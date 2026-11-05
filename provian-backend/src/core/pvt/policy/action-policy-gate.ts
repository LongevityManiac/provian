/**
 * Fail-closed runtime resolver for prospective PVT action classifications.
 *
 * Gate 1 approved the 252-entry atomic accounting classification policy in plain English but
 * did not activate its manifest or make the full policy a runtime allowlist.
 * Only the 162 identifiers observed at the live cut line plus 73 non-overlapping
 * source-verified current emitters bypass the unseen-type queue. That 235-entry
 * recognition set does not activate any proposed weight or disposition. An
 * identifier absent from the evidence-backed set needs an explicit prospective
 * policy pointer.
 */

import type { Firestore } from 'firebase-admin/firestore';
import catalogCutLine from './pe-type-catalog.cut-line.json';
import {
  PROPOSED_ACTION_POLICY_ENTRIES,
  VALIDATED_LAUNCH_EMITTER_ADDITIONS,
} from './proposed-action-policy';
import {
  ACTION_POLICY_COLLECTION,
  PENDING_POLICY_COLLECTION,
  actionPolicyDocumentId,
  assertProspectiveClassificationSemantics,
  observePendingPolicyAction,
  type PendingPolicyAlertSender,
  type PendingPolicyMintDisposition,
  type PendingPolicyObservationResult,
  type ProspectiveActionPolicyDocument,
} from './pending-policy-queue';
import { isWitnessClass, type WitnessClass } from './evidence-class';
import {
  ACTION_POLICY_CATEGORIES,
  ACTION_POLICY_REASON_CODES,
  POLICY_REJECTION_REASON_CODES,
  type ActionPolicyCategory,
  type ActionEvidenceRequirement,
  type ActionPolicyReasonCode,
  type PolicyRejectionReasonCode,
  type ProposedActionPolicyEntry,
} from './types';

const ACTION_POLICY_CATEGORY_SET = new Set<ActionPolicyCategory>([
  ...ACTION_POLICY_CATEGORIES,
]);
const POLICY_REJECTION_REASON_CODE_SET = new Set<string>(POLICY_REJECTION_REASON_CODES);

export const UNKNOWN_ACTION_POLICY_REASON_CODE = 'unknown_action_type' as const;
export const KNOWN_LAUNCH_IDENTIFIER_REASON_CODE =
  'KNOWN_LAUNCH_IDENTIFIER_POLICY_NOT_ACTIVATED' as const;
export const REJECTED_ACTION_POLICY_REASON_CODE =
  'ACTION_TYPE_POLICY_REJECTED_RECORD_ONLY' as const;

export const PROPOSED_LAUNCH_ACTION_IDENTIFIERS: readonly string[] = Object.freeze(
  PROPOSED_ACTION_POLICY_ENTRIES
    .map((entry) => entry.action_type)
    .sort((left, right) => left.localeCompare(right)),
);

const proposedLaunchIdentifierSet = new Set(PROPOSED_LAUNCH_ACTION_IDENTIFIERS);
if (proposedLaunchIdentifierSet.size !== PROPOSED_LAUNCH_ACTION_IDENTIFIERS.length) {
  throw new Error('Proposed launch action manifest contains duplicate identifiers');
}

export const KNOWN_LAUNCH_EMITTER_IDENTIFIERS: readonly string[] = Object.freeze(
  [...new Set([
    ...catalogCutLine.entries.map((entry) => entry.action_type),
    ...VALIDATED_LAUNCH_EMITTER_ADDITIONS,
  ])].sort((left, right) => left.localeCompare(right)),
);
const knownLaunchEmitterSet = new Set(KNOWN_LAUNCH_EMITTER_IDENTIFIERS);

export type ActionPolicyPointerState =
  | 'not_read_for_known_identifier'
  | 'effective'
  | 'missing'
  | 'not_yet_effective'
  | 'invalid'
  | 'read_failed';

