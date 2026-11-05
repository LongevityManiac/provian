/**
 * Commons institutions - Job Board Routes (FOLDED into the Commons hiring board —)
 *
 * hiring runs in all four directions (agent→agent, agent→person,
 * person→person, person→agent) on ONE board — the Commons jobs board, `/v1/commons/jobs`, which
 * both people (wallet auth) and agents (API key) act on. This agent-only board is closed to
 * NEW work: posting, browsing, applying, accepting and featuring answer 410 `job_board_moved`
 * with the Commons path to use. The two legs an IN-FLIGHT legacy job still needs stay open so
 * nothing already assigned is stranded:
 * POST /:id/deliver - Mark an assigned legacy job as delivered
 * GET /my-jobs - Get posted + assigned legacy jobs
 * (Payment on a legacy job settles through its escrow: `/v1/escrow/:id/complete`.)
 */

import { Router, Request, Response } from 'express';
import { createAgentAuthMiddleware } from './middleware/agent-auth';
import type { AgentBankDeps, JobApplication, JobDocument } from '../core/agent-bank/types';

/** where each retired agent-board verb now lives on the Commons hiring board. */
export const JOB_BOARD_MOVED: Readonly<Record<string, string>> = {
  post: 'POST /v1/commons/jobs/post (seeking: "agent" | "human")',
  available: 'GET /v1/commons/jobs?seeking=agent (or GET /v1/commons/market/jobs)',
  apply: 'POST /v1/commons/jobs/:jobId/apply',
  accept: 'POST /v1/commons/jobs/:jobId/accept { applicant_wallet_id }',
  feature: 'POST /v1/commons/jobs/:jobId/feature { burn_id }',
};

function boardMoved(res: Response, verb: keyof typeof JOB_BOARD_MOVED & string): void {
  res.status(410).json({
    error: 'The agent-only job board folded into the Commons hiring board. People and agents hire each other there, in all four directions.',
    code: 'job_board_moved',
    use: JOB_BOARD_MOVED[verb],
  });
}
import { deliverJob, getMyJobs } from '../core/agent-bank/jobs';
import { ValidationError, NotFoundError, ForbiddenError } from '../core/agent-bank/escrow';
import { enqueueAgentBankEvent, twoPartyTargeting } from '../core/agent-bank/event-outbox';
import { makeAgentProvenanceUrl } from '../provenance-links';
import { RailHandshakeError } from '../core/rail/handshake';
import { SpeechWindowRequiredError } from '../core/commons/speech-window';
import { ValidationError as BankValidationError, NotFoundError as BankNotFoundError, ForbiddenError as BankForbiddenError } from '../core/agent-bank/errors';

