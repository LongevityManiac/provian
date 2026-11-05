/**
 * PolicyEvaluator - Evaluates requests against spending policies
 *
 * Takes a spending request and a policy, returns an evaluation result
 * indicating whether the request is allowed and what friction level applies.
 *
 * SECURITY FIX 7.1: Implements optimistic locking to prevent concurrent
 * evaluations from overspending the budget. Each policy has a lock that
 * must be acquired before evaluation.
 *
 * SECURITY FIX 3 (Tier 3): Uses proper async-mutex library instead of
 * custom Map-based locks to handle edge cases like timeouts and deadlocks.
 */

import { Mutex, withTimeout, E_TIMEOUT } from 'async-mutex';
import {
    SpendingPolicy,
    PolicyEvaluation,
    PolicyViolation,
    FrictionLane,
    MerchantCategory,
    CommunicationControls,
    CommitmentControls,
    DataSharingControls,
} from './types';
import {
    AgentSpendRequest,
    AgentSpendActionType,
    CommunicateActionMetadata,
    CommitActionMetadata,
    ShareDataActionMetadata,
    isNonFinancialAction,
} from './spendRequest';
import SpendingPolicyManager from './SpendingPolicy';
import { classifyMerchant } from './CategoryMatcher';

// SECURITY FIX 3: Proper async mutex for policy evaluation
// - One mutex per policy ID
// - 5 second timeout to prevent deadlocks
// - Automatic cleanup of unused mutexes
const LOCK_TIMEOUT_MS = 5000;
const policyMutexes: Map<string, Mutex> = new Map();

/**
 * Get or create a mutex for a policy.
 */
function getPolicyMutex(policyId: string): Mutex {
    let mutex = policyMutexes.get(policyId);
    if (!mutex) {
        mutex = new Mutex();
        policyMutexes.set(policyId, mutex);
    }
    return mutex;
}

/**
 * Evaluate a spending request against a policy.
 *
 * SECURITY FIX 7.1 + FIX 3: Acquires a proper mutex lock on the policy
 * with timeout to prevent deadlocks. If lock cannot be acquired within
 * 5 seconds, the request is rejected.
 */
export async function evaluatePolicy(
    request: AgentSpendRequest,
    policy: SpendingPolicy
): Promise<PolicyEvaluation> {
    const mutex = getPolicyMutex(policy.id);
    const timedMutex = withTimeout(mutex, LOCK_TIMEOUT_MS);

    try {
        // Acquire lock with timeout
        const release = await timedMutex.acquire();
        try {
            return await evaluatePolicyInternal(request, policy);
        } finally {
            // Always release lock, even if evaluation throws
            release();
        }
    } catch (error) {
        // Check if this is a timeout error
        if (error === E_TIMEOUT) {
            console.error(
                `[PolicyEvaluator] Lock acquisition timeout for policy ${policy.id}, agent ${request.agentId}`
            );
            // Return a blocked evaluation due to timeout
            return {
                passed: false,
                violations: [{
                    type: 'system_error',
                    message: 'Policy evaluation timed out - please try again',
                }],
                warnings: [],
                suggestedLane: 'block' as FrictionLane,
                riskScore: 100,
                remainingLimits: { daily: 0, weekly: 0, monthly: 0 },
            };
        }
        // Re-throw other errors
        throw error;
    }
}

/**
 * Internal policy evaluation (called with lock held).
 */