export interface KnownLaunchIdentifierResolution {
  readonly status: 'known_launch_identifier';
  readonly actionType: string;
  readonly recordedAtMs: number;
  readonly knownLaunchIdentifier: true;
  readonly policyActivated: false;
  readonly pointerState: 'not_read_for_known_identifier';
  readonly mintDisposition: null;
  readonly policyReviewState: 'not_required';
  readonly reasonCode: typeof KNOWN_LAUNCH_IDENTIFIER_REASON_CODE;
  readonly effectivePolicyVersion: null;
  readonly effectiveAt: null;
  readonly category: null;
  readonly baseActionWeightBps: null;
  readonly policyOverrideBps: null;
  readonly actionWeightBps: null;
  readonly evidenceRequirement: null;
  readonly financialAttestationNeutral: null;
  readonly allowVerifiedAttestationUpgrade: null;
  readonly amountIndependent: null;
  readonly fixedGrantSource: null;
  readonly canonicalEventRequired: null;
  readonly canonicalEventGroup: null;
  readonly beneficialOwnershipPolicy: null;
  readonly sessionLineagePolicy: null;
  readonly linkageTreatment: null;
  readonly evidenceResolutionMode: null;
}

export interface ClassifiedProspectiveResolution {
  readonly status: 'classified_prospective';
  readonly actionType: string;
  readonly recordedAtMs: number;
  readonly knownLaunchIdentifier: false;
  readonly policyActivated: true;
  readonly pointerState: 'effective';
  readonly mintDisposition: PendingPolicyMintDisposition;
  readonly policyReviewState: 'classified_prospective';
  readonly reasonCode: ActionPolicyReasonCode;
  readonly effectivePolicyVersion: string;
  readonly effectiveAt: number;
  readonly category: string;
  readonly baseActionWeightBps: number;
  readonly policyOverrideBps: number | null;
  readonly actionWeightBps: number;
  readonly evidenceRequirement: ActionEvidenceRequirement;
  readonly financialAttestationNeutral: boolean;
  readonly allowVerifiedAttestationUpgrade: boolean;
  readonly amountIndependent: true;
  readonly fixedGrantSource: ProposedActionPolicyEntry['fixed_grant_source'];
  readonly canonicalEventRequired: boolean;
  readonly canonicalEventGroup: string;
  readonly beneficialOwnershipPolicy: ProposedActionPolicyEntry['beneficial_ownership_policy'];
  readonly sessionLineagePolicy: ProposedActionPolicyEntry['session_lineage_policy'];
  readonly linkageTreatment: ProposedActionPolicyEntry['linkage_treatment'];
  readonly evidenceResolutionMode: ProposedActionPolicyEntry['evidence_resolution_mode'];
}

export interface PendingPolicyResolution {
  readonly status: 'pending_policy';
  readonly actionType: string;
  readonly recordedAtMs: number;
  readonly knownLaunchIdentifier: false;
  readonly policyActivated: false;
  readonly pointerState: Exclude<
    ActionPolicyPointerState,
    'not_read_for_known_identifier' | 'effective'
  >;
  readonly mintDisposition: 'record_only';
  readonly policyReviewState: 'pending_policy';
  readonly reasonCode: typeof UNKNOWN_ACTION_POLICY_REASON_CODE;
  readonly effectivePolicyVersion: null;
  readonly effectiveAt: null;
  readonly category: null;
  readonly baseActionWeightBps: null;
  readonly policyOverrideBps: null;
  readonly actionWeightBps: null;
  readonly evidenceRequirement: null;
  readonly financialAttestationNeutral: null;
  readonly allowVerifiedAttestationUpgrade: null;
  readonly amountIndependent: null;
  readonly fixedGrantSource: null;
  readonly canonicalEventRequired: null;
  readonly canonicalEventGroup: null;
  readonly beneficialOwnershipPolicy: null;
  readonly sessionLineagePolicy: null;
  readonly linkageTreatment: null;
  readonly evidenceResolutionMode: null;
}

