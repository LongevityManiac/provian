import { seedMembershipJournal } from './__test-helpers__/membership-journal-fixture';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { beginPrivateMembershipTransition, openPrivateMembershipConsents, recordPrivateMembershipConsent,
  nextPrivateAddressConsent, refreshRecoveredMembershipTransition, PRIVATE_MEMBERSHIP_TRANSITIONS as T } from './private-membership-transition';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C, planPrivateDebit, reservePrivateMembership, type PrivateMembershipAccount } from './private-membership-reservation';
import { RECOURSE_COLLECTIONS as R } from './ownership';
import { readHistoricalRecoursePoolState } from './pool-state';
import { readPrivateCalendarRules } from './private-calendar-rules';
import { joinPrivateMembership, type PrivateCalendarRules } from './private-membership-calendar';
import { MEMBERSHIP_RECEIPT_ABI } from './membership-receipt';
import { fixture, a, h, old, pointer } from './__test-helpers__/membership-receipt-fixture';
import { utcCalendarMonth } from './calendar-month';
jest.mock('../onchain/rpc-provider', () => ({ getOperatorBoundRpcLegs: jest.fn() }));
jest.mock('../protocol/pointer-pin.generated', () => ({ PROTOCOL_POINTER_PIN: {
  address: '0x0000000000000000000000000000000000000001', runtimeHash: require('ethers').keccak256('0x6000'),
} }));
jest.mock('./pool-state', () => ({ readHistoricalRecoursePoolState: jest.fn() }));
jest.mock('./private-calendar-rules', () => ({ readPrivateCalendarRules: jest.fn() }));
jest.mock('./chain-ledger', () => ({ createRecourseChainPort: () => ({ finalizedBlock: async () => 99, blockHash: async () => `0x${'0'.repeat(62)}63` }) }));
const now = 1700000000, month = utcCalendarMonth(now), ownerId = h(500), ownerKey = `${R.owners}/${ownerId}`, accountKey = `${C.owners}/${ownerId}`;
const rules: PrivateCalendarRules = () => ({ ruleHash: h(9), rule: { schema: 'provian-recourse-membership/v1', chainId: 8453, pointer,
  firstMonth: 0, participationBurnAtomic: '100', noEarningsContributionAtomic: '100', earningsBps: 100 } });
