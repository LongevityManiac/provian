import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { prepareDemotedMeterRetention } from './retire-demoted-meter-keys';
import type { MeterPendingClaim } from './meter-store';

it('retires new terminal keys and completed batches; unpaid siblings and old TTLs remain intact', async () => {
  const fake = createFakeFirestore(), db = fake as unknown as Firestore, now = Date.UTC(2026, 9, 30);
  for (const id of ['done', 'pending', 'legacy']) {
    fake.store.set('meter_act_keys_v1/' + id, { batch_hash: id, created_at_ms: now - 1000,
      ...(id === 'legacy' ? { expire_at: 123 } : { pending_retention_v1: true, expire_at: null }) });
    fake.store.set('meter_batches_v1/' + id, { per_batch_pricing: true, anchored: true, settlement_complete: false, expire_at: null });
    fake.store.set('meter_pending_claims_v1/' + id, { batch_hash: id, state: 'pending' });
  }
  fake.store.set('meter_pending_claims_v1/sibling', { batch_hash: 'pending', state: 'pending' });
  const overrides = new Map(['done','pending','legacy'].map(id => [id, { state: 'void' } as MeterPendingClaim]));
  await db.runTransaction(async tx => {
    const snaps = await Promise.all(['done','pending','legacy'].map(id => tx.get(db.collection('meter_act_keys_v1').doc(id))));
    const apply = await prepareDemotedMeterRetention(db, tx, snaps, overrides, now); apply();
  });
  expect(fake.store.get('meter_act_keys_v1/done')!.expire_at).not.toBeNull();
  expect(fake.store.get('meter_batches_v1/done')!.settlement_complete).toBe(true);
  expect(fake.store.get('meter_batches_v1/done')!.expire_at).not.toBeNull();
  expect(fake.store.get('meter_batches_v1/pending')!.settlement_complete).toBe(false);
  expect(fake.store.get('meter_batches_v1/pending')!.expire_at).toBeNull();
  expect(fake.store.get('meter_act_keys_v1/legacy')!.expire_at).toBe(123);
  expect(fake.store.get('meter_batches_v1/legacy')!.expire_at).toBeNull();
});
