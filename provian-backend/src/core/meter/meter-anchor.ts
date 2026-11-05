import { singleScanQuery } from '../provenance/private-store';
/**
 * PE METER — the daily on-chain anchor over every accepted batch, and each device's proof.
 *
 * One `PEAnchor.anchorBatch` per closed UTC day, over the day's batch leaves in a fixed order
 * (`accepted_at_ms`, then `batch_hash`). The on-chain leaf rule is the PE anchor's own —
 * `keccak256(0x00 ‖ leaf32)` with sorted-pair `0x01` internal nodes — where `leaf32` is the
 * batch's `batch_leaf` (which commits to the device, the actor, the sequence number, the batch
 * hash and the root of its acts). So `POST /v1/pe/verify` verifies a batch leaf exactly as it
 * verified an envelope hash, and an act is proven by two hops: its act leaf to `acts_root` (the
 * device holds its acts and builds that path itself, `merkleProofOf`), then the batch leaf to
 * the day root anchored on Base.
 *
 * The anchor is the PE anchor contract already deployed — no contract change. The batch id is
 * derived like the daily PE anchor's, in its own `meter` kind, so the two can never collide.
 *
 * After anchoring, each batch record carries its proof for 30 days, for its device to fetch
 * (`GET /v1/meter/proofs`) and keep with its PEs; Firestore's TTL then drops the record.
 */

import { ethers } from 'ethers';
import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { buildMerkleTreeFromLeafHashes, generateProof, hashEnvelopeHashLeaf } from '../pvt/merkle';
import { utcDayBounds, utcDayKeyFromMs, utcDayNumber } from '../pvt/daily-pe-anchor';
import { expireAt, METER_ANCHOR_DAYS_COLLECTION, METER_BATCHES_COLLECTION } from './meter-store';
import { METER_ANCHOR_STATE_DOC, meterAnchorBatchIdPreimage } from './meter-constants';

/** A day is anchored only once it has been closed this long (relay clocks across instances). */
export const METER_ANCHOR_CLOSE_MARGIN_MS = 10 * 60_000;
/** How long an anchored batch record (and its proof) stays for its device to fetch. */
export const METER_ANCHORED_BATCH_LIFETIME_MS = 30 * 24 * 3_600_000;
/** One day's leaves are built in memory; past this the run refuses loudly rather than OOM. */
export const METER_ANCHOR_MAX_LEAVES = 1_000_000;
const STALE_PENDING_MS = 2 * 60_000;
const STATE_DOC = METER_ANCHOR_STATE_DOC;

export { meterAnchorBatchIdPreimage } from './meter-constants';

export function meterAnchorBatchId(dayKey: string, segment?: number): string {
  utcDayBounds(dayKey);
  return ethers.keccak256(ethers.concat(['0xff', ethers.toUtf8Bytes(meterAnchorBatchIdPreimage(dayKey, segment))]));
}

export interface MeterAnchorProof {
  readonly day: string;
  readonly anchor_batch_id: string;
  /** Present when the batch was anchored in an intra-day SEGMENT (`<day>:<n>`), absent for the day's close anchor. */
  readonly segment?: number;
  readonly leaf_index: number;
  readonly leaf_count: number;
  /** keccak(0x00 ‖ batch_leaf) — the on-chain leaf. */
  readonly leaf_hash: string;
  readonly proof: readonly string[];
  readonly merkle_root: string;
  readonly anchor_tx_hash: string | null;
  readonly anchored_at_ms: number;
}

export type MeterAnchorDayStatus =
  | 'anchored'
  | 'already_anchored'
  | 'empty'
  | 'day_not_closed'
  | 'in_flight'
  | 'root_mismatch'
  | 'day_too_large';

export interface MeterAnchorDayResult {
  readonly day: string;
  readonly status: MeterAnchorDayStatus;
  readonly batch_count: number;
  readonly merkle_root: string | null;
  readonly anchor_tx_hash: string | null;
  readonly proofs_written: number;
  readonly purged_members?: number;
  readonly detail?: string;
}

