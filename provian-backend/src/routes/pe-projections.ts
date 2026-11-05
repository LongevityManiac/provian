/**
 * PE Public Projections - Protocol-Level Routes
 *
 * These endpoints are part of the PE protocol, not the Commons reference
 * implementation. Any client - Provian's Commons, third-party Commons
 * implementations, custom dashboards - can use these endpoints to publish,
 * verify, and manage PE Public Projections.
 *
 * Mounted at /v1/pe in server.ts AFTER pe-proposals, conformance, and
 * pe-verify routers. Uses /projection/:peId and /consent/ path prefixes
 * to avoid wildcard collisions with other /v1/pe routers.
 *
 * Auth: Supports wallet auth, agent session auth, and Commons session token.
 */

import { Router, Request, Response } from 'express';
import type { AgentBankDeps } from '../core/agent-bank/types';
import { ValidationError, NotFoundError, ForbiddenError } from '../core/agent-bank/errors';
import { requireAuth } from './middleware/commons-auth';
import {
  publishPE,
  unpublishPE,
  requestConsent,
  respondToConsent,
  getPendingConsents,
  verifyProjection,
} from '../core/commons/publication';

function handleError(res: Response, error: unknown): void {
  if (error instanceof ValidationError) {
    res.status(400).json({ error: error.message });
  } else if (error instanceof NotFoundError) {
    res.status(404).json({ error: error.message });
  } else if (error instanceof ForbiddenError) {
    res.status(403).json({ error: error.message });
  } else {
    console.error('[PE Projections] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export function createPEProjectionsRouter(deps: AgentBankDeps): Router {
  const router = Router();

  // ═══ PUBLIC ENDPOINTS ════════════════════════════════════════════════════

  // GET /projection/:peId - Retrieve and verify a PE Public Projection
  router.get('/projection/:peId', async (req, res) => {
    try {
      const result = await verifyProjection(deps, req.params.peId);
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  // ═══ AUTHENTICATED ENDPOINTS ═════════════════════════════════════════════

  // POST /publish-projection - Publish a PE as a Public Projection
  router.post('/publish-projection', async (req, res) => {
    try {
      const auth = await requireAuth(req, res, deps);
      if (!auth) return;
      // never substitute the wallet id for an
      // unresolved address — null is persisted as null.
      const projection = await publishPE(deps, auth.walletId, auth.agentId, auth.actorAddress, req.body);
      res.status(201).json(projection);
    } catch (error) {
      handleError(res, error);
    }
  });

  // Owner-held legacy ids stay inside authenticated encrypted bodies, never request URLs.
  router.post('/unpublish-projection', async (req, res) => {
    try {
      const auth = await requireAuth(req, res, deps);
      if (!auth) return;
      if(typeof req.body?.pe_id!=='string')throw new ValidationError('pe_id required');
      await unpublishPE(deps, auth.walletId, req.body.pe_id);
      res.json({ status: 'unpublished' });
    } catch (error) { handleError(res, error); }
  });

  // Compatibility for public opaque ids; owner clients use the protected body operation.
  router.delete('/projection/:peId', async (req, res) => {
    try {
      const auth = await requireAuth(req, res, deps);
      if (!auth) return;
      await unpublishPE(deps, auth.walletId, req.params.peId);
      res.json({ status: 'unpublished' });
    } catch (error) {
      handleError(res, error);
    }
  });

  // POST /request-consent - Request mutual publication consent
  router.post('/request-consent', async (req, res) => {
    try {
      const auth = await requireAuth(req, res, deps);
      if (!auth) return;
      const consent = await requestConsent(deps, auth.walletId, req.body, { agentId: auth.agentId });
      res.status(201).json(consent);
    } catch (error) {
      handleError(res, error);
    }
  });

  // PUT /consent/:consentId - Respond to a consent request
  router.put('/consent/:consentId', async (req, res) => {
    try {
      const auth = await requireAuth(req, res, deps);
      if (!auth) return;
      const consent = await respondToConsent(deps, auth.walletId, req.params.consentId, req.body.decision);
      res.json(consent);
    } catch (error) {
      handleError(res, error);
    }
  });

  // GET /consent/pending - List pending consent requests
  router.get('/consent/pending', async (req, res) => {
    try {
      const auth = await requireAuth(req, res, deps);
      if (!auth) return;
      const consents = await getPendingConsents(deps, auth.walletId);
      res.json({ consents });
    } catch (error) {
      handleError(res, error);
    }
  });

  return router;
}
