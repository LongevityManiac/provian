/**
 * deleting the crypto path's fabricated telemetry must change NO decision.
 *
 * The crypto path used to pass `createDefaultTelemetrySnapshot()` all zeros, both
 * booleans false, `sessionHealthy: true`. That snapshot could not fire a single
 * telemetry rule and contributed exactly 0 to the risk score — so it was a control
 * in appearance only, while the architecture description implied telemetry-based
 * escalation applied on that path. It does not, and now the code says so: the path
 * passes `telemetry: null` and the router SKIPS telemetry rules.
 *
 * This suite is the equivalence proof. Deleting a governance input is only safe if
 * it provably decided nothing, and "provably" here means executed, not argued:
 * every lane and risk score must be identical between the deleted snapshot and
 * `null`. `INERT` below reconstructs the exact snapshot that was deleted — kept
 * local to this test on purpose, so the production helper stays gone and cannot be
 * reintroduced by a caller reaching for it.
 *
 * It also pins the half that MUST still work: telemetry rules fire normally when a
 * real snapshot is supplied (the stored-card path), because a change that silenced
 * them everywhere would pass an equivalence test and still be a serious regression.
 */

import { describe, it, expect } from 'vitest';

import FrictionRouter from '../FrictionRouter';
import { TELEMETRY_THRESHOLDS } from '../frictionTypes';
import type { FrictionRoutingInput, TelemetrySnapshot } from '../frictionTypes';
import type { PolicyEvaluation } from '../types';

/** The exact snapshot deleted. Reconstructed here, and only here. */
const INERT: TelemetrySnapshot = {
    requestsPerMinute: 0,
    requestsPerHour: 0,
    spendingRatePerHour: 0,
    deviationScore: 0,
    sessionDurationMinutes: 0,
    consecutiveApprovals: 0,
    consecutiveDenials: 0,
    uniqueMerchantsThisSession: 0,
    isNewMerchant: false,
    isUnusualHour: false,
    sessionHealthy: true,
};

function policy(suggestedLane: PolicyEvaluation['suggestedLane'], riskScore = 10): PolicyEvaluation {
    return {
        allowed: true,
        suggestedLane,
        violations: [],
        warnings: [],
        riskScore,
    } as unknown as PolicyEvaluation;
}

function input(
    telemetry: TelemetrySnapshot | null,
    over: Partial<FrictionRoutingInput> = {},
): FrictionRoutingInput {
    return {
        policyEvaluation: policy('soft_confirm'),
        telemetry,
        amount: 25,
        currency: 'USD',
        agentId: 'agent-1',
        merchant: 'example.com',
        ...over,
    } as FrictionRoutingInput;
}

describe('telemetry: null is decision-identical to the deleted inert snapshot', () => {
    const lanes = ['auto_approve', 'soft_confirm', 'hard_confirm'] as const;

    // NOTE ON WHICH CASE ACTUALLY DETECTS A DIVERGENCE. `calculateRiskScore` clamps
    // to a lane minimum (soft_confirm 20, hard_confirm 50), so a small spurious
    // contribution is MASKED at those lanes and only `auto_approve` (minimum 0) can
    // see it. Verified by injecting `score += 7` for the null branch: exactly the
    // auto_approve case went red, the other two stayed green. They are still worth
    // running — they pin lane preservation — but auto_approve is the one carrying the
    // score-equivalence claim, and saying so beats implying three independent checks.
    it.each(lanes)('lane %s: same lane and same risk score with null as with the inert snapshot', (lane) => {
        const withInert = FrictionRouter.route(input(INERT, { policyEvaluation: policy(lane) }));
        const withNull = FrictionRouter.route(input(null, { policyEvaluation: policy(lane) }));

        expect(withNull.lane).toBe(withInert.lane);
        expect(withNull.riskScore).toBe(withInert.riskScore);
        expect(withNull.telemetryEscalated).toBe(withInert.telemetryEscalated);
    });

    it('auto_approve is UNCLAMPED, so the score comparison there is a real test', () => {
        // Guards the note above: if lane minimums ever changed such that auto_approve
        // were also clamped, the equivalence claim would quietly stop being testable.
        const decision = FrictionRouter.route(input(null, { policyEvaluation: policy('auto_approve', 3) }));
        expect(decision.lane).toBe('auto_approve');
        // A policy risk score of 3 survives intact — nothing floors it up to a minimum.
        expect(decision.riskScore).toBe(3);
    });

    it('the crypto-classification rules still fire with NO telemetry', () => {
        // The rules that actually decide the crypto path read cryptoClassification /
        // cryptoEscalated, never telemetry — so removing telemetry must leave them
        // working. Without this, the equivalence test above would be satisfied by a
        // router that had stopped escalating altogether.
        const escalated = FrictionRouter.route(input(null, {
            policyEvaluation: policy('auto_approve'),
            cryptoEscalated: true,
        } as Partial<FrictionRoutingInput>));
        const plain = FrictionRouter.route(input(null, {
            policyEvaluation: policy('auto_approve'),
        }));
        // Same input but for the crypto signal: the signal must still move the lane.
        expect(escalated.lane === plain.lane && escalated.riskScore === plain.riskScore).toBe(false);
    });

    // ── RED: telemetry still WORKS when it is genuinely present ───────────────
    it('RED — a real critical deviation still escalates to block when telemetry IS supplied', () => {
        const hot: TelemetrySnapshot = {
            ...INERT,
            deviationScore: TELEMETRY_THRESHOLDS.criticalDeviationScore,
        };
        const decision = FrictionRouter.route(input(hot, { policyEvaluation: policy('auto_approve') }));
        expect(decision.lane).toBe('block');
        expect(decision.telemetryEscalated).toBe(true);
    });

    it('RED — the SAME critical deviation is inert when telemetry is null (skipped, not scored)', () => {
        // The other half of the previous assertion: absence must not escalate either.
        // A router that escalated on null would be "failing closed" in a way that
        // silently hard-confirms every crypto transaction.
        const decision = FrictionRouter.route(input(null, { policyEvaluation: policy('auto_approve') }));
        expect(decision.lane).toBe('auto_approve');
        expect(decision.telemetryEscalated).toBe(false);
    });

    it('RED — a real high request velocity still escalates when telemetry IS supplied', () => {
        // A second, independent telemetry rule, so the pair above is not evidence
        // about one lucky rule.
        const fast: TelemetrySnapshot = {
            ...INERT,
            requestsPerMinute: TELEMETRY_THRESHOLDS.maxRequestsPerMinute + 1,
        };
        const decision = FrictionRouter.route(input(fast, { policyEvaluation: policy('auto_approve') }));
        expect(decision.telemetryEscalated).toBe(true);
        expect(decision.riskScore).toBeGreaterThan(
            FrictionRouter.route(input(null, { policyEvaluation: policy('auto_approve') })).riskScore,
        );
    });
});
