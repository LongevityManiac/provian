/**
 * REPLY POLICY ROUTES (, item 4) — the linked human sets how their agent
 * answers Commons mail (`core/commons/reply-policy.ts`).
 *
 * GET /v1/agent/wallet/:wallet_id/reply-policy the effective policy (linked human, wallet auth)
 * POST /v1/agent/wallet/:wallet_id/reply-policy { mode } (linked human, wallet auth)
 *
 * Authority is the human's request-bound v2 wallet-auth token, and the caller must be the agent's
 * `linked_human_user_id`. An agent API key or device key is not a wallet-auth token, so an agent can
 * never write — or read here — its own owner's choice; it learns it on its thread reads.
 */

import { Router, type Request, type Response } from 'express';
import type { AgentBankDeps } from '../core/agent-bank/types';
import { verifyWalletAuthToken } from './middleware/wallet-auth';
import { effectiveReplyPolicy, isReplyPolicyMode, REPLY_POLICY_MODES, storedReplyPolicy } from '../core/commons/reply-policy';

/** Changes per human per hour (fail CLOSED on a Redis outage, like every owner-state write). */
export const REPLY_POLICY_WRITES_PER_HOUR = 30;

type Guard =
  | { ok: true; userId: string; walletId: string; wallet: Record<string, unknown> }
  | { ok: false; status: number; error: string };

async function linkedHuman(deps: AgentBankDeps, req: Request): Promise<Guard> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return { ok: false, status: 401, error: 'Missing wallet auth token' };
  const auth = await verifyWalletAuthToken(authHeader.slice(7), req, { db: deps.db, cache: deps.cache });
  if (!auth.ok) return { ok: false, status: auth.status, error: auth.error };
  const walletId = String(req.params.wallet_id ?? '');
  const snap = walletId ? await deps.db.collection('agent_wallets').doc(walletId).get() : null;
  const wallet = snap?.exists ? (snap.data() ?? {}) : null;
  if (!wallet || wallet.id !== walletId || wallet.linked_human_user_id !== auth.userId) {
    return { ok: false, status: 403, error: 'not_your_linked_agent' };
  }
  return { ok: true, userId: auth.userId, walletId, wallet };
}

export function createAgentReplyPolicyRouter(deps: AgentBankDeps): Router {
  const router = Router();

  router.get('/:wallet_id/reply-policy', async (req: Request, res: Response) => {
    try {
      const g = await linkedHuman(deps, req);
      if (!g.ok) { res.status(g.status).json({ error: g.error }); return; }
      res.json({ wallet_id: g.walletId, ...effectiveReplyPolicy(g.wallet) });
    } catch (error) {
      console.error('[ReplyPolicy] read failed:', error);
      res.status(500).json({ error: 'Failed to read reply policy' });
    }
  });

  router.post('/:wallet_id/reply-policy', async (req: Request, res: Response) => {
    try {
      const g = await linkedHuman(deps, req);
      if (!g.ok) { res.status(g.status).json({ error: g.error }); return; }
      const mode = req.body?.mode;
      if (!isReplyPolicyMode(mode)) {
        res.status(400).json({ error: `mode must be one of ${REPLY_POLICY_MODES.join(', ')}` });
        return;
      }
      const rl = await deps.cache.checkRateLimitStrict(`rl:reply-policy:${g.userId}`, REPLY_POLICY_WRITES_PER_HOUR, 3600);
      if (!rl.allowed) { res.status(429).json({ error: 'Rate limit exceeded', retry_after: rl.retryAfter }); return; }
      const stored = storedReplyPolicy(mode, g.userId, Date.now());
      await deps.db.collection('agent_wallets').doc(g.walletId).update({ reply_policy: stored });
      res.json({ wallet_id: g.walletId, ...effectiveReplyPolicy({ ...g.wallet, reply_policy: stored }) });
    } catch (error) {
      console.error('[ReplyPolicy] write failed:', error);
      res.status(500).json({ error: 'Failed to set reply policy' });
    }
  });

  return router;
}
