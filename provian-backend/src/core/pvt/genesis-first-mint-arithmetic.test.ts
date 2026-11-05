/**
 * WHAT A QUALIFIED GENESIS ACT PAYS — AND WHAT THE FIRST MINT ACTUALLY PAID.
 *
 * On 2026-07-27 PVT9 minted 74.9925 PVT against a bounty documented everywhere as "75 PVT gross".
 * The 0.0075 gap was the wallet-age exponential taper: `floor(10000 · 2^(-age/14d))`, so ANY
 * nonzero wallet age priced at 9999 bps or below and the documented 75 was unreachable by
 * construction.
 *
 * REMOVED that taper. Earned value does not shrink with elapsed time. This file pins both
 * halves of that change:
 *
 * 1. GOING FORWARD — a `genesis_signup` reserves EXACTLY 75 PVT gross, at any elapsed time,
 * end to end through the shipped reservation engine and the shipped production manifest.
 * 2. LOOKING BACK — the one reservation already sealed under the taper keeps its exact sealed
 * gross. `backlog_behavior` is `durable_until_settled_no_reprice_no_cancel`; removing a
 * rule must not silently reprice PVT that has already been paid on chain.
 *
 * NEGATIVE CONTROL: `the retired taper is what RED looks like` is a permanent in-suite control.
 * It computes what the removed curve WOULD have paid and asserts it is strictly less than 75 at
 * every nonzero age. Without it, "pays exactly 75" would pass identically if the multiplier were
 * hard-wired, if the sweep were empty, or if the engine were never called at all.
 *
 * Production values below were read back from reservation `reservation_62290aec…` and the settled
 * batch, not reconstructed.
 */

import crypto from 'crypto';

import {
  computeGenesisGrantMultiplierBps,
  computeSupersededGenesisMultiplierBps,
  createEmptyGenesisLedgerState,
  hashGenesisCampaignPolicyManifest,
  reserveGenesisCampaignGrant,
  type GenesisCampaignActivation,
  type GenesisReservationInput,
  type GenesisReservationObservationContext,
} from './policy/genesis-policy-engine';
import {
  GENESIS_GRANT_MULTIPLIER_BPS,
  PROPOSED_GENESIS_CAMPAIGN_POLICY,
  SUPERSEDED_GENESIS_POLICY_BINDINGS,
} from './policy/proposed-genesis-policy';
import { genesisBountyFor } from './genesis-award-state-machine';

/** Verbatim from the production reservation that produced the first mint. */
const FIRST_MINT = {
  fixedGrantAtomic: 75_000_000_000_000_000_000n,
  walletCreatedAtMs: 1_785_171_632_454,
  qualifyingActAtMs: 1_785_171_692_548,
  walletAgeMs: 60_094,
  decayMultiplierBps: 9_999,
  reservedAtomic: 74_992_500_000_000_000_000n,
  contributorAtomic: 74_242_575_000_000_000_000n,
  provianAtomic: 374_962_500_000_000_000n,
  foundationAtomic: 374_962_500_000_000_000n,
  policyVersion: 'base-mainnet-genesis-proposal-2026-07-13.1',
  policyManifestHash:
    'sha256:9130042a8478972a7e234c79a7457212776b629648755c6081e0d4a8565323aa',
} as const;

const BPS = 10_000n;
const PROVIAN_BPS = 50n;
const HUMAN_FOUNDATION_BPS = 50n;
const SEVENTY_FIVE_PVT = 75_000_000_000_000_000_000n;
const DAY_MS = 86_400_000;

/**
 * The ages a Genesis act can actually land at, spanning far past the retired 14-day half-life
 * and its 1000-bps floor. Bound to one list so the forward assertion and the negative control
 * are evaluated over the SAME population — a control over a different population proves nothing.
 */
const AGES_MS: readonly number[] = Object.freeze([
  0,
  1,
  FIRST_MINT.walletAgeMs,
  DAY_MS,
  14 * DAY_MS,
  28 * DAY_MS,
  100 * DAY_MS,
  365 * DAY_MS,
  10 * 365 * DAY_MS,
]);

