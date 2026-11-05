/**
 * AppAttest robustness. The bug this pins: Apple's `attestKey` is one-shot per key, so
 * re-attesting a stored key strands the phone at device_tier forever once `REGISTERED_STORE`
 * desyncs from `KEY_ID_STORE`. The service must mint a FRESH key on the not-confirmed branch and
 * self-heal an unusable stored key, so a fresh submit always attaches a verifiable witness.
 *
 * Every assertion here ships with its RED negative control : the trap test asserts the
 * stored key id is NEVER re-attested, which goes red the instant the code regresses to
 * `storedKey ?? generateKey()`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as SecureStore from 'expo-secure-store';

// A controllable fake of the native App Attest module.
let fake: {
    isSupported: () => boolean;
    generateKey: ReturnType<typeof vi.fn>;
    attestKey: ReturnType<typeof vi.fn>;
    generateAssertion: ReturnType<typeof vi.fn>;
} | null;

vi.mock('expo-modules-core', () => ({
    requireOptionalNativeModule: () => fake,
}));

// Import AFTER the mock is registered. The service is a singleton, so reset its in-memory state
// between tests by clearing SecureStore + re-importing fresh where needed.
import AppAttestSingleton, { AppAttestRelay, registrationClientDataHashBase64 } from './AppAttest';

const KEY_ID_STORE = 'provian_app_attest_key_id_v1';
const REGISTERED_STORE = 'provian_app_attest_registered_v1';
const REGISTERED_USER_STORE = 'provian_app_attest_registered_user_v1';

function makeFake(over: Partial<{ isSupported: boolean }> = {}) {
    let counter = 0;
    return {
        isSupported: () => over.isSupported ?? true,
        generateKey: vi.fn(async () => `freshKey${++counter}`),
        attestKey: vi.fn(async (_k: string, _h: string) => 'attestationB64'),
        generateAssertion: vi.fn(async (_k: string, _h: string) => 'assertionB64'),
    };
}

function makeRelay(registered = true, user: { id: string | null } = { id: 'user_A' }): AppAttestRelay & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        registerAppAttestKey: async ({ key_id }) => {
            calls.push(key_id);
            return { registered };
        },
        getUserId: async () => user.id,
    };
}

async function freshService() {
    vi.resetModules();
    return (await import('./AppAttest')).default;
}

beforeEach(() => {
    fake = makeFake();
    (SecureStore as unknown as { __resetSecureStoreMock: () => void }).__resetSecureStoreMock?.();
});

describe('AppAttest.witnessFor', () => {
    it('attaches a verifiable witness on a clean device (attest + register once, then assert)', async () => {
        const svc = await freshService();
        const relay = makeRelay();
        const w = await svc.witnessFor({ action_type: 'human_approval', foo: 'bar' }, relay);
        expect(w).not.toBeNull();
        expect(w?.scheme).toBe('apple_app_attest');
        expect(w?.key_id).toBe('freshKey1');
        expect(relay.calls).toEqual(['freshKey1']); // registered exactly once
        expect(fake?.attestKey).toHaveBeenCalledTimes(1);
    });

    it('reuses the confirmed-registered key across submits (happy path, no re-attest)', async () => {
        const svc = await freshService();
        const relay = makeRelay();
        await svc.witnessFor({ a: 1 }, relay);
        await svc.witnessFor({ a: 2 }, relay);
        // One registration, two assertions — the second submit does NOT attest or register again.
        expect(fake?.attestKey).toHaveBeenCalledTimes(1);
        expect(relay.calls).toEqual(['freshKey1']);
        expect(fake?.generateAssertion).toHaveBeenCalledTimes(2);
    });

    it('THE TRAP: a stored key with a desynced registration flag mints a FRESH key, never re-attests the stored one', async () => {
        // Simulate the desync that stranded the operator’s phone: KEY_ID_STORE set, REGISTERED_STORE missing.
        await SecureStore.setItemAsync(KEY_ID_STORE, 'oldStrandedKey');
        // attestKey throws for the already-attested stored key (Apple's one-shot rule) — but must NEVER be called with it.
        fake!.attestKey = vi.fn(async (keyId: string) => {
            if (keyId === 'oldStrandedKey') throw new Error('DCError.invalidKey: already attested');
            return 'attestationB64';
        });
        const svc = await freshService();
        const relay = makeRelay();
        const w = await svc.witnessFor({ x: 1 }, relay);
        // RED CONTROL: the fix works ONLY because the stored key is abandoned. If the code regresses
        // to `storedKey ?? generateKey()` the fresh-key mint disappears, attestKey('oldStrandedKey')
        // throws, and this expectation fails.
        expect(w).not.toBeNull();
        expect(w?.key_id).toBe('freshKey1');
        expect(fake?.attestKey).not.toHaveBeenCalledWith('oldStrandedKey', expect.anything());
        expect(fake?.generateKey).toHaveBeenCalled();
        // The fresh key is now persisted as confirmed-registered.
        expect(await SecureStore.getItemAsync(REGISTERED_STORE)).toBe('freshKey1');
    });

    it('self-heals when a confirmed-registered key can no longer assert (invalidated key)', async () => {
        const svc = await freshService();
        const relay = makeRelay();
        // First submit registers freshKey1 and asserts fine.
        await svc.witnessFor({ a: 1 }, relay);
        // Now the enclave key is invalidated: generateAssertion throws for freshKey1 but works for a new key.
        fake!.generateAssertion = vi.fn(async (keyId: string) => {
            if (keyId === 'freshKey1') throw new Error('DCError.invalidKey');
            return 'assertionB64';
        });
        const w = await svc.witnessFor({ a: 2 }, relay);
        // RED CONTROL: without the self-heal retry, witnessFor returns null here.
        expect(w).not.toBeNull();
        expect(w?.key_id).toBe('freshKey2'); // re-registered a fresh key and retried
        expect(relay.calls).toEqual(['freshKey1', 'freshKey2']);
    });

    it('degrades silently (no witness, no throw) when the native module is absent', async () => {
        fake = null; // simulator / Android / Expo Go
        const svc = await freshService();
        const relay = makeRelay();
        const w = await svc.witnessFor({ a: 1 }, relay);
        expect(w).toBeNull();
        expect(relay.calls).toEqual([]);
    });

    it('returns no witness when relay registration is refused (fail-closed for the witness)', async () => {
        const svc = await freshService();
        const relay = makeRelay(false); // registered:false
        const w = await svc.witnessFor({ a: 1 }, relay);
        expect(w).toBeNull();
    });
});

describe('AppAttest — one key, one account ', () => {
    it('the registration binding names the account — the SAME pinned vector the relay pins (hardware.test.ts)', () => {
        // sha256(canonicalJson({ key_id, purpose, user_id })) computed independently (openssl), base64.
        expect(registrationClientDataHashBase64('dGVzdC1rZXktaWQtMDAwMDAwMDA=', 'user_abc')).toBe('J+b5sGrLgGEJqLuELwZ8iuLziFeBEyNR3nMwo4F1P/M=');
        expect(registrationClientDataHashBase64('k', 'u1')).not.toBe(registrationClientDataHashBase64('k', 'u2'));
    });

    it('attests a fresh key over the ACCOUNT-bound binding and records the account with the key', async () => {
        const svc = await freshService();
        const relay = makeRelay(true, { id: 'user_A' });
        const w = await svc.witnessFor({ a: 1 }, relay);
        expect(w?.key_id).toBe('freshKey1');
        expect(fake?.attestKey).toHaveBeenCalledWith('freshKey1', registrationClientDataHashBase64('freshKey1', 'user_A'));
        expect(await SecureStore.getItemAsync(REGISTERED_USER_STORE)).toBe('user_A');
    });

    it('RED: a key registered to account A is NOT reused for account B — a FRESH key is minted and registered for B, and the stored key is never re-attested', async () => {
        const user = { id: 'user_A' as string | null };
        const svc = await freshService();
        const relay = makeRelay(true, user);
        await svc.witnessFor({ a: 1 }, relay);
        user.id = 'user_B'; // this phone now signs in as another account
        fake!.attestKey = vi.fn(async (keyId: string) => {
            if (keyId === 'freshKey1') throw new Error('DCError.invalidKey: already attested');
            return 'attestationB64';
        });
        const w = await svc.witnessFor({ a: 2 }, relay);
        // Without the account check the cached/stored freshKey1 (bound to A on the relay) is asserted for B → the relay refuses it.
        expect(w?.key_id).toBe('freshKey2');
        expect(relay.calls).toEqual(['freshKey1', 'freshKey2']);
        expect(fake?.attestKey).not.toHaveBeenCalledWith('freshKey1', expect.anything());
        expect(fake?.attestKey).toHaveBeenCalledWith('freshKey2', registrationClientDataHashBase64('freshKey2', 'user_B'));
        expect(await SecureStore.getItemAsync(REGISTERED_USER_STORE)).toBe('user_B');
    });

    it('a pre- registration (no stored account) keeps being used — no re-attest, no re-register', async () => {
        await SecureStore.setItemAsync(KEY_ID_STORE, 'legacyKey');
        await SecureStore.setItemAsync(REGISTERED_STORE, 'legacyKey');
        const svc = await freshService();
        const relay = makeRelay(true, { id: 'user_A' });
        const w = await svc.witnessFor({ a: 1 }, relay);
        expect(w?.key_id).toBe('legacyKey');
        expect(relay.calls).toEqual([]);
        expect(fake?.attestKey).not.toHaveBeenCalled();
    });

    it('no signed-in account → no registration, no witness (never attests over an account-less binding)', async () => {
        const svc = await freshService();
        const relay = makeRelay(true, { id: null });
        expect(await svc.witnessFor({ a: 1 }, relay)).toBeNull();
        expect(fake?.attestKey).not.toHaveBeenCalled();
    });
});
