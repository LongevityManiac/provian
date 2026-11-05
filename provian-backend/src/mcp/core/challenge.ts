/**
 * SIGNED CHALLENGES (`provian-challenge-v1`,) — the requester's half of burn-to-present, for
 * the MCP tool core.
 *
 * SHARED CORE — canonical in `provian-mcp/src/core/`, mirrored byte-identically into
 * `provian-backend/src/mcp/core/`. Edit only the canonical copy and run `scripts/sync-mcp-core.sh`.
 *
 * A byte-for-byte port of the relay's `core/presentation/challenge.ts` (signing string, predicate
 * digest, parse, structural rules, Ed25519 verdict). The MCP core cannot import the relay or the
 * SDK, so it carries its own audited copy, pinned by the fixed vectors in
 * `challenge.test.ts` the same vectors every other package pins.
 *
 * A requester hands a presenter `{ v, audience, challenge, predicates?, issuedAt, expiresAt,
 * presenter?, requester, sig }`. With `requester`/`sig` it is SIGNED (Ed25519): a domain requester
 * with its own key published at `https://<domain>/.well-known/provian-requester.json`, a wallet
 * requester by the RELAY with the Provian presentation key (`/v1/present/jwks`) after it
 * authenticated that wallet. `audience === requester.id`, so the presentation's `aud` IS the
 * verified requester. An unsigned legacy `{ audience, challenge, predicates? }` stays valid and is
 * shown UNVERIFIED; a signed challenge failing any check is INVALID and refused (Unknown = Block).
 *
 * The one outbound fetch here (a domain requester's key document) is SSRF-guarded to the same bar
 * as the relay (Security Invariant #6): hostname regex (no IP literals, no localhost), resolve and
 * refuse ANY private address, pin the socket to the validated address (no DNS-rebinding TOCTOU),
 * https only, no redirects, ≤ 64 KiB, ≤ 5 s. Node built-ins only, so the relay mirror compiles with
 * nothing new.
 */

import { createHash, createPublicKey, verify as cryptoVerify, randomBytes } from 'crypto';
import dns from 'dns/promises';
import net from 'net';
import { Agent as HttpsAgent, request as httpsRequest } from 'https';
import {
  canonicalReputationDirective,
  normalizePredicateRequests,
  PRESENTATION_AUDIENCE_MAX_LEN,
  PRESENTATION_CHALLENGE_MAX_LEN,
  PRESENTATION_CHALLENGE_MIN_LEN,
  PRESENTATION_CLOCK_SKEW_SECONDS,
  requesterString,
  type PredicateRequest,
} from './presentation';
import { challengeDisclosuresDigest, normalizeDisclosureRequests, type CanonicalDisclosureRequest } from './disclosure-request';

export const CHALLENGE_SIGNING_TAG = 'provian-challenge-v1';
export const CHALLENGE_ENVELOPE_VERSION = 1 as const;
/** The requester key document path under the requester's domain. */
export const REQUESTER_WELL_KNOWN_PATH = '/.well-known/provian-requester.json';
/** Signed-challenge lifetime bounds (seconds): 60 s .. 7 days. */
export const CHALLENGE_MIN_TTL_SECONDS = 60;
export const CHALLENGE_MAX_TTL_SECONDS = 7 * 24 * 3600;
/** Local gates default to 15 minutes. */
export const CHALLENGE_DEFAULT_TTL_SECONDS = 900;

export const REQUESTER_KEYS_MAX_BYTES = 64 * 1024;
export const REQUESTER_KEYS_TIMEOUT_MS = 5000;
export const REQUESTER_KEYS_CACHE_MS = 5 * 60 * 1000;

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

export { requesterString };

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

/** One Ed25519 public key from a requester's well-known document (or the Provian JWKS). */
export interface RequesterJwk {
  readonly kty: string;
  readonly crv?: string;
  readonly x?: string;
  readonly kid: string;
}

/** Fetch a domain requester's published keys. Throws when unreachable / malformed. */
export type FetchRequesterKeys = (domain: string) => Promise<readonly RequesterJwk[]>;
/** The Provian presentation public keys, or a lazy loader for them (fetched only for a wallet requester). */
export type ProvianChallengeKeys = readonly RequesterJwk[] | (() => Promise<readonly RequesterJwk[]>);

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
  const canonical = canonicalReputationDirective({ redact: [], predicates: predicates ?? [] }).predicates;
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
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
  if (env.disclosures !== undefined && env.disclosures.length > 0) lines.push(`disclosures=${challengeDisclosuresDigest(env.disclosures)}`);
  return lines.join('\n');
}

