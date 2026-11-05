/**
 * Inbound USDC lineage backfill.
 *
 * Recovers and witnesses inbound USDC transfers the watcher missed for ONE agent
 * wallet — e.g. every transfer to Atlas while its key rotation had it excluded
 * from the watched set. It never invents a new witnessing path: every transfer
 * goes through the watcher's own `scanInboundRange` → `createWatcherClaim` →
 * `processInboundClaim` (two-operator verification, the log-granular mint-once
 * claim `8453_<tx>_<logIndex>`, the deterministic `pe_inbound_<sha256>` PE id),
 * so a rerun is idempotent and a transfer the live watcher already witnessed is
 * reported, never re-emitted. The receive-authorship hold applies at
 * accrual exactly as for the live watcher.
 *
 * WINDOWS. The wallet's address lineage is proven from sealed history
 * (`resolveAgentAddressLineage` rotation_history bound to its
 * `agent_key_rotated` PEs). Each address is credited only inside its own window:
 * - from its fence: birth H+1 for the birth address, the rotation's
 * `observed_head_block + 1` for a rotated one — never before;
 * - through the NEXT rotation's `observed_head_block` for a retired address
 * (never after retirement), or through the live watcher's committed global
 * checkpoint for the current address (beyond it, the live watcher owns it).
 * The birth address of a ROTATED wallet has no sealed fence (the rotation
 * overwrote the wallet's fence); it is recovered from independent durable
 * evidence — the outbound watcher's admission for that address and/or the
 * inbound claims the live watcher created while it was live — which must agree.
 * No evidence, or conflicting evidence, REFUSES that window (Unknown = Block).
 *
 * RETIRED ADDRESSES. A rotation deletes the retired address's inbound admission,
 * and the live watcher's claim path requires one. The backfill does NOT recreate
 * a live admission (the live watcher never reads the backfill's collection, so
 * nothing here loosens it). It writes a separate, clearly-labelled
 * `pvt-watcher-historical-admission/v1` document scoped to the address's window,
 * and verifies each claim against it — the window, the retirement tombstone
 * bound to this wallet, and the absence of any live index row for the address.
 *
 * DRY-RUN BY DEFAULT: `execute: false` reads logs and existing claims only.
 */

import type { DocumentReference, Firestore } from 'firebase-admin/firestore';
import {
  agentWalletRotationCount,
  readAgentAddressLineagePes,
  readAgentRotationHistoryRaw,
  resolveAgentAddressLineage,
  type AgentAddressLineage,
  type AgentAddressLineageSegment,
} from '../agent-wallet/agent-address-lineage';
import { AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION } from '../agent-wallet/key-rotation-transition';
import { probeFirestoreUndefinedRejection } from '../../firestore-settings';
import {
  productionBackfillMonetaryGate,
  type BackfillMonetaryGate,
  type BackfillMonetaryPreflight,
  type BackfillMonetaryProjection,
} from './inbound-usdc-backfill-monetary';
import {
  INBOUND_SEEN_COLLECTION,
  atomicUsdcToUsd,
  inboundSeenDocId,
  processInboundClaim,
  scanInboundRange,
  type InboundFundingEvent,
  type InboundRangeLogOutcome,
  type InboundScanReport,
  type InboundTransferLog,
  type InboundUsdcScanDeps,
  type WatchedWallet,
} from './inbound-usdc-watcher';
import {
  INBOUND_WATCHER_CHECKPOINT_COLLECTION,
  WATCHER_ADDRESS_ADMISSION_COLLECTION,
  assertWatcherAddressAdmissionBinding,
  parseWatcherAddressAdmission,
  readWatcherCheckpointSnapshot,
  watcherAddressAdmissionDocId,
  type WatcherAddressAdmissionTarget,
} from './watcher-address-admission';
import {
  NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION,
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  nativeAgentRegistrationIndexId,
  nativeWalletAddressIndexId,
} from './native-wallet-registration';
import {
  isLegacySeenMarker,
  leaseWatcherClaim,
  markWatcherClaimPending,
  readWatcherClaim,
} from './watcher-recovery';

const BASE_CHAIN_ID = 8453;

export const INBOUND_HISTORICAL_ADMISSION_COLLECTION = 'pvt_watcher_historical_admissions_v1';
export const INBOUND_HISTORICAL_ADMISSION_SCHEMA = 'pvt-watcher-historical-admission/v1';
export const INBOUND_HISTORICAL_ADMISSION_LABEL =
  'retired_lineage_address_backfill_not_a_live_admission';

const HISTORICAL_ADMISSION_KEYS = Object.freeze([
  'schema_version',
  'label',
  'direction',
  'chain_id',
  'address',
  'wallet_id',
  'agent_id',
  'lineage_index',
  'eligibility_start_block',
  'retired_after_block',
  'installed_by_pe_id',
  'retired_by_pe_id',
  'fence_source',
  'created_at_ms',
  'created_by',
] as const);

export class InboundBackfillError extends Error {
  constructor(readonly reason: string) {
    super(`inbound_backfill:${reason}`);
    this.name = 'InboundBackfillError';
  }
}

function fail(reason: string): never {
  throw new InboundBackfillError(reason);
}

// =============================================================================
// WINDOWS (pure)
// =============================================================================

