import {mapBounded} from '../net/map-bounded';
import {BASE_GETLOGS_MAX_RANGE_BLOCKS} from '../onchain/economic-discovery';
/**
 * Inbound USDC detection - the PERMANENT activity-mapping layer (inbound leg).
 *
 * Automatically detects USDC deposits landing in watched wallets on Base and
 * emits a standard `receive` PE on the shared record path - WITHOUT the owner
 * self-reporting. Watched sets: native agent wallets, human wallets, and proven
 * EXTERNAL addresses (fenced at proven_at_block). The backend has only
 * pull-by-hash exact-match verification (tx-verifier.ts); this adds the missing
 * SCAN.
 *
 * DECOUPLED FROM GENESIS (2026-07): the `receive` PE records on the standard
 * path and is bounded by identity/count-only limits. Amount remains exact
 * provenance metadata and never enters eligibility or cap authority. PVT9 IS
 * configured and settlement-armed (verified against production Secret
 * Manager + the `provian-pvt9-settlement` Cloud Scheduler cron,
 * 2026-08-22) — an eligible observation mints on the scheduled cadence, currently every 30 days .
 * ("PVT9 is unconfigured" here was stale, predating arming; do not
 * reintroduce it.) As of, `receive` additionally requires the
 * RECIPIENT to have authored a relationship with the counterparty (prior
 * outbound send/x402, an escrow, or a job) before it mints or counts toward
 * the public financial-activity summary — see
 * `core/pvt/policy/receive-authorship.ts`. That check is deliberately NOT
 * run here: it depends on live, mutable Firestore state, and this PE's id
 * is deterministic for exactly-once-emit retry safety (see below) — baking
 * a live-read result into the hashed PE content would make a crash-recovery
 * retry recompute a different hash for the SAME on-chain event and defeat
 * that idempotency. Authorship is instead evaluated where it CAN be
 * recomputed fresh on every read: minting, in `pvt-accrual.ts`'s
 * `resolveOperationalDisposition`, and the public summary, in
 * `core/public-record/financial-activity.ts`. An unsolicited transfer from
 * a stranger still records in full here; it just never mints and never
 * writes the recipient's public reputation.
 *
 * Pattern mirrors anchor-recovery-worker.ts: a stateless Cloud Run scheduler
 * job that pages eth_getLogs in <=10k-block chunks against a Firestore block
 * checkpoint, rather than a persistent WebSocket. Here it scans USDC Transfer
 * logs whose `to` topic is one of the watched addresses.
 *
 * Every finalized matched transfer records regardless of amount. Exact amounts
 * remain provenance metadata and never enter a PVT economic decision.
 *
 * Farm-likelihood metadata is captured WRITE-ONLY: funding source, amount
 * bucket, time-since-wallet-creation, same-source fan-out, per-wallet burst,
 * circular-source hint. NOTHING is blocked on these - they exist only to separate
 * real from farmed cohorts after the fact.
 *
 * Dedup / finality / backfill (REUSED, not reinvented): each (chainId, txHash,
 * logIndex) is claimed once via a Firestore create before emit; the scan only
 * reaches head - minConfirmations (reorg safety); the block checkpoint advances
 * only after a full run - so at-least-once detection with exactly-once emit.
 */

import crypto from 'crypto';
import { ethers } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import type { AgentBankDeps } from '../agent-bank/types';
import type { AgentWalletDocument } from '../agent-wallet/types';
import { generatePE } from '../agent-bank/pe-utils';
import { canonicalLogIdentity } from './institution-funding-watcher';
import { resolvableOrigin, chainWatcherWitness } from '../provenance/origin-capture';
import { relayObservationWitness, RELAY_WITNESS_CHAIN_WATCHER } from './relay-observation-witness';
import { listProvenAddresses, listProvenAddressesFor, type ProvenAddressRecord } from '../external-address/link';
import { enumeratePersonProvenAddresses, type PersonProvenWatchedAddress } from './person-proven-watched';
import {
  assertBaseUsdcTransferEvidence,
  BASE_WATCHER_CONFIRMATION_FLOOR,
  getAgreedBaseLogs,
  readAgreedBaseHead,
  verifyBaseTransactionEvidence,
  verifyBaseUsdcTransferEvidence,
  type BaseTransactionEvidence,
  type BaseUsdcTransferEvidence,
} from '../onchain/economic-discovery';
import { usdcLegIsWalletExchange } from './wallet-exchange';
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
  INBOUND_WATCHER_CHECKPOINT_COLLECTION,
  parseWatcherAddressAdmission,
  readWatcherCheckpointSnapshot,
  WATCHER_ADDRESS_ADMISSION_COLLECTION,
  type WatcherCheckpointSnapshot,
  watcherAddressAdmissionDocId,
  type WatcherAddressAdmissionDocument,
  type WatcherAddressAdmissionTarget,
} from './watcher-address-admission';
import {
  NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION,
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  nativeWalletAddressIndexId,
  parseCanonicalNativeAddressIndex,
  parseNativeWalletRegistrationFence,
  type CanonicalNativeAddressIndex,
} from './native-wallet-registration';
import {
  AgentAddressLineageError,
  agentWalletRotationCount,
  readAgentAddressLineagePes,
  readAgentRotationHistoryRaw,
  resolveAgentAddressLineage,
  type IdentityPeLookup,
} from '../agent-wallet/agent-address-lineage';
import { rethrowWatchReadError, strictReads } from './watch-read-error';
import {
  admissionFromDocs,
  legacyWatchSource,
  registryWatchSource,
  type WatchSource,
  type WatchSourceView,
} from './watch-source';
import {
  countExclusions,
  persistWatcherEnumerationHealth,
  WatcherEnumerationExclusionLog,
  type WatcherEnumerationExclusion,
} from './watcher-enumeration-health';

// =============================================================================
// COLLECTIONS
// =============================================================================

const CHECKPOINT_COLLECTION = INBOUND_WATCHER_CHECKPOINT_COLLECTION;
const SEEN_COLLECTION = 'genesis_inbound_seen';
/** The durable per-log claim collection (mint-once anchor `8453_<tx>_<logIndex>`). */
export const INBOUND_SEEN_COLLECTION = SEEN_COLLECTION;
const WALLET_FUNDING_COLLECTION = 'genesis_wallet_funding';
const SOURCE_COLLECTION = 'genesis_inbound_source';
const SIGNAL_EVENT_COLLECTION = 'genesis_inbound_signal_events';
const HUMAN_WALLET_REGISTRATION_INDEX_COLLECTION = 'human_wallet_registration_by_user_v1';
// The canonical native ADDRESS index (`native_wallet_address_index_v1`) is
// parsed by the SHARED `parseCanonicalNativeAddressIndex` from
// `native-wallet-registration.ts` — the same authority parser the outbound
// watcher and the same-owner fence use (follow-up). Do not re-declare a
// private copy here; `inbound-usdc-watcher.parser-unification.test.ts` pins it.
const AGENT_REGISTRATION_INDEX_KEYS = Object.freeze([
  'schema_version',
  'registration_id',
  'request_fingerprint_sha256',
  'agent_id',
  'address',
  'wallet_id',
  'pe_id',
  'pe_hash',
  'api_key_prefix',
  'created_at_ms',
  'credential_recovery_generation',
  'updated_at_ms',
] as const);
const HUMAN_REGISTRATION_INDEX_KEYS = Object.freeze([
  'schema_version',
  'user_id',
  'request_fingerprint',
  'wallet_id',
  'pe_id',
  'pe_hash',
  'prev_hash',
  'address',
  'public_key_sha256',
  'economic_device_id',
  'created_at_ms',
  'genesis_qualification_id',
  'standard_accrual_status',
  'standard_accrual_acknowledged_at_ms',
] as const);

interface CanonicalAgentRegistrationIndex {
  peId: string;
  peHash: string;
  createdAtMs: number;
}

function exactKeys(raw: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(raw).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length
    && actual.every((key, index) => key === canonical[index]);
}

/**
 * The agent registration index is re-pointed to the live address by a key
 * rotation but keeps its BIRTH `created_at_ms`, while the rotation re-creates the
 * native address index row at the rotation time. `expectedCreatedAtMs` is
 * therefore the address index's own `created_at_ms` for an un-rotated wallet
 * (the exact pre- check) and the wallet's birth `created_at` for a rotated
 * one, whose address-index anchor is proven separately against the sealed
 * rotation lineage.
 */
function assertAgentRegistrationIndex(
  raw: Record<string, unknown> | undefined,
  authority: CanonicalNativeAddressIndex,
  expectedCreatedAtMs: unknown,
): CanonicalAgentRegistrationIndex {
  if (!raw
    || !exactKeys(raw, AGENT_REGISTRATION_INDEX_KEYS)
    || raw.schema_version !== 'native-agent-registration/v1'
    || raw.agent_id !== authority.owner_id
    || raw.wallet_id !== authority.wallet_id
    || raw.address !== authority.address
    || !Number.isSafeInteger(raw.created_at_ms)
    || raw.created_at_ms !== expectedCreatedAtMs) {
    throw new Error(
      `watched_address_enumeration_invalid:agent_registration_index:${authority.wallet_id}`,
    );
  }
  return {
    peId: raw.pe_id as string,
    peHash: raw.pe_hash as string,
    createdAtMs: raw.created_at_ms as number,
  };
}

function assertHumanRegistrationIndex(
  raw: Record<string, unknown> | undefined,
  authority: CanonicalNativeAddressIndex,
): void {
  if (!raw
    || !exactKeys(raw, HUMAN_REGISTRATION_INDEX_KEYS)
    || raw.schema_version !== 'human-wallet-registration/v2'
    || raw.user_id !== authority.owner_id
    || raw.wallet_id !== authority.wallet_id
    || raw.address?.toString().toLowerCase() !== authority.address
    || raw.created_at_ms !== authority.created_at_ms) {
    throw new Error(
      `watched_address_enumeration_invalid:human_registration_index:${authority.wallet_id}`,
    );
  }
}

function assertRegistrationFencedAdmission(
  raw: Record<string, unknown> | undefined,
  authority: CanonicalNativeAddressIndex,
  eligibilityStartBlock: number,
): void {
  let admission: WatcherAddressAdmissionDocument;
  try {
    admission = parseWatcherAddressAdmission(raw);
  } catch {
    throw new Error(
      `watched_address_enumeration_invalid:native_admission:${authority.wallet_id}`,
    );
  }
  if (admission.schema_version !== 'pvt-watcher-address-admission/v3'
    || admission.generation_fenced_at_registration !== true
    || admission.direction !== 'inbound'
    || admission.chain_id !== BASE_CHAIN_ID
    || admission.address !== authority.address
    || admission.wallet_id !== authority.wallet_id
    || admission.agent_id !== authority.owner_id
    || admission.eligibility_start_block !== eligibilityStartBlock
    || admission.created_at_ms !== authority.created_at_ms) {
    throw new Error(
      `watched_address_enumeration_invalid:native_admission:${authority.wallet_id}`,
    );
  }
}

// =============================================================================
// TYPES
// =============================================================================

