/**
 * PE Type Catalog READ Routes
 *
 * PE types are PERMISSIONLESS - any valid identifier is accepted at PE
 * submission time. These routes expose the READ-ONLY discovery/documentation
 * layer over the auto-registered catalog:
 *
 * GET /type-catalog - Browse catalog (filterable)
 * GET /type-catalog/:type_name - Fetch a single catalog entry
 *
 * Legacy read aliases (kept for backward compat):
 * GET /proposals → GET /type-catalog
 * GET /proposals/:proposal_id → GET /type-catalog/:type_name
 *
 * the WRITE forms are GONE: the type-catalog "document a PE type" POST
 * (with its `/propose-type` alias and `suggested_tier`) and the endorse/upvote
 * POSTs are deleted. The submitted envelope is the only submission a contributor
 * ever makes; a type is documented and priced by a signed code change, never a
 * web form. Reads stay public.
 */

import { Router, Request, Response } from 'express';
import type { AgentBankDeps } from '../core/agent-bank/types';
import {
  listPECatalogTypes,
  getPECatalogType,
} from '../core/agent-bank/pe-proposals';
import { ValidationError, NotFoundError } from '../core/agent-bank/errors';

function handleError(res: Response, error: unknown): void {
  if (error instanceof ValidationError) {
    res.status(400).json({ error: error.message });
  } else if (error instanceof NotFoundError) {
    res.status(404).json({ error: error.message });
  } else {
    console.error('[PECatalog] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export function createPEProposalRouter(deps: AgentBankDeps): Router {
  const router = Router();

  // ---------------------------------------------------------------------------
  // GET /type-catalog - Browse catalog (public)
  // Query params: ?category=<string> &source=<seed|auto_registered|namespace> &status=<active|deprecated> &limit=<n> &offset=<n>
  // ---------------------------------------------------------------------------
  const list = async (req: Request, res: Response): Promise<void> => {
    try {
      const category = typeof req.query.category === 'string' ? req.query.category : undefined;
      const source = typeof req.query.source === 'string' ? req.query.source : undefined;
      const statusParam = typeof req.query.status === 'string' ? req.query.status : undefined;
      const limit = Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 100);
      const offset = parseInt(String(req.query.offset || '0'), 10) || 0;

      // Legacy status mapping: old 'open' → active
      const status = statusParam === 'open' ? 'active' : statusParam;

      const entries = await listPECatalogTypes(deps, { category, source, status }, limit, offset);
      res.json({ types: entries, count: entries.length });
    } catch (error) {
      handleError(res, error);
    }
  };
  router.get('/type-catalog', list);
  router.get('/proposals', list); // Legacy alias

  // ---------------------------------------------------------------------------
  // GET /type-catalog/:type_name - Single entry (public)
  // ---------------------------------------------------------------------------
  const get = async (req: Request, res: Response): Promise<void> => {
    try {
      const name = req.params.type_name || req.params.proposal_id;
      const entry = await getPECatalogType(deps, name);
      res.json(entry);
    } catch (error) {
      handleError(res, error);
    }
  };
  router.get('/type-catalog/:type_name', get);
  router.get('/proposals/:proposal_id', get); // Legacy alias

  return router;
}
