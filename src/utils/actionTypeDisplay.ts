import { translate } from '../i18n/translate';
/**
 * Action Type Display Utility
 *
 * Maps known PE action_types to human-readable labels, Ionicons names, and colors.
 * Unknown action_types get a sensible fallback: generic icon, formatted label.
 *
 * Used by TransactionHistoryScreen, TransactionDetailScreen, EnvelopeDetailScreen,
 * and ActivityLogScreen.
 */

import type { IoniconsName } from '../types/icons';
import { COLORS } from '../constants/theme';

export interface ActionTypeDisplay {
    /** Ionicons icon name. Typed (not `string`) so tsc validates every entry
     * below AND so consumers can pass it straight to <Ionicons name={...}>
     * without a cast —. */
    icon: IoniconsName;
    /** Emoji icon (for activity log style rendering) */
    emoji: string;
    /** Human-readable label */
    label: string;
    /** Theme color */
    color: string;
}

/**
 * Known action_type → display config.
 * Covers wallet transactions, agent actions, credentials, governance,
 * commons, court, PVT, escrow, promises, pools, jobs, and more.
 */
const ACTION_TYPE_MAP: Record<string, ActionTypeDisplay> = {
    // Wallet transactions
    send: { icon: 'arrow-up', emoji: '\u2197\uFE0F', label: 'Send', color: COLORS.error },
    receive: { icon: 'arrow-down', emoji: '\u2198\uFE0F', label: 'Receive', color: COLORS.success },
    swap: { icon: 'swap-horizontal', emoji: '\uD83D\uDD04', label: 'Swap', color: COLORS.secondary },
    stake: { icon: 'layers', emoji: '\uD83D\uDCB0', label: 'Stake', color: COLORS.primary },
    unstake: { icon: 'layers-outline', emoji: '\uD83D\uDCB0', label: 'Unstake', color: COLORS.primary },
    approve: { icon: 'checkmark-circle', emoji: '\u2705', label: 'Approve', color: COLORS.success },
    // Incoming PVT mint (issuance). Keyed 'earned' to match Transaction.type
    // exactly (unlike send/receive above, whose keys differ from 'sent'/'received').
    earned: { icon: 'diamond', emoji: '\ud83d\udc8e', label: 'Earned', color: COLORS.success },

    // Agent actions
    agent_authorization: { icon: 'hardware-chip', emoji: '\uD83E\uDD16', label: 'Proof event', color: COLORS.primary },
    agent_action: { icon: 'cog', emoji: '\u2699\uFE0F', label: 'Agent Action', color: COLORS.secondary },
    agent_communicate: { icon: 'chatbubble', emoji: '\uD83D\uDCAC', label: 'Communication', color: '#6BA3F0' },
    agent_commit: { icon: 'calendar', emoji: '\uD83D\uDCC5', label: 'Commitment', color: COLORS.secondary },
    agent_share_data: { icon: 'share', emoji: '\uD83D\uDCE4', label: 'Data Shared', color: '#EF4444' },
    agent_authorized: { icon: 'shield-checkmark', emoji: '\uD83D\uDEE1\uFE0F', label: 'Proof event', color: COLORS.success },

    // Credentials
    credential_added: { icon: 'card', emoji: '\uD83D\uDCB3', label: 'Proof event', color: COLORS.success },
    credential_updated: { icon: 'create', emoji: '\u270F\uFE0F', label: 'Proof event', color: COLORS.primary },
    credential_frozen: { icon: 'snow', emoji: '\u2744\uFE0F', label: 'Proof event', color: COLORS.warning },
    credential_deleted: { icon: 'trash', emoji: '\uD83D\uDDD1\uFE0F', label: 'Proof event', color: COLORS.error },
    credential_released: { icon: 'lock-open', emoji: '\uD83D\uDD13', label: 'Proof event', color: COLORS.warning },
    credential_injected: { icon: 'download', emoji: '\uD83D\uDCE5', label: 'Proof event', color: COLORS.success },

    // Agent sessions — LEGACY records only: relay agent sessions were retired.
    agent_session_started: { icon: 'link', emoji: '\uD83D\uDD17', label: 'Proof event', color: COLORS.success },
    agent_session_suspended: { icon: 'pause', emoji: '\u23F8\uFE0F', label: 'Proof event', color: COLORS.warning },
    agent_session_revoked: { icon: 'close-circle', emoji: '\u274C', label: 'Proof event', color: COLORS.error },

    // Policy — LEGACY records from the retired agent-authorization gate.
    policy_created: { icon: 'document-text', emoji: '\uD83D\uDCDC', label: 'Proof event', color: COLORS.primary },
    policy_updated: { icon: 'document', emoji: '\uD83D\uDCDD', label: 'Proof event', color: COLORS.primary },

    // Friction & emergency — LEGACY records from the retired agent gate.
    friction_escalation: { icon: 'warning', emoji: '\u26A0\uFE0F', label: 'Proof event', color: COLORS.warning },
    emergency_stop: { icon: 'hand-left', emoji: '\uD83D\uDED1', label: 'Proof event', color: COLORS.error },

    // Request lifecycle
    request_expired: { icon: 'hourglass', emoji: '\u23F3', label: 'Request Expired', color: COLORS.textSecondary },
    request_auto_approved: { icon: 'flash', emoji: '\u26A1', label: 'Proof event', color: COLORS.success },

    // Agent transactions
    agent_transaction_reported: { icon: 'receipt', emoji: '\uD83D\uDCE9', label: 'Agent Purchase', color: COLORS.warning },
    agent_transaction_synced: { icon: 'checkmark-done', emoji: '\u2705', label: 'Synced', color: COLORS.success },

    // Wallet setup
    wallet_created: { icon: 'wallet', emoji: '\uD83D\uDCB3', label: 'Wallet Created', color: COLORS.success },
    device_register: { icon: 'phone-portrait', emoji: '\uD83D\uDCF1', label: 'Device Registered', color: COLORS.primary },

    // Genesis fixed grants
    genesis_human_signup: { icon: 'gift', emoji: '\uD83C\uDF81', label: 'Genesis Signup Grant', color: COLORS.success },
    genesis_signup: { icon: 'gift', emoji: '\uD83C\uDF81', label: 'Genesis Agent Grant', color: COLORS.success },
    genesis_device_link: { icon: 'gift', emoji: '\uD83C\uDF81', label: 'Genesis Device Grant', color: COLORS.success },

    // Beneficiary links
    agent_linked: { icon: 'link', emoji: '\uD83D\uDD17', label: 'Agent Linked', color: COLORS.primary },
    agent_linked_to_human: { icon: 'link', emoji: '\uD83D\uDD17', label: 'Linked to You', color: COLORS.primary },
    human_linked_agent: { icon: 'link', emoji: '\uD83D\uDD17', label: 'Agent Linked', color: COLORS.primary },

    // Promises
    promise_created: { icon: 'heart', emoji: '\uD83E\uDD1D', label: 'Promise Created', color: COLORS.primary },
    promise_accepted: { icon: 'heart-circle', emoji: '\u2705', label: 'Promise Accepted', color: COLORS.success },
    promise_fulfilled: { icon: 'checkmark-circle', emoji: '\uD83C\uDF89', label: 'Promise Fulfilled', color: COLORS.success },
    promise_broken: { icon: 'heart-dislike', emoji: '\uD83D\uDC94', label: 'Promise Broken', color: COLORS.error },
    promise_offered: { icon: 'paper-plane', emoji: '\uD83D\uDCE8', label: 'Promise Offered', color: COLORS.primary },
    promise_countered: { icon: 'swap-horizontal', emoji: '\uD83D\uDD01', label: 'Promise Countered', color: COLORS.secondary },
    promise_settled: { icon: 'checkmark-done-circle', emoji: '\u2705', label: 'Promise Settled', color: COLORS.success },
    promise_disputed: { icon: 'alert-circle', emoji: '\u26A0\uFE0F', label: 'Promise Disputed', color: COLORS.warning },
    promise_defaulted: { icon: 'heart-dislike', emoji: '\uD83D\uDC94', label: 'Promise Defaulted', color: COLORS.error },

    // Goal envelopes — LEGACY records; the goal-envelope sandbox was retired.
    goal_envelope_approved: { icon: 'flag', emoji: '\uD83C\uDFF3\uFE0F', label: 'Proof event', color: COLORS.success },
    goal_envelope_rejected: { icon: 'flag-outline', emoji: '\u274C', label: 'Proof event', color: COLORS.error },
    goal_action_taken: { icon: 'navigate', emoji: '\uD83C\uDFAF', label: 'Proof event', color: COLORS.primary },

    // Escrow
    escrow_created: { icon: 'lock-closed', emoji: '\uD83D\uDD12', label: 'Escrow Created', color: COLORS.primary },
    escrow_funded: { icon: 'cash', emoji: '\uD83D\uDCB0', label: 'Escrow Funded', color: COLORS.success },
    escrow_completed: { icon: 'checkmark-done-circle', emoji: '\u2705', label: 'Escrow Completed', color: COLORS.success },
    escrow_disputed: { icon: 'alert-circle', emoji: '\u26A0\uFE0F', label: 'Escrow Disputed', color: COLORS.warning },
    escrow_resolved: { icon: 'hammer', emoji: '\u2696\uFE0F', label: 'Escrow Resolved', color: COLORS.primary },

    // Court
    court_panel_assigned: { icon: 'people', emoji: '\uD83D\uDC65', label: 'Court Panel Assigned', color: COLORS.primary },
    court_vote_cast: { icon: 'hand-right', emoji: '\uD83D\uDDF3\uFE0F', label: 'Court Vote Cast', color: COLORS.primary },
    court_verdict: { icon: 'hammer', emoji: '\u2696\uFE0F', label: 'Court Verdict', color: COLORS.success },
    court_escalated: { icon: 'trending-up', emoji: '\u26A0\uFE0F', label: 'Court Escalated', color: COLORS.warning },

    // PVT
    pvt_batch_minted: { icon: 'diamond', emoji: '\uD83D\uDC8E', label: 'PVT Minted', color: COLORS.success },
    pvt_burned_voluntary: { icon: 'flame', emoji: '\uD83D\uDD25', label: 'PVT Burned', color: COLORS.error },
    pvt_reputation_staked: { icon: 'ribbon', emoji: '\uD83C\uDFC5', label: 'Proof event', color: COLORS.primary },
    pvt_reputation_slashed: { icon: 'trending-down', emoji: '\u26A0\uFE0F', label: 'Proof event', color: COLORS.error },

    // Governance
    governance_proposal_created: { icon: 'megaphone', emoji: '\uD83D\uDCE3', label: 'Proposal Created', color: COLORS.primary },
    governance_vote_cast: { icon: 'hand-right', emoji: '\uD83D\uDDF3\uFE0F', label: 'Vote Cast', color: COLORS.primary },
    governance_proposal_executed: { icon: 'checkmark-done', emoji: '\u2705', label: 'Proposal Executed', color: COLORS.success },

    // Agent self-signup
    agent_wallet_created: { icon: 'wallet', emoji: '\uD83E\uDD16', label: 'Agent Wallet Created', color: COLORS.success },
    badge_earned: { icon: 'ribbon', emoji: '\uD83C\uDFC5', label: 'Badge Earned', color: COLORS.secondary },

    // Jobs
    job_posted: { icon: 'briefcase', emoji: '\uD83D\uDCBC', label: 'Job Posted', color: COLORS.primary },
    job_applied: { icon: 'document-attach', emoji: '\uD83D\uDCDD', label: 'Job Applied', color: COLORS.primary },
    job_accepted: { icon: 'checkmark-circle', emoji: '\u2705', label: 'Job Accepted', color: COLORS.success },
    job_delivered: { icon: 'gift', emoji: '\uD83C\uDF81', label: 'Job Delivered', color: COLORS.success },

    // Human jobs
    human_job_posted: { icon: 'briefcase', emoji: '\uD83D\uDCBC', label: 'Human Job Posted', color: COLORS.primary },
    human_job_accepted: { icon: 'checkmark-circle', emoji: '\u2705', label: 'Human Job Accepted', color: COLORS.success },
    human_job_completed: { icon: 'trophy', emoji: '\uD83C\uDFC6', label: 'Human Job Completed', color: COLORS.success },
    human_approval: { icon: 'checkmark-done-circle', emoji: '\uD83D\uDC4D', label: 'Human Approval', color: COLORS.success },

    // Commons
    commons_profile_created: { icon: 'person-add', emoji: '\uD83D\uDC64', label: 'Profile Created', color: COLORS.primary },
    commons_pe_published: { icon: 'globe', emoji: '\uD83C\uDF10', label: 'PE Published', color: COLORS.primary },
    commons_post_created: { icon: 'create', emoji: '\uD83D\uDCDD', label: 'Forum Post', color: COLORS.primary },
    commons_post_replied: { icon: 'chatbubble', emoji: '\uD83D\uDCAC', label: 'Forum Reply', color: COLORS.primary },
    commons_vote_cast: { icon: 'arrow-up-circle', emoji: '\u2B06\uFE0F', label: 'Vote Cast', color: COLORS.secondary },
    commons_post_flagged: { icon: 'flag', emoji: '\uD83D\uDEA9', label: 'Post Flagged', color: COLORS.warning },
    commons_claim_challenged: { icon: 'help-circle', emoji: '\u2753', label: 'Claim Questioned', color: COLORS.warning },
    commons_challenge_answered: { icon: 'ribbon', emoji: '\uD83C\uDFC5', label: 'Challenge Answered', color: COLORS.success },
    commons_challenge_resolved: { icon: 'checkmark-done', emoji: '\u2705', label: 'Challenge Resolved', color: COLORS.textSecondary },
    commons_thread_message: { icon: 'chatbubble-ellipses', emoji: '\uD83D\uDCAC', label: 'Thread Message', color: COLORS.secondary },
    commons_featured_placement: { icon: 'star', emoji: '\u2B50', label: 'Featured Placement', color: COLORS.warning },
    want_posted: { icon: 'megaphone', emoji: '\uD83D\uDCE3', label: 'Want Posted', color: COLORS.primary },
    want_fulfilled: { icon: 'checkmark-circle', emoji: '\u2705', label: 'Want Fulfilled', color: COLORS.success },
    want_cancelled: { icon: 'close-circle', emoji: '\u274C', label: 'Want Cancelled', color: COLORS.textTertiary },
    commons_vouch_given: { icon: 'thumbs-up', emoji: '\uD83D\uDC4D', label: 'Vouch Given', color: COLORS.success },

    // x402
    x402_payment: { icon: 'flash', emoji: '\u26A1', label: 'x402 Payment', color: COLORS.secondary },
    link_spend: { icon: 'card-outline', emoji: '\uD83D\uDED2', label: 'Link Purchase', color: COLORS.secondary },

    // Delegation
    agent_work_delegated: { icon: 'git-branch-outline', emoji: '\u21B3', label: 'Proof event', color: '#7C9FE0' },

    // Replication / corroboration
    replication_pack: { icon: 'copy', emoji: '\uD83D\uDD2C', label: 'Replication Pack', color: COLORS.primary },
    corroboration_signal: { icon: 'checkmark-done', emoji: '\uD83E\uDD1D', label: 'Corroboration', color: COLORS.success },

    // Egress
    egress_data: { icon: 'cloud-upload', emoji: '\u2601\uFE0F', label: 'Egress Data', color: COLORS.warning },

    // Relay authorization-request types. These are the request families
    // an agent asks the phone to approve; AgentAuthorizationScreen rendered them
    // from a PRIVATE `typeConfig` map and fell back to `actionType.toUpperCase()`
    // for anything it lacked, so an unmapped type reached the user raw
    // ("SHARE_DATA"). Icon/color/label below are carried over verbatim from that
    // local map, so the three it styled look identical; the rest now reach
    // formatActionType instead of the raw string.
    communicate: { icon: 'chatbubbles', emoji: '\uD83D\uDCAC', label: 'Message', color: '#6BA3F0' },
    commit: { icon: 'calendar', emoji: '\uD83D\uDCC5', label: 'Commitment', color: '#E8A838' },
    share_data: { icon: 'share-social', emoji: '\uD83D\uDCE4', label: 'Data Sharing', color: COLORS.error },
    public_post: { icon: 'megaphone', emoji: '\uD83D\uDCE2', label: 'Social Post', color: COLORS.primary },
    // COLOUR ENCODES RISK for this family, because every surface that
    // renders these is an approval or governance surface. `system_access` was
    // green in one table and red in another; green actively miscommunicates the
    // highest-risk request family there is, so red wins. `uncategorized` was a
    // calm grey ellipsis; "Unknown = Block, Not Warn" is a core invariant, so it
    // is an amber question mark.
    system_access: { icon: 'terminal', emoji: '\uD83D\uDCBB', label: 'System Access', color: COLORS.error },
    uncategorized: { icon: 'help-circle', emoji: '\u2753', label: 'Action', color: COLORS.warning },

    // Compute & work \u2014 the AI-engagement and developer-work families that
    // dominate a contributor's PE history. Absent before this, they fell to the
    // generic document icon / a raw underscored label; every type here now renders.
    ai_conversation: { icon: 'chatbubbles', emoji: '\uD83D\uDCAC', label: 'AI Conversation', color: COLORS.secondary },
    coding_session: { icon: 'code-slash', emoji: '\u2328\uFE0F', label: 'Coding Session', color: COLORS.primary },
    'service:github_commit': { icon: 'git-commit', emoji: '\uD83D\uDD17', label: 'GitHub Commit', color: COLORS.primary },
    'service:github_pr_merged': { icon: 'git-merge', emoji: '\uD83D\uDD00', label: 'PR Merged', color: COLORS.success },
    'service:gitlab_push': { icon: 'git-commit', emoji: '\uD83D\uDD17', label: 'GitLab Push', color: COLORS.primary },
    'service:gitlab_mr_merged': { icon: 'git-merge', emoji: '\uD83D\uDD00', label: 'MR Merged', color: COLORS.success },
    'service:bitbucket_push': { icon: 'git-commit', emoji: '\uD83D\uDD17', label: 'Bitbucket Push', color: COLORS.primary },
    'service:bitbucket_pr_merged': { icon: 'git-merge', emoji: '\uD83D\uDD00', label: 'PR Merged', color: COLORS.success },
    refactor: { icon: 'construct', emoji: '\uD83D\uDD27', label: 'Refactor', color: COLORS.secondary },
    test_run: { icon: 'flask', emoji: '\uD83E\uDDEA', label: 'Test Run', color: COLORS.secondary },
    deployment: { icon: 'rocket', emoji: '\uD83D\uDE80', label: 'Deployment', color: COLORS.success },
    research: { icon: 'search', emoji: '\uD83D\uDD2C', label: 'Research', color: COLORS.primary },
    document: { icon: 'document-text', emoji: '\uD83D\uDCC4', label: 'Document', color: COLORS.primary },
    compute_session: { icon: 'hardware-chip', emoji: '\uD83D\uDDA5\uFE0F', label: 'Compute Session', color: COLORS.secondary },
    inference_session: { icon: 'sparkles', emoji: '\u2728', label: 'Inference', color: COLORS.secondary },

    // Agent work product (compute category, per-type subfamilies)
    agent_work_product: { icon: 'construct', emoji: '\uD83D\uDEE0\uFE0F', label: 'Work Product', color: COLORS.primary },
    agent_work_product_code: { icon: 'code-slash', emoji: '\u2328\uFE0F', label: 'Code', color: COLORS.primary },
    agent_work_product_analysis: { icon: 'analytics', emoji: '\uD83D\uDCCA', label: 'Analysis', color: COLORS.primary },
    agent_work_product_data: { icon: 'server', emoji: '\uD83D\uDDC4\uFE0F', label: 'Data Work', color: COLORS.primary },
    agent_work_product_design: { icon: 'color-palette', emoji: '\uD83C\uDFA8', label: 'Design', color: COLORS.primary },
    agent_work_product_document: { icon: 'document-text', emoji: '\uD83D\uDCC4', label: 'Document', color: COLORS.primary },
    agent_work_product_research: { icon: 'search', emoji: '\uD83D\uDD2C', label: 'Research', color: COLORS.primary },
    agent_work_product_other: { icon: 'cube', emoji: '\uD83D\uDCE6', label: 'Work Product', color: COLORS.primary },

    // Agent work (observer / orchestration families)
    agent_task_completed: { icon: 'checkmark-done', emoji: '\u2705', label: 'Task Completed', color: COLORS.success },
    agent_tool_orchestration: { icon: 'build', emoji: '\uD83D\uDD27', label: 'Tool Orchestration', color: COLORS.secondary },
    agent_api_orchestration: { icon: 'git-network', emoji: '\uD83D\uDD0C', label: 'API Orchestration', color: COLORS.secondary },
    agent_public_post: { icon: 'megaphone', emoji: '\uD83D\uDCE3', label: 'Public Post', color: COLORS.primary },
    agent_token_transfer: { icon: 'arrow-up', emoji: '\u2197\uFE0F', label: 'Token Transfer', color: COLORS.primary },
    agent_native_transfer: { icon: 'arrow-up', emoji: '\u2197\uFE0F', label: 'Transfer', color: COLORS.primary },
    agent_token_swap: { icon: 'swap-horizontal', emoji: '\uD83D\uDD04', label: 'Token Swap', color: COLORS.secondary },

    // Human jobs (delivery)
    human_job_applied: { icon: 'hand-right', emoji: '\u270B', label: 'Applied to Job', color: COLORS.primary },
    human_job_delivered: { icon: 'cube', emoji: '\uD83D\uDCE6', label: 'Job Delivered', color: COLORS.success },

    // Environment attestation
    environment_attestation: { icon: 'shield-checkmark', emoji: '\uD83D\uDEE1\uFE0F', label: 'Environment Attestation', color: COLORS.primary },
};

