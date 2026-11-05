import {createQueryPager} from '../../provenance/query-pages';
/**
 * Pending PVT action-policy queue.
 *
 * PE type submission remains permissionless, but a never-before-seen action
 * identifier is not permission to mint. The first observation is recorded in a
 * durable operator queue and remains `record_only` until a prospective,
 * versioned classification takes effect. Classification never edits the PEs
 * that were sealed while the type was unknown.
 */

import crypto from 'crypto';
import { FieldPath, type Firestore } from 'firebase-admin/firestore';
import {
  MAX_POLICY_ACTION_TYPE_LENGTH,
  isValidPolicyActionType,
} from './action-type-syntax';
import {
  ACTION_POLICY_CATEGORIES as ACTION_POLICY_CATEGORY_VALUES,
  ACTION_POLICY_REASON_CODES,
  POLICY_REJECTION_REASON_CODES,
  type ActionPolicyCategory,
  type ActionEvidenceRequirement,
  type ActionPolicyReasonCode,
  type BeneficialOwnershipPolicy,
  type EvidenceResolutionMode,
  type PolicyRejectionReasonCode,
  type ProposedActionPolicyEntry,
  type SessionLineagePolicy,
} from './types';

export const PENDING_POLICY_COLLECTION = 'pvt_pending_policy_queue';
export const PENDING_POLICY_OBSERVATION_COLLECTION = 'pvt_pending_policy_observations';
export const PENDING_POLICY_RECOVERY_STATE_COLLECTION = 'pvt_pending_policy_recovery_state';
export const PENDING_POLICY_DEAD_LETTER_COLLECTION = 'pvt_pending_policy_dead_letter';
export const ACTION_POLICY_COLLECTION = 'pvt_action_policies';
export const ACTION_POLICY_AUDIT_COLLECTION = 'pvt_action_policy_audit';
export const DEFAULT_PENDING_POLICY_VERSION = 'pvt-policy-v1-proposed';

export const PENDING_POLICY_ALERT_RETRY_MS = 5 * 60 * 1000;
export const PENDING_POLICY_OVERDUE_MS = 24 * 60 * 60 * 1000;
export const PENDING_POLICY_OVERDUE_REPEAT_MS = 24 * 60 * 60 * 1000;
export const PENDING_POLICY_ALERT_WORK_LIMIT = 100;
const PENDING_POLICY_ALERT_CONCURRENCY = 10;
const MAX_SAMPLE_PE_IDS = 10;
const MAX_INTEGRATION_SOURCES = 10;
const ACTION_POLICY_REASON_CODE_SET = new Set<string>(ACTION_POLICY_REASON_CODES);
const POLICY_REJECTION_REASON_CODE_SET = new Set<string>(POLICY_REJECTION_REASON_CODES);
const ACTION_POLICY_CATEGORIES = new Set<ActionPolicyCategory>([
  ...ACTION_POLICY_CATEGORY_VALUES,
]);

export type PendingPolicyReviewState =
  | 'pending_policy'
  | 'classified_prospective'
  | 'rejected'
  // The type landed as a NAMED row on the served, digest-matched signed matrix
  // (`resolvePendingPolicyActionBySignedMatrix`). Terminal; the matrix row, not
  // this queue row, is what prices the type from then on.
  | 'resolved_signed_matrix';

export type PendingPolicyMintDisposition =
  | 'eligible'
  | 'pending_evidence'
  | 'pending_review'
  | 'record_only'
  | 'ineligible_terminal';

export type PendingPolicyAlertStatus =
  | 'pending'
  | 'delivered'
  | 'failed'
  | 'unconfigured';

export interface PendingPolicyQueueDocument {
  action_type: string;
  first_seen_at: number;
  last_seen_at: number;
  observation_count: number;
  sample_pe_ids: string[];
  integration_sources: string[];
  mint_disposition: 'record_only';
  disposition_reason_code: 'unknown_action_type';
  policy_review_state: PendingPolicyReviewState;
  observed_under_policy_version: string;
  alert_status: PendingPolicyAlertStatus;
  alert_attempts: number;
  next_alert_due_at: number;
  last_alert_attempt_at: number | null;
  last_alert_delivered_at: number | null;
  last_alert_kind: PendingPolicyAlertKind | null;
  last_alert_error: string | null;
  classified_at?: number;
  classified_by?: string;
  effective_at?: number;
  effective_policy_version?: string;
  proposed_disposition?: PendingPolicyMintDisposition;
  proposed_reason_code?: ActionPolicyReasonCode;
  proposed_category?: string;
  proposed_base_action_weight_bps?: number;
  proposed_policy_override_bps?: number | null;
  proposed_evidence_requirement?: ActionEvidenceRequirement;
  proposed_financial_attestation_neutral?: boolean;
  proposed_allow_verified_attestation_upgrade?: boolean;
  proposed_fixed_grant_source?: ProposedActionPolicyEntry['fixed_grant_source'];
  proposed_canonical_event_required?: boolean;
  proposed_canonical_event_group?: string;
  proposed_beneficial_ownership_policy?: BeneficialOwnershipPolicy;
  proposed_session_lineage_policy?: SessionLineagePolicy;
  proposed_linkage_treatment?: ProposedActionPolicyEntry['linkage_treatment'];
  proposed_evidence_resolution_mode?: EvidenceResolutionMode;
  rejected_at?: number;
  rejected_by?: string;
  rejection_reason_code?: PolicyRejectionReasonCode;
  /** Set when the type landed on the signed matrix (`resolved_signed_matrix`). */
  resolved_at?: number;
  resolved_by?: 'signed_matrix';
  /** The matrix row's disposition + reason at resolution (a copy for the record, never priced). */
  resolved_matrix_mint_disposition?: string;
  resolved_matrix_reason_code?: string;
}

