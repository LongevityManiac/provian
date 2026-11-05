vi.mock('../../security/requireBiometric', () => ({ requireBiometric: vi.fn(async () => { h.prompts++; return true; }) }));
/**
 * The person's message key is published at launch / unlock when the relay has none (coordinator
 * requirement 1, 2026-10-03: the operator’s wallet had no `commons_message_keys/{walletDocId}` doc, so
 * nothing could be sealed to him). The key is the thread key — HKDF over the mnemonic — and
 * the SAME key opens the mailbox. A prompt is never shown at launch; at most one, right after unlock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve } from 'node:path';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const h = vi.hoisted(() => ({
    kv: new Map<string, string>(),
    session: { valid: false },
    prompts: 0,
    remote: null as null | { pubkey_b64u: string; key_version: number },
    published: [] as string[],
    readError: null as Error | null,
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (k: string) => h.kv.get(k) ?? null,
        setItem: async (k: string, v: string) => { h.kv.set(k, v); },
        removeItem: async (k: string) => { h.kv.delete(k); },
    },
}));
vi.mock('../../wallet/SeedManager', () => ({
    default: {
        getMnemonic: async (action: unknown) => { if (!(await import('../../security/biometricAction')).isBiometricActionValid(action as never)) throw new Error('no action'); return MNEMONIC; },
    },
}));
vi.mock('../../../services/RelayAPIService', () => ({
    default: {
        isRegistered: async () => true,
        getRelayWalletId: async () => 'wallet_327eec36',
    },
}));
vi.mock('../../commons/CommonsService', () => ({
    readMessageKey: async (partyId: string) => {
        if (partyId !== 'wallet_327eec36') throw new Error('wrong party id');
        if (h.readError) throw h.readError;
        return h.remote;
    },
    publishMessageKey: async (pubkey: string) => { h.published.push(pubkey); return { key: { party_id: 'wallet_327eec36', pubkey_b64u: pubkey, key_version: 1 } }; },
}));

async function fresh() {
    vi.resetModules();
    const runtime = await import('../phoneMeterRuntime');
    const thread = await import('../../commons/threadCrypto');
    thread.clearMessageKeyCache();
    const { withBiometricAction } = await import('../../security/biometricAction');
    return { runtime, thread, withBiometricAction };
}

beforeEach(() => {
    h.kv.clear();
    h.session.valid = false;
    h.prompts = 0;
    h.remote = null;
    h.published.length = 0;
    h.readError = null;
});

describe('ensureMessageKeyAtLaunch', () => {
    it('relay already holds a key → nothing derived, nothing published, no prompt', async () => {
        const { runtime } = await fresh();
        h.remote = { pubkey_b64u: 'existing', key_version: 1 };
        expect(await runtime.ensureMessageKeyAtLaunch({ allowPrompt: true })).toBe(true);
        expect(h.published).toEqual([]);
        expect(h.prompts).toBe(0);
    });

  it('missing + a live biometric session → derives the key silently and publishes it', async () => {
    const { runtime, thread, withBiometricAction } = await fresh();
    h.session.valid = true;
    expect(await withBiometricAction('unlock', action => runtime.ensureMessageKeyAtLaunch({ allowPrompt: false, biometricAction: action }))).toBe(true);
    expect(h.prompts).toBe(1);
    const pair = await thread.getMessageKeyPair('t');
    expect(h.published).toEqual([pair.pubkeyB64u]);
    // Idempotent: the next launch publishes nothing more.
    expect(await runtime.ensureMessageKeyAtLaunch({ allowPrompt: false })).toBe(true);
    expect(h.published).toHaveLength(1);
  });

    it('RED: missing, no session, launch (allowPrompt false) → no prompt, nothing published', async () => {
        const { runtime } = await fresh();
        expect(await runtime.ensureMessageKeyAtLaunch({ allowPrompt: false })).toBe(false);
        expect(h.prompts).toBe(0);
        expect(h.published).toEqual([]);
    });

    it('RED: allowPrompt alone never authenticates a scheduled key publication', async () => {
        const { runtime, withBiometricAction } = await fresh();
        expect(await runtime.ensureMessageKeyAtLaunch({ allowPrompt: true })).toBe(false);
        expect(h.prompts).toBe(0);
        expect(h.published).toEqual([]);
        // The current unlock's explicit capability also works as the positional argument.
        expect(await withBiometricAction('unlock', action => runtime.ensureMessageKeyAtLaunch({ allowPrompt: true }, action))).toBe(true);
        expect(h.prompts).toBe(1);
        expect(h.published).toHaveLength(1);
        h.kv.clear();
        const { clearMessageKeyCache } = await import('../../commons/threadCrypto');
        clearMessageKeyCache();
        expect(await runtime.ensureMessageKeyAtLaunch({ allowPrompt: true })).toBe(false);
        expect(h.prompts).toBe(1);
    });

    it('RED: a relay read error never publishes over a key that may exist', async () => {
        const { runtime } = await fresh();
        h.session.valid = true;
        h.readError = new Error('503');
        expect(await runtime.ensureMessageKeyAtLaunch({ allowPrompt: true })).toBe(false);
        expect(h.published).toEqual([]);
    });

  it('the published key is the one whose secret opens the mailbox: a box the relay seals to it opens', async () => {
    const { runtime, thread, withBiometricAction } = await fresh();
    h.session.valid = true;
    await withBiometricAction('unlock', action => runtime.ensureMessageKeyAtLaunch({ allowPrompt: false, biometricAction: action }));
    const backend = (await import(resolve(__dirname, '../../../../provian-backend/src/core/meter/sealed-box.ts'))) as {
      sealToKey(p: Uint8Array, t: Uint8Array): Uint8Array; toB64u(b: Uint8Array): string; fromB64u(s: string): Uint8Array;
    };
    const box = backend.toB64u(backend.sealToKey(new Uint8Array(backend.fromB64u(h.published[0])), new TextEncoder().encode('to the human')));
    const pair = await thread.getMessageKeyPair('t');
    expect(thread.openThreadMessage(pair.secretKey, box)).toBe('to the human');
  });
});
