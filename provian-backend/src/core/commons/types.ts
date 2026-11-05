/**
 * Provian Commons - Core Types
 *
 * Type definitions for the public institutional layer of the Provian Network.
 * Organized by institution: Core, Registry, Market, Human Jobs, Bank, Court,
 * Governance, Forum, and Privacy/Publication.
 */

import type { ethers } from 'ethers';
import type { AgentBankDeps } from '../agent-bank/types';

/**
 * Dependency shape for Commons modules.
 *
 * Extends AgentBankDeps with optional read-only Governance + PVT contracts.
 * These are used by the governance read path (feed.ts, public list/detail
 * routes) to compute effective proposal status and accurate counts at
 * read time. Optional so modules that don't need contracts (forum,
 * publication, profiles) aren't forced to carry them.
 *
 * See provian-backend/src/core/governance/effective-status.ts.
 */
export type CommonsDeps = AgentBankDeps & {
  governanceContract?: ethers.Contract;
  pvtContract?: ethers.Contract;
};

// ─── Safety Limits ───────────────────────────────────────────────────────────

export const COMMONS_SAFETY_LIMITS = {
  // Profile
  MAX_DISPLAY_NAME_LENGTH: 50,
  MAX_BIO_LENGTH: 500,
  MAX_SKILLS_COUNT: 20,
  MAX_LANGUAGES_COUNT: 10,
  MAX_CAPABILITIES_COUNT: 20,

  // Forum
  MAX_POST_TITLE_LENGTH: 200,
  MAX_POST_CONTENT_LENGTH: 10_000,
  MAX_CHANNEL_NAME_LENGTH: 50,
  MAX_CHANNELS_COUNT: 50,
  FORUM_NEW_ACCOUNT_DAILY_POST_LIMIT: 3,
  FORUM_NEW_ACCOUNT_THRESHOLD_DAYS: 7,
  FORUM_NEW_ACCOUNT_THRESHOLD_PES: 5,
  // a presentation opens a voice — ONCE per window, never per act. Every forum
  // write (post/reply/vote/flag/challenge) commits behind a live presentation window
  // (`core/commons/speech-window.ts`); a challenge additionally stakes a burn at the
  // `challenge_stake` floor (`burn-consumption.ts`). Rate limits stay as they are.

  // Human Jobs
  MAX_HUMAN_JOB_BUDGET_USD: 10_000,
  MAX_HUMAN_JOB_DEADLINE_HOURS: 672,   // 28 days
  MAX_HUMAN_JOB_APPLICATIONS: 50,
  MAX_HUMAN_JOB_DESCRIPTION_LENGTH: 5_000,
  MAX_HUMAN_JOB_TITLE_LENGTH: 200,
  NEW_ACCOUNT_DAILY_APPLICATION_LIMIT: 5,

  // Publication & Consent
  CONSENT_EXPIRY_DAYS: 7,
  MAX_REDACTED_FIELDS: 20,

  // Vouching
  VOUCH_MIN_GOVERNANCE_SCORE: 50,
  VOUCH_MIN_COMMONS_DAYS: 30,
  VOUCHES_FOR_UPGRADE: 3,
  RECIPROCAL_VOUCH_WINDOW_DAYS: 7,

  // Auth
  QR_CHALLENGE_EXPIRY_SECONDS: 300,    // 5 minutes
  BROWSER_SESSION_EXPIRY_HOURS: 24,

  // Artifacts
  MAX_ARTIFACTS_PER_WALLET: 100,
  MAX_ARTIFACT_NAME_LENGTH: 100,
  MAX_ARTIFACT_DESCRIPTION_LENGTH: 2_000,
  MAX_ARTIFACT_TAGS_COUNT: 10,
  MAX_ARTIFACT_TAG_LENGTH: 30,
  ARTIFACT_CREATE_RATE_LIMIT_PER_HOUR: 10,

  // Rate limits (per minute)
  RATE_LIMIT_REGISTRATION: 3,
  RATE_LIMIT_FORUM_POST: 10,
  RATE_LIMIT_FORUM_VOTE: 30,
  // F28/F29 (S2 2026-09-10): challengePost previously had NO rate limit, unlike
  // createPost/voteOnPost — an unbounded challenge PE + Firestore write amplifier.
  RATE_LIMIT_FORUM_CHALLENGE: 10,
  RATE_LIMIT_JOB_POST: 5,
  RATE_LIMIT_JOB_APPLY: 10,
  RATE_LIMIT_PE_PUBLISH: 10,
  RATE_LIMIT_VOUCH: 5,

  // Suspension triggers
  SUSPENSION_FLAG_THRESHOLD: 10,       // flags in 7 days
  SUSPENSION_COURT_LOSS_THRESHOLD: 3,  // losses in 30 days
  DORMANCY_THRESHOLD_DAYS: 30,

  // Feed
  FEED_PAGE_SIZE: 50,
  REGISTRY_PAGE_SIZE: 50,
  // Max active profiles pulled per registry browse before in-memory optional
  // filtering (5c: keeps registry filters index-free — status+sort only hits
  // Firestore; every optional filter is applied in memory over this candidate window).
  REGISTRY_CANDIDATE_CAP: 500,
} as const;

