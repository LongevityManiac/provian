/**
 * Minimal JWS/JWT verification against a JWKS (RS256 / ES256 / ES384 / PS256) — for the two
 * attestation services that publish keys at a fixed issuer (GCP Confidential Space, Azure
 * Attestation). No `jose` dependency (the relay image installs only provian-backend's deps).
 */
import crypto from 'crypto';

export interface Jwk { readonly kty: string; readonly kid?: string; readonly alg?: string; readonly use?: string; readonly n?: string; readonly e?: string; readonly crv?: string; readonly x?: string; readonly y?: string; readonly x5c?: string[] }

export interface DecodedJwt { readonly header: Record<string, unknown>; readonly payload: Record<string, unknown>; readonly signingInput: Buffer; readonly signature: Buffer; readonly raw: string }

export function decodeJwt(token: string): DecodedJwt | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as Record<string, unknown>;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof header !== 'object' || header === null || typeof payload !== 'object' || payload === null) return null;
    return { header, payload, signingInput: Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8'), signature: Buffer.from(parts[2], 'base64url'), raw: token };
  } catch {
    return null;
  }
}

export function keyFromJwk(jwk: Jwk): crypto.KeyObject | null {
  try {
    if (Array.isArray(jwk.x5c) && jwk.x5c.length > 0) {
      return new crypto.X509Certificate(Buffer.from(jwk.x5c[0], 'base64')).publicKey;
    }
    if (jwk.kty === 'RSA' && jwk.n && jwk.e) return crypto.createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
    if (jwk.kty === 'EC' && jwk.crv && jwk.x && jwk.y) return crypto.createPublicKey({ key: { kty: 'EC', crv: jwk.crv, x: jwk.x, y: jwk.y }, format: 'jwk' });
    return null;
  } catch {
    return null;
  }
}

export function verifyJwsSignature(jwt: DecodedJwt, key: crypto.KeyObject): boolean {
  const alg = jwt.header.alg;
  try {
    switch (alg) {
      case 'RS256': return crypto.verify('sha256', jwt.signingInput, { key, padding: crypto.constants.RSA_PKCS1_PADDING }, jwt.signature);
      case 'RS384': return crypto.verify('sha384', jwt.signingInput, { key, padding: crypto.constants.RSA_PKCS1_PADDING }, jwt.signature);
      case 'PS256': return crypto.verify('sha256', jwt.signingInput, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, jwt.signature);
      case 'ES256': return crypto.verify('sha256', jwt.signingInput, { key, dsaEncoding: 'ieee-p1363' }, jwt.signature);
      case 'ES384': return crypto.verify('sha384', jwt.signingInput, { key, dsaEncoding: 'ieee-p1363' }, jwt.signature);
      default: return false;
    }
  } catch {
    return false;
  }
}

/** Pick the JWKS key for a token: by `kid` when present, else the single key of a one-key set. */
export function selectJwk(keys: readonly Jwk[], kid: unknown): Jwk | null {
  if (typeof kid === 'string' && kid.length > 0) return keys.find((k) => k.kid === kid) ?? null;
  return keys.length === 1 ? keys[0] : null;
}

/** exp / nbf / iat window with `skewSeconds` tolerance; `exp` is REQUIRED. */
export function jwtTimeValid(payload: Record<string, unknown>, nowMs: number, skewSeconds: number = 300): boolean {
  const now = Math.floor(nowMs / 1000);
  const exp = payload.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return false;
  if (now > exp + skewSeconds) return false;
  const nbf = payload.nbf;
  if (typeof nbf === 'number' && now + skewSeconds < nbf) return false;
  return true;
}

export type JwksFetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const jwksCache = new Map<string, { keys: Jwk[]; fetchedAtMs: number }>();
const JWKS_TTL_MS = 60 * 60 * 1000;

export async function fetchJwks(url: string, fetchImpl: JwksFetch, nowMs: number): Promise<Jwk[] | null> {
  const cached = jwksCache.get(url);
  if (cached && nowMs - cached.fetchedAtMs < JWKS_TTL_MS) return cached.keys;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return cached?.keys ?? null;
    const body = await res.json() as { keys?: unknown };
    if (!Array.isArray(body.keys)) return null;
    const keys = body.keys.filter((k): k is Jwk => typeof k === 'object' && k !== null && typeof (k as Jwk).kty === 'string');
    jwksCache.set(url, { keys, fetchedAtMs: nowMs });
    return keys;
  } catch {
    return cached?.keys ?? null;
  }
}

export function resetJwksCacheForTests(): void { jwksCache.clear(); }

export function str(v: unknown): string | null { return typeof v === 'string' && v.length > 0 ? v : null; }
