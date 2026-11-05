import { createHash } from 'crypto';
import { BatchOccurrences, BATCH_OCCURRENCES_COLLECTION } from './batch-occurrences';
import { NoveltyCounterConflictError } from './batch-pricing-counters';
import { prepareDeviceOccurrenceMintClaim, singleLaneOccurrenceClaimHook } from '../pvt/device-occurrence-claim';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('batch occurrence membership — exact actor-wide mint-once', () => {
  let db: Firestore;
  const app = initializeApp({ projectId: 'demo-batch-occurrences-' + Date.now() }, 'batch-occurrence-tests');
  const actor = 'actor-' + Date.now();
  const hash = (v: string): string => createHash('sha256').update(v).digest('hex');
  beforeAll(() => { process.env.RELAY_SIGNING_KEY = 'batch-occurrence-test-key'; db = getFirestore(app); });
  afterAll(async () => { await deleteApp(app); });
  async function commit(batch: BatchOccurrences): Promise<void> {
    await db.runTransaction(async txn => { await batch.inspect(txn); batch.commit(txn); });
  }
  it('second sighting in a batch or another device/batch earns zero, independent of submitted date', async () => {
    const first = new BatchOccurrences(db);
    expect(await first.claim(actor, hash('same-turn'))).toBe(true);
    expect(await first.claim(actor, hash('same-turn'))).toBe(false);
    await commit(first);
    const secondDevice = new BatchOccurrences(db);
    expect(await secondDevice.claim(actor, hash('same-turn'))).toBe(false);
    // RED control: real distinct work remains payable; this is not a deny-everything guard.
    expect(await secondDevice.claim(actor, hash('another-turn'))).toBe(true);
    expect(await secondDevice.claim(actor + '-other', hash('same-turn'))).toBe(true);
    await commit(secondDevice);
    const old = await db.collection('device_occurrence_mint_claims').where('owner_user_id', '==', actor).get();
    expect(old.empty).toBe(true);
    const packed = await db.collection(BATCH_OCCURRENCES_COLLECTION).where('actor_id', '==', actor).get();
    expect(packed.docs).toHaveLength(1);
    expect(packed.docs[0].data().fingerprints).toHaveLength(64);
    expect(packed.docs[0].data().expire_at).toBeUndefined();
  });
  it('two racing devices cannot commit their independently priced first sighting', async () => {
    const a = new BatchOccurrences(db), b = new BatchOccurrences(db);
    expect(await a.claim(actor, hash('race'))).toBe(true);
    expect(await b.claim(actor, hash('race'))).toBe(true);
    await commit(a);
    await expect(commit(b)).rejects.toBeInstanceOf(NoveltyCounterConflictError);
    expect(await new BatchOccurrences(db).claim(actor, hash('race'))).toBe(false);
  });
  it('pre-cutover occurrence claims still block a new device without migration', async () => {
    const event = hash('legacy-turn');
    const plan = await prepareDeviceOccurrenceMintClaim(db, actor, event, 'pe_legacy', Date.now());
    const hook = singleLaneOccurrenceClaimHook(db, plan, Date.now());
    await db.runTransaction(async txn => { await hook.inspect(txn); hook.commit(txn); });
    expect(await new BatchOccurrences(db).claim(actor, event)).toBe(false);
  });
  it('packed leaves split without dropping memberships', async () => {
    const manyActor = actor + '-many';
    for (let start = 0; start < 28_100; start += 500) {
      const batch = new BatchOccurrences(db);
      for (let i = start; i < Math.min(start + 500, 28_100); i++) expect(await batch.claim(manyActor, hash('turn-' + i))).toBe(true);
      await commit(batch);
    }
    const after = new BatchOccurrences(db);
    for (const i of [0, 500, 27_999, 28_099]) expect(await after.claim(manyActor, hash('turn-' + i))).toBe(false);
    expect(await after.claim(manyActor, hash('turn-28100'))).toBe(true);
    await commit(after);
  });
  it('carries live claim digests before their original TTL expires, without touching the claim or act rows', async () => {
    const { carryOccurrenceDigests } = await import('./carry-occurrence-digests');
    const event = hash('carry-before-ttl');
    const plan = await prepareDeviceOccurrenceMintClaim(db, actor, event, 'pe_old_paid', Date.now());
    const hook = singleLaneOccurrenceClaimHook(db, plan, Date.now());
    await db.runTransaction(async txn => { await hook.inspect(txn); hook.commit(txn); });
    const ref = db.collection(plan.claim_collection).doc(plan.evidence.claim.claim_id);
    const before = (await ref.get()).data();
    await expect(carryOccurrenceDigests(db, false)).rejects.toThrow('occurrence_carry_requires_old_writers_drained');
    const report = await carryOccurrenceDigests(db, true);
    expect(report.claims).toBeGreaterThan(0);
    expect(report.added).toBeGreaterThan(0);
    expect((await ref.get()).data()).toEqual(before);
    // RED: even once TTL physically removes the only old claim, another device cannot earn it.
    await ref.delete();
    expect(await new BatchOccurrences(db).claim(actor, event)).toBe(false);
    expect((await carryOccurrenceDigests(db, true)).added).toBe(0);
  });
  it('preserves live hard cross-witness keys and their expired ownership without extending old TTLs', async () => {
    const { prepareMintOnceClaim, inspectPreparedMintOnceClaimInTransaction, applyMintOnceClaimDecision, ClosedCrossWitnessOccurrenceError } = await import('../pvt/mint-once-claim');
    const { carryOccurrenceDigests } = await import('./carry-occurrence-digests');
    const { Timestamp } = await import('firebase-admin/firestore');
    const address = '0x' + 'a'.repeat(40), tx = '0x' + 'b'.repeat(64);
    const entries = [
      { kind: 'commit' as const, subjectId: actor, eventId: 'a'.repeat(40) },
      { kind: 'completion' as const, subjectId: actor, eventId: 'human_job:hjob_test' },
      { kind: 'x402' as const, subjectId: address, eventId: tx },
      { kind: 'financial_settlement' as const, subjectId: address, eventId: '8453:' + tx + ':0' },
      { kind: 'occurrence' as const, subjectId: address, eventId: 'test-occurrence-123' },
    ];
    for (const entry of entries) {
      const input = { ...entry, userId: actor, peId: 'pe_first_' + entry.kind, nowMs: Date.now() };
      const plan = await prepareMintOnceClaim(db, input);
      await db.runTransaction(async txn => applyMintOnceClaimDecision(db, txn, await inspectPreparedMintOnceClaimInTransaction(db, txn, plan), Timestamp.fromMillis(Date.now() + 31 * 86400000)));
      const ref = db.collection(plan.claim_collection).doc(plan.evidence.claim.claim_id);
      expect((await ref.get()).data()!.expire_at).toBeUndefined(); // New hard cross-witness ownership does not expire.
      const originalTtl = Timestamp.fromMillis(Date.now() + 1000);
      await ref.update({ expire_at: originalTtl }); // Simulate an existing live pre-cutover key.
      const before = (await ref.get()).data();
      await carryOccurrenceDigests(db, true);
      expect((await ref.get()).data()).toEqual(before);
      // RED: while present, the real owner still supplies ordinary cross-witness evidence.
      expect((await prepareMintOnceClaim(db, { ...input, peId: 'pe_second' })).evidence.relation).toBe('duplicate');
      await ref.delete();
      await expect(prepareMintOnceClaim(db, { ...input, peId: 'pe_second', nowMs: Date.now() + 60 * 86400000 })).rejects.toBeInstanceOf(ClosedCrossWitnessOccurrenceError);
    }
  });
  it('carries legacy relay occurrence identity without changing its body, held inputs or TTL', async () => {
    const { carryOccurrenceDigests } = await import('./carry-occurrence-digests');
    const { relayOccurrenceDigest } = await import('./batch-occurrences');
    const { Timestamp } = await import('firebase-admin/firestore');
    const id = 'pe_legacy_relay_' + actor;
    const ref = db.collection('meter_act_keys_v1').doc(id);
    const original = { relay_pe_id:id, actor_id:actor, device_id:`relay:${actor}`, action_type:'ai_conversation',
      row:{ economic_snapshot:{ untouched:true } }, held_reason:'deferred',expire_at:Timestamp.fromMillis(Date.now()+1000) };
    await ref.set(original);
    expect((await carryOccurrenceDigests(db,true)).added).toBeGreaterThan(0);
    expect((await ref.get()).data()).toEqual(original);
    await ref.delete();
    expect(await new BatchOccurrences(db).claim(actor,relayOccurrenceDigest(id))).toBe(false);
    expect(await new BatchOccurrences(db).claim(actor,relayOccurrenceDigest(id+'-new'))).toBe(true);
    expect((await db.collection('meter_occurrence_carry_v1').doc('live').get()).data()?.relay_single_lane_complete).toBe(true);
  });
});
