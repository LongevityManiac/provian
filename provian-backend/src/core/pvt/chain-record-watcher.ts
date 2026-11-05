import { mapBounded } from '../net/map-bounded';
/**
 * THE CHAIN-RECORD LANE: chain-verified transfer
 * and swap records mint again.
 *
 * commerce ruling stands and the close-out answer
 * ("transfer/swap: no, keep them as records") is reversed:
 * - chain-verified sends from a watched wallet mint;
 * - chain-verified swaps mint;
 * - (receives are unchanged: the inbound USDC watcher mints a receive from a
 * counterparty the recipient has dealt with; a first receive from a stranger
 * records only — `receive-authorship.ts`);
 * - all at the financial base (the `send` / `swap` matrix rows, 20000 bps,
 * `base_final_chain_receipt`), under the per-actor daily ceilings.
 *
 * WHERE THE MINT COMES FROM. Only this lane's own observation of the chain. The
 * agent's `/transfer/record` and `/swap/record` calls keep sealing their record
 * PE exactly as before (`agent_token_transfer` / `agent_native_transfer` /
 * `agent_token_swap`, `record_only` the best-effort path,) and, in the
 * SAME Firestore transaction, queue the transaction hash here. That hash is a
 * POINTER, never evidence: nothing the actor submitted (recipient, amount, token,
 * `from_token`/`to_token`) is read. The scheduled cycle re-reads the whole
 * transaction through the two operator-bound legs at the watcher confirmation
 * floor and the agreed safe head (`verifyBaseTransactionEvidence`), requires the
 * wallet itself to have signed it, and derives the act from the receipt alone.
 * Nothing mints on an actor's own claim.
 *
 * WHAT IT MINTS — one act per transaction, at most:
 * - a transaction INTO a Provian institution (escrow, promise, pool, bond pool,
 * court) is that institution's act, minted by its own watcher → nothing here;
 * - `tx.to` is a known swap target (the outbound watcher's DEX routers, plus 0x
 * AllowanceHolder, the route the relay quotes agents) AND the wallet received a
 * known asset different from the one it gave (a real exchange; a native↔WETH
 * wrap is not one) → `swap`, keyed on the wallet's outbound leg: its native
 * value (bare tx hash), else its first outbound ERC-20 Transfer log
 * (`chainId:tx:logIndex`) of a known Base asset.
 * - a plain native value transfer (no calldata) → `send` to `tx.to`, keyed on
 * the bare tx hash.
 * - otherwise the wallet's first outbound Transfer log of a known Base asset
 * (PVT, USDT, DAI, WETH) → `send` to that log's recipient.
 * A leg whose token is USDC is NEVER this lane's act: USDC legs belong to the
 * outbound/inbound USDC watchers, which keep minting exactly as they do today.
 * Counterparties that are Provian's own kernel / institutions / the zero
 * address are not sends (burns, bonds, escrow, pools and promises are circular
 * PVT-cost or institution-watcher events).
 *
 * MINT-ONCE — one on-chain transaction mints once, however many lanes see it:
 * - within this lane: one observation per (tx, wallet) (the doc id), one act
 * per transaction, a deterministic PE id + block timestamp (a replay returns
 * the sealed PE), and the unchanged financial-settlement claim keyed
 * (settling address, canonical event);
 * - across lanes: before emitting, the lane reads the USDC watchers' PEs for
 * every USDC leg of the SAME transaction touching the wallet
 * (`outboundUsdcPeId` / `inboundUsdcPeId`). If any of them minted (or may
 * still mint) this lane emits nothing; if one is missing or still pending it
 * waits; only when every one of them sealed a zero-mint terminal status does
 * it emit. So a WETH→USDC swap whose USDC proceeds already minted as a
 * `receive` mints nothing more, and one whose proceeds recorded only (an
 * unsolicited receive) mints as the `swap`.
 *
 * FENCES — none is re-implemented here. The emitted `send` / `swap` goes through
 * `recordPEAccrual` exactly like the outbound watcher's emit (`awaitAccrual`),
 * with `counterpartyAddress` set, so same-owner / shared-beneficial-owner
 * (`detectSameOwnerTransfer`), novelty decay, the financial-settlement
 * mint-once claim, the daily ceilings (`send` 25 with the verified-
 * counterparty identity requirement, `swap` 25) and, at settlement, the epoch
 * ceilings all apply unchanged.
 *
 * FROM THE LANDING FORWARD. Only transactions mined at or after
 * `CHAIN_RECORD_MINT_CUT_LINE_MS` and at or after the wallet's own registration
 * fence mint; every record sealed before this lane existed has no observation
 * and is never repriced.
 *
 * SCOPE. Base only (the matrix rows' evidence is `base_final_chain_receipt`); a
 * record on Arbitrum / Optimism stays a record. Native Provian wallets only.
 *
 * SAME TERMS FOR HUMANS, NON-USDC RECEIVES, ONE SWAP
 * LABEL. The lane now serves every native wallet, human and agent, on one rule:
 * - a HUMAN's send or swap: the app's Send / Swap / WalletConnect record carries
 * the transaction hash, and `POST /v1/pe/submit/mobile` queues it here in the
 * record's own chain-tip transaction (`owner_type: 'human'`). The act is
 * derived from the chain exactly as an agent's, attributed to the human
 * (`ownerType: 'human'`, the immutable 99/0.5/0.5 split).
 * - a RECEIVE of a known non-USDC asset (PVT, USDT, DAI, WETH), human or agent:
 * `chain-record-inbound-scan.ts` finds the Transfer and queues the
 * transaction; a transaction the wallet did NOT sign derives a `receive` from
 * its first qualifying inbound leg. The unchanged receive-authorship gate
 * (`pvt-accrual.ts`) mints it only from a counterparty the recipient has dealt
 * with; a first receive from a stranger records only, as USDC does today.
 * A transaction the wallet signed derives its own send/swap, never a receive.
 * - a SWAP is the one rule in `wallet-exchange.ts`, read by this lane and both
 * USDC watchers; from the landing every swap is keyed on its
 * transaction, so every swap-labelled PE of one transaction collapses onto one
 * mint-once claim whichever lane sealed it.
 * The cut line still governs an agent's send/swap; a human's act and every
 * receive mint only from `VERIFIED_COMMERCE_CUT_LINE_MS`.
 *
 * PROVEN ADDRESSES
 * GET THE SAME COMMERCE TERMS. A proven external address, a person's
 * (`human_proven_addresses`) or an agent's (`proven_addresses`), mints on the
 * terms above: sends, swaps, and receives from a counterparty it has dealt with,
 * in every known token on Base. Its observations are keyed `proven:<address>`;
 * the lane resolves the owner from the proven registry (fence = the proof's
 * exact H+1 `proven_at_block`) and emits as that owner (`ownerType` 'human' for a
 * person). Discovery: `chain-record-inbound-scan.ts` (inbound Transfers) and
 * `chain-record-proven-outbound-scan.ts` (every transaction the proven EOA signed,
 * found from its nonce). The invariants hold unchanged; a proven address's
 * act mints only from `PROVEN_ADDRESS_COMMERCE_CUT_LINE_MS`.
 *
 * 2026-10-01 (the same ruling, which carves out no asset) — ETH RECEIVES MINT. A
 * plain native ETH transfer into a watched address (native wallet or proven
 * address, person or agent) that the address did not sign derives a `receive`
 * from the transaction itself: the address is the recipient (`tx.to`), the value
 * is non-zero, there is no calldata, and the sender is not an excluded
 * counterparty. `chain-record-inbound-scan.ts` finds it from full blocks on both
 * legs. It is keyed on the bare transaction hash in the `receive` namespace, so
 * the sender's own `send` of the same transaction (keyed on the same hash, in the
 * send namespace) is a separate act of a separate actor. Every gate is unchanged:
 * receive authorship (a first receive from a stranger records only), same-owner /
 * shared-owner, novelty, the financial-settlement mint-once claim and
 * the `receive` ceiling. It mints only from `ETH_RECEIVE_COMMERCE_CUT_LINE_MS`.
 *
 * 2026-10-01 — ETH THAT ARRIVES INSIDE A TRANSACTION MINTS on the same
 * terms: ETH a smart wallet (Coinbase's, for one) or any contract sends the
 * address inside some other transaction, a selfdestruct refund, or a top-level
 * call that carries calldata. When a transaction the address did not sign is
 * not a receive by its receipt or its plain value, the lane reads the
 * transaction's ETH movements agreed by BOTH independent trace legs
 * (`readAgreedBaseInternalEth`), checks they name the verified block, and takes
 * the first movement into the address in execution order; the counterparty is
 * the address that sent the ETH (never an excluded counterparty or the address
 * itself). Same key, same gates, same ceiling as a plain ETH receive; it mints
 * only from `INTERNAL_ETH_RECEIVE_CUT_LINE_MS`. A transaction the address signed
 * is its own act: a swap that pays out ETH is the swap, once.
 */

