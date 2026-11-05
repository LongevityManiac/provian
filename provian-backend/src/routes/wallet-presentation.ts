/**
 * Human first-party burn + present (burn-to-present, human side).
 *
 * POST /v1/wallet/burn/record - record a VERIFIED PVT burn the human broadcast
 * from their OWN first-party wallet (the human
 * analogue of the agent burn/record path).
 * POST /v1/wallet/present - produce a presentation (pe_fact or reputation)
 * from the human's first-party identity.
 * POST /v1/wallet/vouch - a person vouches for a person or agent,
 * riding their live reputation presentation to the
 * vouchee (the same burn + floor agents use).
 * GET /v1/wallet/vouches - the vouches this person has staked.
 *
 * Human/agent SYMMETRY: this is the exact parallel of the agent routes on the
 * agent-wallet router, on the SHARED burn substrate + presentation primitive. The
 * only differences are (a) human wallet auth (`req.user`) instead of agent API
 * auth, (b) the burn's `expectedFrom` binds to the human's first-party address,
 * and (c) the human PoP is EIP-191. Everything downstream is identical.
 *
 * Auth: the human wallet `authenticate` middleware (request-bound HMAC) is applied
 * at the mount (`app.use('/v1/wallet', authenticate,...)`), so every route here is
 * wallet-authed and `req.user` is always set. Reuses the app's one wallet-auth path.
 */