export type PendingPolicyAlertKind = 'first_sight' | 'retry' | 'overdue';

export interface PendingPolicyObservation {
  actionType: string;
  peId: string;
  integrationSource: string;
  /**
   * The submitter (the act's `actor_id`, as its 31-day act key carries it). Recorded on the
   * observation so the activation notice reaches every submitter of the type however long review
   * takes — the act keys age out after 31 days; the observation does not.
   */
  actorId?: string | null;
  policyVersion?: string;
  now?: number;
}

export interface PendingPolicyObservationResult {
  firstSight: boolean;
  duplicateObservation: boolean;
  alertKind: PendingPolicyAlertKind | null;
  document: PendingPolicyQueueDocument;
}

export interface PendingPolicyAlertMessage {
  actionType: string;
  kind: PendingPolicyAlertKind;
  firstSeenAt: number;
  observationCount: number;
  policyVersion: string;
  /** Up to MAX_SAMPLE_PE_IDS evidence PE ids for the operator to open. */
  samplePeIds: string[];
}

export type PendingPolicyAlertSender = (
  message: PendingPolicyAlertMessage,
) => Promise<{ delivered: boolean; error?: string }>;

export interface ProspectiveClassificationInput {
  actionType: string;
  effectivePolicyVersion: string;
  effectiveAt: number;
  disposition: PendingPolicyMintDisposition;
  reasonCode: ActionPolicyReasonCode;
  category: string;
  baseActionWeightBps: number;
  policyOverrideBps: number | null;
  evidenceRequirement: ActionEvidenceRequirement;
  financialAttestationNeutral: boolean;
  allowVerifiedAttestationUpgrade: boolean;
  fixedGrantSource: ProposedActionPolicyEntry['fixed_grant_source'];
  canonicalEventRequired: boolean;
  canonicalEventGroup: string;
  beneficialOwnershipPolicy: BeneficialOwnershipPolicy;
  sessionLineagePolicy: SessionLineagePolicy;
  linkageTreatment: ProposedActionPolicyEntry['linkage_treatment'];
  evidenceResolutionMode: EvidenceResolutionMode;
  operatorId: string;
  /** F55: caller-asserted x-operator-id, recorded for forensics — never the
   *  primary audit identity (that is `operatorId`, the nginx x-ops-basic-user). */
  assertedOperatorId?: string | null;
  now?: number;
}

export interface RejectClassificationInput {
  actionType: string;
  reasonCode: PolicyRejectionReasonCode;
  effectivePolicyVersion: string;
  effectiveAt: number;
  operatorId: string;
  /** F55: caller-asserted x-operator-id (forensics), never the primary identity. */
  assertedOperatorId?: string | null;
  now?: number;
}

export interface ProspectiveActionPolicyDocument {
  action_type: string;
  policy_review_state: 'classified_prospective';
  effective_policy_version: string;
  effective_at: number;
  mint_disposition: PendingPolicyMintDisposition;
  disposition_reason_code: ActionPolicyReasonCode;
  category: string;
  base_action_weight_bps: number;
  policy_override_bps: number | null;
  evidence_requirement: ActionEvidenceRequirement;
  financial_attestation_neutral: boolean;
  allow_verified_attestation_upgrade: boolean;
  amount_independent: true;
  fixed_grant_source: ProposedActionPolicyEntry['fixed_grant_source'];
  canonical_event_required: boolean;
  canonical_event_group: string;
  beneficial_ownership_policy: BeneficialOwnershipPolicy;
  session_lineage_policy: SessionLineagePolicy;
  linkage_treatment: ProposedActionPolicyEntry['linkage_treatment'];
  evidence_resolution_mode: EvidenceResolutionMode;
  created_at: number;
  created_by: string;
  /** F55: caller-asserted x-operator-id (forensics), or null — never the primary
   *  audit identity (that is `created_by`, the nginx x-ops-basic-user). */
  created_asserted_operator_id?: string | null;
  prospective_only: true;
}

const EVIDENCE_REQUIREMENTS = new Set<ActionEvidenceRequirement>([
  'none',
  'base_final_chain_receipt',
  'valid_genesis_reservation',
  'verified_institution_lifecycle',
  'verified_substantive_outcome',
  'verified_compute_or_work',
  'verified_external_service_witness',
  'operator_policy_review',
]);