export interface MeterAnchorDeps {
  readonly db: Firestore;
  readonly peAnchorContract: ethers.Contract;
  readonly now?: () => number;
}

export const METER_PURGED_BATCHES_COLLECTION = 'meter_purged_batches_v1';

interface DayLeaf {
  readonly batch_hash: string;
  readonly batch_leaf: string;
}

/**
 * The day's batch leaves this anchor commits: every batch of the day that is not yet anchored, plus
 * the ones already anchored under `keepAnchoredIn` (the repair path re-derives the same tree). A
 * batch anchored in another segment of the day is excluded — it has its proof, and anchoring it
 * twice would put the same leaf under two roots.
 */
async function collectDay(db: Firestore, dayKey: string, keepAnchoredIn: string | null): Promise<DayLeaf[]> {
  const out: DayLeaf[] = [];
  let cursor: [number, string] | null = null;
  const source = singleScanQuery(db.collection(METER_BATCHES_COLLECTION)
    .where('day', '==', dayKey).orderBy('accepted_at_ms', 'asc').orderBy('batch_hash', 'asc')
    .select('batch_leaf', 'accepted_at_ms', 'batch_hash', 'anchored', 'anchor.anchor_batch_id'));
  for (;;) {
    let query = source
      // Only what the tree needs: a batch record also carries its act leaves (up to ~33 KB,
      // PE export), which the day's anchor never reads.
      .select('batch_leaf', 'accepted_at_ms', 'batch_hash', 'anchored', 'anchor.anchor_batch_id')
      .limit(1000);
    if (cursor !== null) query = query.startAfter(cursor[0], cursor[1]);
    const snap = await query.get();
    for (const doc of snap.docs) {
      const d = doc.data();
      cursor = [d.accepted_at_ms as number, doc.id];
      const anchoredIn = d.anchored === true ? ((d.anchor as { anchor_batch_id?: unknown } | undefined)?.anchor_batch_id ?? null) : null;
      if (anchoredIn !== null && anchoredIn !== keepAnchoredIn) continue;
      if (typeof d.batch_leaf !== 'string' || !/^[0-9a-f]{64}$/.test(d.batch_leaf)) {
        throw new Error(`meter_anchor_batch_leaf_invalid:${doc.id}`);
      }
      out.push({ batch_hash: doc.id, batch_leaf: d.batch_leaf });
      if (out.length > METER_ANCHOR_MAX_LEAVES) return out;
    }
    if (snap.docs.length < 1000) break;
  }
  return out;
}

async function readOnChainRoot(contract: ethers.Contract, batchId: string, blockNumber?: number): Promise<string | null> {
  const batch = blockNumber === undefined
    ? await contract.getBatch(batchId)
    : await contract.getBatch(batchId, { blockTag: blockNumber });
  if (typeof batch === 'object' && batch !== null) {
    if ('exists' in batch && !Array.isArray(batch)) {
      const b = batch as { exists: unknown; merkleRoot?: unknown };
      return b.exists ? String(b.merkleRoot) : null;
    }
    if (Array.isArray(batch) && batch.length >= 5) return batch[4] ? String(batch[0]) : null;
  }
  return null;
}

