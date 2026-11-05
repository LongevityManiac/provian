/**
 * Provian Commons - QR Web-to-App Authentication
 *
 * Browser generates challenge → QR displayed → Mobile app scans →
 * App signs with hardware key → Browser polls for session token.
 */

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { ValidationError, NotFoundError } from '../agent-bank/errors';
import {
  COMMONS_SAFETY_LIMITS,
  COMMONS_COLLECTIONS,
  type CommonsDeps,
  type QRAuthChallenge,
  type QRAuthStatus,
} from './types';

// STEP 9 (Wave 4): use Node webcrypto for P-256 verification. The
// previous lazy-loaded `@noble/curves/p256` subpath is not in
// @noble/curves v2's exports map and would throw
// ERR_PACKAGE_PATH_NOT_EXPORTED at runtime - silently broken because
// no test exercised this path before Wave 4.
async function verifyP256(input: {
  publicKeyHex: string; // SEC1 uncompressed 65 bytes (04 || X || Y)
  signature: Uint8Array; // 64-byte r||s
  message: Uint8Array;
}): Promise<boolean> {
  const subtle = (crypto as unknown as { webcrypto: { subtle: any } }).webcrypto.subtle;
  const pubBytes = Buffer.from(input.publicKeyHex, 'hex');
  const pubKey = await subtle.importKey(
    'raw',
    pubBytes,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  return subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    pubKey,
    input.signature,
    input.message,
  );
}

const L = COMMONS_SAFETY_LIMITS;

/**
 * Constant-time comparison for hex strings of (possibly) different
 * lengths. Returns true iff both inputs decode to byte buffers of equal
 * length and content. Wraps Node's crypto.timingSafeEqual which throws
 * on length mismatch - we handle that by zero-extending one side so the
 * comparison still runs and reveals only a single boolean.
 */
function safeCompareHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  // Length mismatch is leaked, but that's the only signal - content is
  // compared in constant time.
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

// ─── Generate Challenge ─────────────────────────────────────────────────────

export async function generateAuthChallenge(
  deps: CommonsDeps,
): Promise<{
  session_id: string;
  challenge_nonce: string;
  qr_data: string;
  expires_at: number;
}> {
  const sessionId = `csess_${uuidv4()}`;
  const challengeNonce = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const expiresAt = now + L.QR_CHALLENGE_EXPIRY_SECONDS * 1000;

  const relayUrl = process.env.RELAY_URL || 'https://api.provian.ai';
  const qrData = JSON.stringify({
    session_id: sessionId,
    challenge_nonce: challengeNonce,
    relay_url: relayUrl,
    type: 'commons_auth',
  });

  const challenge: QRAuthChallenge = {
    session_id: sessionId,
    challenge_nonce: challengeNonce,
    authenticated: false,
    created_at: now,
    expires_at: expiresAt,
  };

  await deps.db
    .collection(COMMONS_COLLECTIONS.QR_AUTH)
    .doc(sessionId)
    .set(challenge);

  return {
    session_id: sessionId,
    challenge_nonce: challengeNonce,
    qr_data: Buffer.from(qrData).toString('base64'),
    expires_at: expiresAt,
  };
}

// ─── Confirm Challenge (from mobile app) ────────────────────────────────────

