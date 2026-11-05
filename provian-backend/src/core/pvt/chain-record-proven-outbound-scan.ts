/**
 * OUTBOUND
 * DISCOVERY FOR PROVEN EXTERNAL ADDRESSES.
 *
 * A native wallet's sends and swaps reach the chain-record lane as pointers from
 * its own records (an agent's `/transfer/record`, the app's Send / Swap). A
 * proven external address — a person's or an agent's — is used OUTSIDE Provian,
 * so nothing records its transactions. This scan finds them on chain, without a
 * second minting path: it only queues each transaction hash into the lane
 * (`chain-record-watcher.ts`, source `proven_outbound_scan`), which re-verifies
 * the whole transaction through both operator legs and derives the act from the
 * receipt alone under every unchanged fence.
 *
 * HOW. An EOA's account nonce at a block counts the transactions it has signed
 * through that block. Per proven EOA the scan keeps a cursor
 * `{ next_block, nonce }` meaning: every transaction with a lower nonce has been
 * queued, and the transaction carrying `nonce` was mined at or after
 * `next_block`. Each run reads the nonce at the finalized head (quorum-2); for
 * each new nonce it binary-searches the first block whose nonce exceeds it, reads
 * that block's transactions on both legs and queues the one the address signed
 * with that nonce. Every transaction the address signed is found — ETH sends,
 * token sends, swaps — and nothing it did not sign. A contract wallet
 * (EIP-1271) signs nothing itself and is skipped: the lane mints only acts the
 * address itself signed.
 *
 * A NONCE WITH NO TRANSACTION (nonce-gap control). Since EIP-7702 a nonce
 * can be consumed without a transaction the address sent: a self-sponsored
 * type-4 transaction bumps it by two, and a sponsored authorization by one with
 * no transaction from the address at all. When both operator legs agree the
 * block that consumed nonce `k` holds no transaction from the address with that
 * nonce, there is no act to find; the scan counts it and moves past it. A leg
 * disagreement still throws and holds the cursor (the reader never returns null
 * on disagreement), so skipping can only ever pass over nothing.
 *
 * FAIRNESS (round-robin fairness). Addresses are visited round-robin from a
 * persisted position, so a run that exhausts its budget resumes with the next
 * address, never the first one in sorted order; every proven address is
 * reached, and none loses history while it waits, because a cursor never starts
 * later than its own fence or the commerce floor.
 *
 * FROM THE PROOF FORWARD. A cursor starts at the proof's exact H+1 fence or the
 * commerce floor block, whichever is later; the lane also refuses anything
 * before the fence or before its own cut line.
 */

import type { Firestore } from 'firebase-admin/firestore';
import {
  BASE_WATCHER_CONFIRMATION_FLOOR,
  readAgreedBaseHead,
  readAgreedBaseBlockTimestampMs,
  readAgreedBaseNonce,
  readAgreedBaseTransactionByNonce,
} from '../onchain/economic-discovery';
import {
  enqueueChainRecordObservation,
  provenObservationWalletId,
  type ChainRecordOwnerType,
} from './chain-record-watcher';
import { withRateLimitRetry } from './outbound-usdc-watcher';
import {
  HUMAN_PROVEN_ADDRESSES_COLLECTION,
  PROVEN_ADDRESSES_COLLECTION,
  PROVEN_ADDRESS_SCHEMA,
  isEconomicallyActiveProvenAddress,
  provenAddressRowForWatchers,
} from '../external-address/link';
import { isEconomicallyActiveHumanProvenAddress } from '../external-address/human-link';
import {
  CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID,
} from './chain-record-inbound-scan';
import {
  CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION,
  PROVEN_OUTBOUND_CURSOR_PREFIX,
  PROVEN_OUTBOUND_FLOOR_BLOCK,
  PROVEN_OUTBOUND_RANGE_SCHEMA,
  openProvenOutboundRange,
  parseProvenOutboundRange,
  refreshProvenOutboundRangeCompletion,
  readFullBlockSince,
  type ProvenOutboundRange,
} from './proven-outbound-ranges';
import { readWatchRegistry, watchRegistryAddresses } from './watch-registry';

