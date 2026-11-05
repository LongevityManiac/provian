import { guardedFetcher, egressResolver } from './guarded-fetch';
/**
 * SIGNED CHALLENGES (`provian-challenge-v1`,) — the requester's half of burn-to-present,
 * SDK side. Mirrors the relay's `provian-backend/src/core/presentation/challenge.ts` byte-for-byte
 * (signing string, predicates digest, structural rules, verdicts); the fixed vectors in
 * `challenge.test.ts` are the relay's own output.
 *
 * A requester (a gate) hands a presenter a challenge envelope `{ v, audience, challenge,
 * predicates?, issuedAt, expiresAt, presenter?, requester, sig }`. When `requester` + `sig` are
 * present the challenge is SIGNED, so the presenter knows whom it presents to BEFORE it burns.
 * Every signature is Ed25519 over one canonical signing string; the identity kind picks the key:
 *
 * - domain — `requester.id` is a DNS hostname; the requester's own Ed25519 key
 * ({@link generateRequesterKey}, no Provian account) is published at
 * `https://<id>/.well-known/provian-requester.json` ({@link requesterWellKnownDocument}).
 * The presenter fetches it through the SDK egress guard (https only, public IPs only, no
 * redirects, ≤ 64 KiB, ≤ 5 s).
 * - wallet — `requester.id` is a Provian wallet id; the RELAY signs it with the Provian
 * presentation key (verify against `GET /v1/present/jwks`) after authenticating that wallet.
 *
 * AUDIENCE BINDING: a signed challenge's `audience` MUST equal `requester.id`.
 *
 * Unsigned legacy challenges `{ audience, challenge, predicates? }` stay valid and are shown
 * UNVERIFIED. A SIGNED challenge that fails any check is INVALID and is refused (Unknown = Block).
 */

import crypto from 'crypto';
import { promises as fsp } from 'fs';
import path from 'path';
import { ProvianError } from './errors';
import { validateEgressTarget, type HostResolver } from './egress-guard';
import {
  canonicalReputationDirective,
  normalizePredicateRequests,
  requesterString,
  type PredicateRequest,
} from './presentation';
import { challengeDisclosuresDigest, normalizeDisclosureRequests, type CanonicalDisclosureRequest } from './disclosure-request';

export { requesterString };

export const CHALLENGE_SIGNING_TAG = 'provian-challenge-v1';
export const CHALLENGE_ENVELOPE_VERSION = 1 as const;
/** The requester key document path under the requester's domain. */
export const REQUESTER_WELL_KNOWN_PATH = '/.well-known/provian-requester.json';
/** Signed-challenge lifetime bounds (seconds). 7 days max: a thread / remote request carries its delivery TTL. */
export const CHALLENGE_MIN_TTL_SECONDS = 60;
export const CHALLENGE_MAX_TTL_SECONDS = 7 * 24 * 3600;
/** Default lifetime of a locally issued challenge (seconds). */
export const CHALLENGE_DEFAULT_TTL_SECONDS = 900;
/** Mirrors the relay's PRESENTATION_CHALLENGE_MIN_LEN / MAX_LEN / AUDIENCE_MAX_LEN / CLOCK_SKEW. */
export const CHALLENGE_NONCE_MIN_LEN = 16;
export const CHALLENGE_NONCE_MAX_LEN = 512;
export const CHALLENGE_AUDIENCE_MAX_LEN = 512;
export const CHALLENGE_CLOCK_SKEW_SECONDS = 60;
/** Well-known key-document fetch bounds. */
export const REQUESTER_KEY_FETCH_TIMEOUT_MS = 5000;
export const REQUESTER_KEY_DOCUMENT_MAX_BYTES = 64 * 1024;

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

