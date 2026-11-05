/**
 * signed challenges + presentation v2 — FIXED-VECTOR CROSS-PACKAGE PARITY PIN.
 *
 * The literals below are the pinned vectors (the relay, the SDK, the CLI and the app pin the
 * SAME values). `challenge.ts` / `presentation.ts` are byte-for-byte ports; if one byte drifts, a
 * presenter's verdict or a v2 PoP would disagree with the relay, so each package reddens its own
 * suite. Every positive assertion has a RED control beside it : a mutated envelope must
 * change the verdict, a mutated preimage must change the digest.
 */

import { createPrivateKey, createPublicKey, sign as edSign } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  challengePredicatesDigest,
  challengeSigningString,
  fetchRequesterKeysGuarded,
  isPrivateIp,
  isSignedChallenge,
  parseChallengeEnvelope,
  describeVerdict,
  verifyChallengeEnvelope,
  type ChallengeEnvelope,
  type RequesterJwk,
} from './challenge';
import { challengeDisclosuresDigest, disclosureCommitmentDigest, normalizeDisclosureRequests, parseDisclosureAnswers } from './disclosure-request';
import { presentationBindingString, requesterString, PRESENTATION_BINDING_TAG_V2 } from './presentation';

// ── pinned vectors ──────────────────────────────────────────────────────
const TEST_SEED_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const TEST_PUBLIC_X = 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg';
const EMPTY_PREDICATES_DIGEST = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const PRESENTER = '0x5e645329ea23a84d6fb6006376f0b2b5e3b575f5';
const DOMAIN_SIGNING_STRING = [
  'provian-challenge-v1',
  'aud=gate.example.com',
  `chal=${'a'.repeat(64)}`,
  'iat=1790000000',
  'exp=1790000900',
  'req=domain:gate.example.com',
  'kid=k1',
  `presenter=${PRESENTER}`,
  'predicates=da4ebf087a6a4e7346e6bf971b59df8942f22381d2e04b7de563a919b6d9b653',
].join('\n');
const DOMAIN_ENVELOPE: ChallengeEnvelope = {
  v: 1,
  audience: 'gate.example.com',
  challenge: 'a'.repeat(64),
  predicates: [
    { field: 'work.total', op: 'gte', threshold: 10 },
    { field: 'standing.adverse_events', op: 'in', set: [0] },
  ],
  issuedAt: 1790000000,
  expiresAt: 1790000900,
  presenter: PRESENTER,
  requester: { type: 'domain', id: 'gate.example.com', kid: 'k1' },
  sig: '_SqvAe4KegEr31znYlpNJ6qjvcpU1lKxx2LCVJQdCuHKom5D37Dbi4K8VLEnt8s5McAPq__srMwSSYFlgVbKBw',
};
const WALLET_SIGNING_STRING = [
  'provian-challenge-v1',
  'aud=wallet_aw_test1',
  `chal=${'b'.repeat(64)}`,
  'iat=1790000000',
  'exp=1790003600',
  `req=wallet:wallet_aw_test1:${PRESENTER}`,
  'kid=provian-commerce-2026-08a',
  'presenter=',
  `predicates=${EMPTY_PREDICATES_DIGEST}`,
].join('\n');
const WALLET_ENVELOPE: ChallengeEnvelope = {
  v: 1,
  audience: 'wallet_aw_test1',
  challenge: 'b'.repeat(64),
  issuedAt: 1790000000,
  expiresAt: 1790003600,
  requester: { type: 'wallet', id: 'wallet_aw_test1', address: PRESENTER, kid: 'provian-commerce-2026-08a' },
  sig: '3T4r5igsr6mP2cyg34xzcnzFFYu-KOOMp23lJ6YR7wHgQNmTvcOI_7UbcLQDo30-7ld1efnQc2UQXAvMCDapDA',
};
const BINDING_V2 = [
  'provian-presentation-v2',
  'tier=reputation',
  `presenter=${PRESENTER}`,
  'aud=gate.example.com',
  `chal=${'a'.repeat(64)}`,
  'iat=1790000100',
  'exp=1790000400',
  'jti=pres_x',
  `burn=${'c'.repeat(64)}`,
  `claims=${'d'.repeat(64)}`,
  'req=domain:gate.example.com',
  'chal_exp=1790000900',
].join('\n');
const BINDING_V2_WALLET = [
  'provian-presentation-v2',
  'tier=pe_fact',
  'presenter=0xabc0000000000000000000000000000000000001',
  'aud=wallet_aw_test1',
  `chal=${'b'.repeat(64)}`,
  'iat=1790000100',
  'exp=1790000400',
  'jti=pres_y',
  `burn=${'e'.repeat(64)}`,
  `claims=${'f'.repeat(64)}`,
  `req=wallet:wallet_aw_test1:${PRESENTER}`,
  'chal_exp=1790003600',
].join('\n');