export { PROVEN_OUTBOUND_CURSOR_PREFIX, PROVEN_OUTBOUND_FLOOR_BLOCK };
const CURSOR_SCHEMA = 'chain-record-proven-outbound-cursor/v1';
const ROTATION_SCHEMA = 'chain-record-proven-outbound-rotation/v1';
export const PROVEN_OUTBOUND_ROTATION_DOC = 'proven_outbound__rotation';
const DEFAULT_MAX_CALLS = 200;

export interface ProvenOutboundAddress {
  readonly address: string; // lowercased
  readonly ownerType: ChainRecordOwnerType;
  /** The proof's exact H+1 fence. */
  readonly provenAtBlock: number;
  readonly proofMethod: 'eip191_eoa' | 'eip1271_contract';
}

export interface ProvenOutboundScanDeps {
  readonly db: Firestore;
  readonly getHead: () => Promise<number>;
  readonly getBlockTimestampMs?: (height: number) => Promise<number>;
  readonly getNonce: (address: string, blockNumber: number) => Promise<number>;
  readonly getTransactionByNonce: (address: string, nonce: number, blockNumber: number) => Promise<string | null>;
  readonly listProven: () => Promise<readonly ProvenOutboundAddress[]>;
  readonly now?: () => number;
  /** production. From B_F on, scan only bounded ranges and cover a lagging chain-record scan. */
  readonly useRegistry?: boolean;
}

export interface ProvenOutboundScanReport {
  finalized_through: number;
  watched: number;
  skipped_contract_wallets: number;
  queued: number;
  already_queued: number;
  /** Nonces consumed with no transaction from the address (EIP-7702 authorizations). */
  nonces_without_transaction: number;
  calls_used: number;
  budget_stopped: boolean;
  errors: Array<{ address: string; error: string }>;
  /** 'every_address' before B_F; 'bounded' after it (ranges + lag cover). */
  mode: 'every_address' | 'bounded';
  ranges_open: number;
  /** the chain-record scan was lagging, so this run covered from its cursor up. */
  lagging: boolean;
}

interface Cursor {
  schema_version: typeof CURSOR_SCHEMA;
  address: string;
  next_block: number;
  /** null until read at `next_block - 1`. */
  nonce: number | null;
  updated_at_ms: number;
}

function cursorId(address: string): string {
  return `${PROVEN_OUTBOUND_CURSOR_PREFIX}${address}`;
}

async function readCursor(db: Firestore, address: string): Promise<Cursor | null> {
  const snap = await db.collection(CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION).doc(cursorId(address)).get();
  if (!snap.exists) return null;
  const c = snap.data() as Record<string, unknown>;
  if (c.schema_version !== CURSOR_SCHEMA || c.address !== address
    || !Number.isSafeInteger(c.next_block) || (c.next_block as number) < 0
    || !(c.nonce === null || (Number.isSafeInteger(c.nonce) && (c.nonce as number) >= 0))) {
    // A malformed cursor is an integrity fault, never a guess at where to resume.
    throw new Error('chain_record_proven_outbound_cursor_invalid');
  }
  return c as unknown as Cursor;
}

async function writeCursor(db: Firestore, cursor: Cursor): Promise<void> {
  await db.collection(CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION).doc(cursorId(cursor.address)).set({ ...cursor });
}

/**
 * The round-robin position: the next run starts at the first address after
 * `resume_after`. It decides only the ORDER of a run, never what is found (every
 * cursor holds its own position), so a malformed position is logged and the run
 * starts from the top rather than stopping the scan for everyone.
 */
async function readResumeAfter(db: Firestore): Promise<string | null> {
  const snap = await db.collection(CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION).doc(PROVEN_OUTBOUND_ROTATION_DOC).get();
  if (!snap.exists) return null;
  const r = snap.data() as Record<string, unknown>;
  if (r.schema_version !== ROTATION_SCHEMA
    || !(r.resume_after === null || (typeof r.resume_after === 'string' && /^0x[0-9a-f]{40}$/.test(r.resume_after)))) {
    console.error('[chain-record-proven-outbound-scan] rotation position invalid; starting from the top');
    return null;
  }
  return r.resume_after as string | null;
}

