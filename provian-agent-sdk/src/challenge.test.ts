/**
 * signed challenges (`provian-challenge-v1`) — SDK side.
 *
 * The VECTORS block is the relay's own output (provian-backend core/presentation/challenge.ts +
 * types.ts presentationBindingString), pinned identically in every package: if the SDK's signing
 * string, predicates digest, Ed25519 envelope, or v2 binding drifts by one byte, a test here reds.
 * Every accepting assertion is paired with a RED control that must refuse.
 */
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { promises as fsp } from 'fs';
import { describe, it, expect, vi } from 'vitest';
import {
  challengeSigningString,
  challengePredicatesDigest,
  signChallengeEnvelope,
  verifyChallengeEnvelope,
  checkSignedStructure,
  parseChallengeEnvelope,
  isSignedChallenge,
  createRequesterKeyFetcher,
  generateRequesterKey,
  requesterWellKnownDocument,
  createMemorySeenStore,
  createFileSeenStore,
  CHALLENGE_MAX_TTL_SECONDS,
  type ChallengeEnvelope,
  type RequesterJwk,
} from './challenge';
import { challengeDisclosuresDigest, disclosureCommitmentDigest, normalizeDisclosureRequests, parseDisclosureAnswers } from './disclosure-request';
import { presentationBindingString } from './presentation';
import { issuePresentationChallenge, parseChallengePayload } from './presentation-verify';

// ── The pinned cross-package vectors (D477_VECTORS.json, produced by the relay) ───────────────
const VECTORS = {
  test_seed_hex: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  test_public_jwk: { crv: 'Ed25519', x: 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg', kty: 'OKP' },
  empty_predicates_digest: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
  domain_signing_string: 'provian-challenge-v1\naud=gate.example.com\nchal=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\niat=1790000000\nexp=1790000900\nreq=domain:gate.example.com\nkid=k1\npresenter=0x5e645329ea23a84d6fb6006376f0b2b5e3b575f5\npredicates=da4ebf087a6a4e7346e6bf971b59df8942f22381d2e04b7de563a919b6d9b653',
  domain_envelope: {
    v: 1,
    audience: 'gate.example.com',
    challenge: 'a'.repeat(64),
    predicates: [
      { field: 'work.total', op: 'gte', threshold: 10 },
      { field: 'standing.adverse_events', op: 'in', set: [0] },
    ],
    issuedAt: 1790000000,
    expiresAt: 1790000900,
    presenter: '0x5e645329ea23a84d6fb6006376f0b2b5e3b575f5',
    requester: { type: 'domain', id: 'gate.example.com', kid: 'k1' },
    sig: '_SqvAe4KegEr31znYlpNJ6qjvcpU1lKxx2LCVJQdCuHKom5D37Dbi4K8VLEnt8s5McAPq__srMwSSYFlgVbKBw',
  },
  wallet_signing_string: 'provian-challenge-v1\naud=wallet_aw_test1\nchal=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\niat=1790000000\nexp=1790003600\nreq=wallet:wallet_aw_test1:0x5e645329ea23a84d6fb6006376f0b2b5e3b575f5\nkid=provian-commerce-2026-08a\npresenter=\npredicates=4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
  wallet_envelope: {
    v: 1,
    audience: 'wallet_aw_test1',
    challenge: 'b'.repeat(64),
    issuedAt: 1790000000,
    expiresAt: 1790003600,
    requester: { type: 'wallet', id: 'wallet_aw_test1', address: '0x5e645329ea23a84d6fb6006376f0b2b5e3b575f5', kid: 'provian-commerce-2026-08a' },
    sig: '3T4r5igsr6mP2cyg34xzcnzFFYu-KOOMp23lJ6YR7wHgQNmTvcOI_7UbcLQDo30-7ld1efnQc2UQXAvMCDapDA',
  },
  binding_v2: 'provian-presentation-v2\ntier=reputation\npresenter=0x5e645329ea23a84d6fb6006376f0b2b5e3b575f5\naud=gate.example.com\nchal=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\niat=1790000100\nexp=1790000400\njti=pres_x\nburn=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\nclaims=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\nreq=domain:gate.example.com\nchal_exp=1790000900',
  binding_v2_wallet: 'provian-presentation-v2\ntier=pe_fact\npresenter=0xabc0000000000000000000000000000000000001\naud=wallet_aw_test1\nchal=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\niat=1790000100\nexp=1790000400\njti=pres_y\nburn=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\nclaims=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\nreq=wallet:wallet_aw_test1:0x5e645329ea23a84d6fb6006376f0b2b5e3b575f5\nchal_exp=1790003600',
} as const;

const SEED_KEY = crypto.createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(VECTORS.test_seed_hex, 'hex')]),
  format: 'der',
  type: 'pkcs8',
});
const DOMAIN_KEYS: RequesterJwk[] = [{ ...VECTORS.test_public_jwk, kid: 'k1' }];
const PROVIAN_KEYS: RequesterJwk[] = [{ ...VECTORS.test_public_jwk, kid: 'provian-commerce-2026-08a' }];
const PRESENTER = '0x5e645329ea23a84d6fb6006376f0b2b5e3b575f5';
const DOMAIN_ENV = VECTORS.domain_envelope as unknown as ChallengeEnvelope;
const WALLET_ENV = VECTORS.wallet_envelope as unknown as ChallengeEnvelope;
const IN_WINDOW = 1790000100;

