import { readStandingMembershipState } from './recourse-standing-state';
import { beforeEach, expect, it, vi } from 'vitest';
import { Wallet, getBytes, verifyMessage } from 'ethers';
import { readRecoursePoolChain } from './recourse-pool-chain';
import { RECOURSE_POOL_ABI } from './recourse-pool-abi';
import { addressMembershipSigningHash, standingMembershipDebitSigningHash, standingMembershipSigningHash, membershipExitCommitment, authenticatedDepartureSigningHash, type StandingMembershipAuthorization } from './recourse-membership-authorization';
import { parseMembershipTransitionView, validateMembershipConsent, validateMembershipDebit, submitMembershipConsent,
  submitMembershipDebit, parseMembershipDebitChallenge, retainMembershipDeparture } from './recourse-membership-client';
import type { OwnerChainNetwork } from './recourse-owner-chain';
import type { ProtocolDeployment } from './protocol-pointer';
vi.mock('./recourse-standing-state',()=>({readStandingMembershipState:vi.fn()}));
vi.mock('./recourse-pool-chain', () => ({ readRecoursePoolChain: vi.fn() }));
const a = (b: string) => `0x${b.repeat(20)}`, h = (b: string) => `0x${b.repeat(32)}`;
const wallet = new Wallet(h('11')), payer = wallet.address.toLowerCase();
const domain = { chainId: '8453', pointer: a('12'), kernel: a('13'), pool: a('14') };
const consent = { binding: h('15'), account: payer, nonce: '3', joined: true, revision: '1', ruleHash: h('16'), expiresAt: '1200' };
const debit = { binding: h('15'), payer, nonce: '7', month: '24321', burn: '40', reserve: '25', generation: '2', revision: '1', ruleHash: h('16'), expiresAt: '1200' };
const consentChallenge = () => ({ domain, consent, admissionMonth:'24322',rejoinPayments:[],fixedChargePayer:true,burnLimit:'100',reserveLimit:'100',earningsBpsLimit:100, messageHex: addressMembershipSigningHash(domain, consent) });
const debitChallenge = () => ({ reservationId: h('17'), domain, debit, messageHex: standingMembershipDebitSigningHash(domain, debit), allowanceAtomic: '65' });
function fixture(joined = false) {
  const deployment = { pointer: domain.pointer, addresses: { kernel: domain.kernel, recoursePool: domain.pool }, revision: 1n, blockHash: h('18'), manifestHash: h('19') } as ProtocolDeployment;
  const state = { pool: domain.pool, kernel: domain.kernel, currentAddress: payer, consentNonce: '3', addressConsent: joined,
    debitNonce: '7', consentGeneration: '2', timestamp: 1000, month: '24322', participationBurnAtomic:'100',noEarningsContributionAtomic:'100',earningsBps:100,signedRuleHash: h('16') };
  vi.mocked(readRecoursePoolChain).mockImplementation(async (_binding, network) => {
    expect(await network.deployment()).toEqual(deployment);
    return state as Awaited<ReturnType<typeof readRecoursePoolChain>>;
  });
  const rpc = { request: vi.fn(async () => RECOURSE_POOL_ABI.encodeFunctionResult('monthlyRule', [[0, 100, 100, 100, h('16')]])) };
  const network: OwnerChainNetwork = { deployment: vi.fn(async () => deployment), rpcs: [rpc, { request: rpc.request }] };
  const relay = { request: vi.fn(async (_path: string, _body?: unknown) => ({ id: h('20'), status: 'queued', transactionHash: null })) };
  return { state, deployment, network, relay, rpc };
}
beforeEach(() => vi.clearAllMocks());
it.each([{expiresAt:'999'},{ruleHash:h('77')},{burnLimit:'0'},{reserveLimit:'0'},{earningsBpsLimit:0}])('departure ignores admission-only presentation fields %j',async patch=>{
 const f=fixture(true), {expiresAt,ruleHash,...limits}=patch;
 const leaving={...consent,joined:false,...(expiresAt ? {expiresAt}:{}),...(ruleHash ? {ruleHash}:{})};
 const challenge={...consentChallenge(),...limits,consent:leaving,messageHex:addressMembershipSigningHash(domain,leaving)};
 await expect(validateMembershipConsent(challenge,payer,'leave',f.network)).resolves.toEqual(challenge);
});
it.each([{account:a('ff')},{nonce:'4'},{revision:'2'},{joined:true}])('departure still refuses scope changes %j',async patch=>{
 const f=fixture(true), leaving={...consent,joined:false,...patch};
 const challenge={...consentChallenge(),consent:leaving,messageHex:addressMembershipSigningHash(domain,leaving)};
 await expect(validateMembershipConsent(challenge,payer,'leave',f.network)).rejects.toThrow();
});
it('consent signs raw validated bytes and refuses a pointer change during signing', async () => {
  const f = fixture(), sign = vi.fn((bytes: Uint8Array) => wallet.signMessage(bytes));
  await submitMembershipConsent(f.relay, f.network, { transitionId: h('21'), kind: 'join', account: payer, challenge: consentChallenge(), signBytes: sign,exitSecret:async()=>h('23') });
  const body = f.relay.request.mock.calls[0][1] as { ownerSignature: string; standing:StandingMembershipAuthorization };
  expect(body.standing.burnLimit).toBe(f.state.participationBurnAtomic);
  expect(body.standing.reserveLimit).toBe(f.state.noEarningsContributionAtomic);
  expect(body.standing.earningsBpsLimit).toBe(f.state.earningsBps);
  const bytes=getBytes(standingMembershipSigningHash(domain,body.standing));
  expect(sign).toHaveBeenCalledWith(bytes);
  expect(verifyMessage(bytes,body.ownerSignature)).toBe(wallet.address);
  f.relay.request.mockClear();
  await expect(submitMembershipConsent(f.relay, f.network, { transitionId: h('21'), kind: 'join', account: payer, challenge: consentChallenge(),
    exitSecret:async()=>h('23'), signBytes: async bytes => { vi.mocked(f.network.deployment).mockResolvedValue({ ...f.deployment, revision: 2n }); return wallet.signMessage(bytes); } })).rejects.toThrow('retired');
  expect(f.relay.request).not.toHaveBeenCalled();
});
it('relay challenge cannot choose another account, nonce, rule, direction or retired pool', async () => {
  const f = fixture();
  for (const patch of [{ account: a('ff') }, { nonce: '4' }, { ruleHash: h('ff') }, { joined: false }, { expiresAt: '999' }, { expiresAt: '1301' }]) {
    const changed = { ...consent, ...patch };
    await expect(validateMembershipConsent({ ...consentChallenge(), domain, consent: changed, messageHex: addressMembershipSigningHash(domain, changed) }, payer, 'join', f.network)).rejects.toThrow();
  }
  const retired = { ...domain, pool: a('ff') };
  await expect(validateMembershipConsent({ ...consentChallenge(),domain: retired, consent, messageHex: addressMembershipSigningHash(retired, consent) }, payer, 'join', f.network)).rejects.toThrow('retired');
  await expect(validateMembershipConsent(consentChallenge(), payer, 'leave', f.network)).rejects.toThrow('scope');
});
it('an optional automatic-payment wake-up sends no signature and no allowance transaction', async () => {
  const f=fixture(true);
  await submitMembershipDebit(f.relay,f.network,{payer,challenge:debitChallenge()});
  expect(f.relay.request).toHaveBeenCalledWith('membership-debits',{reservationId:h('17'),domain,debit});
  expect(()=>parseMembershipDebitChallenge({...debitChallenge(),allowanceAtomic:'66'})).toThrow('invalid');
});
it('changed payer, nonce, generation, historical rule or elapsed grace refuses payment before signing', async () => {
  const f = fixture(true);
  for (const patch of [{ payer: a('ff') }, { nonce: '8' }, { generation: '3' }, { month: '24320' }, { burn: '101' }, { ruleHash: h('ff') }]) {
    const changed = { ...debit, ...patch };
    const challenge = { ...debitChallenge(), debit: changed, allowanceAtomic: String(BigInt(changed.burn) + BigInt(changed.reserve)), messageHex: standingMembershipDebitSigningHash(domain, changed) };
    await expect(validateMembershipDebit(challenge, payer, f.network)).rejects.toThrow();
  }
  const other = { request: vi.fn(async () => RECOURSE_POOL_ABI.encodeFunctionResult('monthlyRule', [[0, 100, 100, 100, h('ff')]])) };
  await expect(validateMembershipDebit(debitChallenge(), payer, { ...f.network, rpcs: [f.rpc, other] })).rejects.toThrow('disagreement');
});
it('portfolio grouping and duplicate challenges are not accepted as public authorization material', () => {
  const view = { id: h('21'), kind: 'join', status: 'consenting', challenges: [consentChallenge()], pending: [] };
  expect(parseMembershipTransitionView(view)).toEqual(view);
  expect(() => parseMembershipTransitionView({ ...view, challenges: [consentChallenge(), consentChallenge()] })).toThrow('invalid');
  expect(() => parseMembershipTransitionView({ ...view, challenges: [{ ...consentChallenge(), siblings: [a('ff')] }] })).toThrow('invalid');
  expect(() => parseMembershipTransitionView({ ...view, kind: 'leave' })).toThrow('invalid');
});

