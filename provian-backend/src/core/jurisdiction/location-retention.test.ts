jest.unmock('./mint-compliance');
jest.unmock('./location-retention');
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { observeWalletSession, observeActorSession, evaluateMintCompliance, SESSION_COLLECTION } from './mint-compliance';
import { complianceRetentionDeadline, planComplianceRetention, prepareComplianceRetention,
  retainComplianceDecision, retainComplianceDecisions, deleteWalletLocation, purgeExpiredWalletLocations, COMPLIANCE_EVENTS_COLLECTION } from './location-retention';
const ADDRESS = `0x${'ab'.repeat(20)}`;
const OTHER = `0x${'cd'.repeat(20)}`;
const T0 = Date.parse('2026-11-02T12:34:56Z');
const UNTIL = Date.parse('2036-11-02T12:34:56Z');
const row = { userId: 'person', mint_status: 'pending_compliance', jurisdiction_compliance_reason: 'jurisdiction_blocked' };
function setup(options?: Parameters<typeof createFakeFirestore>[0]) {
  const fake = createFakeFirestore(options);
  const db = fake as unknown as Firestore;
  fake.store.set('wallets/human', { user_id: 'person', type: 'human', address: ADDRESS });
  fake.store.set(`${SESSION_COLLECTION}/${ADDRESS}`, { address: ADDRESS, country: 'IR', region: 'IR-Tehran', database: 'dbip', observed_at_ms: T0 - 100 });
  return { fake, db };
}
async function seal(db: Firestore, id: string, atMs: number, r: Record<string, unknown> = row): Promise<void> {
  const plans = await planComplianceRetention(db, id, r, atMs);
  await db.runTransaction(async txn => {
    const retain = await prepareComplianceRetention(db, txn, plans, atMs);
    retain();
    txn.set(db.collection('pe_history').doc(id), r);
  });
}
it('uses ten calendar years including the leap-day boundary', () => {
  expect(complianceRetentionDeadline(T0)).toBe(UNTIL);
  expect(complianceRetentionDeadline(Date.parse('2024-02-29T01:02:03Z'))).toBe(Date.parse('2034-02-28T01:02:03Z'));
  expect(() => complianceRetentionDeadline(NaN)).toThrow('invalid_compliance_event_time');
});
it.each(['jurisdiction_blocked', 'jurisdiction_unknown', 'sdn_unavailable', 'jurisdiction_deferred', 'sdn_hit'])(
  'keeps an actual %s hold/denial until the fixed deadline and deletes at expiry', async reason => {
    const { fake, db } = setup();
    const status = reason === 'sdn_hit' ? 'ineligible' : reason === 'jurisdiction_deferred' ? 'deferred' : 'pending_compliance';
    await seal(db, 'work', T0, { ...row, mint_status: status, jurisdiction_compliance_reason: reason });
    expect(fake.store.get(`${SESSION_COLLECTION}/${ADDRESS}`)?.retention_until_ms).toBe(UNTIL);
    expect(await deleteWalletLocation(db, ADDRESS, T0 + 1)).toBe(false);
    expect(await purgeExpiredWalletLocations(db, UNTIL - 1)).toEqual({ scanned: 0, deleted: 0, erased_copy_events: 0 });
    expect(fake.store.get(`${SESSION_COLLECTION}/${ADDRESS}`)?.country).toBe('IR');
    expect(await purgeExpiredWalletLocations(db, UNTIL)).toEqual({ scanned: 1, deleted: 1, erased_copy_events: 1 });
    expect(fake.store.has(`${SESSION_COLLECTION}/${ADDRESS}`)).toBe(false);
    // An old pending act cannot resurrect location or start another ten years on retry.
    await seal(db, 'work', UNTIL + 1, { ...row, mint_status: status, jurisdiction_compliance_reason: reason });
    expect(fake.store.has(`${SESSION_COLLECTION}/${ADDRESS}`)).toBe(false);
  });
