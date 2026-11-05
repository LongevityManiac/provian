/**
 * the SDK local verifier mirrors the relay verify contract (spec C), plus accept-once.
 *
 * Every rule ships with its RED control: the predicate gate refuses a pe_fact, an `in` predicate
 * verifies (the old verifier dropped its set → bad_presenter_pop), a second verify of one token is
 * `replayed`, a wrong presenter is `presenter_mismatch`, the on-chain check runs BY DEFAULT, a
 * signed challenge's deadline and requester bind a v2 presentation, and a v1 co-sign cannot be
 * lifted onto a v2 payload. Presentations are built by the real presenter code
 * (buildAgentPresentationRequest) and the Provian signatures by a test Ed25519 key.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import { keccak256, encodePacked } from 'viem';
import { buildAgentPresentationRequest, canonicalReputationDirective, claimsDigest, type PredicateRequest } from './presentation';

/** Computed by the RELAY's claimsDigest over its canonical share-only directive (cross-package pin). */
const SHARE_ONLY_DIGEST_PIN = '40762420742dc3f5739b06253468266de3215172e26e89bcc5a1d2f044082d1e';
import { deriveAgentIdentityFromPrivateKey } from './wallet';
import {
  issuePresentationChallenge,
  verifyPresentationToken,
  PROVIAN_BASE_PE_ANCHOR,
  DEFAULT_BASE_RPC_URL,
  PRESENTATION_ISSUER,
  PRESENTATION_PEFACT_TYP,
  PRESENTATION_TYP,
  STANDING_ALWAYS_PRESENT_FIELDS,
  type Presentation,
  type PresentationJwk,
} from './presentation-verify';
import peSchema from '../schema/pe-schema.json';
import { createMemorySeenStore, generateRequesterKey, type ChallengeEnvelope } from './challenge';

const { readContractMock, httpUrls } = vi.hoisted(() => ({ readContractMock: vi.fn(), httpUrls: [] as string[] }));
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: () => ({ readContract: readContractMock }),
    http: (url?: string) => { httpUrls.push(String(url)); return actual.http(url); },
  };
});
beforeEach(() => { readContractMock.mockReset(); httpUrls.length = 0; });

const AGENT_KEY = 'a'.repeat(64);
const { address: PRESENTER } = deriveAgentIdentityFromPrivateKey(AGENT_KEY);
const PRESENTER_LC = PRESENTER.toLowerCase();
const AUD = 'requester-agent-1';
const NOW = 1_800_000_000;
const HASH = '0x' + 'ab'.repeat(32);