async function writeProofs(
  db: Firestore,
  dayKey: string,
  batchId: string,
  leaves: readonly DayLeaf[],
  tree: ReturnType<typeof buildMerkleTreeFromLeafHashes>,
  txHash: string | null,
  nowMs: number,
  segment?: number,
): Promise<{ written: number; purged: number; retained: readonly DayLeaf[] }> {
  // Missing data is never inferred to be a purge. An operator must supply an exact,
  // evidence-bound deletion receipt; the frozen selection remains the tree source.
  const present: { leaf: DayLeaf; index: number }[] = [];
  let purged = 0;
  for (let index = 0; index < leaves.length; index++) {
    const leaf = leaves[index];
    const batch = await db.collection(METER_BATCHES_COLLECTION).doc(leaf.batch_hash).get();
    if (batch.exists) { present.push({ leaf, index }); continue; }
    const receipt = (await db.collection(METER_PURGED_BATCHES_COLLECTION).doc(leaf.batch_hash).get()).data();
    if (receipt?.batch_hash !== leaf.batch_hash || receipt.batch_leaf !== leaf.batch_leaf
      || receipt.day !== dayKey || receipt.anchor_batch_id !== batchId
      || typeof receipt.evidence_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.evidence_sha256)
      || typeof receipt.purged_at_ms !== 'number' || !Number.isFinite(receipt.purged_at_ms)
      || receipt.reason !== 'verified_operator_purge') {
      throw new Error(`meter_anchor_missing_batch_without_purge_receipt:${leaf.batch_hash}`);
    }
    // This is an accounting record, never a replacement owner batch or PE.
    await db.collection(METER_ANCHOR_DAYS_COLLECTION).doc(dayKey).collection('purged_members').doc(leaf.batch_hash).set({
      ...receipt, leaf_index: index, leaf_count: leaves.length, leaf_hash: tree.leaves[index],
      proof: generateProof(tree, index).proof, merkle_root: tree.root, anchor_tx_hash: txHash,
    });
    purged++;
  }
  const writer = db.bulkWriter();
  const writes = present.map(({ leaf, index }) => {
    const proof: MeterAnchorProof = {
      day: dayKey,
      anchor_batch_id: batchId,
      ...(segment !== undefined ? { segment } : {}),
      leaf_index: index,
      leaf_count: leaves.length,
      leaf_hash: tree.leaves[index],
      proof: generateProof(tree, index).proof,
      merkle_root: tree.root,
      anchor_tx_hash: txHash,
      anchored_at_ms: nowMs,
    };
    return writer.update(db.collection(METER_BATCHES_COLLECTION).doc(leaf.batch_hash), {
      anchored: true,
      anchor: proof,
      // A partially written selection must remain repairable even after a long outage.
      // Only the completed selection below starts the proof retention clock.
      expire_at: null,
    });
  });
  const results = await Promise.allSettled([...writes, writer.close()]);
  const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failure) throw failure.reason;
  return { written: present.length, purged, retained: present.map(p => p.leaf) };
}

interface AnchorSelection {
  readonly id: string;
  readonly segment: number | null;
  readonly root: string;
  readonly count: number;
  readonly pages: number;
  readonly timestamp: number;
  readonly tx_hash: string | null;
}

/**
 * One day-wide transactional lease serializes both segment selection and close selection.
 * The immutable paged selection is committed BEFORE broadcast. A stale lease may be acquired
 * again, but its committed selection is never replaced, regardless of new arrivals/writebacks.
 * Pending selections have no TTL: recovery cannot lose its only record of what was broadcast.
 */