export type LineageFenceSource =
  | 'wallet_fence'
  | 'rotation_pe'
  | 'outbound_admission'
  | 'inbound_claims'
  | 'outbound_admission+inbound_claims';

export interface BirthFenceEvidence {
  /** Every distinct eligibility_start_block the evidence names for the birth address. */
  readonly values: readonly number[];
  readonly sources: readonly ('outbound_admission' | 'inbound_claims')[];
}

export interface LineageWindow {
  readonly lineageIndex: number;
  readonly address: string;
  readonly walletId: string;
  readonly agentId: string;
  readonly status: 'current' | 'retired';
  /** The address's anchor (its native index row's created_at_ms while live). */
  readonly anchorMs: number;
  /** First creditable block (the address's own H+1 fence); null when refused. */
  readonly startBlock: number | null;
  /** Last creditable block, inclusive; null when the window is empty/refused. */
  readonly endBlock: number | null;
  readonly fenceSource: LineageFenceSource | null;
  readonly installedByPeId: string;
  readonly retiredByPeId: string | null;
  /** Why this window is not scanned; null when it is. */
  readonly refused: string | null;
}

function birthFenceFrom(
  evidence: BirthFenceEvidence,
): { block: number; source: LineageFenceSource } | { refused: string } {
  if (evidence.values.length === 0) return { refused: 'birth_fence_unrecoverable' };
  if (evidence.values.length > 1) return { refused: 'birth_fence_conflict' };
  const source: LineageFenceSource = evidence.sources.length === 2
    ? 'outbound_admission+inbound_claims'
    : evidence.sources[0];
  return { block: evidence.values[0], source };
}

/**
 * The creditable window of every address in the lineage. Pure. `currentCeiling`
 * is the live watcher's committed global checkpoint (null: nothing committed, so
 * the live watcher still owns the whole current range).
 */
export function computeLineageWindows(
  lineage: AgentAddressLineage,
  input: {
    readonly birthFenceEvidence: BirthFenceEvidence | null;
    readonly currentCeiling: number | null;
  },
): LineageWindow[] {
  return lineage.segments.map((segment: AgentAddressLineageSegment): LineageWindow => {
    const current = segment.retiredAfterBlock === null;
    const base = {
      lineageIndex: segment.index,
      address: segment.address,
      walletId: lineage.walletId,
      agentId: lineage.agentId,
      status: current ? 'current' as const : 'retired' as const,
      anchorMs: segment.anchorMs,
      installedByPeId: segment.installedByPeId,
      retiredByPeId: segment.retiredByPeId,
    };
    let start: number;
    let fenceSource: LineageFenceSource;
    if (segment.fence !== null) {
      start = segment.fence.eligibility_start_block;
      fenceSource = segment.index === 0 ? 'wallet_fence' : 'rotation_pe';
    } else {
      const birth = input.birthFenceEvidence === null
        ? { refused: 'birth_fence_unrecoverable' }
        : birthFenceFrom(input.birthFenceEvidence);
      if ('refused' in birth) {
        return { ...base, startBlock: null, endBlock: null, fenceSource: null, refused: birth.refused };
      }
      start = birth.block;
      fenceSource = birth.source;
    }
    if (!Number.isSafeInteger(start) || start < 1) {
      return { ...base, startBlock: null, endBlock: null, fenceSource, refused: 'fence_invalid' };
    }
    const end = current ? input.currentCeiling : segment.retiredAfterBlock;
    if (!current && (end as number) < start - 1) {
      // A retirement head before the address's own fence is an inconsistent
      // lineage, not an empty window.
      return { ...base, startBlock: start, endBlock: null, fenceSource, refused: 'retired_before_fence' };
    }
    if (end === null || end < start) {
      return { ...base, startBlock: start, endBlock: null, fenceSource, refused: current ? 'current_window_owned_by_live_watcher' : 'empty_window' };
    }
    return { ...base, startBlock: start, endBlock: end, fenceSource, refused: null };
  });
}

export type LineageWindowVerdict = 'admit' | 'pre_fence' | 'post_retirement' | 'window_refused';

/** Whether a transfer at `blockNumber` to this window's address may be credited. */
export function lineageWindowAdmits(window: LineageWindow, blockNumber: number): LineageWindowVerdict {
  if (window.refused !== null || window.startBlock === null || window.endBlock === null) {
    return 'window_refused';
  }
  if (!Number.isSafeInteger(blockNumber) || blockNumber < window.startBlock) return 'pre_fence';
  if (blockNumber > window.endBlock) return 'post_retirement';
  return 'admit';
}

/** Intersect a window with an operator clip; never widens it. */
export function clipLineageWindow(
  window: LineageWindow,
  clip: { readonly fromBlock?: number; readonly toBlock?: number },
): { fromBlock: number; toBlock: number } | null {
  if (window.refused !== null || window.startBlock === null || window.endBlock === null) return null;
  const fromBlock = Math.max(window.startBlock, clip.fromBlock ?? window.startBlock);
  const toBlock = Math.min(window.endBlock, clip.toBlock ?? window.endBlock);
  return fromBlock <= toBlock ? { fromBlock, toBlock } : null;
}