const { privateKey: PROVIAN_PRIV, publicKey: PROVIAN_PUB } = crypto.generateKeyPairSync('ed25519');
const KID = 'test-provian-kid';
const JWKS: PresentationJwk[] = [{ kty: 'OKP', crv: 'Ed25519', x: (PROVIAN_PUB.export({ format: 'jwk' }) as { x: string }).x, kid: KID }];
function jws(payload: unknown, typ: string): string {
  const h = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ, kid: KID })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${h}.${p}.${crypto.sign(null, Buffer.from(`${h}.${p}`), PROVIAN_PRIV).toString('base64url')}`;
}
const leafOf = (h: string) => keccak256(encodePacked(['bytes1', 'bytes32'], ['0x00', h as `0x${string}`]));
/** Every always-present Standing fact at an observed zero — bound to the ONE list the verifier checks. */
const STANDING_ZERO: Record<string, number> = Object.fromEntries(STANDING_ALWAYS_PRESENT_FIELDS.map((f) => [f, 0]));
let burnSeq = 0;
const nextBurn = () => (++burnSeq).toString(16).padStart(64, '0');

/** A signed DOMAIN challenge envelope from a fresh requester key. */
function signedDomainChallenge(opts: { ttlSeconds?: number; nowSeconds?: number; predicates?: PredicateRequest[] } = {}): ChallengeEnvelope {
  const key = generateRequesterKey({ kid: 'k1' });
  return issuePresentationChallenge({
    requester: { domain: 'gate.example.com', kid: key.kid, privateKeyPem: key.privateKeyPem },
    ttlSeconds: opts.ttlSeconds, nowSeconds: opts.nowSeconds ?? NOW, predicates: opts.predicates,
  });
}

/** A reputation presentation as the relay issues it (v1, or v2 against a signed `env`). */
function buildReputation(opts: { predicates?: PredicateRequest[]; env?: ChallengeEnvelope; iat?: number; burnId?: string; audience?: string; challenge?: string; facts?: Record<string, number> } = {}): { presentation: Presentation; challenge: string; audience: string; burnId: string } {
  const env = opts.env;
  const audience = env ? env.audience : (opts.audience ?? AUD);
  const challenge = env ? env.challenge : (opts.challenge ?? issuePresentationChallenge({ audience }).challenge);
  const burnId = opts.burnId ?? nextBurn();
  const { body } = buildAgentPresentationRequest({
    privateKeyHex: AGENT_KEY, tier: 'reputation', burnId, audience, challenge, nowSeconds: opts.iat ?? NOW,
    disclosure: { redact: [], predicates: opts.predicates ?? [] }, challengeEnvelope: env,
  });
  const payload = {
    v: env ? 2 : 1, tier: 'reputation' as const, iss: PRESENTATION_ISSUER, sub: 'agent-wallet-x',
    presenter_address: PRESENTER_LC, aud: audience, chal: challenge, iat: body.iat, exp: body.exp, jti: body.jti,
    burn_id: burnId, presenter_pop: body.pop,
    reputation: {
      facts: opts.facts ?? { ...STANDING_ZERO, 'work.total': 12 },
      predicates: (body.disclosure?.predicates ?? []).map((p) => ({ ...p, result: true })),
      redacted: [],
    },
    ...(env ? { requester: { type: 'domain', id: env.audience }, chal_exp: env.expiresAt } : {}),
  };
  const presentation = { tier: 'reputation', payload, provian_jws: jws(payload, PRESENTATION_TYP) } as unknown as Presentation;
  return { presentation, challenge, audience, burnId };
}

/** A pe_fact presentation + Provian co-sign (v1, or v2 against a signed `env`). */
function buildPeFact(opts: { env?: ChallengeEnvelope; cosignOverride?: Record<string, unknown> } = {}): { presentation: Presentation; challenge: string; audience: string; burnId: string } {
  const env = opts.env;
  const audience = env ? env.audience : AUD;
  const challenge = env ? env.challenge : issuePresentationChallenge({ audience }).challenge;
  const burnId = nextBurn();
  const claims = [{ pe_id: 'pe_1', envelope_hash: HASH }];
  const { body } = buildAgentPresentationRequest({
    privateKeyHex: AGENT_KEY, tier: 'pe_fact', burnId, audience, challenge, nowSeconds: NOW,
    peFacts: [{ peId: 'pe_1', envelopeHash: HASH }], challengeEnvelope: env,
  });
  const v2 = env ? { requester: { type: 'domain', id: env.audience }, chal_exp: env.expiresAt } : {};
  const cosign = {
    v: env ? 2 : 1, iss: PRESENTATION_ISSUER, ctx: 'pe_fact_cosign', presenter_address: PRESENTER_LC, burn_id: burnId,
    pe_facts: claims, jti: body.jti, iat: body.iat, exp: body.exp, ...v2, ...(opts.cosignOverride ?? {}),
  };
  const presentation = {
    tier: 'pe_fact',
    payload: {
      v: env ? 2 : 1, tier: 'pe_fact', iss: PRESENTER_LC, sub: 'agent-wallet-x', presenter_address: PRESENTER_LC,
      aud: audience, chal: challenge, iat: body.iat, exp: body.exp, jti: body.jti, burn_id: burnId,
      presenter_pop: body.pop, pe_facts: claims, ...v2,
    },
    provian_jws: jws(cosign, PRESENTATION_PEFACT_TYP),
    proofs: [{ pe_id: 'pe_1', envelope_hash: HASH, anchored: true, anchor: { batch_id: '0x' + '11'.repeat(32) }, leaf: { leaf_value: leafOf(HASH) }, merkle_proof: ['0x' + '22'.repeat(32)] }],
  } as unknown as Presentation;
  return { presentation, challenge, audience, burnId };
}

const OFFLINE = () => ({ jwks: JWKS, requireOnchain: false as const, seenStore: createMemorySeenStore(), nowSeconds: NOW + 10 });

describe('a pe_fact presenter subject is only what Provian co-signed', () => {
  it('RED: rewriting the unsigned payload `sub` to a victim wallet cannot pass a wallet-id presenter check', async () => {
    const { presentation, challenge } = buildPeFact({ cosignOverride: { sub: 'agent-wallet-x' } });
    const forged = { ...presentation, payload: { ...presentation.payload, sub: 'victim-wallet' } } as unknown as Presentation;
    const r = await verifyPresentationToken(forged, { ...OFFLINE(), expectedAudience: AUD, expectedChallenge: challenge, expectedPresenter: 'victim-wallet' });
    expect(r).toEqual({ valid: false, reason: 'pe_fact_cosign_payload_mismatch' });
    // positive twin: the co-signed subject satisfies the check and is the reported `sub`.
    const own = await verifyPresentationToken(presentation, { ...OFFLINE(), expectedAudience: AUD, expectedChallenge: challenge, expectedPresenter: 'agent-wallet-x' });
    expect(own).toMatchObject({ valid: true, sub: 'agent-wallet-x' });
  });

  it('RED: a co-sign with no signed subject never satisfies a wallet-id check and reports sub: null', async () => {
    const { presentation, challenge } = buildPeFact();
    const forged = { ...presentation, payload: { ...presentation.payload, sub: 'victim-wallet' } } as unknown as Presentation;
    const r = await verifyPresentationToken(forged, { ...OFFLINE(), expectedAudience: AUD, expectedChallenge: challenge, expectedPresenter: 'victim-wallet' });
    expect(r).toEqual({ valid: false, reason: 'presenter_mismatch' });
    const plain = await verifyPresentationToken(forged, { ...OFFLINE(), expectedAudience: AUD, expectedChallenge: challenge });
    expect(plain).toMatchObject({ valid: true, sub: null });
  });
});

describe('item 1 — a predicate gate requires the reputation tier', () => {
  it('RED: a pe_fact verified WITH expected predicates is refused before any crypto', async () => {
    const { presentation, challenge } = buildPeFact();
    // jwks: [] would fail the co-sign (unknown kid) — the refusal must come first, before crypto.
    const r = await verifyPresentationToken(presentation, {
      expectedAudience: AUD, expectedChallenge: challenge, expectedPredicates: [{ field: 'work.total', op: 'gte', threshold: 1 }],
      jwks: [], nowSeconds: NOW + 10, seenStore: createMemorySeenStore(),
    });
    expect(r).toEqual({ valid: false, reason: 'predicates_require_reputation_tier' });
    expect(readContractMock).not.toHaveBeenCalled();
  });

  it('the same pe_fact with NO predicates verifies (the gate is specific)', async () => {
    const { presentation, challenge } = buildPeFact();
    const r = await verifyPresentationToken(presentation, { expectedAudience: AUD, expectedChallenge: challenge, ...OFFLINE() });
    expect(r.valid).toBe(true);
  });
});

describe('item 4 — `in` predicates keep their set in the rebuilt directive', () => {
  const IN: PredicateRequest = { field: 'standing.adverse_events', op: 'in', set: [0, 1] };

  it('a legit `in` presentation VERIFIES locally (old verifier: bad_presenter_pop)', async () => {
    const { presentation, challenge } = buildReputation({ predicates: [IN, { field: 'work.total', op: 'gte', threshold: 10 }] });
    const r = await verifyPresentationToken(presentation, { expectedAudience: AUD, expectedChallenge: challenge, expectedPredicates: [IN], ...OFFLINE() });
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.predicates?.find((p) => p.op === 'in')).toMatchObject({ field: IN.field, set: [0, 1], result: true });
  });

  it('RED: a JWS whose `in` set was altered after the presenter signed fails the PoP', async () => {
    const { presentation, challenge } = buildReputation({ predicates: [IN] });
    const payload = JSON.parse(Buffer.from((presentation.provian_jws as string).split('.')[1], 'base64url').toString()) as { reputation: { predicates: Array<{ set?: number[] }> } };
    payload.reputation.predicates[0].set = [0, 1, 2];
    const tampered = { ...presentation, payload: payload as unknown as Presentation['payload'], provian_jws: jws(payload, PRESENTATION_TYP) };
    const r = await verifyPresentationToken(tampered, { expectedAudience: AUD, expectedChallenge: challenge, ...OFFLINE() });
    expect(r).toEqual({ valid: false, reason: 'bad_presenter_pop' });
  });
});

describe('item 6 — accept once, presentationId, expectedPresenter', () => {
  it('RED: the SAME token verified twice against the default store → second is `replayed`', async () => {
    const { presentation, challenge } = buildReputation();
    const token = Buffer.from(JSON.stringify(presentation)).toString('base64url');
    const opts = { expectedAudience: AUD, expectedChallenge: challenge, jwks: JWKS, nowSeconds: NOW + 10 };
    const first = await verifyPresentationToken(token, opts);
    expect(first.valid).toBe(true);
    const second = await verifyPresentationToken(token, opts);
    expect(second).toEqual({ valid: false, reason: 'replayed' });
  });

  it('a fresh store accepts it; acceptOnce:false skips the store; presentationId is the burn id', async () => {
    const { presentation, challenge, burnId } = buildReputation();
    const store = createMemorySeenStore();
    const base = { expectedAudience: AUD, expectedChallenge: challenge, jwks: JWKS, nowSeconds: NOW + 10 };
    const r = await verifyPresentationToken(presentation, { ...base, seenStore: store });
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.presentationId).toBe(burnId);
      expect(r.presenterAddress).toBe(PRESENTER_LC);
      expect(r.sub).toBe('agent-wallet-x');
      expect(r.requester).toBeNull();
      expect(r.challengeExpiresAt).toBeNull();
    }
    expect(await verifyPresentationToken(presentation, { ...base, seenStore: store })).toEqual({ valid: false, reason: 'replayed' });
    expect((await verifyPresentationToken(presentation, { ...base, seenStore: createMemorySeenStore() })).valid).toBe(true);
    expect((await verifyPresentationToken(presentation, { ...base, seenStore: store, acceptOnce: false })).valid).toBe(true);
  });

  it('the claim happens only after every other check: a failed verify does not consume the presentation', async () => {
    const { presentation, challenge } = buildReputation();
    const store = createMemorySeenStore();
    const bad = await verifyPresentationToken(presentation, { expectedAudience: AUD, expectedChallenge: 'x'.repeat(64), jwks: JWKS, nowSeconds: NOW + 10, seenStore: store });
    expect(bad).toEqual({ valid: false, reason: 'challenge_mismatch' });
    const good = await verifyPresentationToken(presentation, { expectedAudience: AUD, expectedChallenge: challenge, jwks: JWKS, nowSeconds: NOW + 10, seenStore: store });
    expect(good.valid).toBe(true);
  });

  it('RED: a seen-store that throws fails closed (seen_store_unavailable)', async () => {
    const { presentation, challenge } = buildReputation();
    const r = await verifyPresentationToken(presentation, {
      expectedAudience: AUD, expectedChallenge: challenge, jwks: JWKS, nowSeconds: NOW + 10,
      seenStore: { claim: async () => { throw new Error('disk gone'); } },
    });
    expect(r).toEqual({ valid: false, reason: 'seen_store_unavailable' });
  });

  it('RED: expectedPresenter (address or wallet id) — a different presenter is `presenter_mismatch`', async () => {
    const { presentation, challenge } = buildReputation();
    const base = { expectedAudience: AUD, expectedChallenge: challenge, jwks: JWKS, nowSeconds: NOW + 10 };
    expect(await verifyPresentationToken(presentation, { ...base, seenStore: createMemorySeenStore(), expectedPresenter: '0x' + '1'.repeat(40) }))
      .toEqual({ valid: false, reason: 'presenter_mismatch' });
    expect(await verifyPresentationToken(presentation, { ...base, seenStore: createMemorySeenStore(), expectedPresenter: 'agent-wallet-other' }))
      .toEqual({ valid: false, reason: 'presenter_mismatch' });
    expect((await verifyPresentationToken(presentation, { ...base, seenStore: createMemorySeenStore(), expectedPresenter: PRESENTER.toUpperCase().replace('0X', '0x') })).valid).toBe(true);
    expect((await verifyPresentationToken(presentation, { ...base, seenStore: createMemorySeenStore(), expectedPresenter: 'agent-wallet-x' })).valid).toBe(true);
  });

  it('the `challenge` option fills audience/challenge/presenter; disagreeing explicit options throw', async () => {
    const issued = issuePresentationChallenge({ audience: AUD, presenter: '0x' + '1'.repeat(40), nowSeconds: NOW });
    const { presentation } = buildReputation();
    // Built against a different nonce → challenge_mismatch proves `challenge` was derived from the option.
    const r = await verifyPresentationToken(presentation, { challenge: issued, jwks: JWKS, nowSeconds: NOW + 10, seenStore: createMemorySeenStore() });
    expect(r).toEqual({ valid: false, reason: 'challenge_mismatch' });
    await expect(verifyPresentationToken(presentation, { challenge: issued, expectedAudience: 'someone-else', jwks: JWKS })).rejects.toThrow(/disagree/);
    await expect(verifyPresentationToken(presentation, { challenge: issued, expectedPresenter: PRESENTER, jwks: JWKS })).rejects.toThrow(/disagree/);
  });

  it('RED: a challenge addressed to another presenter refuses via the `challenge` option alone', async () => {
    const built = buildReputation();
    const issued = { audience: AUD, challenge: built.challenge, issuedAt: NOW, expiresAt: NOW + 900, presenter: '0x' + '1'.repeat(40) };
    const r = await verifyPresentationToken(built.presentation, { challenge: issued, jwks: JWKS, nowSeconds: NOW + 10, seenStore: createMemorySeenStore() });
    expect(r).toEqual({ valid: false, reason: 'presenter_mismatch' });
    const ok = await verifyPresentationToken(built.presentation, { challenge: { ...issued, presenter: PRESENTER_LC }, jwks: JWKS, nowSeconds: NOW + 10, seenStore: createMemorySeenStore() });
    expect(ok.valid).toBe(true);
    if (ok.valid) expect(ok.challengeExpiresAt).toBe(NOW + 900);
  });
});

describe('item 3 — pe_fact requires the on-chain PEAnchor check BY DEFAULT', () => {
  it('RED: default options read the chain via https://mainnet.base.org at the pinned anchor; a false read refuses', async () => {
    readContractMock.mockResolvedValue(false);
    const { presentation, challenge } = buildPeFact();
    const r = await verifyPresentationToken(presentation, { expectedAudience: AUD, expectedChallenge: challenge, jwks: JWKS, nowSeconds: NOW + 10, seenStore: createMemorySeenStore() });
    expect(r).toEqual({ valid: false, reason: 'pe_fact_proof_onchain_invalid' });
    expect(httpUrls).toContain(DEFAULT_BASE_RPC_URL);
    expect((readContractMock.mock.calls[0][0] as { address: string }).address.toLowerCase()).toBe(PROVIAN_BASE_PE_ANCHOR.toLowerCase());
  });

  it('default options + a true chain read → valid with onchainChecked', async () => {
    readContractMock.mockResolvedValue(true);
    const { presentation, challenge } = buildPeFact();
    const r = await verifyPresentationToken(presentation, { expectedAudience: AUD, expectedChallenge: challenge, jwks: JWKS, nowSeconds: NOW + 10, seenStore: createMemorySeenStore() });
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.onchainChecked).toBe(true);
  });

  it('explicit requireOnchain:false with no rpcUrl is the only offline opt-out (never reads the chain)', async () => {
    const { presentation, challenge } = buildPeFact();
    const r = await verifyPresentationToken(presentation, { expectedAudience: AUD, expectedChallenge: challenge, ...OFFLINE() });
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.onchainChecked).toBe(false);
    expect(readContractMock).not.toHaveBeenCalled();
    expect(httpUrls).toHaveLength(0);
  });

  it('a caller rpcUrl overrides the default', async () => {
    readContractMock.mockResolvedValue(true);
    const { presentation, challenge } = buildPeFact();
    await verifyPresentationToken(presentation, { expectedAudience: AUD, expectedChallenge: challenge, jwks: JWKS, rpcUrl: 'https://my-rpc.test', nowSeconds: NOW + 10, seenStore: createMemorySeenStore() });
    expect(httpUrls).toEqual(['https://my-rpc.test']);
  });
});

describe('item 7 — v2 presentations against a SIGNED challenge', () => {
  it('a v2 reputation presentation verifies via the issued envelope; result carries requester + deadline', async () => {
    const env = signedDomainChallenge({ predicates: [{ field: 'work.total', op: 'gte', threshold: 10 }] });
    const { presentation } = buildReputation({ env, predicates: [{ field: 'work.total', op: 'gte', threshold: 10 }] });
    const r = await verifyPresentationToken(presentation, { challenge: env, jwks: JWKS, nowSeconds: NOW + 10, seenStore: createMemorySeenStore() });
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.payload.v).toBe(2);
      expect(r.requester).toEqual({ type: 'domain', id: 'gate.example.com' });
      expect(r.challengeExpiresAt).toBe(env.expiresAt);
    }
  });

  it('RED: a v2 presentation verified after chal_exp + 60 → challenge_expired (presentation itself still fresh)', async () => {
    const env = signedDomainChallenge({ ttlSeconds: 60 });
    const { presentation } = buildReputation({ env });
    const at = (env.expiresAt as number) + 61; // presentation exp = iat + 300 → still inside its own window
    const r = await verifyPresentationToken(presentation, { expectedAudience: env.audience, expectedChallenge: env.challenge, jwks: JWKS, nowSeconds: at, seenStore: createMemorySeenStore() });
    expect(r).toEqual({ valid: false, reason: 'challenge_expired' });
    const inTime = await verifyPresentationToken(presentation, { expectedAudience: env.audience, expectedChallenge: env.challenge, jwks: JWKS, nowSeconds: at - 1, seenStore: createMemorySeenStore() });
    expect(inTime.valid).toBe(true);
  });

  it('RED: an unsigned challenge deadline from the `challenge` option is enforced on a v1 presentation', async () => {
    const built = buildReputation();
    const issued = { audience: AUD, challenge: built.challenge, issuedAt: NOW - 100, expiresAt: NOW - 70 };
    const r = await verifyPresentationToken(built.presentation, { challenge: issued, jwks: JWKS, nowSeconds: NOW + 10, seenStore: createMemorySeenStore() });
    expect(r).toEqual({ valid: false, reason: 'challenge_expired' });
  });

  it('RED: a v1 presentation (signature stripped) answering a SIGNED challenge is refused requester_mismatch', async () => {
    const env = signedDomainChallenge();
    const { presentation } = buildReputation({ audience: env.audience, challenge: env.challenge });
    expect((presentation.payload as { v: number }).v).toBe(1);
    const r = await verifyPresentationToken(presentation, { challenge: env, jwks: JWKS, nowSeconds: NOW + 10, seenStore: createMemorySeenStore() });
    expect(r).toEqual({ valid: false, reason: 'requester_mismatch' });
    // positive twin: the same v1 token verifies against the unsigned expectation
    const ok = await verifyPresentationToken(presentation, { expectedAudience: env.audience, expectedChallenge: env.challenge, jwks: JWKS, nowSeconds: NOW + 10, seenStore: createMemorySeenStore() });
    expect(ok.valid).toBe(true);
  });

  it('RED: expected requester ≠ the v2 payload requester → requester_mismatch', async () => {
    const env = signedDomainChallenge();
    const { presentation } = buildReputation({ env });
    const r = await verifyPresentationToken(presentation, {
      expectedAudience: env.audience, expectedChallenge: env.challenge, expectedRequester: { type: 'domain', id: 'other.example.com' },
      jwks: JWKS, nowSeconds: NOW + 10, seenStore: createMemorySeenStore(),
    });
    expect(r).toEqual({ valid: false, reason: 'requester_mismatch' });
  });

  it('RED: v2 payload missing chal_exp → missing_binding_fields; v1 payload carrying a requester → malformed', async () => {
    const env = signedDomainChallenge();
    const v2 = buildReputation({ env });
    const p2 = JSON.parse(Buffer.from((v2.presentation.provian_jws as string).split('.')[1], 'base64url').toString()) as Record<string, unknown>;
    delete p2.chal_exp;
    const r2 = await verifyPresentationToken({ ...v2.presentation, provian_jws: jws(p2, PRESENTATION_TYP) }, { expectedAudience: env.audience, expectedChallenge: env.challenge, jwks: JWKS, nowSeconds: NOW + 10, seenStore: createMemorySeenStore() });
    expect(r2).toEqual({ valid: false, reason: 'missing_binding_fields' });

    const v1 = buildReputation();
    const p1 = JSON.parse(Buffer.from((v1.presentation.provian_jws as string).split('.')[1], 'base64url').toString()) as Record<string, unknown>;
    p1.requester = { type: 'domain', id: AUD };
    const r1 = await verifyPresentationToken({ ...v1.presentation, provian_jws: jws(p1, PRESENTATION_TYP) }, { expectedAudience: AUD, expectedChallenge: v1.challenge, jwks: JWKS, nowSeconds: NOW + 10, seenStore: createMemorySeenStore() });
    expect(r1).toEqual({ valid: false, reason: 'malformed' });
  });

  it('RED: a v1-signed binding relabelled as v2 fails the presenter PoP (the binding commits to req/chal_exp)', async () => {
    const env = signedDomainChallenge();
    const v1 = buildReputation({ audience: env.audience });
    const p = JSON.parse(Buffer.from((v1.presentation.provian_jws as string).split('.')[1], 'base64url').toString()) as Record<string, unknown>;
    Object.assign(p, { v: 2, requester: { type: 'domain', id: env.audience }, chal_exp: NOW + 900 });
    const r = await verifyPresentationToken({ ...v1.presentation, provian_jws: jws(p, PRESENTATION_TYP) }, { expectedAudience: env.audience, expectedChallenge: v1.challenge, jwks: JWKS, nowSeconds: NOW + 10, seenStore: createMemorySeenStore() });
    expect(r).toEqual({ valid: false, reason: 'bad_presenter_pop' });
  });

  it('pe_fact v2: a matching v2 co-sign verifies; a v1 co-sign or a different chal_exp is refused', async () => {
    const env = signedDomainChallenge();
    const good = buildPeFact({ env });
    const r = await verifyPresentationToken(good.presentation, { challenge: env, ...OFFLINE() });
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.requester).toEqual({ type: 'domain', id: 'gate.example.com' });

    const liftedV1 = buildPeFact({ env, cosignOverride: { v: 1, requester: undefined, chal_exp: undefined } });
    expect(await verifyPresentationToken(liftedV1.presentation, { challenge: env, ...OFFLINE() }))
      .toEqual({ valid: false, reason: 'pe_fact_cosign_payload_mismatch' });
    // A co-sign carrying the SAME requester + chal_exp but stamped v1 is still not a v2 co-sign.
    const v1Stamped = buildPeFact({ env, cosignOverride: { v: 1 } });
    expect(await verifyPresentationToken(v1Stamped.presentation, { challenge: env, ...OFFLINE() }))
      .toEqual({ valid: false, reason: 'pe_fact_cosign_payload_mismatch' });
    const otherDeadline = buildPeFact({ env, cosignOverride: { chal_exp: (env.expiresAt as number) + 1 } });
    expect(await verifyPresentationToken(otherDeadline.presentation, { challenge: env, ...OFFLINE() }))
      .toEqual({ valid: false, reason: 'pe_fact_cosign_payload_mismatch' });
  });

  it('RED: a signed `challenge` option whose predicates the explicit list contradicts throws', async () => {
    const env = signedDomainChallenge({ predicates: [{ field: 'work.total', op: 'gte', threshold: 10 }] });
    const { presentation } = buildReputation({ env });
    await expect(verifyPresentationToken(presentation, { challenge: env, expectedPredicates: [{ field: 'work.total', op: 'gte', threshold: 99 }], jwks: JWKS }))
      .rejects.toThrow(/disagree/);
  });
});

describe('share-only disclosure — cross-package canonical pin', () => {
  it('canonicalizes share only when present (existing digests unchanged) and pins the relay bytes', () => {
    expect(JSON.stringify(canonicalReputationDirective({ redact: ['b', 'a'], predicates: [] }))).toBe('{"redact":["a","b"],"predicates":[]}');
    expect(JSON.stringify(canonicalReputationDirective({ redact: [], predicates: [], share: ['z', 'a', 'a'] }))).toBe('{"redact":[],"predicates":[],"share":["a","z"]}');
    expect(claimsDigest({ tier: 'reputation', directive: { redact: [], predicates: [], share: ['work.total'] } }))
      .toBe(SHARE_ONLY_DIGEST_PIN);
  });
});


describe(' close-out — Standing is never withheld', () => {
  it('the SDK list equals the served schema\'s fixed Standing fields (snapshot binding)', () => {
    const group = (peSchema as { presentation: { vocabulary: { groups: { group: string; fields: string[] }[] } } })
      .presentation.vocabulary.groups.find((g) => g.group === 'standing');
    expect(group).toBeDefined();
    const fixed = (group?.fields ?? []).filter((f) => !f.includes('<')).sort();
    expect([...STANDING_ALWAYS_PRESENT_FIELDS].sort()).toEqual(fixed);
  });

  it('RED: a co-signed payload missing any Standing fact is refused standing_withheld — and burns no seen-store slot; the full payload verifies (control)', async () => {
    for (const withheld of STANDING_ALWAYS_PRESENT_FIELDS) {
      const facts: Record<string, number> = { ...STANDING_ZERO, 'work.total': 12 };
      delete facts[withheld];
      const { presentation, challenge } = buildReputation({ facts });
      const store = createMemorySeenStore();
      const opts = { expectedAudience: AUD, expectedChallenge: challenge, jwks: JWKS, nowSeconds: NOW + 10, seenStore: store };
      expect(await verifyPresentationToken(presentation, opts)).toEqual({ valid: false, reason: 'standing_withheld' });
    }
    const { presentation, challenge } = buildReputation();
    const r = await verifyPresentationToken(presentation, { expectedAudience: AUD, expectedChallenge: challenge, jwks: JWKS, nowSeconds: NOW + 10, seenStore: createMemorySeenStore() });
    expect(r.valid).toBe(true);
    if (r.valid && r.tier === 'reputation') expect(r.standing).toEqual(STANDING_ZERO);
  });
});
