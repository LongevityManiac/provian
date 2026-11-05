import type { Firestore } from 'firebase-admin/firestore';
import { scanQueryUnordered } from '../provenance/query-pages';
import { parseClaim } from '../pvt/mint-once-claim';
import { carryOccurrenceDigests } from './carry-occurrence-digests';
import { BATCH_OCCURRENCES_COLLECTION, nodeMembers, packFingerprints, type OccurrenceNode } from './occurrence-tree';
import { OCCURRENCE_STATES, occurrenceDueDay, occurrenceDueRecord, occurrenceDueRef, occurrenceStateId } from './occurrence-residency';
import { carryPendingClaimIndex } from './pending-claim-index';
import { PACKED_COUNTER_CONFIG } from './packed-day-counters';
import { METER_MAX_FUTURE_SKEW_MS } from './meter-store';

/** Operator format cutover after all older writers drain. No PE, price, owner or original TTL
 * changes. New writers commit their own permanent membership atomically throughout the carry. */
export async function cutoverMeterCostStorage(db: Firestore, oldWritersDrained: boolean, nowMs = Date.now()): Promise<Record<string, unknown>> {
  if (!oldWritersDrained) throw new Error('meter_cost_cutover_requires_old_writers_drained');
  const carried = await carryOccurrenceDigests(db, true, nowMs);
  const activity = new Map<string, number>(), owners = new Map<string, string>(), actors = new Set<string>();
  const remember = (actor: unknown, at: unknown): void => {
    if (typeof actor === 'string' && Number.isSafeInteger(at) && Number(at) >= 0) activity.set(actor, Math.max(activity.get(actor) ?? 0, Number(at)));
  };
  await scanQueryUnordered(db.collection('meter_device_tips_v1'), 250, async doc => { const tip = doc.data(); remember(tip.actor_id, tip.accepted_at_ms); });
  for (const collection of ['device_occurrence_mint_claims', 'commit_mint_claims', 'completion_mint_claims', 'x402_tx_mint_claims', 'financial_settlement_mint_claims', 'occurrence_mint_claims']) {
    await scanQueryUnordered(db.collection(collection), 250, async doc => { const claim = parseClaim(doc.data()); owners.set(claim.subject_id, claim.owner_user_id); remember(claim.subject_id, claim.created_at_ms); });
  }
  let repacked = 0, fingerprints = 0;
  await scanQueryUnordered(db.collection(BATCH_OCCURRENCES_COLLECTION), 250, async source => {
    const initial = source.data(); if (typeof initial.actor_id !== 'string') throw new Error('meter_cutover_actor_invalid'); actors.add(initial.actor_id);
    if (initial._meter_residency_fence) return;
    const result = await db.runTransaction(async txn => {
      const snap = await txn.get(source.ref); if (!snap.exists) return { changed: false, count: 0 };
      const node = snap.data() as OccurrenceNode, members = nodeMembers(node, initial.actor_id, node.prefix);
      if (node.fingerprints !== undefined && node.members === undefined) return { changed: false, count: members.length };
      // A full replacement removes the legacy array and every per-entry encrypted lookup.
      txn.set(source.ref, { actor_id: node.actor_id, prefix: node.prefix, revision: node.revision + 1, split: node.split, fingerprints: packFingerprints(members) });
      return { changed: true, count: members.length };
    });
    if (result.changed) repacked++; fingerprints += result.count;
  });
  let initialized = 0;
  for (const actor of actors) {
    const last = Math.max(activity.get(actor) ?? 0, activity.get(owners.get(actor) ?? '') ?? 0);
    const did = await db.runTransaction(async txn => {
      const ref = db.collection(OCCURRENCE_STATES).doc(occurrenceStateId(actor)), snap = await txn.get(ref);
      if (snap.exists) return false;
      txn.create(ref, { actor_id: actor, residency: 'hot', last_active_at_ms: last, archive_due_day: occurrenceDueDay(last) });
      txn.set(occurrenceDueRef(db, actor), occurrenceDueRecord(actor, last)); return true;
    });
    if (did) initialized++;
  }
  const indexed = await carryPendingClaimIndex(db);
  const config = db.collection(PACKED_COUNTER_CONFIG).doc('live');
  const counterCutover = await db.runTransaction(async txn => {
    const prior = await txn.get(config); if (prior.exists) return prior.data();
    const value = { packed_from_day: new Date(nowMs).toISOString().slice(0, 10),
      legacy_seed_through_day: new Date(nowMs + METER_MAX_FUTURE_SKEW_MS).toISOString().slice(0, 10) };
    txn.create(config, value); return value;
  });
  await db.collection('meter_cost_storage_format_v1').doc('live').set({ complete: true, completed_at_ms: nowMs, version: 1, source_claim_ttls_changed: 0 });
  return { carried, actors: actors.size, repacked, fingerprints, initialized, pending_indexed: indexed, counter_cutover: counterCutover, prices_changed: 0, source_claim_ttls_changed: 0 };
}
