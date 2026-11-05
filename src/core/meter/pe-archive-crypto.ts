/**
 * Per-package crypto adapter for `pe-archive-wire.ts` (the app's sealed box,
 * `core/security/agentKeyRecovery.ts`: x25519 + HKDF-SHA256 + XChaCha20-Poly1305, v0x01 — the
 * mailbox's and thread messages' format; Hermes has no Node crypto, so @noble throughout).
 */
import { x25519 } from '@noble/curves/ed25519';
import { randomBytes as nobleRandomBytes } from '@noble/hashes/utils';
import { openWithAnchor, sealToAnchor } from '../security/agentKeyRecovery';

export type ArchiveRandomBytes = (n: number) => Uint8Array;

export function archiveRandomBytes(n: number): Uint8Array {
    return nobleRandomBytes(n);
}

/** A fresh x25519 key pair (the part's content key). */
export function archiveContentKeyPair(randomBytes: ArchiveRandomBytes = archiveRandomBytes): { secretKey: Uint8Array; publicKey: Uint8Array } {
    const secretKey = randomBytes(32);
    return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

/** Seal `plaintext` to an x25519 public key (draws 32 bytes for the ephemeral key). */
export function archiveSealBox(recipientPublic: Uint8Array, plaintext: Uint8Array, randomBytes: ArchiveRandomBytes = archiveRandomBytes): Uint8Array {
    return sealToAnchor(recipientPublic, plaintext, randomBytes);
}

/** Open a box with the recipient's x25519 secret. Throws on a wrong key or tamper. */
export function archiveOpenBox(recipientSecret: Uint8Array, box: Uint8Array): Uint8Array {
    return openWithAnchor(recipientSecret, box);
}
