/**
 * Commons institutions - Court API Routes (Phase 2)
 *
 * Endpoints:
 *   POST   /opt-in                         - Opt in as arbitrator
 *   POST   /opt-out                        - Opt out of arbitration
 *   GET    /arbitrators                    - List active arbitrators
 *   GET    /dispute/:escrow_id             - Get dispute details
 *   POST   /dispute/:escrow_id/vote        - Cast vote on dispute
 *   GET    /history/:wallet_id             - Arbitrator history
 *   POST   /dispute/:escrow_id/assign-panel - Admin assigns panel
 */

import { Router, Request, Response } from 'express';
import { createAgentAuthMiddleware } from './middleware/agent-auth';
import { safeSecretCompare } from './middleware/admin-secret';
import type { AgentBankDeps } from '../core/agent-bank/types';
import { parsePresentedPeProofs } from '../core/meter/cited-act';

/** At most this many presented PE proofs ride one Court request. */
const MAX_PRESENTED_PE_PROOFS = 50;
import {
  optInAsArbitrator,
  optOutAsArbitrator,
  listArbitrators,
  selectAndAssignPanel,
  castVote,
  getDispute,
  getArbitratorHistory,
  fileGeneralDispute,
  submitEvidence,
  assignGeneralDisputePanel,
  castGeneralDisputeVote,
  getGeneralDispute,
  listMyGeneralDisputes,
} from '../core/agent-bank/court';
import { ValidationError, NotFoundError, ForbiddenError, getEscrow } from '../core/agent-bank/escrow';
import { enqueueAgentBankEvent, twoPartyTargeting } from '../core/agent-bank/event-outbox';