/** Sorted addresses, rotated to start just after `resumeAfter` (wrapping). */
export function rotateFrom<T extends { readonly address: string }>(
  sorted: readonly T[],
  resumeAfter: string | null,
): T[] {
  if (resumeAfter === null) return [...sorted];
  const start = sorted.findIndex((t) => t.address > resumeAfter);
  if (start <= 0) return [...sorted];
  return [...sorted.slice(start), ...sorted.slice(0, start)];
}

interface NonceState {
  next_block: number;
  nonce: number | null;
}

interface NonceRun {
  readonly deps: ProvenOutboundScanDeps;
  readonly report: ProvenOutboundScanReport;
  readonly maxCalls: number;
  readonly now: number;
  calls: number;
}

/**
 * Advance one nonce cursor through `ceiling`: every transaction the address signed with a nonce
 * from the cursor's up to the nonce at `ceiling` is queued. Persists after every step. Returns
 * whether it reached `ceiling` (the budget can stop it first).
 */
async function advanceNonceCursor(
  run: NonceRun,
  address: string,
  ownerType: ChainRecordOwnerType,
  initial: NonceState,
  ceiling: number,
  persist: (state: NonceState) => Promise<void>,
): Promise<boolean> {
  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    run.calls += 1;
    return fn();
  };
  let state = { ...initial };
  if (state.nonce === null) {
    const startNonce = await call(() => run.deps.getNonce(address, state.next_block - 1));
    state = { ...state, nonce: startNonce };
    await persist(state);
  }
  const nonceNow = await call(() => run.deps.getNonce(address, ceiling));
  if (nonceNow < (state.nonce as number)) throw new Error('chain_record_proven_outbound_nonce_regressed');
  while ((state.nonce as number) < nonceNow) {
    const k = state.nonce as number;
    // Binary search the first block in [next_block, ceiling] whose nonce > k.
    const span = ceiling - state.next_block + 1;
    const probes = Math.ceil(Math.log2(Math.max(span, 1))) + 1;
    if (run.calls + probes + 1 > run.maxCalls) {
      run.report.budget_stopped = true;
      return false;
    }
    let lo = state.next_block;
    let hi = ceiling;
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      const atMid = await call(() => run.deps.getNonce(address, mid));
      if (atMid > k) hi = mid;
      else lo = mid + 1;
    }
    const txHash = await call(() => run.deps.getTransactionByNonce(address, k, lo));
    if (txHash === null) {
      // Both legs agree: nonce k was consumed in block `lo` with no transaction
      // from the address (an EIP-7702 authorization). There is no act to find.
      run.report.nonces_without_transaction += 1;
    } else {
      const created = await enqueueChainRecordObservation(run.deps.db, {
        txHash,
        walletId: provenObservationWalletId(address),
        source: 'proven_outbound_scan',
        ownerType,
      }, run.now);
      if (created) run.report.queued += 1;
      else run.report.already_queued += 1;
    }
    // The transaction with nonce k+1 can share block `lo`, never precede it.
    state = { nonce: k + 1, next_block: lo };
    await persist(state);
  }
  await persist({ ...state, next_block: ceiling + 1 });
  return true;
}

