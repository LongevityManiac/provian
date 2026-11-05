/**
 * Pure atomic accounting Genesis reservation kernel.
 *
 * Admission is time-bounded and exactly-once. It deliberately has no campaign
 * pool, participant ceiling, per-action aggregate cap, or epoch-admission cap.
 * The weekly Genesis sub-budget is a settlement concern and therefore cannot
 * reject, trim, cancel, or reprice a valid in-window reservation.
 */

import crypto from 'crypto';
import {
  GENESIS_GRANT_MULTIPLIER_BPS,
  SUPERSEDED_GENESIS_POLICY_BINDINGS,
  type ProposedGenesisBountyPolicy,
  type ProposedGenesisCampaignPolicyManifest,
  type SupersededGenesisPolicyBinding,
} from './proposed-genesis-policy';
import {
  approvalVerifierConfigFromEnv,
  type SshApprovalSignature,
  type SshApprovalVerifierConfig,
} from './approval-signature';
import { verifyCurrentPvtManifestApproval } from './current-approval';
import { isApprovedGenesisActivation } from './approved-genesis-activation-approval';
import { isRejectedPvtApprovalManifestSha256 } from './rejected-approval-manifests';
import { PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256 } from './pvt9-approval-manifest.generated';
import type { PVTAtomic } from './types';

export const GENESIS_LEDGER_SCHEMA_VERSION = 'pvt-genesis-ledger/v2' as const;

const BPS_DENOMINATOR = 10_000n;
/**
 * The canonical atomic-string form. EXPORTED () so a test asserting
 * this shape binds to the single source the code reads instead of declaring its
 * own copy — the defect class.
 */
export const CANONICAL_UNSIGNED_INTEGER = /^(0|[1-9][0-9]*)$/;
const CANONICAL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/;
const SHA256_HASH = /^sha256:[a-f0-9]{64}$/;

const ACTIVATION_KEYS = Object.freeze([
  'approval_status',
  'approval_manifest_sha256',
  'approval_signature',
  'frank_approval_audit_id',
  'approved_policy_version',
  'approved_policy_manifest_hash',
  'approved_monetary_policy_template_hash',
  'effective_at_ms',
  'admission_closed_at_ms',
  'admission_close_audit_id',
  'grants_enabled',
  'genesis_kill_switch_active',
  'canonical_pvt_manifest_id',
  'ledger_namespace',
  'prior_reservations_reconciled',
  'operator_activation_audit_id',
] as const);

const RESERVATION_KEYS = Object.freeze([
  'reservation_id',
  'dedupe_key',
  'policy_version',
  'policy_manifest_hash',
  'canonical_pvt_manifest_id',
  'canonical_bounty_key',
  'emitted_action_type',
  'pe_id',
  'wallet_id',
  'economic_actor_id',
  'immutable_anchor_kind',
  'immutable_anchor_id',
  'evidence_id',
  'evidence_hash',
  'qualifying_act_at_ms',
  'wallet_created_at_ms',
  'wallet_created_evidence_id',
  'wallet_created_evidence_hash',
  'fixed_grant_atomic',
  'decay_multiplier_bps',
  'reserved_atomic',
  'state_revision_before',
  'state_revision_after',
  'reserved_at_ms',
] as const);

const LEDGER_STATE_KEYS = Object.freeze([
  'schema_version',
  'ledger_namespace',
  'revision',
  'last_policy_version',
  'total_reserved_atomic',
  'wallet_reserved_atomic',
  'reservations_by_dedupe_key',
] as const);

// An in-memory capability prevents callers from fabricating a receipt and
// feeding it directly into the economic kernel. The Firestore runtime adapter
// stores the already-computed immutable snapshot with the reservation, so
// process restart never needs a public receipt-rehydration bypass.
const authenticReservationReceipts = new WeakSet<object>();

export function isAuthenticGenesisReservationReceipt(value: unknown): boolean {
  return typeof value === 'object'
    && value !== null
    && authenticReservationReceipts.has(value);
}

export interface GenesisCampaignActivation {
  readonly approval_status: 'approved_by_frank' | 'requires_frank_approval';
  readonly approval_manifest_sha256: string | null;
  readonly approval_signature: SshApprovalSignature | null;
  readonly frank_approval_audit_id: string | null;
  readonly approved_policy_version: string | null;
  readonly approved_policy_manifest_hash: string | null;
  readonly approved_monetary_policy_template_hash: string | null;
  readonly effective_at_ms: number | null;
  /**
   * Evented admission cutoff. Null while open. Closing sets grants_enabled=false
   * and this timestamp atomically; qualifying acts at/before the cutoff remain
   * reservable, while later acts are denied without affecting prior backlog.
   */
  readonly admission_closed_at_ms: number | null;
  readonly admission_close_audit_id: string | null;
  readonly grants_enabled: boolean;
  readonly genesis_kill_switch_active: boolean;
  readonly canonical_pvt_manifest_id: string | null;
  readonly ledger_namespace: string;
  readonly prior_reservations_reconciled: boolean;
  readonly operator_activation_audit_id: string | null;
}

export const INERT_GENESIS_CAMPAIGN_ACTIVATION: GenesisCampaignActivation = Object.freeze({
  approval_status: 'requires_frank_approval',
  approval_manifest_sha256: null,
  approval_signature: null,
  frank_approval_audit_id: null,
  approved_policy_version: null,
  approved_policy_manifest_hash: null,
  approved_monetary_policy_template_hash: null,
  effective_at_ms: null,
  admission_closed_at_ms: null,
  admission_close_audit_id: null,
  grants_enabled: false,
  genesis_kill_switch_active: true,
  canonical_pvt_manifest_id: null,
  ledger_namespace: 'pvt9_genesis_pending',
  prior_reservations_reconciled: false,
  operator_activation_audit_id: null,
});

