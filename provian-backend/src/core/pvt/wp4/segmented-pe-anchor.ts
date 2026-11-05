/**
 * settlement runtime — segmented daily PE anchoring (plan §settlement runtime item 7): chunked daily roots
 * above 5,000 PEs with deterministic ordering, per-segment and aggregate
 * reconciliation, proofs across segments, and no one-document/1-MB
 * dependency.
 *
 * Relationship to the legacy module: `daily-pe-anchor.ts` (linked-job settlement
 * anchor-everything) anchors ONE root per day with a hard
 * `MAX_MEMBERS_PER_BATCH = 5_000` refusal ("day_too_large") because its
 * batch doc stores the whole ordered membership in one document. That module
 * stays untouched (dark behind the runtime boundary 503 scheduler stubs, and the plan
 * explicitly says the single daily-root document is not an accepted
 * substitute). This module is the settlement runtime-accepted shape: the same leaf rule and
 * normative ordering, but the day is PARTITIONED into fixed-size segments,
 * each a bounded Firestore document with its own Merkle root and its own
 * on-chain anchor, plus a day-level AGGREGATE root over the ordered segment
 * roots — so a 25k+ day needs ~10 bounded docs, never a 1 MB one.
 *
 * Namespace discipline: batch ids are keccak256(0xFF || utf8(preimage)) in a
 * fresh v2 namespace, disjoint from mint batches (0xFF never appears in
 * valid UTF-8) AND from the legacy v1 daily ids (different namespace
 * string). The segment count is bound INTO every id, so two different
 * partitions of the same day can never collide.
 *
 * AUTHORITY BOUNDARY — pure module + injected chain adapter. NOT mounted on
 * any route or scheduler; never touches PVT; never modifies sealed PE
 * content (writebacks add the same two additive anchor-metadata fields the
 * legacy module does). activation owns wiring, scheduling and any production
 * anchor keeper.
 *
 * Leaf rules (identical to linked-job settlement so verifiers need only one rule):
 * member leaf = keccak256(0x00 || bytes32(envelope_sha256))
 * aggregate leaf = keccak256(0x00 || bytes32(segment_root))
 * Ordering: members (timestamp asc, envelope_id asc); a member's position in
 * the DAY ordering is its `global_index`; segment k covers global indexes
 * [k * SEGMENT_MAX_MEMBERS,...) — a fixed-size deterministic partition.
 */

import { ethers } from 'ethers';
import {
  buildMerkleTreeFromLeafHashes,
  generateProof,
  hashEnvelopeHashLeaf,
  verifyMerkleProof,
} from '../merkle';

export const SEGMENTED_PE_ANCHOR_NAMESPACE = 'provian:daily-pe-anchor:v2';

export const ANCHOR_SEGMENTS_COLLECTION = 'pe_daily_anchor_segments_v1';
export const ANCHOR_DAYS_COLLECTION = 'pe_daily_anchor_days_v1';

export const ANCHOR_SEGMENT_SCHEMA = 'pe-daily-anchor-segment/v1';
export const ANCHOR_DAY_SCHEMA = 'pe-daily-anchor-day/v1';

/**
 * Fixed segment size. 2,500 members × ~120 bytes ≈ 300 KB per segment doc —
 * comfortably bounded, and a >5,000-PE day becomes ≥3 segments (the plan's
 * threshold case). The partition is deterministic for a given member set.
 */
export const SEGMENT_MAX_MEMBERS = 2_500;

export const SEGMENT_LEAF_RULE =
  'keccak256(0x00 || bytes32(envelope_sha256)) — identical to the linked-job settlement daily anchor leaf rule';
export const AGGREGATE_LEAF_RULE =
  'keccak256(0x00 || bytes32(segment_root)) over segment roots in segment-index order';
export const SEGMENT_LEAF_ORDERING = 'timestamp asc, then envelope_id asc (global across the day)';

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Narrow interfaces
// ---------------------------------------------------------------------------

export interface SegmentedAnchorDb {
  collection(name: string): {
    doc(id: string): {
      get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
      set(data: Record<string, unknown>, opts?: { merge?: boolean }): Promise<void>;
      create(data: Record<string, unknown>): Promise<void>;
    };
  };
}