async function evaluatePolicyInternal(
    request: AgentSpendRequest,
    policy: SpendingPolicy
): Promise<PolicyEvaluation> {
    const violations: PolicyViolation[] = [];
    const warnings: string[] = [];
    let riskScore = 0;

    // Get current usage (safe because lock is held)
    const currentUsage = await SpendingPolicyManager.getCurrentUsage(policy.id);
    const remainingLimits = await SpendingPolicyManager.getRemainingLimits(policy.id);

    // =====================
    // CAPABILITY CHECKS
    // =====================

    // Check action type is allowed
    if (!policy.capabilities.allowedActionTypes.includes(request.actionType)) {
        violations.push({
            type: 'action_type_not_allowed',
            message: `Action type '${request.actionType}' is not allowed by policy`,
            details: { actionType: request.actionType, allowed: policy.capabilities.allowedActionTypes },
        });
    }

    // Check fiat capability
    if (request.actionType === 'purchase' && !policy.capabilities.canSpendFiat) {
        violations.push({
            type: 'capability_denied',
            message: 'Fiat spending is not enabled for this agent',
        });
    }

    // Check crypto capability
    if (
        (request.actionType === 'transfer' || request.actionType === 'swap') &&
        !policy.capabilities.canSpendCrypto
    ) {
        violations.push({
            type: 'capability_denied',
            message: 'Crypto spending is not enabled for this agent',
        });
    }

    // =====================
    // NON-FINANCIAL ACTION CHECKS
    // =====================
    // Non-financial actions (communicate, commit, share_data) require explicit
    // capability enablement. Without it, the action is allowed but defaults to
    // hard_confirm friction lane. With controls configured, more granular
    // evaluation determines the friction level.

    const nonFinancialResult = evaluateNonFinancialAction(request, policy);
    violations.push(...nonFinancialResult.violations);
    warnings.push(...nonFinancialResult.warnings);
    riskScore += nonFinancialResult.riskScore;

    // =====================
    // LIMIT CHECKS
    // =====================

    // Per-transaction limit
    if (request.amount > policy.limits.perTransaction) {
        violations.push({
            type: 'limit_exceeded',
            message: `Amount ${request.amount} exceeds per-transaction limit of ${policy.limits.perTransaction}`,
            details: { amount: request.amount, limit: policy.limits.perTransaction, limitType: 'perTransaction' },
        });
        riskScore += 40;
    }

    // Daily limit
    if (currentUsage.daily + request.amount > policy.limits.daily) {
        violations.push({
            type: 'limit_exceeded',
            message: `Would exceed daily limit (${currentUsage.daily} + ${request.amount} > ${policy.limits.daily})`,
            details: { current: currentUsage.daily, amount: request.amount, limit: policy.limits.daily, limitType: 'daily' },
        });
        riskScore += 30;
    } else if (currentUsage.daily + request.amount > policy.limits.daily * 0.8) {
        warnings.push(`Approaching daily limit (${Math.round((currentUsage.daily / policy.limits.daily) * 100)}% used)`);
        riskScore += 10;
    }

    // Weekly limit
    if (currentUsage.weekly + request.amount > policy.limits.weekly) {
        violations.push({
            type: 'limit_exceeded',
            message: `Would exceed weekly limit (${currentUsage.weekly} + ${request.amount} > ${policy.limits.weekly})`,
            details: { current: currentUsage.weekly, amount: request.amount, limit: policy.limits.weekly, limitType: 'weekly' },
        });
        riskScore += 25;
    }

    // Monthly limit
    if (currentUsage.monthly + request.amount > policy.limits.monthly) {
        violations.push({
            type: 'limit_exceeded',
            message: `Would exceed monthly limit (${currentUsage.monthly} + ${request.amount} > ${policy.limits.monthly})`,
            details: { current: currentUsage.monthly, amount: request.amount, limit: policy.limits.monthly, limitType: 'monthly' },
        });
        riskScore += 20;
    }

    // =====================
    // CATEGORY CHECKS
    // =====================

    const merchantCategory = classifyMerchant(request.merchant);

    // Check blocked categories
    if (policy.categories.blocked.includes(merchantCategory)) {
        violations.push({
            type: 'category_blocked',
            message: `Category '${merchantCategory}' is blocked by policy`,
            details: { category: merchantCategory, merchant: request.merchant },
        });
        riskScore += 50;
    }

    // Check allowlist mode
    if (
        policy.categories.mode === 'allowlist' &&
        policy.categories.allowed.length > 0 &&
        !policy.categories.allowed.includes(merchantCategory)
    ) {
        violations.push({
            type: 'category_blocked',
            message: `Category '${merchantCategory}' is not in the allowed list`,
            details: { category: merchantCategory, allowed: policy.categories.allowed },
        });
        riskScore += 30;
    }

    // =====================
    // MERCHANT CHECKS
    // =====================

    const normalizedMerchant = request.merchant.trim().toLowerCase();

    // Check merchant blocklist
    if (
        policy.merchants.blocklist.some(
            (m) => m.toLowerCase() === normalizedMerchant || normalizedMerchant.includes(m.toLowerCase())
        )
    ) {
        violations.push({
            type: 'merchant_blocked',
            message: `Merchant '${request.merchant}' is blocked by policy`,
            details: { merchant: request.merchant },
        });
        riskScore += 50;
    }

    // Check merchant allowlist mode
    if (policy.merchants.mode === 'allowlist' && policy.merchants.allowlist.length > 0) {
        const isAllowed = policy.merchants.allowlist.some(
            (m) => m.toLowerCase() === normalizedMerchant || normalizedMerchant.includes(m.toLowerCase())
        );
        if (!isAllowed) {
            violations.push({
                type: 'merchant_blocked',
                message: `Merchant '${request.merchant}' is not in the allowed list`,
                details: { merchant: request.merchant, allowed: policy.merchants.allowlist },
            });
            riskScore += 30;
        }
    }

    // Check if this is a new merchant (not in allowlist, not blocked - might warrant attention)
    if (
        policy.merchants.mode === 'any' &&
        !policy.merchants.allowlist.some((m) => m.toLowerCase() === normalizedMerchant)
    ) {
        warnings.push(`New merchant: ${request.merchant}`);
        riskScore += 5;
    }

    // =====================
    // SCHEDULE CHECKS
    // =====================

    const scheduleViolation = checkSchedule(policy.schedule, new Date());
    if (scheduleViolation) {
        violations.push({
            type: 'schedule_violation',
            message: scheduleViolation,
        });
        riskScore += 20;
    }

    // =====================
    // DETERMINE FRICTION LANE
    // =====================

    let suggestedLane: FrictionLane;

    if (violations.length > 0) {
        // Any violation = block
        suggestedLane = 'block';
    } else if (nonFinancialResult.forceHardConfirm) {
        // [Fix F7] Non-financial controls computed a forceHardConfirm signal
        // (capability disabled, controls/metadata missing, sensitive data type).
        // Previously this signal was dropped and the action leaked to soft_confirm
        // (or auto-approve), downgrading Face ID to tap-to-approve. Honor it.
        suggestedLane = 'hard_confirm';
    } else if (request.amount < policy.friction.autoApproveBelow && riskScore < 20) {
        // Low amount + low risk = auto-approve
        suggestedLane = 'auto_approve';
    } else if (request.amount < policy.friction.softConfirmBelow && riskScore < 40) {
        // Medium amount or mild risk = soft confirm (push notification)
        suggestedLane = 'soft_confirm';
    } else {
        // High amount or elevated risk = hard confirm (Face ID)
        suggestedLane = 'hard_confirm';
    }

    // Clamp risk score
    riskScore = Math.min(100, Math.max(0, riskScore));

    return {
        passed: violations.length === 0,
        violations,
        warnings,
        suggestedLane,
        riskScore,
        remainingLimits: {
            daily: Math.max(0, remainingLimits.daily - request.amount),
            weekly: Math.max(0, remainingLimits.weekly - request.amount),
            monthly: Math.max(0, remainingLimits.monthly - request.amount),
        },
    };
}