import { readActRow } from '../meter/act-row-store';
import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import type * as admin from 'firebase-admin';
import type { AgentBankDeps } from '../agent-bank/types';
import { generatePE } from '../agent-bank/pe-utils';
import { resolvableOrigin, chainWatcherWitness } from '../provenance/origin-capture';
import { relayObservationWitness, RELAY_WITNESS_CHAIN_WATCHER } from './relay-observation-witness';
import {
  BASE_USDC_ADDRESS,
  BASE_WATCHER_CONFIRMATION_FLOOR,
  readAgreedBaseBlockTimestampMs,
  readAgreedBaseInternalEth,
  verifyBaseTransactionEvidence,
  verifyEvmTransactionEvidence,
  type BaseInternalEthEvidence,
  type BaseTransactionEvidence,
  type CanonicalEconomicLog,
  type ChainTransactionEvidence,
} from '../onchain/economic-discovery';
import {
  MULTICHAIN_COMMERCE_CUT_LINE_MS,
  OTHER_CHAIN_RECORD_PROFILES,
  baseChainRecordProfile,
  type ChainRecordChainProfile,
} from './chain-record-chains';
import { outboundUsdcPeId } from './outbound-usdc-watcher';
import {
  BASE_NON_USDC_ASSETS,
  BASE_SWAP_TARGETS,
  VERIFIED_COMMERCE_CUT_LINE_MS,
  LIVE_PVT9_TOKEN,
  addressTopic,
  classifyWalletExchange,
  isWalletBridgeSwap,
  movesValue,
  wellFormedTransfers,
} from './wallet-exchange';
import { inboundUsdcPeId } from './inbound-usdc-watcher';
import { canonicalLogIdentity, INSTITUTION_ADDRESSES, PREDECESSOR_ESCROW_V4_ADDRESS } from './institution-funding-watcher';
import { STANDING_INSTITUTION_ADDRESSES } from './institution-standing-watcher';
import { PREDECESSOR_PVT9_KERNEL_BASE } from '../agent-bank/pvt-principal-config';
import {
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  nativeWalletAddressIndexId,
  parseCanonicalNativeAddressIndex,
  parseNativeWalletRegistrationFence,
} from './native-wallet-registration';
import {
  HUMAN_PROVEN_ADDRESSES_COLLECTION,
  PROVEN_ADDRESSES_COLLECTION,
  isEconomicallyActiveProvenAddress,
} from '../external-address/link';
import { isEconomicallyActiveHumanProvenAddress } from '../external-address/human-link';
import { isActiveHumanWallet } from '../wallet/active-human-wallet';

// =============================================================================
// CONSTANTS
// =============================================================================

export const CHAIN_RECORD_OBSERVATIONS_COLLECTION = 'chain_record_observations';
export const CHAIN_RECORD_OBSERVATION_SCHEMA = 'chain-record-observation/v1';
const BASE_CHAIN_ID = 8453;

/**
 * The landing of. A transaction mined before this instant never mints
 * through this lane — minting applies from the landing forward, and no sealed
 * record is repriced.
 */
export const CHAIN_RECORD_MINT_CUT_LINE_MS = Date.UTC(2026, 8, 30, 23, 0, 0);

/**
 * 2026-10-01: the landing of proven-address commerce in this lane. A proven
 * address's send / swap / receive mined before this instant never mints here
 * (its USDC legs keep minting through the USDC watchers as before).
 */
export const PROVEN_ADDRESS_COMMERCE_CUT_LINE_MS = Date.UTC(2026, 9, 1, 18, 0, 0);

/**
 * 2026-10-01: the landing of native ETH receives. An ETH receive mined before this
 * instant never mints here (a token receive keeps its own cut lines).
 */
export const ETH_RECEIVE_COMMERCE_CUT_LINE_MS = Date.UTC(2026, 9, 1, 16, 0, 0);
/** 2026-10-01 : ETH that arrives INSIDE a transaction — an internal
 * transfer from a smart wallet or any contract, or a top-level call that carries
 * calldata — mints from this instant forward. */
export const INTERNAL_ETH_RECEIVE_CUT_LINE_MS = Date.UTC(2026, 9, 1, 20, 0, 0);

/** Observation wallet key of a proven external address (agent's or person's). */
export const PROVEN_OBSERVATION_PREFIX = 'proven:';
export function provenObservationWalletId(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('chain_record_proven_address_invalid');
  return `${PROVEN_OBSERVATION_PREFIX}${address.toLowerCase()}`;
}

/** Operational horizon: an observation that never becomes final (a dropped
 * transaction, a USDC witness that never appears) is closed without a mint. */
export const CHAIN_RECORD_OBSERVATION_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
const LEASE_MS = 5 * 60 * 1000;
/** A finished observation's `next_attempt_at_ms`: never ≤ now, so the ready query
 * (`next_attempt_at_ms <= now`) can never be crowded by finished documents. */
const TERMINAL_NEXT_ATTEMPT_MS = Number.MAX_SAFE_INTEGER;
const RETRY_MS = 2 * 60 * 1000;
/** retries back off (2, 4, 8, … minutes, capped) so an observation that
 * cannot become final yet never polls at the base rate for a week. */
const MAX_RETRY_MS = 30 * 60 * 1000;
/** an app record's hash is an untrusted pointer. A transaction neither
 * operator leg can find an hour after it was queued is refused (a real send the
 * app recorded after its receipt is found at once). */
export const CHAIN_RECORD_NOT_FOUND_HORIZON_MS = 60 * 60 * 1000;

export { ZEROX_ALLOWANCE_HOLDER_BASE } from './wallet-exchange';

/** Swap targets — ONE source (`wallet-exchange.ts`): the Uniswap routers on Base
 * plus 0x AllowanceHolder, read by this lane and both USDC watchers. */
export const CHAIN_RECORD_SWAP_TARGETS: ReadonlySet<string> = BASE_SWAP_TARGETS;

/**
 * The known Base assets whose Transfer can be this lane's act — ONE source
 * (`wallet-exchange.ts`). USDC is absent on purpose: it is the USDC watchers'
 * lane. An unknown token never mints (Unknown = Block).
 */
export const CHAIN_RECORD_ASSETS: Readonly<Record<string, string>> = BASE_NON_USDC_ASSETS;

/** The keyless migration distributor (`contracts/deployments/base-pvt9-institutions.json`
 * `migrationDistributor`): its payouts carried predecessor balances 1:1 — a
 * migration, not a counterparty's act. */
export const PVT9_MIGRATION_DISTRIBUTOR_BASE = '0xf674f1a915862430c9d0da994f1b9ea5dd0c71ed';

/**
 * Counterparties a transfer with which is not a send or a receive: the zero
 * address (a burn, or a mint — every PVT settlement and Genesis grant arrives
 * from it), the live and predecessor PVT9 kernels, the migration
 * distributor, and every Provian institution (escrow, promise, pool, bond pool,
 * court). Those flows are circular PVT-cost events, settlement itself, or belong
 * to the institution watchers.
 */
export const CHAIN_RECORD_EXCLUDED_COUNTERPARTIES: ReadonlySet<string> = new Set<string>([
  `0x${'0'.repeat(40)}`,
  PVT9_MIGRATION_DISTRIBUTOR_BASE,
  ...(LIVE_PVT9_TOKEN ? [LIVE_PVT9_TOKEN] : []),
  PREDECESSOR_PVT9_KERNEL_BASE.toLowerCase(),
  ...Object.values(INSTITUTION_ADDRESSES),
  PREDECESSOR_ESCROW_V4_ADDRESS,
  ...Object.values(STANDING_INSTITUTION_ADDRESSES),
]);

/**
 * Provian institutions as a TRANSACTION TARGET ( , defect 1).
 * A call into an institution is that institution's act — escrow / promise / pool
 * funding, bonds, court — and its own watcher mints it; a PVT promise funding,
 * for instance, moves PVT from the lender straight to the borrower, which would
 * otherwise read as a plain `send` and mint twice for one transaction. The
 * lane derives nothing from such a transaction.
 */
export const CHAIN_RECORD_INSTITUTION_TARGETS: ReadonlySet<string> = new Set<string>([
  ...Object.values(INSTITUTION_ADDRESSES),
  PREDECESSOR_ESCROW_V4_ADDRESS,
  ...Object.values(STANDING_INSTITUTION_ADDRESSES),
]);