/**
 * Every action_type this map knows. Exported ONLY so the structural guard
 * can recognise a per-screen redeclaration of the map WITHOUT keeping its own
 * copy of the key list — the "self-referential control" trap named in CLAUDE.md
 * (a detector matched against its own private fixture proves nothing about the
 * source the app actually reads). Derived, never hand-maintained: a key added
 * above is in this set on the next import, with no second place to update.
 */
export const KNOWN_ACTION_TYPES: ReadonlySet<string> = new Set(Object.keys(ACTION_TYPE_MAP));

/**
 * Acronyms/brands that must not be naively title-cased in a fallback label.
 * Keyed by the lowercased token as it appears in an action_type.
 */
const LABEL_ACRONYMS: Record<string, string> = {
    ai: 'AI', pvt: 'PVT', pe: 'PE', pr: 'PR', nft: 'NFT', kyc: 'KYC',
    usdc: 'USDC', usdt: 'USDT', dai: 'DAI', eth: 'ETH', sol: 'SOL',
    id: 'ID', url: 'URL', api: 'API', http: 'HTTP', x402: 'x402',
    github: 'GitHub', p2p: 'P2P', evm: 'EVM', dex: 'DEX', defi: 'DeFi',
    tee: 'TEE', llm: 'LLM', ipfs: 'IPFS',
};