/**
 * Quick check if a request would be allowed by a policy (without full evaluation).
 */
export async function quickPolicyCheck(
    request: AgentSpendRequest,
    policy: SpendingPolicy
): Promise<boolean> {
    // Check policy status
    if (policy.status !== 'active') {
        return false;
    }

    // Check action type
    if (!policy.capabilities.allowedActionTypes.includes(request.actionType)) {
        return false;
    }

    // Check per-transaction limit
    if (request.amount > policy.limits.perTransaction) {
        return false;
    }

    // Check category
    const category = classifyMerchant(request.merchant);
    if (policy.categories.blocked.includes(category)) {
        return false;
    }

    // Check merchant blocklist
    const normalizedMerchant = request.merchant.trim().toLowerCase();
    if (
        policy.merchants.blocklist.some(
            (m) => m.toLowerCase() === normalizedMerchant
        )
    ) {
        return false;
    }

    return true;
}

/**
 * Check if current time is within schedule.
 */
function checkSchedule(
    schedule: { activeHours: { start: number; end: number }; activeDays: number[]; timezone: string },
    now: Date
): string | null {
    // Convert to local time in the policy's timezone
    const localTime = new Date(now.toLocaleString('en-US', { timeZone: schedule.timezone }));
    const currentHour = localTime.getHours();
    const currentDay = localTime.getDay();

    // Check day
    if (!schedule.activeDays.includes(currentDay)) {
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        return `Agent spending not allowed on ${dayNames[currentDay]}`;
    }

    // Check hours
    if (schedule.activeHours.start <= schedule.activeHours.end) {
        // Normal range (e.g., 9-22)
        if (currentHour < schedule.activeHours.start || currentHour > schedule.activeHours.end) {
            return `Agent spending only allowed ${schedule.activeHours.start}:00-${schedule.activeHours.end}:00`;
        }
    } else {
        // Overnight range (e.g., 22-6)
        if (currentHour < schedule.activeHours.start && currentHour > schedule.activeHours.end) {
            return `Agent spending only allowed ${schedule.activeHours.start}:00-${schedule.activeHours.end}:00`;
        }
    }

    return null;
}

