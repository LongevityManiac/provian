import fs from 'fs';
import path from 'path';

const REPOSITORY_ROOT = path.resolve(__dirname, '../..');
const OUTPUT_PATH = path.join(
  REPOSITORY_ROOT,
  'docs/audit/pvt-wp0-wp1/pvt-launch-capacity-model.generated.json',
);
const PVT_ATOMIC = 10n ** 18n;
const SAFE_RECIPIENTS_PER_TX = 400;
const MAX_TRANSACTIONS_PER_CYCLE = 100;
const GENESIS_EPOCH_CAP = 7_500_000n * PVT_ATOMIC;
const COMBINED_EPOCH_CAP = 10_000_000n * PVT_ATOMIC;

interface ScenarioInput {
  readonly id: string;
  readonly agents: number;
  readonly humans: number;
  readonly deviceLinks: number;
  readonly notes: readonly string[];
}
function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function model(input: ScenarioInput) {
  const recipients = BigInt(input.agents + input.humans);
  const agentGenesisGross = BigInt(input.agents) * 75n * PVT_ATOMIC;
  const humanGenesisGross = BigInt(input.humans) * 75n * PVT_ATOMIC;
  const deviceGenesisGross = BigInt(input.deviceLinks) * 25n * PVT_ATOMIC;
  const genesisGross = agentGenesisGross + humanGenesisGross + deviceGenesisGross;
  // Only human wallet creation emits the distinct standard wallet_created
  // birth-certificate PE. Agent wallet creation is a record-only identity PE.
  const standardWalletCreated = BigInt(input.humans) * 10n * PVT_ATOMIC;
  const directMintTransactions = ceilDiv(recipients, BigInt(SAFE_RECIPIENTS_PER_TX));
  const cyclesAtTxCeiling = ceilDiv(
    directMintTransactions,
    BigInt(MAX_TRANSACTIONS_PER_CYCLE),
  );
  const genesisEpochsAtEconomicCap = ceilDiv(genesisGross, GENESIS_EPOCH_CAP);
  const combinedEpochsAtEconomicCap = ceilDiv(
    genesisGross + standardWalletCreated,
    COMBINED_EPOCH_CAP,
  );
  return {
    id: input.id,
    agents: input.agents,
    humans: input.humans,
    device_links: input.deviceLinks,
    unique_recipients: Number(recipients),
    genesis_pe_count: input.agents + input.humans + input.deviceLinks,
    genesis_gross_contract_input_atomic: genesisGross.toString(),
    genesis_gross_contract_input_pvt: (genesisGross / PVT_ATOMIC).toString(),
    standard_wallet_created_pe_count: input.humans,
    standard_wallet_created_record_points_atomic_at_one_times_policy:
      standardWalletCreated.toString(),
    combined_planning_input_atomic_at_one_times_policy:
      (genesisGross + standardWalletCreated).toString(),
    direct_mint_transactions_at_400_recipients: Number(directMintTransactions),
    minimum_weekly_cycles_at_100_transaction_ceiling: Number(cyclesAtTxCeiling),
    minimum_epochs_at_7500000_genesis_cap: Number(genesisEpochsAtEconomicCap),
    minimum_epochs_at_10000000_combined_cap_if_no_other_issuance:
      Number(combinedEpochsAtEconomicCap),
    current_single_daily_anchor_limit_exceeded: input.agents + input.humans + input.deviceLinks > 5_000,
    notes: input.notes,
  };
}

