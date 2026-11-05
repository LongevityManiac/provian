/**
 * signed challenges — cross-package vectors + the presenter-side verdicts (A.3).
 *
 * The vectors are pinned byte-for-byte from the spec vector set; the relay
 * (`provian-backend/src/core/presentation/challenge.test.ts`) and the SDK pin the same values.
 * If this package drifts, its presenter would show "invalid" for every real signed challenge (or,
 * worse, sign a v2 binding the relay rebuilds differently and strand the burn).
 */
import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { ethers } from 'ethers';
import {
    challengeSigningString,
    challengePredicatesDigest,
    parseChallengeEnvelope,
    verifyChallengeEnvelope,
    fetchRequesterKeysHttps,
    isFetchableRequesterDomain,
    base64UrlToBytes,
    REQUESTER_KEY_DOC_MAX_BYTES,
    type ChallengeEnvelope,
    type KeyFetch,
    type RequesterJwk,
} from './challengeEnvelope';
import { challengeDisclosuresDigest, disclosureCommitmentDigest, normalizeDisclosureRequests, parseDisclosureAnswers } from './disclosureRequest';
import { presentationBindingString, buildHumanPresentationRequest } from './humanPresentation';

// ── Pinned vectors (D477_VECTORS.json) ────────────────────────────────────────────────────────
const TEST_SEED_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const TEST_PUBLIC_JWK = { crv: 'Ed25519', x: 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg', kty: 'OKP' };
const EMPTY_PREDICATES_DIGEST = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const DOMAIN_SIGNING_STRING = 'provian-challenge-v1\naud=gate.example.com\nchal=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\niat=1790000000\nexp=1790000900\nreq=domain:gate.example.com\nkid=k1\npresenter=0x5e645329ea23a84d6fb6006376f0b2b5e3b575f5\npredicates=da4ebf087a6a4e7346e6bf971b59df8942f22381d2e04b7de563a919b6d9b653';
const DOMAIN_ENVELOPE: ChallengeEnvelope = {
    v: 1,
    audience: 'gate.example.com',
    challenge: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    predicates: [
        { field: 'work.total', op: 'gte', threshold: 10 },
        { field: 'standing.adverse_events', op: 'in', set: [0] },
    ],
    issuedAt: 1790000000,
    expiresAt: 1790000900,
    presenter: '0x5e645329ea23a84d6fb6006376f0b2b5e3b575f5',
    requester: { type: 'domain', id: 'gate.example.com', kid: 'k1' },
    sig: '_SqvAe4KegEr31znYlpNJ6qjvcpU1lKxx2LCVJQdCuHKom5D37Dbi4K8VLEnt8s5McAPq__srMwSSYFlgVbKBw',
};
const WALLET_SIGNING_STRING = 'provian-challenge-v1\naud=wallet_aw_test1\nchal=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\niat=1790000000\nexp=1790003600\nreq=wallet:wallet_aw_test1:0x5e645329ea23a84d6fb6006376f0b2b5e3b575f5\nkid=provian-commerce-2026-08a\npresenter=\npredicates=4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const WALLET_ENVELOPE: ChallengeEnvelope = {
    v: 1,
    audience: 'wallet_aw_test1',
    challenge: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    issuedAt: 1790000000,
    expiresAt: 1790003600,
    requester: { type: 'wallet', id: 'wallet_aw_test1', address: '0x5e645329ea23a84d6fb6006376f0b2b5e3b575f5', kid: 'provian-commerce-2026-08a' },
    sig: '3T4r5igsr6mP2cyg34xzcnzFFYu-KOOMp23lJ6YR7wHgQNmTvcOI_7UbcLQDo30-7ld1efnQc2UQXAvMCDapDA',
};
const BINDING_V2 = 'provian-presentation-v2\ntier=reputation\npresenter=0x5e645329ea23a84d6fb6006376f0b2b5e3b575f5\naud=gate.example.com\nchal=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\niat=1790000100\nexp=1790000400\njti=pres_x\nburn=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\nclaims=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\nreq=domain:gate.example.com\nchal_exp=1790000900';
const BINDING_V2_WALLET = 'provian-presentation-v2\ntier=pe_fact\npresenter=0xabc0000000000000000000000000000000000001\naud=wallet_aw_test1\nchal=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\niat=1790000100\nexp=1790000400\njti=pres_y\nburn=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\nclaims=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\nreq=wallet:wallet_aw_test1:0x5e645329ea23a84d6fb6006376f0b2b5e3b575f5\nchal_exp=1790003600';