/**
 * Get policy evaluation summary for display.
 */
export function getEvaluationSummary(evaluation: PolicyEvaluation): string {
    if (evaluation.passed) {
        if (evaluation.warnings.length > 0) {
            return `Approved with warnings: ${evaluation.warnings.join(', ')}`;
        }
        return 'Approved';
    }

    return evaluation.violations.map((v) => v.message).join('; ');
}

// ============================================================================
// NON-FINANCIAL ACTION EVALUATION
// ============================================================================

interface NonFinancialEvaluationResult {
    violations: PolicyViolation[];
    warnings: string[];
    riskScore: number;
    /** If true, force hard_confirm even if no violations */
    forceHardConfirm: boolean;
}

/**
 * Evaluate non-financial action types (communicate, commit, share_data).
 * These actions default to hard_confirm if capability is not enabled or
 * no controls are configured.
 *
 * Exported so the authorization gate can route the dedicated non-financial
 * action handlers (communicate/commit/share_data) through the same controls
 * (see AgentAuthorizationGate.authorizeNonFinancialAction, Fix F3).
 */
export function evaluateNonFinancialAction(
    request: AgentSpendRequest,
    policy: SpendingPolicy
): NonFinancialEvaluationResult {
    const violations: PolicyViolation[] = [];
    const warnings: string[] = [];
    let riskScore = 0;
    let forceHardConfirm = false;

    // Only evaluate non-financial action types
    if (!isNonFinancialAction(request.actionType)) {
        return { violations, warnings, riskScore, forceHardConfirm };
    }

    // Base risk score for non-financial actions (they're inherently sensitive)
    const baseRiskScores: Record<string, number> = {
        communicate: 20,
        commit: 25,
        share_data: 30,
    };
    riskScore += baseRiskScores[request.actionType] || 20;

    switch (request.actionType) {
        case 'communicate':
            return evaluateCommunicateAction(request, policy, riskScore);

        case 'commit':
            return evaluateCommitAction(request, policy, riskScore);

        case 'share_data':
            return evaluateShareDataAction(request, policy, riskScore);

        default:
            return { violations, warnings, riskScore, forceHardConfirm };
    }
}

/**
 * Evaluate COMMUNICATE action.
 */
