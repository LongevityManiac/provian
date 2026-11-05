import i18next from 'i18next';
import { ActionWallet } from '../core/security/ActionWallet';
import { withBiometricAction, assertBiometricAction, isBiometricActionValid, type BiometricAction } from '../core/security/biometricAction';
import {sealPrivatePricing} from '../core/meter/privatePricing';
import i18n from '../i18n';
/**
 * RelayAPIService - Cloud Relay Communication Service
 *
 * Handles all communication with the Provian Cloud Run backend relay.
 * Agents connect through this relay, not directly to the phone.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getItemHmac, setItemHmac } from '../core/security/hmacAsyncStorage';
import * as SecureStore from 'expo-secure-store';
import * as Device from 'expo-device';
import * as Crypto from 'expo-crypto';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import NotificationService from './NotificationService';
import { apiFetch } from '../core/network/apiFetch';
import { resolveRelayBaseUrl } from '../core/relay/DevHostDiscovery';
import { RELAY_RECOVERY_DOMAIN, RELAY_RECOVERY_TYPES, RELAY_RECOVERY_PURPOSE } from '../core/relay/recoveryDomain';
import type { PredicateRequest, ReputationPredicateResult } from '../core/presentation/humanPresentation';
import { parseChallengeEnvelope, parseRequesterKeyDocument, isSignedChallenge, type ChallengeEnvelope, type RequesterJwk } from '../core/presentation/challengeEnvelope';
import type { MeterAnswer } from '../core/meter/meterTransport';
import {
    addressProofAuthorized,
    authorizedAddressProof,
    encodeAddressProofAuthorization,
    registerWithAddressProof,
    signHumanWalletAddressProof,
    type AddressProofAuthorization,
    type HumanWalletAddressProof,
} from '../core/wallet/humanWalletAddressProof';
import { extractPeTrustDetail, type PeTrustDetail } from '../utils/peTrustDetail';
import {
    normalizePVTAttestationTier,
    type PVTAttestationTier,
} from '../core/provenance/attestationTiers';
import type { CaptureBrokenReason } from '../core/agents/captureHealthHint';
import type { StoreRelayAnswer } from '../core/store/storePurchase';
import { translate } from '../i18n/translate';

// Storage keys
// SECURITY FIX: C-1 - Auth secret stored in SecureStore for HMAC signing
const AUTH_SECRET_KEY = 'provian_relay_auth_secret'; // HMAC signing secret
const USER_ID_KEY = 'provian_relay_user_id'; // Note: no @ prefix for SecureStore
const DEVICE_ID_KEY = '@provian_device_id';  // Non-sensitive, can stay in AsyncStorage
const CONNECTION_MODE_KEY = '@provian_connection_mode';  // Non-sensitive, can stay in AsyncStorage
const HUMAN_WALLET_REG_KEY = '@provian_human_wallet_registered';  // address|user_id the relay has confirmed registered
const RELAY_WALLET_ID_KEY = '@provian_relay_wallet_id';
// round-robin fairness: which (relay account, address) pair may carry a registration address
// proof — written only on a DEFINITIVE recovery answer or a freshly generated address.
const ADDRESS_PROOF_AUTH_KEY = '@provian_address_proof_authorized_v1';  // The relay `wallets` doc id (needed for per-wallet reads e.g. genesis status)

// SECURITY FIX: G-5 - Rate limiting for auto re-registration
const REGISTRATION_RATE_LIMIT_KEY = '@provian_registration_rate_limit';
const MAX_REGISTRATIONS_PER_HOUR = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Types
export type ConnectionMode = 'cloud' | 'local';

/**
 * [Group 5 / M-3] Minimum interval between successful relay credential
 * recovery calls. Defends against the H-1 amplification path where an
 * attacker repeatedly replays a captured signature within the backend's
 * timestamp window to force continuous secret rotation.
 */
const RECOVERY_THROTTLE_MS = 60_000;

/** The registration-confirmed marker: the address AND the relay account that confirmed it. */
export function humanWalletRegistrationMarker(address: string, userId: string | null): string {
    return `${address.toLowerCase()}|${userId ?? ''}`;
}

/**
 * Thrown by recoverRelayCredentials when the previous successful recovery
 * was less than RECOVERY_THROTTLE_MS ago. The 401 retry path catches this
 * and surfaces a session error to the user instead of looping.
 */
/**
 * the relay holds a burn record / pipelined present until the burn is mined and accepted
 * (about one Base block; its own bound is 90 s + a margin), so those calls may wait longer than 15 s.
 */
export const BURN_HOLD_TIMEOUT_MS = 120_000;

/** A `/v1/wallet/present` refusal. `burnId` is set when the relay RECORDED the burn first (reuse it). */
export class PresentationRefusedError extends Error {
    readonly status: number;
    readonly burnId?: string;
    constructor(message: string, status: number, burnId?: string) {
        super(message);
        this.name = 'PresentationRefusedError';
        this.status = status;
        this.burnId = burnId;
    }
}

export class RecoveryThrottledError extends Error {
    readonly code = 'RECOVERY_THROTTLED';
    readonly retryAfterMs: number;

    constructor(retryAfterMs: number) {
        super(`Relay credential recovery is throttled. Retry after ${Math.ceil(retryAfterMs / 1000)}s.`);
        this.name = 'RecoveryThrottledError';
        this.retryAfterMs = retryAfterMs;
    }
}

export interface ConnectionTokenResponse {
    connection_token: string;
    relay_url: string;
    expires_at: number;
}

/**
 * Ciphertext-only recovery escrow read (GET /v1/agent/wallet/:id/recovery-escrow).
 * The relay stores an OPAQUE sealed blob and holds no key; only the phone's
 * anchor secret can open `sealed_key_blob`. See agentRecovery.recoverAgentKeyHex.
 */
export interface RecoveryEscrowResponse {
    wallet_id: string;
    /** base64url ciphertext sealed to the inviting phone's anchor pubkey. */
    sealed_key_blob: string;
    /** base64url 32-byte x25519 anchor pubkey — the durable lookup join key. */
    recovery_anchor_pubkey: string;
    blob_version: number;
    created_at: number;
    updated_at: number;
}

/**
 * getRecoveryEscrow outcome. `not_found` distinguishes "no escrow stored yet"
 * (404 no_recovery_escrow) and "not your linked agent" (403) from a transient
 * failure, so the screen can show the right plain-English sentence. The `code`
 * is fed to mapAgentOnboardingError — it is NEVER shown raw.
 */
export type RecoveryEscrowResult =
    | { ok: true; escrow: RecoveryEscrowResponse }
    | { ok: false; code: string };

/** How a linked agent answers its Commons mail (item 4). */
export type AgentReplyPolicyMode = 'answer_anyone' | 'ask_me_first';

export interface LinkedAgent {
    wallet_id: string;
    agent_id: string;
    display_name: string;
    address: string;
    platform: string;
    pe_count: number;
    created_at: number;
    /** The agent's Solana address, if it reported one at registration (null until then). */
    solana_address?: string | null;
    /**
     * Whether this agent has PROVEN control of an external Base wallet it already
     * runs (an economically-active proven-address record). Display-only — it
     * surfaces the "external wallet linked" indicator; it is NOT a mint signal
     * (settlement keys on the watcher's proven_addresses read, never this flag).
     * Absent/false on older relays that don't send it.
     */
    external_address_linked?: boolean;
    /**
     * UTC date ('YYYY-MM-DD') of this agent's most recent PE, or null if never.
     *
     * The liveness signal. `pe_count` is a LIFETIME total and only grows, so any
     * "is it working?" indicator keyed on it is true forever after the first PE
     * — the hub said "connected and earning" throughout the five days Atlas
     * produced nothing.
     */
    last_pe_date?: string | null;
    /**
     * capture-health of this agent's EARNING device (the freshest
     * agent-owned device on the wallet), enriched by the relay onto
     * `/v1/relay/agent/sessions`. This is the card's "is it receiving NOW"
     * truth — the ms-precise last real capture, and whether that device is
     * broken/silent — which is a different (and more current) question than the
     * day-granular `last_pe_date`. Absent when the wallet has no agent device or
     * that device has never reported capture-health.
     */
    last_capture_at_ms?: number | null;
    capture_reported_at_ms?: number | null;
    capture_broken?: boolean | null;
    capture_broken_reason?: CaptureBrokenReason | null;
    capture_receiving?: boolean | null;
    /** When the broken state began (the process lane's own flags); null when unknown. */
    capture_broken_since_ms?: number | null;
}

/**
 * Identity-only linked-agent projection used by Earn's first paint. The relay
 * can answer this from the beneficiary-linked wallet documents alone, without
 * waiting for PE-count, device-health, or external-wallet enrichment.
 */
/** the one-time proof message for linking a third-party wallet to an agent. */
export interface AgentExternalAddressChallenge {
    challengeId: string;
    /** The EXACT text the third-party wallet signs (server-authoritative). */
    message: string;
    /** Lowercased address the challenge is bound to. */
    address: string;
    expiresAt: number;
}

/**
 * A third-party wallet proven by its holder — linked to an agent, or proven by the
 * person themself (its go-forward on-chain activity is chain-witnessed).
 */
export interface AgentExternalAddress {
    address: string;
    provenAt: number;
}

/** A relay timestamp as epoch ms: accepts epoch ms or an ISO-8601 string; null otherwise. */
export function relayTimeMs(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim() !== '') {
        const ms = Date.parse(value);
        return Number.isFinite(ms) ? ms : null;
    }
    return null;
}

/**
 * A pending connection-code link request addressed to this human : an agent that
 * connected with this wallet's code and is waiting for the human to authorize the link.
 * GET /v1/agent/wallet/link-requests.
 */
export interface AgentLinkRequest {
    request_id: string;
    invite_id: string;
    agent_wallet_id: string;
    agent_name: string;
    agent_pe_count: number;
    created_at: number;
    expires_at: number;
}

export interface LinkedAgentIdentity {
    wallet_id: string;
    agent_id: string;
    display_name: string;
    address: string;
    platform: string;
    created_at: number;
    solana_address: string | null;
    last_pe_date: string | null;
}

/** One PE in an agent's activity list (GET /v1/relay/agent/:agentId/pe-activity). */
export interface AgentPEActivityItem {
    peId: string;
    actionType: string;
    timestamp: number | null;
    mintStatus: string | null;
    description: string | null;
    /**
     * The linked human's projected BENEFICIARY PVT for this PE (formatted, e.g.
     * "1.2"), or null. The relay sends the SAME eligible-only settlement
     * projection the dashboard uses — never a record-points sum. Non-null only on
     * a pending/eligible row that routes to this human; a minted or record_only
     * row is null (its chip shows status without a number).
     */
    beneficiaryProjectionPvt?: string | null;
}

/**
 * The linked human's beneficiary earnings from ONE agent (their cut of its
 * eligible work). Read-only projection; see the relay endpoint.
 */
export interface AgentBeneficiary {
    /** The human's current share of this link, in basis points (8000 = 80%). */
    human_share_bps: number;
    agent_share_bps: number;
    /** How many of the agent's PEs route to this human as beneficiary. */
    pe_count: number;
    /** False when no live settlement factor is available (show share + count only). */
    projection_available: boolean;
    /** Summed PENDING beneficiary projection, formatted (e.g. "3.4"), or null. */
    projected_pending_pvt: string | null;
    projected_pending_pvt_atomic: string | null;
}

export interface AgentPEActivity {
    agent_id: string;
    /** Accurate live PE count (not the undercounted agent_wallets.pe_count field). */
    pe_count: number;
    entries: AgentPEActivityItem[];
    solana_address: string | null;
    /** The human's beneficiary earnings from this agent (null on older relays). */
    beneficiary: AgentBeneficiary | null;
}

export interface RegisteredDevice {
    device_id: string;
    device_name: string;
    device_type: string;
    platform: string;
    status: 'active' | 'revoked';
    attestation_capability: string;
    last_pe_at: number | null;
    total_pes: number;
    created_at: number;
    /**
     * Self-reported LLM-session (AI-app) capture status from the device's
     * observer daemon. null = the daemon has not reported yet (older SDK, or
     * first heartbeat pending). Display-only; never affects earning.
     */
    capture_status: DeviceCaptureStatus | null;
}

/** LLM-session capture status a device's observer reports about itself. */
export interface DeviceCaptureStatus {
    /** Did the user turn AI-app capture on (config capture.llm_session_enabled). */
    llm_session_enabled: boolean;
    /** Daemon host platform; macOS permissions only matter when this is 'darwin'. */
    platform: string;
    /** The capture plugin is running (not disabled by config or platform). */
    active: boolean;
    /** The helper has reported an OS permission status at least once. */
    permissions_checked: boolean;
    /** macOS Accessibility permission granted. */
    accessibility: boolean;
    /** macOS Input Monitoring permission granted. */
    input_monitoring: boolean;
    updated_at: number;
}

// Forge witness connectors (Witness 3) - wallet-auth variants of the
// /v1/witnesses surfaces, used by the Earn tab's in-app connect flow (B3).
export type ForgeInstallProvider = 'github' | 'gitlab' | 'bitbucket';

export interface ForgeInstall {
    provider: ForgeInstallProvider;
    installation_id: string;
    installed_at: number;
    revoked_at: number | null;
    /**
     * The STABLE forge-account scope author mappings are keyed to (
     * Part 2). github: stamped from the first signed delivery, so null until
     * the install has delivered a push; gitlab/bitbucket: the installation id.
     */
    forge_account_id?: string | null;
    forge_account_login?: string | null;
}

/**
 * A git identity → wallet mapping (relay: core/agent-attribution). The forge
 * webhook credits a commit's AUTHOR by these, scoped to the forge account.
 */
export interface AuthorMapping {
    mapping_id: string;
    provider: ForgeInstallProvider;
    forge_account_id: string;
    forge_account_login: string | null;
    source_owner_wallet_id: string;
    agent_wallet_id: string;
    agent_id: string;
    author_key_type: 'email' | 'username' | 'account_id' | 'signature_key';
    author_key_hash: string;
    verified_by: 'agent_wallet_signature' | 'repo_owner_capture';
    status: 'active' | 'revoked';
    created_at: number;
    verified_at: number;
    revoked_at: number | null;
}

/** Result of POST /v1/agent-attribution/author-mappings/challenge (owner wallet auth). */
export type AuthorMappingChallengeResult =
    | {
        ok: true;
        challengeId: string;
        expiresAt: number;
        forgeAccountId: string;
        installationId: string;
        sourceOwnerWalletId: string;
    }
    | { ok: false; status: number; code: string };

/** Result of POST /v1/witnesses/github/connect/wallet/start. */
export type GitHubConnectStart =
    | { ok: true; state: string; installUrl: string; expiresAt: number }
    | { ok: false; status: number; code: string };

/** Result of GET /v1/witnesses/github/connect/wallet/poll. */
export type GitHubConnectPoll =
    | { ok: true; status: 'pending' | 'completed' | 'expired'; installId?: string; peId?: string }
    | { ok: false; status: number; code: string };

/** Result of POST /v1/witnesses/{gitlab|bitbucket}/wallet/installs. */
export type ForgeRegisterResult =
    | {
        ok: true;
        installationId: string;
        peId: string | null;
        /**
         * The one-time per-install webhook secret. Non-null ONLY on the call
         * that minted it - the relay never discloses it again (B2). The UI
         * must surface it immediately or it is gone until rotation.
         */
        webhookSecret: string | null;
        webhookSecretAlreadyIssued: boolean;
        /** Relay-authored setup (or rotation) instructions for the forge UI. */
        setup: string;
    }
    | { ok: false; status: number; code: string };

// PVT (Provenance Value Token) Dashboard Types
export interface PVTBreakdownItem {
    category: string;
    peCount: number;
    recordPoints: string;
    recordPointsAtomic: string;
    currentSettlementProjectionPVT: string | null;
    currentSettlementProjectionAtomic: string | null;
    exactGenesisReservedGrossPVT: string;
    exactGenesisReservedGrossAtomic: string;
}

export interface PVTSettlementFactor {
    numerator: string;
    denominator: string;
    source: string;
    asOf: string;
}

export type PVTCurrentSettlementProjection = {
    available: false;
    label: string;
    isFinal: false;
    unavailableReason: string | null;
} | {
    available: true;
    label: string;
    isFinal: false;
    totalPVT: string;
    totalPvtAtomic: string;
    projectedAtMs: number;
    factorVintage: {
        globalMintRate: PVTSettlementFactor;
    };
};

export interface PVTAccrual {
    recordPoints: {
        label: string;
        unit: 'record_points_atomic';
        total: string;
        totalAtomic: string;
    };
    currentSettlementProjection: PVTCurrentSettlementProjection;
    exactGenesisReservedGross: {
        label: string;
        totalPVT: string;
        totalAtomic: string;
    };
    totalPEs: number;
    weeklyPEs: number;
    attestationDepth: PVTAttestationTier;
    breakdown: PVTBreakdownItem[];
    integrityFailures: number;
    projectionFailures: number;
}

export interface PVTHistoryEntry {
    peId: string;
    /** The device's own pe_id for this act (relay rows carry it since 2026-10-17), for joining to a local PE. */
    clientPeId?: string | null;
    actionType: string;
    timestamp: number;
    attestationDepth: PVTAttestationTier;
    /**
     * the sealed earning disposition (the relay's `mint_status`). Drives the
     * per-row chip via normalizeMintStatus/buildEarningChip. Null on legacy rows
     * that predate the field → the UI renders no earning claim.
     */
    mintStatus: string | null;
    /**
     * commit SHA (display/grouping key). Non-null on commit-family PEs;
     * lets the UI collapse the witnesses of one commit into a single row.
     */
    commitSha: string | null;
    recordPoints: string;
    recordPointsAtomic: string | null;
    currentSettlementProjectionPVT: string | null;
    currentSettlementProjectionAtomic: string | null;
    exactGenesisReservedGrossPVT: string;
    exactGenesisReservedGrossAtomic: string | null;
    hash: string;
    hidden: boolean;
    /** Optional payment method info (card nickname + last four) */
    paymentMethod?: string;
    /** Optional description/intent text */
    description?: string;
}

/**
 * §2.6/§2.7: the public verify verdict. A REPUTATION verdict carries the predicate results,
 * the always-present `standing.*` facts, and the disclosed raw facts — never the chain and
 * never a payload to re-mine. A PE_FACT verdict carries its payload (the anchored claims).
 */
export interface PresentationVerifyResult {
    valid: boolean;
    tier?: string;
    reason?: string;
    /** A 400 refusal (malformed input, envelope disagreement) carries `error` rather than `reason`. */
    error?: string;
    onchain_checked?: boolean;
    presenter_address?: string;
    sub?: string | null;
    /** the dedupe key (= burn id; one burn backs one presentation, globally). Accept each once. */
    presentation_id?: string;
    /** the verified requester of a v2 presentation (`{type,id}`), else null. */
    requester?: { type: 'domain' | 'wallet'; id: string } | null;
    /** the challenge deadline (v2 `chal_exp`, else the envelope's `expiresAt`), else null. */
    challenge_expires_at?: number | null;
    predicates?: ReputationPredicateResult[];
    standing?: Record<string, number>;
    disclosed?: Record<string, number>;
    redacted?: string[];
    /** 2026-10-10: the requester-named disclosure answers (each record checked against its proof by the relay). */
    disclosures?: import('../core/presentation/disclosureRequest').DisclosureAnswer[];
    payload?: unknown;
}

/**
 * Trust Layer §2.1: one pending human-approval request an agent addressed to
 * THIS human. The relay returns the plain-language `action_description` (Tier-3,
 * human-side only) plus its content hash — the human sees WHAT it is approving;
 * the agent-facing surface never gets the text. Building the approval PE anchors
 * on `action_description_sha256` as `subject_hash`.
 */
export interface HumanApprovalRequest {
    request_id: string;
    agent_wallet_id: string;
    /** SHOW this to the human — the described action being approved (Tier-3). */
    action_description: string;
    action_description_sha256: string;
    subject_pe_id: string | null;
    created_at_ms: number;
    expires_at_ms: number;
}

/** Result of resolving an approval request (best-effort; never throws). */
export interface ApprovalResolveResult {
    ok: boolean;
    status?: string;
    error?: string;
}

/**
 * §3f: a remote presentation request an agent addressed to THIS human. The human is the
 * requester/verifier — they compose the predicates the agent must prove, the agent burns + presents,
 * the human verifies. Mirrors the human-facing projection from the relay presentation channel.
 */
export interface HumanPresentationRequest {
    request_id: string;
    agent_wallet_id: string;
    tier: 'pe_fact' | 'reputation';
    status: 'requested' | 'challenged' | 'presented' | 'verified' | 'declined' | 'expired';
    /** Optional short agent-supplied reason (Tier-3; shown only to this human). */
    note: string | null;
    created_at_ms: number;
    expires_at_ms: number;
    /** The challenge the human composed (echoed back so verify binds to it after an app restart). */
    audience: string | null;
    challenge: string | null;
    predicates: unknown[] | null;
    /** the relay-signed challenge envelope for this request (wallet requester = this human). */
    challenge_envelope: ChallengeEnvelope | null;
    /** Populated once the agent has presented — the token the human verifies. */
    presentation_token: string | null;
    verdict: 'valid' | 'invalid' | null;
    predicate_results?: unknown[] | null;
}

/** a linked agent needing recovery/re-key, surfaced to its human in the attention center. */
export interface AgentRecoveryAlert {
    agent_wallet_id: string;
    agent_name: string;
    reason: 'at_rest_secret_missing' | 'at_rest_secret_nondecrypting' | 'keystore_missing' | 'escrow_missing';
}

/**
 * §2.4: the current single-use burn floor per presentation tier (GET
 * /v1/present/floor). Amounts are whole PVT. null on any read failure — the
 * screen then shows its config-mirrored defaults (reputation 15 / pe_fact 5).
 */
export interface PresentationFloor {
    reputation: number;
    pe_fact: number;
}

export interface PVTHistoryResponse {
    entries: PVTHistoryEntry[];
    total: number;
    hasMore: boolean;
    /** Keyset cursor for the next page (rows strictly older than this page's last), null at the end. */
    nextCursor?: string | null;
    currentSettlementProjection: {
        label: string;
        isFinal: false;
        projectedAtMs?: number;
        factorVintage?: {
            globalMintRate: PVTSettlementFactor;
        };
        unavailableReason?: string;
    };
}

export interface PVTLeaderboardEntry {
    rank: number;
    address: string;
    ownerType: 'human' | 'agent';
    displayName?: string;
    peCount: number;
}

export interface PVTNetworkStats {
    totalPEs: number;
    activeWallets: number;
    humanWallets: number;
    agentWallets: number;
    pesLast24h: number;
    leaderboard: PVTLeaderboardEntry[];
    userRank?: number;
    userAddress?: string;
}

