import { beforeEach, expect, test, vi } from 'vitest';
import { Interface } from 'ethers';
import { authorizeHumanMembershipDebit, readHumanMembershipApproval, resumeHumanMembershipApproval } from './human-membership-debit';
import type { MembershipDebitChallenge } from './membership-client';
const f = vi.hoisted(() => ({ store: new Map<string, string>(), account: '', signer: '', allowance: '0', hash: false, approval: { to: '', data: '', value: '0', chainId: 8453 },
  pending: null as { target: string; value: string; data: string } | null, send: vi.fn(), key: vi.fn(async () => 'private'), validate: vi.fn(),
  submit: vi.fn(), prepare: vi.fn(), deliver: vi.fn(), rpc: vi.fn() }));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device', getItemAsync: async (key: string) => f.store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { f.store.set(key, value); } }));
vi.mock('../protocol/runtime', () => ({ ownerChainNetwork: () => ({ rpcs: [{ request: f.rpc }, { request: f.rpc }], deployment: async () => ({
  addresses: { kernel: f.approval.to }, revision: 1n, blockHash: `0x${'55'.repeat(32)}` }) }) }));
vi.mock('../security/biometricAction', () => ({ withBiometricAction: async (_reason: string, run: (action: object) => Promise<unknown>) => run({}) }));
vi.mock('../security/ActionWallet', () => ({ ActionWallet: class { address = f.signer; sendTransaction = f.send; } }));
vi.mock('../wallet/SeedManager', () => ({ default: { getMnemonic: async () => 'backup', getEVMPrivateKey: f.key } }));
vi.mock('../wallet/TransactionService', () => ({ default: { providerFor: () => ({}) } }));
vi.mock('../../store/walletStore', () => ({ useWalletStore: { getState: () => ({ address: f.account }) } }));
vi.mock('../../i18n/translate', () => ({ translate: (_key: string, fallback: string) => fallback }));
vi.mock('./human-membership', () => ({ humanMembershipRelay: () => ({}), signHumanMembershipBytes: vi.fn() }));
vi.mock('./membership-client', () => ({ prepareMembershipDebit: vi.fn(), validateMembershipDebit: f.validate,
  prepareMembershipApproval: async () => f.approval, submitMembershipDebit: f.submit }));
vi.mock('./human-account', () => ({ deriveHumanAccount: async () => ({ evm: f.account }), readHumanAccountSelection: async () => ({ kind: f.hash ? 'hash' : 'curve' }) }));
vi.mock('./human-hash-spending', () => ({ prepareHumanHashSpending: f.prepare }));
vi.mock('./human-hash-delivery', () => ({ deliverHumanHashSpending: f.deliver, pendingHumanHashDeliveryOperation: async () => f.pending }));
vi.mock('./hash-account-delivery', () => ({ hashDeliveryId: () => `0x${'66'.repeat(32)}` }));
const a = (v: string) => `0x${v.repeat(20)}`, h = (v: string) => `0x${v.repeat(32)}`;
const token = new Interface(['function allowance(address,address) view returns(uint256)', 'function approveCurrent(address,uint256,uint256) returns(bool)']);
const challenge: MembershipDebitChallenge = { reservationId: h('11'), domain: { chainId: '8453', pointer: a('12'), kernel: a('13'), pool: a('14') },
  debit: { binding: h('15'), payer: a('16'), month: '24322', burn: '40', reserve: '25', nonce: '0', generation: '1', revision: '1', ruleHash: h('17'), expiresAt: '1700000300' },
  messageHex: h('18'), allowanceAtomic: '65' };
