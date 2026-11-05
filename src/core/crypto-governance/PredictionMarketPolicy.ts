/**
 * PredictionMarketPolicy - Prediction Market Governance Module
 *
 * Specialized policy layer for agent interactions with prediction markets
 * (Polymarket, Augur, etc.). This is NOT a separate system - it's an
 * extension of the crypto spending governance pipeline. When the
 * CryptoTransactionClassifier identifies a prediction market transaction,
 * this module activates as an additional policy filter.
 *
 * ARCHITECTURE:
 *   Agent request
 *     → CryptoSpendingGovernance (general crypto policy)
 *       → CryptoTransactionClassifier (identifies prediction market)
 *         → PredictionMarketPolicy (this module - specialized rules)
 *           → FrictionRouter (friction lane assignment)
 *             → Signing (Secure Enclave)
 *
 * DESIGN PRINCIPLE: "We don't block prediction markets. We make them safe
 * for agents to use with human oversight."
 *
 * DEPENDENCY: Requires crypto spending governance (canSpendCrypto: true)
 * to be enabled. This module cannot function without the signing path
 * being governed first.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { FrictionLane, PolicyViolation } from './types';
import { getItemHmac, setItemHmac } from '../security/hmacAsyncStorage';

// ============================================================================
// PREDICTION MARKET POLICY TYPES
// ============================================================================

/**
 * Complete prediction market policy configuration.
 * These 10 fields represent the full governance surface for agent betting.
 */
export interface PredictionMarketPolicyConfig {
    /**
     * Master toggle. Defaults to false.
     * Agent cannot interact with prediction market contracts unless explicitly enabled.
     */
    predictionMarketsEnabled: boolean;

    /**
     * Maximum single position size (USD).
     * Agent cannot place a bet larger than this regardless of confidence.
     */
    maxBetSize: number;

    /**
     * Maximum cumulative amount wagered in a 24-hour period (USD).
     * Resets at midnight UTC.
     */
    dailyBettingBudget: number;

    /**
     * Maximum number of concurrent open bets.
     * Prevents agents from spreading risk across dozens of markets simultaneously.
     */
    maxOpenPositions: number;

    /**
     * Maximum total capital at risk across all open positions (USD).
     * This is the hard ceiling on potential loss.
     */
    maxExposure: number;

    /**
     * Allowlist of prediction market contract addresses the agent can interact with.
     * Start with Polymarket's verified contracts only.
     * Empty array = all known prediction market contracts allowed.
     */
    approvedPlatforms: string[];

    /**
     * Categories the agent cannot bet on.
     * Mapped from market metadata/tags.
     * Examples: "politics", "violence", "death"
     */
    categoryBlacklist: string[];

    /**
     * Any bet above this amount requires explicit human approval via push notification.
     * Below this amount, auto-approve within budget.
     */
    requireApprovalAbove: number;

    /**
     * Cooldown circuit breaker.
     * If cumulative losses exceed threshold within a session, pause all betting
     * for pauseMinutes. Prevents tilt/chasing behavior.
     */
    cooldownAfterLoss: {
        /** Loss threshold in USD that triggers the cooldown */
        threshold: number;
        /** Minutes to pause betting after threshold is hit */
        pauseMinutes: number;
    };

    /**
     * Profit-take trigger.
     * When cumulative profit hits target, execute the specified action.
     *
     * Phase 2.21: dropped 'withdraw' from the action union - there was
     * never a code path that implemented "pull funds" and the dead case
     * meant a config could specify it and silently do nothing. The two
     * remaining actions:
     *   - 'notify' records the trigger in state but otherwise lets
     *     betting continue (the human is expected to react).
     *   - 'pause' raises a `limit_exceeded` violation that blocks the
     *     next bet attempt until the human re-enables.
     */
    profitTakeAction: {
        /** Profit target in USD */
        target: number;
        action: 'notify' | 'pause';
    };
}

/**
 * Default prediction market policy - conservative.
 */
export const DEFAULT_PREDICTION_MARKET_POLICY: PredictionMarketPolicyConfig = {
    predictionMarketsEnabled: false,
    maxBetSize: 25,
    dailyBettingBudget: 100,
    maxOpenPositions: 5,
    maxExposure: 500,
    approvedPlatforms: [], // Empty = all known platforms allowed
    categoryBlacklist: ['violence', 'death'],
    requireApprovalAbove: 50,
    cooldownAfterLoss: {
        threshold: 100,
        pauseMinutes: 60,
    },
    profitTakeAction: {
        target: 200,
        action: 'notify',
    },
};

