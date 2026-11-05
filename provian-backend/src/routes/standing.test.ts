/**
 * F6 — GET /v1/standing/:id is PRIVATE. The document id is the burn_id, derivable
 * from public on-chain burns, so an unauthenticated crawler could reconstruct the
 * presentation interaction graph. The route now requires auth and returns the row
 * ONLY to the presenter wallet or the named audience; everyone else gets 404
 * (existence is never confirmed). RED controls below.
 *
 * The dual-auth middleware is mocked to inject req.pvtAuth from a test header so
 * the GATE logic is exercised without real credential setup; agent callers avoid
 * the human-wallet resolution path entirely.
 */
import { describe, it, expect, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

jest.mock('./middleware/pvt-dual-auth', () => ({
  createPVTDualAuthMiddleware: () => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const hdr = req.headers['x-test-pvtauth'];
    if (typeof hdr !== 'string') { res.status(401).json({ error: 'auth required' }); return; }
    (req as unknown as { pvtAuth: unknown }).pvtAuth = JSON.parse(hdr);
    next();
  },
}));

import { createStandingRouter } from './standing';

const META = {
  presentation_id: 'pres_1',
  tier: 'reputation',
  wallet_id: 'aw_presenter',
  presenter_address: '0x' + '11'.repeat(20),
  audience: 'aw_audience',
  issued_at: 1,
  expires_at: 2,
};

function fakeDeps() {
  const db = {
    collection: (_n: string) => ({
      doc: (_id: string) => ({ async get() { return { exists: true, id: 'burn_1', data: () => ({ ...META }) }; } }),
      where: () => ({ where: () => ({ limit: () => ({ async get() { return { empty: true, docs: [] }; } }) }), limit: () => ({ async get() { return { empty: true, docs: [] }; } }) }),
    }),
  };
  return { db, cache: {} } as unknown as import('../core/agent-bank/types').AgentBankDeps;
}

function app() {
  const a = express();
  a.use(express.json());
  a.use('/v1/standing', createStandingRouter(fakeDeps()));
  return a;
}

const asAgent = (id: string) => JSON.stringify({ type: 'agent', userId: id });

describe('GET /v1/standing/:id privacy gate (F6)', () => {
  it('RED: an unauthenticated request is refused (no interaction graph leak)', async () => {
    const res = await request(app()).get('/v1/standing/burn_1');
    expect(res.status).toBe(401);
  });

  it('RED: a stranger (neither presenter nor audience) gets 404, never the row', async () => {
    const res = await request(app()).get('/v1/standing/burn_1').set('x-test-pvtauth', asAgent('aw_stranger'));
    expect(res.status).toBe(404);
    expect(res.body.wallet_id).toBeUndefined();
    expect(res.body.audience).toBeUndefined();
    expect(res.body.presenter_address).toBeUndefined();
  });

  it('the presenter wallet sees the row', async () => {
    const res = await request(app()).get('/v1/standing/burn_1').set('x-test-pvtauth', asAgent('aw_presenter'));
    expect(res.status).toBe(200);
    expect(res.body.wallet_id).toBe('aw_presenter');
    expect(res.body.audience).toBe('aw_audience');
  });

  it('the named audience sees the row', async () => {
    const res = await request(app()).get('/v1/standing/burn_1').set('x-test-pvtauth', asAgent('aw_audience'));
    expect(res.status).toBe(200);
    expect(res.body.wallet_id).toBe('aw_presenter');
  });
});