/** The WatchedWallet the live watcher built (or would have built) for this address. */
export function watchedWalletForWindow(window: LineageWindow): WatchedWallet {
  if (window.startBlock === null) fail(`window_refused:${window.address}`);
  return {
    walletId: window.walletId,
    agentId: window.agentId,
    address: window.address,
    createdAtMs: window.anchorMs,
    ownerType: 'agent',
    eligibilityStartBlock: window.startBlock as number,
  };
}

// =============================================================================
// DURABLE READS
// =============================================================================

/** Load and prove the wallet's address lineage from Firestore (read-only). */
export async function loadAgentAddressLineage(
  db: Firestore,
  walletId: string,
  now: number,
): Promise<AgentAddressLineage> {
  const walletSnap = await db.collection('agent_wallets').doc(walletId).get();
  if (!walletSnap.exists) fail(`wallet_missing:${walletId}`);
  const wallet = walletSnap.data() as Record<string, unknown>;
  if (typeof wallet.agent_id !== 'string' || wallet.agent_id.length === 0) fail('wallet_agent_id');
  const agentId = wallet.agent_id as string;
  if (wallet.platform === 'test') fail('test_wallet_never_earns');
  const indexSnap = await db.collection(NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION)
    .doc(nativeAgentRegistrationIndexId(agentId)).get();
  if (!indexSnap.exists) fail('registration_index_missing');
  const registrationIndex = indexSnap.data() as Record<string, unknown>;
  if (registrationIndex.wallet_id !== walletId
    || String(registrationIndex.address).toLowerCase() !== String(wallet.address).toLowerCase()) {
    fail('registration_index_binding');
  }
  const rotationHistory = agentWalletRotationCount(wallet) > 0
    ? await readAgentRotationHistoryRaw(db, walletId)
    : [];
  // PE METER: the birth + rotation PEs are point-read identity acts, never the whole chain.
  const identityPes = await readAgentAddressLineagePes(db, {
    agentId,
    walletId,
    registrationIndex,
    rotationHistory,
    maxTimestampMs: now,
  });
  const lineage = resolveAgentAddressLineage({
    walletId,
    agentId,
    wallet,
    registrationIndex,
    rotationHistory,
    identityPes,
    now,
  });
  // The live address row must be the one the watcher binds: same owner, anchored
  // at the lineage's current anchor.
  const rowSnap = await db.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION)
    .doc(nativeWalletAddressIndexId(lineage.currentAddress)).get();
  const row = rowSnap.data() as Record<string, unknown> | undefined;
  if (!rowSnap.exists || !row
    || row.wallet_id !== walletId
    || row.owner_type !== 'agent'
    || row.owner_id !== agentId
    || row.address !== lineage.currentAddress
    || row.created_at_ms !== lineage.currentAddressAnchorMs) {
    fail('current_address_index_binding');
  }
  return lineage;
}

/**
 * Independent durable evidence of the birth address's H+1 fence, for a ROTATED
 * wallet whose own fence was overwritten: the outbound watcher's admission for
 * that address (written from the wallet's fence while it was live) and every
 * inbound claim the live watcher created for it (each carries the fence it was
 * witnessed under). Both are bound to this wallet and agent.
 */
export async function readBirthFenceEvidence(
  db: Firestore,
  lineage: AgentAddressLineage,
): Promise<BirthFenceEvidence> {
  const values = new Set<number>();
  const sources: ('outbound_admission' | 'inbound_claims')[] = [];
  const target: WatcherAddressAdmissionTarget = {
    direction: 'outbound',
    chainId: BASE_CHAIN_ID,
    address: lineage.birthAddress,
    walletId: lineage.walletId,
    agentId: lineage.agentId,
    eligibilityStartBlock: 0,
  };
  const outbound = await db.collection(WATCHER_ADDRESS_ADMISSION_COLLECTION)
    .doc(watcherAddressAdmissionDocId(target)).get();
  if (outbound.exists) {
    const admission = parseWatcherAddressAdmission(outbound.data() as Record<string, unknown>);
    if (admission.direction === 'outbound'
      && admission.address === lineage.birthAddress
      && admission.wallet_id === lineage.walletId
      && admission.agent_id === lineage.agentId) {
      values.add(admission.eligibility_start_block);
      sources.push('outbound_admission');
    }
  }
  const claims = await db.collection(INBOUND_SEEN_COLLECTION)
    .where('to_address', '==', lineage.birthAddress).get();
  let claimFences = 0;
  for (const doc of claims.docs) {
    const payload = (doc.data() as Record<string, unknown>).payload as Record<string, unknown> | undefined;
    const wallet = payload?.wallet as Record<string, unknown> | undefined;
    if (!wallet
      || wallet.walletId !== lineage.walletId
      || wallet.agentId !== lineage.agentId
      || wallet.address !== lineage.birthAddress
      || wallet.isExternalProven === true
      || !Number.isSafeInteger(wallet.eligibilityStartBlock)) {
      continue;
    }
    values.add(wallet.eligibilityStartBlock as number);
    claimFences += 1;
  }
  if (claimFences > 0) sources.push('inbound_claims');
  return { values: [...values].sort((a, b) => a - b), sources };
}

// =============================================================================
// HISTORICAL ADMISSION (retired addresses only)
// =============================================================================

