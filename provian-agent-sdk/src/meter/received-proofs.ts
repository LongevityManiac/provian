/**
 * PE METER — proofs for the PEs another party sealed to this agent (PE export, 2026-10-06).
 *
 * A received PE (a relay-authored PE, or a PE from another of the owner's devices) was sent in a
 * batch this agent never held. To prove it against its on-chain anchor the agent needs that
 * batch's anchoring record: its identity (device, actor, seq, batch hash, acts_root), every act's
 * leaf in batch order, and the batch leaf's path to its day root. The relay answers that from
 * `POST /v1/meter/batch-proofs` — but drops a batch record 30 days after its anchor, so the daemon
 * fetches it DAILY once the day is anchored and KEEPS it (`received-proofs.jsonl`). A PE export
 * builds each received PE's inclusion proof from the kept record.
 *
 * Every answer is checked here before it is kept: its batch leaf must recompute from its identity,
 * its act leaves must rebuild its acts_root, and its anchor path must fold to the day root under the
 * day's batch id on the pinned PEAnchor. An answer failing any check is never kept.
 */

import { batchLeafOf, merkleRootOf, PE_V2_SCHEMA } from '../meter-wire';
import {
  anchoredLeafOf,
  foldAnchorProof,
  meterAnchorBatchIdOf,
  PE_EXPORT_BASE_CHAIN_ID,
  PE_EXPORT_PE_ANCHOR,
} from '../pe-export-wire';
import type { MeterAnchorProofWire, PeStore, ReceivedBatchProof, ReceivedPe } from './pe-store';
import { METER_BATCH_PROOFS_MAX, type MeterTransport } from './transport';

const HEX64 = /^[0-9a-f]{64}$/;

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function hex64(x: unknown): x is string {
  return typeof x === 'string' && HEX64.test(x);
}

/** The batch hashes received PE v2 rows came in (distinct, well-formed), in first-seen order. */
export function receivedBatchHashes(received: readonly ReceivedPe[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of received) {
    if (r.pe?.schema !== PE_V2_SCHEMA || !hex64(r.batch_hash) || seen.has(r.batch_hash)) continue;
    seen.add(r.batch_hash);
    out.push(r.batch_hash);
  }
  return out;
}

function anchorOf(raw: unknown): MeterAnchorProofWire | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.day !== 'string' || typeof raw.anchor_batch_id !== 'string' || typeof raw.merkle_root !== 'string'
    || !Array.isArray(raw.proof) || !raw.proof.every((x) => typeof x === 'string')
    || typeof raw.leaf_index !== 'number' || typeof raw.leaf_count !== 'number'
    || !(raw.segment === undefined || (typeof raw.segment === 'number' && Number.isSafeInteger(raw.segment) && raw.segment >= 1))) return null;
  return {
    day: raw.day,
    anchor_batch_id: raw.anchor_batch_id,
    ...(raw.segment !== undefined ? { segment: raw.segment as number } : {}),
    leaf_index: raw.leaf_index,
    leaf_count: raw.leaf_count,
    leaf_hash: typeof raw.leaf_hash === 'string' ? raw.leaf_hash : '',
    proof: [...(raw.proof as string[])],
    merkle_root: raw.merkle_root,
    anchor_tx_hash: typeof raw.anchor_tx_hash === 'string' ? raw.anchor_tx_hash : null,
    anchored_at_ms: typeof raw.anchored_at_ms === 'number' ? raw.anchored_at_ms : 0,
  };
}

/**
 * Check one batch-proofs answer and shape it for keeping. Returns the reason it is refused, or the
 * record. `anchored: true` requires an anchor that folds to its day root on the pinned contract.
 */