export interface PendingPolicyListOptions {
  state?: PendingPolicyReviewState;
  limit?: number;
  cursor?: string;
}

export interface PendingPolicyListPage {
  items: PendingPolicyQueueDocument[];
  total: number;
  nextCursor: string | null;
}

function uniqueAppend(values: string[], value: string, max: number): string[] {
  const next = values.includes(value) ? values : [...values, value];
  return next.slice(Math.max(0, next.length - max));
}

/**
 * Stable pointer shared by the queue and the prospective action-policy store.
 * Exported so runtime resolution cannot drift onto a second identifier scheme.
 */
export function actionPolicyDocumentId(actionType: string): string {
  return crypto.createHash('sha256').update(actionType, 'utf8').digest('hex');
}

function safeError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}

function validateObservation(input: PendingPolicyObservation): void {
  validateActionType(input.actionType);
  if (!input.peId.trim()) throw new Error('pe_id_required');
  if (!input.integrationSource.trim()) throw new Error('integration_source_required');
}

function validateActionType(actionType: string): void {
  if (!actionType.trim()) throw new Error('action_type_required');
  if (
    actionType.length > MAX_POLICY_ACTION_TYPE_LENGTH
    || !isValidPolicyActionType(actionType)
  ) throw new Error('action_type_invalid');
}

export { MAX_POLICY_ACTION_TYPE_LENGTH, isValidPolicyActionType } from './action-type-syntax';

function pendingPolicyObservationId(actionType: string, peId: string): string {
  return crypto.createHash('sha256')
    .update(actionType, 'utf8')
    .update('\0', 'utf8')
    .update(peId, 'utf8')
    .digest('hex');
}

function nextAlertDueAt(doc: PendingPolicyQueueDocument): number {
  const overdueAt = doc.first_seen_at + PENDING_POLICY_OVERDUE_MS;
  if (doc.last_alert_kind === 'overdue' && doc.last_alert_attempt_at !== null) {
    return doc.last_alert_attempt_at + PENDING_POLICY_OVERDUE_REPEAT_MS;
  }
  if (
    doc.alert_status === 'pending'
    || doc.alert_status === 'failed'
    || doc.alert_status === 'unconfigured'
  ) {
    const retryAnchor = doc.last_alert_attempt_at ?? doc.first_seen_at;
    return Math.min(retryAnchor + PENDING_POLICY_ALERT_RETRY_MS, overdueAt);
  }
  return overdueAt;
}


function emitFirstSightMetric(doc: PendingPolicyQueueDocument): void {
  console.error(JSON.stringify({
    severity: 'ERROR',
    event: 'pvt_pending_policy_first_sight',
    action_type: doc.action_type,
    first_seen_at: doc.first_seen_at,
    mint_disposition: doc.mint_disposition,
    policy_review_state: doc.policy_review_state,
    policy_version: doc.observed_under_policy_version,
  }));
}

/**
 * Upsert a pending-policy queue row inside the caller's Firestore transaction.
 * The caller is responsible for ensuring all transaction reads happen before
 * writes. Keeping this write in the same transaction as pe_history prevents a
 * sealed unknown PE from existing without its operator-visible queue item.
 */