async function anchorSelection(deps: MeterAnchorDeps, dayKey: string, close: boolean): Promise<MeterAnchorDayResult & { segment: number | null }> {
  const { db, peAnchorContract } = deps;
  const nowMs = (deps.now ?? Date.now)();
  const dayRef = db.collection(METER_ANCHOR_DAYS_COLLECTION).doc(dayKey);
  const token = randomUUID();
  const base = { day: dayKey, segment: null, batch_count: 0, merkle_root: null, anchor_tx_hash: null, proofs_written: 0 };
  const acquired = await db.runTransaction(async (txn) => {
    const data = (await txn.get(dayRef)).data() ?? {};
    if (typeof data.lease_at_ms === 'number' && nowMs - data.lease_at_ms < STALE_PENDING_MS) return null;
    txn.set(dayRef, { day: dayKey, lease_token: token, lease_at_ms: nowMs, expire_at: null }, { merge: true });
    return data;
  });
  const inFlight = (reason: string): MeterAnchorDayResult & { segment: number | null } => {
    console.warn('[meter-anchor] in_flight', JSON.stringify({day:dayKey, reason}));
    return {...base, status:'in_flight', detail:reason};
  };
  if (acquired === null) return inFlight('day_lease_held');
  try {
  let selection = acquired.selection as AnchorSelection | undefined;
  let leaves: DayLeaf[] = [];
  const pagesRef = dayRef.collection('selections');
  // A process may die while staging pages, before the selection commit. Once its
  // lease is stale, those pages are unreachable and cannot be broadcast by that worker.
  const retainedSelectionIds = Array.isArray(acquired.retained_selection_ids) ? acquired.retained_selection_ids.filter((id): id is string => typeof id === 'string') : [];
  const orphans = await pagesRef.where('created_at_ms', '<', nowMs - STALE_PENDING_MS).get();
  await Promise.allSettled(orphans.docs.filter(doc => (!selection || !doc.id.startsWith(`${selection.id}_`)) && !retainedSelectionIds.some(id => doc.id.startsWith(`${id}_`))).map(doc => doc.ref.delete()));
  if (selection) {
    for (let page = 0; page < selection.pages; page++) {
      const data = (await pagesRef.doc(`${selection.id}_${page}`).get()).data();
      if (!data || !Array.isArray(data.leaves)) throw new Error('meter_anchor_selection_missing');
      leaves.push(...data.leaves as DayLeaf[]);
    }
    if (leaves.length !== selection.count) throw new Error('meter_anchor_selection_count_mismatch');
  } else {
    const segment = close ? null : (typeof acquired.segments === 'number' ? acquired.segments : 0) + 1;
    const batchId = meterAnchorBatchId(dayKey, segment ?? undefined);
    leaves = await collectDay(db, dayKey, batchId);
    if (leaves.length > METER_ANCHOR_MAX_LEAVES || leaves.length === 0) {
      await db.runTransaction(async (txn) => {
        const data = (await txn.get(dayRef)).data();
        if (data?.lease_token === token) txn.set(dayRef, { lease_at_ms: null, lease_token: null, expire_at: expireAt(nowMs + METER_ANCHORED_BATCH_LIFETIME_MS), ...(close && leaves.length === 0 ? { status: 'empty' } : {}) }, { merge: true });
      });
      return { ...base, status: leaves.length === 0 ? 'empty' : 'day_too_large' };
    }
    const tree = buildMerkleTreeFromLeafHashes(leaves.map((l) => hashEnvelopeHashLeaf(l.batch_leaf)));
    selection = { id: token, segment, root: tree.root, count: leaves.length, pages: Math.ceil(leaves.length / 1000), timestamp: close ? utcDayBounds(dayKey).endMs : nowMs, tx_hash: null };
    for (let page = 0; page < selection.pages; page++) {
      await pagesRef.doc(`${selection.id}_${page}`).create({ created_at_ms: nowMs, leaves: leaves.slice(page * 1000, (page + 1) * 1000) });
    }
    const frozen = selection;
    const committed = await db.runTransaction(async (txn) => {
      const data = (await txn.get(dayRef)).data();
      if (data?.lease_token !== token) return false;
      txn.set(dayRef, { selection: frozen }, { merge: true });
      return true;
    });
    if (!committed) return inFlight('selection_commit_lease_lost');
  }
  const tree = buildMerkleTreeFromLeafHashes(leaves.map((l) => hashEnvelopeHashLeaf(l.batch_leaf)));
  if (tree.root !== selection.root) throw new Error('meter_anchor_selection_corrupt');
  const batchId = meterAnchorBatchId(dayKey, selection.segment ?? undefined);
  let txHash = selection.tx_hash;
  let latestReadFailed = false;
  let onChain = await readOnChainRoot(peAnchorContract, batchId).catch(() => { latestReadFailed = true; return null; });
  const wasAnchored = onChain !== null;
  const confirmedSelection = selection;
  const awaitingConfirmation = async (reason: string) => {
    // This worker has stopped before proof writeback. Let the next call repair the SAME selection
    // immediately; retain the frozen population and broadcast hash until confirmation is visible.
    await db.runTransaction(async (txn) => {
      const held = (await txn.get(dayRef)).data();
      if (held?.lease_token === token && (held?.selection as AnchorSelection | undefined)?.id === confirmedSelection.id) {
        txn.update(dayRef, { lease_at_ms: null, lease_token: null });
      }
    });
    console.warn('[meter-anchor] in_flight', JSON.stringify({day:dayKey, reason, batch_count:leaves.length, anchor_tx_hash:txHash, merkle_root:tree.root}));
    return { ...base, status: 'in_flight' as const, detail:reason, segment: confirmedSelection.segment, batch_count: leaves.length, merkle_root: tree.root, anchor_tx_hash: txHash };
  };
  // An RPC's `latest` view can lag the transaction receipt. A known broadcast must be inspected
  // before retrying it, and a mined transaction is read at its receipt block, not a cached head.
  const provider = peAnchorContract.runner?.provider;
  if (onChain === null && selection.tx_hash) {
    if (!provider) return awaitingConfirmation('receipt_provider_unavailable');
    let receiptReadFailed = false;
    const receipt = await provider.getTransactionReceipt(selection.tx_hash).catch(() => { receiptReadFailed = true; return null; });
    if (receipt === null) return awaitingConfirmation(receiptReadFailed ? 'receipt_read_failed' : 'receipt_not_visible');
    if (receipt.status === 1) {
      onChain = await readOnChainRoot(peAnchorContract, batchId, receipt.blockNumber).catch(() => null);
      if (onChain === null) return awaitingConfirmation('confirmed_root_not_readable');
    }
    else if (receipt.status !== 0) return awaitingConfirmation('receipt_status_unknown');
  }
  if (latestReadFailed && onChain === null) return awaitingConfirmation('latest_root_read_failed');
  if (onChain === null) {
    let receiptBlock: number | undefined;
    try {
      const tx = await peAnchorContract.anchorBatch(batchId, tree.root, leaves.length, selection.timestamp, utcDayNumber(dayKey));
      txHash = tx.hash ?? null;
      // Save the broadcast hash before waiting. If we die earlier, getBatch still recovers the
      // exact selection. Contract BatchAlreadyAnchored is the final concurrent/retry fence.
      const broadcastHash = txHash;
      await db.runTransaction(async (txn) => {
        const held = (await txn.get(dayRef)).data();
        if ((held?.selection as AnchorSelection | undefined)?.id === selection.id) {
          txn.update(dayRef, { 'selection.tx_hash': broadcastHash });
        }
      });
      const receipt = await tx.wait();
      txHash = receipt?.hash ?? txHash;
      receiptBlock = receipt?.blockNumber;
    } catch (err) {
      onChain = await readOnChainRoot(peAnchorContract, batchId).catch(() => null);
      if (onChain === null) throw err; // uncertain broadcast retains selection and lease
    }
    onChain = await readOnChainRoot(peAnchorContract, batchId, receiptBlock).catch(() => null);
  }
  if (onChain === null) return awaitingConfirmation('post_broadcast_root_not_readable');
  if (onChain.toLowerCase() !== tree.root.toLowerCase()) {
    // This is an integrity failure, never a retry computed over a different population.
    return { ...base, status: 'root_mismatch', segment: selection.segment, batch_count: leaves.length, merkle_root: tree.root };
  }
  const written = await writeProofs(db, dayKey, batchId, leaves, tree, txHash, nowMs, selection.segment ?? undefined);
  const completed = await db.runTransaction(async (txn) => {
    const data = (await txn.get(dayRef)).data();
    if (data?.lease_token !== token || (data?.selection as AnchorSelection | undefined)?.id !== selection.id) return false;
    txn.set(dayRef, {
      selection: null, lease_at_ms: null, lease_token: null, updated_at_ms: nowMs,
      ...(written.purged > 0 ? { retained_selection_ids: [...new Set([...retainedSelectionIds, selection.id])] } : {}),
      expire_at: expireAt(nowMs + METER_ANCHORED_BATCH_LIFETIME_MS),
      ...(selection.segment === null
        ? { status: 'anchored', proofs_complete: true, purged_members: written.purged, proofs_written: written.written, completed_selection: written.purged > 0 ? selection : null, anchor_tx_hash: txHash, merkle_root: tree.root, batch_count: leaves.length }
        : { segments: selection.segment, segment_pending_at_ms: null, [`segment_${selection.segment}`]: { anchor_batch_id: batchId, merkle_root: tree.root, batch_count: leaves.length, anchor_tx_hash: txHash, anchored_at_ms: nowMs } }),
    }, { merge: true });
    return true;
  });
  if (!completed) return inFlight('proof_completion_lease_lost');
  for (const leaf of written.retained) await db.runTransaction(async txn => {
    const ref = db.collection(METER_BATCHES_COLLECTION).doc(leaf.batch_hash);
    const batch = (await txn.get(ref)).data();
    if (!batch) return;
    const waiting = batch.per_batch_pricing === true
      ? await txn.get(db.collection('pe_mailbox_v1').where('batch_hash', '==', leaf.batch_hash).limit(1)) : null;
    const keep = batch.per_batch_pricing === true && (batch.settlement_complete !== true || !waiting?.empty);
    txn.update(ref, { expire_at: keep ? null : expireAt(nowMs + METER_ANCHORED_BATCH_LIFETIME_MS) });
  });
  // Completion is durable before cleanup. A cleanup failure leaves only anonymous leaf metadata;
  // it cannot remove a selection another process is still required to repair.
  if (written.purged === 0) await Promise.allSettled(Array.from({ length: selection.pages }, (_, page) => pagesRef.doc(`${selection.id}_${page}`).delete()));
  if (!completed) return inFlight('proof_completion_lease_lost');
  return { day: dayKey, status: wasAnchored ? 'already_anchored' : 'anchored', segment: selection.segment, batch_count: leaves.length, merkle_root: tree.root, anchor_tx_hash: txHash, proofs_written: written.written, purged_members: written.purged };
  } finally {
    // A failed chain read or proof write must not hold recovery hostage until a stale lease.
    // Token comparison prevents an older worker from releasing a successor's lease.
    await db.runTransaction(async txn => {
      const held = (await txn.get(dayRef)).data();
      if (held?.lease_token === token) txn.update(dayRef,{lease_at_ms:null,lease_token:null});
    });
  }
}