/** Read-only probe + single anchoring call; implementations live with callers. */
export interface PEAnchorChainAdapter {
  /** `batches(batchId).exists` — the on-chain idempotency probe. */
  isAnchored(batchId: string): Promise<boolean>;
  /** On-chain root for an anchored batch (null when absent). */
  readRoot(batchId: string): Promise<string | null>;
  /** `anchorBatch(batchId, merkleRoot, peCount, timestamp, epochNumber)`. */
  anchor(args: {
    batchId: string;
    merkleRoot: string;
    peCount: number;
    timestampMs: number;
    epochNumber: number;
  }): Promise<{ txHash: string }>;
}

export interface SegmentMember {
  readonly pe_id: string;
  /** The PE's existing canonical envelope hash (sha256 hex, no 0x). */
  readonly pe_hash: string;
  readonly timestamp: number;
}

export interface AnchorSegmentDoc {
  readonly schema_version: typeof ANCHOR_SEGMENT_SCHEMA;
  readonly namespace: typeof SEGMENTED_PE_ANCHOR_NAMESPACE;
  readonly day: string;
  readonly segment_index: number;
  readonly segment_count: number;
  readonly batch_id: string;
  readonly batch_id_preimage: string;
  /** Global day-order range this segment covers: [start_index, end_index). */
  readonly start_index: number;
  readonly end_index: number;
  readonly pe_count: number;
  readonly merkle_root: string;
  readonly leaf_rule: string;
  readonly leaf_ordering: string;
  readonly members: readonly SegmentMember[];
  readonly status: 'pending' | 'anchored';
  readonly anchor_tx_hash: string | null;
  readonly created_at: number;
  readonly anchored_at: number | null;
}

export interface AnchorDayDoc {
  readonly schema_version: typeof ANCHOR_DAY_SCHEMA;
  readonly namespace: typeof SEGMENTED_PE_ANCHOR_NAMESPACE;
  readonly day: string;
  readonly pe_count: number;
  readonly segment_count: number;
  readonly segment_size: number;
  /** Ordered by segment index — the aggregate tree's leaf order. */
  readonly segment_roots: readonly string[];
  readonly segment_batch_ids: readonly string[];
  readonly aggregate_root: string;
  readonly aggregate_batch_id: string;
  readonly aggregate_leaf_rule: string;
  readonly status: 'pending' | 'anchored';
  readonly aggregate_anchor_tx_hash: string | null;
  readonly created_at: number;
  readonly anchored_at: number | null;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

function requireDayKey(dayKey: string): void {
  if (!DAY_KEY_RE.test(dayKey) || Number.isNaN(Date.parse(`${dayKey}T00:00:00.000Z`))) {
    throw new Error(`Invalid UTC day key (need YYYY-MM-DD): ${dayKey}`);
  }
}

export function segmentBatchIdPreimage(dayKey: string, segmentIndex: number, segmentCount: number): string {
  return `${SEGMENTED_PE_ANCHOR_NAMESPACE}:segment:${dayKey}:${segmentIndex}/${segmentCount}`;
}

export function aggregateBatchIdPreimage(dayKey: string, segmentCount: number): string {
  return `${SEGMENTED_PE_ANCHOR_NAMESPACE}:day-aggregate:${dayKey}:${segmentCount}`;
}

/** keccak256(0xFF || utf8(preimage)) — same collision-proofing as the v1 ids. */
function idFromPreimage(preimage: string): string {
  return ethers.keccak256(ethers.concat(['0xff', ethers.toUtf8Bytes(preimage)]));
}

export function computeSegmentBatchId(dayKey: string, segmentIndex: number, segmentCount: number): string {
  requireDayKey(dayKey);
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0 || !Number.isInteger(segmentCount)
    || segmentCount <= 0 || segmentIndex >= segmentCount) {
    throw new Error(`Invalid segment coordinates: ${segmentIndex}/${segmentCount}`);
  }
  return idFromPreimage(segmentBatchIdPreimage(dayKey, segmentIndex, segmentCount));
}

export function computeAggregateBatchId(dayKey: string, segmentCount: number): string {
  requireDayKey(dayKey);
  if (!Number.isInteger(segmentCount) || segmentCount <= 0) {
    throw new Error(`Invalid segment count: ${segmentCount}`);
  }
  return idFromPreimage(aggregateBatchIdPreimage(dayKey, segmentCount));
}