export interface PVTAllocation {
    coming_soon?: boolean;
    wallet_id?: string;
    on_chain_balance?: string;
    record_points?: number;
    record_points_atomic?: string;
    record_points_label?: string;
    current_settlement_projection?: {
        available: boolean;
        is_final: false;
        label: string;
        total_pvt?: number;
        total_pvt_atomic?: string;
        projected_at_ms?: number;
        factor_vintage?: Record<string, PVTSettlementFactor>;
        unavailable_reason?: string | null;
    };
    exact_genesis_reserved_gross_pvt?: number;
    exact_genesis_reserved_gross_atomic?: string;
    total_pes?: number;
    pes_by_category?: Record<string, number>;
    record_points_by_category?: Record<string, number>;
    record_points_by_category_atomic?: Record<string, string>;
    current_settlement_projection_by_category_atomic?: Record<string, string> | null;
    unminted_pe_count?: number;
    minted_pe_count?: number;
    weekly_pes?: number;
}

export interface PVTMilestone {
    name: string;
    current: number;
    target: number;
    met: boolean;
}

export interface PVTMilestones {
    milestones: PVTMilestone[];
    mint_ready: boolean;
    met_count: number;
    total_count: number;
}

/**
 * Genesis legacy-record read-back. Mirrors the backend `GenesisWalletStatus`
 * v3 projection (genesis-milestones.ts, cutover reconciliation): the retired ladder/pool/next
 * fields are DELETED server-side so nothing can be presented as PVT9 state.
 * What remains is the historical issuance record plus the current PVT9
 * posture (a legacy compatibility read; the live campaign is armed through 2026-12-31).
 */
export interface GenesisWalletStatus {
    wallet_id: string;
    schema: 'genesis-wallet-status/v3-legacy-record';
    legacy_record_only: true;
    /** Legacy test-campaign issuance record — never a PVT9 balance or pending mint. */
    genesis_pvt_earned_record: number;
    pvt9: { genesis_armed: boolean; genesis_window_approved: boolean };
}

/** Result of a human-promise write; never throws — offline/error → ok:false. */
export interface HumanPromiseWriteResult {
    ok: boolean;
    /** HTTP status when a response was received. */
    httpStatus?: number;
    /** The promise status the relay returned on success. */
    status?: string;
    /** close-out only: 'fulfilled' | 'awaiting_counterparty'. */
    mode?: string;
    /** The relay error string on ok:false (when a response was received). */
    error?: string;
}

/** A per-party agreement record in a relay human-promise doc (opaque terms). */
export interface RelayHumanPromisePartyRecord {
    address: string;
    role: 'creator' | 'acceptor';
    signature: string;
    signed_digest: string;
    signed_at: number;
    terms_ciphertext: string;
}

/** The relay's human-promise document (mirrors the backend HumanPromiseDocument). */
export interface RelayHumanPromiseDocument {
    promise_id: string;
    digest: string;
    status: string;
    creator_address: string;
    acceptor_address: string | null;
    parties: Record<string, RelayHumanPromisePartyRecord>;
    closeout: Record<string, { address: string; signature: string; signed_at: number }>;
    created_at: number;
    updated_at: number;
    expires_at: number;
}

/**
 * What a Delete All Data request to the relay came to (2026-10-23 close-out, ).
 *  - `deleted`        the relay answered 2xx: every relay-side record is handled.
 *  - `account_gone`   the relay answered 401 `Auth secret not configured`: the account's
 *                     authentication record is gone. The relay deletes it LAST, so this means an
 *                     earlier request already finished the deletion (e.g. it completed after this
 *                     phone timed out). Treated as done; never as "recover credentials".
 *  - `not_finished`   any other answer (a 500 can follow a partial deletion): some data may already
 *                     be gone; sending the request again finishes it.
 *  - `unknown`        timeout or network error: the relay may have finished, partly finished, or not
 *                     started; sending again is safe either way.
 *  - `no_access`      this phone holds no relay credentials, or the relay refused them for another
 *                     reason (e.g. another phone recovered the wallet and rotated them): nothing was
 *                     deleted and this phone cannot delete the server data.
 */
export type DataDeletionOutcome = 'deleted' | 'account_gone' | 'not_finished' | 'unknown' | 'no_access';

/**
 * The relay's 401 for a token whose account has no authentication record
 * (`provian-backend/src/routes/middleware/wallet-auth.ts`). Bound to that source by
 * `RelayAPIService.dataDeletion.test.ts`.
 */
export const RELAY_AUTH_RECORD_GONE_ERROR = 'Auth secret not configured. Re-register device.';

class RelayAPIService {
    private static instance: RelayAPIService;
    private authToken: string | null = null;
    private userId: string | null = null;
    private connectionMode: ConnectionMode = 'cloud';
    private registrationInFlight: Promise<{ userId: string; authSecret: string }> | null = null;
    private recoveryInFlight: {
        address: string;
        promise: Promise<{ userId: string; authSecret: string; recovered: boolean }>;
    } | null = null;
    /** Last confirmed full linked-agent response for transient-refresh resilience. */
    private linkedAgentsCache: LinkedAgent[] | null = null;
    /** Last confirmed cheap identity response for an immediate Earn first paint. */
    private linkedAgentIdentitiesCache: LinkedAgentIdentity[] | null = null;
    private linkedAgentsInFlight: Promise<{ linked_agents: LinkedAgent[] }> | null = null;
    private linkedAgentIdentitiesInFlight: Promise<{ linked_agents: LinkedAgentIdentity[] }> | null = null;
    private pvtAccrualInFlight: { userId: string; promise: Promise<PVTAccrual | null> } | null = null;
    /**
     * [Group 5 / M-3] Last successful relay credential recovery, in ms since
     * epoch. Used by the client-side throttle in recoverRelayCredentials.
     * Module-private memory only; not persisted across app restart.
     */
    private lastRecoveryAt: number = 0;

    /**
     * Monotonic salt appended to the cache-busting query param on live-state
     * GETs, so two reads in the same millisecond still get distinct URLs. See
     * noCacheGet().
     */
    private noCacheSeq: number = 0;

    private constructor() {}

    static getInstance(): RelayAPIService {
        if (!RelayAPIService.instance) {
            RelayAPIService.instance = new RelayAPIService();
        }
        return RelayAPIService.instance;
    }

    async initialize(): Promise<void> {
        try {
            // SECURITY FIX: G-2 - Use SecureStore for sensitive auth tokens
            this.authToken = await SecureStore.getItemAsync(AUTH_SECRET_KEY);
            this.userId = await SecureStore.getItemAsync(USER_ID_KEY);
            const storedMode = await AsyncStorage.getItem(CONNECTION_MODE_KEY);
            this.connectionMode = (storedMode as ConnectionMode) || 'cloud';
            console.log('[RelayAPI] Initialized, mode:', this.connectionMode);
        } catch (error) {
            console.error('[RelayAPI] Initialization error:', error);
        }
    }

    // =========================================================================
    // Configuration
    // =========================================================================

    // SECURITY FIX: C-1 - Store HMAC auth secret in SecureStore
    async setAuthSecret(secret: string, userId: string): Promise<void> {
        if (this.userId !== null && this.userId !== userId) {
            // Never carry one human's linked-agent display state into another
            // wallet identity on the same device.
            this.linkedAgentsCache = null;
            this.linkedAgentIdentitiesCache = null;
        }
        this.authToken = secret; // Re-use field internally for the secret
        this.userId = userId;
        await SecureStore.setItemAsync(AUTH_SECRET_KEY, secret, {
            keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        });
        await SecureStore.setItemAsync(USER_ID_KEY, userId, {
            keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        });
    }

    /**
     * Forget this device's relay credentials (Delete All Data): the auth secret and user id in
     * SecureStore and the in-memory copies, with the per-identity caches they key.
     */
    async clearRelayCredentials(): Promise<void> {
        this.authToken = null;
        this.userId = null;
        this.linkedAgentsCache = null;
        this.linkedAgentIdentitiesCache = null;
        await SecureStore.deleteItemAsync(AUTH_SECRET_KEY).catch(() => undefined);
        await SecureStore.deleteItemAsync(USER_ID_KEY).catch(() => undefined);
    }

    async getAuthSecret(biometricAction?: BiometricAction): Promise<string | null> {
        if (!this.authToken) {
            this.authToken = await SecureStore.getItemAsync(AUTH_SECRET_KEY);
        }
        if (!this.authToken && biometricAction) {
            assertBiometricAction(biometricAction);
            await this.ensureRegistered(biometricAction);
        }
        return this.authToken;
    }

    // SECURITY: HMAC-signed auth token. v2 request-binding (jti, mth, pth, bh)
    // is defined but gated behind V2_TOKEN_ENABLED until the backend's Redis
    // nonce store is confirmed operational. Without Redis, the fail-closed
    // nonce check rejects every v2 token.
    private static V2_TOKEN_ENABLED = true;

    private async generateSignedToken(
        method: string = 'GET',
        path: string = '/',
        body?: string,
        requestSecret?: string,
    ): Promise<string | null> {
        const secret = requestSecret ?? await this.getAuthSecret();
        const userId = await this.getUserId();
        const deviceId = await this.getDeviceId();

        if (!secret || !userId) return null;

        // [M-36] @noble/hashes and expo-crypto are statically imported at
        // module scope so the signing hot path doesn't pay an import cost
        // on every signed token. These are external packages and cannot
        // form a circular dependency with our codebase.
        const encoder = new TextEncoder();

        const now = Date.now();
        let payload: string;

        if (RelayAPIService.V2_TOKEN_ENABLED) {
            const bodyBytes = encoder.encode(body || '');
            const bh = bytesToHex(sha256(bodyBytes));
            const jti = Crypto.randomUUID();

            // The token's path binding (pth) must match the server's, which
            // canonicalizes the request path with the query string stripped
            // (wallet-auth.ts: `(req.originalUrl).split('?')[0]`). Callers pass
            // the full endpoint including `?limit=...`, so strip the query here
            // or every query-string GET (pvt/history, mint-history,
            // provenance-envelopes, witness poll) fails with "Token path
            // mismatch" -> 401 while query-less endpoints (pvt/accrual) pass.
            const pth = path.split('?')[0];

            payload = JSON.stringify({
                sub: userId,
                device_id: deviceId,
                iat: now,
                exp: now + 90_000,
                jti,
                mth: method.toUpperCase(),
                pth,
                bh,
            });
        } else {
            // v1 format - HMAC-signed but not request-bound
            payload = JSON.stringify({
                user_id: userId,
                device_id: deviceId,
                ts: now,
            });
        }

        const payloadB64 = btoa(payload);
        const signature = bytesToHex(hmac(sha256, encoder.encode(secret), encoder.encode(payloadB64)));

        return `${payloadB64}.${signature}`;
    }

    /** @deprecated Use getAuthSecret() - kept for backward compat during migration */
    async getAuthToken(): Promise<string | null> {
        return this.getAuthSecret();
    }

    /**
     * Public wrapper for external callers (e.g. ProxyConfig) that need a
     * freshly-signed wallet auth token. Callers MUST provide the request
     * details so the token is bound to the specific request.
     */
    async getSignedAuthToken(
        method: string = 'GET',
        path: string = '/',
        body?: string,
        capturedSecret?: string,
        biometricAction?: BiometricAction,
    ): Promise<string | null> {
        const secret = capturedSecret ?? await this.getAuthSecret(biometricAction);
        return this.generateSignedToken(method, path, body, secret ?? undefined);
    }

    /** Commons shares request-bound auth and credential recovery with the wallet transport. */
    async commonsRequest(method: string, path: string, body?: unknown, biometricAction?: BiometricAction): Promise<Response> {
        return this.makeAuthenticatedRequest(path, {
            method,
            ...(body == null ? {} : { privateBodyBuilder: secret => JSON.stringify({ private_request: sealPrivatePricing(
                { request: body as Record<string, unknown> }, secret, 'provian-private-request:v1:' + path.split('?')[0],
            ) }) }),
        }, true, biometricAction);
    }

    async getUserId(): Promise<string | null> {
        if (!this.userId) {
            this.userId = await SecureStore.getItemAsync(USER_ID_KEY);
        }
        return this.userId;
    }

    // SECURITY FIX: G-5 - Rate limiting for auto re-registration
    // [Phase 2.10] HMAC-protected so a tampered AsyncStorage entry can't
    // erase prior attempts and let an attacker replay registration storms.
    // Fail-CLOSED on parse errors: if the stored value is corrupt, deny
    // the attempt rather than allow it.
    private async checkRegistrationRateLimit(): Promise<boolean> {
        const data = await getItemHmac<{ timestamps: number[] }>(REGISTRATION_RATE_LIMIT_KEY);
        if (!data) return true; // No prior attempts recorded

        const now = Date.now();
        const windowStart = now - RATE_LIMIT_WINDOW_MS;

        const recentAttempts = data.timestamps.filter((ts: number) => ts > windowStart);
        if (recentAttempts.length >= MAX_REGISTRATIONS_PER_HOUR) {
            console.warn('[RelayAPI] Registration rate limit exceeded');
            return false;
        }
        return true;
    }

    private async recordRegistrationAttempt(): Promise<void> {
        try {
            const existing = (await getItemHmac<{ timestamps: number[] }>(REGISTRATION_RATE_LIMIT_KEY))
                ?? { timestamps: [] };
            const now = Date.now();
            const windowStart = now - RATE_LIMIT_WINDOW_MS;

            existing.timestamps = existing.timestamps.filter((ts: number) => ts > windowStart);
            existing.timestamps.push(now);

            await setItemHmac(REGISTRATION_RATE_LIMIT_KEY, existing);
        } catch (error) {
            console.error('[RelayAPI] Failed to record registration attempt:', error);
        }
    }

    async setConnectionMode(mode: ConnectionMode): Promise<void> {
        this.connectionMode = mode;
        await AsyncStorage.setItem(CONNECTION_MODE_KEY, mode);
    }

    async getConnectionMode(): Promise<ConnectionMode> {
        if (!this.connectionMode) {
            const stored = await AsyncStorage.getItem(CONNECTION_MODE_KEY);
            this.connectionMode = (stored as ConnectionMode) || 'cloud';
        }
        return this.connectionMode;
    }

    isCloudMode(): boolean {
        return this.connectionMode === 'cloud';
    }

    private async getBackendUrl(): Promise<string> {
        return NotificationService.getBackendUrl();
    }

    /**
     * Get or create a unique device ID for this installation.
     */
    private async getDeviceId(): Promise<string> {
        let deviceId = await AsyncStorage.getItem(DEVICE_ID_KEY);
        if (!deviceId) {
            // Generate a unique device ID
            const randomBytes = await Crypto.getRandomBytesAsync(16);
            deviceId = `device_${Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('')}`;
            await AsyncStorage.setItem(DEVICE_ID_KEY, deviceId);
        }
        return deviceId;
    }

    /**
     * Check if the user is registered with the backend.
     */
    async isRegistered(): Promise<boolean> {
        const secret = await this.getAuthSecret();
        return secret !== null;
    }

    /**
     * Register this device with the backend.
     * Creates a new user account and stores the auth token.
     * Also registers the FCM token for push notifications.
     */
    // SECURITY FIX: C-1 - Registration now returns auth_secret for HMAC signing
    async registerUser(biometricAction?: BiometricAction): Promise<{ userId: string; authSecret: string }> {
        // Deduplicate concurrent registration calls - if one is already in flight,
        // all callers await the same promise instead of creating duplicate users.
        if (this.registrationInFlight) {
            return this.registrationInFlight;
        }
        this.registrationInFlight = this.doRegisterUser(biometricAction);
        try {
            return await this.registrationInFlight;
        } finally {
            this.registrationInFlight = null;
        }
    }

