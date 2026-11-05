import {mapBounded} from '../net/map-bounded';
import {BASE_GETLOGS_MAX_RANGE_BLOCKS} from '../onchain/economic-discovery';
/**
 * Outbound USDC detection - the PERMANENT activity-mapping layer (outbound leg).
 *
 * Reads USDC `Transfer` LOGS whose `from` topic is a proven EXTERNAL address on
 * Base and maps each into a standard Financial PE on the shared mint path. This
 * is the piece that closes the x402 gap: the prior outbound detector counted an
 * address's on-chain NONCE, but a GASLESS x402 payment (EIP-3009
 * `transferWithAuthorization`) is submitted by a FACILITATOR who pays gas, so the
 * payer's nonce never moves and the payment was invisible. In the Transfer LOG,
 * however, the EIP-3009 signer is still the `from` - so the log vantage catches
 * exactly the activity the nonce vantage missed, and also lets us classify swaps.
 *
 * Classification (per Transfer, using the submitting tx):
 *   - relayed direct USDC `transferWithAuthorization` -> `x402_payment`
 *   - the payment leg of a Provian facilitator settlement (tx.to is the configured
 *     `ProvianX402FeeSettler` and its `FeeSettled` names this leg)  -> `x402_payment`
 *   - tx.to is a known DEX router            -> `swap`
 *   - tx.to is a known staking contract      -> `stake`
 *   - otherwise                              -> `send`
 *
 * Everything downstream is IDENTICAL to a native PE of the same action type:
 * weight-framework pricing, native beneficiary split, standing anti-farm rules
 * (identity/count-only counterparty and daily ceilings),
 * and cross-source x402 mint-once dedup (x402-tx-mint-claim.ts) so a payment
 * witnessed by BOTH the SDK self-report and this watcher mints exactly once.
 *
 * Reused correctness guards (NOT reinvented - mirrors inbound-usdc-watcher.ts):
 *   - Idempotency: each (chainId, txHash, logIndex) is claimed once via a
 *     Firestore create() before emit.
 *   - Finality: the scan only reaches head - minConfirmations (reorg safety) so
 *     a log that can still be reorged out is never minted.
 *   - Backfill + no-retro fence: a per-chain block checkpoint advances forward
 *     from proven_at_block; a Transfer below an address's proven_at_block never
 *     earns (pre-proof history stays at zero).
 *
 * Chains: Base now. Arbitrum / Optimism are a config entry (OUTBOUND_CHAIN_CONFIGS)
 * away - USDC address + router/staking allowlists - not a rewrite (EVM-only).
 */

import crypto from 'crypto';
import { ethers } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import type { ChainName } from '../onchain/rpc-provider';
import type { AgentBankDeps } from '../agent-bank/types';
import { generatePE } from '../agent-bank/pe-utils';
import { resolvableOrigin, urlOrigins, chainWatcherWitness } from '../provenance/origin-capture';
import { relayObservationWitness, RELAY_WITNESS_CHAIN_WATCHER } from './relay-observation-witness';
import { listProvenAddresses, listProvenAddressesFor, type ProvenAddressRecord } from '../external-address/link';
import { enumeratePersonProvenAddresses, type PersonProvenWatchedAddress } from './person-proven-watched';
import { rethrowWatchReadError, strictReads, WatchReadError } from './watch-read-error';
import {
  admissionFromDocs,
  legacyWatchSource,
  registryWatchSource,
  type WatchSource,
  type WatchSourceView,
} from './watch-source';
import { atomicUsdcToUsd } from './inbound-usdc-watcher';
import { canonicalLogIdentity } from './institution-funding-watcher';
import { BASE_UNISWAP_ROUTERS, isAtOrAfterCommerceCutLine, usdcLegIsWalletExchange } from './wallet-exchange';
import { facilitatorSettlementNamesLeg, facilitatorSettlerAddress } from './x402-facilitator-settlement';
import {
  assertBaseUsdcTransferEvidence,
  BASE_USDC_ADDRESS,
  BASE_WATCHER_CONFIRMATION_FLOOR,
  getAgreedBaseLogs,
  readAgreedBaseHead,
  verifyBaseTransactionEvidence,
  verifyBaseUsdcTransferEvidence,
  type BaseTransactionEvidence,
  type BaseUsdcTransferEvidence,
} from '../onchain/economic-discovery';
import {
  createWatcherClaim,
  freezeWatcherClaimEvidence,
  leaseWatcherRecoveryClaims,
  markWatcherClaimComplete,
  markWatcherClaimPending,
  type WatcherClaimBinding,
  type WatcherClaimHandle,
} from './watcher-recovery';
import {
  advanceEmptyWatcherCheckpoint,
  advanceWatcherAddressAdmission,
  assertWatcherAddressAdmissionBinding,
  commitWatcherCheckpoint,
  ensureWatcherAddressAdmission,
  readWatcherCheckpointSnapshot,
  WATCHER_ADDRESS_ADMISSION_COLLECTION,
  type WatcherAddressAdmissionDocument,
  type WatcherAddressAdmissionTarget,
  type WatcherCheckpointSnapshot,
} from './watcher-address-admission';
import {
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  nativeWalletAddressIndexId,
  parseCanonicalNativeAddressIndex,
  parseNativeWalletRegistrationFence,
} from './native-wallet-registration';
import {
  countExclusions,
  persistWatcherEnumerationHealth,
  WatcherEnumerationExclusionLog,
  type WatcherEnumerationExclusion,
} from './watcher-enumeration-health';

// =============================================================================
// COLLECTIONS
// =============================================================================

const CHECKPOINT_COLLECTION = 'activity_outbound_checkpoints';
const SEEN_COLLECTION = 'activity_outbound_seen';

// =============================================================================
// TYPES
// =============================================================================

export type OutboundActivityType = 'x402_payment' | 'swap' | 'stake' | 'send';

/**
 * How a watched address entered the set (3d; parity).
 *
 * BOTH sources earn the SAME priced chain-financial family (x402 / swap / send)
 * on the same on-chain act — the tag only LABELS the emitted PE (native_address
 * vs proven_address), it no longer gates which activity earns.
 *
 * - `external_proven` an address the agent PROVED it controls via the
 * external-address link flow.
 * - `native_agent` the agent's OWN native Provian wallet address. the operator’s
 * original x402-only admission was "an example, not a boundary" a
 * native sovereign agent's outbound must not under-earn a proven-external
 * address on the identical act. The earlier duplication worry against
 * `/transfer/record` + `/swap/record` is the settled self-report-vs-watcher
 * shape — those routes are best-effort and seal `record_only`/0 PVT in
 * practice (no `awaitAccrual`), so this watcher's durable chain-verified emit
 * is the ONE seal that prices; the dedup holds per type rather than by
 * excluding native send/swap. Same-owner self-dealing is fenced identically
 * for every type (`detectSameOwnerTransfer`).
 * - `native_human` the HUMAN owner's OWN native Provian wallet address (the operator,
 *). The symmetric parallel of `native_agent` the inbound watcher
 * already mints a human's `receive`, but the human's outbound `send`/`swap`
 * was invisible because this watcher only enumerated agents — so an on-chain
 * act the matrix prices `eligible` 2.0× earned nothing. A human native address
 * earns the SAME priced family, differing ONLY in owner attribution
 * (`ownerType:'human'`, so the immutable 99/0.5/0.5 human split applies and no
 * linked-agent beneficiary routing). The anti-self-farming fence is NOT new
 * code: `detectSameOwnerTransfer` runs off the `counterpartyAddress` this emit
 * carries and resolves human wallet addresses from the SAME
 * `native_wallet_address_index_v1` (`owner_type:'human'`), so a human→own /
 * human→self send or swap seals `record_only` (0 PVT); the per-actor daily
 * activity ceilings apply identically. For `native_human` the accrual
 * identity (`agentId` field below) carries the human `user_id` the chain-tip
 * / `user_id` / accrual key that `generatePE` already uses for human PEs.
 */
export type OutboundWatchedSource = 'external_proven' | 'native_agent' | 'native_human'
  /** 2026-10-01: a PERSON's proven external address — attributed to that person (`ownerType: 'human'`). */
  | 'external_proven_person';

/** A decoded USDC Transfer log FROM a watched (proven external) address. */
export interface OutboundTransferLog {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  fromAddress: string; // decoded from topic[1] - the proven address
  toAddress: string;   // decoded from topic[2] - the counterparty
  amountAtomic: string;
}

export interface WatchedOutboundAddress {
  address: string;   // lowercased proven external / native address
  walletId: string;  // native wallet id for the attributed agent (per-wallet aggregation)
  agentId: string;   // accrual identity (agent_id; the native split routes it)
  provenAtBlock: number; // no-retro fence (external: proven_at_block; native: creation-block eligibility_start_block)
  source: OutboundWatchedSource; // 3d — gates which activity types earn (see OutboundWatchedSource)
}

/** Minimal submitting-tx facts used for classification. */
export interface OutboundTxInfo {
  /** The EOA that SUBMITTED the tx (pays gas). Differs from Transfer.from for a
   *  gasless / facilitator-relayed settlement. */
  submitter: string | null;
  /** The tx target (the contract the submitter called). null when unavailable. */
  to: string | null;
  /** Exact outer transaction selector committed by two-operator evidence. */
  selector?: string | null;
}

export interface OutboundActivityEvent {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  toAddress: string;
  amountUsd: number;
  amountAtomic: string;
  observedAtMs: number;
}

