import { breakDeploymentChain } from './break-deployment-queue';
import { readMembershipWiring } from './membership-wiring';
import { STANDING_MEMBERSHIP_ABI } from './membership-authorization';
import { MEMBERSHIP_DEBIT_OPERATIONS, membershipDebitOperationId } from './membership-operation-identifiers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { prepareMembershipDebit, selectMembershipPayment } from './membership-debit-preparation';
import { joinPrivateMembership, creditPrivateMembership, recordPrivateMembershipIssuance, type PrivateCalendarRules } from './private-membership-calendar';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C, type PrivateMembershipAccount } from './private-membership-reservation';
import { RECOURSE_COLLECTIONS as R } from './ownership';
import { currentProtocolDeployment } from '../protocol/runtime';
import { readRecoursePoolState, readHistoricalRecoursePoolState } from './pool-state';
import { readPrivateCalendarRules } from './private-calendar-rules';
import { utcCalendarMonth } from './calendar-month';
jest.mock('./break-deployment-queue', () => ({ breakDeploymentChain: jest.fn() }));
jest.mock('./membership-wiring', () => ({ readMembershipWiring: jest.fn() }));
jest.mock('./membership-preparation', () => ({ reconcileCurrentPrivateMembership: jest.fn() }));
jest.mock('./pool-state', () => ({ readRecoursePoolState: jest.fn(), readHistoricalRecoursePoolState: jest.fn() }));
jest.mock('../protocol/runtime', () => ({ currentProtocolDeployment: jest.fn() }));
jest.mock('./private-calendar-rules', () => ({ readPrivateCalendarRules: jest.fn() }));
const h = (b: string) => `0x${b.repeat(32)}`, a = (b: string) => `0x${b.repeat(20)}`;
const now = 1700000000, month = utcCalendarMonth(now), owner = h('ab'), payer = a('03');
const rules: PrivateCalendarRules = () => ({ ruleHash: h('12'), rule: { schema: 'provian-recourse-membership/v1', chainId: 8453,
  pointer: a('10'), firstMonth: 0, participationBurnAtomic: '100', noEarningsContributionAtomic: '100', earningsBps: 100 } });
function fixture(startMonth = month) {
  jest.clearAllMocks();
  const fake = createFakeFirestore({ strictTransactionOrder: true, rejectUndefinedValues: true }), db = fake as unknown as Firestore;
  const account: PrivateMembershipAccount = { ownerIdentity: owner, version: 0, pendingReservation: null, needsScan: false,
    checkpoint: { pool: a('12'), block: 99, blockHash: h('99') }, episode: joinPrivateMembership(null, startMonth, rules) };
  fake.store.set(`${C.owners}/${owner}`, { ...account }); fake.store.set(`${R.owners}/${owner}`, { ownerIdentity: owner, membershipFixedDebitBinding:h('03') });
  for (const n of ['03','04']) {
    fake.store.set(`${R.addresses}/${a(n)}`, { address: a(n), identity: h(n), ownerIdentity: owner, kernel: a('11'), recoveryGeneration: 0, chainBindingStatus: 'confirmed' });
    fake.store.set(`${R.identities}/${h(n)}`, { identity: h(n), ownerIdentity: owner, recoveryGeneration: 0 });
  }
  const state = { pool: a('12'), kernel: a('11'), block: 100, blockHash: h('98'), timestamp: now,
    currentAddress: payer, addressConsent: true, consentNonce:'1', debitNonce: '0', consentGeneration: '1' };
  (readRecoursePoolState as jest.Mock).mockResolvedValue(state);
  (readHistoricalRecoursePoolState as jest.Mock).mockResolvedValue({ ...state, block: 99, blockHash: h('99') });
  (readPrivateCalendarRules as jest.Mock).mockResolvedValue(rules);
  (currentProtocolDeployment as jest.Mock).mockResolvedValue({ pointer: a('10'), addresses: { kernel: a('11'), recoursePool: a('12') }, revision: 1n, manifestHash: h('13') });
  const mandate = [100n,100n,100,BigInt(startMonth),0n,1n,h('e1'),h('e2'),true];
  const collected = [0n,0n];
  (readMembershipWiring as jest.Mock).mockResolvedValue({standingMembership:a('77'),pin:{blockHash:state.blockHash}});
  (breakDeploymentChain as jest.Mock).mockReturnValue({agree:async (_method:string,args:readonly {data:string}[])=>{
    const name=STANDING_MEMBERSHIP_ABI.parseTransaction(args[0])!.name;
    return STANDING_MEMBERSHIP_ABI.encodeFunctionResult(name,name==='standingMandate'?mandate:collected);
  }});
  return { fake, db, account, state, mandate, collected };
}
test('current month owes participation burn; a completed no-earnings month adds the separate flat contribution', () => {
  const fresh = fixture();
  expect(selectMembershipPayment(fresh.account, month, rules)).toEqual({ month: String(month), burn: '100', reserve: '0' });
  const prior = fixture(month - 1);
  expect(selectMembershipPayment(prior.account, month, rules)).toEqual({ month: String(month - 1), burn: '100', reserve: '100' });
  const earned = recordPrivateMembershipIssuance(prior.account.episode, month - 1, [{ occurrence: h('55'), account: payer, grossAtomic: '1000', contributorAtomic: '990' }], rules);
  expect(selectMembershipPayment({ ...prior.account, episode: earned.state }, month, rules)).toEqual({ month: String(month - 1), burn: '100', reserve: '0' });
});
test('partial payment preserves the separate remainder and lapsed months cannot be paid retroactively', () => {
  const f = fixture(month - 1);
  const episode = creditPrivateMembership(f.account.episode, month, month - 1, { burnAtomic: '40', reserveAtomic: '25' }, rules);
  expect(selectMembershipPayment({ ...f.account, episode }, month, rules)).toEqual({ month: String(month - 1), burn: '60', reserve: '75' });
  expect(() => selectMembershipPayment(f.account, month + 1, rules)).toThrow('join_required');
  expect(() => selectMembershipPayment(f.account, month, rules, { month: String(month - 1), burn: '101', reserve: '0' })).toThrow('amount');
});
test('preparation reserves exact bytes; retry cannot select a second payer or larger invoice', async () => {
  const f = fixture(), first = await prepareMembershipDebit(f.db, owner, payer);
  expect(first.status).toBe('ready'); if (first.status !== 'ready') throw Error('missing challenge');
  expect(first.challenge).toMatchObject({ allowanceAtomic: '100', debit: { payer, burn: '100', reserve: '0' } });
  expect(f.fake.store.get(`${C.owners}/${owner}`)!.pendingReservation).toBe(first.challenge.reservationId);
  expect(await prepareMembershipDebit(f.db, owner, payer)).toEqual(first);
  expect(await prepareMembershipDebit(f.db, owner, payer, { month: String(month), burn: '200', reserve: '0' })).toEqual({ status: 'pending', operation: null });
  (readRecoursePoolState as jest.Mock).mockResolvedValue({ ...f.state, currentAddress: a('04') });
  expect(await prepareMembershipDebit(f.db, owner, a('04'))).toEqual({ status: 'pending', operation: null });
  expect([...f.fake.store.keys()].filter(k => k.startsWith(C.reservations + '/'))).toHaveLength(1);
});
test('a consumed or recovery-changed nonce must finalize into the private checkpoint before new signing', async () => {
  const f = fixture();
  (readRecoursePoolState as jest.Mock).mockResolvedValue({ ...f.state, debitNonce: '1' });
  await expect(prepareMembershipDebit(f.db, owner, payer)).rejects.toThrow('reconciliation_pending');
  expect(f.fake.store.get(`${C.owners}/${owner}`)!.pendingReservation).toBeNull();
});
test('expiry observation alone never replaces a retained private reservation', async () => {
  const f = fixture(), first = await prepareMembershipDebit(f.db, owner, payer);
  expect(first.status).toBe('ready');
  const reserved = f.fake.store.get(`${C.owners}/${owner}`)!.pendingReservation;
  (readRecoursePoolState as jest.Mock).mockResolvedValue({ ...f.state, timestamp: now + 301 });
  expect(await prepareMembershipDebit(f.db, owner, payer)).toEqual({ status: 'pending', operation: null });
  expect(f.fake.store.get(`${C.owners}/${owner}`)!.pendingReservation).toBe(reserved);
});