it('resume status is bounded to pending public operation metadata', () => {
  const entry = { binding: consent.binding, account: payer, operation: { id: h('20'), status: 'submitted', transactionHash: h('22') } };
  const view = { id: h('21'), kind: 'join', status: 'consenting', challenges: [], pending: [entry] };
  expect(parseMembershipTransitionView(view)).toEqual(view);
  expect(() => parseMembershipTransitionView({ ...view, challenges: [consentChallenge()] })).toThrow('invalid');
  expect(() => parseMembershipTransitionView({ ...view, pending: [{ ...entry, ownerSignature: '0x1234' }] })).toThrow('invalid');
  expect(() => parseMembershipTransitionView({ ...view, pending: [{ ...entry, operation: { ...entry.operation, status: 'confirmed' } }] })).toThrow('invalid');
});

it('one leave action retains current and pending-next exit proofs without financial signatures',async()=>{
 const f=fixture(true),signBytes=vi.fn(),exitSecret=vi.fn(async(_c:unknown,salt:string)=>salt===h('a1')?h('b1'):h('b2'));
 const challenges=[{domain,consent:{...consent,joined:false},exitSalt:h('a1'),exitCommitment:membershipExitCommitment(h('b1'))},
   {domain,consent:{...consent,joined:false,nonce:'4'},exitSalt:h('a2'),exitCommitment:membershipExitCommitment(h('b2'))}];
 const relay={request:vi.fn(async(_path:string,body?:unknown)=>body?{retained:true}:challenges)};
 await retainMembershipDeparture(relay,f.network,{transitionId:h('21'),exitSecret,signBytes});
 expect(signBytes).not.toHaveBeenCalled();expect(exitSecret).toHaveBeenCalledTimes(2);
 expect(relay.request.mock.calls[1][1]).toEqual(challenges.map((challenge,i)=>({challenge,exitSecret:i?h('b2'):h('b1'),ownerSignature:null})));
});
it('suspended departure uses the recovered owner domain and no renewed financial approval',async()=>{
 const f=fixture(true),challenge={domain,consent:{...consent,joined:false,expiresAt:'999'},exitSalt:null,exitCommitment:null};
 vi.mocked(readStandingMembershipState).mockResolvedValue({controller:a('99'),mandate:{active:false,consentNonce:'3'}} as Awaited<ReturnType<typeof readStandingMembershipState>>);
 const relay={request:vi.fn(async(_path:string,body?:unknown)=>body?{retained:true}:[challenge])},exitSecret=vi.fn();
 const signBytes=vi.fn(async(_a:string,_b:string,bytes:Uint8Array)=>wallet.signMessage(bytes));
 await retainMembershipDeparture(relay,f.network,{transitionId:h('21'),exitSecret,signBytes});
 expect(exitSecret).not.toHaveBeenCalled();expect(signBytes).toHaveBeenCalledWith(payer,consent.binding,getBytes(authenticatedDepartureSigningHash(domain,challenge.consent)));
});
it.each(['account','nonce','commitment'])('departure refuses unverifiable material before retaining any proof: %s',async mutation=>{
 const f=fixture(true),challenge={domain,consent:{...consent,joined:false},exitSalt:h('a1'),exitCommitment:membershipExitCommitment(h('b1'))};
 if(mutation==='account')challenge.consent.account=a('ff');if(mutation==='nonce')challenge.consent.nonce='5';
 if(mutation==='commitment')challenge.exitCommitment=h('ff');
 const relay={request:vi.fn(async()=>[challenge])};
 await expect(retainMembershipDeparture(relay,f.network,{transitionId:h('21'),exitSecret:async()=>h('b1'),signBytes:vi.fn()})).rejects.toThrow();
 expect(relay.request).toHaveBeenCalledTimes(1);
});