/** Base, as the chain profile the derivation reads (`chain-record-chains.ts`). */
export const BASE_CHAIN_RECORD_PROFILE: ChainRecordChainProfile = baseChainRecordProfile(
  CHAIN_RECORD_EXCLUDED_COUNTERPARTIES,
  CHAIN_RECORD_INSTITUTION_TARGETS,
);

/** The chain ids an observation may name: Base, Arbitrum One, OP Mainnet. */
export function chainRecordProfileFor(chainId: number): ChainRecordChainProfile {
  if (chainId === BASE_CHAIN_ID) return BASE_CHAIN_RECORD_PROFILE;
  const profile = OTHER_CHAIN_RECORD_PROFILES[chainId];
  if (!profile) throw new Error(`chain_record_chain_unsupported:${chainId}`);
  return profile;
}

/** True for every chain id the lane reads. */
export function isChainRecordChainId(chainId: unknown): chainId is number {
  return chainId === BASE_CHAIN_ID
    || (typeof chainId === 'number' && OTHER_CHAIN_RECORD_PROFILES[chainId] !== undefined);
}

// =============================================================================
// TYPES
// =============================================================================

/**
 * Where an observation's POINTER came from — never evidence:
 * - `transfer_record` / `swap_record` an agent's `/transfer/record` / `/swap/record`;
 * - `app_send_record` / `app_swap_record` the app's send / swap record on the mobile lane;
 * - `inbound_scan` an inbound Transfer of a known non-USDC asset.
 */
export type ChainRecordSource =
  | 'transfer_record' | 'swap_record'
  | 'app_send_record' | 'app_swap_record'
  | 'inbound_scan'
  /** 2026-10-01: a transaction a proven external EOA signed, found from its nonce. */
  | 'proven_outbound_scan'
  /** A transfer into or out of a watched address on Arbitrum One or OP Mainnet. */
  | 'multichain_scan';
const CHAIN_RECORD_SOURCES: ReadonlySet<string> = new Set<ChainRecordSource>([
  'transfer_record', 'swap_record', 'app_send_record', 'app_swap_record', 'inbound_scan',
  'proven_outbound_scan', 'multichain_scan',
]);

export type ChainRecordOwnerType = 'agent' | 'human';

export interface ChainRecordWallet {
  readonly walletId: string;
  /** The accrual identity: the agent's `agent_id`, or the human's `user_id`
   * (the chain-tip / accrual key `generatePE` uses for human PEs, as the
   * outbound watcher's human enumeration). */
  readonly agentId: string;
  readonly address: string; // lowercased native or proven address
  readonly eligibilityStartBlock: number;
  readonly ownerType: ChainRecordOwnerType;
  /** 2026-10-01: a proven external address (absent = the native wallet itself). */
  readonly addressKind?: 'native' | 'proven';
  /** How a proven address was proven. A contract (EIP-1271) proof shows control on
   * Base only: the same address on another chain can be someone else's contract. */
  readonly proofMethod?: 'eip191_eoa' | 'eip1271_contract';
}

export interface ChainRecordAct {
  readonly actionType: 'send' | 'swap' | 'receive';
  readonly counterpartyAddress: string;
  /** `chainId:txHash:logIndex` for a token leg; the bare tx hash for a native leg. */
  readonly canonicalEventId: string;
  readonly leg: 'native' | 'erc20';
  readonly assetSymbol: string;
  /** Token contract for an ERC-20 leg; null for native ETH. */
  readonly assetAddress: string | null;
  readonly amountAtomic: string;
  readonly logIndex: number | null;
  /**
   * : the key of this act's deterministic PE id when it is
   * not the canonical event itself. ETH that arrives inside a transaction keeps
   * the bare transaction hash as its canonical event (the chain witness class and
   * the financial-settlement claim, keyed on (recipient address, tx), read it),
   * and its PE id is keyed on the transaction AND the recipient, so one
   * transaction paying several Provian recipients never collides.
   */
  readonly peIdKey?: string;
  /** 2026-10-01: a native receive found in the agreed trace (an internal transfer,
   * or a top-level call carrying calldata) rather than the plain transaction. */
  readonly internal?: {
    readonly traceAddress: readonly number[];
    readonly evidenceHash: string;
    readonly providerOperatorIds: readonly [string, string];
  };
}

export type ChainRecordDerivation =
  | { readonly status: 'act'; readonly act: ChainRecordAct; readonly usdcWitnessPeIds: readonly string[] }
  | { readonly status: 'no_act'; readonly reason: string; readonly usdcWitnessPeIds: readonly string[] };

export interface ChainRecordWatcherDeps {
  readonly db: Firestore;
  /** `chainId` absent = Base. */
  readonly verifyTransaction: (txHash: string, chainId?: number) => Promise<ChainTransactionEvidence>;
  /** The timestamp of a Base block, agreed by both legs: the registration fence
   * of a wallet, read as a time for a transaction on another chain. */
  readonly readBaseBlockTimestampMs?: (blockNumber: number) => Promise<number>;
  /** 2026-10-01: the transaction's ETH movements, agreed by both trace legs.
   * Read only when nothing else in a transaction the wallet did not sign is a
   * receive. Absent = internal transfers are not read. */
  readonly readInternalEth?: (txHash: string) => Promise<BaseInternalEthEvidence>;
  /** Defaults to `resolveChainRecordWallet` (tests may inject). */
  readonly resolveWallet?: (walletId: string, ownerType: ChainRecordOwnerType) => Promise<ChainRecordWallet | null>;
  readonly emitActPE: (
    wallet: ChainRecordWallet,
    act: ChainRecordAct,
    evidence: ChainTransactionEvidence,
    observation: { readonly recordPeId: string | null; readonly source: ChainRecordSource },
  ) => Promise<{ readonly peId: string }>;
  readonly now?: () => number;
}

export interface ChainRecordCycleReport {
  leased: number;
  emitted: number;
  by_type: { send: number; swap: number; receive: number };
  no_act: number;
  refused: number;
  waiting: number;
  errors: number;
  outcomes: Array<{ id: string; outcome: string }>;
}

// =============================================================================
// PURE HELPERS
// =============================================================================

export function chainRecordObservationId(txHash: string, walletId: string, chainId: number = BASE_CHAIN_ID): string {
  return `obs_${crypto.createHash('sha256')
    .update(`${chainId}:${txHash.toLowerCase()}:${walletId}`)
    .digest('hex')}`;
}

/**
 * The deterministic id of the act PE this lane seals for one canonical event.
 * A `receive` lives in its own namespace ( , defect 1): one
 * Transfer log is the sender's `send` AND the recipient's `receive` when both
 * are watched wallets, so keying both on the log alone would collide and leave
 * one legitimate act unsealed — the direction split the USDC watchers already
 * make (`outboundUsdcPeId` / `inboundUsdcPeId`). The sender's acts keep the
 * id unchanged (only the signer derives a send or swap, so one per tx).
 */
export function chainRecordPeId(
  canonicalEventId: string,
  actionType: ChainRecordAct['actionType'] = 'send',
  chainId: number = BASE_CHAIN_ID,
): string {
  const namespace = actionType === 'receive' ? 'receive:' : '';
  return `pe_chainrec_${crypto.createHash('sha256')
    .update(`${namespace}${chainId}:${canonicalEventId.toLowerCase()}`)
    .digest('hex')}`;
}

function topicAddress(topic: string): string {
  return `0x${topic.slice(-40).toLowerCase()}`;
}

/**
 * Derive this lane's act for `wallet` from the verified transaction alone.
 * Pure. Also returns the deterministic ids of every USDC-watcher PE the same
 * transaction produces for this wallet — the cross-lane mint-once gate reads
 * them before any emit.
 *
 * A transaction the wallet SIGNED derives its own act (swap, native send, token
 * send); one it did NOT sign derives a `receive`. A wallet's own
 * transaction never derives a receive: what it received there is part of its own
 * act.
 */