test('resuming a queued debit returns its status instead of another approval or signature challenge', async () => {
  const f = fixture(), first = await prepareMembershipDebit(f.db, owner, payer);
  if (first.status !== 'ready') throw Error('missing challenge');
  const id = membershipDebitOperationId(first.challenge), transactionHash = h('ee');
  f.fake.store.set(`${MEMBERSHIP_DEBIT_OPERATIONS}/${id}`, { status: 'submitted', transactionHash });
  expect(await prepareMembershipDebit(f.db, owner, payer)).toEqual({ status: 'pending', operation: { id, status: 'submitted', transactionHash } });
  f.fake.store.get(`${MEMBERSHIP_DEBIT_OPERATIONS}/${id}`)!.status = 'failed';
  expect(await prepareMembershipDebit(f.db, owner, payer)).toEqual(first);
});

test.each(['burn','reserve','earnings','inactive','nonce','payer','collected'])('unsupported invoice refuses before reservation: %s',async kind=>{
 const f=fixture();
 if(kind==='burn')f.mandate[0]=99n;
 if(kind==='reserve')f.mandate[1]=99n;
 if(kind==='earnings')f.mandate[2]=99;
 if(kind==='inactive')f.mandate[8]=false;
 if(kind==='nonce')f.mandate[5]=2n;
 if(kind==='payer')f.fake.store.get(`${R.owners}/${owner}`)!.membershipFixedDebitBinding=h('04');
 if(kind==='collected')f.collected[0]=1n;
 expect(await prepareMembershipDebit(f.db,owner,payer)).toEqual({status:'approval_required'});
 expect(f.fake.store.get(`${C.owners}/${owner}`)!.pendingReservation).toBeNull();
 expect([...f.fake.store.keys()].filter(k=>k.startsWith(C.reservations+'/'))).toHaveLength(0);
});
test('a raised current rule does not block an older approved invoice during grace',async()=>{
 const f=fixture(month-1);
 const raised:PrivateCalendarRules=m=>m<month?rules(m):{...rules(m),ruleHash:h('ff'),rule:{...rules(m).rule,participationBurnAtomic:'200',noEarningsContributionAtomic:'200',earningsBps:200}};
 (readPrivateCalendarRules as jest.Mock).mockResolvedValue(raised);
 expect(await prepareMembershipDebit(f.db,owner,payer)).toMatchObject({status:'ready',challenge:{debit:{month:String(month-1),burn:'100',reserve:'100',ruleHash:h('12')}}});
});
