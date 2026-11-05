/**
 * JWS key material + EdDSA verification for burn-to-present PRESENTATION.
 *
 * Relocated byte-for-byte from `core/commerce-attestation/commerce-attestation.ts`
 * when the B6 merchant commerce-attestation product was removed (wallet
 * simplification, ). The `ATTESTATION_SIGNING_KEY` Secret Manager mount,
 * the JWK loader, the public-JWK type and the JWS verify wire-format now serve
 * ONLY `/v1/present/jwks` + `/v1/present/verify` (`routes/present.ts`,
 * `presentation/signer.ts`, `presentation/verify.ts`). Names are kept so the
 * presentation consumers are byte-identical.
 */
/**
 * Commerce-attestation key material + JWS verification (B6).
 *
 * The signer this verifies is the (currently unwired) commerce-attestation
 * module at repo root `src/core/attestation/attestation.ts`: it signs Provian
 * commerce attestations as compact JWS — EdDSA (Ed25519) — with header
 * `{ alg: 'EdDSA', kid, typ: 'provian-attestation+jwt', x5u: <JWKS URI> }`
 * and payload claims `{ iss: 'https://provian.com', iat, exp (iat + 300s),
 * jti, sub (PPID), txn, dai, gov, pe, consumer, ... }`. The developers page
 * promises merchants can verify those attestations against "Provian's JWKS or
 * verification endpoint"; this module is the backend half of that promise:
 * one loader for the key material both routes consume, and one fail-closed
 * verifier.
 *
 * KEY MATERIAL — env var `ATTESTATION_SIGNING_KEY` (a Secret Manager mount,
 * same pattern as RELAY_SIGNING_KEY / TOKEN_SIGNING_SECRET): JSON, either a
 * single Ed25519 JWK or a JWK Set `{"keys":[...]}` (a set carries a rotation
 * overlap — old + new key both serveable while old-kid attestations age out).
 * Every entry must be OKP/Ed25519 with a `kid` and a 32-byte `x` public
 * coordinate. A private `d` member is ACCEPTED (the signer's own key can be
 * mounted directly) but is NEVER emitted: the public projection is built
 * field-by-field, never by spread, so private material cannot ride along.
 *
 * FAIL CLOSED. Unset material and invalid material are both refusals — the
 * loader answers `unset` / `invalid` and the routes turn that into a 503
 * `attestation_signing_unconfigured`. An entry that fails validation poisons
 * the WHOLE configuration rather than being silently dropped: half-serving a
 * rotation set is a silent outage for the kid that got dropped, and
 * "Unknown = Block, Not Warn" applies to configuration too. Nothing here ever
 * fabricates or serves an empty key set.
 */

import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Constants — must byte-match what the signer module emits.
// ---------------------------------------------------------------------------

/** Env var carrying the Ed25519 JWK / JWK Set JSON. */
export const ATTESTATION_SIGNING_KEY_ENV = 'ATTESTATION_SIGNING_KEY';

/**
 * The `iss` the signer stamps into every attestation
 * (`PROVIAN_ISSUER` in `src/core/attestation/attestation.ts`, and a literal
 * type in that module's `ProvianAttestationPayload`).
 */
export const COMMERCE_ATTESTATION_ISSUER = 'https://provian.com';

/** The `typ` header the signer stamps; required, not merely tolerated. */
export const COMMERCE_ATTESTATION_TYP = 'provian-attestation+jwt';

/**
 * The signer's TTL (`ATTESTATION_TTL_SECONDS`): exp = iat + 300. The verifier
 * mirrors the module's own `maxTokenAge` posture — a token whose iat is older
 * than this (plus skew) is refused even if a forged-but-signed exp says
 * otherwise.
 */
export const COMMERCE_ATTESTATION_MAX_AGE_SECONDS = 300;

/** Clock-skew tolerance for iat/exp comparisons. */
export const COMMERCE_ATTESTATION_CLOCK_SKEW_SECONDS = 60;

// ---------------------------------------------------------------------------
// Key material
// ---------------------------------------------------------------------------

/** Public-only JWK served by the JWKS route. Constructed field-by-field. */
export interface CommerceAttestationPublicJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  kid: string;
  x: string;
  use: 'sig';
  alg: 'EdDSA';
  key_ops: ['verify'];
}

export type CommerceAttestationKeyMaterial =
  | { ok: true; keys: CommerceAttestationPublicJwk[] }
  | { ok: false; reason: 'unset' | 'invalid' };

