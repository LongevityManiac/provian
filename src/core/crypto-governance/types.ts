/**
 * Spending Policy Types
 *
 * Extended policy system for fine-grained control over agent spending.
 * Builds on the existing budget system in AgentAuthorizationGate.
 */

import { AgentSpendActionType } from './spendRequest';

/**
 * Merchant categories for policy controls.
 */
export type MerchantCategory =
    | 'food_dining'
    | 'groceries'
    | 'transportation'
    | 'entertainment'
    | 'shopping'
    | 'travel'
    | 'utilities'
    | 'subscriptions'
    | 'healthcare'
    | 'education'
    | 'financial_services'
    | 'gambling'
    | 'adult'
    | 'crypto'
    | 'other';

/**
 * Card access mode.
 * - provian_holds: Card stays on device; phone must be on for every transaction
 * - agent_has_card: Agent has independent card access; checks policy via relay
 */
export type CardAccessMode = 'provian_holds' | 'agent_has_card';

/**
 * Default blocked categories (can be overridden by user).
 */
export const DEFAULT_BLOCKED_CATEGORIES: MerchantCategory[] = ['gambling', 'adult'];

/**
 * Policy status.
 */
export type PolicyStatus = 'active' | 'paused' | 'archived';

/**
 * Friction lane classification.
 */
export type FrictionLane = 'auto_approve' | 'soft_confirm' | 'hard_confirm' | 'block';

/**
 * Spending limits configuration.
 */
export interface SpendingLimits {
    /** Maximum per single transaction (USD) */
    perTransaction: number;

    /** Maximum per day (USD) */
    daily: number;

    /** Maximum per week (USD) */
    weekly: number;

    /** Maximum per month (USD) */
    monthly: number;
}

/**
 * Category controls.
 */
export interface CategoryControls {
    /** Allowed categories (if mode is 'allowlist') */
    allowed: MerchantCategory[];

    /** Blocked categories (always applied) */
    blocked: MerchantCategory[];

    /** Mode: 'allowlist' means ONLY allowed categories; 'blocklist' means all except blocked */
    mode: 'allowlist' | 'blocklist';
}

/**
 * Merchant controls.
 */
export interface MerchantControls {
    /** If set, ONLY these merchants are allowed */
    allowlist: string[];

    /** These merchants are always blocked */
    blocklist: string[];

    /** Mode: 'allowlist', 'blocklist', or 'any' */
    mode: 'allowlist' | 'blocklist' | 'any';
}

/**
 * Rail controls (which payment methods can be used).
 */
export interface RailControls {
    /** Credential IDs that can be used (empty = all) */
    allowedCredentialIds: string[];

    /** Preferred credential for this agent */
    preferredCredentialId?: string;
}

/**
 * Schedule controls (when agent can spend).
 */
export interface ScheduleControls {
    /** Active hours (24-hour format, e.g., { start: 9, end: 22 }) */
    activeHours: {
        start: number;  // 0-23
        end: number;    // 0-23
    };

    /** Active days of week (0=Sunday, 6=Saturday) */
    activeDays: number[];

    /** Timezone for schedule evaluation */
    timezone: string;
}

/**
 * Friction thresholds.
 */
export interface FrictionThresholds {
    /** Auto-approve if amount is below this (USD) */
    autoApproveBelow: number;

    /** Soft confirm (push notification) if amount is below this (USD) */
    softConfirmBelow: number;

    /** Above softConfirmBelow requires hard confirm (Face ID) */
    // Above softConfirmBelow = hard_confirm
}

/**
 * Capabilities - what the agent can do.
 */
export interface AgentCapabilities {
    /** Can create/manage promises */
    canCreatePromises: boolean;

    /** Can spend fiat via credential release */
    canSpendFiat: boolean;

    /** Can spend crypto (disabled at launch) */
    canSpendCrypto: boolean;

    /** Allowed action types */
    allowedActionTypes: AgentSpendActionType[];

    // Non-financial action capabilities (all default to false = ALWAYS_CONFIRM)