export function deriveChainRecordAct(
  evidence: ChainTransactionEvidence,
  walletAddress: string,
  internal: BaseInternalEthEvidence | null = null,
): ChainRecordDerivation {
  const profile = chainRecordProfileFor(evidence.chainId);
  const chainId = profile.chainId;
  const assets = profile.assets;
  const excluded = profile.excludedCounterparties;
  const wallet = walletAddress.toLowerCase();
  const walletTopic = addressTopic(wallet);
  const transfers = wellFormedTransfers(evidence);

  // Another lane's token on this chain (Base USDC: the USDC watchers). None elsewhere.
  const otherLaneToken = profile.otherLaneToken;
  const usdcWitnessPeIds: string[] = [];
  for (const log of transfers) {
    if (otherLaneToken === null || log.address !== otherLaneToken) continue;
    if (log.topics[1] === walletTopic) {
      usdcWitnessPeIds.push(outboundUsdcPeId(BASE_CHAIN_ID, evidence.transactionHash, log.logIndex));
    }
    if (log.topics[2] === walletTopic) {
      usdcWitnessPeIds.push(inboundUsdcPeId(BASE_CHAIN_ID, evidence.transactionHash, log.logIndex));
    }
  }
  const noAct = (reason: string): ChainRecordDerivation => ({ status: 'no_act', reason, usdcWitnessPeIds });
  const to = evidence.toAddress;
  // A call into a Provian institution is that institution's act, whoever signed
  // it — its own watcher mints it ( , defect 1).
  if (to !== null && profile.institutionTargets.has(to)) return noAct('institution_transaction');

  const tokenLeg = (log: CanonicalEconomicLog, counterpartyTopic: string): Omit<ChainRecordAct, 'actionType'> => ({
    counterpartyAddress: topicAddress(counterpartyTopic),
    canonicalEventId: canonicalLogIdentity(chainId, evidence.transactionHash, log.logIndex),
    leg: 'erc20',
    assetSymbol: assets[log.address],
    assetAddress: log.address,
    amountAtomic: BigInt(log.data).toString(),
    logIndex: log.logIndex,
  });

  if (evidence.fromAddress !== wallet) {
    // RECEIVE: the wallet's first inbound leg of a known non-USDC asset
    // that moves a non-zero amount from someone else, and not from the zero
    // address (a mint), a PVT9 kernel, the migration distributor or an
    // institution. USDC deposits stay the inbound USDC watcher's.
    const leg = transfers.find((log) => log.topics[2] === walletTopic
      && movesValue(log)
      && log.address in assets
      && !excluded.has(topicAddress(log.topics[1])));
    if (leg) return { status: 'act', usdcWitnessPeIds, act: { actionType: 'receive', ...tokenLeg(leg, leg.topics[1]) } };
    // 2026-10-01 — a plain native ETH transfer into the wallet: it is the
    // transaction's recipient, the value is non-zero and there is no calldata.
    const nativeValue = BigInt(evidence.valueWei);
    if (to === wallet && nativeValue > 0n && evidence.inputEmpty
      && !excluded.has(evidence.fromAddress)) {
      return {
        status: 'act',
        usdcWitnessPeIds,
        act: {
          actionType: 'receive',
          counterpartyAddress: evidence.fromAddress,
          canonicalEventId: evidence.transactionHash,
          leg: 'native',
          assetSymbol: 'ETH',
          assetAddress: null,
          amountAtomic: nativeValue.toString(),
          logIndex: null,
        },
      };
    }
    // 2026-10-01 — ETH that arrives INSIDE the transaction: a smart
    // wallet's or any contract's call that sends the wallet ETH, a selfdestruct
    // refund, or a top-level call that carries calldata. The counterparty is the
    // address that sent the ETH; the first such movement in execution order is
    // the act (as the first token leg is), from an address that is not the
    // wallet and not an excluded counterparty.
    if (internal !== null) {
      if (internal.transactionHash !== evidence.transactionHash
        || internal.blockHash !== evidence.blockHash
        || internal.blockNumber !== evidence.blockNumber) {
        throw new Error('internal_eth_evidence_mismatch');
      }
      const frame = internal.frames.find((f) => f.toAddress === wallet
        && f.fromAddress !== wallet
        && !excluded.has(f.fromAddress));
      if (frame) {
        return {
          status: 'act',
          usdcWitnessPeIds,
          act: {
            actionType: 'receive',
            counterpartyAddress: frame.fromAddress,
            // The canonical event is the transaction: the financial-settlement
            // claim is keyed on (recipient address, tx), so each address mints
            // once per transaction across every lane. One transaction can pay
            // several recipients (a batch, a split), so the PE id is keyed on
            // the transaction AND the recipient, and no two collide.
            canonicalEventId: evidence.transactionHash,
            peIdKey: `${evidence.transactionHash}:eth:${wallet}`,
            leg: 'native',
            assetSymbol: 'ETH',
            assetAddress: null,
            amountAtomic: frame.valueWei,
            logIndex: null,
            internal: {
              traceAddress: frame.traceAddress,
              evidenceHash: internal.evidenceHash,
              providerOperatorIds: internal.providerOperatorIds,
            },
          },
        };
      }
    }
    return noAct('no_qualifying_receive');
  }

  if (to === null) return noAct('contract_creation');
  const outbound = transfers.filter((log) => log.topics[1] === walletTopic && movesValue(log));
  const value = BigInt(evidence.valueWei);

  // A cross-chain swap (the app's LI.FI route, on every chain the wallet uses):
  // the Diamond emitted LiFiTransferStarted in the wallet's own transaction, so
  // the wallet's outbound leg into it is the swap; its proceeds land on the other
  // chain in a transaction the wallet did not sign. Any other Diamond call is a
  // swap only if it is a real exchange by the ordinary rule below.
  const viaDiamond = profile.bridgeTargets.has(to) && evidence.blockTimestampMs >= MULTICHAIN_COMMERCE_CUT_LINE_MS;
  if (viaDiamond && isWalletBridgeSwap(evidence, wallet)) {
    if (value > 0n) {
      return {
        status: 'act',
        usdcWitnessPeIds,
        act: {
          actionType: 'swap',
          counterpartyAddress: to,
          canonicalEventId: evidence.transactionHash,
          leg: 'native',
          assetSymbol: 'ETH',
          assetAddress: null,
          amountAtomic: value.toString(),
          logIndex: null,
        },
      };
    }
    const carrier = outbound.find((log) => profile.isKnownAsset(log.address));
    if (!carrier) return noAct('bridge_without_known_leg');
    if (otherLaneToken !== null && carrier.address === otherLaneToken) return noAct('usdc_leg_is_usdc_watcher_lane');
    return {
      status: 'act',
      usdcWitnessPeIds,
      act: {
        actionType: 'swap',
        ...tokenLeg(carrier, carrier.topics[2]),
        canonicalEventId: evidence.transactionHash,
      },
    };
  }

  if (profile.swapTargets.has(to) || viaDiamond) {
    // ONE rule for every lane (`wallet-exchange.ts`): a real exchange, carried by
    // the native value, else the first outbound leg (review rounds 1–2).
    const exchange = classifyWalletExchange(evidence, wallet, viaDiamond
      ? { ...profile, swapTargets: new Set([...profile.swapTargets, ...profile.bridgeTargets]) }
      : profile);
    if (!exchange.exchange) return noAct(exchange.reason);
    // from the landing forward a swap is keyed on its TRANSACTION in every
    // lane, so every swap-labelled PE of one transaction collapses onto one
    // mint-once claim. Before it, a token-carried swap keeps 's log key.
    const keyOnTransaction = evidence.blockTimestampMs >= VERIFIED_COMMERCE_CUT_LINE_MS;
    if (exchange.carrier.kind === 'native') {
      return {
        status: 'act',
        usdcWitnessPeIds,
        act: {
          actionType: 'swap',
          counterpartyAddress: to,
          canonicalEventId: evidence.transactionHash,
          leg: 'native',
          assetSymbol: 'ETH',
          assetAddress: null,
          amountAtomic: exchange.carrier.amountWei.toString(),
          logIndex: null,
        },
      };
    }
    const carrier = exchange.carrier.log;
    if (otherLaneToken !== null && carrier.address === otherLaneToken) return noAct('usdc_leg_is_usdc_watcher_lane');
    const leg = tokenLeg(carrier, carrier.topics[2]);
    return {
      status: 'act',
      usdcWitnessPeIds,
      act: {
        actionType: 'swap',
        ...leg,
        canonicalEventId: keyOnTransaction ? evidence.transactionHash : leg.canonicalEventId,
      },
    };
  }

  if (value > 0n && evidence.inputEmpty) {
    if (excluded.has(to)) return noAct('excluded_counterparty');
    return {
      status: 'act',
      usdcWitnessPeIds,
      act: {
        actionType: 'send',
        counterpartyAddress: to,
        canonicalEventId: evidence.transactionHash,
        leg: 'native',
        assetSymbol: 'ETH',
        assetAddress: null,
        amountAtomic: value.toString(),
        logIndex: null,
      },
    };
  }

  const sendLeg = outbound.find((log) => log.address !== otherLaneToken
    && log.address in assets
    && !excluded.has(topicAddress(log.topics[2])));
  if (!sendLeg) return noAct('no_qualifying_leg');
  return { status: 'act', usdcWitnessPeIds, act: { actionType: 'send', ...tokenLeg(sendLeg, sendLeg.topics[2]) } };
}

