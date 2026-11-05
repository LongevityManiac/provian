/**
 * The phone signs outputs with its DEVICE key (P-256 PE attestation key), registers it once under
 * wallet auth, and carries citations of signed outputs it received on its next PE. Pinned to the
 * relay's vectors (`docs/audit/output-signature-vectors.json`); each claim carries a RED control.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { p256 } from '@noble/curves/p256';
import {
    __resetOutputCitationQueueForTests,
    createAppOutputSigner,
    OUTPUT_KEY_RETRY_BACKOFF_MS,
    enqueueReceivedOutput,
    pendingOutputCitationCount,
    withQueuedOutputCitations,
    type AppOutputSignerDeps,
} from '../outputSigning';
import { normalizeInputOrigins } from '../../provenance/inputOrigins';

const V = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../docs/audit/output-signature-vectors.json'), 'utf8'));
const APP_CASE = V.cases.find((c: { signer_kind: string }) => c.signer_kind === 'app');
const WALLET_CASE = V.cases[0];
const APP_SCALAR = V.app_test_scalar.toString(16).padStart(64, '0');

function hardwareDeps(over: Partial<AppOutputSignerDeps> = {}): AppOutputSignerDeps & { registered: Set<string>; register: ReturnType<typeof vi.fn> } {
    const registered = new Set<string>();
    const register = vi.fn(async () => ({ registered: true }));
    return {
        registered,
        getPublicKey: async () => V.app_public_key,
        // The Secure Enclave signs the digest as given; deterministic noble P-256 stands in for it.
        signDigest: async (digest0x: string) => {
            const sig = p256.sign(digest0x.slice(2), APP_SCALAR, { lowS: true });
            return { signature: `0x${Buffer.from(sig.toCompactRawBytes()).toString('hex')}`, v: null };
        },
        getUserId: async () => V.registration.app.owner_id,
        register,
        isRegistered: async (k: string, u: string) => registered.has(`${k}:${u}`),
        markRegistered: async (k: string, u: string) => { registered.add(`${k}:${u}`); },
        ...over,
    } as AppOutputSignerDeps & { registered: Set<string>; register: ReturnType<typeof vi.fn> };
}

describe('phone output signer', () => {
    it('registers the device key once with the pinned proof, then signs the pinned app vector', async () => {
        expect(APP_CASE).toBeDefined();
        const deps = hardwareDeps();
        const signer = createAppOutputSigner(deps);
        const s = await signer.signOutput(APP_CASE.input.value);
        expect(s).toEqual(APP_CASE.signature);
        expect(deps.register).toHaveBeenCalledTimes(1);
        expect(deps.register).toHaveBeenCalledWith({ public_key: V.app_public_key, proof: V.registration.app.sig });
        await signer.signOutput('again');
        expect(deps.register).toHaveBeenCalledTimes(1); // registered once
        expect(await signer.ensureRegistered()).toBe(V.app_key_id);
    });

    it('registration is shared by concurrent triggers, and repeats for a DIFFERENT wallet on the same phone', async () => {
        let user = V.registration.app.owner_id as string;
        const deps = hardwareDeps({ getUserId: async () => user });
        const signer = createAppOutputSigner(deps);
        await Promise.all([signer.ensureRegistered(), signer.ensureRegistered(), signer.signOutput('a')]);
        expect(deps.register).toHaveBeenCalledTimes(1);
        user = 'user_other_wallet';
        await signer.ensureRegistered();
        expect(deps.register).toHaveBeenCalledTimes(2); // the marker is per wallet user
    });

    it('RED — after a refusal, triggers back off (no hammering) until the backoff passes', async () => {
        let t = 0;
        const register = vi.fn(async () => null);
        const signer = createAppOutputSigner(hardwareDeps({ register, now: () => t }));
        await expect(signer.ensureRegistered()).rejects.toThrow('output_signing_key_refused');
        await expect(signer.ensureRegistered()).rejects.toThrow('output_signing_key_backoff');
        await expect(signer.signOutput('x')).rejects.toThrow('output_signing_key_backoff');
        expect(register).toHaveBeenCalledTimes(1);
        t = OUTPUT_KEY_RETRY_BACKOFF_MS + 1;
        await expect(signer.ensureRegistered()).rejects.toThrow('output_signing_key_refused');
        expect(register).toHaveBeenCalledTimes(2);
    });

    it('RED — the software (secp256k1) fallback never signs an output', async () => {
        const signer = createAppOutputSigner(hardwareDeps({ signDigest: async () => ({ signature: `0x${'ab'.repeat(65)}`, v: 27 }) }));
        await expect(signer.signOutput('x')).rejects.toThrow('output_signing_requires_the_hardware_device_key');
    });

    it('RED — no device key, no wallet, or a refused registration signs nothing', async () => {
        await expect(createAppOutputSigner(hardwareDeps({ getPublicKey: async () => null })).signOutput('x')).rejects.toThrow('output_signing_no_device_key');
        await expect(createAppOutputSigner(hardwareDeps({ getUserId: async () => null })).signOutput('x')).rejects.toThrow('output_signing_no_wallet');
        await expect(createAppOutputSigner(hardwareDeps({ register: vi.fn(async () => null) })).signOutput('x')).rejects.toThrow('output_signing_key_refused');
    });
});

describe('received signed outputs ride the next PE', () => {
    beforeEach(() => __resetOutputCitationQueueForTests());
    const WITNESS = { type: 'observer_device', identity: 'phone_device_1', attestation_tier: 'hardware' };

    it('a matching signature is queued and appended once, witnessed by this device; the normalizer keeps it', () => {
        expect(enqueueReceivedOutput(WALLET_CASE.signature, WALLET_CASE.input.value)).toBe(true);
        expect(enqueueReceivedOutput(WALLET_CASE.signature, WALLET_CASE.input.value)).toBe(true); // dedup
        expect(pendingOutputCitationCount()).toBe(1);
        const existing = [{ hash: `sha256:${'a'.repeat(64)}`, origin_identifier: 'provider:anthropic', witnessed: false }];
        const out = normalizeInputOrigins(withQueuedOutputCitations(existing, WITNESS));
        expect(out).toHaveLength(2);
        expect(out![1]).toEqual({
            hash: WALLET_CASE.hash,
            origin_identifier: `out:wallet:${V.wallet_signer}`,
            witnessed: true,
            witness: WITNESS,
            signature: WALLET_CASE.signature,
        });
        expect(pendingOutputCitationCount()).toBe(0);
    });

    it('RED — the same output shown again is not cited again (once per run)', () => {
        expect(enqueueReceivedOutput(WALLET_CASE.signature, WALLET_CASE.input.value)).toBe(true);
        withQueuedOutputCitations([], WITNESS);
        expect(enqueueReceivedOutput(WALLET_CASE.signature, WALLET_CASE.input.value)).toBe(true);
        expect(pendingOutputCitationCount()).toBe(0);
    });

    it('an empty queue leaves the origins untouched (envelopes hash as before)', () => {
        const input = [{ hash: `sha256:${'a'.repeat(64)}`, origin_identifier: 'provider:x', witnessed: false }];
        expect(withQueuedOutputCitations(input, WITNESS)).toBe(input);
        expect(withQueuedOutputCitations(undefined, WITNESS)).toBeUndefined();
    });

    it('RED — a signature over other bytes is never queued; no device witness means nothing is drained', () => {
        expect(enqueueReceivedOutput(WALLET_CASE.signature, `${WALLET_CASE.input.value}tampered`)).toBe(false);
        expect(enqueueReceivedOutput({ ...WALLET_CASE.signature, scheme: 'p256_sha256' }, WALLET_CASE.input.value)).toBe(false);
        expect(pendingOutputCitationCount()).toBe(0);
        enqueueReceivedOutput(WALLET_CASE.signature, WALLET_CASE.input.value);
        expect(withQueuedOutputCitations([], null)).toEqual([]);
        expect(pendingOutputCitationCount()).toBe(1);
    });
});
