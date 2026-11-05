/**
 * Agent Self-Signup - Type definitions
 *
 * All interfaces for agent wallet creation, governance, badges,
 * leaderboard, and invites.
 */

import type { Firestore } from 'firebase-admin/firestore';
import type { Messaging } from 'firebase-admin/messaging';
import type { RedisCache } from '../../cache';
import type { NativeWalletRegistrationFence } from '../pvt/native-wallet-registration';
import type { GenesisActivationApprovalVerifier } from '../pvt/policy/genesis-policy-engine';
import type { AgentBeneficiaryShareBps } from './beneficiary-relationship';

/** Version recorded with a new wallet's optional Network Constitution acceptance. */
export const NETWORK_CONSTITUTION_VERSION = 'network-constitution-2026-09-27';
export const APPROVED_NETWORK_CONSTITUTION_VERSIONS = [
  NETWORK_CONSTITUTION_VERSION,
] as const;

export function isCurrentNetworkConstitutionVersion(version: string): boolean {
  return version === NETWORK_CONSTITUTION_VERSION;
}

// ---------------------------------------------------------------------------
// Badge system
// ---------------------------------------------------------------------------

export type BadgeId =
  | 'genesis_agent'
  | 'chain_builder'
  | 'architect'
  | 'constellation'
  | 'governed'
  | 'linked'
  | 'x402_pioneer'
  | 'signal'
  | 'seven_day_streak'
  | 'thirty_day_streak'
  | 'pvt_minter'
  | 'governance_participant'
  | 'insured_agent';

export interface BadgeDefinition {
  id: BadgeId;
  name: string;
  description: string;
  icon: string;
}

export interface EarnedBadge {
  id: BadgeId;
  earned_at: number;
}

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

export interface AgentGovernanceSettings {
  pe_coverage_enabled: boolean;
  attestation_enabled: boolean;
  human_oversight_enabled: boolean;
  spending_limits_enabled: boolean;
  full_governance: boolean;
}

export const DEFAULT_GOVERNANCE: AgentGovernanceSettings = {
  pe_coverage_enabled: false,
  attestation_enabled: false,
  human_oversight_enabled: false,
  spending_limits_enabled: false,
  full_governance: false,
};

// ---------------------------------------------------------------------------
// Agent Wallet Document (Firestore: agent_wallets)
// ---------------------------------------------------------------------------