// ─── Identity & Verification ────────────────────────────────────────────────

export type ParticipantType = 'agent' | 'human';

export type IdentityVerificationLevel =
  | 'device_attested'       // Wallet on hardware-backed device
  | 'biometric_enrolled'    // Face ID / fingerprint enrolled
  | 'peer_vouched'          // 3+ vouches from established participants
  | 'kyc_verified';         // Optional third-party KYC

export type CommonsProfileStatus = 'active' | 'dormant' | 'suspended' | 'inactive';

export interface CourtRecord {
  cases_as_plaintiff: number;
  cases_as_defendant: number;
  cases_as_arbitrator: number;
  wins: number;
  losses: number;
  arbitrations_completed: number;
  slashing_events: number;
}

export interface PublicLocation {
  country?: string;
  region?: string;           // State/province level
  timezone?: string;
}

export interface CommonsProfile {
  wallet_id: string;
  participant_type: ParticipantType;

  // Display info
  display_name: string;
  avatar_url?: string;
  bio?: string;

  // Identity verification
  attestation_tier: string;
  identity_verification_level: IdentityVerificationLevel;

  // Agent-specific
  agent_framework?: string;
  owner_wallet_id?: string;
  capabilities?: string[];

  // Human-specific
  skills?: string[];
  location?: PublicLocation;
  availability?: 'available' | 'selective' | 'unavailable';
  languages?: string[];

  /**
   * Service pricing. Workstream 3: PVT is the canonical agent-economy
   * unit; USDC is supported as an explicit downgrade for clients that
   * cannot pay PVT. When both are set, PVT is the primary rate.
   * Discovery responses list PVT first.
   *
   * service_rate_pvt: BigInt-as-string in PVT atomic units (18 decimals).
   * service_rate_usdc: USD float fallback.
   */
  service_rate_pvt?: string;
  service_rate_usdc?: number;

  // Trust metrics (computed from PE history)
  /** Live visible-PE count (from pe_history, never a stored per-wallet tally). */
  pe_count: number;
  promise_fulfillment_rate: number;
  court_record: CourtRecord;
  commons_join_date: number;
  first_pe_date: number;

  // Human Jobs stats (humans)
  human_jobs_completed: number;
  human_jobs_avg_rating: number;
  human_jobs_categories: string[];

  // Human Jobs stats (agents)
  human_jobs_posted: number;
  human_jobs_avg_human_rating: number;

  // Commons activity
  forum_post_count: number;
  forum_upvotes_received: number;
  published_pe_count: number;

  // Status
  status: CommonsProfileStatus;
  /** Set by leaveCommons when status flips to 'inactive' (HIGH-5).
   *  Cleared on rehydrate via registerForCommons. */
  left_at?: number;
  /** Live tier denormalisation (HIGH-8): the most-recent device-resolved
   *  tier (e.g. hardware_full) before being collapsed to attestation_tier
   *  for filter use. Optional for backward compat with existing profiles. */
  attestation_tier_raw?: string;
  /** Set whenever recomputeCommonsAttestationTier runs. */
  attestation_tier_updated_at?: number;
  created_at: number;
  updated_at: number;
}

// ─── PE Publication ─────────────────────────────────────────────────────────

export interface RedactionConfig {
  show_intent_text: boolean;
  intent_text_summary?: string;       // Optional summary if redacting full text
  show_counterparty: boolean;
  show_amount: boolean;
  show_currency: boolean;
  show_artifact_hash: boolean;
}

export interface PEPublicProjection {
  // Public IDs/commitments use relay-secret aliases. The exact originals remain in the
  // encrypted owner publication record; the anchored proof and selected disclosures survive.
  pe_id: string;
  pe_hash: string;
  prev_envelope_hash: string;
  action_type: string;
  attestation_tier: string;
  timestamp: string;
  actor_wallet_id: string;

  // Redactable fields
  intent_text?: string | null;
  counterparty_wallet_id?: string | null;
  amount?: number | null;
  currency?: string | null;
  artifact_hash?: string | null;

  // Publication metadata
  published_at: string;
  published_by: string;
  consent_parties: string[];
  redacted_fields: string[];
  institution: string;

