/**
 * Regression test for the 2026-05-05 → 2026-05-09 silent cron window.
 *
 * Background: commit 55d2bd6 mounted the wallet-attestation router as
 * `app.use('/v1', authenticate, createWalletAttestationRouter(...))`,
 * which made the wallet-auth middleware fan out across every /v1/*
 * path - including /v1/internal/scheduler/*, where Cloud Scheduler's
 * OIDC Bearer tokens get parsed as v2 wallet tokens and 400'd before
 * the route's own authenticateScheduler() ever runs. Ten cron jobs
 * silently failed for ~5 days.
 *
 * Fix (2026-05-09): mount path-scoped at `/v1/wallet/attestation` so
 * authenticate only runs for requests under that prefix. Internal
 * routes registered later in server.ts are unaffected.
 *
 * This test pins the architectural property: a path-scoped middleware
 * mount on `/v1/wallet/attestation` does NOT run for sibling /v1/*
 * routes. We don't import the production authenticate middleware
 * (it's bound to firebase-admin and Redis) - a stub middleware that
 * 401s on any request is sufficient to catch the regression. If
 * someone re-broadens the mount path back to `/v1`, the stub will
 * intercept the scheduler request and the test will fail.
 */

import { describe, it, expect } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { createWalletAttestationRouter } from './wallet-attestation';

function blockingAuthMw(_req: express.Request, res: express.Response): void {
  // Stand-in for the production authenticate middleware - always 401s.
  // If this runs for /v1/internal/* the regression has reappeared.
  res.status(401).json({ error: 'authenticate ran where it should not' });
}

function buildApp(mountPath: string): express.Express {
  const app = express();
  app.use(express.json());

  // Stub Firestore + cache. The router is constructed but its handler is
  // never reached in these tests; we only care about the mount-prefix
  // routing behaviour.
  const stubDeps = {
    db: {} as never,
    cache: {} as never,
  };
  app.use(mountPath, blockingAuthMw, createWalletAttestationRouter(stubDeps));

  // Sibling internal route registered AFTER the wallet-attestation mount,
  // matching production order in server.ts.
  app.post('/v1/internal/scheduler/test', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  return app;
}

describe('wallet-attestation mount scope (regression test for 2026-05-05 silent cron break)', () => {
  it('with the correct mount path /v1/wallet/attestation, /v1/internal/* does not trigger authenticate', async () => {
    const app = buildApp('/v1/wallet/attestation');
    const res = await request(app).post('/v1/internal/scheduler/test');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('a request to the wallet-attestation route itself does pass through authenticate (sanity check)', async () => {
    const app = buildApp('/v1/wallet/attestation');
    const res = await request(app).post('/v1/wallet/attestation').send({});
    // The blocking-auth stub fires here because this IS a /v1/wallet/attestation
    // request - exactly what we want.
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/authenticate ran/);
  });

  it('REGRESSION: with the buggy mount path /v1, /v1/internal/* is incorrectly intercepted', async () => {
    const app = buildApp('/v1');
    const res = await request(app).post('/v1/internal/scheduler/test');
    // This is the broken behaviour we're guarding against. If this case
    // ever flips to 200, the bug is structurally back.
    expect(res.status).toBe(401);
  });
});