export interface OutboundUsdcScanDeps {
  db: Firestore;
  chainId: number;
  chainName: string;
  getBlockNumber: () => Promise<number>;
  /** USDC Transfer logs for a block range whose `from` topic is in fromAddresses. */
  getLogs: (args: { fromBlock: number; toBlock: number; fromAddresses: string[] }) => Promise<OutboundTransferLog[]>;
  /** Is this tx target a known DEX router / staking contract for this chain?
   * Read only for a leg mined before the landing; after it, a swap is the
   * wallet's exchange (`wallet-exchange.ts`), read from the whole transaction. */
  isDexRouter: (address: string) => boolean;
  isStakingContract: (address: string) => boolean;
  /** Enumerate the proven external addresses to watch. */
  listWatchedAddresses: () => Promise<WatchedOutboundAddress[]>;
  /** the watch-registry source production scans with. Absent: the legacy
   * full `listWatchedAddresses` list, through the same code path. */
  watchSource?: WatchSource<WatchedOutboundAddress>;
  /** the classified exclusions of the most recent `listWatchedAddresses`
   * call. When present, the scan reports them and persists the watcher's
   * enumeration health (the ops attention rule reads it). */
  takeEnumerationExclusions?: () => Promise<readonly WatcherEnumerationExclusion[]>;
  /** the whole-transaction read the swap label needs (two operator legs,
   * confirmation floor + safe head). Called only for a leg the wallet signed to a
   * swap target; absent → such a leg stays pending (Unknown = Block). */
  readTransactionEvidence?: (txHash: string) => Promise<BaseTransactionEvidence>;
  /** : the x402 facilitator's settler contract (lowercased). Absent = read from
   * `FACILITATOR_SETTLER_ADDRESS`; null = no settler configured (no leg is relabelled). */
  facilitatorSettler?: string | null;
  /** Two-operator/confirmation verification before any economic PE is emitted. */
  verifyActivityEvent: (
    addr: WatchedOutboundAddress,
    event: OutboundActivityEvent,
  ) => Promise<BaseUsdcTransferEvidence>;
  /** Emit the mapped Financial PE on the shared mint path. */
  emitActivityPE: (
    addr: WatchedOutboundAddress,
    event: OutboundActivityEvent,
    activityType: OutboundActivityType,
    metadata: Record<string, unknown>,
    /** a swap is keyed on its transaction (every lane collapses onto one
     * mint-once claim); every other act stays log-granular. */
    keying?: 'log' | 'transaction',
  ) => Promise<{ peId: string; peHash: string }>;
  /** Test/fault-injection seam for a process crash after durable log ownership
   *  but before the address-specific backfill cursor is advanced. */
  beforeBackfillCursorAdvance?: (range: {
    direction: 'outbound';
    address: string;
    fromBlock: number;
    toBlock: number;
  }) => Promise<void>;
  now?: () => number;
}

export interface OutboundScanOptions {
  startBlock?: number;
  minConfirmations?: number;
  blockChunk?: number;
  addressBatchSize?: number;
  /** Deprecated compatibility input; ignored. */
  dustFloorUsd?: number;
  maxBlocksPerRun?: number;
  /**
   * Hard ceiling on getLogs calls issued in one run. The 10-block provider cap
   * turns a deep backlog into thousands of sequential calls; this bound makes
   * one tick's RPC work finite while the durable cursor still advances every
   * tick (partially-scanned runs checkpoint through the last complete window).
   */
  maxLogCallsPerRun?: number;
}

/** Paid operator window. The agreed log reader preserves both legs and adaptively splits
 * any smaller provider limit; no activity proof or finalized-head fence changes. */
const DEFAULT_OUTBOUND_BLOCK_CHUNK = BASE_GETLOGS_MAX_RANGE_BLOCKS;
// Sized to finish comfortably inside a scheduler-tick request deadline
// (~150ms per agreed two-leg call → ~45-60s). With incremental band commits a
// cut run keeps its progress anyway; raise via env to drain a backlog faster.
const DEFAULT_OUTBOUND_MAX_LOG_CALLS_PER_RUN = 300;
/** Sender addresses per getLogs topic-OR batch (both economic legs answer 20,000 measured). */
const DEFAULT_OUTBOUND_ADDRESS_BATCH = 5_000;

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export interface OutboundScanReport {
  chain_id: number;
  from_block: number;
  to_block: number;
  watched_addresses: number;
  logs_seen: number;
  pes_emitted: number;
  by_type: Record<OutboundActivityType, number>;
  duplicates_skipped: number;
  dust_skipped: number;
  pre_proof_skipped: number;
  errors: number;
  log_calls_used: number;
  budget_stopped: boolean;
  /** wallets that EXIST but were excluded from this cycle's watched set. */
  excluded_wallets: number;
  /** index rows naming a wallet whose document no longer exists. */
  orphaned_index_rows: number;
  /** every exclusion with its exact reason. */
  exclusions: WatcherEnumerationExclusion[];
}

// =============================================================================
// PURE HELPERS
// =============================================================================

/**
 * Classify an outbound USDC transfer. Pure + unit-testable.
 * A submitter that differs from the token sender means a third party relayed the
 * transfer the sender signed - the x402 / gasless settlement pattern. Otherwise
 * the target contract decides swap vs stake, with `send` as the catch-all.
 */
export function classifyOutbound(args: {
  transferFrom: string;
  submitter: string | null;
  txTo: string | null;
  txSelector: string | null;
  isDexRouter: (a: string) => boolean;
  isStakingContract: (a: string) => boolean;
}): OutboundActivityType {
  const { transferFrom, submitter, txTo, txSelector } = args;
  // A different submitter alone proves only relaying. It also covers ERC-20
  // transferFrom and smart-wallet execution, neither of which is x402. The
  // launch x402 signer uses USDC EIP-3009 transferWithAuthorization directly;
  // require that exact outer target + selector before granting x402 economics.
  if (submitter
    && submitter.toLowerCase() !== transferFrom.toLowerCase()
    && txTo?.toLowerCase() === BASE_USDC_ADDRESS
    && txSelector === '0xe3ee160e') {
    return 'x402_payment';
  }
  if (txTo) {
    if (args.isDexRouter(txTo)) return 'swap';
    if (args.isStakingContract(txTo)) return 'stake';
  }
  return 'send';
}

/**
 * The deterministic PE id this watcher seals for one outbound USDC Transfer log.
 * ONE derivation, read by this watcher's emit and by the chain-record lane
 * (which must know whether this watcher's PE for a leg of the same transaction
 * minted before it emits its own act — one transaction mints once per actor).
 */
export function outboundUsdcPeId(chainId: number, txHash: string, logIndex: number): string {
  return `pe_outbound_${crypto.createHash('sha256')
    .update(`${chainId}:${txHash.toLowerCase()}:${logIndex}`)
    .digest('hex')}`;
}

function seenDocId(chainId: number, txHash: string, logIndex: number): string {
  return `${chainId}_${txHash.toLowerCase()}_${logIndex}`;
}

function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function emptyByType(): Record<OutboundActivityType, number> {
  return { x402_payment: 0, swap: 0, stake: 0, send: 0 };
}