const PRESENTER = '0x5e645329ea23a84d6fb6006376f0b2b5e3b575f5';
const OTHER_PRESENTER = '0x1111111111111111111111111111111111111111';
const IN_WINDOW = 1790000500;
const DOMAIN_KEYS: RequesterJwk[] = [{ kty: 'OKP', crv: 'Ed25519', x: TEST_PUBLIC_JWK.x, kid: 'k1' }];
const PROVIAN_KEYS: RequesterJwk[] = [{ kty: 'OKP', crv: 'Ed25519', x: TEST_PUBLIC_JWK.x, kid: 'provian-commerce-2026-08a' }];
const fetchDomainKeys = async (): Promise<RequesterJwk[]> => DOMAIN_KEYS;

function b64url(bytes: Uint8Array): string {
    let s = '';
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let i = 0;
    for (; i + 2 < bytes.length; i += 3) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        s += A[(n >> 18) & 63] + A[(n >> 12) & 63] + A[(n >> 6) & 63] + A[n & 63];
    }
    const rem = bytes.length - i;
    if (rem === 1) { const n = bytes[i] << 16; s += A[(n >> 18) & 63] + A[(n >> 12) & 63]; }
    if (rem === 2) { const n = (bytes[i] << 16) | (bytes[i + 1] << 8); s += A[(n >> 18) & 63] + A[(n >> 12) & 63] + A[(n >> 6) & 63]; }
    return s;
}

/** Sign a (possibly modified) envelope with the vector test key — the same key the vectors use. */
function signWithTestKey(fields: Omit<ChallengeEnvelope, 'sig'>): ChallengeEnvelope {
    const msg = challengeSigningString({
        audience: fields.audience, challenge: fields.challenge, issuedAt: fields.issuedAt as number,
        expiresAt: fields.expiresAt as number, requester: fields.requester!, presenter: fields.presenter,
        predicates: fields.predicates,
    });
    return { ...fields, sig: b64url(ed25519.sign(utf8ToBytes(msg), hexToBytes(TEST_SEED_HEX))) };
}