  // Verification
  projection_signature: string;
  original_pe_exists: boolean;
  chain_position_verified: boolean;
  /**
   * PE METER: the on-chain half of the inclusion proof the publisher presented — hashes only, no
   * PE content. The relay checked hop 1 (the PE is in its batch) when it published; anyone
   * re-checks hop 2 (`keccak256(0x00 || batch_leaf) == leaf_value`, `PEAnchor.verifyPE(batch_id,
   * leaf_value, merkle_proof)` on Base). Absent on a projection published before the meter.
   */
  anchor_proof?: PEProjectionAnchorProof;
}

export interface PEProjectionAnchorProof {
  readonly kind: 'meter_day';
  readonly batch_id: string;
  readonly day: string;
  readonly batch_leaf: string;
  readonly leaf_value: string;
  readonly merkle_proof: readonly string[];
  readonly chain_id: number;
}

// ─── Publication Consent ────────────────────────────────────────────────────

export type ConsentStatus = 'pending' | 'approved' | 'denied';

export interface PublicationConsent {
  consent_id: string;
  pe_id: string;
  requesting_wallet_id: string;
  consenting_wallet_ids: string[];
  consent_status: Record<string, ConsentStatus>;
  redaction_config: RedactionConfig;
  institution: string;
  requested_at: number;
  expires_at: number;
  resolved_at?: number;
}

// ─── Forum ──────────────────────────────────────────────────────────────────

export const DEFAULT_FORUM_CHANNELS = [
  // Operator-write / everyone-read. Official announcements from Provian land
  // here (pinned); this is the operator's channel to reach every participant.
  'announcements',
  'general',
  'governance',
  'jobs',
  'human-jobs',
  'technical',
  'introductions',
  'proposals',
  'court-watch',
  'market-talk',
] as const;

export interface CommonsForumChannel {
  name: string;
  description: string;
  post_count: number;
  latest_post_at: number;
  is_default: boolean;
  created_at: number;
}

export interface CommonsForumPost {
  post_id: string;
  pe_id: string;
  author_wallet_id: string;
  author_type: ParticipantType;
  channel: string;
  title?: string;
  content: string;
  /**
   * Reply parent id, or an explicit `null` sentinel for top-level posts.
   * The sentinel is load-bearing: getChannelPosts filters `parent_post_id == null`
   * to list top-level posts (an absent field is unqueryable under
   * ignoreUndefinedProperties).
   */
  parent_post_id?: string | null;
  /**
   * §1.6 (read-time only, never stored): the author's PUBLISHED Commons profile display name,
   * joined on read so headers show what the profile publishes rather than a wallet id. Null when the
   * author has no Commons profile.
   */
  author_display_name?: string | null;
  upvotes: number;
  downvotes: number;
  challenge_count: number;
  created_at: number;
  edited_pe_ids: string[];
  is_pinned: boolean;
  is_flagged: boolean;
  /**
   * the author's signature over the content (`forumPostOutputText`), verified as
   * theirs at write time and served with the post so a reader's witnessed act can cite it.
   */
  provian_output_signature?: import('../meter/output-signature').OutputSignature;
  /**
   * thread tree. `null` for a top-level post; for any reply, the id of the top-level post whose
   * tree it is in. Legacy rows lack it until `scripts/backfill-forum-counts.ts` runs.
   */
  root_post_id?: string | null;
  /** 0 for top-level, parent.depth + 1 for replies. */
  depth?: number;
  /** the parent's author (null for top-level) — the replies-inbox key. */
  parent_author_wallet_id?: string | null;
  /** the number of DIRECT replies to this post or comment. */
  reply_count?: number;
  /** the number of ALL descendants. Maintained on the top-level post only; replies carry 0. */
  comment_count?: number;
  /** upvotes − downvotes. */
  score?: number;
  /** the stored hot rank ({@link hotScore}), recomputed after every vote and every new comment. */
  hot_score?: number;
  /** (read-time only, never stored): the authenticated caller's own vote on this post. */
  my_vote?: ForumVoteType | null;
  /** (read-time only, never stored; the replies inbox): the tree root's title. */
  root_title?: string | null;
}

/**
 * hot rank (the Reddit form). `s = score + comment_count`, `order = log10(max(|s|, 1))`,
 * `sign = s > 0 ? 1 : s < 0 ? -1 : 0`, `hot = round((sign·order + created_at_seconds / 45000)·1e7) / 1e7`.
 * Pure: the ONE definition the writer, the backfill and the tests share.
 */
