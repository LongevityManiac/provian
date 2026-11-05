/**
 * Signed outputs on the phone.
 *
 * The phone signs what it hands out with its DEVICE key — the P-256 PE attestation key
 * (`provian_pe_attestation`, Secure Enclave / StrongBox, KeyManager) — NEVER the wallet key. That key
 * is registered once with the relay under the person's wallet auth (`POST /v1/wallet/output-signing-key`,
 * proof of possession over `provian-output-key:v1:app:<user_id>:<public key>`), and the relay maps
 * its key id (`aok_…`) to the person, so a citation of a phone-signed output counts toward that
 * person's consumption once someone else's WITNESSED act cites it.
 *
 * When the phone RECEIVES a signed output, `enqueueReceivedOutput` queues the citation (only after
 * checking the signature names the exact bytes received), and the next PE the phone records carries
 * it as an `out:` origin witnessed by this device (`withQueuedOutputCitations`, called by
 * ProvenanceEnvelopeManager). There is no "declare a citation" call: a citation is captured, never
 * declared.
 *
 * Pure module: the KeyManager / relay bindings are injected (`outputSigningRuntime.ts`), so this file
 * is testable without native modules.
 */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import {
    appOutputKeyId,
    canonicalOutputHash,
    canonicalP256PublicKey,
    normalizeOutputSignature,
    outputCitationOrigin,
    outputHashOfBytes,
    outputHashOfText,
    outputKeyRegistrationMessage,
    outputSignatureDigestHex,
    type OutputSignature,
} from './output-signature';
import type { InputOrigin, OriginWitness } from '../provenance/inputOrigins';

export type OutputBytes = string | Uint8Array;

/** The bindings the phone signer needs (KeyManager + RelayAPIService + local marker storage). */
export interface AppOutputSignerDeps {
    /** The PE attestation key's public key (SEC1 uncompressed hex), or null when there is none. */
    getPublicKey(): Promise<string | null>;
    /** Sign a 0x-prefixed 32-byte digest with the PE attestation key; `v` is null for P-256 hardware. */
    signDigest(digest0x: string): Promise<{ signature: string; v: number | null }>;
    getUserId(): Promise<string | null>;
    /** POST /v1/wallet/output-signing-key; null on refusal or network failure. */
    register(body: { public_key: string; proof: string }): Promise<{ registered: boolean } | null>;
    /** The registered marker is per key AND per wallet user: a phone that changes wallets registers again. */
    isRegistered(keyId: string, userId: string): Promise<boolean>;
    markRegistered(keyId: string, userId: string): Promise<void>;
    /** Clock for the retry backoff (defaults to Date.now). */
    now?(): number;
}

/** After a failed registration, another attempt waits this long (no hammering from meter ticks or writes). */
export const OUTPUT_KEY_RETRY_BACKOFF_MS = 10 * 60 * 1000;

export function outputHashOf(output: OutputBytes): string {
    return typeof output === 'string' ? outputHashOfText(output) : outputHashOfBytes(output);
}

/** A P-256 r‖s from the device key, or a refusal (the software fallback is secp256k1 and never signs outputs). */
async function p256Sign(deps: AppOutputSignerDeps, digestHex: string): Promise<string> {
    const r = await deps.signDigest(`0x${digestHex}`);
    const sig = r.signature.toLowerCase().replace(/^0x/, '');
    if (r.v !== null || !/^[0-9a-f]{128}$/.test(sig)) {
        throw new Error('output_signing_requires_the_hardware_device_key');
    }
    return sig;
}

export interface AppOutputSigner {
    /** Register the device key once (idempotent); answers the signer id (`aok_…`). */
    ensureRegistered(): Promise<string>;
    /** Sign an output the person hands out (registers first when needed). */
    signOutput(output: OutputBytes): Promise<OutputSignature>;
}

