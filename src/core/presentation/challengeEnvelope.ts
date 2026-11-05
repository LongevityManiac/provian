/**
 * SIGNED CHALLENGES (`provian-challenge-v1`,) — the presenter's check of WHO is asking, done on
 * the device BEFORE any burn.
 *
 * A requester hands the presenter a challenge envelope `{ v, audience, challenge, predicates?,
 * issuedAt, expiresAt, presenter?, requester, sig }`. With `requester` + `sig` it is SIGNED (Ed25519
 * over one canonical signing string):
 * - domain — `requester.id` is a DNS hostname; its key is published at
 * `https://<id>/.well-known/provian-requester.json`.
 * - wallet — `requester.id` is a Provian wallet id + `requester.address`; the RELAY signed it with
 * the Provian presentation key (`GET /v1/present/jwks`) after authenticating that wallet.
 * The audience of a signed challenge IS the requester id. An unsigned legacy `{ audience, challenge,
 * predicates? }` stays valid and is shown UNVERIFIED. A signed challenge that fails any check is
 * INVALID and refused — Unknown = Block; nothing is burned.
 *
 * Byte-for-byte mirror of the relay (`provian-backend/src/core/presentation/challenge.ts`) and the
 * SDK; the pinned vectors (`challengeEnvelope.test.ts`) are the same in every package. RN-safe:
 * @noble/curves (Ed25519) + @noble/hashes (sha256), no node crypto.
 */

import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import {
    canonicalReputationDirective,
    normalizePredicateRequests,
    requesterString,
    PRESENTATION_AUDIENCE_MAX_LEN,
    PRESENTATION_CHALLENGE_MAX_LEN,
    PRESENTATION_CHALLENGE_MIN_LEN,
    type PredicateRequest,
} from './humanPresentation';
import { challengeDisclosuresDigest, normalizeDisclosureRequests, type CanonicalDisclosureRequest } from './disclosureRequest';

export { requesterString };

export const CHALLENGE_SIGNING_TAG = 'provian-challenge-v1';
export const CHALLENGE_ENVELOPE_VERSION = 1 as const;
/** The requester key document path under the requester's domain. */
export const REQUESTER_WELL_KNOWN_PATH = '/.well-known/provian-requester.json';
/** Signed-challenge lifetime bounds (seconds). Seven days max: async thread / remote requests carry
 *  their delivery TTL. */
export const CHALLENGE_MIN_TTL_SECONDS = 60;
export const CHALLENGE_MAX_TTL_SECONDS = 604800;
/** Clock-skew tolerance on the challenge deadline (mirrors PRESENTATION_CLOCK_SKEW_SECONDS). */
export const CHALLENGE_CLOCK_SKEW_SECONDS = 60;
/** SSRF / abuse bounds on the requester key fetch. */
export const REQUESTER_KEY_DOC_MAX_BYTES = 64 * 1024;
export const REQUESTER_KEY_FETCH_TIMEOUT_MS = 5000;

const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const KID_RE = /^[A-Za-z0-9._-]{1,128}$/;
/** A Provian wallet id (agent wallet id / human wallet doc id): no separator characters. */
const WALLET_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export type RequesterType = 'domain' | 'wallet';

export interface RequesterIdentity {
    readonly type: RequesterType;
    readonly id: string;
    /** wallet only. */
    readonly address?: string;
}

export interface EnvelopeRequester {
    readonly type: RequesterType;
    /** domain: the hostname. wallet: the Provian wallet id. */
    readonly id: string;
    /** wallet only: the wallet's lowercase EVM address (Provian-attested). */
    readonly address?: string;
    /** The Ed25519 key id — the domain's well-known kid, or the Provian JWKS kid for a wallet. */
    readonly kid: string;
}

export interface ChallengeEnvelope {
    readonly v?: number;
    readonly audience: string;
    readonly challenge: string;
    readonly predicates?: readonly PredicateRequest[];
    /** Requester-named disclosure requests (2026-10-10). */
    readonly disclosures?: readonly CanonicalDisclosureRequest[];
    readonly issuedAt?: number;
    readonly expiresAt?: number;
    readonly presenter?: string;
    readonly requester?: EnvelopeRequester;
    readonly sig?: string;
}

/** One Ed25519 public key from a requester's well-known document or the Provian JWKS. */
export interface RequesterJwk {
    readonly kty: string;
    readonly crv?: string;
    readonly x?: string;
    readonly kid: string;
}

/** Fetch a domain requester's published keys. Throws when unreachable / malformed. */
export type FetchRequesterKeys = (domain: string) => Promise<readonly RequesterJwk[]>;

export type ChallengeInvalidReason =
    | 'malformed'
    | 'unsupported_version'
    | 'bad_requester'
    | 'audience_not_requester'
    | 'bad_window'
    | 'bad_presenter'
    | 'bad_signature'
    | 'key_not_found'
    | 'requester_key_unreachable';