function handleError(res: Response, error: unknown): void {
  if (error instanceof ValidationError) {
    res.status(400).json({ error: error.message });
  } else if (error instanceof NotFoundError) {
    res.status(404).json({ error: error.message });
  } else if (error instanceof ForbiddenError) {
    res.status(403).json({ error: error.message });
  } else {
    console.error('[Court] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export function createAgentCourtRouter(deps: AgentBankDeps): Router {
  const { db, cache } = deps;
  const router = Router();
  const authenticateAgent = createAgentAuthMiddleware(db);

  // =========================================================================
  // POST /opt-in - Opt in as arbitrator
  // =========================================================================
  router.post('/opt-in', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const walletId = req.agentWallet?.id;
      if (!walletId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const rateLimit = await cache.checkRateLimit(`rl:court:opt-in:${walletId}`, 5, 60);
      if (!rateLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded', retry_after: rateLimit.retryAfter });
        return;
      }

      const arbitrator = await optInAsArbitrator(deps, walletId);

      res.status(201).json({
        wallet_id: arbitrator.wallet_id,
        is_active: arbitrator.is_active,
        completed_escrows: arbitrator.completed_escrows,
        total_cases: arbitrator.total_cases,
        majority_votes: arbitrator.majority_votes,
        minority_votes: arbitrator.minority_votes,
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // POST /opt-out - Opt out of arbitration
  // =========================================================================
  router.post('/opt-out', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const walletId = req.agentWallet?.id;
      if (!walletId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      await optOutAsArbitrator(deps, walletId);
      res.json({ status: 'opted_out' });
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // GET /arbitrators - List active arbitrators
  // =========================================================================
  router.get('/arbitrators', authenticateAgent, async (_req: Request, res: Response) => {
    try {
      const arbitrators = await listArbitrators(deps);
      res.json({
        arbitrators: arbitrators.map(a => ({
          wallet_id: a.wallet_id,
          completed_escrows: a.completed_escrows,
          total_cases: a.total_cases,
          majority_votes: a.majority_votes,
        })),
        count: arbitrators.length,
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // GET /dispute/:escrow_id - Get dispute details
  // =========================================================================
  router.get('/dispute/:escrow_id', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const dispute = await getDispute(deps, req.params.escrow_id);
      // F47/F64 (S2 2026-09-10): party/panel-scope the by-id read. The dispute
      // document exposes the arbitrator panel identities and the LIVE vote tally
      // while voting is still open, so a non-party (or a disputing counterparty)
      // could see who is on the panel and how they voted before the deadline.
      // Allow only a seated arbitrator (panel) or an escrow party; 404 on
      // mismatch so a non-party cannot confirm existence.
      const callerId = req.agentWallet?.id;
      let authorized = !!callerId && dispute.panel.includes(callerId);
      if (!authorized && callerId) {
        // The dispute doc does not carry the escrow parties; load the escrow
        // (dispute id === escrow id) to check depositor/recipient membership.
        const escrow = await getEscrow(deps, req.params.escrow_id).catch(() => null);
        authorized = !!escrow
          && (callerId === escrow.depositor_wallet_id || callerId === escrow.recipient_wallet_id);
      }
      if (!authorized) {
        throw new NotFoundError('Court dispute not found');
      }
      res.json(dispute);
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // POST /dispute/:escrow_id/vote - Cast vote
  // =========================================================================
  router.post('/dispute/:escrow_id/vote', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const actingWallet = req.agentWallet;
      const walletId = actingWallet?.id;
      if (!actingWallet || !walletId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const { release_to_recipient, tx_hash } = req.body;
      if (typeof release_to_recipient !== 'boolean') {
        res.status(400).json({ error: 'release_to_recipient (boolean) is required' });
        return;
      }
      // Phase 2.15: tx_hash is OPTIONAL. When the SDK has already submitted
      // the on-chain CourtV2.castVote() it can pass the hash here so the
      // relay can verify and mark the vote `confirmed`. Otherwise the vote
      // enters `pending_chain` and the SDK will follow up later.
      if (tx_hash !== undefined && (typeof tx_hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(tx_hash))) {
        res.status(400).json({ error: 'tx_hash must be a 0x-prefixed 32-byte hex string when provided' });
        return;
      }

      const dispute = await castVote(deps, req.params.escrow_id, walletId, actingWallet, release_to_recipient, tx_hash);

      // Fire-and-forget event processing if resolved
      if (dispute.status === 'resolved') {
        // notify the ESCROW PARTIES of the verdict (not only the voting
        // arbitrator). Read the escrow for its two parties; notify-only.
        try {
          const escSnap = await deps.db.collection('escrows').doc(dispute.escrow_id).get();
          const esc = escSnap.data() as { depositor_wallet_id?: string; recipient_wallet_id?: string } | undefined;
          if (esc?.depositor_wallet_id && esc?.recipient_wallet_id) {
            await enqueueAgentBankEvent(deps.db, {
              walletId: esc.depositor_wallet_id,
              eventType: 'court_verdict',
              transactionAmount: 0,
              entityId: dispute.escrow_id,
              entityType: 'court',
              data: { verdict: dispute.verdict ?? null },
              notifyOnly: true,
              ...twoPartyTargeting(esc.depositor_wallet_id, esc.recipient_wallet_id),
            });
          }
        } catch (err) {
          console.error('[Court] escrow-party verdict notify failed:', err);
        }
        // The voting arbitrator still gets their own reconciled court_verdict.
        await enqueueAgentBankEvent(deps.db, {
          walletId,
          eventType: 'court_verdict',
          transactionAmount: 0,
          entityId: dispute.escrow_id,
          entityType: 'court',
          data: { verdict: dispute.verdict ?? null, role: 'arbitrator' },
        });
      }

      res.json({
        escrow_id: dispute.escrow_id,
        status: dispute.status,
        votes: dispute.votes,
        verdict: dispute.verdict,
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // GET /history/:wallet_id - Arbitrator case history
  // =========================================================================
  router.get('/history/:wallet_id', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      if (req.agentWallet && req.agentWallet.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }

      const history = await getArbitratorHistory(deps, wallet_id);
      res.json({
        arbitrator: {
          wallet_id: history.arbitrator.wallet_id,
          total_cases: history.arbitrator.total_cases,
          majority_votes: history.arbitrator.majority_votes,
          minority_votes: history.arbitrator.minority_votes,
        },
        disputes: history.disputes,
        count: history.disputes.length,
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // POST /dispute/:escrow_id/assign-panel - Admin assigns panel
  // =========================================================================
  router.post('/dispute/:escrow_id/assign-panel', async (req: Request, res: Response) => {
    try {
      if (!safeSecretCompare(req.headers['x-admin-secret'], process.env.AGENT_BANK_ADMIN_SECRET)) {
        res.status(401).json({ error: 'admin_auth_failed' });
        return;
      }

      const dispute = await selectAndAssignPanel(deps, req.params.escrow_id);

      res.status(201).json({
        escrow_id: dispute.escrow_id,
        panel: dispute.panel,
        voting_deadline: new Date(dispute.voting_deadline).toISOString(),
        status: dispute.status,
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // POST /dispute/general - File a general dispute
  // =========================================================================
  router.post('/dispute/general', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const actingWallet = req.agentWallet;
      const walletId = actingWallet?.id;
      if (!actingWallet || !walletId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      // Strict (fail-closed): filing a dispute starts a Court process that
      // can slash bonds and resolve escrows. Better to 503 briefly than to
      // allow unbounded dispute spam during a Redis outage.
      const rateLimit = await cache.checkRateLimitStrict(`rl:court:file:${walletId}`, 5, 60);
      if (!rateLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded', retry_after: rateLimit.retryAfter });
        return;
      }

      const { respondent_wallet_id, subject_pe_ids, description, requested_remedy, bond_claim_id } = req.body;
      if (!respondent_wallet_id || !Array.isArray(subject_pe_ids) || !description || !requested_remedy) {
        res.status(400).json({ error: 'respondent_wallet_id, subject_pe_ids[], description, and requested_remedy are required' });
        return;
      }
      // Optional: escalate a bond claim to the Court. The verdict drives the
      // claim's resolution (resolveBondClaim) on panel majority.
      if (bond_claim_id !== undefined && typeof bond_claim_id !== 'string') {
        res.status(400).json({ error: 'bond_claim_id must be a string when provided' });
        return;
      }
      // PE METER: a subject PE older than its 31-day act key is cited with its PE + inclusion proof.
      const subjectPeProofs = parsePresentedPeProofs(req.body?.pe_proofs, MAX_PRESENTED_PE_PROOFS);
      if (subjectPeProofs === null) {
        res.status(400).json({ error: 'pe_proofs must be an array of { pe_id, envelope_hash, pe, inclusion }' });
        return;
      }

      const result = await fileGeneralDispute(deps, {
        filedBy: walletId,
        respondent: respondent_wallet_id,
        subjectPeIds: subject_pe_ids,
        description,
        requestedRemedy: requested_remedy,
        actingWallet,
        subjectPeProofs,
        ...(bond_claim_id ? { bondClaimId: bond_claim_id } : {}),
      });

      res.status(201).json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // POST /dispute/:dispute_id/evidence - Submit evidence
  // =========================================================================
  router.post('/dispute/:dispute_id/evidence', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const actingWallet = req.agentWallet;
      const walletId = actingWallet?.id;
      if (!actingWallet || !walletId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const { evidence_pe_ids } = req.body;
      if (!Array.isArray(evidence_pe_ids) || !evidence_pe_ids.length) {
        res.status(400).json({ error: 'evidence_pe_ids[] is required' });
        return;
      }
      const evidencePeProofs = parsePresentedPeProofs(req.body?.pe_proofs, MAX_PRESENTED_PE_PROOFS);
      if (evidencePeProofs === null) {
        res.status(400).json({ error: 'pe_proofs must be an array of { pe_id, envelope_hash, pe, inclusion }' });
        return;
      }

      await submitEvidence(deps, {
        disputeId: req.params.dispute_id,
        submittedBy: walletId,
        evidencePeIds: evidence_pe_ids,
        actingWallet,
        evidencePeProofs,
      });

      res.json({ status: 'evidence_submitted' });
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // GET /disputes/my - List my general disputes
  // =========================================================================
  router.get('/disputes/my', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const walletId = req.agentWallet?.id;
      if (!walletId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const disputes = await listMyGeneralDisputes(deps, walletId);
      res.json({ disputes, count: disputes.length });
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // GET /dispute/general/:dispute_id - Get general dispute details
  // =========================================================================
  router.get('/dispute/general/:dispute_id', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const walletId = req.agentWallet?.id;
      if (!walletId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const dispute = await getGeneralDispute(deps, req.params.dispute_id);

      // Only parties, arbitrators, or admin can view
      const isParty = walletId === dispute.filed_by || walletId === dispute.respondent;
      const isArbitrator = dispute.panel_wallet_ids?.includes(walletId);
      if (!isParty && !isArbitrator) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }

      res.json(dispute);
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // POST /dispute/general/:dispute_id/vote - Cast vote on general dispute
  // =========================================================================
  router.post('/dispute/general/:dispute_id/vote', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const actingWallet = req.agentWallet;
      const walletId = actingWallet?.id;
      if (!actingWallet || !walletId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const { resolution } = req.body;
      const validResolutions = ['upheld', 'dismissed', 'partial', 'escalated_external'];
      if (!resolution || !validResolutions.includes(resolution)) {
        res.status(400).json({ error: `resolution must be one of: ${validResolutions.join(', ')}` });
        return;
      }

      const dispute = await castGeneralDisputeVote(deps, req.params.dispute_id, walletId, actingWallet, resolution);

      if (dispute.status === 'resolved') {
        // notify BOTH dispute parties (filer + respondent), not only the
        // voting arbitrator; notify-only.
        if (dispute.filed_by && dispute.respondent) {
          await enqueueAgentBankEvent(deps.db, {
            walletId: dispute.filed_by,
            eventType: 'court_verdict',
            transactionAmount: 0,
            entityId: dispute.dispute_id,
            entityType: 'court',
            data: { resolution: dispute.resolution ?? null },
            notifyOnly: true,
            ...twoPartyTargeting(dispute.filed_by, dispute.respondent),
          });
        }
        // The voting arbitrator still gets their own reconciled court_verdict.
        await enqueueAgentBankEvent(deps.db, {
          walletId,
          eventType: 'court_verdict',
          transactionAmount: 0,
          entityId: dispute.dispute_id,
          entityType: 'court',
          data: { resolution: dispute.resolution ?? null, role: 'arbitrator' },
        });
      }

      res.json({
        dispute_id: dispute.dispute_id,
        status: dispute.status,
        votes: dispute.votes,
        resolution: dispute.resolution,
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // =========================================================================
  // POST /dispute/general/:dispute_id/assign-panel - Admin assigns panel
  // =========================================================================
  router.post('/dispute/general/:dispute_id/assign-panel', async (req: Request, res: Response) => {
    try {
      if (!safeSecretCompare(req.headers['x-admin-secret'], process.env.AGENT_BANK_ADMIN_SECRET)) {
        res.status(401).json({ error: 'admin_auth_failed' });
        return;
      }

      const dispute = await assignGeneralDisputePanel(deps, req.params.dispute_id);

      res.status(201).json({
        dispute_id: dispute.dispute_id,
        panel: dispute.panel_wallet_ids,
        status: dispute.status,
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  return router;
}
