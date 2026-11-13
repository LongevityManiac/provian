import { seedMembershipJournal } from './__test-helpers__/membership-journal-fixture';
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
jest.mock('./private-membership-scan', () => ({ readPrivateMembershipScan: jest.fn(), commitPrivateMembershipScan: jest.fn() }));
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
  fake.store.set(`${R.owners}/${owner}`, { ownerIdentity: owner, bindingSetVersion: 2, primaryBinding:h('03') });
  for (const b of ['03','04']) {
    fake.store.set(`${R.addresses}/${a(b)}`, { address: a(b), identity: h(b), ownerIdentity: owner, kernel: a('11'), recoveryGeneration: 0, chainBindingStatus: 'confirmed' });
    fake.store.set(`${R.identities}/${h(b)}`, { identity: h(b), ownerIdentity: owner, recoveryGeneration: 0 });
  }
  const state = (binding: string) => ({ pool: a('12'), kernel: a('11'), block: 99, blockHash: h('99'), timestamp: now, month: String(utcCalendarMonth(now)),
    currentAddress: binding === h('03') ? a('03') : a('04'), consentNonce: joined ? '1' : '0', consentGeneration: joined ? '1' : '0',
    addressConsent: joined, signedRuleHash: h('12'), participationBurnAtomic:'100',noEarningsContributionAtomic:'100',earningsBps:100 });
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
  const leaving=await prepareMembershipTransition(f.db, owner, {kind:'leave'});
  expect(leaving.status).toBe('preparing'); expect(leaving.challenges).toHaveLength(2);
  expect(leaving.challenges.every(c=>!c.consent.joined)).toBe(true);
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
  const challenge = view.challenges[0];
  const standing={admissionMonth:challenge.admissionMonth,rejoinPayments:challenge.rejoinPayments,consent:challenge.consent,fixedChargePayer:challenge.fixedChargePayer,burnLimit:challenge.burnLimit,reserveLimit:challenge.reserveLimit,earningsBpsLimit:challenge.earningsBpsLimit,exitCommitment:h('e1'),exitSalt:h('e2')};
  const id=membershipConsentOperationId({...challenge,standing,exitSecret:null});
  const request = { transitionId: view.id, domain: challenge.domain, consent: challenge.consent,
    standing,exitSecret:null,ownerSignature: 'PRIVATE_OWNER_SIGNATURE', attestorSignature: 'PRIVATE_ATTESTOR_SIGNATURE' };
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


test('a retained address issuance cannot hide departure challenges or authorize new admission', async () => {
  const { PRIVATE_ISSUANCE_ADDRESSES } = await import('./issuance-lock');
  const leaving = fixture(true);
  leaving.fake.store.set(`${C.owners}/${owner}`, { ownerIdentity: owner, version: 0, pendingReservation: null, needsScan: false,
    checkpoint: { pool: a('12'), block: 99, blockHash: h('99') }, episode: joinPrivateMembership(null, utcCalendarMonth(now), rules) });
  leaving.fake.store.set(`${PRIVATE_ISSUANCE_ADDRESSES}/${a('03')}`, { batchId: h('77') });
  const view = await prepareMembershipTransition(leaving.db, owner, { kind: 'leave' });
  expect(view.status).toBe('preparing');
  expect(view.challenges).toHaveLength(2);
  expect(view.challenges.every(c => c.consent.joined === false)).toBe(true);
  expect(leaving.fake.store.get(`${PRIVATE_ISSUANCE_ADDRESSES}/${a('03')}`)).toEqual({ batchId: h('77') });
  const joining = fixture();
  joining.fake.store.set(`${PRIVATE_ISSUANCE_ADDRESSES}/${a('03')}`, { batchId: h('77') });
  await expect(prepareMembershipTransition(joining.db, owner, { kind: 'join' })).rejects.toThrow('issuance_reconciliation_pending');
});