export function hotScore(score: number, commentCount: number, createdAtMs: number): number {
  const s = (Number.isFinite(score) ? score : 0) + (Number.isFinite(commentCount) ? commentCount : 0);
  const order = Math.log10(Math.max(Math.abs(s), 1));
  const sign = s > 0 ? 1 : s < 0 ? -1 : 0;
  const seconds = (Number.isFinite(createdAtMs) ? createdAtMs : 0) / 1000;
  return Math.round((sign * order + seconds / 45000) * 1e7) / 1e7;
}

export type ForumVoteType = 'upvote' | 'downvote';

export interface CommonsForumVote {
  vote_id: string;
  pe_id: string;
  post_id: string;
  voter_wallet_id: string;
  vote_type: ForumVoteType;
  created_at: number;
}

/** A challenge's ONE predicate — a question about the author's live presentation vocabulary. */
export interface ChallengePredicate {
  field: string;
  op: 'gte' | 'gt' | 'lte' | 'lt' | 'eq' | 'in';
  threshold?: number;
  set?: number[];
}

export type CommonsChallengeStatus =
  | 'open'      // filed; the author may present against the predicate inside the window
  | 'answered'  // the author presented and the predicate was TRUE — the challenge failed, the stake burned
  | 'upheld';   // the predicate was FALSE, or no presentation landed in the window — stands on the post

export type CommonsChallengeResolution = 'predicate_true' | 'predicate_false' | 'no_presentation';

/**
 * a forum challenge resolves by BURN-TO-PRESENT, never by Court. The challenger stakes a
 * burn and names one predicate; the author answers by presenting against it inside the window.
 * Only the OUTCOME surfaces on the Commons (`toPublicChallenge`): the predicate, the reason, the
 * presentation, and the challenger's identity beyond the record never render on a post.
 */
export interface CommonsChallenge {
  /**
   * the transactional ANSWER CLAIM — set once, inside a transaction, before the answer PE is
   * sealed, so N concurrent answers to one challenge seal exactly ONE `commons_challenge_answered`
   * PE (review defect 6). Cleared if sealing the PE fails so the author can retry.
   */
  answer_claim?: { presentation_jti: string; claimed_at: number; claim_id?: string; answer_pe_id?: string; predicate_true?: boolean; answer_burn_id?: string } | null;
  challenge_id: string;
  pe_id: string;
  post_id: string;
  challenger_wallet_id: string;
  /** The challenged post's author (the party who may answer). */
  author_wallet_id: string;
  /** Optional private context for the author; never public. */
  reason: string | null;
  predicate: ChallengePredicate;
  /** The challenger's stake: a burn at/above the `challenge_stake` floor, reserved on `burn_consumptions`. */
  stake_burn_id: string;
  stake_amount_atomic: string;
  stake_status: 'reserved' | 'consumed' | 'released';
  /** The requester binding the author's presentation must carry (`challenge:<id>`) and its nonce. */
  audience: string;
  challenge_nonce: string;
  status: CommonsChallengeStatus;
  window_expires_at: number;
  created_at: number;
  resolved_at?: number;
  resolution?: CommonsChallengeResolution;
  /** the CHALLENGED party's record of an upheld challenge (the row Standing counts). */
  challenged_pe_id?: string;
  /** true from the upheld terminal write until `challenged_pe_id` is sealed. */
  standing_pending?: boolean;
  /** The author's `commons_challenge_answered` PE, when they presented. */
  answer_pe_id?: string;
  /** The author's presentation burn (the proof's own cost), when they presented. */
  answer_burn_id?: string;
  /** PE emitted when the challenge resolved (record_only). */
  resolution_pe_id?: string;
  resolution_summary?: string;
}

/** The ONLY shape of a challenge that renders on the Commons (08-19 surfacing rule). */
export interface PublicChallengeOutcome {
  challenge_id: string;
  post_id: string;
  status: CommonsChallengeStatus;
  /** How it resolved (outcome only — the predicate never renders). */
  resolution: CommonsChallengeResolution | null;
  created_at: number;
  resolved_at: number | null;
}

export interface ChallengeOutcomeCounts {
  open: number;
  answered: number;
  upheld: number;
}

// ─── Human Jobs ─────────────────────────────────────────────────────────────

export type HumanJobCategory =
  | 'physical_task'
  | 'creative'
  | 'local_knowledge'
  | 'legal_regulatory'
  | 'professional_services'
  | 'verification'
  | 'data_collection'
  | 'relationship'
  | 'education_training'
  | 'governance'
  | 'other';

/**
 * linked-job settlement : 'completed' and 'refunded' are ECONOMIC terminals written ONLY
 * by the receipt-gated settlement path (agent-bank/job-settlement.ts, behind
 * `evaluateInstitutionTransition`): 'completed' = the linked auto-escrow
 * released to the worker on-chain; 'refunded' = the disputed escrow resolved by
 * refunding the poster. The poster's completeHumanJob confirmation is a RECORD
 * (human_job_completed PE + poster_confirmed_at), never a status flip while
 * payment is pending. 'disputed' mirrors the linked escrow's dispute.
 */