export function receivedProofOf(raw: unknown, fetchedAtMs: number): { ok: true; proof: ReceivedBatchProof } | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: 'not_an_object' };
  if (!hex64(raw.batch_hash) || typeof raw.device_id !== 'string' || typeof raw.actor_id !== 'string'
    || !Number.isSafeInteger(raw.seq) || !hex64(raw.acts_root) || !hex64(raw.batch_leaf)) {
    return { ok: false, reason: 'identity_malformed' };
  }
  const identity = { device_id: raw.device_id, actor_id: raw.actor_id, seq: raw.seq as number, batch_hash: raw.batch_hash, acts_root: raw.acts_root };
  let leaf: string;
  try {
    leaf = batchLeafOf(identity);
  } catch {
    return { ok: false, reason: 'identity_malformed' };
  }
  if (leaf !== raw.batch_leaf) return { ok: false, reason: 'batch_leaf_mismatch' };
  let actLeaves: string[] | null = null;
  if (raw.act_leaves !== null && raw.act_leaves !== undefined) {
    if (!Array.isArray(raw.act_leaves) || raw.act_leaves.length === 0 || !raw.act_leaves.every(hex64)) return { ok: false, reason: 'act_leaves_malformed' };
    actLeaves = [...(raw.act_leaves as string[])];
    if (merkleRootOf(actLeaves) !== raw.acts_root) return { ok: false, reason: 'act_leaves_do_not_rebuild_acts_root' };
  }
  const chainId = typeof raw.chain_id === 'number' ? raw.chain_id : PE_EXPORT_BASE_CHAIN_ID;
  if (chainId !== PE_EXPORT_BASE_CHAIN_ID) return { ok: false, reason: 'anchor_chain_untrusted' };
  const contract = typeof raw.anchor_contract === 'string' && raw.anchor_contract.length > 0 ? raw.anchor_contract : null;
  if (contract !== null && contract.toLowerCase() !== PE_EXPORT_PE_ANCHOR.toLowerCase()) return { ok: false, reason: 'anchor_contract_untrusted' };
  const anchored = raw.anchored === true;
  let anchor: MeterAnchorProofWire | null = null;
  if (anchored) {
    anchor = anchorOf(raw.anchor);
    if (anchor === null) return { ok: false, reason: 'anchor_malformed' };
    try {
      if (meterAnchorBatchIdOf(anchor.day, anchor.segment) !== anchor.anchor_batch_id.toLowerCase()) return { ok: false, reason: 'anchor_batch_id_mismatch' };
      if (foldAnchorProof(anchoredLeafOf(leaf), anchor.proof) !== anchor.merkle_root.toLowerCase()) return { ok: false, reason: 'anchor_proof_mismatch' };
    } catch {
      return { ok: false, reason: 'anchor_malformed' };
    }
  }
  return {
    ok: true,
    proof: {
      batch_hash: raw.batch_hash,
      device_id: raw.device_id,
      actor_id: raw.actor_id,
      seq: raw.seq as number,
      acts_root: raw.acts_root,
      batch_leaf: raw.batch_leaf,
      day: typeof raw.day === 'string' ? raw.day : anchor?.day ?? null,
      accepted_at_ms: typeof raw.accepted_at_ms === 'number' ? raw.accepted_at_ms : null,
      anchored,
      chain_id: PE_EXPORT_BASE_CHAIN_ID,
      anchor_contract: PE_EXPORT_PE_ANCHOR,
      anchor,
      act_leaves: actLeaves,
      fetched_at_ms: fetchedAtMs,
    },
  };
}

export interface BatchProofsFetch {
  /** Every request answered 200 with a well-formed body. */
  readonly ok: boolean;
  /** Checked answers by batch hash (anchored or not). */
  readonly answers: Map<string, ReceivedBatchProof>;
  /** Hashes the relay does not hold (it drops a record 30 days after its anchor). */
  readonly missing: Set<string>;
  /** Hashes whose answer failed a check, with why. */
  readonly refused: Map<string, string>;
  /** Why a request failed (status / transport error), when one did. */
  readonly error: string | null;
}