interface OutboundClaimPayload {
  readonly addr: WatchedOutboundAddress;
  readonly event: OutboundActivityEvent;
  readonly chainName: string;
  readonly chainId: number;
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): boolean {
  const expected = [...required].sort();
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function outboundPayload(value: Record<string, unknown>): OutboundClaimPayload {
  const addr = value.addr as (Partial<WatchedOutboundAddress> & Record<string, unknown>) | undefined;
  const event = value.event as (Partial<OutboundActivityEvent> & Record<string, unknown>) | undefined;
  if (!hasExactKeys(value, ['addr', 'event', 'chainName', 'chainId'])
    || !addr || !hasExactKeys(addr, ['address', 'walletId', 'agentId', 'provenAtBlock', 'source'])
    || typeof addr.address !== 'string' || !ethers.isAddress(addr.address)
    || addr.address !== addr.address.toLowerCase()
    || typeof addr.walletId !== 'string' || addr.walletId.length === 0
    || typeof addr.agentId !== 'string' || addr.agentId.length === 0
    || !Number.isSafeInteger(addr.provenAtBlock) || addr.provenAtBlock! < 0
    || (addr.source !== 'external_proven' && addr.source !== 'native_agent' && addr.source !== 'native_human'
      && addr.source !== 'external_proven_person')
    || !event || !hasExactKeys(event, [
      'txHash',
      'logIndex',
      'blockNumber',
      'toAddress',
      'amountUsd',
      'amountAtomic',
      'observedAtMs',
    ])
    || typeof event.txHash !== 'string' || !/^0x[a-f0-9]{64}$/.test(event.txHash)
    || !Number.isSafeInteger(event.logIndex) || event.logIndex! < 0
    || !Number.isSafeInteger(event.blockNumber)
    || event.blockNumber! < (addr.provenAtBlock as number)
    || typeof event.toAddress !== 'string' || !ethers.isAddress(event.toAddress)
    || event.toAddress !== event.toAddress.toLowerCase()
    || typeof event.amountAtomic !== 'string' || !/^(0|[1-9][0-9]*)$/.test(event.amountAtomic)
    || typeof event.amountUsd !== 'number' || !Number.isFinite(event.amountUsd)
    || event.amountUsd !== atomicUsdcToUsd(event.amountAtomic)
    || event.observedAtMs !== 0
    || value.chainName !== 'base' || value.chainId !== 8453) {
    throw new Error('outbound_watcher_claim_payload_invalid');
  }
  return value as unknown as OutboundClaimPayload;
}

function recoveryAddressMap(
  addresses: readonly WatchedOutboundAddress[],
): Map<string, WatchedOutboundAddress> {
  const out = new Map<string, WatchedOutboundAddress>();
  for (const candidate of addresses) {
    const address = candidate.address.toLowerCase();
    if (out.has(address)) throw new Error(`watched_address_enumeration_duplicate:${address}`);
    out.set(address, { ...candidate, address });
  }
  return out;
}

/** The sender a durable claim names, or null when its payload does not parse (it then fails on its own). */
function claimSender(handle: WatcherClaimHandle): string | null {
  try {
    return outboundPayload(handle.payload).addr.address;
  } catch {
    return null;
  }
}

async function recoveryAddressMapFor(
  source: WatchSource<WatchedOutboundAddress>,
  addresses: ReadonlyArray<string | null>,
): Promise<Map<string, WatchedOutboundAddress>> {
  const out = new Map<string, WatchedOutboundAddress>();
  for (const address of new Set(addresses.filter((a): a is string => a !== null))) {
    const resolution = await source.resolve(address);
    if (resolution.kind === 'valid') out.set(address, { ...resolution.wallet, address });
  }
  return out;
}

function assertRecoveredAddressAuthority(
  payload: OutboundClaimPayload,
  authoritative: Map<string, WatchedOutboundAddress> | undefined,
  attempts: number,
): void {
  if (attempts === 1) return;
  const current = authoritative?.get(payload.addr.address);
  if (!current
    || current.walletId !== payload.addr.walletId
    || current.agentId !== payload.addr.agentId
    || current.provenAtBlock !== payload.addr.provenAtBlock
    // 3d — the source gates which activity types earn, so a recovered
    // claim whose source no longer matches the authoritative enumeration must
    // NOT be replayed under the wrong earning rule.
    || current.source !== payload.addr.source) {
    throw new Error('outbound_watcher_claim_authority_mismatch');
  }
}

async function processOutboundClaim(
  deps: OutboundUsdcScanDeps,
  handle: WatcherClaimHandle,
  authoritative?: Map<string, WatchedOutboundAddress>,
): Promise<{ peId: string; activityType: OutboundActivityType }> {
  const payload = outboundPayload(handle.payload);
  if (payload.chainId !== 8453) {
    throw new Error('economic_watcher_non_base_evidence_unsupported');
  }
  assertRecoveredAddressAuthority(payload, authoritative, handle.attempts);
  await assertWatcherAddressAdmissionBinding(
    deps.db,
    outboundAdmissionTarget(payload.addr, payload.chainId),
  );
  const verified = await deps.verifyActivityEvent(payload.addr, payload.event);
  const activeHandle = await freezeWatcherClaimEvidence(
    deps.db,
    handle,
    verified,
    (deps.now ?? Date.now)(),
  );
  const finality = assertBaseUsdcTransferEvidence(activeHandle.evidenceSnapshot ?? undefined, {
    transactionHash: payload.event.txHash,
    logIndex: payload.event.logIndex,
    fromAddress: payload.addr.address,
    toAddress: payload.event.toAddress,
    amountAtomic: payload.event.amountAtomic,
  });
  if (finality.blockNumber !== payload.event.blockNumber
    || finality.blockNumber < payload.addr.provenAtBlock) {
    throw new Error('outbound_watcher_claim_block_fence_mismatch');
  }
  const canonicalEvent = { ...payload.event, observedAtMs: finality.blockTimestampMs };
  // from the landing forward a swap is the wallet's EXCHANGE — signed by
  // the wallet, to a known swap target (Uniswap or 0x AllowanceHolder), and the
  // wallet received a different known asset — read from the whole transaction
  // (`wallet-exchange.ts`, the one rule every lane reads). The router list no
  // longer labels a leg by itself. A leg mined before the landing keeps the
  // label it had (its PE id is deterministic; a retry must derive the same PE).
  const afterLanding = isAtOrAfterCommerceCutLine(finality.blockTimestampMs);
  let activityType = classifyOutbound({
    transferFrom: payload.addr.address,
    submitter: finality.transactionSubmitter,
    txTo: finality.transactionTo,
    txSelector: finality.transactionSelector,
    isDexRouter: afterLanding ? () => false : deps.isDexRouter,
    isStakingContract: deps.isStakingContract,
  });
  if (afterLanding && activityType === 'send' && await usdcLegIsWalletExchange({
    transactionHash: payload.event.txHash,
    blockTimestampMs: finality.blockTimestampMs,
    transactionSubmitter: finality.transactionSubmitter,
    transactionTo: finality.transactionTo,
  }, payload.addr.address, deps.readTransactionEvidence)) {
    activityType = 'swap';
  }
  // — a USDC leg of a settlement Provian's x402 facilitator submitted through its
  // `ProvianX402FeeSettler` is the buyer's x402 PAYMENT when the settler's own `FeeSettled` names
  // this leg (buyer = this address, seller = its recipient, token USDC, value = its amount). The
  // label puts the leg on the x402 claim (payer, settlement tx) — the same anchor the facilitator
  // lane seals the buyer's act under (`x402-facilitator-lane.ts`), so the two lanes mint once. The
  // seller's fee leg (seller -> fee recipient) is never named as a payment and stays as it was.
  const facilitatorSettler = deps.facilitatorSettler !== undefined
    ? deps.facilitatorSettler
    : facilitatorSettlerAddress();
  if (activityType !== 'x402_payment' && facilitatorSettler !== null
    && finality.transactionTo !== null && finality.transactionTo.toLowerCase() === facilitatorSettler) {
    // Unknown = Block: without the whole-transaction read the leg stays pending, never guessed.
    if (!deps.readTransactionEvidence) throw new Error('outbound_facilitator_evidence_reader_missing');
    const settlement = await deps.readTransactionEvidence(payload.event.txHash);
    if (settlement.transactionHash.toLowerCase() !== payload.event.txHash.toLowerCase()) {
      throw new Error('outbound_facilitator_evidence_mismatch');
    }
    if (facilitatorSettlementNamesLeg(settlement, facilitatorSettler, {
      from: payload.addr.address,
      to: payload.event.toAddress,
      amountAtomic: payload.event.amountAtomic,
    })) {
      activityType = 'x402_payment';
    }
  }
  const keying: 'log' | 'transaction' = afterLanding && activityType === 'swap' ? 'transaction' : 'log';
  // 3d PARITY — a NATIVE Provian wallet address earns the FULL
  // priced chain-financial family (x402 / swap / send), byte-identical to a
  // proven-external address: the design requires the original x402-only admission "an
  // example, not a boundary — native must not under-earn proven-external on the
  // same on-chain act." The prior duplication worry against `/transfer/record`
  // and `/swap/record` is the settled self-report-vs-watcher shape: those routes
  // are best-effort and seal `record_only`/0 PVT in practice (no `awaitAccrual`
  // → `durableEconomicPath=false` → `policyRecordOnly=true`, pvt-accrual.ts), so
  // this watcher's durable, chain-verified emit is the ONE seal that prices. No
  // native type is excluded here; the dedup holds per type (the self-report never
  // mints) rather than by dropping the emit. Same-owner self-dealing is fenced
  // for send/swap exactly as for x402 — `detectSameOwnerTransfer` runs off the
  // `counterpartyAddress` the emit carries and is action-type-agnostic — so a
  // native→own / native→sibling send or swap seals `record_only` too.
  const metadata: Record<string, unknown> = {
    tx_hash: payload.event.txHash,
    log_index: payload.event.logIndex,
    block_number: finality.blockNumber,
    block_hash: finality.blockHash,
    chain: payload.chainName,
    chain_id: payload.chainId,
    asset: 'USDC',
    amount_usd: payload.event.amountUsd,
    submitter: finality.transactionSubmitter,
    tx_to: finality.transactionTo,
    tx_selector: finality.transactionSelector,
    verified: true,
    finality_confirmations: BASE_WATCHER_CONFIRMATION_FLOOR,
    finality_reason: null,
    economic_evidence: finality,
  };
  const emitted = await deps.emitActivityPE(
    payload.addr,
    canonicalEvent,
    activityType,
    metadata,
    keying,
  );
  await markWatcherClaimComplete(deps.db, activeHandle, emitted.peId, (deps.now ?? Date.now)());
  return { peId: emitted.peId, activityType };
}

async function recoverOutboundClaims(
  deps: OutboundUsdcScanDeps,
  source: WatchSource<WatchedOutboundAddress>,
  now: number,
): Promise<{
  completed: number;
  byType: Record<OutboundActivityType, number>;
  errors: number;
  structurallyBlocked: boolean;
}> {
  const recovery = await leaseWatcherRecoveryClaims(deps.db, SEEN_COLLECTION, now);
  const authoritative = recovery.handles.length === 0
    ? undefined
    : source.registry
      // the authority for exactly the leased claims' addresses; a held or
      // excluded one is absent, so its claim stays pending for the next run.
      ? await recoveryAddressMapFor(source, recovery.handles.map(claimSender))
      : recoveryAddressMap(await deps.listWatchedAddresses());
  const byType = emptyByType();
  let completed = 0;
  let errors = recovery.issues.length;
  for (const issue of recovery.issues) {
    console.error('[outbound-usdc] malformed durable recovery claim', issue);
  }
  for (const handle of recovery.handles) {
    try {
      const outcome = await processOutboundClaim(deps, handle, authoritative);
      completed += 1;
      byType[outcome.activityType] += 1;
    } catch (error) {
      errors += 1;
      await markWatcherClaimPending(deps.db, handle, error, now).catch((markerError) => {
        console.error('[outbound-usdc] could not persist recovery failure', markerError);
      });
    }
  }
  return {
    completed,
    byType,
    errors,
    structurallyBlocked: recovery.issues.length > 0,
  };
}

interface OutboundRangeScanArgs {
  addrMap: Map<string, WatchedOutboundAddress>;
  /** the addresses to ask the chain about (default: `addrMap`'s keys). */
  filterAddresses?: readonly string[];
  /** resolve a sender `addrMap` does not hold — an address to claim for, 'skip', or 'hold'. */
  resolveSender?: (address: string) => Promise<WatchedOutboundAddress | 'skip' | 'hold'>;
  fromBlock: number;
  toBlock: number;
  blockChunk: number;
  addressBatchSize: number;
  /** Shared across backfill and band scans: one run, one RPC-call pool. */
  budget: { remaining: number };
  report: OutboundScanReport;
  now: () => number;
}

async function scanOutboundRange(
  deps: OutboundUsdcScanDeps,
  args: OutboundRangeScanArgs,
): Promise<number> {
  const filter = args.filterAddresses ?? Array.from(args.addrMap.keys());
  if (args.fromBlock > args.toBlock || filter.length === 0) {
    return Number.MAX_SAFE_INTEGER;
  }
  const addressBatches = chunk([...filter], args.addressBatchSize);
  const logs: OutboundTransferLog[] = [];
  // Whole windows only: a window is scanned iff the budget covers every
  // address batch in it, so a checkpoint never advances past a block some
  // watched address was not asked about.
  let budgetStopBlock = Number.MAX_SAFE_INTEGER;
  for (let cursor = args.fromBlock; cursor <= args.toBlock; cursor += args.blockChunk) {
    const end = Math.min(cursor + args.blockChunk - 1, args.toBlock);
    if (args.budget.remaining < addressBatches.length) {
      budgetStopBlock = cursor;
      args.report.budget_stopped = true;
      break;
    }
    args.budget.remaining -= addressBatches.length;
    args.report.log_calls_used += addressBatches.length;
    const batchLogs = await mapBounded(addressBatches, 4, batch => deps.getLogs({
      fromBlock: cursor, toBlock: end, fromAddresses: batch,
    }));
    for (const list of batchLogs) logs.push(...list);
  }
  args.report.logs_seen += logs.length;
  logs.sort((a, b) => (a.blockNumber - b.blockNumber) || (a.logIndex - b.logIndex));

  let minFailedBlock = Number.MAX_SAFE_INTEGER;
  for (const log of logs) {
    const sender = log.fromAddress.toLowerCase();
    let addr = args.addrMap.get(sender);
    if (!addr && args.resolveSender) {
      const resolved = await args.resolveSender(sender);
      if (resolved === 'hold') {
        // The old run aborted on what holds here: keep the checkpoint behind this log.
        args.report.errors += 1;
        minFailedBlock = Math.min(minFailedBlock, log.blockNumber);
        continue;
      }
      if (resolved !== 'skip') addr = resolved;
    }
    if (!addr) continue;
    if (log.blockNumber < addr.provenAtBlock) {
      args.report.pre_proof_skipped++;
      continue;
    }
    const amountUsd = atomicUsdcToUsd(log.amountAtomic);

    const observedAtMs = args.now();
    const event: OutboundActivityEvent = {
      txHash: log.txHash,
      logIndex: log.logIndex,
      blockNumber: log.blockNumber,
      toAddress: log.toAddress,
      amountUsd,
      amountAtomic: log.amountAtomic,
      observedAtMs: 0,
    };
    const seenRef = deps.db.collection(SEEN_COLLECTION)
      .doc(seenDocId(deps.chainId, log.txHash, log.logIndex));
    const binding: WatcherClaimBinding = {
      chainId: 8453,
      transactionHash: log.txHash,
      logIndex: log.logIndex,
      fromAddress: addr.address,
      toAddress: log.toAddress,
      amountAtomic: log.amountAtomic,
    };
    let claim: WatcherClaimHandle | null;
    try {
      claim = await createWatcherClaim(deps.db, seenRef, binding, {
        addr,
        event,
        chainName: deps.chainName,
        chainId: deps.chainId,
      }, observedAtMs);
    } catch (error) {
      args.report.errors += 1;
      minFailedBlock = Math.min(minFailedBlock, log.blockNumber);
      console.error('[outbound-usdc] durable claim create failed', log.txHash, log.logIndex, error);
      continue;
    }
    if (claim === null) {
      args.report.duplicates_skipped++;
      continue;
    }

    try {
      const outcome = await processOutboundClaim(deps, claim);
      args.report.pes_emitted++;
      args.report.by_type[outcome.activityType]++;
    } catch (error) {
      args.report.errors++;
      await markWatcherClaimPending(deps.db, claim, error, args.now()).catch((markerError) => {
        console.error('[outbound-usdc] could not persist pending claim state', markerError);
      });
      console.error('[outbound-usdc] emit failed for', log.txHash, log.logIndex, error);
    }
  }
  // A budget stop reuses the failed-block convention: the caller checkpoints
  // through budgetStopBlock - 1 and the next run resumes exactly there.
  return Math.min(minFailedBlock, budgetStopBlock);
}

function outboundAdmissionTarget(
  address: WatchedOutboundAddress,
  chainId: number,
): WatcherAddressAdmissionTarget {
  if (!Number.isSafeInteger(address.provenAtBlock) || address.provenAtBlock < 0) {
    throw new Error(`outbound_watcher_admission_fence_invalid:${address.address}`);
  }
  return {
    direction: 'outbound',
    chainId,
    address: address.address,
    walletId: address.walletId,
    agentId: address.agentId,
    eligibilityStartBlock: address.provenAtBlock,
  };
}

async function catchUpOutboundAddress(
  deps: OutboundUsdcScanDeps,
  address: WatchedOutboundAddress,
  initial: WatcherAddressAdmissionDocument,
  args: Omit<OutboundRangeScanArgs, 'addrMap' | 'fromBlock' | 'toBlock'>,
  maxBlocksPerRun: number,
  finalizedThroughBlock: number,
  expectedMembershipGeneration: number,
): Promise<{
  admission: WatcherAddressAdmissionDocument;
  membershipGeneration: number;
}> {
  const target = outboundAdmissionTarget(address, deps.chainId);
  let admission = initial;
  let membershipGeneration = expectedMembershipGeneration;
  let remaining = maxBlocksPerRun;
  while (admission.state === 'backfilling'
    && remaining > 0
    && admission.backfill_next_block <= finalizedThroughBlock) {
    const fromBlock = admission.backfill_next_block;
    const toBlock = Math.min(
      admission.catch_up_through_block,
      finalizedThroughBlock,
      fromBlock + args.blockChunk - 1,
      fromBlock + remaining - 1,
    );
    const minFailedBlock = await scanOutboundRange(deps, {
      ...args,
      addrMap: new Map([[address.address, address]]),
      fromBlock,
      toBlock,
    });
    const processedThrough = minFailedBlock === Number.MAX_SAFE_INTEGER
      ? toBlock
      : Math.min(toBlock, minFailedBlock - 1);
    if (processedThrough < fromBlock) break;
    await deps.beforeBackfillCursorAdvance?.({
      direction: 'outbound',
      address: address.address,
      fromBlock,
      toBlock: processedThrough,
    });
    const advanced = await advanceWatcherAddressAdmission(
      deps.db,
      target,
      processedThrough,
      CHECKPOINT_COLLECTION,
      membershipGeneration,
      args.now(),
    );
    admission = advanced.admission;
    membershipGeneration = advanced.membershipGeneration;
    remaining -= processedThrough - fromBlock + 1;
    if (minFailedBlock !== Number.MAX_SAFE_INTEGER) break;
  }
  return { admission, membershipGeneration };
}

// =============================================================================
// SCAN
// =============================================================================

/**
 * report and persist this cycle's watched-set exclusions — the outbound
 * twin of the inbound watcher's `recordEnumerationHealth`. Best-effort: the
 * scan's own result never depends on the health write.
 */
async function recordOutboundEnumerationHealth(
  deps: OutboundUsdcScanDeps,
  report: OutboundScanReport,
  watchedCount: number,
  nowMs: number,
  source?: WatchSource<WatchedOutboundAddress>,
): Promise<void> {
  if (!deps.takeEnumerationExclusions) return;
  let exclusions: readonly WatcherEnumerationExclusion[];
  try {
    exclusions = await deps.takeEnumerationExclusions();
    // plus the last completed sweep cycle's, so an idle excluded wallet stays visible.
    if (source?.registry) exclusions = await source.healthExclusions(exclusions);
  } catch (error) {
    console.error('[outbound-usdc] exclusion classification failed', error);
    return;
  }
  const counts = countExclusions(exclusions);
  report.excluded_wallets = counts.excluded_wallets;
  report.orphaned_index_rows = counts.orphaned_index_rows;
  report.exclusions = [...exclusions];
  try {
    await persistWatcherEnumerationHealth(deps.db, 'outbound_usdc', {
      watchedCount,
      exclusions,
      now: nowMs,
    });
  } catch (error) {
    console.error('[outbound-usdc] enumeration health write failed', error);
  }
}

/**
 * Scan for outbound USDC from proven external addresses and map each into a
 * standard Financial PE. Idempotent across overlapping runs via the per-log
 * claim; advances the block checkpoint only past fully-emitted blocks so a crash
 * mid-run safely re-scans (mirrors inbound-usdc-watcher.ts).
 */
export async function scanOutboundUsdc(
  deps: OutboundUsdcScanDeps,
  opts: OutboundScanOptions = {},
): Promise<OutboundScanReport> {
  if (deps.chainId !== 8453 || deps.chainName !== 'base') {
    throw new Error('economic_watcher_non_base_evidence_unsupported');
  }
  const now = deps.now ?? Date.now;
  const minConfirmations = deps.chainId === 8453
    ? Math.max(12, opts.minConfirmations ?? 12)
    : (opts.minConfirmations ?? 5);
  const blockChunk = opts.blockChunk
    ?? envPositiveInt('OUTBOUND_USDC_BLOCK_CHUNK', DEFAULT_OUTBOUND_BLOCK_CHUNK);
  const addressBatchSize = opts.addressBatchSize ?? DEFAULT_OUTBOUND_ADDRESS_BATCH;
  const maxBlocksPerRun = opts.maxBlocksPerRun ?? 50_000;
  const maxLogCallsPerRun = opts.maxLogCallsPerRun
    ?? envPositiveInt('OUTBOUND_USDC_MAX_LOG_CALLS_PER_RUN', DEFAULT_OUTBOUND_MAX_LOG_CALLS_PER_RUN);
  const budget = { remaining: maxLogCallsPerRun };
  // production reads the watch registry and resolves only addresses with work; without a
  // registry source the legacy full list runs through the same code (every address pending).
  const source: WatchSource<WatchedOutboundAddress> = deps.watchSource
    ?? legacyWatchSource(deps.listWatchedAddresses, (addr) => addr.address, (addr, address) => ({ ...addr, address }));

  const report: OutboundScanReport = {
    chain_id: deps.chainId,
    from_block: 0,
    to_block: 0,
    watched_addresses: 0,
    logs_seen: 0,
    pes_emitted: 0,
    by_type: emptyByType(),
    duplicates_skipped: 0,
    dust_skipped: 0,
    pre_proof_skipped: 0,
    errors: 0,
    log_calls_used: 0,
    budget_stopped: false,
    excluded_wallets: 0,
    orphaned_index_rows: 0,
    exclusions: [],
  };

  try {
    const recovered = await recoverOutboundClaims(deps, source, now());
    report.pes_emitted += recovered.completed;
    report.errors += recovered.errors;
    for (const type of Object.keys(recovered.byType) as OutboundActivityType[]) {
      report.by_type[type] += recovered.byType[type];
    }
    if (recovered.structurallyBlocked) return report;
  } catch (error) {
    report.errors += 1;
    console.error('[outbound-usdc] durable recovery scan failed', error);
    return report;
  }

  const checkpointSnapshot = await readWatcherCheckpointSnapshot(
    deps.db,
    CHECKPOINT_COLLECTION,
    deps.chainId,
  );
  const view = await source.load(now());
  if (view.generationHighWater > checkpointSnapshot.membershipGeneration) {
    // A marked live admission is newer than the checkpoint: the checkpoint was rolled back or
    // replaced. The pre- run refused this by re-checking every live admission each run.
    throw new Error('watcher_address_admission_invalid:future_membership_generation');
  }
  report.watched_addresses = view.candidates.length;
  if (!source.registry) await recordOutboundEnumerationHealth(deps, report, view.candidates.length, now());
  try {
    return await scanOutboundBand(deps, source, view, checkpointSnapshot, report, budget, {
      minConfirmations, blockChunk, addressBatchSize, maxBlocksPerRun, now, opts,
    });
  } finally {
    // Registry mode: the exclusions are the resolutions this run made, known only at its end.
    if (source.registry) {
      await recordOutboundEnumerationHealth(deps, report, view.candidates.length, now(), source);
    }
  }
}

interface OutboundBandSettings {
  readonly minConfirmations: number;
  readonly blockChunk: number;
  readonly addressBatchSize: number;
  readonly maxBlocksPerRun: number;
  readonly now: () => number;
  readonly opts: OutboundScanOptions;
}

async function scanOutboundBand(
  deps: OutboundUsdcScanDeps,
  source: WatchSource<WatchedOutboundAddress>,
  view: WatchSourceView,
  checkpointSnapshot: WatcherCheckpointSnapshot,
  report: OutboundScanReport,
  budget: { remaining: number },
  settings: OutboundBandSettings,
): Promise<OutboundScanReport> {
  const { minConfirmations, blockChunk, addressBatchSize, maxBlocksPerRun, now, opts } = settings;
  const head = await deps.getBlockNumber();
  // Inclusive confirmations: a log at H-11 has exactly 12 confirmations.
  const toBlockTarget = head - minConfirmations + 1;

  if (view.candidates.length === 0) {
    // No addresses to watch → no USDC Transfer log can exist in any range, so
    // the whole (cursor, head-minConf] window is vacuously scanned. Advance the
    // durable cursor to the finalized head anyway rather than returning early:
    // an empty watched set is the normal pre-launch state (every agent is
    // platform:'test' and excluded), so a bare early-return froze this cursor at
    // 49,679,822 from 2026-08-08 while every */30 tick still reported healthy
    // (watched_addresses:0, HTTP 200) — the / silent-freeze class,
    // now in 3d's own money path. Safe because any address admitted later
    // independently backfills from its own eligibility fence up to this
    // checkpoint (advanceEmptyWatcherCheckpoint docblock). the registry
    // is add-only and returns null until seeded, so empty means no address was
    // ever made watchable.
    if (toBlockTarget >= 0) {
      const advanced = await advanceEmptyWatcherCheckpoint(
        deps.db,
        CHECKPOINT_COLLECTION,
        deps.chainId,
        checkpointSnapshot,
        toBlockTarget,
        now(),
      );
      if (advanced !== null) {
        report.from_block = (checkpointSnapshot.lastProcessedBlock ?? advanced - 1) + 1;
        report.to_block = advanced;
      }
    }
    return report;
  }

  // The default must fit a complete watch-set window; explicit test/operator budgets remain exact.
  if (opts.maxLogCallsPerRun === undefined && !process.env.OUTBOUND_USDC_MAX_LOG_CALLS_PER_RUN) {
    budget.remaining = Math.max(budget.remaining, Math.ceil(view.candidates.length / addressBatchSize));
  }

  if (toBlockTarget < 0) return report;

  const lastProcessed = checkpointSnapshot.lastProcessedBlock;

  let fromBlock = lastProcessed !== null ? lastProcessed + 1 : (opts.startBlock ?? toBlockTarget);
  if (fromBlock < 0) fromBlock = 0;
  let toBlock = toBlockTarget;
  if (toBlock - fromBlock + 1 > maxBlocksPerRun) {
    toBlock = fromBlock + maxBlocksPerRun - 1;
  }

  report.from_block = fromBlock;
  report.to_block = toBlock;
  // only PENDING addresses get per-address work (ensure + catch-up from
  // the fence): those not yet marked live, those backfilling, and late repairs.
  const liveAddrMap = new Map<string, WatchedOutboundAddress>();
  const catchUpThroughBlock = lastProcessed ?? (fromBlock - 1);
  let membershipGeneration = checkpointSnapshot.membershipGeneration;
  const pending: string[] = [];
  const seenPending = new Set<string>();
  const addPending = (address: string): void => {
    if (seenPending.has(address)) return;
    seenPending.add(address);
    pending.push(address);
  };
  for (const address of view.candidates) {
    if (!view.marked.has(address) && !view.parked.has(address)) addPending(address);
  }
  for (const address of [...view.backfilling].sort()) addPending(address);
  for (const address of [...view.late.keys()].sort()) addPending(address);
  const toMark: string[] = [];
  let markGeneration = 0;
  const toPark: string[] = [];
  const requeue = new Set<string>();
  try {
    for (const address of pending) {
      const resolution = await source.resolve(address);
      if (resolution.kind === 'hold') {
        // Not processed this run; it stays in the band, so its log holds the checkpoint.
        report.errors += 1;
        continue;
      }
      if (resolution.kind === 'excluded') {
        if (resolution.admission?.state === 'live') {
          toMark.push(address);
          markGeneration = Math.max(markGeneration, resolution.admission.membership_generation);
        }
        else toPark.push(address);
        continue;
      }
      const addr = resolution.wallet;
      const target = outboundAdmissionTarget(addr, deps.chainId);
      const ensured = await ensureWatcherAddressAdmission(
        deps.db,
        target,
        catchUpThroughBlock,
        CHECKPOINT_COLLECTION,
        membershipGeneration,
        now(),
      );
      membershipGeneration = ensured.membershipGeneration;
      const caughtUp = await catchUpOutboundAddress(deps, addr, ensured.admission, {
        blockChunk,
        addressBatchSize,
        budget,
        report,
        now,
      }, maxBlocksPerRun, toBlockTarget, membershipGeneration);
      membershipGeneration = caughtUp.membershipGeneration;
      if (caughtUp.admission.state !== 'live') continue;
      if (view.late.has(address)) {
        await rescanLateOutboundAddress(deps, source, addr, view.late.get(address) ?? null, catchUpThroughBlock, {
          blockChunk, addressBatchSize, budget, report, now,
        });
      }
      liveAddrMap.set(address, addr);
      toMark.push(address);
      markGeneration = Math.max(markGeneration, caughtUp.admission.membership_generation);
    }
    await source.markLive(toMark, now(), markGeneration);
    await source.park(toPark, now());
    for (const address of await source.sweep(view)) {
      const resolution = await source.resolve(address);
      if (resolution.kind === 'valid' && view.parked.has(address)) requeue.add(address);
    }

    if (fromBlock > toBlock) return report;

    // Backfilling addresses are deliberately not claimed for here. If this
    // checkpoint advances, their transactionally extended per-address target
    // follows it. the band asks the chain about every watched address and
    // resolves a sender only when a log names it (see the inbound twin).
    const bandAddresses = source.registry
      ? [...new Set([...view.candidates, ...pending, ...liveAddrMap.keys()])]
      : [...liveAddrMap.keys()];
    const resolveSender = source.registry
      ? async (address: string): Promise<WatchedOutboundAddress | 'skip' | 'hold'> => {
        const resolution = await source.resolve(address);
        if (resolution.kind === 'hold') return 'hold';
        if (resolution.kind === 'excluded') return 'skip';
        if (resolution.admission?.state === 'live') return resolution.wallet;
        requeue.add(address);
        return 'skip';
      }
      : undefined;
    //
    // The band commits INCREMENTALLY, one stride segment at a time: at the
    // 10-block provider cap a deep backlog takes minutes of sequential calls,
    // and the old single end-of-band commit lost the entire tick's progress
    // whenever the request deadline, the call budget, or a provider error cut
    // the run. Every fully scanned segment now survives any truncation.
    const commitStride = blockChunk * 20;
    let expectedLastProcessed = checkpointSnapshot.lastProcessedBlock;
    let segmentStart = fromBlock;
    while (segmentStart <= toBlock) {
      const segmentEnd = Math.min(segmentStart + commitStride - 1, toBlock);
      const minFailedBlock = await scanOutboundRange(deps, {
        addrMap: liveAddrMap,
        filterAddresses: bandAddresses,
        resolveSender,
        fromBlock: segmentStart,
        toBlock: segmentEnd,
        blockChunk,
        addressBatchSize,
        budget,
        report,
        now,
      });
      const processedThrough = minFailedBlock === Number.MAX_SAFE_INTEGER
        ? segmentEnd
        : Math.min(segmentEnd, minFailedBlock - 1);
      // If durable ownership failed on block zero there is no non-negative
      // cursor to commit. Preserve the absent checkpoint instead of writing -1.
      if (processedThrough >= segmentStart && processedThrough >= 0) {
        await commitWatcherCheckpoint(
          deps.db,
          CHECKPOINT_COLLECTION,
          deps.chainId,
          {
            lastProcessedBlock: expectedLastProcessed,
            membershipGeneration,
          },
          processedThrough,
          now(),
        );
        expectedLastProcessed = processedThrough;
      }
      if (minFailedBlock !== Number.MAX_SAFE_INTEGER) break;
      segmentStart = segmentEnd + 1;
    }
  } finally {
    if (requeue.size > 0) await source.requeue([...requeue], now());
  }

  return report;
}

/** Rescan one late (reconcile-repaired) address from its resume point through `throughBlock`. */
async function rescanLateOutboundAddress(
  deps: OutboundUsdcScanDeps,
  source: WatchSource<WatchedOutboundAddress>,
  addr: WatchedOutboundAddress,
  resumeAt: number | null,
  throughBlock: number,
  args: Omit<OutboundRangeScanArgs, 'addrMap' | 'fromBlock' | 'toBlock'>,
): Promise<void> {
  let next = Math.max(resumeAt ?? addr.provenAtBlock, addr.provenAtBlock);
  while (next <= throughBlock) {
    const end = Math.min(throughBlock, next + args.blockChunk * 20 - 1);
    const minFailedBlock = await scanOutboundRange(deps, {
      ...args,
      addrMap: new Map([[addr.address, addr]]),
      fromBlock: next,
      toBlock: end,
    });
    const processedThrough = minFailedBlock === Number.MAX_SAFE_INTEGER ? end : Math.min(end, minFailedBlock - 1);
    if (processedThrough >= next) {
      next = processedThrough + 1;
      await source.advanceLate(addr.address, next);
    }
    if (minFailedBlock !== Number.MAX_SAFE_INTEGER) return;
  }
  await source.clearLate(addr.address);
}

// =============================================================================
// REAL-DEPS FACTORY (per-chain config)
// =============================================================================

interface OutboundChainConfig {
  chainId: number;
  chainName: ChainName; // getChainProvider key
  usdcAddress: string; // lowercased
  dexRouters: Set<string>; // lowercased
  stakingContracts: Set<string>; // lowercased
}

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * Per-chain config. Base is live; Arbitrum/Optimism are one entry away. The DEX
 * router allowlist decodes swaps; it is intentionally a small, known set (Uniswap
 * on Base) - an unknown target falls back to `send`, never a wrong `swap`.
 */
export const OUTBOUND_CHAIN_CONFIGS: Record<string, OutboundChainConfig> = {
  base: {
    chainId: 8453,
    chainName: 'base',
    usdcAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    // The Uniswap routers on Base — ONE source (`wallet-exchange.ts`). Read only
    // for a leg mined before the landing.
    dexRouters: new Set<string>(BASE_UNISWAP_ROUTERS),
    stakingContracts: new Set<string>([]), // none pinned yet; extend as verified
  },
};

function addressToTopic(address: string): string {
  return '0x' + address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}
function topicToAddress(topic: string): string {
  return '0x' + topic.slice(-40).toLowerCase();
}

/**
 * Rate-limit-shaped RPC errors (HTTP 429 / "too many requests" / throttle). Deliberately does
 * NOT match `economic_discovery_rpc_disagreement` (a real two-provider disagreement, never
 * retryable) or the 10-block-range 400 (a hard cap the chunk size already respects).
 */
const OUTBOUND_RATE_LIMIT_RE = /\b429\b|rate[ _-]?limit|too many requests|throttl/i;

/**
 * Audit 2026-08-05 (finding 9): a rate-limited RPC leg throws out of the two-provider `agreed()`
 * read and aborts the whole scan, so the durable cursor never advances and the scheduler tick
 * fails. Retry the idempotent READ (logs, head) a bounded number of times with exponential
 * backoff on rate-limit-shaped errors only, so a transient throttle self-heals. Never retries a
 * non-rate-limit error (a real disagreement, a malformed range) — those must surface immediately.
 */
export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 200;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const message = err instanceof Error ? err.message : String(err);
      if (!OUTBOUND_RATE_LIMIT_RE.test(message) || i === attempts - 1) throw err;
      await sleep(baseDelayMs * 2 ** i);
    }
  }
  throw lastErr;
}

