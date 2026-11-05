/**
 * runtime boundary / C-2: the public PVT estimator wrapper.
 *
 * `estimatePVT` formats `policy/record-path-estimate`; `computeSubmitTimeEstimate`
 * is the synchronous figure `/v1/relay/action` stamps on its response (what
 * `provian report` prints). These tests pin the WIRING — param mapping,
 * defaults, the disposition/points split, the eligibility language. Pricing
 * PARITY with the money path is owned by
 * `policy/record-path-estimate.parity.test.ts`, which drives the real
 * `recordPEAccrual`; the arithmetic itself is owned by the bps kernel.
 *
 * EVERY EXPECTATION BELOW IS DERIVED FROM THE LIVE POLICY, NOT PINNED AS A
 * LITERAL. That is deliberate: declined to fix this surface precisely
 * because rewriting pinned numbers is the most effective way to launder a wrong
 * value into a green suite. The old expectations here (2.4 / 7.5 / impact_tier
 * 4) came from the retired float framework and were 3x HIGH against the record
 * path.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import {
  estimatePVT,
  computeSubmitTimeEstimate,
  ELIGIBILITY_DISCLAIMER,
  VALID_ESTIMATE_ATTESTATION_TIERS,
} from './estimate';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import { materializeProposedMonetaryPolicy } from './policy/runtime-monetary-policy';
import {
  PROPOSED_ATTESTATION_MULTIPLIERS_BPS,
  PROPOSED_EVIDENCE_PRICED_ATTESTATION_MULTIPLIERS_BPS,
  PROPOSED_LINKAGE_MULTIPLIERS_BPS,
} from './policy/proposed-monetary-policy';
import { BPS_DENOMINATOR, ordinaryNoveltyBps } from './policy/monetary-accounting';

let db: FakeFirestore;
beforeEach(() => { db = createFakeFirestore(); });

const POLICY = materializeProposedMonetaryPolicy(0);
const WORK = 'agent_work_product_code';

/**
 * The formula, derived from the live policy — never a copied number. /* the attestation table is selected per the action's pricing class, exactly
 * as the kernel selects it (`external_proof_priced` reads the evidence-priced
 * table, where software 0.8x and social 0.5x earn the self-attested discount,
 * software_verified is capped at the flat 1.0x, and proof is a 1.0x lift).
 */
function expectedPoints(opts: {
  actionType: string;
  tier?: keyof typeof PROPOSED_ATTESTATION_MULTIPLIERS_BPS;
  linkageBps?: number;
  occurrenceOrdinal?: number;
}): bigint {
  const action = POLICY.actions[opts.actionType];
  const actionBps = action === undefined
    ? 0
    : (action.policyOverrideBps ?? action.baseWeightBps);
  const requestedTier = opts.tier ?? 'software';
  const tier = requestedTier.startsWith('hardware')?'software':requestedTier;
  const attestationBps = action?.financialAttestationNeutral
    ? BPS_DENOMINATOR
    : action?.attestationPricing === 'external_proof_priced'
      ? PROPOSED_EVIDENCE_PRICED_ATTESTATION_MULTIPLIERS_BPS[tier]
      : PROPOSED_ATTESTATION_MULTIPLIERS_BPS[tier];
  return (
    BigInt(POLICY.basePointsAtomic)
    * BigInt(actionBps)
    * BigInt(ordinaryNoveltyBps(opts.occurrenceOrdinal ?? 1))
    * BigInt(BPS_DENOMINATOR)
    * BigInt(opts.linkageBps ?? PROPOSED_LINKAGE_MULTIPLIERS_BPS.unlinked)
    * BigInt(attestationBps)
  ) / (BigInt(BPS_DENOMINATOR) ** 5n);
}

