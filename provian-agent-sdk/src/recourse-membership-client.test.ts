import { beforeEach, expect, it, vi } from 'vitest';
import { Interface, Wallet, getBytes, verifyMessage } from 'ethers';
import { readRecoursePoolChain } from './recourse-pool-chain';
import { RECOURSE_POOL_ABI } from './recourse-pool-abi';
import { addressMembershipSigningHash, exactMembershipDebitSigningHash } from './recourse-membership-authorization';
import { parseMembershipTransitionView, validateMembershipConsent, validateMembershipDebit, submitMembershipConsent,
  submitMembershipDebit, prepareMembershipApproval, parseMembershipDebitChallenge } from './recourse-membership-client';
import type { OwnerChainNetwork } from './recourse-owner-chain';
import type { ProtocolDeployment } from './protocol-pointer';
vi.mock('./recourse-pool-chain', () => ({ readRecoursePoolChain: vi.fn() }));
const a = (b: string) => `0x${b.repeat(20)}`, h = (b: string) => `0x${b.repeat(32)}`;
const wallet = new Wallet(h('11')), payer = wallet.address.toLowerCase();
const domain = { chainId: '8453', pointer: a('12'), kernel: a('13'), pool: a('14') };
const consent = { binding: h('15'), account: payer, nonce: '3', joined: true, revision: '1', ruleHash: h('16'), expiresAt: '1200' };
const debit = { binding: h('15'), payer, nonce: '7', month: '24321', burn: '40', reserve: '25', generation: '2', revision: '1', ruleHash: h('16'), expiresAt: '1200' };
const consentChallenge = () => ({ domain, consent, messageHex: addressMembershipSigningHash(domain, consent) });
const debitChallenge = () => ({ reservationId: h('17'), domain, debit, messageHex: exactMembershipDebitSigningHash(domain, debit), allowanceAtomic: '65' });
function fixture(joined = false) {
  const deployment = { pointer: domain.pointer, addresses: { kernel: domain.kernel, recoursePool: domain.pool }, revision: 1n, blockHash: h('18'), manifestHash: h('19') } as ProtocolDeployment;
  const state = { pool: domain.pool, kernel: domain.kernel, currentAddress: payer, consentNonce: '3', addressConsent: joined,
    debitNonce: '7', consentGeneration: '2', timestamp: 1000, month: '24322', signedRuleHash: h('16') };
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
it('consent signs raw validated bytes and refuses a pointer change during signing', async () => {
  const f = fixture(), sign = vi.fn((bytes: Uint8Array) => wallet.signMessage(bytes));
  await submitMembershipConsent(f.relay, f.network, { transitionId: h('21'), kind: 'join', account: payer, challenge: consentChallenge(), signBytes: sign });
  expect(sign).toHaveBeenCalledWith(getBytes(consentChallenge().messageHex));
  const body = f.relay.request.mock.calls[0][1] as { ownerSignature: string };
  expect(verifyMessage(getBytes(consentChallenge().messageHex), body.ownerSignature)).toBe(wallet.address);
  f.relay.request.mockClear();
  await expect(submitMembershipConsent(f.relay, f.network, { transitionId: h('21'), kind: 'join', account: payer, challenge: consentChallenge(),
    signBytes: async bytes => { vi.mocked(f.network.deployment).mockResolvedValue({ ...f.deployment, revision: 2n }); return wallet.signMessage(bytes); } })).rejects.toThrow('retired');
  expect(f.relay.request).not.toHaveBeenCalled();
});
it('relay challenge cannot choose another account, nonce, rule, direction or retired pool', async () => {
  const f = fixture();
  for (const patch of [{ account: a('ff') }, { nonce: '4' }, { ruleHash: h('ff') }, { joined: false }, { expiresAt: '999' }, { expiresAt: '1301' }]) {
    const changed = { ...consent, ...patch };
    await expect(validateMembershipConsent({ domain, consent: changed, messageHex: addressMembershipSigningHash(domain, changed) }, payer, 'join', f.network)).rejects.toThrow();
  }
  const retired = { ...domain, pool: a('ff') };
  await expect(validateMembershipConsent({ domain: retired, consent, messageHex: addressMembershipSigningHash(retired, consent) }, payer, 'join', f.network)).rejects.toThrow('retired');
  await expect(validateMembershipConsent(consentChallenge(), payer, 'leave', f.network)).rejects.toThrow('scope');
});
it('exact approval is only burn plus reserve and has independently verified current token and pool', async () => {
  const f = fixture(true), tx = await prepareMembershipApproval(debitChallenge(), payer, f.network);
  const token = new Interface(['function approveCurrent(address,uint256,uint256) returns(bool)']);
  expect(tx.to).toBe(domain.kernel); expect(tx.value).toBe('0');
  expect([...token.decodeFunctionData('approveCurrent', tx.data)]).toEqual([domain.pool, 65n, 1n]);
  await submitMembershipDebit(f.relay, f.network, { payer, challenge: debitChallenge(), signBytes: bytes => wallet.signMessage(bytes) });
  expect(f.relay.request).toHaveBeenCalledWith('membership-debits', expect.objectContaining({ reservationId: h('17'), debit }));
  expect(() => parseMembershipDebitChallenge({ ...debitChallenge(), allowanceAtomic: '66' })).toThrow('invalid');
});
it('changed payer, nonce, generation, historical rule or elapsed grace refuses payment before signing', async () => {
  const f = fixture(true);
  for (const patch of [{ payer: a('ff') }, { nonce: '8' }, { generation: '3' }, { month: '24320' }, { burn: '101' }, { ruleHash: h('ff') }]) {
    const changed = { ...debit, ...patch };
    const challenge = { ...debitChallenge(), debit: changed, allowanceAtomic: String(BigInt(changed.burn) + BigInt(changed.reserve)), messageHex: exactMembershipDebitSigningHash(domain, changed) };
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
