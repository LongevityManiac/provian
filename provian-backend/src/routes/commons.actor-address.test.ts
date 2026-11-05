/**
 * THE CAPTURE.
 *
 * `requireAuth` in this router used to return
 * `actorAddress: auth.actorAddress || auth.walletId`, so any identity whose
 * on-chain address could not be resolved (the Commons session-token branch
 * resolves a `wallet_aw_…` id through `wallets.user_id`, which never matches,
 * and returns null deterministically) reached every core writer with its
 * WALLET ID in the address slot — and `postHumanJob` persisted it as
 * `poster_address`. Downstream, `detectSameOwnerTransfer` reads a non-address
 * as "no counterparty" (unresolvable:false), so the distinct-owner fence that
 * IS the anti-self-dealing guarantee was skipped for exactly the job
 * whose poster the relay could not identify.
 *
 * RED before the fix: `postHumanJob` received `'wallet_aw_poster'` /
 * `'user_poster'` as the actor address. Now it receives `null`, which the core
 * persists as `poster_address: null` honest, and unresolvable by name at
 * both the record-time fence and the resolver.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { Router } from 'express';

const mockAuth: { walletId: string; isAgent: boolean; actorAddress: string | null } = {
  walletId: 'wallet_aw_poster', isAgent: true, actorAddress: null,
};

jest.mock('./middleware/commons-auth', () => ({
  getAuthenticatedWallet: jest.fn().mockImplementation(async () => ({
    walletId: mockAuth.walletId,
    agentId: mockAuth.walletId,
    actorAddress: mockAuth.actorAddress,
    isAgent: mockAuth.isAgent,
  })),
}));

// the post is Commons speech behind a live window; the gate is unit-tested elsewhere.
jest.mock('../core/commons/speech-window', () => {
  const actual = jest.requireActual('../core/commons/speech-window') as Record<string, unknown>;
  return { ...actual, assertSpeechWindow: async () => ({ burnId: 'b'.repeat(64), burnAmountAtomic: 0n, audience: 'provian:commons' }) };
});

const postCalls: Array<{ walletId: string; actorAddress: unknown }> = [];
jest.mock('../core/commons/human-jobs', () => ({
  postHumanJob: async (
    _deps: unknown,
    walletId: string,
    _agentId: string,
    actorAddress: unknown,
  ) => {
    postCalls.push({ walletId, actorAddress });
    return {
      job_id: 'hjob_x', pe_id: 'pe_x', poster_wallet_id: walletId, poster_address: actorAddress,
      status: 'open', applicant_count: 0, posted_at: 1, title: 't', description: 'd', category: 'c',
      skills_required: [], compensation_type: 'fixed', budget_pvt: '1', compensation_currency: 'PVT',
    };
  },
}));

import { createCommonsRouter } from './commons';

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { handle: (req: unknown, res: unknown, next?: unknown) => unknown }[];
  };
}

function findHandler(router: Router, method: 'post', path: string) {
  const stack = (router as unknown as { stack: RouteLayer[] }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route?.methods?.[method]);
  if (!layer || !layer.route) throw new Error(`Handler not found for ${method.toUpperCase()} ${path}`);
  return layer.route.stack[0].handle;
}

function makeMockReqRes(body: Record<string, unknown>) {
  const captured: { status?: number; body?: unknown } = {};
  const req = { body, headers: {}, params: {}, query: {} } as unknown;
  const res = {
    status(code: number) { captured.status = code; return this; },
    json(payload: unknown) { captured.body = payload; return this; },
  } as unknown;
  return { req, res, captured };
}

const mockDeps = {
  db: { collection: () => ({ doc: () => ({ get: jest.fn(), set: jest.fn() }) }) },
  cache: { checkRateLimit: jest.fn() },
  peBuffer: { enqueue: jest.fn() },
  recordPEAccrual: jest.fn(),
} as unknown as Parameters<typeof createCommonsRouter>[0];

async function postJob(router: Router): Promise<{ status?: number }> {
  const handler = findHandler(router, 'post', '/jobs/post');
  const { req, res, captured } = makeMockReqRes({ title: 't', description: 'd', category: 'c' });
  await (handler as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return captured;
}

describe('routes/commons requireAuth never substitutes a wallet id for an actor address', () => {
  let router: Router;
  beforeEach(() => {
    router = createCommonsRouter(mockDeps);
    postCalls.length = 0;
  });

  it('RED: an agent session-token identity with no resolvable address posts with actorAddress === null (was its wallet_aw_ id)', async () => {
    mockAuth.walletId = 'wallet_aw_poster';
    mockAuth.isAgent = true;
    mockAuth.actorAddress = null;
    const captured = await postJob(router);
    expect(captured.status).toBe(201);
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0].actorAddress).toBeNull();
    expect(postCalls[0].actorAddress).not.toBe('wallet_aw_poster');
  });

  it('RED: a human session-token identity with no resolvable address posts with actorAddress === null (was its user id)', async () => {
    mockAuth.walletId = 'user_poster';
    mockAuth.isAgent = false;
    mockAuth.actorAddress = null;
    const captured = await postJob(router);
    expect(captured.status).toBe(201);
    expect(postCalls[0].actorAddress).toBeNull();
  });

  it('a resolved address passes through verbatim', async () => {
    mockAuth.walletId = 'wallet_aw_poster';
    mockAuth.isAgent = true;
    mockAuth.actorAddress = '0x1111111111111111111111111111111111111111';
    await postJob(router);
    expect(postCalls[0].actorAddress).toBe('0x1111111111111111111111111111111111111111');
  });
});
