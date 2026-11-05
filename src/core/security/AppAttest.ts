/**
 * App Attest — the iPhone's SECURE ENCLAVE as a hardware-rooted witness (Trust Layer §2.9).
 *
 * Attest ONCE: generate a Secure-Enclave key, ask Apple to attest it over the canonical
 * registration binding, and register the attestation with the relay (`POST /v1/wallet/app-attest/
 * register`, which verifies it against the pinned Apple App Attestation Root CA). Assert PER PE:
 * every mobile submit carries `hardware_witness = { scheme: 'apple_app_attest', key_id, assertion }`
 * where the assertion signs sha256(authenticatorData || bindingNonce) — the nonce being the
 * canonical body minus the slot. The relay admits the PE as hardware_rooted (4.0×) or, when
 * anything fails to verify, records the attempt and keeps device_tier.
 *
 * Fail-open for the SUBMISSION, fail-closed for the WITNESS: nothing here ever blocks a PE; when
 * App Attest is unavailable (simulator, Android, Expo Go, no native module) no slot is attached.
 * This module never sees the key — only Apple-formatted attestation / assertion bytes.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';
import * as SecureStore from 'expo-secure-store';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
import type { ProvianAppAttestModule } from '../../../modules/provian-app-attest';
import { bytesToBase64, canonicalJson, hardwareBindingNonceBase64, HARDWARE_WITNESS_FIELD } from './hardwareBinding';

const KEY_ID_STORE = 'provian_app_attest_key_id_v1';
const REGISTERED_STORE = 'provian_app_attest_registered_v1';
/** the relay account the registered key is bound to (absent on a pre- registration). */
const REGISTERED_USER_STORE = 'provian_app_attest_registered_user_v1';
export const APP_ATTEST_REGISTER_PURPOSE = 'provian_app_attest_register';

export interface AppAttestWitness {
    scheme: 'apple_app_attest';
    nonce_binding: 'body_sha256';
    key_id: string;
    assertion: string;
}

export interface AppAttestRelay {
    registerAppAttestKey(params: { key_id: string; attestation: string }): Promise<{ registered: boolean } | null>;
    /** The relay account this phone is signed in as — the registration binding names it. */
    getUserId(): Promise<string | null>;
}

function nativeModule(): ProvianAppAttestModule | null {
    try {
        const mod = requireOptionalNativeModule<ProvianAppAttestModule>('ProvianAppAttest');
        return mod && typeof mod.isSupported === 'function' && mod.isSupported() ? mod : null;
    } catch {
        return null;
    }
}

/**
 * sha256(canonicalJson({ purpose, key_id, user_id })) — the relay recomputes the same registration
 * binding. the binding names the ACCOUNT, so an attestation made for one account cannot
 * register the key under another (and the relay binds each key to one account globally).
 */
export function registrationClientDataHashBase64(keyId: string, userId: string): string {
    return bytesToBase64(sha256(utf8ToBytes(canonicalJson({ purpose: APP_ATTEST_REGISTER_PURPOSE, key_id: keyId, user_id: userId }))));
}

class AppAttestService {
    private registeredKeyId: string | null = null;
    private registeredForUser: string | null = null;
    private ensuring: Promise<string | null> | null = null;

