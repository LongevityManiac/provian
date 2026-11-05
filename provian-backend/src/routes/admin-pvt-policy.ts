/**
 * Operator API for the fail-closed PVT pending-policy queue.
 *
 * Reads are available to the existing admin-secret holder. Classification and
 * rejection writes additionally require `PVT_POLICY_CLASSIFICATION_WRITES_ENABLED=true`.
 * The flag remains deliberately off so shipping the code cannot silently
 * activate a classification write path.
 *
 * the classify verb is a ONE-WAY DECLINE. It can only write
 * `record_only`; `eligible`, `pending_evidence`, `pending_review`, and
 * `ineligible_terminal` are refused at the route with 403. There is no admin
 * path to a mintable action-policy row: the ONLY way a type becomes eligible is
 * the signed matrix path (emitter + independent verifier + matrix row + the
 * maintainer's SSHSIG + a gated deploy). This closes the "second door" an
 * admin secret plus a Firestore write producing an eligible disposition with no
 * signature — described in the operator-visibility brief.
 */

import crypto from 'crypto';
import { Router, type Request, type Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import {
  classifyPendingPolicyAction,
  getPendingPolicyAction,
  listPendingPolicyActionPage,
  rejectPendingPolicyAction,
  type PendingPolicyMintDisposition,
  type PendingPolicyReviewState,
} from '../core/pvt/policy/pending-policy-queue';
import {
  ACTION_POLICY_REASON_CODES,
  POLICY_REJECTION_REASON_CODES,
  type ActionEvidenceRequirement,
  type ActionPolicyReasonCode,
  type BeneficialOwnershipPolicy,
  type EvidenceResolutionMode,
  type PolicyRejectionReasonCode,
  type ProposedActionPolicyEntry,
  type SessionLineagePolicy,
} from '../core/pvt/policy/types';
import { primaryOperatorId, assertedOperatorId } from './operator-identity';
import { jsonContentTypeOkForMutation } from './middleware/require-json';
export interface AdminPVTPolicyRouterDeps {
  db: Firestore;
  now?: () => number;
}

const REVIEW_STATES = new Set<PendingPolicyReviewState>([
  'pending_policy', 'classified_prospective', 'rejected', 'resolved_signed_matrix',
]);
const DISPOSITIONS = new Set<PendingPolicyMintDisposition>([
  'eligible', 'pending_evidence', 'pending_review', 'record_only', 'ineligible_terminal',
]);
// the classify route can ONLY decline a type (write `record_only`). A
// mintable disposition (`eligible`, `pending_evidence`, `pending_review`) is
// NEVER reachable through an admin secret + a Firestore write — the only path to
// an eligible row is the signed matrix path (emitter + independent verifier +
// matrix row + the operator’s SSHSIG). Rejection is the separate `/reject` route.
// `ineligible_terminal` is a compliance-terminal state and is likewise refused
// here; it is not a classification an operator produces from this queue verb.
const CLASSIFY_ALLOWED_DISPOSITIONS = new Set<PendingPolicyMintDisposition>([
  'record_only',
]);
const EVIDENCE_REQUIREMENTS = new Set<ActionEvidenceRequirement>([
  'none', 'base_final_chain_receipt', 'valid_genesis_reservation',
  'verified_institution_lifecycle', 'verified_substantive_outcome',
  'verified_compute_or_work', 'verified_external_service_witness',
  'operator_policy_review',
]);
const FIXED_GRANT_SOURCES = new Set<ProposedActionPolicyEntry['fixed_grant_source']>([
  'none',
]);
const BENEFICIAL_OWNERSHIP_POLICIES = new Set<BeneficialOwnershipPolicy>([
  'record_only_if_self_shared_or_churn', 'not_applicable',
]);
const SESSION_LINEAGE_POLICIES = new Set<SessionLineagePolicy>([
  'required', 'optional', 'not_applicable',
]);
const LINKAGE_TREATMENTS = new Set<ProposedActionPolicyEntry['linkage_treatment']>([
  'record_time_verified_policy_multiplier',
  'genesis_contributor_only_no_linked_beneficiary_routing',
  'none_record_only',
]);
const EVIDENCE_RESOLUTION_MODES = new Set<EvidenceResolutionMode>([
  'projection_with_verified_evidence', 'linked_evidence_pe_only', 'not_applicable',
]);
const ACTION_POLICY_REASON_CODE_SET = new Set<ActionPolicyReasonCode>(ACTION_POLICY_REASON_CODES);
const POLICY_REJECTION_REASON_CODE_SET = new Set<PolicyRejectionReasonCode>(
  POLICY_REJECTION_REASON_CODES,
);

function secretMatches(provided: unknown, expected: string | undefined): boolean {
  if (typeof provided !== 'string' || !expected) return false;
  const actual = Buffer.from(provided, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
}

function authenticateAdmin(req: Request, res: Response): boolean {
  const expected = process.env.ADMIN_API_KEY || process.env.AGENT_BANK_ADMIN_SECRET;
  if (!secretMatches(req.headers['x-admin-secret'], expected)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  // CSRF backstop (F2/F26/F57/F65): mutating admin routes must carry application/json.
  if (!jsonContentTypeOkForMutation(req, res)) return false;
  return true;
}

function classificationWritesEnabled(): boolean {
  const value = process.env.PVT_POLICY_CLASSIFICATION_WRITES_ENABLED;
  return value === 'true' || value === '1';
}

function requireClassificationWrites(res: Response): boolean {
  if (classificationWritesEnabled()) return true;
  res.status(503).json({
    error: 'PVT policy classification writes are disabled pending later exact policy activation',
    code: 'pvt_policy_classification_writes_disabled',
  });
  return false;
}

function actionTypeParam(req: Request): string {
  try {
    return decodeURIComponent(req.params.actionType ?? '').trim();
  } catch {
    return '';
  }
}

// F55: audit identity is the un-spoofable primaryOperatorId (x-ops-basic-user);
// x-operator-id is recorded only as asserted. See ./operator-identity.

export function createAdminPVTPolicyRouter(deps: AdminPVTPolicyRouterDeps): Router {
  const router = Router();
  const now = deps.now ?? Date.now;

  router.get('/pending', async (req: Request, res: Response) => {
    if (!authenticateAdmin(req, res)) return;
    const stateRaw = typeof req.query.state === 'string' ? req.query.state : undefined;
    if (stateRaw && !REVIEW_STATES.has(stateRaw as PendingPolicyReviewState)) {
      res.status(400).json({ error: 'Invalid policy review state' });
      return;
    }
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    if (limitRaw !== undefined && (!Number.isInteger(limitRaw) || limitRaw <= 0)) {
      res.status(400).json({ error: 'limit must be a positive integer' });
      return;
    }
    try {
      const page = await listPendingPolicyActionPage(deps.db, {
        state: stateRaw as PendingPolicyReviewState | undefined,
        limit: limitRaw,
        cursor,
      });
      res.json({
        items: page.items,
        count: page.items.length,
        total: page.total,
        next_cursor: page.nextCursor,
        classification_writes_enabled: classificationWritesEnabled(),
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'pending_policy_cursor_invalid') {
        res.status(400).json({ error: 'Invalid pagination cursor' });
        return;
      }
      console.error('[PVTPolicy] list pending failed:', error);
      res.status(500).json({ error: 'Failed to list pending policy actions' });
    }
  });

  router.get('/pending/:actionType', async (req: Request, res: Response) => {
    if (!authenticateAdmin(req, res)) return;
    const actionType = actionTypeParam(req);
    if (!actionType) {
      res.status(400).json({ error: 'action_type is required' });
      return;
    }
    try {
      const item = await getPendingPolicyAction(deps.db, actionType);
      if (!item) {
        res.status(404).json({ error: 'Pending policy action not found' });
        return;
      }
      res.json({ item, classification_writes_enabled: classificationWritesEnabled() });
    } catch (error) {
      console.error('[PVTPolicy] pending detail failed:', error);
      res.status(500).json({ error: 'Failed to load pending policy action' });
    }
  });

  router.post('/pending/:actionType/classify', async (req: Request, res: Response) => {
    if (!authenticateAdmin(req, res) || !requireClassificationWrites(res)) return;
    const actionType = actionTypeParam(req);
    const auditedOperatorId = primaryOperatorId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const disposition = body.mint_disposition;
    const effectiveAt = body.effective_at;
    if (
      !actionType
      || !auditedOperatorId
      || typeof disposition !== 'string'
      || !DISPOSITIONS.has(disposition as PendingPolicyMintDisposition)
    ) {
      res.status(400).json({
        error: 'Valid action_type, a primary operator identity (x-ops-basic-user), and mint_disposition are required',
      });
      return;
    }
    if (!CLASSIFY_ALLOWED_DISPOSITIONS.has(disposition as PendingPolicyMintDisposition)) {
      // an otherwise well-formed request that asks for a mintable (or
      // terminal) disposition is refused here, deliberately — not a malformed
      // request but a forbidden one. The classify verb only DECLINES a type.
      res.status(403).json({
        error:
          'The classify route can only decline an action type to record_only. Making a type '
          + 'eligible (or pending_evidence / pending_review) requires the signed matrix path — an '
          + 'emitter, an independent verifier, a matrix row, and the maintainer\'s SSHSIG — never an '
          + 'admin write. Use POST .../reject to reject a type.',
        code: 'pvt_policy_classify_disposition_forbidden',
        allowed_dispositions: [...CLASSIFY_ALLOWED_DISPOSITIONS],
      });
      return;
    }
    if (
      typeof body.effective_policy_version !== 'string'
      || typeof effectiveAt !== 'number'
      || !Number.isSafeInteger(effectiveAt)
      || effectiveAt < 0
      || typeof body.reason_code !== 'string'
      || !ACTION_POLICY_REASON_CODE_SET.has(body.reason_code as ActionPolicyReasonCode)
      || typeof body.category !== 'string'
      || typeof body.base_action_weight_bps !== 'number'
      || (body.policy_override_bps !== null && typeof body.policy_override_bps !== 'number')
      || typeof body.evidence_requirement !== 'string'
      || !EVIDENCE_REQUIREMENTS.has(body.evidence_requirement as ActionEvidenceRequirement)
      || typeof body.financial_attestation_neutral !== 'boolean'
      || typeof body.allow_verified_attestation_upgrade !== 'boolean'
      || typeof body.fixed_grant_source !== 'string'
      || !FIXED_GRANT_SOURCES.has(
        body.fixed_grant_source as ProposedActionPolicyEntry['fixed_grant_source'],
      )
      || typeof body.canonical_event_required !== 'boolean'
      || typeof body.canonical_event_group !== 'string'
      || typeof body.beneficial_ownership_policy !== 'string'
      || !BENEFICIAL_OWNERSHIP_POLICIES.has(
        body.beneficial_ownership_policy as BeneficialOwnershipPolicy,
      )
      || typeof body.session_lineage_policy !== 'string'
      || !SESSION_LINEAGE_POLICIES.has(body.session_lineage_policy as SessionLineagePolicy)
      || typeof body.linkage_treatment !== 'string'
      || !LINKAGE_TREATMENTS.has(
        body.linkage_treatment as ProposedActionPolicyEntry['linkage_treatment'],
      )
      || typeof body.evidence_resolution_mode !== 'string'
      || !EVIDENCE_RESOLUTION_MODES.has(
        body.evidence_resolution_mode as EvidenceResolutionMode,
      )
    ) {
      res.status(400).json({
        error: 'A complete prospective action policy is required',
      });
      return;
    }
    try {
      const policy = await classifyPendingPolicyAction(deps.db, {
        actionType,
        effectivePolicyVersion: body.effective_policy_version,
        effectiveAt,
        disposition: disposition as PendingPolicyMintDisposition,
        reasonCode: body.reason_code as ActionPolicyReasonCode,
        category: body.category,
        baseActionWeightBps: body.base_action_weight_bps,
        policyOverrideBps: body.policy_override_bps as number | null,
        evidenceRequirement: body.evidence_requirement as ActionEvidenceRequirement,
        financialAttestationNeutral: body.financial_attestation_neutral,
        allowVerifiedAttestationUpgrade: body.allow_verified_attestation_upgrade,
        fixedGrantSource: body.fixed_grant_source as ProposedActionPolicyEntry['fixed_grant_source'],
        canonicalEventRequired: body.canonical_event_required,
        canonicalEventGroup: body.canonical_event_group,
        beneficialOwnershipPolicy:
          body.beneficial_ownership_policy as BeneficialOwnershipPolicy,
        sessionLineagePolicy: body.session_lineage_policy as SessionLineagePolicy,
        linkageTreatment:
          body.linkage_treatment as ProposedActionPolicyEntry['linkage_treatment'],
        evidenceResolutionMode: body.evidence_resolution_mode as EvidenceResolutionMode,
        operatorId: auditedOperatorId,
        assertedOperatorId: assertedOperatorId(req),
        now: now(),
      });
      res.status(201).json({ policy });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes('not_found') ? 404 : 409;
      res.status(status).json({ error: message });
    }
  });

  router.post('/pending/:actionType/reject', async (req: Request, res: Response) => {
    if (!authenticateAdmin(req, res) || !requireClassificationWrites(res)) return;
    const actionType = actionTypeParam(req);
    const auditedOperatorId = primaryOperatorId(req);
    const reasonCode = typeof req.body?.reason_code === 'string' ? req.body.reason_code : '';
    const effectivePolicyVersion = typeof req.body?.effective_policy_version === 'string'
      ? req.body.effective_policy_version
      : '';
    const effectiveAt = req.body?.effective_at;
    if (
      !actionType
      || !auditedOperatorId
      || !reasonCode.trim()
      || !POLICY_REJECTION_REASON_CODE_SET.has(reasonCode as PolicyRejectionReasonCode)
      || !effectivePolicyVersion.trim()
      || !Number.isSafeInteger(effectiveAt)
      || effectiveAt < 0
    ) {
      res.status(400).json({
        error: 'action_type, a primary operator identity (x-ops-basic-user), reason_code, effective_policy_version, and effective_at are required',
      });
      return;
    }
    try {
      await rejectPendingPolicyAction(deps.db, {
        actionType,
        reasonCode: reasonCode as PolicyRejectionReasonCode,
        effectivePolicyVersion,
        effectiveAt,
        operatorId: auditedOperatorId,
        assertedOperatorId: assertedOperatorId(req),
        now: now(),
      });
      res.json({
        rejected: true,
        action_type: actionType,
        mint_disposition: 'record_only',
        effective_policy_version: effectivePolicyVersion,
        effective_at: effectiveAt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes('not_found') ? 404 : 409;
      res.status(status).json({ error: message });
    }
  });

  return router;
}