it('ordinary, record-only and unrelated terminal rows do not qualify', async () => {
  const { fake, db } = setup();
  for (const r of [{ ...row, mint_status: 'eligible' }, { ...row, mint_status: 'record_only' },
    { ...row, mint_status: 'ineligible', jurisdiction_compliance_reason: 'sdn_hit', jurisdiction_mint_held: false }]) {
    await seal(db, `not-held-${r.mint_status}`, T0, r);
  }
  expect(fake.store.get(`${SESSION_COLLECTION}/${ADDRESS}`)?.retention_until_ms).toBeUndefined();
  expect(await deleteWalletLocation(db, ADDRESS, T0)).toBe(true);
  expect(fake.store.has(`${SESSION_COLLECTION}/${ADDRESS}`)).toBe(false);
});
it('new authenticated observations do not restart the clock; new acts can extend it', async () => {
  const { fake, db } = setup();
  await seal(db, 'first', T0);
  await observeWalletSession(db, { ip: '8.8.8.8' }, [ADDRESS]);
  expect(fake.store.get(`${SESSION_COLLECTION}/${ADDRESS}`)).toMatchObject({ country: 'US', retention_until_ms: UNTIL });
  await seal(db, 'first', T0 + 1_000_000);
  expect(fake.store.get(`${SESSION_COLLECTION}/${ADDRESS}`)?.retention_until_ms).toBe(UNTIL);
  await seal(db, 'second', T0 + 10_000);
  expect(fake.store.get(`${SESSION_COLLECTION}/${ADDRESS}`)?.retention_until_ms).toBe(UNTIL + 10_000);
});
it('the mint disposition and retention deadline roll back together on write failure', async () => {
  const { fake, db } = setup({ failTxnWriteTo: 'pe_history' });
  await expect(seal(db, 'work', T0)).rejects.toThrow();
  expect(fake.store.get(`${SESSION_COLLECTION}/${ADDRESS}`)?.retention_until_ms).toBeUndefined();
  expect([...fake.store.keys()].filter(k => k.startsWith(`${COMPLIANCE_EVENTS_COLLECTION}/`))).toHaveLength(0);
});
it('both actor and beneficiary observations qualify; unrelated wallets do not', async () => {
  const { fake, db } = setup();
  fake.store.set(`${SESSION_COLLECTION}/${OTHER}`, { address: OTHER, country: 'CN', observed_at_ms: T0 });
  const bystander = `0x${'ef'.repeat(20)}`;
  fake.store.set(`${SESSION_COLLECTION}/${bystander}`, { address: bystander, country: 'US', observed_at_ms: T0 });
  await seal(db, 'work', T0, { ...row, beneficiary_routing_snapshot: { human_address: OTHER } });
  expect(fake.store.get(`${SESSION_COLLECTION}/${OTHER}`)?.retention_until_ms).toBe(UNTIL);
  expect(fake.store.get(`${SESSION_COLLECTION}/${bystander}`)?.retention_until_ms).toBeUndefined();
});
it('settlement/recovery refusals use the first decision time and clear decisions retain nothing', async () => {
  const { fake, db } = setup();
  const decision = { policy: 'blocked' as const, reason: 'sdn_hit' as const, actor_country: null, actor_region: null, deferred_context: null };
  await retainComplianceDecision(db, 'claim:real', { userId: 'person' }, decision, T0);
  await retainComplianceDecision(db, 'claim:real', { userId: 'person' }, decision, T0 + 10_000);
  expect(fake.store.get(`${SESSION_COLLECTION}/${ADDRESS}`)?.retention_until_ms).toBe(UNTIL);
  await retainComplianceDecision(db, 'claim:clear', { userId: 'person' }, { ...decision, policy: 'immediate', reason: 'clear' }, T0);
  expect([...fake.store.keys()].filter(k => k.startsWith(`${COMPLIANCE_EVENTS_COLLECTION}/`))).toHaveLength(1);
});
it('expiry rechecks its transaction after a concurrent new hold', async () => {
  const { fake, db } = setup({ retryFirstTxn: { beforeRetry: store => {
    store.set(`${SESSION_COLLECTION}/${ADDRESS}`, { ...store.get(`${SESSION_COLLECTION}/${ADDRESS}`), retention_until_ms: UNTIL + 1_000 });
  } } });
  fake.store.set(`${SESSION_COLLECTION}/${ADDRESS}`, { ...fake.store.get(`${SESSION_COLLECTION}/${ADDRESS}`), retention_until_ms: UNTIL });
  expect(await purgeExpiredWalletLocations(db, UNTIL)).toEqual({ scanned: 1, deleted: 0, erased_copy_events: 0 });
  expect(fake.store.has(`${SESSION_COLLECTION}/${ADDRESS}`)).toBe(true);
});
it('release fences an observation transaction retried after deletion', async () => {
  const { fake, db } = setup({ retryFirstTxn: { beforeRetry: store => {
    store.set('wallets/human', { ...store.get('wallets/human'), released_at_ms: T0 });
    store.delete(`${SESSION_COLLECTION}/${ADDRESS}`);
  } } });
  await observeWalletSession(db, { ip: '8.8.8.8' }, [ADDRESS]);
  expect(fake.store.has(`${SESSION_COLLECTION}/${ADDRESS}`)).toBe(false);
});
it('expiry deletion is independent of account deletion and bounded', async () => {
  const { fake, db } = setup();
  for (let i = 0; i < 405; i++) fake.store.set(`${SESSION_COLLECTION}/due-${i}`, { retention_until_ms: T0 });
  expect(await purgeExpiredWalletLocations(db, T0)).toEqual({ scanned: 400, deleted: 400, erased_copy_events: 0 });
  expect(await purgeExpiredWalletLocations(db, T0)).toEqual({ scanned: 5, deleted: 5, erased_copy_events: 0 });
  expect(fake.store.has(`${SESSION_COLLECTION}/${ADDRESS}`)).toBe(true);
});
it('evaluating policy without a mint attempt does not create a retention exception', async () => {
  const { fake, db } = setup();
  await evaluateMintCompliance('person', null, db, T0);
  expect(fake.store.get(`${SESSION_COLLECTION}/${ADDRESS}`)?.retention_until_ms).toBeUndefined();
});