/** The test key: Ed25519 from the pinned seed (PKCS#8 DER prefix + 32-byte seed). */
function testPrivateKey() {
  return createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(TEST_SEED_HEX, 'hex')]),
    format: 'der',
    type: 'pkcs8',
  });
}
const DOMAIN_KEYS: RequesterJwk[] = [{ kty: 'OKP', crv: 'Ed25519', x: TEST_PUBLIC_X, kid: 'k1' }];
const PROVIAN_KEYS: RequesterJwk[] = [{ kty: 'OKP', crv: 'Ed25519', x: TEST_PUBLIC_X, kid: 'provian-commerce-2026-08a' }];
const NOW_IN_WINDOW = 1790000100;

describe(' challenge signing string + predicates digest — pinned vectors', () => {
  it('the empty predicate list digests to sha256("[]")', () => {
    expect(challengePredicatesDigest(undefined)).toBe(EMPTY_PREDICATES_DIGEST);
    expect(challengePredicatesDigest([])).toBe(EMPTY_PREDICATES_DIGEST);
  });

  it('domain + wallet signing strings match byte-for-byte', () => {
    const d = DOMAIN_ENVELOPE;
    expect(challengeSigningString({
      audience: d.audience, challenge: d.challenge, issuedAt: d.issuedAt!, expiresAt: d.expiresAt!,
      requester: d.requester!, presenter: d.presenter, predicates: d.predicates,
    })).toBe(DOMAIN_SIGNING_STRING);
    const w = WALLET_ENVELOPE;
    expect(challengeSigningString({
      audience: w.audience, challenge: w.challenge, issuedAt: w.issuedAt!, expiresAt: w.expiresAt!,
      requester: w.requester!, presenter: w.presenter, predicates: w.predicates,
    })).toBe(WALLET_SIGNING_STRING);
  });

  it('the predicate digest is order-independent but NOT input-independent (RED control)', () => {
    const reversed = [...DOMAIN_ENVELOPE.predicates!].reverse();
    expect(challengePredicatesDigest(reversed)).toBe(challengePredicatesDigest(DOMAIN_ENVELOPE.predicates));
    expect(challengePredicatesDigest([{ field: 'work.total', op: 'gte', threshold: 11 }]))
      .not.toBe(challengePredicatesDigest([{ field: 'work.total', op: 'gte', threshold: 10 }]));
  });

  it('Ed25519 from the pinned seed reproduces both envelope signatures and the public key', () => {
    const priv = testPrivateKey();
    const jwk = createPublicKey(priv).export({ format: 'jwk' }) as { x: string };
    expect(jwk.x).toBe(TEST_PUBLIC_X);
    expect(edSign(null, Buffer.from(DOMAIN_SIGNING_STRING, 'utf8'), priv).toString('base64url')).toBe(DOMAIN_ENVELOPE.sig);
    expect(edSign(null, Buffer.from(WALLET_SIGNING_STRING, 'utf8'), priv).toString('base64url')).toBe(WALLET_ENVELOPE.sig);
  });

  it('requesterString renders both identity kinds (wallet address lowercased)', () => {
    expect(requesterString({ type: 'domain', id: 'gate.example.com' })).toBe('domain:gate.example.com');
    expect(requesterString({ type: 'wallet', id: 'wallet_aw_test1', address: PRESENTER.toUpperCase().replace('0X', '0x') }))
      .toBe(`wallet:wallet_aw_test1:${PRESENTER}`);
  });
});

