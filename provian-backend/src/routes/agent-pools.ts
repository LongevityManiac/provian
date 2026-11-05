/**
 * Commons institutions - Pool API Routes (Feature-Gated)
 *
 * Endpoints:
 *   POST   /create                - Create pool (API key auth)
 *   POST   /:pool_id/contribute   - Contribute to pool
 *   POST   /:pool_id/execute      - Trigger execution (creator or admin)
 *   POST   /:pool_id/withdraw     - Withdraw contribution
 *   GET    /active                - Browse active pools
 *   GET    /:pool_id              - Pool details
 *   GET    /wallet/:wallet_id     - Agent's pool history
 *
 * All endpoints gated by ENABLE_POOLS env var.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { createAgentAuthMiddleware } from './middleware/agent-auth';
import { safeSecretCompare } from './middleware/admin-secret';
import type { AgentBankDeps, CreatePoolRequest } from '../core/agent-bank/types';
import {
  createPool,
  contribute,
  executePool,
  withdrawContribution,
  getPool,
  getActivePools,
  getWalletPools,
  resolvePoolContractAddress,
} from '../core/agent-bank/pools';
import type { AgentBankChain } from '../core/agent-bank/chain-registry';
import { ValidationError, NotFoundError, ForbiddenError } from '../core/agent-bank/escrow';
import { enqueueAgentBankEvent, twoPartyTargeting } from '../core/agent-bank/event-outbox';
import { isFeatureEnabled, type GatedFeature } from './middleware/feature-flag';

// ---------------------------------------------------------------------------
// Feature gate middleware
// ---------------------------------------------------------------------------

function requireFeature(feature: GatedFeature) {
  return (_req: Request, res: Response, next: NextFunction) => {
    // The same call GET /v1/ecosystem reports this rail's status from.
    if (!isFeatureEnabled(feature)) {
      const contractAddress = process.env[`${feature.toUpperCase()}_CONTRACT_ADDRESS`] || '';
      res.status(503).json({
        error: 'coming_soon',
        message: `${feature} is deployed but not yet active. Watch for announcements.`,
        contract_address: contractAddress,
      });
      return;
    }
    next();
  };
}

function handleError(res: Response, error: unknown): void {
  if (error instanceof ValidationError) {
    res.status(400).json({ error: error.message });
  } else if (error instanceof NotFoundError) {
    res.status(404).json({ error: error.message });
  } else if (error instanceof ForbiddenError) {
    res.status(403).json({ error: error.message });
  } else {
    console.error('[Pools] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export function createAgentPoolsRouter(deps: AgentBankDeps): Router {
  const { db, cache } = deps;
  const router = Router();
  const authenticateAgent = createAgentAuthMiddleware(db);
  const gate = requireFeature('pools');

  // =========================================================================
  // POST /create - Create pool
  // =========================================================================
  router.post('/create', gate, authenticateAgent, async (req: Request, res: Response) => {
    try {
      const walletId = req.agentWallet?.id || 'unknown';
      // Strict (fail-closed): money-flow endpoint, see agent-escrow.ts.
      const rateLimit = await cache.checkRateLimitStrict(`rl:pool:create:${walletId}`, 10, 60);
      if (!rateLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded', retry_after: rateLimit.retryAfter });
        return;
      }

      const body = req.body as CreatePoolRequest;

      if (req.agentWallet && req.agentWallet.id !== body.creator_wallet_id) {
        res.status(403).json({ error: 'Authenticated wallet must be the creator' });
        return;
      }

      const pool = await createPool(deps, body);
      // Wave J-bis + Chunk K H-1: contract address must be resolved per chain.
      const poolCurrency = pool.currency ?? 'usdc';
      const contractAddress = resolvePoolContractAddress(
        poolCurrency,
        pool.chain as AgentBankChain,
      );

      res.status(201).json({
        pool_id: pool.pool_id,
        status: pool.status,
        threshold_usdc: pool.threshold_usdc,
        fee_usdc: pool.fee_usdc,
        net_to_target_usdc: pool.net_to_target_usdc,
        target_address: pool.target_address,
        target_description: pool.target_description,
        contract_address: contractAddress,
        deadline: new Date(pool.deadline).toISOString(),
        contributors: 0,
        total_contributed_usdc: 0,
        created_at: new Date(pool.created_at).toISOString(),
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // POST /:pool_id/contribute - Contribute to pool
  // =========================================================================
  router.post('/:pool_id/contribute', gate, authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { pool_id } = req.params;
      // Workstream 2: contribution amount comes in either amount_usdc (number)
      // or amount_pvt (BigInt-as-string). Pool's stored currency dictates which
      // is required; sending the wrong one fails inside contribute() with
      // ValidationError. Routes don't need to know the pool's currency - they
      // just forward both fields.
      const { amount_usdc, amount_pvt, tx_hash } = req.body;
      const contributorWalletId = req.agentWallet?.id;

      if (!contributorWalletId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      if (amount_usdc === undefined && amount_pvt === undefined) {
        res.status(400).json({ error: 'amount_usdc (number) or amount_pvt (BigInt string, 18d) is required' });
        return;
      }
      if (amount_usdc !== undefined && (typeof amount_usdc !== 'number' || amount_usdc <= 0)) {
        res.status(400).json({ error: 'amount_usdc must be a positive number' });
        return;
      }
      if (amount_pvt !== undefined && (typeof amount_pvt !== 'string' || !/^[0-9]+$/.test(amount_pvt))) {
        res.status(400).json({ error: 'amount_pvt must be a non-negative integer string (BigInt 18d)' });
        return;
      }
      if (!tx_hash || typeof tx_hash !== 'string') {
        res.status(400).json({ error: 'tx_hash is required' });
        return;
      }

      const amountArg: { amountUsdc?: number; amountPvtWei?: bigint } = {};
      if (amount_usdc !== undefined) amountArg.amountUsdc = amount_usdc;
      if (amount_pvt !== undefined) amountArg.amountPvtWei = BigInt(amount_pvt);

      const pool = await contribute(deps, pool_id, contributorWalletId, amountArg, tx_hash);

      // Telemetry: report contribution amount in USD-equivalent for fee
      // accounting on USDC pools; PVT pools report 0 to keep the legacy
      // accounting helper unaware of PVT (Phase 2 will replace it with a
      // currency-aware analyser).
      const reportedAmount = amount_usdc ?? 0;
      await enqueueAgentBankEvent(deps.db, {
        walletId: contributorWalletId,
        eventType: 'pool_contributed',
        transactionAmount: reportedAmount,
        entityId: pool.pool_id,
        entityType: 'pool',
        data: { currency: pool.currency ?? 'usdc', target_address: pool.target_address ?? null },
      });

      res.json({
        pool_id: pool.pool_id,
        status: pool.status,
        currency: pool.currency ?? 'usdc',
        total_contributed_usdc: pool.total_contributed_usdc,
        total_contributed_pvt: pool.total_contributed_pvt,
        threshold_usdc: pool.threshold_usdc,
        threshold_pvt: pool.threshold_pvt,
        contributors: Object.keys(pool.contributions).length,
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // POST /:pool_id/execute - Trigger pool execution
  // =========================================================================
  router.post('/:pool_id/execute', gate, authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { pool_id } = req.params;
      const { tx_hash } = req.body;

      // Check for admin auth or agent auth (constant-time admin compare).
      // Three cases:
      //   1. x-admin-secret absent: route falls through to agent caller.
      //   2. x-admin-secret present and valid: caller is admin; isAdmin=true.
      //   3. x-admin-secret present and invalid: 401. Refusing to silently
      //      downgrade an admin-claiming request to a non-admin response is
      //      important here because admin status grants different policy
      //      effects inside executePool.
      const adminSecretHeader = req.headers['x-admin-secret'];
      let isAdmin = false;
      if (adminSecretHeader !== undefined) {
        if (!safeSecretCompare(adminSecretHeader, process.env.AGENT_BANK_ADMIN_SECRET)) {
          res.status(401).json({ error: 'admin_auth_failed' });
          return;
        }
        isAdmin = true;
      }
      // Carry a clearer actor identifier into audit logs when the caller is
      // admin: 'admin:agent-bank' is unambiguous in log greps and cannot
      // collide with a real wallet_id (no agent wallet_id contains a colon).
      const callerWalletId = isAdmin ? 'admin:agent-bank' : req.agentWallet?.id;

      if (!callerWalletId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      if (!tx_hash || typeof tx_hash !== 'string') {
        res.status(400).json({ error: 'tx_hash is required' });
        return;
      }

      const pool = await executePool(deps, pool_id, callerWalletId, tx_hash, isAdmin);

      // Process events for all contributors (each is a party; the pool + its
      // target ride in the event so a contributor learns execution without polling).
      for (const [walletId, contribution] of Object.entries(pool.contributions)) {
        await enqueueAgentBankEvent(deps.db, {
          walletId,
          eventType: 'pool_executed',
          transactionAmount: contribution.amount_usdc,
          entityId: pool.pool_id,
          entityType: 'pool',
          recipients: [walletId],
          data: { currency: pool.currency ?? 'usdc', target_address: pool.target_address ?? null },
        });
      }

      res.json({
        pool_id: pool.pool_id,
        status: 'executed',
        executed_at: new Date(pool.executed_at!).toISOString(),
        execute_tx_hash: pool.execute_tx_hash,
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // POST /:pool_id/withdraw - Withdraw contribution
  //
  // The on-chain withdrawContribution(bytes32) is msg.sender-bound, so the agent
  // broadcasts it with its OWN key and passes the resulting tx_hash; the relay
  // VERIFIES the on-chain withdrawal (PoolWithdrawal event) before mutating
  // Firestore or emitting the pool_withdrawn PE (P4-01). Mirrors contribute/execute.
  // =========================================================================
  router.post('/:pool_id/withdraw', gate, authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { pool_id } = req.params;
      const { tx_hash } = req.body;
      const contributorWalletId = req.agentWallet?.id;

      if (!contributorWalletId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      if (!tx_hash || typeof tx_hash !== 'string') {
        res.status(400).json({
          error: 'tx_hash is required — broadcast withdrawContribution(poolId) with your wallet key, then pass its hash',
        });
        return;
      }

      const pool = await withdrawContribution(deps, pool_id, contributorWalletId, tx_hash);

      res.json({
        pool_id: pool.pool_id,
        status: pool.status,
        currency: pool.currency ?? 'usdc',
        total_contributed_usdc: pool.total_contributed_usdc,
        total_contributed_pvt: pool.total_contributed_pvt,
        withdraw_tx_hash: tx_hash,
        message: 'Contribution withdrawn — on-chain withdrawal confirmed',
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // GET /active - Browse active pools
  // =========================================================================
  router.get('/active', gate, authenticateAgent, async (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
      const pools = await getActivePools(deps, limit);
      res.json({ pools, count: pools.length });
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // GET /:pool_id - Pool details
  // =========================================================================
  router.get('/:pool_id', gate, authenticateAgent, async (req: Request, res: Response) => {
    try {
      const pool = await getPool(deps, req.params.pool_id);
      res.json(pool);
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // GET /wallet/:wallet_id - Agent's pool history
  // =========================================================================
  router.get('/wallet/:wallet_id', gate, authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      if (req.agentWallet && req.agentWallet.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }

      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const pools = await getWalletPools(deps, wallet_id, limit);
      res.json({ pools, count: pools.length });
    } catch (error) {
      handleError(res, error);
    }
  });

  return router;
}
