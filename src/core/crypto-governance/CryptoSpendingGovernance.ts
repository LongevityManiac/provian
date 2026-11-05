import type { BiometricAction } from '../security/biometricAction';
/**
 * CryptoSpendingGovernance - On-Chain Transaction Governance
 *
 * Runs a dApp's on-chain request through policy → lane before the wallet
 * owner's own key signs it. Since the only caller is the owner's
 * WalletConnect signing (`src/core/walletconnect/WalletConnectGovernance.ts`);
 * there is no agent-initiated device signing.
 *
 * ARCHITECTURE:
 *
 * dApp request over WalletConnect (owner's own wallet)
 * ↓
 * CryptoSpendingGovernance.evaluateCryptoTransaction()
 * ↓
 * ┌─────────────────────────────────────────────────┐
 * │ 1. Capability check (canSpendCrypto) │
 * │ 2. General crypto policy (limits, schedule) │
 * │ 3. CryptoTransactionClassifier │
 * │ └── Contract address → category │
 * │ └── Function selector → sub-action │
 * │ 4. Category-specific policy │
 * │ └── prediction_market → PredictionMarketPolicy│
 * │ └── dex_swap → DEX limits (future) │
 * │ └── token_approval → approval limits │
 * └─────────────────────────────────────────────────┘
 * ↓
 * Signing decision (auto_approve | soft_confirm | hard_confirm | block)
 * ↓
 * Wallet signing key (BIP-39 EOA via SeedManager) signs (or denies)
 * ↓
 * Provenance Envelope recorded
 *
 * SECURITY MODEL:
 * - The wallet key (BIP-39 secp256k1, Keychain/Keystore via SeedManager — not
 * the Secure Enclave, which holds only the P-256 PE key) signs a governed
 * request only after this layer has produced a lane.
 * - Unknown transactions default to hard_confirm, never auto_approve.
 * - Escalation can ONLY raise the lane, never reduce it.
 * - Every evaluation is recorded as a Provenance Envelope regardless of outcome.
 */

import { PolicyEvaluation, PolicyViolation, FrictionLane, SpendingPolicy } from './types';
import { AgentSpendRequest } from './spendRequest';
import { evaluatePolicy } from './PolicyEvaluator';
import { getDailyCryptoSpentUsd } from './DailyCryptoSpendTracker';
import {
    classifyCryptoTransaction,
    CryptoTransactionInput,
    CryptoClassification,
    CryptoTransactionCategory,
    isPredictionMarketTransaction,
} from './CryptoTransactionClassifier';
import {
    evaluatePredictionMarketPolicy,
    PredictionMarketPolicyConfig,
    PredictionMarketEvaluation,
    DEFAULT_PREDICTION_MARKET_POLICY,
} from './PredictionMarketPolicy';

// ============================================================================
// CRYPTO SPENDING POLICY EXTENSION
// ============================================================================

/**
 * Crypto-specific policy controls, extending the base SpendingPolicy.
 * These are stored alongside the existing SpendingPolicy for an agent.
 */
export interface CryptoSpendingControls {
    /** Per-transaction limit for on-chain transactions (USD) */
    perTransactionLimit: number;

    /** Daily on-chain spending limit (USD) */
    dailyOnChainLimit: number;

    /** Allowed chains (empty = all supported chains) */
    allowedChains: string[];

    /** Allowed contract addresses (empty = any, but unknown → hard_confirm) */
    contractAllowlist: string[];

    /** Blocked contract addresses (always denied) */
    contractBlocklist: string[];

    /** Whether to allow interactions with unknown contracts (default: false → block; true → hard_confirm minimum) */
    allowUnknownContracts: boolean;

    /** Maximum token approval amount (USD). Prevents infinite approvals. */
    maxApprovalAmount: number;

    /** Whether to require hard_confirm for all token approvals */
    requireApprovalConfirm: boolean;

    /** Prediction market policy (undefined = use defaults) */
    predictionMarket?: PredictionMarketPolicyConfig;

    /** Categories that require hard_confirm (even if otherwise auto-approve) */
    highFrictionCategories: CryptoTransactionCategory[];

    /** Categories that are completely blocked */
    blockedCategories: CryptoTransactionCategory[];
}

/**
 * Default crypto spending controls - conservative.
 */
export const DEFAULT_CRYPTO_SPENDING_CONTROLS: CryptoSpendingControls = {
    perTransactionLimit: 100,
    dailyOnChainLimit: 500,
    allowedChains: [], // All supported chains
    contractAllowlist: [],
    contractBlocklist: [],
    allowUnknownContracts: false,
    maxApprovalAmount: 1000,
    requireApprovalConfirm: true,
    predictionMarket: DEFAULT_PREDICTION_MARKET_POLICY,
    highFrictionCategories: ['prediction_market', 'bridge', 'contract_deploy'],
    blockedCategories: [],
};

// ============================================================================
// CRYPTO TRANSACTION EVALUATION
// ============================================================================

