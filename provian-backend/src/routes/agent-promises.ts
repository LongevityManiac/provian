/**
 * Commons institutions - Promise API Routes (Feature-Gated)
 *
 * Endpoints:
 *   POST   /create                   - Create promise (API key auth)
 *   POST   /:promise_id/fund         - Lender funds
 *   POST   /:promise_id/settle       - Borrower repays
 *   GET    /marketplace              - Browse open promises
 *   GET    /:promise_id              - Promise details
 *   GET    /wallet/:wallet_id        - Agent's promise history
 *
 * All endpoints gated by ENABLE_PROMISES env var.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { createAgentAuthMiddleware } from './middleware/agent-auth';
import type { AgentBankDeps, CreatePromiseRequest } from '../core/agent-bank/types';
import {
  createPromise,
  fundPromise,
  settlePromise,
  defaultPromise,
  cancelPromise,
  getPromise,
  getMarketplace,
  getWalletPromises,
  resolvePromiseContractAddress,
} from '../core/agent-bank/promises';
import type { AgentBankChain } from '../core/agent-bank/chain-registry';
import { ValidationError, NotFoundError, ForbiddenError } from '../core/agent-bank/escrow';
import { RateLimitError } from '../core/agent-bank/errors';
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
  if (error instanceof RateLimitError) {
    res.status(429).json({ error: error.message });
  } else if (error instanceof ValidationError) {
    res.status(400).json({ error: error.message });
  } else if (error instanceof NotFoundError) {
    res.status(404).json({ error: error.message });
  } else if (error instanceof ForbiddenError) {
    res.status(403).json({ error: error.message });
  } else {
    console.error('[Promises] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export function createAgentPromisesRouter(deps: AgentBankDeps): Router {
  const { db, cache } = deps;
  const router = Router();
  const authenticateAgent = createAgentAuthMiddleware(db);
  const gate = requireFeature('promises');

  // =========================================================================
  // POST /create - Create promise
  // =========================================================================
  router.post('/create', gate, authenticateAgent, async (req: Request, res: Response) => {
    try {
      const walletId = req.agentWallet?.id || 'unknown';
      // Strict (fail-closed): money-flow endpoint, see agent-escrow.ts.
      const rateLimit = await cache.checkRateLimitStrict(`rl:promise:create:${walletId}`, 10, 60);
      if (!rateLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded', retry_after: rateLimit.retryAfter });
        return;
      }

      const body = req.body as CreatePromiseRequest;

      if (req.agentWallet && req.agentWallet.id !== body.borrower_wallet_id) {
        res.status(403).json({ error: 'Authenticated wallet must be the borrower' });
        return;
      }

      const promise = await createPromise(deps, body);
      // Wave J-bis + Chunk K H-1: contract address must be resolved per chain.
      const promiseCurrency = promise.currency ?? 'usdc';
      const contractAddress = resolvePromiseContractAddress(
        promiseCurrency,
        promise.chain as AgentBankChain,
      );

      const deadlineHours = body.deadline_hours;
      const impliedRate = promiseCurrency === 'pvt'
        ? (() => {
            const principal = BigInt(promise.principal_pvt ?? '0');
            if (principal === 0n) return '0.0';
            const repay = BigInt(promise.repay_pvt ?? '0');
            return ((Number(repay - principal) / Number(principal)) * 100).toFixed(1);
          })()
        : (((promise.repay_usdc - promise.principal_usdc) / promise.principal_usdc) * 100).toFixed(1);

      res.status(201).json({
        promise_id: promise.promise_id,
        status: promise.status,
        currency: promiseCurrency,
        principal_usdc: promise.principal_usdc,
        repay_usdc: promise.repay_usdc,
        fee_usdc: promise.fee_usdc,
        net_to_lender_usdc: promise.net_to_lender_usdc,
        principal_pvt: promise.principal_pvt,
        repay_pvt: promise.repay_pvt,
        fee_pvt: promise.fee_pvt,
        net_to_lender_pvt: promise.net_to_lender_pvt,
        implied_rate: `${impliedRate}% (${deadlineHours}hr)`,
        borrower_profile: {
          economic_activity_usd: promise.borrower_snapshot.economic_activity_usd,
          promise_history: {
            issued: promise.borrower_snapshot.promises_issued,
            settled: promise.borrower_snapshot.promises_settled,
            defaulted: promise.borrower_snapshot.promises_defaulted,
          },
        },
        contract_address: contractAddress,
        deadline: new Date(promise.deadline).toISOString(),
        created_at: new Date(promise.created_at).toISOString(),
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // POST /:promise_id/fund - Lender funds promise
  // =========================================================================
  router.post('/:promise_id/fund', gate, authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { promise_id } = req.params;
      const { tx_hash } = req.body;
      const lenderWalletId = req.agentWallet?.id;

      if (!lenderWalletId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      if (!tx_hash || typeof tx_hash !== 'string') {
        res.status(400).json({ error: 'tx_hash is required' });
        return;
      }
      // no borrower governance-score assertion at fund time (signal deleted).
      const promise = await fundPromise(deps, promise_id, lenderWalletId, tx_hash);

      // each party its own actor + amount; entity + counterparty attached.
      await enqueueAgentBankEvent(deps.db, {
        walletId: promise.borrower_wallet_id,
        eventType: 'promise_funded',
        transactionAmount: promise.principal_usdc,
        entityId: promise.promise_id,
        entityType: 'promise',
        recipients: [promise.borrower_wallet_id],
        counterparties: { [promise.borrower_wallet_id]: lenderWalletId },
      });
      await enqueueAgentBankEvent(deps.db, {
        walletId: lenderWalletId,
        eventType: 'promise_funded',
        transactionAmount: promise.principal_usdc,
        entityId: promise.promise_id,
        entityType: 'promise',
        recipients: [lenderWalletId],
        counterparties: { [lenderWalletId]: promise.borrower_wallet_id },
      });

      res.json({
        promise_id: promise.promise_id,
        status: 'funded',
        lender_wallet_id: promise.lender_wallet_id,
        funded_at: new Date(promise.funded_at!).toISOString(),
        fund_tx_hash: promise.fund_tx_hash,
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // POST /:promise_id/settle - Borrower repays
  // =========================================================================
  router.post('/:promise_id/settle', gate, authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { promise_id } = req.params;
      const { tx_hash } = req.body;
      const callerWalletId = req.agentWallet?.id;

      if (!callerWalletId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      if (!tx_hash || typeof tx_hash !== 'string') {
        res.status(400).json({ error: 'tx_hash is required' });
        return;
      }

      const promise = await settlePromise(deps, promise_id, callerWalletId, tx_hash);

      // each party its own actor + amount; entity + counterparty attached.
      await enqueueAgentBankEvent(deps.db, {
        walletId: promise.borrower_wallet_id,
        eventType: 'promise_settled',
        transactionAmount: promise.repay_usdc,
        entityId: promise.promise_id,
        entityType: 'promise',
        recipients: [promise.borrower_wallet_id],
        counterparties: { [promise.borrower_wallet_id]: promise.lender_wallet_id! },
      });
      await enqueueAgentBankEvent(deps.db, {
        walletId: promise.lender_wallet_id!,
        eventType: 'promise_settled',
        transactionAmount: promise.net_to_lender_usdc,
        entityId: promise.promise_id,
        entityType: 'promise',
        recipients: [promise.lender_wallet_id!],
        counterparties: { [promise.lender_wallet_id!]: promise.borrower_wallet_id },
      });

      res.json({
        promise_id: promise.promise_id,
        status: 'settled',
        settled_at: new Date(promise.settled_at!).toISOString(),
        settle_tx_hash: promise.settle_tx_hash,
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // POST /:promise_id/default - Lender marks a funded promise defaulted
  // =========================================================================
  router.post('/:promise_id/default', gate, authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { promise_id } = req.params;
      const { tx_hash } = req.body;
      const lenderWalletId = req.agentWallet?.id;

      if (!lenderWalletId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      if (!tx_hash || typeof tx_hash !== 'string') {
        res.status(400).json({ error: 'tx_hash is required' });
        return;
      }

      const promise = await defaultPromise(deps, promise_id, lenderWalletId, tx_hash);

      // Outbox: notify BOTH parties (the borrower's reputation is affected; the
      // lender initiated it). Each party its own row, entity + counterparty.
      // `proof: 'onchain_proven'` distinguishes this from the sweep's relay-observed
      // notice (whether this call flipped funded→proven or UPGRADED a relay-observed
      // row, the row is now proven — `promise.default_proof` reflects it).
      const defaultProof = promise.default_proof ?? 'onchain_proven';
      await enqueueAgentBankEvent(deps.db, {
        walletId: promise.borrower_wallet_id,
        eventType: 'promise_defaulted',
        transactionAmount: 0,
        entityId: promise.promise_id,
        entityType: 'promise',
        recipients: [promise.borrower_wallet_id],
        counterparties: { [promise.borrower_wallet_id]: lenderWalletId },
        data: { currency: promise.currency ?? 'usdc', proof: defaultProof },
      });
      await enqueueAgentBankEvent(deps.db, {
        walletId: lenderWalletId,
        eventType: 'promise_defaulted',
        transactionAmount: 0,
        entityId: promise.promise_id,
        entityType: 'promise',
        recipients: [lenderWalletId],
        counterparties: { [lenderWalletId]: promise.borrower_wallet_id },
        data: { currency: promise.currency ?? 'usdc', proof: defaultProof },
      });

      res.json({
        promise_id: promise.promise_id,
        status: 'defaulted',
        defaulted_at: new Date(promise.defaulted_at!).toISOString(),
        default_tx_hash: promise.default_tx_hash,
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // POST /:promise_id/cancel - Borrower cancels an unfunded promise
  // =========================================================================
  router.post('/:promise_id/cancel', gate, authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { promise_id } = req.params;
      const borrowerWalletId = req.agentWallet?.id;

      if (!borrowerWalletId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const promise = await cancelPromise(deps, promise_id, borrowerWalletId);

      // Outbox: an open promise has no lender yet, so only the borrower is a party.
      await enqueueAgentBankEvent(deps.db, {
        walletId: promise.borrower_wallet_id,
        eventType: 'promise_cancelled',
        transactionAmount: 0,
        entityId: promise.promise_id,
        entityType: 'promise',
        recipients: [promise.borrower_wallet_id],
        data: { currency: promise.currency ?? 'usdc' },
        notifyOnly: true,
      });

      res.json({
        promise_id: promise.promise_id,
        status: 'cancelled',
        cancelled_at: new Date(promise.cancelled_at!).toISOString(),
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // GET /marketplace - Browse open promises
  // =========================================================================
  router.get('/marketplace', gate, authenticateAgent, async (req: Request, res: Response) => {
    try {
      const options = {
        max_amount: req.query.max_amount
          ? parseFloat(req.query.max_amount as string)
          : undefined,
        sort: req.query.sort as string | undefined,
        page: req.query.page ? parseInt(req.query.page as string) : 1,
        limit: req.query.limit ? parseInt(req.query.limit as string) : 20,
      };

      const result = await getMarketplace(deps, options);
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // GET /:promise_id - Promise details
  // =========================================================================
  router.get('/:promise_id', gate, authenticateAgent, async (req: Request, res: Response) => {
    try {
      const promise = await getPromise(deps, req.params.promise_id);
      res.json(promise);
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // GET /wallet/:wallet_id - Agent's promise history
  // =========================================================================
  router.get('/wallet/:wallet_id', gate, authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      if (req.agentWallet && req.agentWallet.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }

      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const promises = await getWalletPromises(deps, wallet_id, limit);
      res.json({ promises, count: promises.length });
    } catch (error) {
      handleError(res, error);
    }
  });

  return router;
}