/** Repair any outstanding segment BEFORE selecting the closed day's remaining batches. */
export async function anchorMeterDay(deps: MeterAnchorDeps, dayKey: string): Promise<MeterAnchorDayResult> {
  const nowMs = (deps.now ?? Date.now)();
  const base = { day: dayKey, batch_count: 0, merkle_root: null, anchor_tx_hash: null, proofs_written: 0 };
  if (utcDayBounds(dayKey).endMs + METER_ANCHOR_CLOSE_MARGIN_MS > nowMs) return { ...base, status: 'day_not_closed' };
  const held = (await deps.db.collection(METER_ANCHOR_DAYS_COLLECTION).doc(dayKey).get()).data();
  if (held?.status === 'anchored' && held.proofs_complete === true && !held.selection) {
    return { ...base, status: 'already_anchored', batch_count: Number(held.batch_count ?? 0), merkle_root: typeof held.merkle_root === 'string' ? held.merkle_root : null, anchor_tx_hash: typeof held.anchor_tx_hash === 'string' ? held.anchor_tx_hash : null };
  }
  let result = await anchorSelection(deps, dayKey, true);
  if (result.segment !== null && (result.status === 'anchored' || result.status === 'already_anchored')) result = await anchorSelection(deps, dayKey, true);
  return result;
}