export interface AgentWalletDocument {
  id: string;                           // wallet_aw_{uuid}
  agent_id: string;                     // External agent identifier
  display_name: string;                 // Agent display name
  /**
   * Present once the linked human has named the agent (accept-invite `agent_name` or
   * `POST /:wallet_id/human-name`). While set, the agent cannot overwrite the name
   * (core/agent-wallet/human-agent-name.ts). Display metadata only — never identity.
   */
  display_name_set_by?: 'linked_human';
  display_name_set_at?: number;
  platform: string;                     // e.g. 'openclaw', 'custom'
  address: string;                      // Derived EVM address
  public_key: string;                   // 128 hex chars (no 04 prefix)
  api_key_hash: string;                 // scrypt hash of api_key:api_secret
  api_key_salt: string;                 // Random salt for scrypt
  api_key_prefix: string;              // First 24 chars of api_key (for index lookup)
  governance: AgentGovernanceSettings;
  badges: EarnedBadge[];
  streak_days: number;
  last_pe_date: string | null;         // YYYY-MM-DD of last PE
  chains: string[];                     // Supported chains e.g. ['base', 'ethereum']
  /**
   * Self-sovereign per-chain addresses the agent derived from its OWN key. `evm`
   * mirrors `address`; `solana` is a base58 ed25519 address the relay never
   * derives (the agent's secret key stays on the agent's machine). Display-only,
   * so the app can show + fund the agent's Solana address. Absent until the
   * agent reports one (create body or the report endpoint).
   */
  chain_addresses?: { evm: string; solana: string } | null;
  callback_url: string | null;          // Optional webhook URL
  linked_human_wallet_id: string | null;
  linked_human_user_id: string | null;   // Human's userId for pvt_accrual lookup
  linked_human_address: string | null;   // Human's EVM address for minting
  parent_wallet_id: string | null;       // Sub-agent parent wallet ID
  /** Canonical beneficiary-routing agent share; exact 500-5000 BPS. */
  operational_reserve_bps?: AgentBeneficiaryShareBps | null;
  /** Read-only v1 compatibility field. New writes never persist this ratio. */
  operational_reserve_ratio?: number | null;
  children_wallet_ids: string[];         // Sub-agent wallet IDs
  constitution_accepted_at?: number;
  constitution_version?: string;
  economic_activity_usd: number;
  /**
   * PVT-denominated economic activity (BigInt-as-string, 18 decimals).
   * Tracked separately from economic_activity_usd to avoid an oracle
   * dependency in trust scoring. USD-denominated thresholds (bond trust
   * discount, arbitrator eligibility) keep using economic_activity_usd;
   * the bond trust discount now ALSO consumes PVT metrics directly (see
   * Workstream 2 Q-3 / PVT-aware trust discount).
   *
   * Optional for backwards compat. Backfill migration writes '0'.
   */
  economic_activity_pvt?: string;
  /**
   * Lifetime PVT currently held by this agent (BigInt-as-string, 18 decimals).
   * Cached from on-chain balance reads. Used as a factor in the bond trust
   * discount. Updated opportunistically on wallet reads and mint events;
   * callers that need wei-exact values should query the PVT contract
   * directly. Optional for backwards compat; treated as 0 when absent.
   */
  pvt_held_cached?: string;
  /**
   * Lifetime PVT burned via protocolBurn attributable to this agent
   * (BigInt-as-string, 18 decimals). Sum of fees burned on this agent's
   * Commons institutions primitives (escrow, promise, pool, bond, etc.) when those
   * primitives chose the PVT-fee path, plus any voluntary burn calls the
   * agent made. Drives a factor in the bond trust discount: burning PVT on
   * protocol use is durable signal of network participation. Optional for
   * backwards compat; treated as 0 when absent.
   */
  pvt_burned_attributable?: string;
  x402_payment_count: number;
  attestation_count: number;
  /**
   * Total number of successful key rotations. Incremented inside the
   * rotate-key transaction. Replaces the previous rotation_history array
   * (now a subcollection at agent_wallets/{wallet_id}/rotation_history)
   * for use cases that just need the count without enumerating entries.
   * Optional for backwards compat; treated as 0 when absent.
   */
  rotation_count?: number;
  /**
   * Timestamp (epoch ms) of the most recent successful key rotation. Set
   * inside the rotate-key transaction so the 24-hour cooldown check is
   * atomic with the wallet update. Optional for backwards compat; treated
   * as 0 when absent (no rotation has occurred yet).
   */
  last_rotated_at?: number;
  status: 'active' | 'suspended' | 'revoked';
  created_at: number;
  updated_at: number;
  /** Two-operator-agreed Base head captured during native wallet birth. New
   * wallets require this fence before entering the inbound economic watcher;
   * optional only so legacy stored documents can be rejected explicitly. */
  native_watcher_registration?: NativeWalletRegistrationFence;
}

/**
 * Entry in the rotation_history subcollection at
 * agent_wallets/{wallet_id}/rotation_history/{rotation_id}. The doc id is
 * the rotation_id generated outside the rotate-key transaction.
 */
export interface RotationHistoryEntry {
  rotation_id: string;
  old_address: string;
  new_address: string;
  rotated_at: number;
  /**
   * PE id associated with this rotation. Null between the moment the
   * rotation transaction commits and the follow-up update that lands after
   * generatePEAtomic returns. A null value means the rotation occurred but
   * the PE could not be emitted; the relay logs an ERROR and manual
   * reconciliation may be required. External observers must tolerate null.
   */
  pe_id: string | null;
}

