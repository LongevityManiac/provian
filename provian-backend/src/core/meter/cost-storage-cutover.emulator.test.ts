import { Firestore } from 'firebase-admin/firestore';
import { createHash, randomUUID } from 'crypto';
import { privateFirestore } from '../provenance/private-store';
import { BatchOccurrences } from './batch-occurrences';
import { BATCH_OCCURRENCES_COLLECTION, occurrenceNodeId, unpackFingerprints } from './occurrence-tree';
import { OCCURRENCE_STATES, occurrenceStateId, occurrenceDueRef } from './occurrence-residency';
import { cutoverMeterCostStorage } from './cost-storage-cutover';
import { prepareMintOnceClaim, inspectPreparedMintOnceClaimInTransaction, applyMintOnceClaimDecision } from '../pvt/mint-once-claim';
const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
jest.setTimeout(60_000);
suite('operator cost format cutover preserves ownership and true activity', () => {
  let raw: Firestore, db: Firestore;
  const secret = process.env.RELAY_SIGNING_KEY, actor = 'public-cutover-actor', now = Date.parse('2026-10-31T23:55:00Z'), last = now - 91 * 86400000;
  beforeAll(async () => {
    process.env.RELAY_SIGNING_KEY = 'public-cost-cutover-key'; raw = new Firestore({ projectId: 'demo-cost-cutover', databaseId: 'cutover-' + randomUUID().slice(0, 8) });
    await raw.collection('private_retention_state_v1').doc('d554').set({ opaque_ids_ready: true, opaque_records_complete: true }); db = privateFirestore(raw);
  });
  afterAll(async () => { await raw.terminate(); if (secret === undefined) delete process.env.RELAY_SIGNING_KEY; else process.env.RELAY_SIGNING_KEY = secret; });
  it('RED refuses undrained old writers; repacks live legacy hashes, keeps source claim bytes/TTL, preserves91-day dormancy, and includes admitted tomorrow in scalar seeding', async () => {
    await expect(cutoverMeterCostStorage(db, false, now)).rejects.toThrow('old_writers_drained');
    const batch = new BatchOccurrences(db); const event = createHash('sha256').update('old-observed-work').digest('hex'); await batch.claim(actor, event); await db.runTransaction(async txn => { await batch.inspect(txn); batch.commit(txn); });
    const root = db.collection(BATCH_OCCURRENCES_COLLECTION).doc(occurrenceNodeId(actor, '')), initial = (await root.get()).data()!;
    await root.set({ actor_id: actor, prefix: '', revision: initial.revision, split: false, members: unpackFingerprints(initial.fingerprints) });
    await db.collection(OCCURRENCE_STATES).doc(occurrenceStateId(actor)).delete(); await occurrenceDueRef(db, actor).delete();
    await db.collection('meter_device_tips_v1').doc('public-old-device').set({ actor_id: actor, accepted_at_ms: last });
    const plan = await prepareMintOnceClaim(db, { kind: 'commit', subjectId: actor, eventId: 'a'.repeat(40), userId: actor, peId: 'pe_old_owner', nowMs: last });
    await db.runTransaction(async txn => { applyMintOnceClaimDecision(db, txn, await inspectPreparedMintOnceClaimInTransaction(db, txn, plan)); });
    const ref = db.collection(plan.claim_collection).doc(plan.evidence.claim.claim_id), before = (await ref.get()).data();
    const result = await cutoverMeterCostStorage(db, true, now); expect(result.actors).toBe(1); expect(result.fingerprints).toBe(2); expect((await ref.get()).data()).toEqual(before); expect((await root.get()).get('members')).toBeUndefined();
    expect((await db.collection(OCCURRENCE_STATES).doc(occurrenceStateId(actor)).get()).get('last_active_at_ms')).toBe(last);
    expect(result.counter_cutover).toEqual({ packed_from_day: '2026-10-31', legacy_seed_through_day: '2026-11-01' });
    const again = await cutoverMeterCostStorage(db, true, now + 1000); expect(again.repacked).toBe(0); expect(again.initialized).toBe(0); expect(again.carried).toMatchObject({ added: 0 });
    expect((await db.collection(OCCURRENCE_STATES).doc(occurrenceStateId(actor)).get()).get('last_active_at_ms')).toBe(last); expect(await new BatchOccurrences(db).claim(actor, event)).toBe(false);
  });
});