// ============================================================================
// PREDICTION MARKET STATE TRACKING
// ============================================================================

/**
 * Tracks an agent's prediction market activity for policy enforcement.
 */
export interface PredictionMarketState {
    /** Agent ID */
    agentId: string;

    /** Amount wagered today (USD). Resets at midnight UTC. */
    dailyWagered: number;

    /** Date key for daily reset (YYYY-MM-DD) */
    dailyResetDate: string;

    /** Number of currently open positions */
    openPositions: number;

    /** Total capital at risk across open positions (USD) */
    currentExposure: number;

    /** Cumulative session loss (USD). Used for cooldown circuit breaker. */
    sessionLoss: number;

    /** Cumulative session profit (USD). Used for profit-take trigger. */
    sessionProfit: number;

    /** Timestamp when cooldown started (0 = no active cooldown) */
    cooldownStartedAt: number;

    /** Cooldown duration in ms (0 = no active cooldown) */
    cooldownDurationMs: number;

    /** Whether profit-take has been triggered this session */
    profitTakeTriggered: boolean;

    /** Last updated timestamp */
    lastUpdatedAt: number;
}

const STORAGE_KEY_PREFIX = 'provian_pm_state_';

/**
 * Get or create prediction market state for an agent.
 */
async function getState(agentId: string): Promise<PredictionMarketState> {
    try {
        // HMAC-protected - tampered cooldown / loss-streak / exposure
        // values are dropped, so the agent enters its default conservative
        // state instead of running with attacker-controlled limits.
        const state = await getItemHmac<PredictionMarketState>(`${STORAGE_KEY_PREFIX}${agentId}`);
        if (state) {
            // Reset daily counter if date changed
            const today = new Date().toISOString().split('T')[0];
            if (state.dailyResetDate !== today) {
                state.dailyWagered = 0;
                state.dailyResetDate = today;
            }
            return state;
        }
    } catch (e) {
        console.error('[PredictionMarketPolicy] Failed to load state:', e);
    }

    // Default state
    return {
        agentId,
        dailyWagered: 0,
        dailyResetDate: new Date().toISOString().split('T')[0],
        openPositions: 0,
        currentExposure: 0,
        sessionLoss: 0,
        sessionProfit: 0,
        cooldownStartedAt: 0,
        cooldownDurationMs: 0,
        profitTakeTriggered: false,
        lastUpdatedAt: Date.now(),
    };
}

/**
 * Save prediction market state.
 */
async function saveState(state: PredictionMarketState): Promise<void> {
    state.lastUpdatedAt = Date.now();
    await setItemHmac(`${STORAGE_KEY_PREFIX}${state.agentId}`, state);
}

// ============================================================================
// PREDICTION MARKET POLICY EVALUATION
// ============================================================================

/**
 * Result of prediction market policy evaluation.
 */
export interface PredictionMarketEvaluation {
    /** Whether the bet is allowed */
    allowed: boolean;
    /** Policy violations (if any) */
    violations: PolicyViolation[];
    /** Warnings (notable but not blocking) */
    warnings: string[];
    /** Suggested friction lane */
    suggestedLane: FrictionLane;
    /** Current state snapshot (for PE recording) */
    stateSnapshot: {
        dailyWagered: number;
        openPositions: number;
        currentExposure: number;
        sessionLoss: number;
        sessionProfit: number;
        cooldownActive: boolean;
    };
}

/**
 * Input for prediction market policy evaluation.
 */
export interface PredictionMarketRequest {
    /** Agent making the bet */
    agentId: string;
    /** Bet amount in USD */
    betAmount: number;
    /** Target contract address */
    contractAddress: string;
    /** Market category/tags (from market metadata) */
    marketCategories?: string[];
    /** Market question/title (for PE recording) */
    marketTitle?: string;
    /** Platform name (e.g., "Polymarket") */
    platform?: string;
}

/**
 * Evaluate a prediction market transaction against policy.
 *
 * This is called by CryptoSpendingGovernance AFTER the general crypto
 * policy checks pass and the CryptoTransactionClassifier identifies the
 * transaction as targeting a prediction market contract.
 */