export async function runChainRecordProvenOutboundScan(
  deps: ProvenOutboundScanDeps,
  options: { readonly maxCalls?: number } = {},
): Promise<ProvenOutboundScanReport> {
  const now = (deps.now ?? Date.now)();
  const maxCalls = Math.max(1, options.maxCalls ?? DEFAULT_MAX_CALLS);
  const head = await deps.getHead();
  const finalized = head - BASE_WATCHER_CONFIRMATION_FLOOR;
  const report: ProvenOutboundScanReport = {
    finalized_through: finalized, watched: 0, skipped_contract_wallets: 0, queued: 0,
    already_queued: 0, nonces_without_transaction: 0, calls_used: 0, budget_stopped: false, errors: [],
    mode: 'every_address', ranges_open: 0, lagging: false,
  };
  const run: NonceRun = { deps, report, maxCalls, now, calls: 0 };
  // once the chain-record scan finds proven EOAs' transactions in its full blocks
  // (from B_F), this scan only backfills bounded ranges and covers while that scan lags.
  const fullBlockSince = deps.useRegistry ? await readFullBlockSince(deps.db) : null;
  if (fullBlockSince !== null) {
    await runBoundedProvenOutbound(run, fullBlockSince, finalized);
    report.calls_used = run.calls;
    return report;
  }

  const sorted = [...await deps.listProven()].sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  const resumeAfter = await readResumeAfter(deps.db);
  /** The last address this run gave a turn to (it read at least the nonce). */
  let lastTurn: string | null = null;
  for (const target of rotateFrom(sorted, resumeAfter)) {
    if (report.budget_stopped) break;
    if (target.proofMethod !== 'eip191_eoa') {
      report.skipped_contract_wallets += 1;
      continue;
    }
    report.watched += 1;
    try {
      let cursor = await readCursor(deps.db, target.address) ?? {
        schema_version: CURSOR_SCHEMA,
        address: target.address,
        next_block: Math.max(target.provenAtBlock, PROVEN_OUTBOUND_FLOOR_BLOCK),
        nonce: null,
        updated_at_ms: now,
      } satisfies Cursor;
      // Never before the proof: a cursor can only move forward from the fence.
      if (cursor.next_block < target.provenAtBlock) {
        cursor = { ...cursor, next_block: target.provenAtBlock, nonce: null };
      }
      if (cursor.next_block > finalized) {
        await writeCursor(deps.db, { ...cursor, updated_at_ms: now });
        continue;
      }
      if (run.calls + 2 > maxCalls) {
        report.budget_stopped = true;
        break;
      }
      lastTurn = target.address;
      const base = cursor;
      await advanceNonceCursor(run, target.address, target.ownerType, cursor, finalized,
        (state) => writeCursor(deps.db, { ...base, ...state, updated_at_ms: now }));
    } catch (error) {
      report.errors.push({ address: target.address, error: error instanceof Error ? error.message : String(error) });
    }
  }
  // The next run starts just after the last address that had its turn, so a
  // budget-stopped run never re-favours the start of the sorted list.
  if (lastTurn !== null) {
    await deps.db.collection(CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION).doc(PROVEN_OUTBOUND_ROTATION_DOC).set({
      schema_version: ROTATION_SCHEMA, resume_after: lastTurn, updated_at_ms: now,
    });
  }
  report.calls_used = run.calls;
  return report;
}

// =============================================================================
// BOUNDED MODE (after B_F)
// =============================================================================

const MIGRATION_DOC = 'proven_outbound_migration';
const MIGRATION_SCHEMA = 'chain-record-proven-outbound-migration/v1';
const LAG_SCHEMA = 'chain-record-proven-outbound-lag/v1';
export const PROVEN_OUTBOUND_LAG_PREFIX = 'proven_outbound_lag_';
const RANGE_ROTATION_DOC = 'proven_outbound__range_rotation';
const LAG_ROTATION_DOC = 'proven_outbound__lag_rotation';
/** The chain-record scan is LAGGING when its cursor is more than this far behind the finalized
 * head (~5 minutes, one run): this scan then finds proven EOAs' new transactions itself, from the
 * scan's cursor up, so a backlog there never delays them beyond today's latency. */
export const PROVEN_OUTBOUND_LAG_SECONDS = 300;