export async function upsertPendingPolicyObservationInTransaction(
  db: Firestore,
  txn: FirebaseFirestore.Transaction,
  input: PendingPolicyObservation,
  now: number,
): Promise<PendingPolicyObservationResult> {
  validateObservation(input);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('now_invalid');
  const policyVersion = input.policyVersion ?? DEFAULT_PENDING_POLICY_VERSION;
  const ref = db.collection(PENDING_POLICY_COLLECTION).doc(actionPolicyDocumentId(input.actionType));
  const observationRef = db.collection(PENDING_POLICY_OBSERVATION_COLLECTION)
    .doc(pendingPolicyObservationId(input.actionType, input.peId));
  // Both reads precede every write, as required by real Firestore transactions.
  const [snap, observationSnap] = await Promise.all([
    txn.get(ref),
    txn.get(observationRef),
  ]);
  if (observationSnap.exists) {
    if (!snap.exists) throw new Error('pending_policy_observation_without_queue');
    return {
      firstSight: false,
      duplicateObservation: true,
      alertKind: null,
      document: snap.data() as PendingPolicyQueueDocument,
    };
  }
  const observationDocument = {
    action_type: input.actionType,
    pe_id: input.peId,
    integration_source: input.integrationSource,
    observed_at: now,
    policy_version: policyVersion,
    ...(typeof input.actorId === 'string' && input.actorId.trim() ? { actor_id: input.actorId } : {}),
  };
  if (!snap.exists) {
    const document: PendingPolicyQueueDocument = {
      action_type: input.actionType,
      first_seen_at: now,
      last_seen_at: now,
      observation_count: 1,
      sample_pe_ids: [input.peId],
      integration_sources: [input.integrationSource],
      mint_disposition: 'record_only',
      disposition_reason_code: 'unknown_action_type',
      policy_review_state: 'pending_policy',
      observed_under_policy_version: policyVersion,
      alert_status: 'pending',
      alert_attempts: 0,
      next_alert_due_at: now + PENDING_POLICY_ALERT_RETRY_MS,
      last_alert_attempt_at: null,
      last_alert_delivered_at: null,
      last_alert_kind: null,
      last_alert_error: null,
    };
    txn.create(ref, document as unknown as FirebaseFirestore.DocumentData);
    txn.create(
      observationRef,
      observationDocument as unknown as FirebaseFirestore.DocumentData,
    );
    return {
      firstSight: true,
      duplicateObservation: false,
      alertKind: 'first_sight',
      document,
    };
  }

  const current = snap.data() as PendingPolicyQueueDocument;
  const document: PendingPolicyQueueDocument = {
    ...current,
    last_seen_at: now,
    observation_count: current.observation_count + 1,
    sample_pe_ids: uniqueAppend(current.sample_pe_ids, input.peId, MAX_SAMPLE_PE_IDS),
    integration_sources: uniqueAppend(
      current.integration_sources,
      input.integrationSource,
      MAX_INTEGRATION_SOURCES,
    ),
    // atomic accounting introduces this collection and all new rows carry a due time. Keep
    // observations self-healing for any pre-release fixture or partially
    // written row encountered during rollout.
    next_alert_due_at: Number.isSafeInteger(current.next_alert_due_at)
      ? current.next_alert_due_at
      : nextAlertDueAt(current),
  };
  const retryAnchor = current.last_alert_attempt_at ?? current.first_seen_at;
  const retryDue = current.policy_review_state === 'pending_policy'
    && (
      current.alert_status === 'pending'
      || current.alert_status === 'failed'
      || current.alert_status === 'unconfigured'
    )
    && now - retryAnchor >= PENDING_POLICY_ALERT_RETRY_MS;
  const alertKind: PendingPolicyAlertKind | null = retryDue
    ? (current.alert_attempts === 0 ? 'first_sight' : 'retry')
    : null;
  if (alertKind) document.alert_status = 'pending';
  txn.set(ref, document as unknown as FirebaseFirestore.DocumentData);
  txn.create(
    observationRef,
    observationDocument as unknown as FirebaseFirestore.DocumentData,
  );
  return { firstSight: false, duplicateObservation: false, alertKind, document };
}
/** Product observation is durable before this diagnostic signal. Notification delivery
 * is owned by the private service, which observes the committed queue. */
export async function finalizePendingPolicyObservation(
  _db: Firestore, result: PendingPolicyObservationResult, _now: number,
  _observer?: PendingPolicyAlertSender,
): Promise<void> {
  if (result.firstSight || result.alertKind === 'first_sight') emitFirstSightMetric(result.document);
}


/**
 * Transactionally upsert one queue item for a genuinely unknown action type.
 * Alert failure never changes the fail-closed record-only disposition.
 */
export async function observePendingPolicyAction(
  db: Firestore,
  input: PendingPolicyObservation,
  sender?: PendingPolicyAlertSender,
): Promise<PendingPolicyObservationResult> {
  validateObservation(input);
  const now = input.now ?? Date.now();
  validateActionType(input.actionType);
  const result = await db.runTransaction(async (txn): Promise<PendingPolicyObservationResult> => {
    return upsertPendingPolicyObservationInTransaction(db, txn, input, now);
  });
  await finalizePendingPolicyObservation(db, result, now, sender);
  return result;
}

/**
 * Classify prospectively. The action-policy document is effective only for PEs
 * recorded at/after `effectiveAt`; no pe_history document is read or updated.
 */