export type ChallengeVerdict =
    | { readonly status: 'verified'; readonly requester: RequesterIdentity; readonly envelope: ChallengeEnvelope }
    | { readonly status: 'unverified'; readonly envelope: ChallengeEnvelope }
    | { readonly status: 'invalid'; readonly reason: ChallengeInvalidReason; readonly envelope?: ChallengeEnvelope }
    | { readonly status: 'expired'; readonly requester: RequesterIdentity; readonly envelope: ChallengeEnvelope }
    | { readonly status: 'not_addressed'; readonly requester: RequesterIdentity; readonly envelope: ChallengeEnvelope };

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** True when the envelope carries a requester signature (identity claim). */
export function isSignedChallenge(env: ChallengeEnvelope): boolean {
    return env.requester !== undefined || env.sig !== undefined;
}

/**
 * Parse an untrusted challenge envelope (object or JSON string — a scanned QR, pasted text, a thread
 * attachment). Structural only — no signature check. Returns null when it is not a well-formed
 * challenge (legacy or signed).
 */
export function parseChallengeEnvelope(raw: unknown): ChallengeEnvelope | null {
    let obj: unknown = raw;
    if (typeof raw === 'string') {
        try { obj = JSON.parse(raw.trim()); } catch { return null; }
    }
    if (!isRecord(obj)) return null;
    const audience = typeof obj.audience === 'string' ? obj.audience.trim() : '';
    const challenge = typeof obj.challenge === 'string' ? obj.challenge.trim() : '';
    if (audience.length === 0 || audience.length > PRESENTATION_AUDIENCE_MAX_LEN) return null;
    if (challenge.length < PRESENTATION_CHALLENGE_MIN_LEN || challenge.length > PRESENTATION_CHALLENGE_MAX_LEN) return null;
    const predicates = normalizePredicateRequests(obj.predicates);
    if (predicates === null) return null;
    const disclosures = normalizeDisclosureRequests(obj.disclosures);
    if (disclosures === null) return null;
    const env: Record<string, unknown> = { audience, challenge };
    if (predicates.length > 0) env.predicates = predicates;
    if (disclosures.length > 0) env.disclosures = disclosures;
    if (obj.v !== undefined) env.v = obj.v;
    if (obj.issuedAt !== undefined) env.issuedAt = obj.issuedAt;
    if (obj.expiresAt !== undefined) env.expiresAt = obj.expiresAt;
    if (obj.presenter !== undefined) env.presenter = obj.presenter;
    if (obj.requester !== undefined) env.requester = obj.requester;
    if (obj.sig !== undefined) env.sig = obj.sig;
    return env as unknown as ChallengeEnvelope;
}

/** sha256 hex of the canonical (sorted, normalized) predicate list — the signing-string commitment. */
export function challengePredicatesDigest(predicates: readonly PredicateRequest[] | undefined): string {
    const canonical = canonicalReputationDirective({ redact: [], predicates: [...(predicates ?? [])] }).predicates;
    return bytesToHex(sha256(utf8ToBytes(JSON.stringify(canonical))));
}

/** The exact bytes a requester signs. Fixed line order, `\n`-joined, no trailing newline. */
export function challengeSigningString(env: {
    audience: string;
    challenge: string;
    issuedAt: number;
    expiresAt: number;
    requester: { type: RequesterType; id: string; address?: string; kid: string };
    presenter?: string;
    predicates?: readonly PredicateRequest[];
    disclosures?: readonly CanonicalDisclosureRequest[];
}): string {
    const lines = [
        CHALLENGE_SIGNING_TAG,
        `aud=${env.audience}`,
        `chal=${env.challenge}`,
        `iat=${env.issuedAt}`,
        `exp=${env.expiresAt}`,
        `req=${requesterString(env.requester)}`,
        `kid=${env.requester.kid}`,
        `presenter=${(env.presenter ?? '').toLowerCase()}`,
        `predicates=${challengePredicatesDigest(env.predicates)}`,
    ];
    // The disclosure line exists ONLY when the challenge names disclosures (pre-existing bytes unchanged).
    if (env.disclosures !== undefined && env.disclosures.length > 0) lines.push(`disclosures=${challengeDisclosuresDigest(env.disclosures)}`);
    return lines.join('\n');
}

