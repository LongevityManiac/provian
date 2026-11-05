jest.unmock('./mint-compliance');
import { createHash } from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { deleteOwnerMeterState } from '../meter/owner-reads';
import { beginLocationErasure, eraseActorLocationCopies, prepareLocationCopyFence } from './location-copy-erasure';
import { COMPLIANCE_EVENTS_COLLECTION, complianceRetentionDeadline, planComplianceRetention, prepareComplianceRetention, purgeExpiredWalletLocations } from './location-retention';
import { SESSION_COLLECTION } from './mint-compliance';
const T0 = Date.parse('2026-11-02T12:00:00Z');
const UNTIL = complianceRetentionDeadline(T0);
const ADDRESS = `0x${'ab'.repeat(20)}`;
function setup() {
  const fake = createFakeFirestore(), db = fake as unknown as Firestore;
  fake.store.set('wallets/human', { user_id: 'person', type: 'human', address: ADDRESS });
  const row = (id: string) => ({ peId: id, userId: 'person', mint_status: 'eligible', jurisdiction_context: 'US', jurisdiction_region: 'US-Texas', economic_snapshot: { recordPointsAtomic: '987654321000000000000' }, economic_snapshot_hash: 'original-seal' });
  fake.store.set('pe_history/legacy', row('legacy'));
  fake.store.set('meter_act_keys_v1/key', { actor_id: 'person', row: row('key') });
  fake.store.set('meter_held_acts_v1/held', { actor_id: 'person', key: { row: row('held') } });
  fake.store.set('meter_batch_acts_v1/page', { actor_id: 'person', acts: { first: { row: row('first') }, second: { row: row('second') } } });
  fake.store.set('meter_act_keys_v1/other', { actor_id: 'other', row: { ...row('other'), userId: 'other' } });
  return { fake, db, row };
}
it('ordinary deletion scrubs all four homes, keeps exact sealed values, and cannot touch another actor', async () => {
  const { fake, db } = setup();
  const untouched = fake.store.get('meter_act_keys_v1/other');
  // RED population has five actual country/region copies before the production scrubber runs.
  expect(JSON.stringify([...fake.store.values()]).match(/US-Texas/g)).toHaveLength(6);
  await beginLocationErasure(db, 'person', 0, T0);
  expect(await eraseActorLocationCopies(db, 'person', T0)).toBe(4);
  await deleteOwnerMeterState(db, 'person');
  const rows = [fake.store.get('pe_history/legacy'), fake.store.get('meter_act_keys_v1/key')?.row,
    (fake.store.get('meter_held_acts_v1/held')?.key as { row: unknown })?.row,
    ...(Object.values(fake.store.get('meter_batch_acts_v1/page')?.acts as Record<string, { row: unknown }>).map(x => x.row))];
  expect(rows).toHaveLength(5);
  for (const row of rows) expect(row).toMatchObject({ jurisdiction_context: '', jurisdiction_region: null, economic_snapshot: { recordPointsAtomic: '987654321000000000000' }, economic_snapshot_hash: 'original-seal' });
  expect(fake.store.get('meter_act_keys_v1/other')).toEqual(untouched);
});
it('the deletion fence scrubs a delayed seal inside its transaction', async () => {
  const { fake, db, row } = setup();
  await beginLocationErasure(db, 'person', 0, T0);
  const late = row('late');
  await db.runTransaction(async txn => { await prepareLocationCopyFence(db, txn, 'person', [late], T0); txn.set(db.collection('pe_history').doc('late'), late); });
  expect(fake.store.get('pe_history/late')).toMatchObject({ jurisdiction_context: '', jurisdiction_region: null, economic_snapshot_hash: 'original-seal' });
});
it('expiry scrubs retained copies even when Firestore TTL already removed the session', async () => {
  const { fake, db } = setup();
  const held = { peId: 'key', userId: 'person', mint_status: 'pending_compliance', jurisdiction_compliance_reason: 'jurisdiction_blocked' };
  const plans = await planComplianceRetention(db, 'key', held, T0);
  await db.runTransaction(async txn => { const commit = await prepareComplianceRetention(db, txn, plans, T0); commit(); });
  await beginLocationErasure(db, 'person', UNTIL, T0 + 1);
  fake.store.delete(`${SESSION_COLLECTION}/${ADDRESS}`);
  expect(await purgeExpiredWalletLocations(db, UNTIL)).toEqual({ scanned: 0, deleted: 0, erased_copy_events: 1 });
  expect(fake.store.get('meter_act_keys_v1/key')?.row).toMatchObject({ jurisdiction_context: '', jurisdiction_region: null, economic_snapshot_hash: 'original-seal' });
  expect(fake.store.get('pe_history/legacy')).toMatchObject({ jurisdiction_context: '', jurisdiction_region: null });
  const event = fake.store.get(`${COMPLIANCE_EVENTS_COLLECTION}/${createHash('sha256').update('key').digest('hex')}`)!;
  expect(event.held_at_ms).toBe(T0);
  expect(event.pe_id).toBeUndefined(); expect(event.actor_id).toBeUndefined();
  expect(event.location_copies_erased_at_ms).toBe(UNTIL);
});
it('an expired mint cannot restore its geographic copy, while a different unexpired hold stays intact', async () => {
  const { fake, db, row } = setup();
  const id = createHash('sha256').update('expired').digest('hex');
  fake.store.set(`${COMPLIANCE_EVENTS_COLLECTION}/${id}`, { held_at_ms: T0, location_copies_erased_at_ms: UNTIL });
  const expired = row('expired'), other = row('other-hold');
  await db.runTransaction(async txn => { await prepareLocationCopyFence(db, txn, 'person', [expired, other], UNTIL, true); });
  expect(expired.jurisdiction_context).toBe(''); expect(expired.jurisdiction_region).toBeNull();
  expect(other.jurisdiction_context).toBe('US');
});
it('compliance and deferred holds keep their nonzero sealed value through account deletion', async () => {
  const { fake, db, row } = setup();
  for (const status of ['pending_compliance', 'deferred']) {
    fake.store.set(`meter_held_acts_v1/${status}`, { actor_id: 'person', key: { row: { ...row(status), mint_status: status } } });
  }
  await deleteOwnerMeterState(db, 'person');
  for (const status of ['pending_compliance', 'deferred']) expect((fake.store.get(`meter_held_acts_v1/${status}`)?.key as { row: unknown }).row)
    .toMatchObject({ mint_status: status, economic_snapshot: { recordPointsAtomic: '987654321000000000000' } });
});
it('a real new hold racing expiry preserves its binding, while the expired mint is scrubbed', async () => {
  const { fake, db, row } = setup();
  const held = { ...row('key'), mint_status: 'pending_compliance', jurisdiction_compliance_reason: 'jurisdiction_blocked' };
  const plans = await planComplianceRetention(db, 'key', held, T0);
  await db.runTransaction(async txn => { const commit = await prepareComplianceRetention(db, txn, plans, T0); commit(); });
  await beginLocationErasure(db, 'person', UNTIL, T0 + 1);
  const run = fake.runTransaction.bind(fake);
  let armed = true;
  fake.runTransaction = async callback => {
    if (armed) {
      armed = false;
      const fresh = { ...row('fresh'), mint_status: 'pending_compliance', jurisdiction_compliance_reason: 'jurisdiction_blocked', jurisdiction_context: 'IR', jurisdiction_region: 'IR-Tehran' };
      const newPlans = await planComplianceRetention(db, 'fresh', fresh, UNTIL);
      await run(async txn => {
        const commit = await prepareComplianceRetention(db, txn as unknown as FirebaseFirestore.Transaction, newPlans, UNTIL);
        commit(); txn.set(fake.collection('meter_act_keys_v1').doc('fresh'), { actor_id: 'person', row: fresh });
      });
    }
    return run(callback);
  };
  await purgeExpiredWalletLocations(db, UNTIL);
  expect(fake.store.get('meter_act_keys_v1/fresh')?.row).toMatchObject({ jurisdiction_context: 'IR', jurisdiction_region: 'IR-Tehran', economic_snapshot_hash: 'original-seal' });
  expect(fake.store.get('meter_act_keys_v1/key')?.row).toMatchObject({ jurisdiction_context: '', jurisdiction_region: null });
});
it('the deletion fence reads a hold committed after its caller read the old deadline', async () => {
  const { db, row } = setup();
  const held = { ...row('key'), mint_status: 'pending_compliance', jurisdiction_compliance_reason: 'jurisdiction_blocked' };
  const plans = await planComplianceRetention(db, 'key', held, T0);
  await db.runTransaction(async txn => { const commit = await prepareComplianceRetention(db, txn, plans, T0); commit(); });
  expect(await beginLocationErasure(db, 'person', 0, T0 + 1)).toBe(UNTIL);
  expect(await eraseActorLocationCopies(db, 'person', T0 + 1)).toBe(0);
});
