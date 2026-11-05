import {openTestPrivateRequest} from './private-request.test-support';
/**
 * every PRESENTER path verifies the requester's challenge BEFORE any burn.
 *
 * respondToChallenge / respondToPresentationRequest / presentInThread / answerChallenge / present:
 * a signed challenge that is invalid, expired, or addressed to someone else throws
 * ChallengeRefusedError and NOTHING is burned (sendBurn — the broadcast — and the /present POST are
 * spied and asserted never called; lets the PUBLIC floor read race the verification, since a
 * read moves nothing). An unsigned challenge proceeds as `unverified`; a verified one
 * proceeds and rides to /present as `challenge_envelope`. Requester side: CommonsInstitutions's
 * issuePresentationChallenge defaults to a relay WALLET-signed envelope, and verifyPresentation
 * passes the options through.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommonsInstitutions, type CommonsInstitutionsConfig } from './commons-institutions';
import { ChallengeRefusedError, generateRequesterKey, type ChallengeEnvelope, type RequesterJwk } from './challenge';
import * as presentationVerify from './presentation-verify';
import { deriveAddressFromPrivateKey } from './wallet';
import { burnIdForTx } from './presentation';

vi.mock('./presentation-verify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./presentation-verify')>();
  return { ...actual, verifyPresentationToken: vi.fn(actual.verifyPresentationToken) };
});

const KEY = 'a'.repeat(64);
// the default presenter path BROADCASTS via sendBurn (the relay records the burn at finality
// inside /present), so sendBurn is the call that moves money and the one every RED control spies on.
const BURN_TX = '0x' + 'be'.repeat(32);
const fakeSendBurn = async (p: { amountAtomic: string | bigint }) =>
  ({ txHash: BURN_TX, burnId: burnIdForTx('base', BURN_TX), amountAtomic: String(p.amountAtomic), chain: 'base' as const });
const MY_ADDRESS = deriveAddressFromPrivateKey(KEY).toLowerCase();
const RPC = 'https://base-rpc.test';
const NOW = 1790000100;

// The pinned relay vector (D477_VECTORS.json): the seed key's public x + its wallet envelope.
const SEED_X = 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg';
const WALLET_ENVELOPE: ChallengeEnvelope = {
  v: 1, audience: 'wallet_aw_test1', challenge: 'b'.repeat(64), issuedAt: 1790000000, expiresAt: 1790003600,
  requester: { type: 'wallet', id: 'wallet_aw_test1', address: '0x5e645329ea23a84d6fb6006376f0b2b5e3b575f5', kid: 'provian-commerce-2026-08a' },
  sig: '3T4r5igsr6mP2cyg34xzcnzFFYu-KOOMp23lJ6YR7wHgQNmTvcOI_7UbcLQDo30-7ld1efnQc2UQXAvMCDapDA',
};

const DOMAIN_KEY = generateRequesterKey({ kid: 'k1' });
const DOMAIN_KEYS: RequesterJwk[] = [DOMAIN_KEY.publicJwk];
const fetchRequesterKeys = async () => DOMAIN_KEYS;

function domainChallenge(opts: { presenter?: string; nowSeconds?: number; ttlSeconds?: number } = {}): ChallengeEnvelope {
  return presentationVerify.issuePresentationChallenge({
    requester: { domain: 'gate.example.com', kid: DOMAIN_KEY.kid, privateKeyPem: DOMAIN_KEY.privateKeyPem },
    presenter: opts.presenter, nowSeconds: opts.nowSeconds ?? NOW - 100, ttlSeconds: opts.ttlSeconds,
  });
}

interface Call { url: string; method: string; body: unknown }
function relayStub(routes: Record<string, unknown>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: String(init?.method ?? 'GET'), body: init?.body ? openTestPrivateRequest(JSON.parse(String(init.body)),String(input),init?.headers) : undefined });
    const path = url.replace('https://relay.test', '').split('?')[0];
    if (path in routes) return new Response(JSON.stringify(routes[path]), { status: 200 });
    return new Response(JSON.stringify({ error: 'no route' }), { status: 404 });
  }) as typeof fetch;
  return { fetch: f, calls };
}

const WALLET = 'wallet_aw_me';
function makeInstitutions(routes: Record<string, unknown> = {}): { institutions: CommonsInstitutions; calls: Call[] } {
  const { fetch, calls } = relayStub({
    [`/v1/agent/wallet/${WALLET}/present/preflight`]: {ok:true},
    [`/v1/agent/wallet/${WALLET}/present`]: { tier: 'pe_fact', presentation: {}, token: 'TOKEN' },
    '/v1/present/jwks': { keys: [{ kty: 'OKP', crv: 'Ed25519', x: SEED_X, kid: 'provian-commerce-2026-08a' }] },
    ...routes,
  });
  const config: CommonsInstitutionsConfig = { relayUrl: 'https://relay.test', walletId: WALLET, apiKey: 'pvn_live_abc', apiSecret: 'pvns_' + 'x'.repeat(64), fetch };
  return { institutions: new CommonsInstitutions(config), calls };
}
const presentPosts = (calls: Call[]) => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/present'));

describe('respondToChallenge — the challenge is verified BEFORE the burn', () => {
  let institutions: CommonsInstitutions;
  let calls: Call[];
  let burnSpy: ReturnType<typeof vi.spyOn>;
  let floorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    ({ institutions, calls } = makeInstitutions());
    burnSpy = vi.spyOn(institutions, 'sendBurn').mockImplementation(fakeSendBurn);
    floorSpy = vi.spyOn(institutions, 'presentationFloorAtomic').mockResolvedValue(5n * 10n ** 18n);
  });

  it('RED: an EXPIRED signed challenge is refused — no burn, no /present', async () => {
    const env = domainChallenge({ nowSeconds: NOW - 10_000, ttlSeconds: 60 });
    const err = await institutions.respondToChallenge(env, { privateKeyHex: KEY, rpcUrl: RPC, fetchRequesterKeys, nowSeconds: NOW }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChallengeRefusedError);
    expect((err as ChallengeRefusedError).verdict.status).toBe('expired');
    expect(burnSpy).not.toHaveBeenCalled();
    expect(presentPosts(calls)).toHaveLength(0);
  });

  it('RED: an INVALID signature (tampered nonce) is refused — no burn', async () => {
    const env = { ...domainChallenge(), challenge: 'c'.repeat(64) };
    const err = await institutions.respondToChallenge(env, { privateKeyHex: KEY, rpcUrl: RPC, fetchRequesterKeys, nowSeconds: NOW }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChallengeRefusedError);
    expect((err as ChallengeRefusedError).verdict).toMatchObject({ status: 'invalid', reason: 'bad_signature' });
    expect(burnSpy).not.toHaveBeenCalled();
  });

  it('RED: a JSON-string challenge addressed to ANOTHER presenter is refused (not_addressed) — no burn', async () => {
    const env = domainChallenge({ presenter: '0x' + '1'.repeat(40) });
    const err = await institutions.respondToChallenge(JSON.stringify(env), { privateKeyHex: KEY, rpcUrl: RPC, fetchRequesterKeys, nowSeconds: NOW }).catch((e: unknown) => e);
    expect((err as ChallengeRefusedError).verdict.status).toBe('not_addressed');
    expect(burnSpy).not.toHaveBeenCalled();
  });

  it('RED: an unreachable requester key is refused (Unknown = Block) — no burn', async () => {
    const env = domainChallenge();
    const err = await institutions.respondToChallenge(env, { privateKeyHex: KEY, rpcUrl: RPC, fetchRequesterKeys: async () => { throw new Error('down'); }, nowSeconds: NOW }).catch((e: unknown) => e);
    expect((err as ChallengeRefusedError).verdict).toMatchObject({ status: 'invalid', reason: 'requester_key_unreachable' });
    expect(burnSpy).not.toHaveBeenCalled();
  });

  it('RED: onRequester returning false declines a VERIFIED challenge — no burn', async () => {
    const env = domainChallenge({ presenter: MY_ADDRESS });
    const onRequester = vi.fn(async () => false);
    const err = await institutions.respondToChallenge(env, { privateKeyHex: KEY, rpcUrl: RPC, fetchRequesterKeys, nowSeconds: NOW, onRequester }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChallengeRefusedError);
    expect((err as ChallengeRefusedError).declined).toBe(true);
    expect(onRequester).toHaveBeenCalledWith(expect.objectContaining({ status: 'verified' }));
    expect(burnSpy).not.toHaveBeenCalled();
  });

  it('a VERIFIED signed challenge (addressed to me) burns, then rides to /present as challenge_envelope', async () => {
    const env = domainChallenge({ presenter: MY_ADDRESS });
    const keySpy = vi.fn(fetchRequesterKeys);
    const r = await institutions.respondToChallenge(env, { privateKeyHex: KEY, rpcUrl: RPC, fetchRequesterKeys: keySpy, nowSeconds: NOW });
    expect(r.requesterVerdict).toMatchObject({ status: 'verified', requester: { type: 'domain', id: 'gate.example.com' } });
    expect(burnSpy).toHaveBeenCalledTimes(1);
    // Order: verify the challenge (key fetch) and read the floor → burn. present() reuses the verdict (one fetch).
    expect(keySpy).toHaveBeenCalledTimes(1);
    expect(keySpy.mock.invocationCallOrder[0]).toBeLessThan(burnSpy.mock.invocationCallOrder[0]);
    expect(floorSpy.mock.invocationCallOrder[0]).toBeLessThan(burnSpy.mock.invocationCallOrder[0]);
    const post = presentPosts(calls)[0];
    expect((post.body as { challenge_envelope?: unknown }).challenge_envelope).toEqual(JSON.parse(JSON.stringify(env)));
    // pipelining: the ONE /present carries the burn's tx; no separate /burn/record call.
    expect((post.body as { burn?: unknown }).burn).toEqual({ tx_hash: BURN_TX, amount_atomic: '5000000000000000000', chain: 'base' });
    expect(calls.some((c) => c.url.endsWith('/burn/record'))).toBe(false);
  });

  it('an UNSIGNED legacy challenge proceeds as `unverified` and sends no envelope (v1 unchanged)', async () => {
    const r = await institutions.respondToChallenge({ audience: 'gate.example.com', challenge: 'a'.repeat(64) }, { privateKeyHex: KEY, rpcUrl: RPC, nowSeconds: NOW });
    expect(r.requesterVerdict.status).toBe('unverified');
    expect(burnSpy).toHaveBeenCalledTimes(1);
    expect((presentPosts(calls)[0].body as { challenge_envelope?: unknown }).challenge_envelope).toBeUndefined();
  });

  it('a relay WALLET-signed challenge verifies against the institutions relay JWKS (pinned vector)', async () => {
    const r = await institutions.respondToChallenge(WALLET_ENVELOPE, { privateKeyHex: KEY, rpcUrl: RPC, nowSeconds: NOW });
    expect(r.requesterVerdict).toMatchObject({ status: 'verified', requester: { type: 'wallet', id: 'wallet_aw_test1' } });
    expect(calls.some((c) => c.url === 'https://relay.test/v1/present/jwks')).toBe(true);
  });
});

describe('the other presenter paths refuse before the burn is consumed', () => {
  it('RED: respondToPresentationRequest with an expired relay envelope — no burn', async () => {
    const { institutions } = makeInstitutions();
    const burnSpy = vi.spyOn(institutions, 'sendBurn').mockImplementation(fakeSendBurn);
    const env = domainChallenge({ nowSeconds: NOW - 10_000, ttlSeconds: 60 });
    const err = await institutions.respondToPresentationRequest(
      { request_id: 'preq_1', status: 'challenged', audience: env.audience, challenge: env.challenge, predicates: null, challenge_envelope: env },
      { privateKeyHex: KEY, rpcUrl: RPC, fetchRequesterKeys, nowSeconds: NOW },
    ).catch((e: unknown) => e);
    expect((err as ChallengeRefusedError).verdict.status).toBe('expired');
    expect(burnSpy).not.toHaveBeenCalled();
  });

  it('RED: respondToPresentationRequest whose envelope names a different nonce than the request — no burn', async () => {
    const { institutions } = makeInstitutions();
    const burnSpy = vi.spyOn(institutions, 'sendBurn').mockImplementation(fakeSendBurn);
    const env = domainChallenge();
    const err = await institutions.respondToPresentationRequest(
      { request_id: 'preq_1', status: 'challenged', audience: env.audience, challenge: 'd'.repeat(64), predicates: null, challenge_envelope: env },
      { privateKeyHex: KEY, rpcUrl: RPC, fetchRequesterKeys, nowSeconds: NOW },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChallengeRefusedError);
    expect(burnSpy).not.toHaveBeenCalled();
  });

  it('RED: presentInThread with an invalid signed envelope never POSTs /present (the burn is not consumed)', async () => {
    const env = { ...domainChallenge(), predicates: [{ field: 'work.total', op: 'gte' as const, threshold: 1 }] }; // predicate added after signing
    const { institutions, calls } = makeInstitutions({
      '/v1/threads/th_1/presentation-requests': { requests: [{ request_id: 'r1', audience: env.audience, challenge: env.challenge, tier: 'reputation', predicates: env.predicates, challenge_envelope: env }] },
    });
    const err = await institutions.presentInThread('th_1', 'r1', { privateKeyHex: KEY, burnId: 'burn_x', fetchRequesterKeys, nowSeconds: NOW }).catch((e: unknown) => e);
    expect((err as ChallengeRefusedError).verdict).toMatchObject({ status: 'invalid', reason: 'bad_signature' });
    expect(presentPosts(calls)).toHaveLength(0);
  });

  it('presentInThread with a verified envelope presents it and surfaces requesterVerdict', async () => {
    const env = domainChallenge();
    const { institutions, calls } = makeInstitutions({
      '/v1/threads/th_1/presentation-requests': { requests: [{ request_id: 'r1', audience: env.audience, challenge: env.challenge, tier: 'pe_fact', challenge_envelope: env }] },
      '/v1/threads/th_1/presentation-requests/r1/present': { ok: true },
    });
    const out = await institutions.presentInThread('th_1', 'r1', { privateKeyHex: KEY, burnId: 'burn_x', fetchRequesterKeys, nowSeconds: NOW });
    expect(out.requesterVerdict).toMatchObject({ status: 'verified' });
    const presentPost = calls.find((c) => c.url.endsWith(`/wallet/${WALLET}/present`));
    expect((presentPost?.body as { challenge_envelope?: unknown }).challenge_envelope).toBeDefined();
  });

  it('RED: answerChallenge with an expired envelope never POSTs /present', async () => {
    const env = domainChallenge({ nowSeconds: NOW - 10_000, ttlSeconds: 60 });
    const { institutions, calls } = makeInstitutions({
      '/v1/commons/forum/challenge/ch_1': { audience: env.audience, challenge_nonce: env.challenge, challenge_envelope: env },
    });
    const err = await institutions.answerChallenge('ch_1', { privateKeyHex: KEY, burnId: 'burn_x', fetchRequesterKeys, nowSeconds: NOW }).catch((e: unknown) => e);
    expect((err as ChallengeRefusedError).verdict.status).toBe('expired');
    expect(presentPosts(calls)).toHaveLength(0);
  });

  it('RED: present() called directly with an expired signed envelope never POSTs', async () => {
    const env = domainChallenge({ nowSeconds: NOW - 10_000, ttlSeconds: 60 });
    const { institutions, calls } = makeInstitutions();
    const err = await institutions.present({
      privateKeyHex: KEY, tier: 'pe_fact', burnId: 'burn_x', audience: env.audience, challenge: env.challenge,
      challengeEnvelope: env, fetchRequesterKeys, nowSeconds: NOW, peFacts: [{ peId: 'pe_1', envelopeHash: '0x' + 'ab'.repeat(32) }],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChallengeRefusedError);
    expect(presentPosts(calls)).toHaveLength(0);
  });
});

describe('CommonsInstitutions requester side', () => {
  it('issuePresentationChallenge defaults to a relay WALLET-signed envelope', async () => {
    const signed = { ...WALLET_ENVELOPE, audience: WALLET, requester: { ...WALLET_ENVELOPE.requester, id: WALLET } };
    const { institutions, calls } = makeInstitutions({ [`/v1/agent/wallet/${WALLET}/present/challenge`]: { challenge: signed } });
    const c = await institutions.issuePresentationChallenge({ predicates: [{ field: 'work.total', op: 'gte', threshold: 3 }], ttlSeconds: 86_400, presenter: '0x' + 'A'.repeat(40) });
    expect(c).toEqual(signed);
    const post = calls.find((x) => x.url.endsWith('/present/challenge'));
    expect(post?.method).toBe('POST');
    expect(post?.body).toEqual({ predicates: [{ field: 'work.total', op: 'gte', threshold: 3 }], ttl_seconds: 86_400, presenter: '0x' + 'a'.repeat(40) });
  });

  it('RED: a relay envelope naming ANOTHER wallet is refused', async () => {
    const { institutions } = makeInstitutions({ [`/v1/agent/wallet/${WALLET}/present/challenge`]: { challenge: WALLET_ENVELOPE } });
    await expect(institutions.issuePresentationChallenge()).rejects.toThrow(/different requester/);
  });

  it('RED: an unsigned relay answer is refused (never handed out as "signed")', async () => {
    const { institutions } = makeInstitutions({ [`/v1/agent/wallet/${WALLET}/present/challenge`]: { challenge: { audience: WALLET, challenge: 'a'.repeat(64) } } });
    await expect(institutions.issuePresentationChallenge()).rejects.toThrow(/not a valid signed challenge/);
  });

  it('sign:false issues an unsigned local challenge (no network) carrying predicates', async () => {
    const { institutions, calls } = makeInstitutions();
    const c = await institutions.issuePresentationChallenge({ sign: false, predicates: [{ field: 'work.total', op: 'gte', threshold: 3 }] });
    expect(c.audience).toBe(WALLET);
    expect(c.predicates).toEqual([{ field: 'work.total', op: 'gte', threshold: 3 }]);
    expect(c.sig).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('a requester key signs locally as a DOMAIN requester', async () => {
    const { institutions, calls } = makeInstitutions();
    const c = await institutions.issuePresentationChallenge({ requester: { domain: 'gate.example.com', kid: DOMAIN_KEY.kid, privateKeyPem: DOMAIN_KEY.privateKeyPem } });
    expect(c.requester).toEqual({ type: 'domain', id: 'gate.example.com', kid: 'k1' });
    expect(calls).toHaveLength(0);
  });

  it('verifyPresentation passes every option through (and no wallet-id audience when a challenge is given)', async () => {
    const { institutions } = makeInstitutions();
    const spy = vi.mocked(presentationVerify.verifyPresentationToken);
    spy.mockClear();
    const store = { claim: async () => true };
    const env = domainChallenge();
    await institutions.verifyPresentation('garbage', {
      challenge: env, expectedPresenter: MY_ADDRESS, acceptOnce: false, seenStore: store,
      requireOnchain: false, rpcUrl: 'https://my-rpc.test', peAnchorAddress: '0x' + '9'.repeat(40),
    });
    const opts = spy.mock.calls[0][1];
    expect(opts).toMatchObject({
      challenge: env, expectedPresenter: MY_ADDRESS, acceptOnce: false, seenStore: store,
      requireOnchain: false, rpcUrl: 'https://my-rpc.test', peAnchorAddress: '0x' + '9'.repeat(40),
      jwksUrl: 'https://relay.test/v1/present/jwks',
    });
    expect(opts.expectedAudience).toBeUndefined();
  });
});
