/**
 * agent-key-recovery — the non-custodial sealed box that lets an agent escrow a
 * recoverable copy of its own wallet key WITHOUT the relay ever holding anything
 * it can decrypt.
 *
 * The two-touch onboarding needs a fund-bearing agent wallet that (a) is created
 * with no operator passphrase and (b) survives the loss of the agent's machine.
 * The design : the INVITING HUMAN's phone is the recovery
 * custodian. At "Invite an agent" (touch 1) the phone mints an x25519 *anchor*
 * keypair, keeps the secret half in its own cloud-backed keychain, and publishes
 * the PUBLIC half inside the one copied command. The agent seals a copy of its
 * secp256k1 private key TO that anchor public key and escrows only the resulting
 * ciphertext to the relay. The relay stores an opaque blob; only the phone's
 * anchor secret can open it. Provian is never custodial: it holds ciphertext,
 * not a key and not anything readable.
 *
 * Wire format (version 0x01):
 * blob = 0x01 || ephemeral_x25519_pubkey(32) || xchacha20poly1305_ciphertext(+16 tag)
 * The 32-byte key and 24-byte nonce are HKDF-SHA256 derived from the x25519
 * shared secret salted with (ephemeral_pubkey || anchor_pubkey), so every seal
 * uses a fresh ephemeral key and therefore a fresh nonce — no reuse. The AEAD
 * AAD binds the version + anchor pubkey so a blob cannot be replayed against a
 * different anchor.
 *
 * This module is intentionally byte-identical to the mobile app's copy
 * (src/core/agents/agentKeyRecovery.ts): both are built on @noble primitives so
 * a blob sealed here (Node) opens on the phone (React Native) and vice versa.
 * The pinned cross-environment vector in the test suites guards that parity — if
 * you change anything here, change both and re-pin the vector.
 */

import { x25519 } from '@noble/curves/ed25519';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes as nobleRandomBytes } from '@noble/hashes/utils';
import { base64urlnopad } from '@scure/base';

export const RECOVERY_BLOB_VERSION = 0x01;
const HKDF_INFO = new TextEncoder().encode('provian-agent-recovery-v1');
const AEAD_KEY_LEN = 32;
const XCHACHA_NONCE_LEN = 24;
const X25519_KEY_LEN = 32;

export interface AnchorKeyPair {
  /** 32-byte x25519 secret — stays on the human's phone, never leaves it plaintext. */
  secretKey: Uint8Array;
  /** 32-byte x25519 public — rides the one command; safe to publish. */
  publicKey: Uint8Array;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function deriveKeyAndNonce(
  shared: Uint8Array,
  ephemeralPub: Uint8Array,
  anchorPub: Uint8Array,
): { key: Uint8Array; nonce: Uint8Array } {
  const salt = concatBytes(ephemeralPub, anchorPub);
  const okm = hkdf(sha256, shared, salt, HKDF_INFO, AEAD_KEY_LEN + XCHACHA_NONCE_LEN);
  return {
    key: okm.slice(0, AEAD_KEY_LEN),
    nonce: okm.slice(AEAD_KEY_LEN, AEAD_KEY_LEN + XCHACHA_NONCE_LEN),
  };
}

function aeadAad(anchorPub: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(RECOVERY_BLOB_VERSION), anchorPub);
}

/**
 * Mint a fresh anchor keypair. Called on the human's phone at invite time. The
 * caller is responsible for persisting `secretKey` in device-secure, cloud-
 * backed storage and for never transmitting it.
 */
export function generateAnchorKeyPair(
  randomBytes: (n: number) => Uint8Array = nobleRandomBytes,
): AnchorKeyPair {
  const secretKey = randomBytes(X25519_KEY_LEN);
  const publicKey = x25519.getPublicKey(secretKey);
  return { secretKey, publicKey };
}

/**
 * Seal `plaintext` (the agent's secp256k1 private key bytes) to the anchor
 * public key. Runs on the agent's machine. Returns the opaque blob to escrow.
 */
export function sealToAnchor(
  anchorPublicKey: Uint8Array,
  plaintext: Uint8Array,
  randomBytes: (n: number) => Uint8Array = nobleRandomBytes,
): Uint8Array {
  if (anchorPublicKey.length !== X25519_KEY_LEN) {
    throw new Error(`anchor public key must be ${X25519_KEY_LEN} bytes`);
  }
  const ephemeralSecret = randomBytes(X25519_KEY_LEN);
  const ephemeralPublic = x25519.getPublicKey(ephemeralSecret);
  const shared = x25519.getSharedSecret(ephemeralSecret, anchorPublicKey);
  const { key, nonce } = deriveKeyAndNonce(shared, ephemeralPublic, anchorPublicKey);
  const ciphertext = xchacha20poly1305(key, nonce, aeadAad(anchorPublicKey)).encrypt(plaintext);
  return concatBytes(Uint8Array.of(RECOVERY_BLOB_VERSION), ephemeralPublic, ciphertext);
}

/**
 * Open a blob with the anchor secret key. Runs ONLY on the human's phone.
 * Throws (fail-closed) on wrong key, tamper, or malformed blob.
 */
export function openWithAnchor(anchorSecretKey: Uint8Array, blob: Uint8Array): Uint8Array {
  if (anchorSecretKey.length !== X25519_KEY_LEN) {
    throw new Error(`anchor secret key must be ${X25519_KEY_LEN} bytes`);
  }
  if (blob.length < 1 + X25519_KEY_LEN + 16) {
    throw new Error('recovery blob is too short');
  }
  if (blob[0] !== RECOVERY_BLOB_VERSION) {
    throw new Error(`unsupported recovery blob version ${blob[0]}`);
  }
  const ephemeralPublic = blob.slice(1, 1 + X25519_KEY_LEN);
  const ciphertext = blob.slice(1 + X25519_KEY_LEN);
  const anchorPublic = x25519.getPublicKey(anchorSecretKey);
  const shared = x25519.getSharedSecret(anchorSecretKey, ephemeralPublic);
  const { key, nonce } = deriveKeyAndNonce(shared, ephemeralPublic, anchorPublic);
  return xchacha20poly1305(key, nonce, aeadAad(anchorPublic)).decrypt(ciphertext);
}

/** base64url(no pad) for carrying keys/blobs in JSON + URLs. */
export function toB64u(bytes: Uint8Array): string {
  return base64urlnopad.encode(bytes);
}

export function fromB64u(s: string): Uint8Array {
  return base64urlnopad.decode(s);
}
