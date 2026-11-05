/**
 * Bound-preimage signature verifier (BLOCKER-4 fix).
 *
 * Replaces the legacy "P-256 signature over raw body bytes" scheme that
 * had no method/path/timestamp/nonce binding (captured-then-replayed
 * indefinitely). The new envelope shape mirrors the v2 wallet-auth
 * tokens:
 *
 *   X-Provian-Signature: <preimage_b64u>.<sig_b64u>
 *   preimage_b64u = base64url(JSON.stringify({
 *       mth: "POST",
 *       pth: "/v1/pe/submit",
 *       bh:  "<sha256(rawBody) hex>",
 *       iat: <unix seconds>,
 *       exp: <unix seconds, iat + 300>,
 *       jti: "<128-bit random hex>",
 *       aud: "<DEPLOYMENT_AUDIENCE>"
 *   }))
 *   sig_b64u     = base64url of the compact P-256 signature (r||s, 64 bytes)
 *                  computed over the UTF-8 bytes of preimage_b64u itself.
 *
 * The signature is over the b64url string, not the JSON, so byte-stable
 * across canonicalisers. jti is consumed via cache.setNx with TTL =
 * exp - now + buffer; on Redis miss we fall back to a Firestore txn on
 * a `consumed_nonces` doc. Either failure → fail closed.
 *
 * SDK and mobile/server both compute the same preimage; the only env
 * configuration is the audience string (env DEVICE_SIGNATURE_AUDIENCE,
 * default "provian-relay-prod").
 */

import crypto, { webcrypto } from 'crypto';
import type { Request } from 'express';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { RedisCache } from '../../cache';

export interface BoundPreimageEnvelope {
  mth: string;
  pth: string;
  bh: string;
  iat: number;
  exp: number;
  jti: string;
  aud: string;
}

export interface BoundSignatureVerifyDeps {
  db: Firestore;
  cache: RedisCache;
}

export type BoundSignatureVerifyResult =
  | { ok: true; envelope: BoundPreimageEnvelope }
  | { ok: false; reason: string; code: string };

const DEFAULT_AUDIENCE = 'provian-relay-prod';
const MAX_SKEW_SECONDS = 60;
const NONCE_TTL_BUFFER_SECONDS = 60;

function fail(code: string, reason: string): { ok: false; reason: string; code: string } {
  return { ok: false, reason, code };
}

function expectedAudience(): string {
  return process.env.DEVICE_SIGNATURE_AUDIENCE || DEFAULT_AUDIENCE;
}

function decodeB64u(input: string): Buffer | null {
  try {
    return Buffer.from(input, 'base64url');
  } catch {
    return null;
  }
}

/**
 * Verify a bound X-Provian-Signature against the registered device's
 * P-256 public key. Returns the envelope on success so callers can
 * record telemetry (jti, exp) - but the envelope is NOT load-bearing
 * for downstream policy, only the verified=true outcome is.
 */