function setup(joined = false) {
  const f = fixture(); f.state.priorRevision = 1; f.state.publications = []; f.state.effects = [];
  const fake = createFakeFirestore({ strictTransactionOrder: true, rejectUndefinedValues: true }), db = fake as unknown as Firestore;
  fake.store.set(ownerKey, { ownerIdentity: ownerId, bindingSetVersion: 2 });
  for (const n of [3, 4]) {
    fake.store.set(`${R.addresses}/${a(n)}`, { ownerIdentity: ownerId, address: a(n), identity: h(n), kernel: old[0], recoveryGeneration: 0, chainBindingStatus: 'confirmed' });
    fake.store.set(`${R.identities}/${h(n)}`, { ownerIdentity: ownerId, identity: h(n), recoveryGeneration: 0 });
  }
  if (joined) fake.store.set(accountKey, seedMembershipJournal(fake.store, { ownerIdentity: ownerId, version: 0, needsScan: false, pendingReservation: null,
    checkpoint: { pool: old[8], block: 99, blockHash: h(99) }, episode: joinPrivateMembership(null, month, rules) }, { chainId: '8453', kernel: old[0], pool: old[8], block: 98, blockHash: h(98), logIndex: 1, timestamp: now - 1 }));
  (readHistoricalRecoursePoolState as jest.Mock).mockImplementation(async (id: string) => ({ pool: old[8], kernel: old[0],
    block: 99, blockHash: h(99), timestamp: now, currentAddress: id === h(3) ? a(3) : a(4),
    addressConsent: joined, consentNonce: joined ? '1' : '0', consentGeneration: joined ? '1' : '0' }));
  (readPrivateCalendarRules as jest.Mock).mockResolvedValue(rules);
  const effects = (items: readonly { binding: string; joined: boolean; nonce: number; generation: number; index: number }[]) => {
    f.state.effects = items.map(e => ({ logIndex: `0x${e.index.toString(16)}`,
      ...MEMBERSHIP_RECEIPT_ABI.encodeEventLog(MEMBERSHIP_RECEIPT_ABI.getEvent('AddressConsentChanged')!, [e.binding, e.generation, e.joined, e.nonce]) }));
  };
  return { f, fake, db, effects };
}
test('first join freezes the whole portfolio and activates only after every independent address consent', async () => {
  const s = setup(), op = await beginPrivateMembershipTransition(s.db, ownerId, 'join');
  expect(s.fake.store.get(ownerKey)?.membershipTransition).toBe(op.id);
  expect(s.fake.store.has(accountKey)).toBe(false);
  expect(await beginPrivateMembershipTransition(s.db, ownerId, 'join')).toEqual(op);
  await expect(beginPrivateMembershipTransition(s.db, ownerId, 'leave')).rejects.toThrow('busy');
  const ready = await openPrivateMembershipConsents(s.db, op.id);
  expect(nextPrivateAddressConsent(ready, h(3), { revision: '1', ruleHash: h(9), timestamp: now })).toMatchObject({ binding: h(3), account: a(3), nonce: '0', joined: true });
  expect(JSON.stringify(nextPrivateAddressConsent(ready, h(3), { revision: '1', ruleHash: h(9), timestamp: now }))).not.toContain(ownerId);
  s.effects([{ binding: h(3), joined: true, nonce: 0, generation: 1, index: 5 }, { binding: h(4), joined: true, nonce: 0, generation: 1, index: 6 }]);
  const receipt = await s.f.read();
  await expect(recordPrivateMembershipConsent(s.db, op.id, { ...receipt })).rejects.toThrow('unverified');
  const complete = await recordPrivateMembershipConsent(s.db, op.id, receipt);
  expect(complete.status).toBe('complete');
  expect(s.fake.store.get(accountKey)).toMatchObject({ needsScan: true, pendingReservation: null, episode: { joined: true, admissionMonth: month } });
  expect(s.fake.store.get(ownerKey)?.membershipTransition).toBeNull();
  expect([...s.fake.store.keys()].filter(k => k.startsWith(C.effects + '/'))).toHaveLength(2);
  expect((await recordPrivateMembershipConsent(s.db, op.id, receipt)).status).toBe('complete');
});
test('a partial join cannot create a protected private episode', async () => {
  const s = setup(), op = await beginPrivateMembershipTransition(s.db, ownerId, 'join');
  await openPrivateMembershipConsents(s.db, op.id);
  s.effects([{ binding: h(3), joined: true, nonce: 0, generation: 1, index: 5 }]);
  expect((await recordPrivateMembershipConsent(s.db, op.id, await s.f.read())).status).toBe('consenting');
  expect(s.fake.store.has(accountKey)).toBe(false);
  expect(s.fake.store.get(ownerKey)?.membershipTransition).toBe(op.id);
});
test('leave closes privately after reconciliation and retained reservations cannot be newly signed during departure', async () => {
  const s = setup(true), account = s.fake.store.get(accountKey) as unknown as PrivateMembershipAccount;
  const debit = planPrivateDebit(account, { chainId: '8453', pointer, kernel: old[0], pool: old[8] }, {
    binding: h(3), payer: a(3), month: String(month), burn: '100', reserve: '0', nonce: '7', generation: '1', revision: '1', ruleHash: h(9), expiresAt: String(now + 300),
  }, month, rules);
  const op = await beginPrivateMembershipTransition(s.db, ownerId, 'leave');
  await expect(reservePrivateMembership(s.db, debit)).rejects.toThrow('transition_pending');
  const ready = await openPrivateMembershipConsents(s.db, op.id);
  expect(s.fake.store.get(accountKey)).toMatchObject({ episode: { joined: false } });
  expect(nextPrivateAddressConsent(ready, h(3), { revision: '1', ruleHash: h(9), timestamp: now })).toMatchObject({ nonce: '1', joined: false });
  s.effects([{ binding: h(3), joined: false, nonce: 1, generation: 1, index: 5 }, { binding: h(4), joined: false, nonce: 1, generation: 1, index: 6 }]);
  expect((await recordPrivateMembershipConsent(s.db, op.id, await s.f.read())).status).toBe('complete');
  expect(s.fake.store.get(ownerKey)?.membershipTransition).toBeNull();
});
test('pending money reservations prevent closure; no signature, elapsed time or request alone erases them', async () => {
  const s = setup(true), op = await beginPrivateMembershipTransition(s.db, ownerId, 'leave');
  s.fake.store.set(accountKey, { ...s.fake.store.get(accountKey), pendingReservation: h(999) });
  await expect(openPrivateMembershipConsents(s.db, op.id)).rejects.toThrow('reconciliation_pending');
  expect(s.fake.store.get(`${T}/${op.id}`)?.status).toBe('preparing');
  expect(s.fake.store.get(accountKey)).toMatchObject({ pendingReservation: h(999), episode: { joined: true } });
});
test('active duplicate join never freezes the owner; changed portfolio or wrong consumed nonce cannot activate', async () => {
  const active = setup(true);
  await expect(beginPrivateMembershipTransition(active.db, ownerId, 'join')).rejects.toThrow('already_joined');
  expect(active.fake.store.get(ownerKey)?.membershipTransition).toBeUndefined();
  const s = setup(), op = await beginPrivateMembershipTransition(s.db, ownerId, 'join');
  await openPrivateMembershipConsents(s.db, op.id);
  s.effects([{ binding: h(3), joined: true, nonce: 1, generation: 1, index: 5 }]);
  await expect(recordPrivateMembershipConsent(s.db, op.id, await s.f.read())).rejects.toThrow('consent_mismatch');
  s.fake.store.set(ownerKey, { ...s.fake.store.get(ownerKey), bindingSetVersion: 3 });
  s.effects([{ binding: h(3), joined: true, nonce: 0, generation: 1, index: 5 }]);
  await expect(recordPrivateMembershipConsent(s.db, op.id, await s.f.read())).rejects.toThrow('portfolio_changed');
  expect(s.fake.store.has(accountKey)).toBe(false);
});

