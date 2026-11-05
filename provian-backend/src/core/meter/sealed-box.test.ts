/**
 * The relay's sealed box must be byte-identical to the SDK's (`sealToAnchor`), or a PE the relay
 * seals for its owner could not be opened on the phone or the daemon. The vector below was
 * produced by the SDK's own implementation with a fixed ephemeral key.
 */
import { describe, expect, it } from '@jest/globals';
import { fromB64u, hchacha20, openWithKey, sealToKey, toB64u } from './sealed-box';

const SDK_VECTOR = {
  anchor_secret_b64u: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA',
  anchor_public_b64u: 'B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw',
  ephemeral_secret_b64u: 'yMfGxcTDwsHAv769vLu6ubi3trW0s7KxsK-urayrqqk',
  plaintext: '{"pe_id":"pe_vector","schema":"provian.pe.v2"}',
  blob_b64u: 'AY2vz-6ukEXumnjXipn88y53geRB6wcwlsNCuOLcw7YSBhxegjkAhOvYmKkaOwWyKjscbkELnKxrLEPiFxPfTgubqeTe1f9Zpg8Cohqp1Tj3JczTYuBDRe_ndLIsG-I',
};

describe('sealed box (relay ↔ SDK byte compatibility)', () => {
  it('HChaCha20 matches the draft-irtf-cfrg-xchacha test vector', () => {
    const key = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
    const nonce = Buffer.from('000000090000004a0000000031415927', 'hex');
    expect(hchacha20(key, nonce).toString('hex'))
      .toBe('82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc');
  });

  it('seals exactly what the SDK seals for the same ephemeral key', () => {
    const blob = sealToKey(fromB64u(SDK_VECTOR.anchor_public_b64u), Buffer.from(SDK_VECTOR.plaintext, 'utf8'), fromB64u(SDK_VECTOR.ephemeral_secret_b64u));
    expect(toB64u(blob)).toBe(SDK_VECTOR.blob_b64u);
  });

  it('opens an SDK box; RED: a flipped byte or the wrong key fails', () => {
    const secret = fromB64u(SDK_VECTOR.anchor_secret_b64u);
    expect(openWithKey(secret, fromB64u(SDK_VECTOR.blob_b64u)).toString('utf8')).toBe(SDK_VECTOR.plaintext);
    const tampered = fromB64u(SDK_VECTOR.blob_b64u);
    tampered[tampered.length - 1] ^= 1;
    expect(() => openWithKey(secret, tampered)).toThrow();
    const wrong = Buffer.alloc(32, 7);
    expect(() => openWithKey(wrong, fromB64u(SDK_VECTOR.blob_b64u))).toThrow();
  });
});