/** A decoded USDC Transfer log to a watched address. */
export interface InboundTransferLog {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  fromAddress: string;   // decoded from topic[1]
  toAddress: string;     // decoded from topic[2]
  amountAtomic: string;  // uint256 USDC atomic (6 decimals) as a decimal string
}

export interface WatchedWallet {
  walletId: string;
  agentId: string;
  address: string;       // lowercased
  createdAtMs: number;   // 0 when unknown
  /** First Base block eligible for economic activity. Native wallets derive
   * this from their registration head; external wallets retain their H+1
   * proof fence. Every address persists this value before joining `live`. */
  eligibilityStartBlock: number;
  /** Wallet owner class retained for attribution metadata. Both owner classes
   *  now emit the standard `receive` action; retired funding aliases cannot mint. */
  ownerType?: 'human' | 'agent';
  /** True for a proven EXTERNAL address (Unit 2), false/undefined for a native
   *  Provian agent wallet. Controls the no-retro fence + per-source keying. */
  isExternalProven?: boolean;
  /** No-retro fence: chain head block at proof time. Only logs at or after this
   *  block earn for an external-proven address. Undefined for native wallets,
   *  which instead use the immutable registration-derived eligibility fence. */
  provenAtBlock?: number;
}

export interface InboundFundingEvent {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  fromAddress: string;
  amountUsd: number;
  amountAtomic: string;
  observedAtMs: number;
}

export interface InboundUsdcScanDeps {
  db: Firestore;
  chainId: number;
  chainName: string;
  /** Current chain head block number. */
  getBlockNumber: () => Promise<number>;
  /** Low-level USDC Transfer log fetch for a block range + recipient batch. */
  getLogs: (args: { fromBlock: number; toBlock: number; toAddresses: string[] }) => Promise<InboundTransferLog[]>;
  /** Enumerate the agent wallets to watch (non-test). */
  listWatchedWallets: () => Promise<WatchedWallet[]>;
  /** the watch-registry source production scans with. Absent: the legacy
   * full `listWatchedWallets` list, through the same code path. */
  watchSource?: WatchSource<WatchedWallet>;
  /** the classified exclusions of the most recent `listWatchedWallets`
   * call. When present, the scan reports them and persists the watcher's
   * enumeration health (the ops attention rule reads it). */
  takeEnumerationExclusions?: () => Promise<readonly WatcherEnumerationExclusion[]>;
  /** the durable admission check a claimed event must pass before it
   * emits. Omitted in production — the default is the exact live-admission
   * binding (`assertWatcherAddressAdmissionBinding`). Only the lineage backfill
   * supplies one, to bind a RETIRED address to its sealed lineage window. */
  verifyAddressAdmission?: (
    target: WatcherAddressAdmissionTarget,
    event: InboundFundingEvent,
  ) => Promise<void>;
  /** the whole-transaction read the swap label needs. Called only for a
   * deposit in a transaction the wallet itself signed to a swap target; absent →
   * such a deposit stays pending (Unknown = Block). */
  readTransactionEvidence?: (txHash: string) => Promise<BaseTransactionEvidence>;
  /** Two-operator/confirmation verification before any economic PE is emitted. */
  verifyFundingEvent: (
    wallet: WatchedWallet,
    event: InboundFundingEvent,
  ) => Promise<BaseUsdcTransferEvidence>;
  /** Emit the standard receive PE — or,, a `swap` when the deposit is the
   * proceeds of the wallet's own exchange (keyed on its transaction). `bountyPvt`
   * is legacy report compatibility and the production implementation always
   * returns zero. */
  emitFundingPE: (
    wallet: WatchedWallet,
    event: InboundFundingEvent,
    metadata: Record<string, unknown>,
    activityType?: 'receive' | 'swap',
  ) => Promise<{ peId: string; peHash: string; bountyPvt?: number }>;
  /** Test/fault-injection seam. Throwing here models a process crash after all
   *  range logs are durably claimed but before the per-address cursor advances. */
  beforeBackfillCursorAdvance?: (range: {
    direction: 'inbound';
    address: string;
    fromBlock: number;
    toBlock: number;
  }) => Promise<void>;
  now?: () => number;
}

export interface InboundScanOptions {
  /** Fallback start block when no checkpoint exists. */
  startBlock?: number;
  /** Reorg safety: Base economic eligibility requires at least 12 confirmations. */
  minConfirmations?: number;
  /**
   * Block-range chunk for getLogs. Default 10 — the Alchemy free-tier cap the
   * agreed two-leg read must satisfy (same constraint and same live 400 as the
   * outbound watcher, observed 2026-07-28 the moment un-wedged this
   * lane). Env-override `INBOUND_USDC_BLOCK_CHUNK` after a plan upgrade.
   */
  blockChunk?: number;
  /** Recipient addresses per getLogs topic-OR batch. Default 200. */
  addressBatchSize?: number;
  /** Deprecated compatibility input; ignored. */
  dustFloorUsd?: number;
  /** Deprecated compatibility input; ignored. */
  fundingMinUsd?: number;
  /** Safety cap on blocks processed per run. Default 50_000. */
  maxBlocksPerRun?: number;
  /** Hard ceiling on getLogs calls per run; see the outbound twin. */
  maxLogCallsPerRun?: number;
}

const DEFAULT_INBOUND_BLOCK_CHUNK = BASE_GETLOGS_MAX_RANGE_BLOCKS;
const DEFAULT_INBOUND_MAX_LOG_CALLS_PER_RUN = 300;
/** Recipient addresses per getLogs topic-OR batch (both economic legs answer 20,000 measured). */
const DEFAULT_INBOUND_ADDRESS_BATCH = 5_000;

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export interface InboundScanReport {
  chain_id: number;
  from_block: number;
  to_block: number;
  watched_wallets: number;
  logs_seen: number;
  new_fundings: number;
  pes_emitted: number;
  duplicates_skipped: number;
  dust_skipped: number;
  unmatched_skipped: number;
  /** Logs skipped because they predate an external address's proven_at_block
   *  (no retroactive mint). Always 0 for native-only watched sets. */
  pre_proof_skipped: number;
  errors: number;
  /** Legacy report field; the permanent funding watcher always returns zero. */
  bounty_pvt_granted: number;
  log_calls_used: number;
  budget_stopped: boolean;
  /** wallets that EXIST but were excluded from this cycle's watched set. */
  excluded_wallets: number;
  /** index rows naming a wallet whose document no longer exists. */
  orphaned_index_rows: number;
  /** every exclusion with its exact reason. */
  exclusions: WatcherEnumerationExclusion[];
}

interface WalletFundingDoc {
  count: number;
  first_at: number;
  last_at: number;
  /** Legacy analytical flag. Sticky, but never Genesis mint authority. */
  bounty_eligible?: boolean;
  /** Retired-scanner compatibility flag. No wired endpoint consumes it and the
   *  legacy payout boundary returns zero for first-transaction rewards. */
  first_tx_pending?: boolean;
}

interface SourceDoc {
  funding_count: number;
  last_seen: number;
}

// =============================================================================
// PURE HELPERS
// =============================================================================

/** USDC atomic (6 decimals) decimal string -> USD float, BigInt-safe on the integer part. */
export function atomicUsdcToUsd(atomic: string): number {
  let v: bigint;
  try {
    v = BigInt(atomic);
  } catch {
    return 0;
  }
  if (v < 0n) return 0;
  const whole = v / 1_000_000n;
  const frac = v % 1_000_000n;
  return Number(whole) + Number(frac) / 1e6;
}

export type AmountBucket = 'dust' | 'micro' | 'small' | 'medium' | 'large' | 'xl' | 'whale';

/** Coarse amount bucket for cohort separation (passive metadata only). */
export function amountBucket(usd: number): AmountBucket {
  if (usd < 0.01) return 'dust';
  if (usd < 1) return 'micro';
  if (usd < 10) return 'small';
  if (usd < 100) return 'medium';
  if (usd < 1000) return 'large';
  if (usd < 10000) return 'xl';
  return 'whale';
}

export function inboundSeenDocId(chainId: number, txHash: string, logIndex: number): string {
  return seenDocId(chainId, txHash, logIndex);
}

/**
 * The deterministic PE id this watcher seals for one inbound USDC Transfer log.
 * ONE derivation, read by this watcher's emit and by the chain-record lane
 * (which must know whether this watcher's `receive` for a leg of the same
 * transaction minted before it emits its own act — one transaction mints once
 * per actor).
 */
export function inboundUsdcPeId(chainId: number, txHash: string, logIndex: number): string {
  return `pe_inbound_${crypto.createHash('sha256')
    .update(`${chainId}:${txHash.toLowerCase()}:${logIndex}`)
    .digest('hex')}`;
}

function seenDocId(chainId: number, txHash: string, logIndex: number): string {
  return `${chainId}_${txHash.toLowerCase()}_${logIndex}`;
}

/**
 * ONLY the two-operator disagreement class (economic-discovery.ts `agreed()`,
 * after its bounded both-legs re-poll) qualifies for skip-cycle-not-crash in
 * `scanInboundUsdc`. Every other error class stays loud — a 500 to the
 * scheduler — by design.
 */
function isRpcDisagreementError(error: unknown): boolean {
  return error instanceof Error
    && error.message.startsWith('economic_discovery_rpc_disagreement');
}

function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// =============================================================================
// FARM-LIKELIHOOD METADATA (write-only, no enforcement)
// =============================================================================

/**
 * Read-modify-write the per-wallet funding doc and per-source doc to derive
 * cheap farm signals, and return the metadata to stamp on the PE. These are
 * recorded only; nothing is blocked on them.
 */