test('auxiliary-only membership pins one payer and departure needs no primary',async()=>{
 const f=fixture();delete f.fake.store.get(`${R.owners}/${owner}`)!.primaryBinding;
 const view=await prepareMembershipTransition(f.db,owner,{kind:'join'});
 expect(view.challenges.filter(c=>c.fixedChargePayer)).toHaveLength(1);
 expect(view.challenges.find(c=>c.fixedChargePayer)!.consent.binding).toBe(h('03'));
 f.fake.store.get(`${R.owners}/${owner}`)!.primaryBinding=h('04');
 const resumed=await prepareMembershipTransition(f.db,owner,{id:view.id});
 expect(resumed.challenges.find(c=>c.fixedChargePayer)!.consent.binding).toBe(h('03'));
 const leaving=fixture(true);delete leaving.fake.store.get(`${R.owners}/${owner}`)!.primaryBinding;
 leaving.fake.store.set(`${C.owners}/${owner}`,seedMembershipJournal(leaving.fake.store,{ownerIdentity:owner,version:0,pendingReservation:null,needsScan:false,
 checkpoint:{pool:a('12'),block:99,blockHash:h('99')},episode:joinPrivateMembership(null,utcCalendarMonth(now),rules)},
 {chainId:'8453',kernel:a('11'),pool:a('12'),block:98,blockHash:h('98'),logIndex:1,timestamp:now-1}));
 const departure=await prepareMembershipTransition(leaving.db,owner,{kind:'leave'});
 expect(departure.challenges).toHaveLength(2);expect(departure.challenges.every(c=>!c.consent.joined&&!c.fixedChargePayer)).toBe(true);
});

test('an unsigned pending join can become a completed departure without creating membership',async()=>{
 const f=fixture(),joining=await prepareMembershipTransition(f.db,owner,{kind:'join'});
 const leaving=await prepareMembershipTransition(f.db,owner,{kind:'leave'});
 expect(leaving).toMatchObject({id:joining.id,kind:'leave',status:'complete',challenges:[],pending:[]});
 expect(f.fake.store.has(`${C.owners}/${owner}`)).toBe(false);
 expect([...f.fake.store.values()].filter(r=>r.status==='superseded')).toHaveLength(1);
});
test('departure retains pending signed admissions and exposes no new admission challenges',async()=>{
 const f=fixture(),joining=await prepareMembershipTransition(f.db,owner,{kind:'join'}),challenge=joining.challenges[0];
 const standing={admissionMonth:challenge.admissionMonth,rejoinPayments:challenge.rejoinPayments,consent:challenge.consent,fixedChargePayer:challenge.fixedChargePayer,burnLimit:challenge.burnLimit,reserveLimit:challenge.reserveLimit,earningsBpsLimit:challenge.earningsBpsLimit,exitCommitment:h('e1'),exitSalt:h('e2')};
 const id=membershipConsentOperationId({...challenge,standing,exitSecret:null});
 const request={transitionId:joining.id,domain:challenge.domain,consent:challenge.consent,standing,exitSecret:null,ownerSignature:'PRIVATE_OWNER',attestorSignature:'PRIVATE_ATTESTOR'};
 f.fake.store.set(`${MEMBERSHIP_CONSENT_OPERATIONS}/${id}`,{request,status:'submitted',transactionHash:h('e3'),signedTransaction:'RETAINED_BYTES'});
 const leaving=await prepareMembershipTransition(f.db,owner,{kind:'leave'});
 expect(leaving).toMatchObject({kind:'leave',status:'preparing',challenges:[]});expect(leaving.pending).toHaveLength(1);
 expect(f.fake.store.get(`${MEMBERSHIP_CONSENT_OPERATIONS}/${id}`)!.signedTransaction).toBe('RETAINED_BYTES');
 expect(f.fake.store.has(`${C.owners}/${owner}`)).toBe(false);
});


test.each(['queued','submitted'])('month rollover preserves visibility and bytes of %s consent',async status=>{
  const f=fixture(),view=await prepareMembershipTransition(f.db,owner,{kind:'join'}),c=view.challenges[0];
  const standing={admissionMonth:c.admissionMonth,rejoinPayments:c.rejoinPayments,consent:c.consent,fixedChargePayer:c.fixedChargePayer,burnLimit:c.burnLimit,reserveLimit:c.reserveLimit,earningsBpsLimit:c.earningsBpsLimit,exitCommitment:h('e1'),exitSalt:h('e2')};
  const id=membershipConsentOperationId({...c,standing,exitSecret:null});
  const request={transitionId:view.id,domain:c.domain,consent:c.consent,standing,exitSecret:null,ownerSignature:'PRIVATE_OWNER',attestorSignature:'PRIVATE_ATTESTOR'};
  f.fake.store.set(`${MEMBERSHIP_CONSENT_OPERATIONS}/${id}`,{request,status,transactionHash:status==='submitted'?h('e3'):null,...(status==='submitted'?{signedTransaction:'RETAINED_BYTES'}:{})});
  const before=JSON.stringify(f.fake.store.get(`${T}/${view.id}`));
  const prior=(readHistoricalRecoursePoolState as jest.Mock).getMockImplementation()!;
  const later=async(binding:string)=>({...await prior(binding),timestamp:now+32*86400,month:String(utcCalendarMonth(now+32*86400))});
  (readHistoricalRecoursePoolState as jest.Mock).mockImplementation(later);
  (readRecoursePoolState as jest.Mock).mockImplementation(later);
  const resumed=await prepareMembershipTransition(f.db,owner,{id:view.id});
  expect(resumed.challenges).toHaveLength(0);
  expect(resumed.pending).toEqual([{binding:c.consent.binding,account:c.consent.account,operation:{id,status,transactionHash:status==='submitted'?h('e3'):null}}]);
  expect(JSON.stringify(f.fake.store.get(`${T}/${view.id}`))).toBe(before);
  if(status==='submitted')expect(f.fake.store.get(`${MEMBERSHIP_CONSENT_OPERATIONS}/${id}`)!.signedTransaction).toBe('RETAINED_BYTES');
});

