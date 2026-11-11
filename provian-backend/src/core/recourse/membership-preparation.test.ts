import { MEMBERSHIP_CONSENT_OPERATIONS, membershipConsentOperationId } from './membership-operation-identifiers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { prepareMembershipTransition } from './membership-preparation';
import { RECOURSE_COLLECTIONS as R } from './ownership';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C } from './private-membership-reservation';
import { PRIVATE_MEMBERSHIP_TRANSITIONS as T } from './private-membership-transition';
import { readRecoursePoolState, readHistoricalRecoursePoolState } from './pool-state';
import { readPrivateCalendarRules } from './private-calendar-rules';
import { currentProtocolDeployment } from '../protocol/runtime';
import { reconcilePrivateMembershipDomain } from './private-membership-domain';
import { joinPrivateMembership, type PrivateCalendarRules } from './private-membership-calendar';
import { utcCalendarMonth } from './calendar-month';
import { addressMembershipSigningHash } from './membership-authorization';
jest.mock('./pool-state', () => ({ readRecoursePoolState: jest.fn(), readHistoricalRecoursePoolState: jest.fn() }));
jest.mock('./private-calendar-rules', () => ({ readPrivateCalendarRules: jest.fn() }));
jest.mock('../protocol/runtime', () => ({ currentProtocolDeployment: jest.fn() }));
jest.mock('./private-membership-domain', () => ({ reconcilePrivateMembershipDomain: jest.fn() }));
jest.mock('./private-membership-reconcile', () => ({ reconcilePrivateMembershipThrough: jest.fn(), reconcilePrivateMembershipReceipt: jest.fn() }));
jest.mock('./chain-ledger', () => ({ createRecourseChainPort: () => ({ finalizedBlock: async () => 99, blockHash: async () => `0x${'99'.repeat(32)}` }) }));
const a = (b: string) => `0x${b.repeat(20)}`, h = (b: string) => `0x${b.repeat(32)}`;
const owner = h('ab'), now = 1700000000;
const rules: PrivateCalendarRules = () => ({ ruleHash: h('12'), rule: { schema: 'provian-recourse-membership/v1', chainId: 8453,
  pointer: a('10'), firstMonth: 0, participationBurnAtomic: '100', noEarningsContributionAtomic: '100', earningsBps: 100 } });
