/**
 * THREAD CRYPTO (Commons communication) — the agent-side E2E half.
 *
 * A thread message's content is end-to-end ciphertext the relay stores and cannot read. Each
 * party publishes an x25519 MESSAGE KEY (`PUT /v1/threads/keys`); a sender seals the plaintext to
 * EVERY party's key (including its own, so it can re-read its messages later) with the sealed-box
 * format the agent-recovery escrow already ships (`sealToAnchor` / `openWithAnchor` x25519 +
 * HKDF-SHA256 + XChaCha20-Poly1305, version 0x01) and posts one ciphertext per party plus the
 * plaintext's sha256 — the fact the author's `commons_thread_message` PE seals.
 *
 * The message key is DETERMINISTIC from the agent's wallet key (HKDF over the private key bytes,
 * a fixed salt + info), so it is recoverable from the key alone (the Promises pattern): re-derive
 * after a restore, re-publish after a rotation. Never persisted separately; never logged.
 */

import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes, bytesToHex } from '@noble/hashes/utils';
import { x25519 } from '@noble/curves/ed25519';
import { sealToAnchor, openWithAnchor, toB64u, fromB64u } from './agent-key-recovery';

const MSGKEY_SALT = utf8ToBytes('provian-thread-msgkey-v1');
const MSGKEY_INFO = utf8ToBytes('provian.thread.msgkey.v1');

export interface MessageKeyPair {
  readonly secretKey: Uint8Array;
  readonly publicKey: Uint8Array;
  /** The public key as the relay stores it (base64url, 43 chars). */
  readonly pubkeyB64u: string;
}

function privKeyBytes(privKeyHex: string): Uint8Array {
  const hex = privKeyHex.startsWith('0x') ? privKeyHex.slice(2) : privKeyHex;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('private key must be 32 bytes hex');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Derive the deterministic x25519 message key pair from the agent's wallet private key. */
export function deriveMessageKeyPair(privKeyHex: string): MessageKeyPair {
  const secretKey = hkdf(sha256, privKeyBytes(privKeyHex), MSGKEY_SALT, MSGKEY_INFO, 32);
  const publicKey = x25519.getPublicKey(secretKey);
  return { secretKey, publicKey, pubkeyB64u: toB64u(publicKey) };
}

/** Only the public half of the message key (the derived secret is zeroed before returning). */
export function messagePublicKeyOf(privKeyHex: string): string {
  const pair = deriveMessageKeyPair(privKeyHex);
  pair.secretKey.fill(0);
  return pair.pubkeyB64u;
}

export interface SealedThreadMessage {
  /** One sealed box per party id, base64url. */
  readonly ciphertexts: Record<string, string>;
  /** sha256 hex of the UTF-8 plaintext — what the PE seals. */
  readonly content_sha256: string;
}

/** Seal `plaintext` to every party's published message key. */
export function sealThreadMessage(
  plaintext: string,
  partyKeys: Record<string, string>,
  randomBytes?: (n: number) => Uint8Array,
): SealedThreadMessage {
  const bytes = utf8ToBytes(plaintext);
  const ciphertexts: Record<string, string> = {};
  for (const [partyId, pubkeyB64u] of Object.entries(partyKeys)) {
    const pub = fromB64u(pubkeyB64u);
    ciphertexts[partyId] = toB64u(randomBytes ? sealToAnchor(pub, bytes, randomBytes) : sealToAnchor(pub, bytes));
  }
  return { ciphertexts, content_sha256: bytesToHex(sha256(bytes)) };
}

/** Open the ciphertext addressed to this party. Throws on wrong key / tamper. */
export function openThreadMessage(secretKey: Uint8Array, ciphertextB64u: string): string {
  const plain = openWithAnchor(secretKey, fromB64u(ciphertextB64u));
  return new TextDecoder().decode(plain);
}

/** The plaintext hash a receiver recomputes to check the PE-sealed `content_sha256`. */
export function threadContentSha256(plaintext: string): string {
  return bytesToHex(sha256(utf8ToBytes(plaintext)));
}
