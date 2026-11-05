import { describe, it, expect } from 'vitest';

// C3 proof: the REMOTE promise share link carries the BODY end-to-end encrypted.
// expo-crypto is aliased to a real stub (node randomBytes) by the vitest config,
// and @noble/ciphers runs natively, so this exercises the REAL AES-256-GCM path.
//
// This module imports only a TYPE from PromiseService (erased at runtime), so it
// drags in no Firestore/native deps.
import {
  encryptPromisePayload,
  decryptPromisePayload,
  buildPromiseShareUrls,
} from './PromiseShareCrypto';
import { deepLinkValidator } from '../navigation/deepLinkValidator';
import type { PromiseQRPayload } from './PromiseService';

const PAYLOAD: PromiseQRPayload = {
  version: 2,
  promiseId: 'promise-uuid-123',
  theyGave: 'Tamales',
  theyOwe: '50 pesos',
  who: 'Bob',
  creatorAddress: '0xCreatorAddressAbCdEf',
  creatorName: 'Alice',
  dueDate: 1893456000000,
  creatorSignature: 'deadbeefcafefeed'.repeat(4),
  timestamp: 1750000000000,
};

// Split a share URL into the query (server-visible) and fragment (key) halves.
function splitUrl(url: string): { beforeHash: string; fragment: string } {
  const i = url.indexOf('#');
  return i === -1
    ? { beforeHash: url, fragment: '' }
    : { beforeHash: url.slice(0, i), fragment: url.slice(i + 1) };
}

