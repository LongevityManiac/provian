import { hmac } from '@noble/hashes/hmac';
/**
 * originCapture (mobile app) — Prompt 2 builders that turn what the app observed
 * into `input_origins` entries, honouring the privacy rule. Mirror of the SDK
 * (`provian-agent-sdk/src/observer/origin-capture.ts`) and backend
 * (`provian-backend/src/core/provenance/origin-capture.ts`) copies; the
 * private-origin type tags + witness-type literals are kept byte-identical across
 * the packages by `origin-capture-parity.test.ts`.
 *
 * THE PRIVACY RULE: publicly-resolvable identifiers (provider, domain, DOI,
 * package coordinate, on-chain address) are recorded RESOLVABLY; private values
 * (URL paths) are recorded as an owner-secret MAC with a non-sensitive type tag as the
 * origin_identifier. No private plaintext reaches origin_identifier.
 *
 * Uses the SYNC `@noble/hashes` sha256 (the same primitive `sessionFingerprint.ts`
 * uses) so origins can be built inside the synchronous metadata path without an
 * await. PURE PROVENANCE, ZERO mint effect.
 */
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import type { InputOrigin, OriginWitness } from './inputOrigins';

/** Witness type literals (Prompt 2) — identical to the SDK/backend copies. */
export const WITNESS_OBSERVER_DEVICE = 'observer_device';
export const WITNESS_FORGE_WEBHOOK = 'forge_webhook';
export const WITNESS_CHAIN_WATCHER = 'chain_watcher';
export const WITNESS_ORIGIN_OWNER_SIGNATURE = 'origin_owner_signature';

/** Private-origin type tags. */
export const PRIVATE_FILE = 'private_file';
export const PRIVATE_URL_PATH = 'private_url_path';
export const PRIVATE_PKG = 'private_pkg';
export const PRIVATE_PROJECT = 'private_project';

function sha256Hex(value: string): string {
    return bytesToHex(sha256(utf8ToBytes(value)));
}

/** A publicly-resolvable origin: identifier in the clear; hash is its digest. */
export function resolvableOrigin(identifier: string, witness?: OriginWitness | null): InputOrigin {
    const base = { hash: `sha256:${sha256Hex(identifier)}`, origin_identifier: identifier };
    return witness ? { ...base, witnessed: true, witness } : { ...base, witnessed: false };
}

/** A private origin: a purpose-separated owner-secret MAC binds the value; origin_identifier is a type tag. */
export function privateOrigin(typeTag: string, rawValue: string, witness?: OriginWitness | null, privacySecret?: Uint8Array): InputOrigin {
    if (!privacySecret?.length) throw new Error('private identifier requires the owner-held secret');
    const mac=bytesToHex(hmac(sha256,privacySecret,utf8ToBytes('provian-private-identifier:v1\0'+typeTag+'\0'+rawValue)));
    const base = { hash: `sha256:${mac}`, origin_identifier: typeTag };
    return witness ? { ...base, witnessed: true, witness } : { ...base, witnessed: false };
}

/** Lower-cased host of an http(s) URL, or null. */
export function domainOf(rawUrl: string): string | null {
    try {
        const u = new URL(rawUrl);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        return u.hostname.toLowerCase() || null;
    } catch {
        return null;
    }
}

/** One URL → domain (resolvable) + path (owner-secret MAC over the full URL). */
export function urlOrigins(rawUrl: string, witness?: OriginWitness | null, privacySecret?: Uint8Array): InputOrigin[] {
    const out: InputOrigin[] = [];
    const host = domainOf(rawUrl);
    if (host) out.push(resolvableOrigin(`domain:${host}`, witness));
    let u:URL;
    try { u=new URL(rawUrl); } catch { return out; }
    if (u.pathname && u.pathname !== '/') out.push(privateOrigin(PRIVATE_URL_PATH,u.toString(),witness,privacySecret));
    return out;
}