export interface RejectedActionPolicyResolution {
  readonly status: 'rejected';
  readonly actionType: string;
  readonly recordedAtMs: number;
  readonly knownLaunchIdentifier: false;
  readonly policyActivated: true;
  readonly pointerState: 'effective';
  readonly mintDisposition: 'record_only';
  readonly policyReviewState: 'rejected';
  readonly reasonCode: typeof REJECTED_ACTION_POLICY_REASON_CODE;
  readonly rejectionReasonCode: string;
  readonly effectivePolicyVersion: string;
  readonly effectiveAt: number;
  readonly category: null;
  readonly baseActionWeightBps: null;
  readonly policyOverrideBps: null;
  readonly actionWeightBps: null;
  readonly evidenceRequirement: null;
  readonly financialAttestationNeutral: null;
  readonly allowVerifiedAttestationUpgrade: null;
  readonly amountIndependent: true;
  readonly fixedGrantSource: null;
  readonly canonicalEventRequired: null;
  readonly canonicalEventGroup: null;
  readonly beneficialOwnershipPolicy: null;
  readonly sessionLineagePolicy: null;
  readonly linkageTreatment: null;
  readonly evidenceResolutionMode: null;
}

export const CLASS_ADMITTED_REASON_CODE = 'witness_class_admitted' as const;

/**
 * — an action type with NO named row (pointer absent, or a queue entry that is
 * not a rejection, or a pointer/rejection not yet effective) submitted under a relay-assigned
 * witness class. The signed monetary template prices it at the class base; the gate only records
 * that no named ruling covers it. Economics fields are null here on purpose — the RAIL synthesizes
 * them from the signed bases, never the gate.
 */
export interface ClassAdmittedResolution {
  readonly status: 'class_admitted';
  readonly actionType: string;
  readonly recordedAtMs: number;
  readonly knownLaunchIdentifier: false;
  readonly policyActivated: true;
  readonly pointerState: 'missing' | 'not_yet_effective';
  readonly witnessClass: WitnessClass;
  readonly mintDisposition: null;
  readonly policyReviewState: 'class_admitted';
  readonly reasonCode: typeof CLASS_ADMITTED_REASON_CODE;
  readonly effectivePolicyVersion: null;
  readonly effectiveAt: null;
  readonly category: null;
  readonly baseActionWeightBps: null;
  readonly policyOverrideBps: null;
  readonly actionWeightBps: null;
  readonly evidenceRequirement: null;
  readonly financialAttestationNeutral: null;
  readonly allowVerifiedAttestationUpgrade: null;
  readonly amountIndependent: true;
  readonly fixedGrantSource: null;
  readonly canonicalEventRequired: null;
  readonly canonicalEventGroup: null;
  readonly beneficialOwnershipPolicy: null;
  readonly sessionLineagePolicy: null;
  readonly linkageTreatment: null;
  readonly evidenceResolutionMode: null;
}

export type ActionPolicyGateResolution =
  | KnownLaunchIdentifierResolution
  | ClassifiedProspectiveResolution
  | ClassAdmittedResolution
  | PendingPolicyResolution
  | RejectedActionPolicyResolution;

export interface ActionPolicyResolutionInput {
  readonly actionType: string;
  readonly recordedAtMs: number;
  /**
   * : the relay-ASSIGNED witness class of this submission (never body-supplied).
   * Present → an unnamed type is class-admitted; absent → the pre-build pending_policy outcome.
   */
  readonly witnessClass?: WitnessClass | null;
}

export interface ResolveAndObserveActionPolicyInput extends ActionPolicyResolutionInput {
  readonly peId: string;
  readonly integrationSource: string;
  readonly observedUnderPolicyVersion?: string;
  readonly now?: number;
}

export interface ResolveAndObserveActionPolicyResult {
  readonly resolution: ActionPolicyGateResolution;
  readonly queueAttempted: boolean;
  readonly observation: PendingPolicyObservationResult | null;
  /** Queue/alert-path failure detail for operations; economics remain fail-closed. */
  readonly observationError: string | null;
}

export function isProposedLaunchActionIdentifier(actionType: string): boolean {
  return proposedLaunchIdentifierSet.has(actionType);
}

export function isKnownLaunchEmitterIdentifier(actionType: string): boolean {
  return knownLaunchEmitterSet.has(actionType);
}