import { issueWalletChallengeFromRequest } from '../core/presentation/challenge-issuer';
import { Router, type Request, type Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import { recordFirstPartyBurn, BURN_RECORD_MAX_WAIT_MS } from '../core/presentation/burn-record';
import { resolveHumanWallet, resolveHumanPrincipal } from '../core/presentation/principal';
import { computeActorVocabulary, isVocabularyUnavailableError, selfViewOfVocabulary, STANDING_FIELD_PREFIX } from '../core/presentation/vocabulary';
import { listPendingRequestsForHuman, resolveApprovalRequest } from '../core/pe/human-approval-request-store';
import { toHumanFacingRequest as toHumanFacingPresentationRequest } from '../core/pe/presentation-request';
import {
  listPendingRequestsForHuman as listPendingPresentationRequestsForHuman,
  challengePresentationRequest,
  recordVerdictForRequest,
  declinePresentationRequest,
} from '../core/pe/presentation-request-store';
import { registerAppAttestKey } from '../core/hardware/app-attest-register';
import { firestoreAppAttestKeyStore } from '../core/hardware/app-attest-keys';
import {
  producePresentationFromRequest,
  preflightPresentationFromRequest,
} from '../core/presentation/service';
import { encodePresentationToken } from '../core/presentation/types';
import { readHandshakeState } from '../core/rail/handshake';
import { bumpOpsCounter } from '../core/observability/ops-counters';
import { listAgentRecoveryAlertsForHuman } from '../core/agent-recovery-escrow';
import { publishHumanRecoveryAnchor, readHumanRecoveryAnchor } from '../core/human-recovery-anchor';
import { stakeHumanVouch, vouchesByVoucher } from '../core/commons/burn-vouch';
import type { AgentBankDeps } from '../core/agent-bank/types';

export interface WalletPresentationDeps {
  readonly db: Firestore;
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

export function createWalletPresentationRouter(deps: WalletPresentationDeps): Router {
  const router = Router();

  // §2.9 — POST /app-attest/register: attest this phone's Secure-Enclave key ONCE (Apple App Attest
  // attestation object verified against the pinned Apple root, nonce = the canonical registration
  // binding over the key id); every later mobile PE carries an assertion from it → hardware_rooted.
  router.post('/app-attest/register', async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user?.id;
      if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
      const result = await registerAppAttestKey(firestoreAppAttestKeyStore(deps.db), {
        userId,
        keyId: (req.body as { key_id?: unknown }).key_id,
        attestation: (req.body as { attestation?: unknown }).attestation,
        appleAppId: process.env.APPLE_APP_ATTEST_APP_ID ?? null,
        nowMs: Date.now(),
      });
      // one attested key backs ONE account — a key already bound to another account is 409.
      if (!result.ok) { res.status(result.status ?? 400).json({ error: 'app_attest_rejected', reason: result.reason }); return; }
      res.status(result.created ? 201 : 200).json({ registered: true, created: result.created, signer_key_sha256: result.signer_key_sha256, environment: result.environment });
    } catch (error) {
      console.error('[WalletPresentation] app-attest register error:', error);
      res.status(500).json({ error: 'Failed to register App Attest key' });
    }
  });

  // POST /vouch: a person vouches for any person or agent. Rides the person's live
  // REPUTATION presentation to the vouchee (one burn, one benefit — the vouch never burns again).
  // The excluded pair is refused HERE, at the relay: a person cannot vouch for their own
  // beneficiary-linked agent (and an agent cannot vouch for its linked human — agent route).
  router.post('/vouch', async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user?.id;
      if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
      const body = (req.body ?? {}) as { target_id?: unknown; note?: unknown };
      const result = await stakeHumanVouch(deps as unknown as AgentBankDeps, {
        userId,
        targetId: body.target_id,
        note: body.note,
      });
      if (!result.ok) {
        res.status(result.status).json({ error: result.error, ...(result.reason ? { reason: result.reason } : {}) });
        return;
      }
      const v = result.vouch;
      res.status(201).json({
        vouch_id: v.vouch_id,
        target_id: v.target_party_id ?? v.target_agent_id,
        target_kind: v.target_kind ?? null,
        note: v.note,
        backing_burn_id: v.backing_burn_id,
        backing_presentation_id: v.backing_presentation_id,
        created_at: v.created_at,
      });
    } catch (error) {
      console.error('[WalletPresentation] vouch error:', error);
      res.status(500).json({ error: 'Failed to stake vouch' });
    }
  });

  // GET /vouches: the vouches this person has staked (for the profile "Vouched" state).
  router.get('/vouches', async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user?.id;
      if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
      const vouches = await vouchesByVoucher(deps as unknown as AgentBankDeps, userId);
      res.json({
        vouches: vouches.map((v) => ({
          vouch_id: v.vouch_id,
          target_id: v.target_party_id ?? v.target_agent_id,
          target_kind: v.target_kind ?? null,
          note: v.note,
          backing_burn_id: v.backing_burn_id,
          created_at: v.created_at,
        })),
      });
    } catch (error) {
      console.error('[WalletPresentation] vouches list error:', error);
      res.status(500).json({ error: 'Failed to list vouches' });
    }
  });

  // GET /agent-recovery-alerts — linked agents needing this human's recovery/re-key, for
  // the app's attention center. Wallet auth. Never throws; [] on any read failure.
  router.get('/agent-recovery-alerts', async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user?.id;
      if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
      const alerts = await listAgentRecoveryAlertsForHuman(deps.db, userId);
      res.json({ alerts });
    } catch (error) {
      console.error('[WalletPresentation] agent-recovery-alerts error:', error);
      res.json({ alerts: [] });
    }
  });

  // POST /burn/record — record a verified first-party human PVT burn.
  router.post('/burn/record', async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      const wallet = await resolveHumanWallet(deps.db, userId);
      if (!wallet.ok) {
        res.status(wallet.status).json({ error: wallet.error });
        return;
      }
      const { tx_hash, chain, amount_atomic, await_finality } = (req.body ?? {}) as Record<string, unknown>;
      const result = await recordFirstPartyBurn(deps, {
        walletId: wallet.walletId,
        address: wallet.address,
        ownerKind: 'human',
        ownerId: userId,
        txHash: String(tx_hash ?? ''),
        chain: String(chain ?? ''),
        amountAtomic: String(amount_atomic ?? ''),
        // hold the request open until the burn is mined and accepted at inclusion
        // instead of the phone polling for it. Finality is then the relay's job.
        waitMs: await_finality === true ? BURN_RECORD_MAX_WAIT_MS : 0,
      });
      if (!result.ok) {
        // Ops observability (Part D): count a burn-replay 409 (the same tx_hash presented
        // twice). Structure-only — the counter carries no tx or wallet identity.
        if (result.status === 409) bumpOpsCounter('burn.replay_409');
        res.status(result.status).json(
          result.reason ? { error: result.error, reason: result.reason } : { error: result.error },
        );
        return;
      }
      res.json({
        burn_id: result.burnId,
        tx_hash,
        verified: result.verified,
        // 'provisional' = accepted at inclusion, 12-block finality check pending
        // (a burn that fails it is revoked with its benefits); 'final' = past finality.
        ...(result.finality ? { finality: result.finality } : {}),
        ...(result.idempotent ? { idempotent: true } : {}),
      });
    } catch (error) {
      console.error('[WalletPresentation] burn record error:', error);
      res.status(500).json({ error: 'Failed to record burn' });
    }
  });

  // POST /present — produce a burn-backed presentation from the human's identity.
  // §2.5: the presenter's own live vocabulary — what a reputation presentation would disclose.
  router.get('/vocabulary', async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      const principal = await resolveHumanPrincipal(deps.db, userId);
      if (!principal.ok) {
        res.status(principal.status).json({ error: principal.error });
        return;
      }
      const facts = await computeActorVocabulary({ db: deps.db }, principal.principal);
      res.json({ ...selfViewOfVocabulary(facts), standing_prefix: STANDING_FIELD_PREFIX });
    } catch (error) {
      // item 2: a source that could not be read is unavailable — never a zero.
      if (isVocabularyUnavailableError(error)) {
        res.status(503).json({ error: 'vocabulary_source_unavailable', source: error.source });
        return;
      }
      console.error('[WalletPresentation] vocabulary error:', error);
      res.status(500).json({ error: 'Failed to compute vocabulary' });
    }
  });

  // Item 11 — the PUBLIC half of this human's agent-recovery key,
  // published once from the phone (EIP-191-signed by the wallet key). Fleet codes carry
  // it and un-escrowed agents seal to it; only the phone holds the secret half.
  router.get('/recovery-anchor', async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user?.id;
      if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
      res.json({ recovery_anchor_pubkey: await readHumanRecoveryAnchor(deps.db, userId) });
    } catch (error) {
      console.error('[WalletPresentation] recovery-anchor read error:', error);
      res.status(500).json({ error: 'Failed to read recovery anchor' });
    }
  });

  router.put('/recovery-anchor', async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user?.id;
      if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
      const wallet = await resolveHumanWallet(deps.db, userId);
      if (!wallet.ok) { res.status(wallet.status).json({ error: wallet.error }); return; }
      const body = (req.body ?? {}) as { recovery_anchor_pubkey?: unknown; signature?: unknown };
      const result = await publishHumanRecoveryAnchor(deps.db, {
        userId, walletAddress: wallet.address, pubkey: body.recovery_anchor_pubkey, signature: body.signature, now: Date.now(),
      });
      if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ published: true, changed: result.changed });
    } catch (error) {
      console.error('[WalletPresentation] recovery-anchor publish error:', error);
      res.status(500).json({ error: 'Failed to publish recovery anchor' });
    }
  });

  // §2.1 — the human's inbox of agent-initiated approval requests. WITH the
  // description text (Tier-3: only this authenticated human reads it; never public).
  router.get('/approval-requests', async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user?.id;
      if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
      const rows = await listPendingRequestsForHuman(deps.db, userId, Date.now());
      res.json({
        requests: rows.map((r) => ({
          request_id: r.request_id,
          agent_wallet_id: r.agent_wallet_id,
          action_description: r.action_description, // shown to THIS human so they can approve it
          action_description_sha256: r.action_description_sha256, // the anchor they sign into the PE
          subject_pe_id: r.subject_pe_id,
          created_at_ms: r.created_at_ms,
          expires_at_ms: r.expires_at_ms,
        })),
      });
    } catch (error) {
      console.error('[WalletPresentation] approval-requests error:', error);
      res.status(500).json({ error: 'Failed to list approval requests' });
    }
  });

  // §2.1 — mark a request satisfied after the human's biometric human_approval PE
  // seals. The app calls this with the sealed approval PE id + decision.
  router.post('/approval-requests/:request_id/resolve', async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user?.id;
      if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
      const approvalPeId = typeof req.body?.approval_pe_id === 'string' ? req.body.approval_pe_id.trim() : '';
      const decision = req.body?.decision;
      if (!approvalPeId) { res.status(400).json({ error: 'approval_pe_id is required' }); return; }
      if (decision !== 'approved' && decision !== 'rejected') { res.status(400).json({ error: 'decision must be approved|rejected' }); return; }
      const result = await resolveApprovalRequest(deps.db, {
        requestId: req.params.request_id, humanUserId: userId, approvalPeId, decision, nowMs: Date.now(),
      });
      if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ request_id: result.record.request_id, status: result.record.status, satisfied_by_pe_id: result.record.satisfied_by_pe_id });
    } catch (error) {
      console.error('[WalletPresentation] resolve approval error:', error);
      res.status(500).json({ error: 'Failed to resolve approval request' });
    }
  });

  // §the human's inbox of remote presentation requests that need THEIR
  // action (`requested` → compose a challenge; `presented` → record a verdict).
  // WITH the Tier-3 note (only this authenticated human reads it; never public).
  router.get('/presentation-requests', async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user?.id;
      if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
      const rows = await listPendingPresentationRequestsForHuman(deps.db, userId, Date.now());
      res.json({ requests: rows.map(toHumanFacingPresentationRequest) });
    } catch (error) {
      console.error('[WalletPresentation] presentation-requests error:', error);
      res.status(500).json({ error: 'Failed to list presentation requests' });
    }
  });

  // §the human (verifier role) composes the challenge (audience/challenge/
  // predicates). Human-owned; 409 if the request is not `requested`.
  router.post('/presentation-requests/:request_id/challenge', async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user?.id;
      if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
      const result = await challengePresentationRequest(deps.db, {
        requestId: req.params.request_id,
        humanUserId: userId,
        audience: req.body?.audience,
        challenge: req.body?.challenge,
        predicates: req.body?.predicates,
        nowMs: Date.now(),
      });
      if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ request: toHumanFacingPresentationRequest(result.record) });
    } catch (error) {
      console.error('[WalletPresentation] presentation-request challenge error:', error);
      res.status(500).json({ error: 'Failed to record challenge' });
    }
  });

  // §the human records the verdict after running the EXISTING
  // /v1/present/verify. Human-owned; 409 if the request is not `presented`.
  router.post('/presentation-requests/:request_id/verify', async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user?.id;
      if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
      const verdict = req.body?.verdict;
      if (verdict !== 'valid' && verdict !== 'invalid') {
        res.status(400).json({ error: 'verdict must be valid|invalid' }); return;
      }
      const result = await recordVerdictForRequest(deps.db, {
        requestId: req.params.request_id,
        humanUserId: userId,
        verdict,
        predicateResults: req.body?.predicate_results,
        nowMs: Date.now(),
      });
      if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ request: toHumanFacingPresentationRequest(result.record) });
    } catch (error) {
      console.error('[WalletPresentation] presentation-request verify error:', error);
      res.status(500).json({ error: 'Failed to record verdict' });
    }
  });

  // §the human declines a remote presentation request (from any
  // non-terminal status). Human-owned; 409 from a terminal status.
  router.post('/presentation-requests/:request_id/decline', async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user?.id;
      if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
      const result = await declinePresentationRequest(deps.db, {
        requestId: req.params.request_id,
        humanUserId: userId,
      });
      if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ request: toHumanFacingPresentationRequest(result.record) });
    } catch (error) {
      console.error('[WalletPresentation] presentation-request decline error:', error);
      res.status(500).json({ error: 'Failed to decline presentation request' });
    }
  });

  // a human requester's SIGNED challenge. The relay authenticated this wallet, so it signs the
  // envelope with the Provian presentation key: requester = { type:'wallet', id, address }.
  router.post('/present/challenge', async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      const principal = await resolveHumanPrincipal(deps.db, userId);
      if (!principal.ok) {
        res.status(principal.status).json({ error: principal.error });
        return;
      }
      const issued = issueWalletChallengeFromRequest(
        { walletId: principal.principal.walletId, address: principal.principal.address },
        req.body,
        deps.env ?? process.env,
      );
      if (!issued.ok) {
        res.status(issued.status).json({ error: issued.error });
        return;
      }
      res.json({ challenge: issued.envelope });
    } catch (error) {
      console.error('[WalletPresentation] challenge error:', error);
      res.status(500).json({ error: 'Failed to issue challenge' });
    }
  });

  router.post('/present/preflight', async (req: Request, res: Response): Promise<void> => {
    try {
      const userId=req.user?.id;
      if(!userId){res.status(401).json({error:'Authentication required'});return;}
      const principal=await resolveHumanPrincipal(deps.db,userId);
      if(!principal.ok){res.status(principal.status).json({error:principal.error});return;}
      const result=await preflightPresentationFromRequest({db:deps.db,env:deps.env},principal.principal,req.body);
      res.setHeader('Cache-Control','no-store');
      if(!result.ok){res.status(result.status).json({error:result.error,reason:result.reason});return;}
      res.json({ok:true});
    } catch {res.status(503).json({error:'presentation_preflight_unavailable'});}
  });

  router.post('/present', async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      const principal = await resolveHumanPrincipal(deps.db, userId);
      if (!principal.ok) {
        res.status(principal.status).json({ error: principal.error });
        return;
      }
      const result = await producePresentationFromRequest(
        { db: deps.db, env: deps.env },
        principal.principal,
        req.body,
      );
      if (!result.ok) {
        res.status(result.status).json({
          error: result.error,
          ...(result.reason ? { reason: result.reason } : {}),
          // a pipelined call's burn that WAS recorded — present it again with `burn_id`.
          ...(result.burnId ? { burn_id: result.burnId, burn_recorded: true } : {}),
        });
        return;
      }
      res.json({
        tier: result.presentation.tier,
        presentation: result.presentation,
        token: encodePresentationToken(result.presentation),
      });
    } catch (error) {
      console.error('[WalletPresentation] present error:', error);
      res.status(500).json({ error: 'Failed to produce presentation' });
    }
  });

  // GET /rail-handshake — HANDSHAKE STATE READ (Part C / C2), human side. Read
  // the live / lapsed / invalidated / none state (+ reason class) of a directed
  // rail handshake for a relationship this human is a party to. Symmetric with
  // the agent GET /v1/agent/wallet/:id/rail-handshake. Never a Commons surface.
  //   ?counterparty=<wallet_id | provian:commons>  (required)
  //   ?role=presenter (default) → state of (this wallet → counterparty)
  //   ?role=audience            → state of (counterparty → this wallet)
  router.get('/rail-handshake', async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      const wallet = await resolveHumanWallet(deps.db, userId);
      if (!wallet.ok) {
        res.status(wallet.status).json({ error: wallet.error });
        return;
      }
      const counterparty = typeof req.query.counterparty === 'string' ? req.query.counterparty : '';
      if (!counterparty) {
        res.status(400).json({ error: 'counterparty query param is required' });
        return;
      }
      const role = req.query.role === 'audience' ? 'audience' : 'presenter';
      const [committer, other] = role === 'audience'
        ? [counterparty, wallet.walletId]
        : [wallet.walletId, counterparty];
      const state = await readHandshakeState(deps.db, committer, other, Date.now());
      res.json(state);
    } catch (error) {
      console.error('[WalletPresentation] rail-handshake state error:', error);
      res.status(500).json({ error: 'Failed to read handshake state' });
    }
  });

  return router;
}
