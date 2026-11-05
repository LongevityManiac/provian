/**
 * Wants Board + want→fulfiller Match Routes (work package orphan O7 — the demand loop).
 *
 * POST /v1/wants - post a want (Commons speech: needs a live presentation
 * window to provian:commons; the `want_posted` PE MINTS)
 * GET /v1/wants - browse (public at the flip; filter by status/capability)
 * GET /v1/wants/featured - the board's ranked featured slots (burn auction)
 * GET /v1/wants/:want_id - single want
 * GET /v1/wants/:want_id/matches - THE want→fulfiller match (public discovery)
 * POST /v1/wants/:want_id/feature - bid a burn for featured placement (poster only)
 * POST /v1/wants/:want_id/fulfill - record a verified want→job link (poster only)
 * POST /v1/wants/:want_id/cancel - cancel (poster only)
 *
 * a presentation opens a voice (one presentation window per 7 days, folded, never stacked), every
 * act mints (`want_posted` at its evidence-class base, budget-bounded by the window), and a
 * featured slot is its own burn on the global single-use ledger. A want holds no custody. Auth:
 * writes require any authenticated wallet (human or agent); reads are public at the flip.
 */

import { OutputSignatureUnverifiableError } from '../core/commons/attached-output-signature';
import { Router, type Request, type Response } from 'express';
import { requireAuth } from './middleware/commons-auth';
import type { AgentBankDeps } from '../core/agent-bank/types';
import { ValidationError, NotFoundError, ForbiddenError } from '../core/agent-bank/errors';
import { RailHandshakeError } from '../core/rail/handshake';
import { assertSpeechWindow, SPEECH_AUDIENCE, SpeechWindowRequiredError } from '../core/commons/speech-window';
import {
  postWant,
  browseWants,
  getWant,
  matchWant,
  fulfillWant,
  cancelWant,
  featureWant,
  featuredWants,
  type WantStatus,
  type WantPosterIdentity,
} from '../core/commons/wants';

const WANT_STATUSES: ReadonlySet<WantStatus> = new Set<WantStatus>([
  'open', 'matched', 'fulfilled', 'cancelled', 'expired',
]);