/** Structural rules for a SIGNED envelope (A.2), excluding the signature itself. */
export function checkSignedStructure(env: ChallengeEnvelope): ChallengeInvalidReason | null {
  if (env.v !== CHALLENGE_ENVELOPE_VERSION) return 'unsupported_version';
  const r = env.requester;
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
    const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.x }, format: 'jwk' });
    return cryptoVerify(null, Buffer.from(message, 'utf8'), pub, sig);
  } catch {
    return false;
  }
}

/**
 * Verify a challenge envelope the way a presenter surface must BEFORE burning (A.3). Unsigned →
 * `unverified`; signed and every check passes → `verified` (or `expired` / `not_addressed` when
 * the signature holds but the deadline passed / the challenge names another presenter); any
 * failure → `invalid`. A domain requester needs `fetchRequesterKeys`; a wallet requester needs
 * `provianKeys` (the Provian presentation JWKS, or a lazy loader for it).
 */
export async function verifyChallengeEnvelope(
  env: ChallengeEnvelope,
  opts: {
    fetchRequesterKeys?: FetchRequesterKeys;
    provianKeys?: ProvianChallengeKeys;
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
    const source = opts.provianKeys;
    try { keys = typeof source === 'function' ? await source() : source; } catch { return { status: 'invalid', reason: 'requester_key_unreachable', envelope: env }; }
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
  if (now > (env.expiresAt as number) + PRESENTATION_CLOCK_SKEW_SECONDS) return { status: 'expired', requester: identity, envelope: env };
  if (env.presenter !== undefined && opts.presenterAddress !== undefined
    && env.presenter !== opts.presenterAddress.toLowerCase()) {
    return { status: 'not_addressed', requester: identity, envelope: env };
  }
  return { status: 'verified', requester: identity, envelope: env };
}

/** Parse a well-known requester key document body (or a JWKS). Throws on a malformed document. */
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

// ---------------------------------------------------------------------------
// Presenter-facing display (A.3) — one shape every MCP tool returns.
// ---------------------------------------------------------------------------

export interface RequesterVerdictView {
  readonly status: ChallengeVerdict['status'];
  /** The verified (or signature-verified but refused) identity; null for unsigned / invalid. */
  readonly identity: RequesterIdentity | null;
  /** invalid only: why. */
  readonly reason?: ChallengeInvalidReason;
  /** One line a presenter surface shows. */
  readonly display: string;
}

function identityLabel(r: RequesterIdentity): string {
  return r.type === 'wallet' ? `${r.id} (${r.address ?? ''})` : r.id;
}

export function describeVerdict(v: ChallengeVerdict): RequesterVerdictView {
  switch (v.status) {
    case 'verified':
      return { status: 'verified', identity: v.requester, display: `Requester: ${identityLabel(v.requester)} — verified` };
    case 'unverified':
      return { status: 'unverified', identity: null, display: `Requester: ${v.envelope.audience} — unverified (unsigned challenge)` };
    case 'expired':
      return { status: 'expired', identity: v.requester, display: `Requester: ${identityLabel(v.requester)} — challenge EXPIRED; do not burn or present` };
    case 'not_addressed':
      return { status: 'not_addressed', identity: v.requester, display: `Requester: ${identityLabel(v.requester)} — challenge is addressed to a DIFFERENT presenter; do not burn or present` };
    default:
      return { status: 'invalid', identity: null, reason: v.reason, display: `Signed challenge is INVALID (${v.reason}) — refuse; do not burn or present` };
  }
}

/** A fresh unsigned (legacy) challenge in the wire shape. Presenters see it as UNVERIFIED. */
export function issueUnsignedChallenge(input: {
  audience: string;
  predicates?: readonly PredicateRequest[];
  disclosures?: readonly CanonicalDisclosureRequest[];
  ttlSeconds?: number;
  presenter?: string;
  nowSeconds?: number;
}): ChallengeEnvelope {
  const issuedAt = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = input.ttlSeconds ?? CHALLENGE_DEFAULT_TTL_SECONDS;
  const env: Record<string, unknown> = { audience: input.audience, challenge: randomBytes(32).toString('hex') };
  if (input.predicates && input.predicates.length > 0) env.predicates = [...input.predicates];
  if (input.disclosures && input.disclosures.length > 0) env.disclosures = [...input.disclosures];
  env.issuedAt = issuedAt;
  env.expiresAt = issuedAt + ttl;
  if (input.presenter !== undefined) env.presenter = input.presenter.toLowerCase();
  return env as unknown as ChallengeEnvelope;
}

// ---------------------------------------------------------------------------
// Domain requester key discovery — SSRF-guarded (Security Invariant #6).
// ---------------------------------------------------------------------------

function parseIpv4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** Eight 16-bit segments, or null when the text (brackets / zone id tolerated) is not one IPv6 address. */
function expandIpv6(raw: string): number[] | null {
  let text = raw.trim().replace(/^\[|\]$/g, '');
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  if (text.length === 0 || !/^[0-9a-fA-F:.]+$/.test(text)) return null;
  if (text.includes('.')) {
    const lastColon = text.lastIndexOf(':');
    if (lastColon === -1) return null;
    const v4 = parseIpv4(text.slice(lastColon + 1));
    if (v4 === null) return null;
    text = `${text.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let segments: string[];
  if (halves.length === 2) {
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    segments = [...left, ...new Array<string>(missing).fill('0'), ...right];
  } else {
    segments = left;
  }
  if (segments.length !== 8) return null;
  const out: number[] = [];
  for (const segment of segments) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(segment)) return null;
    out.push(parseInt(segment, 16));
  }
  return out;
}

/**
 * Private / internal / non-routable address predicate. Anything it cannot parse as a public IPv4 /
 * IPv6 address is treated as private (fail-closed). A superset of the relay's `isPrivateIp`
 * (adds CGNAT, multicast/reserved, IPv6 multicast, NAT64 / 6to4 which can embed a private v4).
 */
export function isPrivateIp(ip: string): boolean {
  if (ip.includes(':')) {
    // Judged on the PARSED segments, never the text: an uncompressed `0:0:0:0:0:0:0:1` or a
    // bracketed literal spells the same loopback (2026-10-17 bug check).
    const s = expandIpv6(ip);
    if (s === null) return true;
    const zeroThrough = (n: number): boolean => s.slice(0, n).every((x) => x === 0);
    if (zeroThrough(8)) return true; // ::
    if (zeroThrough(7) && s[7] === 1) return true; // ::1
    const embedded = `${s[6] >> 8}.${s[6] & 0xff}.${s[7] >> 8}.${s[7] & 0xff}`;
    // Every IPv4-embedding form under ::/80 — mapped `::ffff:a.b.c.d`, translated `::ffff:0:a.b.c.d`
    // (SIIT), compatible `::a.b.c.d` — is refused whatever it embeds: a public host is reached by its
    // plain IPv4, and a translation path is a way to reach a private one .
    if (zeroThrough(4) && (s[4] === 0 || s[4] === 0xffff) && (s[5] === 0 || s[5] === 0xffff)) return true;
    if (s[0] === 0x0064 && s[1] === 0xff9b) return isPrivateIp(embedded); // NAT64 — judged by the embedded v4
    if (s[0] === 0x2002) return isPrivateIp(`${s[1] >> 8}.${s[1] & 0xff}.${s[2] >> 8}.${s[2] & 0xff}`); // 6to4
    if ((s[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
    if ((s[0] & 0xffc0) === 0xfec0) return true; // site-local (deprecated)
    if ((s[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
    if ((s[0] & 0xff00) === 0xff00) return true; // multicast
    if (s[0] === 0x2001 && s[1] === 0x0db8) return true; // documentation — never routable
    return false;
  }
  const p = parseIpv4(ip);
  if (!p) return true;
  if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT 100.64/10
  if (p[0] === 169 && p[1] === 254) return true; // link-local incl. cloud metadata
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 192 && p[1] === 0 && (p[2] === 0 || p[2] === 2)) return true;
  if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return true; // benchmarking
  if (p[0] >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/** A requester domain the guard will fetch from: the spec's hostname regex, never localhost. */
export function isAllowedRequesterDomain(domain: string): boolean {
  if (!DOMAIN_RE.test(domain)) return false;
  if (domain === 'localhost' || domain.endsWith('.localhost')) return false;
  return net.isIP(domain) === 0;
}

export interface RequesterKeyFetchDeps {
  /** Resolve a hostname to A + AAAA addresses (test seam). */
  readonly resolveHostname?: (hostname: string) => Promise<string[]>;
  /** Perform the pinned GET (test seam). Resolves the body, or null on any non-2xx / failure. */
  readonly get?: (url: string, pinnedIp: string) => Promise<Buffer | null>;
  readonly nowMs?: () => number;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const [v4, v6] = await Promise.all([
    dns.resolve4(hostname).catch(() => [] as string[]),
    dns.resolve6(hostname).catch(() => [] as string[]),
  ]);
  return [...v4, ...v6];
}

function pinnedGet(url: string, pinnedIp: string): Promise<Buffer | null> {
  const family = net.isIP(pinnedIp) === 6 ? 6 : 4;
  // Node 20+ calls an Agent's lookup with `{ all: true }` (autoSelectFamily) and expects an ARRAY;
  // the single-address answer fails the connection ("Invalid IP address: undefined"). Answer both.
  const lookupImpl = (_h: string, options: unknown, cb: (...args: unknown[]) => void): void => {
    const all = typeof options === 'object' && options !== null && (options as { all?: unknown }).all === true;
    if (all) cb(null, [{ address: pinnedIp, family }]);
    else cb(null, pinnedIp, family);
  };
  const agent = new HttpsAgent({ lookup: lookupImpl as unknown as net.LookupFunction });
  return new Promise<Buffer | null>((resolve) => {
    let settled = false;
    const done = (v: Buffer | null): void => { if (!settled) { settled = true; resolve(v); } };
    const outbound = httpsRequest(url, { method: 'GET', agent, timeout: REQUESTER_KEYS_TIMEOUT_MS, headers: { accept: 'application/json' } }, (response) => {
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) { response.resume(); done(null); return; } // no redirects
      const chunks: Buffer[] = [];
      let total = 0;
      response.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > REQUESTER_KEYS_MAX_BYTES) { outbound.destroy(new Error('too_large')); done(null); return; }
        chunks.push(chunk);
      });
      response.on('end', () => done(Buffer.concat(chunks)));
      response.on('error', () => done(null));
    });
    const hardStop = setTimeout(() => { outbound.destroy(new Error('timeout')); done(null); }, REQUESTER_KEYS_TIMEOUT_MS);
    outbound.on('timeout', () => outbound.destroy(new Error('timeout')));
    outbound.on('error', () => done(null));
    outbound.on('close', () => clearTimeout(hardStop));
    outbound.end();
  }).finally(() => agent.destroy());
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

const keyCache = new Map<string, { keys: RequesterJwk[]; atMs: number }>();

/** Clear the per-domain key cache (tests / key rotation). */
export function clearRequesterKeyCache(): void {
  keyCache.clear();
}

/**
 * Fetch a domain requester's Ed25519 keys, SSRF-guarded. Throws on any failure (the caller maps a
 * throw to `requester_key_unreachable`, never to a verified identity). Cached 5 minutes per domain
 * so one requester cannot turn a presenter surface into a request amplifier.
 */
export async function fetchRequesterKeysGuarded(domain: string, deps: RequesterKeyFetchDeps = {}): Promise<RequesterJwk[]> {
  if (!isAllowedRequesterDomain(domain)) throw new Error('requester domain is not a public DNS hostname');
  const now = deps.nowMs ? deps.nowMs() : Date.now();
  const hit = keyCache.get(domain);
  if (hit && now - hit.atMs < REQUESTER_KEYS_CACHE_MS) return hit.keys;

  const addresses = await withTimeout((deps.resolveHostname ?? defaultResolve)(domain), REQUESTER_KEYS_TIMEOUT_MS, 'requester domain resolution');
  if (addresses.length === 0) throw new Error('requester domain does not resolve');
  for (const addr of addresses) {
    if (net.isIP(addr) === 0 || isPrivateIp(addr)) throw new Error('requester domain resolves to a private address');
  }
  const url = `https://${domain}${REQUESTER_WELL_KNOWN_PATH}`;
  const body = await withTimeout((deps.get ?? pinnedGet)(url, addresses[0]), REQUESTER_KEYS_TIMEOUT_MS + 500, 'requester key fetch');
  if (!body) throw new Error('requester key document unreachable');
  if (body.length > REQUESTER_KEYS_MAX_BYTES) throw new Error('requester key document too large');
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { throw new Error('requester key document is not JSON'); }
  const keys = parseRequesterKeyDocument(parsed);
  if (keys.length === 0) throw new Error('requester key document has no Ed25519 keys');
  keyCache.set(domain, { keys, atMs: now });
  return keys;
}