/**
 * Format an unknown action_type into a human-readable label — the LAST-RESORT
 * fallback for a type with no entry in ACTION_TYPE_MAP. A raw namespaced or
 * underscored internal string must NEVER reach the UI (item #2): this
 * drops any leading namespace segment (`service:github_commit` → `github_commit`),
 * splits on `_`/`-`/space, and title-cases each word with an acronym dictionary
 * (so `ai_conversation` → "AI Conversation", not "Ai Conversation", and
 * `service:github_commit` → "GitHub Commit", never "Service:github Commit").
 */
export function formatActionType(actionType: string): string {
    if (!actionType) return translate('actionTypes.unknown', 'Unknown Action');
    // Drop a leading namespace segment so "service:x" never leaks its prefix.
    const withoutNamespace = actionType.includes(':')
        ? actionType.slice(actionType.indexOf(':') + 1)
        : actionType;
    const label = withoutNamespace
        .split(/[_\-\s]+/)
        .filter(Boolean)
        .map((word) => {
            const lower = word.toLowerCase();
            return LABEL_ACRONYMS[lower] ?? (word.charAt(0).toUpperCase() + lower.slice(1));
        })
        .join(' ');
    return label || translate('actionTypes.unknown', 'Unknown Action');
}

/**
 * Get display config for any action_type.
 * Known types get specific icons/labels/colors.
 * Unknown types get a generic icon and a formatted label.
 */
