/**
 * a job's deliverable body and locator are readable by its two parties
 * only. Before `GET /v1/commons/jobs/:jobId` was unauthenticated and spread the whole job
 * document through `serializeHumanJob`, so anyone could read `deliverable.body` / `deliverable.uri`
 * of an in-progress or completed job; `GET /jobs?status=in_progress|completed` bulk-listed them.
 *
 * RED controls: the public detail + list reads (no viewer) carry no body and no uri; a stranger's
 * authenticated read of `/jobs/:jobId/deliverable` is 403. Positive controls: the poster and the
 * accepted applicant read the body through the authenticated routes.
 */
import { Router } from 'express';
import type { HumanJob } from '../core/commons/types';

let mockViewer: string | null = null;
jest.mock('./middleware/commons-auth', () => ({
  getAuthenticatedWallet: jest.fn(async () => (mockViewer === null ? null : {
    walletId: mockViewer,
    agentId: `agent_${mockViewer}`,
    actorAddress: null,
    isAgent: false,
  })),
}));

const BODY = 'the private deliverable body — for the poster only';
const URI = 'https://private.example/deliverable?token=secret';
const SHA = 'd'.repeat(64);
const JOB = {
  job_id: 'hjob_1',
  title: 'A job',
  poster_wallet_id: 'poster_1',
  accepted_applicant_wallet_id: 'worker_1',
  status: 'in_progress',
  deliverable: { uri: URI, body: BODY, sha256: SHA, delivered_at: 1_800_000_000_000 },
} as unknown as HumanJob;

jest.mock('../core/commons/human-jobs', () => ({
  ...(jest.requireActual('../core/commons/human-jobs') as object),
  getHumanJob: jest.fn(async () => JOB),
  browseHumanJobs: jest.fn(async () => ({ jobs: [JOB], total: 1 })),
  getMyHumanJobs: jest.fn(async () => ({ posted: [JOB], assigned: [], total: 1, has_more: false })),
}));
jest.mock('../core/commons/featured', () => ({
  ...(jest.requireActual('../core/commons/featured') as object),
  listFeatured: jest.fn(async () => []),
}));

import { createCommonsRouter, serializeHumanJob } from './commons';

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean>; stack: { handle: (req: unknown, res: unknown) => unknown }[] };
}

function handlerFor(router: Router, path: string): (req: unknown, res: unknown) => Promise<unknown> {
  const stack = (router as unknown as { stack: RouteLayer[] }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route?.methods?.get);
  if (!layer?.route) throw new Error(`no GET ${path}`);
  return layer.route.stack[0].handle as (req: unknown, res: unknown) => Promise<unknown>;
}

async function call(router: Router, path: string, params: Record<string, string> = {}, query: Record<string, string> = {}) {
  const captured: { status: number; body?: unknown } = { status: 200 };
  const res = {
    status(code: number) { captured.status = code; return this; },
    json(payload: unknown) { captured.body = payload; return this; },
  };
  await handlerFor(router, path)({ params, query, headers: {}, body: {} }, res);
  return captured;
}

const deps = {
  db: { collection: () => ({ doc: () => ({ get: jest.fn() }) }) },
  cache: { checkRateLimit: jest.fn(async () => ({ allowed: true, retryAfter: 0 })) },
  peBuffer: { enqueue: jest.fn() },
  recordPEAccrual: jest.fn(),
} as unknown as Parameters<typeof createCommonsRouter>[0];

const carriesSecret = (value: unknown): boolean => {
  const s = JSON.stringify(value);
  return s.includes(BODY) || s.includes(URI);
};

describe('a deliverable is readable by the job\'s parties only', () => {
  let router: Router;
  beforeAll(() => { router = createCommonsRouter(deps); });
  beforeEach(() => { mockViewer = null; });

  it('control: the fixture really carries a body and a uri (a pass is not a vacuous pass)', () => {
    expect(carriesSecret(JOB)).toBe(true);
  });

  it('RED: the unauthenticated job detail read carries no body and no uri — only the sha256', async () => {
    const out = await call(router, '/jobs/:jobId', { jobId: 'hjob_1' });
    expect(out.status).toBe(200);
    expect(carriesSecret(out.body)).toBe(false);
    expect((out.body as { deliverable?: unknown }).deliverable).toEqual({ sha256: SHA, delivered_at: 1_800_000_000_000 });
  });

  it('RED: the public detail read passes no viewer — even the poster\'s token does not open it there', async () => {
    mockViewer = 'poster_1';
    const out = await call(router, '/jobs/:jobId', { jobId: 'hjob_1' });
    expect(carriesSecret(out.body)).toBe(false);
  });

  it('RED: the public board list (status=in_progress) carries no body and no uri', async () => {
    const out = await call(router, '/jobs', {}, { status: 'in_progress' });
    expect(out.status).toBe(200);
    expect((out.body as { jobs: unknown[] }).jobs).toHaveLength(1);
    expect(carriesSecret(out.body)).toBe(false);
  });

  it('RED: the market board list carries no body and no uri', async () => {
    const out = await call(router, '/market/jobs');
    expect((out.body as { jobs: unknown[] }).jobs).toHaveLength(1);
    expect(carriesSecret(out.body)).toBe(false);
  });

  it('RED: a stranger\'s authenticated deliverable read is refused 403; an anonymous one 401', async () => {
    mockViewer = 'stranger_9';
    expect((await call(router, '/jobs/:jobId/deliverable', { jobId: 'hjob_1' })).status).toBe(403);
    mockViewer = null;
    expect((await call(router, '/jobs/:jobId/deliverable', { jobId: 'hjob_1' })).status).toBe(401);
  });

  it.each(['poster_1', 'worker_1'])('the party %s reads the body through the authenticated deliverable route', async (viewer) => {
    mockViewer = viewer;
    const out = await call(router, '/jobs/:jobId/deliverable', { jobId: 'hjob_1' });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ job_id: 'hjob_1', deliverable: JOB.deliverable });
  });

  it('the poster reads the body through /jobs/mine (authenticated, viewer = the poster)', async () => {
    mockViewer = 'poster_1';
    const out = await call(router, '/jobs/mine');
    expect(out.status).toBe(200);
    expect(carriesSecret(out.body)).toBe(true);
  });

  it('serializeHumanJob: party → full deliverable; anyone else or no viewer → sha256 + time only', () => {
    expect((serializeHumanJob(JOB, 'poster_1').deliverable as { body: string }).body).toBe(BODY);
    expect((serializeHumanJob(JOB, 'worker_1').deliverable as { uri: string }).uri).toBe(URI);
    for (const viewer of [null, '', 'stranger_9']) {
      expect(carriesSecret(serializeHumanJob(JOB, viewer))).toBe(false);
    }
    const noDeliverable = { ...JOB, deliverable: undefined } as HumanJob;
    expect('deliverable' in serializeHumanJob(noDeliverable, null)).toBe(false);
  });
});
