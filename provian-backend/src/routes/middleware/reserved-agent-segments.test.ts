/**
 * Regression tests for the /v1/agents/:agentId route shadow.
 *
 * The legacy AI-controls param routes (server.ts ~:2441 GET / ~:2475 PUT /
 * ~:2520 DELETE) are registered thousands of lines before the public
 * agent-directory router on the same prefix. Express matches in registration
 * order, so before the fix `GET /v1/agents/directory` resolved with
 * `agentId="directory"` and the authenticate middleware 401'd the documented
 * PUBLIC directory read (live-reproduced on prod 2026-07-07).
 *
 * These tests exercise the REAL production pieces — skipReservedAgentSegments
 * and createAgentDirectoryRouter — wired in the same order server.ts uses,
 * and prove (a) the guard un-shadows the directory, (b) removing the guard
 * reintroduces the bug (so this suite would catch a regression), and (c) the
 * legacy routes stay exactly as authenticated as before for real agent ids.
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import type { Firestore } from 'firebase-admin/firestore';
import { RESERVED_AGENT_SEGMENTS, skipReservedAgentSegments } from './reserved-agent-segments';
import { createAgentDirectoryRouter } from '../agent-directory';
import type { AgentBankDeps } from '../../core/agent-bank/types';
import { createFakeFirestore } from '../../core/pvt/__test-helpers__/fake-firestore';

/** Mirrors wallet-auth's observable behavior: 401 without a Bearer header. */
function stubAuthenticate(req: Request, res: Response, next: NextFunction): void {
  if (!req.headers.authorization) {
    res.status(401).json({ error: 'Missing authorization header' });
    return;
  }
  next();
}

function buildApp(opts: { withGuard: boolean }): Express {
  const app = express();
  app.use(express.json());

  // 1. Legacy param routes, registered FIRST — same order as server.ts.
  const guards = opts.withGuard ? [skipReservedAgentSegments] : [];
  app.get('/v1/agents/:agentId', ...guards, stubAuthenticate, (req: Request, res: Response) => {
    res.json({ legacy_lookup: req.params.agentId });
  });
  app.put('/v1/agents/:agentId', ...guards, stubAuthenticate, (req: Request, res: Response) => {
    res.json({ legacy_update: req.params.agentId });
  });

  // 2. Public directory router, mounted AFTER (server.ts mounts it ~7,700
  //    lines later). Real router + fake Firestore; the cache stub satisfies
  //    the deps shape (GET /directory itself is unauthenticated + unlimited).
  const fake = createFakeFirestore();
  const deps = {
    db: fake as unknown as Firestore,
    cache: { checkRateLimit: async () => ({ allowed: true }) },
  } as unknown as AgentBankDeps;
  app.use('/v1/agents', createAgentDirectoryRouter(deps));

  return app;
}

describe('skipReservedAgentSegments (unit)', () => {
  it('reserves the directory segment', () => {
    expect(RESERVED_AGENT_SEGMENTS.has('directory')).toBe(true);
  });

  it("passes reserved names to the next route via next('route')", () => {
    const next = jest.fn();
    skipReservedAgentSegments(
      { params: { agentId: 'directory' } } as unknown as Request,
      {} as Response,
      next,
    );
    expect(next).toHaveBeenCalledWith('route');
  });

  it('lets real agent ids continue down the legacy route chain', () => {
    const next = jest.fn();
    skipReservedAgentSegments(
      { params: { agentId: 'agent_1234' } } as unknown as Request,
      {} as Response,
      next,
    );
    expect(next).toHaveBeenCalledWith();
  });
});

describe('GET /v1/agents/directory (integration, real directory router)', () => {
  it('is publicly reachable with the guard in place — the fix', async () => {
    const app = buildApp({ withGuard: true });
    const res = await request(app).get('/v1/agents/directory').expect(200);
    // : the directory also lists x402 sellers, in their own additive section.
    expect(res.body).toEqual({ agents: [], count: 0, x402_sellers: [], x402_sellers_next_cursor: null });
  });

  it('is shadowed into a 401 without the guard — proves this suite catches the regression', async () => {
    const app = buildApp({ withGuard: false });
    const res = await request(app).get('/v1/agents/directory').expect(401);
    expect(res.body.error).toBe('Missing authorization header');
  });

  it('leaves the legacy lookup exactly as authenticated as before', async () => {
    const app = buildApp({ withGuard: true });
    await request(app).get('/v1/agents/agent_abc123').expect(401);
    const authed = await request(app)
      .get('/v1/agents/agent_abc123')
      .set('Authorization', 'Bearer something')
      .expect(200);
    expect(authed.body).toEqual({ legacy_lookup: 'agent_abc123' });
  });

  it('applies to the PUT sibling too (reserved names never reach legacy handlers)', async () => {
    const app = buildApp({ withGuard: true });
    // No PUT /directory route exists after fall-through → Express default 404,
    // NOT the legacy authenticated handler.
    await request(app).put('/v1/agents/directory').send({}).expect(404);
  });
});