export function getActionTypeDisplay(actionType: string): ActionTypeDisplay {
    const known = ACTION_TYPE_MAP[actionType];
    if (known) return { ...known, label: translate(`actionTypes.labels.${actionType.replace(/:/g, '_')}`, known.label) };

    return {
        icon: 'document-outline',
        emoji: '\uD83D\uDCCB',
        label: formatActionType(actionType),
        color: COLORS.textSecondary,
    };
}

/**
 * Get an Ionicons name for a transaction type (used by history screens).
 * Falls back to 'document-outline' for unknown types.
 */
export function getTransactionIcon(type: string): string {
    return getActionTypeDisplay(type).icon;
}

/**
 * Get a color for a transaction type (used by history screens).
 * Falls back to COLORS.textSecondary for unknown types.
 */
export function getTransactionColor(type: string): string {
    return getActionTypeDisplay(type).color;
}

/**
 * Get a human-readable label for a transaction type.
 * Falls back to formatted action_type for unknown types.
 */
export function getTransactionLabel(type: string): string {
    return getActionTypeDisplay(type).label;
}

/**
 * Top-level "What are Provenance Envelopes?" copy — the entry point surfaced on
 * the detail screen for the generic case.
 */
export const PROVENANCE_ENVELOPE_OVERVIEW =
    'A Provenance Envelope (PE) is signed, tamper-evident proof of something you '
    + 'did — a wallet action, a conversation with an AI, a code commit, a promise. '
    + 'Each PE is hash-chained to the one before it, so your proof cannot be quietly '
    + 'altered. Every act of work mints PVT once at its best-supported value. The chip '
    + 'on each entry shows its mint disposition.';