export async function classifyPendingPolicyAction(
  db: Firestore,
  input: ProspectiveClassificationInput,
): Promise<ProspectiveActionPolicyDocument> {
  const now = input.now ?? Date.now();
  validateActionType(input.actionType);
  if (!input.operatorId.trim()) throw new Error('operator_id_required');
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('now_invalid');
  if (!Number.isSafeInteger(input.effectiveAt) || input.effectiveAt < 0) {
    throw new Error('effective_at_invalid');
  }
  if (input.effectiveAt <= now) throw new Error('effective_at_must_be_future');
  if (!input.effectivePolicyVersion.trim()) throw new Error('effective_policy_version_required');
  if (!ACTION_POLICY_REASON_CODE_SET.has(input.reasonCode)) throw new Error('reason_code_invalid');
  if (!ACTION_POLICY_CATEGORIES.has(input.category as ActionPolicyCategory)) {
    throw new Error('category_invalid');
  }
  if (
    !Number.isInteger(input.baseActionWeightBps)
    || input.baseActionWeightBps < 0
    || input.baseActionWeightBps > 100_000
  ) throw new Error('base_action_weight_bps_invalid');
  if (
    input.policyOverrideBps !== null
    && (
      !Number.isInteger(input.policyOverrideBps)
      || input.policyOverrideBps < 0
      || input.policyOverrideBps > 100_000
    )
  ) throw new Error('policy_override_bps_invalid');
  const effectiveWeightBps = input.policyOverrideBps ?? input.baseActionWeightBps;
  if (
    (input.disposition === 'record_only' || input.disposition === 'ineligible_terminal')
    && effectiveWeightBps !== 0
  ) throw new Error('non_minting_disposition_requires_zero_weight');
  if (
    input.disposition !== 'record_only'
    && input.disposition !== 'ineligible_terminal'
    && effectiveWeightBps === 0
  ) throw new Error('minting_disposition_requires_positive_weight');
  if (!EVIDENCE_REQUIREMENTS.has(input.evidenceRequirement)) {
    throw new Error('evidence_requirement_invalid');
  }
  if (input.financialAttestationNeutral && input.allowVerifiedAttestationUpgrade) {
    throw new Error('financial_attestation_neutral_cannot_upgrade');
  }
  if (
    input.fixedGrantSource !== 'none'
    && input.fixedGrantSource !== 'genesis_campaign_reservation'
  ) {
    throw new Error('fixed_grant_source_invalid');
  }
  if (input.fixedGrantSource !== 'none') {
    throw new Error('generic_classification_cannot_arm_genesis');
  }
  if (!input.canonicalEventGroup.trim()) throw new Error('canonical_event_group_required');
  if (input.canonicalEventRequired !== (input.evidenceRequirement !== 'none')) {
    throw new Error('canonical_event_requirement_mismatch');
  }
  if (
    input.beneficialOwnershipPolicy !== 'record_only_if_self_shared_or_churn'
    && input.beneficialOwnershipPolicy !== 'not_applicable'
  ) throw new Error('beneficial_ownership_policy_invalid');
  if (
    input.sessionLineagePolicy !== 'required'
    && input.sessionLineagePolicy !== 'optional'
    && input.sessionLineagePolicy !== 'not_applicable'
  ) throw new Error('session_lineage_policy_invalid');
  if (
    input.linkageTreatment !== 'record_time_verified_policy_multiplier'
    && input.linkageTreatment !== 'none_record_only'
  ) throw new Error('linkage_treatment_invalid');
  if (
    input.evidenceResolutionMode !== 'projection_with_verified_evidence'
    && input.evidenceResolutionMode !== 'linked_evidence_pe_only'
    && input.evidenceResolutionMode !== 'not_applicable'
  ) throw new Error('evidence_resolution_mode_invalid');
  if (
    input.disposition === 'pending_evidence'
    && input.evidenceResolutionMode !== 'linked_evidence_pe_only'
  ) throw new Error('pending_evidence_requires_linked_evidence_pe');
  if (
    (input.disposition === 'record_only' || input.disposition === 'ineligible_terminal')
    && input.evidenceResolutionMode !== 'not_applicable'
  ) throw new Error('non_minting_disposition_cannot_resolve_evidence');
  if (
    input.disposition !== 'record_only'
    && input.disposition !== 'ineligible_terminal'
    && input.linkageTreatment !== 'record_time_verified_policy_multiplier'
  ) throw new Error('minting_disposition_requires_linkage_policy');
  // / the policy setter signature gates EARNING. An unsigned classification
  // can only decline a type (record_only / ineligible_terminal); a minting disposition needs a
  // signed matrix row. The admin route already refuses; this holds for every caller.
  if (input.disposition !== 'record_only' && input.disposition !== 'ineligible_terminal') {
    throw new Error('unsigned_classification_cannot_mint');
  }
  assertProspectiveClassificationSemantics(input);
  const queueRef = db.collection(PENDING_POLICY_COLLECTION).doc(actionPolicyDocumentId(input.actionType));
  const policyRef = db.collection(ACTION_POLICY_COLLECTION).doc(actionPolicyDocumentId(input.actionType));
  const auditId = crypto.randomUUID();
  const auditRef = db.collection(ACTION_POLICY_AUDIT_COLLECTION).doc(auditId);

  const policy: ProspectiveActionPolicyDocument = {
    action_type: input.actionType,
    policy_review_state: 'classified_prospective',
    effective_policy_version: input.effectivePolicyVersion,
    effective_at: input.effectiveAt,
    mint_disposition: input.disposition,
    disposition_reason_code: input.reasonCode,
    category: input.category,
    base_action_weight_bps: input.baseActionWeightBps,
    policy_override_bps: input.policyOverrideBps,
    evidence_requirement: input.evidenceRequirement,
    financial_attestation_neutral: input.financialAttestationNeutral,
    allow_verified_attestation_upgrade: input.allowVerifiedAttestationUpgrade,
    amount_independent: true,
    fixed_grant_source: input.fixedGrantSource,
    canonical_event_required: input.canonicalEventRequired,
    canonical_event_group: input.canonicalEventGroup,
    beneficial_ownership_policy: input.beneficialOwnershipPolicy,
    session_lineage_policy: input.sessionLineagePolicy,
    linkage_treatment: input.linkageTreatment,
    evidence_resolution_mode: input.evidenceResolutionMode,
    created_at: now,
    created_by: input.operatorId,
    created_asserted_operator_id: input.assertedOperatorId ?? null,
    prospective_only: true,
  };

  await db.runTransaction(async (txn) => {
    const queueSnap = await txn.get(queueRef);
    if (!queueSnap.exists) throw new Error('pending_policy_action_not_found');
    const current = queueSnap.data() as PendingPolicyQueueDocument;
    if (current.policy_review_state !== 'pending_policy') {
      throw new Error('pending_policy_action_already_closed');
    }
    txn.set(policyRef, policy as unknown as FirebaseFirestore.DocumentData);
    txn.update(queueRef, {
      policy_review_state: 'classified_prospective',
      classified_at: now,
      classified_by: input.operatorId,
      classified_asserted_operator_id: input.assertedOperatorId ?? null,
      effective_at: input.effectiveAt,
      effective_policy_version: input.effectivePolicyVersion,
      proposed_disposition: input.disposition,
      proposed_reason_code: input.reasonCode,
      proposed_category: input.category,
      proposed_base_action_weight_bps: input.baseActionWeightBps,
      proposed_policy_override_bps: input.policyOverrideBps,
      proposed_evidence_requirement: input.evidenceRequirement,
      proposed_financial_attestation_neutral: input.financialAttestationNeutral,
      proposed_allow_verified_attestation_upgrade: input.allowVerifiedAttestationUpgrade,
      proposed_fixed_grant_source: input.fixedGrantSource,
      proposed_canonical_event_required: input.canonicalEventRequired,
      proposed_canonical_event_group: input.canonicalEventGroup,
      proposed_beneficial_ownership_policy: input.beneficialOwnershipPolicy,
      proposed_session_lineage_policy: input.sessionLineagePolicy,
      proposed_linkage_treatment: input.linkageTreatment,
      proposed_evidence_resolution_mode: input.evidenceResolutionMode,
    });
    txn.create(auditRef, {
      event: 'action_policy_classified_prospective',
      action_type: input.actionType,
      previous_policy_review_state: current.policy_review_state,
      policy,
      operator_id: input.operatorId,
      asserted_operator_id: input.assertedOperatorId ?? null,
      created_at: now,
    });
  });
  return policy;
}