/** The proven EOA an address is, for this scan: one valid row, proved by EOA signature. */
async function resolveProvenEoa(
  db: Firestore,
  address: string,
): Promise<{ ownerType: ChainRecordOwnerType; provenAtBlock: number; eoa: boolean } | null> {
  const [agentSnap, personSnap] = await Promise.all([
    db.collection(PROVEN_ADDRESSES_COLLECTION).doc(address).get(),
    db.collection(HUMAN_PROVEN_ADDRESSES_COLLECTION).doc(address).get(),
  ]);
  const found: Array<{ ownerType: ChainRecordOwnerType; provenAtBlock: number; eoa: boolean }> = [];
  if (agentSnap.exists) {
    let row = null;
    try {
      row = provenAddressRowForWatchers(address, agentSnap.data());
    } catch {
      return null; // not a valid row now: retried next run, as the full listing skipped it
    }
    if (row) found.push({ ownerType: 'agent', provenAtBlock: row.proven_at_block, eoa: row.proof_method === 'eip191_eoa' });
  }
  if (personSnap.exists) {
    const raw: unknown = personSnap.data();
    if (!isEconomicallyActiveHumanProvenAddress(raw, address)) return null;
    found.push({ ownerType: 'human', provenAtBlock: raw.proven_at_block, eoa: raw.proof_method === 'eip191_eoa' });
  }
  return found.length === 1 ? found[0] : null;
}

/**
 * Once, at the switch: every existing per-address cursor becomes a range ending at B_F - 1, and
 * every proven registry address WITHOUT a cursor (the round-robin never reached it, or its row was
 * invalid when listed) gets a range from its fence to B_F - 1, so no block below B_F is skipped.
 */
async function migrateToRanges(run: NonceRun, fullBlockSince: number): Promise<void> {
  const db = run.deps.db;
  const markerRef = db.collection(CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION).doc(MIGRATION_DOC);
  if ((await markerRef.get()).exists) return;
  const through = fullBlockSince - 1;
  const legacy = await db.collection(CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION).where('schema_version', '==', CURSOR_SCHEMA).get();
  const covered = new Set<string>();
  for (const doc of legacy.docs) {
    const c = doc.data() as Record<string, unknown>;
    if (typeof c.address !== 'string' || !/^0x[0-9a-f]{40}$/.test(c.address)
      || !Number.isSafeInteger(c.next_block) || !(c.nonce === null || Number.isSafeInteger(c.nonce))) {
      throw new Error('chain_record_proven_outbound_cursor_invalid');
    }
    const ownerType: ChainRecordOwnerType = (await db.collection(HUMAN_PROVEN_ADDRESSES_COLLECTION).doc(c.address).get()).exists
      ? 'human' : 'agent';
    covered.add(c.address);
    await doc.ref.set({
      schema_version: PROVEN_OUTBOUND_RANGE_SCHEMA,
      address: c.address,
      owner_type: ownerType,
      next_block: c.next_block,
      nonce: c.nonce,
      through_block: through,
      done: (c.next_block as number) > through,
      updated_at_ms: run.now,
    });
  }
  const registry = await readWatchRegistry(db);
  if (!registry) throw new Error('watch_registry_not_seeded');
  for (const address of watchRegistryAddresses(registry, ['agent_proven', 'human_proven'])) {
    if (covered.has(address)) continue;
    for (const [collection, ownerType] of [
      [PROVEN_ADDRESSES_COLLECTION, 'agent'], [HUMAN_PROVEN_ADDRESSES_COLLECTION, 'human'],
    ] as const) {
      const raw = (await db.collection(collection).doc(address).get()).data() as { proven_at_block?: unknown } | undefined;
      if (!raw || !Number.isSafeInteger(raw.proven_at_block)) continue;
      // Opened even while the row is invalid: each run re-validates it, as the full listing did.
      await openProvenOutboundRange(db, {
        address, ownerType,
        fromBlock: Math.max(raw.proven_at_block as number, PROVEN_OUTBOUND_FLOOR_BLOCK),
        throughBlock: through,
      }, run.now);
    }
  }
  await markerRef.set({ schema_version: MIGRATION_SCHEMA, full_block_since: fullBlockSince, migrated_at_ms: run.now });
}

async function readRotation(db: Firestore, id: string): Promise<string | null> {
  const snap = await db.collection(CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION).doc(id).get();
  const r = snap.exists ? snap.data() as Record<string, unknown> : undefined;
  return r?.schema_version === ROTATION_SCHEMA && typeof r.resume_after === 'string' ? r.resume_after : null;
}