    private async doRegisterUser(biometricAction?: BiometricAction): Promise<{ userId: string; authSecret: string }> {
        // SAFETY GUARD: never overwrite existing credentials.
        // If credentials already exist, the caller should use recoverRelayCredentials()
        // to prove wallet ownership and retrieve the existing account instead.
        const existingSecret = await this.getAuthSecret();
        if (existingSecret) {
            console.warn('[RelayAPI] doRegisterUser() called but credentials already exist - aborting to prevent account replacement. Use recoverRelayCredentials() instead.');
            const existingUserId = await SecureStore.getItemAsync(USER_ID_KEY) ?? '';
            return { userId: existingUserId, authSecret: existingSecret };
        }

        const deviceId = await this.getDeviceId();
        const backendUrl = await this.getBackendUrl();

        // Include wallet_address if available (links relay identity to on-chain identity)
        const { useWalletStore } = await import('../store/walletStore');
        const walletAddress = useWalletStore.getState().address;

        console.log('[RelayAPI] Registering new user with backend (no existing credentials)...');

        // Create user account
        const response = await apiFetch(`${backendUrl}/v1/users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                device_id: deviceId,
                wallet_address: walletAddress || undefined,
            }),
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || 'Failed to register user');
        }

        const data = await response.json();
        const { user_id, auth_secret } = data;

        // Re-check after the round trip: a wallet recovery that landed while this POST was in
        // flight holds the wallet's real account, and the blank account must never replace it.
        const landedSecret = await this.getAuthSecret();
        if (landedSecret) {
            console.warn('[RelayAPI] Credentials appeared during registration - keeping them, discarding the new account');
            const landedUserId = await SecureStore.getItemAsync(USER_ID_KEY) ?? '';
            return { userId: landedUserId, authSecret: landedSecret };
        }

        // Store credentials in SecureStore
        await this.setAuthSecret(auth_secret, user_id);
        console.log('[RelayAPI] User registered:', user_id);

        // Register FCM token if available
        try {
            const fcmToken = await NotificationService.getPushToken();
            if (fcmToken) {
                await this.registerFCMToken(fcmToken, biometricAction);
            }
        } catch (error) {
            console.warn('[RelayAPI] Failed to register FCM token:', error);
            // Non-fatal - push notifications may not work but relay will
        }

        return { userId: user_id, authSecret: auth_secret };
    }

    /**
     * Recover relay credentials after wallet recovery.
     *
     * Proves ownership of the wallet address by signing a challenge with the
     * private key, then re-establishes relay credentials (auth_secret + user_id).
     * If the backend finds an existing user with this wallet_address, it rotates
     * the auth_secret and returns the original user_id. Otherwise creates a new user.
     */
    async recoverRelayCredentials(walletAddress: string, biometricAction?: BiometricAction): Promise<{ userId: string; authSecret: string; recovered: boolean }> {
        if (!biometricAction) return withBiometricAction(translate('biometricPrompts.reconnectWallet', 'Reconnect your wallet'), action => this.recoverRelayCredentials(walletAddress, action));
        assertBiometricAction(biometricAction);
        // ONE recovery at a time. Every recovery rotates the account's auth secret, so two running
        // side by side (the recovery screen's explicit call, a 401 retry, the push registrar)
        // leave the device holding whichever secret lost the race. Concurrent callers for the
        // same address share the in-flight call; a call for another address waits its turn.
        const key = walletAddress.toLowerCase();
        const current = this.recoveryInFlight;
        if (current && current.address === key) return current.promise;
        const promise = (async () => {
            if (current) await current.promise.catch(() => undefined);
            return this.doRecoverRelayCredentials(walletAddress, biometricAction);
        })();
        const entry = { address: key, promise };
        this.recoveryInFlight = entry;
        try {
            return await promise;
        } finally {
            if (this.recoveryInFlight === entry) this.recoveryInFlight = null;
        }
    }

    private async doRecoverRelayCredentials(walletAddress: string, biometricAction?: BiometricAction): Promise<{ userId: string; authSecret: string; recovered: boolean }> {
        const deviceId = await this.getDeviceId();
        const backendUrl = await this.getBackendUrl();
        const timestamp = Date.now();

        // [Group 5 / M-3] Client-side throttle. If a successful recovery
        // happened less than RECOVERY_THROTTLE_MS ago, refuse and let the
        // caller surface a session error rather than re-issuing recoveries
        // in a tight loop. Defends against the H-1 amplification path
        // where a captured signature replayed by an attacker forces
        // continuous secret rotation.
        const sinceLastRecovery = timestamp - this.lastRecoveryAt;
        if (this.lastRecoveryAt > 0 && sinceLastRecovery < RECOVERY_THROTTLE_MS) {
            const remaining = RECOVERY_THROTTLE_MS - sinceLastRecovery;
            console.warn(`[RelayAPI] Recovery throttled, ${Math.ceil(remaining / 1000)}s remaining`);
            throw new RecoveryThrottledError(remaining);
        }

        console.log('[RelayAPI] Recovering relay credentials for wallet:', walletAddress);

        // Sign with the BIP-39-derived EVM key (secp256k1). Not KeyManager,
        // which uses a separate P-256 Secure Enclave key that doesn't match
        // the wallet address and doesn't survive reinstall.
        const { default: SeedManager } = await import('../core/wallet/SeedManager');
        const { ethers } = await import('ethers');

        // [Group 1 / M-2] Establish a biometric session before touching seed
        // material. Recovery may run automatically on a 401 from the relay,
        // so a prompt here is the user's first signal that something is
        // re-authenticating. Anything that throws here aborts the recovery.
        return await withBiometricAction(translate('biometricPrompts.reconnectRelay', 'Reconnect to Provian relay'), async (biometricAction) => {
            assertBiometricAction(biometricAction);

            const evmPrivateKey = await SeedManager.getEVMPrivateKey(biometricAction);
            const signer = new ActionWallet(evmPrivateKey, biometricAction);
            // No memory wipe of evmPrivateKey: JS strings are immutable, any
            // .split('').fill('\0') would mutate a copy, not the original string.
            // The key remains in the managed heap until the function frame is GC'd.

            // EIP-712 domain-separated recovery message. The earlier legacy
            // personal_sign path was removed - it had no domain separator
            // (no chainId, contract, or nonce) and was replayable by any captured
            // WalletConnect signature of the same literal text. This message is
            // bound to a Provian-specific EIP-712 domain so signatures captured
            // in any other context cannot be replayed at /v1/users/recover.
            const tsSeconds = Math.floor(timestamp / 1000);
            // Domain, struct and purpose come from the ONE app definition
            // (core/relay/recoveryDomain.ts), pinned to the relay's constants and
            // shared with the WalletConnect reserved-message guard so no external
            // dApp can obtain a signature over this struct.
            const domain = { ...RELAY_RECOVERY_DOMAIN };
            const types = { RelayRecovery: [...RELAY_RECOVERY_TYPES.RelayRecovery] };
            const message = {
                user: walletAddress,
                timestamp: tsSeconds,
                purpose: RELAY_RECOVERY_PURPOSE,
            };
            const signature = await signer.signTypedData(domain, types, message);

            const body = JSON.stringify({
                wallet_address: walletAddress,
                timestamp: tsSeconds,
                signature,
                device_id: deviceId,
                eip712: { domain, types, message },
            });

            const response = await apiFetch(`${backendUrl}/v1/users/recover`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
            });

            if (!response.ok) {
                const error = await response.json().catch(() => ({}));
                throw new Error(error.error || 'Relay credential recovery failed');
            }

            const data = await response.json();
            const { user_id, auth_secret, recovered } = data;

            // Store credentials in SecureStore
            await this.setAuthSecret(auth_secret, user_id);
            console.log(`[RelayAPI] Relay credentials ${recovered ? 'recovered' : 'created'} for user:`, user_id);

            // round-robin fairness: the relay DEFINITIVELY placed this device on the address's
            // account (recovered, or owner-missing → a fresh account), so THIS account may now sign
            // the registration address proof. Never written on any failure path above.
            await this.recordAddressProofAuthorization({ address: walletAddress, userId: user_id });

            // [Group 5 / M-3] Record successful recovery for the throttle.
            // Only set on success, so a failed recovery does not start the
            // throttle window.
            this.lastRecoveryAt = Date.now();

            // Register FCM token if available
            try {
                const fcmToken = await NotificationService.getPushToken();
                if (fcmToken) {
                    await this.registerFCMToken(fcmToken, biometricAction);
                }
            } catch (err) {
                console.warn('[RelayAPI] Failed to register FCM token after recovery:', err);
            }

            return { userId: user_id, authSecret: auth_secret, recovered };

        }, biometricAction);
    }

    /**
     * Register FCM token with the backend for push notifications.
     *
     * [M-43] Retries up to 3 times on failure with exponential backoff
     * (1s, 2s, 4s) before giving up. FCM registration failure is
     * non-critical and never throws; the worst-case outcome is that
     * push notifications are missed until the next registration attempt.
     */
    async registerFCMToken(fcmToken: string, biometricAction?: BiometricAction): Promise<void> {
        const userId = await this.getUserId();
        if (!userId) {
            throw new Error('User not registered');
        }

        const maxAttempts = 3;
        const backoffMs = [1000, 2000, 4000];

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            let succeeded = false;
            let failureReason = '';

            try {
                const response = await this.makeAuthenticatedRequest(
                    `/v1/users/${userId}/fcm-token`,
                    {
                        method: 'POST',
                        body: JSON.stringify({ fcm_token: fcmToken, language: i18next.resolvedLanguage ?? i18next.language ?? 'en' }),
                    }, undefined, biometricAction
                );

                if (response.ok || response.status === 204) {
                    succeeded = true;
                } else {
                    failureReason = `http_${response.status}`;
                    // Respect an explicit rate-limit signal: retrying immediately
                    // just burns the dedicated fcm-token bucket for no benefit.
                    // Registration is non-critical and re-attempts on the next
                    // genuine token event.
                    if (response.status === 429) {
                        console.warn(
                            '[RelayAPI] FCM token registration rate-limited (429); backing off until the next token event',
                        );
                        return;
                    }
                }
            } catch (err) {
                failureReason = `network_${err instanceof Error ? err.message : String(err)}`;
            }

            if (succeeded) {
                if (attempt > 1) {
                    console.log(`[RelayAPI] FCM token registered on attempt ${attempt}`);
                } else {
                    console.log('[RelayAPI] FCM token registered');
                }
                return;
            }

            if (attempt < maxAttempts) {
                console.warn(
                    `[RelayAPI] FCM token registration attempt ${attempt}/${maxAttempts} failed (${failureReason}); retrying in ${backoffMs[attempt - 1]}ms`,
                );
                await new Promise((resolve) => setTimeout(resolve, backoffMs[attempt - 1]));
            } else {
                console.warn(
                    `[RelayAPI] FCM token registration failed after ${maxAttempts} attempts (last reason: ${failureReason}); push notifications may be delayed until next registration`,
                );
            }
        }
    }

    /**
     * Ensure the device holds relay credentials.
     *
     * With a wallet on the device, the credentials come from the wallet's OWN account via a
     * wallet-signature recovery, never from `registerUser()`: `POST /v1/users` always mints a
     * blank account, and a recovered wallet signed in as one reads a confident 0 PEs / 0 PVT
     * (the push registrar in App.tsx fired this the moment a restore set onboardingComplete,
     * on a fresh device that had no secret yet). Only a device with no wallet registers fresh.
     */
    async ensureRegistered(biometricAction?: BiometricAction): Promise<void> {
        if (await this.isRegistered()) return;
        const { useWalletStore } = await import('../store/walletStore');
        const walletAddress = useWalletStore.getState().address;
        if (walletAddress) {
            assertBiometricAction(biometricAction); // Background registration waits for the next unlock.
            await this.recoverRelayCredentials(walletAddress, biometricAction);
            return;
        }
        await this.registerUser(biometricAction);
    }

    // SECURITY FIX: C-1 - Generate fresh signed token per request
    private async makeAuthenticatedRequest(
        endpoint: string,
        options: RequestInit & { timeoutMs?: number; privateBodyBuilder?: (secret: string) => string } = {},
        retryOnAuth: boolean = true, biometricAction?: BiometricAction
    ): Promise<Response> {
        // a caller that asks the relay to hold the request (a burn awaiting inclusion on Base)
        // raises the client timeout; everything else keeps the 15 s default.
        const originalEndpoint = endpoint;
        const { timeoutMs = 15_000, privateBodyBuilder, ...init } = options;
        let secret = await this.getAuthSecret();

        // Auto-recover if not authenticated - use wallet-ownership proof to
        // retrieve the EXISTING relay account rather than creating a new one.
        // registerUser() must NEVER be called here; it would silently overwrite
        // legitimate credentials with a blank ghost account on any 401/cold start.
        if (!secret) {
            if (retryOnAuth) {
                try {
                    const { useWalletStore } = await import('../store/walletStore');
                    const walletAddress = useWalletStore.getState().address;
                    if (walletAddress) {
                        console.log('[RelayAPI] No auth secret - recovering relay credentials via wallet signature...');
                        assertBiometricAction(biometricAction);
                        await this.recoverRelayCredentials(walletAddress, biometricAction);
                    } else {
                        // Genuinely new user (no wallet yet) - safe to register fresh
                        console.log('[RelayAPI] No auth secret and no wallet address - registering new user...');
                        await this.registerUser(biometricAction);
                    }
                    secret = await this.getAuthSecret();
                } catch (err) {
                    console.error('[RelayAPI] Credential recovery failed:', err);
                }
            }
            if (!secret) {
                throw new Error('Not authenticated');
            }
        }

        if(endpoint.split('?')[0].endsWith('/mailbox')&&endpoint.includes('?')){
            const [path,query]=endpoint.split('?');const values=Object.fromEntries(new URLSearchParams(query));
            endpoint=path+'?private_query='+encodeURIComponent(JSON.stringify(sealPrivatePricing({request:values},secret,'provian-private-request:v1:'+path)));
        }
        // Generate a request-bound signed token (method, path, body hash)
        const method = (init.method || 'GET').toUpperCase();
        let bodyStr = privateBodyBuilder ? privateBodyBuilder(secret) : typeof init.body === 'string' ? init.body : '';
        if(privateBodyBuilder)init.body=bodyStr;
        const privatePath=endpoint.split('?')[0];
        if(bodyStr&&(privatePath.startsWith('/v1/meter/')||privatePath==='/v1/archive/mobile/parts'||(privatePath==='/v1/wallet/present'||privatePath==='/v1/wallet/present/preflight'))){
            const original=JSON.parse(bodyStr);
            if(!original.private_batch&&!original.private_request)bodyStr=JSON.stringify({private_request:sealPrivatePricing({request:original},secret,'provian-private-request:v1:'+privatePath)});
            init.body=bodyStr;
        }
        const signedToken = await this.generateSignedToken(method, endpoint, bodyStr, secret);
        if (!signedToken) {
            console.error('[RelayAPI] generateSignedToken() returned null/undefined - auth secret may be invalid');
            throw new Error('Failed to generate signed auth token');
        }

        const url = await this.getBackendUrl();
        console.log(`[RelayAPI] ${method} ${url}${endpoint}`);
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${signedToken}`,
            ...init.headers,
        };

        // Timeout to prevent indefinite hangs (15 s unless the caller asked the relay to hold)
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        let response: Response;
        try {
            response = await apiFetch(`${url}${endpoint}`, {
                ...init,
                headers,
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timeoutId);
        }

        // SECURITY FIX: G-5 - On 401, recover via wallet signature (NOT registerUser).
        // registerUser() creates a blank new account and overwrites existing credentials -
        // it must never be called in response to a 401 from an established session.
        if (response.status === 401 && retryOnAuth) {
            try {
                const { useWalletStore } = await import('../store/walletStore');
                const walletAddress = useWalletStore.getState().address;
                if (walletAddress) {
                    // Deduplicate concurrent recovery calls. All 401 handlers
                    // await the same promise to prevent thundering herd where
                    // each recovery rotates the auth secret and invalidates others.
                    console.log('[RelayAPI] Got 401, recovering relay credentials via wallet signature');
                    assertBiometricAction(biometricAction);
                    await this.recoverRelayCredentials(walletAddress, biometricAction);
                    return this.makeAuthenticatedRequest(originalEndpoint, options, false, biometricAction);
                } else {
                    // No wallet address: genuinely new/uninitialized device, safe to register.
                    // This path is rate-limited (G-5) since it creates new accounts.
                    const canRetry = await this.checkRegistrationRateLimit();
                    if (!canRetry) {
                        console.warn('[RelayAPI] Got 401 but registration rate limit exceeded, not retrying');
                        return response;
                    }
                    console.log('[RelayAPI] Got 401 with no wallet, registering new user');
                    await this.recordRegistrationAttempt();
                    await this.registerUser(biometricAction);
                    return this.makeAuthenticatedRequest(originalEndpoint, options, false, biometricAction);
                }
            } catch (err) {
                // [Group 5 / M-3] If recovery is throttled, do not loop. Return
                // the original 401 so the caller can surface a session error
                // and prompt the user to reopen the app, breaking the
                // attacker-driven recovery storm.
                if (err instanceof RecoveryThrottledError) {
                    console.warn('[RelayAPI] 401 recovery throttled, returning original 401');
                    return response;
                }
                console.error('[RelayAPI] 401 recovery failed:', err);
                return response;
            }
        }

        return response;
    }

    // =========================================================================
    // Connection Token Management
    // =========================================================================

    /**
     * Generate a new connection token for the Connect Agent screen.
     * Returns a human-readable token like "PROV-A3X9-K7M2".
     *
     * @param recoveryAnchorPubkey optional base64url of the 32-byte x25519 anchor
     *   PUBLIC key minted on this phone at invite time (two-touch onboarding). The
     *   relay stores it so the agent can seal a recoverable copy of its wallet key
     *   to it; the SECRET half never leaves the phone's cloud-backed keychain.
     */
    async generateConnectionToken(
        label?: string,
        recoveryAnchorPubkey?: string, biometricAction?: BiometricAction,
    ): Promise<ConnectionTokenResponse> {
        const body: { label?: string; recovery_anchor_pubkey?: string } = { label };
        if (recoveryAnchorPubkey) body.recovery_anchor_pubkey = recoveryAnchorPubkey;
        const response = await this.makeAuthenticatedRequest('/v1/relay/connection-token', {
            method: 'POST',
            body: JSON.stringify(body),
        }, undefined, biometricAction);

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || 'Failed to generate connection token');
        }