function historicalAdmissionRef(db: Firestore, address: string): DocumentReference {
  return db.collection(INBOUND_HISTORICAL_ADMISSION_COLLECTION).doc(watcherAddressAdmissionDocId({
    direction: 'inbound',
    chainId: BASE_CHAIN_ID,
    address,
    walletId: 'historical',
    agentId: 'historical',
    eligibilityStartBlock: 0,
  }));
}

export function historicalAdmissionDocument(
  window: LineageWindow,
  nowMs: number,
): Record<string, unknown> {
  if (window.status !== 'retired' || window.refused !== null
    || window.startBlock === null || window.endBlock === null || window.retiredByPeId === null) {
    fail(`historical_admission_requires_retired_window:${window.address}`);
  }
  return {
    schema_version: INBOUND_HISTORICAL_ADMISSION_SCHEMA,
    label: INBOUND_HISTORICAL_ADMISSION_LABEL,
    direction: 'inbound',
    chain_id: BASE_CHAIN_ID,
    address: window.address,
    wallet_id: window.walletId,
    agent_id: window.agentId,
    lineage_index: window.lineageIndex,
    eligibility_start_block: window.startBlock,
    retired_after_block: window.endBlock,
    installed_by_pe_id: window.installedByPeId,
    retired_by_pe_id: window.retiredByPeId,
    fence_source: window.fenceSource,
    created_at_ms: nowMs,
    created_by: 'provian-backend/scripts/inbound-usdc-backfill.ts',
  };
}

function sameHistoricalAdmission(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return HISTORICAL_ADMISSION_KEYS.every((key) => key === 'created_at_ms' || a[key] === b[key]);
}

/** Create the retired window's historical admission, or require the existing one
 * to be identical (apart from its creation time). */
export async function ensureHistoricalAdmission(
  db: Firestore,
  window: LineageWindow,
  nowMs: number,
): Promise<void> {
  const ref = historicalAdmissionRef(db, window.address);
  const wanted = historicalAdmissionDocument(window, nowMs);
  await db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) {
      txn.create(ref, wanted);
      return;
    }
    if (!sameHistoricalAdmission(snap.data() as Record<string, unknown>, wanted)) {
      fail(`historical_admission_conflict:${window.address}`);
    }
  });
}

/**
 * Verify a claimed transfer to a RETIRED address against its historical
 * admission. Self-contained: the document must be exact and bound to the
 * target, the block must lie inside its window, the address's retirement
 * tombstone must name this wallet, and no live native index row may exist for
 * the address (a live address is witnessed through its live admission only).
 */
export async function assertHistoricalAdmission(
  db: Firestore,
  target: WatcherAddressAdmissionTarget,
  blockNumber: number,
): Promise<void> {
  const address = target.address.toLowerCase();
  const snap = await historicalAdmissionRef(db, address).get();
  if (!snap.exists) fail(`historical_admission_missing:${address}`);
  const doc = snap.data() as Record<string, unknown>;
  const keys = Object.keys(doc).sort();
  if (keys.join('\u0000') !== [...HISTORICAL_ADMISSION_KEYS].sort().join('\u0000')
    || doc.schema_version !== INBOUND_HISTORICAL_ADMISSION_SCHEMA
    || doc.label !== INBOUND_HISTORICAL_ADMISSION_LABEL
    || doc.direction !== 'inbound' || target.direction !== 'inbound'
    || doc.chain_id !== BASE_CHAIN_ID || target.chainId !== BASE_CHAIN_ID
    || doc.address !== address
    || doc.wallet_id !== target.walletId
    || doc.agent_id !== target.agentId
    || doc.eligibility_start_block !== target.eligibilityStartBlock
    || !Number.isSafeInteger(doc.retired_after_block)) {
    fail(`historical_admission_binding:${address}`);
  }
  if (!Number.isSafeInteger(blockNumber) || blockNumber < (doc.eligibility_start_block as number)) {
    fail(`historical_admission_pre_fence:${address}`);
  }
  if (blockNumber > (doc.retired_after_block as number)) {
    fail(`historical_admission_post_retirement:${address}`);
  }
  const [tombstone, liveRow] = await Promise.all([
    db.collection(AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION).doc(address).get(),
    db.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION).doc(nativeWalletAddressIndexId(address)).get(),
  ]);
  const retired = tombstone.data() as Record<string, unknown> | undefined;
  if (!tombstone.exists || !retired
    || retired.wallet_id !== target.walletId
    || retired.agent_id !== target.agentId
    || retired.rotation_pe_id !== doc.retired_by_pe_id) {
    fail(`historical_admission_retirement:${address}`);
  }
  if (liveRow.exists) fail(`historical_admission_address_live:${address}`);
}

// =============================================================================
// RUN
// =============================================================================

export type BackfillOutcome =
  | 'witnessed'
  | 'already_witnessed'
  | 'recovered'
  | 'recovery_failed'
  | 'emit_failed'
  | 'claim_create_failed'
  | 'refused_pre_fence'
  | 'refused_post_retirement'
  /** The monetary policy at this transfer's record time is not the active vintage. */
  | 'refused_monetary_policy_inactive'
  /** Two-operator evidence (and so the record time) could not be read: no claim. */
  | 'refused_unverified'
  | 'claim_in_flight'
  | 'would_witness'
  | 'would_recover';

