import { beforeEach, expect, test, vi } from 'vitest';
import { Transaction, type Provider } from 'ethers';
import { ActionWallet } from './ActionWallet';
import type { BiometricAction } from './biometricAction';
import { builderCodeGas, withBuilderCode } from '../protocol/builder-code';

// The real ActionWallet against an in-memory nonce journal and a fake provider: every Base
// transaction the app signs carries Provian's Builder Code, with gas estimated on those bytes.
const f = vi.hoisted(() => ({ journals: new Map<string, unknown>(), estimated: [] as string[], sent: [] as string[], chainId: 8453n }));
vi.mock('expo-crypto', () => ({ randomUUID: () => globalThis.crypto.randomUUID() }));
vi.mock('./biometricAction', () => ({ assertBiometricAction: () => undefined }));
vi.mock('./secureNonceStore', () => ({ secureNonceStore: () => ({
  transact: async (key: string, change: (current: unknown) => unknown) => {
    const next = change(f.journals.get(key) ?? null);
    f.journals.set(key, next);
    return next;
  },
}) }));
vi.mock('../protocol/runtime', () => ({ ownerChainNetwork: () => ({}) }));
vi.mock('../protocol/transaction', () => ({
  assertCurrentProtocolTransaction: async () => ({}), assertCurrentProtocolAddresses: async () => ({}), typedDataProtocolAddresses: () => [],
}));

const key = `0x${'42'.repeat(32)}`;
const target = `0x${'33'.repeat(20)}`;
const call = '0xa9059cbb' + '0'.repeat(128);
const contract = `0x${'55'.repeat(20)}`;

function provider(): Provider {
  return {
    getNetwork: async () => ({ chainId: f.chainId, name: 'test' }),
    estimateGas: async (tx: { data?: string }) => { f.estimated.push(tx.data ?? '0x'); return 50_000n; },
    getFeeData: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, gasPrice: null }),
    getTransactionCount: async () => 0,
    getCode: async (address: string) => address.toLowerCase() === contract ? '0x6080' : '0x',
    broadcastTransaction: async (raw: string) => { f.sent.push(raw); return { hash: Transaction.from(raw).hash }; },
    getTransaction: async () => null,
    getTransactionReceipt: async () => null,
    getBlockNumber: async () => 1,
    getBlock: async () => null,
  } as unknown as Provider;
}

beforeEach(() => { f.journals.clear(); f.estimated = []; f.sent = []; f.chainId = 8453n; });

test('a Base call is estimated and signed with the Builder Code', async () => {
  await new ActionWallet(key, {} as BiometricAction, provider()).sendTransaction({ to: target, data: call });
  expect(f.estimated).toEqual([withBuilderCode(call)]);
  expect(Transaction.from(f.sent[0]).data).toBe(withBuilderCode(call));
});

test('a plain Base transfer carries only the Builder Code', async () => {
  await new ActionWallet(key, {} as BiometricAction, provider()).sendTransaction({ to: target, value: 1n });
  expect(Transaction.from(f.sent[0]).data).toBe(withBuilderCode('0x'));
});

test('a plain transfer to a contract goes without the suffix, so receive() still runs', async () => {
  await new ActionWallet(key, {} as BiometricAction, provider()).sendTransaction({ to: contract, value: 1n });
  expect(Transaction.from(f.sent[0]).data).toBe('0x');
});

test("a dApp's 21,000-gas value send clears the EIP-7623 floor once attributed", async () => {
  await new ActionWallet(key, {} as BiometricAction, provider()).sendTransaction({ to: target, value: 1n, gasLimit: 21_000n });
  const tx = Transaction.from(f.sent[0]);
  let tokens = 0n;
  for (let i = 2; i < tx.data.length; i += 2) tokens += tx.data.slice(i, i + 2) === '00' ? 1n : 4n;
  expect(tx.gasLimit).toBeGreaterThanOrEqual(21_000n + 10n * tokens);
});

test("a dApp's fixed gas limit gains exactly the suffix gas", async () => {
  await new ActionWallet(key, {} as BiometricAction, provider()).sendTransaction({ to: target, data: call, gasLimit: 60_000n });
  expect(Transaction.from(f.sent[0]).gasLimit).toBe(60_000n + builderCodeGas(call));
});

test('the CREATE2 deployer and another chain are sent exactly as given (RED controls)', async () => {
  await new ActionWallet(key, {} as BiometricAction, provider()).sendTransaction({ to: '0x4e59b44847b379578588920cA78FbF26c0B4956C', data: call });
  expect(Transaction.from(f.sent[0]).data).toBe(call);
  f.chainId = 1n;
  await new ActionWallet(key, {} as BiometricAction, provider()).sendTransaction({ to: target, data: call });
  expect(Transaction.from(f.sent[1]).data).toBe(call);
});
