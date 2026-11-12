import { getAgreedBaseLogs } from '../onchain/economic-discovery';
import { reconcileMembershipDebit, assertDebitRevocation } from './membership-debit-revocation';
import { MEMBERSHIP_AUTHORIZATION_ABI, standingMembershipDebitDigest } from './membership-authorization';
import { fixture, a, h, old, pointer, tx } from './__test-helpers__/membership-receipt-fixture';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { joinPrivateMembership, type PrivateCalendarRules } from './private-membership-calendar';
import { planPrivateDebit, reservePrivateMembership, releaseRevokedPrivateDebit, PRIVATE_MEMBERSHIP_COLLECTIONS as C } from './private-membership-reservation';
import { RECOURSE_COLLECTIONS } from './ownership';
jest.mock('../onchain/rpc-provider', () => ({ getOperatorBoundRpcLegs: jest.fn() }));
jest.mock('../protocol/pointer-pin.generated', () => ({ PROTOCOL_POINTER_PIN: {
  address: '0x0000000000000000000000000000000000000001', runtimeHash: require('ethers').keccak256('0x6000'),
} }));
jest.mock('../onchain/economic-discovery', () => ({ getAgreedBaseLogs: jest.fn() }));
jest.mock('./chain-ledger', () => ({ createRecourseChainPort: () => ({
  finalizedBlock: async () => 100,
  blockHash: async (n: number) => `0x${n.toString(16).padStart(64, '0')}`,
}) }));
const domain = { chainId: '8453', pointer, kernel: old[0], pool: old[8] };
const debit = { binding: h(2), payer: a(3), month: '24286', burn: '100', reserve: '0', nonce: '7', generation: '1',
  revision: '1', ruleHash: h(9), expiresAt: '1700000300' };
const checkpoint = { block: 99, blockHash: h(99) };
function setup() {
  const f = fixture(); f.state.priorRevision = 1; f.state.publications = [];
  (getAgreedBaseLogs as jest.Mock).mockResolvedValue([]); return f;
}
function event(name: string, args: readonly unknown[], index = 5) {
  return { address: old[8], blockNumber: 100, blockHash: h(100), transactionHash: tx, transactionIndex: 0, logIndex: index, removed: false,
    ...MEMBERSHIP_AUTHORIZATION_ABI.encodeEventLog(MEMBERSHIP_AUTHORIZATION_ABI.getEvent(name)!, args) };
}
test('leave permanently revokes the old nonce after a complete finalized scan', async () => {
  const f = setup(); f.state.debitNonceAfter = 8;
  (getAgreedBaseLogs as jest.Mock).mockResolvedValue([event('MembershipDebitCancelled', [h(2), 7])]);
  const result = await reconcileMembershipDebit(domain, debit, checkpoint);
  expect(result?.kind).toBe('revoked');
  if (result?.kind !== 'revoked') throw Error('missing_proof');
  expect(result.proof).toMatchObject({ reason: 'nonce', nonceBefore: '7', nonceAfter: '8' });
  expect(() => assertDebitRevocation(result.proof)).not.toThrow();
  expect(() => assertDebitRevocation({ ...result.proof })).toThrow('unverified');
});
test('recovery or abandoned signing releases only after canonical expiry and complete no-execution evidence', async () => {
  setup();
  expect(await reconcileMembershipDebit(domain, debit, checkpoint)).toBeNull();
  expect(await reconcileMembershipDebit(domain, { ...debit, expiresAt: '1700000000' }, checkpoint)).toBeNull();
  const result = await reconcileMembershipDebit(domain, { ...debit, expiresAt: '1699999999' }, checkpoint);
  expect(result?.kind === 'revoked' && result.proof.reason).toBe('expired');
});
test('an earlier real execution returns its receipt instead of releasing the private owner credit', async () => {
  const f = setup(), digest = standingMembershipDebitDigest(domain, debit);
  const executed = event('MembershipDebitExecuted', [digest, h(2), a(3), debit.month, 100, 0, 7]);
  f.state.debitNonceAfter = 9;
  (getAgreedBaseLogs as jest.Mock).mockResolvedValue([executed, event('MembershipDebitCancelled', [h(2), 8], 6)]);
  f.state.effects = [{ logIndex: '0x5', topics: executed.topics, data: executed.data }];
  const result = await reconcileMembershipDebit(domain, debit, checkpoint);
  expect(result?.kind).toBe('executed');
});
test('missing execution, missing final leave, wrong baseline and gapped nonces fail closed', async () => {
  const f = setup(); f.state.debitNonceAfter = 8;
  await expect(reconcileMembershipDebit(domain, debit, checkpoint)).rejects.toThrow('history_gap');
  (getAgreedBaseLogs as jest.Mock).mockResolvedValue([event('MembershipDebitCancelled', [h(2), 8])]);
  await expect(reconcileMembershipDebit(domain, debit, checkpoint)).rejects.toThrow('history_gap');
  f.state.debitNonceBefore = 6;
  await expect(reconcileMembershipDebit(domain, debit, checkpoint)).rejects.toThrow('baseline');
});
test('a verified leave releases the durable owner lock without inventing paid credit', async () => {
  const f = setup(), fake = createFakeFirestore({ strictTransactionOrder: true, rejectUndefinedValues: true }), db = fake as unknown as Firestore;
  const rules: PrivateCalendarRules = () => ({ ruleHash: h(9), rule: { schema: 'provian-recourse-membership/v1', chainId: 8453, pointer,
    firstMonth: 0, participationBurnAtomic: '100', noEarningsContributionAtomic: '100', earningsBps: 100 } });
  const account = { ownerIdentity: h(500), version: 0, pendingReservation: null, needsScan: false,
    checkpoint: { pool: old[8], ...checkpoint }, episode: joinPrivateMembership(null, Number(debit.month), rules) };
  const key = `${C.owners}/${account.ownerIdentity}`; fake.store.set(key, account);
  fake.store.set(`${RECOURSE_COLLECTIONS.addresses}/${a(3)}`, { address: a(3), identity: h(2), ownerIdentity: h(500),
    kernel: old[0], chainBindingStatus: 'confirmed', recoveryGeneration: 0 });
  fake.store.set(`${RECOURSE_COLLECTIONS.identities}/${h(2)}`, { identity: h(2), ownerIdentity: h(500), recoveryGeneration: 0 });
  fake.store.set(`${RECOURSE_COLLECTIONS.owners}/${h(500)}`, { ownerIdentity: h(500) });
  const reservation = planPrivateDebit(account, domain, debit, Number(debit.month), rules);
  await reservePrivateMembership(db, reservation);
  f.state.debitNonceAfter = 8;
  (getAgreedBaseLogs as jest.Mock).mockResolvedValue([event('MembershipDebitCancelled', [h(2), 7])]);
  const result = await reconcileMembershipDebit(domain, debit, checkpoint);
  if (result?.kind !== 'revoked') throw Error('proof_missing');
  await expect(releaseRevokedPrivateDebit(db, h(500), reservation.id, { ...result.proof })).rejects.toThrow('unverified');
  await releaseRevokedPrivateDebit(db, h(500), reservation.id, result.proof);
  await releaseRevokedPrivateDebit(db, h(500), reservation.id, result.proof);
  expect(fake.store.get(key)).toMatchObject({ pendingReservation: null, needsScan: true, version: 1, episode: account.episode });
  expect(fake.store.get(`${C.reservations}/${reservation.id}`)?.status).toBe('revoked');
});