function fixture(joined = false) {
  jest.clearAllMocks();
  const fake = createFakeFirestore({ strictTransactionOrder: true, rejectUndefinedValues: true }), db = fake as unknown as Firestore;
  fake.store.set(`${R.owners}/${owner}`, { ownerIdentity: owner, bindingSetVersion: 2 });
  for (const b of ['03','04']) {
    fake.store.set(`${R.addresses}/${a(b)}`, { address: a(b), identity: h(b), ownerIdentity: owner, kernel: a('11'), recoveryGeneration: 0, chainBindingStatus: 'confirmed' });
    fake.store.set(`${R.identities}/${h(b)}`, { identity: h(b), ownerIdentity: owner, recoveryGeneration: 0 });
  }
  const state = (binding: string) => ({ pool: a('12'), kernel: a('11'), block: 99, blockHash: h('99'), timestamp: now,
    currentAddress: binding === h('03') ? a('03') : a('04'), consentNonce: joined ? '1' : '0', consentGeneration: joined ? '1' : '0',
    addressConsent: joined, signedRuleHash: h('12') });
  (readRecoursePoolState as jest.Mock).mockImplementation(async (binding: string) => state(binding));
  (readHistoricalRecoursePoolState as jest.Mock).mockImplementation(async (binding: string) => state(binding));
  (readPrivateCalendarRules as jest.Mock).mockResolvedValue(rules);
  (currentProtocolDeployment as jest.Mock).mockResolvedValue({ pointer: a('10'), addresses: { kernel: a('11'), recoursePool: a('12') }, revision: 1n, manifestHash: h('13') });
  return { fake, db };
}
test('first join returns individual challenges and remains unadmitted until canonical receipts', async () => {
  const f = fixture(), view = await prepareMembershipTransition(f.db, owner, { kind: 'join' });
  expect(view.status).toBe('consenting'); expect(view.challenges).toHaveLength(2);
  expect(f.fake.store.has(`${C.owners}/${owner}`)).toBe(false);
  for (const challenge of view.challenges) {
    expect(challenge.messageHex).toBe(addressMembershipSigningHash(challenge.domain, challenge.consent));
    expect(JSON.stringify(challenge)).not.toContain(owner);
    expect(JSON.stringify(challenge)).not.toContain(view.id);
  }
  expect(await prepareMembershipTransition(f.db, owner, { id: view.id })).toEqual(view);
});
test('an operation belonging to another private owner is refused before any chain reconciliation', async () => {
  const f = fixture(), view = await prepareMembershipTransition(f.db, owner, { kind: 'join' });
  (reconcilePrivateMembershipDomain as jest.Mock).mockClear();
  await expect(prepareMembershipTransition(f.db, h('ff'), { id: view.id })).rejects.toThrow('unknown');
  expect(reconcilePrivateMembershipDomain).not.toHaveBeenCalled();
});
test('leave freezes new signing but cannot erase an unresolved issuance reservation or close the episode', async () => {
  const f = fixture(true);
  f.fake.store.set(`${C.owners}/${owner}`, { ownerIdentity: owner, version: 0, pendingReservation: h('fe'), needsScan: false,
    checkpoint: { pool: a('12'), block: 99, blockHash: h('99') }, episode: joinPrivateMembership(null, utcCalendarMonth(now), rules) });
  f.fake.store.set(`${C.reservations}/${h('fe')}`, { status: 'pending', reservation: { ownerIdentity: owner, kind: 'issuance' } });
  await expect(prepareMembershipTransition(f.db, owner, { kind: 'leave' })).resolves.toMatchObject({ status: 'preparing', challenges: [] });
  const id = f.fake.store.get(`${R.owners}/${owner}`)!.membershipTransition;
  expect(f.fake.store.get(`${T}/${id}`)).toMatchObject({ status: 'preparing', closure: null });
  expect(f.fake.store.get(`${C.owners}/${owner}`)).toMatchObject({ pendingReservation: h('fe'), episode: { joined: true } });
});
test('recovery during interrupted preparation refreshes the replacement before opening consents', async () => {
  const f = fixture();
  (readPrivateCalendarRules as jest.Mock).mockRejectedValueOnce(Error('rule_temporarily_unavailable'));
  await expect(prepareMembershipTransition(f.db, owner, { kind: 'join' })).rejects.toThrow('temporarily_unavailable');
  const id = String(f.fake.store.get(`${R.owners}/${owner}`)!.membershipTransition);
  expect(f.fake.store.get(`${T}/${id}`)?.status).toBe('preparing');
  f.fake.store.set(`${R.addresses}/${a('05')}`, { address: a('05'), identity: h('03'), ownerIdentity: owner,
    kernel: a('11'), recoveryGeneration: 1, chainBindingStatus: 'confirmed' });
  f.fake.store.get(`${R.identities}/${h('03')}`)!.recoveryGeneration = 1;
  f.fake.store.get(`${R.owners}/${owner}`)!.bindingSetVersion = 3;
  const prior = (readHistoricalRecoursePoolState as jest.Mock).getMockImplementation()!;
  const recovered = async (binding: string) => ({ ...await prior(binding), currentAddress: binding === h('03') ? a('05') : a('04') });
  (readHistoricalRecoursePoolState as jest.Mock).mockImplementation(recovered);
  (readRecoursePoolState as jest.Mock).mockImplementation(recovered);
  const view = await prepareMembershipTransition(f.db, owner, { id });
  expect(view.status).toBe('consenting');
  expect(view.challenges.find(c => c.consent.binding === h('03'))?.consent.account).toBe(a('05'));
  expect(f.fake.store.get(`${T}/${id}`)?.bindingSetVersion).toBe(3);
});

test('resume discovers exact queued consent without requesting a second signature or exposing signatures', async () => {
  const f = fixture(), view = await prepareMembershipTransition(f.db, owner, { kind: 'join' });
  const challenge = view.challenges[0], id = membershipConsentOperationId(challenge);
  const request = { transitionId: view.id, domain: challenge.domain, consent: challenge.consent,
    ownerSignature: 'PRIVATE_OWNER_SIGNATURE', attestorSignature: 'PRIVATE_ATTESTOR_SIGNATURE' };
  f.fake.store.set(`${MEMBERSHIP_CONSENT_OPERATIONS}/${id}`, { request, status: 'queued', transactionHash: null });
  const resumed = await prepareMembershipTransition(f.db, owner, { id: view.id });
  expect(resumed.challenges).toHaveLength(1);
  expect(resumed.pending).toEqual([{ binding: challenge.consent.binding, account: challenge.consent.account,
    operation: { id, status: 'queued', transactionHash: null } }]);
  expect(JSON.stringify(resumed)).not.toContain('PRIVATE_');
  // Another transition and an obsolete nonce cannot suppress the current challenge.
  f.fake.store.get(`${MEMBERSHIP_CONSENT_OPERATIONS}/${id}`)!.request = { ...request, transitionId: h('ee') };
  expect((await prepareMembershipTransition(f.db, owner, { id: view.id })).challenges).toHaveLength(2);
  f.fake.store.get(`${MEMBERSHIP_CONSENT_OPERATIONS}/${id}`)!.request = request;
  f.fake.store.get(`${MEMBERSHIP_CONSENT_OPERATIONS}/${id}`)!.status = 'failed';
  expect((await prepareMembershipTransition(f.db, owner, { id: view.id })).challenges).toHaveLength(2);
});
