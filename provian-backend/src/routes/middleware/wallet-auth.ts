import { observeActorSession } from '../../core/jurisdiction/mint-compliance';
import {openPrivateAuthenticatedRequest} from '../../core/meter/private-pricing';
/**
 * Wallet Auth Token Verifier
 *
 * Shared by the canonical authenticate() / authenticateDual() middleware in
 * server.ts and by the PVT router's authenticatePVTDual middleware. Verifies
 * v2 request-bound HMAC tokens. v1 (legacy user_id/ts) tokens are refused
 * with token_v1_no_longer_supported.
 *
 * v2 token shape: payloadB64.signatureHex
 *   payload = { sub, device_id, iat, exp, jti, mth, pth, bh }
 *   signature = HMAC-SHA256(payloadB64, authSecret)
 *
 * Binding: method, full path (originalUrl, query stripped), body sha256.
 * Replay: jti consumed via Redis SETNX with Firestore fallback.
 */

import { Request } from 'express';
import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import type { RedisCache } from '../../cache';
import { isValidFirestoreDocumentId } from '../../firestore-document-id';

export const AUTH_NONCE_TTL_SECONDS = 120;
/**
 * 2026-10-17: the longest a token may still be valid for when it arrives. The app mints
 * `exp = now + 90 s`; the bound only has to cut off a captured token whose `exp` outlives the
 * jti nonce (which is also stretched to cover `exp` below). Generous enough for a phone clock
 * that runs minutes fast.
 */
export const AUTH_TOKEN_MAX_LIFETIME_MS = 15 * 60 * 1000;

export type WalletTokenResult =
  | { ok: true; userId: string; deviceId: string }
  | { ok: false; status: number; error: string };

type WalletTokenPayload = {
  sub?: string; exp?: number; jti?: string;
  mth?: string; pth?: string; bh?: string;
  device_id?: string; iat?: number;
};

export interface WalletAuthDeps {
  db: Firestore;
  cache: RedisCache;
}

export interface WalletAuthBinding {
  /** HTTP method the token is bound to. */
  method: string;
  /** Full request path (no querystring), normalised by the verifier. */
  path: string;
  /** sha256 hex of the canonical request body bytes. */
  bodyHash: string;
}

export async function verifyWalletAuthToken(
  token: string,
  req: Request,
  deps: WalletAuthDeps,
): Promise<WalletTokenResult> {
  // [Body-hash fix 2026-06-10] The client signs over the LITERAL body bytes
  // it sends (empty string for GET/no-body). req.rawBody, captured by the
  // express.json verify callback before parsing, is the source of truth for
  // those bytes. When no body was sent the callback never fires, so rawBody
  // is undefined and the canonical body is ''. The old fallback
  // `req.body ? JSON.stringify(req.body) : ''` was wrong: body-parser sets
  // req.body = {} for a bodyless request, and {} is truthy, so it hashed
  // '{}' and every GET failed with 'Token body hash mismatch' (the client
  // hashed ''). Re-serializing the parsed body is also unreliable for POSTs
  // (key reordering vs the raw bytes), so the parsed-body fallback is dropped.
  const rawBody = typeof req.rawBody === 'string' ? req.rawBody : '';
  const expectedBodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  const reqFullPath = (req.originalUrl || req.url || req.path).split('?')[0];
  const result=await verifyWalletAuthTokenWithBinding(
    token,
    {
      method: req.method,
      path: reqFullPath,
      bodyHash: expectedBodyHash,
    },
    deps,
  );
  if(result.ok&&(req.body?.private_request||req.query?.private_query)){
    try {
      const cached=await deps.cache.getUserAuthSecret(result.userId);
      const secret=cached||(await deps.db.collection('auth_secrets').doc(result.userId).get()).data()?.secret;
      openPrivateAuthenticatedRequest(req,secret);
    }catch{return {ok:false,status:400,error:'Private request could not be opened'};}
  }
  if (result.ok) await observeActorSession(deps.db, req, result.userId);
  return result;
}

/**
 * Core v2 wallet-auth verifier: validates a token against an explicitly
 * supplied method/path/body_hash binding. The middleware-bound verifier above
 * derives the binding from the Express request and delegates here.
 */
