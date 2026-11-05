/**
 * Public earning-type projection READ routes.
 *
 * GET /v1/pe/earning-proposals - the full projection (queue + rulings + served matrix)
 * GET /v1/pe/earning-proposals/:action_type - one type's status
 *
 * there is NO write form. The submitted envelope is the only submission a
 * contributor makes (an unknown type is sealed record_only and enters the
 * operator queue on first sight). These reads join the pending-policy queue, the
 * operator rulings sidecar, and the SERVED matrix; "live" is computed from the
 * served code + a matched activation digest, never from `pvt_action_policies`, so
 * there is no "accepted" state (decision 8). Behind the pre-launch surface gate
 * (decision 5): closed pre-flip, opens with everything else.
 */

import { Router, type Request, type Response } from 'express';
import type { AgentBankDeps } from '../core/agent-bank/types';
import {
  projectEarningType,
  projectEarningTypes,
} from '../core/pvt/policy/earning-type-projection';

function clientIpOf(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

export function createEarningProposalRouter(deps: AgentBankDeps): Router {
  const { cache, db } = deps;
  const router = Router();

  router.get('/earning-proposals', async (req: Request, res: Response): Promise<void> => {
    try {
      const ipLimit = await cache.checkRateLimit(`rl:earning-browse:ip:${clientIpOf(req)}`, 60, 60);
      if (!ipLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded', retry_after: ipLimit.retryAfter });
        return;
      }
      const statusRaw = typeof req.query.status === 'string' ? req.query.status : undefined;
      const projection = await projectEarningTypes(db);
      const types = statusRaw
        ? projection.types.filter((t) => t.status === statusRaw)
        : projection.types;
      res.json({ ...projection, types, count: types.length });
    } catch (error) {
      console.error('[EarningProposals] projection failed:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/earning-proposals/:action_type', async (req: Request, res: Response): Promise<void> => {
    try {
      const ipLimit = await cache.checkRateLimit(`rl:earning-get:ip:${clientIpOf(req)}`, 60, 60);
      if (!ipLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded', retry_after: ipLimit.retryAfter });
        return;
      }
      const actionType = req.params.action_type ?? '';
      const view = await projectEarningType(db, actionType);
      if (!view) {
        res.status(404).json({ error: 'action type not seen', action_type: actionType });
        return;
      }
      res.json(view);
    } catch (error) {
      console.error('[EarningProposals] single projection failed:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