/** USDC-watcher statuses under which that PE minted, or will. */
const USDC_WITNESS_MINTING = new Set([
  'eligible', 'minting', 'minted', 'beneficiary_pending', 'deferred',
  'genesis_epoch_deferred', 'epoch_headroom_deferred', 'settlement_retry_deferred',
  // The same (address, event) already minted through ANOTHER PE — the
  // transaction has minted for this actor ( , latent note).
  'corroborated_duplicate',
]);
/** USDC-watcher statuses that are terminal and minted nothing. */
const USDC_WITNESS_ZERO_TERMINAL = new Set([
  'record_only', 'ineligible', 'skipped_no_output',
  'farm_capped', 'x402_unverified',
]);

export type UsdcWitnessVerdict = 'clear' | 'minted' | 'wait';

/**
 * Cross-lane mint-once. `clear` only when every USDC-watcher PE for this
 * transaction's USDC legs exists and sealed a zero-mint terminal status; any
 * minting status → `minted`; a missing, pending or unrecognized one → `wait`
 * (Unknown = Block).
 */
export async function readUsdcWitnessVerdict(
  db: Firestore,
  peIds: readonly string[],
): Promise<UsdcWitnessVerdict> {
  let wait = false;
  for (const peId of peIds) {
    // PE METER: the watcher PE's priced row is in its act key (or a pre-meter pe_history row).
    const status = (await readActRow(db, peId))?.row.mint_status;
    if (typeof status === 'string' && USDC_WITNESS_MINTING.has(status)) return 'minted';
    if (typeof status !== 'string' || !USDC_WITNESS_ZERO_TERMINAL.has(status)) wait = true;
  }
  return wait ? 'wait' : 'clear';
}

// =============================================================================
// ENQUEUE (called by /transfer/record and /swap/record)
// =============================================================================

/**
 * The two halves of the route's enqueue, for its PE transaction: a read (in the
 * `atomicEntityPrecondition`, before any write) and a write (in the
 * `atomicEntityWrite`). The observation is created only when absent, so a
 * second record of the same transaction never resets one already processed.
 */
export interface ChainRecordEnqueueInput {
  readonly txHash: string;
  readonly walletId: string;
  readonly source: ChainRecordSource;
  /** Absent = an agent wallet (every observation). */
  readonly ownerType?: ChainRecordOwnerType;
  /** Absent = Base. Arbitrum One (42161) and OP Mainnet (10) are read too. */
  readonly chainId?: number;
}

function observationDocument(input: ChainRecordEnqueueInput, recordPeId: string | null, now: number): Record<string, unknown> {
  const chainId = input.chainId ?? BASE_CHAIN_ID;
  if (!isChainRecordChainId(chainId)) throw new Error(`chain_record_chain_unsupported:${chainId}`);
  return {
    schema_version: CHAIN_RECORD_OBSERVATION_SCHEMA,
    chain_id: chainId,
    tx_hash: input.txHash.toLowerCase(),
    wallet_id: input.walletId,
    source: input.source,
    ...(input.ownerType === 'human' ? { owner_type: 'human' } : {}),
    record_pe_id: recordPeId,
    requested_at_ms: now,
    status: 'pending',
    attempts: 0,
    next_attempt_at_ms: now,
    lease_until_ms: 0,
    last_reason: null,
    outcome: null,
  };
}

export function chainRecordEnqueue(
  db: Firestore,
  input: ChainRecordEnqueueInput,
): {
  readonly read: (txn: admin.firestore.Transaction) => Promise<void>;
  readonly write: (txn: admin.firestore.Transaction, recordPeId: string) => void;
} {
  // Resolved lazily, inside the transaction: nothing is touched unless the PE
  // transaction actually runs.
  const ref = () => db.collection(CHAIN_RECORD_OBSERVATIONS_COLLECTION)
    .doc(chainRecordObservationId(input.txHash, input.walletId, input.chainId ?? BASE_CHAIN_ID));
  // null = not read in this attempt → write nothing (never a blind overwrite).
  let exists: boolean | null = null;
  return {
    read: async (txn) => {
      exists = (await txn.get(ref())).exists;
    },
    write: (txn, recordPeId) => {
      if (exists !== false) return;
      txn.set(ref(), observationDocument(input, recordPeId, Date.now()));
    },
  };
}

/**
 * queue an observation outside a PE transaction (the inbound scan). Created
 * only when absent — the doc id is (tx, wallet), so a transaction already queued
 * by a record, or by an earlier scan, is never reset. Returns whether it created.
 */
export async function enqueueChainRecordObservation(
  db: Firestore,
  input: ChainRecordEnqueueInput,
  now: number = Date.now(),
): Promise<boolean> {
  const ref = db.collection(CHAIN_RECORD_OBSERVATIONS_COLLECTION)
    .doc(chainRecordObservationId(input.txHash, input.walletId, input.chainId ?? BASE_CHAIN_ID));
  try {
    await ref.create(observationDocument(input, null, now));
    return true;
  } catch (error) {
    // gRPC ALREADY_EXISTS (6): the observation is already queued.
    if ((error as { code?: unknown }).code === 6) return false;
    throw error;
  }
}

// =============================================================================
// WALLET RESOLUTION
// =============================================================================

/**
 * The watched native agent wallet an observation belongs to — the same authority
 * the outbound watcher's native enumeration reads (canonical address index +
 * registration fence), so this lane and the watchers agree on who is watched. A
 * test wallet resolves null (never earns); an integrity fault throws.
 */
export async function resolveChainRecordWallet(
  db: Firestore,
  walletId: string,
  ownerType: ChainRecordOwnerType = 'agent',
): Promise<ChainRecordWallet | null> {
  if (walletId.startsWith(PROVEN_OBSERVATION_PREFIX)) {
    return resolveChainRecordProvenAddress(db, walletId.slice(PROVEN_OBSERVATION_PREFIX.length), ownerType);
  }
  if (ownerType === 'human') return resolveChainRecordHumanWallet(db, walletId);
  const walletSnap = await db.collection('agent_wallets').doc(walletId).get();
  if (!walletSnap.exists) throw new Error('chain_record_wallet_missing');
  const wallet = walletSnap.data() as {
    id?: string; agent_id?: string; address?: string; platform?: string;
    native_watcher_registration?: unknown;
  };
  if (wallet.platform === 'test') return null;
  if (wallet.id !== walletId || typeof wallet.agent_id !== 'string' || typeof wallet.address !== 'string'
    || !/^0x[0-9a-fA-F]{40}$/.test(wallet.address)) {
    throw new Error('chain_record_wallet_identity_invalid');
  }
  const indexId = nativeWalletAddressIndexId(wallet.address);
  const indexSnap = await db.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION).doc(indexId).get();
  const authority = parseCanonicalNativeAddressIndex(
    indexSnap.exists ? indexSnap.data() as Record<string, unknown> : undefined,
    indexId,
  );
  if (authority.owner_type !== 'agent'
    || authority.wallet_id !== walletId
    || authority.owner_id !== wallet.agent_id
    || authority.address !== wallet.address.toLowerCase()) {
    throw new Error('chain_record_wallet_index_mismatch');
  }
  const fence = parseNativeWalletRegistrationFence(wallet.native_watcher_registration);
  return {
    walletId,
    agentId: wallet.agent_id,
    address: authority.address,
    eligibilityStartBlock: fence.eligibility_start_block,
    ownerType: 'agent',
  };
}

/**
 * the watched native HUMAN wallet an observation belongs to — the same
 * authority the outbound watcher's human enumeration reads
 * (`enumerateNativeHumanOutboundAddresses`): the `wallets` doc, the canonical
 * address index (`owner_type: 'human'`) and the registration fence. The accrual
 * identity is the human's `user_id`.
 */
async function resolveChainRecordHumanWallet(
  db: Firestore,
  walletId: string,
): Promise<ChainRecordWallet | null> {
  const walletSnap = await db.collection('wallets').doc(walletId).get();
  if (!walletSnap.exists) throw new Error('chain_record_wallet_missing');
  const wallet = walletSnap.data() as {
    id?: string; user_id?: string; address?: string; platform?: string;
    native_watcher_registration?: unknown;
  };
  if (wallet.platform === 'test') return null;
  if (wallet.id !== walletId || typeof wallet.user_id !== 'string' || wallet.user_id.length === 0
    || typeof wallet.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(wallet.address)) {
    throw new Error('chain_record_wallet_identity_invalid');
  }
  const indexId = nativeWalletAddressIndexId(wallet.address);
  const indexSnap = await db.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION).doc(indexId).get();
  const authority = parseCanonicalNativeAddressIndex(
    indexSnap.exists ? indexSnap.data() as Record<string, unknown> : undefined,
    indexId,
  );
  if (authority.owner_type !== 'human'
    || authority.wallet_id !== walletId
    || authority.owner_id !== wallet.user_id
    || authority.address !== wallet.address.toLowerCase()) {
    throw new Error('chain_record_wallet_index_mismatch');
  }
  const fence = parseNativeWalletRegistrationFence(wallet.native_watcher_registration);
  return {
    walletId,
    agentId: wallet.user_id,
    address: authority.address,
    eligibilityStartBlock: fence.eligibility_start_block,
    ownerType: 'human',
  };
}