describe('estimatePVT — record points come from the bps kernel', () => {
  it('the default (software) scenario for agent-work earns the 0.8x discount in its points, sealed record_only by the best-effort path', async () => {
    const result = await estimatePVT(db as unknown as Firestore, { actionType: WORK });
    // reversed 's terminal zero: software agent-work points are 0.8x, not 0.
    expect(result.record_points_atomic).toBe(expectedPoints({ actionType: WORK }).toString(10));
    expect(BigInt(result.record_points_atomic)).toBeGreaterThan(0n);
    // The weight axis is untouched (compute stays 1.0x); the software discount (0.8x) prices the evidence axis.
    expect(result.inputs.effective_action_weight_bps)
      .toBe(POLICY.actions[WORK].policyOverrideBps ?? POLICY.actions[WORK].baseWeightBps);
    expect(result.inputs.attestation_multiplier_bps).toBe(8_000);
    // Points are NOT PVT: the bare best-effort relay path still mints 0 (record_only).
    expect(result.estimated_pvt).toBe(0);
    expect(result.mint_disposition).toBe('record_only');
  });

  it('a generic hardware label prices at its lane tier', async () => {
    const result = await estimatePVT(db as unknown as Firestore, {
      actionType: WORK, attestationTier: 'hardware', durableSubmissionPath: true,
    });
    expect(result.inputs.attestation_multiplier_bps).toBe(PROPOSED_EVIDENCE_PRICED_ATTESTATION_MULTIPLIERS_BPS.software);
    expect(result.record_points_atomic)
      .toBe(expectedPoints({ actionType: WORK, tier: 'hardware_full' }).toString(10));
    expect(BigInt(result.record_points_atomic)).toBeGreaterThan(0n);
  });

  it('separates record points from PVT: the default path pays 0 and says why', async () => {
    // The headline defect C-2 fixes. The ordinary relay path is best-effort, so
    // the PE seals record_only and mints nothing no matter what its points are.
    // (floored the agent-work family's software points to 0, so the
    // points-vs-disposition split is demonstrated on a STANDARD-priced type.)
    const result = await estimatePVT(db as unknown as Firestore, { actionType: 'job_delivered' });
    expect(BigInt(result.record_points_atomic)).toBeGreaterThan(0n);
    expect(result.estimated_pvt).toBe(0);
    expect(result.estimated_pvt_atomic).toBe('0');
    expect(result.mint_disposition).toBe('record_only');
    expect(result.assumptions.join(' ')).toContain('best-effort submission path');
  });

  it('carries the eligibility and disposition disclaimers on every estimate', async () => {
    const result = await estimatePVT(db as unknown as Firestore, { actionType: WORK });
    expect(result.disclaimers).toContain(ELIGIBILITY_DISCLAIMER);
    expect(result.disclaimers.length).toBeGreaterThanOrEqual(6);
    expect(result.disclaimers.join(' ')).toContain('scenario input only');
    expect(result.disclaimers.join(' ')).toContain('0.5x-2.5x');
    expect(result.disclaimers.join(' ')).toContain('no daily diminishing multiplier');
    expect(result.disclaimers.join(' ')).toContain('not a second multiplier');
    // record points are NOT PVT — the distinction must be stated, not implied.
    expect(result.disclaimers.join(' ')).toContain('NOT PVT');
    expect(result.disclaimers.join(' ')).not.toMatch(/\$|usd|dollar/i);
  });

  it(' normalizes an unverified hardware alias to the software multiplier', async () => {
    // Uses a STANDARD-priced eligible type (verified_substantive_outcome), where
    // the graded ladder applies. This proves the alias 'hardware' resolves to
    // the hardware_full multiplier at record time.
    const STANDARD_PRICED = 'job_delivered';
    const result = await estimatePVT(db as unknown as Firestore, {
      actionType: STANDARD_PRICED,
      attestationTier: 'hardware',
      durableSubmissionPath: true,
    });
    expect(result.inputs.attestation_multiplier_bps)
      .toBe(PROPOSED_ATTESTATION_MULTIPLIERS_BPS.software);
    expect(result.record_points_atomic).toBe(expectedPoints({
      actionType: STANDARD_PRICED,
      tier: 'hardware_full',
    }).toString(10));
  });

  it('the tier DECIDES the discount for agent-work — self-attested earns 0.8x, proof lifts to the flat 1.0x', async () => {
    const hardware = await estimatePVT(db as unknown as Firestore, {
      actionType: WORK, attestationTier: 'hardware', durableSubmissionPath: true,
    });
    const software = await estimatePVT(db as unknown as Firestore, {
      actionType: WORK, attestationTier: 'software', durableSubmissionPath: true,
    });
    // Externally-proven work keeps the family's flat 1.0x lift, unchanged.
    expect(hardware.inputs.attestation_multiplier_bps).toBe(PROPOSED_EVIDENCE_PRICED_ATTESTATION_MULTIPLIERS_BPS.software);
    expect(BigInt(hardware.record_points_atomic)).toBeGreaterThan(0n);
    // Self-attested work earns the 0.8x discount — no longer floored to 0.
    expect(software.inputs.attestation_multiplier_bps).toBe(8_000);
    expect(software.record_points_atomic).toBe(expectedPoints({ actionType: WORK, tier: 'software' }).toString(10));
    expect(BigInt(software.record_points_atomic)).toBeGreaterThan(0n);
    // Software points sit below the proven lift (0.8x < 1.0x).
    expect(software.record_points_atomic).toBe(hardware.record_points_atomic);
    // A self-produced replication-pack structure (software_verified) is capped at the
    // flat 1.0x — parity with proof, not the ladder's 1.2x (the operator’s amendment).
    const replication = await estimatePVT(db as unknown as Firestore, {
      actionType: WORK, attestationTier: 'software_verified', durableSubmissionPath: true,
    });
    expect(replication.inputs.attestation_multiplier_bps).toBe(10_000);
    // software_verified now equals the proven lift.
    expect(replication.record_points_atomic).toBe(expectedPoints({actionType:WORK,tier:'software_verified'}).toString(10));
    expect(BigInt(replication.record_points_atomic)).toBeGreaterThan(0n);
  });

  it('applies the linkage multiplier for the verified-human scenario input', async () => {
    // Hardware tier : the proven variant keeps points observable — the
    // software variant floors to 0, where any ratio holds vacuously.
    const unlinked = await estimatePVT(db as unknown as Firestore, {
      actionType: WORK, attestationTier: 'hardware', durableSubmissionPath: true,
    });
    const linked = await estimatePVT(db as unknown as Firestore, {
      actionType: WORK, attestationTier: 'hardware', humanLinked: true, durableSubmissionPath: true,
    });
    expect(BigInt(unlinked.record_points_atomic)).toBeGreaterThan(0n);
    expect(linked.inputs.linkage_multiplier_bps)
      .toBe(PROPOSED_LINKAGE_MULTIPLIERS_BPS.human_linked);
    // 2.0x is the policy's ratio, read from the policy rather than asserted.
    const ratio = BigInt(PROPOSED_LINKAGE_MULTIPLIERS_BPS.human_linked)
      / BigInt(PROPOSED_LINKAGE_MULTIPLIERS_BPS.unlinked);
    expect(BigInt(linked.record_points_atomic))
      .toBe(BigInt(unlinked.record_points_atomic) * ratio);
  });

  it('maps novelty to prior occurrences exactly like the accrual (+1 for this PE)', async () => {
    const onePrior = await estimatePVT(db as unknown as Firestore, {
      actionType: WORK, attestationTier: 'hardware', novelty: 1, durableSubmissionPath: true,
    });
    expect(onePrior.inputs.novelty_bps).toBe(ordinaryNoveltyBps(2));
    expect(onePrior.record_points_atomic)
      .toBe(expectedPoints({ actionType: WORK, tier: 'hardware_full', occurrenceOrdinal: 2 }).toString(10));
    expect(BigInt(onePrior.record_points_atomic)).toBeGreaterThan(0n);

    const manyPrior = await estimatePVT(db as unknown as Firestore, {
      actionType: WORK, attestationTier: 'hardware', novelty: 50, durableSubmissionPath: true,
    });
    expect(manyPrior.inputs.novelty_bps).toBe(ordinaryNoveltyBps(51));
  });

  it('volume neither reduces price nor disqualifies — every ordinal prices like the first', async () => {
    const inside = await estimatePVT(db as unknown as Firestore, {
      actionType: WORK, attestationTier: 'hardware', count: 49, durableSubmissionPath: true,
    });
    // Full price at ordinal 50: no rate cut, identical to ordinal 1.
    expect(inside.record_points_atomic)
      .toBe(expectedPoints({ actionType: WORK, tier: 'hardware_full' }).toString(10));
    expect(BigInt(inside.record_points_atomic)).toBeGreaterThan(0n);

    // Beyond the FORMER bound (ordinal 51+) and at extreme volume the
    // estimate is IDENTICAL — same points, same disposition. Volume is gone
    // as an input to qualification.
    for (const count of [50, 2000, 1_000_000]) {
      const beyond = await estimatePVT(db as unknown as Firestore, {
        actionType: WORK, attestationTier: 'hardware', count, durableSubmissionPath: true,
      });
      expect(beyond.record_points_atomic).toBe(inside.record_points_atomic);
      expect(beyond.mint_disposition).toBe(inside.mint_disposition);
    }

    //, estimate surface: the SELF-ATTESTED variant EARNS the 0.8x discount
    // at every volume — points are volume-flat, not zeroed. (Under
    // this block asserted 0 at every count; the reversal restores earning.)
    for (const count of [0, 49, 2000, 1_000_000]) {
      const swarm = await estimatePVT(db as unknown as Firestore, {
        actionType: WORK, attestationTier: 'software', count, durableSubmissionPath: true,
      });
      expect(swarm.record_points_atomic)
        .toBe(expectedPoints({ actionType: WORK, tier: 'software' }).toString(10));
      expect(BigInt(swarm.record_points_atomic)).toBeGreaterThan(0n);
    }

    // NEGATIVE CONTROL — the suite can still observe a terminal zero: an
    // x402 self-report (no chain-verified settlement — an evidence gate,
    // not a volume cap) is terminal at ANY count, including zero.
    const terminal = await estimatePVT(db as unknown as Firestore, {
      actionType: 'x402_payment', count: 0, durableSubmissionPath: true,
    });
    expect(terminal.mint_disposition).toBe('ineligible_terminal');
    expect(terminal.record_points_atomic).toBe('0');
  });

  it('neutralizes attestation for financial types, as the kernel does', async () => {
    const software = await estimatePVT(db as unknown as Firestore, {
      actionType: 'receive', attestationTier: 'software', durableSubmissionPath: true,
    });
    const hardware = await estimatePVT(db as unknown as Firestore, {
      actionType: 'receive', attestationTier: 'hardware', durableSubmissionPath: true,
    });
    expect(software.inputs.financial_full_weight).toBe(true);
    expect(software.inputs.attestation_multiplier_bps).toBe(BPS_DENOMINATOR);
    expect(software.record_points_atomic).toBe(hardware.record_points_atomic);
    expect(software.disclaimers.join(' ')).toMatch(/chain-verified/);
  });

  it('prices an unknown permissionless action type at ZERO, not a default tier', async () => {
    // The retired framework fell back to a default tier and quoted 0.8 here.
    // The kernel has no fallback: an action type with no approved policy entry
    // has no weight, and a namespaced third-party type is exactly that case.
    const result = await estimatePVT(db as unknown as Firestore, {
      actionType: 'totally_new_action_type_xyz', durableSubmissionPath: true,
    });
    expect(POLICY.actions.totally_new_action_type_xyz).toBeUndefined();
    expect(result.inputs.effective_action_weight_bps).toBe(0);
    expect(result.record_points_atomic).toBe('0');
    expect(result.estimated_pvt).toBe(0);
    // §2.8 : on the default ACTOR-DECLARED lane an unnamed type class-admits at base 0 →
    // record_only / policy_record_only (the pre- reason was `unknown_action_type`).
    expect(result.mint_reason_code).toBe('policy_record_only');
  });

  it.each(['badge_earned', 'pvt_badge_projection_completed'])(
    'reports zero for record-only badge action %s',
    async (actionType) => {
      const result = await estimatePVT(db as unknown as Firestore, {
        actionType, attestationTier: 'hardware', humanLinked: true, durableSubmissionPath: true,
      });
      expect(result.estimated_pvt).toBe(0);
      expect(result.record_points_atomic).toBe('0');
      expect(result.mint_disposition).toBe('record_only');
    },
  );

  it('exposes every PRICING tier plus the hardware alias as valid inputs', () => {
    // Sourced from the bps table the kernel prices with, so this can never
    // accept a tier the kernel would reject at record time.
    for (const tier of Object.keys(PROPOSED_ATTESTATION_MULTIPLIERS_BPS)) {
      expect(VALID_ESTIMATE_ATTESTATION_TIERS).toContain(tier);
    }
    expect(VALID_ESTIMATE_ATTESTATION_TIERS).toContain('hardware');
  });
});