test('a clean but stale account checkpoint cannot close the episode before the requested transition', async () => {
  const s = setup(true), op = await beginPrivateMembershipTransition(s.db, ownerId, 'leave');
  s.fake.store.set(accountKey, { ...s.fake.store.get(accountKey), checkpoint: { pool: old[8], block: 98, blockHash: h(98) } });
  (readHistoricalRecoursePoolState as jest.Mock).mockResolvedValue({ pool: old[8], kernel: old[0], block: 98, blockHash: h(98), timestamp: now - 86400 });
  await expect(openPrivateMembershipConsents(s.db, op.id)).rejects.toThrow('reconciliation_pending');
  expect(s.fake.store.get(accountKey)).toMatchObject({ episode: { joined: true } });
  expect(s.fake.store.get(`${T}/${op.id}`)?.status).toBe('preparing');
});

test('an executed consent can be recorded after recovery, then the interrupted transition resumes with the replacement', async () => {
  const s = setup(), op = await beginPrivateMembershipTransition(s.db, ownerId, 'join');
  await openPrivateMembershipConsents(s.db, op.id);
  s.effects([{ binding: h(3), joined: true, nonce: 0, generation: 1, index: 5 }]);
  const receipt = await s.f.read();
  s.fake.store.set(`${R.identities}/${h(3)}`, { ownerIdentity: ownerId, identity: h(3), recoveryGeneration: 1 });
  s.fake.store.set(`${R.addresses}/${a(5)}`, { ownerIdentity: ownerId, address: a(5), identity: h(3), kernel: old[0], recoveryGeneration: 1, chainBindingStatus: 'confirmed' });
  (readHistoricalRecoursePoolState as jest.Mock).mockImplementation(async (id: string) => ({ pool: old[8], kernel: old[0],
    block: 99, blockHash: h(99), timestamp: now, currentAddress: id === h(3) ? a(5) : a(4),
    addressConsent: id === h(3), consentNonce: id === h(3) ? '1' : '0', consentGeneration: id === h(3) ? '1' : '0' }));
  await expect(refreshRecoveredMembershipTransition(s.db, op.id)).rejects.toThrow('reconciliation_pending');
  const recorded = await recordPrivateMembershipConsent(s.db, op.id, receipt);
  expect(recorded.status).toBe('consenting');
  const refreshed = await refreshRecoveredMembershipTransition(s.db, op.id);
  expect(refreshed.bindings.find(b => b.binding === h(3))).toMatchObject({ address: a(5), recoveryGeneration: 1, admission: { block: 100, logIndex: 5 } });
  expect(nextPrivateAddressConsent(refreshed, h(4), { revision: '1', ruleHash: h(9), timestamp: now })).toMatchObject({ account: a(4), nonce: '0', joined: true });
});

test('first admission waits for zero-contribution issuance even when no membership account exists', async () => {
  const s = setup();
  const { PRIVATE_ISSUANCE_ADDRESSES } = await import('./issuance-lock');
  s.fake.store.set(`${PRIVATE_ISSUANCE_ADDRESSES}/${a(3)}`, { batchId: h(777) });
  const op = await beginPrivateMembershipTransition(s.db, ownerId, 'join');
  await expect(openPrivateMembershipConsents(s.db, op.id)).rejects.toThrow('issuance_reconciliation_pending');
  expect(s.fake.store.get(`${T}/${op.id}`)?.status).toBe('preparing');
  expect(s.fake.store.has(accountKey)).toBe(false);
  s.fake.store.set(`${PRIVATE_ISSUANCE_ADDRESSES}/${a(3)}`, { batchId: null });
  expect((await openPrivateMembershipConsents(s.db, op.id)).status).toBe('consenting');
});