/**
 * 2026-10-01: the owner of a proven external address — the same authority every
 * watcher reads. An agent's address: its valid `proven_addresses` v2 record and
 * the agent wallet it names. A person's: its valid `human_proven_addresses`
 * record and that person's active Provian wallet. The fence is the proof's exact
 * H+1 `proven_at_block`. A test wallet resolves null (never earns); anything that
 * does not bind throws (the cycle retries it under the horizon).
 */
export async function resolveChainRecordProvenAddress(
  db: Firestore,
  address: string,
  ownerType: ChainRecordOwnerType,
): Promise<ChainRecordWallet | null> {
  const lower = address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(lower)) throw new Error('chain_record_proven_address_invalid');
  if (ownerType === 'human') {
    const snap = await db.collection(HUMAN_PROVEN_ADDRESSES_COLLECTION).doc(lower).get();
    const record: unknown = snap.exists ? snap.data() : undefined;
    if (!isEconomicallyActiveHumanProvenAddress(record, lower)) throw new Error('chain_record_person_proven_invalid');
    const walletSnap = await db.collection('wallets').doc(record.wallet_id).get();
    const wallet = walletSnap.exists ? walletSnap.data() as Record<string, unknown> : undefined;
    if (wallet?.platform === 'test') return null;
    if (!wallet || !isActiveHumanWallet(wallet) || wallet.id !== record.wallet_id || wallet.user_id !== record.user_id) {
      throw new Error('chain_record_person_proven_wallet_invalid');
    }
    return {
      walletId: record.wallet_id,
      agentId: record.user_id,
      address: lower,
      eligibilityStartBlock: record.proven_at_block,
      ownerType: 'human',
      addressKind: 'proven',
      proofMethod: record.proof_method,
    };
  }
  const snap = await db.collection(PROVEN_ADDRESSES_COLLECTION).doc(lower).get();
  const record: unknown = snap.exists ? snap.data() : undefined;
  if (!isEconomicallyActiveProvenAddress(record, lower)) throw new Error('chain_record_agent_proven_invalid');
  const walletSnap = await db.collection('agent_wallets').doc(record.wallet_id).get();
  if (!walletSnap.exists) throw new Error('chain_record_wallet_missing');
  const wallet = walletSnap.data() as { id?: string; agent_id?: string; platform?: string };
  if (wallet.platform === 'test') return null;
  if (wallet.id !== record.wallet_id || wallet.agent_id !== record.agent_id) {
    throw new Error('chain_record_agent_proven_wallet_mismatch');
  }
  return {
    walletId: record.wallet_id,
    agentId: record.agent_id,
    address: lower,
    eligibilityStartBlock: record.proven_at_block,
    ownerType: 'agent',
    addressKind: 'proven',
    proofMethod: record.proof_method,
  };
}

// =============================================================================
// CYCLE
// =============================================================================

interface ObservationDoc {
  schema_version: string;
  chain_id: number;
  tx_hash: string;
  wallet_id: string;
  source: ChainRecordSource;
  owner_type?: ChainRecordOwnerType;
  record_pe_id: string | null;
  requested_at_ms: number;
  /** Set when an operator re-opens a parked observation; its horizons restart here. */
  reopened_at_ms?: number;
  status: 'pending' | 'complete' | 'refused';
  attempts: number;
  next_attempt_at_ms: number;
  lease_until_ms: number;
}

/** Where an observation's horizons start: its request, or its latest re-open. */
function horizonStart(doc: ObservationDoc): number {
  return typeof doc.reopened_at_ms === 'number' && doc.reopened_at_ms > doc.requested_at_ms
    ? doc.reopened_at_ms
    : doc.requested_at_ms;
}

function parseObservation(raw: unknown): ObservationDoc | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.schema_version !== CHAIN_RECORD_OBSERVATION_SCHEMA
    || !isChainRecordChainId(o.chain_id)
    || typeof o.tx_hash !== 'string' || !/^0x[0-9a-f]{64}$/.test(o.tx_hash)
    || typeof o.wallet_id !== 'string' || o.wallet_id.length === 0
    || typeof o.source !== 'string' || !CHAIN_RECORD_SOURCES.has(o.source)
    || (o.owner_type !== undefined && o.owner_type !== 'agent' && o.owner_type !== 'human')
    || typeof o.requested_at_ms !== 'number'
    || (o.reopened_at_ms !== undefined && typeof o.reopened_at_ms !== 'number')
    || typeof o.attempts !== 'number'
    || typeof o.next_attempt_at_ms !== 'number'
    || typeof o.lease_until_ms !== 'number') {
    return null;
  }
  return o as unknown as ObservationDoc;
}

async function lease(
  db: Firestore,
  id: string,
  now: number,
): Promise<ObservationDoc | null> {
  const ref = db.collection(CHAIN_RECORD_OBSERVATIONS_COLLECTION).doc(id);
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const doc = snap.exists ? parseObservation(snap.data()) : null;
    if (!doc || doc.status !== 'pending' || doc.lease_until_ms > now || doc.next_attempt_at_ms > now) {
      return null;
    }
    txn.update(ref, { lease_until_ms: now + LEASE_MS, attempts: doc.attempts + 1 });
    return { ...doc, attempts: doc.attempts + 1 };
  });
}

async function settle(
  db: Firestore,
  id: string,
  update: Record<string, unknown>,
): Promise<void> {
  const terminal = update.status === 'complete' || update.status === 'refused';
  await db.collection(CHAIN_RECORD_OBSERVATIONS_COLLECTION).doc(id).update({
    lease_until_ms: 0,
    ...update,
    ...(terminal ? { next_attempt_at_ms: TERMINAL_NEXT_ATTEMPT_MS } : {}),
  });
}

/** 2, 4, 8, 16, then 30 minutes (attempts counts this lease, so the first retry is RETRY_MS). */
function retryDelayMs(attempts: number): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 10);
  return Math.min(RETRY_MS * 2 ** exponent, MAX_RETRY_MS);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Process one leased observation to exactly one of: emitted (complete),
 * no act (complete, nothing minted), refused (terminal), or waiting (retry).
 */