export async function evaluatePredictionMarketPolicy(
    request: PredictionMarketRequest,
    policy: PredictionMarketPolicyConfig
): Promise<PredictionMarketEvaluation> {
    const violations: PolicyViolation[] = [];
    const warnings: string[] = [];
    let suggestedLane: FrictionLane = 'auto_approve';

    const state = await getState(request.agentId);

    // =====================
    // 1. MASTER TOGGLE
    // =====================
    if (!policy.predictionMarketsEnabled) {
        violations.push({
            type: 'capability_denied',
            message: 'Prediction market activity is not enabled for this agent',
        });
        return buildResult(false, violations, warnings, 'block', state);
    }

    // =====================
    // 2. COOLDOWN CHECK (circuit breaker)
    // =====================
    if (state.cooldownStartedAt > 0) {
        const elapsed = Date.now() - state.cooldownStartedAt;
        if (elapsed < state.cooldownDurationMs) {
            const remainingMinutes = Math.ceil((state.cooldownDurationMs - elapsed) / 60000);
            violations.push({
                type: 'schedule_violation',
                message: `Cooldown active: ${remainingMinutes} minutes remaining after losses exceeded $${policy.cooldownAfterLoss.threshold}`,
                details: { remainingMinutes, lossThreshold: policy.cooldownAfterLoss.threshold },
            });
            return buildResult(false, violations, warnings, 'block', state);
        } else {
            // Cooldown expired - reset
            state.cooldownStartedAt = 0;
            state.cooldownDurationMs = 0;
            state.sessionLoss = 0;
        }
    }

    // =====================
    // 3. PROFIT-TAKE CHECK
    // =====================
    if (state.profitTakeTriggered && policy.profitTakeAction.action === 'pause') {
        violations.push({
            type: 'limit_exceeded',
            message: `Profit-take triggered: cumulative profit exceeded $${policy.profitTakeAction.target}. Betting paused.`,
            details: { profitTarget: policy.profitTakeAction.target, sessionProfit: state.sessionProfit },
        });
        return buildResult(false, violations, warnings, 'block', state);
    }

    // =====================
    // 4. PLATFORM ALLOWLIST
    // =====================
    if (policy.approvedPlatforms.length > 0) {
        const isApproved = policy.approvedPlatforms.some(
            addr => addr.toLowerCase() === request.contractAddress.toLowerCase()
        );
        if (!isApproved) {
            violations.push({
                type: 'merchant_blocked',
                message: `Contract ${request.contractAddress} is not in the approved prediction market platforms`,
                details: { contract: request.contractAddress, approved: policy.approvedPlatforms },
            });
            return buildResult(false, violations, warnings, 'block', state);
        }
    }

    // =====================
    // 5. CATEGORY BLACKLIST
    // =====================
    if (request.marketCategories && policy.categoryBlacklist.length > 0) {
        const blocked = request.marketCategories.filter(cat =>
            policy.categoryBlacklist.some(b => b.toLowerCase() === cat.toLowerCase())
        );
        if (blocked.length > 0) {
            violations.push({
                type: 'category_blocked',
                message: `Market categories blocked: ${blocked.join(', ')}`,
                details: { blockedCategories: blocked },
            });
            return buildResult(false, violations, warnings, 'block', state);
        }
    }

    // =====================
    // 6. BET SIZE LIMIT
    // =====================
    if (request.betAmount > policy.maxBetSize) {
        violations.push({
            type: 'limit_exceeded',
            message: `Bet size $${request.betAmount} exceeds max bet size of $${policy.maxBetSize}`,
            details: { betAmount: request.betAmount, maxBetSize: policy.maxBetSize },
        });
    }

    // =====================
    // 7. DAILY BUDGET CHECK
    // =====================
    if (state.dailyWagered + request.betAmount > policy.dailyBettingBudget) {
        violations.push({
            type: 'limit_exceeded',
            message: `Would exceed daily betting budget ($${state.dailyWagered} + $${request.betAmount} > $${policy.dailyBettingBudget})`,
            details: {
                dailyWagered: state.dailyWagered,
                betAmount: request.betAmount,
                dailyBudget: policy.dailyBettingBudget,
            },
        });
    } else if (state.dailyWagered + request.betAmount > policy.dailyBettingBudget * 0.8) {
        warnings.push(`Approaching daily betting budget (${Math.round((state.dailyWagered / policy.dailyBettingBudget) * 100)}% used)`);
    }

    // =====================
    // 8. OPEN POSITIONS CHECK
    // =====================
    if (state.openPositions >= policy.maxOpenPositions) {
        violations.push({
            type: 'limit_exceeded',
            message: `Open positions (${state.openPositions}) at maximum (${policy.maxOpenPositions})`,
            details: { openPositions: state.openPositions, maxOpenPositions: policy.maxOpenPositions },
        });
    }

    // =====================
    // 9. EXPOSURE CAP CHECK
    // =====================
    if (state.currentExposure + request.betAmount > policy.maxExposure) {
        violations.push({
            type: 'limit_exceeded',
            message: `Would exceed max exposure ($${state.currentExposure} + $${request.betAmount} > $${policy.maxExposure})`,
            details: {
                currentExposure: state.currentExposure,
                betAmount: request.betAmount,
                maxExposure: policy.maxExposure,
            },
        });
    }

    // =====================
    // 10. APPROVAL THRESHOLD
    // =====================
    if (violations.length === 0 && request.betAmount > policy.requireApprovalAbove) {
        suggestedLane = 'hard_confirm';
        warnings.push(`Bet $${request.betAmount} exceeds auto-approve threshold of $${policy.requireApprovalAbove} - requires human approval`);
    } else if (violations.length === 0) {
        // Small bet within all limits - auto-approve or soft-confirm
        suggestedLane = request.betAmount > policy.requireApprovalAbove * 0.5 ? 'soft_confirm' : 'auto_approve';
    }

    // If any violations, block
    if (violations.length > 0) {
        return buildResult(false, violations, warnings, 'block', state);
    }

    return buildResult(true, violations, warnings, suggestedLane, state);
}