/** Aggregate leaf: same 0x00 leaf-domain tag over the 32-byte segment root. */
export function hashSegmentRootLeaf(segmentRoot: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(segmentRoot)) {
    throw new Error(`Invalid segment root (need 0x-prefixed bytes32): ${segmentRoot}`);
  }
  return ethers.keccak256(ethers.concat(['0x00', segmentRoot]));
}

// ---------------------------------------------------------------------------
// Planning — deterministic partition
// ---------------------------------------------------------------------------

export interface PlannedSegment {
  readonly segment_index: number;
  readonly start_index: number;
  readonly end_index: number;
  readonly members: readonly SegmentMember[];
  readonly merkle_root: string;
  readonly batch_id: string;
}

export interface SegmentedDayPlan {
  readonly day: string;
  readonly pe_count: number;
  readonly segment_count: number;
  readonly segment_size: number;
  readonly segments: readonly PlannedSegment[];
  readonly aggregate_root: string;
  readonly aggregate_batch_id: string;
}

const ENVELOPE_HASH_RE = /^[0-9a-f]{64}$/;

/** Normative day ordering (identical rule to the legacy module). */
export function sortMembers(members: readonly SegmentMember[]): SegmentMember[] {
  return [...members].sort((a, b) =>
    a.timestamp !== b.timestamp
      ? a.timestamp - b.timestamp
      : a.pe_id < b.pe_id ? -1 : a.pe_id > b.pe_id ? 1 : 0);
}

/**
 * Plan a day's segments. Pure and deterministic: the same member set always
 * yields the same partition, the same roots, and the same ids. Members with
 * malformed envelope hashes are REJECTED (a silent drop would read as
 * "anchored" — Unknown = Block). Duplicate PE ids are rejected outright.
 */
export function planSegmentedDay(
  dayKey: string,
  members: readonly SegmentMember[],
  segmentSize: number = SEGMENT_MAX_MEMBERS,
): SegmentedDayPlan {
  requireDayKey(dayKey);
  if (!Number.isInteger(segmentSize) || segmentSize <= 0) {
    throw new Error(`Invalid segment size: ${segmentSize}`);
  }
  if (members.length === 0) throw new Error('planSegmentedDay: empty membership');
  const seen = new Set<string>();
  for (const member of members) {
    if (!ENVELOPE_HASH_RE.test(member.pe_hash)) {
      throw new Error(`planSegmentedDay: malformed envelope hash for ${member.pe_id}`);
    }
    if (seen.has(member.pe_id)) {
      throw new Error(`planSegmentedDay: duplicate pe_id ${member.pe_id}`);
    }
    seen.add(member.pe_id);
  }

  const ordered = sortMembers(members);
  const segmentCount = Math.ceil(ordered.length / segmentSize);
  const segments: PlannedSegment[] = [];
  for (let index = 0; index < segmentCount; index += 1) {
    const start = index * segmentSize;
    const slice = ordered.slice(start, start + segmentSize);
    const leaves = slice.map((member) => hashEnvelopeHashLeaf(member.pe_hash));
    const tree = buildMerkleTreeFromLeafHashes(leaves);
    segments.push({
      segment_index: index,
      start_index: start,
      end_index: start + slice.length,
      members: slice,
      merkle_root: tree.root,
      batch_id: computeSegmentBatchId(dayKey, index, segmentCount),
    });
  }

  const aggregateLeaves = segments.map((segment) => hashSegmentRootLeaf(segment.merkle_root));
  const aggregateTree = buildMerkleTreeFromLeafHashes(aggregateLeaves);

  return {
    day: dayKey,
    pe_count: ordered.length,
    segment_count: segmentCount,
    segment_size: segmentSize,
    segments,
    aggregate_root: aggregateTree.root,
    aggregate_batch_id: computeAggregateBatchId(dayKey, segmentCount),
  };
}

// ---------------------------------------------------------------------------
// Reconciliation — per-segment and aggregate (the extension surface)
// ---------------------------------------------------------------------------

export interface SegmentReconciliationVerdict {
  readonly ok: boolean;
  readonly violations: readonly string[];
}

