import { createHash } from 'node:crypto';
import frozenGenesisManifest from './__artifacts__/genesis-campaign-policy.json';
import type { ApprovalFlag, ProposalStatus, PVTAtomic } from './types';

/**
 * Relay-side Genesis admission policy. Admission is bounded by the campaign
 * window and per-wallet/replay rules, never by a depletable campaign pool.
 * Settlement pacing is declared separately because it must never reject or
 * reprice an otherwise-valid in-window reservation.
 */
export type GenesisArmingState =
  | 'disarmed_requires_explicit_pvt9_activation'
  | 'armed_by_explicit_pvt9_activation';

/**
 * Compatibility pricing rule for reservations sealed under a wallet-age taper.
 * Current grants never depend on elapsed time. The invariant registry checks
 * both code shape and behavior to keep the taper out of current pricing.
 */
export const RETIRED_GENESIS_DECAY_ALGORITHM_VERSION =
  'wallet-age-exponential-bps-floor/v2' as const;

/**
 * The multiplier applied to an approved fixed Genesis grant. Constant by
 * construction: a fixed grant of 75 PVT reserves exactly 75 PVT, whether the
 * qualifying act lands one millisecond or one year after wallet creation.
 */
export const GENESIS_GRANT_MULTIPLIER_BPS = 10_000 as const;

export const RETIRED_GENESIS_ACTION_TYPES = Object.freeze([
  'agent_wallet_created',
  'agent_wallet_funded',
  'wallet_funded',
  'agent_first_transaction',
  'wallet_first_transaction',
  'agent_sustained_activity',
  'wallet_sustained_activity',
] as const);

export interface ProposedGenesisBountyPolicy {
  readonly canonical_bounty_key:
    | 'genesis_human_signup'
    | 'genesis_signup'
    | 'genesis_device_link';
  readonly emitted_action_types: readonly [string];
  readonly qualifying_act: string;
  readonly fixed_grant_atomic: PVTAtomic;
  readonly dedupe: {
    readonly key_template: string;
    readonly required_anchor:
      | 'human_wallet_id'
      | 'agent_id'
      | 'registered_device_id';
    readonly missing_anchor_behavior: 'deny_grant_fail_closed';
    readonly aliases_share_one_key: true;
  };
  readonly launch_armed: boolean;
  readonly activation:
    | 'requires_wp12_launch_dates_and_explicit_activation'
    | 'explicit_pvt9_launch_activation';
  readonly fixed_grant_approval: ApprovalFlag;
}

export interface ProposedGenesisCampaignPolicyManifest {
  readonly schema_version: 'pvt-genesis-campaign-policy/v2';
  readonly policy_version: string;
  readonly status: ProposalStatus;
  readonly effective_at: null;
  readonly chain_id: 8453;
  readonly arming: {
    readonly state: GenesisArmingState;
    readonly grants_enabled: boolean;
    readonly canonical_pvt_manifest_id: string | null;
    readonly ledger_namespace: string;
    readonly requires_reconciled_prior_reservations: true;
    readonly requires_operator_activation_audit: true;
    readonly prior_configuration_carries_forward: false;
    readonly admission_close_control: 'evented_cutoff_config_flip';
    readonly pre_cutoff_outbox_behavior: 'preserve_and_reserve_exactly';
  };
  readonly window: {
    readonly start_ms: number | null;
    readonly end_ms: number | null;
    readonly admission_rule: 'qualifying_act_must_be_in_window_pre_cutoff_outbox_may_reserve_after_close';
    readonly close_behavior: 'stop_new_qualifications_preserve_pre_cutoff_reservations';
    readonly approval: ApprovalFlag;
  };
  /**
   * Replaces the retired `decay` block. There is deliberately NO half-life, NO
   * floor, and NO age input: the shape carries nothing that could be flipped
   * back into a taper without re-adding fields.
   */
  readonly grant_multiplier: {
    readonly mode: 'fixed_grant_no_time_based_reduction';
    readonly multiplier_bps: typeof GENESIS_GRANT_MULTIPLIER_BPS;
    readonly multiplier_formula: 'constant_10000_bps_independent_of_elapsed_time';
    readonly grant_formula: 'fixed_grant_atomic';
    readonly rounding: 'exact_no_rounding';
    readonly approval: ApprovalFlag;
  };
  readonly caps: {
    readonly per_wallet_lifetime_atomic: PVTAtomic;
    readonly admission_total_pool: 'none';
    readonly aggregate_per_action_caps: 'none';
    readonly participant_cap: 'none';
    readonly reservation_rule: 'minimum_of_fixed_grant_and_wallet_lifetime_remaining';
    readonly tail_behavior: 'partial_atomic_grant_allowed';
    readonly debit_semantics: 'compare_and_swap_wallet_ledger_dedupe_and_reservation_atomically';
    readonly approval: {
      readonly per_wallet_lifetime: ApprovalFlag;
    };
  };
  readonly settlement: {
    readonly admission_independent: true;
    readonly epoch_duration_seconds: 604_800;
    readonly initial_genesis_sub_budget_atomic: PVTAtomic;
    readonly initial_combined_system_cap_atomic: PVTAtomic;
    readonly initial_flat_epoch_count: 12;
    readonly post_flat_policy: 'two_times_trailing_average_evented_adjustable';
    readonly genesis_sub_budget_change_control: 'append_only_signed_effective_epoch_policy_events';
    readonly initial_event_binding: 'exact_launch_approval_manifest';
    readonly epoch_snapshot_rule: 'event_id_hash_approval_hash_immutable_per_epoch';
    readonly backlog_behavior: 'durable_until_settled_no_reprice_no_cancel';
    readonly approval: ApprovalFlag;
  };
  readonly bounties: readonly ProposedGenesisBountyPolicy[];
}

