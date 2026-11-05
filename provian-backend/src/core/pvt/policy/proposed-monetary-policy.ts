import nodeCrypto from 'crypto';

/**
 * Complete Gate-1 monetary policy template.
 *
 * This composes every explicit launch action entry into the exact schema used
 * by the atomic accounting atomic accounting kernel. Runtime selection requires a signed,
 * explicit activation document; merely importing this template cannot arm it.
 */

import {
  MONETARY_ACCOUNTING_SCHEMA_VERSION,
  atomicUnits,
  type ActionMonetaryPolicy,
  type AtomicUnits,
  type LinkageState,
  type MintReasonCode,
} from './monetary-accounting';
import { PROPOSED_ACTION_POLICY_ENTRIES, PROPOSED_ACTION_POLICY_MANIFEST } from './proposed-action-policy';
import type { ProposedActionPolicyManifest } from './types';
import { PROPOSED_EVIDENCE_CLASS_BASES_BPS } from './evidence-class';

export const PROPOSED_ATTESTATION_MULTIPLIERS_BPS = Object.freeze({
  full_stack: 20_000,
  hardware_full: 25_000,
  compute_tee: 14_000,
  hardware_partial: 12_000,
  corroborated: 11_000,
  software_verified: 12_000,
  software: 8_000,
  social: 5_000,
});

/**
 * Evidence pricing for VERIFIED_SOVEREIGN_AGENT_WORK and
 * VERIFIED_EXTERNAL_SERVICE_OUTCOME. Admitted non-actor-witnessed work earns
 * the family base at its tier discount: software 8,000 bps and social 5,000 bps.
 * Actor-declared work has no PE intake path and cannot gain authority from this
 * pricing table.
 *
 * A self-produced replication pack reaches the family's flat 10,000-bps price.
 * Independent verified evidence can lift a qualifying named row to that same
 * full value. These families do not import the standard ladder's 2.5x/1.4x/1.1x
 * proof premiums: proof is a lift, not a hardware-farm gradient. Hardware
 * pricing itself requires the schemes and pinned measurements in the signed
 * template. Novelty prices repetition separately; exact duplicates mint zero.
 */
export const PROPOSED_EVIDENCE_PRICED_ATTESTATION_MULTIPLIERS_BPS = Object.freeze({
  full_stack: 10_000,
  hardware_full: 10_000,
  compute_tee: 10_000,
  hardware_partial: 10_000,
  corroborated: 10_000,
  software_verified: 10_000,
  software: 8_000,
  social: 5_000,
});

export const PROPOSED_LINKAGE_MULTIPLIERS_BPS = Object.freeze({
  unlinked: 10_000,
  human_linked: 20_000,
  beneficiary_linked: 20_000,
  // The engine forces unverifiable linkage to pending_review before settlement;
  // 1.0x is retained only so record points can be audited without guessing 2x.
  unverifiable: 10_000,
});

function reasonForDisposition(
  disposition: (typeof PROPOSED_ACTION_POLICY_ENTRIES)[number]['mint_disposition'],
  semanticReason: (typeof PROPOSED_ACTION_POLICY_ENTRIES)[number]['reason_code'],
): MintReasonCode {
  switch (disposition) {
    case 'eligible': return 'policy_eligible';
    case 'pending_evidence': return 'awaiting_evidence';
    case 'pending_review': return 'awaiting_review';
    case 'record_only':
      return semanticReason === 'SYSTEM_BOOKKEEPING_NON_CIRCULAR'
        ? 'system_accounting_record_only'
        : 'policy_record_only';
    case 'ineligible_terminal': return 'policy_ineligible';
    case 'pending_compliance': return 'jurisdiction_unknown';
    case 'pending_cache': return 'cache_unavailable';
    case 'beneficiary_pending': return 'beneficiary_unresolved';
    case 'jurisdiction_deferred': return 'jurisdiction_deferred';
  }
}

const actions: Record<string, ActionMonetaryPolicy> = {};
for (const entry of PROPOSED_ACTION_POLICY_ENTRIES) {
  actions[entry.action_type] = Object.freeze({
    category: entry.category,
    baseWeightBps: entry.base_action_weight_bps,
    policyOverrideBps: entry.policy_override_bps,
    mintDisposition: entry.mint_disposition,
    mintReasonCode: reasonForDisposition(entry.mint_disposition, entry.reason_code),
    policyReviewState: 'not_required',
    policyReviewReasonCode: 'known_policy_entry',
    financialAttestationNeutral: entry.financial_attestation_neutral,
    attestationPricing: entry.attestation_pricing,
    allowVerifiedAttestationUpgrade: entry.allow_verified_attestation_upgrade,
    evidenceRequirement: entry.evidence_requirement,
    canonicalEventRequired: entry.canonical_event_required,
    canonicalEventGroup: entry.canonical_event_group,
    beneficialOwnershipPolicy: entry.beneficial_ownership_policy,
    sessionLineagePolicy: entry.session_lineage_policy,
    fixedGrantSource: entry.fixed_grant_source,
    evidenceResolutionMode: entry.evidence_resolution_mode,
  });
}

