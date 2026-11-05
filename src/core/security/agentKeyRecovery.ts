/**
 * agentKeyRecovery (mobile mirror) — the phone side of the non-custodial sealed
 * box that makes an invited agent's wallet recoverable through the inviting
 * human WITHOUT the relay ever holding anything it can decrypt.
 *
 * Custody model : the inviting human's phone is the agent's
 * key-recovery custodian. At "Invite an agent" (touch 1) this module mints an
 * x25519 anchor keypair; the SECRET half is persisted ONLY as seed-wrapped
 * AEAD ciphertext in the same cloud-backed store as the human's own wallet
 * backup (recover your phone → restore the wallet → your agent anchors come
 * back; see agentAnchorStore), and the PUBLIC half rides the one copied command. The
 * agent seals a copy of its secp256k1 key to that public half and escrows only
 * the ciphertext to the relay. When an agent machine dies, THIS module opens the
 * escrowed blob with the anchor secret so the human can re-provision the wallet.
 *
 * This is the byte-identical mirror of the SDK module
 * (provian-agent-sdk/src/agent-key-recovery.ts). The crypto core is the SAME
 * @noble primitives so a blob sealed by the Node SDK opens here in React Native.
 * The ONLY difference is base64url is inlined below (rather than @scure/base) to
 * keep the RN bundle's dependency surface minimal; the wire bytes are identical.
 * The pinned cross-environment vector in the test suites guards the parity — if
 * you change the wire format here, change the SDK module and re-pin BOTH vectors
 * in the same commit, or the phone will no longer open the agent's escrow (an
 * unrecoverable wallet).
 */

import { x25519 } from '@noble/curves/ed25519';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, randomBytes as nobleRandomBytes } from '@noble/hashes/utils';

export const RECOVERY_BLOB_VERSION = 0x01;
const HKDF_INFO = new TextEncoder().encode('provian-agent-recovery-v1');
const AEAD_KEY_LEN = 32;
const XCHACHA_NONCE_LEN = 24;
const X25519_KEY_LEN = 32;

export interface AnchorKeyPair {
  /** 32-byte x25519 secret — stays on this phone, persisted only in secure cloud-backed storage. */
  secretKey: Uint8Array;
  /** 32-byte x25519 public — safe to publish inside the one copied command. */
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
 * Mint a fresh anchor keypair on the phone at invite time. Persist `secretKey`
 * in secure cloud-backed storage; never transmit it.
 */
export function generateAnchorKeyPair(
  randomBytes: (n: number) => Uint8Array = nobleRandomBytes,
): AnchorKeyPair {
  const secretKey = randomBytes(X25519_KEY_LEN);
  const publicKey = x25519.getPublicKey(secretKey);
  return { secretKey, publicKey };
}

/** Present for symmetry/testing; in production the SDK seals, the phone opens. */
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
 * The anchor's public key, derived once per secret (opening a mailbox backlog opens thousands of
 * boxes with one secret; deriving it again each time doubled the cost of every open). Keyed by the
 * secret array and checked against a hash of its bytes (never a copy of the secret), so a secret
 * wiped or changed in place is derived afresh; held weakly, so a dropped secret takes its entry.
 */
const anchorPublicCache = new WeakMap<Uint8Array, { readonly tag: string; readonly pub: Uint8Array }>();

function anchorPublicOf(secret: Uint8Array): Uint8Array {
  const tag = bytesToHex(sha256(secret));
  const hit = anchorPublicCache.get(secret);
  if (hit !== undefined && hit.tag === tag) return hit.pub;
  const pub = x25519.getPublicKey(secret);
  anchorPublicCache.set(secret, { tag, pub });
  return pub;
}

/**
 * Open an escrowed blob with the phone's anchor secret. Fail-closed (throws) on
 * wrong key, tamper, or malformed blob.
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
  const anchorPublic = anchorPublicOf(anchorSecretKey);
  const shared = x25519.getSharedSecret(anchorSecretKey, ephemeralPublic);
  const { key, nonce } = deriveKeyAndNonce(shared, ephemeralPublic, anchorPublic);
  return xchacha20poly1305(key, nonce, aeadAad(anchorPublic)).decrypt(ciphertext);
}

// --- base64url (no pad), inlined to keep the RN bundle dependency-light. ---
// Byte-identical to @scure/base's base64urlnopad, which the SDK mirror uses.

const B64U_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function toB64u(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64U_ALPHABET[(n >> 18) & 63] + B64U_ALPHABET[(n >> 12) & 63]
      + B64U_ALPHABET[(n >> 6) & 63] + B64U_ALPHABET[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += B64U_ALPHABET[(n >> 18) & 63] + B64U_ALPHABET[(n >> 12) & 63];
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64U_ALPHABET[(n >> 18) & 63] + B64U_ALPHABET[(n >> 12) & 63]
      + B64U_ALPHABET[(n >> 6) & 63];
  }
  return out;
}

export function fromB64u(s: string): Uint8Array {
  const lookup = (ch: string): number => {
    const idx = B64U_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('invalid base64url character');
    return idx;
  };
  const bytes: number[] = [];
  let i = 0;
  for (; i + 4 <= s.length; i += 4) {
    const n = (lookup(s[i]) << 18) | (lookup(s[i + 1]) << 12)
      | (lookup(s[i + 2]) << 6) | lookup(s[i + 3]);
    bytes.push((n >> 16) & 255, (n >> 8) & 255, n & 255);
  }
  const rem = s.length - i;
  if (rem === 2) {
    const n = (lookup(s[i]) << 18) | (lookup(s[i + 1]) << 12);
    bytes.push((n >> 16) & 255);
  } else if (rem === 3) {
    const n = (lookup(s[i]) << 18) | (lookup(s[i + 1]) << 12) | (lookup(s[i + 2]) << 6);
    bytes.push((n >> 16) & 255, (n >> 8) & 255);
  } else if (rem === 1) {
    throw new Error('invalid base64url length');
  }
  return Uint8Array.from(bytes);
}