    /** Can send communications on behalf of user (email, messages, etc.) */
    canCommunicate: boolean;

    /** Can make commitments on behalf of user (accept terms, sign up, book, etc.) */
    canCommit: boolean;

    /** Can share/export user data to third parties */
    canShareData: boolean;
}

// ============================================================================
// NON-FINANCIAL ACTION CONTROLS
// ============================================================================
// Controls for non-financial actions. When undefined, the action defaults to
// ALWAYS_CONFIRM (hard_confirm friction lane). Users must explicitly configure
// controls to enable any auto-approval for these sensitive actions.
// ============================================================================

/**
 * Communication channel types.
 */
export type CommunicationChannel = 'email' | 'sms' | 'social' | 'chat' | 'other';

/**
 * Controls for COMMUNICATE action type.
 */
export interface CommunicationControls {
    /** Allowed communication channels */
    allowedChannels: CommunicationChannel[];

    /** Allowed recipient domains (e.g., "@company.com") - empty means any */
    allowedRecipientDomains: string[];

    /** Blocked recipients (email, phone, username patterns) */
    blockedRecipients: string[];

    /** Auto-approve replies to existing threads */
    autoApproveReplies: boolean;

    /** Maximum messages per hour (rate limit) */
    maxMessagesPerHour: number;
}

/**
 * Commitment types for COMMIT action.
 */
export type CommitmentType = 'terms_of_service' | 'subscription' | 'booking' | 'trial' | 'agreement' | 'other';

/**
 * Controls for COMMIT action type.
 */
export interface CommitmentControls {
    /** Allowed commitment types */
    allowedCommitmentTypes: CommitmentType[];

    /** Auto-approve free trials (no financial implication) */
    autoApproveFreeTrials: boolean;

    /** Max auto-approve financial implication (USD) - above requires hard_confirm */
    maxAutoApproveImplication: number;

    /** Require commitments to be revocable */
    requireRevocable: boolean;

    /** Blocked counterparties */
    blockedCounterparties: string[];
}

/**
 * Data types for SHARE_DATA action.
 */
export type ShareDataType = 'medical' | 'financial' | 'identity' | 'contacts' | 'documents' | 'browsing' | 'credentials' | 'other';

/**
 * Controls for SHARE_DATA action type.
 */
export interface DataSharingControls {
    /** Allowed data types to share */
    allowedDataTypes: ShareDataType[];

    /** BLOCKED data types (never auto-approve, hard block) */
    blockedDataTypes: ShareDataType[];

    /** Allowed data recipients */
    allowedRecipients: string[];

    /** Require data to be recoverable (deletable after sharing) */
    requireRecoverable: boolean;
}

/**
 * Complete spending policy for an agent.
 */
export interface SpendingPolicy {
    /** Policy ID (UUID) */
    id: string;

    /** Agent this policy applies to */
    agentId: string;

    /** Human-readable name for this policy */
    name: string;

    /** Description */
    description?: string;

    /** Spending limits */
    limits: SpendingLimits;

    /** Category controls */
    categories: CategoryControls;

    /** Merchant controls */
    merchants: MerchantControls;

    /** Rail controls */
    rails: RailControls;

    /** Schedule controls */
    schedule: ScheduleControls;

    /** Friction thresholds */
    friction: FrictionThresholds;

    /** Capabilities */
    capabilities: AgentCapabilities;

    // Non-financial action controls (undefined = ALWAYS_CONFIRM)

    /** Communication controls (undefined = always require hard_confirm) */
    communication?: CommunicationControls;

    /** Commitment controls (undefined = always require hard_confirm) */
    commitments?: CommitmentControls;

    /** Data sharing controls (undefined = always require hard_confirm) */
    dataSharing?: DataSharingControls;

    /** Card access mode: how the agent accesses payment methods */
    cardAccessMode: CardAccessMode;

    /** Crypto spending controls (undefined = use defaults from CryptoSpendingGovernance) */
    cryptoControls?: import('./CryptoSpendingGovernance').CryptoSpendingControls;

    /** Policy status */
    status: PolicyStatus;