/** A challenge envelope as handed over any channel. `JSON.stringify` of it IS the wire form. */
export interface ChallengeEnvelope {
  readonly v?: number;
  readonly audience: string;
  readonly challenge: string;
  readonly predicates?: readonly PredicateRequest[];
  /** Requester-named disclosure requests (2026-10-10): a distinct part of the challenge, committed by
   *  its own signing-string line ONLY when present. */
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

/** A.3: the presenter-side verdict, computed BEFORE any burn. */
export type ChallengeVerdict =
  | { readonly status: 'verified'; readonly requester: RequesterIdentity; readonly envelope: ChallengeEnvelope }
  | { readonly status: 'unverified'; readonly envelope: ChallengeEnvelope }
  | { readonly status: 'invalid'; readonly reason: ChallengeInvalidReason; readonly envelope?: ChallengeEnvelope }
  | { readonly status: 'expired'; readonly requester: RequesterIdentity; readonly envelope: ChallengeEnvelope }
  | { readonly status: 'not_addressed'; readonly requester: RequesterIdentity; readonly envelope: ChallengeEnvelope };

/** The verdicts a presenter surface must refuse (no burn). */
export type RefusedChallengeVerdict = Extract<ChallengeVerdict, { status: 'invalid' | 'expired' | 'not_addressed' }>;

export function isRefusedVerdict(v: ChallengeVerdict): v is RefusedChallengeVerdict {
  return v.status === 'invalid' || v.status === 'expired' || v.status === 'not_addressed';
}

/**
 * Thrown by every presenter path when the challenge must not be answered — a signed challenge
 * that is invalid / expired / not addressed to this presenter (A.3), or a caller's
 * `onRequester` hook declining. Thrown BEFORE any burn: nothing was spent.
 */
export class ChallengeRefusedError extends ProvianError {
  public readonly verdict: ChallengeVerdict;
  /** True when the caller's `onRequester` hook declined an otherwise acceptable challenge. */
  public readonly declined: boolean;
  constructor(verdict: ChallengeVerdict, declined = false) {
    super(
      declined
        ? `challenge declined by onRequester (${verdict.status}); nothing was burned`
        : `challenge refused (${verdict.status}${verdict.status === 'invalid' ? `: ${verdict.reason}` : ''}); nothing was burned`,
      'CHALLENGE_REFUSED',
    );
    this.name = 'ChallengeRefusedError';
    this.verdict = verdict;
    this.declined = declined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** True when the envelope carries a requester signature (identity claim). */
export function isSignedChallenge(env: ChallengeEnvelope): boolean {
  return env.requester !== undefined || env.sig !== undefined;
}

/**
 * Parse an untrusted challenge envelope (object or JSON string). Structural only — no signature
 * check. Returns null when it is not a well-formed challenge (legacy or signed).
 */
export function parseChallengeEnvelope(raw: unknown): ChallengeEnvelope | null {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  if (!isRecord(obj)) return null;
  const audience = typeof obj.audience === 'string' ? obj.audience.trim() : '';
  const challenge = typeof obj.challenge === 'string' ? obj.challenge.trim() : '';
  if (audience.length === 0 || audience.length > CHALLENGE_AUDIENCE_MAX_LEN) return null;
  if (challenge.length < CHALLENGE_NONCE_MIN_LEN || challenge.length > CHALLENGE_NONCE_MAX_LEN) return null;
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
  const canonical = canonicalReputationDirective({ redact: [], predicates: predicates ?? [] }).predicates;
  return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
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
  // The disclosure line exists ONLY when the challenge names disclosures, so every pre-existing
  // challenge (and every pinned vector) signs byte-identical bytes.
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

function verifyEd25519(message: string, sigB64url: string, key: RequesterJwk): boolean {
  if (!BASE64URL_RE.test(sigB64url)) return false;
  if (key.kty !== 'OKP' || key.crv !== 'Ed25519' || typeof key.x !== 'string') return false;
  const sig = Buffer.from(sigB64url, 'base64url');
  if (sig.length !== 64) return false;
  try {
    const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.x }, format: 'jwk' });
    return crypto.verify(null, Buffer.from(message, 'utf8'), pub, sig);
  } catch {
    return false;
  }
}

/** Parse a well-known requester key document (or a JWKS) body. Throws on a malformed document. */
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

/** Read a response body as text, refusing anything over `maxBytes`. */
async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('requester key document too large');
  const body = res.body;
  if (!body) {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('requester key document too large');
    return text;
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new Error('requester key document too large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Build the default domain-key fetcher: `GET https://<domain>/.well-known/provian-requester.json`
 * through the SDK egress guard ({@link validateEgressTarget}: https only, no private / loopback /
 * link-local / metadata hosts, hosts resolving to a private IP refused), `redirect: 'manual'`
 * (any 3xx refused), a 5 s timeout, and a 64 KiB body cap.
 */
export function createRequesterKeyFetcher(opts: {
  fetchFn?: typeof fetch;
  resolveHost?: HostResolver;
  timeoutMs?: number;
  maxBytes?: number;
} = {}): FetchRequesterKeys {
  return async (domain: string): Promise<readonly RequesterJwk[]> => {
    if (typeof domain !== 'string' || !DOMAIN_RE.test(domain)) throw new Error('requester domain is not a valid hostname');
    const url = `https://${domain}${REQUESTER_WELL_KNOWN_PATH}`;
    const guard = await validateEgressTarget(url, { resolveHost: opts.resolveHost ?? egressResolver(url) });
    if (!guard.ok) throw new Error(`requester key fetch refused by the egress guard: ${guard.reason ?? guard.code ?? 'blocked'}`);
    const f = guardedFetcher(opts.fetchFn, opts.resolveHost);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? REQUESTER_KEY_FETCH_TIMEOUT_MS);
    try {
      const res = await f(url, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual', signal: controller.signal });
      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
        throw new Error('requester key document redirected (refused)');
      }
      if (!res.ok) throw new Error(`requester key document fetch failed (${res.status})`);
      const text = await readCappedText(res, opts.maxBytes ?? REQUESTER_KEY_DOCUMENT_MAX_BYTES);
      return parseRequesterKeyDocument(JSON.parse(text));
    } finally {
      clearTimeout(timer);
    }
  };
}

/** The default domain-key fetcher (global fetch + the Node DNS resolver behind the egress guard). */
export const fetchRequesterKeys: FetchRequesterKeys = (domain) => createRequesterKeyFetcher()(domain);

/** Fetch the Provian presentation JWKS (`${relayUrl}/v1/present/jwks`) — the wallet-requester key source. */
export async function fetchProvianPresentationKeys(relayUrl: string, fetchFn?: typeof fetch): Promise<RequesterJwk[]> {
  const f = guardedFetcher(fetchFn);
  const res = await f(`${relayUrl.replace(/\/+$/, '')}/v1/present/jwks`, { method: 'GET', headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`jwks fetch failed (${res.status})`);
  return parseRequesterKeyDocument(await res.json());
}

export interface VerifyChallengeEnvelopeOptions {
  /** Domain-requester key source. Default: the SSRF-guarded well-known fetch ({@link createRequesterKeyFetcher}). */
  fetchRequesterKeys?: FetchRequesterKeys;
  /** Wallet-requester key source (the Provian presentation JWKS). Default: fetched from `relayUrl` when given. */
  provianKeys?: readonly RequesterJwk[];
  /** Relay base URL — `provianKeys` defaults to `${relayUrl}/v1/present/jwks`. */
  relayUrl?: string;
  /** fetch used for the default key sources. */
  fetchFn?: typeof fetch;
  /** Resolver for the egress guard of the default domain fetcher (tests / custom DNS). */
  resolveHost?: HostResolver;
  nowSeconds?: number;
  /** This presenter's address — a signed `presenter` naming someone else is `not_addressed`. */
  presenterAddress?: string;
}

/**
 * Verify a challenge envelope the way a presenter surface must BEFORE burning (A.3). Unsigned →
 * `unverified`; signed and every check passes → `verified` (or `expired` / `not_addressed` when
 * the signature holds but the deadline passed / the challenge names another presenter); any
 * failure → `invalid`. Key sources are only touched for the requester kind the envelope names.
 */
export async function verifyChallengeEnvelope(
  env: ChallengeEnvelope,
  opts: VerifyChallengeEnvelopeOptions = {},
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
    if (opts.provianKeys) {
      keys = opts.provianKeys;
    } else if (opts.relayUrl) {
      try { keys = await fetchProvianPresentationKeys(opts.relayUrl, opts.fetchFn); } catch { return { status: 'invalid', reason: 'requester_key_unreachable', envelope: env }; }
    } else {
      return { status: 'invalid', reason: 'requester_key_unreachable', envelope: env };
    }
  } else {
    const fetcher = opts.fetchRequesterKeys ?? createRequesterKeyFetcher({ fetchFn: opts.fetchFn, resolveHost: opts.resolveHost });
    try { keys = await fetcher(requester.id); } catch { return { status: 'invalid', reason: 'requester_key_unreachable', envelope: env }; }
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

/** Human-readable requester line for a presenter surface (A.3 identity display). */
export function describeChallengeVerdict(v: ChallengeVerdict): string {
  switch (v.status) {
    case 'verified':
      return v.requester.type === 'wallet'
        ? `Requester: ${v.requester.id} (${v.requester.address}) — verified`
        : `Requester: ${v.requester.id} — verified`;
    case 'unverified':
      return `Requester: ${v.envelope.audience} — unverified (unsigned challenge)`;
    case 'expired':
      return `Requester: ${v.requester.id} — challenge expired (refused)`;
    case 'not_addressed':
      return `Requester: ${v.requester.id} — challenge addressed to a different presenter (refused)`;
    default:
      return `Requester: invalid signed challenge (${v.reason}) — refused`;
  }
}

function toPrivateKey(privateKey: crypto.KeyObject | string): crypto.KeyObject {
  return typeof privateKey === 'string' ? crypto.createPrivateKey(privateKey) : privateKey;
}

/** Sign a challenge envelope with an Ed25519 private key (KeyObject or PKCS8 PEM). Returns the complete envelope. */
export function signChallengeEnvelope(
  fields: {
    audience: string;
    challenge: string;
    issuedAt: number;
    expiresAt: number;
    requester: EnvelopeRequester;
    presenter?: string;
    predicates?: readonly PredicateRequest[];
    disclosures?: readonly CanonicalDisclosureRequest[];
  },
  privateKey: crypto.KeyObject | string,
): ChallengeEnvelope {
  const message = challengeSigningString(fields);
  const sig = crypto.sign(null, Buffer.from(message, 'utf8'), toPrivateKey(privateKey)).toString('base64url');
  const env: Record<string, unknown> = {
    v: CHALLENGE_ENVELOPE_VERSION,
    audience: fields.audience,
    challenge: fields.challenge,
  };
  if (fields.predicates && fields.predicates.length > 0) env.predicates = [...fields.predicates];
  if (fields.disclosures && fields.disclosures.length > 0) env.disclosures = [...fields.disclosures];
  env.issuedAt = fields.issuedAt;
  env.expiresAt = fields.expiresAt;
  if (fields.presenter !== undefined) env.presenter = fields.presenter.toLowerCase();
  env.requester = fields.requester.type === 'wallet'
    ? { type: 'wallet', id: fields.requester.id, address: (fields.requester.address ?? '').toLowerCase(), kid: fields.requester.kid }
    : { type: 'domain', id: fields.requester.id, kid: fields.requester.kid };
  env.sig = sig;
  return env as unknown as ChallengeEnvelope;
}

/** A requester's published Ed25519 public JWK. */
export interface RequesterPublicJwk {
  readonly kty: 'OKP';
  readonly crv: 'Ed25519';
  readonly x: string;
  readonly kid: string;
}

/**
 * Generate a domain requester's Ed25519 signing key. Keep `privateKeyPem` secret; publish
 * `publicJwk` in {@link requesterWellKnownDocument} at `https://<domain>/.well-known/provian-requester.json`.
 * No Provian account is involved.
 */
export function generateRequesterKey(opts: { kid?: string } = {}): { kid: string; privateKeyPem: string; publicJwk: RequesterPublicJwk } {
  const kid = opts.kid ?? `k${crypto.randomBytes(6).toString('hex')}`;
  if (!KID_RE.test(kid)) throw new Error('kid must match ^[A-Za-z0-9._-]{1,128}$');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  if (typeof jwk.x !== 'string') throw new Error('failed to export the Ed25519 public key');
  return {
    kid,
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid },
  };
}

/** The `/.well-known/provian-requester.json` body for the given public keys. */
export function requesterWellKnownDocument(publicJwks: readonly RequesterPublicJwk[]): { keys: RequesterPublicJwk[] } {
  return { keys: publicJwks.map((k) => ({ kty: 'OKP', crv: 'Ed25519', x: k.x, kid: k.kid })) };
}

/**
 * Sign a DOMAIN challenge locally with the requester's own key. `audience` defaults to (and must
 * equal) `domain`. Used by {@link issuePresentationChallenge} in presentation-verify.
 */
export function signDomainChallenge(params: {
  domain: string;
  kid: string;
  privateKeyPem: string;
  challenge: string;
  issuedAt: number;
  expiresAt: number;
  presenter?: string;
  predicates?: readonly PredicateRequest[];
  disclosures?: readonly CanonicalDisclosureRequest[];
}): ChallengeEnvelope {
  if (!DOMAIN_RE.test(params.domain)) throw new Error('requester.domain must be a lowercase DNS hostname');
  if (!KID_RE.test(params.kid)) throw new Error('requester.kid must match ^[A-Za-z0-9._-]{1,128}$');
  const env = signChallengeEnvelope({
    audience: params.domain,
    challenge: params.challenge,
    issuedAt: params.issuedAt,
    expiresAt: params.expiresAt,
    requester: { type: 'domain', id: params.domain, kid: params.kid },
    presenter: params.presenter,
    predicates: params.predicates,
    disclosures: params.disclosures,
  }, params.privateKeyPem);
  const structural = checkSignedStructure(env);
  if (structural) throw new Error(`signed challenge is not well-formed (${structural})`);
  return env;
}

// ── Replay protection: the seen-store (item 6) ────────────────────────────

/**
 * A presentation-id seen-store. `claim` returns true the FIRST time an id is claimed (and
 * remembers it until `expiresAtSeconds`), false for every later claim while it is remembered.
 * `nowSeconds` (optional) is the verifier's clock, used for pruning.
 */
export interface PresentationSeenStore {
  claim(id: string, expiresAtSeconds: number, nowSeconds?: number): Promise<boolean>;
}

/** An in-memory seen-store (single process), TTL-pruned on every claim. */
export function createMemorySeenStore(): PresentationSeenStore {
  const seen = new Map<string, number>();
  return {
    async claim(id: string, expiresAtSeconds: number, nowSeconds?: number): Promise<boolean> {
      const now = nowSeconds ?? Math.floor(Date.now() / 1000);
      for (const [k, exp] of seen) if (exp < now) seen.delete(k);
      if (seen.has(id)) return false;
      seen.set(id, expiresAtSeconds);
      return true;
    },
  };
}

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

async function acquireLock(lockPath: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      const h = await fsp.open(lockPath, 'wx', 0o600);
      await h.close();
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        const st = await fsp.stat(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) { await fsp.rm(lockPath, { force: true }); continue; }
      } catch { continue; }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error(`seen-store lock busy: ${lockPath}`);
      await new Promise((r) => setTimeout(r, 15 + Math.floor(Math.random() * 20)));
    }
  }
}