describe('pinned vectors (cross-package)', () => {
    it('the test seed derives the pinned public JWK', () => {
        expect(b64url(ed25519.getPublicKey(hexToBytes(TEST_SEED_HEX)))).toBe(TEST_PUBLIC_JWK.x);
        expect(bytesToHex(base64UrlToBytes(TEST_PUBLIC_JWK.x)!)).toBe(bytesToHex(ed25519.getPublicKey(hexToBytes(TEST_SEED_HEX))));
    });

    it('empty predicate list digests to sha256("[]")', () => {
        expect(challengePredicatesDigest(undefined)).toBe(EMPTY_PREDICATES_DIGEST);
        expect(challengePredicatesDigest([])).toBe(EMPTY_PREDICATES_DIGEST);
    });

    it('domain signing string matches byte-for-byte (predicates canonicalized + sorted)', () => {
        const e = DOMAIN_ENVELOPE;
        expect(challengeSigningString({
            audience: e.audience, challenge: e.challenge, issuedAt: e.issuedAt!, expiresAt: e.expiresAt!,
            requester: e.requester!, presenter: e.presenter, predicates: e.predicates,
        })).toBe(DOMAIN_SIGNING_STRING);
        // Order-independent: the reversed predicate list commits to the same digest.
        expect(challengePredicatesDigest([...(e.predicates ?? [])].reverse())).toBe(DOMAIN_SIGNING_STRING.split('predicates=')[1]);
    });

    it('wallet signing string matches byte-for-byte (empty presenter line, empty predicates)', () => {
        const e = WALLET_ENVELOPE;
        expect(challengeSigningString({
            audience: e.audience, challenge: e.challenge, issuedAt: e.issuedAt!, expiresAt: e.expiresAt!,
            requester: e.requester!, presenter: e.presenter, predicates: e.predicates,
        })).toBe(WALLET_SIGNING_STRING);
    });

    it('both pinned envelope signatures verify under the test public key', () => {
        const pub = base64UrlToBytes(TEST_PUBLIC_JWK.x)!;
        expect(ed25519.verify(base64UrlToBytes(DOMAIN_ENVELOPE.sig!)!, utf8ToBytes(DOMAIN_SIGNING_STRING), pub)).toBe(true);
        expect(ed25519.verify(base64UrlToBytes(WALLET_ENVELOPE.sig!)!, utf8ToBytes(WALLET_SIGNING_STRING), pub)).toBe(true);
        // RED control: the domain sig does not verify the wallet string.
        expect(ed25519.verify(base64UrlToBytes(DOMAIN_ENVELOPE.sig!)!, utf8ToBytes(WALLET_SIGNING_STRING), pub)).toBe(false);
    });

    it('binding v2 (domain requester) matches byte-for-byte', () => {
        expect(presentationBindingString({
            tier: 'reputation', presenterAddress: PRESENTER, aud: 'gate.example.com', chal: 'a'.repeat(64),
            iat: 1790000100, exp: 1790000400, jti: 'pres_x', burnId: 'c'.repeat(64), claimsDigest: 'd'.repeat(64),
            requester: { type: 'domain', id: 'gate.example.com' }, chalExp: 1790000900,
        })).toBe(BINDING_V2);
    });

    it('binding v2 (wallet requester) matches byte-for-byte, address lowercased', () => {
        expect(presentationBindingString({
            tier: 'pe_fact', presenterAddress: '0xABC0000000000000000000000000000000000001', aud: 'wallet_aw_test1', chal: 'b'.repeat(64),
            iat: 1790000100, exp: 1790000400, jti: 'pres_y', burnId: 'e'.repeat(64), claimsDigest: 'f'.repeat(64),
            requester: { type: 'wallet', id: 'wallet_aw_test1', address: PRESENTER.toUpperCase().replace('0X', '0x') }, chalExp: 1790003600,
        })).toBe(BINDING_V2_WALLET);
    });

    it('without requester + chal_exp the binding stays v1 (unsigned challenge is byte-identical to before)', () => {
        const v1 = presentationBindingString({
            tier: 'reputation', presenterAddress: PRESENTER, aud: 'gate.example.com', chal: 'a'.repeat(64),
            iat: 1790000100, exp: 1790000400, jti: 'pres_x', burnId: 'c'.repeat(64), claimsDigest: 'd'.repeat(64),
        });
        expect(v1.startsWith('provian-presentation-v1\n')).toBe(true);
        expect(v1).toBe(BINDING_V2.replace('provian-presentation-v2', 'provian-presentation-v1').split('\nreq=')[0]);
    });
});

