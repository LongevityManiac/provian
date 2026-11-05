/**
 * Public presentation VERIFICATION surface — route-level acceptance.
 *
 * Proves the burn-to-present READ requirement: a counterparty with NO account and
 * NO Bearer credential can (a) fetch the Provian JWKS and (b) POST a presentation
 * to /verify and get a truthful verdict — the presentation being handed over is
 * the only credential involved. JWKS fails closed (503) when unconfigured.
 */
import crypto from 'crypto';
import { describe, it, expect } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { ethers } from 'ethers';
import { createPresentRouter } from './present';
import {
  produceReputationPresentation,
  type PresenterPrincipal,
} from '../core/presentation/service';
import {
  presentationBindingString,
  claimsDigest,
  encodePresentationToken,
  type PresenterPop,
} from '../core/presentation/types';
import { canonicalReputationDirective, type DisclosureDirective } from '../core/presentation/disclosure';
import { ACTOR_STATS_COLLECTION, emptyActorStats } from '../core/pvt/actor-stats';

function ed25519Env() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const priv = privateKey.export({ format: 'jwk' }) as { x: string; d: string };
  return { ATTESTATION_SIGNING_KEY: JSON.stringify({ kty: 'OKP', crv: 'Ed25519', kid: 'k1', x: priv.x, d: priv.d }) };
}
function agentSigner() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const pubkeyHex = Buffer.from(jwk.x, 'base64url').toString('hex').padStart(64, '0')
    + Buffer.from(jwk.y, 'base64url').toString('hex').padStart(64, '0');
  return { pubkeyHex, address: ethers.computeAddress(`0x04${pubkeyHex}`).toLowerCase(), sign: (m: string) => crypto.createSign('SHA256').update(m).sign(privateKey, 'hex') };
}

// Minimal in-memory Firestore for producing one presentation.
function fakeDb(store: Map<string, Map<string, Record<string, unknown>>>) {
  const coll = (n: string) => { let c = store.get(n); if (!c) { c = new Map(); store.set(n, c); } return c; };
  const ref = (n: string, id: string) => ({
    id,
    async get() { const r = coll(n).get(id); return { exists: r !== undefined, data: () => (r ? { ...r } : undefined) }; },
    set(d: Record<string, unknown>, o?: { merge?: boolean }) { coll(n).set(id, o?.merge ? { ...(coll(n).get(id) ?? {}), ...d } : { ...d }); },
    create(d: Record<string, unknown>) { if (coll(n).has(id)) { const e = new Error('x') as Error & { code: number }; e.code = 6; throw e; } coll(n).set(id, { ...d }); },
  });
  // the vocabulary is fail-closed — the fixture answers every reader it uses (the reference
  // graph, presentation counts, device / bond counts) instead of relying on a swallowed read error.
  type Q = { where(f: string, op: string, v: unknown): Q; orderBy(): Q; select(): Q; startAfter(): Q; limit(n: number): Q;
    get(): Promise<{ empty: boolean; size: number; docs: Array<{ id: string; data: () => Record<string, unknown> }> }>;
    count(): { get(): Promise<{ data: () => { count: number } }> } };
  const query = (n: string, cons: Array<[string, string, unknown]> = [], lim = Infinity): Q => {
    const rows = () => [...coll(n).entries()]
      .filter(([, d]) => cons.every(([f, op, v]) => (op === '>=' ? typeof d[f] === 'number' && (d[f] as number) >= (v as number) : d[f] === v)))
      .slice(0, lim);
    const q: Q = {
      where: (f, op, v) => query(n, [...cons, [f, op, v]], lim),
      orderBy: () => q, select: () => q, startAfter: () => q,
      limit: (k) => query(n, cons, k),
      get: async () => { const r = rows(); return { empty: r.length === 0, size: r.length, docs: r.map(([id, d]) => ({ id, data: () => ({ ...d }) })) }; },
      count: () => ({ get: async () => ({ data: () => ({ count: rows().length }) }) }),
    };
    return q;
  };
  return {
    collection: (n: string) => ({ doc: (id: string) => ref(n, id), where: (f: string, op: string, v: unknown) => query(n).where(f, op, v) }),
    runTransaction: async (fn: (t: unknown) => Promise<unknown>) => fn({
      get: (r: { get: () => unknown }) => r.get(),
      create: (r: { create: (d: Record<string, unknown>) => void }, d: Record<string, unknown>) => r.create(d),
      set: (r: { set: (d: Record<string, unknown>, o?: unknown) => void }, d: Record<string, unknown>, o?: unknown) => r.set(d, o),
    }),
  } as unknown as import('firebase-admin/firestore').Firestore;
}

const NOW = Math.floor(Date.now() / 1000);

