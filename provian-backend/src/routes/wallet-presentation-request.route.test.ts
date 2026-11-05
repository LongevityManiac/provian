/**
 * Human-side presentation-request ROUTES, mounted on the REAL
 * createWalletPresentationRouter with an injected wallet-auth stub. Proves the
 * HTTP wiring + status-code mapping of the channel end to end:
 * GET /v1/wallet/presentation-requests
 * POST /v1/wallet/presentation-requests/:id/challenge
 * POST /v1/wallet/presentation-requests/:id/verify
 * POST /v1/wallet/presentation-requests/:id/decline
 *
 * The agent legs (create, present-back) are driven directly through the store
 * functions the agent routes call — the same real code — so the full state
 * machine is exercised. Every guard is paired with its RED control : a
 * different human is refused (403), a wrong-status transition is refused (409),
 * and a bad verdict is refused (400).
 */
import crypto from 'crypto';
import { describe, it, expect, beforeEach, beforeAll, afterAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { createWalletPresentationRouter } from './wallet-presentation';
import {
  writePresentationRequest,
  recordPresentationForRequest,
} from '../core/pe/presentation-request-store';
import { buildPresentationRequest, type PresentationRequestRecord } from '../core/pe/presentation-request';

type Doc = Record<string, unknown>;
function fakeDb() {
  const store = new Map<string, Map<string, Doc>>();
  const coll = (n: string) => { let c = store.get(n); if (!c) { c = new Map(); store.set(n, c); } return c; };
  const ref = (n: string, id: string) => ({
    id,
    async get() { const d = coll(n).get(id); return { exists: d !== undefined, data: () => (d ? { ...d } : undefined) }; },
    async set(d: Doc) { coll(n).set(id, { ...d }); },
  });
  type Filter = { field: string; op: string; value: unknown };
  const query = (n: string, filters: Filter[]) => ({
    where(f: string, op: string, v: unknown) { return query(n, [...filters, { field: f, op, value: v }]); },
    limit() { return query(n, filters); },
    async get() {
      const rows = [...coll(n).values()].filter((row) => filters.every((f) => {
        const v = (row as Doc)[f.field];
        if (f.op === '==') return v === f.value;
        if (f.op === 'in') return Array.isArray(f.value) && (f.value as unknown[]).includes(v);
        throw new Error(`op ${f.op}`);
      }));
      return { empty: rows.length === 0, docs: rows.map((r, i) => ({ id: `row_${i}`, data: () => ({ ...r }) })) };
    },
  });
  return {
    collection: (n: string) => ({
      doc: (id: string) => ref(n, id),
      where: (f: string, op: string, v: unknown) => query(n, [{ field: f, op, value: v }]),
    }),
    async runTransaction(fn: (t: unknown) => Promise<unknown>) {
      return fn({
        get: (r: { get: () => unknown }) => r.get(),
        set: (r: { set: (d: Doc) => void }, d: Doc) => r.set(d),
      });
    },
  } as unknown as import('firebase-admin/firestore').Firestore;
}

const NOW = Date.now();
let CURRENT_USER = 'user_frank';

function appWith(db: import('firebase-admin/firestore').Firestore) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as unknown as { user: { id: string } }).user = { id: CURRENT_USER }; next(); });
  app.use('/v1/wallet', createWalletPresentationRouter({ db }));
  return app;
}

// compose SIGNS the challenge as the human wallet — seed attestable addresses + a signing key.
const priorKey = process.env.ATTESTATION_SIGNING_KEY;
beforeAll(() => {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const priv = privateKey.export({ format: 'jwk' }) as { x: string; d: string };
  process.env.ATTESTATION_SIGNING_KEY = JSON.stringify({ kty: 'OKP', crv: 'Ed25519', kid: 'route-k1', x: priv.x, d: priv.d });
});
afterAll(() => { if (priorKey === undefined) delete process.env.ATTESTATION_SIGNING_KEY; else process.env.ATTESTATION_SIGNING_KEY = priorKey; });

async function seed(db: import('firebase-admin/firestore').Firestore, humanUserId = 'user_frank'): Promise<PresentationRequestRecord> {
  await db.collection('wallets').doc(`hw_${humanUserId}`).set({ user_id: humanUserId, type: 'human', address: '0x' + '1'.repeat(40) });
  await db.collection('agent_wallets').doc('wallet_aw_1').set({ address: '0x' + '2'.repeat(40) });
  const r = buildPresentationRequest({ agentWalletId: 'wallet_aw_1', humanUserId, note: 'confirm my standing', nowMs: NOW });
  if (!r.ok) throw new Error('seed');
  await writePresentationRequest(db, r.record);
  return r.record;
}