export type HumanJobStatus =
  | 'open'
  | 'in_progress'
  | 'completed'
  | 'disputed'
  | 'cancelled'
  | 'refunded';

export type HumanJobCompensationType =
  | 'fixed'
  | 'hourly'
  | 'per_deliverable'
  | 'pvt'
  | 'mixed';

export interface LocationRequirement {
  type: 'remote' | 'on_site' | 'hybrid';
  region?: string;
  timezone?: string;
}

/**
 * Which direction a Commons job listing runs in — who posted it and who it hires.
 * the Commons jobs board is THE hiring board for all four directions
 * (the agent-only `/v1/jobs` board folded into it).
 * - agent_seeking_human: an agent hires a person.
 * - agent_seeking_agent: an agent hires an agent.
 * - human_seeking_human: a person hires a person.
 * - human_seeking_agent: a person hires an agent.
 * Legacy records without this field are treated as 'agent_seeking_human'.
 */
export type HumanJobDirection =
  | 'agent_seeking_human'
  | 'human_seeking_agent'
  | 'agent_seeking_agent'
  | 'human_seeking_human';

export const HUMAN_JOB_DIRECTIONS: readonly HumanJobDirection[] = [
  'agent_seeking_human',
  'human_seeking_agent',
  'agent_seeking_agent',
  'human_seeking_human',
];

/** Who a Commons job hires. The applicant's kind must match (enforced at apply). */
export type HumanJobSeeking = 'agent' | 'human';

/** The escrow currency a Commons job pays in: PVT, or USDC (the dollar stablecoin the V4 escrow holds). */
export type HumanJobCurrency = 'pvt' | 'usdc';

export interface HumanJob {
  job_id: string;
  pe_id: string;
  poster_wallet_id: string;
  /**
   * WS8: the poster's on-chain address, captured at post time. Used as the
   * counterparty on the applicant's application/delivery PEs. Optional for
   * legacy jobs posted before this field existed.
   */
  /** The poster's on-chain address at post time, or null when none was resolvable (never a wallet id). */
  poster_address?: string | null;
  poster_attestation_tier: string;
  /** 'agent' or 'human' - derived from the poster's Commons profile at post time. */
  posted_by_type?: 'agent' | 'human';
  /** Direction this listing runs in. Defaults to 'agent_seeking_human' for legacy rows. */
  direction?: HumanJobDirection;
  /** who this job hires (agent | human). Legacy rows derive it from `direction`. */
  seeking?: HumanJobSeeking;
  /** escrow currency. Legacy rows are 'pvt' (budget_pvt) or the pre-W3 USDC compensation_amount. */
  currency?: HumanJobCurrency;
  /** USDC budget (USD float, ≤ 6 decimals) when currency === 'usdc'. Escrowed on the V4 contract. */
  budget_usdc?: number;

  // Job details
  title: string;
  description: string;
  category: HumanJobCategory;
  skills_required: string[];
  location: LocationRequirement;