export type MeterAnchorSegmentStatus = 'anchored' | 'empty' | 'in_flight' | 'root_mismatch' | 'day_too_large';

export interface MeterAnchorSegmentResult {
  readonly day: string;
  readonly segment: number | null;
  readonly status: MeterAnchorSegmentStatus;
  readonly anchor_batch_id: string | null;
  readonly batch_count: number;
  readonly merkle_root: string | null;
  readonly anchor_tx_hash: string | null;
  readonly proofs_written: number;
  readonly purged_members?: number;
  readonly detail?: string;
}

/**
 * Anchor the OPEN day's accepted-but-unanchored batches NOW, as the day's next segment (the operator,
 * 2026-10-10: a PE sealed today must be presentable today). The segment's batch id is
 * keccak(0xff ‖ "<namespace>:meter:<day>:<n>"); each batch's proof carries `segment: n`, and the
 * day's close (`anchorMeterDay`) commits only the batches no segment took. Operator-run
 * (`POST /v1/internal/scheduler/meter-anchor-now`); never scheduled. Idempotent per segment: a
 * segment whose id is already on chain with the same root only repairs its proof writebacks.
 */
export async function anchorMeterSegment(deps: MeterAnchorDeps): Promise<MeterAnchorSegmentResult> {
  const day = utcDayKeyFromMs((deps.now ?? Date.now)());
  const result = await anchorSelection(deps, day, false);
  return { ...result, status: result.status === 'already_anchored' ? 'anchored' : result.status as MeterAnchorSegmentStatus, anchor_batch_id: result.segment === null ? null : meterAnchorBatchId(day, result.segment) };
}

