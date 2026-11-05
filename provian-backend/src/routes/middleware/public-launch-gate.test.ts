/**
 * Public discovery is closed while `PUBLIC_LAUNCH` is not exactly `'true'`.
 *
 * The whole point of this gate is a refusal, so the risk is a guard that
 * refuses unconditionally and therefore proves nothing. Every closed case here
 * is paired with the SAME route served through the SAME gate with the flag
 * flipped, returning 200 — so "404" is a measurement, not a constant.
 */

import express from 'express';
import request from 'supertest';
import type { Request } from 'express';
import {
  agentRecordDiscoveryGate,
  isAgentRecordDiscoveryAdmissible,
  isPublicDiscoveryOpen,
  publicDiscoveryGate,
} from './public-launch-gate';
import { createAgentLeaderboardRouter } from '../agent-leaderboard';
import { createAgentProfileRouter } from '../agent-profile';

function appWith(env: Record<string, string | undefined>) {
  const app = express();
  const router = express.Router();
  router.use(publicDiscoveryGate(env));
  router.get('/leaderboard', (_req, res) => {
    res.json({ leaderboard: [{ badges: [{ id: 'genesis_agent' }] }] });
  });
  app.use('/v1', router);
  return app;
}

describe('isPublicDiscoveryOpen', () => {
  it('OPEN for exactly "true"', () => {
    expect(isPublicDiscoveryOpen({ PUBLIC_LAUNCH: 'true' })).toBe(true);
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['false', 'false'],
    ['TRUE (wrong case)', 'TRUE'],
    ['True (wrong case)', 'True'],
    ['1', '1'],
    ['yes', 'yes'],
    ['" true " (whitespace)', ' true '],
    ['on', 'on'],
  ])('CLOSED for %s — no truthiness coercion', (_label, value) => {
    expect(isPublicDiscoveryOpen({ PUBLIC_LAUNCH: value })).toBe(false);
  });

  it('both answers are reachable — the predicate is not a constant', () => {
    const answers = new Set([
      isPublicDiscoveryOpen({ PUBLIC_LAUNCH: 'true' }),
      isPublicDiscoveryOpen({}),
    ]);
    expect([...answers].sort()).toEqual([false, true]);
  });
});

/**
 * Finding 13a — the agent-record read paths (get_agent_record's primary
 * `/record` and fallback `/profile`) admit any KEY-BEARING MCP onboarding caller
 * even while public discovery is closed, so an agent admitted at `/mcp` can
 * actually read a record before launch (retired the key allowlist; the gate
 * now opens on MCP_AGENT_ONBOARDING). It stays NARROWER than `/mcp` itself: an
 * anonymous (keyless) caller is still refused a record read. Every admit is paired
 * with a refuse so the exemption is never a blanket open.
 */
describe('isAgentRecordDiscoveryAdmissible (finding 13a)', () => {
  const onboarding = {
    PUBLIC_LAUNCH: 'false',
    MCP_AGENT_ONBOARDING: 'true',
    MCP_AGENT_ALLOWLIST: 'pvn_key_allow, pvn_key_two', // stale value — must be ignored
  };
  const reqWith = (auth?: string): Request =>
    ({ headers: auth ? { authorization: auth } : {} }) as unknown as Request;

  it('admits ANY key-bearing MCP onboarding caller while public discovery is CLOSED', () => {
    expect(isAgentRecordDiscoveryAdmissible(reqWith('Bearer pvn_key_allow:secret'), onboarding)).toBe(true);
    // A key NOT on the stale allowlist is admitted too — the allowlist is retired.
    expect(isAgentRecordDiscoveryAdmissible(reqWith('Bearer pvn_key_other:secret'), onboarding)).toBe(true);
  });

  it('RED: refuses an ANONYMOUS (keyless) caller — the record read stays key-gated, not a blanket open', () => {
    expect(isAgentRecordDiscoveryAdmissible(reqWith(), onboarding)).toBe(false);
  });

  it('RED: refuses even a key when onboarding is OFF', () => {
    expect(
      isAgentRecordDiscoveryAdmissible(reqWith('Bearer pvn_key_allow:secret'), { PUBLIC_LAUNCH: 'false' }),
    ).toBe(false);
  });

  it('PAIRED CONTROL: public launch admits everyone, anonymous included', () => {
    expect(isAgentRecordDiscoveryAdmissible(reqWith(), { PUBLIC_LAUNCH: 'true' })).toBe(true);
  });

  it('both answers are reachable — the predicate is not a constant', () => {
    const answers = new Set([
      isAgentRecordDiscoveryAdmissible(reqWith('Bearer pvn_key_any:secret'), onboarding), // key → true
      isAgentRecordDiscoveryAdmissible(reqWith(), onboarding), // anonymous → false
    ]);
    expect([...answers].sort()).toEqual([false, true]);
  });

  it('route level: agentRecordDiscoveryGate admits any key, 404s only the anonymous', async () => {
    const app = express();
    const router = express.Router();
    router.get('/rec', agentRecordDiscoveryGate(onboarding), (_q, r) => r.json({ ok: true }));
    app.use('/v1', router);
    expect((await request(app).get('/v1/rec').set('Authorization', 'Bearer pvn_key_allow:secret')).status).toBe(200);
    expect((await request(app).get('/v1/rec').set('Authorization', 'Bearer pvn_key_other:secret')).status).toBe(200);
    expect((await request(app).get('/v1/rec')).status).toBe(404);
  });
});

