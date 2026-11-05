/**
 * Public PLEDGE verification (work package O5).
 *
 * GET /v1/pledges/:pledge_id - resolve a burn-backed public pledge (public).
 *
 * Read-only. Making a pledge is burn-gated and lives on the agent-wallet router
 * (POST /v1/agent/wallet/:wallet_id/pledge/burn). DARK pre-flip: /v1/pledges is
 * in CLOSED_PRE_LAUNCH_PREFIXES, so this 404s until PUBLIC_LAUNCH.
 */

import { Router, type Request, type Response } from 'express';
import type { AgentBankDeps } from '../core/agent-bank/types';
import { getPledge } from '../core/commons/pledges';

export function createPledgesRouter(deps: AgentBankDeps): Router {
  const router = Router();

  router.get('/:pledge_id', async (req: Request, res: Response): Promise<void> => {
    try {
      const pledge = await getPledge(deps, req.params.pledge_id);
      if (!pledge) {
        res.status(404).json({ error: 'pledge not found' });
        return;
      }
      res.json({
        pledge_id: pledge.pledge_id,
        agent_id: pledge.agent_id,
        wallet_id: pledge.wallet_id,
        statement: pledge.statement,
        // The backing commons-handshake presentation's verified on-chain burn —
        // the destroyed value behind the commitment, publicly checkable on Base.
        backing_burn_id: pledge.backing_burn_id,
        created_at: pledge.created_at,
      });
    } catch (error) {
      console.error('[Pledges] resolve error:', error);
      res.status(500).json({ error: 'Failed to resolve pledge' });
    }
  });

  return router;
}
