/**
 * Navigation Types - TypeScript definitions for React Navigation stacks
 *
 * [Issue #14] Provides proper typing for navigation props across all screens.
 *
 * AppParamList is the single source of truth for the flat Stack navigator
 * in AppNavigator.tsx. All screen prop types reference it.
 */

import { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { NavigatorScreenParams } from '@react-navigation/native';
import type { Contact } from '../core/protection/AddressHistoryService';
import type { Transaction } from '../core/history/TransactionHistoryService';
import type { EarningSurfaceId, ForgeProvider } from '../core/earn/EarningSurfaceRegistry';

// =============================================================================
// APP PARAM LIST: Comprehensive flat Stack navigator type
// =============================================================================

export type AppParamList = {
    // Vision (accessible before and after onboarding)
    Vision: undefined;

    // Onboarding
    Onboarding: undefined;
    // Commons
    CommonsOnboarding: undefined;
    CommonsDashboard: { tab?: 'feed' | 'work' | 'people' | 'inbox' } | undefined;
    CommonsProfile: { walletId?: string; editable?: boolean };
    CommonsRegistry: undefined;
    CommonsMarket: undefined;
    CommonsHumanJobs: undefined;
    CommonsHumanJobsPost: { seeking?: 'agent' | 'human' } | undefined;
    CommonsHumanJobManage: { jobId: string };
    CommonsInstitutions: undefined;
    CommonsCourt: undefined;
    CommonsBonds: undefined;
    CommonsGovernance: undefined;
    CommonsForum: undefined;
    CommonsForumPost: { postId: string; channel?: string; focusCommentId?: string };
    // the full-screen composer (a new top-level post, or a reply when parentPostId is set)
    CommonsCompose: { channel?: string; parentPostId?: string } | undefined;
    // Commons communication
    CommonsThreads: undefined;
    CommonsNewMessage: undefined;
    /** an existing thread by id, or a direct conversation with `counterparty` (the first message opens it). */
    CommonsThread: { threadId?: string; counterparty?: string; counterpartyName?: string };
    CommonsWants: undefined;
    CommonsConsentRequests: undefined;
    /** `next`: the restore method to continue to once accepted; absent on the create path. */
    Consent: { next?: 'CloudRecovery' | 'ImportRecoveryPhrase' } | undefined;
    BiometricSetup: undefined;
    CloudBackupConfirm: { fromSettings?: boolean; requiredBeforeApp?: boolean } | undefined;
    PhraseBackup: { fromSettings?: boolean; requiredBeforeApp?: boolean } | undefined;
    StayInTheLoop: { fromSettings?: boolean } | undefined;
    ImportRecoveryPhrase: undefined;
    ExportMnemonic: undefined;
    Attestation: undefined;
    // Main Tabs (unified bottom tab navigator)
    MainTabs: NavigatorScreenParams<TabParamList> | undefined;

    // Dashboard
    Dashboard: undefined;

    // Actions
    // [F19] The agent-initiated Send params (isAgentInitiated / agentId / agent*)
    // were removed: Send is first-party only. No production route may construct
    // Send with an agent-initiated flag.
    Send: {
        prefillAddress?: string;
        prefillChain?: string;
        prefillName?: string;
    } | undefined;
    Receive: undefined;
    Swap: undefined;
    BuyCrypto: undefined;
    // F-A5-1 — human burn-to-present front door
    HumanPresentment: {
        audience?: string;
        challenge?: string;
        /** no requester nonce — generate one locally (a speech window / handshake binds on audience + window). */
        selfChallenge?: boolean;
        /** Predicates the requester named (a thread request / a forum challenge). */
        predicates?: Array<{ field: string; op: 'gte' | 'gt' | 'lte' | 'lt' | 'eq' | 'in'; threshold?: number; set?: number[] }>;
        /** a (relay-)signed challenge envelope — verified before any burn, forwarded to /present. */
        challengeEnvelope?: unknown;
        /** Where the produced token goes: answer a forum challenge, or present inside a thread. */
        deliverTo?: { kind: 'challenge'; challengeId: string } | { kind: 'thread'; threadId: string; requestId: string }
            /** the reputation presentation backs a vouch for `targetId` (the audience). */
            | { kind: 'vouch'; targetId: string; targetName?: string }
            /** the presentation to an applicant opens the hire handshake, then accepts them. */
            | { kind: 'hire'; jobId: string; applicantWalletId: string; applicantName?: string };
    } | undefined;
    PresentationRequester: { counterparty?: string } | undefined;
    // Security
    Lockdown: undefined;
    WalletLock: undefined;
    PEViewer: { envelopeId?: string } | undefined;

    // Settings
    Settings: undefined;
    Contacts: undefined;
    ContactDetail: { contact: Contact };
    Language: undefined;
    SecuritySettings: undefined;
    BackupAndRecovery: undefined;
    Legal: undefined;
    OpenSourceNotices: undefined;
    HelpSupport: undefined;
    DeleteAllData: undefined;
    TermsOfService: undefined;
    PrivacyPolicy: undefined;
    NetworkConstitution: undefined;
    BiometricSettings: undefined;
    ProfileEdit: undefined;
    DeviceManagement: undefined;

    // WalletConnect
    WalletConnect: undefined;
    WalletConnectSecurity: undefined;
    PeArchive: { buy?: boolean } | undefined;
    CommonsBlocked: undefined;


    // Exit Strategy
    ExitStrategyInfo: undefined;

    // Transaction History
    TransactionHistory: undefined;
    TransactionDetail: { transaction: Transaction };

    // Promise Tool
    PromiseList: { tab?: string } | undefined;
    CreatePromise: undefined;
    /** `openedAt` changes on every open from a link or a notification, so a screen already showing
     *  this promise reloads it instead of keeping what it showed (two-sim proof, 2026-10-17). */
    PromiseDetail: { promiseId: string; openedAt?: number };
    ScanPromise: undefined;

    // Chat (Phase 2c)
    ChatWebView: { providerId: string };

    // Recovery Flow
    RecoveryStart: { recoveryId?: string } | undefined;
    CloudRecovery: undefined;

    // Agent Stack
    AgentHub: undefined;
    AgentDetail: { agentId: string };
    LinkAccept: { inviteId: string; agentWalletId?: string };
    ConnectAgent: { mode?: 'device' | 'agent' | 'codeHost' } | undefined;
    RecoverAgent: { walletId: string; agentName?: string };
    RekeyAgent: { walletId: string; agentName?: string };
    // link a third-party wallet to a linked agent; card spending via Stripe Link.
    LinkExternalWallet: { walletId: string; agentName?: string };
    AgentCardSpending: { walletId: string; agentName?: string };


    // Earn (earning-surface hub lives in the tab navigator; detail is a stack route)
    EarnSurfaceDetail: { surfaceId: EarningSurfaceId };
    ForgeConnect: { provider: ForgeProvider };
    /** A person proves a wallet they already hold is theirs (Earn; no agent involved). */
    ProveOwnWallet: undefined;
    ForgeContributors: { provider: ForgeProvider; installationId: string };

    // Insurance Bonds
    BondManagement: { agentId: string };
    BondClaims: { agentId: string };


    // Activity
    ActivityLog: { focusEnvelopeId?: string } | undefined;
    EnvelopeDetail: { envelopeId: string };

    // Provenance / PVT Dashboard
    MyProvenance: undefined;
    PVTDetail: undefined;

    // Trust Layer (pass 2)
    OwnProfile: undefined;      // §2.3 the actor's own reputation vocabulary
    ApprovalInbox: undefined;   // §2.1 human-approval requests from agents

    // human surface
    AttentionCenter: undefined; // one place for everything needing the human's action
    PresentationRequest: { requestId: string }; // §3f compose predicates / verify a remote presentation

};

// =============================================================================
// TAB PARAM LIST: Bottom tab navigator (mounted at MainTabs)
// =============================================================================

export type TabParamList = {
    VisionTab: undefined;
    AbundanceTab: undefined;
    WalletTab: undefined;
    AgentsTab: undefined;
    CommonsTab: { tab?: 'feed' | 'work' | 'people' | 'inbox' } | undefined;
    PromisesTab: undefined;
    ChatTab: undefined;
};

// =============================================================================
// ONBOARDING STACK (legacy, kept for backward compatibility)
// =============================================================================

// Screen props for onboarding-related screens (reference AppParamList)
export type CloudBackupConfirmScreenProps = NativeStackScreenProps<
    AppParamList,
    'CloudBackupConfirm'
>;

// =============================================================================
// RECOVERY STACK (legacy, kept for backward compatibility)
// =============================================================================

export type RecoveryStackParamList = {
    RecoveryStart: undefined;
    RecoveryMethod: undefined;
    CloudRecovery: undefined;
    RecoveryFailed: { error?: string };
};

// =============================================================================
// SECURITY STACK (legacy, kept for backward compatibility)
// =============================================================================

export type SecurityStackParamList = {
    SecuritySettings: undefined;
    BackupStatus: undefined;
    DeviceManagement: undefined;
    ExportMnemonic: undefined;
};

// =============================================================================
// AGENT STACK: Screen props now reference AppParamList
// =============================================================================

export type AgentStackParamList = {
    AgentHub: undefined;
    AgentDetail: { agentId: string };
    AgentHistory: { agentId?: string };
    BondManagement: { agentId: string };
    BondClaims: { agentId: string };
};

export type BondManagementScreenProps = NativeStackScreenProps<
    AppParamList,
    'BondManagement'
>;

export type BondClaimsScreenProps = NativeStackScreenProps<
    AppParamList,
    'BondClaims'
>;

export type AgentHubScreenProps = NativeStackScreenProps<
    AppParamList,
    'AgentHub'
>;

export type EarnSurfaceDetailScreenProps = NativeStackScreenProps<
    AppParamList,
    'EarnSurfaceDetail'
>;

export type ForgeConnectScreenProps = NativeStackScreenProps<
    AppParamList,
    'ForgeConnect'
>;

export type ForgeContributorsScreenProps = NativeStackScreenProps<
    AppParamList,
    'ForgeContributors'
>;

export type AgentDetailScreenProps = NativeStackScreenProps<
    AppParamList,
    'AgentDetail'
>;




export type RecoverAgentScreenProps = NativeStackScreenProps<
    AppParamList,
    'RecoverAgent'
>;

// =============================================================================
// ACTIVITY STACK: Screen props now reference AppParamList
// =============================================================================

export type ActivityStackParamList = {
    ActivityLog: undefined;
    EnvelopeDetail: { envelopeId: string };
};

export type ActivityLogScreenProps = NativeStackScreenProps<
    AppParamList,
    'ActivityLog'
>;

export type EnvelopeDetailScreenProps = NativeStackScreenProps<
    AppParamList,
    'EnvelopeDetail'
>;

// =============================================================================
// PROVENANCE STACK (My Provenance / PVT Dashboard)
// =============================================================================

export type ProvenanceStackParamList = {
    MyProvenance: undefined;
};

export type MyProvenanceScreenProps = NativeStackScreenProps<
    ProvenanceStackParamList,
    'MyProvenance'
>;

// =============================================================================
// SCREEN PROPS: For screens with custom inline props, use AppParamList
// =============================================================================

export type ContactDetailScreenProps = NativeStackScreenProps<
    AppParamList,
    'ContactDetail'
>;

export type TransactionDetailScreenProps = NativeStackScreenProps<
    AppParamList,
    'TransactionDetail'
>;

// =============================================================================
// MAIN STACK (Root Navigator), legacy
// =============================================================================

export type RootStackParamList = {
    Onboarding: undefined;
    Dashboard: undefined;
    Settings: undefined;
    Agent: undefined;
    Credentials: undefined;
    Activity: undefined;
};