const scenarios = [
  model({
    id: 'launch_25000_recipients_50000_genesis_pes',
    agents: 20_000,
    humans: 5_000,
    deviceLinks: 25_000,
    notes: [
      'All 25,000 recipients have one signup gross reservation and one registered-device-link gross reservation.',
      'The 2,500,000 PVT Genesis gross contract input fits one initial Genesis settlement epoch economically.',
      'Sixty-three direct transactions fit the initial 100-transaction operating ceiling; gas and fee ceilings may still stop safely with backlog.',
    ],
  }),
  model({
    id: 'two_times_burst_50000_recipients_100000_genesis_pes',
    agents: 40_000,
    humans: 10_000,
    deviceLinks: 50_000,
    notes: [
      'This is the required 2x recipient/PE burst around the 25,000-wallet case.',
      'The gross contract input fits one initial Genesis epoch, but 125 direct transactions exceed the initial per-cycle transaction ceiling and therefore require durable continuation.',
    ],
  }),
  model({
    id: 'modeled_350000_recipients',
    agents: 150_000,
    humans: 200_000,
    deviceLinks: 350_000,
    notes: [
      'The 35,000,000 PVT Genesis gross contract input requires at least five initial Genesis-cap epochs.',
      'Eight hundred seventy-five direct transactions require at least nine weekly cycles under the initial 100-transaction operating ceiling, before gas/fee/run-duration stops.',
      'This is a backlog-drainage model, not an instant-settlement promise.',
    ],
  }),
];

const artifact = {
  schema_version: 'pvt-launch-capacity-model/v3',
  status: 'wp0_wp1_planning_evidence_not_worker_implementation',
  exact_policy_inputs: {
    agent_signup_gross_reservation_pvt: '75',
    human_signup_gross_reservation_pvt: '75',
    registered_device_link_gross_reservation_pvt: '25',
    genesis_wallet_gross_ceiling_pvt: '500',
    genesis_total_pool: 'none',
    genesis_launch_dates: 'none_approved_campaign_unarmed_until_wp12',
    human_wallet_created_record_points_pvt_at_one_times_policy: '10',
    genesis_epoch_gross_settlement_sub_budget_pvt: '7500000',
    combined_initial_epoch_issuance_cap_pvt: '10000000',
    initial_flat_epoch_count: 12,
    post_flat_combined_epoch_cap_rule: 'exactly_two_times_trailing_average',
    post_flat_trend_tolerance: 'none',
    zero_trailing_average_behavior:
      'zero_combined_epoch_cap_until_authorized_prospective_policy_event',
    post_flat_change_control: 'authorized_prospective_policy_event_only',
    safe_recipients_per_direct_mint_transaction: SAFE_RECIPIENTS_PER_TX,
    maximum_transactions_per_weekly_cycle: MAX_TRANSACTIONS_PER_CYCLE,
    maximum_cumulative_gas_spend_eth: '0.1',
  },
  interpretation: {
    genesis_amount_semantics:
      'gross_contract_input_before_the_pvt9_immutable_99_0_5_0_5_treasury_split_not_contributor_net_receipt',
    genesis_routing:
      'bypasses_standard_linked_agent_beneficiary_routing_but_not_the_immutable_treasury_split',
    standard_linked_agent_routing:
      'default_agent_share_2000_bps_prospectively_configurable_from_500_through_5000_bps',
    admission:
      'currently_unarmed_no_approved_dates_then_time_window_plus_one_time_keys_plus_500_pvt_gross_wallet_cap_when_separately_armed_in_wp12',
    settlement:
      'weekly_rate_limited_durable_backlog_including_valid_pre_cutoff_reservations_after_admission_closes',
    epoch_transition:
      'twelve_flat_epochs_then_exactly_two_times_trailing_average_with_zero_average_equal_to_zero_cap',
    scenario_epoch_estimates_scope:
      'initial_flat_epoch_caps_only_post_flat_capacity_depends_on_actual_trailing_issuance',
    lifetime_genesis_bound:
      'sum_of_valid_in_window_reservations_not_window_length_times_weekly_budget',
    worker_status: 'multi_transaction_worker_is_later_wp4_work',
    segmented_anchoring_status: 'later_wp4_work_required_before_capacity_launch_gate',
  },
  scenarios,
};

const expected = `${JSON.stringify(artifact, null, 2)}\n`;
const check = process.argv.includes('--check');
if (check) {
  const current = fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, 'utf8') : '';
  if (current !== expected) {
    throw new Error(`Capacity model is stale; run generate:pvt-capacity-model (${OUTPUT_PATH})`);
  }
  process.stdout.write(`Capacity model is current: ${OUTPUT_PATH}\n`);
} else {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, expected, 'utf8');
  process.stdout.write(`Wrote ${OUTPUT_PATH}\n`);
}