beforeEach(() => {
  vi.clearAllMocks(); f.store.clear(); f.account = challenge.debit.payer; f.signer = f.account; f.allowance = '0'; f.hash = false; f.pending = null;
  f.approval = { to: challenge.domain.kernel, data: token.encodeFunctionData('approveCurrent', [challenge.domain.pool, 65, 1]), value: '0', chainId: 8453 };
  f.send.mockResolvedValue({ hash: h('19'), wait: async () => ({ status: 1 }) }); f.validate.mockResolvedValue(challenge);
  f.submit.mockResolvedValue({ id: h('20'), status: 'queued', transactionHash: null });
  f.prepare.mockResolvedValue({ account: f.account });
  f.deliver.mockResolvedValue({ status: 'pending', transactionHash: h('21') });
  f.rpc.mockImplementation(async (method: string) => method === 'eth_estimateGas' ? '0x5208' : token.encodeFunctionResult('allowance', [f.allowance]));
});
test('curve approval preserves the exact reviewed transaction even when replacing an excessive existing allowance', async () => {
  f.allowance = String(2n ** 256n - 1n);
  expect((await authorizeHumanMembershipDebit(challenge)).status).toBe('submitted');
  expect(f.send).toHaveBeenCalledWith(f.approval);
  expect([...token.decodeFunctionData('approveCurrent', f.send.mock.calls[0][0].data)]).toEqual([challenge.domain.pool, 65n, 1n]);
  expect(f.submit).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ payer: f.account, challenge }));
});
test('exact existing allowance needs no approval, while stale or wrong-wallet actions cannot send', async () => {
  f.allowance = '65'; await authorizeHumanMembershipDebit(challenge); expect(f.send).not.toHaveBeenCalled(); expect(f.key).not.toHaveBeenCalled();
  f.allowance = '0'; f.validate.mockRejectedValueOnce(Error('stale'));
  await expect(authorizeHumanMembershipDebit(challenge)).rejects.toThrow('stale'); expect(f.send).not.toHaveBeenCalled();
  f.signer = a('ff'); await expect(authorizeHumanMembershipDebit(challenge)).rejects.toThrow('wrong_wallet'); expect(f.send).not.toHaveBeenCalled();
});
test('hash approval uses the hash operation and defers the debit until its outcome is known', async () => {
  f.hash = true;
  expect(await authorizeHumanMembershipDebit(challenge)).toEqual({ status: 'approval', delivery: { status: 'pending', transactionHash: h('21') } });
  expect(f.prepare).toHaveBeenCalledWith('backup', expect.objectContaining({ target: f.approval.to, value: '0', data: f.approval.data }), expect.anything());
  expect(f.key).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});
test('an unrelated pending hash call cannot run under monthly debit authorization', async () => {
  f.pending = { target: a('ff'), value: '0', data: f.approval.data };
  await expect(authorizeHumanMembershipDebit(challenge)).rejects.toThrow('spending_pending');
  expect(f.deliver).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});
test('resuming an expired-challenge approval binds the exact displayed account, target, spender and amount', async () => {
  f.pending = { target: f.approval.to, value: '0', data: f.approval.data };
  await authorizeHumanMembershipDebit(challenge); f.deliver.mockClear();
  const review = await readHumanMembershipApproval(); expect(review).toMatchObject({ account: f.account, kernel: f.approval.to, pool: challenge.domain.pool, amountAtomic: '65' });
  await expect(resumeHumanMembershipApproval({ ...review!, amountAtomic: '66' })).rejects.toThrow('approval_changed'); expect(f.deliver).not.toHaveBeenCalled();
  expect((await resumeHumanMembershipApproval(review!)).status).toBe('pending'); expect(f.deliver).toHaveBeenCalledTimes(1);
});

test('approval-shaped calls without verified monthly provenance are never offered for monthly resume', async () => {
  f.pending = { target: a('aa'), value: '0', data: token.encodeFunctionData('approveCurrent', [a('bb'), 999, 1]) };
  expect(await readHumanMembershipApproval()).toBeNull();
  f.pending = { target: f.approval.to, value: '0', data: f.approval.data };
  expect(await readHumanMembershipApproval()).toBeNull();
  await authorizeHumanMembershipDebit(challenge); f.deliver.mockClear();
  f.pending = { ...f.pending, target: a('aa') };
  expect(await readHumanMembershipApproval()).toBeNull(); expect(f.deliver).not.toHaveBeenCalled();
});
