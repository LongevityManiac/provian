/**
 * Standing lookup (work package O9), REMEDIATED — burn-to-present.
 *
 * GET /v1/standing/:id - non-sensitive metadata about a produced reputation
 * presentation. This is NOT a presentation and returns
 * NO scores: a raw id lookup that returns a bearer
 * snapshot is exactly the replayable defect this build
 * removes. A counterparty must be handed a requester-
 * bound presentation and verify it at POST /v1/present/verify.
 *
 * F6: this row is PRIVATE. The document id is the burn_id = sha256(`${chain}:${txHash}`),
 * and every PVT9 burn Transfer(->0x0) is public on Base, so the key space is
 * enumerable — an unauthenticated crawler could reconstruct the whole presentation
 * interaction graph (who presented to whom, and when: presenter wallet_id,
 * presenter_address, audience — humans included). the invariant: is absolute:
 * individual presentations, contents, timing, requester identity, the interaction
 * graph, and handshake records NEVER surface. So this route now REQUIRES auth and
 * returns the row ONLY to the presenter wallet or the named audience; everyone
 * else gets 404 (existence is not confirmed).
 *
 * Read-only. Producing a standing is a reputation-tier presentation on the
 * burn-to-present primitive (POST /v1/agent/wallet/:wallet_id/present tier=reputation,
 * or POST /v1/wallet/present for a human).
 */

import { Router, type Request, type Response } from 'express';
import type { AgentBankDeps } from '../core/agent-bank/types';
import { getStandingPresentationMeta } from '../core/commons/standing-export';
import { createPVTDualAuthMiddleware } from './middleware/pvt-dual-auth';
import { resolveHumanWallet } from '../core/presentation/principal';

export function createStandingRouter(deps: AgentBankDeps): Router {
  const router = Router();

  // Dual auth (agent API key OR wallet HMAC). Sets req.pvtAuth = { type, userId }.
  const authenticateStanding = createPVTDualAuthMiddleware({ db: deps.db, cache: deps.cache });

  router.get('/:export_id', authenticateStanding, async (req: Request, res: Response): Promise<void> => {
    try {
      const meta = await getStandingPresentationMeta(deps, req.params.export_id);
      if (!meta) {
        res.status(404).json({ error: 'standing presentation not found' });
        return;
      }

      // Resolve the caller's authorized identity strings. The presenter of an
      // AGENT presentation is the agent wallet id (== pvtAuth.userId under agent
      // auth); the presenter of a HUMAN presentation is that human's first-party
      // wallets-doc id (resolved from the authenticated user id).
      const auth = req.pvtAuth;
      const callerIds = new Set<string>();
      if (auth?.type === 'agent') {
        callerIds.add(auth.userId);
      } else if (auth?.type === 'wallet') {
        const resolved = await resolveHumanWallet(deps.db, auth.userId);
        if (resolved.ok) callerIds.add(resolved.walletId);
      }

      const isPresenter = meta.wallet_id.length > 0 && callerIds.has(meta.wallet_id);
      const isAudience = meta.audience.length > 0 && callerIds.has(meta.audience);
      if (!isPresenter && !isAudience) {
        // Do NOT confirm existence to a non-party (F6): 404, never 403.
        res.status(404).json({ error: 'standing presentation not found' });
        return;
      }

      // METADATA ONLY — never the scores. The scores are disclosed exclusively
      // inside a signed, requester-bound presentation the presenter hands to a
      // chosen counterparty, verified at /v1/present/verify. Returned only to the
      // presenter or the named audience, both of whom already know these fields.
      res.json({
        presentation_id: meta.presentation_id,
        tier: meta.tier,
        wallet_id: meta.wallet_id,
        presenter_address: meta.presenter_address,
        audience: meta.audience,
        issued_at: meta.issued_at,
        expires_at: meta.expires_at,
        verifiable_by_id: false,
        note: 'A standing is a requester-bound presentation, not a bearer snapshot. '
          + 'Obtain a presentation from the presenter and verify it at POST /v1/present/verify.',
      });
    } catch (error) {
      console.error('[Standing] resolve error:', error);
      res.status(500).json({ error: 'Failed to resolve standing' });
    }
  });

  return router;
}