describe('pinned cross-package vectors (relay output)', () => {
  it('the SDK public key derived from the seed IS the pinned JWK', () => {
    const jwk = crypto.createPublicKey(SEED_KEY).export({ format: 'jwk' }) as { x: string };
    expect(jwk.x).toBe(VECTORS.test_public_jwk.x);
  });

  it('empty predicates digest = sha256("[]")', () => {
    expect(challengePredicatesDigest([])).toBe(VECTORS.empty_predicates_digest);
    expect(challengePredicatesDigest(undefined)).toBe(VECTORS.empty_predicates_digest);
  });

  it('domain + wallet signing strings are byte-identical to the relay', () => {
    const d = VECTORS.domain_envelope;
    expect(challengeSigningString({
      audience: d.audience, challenge: d.challenge, issuedAt: d.issuedAt, expiresAt: d.expiresAt,
      requester: d.requester, presenter: d.presenter, predicates: DOMAIN_ENV.predicates,
    })).toBe(VECTORS.domain_signing_string);
    const w = VECTORS.wallet_envelope;
    expect(challengeSigningString({
      audience: w.audience, challenge: w.challenge, issuedAt: w.issuedAt, expiresAt: w.expiresAt, requester: w.requester,
    })).toBe(VECTORS.wallet_signing_string);
  });

  it('signChallengeEnvelope reproduces both relay envelopes exactly (incl. the Ed25519 sig)', () => {
    const d = VECTORS.domain_envelope;
    expect(signChallengeEnvelope({
      audience: d.audience, challenge: d.challenge, issuedAt: d.issuedAt, expiresAt: d.expiresAt,
      requester: d.requester, presenter: d.presenter, predicates: DOMAIN_ENV.predicates,
    }, SEED_KEY)).toEqual(VECTORS.domain_envelope);
    const w = VECTORS.wallet_envelope;
    expect(signChallengeEnvelope({
      audience: w.audience, challenge: w.challenge, issuedAt: w.issuedAt, expiresAt: w.expiresAt, requester: w.requester,
    }, SEED_KEY)).toEqual(VECTORS.wallet_envelope);
  });

  it('an uppercase presenter is lowercased in the signing string (relay parity)', () => {
    const d = VECTORS.domain_envelope;
    expect(challengeSigningString({
      audience: d.audience, challenge: d.challenge, issuedAt: d.issuedAt, expiresAt: d.expiresAt,
      requester: d.requester, presenter: '0x5E645329EA23A84D6FB6006376F0B2B5E3B575F5', predicates: DOMAIN_ENV.predicates,
    })).toBe(VECTORS.domain_signing_string);
  });

  it('predicate ORDER does not move the signing string (canonical digest)', () => {
    const d = VECTORS.domain_envelope;
    const reversed = [...(DOMAIN_ENV.predicates ?? [])].reverse();
    expect(challengeSigningString({
      audience: d.audience, challenge: d.challenge, issuedAt: d.issuedAt, expiresAt: d.expiresAt,
      requester: d.requester, presenter: d.presenter, predicates: reversed,
    })).toBe(VECTORS.domain_signing_string);
  });

  it('v2 presentation binding strings (domain + wallet) are byte-identical to the relay', () => {
    expect(presentationBindingString({
      tier: 'reputation', presenterAddress: '0x5E645329EA23A84D6FB6006376F0B2B5E3B575F5', aud: 'gate.example.com',
      chal: 'a'.repeat(64), iat: 1790000100, exp: 1790000400, jti: 'pres_x', burnId: 'c'.repeat(64), claimsDigest: 'd'.repeat(64),
      requester: { type: 'domain', id: 'gate.example.com' }, chalExp: 1790000900,
    })).toBe(VECTORS.binding_v2);
    expect(presentationBindingString({
      tier: 'pe_fact', presenterAddress: '0xabc0000000000000000000000000000000000001', aud: 'wallet_aw_test1',
      chal: 'b'.repeat(64), iat: 1790000100, exp: 1790000400, jti: 'pres_y', burnId: 'e'.repeat(64), claimsDigest: 'f'.repeat(64),
      requester: { type: 'wallet', id: 'wallet_aw_test1', address: '0x5E645329EA23A84D6FB6006376F0B2B5E3B575F5' }, chalExp: 1790003600,
    })).toBe(VECTORS.binding_v2_wallet);
  });

  it('RED: requester without chalExp is refused (never a silent v1 downgrade)', () => {
    expect(() => presentationBindingString({
      tier: 'reputation', presenterAddress: PRESENTER, aud: 'gate.example.com', chal: 'a'.repeat(64), iat: 1, exp: 2,
      jti: 'j', burnId: 'c'.repeat(64), claimsDigest: 'd'.repeat(64), requester: { type: 'domain', id: 'gate.example.com' },
    })).toThrow(/both-or-neither/);
  });
});

