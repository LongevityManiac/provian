import { describe, expect, it } from 'vitest';
import {
  generateAnchorKeyPair,
  sealToAnchor,
  openWithAnchor,
  toB64u,
  fromB64u,
  RECOVERY_BLOB_VERSION,
} from './agentKeyRecovery';

/**
 * PINNED CROSS-ENVIRONMENT VECTOR — MUST be byte-identical to the SDK suite
 * (provian-agent-sdk/src/agent-key-recovery.test.ts). This blob was SEALED BY
 * THE NODE SDK. The test below opens it HERE (the React Native module). If it
 * ever fails, the phone can no longer open the agent's escrow → an
 * unrecoverable wallet. Change the vector in BOTH suites in the same commit or
 * not at all.
 */
const VECTOR = {
  anchorSecretB64u: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
  anchorPubB64u: 'E75P6uryBMf9M1j8nAByGIHRdCeBKCJ-xnTzf3_pe20',
  plaintext: 'provian-agent-secp256k1-key-32bytes!!',
  blobB64u:
    'AVfbSzWfI65eFG5OJRIFZwRyJQY0jBUMFHU9DJM9BNQhr_-CnW3w_T1hMIEMszdx7ur6VXxHlGpe0hY1CLWOQI3aTC8ivRgEzEvVwrzoN7wSOllRsPo',
};

const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const enc = (s: string) => new TextEncoder().encode(s);

describe('agentKeyRecovery (mobile) — SDK↔phone parity', () => {
  it('opens a blob that was SEALED BY THE NODE SDK (the whole point)', () => {
    const anchorSecret = fromB64u(VECTOR.anchorSecretB64u);
    const blob = fromB64u(VECTOR.blobB64u);
    expect(dec(openWithAnchor(anchorSecret, blob))).toBe(VECTOR.plaintext);
  });

  it('inlined base64url matches @scure/base output byte-for-byte', () => {
    // If this drifts, the vector strings the SDK produced would decode wrong here.
    const anchorSecret = fromB64u(VECTOR.anchorSecretB64u);
    expect(toB64u(anchorSecret)).toBe(VECTOR.anchorSecretB64u);
    const blob = fromB64u(VECTOR.blobB64u);
    expect(toB64u(blob)).toBe(VECTOR.blobB64u);
    // derived anchor pubkey must match the vector's published pubkey
    const { x25519 } = require('@noble/curves/ed25519');
    expect(toB64u(x25519.getPublicKey(anchorSecret))).toBe(VECTOR.anchorPubB64u);
  });

  it('round-trips a locally sealed secret', () => {
    const anchor = generateAnchorKeyPair();
    const secret = enc('a-32-byte-agent-secp256k1-private');
    const blob = sealToAnchor(anchor.publicKey, secret);
    expect(dec(openWithAnchor(anchor.secretKey, blob))).toBe('a-32-byte-agent-secp256k1-private');
  });

  // --- negative controls (mirror the SDK suite). ---

  it('RED CONTROL: a tampered blob byte fails closed (throws)', () => {
    const anchorSecret = fromB64u(VECTOR.anchorSecretB64u);
    const blob = fromB64u(VECTOR.blobB64u);
    const tampered = Uint8Array.from(blob);
    tampered[tampered.length - 1] ^= 0x01;
    expect(() => openWithAnchor(anchorSecret, tampered)).toThrow();
    expect(dec(openWithAnchor(anchorSecret, blob))).toBe(VECTOR.plaintext); // non-vacuous
  });

  it('RED CONTROL: the wrong anchor secret cannot open the blob (throws)', () => {
    const blob = fromB64u(VECTOR.blobB64u);
    expect(() => openWithAnchor(generateAnchorKeyPair().secretKey, blob)).toThrow();
  });

  it('RED CONTROL: unknown version + too-short blobs are rejected (throw)', () => {
    const anchorSecret = fromB64u(VECTOR.anchorSecretB64u);
    const blob = fromB64u(VECTOR.blobB64u);
    const badVersion = Uint8Array.from(blob);
    badVersion[0] = 0x02;
    expect(() => openWithAnchor(anchorSecret, badVersion)).toThrow(/version/);
    expect(() => openWithAnchor(anchorSecret, new Uint8Array(10))).toThrow(/too short/);
  });

  it('blob shape is version + ephemeral pubkey + AEAD ciphertext', () => {
    const anchor = generateAnchorKeyPair();
    const blob = sealToAnchor(anchor.publicKey, enc('x'));
    expect(blob[0]).toBe(RECOVERY_BLOB_VERSION);
    expect(blob.length).toBe(1 + 32 + 1 + 16);
  });
});
