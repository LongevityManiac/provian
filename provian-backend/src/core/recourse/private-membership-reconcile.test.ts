import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { fixture, a, h, old, pointer, tx as receiptTx } from './__test-helpers__/membership-receipt-fixture';
import { seedMembershipJournal } from './__test-helpers__/membership-journal-fixture';
import { joinPrivateMembership, type PrivateCalendarRules } from './private-membership-calendar';
import { planPrivateDebit, reservePrivateMembership, PRIVATE_MEMBERSHIP_COLLECTIONS as C, type PrivateMembershipAccount } from './private-membership-reservation';
import { beginPrivateMembershipTransition, openPrivateMembershipConsents } from './private-membership-transition';
import { reconcilePrivateMembershipReceipt, reconcilePrivateMembershipThrough } from './private-membership-reconcile';
import { RECOURSE_COLLECTIONS as R } from './ownership';
import { MEMBERSHIP_RECEIPT_ABI } from './membership-receipt';
import { readPrivateCalendarRules } from './private-calendar-rules';
import { readHistoricalRecoursePoolState } from './pool-state';
import { getAgreedBaseLogs } from '../onchain/economic-discovery';
import { utcCalendarMonth } from './calendar-month';
jest.mock('../onchain/rpc-provider', () => ({ getOperatorBoundRpcLegs: jest.fn() }));
jest.mock('../onchain/economic-discovery', () => ({ getAgreedBaseLogs: jest.fn() }));
jest.mock('../protocol/pointer-pin.generated', () => ({ PROTOCOL_POINTER_PIN: {
  address: '0x0000000000000000000000000000000000000001', runtimeHash: require('ethers').keccak256('0x6000'),
} }));
jest.mock('./private-calendar-rules', () => ({ readPrivateCalendarRules: jest.fn() }));
jest.mock('./pool-state', () => ({ readHistoricalRecoursePoolState: jest.fn() }));
jest.mock('./chain-ledger', () => ({ createRecourseChainPort: () => ({ finalizedBlock: async () => 99, blockHash: async () => `0x${'0'.repeat(62)}63` }) }));
const now = 1700000000, month = utcCalendarMonth(now), ownerId = h(500), key = `${C.owners}/${ownerId}`;
const rules: PrivateCalendarRules = () => ({ ruleHash: h(9), rule: { schema: 'provian-recourse-membership/v1', chainId: 8453,
  pointer, firstMonth: 0, participationBurnAtomic: '100', noEarningsContributionAtomic: '100', earningsBps: 100 } });