/**
 * Enumerate the agent NATIVE wallet addresses to watch for outbound x402 (3d).
 *
 * Reads the canonical native-address index `native_wallet_address_index_v1`
 * (`owner_type === 'agent'`), the SAME authority the same-owner fence
 * (`same-owner-detection.ts`) resolves ownership from — so an address admitted
 * here to EARN and the fence that decides whether it earns read one binding.
 *
 * For each agent native address it reads the wallet doc for (a) the no-retro
 * fence (`native_watcher_registration.eligibility_start_block` = creation head
 * + 1 — the native parallel of an external address's `proven_at_block`) and
 * (b) the platform (smoke-`test` agents never earn, parity with the external
 * path and both sibling watchers). Every shape/identity violation THROWS
 * (`watched_address_enumeration_invalid:*`) rather than guessing past a
 * malformed authority record — same fail-closed posture as the external
 * enumerator below and the inbound watcher.
 *
 * NOTE (asymmetry, stated): the inbound watcher additionally cross-checks the
 * agent birth-PE chain to pin `platform`. This outbound path uses the wallet
 * doc's `platform` directly, matching the EXISTING outbound external
 * enumerator's lighter trust level — the economic protection for native x402 is
 * the same-owner fence + x402 `(payer,txHash)` mint-once + the no-retro fence,
 * not birth-PE authority. Unifying inbound's inline index parser onto the shared
 * one in `native-wallet-registration.ts` is a follow-up (OPEN_ITEMS).
 */