describe('verifyChallengeEnvelope (A.3 presenter verdicts)', () => {
  const fetchKeys = async () => DOMAIN_KEYS;

  it('signed domain challenge → verified (addressed to me, in window)', async () => {
    const v = await verifyChallengeEnvelope(DOMAIN_ENV, { fetchRequesterKeys: fetchKeys, nowSeconds: IN_WINDOW, presenterAddress: PRESENTER.toUpperCase().replace('0X', '0x') });
    expect(v.status).toBe('verified');
    if (v.status === 'verified') expect(v.requester).toEqual({ type: 'domain', id: 'gate.example.com' });
  });

  it('RED: a tampered field (challenge) → invalid bad_signature', async () => {
    const v = await verifyChallengeEnvelope({ ...DOMAIN_ENV, challenge: 'c'.repeat(64) }, { fetchRequesterKeys: fetchKeys, nowSeconds: IN_WINDOW });
    expect(v).toMatchObject({ status: 'invalid', reason: 'bad_signature' });
  });

  it('RED: a tampered predicate → invalid bad_signature', async () => {
    const v = await verifyChallengeEnvelope({ ...DOMAIN_ENV, predicates: [{ field: 'work.total', op: 'gte', threshold: 1 }] }, { fetchRequesterKeys: fetchKeys, nowSeconds: IN_WINDOW });
    expect(v).toMatchObject({ status: 'invalid', reason: 'bad_signature' });
  });

  it('RED: a key set without the kid → invalid key_not_found', async () => {
    const v = await verifyChallengeEnvelope(DOMAIN_ENV, { fetchRequesterKeys: async () => [{ ...VECTORS.test_public_jwk, kid: 'k2' }], nowSeconds: IN_WINDOW });
    expect(v).toMatchObject({ status: 'invalid', reason: 'key_not_found' });
  });

  it('RED: past expiresAt + 60 → expired (signature still holds)', async () => {
    const v = await verifyChallengeEnvelope(DOMAIN_ENV, { fetchRequesterKeys: fetchKeys, nowSeconds: 1790000900 + 61 });
    expect(v.status).toBe('expired');
    const edge = await verifyChallengeEnvelope(DOMAIN_ENV, { fetchRequesterKeys: fetchKeys, nowSeconds: 1790000900 + 60 });
    expect(edge.status).toBe('verified');
  });

  it('RED: addressed to a different presenter → not_addressed', async () => {
    const v = await verifyChallengeEnvelope(DOMAIN_ENV, { fetchRequesterKeys: fetchKeys, nowSeconds: IN_WINDOW, presenterAddress: '0x' + '1'.repeat(40) });
    expect(v.status).toBe('not_addressed');
  });

  it('unsigned legacy challenge → unverified (no key fetch at all)', async () => {
    const spy = vi.fn(fetchKeys);
    const v = await verifyChallengeEnvelope({ audience: 'gate.example.com', challenge: 'a'.repeat(64) }, { fetchRequesterKeys: spy });
    expect(v.status).toBe('unverified');
    expect(spy).not.toHaveBeenCalled();
  });

  it('RED: a "requester" with no sig is SIGNED-but-invalid, never unverified', async () => {
    const { sig: _sig, ...noSig } = VECTORS.domain_envelope;
    void _sig;
    const v = await verifyChallengeEnvelope(noSig as unknown as ChallengeEnvelope, { fetchRequesterKeys: fetchKeys, nowSeconds: IN_WINDOW });
    expect(v).toMatchObject({ status: 'invalid', reason: 'bad_signature' });
  });

  it('wallet challenge → verified against the Provian JWKS (provianKeys)', async () => {
    const v = await verifyChallengeEnvelope(WALLET_ENV, { provianKeys: PROVIAN_KEYS, nowSeconds: IN_WINDOW });
    expect(v.status).toBe('verified');
    if (v.status === 'verified') expect(v.requester).toEqual({ type: 'wallet', id: 'wallet_aw_test1', address: PRESENTER });
  });

  it('wallet challenge → verified against ${relayUrl}/v1/present/jwks when no keys are given', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ keys: PROVIAN_KEYS }), { status: 200 }));
    const v = await verifyChallengeEnvelope(WALLET_ENV, { relayUrl: 'https://relay.test', fetchFn: fetchFn as unknown as typeof fetch, nowSeconds: IN_WINDOW });
    expect(v.status).toBe('verified');
    expect(fetchFn).toHaveBeenCalledWith('https://relay.test/v1/present/jwks', expect.anything());
  });

  it('RED: wallet challenge with no Provian key source → invalid requester_key_unreachable', async () => {
    const v = await verifyChallengeEnvelope(WALLET_ENV, { nowSeconds: IN_WINDOW });
    expect(v).toMatchObject({ status: 'invalid', reason: 'requester_key_unreachable' });
  });

  it('RED: a wallet envelope verified with a DOMAIN key of the same kid is still bound to its own requester type', async () => {
    // Re-label the wallet envelope as a domain requester — the signing string's req= line moves.
    const relabeled = { ...WALLET_ENV, audience: 'gate.example.com', requester: { type: 'domain' as const, id: 'gate.example.com', kid: 'provian-commerce-2026-08a' } };
    const v = await verifyChallengeEnvelope(relabeled, { fetchRequesterKeys: async () => PROVIAN_KEYS, nowSeconds: IN_WINDOW });
    expect(v).toMatchObject({ status: 'invalid', reason: 'bad_signature' });
  });
});