export function createAppOutputSigner(deps: AppOutputSignerDeps): AppOutputSigner {
    const publicKey = async (): Promise<string> => {
        const pub = canonicalP256PublicKey(await deps.getPublicKey());
        if (pub === null) throw new Error('output_signing_no_device_key');
        return pub;
    };
    const now = (): number => (deps.now ? deps.now() : Date.now());
    let inFlight: Promise<string> | null = null;
    let failedAtMs: number | null = null;
    const registerOnce = async (): Promise<string> => {
        const userId = await deps.getUserId();
        if (!userId) throw new Error('output_signing_no_wallet');
        const pub = await publicKey();
        const keyId = appOutputKeyId(pub);
        if (await deps.isRegistered(keyId, userId)) return keyId;
        if (failedAtMs !== null && now() - failedAtMs < OUTPUT_KEY_RETRY_BACKOFF_MS) throw new Error('output_signing_key_backoff');
        try {
            const message = outputKeyRegistrationMessage('app', userId, pub);
            const proof = await p256Sign(deps, bytesToHex(sha256(utf8ToBytes(message))));
            const result = await deps.register({ public_key: pub, proof });
            if (result === null || result.registered !== true) throw new Error('output_signing_key_refused');
        } catch (err) {
            failedAtMs = now();
            throw err;
        }
        failedAtMs = null;
        await deps.markRegistered(keyId, userId);
        return keyId;
    };
    // Idempotent and shared: concurrent triggers (setup, restore, unlock, ticks, a write) run once.
    const ensureRegistered = (): Promise<string> => {
        if (inFlight) return inFlight;
        const run = registerOnce().finally(() => { inFlight = null; });
        inFlight = run;
        return run;
    };
    return {
        ensureRegistered,
        async signOutput(output: OutputBytes): Promise<OutputSignature> {
            const keyId = await ensureRegistered();
            const hash = outputHashOf(output);
            const sig = await p256Sign(deps, outputSignatureDigestHex(hash));
            const out = normalizeOutputSignature({ hash, signer: { kind: 'app', id: keyId }, scheme: 'p256_sha256', sig });
            if (out === null) throw new Error('output_signature_did_not_normalize');
            return out;
        },
    };
}

// ─── received outputs → the next PE's citations ─────────────────────────────────

/** At most this many citations ride one PE; a longer queue keeps its newest entries. */
export const MAX_CITATIONS_PER_PE = 16;
const MAX_PENDING = 256;
let pending: OutputSignature[] = [];
const MAX_CITED_REMEMBERED = 4096;
const cited = new Set<string>();

/**
 * Queue a signed output this phone RECEIVED. Refused (false) unless the signature is well-formed
 * and names the hash of exactly `received`.
 */
export function enqueueReceivedOutput(signature: unknown, received: OutputBytes): boolean {
    const s = normalizeOutputSignature(signature);
    if (s === null || canonicalOutputHash(s.hash) !== outputHashOf(received)) return false;
    const key = `${s.signer.kind}:${s.signer.id}|${s.hash}`;
    // One output is cited once: re-opening the same post or deliverable never cites it again
    // (per app run; the relay's per-pair count is what makes repeats harmless to independence).
    if (cited.has(key)) return true;
    cited.add(key);
    if (cited.size > MAX_CITED_REMEMBERED) cited.delete(cited.values().next().value as string);
    pending = [...pending, s].slice(-MAX_PENDING);
    return true;
}

/** How many citations are waiting (diagnostics, tests). */
export function pendingOutputCitationCount(): number {
    return pending.length;
}

/**
 * The PE's input origins with the queued citations appended, witnessed by this device. With an
 * empty queue (or no device witness) the input is returned UNCHANGED, so every other envelope
 * hashes exactly as before.
 */
export function withQueuedOutputCitations(inputOrigins: unknown, witness: OriginWitness | null): unknown {
    if (pending.length === 0 || witness === null || !witness.identity) return inputOrigins;
    const taken = pending.slice(0, MAX_CITATIONS_PER_PE);
    pending = pending.slice(MAX_CITATIONS_PER_PE);
    const citations: InputOrigin[] = taken.map((s) => outputCitationOrigin(s, witness) as InputOrigin);
    const existing = Array.isArray(inputOrigins) ? inputOrigins : [];
    return [...existing, ...citations];
}

/** Test seam: empty the queue. */
export function __resetOutputCitationQueueForTests(): void {
    pending = [];
    cited.clear();
}