export async function enumerateNativeAgentOutboundAddresses(
  db: Firestore,
  // PER-WALLET FAULT ISOLATION (2026-09-03): when the production orchestrator
  // passes an `onExclude` sink, a single wallet whose authority fails validation
  // is EXCLUDED from this cycle (its exact reason logged) and enumeration
  // proceeds for everyone else — exact parity with the inbound watcher's
  // `excludeWallet` (2026-08-16 audit item 3). Without the sink the contract is
  // unchanged: the first invalid wallet THROWS (fail-closed), which the standalone
  // enumerator tests pin. An excluded wallet is never watched, so it earns nothing
  // this cycle (Unknown = Block, applied per wallet). This closes the outbound
  // parallel of the inbound outage: before it, one orphaned index row (a deleted
  // wallet doc) aborted every ~30-min outbound scan (dark 2026-08-13..09-03).
  onExclude?: (error: unknown) => void,
  /** only these index rows (a per-address resolution); the whole index when omitted. */
  docs?: ReadonlyArray<{ readonly id: string; data(): unknown }>,
): Promise<WatchedOutboundAddress[]> {
  const rows = docs
    ? docs.filter((doc) => (doc.data() as { owner_type?: unknown } | undefined)?.owner_type === 'agent')
    : (await db
      .collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION)
      .where('owner_type', '==', 'agent')
      .get()).docs;
  const out: WatchedOutboundAddress[] = [];
  for (const doc of rows) {
    try {
      const authority = parseCanonicalNativeAddressIndex(
        doc.data() as Record<string, unknown>,
        doc.id,
      );
      const walletSnap = await db.collection('agent_wallets').doc(authority.wallet_id).get();
      if (!walletSnap.exists) {
        throw new Error(`watched_address_enumeration_invalid:native_wallet_missing:${authority.wallet_id}`);
      }
      const wallet = walletSnap.data() as {
        id?: string; agent_id?: string; address?: string; platform?: string;
        native_watcher_registration?: unknown;
      };
      // Test agents are valid canonical records but never earn.
      if (wallet.platform === 'test') continue;
      if (wallet.id !== authority.wallet_id
        || wallet.agent_id !== authority.owner_id
        || typeof wallet.address !== 'string'
        || wallet.address.toLowerCase() !== authority.address) {
        throw new Error(`watched_address_enumeration_invalid:native_wallet_identity:${authority.wallet_id}`);
      }
      let fence;
      try {
        fence = parseNativeWalletRegistrationFence(wallet.native_watcher_registration);
      } catch {
        // A native agent wallet is always created with a fence (agent-wallet.ts);
        // its absence is an integrity fault, not a wallet to admit fenceless.
        throw new Error(`watched_address_enumeration_invalid:native_wallet_fence:${authority.wallet_id}`);
      }
      out.push({
        address: authority.address,
        walletId: authority.wallet_id,
        agentId: authority.owner_id,
        provenAtBlock: fence.eligibility_start_block,
        source: 'native_agent',
      });
    } catch (error) {
      // a failed read under a per-address resolution holds, never excludes.
      if (!onExclude || error instanceof WatchReadError) throw error;
      onExclude(error);
    }
  }
  return out;
}