/**
 * Verify that a stored day doc + its segment docs form one exact partition:
 * contiguous [0, pe_count) ranges in index order with no gap or overlap,
 * counts consistent, every segment root recomputable from its stored
 * members under the normative ordering, and the aggregate root recomputable
 * from the ordered segment roots. Every violation is named; an empty list is
 * the only passing state.
 */
export function reconcileSegmentedDay(
  dayDoc: AnchorDayDoc,
  segmentDocs: readonly AnchorSegmentDoc[],
): SegmentReconciliationVerdict {
  const violations: string[] = [];
  const ordered = [...segmentDocs].sort((a, b) => a.segment_index - b.segment_index);

  if (ordered.length !== dayDoc.segment_count) {
    violations.push(`segment docs ${ordered.length} != day segment_count ${dayDoc.segment_count}`);
  }

  let expectedStart = 0;
  let totalMembers = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const segment = ordered[index];
    const tag = `segment ${segment.segment_index}`;
    if (segment.segment_index !== index) {
      violations.push(`${tag}: index sequence broken (expected ${index})`);
    }
    if (segment.day !== dayDoc.day) violations.push(`${tag}: day ${segment.day} != ${dayDoc.day}`);
    if (segment.segment_count !== dayDoc.segment_count) {
      violations.push(`${tag}: segment_count ${segment.segment_count} != ${dayDoc.segment_count}`);
    }
    if (segment.start_index !== expectedStart) {
      violations.push(`${tag}: start ${segment.start_index} != expected ${expectedStart} (gap or overlap)`);
    }
    if (segment.end_index <= segment.start_index) {
      violations.push(`${tag}: empty or inverted range`);
    }
    if (segment.members.length !== segment.end_index - segment.start_index
      || segment.members.length !== segment.pe_count) {
      violations.push(`${tag}: member count ${segment.members.length} != range/pe_count`);
    }
    const sorted = sortMembers(segment.members);
    const orderOk = segment.members.every((member, i) =>
      member.pe_id === sorted[i].pe_id && member.timestamp === sorted[i].timestamp);
    if (!orderOk) violations.push(`${tag}: members violate the normative ordering`);
    try {
      const rebuilt = buildMerkleTreeFromLeafHashes(
        segment.members.map((member) => hashEnvelopeHashLeaf(member.pe_hash)),
      );
      if (rebuilt.root !== segment.merkle_root) {
        violations.push(`${tag}: rebuilt root ${rebuilt.root} != stored ${segment.merkle_root}`);
      }
    } catch (error) {
      violations.push(`${tag}: unbuildable members (${(error as Error).message})`);
    }
    const expectedId = computeSegmentBatchId(dayDoc.day, segment.segment_index, dayDoc.segment_count);
    if (segment.batch_id !== expectedId) violations.push(`${tag}: batch id drift`);
    if (dayDoc.segment_roots[segment.segment_index] !== segment.merkle_root) {
      violations.push(`${tag}: day doc root entry mismatch`);
    }
    if (dayDoc.segment_batch_ids[segment.segment_index] !== segment.batch_id) {
      violations.push(`${tag}: day doc batch id entry mismatch`);
    }
    expectedStart = segment.end_index;
    totalMembers += segment.members.length;
  }

  if (totalMembers !== dayDoc.pe_count) {
    violations.push(`member total ${totalMembers} != day pe_count ${dayDoc.pe_count}`);
  }
  if (ordered.length > 0 && expectedStart !== dayDoc.pe_count) {
    violations.push(`final range end ${expectedStart} != day pe_count ${dayDoc.pe_count} (partition incomplete)`);
  }
  try {
    const aggregate = buildMerkleTreeFromLeafHashes(
      dayDoc.segment_roots.map((root) => hashSegmentRootLeaf(root)),
    );
    if (aggregate.root !== dayDoc.aggregate_root) {
      violations.push(`rebuilt aggregate root ${aggregate.root} != stored ${dayDoc.aggregate_root}`);
    }
  } catch (error) {
    violations.push(`aggregate unbuildable (${(error as Error).message})`);
  }
  if (dayDoc.aggregate_batch_id !== computeAggregateBatchId(dayDoc.day, dayDoc.segment_count)) {
    violations.push('aggregate batch id drift');
  }

  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// Proofs across segments
// ---------------------------------------------------------------------------

