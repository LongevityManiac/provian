/**
 * Friction Router Types
 *
 * Types for the friction routing system that classifies agent
 * spending requests into one of four lanes based on policy
 * evaluation and telemetry signals.
 */

import { FrictionLane, PolicyEvaluation } from './types';

/**
 * Telemetry snapshot at time of request.
 */
export interface TelemetrySnapshot {
    /** Requests per minute from this agent */
    requestsPerMinute: number;

    /** Requests per hour from this agent */
    requestsPerHour: number;

    /** Spending rate in USD per hour */
    spendingRatePerHour: number;

    /** Behavioral deviation score (0-1) */
    deviationScore: number;

    /** Session duration in minutes */
    sessionDurationMinutes: number;

    /** Consecutive successful approvals */
    consecutiveApprovals: number;

    /** Consecutive denials */
    consecutiveDenials: number;

    /** Unique merchants contacted this session */
    uniqueMerchantsThisSession: number;

    /** Time since last transaction (seconds) */
    timeSinceLastTransaction?: number;

    /** Is this a new merchant (not in baseline)? */
    isNewMerchant: boolean;

    /** Is this an unusual hour for this agent? */
    isUnusualHour: boolean;

    /** Is the agent's session healthy? */
    sessionHealthy: boolean;
}

/**
 * Friction decision output.
 */
export interface FrictionDecision {
    /** Final friction lane */
    lane: FrictionLane;

    /** Human-readable reasons for this decision */
    reasons: string[];

    /** Original lane before telemetry escalation (if escalated) */
    originalLane?: FrictionLane;

    /** Whether telemetry forced an escalation */
    telemetryEscalated: boolean;

    /** Specific telemetry flag that caused escalation */
    escalationTrigger?: string;

    /** Whether biometric authentication is required */
    requiresBiometric: boolean;

    /** Whether push notification approval is sufficient */
    requiresPushApproval: boolean;

    /** Timeout for approval (seconds) - auto-deny if exceeded */
    approvalTimeoutSeconds: number;

    /** Risk score (0-100) */
    riskScore: number;

    /** Confidence in this decision (0-1) */
    confidence: number;
}

/**
 * Friction routing input.
 */
export interface FrictionRoutingInput {
    /** Policy evaluation result */
    policyEvaluation: PolicyEvaluation;

    /**
     * Telemetry snapshot, or `null` when this path HAS no telemetry.
     *
     * The two must not be spelled the same way. The crypto path used to pass a
     * fabricated all-zeros-but-healthy snapshot, which reads as "telemetry says
     * everything is normal" when the truth is "nothing measured anything". Every
     * telemetry rule was therefore structurally unable to fire there while the
     * architecture description implied it could (the darkness finding).
     *
     * `null` means the rules that read telemetry are SKIPPED, not fed zeros, and
     * telemetry contributes nothing to the risk score. Decisions are identical
     * either way — the fabricated snapshot fired no rule and added no points —
     * so this removes a false control without changing a single lane.
     */
    telemetry: TelemetrySnapshot | null;

    /** Transaction amount */
    amount: number;

    /** Transaction currency */
    currency: string;

    /** Agent ID */
    agentId: string;

    /** Merchant name */
    merchant: string;

    // Promise negotiation context (optional)
    /** Type of negotiation action if this is a promise-related request */
    negotiationType?: 'promise_offer' | 'promise_accept' | 'promise_counter';

    /** Negotiation thread ID for tracking related offers/counters */
    negotiationThreadId?: string;

    /** Promise terms for amount-based friction decisions */
    promiseTerms?: {
        amount?: { value: number; currency: string; maxValue?: number };
        merchant?: { name: string; category?: string };
        conditions?: string[];
        expiresAt?: number;
    };

    // Non-financial action context (optional)
    /** Action type for non-financial action routing */
    actionType?: 'communicate' | 'commit' | 'share_data' | string;

    /** Action metadata (typed based on actionType) */
    actionMetadata?: Record<string, unknown>;

    /** Whether non-financial action controls force hard_confirm */
    forceHardConfirm?: boolean;

    // Crypto transaction context (optional)
    /** Crypto transaction classification result */
    cryptoClassification?: import('./CryptoTransactionClassifier').CryptoClassification;

    /** Whether crypto governance escalated the friction */
    cryptoEscalated?: boolean;

    /** Prediction market state snapshot (if applicable) */
    predictionMarketState?: {
        dailyWagered: number;
        openPositions: number;
        currentExposure: number;
        sessionLoss: number;
        cooldownActive: boolean;
    };

    /** Insurance bond status for autonomy-gated operations */
    bondStatus?: {
        hasBond: boolean;
        bondActive: boolean;
        bondHealthy: boolean;
    };
}

/**
 * Friction escalation rules.
 */
interface EscalationRuleBase {
    /** Rule name */
    name: string;

    /** How many lanes to escalate (1 = one level up) */
    escalationLevels: number;

    /** Priority (higher = checked first) */
    priority: number;
}

/**
 * A rule is EITHER telemetry-reading or it is not, and it says which.
 *
 * A discriminated union rather than a boolean flag, deliberately: a rule that
 * reads telemetry can only express itself through `telemetryCondition`, whose
 * snapshot argument is non-nullable, so the router is forced to have already
 * checked for absence before the body runs. A flag would let a rename or a
 * copy-paste produce a telemetry-reading rule that forgot to declare itself and
 * then dereferenced null at runtime on the crypto path.
 */
export type EscalationRule =
    | (EscalationRuleBase & {
        /** Condition over inputs OTHER than telemetry. Always evaluated. */
        condition: (input: FrictionRoutingInput) => boolean;
        telemetryCondition?: never;
    })
    | (EscalationRuleBase & {
        /**
         * Condition that READS telemetry. SKIPPED entirely when `input.telemetry`
         * is null — an absent measurement never escalates and never de-escalates.
         */
        telemetryCondition: (
            telemetry: TelemetrySnapshot,
            input: FrictionRoutingInput,
        ) => boolean;
        condition?: never;
    });

/**
 * Default telemetry thresholds.
 */
export const TELEMETRY_THRESHOLDS = {
    /** Deviation score above which to escalate one level */
    mildDeviationScore: 0.3,

    /** Deviation score above which to escalate to hard_confirm */
    significantDeviationScore: 0.6,

    /** Deviation score above which to auto-block and trigger emergency */
    criticalDeviationScore: 0.8,

    /** Max requests per minute before escalation */
    maxRequestsPerMinute: 5,

    /** Max requests per hour before escalation */
    maxRequestsPerHour: 30,

    /** Max consecutive denials before block */
    maxConsecutiveDenials: 5,

    /** Spending rate (USD/hour) that triggers escalation */
    highSpendingRatePerHour: 500,

    /** Number of new merchants in session that triggers escalation */
    maxNewMerchantsPerSession: 10,
};

/**
 * Approval timeout defaults by lane.
 */
export const APPROVAL_TIMEOUTS: Record<FrictionLane, number> = {
    auto_approve: 0,      // No approval needed
    soft_confirm: 300,    // 5 minutes
    hard_confirm: 180,    // 3 minutes
    block: 0,             // No approval possible
};

/**
 * Lane ordering for escalation.
 */
export const LANE_ORDER: FrictionLane[] = ['auto_approve', 'soft_confirm', 'hard_confirm', 'block'];
