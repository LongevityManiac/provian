/**
 * F27 (S2 2026-09-10) — the free vouch path is retired.
 *
 *   - POST /v1/commons/vouch returns 410 Gone (no free vouch is written).
 *   - GET /v1/commons/agent/:walletId/vouches returns burn-vouches ONLY
 *     (commons_burn_vouches keyed by target_agent_id); free `commons_vouches`
 *     rows are never surfaced.
 *
 * RED controls: revert the route to call vouchForParticipant → the POST returns
 * 201; revert the GET to read commons_vouches → free rows appear in the list.
 */

import { Router } from 'express';
import { createCommonsRouter } from './commons';

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { handle: (req: unknown, res: unknown, next?: unknown) => unknown }[];
  };
}

function findHandler(router: Router, method: 'get' | 'post', path: string) {
  const stack = (router as unknown as { stack: RouteLayer[] }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route?.methods?.[method]);
  if (!layer || !layer.route) throw new Error(`Handler not found for ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function makeReqRes(params: Record<string, string> = {}, body: Record<string, unknown> = {}) {
  const captured: { status?: number; body?: unknown } = {};
  const req = { body, headers: {}, params, query: {} } as unknown;
  const res = {
    status(code: number) { captured.status = code; return this; },
    json(payload: unknown) { captured.body = payload; return this; },
  } as unknown;
  return { req, res, captured };
}

/** db mock: agent_wallets doc get + collection.where(...).get() for the two
 *  vouch collections. Free commons_vouches rows exist but must be ignored. */
function makeDeps() {
  const rowsByCollection: Record<string, Array<{ data: () => unknown }>> = {
    commons_burn_vouches: [
      { data: () => ({ vouch_id: 'vouch_burn_1', target_agent_id: 'atlas' }) },
    ],
    commons_vouches: [
      { data: () => ({ vouchee_wallet_id: 'wal_atlas', voucher_wallet_id: 'x' }) },
      { data: () => ({ vouchee_wallet_id: 'wal_atlas', voucher_wallet_id: 'y' }) },
    ],
  };
  const db = {
    collection: (name: string) => ({
      doc: (_id: string) => ({
        async get() {
          if (name === 'agent_wallets') {
            return { exists: true, data: () => ({ id: 'wal_atlas', agent_id: 'atlas' }) };
          }
          return { exists: false, data: () => undefined };
        },
      }),
      where(_f: string, _op: string, _v: unknown) {
        return {
          where() { return this; },
          orderBy() { return this; },
          async get() { return { docs: rowsByCollection[name] ?? [] }; },
        };
      },
    }),
  };
  return { db, cache: { checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }) } } as unknown as Parameters<typeof createCommonsRouter>[0];
}

describe('F27 — free vouch path retired', () => {
  let router: Router;
  beforeAll(() => { router = createCommonsRouter(makeDeps()); });

  it('POST /vouch returns 410 Gone (no free vouch written)', async () => {
    const handler = findHandler(router, 'post', '/vouch');
    const { req, res, captured } = makeReqRes({}, { vouchee_wallet_id: 'wal_atlas' });
    await (handler as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
    expect(captured.status).toBe(410);
    expect(JSON.stringify(captured.body)).toMatch(/vouch\/burn/);
  });

  it('GET /agent/:walletId/vouches returns burn-vouches only (free rows ignored)', async () => {
    const handler = findHandler(router, 'get', '/agent/:walletId/vouches');
    const { req, res, captured } = makeReqRes({ walletId: 'wal_atlas' });
    await (handler as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
    const body = captured.body as { vouches: Array<{ vouch_id?: string }> };
    expect(body.vouches).toHaveLength(1);
    expect(body.vouches[0].vouch_id).toBe('vouch_burn_1');
    // The two free commons_vouches rows must NOT appear.
    expect(JSON.stringify(body.vouches)).not.toContain('voucher_wallet_id');
  });
});
