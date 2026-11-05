import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { generateKeyPairSigner } from '@solana/kit';
import { createApp, secretMatches, type AppDeps } from './app.js';
import { BaseFacilitator } from './base/facilitator.js';
import { MemoryStore } from './store.js';
import { FakeBaseChain, FakeSolanaChain, noFetch, recordingWitness, seller } from './test-support/fakes.js';
import { SolanaFacilitator } from './solana/facilitator.js';
import { checkPresentation } from './presentation.js';

const SECRET = 'internal-secret-0123456789abcdef';
let deps: AppDeps;
let store: MemoryStore;
let baseChain: FakeBaseChain;

beforeEach(async () => {
  store = new MemoryStore();
  baseChain = new FakeBaseChain();
  const kp = await generateKeyPairSigner();
  const solChain = new FakeSolanaChain(kp.address, kp);
  const w = recordingWitness();
  deps = {
    base: new BaseFacilitator({ chain: baseChain, store, relayUrl: 'r', fetch: noFetch, witness: w.reporter, priceMaxAgeSeconds: 3600, now: () => Date.now(), standardVerify: async () => ({ isValid: true }) }),
    baseChain,
    basePriceMaxAgeSeconds: 3600,
    solana: new SolanaFacilitator({ chain: solChain, store, relayUrl: 'r', fetch: noFetch, witness: w.reporter, quoteSecret: SECRET, priceMaxAgeSeconds: 120, now: () => Date.now() }),
    solanaChain: solChain,
    solanaPriceMaxAgeSeconds: 120,
    store,
    verifyEvmMessage: null,
    internalSecret: SECRET,
    quoteSecret: SECRET,
    refill: {
      baseGasFloorWei: 1n,
      baseUsdcBuffer: 10n ** 12n,
      baseRefillMaxUsdc: 1n,
      baseMinSwapUsdc: 1_000_000n,
      solanaGasFloorLamports: 1n,
      solanaUsdcBuffer: 10n ** 12n,
      solanaRefillMaxUsdc: 1n,
      solanaMinSwapUsdc: 1_000_000n,
      zeroxApiKey: null,
      jupiterApiKey: null,
    },
    witness: w.reporter,
    fetch: noFetch,
    now: () => Date.now(),
    disabledReasons: { base: null, solana: null },
  };
});