/**
 * Resolve policy exactly as of the PE's immutable record timestamp.
 *
 * Known launch identifiers deliberately return no economic decision because
 * the proposal is not activated. Unknown identifiers fail closed unless their
 * exact prospective pointer is both structurally valid and already effective.
 */
export async function resolveActionPolicyAtRecordTime(
  db: Firestore,
  input: ActionPolicyResolutionInput,
): Promise<ActionPolicyGateResolution> {
  validateResolutionInput(input);

  if (isKnownLaunchEmitterIdentifier(input.actionType)) {
    return knownLaunchIdentifierResolution(input);
  }

  let pointerState: PendingPolicyResolution['pointerState'] = 'missing';
  try {
    const snap = await db.collection(ACTION_POLICY_COLLECTION)
      .doc(actionPolicyDocumentId(input.actionType))
      .get();
    if (!snap.exists) return resolveAbsentPolicyPointer(db, input);

    const pointer = parseProspectiveActionPolicy(snap.data(), input.actionType);
    if (pointer === null) return pendingPolicyResolution(input, 'invalid');
    // / an unnamed type earns only from a signed matrix row. A
    // minting pointer in this collection carries no signature, so it is invalid (Unknown = Block).
    if (pointer.mint_disposition !== 'record_only' && pointer.mint_disposition !== 'ineligible_terminal') {
      return pendingPolicyResolution(input, 'invalid');
    }
    if (pointer.effective_at > input.recordedAtMs) {
      return unnamedResolution(input, 'not_yet_effective');
    }
    return classifiedProspectiveResolution(input, pointer);
  } catch {
    pointerState = 'read_failed';
  }
  return pendingPolicyResolution(input, pointerState);
}

async function resolveAbsentPolicyPointer(
  db: Firestore,
  input: ActionPolicyResolutionInput,
): Promise<ActionPolicyGateResolution> {
  try {
    const queueSnap = await db.collection(PENDING_POLICY_COLLECTION)
      .doc(actionPolicyDocumentId(input.actionType))
      .get();
    if (!queueSnap.exists) return unnamedResolution(input, 'missing');
    const queue = queueSnap.data();
    if (!isRecord(queue) || queue.action_type !== input.actionType) {
      return pendingPolicyResolution(input, 'invalid');
    }
    if (queue.policy_review_state !== 'rejected') {
      // The queue is an OVERRIDE-PROPOSAL surface, never an admission gate (§2.8).
      return unnamedResolution(input, 'missing');
    }
    if (
      !isSafeTimestamp(queue.effective_at)
      || !isNonEmptyString(queue.effective_policy_version)
      || !isPolicyRejectionReasonCode(queue.rejection_reason_code)
      || !isSafeTimestamp(queue.rejected_at)
      || queue.effective_at <= queue.rejected_at
      || !isNonEmptyString(queue.rejected_by)
    ) {
      return pendingPolicyResolution(input, 'invalid');
    }
    if (queue.effective_at > input.recordedAtMs) {
      return unnamedResolution(input, 'not_yet_effective');
    }
    return rejectedActionPolicyResolution(input, {
      effectiveAt: queue.effective_at,
      effectivePolicyVersion: queue.effective_policy_version,
      rejectionReasonCode: queue.rejection_reason_code,
    });
  } catch {
    return pendingPolicyResolution(input, 'read_failed');
  }
}

/**
 * Resolve and durably observe a genuinely unknown identifier. The observation
 * and notification path cannot make an unknown action eligible: a failed alert
 * or failed queue write returns the original record-only resolution.
 */
export async function resolveAndObserveActionPolicy(
  db: Firestore,
  input: ResolveAndObserveActionPolicyInput,
  sender?: PendingPolicyAlertSender,
): Promise<ResolveAndObserveActionPolicyResult> {
  assertNonEmpty(input.peId, 'peId');
  assertNonEmpty(input.integrationSource, 'integrationSource');
  if (input.now !== undefined) assertSafeTimestamp(input.now, 'now');

  const resolution = await resolveActionPolicyAtRecordTime(db, input);
  if (resolution.status !== 'pending_policy') {
    return Object.freeze({
      resolution,
      queueAttempted: false,
      observation: null,
      observationError: null,
    });
  }

  try {
    const observation = await observePendingPolicyAction(
      db,
      {
        actionType: input.actionType,
        peId: input.peId,
        integrationSource: input.integrationSource,
        policyVersion: input.observedUnderPolicyVersion,
        now: input.now,
      },
      sender,
    );
    return Object.freeze({
      resolution,
      queueAttempted: true,
      observation,
      observationError: null,
    });
  } catch (error: unknown) {
    return Object.freeze({
      resolution,
      queueAttempted: true,
      observation: null,
      observationError: safeError(error),
    });
  }
}