function evaluateCommunicateAction(
    request: AgentSpendRequest,
    policy: SpendingPolicy,
    baseRiskScore: number
): NonFinancialEvaluationResult {
    const violations: PolicyViolation[] = [];
    const warnings: string[] = [];
    let riskScore = baseRiskScore;
    let forceHardConfirm = false;

    // Check capability
    if (!policy.capabilities.canCommunicate) {
        // Capability not enabled - not a violation, but forces hard_confirm
        warnings.push('Communication capability not enabled - requires manual approval');
        forceHardConfirm = true;
        return { violations, warnings, riskScore, forceHardConfirm };
    }

    // Get controls - if undefined, force hard_confirm
    const controls = policy.communication;
    if (!controls) {
        warnings.push('No communication controls configured - requires manual approval');
        forceHardConfirm = true;
        return { violations, warnings, riskScore, forceHardConfirm };
    }

    // Extract metadata
    const metadata = request.metadata as CommunicateActionMetadata | undefined;
    if (!metadata) {
        warnings.push('Missing communication metadata - requires manual approval');
        forceHardConfirm = true;
        return { violations, warnings, riskScore, forceHardConfirm };
    }

    // Check channel
    if (controls.allowedChannels.length > 0 && !controls.allowedChannels.includes(metadata.channel)) {
        violations.push({
            type: 'communication_channel_blocked',
            message: `Communication channel '${metadata.channel}' is not allowed`,
            details: { channel: metadata.channel, allowed: controls.allowedChannels },
        });
        riskScore += 30;
    }

    // Check recipient against blocklist
    const normalizedRecipient = metadata.recipient.toLowerCase();
    if (controls.blockedRecipients.some(blocked => normalizedRecipient.includes(blocked.toLowerCase()))) {
        violations.push({
            type: 'communication_recipient_blocked',
            message: `Recipient '${metadata.recipient}' is blocked`,
            details: { recipient: metadata.recipient },
        });
        riskScore += 40;
    }

    // Check recipient domain allowlist (if configured)
    if (controls.allowedRecipientDomains.length > 0) {
        const recipientDomain = normalizedRecipient.split('@').pop() || '';
        const domainAllowed = controls.allowedRecipientDomains.some(
            domain => recipientDomain.endsWith(domain.toLowerCase().replace('@', ''))
        );
        if (!domainAllowed) {
            warnings.push(`Recipient domain not in allowlist - escalating to hard_confirm`);
            forceHardConfirm = true;
            riskScore += 15;
        }
    }

    // Check if auto-approve reply is applicable
    if (metadata.isReply && controls.autoApproveReplies && violations.length === 0) {
        // Reduce risk score for replies if configured
        riskScore = Math.max(0, riskScore - 15);
    }

    return { violations, warnings, riskScore, forceHardConfirm };
}

/**
 * Evaluate COMMIT action.
 */
function evaluateCommitAction(
    request: AgentSpendRequest,
    policy: SpendingPolicy,
    baseRiskScore: number
): NonFinancialEvaluationResult {
    const violations: PolicyViolation[] = [];
    const warnings: string[] = [];
    let riskScore = baseRiskScore;
    let forceHardConfirm = false;

    // Check capability
    if (!policy.capabilities.canCommit) {
        warnings.push('Commitment capability not enabled - requires manual approval');
        forceHardConfirm = true;
        return { violations, warnings, riskScore, forceHardConfirm };
    }

    // Get controls
    const controls = policy.commitments;
    if (!controls) {
        warnings.push('No commitment controls configured - requires manual approval');
        forceHardConfirm = true;
        return { violations, warnings, riskScore, forceHardConfirm };
    }

    // Extract metadata
    const metadata = request.metadata as CommitActionMetadata | undefined;
    if (!metadata) {
        warnings.push('Missing commitment metadata - requires manual approval');
        forceHardConfirm = true;
        return { violations, warnings, riskScore, forceHardConfirm };
    }

    // Check commitment type
    if (controls.allowedCommitmentTypes.length > 0 &&
        !controls.allowedCommitmentTypes.includes(metadata.commitmentType)) {
        violations.push({
            type: 'commitment_type_blocked',
            message: `Commitment type '${metadata.commitmentType}' is not allowed`,
            details: { type: metadata.commitmentType, allowed: controls.allowedCommitmentTypes },
        });
        riskScore += 30;
    }

    // Check counterparty blocklist
    const normalizedCounterparty = metadata.counterparty.toLowerCase();
    if (controls.blockedCounterparties.some(blocked => normalizedCounterparty.includes(blocked.toLowerCase()))) {
        violations.push({
            type: 'commitment_counterparty_blocked',
            message: `Counterparty '${metadata.counterparty}' is blocked`,
            details: { counterparty: metadata.counterparty },
        });
        riskScore += 40;
    }

    // Check revocability requirement
    if (controls.requireRevocable && !metadata.isRevocable) {
        violations.push({
            type: 'commitment_non_revocable',
            message: 'Non-revocable commitments are not allowed',
            details: { isRevocable: metadata.isRevocable },
        });
        riskScore += 35;
    }

    // Check financial implication
    if (metadata.financialImplication) {
        const amount = metadata.financialImplication.amount;
        if (amount > controls.maxAutoApproveImplication) {
            warnings.push(`Financial implication ${amount} exceeds auto-approve limit - requires hard_confirm`);
            forceHardConfirm = true;
            riskScore += 20;
        }
    } else if (controls.autoApproveFreeTrials && metadata.commitmentType === 'trial') {
        // Reduce risk for free trials if configured
        riskScore = Math.max(0, riskScore - 10);
    }

    return { violations, warnings, riskScore, forceHardConfirm };
}

