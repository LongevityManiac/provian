/** Record and reputation discovery must remain available while legacy PVT reads are removed. */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import express, { type Express } from 'express';
import request from 'supertest';
import { mountOpenAPIRoutes } from './openapi';
import { createEcosystemRouter } from './ecosystem';

const MINT_ONCE_TRUTH = 'every act of work mints pvt once at its best-supported value';

function buildApp(): Express {
  const app = express();
  mountOpenAPIRoutes(app);
  app.use('/v1/ecosystem', createEcosystemRouter());
  return app;
}

describe('truthful discovery of record-only PVT, record, and reputation reads', () => {
  let app: Express;
  let priorLaunch: string | undefined;

  beforeAll(() => {
    priorLaunch = process.env.PUBLIC_LAUNCH;
    process.env.PUBLIC_LAUNCH = 'true'; // discovery routes are launch-gated
    app = buildApp();
  });

  afterAll(() => {
    if (priorLaunch === undefined) delete process.env.PUBLIC_LAUNCH;
    else process.env.PUBLIC_LAUNCH = priorLaunch;
  });

  describe('/v1/openapi.json', () => {
    it('documents the live estimator at launch while hiding the legacy PVT reads', async () => {
      // Mounted with PUBLIC_LAUNCH=true → the LAUNCHED spec : the live,
      // launch-gated /v1/pvt/estimate is documented; the legacy PVTv8-era reads
      // (503 from the runtime boundary in every posture) never are.
      const res = await request(app).get('/v1/openapi.json');
      expect(res.status).toBe(200);
      expect(res.body.paths['/v1/pvt/estimate']).toBeDefined();
      expect(res.body.paths['/v1/pvt/stats']).toBeUndefined();
      expect(res.body.paths['/v1/pvt/mint-history']).toBeUndefined();
      expect(res.body.paths['/v1/pvt/accrual'].get.description).toContain('Record-only');
      expect(res.body.paths['/v1/pvt/history'].get.responses['410'].description).toBe('pe_kept_by_owner');
      expect(res.body.paths['/v1/pvt/history'].get.responses['200']).toBeUndefined();
      expect(res.body.paths['/v1/pvt/network-stats'].get.security).toEqual([]);
      expect(res.body['x-pvt9-runtime']).toMatchObject({
        // B10 + DERIVED per env. This test instance sets no
        // arming env, so
        // the honest block is configured/false — deployed alone is constant
        // (a chain fact). The armed leg is asserted separately with the env
        // set, proving the derivation moves.
        status: 'configured',
        deployed: true,
        mint_active: false,
        settlement_active: false,
      });
    });

    it('documents the record + badge endpoints under the Provenance Record tag', async () => {
      const res = await request(app).get('/v1/openapi.json');
      const record = res.body.paths['/v1/agents/{identifier}/record'];
      const badge = res.body.paths['/v1/agents/{identifier}/badge.svg'];
      expect(record).toBeDefined();
      expect(badge).toBeDefined();
      expect(record.get.tags).toEqual(['Provenance Record']);
      expect(record.get.security).toEqual([]);
      expect(record.get.description.toLowerCase()).toContain(MINT_ONCE_TRUTH);
      expect(record.get.description).toContain('The PVT kernel is live on Base');
      expect(record.get.description).toContain('chain-verified');
      const tagNames = (res.body.tags as Array<{ name: string }>).map(t => t.name);
      expect(tagNames).toContain('Provenance Record');
    });

    it('documents the reputation endpoint with the honest unknown-address contract', async () => {
      const res = await request(app).get('/v1/openapi.json');
      const rep = res.body.paths['/v1/reputation/address/{address}'];
      expect(rep).toBeDefined();
      expect(rep.get.tags).toEqual(['Reputation']);
      expect(rep.get.security).toEqual([]);
      expect(rep.get.description).toContain('{ known: false }');
      expect(rep.get.description).toContain('not a score');
      expect(rep.get.description).toContain('free_beta');
      const tagNames = (res.body.tags as Array<{ name: string }>).map(t => t.name);
      expect(tagNames).toContain('Reputation');
    });
  });

  describe('/v1/ecosystem', () => {
    it('lists public trust reads and network record stats, never the estimator', async () => {
      const res = await request(app).get('/v1/ecosystem');
      expect(res.status).toBe(200);
      const publicEndpoints = res.body.auth.public.endpoints as string[];
      expect(publicEndpoints).toEqual(expect.arrayContaining([
        'GET /v1/agents/:identifier/record',
        'GET /v1/agents/:identifier/badge.svg',
        'GET /v1/reputation/address/:address',
        'GET /v1/pvt/network-stats',
      ]));
      expect(publicEndpoints).not.toContain('GET /v1/pvt/estimate');
    });

    it('catalogs safe record reads and keeps Forum available without Court escalation', async () => {
      const res = await request(app).get('/v1/ecosystem');
      expect(res.body.services.provenance_records.endpoints).toEqual(expect.arrayContaining([
        'GET /v1/pvt/accrual',
        'GET /v1/pvt/history',
        'GET /v1/pvt/network-stats',
      ]));
      // challenges resolve by burn-to-present; Court escalation is retired, nothing is unavailable.
      expect(res.body.services.forum).toMatchObject({
        status: 'live',
        unavailable: [],
        available: expect.arrayContaining(['challenges', 'challenge_answers']),
      });
      expect(res.body.services.forum.challenges).toContain('burn-to-present');
      expect(res.body.services.threads.status).toBe('live');
      expect(res.body.services.wants.status).toBe('live');
    });

    it('exposes the new surfaces in the links map', async () => {
      const res = await request(app).get('/v1/ecosystem');
      const links = res.body.links as Record<string, string>;
      expect(links.agent_record).toContain('/v1/agents/{identifier}/record');
      expect(links.record_badge).toContain('/v1/agents/{identifier}/badge.svg');
      expect(links.address_reputation).toContain('/v1/reputation/address/{address}');
      expect(links.pvt_accrual_records).toContain('/v1/pvt/accrual');
      expect(links.pvt_history_records).toContain('/v1/pvt/history');
      expect(links.pvt_estimate).toBeUndefined();
    });
  });
});