/**
 * A JSON-file seen-store for multi-process use (e.g. the CLI). Each claim takes an exclusive
 * lock file (`<path>.lock`), reads `{ id: expiresAtSeconds }`, prunes expired entries, records the
 * claim, and writes atomically (temp file + rename). Creates the parent directory. A store that
 * cannot be read or written THROWS — the verifier then refuses (Unknown = Block).
 */
export function createFileSeenStore(filePath: string): PresentationSeenStore {
  const resolved = path.resolve(filePath);
  const lockPath = `${resolved}.lock`;
  return {
    async claim(id: string, expiresAtSeconds: number, nowSeconds?: number): Promise<boolean> {
      const now = nowSeconds ?? Math.floor(Date.now() / 1000);
      await fsp.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
      await acquireLock(lockPath);
      try {
        // Null-prototype maps: an id is data, never a prototype key.
        let entries: Record<string, number> = Object.create(null) as Record<string, number>;
        try {
          const parsed: unknown = JSON.parse(await fsp.readFile(resolved, 'utf8'));
          if (isRecord(parsed)) {
            for (const [k, v] of Object.entries(parsed)) if (typeof v === 'number') entries[k] = v;
          } else {
            throw new Error('seen-store file is not a JSON object');
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          entries = Object.create(null) as Record<string, number>;
        }
        const kept: Record<string, number> = Object.create(null) as Record<string, number>;
        for (const [k, exp] of Object.entries(entries)) if (exp >= now) kept[k] = exp;
        const fresh = !Object.prototype.hasOwnProperty.call(kept, id);
        if (fresh) kept[id] = expiresAtSeconds;
        const tmp = `${resolved}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        await fsp.writeFile(tmp, JSON.stringify(kept), { mode: 0o600 });
        await fsp.rename(tmp, resolved);
        return fresh;
      } finally {
        await fsp.rm(lockPath, { force: true });
      }
    },
  };
}