/**
 * Anchor every closed day since the last anchored one (bounded per run). The first run starts at
 * the day of the oldest batch record.
 */
export async function runDailyMeterAnchor(
  deps: MeterAnchorDeps,
  options: { readonly maxDays?: number } = {},
): Promise<{ readonly processed: readonly MeterAnchorDayResult[]; readonly watermark: string | null; readonly complete: boolean }> {
  const { db } = deps;
  const nowMs = (deps.now ?? Date.now)();
  const maxDays = options.maxDays ?? 7;
  const stateRef = db.collection(METER_ANCHOR_DAYS_COLLECTION).doc(STATE_DOC);
  const state = (await stateRef.get()).data() ?? {};
  let next: string | null = null;
  if (typeof state.last_anchored_day === 'string') {
    next = utcDayKeyFromMs(utcDayBounds(state.last_anchored_day).endMs);
  } else {
    const oldest = await db.collection(METER_BATCHES_COLLECTION).orderBy('accepted_at_ms', 'asc').limit(1).get();
    const first = oldest.docs[0]?.data();
    next = typeof first?.day === 'string' ? first.day : null;
  }
  const processed: MeterAnchorDayResult[] = [];
  let watermark: string | null = typeof state.last_anchored_day === 'string' ? state.last_anchored_day : null;
  while (next !== null && processed.length < maxDays) {
    const result = await anchorMeterDay(deps, next);
    processed.push(result);
    if (result.status !== 'anchored' && result.status !== 'already_anchored' && result.status !== 'empty') break;
    watermark = next;
    await stateRef.set({ last_anchored_day: next, updated_at_ms: nowMs }, { merge: true });
    next = utcDayKeyFromMs(utcDayBounds(next).endMs);
  }
  // An open day is normal; any remaining CLOSED day (including a bounded backlog) needs retry.
  const complete = next === null || utcDayBounds(next).endMs + METER_ANCHOR_CLOSE_MARGIN_MS > nowMs;
  return { processed, watermark, complete };
}