function knownLaunchIdentifierResolution(
  input: ActionPolicyResolutionInput,
): KnownLaunchIdentifierResolution {
  return Object.freeze({
    status: 'known_launch_identifier',
    actionType: input.actionType,
    recordedAtMs: input.recordedAtMs,
    knownLaunchIdentifier: true,
    policyActivated: false,
    pointerState: 'not_read_for_known_identifier',
    mintDisposition: null,
    policyReviewState: 'not_required',
    reasonCode: KNOWN_LAUNCH_IDENTIFIER_REASON_CODE,
    effectivePolicyVersion: null,
    effectiveAt: null,
    category: null,
    baseActionWeightBps: null,
    policyOverrideBps: null,
    actionWeightBps: null,
    evidenceRequirement: null,
    financialAttestationNeutral: null,
    allowVerifiedAttestationUpgrade: null,
    amountIndependent: null,
    fixedGrantSource: null,
    canonicalEventRequired: null,
    canonicalEventGroup: null,
    beneficialOwnershipPolicy: null,
    sessionLineagePolicy: null,
    linkageTreatment: null,
    evidenceResolutionMode: null,
  });
}

function classifiedProspectiveResolution(
  input: ActionPolicyResolutionInput,
  pointer: ProspectiveActionPolicyDocument,
): ClassifiedProspectiveResolution {
  return Object.freeze({
    status: 'classified_prospective',
    actionType: input.actionType,
    recordedAtMs: input.recordedAtMs,
    knownLaunchIdentifier: false,
    policyActivated: true,
    pointerState: 'effective',
    mintDisposition: pointer.mint_disposition,
    policyReviewState: 'classified_prospective',
    reasonCode: pointer.disposition_reason_code,
    effectivePolicyVersion: pointer.effective_policy_version,
    effectiveAt: pointer.effective_at,
    category: pointer.category,
    baseActionWeightBps: pointer.base_action_weight_bps,
    policyOverrideBps: pointer.policy_override_bps,
    actionWeightBps: pointer.policy_override_bps ?? pointer.base_action_weight_bps,
    evidenceRequirement: pointer.evidence_requirement,
    financialAttestationNeutral: pointer.financial_attestation_neutral,
    allowVerifiedAttestationUpgrade: pointer.allow_verified_attestation_upgrade,
    amountIndependent: true,
    fixedGrantSource: pointer.fixed_grant_source,
    canonicalEventRequired: pointer.canonical_event_required,
    canonicalEventGroup: pointer.canonical_event_group,
    beneficialOwnershipPolicy: pointer.beneficial_ownership_policy,
    sessionLineagePolicy: pointer.session_lineage_policy,
    linkageTreatment: pointer.linkage_treatment,
    evidenceResolutionMode: pointer.evidence_resolution_mode,
  });
}

/**
 * §2.8: no named ruling covers this type (positively established — not a read failure). With a
 * relay-assigned witness class the type is CLASS-ADMITTED; without one it stays pending_policy
 * (record_only), exactly as before the build. `invalid` / `read_failed` never reach here (Unknown =
 * Block: a pointer we could not read is not "no pointer").
 */