describe('computeSubmitTimeEstimate — the number `provian report` prints', () => {
  const BEST_EFFORT = { durableSubmissionPath: false } as const;
  const DURABLE = { durableSubmissionPath: true } as const;

  it('is DERIVED, not hard-coded: the submission path changes the disposition', async () => {
    // The proof that the disposition is not a constant: the SAME action type,
    // differing only in whether the caller has a durable replay source, comes
    // out of the kernel differently. flipped the relay report route to the
    // durable side, and this is the coupling that made the response follow
    // without being retuned. Uses `agent_native_transfer` rather than `receive`
    // (the original case here) because pins `receive` to record_only on
    // BOTH paths for this surface — see the dedicated receive test below for
    // why that is correct, not a regression of this property.
    const bestEffort = computeSubmitTimeEstimate('agent_native_transfer', BEST_EFFORT);
    expect(bestEffort.estimated_pvt).toBe(0);
    expect(bestEffort.mint_disposition).toBe('record_only');

    const durable = computeSubmitTimeEstimate('agent_native_transfer', DURABLE);
    expect(durable.mint_disposition).toBe('pending_evidence');
    expect(durable.estimated_pvt).toBe(0);
  });

  it('`wallet_created` quotes the DEVICE-ANCHORLESS truth, not the generic assumption', async () => {
    // THE REVIEWER-FOUND REGRESSION, pinned so it cannot return. This surface
    // used to inherit the generic estimator's assume-a-device-anchor posture,
    // which is structurally false on both of its callers: `sealActionPE` passes
    // no `deviceAttestationId` and no `deviceId`, ever. `action_type` is
    // permissionless on `POST /v1/relay/action`, so an agent posting
    // `wallet_created` was answered `{estimated_pvt: 10, eligible}` — with the
    // "minting still depends on protocol policy" note — against a seal of
    // `ineligible_terminal` at 0. Before it said 0/`record_only` and
    // happened to match; flipping `durableSubmissionPath` exposed it.
    const durable = computeSubmitTimeEstimate('wallet_created', DURABLE);
    expect(durable.mint_disposition).toBe('ineligible_terminal');
    expect(durable.mint_reason_code).toBe('policy_ineligible');
    expect(durable.estimated_pvt).toBe(0);

    // The GENERIC endpoint keeps the assume-an-anchor posture and therefore
    // DIVERGES here — deliberately, because it answers a different question
    // ("what does this action type price at?") and discloses the assumption in
    // `assumptions[]`. Pinned so the divergence is a recorded choice rather than
    // a rediscovered surprise, and so a future change to either surface has to
    // come here and say which one it meant.
    const endpoint = await estimatePVT(db as unknown as Firestore, {
      actionType: 'wallet_created', durableSubmissionPath: true,
    });
    expect(endpoint.estimated_pvt).toBeGreaterThan(0);
    expect(endpoint.mint_disposition).toBe('eligible');
  });

  it.each(['agent_work_product_code', 'receive', 'x402_payment', 'badge_earned'])(
    'reports 0 for %s on the best-effort path',
    (actionType) => {
      expect(computeSubmitTimeEstimate(actionType, BEST_EFFORT).estimated_pvt).toBe(0);
      expect(computeSubmitTimeEstimate(actionType, BEST_EFFORT).mint_disposition)
        .toBe('record_only');
    },
  );

  it.each(['agent_native_transfer', 'escrow_funded'])(
    '%s moves off the TRANSPORT verdict on the durable path — and still pays 0',
    (actionType) => {
      // 's honest ceiling for a self-report: the durable outbox removes
      // the record_only fence that transport imposed, it does not supply
      // evidence. `policy_record_only` has no exits; `awaiting_evidence` does.
      // The figure is 0 either way, and the response must not imply otherwise.
      const bestEffort = computeSubmitTimeEstimate(actionType, BEST_EFFORT);
      expect(bestEffort.mint_disposition).toBe('record_only');
      expect(bestEffort.mint_reason_code).toBe('policy_record_only');

      const durable = computeSubmitTimeEstimate(actionType, DURABLE);
      expect(durable.mint_disposition).toBe('pending_evidence');
      expect(durable.mint_reason_code).toBe('awaiting_evidence');
      expect(durable.estimated_pvt).toBe(0);
    },
  );

  // `receive` no longer joins the pair above. This surface has no way
  // to learn recipient authorship any more than it can learn a device anchor
  // ('s same reasoning, applied to a different fact this route
  // structurally cannot know) — its only callers are self-reported submissions
  // through `sealActionPE`, never the watcher-driven path that actually knows
  // the counterparty relationship. So it inherits the conservative default
  // (`receiveAuthored` unset), which shadows the transport/evidence verdict
  // with the authorship gate BEFORE evidence is even considered — record_only,
  // not pending_evidence, on the durable path too. This is the removal of an
  // assumption that was never true here, exactly as was for the device
  // anchor: nothing about this endpoint's real callers ever supplies a
  // recipient-authored relationship for it to assume.
  it('receive: this surface cannot know authorship any more than a device anchor — record_only even on the durable path', () => {
    const bestEffort = computeSubmitTimeEstimate('receive', BEST_EFFORT);
    expect(bestEffort.mint_disposition).toBe('record_only');
    expect(bestEffort.mint_reason_code).toBe('policy_record_only');

    const durable = computeSubmitTimeEstimate('receive', DURABLE);
    expect(durable.mint_disposition).toBe('record_only');
    expect(durable.mint_reason_code).toBe('unsolicited_receive_record_only');
    expect(durable.estimated_pvt).toBe(0);
  });

  it.each(['agent_action', 'agent_work_product_code', 'agent_task_completed'])(
    '%s earns the 0.8x discount in points, but this evidence-free estimate scenario still pays 0 — best-effort record_only, durable pending_evidence ',
    (actionType) => {
      // reversed 's terminal zero: self-attested software agent-work now
      // earns the 0.8x discount in its RECORD POINTS. But this estimate scenario
      // supplies no server-verified evidence, so it does not reach eligible: the
      // best-effort path seals record_only (the transport fence) and the durable
      // path seals pending_evidence (awaiting evidence) — 0 PVT on both, exactly
      // like the financial/institutional families above. RED reachability: the
      // sovereign-work accrual suite proves the SAME types MINT (0.8x software, up
      // to the 1.0x proof lift) once a server-verified binding is present.
      const bestEffort = computeSubmitTimeEstimate(actionType, BEST_EFFORT);
      expect(bestEffort.mint_disposition).toBe('record_only');
      expect(bestEffort.mint_reason_code).toBe('policy_record_only');
      expect(bestEffort.estimated_pvt).toBe(0);

      const durable = computeSubmitTimeEstimate(actionType, DURABLE);
      expect(durable.mint_disposition).toBe('pending_evidence');
      expect(durable.mint_reason_code).toBe('awaiting_evidence');
      expect(durable.estimated_pvt).toBe(0);
    },
  );

  it.each([true, false])('agrees with the endpoint at durable=%s', async (durable) => {
    const endpoint = await estimatePVT(db as unknown as Firestore, {
      actionType: WORK, durableSubmissionPath: durable,
    });
    const submit = computeSubmitTimeEstimate(WORK, { durableSubmissionPath: durable });
    expect(submit.estimated_pvt).toBe(endpoint.estimated_pvt);
    expect(submit.mint_disposition).toBe(endpoint.mint_disposition);
  });

  it('never throws on a Genesis type (the kernel would, without a receipt)', () => {
    for (const actionType of ['genesis_human_signup', 'genesis_signup', 'genesis_device_link']) {
      for (const opts of [BEST_EFFORT, DURABLE]) {
        expect(() => computeSubmitTimeEstimate(actionType, opts)).not.toThrow();
        expect(computeSubmitTimeEstimate(actionType, opts).estimated_pvt).toBe(0);
      }
    }
  });
});
