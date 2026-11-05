/**
 * pe-weight-framework: action-type tier assertions.
 *
 * The full weight resolver runs in integration paths (pvt-accrual). This
 * file covers the behaviors that matter for action-type onboarding:
 *
 *   - An action type registered in ACTION_TYPE_TIERS resolves to that tier.
 *   - Unknown metadata shapes do not throw (the resolver looks at
 *     actionType + context only).
 *   - ai_conversation (Phase 2b) resolves at parity with inference_session
 *     so launch PVT math is identical for the two complementary signals.
 */

import {
  buildWeightConfigResponse,
  calculatePEWeight,
  getActionTypeTier,
  normalizeAttestationTier,
  NOVELTY_FACTORS,
  PEWeightInput,
} from './pe-weight-framework';

function baseInput(overrides: Partial<PEWeightInput> = {}): PEWeightInput {
  return {
    userId: 'user_test',
    actionType: 'inference_session',
    attestationDepth: 'software',
    isHumanLinked: false,
    dailyPECount: 0,
    occurrenceCount: 0,
    isDuplicate: false,
    ...overrides,
  };
}

describe('pe-weight-framework: ai_conversation', () => {
  it('resolves to tier 2 (standard), matching inference_session', () => {
    expect(getActionTypeTier('ai_conversation')).toBe(2);
    expect(getActionTypeTier('ai_conversation')).toBe(getActionTypeTier('inference_session'));
  });

  it('produces the same PVT estimate as inference_session for identical input', () => {
    const ai = calculatePEWeight(baseInput({ actionType: 'ai_conversation' }));
    const inf = calculatePEWeight(baseInput({ actionType: 'inference_session' }));
    expect(ai.estimatedPVT).toBe(inf.estimatedPVT);
    expect(ai.tier).toBe(inf.tier);
    expect(ai.tierMultiplier).toBe(inf.tierMultiplier);
  });

  it('does not throw when the caller supplies no metadata context', () => {
    // input_fidelity lives in PE metadata, not PEWeightInput. The current
    // resolver ignores it entirely (future governance hook). Calling the
    // resolver without any PE metadata must succeed.
    expect(() =>
      calculatePEWeight(baseInput({ actionType: 'ai_conversation' })),
    ).not.toThrow();
  });

  it('respects attestation multiplier (hardware_full vs software)', () => {
    const hw = calculatePEWeight(baseInput({
      actionType: 'ai_conversation',
      attestationDepth: 'hardware_full',
    }));
    const sw = calculatePEWeight(baseInput({
      actionType: 'ai_conversation',
      attestationDepth: 'software',
    }));
    expect(hw.estimatedPVT).toBeGreaterThan(sw.estimatedPVT);
    expect(hw.attestationMultiplier).toBe(2.5);
    expect(sw.attestationMultiplier).toBe(0.8);
  });

  it('canonicalizes TPM/generic device evidence to partial and unknown to software', () => {
    expect(normalizeAttestationTier('hardware_tpm')).toBe('hardware_partial');
    expect(normalizeAttestationTier('hardware_limited')).toBe('hardware_partial');
    expect(normalizeAttestationTier('hardware_full')).toBe('hardware_full');
    expect(normalizeAttestationTier('unknown')).toBe('software');
    expect(normalizeAttestationTier(null)).toBe('software');
  });

  it('applies the 2x factor only when verified linkage is supplied', () => {
    const linked = calculatePEWeight(baseInput({
      actionType: 'ai_conversation',
      isHumanLinked: true,
    }));
    const unlinked = calculatePEWeight(baseInput({
      actionType: 'ai_conversation',
      isHumanLinked: false,
    }));
    expect(linked.estimatedPVT).toBe(unlinked.estimatedPVT * 2);
    expect(linked.humanTrustBonus).toBe(2.0);
    expect(unlinked.humanTrustBonus).toBe(1.0);
  });

  it('applies novelty decay across repeated occurrences within a day', () => {
    const first = calculatePEWeight(baseInput({
      actionType: 'ai_conversation',
      occurrenceCount: 0,
    }));
    const fourth = calculatePEWeight(baseInput({
      actionType: 'ai_conversation',
      occurrenceCount: 4,
    }));
    expect(first.noveltyFactor).toBeGreaterThan(fourth.noveltyFactor);
  });

  describe('the novelty curve is PINNED (valuation, not deterrent)', () => {
    it('the exact ruled curve: 1.0 / 1.0 / 0.7 / 0.4, floor 0.3, dupe 0', () => {
      const at = (occurrenceCount: number): number =>
        calculatePEWeight(baseInput({ actionType: 'ai_conversation', occurrenceCount }))
          .noveltyFactor;
      expect(at(1)).toBe(1.0);
      expect(at(2)).toBe(0.7);
      expect(at(3)).toBe(0.4);
      expect(at(4)).toBe(0.3);
      expect(at(100)).toBe(0.3); // the floor never gates: > 0 for non-dupes
      const dupe = calculatePEWeight(baseInput({
        actionType: 'ai_conversation',
        occurrenceCount: 1,
        isDuplicate: true,
      }));
      expect(dupe.noveltyFactor).toBe(0); // a duplicate is not new work
    });

    it('genuinely different work is exempt: artifact-aware keeps full value to 10/day', () => {
      const tenth = calculatePEWeight(baseInput({
        actionType: 'agent_work_product',
        occurrenceCount: 10,
        isUniqueArtifact: true,
      }));
      expect(tenth.noveltyFactor).toBe(1.0);
    });

    it('NEGATIVE CONTROL — the pinned table is frozen; a real mutation attempt does not take', () => {
      // The PRODUCTION table itself, not a copy. Strict-mode assignment to a
      // frozen property throws, so deleting the Object.freeze on
      // NOVELTY_FACTORS (the pin) turns BOTH expectations red: the
      // write stops throwing AND the priced value moves.
      expect(Object.isFrozen(NOVELTY_FACTORS)).toBe(true);
      expect(() => {
        (NOVELTY_FACTORS as Record<number, number>)[2] = 0.9;
      }).toThrow(TypeError);
      expect(NOVELTY_FACTORS[2]).toBe(0.7);
      expect(calculatePEWeight(baseInput({
        actionType: 'ai_conversation', occurrenceCount: 2,
      })).noveltyFactor).toBe(0.7);
      // The public copy mirrors the frozen source.
      expect(buildWeightConfigResponse().novelty_factors[2]).toBe(0.7);
    });
  });

  describe('same-day volume never reprices (the diminishing multiplier is gone)', () => {
    it('the price is identical at volume 0, 49, 51, and 2000', () => {
      const priceAt = (dailyPECount: number): number =>
        calculatePEWeight(baseInput({ actionType: 'ai_conversation', dailyPECount }))
          .estimatedPVT;
      const baseline = priceAt(0);
      expect(baseline).toBeGreaterThan(0); // anti-vacuity: a real price, not zero
      expect(priceAt(49)).toBe(baseline);
      expect(priceAt(51)).toBe(baseline);
      expect(priceAt(2000)).toBe(baseline);
    });
  });
});