function unnamedResolution(
  input: ActionPolicyResolutionInput,
  pointerState: 'missing' | 'not_yet_effective',
): ClassAdmittedResolution | PendingPolicyResolution {
  if (!isWitnessClass(input.witnessClass)) return pendingPolicyResolution(input, pointerState);
  return Object.freeze({
    status: 'class_admitted',
    actionType: input.actionType,
    recordedAtMs: input.recordedAtMs,
    knownLaunchIdentifier: false,
    policyActivated: true,
    pointerState,
    witnessClass: input.witnessClass,
    mintDisposition: null,
    policyReviewState: 'class_admitted',
    reasonCode: CLASS_ADMITTED_REASON_CODE,
    effectivePolicyVersion: null,
    effectiveAt: null,
    category: null,
    baseActionWeightBps: null,
    policyOverrideBps: null,
    actionWeightBps: null,
    evidenceRequirement: null,
    financialAttestationNeutral: null,
    allowVerifiedAttestationUpgrade: null,
    amountIndependent: true,
    fixedGrantSource: null,
    canonicalEventRequired: null,
    canonicalEventGroup: null,
    beneficialOwnershipPolicy: null,
    sessionLineagePolicy: null,
    linkageTreatment: null,
    evidenceResolutionMode: null,
  });
}

function pendingPolicyResolution(
  input: ActionPolicyResolutionInput,
  pointerState: PendingPolicyResolution['pointerState'],
): PendingPolicyResolution {
  return Object.freeze({
    status: 'pending_policy',
    actionType: input.actionType,
    recordedAtMs: input.recordedAtMs,
    knownLaunchIdentifier: false,
    policyActivated: false,
    pointerState,
    mintDisposition: 'record_only',
    policyReviewState: 'pending_policy',
    reasonCode: UNKNOWN_ACTION_POLICY_REASON_CODE,
    effectivePolicyVersion: null,
    effectiveAt: null,
    category: null,
    baseActionWeightBps: null,
    policyOverrideBps: null,
    actionWeightBps: null,
    evidenceRequirement: null,
    financialAttestationNeutral: null,
    allowVerifiedAttestationUpgrade: null,
    amountIndependent: null,
    fixedGrantSource: null,
    canonicalEventRequired: null,
    canonicalEventGroup: null,
    beneficialOwnershipPolicy: null,
    sessionLineagePolicy: null,
    linkageTreatment: null,
    evidenceResolutionMode: null,
  });
}

function rejectedActionPolicyResolution(
  input: ActionPolicyResolutionInput,
  rejection: {
    effectiveAt: number;
    effectivePolicyVersion: string;
    rejectionReasonCode: string;
  },
): RejectedActionPolicyResolution {
  return Object.freeze({
    status: 'rejected',
    actionType: input.actionType,
    recordedAtMs: input.recordedAtMs,
    knownLaunchIdentifier: false,
    policyActivated: true,
    pointerState: 'effective',
    mintDisposition: 'record_only',
    policyReviewState: 'rejected',
    reasonCode: REJECTED_ACTION_POLICY_REASON_CODE,
    rejectionReasonCode: rejection.rejectionReasonCode,
    effectivePolicyVersion: rejection.effectivePolicyVersion,
    effectiveAt: rejection.effectiveAt,
    category: null,
    baseActionWeightBps: null,
    policyOverrideBps: null,
    actionWeightBps: null,
    evidenceRequirement: null,
    financialAttestationNeutral: null,
    allowVerifiedAttestationUpgrade: null,
    amountIndependent: true,
    fixedGrantSource: null,
    canonicalEventRequired: null,
    canonicalEventGroup: null,
    beneficialOwnershipPolicy: null,
    sessionLineagePolicy: null,
    linkageTreatment: null,
    evidenceResolutionMode: null,
  });
}