describe('checkSignedStructure (A.2)', () => {
  it('accepts both pinned envelopes', () => {
    expect(checkSignedStructure(DOMAIN_ENV)).toBeNull();
    expect(checkSignedStructure(WALLET_ENV)).toBeNull();
  });
  it('RED: audience ≠ requester.id → audience_not_requester', () => {
    expect(checkSignedStructure({ ...DOMAIN_ENV, audience: 'other.example.com' })).toBe('audience_not_requester');
  });
  it('window: 604800 s accepted, 604801 s and 59 s refused (bad_window)', () => {
    expect(CHALLENGE_MAX_TTL_SECONDS).toBe(604800);
    expect(checkSignedStructure({ ...DOMAIN_ENV, expiresAt: 1790000000 + 604800 })).toBeNull();
    expect(checkSignedStructure({ ...DOMAIN_ENV, expiresAt: 1790000000 + 604801 })).toBe('bad_window');
    expect(checkSignedStructure({ ...DOMAIN_ENV, expiresAt: 1790000000 + 59 })).toBe('bad_window');
  });
  it('RED: v ≠ 1, uppercase presenter, domain with an address, bad kid', () => {
    expect(checkSignedStructure({ ...DOMAIN_ENV, v: 2 })).toBe('unsupported_version');
    expect(checkSignedStructure({ ...DOMAIN_ENV, presenter: PRESENTER.toUpperCase() })).toBe('bad_presenter');
    expect(checkSignedStructure({ ...DOMAIN_ENV, requester: { type: 'domain', id: 'gate.example.com', kid: 'k1', address: PRESENTER } })).toBe('bad_requester');
    expect(checkSignedStructure({ ...DOMAIN_ENV, requester: { type: 'domain', id: 'gate.example.com', kid: 'k 1' } })).toBe('bad_requester');
  });
});

