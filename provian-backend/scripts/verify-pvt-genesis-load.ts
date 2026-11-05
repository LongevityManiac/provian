import {
  createEmptyGenesisLedgerState,
  hashGenesisCampaignPolicyManifest,
  reserveGenesisCampaignGrant,
  type GenesisCampaignActivation,
  type GenesisCampaignLedgerState,
} from '../src/core/pvt/policy/genesis-policy-engine';
import { createArmedGenesisPolicyForTest } from '../src/core/pvt/__test-helpers__/armed-genesis-policy';

const ATOMIC = 10n ** 18n;
const TEST_GENESIS_CAMPAIGN_POLICY = createArmedGenesisPolicyForTest();
const OBSERVED_AT = TEST_GENESIS_CAMPAIGN_POLICY.window.start_ms;

const activation: GenesisCampaignActivation = {
  approval_status: 'approved_by_frank',
  approval_manifest_sha256: `sha256:${'a'.repeat(64)}`,
  approval_signature: {
    scheme: 'sshsig-ed25519',
    signer_identity: 'frank',
    namespace: 'provian-pvt-policy',
    public_key_sha256: `sha256:${'e'.repeat(64)}`,
    armored_signature: 'pure-load-test-only-structured-signature',
  },
  frank_approval_audit_id: 'local-load-evidence-not-production-approval',
  approved_policy_version: TEST_GENESIS_CAMPAIGN_POLICY.policy_version,
  approved_policy_manifest_hash:
    hashGenesisCampaignPolicyManifest(TEST_GENESIS_CAMPAIGN_POLICY),
  approved_monetary_policy_template_hash: `sha256:${'b'.repeat(64)}`,
  effective_at_ms: OBSERVED_AT,
  admission_closed_at_ms: null,
  admission_close_audit_id: null,
  grants_enabled: true,
  genesis_kill_switch_active: false,
  canonical_pvt_manifest_id: 'local-pvt9-load-evidence',
  ledger_namespace: 'local-load-evidence',
  prior_reservations_reconciled: true,
  operator_activation_audit_id: 'local-load-evidence',
};

function reserve(
  state: GenesisCampaignLedgerState,
  walletId: string,
  actionType: 'genesis_human_signup' | 'genesis_signup' | 'genesis_device_link',
  anchorKind: 'human_wallet_id' | 'agent_id' | 'registered_device_id',
  anchorId: string,
) {
  return reserveGenesisCampaignGrant({
    manifest: TEST_GENESIS_CAMPAIGN_POLICY,
    activation,
    state,
    input: {
      pe_id: `pe-${actionType}-${anchorId}`,
      action_type: actionType,
      wallet_id: walletId,
      economic_actor_id: actionType === 'genesis_signup' ? anchorId : walletId,
      immutable_anchor: { anchor_kind: anchorKind, anchor_id: anchorId },
      qualifying_act_evidence: {
        verification_status: 'verified',
        evidence_id: `evidence-${actionType}-${anchorId}`,
        evidence_hash: `sha256:${'c'.repeat(64)}`,
        subject_wallet_id: walletId,
        canonical_bounty_key: actionType,
        qualifying_act: actionType === 'genesis_human_signup'
          ? 'create_human_wallet'
          : actionType === 'genesis_signup'
            ? 'create_agent_wallet'
            : 'link_registered_device',
        immutable_anchor_kind: anchorKind,
        immutable_anchor_id: anchorId,
        qualifying_act_at_ms: OBSERVED_AT,
      },
    },
    observation_context: {
      verification_status: 'verified',
      observed_at_ms: OBSERVED_AT,
      wallet_created: {
        wallet_id: walletId,
        created_at_ms: OBSERVED_AT,
        evidence_id: `wallet-${walletId}`,
        evidence_hash: `sha256:${'d'.repeat(64)}`,
        source: 'authoritative_wallet_record',
      },
    },
    // Pure load arithmetic only. Production never injects an approval
    // verifier and must validate the exact signable manifest SSHSIG.
    activation_approval_verifier: () => true,
  });
}

function runScenario(agents: number, humans: number): {
  wallets: number;
  genesisPEs: number;
  reservedGrossAtomic: string;
  replayDenials: number;
} {
  let total = 0n;
  let replayDenials = 0;
  const wallets = agents + humans;
  for (let index = 0; index < wallets; index += 1) {
    const isAgent = index < agents;
    const walletId = `${isAgent ? 'agent' : 'human'}-${index}`;
    const signupAction = isAgent ? 'genesis_signup' : 'genesis_human_signup';
    const signupAnchor = isAgent ? 'agent_id' : 'human_wallet_id';
    const first = reserve(
      createEmptyGenesisLedgerState('local-load-evidence'),
      walletId,
      signupAction,
      signupAnchor,
      walletId,
    );
    if (!first.allowed) throw new Error(`signup reservation failed: ${first.reason}`);
    total += BigInt(first.reservation.reserved_atomic);

    const deviceId = `device-${index}`;
    const second = reserve(
      first.next_state,
      walletId,
      'genesis_device_link',
      'registered_device_id',
      deviceId,
    );
    if (!second.allowed) throw new Error(`device reservation failed: ${second.reason}`);
    total += BigInt(second.reservation.reserved_atomic);

    const replay = reserve(
      second.next_state,
      walletId,
      signupAction,
      signupAnchor,
      walletId,
    );
    if (replay.allowed || replay.reason !== 'replay') {
      throw new Error('one-time Genesis replay was not denied');
    }
    replayDenials += 1;
  }
  return {
    wallets,
    genesisPEs: wallets * 2,
    reservedGrossAtomic: total.toString(),
    replayDenials,
  };
}

const launch = runScenario(20_000, 5_000);
if (launch.genesisPEs !== 50_000 || BigInt(launch.reservedGrossAtomic) !== 2_500_000n * ATOMIC) {
  throw new Error('25,000-wallet load scenario arithmetic mismatch');
}
const burst = runScenario(40_000, 10_000);
if (burst.genesisPEs !== 100_000 || BigInt(burst.reservedGrossAtomic) !== 5_000_000n * ATOMIC) {
  throw new Error('50,000-wallet burst scenario arithmetic mismatch');
}

process.stdout.write(`${JSON.stringify({
  schema_version: 'pvt-genesis-pure-kernel-load-result/v1',
  launch,
  two_times_burst: burst,
  assertions: {
    exact_75_plus_25_gross_reservation_input_per_wallet: true,
    one_time_replay_denied_for_every_wallet: true,
    no_production_services_used: true,
  },
}, null, 2)}\n`);
