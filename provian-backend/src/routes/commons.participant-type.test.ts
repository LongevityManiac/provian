/**
 * Wave 4 HIGH-9: /v1/commons/register derives participant_type from
 * the auth context. An agent's API key cannot post
 * {participant_type:'human'} and unlock biometric_enrolled identity.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { Router } from 'express';

const mockAuth: { isAgent: boolean } = { isAgent: false };

jest.mock('./middleware/commons-auth', () => ({
  getAuthenticatedWallet: jest.fn().mockImplementation(async () => ({
    walletId: 'wal_x',
    agentId: 'agent_x',
    actorAddress: '0x1111111111111111111111111111111111111111',
    isAgent: mockAuth.isAgent,
  })),
}));

const registerCalls: Array<Record<string, unknown>> = [];
jest.mock('../core/commons/profiles', () => ({
  registerForCommons: async (
    _deps: unknown,
    _wid: string,
    _aid: string,
    _addr: string,
    body: Record<string, unknown>,
  ) => {
    registerCalls.push(body);
    return {
      profile: {
        wallet_id: 'wal_x',
        participant_type: body.participant_type,
        display_name: body.display_name,
        status: 'active',
        attestation_tier: 'software',
      },
      registration_pe_id: 'pe_x',
    };
  },
  joinCommons: async () => ({ profile: {}, registration_pe_id: 'pe_y' }),
  updateProfile: async () => ({}),
  leaveCommons: async () => undefined,
  getProfile: async () => null,
  browseRegistry: async () => ({}),
  getPublishedPEs: async () => ({}),
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

describe('Wave 4 HIGH-9: /v1/commons/register derives participant_type', () => {
  let router: Router;
  beforeEach(() => {
    router = createCommonsRouter(mockDeps);
    registerCalls.length = 0;
  });

  it('rejects when body.participant_type contradicts derived value', async () => {
    mockAuth.isAgent = true; // agent API key
    const handler = findHandler(router, 'post', '/register');
    const { req, res, captured } = makeMockReqRes({
      display_name: 'Mallory',
      participant_type: 'human', // <- attacker tries to claim human identity
    });
    await (handler as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
    expect(captured.status).toBe(400);
    const body = captured.body as { error: string };
    expect(body.error).toBe('PARTICIPANT_TYPE_MISMATCH');
    expect(registerCalls).toHaveLength(0);
  });

  it('accepts when body.participant_type matches derived (agent → agent)', async () => {
    mockAuth.isAgent = true;
    const handler = findHandler(router, 'post', '/register');
    const { req, res, captured } = makeMockReqRes({
      display_name: 'Atlas',
      participant_type: 'agent',
    });
    await (handler as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
    expect(captured.status).toBe(201);
    expect(registerCalls).toHaveLength(1);
    expect(registerCalls[0].participant_type).toBe('agent');
  });

  it('accepts when body omits participant_type (derived from auth)', async () => {
    mockAuth.isAgent = false;
    const handler = findHandler(router, 'post', '/register');
    const { req, res, captured } = makeMockReqRes({ display_name: 'Alice' });
    await (handler as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
    expect(captured.status).toBe(201);
    expect(registerCalls).toHaveLength(1);
    expect(registerCalls[0].participant_type).toBe('human');
  });
});
