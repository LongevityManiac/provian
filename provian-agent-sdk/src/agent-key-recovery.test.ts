import { describe, expect, it } from 'vitest';
import {
  generateAnchorKeyPair,
  sealToAnchor,
  openWithAnchor,
  toB64u,
  fromB64u,
  RECOVERY_BLOB_VERSION,
} from './agent-key-recovery';

/**
 * PINNED CROSS-ENVIRONMENT VECTOR — do not regenerate casually.
 *
 * Produced once from this module with a fixed anchor secret (32×0x07) and a
 * deterministic ephemeral (32×0x09). The mobile app's mirror
 * (src/core/agents/agentKeyRecovery.test.ts) asserts the SAME vector: a blob
 * sealed by the Node SDK must open on the React Native phone. If this vector
 * ever has to change, change it in BOTH suites in the same commit — a silent
 * divergence would mean the human's phone can no longer open the agent's escrow,
 * i.e. an unrecoverable wallet.
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

describe('agent-key-recovery sealed box', () => {
  it('round-trips a sealed secret with a fresh anchor keypair', () => {
    const anchor = generateAnchorKeyPair();
    const secret = enc('a-32-byte-agent-secp256k1-private');
    const blob = sealToAnchor(anchor.publicKey, secret);
    expect(dec(openWithAnchor(anchor.secretKey, blob))).toBe('a-32-byte-agent-secp256k1-private');
  });

  it('opens the pinned cross-environment vector (SDK↔mobile wire parity)', () => {
    const anchorSecret = fromB64u(VECTOR.anchorSecretB64u);
    const blob = fromB64u(VECTOR.blobB64u);
    expect(dec(openWithAnchor(anchorSecret, blob))).toBe(VECTOR.plaintext);
  });

  it('produces a version-tagged, ephemeral-prefixed blob shape', () => {
    const anchor = generateAnchorKeyPair();
    const blob = sealToAnchor(anchor.publicKey, enc('x'));
    expect(blob[0]).toBe(RECOVERY_BLOB_VERSION);
    // version(1) + ephemeral x25519 pubkey(32) + ciphertext(1) + poly1305 tag(16)
    expect(blob.length).toBe(1 + 32 + 1 + 16);
  });

  // --- negative controls: a fund-key guard must be PROVEN able to fail. ---

  it('RED CONTROL: a single tampered ciphertext byte fails closed (throws)', () => {
    const anchorSecret = fromB64u(VECTOR.anchorSecretB64u);
    const blob = fromB64u(VECTOR.blobB64u);
    // flip the last byte (inside the poly1305 tag) — authentication must reject it.
    const tampered = Uint8Array.from(blob);
    tampered[tampered.length - 1] ^= 0x01;
    expect(() => openWithAnchor(anchorSecret, tampered)).toThrow();
    // control is non-vacuous: the UNtampered blob still opens.
    expect(dec(openWithAnchor(anchorSecret, blob))).toBe(VECTOR.plaintext);
  });

  it('RED CONTROL: the wrong anchor secret cannot open the blob (throws)', () => {
    const blob = fromB64u(VECTOR.blobB64u);
    const wrong = generateAnchorKeyPair().secretKey;
    expect(() => openWithAnchor(wrong, blob)).toThrow();
  });

  it('RED CONTROL: an unknown version byte is rejected (throws)', () => {
    const anchorSecret = fromB64u(VECTOR.anchorSecretB64u);
    const blob = fromB64u(VECTOR.blobB64u);
    const badVersion = Uint8Array.from(blob);
    badVersion[0] = 0x02;
    expect(() => openWithAnchor(anchorSecret, badVersion)).toThrow(/version/);
  });

  it('RED CONTROL: a blob shorter than the minimum is rejected (throws)', () => {
    const anchorSecret = fromB64u(VECTOR.anchorSecretB64u);
    expect(() => openWithAnchor(anchorSecret, new Uint8Array(10))).toThrow(/too short/);
  });

  it('every seal uses a fresh ephemeral key (no nonce reuse across seals)', () => {
    const anchor = generateAnchorKeyPair();
    const a = sealToAnchor(anchor.publicKey, enc('same-plaintext'));
    const b = sealToAnchor(anchor.publicKey, enc('same-plaintext'));
    // ephemeral pubkey bytes [1..33) must differ → different derived key+nonce.
    expect(toB64u(a.slice(1, 33))).not.toBe(toB64u(b.slice(1, 33)));
    expect(toB64u(a)).not.toBe(toB64u(b));
  });
});