function handleError(res: Response, error: unknown): void {
  if (error instanceof SpeechWindowRequiredError) {
    res.status(error.status).json({ error: error.message, reason: error.reason, present_to: error.presentTo });
  } else if (error instanceof RailHandshakeError) {
    res.status(error.status).json({ error: error.message, reason: error.reason });
  } else if (error instanceof ValidationError || error instanceof BankValidationError) {
    res.status(400).json({ error: error.message });
  } else if (error instanceof NotFoundError || error instanceof BankNotFoundError) {
    res.status(404).json({ error: error.message });
  } else if (error instanceof ForbiddenError || error instanceof BankForbiddenError) {
    res.status(403).json({ error: error.message });
  } else {
    console.error('[Jobs] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

function serializeJobApplication(application: JobApplication): Record<string, unknown> {
  return {
    ...application,
    applicant_provenance_url: makeAgentProvenanceUrl(application.wallet_id),
  };
}

function serializeJob(job: JobDocument): Record<string, unknown> {
  return {
    ...job,
    poster_provenance_url: makeAgentProvenanceUrl(job.poster_wallet_id),
    assigned_provenance_url: job.assigned_wallet_id
      ? makeAgentProvenanceUrl(job.assigned_wallet_id)
      : undefined,
    applications: job.applications.map(serializeJobApplication),
  };
}

export function createAgentJobsRouter(deps: AgentBankDeps): Router {
  const { db, cache } = deps;
  const router = Router();
  const authenticateAgent = createAgentAuthMiddleware(db);

  // the new-work verbs moved to the Commons hiring board. Auth still runs first so an
  // unauthenticated probe learns nothing it could not learn from the public docs.
  router.post('/post', authenticateAgent, (_req: Request, res: Response) => boardMoved(res, 'post'));
  router.get('/available', authenticateAgent, (_req: Request, res: Response) => boardMoved(res, 'available'));
  router.post('/:id/apply', authenticateAgent, (_req: Request, res: Response) => boardMoved(res, 'apply'));
  router.post('/:id/accept/:wallet_id', authenticateAgent, (_req: Request, res: Response) => boardMoved(res, 'accept'));
  router.post('/:id/feature', authenticateAgent, (_req: Request, res: Response) => boardMoved(res, 'feature'));

  // POST /:id/deliver - Mark job as delivered
  router.post('/:id/deliver', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const wallet = req.agentWallet;
      if (!wallet) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const job = await deliverJob(deps, req.params.id, wallet.id, wallet, {
        deliverable_uri: req.body?.deliverable_uri,
        deliverable_body: req.body?.deliverable_body,
      });

      // notify the POSTER (counterparty) that delivery landed so they can
      // confirm/settle without polling. Deliverer is the actor.
      await enqueueAgentBankEvent(deps.db, {
        walletId: wallet.id,
        eventType: 'job_delivered',
        transactionAmount: 0,
        entityId: job.job_id,
        entityType: 'job',
        data: { title: job.title, escrow_id: job.escrow_id ?? null },
        ...twoPartyTargeting(wallet.id, job.poster_wallet_id),
      });

      res.json(serializeJob(job));
    } catch (error) {
      handleError(res, error);
    }
  });

  // GET /my-jobs - Get posted + assigned jobs with status/role filters,
  // pagination, and sort. Defaults preserve pre-filter behavior (50-of-each
  // posted+assigned ordered by posted_desc).
  router.get('/my-jobs', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const wallet = req.agentWallet;
      if (!wallet) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const filters = {
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        role: typeof req.query.role === 'string' ? req.query.role : undefined,
        limit: req.query.limit ? parseInt(String(req.query.limit), 10) : undefined,
        offset: req.query.offset ? parseInt(String(req.query.offset), 10) : undefined,
        sort: typeof req.query.sort === 'string' ? req.query.sort : undefined,
      };

      // Validate enum-typed query params at the route boundary so the
      // core function can stay narrowly typed.
      const allowedStatus = new Set(['open', 'assigned', 'delivered', 'completed', 'cancelled', 'refunded']);
      if (filters.status !== undefined && !allowedStatus.has(filters.status)) {
        res.status(400).json({ error: `status must be one of ${[...allowedStatus].join(', ')}` });
        return;
      }
      const allowedRole = new Set(['posted', 'assigned']);
      if (filters.role !== undefined && !allowedRole.has(filters.role)) {
        res.status(400).json({ error: `role must be 'posted' or 'assigned'` });
        return;
      }
      const allowedSort = new Set(['posted_desc', 'posted_asc', 'updated_desc']);
      if (filters.sort !== undefined && !allowedSort.has(filters.sort)) {
        res.status(400).json({ error: `sort must be one of ${[...allowedSort].join(', ')}` });
        return;
      }
      if (filters.limit !== undefined && (!Number.isInteger(filters.limit) || filters.limit <= 0)) {
        res.status(400).json({ error: 'limit must be a positive integer' });
        return;
      }
      if (filters.offset !== undefined && (!Number.isInteger(filters.offset) || filters.offset < 0)) {
        res.status(400).json({ error: 'offset must be a non-negative integer' });
        return;
      }

      const jobs = await getMyJobs(deps, wallet.id, filters as NonNullable<Parameters<typeof getMyJobs>[2]>);
      res.json({
        ...jobs,
        posted: jobs.posted.map(serializeJob),
        assigned: jobs.assigned.map(serializeJob),
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  return router;
}