/**
 * Full result of crypto spending governance evaluation.
 */
export interface CryptoGovernanceResult {
    /** Whether the transaction is allowed to proceed */
    allowed: boolean;

    /** General policy evaluation (limits, schedule, categories) */
    policyEvaluation: PolicyEvaluation;

    /** Transaction classification */
    classification: CryptoClassification;

    /** Prediction market evaluation (if applicable) */
    predictionMarketEvaluation?: PredictionMarketEvaluation;

    /** Final friction lane (after all escalations) */
    finalLane: FrictionLane;

    /** Combined violations from all evaluation layers */
    allViolations: PolicyViolation[];

    /** Combined warnings from all evaluation layers */
    allWarnings: string[];

    /** Whether this was escalated due to crypto-specific rules */
    cryptoEscalated: boolean;

    /** Reason for escalation if applicable */
    escalationReason?: string;
}

/**
 * Evaluate a crypto transaction against all governance layers.
 *
 * This is the main entry point for crypto spending governance.
 * Call this before allowing the Secure Enclave to sign any agent-initiated
 * on-chain transaction.
 *
 * @param agentRequest - The standard agent spend request
 * @param policy - The agent's spending policy (includes crypto controls)
 * @param txInput - The raw transaction details (to, value, data, chain)
 * @param cryptoControls - Crypto-specific policy controls
 */