describe('publicDiscoveryGate (route level)', () => {
  it('404s an anonymous request while closed, and does not reach the handler', async () => {
    const res = await request(appWith({ PUBLIC_LAUNCH: 'false' })).get('/v1/leaderboard');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not found' });
    expect(JSON.stringify(res.body)).not.toMatch(/genesis/i);
  });

  it('404s when the variable is ABSENT (unknown is closed, not open)', async () => {
    const res = await request(appWith({})).get('/v1/leaderboard');
    expect(res.status).toBe(404);
  });

  it('PAIRED CONTROL: the identical route returns 200 with the flag flipped', async () => {
    const res = await request(appWith({ PUBLIC_LAUNCH: 'true' })).get('/v1/leaderboard');
    expect(res.status).toBe(200);
    // The control proves the gate is what closed it — the payload really does
    // carry the Genesis disclosure that the closed case must not emit.
    expect(JSON.stringify(res.body)).toMatch(/genesis_agent/);
  });

  it('404 rather than 403: a 403 would confirm the surface exists', async () => {
    expect((await request(appWith({})).get('/v1/leaderboard')).status).not.toBe(403);
  });

  it('is evaluated PER REQUEST, not captured at mount', async () => {
    const env: Record<string, string | undefined> = { PUBLIC_LAUNCH: 'true' };
    const app = appWith(env);
    expect((await request(app).get('/v1/leaderboard')).status).toBe(200);
    env.PUBLIC_LAUNCH = 'false'; // re-close AFTER the router was built
    expect((await request(app).get('/v1/leaderboard')).status).toBe(404);
  });
});

/**
 * THE DEFECT THIS EXISTS TO PREVENT, and it was real.
 *
 * The first wiring used `router.use(publicDiscoveryGate())`. The leaderboard
 * router is mounted at `app.use('/v1', ...)` and the profile router at
 * `app.use('/v1/agents', ...)`, both BEFORE ~150 routes that server.ts declares
 * later. Router-level middleware that ANSWERS 404 swallows every request that
 * falls through to it, so with `PUBLIC_LAUNCH=false` the closed gate 404'd
 * `/v1/agents/directory`, `/v1/pe/submit/mobile`, and every
 * `/v1/internal/scheduler/*` endpoint. Measured, not hypothesised: 404/404/404.
 *
 * The gate must close ITS OWN routes and leave everything else untouched.
 */
describe('the gate does not shadow routes mounted after it', () => {
  const deps = {
    db: { collection: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }) },
    cache: {
      get: async () => null,
      set: async () => {},
      checkRateLimit: async () => ({ allowed: true }),
    },
  } as never;

  function serverShapedApp() {
    const app = express();
    // Same order as server.ts: both gated routers first, later routes after.
    app.use('/v1/agents', createAgentProfileRouter(deps));
    app.use('/v1', createAgentLeaderboardRouter(deps));
    app.get('/v1/agents/directory', (_q, r) => { r.json({ agents: [], count: 0 }); });
    app.post('/v1/pe/submit/mobile', (_q, r) => { r.json({ ok: true }); });
    app.post('/v1/internal/scheduler/auto-release', (_q, r) => { r.json({ ok: true }); });
    return app;
  }

  const originalPublicLaunch = process.env.PUBLIC_LAUNCH;
  afterEach(() => {
    if (originalPublicLaunch === undefined) delete process.env.PUBLIC_LAUNCH;
    else process.env.PUBLIC_LAUNCH = originalPublicLaunch;
  });

  it('later routes are UNTOUCHED while the gate is closed', async () => {
    process.env.PUBLIC_LAUNCH = 'false';
    const app = serverShapedApp();
    expect((await request(app).get('/v1/agents/directory')).status).toBe(200);
    expect((await request(app).post('/v1/pe/submit/mobile')).status).toBe(200);
    expect((await request(app).post('/v1/internal/scheduler/auto-release')).status).toBe(200);
  });

  it('and the gated routes themselves ARE closed — so the test above is not vacuous', async () => {
    process.env.PUBLIC_LAUNCH = 'false';
    const app = serverShapedApp();
    expect((await request(app).get('/v1/leaderboard')).status).toBe(404);
    expect((await request(app).get('/v1/agents/wallet_aw_x/profile')).status).toBe(404);
    expect((await request(app).get('/v1/agents/wallet_aw_x/provenance')).status).toBe(404);
  });

  it('later routes are also untouched while the gate is OPEN', async () => {
    process.env.PUBLIC_LAUNCH = 'true';
    const app = serverShapedApp();
    expect((await request(app).get('/v1/agents/directory')).status).toBe(200);
    expect((await request(app).post('/v1/internal/scheduler/auto-release')).status).toBe(200);
  });
});