async function makePresentationToken(env: Record<string, string>, opts: { directive?: DisclosureDirective; peCount?: number } = {}) {
  const agent = agentSigner();
  const directive: DisclosureDirective = opts.directive ?? { redact: [], predicates: [] };
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  // §2.5: the vocabulary is LIVE — seed the actor's counters so the presentation has facts to answer over.
  store.set(ACTOR_STATS_COLLECTION, new Map([['agent1', { ...emptyActorStats('agent1'), pe_count: opts.peCount ?? 10 } as unknown as Record<string, unknown>]]));
  store.set('pvt_burn_records', new Map([['a'.repeat(64), {
    wallet_id: 'aw1', amount_atomic: (15n * 10n ** 18n).toString(), status: 'recorded', verified: true, chain: 'base',
  }]]));
  const principal: PresenterPrincipal = { kind: 'agent', walletId: 'aw1', address: agent.address, peOwnerUserId: 'agent1', publicKeyHex: agent.pubkeyHex, standing: {} };
  const binding = presentationBindingString({ tier: 'reputation', presenter_address: agent.address, aud: 'requester-1', chal: 'chal-abcdefghijklmnop', iat: NOW, exp: NOW + 300, jti: 'j1', burn_id: 'a'.repeat(64), claims_digest: claimsDigest({ tier: 'reputation', reputation_directive: canonicalReputationDirective(directive) }) });
  const pop: PresenterPop = { scheme: 'ecdsa_sha256_secp256k1', signature: agent.sign(binding), pubkey: agent.pubkeyHex };
  const r = await produceReputationPresentation({ db: fakeDb(store), env }, { principal, burnId: 'a'.repeat(64), audience: 'requester-1', challenge: 'chal-abcdefghijklmnop', iat: NOW, exp: NOW + 300, jti: 'j1', pop, directive, nowSeconds: NOW });
  if (!r.ok) throw new Error('setup failed to produce presentation');
  return encodePresentationToken(r.presentation);
}

function appWith(env: Record<string, string>) {
  const app = express();
  app.use(express.json());
  app.use('/v1/present', createPresentRouter({ env }));
  return app;
}

describe('GET /v1/present/jwks', () => {
  it('503 fail-closed when unconfigured', async () => {
    const res = await request(appWith({})).get('/v1/present/jwks');
    expect(res.status).toBe(503);
  });
  it('200 with public keys when configured — reachable with NO auth', async () => {
    const res = await request(appWith(ed25519Env())).get('/v1/present/jwks');
    expect(res.status).toBe(200);
    expect(res.body.keys[0].kty).toBe('OKP');
    expect(res.body.keys[0].d).toBeUndefined(); // never leaks the private half
  });
});

describe('GET /v1/present/floor (public, read-only — presenter learns the fee before burning)', () => {
  it('answers the per-tier launch literals with NO db (never fails closed)', async () => {
    const res = await request(appWith({})).get('/v1/present/floor');
    expect(res.status).toBe(200);
    expect(res.body.floors.reputation.floor_pvt).toBe('15');
    expect(res.body.floors.pe_fact.floor_pvt).toBe('5');
  });
  it('filters to one tier via ?tier=', async () => {
    const res = await request(appWith({})).get('/v1/present/floor?tier=pe_fact');
    expect(res.body.floors.pe_fact.floor_pvt).toBe('5');
    expect(res.body.floors.reputation).toBeUndefined();
  });
  it('reflects a scheduled override — RED control: 20, NOT the 15 literal (proves the db read fires)', async () => {
    const store = new Map<string, Map<string, Record<string, unknown>>>();
    store.set('burn_floor_policy', new Map([['presentation_reputation', { floor_atomic: (20n * 10n ** 18n).toString() }]]));
    const app = express();
    app.use(express.json());
    app.use('/v1/present', createPresentRouter({ env: {}, db: fakeDb(store) }));
    const res = await request(app).get('/v1/present/floor?tier=reputation');
    expect(res.body.floors.reputation.floor_pvt).toBe('20');
  });
});