interface CandidateJwk {
  kid: string;
  x: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate one configured JWK entry. Returns the kid + x pair or null.
 * Strict: kty OKP, crv Ed25519, non-empty kid, x decoding to exactly 32
 * bytes AND importable as an Ed25519 public key (garbage fails at load, not
 * at first verify).
 */
function parseCandidate(entry: unknown): CandidateJwk | null {
  if (!isRecord(entry)) return null;
  if (entry.kty !== 'OKP' || entry.crv !== 'Ed25519') return null;
  const kid = entry.kid;
  const x = entry.x;
  if (typeof kid !== 'string' || kid.length === 0) return null;
  if (typeof x !== 'string' || !/^[A-Za-z0-9_-]+$/.test(x)) return null;
  if (Buffer.from(x, 'base64url').length !== 32) return null;
  try {
    importPublicKey(x);
  } catch {
    return null;
  }
  return { kid, x };
}

/**
 * Load and validate the configured key material. Read this per REQUEST, never
 * captured at module/mount time, so rotation and un/mis-configuration take
 * effect without a redeploy (same doctrine as the pre-launch gate).
 */
export function loadCommerceAttestationKeys(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): CommerceAttestationKeyMaterial {
  const raw = env[ATTESTATION_SIGNING_KEY_ENV];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, reason: 'unset' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  let entries: unknown[];
  if (isRecord(parsed) && Array.isArray(parsed.keys)) {
    entries = parsed.keys;
  } else if (isRecord(parsed)) {
    entries = [parsed];
  } else {
    return { ok: false, reason: 'invalid' };
  }

  if (entries.length === 0) return { ok: false, reason: 'invalid' };

  const keys: CommerceAttestationPublicJwk[] = [];
  const seenKids = new Set<string>();
  for (const entry of entries) {
    const candidate = parseCandidate(entry);
    // One bad entry poisons the whole configuration (loud fail; see docblock).
    if (candidate === null) return { ok: false, reason: 'invalid' };
    // Duplicate kids make verification ambiguous — refuse the configuration.
    if (seenKids.has(candidate.kid)) return { ok: false, reason: 'invalid' };
    seenKids.add(candidate.kid);
    // Field-by-field public projection. NEVER spread the entry: a mounted
    // private JWK carries `d`, and a spread would serve it to the world.
    keys.push({
      kty: 'OKP',
      crv: 'Ed25519',
      kid: candidate.kid,
      x: candidate.x,
      use: 'sig',
      alg: 'EdDSA',
      key_ops: ['verify'],
    });
  }

  return { ok: true, keys };
}

function importPublicKey(x: string): crypto.KeyObject {
  return crypto.createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x },
    format: 'jwk',
  });
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export type CommerceAttestationRefusalReason =
  | 'malformed_token'
  | 'unsupported_alg'
  | 'wrong_typ'
  | 'crit_not_supported'
  | 'unknown_kid'
  | 'bad_signature'
  | 'invalid_payload'
  | 'issuer_mismatch'
  | 'missing_claims'
  | 'not_yet_valid'
  | 'expired';

export type CommerceAttestationVerifyResult =
  | { valid: true; payload: Record<string, unknown> }
  | { valid: false; reason: CommerceAttestationRefusalReason };

const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

function decodeJsonSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

/**
 * Verify a compact-serialization commerce attestation against the configured
 * public keys. Every refusal is fail-closed and enumerated: unknown kid, any
 * alg other than EdDSA (so `none` / RS256 substitution dies structurally),
 * unsupported critical extensions, bad signature, wrong issuer, and
 * missing/expired/not-yet-valid temporal claims. The payload is only parsed
 * AFTER the signature verifies — attacker-controlled JSON is not touched
 * before authenticity is established.
 */
export function verifyCommerceAttestation(
  token: string,
  keys: readonly CommerceAttestationPublicJwk[],
  nowSeconds: number = Math.floor(Date.now() / 1000),
): CommerceAttestationVerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'malformed_token' };
  const [headerB64, payloadB64, signatureB64] = parts;
  if (
    !BASE64URL_SEGMENT.test(headerB64)
    || !BASE64URL_SEGMENT.test(payloadB64)
    || !BASE64URL_SEGMENT.test(signatureB64)
  ) {
    return { valid: false, reason: 'malformed_token' };
  }

  let header: unknown;
  try {
    header = decodeJsonSegment(headerB64);
  } catch {
    return { valid: false, reason: 'malformed_token' };
  }
  if (!isRecord(header)) return { valid: false, reason: 'malformed_token' };

  if (header.alg !== 'EdDSA') return { valid: false, reason: 'unsupported_alg' };
  if (header.typ !== COMMERCE_ATTESTATION_TYP) return { valid: false, reason: 'wrong_typ' };
  // RFC 7515 §4.1.11: a JWS with a `crit` we do not process MUST be rejected.
  if ('crit' in header) return { valid: false, reason: 'crit_not_supported' };

  const kid = header.kid;
  if (typeof kid !== 'string' || kid.length === 0) {
    return { valid: false, reason: 'unknown_kid' };
  }
  const key = keys.find((k) => k.kid === kid);
  if (!key) return { valid: false, reason: 'unknown_kid' };

  const signature = Buffer.from(signatureB64, 'base64url');
  if (signature.length !== 64) return { valid: false, reason: 'bad_signature' };

  let signatureValid = false;
  try {
    signatureValid = crypto.verify(
      null,
      Buffer.from(`${headerB64}.${payloadB64}`, 'utf8'),
      importPublicKey(key.x),
      signature,
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) return { valid: false, reason: 'bad_signature' };

  let payload: unknown;
  try {
    payload = decodeJsonSegment(payloadB64);
  } catch {
    return { valid: false, reason: 'invalid_payload' };
  }
  if (!isRecord(payload)) return { valid: false, reason: 'invalid_payload' };

  if (payload.iss !== COMMERCE_ATTESTATION_ISSUER) {
    return { valid: false, reason: 'issuer_mismatch' };
  }

  const iat = payload.iat;
  const exp = payload.exp;
  if (typeof iat !== 'number' || !Number.isFinite(iat)
    || typeof exp !== 'number' || !Number.isFinite(exp)) {
    return { valid: false, reason: 'missing_claims' };
  }

  const skew = COMMERCE_ATTESTATION_CLOCK_SKEW_SECONDS;
  if (iat > nowSeconds + skew) return { valid: false, reason: 'not_yet_valid' };
  if (exp <= nowSeconds - skew) return { valid: false, reason: 'expired' };
  if (nowSeconds - iat > COMMERCE_ATTESTATION_MAX_AGE_SECONDS + skew) {
    return { valid: false, reason: 'expired' };
  }

  return { valid: true, payload };
}