async function gatherFarmSignals(
  deps: InboundUsdcScanDeps,
  wallet: WatchedWallet,
  event: InboundFundingEvent,
  watchedAddresses: Set<string>,
  now: number,
  bountyEligible: boolean,
  eventId: string,
): Promise<Record<string, unknown>> {
  const source = event.fromAddress.toLowerCase();
  const walletRef = deps.db.collection(WALLET_FUNDING_COLLECTION).doc(wallet.walletId);
  const sourceRef = deps.db.collection(SOURCE_COLLECTION).doc(source);
  const eventRef = deps.db.collection(SIGNAL_EVENT_COLLECTION).doc(eventId);
  return deps.db.runTransaction(async (txn) => {
    const [eventSnap, walletSnap, sourceSnap] = await Promise.all([
      txn.get(eventRef),
      txn.get(walletRef),
      txn.get(sourceRef),
    ]);
    if (eventSnap.exists) {
      const prior = eventSnap.data()?.signals;
      if (typeof prior !== 'object' || prior === null || Array.isArray(prior)) {
        throw new Error('inbound_signal_event_invalid');
      }
      return prior as Record<string, unknown>;
    }
    const prevWallet = walletSnap.exists ? (walletSnap.data() as WalletFundingDoc) : null;
    const walletFundingCount = (prevWallet?.count ?? 0) + 1;
    const msSincePrevFunding = prevWallet?.last_at ? now - prevWallet.last_at : null;
    const newBountyEligible = bountyEligible || (prevWallet?.bounty_eligible ?? false);
    const prevSource = sourceSnap.exists ? (sourceSnap.data() as SourceDoc) : null;
    const sourceFundingCount = (prevSource?.funding_count ?? 0) + 1;
    const signals: Record<string, unknown> = {
      funding_source: source,
      counterparty_address: source,
      amount_usd: event.amountUsd,
      amount_bucket: amountBucket(event.amountUsd),
      ms_since_wallet_creation: wallet.createdAtMs > 0 ? now - wallet.createdAtMs : null,
      is_sub_dollar: event.amountUsd < 1,
      is_first_funding: walletFundingCount === 1,
      wallet_funding_count: walletFundingCount,
      ms_since_prev_funding: msSincePrevFunding,
      source_funding_count: sourceFundingCount,
      source_is_watched_agent: watchedAddresses.has(source),
    };
    const fundingUpdate: Record<string, unknown> = {
      count: walletFundingCount,
      first_at: prevWallet?.first_at ?? now,
      last_at: now,
      bounty_eligible: newBountyEligible,
    };
    if (prevWallet?.first_tx_pending === undefined && newBountyEligible) {
      fundingUpdate.first_tx_pending = true;
    }
    txn.set(walletRef, fundingUpdate, { merge: true });
    txn.set(sourceRef, { funding_count: sourceFundingCount, last_seen: now }, { merge: true });
    txn.create(eventRef, {
      schema_version: 'inbound-signal-event/v1',
      event_id: eventId,
      signals,
      created_at_ms: now,
    });
    return signals;
  });
}

interface InboundClaimPayload {
  readonly wallet: WatchedWallet;
  readonly event: InboundFundingEvent;
  readonly bountyEligible: boolean;
  readonly sourceIsWatched: boolean;
  readonly chainName: string;
  readonly chainId: number;
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => allowed.has(key));
}

function inboundPayload(value: Record<string, unknown>): InboundClaimPayload {
  const wallet = value.wallet as (Partial<WatchedWallet> & Record<string, unknown>) | undefined;
  const event = value.event as (Partial<InboundFundingEvent> & Record<string, unknown>) | undefined;
  if (!hasExactKeys(value, [
    'wallet',
    'event',
    'bountyEligible',
    'sourceIsWatched',
    'chainName',
    'chainId',
  ])
    || !wallet || !hasExactKeys(wallet, [
      'walletId',
      'agentId',
      'address',
      'createdAtMs',
      'eligibilityStartBlock',
    ], ['ownerType', 'isExternalProven', 'provenAtBlock'])
    || typeof wallet.walletId !== 'string' || wallet.walletId.length === 0
    || typeof wallet.agentId !== 'string' || wallet.agentId.length === 0
    || typeof wallet.address !== 'string' || !ethers.isAddress(wallet.address)
    || wallet.address !== wallet.address.toLowerCase()
    || !Number.isSafeInteger(wallet.createdAtMs) || wallet.createdAtMs! < 0
    || !Number.isSafeInteger(wallet.eligibilityStartBlock)
    || (wallet.eligibilityStartBlock as number) < 0
    || (wallet.ownerType !== undefined
      && wallet.ownerType !== 'human' && wallet.ownerType !== 'agent')
    || (wallet.isExternalProven !== undefined && wallet.isExternalProven !== true)
    || (wallet.isExternalProven === true
      // 2026-10-01: a PERSON's proven address is external AND human-owned.
      ? !Number.isSafeInteger(wallet.provenAtBlock)
        || wallet.provenAtBlock !== wallet.eligibilityStartBlock
      : wallet.provenAtBlock !== undefined)
    || !event || !hasExactKeys(event, [
      'txHash',
      'logIndex',
      'blockNumber',
      'fromAddress',
      'amountUsd',
      'amountAtomic',
      'observedAtMs',
    ])
    || typeof event.txHash !== 'string' || !/^0x[a-f0-9]{64}$/.test(event.txHash)
    || !Number.isSafeInteger(event.logIndex) || event.logIndex! < 0
    || !Number.isSafeInteger(event.blockNumber) || event.blockNumber! < 0
    || event.blockNumber! < (wallet.eligibilityStartBlock as number)
    || typeof event.fromAddress !== 'string' || !ethers.isAddress(event.fromAddress)
    || event.fromAddress !== event.fromAddress.toLowerCase()
    || typeof event.amountAtomic !== 'string' || !/^(0|[1-9][0-9]*)$/.test(event.amountAtomic)
    || typeof event.amountUsd !== 'number' || !Number.isFinite(event.amountUsd)
    || event.amountUsd !== atomicUsdcToUsd(event.amountAtomic)
    || event.observedAtMs !== 0
    || typeof value.bountyEligible !== 'boolean'
    || typeof value.sourceIsWatched !== 'boolean'
    || value.chainName !== 'base'
    || value.chainId !== BASE_CHAIN_ID) {
    throw new Error('inbound_watcher_claim_payload_invalid');
  }
  return value as unknown as InboundClaimPayload;
}

function recoveryWalletMap(wallets: readonly WatchedWallet[]): Map<string, WatchedWallet> {
  const out = new Map<string, WatchedWallet>();
  for (const wallet of wallets) {
    const address = wallet.address.toLowerCase();
    if (out.has(address)) throw new Error(`watched_address_enumeration_duplicate:${address}`);
    out.set(address, { ...wallet, address });
  }
  return out;
}

/** The recipient a durable claim names, or null when its payload does not parse (it then fails on its own). */
function claimRecipient(handle: WatcherClaimHandle): string | null {
  try {
    return inboundPayload(handle.payload).wallet.address;
  } catch {
    return null;
  }
}

async function recoveryWalletMapFor(
  source: WatchSource<WatchedWallet>,
  addresses: ReadonlyArray<string | null>,
): Promise<Map<string, WatchedWallet>> {
  const out = new Map<string, WatchedWallet>();
  for (const address of new Set(addresses.filter((a): a is string => a !== null))) {
    const resolution = await source.resolve(address);
    if (resolution.kind === 'valid') out.set(address, { ...resolution.wallet, address });
  }
  return out;
}

function assertRecoveredWalletAuthority(
  payload: InboundClaimPayload,
  authoritative: Map<string, WatchedWallet> | undefined,
  attempts: number,
): void {
  if (attempts === 1) return;
  const current = authoritative?.get(payload.wallet.address);
  if (!current
    || current.walletId !== payload.wallet.walletId
    || current.agentId !== payload.wallet.agentId
    || current.createdAtMs !== payload.wallet.createdAtMs
    || current.eligibilityStartBlock !== payload.wallet.eligibilityStartBlock
    || (current.ownerType ?? 'agent') !== (payload.wallet.ownerType ?? 'agent')
    || (current.isExternalProven === true) !== (payload.wallet.isExternalProven === true)
    || (current.provenAtBlock ?? null) !== (payload.wallet.provenAtBlock ?? null)) {
    throw new Error('inbound_watcher_claim_authority_mismatch');
  }
}

export async function processInboundClaim(
  deps: InboundUsdcScanDeps,
  handle: WatcherClaimHandle,
  authoritative?: Map<string, WatchedWallet>,
): Promise<{ peId: string; bountyPvt: number }> {
  const payload = inboundPayload(handle.payload);
  if (payload.chainId !== BASE_CHAIN_ID) {
    throw new Error('economic_watcher_non_base_evidence_unsupported');
  }
  assertRecoveredWalletAuthority(payload, authoritative, handle.attempts);
  const admissionTarget = inboundAdmissionTarget(payload.wallet, payload.chainId);
  if (deps.verifyAddressAdmission) {
    await deps.verifyAddressAdmission(admissionTarget, payload.event);
  } else {
    await assertWatcherAddressAdmissionBinding(deps.db, admissionTarget);
  }
  // Recovery never trusts a persisted self-hash as live chain authority. The
  // exact event is independently re-read; freeze either stores the first
  // canonical snapshot or requires byte-identical evidence on every retry.
  const verified = await deps.verifyFundingEvent(payload.wallet, payload.event);
  const activeHandle = await freezeWatcherClaimEvidence(
    deps.db,
    handle,
    verified,
    (deps.now ?? Date.now)(),
  );
  const finality = assertBaseUsdcTransferEvidence(activeHandle.evidenceSnapshot ?? undefined, {
    transactionHash: payload.event.txHash,
    logIndex: payload.event.logIndex,
    fromAddress: payload.event.fromAddress,
    toAddress: payload.wallet.address,
    amountAtomic: payload.event.amountAtomic,
  });
  if (finality.blockNumber !== payload.event.blockNumber
    || finality.blockNumber < payload.wallet.eligibilityStartBlock) {
    throw new Error('inbound_watcher_claim_block_fence_mismatch');
  }
  const canonicalEvent = { ...payload.event, observedAtMs: finality.blockTimestampMs };
  const watched = payload.sourceIsWatched
    ? new Set([payload.event.fromAddress.toLowerCase()])
    : new Set<string>();
  const signals = await gatherFarmSignals(
    deps,
    payload.wallet,
    canonicalEvent,
    watched,
    finality.blockTimestampMs,
    payload.bountyEligible,
    handle.ref.id,
  );
  const metadata: Record<string, unknown> = {
    ...signals,
    tx_hash: canonicalEvent.txHash,
    log_index: canonicalEvent.logIndex,
    block_number: finality.blockNumber,
    block_hash: finality.blockHash,
    chain: payload.chainName,
    chain_id: payload.chainId,
    asset: 'USDC',
    bounty_eligible: payload.bountyEligible,
    verified: true,
    finality_confirmations: BASE_WATCHER_CONFIRMATION_FLOOR,
    finality_reason: null,
    economic_evidence: finality,
  };
  // a deposit that is the proceeds of the wallet's OWN exchange (signed by
  // the wallet, to a known swap target, a different known asset given) is that
  // exchange — labelled and ceiling-counted `swap`, keyed on its transaction —
  // never a `receive` from the pool that paid it. From the landing forward only.
  const exchange = await usdcLegIsWalletExchange({
    transactionHash: canonicalEvent.txHash,
    blockTimestampMs: finality.blockTimestampMs,
    transactionSubmitter: finality.transactionSubmitter,
    transactionTo: finality.transactionTo,
  }, payload.wallet.address, deps.readTransactionEvidence);
  const emitted = await deps.emitFundingPE(
    payload.wallet,
    canonicalEvent,
    metadata,
    exchange ? 'swap' : 'receive',
  );
  await markWatcherClaimComplete(deps.db, activeHandle, emitted.peId, (deps.now ?? Date.now)());
  return { peId: emitted.peId, bountyPvt: emitted.bountyPvt ?? 0 };
}