export interface ProposedMonetaryPolicyTemplate {
  readonly schemaVersion: typeof MONETARY_ACCOUNTING_SCHEMA_VERSION;
  readonly proposedPolicyVersion: string;
  readonly effectiveAtMs: null;
  readonly effectiveUntilMs: null;
  readonly basePointsAtomic: AtomicUnits;
  readonly attestationMultipliersBps: Readonly<Record<string, number>>;
  readonly evidencePricedAttestationMultipliersBps: Readonly<Record<string, number>>;
  readonly linkageMultipliersBps: Readonly<Record<LinkageState, number>>;
  /** : the six witness-class bases (pinned by the signature over this template). */
  readonly evidenceClassBasesBps: Readonly<Record<string, number>>;
  /** addendum 6: the schemes whose verified report alone prices at `hardware_rooted`. */
  readonly hardwarePricingSchemes: readonly string[];
  /**
   * Measured observer : the schemes whose verified report prices at
   * `hardware_rooted` ONLY when its platform-produced launch measurement (PCR digest / launch
   * measurement / image digest / measurement record) is one the signed observer release channel
   * pins (`core/hardware/pinned-measurements.ts`). Any other measurement stays a presentation fact
   * at the lane's class. A body-supplied measurement is never read — only the verifier's own fields.
   */
  readonly hardwarePricingMeasuredSchemes: readonly string[];
  /**
   * (; ): what an action type with no
   * named row does — recorded at its witness class with no mint, queued only from a witnessed
   * class, earning only from a signed row's effective time. The SAME object the action-policy
   * manifest declares (`unknown_action_policy`, emitted into the matrix as
   * `unknown_action_admission`), so the signature over this template covers the declaration and
   * the two can never disagree. Runtime behaviour is bound to it by
   * `unknown-action-admission.binding.test.ts`.
   */
  readonly unknownActionAdmission: ProposedActionPolicyManifest['unknown_action_policy'];
  readonly actions: Readonly<Record<string, ActionMonetaryPolicy>>;
}

export const PROPOSED_MONETARY_POLICY_TEMPLATE: ProposedMonetaryPolicyTemplate = Object.freeze({
  hardwarePricingSchemes: Object.freeze(['apple_app_attest']),
  hardwarePricingMeasuredSchemes: Object.freeze(['tpm2_quote', 'aws_nitro', 'gcp_confidential_space', 'azure_attestation', 'nvidia_cc']),
  schemaVersion: MONETARY_ACCOUNTING_SCHEMA_VERSION,
  proposedPolicyVersion: 'base-mainnet-monetary-proposal-2026-07-13.1',
  effectiveAtMs: null,
  effectiveUntilMs: null,
  basePointsAtomic: atomicUnits('1000000000000000000'),
  attestationMultipliersBps: PROPOSED_ATTESTATION_MULTIPLIERS_BPS,
  evidencePricedAttestationMultipliersBps:
    PROPOSED_EVIDENCE_PRICED_ATTESTATION_MULTIPLIERS_BPS,
  linkageMultipliersBps: PROPOSED_LINKAGE_MULTIPLIERS_BPS,
  evidenceClassBasesBps: PROPOSED_EVIDENCE_CLASS_BASES_BPS,
  unknownActionAdmission: PROPOSED_ACTION_POLICY_MANIFEST.unknown_action_policy,
  actions: Object.freeze(actions),
});

// SUPERSEDES the daily-boundary fields below: the daily
// diminishing-returns rate cut is removed entirely (dailyDiminishingBps seals a
// constant 10_000; the retired curve survives only as
// supersededDailyDiminishingBps for sealed-history validation), and the 50/day
// literal moved to qualification in pvt-accrual.ts. then
// removed the qualification ordinal itself, with the per-user hourly/daily
// volume caps — volume neither reprices nor disqualifies anywhere. The two
// boundary strings are retained unchanged as the Gate-1 approval record they
// are — they no longer describe current pricing, and the off-by-one they
// acknowledged is moot: no ordinal prices differently from any other.
export const PROPOSED_MONETARY_POLICY_APPROVAL = Object.freeze({
  status: 'gate_1_plain_english_approved' as const,
  effective_at: null,
  daily_boundary_treatment: 'proposed_one_based_50_51_52_is_10000_5000_2500_bps' as const,
  current_runtime_boundary: 'pre_event_counter_makes_events_50_51_52_equal_10000_10000_5000_bps' as const,
  policy: PROPOSED_MONETARY_POLICY_TEMPLATE,
});

// ---------------------------------------------------------------------------
// Canonical template digest.
//
// MOVED HERE FROM `runtime-monetary-policy`. It lived beside the runtime
// rail, so any module needing the template's digest had to import the rail —
// and once the rail was wired to consult the monetary approval source, that
// became a genuine import CYCLE. The cycle was not merely a module-init hazard:
// it made the approval source UNMOCKABLE from the rail's own suite, so the
// wiring control could not be written. Its correct home is beside the template
// it hashes, which imports nothing from the rail.
//
// `runtime-monetary-policy` re-exports this, so every existing importer is
// unaffected.
// ---------------------------------------------------------------------------

export function canonicalPolicyJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('non-canonical policy number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalPolicyJson).join(',')}]`;
  if (typeof value !== 'object') throw new Error('non-canonical policy value');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalPolicyJson(record[key])}`).join(',')}}`;
}

export function hashProposedMonetaryPolicyTemplate(): string {
  return `sha256:${nodeCrypto.createHash('sha256')
    .update(canonicalPolicyJson(PROPOSED_MONETARY_POLICY_TEMPLATE), 'utf8')
    .digest('hex')}`;
}