    /**
     * Attest once + register; returns the registered key id or null. Never throws.
     *
     * ROBUSTNESS : Apple's `attestKey` is ONE-SHOT per key — attesting a key that was
     * already attested throws `DCError.invalidKey` forever. The prior implementation reused a
     * stored key id (`storedKey ?? generateKey()`) on the not-confirmed-registered branch and
     * re-attested it, so once `REGISTERED_STORE` desynced from `KEY_ID_STORE` (a dropped/partial
     * SecureStore write, an interrupted first run) EVERY later submit silently produced no witness
     * the whole phone was stuck at device_tier with no signal. That is the exact failure that
     * sealed the policy setter approvals at device_tier while his registered key sat on the relay at counter 3.
     *
     * The fix: the happy path (stored key confirmed registered) is unchanged, but the fallback
     * NEVER re-attests a stored key — it mints a FRESH key and registers that, abandoning the old
     * un-usable one (Apple allows many keys per app; the relay records each with its own counter).
     * `witnessFor` additionally self-heals a stored-but-unusable key on an assertion failure.
     *
     * ONE KEY, ONE ACCOUNT : the relay binds each attested key to the account that first
     * registered it and refuses it for any other. The registration binding names the account, and
     * the confirmed-registered key is remembered WITH its account; when this phone is now signed in
     * as a different account, the stored key cannot serve it, so a FRESH key is minted and registered
     * for the new account — still never re-attesting the stored one. A pre- registration (no
     * stored account) keeps being used unchanged.
     */
    async ensureRegistered(relay: AppAttestRelay): Promise<string | null> {
        const userId = await relay.getUserId().catch(() => null);
        if (!userId) return null;
        if (this.registeredKeyId && this.registeredForUser === userId) return this.registeredKeyId;
        if (this.ensuring) return this.ensuring;
        this.ensuring = (async () => {
            try {
                const mod = nativeModule();
                if (!mod) return null;
                const storedKey = await SecureStore.getItemAsync(KEY_ID_STORE);
                const storedRegistered = await SecureStore.getItemAsync(REGISTERED_STORE);
                const storedUser = await SecureStore.getItemAsync(REGISTERED_USER_STORE);
                if (storedKey && storedRegistered === storedKey && (storedUser === null || storedUser === userId)) {
                    this.registeredKeyId = storedKey;
                    this.registeredForUser = userId;
                    return storedKey;
                }
                // Not confirmed-registered (or registered to ANOTHER account) → mint a FRESH key.
                // Never re-attest `storedKey`: a key that was ever attested cannot be attested again,
                // so reusing it here would throw and strand the phone at device_tier permanently.
                const keyId = await mod.generateKey();
                if (!keyId) return null;
                const attestation = await mod.attestKey(keyId, registrationClientDataHashBase64(keyId, userId));
                const res = await relay.registerAppAttestKey({ key_id: keyId, attestation });
                if (!res?.registered) return null;
                // Registered flag written LAST, key id + account first: if a later write is lost we
                // retry a fresh key next time (never re-attest), which is exactly the trap this avoids.
                await SecureStore.setItemAsync(KEY_ID_STORE, keyId, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
                await SecureStore.setItemAsync(REGISTERED_USER_STORE, userId, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
                await SecureStore.setItemAsync(REGISTERED_STORE, keyId, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
                this.registeredKeyId = keyId;
                this.registeredForUser = userId;
                return keyId;
            } catch (err) {
                console.log('[AppAttest] registration unavailable:', err instanceof Error ? err.message : String(err));
                return null;
            } finally {
                this.ensuring = null;
            }
        })();
        return this.ensuring;
    }

    /** Forget the current key so the next `ensureRegistered` mints and registers a fresh one. */
    async reset(): Promise<void> {
        this.registeredKeyId = null;
        this.registeredForUser = null;
        this.ensuring = null;
        try {
            await SecureStore.deleteItemAsync(REGISTERED_STORE);
            await SecureStore.deleteItemAsync(REGISTERED_USER_STORE);
            await SecureStore.deleteItemAsync(KEY_ID_STORE);
        } catch {
            // best-effort — a failed delete just means the desynced stored key lingers; the
            // fresh-key mint on the next ensureRegistered still bypasses it.
        }
    }

    /** The per-PE witness for THIS exact body (minus the slot), or null. Never throws. */
    async witnessFor(body: Record<string, unknown>, relay: AppAttestRelay): Promise<AppAttestWitness | null> {
        return this.witnessForNonce(hardwareBindingNonceBase64(body), relay);
    }

    /**
     * The witness for a PE v2 act (PE meter): the assertion's clientDataHash is the act's binding
     * nonce `hardwareNonceOfAct(actRecordOf(pe without its witness slot))` — exactly the bytes the
     * relay's admission checks for a metered act.
     */
    async witnessForActNonceHex(nonceHex: string, relay: AppAttestRelay): Promise<AppAttestWitness | null> {
        if (!/^[0-9a-f]{64}$/.test(nonceHex)) return null;
        const bytes = new Uint8Array(32);
        for (let i = 0; i < 32; i++) bytes[i] = parseInt(nonceHex.slice(i * 2, i * 2 + 2), 16);
        return this.witnessForNonce(bytesToBase64(bytes), relay);
    }

    private async witnessForNonce(nonce: string, relay: AppAttestRelay): Promise<AppAttestWitness | null> {
        const mod = nativeModule();
        if (!mod) return null;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const keyId = await this.ensureRegistered(relay);
                if (!keyId) return null;
                const assertion = await mod.generateAssertion(keyId, nonce);
                if (assertion) {
                    return { scheme: 'apple_app_attest', nonce_binding: 'body_sha256', key_id: keyId, assertion };
                }
                // Empty assertion from a registered key → the key is unusable. Self-heal once.
            } catch (err) {
                console.log('[AppAttest] assertion unavailable:', err instanceof Error ? err.message : String(err));
            }
            // Self-heal: the stored key can no longer produce an assertion (invalidated, or a
            // desynced registration state). Forget it and re-register a fresh key ONCE, then retry.
            if (attempt === 0) await this.reset();
        }
        return null;
    }

    /** Attach the witness to a submit body (returns the same body when no witness is available). */
    async attach<T extends Record<string, unknown>>(body: T, relay: AppAttestRelay): Promise<T | (T & { hardware_witness: AppAttestWitness })> {
        const { [HARDWARE_WITNESS_FIELD]: _omitted, ...rest } = body;
        const witness = await this.witnessFor(rest, relay);
        return witness ? { ...(rest as T), hardware_witness: witness } : (rest as T);
    }
}

export default new AppAttestService();