describe(' presentation binding v2 — pinned vectors', () => {
  it('a signed-challenge binding appends req= and chal_exp= under the v2 tag', () => {
    expect(presentationBindingString({
      tier: 'reputation', presenterAddress: PRESENTER, aud: 'gate.example.com', chal: 'a'.repeat(64),
      iat: 1790000100, exp: 1790000400, jti: 'pres_x', burnId: 'c'.repeat(64), claimsDigest: 'd'.repeat(64),
      requester: { type: 'domain', id: 'gate.example.com' }, chalExp: 1790000900,
    })).toBe(BINDING_V2);
    expect(presentationBindingString({
      tier: 'pe_fact', presenterAddress: '0xABC0000000000000000000000000000000000001', aud: 'wallet_aw_test1',
      chal: 'b'.repeat(64), iat: 1790000100, exp: 1790000400, jti: 'pres_y', burnId: 'e'.repeat(64),
      claimsDigest: 'f'.repeat(64),
      requester: { type: 'wallet', id: 'wallet_aw_test1', address: PRESENTER }, chalExp: 1790003600,
    })).toBe(BINDING_V2_WALLET);
    expect(BINDING_V2.split('\n')[0]).toBe(PRESENTATION_BINDING_TAG_V2);
  });

  it('RED control: without requester + chal_exp the binding stays v1 (byte-identical to before)', () => {
    const v1 = presentationBindingString({
      tier: 'reputation', presenterAddress: PRESENTER, aud: 'gate.example.com', chal: 'a'.repeat(64),
      iat: 1790000100, exp: 1790000400, jti: 'pres_x', burnId: 'c'.repeat(64), claimsDigest: 'd'.repeat(64),
    });
    expect(v1).not.toBe(BINDING_V2);
    expect(v1.split('\n')[0]).toBe('provian-presentation-v1');
    expect(v1).toBe(BINDING_V2.split('\n').slice(0, 10).join('\n').replace('provian-presentation-v2', 'provian-presentation-v1'));
  });
});

describe(' presenter verdict (A.3)', () => {
  const opts = { fetchRequesterKeys: async () => DOMAIN_KEYS, provianKeys: PROVIAN_KEYS, nowSeconds: NOW_IN_WINDOW };

  it('the pinned domain envelope verifies for its addressed presenter', async () => {
    const v = await verifyChallengeEnvelope(DOMAIN_ENVELOPE, { ...opts, presenterAddress: PRESENTER });
    expect(v.status).toBe('verified');
    expect(describeVerdict(v)).toMatchObject({ status: 'verified', identity: { type: 'domain', id: 'gate.example.com' } });
  });

  it('the pinned wallet envelope verifies against the Provian keys', async () => {
    const v = await verifyChallengeEnvelope(WALLET_ENVELOPE, opts);
    expect(v.status).toBe('verified');
    expect(describeVerdict(v).identity).toEqual({ type: 'wallet', id: 'wallet_aw_test1', address: PRESENTER });
  });

  it('an unsigned legacy challenge is unverified (allowed)', async () => {
    const legacy = parseChallengeEnvelope({ audience: 'gate.example.com', challenge: 'a'.repeat(64) })!;
    expect(isSignedChallenge(legacy)).toBe(false);
    const v = await verifyChallengeEnvelope(legacy, opts);
    expect(v.status).toBe('unverified');
    expect(describeVerdict(v).display).toContain('unverified (unsigned challenge)');
  });

  it('RED controls: tampered / expired / wrongly addressed / unbound audience / unreachable key', async () => {
    const tampered = { ...DOMAIN_ENVELOPE, challenge: 'f'.repeat(64) };
    expect(await verifyChallengeEnvelope(tampered, opts)).toMatchObject({ status: 'invalid', reason: 'bad_signature' });
    expect((await verifyChallengeEnvelope(DOMAIN_ENVELOPE, { ...opts, nowSeconds: 1790000900 + 61 })).status).toBe('expired');
    // Inside the 60 s skew it is still verified — the boundary is exp + 60, not exp.
    expect((await verifyChallengeEnvelope(DOMAIN_ENVELOPE, { ...opts, nowSeconds: 1790000900 + 60 })).status).toBe('verified');
    expect((await verifyChallengeEnvelope(DOMAIN_ENVELOPE, { ...opts, presenterAddress: '0x' + '1'.repeat(40) })).status)
      .toBe('not_addressed');
    expect(await verifyChallengeEnvelope({ ...DOMAIN_ENVELOPE, audience: 'other.example.com' }, opts))
      .toMatchObject({ status: 'invalid', reason: 'audience_not_requester' });
    expect(await verifyChallengeEnvelope(DOMAIN_ENVELOPE, { ...opts, fetchRequesterKeys: async () => { throw new Error('down'); } }))
      .toMatchObject({ status: 'invalid', reason: 'requester_key_unreachable' });
    expect(await verifyChallengeEnvelope(WALLET_ENVELOPE, { nowSeconds: NOW_IN_WINDOW }))
      .toMatchObject({ status: 'invalid', reason: 'requester_key_unreachable' });
    // A signature claim with no requester is signed-but-invalid, never "unsigned".
    const { requester: _r, ...sigOnly } = DOMAIN_ENVELOPE;
    expect((await verifyChallengeEnvelope(sigOnly, opts)).status).toBe('invalid');
    // Window outside 60..604800.
    expect(await verifyChallengeEnvelope({ ...DOMAIN_ENVELOPE, expiresAt: 1790000000 + 604801 }, opts))
      .toMatchObject({ status: 'invalid', reason: 'bad_window' });
  });

  it('the wallet key is matched by kid — a same-bytes key under another kid is key_not_found', async () => {
    expect(await verifyChallengeEnvelope(WALLET_ENVELOPE, { ...opts, provianKeys: DOMAIN_KEYS }))
      .toMatchObject({ status: 'invalid', reason: 'key_not_found' });
  });
});