async function recoverInboundClaims(
  deps: InboundUsdcScanDeps,
  source: WatchSource<WatchedWallet>,
  now: number,
): Promise<{
  completed: number;
  bountyPvt: number;
  errors: number;
  structurallyBlocked: boolean;
}> {
  const recovery = await leaseWatcherRecoveryClaims(deps.db, SEEN_COLLECTION, now);
  const authoritative = recovery.handles.length === 0
    ? undefined
    : source.registry
      // the authority for exactly the leased claims' addresses. A held or
      // excluded address is absent, so its claim fails the authority check and
      // stays pending for the next run.
      ? await recoveryWalletMapFor(source, recovery.handles.map(claimRecipient))
      : recoveryWalletMap(await deps.listWatchedWallets());
  let completed = 0;
  let bountyPvt = 0;
  let errors = recovery.issues.length;
  for (const issue of recovery.issues) {
    console.error('[inbound-usdc] malformed durable recovery claim', issue);
  }
  for (const handle of recovery.handles) {
    try {
      const emitted = await processInboundClaim(deps, handle, authoritative);
      completed += 1;
      bountyPvt += emitted.bountyPvt;
    } catch (error) {
      errors += 1;
      await markWatcherClaimPending(deps.db, handle, error, now).catch((markerError) => {
        console.error('[inbound-usdc] could not persist recovery failure', markerError);
      });
    }
  }
  return {
    completed,
    bountyPvt,
    errors,
    structurallyBlocked: recovery.issues.length > 0,
  };
}

/** per-log outcome of one range scan (the lineage backfill reports it). */
export type InboundRangeLogOutcome =
  | { readonly outcome: 'witnessed'; readonly peId: string }
  | { readonly outcome: 'duplicate' }
  | { readonly outcome: 'pre_fence' }
  | { readonly outcome: 'unmatched' }
  | { readonly outcome: 'claim_create_failed'; readonly error: string }
  | { readonly outcome: 'emit_failed'; readonly error: string };

export interface InboundRangeScanArgs {
  addrMap: Map<string, WatchedWallet>;
  sourceWatchSet: Set<string>;
  /** the addresses to ask the chain about (default: `addrMap`'s keys). */
  filterAddresses?: readonly string[];
  /** resolve a recipient `addrMap` does not hold — a wallet to claim for,
   * 'skip' (not watched for this log), or 'hold' (keep the checkpoint behind it). */
  resolveRecipient?: (address: string) => Promise<WatchedWallet | 'skip' | 'hold'>;
  /** whether a sender is a watched address (default: `sourceWatchSet`). */
  isSourceWatched?: (address: string) => Promise<boolean>;
  fromBlock: number;
  toBlock: number;
  blockChunk: number;
  addressBatchSize: number;
  /** Shared across backfill and band scans: one run, one RPC-call pool. */
  budget: { remaining: number };
  report: InboundScanReport;
  now: () => number;
  /** Optional observer of each fetched log's outcome. Never alters control flow. */
  onLog?: (log: InboundTransferLog, outcome: InboundRangeLogOutcome) => void;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/** Scan one explicit range. A durable claim, rather than a block cursor, owns
 * every discovered event after this returns. */
export async function scanInboundRange(
  deps: InboundUsdcScanDeps,
  args: InboundRangeScanArgs,
): Promise<number> {
  const filter = args.filterAddresses ?? Array.from(args.addrMap.keys());
  if (args.fromBlock > args.toBlock || filter.length === 0) {
    return Number.MAX_SAFE_INTEGER;
  }
  const addressBatches = chunk([...filter], args.addressBatchSize);
  const logs: InboundTransferLog[] = [];
  // Whole windows only: a window is scanned iff the budget covers every
  // address batch in it, so a checkpoint never advances past a block some
  // watched wallet was not asked about.
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
      fromBlock: cursor, toBlock: end, toAddresses: batch,
    }));
    for (const list of batchLogs) logs.push(...list);
  }
  args.report.logs_seen += logs.length;
  logs.sort((a, b) => (a.blockNumber - b.blockNumber) || (a.logIndex - b.logIndex));

  let minFailedBlock = Number.MAX_SAFE_INTEGER;
  for (const log of logs) {
    const recipient = log.toAddress.toLowerCase();
    let wallet = args.addrMap.get(recipient);
    if (!wallet && args.resolveRecipient) {
      const resolved = await args.resolveRecipient(recipient);
      if (resolved === 'hold') {
        // The old run aborted on what holds here: keep the checkpoint behind this
        // log so the next run resolves it again. Never a skip.
        args.report.errors += 1;
        minFailedBlock = Math.min(minFailedBlock, log.blockNumber);
        args.onLog?.(log, { outcome: 'claim_create_failed', error: 'watched_address_resolution_held' });
        continue;
      }
      if (resolved !== 'skip') wallet = resolved;
    }
    if (!wallet) {
      args.report.unmatched_skipped++;
      args.onLog?.(log, { outcome: 'unmatched' });
      continue;
    }
    if (log.blockNumber < wallet.eligibilityStartBlock) {
      args.report.pre_proof_skipped++;
      args.onLog?.(log, { outcome: 'pre_fence' });
      continue;
    }
    const amountUsd = atomicUsdcToUsd(log.amountAtomic);

    const observedAtMs = args.now();
    const event: InboundFundingEvent = {
      txHash: log.txHash,
      logIndex: log.logIndex,
      blockNumber: log.blockNumber,
      fromAddress: log.fromAddress,
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
      fromAddress: log.fromAddress,
      toAddress: wallet.address,
      amountAtomic: log.amountAtomic,
    };
    let claim: WatcherClaimHandle | null;
    try {
      claim = await createWatcherClaim(deps.db, seenRef, binding, {
        wallet,
        event,
        bountyEligible: false,
        sourceIsWatched: args.isSourceWatched
          ? await args.isSourceWatched(log.fromAddress.toLowerCase())
          : args.sourceWatchSet.has(log.fromAddress.toLowerCase()),
        chainName: deps.chainName,
        chainId: deps.chainId,
      }, observedAtMs);
    } catch (error) {
      args.report.errors += 1;
      minFailedBlock = Math.min(minFailedBlock, log.blockNumber);
      console.error('[inbound-usdc] durable claim create failed', log.txHash, log.logIndex, error);
      args.onLog?.(log, { outcome: 'claim_create_failed', error: errorText(error) });
      continue;
    }
    if (claim === null) {
      args.report.duplicates_skipped++;
      args.onLog?.(log, { outcome: 'duplicate' });
      continue;
    }

    try {
      const emitted = await processInboundClaim(deps, claim);
      args.report.pes_emitted++;
      args.report.new_fundings++;
      args.report.bounty_pvt_granted += emitted.bountyPvt;
      args.onLog?.(log, { outcome: 'witnessed', peId: emitted.peId });
    } catch (error) {
      args.report.errors++;
      await markWatcherClaimPending(deps.db, claim, error, args.now()).catch((markerError) => {
        console.error('[inbound-usdc] could not persist pending claim state', markerError);
      });
      console.error('[inbound-usdc] emit failed for', log.txHash, log.logIndex, error);
      args.onLog?.(log, { outcome: 'emit_failed', error: errorText(error) });
    }
  }
  // A budget stop reuses the failed-block convention: the caller checkpoints
  // through budgetStopBlock - 1 and the next run resumes exactly there.
  return Math.min(minFailedBlock, budgetStopBlock);
}

export function inboundAdmissionTarget(wallet: WatchedWallet, chainId: number): WatcherAddressAdmissionTarget {
  if (!Number.isSafeInteger(wallet.eligibilityStartBlock)
    || wallet.eligibilityStartBlock < 0) {
    throw new Error(`inbound_watcher_admission_fence_invalid:${wallet.address}`);
  }
  return {
    direction: 'inbound',
    chainId,
    address: wallet.address,
    walletId: wallet.walletId,
    agentId: wallet.agentId,
    eligibilityStartBlock: wallet.eligibilityStartBlock,
  };
}

