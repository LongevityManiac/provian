/**
 * GET /v1/wallet/launch-state — the one launch switch the app reads.
 *
 * The Connect screen's MCP / SDK / fleet options and the Devices note read this answer, so it
 * must be the SAME predicate that opens `/mcp` and turns the wallet-create welcome's MCP pointer
 * from `opens_at_launch` into a plain URL: `PUBLIC_LAUNCH === 'true'` and nothing else.
 *
 * RED controls: a hard-coded `launched: false` fails the "flips with PUBLIC_LAUNCH" case; a truthy
 * coercion (`!!env.PUBLIC_LAUNCH`) fails the unknown-value cases; a route mounted without auth
 * fails the 401 case.
 */
import { describe, it, expect } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { createLaunchStateRouter, launchState } from './launch-state';
import { isPublicDiscoveryOpen } from './middleware/public-launch-gate';

const allow: RequestHandler = (_req, _res, next) => next();
const deny: RequestHandler = (_req, res) => { res.status(401).json({ error: 'unauthorized' }); };

function app(env: Record<string, string | undefined>, auth: RequestHandler = allow) {
  const a = express();
  a.use('/v1/wallet/launch-state', createLaunchStateRouter({ authenticate: auth, env }));
  return a;
}

describe('launch-state reads the launch switch', () => {
  it('flips with PUBLIC_LAUNCH, read per request', async () => {
    const env: Record<string, string | undefined> = { PUBLIC_LAUNCH: 'false' };
    const a = app(env);
    const before = await request(a).get('/v1/wallet/launch-state');
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ launched: false, mcp_url: 'https://api.provian.ai/mcp' });
    env.PUBLIC_LAUNCH = 'true';
    const after = await request(a).get('/v1/wallet/launch-state');
    expect(after.body.launched).toBe(true);
  });

  it('unknown values stay closed (no truthiness)', () => {
    for (const v of [undefined, '', 'TRUE', '1', 'yes', ' true ']) {
      expect(launchState({ PUBLIC_LAUNCH: v }).launched).toBe(false);
    }
  });

  it('is the same predicate public discovery and /mcp read', () => {
    for (const v of [undefined, 'false', 'true', 'TRUE', '1']) {
      expect(launchState({ PUBLIC_LAUNCH: v }).launched).toBe(isPublicDiscoveryOpen({ PUBLIC_LAUNCH: v }));
    }
  });

  it('names the MCP server under API_BASE_URL', () => {
    expect(launchState({ API_BASE_URL: 'https://relay.example/' }).mcp_url).toBe('https://relay.example/mcp');
  });

  it('requires wallet auth', async () => {
    const res = await request(app({ PUBLIC_LAUNCH: 'true' }, deny)).get('/v1/wallet/launch-state');
    expect(res.status).toBe(401);
  });
});