export function assertProspectiveClassificationSemantics(
  input: ProspectiveClassificationInput,
): void {
  const recordOnlyReasons = new Set<ActionPolicyReasonCode>([
    'SYSTEM_BOOKKEEPING_NON_CIRCULAR',
    'PVT_COST_LOCK_BURN_OR_BOND_NON_CIRCULAR',
    'DENIAL_FAILURE_EXPIRY_OR_NOOP',
    'SECURITY_POLICY_OR_IDENTITY_RECORD',
    'SETTLEMENT_SIGNAL_APPLIES_TO_TARGET',
    'INSUFFICIENT_LAUNCH_JUSTIFICATION_RECORD_ONLY',
    // F-A7: the repriced relay-draft institution-lifecycle types — record_only,
    // no sound independent verifier (value mints on the funding/completion
    // watcher or chain event, never the draft).
    'RELAY_DRAFT_NO_INDEPENDENT_VERIFIER_RECORD_ONLY',
  ]);
  const pendingEvidenceReasons = new Set<ActionPolicyReasonCode>([
    'RELAY_DRAFT_AWAITS_INDEPENDENT_EVIDENCE',
    'WORK_OR_COMPUTE_AWAITS_VERIFICATION',
  ]);
  const eligibleReasons = new Set<ActionPolicyReasonCode>([
    'VERIFIED_FINANCIAL_SETTLEMENT_AMOUNT_INDEPENDENT',
    'VERIFIED_INSTITUTION_LIFECYCLE_AMOUNT_INDEPENDENT',
    'VERIFIED_SUBSTANTIVE_OUTCOME',
    'VERIFIED_EXTERNAL_SERVICE_OUTCOME',
  ]);
  const pendingReviewReasons = new Set<ActionPolicyReasonCode>([
    'NON_POLICY_REGISTRY_REVIEW_REQUIRED',
  ]);

  if (input.reasonCode === 'GENESIS_VALID_RESERVATION_FIXED_GRANT') {
    throw new Error('generic_classification_cannot_arm_genesis');
  }
  if (recordOnlyReasons.has(input.reasonCode) && input.disposition !== 'record_only') {
    throw new Error('reason_disposition_mismatch');
  }
  if (pendingEvidenceReasons.has(input.reasonCode) && input.disposition !== 'pending_evidence') {
    throw new Error('reason_disposition_mismatch');
  }
  if (eligibleReasons.has(input.reasonCode) && input.disposition !== 'eligible') {
    throw new Error('reason_disposition_mismatch');
  }
  if (pendingReviewReasons.has(input.reasonCode) && input.disposition !== 'pending_review') {
    throw new Error('reason_disposition_mismatch');
  }

  if (input.disposition === 'record_only') {
    if (
      input.evidenceRequirement !== 'none'
      || input.canonicalEventRequired
      || input.beneficialOwnershipPolicy !== 'not_applicable'
      || input.sessionLineagePolicy !== 'not_applicable'
      || input.linkageTreatment !== 'none_record_only'
    ) throw new Error('record_only_policy_fields_mismatch');
    return;
  }

  if (input.disposition === 'eligible') {
    if (input.evidenceResolutionMode !== 'projection_with_verified_evidence') {
      throw new Error('eligible_policy_requires_verified_projection_mode');
    }
    if (input.beneficialOwnershipPolicy !== 'record_only_if_self_shared_or_churn') {
      throw new Error('eligible_policy_requires_ownership_guard');
    }
  }
  if (input.disposition === 'pending_review') {
    if (
      input.evidenceRequirement !== 'operator_policy_review'
      || input.evidenceResolutionMode !== 'projection_with_verified_evidence'
      || input.beneficialOwnershipPolicy !== 'record_only_if_self_shared_or_churn'
    ) throw new Error('pending_review_policy_fields_mismatch');
  }

  if (input.reasonCode === 'VERIFIED_FINANCIAL_SETTLEMENT_AMOUNT_INDEPENDENT') {
    if (
      input.category !== 'financial'
      || input.evidenceRequirement !== 'base_final_chain_receipt'
      || !input.financialAttestationNeutral
      || input.allowVerifiedAttestationUpgrade
    ) throw new Error('financial_policy_fields_mismatch');
  } else if (input.reasonCode === 'VERIFIED_INSTITUTION_LIFECYCLE_AMOUNT_INDEPENDENT') {
    if (
      input.category !== 'institutional'
      || input.evidenceRequirement !== 'verified_institution_lifecycle'
      || !input.financialAttestationNeutral
      || input.allowVerifiedAttestationUpgrade
    ) throw new Error('institution_policy_fields_mismatch');
  } else if (input.financialAttestationNeutral) {
    throw new Error('attestation_neutral_reason_mismatch');
  }
}