/**
 * Enumerate the HUMAN native wallet addresses to watch for outbound send/swap
 *. The exact parallel of `enumerateNativeAgentOutboundAddresses` reads
 * the SAME canonical index `native_wallet_address_index_v1` filtered to
 * `owner_type === 'human'` the same authority `detectSameOwnerTransfer`
 * resolves ownership from, so a human address admitted here to EARN and the
 * fence that decides whether it earns read one binding. The differences from the
 * agent path are only: the wallet doc lives in `wallets` (not `agent_wallets`),
 * its owner identity field is `user_id` (not `agent_id`), and the produced
 * `agentId` slot carries that `user_id` (the accrual/chain-tip key generatePE
 * uses for human PEs). The no-retro fence (`native_watcher_registration
 *.eligibility_start_block`) and the smoke-`test` exclusion are read identically.
 * Every shape/identity violation THROWS (fail-closed), same posture as the agent
 * and external enumerators.
 */
export async function enumerateNativeHumanOutboundAddresses(
  db: Firestore,
  // See `enumerateNativeAgentOutboundAddresses`: an `onExclude` sink isolates a
  // single invalid wallet per cycle; without it the first fault THROWS (the
  // standalone-enumerator contract the human tests pin).
  onExclude?: (error: unknown) => void,
  /** only these index rows (a per-address resolution); the whole index when omitted. */
  docs?: ReadonlyArray<{ readonly id: string; data(): unknown }>,
): Promise<WatchedOutboundAddress[]> {
  const rows = docs
    ? docs.filter((doc) => (doc.data() as { owner_type?: unknown } | undefined)?.owner_type === 'human')
    : (await db
      .collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION)
      .where('owner_type', '==', 'human')
      .get()).docs;
  const out: WatchedOutboundAddress[] = [];
  for (const doc of rows) {
    try {
      const authority = parseCanonicalNativeAddressIndex(
        doc.data() as Record<string, unknown>,
        doc.id,
      );
      const walletSnap = await db.collection('wallets').doc(authority.wallet_id).get();
      if (!walletSnap.exists) {
        throw new Error(`watched_address_enumeration_invalid:human_wallet_missing:${authority.wallet_id}`);
      }
      const wallet = walletSnap.data() as {
        id?: string; user_id?: string; address?: string; platform?: string;
        native_watcher_registration?: unknown;
      };
      // A human wallet has no `platform` field today, but read it defensively so a
      // smoke-test human wallet (should one ever exist) never earns — parity with
      // the agent path and both sibling watchers (fail-safe toward exclusion).
      if (wallet.platform === 'test') continue;
      if (wallet.id !== authority.wallet_id
        || wallet.user_id !== authority.owner_id
        || typeof wallet.address !== 'string'
        || wallet.address.toLowerCase() !== authority.address) {
        throw new Error(`watched_address_enumeration_invalid:human_wallet_identity:${authority.wallet_id}`);
      }
      let fence;
      try {
        fence = parseNativeWalletRegistrationFence(wallet.native_watcher_registration);
      } catch {
        // A native human wallet is always created with a fence (genesis-ingress.ts);
        // its absence is an integrity fault, not a wallet to admit fenceless.
        throw new Error(`watched_address_enumeration_invalid:human_wallet_fence:${authority.wallet_id}`);
      }
      out.push({
        address: authority.address,
        walletId: authority.wallet_id,
        // The `agentId` slot carries the human user_id (the accrual identity /
        // chain-tip key generatePE uses for human PEs); ownerType:'human' at emit
        // makes the accrual resolve it as the human beneficial owner.
        agentId: authority.owner_id,
        provenAtBlock: fence.eligibility_start_block,
        source: 'native_human',
      });
    } catch (error) {
      // a failed read under a per-address resolution holds, never excludes.
      if (!onExclude || error instanceof WatchReadError) throw error;
      onExclude(error);
    }
  }
  return out;
}