/** Structural rules for a SIGNED envelope (A.2), excluding the signature itself. */
export function checkSignedStructure(env: ChallengeEnvelope): ChallengeInvalidReason | null {
    if (env.v !== CHALLENGE_ENVELOPE_VERSION) return 'unsupported_version';
    const r: unknown = env.requester;
    if (!isRecord(r) || (r.type !== 'domain' && r.type !== 'wallet') || typeof r.id !== 'string') return 'bad_requester';
    if (typeof r.kid !== 'string' || !KID_RE.test(r.kid)) return 'bad_requester';
    if (r.type === 'domain') {
        if (!DOMAIN_RE.test(r.id)) return 'bad_requester';
        if (r.address !== undefined) return 'bad_requester';
    } else {
        if (!WALLET_ID_RE.test(r.id)) return 'bad_requester';
        if (typeof r.address !== 'string' || !ADDRESS_RE.test(r.address)) return 'bad_requester';
    }
    if (env.audience !== r.id) return 'audience_not_requester';
    if (!Number.isInteger(env.issuedAt) || !Number.isInteger(env.expiresAt)) return 'bad_window';
    const ttl = (env.expiresAt as number) - (env.issuedAt as number);
    if (ttl < CHALLENGE_MIN_TTL_SECONDS || ttl > CHALLENGE_MAX_TTL_SECONDS) return 'bad_window';
    if (env.presenter !== undefined && (typeof env.presenter !== 'string' || !ADDRESS_RE.test(env.presenter))) return 'bad_presenter';
    if (typeof env.sig !== 'string' || env.sig.length === 0) return 'bad_signature';
    return null;
}

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Decode unpadded base64url (RN-safe: no Buffer / atob). Null on any non-alphabet character. */
export function base64UrlToBytes(s: string): Uint8Array | null {
    if (!BASE64URL_RE.test(s) || s.length % 4 === 1) return null;
    const out: number[] = [];
    let buffer = 0;
    let bits = 0;
    for (const ch of s) {
        const v = B64URL_ALPHABET.indexOf(ch);
        if (v < 0) return null;
        buffer = (buffer << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push((buffer >> bits) & 0xff);
        }
    }
    return new Uint8Array(out);
}

function verifyEd25519(message: string, sigB64url: string, key: RequesterJwk): boolean {
    if (key.kty !== 'OKP' || key.crv !== 'Ed25519' || typeof key.x !== 'string') return false;
    const sig = base64UrlToBytes(sigB64url);
    const pub = base64UrlToBytes(key.x);
    if (!sig || sig.length !== 64 || !pub || pub.length !== 32) return false;
    try {
        // zip215:false = strict RFC 8032, the same acceptance set as the relay's node crypto.verify.
        return ed25519.verify(sig, utf8ToBytes(message), pub, { zip215: false });
    } catch {
        return false;
    }
}

/**
 * Verify a challenge envelope the way a presenter surface must BEFORE burning (A.3). Unsigned →
 * `unverified`; signed and every check passes → `verified` (or `expired` / `not_addressed` when the
 * signature holds but the deadline passed / the challenge names another presenter); any failure →
 * `invalid`. A domain requester needs `fetchRequesterKeys`; a wallet requester needs `provianKeys`
 * (the Provian presentation JWKS). A missing key source is `requester_key_unreachable` — never a pass.
 */
export async function verifyChallengeEnvelope(
    env: ChallengeEnvelope,
    opts: {
        fetchRequesterKeys?: FetchRequesterKeys;
        provianKeys?: readonly RequesterJwk[] | null;
        nowSeconds?: number;
        presenterAddress?: string;
    } = {},
): Promise<ChallengeVerdict> {
    if (!isSignedChallenge(env)) return { status: 'unverified', envelope: env };
    const structural = checkSignedStructure(env);
    if (structural) return { status: 'invalid', reason: structural, envelope: env };
    const requester = env.requester as EnvelopeRequester;
    const message = challengeSigningString({
        audience: env.audience,
        challenge: env.challenge,
        issuedAt: env.issuedAt as number,
        expiresAt: env.expiresAt as number,
        requester,
        presenter: env.presenter,
        predicates: env.predicates,
        disclosures: env.disclosures,
    });

    let keys: readonly RequesterJwk[];
    if (requester.type === 'wallet') {
        if (!opts.provianKeys) return { status: 'invalid', reason: 'requester_key_unreachable', envelope: env };
        keys = opts.provianKeys;
    } else {
        if (!opts.fetchRequesterKeys) return { status: 'invalid', reason: 'requester_key_unreachable', envelope: env };
        try { keys = await opts.fetchRequesterKeys(requester.id); } catch { return { status: 'invalid', reason: 'requester_key_unreachable', envelope: env }; }
    }
    const key = keys.find((k) => isRecord(k) && k.kid === requester.kid);
    if (!key) return { status: 'invalid', reason: 'key_not_found', envelope: env };
    if (!verifyEd25519(message, env.sig as string, key)) return { status: 'invalid', reason: 'bad_signature', envelope: env };

    const identity: RequesterIdentity = requester.type === 'wallet'
        ? { type: 'wallet', id: requester.id, address: requester.address }
        : { type: 'domain', id: requester.id };
    const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (now > (env.expiresAt as number) + CHALLENGE_CLOCK_SKEW_SECONDS) return { status: 'expired', requester: identity, envelope: env };
    if (env.presenter !== undefined && opts.presenterAddress !== undefined
        && env.presenter !== opts.presenterAddress.toLowerCase()) {
        return { status: 'not_addressed', requester: identity, envelope: env };
    }
    return { status: 'verified', requester: identity, envelope: env };
}