export interface GenesisImmutableAnchor {
  readonly anchor_kind: string;
  readonly anchor_id: string;
}

export interface GenesisQualifyingActEvidence {
  readonly verification_status: 'verified';
  readonly evidence_id: string;
  readonly evidence_hash: string;
  readonly subject_wallet_id: string;
  readonly canonical_bounty_key: string;
  readonly qualifying_act: string;
  readonly immutable_anchor_kind: string;
  readonly immutable_anchor_id: string;
  readonly qualifying_act_at_ms: number;
}

export interface GenesisReservationInput {
  readonly pe_id: string;
  readonly action_type: string;
  readonly wallet_id: string;
  readonly economic_actor_id: string;
  readonly immutable_anchor: GenesisImmutableAnchor;
  readonly qualifying_act_evidence: GenesisQualifyingActEvidence;
}

/** Verified relay facts, never copied from an untrusted submission. */
export interface GenesisReservationObservationContext {
  readonly verification_status: 'verified';
  readonly observed_at_ms: number;
  readonly wallet_created: {
    readonly wallet_id: string;
    readonly created_at_ms: number;
    readonly evidence_id: string;
    readonly evidence_hash: string;
    readonly source: 'authoritative_wallet_record';
  };
}

export interface GenesisReservationLedgerEntry {
  readonly reservation_id: string;
  readonly dedupe_key: string;
  readonly policy_version: string;
  readonly policy_manifest_hash: string;
  readonly canonical_pvt_manifest_id: string;
  readonly canonical_bounty_key: string;
  readonly emitted_action_type: string;
  readonly pe_id: string;
  readonly wallet_id: string;
  readonly economic_actor_id: string;
  readonly immutable_anchor_kind: string;
  readonly immutable_anchor_id: string;
  readonly evidence_id: string;
  readonly evidence_hash: string;
  readonly qualifying_act_at_ms: number;
  readonly wallet_created_at_ms: number;
  readonly wallet_created_evidence_id: string;
  readonly wallet_created_evidence_hash: string;
  readonly fixed_grant_atomic: PVTAtomic;
  readonly decay_multiplier_bps: number;
  readonly reserved_atomic: PVTAtomic;
  readonly state_revision_before: string;
  readonly state_revision_after: string;
  readonly reserved_at_ms: number;
}

export interface GenesisCampaignLedgerState {
  readonly schema_version: typeof GENESIS_LEDGER_SCHEMA_VERSION;
  readonly ledger_namespace: string;
  readonly revision: string;
  readonly last_policy_version: string | null;
  /** Audit total only. It is not a cap and is never consulted for admission. */
  readonly total_reserved_atomic: PVTAtomic;
  readonly wallet_reserved_atomic: Readonly<Record<string, PVTAtomic>>;
  readonly reservations_by_dedupe_key: Readonly<Record<string, GenesisReservationLedgerEntry>>;
}

export type GenesisReservationDenyReason =
  | 'genesis_kill_switch_active'
  | 'proposal_not_approved'
  | 'successor_not_armed'
  | 'policy_not_effective'
  | 'campaign_not_started'
  | 'campaign_closed'
  | 'invalid_policy'
  | 'invalid_request'
  | 'unverified_observation_context'
  | 'invalid_state'
  | 'ledger_namespace_mismatch'
  | 'unknown_bounty_action'
  | 'missing_qualifying_evidence'
  | 'invalid_immutable_anchor'
  | 'replay'
  // `decayed_to_zero` was removed with the taper. a constant
  // 10000-bps multiplier a fixed grant can never price to zero, so the branch
  // was unreachable — the "guard whose violating case cannot be
  // constructed" shape. The wallet lifetime cap remains the only zero path.
  | 'wallet_lifetime_cap_reached';

export type GenesisActivationApprovalVerifier = (
  activation: GenesisCampaignActivation,
) => boolean;

export interface GenesisReservationDiagnostics {
  readonly canonical_bounty_key: string | null;
  readonly fixed_grant_atomic: PVTAtomic;
  readonly wallet_age_ms: number;
  readonly decay_multiplier_bps: number;
  readonly desired_after_decay_atomic: PVTAtomic;
  readonly wallet_lifetime_remaining_atomic: PVTAtomic;
}

export interface GenesisReservationAllowedResult {
  readonly allowed: true;
  readonly reason: 'reserved';
  readonly reservation: GenesisReservationLedgerEntry;
  readonly diagnostics: GenesisReservationDiagnostics;
  readonly next_state: GenesisCampaignLedgerState;
}

export interface GenesisReservationDeniedResult {
  readonly allowed: false;
  readonly reason: GenesisReservationDenyReason;
  readonly reservation: null;
  readonly diagnostics: GenesisReservationDiagnostics;
  readonly next_state: GenesisCampaignLedgerState;
}

export type GenesisReservationResult =
  | GenesisReservationAllowedResult
  | GenesisReservationDeniedResult;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isCanonicalIdentifier(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_IDENTIFIER.test(value);
}

function isCanonicalAtomic(value: unknown): value is PVTAtomic {
  return typeof value === 'string' && CANONICAL_UNSIGNED_INTEGER.test(value);
}