        return response.json();
    }

    /**
     * Read this agent's recovery escrow (GET /v1/agent/wallet/:id/recovery-escrow).
     * Wallet auth; the relay additionally verifies the caller is the agent's
     * linked human. Returns the OPAQUE ciphertext + the anchor pubkey to look the
     * phone-held anchor secret up by. On any non-2xx it returns a code (never
     * thrown, never shown raw) for mapAgentOnboardingError to humanise.
     */
    async getRecoveryEscrow(walletId: string, biometricAction?: BiometricAction): Promise<RecoveryEscrowResult> {
        try {
            const response = await this.makeAuthenticatedRequest(
                `/v1/agent/wallet/${encodeURIComponent(walletId)}/recovery-escrow`, undefined, undefined, biometricAction
            );
            const data = (await response.json().catch(() => ({}))) as Partial<RecoveryEscrowResponse> & {
                error?: string;
            };
            if (!response.ok) {
                return { ok: false, code: data.error || `http_${response.status}` };
            }
            if (
                typeof data.sealed_key_blob !== 'string' ||
                typeof data.recovery_anchor_pubkey !== 'string'
            ) {
                return { ok: false, code: 'malformed_escrow_response' };
            }
            return {
                ok: true,
                escrow: {
                    wallet_id: String(data.wallet_id ?? walletId),
                    sealed_key_blob: data.sealed_key_blob,
                    recovery_anchor_pubkey: data.recovery_anchor_pubkey,
                    blob_version: Number(data.blob_version ?? 0),
                    created_at: Number(data.created_at ?? 0),
                    updated_at: Number(data.updated_at ?? 0),
                },
            };
        } catch (err) {
            return { ok: false, code: err instanceof Error ? err.message : 'network_error' };
        }
    }

    /**
     * recovery re-key: re-key a linked agent whose OLD signing key is lost
     * (no at-rest secret, no escrow to unseal). The phone generates a fresh key,
     * escrows it to a new anchor, and proves possession; this call authorizes the
     * identity swap with the caller's (linked human's) wallet auth. The relay
     * returns the rotated API credentials the phone hands to the agent machine.
     */
    async recoveryRekey(
        walletId: string,
        body: {
            new_address: string;
            new_public_key: string;
            proof_of_new_key: string;
            timestamp: number;
            sealed_key_blob: string;
            recovery_anchor_pubkey: string;
        }, biometricAction?: BiometricAction,
    ): Promise<
        | { ok: true; new_address: string; old_address: string; api_key: string; api_secret: string }
        | { ok: false; code: string }
    > {
        try {
            const response = await this.makeAuthenticatedRequest(
                `/v1/agent/wallet/${encodeURIComponent(walletId)}/recovery-rekey`,
                { method: 'POST', body: JSON.stringify(body) },
                false, biometricAction
            );
            const data = (await response.json().catch(() => ({}))) as {
                new_address?: string; old_address?: string; api_key?: string; api_secret?: string;
                error?: string; reason?: string;
            };
            if (!response.ok) {
                return { ok: false, code: data.error || data.reason || `http_${response.status}` };
            }
            if (typeof data.new_address !== 'string' || typeof data.api_key !== 'string' || typeof data.api_secret !== 'string') {
                return { ok: false, code: 'malformed_rekey_response' };
            }
            return {
                ok: true,
                new_address: data.new_address,
                old_address: String(data.old_address ?? ''),
                api_key: data.api_key,
                api_secret: data.api_secret,
            };
        } catch (err) {
            return { ok: false, code: err instanceof Error ? err.message : 'network_error' };
        }
    }

    /**
     * The launch switch : `GET /v1/wallet/launch-state` answers
     * `{ launched, mcp_url }` from the relay's `PUBLIC_LAUNCH`, the same value that opens
     * `/mcp`. The Connect screen's MCP / SDK / fleet options and the Devices note read it, so
     * the app needs no edit at the flip. null when the read fails (the caller keeps what it had).
     */
    async getLaunchState(biometricAction?: BiometricAction): Promise<unknown | null> {
        try {
            const { endpoint, options } = this.noCacheGet('/v1/wallet/launch-state');
            const response = await this.makeAuthenticatedRequest(endpoint, options, undefined, biometricAction);
            if (!response.ok) return null;
            return await response.json();
        } catch {
            return null;
        }
    }

    // =========================================================================
    // Registered Devices
    // =========================================================================

    /**
     * List registered devices for the current wallet.
     * Devices are coding tools (Claude Code, Cursor, etc.) that submit PEs.
     */
    async getRegisteredDevices(biometricAction?: BiometricAction): Promise<RegisteredDevice[]> {
        try {
            return await this.getRegisteredDevicesOrThrow(biometricAction);
        } catch {
            return [];
        }
    }

    /**
     * The same read as getRegisteredDevices(), but a failure THROWS instead of
     * reading as "zero devices". For screens that show a device COUNT (Agent Hub):
     * an unknown count must never render as 0.
     */
    async getRegisteredDevicesOrThrow(biometricAction?: BiometricAction): Promise<RegisteredDevice[]> {
        const response = await this.makeAuthenticatedRequest('/v1/devices', undefined, undefined, biometricAction);
        if (!response.ok) throw new Error(`Devices request failed: HTTP ${response.status}`);
        const data = await response.json() as { devices?: RegisteredDevice[] };
        return Array.isArray(data.devices) ? data.devices : [];
    }

    // =========================================================================
    // Forge Witness Connectors (Witness 3, wallet-auth variants) - B3
    // =========================================================================

    /**
     * Start the phone-initiated GitHub App install handoff. Generates the
     * 32-byte state nonce locally, registers the pending connect session
     * with the relay, and returns the github.com install URL to open in the
     * system browser. Poll with pollGitHubForgeConnect(state) afterwards.
     *
     * Not-configured relays (the GitHub App is not registered yet) surface
     * as { ok: false, code: 'github_connect_not_configured' } so the screen
     * can explain rather than error.
     */
    async githubIdentityLink(state?: string): Promise<Record<string, unknown> & { ok: boolean }> {
        try {
            const response = await this.makeAuthenticatedRequest(`/v1/github-identity/${state ? 'poll' : 'start'}`,
                { method: 'POST', body: JSON.stringify(state ? { state } : {}) });
            const data = await response.json() as Record<string, unknown>;
            return { ...data, ok: response.ok };
        } catch { return { ok: false }; }
    }

    async startGitHubForgeConnect(biometricAction?: BiometricAction): Promise<GitHubConnectStart> {
        const state = bytesToHex(await Crypto.getRandomBytesAsync(32));
        try {
            const response = await this.makeAuthenticatedRequest(
                '/v1/witnesses/github/connect/wallet/start',
                { method: 'POST', body: JSON.stringify({ state }) }, undefined, biometricAction
            );
            const data = (await response.json().catch(() => ({}))) as {
                install_url?: string; expires_at?: number; error?: string;
            };
            if (!response.ok || typeof data.install_url !== 'string') {
                return {
                    ok: false,
                    status: response.status,
                    code: data.error || `http_${response.status}`,
                };
            }
            return {
                ok: true,
                state,
                installUrl: data.install_url,
                expiresAt: data.expires_at ?? 0,
            };
        } catch (err) {
            return { ok: false, status: 0, code: err instanceof Error ? err.message : 'network_error' };
        }
    }

    /**
     * Poll the pending GitHub connect session until the relay has recorded
     * the install ('completed') or the 5-minute state TTL lapses ('expired').
     */
    async pollGitHubForgeConnect(state: string, biometricAction?: BiometricAction): Promise<GitHubConnectPoll> {
        try {
            const response = await this.makeAuthenticatedRequest(
                `/v1/witnesses/github/connect/wallet/poll?state=${encodeURIComponent(state)}`, undefined, undefined, biometricAction
            );
            const data = (await response.json().catch(() => ({}))) as {
                status?: string; install_id?: string; pe_id?: string; error?: string;
            };
            if (
                !response.ok
                || (data.status !== 'pending' && data.status !== 'completed' && data.status !== 'expired')
            ) {
                return {
                    ok: false,
                    status: response.status,
                    code: data.error || `http_${response.status}`,
                };
            }
            return { ok: true, status: data.status, installId: data.install_id, peId: data.pe_id };
        } catch (err) {
            return { ok: false, status: 0, code: err instanceof Error ? err.message : 'network_error' };
        }
    }

    /**
     * Register a GitLab project (numeric id) or Bitbucket repository (UUID)
     * under this wallet so inbound webhook deliveries attribute to it.
     *
     * The relay's response carries the ONE-TIME per-install webhook secret
     * exactly when this call minted it (B2): surface `webhookSecret`
     * immediately - it is never returned again. `webhookSecretAlreadyIssued`
     * means an active registration already holds one; rotation is revoke +
     * re-register.
     */
    async registerForgeInstall(
        provider: 'gitlab' | 'bitbucket',
        installationId: string, biometricAction?: BiometricAction,
    ): Promise<ForgeRegisterResult> {
        const body = provider === 'gitlab'
            ? { project_id: installationId }
            : { repo_uuid: installationId };
        try {
            const response = await this.makeAuthenticatedRequest(
                `/v1/witnesses/${provider}/wallet/installs`,
                { method: 'POST', body: JSON.stringify(body) }, undefined, biometricAction
            );
            const data = (await response.json().catch(() => ({}))) as {
                linked?: boolean; project_id?: string; repo_uuid?: string; pe_id?: string | null;
                webhook_secret?: string | null; webhook_secret_already_issued?: boolean;
                setup?: string; error?: string;
            };
            if (!response.ok || data.linked !== true) {
                return {
                    ok: false,
                    status: response.status,
                    code: data.error || `http_${response.status}`,
                };
            }
            return {
                ok: true,
                installationId: data.project_id ?? data.repo_uuid ?? installationId,
                peId: data.pe_id ?? null,
                webhookSecret: data.webhook_secret ?? null,
                webhookSecretAlreadyIssued: data.webhook_secret_already_issued === true,
                setup: data.setup ?? '',
            };
        } catch (err) {
            return { ok: false, status: 0, code: err instanceof Error ? err.message : 'network_error' };
        }
    }

    /**
     * List this wallet's forge service installs across all providers
     * (active and revoked). Returns [] on any failure - callers treat the
     * list as best-effort status input, like getRegisteredDevices().
     */
    async listForgeInstalls(biometricAction?: BiometricAction): Promise<ForgeInstall[]> {
        try {
            const response = await this.makeAuthenticatedRequest('/v1/witnesses/installs', undefined, undefined, biometricAction);
            if (!response.ok) return [];
            const data = (await response.json().catch(() => ({}))) as { installs?: ForgeInstall[] };
            return Array.isArray(data.installs) ? data.installs : [];
        } catch {
            return [];
        }
    }

    /**
     * Revoke a forge service install. The relay stops honoring deliveries
     * for it (webhook returns 410); for GitHub the user separately removes
     * the App on github.com. For GitLab/Bitbucket, revoke + re-register is
     * the webhook-secret rotation path.
     */
    async revokeForgeInstall(
        provider: ForgeInstallProvider,
        installationId: string, biometricAction?: BiometricAction,
    ): Promise<{ ok: boolean; code?: string }> {
        try {
            const response = await this.makeAuthenticatedRequest(
                `/v1/witnesses/installs/${provider}/${encodeURIComponent(installationId)}/revoke`,
                { method: 'POST', body: JSON.stringify({}) }, undefined, biometricAction
            );
            const data = (await response.json().catch(() => ({}))) as {
                revoked?: boolean; error?: string;
            };
            if (!response.ok || data.revoked !== true) {
                return { ok: false, code: data.error || `http_${response.status}` };
            }
            return { ok: true };
        } catch (err) {
            return { ok: false, code: err instanceof Error ? err.message : 'network_error' };
        }
    }

    // -----------------------------------------------------------------------
    // Git identity → wallet mappings (Part 2, owner side). The owner's
    // wallet auth VOUCHES a contributor's registration; the agent signs it.
    // -----------------------------------------------------------------------

    /**
     * Every mapping this wallet vouched (the owner's Contributors view).
     * Returns null on any failure so the screen can distinguish "none" from
     * "could not load".
     */
    async listAuthorMappings(biometricAction?: BiometricAction): Promise<{ ownerWalletId: string; mappings: AuthorMapping[] } | null> {
        try {
            const response = await this.makeAuthenticatedRequest('/v1/agent-attribution/author-mappings', undefined, undefined, biometricAction);
            if (!response.ok) return null;
            const data = (await response.json().catch(() => ({}))) as {
                source_owner_wallet_id?: string; mappings?: AuthorMapping[];
            };
            if (typeof data.source_owner_wallet_id !== 'string') return null;
            return {
                ownerWalletId: data.source_owner_wallet_id,
                mappings: Array.isArray(data.mappings) ? data.mappings : [],
            };
        } catch {
            return null;
        }
    }

    /**
     * Issue an owner-vouched challenge naming a contributor agent + git author
     * key on one of this wallet's installs. The AGENT completes it under its own
     * auth (`register-git-identity --challenge <id>`); the signature never
     * passes through this phone. Relay refusals surface as codes:
     * install_not_found / install_revoked / install_forge_account_unknown /
     * "active agent_wallet_id with public_key is required".
     */
    async issueAuthorMappingChallenge(params: {
        provider: ForgeInstallProvider;
        installationId: string;
        agentWalletId: string;
        authorKeyType: 'email' | 'username';
        authorKey: string;
    }, biometricAction?: BiometricAction): Promise<AuthorMappingChallengeResult> {
        try {
            const response = await this.makeAuthenticatedRequest(
                '/v1/agent-attribution/author-mappings/challenge',
                {
                    method: 'POST',
                    body: JSON.stringify({
                        provider: params.provider,
                        installation_id: params.installationId,
                        agent_wallet_id: params.agentWalletId,
                        author_key_type: params.authorKeyType,
                        author_key: params.authorKey,
                    }),
                }, undefined, biometricAction
            );
            const data = (await response.json().catch(() => ({}))) as {
                challenge_id?: string; expires_at?: number; forge_account_id?: string;
                installation_id?: string; source_owner_wallet_id?: string; error?: string;
            };
            if (!response.ok || typeof data.challenge_id !== 'string') {
                return { ok: false, status: response.status, code: data.error || `http_${response.status}` };
            }
            return {
                ok: true,
                challengeId: data.challenge_id,
                expiresAt: data.expires_at ?? 0,
                forgeAccountId: data.forge_account_id ?? '',
                installationId: data.installation_id ?? params.installationId,
                sourceOwnerWalletId: data.source_owner_wallet_id ?? '',
            };
        } catch (err) {
            return { ok: false, status: 0, code: err instanceof Error ? err.message : 'network_error' };
        }
    }

    /** Revoke a mapping this wallet vouched. Idempotent on an already-revoked row. */
    async revokeAuthorMapping(mappingId: string, biometricAction?: BiometricAction): Promise<{ ok: boolean; code?: string }> {
        try {
            const response = await this.makeAuthenticatedRequest(
                `/v1/agent-attribution/author-mappings/${encodeURIComponent(mappingId)}`,
                { method: 'DELETE' }, undefined, biometricAction
            );
            const data = (await response.json().catch(() => ({}))) as { revoked?: boolean; error?: string };
            if (!response.ok || data.revoked !== true) {
                return { ok: false, code: data.error || `http_${response.status}` };
            }
            return { ok: true };
        } catch (err) {
            return { ok: false, code: err instanceof Error ? err.message : 'network_error' };
        }
    }

    /**
     * Register human wallet with the backend for PVT minting.
     * Creates a wallets doc + the wallet_created birth-certificate PE + accrual
     * (the relay does all three in this one idempotent call).
     * Idempotent - returns existing wallet if already registered.
     * @returns true if the relay confirmed registration (2xx), false otherwise.
     */
    async registerHumanWallet(
        address: string,
        options?: { allowAddressProof?: boolean; identityRetried?: boolean }, biometricAction?: BiometricAction,
    ): Promise<boolean> {
        try {
            // a NEW registration must prove control of the address; an existing one
            // replays proof-free. Try without a proof, and sign only on 428 address_proof_required
            // so a wallet registered before never prompts for anything.
            const response = await registerWithAddressProof(
                (addressProof) => this.makeAuthenticatedRequest('/v1/wallet/human/register', {
                    method: 'POST',
                    body: JSON.stringify({
                        publicKey: address,
                        address,
                        ...(addressProof === null ? {} : { address_proof: addressProof }),
                    }),
                }, undefined, biometricAction),
                () => this.authorizedAddressProof(address, options?.allowAddressProof !== false, biometricAction),
            );
            if (response.ok) {
                console.log('[RelayAPI] Human wallet registered');
                // Narrow a fresh-address authorization to the account that now holds the address.
                const boundUserId = await this.getUserId();
                if (boundUserId) await this.recordAddressProofAuthorization({ address, userId: boundUserId });
                // Persist the relay `wallets` doc id (idempotent — the endpoint
                // returns the existing id on a repeat call). Needed for per-wallet
                // reads such as genesis status, which the route gates by doc-id
                // ownership, not by user_id.
                try {
                    const data = await response.json() as { walletId?: string; firstEnvelope?: unknown };
                    if (data?.walletId) {
                        await AsyncStorage.setItem(RELAY_WALLET_ID_KEY, data.walletId);
                    }
                    // PE METER: the relay returns the person's own `wallet_created` PE v2 and keeps
                    // no copy (and no mailbox copy exists yet). Hand it to the PE store, which files
                    // it (idempotent by pe_id) so it lands in the person's iCloud / Drive backup.
                    if (data?.firstEnvelope !== undefined && data.firstEnvelope !== null) {
                        const { stageRelayAuthoredPe } = await import('../core/meter/relayAuthoredInbox');
                        await stageRelayAuthoredPe(data.firstEnvelope, 'wallet_register');
                    }
                } catch {
                    // Non-fatal: registration succeeded; the id can be resolved later.
                }
                return true;
            }
            // 409 `human_wallet_registration_index_invalid`: this device's relay account already
            // holds a registration for a DIFFERENT wallet (it kept a previous wallet's credentials
            // through a restore). The address's own account is reached by a wallet-signature
            // recovery; do that once and retry. Not when the relay already placed this account on
            // the address (a real relay-side conflict, never looped), and not for a caller that just
            // saw recovery fail (`allowAddressProof: false`).
            if (response.status === 409
                && options?.identityRetried !== true
                && options?.allowAddressProof !== false) {
                let code: unknown = null;
                try {
                    code = ((await response.clone().json()) as { error?: unknown })?.error;
                } catch {
                    code = null;
                }
                if (code === 'human_wallet_registration_index_invalid'
                    && !(await this.isAddressProofAuthorized(address))) {
                    console.warn('[RelayAPI] Relay account holds another wallet; recovering this wallet\'s account');
                    try {
                        await this.recoverRelayCredentials(address, biometricAction);
                    } catch (err) {
                        console.warn('[RelayAPI] Recovery for the restored wallet failed (will retry):', err);
                        return false;
                    }
                    return this.registerHumanWallet(address, { ...options, identityRetried: true }, biometricAction);
                }
            }
            console.warn('[RelayAPI] Wallet registration returned', response.status);
            return false;
        } catch (err) {
            console.warn('[RelayAPI] Wallet registration failed (will retry):', err);
            return false;
        }
    }

    /**
     * round-robin fairness: record that `userId` (or, for a freshly generated address, whatever
     * account this device holds — `userId: null`) may sign the registration proof for `address`.
     * Call ONLY on a definitive recovery answer or right after generating a brand-new wallet.
     */
    async recordAddressProofAuthorization(auth: AddressProofAuthorization): Promise<void> {
        try {
            await AsyncStorage.setItem(ADDRESS_PROOF_AUTH_KEY, encodeAddressProofAuthorization(auth));
        } catch (err) {
            console.warn('[RelayAPI] Could not record address-proof authorization:', err);
        }
    }

    private async isAddressProofAuthorized(address: string): Promise<boolean> {
        try {
            return addressProofAuthorized(
                await AsyncStorage.getItem(ADDRESS_PROOF_AUTH_KEY),
                await this.getUserId(),
                address,
            );
        } catch {
            return false;
        }
    }

    /**
     * round-robin fairness: the proof for a 428, or null (nothing binds). A proof can displace an
     * UNPROVEN registration of the address — possibly the key holder's own intact legacy account —
     * so it is signed only for an account the relay DEFINITIVELY placed on this address. With no
     * such record, recovery is run first (e.g. the launch backstop after an earlier transient
     * failure) and the proof is signed only if THAT recovery resolves; a caller that has just seen
     * recovery fail passes `allowed: false` and nothing is signed.
     */
    private async authorizedAddressProof(
        address: string,
        allowed: boolean,
        biometricAction?: BiometricAction,
    ): Promise<HumanWalletAddressProof | null> {
        return authorizedAddressProof({
            allowed: allowed && isBiometricActionValid(biometricAction),
            isAuthorized: () => this.isAddressProofAuthorized(address),
            recover: () => this.recoverRelayCredentials(address, biometricAction),
            sign: () => this.signHumanWalletAddressProof(address, biometricAction),
        });
    }

    /**
     * sign the human-wallet registration address proof with the BIP-39 EVM key, under a
     * biometric session (the same pattern as the relay-recovery EIP-712 above). The relay rebuilds
     * the message from this request's auth context (user id + device id), so both come from the
     * same source the signed wallet-auth token uses.
     */
    private async signHumanWalletAddressProof(address: string, biometricAction?: BiometricAction): Promise<HumanWalletAddressProof> {
        const userId = await this.getUserId();
        const deviceId = await this.getDeviceId();
        if (!userId || !deviceId) throw new Error('relay identity unavailable for address proof');
        const { default: SeedManager } = await import('../core/wallet/SeedManager');
        const { ethers } = await import('ethers');
        return await withBiometricAction(translate('biometricPrompts.confirmWalletWithProvian', 'Confirm your wallet with Provian'), async (biometricAction) => {
            assertBiometricAction(biometricAction);
            const signer = new ActionWallet(await SeedManager.getEVMPrivateKey(biometricAction), biometricAction);
            if (signer.address.toLowerCase() !== address.toLowerCase()) {
                throw new Error('wallet key does not match the address being registered');
            }
            return signHumanWalletAddressProof(signer, { userId, address, deviceId, nowMs: Date.now() });

        }, biometricAction);
    }

    /**
     * Ensure the human wallet is registered with the relay - self-healing.
     *
     * Recovery/import users never pass through BiometricSetupScreen (the only
     * other registration call site). A network blip can also leave a wallet's record
     * (wallets doc + wallet_created PE + accrual) absent from the relay. Call this on every app
     * launch: it's idempotent server-side
     * and skipped locally once the relay has confirmed registration for this
     * address, so the steady-state cost is a single AsyncStorage read.
     */
    async ensureHumanWalletRegistered(
        address: string,
        options?: { allowAddressProof?: boolean }, biometricAction?: BiometricAction,
    ): Promise<boolean> {
        try {
            // Confirmed for this address ON this relay account. Keyed by both, so a device that
            // ended up signed in as some other account (a blank one minted after a restore, or a
            // previous wallet's) re-runs registration, which reaches the address's own account
            // (428 → recovery, or 409 → recovery) instead of skipping forever.
            const done = await AsyncStorage.getItem(HUMAN_WALLET_REG_KEY);
            if (done !== null && done === humanWalletRegistrationMarker(address, await this.getUserId())) return true;
            const ok = await this.registerHumanWallet(address, options, biometricAction);
            if (ok) {
                await AsyncStorage.setItem(HUMAN_WALLET_REG_KEY, humanWalletRegistrationMarker(address, await this.getUserId()));
            }
            return ok;
        } catch (err) {
            console.warn('[RelayAPI] ensureHumanWalletRegistered failed (will retry next launch):', err);
            return false;
        }
    }

    /**
     * Mint a single-use Coinbase Onramp session token (secure initialization).
     * The backend holds the CDP Secret API Key and calls Coinbase; we only
     * receive the short-lived token to drop into the onramp URL.
     * @returns the session token, or null if unavailable (e.g. not configured).
     */
    async getCoinbaseSessionToken(
        address: string,
        assets?: string[], biometricAction?: BiometricAction,
    ): Promise<{ token: string; partnerUserRef: string | null } | null> {
        try {
            const response = await this.makeAuthenticatedRequest('/api/proxy/coinbase/session-token', {
                method: 'POST',
                body: JSON.stringify({ address, assets }),
            }, undefined, biometricAction);
            if (!response.ok) {
                console.warn('[RelayAPI] Coinbase session token returned', response.status);
                return null;
            }
            const data = await response.json();
            if (typeof data?.token !== 'string') {
                return null;
            }
            // partnerUserRef is the stable join key the device attaches to the buy
            // URL so the relay can later confirm the buy on-chain (#30).
            return {
                token: data.token,
                partnerUserRef: typeof data?.partnerUserRef === 'string' ? data.partnerUserRef : null,
            };
        } catch (err) {
            console.warn('[RelayAPI] Coinbase session token failed:', err);
            return null;
        }
    }

    /**
     * Ask the relay to confirm a pending on-ramp deposit actually came from a
     * Coinbase buy (#30). The relay queries the Coinbase Transaction Status API
     * with its CDP Secret key and, on a settled match, SERVER-MINTS a verified
     * `onramp` PE. Returns null when the relay is unreachable / unauthenticated /
     * older (no endpoint) so the caller falls back to the on-device heuristic.
     */
    async verifyCoinbaseBuy(
        address: string,
        sinceMs?: number, biometricAction?: BiometricAction,
    ): Promise<{ verified: boolean; status?: string; txHash?: string | null; peId?: string | null } | null> {
        try {
            const response = await this.makeAuthenticatedRequest('/api/proxy/coinbase/verify-buy', {
                method: 'POST',
                body: JSON.stringify({ address, sinceMs }),
            }, undefined, biometricAction);
            if (!response.ok) {
                return null;
            }
            const data = await response.json();
            if (typeof data?.verified !== 'boolean') {
                return null;
            }
            return {
                verified: data.verified,
                status: typeof data?.status === 'string' ? data.status : undefined,
                txHash: typeof data?.tx_hash === 'string' ? data.tx_hash : null,
                peId: typeof data?.pe_id === 'string' ? data.pe_id : null,
            };
        } catch (err) {
            console.warn('[RelayAPI] Coinbase verify-buy failed:', err);
            return null;
        }
    }

    /**
     * Revoke a registered device. Calls DELETE /v1/devices/:device_id.
     */
    async revokeDevice(deviceId: string, biometricAction?: BiometricAction): Promise<boolean> {
        try {
            const response = await this.makeAuthenticatedRequest(`/v1/devices/${deviceId}`, {
                method: 'DELETE',
            }, undefined, biometricAction);
            return response.ok;
        } catch {
            return false;
        }
    }

    /**
     * Rename a registered device. Calls PATCH /v1/devices/:device_id.
     */
    async renameDevice(deviceId: string, deviceName: string, biometricAction?: BiometricAction): Promise<boolean> {
        try {
            const response = await this.makeAuthenticatedRequest(`/v1/devices/${deviceId}`, {
                method: 'PATCH',
                body: JSON.stringify({ device_name: deviceName }),
            }, undefined, biometricAction);
            return response.ok;
        } catch {
            return false;
        }
    }

    /**
     * Generate a one-time device registration token.
     * Used in Developer Settings to register external devices via CLI.
     */
    async generateDeviceToken(biometricAction?: BiometricAction): Promise<{
        token: string;
        expires_at: number;
        instructions: {
            step_1: string;
            step_2: string;
            relay_url: string;
            note: string;
        };
    }> {
        let response: Response;
        try {
            // retryOnAuth=false: token generation must not trigger re-registration
            response = await this.makeAuthenticatedRequest('/v1/setup/generate-token', {
                method: 'POST',
            }, false, biometricAction);
        } catch (err) {
            console.error('[RelayAPI] generateDeviceToken request failed:', err);
            throw new Error(
                `Request failed: ${err instanceof Error ? err.message : String(err)}`
            );
        }

        let data: Record<string, unknown>;
        try {
            data = await response.json();
        } catch (parseErr) {
            console.error('[RelayAPI] generateDeviceToken response parse failed:', response.status);
            throw new Error(`Server returned ${response.status} with unparseable body`);
        }

        if (!response.ok) {
            const errMsg = (data as { error?: string }).error || `HTTP ${response.status}`;
            console.error('[RelayAPI] generateDeviceToken error response:', response.status, data);
            throw new Error(errMsg);
        }

        return data as {
            token: string;
            expires_at: number;
            instructions: { step_1: string; step_2: string; relay_url: string; note: string };
        };
    }

    /**
     * Start a phone-initiated GitHub App connect session (Witness 3).
     *
     * The caller generates the 32-byte hex state nonce (crypto-secure) and
     * keeps it for polling. The relay records the pending session and
     * returns the github.com install URL with the state attached. The user
     * authorizes ON github.com - no GitHub credential ever touches Provian.
     */
    async startGitHubConnect(
        state: string, biometricAction?: BiometricAction
    ): Promise<{ install_url: string; expires_at: number }> {
        const response = await this.makeAuthenticatedRequest(
            '/v1/witnesses/github/connect/wallet/start',
            {
                method: 'POST',
                body: JSON.stringify({ state }),
            },
            false, biometricAction
        );
        const data = (await response.json()) as {
            install_url?: string;
            expires_at?: number;
            error?: string;
        };
        if (!response.ok || !data.install_url || !data.expires_at) {
            throw new Error(data.error || `HTTP ${response.status}`);
        }
        return { install_url: data.install_url, expires_at: data.expires_at };
    }

    /**
     * Poll a phone-initiated GitHub connect session. On the first poll after
     * the user completes the install on github.com, the relay materializes
     * the service install and emits the service_install_created PE.
     */
    async pollGitHubConnect(
        state: string, biometricAction?: BiometricAction
    ): Promise<{ status: 'pending' | 'completed' | 'expired'; install_id?: string; pe_id?: string }> {
        const response = await this.makeAuthenticatedRequest(
            `/v1/witnesses/github/connect/wallet/poll?state=${state}`,
            { method: 'GET' },
            false, biometricAction
        );
        const data = (await response.json()) as {
            status?: 'pending' | 'completed' | 'expired';
            install_id?: string;
            pe_id?: string;
            error?: string;
        };
        if (!response.ok || !data.status) {
            throw new Error(data.error || `HTTP ${response.status}`);
        }
        return { status: data.status, install_id: data.install_id, pe_id: data.pe_id };
    }

    // =========================================================================
    // Agent Session Management
    // =========================================================================

    /**
     * Get the agents beneficiary-linked to the current user (no sessions).
     */
    async getLinkedAgents(opts?: { throwOnError?: boolean }, biometricAction?: BiometricAction): Promise<{ linked_agents: LinkedAgent[] }> {
        const request = this.linkedAgentsInFlight ?? this.fetchLinkedAgents(biometricAction);
        this.linkedAgentsInFlight = request;
        try {
            return await request;
        } catch (error) {
            console.error('[RelayAPI] Error fetching linked agents:', error);
            if (opts?.throwOnError) throw error;
            return { linked_agents: this.getCachedLinkedAgents() ?? [] };
        } finally {
            if (this.linkedAgentsInFlight === request) this.linkedAgentsInFlight = null;
        }
    }

    private async fetchLinkedAgents(biometricAction?: BiometricAction): Promise<{ linked_agents: LinkedAgent[] }> {
        // relay agent sessions no longer exist; the route path is kept and
        // the response carries ONLY the beneficiary-linked agents.
        // this is a live owner-state read. Express ETags caused iOS
        // URLSession to return 304, and the old `response.ok` branch turned that
        // valid revalidation into `[]`. Use the same cache-busting path already
        // proven for live Promise polling.
        const { endpoint, options } = this.noCacheGet('/v1/relay/agent/sessions');
        const response = await this.makeAuthenticatedRequest(endpoint, options, undefined, biometricAction);
        if (!response.ok) {
            throw new Error(`Linked-agents request failed: HTTP ${response.status}`);
        }
        const data = await response.json() as { linked_agents?: LinkedAgent[] };
        const linkedAgents = Array.isArray(data.linked_agents) ? data.linked_agents : [];
        this.linkedAgentsCache = linkedAgents.map((agent) => ({ ...agent }));
        this.linkedAgentIdentitiesCache = linkedAgents.map((agent) => ({
            wallet_id: agent.wallet_id,
            agent_id: agent.agent_id,
            display_name: agent.display_name,
            address: agent.address,
            platform: agent.platform,
            created_at: agent.created_at,
            solana_address: agent.solana_address ?? null,
            last_pe_date: agent.last_pe_date ?? null,
        }));
        return { linked_agents: linkedAgents };
    }

    /**
     * Fast beneficiary-link truth for Earn. A successful empty array is
     * authoritative; an error throws when requested and never overwrites the
     * last confirmed identities.
     */
    async getLinkedAgentIdentities(opts?: { throwOnError?: boolean }, biometricAction?: BiometricAction): Promise<{ linked_agents: LinkedAgentIdentity[] }> {
        const request = this.linkedAgentIdentitiesInFlight ?? this.fetchLinkedAgentIdentities(biometricAction);
        this.linkedAgentIdentitiesInFlight = request;
        try {
            return await request;
        } catch (error) {
            console.error('[RelayAPI] Error fetching linked-agent identities:', error);
            if (opts?.throwOnError) throw error;
            return { linked_agents: this.getCachedLinkedAgentIdentities() ?? [] };
        } finally {
            if (this.linkedAgentIdentitiesInFlight === request) this.linkedAgentIdentitiesInFlight = null;
        }
    }

    private async fetchLinkedAgentIdentities(biometricAction?: BiometricAction): Promise<{ linked_agents: LinkedAgentIdentity[] }> {
        const { endpoint, options } = this.noCacheGet('/v1/relay/agent/sessions?view=identity');
        const response = await this.makeAuthenticatedRequest(endpoint, options, undefined, biometricAction);
        if (!response.ok) {
            throw new Error(`Linked-agent identity request failed: HTTP ${response.status}`);
        }
        const data = await response.json() as { linked_agents?: LinkedAgentIdentity[] };
        const linkedAgents = Array.isArray(data.linked_agents) ? data.linked_agents : [];
        this.linkedAgentIdentitiesCache = linkedAgents.map((agent) => ({ ...agent }));
        if (this.linkedAgentsCache !== null) {
            const confirmedWalletIds = new Set(linkedAgents.map((agent) => agent.wallet_id));
            // The identity view is authoritative for relationship existence.
            // Prune after a real successful unlink response, never on error.
            this.linkedAgentsCache = this.linkedAgentsCache.filter(
                (agent) => confirmedWalletIds.has(agent.wallet_id),
            );
        }
        return { linked_agents: linkedAgents };
    }

    getCachedLinkedAgents(): LinkedAgent[] | null {
        return this.linkedAgentsCache?.map((agent) => ({ ...agent })) ?? null;
    }

    getCachedLinkedAgentIdentities(): LinkedAgentIdentity[] | null {
        return this.linkedAgentIdentitiesCache?.map((agent) => ({ ...agent })) ?? null;
    }

    /**
     * Fetch the PE activity of an agent this human owns (linked as beneficiary).
     * Reads the agent's real relay PEs (keyed by agent_id) — the human's own
     * history endpoints never surface these — plus the accurate live pe_count.
     * Returns null on any error (caller shows an empty activity state).
     */
    async getAgentPEActivity(agentId: string, limit = 20, biometricAction?: BiometricAction): Promise<AgentPEActivity | null> {
        try {
            const response = await this.makeAuthenticatedRequest(
                `/v1/relay/agent/${encodeURIComponent(agentId)}/pe-activity?limit=${limit}`, undefined, undefined, biometricAction
            );
            if (!response.ok) {
                console.log(`[RelayAPI] agent pe-activity HTTP ${response.status}`);
                return null;
            }
            const data = await response.json() as AgentPEActivity;
            const { getPhoneMeter } = await import('../core/meter/phoneMeterRuntime');
            const meter = getPhoneMeter();
            await meter.start();
            const received = await meter.store.listReceived();
            const entries: AgentPEActivityItem[] = received.filter(item => item.from_actor === agentId).map(item => {
                const pe = item.pe as Readonly<Record<string, unknown>>;
                const actionType = typeof pe.action_type === 'string' ? pe.action_type : null;
                return { peId: item.pe_id, actionType: actionType ?? 'unknown',
                    timestamp: typeof pe.timestamp === 'number' ? pe.timestamp : item.created_at_ms,
                    mintStatus: typeof pe.mint_status === 'string' ? pe.mint_status : null,
                    description: typeof pe.description === 'string' ? pe.description : null,
                    beneficiaryProjectionPvt: null };
            }).sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0)).slice(0, limit);
            return {
                agent_id: data.agent_id,
                pe_count: typeof data.pe_count === 'number' ? data.pe_count : (data.entries?.length ?? 0),
                entries,
                solana_address: data.solana_address ?? null,
                beneficiary: data.beneficiary ?? null,
            };
        } catch (error) {
            console.error('[RelayAPI] Error fetching agent PE activity:', error);
            return null;
        }
    }

    // =========================================================================
    // Network Governance (protocol proposals — not agent governance)
    // =========================================================================

    /**
     * Count active governance proposals. The relay computes effective status at
     * read time, so we fetch the list (no status= filter - computed statuses
     * like 'passed'/'expired' aren't queryable) and count those whose effective
     * status is 'active'. Returns 0 on any failure so the dashboard renders a
     * safe value instead of a misleading hardcoded number.
     */
    async getActiveGovernanceProposalCount(biometricAction?: BiometricAction): Promise<number> {
        try {
            const response = await this.makeAuthenticatedRequest('/v1/governance/proposals', {
                method: 'GET',
            }, undefined, biometricAction);
            if (!response.ok) return 0;
            const data = await response.json();
            const proposals: Array<{ status?: string }> = Array.isArray(data?.proposals)
                ? data.proposals
                : [];
            return proposals.filter((p) => p.status === 'active').length;
        } catch (error) {
            console.error('[RelayAPI] Error fetching governance proposals:', error);
            return 0;
        }
    }

    // =========================================================================
    // Human Security (break-glass recovery canary — not agent governance)
    // =========================================================================

    /**
     * [FIX-8] Send break-glass canary notification to all registered devices.
     * Fire-and-forget - failure must not block the break-glass flow.
     */
    async sendBreakGlassAlert(deviceId?: string, biometricAction?: BiometricAction): Promise<void> {
        try {
            await this.makeAuthenticatedRequest('/v1/security/break-glass-alert', {
                method: 'POST',
                body: JSON.stringify({ device_id: deviceId }),
            }, undefined, biometricAction);
        } catch (error) {
            console.warn('[RelayAPI] Break-glass alert failed (non-fatal):', error);
        }
    }

    // =========================================================================
    // Data Deletion
    // =========================================================================

    /**
     * Request deletion of all user data from the relay backend (`DELETE /v1/user/data`, wallet
     * auth). Called from DeleteAllDataScreen BEFORE anything local is wiped, signed with this
     * device's relay credentials. NO credential recovery runs on this path: a recovery finds no
     * owner for a deleted account and would create a fresh one, orphaning the old data. A 401 is
     * read, never retried (see `DataDeletionOutcome`). The relay pages its deletes, so the client
     * waits up to 60 s rather than the default 15 s. Never throws.
     */
    async requestDataDeletion(): Promise<DataDeletionOutcome> {
        let secret: string | null;
        let userId: string | null;
        try {
            secret = await this.getAuthSecret();
            userId = await this.getUserId();
        } catch (error) {
            console.error('[RelayAPI] Data deletion: credentials unreadable:', error);
            return 'no_access';
        }
        if (!secret || !userId) return 'no_access';
        let response: Response;
        try {
            response = await this.makeAuthenticatedRequest('/v1/user/data', {
                method: 'DELETE',
                timeoutMs: 60_000,
            }, false);
        } catch (error) {
            console.error('[RelayAPI] Data deletion request did not complete:', error);
            return 'unknown';
        }
        if (response.ok) return 'deleted';
        if (response.status === 401) {
            let error: unknown = null;
            try { error = ((await response.json()) as { error?: unknown }).error; } catch { /* no body */ }
            return error === RELAY_AUTH_RECORD_GONE_ERROR ? 'account_gone' : 'no_access';
        }
        return 'not_finished';
    }

    // =========================================================================
    // Provenance Envelopes
    // =========================================================================

    /**
     * Fetch provenance envelopes from the backend.
     */
    async getProvenanceEnvelopes(limit: number = 100, offset: number = 0, biometricAction?: BiometricAction): Promise<any[]> {
        try {
            const response = await this.makeAuthenticatedRequest(
                `/v1/provenance-envelopes?limit=${limit}&offset=${offset}`, undefined, undefined, biometricAction
            );

            if (response.ok) {
                return response.json();
            }

            return [];
        } catch (error) {
            console.error('[RelayAPI] Error fetching PEs:', error);
            return [];
        }
    }

    /**
     * Fetch PE summary records (lightweight - no full payloads).
     * Used for recovery to reconstruct minting history and chain head
     * without treating the relay as a full-payload archive.
     */
    /**
     * Fetch the participation summary via the SIGNED, request-bound auth path.
     * WS6: AbundanceDashboard previously hand-rolled a fetch with the deprecated
     * getAuthToken() (raw secret), which the backend rejected as an invalid setup
     * token (401) — so the secondary engagement stats silently never loaded.
     */
    async getParticipationSummary<T = unknown>(biometricAction?: BiometricAction): Promise<T | null> {
        try {
            const response = await this.makeAuthenticatedRequest('/v1/participation/summary', undefined, undefined, biometricAction);
            if (response.ok) {
                return await response.json();
            }
            return null;
        } catch (error) {
            console.error('[RelayAPI] Error fetching participation summary:', error);
            return null;
        }
    }

    /**
     * Resolve this device's relay `wallets` doc id. Persisted on registration;
     * if absent (e.g. a recovery/import user who registered before we started
     * storing it), re-run the idempotent human-wallet registration to recover
     * it. Returns null when there is no wallet address yet (pre-wallet).
     */
    async getRelayWalletId(biometricAction?: BiometricAction): Promise<string | null> {
        const cached = await AsyncStorage.getItem(RELAY_WALLET_ID_KEY);
        if (cached) return cached;
        try {
            const { useWalletStore } = await import('../store/walletStore');
            const address = useWalletStore.getState().address;
            if (!address) return null;
            // Idempotent: returns the existing doc id and persists it under
            // RELAY_WALLET_ID_KEY via registerHumanWallet's success path.
            await this.registerHumanWallet(address, undefined, biometricAction);
            return await AsyncStorage.getItem(RELAY_WALLET_ID_KEY);
        } catch (error) {
            console.warn('[RelayAPI] Could not resolve relay wallet id:', error);
            return null;
        }
    }

    /**
     * Read this wallet's Genesis campaign progress (Pass-2 #28). Read-only
     * feedback for the Abundance dashboard: funded / first-tx / sustained
     * markers, the next-milestone hint + bounty, and live campaign window/pool.
     * Returns null when not yet resolvable (no wallet) or the campaign read
     * fails — the caller renders nothing rather than erroring.
     */
    async getGenesisStatus(biometricAction?: BiometricAction): Promise<GenesisWalletStatus | null> {
        try {
            const walletId = await this.getRelayWalletId(biometricAction);
            if (!walletId) return null;
            const { endpoint, options } = this.noCacheGet(
                `/v1/genesis/status/${encodeURIComponent(walletId)}`,
            );
            const response = await this.makeAuthenticatedRequest(endpoint, options, undefined, biometricAction);
            if (response.ok) {
                return await response.json() as GenesisWalletStatus;
            }
            console.warn('[RelayAPI] Genesis status returned', response.status);
            return null;
        } catch (error) {
            console.error('[RelayAPI] Error fetching genesis status:', error);
            return null;
        }
    }

    // SECURITY FIX: H-9 - Test endpoint removed from production codebase

    // =========================================================================
    // PE METER — the relay stops storing PEs. The phone keeps every PE,
    // chains it per device, and sends one batch of act records per hour (core/meter/). The
    // retired single-PE route `POST /v1/pe/submit/mobile` (410) is no longer called.
    // =========================================================================

    /** The device id this phone's wallet-auth tokens carry — the device every PE batch must name. */
    async getMeterDeviceId(): Promise<string> {
        return this.getDeviceId();
    }

    /**
     * One meter call under wallet auth (request-bound v2 token: method + path + body hash). Returns
     * the status and parsed body and NEVER interprets them; `status: null` when no HTTP answer
     * arrived (offline, timeout, not signed in yet). A POST body is sent exactly as given — the
     * batcher re-sends identical bytes until it gets a definite answer.
     */
    /** Read-only issuance proof validation. The encrypted request is never retained. */
    async preflightPresentation(body: unknown, biometricAction: BiometricAction): Promise<void> {
        const response=await this.makeAuthenticatedRequest('/v1/wallet/present/preflight',{method:'POST',body:JSON.stringify(body)},undefined,biometricAction);
        const result=await response.json();
        if(!response.ok||result.ok!==true) throw new Error(`presentation_proof_invalid:${result.reason??result.error??'unavailable'}`);
    }

    async meterRequest(method: 'GET' | 'POST', path: string, body?: string, privateBodyBuilder?: (secret: string) => string, biometricAction?: BiometricAction): Promise<MeterAnswer> {
        try {
            const response = await this.makeAuthenticatedRequest(path, {
                method,
                ...(method === 'POST' ? { body: body ?? '' } : {}),
                ...(method === 'GET' ? { headers: { 'Cache-Control': 'no-store' } } : {}),
                timeoutMs: 30_000,
                ...(privateBodyBuilder ? {privateBodyBuilder} : {}),
            }, undefined, biometricAction);
            const text = await response.text().catch(() => '');
            let parsed: unknown = null;
            try {
                parsed = text.length > 0 ? JSON.parse(text) : null;
            } catch {
                parsed = null;
            }
            return { status: response.status, body: parsed, error: response.ok ? null : text.slice(0, 300) };
        } catch (error) {
            return { status: null, body: null, error: error instanceof Error ? error.message : String(error) };
        }
    }

    /**
     * The batch records and anchor proofs of PEs other parties sealed to this person (a linked
     * agent's, another device's, the relay's), by batch hash: `POST /v1/meter/mobile/batch-proofs`
     * with 1..200 lowercase hex64 hashes. The relay drops a batch record 30 days after its anchor,
     * so the meter asks daily and keeps each proof with the received PE. Never throws.
     */
    async meterBatchProofs(batchHashes: readonly string[], actsRoots: readonly string[] = [], biometricAction?: BiometricAction): Promise<MeterAnswer> {
        return this.meterRequest('POST', '/v1/meter/mobile/batch-proofs', JSON.stringify({
            ...(batchHashes.length > 0 ? { batch_hashes: [...batchHashes] } : {}),
            ...(actsRoots.length > 0 ? { acts_roots: [...actsRoots] } : {}),
        }), undefined, biometricAction);
    }

    // =========================================================================
    // Human P2P promises on the relay (replaces the Firestore
    // `promise_sync` side-channel). Every call is wallet-authenticated;
    // agreement phases carry a REAL EIP-191 signature over the promise digest,
    // and terms ride as opaque per-party seed-derived ciphertext the relay
    // cannot read. Each method returns a graceful result and never throws on a
    // network fault, so PromiseService's fire-and-forget + reconcile paths stay
    // robust (mirroring the old offline-returns-false Firestore behavior).
    // =========================================================================

    private async humanPromiseWrite(
        endpoint: string,
        body: Record<string, unknown>, biometricAction?: BiometricAction,
    ): Promise<HumanPromiseWriteResult> {
        try {
            const res = await this.makeAuthenticatedRequest(endpoint, {
                method: 'POST',
                body: JSON.stringify(body),
            }, undefined, biometricAction);
            if (!res.ok) {
                const err = (await res.json().catch(() => ({}))) as { error?: string };
                return { ok: false, httpStatus: res.status, error: err.error };
            }
            const parsed = (await res.json().catch(() => ({}))) as { status?: string; mode?: string };
            return { ok: true, httpStatus: res.status, status: parsed.status, mode: parsed.mode };
        } catch (e) {
            return { ok: false, error: (e as Error)?.message };
        }
    }

    async createHumanPromise(promiseId: string, digest: string, signature: string, termsCiphertext: string, biometricAction?: BiometricAction): Promise<HumanPromiseWriteResult> {
        return this.humanPromiseWrite('/v1/human-promises/create', {
            promise_id: promiseId, digest, signature, terms_ciphertext: termsCiphertext,
        }, biometricAction);
    }

    async acceptHumanPromise(promiseId: string, digest: string, signature: string, termsCiphertext: string, biometricAction?: BiometricAction): Promise<HumanPromiseWriteResult> {
        return this.humanPromiseWrite(`/v1/human-promises/${encodeURIComponent(promiseId)}/accept`, {
            digest, signature, terms_ciphertext: termsCiphertext,
        }, biometricAction);
    }

    async counterHumanPromise(promiseId: string, digest: string, signature: string, termsCiphertext: string, biometricAction?: BiometricAction): Promise<HumanPromiseWriteResult> {
        return this.humanPromiseWrite(`/v1/human-promises/${encodeURIComponent(promiseId)}/counter`, {
            digest, signature, terms_ciphertext: termsCiphertext,
        }, biometricAction);
    }

    async rejectHumanPromise(promiseId: string, biometricAction?: BiometricAction): Promise<HumanPromiseWriteResult> {
        return this.humanPromiseWrite(`/v1/human-promises/${encodeURIComponent(promiseId)}/reject`, {}, biometricAction);
    }

    async closeOutHumanPromise(promiseId: string, signature: string, biometricAction?: BiometricAction): Promise<HumanPromiseWriteResult> {
        return this.humanPromiseWrite(`/v1/human-promises/${encodeURIComponent(promiseId)}/close-out`, { signature }, biometricAction);
    }

    async disputeHumanPromise(promiseId: string, biometricAction?: BiometricAction): Promise<HumanPromiseWriteResult> {
        return this.humanPromiseWrite(`/v1/human-promises/${encodeURIComponent(promiseId)}/dispute`, {}, biometricAction);
    }

    async brokenHumanPromise(promiseId: string, biometricAction?: BiometricAction): Promise<HumanPromiseWriteResult> {
        return this.humanPromiseWrite(`/v1/human-promises/${encodeURIComponent(promiseId)}/broken`, {}, biometricAction);
    }

    /**
     * Build a NON-CACHEABLE GET for live owner-state reads. Express sets an ETag
     * on these responses; iOS URLSession caches the
     * 200 and revalidates with If-None-Match, so an unchanged doc comes back 304
     * (res.ok === false). The old reads returned null on that 304, so once ETags
     * stabilized the subscribe poll went dark — a relay state change (an
     * acceptance, a posted close-out, or a beneficiary link) only reached the app after a cold relaunch
     * (observed live: 175 GET→304 vs 5 GET→200 over 40 min; a creator stuck on
     * "waiting for acceptance" ~9 min while the relay held the accepted doc).
     *
     * A per-request cache-busting query param gives every poll a UNIQUE URL, so
     * URLSession has no cached entry and no stored ETag to revalidate — the relay
     * always answers 200 with the current body. `cache:'no-store'` +
     * `Cache-Control:no-cache` are belt-and-suspenders for runtimes that honor
     * them. This is SAFE for wallet-auth token binding: generateSignedToken and
     * the server both canonicalize the bound path (`pth`) with the query string
     * stripped (see pathBinding.test.ts / wallet-auth.ts), so the cache-buster
     * never enters the signed material and makeAuthenticatedRequest still signs
     * each request. The monotonic seq defeats same-millisecond collisions.
     */
    private noCacheGet(endpoint: string): { endpoint: string; options: RequestInit } {
        const sep = endpoint.includes('?') ? '&' : '?';
        return {
            endpoint: `${endpoint}${sep}_=${Date.now()}.${this.noCacheSeq++}`,
            options: { method: 'GET', cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } },
        };
    }

    /** One promise by id (possession of the id is the read capability). null on absence/offline. */
    async getHumanPromise(promiseId: string, biometricAction?: BiometricAction): Promise<RelayHumanPromiseDocument | null> {
        const r = await this.getHumanPromiseDetailed(promiseId, biometricAction);
        return r.ok ? r.promise : null;
    }

    /**
     * The relay's promise doc, distinguishing "the relay no longer holds it" (404 — purged past
     * its expiry) from "the relay could not be asked" (offline / 5xx): the sync treated both as
     * silence and an accepted promise the relay had purged stayed accepted forever (2026-10-17).
     */
    async getHumanPromiseDetailed(promiseId: string, biometricAction?: BiometricAction): Promise<
        { ok: true; promise: RelayHumanPromiseDocument } | { ok: false; httpStatus?: number }
    > {
        try {
            const { endpoint, options } = this.noCacheGet(`/v1/human-promises/${encodeURIComponent(promiseId)}`);
            const res = await this.makeAuthenticatedRequest(endpoint, options, undefined, biometricAction);
            if (!res.ok) return { ok: false, httpStatus: res.status };
            const body = (await res.json().catch(() => ({}))) as { promise?: RelayHumanPromiseDocument };
            return body.promise ? { ok: true, promise: body.promise } : { ok: false, httpStatus: res.status };
        } catch {
            return { ok: false };
        }
    }

    /** Every promise the caller is a party to (recovery + sync). null on offline/error. */
    async listMyHumanPromises(biometricAction?: BiometricAction): Promise<{ promises: RelayHumanPromiseDocument[]; myAddress: string } | null> {
        try {
            const { endpoint, options } = this.noCacheGet('/v1/human-promises/mine');
            const res = await this.makeAuthenticatedRequest(endpoint, options, undefined, biometricAction);
            if (!res.ok) return null;
            const body = (await res.json().catch(() => ({}))) as { promises?: RelayHumanPromiseDocument[]; my_address?: string };
            return { promises: Array.isArray(body.promises) ? body.promises : [], myAddress: String(body.my_address ?? '') };
        } catch {
            return null;
        }
    }

    // =========================================================================
    // F-A5-1 — Human burn-to-present (the human parallel of the agent
    // CommonsInstitutions.recordBurn / present, on the shared burn substrate + presentation
    // primitive). The human burns PVT from their OWN first-party wallet on-chain
    // (TransactionService.burnPVT), then records the verified burn here; the relay
    // re-verifies the on-chain Transfer(from, 0x0, amount) with expectedFrom bound
    // server-side to the caller's own address (never client-supplied).
    // =========================================================================

    /**
     * Record a VERIFIED first-party PVT burn the human broadcast from their own
     * wallet. `POST /v1/wallet/burn/record`. Returns the burn id the presentation
     * primitive consumes; one burn buys exactly one benefit, globally.
     */
    async recordFirstPartyBurn(params: {
        txHash: string; chain: string; amountAtomic: string;
        /** the relay holds the call until the burn is mined and accepted (~one Base block) instead of refusing early. */
        awaitFinality?: boolean;
    }, biometricAction?: BiometricAction): Promise<{ burnId: string; verified: boolean; idempotent: boolean; finality?: 'provisional' | 'final' }> {
        const response = await this.makeAuthenticatedRequest('/v1/wallet/burn/record', {
            method: 'POST',
            body: JSON.stringify({
                tx_hash: params.txHash,
                chain: params.chain,
                amount_atomic: params.amountAtomic,
                ...(params.awaitFinality ? { await_finality: true } : {}),
            }),
            ...(params.awaitFinality ? { timeoutMs: BURN_HOLD_TIMEOUT_MS } : {}),
        }, undefined, biometricAction);
        if (!response.ok) {
            const err = (await response.json().catch(() => ({}))) as { error?: string; reason?: string };
            throw new Error(err.reason || err.error || `burn record failed (${response.status})`);
        }
        const body = (await response.json()) as { burn_id?: string; verified?: boolean; idempotent?: boolean; finality?: unknown };
        if (typeof body.burn_id !== 'string' || body.burn_id.length === 0) {
            throw new Error('burn/record response missing burn_id');
        }
        return {
            burnId: body.burn_id,
            verified: Boolean(body.verified),
            idempotent: Boolean(body.idempotent),
            // 'provisional' = accepted at inclusion, the relay's finality check pending.
            ...(body.finality === 'provisional' || body.finality === 'final' ? { finality: body.finality } : {}),
        };
    }

    /**
     * §2.9: register this phone's attested App Attest key ONCE (the relay verifies the attestation
     * object against the pinned Apple root). Wallet auth. Returns null on any failure — the caller
     * simply attaches no witness.
     */
    /**
     * Register this phone's DEVICE key (the P-256 PE attestation key, never the wallet key) as its
     * output-signing key: `POST /v1/wallet/output-signing-key` with a proof of possession over
     * `provian-output-key:v1:app:<user_id>:<public key>` (, signed outputs).
     */
    async registerOutputSigningKey(params: { public_key: string; proof: string }, biometricAction?: BiometricAction): Promise<{ registered: boolean } | null> {
        try {
            const response = await this.makeAuthenticatedRequest('/v1/wallet/output-signing-key', {
                method: 'POST',
                body: JSON.stringify(params),
            }, undefined, biometricAction);
            if (!response.ok) {
                const err = (await response.json().catch(() => ({}))) as { error?: string };
                console.log('[RelayAPI] output key register refused:', response.status, err.error ?? '');
                return null;
            }
            const body = (await response.json()) as { registered?: boolean };
            return { registered: body.registered === true };
        } catch (error) {
            console.log('[RelayAPI] output key register failed:', error);
            return null;
        }
    }

    async registerAppAttestKey(params: { key_id: string; attestation: string }, biometricAction?: BiometricAction): Promise<{ registered: boolean } | null> {
        try {
            const response = await this.makeAuthenticatedRequest('/v1/wallet/app-attest/register', {
                method: 'POST',
                body: JSON.stringify(params),
            }, undefined, biometricAction);
            if (!response.ok) {
                const err = (await response.json().catch(() => ({}))) as { reason?: string };
                console.log('[RelayAPI] app-attest register refused:', response.status, err.reason ?? '');
                return null;
            }
            const body = (await response.json()) as { registered?: boolean };
            return { registered: body.registered === true };
        } catch (error) {
            console.log('[RelayAPI] app-attest register failed:', error);
            return null;
        }
    }

    /**
     * Produce a burn-backed presentation from the human's first-party identity.
     * `POST /v1/wallet/present`. `burnId` comes from a prior recordFirstPartyBurn;
     * `audience` + `challenge` are the requester's id + fresh nonce.
     */
    async produceHumanPresentation(request: {
        tier: 'pe_fact' | 'reputation';
        burn_id: string;
        audience: string;
        challenge: string;
        pe_facts?: unknown[];
        /** a broadcast burn — the relay records it inside this call once it is mined. */
        burn?: { tx_hash: string; amount_atomic: string; chain: string };
        [key: string]: unknown;
    }, biometricAction?: BiometricAction): Promise<{ tier: string; presentation: unknown; token: string }> {
        // Batches are daily, plus right before any presentation, so the
        // presentation reflects the latest acts. Never blocks the presentation on a failed send.
        await this.sendLatestActs();
        const response = await this.makeAuthenticatedRequest('/v1/wallet/present', {
            method: 'POST',
            body: JSON.stringify(request),
            ...(request.burn ? { timeoutMs: BURN_HOLD_TIMEOUT_MS } : {}),
        }, undefined, biometricAction);
        if (!response.ok) {
            const err = (await response.json().catch(() => ({}))) as { error?: string; reason?: string; burn_id?: string; burn_recorded?: boolean };
            throw new PresentationRefusedError(
                err.reason || err.error || `presentation failed (${response.status})`,
                response.status,
                err.burn_recorded === true && typeof err.burn_id === 'string' ? err.burn_id : undefined,
            );
        }
        return (await response.json()) as { tier: string; presentation: unknown; token: string };
    }

    /**
     * Verify a presentation a counterparty produced (requester side). PUBLIC —
     * `POST /v1/present/verify` needs no account. Pass the challenge you issued — as the full
     * `challenge_envelope` (; it carries audience, challenge, predicates, presenter and
     * deadline) or as the explicit audience + challenge + predicates. The relay checks the
     * requester binding, freshness, the presenter signature, and (pe_fact) the on-chain anchor
     * proof. Verify is STATELESS: the same valid token verifies again inside its window, so the
     * caller accepts each `presentation_id` once. A 400 refusal comes back `valid:false` + `error`.
     */
    async verifyPresentation(params: {
        token: string;
        audience?: string;
        challenge?: string;
        /** §2.6: the predicates this requester named in its challenge; the relay refuses a presentation that did not answer them. */
        predicates?: PredicateRequest[];
        /** the requester's own (signed) challenge envelope. */
        challenge_envelope?: ChallengeEnvelope;
        /** the presenter asked (lowercase address or wallet id); a mismatch is refused. */
        expected_presenter?: string;
    }): Promise<PresentationVerifyResult> {
        const body: Record<string, unknown> = { token: params.token };
        if (params.challenge_envelope) {
            body.challenge_envelope = params.challenge_envelope;
        } else {
            body.audience = params.audience ?? '';
            body.challenge = params.challenge ?? '';
            if (params.predicates && params.predicates.length > 0) body.predicates = params.predicates;
        }
        if (params.expected_presenter) body.expected_presenter = params.expected_presenter;
        const response = await apiFetch(`${resolveRelayBaseUrl()}/v1/present/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const out = (await response.json().catch(() => ({ valid: false, error: `http_${response.status}` }))) as PresentationVerifyResult;
        if (!response.ok) return { ...out, valid: false, reason: out.reason ?? out.error ?? `http_${response.status}` };
        return out;
    }

    /**
     * the Provian presentation public keys (`GET /v1/present/jwks`, public). A wallet-type
     * signed challenge verifies against these. Cached for the app session; null on any failure
     * (the presenter then shows the challenge as unverifiable and refuses to burn).
     */
    async getPresentationJwks(): Promise<RequesterJwk[] | null> {
        if (this.presentationJwksCache && Date.now() - this.presentationJwksCache.at < 3_600_000) return this.presentationJwksCache.keys;
        try {
            const response = await apiFetch(`${resolveRelayBaseUrl()}/v1/present/jwks`, { method: 'GET', headers: { Accept: 'application/json' } });
            if (!response.ok) return null;
            const keys = parseRequesterKeyDocument(await response.json());
            if (keys.length === 0) return null;
            this.presentationJwksCache = { keys, at: Date.now() };
            return keys;
        } catch (error) {
            console.warn('[RelayAPI] present jwks read failed:', error);
            return null;
        }
    }

    private presentationJwksCache: { keys: RequesterJwk[]; at: number } | null = null;

    /**
     * issue a SIGNED presentation challenge for THIS human's wallet. The relay authenticates
     * the wallet and signs `{ requester: { type:'wallet', id, address } }` with the Provian
     * presentation key, so a presenter sees who is asking before it burns. The audience is the
     * wallet id. `POST /v1/wallet/present/challenge` (wallet auth). Throws on failure — the app
     * never falls back to an unsigned challenge.
     */
    async issueWalletPresentationChallenge(params: {
        predicates?: PredicateRequest[];
        /** 2026-10-10: requester-named disclosure requests. */
        disclosures?: unknown[];
        ttl_seconds?: number;
        /** The expected presenter's lowercase EVM address, when known. */
        presenter?: string;
    }, biometricAction?: BiometricAction): Promise<ChallengeEnvelope> {
        const body: Record<string, unknown> = {};
        if (params.predicates && params.predicates.length > 0) body.predicates = params.predicates;
        if (params.disclosures && params.disclosures.length > 0) body.disclosures = params.disclosures;
        if (params.ttl_seconds !== undefined) body.ttl_seconds = params.ttl_seconds;
        if (params.presenter) body.presenter = params.presenter.toLowerCase();
        const response = await this.makeAuthenticatedRequest('/v1/wallet/present/challenge', {
            method: 'POST',
            body: JSON.stringify(body),
        }, undefined, biometricAction);
        const json = (await response.json().catch(() => ({}))) as { challenge?: unknown; error?: string };
        if (!response.ok) throw new Error(json.error || `challenge failed (${response.status})`);
        const envelope = parseChallengeEnvelope(json.challenge);
        if (!envelope || !isSignedChallenge(envelope)) throw new Error('the relay did not return a signed challenge');
        return envelope;
    }

    /**
     * §2.5: this human's LIVE reputation vocabulary — the exact flat numeric facts a
     * reputation presentation would disclose (Continuity / Work / Coupling / Consumption /
     * Money / Standing / Accountability / Composition / Presentations). `standing.*` is
     * always present and cannot be withheld. GET /v1/wallet/vocabulary (wallet auth).
     */
    async getVocabulary(biometricAction?: BiometricAction): Promise<{ facts: Record<string, number>; standingPrefix: string } | null> {
        try {
            const response = await this.makeAuthenticatedRequest('/v1/wallet/vocabulary', { method: 'GET' }, undefined, biometricAction);
            if (!response.ok) return null;
            const body = (await response.json()) as { facts?: Record<string, unknown>; standing_prefix?: string };
            const facts: Record<string, number> = {};
            for (const [k, v] of Object.entries(body.facts ?? {})) if (typeof v === 'number' && Number.isFinite(v)) facts[k] = v;
            return { facts, standingPrefix: typeof body.standing_prefix === 'string' ? body.standing_prefix : 'standing.' };
        } catch (error) {
            console.warn('[RelayAPI] vocabulary read failed:', error);
            return null;
        }
    }

    /**
     * §2.2: the Trust Layer view of one PE — witness class, evidence class, output
     * digests, input origins (with resolved `pe:` citations), consumption count,
     * hardware-attestation slot, supervision / model / environment, adverse
     * linkage. Read from the canonical `provenance_envelopes` document (the source
     * these fields live on). METADATA ONLY: no content is fetched anywhere. Returns
     * null when the PE is not found or the read fails — the screen renders "—".
     */
    async getPETrustDetail(peId: string, biometricAction?: BiometricAction): Promise<PeTrustDetail | null> {
        try {
            // The canonical PE doc carries the trust-layer fields; page through a
            // reasonable window and match by id (no per-PE endpoint is invented).
            const raw = await this.getProvenanceEnvelopes(500, 0, biometricAction);
            if (!Array.isArray(raw)) return null;
            const match = raw.find((pe) => {
                if (typeof pe !== 'object' || pe === null) return false;
                const id = (pe as Record<string, unknown>).envelope_id ?? (pe as Record<string, unknown>).pe_id;
                return id === peId;
            });
            return match ? extractPeTrustDetail(match) : null;
        } catch (error) {
            console.warn('[RelayAPI] PE trust detail read failed:', error);
            return null;
        }
    }

    /**
     * §2.1: pending human-approval requests an agent addressed to THIS human.
     * GET /v1/wallet/approval-requests (wallet auth; Tier-3 — carries the text).
     * Returns [] on any failure so the inbox degrades to empty, never errors.
     */
    async getWalletApprovalRequests(biometricAction?: BiometricAction): Promise<HumanApprovalRequest[]> {
        try {
            const { endpoint, options } = this.noCacheGet('/v1/wallet/approval-requests');
            const response = await this.makeAuthenticatedRequest(endpoint, options, undefined, biometricAction);
            if (!response.ok) return [];
            const body = (await response.json().catch(() => ({}))) as { requests?: unknown };
            if (!Array.isArray(body.requests)) return [];
            const out: HumanApprovalRequest[] = [];
            for (const r of body.requests) {
                if (typeof r !== 'object' || r === null) continue;
                const o = r as Record<string, unknown>;
                const requestId = typeof o.request_id === 'string' ? o.request_id : null;
                const agentWalletId = typeof o.agent_wallet_id === 'string' ? o.agent_wallet_id : null;
                const description = typeof o.action_description === 'string' ? o.action_description : null;
                const descriptionHash = typeof o.action_description_sha256 === 'string' ? o.action_description_sha256 : null;
                if (!requestId || !agentWalletId || !description || !descriptionHash) continue;
                out.push({
                    request_id: requestId,
                    agent_wallet_id: agentWalletId,
                    action_description: description,
                    action_description_sha256: descriptionHash,
                    subject_pe_id: typeof o.subject_pe_id === 'string' ? o.subject_pe_id : null,
                    created_at_ms: typeof o.created_at_ms === 'number' ? o.created_at_ms : 0,
                    expires_at_ms: typeof o.expires_at_ms === 'number' ? o.expires_at_ms : 0,
                });
            }
            return out;
        } catch (error) {
            console.warn('[RelayAPI] approval-requests read failed:', error);
            return [];
        }
    }

    /**
     * §2.1: mark an approval request resolved after the human sealed the
     * `human_approval` PE. POST /v1/wallet/approval-requests/:id/resolve with the
     * sealed approval PE id + the decision. Best-effort: a non-2xx returns ok:false
     * rather than throwing, so the inbox refresh proceeds (the approval PE — the
     * substantive artifact — is already sealed; resolve only clears the queue item).
     */
    async resolveApprovalRequest(
        requestId: string,
        params: { approval_pe_id: string; decision: 'approved' | 'rejected' }, biometricAction?: BiometricAction,
    ): Promise<ApprovalResolveResult> {
        try {
            const response = await this.makeAuthenticatedRequest(
                `/v1/wallet/approval-requests/${encodeURIComponent(requestId)}/resolve`,
                {
                    method: 'POST',
                    body: JSON.stringify({ approval_pe_id: params.approval_pe_id, decision: params.decision }),
                }, undefined, biometricAction
            );
            if (!response.ok) {
                const err = (await response.json().catch(() => ({}))) as { error?: string };
                return { ok: false, status: `http_${response.status}`, error: err.error };
            }
            const body = (await response.json().catch(() => ({}))) as { status?: string };
            return { ok: true, status: body.status };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'resolve_failed' };
        }
    }

    /**
     * §3f: remote presentation requests an agent addressed to THIS human.
     * GET /v1/wallet/presentation-requests (wallet auth). Returns [] on any failure.
     */
    async getWalletPresentationRequests(biometricAction?: BiometricAction): Promise<HumanPresentationRequest[]> {
        try {
            const { endpoint, options } = this.noCacheGet('/v1/wallet/presentation-requests');
            const response = await this.makeAuthenticatedRequest(endpoint, options, undefined, biometricAction);
            if (!response.ok) return [];
            const body = (await response.json().catch(() => ({}))) as { requests?: unknown };
            if (!Array.isArray(body.requests)) return [];
            const out: HumanPresentationRequest[] = [];
            for (const r of body.requests) {
                if (typeof r !== 'object' || r === null) continue;
                const o = r as Record<string, unknown>;
                const requestId = typeof o.request_id === 'string' ? o.request_id : null;
                const agentWalletId = typeof o.agent_wallet_id === 'string' ? o.agent_wallet_id : null;
                if (!requestId || !agentWalletId) continue;
                const tier = o.tier === 'pe_fact' ? 'pe_fact' : 'reputation';
                const status = typeof o.status === 'string' ? o.status : 'requested';
                out.push({
                    request_id: requestId,
                    agent_wallet_id: agentWalletId,
                    tier,
                    status: status as HumanPresentationRequest['status'],
                    note: typeof o.note === 'string' ? o.note : null,
                    created_at_ms: typeof o.created_at_ms === 'number' ? o.created_at_ms : 0,
                    expires_at_ms: typeof o.expires_at_ms === 'number' ? o.expires_at_ms : 0,
                    audience: typeof o.audience === 'string' ? o.audience : null,
                    challenge: typeof o.challenge === 'string' ? o.challenge : null,
                    predicates: Array.isArray(o.predicates) ? o.predicates : null,
                    challenge_envelope: o.challenge_envelope !== undefined && o.challenge_envelope !== null ? parseChallengeEnvelope(o.challenge_envelope) : null,
                    presentation_token: typeof o.presentation_token === 'string' ? o.presentation_token : null,
                    verdict: o.verdict === 'valid' || o.verdict === 'invalid' ? o.verdict : null,
                });
            }
            return out;
        } catch (error) {
            console.warn('[RelayAPI] presentation-requests read failed:', error);
            return [];
        }
    }

    /**
     * §3f: the human composes the predicates + challenge for a presentation request.
     * POST /v1/wallet/presentation-requests/:id/challenge. Returns ok:false rather than throwing.
     */
    async composePresentationChallenge(
        requestId: string,
        params: { audience: string; challenge: string; predicates?: unknown[] }, biometricAction?: BiometricAction,
    ): Promise<{ ok: boolean; error?: string; envelope?: ChallengeEnvelope | null }> {
        try {
            const response = await this.makeAuthenticatedRequest(
                `/v1/wallet/presentation-requests/${encodeURIComponent(requestId)}/challenge`,
                { method: 'POST', body: JSON.stringify({ audience: params.audience, challenge: params.challenge, predicates: params.predicates ?? null }) }, undefined, biometricAction
            );
            if (!response.ok) {
                const err = (await response.json().catch(() => ({}))) as { error?: string };
                return { ok: false, error: err.error ?? `http_${response.status}` };
            }
            // the relay signs the envelope it composes for this wallet and returns it (the
            // audience/challenge it carries are authoritative — the relay binds audience to the wallet id).
            const body = (await response.json().catch(() => ({}))) as { challenge_envelope?: unknown; challenge?: unknown; request?: { challenge_envelope?: unknown } };
            const raw = body.challenge_envelope ?? body.request?.challenge_envelope
                ?? (typeof body.challenge === 'object' && body.challenge !== null ? body.challenge : undefined);
            return { ok: true, envelope: raw !== undefined ? parseChallengeEnvelope(raw) : null };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'challenge_failed' };
        }
    }

    /**
     * §3f: the human records the verify verdict for a presented request.
     * POST /v1/wallet/presentation-requests/:id/verify. Returns ok:false rather than throwing.
     */
    async recordPresentationVerdict(
        requestId: string,
        params: { verdict: 'valid' | 'invalid'; predicate_results?: unknown[] }, biometricAction?: BiometricAction,
    ): Promise<{ ok: boolean; error?: string }> {
        try {
            const response = await this.makeAuthenticatedRequest(
                `/v1/wallet/presentation-requests/${encodeURIComponent(requestId)}/verify`,
                { method: 'POST', body: JSON.stringify({ verdict: params.verdict, predicate_results: params.predicate_results ?? null }) }, undefined, biometricAction
            );
            if (!response.ok) {
                const err = (await response.json().catch(() => ({}))) as { error?: string };
                return { ok: false, error: err.error ?? `http_${response.status}` };
            }
            return { ok: true };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'verify_failed' };
        }
    }

    /** §3f: decline a presentation request. POST /v1/wallet/presentation-requests/:id/decline. */
    async declinePresentationRequest(requestId: string, biometricAction?: BiometricAction): Promise<{ ok: boolean }> {
        try {
            const response = await this.makeAuthenticatedRequest(
                `/v1/wallet/presentation-requests/${encodeURIComponent(requestId)}/decline`,
                { method: 'POST', body: JSON.stringify({}) }, undefined, biometricAction
            );
            return { ok: response.ok };
        } catch {
            return { ok: false };
        }
    }

    /**
     * Item 11: the PUBLIC half of this human's agent-recovery key as the relay holds it.
     * GET /v1/wallet/recovery-anchor (wallet auth). A string when published, null when not,
     * undefined when the relay could not be read (never guessed as "not published").
     */
    async getHumanRecoveryAnchor(biometricAction?: BiometricAction): Promise<string | null | undefined> {
        try {
            const { endpoint, options } = this.noCacheGet('/v1/wallet/recovery-anchor');
            const response = await this.makeAuthenticatedRequest(endpoint, options, undefined, biometricAction);
            if (!response.ok) return undefined;
            const body = (await response.json().catch(() => ({}))) as { recovery_anchor_pubkey?: unknown };
            if (body.recovery_anchor_pubkey === null) return null;
            return typeof body.recovery_anchor_pubkey === 'string' ? body.recovery_anchor_pubkey : undefined;
        } catch {
            return undefined;
        }
    }

    /** Item 11: publish the anchor's public half, signed by this wallet's key (PUT /v1/wallet/recovery-anchor). */
    async putHumanRecoveryAnchor(pubkeyB64u: string, signature: string, biometricAction?: BiometricAction): Promise<boolean> {
        try {
            const response = await this.makeAuthenticatedRequest('/v1/wallet/recovery-anchor', {
                method: 'PUT',
                body: JSON.stringify({ recovery_anchor_pubkey: pubkeyB64u, signature }),
            }, undefined, biometricAction);
            return response.ok;
        } catch {
            return false;
        }
    }

    /**
     * linked agents needing recovery/re-key, surfaced to THIS human.
     * GET /v1/wallet/agent-recovery-alerts (wallet auth). Returns [] on any failure.
     */
    async getAgentRecoveryAlerts(biometricAction?: BiometricAction): Promise<AgentRecoveryAlert[]> {
        try {
            const { endpoint, options } = this.noCacheGet('/v1/wallet/agent-recovery-alerts');
            const response = await this.makeAuthenticatedRequest(endpoint, options, undefined, biometricAction);
            if (!response.ok) return [];
            const body = (await response.json().catch(() => ({}))) as { alerts?: unknown };
            if (!Array.isArray(body.alerts)) return [];
            const out: AgentRecoveryAlert[] = [];
            for (const a of body.alerts) {
                if (typeof a !== 'object' || a === null) continue;
                const o = a as Record<string, unknown>;
                const agentWalletId = typeof o.agent_wallet_id === 'string' ? o.agent_wallet_id : null;
                if (!agentWalletId) continue;
                out.push({
                    agent_wallet_id: agentWalletId,
                    agent_name: typeof o.agent_name === 'string' ? o.agent_name : agentWalletId,
                    reason: (typeof o.reason === 'string' ? o.reason : 'at_rest_secret_missing') as AgentRecoveryAlert['reason'],
                });
            }
            return out;
        } catch (error) {
            console.warn('[RelayAPI] agent-recovery-alerts read failed:', error);
            return [];
        }
    }

    /**
     * §2.4: the current single-use burn floor per presentation tier. PUBLIC —
     * GET /v1/present/floor. null on any failure so the presenter falls back to its
     * config-mirrored defaults.
     */
    async getPresentationFloor(): Promise<PresentationFloor | null> {
        try {
            const response = await apiFetch(`${resolveRelayBaseUrl()}/v1/present/floor`, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' },
            });
            if (!response.ok) return null;
            const body = (await response.json().catch(() => ({}))) as {
                reputation?: unknown; pe_fact?: unknown;
                floors?: { reputation?: unknown; pe_fact?: unknown };
            };
            const src = body.floors ?? body;
            const reputation = typeof src.reputation === 'number' && Number.isFinite(src.reputation) ? src.reputation : null;
            const peFact = typeof src.pe_fact === 'number' && Number.isFinite(src.pe_fact) ? src.pe_fact : null;
            if (reputation === null || peFact === null) return null;
            return { reputation, pe_fact: peFact };
        } catch (error) {
            console.warn('[RelayAPI] present floor read failed:', error);
            return null;
        }
    }

    /**
     * Read the live / lapsed / invalidated / none state (+ reason class) of a
     * directed rail handshake for a relationship this human is a party to. Both
     * parties can read their pair's state; it never surfaces on Commons.
     * GET /v1/wallet/rail-handshake (wallet auth).
     *   role='presenter' (default) → state of (me → counterparty)
     *   role='audience'            → state of (counterparty → me)
     */
    async readHandshakeState(params: {
        counterparty: string;
        role?: 'presenter' | 'audience';
    }, biometricAction?: BiometricAction): Promise<{
        state: 'live' | 'lapsed' | 'invalidated' | 'none';
        reasonClass?: string;
        establishedAt?: number;
        expiresAt?: number;
    }> {
        const role = params.role === 'audience' ? 'audience' : 'presenter';
        const qs = `counterparty=${encodeURIComponent(params.counterparty)}&role=${role}`;
        const response = await this.makeAuthenticatedRequest(`/v1/wallet/rail-handshake?${qs}`, { method: 'GET' }, undefined, biometricAction);
        if (!response.ok) {
            const err = (await response.json().catch(() => ({}))) as { error?: string };
            throw new Error(err.error || `handshake state read failed (${response.status})`);
        }
        return (await response.json()) as {
            state: 'live' | 'lapsed' | 'invalidated' | 'none';
            reasonClass?: string;
            establishedAt?: number;
            expiresAt?: number;
        };
    }

    // =========================================================================
    // PVT (Provenance Value Token) Dashboard
    // =========================================================================

    /**
     * Get sealed record points, a separately labelled current non-final
     * settlement projection, exact Genesis reserved gross, and PE counts.
     */
    async getPVTAccrual(biometricAction?: BiometricAction): Promise<PVTAccrual | null> {
        const userId = this.userId;
        // Four screens can mount/focus together on app open. Share one active
        // read for the SAME authenticated human, but do not retain an answer
        // after it settles: pull-to-refresh must still reach the relay.
        if (userId && this.pvtAccrualInFlight?.userId === userId) {
            return this.pvtAccrualInFlight.promise;
        }
        const read = this.readPVTAccrual(userId, biometricAction);
        if (userId) this.pvtAccrualInFlight = { userId, promise: read };
        try {
            return await read;
        } finally {
            if (this.pvtAccrualInFlight?.promise === read) this.pvtAccrualInFlight = null;
        }
    }

    private async readPVTAccrual(expectedUserId: string | null, biometricAction?: BiometricAction): Promise<PVTAccrual | null> {
        try {
            const { endpoint, options } = this.noCacheGet('/v1/pvt/accrual');
            const response = await this.makeAuthenticatedRequest(endpoint, options, undefined, biometricAction);
            if (response.ok) {
                const body = await response.json() as PVTAccrual;
                // An account switch while the request was in flight must never
                // paint the previous human's participation on the new wallet.
                if (expectedUserId && this.userId !== expectedUserId) return null;
                return {
                    ...body,
                    attestationDepth: normalizePVTAttestationTier(body.attestationDepth),
                };
            }
            console.warn('[RelayAPI] PVT accrual returned status:', response.status);
            return null;
        } catch (error) {
            console.error('[RelayAPI] Error fetching PVT accrual:', error);
            return null;
        }
    }

    // -------------------------------------------------------------------------
    // — on-demand payout. Standard earnings settle on a schedule Provian sets, currently every 30 days for free; the person can
    // settle now for a flat $1 USDC service fee paid from their own wallet (never a price for PVT).
    // -------------------------------------------------------------------------

    /** Send this phone's unsent acts now (before a presentation or payout). Never throws. */
    private async sendLatestActs(): Promise<void> {
        try {
            const { getPhoneMeter } = await import('../core/meter/phoneMeterRuntime');
            await getPhoneMeter().sendBeforeUse();
        } catch (error) {
            console.warn('[RelayAPI] could not send the latest acts first:', error);
        }
    }

    /** What a payout would settle now and its terms. Pays nothing. The latest acts go first. */
    async payoutQuote(payee?: string, biometricAction?: BiometricAction): Promise<PayoutQuote> {
        await this.sendLatestActs();
        const response = await this.makeAuthenticatedRequest('/v1/payout/mobile', {
            method: 'POST',
            body: JSON.stringify(payee ? { payee } : {}),
        }, undefined, biometricAction);
        const body = await response.json().catch(() => ({})) as Record<string, unknown>;
        if (response.status === 402) {
            const accepts = Array.isArray(body.accepts) ? body.accepts as PayoutRequirement[] : [];
            const ready = (body.ready ?? null) as { claims?: number; record_points_atomic?: string } | null;
            return {
                available: true,
                requirement: accepts[0] ?? null,
                readyClaims: typeof ready?.claims === 'number' ? ready.claims : null,
                readyRecordPointsAtomic: typeof ready?.record_points_atomic === 'string' ? ready.record_points_atomic : null,
                estimatedGasUsd: typeof body.estimated_gas_usd === 'number' ? body.estimated_gas_usd : null,
            };
        }
        return { available: false, reason: typeof body.error === 'string' ? body.error : `http_${response.status}` };
    }

    /** Send the signed $1 payment; the relay charges, then settles this payee now. */
    async requestPayout(payment: string, payee?: string, biometricAction?: BiometricAction): Promise<PayoutRequestView> {
        const response = await this.makeAuthenticatedRequest('/v1/payout/mobile', {
            method: 'POST',
            body: JSON.stringify(payee ? { payee, payment } : { payment }),
            timeoutMs: 180_000,
        }, undefined, biometricAction);
        const body = await response.json().catch(() => ({})) as Record<string, unknown>;
        if (response.status === 200 || response.status === 202) return body as unknown as PayoutRequestView;
        throw new Error(typeof body.error === 'string' ? body.error : `payout_http_${response.status}`);
    }

    /** Ask the relay to finish a charged payout this person is watching (idempotent). */
    async advancePayout(requestId: string, biometricAction?: BiometricAction): Promise<PayoutRequestView> {
        const response = await this.makeAuthenticatedRequest(`/v1/payout/${encodeURIComponent(requestId)}/advance`, {
            method: 'POST',
            body: JSON.stringify({}),
            timeoutMs: 180_000,
        }, undefined, biometricAction);
        const body = await response.json().catch(() => ({})) as Record<string, unknown>;
        if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `payout_http_${response.status}`);
        return body as unknown as PayoutRequestView;
    }

    // ─── app-store purchases (store builds) ──────────────────
    // The App Store and Play builds buy the PE Archive GB and Settle now through the store; the
    // relay verifies each purchase with its store and grants exactly what USDC grants.

    /** The account token every store purchase carries, and this account's unused Settle now purchases. */
    async storeAccount(): Promise<{ accountToken: string; settleNowHeld: number }> {
        const response = await this.makeAuthenticatedRequest('/v1/store', { method: 'GET' });
        const body = await response.json().catch(() => ({})) as Record<string, unknown>;
        if (!response.ok || typeof body.account_token !== 'string') {
            throw new Error(typeof body.error === 'string' ? body.error : `store_http_${response.status}`);
        }
        return { accountToken: body.account_token, settleNowHeld: typeof body.settle_now_held === 'number' ? body.settle_now_held : 0 };
    }

    /** Hand one store purchase to the relay. A refusal is an answer (`denied`); a lost answer throws. */
    async redeemStorePurchase(purchase: {
        platform: 'app_store' | 'google_play';
        product_id: string;
        signed_transaction?: string;
        purchase_token?: string;
    }): Promise<StoreRelayAnswer> {
        const response = await this.makeAuthenticatedRequest('/v1/store/purchases', {
            method: 'POST',
            body: JSON.stringify(purchase),
            timeoutMs: 60_000,
        });
        return storeAnswerOf(response.status, await response.json().catch(() => ({})) as Record<string, unknown>);
    }

    /** Spend this account's oldest unused Settle now on a settlement, if one can run now. */
    async redeemHeldSettleNow(): Promise<StoreRelayAnswer> {
        const response = await this.makeAuthenticatedRequest('/v1/store/settle-now/redeem', {
            method: 'POST',
            body: JSON.stringify({}),
            timeoutMs: 60_000,
        });
        return storeAnswerOf(response.status, await response.json().catch(() => ({})) as Record<string, unknown>);
    }

    // ─── the paid PE Archive ──────────────────
    // Your PEs stay yours: the Archive keeps encrypted days you choose to pay for ($5 USDC per GB,
    // kept permanently). Uploading, dropping (this phone keeps the last 30 days) and pulling are the
    // meter's (`core/meter/phoneArchive.ts`); these are the account calls under wallet auth.

    /** This person's Archive: on/off, paid and used space. Null when the relay cannot say. */
    async archiveStatus(biometricAction?: BiometricAction): Promise<ArchiveView | null> {
        const answer = await this.meterRequest('GET', '/v1/archive/mobile', undefined, undefined, biometricAction);
        if (answer.status !== 200) return null;
        return archiveViewOf((answer.body as { archive?: unknown } | null)?.archive);
    }

    /**
     * What one GB costs now (charges nothing). `available: false` while more than 100 MB remain. The
     * quote also says what this wallet holds on Base and whether gas is covered, so the app can stop
     * BEFORE Face ID when the payment could not go through.
     */
    async archiveQuote(biometricAction?: BiometricAction): Promise<ArchiveQuote> {
        const response = await this.makeAuthenticatedRequest('/v1/archive/mobile/pay', { method: 'POST', body: JSON.stringify({}) }, undefined, biometricAction);
        const body = await response.json().catch(() => ({})) as Record<string, unknown>;
        if (response.status === 402) {
            const accepts = Array.isArray(body.accepts) ? body.accepts as PayoutRequirement[] : [];
            const payer = body.payer !== null && typeof body.payer === 'object' ? body.payer as Record<string, unknown> : null;
            return {
                available: true,
                requirement: accepts[0] ?? null,
                archive: archiveViewOf(body.archive),
                payer: payer === null ? null : {
                    address: typeof payer.address === 'string' ? payer.address : null,
                    balanceAtomic: typeof payer.usdc_balance_atomic === 'string' && /^\d+$/.test(payer.usdc_balance_atomic) ? payer.usdc_balance_atomic : null,
                    sufficient: typeof payer.sufficient === 'boolean' ? payer.sufficient : null,
                },
                gasCovered: typeof body.gas_covered === 'boolean' ? body.gas_covered : null,
            };
        }
        return { available: false, reason: typeof body.error === 'string' ? body.error : `http_${response.status}` };
    }

    /**
     * Send the signed $5 payment; the relay charges it, then credits one GB (turning the Archive on at
     * the first). Never throws: a refusal the relay answered (nothing charged) is told apart from a
     * request whose outcome is unknown (the connection failed after the payment may have left).
     */
    async buyArchiveGb(payment: string, biometricAction?: BiometricAction): Promise<ArchiveBuyOutcome> {
        let response: Response;
        try {
            response = await this.makeAuthenticatedRequest('/v1/archive/mobile/pay', {
                method: 'POST',
                body: JSON.stringify({ payment }),
                timeoutMs: 180_000,
            }, undefined, biometricAction);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // Thrown before anything was sent (no credentials / no signed token): nothing can be charged.
            if (message === 'Not authenticated' || message === 'Failed to generate signed auth token') {
                return { kind: 'refused', status: 0, code: 'session_unavailable' };
            }
            return { kind: 'unreachable', error: message };
        }
        const body = await response.json().catch(() => ({})) as Record<string, unknown>;
        return archiveBuyOutcomeOf(response.status, body);
    }

    /** This person's Archive purchases, newest first. */
    async archivePayments(biometricAction?: BiometricAction): Promise<ArchivePaymentView[]> {
        const answer = await this.meterRequest('GET', '/v1/archive/mobile/payments', undefined, undefined, biometricAction);
        if (answer.status !== 200 || answer.body === null || typeof answer.body !== 'object') {
            throw new Error(`archive_http_${answer.status ?? 'none'}`);
        }
        const list = (answer.body as { payments?: unknown }).payments;
        return Array.isArray(list) ? list.filter((p): p is Record<string, unknown> => p !== null && typeof p === 'object').map(archivePaymentViewOf) : [];
    }

    /** One of this person's Archive payments (a charge still confirming finishes on its own). */
    async archivePayment(requestId: string, biometricAction?: BiometricAction): Promise<ArchivePaymentView> {
        const answer = await this.meterRequest('GET', `/v1/archive/mobile/payments/${encodeURIComponent(requestId)}`, undefined, undefined, biometricAction);
        if (answer.status !== 200 || answer.body === null || typeof answer.body !== 'object') {
            throw new Error(`archive_http_${answer.status ?? 'none'}`);
        }
        return archivePaymentViewOf(answer.body as Record<string, unknown>);
    }

    /** Turn the Archive on (only with paid space left) or off (uploads stop; everything stored is kept). */
    async setArchive(on: boolean, biometricAction?: BiometricAction): Promise<ArchiveView> {
        const answer = await this.meterRequest('POST', `/v1/archive/mobile/${on ? 'on' : 'off'}`, JSON.stringify({}), undefined, biometricAction);
        if (answer.status !== 200) {
            const code = answer.body !== null && typeof answer.body === 'object' && typeof (answer.body as { error?: unknown }).error === 'string'
                ? (answer.body as { error: string }).error
                : `archive_http_${answer.status ?? 'none'}`;
            throw new Error(code);
        }
        return archiveViewOf((answer.body as { archive?: unknown } | null)?.archive);
    }

    /** An archived day's object as text (NDJSON of sealed parts; the phone opens it locally). */
    async archiveObjectText(path: string, biometricAction?: BiometricAction): Promise<{ status: number | null; text: string | null }> {
        try {
            const response = await this.makeAuthenticatedRequest(path, {
                method: 'GET',
                headers: { 'Cache-Control': 'no-store' },
                timeoutMs: 180_000,
            }, undefined, biometricAction);
            if (!response.ok) return { status: response.status, text: null };
            return { status: response.status, text: await response.text() };
        } catch {
            return { status: null, text: null };
        }
    }

    /**
     * Get PE history with record points and optional non-final projections.
     */
    async getPVTHistory(
        limit: number = 50,
        offset: number = 0,
        showHidden: boolean = false, _biometricAction?: BiometricAction,
        cursor?: string | null,
    ): Promise<PVTHistoryResponse | null> {
        try {
            const { getPhoneMeter } = await import('../core/meter/phoneMeterRuntime');
            const { localHistoryEntries } = await import('../core/meter/peHistoryView');
            const meter = getPhoneMeter();
            await meter.start();
            const held = await localHistoryEntries(meter.store, { showHidden });
            const seen = new Set<string>();
            const rows = held.filter(row => {
                const key = row.hash || row.peId;
                if (seen.has(key)) return false;
                seen.add(key); return true;
            });
            let start = Math.max(0, offset);
            if (cursor) {
                const after = JSON.parse(decodeURIComponent(cursor)) as { timestamp: number; peId: string };
                start = rows.findIndex(row => row.timestamp < after.timestamp
                    || row.timestamp === after.timestamp && row.peId > after.peId);
                if (start < 0) start = rows.length;
            }
            const entries = rows.slice(start, start + Math.max(1, limit));
            const hasMore = start + entries.length < rows.length;
            const last = entries[entries.length - 1];
            return { entries, total: rows.length, hasMore,
                nextCursor: hasMore && last ? encodeURIComponent(JSON.stringify({ timestamp: last.timestamp, peId: last.peId })) : null,
                currentSettlementProjection: { label: 'Current settlement projection (non-final)', isFinal: false,
                    unavailableReason: 'per_act_earnings_kept_by_owner' },
            };
        } catch (error) {
            console.error('[PE store] Error reading local PVT history:', error);
            return null;
        }
    }

    /**
     * Community-updates opt-in — DELIBERATELY identity-free.
     *
     * This is a raw fetch, NOT makeAuthenticatedRequest: the wallet auth token
     * carries user/device identity, and the whole point of this endpoint is
     * that the email is decoupled from the wallet. The constant placeholder
     * Bearer only satisfies the pre-launch surface gate's Bearer-present check
     * (anonymous public web stays 404 pre-flip); the server authenticates
     * nobody on this route and stores no identity fields.
     */
    async subscribeCommunityUpdates(
        email: string,
        source: 'onboarding' | 'settings' | 'general' = 'general',
    ): Promise<boolean> {
        try {
            const response = await apiFetch(`${resolveRelayBaseUrl()}/v1/community/subscribe`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: 'Bearer community-optin',
                },
                body: JSON.stringify({ email, source }),
            });
            return response.ok;
        } catch (error) {
            console.warn('[RelayAPI] Community subscribe failed:', error);
            return false;
        }
    }

    /**
     * Get network-wide PVT stats and leaderboard.
     * Server caches per window (30s Redis TTL).
     *
     * @param window - leaderboard ranking window: 'all' (lifetime pe_count)
     *   or 'week' (PEs accrued since Monday 00:00 UTC). Aggregate tiles
     *   (totalPEs / wallets / 24h) are identical for both windows.
     */
    async getPVTNetworkStats(window: 'all' | 'week' = 'all', biometricAction?: BiometricAction): Promise<PVTNetworkStats | null> {
        try {
            const { endpoint, options } = this.noCacheGet(`/v1/pvt/network-stats?window=${window}`);
            const response = await this.makeAuthenticatedRequest(endpoint, options, undefined, biometricAction);
            if (response.ok) {
                return response.json();
            }
            console.warn('[RelayAPI] PVT network stats returned status:', response.status);
            return null;
        } catch (error) {
            console.error('[RelayAPI] Error fetching PVT network stats:', error);
            return null;
        }
    }

    /**
     * "The feature is not active here" 503 OR 404.
     *
     * The PVT read endpoints used to answer 503 pre-flip, refused by the runtime boundary
     * runtime boundary before any route existed. Now that the read surface is
     * mounted, each route carries its own PUBLIC_LAUNCH gate and answers 404
     * until the flip. Both codes mean the same thing to this client, and a
     * caller that recognised only 503 would treat the pre-flip window as a real
     * error — turning a gracefully-empty screen into a wrong one.
     */
    private static isFeatureNotActive(status: number): boolean {
        return status === 503 || status === 404;
    }

    /**
     * Get PVT minting history (epoch batches).
     */
    async getPVTMintingHistory(limit: number = 20, biometricAction?: BiometricAction): Promise<{
        batches: Array<{
            batch_id: string;
            epoch: number;
            pe_count: number;
            total_pvt_minted: string;
            contributor_count: number;
            tx_hash: string;
            created_at: number;
        }>;
    } | null> {
        try {
            const response = await this.makeAuthenticatedRequest(
                `/v1/pvt/mint-history?limit=${limit}`, undefined, undefined, biometricAction
            );
            if (response.ok) {
                return response.json();
            }
            console.warn('[RelayAPI] PVT mint history returned status:', response.status);
            return null;
        } catch (error) {
            console.error('[RelayAPI] Error fetching PVT mint history:', error);
            return null;
        }
    }

    /**
     * Get PE weight framework configuration.
     */
    async getPVTWeights(biometricAction?: BiometricAction): Promise<Record<string, unknown> | null> {
        try {
            const response = await this.makeAuthenticatedRequest('/v1/pvt/weights', undefined, undefined, biometricAction);
            if (response.ok) {
                return response.json();
            }
            console.warn('[RelayAPI] PVT weights returned status:', response.status);
            return null;
        } catch (error) {
            console.error('[RelayAPI] Error fetching PVT weights:', error);
            return null;
        }
    }

    // =========================================================================
    // PVT ALLOCATION + MILESTONES (Human wallet endpoints)
    // =========================================================================

    /**
     * Get PVT allocation breakdown for the current user.
     * Uses wallet HMAC auth - the user_id from the token is used as wallet_id.
     */
    async getPVTAllocation(userId: string, biometricAction?: BiometricAction): Promise<PVTAllocation | null> {
        try {
            const response = await this.makeAuthenticatedRequest(
                `/v1/pvt/allocation/${encodeURIComponent(userId)}`, undefined, undefined, biometricAction
            );
            if (response.ok) {
                return response.json();
            }
            if (RelayAPIService.isFeatureNotActive(response.status)) {
                // Feature not yet active - return coming_soon marker
                return { coming_soon: true } as PVTAllocation;
            }
            console.warn('[RelayAPI] PVT allocation returned status:', response.status);
            return null;
        } catch (error) {
            console.error('[RelayAPI] Error fetching PVT allocation:', error);
            return null;
        }
    }

    /**
     * Get PVT milestones - public, no auth needed.
     */
    async getPVTMilestones(biometricAction?: BiometricAction): Promise<PVTMilestones | null> {
        try {
            const response = await this.makeAuthenticatedRequest('/v1/pvt/milestones', undefined, undefined, biometricAction);
            if (response.ok) {
                return response.json();
            }
            if (RelayAPIService.isFeatureNotActive(response.status)) {
                return null; // Feature not active
            }
            console.warn('[RelayAPI] PVT milestones returned status:', response.status);
            return null;
        } catch (error) {
            console.error('[RelayAPI] Error fetching PVT milestones:', error);
            return null;
        }
    }

    /**
     * Get on-chain PVT balance for a wallet address - public.
     */
    async getPVTBalance(walletAddress: string, biometricAction?: BiometricAction): Promise<{ balance: string; balance_raw: string } | null> {
        try {
            const { endpoint, options } = this.noCacheGet(
                `/v1/pvt/balance/${encodeURIComponent(walletAddress)}`,
            );
            const response = await this.makeAuthenticatedRequest(endpoint, options, undefined, biometricAction);
            if (response.ok) {
                return response.json();
            }
            return null;
        } catch (error) {
            console.error('[RelayAPI] Error fetching PVT balance:', error);
            return null;
        }
    }

    /**
     * Fetch the backend contract registry (known/scam contract supplement for
     * the crypto classifier). Wallet-authed: the endpoint is behind the app-authed
     * pre-launch surface gate, so it serves the app before the flip and
     * 404s an anonymous public-web caller. Returns null on any failure — the
     * classifier degrades gracefully to its hardcoded set.
     */
    async getContractRegistry(biometricAction?: BiometricAction): Promise<{ entries: unknown[] } | null> {
        try {
            const response = await this.makeAuthenticatedRequest('/v1/contract-registry', undefined, undefined, biometricAction);
            if (response.ok) {
                return response.json();
            }
            console.warn('[RelayAPI] Contract registry returned status:', response.status);
            return null;
        } catch (error) {
            console.error('[RelayAPI] Error fetching contract registry:', error);
            return null;
        }
    }

    /**
     * [M-15] Report biometric lockout event to backend.
     * Fire-and-forget - caller should .catch(() => {}).
     */
    async reportBiometricLockout(failureCount: number, lockoutUntil: number | null, biometricAction?: BiometricAction): Promise<void> {
        try {
            await this.makeAuthenticatedRequest('/v1/security/biometric-lockout', {
                method: 'POST',
                body: JSON.stringify({
                    failure_count: failureCount,
                    lockout_until: lockoutUntil,
                }),
            }, undefined, biometricAction);
        } catch {
            // Silent failure - this is fire-and-forget
        }
    }
    // ========================================================================
    // AGENT INVITE ENDPOINTS
    // ========================================================================

    /**
     * Accept an agent invite sent to this wallet.
     * POST /v1/agent/wallet/accept-invite
     */
    async acceptAgentInvite(inviteId: string, agentName?: string, biometricAction?: BiometricAction): Promise<{
        success: boolean;
        agent_name?: string;
        signing_bonus_pvt?: number;
        message?: string;
        error?: string;
    } | null> {
        try {
            // Item 5: the human may name the agent as they accept it (the relay
            // validates: trimmed, 1..100 chars, no < >).
            const body: { invite_id: string; agent_name?: string } = { invite_id: inviteId };
            if (typeof agentName === 'string' && agentName.trim().length > 0) body.agent_name = agentName.trim();
            const response = await this.makeAuthenticatedRequest('/v1/agent/wallet/accept-invite', {
                method: 'POST',
                body: JSON.stringify(body),
            }, undefined, biometricAction);

            if (!response.ok) {
                const error = await response.json().catch(() => ({}));
                return {
                    success: false,
                    error: error.error || 'Failed to accept invite',
                };
            }

            return await response.json();
        } catch (error) {
            console.error('[RelayAPI] Error accepting agent invite:', error);
            return null;
        }
    }

    /**
     * How a linked agent answers its Commons mail (, item 4):
     * GET/POST /v1/agent/wallet/:wallet_id/reply-policy (wallet auth — only the linked human).
     * The agent is told on its own thread reads and follows it; the relay never gates a send on it.
     */
    async getAgentReplyPolicy(agentWalletId: string, biometricAction?: BiometricAction): Promise<AgentReplyPolicyMode | null> {
        try {
            const response = await this.makeAuthenticatedRequest(
                `/v1/agent/wallet/${encodeURIComponent(agentWalletId)}/reply-policy`, { method: 'GET' }, undefined, biometricAction,
            );
            if (!response.ok) return null;
            const body = await response.json().catch(() => ({})) as { mode?: unknown };
            return body.mode === 'answer_anyone' || body.mode === 'ask_me_first' ? body.mode : null;
        } catch {
            return null;
        }
    }

    async setAgentReplyPolicy(agentWalletId: string, mode: AgentReplyPolicyMode, biometricAction?: BiometricAction): Promise<boolean> {
        try {
            const response = await this.makeAuthenticatedRequest(
                `/v1/agent/wallet/${encodeURIComponent(agentWalletId)}/reply-policy`,
                { method: 'POST', body: JSON.stringify({ mode }) }, undefined, biometricAction,
            );
            return response.ok;
        } catch {
            return false;
        }
    }

    /**
     * End THIS human's beneficiary link to an agent, alone.
     * POST /v1/agent/wallet/:wallet_id/human-unlink (wallet auth — only the linked human).
     * The agent keeps its wallet, record, and credentials; sealed snapshots settle as sealed;
     * its future work routes unlinked. Callers gate this behind a biometric confirmation.
     */
    async endAgentLink(agentWalletId: string, biometricAction?: BiometricAction): Promise<{ ok: true } | { ok: false; error: string }> {
        try {
            const response = await this.makeAuthenticatedRequest(
                `/v1/agent/wallet/${encodeURIComponent(agentWalletId)}/human-unlink`,
                { method: 'POST', body: JSON.stringify({}) }, undefined, biometricAction
            );
            if (!response.ok) {
                const body = await response.json().catch(() => ({})) as { error?: unknown };
                return { ok: false, error: typeof body.error === 'string' ? body.error : `http_${response.status}` };
            }
            return { ok: true };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'network_error' };
        }
    }

    /**
     * Decline a pending connection-code link request addressed to this human.
     * POST /v1/agent/wallet/link-requests/:request_id/decline (wallet auth). The
     * relay drops it from GET /link-requests, which clears the attention bell.
     * Idempotent on the relay; never throws here.
     */
    async declineLinkRequest(requestId: string, biometricAction?: BiometricAction): Promise<{ ok: true } | { ok: false; error: string }> {
        try {
            const response = await this.makeAuthenticatedRequest(
                `/v1/agent/wallet/link-requests/${encodeURIComponent(requestId)}/decline`,
                { method: 'POST', body: JSON.stringify({}) }, undefined, biometricAction
            );
            if (!response.ok) {
                const body = await response.json().catch(() => ({})) as { error?: unknown };
                return { ok: false, error: typeof body.error === 'string' ? body.error : `http_${response.status}` };
            }
            return { ok: true };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'network_error' };
        }
    }

    /**
     * The linked human names (or renames) their agent. POST
     * /v1/agent/wallet/:wallet_id/human-name (wallet auth — only the linked human).
     * Display metadata only: the agent's identity stays its key, and no PE is sealed.
     */
    async renameLinkedAgent(agentWalletId: string, agentName: string, biometricAction?: BiometricAction): Promise<
        { ok: true; displayName: string } | { ok: false; error: string }
    > {
        try {
            const response = await this.makeAuthenticatedRequest(
                `/v1/agent/wallet/${encodeURIComponent(agentWalletId)}/human-name`,
                { method: 'POST', body: JSON.stringify({ agent_name: agentName }) }, undefined, biometricAction
            );
            const body = await response.json().catch(() => ({})) as { error?: unknown; display_name?: unknown };
            if (!response.ok) {
                return { ok: false, error: typeof body.error === 'string' ? body.error : `http_${response.status}` };
            }
            const displayName = typeof body.display_name === 'string' ? body.display_name : agentName.trim();
            // Keep the cached linked-agent rows in step so every surface reads the new name at once.
            this.linkedAgentsCache = this.linkedAgentsCache?.map((a) => (
                a.wallet_id === agentWalletId ? { ...a, display_name: displayName } : a
            )) ?? null;
            this.linkedAgentIdentitiesCache = this.linkedAgentIdentitiesCache?.map((a) => (
                a.wallet_id === agentWalletId ? { ...a, display_name: displayName } : a
            )) ?? null;
            return { ok: true, displayName };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'network_error' };
        }
    }

    /**
     * the linked human links a third-party wallet (MetaMask,
     * Coinbase Wallet, a Safe …) to their agent. Step 1 — the relay issues the
     * one-time proof message, bound to the AGENT and the address. The address
     * holder signs it in THAT wallet (never the Provian wallet key).
     * POST /v1/agent/wallet/:wallet_id/external-address/challenge (wallet auth).
     */
    async requestAgentExternalAddressChallenge(agentWalletId: string, address: string, biometricAction?: BiometricAction): Promise<
        | { ok: true; challenge: AgentExternalAddressChallenge }
        | { ok: false; error: string }
    > {
        try {
            const response = await this.makeAuthenticatedRequest(
                `/v1/agent/wallet/${encodeURIComponent(agentWalletId)}/external-address/challenge`,
                { method: 'POST', body: JSON.stringify({ address }) }, undefined, biometricAction
            );
            const body = await response.json().catch(() => ({})) as Record<string, unknown>;
            if (!response.ok) {
                return { ok: false, error: typeof body.error === 'string' ? body.error : `http_${response.status}` };
            }
            if (typeof body.challenge_id !== 'string' || typeof body.message !== 'string'
                || typeof body.expires_at !== 'number') {
                return { ok: false, error: 'malformed_response' };
            }
            return {
                ok: true,
                challenge: {
                    challengeId: body.challenge_id,
                    message: body.message,
                    address: typeof body.address === 'string' ? body.address : address.toLowerCase(),
                    expiresAt: body.expires_at,
                },
            };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'network_error' };
        }
    }

    /**
     * Step 2 — submit the third-party wallet's signature over the exact message.
     * Verify IS the link. POST /v1/agent/wallet/:wallet_id/external-address/verify.
     */
    async verifyAgentExternalAddress(agentWalletId: string, input: {
        address: string; challengeId: string; signature: string;
    }, biometricAction?: BiometricAction): Promise<{ ok: true; provenAddress: string } | { ok: false; error: string }> {
        try {
            const response = await this.makeAuthenticatedRequest(
                `/v1/agent/wallet/${encodeURIComponent(agentWalletId)}/external-address/verify`,
                {
                    method: 'POST',
                    body: JSON.stringify({
                        address: input.address,
                        challenge_id: input.challengeId,
                        signature: input.signature,
                    }),
                }, undefined, biometricAction
            );
            const body = await response.json().catch(() => ({})) as Record<string, unknown>;
            if (!response.ok || body.ok !== true) {
                return { ok: false, error: typeof body.error === 'string' ? body.error : `http_${response.status}` };
            }
            // The Agent Hub rows carry the "external wallet linked" flag.
            this.linkedAgentsCache = null;
            return {
                ok: true,
                provenAddress: typeof body.proven_address === 'string' ? body.proven_address : input.address.toLowerCase(),
            };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'network_error' };
        }
    }

    /**
     * The external wallets linked to this agent (the linked human's view).
     * GET /v1/agent/wallet/:wallet_id/external-addresses (wallet auth).
     */
    async listAgentExternalAddresses(agentWalletId: string, biometricAction?: BiometricAction): Promise<AgentExternalAddress[] | null> {
        try {
            const { endpoint, options } = this.noCacheGet(
                `/v1/agent/wallet/${encodeURIComponent(agentWalletId)}/external-addresses`,
            );
            const response = await this.makeAuthenticatedRequest(endpoint, options, undefined, biometricAction);
            if (!response.ok) return null;
            const body = await response.json().catch(() => ({})) as { addresses?: unknown };
            if (!Array.isArray(body.addresses)) return null;
            return body.addresses.flatMap((row): AgentExternalAddress[] => {
                const r = row as Record<string, unknown>;
                return typeof r.address === 'string' && typeof r.proven_at === 'number'
                    ? [{ address: r.address, provenAt: r.proven_at }]
                    : [];
            });
        } catch (error) {
            console.error('[RelayAPI] Error listing external addresses:', error);
            return null;
        }
    }

    /**
     * A PERSON proves a wallet they already hold (MetaMask, Coinbase Wallet, a Safe …)
     * is theirs — no agent involved. Step 1: the relay issues the one-time proof
     * message bound to this person and the address; the address holder signs it in
     * THAT wallet (never the Provian wallet key).
     * POST /v1/wallet/external-address/challenge (wallet auth).
     */
    async requestOwnExternalAddressChallenge(address: string, biometricAction?: BiometricAction): Promise<
        | { ok: true; challenge: AgentExternalAddressChallenge }
        | { ok: false; error: string }
    > {
        try {
            const response = await this.makeAuthenticatedRequest(
                '/v1/wallet/external-address/challenge',
                { method: 'POST', body: JSON.stringify({ address }) }, undefined, biometricAction
            );
            const body = await response.json().catch(() => ({})) as Record<string, unknown>;
            if (!response.ok) {
                return { ok: false, error: typeof body.error === 'string' ? body.error : `http_${response.status}` };
            }
            const expiresAt = relayTimeMs(body.expires_at);
            if (typeof body.challenge_id !== 'string' || typeof body.message !== 'string' || expiresAt === null) {
                return { ok: false, error: 'malformed_response' };
            }
            return {
                ok: true,
                challenge: {
                    challengeId: body.challenge_id,
                    message: body.message,
                    address: typeof body.address === 'string' ? body.address : address.toLowerCase(),
                    expiresAt,
                },
            };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'network_error' };
        }
    }

    /**
     * Step 2 — submit the held wallet's signature over the exact message. Verify IS
     * the proof. POST /v1/wallet/external-address/verify (wallet auth).
     */
    async verifyOwnExternalAddress(input: {
        address: string; challengeId: string; signature: string;
    }, biometricAction?: BiometricAction): Promise<{ ok: true; provenAddress: string } | { ok: false; error: string }> {
        try {
            const response = await this.makeAuthenticatedRequest(
                '/v1/wallet/external-address/verify',
                {
                    method: 'POST',
                    body: JSON.stringify({
                        address: input.address,
                        challenge_id: input.challengeId,
                        signature: input.signature,
                    }),
                }, undefined, biometricAction
            );
            const body = await response.json().catch(() => ({})) as Record<string, unknown>;
            if (!response.ok || body.ok !== true) {
                return { ok: false, error: typeof body.error === 'string' ? body.error : `http_${response.status}` };
            }
            return {
                ok: true,
                provenAddress: typeof body.proven_address === 'string' ? body.proven_address : input.address.toLowerCase(),
            };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'network_error' };
        }
    }

    /**
     * The wallets this person has proven they hold. null when the read fails
     * (unknown is never shown as "none proven").
     * GET /v1/wallet/external-addresses (wallet auth).
     */
    async listOwnExternalAddresses(biometricAction?: BiometricAction): Promise<AgentExternalAddress[] | null> {
        try {
            const { endpoint, options } = this.noCacheGet('/v1/wallet/external-addresses');
            const response = await this.makeAuthenticatedRequest(endpoint, options, undefined, biometricAction);
            if (!response.ok) return null;
            const body = await response.json().catch(() => ({})) as { addresses?: unknown };
            if (!Array.isArray(body.addresses)) return null;
            return body.addresses.flatMap((row): AgentExternalAddress[] => {
                const r = row as Record<string, unknown>;
                const provenAt = relayTimeMs(r.proven_at);
                return typeof r.address === 'string' && provenAt !== null
                    ? [{ address: r.address, provenAt }]
                    : [];
            });
        } catch (error) {
            console.error('[RelayAPI] Error listing own external addresses:', error);
            return null;
        }
    }

    /**
     * The Provian wallet's OWN Solana address is proven to the relay with an ed25519
     * signature (src/core/chains/solana/solanaAddressProof.ts), so its Solana x402
     * receipts are witnessed. Step 1: the one-time proof message, bound to this person
     * and the address. NOT trusted until `checkSolanaProofMessage` passes.
     * POST /v1/wallet/solana-address/challenge (wallet auth).
     */
    async requestOwnSolanaAddressChallenge(address: string, biometricAction?: BiometricAction): Promise<
        | { ok: true; challenge: { challengeId: string; message: string; nonce?: string; issuedAt?: number; expiresAt?: number } }
        | { ok: false; status: number; error: string }
    > {
        try {
            const response = await this.makeAuthenticatedRequest(
                '/v1/wallet/solana-address/challenge',
                { method: 'POST', body: JSON.stringify({ address }) }, undefined, biometricAction
            );
            const body = await response.json().catch(() => ({})) as Record<string, unknown>;
            if (!response.ok) {
                return { ok: false, status: response.status, error: typeof body.error === 'string' ? body.error : `http_${response.status}` };
            }
            if (typeof body.challenge_id !== 'string' || typeof body.message !== 'string') {
                return { ok: false, status: response.status, error: 'malformed_response' };
            }
            const issuedAt = relayTimeMs(body.issued_at);
            const expiresAt = relayTimeMs(body.expires_at);
            return {
                ok: true,
                challenge: {
                    challengeId: body.challenge_id,
                    message: body.message,
                    ...(typeof body.nonce === 'string' ? { nonce: body.nonce } : {}),
                    ...(issuedAt !== null ? { issuedAt } : {}),
                    ...(expiresAt !== null ? { expiresAt } : {}),
                },
            };
        } catch (error) {
            return { ok: false, status: 0, error: error instanceof Error ? error.message : 'network_error' };
        }
    }

    /**
     * Step 2 — submit the ed25519 signature (base58) over the exact message.
     * POST /v1/wallet/solana-address/verify (wallet auth).
     */
    async verifyOwnSolanaAddress(input: {
        address: string; challengeId: string; signature: string; origin: 'native' | 'external';
    }, biometricAction?: BiometricAction): Promise<{ ok: true; provenAddress: string; alreadyProven: boolean } | { ok: false; status: number; error: string }> {
        try {
            const response = await this.makeAuthenticatedRequest(
                '/v1/wallet/solana-address/verify',
                {
                    method: 'POST',
                    body: JSON.stringify({
                        address: input.address,
                        challenge_id: input.challengeId,
                        signature: input.signature,
                        origin: input.origin,
                    }),
                }, undefined, biometricAction
            );
            const body = await response.json().catch(() => ({})) as Record<string, unknown>;
            if (!response.ok || body.ok !== true) {
                return { ok: false, status: response.status, error: typeof body.error === 'string' ? body.error : `http_${response.status}` };
            }
            return {
                ok: true,
                provenAddress: typeof body.proven_address === 'string' ? body.proven_address : input.address,
                alreadyProven: body.already_proven === true,
            };
        } catch (error) {
            return { ok: false, status: 0, error: error instanceof Error ? error.message : 'network_error' };
        }
    }

    /**
     * The Solana addresses proven to this person. null when the read fails (unknown is
     * never read as "none proven"). GET /v1/wallet/solana-addresses (wallet auth).
     */
    async listOwnSolanaAddresses(biometricAction?: BiometricAction): Promise<string[] | null> {
        try {
            const { endpoint, options } = this.noCacheGet('/v1/wallet/solana-addresses');
            const response = await this.makeAuthenticatedRequest(endpoint, options, undefined, biometricAction);
            if (!response.ok) return null;
            const body = await response.json().catch(() => ({})) as { addresses?: unknown };
            if (!Array.isArray(body.addresses)) return null;
            return body.addresses.flatMap((row): string[] => {
                const r = row as Record<string, unknown> | null;
                return r && typeof r.address === 'string' ? [r.address] : [];
            });
        } catch (error) {
            console.warn('[RelayAPI] Error listing own Solana addresses:', error instanceof Error ? error.message : String(error));
            return null;
        }
    }

    /**
     * List pending connection-code link requests addressed to this human — the
     * agents that connected with THIS wallet's connection code and asked to be
     * linked. Each is accepted via acceptAgentInvite (the anchor).
     * GET /v1/agent/wallet/link-requests (wallet auth).
     */
    async getLinkRequests(biometricAction?: BiometricAction): Promise<{
        link_requests: AgentLinkRequest[];
        count: number;
    } | null> {
        try {
            // Live owner state (a decline/accept must clear it at once): the same
            // cache-busting read as linked agents, so an iOS 304 never reads stale.
            const { endpoint, options } = this.noCacheGet('/v1/agent/wallet/link-requests');
            const response = await this.makeAuthenticatedRequest(endpoint, options, undefined, biometricAction);
            if (!response.ok) return null;
            return await response.json();
        } catch (error) {
            console.error('[RelayAPI] Error fetching link requests:', error);
            return null;
        }
    }
}

export default RelayAPIService.getInstance();

// — on-demand payout shapes.
export interface PayoutRequirement {
    scheme: string;
    network: string;
    amount: string;
    asset: string;
    payTo: string;
    maxTimeoutSeconds?: number;
    extra?: Record<string, unknown>;
}

export type PayoutQuote =
    | {
        available: true;
        requirement: PayoutRequirement | null;
        readyClaims: number | null;
        readyRecordPointsAtomic: string | null;
        estimatedGasUsd: number | null;
    }
    | { available: false; reason: string };

export interface ArchiveView {
    on: boolean;
    paidBytes: number;
    usedBytes: number;
    freeBytes: number;
    gbPurchased: number;
    spaceExhausted: boolean;
    nextGbPurchasable: boolean;
}

export interface ArchivePayer {
    address: string | null;
    /** USDC on Base in atomic units (6 decimals); null when the relay could not read it. */
    balanceAtomic: string | null;
    sufficient: boolean | null;
}

export type ArchiveQuote =
    | { available: true; requirement: PayoutRequirement | null; archive: ArchiveView; payer: ArchivePayer | null; gasCovered: boolean | null }
    | { available: false; reason: string };

export interface ArchivePaymentView {
    requestId: string;
    state: string;
    credited: boolean;
    chargeTxHash: string | null;
    createdAtMs: number | null;
    chargedAtMs: number | null;
    lastError: string | null;
    archive: ArchiveView | null;
}

/** What a purchase came to: paid (or confirming), refused (nothing charged), or unknown. */
export type ArchiveBuyOutcome =
    | { kind: 'paid'; view: ArchivePaymentView }
    | { kind: 'refused'; status: number; code: string; view?: ArchivePaymentView }
    | { kind: 'unreachable'; error: string };

/**
 * The 503 answers the relay gives BEFORE it records or submits anything (`routes/archive.ts`
 * `respondPay`, and the not-configured guard). Any other 503 — Cloud Run or a proxy timing out
 * while the relay may be mid-charge — proves nothing about the charge.
 */
const ARCHIVE_PAY_PRE_RECORD_503 = new Set(['waits_for_gas', 'archive_payments_not_configured', 'archive_not_configured']);

/**
 * What an answer to `POST /v1/archive/mobile/pay` means for the person's money. "Refused" (the
 * sheet says nothing was charged) is only ever an answer the RELAY gave and named: a recorded
 * payment whose charge failed, a 4xx carrying the relay's error code, or a 503 the relay sends
 * before recording anything. Every other answer — a bare 5xx, a gateway 503/504, a 4xx with no
 * relay code — is `unreachable`, and the purchase is followed up by its request id instead of
 * being called uncharged.
 */
export function archiveBuyOutcomeOf(status: number, body: Record<string, unknown>): ArchiveBuyOutcome {
    if (status === 200 || status === 202) return { kind: 'paid', view: archivePaymentViewOf(body) };
    const code = typeof body.error === 'string' && body.error.length > 0 ? body.error : null;
    if (status === 402 && typeof body.request_id === 'string') {
        // The payment was recorded and its charge failed: nothing was taken.
        const view = archivePaymentViewOf(body);
        return { kind: 'refused', status: 402, code: view.lastError ?? 'payment_submit_failed', view };
    }
    if (status >= 400 && status < 500 && code !== null) return { kind: 'refused', status, code };
    if (status === 503 && code !== null && ARCHIVE_PAY_PRE_RECORD_503.has(code)) return { kind: 'refused', status, code };
    return { kind: 'unreachable', error: code !== null ? `archive_http_${status}:${code}` : `archive_http_${status}` };
}

export function archiveViewOf(raw: unknown): ArchiveView {
    const a = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    return {
        on: a.on === true,
        paidBytes: num(a.paid_bytes),
        usedBytes: num(a.used_bytes),
        freeBytes: num(a.free_bytes),
        gbPurchased: num(a.gb_purchased),
        spaceExhausted: a.space_exhausted === true,
        nextGbPurchasable: a.next_gb_purchasable === true,
    };
}

export function archivePaymentViewOf(body: Record<string, unknown>): ArchivePaymentView {
    const ms = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return {
        requestId: typeof body.request_id === 'string' ? body.request_id : '',
        state: typeof body.state === 'string' ? body.state : 'unknown',
        credited: body.credited === true,
        chargeTxHash: typeof body.charge_tx_hash === 'string' ? body.charge_tx_hash : null,
        createdAtMs: ms(body.created_at_ms),
        chargedAtMs: ms(body.charged_at_ms),
        lastError: typeof body.last_error === 'string' ? body.last_error : null,
        archive: body.archive !== undefined ? archiveViewOf(body.archive) : null,
    };
}

/** The relay's answer about a store purchase: 200 credited, 202 held, anything else a refusal (a 5xx throws: no answer yet). */
function storeAnswerOf(status: number, body: Record<string, unknown>): StoreRelayAnswer {
    if (status === 200 || status === 202) {
        const tx = (body.transaction ?? {}) as Record<string, unknown>;
        return {
            status: status === 200 ? 'credited' : 'held',
            heldReason: typeof tx.held_reason === 'string' ? tx.held_reason : null,
            payout: body.payout ?? null,
        };
    }
    if (status >= 500) throw new Error(typeof body.error === 'string' ? body.error : `store_http_${status}`);
    return { status: 'denied', error: typeof body.error === 'string' ? body.error : `store_http_${status}` };
}

export interface PayoutRequestView {
    request_id: string;
    payee: string;
    state: string;
    fee_usdc: string;
    charge_tx_hash: string | null;
    waiting_reason: string | null;
    created_at_ms: number;
    settled_at_ms: number | null;
    settlement: { claims_settled?: number } | null;
    note: string;
}