describe('human presentation-request routes', () => {
  beforeEach(() => { CURRENT_USER = 'user_frank'; });

  it('GET lists the human inbox WITH the Tier-3 note (this human only)', async () => {
    const db = fakeDb();
    const rec = await seed(db);
    const res = await request(appWith(db)).get('/v1/wallet/presentation-requests');
    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(1);
    expect(res.body.requests[0].request_id).toBe(rec.request_id);
    expect(res.body.requests[0].note).toBe('confirm my standing'); // human sees the note
    expect(res.body.requests[0].agent_wallet_id).toBe('wallet_aw_1');
  });

  it('HAPPY PATH via HTTP: challenge → (agent presents) → verify → 200s', async () => {
    const db = fakeDb();
    const rec = await seed(db);
    const app = appWith(db);

    const ch = await request(app).post(`/v1/wallet/presentation-requests/${rec.request_id}/challenge`)
      .send({ audience: 'aud-1', challenge: 'chal-abcdefghijklmnop', predicates: [{ field: 'x', op: 'gte', threshold: 1 }] });
    expect(ch.status).toBe(200);
    expect(ch.body.request.status).toBe('challenged');
    // the response carries the relay-signed envelope the agent will verify before burning.
    expect(ch.body.request.challenge_envelope).toMatchObject({ audience: 'user_frank', requester: { type: 'wallet', id: 'user_frank', address: '0x' + '1'.repeat(40) } });

    // agent leg — the real store fn the agent route calls
    await recordPresentationForRequest(db, { requestId: rec.request_id, agentWalletId: 'wallet_aw_1', burnId: 'b'.repeat(64), presentationToken: 'TOKEN', nowMs: NOW });

    const vr = await request(app).post(`/v1/wallet/presentation-requests/${rec.request_id}/verify`).send({ verdict: 'valid', predicate_results: [{ field: 'x', result: true }] });
    expect(vr.status).toBe(200);
    expect(vr.body.request.status).toBe('verified');
    expect(vr.body.request.verdict).toBe('valid');
  });

  it('RED: a DIFFERENT human challenging is 403', async () => {
    const db = fakeDb();
    const rec = await seed(db);
    CURRENT_USER = 'user_imposter';
    const res = await request(appWith(db)).post(`/v1/wallet/presentation-requests/${rec.request_id}/challenge`).send({ audience: 'a', challenge: 'c' });
    expect(res.status).toBe(403);
  });

  it('RED: verifying a request that is not `presented` is 409', async () => {
    const db = fakeDb();
    const rec = await seed(db);
    const app = appWith(db);
    await request(app).post(`/v1/wallet/presentation-requests/${rec.request_id}/challenge`).send({ audience: 'a', challenge: 'c' });
    // still 'challenged', not 'presented'
    const res = await request(app).post(`/v1/wallet/presentation-requests/${rec.request_id}/verify`).send({ verdict: 'valid' });
    expect(res.status).toBe(409);
  });

  it('RED: a bad verdict value is 400 (validated at the route)', async () => {
    const db = fakeDb();
    const rec = await seed(db);
    const res = await request(appWith(db)).post(`/v1/wallet/presentation-requests/${rec.request_id}/verify`).send({ verdict: 'maybe' });
    expect(res.status).toBe(400);
  });

  it('challenging a missing request is 404', async () => {
    const db = fakeDb();
    const res = await request(appWith(db)).post('/v1/wallet/presentation-requests/preq_missing/challenge').send({ audience: 'a', challenge: 'c' });
    expect(res.status).toBe(404);
  });

  it('decline moves requested → declined (200)', async () => {
    const db = fakeDb();
    const rec = await seed(db);
    const res = await request(appWith(db)).post(`/v1/wallet/presentation-requests/${rec.request_id}/decline`).send({});
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('declined');
  });
});

describe(' POST /v1/wallet/present/challenge — a human requester\'s relay-signed challenge', () => {
  it('signs a wallet challenge for the authenticated human (audience = their wallet id); RED: malformed input is a 400', async () => {
    const db = fakeDb();
    await db.collection('wallets').doc('hw_frank').set({ user_id: 'user_frank', type: 'human', address: '0x' + '1'.repeat(40) });
    const app = appWith(db);
    const ok = await request(app).post('/v1/wallet/present/challenge').send({ predicates: [{ field: 'work.total', op: 'gte', threshold: 2 }], ttl_seconds: 600, presenter: '0x' + '3'.repeat(40) });
    expect(ok.status).toBe(200);
    expect(ok.body.challenge).toMatchObject({
      v: 1, audience: 'row_0', presenter: '0x' + '3'.repeat(40),
      requester: { type: 'wallet', id: 'row_0', address: '0x' + '1'.repeat(40), kid: 'route-k1' },
    });
    expect(ok.body.challenge.expiresAt - ok.body.challenge.issuedAt).toBe(600);
    expect(typeof ok.body.challenge.sig).toBe('string');
    const bad = await request(app).post('/v1/wallet/present/challenge').send({ ttl_seconds: 10 });
    expect(bad.status).toBe(400);
    const badPred = await request(app).post('/v1/wallet/present/challenge').send({ predicates: [{ field: 'x' }] });
    expect(badPred.status).toBe(400);
  });
});