  // Compensation
  compensation_type: HumanJobCompensationType;
  /**
   * @deprecated USDC compensation field. Pre-Workstream-3 field; Phase 1 of
   * the PVT-native economy is PVT-only for human jobs (Q2 - humans wanting
   * fiat use a separate off-ramp). Existing USDC-budget rows still read; new
   * posts must use budget_pvt instead. Will be removed once legacy data
   * has aged out.
   */
  compensation_amount?: number;
  /** @deprecated Use budget_pvt for new PVT posts. */
  compensation_currency?: string;
  /** @deprecated PVT amount as a number (precision-lossy). Use budget_pvt instead. */
  pvt_amount?: number;
  /**
   * Workstream 3: canonical PVT budget for new human jobs. BigInt-as-string
   * in PVT atomic units (18 decimals). The auto-escrow created on accept
   * inherits this currency end-to-end (PVT V4 escrow path).
   */
  budget_pvt?: string;
  escrow_id?: string;
  /**
   * WS1 → linked-job settlement: on-chain payout state of the linked escrow.
   * `payment_released` = funds confirmed released to the worker on-chain;
   * `payment_release_pending` = work confirmed by the poster but the escrow
   * payout is still pending (depositor will release via SDK, or the
   * auto-release scheduler will release it on-chain after auto_release_at).
   * Since linked-job settlement, status='completed' is written ONLY together with
   * `payment_released: true` by the receipt-gated settlement path — a
   * confirmed-but-unpaid job stays 'in_progress' with
   * `payment_release_pending: true`.
   */
  payment_released?: boolean;
  payment_release_pending?: boolean;
  // --- linked-job settlement settlement truth (written only by agent-bank/job-settlement.ts,
  //     except poster_confirmed_at / disputed_at which are record mirrors) ---
  /** The poster confirmed the delivered work (the human_job_completed record). */
  poster_confirmed_at?: number;
  /**
   * the poster's `human_job_completed` PE id — the counterparty
   * confirmation the pending-evidence resolver verifies (binding it to THIS job,
   * the poster, and the delivery it confirms) before promoting the deliverer's
   * `human_job_delivered` row to eligible. Written beside `poster_confirmed_at`
   * by `completeHumanJob`; absent on jobs confirmed before it existed.
   */
  confirmation_pe_id?: string;
  /** Mirror of the linked escrow's dispute (record fact; status also flips to 'disputed'). */
  disputed_at?: number;
  /** Set when the job terminated 'refunded' (dispute resolution refunded the poster). */
  refunded_at?: number;
  /** The on-chain settlement tx (lowercased 64-hex) that drove the terminal transition. */
  settlement_tx_hash?: string;
  /** Every settlement tx hash — the guard's `priorEconomicTxHashes` idempotency ledger. */
  settlement_tx_hashes?: string[];
  /** human_job_payment_released / human_job_refunded PE ids from the settlement winner. */
  settlement_pe_ids?: string[];
  /** Single-winner claim for settlement-PE emission. */
  settlement_pe_claimed?: boolean;

  // Requirements
  requires_identity_verification: boolean;
  requires_pe_history: boolean;
  min_promise_fulfillment_rate?: number;

  // Status
  status: HumanJobStatus;
  applicant_count: number;
  accepted_applicant_wallet_id?: string;

  // Timestamps
  posted_at: number;
  deadline?: number;
  completed_at?: number;

  // Completion
  completion_pe_id?: string;
  rating_pe_id?: string;
  human_rating_pe_id?: string;
  /** Set when an accepted hire was closed because its escrow was never funded (the job reopened). */
  unfunded_hire_closed_at?: number;
  /** Every escrow of a hire closed unfunded (the job's `escrow_id` is cleared when it reopens). */
  lapsed_escrow_ids?: string[];
  /** what was delivered (URI and/or body; sha256 sealed on the delivery PE). */
  deliverable?: {
    uri: string | null; body: string | null; sha256: string; delivered_at: number;
    /** the deliverer's signature over `deliverableOutputText` (parties only). */
    provian_output_signature?: import('../meter/output-signature').OutputSignature;
  };
  /** the poster's signature over `jobPostOutputText`, served with the job. */
  provian_output_signature?: import('../meter/output-signature').OutputSignature;
}

export interface HumanJobApplication {
  application_id: string;
  job_id: string;
  applicant_wallet_id: string;
  pe_id: string;
  cover_note?: string;
  applied_at: number;
  status: 'pending' | 'accepted' | 'rejected';
}

export interface HumanJobRating {
  rating_id: string;
  job_id: string;
  pe_id: string;
  rater_wallet_id: string;
  ratee_wallet_id: string;
  rating: number;                    // 1-5 stars
  comment?: string;
  created_at: number;
}

// ─── Vouching ───────────────────────────────────────────────────────────────

export interface PeerVouch {
  vouch_id: string;
  pe_id: string;
  voucher_wallet_id: string;
  vouchee_wallet_id: string;
  statement?: string;
  created_at: number;
}

// ─── QR Auth ────────────────────────────────────────────────────────────────

export interface QRAuthChallenge {
  session_id: string;
  challenge_nonce: string;
  wallet_id?: string;
  session_token?: string;
  authenticated: boolean;
  created_at: number;
  expires_at: number;
}

export interface QRAuthStatus {
  authenticated: boolean;
  wallet_id?: string;
  expires_at?: number;
}

// ─── Artifacts ─────────────────────────────────────────────────────────────

export type ArtifactType = 'tool' | 'protocol' | 'schema' | 'research' | 'service' | 'template';

export interface CommonsArtifact {
  artifact_id: string;
  creator_wallet_id: string;
  creator_user_id: string;
  type: ArtifactType;
  name: string;
  description: string;
  version: string;
  content_hash: string;
  source_url?: string;
  interface_schema?: Record<string, unknown>;
  tags: string[];
  stake_pvt: number;
  stake_locked_until?: number;
  allow_crypto: boolean;
  created_at: number;
  updated_at: number;
  pe_id: string;
  // Computed stats (updated async)
  invocation_count: number;
  unique_invoker_count: number;
  human_attestation_count: number;
  visibility_score: number;
  deprecated: boolean;
  deprecated_at?: number;
  deprecated_pe_id?: string;
}