it('changing refusal reason and folding the same mint into claims never restarts its clock', async () => {
  const { fake, db } = setup();
  await seal(db, 'work', T0, { ...row, jurisdiction_compliance_reason: 'jurisdiction_unknown' });
  const decision = { policy: 'blocked' as const, reason: 'sdn_hit' as const, actor_country: null, actor_region: null, deferred_context: null };
  await retainComplianceDecisions(db, ['work', 'work'], { userId: 'person' }, decision, T0 + 60_000);
  expect(fake.store.get(`${SESSION_COLLECTION}/${ADDRESS}`)?.retention_until_ms).toBe(UNTIL);
  expect([...fake.store.keys()].filter(k => k.startsWith(`${COMPLIANCE_EVENTS_COLLECTION}/`))).toHaveLength(1);
});

it('authenticated checksum-address wallets cannot recreate observations after release', async () => {
  const { fake, db } = setup({ retryFirstTxn: { beforeRetry: store => {
    store.set('wallets/human', { ...store.get('wallets/human'), released_at_ms: T0 });
    store.delete(`${SESSION_COLLECTION}/${ADDRESS}`);
  } } });
  fake.store.set('wallets/human', { user_id: 'person', type: 'human', address: '0x' + 'aB'.repeat(20) });
  await observeActorSession(db, { ip: '8.8.8.8' }, 'person');
  expect(fake.store.has(`${SESSION_COLLECTION}/${ADDRESS}`)).toBe(false);
});

it('fresh same-country authentication drops expired TTL instead of coalescing it', async () => {
  const { fake, db } = setup();
  const now = Date.now();
  fake.store.set(`${SESSION_COLLECTION}/${ADDRESS}`, { address: ADDRESS, country: 'US', region: 'US-California', database: 'dbip-city-lite-2026-11', observed_at_ms: now - 60_000, retention_until_ms: now - 1, expire_at: 'expired' });
  await observeActorSession(db, { ip: '8.8.8.8' }, 'person');
  const after = fake.store.get(`${SESSION_COLLECTION}/${ADDRESS}`)!;
  expect(after.country).toBe('US');
  expect(after.observed_at_ms).toBeGreaterThanOrEqual(now);
  expect(after.retention_until_ms).toBeUndefined(); expect(after.expire_at).toBeUndefined();
});