async function writeRotation(db: Firestore, id: string, resumeAfter: string, now: number): Promise<void> {
  await db.collection(CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION).doc(id).set({
    schema_version: ROTATION_SCHEMA, resume_after: resumeAfter, updated_at_ms: now,
  });
}

async function runBoundedProvenOutbound(run: NonceRun, fullBlockSince: number, finalized: number): Promise<void> {
  const { deps, report, now } = run;
  const db = deps.db;
  report.mode = 'bounded';
  await migrateToRanges(run, fullBlockSince);

  // 1. Bounded ranges (below B_F, late entries, held rows): each runs to its own end.
  const open = await db.collection(CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION)
    .where('schema_version', '==', PROVEN_OUTBOUND_RANGE_SCHEMA).where('done', '==', false).get();
  const ranges: ProvenOutboundRange[] = open.docs.map((doc) => parseProvenOutboundRange(doc.id, doc.data() as Record<string, unknown>))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  report.ranges_open = ranges.length;
  const rangeResume = await readRotation(db, RANGE_ROTATION_DOC);
  const rangeOrder = rangeResume === null ? ranges
    : [...ranges.filter((r) => r.id > rangeResume), ...ranges.filter((r) => r.id <= rangeResume)];
  let lastRange: string | null = null;
  for (const range of rangeOrder) {
    if (report.budget_stopped) break;
    const ref = db.collection(CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION).doc(range.id);
    try {
      if (range.next_block > range.through_block) {
        await refreshProvenOutboundRangeCompletion(db, range.id, now);
        continue;
      }
      const eoa = await resolveProvenEoa(db, range.address);
      if (eoa === null) continue; // not a valid single row now: retried next run
      if (!eoa.eoa) {
        // A contract wallet signs nothing itself: the lane mints only what the address signed.
        report.skipped_contract_wallets += 1;
        await ref.set({ done: true, updated_at_ms: now }, { merge: true });
        continue;
      }
      report.watched += 1;
      const ceiling = Math.min(finalized, range.through_block);
      const start = Math.max(range.next_block, eoa.provenAtBlock);
      const state: NonceState = start === range.next_block ? range : { next_block: start, nonce: null };
      if (state.next_block > ceiling) continue; // not final yet
      if (run.calls + 2 > run.maxCalls) {
        report.budget_stopped = true;
        break;
      }
      lastRange = range.id;
      const reached = await advanceNonceCursor(run, range.address, eoa.ownerType, state, ceiling,
        async (next) => { await ref.set({ next_block: next.next_block, nonce: next.nonce, updated_at_ms: now }, { merge: true }); });
      if (reached && ceiling === range.through_block) await refreshProvenOutboundRangeCompletion(db, range.id, now);
    } catch (error) {
      report.errors.push({ address: range.address, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (lastRange !== null) await writeRotation(db, RANGE_ROTATION_DOC, lastRange, now);

  // 2. While the chain-record scan lags, cover from its cursor up to the finalized head.
  const checkpoint = (await db.collection(CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION)
    .doc(CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID).get()).data() as { next_block?: unknown } | undefined;
  const scanNext = Number.isSafeInteger(checkpoint?.next_block) ? checkpoint!.next_block as number : fullBlockSince;
  if (report.budget_stopped || finalized <= scanNext - 1) return;
  if (!deps.getBlockTimestampMs) throw new Error('proven_outbound_lag_time_unavailable');
  const [headTime, cursorTime] = await Promise.all([
    deps.getBlockTimestampMs(finalized), deps.getBlockTimestampMs(Math.max(0, scanNext - 1)),
  ]);
  if (!Number.isSafeInteger(headTime) || !Number.isSafeInteger(cursorTime) || cursorTime > headTime) throw new Error('proven_outbound_lag_time_invalid');
  if (headTime - cursorTime <= PROVEN_OUTBOUND_LAG_SECONDS * 1000) return;
  report.lagging = true;
  const registry = await readWatchRegistry(db);
  if (!registry) throw new Error('watch_registry_not_seeded');
  const signers = watchRegistryAddresses(registry, ['agent_proven', 'human_proven']);
  const lagResume = await readRotation(db, LAG_ROTATION_DOC);
  let lastLag: string | null = null;
  for (const address of rotateFrom(signers.map((a) => ({ address: a })), lagResume)) {
    if (report.budget_stopped) break;
    try {
      const eoa = await resolveProvenEoa(db, address.address);
      if (eoa === null) continue;
      if (!eoa.eoa) {
        report.skipped_contract_wallets += 1;
        continue;
      }
      report.watched += 1;
      const ref = db.collection(CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION).doc(`${PROVEN_OUTBOUND_LAG_PREFIX}${address.address}`);
      const raw = (await ref.get()).data() as Record<string, unknown> | undefined;
      const floor = Math.max(scanNext, eoa.provenAtBlock, PROVEN_OUTBOUND_FLOOR_BLOCK, fullBlockSince);
      let state: NonceState = raw?.schema_version === LAG_SCHEMA && Number.isSafeInteger(raw.next_block)
        && (raw.nonce === null || Number.isSafeInteger(raw.nonce))
        ? { next_block: raw.next_block as number, nonce: raw.nonce as number | null }
        : { next_block: floor, nonce: null };
      // Below the scan's cursor the full blocks have it: restart there.
      if (state.next_block < floor) state = { next_block: floor, nonce: null };
      if (state.next_block > finalized) continue;
      if (run.calls + 2 > run.maxCalls) {
        report.budget_stopped = true;
        break;
      }
      lastLag = address.address;
      await advanceNonceCursor(run, address.address, eoa.ownerType, state, finalized,
        async (next) => { await ref.set({ schema_version: LAG_SCHEMA, address: address.address, ...next, updated_at_ms: now }); });
    } catch (error) {
      report.errors.push({ address: address.address, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (lastLag !== null) await writeRotation(db, LAG_ROTATION_DOC, lastLag, now);
}

/** Production deps: quorum-2 Base reads; the two proven registries (valid rows only —
 * a row that does not validate is set aside and surfaced by the inbound scan). */
export function buildChainRecordProvenOutboundScanDeps(db: Firestore): ProvenOutboundScanDeps {
  return {
    db,
    useRegistry: true,
    getHead: () => withRateLimitRetry(() => readAgreedBaseHead()),
    getBlockTimestampMs: height => withRateLimitRetry(() => readAgreedBaseBlockTimestampMs(height)),
    getNonce: (address, blockNumber) => withRateLimitRetry(() => readAgreedBaseNonce(address, blockNumber)),
    getTransactionByNonce: (address, nonce, blockNumber) =>
      withRateLimitRetry(() => readAgreedBaseTransactionByNonce(address, nonce, blockNumber)),
    listProven: async () => {
      const [agentProven, personProven] = await Promise.all([
        db.collection(PROVEN_ADDRESSES_COLLECTION).get(),
        db.collection(HUMAN_PROVEN_ADDRESSES_COLLECTION).get(),
      ]);
      const out: ProvenOutboundAddress[] = [];
      for (const doc of agentProven.docs) {
        const raw: unknown = doc.data();
        if ((raw as { schema_version?: unknown } | undefined)?.schema_version !== PROVEN_ADDRESS_SCHEMA) continue;
        if (!isEconomicallyActiveProvenAddress(raw, doc.id)) continue;
        out.push({ address: raw.address, ownerType: 'agent', provenAtBlock: raw.proven_at_block, proofMethod: raw.proof_method });
      }
      for (const doc of personProven.docs) {
        const raw: unknown = doc.data();
        if (!isEconomicallyActiveHumanProvenAddress(raw, doc.id)) continue;
        out.push({ address: raw.address, ownerType: 'human', provenAtBlock: raw.proven_at_block, proofMethod: raw.proof_method });
      }
      return out;
    },
  };
}