test('unfinished renewal advances its approval month without losing partial renewal receipts',async()=>{
  const f=fixture(true),m=utcCalendarMonth(now);
  f.fake.store.set(`${C.owners}/${owner}`,seedMembershipJournal(f.fake.store,{ownerIdentity:owner,version:0,pendingReservation:null,needsScan:false,
    checkpoint:{pool:a('12'),block:99,blockHash:h('99')},episode:joinPrivateMembership(null,m,rules)},
    {chainId:'8453',kernel:a('11'),pool:a('12'),block:98,blockHash:h('98'),logIndex:1,timestamp:now-1}));
  const view=await prepareMembershipTransition(f.db,owner,{kind:'renew'});
  const op=f.fake.store.get(`${T}/${view.id}`)!;
  const bindings=op.bindings as {binding:string;admission:{block:number;blockHash:string;logIndex:number;timestamp:number}|null}[];
  bindings[0].admission={block:99,blockHash:h('99'),logIndex:5,timestamp:now};
  const retained=JSON.stringify(bindings[0].admission);
  const prior=(readHistoricalRecoursePoolState as jest.Mock).getMockImplementation()!;
  const later=async(binding:string)=>({...await prior(binding),timestamp:now+32*86400,month:String(m+1),consentNonce:binding===bindings[0].binding?'2':'1'});
  (readHistoricalRecoursePoolState as jest.Mock).mockImplementation(later);(readRecoursePoolState as jest.Mock).mockImplementation(later);
  const resumed=await prepareMembershipTransition(f.db,owner,{id:view.id});
  expect(resumed.challenges).toHaveLength(1);
  expect(resumed.challenges[0].admissionMonth).toBe(String(m+1));
  expect(JSON.stringify((f.fake.store.get(`${T}/${view.id}`)!.bindings as typeof bindings)[0].admission)).toBe(retained);
});

test('confirmed recovery at a new month refreshes the replacement before rolling over admission',async()=>{
 const f=fixture(),initial=await prepareMembershipTransition(f.db,owner,{kind:'join'});
 f.fake.store.set(`${R.addresses}/${a('05')}`,{ownerIdentity:owner,address:a('05'),identity:h('03'),kernel:a('11'),recoveryGeneration:1,chainBindingStatus:'confirmed'});
 f.fake.store.get(`${R.identities}/${h('03')}`)!.recoveryGeneration=1;
 f.fake.store.get(`${R.owners}/${owner}`)!.bindingSetVersion=3;
 const prior=(readHistoricalRecoursePoolState as jest.Mock).getMockImplementation()!;
 const recovered=async(binding:string)=>({...await prior(binding),timestamp:now+32*86400,month:String(utcCalendarMonth(now+32*86400)),currentAddress:binding===h('03')?a('05'):a('04')});
 (readHistoricalRecoursePoolState as jest.Mock).mockImplementation(recovered);(readRecoursePoolState as jest.Mock).mockImplementation(recovered);
 const resumed=await prepareMembershipTransition(f.db,owner,{id:initial.id});
 expect(resumed.status).toBe('consenting');expect(resumed.challenges.find(c=>c.consent.binding===h('03'))!.consent.account).toBe(a('05'));
 expect(resumed.challenges.every(c=>c.admissionMonth===String(utcCalendarMonth(now+32*86400)))).toBe(true);
 expect(f.fake.store.get(`${T}/${initial.id}`)!.bindingSetVersion).toBe(3);
});
