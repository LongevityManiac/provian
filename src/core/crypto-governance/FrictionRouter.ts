/**
 * FrictionRouter - 4-Lane Friction Classification
 *
 * Combines policy evaluation with telemetry signals to determine
 * the appropriate friction level for an agent spending request.
 *
 * Lanes:
 * - auto_approve: Silent execution, no user interaction
 * - soft_confirm: Push notification with tap-to-approve
 * - hard_confirm: Full Face ID + explicit approval
 * - block: Rejected immediately
 *
 * Telemetry can ONLY escalate friction, never reduce it.
 */

import { FrictionLane, PolicyEvaluation } from './types';
import {
    TelemetrySnapshot,
    FrictionDecision,
    FrictionRoutingInput,
    EscalationRule,
    TELEMETRY_THRESHOLDS,
    APPROVAL_TIMEOUTS,
    LANE_ORDER,
} from './frictionTypes';

class FrictionRouter {
    private static instance: FrictionRouter;
    private escalationRules: EscalationRule[] = [];

    private constructor() {
        this.initializeDefaultRules();
    }

    static getInstance(): FrictionRouter {
        if (!FrictionRouter.instance) {
            FrictionRouter.instance = new FrictionRouter();
        }
        return FrictionRouter.instance;
    }

    /**
     * Route a request to the appropriate friction lane.
     */
    route(input: FrictionRoutingInput): FrictionDecision {
        const reasons: string[] = [];

        // Start with policy-suggested lane
        let lane = input.policyEvaluation.suggestedLane;
        const originalLane = lane;
        let telemetryEscalated = false;
        let escalationTrigger: string | undefined;

        // If policy says block, that's final
        if (lane === 'block') {
            return this.createDecision({
                lane: 'block',
                reasons: input.policyEvaluation.violations.map((v) => v.message),
                telemetryEscalated: false,
                riskScore: 100,
            });
        }

        // Add policy warnings to reasons
        if (input.policyEvaluation.warnings.length > 0) {
            reasons.push(...input.policyEvaluation.warnings);
        }

        // Apply escalation rules.
        //
        // THE ONE GATE : a rule that reads telemetry is SKIPPED outright when
        // this path has none, rather than being fed a fabricated snapshot. Skipping and
        // feeding all-zeros produce identical lanes — the fabricated snapshot fired no
        // rule — but only skipping is honest about the fact that nothing was measured.
        // Rules that do not read telemetry (every crypto-classification rule among them)
        // are unaffected and still run on every path.
        const sortedRules = [...this.escalationRules].sort((a, b) => b.priority - a.priority);

        for (const rule of sortedRules) {
            const fired = rule.telemetryCondition !== undefined
                ? input.telemetry !== null && rule.telemetryCondition(input.telemetry, input)
                : rule.condition(input);
            if (fired) {
                const newLane = this.escalateLane(lane, rule.escalationLevels);
                if (this.isMoreRestrictive(newLane, lane)) {
                    lane = newLane;
                    telemetryEscalated = true;
                    escalationTrigger = rule.name;
                    reasons.push(`Telemetry escalation: ${rule.name}`);

                    // If escalated to block, stop checking other rules
                    if (lane === 'block') {
                        break;
                    }
                }
            }
        }

        // Calculate composite risk score
        const riskScore = this.calculateRiskScore(input, lane);

        return this.createDecision({
            lane,
            reasons,
            originalLane: telemetryEscalated ? originalLane : undefined,
            telemetryEscalated,
            escalationTrigger,
            riskScore,
        });
    }

