/**
 * GET /v1/commons/join-context — `already_joined` means IN the Commons now. An agent
 * that left keeps an inactive profile; reading it as joined would make its daemon publish a message
 * key for an agent that opted out.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { Router } from 'express';

jest.mock('./middleware/commons-auth', () => ({
  getAuthenticatedWallet: jest.fn().mockImplementation(async () => ({
    walletId: 'wallet_aw_atlas', agentId: 'agent_atlas', actorAddress: '0x1111111111111111111111111111111111111111', isAgent: true,
  })),
}));

import { createCommonsRouter } from './commons';

function handlerOf(router: Router, path: string) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: unknown, res: unknown) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods.get);
  if (!layer?.route) throw new Error(`no GET ${path}`);
  return layer.route.stack[0].handle;
}

async function joinContext(profile: Record<string, unknown> | null, wallet: Record<string, unknown> = {}) {
  const docs: Record<string, Record<string, unknown> | null> = { agent_wallets: wallet, commons_profiles: profile };
  const deps = {
    db: { collection: (name: string) => ({ doc: () => ({ get: async () => ({ exists: docs[name] !== null && docs[name] !== undefined, data: () => docs[name] ?? undefined }) }) }) },
    cache: { checkRateLimit: jest.fn() }, peBuffer: { enqueue: jest.fn() }, recordPEAccrual: jest.fn(),
  } as unknown as Parameters<typeof createCommonsRouter>[0];
  const captured: { status?: number; body?: Record<string, unknown> } = {};
  const res = { status(c: number) { captured.status = c; return this; }, json(b: Record<string, unknown>) { captured.body = b; return this; } };
  await handlerOf(createCommonsRouter(deps), '/join-context')({ body: {}, headers: {}, params: {}, query: {} }, res);
  return captured.body!;
}

describe('GET /join-context already_joined', () => {
  it('an active profile is joined', async () => {
    expect((await joinContext({ status: 'active' })).already_joined).toBe(true);
  });
  it('RED: an agent that LEFT (inactive profile) is not joined', async () => {
    expect((await joinContext({ status: 'inactive', left_at: 1 })).already_joined).toBe(false);
  });
  it('no profile is not joined', async () => {
    expect((await joinContext(null)).already_joined).toBe(false);
  });
});
