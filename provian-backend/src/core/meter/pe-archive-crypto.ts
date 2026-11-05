/**
 * Per-package crypto adapter for `pe-archive-wire.ts` (the relay uses Node's crypto through
 * `sealed-box.ts`, byte-compatible with the SDK's and the app's sealed box). The relay never holds
 * a recipient secret; it opens nothing in production — `archiveOpenBox` exists for tests and tools.
 */
import crypto from 'crypto';
import { openWithKey, sealToKey, x25519PublicOf } from './sealed-box';

export type ArchiveRandomBytes = (n: number) => Uint8Array;

export function archiveRandomBytes(n: number): Uint8Array {
  return new Uint8Array(crypto.randomBytes(n));
}

/** A fresh x25519 key pair (the part's content key). */
export function archiveContentKeyPair(randomBytes: ArchiveRandomBytes = archiveRandomBytes): { secretKey: Uint8Array; publicKey: Uint8Array } {
  const secretKey = randomBytes(32);
  return { secretKey, publicKey: new Uint8Array(x25519PublicOf(secretKey)) };
}

/** Seal `plaintext` to an x25519 public key (draws 32 bytes for the ephemeral key). */
export function archiveSealBox(recipientPublic: Uint8Array, plaintext: Uint8Array, randomBytes: ArchiveRandomBytes = archiveRandomBytes): Uint8Array {
  return new Uint8Array(sealToKey(recipientPublic, plaintext, randomBytes(32)));
}

/** Open a box with the recipient's x25519 secret. Throws on a wrong key or tamper. */
export function archiveOpenBox(recipientSecret: Uint8Array, box: Uint8Array): Uint8Array {
  return new Uint8Array(openWithKey(recipientSecret, box));
}