describe(' domain requester key fetch — SSRF guard (Security Invariant #6)', () => {
  it('refuses IP literals, localhost and non-hostnames before any network call', async () => {
    const resolveHostname = vi.fn(async () => ['93.184.216.34']);
    const get = vi.fn(async () => Buffer.from(JSON.stringify({ keys: DOMAIN_KEYS })));
    for (const bad of ['127.0.0.1', 'localhost', 'foo.localhost', '169.254.169.254', 'Gate.Example.com', 'gate', '[::1]']) {
      await expect(fetchRequesterKeysGuarded(bad, { resolveHostname, get })).rejects.toThrow();
    }
    expect(resolveHostname).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('refuses a hostname resolving to any private address, fetches a public one pinned', async () => {
    const get = vi.fn(async () => Buffer.from(JSON.stringify({ keys: DOMAIN_KEYS })));
    await expect(fetchRequesterKeysGuarded('rebind.example.com', {
      resolveHostname: async () => ['93.184.216.34', '10.0.0.5'], get,
    })).rejects.toThrow(/private/);
    expect(get).not.toHaveBeenCalled();
    const keys = await fetchRequesterKeysGuarded('gate-ok.example.com', { resolveHostname: async () => ['93.184.216.34'], get });
    expect(keys).toEqual(DOMAIN_KEYS);
    expect(get).toHaveBeenCalledWith('https://gate-ok.example.com/.well-known/provian-requester.json', '93.184.216.34');
  });

  it('isPrivateIp blocks the private / loopback / link-local / mapped ranges and passes a public address', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1',
      '224.0.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:10.0.0.1', '::ffff:7f00:1', 'ff02::1', 'not-an-ip',
      // 2026-10-17 (RED on the text-matching form): the same addresses spelled differently.
      '0:0:0:0:0:0:0:1', '[::1]', '0000:0000:0000:0000:0000:ffff:7f00:0001', 'fe80::1%en0', '64:ff9b::7f00:1', '2002:a9fe:a9fe::', '1:2:3:4:5:6:7::8',
      // Reviewer 2026-10-17: the IPv4-translated form (SIIT) parsed as public; every ::/80 embedding form is refused outright.
      '::ffff:0:7f00:1', '::ffff:0:a9fe:a9fe', '::ffff:0:5db8:d822', '::ffff:93.184.216.34', '::5db8:d822']) {
      expect(isPrivateIp(ip)).toBe(true);
    }
    expect(isPrivateIp('93.184.216.34')).toBe(false);
    expect(isPrivateIp('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
    // A PUBLIC v4 behind NAT64 / 6to4 is the same public host (DNS64 on an IPv6-only box).
    expect(isPrivateIp('64:ff9b::5db8:d822')).toBe(false);
    expect(isPrivateIp('2002:5db8:d822::')).toBe(false);
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