export async function evaluateCryptoTransaction(
    agentRequest: AgentSpendRequest,
    policy: SpendingPolicy,
    txInput: CryptoTransactionInput,
    cryptoControls: CryptoSpendingControls = DEFAULT_CRYPTO_SPENDING_CONTROLS, biometricAction?: BiometricAction
): Promise<CryptoGovernanceResult> {
    const allViolations: PolicyViolation[] = [];
    const allWarnings: string[] = [];
    let finalLane: FrictionLane = 'auto_approve';
    let cryptoEscalated = false;
    let escalationReason: string | undefined;

    // =====================
    // LAYER 1: General policy evaluation (same as fiat)
    // =====================
    // This checks: capabilities (canSpendCrypto), limits, categories, schedule, friction thresholds
    const policyEvaluation = await evaluatePolicy(agentRequest, policy);
    allViolations.push(...policyEvaluation.violations);
    allWarnings.push(...policyEvaluation.warnings);
    finalLane = policyEvaluation.suggestedLane;

    // If general policy blocks, stop here
    if (finalLane === 'block') {
        const classification = classifyCryptoTransaction(txInput, biometricAction);
        return {
            allowed: false,
            policyEvaluation,
            classification,
            finalLane: 'block',
            allViolations,
            allWarnings,
            cryptoEscalated: false,
        };
    }

    // =====================
    // LAYER 2: Transaction classification
    // =====================
    const classification = classifyCryptoTransaction(txInput, biometricAction);

    // SECURITY FIX: K-2 - Unknown contract → ALWAYS hard_confirm minimum.
    // The allowUnknownContracts flag controls whether to BLOCK (false) or allow
    // with hard_confirm (true). It must never reduce friction below hard_confirm.
    // Per CLAUDE.md pitfall #12: escalation only goes UP, never down.
    if (classification.category === 'unknown') {
        if (!cryptoControls.allowUnknownContracts) {
            finalLane = 'block';
            cryptoEscalated = true;
            escalationReason = 'Unknown contract interaction blocked by policy';
            allWarnings.push(escalationReason);
        } else {
            finalLane = escalateLane(finalLane, 'hard_confirm');
            cryptoEscalated = true;
            escalationReason = 'Unknown contract interaction requires manual approval';
            allWarnings.push(escalationReason);
        }
    }

    // Low confidence classification → escalate
    if (classification.confidence < 0.7 && classification.category !== 'unknown') {
        finalLane = escalateLane(finalLane, 'soft_confirm');
        if (!cryptoEscalated) {
            cryptoEscalated = true;
            escalationReason = `Low confidence classification (${Math.round(classification.confidence * 100)}%)`;
        }
        allWarnings.push(`Transaction classification confidence: ${Math.round(classification.confidence * 100)}%`);
    }

    // =====================
    // LAYER 3: Crypto-specific policy checks
    // =====================

    // Chain allowlist
    if (cryptoControls.allowedChains.length > 0 && !cryptoControls.allowedChains.includes(txInput.chain)) {
        allViolations.push({
            type: 'capability_denied',
            message: `Chain '${txInput.chain}' is not in the allowed chains list`,
            details: { chain: txInput.chain, allowed: cryptoControls.allowedChains },
        });
        finalLane = 'block';
    }

    // Contract blocklist
    if (txInput.to && cryptoControls.contractBlocklist.some(
        addr => addr.toLowerCase() === txInput.to!.toLowerCase()
    )) {
        allViolations.push({
            type: 'merchant_blocked',
            message: `Contract ${txInput.to} is explicitly blocked`,
            details: { contract: txInput.to },
        });
        finalLane = 'block';
    }

    // Per-transaction limit
    if (agentRequest.amount > cryptoControls.perTransactionLimit) {
        allViolations.push({
            type: 'limit_exceeded',
            message: `Crypto transaction $${agentRequest.amount} exceeds per-transaction limit of $${cryptoControls.perTransactionLimit}`,
            details: { amount: agentRequest.amount, limit: cryptoControls.perTransactionLimit },
        });
        finalLane = 'block';
    }

    // Daily on-chain spending limit
    if (cryptoControls.dailyOnChainLimit > 0) {
        // WS5: read the cumulative spend from the persistent accumulator when the
        // caller didn't supply an override. Previously nothing ever wrote
        // metadata.dailyCryptoSpent, so this was permanently 0 and the cap only
        // tripped on a single tx that alone exceeded the limit (drain-via-many-
        // sub-limit-transfers slipped through). The execution paths record into
        // DailyCryptoSpendTracker after a spend dispatches.
        const dailySpent = (agentRequest.metadata?.dailyCryptoSpent as number)
            ?? await getDailyCryptoSpentUsd(agentRequest.agentId);
        if (dailySpent + agentRequest.amount > cryptoControls.dailyOnChainLimit) {
            allViolations.push({
                type: 'limit_exceeded',
                message: `Daily on-chain spend ($${dailySpent + agentRequest.amount}) would exceed limit of $${cryptoControls.dailyOnChainLimit}`,
                details: { dailySpent, amount: agentRequest.amount, limit: cryptoControls.dailyOnChainLimit },
            });
            finalLane = 'block';
        }
    }

    // Token approval limits
    if (classification.category === 'token_approval') {
        if (cryptoControls.requireApprovalConfirm) {
            finalLane = escalateLane(finalLane, 'hard_confirm');
            cryptoEscalated = true;
            escalationReason = 'Token approval requires manual confirmation';
            allWarnings.push('Token approval requires explicit approval');
        }
        if (agentRequest.amount > cryptoControls.maxApprovalAmount) {
            allViolations.push({
                type: 'limit_exceeded',
                message: `Approval amount $${agentRequest.amount} exceeds max approval limit of $${cryptoControls.maxApprovalAmount}`,
                details: { amount: agentRequest.amount, limit: cryptoControls.maxApprovalAmount },
            });
            finalLane = 'block';
        }
    }

    // High-friction categories → escalate to hard_confirm
    if (cryptoControls.highFrictionCategories.includes(classification.category)) {
        finalLane = escalateLane(finalLane, 'hard_confirm');
        if (!cryptoEscalated) {
            cryptoEscalated = true;
            escalationReason = `${classification.category} transactions require manual approval`;
        }
    }

    // Blocked categories
    if (cryptoControls.blockedCategories.includes(classification.category)) {
        allViolations.push({
            type: 'category_blocked',
            message: `Transaction category '${classification.category}' is blocked`,
            details: { category: classification.category },
        });
        finalLane = 'block';
    }

    // =====================
    // LAYER 4: Prediction market policy (if applicable)
    // =====================
    let predictionMarketEvaluation: PredictionMarketEvaluation | undefined;

    if (classification.category === 'prediction_market') {
        const pmPolicy = cryptoControls.predictionMarket ?? DEFAULT_PREDICTION_MARKET_POLICY;

        predictionMarketEvaluation = await evaluatePredictionMarketPolicy(
            {
                agentId: agentRequest.agentId,
                betAmount: agentRequest.amount,
                contractAddress: txInput.to || '',
                marketCategories: agentRequest.metadata?.marketCategories as string[] | undefined,
                marketTitle: agentRequest.metadata?.marketTitle as string | undefined,
                platform: classification.platform,
            },
            pmPolicy
        );

        allViolations.push(...predictionMarketEvaluation.violations);
        allWarnings.push(...predictionMarketEvaluation.warnings);

        if (!predictionMarketEvaluation.allowed) {
            finalLane = 'block';
        } else {
            // Escalate to prediction market's suggested lane if more restrictive
            finalLane = escalateLane(finalLane, predictionMarketEvaluation.suggestedLane);
        }
    }

    // =====================
    // FINAL RESULT
    // =====================
    const allowed = finalLane !== 'block' && allViolations.length === 0;

    return {
        allowed,
        policyEvaluation,
        classification,
        predictionMarketEvaluation,
        finalLane: allViolations.length > 0 ? 'block' : finalLane,
        allViolations,
        allWarnings,
        cryptoEscalated,
        escalationReason,
    };
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Escalate to a more restrictive lane (never de-escalate).
 */
function escalateLane(current: FrictionLane, target: FrictionLane): FrictionLane {
    const order: FrictionLane[] = ['auto_approve', 'soft_confirm', 'hard_confirm', 'block'];
    const currentIdx = order.indexOf(current);
    const targetIdx = order.indexOf(target);
    return order[Math.max(currentIdx, targetIdx)];
}
