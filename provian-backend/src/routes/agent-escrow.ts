/**
 * Commons institutions - Escrow API Routes
 *
 * Endpoints:
 *   POST   /create              - Create escrow (API key or wallet auth)
 *   POST   /:escrow_id/fund     - Verify on-chain funding
 *   POST   /:escrow_id/complete - Depositor confirms release
 *   POST   /:escrow_id/dispute  - Depositor disputes
 *   POST   /:escrow_id/resolve  - Admin resolves dispute
 *   GET    /:escrow_id          - Get escrow details
 *   GET    /wallet/:wallet_id   - Agent's escrow history
 */

import { Router, Request, Response } from 'express';
import { createAgentAuthMiddleware } from './middleware/agent-auth';
import { safeSecretCompare } from './middleware/admin-secret';
import type { AgentBankDeps, EscrowDocument } from '../core/agent-bank/types';
import type { CreateEscrowRequest } from '../core/agent-bank/types';
import {
  createEscrow,
  verifyFunding,
  completeEscrow,
  disputeEscrow,
  resolveDispute,
  getEscrow,
  getWalletEscrows,
  resolveEscrowContractAddress,
  ValidationError,
  NotFoundError,
  ForbiddenError,
} from '../core/agent-bank/escrow';
import type { AgentBankChain } from '../core/agent-bank/chain-registry';
import { RateLimitError } from '../core/agent-bank/errors';
import { enqueueAgentBankEvent, twoPartyTargeting } from '../core/agent-bank/event-outbox';
import { makeAgentProvenanceUrl } from '../provenance-links';
import { assertLiveHandshake, RailHandshakeError } from '../core/rail/handshake';