/** Ask the relay for these batches' anchoring records, at most 200 per request. */
export async function fetchBatchProofs(
  transport: Pick<MeterTransport, 'getBatchProofs'>,
  batchHashes: readonly string[],
  nowMs: number,
): Promise<BatchProofsFetch> {
  const answers = new Map<string, ReceivedBatchProof>();
  const missing = new Set<string>();
  const refused = new Map<string, string>();
  if (!transport.getBatchProofs) return { ok: false, answers, missing, refused, error: 'batch_proofs_unsupported' };
  let ok = true;
  let error: string | null = null;
  const wanted = [...new Set(batchHashes.filter(hex64))];
  for (let i = 0; i < wanted.length; i += METER_BATCH_PROOFS_MAX) {
    const chunk = wanted.slice(i, i + METER_BATCH_PROOFS_MAX);
    const requested = new Set(chunk);
    const answer = await transport.getBatchProofs(chunk);
    if (answer.status !== 200 || !isRecord(answer.body) || !Array.isArray(answer.body.batches)) {
      ok = false;
      error = `batch_proofs_unreadable:${answer.status ?? answer.error ?? 'no answer'}`;
      continue;
    }
    for (const raw of answer.body.batches) {
      const hash = isRecord(raw) && typeof raw.batch_hash === 'string' ? raw.batch_hash : null;
      if (hash === null || !requested.has(hash)) continue;
      const checked = receivedProofOf(raw, nowMs);
      if (checked.ok) answers.set(hash, checked.proof);
      else refused.set(hash, checked.reason);
    }
    if (Array.isArray(answer.body.missing)) {
      for (const h of answer.body.missing) if (typeof h === 'string' && requested.has(h) && !answers.has(h)) missing.add(h);
    }
  }
  return { ok, answers, missing, refused, error };
}

export interface KeepReceivedProofsReport {
  readonly ok: boolean;
  /** Anchored records kept now. */
  readonly kept: number;
  /** Batches the relay answered but whose day is not anchored yet (asked again tomorrow). */
  readonly pending: number;
  readonly refused: number;
  readonly missing: number;
}

/**
 * The daemon's daily step: fetch the anchoring record of every batch a received PE came in that has
 * none kept yet, and keep the anchored ones. A record whose device is not the one the received PE
 * names is refused.
 */
export async function keepReceivedProofs(
  store: PeStore,
  transport: Pick<MeterTransport, 'getBatchProofs'>,
  nowMs: number,
): Promise<KeepReceivedProofsReport & { readonly fetch: BatchProofsFetch | null }> {
  if (!store.recordReceivedProof || !store.listReceivedProofs || !transport.getBatchProofs) {
    return { ok: true, kept: 0, pending: 0, refused: 0, missing: 0, fetch: null };
  }
  const received = await store.listReceived();
  const kept = new Set((await store.listReceivedProofs()).map((p) => p.batch_hash));
  const wanted = receivedBatchHashes(received).filter((h) => !kept.has(h));
  if (wanted.length === 0) return { ok: true, kept: 0, pending: 0, refused: 0, missing: 0, fetch: null };
  const fetched = await fetchBatchProofs(transport, wanted, nowMs);
  const devicesOf = new Map<string, Set<string>>();
  for (const r of received) {
    const set = devicesOf.get(r.batch_hash) ?? new Set<string>();
    set.add(r.from_device);
    devicesOf.set(r.batch_hash, set);
  }
  let keptNow = 0;
  let pending = 0;
  let refused = fetched.refused.size;
  for (const [hash, proof] of fetched.answers) {
    const devices = devicesOf.get(hash);
    if (devices !== undefined && [...devices].some((d) => d.length > 0 && d !== proof.device_id)) {
      refused += 1;
      continue;
    }
    if (!proof.anchored) {
      pending += 1;
      continue;
    }
    if (await store.recordReceivedProof(proof)) keptNow += 1;
  }
  return { ok: fetched.ok, kept: keptNow, pending, refused, missing: fetched.missing.size, fetch: fetched };
}