// ============================================================================
// STATE MUTATION (post-execution)
// ============================================================================

/**
 * Record a bet placement (call after successful execution).
 */
export async function recordBetPlaced(
    agentId: string,
    betAmount: number
): Promise<void> {
    const state = await getState(agentId);
    state.dailyWagered += betAmount;
    state.openPositions += 1;
    state.currentExposure += betAmount;
    await saveState(state);
}

/**
 * Record a position closed (bet resolved).
 * @param pnl Profit/loss from the position (positive = profit, negative = loss)
 */
export async function recordPositionClosed(
    agentId: string,
    positionSize: number,
    pnl: number,
    policy: PredictionMarketPolicyConfig
): Promise<{ cooldownTriggered: boolean; profitTakeTriggered: boolean }> {
    const state = await getState(agentId);

    state.openPositions = Math.max(0, state.openPositions - 1);
    state.currentExposure = Math.max(0, state.currentExposure - positionSize);

    let cooldownTriggered = false;
    let profitTakeTriggered = false;

    if (pnl < 0) {
        state.sessionLoss += Math.abs(pnl);
        // Check cooldown trigger
        if (state.sessionLoss >= policy.cooldownAfterLoss.threshold) {
            state.cooldownStartedAt = Date.now();
            state.cooldownDurationMs = policy.cooldownAfterLoss.pauseMinutes * 60 * 1000;
            cooldownTriggered = true;
        }
    } else if (pnl > 0) {
        state.sessionProfit += pnl;
        // Check profit-take trigger
        if (state.sessionProfit >= policy.profitTakeAction.target && !state.profitTakeTriggered) {
            state.profitTakeTriggered = true;
            profitTakeTriggered = true;
        }
    }

    await saveState(state);
    return { cooldownTriggered, profitTakeTriggered };
}

/**
 * Reset session counters (e.g., when user manually resets after reviewing).
 */
export async function resetSession(agentId: string): Promise<void> {
    const state = await getState(agentId);
    state.sessionLoss = 0;
    state.sessionProfit = 0;
    state.cooldownStartedAt = 0;
    state.cooldownDurationMs = 0;
    state.profitTakeTriggered = false;
    await saveState(state);
}

/**
 * Get current prediction market state (for UI display).
 */
export async function getAgentPredictionMarketState(
    agentId: string
): Promise<PredictionMarketState> {
    return getState(agentId);
}

// ============================================================================
// HELPERS
// ============================================================================

function buildResult(
    allowed: boolean,
    violations: PolicyViolation[],
    warnings: string[],
    suggestedLane: FrictionLane,
    state: PredictionMarketState
): PredictionMarketEvaluation {
    return {
        allowed,
        violations,
        warnings,
        suggestedLane,
        stateSnapshot: {
            dailyWagered: state.dailyWagered,
            openPositions: state.openPositions,
            currentExposure: state.currentExposure,
            sessionLoss: state.sessionLoss,
            sessionProfit: state.sessionProfit,
            cooldownActive: state.cooldownStartedAt > 0 &&
                (Date.now() - state.cooldownStartedAt) < state.cooldownDurationMs,
        },
    };
}