it('rejoin binds both historical payments and the admission month into the owner signature', async () => {
  const f = fixture();
  const rejoinPayments = [
    { month: '24320', burn: '100', reserve: '500', ruleHash: h('16') },
    { month: '24321', burn: '50', reserve: '100', ruleHash: h('16') },
  ];
  await submitMembershipConsent(f.relay, f.network, { transitionId: h('21'), kind: 'join', account: payer,
    challenge: { ...consentChallenge(), rejoinPayments }, signBytes: bytes => wallet.signMessage(bytes), exitSecret: async () => h('23') });
  const body = f.relay.request.mock.calls[0][1] as { ownerSignature: string; standing: StandingMembershipAuthorization };
  expect(body.standing.rejoinPayments).toEqual(rejoinPayments);
  expect(body.standing.admissionMonth).toBe('24322');
  const altered = { ...body.standing, rejoinPayments: rejoinPayments.map((p, i) => i ? p : { ...p, reserve: '100' }) };
  expect(verifyMessage(getBytes(standingMembershipSigningHash(domain, altered)), body.ownerSignature)).not.toBe(wallet.address);
});
it('rejoin refuses current-month, duplicate, excessive-burn and wrong-rule invoices before signing', async () => {
  const f = fixture(), invoice = { month: '24321', burn: '100', reserve: '100', ruleHash: h('16') };
  for (const rejoinPayments of [[{ ...invoice, month: '24322' }], [invoice, invoice], [{ ...invoice, burn: '101' }], [{ ...invoice, ruleHash: h('ff') }]]) {
    await expect(validateMembershipConsent({ ...consentChallenge(), rejoinPayments }, payer, 'join', f.network)).rejects.toThrow();
  }
  await expect(validateMembershipConsent({ ...consentChallenge(), admissionMonth: '24321' }, payer, 'join', f.network)).rejects.toThrow();
});
it('a new month arriving during approval prevents relaying the old signed rejoin', async () => {
  const f = fixture();
  await expect(submitMembershipConsent(f.relay, f.network, { transitionId: h('21'), kind: 'join', account: payer,
    challenge: consentChallenge(), exitSecret: async () => h('23'), signBytes: async bytes => {
      f.state.month = '24323'; return wallet.signMessage(bytes);
    } })).rejects.toThrow();
  expect(f.relay.request).not.toHaveBeenCalled();
});