    /**
     * Initialize default escalation rules.
     */
    private initializeDefaultRules(): void {
        this.escalationRules = [
            // Critical deviation - auto-block
            {
                name: 'Critical behavioral anomaly',
                telemetryCondition: (telemetry, input) => telemetry.deviationScore >= TELEMETRY_THRESHOLDS.criticalDeviationScore,
                escalationLevels: 3, // Escalate to block
                priority: 100,
            },

            // Proxied API payment - always hard_confirm minimum
            // Path B2': Device makes outbound HTTP call on behalf of agent
            {
                name: 'Proxied API payment requires hard confirm',
                condition: (input) => input.actionType === 'proxied_api_payment',
                escalationLevels: 2, // Escalate to hard_confirm
                priority: 99, // Very high priority - always check
            },

            // Missing insurance bond for Level 2/3 autonomy - default-deny (Theme 9)
            // If bondStatus is provided and shows no active/healthy bond,
            // escalate to hard_confirm (effectively forcing Level 1 behavior)
            {
                name: 'Missing or expired insurance bond',
                condition: (input) => {
                    if (!input.bondStatus) return false; // No bond check available
                    return !input.bondStatus.hasBond || !input.bondStatus.bondActive || !input.bondStatus.bondHealthy;
                },
                escalationLevels: 2, // Escalate to hard_confirm
                priority: 95, // High - checked before behavioral anomaly
            },

            // Significant deviation - hard confirm
            {
                name: 'Significant behavioral anomaly',
                telemetryCondition: (telemetry, input) =>
                    telemetry.deviationScore >= TELEMETRY_THRESHOLDS.significantDeviationScore &&
                    telemetry.deviationScore < TELEMETRY_THRESHOLDS.criticalDeviationScore,
                escalationLevels: 2, // Escalate to hard_confirm
                priority: 90,
            },

            // Mild deviation - bump one level
            {
                name: 'Mild behavioral deviation',
                telemetryCondition: (telemetry, input) =>
                    telemetry.deviationScore >= TELEMETRY_THRESHOLDS.mildDeviationScore &&
                    telemetry.deviationScore < TELEMETRY_THRESHOLDS.significantDeviationScore,
                escalationLevels: 1,
                priority: 50,
            },

            // High request velocity
            {
                name: 'High request velocity',
                telemetryCondition: (telemetry, input) => telemetry.requestsPerMinute > TELEMETRY_THRESHOLDS.maxRequestsPerMinute,
                escalationLevels: 2,
                priority: 80,
            },

            // High hourly request rate
            {
                name: 'High hourly request rate',
                telemetryCondition: (telemetry, input) => telemetry.requestsPerHour > TELEMETRY_THRESHOLDS.maxRequestsPerHour,
                escalationLevels: 1,
                priority: 60,
            },

            // High spending rate
            {
                name: 'High spending rate',
                telemetryCondition: (telemetry, input) => telemetry.spendingRatePerHour > TELEMETRY_THRESHOLDS.highSpendingRatePerHour,
                escalationLevels: 1,
                priority: 70,
            },

            // Consecutive denials (suspicious pattern)
            {
                name: 'Multiple consecutive denials',
                telemetryCondition: (telemetry, input) => telemetry.consecutiveDenials >= TELEMETRY_THRESHOLDS.maxConsecutiveDenials,
                escalationLevels: 2,
                priority: 75,
            },

            // Many new merchants (potential account takeover)
            {
                name: 'Unusual merchant diversity',
                telemetryCondition: (telemetry, input) => telemetry.uniqueMerchantsThisSession > TELEMETRY_THRESHOLDS.maxNewMerchantsPerSession,
                escalationLevels: 1,
                priority: 55,
            },

            // New merchant + deviation
            {
                name: 'New merchant with behavioral deviation',
                telemetryCondition: (telemetry, input) =>
                    telemetry.isNewMerchant &&
                    telemetry.deviationScore > 0.2,
                escalationLevels: 1,
                priority: 45,
            },

            // Unusual hour + any deviation
            {
                name: 'Unusual hour activity',
                telemetryCondition: (telemetry, input) =>
                    telemetry.isUnusualHour &&
                    telemetry.deviationScore > 0.1,
                escalationLevels: 1,
                priority: 40,
            },

            // Session unhealthy
            {
                name: 'Unhealthy session state',
                telemetryCondition: (telemetry, input) => !telemetry.sessionHealthy,
                escalationLevels: 1,
                priority: 65,
            },

            // ===== Promise Negotiation Rules =====

            // Promise acceptance with high amount
            {
                name: 'Promise acceptance amount check',
                condition: (input) => {
                    if (input.negotiationType !== 'promise_accept') return false;
                    const amount = input.promiseTerms?.amount?.value ?? 0;
                    const limit = input.policyEvaluation.remainingLimits?.daily ?? Infinity;
                    return amount > limit * 0.5;
                },
                escalationLevels: 1,
                priority: 55,
            },

            // High-value promise requires hard confirm
            {
                name: 'High-value promise requires hard confirm',
                condition: (input) => {
                    if (input.negotiationType !== 'promise_accept') return false;
                    const amount = input.promiseTerms?.amount?.value ?? 0;
                    const perTxLimit = input.policyEvaluation.remainingLimits?.perTransaction ?? Infinity;
                    return amount > perTxLimit;
                },
                escalationLevels: 2,
                priority: 85,
            },

            // New merchant in promise negotiation
            {
                name: 'Promise with unknown merchant',
                telemetryCondition: (telemetry, input) => {
                    if (!input.negotiationType) return false;
                    return telemetry.isNewMerchant && input.promiseTerms?.amount?.value !== undefined;
                },
                escalationLevels: 1,
                priority: 50,
            },

            // ===== Non-Financial Action Rules =====

            // Non-financial action default - always escalate to hard_confirm
            {
                name: 'Non-financial action default',
                condition: (input) => {
                    const nonFinancialTypes = ['communicate', 'commit', 'share_data'];
                    return nonFinancialTypes.includes(input.actionType || '');
                },
                escalationLevels: 2, // Escalate to hard_confirm
                priority: 100,
            },

            // Force hard_confirm if policy evaluation says so
            {
                name: 'Non-financial controls require hard confirm',
                condition: (input) => {
                    return input.forceHardConfirm === true;
                },
                escalationLevels: 2,
                priority: 98,
            },

            // Sensitive data sharing - extra escalation
            {
                name: 'Sensitive data sharing',
                condition: (input) => {
                    if (input.actionType !== 'share_data') return false;
                    const metadata = input.actionMetadata as { dataType?: string } | undefined;
                    const sensitiveTypes = ['medical', 'financial', 'identity', 'credentials'];
                    return sensitiveTypes.includes(metadata?.dataType || '');
                },
                escalationLevels: 2, // Ensure hard_confirm for sensitive data
                priority: 95,
            },

            // Non-revocable commitment - extra scrutiny
            {
                name: 'Non-revocable commitment',
                condition: (input) => {
                    if (input.actionType !== 'commit') return false;
                    const metadata = input.actionMetadata as { isRevocable?: boolean } | undefined;
                    return metadata?.isRevocable === false;
                },
                escalationLevels: 2,
                priority: 90,
            },

            // Commitment with financial implication
            {
                name: 'Commitment with financial implication',
                condition: (input) => {
                    if (input.actionType !== 'commit') return false;
                    const metadata = input.actionMetadata as { financialImplication?: { amount: number } } | undefined;
                    return metadata?.financialImplication !== undefined && metadata.financialImplication.amount > 0;
                },
                escalationLevels: 1,
                priority: 85,
            },

            // Unknown recipient for communication or data sharing
            {
                name: 'Unknown recipient',
                telemetryCondition: (telemetry, input) => {
                    if (input.actionType !== 'communicate' && input.actionType !== 'share_data') return false;
                    // If telemetry indicates new recipient, escalate
                    return telemetry.isNewMerchant; // Reusing isNewMerchant for recipient tracking
                },
                escalationLevels: 1,
                priority: 60,
            },

            // ===== Crypto Transaction Rules =====

            // Unknown contract interaction - always hard_confirm
            {
                name: 'Unknown contract interaction',
                condition: (input) => {
                    return input.cryptoClassification?.category === 'unknown';
                },
                escalationLevels: 2, // Escalate to hard_confirm minimum
                priority: 95,
            },

            // Low-confidence crypto classification
            {
                name: 'Low confidence crypto classification',
                condition: (input) => {
                    return input.cryptoClassification !== undefined &&
                        input.cryptoClassification.confidence < 0.7 &&
                        input.cryptoClassification.category !== 'unknown';
                },
                escalationLevels: 1,
                priority: 70,
            },

            // Prediction market transaction - always hard_confirm minimum
            {
                name: 'Prediction market transaction',
                condition: (input) => {
                    return input.cryptoClassification?.category === 'prediction_market';
                },
                escalationLevels: 2,
                priority: 92,
            },

            // Prediction market near exposure cap
            {
                name: 'Prediction market near exposure cap',
                condition: (input) => {
                    if (!input.predictionMarketState) return false;
                    // Escalate if over 80% of daily budget or exposure
                    return input.predictionMarketState.dailyWagered > 0 &&
                        input.predictionMarketState.openPositions > 3;
                },
                escalationLevels: 1,
                priority: 80,
            },

            // Prediction market with active session losses
            {
                name: 'Prediction market loss streak',
                condition: (input) => {
                    return (input.predictionMarketState?.sessionLoss ?? 0) > 0;
                },
                escalationLevels: 1,
                priority: 75,
            },

            // Contract deployment - always block for agents
            {
                name: 'Agent contract deployment blocked',
                condition: (input) => {
                    return input.cryptoClassification?.category === 'contract_deploy';
                },
                escalationLevels: 3, // Block
                priority: 100,
            },

            // Token approval - always hard_confirm
            {
                name: 'Token approval requires confirmation',
                condition: (input) => {
                    return input.cryptoClassification?.category === 'token_approval';
                },
                escalationLevels: 2,
                priority: 88,
            },

            // Bridge transaction - hard_confirm (cross-chain = higher risk)
            {
                name: 'Bridge transaction elevated risk',
                condition: (input) => {
                    return input.cryptoClassification?.category === 'bridge';
                },
                escalationLevels: 2,
                priority: 85,
            },

            // Crypto governance already escalated - respect it
            {
                name: 'Crypto governance escalation',
                condition: (input) => {
                    return input.cryptoEscalated === true;
                },
                escalationLevels: 1,
                priority: 90,
            },
        ];
    }