// ---------------------------------------------------------------------------
// API Key Index (Firestore: api_key_index)
// ---------------------------------------------------------------------------

export interface ApiKeyIndexDocument {
  api_key_prefix: string;              // First 24 chars of api_key
  wallet_id: string;                   // References agent_wallets/{id}
  created_at: number;
}

// ---------------------------------------------------------------------------
// Agent Invite (Firestore: agent_invites)
// ---------------------------------------------------------------------------

export interface AgentInviteDocument {
  id: string;                          // inv_{uuid}
  agent_wallet_id: string;
  agent_display_name: string;
  email?: string;                      // delivery address for email invites; ABSENT for connection-code link requests (discovered in-app, no email)
  status: 'pending' | 'accepted' | 'expired' | 'declined';
  created_at: number;
  expires_at: number;                  // 7 (standard) or 30 (beneficiary) days from creation; honored by the consumption endpoints (7d fallback when absent)
  invite_type?: 'standard' | 'beneficiary';
  signing_bonus_pvt?: number;          // Legacy compatibility field; always zero on current invite/link paths
  agent_pe_count?: number;
  // Connection-code link request (POST /:wallet_id/request-link): the human who
  // issued the code. When present, ONLY that human may accept (enforced in
  // accept-invite) — a strengthening of the anchor, never a weakening. Email
  // invites omit it and stay bearer-claimable as before.
  for_human_user_id?: string;
  origin?: 'connection_token';         // provenance of a code-originated link request
  // Set by accept-invite once the human authorizes the link. `status` also flips
  // to 'accepted'; `accepted_at` is the idempotency anchor (a re-accept by the
  // same human reuses it). The link-requests list excludes any invite carrying
  // accepted_at so a bound invite never lingers as a dead "authorize" card.
  accepted_at?: number;
  accepted_by_user_id?: string;
  accepted_by_wallet_id?: string;
  // a link formed at request-link by a fleet code (one of the human's
  // linked agents issued it) instead of the human's Accept tap, and which
  // agent issued that code.
  accepted_via?: 'fleet_code';
  issued_by_agent_wallet_id?: string;
  // Set by POST /link-requests/:request_id/decline (the addressed human only).
  declined_at?: number;
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

export interface LeaderboardEntry {
  rank: number;
  wallet_id: string;
  agent_id: string;
  display_name: string;
  address: string;
  composite_score: number;
  pe_count: number;
  economic_activity_usd: number;
  streak_days: number;
  x402_payment_count: number;
  badges: EarnedBadge[];
  pvt_estimate_rank: string;           // 'top_1%' | 'top_5%' | 'top_10%' | 'top_25%' | 'building'
  provenance_url: string;
}

export interface LeaderboardResponse {
  network_stats: {
    total_agents: number;
    total_pes_generated: number;
    total_economic_activity_usd: number;
  };
  leaderboard: LeaderboardEntry[];
  cached_at: number;
}

export interface AgentProfileResponse {
  wallet_id: string;
  agent_id: string;
  display_name: string;
  platform: string;
  address: string;
  pe_count: number;
  badges: EarnedBadge[];
  streak_days: number;
  economic_activity_usd: number;
  x402_payment_count: number;
  composite_score: number;
  rank: number | null;
  pvt_estimate_rank: string;
  provenance_url: string;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Router dependencies (injected from server.ts)
// ---------------------------------------------------------------------------

export interface RouterDeps {
  db: Firestore;
  cache: RedisCache;
  peBuffer: { enqueue: (docId: string, data: object) => void };
  recordPEAccrual: (params: {
    peId: string;
    userId: string;
    actionType: string;
    integrationSource: string;
    // PE METER: the batch the act is metered in (relay-authored acts price as a one-act relay
    // batch, `meter-relay-authored.ts`). The accrual seals through the meter when it is present.
    meter?: import('../../pvt-accrual').RecordPEAccrualParams['meter'];
    attestationDepth: 'hardware' | 'software';
    peHash: string;
    timestamp: number;
  }) => Promise<void>;
  keccak256: (input: Buffer) => Buffer;
  deriveAddressFromPublicKey: (publicKeyHex: string) => string;
  /** Production binds this to the two-operator Base head reader. */
  readBaseRegistrationHead?: () => Promise<number>;
  /** Test seam for proving recovery validates durable identity before even
   * creating a replacement secret. Production uses the hardened generator. */
  generateRecoveryApiCredentials?: () => Promise<{
    api_key: string;
    api_secret: string;
    api_key_hash: string;
    api_key_salt: string;
    api_key_prefix: string;
  }>;
  /** Drains a freshly persisted Genesis outbox row. Best-effort: the outbox is the
   * durable source of truth, so a failure here leaves the grant queued, never lost. */
  processGenesisQualification?: (qualificationId: string) => Promise<unknown>;
  /** Explicit test seam. Production always uses structured SSHSIG verification. */
  genesisActivationApprovalVerifier?: GenesisActivationApprovalVerifier;
}

// ---------------------------------------------------------------------------
// API Request/Response types
// ---------------------------------------------------------------------------

export interface CreateAgentWalletRequest {
  /** Caller-generated stable identity, durably retained with the wallet key
   * before the first challenge request. Reused on every ambiguous retry. */
  registration_id: string;
  agent_name: string;
  agent_id: string;
  platform: string;
  chains?: string[];
  /**
   * OPTIONAL self-sovereign per-chain addresses the agent derived from its OWN
   * key (which the relay never holds). `evm` must equal the PoP-verified EVM
   * address or it is ignored; `solana` is a base58 ed25519 address the relay
   * CANNOT derive or verify — stored display-only so the app can show + fund the
   * agent's Solana address. A wrong value is only self-harm (the agent controls
   * that address). Absent for pre-Solana SDKs; a wallet simply has no
   * chain_addresses until it reports one.
   */
  chain_addresses?: { evm?: string; solana?: string } | null;
  governance?: Partial<AgentGovernanceSettings>;
  callback_url?: string;
  parent_wallet_id?: string;           // If spawned by another agent
  agent_session_id?: string;           // RETIRED : accepted from older SDK builds and ignored