describe('verifyChallengeEnvelope — the A.3 verdicts', () => {
    it('verified: domain envelope, key from the domain, in window, addressed to me', async () => {
        const v = await verifyChallengeEnvelope(DOMAIN_ENVELOPE, { fetchRequesterKeys: fetchDomainKeys, nowSeconds: IN_WINDOW, presenterAddress: PRESENTER.toUpperCase().replace('0X', '0x') });
        expect(v.status).toBe('verified');
        if (v.status === 'verified') expect(v.requester).toEqual({ type: 'domain', id: 'gate.example.com' });
    });

    it('verified: wallet envelope against the Provian JWKS', async () => {
        const v = await verifyChallengeEnvelope(WALLET_ENVELOPE, { provianKeys: PROVIAN_KEYS, nowSeconds: IN_WINDOW });
        expect(v.status).toBe('verified');
        if (v.status === 'verified') expect(v.requester).toEqual({ type: 'wallet', id: 'wallet_aw_test1', address: PRESENTER });
    });

    it('unverified: an unsigned legacy challenge (parsed from JSON text)', async () => {
        const env = parseChallengeEnvelope(JSON.stringify({ audience: 'gate.example.com', challenge: 'a'.repeat(64) }))!;
        expect(env).not.toBeNull();
        expect((await verifyChallengeEnvelope(env, { nowSeconds: IN_WINDOW })).status).toBe('unverified');
    });

    it('RED invalid: a tampered challenge (one byte) fails the signature', async () => {
        const tampered = { ...DOMAIN_ENVELOPE, challenge: `${'a'.repeat(63)}b` };
        const v = await verifyChallengeEnvelope(tampered, { fetchRequesterKeys: fetchDomainKeys, nowSeconds: IN_WINDOW, presenterAddress: PRESENTER });
        expect(v).toMatchObject({ status: 'invalid', reason: 'bad_signature' });
    });

    it('RED invalid: a tampered predicate threshold fails the signature', async () => {
        const tampered = { ...DOMAIN_ENVELOPE, predicates: [{ field: 'work.total', op: 'gte' as const, threshold: 1 }, DOMAIN_ENVELOPE.predicates![1]] };
        const v = await verifyChallengeEnvelope(tampered, { fetchRequesterKeys: fetchDomainKeys, nowSeconds: IN_WINDOW, presenterAddress: PRESENTER });
        expect(v).toMatchObject({ status: 'invalid', reason: 'bad_signature' });
    });

    it('RED invalid: the wallet envelope under a different key / kid', async () => {
        const otherKey = b64url(ed25519.getPublicKey(hexToBytes('11'.repeat(32))));
        expect(await verifyChallengeEnvelope(WALLET_ENVELOPE, { provianKeys: [{ kty: 'OKP', crv: 'Ed25519', x: otherKey, kid: 'provian-commerce-2026-08a' }], nowSeconds: IN_WINDOW }))
            .toMatchObject({ status: 'invalid', reason: 'bad_signature' });
        expect(await verifyChallengeEnvelope(WALLET_ENVELOPE, { provianKeys: DOMAIN_KEYS, nowSeconds: IN_WINDOW }))
            .toMatchObject({ status: 'invalid', reason: 'key_not_found' });
    });

    it('RED invalid: no key source is never a pass (Unknown = Block)', async () => {
        expect(await verifyChallengeEnvelope(WALLET_ENVELOPE, { nowSeconds: IN_WINDOW })).toMatchObject({ status: 'invalid', reason: 'requester_key_unreachable' });
        expect(await verifyChallengeEnvelope(DOMAIN_ENVELOPE, { nowSeconds: IN_WINDOW })).toMatchObject({ status: 'invalid', reason: 'requester_key_unreachable' });
        const unreachable = async (): Promise<RequesterJwk[]> => { throw new Error('ECONNREFUSED'); };
        expect(await verifyChallengeEnvelope(DOMAIN_ENVELOPE, { fetchRequesterKeys: unreachable, nowSeconds: IN_WINDOW })).toMatchObject({ status: 'invalid', reason: 'requester_key_unreachable' });
    });

    it('RED invalid: audience not bound to the requester, a half-signed envelope, a bad window', async () => {
        const opts = { fetchRequesterKeys: fetchDomainKeys, nowSeconds: IN_WINDOW };
        expect(await verifyChallengeEnvelope({ ...DOMAIN_ENVELOPE, audience: 'other.example.com' }, opts)).toMatchObject({ status: 'invalid', reason: 'audience_not_requester' });
        const { sig: _sig, ...noSig } = DOMAIN_ENVELOPE;
        expect(await verifyChallengeEnvelope(noSig, opts)).toMatchObject({ status: 'invalid', reason: 'bad_signature' });
        const { requester: _r, ...noRequester } = DOMAIN_ENVELOPE;
        expect(await verifyChallengeEnvelope(noRequester, opts)).toMatchObject({ status: 'invalid', reason: 'bad_requester' });
        expect(await verifyChallengeEnvelope({ ...DOMAIN_ENVELOPE, expiresAt: 1790000000 + 604801 }, opts)).toMatchObject({ status: 'invalid', reason: 'bad_window' });
        expect(await verifyChallengeEnvelope({ ...DOMAIN_ENVELOPE, v: 2 }, opts)).toMatchObject({ status: 'invalid', reason: 'unsupported_version' });
    });

    it('a seven-day signed window is accepted (async thread / remote requests)', async () => {
        const env = signWithTestKey({ ...WALLET_ENVELOPE, expiresAt: 1790000000 + 604800 });
        expect((await verifyChallengeEnvelope(env, { provianKeys: PROVIAN_KEYS, nowSeconds: IN_WINDOW })).status).toBe('verified');
    });

    it('RED invalid: an IP-literal or localhost domain requester is refused before any fetch', async () => {
        let fetched = 0;
        const counting = async (): Promise<RequesterJwk[]> => { fetched++; return DOMAIN_KEYS; };
        for (const host of ['127.0.0.1', '10.0.0.1', 'localhost', '[::1]', '169.254.169.254']) {
            const env = { ...DOMAIN_ENVELOPE, audience: host, requester: { type: 'domain' as const, id: host, kid: 'k1' } };
            expect(await verifyChallengeEnvelope(env, { fetchRequesterKeys: counting, nowSeconds: IN_WINDOW })).toMatchObject({ status: 'invalid', reason: 'bad_requester' });
        }
        expect(fetched).toBe(0);
    });

    it('expired: signature holds but now > expiresAt + 60', async () => {
        const opts = { fetchRequesterKeys: fetchDomainKeys, presenterAddress: PRESENTER };
        expect((await verifyChallengeEnvelope(DOMAIN_ENVELOPE, { ...opts, nowSeconds: 1790000900 + 60 })).status).toBe('verified');
        expect((await verifyChallengeEnvelope(DOMAIN_ENVELOPE, { ...opts, nowSeconds: 1790000900 + 61 })).status).toBe('expired');
    });

    it('not_addressed: signature holds but the challenge names another presenter', async () => {
        const v = await verifyChallengeEnvelope(DOMAIN_ENVELOPE, { fetchRequesterKeys: fetchDomainKeys, nowSeconds: IN_WINDOW, presenterAddress: OTHER_PRESENTER });
        expect(v.status).toBe('not_addressed');
    });
});