function handleError(res: Response, error: unknown): void {
  if (error instanceof RailHandshakeError) {
    res.status(error.status).json({ error: error.message, reason: error.reason });
  } else if (error instanceof RateLimitError) {
    res.status(429).json({ error: error.message });
  } else if (error instanceof ValidationError) {
    res.status(400).json({ error: error.message });
  } else if (error instanceof NotFoundError) {
    res.status(404).json({ error: error.message });
  } else if (error instanceof ForbiddenError) {
    res.status(403).json({ error: error.message });
  } else {
    console.error('[Escrow] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

function escrowCounterpartyLinks(escrow: EscrowDocument): Record<string, string> {
  return {
    depositor_wallet_id: escrow.depositor_wallet_id,
    depositor_provenance_url: makeAgentProvenanceUrl(escrow.depositor_wallet_id),
    recipient_wallet_id: escrow.recipient_wallet_id,
    recipient_provenance_url: makeAgentProvenanceUrl(escrow.recipient_wallet_id),
  };
}

function serializeEscrow(escrow: EscrowDocument): Record<string, unknown> {
  const counterparties = escrowCounterpartyLinks(escrow);
  return {
    ...escrow,
    ...counterparties,
    counterparties,
  };
}

export function createAgentEscrowRouter(deps: AgentBankDeps): Router {
  const { db, cache } = deps;
  const router = Router();
  const authenticateAgent = createAgentAuthMiddleware(db);

  // =========================================================================
  // POST /create - Create escrow
  // =========================================================================
  router.post('/create', authenticateAgent, async (req: Request, res: Response) => {
    try {
      // Rate limit: 10/min per agent. Strict (fail-closed) because escrow
      // creation moves real money - better a brief 503 during a Redis outage
      // than unbounded agent abuse.
      const walletId = req.agentWallet?.id || 'unknown';
      const rateLimit = await cache.checkRateLimitStrict(`rl:escrow:create:${walletId}`, 10, 60);
      if (!rateLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded', retry_after: rateLimit.retryAfter });
        return;
      }

      const body = req.body as CreateEscrowRequest;

      // Verify caller is the depositor
      if (req.agentWallet && req.agentWallet.id !== body.depositor_wallet_id) {
        res.status(403).json({ error: 'Authenticated wallet must be the depositor' });
        return;
      }

      // RAIL HANDSHAKE (burn-to-present, Part 1): escrow is a PVT-native rail-
      // mediated commitment. The depositor (the party seeking trust for the
      // action) must hold a live presentation to the recipient before the escrow
      // commits — one burn-backed handshake per relationship covers its actions
      // in the window; no separate/stacked burn here. Raw PVT transfer is NOT
      // gated (see core/rail/handshake.ts). Throws 428 if none is live.
      await assertLiveHandshake(deps.db, body.depositor_wallet_id, body.recipient_wallet_id, Date.now());

      const escrow = await createEscrow(deps, body);

      // notify BOTH parties the escrow exists (targeted, not broadcast).
      // notify-only — creating an escrow is not economic activity, so it must not
      // bump either party's pe_count / activity counters.
      {
        const cur = escrow.currency ?? 'usdc';
        const createdAmount = cur === 'pvt'
          ? Number(BigInt(escrow.amount_pvt ?? '0') / (10n ** 18n))
          : escrow.amount_usdc;
        await enqueueAgentBankEvent(deps.db, {
          walletId: escrow.depositor_wallet_id,
          eventType: 'escrow_created',
          transactionAmount: createdAmount,
          amountUnit: cur === 'pvt' ? 'pvt_whole' : 'usdc_whole',
          entityId: escrow.escrow_id,
          entityType: 'escrow',
          data: { currency: cur, escrow_status: escrow.status },
          notifyOnly: true,
          ...twoPartyTargeting(escrow.depositor_wallet_id, escrow.recipient_wallet_id),
        });
      }

      // Wave J-bis + Chunk K H-1: contract address must be resolved per chain.
      // The created escrow already has its chain validated by createEscrow;
      // resolveEscrowContractAddress reads the per-chain env var so the funding
      // instructions point at the correct contract on the correct chain.
      const escrowCurrency = escrow.currency ?? 'usdc';
      const contractAddress = resolveEscrowContractAddress(
        escrowCurrency,
        escrow.chain as AgentBankChain,
      );
      const tokenSymbol = escrowCurrency === 'pvt' ? 'PVT' : 'USDC';

      res.status(201).json({
        escrow_id: escrow.escrow_id,
        status: escrow.status,
        counterparties: escrowCounterpartyLinks(escrow),
        currency: escrowCurrency,
        amount_usdc: escrow.amount_usdc,
        fee_usdc: escrow.fee_usdc,
        net_to_recipient_usdc: escrow.net_to_recipient_usdc,
        amount_pvt: escrow.amount_pvt,
        fee_pvt: escrow.fee_pvt,
        net_to_recipient_pvt: escrow.net_to_recipient_pvt,
        contract_address: contractAddress,
        funding_instructions: {
          step_1: `Approve ${tokenSymbol} spend: ${tokenSymbol.toLowerCase()}.approve(${contractAddress}, amount)`,
          step_2: `Fund escrow: POST /v1/escrow/${escrow.escrow_id}/fund`,
        },
        deadline: new Date(escrow.deadline).toISOString(),
        auto_release_at: new Date(escrow.auto_release_at).toISOString(),
        created_at: new Date(escrow.created_at).toISOString(),
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // POST /:escrow_id/fund - Verify on-chain funding
  // =========================================================================
  router.post('/:escrow_id/fund', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { escrow_id } = req.params;
      const { tx_hash } = req.body;

      if (!tx_hash || typeof tx_hash !== 'string') {
        res.status(400).json({ error: 'tx_hash is required' });
        return;
      }

      const escrow = await verifyFunding(deps, escrow_id, tx_hash);

      // Process event (badges, webhooks). PVT escrows report whole-PVT with
      // amount_unit='pvt_whole'; USDC escrows report whole-USD.
      const fundedAmount = escrow.currency === 'pvt'
        ? Number(BigInt(escrow.amount_pvt ?? '0') / (10n ** 18n))
        : escrow.amount_usdc;
      const fundedUnit = escrow.currency === 'pvt' ? 'pvt_whole' : 'usdc_whole';
      // the depositor is the actor (reconciled); the recipient is now
      // notified too (previously only the depositor was enqueued), carrying the
      // escrow_id + counterparty so the recipient learns funding without polling.
      await enqueueAgentBankEvent(deps.db, {
        walletId: escrow.depositor_wallet_id,
        eventType: 'escrow_funded',
        transactionAmount: fundedAmount,
        amountUnit: fundedUnit,
        entityId: escrow.escrow_id,
        entityType: 'escrow',
        data: { currency: escrow.currency ?? 'usdc' },
        ...twoPartyTargeting(escrow.depositor_wallet_id, escrow.recipient_wallet_id),
      });

      res.json({
        escrow_id: escrow.escrow_id,
        status: 'funded',
        counterparties: escrowCounterpartyLinks(escrow),
        funded_at: new Date(escrow.funded_at!).toISOString(),
        fund_tx_hash: escrow.fund_tx_hash,
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // POST /:escrow_id/complete - Depositor confirms release
  // =========================================================================
  router.post('/:escrow_id/complete', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { escrow_id } = req.params;
      const callerWalletId = req.agentWallet?.id;
      if (!callerWalletId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const escrow = await completeEscrow(deps, escrow_id, callerWalletId);

      // Process events for both parties. PVT escrows report whole-PVT with
      // amount_unit='pvt_whole'; USDC escrows report whole-USD.
      const depositorAmount = escrow.currency === 'pvt'
        ? Number(BigInt(escrow.amount_pvt ?? '0') / (10n ** 18n))
        : escrow.amount_usdc;
      const recipientAmount = escrow.currency === 'pvt'
        ? Number(BigInt(escrow.net_to_recipient_pvt ?? '0') / (10n ** 18n))
        : escrow.net_to_recipient_usdc;
      const completedUnit = escrow.currency === 'pvt' ? 'pvt_whole' : 'usdc_whole';
      // Both parties realize economic activity on completion, so each is its own
      // actor (reconciled) with its own amount; each carries the escrow_id and the
      // other party as counterparty.
      await enqueueAgentBankEvent(deps.db, {
        walletId: escrow.depositor_wallet_id,
        eventType: 'escrow_completed',
        transactionAmount: depositorAmount,
        amountUnit: completedUnit,
        entityId: escrow.escrow_id,
        entityType: 'escrow',
        recipients: [escrow.depositor_wallet_id],
        counterparties: { [escrow.depositor_wallet_id]: escrow.recipient_wallet_id },
        data: { currency: escrow.currency ?? 'usdc' },
      });
      await enqueueAgentBankEvent(deps.db, {
        walletId: escrow.recipient_wallet_id,
        eventType: 'escrow_completed',
        transactionAmount: recipientAmount,
        amountUnit: completedUnit,
        entityId: escrow.escrow_id,
        entityType: 'escrow',
        recipients: [escrow.recipient_wallet_id],
        counterparties: { [escrow.recipient_wallet_id]: escrow.depositor_wallet_id },
        data: { currency: escrow.currency ?? 'usdc' },
      });

      res.json({
        escrow_id: escrow.escrow_id,
        status: 'completed',
        counterparties: escrowCounterpartyLinks(escrow),
        completed_at: new Date(escrow.completed_at!).toISOString(),
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // POST /:escrow_id/dispute - Depositor disputes
  // =========================================================================
  router.post('/:escrow_id/dispute', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { escrow_id } = req.params;
      const callerWalletId = req.agentWallet?.id;
      if (!callerWalletId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const { reason, evidence } = req.body;
      if (!reason || typeof reason !== 'string') {
        res.status(400).json({ error: 'reason is required' });
        return;
      }

      const escrow = await disputeEscrow(deps, escrow_id, callerWalletId, reason, evidence);

      // notify BOTH parties (esp. the non-disputing one, whose escrow is now
      // contested). notify-only — a dispute is not economic activity.
      await enqueueAgentBankEvent(deps.db, {
        walletId: callerWalletId,
        eventType: 'escrow_disputed',
        transactionAmount: 0,
        entityId: escrow.escrow_id,
        entityType: 'escrow',
        data: { currency: escrow.currency ?? 'usdc', disputed_by: callerWalletId, reason },
        notifyOnly: true,
        ...twoPartyTargeting(escrow.depositor_wallet_id, escrow.recipient_wallet_id),
      });

      res.json({
        escrow_id: escrow.escrow_id,
        status: 'disputed',
        counterparties: escrowCounterpartyLinks(escrow),
        disputed_at: new Date(escrow.disputed_at!).toISOString(),
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // POST /:escrow_id/resolve - Admin resolves dispute
  // =========================================================================
  router.post('/:escrow_id/resolve', async (req: Request, res: Response) => {
    try {
      if (!safeSecretCompare(req.headers['x-admin-secret'], process.env.AGENT_BANK_ADMIN_SECRET)) {
        res.status(401).json({ error: 'admin_auth_failed' });
        return;
      }

      const { escrow_id } = req.params;
      const { release_to_recipient, resolution_reason } = req.body;

      if (typeof release_to_recipient !== 'boolean') {
        res.status(400).json({ error: 'release_to_recipient (boolean) is required' });
        return;
      }
      if (!resolution_reason || typeof resolution_reason !== 'string') {
        res.status(400).json({ error: 'resolution_reason is required' });
        return;
      }

      const escrow = await resolveDispute(deps, escrow_id, release_to_recipient, resolution_reason);

      // notify BOTH parties of the admin resolution. notify-only — the
      // resolution's value movement is recorded by completeEscrow's own events; this
      // is the resolution notice itself.
      await enqueueAgentBankEvent(deps.db, {
        walletId: escrow.depositor_wallet_id,
        eventType: 'escrow_resolved',
        transactionAmount: 0,
        entityId: escrow.escrow_id,
        entityType: 'escrow',
        data: {
          currency: escrow.currency ?? 'usdc',
          resolution: escrow.resolution ?? null,
          released_to_recipient: release_to_recipient,
        },
        notifyOnly: true,
        ...twoPartyTargeting(escrow.depositor_wallet_id, escrow.recipient_wallet_id),
      });

      res.json({
        escrow_id: escrow.escrow_id,
        status: 'resolved',
        counterparties: escrowCounterpartyLinks(escrow),
        resolution: escrow.resolution,
        resolved_at: new Date(escrow.resolved_at!).toISOString(),
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // GET /:escrow_id - Get escrow details
  // =========================================================================
  router.get('/:escrow_id', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const escrow = await getEscrow(deps, req.params.escrow_id);
      // F47/F64 (S2 2026-09-10): party-scope the by-id read. The sibling
      // /wallet/:wallet_id route already scopes to a party, but this by-id read
      // returned the full escrow document (counterparty wallet ids + on-chain
      // addresses, description, deliverables, amounts, fund/release tx hashes) to
      // ANY authenticated agent that learned an esc_<uuid> (they leak through job
      // events, court filings, published PE details). Restrict to the escrow's
      // parties; 404 on mismatch so a non-party cannot even confirm existence.
      const callerId = req.agentWallet?.id;
      if (!callerId || (callerId !== escrow.depositor_wallet_id && callerId !== escrow.recipient_wallet_id)) {
        throw new NotFoundError('Escrow not found');
      }
      res.json(serializeEscrow(escrow));
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // GET /wallet/:wallet_id - Agent's escrow history
  // =========================================================================
  router.get('/wallet/:wallet_id', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      if (req.agentWallet && req.agentWallet.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }

      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const escrows = await getWalletEscrows(deps, wallet_id, limit);
      res.json({ escrows: escrows.map(serializeEscrow), count: escrows.length });
    } catch (error) {
      handleError(res, error);
    }
  });

  return router;
}