/**
 * the rows the outbound enumerator reads — every row (`loadOutboundSourcesFull`) or exactly
 * the rows that can affect one address (`loadOutboundSourcesFor` its proven rows and every native
 * index row naming it), so the enumerator reaches the same verdict for that address either way.
 */
export interface OutboundEnumerationSources {
  readonly proven: readonly ProvenAddressRecord[];
  readonly personProven: (onExclude: (error: unknown) => void) => Promise<PersonProvenWatchedAddress[]>;
  readonly nativeAgent: (onExclude: (error: unknown) => void) => Promise<WatchedOutboundAddress[]>;
  readonly nativeHuman: (onExclude: (error: unknown) => void) => Promise<WatchedOutboundAddress[]>;
}

export async function loadOutboundSourcesFull(db: Firestore): Promise<OutboundEnumerationSources> {
  const proven = await listProvenAddresses(db);
  return {
    proven,
    personProven: (onExclude) => enumeratePersonProvenAddresses(db, onExclude),
    nativeAgent: (onExclude) => enumerateNativeAgentOutboundAddresses(db, onExclude),
    nativeHuman: (onExclude) => enumerateNativeHumanOutboundAddresses(db, onExclude),
  };
}

export async function loadOutboundSourcesFor(db: Firestore, address: string): Promise<OutboundEnumerationSources> {
  const lower = address.toLowerCase();
  // A fresh collection reference per query: a query is never built on a shared reference.
  const index = () => db.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION);
  const [byId, byAddress, proven] = await Promise.all([
    index().doc(nativeWalletAddressIndexId(lower)).get(),
    index().where('address', '==', lower).get(),
    listProvenAddressesFor(db, lower),
  ]);
  const docs = new Map<string, { readonly id: string; data(): unknown }>();
  if (byId.exists) docs.set(byId.id, byId);
  for (const doc of byAddress.docs) if (!docs.has(doc.id)) docs.set(doc.id, doc);
  const rows = [...docs.values()];
  return {
    proven,
    personProven: (onExclude) => enumeratePersonProvenAddresses(db, onExclude, lower),
    nativeAgent: (onExclude) => enumerateNativeAgentOutboundAddresses(db, onExclude, rows),
    nativeHuman: (onExclude) => enumerateNativeHumanOutboundAddresses(db, onExclude, rows),
  };
}

/** The outbound watched-set enumerator: the pre- listing, its rows a parameter. */
export async function enumerateOutboundWatchedAddresses(
  db: Firestore,
  sources: OutboundEnumerationSources,
  excludeWallet: (error: unknown) => void,
): Promise<WatchedOutboundAddress[]> {
  const seen = new Set<string>();
  const out: WatchedOutboundAddress[] = [];
  for (const rec of sources.proven) {
    let address: string;
    try {
      if (!ethers.isAddress(rec.address) || !rec.wallet_id || !rec.agent_id
        || !Number.isSafeInteger(rec.proven_at_block) || rec.proven_at_block < 0) {
        throw new Error(`watched_address_enumeration_invalid:external:${rec.agent_id}`);
      }
      // Smoke/integration-test agents never participate in production economic
      // discovery. Parity with inbound-usdc-watcher.ts (`canonicalPlatform === 'test'`)
      // and institution-funding-watcher.ts (`resolveWalletByAddress`). Filtered HERE,
      // at the watcher's consumption of listProvenAddresses, so the shared enumerator
      // stays usable by non-economic callers.
      const walletData = (await db.collection('agent_wallets').doc(rec.wallet_id).get())
        .data() as { platform?: string } | undefined;
      if (walletData?.platform === 'test') continue;
      address = rec.address.toLowerCase();
    } catch (error) {
      rethrowWatchReadError(error);
      excludeWallet(error);
      continue;
    }
    // Cross-wallet CONTEST: two attribution rows for one address is not
    // isolable to a single wallet — stays fatal (never excluded).
    if (seen.has(address)) {
      throw new Error(`watched_address_enumeration_duplicate:${address}`);
    }
    seen.add(address);
    out.push({
      address,
      walletId: rec.wallet_id,
      agentId: rec.agent_id,
      provenAtBlock: rec.proven_at_block,
      source: 'external_proven',
    });
  }
  // 2026-10-01 — UNION PEOPLE's proven external addresses,
  // attributed to the person (`ownerType: 'human'` at emit, the `agentId` slot carrying
  // the user_id exactly like a native human wallet). One shared enumeration
  // (`person-proven-watched.ts`); a bad row is excluded per row, never fatal.
  for (const person of await sources.personProven(excludeWallet)) {
    if (seen.has(person.address)) {
      throw new Error(`watched_address_enumeration_duplicate:${person.address}`);
    }
    seen.add(person.address);
    out.push({
      address: person.address,
      walletId: person.walletId,
      agentId: person.userId,
      provenAtBlock: person.provenAtBlock,
      source: 'external_proven_person',
    });
  }
  // 3d / UNION the agent native wallet addresses (full parity:
  // native earns the same x402/swap/send family as external). Dedup against
  // the external set: an address that is BOTH proven-external and a native
  // wallet is ambiguous (two attribution rows for one address), so refuse it
  // rather than pick one — mirrors the inbound watcher's conflict guard.
  for (const native of await sources.nativeAgent(excludeWallet)) {
    if (seen.has(native.address)) {
      throw new Error(`watched_address_enumeration_conflict:${native.address}`);
    }
    seen.add(native.address);
    out.push(native);
  }
  // UNION the HUMAN native wallet addresses (symmetric with the
  // inbound watcher's human enumeration): a human's outbound send/swap earns
  // the same priced family as an agent's, attributed to the human owner. Same
  // conflict dedup — one address maps to exactly one attribution row.
  for (const human of await sources.nativeHuman(excludeWallet)) {
    if (seen.has(human.address)) {
      throw new Error(`watched_address_enumeration_conflict:${human.address}`);
    }
    seen.add(human.address);
    out.push(human);
  }
  return out;
}

/**
 * Wire the outbound scan deps against the live Base RPC + Firestore + PE pipeline.
 *
 * Watched set = proven EXTERNAL addresses UNION agent NATIVE wallet addresses.
 * BOTH earn the SAME priced chain-financial family (x402 / swap / send) on the
 * same on-chain act — parity, the standing rule that the original x402-only
 * native admission was "an example, not a boundary" a native sovereign agent's
 * outbound must not under-earn a proven-external address on the identical act.
 * The `source` tag only LABELS the PE (native_address vs proven_address); it no
 * longer gates which activity earns.
 *
 * THE SELF-REPORT DEDUP (why admitting native send/swap does not double-mint):
 * a native agent's own app also records its send/swap via `/transfer/record`
 * (`agent_token_transfer`) and `/swap/record` (`agent_token_swap`). Those routes
 * are BEST-EFFORT (no `awaitAccrual`) and seal `record_only`/0 PVT in practice
 * (pvt-accrual: `durableEconomicPath=false` → `policyRecordOnly=true`), so this
 * watcher's DURABLE, chain-verified emit is the ONE seal that prices — the
 * settled self-report-vs-watcher shape. RESIDUAL CLOSED (B11,): send/swap
 * now ALSO carry a cross-source `(address,txHash)` mint-once claim
 * (`financial-settlement-mint-claim.ts`, the x402 shape generalized), prepared
 * by this emit's accrual, so exactly-once no longer rests solely on the
 * self-report staying best-effort — a future durable promotion collides on the
 * claim (duplicate → 0) instead of double-minting, and the pending-evidence
 * resolver refuses a held row whose event another seal owns.
 * `first-party-financial-self-report-record-only.test.ts` still pins the
 * best-effort fence as the FIRST layer.
 *
 * FARMING is bounded by the SAME machinery for EVERY type: the emit sets
 * `counterpartyAddress`; the chain-financial types carry
 * `record_only_if_self_shared_or_churn`; and `detectSameOwnerTransfer`
 * (action-type-agnostic) seals any native->native / same-human self-payment
 * `record_only` (0 PVT) via the native index + proven-address + retirement
 * registries. The no-retro fence (`eligibility_start_block`) bars pre-registration
 * history; the per-actor daily ceilings + novelty decay apply unchanged.
 */