describe('fetchRequesterKeysHttps — SSRF / abuse guards', () => {
    const DOC = JSON.stringify({ keys: [{ kty: 'OKP', crv: 'Ed25519', x: TEST_PUBLIC_JWK.x, kid: 'k1' }] });
    function fakeFetch(res: Partial<Awaited<ReturnType<KeyFetch>>> & { body?: string }, seen: string[] = []): KeyFetch {
        return async (url, init) => {
            seen.push(url);
            expect(init.redirect).toBe('manual');
            return {
                ok: res.ok ?? true, status: res.status ?? 200, url: res.url ?? url, type: res.type, redirected: res.redirected,
                headers: res.headers ?? { get: () => null }, text: async () => res.body ?? DOC,
            };
        };
    }

    it('fetches https://<domain>/.well-known/provian-requester.json and parses Ed25519 keys', async () => {
        const seen: string[] = [];
        const keys = await fetchRequesterKeysHttps('gate.example.com', { fetchImpl: fakeFetch({}, seen) });
        expect(seen).toEqual(['https://gate.example.com/.well-known/provian-requester.json']);
        expect(keys).toEqual(DOMAIN_KEYS);
    });

    it('RED: IP literals and localhost are refused without a request', async () => {
        const seen: string[] = [];
        for (const host of ['127.0.0.1', '192.168.1.1', 'localhost', 'api.localhost', '::1', 'gate.example.com:8443']) {
            expect(isFetchableRequesterDomain(host)).toBe(false);
            await expect(fetchRequesterKeysHttps(host, { fetchImpl: fakeFetch({}, seen) })).rejects.toThrow();
        }
        expect(seen).toHaveLength(0);
        expect(isFetchableRequesterDomain('gate.example.com')).toBe(true);
    });

    it('RED: a redirect (3xx, opaque, or followed to another URL) is refused', async () => {
        await expect(fetchRequesterKeysHttps('gate.example.com', { fetchImpl: fakeFetch({ ok: false, status: 302 }) })).rejects.toThrow(/redirect/);
        await expect(fetchRequesterKeysHttps('gate.example.com', { fetchImpl: fakeFetch({ ok: false, status: 0, type: 'opaqueredirect' }) })).rejects.toThrow(/redirect/);
        await expect(fetchRequesterKeysHttps('gate.example.com', { fetchImpl: fakeFetch({ redirected: true }) })).rejects.toThrow(/redirect/);
        await expect(fetchRequesterKeysHttps('gate.example.com', { fetchImpl: fakeFetch({ url: 'https://evil.example.net/.well-known/provian-requester.json' }) })).rejects.toThrow(/redirect/);
    });

    it('RED: a body over 64 KiB is refused (declared or actual)', async () => {
        const big = `{"keys":[],"pad":"${'x'.repeat(REQUESTER_KEY_DOC_MAX_BYTES)}"}`;
        await expect(fetchRequesterKeysHttps('gate.example.com', { fetchImpl: fakeFetch({ body: big }) })).rejects.toThrow(/too_large/);
        await expect(fetchRequesterKeysHttps('gate.example.com', { fetchImpl: fakeFetch({ headers: { get: (n: string) => (n.toLowerCase() === 'content-length' ? String(REQUESTER_KEY_DOC_MAX_BYTES + 1) : null) } }) })).rejects.toThrow(/too_large/);
    });

    it('RED: a slow host times out', async () => {
        const hang: KeyFetch = () => new Promise(() => undefined);
        await expect(fetchRequesterKeysHttps('gate.example.com', { fetchImpl: hang, timeoutMs: 20 })).rejects.toThrow(/timeout/);
    });

    it('RED: a non-2xx or malformed document is refused', async () => {
        await expect(fetchRequesterKeysHttps('gate.example.com', { fetchImpl: fakeFetch({ ok: false, status: 404 }) })).rejects.toThrow();
        await expect(fetchRequesterKeysHttps('gate.example.com', { fetchImpl: fakeFetch({ body: '{"nokeys":true}' }) })).rejects.toThrow();
    });
});

