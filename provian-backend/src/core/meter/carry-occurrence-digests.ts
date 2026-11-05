import type { Firestore } from 'firebase-admin/firestore';
import { parseClaim } from '../pvt/mint-once-claim';
import { privateRetentionCollection, PRIVATE_RETENTION_COLLECTIONS } from '../provenance/private-retention';
import { scanQueryUnordered } from '../provenance/query-pages';
import { BatchOccurrences, crossWitnessOccurrenceDigest, relayOccurrenceDigest } from './batch-occurrences';
import { isSingleLaneActType } from './act-witness-lanes';
import { retryNoveltyConflict } from './batch-pricing-counters';

export const OCCURRENCE_CARRY_STATE = 'meter_occurrence_carry_v1';
/** Operator-only cutover. Old writers must be drained before invocation. The source scan is a
 * single fixed snapshot in the private-store adapter. Only opaque membership is written.
 */
export async function carryOccurrenceDigests(db: Firestore, oldWritersDrained: boolean, nowMs = Date.now(), finalize = true): Promise<{ claims: number; actors: number; added: number }> {
  if (!oldWritersDrained) throw new Error('occurrence_carry_requires_old_writers_drained');
  const certificate = db.collection(OCCURRENCE_CARRY_STATE).doc('live'), previous = (await certificate.get()).data();
  // An additive carry cannot retract permanent evidence already certified by an earlier pass.
  await certificate.set({ complete: previous?.complete === true, started_at_ms: nowMs }, { merge: true });
  let claims = 0, added = 0;
  const actors = new Set<string>();
  const pending = new Map<string, Set<string>>();
  let pendingCount = 0;
  const flush = async (): Promise<void> => {
    for (const [actor, hashes] of pending) {
      added += await retryNoveltyConflict(async () => {
        const batch = new BatchOccurrences(db, undefined, false);
        let fresh = 0;
        for (const hash of hashes) if (await batch.remember(actor, hash)) fresh++;
        await db.runTransaction(async txn => { await batch.inspect(txn); batch.commit(txn); });
        return fresh;
      });
    }
    pending.clear(); pendingCount = 0;
  };
  for (const [collection, kind] of [['device_occurrence_mint_claims', 'device_occurrence'], ['commit_mint_claims', 'commit'], ['completion_mint_claims', 'completion'], ['x402_tx_mint_claims', 'x402'], ['financial_settlement_mint_claims', 'financial_settlement'], ['occurrence_mint_claims', 'occurrence']] as const) {
  await scanQueryUnordered(PRIVATE_RETENTION_COLLECTIONS.has(collection) ? privateRetentionCollection(db, collection) : db.collection(collection), 250, async doc => {
    const claim = parseClaim(doc.data());
    if (claim.claim_kind !== kind) throw new Error('occurrence_carry_wrong_claim_kind');
    actors.add(claim.subject_id); claims++;
    const hashes = pending.get(claim.subject_id) ?? new Set<string>();
    hashes.add(kind === 'device_occurrence' ? claim.event_id : crossWitnessOccurrenceDigest(collection, claim.claim_id)); pending.set(claim.subject_id, hashes);
    if (++pendingCount >= 250) await flush();
  });
  }
  // Existing relay-only act keys were also replay guards. Carry only their occurrence
  // identity, leaving every row, snapshot, held state and original TTL untouched.
  await scanQueryUnordered(privateRetentionCollection(db, 'meter_act_keys_v1'), 250, async doc => {
    const key = doc.data();
    if (typeof key.device_id !== 'string' || !key.device_id.startsWith('relay:')
      || typeof key.action_type !== 'string' || !isSingleLaneActType(key.action_type)) return;
    if (typeof key.actor_id !== 'string' || typeof key.relay_pe_id !== 'string') throw new Error('relay_occurrence_carry_identity_invalid');
    actors.add(key.actor_id); claims++;
    const hashes = pending.get(key.actor_id) ?? new Set<string>();
    hashes.add(relayOccurrenceDigest(key.relay_pe_id)); pending.set(key.actor_id, hashes);
    if (++pendingCount >= 250) await flush();
  });
  await flush();
  const result = { claims, actors: actors.size, added };
  await db.collection(OCCURRENCE_CARRY_STATE).doc('live').set({ complete: finalize || previous?.complete === true, relay_single_lane_complete: finalize || previous?.relay_single_lane_complete === true,
    ...(finalize ? { completed_at_ms: nowMs } : { captured_at_ms: nowMs }), ...result }, { merge: true });
  return result;
}
