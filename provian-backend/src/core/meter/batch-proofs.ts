/**
 * PE METER — the anchoring record of batches whose PEs were SEALED to their owner (PE export).
 *
 * A device fetches its OWN batches' proofs by sequence number (`meter-proofs.ts`). A PE that
 * another party sealed to an owner — a linked agent's PE sealed to its human through the mailbox,
 * a relay-authored PE sealed to its owner (device `relay:<actor>`) — reaches the owner with no
 * proof, and the owner may hold only some of that batch's PEs. This read hands back, per batch
 * hash the caller presents, exactly what the owner needs to prove each PE it holds:
 *   - the batch identity (device, actor, seq, acts_root, batch_leaf) — the batch leaf recomputes
 *     from these and the batch hash;
 *   - the act leaves of the WHOLE batch, in order, so the owner builds each held PE's path to
 *     `acts_root` without the PEs it never received;
 *   - once anchored, the batch leaf's proof in that day's on-chain root.
 *
 * AUTHORIZATION MODEL (decided, PE export): any authenticated caller (a registered device, or a
 * wallet) who presents a batch hash gets that batch's anchoring record. A batch hash is a sha256
 * over the whole batch and is only ever disclosed to the batch's own device, to the recipients of
 * its sealed copies (each mailbox item carries its `batch_hash`) and inside presentations. The
 * record holds hashes and ids only — never a PE, a pricing input, a claim key or a point total —
 * so the field set below is an explicit allowlist and nothing else on the document is returned.
 *
 * Read-only: one `getAll` round trip for up to 200 hashes; it writes nothing.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { METER_BATCHES_COLLECTION } from './meter-store';
import type { MeterAnchorProof } from './meter-anchor';
import { anchorContractAddress } from './meter-proofs';
import { MAX_ACTS_PER_BATCH, merkleRootOf } from './meter-wire';

/** At most this many batch hashes per request (one `getAll`). */
export const MAX_BATCH_PROOF_HASHES = 200;

const HEX64 = /^[0-9a-f]{64}$/;

export interface MeterBatchAnchoringRecord {
  readonly batch_hash: string;
  readonly device_id: string;
  readonly actor_id: string;
  readonly seq: number;
  readonly acts_root: string;
  readonly batch_leaf: string;
  readonly day: string;
  readonly accepted_at_ms: number;
  readonly anchored: boolean;
  /** Where the anchored root is: Base mainnet, the deployed PEAnchor (null when unconfigured). */
  readonly chain_id: 8453;
  readonly anchor_contract: string | null;
  /** The batch leaf's proof in its day's on-chain root; null until the day is anchored. */
  readonly anchor: MeterAnchorProof | null;
  /**
   * Every act's leaf in `acts_root`, in batch order. Null for a batch accepted before the relay
   * kept them (or a record whose leaves do not recompute `acts_root`).
   */
  readonly act_leaves: readonly string[] | null;
}

export interface MeterBatchProofsResponse {
  readonly batches: MeterBatchAnchoringRecord[];
  /** Presented hashes with no (well-formed) record: never accepted, or dropped by TTL. */
  readonly missing: string[];
  /** Presented one-act roots with no relay-authored record (only when `acts_roots` was asked). */
  readonly missing_acts_roots?: string[];
}

export type ReadBatchProofsResult =
  | { readonly ok: true; readonly value: MeterBatchProofsResponse }
  | { readonly ok: false; readonly error: 'batch_hashes_invalid' };

/** Validate the request's `batch_hashes`: 1..200 lowercase 64-hex strings, deduped in order. */
export function parseBatchHashes(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_BATCH_PROOF_HASHES) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const h of raw) {
    if (typeof h !== 'string' || !HEX64.test(h)) return null;
    if (seen.has(h)) continue;
    seen.add(h);
    out.push(h);
  }
  return out;
}

function isHex64(v: unknown): v is string {
  return typeof v === 'string' && HEX64.test(v);
}

function nonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/** The stored proof, projected field by field (nothing else on the stored object leaks). */
function anchorOf(raw: unknown): MeterAnchorProof | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.day !== 'string' || typeof a.anchor_batch_id !== 'string'
    || !nonNegativeInt(a.leaf_index) || !nonNegativeInt(a.leaf_count)
    || typeof a.leaf_hash !== 'string' || typeof a.merkle_root !== 'string'
    || !Array.isArray(a.proof) || !a.proof.every((p) => typeof p === 'string')
    || !(a.anchor_tx_hash === null || typeof a.anchor_tx_hash === 'string')
    || !nonNegativeInt(a.anchored_at_ms)
    || !(a.segment === undefined || (nonNegativeInt(a.segment) && a.segment >= 1))) {
    return null;
  }
  return {
    day: a.day,
    anchor_batch_id: a.anchor_batch_id,
    ...(a.segment !== undefined ? { segment: a.segment as number } : {}),
    leaf_index: a.leaf_index,
    leaf_count: a.leaf_count,
    leaf_hash: a.leaf_hash,
    proof: [...(a.proof as string[])],
    merkle_root: a.merkle_root,
    anchor_tx_hash: a.anchor_tx_hash as string | null,
    anchored_at_ms: a.anchored_at_ms,
  };
}

/** The stored act leaves, only when they are well formed AND recompute the batch's `acts_root`. */
function actLeavesOf(raw: unknown, actsRoot: string): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ACTS_PER_BATCH) return null;
  if (!raw.every(isHex64)) return null;
  const leaves = raw as string[];
  return merkleRootOf(leaves) === actsRoot ? [...leaves] : null;
}

