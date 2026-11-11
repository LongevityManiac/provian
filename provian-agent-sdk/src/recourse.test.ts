import { Wallet, getBytes, verifyMessage } from 'ethers';
import { addressMembershipSigningHash } from './recourse-membership-authorization';
vi.mock('./protocol-runtime', () => ({ currentProtocolDeployment: async () => ({ pointer: `0x${'34'.repeat(20)}`, revision: 1n, addresses: { kernel: requireConfiguredPvt9Runtime().address } }), ownerChainNetwork: () => ({}) }));
vi.mock('./recourse-pool-chain', () => ({ readRecoursePoolChain: async () => ({ pool: `0x${'56'.repeat(20)}`, consentNonce: '0', signedRuleHash: `0x${'78'.repeat(32)}`, timestamp: Math.floor(Date.now()/1000) }) }));
vi.mock('./recourse-binding-chain', () => ({ waitForRecourseBinding: (...args: unknown[]) => h.confirm(...args) }));
import { recoverySigningRoot, recoveryCommitment as commitmentHash } from './recourse-hash-authorization';
import { addressRecoveryBinding } from './recourse-address-binding';
import { deriveBoundRecoveryCredential } from './recourse-address-credential';
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
    callback({ privateKey: `0x${'11'.repeat(32)}` }),
}));
vi.mock('./link-signing', () => ({ signEip191Message: (...args: unknown[]) => h.sign(...args) }));
const walletId = 'agent-test';
const testWallet = new Wallet(`0x${'11'.repeat(32)}`);
const address = testWallet.address.toLowerCase();
const identity = addressRecoveryBinding({ chainId: '8453', pointer: `0x${'34'.repeat(20)}`, origin: address });
let signingRoot: string;
let recoveryCommitment: string;
beforeAll(async () => {
  const root = new Uint8Array(64); root.fill(7, 0, 32); root.fill(8, 32);
  const derived = deriveBoundRecoveryCredential(root, identity, '0');
  signingRoot = await recoverySigningRoot(derived.signingSeed);
  recoveryCommitment = commitmentHash(derived.recoverySecret, signingRoot);
});
const config = { relayUrl: 'https://relay.example', apiKey: 'key', apiSecret: 'secret', walletId };
const input = { keystore: { wallet_id: walletId, address } as AgentKeystore,
  passphrase: 'local-only', keystorePath: '/test/encrypted' };
let change: Partial<RecourseBinding>;
let member = false;
beforeEach(() => {
  vi.clearAllMocks(); h.initialized = false; change = {}; member = false;
  h.sign.mockResolvedValue('0xsignature');
  h.fetch.mockImplementation(async (url: string, options: RequestInit) => {
    expect(h.initialized).toBe(true);
    const text = String(options.body);
    expect(text).not.toContain('local-only');
    expect(text).not.toContain('11'.repeat(32));
    expect(text).not.toContain('07'.repeat(32));
    if (url.endsWith('/binding-challenge')) {
      expect(JSON.parse(text)).toEqual({ address, recoveryCommitment, signingRoot });
      const binding: RecourseBinding = { address, identity, recoveryCommitment, signingRoot,
        kernel: requireConfiguredPvt9Runtime().address.toLowerCase(), nonce: `0x${'ab'.repeat(32)}`,
        expiresAtMs: Date.now() + 60_000, ...change };
      const memberConsent = member ? { domain: { chainId: '8453', pointer: `0x${'34'.repeat(20)}`, kernel: binding.kernel, pool: `0x${'56'.repeat(20)}` },
        consent: { binding: identity, account: address, nonce: '0', joined: true, revision: '1', ruleHash: `0x${'78'.repeat(32)}`, expiresAt: String(Math.floor(binding.expiresAtMs/1000)) } } : null;
      return { ok: true, json: async () => ({ binding, message: recourseBindingMessage(binding), memberConsent }) };
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

it('signs exact member consent bytes with the sovereign key and sends only the scoped mandate', async () => {
  member = true;
  await bindRecourseOwnership(config, input);
  const body = JSON.parse(h.fetch.mock.calls[1][1].body), domain = { chainId: '8453', pointer: `0x${'34'.repeat(20)}`,
    kernel: body.binding.kernel, pool: `0x${'56'.repeat(20)}` };
  const hash = addressMembershipSigningHash(domain, body.memberConsent.consent);
  expect(verifyMessage(getBytes(hash), body.memberConsent.ownerSignature)).toBe(testWallet.address);
  expect(verifyMessage(hash, body.memberConsent.ownerSignature)).not.toBe(testWallet.address);
});
it('external member bindings require the explicit byte signer and never borrow the local wallet', async () => {
  member = true;
  const sign = vi.fn(async () => '0xexternal');
  await expect(bindRecourseOwnership(config, { ...input, external: { address, sign } })).rejects.toThrow('external_membership_signer_required');
  expect(h.fetch).toHaveBeenCalledTimes(1);
  const signBytes = vi.fn((bytes: Uint8Array) => testWallet.signMessage(bytes));
  await bindRecourseOwnership(config, { ...input, external: { address, sign, signBytes } });
  expect(signBytes).toHaveBeenCalledOnce(); expect(signBytes.mock.calls[0][0]).toHaveLength(32);
  expect(h.sign).not.toHaveBeenCalled();
});
