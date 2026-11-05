/**
 * Agent Leaderboard Router - Public endpoints
 *
 * Endpoints:
 *   GET /leaderboard              - Public leaderboard (rate limited)
 *   GET /agent/profile/:agent_id  - Public agent profile (rate limited)
 */

import { Router, Request, Response } from 'express';
import { getLeaderboard, getAgentProfile } from '../core/agent-wallet/leaderboard';
import type { RouterDeps } from '../core/agent-wallet/types';
import { publicDiscoveryGate } from './middleware/public-launch-gate';

export function createAgentLeaderboardRouter(deps: RouterDeps): Router {
  const { db, cache } = deps;
  const router = Router();

  // Public discovery gate, applied PER ROUTE. `GET /v1/leaderboard` served 200
  // to an anonymous caller with PUBLIC_LAUNCH=false, and the payload carried
  // the agent's wallet id, agent id, on-chain address, and a `genesis_agent`
  // badge — which is how an unauthenticated visitor learned Genesis exists.
  //
  // NOT `router.use(...)`. This router is mounted at `app.use('/v1', ...)`, so
  // router-level middleware that answers 404 would swallow every `/v1/*`
  // request that falls through to it — including the ~150 routes server.ts
  // declares AFTER this mount (`/v1/meter/batch/mobile`, every
  // `/v1/internal/scheduler/*`). A gate must close ITS OWN routes and let
  // everything else fall through untouched.
  const gate = publicDiscoveryGate();

  // =========================================================================
  // GET /leaderboard - Public leaderboard
  // =========================================================================
  router.get('/leaderboard', gate, async (req: Request, res: Response) => {
    try {
      // Rate limit: 60/min per IP
      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
      const rateLimit = await cache.checkRateLimit(
        `rl:leaderboard:${clientIp}`, 60, 60,
      );
      if (!rateLimit.allowed) {
        res.status(429).json({
          error: 'Rate limit exceeded',
          retry_after: rateLimit.retryAfter,
        });
        return;
      }

      const leaderboard = await getLeaderboard(db, cache);
      res.json(leaderboard);

    } catch (error) {
      console.error('[Leaderboard] Error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =========================================================================
  // GET /agent/profile/:agent_id - Public agent profile
  // =========================================================================
  router.get('/agent/profile/:agent_id', gate, async (req: Request, res: Response) => {
    try {
      const { agent_id } = req.params;

      // Rate limit: 60/min per IP
      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
      const rateLimit = await cache.checkRateLimit(
        `rl:agent-profile:${clientIp}`, 60, 60,
      );
      if (!rateLimit.allowed) {
        res.status(429).json({
          error: 'Rate limit exceeded',
          retry_after: rateLimit.retryAfter,
        });
        return;
      }

      if (!agent_id || typeof agent_id !== 'string') {
        res.status(400).json({ error: 'agent_id is required' });
        return;
      }

      const profile = await getAgentProfile(db, cache, agent_id);
      if (!profile) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }

      res.json(profile);

    } catch (error) {
      console.error('[AgentProfile] Error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
