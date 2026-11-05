/**
 * Phase 5 (item 07) — the row → verifier coverage gate.
 *
 * CI already enforces the matrix pin, emitter→row coverage, the template digest,
 * and the money-path tripwire. It did NOT enforce that an ELIGIBLE row actually
 * has a verifier: an eligible row whose evidence class the resolver does not
 * recognize passes every existing check and then "pays zero forever" (it falls
 * through to `no_verifier_unknown_evidence_requirement`). This gate closes that
 * hole: every eligible matrix row that requires evidence must name a class the
 * resolver either verifies in place (a LIVE settlement arm) or has explicitly
 * declared as verified-elsewhere / not-held (`NO_VERIFIER_REASONS`).
 *
 * Bound to the single sources — the served matrix (`PROPOSED_ACTION_POLICY_ENTRIES`)
 * and the resolver's own `LIVE_SETTLEMENT_ARMS` + `NO_VERIFIER_REASONS` never a
 * copy. Ships with its RED control (an eligible row on an unwired class is caught).
 */

import { PROPOSED_ACTION_POLICY_ENTRIES } from './proposed-action-policy';
import type { ProposedActionPolicyEntry } from './types';
import type { ActionEvidenceRequirement } from './monetary-accounting';
import {
  LIVE_SETTLEMENT_ARMS,
  NO_VERIFIER_REASONS,
  isEligibleEvidenceClassCovered,
} from '../pending-evidence-resolver';

const eligibleWithEvidence = PROPOSED_ACTION_POLICY_ENTRIES.filter(
  (e) => e.mint_disposition === 'eligible' && e.evidence_requirement !== 'none',
);

function uncovered(entries: readonly ProposedActionPolicyEntry[]): string[] {
  return entries
    .filter((e) => !isEligibleEvidenceClassCovered(e.evidence_requirement))
    .map((e) => `${e.action_type}:${e.evidence_requirement}`);
}

describe('row → verifier coverage (item 07)', () => {
  it('the evaluated population is non-empty', () => {
    // A vacuous pass over zero eligible rows would tell us nothing.
    expect(eligibleWithEvidence.length).toBeGreaterThan(0);
  });

  it('every eligible+evidence matrix row names a verifier the resolver recognizes', () => {
    // Print the count so a pass is legibly non-vacuous.
    // eslint-disable-next-line no-console
    console.log(`[row→verifier] checked ${eligibleWithEvidence.length} eligible+evidence rows`);
    expect(uncovered(eligibleWithEvidence)).toEqual([]);
  });

  it('live arms and declared no-verifier classes are DISJOINT (a class is one or the other)', () => {
    for (const arm of LIVE_SETTLEMENT_ARMS) {
      expect(arm in NO_VERIFIER_REASONS).toBe(false);
    }
    expect(LIVE_SETTLEMENT_ARMS.size).toBeGreaterThan(0);
    expect(Object.keys(NO_VERIFIER_REASONS).length).toBeGreaterThan(0);
  });

  it('RED CONTROL — an eligible row on an unwired evidence class is flagged uncovered', () => {
    const base = eligibleWithEvidence[0];
    // Widen the input past the enum so the violating case is constructible (the
    // narrow type would forbid it at the call site, making the branch unreachable).
    const verifierless: ProposedActionPolicyEntry = {
      ...base,
      action_type: 'thirdparty:verifierless_eligible',
      evidence_requirement: 'verified_unwired_class_not_in_any_set' as unknown as ActionEvidenceRequirement,
    };
    // The predicate rejects it …
    expect(isEligibleEvidenceClassCovered(verifierless.evidence_requirement)).toBe(false);
    // … and the full-list gate reports it, proving the guard is not vacuous.
    const report = uncovered([...eligibleWithEvidence, verifierless]);
    expect(report).toContain('thirdparty:verifierless_eligible:verified_unwired_class_not_in_any_set');
  });
});