function recordOf(batchHash: string, d: Record<string, unknown>): MeterBatchAnchoringRecord | null {
  if (typeof d.device_id !== 'string' || d.device_id.length === 0
    || typeof d.actor_id !== 'string' || d.actor_id.length === 0
    || !nonNegativeInt(d.seq) || !isHex64(d.acts_root) || !isHex64(d.batch_leaf)
    || typeof d.day !== 'string' || !nonNegativeInt(d.accepted_at_ms)) {
    return null;
  }
  const anchored = d.anchored === true;
  const anchor = anchored ? anchorOf(d.anchor) : null;
  return {
    batch_hash: batchHash,
    device_id: d.device_id,
    actor_id: d.actor_id,
    seq: d.seq,
    acts_root: d.acts_root,
    batch_leaf: d.batch_leaf,
    day: d.day,
    accepted_at_ms: d.accepted_at_ms,
    // A record marked anchored whose proof is unreadable is reported unanchored (no proof to give).
    anchored: anchored && anchor !== null,
    chain_id: 8453,
    anchor_contract: anchorContractAddress(),
    anchor,
    act_leaves: actLeavesOf(d.act_leaves, d.acts_root),
  };
}

export async function readBatchProofs(db: Firestore, rawHashes: unknown): Promise<ReadBatchProofsResult> {
  const hashes = parseBatchHashes(rawHashes);
  if (hashes === null) return { ok: false, error: 'batch_hashes_invalid' };
  const refs = hashes.map((h) => db.collection(METER_BATCHES_COLLECTION).doc(h));
  const snaps = await db.getAll(...refs);
  const batches: MeterBatchAnchoringRecord[] = [];
  const missing: string[] = [];
  snaps.forEach((snap, i) => {
    const record = snap.exists ? recordOf(hashes[i], (snap.data() ?? {}) as Record<string, unknown>) : null;
    if (record === null) missing.push(hashes[i]);
    else batches.push(record);
  });
  return { ok: true, value: { batches, missing } };
}

/** Firestore's `in` filter takes at most 30 values. */
const IN_QUERY_MAX = 30;

/**
 * A relay-authored PE the relay handed its owner DIRECTLY (registration's `firstEnvelope`) reaches
 * the owner without its batch hash — and before the owner has a published key there is no mailbox
 * copy carrying one. A relay-authored batch holds exactly one act, so its `acts_root` is a function
 * of the PE alone (the root of a one-leaf tree over its act leaf), which the owner computes. This
 * read answers by that root: only one-act batches of a relay device (`relay:<actor>`), the same
 * allowlisted record. The authorization model is the batch-hash one: a one-act root is a sha256
 * over the act record, which commits to the complete PE's sha256 — only its holder can name it.
 */
export async function readRelayBatchesByActsRoot(
  db: Firestore,
  roots: readonly string[],
): Promise<{ batches: MeterBatchAnchoringRecord[]; missing: string[] }> {
  const found = new Map<string, MeterBatchAnchoringRecord>();
  for (let i = 0; i < roots.length; i += IN_QUERY_MAX) {
    const chunk = roots.slice(i, i + IN_QUERY_MAX);
    const snap = await db.collection(METER_BATCHES_COLLECTION).where('acts_root', 'in', chunk).get();
    for (const doc of snap.docs) {
      const d = (doc.data() ?? {}) as Record<string, unknown>;
      if (typeof d.device_id !== 'string' || !d.device_id.startsWith('relay:') || d.act_count !== 1) continue;
      const record = recordOf(doc.id, d);
      if (record === null) continue;
      const prior = found.get(record.acts_root);
      // One act, one batch: if a root ever named two records, prefer the anchored one.
      if (prior === undefined || (!prior.anchored && record.anchored)) found.set(record.acts_root, record);
    }
  }
  return { batches: [...found.values()], missing: roots.filter((r) => !found.has(r)) };
}

/**
 * The route body: `{ batch_hashes?: string[], acts_roots?: string[] }` — at least one non-empty,
 * at most 200 values in all, each lowercase 64-hex. `acts_roots` look up relay-authored one-act
 * batches (`readRelayBatchesByActsRoot`).
 */
export async function readBatchProofsRequest(db: Firestore, body: unknown): Promise<ReadBatchProofsResult> {
  const b = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const hasHashes = b.batch_hashes !== undefined;
  const hasRoots = b.acts_roots !== undefined;
  if (!hasRoots) return readBatchProofs(db, b.batch_hashes);
  const roots = parseBatchHashes(b.acts_roots);
  const hashes = hasHashes ? parseBatchHashes(b.batch_hashes) : [];
  if (roots === null || hashes === null || roots.length + hashes.length > MAX_BATCH_PROOF_HASHES) {
    return { ok: false, error: 'batch_hashes_invalid' };
  }
  const byHash = hashes.length > 0 ? await readBatchProofs(db, hashes) : null;
  if (byHash !== null && !byHash.ok) return byHash;
  const byRoot = await readRelayBatchesByActsRoot(db, roots);
  const seen = new Set<string>();
  const batches: MeterBatchAnchoringRecord[] = [];
  for (const r of [...(byHash?.value.batches ?? []), ...byRoot.batches]) {
    if (seen.has(r.batch_hash)) continue;
    seen.add(r.batch_hash);
    batches.push(r);
  }
  return { ok: true, value: { batches, missing: byHash?.value.missing ?? [], missing_acts_roots: byRoot.missing } };
}