function clientIpOf(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/** Map a thrown core error message to an HTTP status. */
function handleError(res: Response, error: unknown): void {
  if (error instanceof SpeechWindowRequiredError) {
    res.status(error.status).json({ error: error.message, reason: error.reason, present_to: error.presentTo });
    return;
  }
  if (error instanceof RailHandshakeError) {
    res.status(error.status).json({ error: error.message, reason: error.reason });
    return;
  }
  if (error instanceof OutputSignatureUnverifiableError) { res.status(error.status).json({ error: error.message }); return; }
  if (error instanceof ValidationError) { res.status(400).json({ error: error.message }); return; }
  if (error instanceof NotFoundError) { res.status(404).json({ error: error.message }); return; }
  if (error instanceof ForbiddenError) { res.status(403).json({ error: error.message }); return; }
  const message = error instanceof Error ? error.message : String(error);
  if (message.endsWith('_not_found')) {
    res.status(404).json({ error: message });
    return;
  }
  if (
    message === 'want_not_owned'
    || message === 'linked_job_not_owned'
    || message === 'cannot_fulfill_own_want'
  ) {
    res.status(403).json({ error: message });
    return;
  }
  if (
    message === 'want_not_open'
    || message === 'want_already_fulfilled'
    || message === 'want_already_cancelled'
  ) {
    res.status(409).json({ error: message });
    return;
  }
  if (
    message.endsWith('_required')
    || message.endsWith('_invalid')
    || message.endsWith('_too_long')
    || message.endsWith('_too_many')
    || message === 'expiry_in_past'
  ) {
    res.status(400).json({ error: message });
    return;
  }
  console.error('[Wants] Error:', error);
  res.status(500).json({ error: 'Internal server error' });
}

function posterOf(auth: { walletId: string; agentId: string; actorAddress: string | null; isAgent: boolean }): WantPosterIdentity {
  return { walletId: auth.walletId, isAgent: auth.isAgent, agentId: auth.agentId, actorAddress: auth.actorAddress };
}

export function createWantsRouter(deps: AgentBankDeps): Router {
  const { cache } = deps;
  const router = Router();

  // POST /wants — Commons speech behind the poster's live presentation window
  router.post('/', async (req: Request, res: Response): Promise<void> => {
    try {
      const auth = await requireAuth(req, res, deps);
      if (!auth) return;
      const window = await assertSpeechWindow(deps.db, auth, SPEECH_AUDIENCE, Date.now());

      const walletLimit = await cache.checkRateLimit(`rl:want-post:wallet:${auth.walletId}`, 10, 60);
      if (!walletLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded', retry_after: walletLimit.retryAfter });
        return;
      }
      const ipLimit = await cache.checkRateLimit(`rl:want-post:ip:${clientIpOf(req)}`, 30, 60);
      if (!ipLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded', retry_after: ipLimit.retryAfter });
        return;
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const view = await postWant(deps, posterOf(auth), {
        outcome: typeof body.outcome === 'string' ? body.outcome : '',
        capabilities: Array.isArray(body.capabilities) ? body.capabilities : [],
        budgetMaxPvt: (typeof body.budget_max_pvt === 'string' ? body.budget_max_pvt : null),
        budgetMaxUsdc: (typeof body.budget_max_usdc === 'number' ? body.budget_max_usdc : null),
        preferredChains: Array.isArray(body.preferred_chains) ? (body.preferred_chains as unknown[]).filter((c): c is string => typeof c === 'string') : undefined,
        expiry: (typeof body.expiry === 'number' ? body.expiry : null),
        outputSignature: body.provian_output_signature,
      }, window);
      res.status(201).json(view);
    } catch (error) {
      handleError(res, error);
    }
  });

  // GET /wants — public browse
  router.get('/', async (req: Request, res: Response): Promise<void> => {
    try {
      const ipLimit = await cache.checkRateLimit(`rl:want-browse:ip:${clientIpOf(req)}`, 60, 60);
      if (!ipLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded', retry_after: ipLimit.retryAfter });
        return;
      }
      const statusRaw = typeof req.query.status === 'string' ? req.query.status : undefined;
      if (statusRaw && !WANT_STATUSES.has(statusRaw as WantStatus)) {
        res.status(400).json({ error: 'invalid status filter' });
        return;
      }
      const limitRaw = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined;
      const page = await browseWants(deps, {
        status: statusRaw as WantStatus | undefined,
        capability: typeof req.query.capability === 'string' ? req.query.capability : undefined,
        limit: limitRaw !== undefined && Number.isFinite(limitRaw) ? limitRaw : undefined,
        cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
      });
      res.json({ wants: page.items, count: page.items.length, next_cursor: page.nextCursor });
    } catch (error) {
      if (error instanceof Error && error.message === 'want_cursor_invalid') {
        res.status(400).json({ error: 'invalid pagination cursor' });
        return;
      }
      handleError(res, error);
    }
  });

  // GET /wants/featured — the ranked featured slots (burn auction)
  router.get('/featured', async (req: Request, res: Response): Promise<void> => {
    try {
      const ipLimit = await cache.checkRateLimit(`rl:want-featured:ip:${clientIpOf(req)}`, 60, 60);
      if (!ipLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded', retry_after: ipLimit.retryAfter });
        return;
      }
      res.json({ featured: await featuredWants(deps) });
    } catch (error) {
      handleError(res, error);
    }
  });

  // POST /wants/:want_id/feature — bid a verified burn for featured placement (poster only)
  router.post('/:want_id/feature', async (req: Request, res: Response): Promise<void> => {
    try {
      const auth = await requireAuth(req, res, deps);
      if (!auth) return;
      const walletLimit = await cache.checkRateLimit(`rl:want-feature:wallet:${auth.walletId}`, 15, 60);
      if (!walletLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded', retry_after: walletLimit.retryAfter });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const placement = await featureWant(deps, req.params.want_id ?? '', posterOf(auth), body.burn_id);
      res.status(201).json(placement);
    } catch (error) {
      handleError(res, error);
    }
  });

  // GET /wants/:want_id — single want
  router.get('/:want_id', async (req: Request, res: Response): Promise<void> => {
    try {
      const ipLimit = await cache.checkRateLimit(`rl:want-get:ip:${clientIpOf(req)}`, 60, 60);
      if (!ipLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded', retry_after: ipLimit.retryAfter });
        return;
      }
      const view = await getWant(deps, req.params.want_id ?? '');
      res.json(view);
    } catch (error) {
      handleError(res, error);
    }
  });

  // GET /wants/:want_id/matches — the want→fulfiller match (public discovery)
  router.get('/:want_id/matches', async (req: Request, res: Response): Promise<void> => {
    try {
      const ipLimit = await cache.checkRateLimit(`rl:want-match:ip:${clientIpOf(req)}`, 60, 60);
      if (!ipLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded', retry_after: ipLimit.retryAfter });
        return;
      }
      const limitRaw = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined;
      const result = await matchWant(deps, req.params.want_id ?? '', {
        limit: limitRaw !== undefined && Number.isFinite(limitRaw) ? limitRaw : undefined,
      });
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  // POST /wants/:want_id/fulfill — record a verified want→job link
  router.post('/:want_id/fulfill', async (req: Request, res: Response): Promise<void> => {
    try {
      const auth = await requireAuth(req, res, deps);
      if (!auth) return;
      const walletLimit = await cache.checkRateLimit(`rl:want-fulfill:wallet:${auth.walletId}`, 15, 60);
      if (!walletLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded', retry_after: walletLimit.retryAfter });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const view = await fulfillWant(deps, req.params.want_id ?? '', posterOf(auth), {
        fulfillerWalletId: typeof body.fulfiller_wallet_id === 'string' ? body.fulfiller_wallet_id : '',
        linkedJobId: typeof body.linked_job_id === 'string' ? body.linked_job_id : '',
      });
      res.json(view);
    } catch (error) {
      handleError(res, error);
    }
  });

  // POST /wants/:want_id/cancel — cancel (poster only)
  router.post('/:want_id/cancel', async (req: Request, res: Response): Promise<void> => {
    try {
      const auth = await requireAuth(req, res, deps);
      if (!auth) return;
      const walletLimit = await cache.checkRateLimit(`rl:want-cancel:wallet:${auth.walletId}`, 15, 60);
      if (!walletLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded', retry_after: walletLimit.retryAfter });
        return;
      }
      const view = await cancelWant(deps, req.params.want_id ?? '', posterOf(auth));
      res.json(view);
    } catch (error) {
      handleError(res, error);
    }
  });

  return router;
}
