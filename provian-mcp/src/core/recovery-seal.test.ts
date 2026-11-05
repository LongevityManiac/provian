/**
 * recovery-seal : the node:crypto-only sealer the MCP core uses is byte-for-byte the SDK's
 * `sealToAnchor` (provian-agent-sdk/src/agent-key-recovery.ts, itself byte-identical to the app's).
 * The vector below was produced by the SDK's sealToAnchor with the same anchor, ephemeral secret and
 * key, so a blob this module seals opens on the phone exactly like one the SDK sealed.
 */
import { describe, expect, it } from 'vitest';
import { hchacha20, sealToRecoveryAnchor } from './recovery-seal';

// SDK vector: anchor secret = bytes 1..32; ephemeral secret = bytes 200,199,…,169.
const ANCHOR_PUB = 'B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw';
const EPH = Buffer.from(Array.from({ length: 32 }, (_, i) => 200 - i));
const PRIV = '11'.repeat(16) + '2f'.repeat(16);
const SDK_BLOB = 'AY2vz-6ukEXumnjXipn88y53geRB6wcwlsNCuOLcw7YSbC8_9nd48djzq8hudWLGWGBcM0wIkfAnawmgWR7KQ1Rlr5n82d2eLSXhiORyhpmQ';

describe('sealToRecoveryAnchor', () => {
  it('matches the SDK sealToAnchor vector byte for byte', () => {
    expect(sealToRecoveryAnchor(ANCHOR_PUB, PRIV, EPH)).toBe(SDK_BLOB);
    expect(Buffer.from(SDK_BLOB, 'base64url')).toHaveLength(81);
  });

  it('RED CONTROL: a different key, anchor or ephemeral secret gives a different blob', () => {
    expect(sealToRecoveryAnchor(ANCHOR_PUB, '22'.repeat(32), EPH)).not.toBe(SDK_BLOB);
    expect(sealToRecoveryAnchor('A'.repeat(42) + 'E', PRIV, EPH)).not.toBe(SDK_BLOB);
    const eph2 = Buffer.from(EPH); eph2[1] ^= 1; // not byte 0: X25519 clamps its low 3 bits
    expect(sealToRecoveryAnchor(ANCHOR_PUB, PRIV, eph2)).not.toBe(SDK_BLOB);
  });

  it('a fresh ephemeral key every seal (never the same blob twice)', () => {
    expect(sealToRecoveryAnchor(ANCHOR_PUB, PRIV)).not.toBe(sealToRecoveryAnchor(ANCHOR_PUB, PRIV));
  });

  it('refuses a malformed anchor or key', () => {
    expect(() => sealToRecoveryAnchor('short', PRIV)).toThrow();
    expect(() => sealToRecoveryAnchor(ANCHOR_PUB, 'zz')).toThrow();
  });

  it('HChaCha20 matches the draft-irtf-cfrg-xchacha §2.2.1 test vector', () => {
    const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    const nonce = Buffer.from('000000090000004a0000000031415927', 'hex');
    expect(hchacha20(key, nonce).toString('hex'))
      .toBe('82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc');
  });
});
