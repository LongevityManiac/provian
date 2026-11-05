/**
 * GET /v1/witnesses/github/installs - route tests.
 *
 * Exercises the thin list endpoint that backs the mobile "connected
 * services" view. Covers:
 *  - 401 when the device-auth middleware did not attach a device owner
 *  - 200 with the authenticated user's installs, mapped to the public
 *    shape { installation_id, installed_at, revoked_at }
 *  - revoked_at normalized to null when absent on the stored doc
 *  - 200 with an empty list for a user with no installs
 *
 * The real device-auth middleware performs DeviceSignature verification,
 * which is out of scope here; it is replaced with a stub that attaches
 * req.device.owner_wallet_id from an x-test-user header so the route's own
 * logic (owner extraction + field mapping) is what gets exercised.
 */

import { describe, it, expect, jest } from '@jest/globals';

// Stub the device-auth middleware: attach req.device from a test header so
// we test the route handler, not signature verification.
jest.mock('./middleware/device-auth', () => ({
  createDeviceAuthMiddleware: () => (req: any, _res: any, next: any) => {
    const u = req.headers['x-test-user'];
    if (typeof u === 'string' && u.length > 0) {
      req.device = { owner_wallet_id: u };
    }
    next();
  },
}));

import express from 'express';
import request from 'supertest';
import { createWitnessesGitHubRouter } from './witnesses-github';

// In-memory installs keyed by user_id; the fake db's where('user_id','==',u)
// query returns the matching docs in getServiceInstallsByUser's shape.
function buildApp(installsByUser: Record<string, any[]>): express.Express {
  const db: any = {
    collection: () => ({
      where: (_field: string, _op: string, userId: string) => ({
        async get() {
          const rows = installsByUser[userId] ?? [];
          return { docs: rows.map((r) => ({ data: () => r })) };
        },
      }),
    }),
  };
  const deps: any = { db };
  const app = express();
  app.use(express.json());
  app.use('/v1/witnesses', createWitnessesGitHubRouter(deps));
  return app;
}

describe('GET /v1/witnesses/github/installs', () => {
  it('401 when no device owner is attached', async () => {
    const res = await request(buildApp({})).get('/v1/witnesses/github/installs');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'no_device_owner' });
  });

  it('200 with the user\'s installs mapped to the public shape', async () => {
    const app = buildApp({
      user_1: [
        { user_id: 'user_1', provider: 'github', installation_id: '111', installed_at: 1000, revoked_at: null },
        { user_id: 'user_1', provider: 'github', installation_id: '222', installed_at: 2000, revoked_at: 2500 },
      ],
    });
    const res = await request(app).get('/v1/witnesses/github/installs').set('x-test-user', 'user_1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      installs: [
        { installation_id: '111', installed_at: 1000, revoked_at: null },
        { installation_id: '222', installed_at: 2000, revoked_at: 2500 },
      ],
    });
    // Custody invariant: no user_id / provider leaked in the response.
    expect(JSON.stringify(res.body)).not.toContain('user_id');
    expect(JSON.stringify(res.body)).not.toContain('provider');
  });

  it('normalizes a missing revoked_at to null', async () => {
    const app = buildApp({
      user_2: [
        { user_id: 'user_2', provider: 'github', installation_id: '333', installed_at: 3000 },
      ],
    });
    const res = await request(app).get('/v1/witnesses/github/installs').set('x-test-user', 'user_2');
    expect(res.status).toBe(200);
    expect(res.body.installs).toEqual([
      { installation_id: '333', installed_at: 3000, revoked_at: null },
    ]);
  });

  it('200 with an empty list for a user with no installs', async () => {
    const res = await request(buildApp({}))
      .get('/v1/witnesses/github/installs')
      .set('x-test-user', 'user_nobody');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ installs: [] });
  });
});