describe('POST /v1/present/verify (no account, no flip)', () => {
  it('verifies a reputation presentation for the bound requester', async () => {
    const env = ed25519Env();
    const token = await makePresentationToken(env);
    const res = await request(appWith(env)).post('/v1/present/verify').send({ token, audience: 'requester-1', challenge: 'chal-abcdefghijklmnop' });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.tier).toBe('reputation');
  });

  it('RED: rejects the wrong challenge', async () => {
    const env = ed25519Env();
    const token = await makePresentationToken(env);
    const res = await request(appWith(env)).post('/v1/present/verify').send({ token, audience: 'requester-1', challenge: 'WRONG-challenge-000' });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.reason).toBe('challenge_mismatch');
  });

  it('400 when no presentation is supplied (binding present)', async () => {
    const res = await request(appWith(ed25519Env())).post('/v1/present/verify').send({ audience: 'requester-1', challenge: 'chal-abcdefghijklmnop' });
    expect(res.status).toBe(400);
  });

  // F7 — audience + challenge are REQUIRED. Without them the verifier skipped
  // binding and a leaked token verified valid:true for any third party in-window.
  // RED controls: a token WITHOUT a matching binding must be refused up front.
  it('RED (F7): a token with NO audience is refused 400 (binding required)', async () => {
    const env = ed25519Env();
    const token = await makePresentationToken(env);
    const res = await request(appWith(env)).post('/v1/present/verify').send({ token, challenge: 'chal-abcdefghijklmnop' });
    expect(res.status).toBe(400);
    expect(res.body.valid).toBe(false);
  });

  it('RED (F7): a token with NO challenge is refused 400 (binding required)', async () => {
    const env = ed25519Env();
    const token = await makePresentationToken(env);
    const res = await request(appWith(env)).post('/v1/present/verify').send({ token, audience: 'requester-1' });
    expect(res.status).toBe(400);
    expect(res.body.valid).toBe(false);
  });

  it('RED (F7): a token with NEITHER audience nor challenge is refused 400', async () => {
    const env = ed25519Env();
    const token = await makePresentationToken(env);
    const res = await request(appWith(env)).post('/v1/present/verify').send({ token });
    expect(res.status).toBe(400);
    expect(res.body.valid).toBe(false);
  });
});

// =============================================================================
describe('§2.6 requester-named predicates on the public verify surface', () => {
  const PRED = { field: 'continuity.chain_depth', op: 'gte' as const, threshold: 100 };

  it('returns predicate results + standing + disclosed — never the payload/chain', async () => {
    const env = ed25519Env();
    const token = await makePresentationToken(env, { directive: { redact: ['continuity.chain_depth'], predicates: [PRED] }, peCount: 120 });
    const res = await request(appWith(env)).post('/v1/present/verify').send({ token, audience: 'requester-1', challenge: 'chal-abcdefghijklmnop', predicates: [PRED] });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.predicates).toEqual([{ ...PRED, result: true }]);
    expect(res.body.standing['standing.adverse_events']).toBe(0);
    expect(res.body.disclosed['continuity.chain_depth']).toBeUndefined(); // withheld behind the predicate
    expect(res.body.payload).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('provian_jws');
  });

  it('RED: a predicate the requester named that the presenter did NOT answer is refused (predicates_unanswered)', async () => {
    const env = ed25519Env();
    const token = await makePresentationToken(env, { directive: { redact: [], predicates: [] }, peCount: 120 });
    const res = await request(appWith(env)).post('/v1/present/verify').send({ token, audience: 'requester-1', challenge: 'chal-abcdefghijklmnop', predicates: [PRED] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: false, reason: 'predicates_unanswered' });
  });

  it('RED: a predicate answered against a DIFFERENT threshold than the one requested does not satisfy the request', async () => {
    const env = ed25519Env();
    const token = await makePresentationToken(env, { directive: { redact: [], predicates: [{ ...PRED, threshold: 1 }] }, peCount: 120 });
    const res = await request(appWith(env)).post('/v1/present/verify').send({ token, audience: 'requester-1', challenge: 'chal-abcdefghijklmnop', predicates: [PRED] });
    expect(res.body).toEqual({ valid: false, reason: 'predicates_unanswered' });
  });

  it('400 on a malformed predicate list', async () => {
    const env = ed25519Env();
    const token = await makePresentationToken(env);
    const res = await request(appWith(env)).post('/v1/present/verify').send({ token, audience: 'requester-1', challenge: 'chal-abcdefghijklmnop', predicates: [{ field: 'x', op: 'between' }] });
    expect(res.status).toBe(400);
  });
});

describe('§2.7 verify is STATELESS — no verified-presentation counter, no store', () => {
  it('the router takes no database; the same token verifies identically N times; nothing is written', async () => {
    const env = ed25519Env();
    const token = await makePresentationToken(env);
    // The router's deps carry no Firestore at all (jwks + verify need only the public keys).
    const app = appWith(env);
    const verdicts: unknown[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await request(app).post('/v1/present/verify').send({ token, audience: 'requester-1', challenge: 'chal-abcdefghijklmnop' });
      verdicts.push(res.body);
    }
    expect(verdicts[0]).toEqual(verdicts[1]);
    expect(verdicts[1]).toEqual(verdicts[2]);
    expect((verdicts[0] as { valid: boolean }).valid).toBe(true);
    // No verified-count / burn-on-verify field of any kind rides the verdict.
    expect(JSON.stringify(verdicts[0])).not.toMatch(/verif(y|ied)_count|times_verified|verification_count/);
  });
});