export async function verifyBoundDeviceSignature(input: {
  signatureHeader: string | string[] | undefined;
  rawBody: string;
  method: string;
  path: string;
  signingPublicKeyHex: string;
  deps: BoundSignatureVerifyDeps;
  now?: () => number;
}): Promise<BoundSignatureVerifyResult> {
  const headerVal = Array.isArray(input.signatureHeader)
    ? input.signatureHeader[0]
    : input.signatureHeader;
  if (typeof headerVal !== 'string' || headerVal.length === 0) {
    return fail('SIG_HEADER_MISSING', 'X-Provian-Signature header missing');
  }
  const dot = headerVal.indexOf('.');
  if (dot === -1) {
    return fail('SIG_HEADER_FORMAT', 'X-Provian-Signature must be <preimage>.<sig> (BLOCKER-4 binding required)');
  }
  const preimagePart = headerVal.slice(0, dot);
  const sigPart = headerVal.slice(dot + 1);
  if (preimagePart.length === 0 || sigPart.length === 0) {
    return fail('SIG_HEADER_FORMAT', 'X-Provian-Signature parts cannot be empty');
  }

  const preimageBytes = decodeB64u(preimagePart);
  if (!preimageBytes) {
    return fail('SIG_PREIMAGE_B64U_INVALID', 'preimage is not valid base64url');
  }

  let envelope: BoundPreimageEnvelope;
  try {
    envelope = JSON.parse(preimageBytes.toString('utf8')) as BoundPreimageEnvelope;
  } catch {
    return fail('SIG_PREIMAGE_JSON_INVALID', 'preimage is not valid JSON');
  }

  if (typeof envelope !== 'object' || envelope === null) {
    return fail('SIG_PREIMAGE_SHAPE', 'preimage must be an object');
  }
  for (const f of ['mth', 'pth', 'bh', 'jti', 'aud'] as const) {
    if (typeof envelope[f] !== 'string' || envelope[f].length === 0) {
      return fail('SIG_PREIMAGE_FIELD_MISSING', `preimage field "${f}" missing`);
    }
  }
  if (typeof envelope.iat !== 'number' || typeof envelope.exp !== 'number') {
    return fail('SIG_PREIMAGE_TS_INVALID', 'preimage iat/exp must be numbers (unix seconds)');
  }

  const nowSeconds = Math.floor((input.now ? input.now() : Date.now()) / 1000);
  if (envelope.iat > nowSeconds + MAX_SKEW_SECONDS) {
    return fail('SIG_IAT_FUTURE', 'preimage iat is in the future');
  }
  if (envelope.exp <= nowSeconds) {
    return fail('SIG_EXP_PAST', 'preimage has expired');
  }
  if (envelope.aud !== expectedAudience()) {
    return fail('SIG_AUD_MISMATCH', 'preimage aud does not match this deployment');
  }
  if (envelope.mth !== input.method) {
    return fail('SIG_METHOD_MISMATCH', 'preimage method does not match request');
  }
  // Path comparison: tolerate trailing-slash + casing differences (mirrors
  // wallet-auth.ts).
  const normPreimagePath = envelope.pth.replace(/\/+$/, '').toLowerCase();
  const normRequestPath = input.path.replace(/\/+$/, '').toLowerCase();
  if (normPreimagePath !== normRequestPath) {
    return fail('SIG_PATH_MISMATCH', 'preimage path does not match request');
  }
  const computedBodyHash = crypto.createHash('sha256').update(input.rawBody || '').digest('hex');
  if (envelope.bh !== computedBodyHash) {
    return fail('SIG_BODY_HASH_MISMATCH', 'preimage bh does not match request body');
  }

  // jti format: enforce hex / not pathological. We don't require a
  // specific length to allow client choice but reject trivially-replayable
  // values.
  if (envelope.jti.length < 16 || !/^[A-Za-z0-9_-]+$/.test(envelope.jti)) {
    return fail('SIG_JTI_INVALID', 'preimage jti must be ≥16 chars [A-Za-z0-9_-]');
  }

  // Verify P-256 signature OVER the b64url preimage bytes (not the
  // decoded JSON) - that's the only byte-stable form across canonicalisers.
  let sigBytes: Uint8Array;
  try {
    const decoded = Buffer.from(sigPart, 'base64url');
    sigBytes = new Uint8Array(decoded);
  } catch {
    return fail('SIG_SIGNATURE_B64U_INVALID', 'signature is not valid base64url');
  }
  if (sigBytes.length !== 64) {
    return fail('SIG_SIGNATURE_LENGTH', `signature length ${sigBytes.length} (expected 64)`);
  }

  // Use Node's built-in webcrypto (no ESM-only deps) to verify ECDSA-P256.
  // Webcrypto's IEEE-P1363 raw signature shape matches the SDK's
  // 64-byte (r||s) compact output exactly.
  //
  // SE/StrongBox quirk handling at this layer:
  //   1. Low-s: subtle.verify accepts both low-s and high-s, and the SDK's
  //      native modules normalize to low-s before the wire (iOS:
  //      ProvianSecureEnclaveP256.swift normalizeLowS; Android:
  //      ProvianSecureEnclaveP256Module.kt P256_HALF_ORDER check).
  //   2. DER framing: the SDK strips DER on-device and sends raw r||s, so
  //      DER never reaches this verifier. We intentionally enforce a
  //      strict 64-byte raw shape; a permissive DER fallback would mask
  //      SDK bugs and is not added.
  //   3. Public-key format: importKey 'raw' requires uncompressed
  //      04 || X || Y (65 bytes). The device registration path stores
  //      keys in this shape; conversion happens at registration, not here.
  //   4. StrongBox vs TEE parity: this code does not branch on backing.
  //      Both Android backings produce identical signatures via the same
  //      KeyStore API and verify identically here. Backing is reflected in
  //      the device's attestation_tier metadata, not in verification.
  try {
    const subtle = (crypto as unknown as { webcrypto: webcrypto.Crypto }).webcrypto.subtle;
    const pubKeyBytes = Buffer.from(input.signingPublicKeyHex, 'hex');
    const pubKey = await subtle.importKey(
      'raw',
      pubKeyBytes,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const ok = await subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pubKey,
      sigBytes,
      new TextEncoder().encode(preimagePart),
    );
    if (!ok) {
      return fail('SIG_VERIFY_FAILED', 'signature did not verify against device key');
    }
  } catch (err) {
    return fail('SIG_VERIFY_FAILED', `signature verification error: ${(err as Error).message}`);
  }

  // Consume jti - fail closed on any infrastructure failure.
  // When the Redis cache is enabled, SETNX is authoritative: a `false`
  // return means the jti was already consumed (REPLAY). We only fall
  // back to Firestore when Redis itself is disabled or errored, never
  // after a successful "this jti is taken" answer from Redis.
  const ttl = Math.max(envelope.exp - nowSeconds, 1) + NONCE_TTL_BUFFER_SECONDS;
  const nonceKey = `device_sig_nonce:${envelope.jti}`;
  const { db, cache } = input.deps;
  let consumed = false;
  let cacheBackingFailed = !cache.isEnabled();
  if (!cacheBackingFailed) {
    try {
      consumed = await cache.setNx(nonceKey, 1, ttl);
      if (!consumed) {
        // Authoritative replay answer from Redis.
        return fail('SIG_REPLAY', 'preimage jti already consumed (replay detected)');
      }
    } catch (err) {
      console.warn('[DeviceSig] Redis SETNX errored, falling back to Firestore', err);
      cacheBackingFailed = true;
    }
  }
  if (cacheBackingFailed) {
    try {
      const nonceRef = db.collection('consumed_nonces').doc(envelope.jti);
      await db.runTransaction(async (txn: Transaction) => {
        const doc = await txn.get(nonceRef);
        if (doc.exists) throw new Error('nonce_reused');
        txn.set(nonceRef, {
          consumed_at: Date.now(),
          expires_at: Date.now() + ttl * 1000,
          source: 'device_signature',
        });
      });
      consumed = true;
    } catch {
      consumed = false;
    }
  }
  if (!consumed) {
    return fail('SIG_REPLAY', 'preimage jti already consumed (replay detected)');
  }

  return { ok: true, envelope };
}

/**
 * Convenience: extract the rawBody express-json captured (if any).
 */
export function readRawBody(req: Request): string {
  const raw = req.rawBody;
  return typeof raw === 'string' ? raw : '';
}