describe('buildHumanPresentationRequest — signed challenge → v2', () => {
    it('a SIGNED envelope yields the v2 binding (req + chal_exp) and rides as challenge_envelope', async () => {
        const wallet = ethers.Wallet.createRandom();
        const addr = wallet.address.toLowerCase();
        const { body, binding } = await buildHumanPresentationRequest(
            { tier: 'reputation', burnId: 'c'.repeat(64), audience: WALLET_ENVELOPE.audience, challenge: WALLET_ENVELOPE.challenge, nowSeconds: 1790000100, ttlSeconds: 300, jti: 'pres_z', challengeEnvelope: WALLET_ENVELOPE },
            addr, (m) => wallet.signMessage(m),
        );
        const lines = binding.split('\n');
        expect(lines[0]).toBe('provian-presentation-v2');
        expect(lines.slice(-2)).toEqual([`req=wallet:wallet_aw_test1:${PRESENTER}`, 'chal_exp=1790003600']);
        expect(body.challenge_envelope).toBe(WALLET_ENVELOPE);
        expect(ethers.verifyMessage(binding, body.pop.signature).toLowerCase()).toBe(addr);
    });

    it('an UNSIGNED envelope changes nothing: v1 binding, no challenge_envelope on the body', async () => {
        const wallet = ethers.Wallet.createRandom();
        const env = parseChallengeEnvelope({ audience: 'gate.example.com', challenge: 'a'.repeat(64) })!;
        const { body, binding } = await buildHumanPresentationRequest(
            { tier: 'reputation', burnId: 'c'.repeat(64), audience: env.audience, challenge: env.challenge, nowSeconds: 1790000100, jti: 'j', challengeEnvelope: env },
            wallet.address.toLowerCase(), (m) => wallet.signMessage(m),
        );
        expect(binding.startsWith('provian-presentation-v1\n')).toBe(true);
        expect(binding).not.toContain('\nreq=');
        expect(body.challenge_envelope).toBeUndefined();
    });

    it('RED: a signed envelope whose audience/challenge differ from what is being signed throws before signing', async () => {
        let signed = 0;
        await expect(buildHumanPresentationRequest(
            { tier: 'reputation', burnId: 'c'.repeat(64), audience: 'someone-else', challenge: WALLET_ENVELOPE.challenge, challengeEnvelope: WALLET_ENVELOPE },
            PRESENTER, async () => { signed++; return '0x'; },
        )).rejects.toThrow();
        expect(signed).toBe(0);
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