export interface BackfillTransferRow {
  readonly tx_hash: string;
  readonly log_index: number;
  readonly block_number: number;
  readonly from: string;
  readonly to: string;
  readonly amount_atomic: string;
  readonly pe_id: string | null;
  readonly outcome: BackfillOutcome;
  readonly mint_status: string | null;
  readonly error: string | null;
  /** What the record path seals for this transfer (dry run: would seal). */
  readonly projection: BackfillMonetaryProjection | null;
}

export interface InboundBackfillReport {
  readonly wallet_id: string;
  readonly agent_id: string;
  readonly execute: boolean;
  readonly rotation_count: number;
  readonly global_checkpoint: number | null;
  readonly monetary_preflight: BackfillMonetaryPreflight;
  /**
   * round 2: whether this process's Firestore client accepts documents
   * holding `undefined` exactly as the relay's does (`RELAY_FIRESTORE_SETTINGS`).
   * `--execute` refuses when it does not. Null = matches the relay.
   */
  readonly firestore_write_parity_refusal: string | null;
  readonly windows: readonly LineageWindow[];
  readonly scanned: readonly { address: string; fromBlock: number; toBlock: number }[];
  readonly transfers: readonly BackfillTransferRow[];
  readonly totals: Readonly<Record<string, number>>;
}

export interface InboundBackfillParams {
  /** Production deps (`buildBaseInboundDeps`), or an injected test double. */
  readonly deps: InboundUsdcScanDeps;
  readonly walletId: string;
  readonly execute: boolean;
  readonly fromBlock?: number;
  readonly toBlock?: number;
  /** Blocks per getLogs call (default: the live watcher's 10-block cap). */
  readonly blockChunk?: number;
  /** Blocks per progress segment (default 10,000). */
  readonly segmentBlocks?: number;
  readonly now?: () => number;
  readonly onProgress?: (line: string) => void;
  /**
   * The monetary gate. Production (the default) checks the live activation
   * against this process's approval env and template digest; `--execute`
   * refuses before any write unless it admits. Tests inject a double.
   */
  readonly monetaryGate?: BackfillMonetaryGate;
  /**
   * The write-parity probe (default: the real write-free probe). Test seam
   * only — a no-op reproduces the pre-round-2 code, which had no probe.
   */
  readonly firestoreParityProbe?: (db: Firestore) => string | null;
}

/**
 * round 2: an eth_getLogs provider range cap (mainnet.base.org refuses
 * a range over 2,000 blocks with HTTP 413) is recognised and the range is
 * SPLIT and retried, never skipped. Anything else — a rate limit or an outage
 * included, which splitting would only multiply — propagates unchanged.
 */
export const LOG_RANGE_REFUSAL =
  /\b413\b|payload too large|request entity too large|block range|range (?:is )?too (?:large|wide|big)|returned more than \d+ results|response size exceeded/i;

