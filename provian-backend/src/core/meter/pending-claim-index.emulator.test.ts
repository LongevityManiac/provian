import { Firestore } from 'firebase-admin/firestore';
import { randomUUID, createHash } from 'crypto';
import { privateFirestore } from '../provenance/private-store';
import { aggregateWindowClaims, buildPendingClaim, meterBatchClaimKey, meterBatchClaimId, meterActClaimId, meterActClaimKey } from './meter-claims';
import { carryPendingClaimIndex, createIndexedMeterClaim, PENDING_PAYEES, PENDING_READY } from './pending-claim-index';
import { runMeterClaimInlet } from './meter-settlement';
import { METER_PENDING_CLAIMS_COLLECTION as CLAIMS } from './meter-store';
jest.setTimeout(60_000);
const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('bounded readiness routing: reads only claims for due payees whose work is ready', () => {
  let raw: Firestore, db: Firestore;
  const now = 1_800_000_000_000, contributor = '0x' + 'a'.repeat(40), oldSecret = process.env.RELAY_SIGNING_KEY;
  beforeAll(async () => {
    process.env.RELAY_SIGNING_KEY = 'public-ready-index-emulator-key';
    raw = new Firestore({ projectId: 'demo-ready-index', databaseId: 'ready-' + randomUUID().slice(0, 8) });
    await raw.collection('private_retention_state_v1').doc('d554').set({ opaque_ids_ready: true, opaque_records_complete: true }); db = privateFirestore(raw);
  });
  afterAll(async () => { await raw.terminate(); if (oldSecret === undefined) delete process.env.RELAY_SIGNING_KEY; else process.env.RELAY_SIGNING_KEY = oldSecret; });
  function claim(i: number, ready = 0) {
    const identity = { batch_hash: createHash('sha256').update('batch' + i).digest('hex'), leg: 'sole' as const, contributor, beneficiary_class: 1 };
    return buildPendingClaim({ ...identity, claim_key: meterBatchClaimKey(identity), claim_id: meterBatchClaimId(identity), unit: 'batch', device_id: 'device', actor_id: 'agent',
      acts: [{ relay_pe_id: 'pe_' + i, points_atomic: '1000' }], record_points_atomic: '1000', created_at_ms: now - 1000, ready_at_ms: ready });
  }
  function reads() {
    let pending = 0; const original = (raw as any).requestStream;
    const spy = jest.spyOn(raw as any, 'requestStream').mockImplementation(async function(this: unknown, ...args: any[]) {
      const stream = await original.apply(raw, args), emit = stream.emit.bind(stream);
      stream.emit = (event: string, chunk: any, ...rest: unknown[]) => {
        const name = chunk?.document?.name ?? chunk?.found?.name ?? chunk?.missing;
        if (event === 'data' && typeof name === 'string' && name.includes('/documents/' + CLAIMS + '/')) pending++;
        return emit(event, chunk, ...rest);
      }; return stream;
    }); return { count: () => pending, stop: () => spy.mockRestore() };
  }
  it('RED full scan reads80 waiting claims; certified index reads zero claims for a payee not due and then only two ready claims', async () => {
    const batch = db.batch();
    for (let i = 0; i < 80; i++) batch.create(db.collection(CLAIMS).doc(claim(i).claim_key), claim(i, i < 2 ? 0 : now + 86400000));
    await batch.commit(); const old = reads();
    const fallback = await runMeterClaimInlet(db, { nowMs: now, payeeDue: async () => false }); old.stop();
    expect(fallback.scanned).toBe(80); expect(old.count()).toBeGreaterThanOrEqual(80);
    expect(await carryPendingClaimIndex(db)).toBe(80); expect(await carryPendingClaimIndex(db)).toBe(0);
    const idle = reads(); const none = await runMeterClaimInlet(db, { nowMs: now, payeeDue: async () => false }); idle.stop();
    expect(none.scanned).toBe(0); expect(idle.count()).toBe(0);
    const due = reads(); const paid = await runMeterClaimInlet(db, { nowMs: now, payeeDue: async () => true }); due.stop();
    expect(paid.scanned).toBe(2); expect(paid.aggregated).toBe(2); expect(paid.registered).toBe(1); expect(due.count()).toBeLessThan(15);
    expect((await runMeterClaimInlet(db, { nowMs: now, payeeDue: async () => true })).scanned).toBe(0);
    const later = await runMeterClaimInlet(db, { nowMs: now + 86400000, payeeDue: async () => true });
    expect(later.scanned).toBe(78); expect(later.aggregated).toBe(78);
    expect((await db.collection(PENDING_PAYEES).where('count', '>', 0).get()).empty).toBe(true);
    expect((await db.collection(PENDING_READY).get()).empty).toBe(true);
  });
  it('two simultaneous producers retain both claims without an unbounded payee map', async () => {
    await Promise.all([90, 91].map(i => db.runTransaction(async txn => {
      const value = claim(i); createIndexedMeterClaim(db, txn, db.collection(CLAIMS).doc(value.claim_key), value);
    })));
    const heads = await db.collection(PENDING_PAYEES).where('count', '>', 0).get(); expect(heads.docs).toHaveLength(1); expect(heads.docs[0].get('count')).toBe(2);
    expect(heads.docs[0].get('claims')).toBeUndefined();
    const paid = await runMeterClaimInlet(db, { nowMs: now, payeeDue: async () => true }); expect(paid.aggregated).toBe(2);
  });
  it('preserves original payout grouping across more than500 physical writes', async () => {
    for (let start = 1000; start < 1260; start += 50) {
      const writer = db.batch(); for (let i = start; i < Math.min(start + 50, 1260); i++) { const value = claim(i); createIndexedMeterClaim(db, writer, db.collection(CLAIMS).doc(value.claim_key), value); } await writer.commit();
    }
    const result = await runMeterClaimInlet(db, { nowMs: now, payeeDue: async () => true }); expect(result.aggregated).toBe(260); expect(result.registered).toBe(1);
    expect((await db.collection(PENDING_READY).get()).empty).toBe(true); expect((await db.collection(PENDING_PAYEES).where('count', '>', 0).get()).empty).toBe(true);
    const ledger = await db.collection('pvt9_claim_ledger_v1').where('settled', '==', false).get();
    expect(ledger.docs.filter(d => Number(d.get('created_at')) === now).map(d => d.get('record_points_atomic')).reduce((n, value) => n + BigInt(value), 0n)).toBeGreaterThanOrEqual(260000n);
  });
  it('takes large partial-window groups atomically and leaves only their unready halves indexed', async () => {
    for (let first = 3000; first < 3260; first += 50) {
      const writer = db.batch(); for (let i = first; i < Math.min(first + 50, 3260); i++) {
        const hash = createHash('sha256').update('window' + i).digest('hex');
        const leg = { leg: 'sole' as const, contributor, beneficiary_class: 1, bps: 10000, points_atomic: '1000' };
        const value = aggregateWindowClaims({ batch_hash: hash, device_id: 'device', actor_id: 'agent', created_at_ms: now - 1000, acts: [
          { relay_pe_id: 'pe_ready_' + i, legs: [leg], ready_at_ms: now - 1 }, { relay_pe_id: 'pe_waiting_' + i, legs: [leg], ready_at_ms: now + 1000 },
        ] })[0]; createIndexedMeterClaim(db, writer, db.collection(CLAIMS).doc(value.claim_key), value);
      } await writer.commit();
    }
    const result = await runMeterClaimInlet(db, { nowMs: now, payeeDue: async () => true }); expect(result.aggregated).toBe(260); expect(result.registered).toBe(1);
    expect((await runMeterClaimInlet(db, { nowMs: now, payeeDue: async () => true })).scanned).toBe(0);
    expect((await db.collection(PENDING_READY).get()).size).toBe(260);
    const later = await runMeterClaimInlet(db, { nowMs: now + 1000, payeeDue: async () => true }); expect(later.aggregated).toBe(260); expect((await db.collection(PENDING_READY).get()).empty).toBe(true);
  });
  it('concurrent inlet finalization never decrements an indexed payout twice', async () => {
    const writer = db.batch(); for (const i of [2000, 2001]) { const value = claim(i); createIndexedMeterClaim(db, writer, db.collection(CLAIMS).doc(value.claim_key), value); } await writer.commit();
    await Promise.all([runMeterClaimInlet(db, { nowMs: now, payeeDue: async () => true }), runMeterClaimInlet(db, { nowMs: now, payeeDue: async () => true })]);
    expect((await db.collection(PENDING_READY).get()).empty).toBe(true); expect((await db.collection(PENDING_PAYEES).get()).docs.every(d => d.get('count') === 0)).toBe(true);
  });
  it('RED legacy migrated claims remain immediately ready even when their old takeover date lies in the future', async () => {
    const pe = 'pe_legacy_ready', identity = { id: pe, prev_hash: 'genesis', hash: 'a'.repeat(64), timestamp: now - 1000, action_type: 'coding_session', user_id: 'agent' };
    const value = buildPendingClaim({ claim_key: meterActClaimKey(pe, 'sole'), unit: 'act', batch_hash: 'legacy_pre_meter', device_id: 'legacy:agent', actor_id: 'agent', leg: 'sole', contributor,
      beneficiary_class: 1, record_points_atomic: '1000', acts: [{ relay_pe_id: pe, points_atomic: '1000' }], claim_id: meterActClaimId(identity, 'sole'), act_identity: identity, created_at_ms: 1, ready_at_ms: now + 3 * 86400000 });
    await db.runTransaction(async txn => { createIndexedMeterClaim(db, txn, db.collection(CLAIMS).doc(value.claim_key), value); });
    const result = await runMeterClaimInlet(db, { nowMs: now, payeeDue: async () => true }); expect(result.aggregated).toBe(1);
  });
});