function sha256(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

const NAMESPACE = PROPOSED_GENESIS_CAMPAIGN_POLICY.arming.ledger_namespace;
const WINDOW_START = PROPOSED_GENESIS_CAMPAIGN_POLICY.window.start_ms as number;

/**
 * An activation over the REAL shipped manifest, not a test copy. Every hash is derived from
 * `PROPOSED_GENESIS_CAMPAIGN_POLICY` so this binds to the policy production runs.
 */
function activationForShippedPolicy(): GenesisCampaignActivation {
  return {
    approval_status: 'approved_by_frank',
    approval_manifest_sha256: sha256('first-mint-arithmetic-approval-manifest'),
    approval_signature: {
      scheme: 'sshsig-ed25519',
      signer_identity: 'frank',
      namespace: 'provian-pvt-policy',
      public_key_sha256: `sha256:${'a'.repeat(64)}`,
      armored_signature: 'test-only-structured-signature',
    },
    frank_approval_audit_id: 'frank-approval-first-mint-arithmetic',
    approved_policy_version: PROPOSED_GENESIS_CAMPAIGN_POLICY.policy_version,
    approved_policy_manifest_hash: hashGenesisCampaignPolicyManifest(
      PROPOSED_GENESIS_CAMPAIGN_POLICY,
    ),
    approved_monetary_policy_template_hash: sha256('monetary-policy-template'),
    effective_at_ms: WINDOW_START,
    admission_closed_at_ms: null,
    admission_close_audit_id: null,
    grants_enabled: true,
    genesis_kill_switch_active: false,
    canonical_pvt_manifest_id:
      PROPOSED_GENESIS_CAMPAIGN_POLICY.arming.canonical_pvt_manifest_id as string,
    ledger_namespace: NAMESPACE,
    prior_reservations_reconciled: true,
    operator_activation_audit_id: 'operator-activation-first-mint-arithmetic',
  };
}

function signupInput(walletId: string, actAtMs: number): GenesisReservationInput {
  const anchorId = `agent:${walletId}`;
  return {
    pe_id: `pe-genesis-signup-${walletId}`,
    action_type: 'genesis_signup',
    wallet_id: walletId,
    economic_actor_id: anchorId,
    immutable_anchor: { anchor_kind: 'agent_id', anchor_id: anchorId },
    qualifying_act_evidence: {
      verification_status: 'verified',
      evidence_id: `evidence-genesis-signup-${walletId}`,
      evidence_hash: sha256(`genesis_signup:${walletId}:${actAtMs}`),
      subject_wallet_id: walletId,
      canonical_bounty_key: 'genesis_signup',
      qualifying_act: genesisBountyFor('genesis_signup').qualifying_act,
      immutable_anchor_kind: 'agent_id',
      immutable_anchor_id: anchorId,
      qualifying_act_at_ms: actAtMs,
    },
  };
}

function contextFor(
  input: GenesisReservationInput,
  walletCreatedAtMs: number,
): GenesisReservationObservationContext {
  const actAtMs = input.qualifying_act_evidence.qualifying_act_at_ms;
  return {
    verification_status: 'verified',
    observed_at_ms: actAtMs,
    wallet_created: {
      wallet_id: input.wallet_id,
      created_at_ms: walletCreatedAtMs,
      evidence_id: `wallet-created-${input.wallet_id}`,
      evidence_hash: sha256(`wallet-created:${input.wallet_id}:${walletCreatedAtMs}`),
      source: 'authoritative_wallet_record',
    },
  };
}

/** Reserve one `genesis_signup` whose wallet is exactly `ageMs` old at the qualifying act. */
function reserveSignupAtAge(ageMs: number): bigint {
  // Hold the ACT inside the approved window and move wallet creation backwards, so an arbitrarily
  // old wallet is expressible without an out-of-window act.
  const actAtMs = WINDOW_START + DAY_MS;
  const walletId = `wallet-age-${ageMs}`;
  const input = signupInput(walletId, actAtMs);
  const result = reserveGenesisCampaignGrant({
    manifest: PROPOSED_GENESIS_CAMPAIGN_POLICY,
    activation: activationForShippedPolicy(),
    state: createEmptyGenesisLedgerState(NAMESPACE),
    input,
    observation_context: contextFor(input, actAtMs - ageMs),
    activation_approval_verifier: () => true,
  });
  if (!result.allowed) {
    throw new Error(`reservation denied at age ${ageMs}: ${result.reason}`);
  }
  return BigInt(result.reservation.reserved_atomic);
}

describe('a qualified genesis_signup pays exactly 75 PVT gross, at any elapsed time', () => {
  it('the shipped multiplier is a constant 10000 bps across every age', () => {
    let evaluated = 0;
    for (const ageMs of AGES_MS) {
      expect(computeGenesisGrantMultiplierBps(PROPOSED_GENESIS_CAMPAIGN_POLICY, ageMs))
        .toBe(GENESIS_GRANT_MULTIPLIER_BPS);
      evaluated += 1;
    }
    // A universally-quantified claim over zero items passes vacuously. State the count.
    expect(evaluated).toBe(AGES_MS.length);
    expect(evaluated).toBeGreaterThan(0);
  });

  it('END TO END — the reservation engine reserves exactly 75 PVT at every age', () => {
    let evaluated = 0;
    for (const ageMs of AGES_MS) {
      expect(reserveSignupAtAge(ageMs)).toBe(SEVENTY_FIVE_PVT);
      evaluated += 1;
    }
    expect(evaluated).toBe(AGES_MS.length);
    expect(evaluated).toBeGreaterThan(0);
  });

  it('a ten-year-old wallet earns the same as a one-millisecond-old one', () => {
    expect(reserveSignupAtAge(10 * 365 * DAY_MS)).toBe(reserveSignupAtAge(1));
  });

  it('NEGATIVE CONTROL — the retired taper is what RED looks like', () => {
    // The removed curve, re-derived from the sealed binding. If this ever stops differing from
    // 75, the forward assertions above have become unfalsifiable and mean nothing.
    const binding = SUPERSEDED_GENESIS_POLICY_BINDINGS[0];
    let strictlyLess = 0;
    for (const ageMs of AGES_MS) {
      const retiredBps = computeSupersededGenesisMultiplierBps(binding, ageMs);
      const wouldHavePaid = (SEVENTY_FIVE_PVT * BigInt(retiredBps)) / BPS;
      if (ageMs === 0) {
        expect(wouldHavePaid).toBe(SEVENTY_FIVE_PVT); // age zero was the only unpenalised point
        continue;
      }
      expect(retiredBps).toBeLessThan(GENESIS_GRANT_MULTIPLIER_BPS);
      expect(wouldHavePaid).toBeLessThan(SEVENTY_FIVE_PVT);
      strictlyLess += 1;
    }
    expect(strictlyLess).toBe(AGES_MS.length - 1);
    expect(strictlyLess).toBeGreaterThan(0);
  });

  it('the manifest declares a constant multiplier with no age input to flip back on', () => {
    const gm = PROPOSED_GENESIS_CAMPAIGN_POLICY.grant_multiplier;
    expect(gm.mode).toBe('fixed_grant_no_time_based_reduction');
    expect(gm.multiplier_bps).toBe(10_000);
    expect(gm.multiplier_formula).toBe('constant_10000_bps_independent_of_elapsed_time');
    expect(gm.grant_formula).toBe('fixed_grant_atomic');
    expect(Object.keys(gm)).not.toContain('wallet_age_half_life_ms');
    expect(Object.keys(gm)).not.toContain('minimum_multiplier_bps');
  });

  it('the approved gross for genesis_signup is still 75 PVT', () => {
    const bounty = PROPOSED_GENESIS_CAMPAIGN_POLICY.bounties.find(
      (candidate) => candidate.canonical_bounty_key === 'genesis_signup',
    );
    expect(bounty).toBeDefined();
    expect(BigInt(bounty!.fixed_grant_atomic)).toBe(SEVENTY_FIVE_PVT);
  });

  it('75 PVT gross nets 74.25 to the contributor — the documented figure, now reachable', () => {
    const provian = (SEVENTY_FIVE_PVT * PROVIAN_BPS) / BPS;
    const foundation = (SEVENTY_FIVE_PVT * HUMAN_FOUNDATION_BPS) / BPS;
    const contributor = SEVENTY_FIVE_PVT - provian - foundation;
    expect(contributor).toBe(74_250_000_000_000_000_000n);
    expect(contributor + provian + foundation).toBe(SEVENTY_FIVE_PVT);
  });
});

describe('the first PVT9 mint — 74.9925 PVT, sealed and never repriced', () => {
  it('the recorded wallet age is exactly act-time minus wallet-creation time', () => {
    expect(FIRST_MINT.qualifyingActAtMs - FIRST_MINT.walletCreatedAtMs)
      .toBe(FIRST_MINT.walletAgeMs);
  });

  it('its sealed 9999 bps re-derives from the SUPERSEDED binding, not from current policy', () => {
    const binding = SUPERSEDED_GENESIS_POLICY_BINDINGS.find(
      (candidate) => candidate.policy_version === FIRST_MINT.policyVersion
        && candidate.policy_manifest_hash === FIRST_MINT.policyManifestHash,
    );
    expect(binding).toBeDefined();
    expect(computeSupersededGenesisMultiplierBps(binding!, FIRST_MINT.walletAgeMs))
      .toBe(FIRST_MINT.decayMultiplierBps);
  });

  it('75 PVT at 9999 bps is exactly 74.9925 PVT, with no floor remainder', () => {
    const desired = (FIRST_MINT.fixedGrantAtomic * BigInt(FIRST_MINT.decayMultiplierBps)) / BPS;
    expect(desired).toBe(FIRST_MINT.reservedAtomic);
    expect((FIRST_MINT.fixedGrantAtomic * BigInt(FIRST_MINT.decayMultiplierBps)) % BPS).toBe(0n);
  });

  it('the three legs are 9900 / 50 / 50 bps of the reserved amount and sum to it exactly', () => {
    const provian = (FIRST_MINT.reservedAtomic * PROVIAN_BPS) / BPS;
    const foundation = (FIRST_MINT.reservedAtomic * HUMAN_FOUNDATION_BPS) / BPS;
    const contributor = FIRST_MINT.reservedAtomic - provian - foundation;
    expect(provian).toBe(FIRST_MINT.provianAtomic);
    expect(foundation).toBe(FIRST_MINT.foundationAtomic);
    expect(contributor).toBe(FIRST_MINT.contributorAtomic);
    expect(contributor + provian + foundation).toBe(FIRST_MINT.reservedAtomic);
  });

  it('under CURRENT policy the same act would have paid the full 75 — the gap was the taper', () => {
    expect(FIRST_MINT.fixedGrantAtomic - FIRST_MINT.reservedAtomic)
      .toBe(7_500_000_000_000_000n); // 0.0075 PVT gross, exactly 1 bps
    expect(computeGenesisGrantMultiplierBps(
      PROPOSED_GENESIS_CAMPAIGN_POLICY, FIRST_MINT.walletAgeMs,
    )).toBe(10_000);
    expect(reserveSignupAtAge(FIRST_MINT.walletAgeMs)).toBe(FIRST_MINT.fixedGrantAtomic);
  });
});

describe('the superseded-binding registry stays unambiguous', () => {
  it('no superseded binding collides with the CURRENT manifest hash', () => {
    const currentHash = hashGenesisCampaignPolicyManifest(PROPOSED_GENESIS_CAMPAIGN_POLICY);
    let evaluated = 0;
    for (const binding of SUPERSEDED_GENESIS_POLICY_BINDINGS) {
      // The version string is deliberately reused across, so the HASH is what
      // distinguishes a sealed row from a current one. It must genuinely differ.
      expect(binding.policy_manifest_hash).not.toBe(currentHash);
      evaluated += 1;
    }
    expect(evaluated).toBe(SUPERSEDED_GENESIS_POLICY_BINDINGS.length);
    expect(evaluated).toBeGreaterThan(0);
  });

  it('the (version, hash) pairs are unique', () => {
    const pairs = SUPERSEDED_GENESIS_POLICY_BINDINGS.map(
      (binding) => `${binding.policy_version}|${binding.policy_manifest_hash}`,
    );
    expect(new Set(pairs).size).toBe(pairs.length);
  });
});