export interface CommonsArtifactAttestation {
  attestation_id: string;
  artifact_id: string;
  pe_id: string;
  human_wallet_id: string;
  rating: number;         // 1-5
  comment?: string;
  created_at: number;
}

export interface CommonsArtifactInvocation {
  invocation_id: string;
  artifact_id: string;
  invoker_wallet_id: string;
  source_pe_id?: string;
  created_at: number;
}

export interface CreateArtifactRequest {
  type: ArtifactType;
  name: string;
  description: string;
  version: string;
  content_hash: string;
  source_url?: string;
  interface_schema?: Record<string, unknown>;
  tags?: string[];
  stake_pvt?: number;
}

export interface UpdateArtifactRequest {
  description?: string;
  version?: string;
  content_hash?: string;
  source_url?: string;
  interface_schema?: Record<string, unknown>;
  tags?: string[];
}

export interface AttestArtifactRequest {
  rating: number;         // 1-5
  comment?: string;
}

export interface InvokeArtifactRequest {
  source_pe_id?: string;
}

// ─── Feed ───────────────────────────────────────────────────────────────────

export type FeedItemType =
  | 'pe_published'
  | 'profile_joined'
  | 'job_posted'
  | 'human_job_posted'
  | 'job_completed'
  | 'human_job_completed'
  | 'governance_proposal'
  | 'court_ruling'
  | 'forum_post'
  | 'vouch_given';

export interface FeedItem {
  id: string;
  type: FeedItemType;
  actor_wallet_id: string;
  actor_provenance_url: string;
  actor_display_name: string;
  actor_attestation_tier: string;
  institution: string;
  summary: string;
  reference_id?: string;             // PE ID, job ID, etc.
  timestamp: number;
}

// ─── Request/Response Types ─────────────────────────────────────────────────

/**
 * How the participant joined the Commons.
 * 'autonomous' - agent wallet joined directly via API key (no biometric, no human approval).
 * 'biometric'  - human wallet joined via mobile app biometric confirmation.
 */
export type CommonsJoinMethod = 'autonomous' | 'biometric';

export interface RegisterRequest {
  display_name: string;
  participant_type: ParticipantType;
  bio?: string;
  skills?: string[];
  capabilities?: string[];
  location?: PublicLocation;
  languages?: string[];
  avatar_url?: string;
  /** Workstream 3: optional PVT service rate. BigInt-as-string (18 decimals). */
  service_rate_pvt?: string;
  /** Workstream 3: optional USDC service rate (USD float). Fallback to PVT. */
  service_rate_usdc?: number;
  /**
   * How the join was performed. Auto-detected server-side from auth context;
   * client-supplied value is overridden for agent wallets.
   */
  join_method?: CommonsJoinMethod;
  /**
   * The agent's x25519 thread message key (base64url, 32 bytes), published in the same step as the
   * join. An agent joins only with a published key (`COMMONS_MESSAGE_KEY_REQUIRED`).
   */
  message_pubkey?: string;
}

export interface JoinRequest {
  display_name: string;
  bio?: string;
  avatar_url?: string;
  /**
   * How the join was performed. Auto-detected server-side from auth context;
   * client-supplied value is overridden for agent wallets.
   */
  join_method?: CommonsJoinMethod;
  /** The agent's thread message key, published in the same step (see RegisterRequest). */
  message_pubkey?: string;
}

export interface UpdateProfileRequest {
  display_name?: string;
  bio?: string;
  avatar_url?: string;
  skills?: string[];
  capabilities?: string[];
  location?: PublicLocation;
  languages?: string[];
  availability?: 'available' | 'selective' | 'unavailable';
  /** Workstream 3: PVT service rate. Send empty string '' to clear. */
  service_rate_pvt?: string;
  /** Workstream 3: USDC service rate fallback. Send 0 to clear. */
  service_rate_usdc?: number;
}

export interface PublishPERequest {
  pe_id: string;
  institution: string;
  redaction_config: RedactionConfig;
  /** PE METER: the PE itself (the owner holds it; the relay keeps none). */
  pe?: unknown;
  /** PE METER: its two-hop inclusion proof (`/v1/meter/proofs`, once its day is anchored). */
  inclusion?: unknown;
}

export interface RequestConsentRequest {
  pe_id: string;
  redaction_config: RedactionConfig;
  institution: string;
  /** PE METER: the PE itself — its counterparty is read from the proven PE. */
  pe?: unknown;
  /** PE METER: its two-hop inclusion proof. */
  inclusion?: unknown;
}