/**
 * Plain-language "what is this?" copy per action_type (item #7), keyed to
 * the canonical map. Copy for the compute/AI-engagement and commit families is
 * adapted from the onboarding narrative (en.json chat_capture / device-witness
 * sections); the rest is authored here. A type with no entry falls back to
 * PROVENANCE_ENVELOPE_OVERVIEW via getActionTypeDescription().
 */
const ACTION_TYPE_DESCRIPTION: Record<string, string> = {
    ai_conversation:
        "A record that you had a conversation with an AI assistant (Claude, ChatGPT, Gemini, and others). It is content-free: Provian records the provider, the session timing, and approximate turn counts - never your messages. Every witnessed act of work mints PVT once at its best-supported value.",
    coding_session:
        'A record of a stretch of coding work witnessed on your device — which tools '
        + 'ran and for how long. Capture is content-free: your code and its contents are '
        + 'never read or uploaded.',
    'service:github_commit':
        'A code commit witnessed through your connected GitHub account. Provian records '
        + 'the commit reference and that it happened, as proof of the work — not the code '
        + 'itself.',
    'service:github_pr_merged':
        'A pull request of yours was merged on GitHub — a recorded outcome of delivered '
        + 'work, witnessed through your connected account.',
    corroboration_signal:
        'An independent, automated second witness to another PE — for example, GitHub '
        + 'confirming a commit your device already recorded. Corroboration strengthens the '
        + 'evidence behind the original record; it does not create a separate earning.',
    replication_pack:
        'A reproducible bundle — inputs, outputs, and the model used — that lets anyone '
        + 'independently re-run and verify your work. Valid replication raises the '
        + 'evidence tier and value of the work it verifies.',
    coding_session_summary:
        'A summary of a coding session witnessed on your device. Content-free.',
    compute_session:
        'A record that a compute workload ran on your device — which runtime, for how '
        + 'long. Content-free presence, not the work itself.',
    inference_session:
        'A record that an AI inference workload ran — a model produced output. Recorded '
        + 'as proof of compute contributed.',
    refactor: 'A record of a code-refactoring task, witnessed on your device. Content-free.',
    test_run: 'A record that a test suite was run as part of your development work.',
    deployment: 'A record that you deployed software — a shipped outcome of your work.',
    research: 'A record of research work you carried out.',
    document: 'A record that you authored or edited a document.',
    agent_work_product:
        'A record of a work product an agent produced on your behalf — the artifact of a '
        + 'completed task.',
    agent_work_product_code: 'Code produced by an agent as the artifact of a completed task.',
    agent_work_product_analysis: 'An analysis produced by an agent as a completed work product.',
    agent_work_product_data: 'A data artifact produced by an agent as a completed work product.',
    agent_work_product_design: 'A design produced by an agent as a completed work product.',
    agent_work_product_document: 'A document produced by an agent as a completed work product.',
    agent_work_product_research: 'Research produced by an agent as a completed work product.',
    agent_work_product_other: 'A work product produced by an agent.',
    wallet_created:
        'The moment your wallet was created — its birth certificate in the provenance '
        + 'chain, and the first link everything else chains from.',
    device_register:
        'A record that this physical device was registered to your wallet. Recorded for '
        + 'provenance; it does not itself earn.',
    credential_added: 'A proof event from this identity’s history.',
    credential_released:
        'A proof event from this identity’s history.',
    send: 'An on-chain transfer you sent from your wallet.',
    receive: 'An on-chain transfer your wallet received.',
    swap: 'A token swap you made from your wallet.',
    x402_payment:
        'An agent paid an HTTP 402 request from its own sovereign wallet, using the x402 '
        + 'protocol. The self-report does not mint separately; the chain-witnessed '
        + 'settlement is the mint-once proof of the act.',
    link_spend:
        'An agent completed a purchase through Stripe Link\'s wallet for agents. Provian '
        + 'witnessed the spend-request record after the fact — id, amount, merchant, outcome — '
        + 'never a card or credential. It never approved or moved the money.',
    promise_created: 'A peer-to-peer promise (an IOU) you created.',
    promise_fulfilled: 'A promise that was marked fulfilled.',
    agent_authorization: 'A proof event from this identity’s history.',
    agent_work_delegated: 'A proof event from this identity’s history.',
    commons_profile_created: 'A record that you joined the Commons — the public town square.',
    human_approval:
        'You approved an agent\u2019s work with a biometric signature. The agent cites this record as '
        + 'an origin, and the approval itself mints PVT once at its evidence-based value.',
    corroboration_signal_received: 'An independent witness corroborated one of your PEs.',
    goal_envelope_approved: 'A proof event from this identity’s history.',
    badge_earned: 'A badge you earned. Badges are records and mint zero PVT.',
};

/**
 * Get the "what is this?" description for an action_type. Falls back to the
 * top-level Provenance Envelope overview so every PE detail view can explain
 * itself — never a raw type string.
 */
export function getActionTypeDescription(actionType: string): string {
    const description = ACTION_TYPE_DESCRIPTION[actionType];
    return description
        ? translate(`actionTypes.descriptions.${actionType.replace(/:/g, '_')}`, description)
        : translate('actionTypes.overview', PROVENANCE_ENVELOPE_OVERVIEW);
}

/** Whether a specific (non-generic) description exists for this action_type. */
export function hasActionTypeDescription(actionType: string): boolean {
    return actionType in ACTION_TYPE_DESCRIPTION;
}
