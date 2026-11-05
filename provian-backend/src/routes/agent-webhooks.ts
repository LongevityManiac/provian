/**
 * Commons institutions - Webhook Subscription Routes
 *
 * Endpoints:
 *   POST   /subscribe          - Subscribe to webhook events
 *   GET    /subscriptions      - List active subscriptions
 *   DELETE /:subscription_id   - Delete a subscription
 */

import { Router, Request, Response } from 'express';
import { createAgentAuthMiddleware } from './middleware/agent-auth';
import type { AgentBankDeps } from '../core/agent-bank/types';
import {
  createWebhookSubscription,
  listWebhookSubscriptions,
  deleteWebhookSubscription,
} from '../core/agent-bank/webhooks';
import { ValidationError, NotFoundError, ForbiddenError } from '../core/agent-bank/escrow';

function handleError(res: Response, error: unknown): void {
  if (error instanceof ValidationError) {
    res.status(400).json({ error: error.message });
  } else if (error instanceof NotFoundError) {
    res.status(404).json({ error: error.message });
  } else if (error instanceof ForbiddenError) {
    res.status(403).json({ error: error.message });
  } else {
    console.error('[Webhooks] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export function createWebhookRouter(deps: AgentBankDeps): Router {
  const { db, cache } = deps;
  const router = Router();
  const authenticateAgent = createAgentAuthMiddleware(db);

  // POST /subscribe - Create webhook subscription
  router.post('/subscribe', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const wallet = req.agentWallet;
      if (!wallet) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const rateLimit = await cache.checkRateLimit(`rl:wh:sub:${wallet.id}`, 5, 60);
      if (!rateLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded', retry_after: rateLimit.retryAfter });
        return;
      }

      const result = await createWebhookSubscription(deps, wallet.id, wallet, req.body);
      res.status(201).json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  // GET /subscriptions - List subscriptions
  router.get('/subscriptions', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const wallet = req.agentWallet;
      if (!wallet) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const subs = await listWebhookSubscriptions(deps, wallet.id);
      res.json({ subscriptions: subs });
    } catch (error) {
      handleError(res, error);
    }
  });

  // DELETE /:subscription_id - Delete subscription
  router.delete('/:subscription_id', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const wallet = req.agentWallet;
      if (!wallet) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      await deleteWebhookSubscription(deps, wallet.id, req.params.subscription_id);
      res.json({ deleted: true });
    } catch (error) {
      handleError(res, error);
    }
  });

  return router;
}