/** Parse a well-known requester key document / JWKS body. Throws on a malformed document. */
export function parseRequesterKeyDocument(body: unknown): RequesterJwk[] {
    if (!isRecord(body) || !Array.isArray(body.keys)) throw new Error('requester key document missing keys');
    const keys: RequesterJwk[] = [];
    for (const k of body.keys.slice(0, 16)) {
        if (isRecord(k) && k.kty === 'OKP' && k.crv === 'Ed25519' && typeof k.x === 'string' && typeof k.kid === 'string') {
            keys.push({ kty: 'OKP', crv: 'Ed25519', x: k.x, kid: k.kid });
        }
    }
    return keys;
}

/**
 * True only for a hostname the app may fetch a requester key from. The spec's domain regex already
 * excludes IPv4 / IPv6 literals and single-label hosts; this refuses them explicitly as well as
 * `localhost` / `*.localhost`. The app cannot resolve DNS to refuse a public name pointing at a
 * private IP — the relay's SSRF-guarded fetch covers that at `/present`.
 */
export function isFetchableRequesterDomain(host: string): boolean {
    if (typeof host !== 'string' || !DOMAIN_RE.test(host)) return false;
    if (host.includes(':') || host.includes('[')) return false;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
    if (host === 'localhost' || host.endsWith('.localhost')) return false;
    return true;
}

/** Minimal fetch shape the key fetcher needs (injectable for tests). */
export type KeyFetch = (url: string, init: {
    method: 'GET';
    redirect: 'manual';
    signal?: AbortSignal;
    headers: Record<string, string>;
}) => Promise<{
    ok: boolean;
    status: number;
    url?: string;
    type?: string;
    redirected?: boolean;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
}>;

/**
 * Fetch a domain requester's Ed25519 keys from `https://<domain>/.well-known/provian-requester.json`.
 * https only; IP-literal / localhost hosts refused before any request; no redirects (a 3xx, an opaque
 * redirect, or a response whose final URL differs is refused — RN may follow redirects silently);
 * bodies over 64 KiB refused; 5 s timeout. Throws on any failure (the verdict becomes
 * `requester_key_unreachable`).
 */
export async function fetchRequesterKeysHttps(
    domain: string,
    opts: { fetchImpl?: KeyFetch; timeoutMs?: number } = {},
): Promise<RequesterJwk[]> {
    if (!isFetchableRequesterDomain(domain)) throw new Error('requester_domain_refused');
    const url = `https://${domain}${REQUESTER_WELL_KNOWN_PATH}`;
    const fetchImpl: KeyFetch = opts.fetchImpl ?? ((u, init) => fetch(u, init) as unknown as ReturnType<KeyFetch>);
    const timeoutMs = opts.timeoutMs ?? REQUESTER_KEY_FETCH_TIMEOUT_MS;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            controller?.abort();
            reject(new Error('requester_key_timeout'));
        }, timeoutMs);
    });
    const work = (async (): Promise<RequesterJwk[]> => {
        const res = await fetchImpl(url, {
            method: 'GET',
            redirect: 'manual',
            ...(controller ? { signal: controller.signal } : {}),
            headers: { Accept: 'application/json' },
        });
        if ((res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect' || res.redirected === true) {
            throw new Error('requester_key_redirect_refused');
        }
        if (typeof res.url === 'string' && res.url.length > 0 && res.url !== url) throw new Error('requester_key_redirect_refused');
        if (!res.ok) throw new Error(`requester_key_http_${res.status}`);
        const declared = res.headers.get('content-length');
        if (declared !== null && Number(declared) > REQUESTER_KEY_DOC_MAX_BYTES) throw new Error('requester_key_too_large');
        const text = await res.text();
        if (utf8ToBytes(text).length > REQUESTER_KEY_DOC_MAX_BYTES) throw new Error('requester_key_too_large');
        return parseRequesterKeyDocument(JSON.parse(text));
    })();
    // A late failure after the timeout already won must not surface as an unhandled rejection.
    work.catch(() => undefined);
    try {
        return await Promise.race([work, timeout]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

/** Short `0x1234…abcd` form for display. */
export function shortAddress(address: string): string {
    return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/** The requester identity to SHOW: domain → hostname; wallet → wallet id + short address. */
export function requesterDisplay(identity: RequesterIdentity): string {
    return identity.type === 'wallet' && identity.address
        ? `${identity.id} (${shortAddress(identity.address)})`
        : identity.id;
}
