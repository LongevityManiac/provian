import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C } from './private-membership-reservation';
import { RECOURSE_COLLECTIONS as R } from './ownership';
import { PRIVATE_MEMBERSHIP_TRANSITIONS as T } from './private-membership-transition';
import { reconcilePrivateMembershipDomain } from './private-membership-domain';
import { readMembershipJournal } from './private-membership-journal';
import { findMembershipSuccessionCheckpoint } from './membership-succession-checkpoint';
import { reconcilePrivateMembershipThrough } from './private-membership-reconcile';
import { readPrivateMembershipSuccession, commitPrivateMembershipSuccession } from './private-membership-succession';
jest.mock('./private-membership-journal', () => ({ readMembershipJournal: jest.fn() }));
jest.mock('./membership-succession-checkpoint', () => ({ findMembershipSuccessionCheckpoint: jest.fn() }));
jest.mock('./private-membership-reconcile', () => ({ reconcilePrivateMembershipThrough: jest.fn() }));
jest.mock('./private-membership-succession', () => ({ readPrivateMembershipSuccession: jest.fn(),commitPrivateMembershipSuccession: jest.fn() }));
const h = (n: number) => `0x${n.toString(16).padStart(64,'0')}`, a = (n: number) => `0x${n.toString(16).padStart(40,'0')}`;
const ownerId = h(9), key = `${C.owners}/${ownerId}`;
function setup() {
  const fake = createFakeFirestore(), db = fake as unknown as Firestore;
  fake.store.set(`${R.owners}/${ownerId}`, { ownerIdentity: ownerId });
  fake.store.set(key, { ownerIdentity: ownerId, checkpoint: { pool: a(1),block: 10,blockHash: h(10) } });
  (readMembershipJournal as jest.Mock).mockImplementation(async (_db,account) => [{ position: { pool: account.checkpoint.pool,kernel: a(Number(account.checkpoint.pool)+1) } }]);
  (findMembershipSuccessionCheckpoint as jest.Mock).mockImplementation(async source => {
    const n = Number(source.pool); return n === 5 ? null : { cutoff: { ...source,block: n*50,blockHash: h(n*50) },
      successor: { pool: a(n+2),kernel: a(n+3),block: n*50+20,blockHash: h(n*50+20) } };
  });
  (reconcilePrivateMembershipThrough as jest.Mock).mockResolvedValue(undefined);
  (readPrivateMembershipSuccession as jest.Mock).mockImplementation(async (_db,_id,observation) => ({ observed: observation }));
  (commitPrivateMembershipSuccession as jest.Mock).mockImplementation(async (_db,proof) => fake.store.set(key,{ ownerIdentity: ownerId,checkpoint: proof.observed }));
  return { fake,db };
}
beforeEach(() => jest.resetAllMocks());
test('failed receipt reconciliation never advances the branch; retry resumes through each successor in order', async () => {
  const s = setup(); (reconcilePrivateMembershipThrough as jest.Mock).mockRejectedValueOnce(Error('missing_evidence'));
  await expect(reconcilePrivateMembershipDomain(s.db,ownerId)).rejects.toThrow('missing_evidence');
  expect(commitPrivateMembershipSuccession).not.toHaveBeenCalled();
  expect(s.fake.store.get(key)?.checkpoint).toMatchObject({ pool: a(1) });
  await reconcilePrivateMembershipDomain(s.db,ownerId);
  expect((findMembershipSuccessionCheckpoint as jest.Mock).mock.calls.map(c => c[0].pool)).toEqual([a(1),a(1),a(3),a(5)]);
  expect(commitPrivateMembershipSuccession).toHaveBeenCalledTimes(2);
  expect(s.fake.store.get(key)?.checkpoint).toMatchObject({ pool: a(5) });
  await reconcilePrivateMembershipDomain(s.db,ownerId);
  expect(commitPrivateMembershipSuccession).toHaveBeenCalledTimes(2);
});
test('a first join without an account is reconciled from its retained transition before any successor commit', async () => {
  const s = setup(); s.fake.store.delete(key);
  s.fake.store.set(`${R.owners}/${ownerId}`, { ownerIdentity: ownerId,membershipTransition: 'first' });
  s.fake.store.set(`${T}/first`, { ownerIdentity: ownerId,pool: a(3),kernel: a(4),checkpoint: { block: 120 } });
  await reconcilePrivateMembershipDomain(s.db,ownerId);
  expect(reconcilePrivateMembershipThrough).toHaveBeenCalledWith(s.db,ownerId,120,expect.objectContaining({ pool: a(3),block: 150 }));
  expect(commitPrivateMembershipSuccession).toHaveBeenCalledTimes(1);
});