  connection_token?: string | null;
  constitution_accepted?: boolean;     // Optional: records Network Constitution acceptance (not required)
  constitution_version?: string;       // Omitted: the version already on record for this registration_id, else NETWORK_CONSTITUTION_VERSION
  constitution_accepted_at?: string;   // ISO timestamp supplied by SDK/agent

  // Proof-of-possession (REQUIRED). The agent generates its own secp256k1
  // keypair locally, fetches a challenge via GET /v1/agent/wallet/challenge,
  // signs it, and submits the signature here. The relay never sees or
  // generates the private key. See core/agent-wallet/proof-of-possession.ts.
  public_key: string;       // 64-byte uncompressed secp256k1 hex (no 04 prefix)
  challenge_id: string;     // From GET /v1/agent/wallet/challenge
  signature: string;        // ECDSA signature over the challenge bytes

  // HIGH-2 (Wave 4): when parent_wallet_id is set, parent_proof_of_authorization
  // is REQUIRED. The parent fetches a challenge from
  // GET /v1/agent/wallet/parent-challenge?parent_wallet_id=&child_address=
  // bound to {parent_wallet_id, child_address}, signs it with the parent's
  // registered secret key, and the SDK forwards both fields here.
  parent_proof_of_authorization?: {
    challenge_id: string;
    signature: string; // ECDSA over canonicalPopMessage by parent.public_key
  };
}

export interface CommonsInstitutionsPerChainAddresses {
  base: string;
  arbitrum: string;
  optimism: string;
}

export interface CommonsInstitutionsServiceStatus {
  status: 'live' | 'coming_soon';
  description: string;
  /** Per-chain contract address. Empty string when the chain has no deployment. */
  contract_addresses: CommonsInstitutionsPerChainAddresses;
}

export interface CommonsInstitutionsWelcome {
  headline: string;
  /** Mainnet chains where Commons institutions contracts are deployed. */
  chains_supported: ReadonlyArray<'base' | 'arbitrum' | 'optimism'>;
  escrow: CommonsInstitutionsServiceStatus;
  promises: CommonsInstitutionsServiceStatus;
  pools: CommonsInstitutionsServiceStatus;
  court: CommonsInstitutionsServiceStatus;
  why_it_matters: string;
}

export interface WelcomeMessage {
  message: string;
  what_are_pes: string;
  why_governance: string;
  pvt_preview: string;
  x402: string;
  pe_open_source: string;
  leaderboard: string;
  commons_institutions: CommonsInstitutionsWelcome;
  pvt_status: {
    status: 'live' | 'coming_soon';
    description: string;
    contract_addresses: CommonsInstitutionsPerChainAddresses;
  };
  governance: {
    status: 'live' | 'coming_soon';
    description: string;
    /** Governance and the canonical PE anchor live on Base only by design. */
    chain: 'base';
    contract_address: string;
  };
  /**
   * Multi-chain contract registry. Per-chain blocks for Commons institutions contracts;
   * `base_only_by_design` for governance and PE anchor which intentionally
   * live on Base only.
   */
  contracts: {
    chains_supported: ReadonlyArray<'base' | 'arbitrum' | 'optimism'>;
    base: { chain_id: number; usdc: string; escrow: string; promise: string; pool: string; court: string; pvt: string };
    arbitrum: { chain_id: number; usdc: string; escrow: string; promise: string; pool: string; court: string; pvt: string };
    optimism: { chain_id: number; usdc: string; escrow: string; promise: string; pool: string; court: string; pvt: string };
    base_only_by_design: { governance: string; pe_anchor: string };
  };
  /**
   * A9 : gate-aware. Pre-flip, a deliberately-dark surface is served as
   * `{ url, opens_at_launch: true }` instead of a bare dead link; at the flip
   * every entry is a plain live URL string again.
   */
  start_here: Record<string, string | { url: string; opens_at_launch: true }>;
  get_started: string;
  linking: {
    status: 'unlinked' | 'linked';
    current_earning_rate: string;
    linked_earning_rate: string;
    earning_premium: string;
    how_to_link: string;
    why_link: string;
  };
  /**
   * Project Genesis: the agent's economic-identity on-ramp. The wallet is not
   * just a balance — real activity builds a verifiable record that can mint PVT.
   * States the launch-window reward without asserting it is live (the
   * genesis/status endpoint reports the actual campaign state), and names both
   * on-ramps (create native, or prove an existing EVM wallet).
   */
  genesis: {
    headline: string;
    two_ways_in: string;
    what_earns: string;
    track_progress: string;
    integrity: string;
  };
}

export interface CreateAgentWalletResponse {
  wallet_id: string;
  address: string;
  public_key: string;                 // Echo of submitted public key (caller already has the matching private key)
  api_key: string;
  api_secret: string;
  pe_chain_root: string;
  badges: EarnedBadge[];
  welcome: WelcomeMessage;
  /** the phone-minted recovery anchor the connection token carried (base64url), when any. */
  recovery_anchor_pubkey?: string;
}

export interface PopChallengeResponse {
  challenge_id: string;
  challenge: string;
  expires_at: number;
}

// ---------------------------------------------------------------------------
// Beneficiary linking request/response types
// ---------------------------------------------------------------------------

export interface LinkHumanRequest {
  human_wallet_id: string;
  /**
   * 0x-prefixed hex EIP-191 (`personal_sign`) signature of the canonical
   * link payload by the human's BIP-39-derived secp256k1 wallet key.
   * The relay recovers the EVM address from the signature and compares
   * it to the address on the human's `wallets/` document.
   */
  signature: string;
  timestamp: number;                   // Must be within 5 min of server time
  /** the relationship epoch the signature names (GET /:wallet_id/link-epoch). Single-use. */
  link_epoch: number;
  /** Canonical agent share. Defaults to 2000; exact integer range [500, 5000]. */
  operational_reserve_bps?: number;
  /** Legacy request compatibility; converted exactly and never persisted. */
  operational_reserve_ratio?: number;
}

export interface UnlinkHumanRequest {
  /** 0x-prefixed hex EIP-191 signature; same recovery as LinkHumanRequest. */
  signature: string;
  timestamp: number;
  /** the relationship epoch the signature names (GET /:wallet_id/link-epoch). Single-use. */
  link_epoch: number;
}

export interface InviteHumanRequest {
  human_email?: string;
  message?: string;                    // Optional personalized message
}

export interface LinkHumanResponse {
  wallet_id: string;
  linked_human_wallet_id: string;
  operational_reserve_bps: AgentBeneficiaryShareBps;
  new_badges: string[];
  retroactive_transfer: {
    total_pvt_transferred: number;
    agent_retained: number;
    human_received: number;
  };
}

export interface InviteHumanResponse {
  invite_id: string;
  status: 'sent';
  signing_bonus_pvt: number;
  agent_pe_count: number;
  expires_at: number;
}

// ---------------------------------------------------------------------------
// Key Rotation
// ---------------------------------------------------------------------------

export interface RotateKeyRequest {
  /** Durable SDK rotation: credentials are staged locally before the identity cut. */
  rotation_id?: string;
  new_api_key?: string;
  new_api_secret?: string;
  new_address: string;
  new_public_key: string;     // 128 hex chars (64 bytes, no 04 prefix)
  proof_of_old_key: string;   // hex ECDSA-SHA256 signature with OLD private key
  proof_of_new_key: string;   // hex ECDSA-SHA256 signature with NEW private key
  timestamp: number;          // Must be within 5 minutes
  /**
   * the NEW key re-sealed to the agent's recovery anchor, written
   * ATOMICALLY with the identity cut. REQUIRED when the agent already holds a
   * recovery escrow (the rotation may not orphan it); optional only when the
   * agent has no escrow to re-seal (nothing to keep recoverable yet).
   */
  sealed_key_blob?: string;
  recovery_anchor_pubkey?: string;
}

export interface RotateKeyResponse {
  wallet_id: string;
  old_address: string;
  new_address: string;
  api_key: string;
  api_secret: string;
  rotated_at: number;
}

// ---------------------------------------------------------------------------
// Recovery re-key — re-key an agent whose OLD signing key is lost.
//
// The standard rotate-key needs the OLD key's proof-of-possession. When the
// key is lost (no at-rest secret, no escrow to unseal) that PoP can never be
// produced. The recovery re-key waives the old-key PoP and instead requires
// the LINKED HUMAN's wallet auth — the same non-custodial recovery custodian
// who reads the escrow — plus NEW-key PoP. It escrows the new key in the same
// handler so the re-keyed identity is recoverable immediately. It moves no
// funds (the new address controls the go-forward identity; the old address's
// on-chain balance is unaffected and stays where it is).
// ---------------------------------------------------------------------------

export interface RecoveryRekeyRequest {
  new_address: string;
  new_public_key: string;     // 128 hex chars (64 bytes, no 04 prefix)
  proof_of_new_key: string;   // hex ECDSA-SHA256 signature with NEW private key
  timestamp: number;          // Must be within 5 minutes
  /** base64url sealed box of the NEW key to the phone anchor (relay never opens it). */
  sealed_key_blob: string;
  /** base64url x25519 anchor public key the blob was sealed to. */
  recovery_anchor_pubkey: string;
}

export interface RecoveryRekeyResponse {
  wallet_id: string;
  old_address: string;
  new_address: string;
  api_key: string;
  api_secret: string;
  rotated_at: number;
  recovery_escrowed: true;
}