export async function rejectPendingPolicyAction(
  db: Firestore,
  input: RejectClassificationInput,
): Promise<void> {
  const now = input.now ?? Date.now();
  validateActionType(input.actionType);
  if (!input.operatorId.trim()) throw new Error('operator_id_required');
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('now_invalid');
  if (!Number.isSafeInteger(input.effectiveAt) || input.effectiveAt < 0) {
    throw new Error('effective_at_invalid');
  }
  if (!POLICY_REJECTION_REASON_CODE_SET.has(input.reasonCode)) {
    throw new Error('reason_code_invalid');
  }
  if (!input.effectivePolicyVersion.trim()) throw new Error('effective_policy_version_required');
  if (input.effectiveAt <= now) throw new Error('effective_at_must_be_future');
  const queueRef = db.collection(PENDING_POLICY_COLLECTION).doc(actionPolicyDocumentId(input.actionType));
  const auditRef = db.collection(ACTION_POLICY_AUDIT_COLLECTION).doc(crypto.randomUUID());
  await db.runTransaction(async (txn) => {
    const snap = await txn.get(queueRef);
    if (!snap.exists) throw new Error('pending_policy_action_not_found');
    const current = snap.data() as PendingPolicyQueueDocument;
    if (current.policy_review_state !== 'pending_policy') {
      throw new Error('pending_policy_action_already_closed');
    }
    txn.update(queueRef, {
      policy_review_state: 'rejected',
      rejected_at: now,
      rejected_by: input.operatorId,
      rejected_asserted_operator_id: input.assertedOperatorId ?? null,
      rejection_reason_code: input.reasonCode,
      effective_at: input.effectiveAt,
      effective_policy_version: input.effectivePolicyVersion,
    });
    txn.create(auditRef, {
      event: 'action_policy_rejected',
      action_type: input.actionType,
      previous_policy_review_state: current.policy_review_state,
      mint_disposition: 'record_only',
      reason_code: input.reasonCode,
      effective_at: input.effectiveAt,
      effective_policy_version: input.effectivePolicyVersion,
      operator_id: input.operatorId,
      asserted_operator_id: input.assertedOperatorId ?? null,
      created_at: now,
    });
  });
}

/**
 * Close a queue row because its type now has a NAMED row on the served,
 * digest-matched signed matrix (: "a type's queue row resolves
 * when the type lands in the signed matrix"). The caller
 * (`resolveQueueRowsLandedInSignedMatrix`) decides "landed"; this write only
 * moves `pending_policy` → `resolved_signed_matrix` and records the audit. It
 * grants nothing: the queue row never priced anything, and the matrix row is
 * what prices the type. Idempotent — any other state returns false untouched.
 */
