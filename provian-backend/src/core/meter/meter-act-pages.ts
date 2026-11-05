import { privateRetentionCollection } from '../provenance/private-retention';
/**
 * PE METER — a batch's act pages: where a SINGLE-LANE act's priced row lives .
 *
 * the standing rule : single-lane act types keep no per-act document. Their priced rows
 * (the row the batch's settlement, the owner's 31-day history and the live projection tail read)
 * are kept per BATCH instead: one page document per batch, chunked only when a batch's rows do not
 * fit one document (a full 500-act batch). Same 31-day lifetime as an act key, same content (the
 * priced row, never free text), keyed by the act's relay pe id inside the page.
 *
 * meter_batch_acts_v1/{batch_hash}~{page}
 * batch_hash, page, actor_id, device_id, beneficiary_ids[], min_ts, max_ts,
 * acts: { [relay_pe_id]: MeterPageAct } — exempt from indexing (`firestore.indexes.json`)
 * expire_at: max act timestamp + 31 days (TTL)
 *
 * A multi-lane act keeps its own act key (`meter_act_keys_v1`) exactly as before: a second lane
 * may take it over, corroborate it, or complete it, and those read and write it by id.
 */

import type { DocumentReference, Firestore, Transaction } from 'firebase-admin/firestore';
import type { MeterActKeyDoc } from './meter-act-key';
import { expireAt, METER_KEY_LIFETIME_MS } from './meter-store';

export const METER_BATCH_ACTS_COLLECTION = 'meter_batch_acts_v1';

/** A page's acts are kept under this many serialized bytes (Firestore's limit is 1 MiB). */
export const METER_ACT_PAGE_MAX_BYTES = 600_000;

/** What a page keeps per act: the act key's fields minus the commit-only inputs. */
export type MeterPageAct = Omit<MeterActKeyDoc, 'side' | 'facts' | 'expire_at'>;

export interface MeterActPageDoc {
  readonly schema: 'provian.meter-batch-acts.v1';
  readonly batch_hash: string;
  readonly page: number;
  readonly actor_id: string;
  readonly device_id: string;
  readonly beneficiary_ids: readonly string[];
  readonly min_ts: number;
  readonly max_ts: number;
  readonly acts: Readonly<Record<string, MeterPageAct>>;
  /** Ops counts over the page (the console counts single-lane acts from these, never from acts). */
  readonly act_count: number;
  readonly action_types: readonly string[];
  readonly type_counts: Readonly<Record<string, number>>;
  readonly witness_class_counts: Readonly<Record<string, number>>;
  readonly expire_at: FirebaseFirestore.Timestamp;
}

export function meterActPageId(batchHash: string, page: number): string {
  return `${batchHash}~${page}`;
}

export function pageActOf(key: MeterActKeyDoc): MeterPageAct {
  const { side: _side, facts: _facts, expire_at: _expire, ...rest } = key;
  void _side; void _facts; void _expire;
  return rest;
}

/** Re-shape a page act as an act key (for the readers written against act keys). */
export function actKeyOfPageAct(act: MeterPageAct): MeterActKeyDoc {
  return {
    ...act,
    side: { statsBump: null, delegation: null, corroborateIncumbentPeId: null, outputDigestsIndexed: false, effect: null },
    facts: null,
    expire_at: null,
  };
}

/** Split a batch's single-lane act keys into pages (in batch order; deterministic). */
export function buildActPages(input: {
  readonly batchHash: string;
  readonly actorId: string;
  readonly deviceId: string;
  readonly keys: readonly MeterActKeyDoc[];
}): MeterActPageDoc[] {
  const pages: MeterActPageDoc[] = [];
  let current: MeterPageAct[] = [];
  let bytes = 0;
  const flush = () => {
    if (current.length === 0) return;
    const ts = current.map((a) => a.timestamp);
    const beneficiaries = [...new Set(current.map((a) => a.beneficiary_id).filter((b): b is string => typeof b === 'string' && b.length > 0))].sort();
    const acts: Record<string, MeterPageAct> = {};
    const typeCounts: Record<string, number> = {};
    const classCounts: Record<string, number> = {};
    for (const a of current) {
      acts[a.relay_pe_id] = a;
      typeCounts[a.action_type] = (typeCounts[a.action_type] ?? 0) + 1;
      const wc = typeof a.row.witness_class === 'string' && a.row.witness_class.length > 0 ? a.row.witness_class : 'unclassified';
      classCounts[wc] = (classCounts[wc] ?? 0) + 1;
    }
    const maxTs = Math.max(...ts);
    pages.push({
      schema: 'provian.meter-batch-acts.v1',
      batch_hash: input.batchHash,
      page: pages.length,
      actor_id: input.actorId,
      device_id: input.deviceId,
      beneficiary_ids: beneficiaries,
      min_ts: Math.min(...ts),
      max_ts: maxTs,
      acts,
      act_count: current.length,
      action_types: Object.keys(typeCounts).sort(),
      type_counts: typeCounts,
      witness_class_counts: classCounts,
      expire_at: expireAt(maxTs + METER_KEY_LIFETIME_MS),
    });
    current = [];
    bytes = 0;
  };
  for (const key of input.keys) {
    const act = pageActOf(key);
    const size = Buffer.byteLength(JSON.stringify(act));
    if (current.length > 0 && bytes + size > METER_ACT_PAGE_MAX_BYTES) flush();
    current.push(act);
    bytes += size;
  }
  flush();
  return pages;
}

export function actPageRef(db: Firestore, batchHash: string, page: number): DocumentReference {
  return privateRetentionCollection(db, METER_BATCH_ACTS_COLLECTION).doc(meterActPageId(batchHash, page));
}

/** Every page of one batch (normally one). */
export async function readBatchActPages(
  db: Firestore,
  batchHash: string,
  txn?: Transaction,
): Promise<{ readonly ref: DocumentReference; readonly doc: MeterActPageDoc }[]> {
  const query = privateRetentionCollection(db, METER_BATCH_ACTS_COLLECTION).where('batch_hash', '==', batchHash);
  const snap = txn ? await txn.get(query) : await query.get();
  return snap.docs
    .map((d) => ({ ref: d.ref, doc: d.data() as MeterActPageDoc }))
    .sort((a, b) => a.doc.page - b.doc.page);
}

/**
 * Find single-lane acts by relay pe id, given the batches they belong to. Returns act key-shaped
 * docs, each with the page it lives on.
 */
export async function readPageActs(
  db: Firestore,
  wanted: readonly { readonly relayPeId: string; readonly batchHash: string }[],
): Promise<Map<string, { readonly key: MeterActKeyDoc; readonly ref: DocumentReference }>> {
  const out = new Map<string, { key: MeterActKeyDoc; ref: DocumentReference }>();
  const byBatch = new Map<string, Set<string>>();
  for (const w of wanted) {
    const set = byBatch.get(w.batchHash) ?? new Set<string>();
    set.add(w.relayPeId);
    byBatch.set(w.batchHash, set);
  }
  for (const [batchHash, ids] of byBatch) {
    for (const { ref, doc } of await readBatchActPages(db, batchHash)) {
      for (const id of ids) {
        const act = doc.acts[id];
        if (act !== undefined) out.set(id, { key: actKeyOfPageAct(act), ref });
      }
    }
  }
  return out;
}
