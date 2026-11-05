/**
 * Public agent NAME resolution (work package O8 forward lookup).
 *
 * GET /v1/names/:name - resolve a claimed name to its owning agent (public).
 *
 * Read-only. Claiming is burn-gated and lives on the agent-wallet router
 * (POST /v1/agent/wallet/:wallet_id/name/claim). DARK pre-flip: /v1/names is in
 * CLOSED_PRE_LAUNCH_PREFIXES, so this 404s until PUBLIC_LAUNCH.
 */

import { Router, type Request, type Response } from 'express';
import type { AgentBankDeps } from '../core/agent-bank/types';
import { resolveName } from '../core/commons/name-registry';

export function createNamesRouter(deps: AgentBankDeps): Router {
  const router = Router();

  router.get('/:name', async (req: Request, res: Response): Promise<void> => {
    try {
      const claim = await resolveName(deps, req.params.name);
      if (!claim) {
        res.status(404).json({ error: 'name not claimed' });
        return;
      }
      res.json({
        name: claim.name,
        name_normalized: claim.name_normalized,
        agent_id: claim.agent_id,
        wallet_id: claim.wallet_id,
        claimed_at: claim.claimed_at,
      });
    } catch (error) {
      console.error('[Names] resolve error:', error);
      res.status(500).json({ error: 'Failed to resolve name' });
    }
  });

  return router;
}