function atomic(value: bigint): PVTAtomic {
  if (value < 0n) throw new Error('negative atomic quantity');
  return value.toString(10);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('non-canonical manifest number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!isPlainObject(value)) throw new Error('non-canonical manifest value');
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function hashGenesisCampaignPolicyManifest(
  manifest: ProposedGenesisCampaignPolicyManifest,
): string {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(manifest)).digest('hex')}`;
}

function encodePart(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function expectedReservationId(ledgerNamespace: string, dedupeKey: string): string {
  return `genesis-reservation:${encodePart(`${ledgerNamespace}:${dedupeKey}`)}`;
}

export function buildGenesisDedupeKey(
  canonicalBountyKey: string,
  anchor: GenesisImmutableAnchor,
): string {
  if (!isCanonicalIdentifier(canonicalBountyKey)
    || !isCanonicalIdentifier(anchor.anchor_kind)
    || !isCanonicalIdentifier(anchor.anchor_id)) {
    throw new Error('invalid Genesis dedupe input');
  }
  return `${canonicalBountyKey}:${anchor.anchor_kind}:${encodePart(anchor.anchor_id)}`;
}

export function createEmptyGenesisLedgerState(ledgerNamespace: string): GenesisCampaignLedgerState {
  if (!isCanonicalIdentifier(ledgerNamespace)) {
    throw new Error('ledgerNamespace must be a canonical identifier');
  }
  return Object.freeze({
    schema_version: GENESIS_LEDGER_SCHEMA_VERSION,
    ledger_namespace: ledgerNamespace,
    revision: '0',
    last_policy_version: null,
    total_reserved_atomic: '0',
    wallet_reserved_atomic: Object.freeze({}),
    reservations_by_dedupe_key: Object.freeze({}),
  });
}

export function resolveGenesisBountyPolicy(
  manifest: ProposedGenesisCampaignPolicyManifest,
  actionType: string,
): ProposedGenesisBountyPolicy | null {
  return manifest.bounties.find((bounty) => bounty.emitted_action_types.includes(actionType)) ?? null;
}

type ArmedGenesisCampaignPolicyManifest = ProposedGenesisCampaignPolicyManifest & {
  readonly arming: ProposedGenesisCampaignPolicyManifest['arming'] & {
    readonly state: 'armed_by_explicit_pvt9_activation';
    readonly grants_enabled: true;
    readonly canonical_pvt_manifest_id: string;
  };
  readonly window: ProposedGenesisCampaignPolicyManifest['window'] & {
    readonly start_ms: number;
    readonly end_ms: number;
    readonly approval: {
      readonly status: 'wp12_launch_dates_explicitly_approved';
      readonly rationale: string;
    };
  };
  readonly bounties: readonly (ProposedGenesisBountyPolicy & {
    readonly launch_armed: true;
    readonly activation: 'explicit_pvt9_launch_activation';
  })[];
};

function validateManifest(
  manifest: ProposedGenesisCampaignPolicyManifest,
): manifest is ArmedGenesisCampaignPolicyManifest {
  if (manifest.schema_version !== 'pvt-genesis-campaign-policy/v2'
    || !isCanonicalIdentifier(manifest.policy_version)
    || manifest.status !== 'gate_1_plain_english_approved'
    || manifest.chain_id !== 8453
    || manifest.effective_at !== null
    || manifest.arming.state !== 'armed_by_explicit_pvt9_activation'
    || manifest.arming.grants_enabled !== true
    || !isCanonicalIdentifier(manifest.arming.canonical_pvt_manifest_id)
    || !isCanonicalIdentifier(manifest.arming.ledger_namespace)
    || manifest.arming.ledger_namespace === 'pvt9_genesis_pending'
    || manifest.arming.requires_reconciled_prior_reservations !== true
    || manifest.arming.requires_operator_activation_audit !== true
    || manifest.arming.prior_configuration_carries_forward !== false
    || !isSafeInteger(manifest.window.start_ms)
    || !isSafeInteger(manifest.window.end_ms)
    || manifest.window.start_ms > manifest.window.end_ms
    || manifest.window.approval.status !== 'wp12_launch_dates_explicitly_approved'
    || manifest.window.admission_rule
      !== 'qualifying_act_must_be_in_window_pre_cutoff_outbox_may_reserve_after_close'
    || manifest.window.close_behavior !== 'stop_new_qualifications_preserve_pre_cutoff_reservations'
    || manifest.arming.admission_close_control !== 'evented_cutoff_config_flip'
    || manifest.arming.pre_cutoff_outbox_behavior !== 'preserve_and_reserve_exactly'
    || manifest.grant_multiplier.mode !== 'fixed_grant_no_time_based_reduction'
    || manifest.grant_multiplier.multiplier_bps !== GENESIS_GRANT_MULTIPLIER_BPS
    || manifest.grant_multiplier.multiplier_formula
      !== 'constant_10000_bps_independent_of_elapsed_time'
    || manifest.grant_multiplier.grant_formula !== 'fixed_grant_atomic'
    || manifest.grant_multiplier.rounding !== 'exact_no_rounding'
    || !isCanonicalAtomic(manifest.caps.per_wallet_lifetime_atomic)
    || BigInt(manifest.caps.per_wallet_lifetime_atomic) <= 0n
    || manifest.caps.admission_total_pool !== 'none'
    || manifest.caps.aggregate_per_action_caps !== 'none'
    || manifest.caps.participant_cap !== 'none'
    || manifest.caps.reservation_rule !== 'minimum_of_fixed_grant_and_wallet_lifetime_remaining'
    || manifest.caps.debit_semantics !== 'compare_and_swap_wallet_ledger_dedupe_and_reservation_atomically'
    || manifest.settlement.admission_independent !== true
    || manifest.settlement.epoch_duration_seconds !== 604_800
    || !isCanonicalAtomic(manifest.settlement.initial_genesis_sub_budget_atomic)
    || !isCanonicalAtomic(manifest.settlement.initial_combined_system_cap_atomic)
    || manifest.settlement.initial_flat_epoch_count !== 12
    || manifest.settlement.genesis_sub_budget_change_control
      !== 'append_only_signed_effective_epoch_policy_events'
    || manifest.settlement.initial_event_binding !== 'exact_launch_approval_manifest'
    || manifest.settlement.epoch_snapshot_rule
      !== 'event_id_hash_approval_hash_immutable_per_epoch'
    || manifest.bounties.length !== 3) {
    return false;
  }
  const actions = new Set<string>();
  const bountyKeys = new Set<string>();
  for (const bounty of manifest.bounties) {
    if (!isCanonicalIdentifier(bounty.canonical_bounty_key)
      || bountyKeys.has(bounty.canonical_bounty_key)
      || bounty.emitted_action_types.length !== 1
      || !isCanonicalIdentifier(bounty.emitted_action_types[0])
      || actions.has(bounty.emitted_action_types[0])
      || !isCanonicalIdentifier(bounty.qualifying_act)
      || !isCanonicalAtomic(bounty.fixed_grant_atomic)
      || BigInt(bounty.fixed_grant_atomic) <= 0n
      || bounty.launch_armed !== true
      || bounty.activation !== 'explicit_pvt9_launch_activation') {
      return false;
    }
    bountyKeys.add(bounty.canonical_bounty_key);
    actions.add(bounty.emitted_action_types[0]);
  }
  return actions.has('genesis_human_signup')
    && actions.has('genesis_signup')
    && actions.has('genesis_device_link');
}

function hasStructuredApprovalSignature(
  value: unknown,
): value is SshApprovalSignature {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (!hasExactKeys(value as Record<string, unknown>, [
    'scheme',
    'signer_identity',
    'namespace',
    'public_key_sha256',
    'armored_signature',
  ])) return false;
  const signature = value as Partial<SshApprovalSignature>;
  return signature.scheme === 'sshsig-ed25519'
    && signature.signer_identity === 'frank'
    && signature.namespace === 'provian-pvt-policy'
    && typeof signature.public_key_sha256 === 'string'
    && /^sha256:[a-f0-9]{64}$/.test(signature.public_key_sha256)
    && typeof signature.armored_signature === 'string'
    && signature.armored_signature.length > 0;
}

/**
 * Cryptographically bind Genesis activation to the exact embedded approval
 * manifest.
 *
 * TWO ROUTES, BOTH REQUIRING THE SAME FROZEN BYTES.
 *
 * The three leading conjuncts are unchanged and apply to BOTH routes: the
 * document must name the exact frozen Gate 1 digest, that digest must not be on
 * the rejection ledger, and the signature must be structurally well formed.
 *
 * ROUTE 1 — `verifyCurrentPvtManifestApproval`, UNTOUCHED. It additionally
 * requires the manifest bytes themselves to declare `signing_permitted: true`
 * and the approvable status. The checked-in Gate 1 manifest declares neither,
 * so this route refuses today and every existing caller keeps that behaviour.
 *
 * ROUTE 2 — the separate checked-in Genesis approval record
 * (`approved-genesis-activation-approval.ts`), modelled on
 * `approved-pvt-cost-catalog.ts`. It does NOT bypass the frozen manifest: it
 * REQUIRES it unmoved, requires a real ed25519 SSHSIG over its exact bytes by
 * the configured key, and admits only the ONE artifact it records — campaign
 * `pvt9_genesis_v1`, canonical manifest id `pvt9_base_mainnet_v1`, the
 * window. It is not a general `signing_permitted: true`.
 *
 * The disjunction is scoped HERE, in the Genesis-only entry point. The monetary
 * rail reaches `verifyCurrentPvtManifestApproval` directly
 * (`runtime-monetary-policy.ts:118`) and never imports the Genesis record, so it
 * is structurally unable to consult route 2.
 */
export function verifyGenesisCampaignActivationApproval(
  activation: GenesisCampaignActivation,
  verifierConfig: SshApprovalVerifierConfig | null = approvalVerifierConfigFromEnv(),
): boolean {
  return activation.approval_manifest_sha256 === PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256
    && !isRejectedPvtApprovalManifestSha256(activation.approval_manifest_sha256)
    && hasStructuredApprovalSignature(activation.approval_signature)
    && (verifyCurrentPvtManifestApproval(activation.approval_signature, verifierConfig)
      || isApprovedGenesisActivation(activation, { verifierConfig }));
}

function validateActivationStructure(
  manifest: ArmedGenesisCampaignPolicyManifest,
  activation: GenesisCampaignActivation,
): GenesisReservationDenyReason | null {
  if (activation.genesis_kill_switch_active !== false) return 'genesis_kill_switch_active';
  if (!isPlainObject(activation)
    || !hasExactKeys(activation, ACTIVATION_KEYS)
    || isRejectedPvtApprovalManifestSha256(activation.approval_manifest_sha256)
    || activation.approval_status !== 'approved_by_frank'
    || !SHA256_HASH.test(activation.approval_manifest_sha256 ?? '')
    || !hasStructuredApprovalSignature(activation.approval_signature)
    || !isCanonicalIdentifier(activation.frank_approval_audit_id)
    || activation.approved_policy_version !== manifest.policy_version
    || !SHA256_HASH.test(activation.approved_policy_manifest_hash ?? '')
    || !SHA256_HASH.test(activation.approved_monetary_policy_template_hash ?? '')
    || activation.approved_policy_manifest_hash !== hashGenesisCampaignPolicyManifest(manifest)) {
    return 'proposal_not_approved';
  }
  if (!isSafeInteger(activation.effective_at_ms)
    || activation.effective_at_ms < 0
    || !isCanonicalIdentifier(activation.canonical_pvt_manifest_id)
    || !isCanonicalIdentifier(activation.ledger_namespace)
    || activation.ledger_namespace === 'pvt9_genesis_pending'
    || activation.prior_reservations_reconciled !== true
    || typeof activation.grants_enabled !== 'boolean'
    || !isCanonicalIdentifier(activation.operator_activation_audit_id)) {
    return 'successor_not_armed';
  }
  if (activation.grants_enabled) {
    if (activation.admission_closed_at_ms !== null
      || activation.admission_close_audit_id !== null) return 'successor_not_armed';
  } else if (!isSafeInteger(activation.admission_closed_at_ms)
    || activation.admission_closed_at_ms < activation.effective_at_ms
    || activation.admission_closed_at_ms > manifest.window.end_ms
    || !isCanonicalIdentifier(activation.admission_close_audit_id)) {
    // grants_enabled=false with no valid cutoff is the inert prelaunch shape.
    // A closed, previously-armed campaign must retain the evented cutoff so
    // pre-cutoff durable outboxes remain distinguishable from later acts.
    return 'successor_not_armed';
  }
  return null;
}

/**
 * Public structural/policy validation for local admission-control operations.
 * Reservation remains the economic authority; this wrapper lets an evented
 * close refuse to mutate an inert, killed, malformed, or unapproved campaign.
 */
export function validateGenesisCampaignActivation(
  manifest: ProposedGenesisCampaignPolicyManifest,
  activation: GenesisCampaignActivation,
  approvalVerifier: GenesisActivationApprovalVerifier =
    verifyGenesisCampaignActivationApproval,
): GenesisReservationDenyReason | null {
  if (!validateManifest(manifest)) return 'invalid_policy';
  const structuralFailure = validateActivationStructure(manifest, activation);
  if (structuralFailure !== null) return structuralFailure;
  return approvalVerifier(activation) ? null : 'proposal_not_approved';
}

function validateInput(input: GenesisReservationInput): boolean {
  if (!isPlainObject(input)
    || !hasExactKeys(input, [
      'pe_id',
      'action_type',
      'wallet_id',
      'economic_actor_id',
      'immutable_anchor',
      'qualifying_act_evidence',
    ])
    || !isCanonicalIdentifier(input.pe_id)
    || !isCanonicalIdentifier(input.action_type)
    || !isCanonicalIdentifier(input.wallet_id)
    || !isCanonicalIdentifier(input.economic_actor_id)
    || !isPlainObject(input.immutable_anchor)
    || !hasExactKeys(input.immutable_anchor, ['anchor_kind', 'anchor_id'])
    || !isCanonicalIdentifier(input.immutable_anchor.anchor_kind)
    || !isPlainObject(input.qualifying_act_evidence)) {
    return false;
  }
  const evidence = input.qualifying_act_evidence;
  return hasExactKeys(evidence, [
    'verification_status',
    'evidence_id',
    'evidence_hash',
    'subject_wallet_id',
    'canonical_bounty_key',
    'qualifying_act',
    'immutable_anchor_kind',
    'immutable_anchor_id',
    'qualifying_act_at_ms',
  ])
    && evidence.verification_status === 'verified'
    && isCanonicalIdentifier(evidence.evidence_id)
    && SHA256_HASH.test(evidence.evidence_hash)
    && evidence.subject_wallet_id === input.wallet_id
    && isCanonicalIdentifier(evidence.canonical_bounty_key)
    && isCanonicalIdentifier(evidence.qualifying_act)
    && isCanonicalIdentifier(evidence.immutable_anchor_kind)
    && isCanonicalIdentifier(evidence.immutable_anchor_id)
    && isSafeInteger(evidence.qualifying_act_at_ms)
    && evidence.qualifying_act_at_ms >= 0;
}

function validateObservationContext(
  context: GenesisReservationObservationContext,
  input: GenesisReservationInput,
): boolean {
  return isPlainObject(context)
    && hasExactKeys(context, ['verification_status', 'observed_at_ms', 'wallet_created'])
    && context.verification_status === 'verified'
    && isSafeInteger(context.observed_at_ms)
    && context.observed_at_ms >= 0
    && isPlainObject(context.wallet_created)
    && hasExactKeys(context.wallet_created, [
      'wallet_id',
      'created_at_ms',
      'evidence_id',
      'evidence_hash',
      'source',
    ])
    && context.wallet_created.wallet_id === input.wallet_id
    && isSafeInteger(context.wallet_created.created_at_ms)
    && context.wallet_created.created_at_ms >= 0
    && isCanonicalIdentifier(context.wallet_created.evidence_id)
    && SHA256_HASH.test(context.wallet_created.evidence_hash)
    && context.wallet_created.source === 'authoritative_wallet_record';
}

function validateReservationShape(entry: GenesisReservationLedgerEntry): boolean {
  return isPlainObject(entry)
    && hasExactKeys(entry, RESERVATION_KEYS)
    && isCanonicalIdentifier(entry.reservation_id)
    && isCanonicalIdentifier(entry.dedupe_key)
    && isCanonicalIdentifier(entry.policy_version)
    && SHA256_HASH.test(entry.policy_manifest_hash)
    && isCanonicalIdentifier(entry.canonical_pvt_manifest_id)
    && isCanonicalIdentifier(entry.canonical_bounty_key)
    && isCanonicalIdentifier(entry.emitted_action_type)
    && isCanonicalIdentifier(entry.pe_id)
    && isCanonicalIdentifier(entry.wallet_id)
    && isCanonicalIdentifier(entry.economic_actor_id)
    && isCanonicalIdentifier(entry.immutable_anchor_kind)
    && isCanonicalIdentifier(entry.immutable_anchor_id)
    && isCanonicalIdentifier(entry.evidence_id)
    && SHA256_HASH.test(entry.evidence_hash)
    && isSafeInteger(entry.qualifying_act_at_ms)
    && entry.qualifying_act_at_ms >= 0
    && isSafeInteger(entry.wallet_created_at_ms)
    && entry.wallet_created_at_ms >= 0
    && entry.wallet_created_at_ms <= entry.qualifying_act_at_ms
    && isCanonicalIdentifier(entry.wallet_created_evidence_id)
    && SHA256_HASH.test(entry.wallet_created_evidence_hash)
    && isCanonicalAtomic(entry.fixed_grant_atomic)
    && isSafeInteger(entry.decay_multiplier_bps)
    && entry.decay_multiplier_bps >= 0
    && entry.decay_multiplier_bps <= 10_000
    && isCanonicalAtomic(entry.reserved_atomic)
    && BigInt(entry.reserved_atomic) > 0n
    && isCanonicalAtomic(entry.state_revision_before)
    && isCanonicalAtomic(entry.state_revision_after)
    && BigInt(entry.state_revision_after) === BigInt(entry.state_revision_before) + 1n
    && isSafeInteger(entry.reserved_at_ms)
    && entry.reserved_at_ms >= entry.qualifying_act_at_ms;
}

function validateState(state: GenesisCampaignLedgerState): boolean {
  if (!isPlainObject(state)
    || !hasExactKeys(state, LEDGER_STATE_KEYS)
    || state.schema_version !== GENESIS_LEDGER_SCHEMA_VERSION
    || !isCanonicalIdentifier(state.ledger_namespace)
    || !isCanonicalAtomic(state.revision)
    || (state.last_policy_version !== null && !isCanonicalIdentifier(state.last_policy_version))
    || !isCanonicalAtomic(state.total_reserved_atomic)
    || !isPlainObject(state.wallet_reserved_atomic)
    || !Object.keys(state.wallet_reserved_atomic).every(isCanonicalIdentifier)
    || !Object.values(state.wallet_reserved_atomic).every(isCanonicalAtomic)
    || !isPlainObject(state.reservations_by_dedupe_key)) {
    return false;
  }
  const reservations = Object.entries(state.reservations_by_dedupe_key);
  if (BigInt(state.revision) !== BigInt(reservations.length)) return false;
  let total = 0n;
  const wallets: Record<string, bigint> = {};
  const revisions = new Set<string>();
  const peIds = new Set<string>();
  for (const [dedupeKey, reservation] of reservations) {
    if (!validateReservationShape(reservation)
      || !isCanonicalIdentifier(dedupeKey)
      || reservation.dedupe_key !== dedupeKey
      || reservation.dedupe_key !== buildGenesisDedupeKey(
        reservation.canonical_bounty_key,
        {
          anchor_kind: reservation.immutable_anchor_kind,
          anchor_id: reservation.immutable_anchor_id,
        },
      )
      || reservation.reservation_id !== expectedReservationId(state.ledger_namespace, dedupeKey)
      || revisions.has(reservation.state_revision_after)
      || peIds.has(reservation.pe_id)) return false;
    revisions.add(reservation.state_revision_after);
    peIds.add(reservation.pe_id);
    const amount = BigInt(reservation.reserved_atomic);
    total += amount;
    wallets[reservation.wallet_id] = (wallets[reservation.wallet_id] ?? 0n) + amount;
  }
  if (total !== BigInt(state.total_reserved_atomic)) return false;
  const stateWalletKeys = Object.keys(state.wallet_reserved_atomic).sort();
  const expectedWalletKeys = Object.keys(wallets).sort();
  if (stateWalletKeys.join('|') !== expectedWalletKeys.join('|')) return false;
  if (!expectedWalletKeys.every((key) =>
    BigInt(state.wallet_reserved_atomic[key]) === wallets[key])) return false;
  const ordered = [...reservations]
    .sort((left, right) => Number(
      BigInt(left[1].state_revision_after) - BigInt(right[1].state_revision_after),
    ));
  for (let index = 0; index < ordered.length; index += 1) {
    if (BigInt(ordered[index][1].state_revision_before) !== BigInt(index)
      || BigInt(ordered[index][1].state_revision_after) !== BigInt(index + 1)) return false;
  }
  return ordered.length === 0
    ? state.last_policy_version === null
    : state.last_policy_version === ordered[ordered.length - 1][1].policy_version;
}

function validateStateAgainstApprovedPolicy(
  state: GenesisCampaignLedgerState,
  manifest: ProposedGenesisCampaignPolicyManifest,
  activation: GenesisCampaignActivation,
): boolean {
  const walletUsed: Record<string, bigint> = {};
  const walletCap = BigInt(manifest.caps.per_wallet_lifetime_atomic);
  const ordered = Object.values(state.reservations_by_dedupe_key)
    .sort((left, right) => Number(
      BigInt(left.state_revision_after) - BigInt(right.state_revision_after),
    ));
  for (const reservation of ordered) {
    const bounty = resolveGenesisBountyPolicy(manifest, reservation.emitted_action_type);
    if (bounty === null
      || reservation.canonical_bounty_key !== bounty.canonical_bounty_key
      || reservation.immutable_anchor_kind !== bounty.dedupe.required_anchor
      || reservation.canonical_pvt_manifest_id !== activation.canonical_pvt_manifest_id
      || reservation.fixed_grant_atomic !== bounty.fixed_grant_atomic) return false;

    // A stored reservation is valid under EITHER the current manifest or
    // exactly one superseded binding. Sealed rows are never repriced: they are
    // re-derived under the policy identity they were actually sealed with.
    const walletAgeMs = reservation.qualifying_act_at_ms - reservation.wallet_created_at_ms;
    const isCurrent = reservation.policy_version === manifest.policy_version
      && reservation.policy_manifest_hash === activation.approved_policy_manifest_hash;
    let expectedBps: number;
    if (isCurrent) {
      expectedBps = computeGenesisGrantMultiplierBps(manifest, walletAgeMs);
    } else {
      const superseded = SUPERSEDED_GENESIS_POLICY_BINDINGS.find(
        (binding) => binding.policy_version === reservation.policy_version
          && binding.policy_manifest_hash === reservation.policy_manifest_hash,
      );
      if (superseded === undefined) return false;
      expectedBps = computeSupersededGenesisMultiplierBps(superseded, walletAgeMs);
    }
    if (reservation.decay_multiplier_bps !== expectedBps) return false;
    const desired = (BigInt(bounty.fixed_grant_atomic) * BigInt(expectedBps))
      / BPS_DENOMINATOR;
    const used = walletUsed[reservation.wallet_id] ?? 0n;
    const remaining = used >= walletCap ? 0n : walletCap - used;
    const expected = desired < remaining ? desired : remaining;
    if (expected <= 0n || BigInt(reservation.reserved_atomic) !== expected) return false;
    walletUsed[reservation.wallet_id] = used + expected;
  }
  return true;
}

/**
 * The multiplier applied to an approved fixed Genesis grant under CURRENT
 * policy. Constant 10000 bps: a qualified act pays its approved fixed grant
 * exactly, at any elapsed time. There is no wallet-age input, by design — see
 *. `walletAgeMs` is still validated so a caller passing garbage is a
 * throw rather than a silently-priced grant, but it cannot change the result.
 */
export function computeGenesisGrantMultiplierBps(
  manifest: ProposedGenesisCampaignPolicyManifest,
  walletAgeMs: number,
): number {
  if (!isSafeInteger(walletAgeMs) || walletAgeMs < 0 || !validateManifest(manifest)) {
    throw new Error('Invalid Genesis grant-multiplier input or manifest');
  }
  return manifest.grant_multiplier.multiplier_bps;
}

/**
 * Re-derive the multiplier a SUPERSEDED policy assigned, so already-sealed
 * reservations keep validating against the policy they were sealed under. This
 * is the ONLY remaining implementation of the retired wallet-age taper, and it
 * is reachable only from ledger validation of historical rows — never from
 * pricing a new grant.
 */
export function computeSupersededGenesisMultiplierBps(
  binding: SupersededGenesisPolicyBinding,
  walletAgeMs: number,
): number {
  if (!isSafeInteger(walletAgeMs) || walletAgeMs < 0) {
    throw new Error('Invalid superseded Genesis multiplier input');
  }
  // a constant-multiplier binding re-derives its constant. Wallet age is
  // validated above and cannot change the result.
  if (binding.multiplier_rule === 'fixed_grant_no_time_based_reduction') {
    return binding.multiplier_bps;
  }
  const raw = Math.floor(
    10_000 * Math.pow(2, -walletAgeMs / binding.wallet_age_half_life_ms),
  );
  return Math.max(binding.minimum_multiplier_bps, Math.max(0, Math.min(10_000, raw)));
}

function emptyDiagnostics(): GenesisReservationDiagnostics {
  return {
    canonical_bounty_key: null,
    fixed_grant_atomic: '0',
    wallet_age_ms: 0,
    decay_multiplier_bps: 0,
    desired_after_decay_atomic: '0',
    wallet_lifetime_remaining_atomic: '0',
  };
}

function deny(
  state: GenesisCampaignLedgerState,
  reason: GenesisReservationDenyReason,
  diagnostics: GenesisReservationDiagnostics = emptyDiagnostics(),
): GenesisReservationDeniedResult {
  return { allowed: false, reason, reservation: null, diagnostics, next_state: state };
}

export function reserveGenesisCampaignGrant(args: {
  readonly manifest: ProposedGenesisCampaignPolicyManifest;
  readonly activation: GenesisCampaignActivation | null;
  readonly state: GenesisCampaignLedgerState;
  readonly input: GenesisReservationInput;
  readonly observation_context: GenesisReservationObservationContext;
  readonly activation_approval_verifier?: GenesisActivationApprovalVerifier;
}): GenesisReservationResult {
  const { manifest, activation, state, input, observation_context: context } = args;

  // The Genesis kill switch is the first authorization gate.
  if (activation !== null && activation.genesis_kill_switch_active !== false) {
    return deny(state, 'genesis_kill_switch_active');
  }
  if (activation === null) return deny(state, 'proposal_not_approved');
  if (!validateManifest(manifest)) return deny(state, 'invalid_policy');
  const activationFailure = validateGenesisCampaignActivation(
    manifest,
    activation,
    args.activation_approval_verifier,
  );
  if (activationFailure !== null) return deny(state, activationFailure);
  if (!validateState(state)) return deny(state, 'invalid_state');
  if (state.ledger_namespace !== activation.ledger_namespace) {
    return deny(state, 'ledger_namespace_mismatch');
  }
  if (!validateStateAgainstApprovedPolicy(state, manifest, activation)) {
    return deny(state, 'invalid_state');
  }
  if (!validateInput(input)) return deny(state, 'invalid_request');
  if (!validateObservationContext(context, input)) {
    return deny(state, 'unverified_observation_context');
  }

  const reservedAtMs = context.observed_at_ms;
  const actAtMs = input.qualifying_act_evidence.qualifying_act_at_ms;
  const admissionCutoffMs = activation.grants_enabled
    ? manifest.window.end_ms
    : activation.admission_closed_at_ms!;
  if (reservedAtMs < activation.effective_at_ms!) return deny(state, 'policy_not_effective');
  if (reservedAtMs < manifest.window.start_ms) return deny(state, 'campaign_not_started');
  if (reservedAtMs > admissionCutoffMs) return deny(state, 'campaign_closed');
  if (actAtMs < manifest.window.start_ms || actAtMs > manifest.window.end_ms) {
    return deny(state, 'missing_qualifying_evidence');
  }
  if (actAtMs > admissionCutoffMs) return deny(state, 'campaign_closed');
  if (actAtMs < activation.effective_at_ms!) return deny(state, 'policy_not_effective');
  if (reservedAtMs < actAtMs) return deny(state, 'unverified_observation_context');

  const bounty = resolveGenesisBountyPolicy(manifest, input.action_type);
  if (bounty === null) return deny(state, 'unknown_bounty_action');
  const evidence = input.qualifying_act_evidence;
  if (evidence.canonical_bounty_key !== bounty.canonical_bounty_key
    || evidence.qualifying_act !== bounty.qualifying_act
    || evidence.immutable_anchor_kind !== input.immutable_anchor.anchor_kind
    || evidence.immutable_anchor_id !== input.immutable_anchor.anchor_id) {
    return deny(state, 'missing_qualifying_evidence');
  }
  if (input.immutable_anchor.anchor_kind !== bounty.dedupe.required_anchor) {
    return deny(state, 'invalid_immutable_anchor');
  }

  const dedupeKey = buildGenesisDedupeKey(bounty.canonical_bounty_key, input.immutable_anchor);
  if (state.reservations_by_dedupe_key[dedupeKey] !== undefined
    || Object.values(state.reservations_by_dedupe_key)
      .some((reservation) => reservation.pe_id === input.pe_id)) {
    return deny(state, 'replay');
  }

  const walletCreatedAtMs = context.wallet_created.created_at_ms;
  if (walletCreatedAtMs > actAtMs) return deny(state, 'unverified_observation_context');
  const walletAgeMs = actAtMs - walletCreatedAtMs;
  const multiplierBps = computeGenesisGrantMultiplierBps(manifest, walletAgeMs);
  const fixedGrant = BigInt(bounty.fixed_grant_atomic);
  const desired = (fixedGrant * BigInt(multiplierBps)) / BPS_DENOMINATOR;
  const walletUsed = BigInt(state.wallet_reserved_atomic[input.wallet_id] ?? '0');
  const walletCap = BigInt(manifest.caps.per_wallet_lifetime_atomic);
  const walletRemaining = walletUsed >= walletCap ? 0n : walletCap - walletUsed;
  const diagnostics: GenesisReservationDiagnostics = {
    canonical_bounty_key: bounty.canonical_bounty_key,
    fixed_grant_atomic: bounty.fixed_grant_atomic,
    wallet_age_ms: walletAgeMs,
    decay_multiplier_bps: multiplierBps,
    desired_after_decay_atomic: atomic(desired),
    wallet_lifetime_remaining_atomic: atomic(walletRemaining),
  };
  if (walletRemaining <= 0n) return deny(state, 'wallet_lifetime_cap_reached', diagnostics);
  const granted = desired < walletRemaining ? desired : walletRemaining;

  const beforeRevision = BigInt(state.revision);
  const afterRevision = (beforeRevision + 1n).toString(10);
  const reservationId = `genesis-reservation:${encodePart(`${state.ledger_namespace}:${dedupeKey}`)}`;
  const reservation: GenesisReservationLedgerEntry = Object.freeze({
    reservation_id: reservationId,
    dedupe_key: dedupeKey,
    policy_version: manifest.policy_version,
    policy_manifest_hash: activation.approved_policy_manifest_hash!,
    canonical_pvt_manifest_id: activation.canonical_pvt_manifest_id!,
    canonical_bounty_key: bounty.canonical_bounty_key,
    emitted_action_type: input.action_type,
    pe_id: input.pe_id,
    wallet_id: input.wallet_id,
    economic_actor_id: input.economic_actor_id,
    immutable_anchor_kind: input.immutable_anchor.anchor_kind,
    immutable_anchor_id: input.immutable_anchor.anchor_id,
    evidence_id: evidence.evidence_id,
    evidence_hash: evidence.evidence_hash,
    qualifying_act_at_ms: actAtMs,
    wallet_created_at_ms: walletCreatedAtMs,
    wallet_created_evidence_id: context.wallet_created.evidence_id,
    wallet_created_evidence_hash: context.wallet_created.evidence_hash,
    fixed_grant_atomic: bounty.fixed_grant_atomic,
    // SEALED SCHEMA FIELD — the name is retained because one mainnet
    // reservation is already persisted with it and is compared byte-for-byte on
    // recovery. Under current policy its value is always 10000.
    decay_multiplier_bps: multiplierBps,
    reserved_atomic: atomic(granted),
    state_revision_before: state.revision,
    state_revision_after: afterRevision,
    reserved_at_ms: reservedAtMs,
  });
  authenticReservationReceipts.add(reservation);

  const nextState: GenesisCampaignLedgerState = Object.freeze({
    schema_version: GENESIS_LEDGER_SCHEMA_VERSION,
    ledger_namespace: state.ledger_namespace,
    revision: afterRevision,
    last_policy_version: manifest.policy_version,
    total_reserved_atomic: atomic(BigInt(state.total_reserved_atomic) + granted),
    wallet_reserved_atomic: Object.freeze({
      ...state.wallet_reserved_atomic,
      [input.wallet_id]: atomic(walletUsed + granted),
    }),
    reservations_by_dedupe_key: Object.freeze({
      ...state.reservations_by_dedupe_key,
      [dedupeKey]: reservation,
    }),
  });

  return { allowed: true, reason: 'reserved', reservation, diagnostics, next_state: nextState };
}