export interface SegmentedInclusionProof {
  readonly pe_id: string;
  readonly global_index: number;
  readonly segment_index: number;
  readonly leaf_index_in_segment: number;
  readonly leaf_value: string;
  /** Sibling path from the member leaf to the SEGMENT root. */
  readonly segment_proof: readonly string[];
  readonly segment_root: string;
  readonly segment_batch_id: string;
  /** Sibling path from hashSegmentRootLeaf(segment_root) to the DAY root. */
  readonly aggregate_proof: readonly string[];
  readonly aggregate_root: string;
  readonly aggregate_batch_id: string;
}

/**
 * Build the two-level inclusion proof for one PE: leaf → segment root →
 * aggregate day root. Verifiable on-chain in two steps against the segment
 * anchor and the aggregate anchor independently (each is its own `verifyPE`
 * call), or off-chain via `verifySegmentedProof`.
 */
export function buildSegmentedProof(
  dayDoc: AnchorDayDoc,
  segmentDoc: AnchorSegmentDoc,
  peId: string,
): SegmentedInclusionProof | null {
  const leafIndex = segmentDoc.members.findIndex((member) => member.pe_id === peId);
  if (leafIndex === -1) return null;

  const leaves = segmentDoc.members.map((member) => hashEnvelopeHashLeaf(member.pe_hash));
  const segmentTree = buildMerkleTreeFromLeafHashes(leaves);
  if (segmentTree.root !== segmentDoc.merkle_root) {
    throw new Error(
      `Segment integrity failure: rebuilt root ${segmentTree.root} != stored ${segmentDoc.merkle_root}`,
    );
  }
  const segmentProof = generateProof(segmentTree, leafIndex);
  if (!verifyMerkleProof(segmentProof.leaf, segmentProof.proof, segmentTree.root)) {
    throw new Error('Generated segment proof failed local verification');
  }

  const aggregateLeaves = dayDoc.segment_roots.map((root) => hashSegmentRootLeaf(root));
  const aggregateTree = buildMerkleTreeFromLeafHashes(aggregateLeaves);
  if (aggregateTree.root !== dayDoc.aggregate_root) {
    throw new Error(
      `Aggregate integrity failure: rebuilt root ${aggregateTree.root} != stored ${dayDoc.aggregate_root}`,
    );
  }
  const aggregateProof = generateProof(aggregateTree, segmentDoc.segment_index);
  if (!verifyMerkleProof(aggregateProof.leaf, aggregateProof.proof, aggregateTree.root)) {
    throw new Error('Generated aggregate proof failed local verification');
  }

  return {
    pe_id: peId,
    global_index: segmentDoc.start_index + leafIndex,
    segment_index: segmentDoc.segment_index,
    leaf_index_in_segment: leafIndex,
    leaf_value: segmentProof.leaf,
    segment_proof: segmentProof.proof,
    segment_root: segmentDoc.merkle_root,
    segment_batch_id: segmentDoc.batch_id,
    aggregate_proof: aggregateProof.proof,
    aggregate_root: dayDoc.aggregate_root,
    aggregate_batch_id: dayDoc.aggregate_batch_id,
  };
}

/** Off-chain verification of both proof levels. */
export function verifySegmentedProof(proof: SegmentedInclusionProof): boolean {
  return verifyMerkleProof(proof.leaf_value, [...proof.segment_proof], proof.segment_root)
    && verifyMerkleProof(
      hashSegmentRootLeaf(proof.segment_root),
      [...proof.aggregate_proof],
      proof.aggregate_root,
    );
}

// ---------------------------------------------------------------------------
// Anchoring — segment docs persisted BEFORE any transaction; idempotent
// ---------------------------------------------------------------------------

export interface SegmentedAnchorDeps {
  readonly db: SegmentedAnchorDb;
  readonly chain: PEAnchorChainAdapter;
  readonly now: () => number;
}

export interface AnchorSegmentedDayResult {
  readonly day: string;
  readonly pe_count: number;
  readonly segment_count: number;
  readonly segments_anchored: number;
  readonly segments_already_anchored: number;
  readonly aggregate_anchored: boolean;
  readonly aggregate_already_anchored: boolean;
  readonly aggregate_root: string;
  readonly segment_tx_hashes: readonly (string | null)[];
  readonly aggregate_tx_hash: string | null;
}

