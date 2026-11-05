/**
 * Commons institutions - Agent Directory Routes
 *
 * Endpoints:
 *   POST   /register-capabilities   - Register/update agent capabilities
 *   GET    /directory               - Browse directory (public, filterable); also lists the
 *                                      x402 sellers registered with Provian's facilitator
 *   GET    /profile/:wallet_id      - Get agent directory profile (public)
 */

import { Router, Request, Response } from 'express';
import { createAgentAuthMiddleware } from './middleware/agent-auth';
import type { AgentBankDeps, AgentDirectoryDocument } from '../core/agent-bank/types';
import {
  registerCapabilities,
  browseDirectory,
  getDirectoryProfile,
} from '../core/agent-bank/directory';
import { ValidationError, NotFoundError } from '../core/agent-bank/escrow';
import { makeAgentProvenanceUrl } from '../provenance-links';
import { listActiveX402Sellers, x402SellerDirectoryEntry } from '../core/x402/sellers';

function handleError(res: Response, error: unknown): void {
  if (error instanceof ValidationError) {
    res.status(400).json({ error: error.message });
  } else if (error instanceof NotFoundError) {
    res.status(404).json({ error: error.message });
  } else {
    console.error('[Directory] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Workstream 3: serialize a directory profile with PVT-first field ordering.
 *
 * The W3 directive ("Discovery responses include both fields when present,
 * with PVT listed first") requires the PVT rate to appear before the USDC
 * rate in JSON responses so clients walking object keys in document order
 * see the canonical agent-economy unit first. Firestore documents have no
 * guaranteed key order on reconstruction, so we rebuild the response object
 * explicitly here at the response boundary.
 */
function serializeDirectoryProfile(doc: AgentDirectoryDocument): Record<string, unknown> {
  return {
    wallet_id: doc.wallet_id,
    agent_id: doc.agent_id,
    display_name: doc.display_name,
    address: doc.address,
    capabilities: doc.capabilities,
    description: doc.description,
    availability: doc.availability,
    // PVT first - primary agent-economy unit.
    hourly_rate_pvt: doc.hourly_rate_pvt,
    hourly_rate_usdc: doc.hourly_rate_usdc,
    preferred_chains: doc.preferred_chains,
    pe_count: doc.pe_count,
    provenance_url: makeAgentProvenanceUrl(doc.wallet_id),
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
}

export function createAgentDirectoryRouter(deps: AgentBankDeps): Router {
  const { db, cache } = deps;
  const router = Router();
  const authenticateAgent = createAgentAuthMiddleware(db);

  // POST /register-capabilities - Register or update capabilities
  router.post('/register-capabilities', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const wallet = req.agentWallet;
      if (!wallet) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const rateLimit = await cache.checkRateLimit(`rl:dir:reg:${wallet.id}`, 5, 60);
      if (!rateLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded', retry_after: rateLimit.retryAfter });
        return;
      }

      const profile = await registerCapabilities(deps, wallet.id, wallet, req.body);
      res.status(200).json(serializeDirectoryProfile(profile));
    } catch (error) {
      handleError(res, error);
    }
  });

  // GET /directory - Browse directory (public)
  router.get('/directory', async (req: Request, res: Response) => {
    try {
      const filters = {
        capability: typeof req.query.capability === 'string' ? req.query.capability : undefined,
        availability: typeof req.query.availability === 'string' ? req.query.availability : undefined,
        min_pe_count: req.query.min_pe_count
          ? parseInt(String(req.query.min_pe_count), 10)
          : undefined,
        limit: req.query.limit ? parseInt(String(req.query.limit), 10) : undefined,
        offset: req.query.offset ? parseInt(String(req.query.offset), 10) : undefined,
      };

      const agents = await browseDirectory(deps, filters);
      // : sellers registered with Provian's x402 facilitator are listed beside the
      // agents, in their own section and clearly marked (`kind: 'x402_seller'`), so every existing
      // `agents` / `count` consumer reads exactly what it read before.
      const sellers = await listActiveX402Sellers(db);
      res.json({
        agents: agents.map(serializeDirectoryProfile),
        count: agents.length,
        x402_sellers: sellers.sellers.map(x402SellerDirectoryEntry),
        x402_sellers_next_cursor: sellers.next_cursor,
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // GET /profile/:wallet_id - Get directory profile (public)
  router.get('/profile/:wallet_id', async (req: Request, res: Response) => {
    try {
      const profile = await getDirectoryProfile(deps, req.params.wallet_id);
      res.json(serializeDirectoryProfile(profile));
    } catch (error) {
      handleError(res, error);
    }
  });

  return router;
}