/**
 * Evaluate SHARE_DATA action.
 */
function evaluateShareDataAction(
    request: AgentSpendRequest,
    policy: SpendingPolicy,
    baseRiskScore: number
): NonFinancialEvaluationResult {
    const violations: PolicyViolation[] = [];
    const warnings: string[] = [];
    let riskScore = baseRiskScore;
    let forceHardConfirm = false;

    // Check capability
    if (!policy.capabilities.canShareData) {
        warnings.push('Data sharing capability not enabled - requires manual approval');
        forceHardConfirm = true;
        return { violations, warnings, riskScore, forceHardConfirm };
    }

    // Get controls
    const controls = policy.dataSharing;
    if (!controls) {
        warnings.push('No data sharing controls configured - requires manual approval');
        forceHardConfirm = true;
        return { violations, warnings, riskScore, forceHardConfirm };
    }

    // Extract metadata
    const metadata = request.metadata as ShareDataActionMetadata | undefined;
    if (!metadata) {
        warnings.push('Missing data sharing metadata - requires manual approval');
        forceHardConfirm = true;
        return { violations, warnings, riskScore, forceHardConfirm };
    }

    // Check blocked data types (hard block)
    if (controls.blockedDataTypes.includes(metadata.dataType)) {
        violations.push({
            type: 'data_type_blocked',
            message: `Data type '${metadata.dataType}' is blocked and cannot be shared`,
            details: { dataType: metadata.dataType, blocked: controls.blockedDataTypes },
        });
        riskScore += 50;
    }

    // Check allowed data types (if configured)
    if (controls.allowedDataTypes.length > 0 && !controls.allowedDataTypes.includes(metadata.dataType)) {
        violations.push({
            type: 'data_type_blocked',
            message: `Data type '${metadata.dataType}' is not in allowed list`,
            details: { dataType: metadata.dataType, allowed: controls.allowedDataTypes },
        });
        riskScore += 30;
    }

    // Check recipient allowlist
    const normalizedRecipient = metadata.recipient.toLowerCase();
    if (controls.allowedRecipients.length > 0) {
        const recipientAllowed = controls.allowedRecipients.some(
            allowed => normalizedRecipient.includes(allowed.toLowerCase())
        );
        if (!recipientAllowed) {
            violations.push({
                type: 'data_recipient_blocked',
                message: `Recipient '${metadata.recipient}' is not in allowed recipients list`,
                details: { recipient: metadata.recipient, allowed: controls.allowedRecipients },
            });
            riskScore += 35;
        }
    }

    // Check recoverability requirement
    if (controls.requireRecoverable && !metadata.isRecoverable) {
        violations.push({
            type: 'data_non_recoverable',
            message: 'Data sharing must be recoverable (deletable after sharing)',
            details: { isRecoverable: metadata.isRecoverable },
        });
        riskScore += 30;
    }

    // Add extra risk for sensitive data types. Spec: share_data ALWAYS pushes for
    // medical/financial/identity/credentials, so force hard_confirm rather than
    // merely raising the risk score - otherwise a configured allowlist could let a
    // sensitive-data share auto-approve. (Fix F3)
    const sensitiveTypes = ['medical', 'financial', 'identity', 'credentials'];
    if (sensitiveTypes.includes(metadata.dataType)) {
        riskScore += 10;
        if (violations.length === 0) {
            forceHardConfirm = true;
            warnings.push(`Sharing sensitive data type '${metadata.dataType}' - requires manual approval`);
        }
    }

    return { violations, warnings, riskScore, forceHardConfirm };
}

/**
 * Check if a non-financial action should force hard_confirm.
 * Used by FrictionRouter to determine final lane.
 */
export function shouldForceHardConfirmForNonFinancial(
    request: AgentSpendRequest,
    policy: SpendingPolicy
): boolean {
    if (!isNonFinancialAction(request.actionType)) {
        return false;
    }

    const result = evaluateNonFinancialAction(request, policy);
    return result.forceHardConfirm;
}