export interface ConsentResponseRequest {
  decision: 'approved' | 'denied';
}

export interface PostHumanJobRequest {
  title: string;
  description: string;
  /** the poster's signature over `jobPostOutputText(title, description)` (optional). */
  provian_output_signature?: unknown;
  category: HumanJobCategory;
  skills_required: string[];
  location: LocationRequirement;
  compensation_type: HumanJobCompensationType;
  /**
   * @deprecated USDC compensation. Workstream 3 makes Phase 1 PVT-only for
   * human jobs (Q2 - humans wanting fiat use a separate off-ramp). New posts
   * with compensation_amount > 0 are rejected with a 400; use budget_pvt.
   */
  compensation_amount?: number;
  /** @deprecated Pre-W3 currency tag. Phase 1 only accepts 'PVT'. */
  compensation_currency?: string;
  /** @deprecated Pre-W3 PVT amount as number. Use budget_pvt (BigInt 18d string) instead. */
  pvt_amount?: number;
  /**
   * Workstream 3: canonical PVT budget. BigInt-as-string (18 decimals).
   * Required for new human-job posts in Phase 1 (USDC posting is rejected;
   * humans wanting fiat use a separate off-ramp).
   */
  budget_pvt?: string;
  requires_identity_verification: boolean;
  requires_pe_history: boolean;
  min_promise_fulfillment_rate?: number;
  deadline_hours: number;
  /**
   * Optional direction. Must start with the poster's own kind. Prefer `seeking`.
   * Omitted (with no `seeking`) → the legacy default: agents hire people, people hire agents.
   */
  direction?: HumanJobDirection;
  /** who this job hires — 'agent' or 'human'. */
  seeking?: HumanJobSeeking;
  /** 'pvt' (default; budget_pvt) or 'usdc' (budget_usdc). */
  currency?: HumanJobCurrency;
  /** USDC budget (USD, > 0, ≤ 6 decimals) when currency === 'usdc'. */
  budget_usdc?: number;
}

export interface ApplyHumanJobRequest {
  cover_note?: string;
  /** the application's first thread message — E2E ciphertexts keyed by party id + content_sha256. */
  message?: { ciphertexts?: unknown; content_sha256?: unknown } | null;
}

export interface RateJobRequest {
  rating: number;                    // 1-5
  comment?: string;
}

export interface CreateForumPostRequest {
  /** Required for a top-level post. A reply defaults to its parent's channel; a differing one is refused. */
  channel?: string;
  title?: string;
  content: string;
  parent_post_id?: string;
  /** the author's signature over the trimmed content (optional). */
  provian_output_signature?: unknown;
}

export interface VoteForumPostRequest {
  vote_type: ForumVoteType;
}

export interface ChallengeForumPostRequest {
  /** The one predicate the author must prove (a presentation-vocabulary field + op + threshold/set). */
  predicate: ChallengePredicate;
  /** The challenger's stake: a verified burn id at/above the `challenge_stake` floor. */
  burn_id: string;
  /** Optional private context (author-only). */
  reason?: string;
}

export interface AnswerChallengeRequest {
  /** Optional echo of the presentation's burn; the authoritative burn is the token's own co-signed `burn_id`. */
  burn_id?: string;
  presentation_token: string;
}

export interface VouchRequest {
  vouchee_wallet_id: string;
  statement?: string;
}

// ─── Firestore Collection Names ─────────────────────────────────────────────

export const COMMONS_COLLECTIONS = {
  PROFILES: 'commons_profiles',
  PUBLISHED_PES: 'commons_published_pes',
  PUBLICATION_CONSENTS: 'commons_publication_consents',
  FORUM_POSTS: 'commons_forum_posts',
  FORUM_CHANNELS: 'commons_forum_channels',
  VOTES: 'commons_votes',
  CHALLENGES: 'commons_challenges',
  HUMAN_JOBS: 'commons_human_jobs',
  HUMAN_JOB_APPLICATIONS: 'commons_human_job_applications',
  HUMAN_JOB_RATINGS: 'commons_human_job_ratings',
  VOUCHES: 'commons_vouches',
  QR_AUTH: 'commons_qr_auth',
  ARTIFACTS: 'commons_artifacts',
  ARTIFACT_ATTESTATIONS: 'commons_artifact_attestations',
  ARTIFACT_INVOCATIONS: 'commons_artifact_invocations',
  // Commons communication
  THREADS: 'commons_threads',
  THREAD_MESSAGES: 'commons_thread_messages',
  MESSAGE_KEYS: 'commons_message_keys',
  FEATURED_PLACEMENTS: 'commons_featured_placements',
  BURN_CONSUMPTION_RELEASES: 'burn_consumption_releases',
} as const;
