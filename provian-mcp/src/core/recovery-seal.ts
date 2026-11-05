/**
 * recovery-seal — seal an agent's wallet key to its recovering human's phone anchor,
 * with node:crypto ONLY, byte-for-byte the SDK's `sealToAnchor` (provian-agent-sdk/src/agent-key-recovery.ts,
 * itself byte-identical to the app's copy). A pinned vector in recovery-seal.test.ts holds the three equal.
 *
 * SHARED CORE — canonical in `provian-mcp/src/core/`, mirrored into `provian-backend/src/mcp/core/`
 * by scripts/sync-mcp-core.sh. The relay's mirror never CALLS this with a key: the hosted endpoint
 * holds no key, so in remote mode a hosted agent seals in its own runtime by the recipe below and
 * sends only the ciphertext. Local stdio mode seals in-process with the local identity's key.
 *
 * Wire format (version 0x01):
 * blob = 0x01 ‖ ephemeral_x25519_pub(32) ‖ XChaCha20-Poly1305(key, nonce, aad, privkey32) (‖ 16-byte tag)
 * shared = X25519(ephemeral_secret, anchor_pub)
 * okm = HKDF-SHA256(ikm = shared, salt = ephemeral_pub ‖ anchor_pub, info = "provian-agent-recovery-v1", 56)
 * key = okm[0..32), nonce = okm[32..56)
 * aad = 0x01 ‖ anchor_pub
 * XChaCha20-Poly1305 = ChaCha20-Poly1305 (IETF) under subkey HChaCha20(key, nonce[0..16)) with the
 * 12-byte nonce 0x00000000 ‖ nonce[16..24) — the construction libsodium and @noble/ciphers use.
 */

import {
  createCipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  randomBytes as nodeRandomBytes,
} from 'node:crypto';

export const RECOVERY_SEAL_VERSION = 0x01;
const HKDF_INFO = Buffer.from('provian-agent-recovery-v1', 'utf8');
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

/** The recipe a hosted agent follows in its own runtime (served in the MCP tool descriptions). */
export const RECOVERY_SEAL_RECIPE = {
  plaintext: 'your 32-byte secp256k1 private key (raw bytes, not hex text)',
  anchor: 'recovery_anchor_pubkey: base64url (no padding) of a 32-byte X25519 public key',
  steps: [
    'eph_secret = 32 random bytes; eph_pub = X25519 public key of eph_secret',
    'shared = X25519(eph_secret, anchor)',
    'okm = HKDF-SHA256(ikm=shared, salt=eph_pub||anchor, info=UTF-8 "provian-agent-recovery-v1", length=56); key = okm[0:32], nonce = okm[32:56]',
    'aad = 0x01 || anchor',
    'ct = XChaCha20-Poly1305(key, nonce, aad).encrypt(private_key) — ciphertext followed by the 16-byte tag (libsodium crypto_aead_xchacha20poly1305_ietf_encrypt)',
    'sealed_key_blob = base64url-nopad(0x01 || eph_pub || ct)  (81 bytes → 108 characters)',
  ],
  never: 'Never send the private key itself, to any tool. Only sealed_key_blob leaves your runtime.',
} as const;

function b64uDecode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('not base64url');
  return Buffer.from(value, 'base64url');
}

function rotl(v: number, n: number): number {
  return ((v << n) | (v >>> (32 - n))) >>> 0;
}

/** HChaCha20(key32, nonce16) → 32-byte subkey (RFC draft-irtf-cfrg-xchacha §2.2). */
export function hchacha20(key: Buffer, nonce16: Buffer): Buffer {
  if (key.length !== 32 || nonce16.length !== 16) throw new Error('hchacha20: key 32 / nonce 16 bytes');
  const s = new Uint32Array(16);
  s[0] = 0x61707865; s[1] = 0x3320646e; s[2] = 0x79622d32; s[3] = 0x6b206574;
  for (let i = 0; i < 8; i += 1) s[4 + i] = key.readUInt32LE(i * 4);
  for (let i = 0; i < 4; i += 1) s[12 + i] = nonce16.readUInt32LE(i * 4);
  const qr = (a: number, b: number, c: number, d: number) => {
    s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 16);
    s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 12);
    s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 8);
    s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 7);
  };
  for (let i = 0; i < 10; i += 1) {
    qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15);
    qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14);
  }
  const out = Buffer.alloc(32);
  [0, 1, 2, 3, 12, 13, 14, 15].forEach((w, i) => out.writeUInt32LE(s[w], i * 4));
  return out;
}

export function xchacha20poly1305Encrypt(key: Buffer, nonce24: Buffer, aad: Buffer, plaintext: Buffer): Buffer {
  if (nonce24.length !== 24) throw new Error('xchacha20poly1305: nonce must be 24 bytes');
  const subkey = hchacha20(key, nonce24.subarray(0, 16));
  const nonce12 = Buffer.concat([Buffer.alloc(4), nonce24.subarray(16, 24)]);
  const cipher = createCipheriv('chacha20-poly1305', subkey, nonce12, { authTagLength: 16 });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([ct, cipher.getAuthTag()]);
}

/**
 * Seal `privateKeyHex` (32-byte secp256k1 key, hex) to `anchorPubkeyB64u`. Returns the base64url
 * sealed blob the relay stores as `sealed_key_blob`. `ephemeralSecret` is a test seam (pinned vector).
 */
export function sealToRecoveryAnchor(
  anchorPubkeyB64u: string,
  privateKeyHex: string,
  ephemeralSecret: Buffer = nodeRandomBytes(32),
): string {
  const anchor = b64uDecode(anchorPubkeyB64u);
  if (anchor.length !== 32) throw new Error('recovery anchor must be a 32-byte X25519 public key');
  const keyHex = privateKeyHex.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) throw new Error('private key must be 32 bytes of hex');
  if (ephemeralSecret.length !== 32) throw new Error('ephemeral secret must be 32 bytes');
  const ephPrivate = createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, ephemeralSecret]), format: 'der', type: 'pkcs8' });
  const ephPub = Buffer.from(createPublicKey(ephPrivate).export({ format: 'der', type: 'spki' })).subarray(-32);
  const anchorKey = createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, anchor]), format: 'der', type: 'spki' });
  const shared = diffieHellman({ privateKey: ephPrivate, publicKey: anchorKey });
  const okm = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephPub, anchor]), HKDF_INFO, 56));
  const aad = Buffer.concat([Buffer.of(RECOVERY_SEAL_VERSION), anchor]);
  const ct = xchacha20poly1305Encrypt(okm.subarray(0, 32), okm.subarray(32, 56), aad, Buffer.from(keyHex, 'hex'));
  return Buffer.concat([Buffer.of(RECOVERY_SEAL_VERSION), ephPub, ct]).toString('base64url');
}