describe('PromiseShareCrypto — E2E-encrypted remote share link (C3)', () => {
  it('encrypt → link → decrypt round-trips to an identical payload', async () => {
    const share = await encryptPromisePayload(PAYLOAD);
    const { universalUrl } = buildPromiseShareUrls(share);

    // Pull d from the query and k from the fragment, exactly as the deep-link
    // handler does.
    const url = new URL(universalUrl);
    const d = url.searchParams.get('d')!;
    const k = new URLSearchParams(url.hash.slice(1)).get('k')!;

    const decrypted = decryptPromisePayload(d, k);
    expect(decrypted).toEqual(PAYLOAD);
  });

  it('each encryption uses a fresh key + nonce (no reuse across promises)', async () => {
    const a = await encryptPromisePayload(PAYLOAD);
    const b = await encryptPromisePayload(PAYLOAD);
    expect(a.k).not.toBe(b.k); // fresh random key
    expect(a.d).not.toBe(b.d); // different nonce → different ciphertext
  });

  it('ciphertext (d) is opaque: it leaks none of the plaintext terms', async () => {
    const { d } = await encryptPromisePayload(PAYLOAD);
    // The server-visible blob must not contain any term in any obvious encoding.
    const haystacks = [d, Buffer.from(d, 'base64').toString('latin1')];
    for (const needle of ['Tamales', '50 pesos', 'Bob', 'Alice', PAYLOAD.creatorAddress, PAYLOAD.promiseId]) {
      for (const hay of haystacks) {
        expect(hay.includes(needle)).toBe(false);
      }
    }
  });

  it('the key lives ONLY in the fragment, never in the query', async () => {
    const share = await encryptPromisePayload(PAYLOAD);
    const { universalUrl, fallbackUrl } = buildPromiseShareUrls(share);

    expect(universalUrl.startsWith('https://provian.ai/p?d=')).toBe(true);
    expect(fallbackUrl.startsWith('provian://promise?d=')).toBe(true);

    for (const url of [universalUrl, fallbackUrl]) {
      const { beforeHash, fragment } = splitUrl(url);
      // Key present in the fragment...
      expect(fragment).toBe(`k=${share.k}`);
      // ...and absent from everything a server would receive.
      expect(beforeHash.includes(share.k)).toBe(false);
      expect(beforeHash.includes('k=')).toBe(false);
    }
  });

  it('wrong key fails to decrypt (authenticated): no silent garbage', async () => {
    const share = await encryptPromisePayload(PAYLOAD);
    const otherKey = (await encryptPromisePayload(PAYLOAD)).k;
    expect(() => decryptPromisePayload(share.d, otherKey)).toThrow();
  });

  it('tampered ciphertext fails to decrypt (GCM auth tag)', async () => {
    const share = await encryptPromisePayload(PAYLOAD);
    // Flip a character deep in the base64url blob (past the version+nonce header).
    const idx = share.d.length - 4;
    const ch = share.d[idx];
    const flipped = share.d.slice(0, idx) + (ch === 'A' ? 'B' : 'A') + share.d.slice(idx + 1);
    expect(() => decryptPromisePayload(flipped, share.k)).toThrow();
  });

  it('rejects a malformed/short blob and a bad-length key (fail closed)', async () => {
    const share = await encryptPromisePayload(PAYLOAD);
    expect(() => decryptPromisePayload('AAAA', share.k)).toThrow(); // too short
    expect(() => decryptPromisePayload(share.d, 'AAAA')).toThrow(); // bad key length
    expect(() => decryptPromisePayload('not base64url!!', share.k)).toThrow(); // invalid alphabet
  });

  // The fail-closed property must be the REAL AES-GCM auth tag rejecting, not a
  // wrapper length/alphabet check. Each case below mutates the packed blob at the
  // BYTE level and keeps it long enough to clear the wrapper's version + min-length
  // guards, so it reaches gcm().decrypt(), which then throws on the GHASH/tag
  // mismatch. Packed layout of `d`:
  //   [0]=version(1) | [1..13)=nonce(12) | [13..len-16)=ciphertext body | [len-16..len)=auth tag(16)
  describe('AES-256-GCM authentication is real (reaches GCM, not a wrapper check)', () => {
    // Test-local base64url <-> bytes (Node Buffer), independent of the module's
    // own codec so a codec bug can't hide a crypto bug.
    const toBytes = (s: string): Uint8Array =>
      new Uint8Array(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
    const toB64url = (b: Uint8Array): string =>
      Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const MIN = 1 + 12 + 16; // version + nonce + tag

    it('positive control: correct key + ciphertext decrypts to the EXACT original', async () => {
      const { d, k } = await encryptPromisePayload(PAYLOAD);
      expect(decryptPromisePayload(d, k)).toEqual(PAYLOAD);
    });

    it('(a) flipping one byte of the CIPHERTEXT BODY throws (GHASH mismatch)', async () => {
      const { d, k } = await encryptPromisePayload(PAYLOAD);
      const bytes = toBytes(d);
      const bodyStart = 1 + 12; // after version + nonce
      const bodyEnd = bytes.length - 16; // before the auth tag
      expect(bodyEnd).toBeGreaterThan(bodyStart); // non-empty body
      const idx = bodyStart + Math.floor((bodyEnd - bodyStart) / 2);
      bytes[idx] ^= 0xff; // length unchanged → clears wrapper guards → reaches GCM
      expect(bytes.length).toBeGreaterThanOrEqual(MIN);
      expect(() => decryptPromisePayload(toB64url(bytes), k)).toThrow();
    });

    it('(b) flipping one byte of the AUTH TAG throws', async () => {
      const { d, k } = await encryptPromisePayload(PAYLOAD);
      const bytes = toBytes(d);
      bytes[bytes.length - 1] ^= 0xff; // last byte = tail of the 16-byte tag
      expect(bytes.length).toBeGreaterThanOrEqual(MIN);
      expect(() => decryptPromisePayload(toB64url(bytes), k)).toThrow();
    });

    it('(c) truncating the ciphertext throws (still past the min-length guard → GCM rejects)', async () => {
      const { d, k } = await encryptPromisePayload(PAYLOAD);
      const bytes = toBytes(d);
      const truncated = bytes.slice(0, bytes.length - 4); // drop 4 bytes of the tag
      expect(truncated.length).toBeGreaterThanOrEqual(MIN); // NOT a wrapper-length reject
      expect(() => decryptPromisePayload(toB64url(truncated), k)).toThrow();
    });
  });

  // Findings #2/#3 regression: BOTH link forms must survive the REAL
  // deepLinkValidator (device-faithful hand parser) and decrypt back to the
  // exact payload. Before the parser fix, the provian://promise fallback yielded
  // host="" (skipped) and a "/"-corrupted ciphertext.
  it('round-trips through deepLinkValidator for the universal AND fallback links', async () => {
    const share = await encryptPromisePayload(PAYLOAD);
    const { universalUrl, fallbackUrl } = buildPromiseShareUrls(share);

    for (const url of [universalUrl, fallbackUrl]) {
      const parsed = deepLinkValidator(url);
      expect(parsed).not.toBeNull();
      const d = parsed!.params.d;
      const k = new URLSearchParams(parsed!.fragment).get('k')!;
      // Ciphertext is byte-exact (no stray '/'), key recovered from the fragment.
      expect(d).toBe(share.d);
      expect(k).toBe(share.k);
      expect(decryptPromisePayload(d, k)).toEqual(PAYLOAD);
    }
  });
});