async function catchUpInboundAddress(
  deps: InboundUsdcScanDeps,
  wallet: WatchedWallet,
  initial: WatcherAddressAdmissionDocument,
  args: Omit<InboundRangeScanArgs, 'addrMap' | 'fromBlock' | 'toBlock'>,
  maxBlocksPerRun: number,
  finalizedThroughBlock: number,
  expectedMembershipGeneration: number,
): Promise<{
  admission: WatcherAddressAdmissionDocument;
  membershipGeneration: number;
}> {
  const target = inboundAdmissionTarget(wallet, deps.chainId);
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
    const minFailedBlock = await scanInboundRange(deps, {
      ...args,
      addrMap: new Map([[wallet.address, wallet]]),
      fromBlock,
      toBlock,
    });
    const processedThrough = minFailedBlock === Number.MAX_SAFE_INTEGER
      ? toBlock
      : Math.min(toBlock, minFailedBlock - 1);
    if (processedThrough < fromBlock) break;
    await deps.beforeBackfillCursorAdvance?.({
      direction: 'inbound',
      address: wallet.address,
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
 * report and persist this cycle's watched-set exclusions. The health
 * write is best-effort — the scan's own result never depends on it — but its
 * absence is itself visible (the ops rule ages a stale health document).
 */
async function recordEnumerationHealth(
  deps: InboundUsdcScanDeps,
  report: InboundScanReport,
  watchedCount: number,
  nowMs: number,
  source?: WatchSource<WatchedWallet>,
): Promise<void> {
  if (!deps.takeEnumerationExclusions) return;
  let exclusions: readonly WatcherEnumerationExclusion[];
  try {
    exclusions = await deps.takeEnumerationExclusions();
    // this run resolved only addresses with work plus one sweep slice; the
    // last completed sweep cycle keeps an idle excluded wallet visible meanwhile.
    if (source?.registry) exclusions = await source.healthExclusions(exclusions);
  } catch (error) {
    console.error('[inbound-usdc] exclusion classification failed', error);
    return;
  }
  const counts = countExclusions(exclusions);
  report.excluded_wallets = counts.excluded_wallets;
  report.orphaned_index_rows = counts.orphaned_index_rows;
  report.exclusions = [...exclusions];
  try {
    await persistWatcherEnumerationHealth(deps.db, 'inbound_usdc', {
      watchedCount,
      exclusions,
      now: nowMs,
    });
  } catch (error) {
    console.error('[inbound-usdc] enumeration health write failed', error);
  }
}

/**
 * Scan for inbound USDC to watched agent wallets and emit funding PEs.
 * Idempotent across overlapping runs via the per-log claim. Advances the
 * block checkpoint at the end so a crash mid-run safely re-scans.
 */
export async function scanInboundUsdc(
  deps: InboundUsdcScanDeps,
  opts: InboundScanOptions = {},
): Promise<InboundScanReport> {
  if (deps.chainId !== BASE_CHAIN_ID || deps.chainName !== 'base') {
    throw new Error('economic_watcher_non_base_evidence_unsupported');
  }
  const now = deps.now ?? Date.now;
  const minConfirmations = deps.chainId === 8453
    ? Math.max(12, opts.minConfirmations ?? 12)
    : (opts.minConfirmations ?? 5);
  const blockChunk = opts.blockChunk
    ?? envPositiveInt('INBOUND_USDC_BLOCK_CHUNK', DEFAULT_INBOUND_BLOCK_CHUNK);
  const addressBatchSize = opts.addressBatchSize ?? DEFAULT_INBOUND_ADDRESS_BATCH;
  const maxBlocksPerRun = opts.maxBlocksPerRun ?? 50_000;
  const maxLogCallsPerRun = opts.maxLogCallsPerRun
    ?? envPositiveInt('INBOUND_USDC_MAX_LOG_CALLS_PER_RUN', DEFAULT_INBOUND_MAX_LOG_CALLS_PER_RUN);
  const budget = { remaining: maxLogCallsPerRun };
  // production reads the watch registry and resolves only addresses with work; without a
  // registry source the legacy full list runs through the same code (every address pending).
  const source: WatchSource<WatchedWallet> = deps.watchSource
    ?? legacyWatchSource(deps.listWatchedWallets, (wallet) => wallet.address, (wallet, address) => ({ ...wallet, address }));

  const report: InboundScanReport = {
    chain_id: deps.chainId,
    from_block: 0,
    to_block: 0,
    watched_wallets: 0,
    logs_seen: 0,
    new_fundings: 0,
    pes_emitted: 0,
    duplicates_skipped: 0,
    dust_skipped: 0,
    unmatched_skipped: 0,
    pre_proof_skipped: 0,
    errors: 0,
    bounty_pvt_granted: 0,
    log_calls_used: 0,
    budget_stopped: false,
    excluded_wallets: 0,
    orphaned_index_rows: 0,
    exclusions: [],
  };

  // Durable claims survive checkpoint advancement. Re-verify them before the
  // new range so an RPC disagreement or post-PE accrual failure cannot strand
  // economic evidence behind the scan cursor.
  try {
    const recovered = await recoverInboundClaims(deps, source, now());
    report.pes_emitted += recovered.completed;
    report.new_fundings += recovered.completed;
    report.bounty_pvt_granted += recovered.bountyPvt;
    report.errors += recovered.errors;
    if (recovered.structurallyBlocked) return report;
  } catch (error) {
    report.errors += 1;
    console.error('[inbound-usdc] durable recovery scan failed', error);
    return report;
  }

  // Read the generation before the watched addresses. Any address that becomes
  // live after this point increments it transactionally (in the same commit that
  // adds it to the watch registry) and fences this worker's checkpoint commit.
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
  report.watched_wallets = view.candidates.length;
  if (!source.registry) await recordEnumerationHealth(deps, report, view.candidates.length, now());
  try {
    return await scanInboundBand(deps, source, view, checkpointSnapshot, report, budget, {
      minConfirmations, blockChunk, addressBatchSize, maxBlocksPerRun, now, opts,
    });
  } finally {
    // Registry mode: the exclusions are the resolutions this run made, known only at its end.
    if (source.registry) await recordEnumerationHealth(deps, report, view.candidates.length, now(), source);
  }
}

interface InboundBandSettings {
  readonly minConfirmations: number;
  readonly blockChunk: number;
  readonly addressBatchSize: number;
  readonly maxBlocksPerRun: number;
  readonly now: () => number;
  readonly opts: InboundScanOptions;
}

async function scanInboundBand(
  deps: InboundUsdcScanDeps,
  source: WatchSource<WatchedWallet>,
  view: WatchSourceView,
  checkpointSnapshot: WatcherCheckpointSnapshot,
  report: InboundScanReport,
  budget: { remaining: number },
  settings: InboundBandSettings,
): Promise<InboundScanReport> {
  const { minConfirmations, blockChunk, addressBatchSize, maxBlocksPerRun, now, opts } = settings;
  let head: number;
  try {
    head = await deps.getBlockNumber();
  } catch (error) {
    if (!isRpcDisagreementError(error)) throw error;
    // A two-provider head split that survived the bounded re-poll: skip the
    // CYCLE, not the process (2026-08-16 audit item 3). Nothing has been read
    // for this range yet, the checkpoint is untouched, and the next tick
    // resumes exactly here. A disagreed answer is never consumed — the
    // two-operator agreement invariant holds; only the tick is sacrificed.
    report.errors += 1;
    console.error('[inbound-usdc] two-provider disagreement; cycle skipped', error);
    return report;
  }
  // Inclusive confirmations: a log at H-11 has exactly 12 confirmations.
  const toBlockTarget = head - minConfirmations + 1;

  if (view.candidates.length === 0) {
    // Empty watched set: advance the cursor to the finalized head rather than
    // returning early, so it tracks head instead of silently freezing. This is
    // the receive-side sibling of the outbound-watcher fix — identical shape,
    // identical safety: no watched address means no log can exist in the range,
    // and any address admitted later independently backfills from its own fence
    // up to this checkpoint (advanceEmptyWatcherCheckpoint docblock). Inert in
    // production today (this set is non-empty), so it only ever fires if the
    // watched set genuinely empties — exactly when the freeze would otherwise
    // begin. the registry is add-only and returns null until seeded, so
    // an empty registry means no address was ever made watchable.
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
  if (opts.maxLogCallsPerRun === undefined && !process.env.INBOUND_USDC_MAX_LOG_CALLS_PER_RUN) {
    budget.remaining = Math.max(budget.remaining, Math.ceil(view.candidates.length / addressBatchSize));
  }
  const candidateSet = new Set(view.candidates);
  // `source_is_watched` (farm-signal metadata): the sender is a watched address
  // that resolves valid — the old run's validated set, backfilling ones included.
  const isSourceWatched = async (address: string): Promise<boolean> => {
    const lower = address.toLowerCase();
    return candidateSet.has(lower) && (await source.resolve(lower)).kind === 'valid';
  };

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
  // Every address catches up from its immutable eligibility fence through the
  // checkpoint that existed when it was discovered. Native registrations use
  // birth-head + 1; external proofs retain H + 1. No address is claimed for in
  // the global band until its durable cursor reaches `live`.
  //
  // only PENDING addresses get that per-address work — those not yet
  // marked live (new registrations and proofs), those still backfilling, and
  // late repairs. A marked address's admission is live; nothing changes it but a
  // rebind, which removes the mark in its own transaction.
  const liveAddrMap = new Map<string, WatchedWallet>();
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
        // Not processed this run. It stays in the band below, so a log for it
        // holds the checkpoint rather than being passed.
        report.errors += 1;
        continue;
      }
      if (resolution.kind === 'excluded') {
        // The old run left an excluded wallet out of its band. A live admission
        // needs no per-address work (mark it; a log is still resolved at use);
        // otherwise park it until tomorrow (or until it registers or proves again).
        if (resolution.admission?.state === 'live') {
          toMark.push(address);
          markGeneration = Math.max(markGeneration, resolution.admission.membership_generation);
        }
        else toPark.push(address);
        continue;
      }
      const wallet = resolution.wallet;
      const target = inboundAdmissionTarget(wallet, deps.chainId);
      const ensured = await ensureWatcherAddressAdmission(
        deps.db,
        target,
        catchUpThroughBlock,
        CHECKPOINT_COLLECTION,
        membershipGeneration,
        now(),
      );
      membershipGeneration = ensured.membershipGeneration;
      const caughtUp = await catchUpInboundAddress(deps, wallet, ensured.admission, {
        sourceWatchSet: candidateSet,
        isSourceWatched,
        blockChunk,
        addressBatchSize,
        budget,
        report,
        now,
      }, maxBlocksPerRun, toBlockTarget, membershipGeneration);
      membershipGeneration = caughtUp.membershipGeneration;
      if (caughtUp.admission.state !== 'live') continue;
      if (view.late.has(address)) {
        // A reconcile repair: this address was never in a registry-driven band, so
        // rescan it alone from its fence through the committed checkpoint (claims
        // are idempotent per log). This run's band covers it from here on.
        await rescanLateInboundAddress(deps, source, wallet, view.late.get(address) ?? null, catchUpThroughBlock, {
          sourceWatchSet: candidateSet, isSourceWatched, blockChunk, addressBatchSize, budget, report, now,
        });
      }
      liveAddrMap.set(address, wallet);
      toMark.push(address);
      markGeneration = Math.max(markGeneration, caughtUp.admission.membership_generation);
    }
    await source.markLive(toMark, now(), markGeneration);
    await source.park(toPark, now());
    // The health sweep: a fixed slice of the registry per run, resolved only so an
    // idle wallet that has become invalid is reported. A parked address that now
    // resolves valid is re-queued for tomorrow's work to happen next run instead.
    for (const address of await source.sweep(view)) {
      const resolution = await source.resolve(address);
      if (resolution.kind === 'valid' && view.parked.has(address)) requeue.add(address);
    }

    if (fromBlock > toBlock) return report;

    // The band asks the chain about EVERY watched address (the registry, plus any
    // pending address outside it), and resolves a recipient only when a log names
    // it: valid with a live admission is claimed with the FRESH record; excluded is
    // skipped (the old band left it out); a hold keeps the checkpoint behind the log.
    // A valid address whose admission is not live is skipped and re-queued: its
    // catch-up from its fence covers the log. Legacy mode keeps the old band: live
    // addresses only.
    const bandAddresses = source.registry
      ? [...new Set([...view.candidates, ...pending, ...liveAddrMap.keys()])]
      : [...liveAddrMap.keys()];
    const resolveRecipient = source.registry
      ? async (address: string): Promise<WatchedWallet | 'skip' | 'hold'> => {
        const resolution = await source.resolve(address);
        if (resolution.kind === 'hold') return 'hold';
        if (resolution.kind === 'excluded') return 'skip';
        if (resolution.admission?.state === 'live') return resolution.wallet;
        requeue.add(address);
        return 'skip';
      }
      : undefined;

    // Only a failure to CREATE durable ownership holds the global checkpoint.
    // Once a claim exists, its payload/lease is an independent recovery cursor.
    //
    // The band commits INCREMENTALLY, one stride segment at a time (the
    // addendum, mirroring the outbound watcher): at the 10-block provider cap a
    // deep backlog takes minutes of sequential calls, and a single end-of-band
    // commit lost the entire tick's progress whenever the request deadline, the
    // call budget, or a provider error cut the run.
    const commitStride = blockChunk * 20;
    let expectedLastProcessed = checkpointSnapshot.lastProcessedBlock;
    let segmentStart = fromBlock;
    while (segmentStart <= toBlock) {
      const segmentEnd = Math.min(segmentStart + commitStride - 1, toBlock);
      const minFailedBlock = await scanInboundRange(deps, {
        addrMap: liveAddrMap,
        filterAddresses: bandAddresses,
        resolveRecipient,
        sourceWatchSet: candidateSet,
        isSourceWatched,
        fromBlock: segmentStart,
        toBlock: segmentEnd,
        blockChunk,
        addressBatchSize,
        budget,
        report,
        now,
      });
      // A claimed event is recoverable independently of this cursor. Only an
      // event for which durable ownership itself failed keeps the cursor behind
      // it. If that happened on block zero there is no non-negative cursor to
      // commit — preserve the absent checkpoint instead of writing -1.
      const processedThrough = minFailedBlock === Number.MAX_SAFE_INTEGER
        ? segmentEnd
        : Math.min(segmentEnd, minFailedBlock - 1);
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
  } catch (error) {
    // Narrow skip-cycle-not-crash (2026-08-16 audit item 3): ONLY a
    // two-provider disagreement that survived economic-discovery's bounded
    // re-poll ends the cycle as a logged report instead of a thrown 500.
    // Already-committed incremental segments stand, the checkpoint is
    // untouched beyond them, and the next tick resumes exactly where the last
    // segment committed. NEVER applied inside processInboundClaim — a
    // per-claim failure already marks its durable claim pending and must keep
    // doing so. Every other error class still throws.
    if (!isRpcDisagreementError(error)) throw error;
    report.errors += 1;
    console.error('[inbound-usdc] two-provider disagreement; remainder of cycle skipped', error);
    return report;
  } finally {
    if (requeue.size > 0) await source.requeue([...requeue], now());
  }

  return report;
}

/** Rescan one late (reconcile-repaired) address from its resume point through `throughBlock`. */
async function rescanLateInboundAddress(
  deps: InboundUsdcScanDeps,
  source: WatchSource<WatchedWallet>,
  wallet: WatchedWallet,
  resumeAt: number | null,
  throughBlock: number,
  args: Omit<InboundRangeScanArgs, 'addrMap' | 'fromBlock' | 'toBlock'>,
): Promise<void> {
  let next = Math.max(resumeAt ?? wallet.eligibilityStartBlock, wallet.eligibilityStartBlock);
  while (next <= throughBlock) {
    const end = Math.min(throughBlock, next + args.blockChunk * 20 - 1);
    const minFailedBlock = await scanInboundRange(deps, {
      ...args,
      addrMap: new Map([[wallet.address, wallet]]),
      fromBlock: next,
      toBlock: end,
    });
    const processedThrough = minFailedBlock === Number.MAX_SAFE_INTEGER ? end : Math.min(end, minFailedBlock - 1);
    if (processedThrough >= next) {
      next = processedThrough + 1;
      await source.advanceLate(wallet.address, next);
    }
    if (minFailedBlock !== Number.MAX_SAFE_INTEGER) return;
  }
  await source.clearLate(wallet.address);
}

// =============================================================================
// WATCHED-SET ENUMERATION (one enumerator, two scopes —)
// =============================================================================

/** One source document as the enumerator reads it (a Firestore document snapshot). */
interface InboundSourceDoc {
  readonly id: string;
  data(): unknown;
}

/**
 * The rows the enumerator reads. `loadInboundSourcesFull` returns every row (the operator tools'
 * full listing); `loadInboundSourcesFor` returns exactly the rows that can affect one address —
 * every index row naming the address or its wallet, its wallet's registration indexes, every
 * admission naming the address, and its proven rows — so the enumerator reaches the same verdict
 * for that address as it does over the full set.
 */
export interface InboundEnumerationSources {
  readonly addressIndexDocs: readonly InboundSourceDoc[];
  readonly agentIndexDocs: readonly InboundSourceDoc[];
  readonly humanIndexDocs: readonly InboundSourceDoc[];
  readonly admissionDocs: readonly InboundSourceDoc[];
  readonly proven: readonly ProvenAddressRecord[];
  readonly personProven: (onExclude: (error: unknown) => void) => Promise<PersonProvenWatchedAddress[]>;
}

export async function loadInboundSourcesFull(db: Firestore): Promise<InboundEnumerationSources> {
  const [addressIndexSnap, agentIndexSnap, humanIndexSnap, admissionSnap, proven] = await Promise.all([
    db.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION).get(),
    db.collection(NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION).get(),
    db.collection(HUMAN_WALLET_REGISTRATION_INDEX_COLLECTION).get(),
    db.collection(WATCHER_ADDRESS_ADMISSION_COLLECTION).get(),
    listProvenAddresses(db),
  ]);
  return {
    addressIndexDocs: addressIndexSnap.docs,
    agentIndexDocs: agentIndexSnap.docs,
    humanIndexDocs: humanIndexSnap.docs,
    admissionDocs: admissionSnap.docs,
    proven,
    personProven: (onExclude) => enumeratePersonProvenAddresses(db, onExclude),
  };
}

function uniqueDocs(groups: ReadonlyArray<readonly InboundSourceDoc[]>): InboundSourceDoc[] {
  const byId = new Map<string, InboundSourceDoc>();
  for (const group of groups) for (const doc of group) if (!byId.has(doc.id)) byId.set(doc.id, doc);
  return [...byId.values()];
}

/** Every native-index row that names `address` or its wallet, plus the rows that wallet owns. */
export async function loadNativeIndexRowsFor(
  db: Firestore,
  address: string,
): Promise<{ docs: InboundSourceDoc[]; walletIds: string[] }> {
  // A fresh collection reference per query: a query is never built on a shared reference.
  const index = () => db.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION);
  const [byId, byAddress] = await Promise.all([
    index().doc(nativeWalletAddressIndexId(address)).get(),
    index().where('address', '==', address).get(),
  ]);
  const direct = uniqueDocs([byId.exists ? [byId] : [], byAddress.docs]);
  const walletIds = [...new Set(direct
    .map((doc) => (doc.data() as { wallet_id?: unknown } | undefined)?.wallet_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const siblings = await Promise.all(walletIds.map((id) => index().where('wallet_id', '==', id).get()));
  return { docs: uniqueDocs([direct, ...siblings.map((snap) => snap.docs)]), walletIds };
}

export async function loadInboundSourcesFor(db: Firestore, address: string): Promise<InboundEnumerationSources> {
  const lower = address.toLowerCase();
  const native = await loadNativeIndexRowsFor(db, lower);
  const byWallet = (collection: string) => Promise.all(native.walletIds
    .map((id) => db.collection(collection).where('wallet_id', '==', id).get()))
    .then((snaps) => uniqueDocs(snaps.map((snap) => snap.docs)));
  const [agentIndexDocs, humanIndexDocs, admissionSnap, proven] = await Promise.all([
    byWallet(NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION),
    byWallet(HUMAN_WALLET_REGISTRATION_INDEX_COLLECTION),
    db.collection(WATCHER_ADDRESS_ADMISSION_COLLECTION).where('address', '==', lower).get(),
    listProvenAddressesFor(db, lower),
  ]);
  return {
    addressIndexDocs: native.docs,
    agentIndexDocs,
    humanIndexDocs,
    admissionDocs: admissionSnap.docs,
    proven,
    personProven: (onExclude) => enumeratePersonProvenAddresses(db, onExclude, lower),
  };
}

/**
 * The inbound watched-set enumerator. Every check, contest and exclusion is the pre-
 * listing's, unchanged; only the source of the rows is a parameter.
 */
export async function enumerateInboundWatchedWallets(
  db: Firestore,
  sources: InboundEnumerationSources,
  excludeWallet: (error: unknown) => void,
): Promise<WatchedWallet[]> {
  const out: WatchedWallet[] = [];
  const addressOwners = new Map<string, { ownerType: 'agent' | 'human'; ownerId: string }>();
  const agentIndexesByWallet = new Map<string, Record<string, unknown>>();
  const contestedAgentIndexWalletIds = new Set<string>();
  for (const doc of sources.agentIndexDocs) {
    const raw = doc.data() as Record<string, unknown>;
    if (!exactKeys(raw, AGENT_REGISTRATION_INDEX_KEYS)
      || raw.schema_version !== 'native-agent-registration/v1'
      || typeof raw.wallet_id !== 'string' || raw.wallet_id.length === 0) {
      excludeWallet(
        new Error(`watched_address_enumeration_invalid:agent_registration_index:${doc.id}`),
      );
      continue;
    }
    if (agentIndexesByWallet.has(raw.wallet_id)
      || contestedAgentIndexWalletIds.has(raw.wallet_id)) {
      // Two registration-index docs claiming one wallet: neither is
      // authority. Poison the wallet id (never first-doc-wins) so the
      // authority loop's assert faults — and thereby excludes — exactly
      // that wallet.
      contestedAgentIndexWalletIds.add(raw.wallet_id);
      agentIndexesByWallet.delete(raw.wallet_id);
      excludeWallet(
        new Error(`watched_address_enumeration_invalid:agent_registration_index:${doc.id}`),
      );
      continue;
    }
    agentIndexesByWallet.set(raw.wallet_id, raw);
  }
  const humanIndexesByWallet = new Map<string, Record<string, unknown>>();
  const contestedHumanIndexWalletIds = new Set<string>();
  for (const doc of sources.humanIndexDocs) {
    const raw = doc.data() as Record<string, unknown>;
    if (!exactKeys(raw, HUMAN_REGISTRATION_INDEX_KEYS)
      || raw.schema_version !== 'human-wallet-registration/v2'
      || typeof raw.wallet_id !== 'string' || raw.wallet_id.length === 0) {
      excludeWallet(
        new Error(`watched_address_enumeration_invalid:human_registration_index:${doc.id}`),
      );
      continue;
    }
    if (humanIndexesByWallet.has(raw.wallet_id)
      || contestedHumanIndexWalletIds.has(raw.wallet_id)) {
      contestedHumanIndexWalletIds.add(raw.wallet_id);
      humanIndexesByWallet.delete(raw.wallet_id);
      excludeWallet(
        new Error(`watched_address_enumeration_invalid:human_registration_index:${doc.id}`),
      );
      continue;
    }
    humanIndexesByWallet.set(raw.wallet_id, raw);
  }
  const admissionsByAddress = new Map<string, WatcherAddressAdmissionDocument>();
  for (const doc of sources.admissionDocs) {
    let admission: WatcherAddressAdmissionDocument;
    try {
      admission = parseWatcherAddressAdmission(doc.data() as Record<string, unknown>);
    } catch {
      // The wallet this malformed admission belongs to faults (and is
      // excluded) in the authority loop below, where its address finds no
      // parsed admission.
      excludeWallet(new Error(`watched_address_enumeration_invalid:admission:${doc.id}`));
      continue;
    }
    if (admission.direction !== 'inbound' || admission.chain_id !== BASE_CHAIN_ID) continue;
    if (admissionsByAddress.has(admission.address)) {
      throw new Error(`watched_address_enumeration_duplicate_admission:${admission.address}`);
    }
    admissionsByAddress.set(admission.address, admission);
  }
  const nativeWalletIds = new Set<string>();
  for (const doc of sources.addressIndexDocs) {
    let authority: CanonicalNativeAddressIndex;
    try {
      authority = parseCanonicalNativeAddressIndex(
        doc.data() as Record<string, unknown>,
        doc.id,
      );
    } catch (error) {
      excludeWallet(error);
      continue;
    }
    // Cross-wallet duplicate: not attributable to one wallet — still
    // aborts the whole enumeration (see the isolation note above).
    if (nativeWalletIds.has(authority.wallet_id) || addressOwners.has(authority.address)) {
      throw new Error(`watched_address_enumeration_duplicate:${authority.address}`);
    }
    nativeWalletIds.add(authority.wallet_id);
    try {
      const walletCollection = authority.owner_type === 'agent' ? 'agent_wallets' : 'wallets';
      const walletSnap = await db
        .collection(walletCollection).doc(authority.wallet_id).get();
      if (!walletSnap.exists) {
        throw new Error(
          `watched_address_enumeration_invalid:${authority.owner_type}_wallet_missing:${authority.wallet_id}`,
        );
      }
      const wallet = walletSnap.data() as Record<string, unknown>;
      // consignment: a live `platform: 'test'` marker excludes the
      // wallet from production economic discovery for BOTH owner classes,
      // BEFORE any identity/birth-chain read — parity with
      // outbound-usdc-watcher.ts (enumerateNativeAgentOutboundAddresses /
      // listWatchedAddresses) and the other economic surfaces
      // (pvt-accrual, leaderboard, commons feed, genesis-milestones,
      // institution watchers, durable-accrual-effects,
      // genesis-award-state-machine). The wallet stays a valid canonical
      // record; it just never earns. The BIRTH-platform skip further down
      // is retained so a born-test wallet whose live marker is later
      // removed stays excluded (fail-closed in the smuggle direction).
      if (wallet.platform === 'test') continue;
      let registrationFence;
      try {
        registrationFence = parseNativeWalletRegistrationFence(
          wallet.native_watcher_registration,
        );
      } catch {
        throw new Error(
          `watched_address_enumeration_invalid:${authority.owner_type}_wallet_fence:${authority.wallet_id}`,
        );
      }
      const admission = admissionsByAddress.get(authority.address);
      assertRegistrationFencedAdmission(
        admission as unknown as Record<string, unknown> | undefined,
        authority,
        registrationFence.eligibility_start_block,
      );
      if (authority.owner_type === 'agent') {
        // a key rotation (rotate-key / recovery-rekey) re-creates the
        // address index row at the ROTATION time while the registration
        // index, the wallet's created_at and the birth PE keep the BIRTH
        // anchor — so the birth-equality checks below excluded every rotated
        // agent every cycle. An un-rotated wallet keeps those exact checks;
        // a rotated one is admitted only when its address row is anchored at
        // `last_rotated_at` AND the rotation is proven by the sealed lineage
        // (rotation_history bound to its sealed `agent_key_rotated` identity
        // PEs). A row anchored at neither is still excluded.
        let rotationCount: number;
        try {
          rotationCount = agentWalletRotationCount(wallet);
        } catch {
          throw new Error(
            `watched_address_enumeration_invalid:agent_rotation_lineage:${authority.wallet_id}`,
          );
        }
        const rotated = rotationCount > 0;
        const registrationIndex = assertAgentRegistrationIndex(
          agentIndexesByWallet.get(authority.wallet_id),
          authority,
          rotated ? wallet.created_at : authority.created_at_ms,
        );
        if (wallet.id !== authority.wallet_id
          || wallet.agent_id !== authority.owner_id
          || typeof wallet.address !== 'string'
          || wallet.address.toLowerCase() !== authority.address
          || wallet.created_at !== registrationIndex.createdAtMs
          || typeof wallet.platform !== 'string'
          || wallet.platform.length === 0) {
          throw new Error(
            `watched_address_enumeration_invalid:agent_wallet_identity:${authority.wallet_id}`,
          );
        }
        if (rotated && authority.created_at_ms !== wallet.last_rotated_at) {
          throw new Error(
            `watched_address_enumeration_invalid:agent_address_anchor:${authority.wallet_id}`,
          );
        }
        // PE METER (2026-10-03): the birth PE (and, for a rotated wallet, each
        // rotation PE) is POINT-READ as the identity act its index / history entry
        // pins — never by walking the agent's chain, which grew with history on
        // every cycle and is no longer stored.
        let canonicalPlatform: unknown;
        let rotationHistory: Record<string, unknown>[] = [];
        let identityPes: IdentityPeLookup;
        try {
          rotationHistory = rotated
            ? await readAgentRotationHistoryRaw(db, authority.wallet_id)
            : [];
          identityPes = await readAgentAddressLineagePes(db, {
            agentId: authority.owner_id,
            walletId: authority.wallet_id,
            registrationIndex: {
              pe_id: registrationIndex.peId,
              pe_hash: registrationIndex.peHash,
            },
            rotationHistory,
          });
          const birthPe = identityPes.get(registrationIndex.peId);
          if (!birthPe
            || birthPe.hash !== registrationIndex.peHash
            || birthPe.action_type !== 'agent_wallet_created'
            || birthPe.prev_hash !== '0x0000'
            || (!rotated && birthPe.actor_address.toLowerCase() !== authority.address)
            || birthPe.timestamp !== registrationIndex.createdAtMs) {
            throw new Error('birth_binding');
          }
          canonicalPlatform = birthPe.metadata.platform;
        } catch (error) {
          rethrowWatchReadError(error);
          throw new Error(
            `watched_address_enumeration_invalid:agent_birth_authority:${authority.wallet_id}`,
          );
        }
        if (rotated) {
          try {
            const lineage = resolveAgentAddressLineage({
              walletId: authority.wallet_id,
              agentId: authority.owner_id,
              wallet,
              registrationIndex: {
                created_at_ms: registrationIndex.createdAtMs,
                pe_id: registrationIndex.peId,
                pe_hash: registrationIndex.peHash,
              },
              rotationHistory,
              identityPes,
              now: Date.now(),
            });
            if (lineage.currentAddress !== authority.address
              || lineage.currentAddressAnchorMs !== authority.created_at_ms
              || lineage.currentFence.eligibility_start_block
                !== registrationFence.eligibility_start_block) {
              throw new AgentAddressLineageError('current_binding');
            }
          } catch (error) {
            rethrowWatchReadError(error);
            const detail = error instanceof AgentAddressLineageError ? `${error.reason}:` : '';
            throw new Error(
              `watched_address_enumeration_invalid:agent_rotation_lineage:${detail}${authority.wallet_id}`,
            );
          }
        }
        if (typeof canonicalPlatform !== 'string'
          || canonicalPlatform.length === 0
          || canonicalPlatform !== wallet.platform) {
          throw new Error(
            `watched_address_enumeration_invalid:agent_platform_binding:${authority.wallet_id}`,
          );
        }
        // Test registrations are valid canonical records but intentionally do
        // not participate in production economic discovery.
        if (canonicalPlatform === 'test') continue;
      } else {
        assertHumanRegistrationIndex(
          humanIndexesByWallet.get(authority.wallet_id),
          authority,
        );
        const rawAddress = wallet.evm_address ?? wallet.address;
        if (wallet.id !== authority.wallet_id
          || wallet.type !== 'human'
          || wallet.user_id !== authority.owner_id
          || typeof rawAddress !== 'string'
          || rawAddress.toLowerCase() !== authority.address
          || wallet.created_at !== authority.created_at_ms) {
          throw new Error(
            `watched_address_enumeration_invalid:human_wallet_identity:${authority.wallet_id}`,
          );
        }
      }
      addressOwners.set(authority.address, {
        ownerType: authority.owner_type,
        ownerId: authority.owner_id,
      });
      out.push({
        walletId: authority.wallet_id,
        agentId: authority.owner_id,
        address: authority.address,
        createdAtMs: authority.created_at_ms,
        ownerType: authority.owner_type,
        eligibilityStartBlock: registrationFence.eligibility_start_block,
      });
    } catch (error) {
      rethrowWatchReadError(error);
      excludeWallet(error);
      continue;
    }
  }
  // Consistency back-checks: a registration index with no address-index
  // row was never watched, so the signal is logged (with the original
  // reason string) rather than aborting the scan.
  for (const walletId of agentIndexesByWallet.keys()) {
    if (!nativeWalletIds.has(walletId)) {
      excludeWallet(
        new Error(`watched_address_enumeration_invalid:agent_address_index_missing:${walletId}`),
      );
    }
  }
  for (const walletId of humanIndexesByWallet.keys()) {
    if (!nativeWalletIds.has(walletId)) {
      excludeWallet(
        new Error(`watched_address_enumeration_invalid:human_address_index_missing:${walletId}`),
      );
    }
  }

  // Unit 2: union proven EXTERNAL addresses into the SAME watched set (no
  // second watcher). Admission is bound by exact address. A v2 external
  // admission that happens to share the native wallet_id can never
  // authenticate or pin that native address; native authority requires the
  // registration-fenced v3 document checked above.
  const provenAddresses = new Set<string>();
  const conflictedAddresses = new Set<string>();
  for (const rec of sources.proven) {
    try {
      if (!ethers.isAddress(rec.address) || !rec.wallet_id || !rec.agent_id
        || !Number.isSafeInteger(rec.proven_at_block) || rec.proven_at_block < 0) {
        throw new Error(`watched_address_enumeration_invalid:external:${rec.agent_id}`);
      }
      const address = rec.address.toLowerCase();
      provenAddresses.add(address);
      // Smoke/integration-test agents never participate in production
      // economic discovery — live-marker parity with
      // outbound-usdc-watcher.ts (listWatchedAddresses) and the
      // consignment convention, checked on the LIVE agent_wallets doc,
      // the same authority the consignment script writes.
      const ownerWallet = (await db.collection('agent_wallets').doc(rec.wallet_id).get())
        .data() as { platform?: string } | undefined;
      if (ownerWallet?.platform === 'test') continue;
      const existing = addressOwners.get(address);
      if (existing) {
        if (existing.ownerType === 'agent' && existing.ownerId === rec.agent_id) continue;
        // Contested ownership between a native row and an external proof:
        // the address is EXCLUDED (neither claimant is watched) and the
        // scan proceeds for everyone else.
        conflictedAddresses.add(address);
        throw new Error(`watched_address_enumeration_conflict:${address}`);
      }
      addressOwners.set(address, { ownerType: 'agent', ownerId: rec.agent_id });
      out.push({
        // Per-wallet cap aggregates per AGENT (wallet_id = native wallet id
        // when the agent has one, else agent_id) across all its proven
        // addresses + native earnings.
        walletId: rec.wallet_id,
        agentId: rec.agent_id,
        address,
        createdAtMs: rec.proven_at_ms,
        isExternalProven: true,
        provenAtBlock: rec.proven_at_block,
        eligibilityStartBlock: rec.proven_at_block,
      });
    } catch (error) {
      rethrowWatchReadError(error);
      excludeWallet(error);
      continue;
    }
  }
  // 2026-10-01 — PEOPLE's proven external addresses, attributed
  // to the person (`ownerType: 'human'`, the `agentId` slot carrying the user_id). The
  // one shared enumeration (`person-proven-watched.ts`); a bad row is excluded per row.
  for (const person of await sources.personProven(excludeWallet)) {
    try {
      provenAddresses.add(person.address);
      const existing = addressOwners.get(person.address);
      if (existing) {
        if (existing.ownerType === 'human' && existing.ownerId === person.userId) continue;
        conflictedAddresses.add(person.address);
        throw new Error(`watched_address_enumeration_conflict:${person.address}`);
      }
      addressOwners.set(person.address, { ownerType: 'human', ownerId: person.userId });
      out.push({
        walletId: person.walletId,
        agentId: person.userId,
        address: person.address,
        createdAtMs: person.provenAtMs,
        ownerType: 'human',
        isExternalProven: true,
        provenAtBlock: person.provenAtBlock,
        eligibilityStartBlock: person.provenAtBlock,
      });
    } catch (error) {
      rethrowWatchReadError(error);
      excludeWallet(error);
    }
  }
  for (const admission of admissionsByAddress.values()) {
    if (admission.schema_version === 'pvt-watcher-address-admission/v3') {
      if (!nativeWalletIds.has(admission.wallet_id)) {
        excludeWallet(
          new Error(
            `watched_address_enumeration_invalid:native_address_index_missing:${admission.wallet_id}`,
          ),
        );
      }
      continue;
    }
    if (!provenAddresses.has(admission.address)) {
      // A pre-v3 compatibility admission is not native authority. Ignore it
      // rather than allowing a same-wallet external admission to pin or
      // resurrect an unrelated native address.
      console.error(`watched_address_enumeration_retired:unbound_admission:${admission.address}`);
    }
  }
  return conflictedAddresses.size === 0
    ? out
    : out.filter((wallet) => !conflictedAddresses.has(wallet.address));
}

// =============================================================================
// REAL-DEPS FACTORY (Base genesis chain)
// =============================================================================

// USDC on Base. MUST MATCH tx-verifier USDC_ADDRESSES[8453] and the mobile
// TOKEN_ADDRESSES.usdc (src/core/chains/evm/config.ts). Genesis is Base-only.
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const BASE_CHAIN_ID = 8453;

function addressToTopic(address: string): string {
  return '0x' + address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}
function topicToAddress(topic: string): string {
  return '0x' + topic.slice(-40).toLowerCase();
}

/**
 * Wire the scan deps against the live Base RPC + Firestore + PE pipeline.
 * The deposit records a standard `receive` PE on the shared mint path. `receive`
 * is not a device-rate-limited setup type, so an agent with no Secure-Enclave
 * device anchor is NOT zeroed - and it is not in GENESIS_ACTION_TYPES, so the
 * PVT9 standard lane settles it, not the Genesis lane.
 */
export function buildBaseInboundDeps(deps: AgentBankDeps): InboundUsdcScanDeps {
  // the exclusions of the most recent enumeration, classified on take.
  let lastExclusions = new WatcherEnumerationExclusionLog();
  let currentExclusions = (): WatcherEnumerationExclusionLog => lastExclusions;
  // the scan resolves one address at a time, by the same enumerator over the
  // rows that can affect it; a failed read holds instead of excluding.
  const registrySource = registryWatchSource<WatchedWallet>({
    db: deps.db,
    watcher: 'inbound_usdc',
    direction: 'inbound',
    chainId: BASE_CHAIN_ID,
    logPrefix: '[inbound-usdc]',
    addressOf: (wallet) => wallet.address,
    resolveAddress: async (address, exclude) => {
      const db = strictReads(deps.db);
      const sources = await loadInboundSourcesFor(db, address);
      return {
        wallets: await enumerateInboundWatchedWallets(db, sources, exclude),
        admission: admissionFromDocs(sources.admissionDocs, 'inbound', BASE_CHAIN_ID, address),
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
    chainId: BASE_CHAIN_ID,
    chainName: 'base',
    getBlockNumber: () => readAgreedBaseHead(),
    getLogs: async ({ fromBlock, toBlock, toAddresses }) => {
      if (toAddresses.length === 0) return [];
      const raw = await getAgreedBaseLogs({
        address: USDC_BASE,
        topics: [TRANSFER_TOPIC, null, toAddresses.map(addressToTopic)],
        fromBlock,
        toBlock,
      });
      const out: InboundTransferLog[] = [];
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
    listWatchedWallets: async () => {
      // Enumerate immutable registration authorities first, so the full
      // population is always seen (a filtered wallet query would silently drop
      // a deleted row, missing `platform`, or corrupted human `type`). Every
      // canonical native registration atomically creates all three authorities
      // below.
      //
      // PER-WALLET FAULT ISOLATION (2026-08-16 production-effect audit, item
      // 3): a single wallet whose authority records fail validation is
      // EXCLUDED from this cycle's watched set — its exact
      // `watched_address_enumeration_invalid:*` reason is logged and the scan
      // proceeds for everyone else (Unknown = Block, applied per wallet; an
      // unverifiable identity earns nothing). Before this, one bad wallet
      // aborted every cycle (~330 consecutive aborts, 08-13..08-16). The ONLY
      // whole-enumeration aborts left are collection-level read failures and
      // the cross-wallet `watched_address_enumeration_duplicate*` contests —
      // a contested address identity is not attributable to one wallet, and
      // watching either claimant would be unsafe.
      const exclusionLog = new WatcherEnumerationExclusionLog();
      lastExclusions = exclusionLog;
      currentExclusions = () => lastExclusions;
      const excludeWallet = (error: unknown): void => {
        exclusionLog.record(error);
        console.error(
          '[inbound-usdc] watched-set enumeration fault; wallet excluded this cycle:',
          error,
        );
      };
      return enumerateInboundWatchedWallets(deps.db, await loadInboundSourcesFull(deps.db), excludeWallet);
    },
    verifyFundingEvent: (wallet, event) => verifyBaseUsdcTransferEvidence({
      transactionHash: event.txHash,
      logIndex: event.logIndex,
      expectedFrom: event.fromAddress,
      expectedTo: wallet.address,
      expectedAmountAtomic: event.amountAtomic,
    }),
    readTransactionEvidence: (txHash) => verifyBaseTransactionEvidence({ transactionHash: txHash }),
    emitFundingPE: async (wallet, event, metadata, activityType = 'receive') => {
      // Permanent activity mapping: an inbound USDC deposit is a standard `receive`
      // PE on the SHARED mint path (generatePE -> recordPEAccrual -> PVT9 settlement),
      // NOT a Genesis bounty. It is priced by the weight framework, routed by the
      // record-time beneficiary snapshot (linked agent uses its configured split;
      // a human or unlinked agent keeps the full contributor allocation), subject
      // to the immutable human-side treasury floor (and any separately authorized
      // agent-side Foundation rate) plus identity/count-only anti-farming. It is
      // independent of retired PVTv8 Genesis pool/decay behavior. `receive`
      // is NOT in GENESIS_ACTION_TYPES, so it settles on the PVT9 standard lane
      // rather than the Genesis lane.
      if (metadata.verified !== true
        || typeof metadata.finality_confirmations !== 'number'
        || metadata.finality_confirmations < 12) {
        throw new Error('inbound_economic_evidence_not_verified');
      }
      //, revised: `activity_mapped` stays the ORIGINAL unconditional
      // "this deposit was evidence/finality verified" flag - it must NOT
      // depend on a live authorship read. This field is part of the HASHED
      // PE content (peMetadata -> metadata -> pe-utils.ts's buildContent),
      // and this PE's id is DETERMINISTIC (peIdOverride below, keyed off
      // chainId:txHash:logIndex) for exactly-once-emit retry safety per this
      // file's own docstring. A value derived from mutable Firestore state
      // (whether a relationship exists NOW) can legitimately differ between
      // the first attempt and a crash-recovery retry of the SAME on-chain
      // event, which would change the recomputed hash and turn
      // generatePE's idempotent replay short-circuit into a permanent
      // `deterministic_pe_id_collision` on every subsequent retry. The
      // authorship gate lives ONLY where it can be recomputed fresh on every
      // read without being baked into anything immutable: minting, via
      // pvt-accrual.ts's resolveReceiveAuthorship-driven disposition hold,
      // and the public summary, via financial-activity.ts's live
      // disposition lookup. See receive-authorship.ts for the shared check.
      const isExternal = wallet.isExternalProven === true;
      const peMetadata: Record<string, unknown> = {
        ...metadata,
        activity_mapped: true,
        ...(isExternal
          ? {
              external_proven: true,
              proven_address: wallet.address,
              attributed_agent_id: wallet.agentId,
              proven_at_block: wallet.provenAtBlock,
              source_type: wallet.ownerType === 'human' ? 'external_proven_person' : 'external_proven',
            }
          : {}),
      };
      // Prompt 2: the external artifacts this receive consumed — the counterparty
      // (sender) address and the exact on-chain event — are PUBLIC, resolvable
      // facts. The chain-verified watcher is the voucher → chain_watcher witness.
      const inboundChainWitness = chainWatcherWitness(`eip155:${BASE_CHAIN_ID}`);
      const inboundOrigins = [
        resolvableOrigin(`evm:${event.fromAddress.toLowerCase()}`, inboundChainWitness),
        resolvableOrigin(
          `chaintx:${canonicalLogIdentity(BASE_CHAIN_ID, event.txHash, event.logIndex)}`,
          inboundChainWitness,
        ),
      ];
      const emitted = await generatePE(deps, {
        walletId: wallet.walletId,
        agentId: wallet.agentId,
        actorAddress: wallet.address,
        // Written as two literals so the static emitter census (policy matrix
        // `static_emitter_files`) sees both acts this watcher seals.
        ...(activityType === 'swap' ? { actionType: 'swap' } : { actionType: 'receive' }),
        ownerType: wallet.ownerType ?? 'agent',
        walletAddress: wallet.address,
        counterpartyAddress: event.fromAddress,
        metadata: peMetadata,
        input_origins: inboundOrigins,
        // Fact-base fixes item 4 (2026-09-23): the chain-verified watcher witnesses the origins the
        // relay derived from the verified Transfer log — the counterparty (sender) and the settlement.
        relayObservation: {
          witness: relayObservationWitness(RELAY_WITNESS_CHAIN_WATCHER, `eip155:${BASE_CHAIN_ID}`),
          derivedOrigins: inboundOrigins,
        },
        // F-A6 (/, matching the outbound watcher's fix): seal the
        // LOG-GRANULAR canonical identity EXPLICITLY. The metadata carries
        // `tx_hash` + `log_index` separately with no `canonical_event_id`, so the
        // accrual's `firstEconomicEventId` fallback keyed the financial-settlement
        // mint-once on the BARE tx hash — collapsing two USDC deposits in ONE
        // transaction onto one claim and refusing the second a mint it earned. An
        // explicit id outranks that fallback (pe-utils.ts). This watcher is
        // log-granular everywhere else (seen-doc, peIdOverride below); one source
        // for the format is `canonicalLogIdentity`.
        // the proceeds of the wallet's own exchange are keyed on the
        // TRANSACTION, like every swap-labelled PE in every lane.
        observedCanonicalEventId: activityType === 'swap'
          ? event.txHash.toLowerCase()
          : canonicalLogIdentity(BASE_CHAIN_ID, event.txHash, event.logIndex),
        peIdOverride: inboundUsdcPeId(BASE_CHAIN_ID, event.txHash, event.logIndex),
        timestampOverride: event.observedAtMs,
        awaitAccrual: true,
      });
      // No Genesis bounty on the permanent path - the standing mint path prices
      // and mints this asynchronously in recordPEAccrual / the PVT9 settlement runtime.
      return { peId: emitted.peId, peHash: emitted.peHash, bountyPvt: 0 };
    },
  };
}