function setup(joined = true) {
  const f = fixture(); f.state.priorRevision = 1; f.state.publications = []; f.state.effects = [];
  const fake = createFakeFirestore({ strictTransactionOrder: true, rejectUndefinedValues: true }), db = fake as unknown as Firestore;
  fake.store.set(`${R.owners}/${ownerId}`, { ownerIdentity: ownerId, bindingSetVersion: 1 });
  fake.store.set(`${R.addresses}/${a(3)}`, { ownerIdentity: ownerId, identity: h(2), address: a(3), kernel: old[0], chainBindingStatus: 'confirmed', recoveryGeneration: 0 });
  fake.store.set(`${R.identities}/${h(2)}`, { ownerIdentity: ownerId, identity: h(2), recoveryGeneration: 0 });
  if (joined) fake.store.set(key,seedMembershipJournal(fake.store, { ownerIdentity: ownerId, version: 0, needsScan: false, pendingReservation: null,
    episode: joinPrivateMembership(null,month,rules), checkpoint: { pool: old[8],block: 99,blockHash: h(99) } },
    { chainId: '8453',kernel: old[0],pool: old[8],block: 98,blockHash: h(98),logIndex: 1,timestamp: now-1 }));
  (readPrivateCalendarRules as jest.Mock).mockResolvedValue(rules);
  (readHistoricalRecoursePoolState as jest.Mock).mockResolvedValue({ pool: old[8],kernel: old[0],block: 99,blockHash: h(99),timestamp: now,
    currentAddress: a(3), addressConsent: false,consentNonce: '0',consentGeneration: '0' });
  const setEvent = (name: string,args: readonly unknown[]) => {
    const encoded = MEMBERSHIP_RECEIPT_ABI.encodeEventLog(MEMBERSHIP_RECEIPT_ABI.getEvent(name)!,args);
    f.state.effects = [{ ...encoded,logIndex: '0x5' }];
    (getAgreedBaseLogs as jest.Mock).mockResolvedValue([{ ...encoded,address: old[8],blockNumber: 100,blockHash: h(100),logIndex: 5,transactionHash: receiptTx,removed: false }]);
  };
  const state = () => fake.store.get(key) as unknown as PrivateMembershipAccount;
  const reserve = async () => {
    const r = planPrivateDebit(state(), { chainId: '8453',pointer,kernel: old[0],pool: old[8] },
      { binding: h(2),payer: a(3),month: String(month),burn: '100',reserve: '0',nonce: '7',generation: '1',revision: '1',ruleHash: h(9),expiresAt: String(now+300) },month,rules);
    await reservePrivateMembership(db,r); return r;
  };
  return { f,fake,db,state,setEvent,reserve };
}
beforeEach(() => jest.resetAllMocks());
test('catchup commits authentic reserved debit exactly once and refuses a receipt-shaped copy', async () => {
  const s = setup(), r = await s.reserve(); s.setEvent('MembershipDebitExecuted',[r.digest,h(2),a(3),month,100,0,7]);
  const receipt = await s.f.read();
  await expect(reconcilePrivateMembershipReceipt(s.db,ownerId,{ ...receipt })).rejects.toThrow('unverified');
  await reconcilePrivateMembershipReceipt(s.db,ownerId,receipt); await reconcilePrivateMembershipReceipt(s.db,ownerId,receipt);
  expect(s.state().episode.invoices[String(month)].burnPaidAtomic).toBe('100');
  expect(s.state().pendingReservation).toBeNull();
});
test('selection of a matching digest never bypasses the exact amount check', async () => {
  const s = setup(), r = await s.reserve(); s.setEvent('MembershipDebitExecuted',[r.digest,h(2),a(3),month,101,0,7]);
  await expect(reconcilePrivateMembershipReceipt(s.db,ownerId,await s.f.read())).rejects.toThrow('debit_effect');
  expect(s.state().episode.invoices[String(month)].burnPaidAtomic).toBe('0'); expect(s.state().pendingReservation).toBe(r.id);
});
test('an executed first join missing its relay reply is reconciled into a real admission before succession', async () => {
  const s = setup(false), op = await beginPrivateMembershipTransition(s.db,ownerId,'join');
  await openPrivateMembershipConsents(s.db,op.id);
  s.setEvent('AddressConsentChanged',[h(2),1,true,0]);
  await reconcilePrivateMembershipThrough(s.db,ownerId,99,{ pool: old[8],kernel: old[0],block: 100,blockHash: h(100) });
  expect(s.state()).toMatchObject({ episode: { joined: true,generation: 1 },admission: { block: 100,logIndex: 5 } });
  expect(s.fake.store.get(`${R.owners}/${ownerId}`)?.membershipTransition).toBeNull();
});
test('a receipt beyond the selected cutoff cannot credit an earlier snapshot', async () => {
  const s = setup(), r = await s.reserve(); s.setEvent('MembershipDebitExecuted',[r.digest,h(2),a(3),month,100,0,7]);
  await expect(reconcilePrivateMembershipThrough(s.db,ownerId,99,{ pool: old[8],kernel: old[0],block: 99,blockHash: h(99) })).rejects.toThrow('reconcile_log');
  expect(s.state().pendingReservation).toBe(r.id); expect(s.state().episode.invoices[String(month)].burnPaidAtomic).toBe('0');
});