describe('HTTP surface', () => {
  it('GET /supported lists both chains, the presentation extension and the signers', async () => {
    const res = await request(createApp(deps)).get('/supported');
    expect(res.status).toBe(200);
    expect(res.body.kinds.map((k: { network: string }) => k.network)).toEqual(['eip155:8453', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp']);
    expect(res.body.extensions).toEqual(['provian-presentation']);
    expect(res.body.signers['eip155:*']).toEqual([baseChain.operator]);
  });

  it('a disabled chain is not offered', async () => {
    const res = await request(createApp({ ...deps, solana: null, solanaChain: null, disabledReasons: { base: null, solana: 'SOLANA_RPC_URL unset' } })).get('/supported');
    expect(res.body.kinds).toHaveLength(1);
    const h = await request(createApp({ ...deps, solana: null, solanaChain: null, disabledReasons: { base: null, solana: 'SOLANA_RPC_URL unset' } })).get('/health');
    expect(h.body.chains.solana).toBe('disabled: SOLANA_RPC_URL unset');
  });

  it('RED: malformed /verify and /settle bodies are refused', async () => {
    const app = createApp(deps);
    expect((await request(app).post('/verify').send({ x402Version: 1 })).body).toEqual({ isValid: false, invalidReason: 'invalid_request' });
    expect((await request(app).post('/settle').send({})).status).toBe(400);
  });

  it('RED: an unsupported network is refused', async () => {
    const r = { scheme: 'exact', network: 'eip155:1', asset: '0x0', amount: '1', payTo: '0x0', maxTimeoutSeconds: 10, extra: {} };
    const res = await request(createApp(deps)).post('/verify').send({ x402Version: 2, paymentPayload: { x402Version: 2, accepted: r, payload: {} }, paymentRequirements: r });
    expect(res.body).toEqual({ isValid: false, invalidReason: 'unsupported_network' });
  });

  it('GET /fee-quote for Base and Solana', async () => {
    const app = createApp(deps);
    const b = await request(app).get('/fee-quote?network=base');
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ network: 'eip155:8453', payer: 'seller', margin_usdc_atomic: '300' });
    const s = await request(app).get('/fee-quote?network=solana');
    expect(s.status).toBe(200);
    expect(s.body.extra.provianFee.quote).toEqual(expect.any(String));
    // 10,001 lamports at $120 → 1,201 + 300.
    expect(s.body.fee_atomic).toBe('1501');
    expect((await request(app).get('/fee-quote?network=solana&compute_unit_limit=999999')).status).toBe(400);
  });

  it('GET /sellers/:chain/:address returns the public profile', async () => {
    await store.upsertSeller(seller('base', '0x2000000000000000000000000000000000000002'));
    const app = createApp(deps);
    const ok = await request(app).get('/sellers/base/0x2000000000000000000000000000000000000002');
    expect(ok.status).toBe(200);
    expect(ok.body.seller_id).toBe('base:0x2000000000000000000000000000000000000002');
    expect((await request(app).get('/sellers/base/0x3000000000000000000000000000000000000003')).status).toBe(404);
    expect((await request(app).get('/sellers/eth/0x3000000000000000000000000000000000000003')).status).toBe(400);
  });

  it('RED: /internal/* needs the secret (unset → 503, wrong → 401)', async () => {
    expect((await request(createApp({ ...deps, internalSecret: null })).post('/internal/refill')).status).toBe(503);
    expect((await request(createApp(deps)).post('/internal/refill').set('authorization', 'Bearer wrong')).status).toBe(401);
    expect((await request(createApp(deps)).post('/internal/witness-retry')).status).toBe(401);
    const ok = await request(createApp(deps)).post('/internal/witness-retry').set('authorization', `Bearer ${SECRET}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ attempted: 0, reported: 0, reconciled: { scanned: 0, resolved: 0 }, reconciled_solana: { scanned: 0, resolved: 0 } });
  });

  it('/internal/* accepts the scheduler OIDC token in place of the secret, and nothing else', async () => {
    const verifySchedulerToken = async (token: string): Promise<boolean> => token === 'scheduler-oidc';
    const app = createApp({ ...deps, verifySchedulerToken });
    const ok = await request(app).post('/internal/witness-retry').set('authorization', 'Bearer scheduler-oidc');
    expect(ok.status).toBe(200);
    expect((await request(app).post('/internal/witness-retry').set('authorization', `Bearer ${SECRET}`)).status).toBe(200);
    // RED controls: a token the check refuses, a check that throws, and no check at all → 401.
    expect((await request(app).post('/internal/refill').set('authorization', 'Bearer not-scheduler')).status).toBe(401);
    const throwing = createApp({ ...deps, verifySchedulerToken: async () => { throw new Error('jwks unreachable'); } });
    expect((await request(throwing).post('/internal/refill').set('authorization', 'Bearer scheduler-oidc')).status).toBe(401);
    expect((await request(createApp(deps)).post('/internal/refill').set('authorization', 'Bearer scheduler-oidc')).status).toBe(401);
  });

  it('a refill run is kept per chain for the Command Center', async () => {
    deps = { ...deps, now: () => 1_000 };
    const res = await request(createApp(deps)).post('/internal/refill').set('authorization', `Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect([...store.refills.keys()].sort()).toEqual(['base', 'solana']);
    expect(store.refills.get('base')).toMatchObject({ chain: 'base', last_run_at_ms: 1_000, error: null });
  });

  it('RED: a store that cannot save the refill state never fails the refill', async () => {
    store.recordRefill = async () => { throw new Error('firestore down'); };
    const res = await request(createApp(deps)).post('/internal/refill').set('authorization', `Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(res.body.reports).toHaveLength(2);
  });

  it('secretMatches is exact', () => {
    expect(secretMatches(SECRET, SECRET)).toBe(true);
    expect(secretMatches(`${SECRET}x`, SECRET)).toBe(false);
    expect(secretMatches('', SECRET)).toBe(false);
  });
});

describe('presentation gate (relay /v1/present/verify)', () => {
  const payer = '0x1000000000000000000000000000000000000001';
  const base = seller('base', '0x2000000000000000000000000000000000000002', { require_presentation: { tier: 'reputation', predicates: [{ field: 'standing.acts', op: 'gte', threshold: 10 }] } });
  const ext = { 'provian-presentation': { token: 't'.repeat(32), challenge: `x402-pay:${payer}` } };
  const answer = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  const ok = { valid: true, tier: 'reputation', presentation_id: 'burn-9', presenter_address: payer, predicates: [{ field: 'standing.acts', op: 'gte', result: true }] };

  it('passes a valid presentation bound to this seller and this buyer', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: String(init?.body) });
      return new Response(JSON.stringify(ok), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await checkPresentation({ seller: base, payer, extensions: ext, relayUrl: 'https://relay', fetch: f, store: new MemoryStore() });
    expect(r).toMatchObject({ ok: true, presentationId: 'burn-9' });
    expect(calls[0]!.url).toBe('https://relay/v1/present/verify');
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ audience: base.seller_id, challenge: `x402-pay:${payer}`, expected_presenter: payer });
  });

  const reds: Array<[string, Parameters<typeof checkPresentation>[0]['extensions'], unknown, string]> = [
    ['absent', undefined, ok, 'presentation_required'],
    ['challenge for another buyer', { 'provian-presentation': { token: 't'.repeat(32), challenge: 'x402-pay:0xdead' } }, ok, 'presentation_challenge_mismatch'],
    ['relay says invalid', ext, { valid: false, reason: 'expired' }, 'presentation_invalid'],
    ['wrong tier', ext, { ...ok, tier: 'pe_fact' }, 'presentation_tier_mismatch'],
    ['another presenter', ext, { ...ok, presenter_address: '0x9999999999999999999999999999999999999999' }, 'presentation_presenter_mismatch'],
    ['predicate false', ext, { ...ok, predicates: [{ field: 'standing.acts', op: 'gte', result: false }] }, 'presentation_predicate_unmet'],
    ['predicate unanswered', ext, { ...ok, predicates: [] }, 'presentation_predicate_unmet'],
  ];
  for (const [name, extensions, body, reason] of reds) {
    it(`RED: ${name} → ${reason}`, async () => {
      expect(await checkPresentation({ seller: base, payer, extensions, relayUrl: 'r', fetch: answer(body), store: new MemoryStore() })).toEqual({ ok: false, reason });
    });
  }

  it('RED: a presentation id already consumed is refused', async () => {
    const s = new MemoryStore();
    await s.consumePresentation('burn-9', 'k', Date.now() + 1000);
    expect(await checkPresentation({ seller: base, payer, extensions: ext, relayUrl: 'r', fetch: answer(ok), store: s })).toEqual({ ok: false, reason: 'presentation_already_used' });
  });

  it('RED: the relay unreachable fails closed', async () => {
    expect(await checkPresentation({ seller: base, payer, extensions: ext, relayUrl: 'r', fetch: noFetch, store: new MemoryStore() })).toEqual({ ok: false, reason: 'presentation_verifier_unavailable' });
  });
});

describe('witness reporter (relay answers)', () => {
  it('2xx → reported, 400/409/422 → refused, 5xx/401/network → retry; no secret → retry', async () => {
    const { createWitnessReporter } = await import('./witness.js');
    const report = { chain: 'base' as const, tx_hash: '0x1', buyer: 'b', seller: 's', asset: 'a', amount: '1', fee: '1', scheme: 'eip3009' as const };
    const withStatus = (status: number) => (async () => new Response('{}', { status })) as unknown as typeof fetch;
    expect(await createWitnessReporter('r', SECRET, withStatus(202))(report)).toBe('reported');
    for (const s of [400, 409, 422]) expect(await createWitnessReporter('r', SECRET, withStatus(s))(report)).toBe('refused');
    for (const s of [401, 500, 503]) expect(await createWitnessReporter('r', SECRET, withStatus(s))(report)).toBe('retry');
    expect(await createWitnessReporter('r', SECRET, noFetch)(report)).toBe('retry');
    expect(await createWitnessReporter('r', null, withStatus(200))(report)).toBe('retry');
  });
});