export async function verifyWalletAuthTokenWithBinding(
  token: string,
  binding: WalletAuthBinding,
  deps: WalletAuthDeps,
): Promise<WalletTokenResult> {
  const { db, cache } = deps;
  const dotIndex = token.lastIndexOf('.');
  if (dotIndex === -1) {
    return { ok: false, status: 401, error: 'Invalid token format' };
  }

  const payloadB64 = token.substring(0, dotIndex);
  const providedSignature = token.substring(dotIndex + 1);

  let payload: WalletTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString());
  } catch {
    return { ok: false, status: 400, error: 'malformed_token' };
  }

  if (!payload.sub) {
    // A v1 token carried `user_id` instead of `sub`; detect it to surface the
    // explicit upgrade error rather than a generic incomplete-payload error.
    if ((payload as { user_id?: unknown }).user_id) {
      return { ok: false, status: 401, error: 'token_v1_no_longer_supported' };
    }
    return { ok: false, status: 401, error: 'Incomplete token payload' };
  }
  if (!payload.jti || !payload.mth || !payload.pth || !payload.bh) {
    return { ok: false, status: 401, error: 'token_v1_no_longer_supported' };
  }

  const userId = payload.sub;
  const deviceId = payload.device_id;
  if (!deviceId) {
    return { ok: false, status: 401, error: 'Incomplete token payload' };
  }

  // F62: `userId` (the UNSIGNED payload `sub`, read before the HMAC is checked)
  // becomes a Firestore document path at `auth_secrets/{userId}` below.
  // `.doc(userId)` throws SYNCHRONOUSLY on a '/'; because this async verifier is
  // awaited un-wrapped by the extracted wallet-owner / pvt-dual middlewares, that
  // throw would reject uncaught and crash the process. Reject a non-document-id
  // `sub` here — at the single choke point every wallet-token caller shares —
  // BEFORE it reaches `.doc()`. A relay-minted `usr_`/`user_` id always passes.
  if (!isValidFirestoreDocumentId(userId)) {
    return { ok: false, status: 401, error: 'Invalid token subject' };
  }

  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
    // A string `exp` ("never") compared as NaN and never expired (2026-10-17).
    return { ok: false, status: 401, error: 'Token missing expiry' };
  }
  if (Date.now() > payload.exp) {
    return { ok: false, status: 401, error: 'Token expired' };
  }
  const remainingMs = payload.exp - Date.now();
  if (remainingMs > AUTH_TOKEN_MAX_LIFETIME_MS) {
    return { ok: false, status: 401, error: 'Token expiry too far ahead' };
  }

  let authSecret = await cache.getUserAuthSecret(userId);
  if (!authSecret) {
    const secretDoc = await db.collection('auth_secrets').doc(userId).get();
    if (!secretDoc.exists) {
      return { ok: false, status: 401, error: 'Auth secret not configured. Re-register device.' };
    }
    const secretData = secretDoc.data() as { secret: string };
    if (!secretData.secret) {
      return { ok: false, status: 401, error: 'Auth secret not configured. Re-register device.' };
    }
    authSecret = secretData.secret;
    cache.setUserAuthSecret(userId, authSecret).catch(() => {});
  }

  const expectedSignature = crypto
    .createHmac('sha256', authSecret)
    .update(payloadB64)
    .digest('hex');
  // A 64-char NON-hex signature decodes to a shorter buffer and made
  // timingSafeEqual throw → every wallet-auth route answered 503 to an
  // unauthenticated caller (2026-10-17). Shape first, then the compare.
  if (
    !/^[0-9a-f]{64}$/i.test(providedSignature) ||
    providedSignature.length !== expectedSignature.length ||
    !crypto.timingSafeEqual(
      Buffer.from(providedSignature, 'hex'),
      Buffer.from(expectedSignature, 'hex'),
    )
  ) {
    return { ok: false, status: 401, error: 'Invalid token signature' };
  }

  if (payload.mth !== binding.method) {
    return { ok: false, status: 401, error: 'Token method mismatch' };
  }

  const normalizedTokenPath = payload.pth.replace(/\/+$/, '').toLowerCase();
  const normalizedReqPath = binding.path.replace(/\/+$/, '').toLowerCase();
  if (normalizedTokenPath !== normalizedReqPath) {
    return { ok: false, status: 401, error: 'Token path mismatch' };
  }

  if (payload.bh !== binding.bodyHash) {
    return { ok: false, status: 401, error: 'Token body hash mismatch' };
  }

  // jti replay: Redis SETNX with Firestore fallback when Redis is disabled.
  const nonceKey = `nonce:${payload.jti}`;
  // The consumed jti outlives the token: a replay after the nonce lapsed but before `exp`
  // was accepted before 2026-10-17.
  const nonceTtlSeconds = Math.max(AUTH_NONCE_TTL_SECONDS, Math.ceil(remainingMs / 1000) + 30);
  let nonceAccepted = false;
  if (cache.isEnabled()) {
    nonceAccepted = await cache.setNx(nonceKey, 1, nonceTtlSeconds);
  } else {
    const nonceRef = db.collection('consumed_nonces').doc(payload.jti);
    try {
      await db.runTransaction(async (txn) => {
        const doc = await txn.get(nonceRef);
        if (doc.exists) {
          throw new Error('nonce_reused');
        }
        txn.set(nonceRef, {
          consumed_at: Date.now(),
          expires_at: Date.now() + nonceTtlSeconds * 1000,
        });
      });
      nonceAccepted = true;
    } catch {
      nonceAccepted = false;
    }
  }
  if (!nonceAccepted) {
    return { ok: false, status: 401, error: 'Token already used (replay detected)' };
  }

  return { ok: true, userId, deviceId };
}
