/**
 * Spend-request types shared by the crypto-governance pipeline.
 *
 * Extracted VERBATIM from the (removed) AgentAuthorizationGate so the human
 * WalletConnect signing path keeps the exact request shape the pipeline was
 * written against (wallet simplification U2, relocated as-is).
 */

export type AgentSpendActionType =
    | 'purchase' | 'subscription' | 'api_usage' | 'transfer' | 'swap' | 'sign' | 'approve' | 'other'
    // Non-financial action types
    | 'communicate' | 'commit' | 'share_data';

export interface AgentSpendRequest {
    agentId: string;
    actionType: AgentSpendActionType;
    merchant: string;
    amount: number;
    currency: string;
    purpose: string;
    counterparty?: string;  // [Fix 1] Destination address for transfers/approves
    metadata?: Record<string, unknown>;
    /** If this action is part of a goal envelope, the goal ID */
    goal_id?: string;
}

// ============================================================================
// NON-FINANCIAL ACTION METADATA
// ============================================================================
// Typed metadata for non-financial action types (communicate, commit, share_data).
// These provide structured context for policy evaluation and provenance tracking.
// ============================================================================

/**
 * Metadata for COMMUNICATE action type.
 * Sending email, message, social post, etc. as the user.
 */
export interface CommunicateActionMetadata {
    /** Communication channel */
    channel: 'email' | 'sms' | 'social' | 'chat' | 'other';

    /** Recipient identifier (email, phone, username, etc.) */
    recipient: string;

    /** Subject line (for email) */
    subject?: string;

    /** Preview of content being sent */
    contentPreview: string;

    /** Platform name (e.g., "Gmail", "Slack", "Twitter") */
    platform?: string;

    /** Whether this is a reply to an existing thread */
    isReply: boolean;
}

/**
 * Metadata for COMMIT action type.
 * Accepting terms, signing up, booking, agreeing to anything.
 */
export interface CommitActionMetadata {
    /** Type of commitment */
    commitmentType: 'terms_of_service' | 'subscription' | 'booking' | 'trial' | 'agreement' | 'other';

    /** Who the user is committing to */
    counterparty: string;

    /** Human-readable description of what is being committed to */
    description: string;

    /** Whether the commitment can be revoked/cancelled */
    isRevocable: boolean;

    /** Financial implication if any */
    financialImplication?: {
        amount: number;
        currency: string;
        timing: string;  // e.g., "monthly", "one-time", "after trial"
    };

    /** When the commitment expires (if applicable) */
    expiresAt?: number;
}

/**
 * Metadata for SHARE_DATA action type.
 * Sharing or exporting user data to a third party.
 */
export interface ShareDataActionMetadata {
    /** Type of data being shared */
    dataType: 'medical' | 'financial' | 'identity' | 'contacts' | 'documents' | 'browsing' | 'credentials' | 'other';

    /** Who the data is being shared with */
    recipient: string;

    /** Human-readable description of what data */
    description: string;

    /** Number of items being shared (if applicable) */
    itemCount?: number;

    /** Whether the data can be recovered/deleted after sharing */
    isRecoverable: boolean;
}

/**
 * Helper type guard: check if action is non-financial
 */
export function isNonFinancialAction(actionType: AgentSpendActionType): boolean {
    return actionType === 'communicate' || actionType === 'commit' || actionType === 'share_data';
}
