/**
 * Tests for the production adapter: revocation-source loading (cache/fetch with
 * fail-closed semantics), base64 chain decoding + DoS bounds, and end-to-end
 * delegation to the pure verifier with embedded-anchor overrides.
 */
import {
  verifyAndroidRegistrationChain,
  loadRevocationSource,
  productionAnchors,
  type FetchLike,
  type RevocationCache,
} from '../adapter';
import { mintChain, ALLOW_ALL_REVOCATION, TEST_NOW } from './synthetic-chain';
import { buildTrustAnchorSet } from '../roots';
import { GOOGLE_HW_ATTESTATION_ROOTS } from '../google-roots';

function memCache(): RevocationCache & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    get: async <T>(k: string) => (store.has(k) ? (store.get(k) as T) : null),
    set: async (k: string, v: unknown) => {
      store.set(k, v);
    },
  };
}

function toB64Chain(der: Uint8Array[]): string[] {
  return der.map((d) => Buffer.from(d).toString('base64'));
}

describe('productionAnchors', () => {
  it('parses both embedded Google roots', () => {
    const anchors = productionAnchors();
    expect(anchors.anchors.length).toBe(2);
    expect(anchors.spkiFingerprints.size).toBe(2);
    // Stable across calls (memoized).
    expect(productionAnchors()).toBe(anchors);
  });

  it('embeds exactly the two documented roots', () => {
    expect(GOOGLE_HW_ATTESTATION_ROOTS.length).toBe(2);
  });
});

describe('loadRevocationSource', () => {
  const statusList = {
    entries: {
      deadbeef: { status: 'REVOKED', reason: 'KEY_COMPROMISE' },
      cafe: { status: 'SUSPENDED' },
    },
  };

  it('fetches, caches, and flags revoked + suspended serials', async () => {
    const cache = memCache();
    let fetched = 0;
    const fetchImpl: FetchLike = async () => {
      fetched += 1;
      return { ok: true, json: async () => statusList };
    };
    const src = await loadRevocationSource(cache, fetchImpl);
    expect(src.available).toBe(true);
    expect(src.isRevoked('deadbeef').revoked).toBe(true);
    expect(src.isRevoked('cafe').revoked).toBe(true);
    expect(src.isRevoked('feed').revoked).toBe(false);
    expect(fetched).toBe(1);

    // Second load hits the cache, not the network.
    const src2 = await loadRevocationSource(cache, fetchImpl);
    expect(src2.isRevoked('deadbeef').revoked).toBe(true);
    expect(fetched).toBe(1);
  });

  it('fails closed (available=false) when the fetch errors and cache is empty', async () => {
    const cache = memCache();
    const fetchImpl: FetchLike = async () => {
      throw new Error('network down');
    };
    const src = await loadRevocationSource(cache, fetchImpl);
    expect(src.available).toBe(false);
  });

  it('fails closed when the fetch returns a non-ok response', async () => {
    const cache = memCache();
    const fetchImpl: FetchLike = async () => ({ ok: false, json: async () => ({}) });
    const src = await loadRevocationSource(cache, fetchImpl);
    expect(src.available).toBe(false);
  });
});

describe('verifyAndroidRegistrationChain', () => {
  it('decodes a base64 chain and promotes a valid StrongBox chain', async () => {
    const chain = await mintChain();
    const res = await verifyAndroidRegistrationChain({
      certChainB64: toB64Chain(chain.derChain),
      expectedChallenge: chain.challenge,
      registeredSigningPublicKeyHex: chain.registeredKeyHex,
      cache: memCache(),
      anchors: chain.anchors,
      revocation: ALLOW_ALL_REVOCATION,
      now: TEST_NOW,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.attestedTier).toBe('hardware_full');
  });

  it('rejects an empty chain', async () => {
    const res = await verifyAndroidRegistrationChain({
      certChainB64: [],
      expectedChallenge: new Uint8Array([1]),
      registeredSigningPublicKeyHex: '04'.padEnd(130, '0'),
      cache: memCache(),
      revocation: ALLOW_ALL_REVOCATION,
      now: TEST_NOW,
    });
    expect(res).toMatchObject({ ok: false, code: 'CHAIN_EMPTY' });
  });

  it('rejects an over-long chain (DoS bound)', async () => {
    const res = await verifyAndroidRegistrationChain({
      certChainB64: new Array(11).fill('AAAA'),
      expectedChallenge: new Uint8Array([1]),
      registeredSigningPublicKeyHex: '04'.padEnd(130, '0'),
      cache: memCache(),
      revocation: ALLOW_ALL_REVOCATION,
      now: TEST_NOW,
    });
    expect(res).toMatchObject({ ok: false, code: 'CHAIN_PARSE' });
  });

  it('does not promote a chain not rooted in the embedded Google roots', async () => {
    // Use the real embedded production anchors; a synthetic test-root chain
    // must NOT anchor to them.
    const chain = await mintChain();
    const res = await verifyAndroidRegistrationChain({
      certChainB64: toB64Chain(chain.derChain),
      expectedChallenge: chain.challenge,
      registeredSigningPublicKeyHex: chain.registeredKeyHex,
      cache: memCache(),
      anchors: buildTrustAnchorSet([...GOOGLE_HW_ATTESTATION_ROOTS]),
      revocation: ALLOW_ALL_REVOCATION,
      now: TEST_NOW,
    });
    expect(res).toMatchObject({ ok: false, code: 'ROOT_NOT_TRUSTED' });
  });
});