    /** Creation timestamp */
    createdAt: number;

    /** Last update timestamp */
    updatedAt: number;
}

/**
 * Policy evaluation result.
 */
export interface PolicyEvaluation {
    /** Whether the request passed policy checks */
    passed: boolean;

    /** Specific violations (if any) */
    violations: PolicyViolation[];

    /** Warnings (not blocking, but notable) */
    warnings: string[];

    /** Suggested friction lane */
    suggestedLane: FrictionLane;

    /** Risk score (0-100) */
    riskScore: number;

    /** Remaining limits after this transaction */
    remainingLimits: {
        daily: number;
        weekly: number;
        monthly: number;
        perTransaction?: number;
    };
}

/**
 * Policy violation detail.
 */
export interface PolicyViolation {
    /** Violation type */
    type:
        | 'limit_exceeded'
        | 'category_blocked'
        | 'merchant_blocked'
        | 'schedule_violation'
        | 'capability_denied'
        | 'credential_not_allowed'
        | 'action_type_not_allowed'
        | 'system_error'
        // Non-financial action violations
        | 'communication_channel_blocked'
        | 'communication_recipient_blocked'
        | 'communication_rate_exceeded'
        | 'commitment_type_blocked'
        | 'commitment_non_revocable'
        | 'commitment_counterparty_blocked'
        | 'data_type_blocked'
        | 'data_recipient_blocked'
        | 'data_non_recoverable';

    /** Human-readable message */
    message: string;

    /** Additional details */
    details?: Record<string, unknown>;
}

/**
 * Policy usage tracking.
 */
export interface PolicyUsage {
    /** Policy ID */
    policyId: string;

    /** Agent ID */
    agentId: string;

    /** Daily usage by date key (YYYY-MM-DD -> amount) */
    dailyUsage: Record<string, number>;

    /** Weekly usage by week key (YYYY-Www -> amount) */
    weeklyUsage: Record<string, number>;

    /** Monthly usage by month key (YYYY-MM -> amount) */
    monthlyUsage: Record<string, number>;

    /** Last transaction timestamp */
    lastTransactionAt?: number;

    /** Total transaction count */
    transactionCount: number;
}

/**
 * Default policy template.
 */
export const DEFAULT_POLICY_TEMPLATE: Omit<SpendingPolicy, 'id' | 'agentId' | 'name' | 'createdAt' | 'updatedAt'> = {
    limits: {
        perTransaction: 100,
        daily: 250,
        weekly: 1000,
        monthly: 3000,
    },
    categories: {
        allowed: [],
        blocked: DEFAULT_BLOCKED_CATEGORIES,
        mode: 'blocklist',
    },
    merchants: {
        allowlist: [],
        blocklist: [],
        mode: 'any',
    },
    rails: {
        allowedCredentialIds: [],
    },
    schedule: {
        activeHours: { start: 0, end: 23 },
        activeDays: [0, 1, 2, 3, 4, 5, 6],
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles',
    },
    friction: {
        autoApproveBelow: 25,
        softConfirmBelow: 100,
    },
    capabilities: {
        canCreatePromises: true,
        canSpendFiat: true,
        // Agents do not spend the human's on-device crypto wallet. Off at BOTH the
        // flag level AND the action-type level (allowedActionTypes carries no crypto
        // types) so the two can't drift into disagreement. The human WalletConnect
        // owner policy sets its own canSpendCrypto:true in WalletConnectGovernance
        // and is unaffected.
        canSpendCrypto: false,
        allowedActionTypes: ['purchase', 'subscription', 'api_usage'],
        // Non-financial actions default to ALWAYS_CONFIRM (false = no auto-approve)
        canCommunicate: false,
        canCommit: false,
        canShareData: false,
    },
    // Non-financial controls undefined = ALWAYS_CONFIRM
    communication: undefined,
    commitments: undefined,
    dataSharing: undefined,
    // Crypto controls undefined = use defaults from CryptoSpendingGovernance
    cryptoControls: undefined,
    cardAccessMode: 'provian_holds',
    status: 'active',
};