function parseProspectiveActionPolicy(
  value: unknown,
  expectedActionType: string,
): ProspectiveActionPolicyDocument | null {
  if (!isRecord(value)) return null;
  if (value.action_type !== expectedActionType) return null;
  if (value.policy_review_state !== 'classified_prospective') return null;
  if (!isNonEmptyString(value.effective_policy_version)) return null;
  if (!isSafeTimestamp(value.effective_at)) return null;
  if (!isPendingPolicyMintDisposition(value.mint_disposition)) return null;
  if (!isActionPolicyReasonCode(value.disposition_reason_code)) return null;
  if (!isActionPolicyCategory(value.category)) return null;
  if (
    !isNonNegativeSafeInteger(value.base_action_weight_bps)
    || value.base_action_weight_bps > 100_000
  ) {
    return null;
  }
  if (
    value.policy_override_bps !== null
    && (
      !isNonNegativeSafeInteger(value.policy_override_bps)
      || value.policy_override_bps > 100_000
    )
  ) return null;
  if (!isActionEvidenceRequirement(value.evidence_requirement)) return null;
  if (typeof value.financial_attestation_neutral !== 'boolean') return null;
  if (typeof value.allow_verified_attestation_upgrade !== 'boolean') return null;
  if (value.financial_attestation_neutral && value.allow_verified_attestation_upgrade) return null;
  if (value.amount_independent !== true) return null;
  if (!isFixedGrantSource(value.fixed_grant_source)) return null;
  // Generic unseen-type classification is never an authority to add a Genesis
  // bounty. Genesis actions come only from the separately approved manifest.
  if (value.fixed_grant_source !== 'none') return null;
  if (typeof value.canonical_event_required !== 'boolean') return null;
  if (!isNonEmptyString(value.canonical_event_group)) return null;
  if (value.canonical_event_required !== (value.evidence_requirement !== 'none')) return null;
  if (!isBeneficialOwnershipPolicy(value.beneficial_ownership_policy)) return null;
  if (!isSessionLineagePolicy(value.session_lineage_policy)) return null;
  if (!isGenericClassificationLinkageTreatment(value.linkage_treatment)) return null;
  if (!isEvidenceResolutionMode(value.evidence_resolution_mode)) return null;
  const effectiveWeightBps = value.policy_override_bps ?? value.base_action_weight_bps;
  if (
    (value.mint_disposition === 'record_only' || value.mint_disposition === 'ineligible_terminal')
    && effectiveWeightBps !== 0
  ) return null;
  if (
    value.mint_disposition !== 'record_only'
    && value.mint_disposition !== 'ineligible_terminal'
    && effectiveWeightBps === 0
  ) return null;
  if (
    value.mint_disposition === 'pending_evidence'
    && value.evidence_resolution_mode !== 'linked_evidence_pe_only'
  ) return null;
  if (
    (value.mint_disposition === 'record_only' || value.mint_disposition === 'ineligible_terminal')
    && value.evidence_resolution_mode !== 'not_applicable'
  ) return null;
  if (
    value.mint_disposition !== 'record_only'
    && value.mint_disposition !== 'ineligible_terminal'
    && value.linkage_treatment !== 'record_time_verified_policy_multiplier'
  ) return null;
  if (!isSafeTimestamp(value.created_at)) return null;
  if (value.effective_at <= value.created_at) return null;
  if (!isNonEmptyString(value.created_by)) return null;
  if (value.prospective_only !== true) return null;

  const parsed: ProspectiveActionPolicyDocument = {
    action_type: value.action_type,
    policy_review_state: 'classified_prospective',
    effective_policy_version: value.effective_policy_version,
    effective_at: value.effective_at,
    mint_disposition: value.mint_disposition,
    disposition_reason_code: value.disposition_reason_code,
    category: value.category,
    base_action_weight_bps: value.base_action_weight_bps,
    policy_override_bps: value.policy_override_bps,
    evidence_requirement: value.evidence_requirement,
    financial_attestation_neutral: value.financial_attestation_neutral,
    allow_verified_attestation_upgrade: value.allow_verified_attestation_upgrade,
    amount_independent: true,
    fixed_grant_source: value.fixed_grant_source,
    canonical_event_required: value.canonical_event_required,
    canonical_event_group: value.canonical_event_group,
    beneficial_ownership_policy: value.beneficial_ownership_policy,
    session_lineage_policy: value.session_lineage_policy,
    linkage_treatment: value.linkage_treatment,
    evidence_resolution_mode: value.evidence_resolution_mode,
    created_at: value.created_at,
    created_by: value.created_by,
    prospective_only: true,
  };
  try {
    assertProspectiveClassificationSemantics({
      actionType: parsed.action_type,
      effectivePolicyVersion: parsed.effective_policy_version,
      effectiveAt: parsed.effective_at,
      disposition: parsed.mint_disposition,
      reasonCode: parsed.disposition_reason_code,
      category: parsed.category,
      baseActionWeightBps: parsed.base_action_weight_bps,
      policyOverrideBps: parsed.policy_override_bps,
      evidenceRequirement: parsed.evidence_requirement,
      financialAttestationNeutral: parsed.financial_attestation_neutral,
      allowVerifiedAttestationUpgrade: parsed.allow_verified_attestation_upgrade,
      fixedGrantSource: parsed.fixed_grant_source,
      canonicalEventRequired: parsed.canonical_event_required,
      canonicalEventGroup: parsed.canonical_event_group,
      beneficialOwnershipPolicy: parsed.beneficial_ownership_policy,
      sessionLineagePolicy: parsed.session_lineage_policy,
      linkageTreatment: parsed.linkage_treatment,
      evidenceResolutionMode: parsed.evidence_resolution_mode,
      operatorId: parsed.created_by,
      now: parsed.created_at,
    });
  } catch {
    return null;
  }
  return parsed;
}

