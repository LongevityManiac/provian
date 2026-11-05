/**
 * PE METER — the relay seals a PE it authored to its owner (and the owner's linked human) so the
 * relay never keeps a readable copy. Byte-compatible with the SDK's and the app's sealed box
 * (`provian-agent-sdk/src/agent-key-recovery.ts` `sealToAnchor` / `openWithAnchor`, also used by
 * thread messages): a box the relay seals opens with the recipient's message key on the phone or
 * the daemon. The construction, built here from Node's own primitives:
 *
 *   ephemeral x25519 keypair; shared = X25519(eph_secret, recipient_pub)
 *   okm = HKDF-SHA256(ikm = shared, salt = eph_pub ‖ recipient_pub, info = "provian-agent-recovery-v1", 56)
 *   key = okm[0..32], nonce = okm[32..56]                       (XChaCha20-Poly1305, 24-byte nonce)
 *   aad = 0x01 ‖ recipient_pub
 *   box = 0x01 ‖ eph_pub ‖ ciphertext ‖ tag
 *
 * Node has IETF ChaCha20-Poly1305 (12-byte nonce) but not the X variant; XChaCha20-Poly1305 is
 * exactly ChaCha20-Poly1305 under the subkey HChaCha20(key, nonce[0..16]) with the 12-byte nonce
 * 0x00000000 ‖ nonce[16..24], so HChaCha20 is the one function written out here. A pinned vector
 * produced by the SDK's implementation keeps the two identical.
 */

import crypto from 'crypto';

const VERSION = 0x01;
const INFO = Buffer.from('provian-agent-recovery-v1', 'utf8');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

function rotl(v: number, n: number): number {
  return ((v << n) | (v >>> (32 - n))) >>> 0;
}

/** HChaCha20: the ChaCha20 core over (constants, key, 16-byte nonce), keeping words 0–3 and 12–15. */
export function hchacha20(key: Uint8Array, nonce16: Uint8Array): Buffer {
  if (key.length !== 32 || nonce16.length !== 16) throw new Error('hchacha20_bad_input');
  const s = new Uint32Array(16);
  s[0] = 0x61707865; s[1] = 0x3320646e; s[2] = 0x79622d32; s[3] = 0x6b206574;
  const k = Buffer.from(key);
  const n = Buffer.from(nonce16);
  for (let i = 0; i < 8; i += 1) s[4 + i] = k.readUInt32LE(i * 4);
  for (let i = 0; i < 4; i += 1) s[12 + i] = n.readUInt32LE(i * 4);
  const qr = (a: number, b: number, c: number, d: number): void => {
    s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 16);
    s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 12);
    s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 8);
    s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 7);
  };
  for (let round = 0; round < 10; round += 1) {
    qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15);
    qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14);
  }
  const out = Buffer.alloc(32);
  [0, 1, 2, 3, 12, 13, 14, 15].forEach((word, i) => out.writeUInt32LE(s[word], i * 4));
  return out;
}

function xchachaEncrypt(key: Uint8Array, nonce24: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Buffer {
  const subkey = hchacha20(key, nonce24.subarray(0, 16));
  const nonce12 = Buffer.concat([Buffer.alloc(4), Buffer.from(nonce24.subarray(16, 24))]);
  const cipher = crypto.createCipheriv('chacha20-poly1305', subkey, nonce12, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad), { plaintextLength: plaintext.length });
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  return Buffer.concat([ct, cipher.getAuthTag()]);
}

function xchachaDecrypt(key: Uint8Array, nonce24: Uint8Array, aad: Uint8Array, sealed: Uint8Array): Buffer {
  if (sealed.length < 16) throw new Error('sealed_box_too_short');
  const subkey = hchacha20(key, nonce24.subarray(0, 16));
  const nonce12 = Buffer.concat([Buffer.alloc(4), Buffer.from(nonce24.subarray(16, 24))]);
  const decipher = crypto.createDecipheriv('chacha20-poly1305', subkey, nonce12, { authTagLength: 16 });
  const body = Buffer.from(sealed.subarray(0, sealed.length - 16));
  decipher.setAAD(Buffer.from(aad), { plaintextLength: body.length });
  decipher.setAuthTag(Buffer.from(sealed.subarray(sealed.length - 16)));
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

export function x25519PublicOf(secret: Uint8Array): Buffer {
  const priv = crypto.createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, Buffer.from(secret)]), format: 'der', type: 'pkcs8' });
  const spki = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }) as Buffer;
  return spki.subarray(spki.length - 32);
}

function x25519Shared(secret: Uint8Array, peerPublic: Uint8Array): Buffer {
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, Buffer.from(secret)]), format: 'der', type: 'pkcs8' });
  const publicKey = crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(peerPublic)]), format: 'der', type: 'spki' });
  return crypto.diffieHellman({ privateKey, publicKey });
}

function keyAndNonce(shared: Uint8Array, ephPub: Uint8Array, recipientPub: Uint8Array): { key: Buffer; nonce: Buffer } {
  const okm = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([ephPub, recipientPub]), INFO, 56));
  return { key: okm.subarray(0, 32), nonce: okm.subarray(32, 56) };
}

/** Seal `plaintext` to an x25519 public key. `ephemeralSecret` is for test vectors only. */
export function sealToKey(recipientPublic: Uint8Array, plaintext: Uint8Array, ephemeralSecret?: Uint8Array): Buffer {
  if (recipientPublic.length !== 32) throw new Error('recipient_public_key_must_be_32_bytes');
  const ephSecret = ephemeralSecret ?? crypto.randomBytes(32);
  const ephPub = x25519PublicOf(ephSecret);
  const shared = x25519Shared(ephSecret, recipientPublic);
  const { key, nonce } = keyAndNonce(shared, ephPub, recipientPublic);
  const aad = Buffer.concat([Buffer.from([VERSION]), Buffer.from(recipientPublic)]);
  return Buffer.concat([Buffer.from([VERSION]), ephPub, xchachaEncrypt(key, nonce, aad, plaintext)]);
}

/** Open a box with the recipient's x25519 secret (tests and tooling; the relay never holds one). */
export function openWithKey(recipientSecret: Uint8Array, box: Uint8Array): Buffer {
  if (box.length < 1 + 32 + 16 || box[0] !== VERSION) throw new Error('sealed_box_malformed');
  const ephPub = box.subarray(1, 33);
  const recipientPub = x25519PublicOf(recipientSecret);
  const shared = x25519Shared(recipientSecret, ephPub);
  const { key, nonce } = keyAndNonce(shared, ephPub, recipientPub);
  const aad = Buffer.concat([Buffer.from([VERSION]), recipientPub]);
  return xchachaDecrypt(key, nonce, aad, box.subarray(33));
}

export function toB64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function fromB64u(text: string): Buffer {
  return Buffer.from(text, 'base64url');
}