async function processObservation(
  deps: ChainRecordWatcherDeps,
  id: string,
  doc: ObservationDoc,
  now: number,
): Promise<string> {
  const retry = async (reason: string): Promise<string> => {
    if (now - horizonStart(doc) > CHAIN_RECORD_OBSERVATION_HORIZON_MS) {
      await settle(deps.db, id, { status: 'refused', last_reason: reason, outcome: { reason: `horizon_expired:${reason}` } });
      return `refused:horizon_expired:${reason}`;
    }
    await settle(deps.db, id, { next_attempt_at_ms: now + retryDelayMs(doc.attempts), last_reason: reason });
    return `waiting:${reason}`;
  };
  const refuse = async (reason: string): Promise<string> => {
    await settle(deps.db, id, { status: 'refused', last_reason: reason, outcome: { reason } });
    return `refused:${reason}`;
  };

  const ownerType: ChainRecordOwnerType = doc.owner_type ?? 'agent';
  let wallet: ChainRecordWallet | null;
  try {
    wallet = deps.resolveWallet
      ? await deps.resolveWallet(doc.wallet_id, ownerType)
      : await resolveChainRecordWallet(deps.db, doc.wallet_id, ownerType);
  } catch (error) {
    // review r1 defect 2: a wallet that cannot be resolved now (a transient
    // read failure, or an integrity fault later repaired) is RETRIED with back-off,
    // never refused on first sight; the 7-day horizon closes one that never resolves.
    return retry(`wallet_unresolvable:${errorText(error)}`);
  }
  if (wallet === null) return refuse('test_wallet');
  if (wallet.ownerType !== ownerType) return refuse('wallet_owner_type_mismatch');

  let evidence: ChainTransactionEvidence;
  try {
    evidence = await deps.verifyTransaction(doc.tx_hash, doc.chain_id);
  } catch (error) {
    const message = errorText(error);
    if (message === 'economic_evidence_transaction_failed') return refuse('transaction_failed');
    // an app record's hash is an untrusted pointer; a transaction neither
    // leg can find an hour after it was queued is not coming.
    if (message === 'economic_evidence_pending:transaction_unavailable'
      && now - horizonStart(doc) > CHAIN_RECORD_NOT_FOUND_HORIZON_MS) {
      return refuse('transaction_not_found');
    }
    return retry(message);
  }
  if (evidence.transactionHash !== doc.tx_hash) return refuse('evidence_transaction_mismatch');
  if (evidence.chainId !== doc.chain_id) return refuse('evidence_chain_mismatch');
  if (evidence.blockTimestampMs < CHAIN_RECORD_MINT_CUT_LINE_MS) return refuse('before_landing');
  if (evidence.chainId === BASE_CHAIN_ID) {
    if (evidence.blockNumber < wallet.eligibilityStartBlock) return refuse('before_wallet_fence');
  } else {
    // Another chain: nothing before its own landing, and nothing before the
    // wallet's registration fence (a Base block), read as that block's agreed time.
    if (evidence.blockTimestampMs < MULTICHAIN_COMMERCE_CUT_LINE_MS) return refuse('before_landing');
    // Only an EOA signature proves control of the same address on every chain.
    if (wallet.addressKind === 'proven' && wallet.proofMethod !== 'eip191_eoa') return refuse('contract_proof_is_base_only');
    if (!deps.readBaseBlockTimestampMs) return retry('wallet_fence_time_unavailable');
    let fenceMs: number;
    try {
      fenceMs = await deps.readBaseBlockTimestampMs(wallet.eligibilityStartBlock);
    } catch (error) {
      return retry(`wallet_fence_time:${errorText(error)}`);
    }
    if (evidence.blockTimestampMs < fenceMs) return refuse('before_wallet_fence');
  }

  // Derivation is a pure function of final chain facts: a throw can only repeat,
  // so it is terminal, never a retry that pins a queue slot ( ).
  let derivation: ChainRecordDerivation;
  try {
    derivation = deriveChainRecordAct(evidence, wallet.address);
  } catch (error) {
    return refuse(`derivation_error:${errorText(error)}`);
  }
  // 2026-10-01: nothing in a transaction the wallet did not sign is a receive by
  // its receipt or its plain value — ETH may still have arrived inside it. Read
  // the agreed trace (both trace legs); a trace that is not yet readable, or that
  // names another block than the verified transaction, is retried, never guessed.
  if (derivation.status === 'no_act' && derivation.reason === 'no_qualifying_receive'
    && evidence.chainId === BASE_CHAIN_ID
    && deps.readInternalEth && evidence.fromAddress !== wallet.address
    && evidence.blockTimestampMs >= INTERNAL_ETH_RECEIVE_CUT_LINE_MS) {
    let internal: BaseInternalEthEvidence;
    try {
      internal = await deps.readInternalEth(doc.tx_hash);
    } catch (error) {
      return retry(`internal_eth:${errorText(error)}`);
    }
    if (internal.transactionHash !== evidence.transactionHash
      || internal.blockHash !== evidence.blockHash
      || internal.blockNumber !== evidence.blockNumber) {
      return retry('internal_eth_block_mismatch');
    }
    try {
      derivation = deriveChainRecordAct(evidence, wallet.address, internal);
    } catch (error) {
      return refuse(`derivation_error:${errorText(error)}`);
    }
  }
  if (derivation.status === 'no_act') {
    await settle(deps.db, id, { status: 'complete', last_reason: derivation.reason, outcome: { reason: derivation.reason } });
    return `no_act:${derivation.reason}`;
  }
  // a human's act and every receive mint from the landing forward;
  // an agent's send/swap keeps the line checked above.
  if ((wallet.ownerType === 'human' || derivation.act.actionType === 'receive')
    && evidence.blockTimestampMs < VERIFIED_COMMERCE_CUT_LINE_MS) {
    return refuse('before_landing');
  }
  // 2026-10-01: a native ETH receive mints only from its own landing forward.
  if (derivation.act.actionType === 'receive' && derivation.act.leg === 'native'
    && evidence.blockTimestampMs < ETH_RECEIVE_COMMERCE_CUT_LINE_MS) {
    return refuse('before_landing');
  }
  // 2026-10-01: ETH that arrived inside a transaction mints only from its own landing forward.
  if (derivation.act.internal !== undefined && evidence.blockTimestampMs < INTERNAL_ETH_RECEIVE_CUT_LINE_MS) {
    return refuse('before_landing');
  }
  // 2026-10-01: a proven address's act mints only from its own landing forward.
  if (wallet.addressKind === 'proven' && evidence.blockTimestampMs < PROVEN_ADDRESS_COMMERCE_CUT_LINE_MS) {
    return refuse('before_landing');
  }
  const witness = await readUsdcWitnessVerdict(deps.db, derivation.usdcWitnessPeIds);
  if (witness === 'wait') return retry('awaiting_usdc_witness');
  if (witness === 'minted') {
    await settle(deps.db, id, {
      status: 'complete', last_reason: 'usdc_witness_minted', outcome: { reason: 'usdc_witness_minted' },
    });
    return 'no_act:usdc_witness_minted';
  }

  const emitted = await deps.emitActPE(wallet, derivation.act, evidence, {
    recordPeId: doc.record_pe_id,
    source: doc.source,
  });
  await settle(deps.db, id, {
    status: 'complete',
    last_reason: null,
    outcome: {
      pe_id: emitted.peId,
      action_type: derivation.act.actionType,
      canonical_event_id: derivation.act.canonicalEventId,
    },
  });
  return `emitted:${derivation.act.actionType}`;
}

export interface ChainRecordDrainCapacity {
  readonly concurrency: number;
  readonly maxRunMs: number;
}

/** Transaction-driven capacity; idle runs do not fill their time budget. The
 * upper bounds leave room for the other chains inside the request deadline. */
export function readChainRecordDrainCapacity(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ChainRecordDrainCapacity {
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`chain_record_capacity_invalid:${name}`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`chain_record_capacity_invalid:${name}`);
    }
    return value;
  };
  return {
    concurrency: integer('CHAIN_RECORD_DRAIN_CONCURRENCY', 16, 1, 128),
    maxRunMs: integer('CHAIN_RECORD_DRAIN_BUDGET_MS', 240_000, 1_000, 300_000),
  };
}

export async function runChainRecordWatcherCycle(
  deps: ChainRecordWatcherDeps,
  options: { readonly batch?: number; readonly concurrency?: number; readonly maxRunMs?: number; readonly clock?: () => number } = {},
): Promise<ChainRecordCycleReport> {
  const now = (deps.now ?? Date.now)();
  const report: ChainRecordCycleReport = {
    leased: 0, emitted: 0, by_type: { send: 0, swap: 0, receive: 0 }, no_act: 0, refused: 0, waiting: 0, errors: 0, outcomes: [],
  };
  // READY observations only, oldest due first: a single-field range on
  // `next_attempt_at_ms` (no composite index). Finished observations carry
  // TERMINAL_NEXT_ATTEMPT_MS and waiting ones a future time, so neither can crowd
  // a ready observation out of the window ( ).
  const clock = options.clock ?? Date.now;
  const deadline = clock() + (options.maxRunMs ?? 240_000);
  const pageSize = Math.max(1, options.batch ?? 256);
  do {
  if (clock() >= deadline) break;
  const snap = await deps.db.collection(CHAIN_RECORD_OBSERVATIONS_COLLECTION)
    .where('next_attempt_at_ms', '<=', now)
    .orderBy('next_attempt_at_ms')
    .limit(pageSize * 4)
    .get();
  const ready = snap.docs
    .map((d) => ({ id: d.id, doc: parseObservation(d.data()) }))
    .filter((r) => r.doc !== null && r.doc.status === 'pending'
      && r.doc.next_attempt_at_ms <= now && r.doc.lease_until_ms <= now)
    .slice(0, pageSize);
  if (ready.length === 0) break;
  await mapBounded(ready, options.concurrency ?? 16, async ({ id }) => {
    if (clock() >= deadline) return;
    let leased: ObservationDoc | null;
    try {
      leased = await lease(deps.db, id, now);
    } catch (error) {
      report.errors += 1;
      report.outcomes.push({ id, outcome: `lease_failed:${errorText(error)}` });
      return;
    }
    if (!leased) return;
    report.leased += 1;
    try {
      const outcome = await processObservation(deps, id, leased, now);
      report.outcomes.push({ id, outcome });
      if (outcome.startsWith('emitted:')) {
        report.emitted += 1;
        report.by_type[outcome.slice('emitted:'.length) as 'send' | 'swap' | 'receive'] += 1;
      } else if (outcome.startsWith('no_act:')) report.no_act += 1;
      else if (outcome.startsWith('refused:')) report.refused += 1;
      else report.waiting += 1;
    } catch (error) {
      // An emit that threw leaves the observation pending (lease expires); the
      // deterministic PE id makes the next attempt return the sealed PE.
      report.errors += 1;
      report.outcomes.push({ id, outcome: `error:${errorText(error)}` });
      const expired = now - horizonStart(leased) > CHAIN_RECORD_OBSERVATION_HORIZON_MS;
      await settle(deps.db, id, expired
        ? { status: 'refused', last_reason: errorText(error), outcome: { reason: `horizon_expired:${errorText(error)}` } }
        : { next_attempt_at_ms: now + retryDelayMs(leased.attempts), last_reason: errorText(error) })
        .catch(() => {});
    }
  });
  } while (options.batch === undefined && clock() < deadline);
  return report;
}