export function withRangeSplitting(
  getLogs: InboundUsdcScanDeps['getLogs'],
  onSplit: (fromBlock: number, toBlock: number) => void = () => undefined,
): InboundUsdcScanDeps['getLogs'] {
  const fetchRange = async (
    args: { fromBlock: number; toBlock: number; toAddresses: string[] },
  ): Promise<InboundTransferLog[]> => {
    try {
      return await getLogs(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (args.toBlock <= args.fromBlock || !LOG_RANGE_REFUSAL.test(message)) throw error;
      const mid = args.fromBlock + Math.floor((args.toBlock - args.fromBlock) / 2);
      onSplit(args.fromBlock, args.toBlock);
      const left = await fetchRange({ ...args, toBlock: mid });
      const right = await fetchRange({ ...args, fromBlock: mid + 1 });
      return [...left, ...right];
    }
  };
  return fetchRange;
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * round 2: every provider log is shape-checked before it can reach a
 * report row, a claim, or a PE. A log from a mis-mapped provider (e.g. an ethers
 * `Log`, whose index field is `index`, not `logIndex`) fails the run by name —
 * Unknown = Block — instead of writing `undefined` anywhere.
 */
export function assertInboundLogShape(log: unknown): asserts log is InboundTransferLog {
  const record = (typeof log === 'object' && log !== null ? log : {}) as Record<string, unknown>;
  const bad = (field: string): never => fail(`malformed_provider_log:${field}`);
  if (typeof record.txHash !== 'string' || !TX_HASH.test(record.txHash)) bad('txHash');
  if (typeof record.logIndex !== 'number' || !Number.isSafeInteger(record.logIndex) || record.logIndex < 0) bad('logIndex');
  if (typeof record.blockNumber !== 'number' || !Number.isSafeInteger(record.blockNumber) || record.blockNumber < 0) {
    bad('blockNumber');
  }
  if (typeof record.fromAddress !== 'string' || !EVM_ADDRESS.test(record.fromAddress)) bad('fromAddress');
  if (typeof record.toAddress !== 'string' || !EVM_ADDRESS.test(record.toAddress)) bad('toAddress');
  if (typeof record.amountAtomic !== 'string' || !/^\d+$/.test(record.amountAtomic)) bad('amountAtomic');
}

function emptyScanReport(): InboundScanReport {
  return {
    chain_id: BASE_CHAIN_ID, from_block: 0, to_block: 0, watched_wallets: 0, logs_seen: 0,
    new_fundings: 0, pes_emitted: 0, duplicates_skipped: 0, dust_skipped: 0,
    unmatched_skipped: 0, pre_proof_skipped: 0, errors: 0, bounty_pvt_granted: 0,
    log_calls_used: 0, budget_stopped: false, excluded_wallets: 0, orphaned_index_rows: 0,
    exclusions: [],
  };
}

/** An existing per-log claim, including the pre-durable legacy marker (which is
 * completed history: its transfer was processed by the pre-claim path). */
async function existingClaim(ref: DocumentReference): Promise<
  | { kind: 'none' }
  | { kind: 'legacy' }
  | { kind: 'claim'; state: string; peId: string | null; lastError: string | null }
> {
  const snap = await ref.get();
  if (!snap.exists) return { kind: 'none' };
  if (isLegacySeenMarker(snap.data())) return { kind: 'legacy' };
  const claim = await readWatcherClaim(ref);
  if (claim === null) return { kind: 'none' };
  return { kind: 'claim', state: claim.state, peId: claim.peId, lastError: claim.lastError };
}

async function mintStatusOf(db: Firestore, peId: string | null): Promise<string | null> {
  if (peId === null) return null;
  try {
    const snap = await db.collection('pe_history').doc(peId).get();
    const status = snap.exists ? (snap.data() as Record<string, unknown>).mint_status : null;
    return typeof status === 'string' ? status : null;
  } catch {
    return null;
  }
}

export async function runInboundUsdcBackfill(params: InboundBackfillParams): Promise<InboundBackfillReport> {
  const now = params.now ?? Date.now;
  const db = params.deps.db;
  const blockChunk = params.blockChunk ?? 10;
  const segmentBlocks = params.segmentBlocks ?? 10_000;
  const progress = params.onProgress ?? (() => undefined);
  if (!Number.isSafeInteger(blockChunk) || blockChunk < 1) fail('block_chunk_invalid');
  if (!Number.isSafeInteger(segmentBlocks) || segmentBlocks < blockChunk) fail('segment_blocks_invalid');

  // Before ANY write: a shell whose accrual would price under the inactive
  // record-only policy (or a different template) would seal every recovered
  // receive at 0 PVT under a deterministic PE id — permanent. Refuse here.
  // Before ANY write: a client that rejects `undefined` fails the shared
  // pe_history write AFTER the receive PE is sealed (the round-2 prod failure).
  const parityRefusal = (params.firestoreParityProbe ?? probeFirestoreUndefinedRejection)(db);
  progress(`firestore write parity: ${parityRefusal === null ? 'matches the relay' : `REFUSES (${parityRefusal})`}`);
  if (params.execute && parityRefusal !== null) {
    fail('firestore_write_parity_refused:ignoreUndefinedProperties_not_set');
  }

  const gate = params.monetaryGate ?? productionBackfillMonetaryGate(db, { now });
  const preflight = await gate.preflight();
  progress(`monetary preflight: ${preflight.admits_execute ? 'admits' : `refuses (${preflight.refusal})`}`
    + ` verdict=${preflight.activation_verdict} digest_match=${preflight.digest_match}`
    + ` computed=${preflight.computed_template_sha256} pinned=${preflight.pinned_template_sha256 ?? 'none'}`);
  if (params.execute && !preflight.admits_execute) {
    fail(`monetary_preflight_refused:${preflight.refusal ?? 'unknown'}`);
  }

  const lineage = await loadAgentAddressLineage(db, params.walletId, now());
  const birthFenceEvidence = lineage.rotationCount > 0
    ? await readBirthFenceEvidence(db, lineage)
    : null;
  const checkpoint = await readWatcherCheckpointSnapshot(
    db,
    INBOUND_WATCHER_CHECKPOINT_COLLECTION,
    BASE_CHAIN_ID,
  );
  const windows = computeLineageWindows(lineage, {
    birthFenceEvidence,
    currentCeiling: checkpoint.lastProcessedBlock,
  });
  const byAddress = new Map(windows.map((window) => [window.address, window]));

  // The claim payload records whether the SENDER is watched; bind it to the
  // live watched set so a claim the live watcher creates concurrently for the
  // same log carries a byte-identical payload (the duplicate check compares it).
  const liveWatched = await params.deps.listWatchedWallets();
  const sourceWatchSet = new Set(liveWatched.map((wallet) => wallet.address.toLowerCase()));

  const shapedGetLogs = withRangeSplitting(params.deps.getLogs, (from, to) =>
    progress(`  getLogs ${from}..${to} refused as too large by the provider; splitting`));
  const deps: InboundUsdcScanDeps = {
    ...params.deps,
    getLogs: async (args) => {
      const logs = await shapedGetLogs(args);
      for (const log of logs) assertInboundLogShape(log);
      return logs;
    },
    verifyAddressAdmission: async (target: WatcherAddressAdmissionTarget, event: InboundFundingEvent) => {
      const window = byAddress.get(target.address.toLowerCase());
      if (!window) fail(`address_not_in_lineage:${target.address}`);
      const verdict = lineageWindowAdmits(window as LineageWindow, event.blockNumber);
      if (verdict !== 'admit') fail(`window_${verdict}:${target.address}`);
      if ((window as LineageWindow).status === 'current') {
        await assertWatcherAddressAdmissionBinding(db, target);
      } else {
        await assertHistoricalAdmission(db, target, event.blockNumber);
      }
    },
  };

  const transfers: BackfillTransferRow[] = [];
  const scanned: { address: string; fromBlock: number; toBlock: number }[] = [];
  const row = (
    log: InboundTransferLog,
    outcome: BackfillOutcome,
    peId: string | null,
    error: string | null,
    mintStatus: string | null,
    projection: BackfillMonetaryProjection | null = null,
  ): BackfillTransferRow => ({
    tx_hash: log.txHash.toLowerCase(),
    log_index: log.logIndex,
    block_number: log.blockNumber,
    from: log.fromAddress.toLowerCase(),
    to: log.toAddress.toLowerCase(),
    amount_atomic: log.amountAtomic,
    pe_id: peId,
    outcome,
    mint_status: mintStatus,
    error,
    projection,
  });

  // Per transfer, BEFORE a claim exists: read its two-operator evidence for the
  // record time (the PE's timestamp is the block timestamp) and require the
  // loader to return the ACTIVE vintage there. Read-only.
  const projections = new Map<string, BackfillMonetaryProjection>();
  const projectionKey = (log: InboundTransferLog): string => `${log.txHash.toLowerCase()}:${log.logIndex}`;
  const gateLog = async (
    wallet: WatchedWallet,
    log: InboundTransferLog,
  ): Promise<{ ok: true; projection: BackfillMonetaryProjection } | { ok: false; row: BackfillTransferRow }> => {
    let recordedAtMs: number;
    try {
      const evidence = await deps.verifyFundingEvent(wallet, {
        txHash: log.txHash,
        logIndex: log.logIndex,
        blockNumber: log.blockNumber,
        fromAddress: log.fromAddress,
        amountUsd: atomicUsdcToUsd(log.amountAtomic),
        amountAtomic: log.amountAtomic,
        observedAtMs: 0,
      });
      recordedAtMs = evidence.blockTimestampMs;
    } catch (error) {
      return {
        ok: false,
        row: row(log, 'refused_unverified', null,
          (error instanceof Error ? error.message : String(error)).slice(0, 500), null),
      };
    }
    const projection = await gate.project({
      wallet,
      log,
      recordedAtMs,
      pinnedPolicyVersion: preflight.policy_version,
    });
    projections.set(projectionKey(log), projection);
    if (!projection.policy_active) {
      return {
        ok: false,
        row: row(log, 'refused_monetary_policy_inactive', null,
          `policy_inactive_at_record_time:${projection.policy_version}`, null, projection),
      };
    }
    return { ok: true, projection };
  };
  const projectionOf = (log: InboundTransferLog): BackfillMonetaryProjection | null =>
    projections.get(projectionKey(log)) ?? null;

  for (const window of windows) {
    const range = clipLineageWindow(window, { fromBlock: params.fromBlock, toBlock: params.toBlock });
    if (range === null) {
      progress(`window ${window.lineageIndex} ${window.address} ${window.status}: skipped (${window.refused ?? 'outside clip'})`);
      continue;
    }
    scanned.push({ address: window.address, ...range });
    const wallet = watchedWalletForWindow(window);
    if (params.execute && window.status === 'retired') {
      await ensureHistoricalAdmission(db, window, now());
    }
    progress(`window ${window.lineageIndex} ${window.address} ${window.status}: blocks ${range.fromBlock}..${range.toBlock}`);

    for (let segmentStart = range.fromBlock; segmentStart <= range.toBlock; segmentStart += segmentBlocks) {
      const segmentEnd = Math.min(segmentStart + segmentBlocks - 1, range.toBlock);
      if (!params.execute) {
        for (let cursor = segmentStart; cursor <= segmentEnd; cursor += blockChunk) {
          const end = Math.min(cursor + blockChunk - 1, segmentEnd);
          const logs = await deps.getLogs({ fromBlock: cursor, toBlock: end, toAddresses: [window.address] });
          for (const log of logs.sort((a, b) => (a.blockNumber - b.blockNumber) || (a.logIndex - b.logIndex))) {
            if (log.toAddress.toLowerCase() !== window.address) continue;
            const verdict = lineageWindowAdmits(window, log.blockNumber);
            if (verdict !== 'admit') {
              transfers.push(row(log, verdict === 'pre_fence' ? 'refused_pre_fence' : 'refused_post_retirement', null, verdict, null));
              continue;
            }
            const claim = await existingClaim(db.collection(INBOUND_SEEN_COLLECTION)
              .doc(inboundSeenDocId(BASE_CHAIN_ID, log.txHash, log.logIndex)));
            if (claim.kind === 'none' || (claim.kind === 'claim' && claim.state !== 'complete')) {
              const gated = await gateLog(wallet, log);
              const projection = gated.ok ? gated.projection : gated.row.projection;
              const error = gated.ok ? (claim.kind === 'claim' ? claim.lastError : null) : gated.row.error;
              transfers.push(row(log, claim.kind === 'none' ? 'would_witness' : 'would_recover',
                null, error, null, projection));
              continue;
            }
            if (claim.kind === 'legacy') {
              transfers.push(row(log, 'already_witnessed', null, 'legacy_seen_marker', null));
            } else if (claim.kind === 'claim') {
              transfers.push(row(log, 'already_witnessed', claim.peId, null, await mintStatusOf(db, claim.peId)));
            }
          }
        }
        progress(`  dry-run through block ${segmentEnd}`);
        continue;
      }

      const seen: { log: InboundTransferLog; outcome: InboundRangeLogOutcome }[] = [];
      // A log outside the window never reaches claim creation: a durable claim
      // for a transfer this address may not be credited for would sit pending
      // in the live watcher's recovery forever. The window check inside
      // `verifyAddressAdmission` remains as the second, independent refusal.
      const windowDeps: InboundUsdcScanDeps = {
        ...deps,
        getLogs: async (args) => {
          const admitted: InboundTransferLog[] = [];
          for (const log of await deps.getLogs(args)) {
            if (log.toAddress.toLowerCase() !== window.address) {
              admitted.push(log);
              continue;
            }
            const verdict = lineageWindowAdmits(window, log.blockNumber);
            if (verdict === 'admit') {
              const gated = await gateLog(wallet, log);
              if (gated.ok) admitted.push(log);
              else transfers.push(gated.row);
            } else {
              transfers.push(row(log, verdict === 'pre_fence' ? 'refused_pre_fence' : 'refused_post_retirement',
                null, verdict, null));
            }
          }
          return admitted;
        },
      };
      await scanInboundRange(windowDeps, {
        addrMap: new Map([[window.address, wallet]]),
        sourceWatchSet,
        fromBlock: segmentStart,
        toBlock: segmentEnd,
        blockChunk,
        addressBatchSize: 1,
        budget: { remaining: Number.MAX_SAFE_INTEGER },
        report: emptyScanReport(),
        now,
        onLog: (log, outcome) => { seen.push({ log, outcome }); },
      });
      for (const { log, outcome } of seen) {
        if (outcome.outcome === 'witnessed') {
          transfers.push(row(log, 'witnessed', outcome.peId, null, await mintStatusOf(db, outcome.peId),
            projectionOf(log)));
        } else if (outcome.outcome === 'pre_fence') {
          transfers.push(row(log, 'refused_pre_fence', null, 'pre_fence', null));
        } else if (outcome.outcome === 'emit_failed') {
          transfers.push(row(log, outcome.outcome, null, outcome.error, null));
        } else if (outcome.outcome === 'claim_create_failed') {
          const ref = db.collection(INBOUND_SEEN_COLLECTION)
            .doc(inboundSeenDocId(BASE_CHAIN_ID, log.txHash, log.logIndex));
          const claim = await existingClaim(ref).catch(() => ({ kind: 'none' as const }));
          transfers.push(claim.kind === 'legacy'
            ? row(log, 'already_witnessed', null, 'legacy_seen_marker', null)
            : row(log, 'claim_create_failed', null, outcome.error, null));
        } else if (outcome.outcome === 'duplicate') {
          // The claim already exists: completed history, or a claim stranded
          // behind the rotation (its live admission was deleted, so the live
          // watcher's recovery can never finish it). Drive the stranded one here.
          const ref = db.collection(INBOUND_SEEN_COLLECTION)
            .doc(inboundSeenDocId(BASE_CHAIN_ID, log.txHash, log.logIndex));
          const claim = await existingClaim(ref);
          if (claim.kind === 'legacy') {
            transfers.push(row(log, 'already_witnessed', null, 'legacy_seen_marker', null));
            continue;
          }
          if (claim.kind === 'claim' && claim.state === 'complete') {
            transfers.push(row(log, 'already_witnessed', claim.peId, null, await mintStatusOf(db, claim.peId)));
            continue;
          }
          const handle = await leaseWatcherClaim(db, ref, now());
          if (handle === null) {
            transfers.push(row(log, 'claim_in_flight', null, null, null));
            continue;
          }
          try {
            const emitted = await processInboundClaim(deps, handle, new Map([[window.address, wallet]]));
            transfers.push(row(log, 'recovered', emitted.peId, null, await mintStatusOf(db, emitted.peId),
              projectionOf(log)));
          } catch (error) {
            await markWatcherClaimPending(db, handle, error, now()).catch(() => undefined);
            transfers.push(row(log, 'recovery_failed', null,
              (error instanceof Error ? error.message : String(error)).slice(0, 500), null));
          }
        }
      }
      progress(`  executed through block ${segmentEnd} (resume with --from-block ${segmentEnd + 1})`);
    }
  }

  const totals: Record<string, number> = {};
  for (const transfer of transfers) totals[transfer.outcome] = (totals[transfer.outcome] ?? 0) + 1;
  return {
    wallet_id: lineage.walletId,
    agent_id: lineage.agentId,
    execute: params.execute,
    rotation_count: lineage.rotationCount,
    global_checkpoint: checkpoint.lastProcessedBlock,
    monetary_preflight: preflight,
    firestore_write_parity_refusal: parityRefusal,
    windows,
    scanned,
    transfers,
    totals,
  };
}