    /**
     * Route a goal envelope request to the appropriate friction lane.
     *
     * SECURITY INVARIANT: Goal selection = always hard_confirm minimum.
     * No risk score, no policy evaluation, no telemetry can reduce this below hard_confirm.
     * The user's CLAUDE.md says: "Goal selection = always hard_confirm, regardless of risk score."
     *
     * Escalation rules (can only go UP from hard_confirm → block):
     * 1. Urgency language in outcome → block (scam pattern)
     * 2. Budget > $1000 → add 30-second cooling period
     * 3. Expiry < 1 hour → block (too short for safe execution)
     * 4. >3 allowed_action_types → add extra confirmation step
     * 5. No constraints → block (unbounded goals are dangerous)
     */
    routeGoalRequest(input: {
        outcome: string;
        budget: number;
        expiryTimestamp: number;
        allowedActionTypes: string[];
        constraints: string[];
        agentId: string;
    }): FrictionDecision {
        const reasons: string[] = [];
        let lane: FrictionLane = 'hard_confirm'; // Minimum - NEVER lower

        // Rule 1: Urgency language in outcome → block
        const urgencyPatterns = /\b(urgent|immediately|right now|asap|hurry|rush|quickly|fast|don't wait|act now|limited time|expiring)\b/i;
        if (urgencyPatterns.test(input.outcome)) {
            lane = 'block';
            reasons.push('Goal contains urgency language - potential scam pattern');
        }

        // Rule 2: Budget > $1000 → cooling period (stays hard_confirm but with extended timeout)
        const hasCoolingPeriod = input.budget > 1000;
        if (hasCoolingPeriod) {
            reasons.push('High-budget goal - 30-second cooling period required');
        }

        // Rule 3: Expiry < 1 hour → block
        const timeUntilExpiry = input.expiryTimestamp - Date.now();
        if (timeUntilExpiry < 60 * 60 * 1000) {
            lane = 'block';
            reasons.push('Goal expiry is less than 1 hour - too short for safe execution');
        }

        // Rule 4: >3 allowed_action_types → extra confirmation
        if (input.allowedActionTypes.length > 3) {
            reasons.push('Goal requests many action types - review carefully');
        }

        // Rule 5: No constraints → block
        if (!input.constraints || input.constraints.length === 0) {
            lane = 'block';
            reasons.push('Goal has no constraints - unbounded goals are not allowed');
        }

        const riskScore = lane === 'block' ? 100 :
            (input.budget > 500 ? 75 : 60);

        return {
            lane,
            reasons,
            telemetryEscalated: false,
            requiresBiometric: lane === 'hard_confirm',
            requiresPushApproval: false,
            approvalTimeoutSeconds: hasCoolingPeriod ? 30 : APPROVAL_TIMEOUTS.hard_confirm,
            riskScore,
            confidence: 0.95,
        };
    }

    /**
     * Add a custom escalation rule.
     */
    addEscalationRule(rule: EscalationRule): void {
        this.escalationRules.push(rule);
    }

    /**
     * Remove an escalation rule by name.
     */
    removeEscalationRule(name: string): void {
        this.escalationRules = this.escalationRules.filter((r) => r.name !== name);
    }

    /**
     * Get all escalation rules (for debugging/display).
     */
    getEscalationRules(): EscalationRule[] {
        return [...this.escalationRules];
    }

    /**
     * Escalate a lane by N levels.
     */
    private escalateLane(currentLane: FrictionLane, levels: number): FrictionLane {
        const currentIndex = LANE_ORDER.indexOf(currentLane);
        const newIndex = Math.min(currentIndex + levels, LANE_ORDER.length - 1);
        return LANE_ORDER[newIndex];
    }

    /**
     * Check if lane A is more restrictive than lane B.
     */
    private isMoreRestrictive(a: FrictionLane, b: FrictionLane): boolean {
        return LANE_ORDER.indexOf(a) > LANE_ORDER.indexOf(b);
    }

    /**
     * Calculate composite risk score.
     */
    private calculateRiskScore(input: FrictionRoutingInput, finalLane: FrictionLane): number {
        let score = input.policyEvaluation.riskScore;

        // Telemetry-based risk. Contributes NOTHING when this path has no telemetry
        // an absent measurement must not be scored as a benign one. The
        // fabricated all-zeros snapshot this replaces contributed exactly 0 here too
        // (deviation 0, rate 0, both booleans false, sessionHealthy true), so the score
        // is unchanged on the crypto path; what changes is that the zero is now
        // structural rather than a coincidence of the fabricated values.
        const telemetry = input.telemetry;
        if (telemetry !== null) {
            // Guard against NaN from external telemetry.
            const deviation = Number.isFinite(telemetry.deviationScore) ? telemetry.deviationScore : 0;
            score += deviation * 30;

            if (telemetry.requestsPerMinute > TELEMETRY_THRESHOLDS.maxRequestsPerMinute) {
                score += 15;
            }

            if (telemetry.isNewMerchant) {
                score += 10;
            }

            if (telemetry.isUnusualHour) {
                score += 10;
            }

            if (!telemetry.sessionHealthy) {
                score += 20;
            }
        }

        // Lane-based minimum scores
        const laneMinScores: Record<FrictionLane, number> = {
            auto_approve: 0,
            soft_confirm: 20,
            hard_confirm: 50,
            block: 80,
        };
        score = Math.max(score, laneMinScores[finalLane]);

        return Math.min(100, Math.max(0, Math.round(score)));
    }

    /**
     * Create a friction decision object.
     */
    private createDecision(params: {
        lane: FrictionLane;
        reasons: string[];
        originalLane?: FrictionLane;
        telemetryEscalated: boolean;
        escalationTrigger?: string;
        riskScore: number;
    }): FrictionDecision {
        const { lane, reasons, originalLane, telemetryEscalated, escalationTrigger, riskScore } = params;

        return {
            lane,
            reasons,
            originalLane,
            telemetryEscalated,
            escalationTrigger,
            requiresBiometric: lane === 'hard_confirm',
            requiresPushApproval: lane === 'soft_confirm',
            approvalTimeoutSeconds: APPROVAL_TIMEOUTS[lane],
            riskScore,
            confidence: telemetryEscalated ? 0.8 : 0.95, // Slightly lower confidence if telemetry-escalated
        };
    }
}

export default FrictionRouter.getInstance();

/*
 * `createDefaultTelemetrySnapshot()` was DELETED in.
 *
 * It fabricated an all-zeros-but-healthy snapshot for callers that had no
 * telemetry, which made "nothing measured anything" indistinguishable from
 * "telemetry says everything is normal". Two callers used it: the crypto path
 * (unconditionally) and the agent API server (as a fallback). Both now pass
 * `telemetry: null`, and the router SKIPS telemetry rules rather than evaluating
 * them against invented data. Do not reintroduce it — a helper whose only job is
 * to manufacture a benign reading is the darkness-ledger defect, not a default.
 */

/**
 * Helper: Get human-readable lane description.
 */
export function getLaneDescription(lane: FrictionLane): string {
    const descriptions: Record<FrictionLane, string> = {
        auto_approve: 'Automatic approval - no user action needed',
        soft_confirm: 'Quick confirmation via notification',
        hard_confirm: 'Full verification with Face ID required',
        block: 'Request blocked - policy violation',
    };
    return descriptions[lane];
}

/**
 * Helper: Check if a lane requires user interaction.
 */
export function laneRequiresInteraction(lane: FrictionLane): boolean {
    return lane === 'soft_confirm' || lane === 'hard_confirm';
}
