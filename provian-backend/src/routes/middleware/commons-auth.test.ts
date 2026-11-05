/**
 * getAuthenticatedWallet — identity resolution across the three Commons auth
 * contexts.
 *
 * Regression guard for the human-wallet 401: the `authenticate` middleware
 * (server.ts) stamps `req.user = { id, device_id }`, but this helper used to
 * read only `req.walletAuth` — a declared Request field NOTHING in the backend
 * assigns. So every human Commons call (join, join-context, forum, vouch,
 * publish) fell through to a null return and 401'd, while agent calls
 * (req.agentWallet) worked. The Commons tab was the first surface to exercise
 * the human path in production.
 *
 * The first test is the RED negative control: before the fix it returned null
 * for a req that carries only `req.user`, so `walletId === 'user_123'` failed.
 */
import { describe, it, expect, jest } from '@jest/globals';
import type { Request } from 'express';
import { getAuthenticatedWallet } from './commons-auth';
import type { AgentBankDeps } from '../../core/agent-bank/types';

const sessionWallet: { id: string | null } = { id: null };
jest.mock('../../core/commons/auth', () => ({
  validateSessionToken: async () => sessionWallet.id,
}));

// resolveActorAddress queries the `wallets` collection; return empty so the
// address resolves to null (irrelevant to the identity assertions here).
const deps = {
  db: {
    collection: () => ({
      where: () => ({
        limit: () => ({
          get: async () => ({ empty: true, docs: [] }),
        }),
      }),
    }),
  },
} as unknown as AgentBankDeps;

describe('getAuthenticatedWallet', () => {
  it('resolves the human wallet from req.user (RED before the fix)', async () => {
    const req = { user: { id: 'user_123', device_id: 'dev_1' }, headers: {} } as unknown as Request;
    const auth = await getAuthenticatedWallet(req, deps);
    expect(auth).not.toBeNull();
    expect(auth?.walletId).toBe('user_123');
    expect(auth?.agentId).toBe('user_123');
    expect(auth?.isAgent).toBe(false);
  });

  it('still resolves an agent wallet from req.agentWallet (unchanged)', async () => {
    const req = {
      agentWallet: { id: 'wallet_aw_1', agent_id: 'atlas', address: '0xabc' },
      headers: {},
    } as unknown as Request;
    const auth = await getAuthenticatedWallet(req, deps);
    expect(auth?.walletId).toBe('wallet_aw_1');
    expect(auth?.isAgent).toBe(true);
  });

  it('honors the legacy req.walletAuth shape as a fallback', async () => {
    const req = { walletAuth: { user_id: 'user_legacy' }, headers: {} } as unknown as Request;
    const auth = await getAuthenticatedWallet(req, deps);
    expect(auth?.walletId).toBe('user_legacy');
    expect(auth?.isAgent).toBe(false);
  });

  it('returns null when no auth identity is present (no false positive)', async () => {
    const req = { headers: {} } as unknown as Request;
    const auth = await getAuthenticatedWallet(req, deps);
    expect(auth).toBeNull();
  });
});

/**
 * the Commons SESSION-TOKEN branch
 * resolved every identity through `wallets.user_id`, which an agent's
 * `wallet_aw_…` id never matches, so an agent signed in over QR/web always got
 * `actorAddress: null` and the router then substituted its wallet id. The
 * branch now resolves an agent through its own `agent_wallets` document and
 * returns ONLY a well-formed EVM address or null: never a synthetic string.
 */
describe('getAuthenticatedWallet — session-token branch resolves a REAL address or null', () => {
  const AGENT_ADDR = '0x2222222222222222222222222222222222222222';
  function depsWith(store: Record<string, Record<string, unknown> | undefined>, wallets: Array<Record<string, unknown>> = []): AgentBankDeps {
    return {
      db: {
        collection: (name: string) => ({
          doc: (id: string) => ({
            get: async () => {
              const data = store[`${name}/${id}`];
              return { exists: data !== undefined, data: () => data };
            },
          }),
          where: () => ({
            limit: () => ({
              get: async () => ({ empty: wallets.length === 0, docs: wallets.map((w) => ({ data: () => w })) }),
            }),
          }),
        }),
      },
    } as unknown as AgentBankDeps;
  }
  const sessionReq = { headers: { authorization: 'Bearer tok' } } as unknown as Request;

  it('RED: an agent session token resolves its address from agent_wallets (was null → router fell back to the wallet id)', async () => {
    sessionWallet.id = 'wallet_aw_1';
    const auth = await getAuthenticatedWallet(sessionReq, depsWith({ 'agent_wallets/wallet_aw_1': { address: AGENT_ADDR } }));
    expect(auth?.walletId).toBe('wallet_aw_1');
    expect(auth?.isAgent).toBe(true);
    expect(auth?.actorAddress).toBe(AGENT_ADDR);
  });

  it('an agent session token with no agent_wallets document resolves null, never the wallet id', async () => {
    sessionWallet.id = 'wallet_aw_orphan';
    const auth = await getAuthenticatedWallet(sessionReq, depsWith({}));
    expect(auth?.actorAddress).toBeNull();
  });

  it('a stored address that is not a well-formed EVM address resolves null (never a synthetic string), on both branches', async () => {
    sessionWallet.id = 'wallet_aw_bad';
    const agent = await getAuthenticatedWallet(sessionReq, depsWith({ 'agent_wallets/wallet_aw_bad': { address: 'wallet_aw_bad' } }));
    expect(agent?.actorAddress).toBeNull();
    sessionWallet.id = 'user_bad';
    const human = await getAuthenticatedWallet(sessionReq, depsWith({}, [{ address: 'user_bad' }]));
    expect(human?.isAgent).toBe(false);
    expect(human?.actorAddress).toBeNull();
  });

  it('a human session token still resolves through wallets.user_id', async () => {
    sessionWallet.id = 'user_1';
    const auth = await getAuthenticatedWallet(sessionReq, depsWith({}, [{ address: AGENT_ADDR }]));
    expect(auth?.isAgent).toBe(false);
    expect(auth?.actorAddress).toBe(AGENT_ADDR);
  });
});