export async function resolvePendingPolicyActionBySignedMatrix(
  db: Firestore,
  input: {
    actionType: string;
    matrixMintDisposition: string;
    matrixReasonCode: string;
    now?: number;
  },
): Promise<boolean> {
  const now = input.now ?? Date.now();
  validateActionType(input.actionType);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('now_invalid');
  const queueRef = db.collection(PENDING_POLICY_COLLECTION).doc(actionPolicyDocumentId(input.actionType));
  const auditRef = db.collection(ACTION_POLICY_AUDIT_COLLECTION).doc(crypto.randomUUID());
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(queueRef);
    if (!snap.exists) return false;
    const current = snap.data() as PendingPolicyQueueDocument;
    if (current.action_type !== input.actionType) return false;
    if (current.policy_review_state !== 'pending_policy') return false;
    txn.update(queueRef, {
      policy_review_state: 'resolved_signed_matrix',
      resolved_at: now,
      resolved_by: 'signed_matrix',
      resolved_matrix_mint_disposition: input.matrixMintDisposition,
      resolved_matrix_reason_code: input.matrixReasonCode,
    });
    txn.create(auditRef, {
      event: 'action_policy_resolved_by_signed_matrix',
      action_type: input.actionType,
      previous_policy_review_state: current.policy_review_state,
      matrix_mint_disposition: input.matrixMintDisposition,
      matrix_reason_code: input.matrixReasonCode,
      created_at: now,
    });
    return true;
  });
}

export async function getPendingPolicyAction(
  db: Firestore,
  actionType: string,
): Promise<PendingPolicyQueueDocument | null> {
  const snap = await db.collection(PENDING_POLICY_COLLECTION).doc(actionPolicyDocumentId(actionType)).get();
  return snap.exists ? (snap.data() as PendingPolicyQueueDocument) : null;
}

export async function listPendingPolicyActions(
  db: Firestore,
  options: PendingPolicyListOptions = {},
): Promise<PendingPolicyQueueDocument[]> {
  return (await listPendingPolicyActionPage(db, options)).items;
}

function encodeListCursor(
  firstSeenAt: number,
  documentId: string,
  state: PendingPolicyReviewState | null,
): string {
  return Buffer.from(JSON.stringify({
    v: 1,
    first_seen_at: firstSeenAt,
    document_id: documentId,
    state,
  }), 'utf8').toString('base64url');
}

function decodeListCursor(
  value: string,
  expectedState: PendingPolicyReviewState | null,
): { firstSeenAt: number; documentId: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    const row = parsed as Record<string, unknown>;
    if (
      Object.keys(row).sort().join(',') !== 'document_id,first_seen_at,state,v'
      || row.v !== 1
      || !Number.isSafeInteger(row.first_seen_at)
      || (row.first_seen_at as number) < 0
      || typeof row.document_id !== 'string'
      || !/^[0-9a-f]{64}$/.test(row.document_id)
      || row.state !== expectedState
    ) throw new Error();
    return {
      firstSeenAt: row.first_seen_at as number,
      documentId: row.document_id,
    };
  } catch {
    throw new Error('pending_policy_cursor_invalid');
  }
}

export async function listPendingPolicyActionPage(db: Firestore, options: PendingPolicyListOptions = {}): Promise<PendingPolicyListPage> {
  const state = options.state ?? null;
  let countQuery: FirebaseFirestore.Query = db.collection(PENDING_POLICY_COLLECTION);
  if (state !== null) countQuery = countQuery.where('policy_review_state','==',state);
  const [count,page] = await Promise.all([countQuery.count().get(),listPendingPolicyActionItemsPage(db,options)]);
  return {...page,total:count.data().count};
}

export async function listPendingPolicyActionItemsPage(
  db: Firestore,
  options: PendingPolicyListOptions = {},
  readPage?: ReturnType<typeof createQueryPager>,
): Promise<Omit<PendingPolicyListPage,'total'>> {
  const limit = Math.min(200, Math.max(1, options.limit ?? 100));
  const state = options.state ?? null;
  const cursor = options.cursor === undefined
    ? null
    : decodeListCursor(options.cursor, state);

  let pageQuery: FirebaseFirestore.Query = db.collection(PENDING_POLICY_COLLECTION);
  if (state !== null) {
    pageQuery = pageQuery.where('policy_review_state', '==', state);
  }
  pageQuery = pageQuery
    .orderBy('first_seen_at', 'asc')
    .orderBy(FieldPath.documentId(), 'asc');
  if (cursor !== null) {
    pageQuery = pageQuery.startAfter(cursor.firstSeenAt, cursor.documentId);
  }

  const limited = pageQuery.limit(limit + 1);
  const pageSnap = await (readPage ? readPage(limited) : limited.get());
  const pageDocs = pageSnap.docs.slice(0, limit);
  const items = pageDocs.map((row) => row.data() as PendingPolicyQueueDocument);
  const hasMore = pageSnap.docs.length > limit;
  const last = pageDocs[pageDocs.length - 1];
  return {
    items,
    nextCursor: hasMore && last
      ? encodeListCursor(
        (last.data() as PendingPolicyQueueDocument).first_seen_at,
        last.id,
        state,
      )
      : null,
  };
}
