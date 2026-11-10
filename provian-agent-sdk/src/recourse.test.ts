vi.mock('./protocol-runtime', () => ({ currentProtocolDeployment: async () => ({ addresses: { kernel: requireConfiguredPvt9Runtime().address } }), ownerChainNetwork: () => ({}) }));
vi.mock('./recourse-binding-chain', () => ({ waitForRecourseBinding: (...args: unknown[]) => h.confirm(...args) }));
import { recoverySigningRoot, recoveryCommitment as commitmentHash } from './recourse-hash-authorization';
import { createHash } from 'crypto';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { AgentKeystore } from './keystore';
import { requireConfiguredPvt9Runtime } from './pvt9-base-config.generated';
import { bindRecourseOwnership, recourseBindingMessage, type RecourseBinding } from './recourse';
const h = vi.hoisted(() => ({ initialized: false, sign: vi.fn(), fetch: vi.fn(), confirm: vi.fn(async (..._args: unknown[]) => {}) }));
vi.mock('./guarded-fetch', () => ({ guardedFetcher: () => h.fetch }));
vi.mock('./keystore', () => ({
  initializeRecoveryKeystore: (key: AgentKeystore) => { h.initialized = true; return key; },
  withRecoveryMaterial: async (_key: AgentKeystore, _pass: string, callback: (secret: Uint8Array, signingSeed: Uint8Array) => unknown) => {
    const secret = new Uint8Array(32).fill(7);
    try { return await callback(secret, new Uint8Array(32).fill(8)); } finally { secret.fill(0); }
  },
  withDecryptedKey: async (_key: AgentKeystore, _pass: string, callback: (key: { privateKey: string }) => unknown) =>
    callback({ privateKey: 'test-key-never-transmitted' }),
}));
vi.mock('./link-signing', () => ({ signEip191Message: (...args: unknown[]) => h.sign(...args) }));
const walletId = 'agent-test';
const address = `0x${'12'.repeat(20)}`;
const identity = `0x${createHash('sha256').update(JSON.stringify(['provian ownership', 'agent', walletId])).digest('hex')}`;
let signingRoot: string;
let recoveryCommitment: string;
beforeAll(async () => {
  signingRoot = await recoverySigningRoot(new Uint8Array(32).fill(8));
  recoveryCommitment = commitmentHash(new Uint8Array(32).fill(7), signingRoot);
});
const config = { relayUrl: 'https://relay.example', apiKey: 'key', apiSecret: 'secret', walletId };
const input = { keystore: { wallet_id: walletId, address } as AgentKeystore,
  passphrase: 'local-only', keystorePath: '/test/encrypted' };
let change: Partial<RecourseBinding>;
beforeEach(() => {
  vi.clearAllMocks(); h.initialized = false; change = {};
  h.sign.mockResolvedValue('0xsignature');
  h.fetch.mockImplementation(async (url: string, options: RequestInit) => {
    expect(h.initialized).toBe(true);
    const text = String(options.body);
    expect(text).not.toContain('local-only');
    expect(text).not.toContain('test-key-never-transmitted');
    expect(text).not.toContain('07'.repeat(32));
    if (url.endsWith('/binding-challenge')) {
      expect(JSON.parse(text)).toEqual({ address, recoveryCommitment, signingRoot });
      const binding: RecourseBinding = { address, identity, recoveryCommitment, signingRoot,
        kernel: requireConfiguredPvt9Runtime().address.toLowerCase(), nonce: `0x${'ab'.repeat(32)}`,
        expiresAtMs: Date.now() + 60_000, ...change };
      return { ok: true, json: async () => ({ binding, message: recourseBindingMessage(binding) }) };
    }
    return { ok: true, json: async () => ({ bound: true }) };
  });
});
it('persists independent recovery material before transmitting only its hash and exact binding signature', async () => {
  expect(await bindRecourseOwnership(config, input)).toEqual({ bound: true });
  expect(h.sign).toHaveBeenCalledOnce();
  const body = JSON.parse(h.fetch.mock.calls[1][1].body);
  expect(body.signature).toBe('0xsignature');
  expect(body.binding.recoveryCommitment).toBe(recoveryCommitment);
});
it.each(['identity', 'address', 'kernel', 'recoveryCommitment', 'signingRoot'] as const)('refuses substituted %s before signing', async field => {
  change = { [field]: `0x${'ff'.repeat(field === 'address' || field === 'kernel' ? 20 : 32)}` };
  await expect(bindRecourseOwnership(config, input)).rejects.toThrow('recourse_challenge_invalid');
  expect(h.sign).not.toHaveBeenCalled();
  expect(h.fetch).toHaveBeenCalledOnce();
});
it('refuses expired challenge and mismatched local wallet', async () => {
  change = { expiresAtMs: Date.now() - 1 };
  await expect(bindRecourseOwnership(config, input)).rejects.toThrow('recourse_challenge_invalid');
  await expect(bindRecourseOwnership({ ...config, walletId: 'other' }, input)).rejects.toThrow('recourse_wallet_mismatch');
  expect(h.sign).not.toHaveBeenCalled();
});