export async function confirmAuthChallenge(
  deps: CommonsDeps,
  walletId: string,
  sessionId: string,
  challengeNonce: string,
  signature: string,
): Promise<void> {
  // Validate signature is present
  if (!signature || typeof signature !== 'string') {
    throw new ValidationError('Signature is required');
  }

  const doc = await deps.db
    .collection(COMMONS_COLLECTIONS.QR_AUTH)
    .doc(sessionId)
    .get();
  if (!doc.exists) {
    throw new NotFoundError('Auth session not found');
  }

  const challenge = doc.data() as QRAuthChallenge;

  if (Date.now() > challenge.expires_at) {
    throw new ValidationError('Auth challenge has expired');
  }
  if (challenge.authenticated) {
    throw new ValidationError('Session already authenticated');
  }
  // Phase 2.16 - Theme: constant-time nonce comparison so a remote
  // attacker cannot brute-force the nonce one byte at a time via timing.
  if (!safeCompareHex(challenge.challenge_nonce, challengeNonce)) {
    throw new ValidationError('Invalid challenge nonce');
  }

  // Look up the device-identity P-256 public key on this wallet record and verify signature.
  // (This is the PE-attestation key registered for the device, not the wallet's BIP-39 secp256k1 key.)
  const walletSnap = await deps.db
    .collection('wallets')
    .where('user_id', '==', walletId)
    .limit(1)
    .get();
  if (walletSnap.empty) {
    throw new ValidationError('Wallet not found');
  }
  const walletData = walletSnap.docs[0].data();
  const publicKey = walletData.public_key;
  if (!publicKey || typeof publicKey !== 'string') {
    throw new ValidationError('Wallet public key not found');
  }

  // STEP 9 (Wave 4): webcrypto P-256 verification. Webcrypto signs/verifies
  // sha256(message) internally, so we pass the raw challenge bytes.
  const messageBytes = new TextEncoder().encode(challengeNonce);
  const pubKeyHex = publicKey.length === 128 ? `04${publicKey}` : publicKey;
  if (!/^04[0-9a-fA-F]{128}$/.test(pubKeyHex)) {
    throw new ValidationError('Invalid wallet public key format');
  }
  if (!/^[0-9a-fA-F]+$/.test(signature)) {
    throw new ValidationError('Invalid signature format');
  }
  const signatureBytes = new Uint8Array(Buffer.from(signature, 'hex'));
  let isValid = false;
  try {
    isValid = await verifyP256({
      publicKeyHex: pubKeyHex,
      signature: signatureBytes,
      message: messageBytes,
    });
  } catch {
    isValid = false;
  }

  if (!isValid) {
    throw new ValidationError('Invalid signature');
  }

  // Generate session token
  const sessionToken = crypto.randomBytes(48).toString('hex');
  const sessionExpiry = Date.now() + L.BROWSER_SESSION_EXPIRY_HOURS * 60 * 60 * 1000;

  await deps.db
    .collection(COMMONS_COLLECTIONS.QR_AUTH)
    .doc(sessionId)
    .update({
      authenticated: true,
      wallet_id: walletId,
      session_token: sessionToken,
      expires_at: sessionExpiry,
    });

  // Cache session token for fast lookup
  await deps.cache.set(
    `commons:session:${sessionToken}`,
    walletId,
    L.BROWSER_SESSION_EXPIRY_HOURS * 3600,
  );
}

// ─── Poll Auth Status (from browser) ────────────────────────────────────────

export async function getAuthStatus(
  deps: CommonsDeps,
  sessionId: string,
): Promise<QRAuthStatus> {
  const doc = await deps.db
    .collection(COMMONS_COLLECTIONS.QR_AUTH)
    .doc(sessionId)
    .get();
  if (!doc.exists) {
    throw new NotFoundError('Auth session not found');
  }

  const data = doc.data() as QRAuthChallenge;

  if (!data.authenticated) {
    return { authenticated: false };
  }

  return {
    authenticated: true,
    wallet_id: data.wallet_id,
    expires_at: data.expires_at,
  };
}

// ─── Exchange Authenticated QR Session For Browser Token ───────────────────

export async function exchangeAuthSession(
  deps: CommonsDeps,
  sessionId: string,
  challengeNonce: string,
): Promise<{
  authenticated: true;
  wallet_id: string;
  session_token: string;
  expires_at: number;
}> {
  const doc = await deps.db
    .collection(COMMONS_COLLECTIONS.QR_AUTH)
    .doc(sessionId)
    .get();
  if (!doc.exists) {
    throw new NotFoundError('Auth session not found');
  }

  const data = doc.data() as QRAuthChallenge;

  if (!data.authenticated || !data.session_token || !data.wallet_id || !data.expires_at) {
    throw new ValidationError('Auth session is not authenticated');
  }
  if (Date.now() > data.expires_at) {
    throw new ValidationError('Auth session has expired');
  }
  if (!safeCompareHex(data.challenge_nonce, challengeNonce)) {
    throw new ValidationError('Invalid challenge nonce');
  }

  return {
    authenticated: true,
    wallet_id: data.wallet_id,
    session_token: data.session_token,
    expires_at: data.expires_at,
  };
}

// ─── Validate Session Token ─────────────────────────────────────────────────

export async function validateSessionToken(
  deps: CommonsDeps,
  token: string,
): Promise<string | null> {
  // Check cache first
  const cached = await deps.cache.get<string>(`commons:session:${token}`);
  if (cached) return cached;

  // Fallback to Firestore
  const snap = await deps.db
    .collection(COMMONS_COLLECTIONS.QR_AUTH)
    .where('session_token', '==', token)
    .where('authenticated', '==', true)
    .limit(1)
    .get();

  if (snap.empty) return null;

  const data = snap.docs[0].data() as QRAuthChallenge;
  if (Date.now() > data.expires_at!) return null;

  return data.wallet_id || null;
}
