/**
 * W3 follow-up: PVT-first field ordering on Commons profile responses.
 *
 * Verifies that POST /register, POST /join, and PUT /profile route their
 * profile output through serializeCommonsProfile() so that
 * `service_rate_pvt` always appears before `service_rate_usdc` in the JSON
 * key insertion order. Uses Object.keys(body).indexOf(...) for the
 * assertion (same pattern noted in the W3 follow-up brief).
 *
 * Strategy:
 * - Mock the auth middleware so requireAuth returns a fixed wallet.
 * - Mock registerForCommons / joinCommons / updateProfile so they return
 * a canned CommonsProfile carrying both rate fields in REVERSED order
 * (USDC first). If the route bypasses the serializer, the response
 * body will preserve the upstream ordering and the test fails.
 * - Pull the handler out of router.stack and invoke it with a minimal
 * req/res pair that captures res.json calls.
 */

import { Router } from 'express';
import type { CommonsProfile } from '../core/commons/types';

// Mock the shared auth middleware so requireAuth resolves to a fixed wallet.
jest.mock('./middleware/commons-auth', () => ({
  getAuthenticatedWallet: jest.fn().mockResolvedValue({
    walletId: 'wal_test',
    agentId: 'agent_test',
    actorAddress: '0x1111111111111111111111111111111111111111',
    // Wave-4 HIGH-9 derives participant_type from auth.isAgent;
    // this test posts a profile carrying agent service rates so the
    // mocked auth must report isAgent=true to match.
    isAgent: true,
  }),
}));

// Mock profile module. Each function returns a profile constructed in
// REVERSED key order - USDC field inserted before PVT - so the serializer
// is the only thing that can flip the order back to PVT-first.
jest.mock('../core/commons/profiles', () => {
  const reversedProfile: Record<string, unknown> = {
    wallet_id: 'wal_test',
    participant_type: 'agent',
    display_name: 'Test',
    attestation_tier: 'software',
    identity_verification_level: 'device_attested',
    // Reversed: USDC first.
    service_rate_usdc: 25,
    service_rate_pvt: '500000000000000000', // 0.5 PVT atomic units
    pe_count: 0,
    governance_score: 0,
    promise_fulfillment_rate: 1.0,
    court_record: {
      cases_as_plaintiff: 0,
      cases_as_defendant: 0,
      cases_as_arbitrator: 0,
      wins: 0,
      losses: 0,
      arbitrations_completed: 0,
      slashing_events: 0,
    },
    commons_join_date: 0,
    first_pe_date: 0,
    human_jobs_completed: 0,
    human_jobs_avg_rating: 0,
    human_jobs_categories: [],
    human_jobs_posted: 0,
    human_jobs_avg_human_rating: 0,
    forum_post_count: 0,
    forum_upvotes_received: 0,
    published_pe_count: 0,
    status: 'active',
    created_at: 0,
    updated_at: 0,
  };

  return {
    registerForCommons: jest.fn().mockResolvedValue({
      profile: reversedProfile as unknown as CommonsProfile,
      registration_pe_id: 'pe_register',
    }),
    joinCommons: jest.fn().mockResolvedValue({
      profile: reversedProfile as unknown as CommonsProfile,
      registration_pe_id: 'pe_join',
    }),
    updateProfile: jest.fn().mockResolvedValue(reversedProfile as unknown as CommonsProfile),
    leaveCommons: jest.fn(),
    getProfile: jest.fn(),
    browseRegistry: jest.fn(),
    getPublishedPEs: jest.fn(),
  };
});

// Import AFTER the mocks so the router picks up the mocked symbols.
import { createCommonsRouter } from './commons';

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { handle: (req: unknown, res: unknown, next?: unknown) => unknown }[];
  };
}

/**
 * Pull a specific (method, path) handler out of an Express Router's
 * internal layer stack. The mounted route handler is the LAST entry in
 * route.stack - preceding entries are middleware. Each Commons handler
 * mounts a single function, so route.stack[0] is the right one.
 */
function findHandler(router: Router, method: 'post' | 'put', path: string) {
  // Express Router internals: stack is private but stable across versions.
  const stack = (router as unknown as { stack: RouteLayer[] }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route?.methods?.[method]);
  if (!layer || !layer.route) {
    throw new Error(`Handler not found for ${method.toUpperCase()} ${path}`);
  }
  return layer.route.stack[0].handle;
}

function makeMockReqRes(body: Record<string, unknown> = {}) {
  const captured: { status?: number; body?: unknown } = {};
  const req = { body, headers: {}, params: {}, query: {} } as unknown;
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(payload: unknown) {
      captured.body = payload;
      return this;
    },
  } as unknown;
  return { req, res, captured };
}

const mockDeps = {
  db: { collection: () => ({ doc: () => ({ get: jest.fn(), set: jest.fn() }) }) },
  cache: { checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, retryAfter: 0 }) },
  peBuffer: { enqueue: jest.fn() },
  recordPEAccrual: jest.fn().mockResolvedValue(undefined),
} as unknown as Parameters<typeof createCommonsRouter>[0];

describe('Commons routes - PVT-first key ordering on profile responses', () => {
  let router: Router;

  beforeAll(() => {
    router = createCommonsRouter(mockDeps);
  });

  it('POST /register returns profile with service_rate_pvt before service_rate_usdc', async () => {
    const handler = findHandler(router, 'post', '/register');
    const { req, res, captured } = makeMockReqRes({
      display_name: 'Test',
      participant_type: 'agent',
    });

    await (handler as (req: unknown, res: unknown) => Promise<unknown>)(req, res);

    expect(captured.status).toBe(201);
    const body = captured.body as { profile: Record<string, unknown>; registration_pe_id: string };
    expect(body.registration_pe_id).toBe('pe_register');
    const keys = Object.keys(body.profile);
    const pvtIdx = keys.indexOf('service_rate_pvt');
    const usdcIdx = keys.indexOf('service_rate_usdc');
    expect(pvtIdx).toBeGreaterThanOrEqual(0);
    expect(usdcIdx).toBeGreaterThanOrEqual(0);
    expect(pvtIdx).toBeLessThan(usdcIdx);
  });

  it('POST /join returns profile with service_rate_pvt before service_rate_usdc', async () => {
    const handler = findHandler(router, 'post', '/join');
    const { req, res, captured } = makeMockReqRes({ display_name: 'Test' });

    await (handler as (req: unknown, res: unknown) => Promise<unknown>)(req, res);

    expect(captured.status).toBe(201);
    const body = captured.body as { profile: Record<string, unknown>; registration_pe_id: string };
    expect(body.registration_pe_id).toBe('pe_join');
    const keys = Object.keys(body.profile);
    expect(keys.indexOf('service_rate_pvt')).toBeLessThan(keys.indexOf('service_rate_usdc'));
  });

  it('PUT /profile returns profile with service_rate_pvt before service_rate_usdc', async () => {
    const handler = findHandler(router, 'put', '/profile');
    const { req, res, captured } = makeMockReqRes({ bio: 'updated' });

    await (handler as (req: unknown, res: unknown) => Promise<unknown>)(req, res);

    // PUT /profile uses res.json directly (no res.status), so captured.status
    // stays undefined. The serializer is what we care about.
    const body = captured.body as Record<string, unknown>;
    const keys = Object.keys(body);
    expect(keys.indexOf('service_rate_pvt')).toBeLessThan(keys.indexOf('service_rate_usdc'));
  });
});