function isActionEvidenceRequirement(value: unknown): value is ActionEvidenceRequirement {
  return value === 'none'
    || value === 'base_final_chain_receipt'
    || value === 'valid_genesis_reservation'
    || value === 'verified_institution_lifecycle'
    || value === 'verified_substantive_outcome'
    || value === 'verified_compute_or_work'
    || value === 'verified_external_service_witness'
    || value === 'operator_policy_review';
}

function isActionPolicyReasonCode(value: unknown): value is ActionPolicyReasonCode {
  return typeof value === 'string'
    && (ACTION_POLICY_REASON_CODES as readonly string[]).includes(value);
}

function isActionPolicyCategory(value: unknown): value is ActionPolicyCategory {
  return typeof value === 'string'
    && ACTION_POLICY_CATEGORY_SET.has(value as ActionPolicyCategory);
}

function isPolicyRejectionReasonCode(value: unknown): value is PolicyRejectionReasonCode {
  return typeof value === 'string' && POLICY_REJECTION_REASON_CODE_SET.has(value);
}

function isFixedGrantSource(
  value: unknown,
): value is ProposedActionPolicyEntry['fixed_grant_source'] {
  return value === 'none' || value === 'genesis_campaign_reservation';
}

function isBeneficialOwnershipPolicy(
  value: unknown,
): value is ProposedActionPolicyEntry['beneficial_ownership_policy'] {
  return value === 'record_only_if_self_shared_or_churn' || value === 'not_applicable';
}

function isSessionLineagePolicy(
  value: unknown,
): value is ProposedActionPolicyEntry['session_lineage_policy'] {
  return value === 'required' || value === 'optional' || value === 'not_applicable';
}

function isGenericClassificationLinkageTreatment(
  value: unknown,
): value is Exclude<
  ProposedActionPolicyEntry['linkage_treatment'],
  'genesis_contributor_only_no_linked_beneficiary_routing'
> {
  return value === 'record_time_verified_policy_multiplier' || value === 'none_record_only';
}

function isEvidenceResolutionMode(
  value: unknown,
): value is ProposedActionPolicyEntry['evidence_resolution_mode'] {
  return value === 'projection_with_verified_evidence'
    || value === 'linked_evidence_pe_only'
    || value === 'not_applicable';
}

function isPendingPolicyMintDisposition(value: unknown): value is PendingPolicyMintDisposition {
  return value === 'eligible'
    || value === 'pending_evidence'
    || value === 'pending_review'
    || value === 'record_only'
    || value === 'ineligible_terminal';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validateResolutionInput(input: ActionPolicyResolutionInput): void {
  assertNonEmpty(input.actionType, 'actionType');
  assertSafeTimestamp(input.recordedAtMs, 'recordedAtMs');
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`${label}_required`);
}

function assertSafeTimestamp(value: number, label: string): void {
  if (!isSafeTimestamp(value)) throw new Error(`${label}_must_be_a_non_negative_safe_integer`);
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
}
