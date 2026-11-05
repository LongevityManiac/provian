/**
 * Commons institutions - Performance Bonds API Routes
 *
 * Mounted at /v1/bonds. Endpoints:
 * POST /post - Post a new performance bond
 * POST /renew - Renew an existing bond
 * POST /withdraw - Withdraw bond (blocked if claims pending)
 * GET /:agentId - Get bond details for an agent
 * POST /claim/file - File a claim against an agent's bond
 * POST /claim/:claimId/resolution - Observe the on-chain Court settlement
 * GET /claim/:claimId - Get claim status and history
 * GET /requirements/:autonomyLevel - Get bond requirements for a level
 * GET /status/:agentId - Check bond status (used by FrictionRouter)
 *
 * History: previously mounted at /v1/insurance with a /bond/ sub-prefix
 * on the lookup/post/renew/withdraw routes. The institution name was
 * Insurance, withdrawn 2026-03-14 for regulatory reasons; the contract
 * is now ProvianBondPool and the institution is Performance Bonds.
 * URL renamed to match. Hard cutover with no deprecation stub: any
 * client still hitting /v1/insurance/* gets a 404 (Express default)
 * and updates.
 */

import { Router, Request, Response } from 'express';
import { createAgentAuthMiddleware } from './middleware/agent-auth';
import type { AgentBankDeps } from '../core/agent-bank/types';
import type {
  PostBondRequest,
  RenewBondRequest,
  WithdrawBondRequest,
  FileClaimRequest,
} from '../core/agent-bank/types';
import {
  postBond,
  renewBond,
  topUpBond,
  withdrawBond,
  fileClaim,
  getRequiredBond,
  getBondByAgent,
  getBondDetails,
  getClaimDetails,
  checkBondStatus,
  observeBondClaimSettlement,
} from '../core/agent-bank/bonds';
import type { TopUpBondRequest } from '../core/agent-bank/types';
import { ValidationError, NotFoundError, ForbiddenError, RateLimitError } from '../core/agent-bank/errors';
import { SAFETY_LIMITS } from '../core/agent-bank/types';
import { enqueueAgentBankEvent, twoPartyTargeting } from '../core/agent-bank/event-outbox';
import { assertLiveHandshake, RailHandshakeError, RAIL_COMMONS_AUDIENCE } from '../core/rail/handshake';

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
    console.error('[Bonds] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export function createAgentBondsRouter(deps: AgentBankDeps): Router {
  const { db, cache } = deps;
  const router = Router();
  const authenticateAgent = createAgentAuthMiddleware(db);

  // =========================================================================
  // POST /post - Post a new performance bond
  // =========================================================================
  router.post('/post', authenticateAgent, async (req: Request, res: Response) => {
    try {
      // bond lifecycle: the acting wallet doc (set by authenticateAgent) rides into the
      // module so the machine's suspension-check-first gate runs before any I/O.
      const actingWallet = req.agentWallet;
      if (!actingWallet) {
        res.status(401).json({ error: 'Agent wallet authentication required' });
        return;
      }
      const walletId = actingWallet.id;
      const rateLimit = await cache.checkRateLimitStrict(`rl:bond:post:${walletId}`, 5, 60);
      if (rateLimit.error === 'rate_limit_unavailable') {
        res.status(503).json({ error: 'rate_limit_unavailable' });
        return;
      }
      if (!rateLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded', retry_after: rateLimit.retryAfter });
        return;
      }

      // RAIL HANDSHAKE (burn-to-present, Part 1): posting a performance bond is a
      // rail-mediated commitment to the commons. The agent (seeking trust for the
      // bond) must hold a live commons handshake — a burn-backed presentation to
      // RAIL_COMMONS_AUDIENCE — before it commits. One commons handshake covers
      // the agent's commons commitments in the window. Throws 428 if none is live.
      await assertLiveHandshake(db, walletId, RAIL_COMMONS_AUDIENCE, Date.now());

      const body = req.body as PostBondRequest;
      const bond = await postBond(deps, walletId, actingWallet, body);

      // The insured-agent badge cursor was committed atomically by postBond.
      // Durably enqueue the reconciliation/notification pass; the scheduler drains
      // it, so a failure is recoverable from that row rather than a dropped promise.
      await enqueueAgentBankEvent(deps.db, { walletId, eventType: 'bond_posted', transactionAmount: 0, entityId: bond.bond_id, entityType: 'bond' });

      res.status(201).json({
        bond_id: bond.bond_id,
        status: bond.status,
        autonomy_level: bond.autonomy_level,
        amount_pvt: bond.amount_pvt,
        trust_discount_bps: bond.trust_discount_bps,
        renewal_deadline: bond.renewal_deadline,
        chain: bond.chain,
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // POST /renew - Renew an existing bond
  // =========================================================================
  router.post('/renew', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const actingWallet = req.agentWallet;
      if (!actingWallet) {
        res.status(401).json({ error: 'Agent wallet authentication required' });
        return;
      }
      const walletId = actingWallet.id;
      const rateLimit = await cache.checkRateLimitStrict(`rl:bond:renew:${walletId}`, 5, 60);
      if (rateLimit.error === 'rate_limit_unavailable') {
        res.status(503).json({ error: 'rate_limit_unavailable' });
        return;
      }
      if (!rateLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded', retry_after: rateLimit.retryAfter });
        return;
      }

      const body = req.body as RenewBondRequest;
      const bond = await renewBond(deps, walletId, actingWallet, body);

      await enqueueAgentBankEvent(deps.db, { walletId, eventType: 'bond_renewed', transactionAmount: 0, entityId: bond.bond_id, entityType: 'bond' });

      res.json({
        bond_id: bond.bond_id,
        status: bond.status,
        renewal_deadline: bond.renewal_deadline,
        last_renewal_at: bond.last_renewal_at,
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // POST /topup - Top up bond collateral (bond lifecycle shortfall restore)
  // =========================================================================
  router.post('/topup', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const actingWallet = req.agentWallet;
      if (!actingWallet) {
        res.status(401).json({ error: 'Agent wallet authentication required' });
        return;
      }
      const walletId = actingWallet.id;
      const rateLimit = await cache.checkRateLimitStrict(`rl:bond:topup:${walletId}`, 5, 60);
      if (rateLimit.error === 'rate_limit_unavailable') {
        res.status(503).json({ error: 'rate_limit_unavailable' });
        return;
      }
      if (!rateLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded', retry_after: rateLimit.retryAfter });
        return;
      }

      const body = req.body as TopUpBondRequest;
      const bond = await topUpBond(deps, walletId, actingWallet, body);

      await enqueueAgentBankEvent(deps.db, { walletId, eventType: 'bond_topped_up', transactionAmount: 0, entityId: bond.bond_id, entityType: 'bond' });

      res.json({
        bond_id: bond.bond_id,
        status: bond.status,
        collateral_atomic: bond.collateral_atomic,
        last_topup_at: bond.last_topup_at,
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // POST /withdraw - Withdraw bond
  // =========================================================================
  router.post('/withdraw', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const actingWallet = req.agentWallet;
      if (!actingWallet) {
        res.status(401).json({ error: 'Agent wallet authentication required' });
        return;
      }
      const walletId = actingWallet.id;
      const rateLimit = await cache.checkRateLimitStrict(`rl:bond:withdraw:${walletId}`, 5, 60);
      if (rateLimit.error === 'rate_limit_unavailable') {
        res.status(503).json({ error: 'rate_limit_unavailable' });
        return;
      }
      if (!rateLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded', retry_after: rateLimit.retryAfter });
        return;
      }

      const body = req.body as WithdrawBondRequest;
      const bond = await withdrawBond(deps, walletId, actingWallet, body);

      await enqueueAgentBankEvent(deps.db, { walletId, eventType: 'bond_withdrawn', transactionAmount: 0, entityId: bond.bond_id, entityType: 'bond' });

      res.json({
        bond_id: bond.bond_id,
        status: bond.status,
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // GET /:agentId - Get bond details for an agent
  // =========================================================================
  // NOTE: Single-segment route. Express won't shadow the other GET handlers
  // because they're all two-segment (`/claim/:claimId`, `/requirements/:level`,
  // `/status/:agentId`). A GET to `/post`, `/renew`, or `/withdraw` would
  // fall through to this handler treating the verb as an agent ID and
  // return a clean 404 from getBondByAgent - acceptable for a misuse case.
  router.get('/:agentId', async (req: Request, res: Response) => {
    try {
      const { agentId } = req.params;

      // First try to find by wallet ID (agent_wallet_id)
      const bond = await getBondByAgent(deps, agentId);
      if (!bond) {
        // Try by bond_id
        try {
          const details = await getBondDetails(deps, agentId);
          res.json(details);
          return;
        } catch {
          res.status(404).json({ error: 'No bond found for this agent' });
          return;
        }
      }

      const details = await getBondDetails(deps, bond.bond_id);
      res.json(details);
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // POST /claim/file - File a claim against an agent's bond
  // =========================================================================
  router.post('/claim/file', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const actingWallet = req.agentWallet;
      if (!actingWallet) {
        res.status(401).json({ error: 'Agent wallet authentication required' });
        return;
      }
      const walletId = actingWallet.id;
      const rateLimit = await cache.checkRateLimitStrict(`rl:claim:file:${walletId}`, 3, 60);
      if (rateLimit.error === 'rate_limit_unavailable') {
        res.status(503).json({ error: 'rate_limit_unavailable' });
        return;
      }
      if (!rateLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded', retry_after: rateLimit.retryAfter });
        return;
      }

      const body = req.body as FileClaimRequest;
      const claim = await fileClaim(deps, walletId, actingWallet, body);

      // notify the RESPONDENT (their bond is now under claim); the claimant
      // is the actor (reconciled). entity = claim_id.
      await enqueueAgentBankEvent(deps.db, {
        walletId,
        eventType: 'bond_claim_filed',
        transactionAmount: 0,
        entityId: claim.claim_id,
        entityType: 'bond',
        data: { bond_id: claim.bond_id },
        ...(claim.respondent_wallet_id
          ? twoPartyTargeting(walletId, claim.respondent_wallet_id)
          : {}),
      });

      res.status(201).json({
        claim_id: claim.claim_id,
        bond_id: claim.bond_id,
        status: claim.status,
        respondent_wallet_id: claim.respondent_wallet_id,
        filing_fee_pvt: claim.filing_fee_pvt,
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // POST /claim/:claimId/resolution - Observe the on-chain Court settlement
  //
  // agent directory: the SDK posts the resolving tx (the majority-landing on-chain
  // CourtV2.castBondClaimVote or the permissionless finalizeBondClaim), or
  // posts nothing and the relay recovers the BondSlashed/ClaimDismissed log
  // bounded from the filing block. Everything caller-supplied is a POINTER:
  // the verified on-chain EVENT decides the verdict, the machine's economic
  // filed→upheld|dismissed gate runs inside the resolution transaction, and
  // the backend never signs or drives a slash. Idempotent: re-posting a
  // recorded settlement returns the resolved claim with no second PE.
  // =========================================================================
  router.post('/claim/:claimId/resolution', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const actingWallet = req.agentWallet;
      if (!actingWallet) {
        res.status(401).json({ error: 'Agent wallet authentication required' });
        return;
      }
      const rateLimit = await cache.checkRateLimitStrict(`rl:claim:resolution:${actingWallet.id}`, 5, 60);
      if (rateLimit.error === 'rate_limit_unavailable') {
        res.status(503).json({ error: 'rate_limit_unavailable' });
        return;
      }
      if (!rateLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded', retry_after: rateLimit.retryAfter });
        return;
      }

      const { tx_hash } = req.body ?? {};
      if (tx_hash !== undefined && (typeof tx_hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(tx_hash))) {
        res.status(400).json({ error: 'tx_hash must be a 0x-prefixed 32-byte hex string when provided' });
        return;
      }

      const claim = await observeBondClaimSettlement(deps, {
        claimId: req.params.claimId,
        ...(tx_hash ? { txHash: tx_hash } : {}),
        actingWallet,
      });

      // notify BOTH parties (claimant + respondent) of a terminal claim.
      // bond_claim_resolved on any terminal state; bond_slashed additionally when
      // the claim was UPHELD (the respondent's bond was slashed). notify-only.
      if ((claim.status === 'upheld' || claim.status === 'dismissed' || claim.status === 'expired')
        && claim.claimant_wallet_id && claim.respondent_wallet_id) {
        const resolvedData = {
          bond_id: claim.bond_id,
          verdict: claim.status,
          ...(claim.slash_amount_pvt ? { slash_amount_pvt: claim.slash_amount_pvt } : {}),
        };
        await enqueueAgentBankEvent(deps.db, {
          walletId: claim.claimant_wallet_id,
          eventType: 'bond_claim_resolved',
          transactionAmount: 0,
          entityId: claim.claim_id,
          entityType: 'bond',
          data: resolvedData,
          notifyOnly: true,
          ...twoPartyTargeting(claim.claimant_wallet_id, claim.respondent_wallet_id),
        });
        if (claim.status === 'upheld') {
          await enqueueAgentBankEvent(deps.db, {
            walletId: claim.respondent_wallet_id,
            eventType: 'bond_slashed',
            transactionAmount: 0,
            entityId: claim.claim_id,
            entityType: 'bond',
            data: resolvedData,
            notifyOnly: true,
            ...twoPartyTargeting(claim.claimant_wallet_id, claim.respondent_wallet_id),
          });
        }
      }

      res.json({
        claim_id: claim.claim_id,
        bond_id: claim.bond_id,
        status: claim.status,
        fee_outcome: claim.fee_outcome ?? null,
        onchain_settlement: claim.onchain_settlement ?? null,
        resolution_tx_hash: claim.resolution_tx_hash ?? null,
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // GET /claim/:claimId - Get claim status
  // =========================================================================
  router.get('/claim/:claimId', async (req: Request, res: Response) => {
    try {
      const claim = await getClaimDetails(deps, req.params.claimId);
      res.json(claim);
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // GET /requirements/:autonomyLevel - Get bond requirements
  // =========================================================================
  router.get('/requirements/:autonomyLevel', async (req: Request, res: Response) => {
    try {
      const level = parseInt(req.params.autonomyLevel, 10);
      if (level !== 2 && level !== 3) {
        res.status(400).json({ error: 'autonomyLevel must be 2 or 3' });
        return;
      }

      // If authenticated, include trust discount
      let walletId: string | undefined;
      if (req.agentWallet?.id) {
        walletId = req.agentWallet.id;
      }

      const requirements = await getRequiredBond(deps, level as 2 | 3, walletId);
      res.json({
        autonomy_level: level,
        ...requirements,
        filing_fee_pvt: SAFETY_LIMITS.BOND_CLAIM_FILING_FEE_PVT,
        claims_processing_fee_pvt: SAFETY_LIMITS.BOND_SLASH_PROCESSING_FEE_PVT,
        deposit_burn_pct: 2,
        deposit_fee_pct: 1,
        renewal_burn_pct: 1,
        renewal_fee_pct: 0.5,
        renewal_period_days: SAFETY_LIMITS.BOND_RENEWAL_PERIOD_DAYS,
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // GET /status/:agentId - Check bond status
  // =========================================================================
  router.get('/status/:agentId', async (req: Request, res: Response) => {
    try {
      const status = await checkBondStatus(deps, req.params.agentId);
      res.json(status);
    } catch (error) {
      handleError(res, error);
    }
  });

  return router;
}