/**
 * Exact canonical manifest data bound by activation and sealed reservations.
 * Its frozen JSON bytes retain their existing hash; source commentary cannot
 * change that authority. Types and compatibility readers remain here.
 */
const FROZEN_GENESIS_MANIFEST_SHA256 = '63b94b743e39bf96efe8d4c10a5c1fa57c2cc8b6f2b35d71d9b244c55fee13d7';

/** Exact hash equality binds this value to the reviewed manifest's complete schema. */
export function assertFrozenGenesisManifest(value: unknown): asserts value is ProposedGenesisCampaignPolicyManifest {
  if (createHash('sha256').update(JSON.stringify(value) ?? '').digest('hex') !== FROZEN_GENESIS_MANIFEST_SHA256) {
    throw new Error('frozen_genesis_manifest_mismatch');
  }
}

assertFrozenGenesisManifest(frozenGenesisManifest);
export const PROPOSED_GENESIS_CAMPAIGN_POLICY: ProposedGenesisCampaignPolicyManifest = frozenGenesisManifest;

/**
 * Append-only validation bindings for already-sealed reservations. Each hash
 * selects the exact pricing rule used at seal time, so a current policy update
 * cannot invalidate a wallet ledger or reprice previously earned value.
 */
interface SupersededGenesisPolicyBindingBase {
  readonly policy_version: string;
  /** `hashGenesisCampaignPolicyManifest` of the manifest as it stood. */
  readonly policy_manifest_hash: string;
  /** Compatibility validation rule. Documentation only. */
  readonly superseded_reason: string;
}

/** A binding priced by the retired wallet-age taper for sealed reservations. */
export interface SupersededGenesisDecayBinding extends SupersededGenesisPolicyBindingBase {
  readonly multiplier_rule: typeof RETIRED_GENESIS_DECAY_ALGORITHM_VERSION;
  readonly wallet_age_half_life_ms: number;
  readonly minimum_multiplier_bps: number;
}

/** A sealed fixed-grant binding retains its exact multiplier at every age. */
export interface SupersededGenesisFixedBinding extends SupersededGenesisPolicyBindingBase {
  readonly multiplier_rule: 'fixed_grant_no_time_based_reduction';
  readonly multiplier_bps: typeof GENESIS_GRANT_MULTIPLIER_BPS;
}

export type SupersededGenesisPolicyBinding = SupersededGenesisDecayBinding | SupersededGenesisFixedBinding;

export const SUPERSEDED_GENESIS_POLICY_BINDINGS:
readonly SupersededGenesisPolicyBinding[] = Object.freeze([
  Object.freeze({
    policy_version: 'base-mainnet-genesis-proposal-2026-07-13.1',
    policy_manifest_hash:
      'sha256:9130042a8478972a7e234c79a7457212776b629648755c6081e0d4a8565323aa',
    multiplier_rule: RETIRED_GENESIS_DECAY_ALGORITHM_VERSION,
    wallet_age_half_life_ms: 1_209_600_000,
    minimum_multiplier_bps: 1_000,
    superseded_reason:
      'A reservation sealed under this wallet-age rule keeps its original gross unchanged; current grants have no time-based reduction.',
  }),
  Object.freeze({
    policy_version: 'base-mainnet-genesis-proposal-2026-07-13.1',
    policy_manifest_hash:
      'sha256:12e1e87177bd62b36f4b40a440a1e9bb3c770f4f30260424cc8e65692776ddf0',
    multiplier_rule: 'fixed_grant_no_time_based_reduction',
    multiplier_bps: GENESIS_GRANT_MULTIPLIER_BPS,
    superseded_reason:
      'Reservations sealed under this fixed-grant binding retain their exact 10000-bps multiplier regardless of the current admission window.',
  }),
] as const);