// =============================================================================
// RE-OPEN PARKED OBSERVATIONS (operator)
// =============================================================================

/** The reason an observation parked on: the two RPC legs disagreed. */
export const PROVIDER_DISAGREEMENT_REASON_PREFIX = 'economic_discovery_rpc_disagreement';

export interface ReopenParkedReport {
  readonly scanned: number;
  readonly reopened: readonly { readonly id: string; readonly status: string; readonly reason: string }[];
}

function parkedOnProviderDisagreement(raw: Record<string, unknown>): string | null {
  const last = typeof raw.last_reason === 'string' ? raw.last_reason : '';
  const outcome = raw.outcome !== null && typeof raw.outcome === 'object'
    ? (raw.outcome as Record<string, unknown>).reason
    : undefined;
  const outcomeReason = typeof outcome === 'string' ? outcome : '';
  if (raw.status === 'pending' && last.startsWith(PROVIDER_DISAGREEMENT_REASON_PREFIX)) return last;
  if (raw.status === 'refused'
    && outcomeReason.startsWith(`horizon_expired:${PROVIDER_DISAGREEMENT_REASON_PREFIX}`)) {
    return outcomeReason;
  }
  return null;
}

/**
 * Re-open every observation that parked because the two RPC legs disagreed —
 * still pending on the disagreement, or refused when its horizon ran out on it —
 * requested at or after `sinceMs`. Each goes back to `pending`, due now, with its
 * horizons restarted, and the next cycle re-reads the chain and settles it under
 * the lane's rule (emit, no act, or refusal). Nothing else changes: an
 * observation that emitted, completed or was refused for any other reason is
 * never touched, and the deterministic PE id and mint-once claims hold for the
 * re-run exactly as for a first run. Dry-run unless `execute`.
 */
export async function reopenParkedChainRecordObservations(
  db: Firestore,
  options: { readonly sinceMs: number; readonly execute: boolean; readonly now?: number },
): Promise<ReopenParkedReport> {
  const now = options.now ?? Date.now();
  const reopened: { id: string; status: string; reason: string }[] = [];
  let scanned = 0;
  for (const status of ['pending', 'refused'] as const) {
    const snap = await db.collection(CHAIN_RECORD_OBSERVATIONS_COLLECTION).where('status', '==', status).get();
    for (const d of snap.docs) {
      scanned += 1;
      const raw = d.data() as Record<string, unknown>;
      const doc = parseObservation(raw);
      if (doc === null || doc.requested_at_ms < options.sinceMs) continue;
      const reason = parkedOnProviderDisagreement(raw);
      if (reason === null) continue;
      reopened.push({ id: d.id, status, reason });
      if (!options.execute) continue;
      await db.runTransaction(async (txn) => {
        const ref = db.collection(CHAIN_RECORD_OBSERVATIONS_COLLECTION).doc(d.id);
        const fresh = await txn.get(ref);
        const current = fresh.exists ? fresh.data() as Record<string, unknown> : null;
        if (current === null || parkedOnProviderDisagreement(current) === null) return;
        txn.update(ref, {
          status: 'pending',
          next_attempt_at_ms: now,
          lease_until_ms: 0,
          reopened_at_ms: now,
          last_reason: `reopened:${reason}`,
          outcome: null,
        });
      });
    }
  }
  return { scanned, reopened };
}

// =============================================================================
// PRODUCTION DEPS
// =============================================================================

export function buildChainRecordWatcherDeps(deps: AgentBankDeps): ChainRecordWatcherDeps {
  return {
    db: deps.db,
    verifyTransaction: (txHash, chainId = BASE_CHAIN_ID) => {
      if (chainId === BASE_CHAIN_ID) return verifyBaseTransactionEvidence({ transactionHash: txHash });
      const profile = chainRecordProfileFor(chainId);
      if (profile.chain === 'base') throw new Error(`chain_record_chain_unsupported:${chainId}`);
      return verifyEvmTransactionEvidence(profile.chain, { transactionHash: txHash });
    },
    readBaseBlockTimestampMs: (blockNumber) => readAgreedBaseBlockTimestampMs(blockNumber),
    readInternalEth: (txHash) => readAgreedBaseInternalEth({ transactionHash: txHash }),
    emitActPE: async (wallet, act, evidence, observation) => {
      if (evidence.confirmationFloor < BASE_WATCHER_CONFIRMATION_FLOOR) {
        throw new Error('chain_record_evidence_not_final');
      }
      const profile = chainRecordProfileFor(evidence.chainId);
      const witness = chainWatcherWitness(`eip155:${profile.chainId}`);
      const derived = [
        resolvableOrigin(`evm:${act.counterpartyAddress}`, witness),
        resolvableOrigin(
          act.logIndex === null
            ? `evmtx:${profile.chain}:${evidence.transactionHash}`
            : `chaintx:${act.canonicalEventId}`,
          witness,
        ),
      ];
      const emitted = await generatePE(deps, {
        walletId: wallet.walletId,
        agentId: wallet.agentId,
        actorAddress: wallet.address,
        actionType: act.actionType,
        // a human wallet is attributed to the human owner (the immutable
        // 99/0.5/0.5 split, no linked-agent routing; the same-owner fence resolves
        // `agentId`, the user_id, to that human) — as the outbound watcher's
        // human leg. An agent stays 'agent', byte-identical to.
        ownerType: wallet.ownerType,
        walletAddress: wallet.address,
        counterpartyAddress: act.counterpartyAddress,
        // review: a receive that reached the wallet through a contract — the
        // same-owner fence checks the verified signer too.
        transactionSignerAddress: act.actionType === 'receive' && evidence.fromAddress !== act.counterpartyAddress
          ? evidence.fromAddress
          : null,
        metadata: {
          tx_hash: evidence.transactionHash,
          log_index: act.logIndex,
          block_number: evidence.blockNumber,
          block_hash: evidence.blockHash,
          chain: profile.chain,
          chain_id: profile.chainId,
          asset: act.assetSymbol,
          token_address: act.assetAddress,
          amount_atomic: act.amountAtomic,
          leg: act.leg,
          // 2026-10-01: ETH that arrived inside the transaction, from the agreed trace.
          ...(act.internal !== undefined
            ? {
              native_via: 'trace',
              trace_address: [...act.internal.traceAddress],
              trace_evidence_hash: act.internal.evidenceHash,
              trace_evidence_providers: [...act.internal.providerOperatorIds],
            }
            : {}),
          tx_to: evidence.toAddress,
          tx_selector: evidence.transactionSelector,
          verified: true,
          finality_confirmations: BASE_WATCHER_CONFIRMATION_FLOOR,
          economic_evidence_hash: evidence.evidenceHash,
          economic_evidence_providers: [...evidence.providerOperatorIds],
          activity_mapped: true,
          source_type: 'chain_record',
          record_source: observation.source,
          record_pe_id: observation.recordPeId,
          // 2026-10-01: a proven external address is labelled as one, like the USDC watchers do.
          ...(wallet.addressKind === 'proven'
            ? { external_proven: true, proven_address: wallet.address }
            : { native_address: wallet.address }),
          attributed_agent_id: wallet.agentId,
        },
        input_origins: derived,
        relayObservation: {
          witness: relayObservationWitness(RELAY_WITNESS_CHAIN_WATCHER, `eip155:${profile.chainId}`),
          derivedOrigins: derived,
        },
        observedCanonicalEventId: act.canonicalEventId,
        peIdOverride: chainRecordPeId(act.peIdKey ?? act.canonicalEventId, act.actionType, profile.chainId),
        timestampOverride: evidence.blockTimestampMs,
        awaitAccrual: true,
      });
      return { peId: emitted.peId };
    },
  };
}