function dayDocId(dayKey: string, segmentCount: number): string {
  return `${dayKey}__${segmentCount}`;
}

function segmentDocId(dayKey: string, segmentIndex: number, segmentCount: number): string {
  return `${dayKey}__${segmentIndex}_${segmentCount}`;
}

/**
 * Anchor a planned day: persist every segment doc and the day doc FIRST (an
 * anchored root must always be re-attributable to its exact leaf set — the
 * minting-engine snapshot discipline), then send one transaction per segment
 * plus one for the aggregate. Idempotent end to end: each anchor call probes
 * on-chain state first, so a crashed run re-anchors nothing and simply
 * finishes what is missing. A stored doc whose root disagrees with a
 * replanned membership is a hard error, never an overwrite — unless the
 * caller passes `takeoverUnanchored` AND the stored doc's own batch id(s)
 * probe UNANCHORED on-chain, in which case the stale doc is the debris of a
 * crashed persist pass (docs are written before any transaction, so an
 * unanchored stored doc constrains nothing) and is overwritten with the
 * plan's doc. An anchored stored doc is never overwritten in any mode.
 */
export async function anchorSegmentedDay(
  deps: SegmentedAnchorDeps,
  plan: SegmentedDayPlan,
  epochNumber: number,
  dayEndMs: number,
  opts?: { readonly takeoverUnanchored?: boolean },
): Promise<AnchorSegmentedDayResult> {
  const { db, chain, now } = deps;
  const takeover = opts?.takeoverUnanchored === true;
  const segmentsCollection = db.collection(ANCHOR_SEGMENTS_COLLECTION);
  const daysCollection = db.collection(ANCHOR_DAYS_COLLECTION);

  /**
   * May a stale stored doc be replaced? Only when every batch id IT declares
   * probes unanchored — an anchored id means the stored partition is (partly)
   * on-chain truth and must win over any replan.
   */
  const storedIsUnanchored = async (batchIds: readonly (string | undefined)[]): Promise<boolean> => {
    for (const id of batchIds) {
      if (typeof id !== 'string' || id.length === 0) continue;
      if (await chain.isAnchored(id)) return false;
    }
    return true;
  };

  // ── Persist (or verify) the day doc.
  const dayRef = daysCollection.doc(dayDocId(plan.day, plan.segment_count));
  const existingDay = await dayRef.get();
  let writeFreshDayDoc = !existingDay.exists;
  if (existingDay.exists) {
    const stored = existingDay.data() as unknown as AnchorDayDoc;
    if (stored.aggregate_root !== plan.aggregate_root || stored.pe_count !== plan.pe_count) {
      if (!takeover
        || !(await storedIsUnanchored([stored.aggregate_batch_id, ...(stored.segment_batch_ids ?? [])]))) {
        throw new Error(
          `Stored day doc for ${plan.day} disagrees with the plan (root ${stored.aggregate_root} vs ${plan.aggregate_root}); refusing to overwrite`,
        );
      }
      writeFreshDayDoc = true;
    }
  }
  if (writeFreshDayDoc) {
    const dayDoc: AnchorDayDoc = {
      schema_version: ANCHOR_DAY_SCHEMA,
      namespace: SEGMENTED_PE_ANCHOR_NAMESPACE,
      day: plan.day,
      pe_count: plan.pe_count,
      segment_count: plan.segment_count,
      segment_size: plan.segment_size,
      segment_roots: plan.segments.map((segment) => segment.merkle_root),
      segment_batch_ids: plan.segments.map((segment) => segment.batch_id),
      aggregate_root: plan.aggregate_root,
      aggregate_batch_id: plan.aggregate_batch_id,
      aggregate_leaf_rule: AGGREGATE_LEAF_RULE,
      status: 'pending',
      aggregate_anchor_tx_hash: null,
      created_at: now(),
      anchored_at: null,
    };
    await dayRef.set(dayDoc as unknown as Record<string, unknown>);
  }

  // ── Persist (or verify) every segment doc BEFORE any transaction.
  for (const segment of plan.segments) {
    const ref = segmentsCollection.doc(segmentDocId(plan.day, segment.segment_index, plan.segment_count));
    const existing = await ref.get();
    if (existing.exists) {
      const stored = existing.data() as unknown as AnchorSegmentDoc;
      if (stored.merkle_root === segment.merkle_root) continue;
      if (!takeover || !(await storedIsUnanchored([stored.batch_id]))) {
        throw new Error(
          `Stored segment ${segment.segment_index} of ${plan.day} disagrees with the plan; refusing to overwrite`,
        );
      }
      // Unanchored debris of a crashed persist pass — fall through and
      // overwrite with the plan's doc.
    }
    const doc: AnchorSegmentDoc = {
      schema_version: ANCHOR_SEGMENT_SCHEMA,
      namespace: SEGMENTED_PE_ANCHOR_NAMESPACE,
      day: plan.day,
      segment_index: segment.segment_index,
      segment_count: plan.segment_count,
      batch_id: segment.batch_id,
      batch_id_preimage: segmentBatchIdPreimage(plan.day, segment.segment_index, plan.segment_count),
      start_index: segment.start_index,
      end_index: segment.end_index,
      pe_count: segment.members.length,
      merkle_root: segment.merkle_root,
      leaf_rule: SEGMENT_LEAF_RULE,
      leaf_ordering: SEGMENT_LEAF_ORDERING,
      members: segment.members,
      status: 'pending',
      anchor_tx_hash: null,
      created_at: now(),
      anchored_at: null,
    };
    await ref.set(doc as unknown as Record<string, unknown>);
  }

  // ── Anchor each segment (idempotent probe first).
  let anchored = 0;
  let alreadyAnchored = 0;
  const segmentTxHashes: (string | null)[] = [];
  for (const segment of plan.segments) {
    const ref = segmentsCollection.doc(segmentDocId(plan.day, segment.segment_index, plan.segment_count));
    if (await chain.isAnchored(segment.batch_id)) {
      const onChainRoot = await chain.readRoot(segment.batch_id);
      if (onChainRoot !== null && onChainRoot !== segment.merkle_root) {
        throw new Error(
          `On-chain root for segment ${segment.segment_index} of ${plan.day} (${onChainRoot}) != planned ${segment.merkle_root}`,
        );
      }
      alreadyAnchored += 1;
      segmentTxHashes.push(null);
      await ref.set({ status: 'anchored', anchored_at: now() }, { merge: true });
      continue;
    }
    const { txHash } = await chain.anchor({
      batchId: segment.batch_id,
      merkleRoot: segment.merkle_root,
      peCount: segment.members.length,
      timestampMs: dayEndMs,
      epochNumber,
    });
    anchored += 1;
    segmentTxHashes.push(txHash);
    await ref.set({ status: 'anchored', anchor_tx_hash: txHash, anchored_at: now() }, { merge: true });
  }

  // ── Anchor the aggregate root.
  let aggregateAnchored = false;
  let aggregateAlready = false;
  let aggregateTxHash: string | null = null;
  if (await chain.isAnchored(plan.aggregate_batch_id)) {
    const onChainRoot = await chain.readRoot(plan.aggregate_batch_id);
    if (onChainRoot !== null && onChainRoot !== plan.aggregate_root) {
      throw new Error(
        `On-chain aggregate root for ${plan.day} (${onChainRoot}) != planned ${plan.aggregate_root}`,
      );
    }
    aggregateAlready = true;
  } else {
    const { txHash } = await chain.anchor({
      batchId: plan.aggregate_batch_id,
      merkleRoot: plan.aggregate_root,
      peCount: plan.pe_count,
      timestampMs: dayEndMs,
      epochNumber,
    });
    aggregateAnchored = true;
    aggregateTxHash = txHash;
  }
  await dayRef.set({
    status: 'anchored',
    aggregate_anchor_tx_hash: aggregateTxHash,
    anchored_at: now(),
  }, { merge: true });

  return {
    day: plan.day,
    pe_count: plan.pe_count,
    segment_count: plan.segment_count,
    segments_anchored: anchored,
    segments_already_anchored: alreadyAnchored,
    aggregate_anchored: aggregateAnchored,
    aggregate_already_anchored: aggregateAlready,
    aggregate_root: plan.aggregate_root,
    segment_tx_hashes: segmentTxHashes,
    aggregate_tx_hash: aggregateTxHash,
  };
}
