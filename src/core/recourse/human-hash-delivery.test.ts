import { hashDeliveryId } from './hash-account-delivery';
import { beforeEach, expect, test, vi } from 'vitest';
import { sha256 } from 'ethers';
import type { BiometricAction } from '../security/biometricAction';
import { hashAccountCall, type SignedHashAccountOperation } from './hash-account';
import { deliverHumanHashSpending, pendingHumanHashDeliveryOperation } from './human-hash-delivery';
const f = vi.hoisted(() => ({ store: new Map<string, string>(), account: '', operation: null as unknown,
  completed: null as { hash: string; outcome: 'succeeded' | 'cancelled' } | null, failCompletion: false, active: true,
  sender: '', tx: '', block: '', mined: false, rotations: 0, sends: 0, rpc: vi.fn(), auxiliaryBinding:null as string|null, boundAccount:'' }));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device', getItemAsync: async (key: string) => f.store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    if (f.failCompletion && JSON.parse(value).complete) { f.failCompletion = false; throw Error('delivery write interrupted'); }
    f.store.set(key, value);
  } }));
vi.mock('../wallet/pacedSeed', () => ({ mnemonicToSeedPaced: async () => new Uint8Array(64).fill(1) }));
vi.mock('../wallet/SeedManager', () => ({ default: { getMnemonic: async () => 'backup' } }));
vi.mock('../wallet/TransactionService', () => ({ default: { providerFor: () => ({}) } }));
vi.mock('../security/ActionWallet', () => ({ ActionWallet: class { address = f.sender; async sendTransaction() { ++f.sends; return { hash: f.tx }; } } }));
vi.mock('../security/biometricAction', () => ({ assertBiometricAction: () => { if (!f.active) throw Error('approval expired'); } }));
vi.mock('../security/chainNonce', () => ({ readChainOperation: async () => { throw Error('chain_operation_not_found'); } }));
vi.mock('../security/secureNonceStore', () => ({ secureNonceStore: () => ({}) }));
vi.mock('../protocol/runtime', () => ({ ownerChainNetwork: () => ({ rpcs: [{ request: f.rpc }, { request: f.rpc }], deployment: vi.fn() }) }));
vi.mock('../protocol/transaction', () => ({ assertCurrentProtocolTransaction: async () => ({}) }));
vi.mock('../../store/walletStore', () => ({ useWalletStore: { getState: () => ({ address: f.account }) } }));
vi.mock('./human-account', () => ({ humanAccountPaths: () => ({ evm: "m/44'/60'/0'/0/0" }) }));
vi.mock('./human-bound-hash-account',()=>({discoverBoundHumanHashAccount:async()=>({evm:f.boundAccount})}));
vi.mock('./human-hash-spending', () => ({
  readHumanHashSpendingDelivery: async () => ({ operation: f.operation, cancellation: null, completed: f.completed, auxiliaryBinding:f.auxiliaryBinding }),
  // The old pending-only accessor deliberately hides a completed operation.
  pendingHumanHashSpending: async () => ({ operation: f.completed ? null : f.operation, cancellation: null }),
  completeHumanHashSpending: async (_mnemonic: string, _account: string, hash: string) => {
    if (!f.completed) { ++f.rotations; f.completed = { hash, outcome: 'succeeded' }; }
    if (f.completed.hash !== hash) throw Error('receipt changed'); return f.completed.outcome;
  },
}));
const a = (v: string) => `0x${v.repeat(20)}`, h = (v: string) => `0x${v.repeat(32)}`, action = {} as BiometricAction;
const operation: SignedHashAccountOperation = { chainId: '8453', account: a('11'), nonce: '0', target: a('22'), value: '0', callGas: '100000', data: '0x1234',
  nextCommitment: h('33'), publicKey: h('44'), signingRoot: sha256(h('44')), signature: `0x${'55'.repeat(7856)}` };