describe('parseChallengeEnvelope / parseChallengePayload', () => {
  it('keeps the signed fields and round-trips JSON', () => {
    const parsed = parseChallengePayload(JSON.stringify(VECTORS.domain_envelope));
    expect(parsed).toEqual(VECTORS.domain_envelope);
    expect(parsed && isSignedChallenge(parsed)).toBe(true);
  });
  it('legacy payload stays unsigned', () => {
    const parsed = parseChallengeEnvelope({ audience: 'x-aud', challenge: 'a'.repeat(16) });
    expect(parsed).toEqual({ audience: 'x-aud', challenge: 'a'.repeat(16) });
    expect(parsed && isSignedChallenge(parsed)).toBe(false);
  });
  it('RED: a 513-char challenge is refused', () => {
    expect(parseChallengeEnvelope({ audience: 'x', challenge: 'a'.repeat(513) })).toBeNull();
  });
});

describe('domain requester key fetch — SSRF-guarded (egress guard)', () => {
  const DOC = JSON.stringify({ keys: DOMAIN_KEYS });

  it('fetches https://<domain>/.well-known/provian-requester.json with redirect:manual → verified', async () => {
    const fetchFn = vi.fn(async () => new Response(DOC, { status: 200 }));
    const v = await verifyChallengeEnvelope(DOMAIN_ENV, {
      fetchFn: fetchFn as unknown as typeof fetch, resolveHost: async () => ['93.184.216.34'], nowSeconds: IN_WINDOW,
    });
    expect(v.status).toBe('verified');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://gate.example.com/.well-known/provian-requester.json');
    expect(init.redirect).toBe('manual');
  });

  it('RED: a domain resolving to a PRIVATE IP is refused by the egress guard — fetch never runs', async () => {
    const fetchFn = vi.fn(async () => new Response(DOC, { status: 200 }));
    const fetcher = createRequesterKeyFetcher({ fetchFn: fetchFn as unknown as typeof fetch, resolveHost: async () => ['10.0.0.5'] });
    await expect(fetcher('gate.example.com')).rejects.toThrow(/egress guard/);
    const v = await verifyChallengeEnvelope(DOMAIN_ENV, {
      fetchFn: fetchFn as unknown as typeof fetch, resolveHost: async () => ['169.254.169.254'], nowSeconds: IN_WINDOW,
    });
    expect(v).toMatchObject({ status: 'invalid', reason: 'requester_key_unreachable' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('RED: a 3xx answer is refused (no redirect following)', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example.org/' } }));
    const fetcher = createRequesterKeyFetcher({ fetchFn: fetchFn as unknown as typeof fetch, resolveHost: async () => ['93.184.216.34'] });
    await expect(fetcher('gate.example.com')).rejects.toThrow(/redirect/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('RED: a body over 64 KiB is refused', async () => {
    const big = JSON.stringify({ keys: DOMAIN_KEYS, pad: 'x'.repeat(70 * 1024) });
    const fetchFn = vi.fn(async () => new Response(big, { status: 200 }));
    const fetcher = createRequesterKeyFetcher({ fetchFn: fetchFn as unknown as typeof fetch, resolveHost: async () => ['93.184.216.34'] });
    await expect(fetcher('gate.example.com')).rejects.toThrow(/too large/);
  });

  it('RED: a non-hostname requester id never reaches the network', async () => {
    const fetchFn = vi.fn(async () => new Response(DOC, { status: 200 }));
    const fetcher = createRequesterKeyFetcher({ fetchFn: fetchFn as unknown as typeof fetch });
    await expect(fetcher('127.0.0.1')).rejects.toThrow(/hostname/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('generateRequesterKey + issuePresentationChallenge({ requester }) — the accountless gate', () => {
  it('a locally signed domain challenge verifies against its own well-known document', async () => {
    const key = generateRequesterKey({ kid: 'gate-2026' });
    const doc = requesterWellKnownDocument([key.publicJwk]);
    expect(doc).toEqual({ keys: [{ kty: 'OKP', crv: 'Ed25519', x: key.publicJwk.x, kid: 'gate-2026' }] });
    const c = issuePresentationChallenge({
      requester: { domain: 'gate.example.com', kid: key.kid, privateKeyPem: key.privateKeyPem },
      predicates: [{ field: 'work.total', op: 'gte', threshold: 10 }],
      presenter: PRESENTER.toUpperCase().replace('0X', '0x'),
      nowSeconds: 1790000000,
    });
    expect(c).toMatchObject({ v: 1, audience: 'gate.example.com', issuedAt: 1790000000, expiresAt: 1790000900, presenter: PRESENTER });
    expect(c.requester).toEqual({ type: 'domain', id: 'gate.example.com', kid: 'gate-2026' });
    // JSON.stringify of the returned object IS the wire envelope.
    const wire = parseChallengeEnvelope(JSON.stringify(c));
    expect(wire).toEqual(JSON.parse(JSON.stringify(c)));
    const v = await verifyChallengeEnvelope(wire as ChallengeEnvelope, { fetchRequesterKeys: async () => doc.keys, nowSeconds: 1790000100, presenterAddress: PRESENTER });
    expect(v.status).toBe('verified');
    // RED: another key's document (same kid) does not verify it.
    const other = generateRequesterKey({ kid: 'gate-2026' });
    const bad = await verifyChallengeEnvelope(wire as ChallengeEnvelope, { fetchRequesterKeys: async () => [other.publicJwk], nowSeconds: 1790000100 });
    expect(bad).toMatchObject({ status: 'invalid', reason: 'bad_signature' });
  });

  it('RED: a signed challenge whose audience is not the domain is refused at issuance', () => {
    const key = generateRequesterKey();
    expect(() => issuePresentationChallenge({ audience: 'someone-else', requester: { domain: 'gate.example.com', kid: key.kid, privateKeyPem: key.privateKeyPem } })).toThrow(/audience/);
  });

  it('unsigned issuance is unchanged (no v / requester / sig)', () => {
    const c = issuePresentationChallenge({ audience: 'order-42', nowSeconds: 1000 });
    expect(c).toEqual({ audience: 'order-42', challenge: c.challenge, issuedAt: 1000, expiresAt: 1900 });
    expect(isSignedChallenge(c)).toBe(false);
  });
});

describe('seen-stores (accept-once)', () => {
  it('memory store: first claim true, repeat false, re-claimable after expiry', async () => {
    const s = createMemorySeenStore();
    expect(await s.claim('p1', 100, 50)).toBe(true);
    expect(await s.claim('p1', 100, 60)).toBe(false);
    expect(await s.claim('p2', 100, 60)).toBe(true);
    expect(await s.claim('p1', 300, 101)).toBe(true); // pruned (exp 100 < now 101)
  });

  it('file store: shared across instances (multi-process), prunes, creates the parent dir', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'provian-seen-'));
    const file = path.join(dir, 'nested', 'deeper', 'seen.json');
    const a = createFileSeenStore(file);
    const b = createFileSeenStore(file);
    expect(await a.claim('p1', 100, 50)).toBe(true);
    expect(await b.claim('p1', 100, 60)).toBe(false); // a second "process" sees the claim
    expect(await b.claim('p2', 200, 60)).toBe(true);
    expect(await a.claim('p3', 300, 150)).toBe(true); // prunes p1 (exp 100 < 150)
    const onDisk = JSON.parse(await fsp.readFile(file, 'utf8')) as Record<string, number>;
    expect(onDisk).toEqual({ p2: 200, p3: 300 });
    await expect(fsp.stat(`${file}.lock`)).rejects.toThrow(); // lock released
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('RED: a corrupt file store throws (the verifier then fails closed), never silently re-accepts', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'provian-seen-'));
    const file = path.join(dir, 'seen.json');
    await fsp.writeFile(file, 'not json');
    await expect(createFileSeenStore(file).claim('p1', 100, 50)).rejects.toThrow();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('file store: concurrent claims of ONE id admit exactly one', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'provian-seen-'));
    const file = path.join(dir, 'seen.json');
    const results = await Promise.all(Array.from({ length: 8 }, () => createFileSeenStore(file).claim('same', 1000, 10)));
    expect(results.filter(Boolean)).toHaveLength(1);
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

// ── Requester-named disclosure vectors (2026-10-10, cross-package pin) ───────────────────────
// The SAME literals are asserted in the relay, SDK, MCP core and app suites: the request
// canonicalization, the challenge `disclosures=` digest, and the identity-only commitment the
// presenter's PoP covers. Every accepting assertion is paired with a RED control.
describe('named disclosure vectors (cross-package pin)', () => {
  const GCE_ROOT = '594759594b9b61524f6c8ef668f7177f7b9066bc0674f2f49fe9e052be78beb2';
  const RAW_REQUESTS = [
    { kind: 'witness', issuer: GCE_ROOT, limit: 3 },
    { kind: 'pe', output_digest: 'ab'.repeat(32), fields: ['metadata.lines'], content: ['description'] },
  ];
  const BOTH_DIGEST = '6e800ab4c7b515877c8204a316e6b6f6fac2955991dfb18e7fcea801a510e250';
  const SINGLE_DIGEST = '64a9ce6293c9eb83c422b209db81b4ec3b10ae32c0617512f2a3b825ff95d32d';
  const COMMITMENT_DIGEST = 'ad587e32f1d40021e49c349706775ef6dca39ba7f1ed3d5851a65c89c74ab4dc';
  const EMPTY_PREDICATES = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';

  it('normalizes to the sorted canonical list (pe before witness) and digests to the pinned value', () => {
    const reqs = normalizeDisclosureRequests(RAW_REQUESTS)!;
    expect(reqs).toEqual([
      { kind: 'pe', output_digest: 'ab'.repeat(32), fields: ['metadata.lines'], content: ['description'] },
      { kind: 'witness', issuer: GCE_ROOT, limit: 3 },
    ]);
    expect(challengeDisclosuresDigest(reqs)).toBe(BOTH_DIGEST);
    // Order-independent: the reversed raw list commits to the same digest.
    expect(challengeDisclosuresDigest(normalizeDisclosureRequests([...RAW_REQUESTS].reverse())!)).toBe(BOTH_DIGEST);
    expect(challengeDisclosuresDigest(normalizeDisclosureRequests([RAW_REQUESTS[1]])!)).toBe(SINGLE_DIGEST);
    // RED: a different limit, field, or content election moves the digest.
    expect(challengeDisclosuresDigest(normalizeDisclosureRequests([{ ...RAW_REQUESTS[0], limit: 4 }, RAW_REQUESTS[1]])!)).not.toBe(BOTH_DIGEST);
    expect(challengeDisclosuresDigest(normalizeDisclosureRequests([{ kind: 'pe', output_digest: 'ab'.repeat(32), fields: ['metadata.lines'] }])!)).not.toBe(SINGLE_DIGEST);
  });

  it('the signing line carries `disclosures=` ONLY when the challenge names disclosures (pinned)', () => {
    const base = { audience: 'gate.example.com', challenge: 'a'.repeat(64), issuedAt: 1790000000, expiresAt: 1790000900, requester: { type: 'domain' as const, id: 'gate.example.com', kid: 'k1' }, presenter: '0x5e645329ea23a84d6fb6006376f0b2b5e3b575f5', predicates: [] };
    const withDisclosures = challengeSigningString({ ...base, disclosures: normalizeDisclosureRequests(RAW_REQUESTS)! });
    expect(withDisclosures).toBe([
      'provian-challenge-v1', 'aud=gate.example.com', `chal=${'a'.repeat(64)}`, 'iat=1790000000', 'exp=1790000900',
      'req=domain:gate.example.com', 'kid=k1', 'presenter=0x5e645329ea23a84d6fb6006376f0b2b5e3b575f5',
      `predicates=${EMPTY_PREDICATES}`, `disclosures=${BOTH_DIGEST}`,
    ].join('\n'));
    // RED control: no disclosures → the pre-existing bytes, no trailing line.
    expect(challengeSigningString(base).includes('disclosures=')).toBe(false);
    expect(challengeSigningString({ ...base, disclosures: [] }).includes('disclosures=')).toBe(false);
  });

  it('the identity-only commitment digest is pinned, order-independent, and RED on a changed identity', () => {
    const reqs = normalizeDisclosureRequests(RAW_REQUESTS)!;
    const pe = reqs[0]; const witness = reqs[1];
    const record = { pe_id: 'pe_7', pe_hash: 'cd'.repeat(32), action_type: 'coding_session', timestamp: 1790000000000, witness: { kind: 'device', signer: 'dev_x' } };
    const answers = parseDisclosureAnswers([
      { request: witness, election: 'declined' },
      { request: pe, election: 'disclosed', records: [record] },
    ])!;
    expect(disclosureCommitmentDigest(answers)).toBe(COMMITMENT_DIGEST);
    expect(disclosureCommitmentDigest([...answers].reverse())).toBe(COMMITMENT_DIGEST);
    // The commitment ignores everything but elections + record identities: relay-derived witness
    // facts, fields and content do not move it (the Provian JWS covers those).
    const withFacts = parseDisclosureAnswers([
      { request: witness, election: 'declined' },
      { request: pe, election: 'disclosed', records: [{ ...record, action_type: 'other', witness: { kind: 'hardware', scheme: 'tpm2_quote' }, fields: { 'metadata.lines': 12 }, content: { description: 'x' } }] },
    ])!;
    expect(disclosureCommitmentDigest(withFacts)).toBe(COMMITMENT_DIGEST);
    // RED: a different pe_hash, a dropped record, or a flipped election moves it.
    expect(disclosureCommitmentDigest(parseDisclosureAnswers([{ request: witness, election: 'declined' }, { request: pe, election: 'disclosed', records: [{ ...record, pe_hash: 'ce'.repeat(32) }] }])!)).not.toBe(COMMITMENT_DIGEST);
    expect(disclosureCommitmentDigest(parseDisclosureAnswers([{ request: witness, election: 'declined' }, { request: pe, election: 'disclosed', records: [] }])!)).not.toBe(COMMITMENT_DIGEST);
    expect(disclosureCommitmentDigest(parseDisclosureAnswers([{ request: witness, election: 'disclosed', records: [] }, { request: pe, election: 'disclosed', records: [record] }])!)).not.toBe(COMMITMENT_DIGEST);
  });

  it('RED: malformed requests are refused as a whole (null), never partially accepted', () => {
    expect(normalizeDisclosureRequests([{ kind: 'pe', output_digest: 'zz'.repeat(32) }])).toBeNull();
    expect(normalizeDisclosureRequests([{ kind: 'pe', output_digest: 'ab'.repeat(32), content: ['prompt'] }])).toBeNull();
    expect(normalizeDisclosureRequests([{ kind: 'witness', limit: 51 }])).toBeNull();
    expect(normalizeDisclosureRequests(Array.from({ length: 17 }, (_, i) => ({ kind: 'pe', output_digest: i.toString(16).padStart(2, '0').repeat(32) })))).toBeNull();
    expect(normalizeDisclosureRequests([{ kind: 'pe', output_digest: 'ab'.repeat(32), fields: ['__proto__.x'] }])).toBeNull();
    expect(normalizeDisclosureRequests(undefined)).toEqual([]);
  });
});