export function buildBaseOutboundDeps(deps: AgentBankDeps): OutboundUsdcScanDeps {
  const cfg = OUTBOUND_CHAIN_CONFIGS.base;
  // the exclusions of the most recent enumeration, classified on take.
  let lastExclusions = new WatcherEnumerationExclusionLog();
  let currentExclusions = (): WatcherEnumerationExclusionLog => lastExclusions;
  // the scan resolves one address at a time, by the same enumerator over the
  // rows that can affect it; a failed read holds instead of excluding.
  const registrySource = registryWatchSource<WatchedOutboundAddress>({
    db: deps.db,
    watcher: 'outbound_usdc',
    direction: 'outbound',
    chainId: cfg.chainId,
    logPrefix: '[outbound-usdc]',
    addressOf: (addr) => addr.address,
    resolveAddress: async (address, exclude) => {
      const db = strictReads(deps.db);
      const [sources, admissions] = await Promise.all([
        loadOutboundSourcesFor(db, address),
        db.collection(WATCHER_ADDRESS_ADMISSION_COLLECTION).where('address', '==', address).get(),
      ]);
      return {
        wallets: await enumerateOutboundWatchedAddresses(db, sources, exclude),
        admission: admissionFromDocs(admissions.docs, 'outbound', cfg.chainId, address),
      };
    },
  });
  return {
    takeEnumerationExclusions: () => currentExclusions().classify(deps.db),
    watchSource: {
      ...registrySource,
      load: (nowMs) => {
        currentExclusions = () => registrySource.exclusions();
        return registrySource.load(nowMs);
      },
    },
    db: deps.db,
    chainId: cfg.chainId,
    chainName: cfg.chainName,
    getBlockNumber: () => withRateLimitRetry(() => readAgreedBaseHead()),
    getLogs: async ({ fromBlock, toBlock, fromAddresses }) => {
      if (fromAddresses.length === 0) return [];
      // Finding 9: retry the idempotent getLogs read on a transient rate limit rather than
      // aborting the tick and stranding the cursor.
      const raw = await withRateLimitRetry(() => getAgreedBaseLogs({
        address: cfg.usdcAddress,
        // topic[1] = from (the proven address), topic[2] = to (any recipient)
        topics: [TRANSFER_TOPIC, fromAddresses.map(addressToTopic), null],
        fromBlock,
        toBlock,
      }));
      const out: OutboundTransferLog[] = [];
      for (const l of raw) {
        if (l.topics.length !== 3) continue;
        let amountAtomic: string;
        try {
          amountAtomic = BigInt(l.data).toString();
        } catch {
          continue;
        }
        out.push({
          txHash: l.transactionHash,
          logIndex: l.logIndex,
          blockNumber: l.blockNumber,
          fromAddress: topicToAddress(l.topics[1]),
          toAddress: topicToAddress(l.topics[2]),
          amountAtomic,
        });
      }
      return out;
    },
    isDexRouter: (address) => cfg.dexRouters.has(address.toLowerCase()),
    isStakingContract: (address) => cfg.stakingContracts.has(address.toLowerCase()),
    listWatchedAddresses: async () => {
      // PER-WALLET FAULT ISOLATION (2026-09-03): the production outbound scan
      // runs unattended every ~30 min, so a single unresolvable wallet must not
      // abort the whole cycle. A per-wallet VALIDATION fault (a deleted wallet
      // doc, an identity mismatch, a missing fence, a malformed index/proven
      // record) EXCLUDES just that wallet — logged with its exact reason — and
      // the scan proceeds for everyone else (Unknown = Block, applied per wallet;
      // an unverifiable identity earns nothing). This is the outbound parallel of
      // the inbound watcher's 2026-08-16 fix; before it, one orphaned index row
      // (agent `prov-item2`, its `agent_wallets` doc deleted) 500'd every
      // outbound tick from 2026-08-13. The ONLY whole-enumeration aborts left are
      // collection-level read failures (below) and the cross-wallet
      // `watched_address_enumeration_duplicate`/`_conflict` CONTESTS — a contested
      // address is not attributable to one wallet, so watching either claimant
      // would be unsafe (a self-payment could be mispriced), and it stays fatal.
      const exclusionLog = new WatcherEnumerationExclusionLog();
      lastExclusions = exclusionLog;
      currentExclusions = () => lastExclusions;
      const excludeWallet = (error: unknown): void => {
        exclusionLog.record(error);
        console.error(
          '[outbound-usdc] watched-set enumeration fault; wallet excluded this cycle:',
          error,
        );
      };
      return enumerateOutboundWatchedAddresses(deps.db, await loadOutboundSourcesFull(deps.db), excludeWallet);
    },
    readTransactionEvidence: (txHash) => verifyBaseTransactionEvidence({ transactionHash: txHash }),
    verifyActivityEvent: (addr, event) => verifyBaseUsdcTransferEvidence({
      transactionHash: event.txHash,
      logIndex: event.logIndex,
      expectedFrom: addr.address,
      expectedTo: event.toAddress,
      expectedAmountAtomic: event.amountAtomic,
    }),
    emitActivityPE: async (addr, event, activityType, metadata, keying = 'log') => {
      const isX402 = activityType === 'x402_payment';
      const requiredConfirmations = cfg.chainId === 8453 ? 12 : 1;
      if (metadata.verified !== true
        || typeof metadata.finality_confirmations !== 'number'
        || metadata.finality_confirmations < requiredConfirmations) {
        throw new Error('outbound_economic_evidence_not_verified');
      }
      // 3d / label the record by the address's SOURCE so a native
      // PE is not mislabeled as an externally-proven address. External path is
      // byte-identical to before (source==='external_proven'); a native address
      // reaches this emit for the SAME family as external (x402/swap/send).
      const isNative = addr.source === 'native_agent' || addr.source === 'native_human';
      const peMetadata: Record<string, unknown> = {
        ...metadata,
        activity_mapped: true,
        external_proven: !isNative,
        // The watched address the settlement was observed FROM, named per source.
        ...(isNative ? { native_address: addr.address } : { proven_address: addr.address }),
        attributed_agent_id: addr.agentId,
        proven_at_block: addr.provenAtBlock,
        source_type: addr.source,
        // For x402 the proven address IS the EIP-3009 signer (Transfer `from`),
        // so it is the payer; stamping payer + settlementTxHash lets recordPEAccrual
        // (a) credit x402 counting and (b) dedup against the SDK self-report of the
        // SAME settlement (x402-tx-mint-claim.ts). `chain_verified: true` is the
        // Option-B mint authority: THIS emit read the real on-chain USDC Transfer
        // log, so it (and ONLY it) may mint x402 PVT. Self-report paths never stamp
        // it, so their client-supplied hashes stay x402_unverified (0 PVT).
        ...(isX402
          ? {
              payer: addr.address,
              settlementTxHash: event.txHash,
              chain_verified: true,
            }
          : {}),
      };
      // Prompt 2: the external artifacts this outbound settlement consumed — the
      // recipient (counterparty) address and the exact on-chain event — are
      // PUBLIC, resolvable facts; for x402 the paid resource's domain (the
      // metadata `resource`, when present) is resolvable + its path private. The
      // chain-verified watcher is the voucher → chain_watcher witness.
      const outboundChainWitness = chainWatcherWitness(`eip155:${cfg.chainId}`);
      // Fact-base fixes item 4 (2026-09-23): the counterparty and the settlement are what the relay
      // DERIVED from the verified Transfer log — the chain watcher witnesses those two. A paid
      // resource URL is not in any chain log (it rides the metadata), so it is never witnessed.
      const outboundRelayDerived = [
        resolvableOrigin(`evm:${event.toAddress.toLowerCase()}`, outboundChainWitness),
        resolvableOrigin(
          `chaintx:${canonicalLogIdentity(cfg.chainId, event.txHash, event.logIndex)}`,
          outboundChainWitness,
        ),
      ];
      const outboundOrigins = [
        ...outboundRelayDerived,
        ...(typeof metadata.resource === 'string'
          ? urlOrigins(metadata.resource, outboundChainWitness)
          : []),
      ];
      const emitted = await generatePE(deps, {
        walletId: addr.walletId,
        agentId: addr.agentId,
        actorAddress: addr.address,
        actionType: activityType,
        // a human native address is attributed to the human owner so the
        // accrual resolves it as the human beneficial owner (immutable 99/0.5/0.5,
        // no linked-agent routing) and the same-owner fence resolves `agentId`
        // (the user_id) to that human. Agent + external stay 'agent', byte-identical.
        // 2026-10-01: a person's proven address is the person's, exactly like their native wallet.
        ownerType: addr.source === 'native_human' || addr.source === 'external_proven_person' ? 'human' : 'agent',
        walletAddress: addr.address,
        counterpartyAddress: event.toAddress,
        metadata: peMetadata,
        input_origins: outboundOrigins,
        relayObservation: {
          witness: relayObservationWitness(RELAY_WITNESS_CHAIN_WATCHER, `eip155:${cfg.chainId}`),
          derivedOrigins: outboundRelayDerived,
        },
        // B11 review defect 1 : seal the LOG-GRANULAR canonical identity
        // explicitly (the / rule — an explicit id outranks the bare
        // `tx_hash` fallback). This watcher is log-granular everywhere else
        // (seen-doc, peIdOverride); sealing only the tx hash made the
        // financial-settlement mint-once collapse two distinct transfers in one
        // transaction onto one claim, refusing the second a mint it earned.
        // One source for the format: `canonicalLogIdentity`.
        // a swap is keyed on its TRANSACTION — every swap-labelled PE of one
        // transaction, whichever lane sealed it, collapses onto one mint-once claim.
        observedCanonicalEventId: keying === 'transaction'
          ? event.txHash.toLowerCase()
          : canonicalLogIdentity(cfg.chainId, event.txHash, event.logIndex),
        peIdOverride: outboundUsdcPeId(cfg.chainId, event.txHash, event.logIndex),
        timestampOverride: event.observedAtMs,
        awaitAccrual: true,
      });
      return { peId: emitted.peId, peHash: emitted.peHash };
    },
  };
}