beforeEach(() => {
  f.store.clear(); f.account = operation.account; f.operation = operation; f.completed = null; f.failCompletion = false;
  f.active = true; f.sender = a('66'); f.tx = h('77'); f.block = h('88'); f.mined = false; f.rotations = 0; f.sends = 0;
  f.auxiliaryBinding=null;f.boundAccount=operation.account;
  f.rpc.mockReset(); f.rpc.mockImplementation(async (method: string) => {
    if (method === 'eth_getTransactionReceipt') return f.mined ? { transactionHash: f.tx, blockHash: f.block, blockNumber: '0x64', status: '0x1' } : null;
    if (method === 'eth_getTransactionByHash') return { hash: f.tx, blockHash: f.block, from: f.sender, to: operation.account, input: hashAccountCall(operation), value: '0x0' };
    if (method === 'eth_getBlockByNumber') return { number: '0x64', hash: f.block };
    throw Error('unexpected rpc');
  });
});
test('a crash after key rotation resumes the exact retained operation and completes without another send or rotation', async () => {
  await deliverHumanHashSpending(operation.account, action, hashDeliveryId(operation)); expect(f.sends).toBe(1);
  f.mined = true; f.failCompletion = true;
  await expect(deliverHumanHashSpending(operation.account, action, hashDeliveryId(operation))).rejects.toThrow('delivery write interrupted');
  expect(f.rotations).toBe(1); expect(f.completed?.hash).toBe(f.tx);
  expect(await pendingHumanHashDeliveryOperation(operation.account)).toBeNull();
  expect(await deliverHumanHashSpending(operation.account, action, hashDeliveryId(operation))).toEqual({ status: 'complete', transactionHash: f.tx, outcome: 'succeeded' });
  expect(f.sends).toBe(1); expect(f.rotations).toBe(1);
  expect(await pendingHumanHashDeliveryOperation(operation.account)).toBeNull();
});
test('expired biometric authority or a different selected wallet cannot deliver an operation', async () => {
  f.active = false; await expect(deliverHumanHashSpending(operation.account, action, hashDeliveryId(operation))).rejects.toThrow('approval expired');
  f.active = true; f.account = a('ff');
  await expect(deliverHumanHashSpending(operation.account, action, hashDeliveryId(operation))).rejects.toThrow('wrong_wallet');
  expect(f.sends).toBe(0); expect(f.rotations).toBe(0); expect(f.store.size).toBe(0);
});

test('a completed competing cancellation is returned before the losing original can spend more gas', async () => {
  await deliverHumanHashSpending(operation.account, action, hashDeliveryId(operation)); expect(f.sends).toBe(1);
  f.completed = { hash: h('99'), outcome: 'cancelled' };
  expect(await deliverHumanHashSpending(operation.account, action, hashDeliveryId(operation))).toEqual({ status: 'complete', transactionHash: h('99'), outcome: 'cancelled' });
  expect(f.sends).toBe(1); expect(f.rotations).toBe(0); expect(f.rpc).not.toHaveBeenCalled();
  expect(await pendingHumanHashDeliveryOperation(operation.account)).toBeNull();
});

test('queued delivery cannot substitute a newer account operation for the exact reviewed intent', async () => {
  const queued = deliverHumanHashSpending(operation.account, action, hashDeliveryId(operation));
  f.operation = { ...operation, data: '0xabcd' };
  await expect(queued).rejects.toThrow('intent_changed');
  expect(f.sends).toBe(0); expect(f.rotations).toBe(0); expect(f.rpc).not.toHaveBeenCalled();
  f.completed = { hash: h('99'), outcome: 'succeeded' };
  await expect(deliverHumanHashSpending(operation.account, action, hashDeliveryId(operation))).rejects.toThrow('intent_changed');
});
test('auxiliary gas delivery requires the seed-derived current account and leaves the primary wallet selected',async()=>{
  f.account=a('99');f.auxiliaryBinding=h('aa');f.boundAccount=a('bb');
  await expect(deliverHumanHashSpending(operation.account,action,hashDeliveryId(operation))).rejects.toThrow('wrong_wallet');
  expect(f.sends).toBe(0);
  f.boundAccount=operation.account;
  await deliverHumanHashSpending(operation.account,action,hashDeliveryId(operation));
  expect(f.sends).toBe(1);expect(f.account).toBe(a('99'));
});
