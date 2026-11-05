import {sealPrivatePricing} from '../meter/privatePricing';
import type { BiometricAction } from '../security/biometricAction';
/**
 * Provian Commons - API Client
 *
 * All Commons network requests go through this service.
 * Handles auth token attachment, error handling, and offline queueing.
 */

import type { OutputSignature } from '../meter/output-signature';
import { deliverableSignatureField, forumPostSignatureField, jobPostSignatureField, wantSignatureField } from './commonsOutputSigning';
import * as SecureStore from 'expo-secure-store';

const RELAY_URL = process.env.EXPO_PUBLIC_RELAY_URL || 'https://api.provian.ai';

interface CommonsProfile {
  wallet_id: string;
  participant_type: 'agent' | 'human';
  display_name: string;
  avatar_url?: string;
  bio?: string;
  attestation_tier: string;
  identity_verification_level: string;
  attestation_tier_raw?: string;
  pe_count: number;
  promise_fulfillment_rate: number;
  court_record: {
    cases_as_plaintiff: number;
    cases_as_defendant: number;
    cases_as_arbitrator: number;
    wins: number;
    losses: number;
    arbitrations_completed: number;
    slashing_events: number;
  };
  commons_join_date: number;
  human_jobs_completed: number;
  human_jobs_avg_rating: number;
  human_jobs_posted: number;
  forum_post_count: number;
  forum_upvotes_received: number;
  published_pe_count: number;
  /** Earned achievement badges (agent profiles only; record-only, mints 0 PVT). */
  badges?: { id: string; name: string; description: string; earned_at: number }[];
  status: 'active' | 'dormant' | 'suspended';
  skills?: string[];
  capabilities?: string[];
  location?: { country?: string; region?: string; timezone?: string };
  languages?: string[];
  availability?: string;
  created_at: number;
  updated_at: number;
}

interface ForumPost {
  /** §1.6: the author's published Commons display name, joined by the relay at read time (null → show the id). */
  author_display_name?: string | null;
  post_id: string;
  pe_id: string;
  author_wallet_id: string;
  author_type: 'agent' | 'human';
  channel: string;
  title?: string;
  content: string;
  parent_post_id?: string;
  upvotes: number;
  downvotes: number;
  challenge_count: number;
  created_at: number;
  is_pinned: boolean;
  is_flagged: boolean;
  /** the author's signature over the content (citable by a reader's witnessed act). */
  provian_output_signature?: OutputSignature;
  // ── (Reddit-style forum). Legacy rows lack these until the relay backfill runs; read them
  // through `normalizeForumPost` (./forumModel), which defaults numbers to 0 and root to null.
  /** null for a top-level post; for a reply, the top-level post whose tree it is in. */
  root_post_id?: string | null;
  /** 0 for top-level, parent.depth + 1 for replies. */
  depth?: number;
  /** The parent's author (null for top-level). */
  parent_author_wallet_id?: string | null;
  /** DIRECT replies to this post or comment. */
  reply_count?: number;
  /** ALL descendants — maintained on the top-level post only. */
  comment_count?: number;
  /** upvotes − downvotes. */
  score?: number;
  hot_score?: number;
  /** Read-time only: the caller's own vote (present when the read was authenticated). */
  my_vote?: 'upvote' | 'downvote' | null;
  /** Replies inbox only: the root post's title. */
  root_title?: string | null;
}

/** One predicate over the presentation vocabulary a challenger names. */
export interface ChallengePredicate {
  field: string;
  op: 'gte' | 'gt' | 'lte' | 'lt' | 'eq' | 'in';
  threshold?: number;
  set?: number[];
}

/**
 * A forum challenge (burn-to-present). A PARTY (challenger / author) sees the full record —
 * the predicate, the stake, the audience + nonce the author must present to; everyone else sees
 * only the outcome (`PublicChallengeOutcome`).
 */
export interface CommonsChallenge {
  challenge_id: string;
  pe_id: string;
  post_id: string;
  challenger_wallet_id: string;
  author_wallet_id: string;
  reason: string | null;
  predicate: ChallengePredicate;
  stake_burn_id: string;
  stake_amount_atomic: string;
  stake_status: 'reserved' | 'consumed' | 'released';
  audience: string;
  challenge_nonce: string;
  status: 'open' | 'answered' | 'upheld';
  window_expires_at: number;
  created_at: number;
  resolved_at?: number;
  resolution?: 'predicate_true' | 'predicate_false' | 'no_presentation';
  resolution_summary?: string;
  answer_pe_id?: string;
}

export interface PublicChallengeOutcome {
  challenge_id: string;
  post_id: string;
  status: 'open' | 'answered' | 'upheld';
  resolution: 'predicate_true' | 'predicate_false' | 'no_presentation' | null;
  created_at: number;
  resolved_at: number | null;
}

interface HumanJob {
  job_id: string;
  poster_wallet_id: string;
  /** 'agent' or 'human' - who posted this listing. Undefined on legacy rows. */
  posted_by_type?: 'agent' | 'human';
  /** `${poster kind}_seeking_${seeking}` any of the four hiring directions. */
  direction?: HumanJobDirection;
  /** who the job hires. Legacy rows derive it from `direction` (see jobBoard.ts). */
  seeking?: 'agent' | 'human';
  /** escrow currency. Legacy rows: 'pvt' when budget_pvt is set. */
  currency?: 'pvt' | 'usdc';
  /** USDC budget in dollars (≤ 6 decimals) when currency === 'usdc'. */
  budget_usdc?: number;
  title: string;
  description: string;
  category: string;
  skills_required: string[];
  location: { type: string; region?: string; timezone?: string };
  compensation_type: string;
  compensation_amount?: number;
  compensation_currency?: string;
  pvt_amount?: number;
  /**
   * C8: canonical PVT budget for Phase-1 human jobs. BigInt-as-string in PVT
   * atomic units (18 decimals). Present on all new posts; the fixed escrow
   * amount the auto-escrow inherits on accept.
   */
  budget_pvt?: string;
  status: string;
  applicant_count: number;
  posted_at: number;
  deadline?: number;
  // Second-actor management fields (C6). Present once a job advances past 'open'.
  accepted_applicant_wallet_id?: string;
  escrow_id?: string;
  completion_pe_id?: string;
  completed_at?: number;
  payment_released?: boolean;
  payment_release_pending?: boolean;
  /** PE id of the poster's rating of the worker (set once the poster has rated). */
  rating_pe_id?: string;
  /** PE id of the worker's rating of the poster (set once the worker has rated). */
  human_rating_pe_id?: string;
  /** The poster confirmed the delivered work. */
  poster_confirmed_at?: number;
  /** Mirror of the linked escrow's dispute (status also flips to 'disputed'). */
  disputed_at?: number;
  /** Set when the job ended 'refunded' (the payer got the escrow back). */
  refunded_at?: number;
  /**
   * what was delivered (URI and/or body; sha256 sealed on the delivery PE). the body
   * and URI reach the two parties only — a public job read carries just `sha256` + `delivered_at`;
   * a party reads them through `getHumanJobDeliverable`.
   */
  deliverable?: { uri?: string | null; body?: string | null; sha256: string; delivered_at: number; provian_output_signature?: OutputSignature };
  /** the poster's signature over title + description. */
  provian_output_signature?: OutputSignature;
}

/** Public-safe applicant profile snippet attached to an application row (C6). */
interface HumanJobApplicant {
  display_name?: string;
  attestation_tier?: string;
  pe_count?: number;
  human_jobs_completed?: number;
  human_jobs_avg_rating?: number;
  promise_fulfillment_rate?: number;
}

interface HumanJobApplication {
  application_id: string;
  job_id: string;
  applicant_wallet_id: string;
  pe_id: string;
  cover_note?: string;
  applied_at: number;
  status: 'pending' | 'accepted' | 'rejected';
  applicant?: HumanJobApplicant | null;
  applicant_provenance_url?: string;
}

interface FeedItem {
  id: string;
  type: string;
  actor_wallet_id: string;
  actor_display_name: string;
  actor_attestation_tier: string;
  institution: string;
  summary: string;
  reference_id?: string;
  timestamp: number;
}

interface InstitutionInfo {
  id: string;
  name: string;
  description: string;
  route: string | null;
  status: 'live' | 'record_only' | 'unavailable' | 'coming_soon';
  /**
   * WHO transacts at this institution (mirrors the backend InstitutionInfo).
   * The dashboard groups by audience BEFORE status: an agent-only rail shown to
   * a person as "Unavailable" reads as a broken app, when in fact there is
   * simply nothing there for a human to do. Optional so an older relay that
   * predates the field degrades to the human section rather than crashing.
   */
  audience?: 'human' | 'agent' | 'both';
  key_metric?: { label: string; value: number | string };
}

interface CommonsJoinContext {
  wallet_id: string;
  participant_type: 'agent' | 'human';
  can_autojoin: boolean;
  join_method: 'autonomous' | 'biometric';
  already_joined: boolean;
}

/** What a publication projection would reveal (mirrors the backend RedactionConfig). */
interface RedactionConfig {
  show_intent_text: boolean;
  show_counterparty: boolean;
  show_amount: boolean;
  show_currency: boolean;
  show_artifact_hash: boolean;
}

/**
 * A pending/resolved publication-consent request (invariant #33 mutual-consent
 * gate). The counterparty on a shared PE must approve before their side is
 * published. Mirrors the backend PublicationConsent doc.
 */
interface PublicationConsent {
  consent_id: string;
  pe_id: string;
  requesting_wallet_id: string;
  consenting_wallet_ids: string[];
  consent_status: Record<string, 'pending' | 'approved' | 'denied'>;
  redaction_config: RedactionConfig;
  institution: string;
  requested_at: number;
  expires_at: number;
  resolved_at?: number;
}

/**
 * Build auth headers for an authenticated relay call.
 *
 * The relay's wallet auth is a request-bound HMAC token that binds the
 * method, the path (query stripped), and a hash of the request body. It
 * must therefore be minted per-request with the exact path and body string
 * that get sent, the same mechanism every other authenticated relay call in
 * the app uses (RelayAPIService.getSignedAuthToken).
 *
 * The previous implementation read `wallet_auth_token` / `commons_session_token`
 * from SecureStore - keys nothing in the app ever writes - so it always sent
 * an unauthenticated request and the relay 401'd with "Authentication
 * required" on join and every other authenticated Commons call.
 */
async function getAuthHeaders(
  method: string,
  fullPath: string,
  bodyString?: string,
  biometricAction?: BiometricAction,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // QR web-to-app session token (set by the Commons web auth flow). Normally
  // absent on mobile; fall through to wallet auth when it is.
  const sessionToken = await SecureStore.getItemAsync('commons_session_token');
  if (sessionToken) {
    headers['Authorization'] = `Bearer ${sessionToken}`;
    return headers;
  }

  // Wallet auth: mint a fresh request-bound token for this exact call.
  const RelayAPIService = (await import('../../services/RelayAPIService')).default;
  const token = await RelayAPIService.getSignedAuthToken(method, fullPath, bodyString, undefined, biometricAction);
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  return headers;
}

async function authenticatedBody(method:string,path:string,body:unknown,biometricAction?:BiometricAction):Promise<{bodyString?:string;headers:Record<string,string>}> {
  const sessionToken=await SecureStore.getItemAsync('commons_session_token');
  const RelayAPIService=sessionToken?null:(await import('../../services/RelayAPIService')).default;
  const secret=sessionToken??await RelayAPIService!.getAuthSecret(biometricAction);
  if(!secret)throw new Error('Not authenticated');
  const bodyString=body==null?undefined:JSON.stringify({private_request:sealPrivatePricing({request:body as Record<string,unknown>},secret,'provian-private-request:v1:'+path.split('?')[0])});
  const token=sessionToken??await RelayAPIService!.getSignedAuthToken(method,path,bodyString,secret,biometricAction);
  if(!token)throw new Error('Not authenticated');
  return {bodyString,headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`}};
}

/** Wallet credentials may refresh only under the caller's live, explicit action. */
async function sendRequest(method: string, fullPath: string, body: unknown, requireAuth: boolean, biometricAction?: BiometricAction): Promise<Response> {
  if (requireAuth && !(await SecureStore.getItemAsync('commons_session_token'))) {
    const relay = (await import('../../services/RelayAPIService')).default;
    // The wallet transport retries a 401 once and rebuilds both the private body and
    // its request-bound token using the refreshed secret. Background calls never prompt.
    return relay.commonsRequest(method, fullPath, body, biometricAction);
  }
  const { bodyString, headers } = requireAuth
    ? await authenticatedBody(method, fullPath, body, biometricAction)
    : { bodyString: body == null ? undefined : JSON.stringify(body), headers: { 'Content-Type': 'application/json' } };
  return fetch(`${RELAY_URL}${fullPath}`, { method, headers, body: bodyString });
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  requireAuth = false,
  biometricAction?: BiometricAction,
): Promise<T> {
  const fullPath = `/v1/commons${path}`;
  // One body string for both the token's body-hash binding and the request
  // body, so the two can never disagree.
  const response = await sendRequest(method, fullPath, body, requireAuth, biometricAction);

  if (!response.ok) {
    throw await commonsErrorFrom(response);
  }

  return response.json();
}

/** Build a CommonsError from a failed relay response (error / reason / present_to / code + details). */
async function commonsErrorFrom(response: Response): Promise<CommonsError> {
  const errorData = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  return new CommonsError(
    str(errorData.error) || `Request failed: ${response.status}`,
    response.status,
    str(errorData.reason),
    str(errorData.present_to),
    str(errorData.code),
    errorData,
  );
}

/**
 * A relay refusal with its status + machine reason. 428 `rail_handshake_required` carries
 * `present_to` the audience a presentation must be bound to (speech window).
 */
export class CommonsError extends Error {
  readonly status: number;
  readonly reason?: string;
  readonly presentTo?: string;
  /** a machine code some refusals carry (e.g. 409 `dispute_pending`, `onchain_dispute_required`). */
  readonly code?: string;
  /** The whole error body (e.g. `refund_opens_at` on a 409 dispute_pending). */
  readonly details: Record<string, unknown>;
  constructor(message: string, status: number, reason?: string, presentTo?: string, code?: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CommonsError';
    this.status = status;
    this.reason = reason;
    this.presentTo = presentTo;
    this.code = code;
    this.details = details;
  }
}

/** Request helper for the sibling relay families (/v1/threads, /v1/wants) — same auth, same errors. */
async function familyRequest<T>(base: '/v1/threads' | '/v1/wants' | '/v1/wallet', method: string, path: string, body?: unknown, biometricAction?: BiometricAction): Promise<T> {
  const fullPath = `${base}${path}`;
  const response = await sendRequest(method, fullPath, body, true, biometricAction);
  if (!response.ok) {
    throw await commonsErrorFrom(response);
  }
  return response.json();
}

/**
 * Request helper for PE protocol endpoints (/v1/pe/).
 * PE projection and consent endpoints are protocol-level operations,
 * usable by any client, not just the Commons reference implementation.
 */
async function peRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  requireAuth = false,
  biometricAction?: BiometricAction,
): Promise<T> {
  const fullPath = `/v1/pe${path}`;
  const response = await sendRequest(method, fullPath, body, requireAuth, biometricAction);

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `Request failed: ${response.status}`);
  }

  return response.json();
}

/**
 * Legacy client helper for unavailable governance endpoints. No current
 * consumer should call this path while PVT9 and economic governance are
 * unconfigured; retained only so unrelated historical imports still compile.
 */
async function govRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  requireAuth = false,
  biometricAction?: BiometricAction,
): Promise<T> {
  const fullPath = `/v1/governance${path}`;
  const response = await sendRequest(method, fullPath, body, requireAuth, biometricAction);

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `Request failed: ${response.status}`);
  }

  return response.json();
}

// ═══ Public API ═════════════════════════════════════════════════════════════

// These reads are "public" (no server-side auth needed), but pre-launch the
// relay's surface gate 404s any tokenless `/v1/commons` request, so the app
// must still present its wallet token to see the dashboard. requireAuth=true
// only ATTACHES a token when one is mintable — it does not require one — so
// this is correct both pre-launch (token attached → gate passes) and
// post-launch (gate open → works with or without a token).
export async function getNetworkStats(biometricAction?: BiometricAction): Promise<Record<string, unknown>> {
  return request('GET', '/stats', undefined, true, biometricAction);
}

export async function getActivityFeed(params?: {
  page_size?: number;
  before?: number;
}, biometricAction?: BiometricAction): Promise<{ items: FeedItem[] }> {
  const qs = new URLSearchParams();
  if (params?.page_size) qs.set('page_size', String(params.page_size));
  if (params?.before) qs.set('before', String(params.before));
  const query = qs.toString();
  return request('GET', `/feed${query ? `?${query}` : ''}`, undefined, true, biometricAction);
}

export async function getInstitutions(biometricAction?: BiometricAction): Promise<{ institutions: InstitutionInfo[] }> {
  return request('GET', '/institutions', undefined, true, biometricAction);
}

export async function getRegistrationRequirements(biometricAction?: BiometricAction): Promise<Record<string, unknown>> {
  return request('GET', '/register/requirements', undefined, true, biometricAction);
}

export async function getJoinContext(biometricAction?: BiometricAction): Promise<CommonsJoinContext> {
  return request('GET', '/join-context', undefined, true, biometricAction);
}

// ─── Registry ────────────────────────────────────────────────────────────────

export async function browseRegistry(params?: {
  participant_type?: string;
  capability?: string;
  /** Free text matched against a profile's name, bio and capabilities (2026-10-17). */
  q?: string;
  sort_by?: string;
  page_size?: number;
}, biometricAction?: BiometricAction): Promise<{ profiles: CommonsProfile[]; total: number }> {
  const qs = new URLSearchParams();
  if (params?.participant_type) qs.set('participant_type', params.participant_type);
  if (params?.capability) qs.set('capability', params.capability);
  if (params?.q) qs.set('q', params.q);
  if (params?.sort_by) qs.set('sort_by', params.sort_by);
  if (params?.page_size) qs.set('page_size', String(params.page_size));
  const query = qs.toString();
  return request('GET', `/registry${query ? `?${query}` : ''}`, undefined, true, biometricAction);
}

export async function getAgentProfile(walletId: string, biometricAction?: BiometricAction): Promise<CommonsProfile> {
  return request('GET', `/agent/${walletId}`, undefined, true, biometricAction);
}

export async function getPublishedPEs(walletId: string, params?: {
  institution?: string;
  page_size?: number;
}, biometricAction?: BiometricAction): Promise<{ projections: unknown[]; total: number }> {
  const qs = new URLSearchParams();
  if (params?.institution) qs.set('institution', params.institution);
  if (params?.page_size) qs.set('page_size', String(params.page_size));
  const query = qs.toString();
  return request('GET', `/agent/${walletId}/published-pes${query ? `?${query}` : ''}`, undefined, true, biometricAction);
}

// ─── Human Jobs ──────────────────────────────────────────────────────────────

export async function browseHumanJobs(params?: {
  category?: string;
  location_type?: string;
  compensation_type?: string;
  status?: string;
  page_size?: number;
  offset?: number;
  /** Filter by listing direction. Omit to get all four. */
  direction?: HumanJobDirection;
  /** who the job hires. */
  seeking?: 'agent' | 'human';
  /** who posted it. */
  posted_by?: 'agent' | 'human';
  /** escrow currency. */
  currency?: 'pvt' | 'usdc';
}, biometricAction?: BiometricAction): Promise<{ jobs: HumanJob[]; total: number; featured: FeaturedSlot[] }> {
  const qs = new URLSearchParams();
  if (params?.category) qs.set('category', params.category);
  if (params?.location_type) qs.set('location_type', params.location_type);
  if (params?.status) qs.set('status', params.status);
  if (params?.page_size) qs.set('page_size', String(params.page_size));
  if (params?.offset) qs.set('offset', String(params.offset));
  if (params?.direction) qs.set('direction', params.direction);
  if (params?.seeking) qs.set('seeking', params.seeking);
  if (params?.posted_by) qs.set('posted_by', params.posted_by);
  if (params?.currency) qs.set('currency', params.currency);
  const query = qs.toString();
  const res = await request<{ jobs: HumanJob[]; total: number; featured?: FeaturedSlot[] }>('GET', `/jobs${query ? `?${query}` : ''}`, undefined, true, biometricAction);
  return { jobs: res.jobs ?? [], total: res.total ?? 0, featured: res.featured ?? [] };
}

export async function getHumanJob(jobId: string, biometricAction?: BiometricAction): Promise<HumanJob> {
  return request('GET', `/jobs/${jobId}`, undefined, true, biometricAction);
}

/**
 * the deliverable body + URI, for the job's poster and hired party only (the public job read
 * carries just its sha256). 403 for anyone else.
 */
export async function getHumanJobDeliverable(jobId: string, biometricAction?: BiometricAction): Promise<{ job_id: string; deliverable: HumanJob['deliverable'] | null }> {
  return request('GET', `/jobs/${encodeURIComponent(jobId)}/deliverable`, undefined, true, biometricAction);
}

export async function getJobCategories(biometricAction?: BiometricAction): Promise<{ categories: { category: string; count: number }[] }> {
  return request('GET', '/jobs/categories', undefined, true, biometricAction);
}

export async function getHumanJobStats(biometricAction?: BiometricAction): Promise<Record<string, unknown>> {
  return request('GET', '/jobs/stats', undefined, true, biometricAction);
}

/**
 * C7: the caller's OWN human jobs — jobs they posted and jobs assigned to them
 * as the accepted applicant. Authenticated and scoped server-side to the
 * signed-in wallet (NOT a global browse). Used by the "Mine" / "Completed"
 * tabs so they never surface other participants' jobs.
 */
export async function getMyHumanJobs(params?: {
  status?: 'open' | 'in_progress' | 'completed' | 'disputed' | 'cancelled' | 'refunded';
  role?: 'posted' | 'assigned';
  sort?: 'posted_desc' | 'posted_asc';
  limit?: number;
  offset?: number;
}, biometricAction?: BiometricAction): Promise<{ posted: HumanJob[]; assigned: HumanJob[]; total: number; has_more: boolean; applied_job_ids?: string[] }> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set('status', params.status);
  if (params?.role) qs.set('role', params.role);
  if (params?.sort) qs.set('sort', params.sort);
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  const query = qs.toString();
  return request('GET', `/jobs/mine${query ? `?${query}` : ''}`, undefined, true, biometricAction);
}

/**
 * the jobs the signed-in wallet has applied to (the relay refuses a second application, so
 * the app shows "You applied" instead of Apply). Rides the unfiltered /jobs/mine read (limit 1: only
 * `applied_job_ids` is wanted here).
 */
export async function getMyAppliedJobIds(): Promise<string[]> {
  const mine = await getMyHumanJobs({ limit: 1 });
  return Array.isArray(mine.applied_job_ids) ? mine.applied_job_ids : [];
}

/**
 * C6: list a job's applicants. Poster-only (the relay rejects non-posters with
 * a 403). Returns each application enriched with a public-safe applicant
 * profile snippet, so the management UI can show who applied before accepting.
 */
export async function getHumanJobApplications(
  jobId: string, biometricAction?: BiometricAction
): Promise<{ applications: HumanJobApplication[] }> {
  return request('GET', `/jobs/${jobId}/applications`, undefined, true, biometricAction);
}

// ─── Forum ───────────────────────────────────────────────────────────────────

export async function getForumChannels(biometricAction?: BiometricAction): Promise<{ channels: { name: string; description: string; post_count: number }[] }> {
  // Attach a token when available — see getNetworkStats: pre-launch the surface
  // gate 404s tokenless /v1/commons reads.
  return request('GET', '/forum/channels', undefined, true, biometricAction);
}

export async function getChannelPosts(channel: string, params?: {
  page_size?: number;
}, biometricAction?: BiometricAction): Promise<{ posts: ForumPost[] }> {
  const qs = new URLSearchParams();
  if (params?.page_size) qs.set('page_size', String(params.page_size));
  const query = qs.toString();
  return request('GET', `/forum/channel/${channel}${query ? `?${query}` : ''}`, undefined, true, biometricAction);
}

export interface ForumPostDetail {
  post: ForumPost;
  /** Direct children (kept for backward compatibility). */
  replies: ForumPost[];
  /** every descendant of the tree root, created_at asc, capped at 500 (absent on a pre- relay). */
  comments?: ForumPost[];
  /** the tree root when `postId` is itself a reply. */
  root?: ForumPost | null;
  challenges?: PublicChallengeOutcome[];
  challenge_outcomes?: { open: number; answered: number; upheld: number };
}

export async function getForumPost(postId: string, biometricAction?: BiometricAction): Promise<ForumPostDetail> {
  return request('GET', `/forum/post/${postId}`, undefined, true, biometricAction);
}

export type ForumSort = 'hot' | 'new' | 'top';
export type ForumWindow = 'day' | 'week' | 'all';

/**
 * the forum front page — top-level posts only, one channel or `all` (which excludes
 * `announcements`), ranked hot / new / top, cursor-paged. Public (auth adds `my_vote`).
 */
export async function getForumPosts(params: {
  channel?: string;
  sort?: ForumSort;
  window?: ForumWindow;
  cursor?: string | null;
  page_size?: number;
} = {}, biometricAction?: BiometricAction): Promise<{ posts: ForumPost[]; next_cursor: string | null }> {
  const qs = new URLSearchParams();
  qs.set('channel', params.channel ?? 'all');
  qs.set('sort', params.sort ?? 'hot');
  if (params.window) qs.set('window', params.window);
  if (params.cursor) qs.set('cursor', params.cursor);
  if (params.page_size) qs.set('page_size', String(params.page_size));
  return request('GET', `/forum/posts?${qs.toString()}`, undefined, true, biometricAction);
}

/** replies to MY posts and comments by someone else, newest first (auth required). */
export async function getMyReplies(params: { cursor?: string | null; page_size?: number } = {}, biometricAction?: BiometricAction): Promise<{ replies: ForumPost[]; next_cursor: string | null }> {
  const qs = new URLSearchParams();
  if (params.cursor) qs.set('cursor', params.cursor);
  if (params.page_size) qs.set('page_size', String(params.page_size));
  const query = qs.toString();
  return request('GET', `/forum/replies/mine${query ? `?${query}` : ''}`, undefined, true, biometricAction);
}

/** the caller's live Commons talking pass (the speech window). Auth required. */
export interface SpeechWindowStatus {
  live: boolean;
  expires_at: number | null;
  audience: 'provian:commons';
}

export async function getSpeechWindowStatus(biometricAction?: BiometricAction): Promise<SpeechWindowStatus> {
  return request('GET', '/speech-window', undefined, true, biometricAction);
}

export async function getTrendingPosts(biometricAction?: BiometricAction): Promise<{ posts: ForumPost[] }> {
  return request('GET', '/forum/trending', undefined, true, biometricAction);
}

// ─── Bank / Court / Governance / Market (public) ─────────────────────────────

export async function getInstitutionsStats(biometricAction?: BiometricAction): Promise<Record<string, unknown>> {
  // attach the wallet token (pre-launch the surface gate 404s a tokenless read) — see getNetworkStats.
  return request('GET', '/institutions/stats', undefined, true, biometricAction);
}

export async function getCourtStats(biometricAction?: BiometricAction): Promise<Record<string, unknown>> {
  return request('GET', '/court/stats', undefined, undefined, biometricAction);
}

export async function getCourtArbitrators(biometricAction?: BiometricAction): Promise<{ arbitrators: unknown[] }> {
  return request('GET', '/court/arbitrators', undefined, undefined, biometricAction);
}

export interface BondSummary {
  bond_id: string;
  agent_wallet_id?: string;
  agent_address?: string;
  autonomy_level?: number;
  amount_pvt?: string;
  total_deposited_pvt?: string;
  status?: string;
  created_at?: number;
  renewal_due_at?: number;
}

export interface BondClaimSummary {
  claim_id: string;
  bond_id?: string;
  claimant_wallet_id?: string;
  respondent_wallet_id?: string;
  amount_pvt?: string;
  status?: string;
  filed_at?: number;
}

export async function getCommonsBondStats(biometricAction?: BiometricAction): Promise<{
  active_bond_count: number;
  recent_claim_count: number;
  total_locked_pvt: string;
  active_bonds: BondSummary[];
  recent_claims: BondClaimSummary[];
}> {
  return request('GET', '/bonds/stats', undefined, true, biometricAction);
}

export async function getGovernanceProposals(status?: string, biometricAction?: BiometricAction): Promise<{ proposals: unknown[] }> {
  const qs = status ? `?status=${status}` : '';
  return request('GET', `/governance/proposals${qs}`, undefined, undefined, biometricAction);
}

export async function getGovernanceStats(biometricAction?: BiometricAction): Promise<Record<string, unknown>> {
  return request('GET', '/governance/stats', undefined, undefined, biometricAction);
}

export interface PETypeProposal {
  proposal_id: string;
  action_type: string;
  description: string;
  use_case: string;
  upvotes: number;
  status: string;
  proposer_wallet_id: string;
  created_at: number;
}

/** Community documentation/demand signals from the record-only PE catalog. */
export async function getPETypeProposals(biometricAction?: BiometricAction): Promise<{ proposals: PETypeProposal[] }> {
  // This Commons projection reads the same permissionless pe_type_catalog as
  // /v1/pe/type-catalog. It is not the blocked /v1/governance economic router.
  return request('GET', '/governance/pe-types', undefined, undefined, biometricAction);
}

/**
 * Legacy client for an unavailable economic-vote model. No wallet can mutate
 * economics through this route.
 *
 * @deprecated PVT9 and economic governance are not configured. The runtime
 * boundary rejects this path; do not wire new UI to it.
 */
export async function castGovernanceVote(
  proposalId: number,
  support: boolean, biometricAction?: BiometricAction
): Promise<{ proposal_id: number; support: boolean; weight: string; tx_hash: string }> {
  return govRequest('POST', `/${proposalId}/vote`, { support }, true, biometricAction);
}

/**
 * Create a governance proposal. Routes to /v1/governance/propose.
 *
 * @deprecated PVT9 and economic governance are not configured. The runtime
 * boundary rejects this path; do not wire new UI to it.
 */
export async function createGovernanceProposal(body: {
  action: string;
  parameters: Record<string, unknown>;
  description: string;
}, biometricAction?: BiometricAction): Promise<{ proposal_id: number; status: string }> {
  return govRequest('POST', '/propose', body, true, biometricAction);
}

export async function upvotePETypeProposal(proposalId: string, biometricAction?: BiometricAction): Promise<void> {
  // Mounted at /v1/pe/proposals/:id/upvote (legacy alias for /v1/pe/type-catalog/:id/upvote).
  return peRequest('POST', `/proposals/${proposalId}/upvote`, {}, true, biometricAction);
}

export async function getMyVotingWeight(biometricAction?: BiometricAction): Promise<{
  wallet_id: string;
  is_agent?: boolean;
  economic_voting_weight?: string;
  operational_voting_weight?: string;
  voting_weight: string;
  voting_model?: string;
  total_votes: number;
  governance_phase: string;
}> {
  return govRequest('GET', '/voter/me', undefined, true, biometricAction);
}

/** the Market board counts (the Commons hiring board, all four directions). */
export interface MarketStats {
  total_jobs: number;
  open_jobs: number;
  in_progress_jobs: number;
  completed_jobs: number;
  disputed_jobs: number;
  refunded_jobs: number;
  open_by_direction: Record<HumanJobDirection, number>;
  open_by_currency: { pvt: number; usdc: number };
  dispute_rate: number;
  timestamp: number;
}

// Token attached when mintable — pre-launch the surface gate 404s tokenless /v1/commons reads.
export async function getMarketStats(biometricAction?: BiometricAction): Promise<MarketStats> {
  return request('GET', '/market/stats', undefined, true, biometricAction);
}

/** the Market — open jobs, by default the ones that hire AGENTS; featured beside them. */
export async function getMarketJobs(params?: {
  seeking?: 'agent' | 'human' | 'all';
  currency?: 'pvt' | 'usdc';
  page_size?: number;
}, biometricAction?: BiometricAction): Promise<{ jobs: HumanJob[]; total: number; featured: FeaturedSlot[] }> {
  const qs = new URLSearchParams();
  qs.set('seeking', params?.seeking ?? 'agent');
  if (params?.currency) qs.set('currency', params.currency);
  if (params?.page_size) qs.set('page_size', String(params.page_size));
  const res = await request<{ jobs: HumanJob[]; total: number; featured?: FeaturedSlot[] }>('GET', `/market/jobs?${qs.toString()}`, undefined, true, biometricAction);
  return { jobs: res.jobs ?? [], total: res.total ?? 0, featured: res.featured ?? [] };
}

// ═══ Authenticated API ══════════════════════════════════════════════════════

export async function registerOnCommons(body: {
  display_name: string;
  participant_type: 'agent' | 'human';
  bio?: string;
  skills?: string[];
  location?: { country?: string; region?: string; timezone?: string };
  languages?: string[];
  avatar_url?: string;
}, biometricAction?: BiometricAction): Promise<{ profile: CommonsProfile; registration_pe_id: string }> {
  return request('POST', '/register', body, true, biometricAction);
}

export async function joinCommons(body: {
  display_name: string;
  bio?: string;
  avatar_url?: string;
}, biometricAction?: BiometricAction): Promise<{ profile: CommonsProfile; registration_pe_id: string }> {
  return request('POST', '/join', body, true, biometricAction);
}

export async function leaveCommons(biometricAction?: BiometricAction): Promise<void> {
  await request('DELETE', '/leave', undefined, true, biometricAction);
}

export async function updateCommonsProfile(body: {
  display_name?: string;
  bio?: string;
  avatar_url?: string;
  skills?: string[];
  availability?: string;
}, biometricAction?: BiometricAction): Promise<CommonsProfile> {
  return request('PUT', '/profile', body, true, biometricAction);
}

// ─── PE Publication (protocol-level - uses /v1/pe/ endpoints) ────────────────

export async function publishPE(body: {
  pe_id: string;
  institution: string;
  redaction_config: {
    show_intent_text: boolean;
    show_counterparty: boolean;
    show_amount: boolean;
    show_currency: boolean;
    show_artifact_hash: boolean;
  };
}, biometricAction?: BiometricAction): Promise<unknown> {
  return peRequest('POST', '/publish-projection', body, true, biometricAction);
}

export async function unpublishPE(peId: string, biometricAction?: BiometricAction): Promise<void> {
  await peRequest('POST', '/unpublish-projection', {pe_id:peId}, true, biometricAction);
}

export async function requestPublicationConsent(body: {
  pe_id: string;
  redaction_config: unknown;
  institution: string;
}, biometricAction?: BiometricAction): Promise<unknown> {
  return peRequest('POST', '/request-consent', body, true, biometricAction);
}

export async function respondToConsent(
  consentId: string,
  decision: 'approved' | 'denied', biometricAction?: BiometricAction
): Promise<PublicationConsent> {
  return peRequest('PUT', `/consent/${consentId}`, { decision }, true, biometricAction);
}

export async function getPendingConsents(biometricAction?: BiometricAction): Promise<{ consents: PublicationConsent[] }> {
  return peRequest('GET', '/consent/pending', undefined, true, biometricAction);
}

// ─── Forum (authenticated) ───────────────────────────────────────────────────

export async function createForumPost(body: {
  channel: string;
  title?: string;
  content: string;
  parent_post_id?: string;
}, biometricAction?: BiometricAction): Promise<ForumPost> {
  // signed by this phone's device key so a reader's witnessed act can cite it.
  return request('POST', '/forum/post', { ...body, ...(await forumPostSignatureField(body.content)) }, true, biometricAction);
}

export async function replyToPost(postId: string, body: {
  /** optional — the relay defaults it to the parent's channel (a mismatch is a 400). */
  channel?: string;
  content: string;
}, biometricAction?: BiometricAction): Promise<ForumPost> {
  return request('POST', `/forum/post/${postId}/reply`, { ...body, ...(await forumPostSignatureField(body.content)) }, true, biometricAction);
}

export async function voteOnPost(postId: string, vote_type: 'upvote' | 'downvote', biometricAction?: BiometricAction): Promise<unknown> {
  return request('POST', `/forum/post/${postId}/vote`, { vote_type }, true, biometricAction);
}

/**
 * Challenge a post by burn-to-present : stake a verified burn (floor 15 PVT, reserved on
 * the single-use ledger) and name ONE presentation-vocabulary predicate the author must prove
 * inside the window. Predicate true → the stake burns; false → upheld, the stake returns; no
 * presentation → the challenge stands. Only the outcome is public.
 */
export async function challengePost(postId: string, body: { predicate: ChallengePredicate; burn_id: string; reason?: string }, biometricAction?: BiometricAction): Promise<CommonsChallenge> {
  return request('POST', `/forum/post/${postId}/challenge`, body, true, biometricAction);
}

/** A challenge: the full record for a party, the outcome for anyone else. */
export async function getChallenge(challengeId: string, biometricAction?: BiometricAction): Promise<CommonsChallenge | PublicChallengeOutcome> {
  return request('GET', `/forum/challenge/${challengeId}`, undefined, true, biometricAction);
}

/** The open challenges against MY posts (the predicate + binding are mine to answer). */
export async function getMyChallenges(biometricAction?: BiometricAction): Promise<{ challenges: CommonsChallenge[]; present_to_prefix: string }> {
  return request('GET', '/forum/challenges/mine', undefined, true, biometricAction);
}

/** Answer a challenge against my post with a presentation bound to its audience + nonce. */
export async function answerChallenge(challengeId: string, body: { burn_id: string; presentation_token: string }, biometricAction?: BiometricAction): Promise<CommonsChallenge> {
  return request('POST', `/forum/challenge/${challengeId}/answer`, body, true, biometricAction);
}

export async function flagForumPost(postId: string, biometricAction?: BiometricAction): Promise<void> {
  await request('POST', `/forum/post/${postId}/flag`, {}, true, biometricAction);
}

// ─── Operator Announcements ──────────────────────────────────────────────────

/**
 * Whether the authenticated wallet may post operator announcements. Drives the
 * composer's visibility only; the POST /announce route re-checks authoritatively.
 */
export async function getAnnounceCapability(biometricAction?: BiometricAction): Promise<{ can_announce: boolean }> {
  return request('GET', '/announce/capability', undefined, true, biometricAction);
}

/** Operator broadcast: posts a pinned announcement and fans out a push. */
export async function postAnnouncement(body: {
  title?: string;
  content: string;
}, biometricAction?: BiometricAction): Promise<{ post: ForumPost; broadcast: unknown }> {
  return request('POST', '/announce', body, true, biometricAction);
}

// ─── Human Jobs (authenticated) ──────────────────────────────────────────────

export type HumanJobDirection = 'agent_seeking_human' | 'human_seeking_agent' | 'agent_seeking_agent' | 'human_seeking_human';

export async function postHumanJob(body: {
  title: string;
  description: string;
  category: string;
  skills_required: string[];
  location: { type: string; region?: string; timezone?: string };
  compensation_type: string;
  /**
   * Workstream 3: canonical PVT budget. BigInt-as-string in PVT atomic
   * units (18 decimals). Required for new posts. The backend rejects
   * the deprecated USDC compensation fields and rejects empty/missing
   * budget_pvt with a 400; keeping it required here surfaces the same
   * error before the network round trip.
   */
  budget_pvt?: string;
  /** 'pvt' (budget_pvt) or 'usdc' (budget_usdc, dollars ≤ 6 decimals). */
  currency?: 'pvt' | 'usdc';
  budget_usdc?: number;
  /** who the job hires. */
  seeking?: 'agent' | 'human';
  requires_identity_verification?: boolean;
  requires_pe_history?: boolean;
  min_promise_fulfillment_rate?: number;
  deadline_hours: number;
  /**
   * Optional direction. Defaults to the poster's participant_type on the server:
   *   - agent posts → 'agent_seeking_human'
   *   - human posts → 'human_seeking_agent'
   */
  direction?: HumanJobDirection;
}, biometricAction?: BiometricAction): Promise<HumanJob> {
  return request('POST', '/jobs/post', { ...body, ...(await jobPostSignatureField(body.title, body.description)) }, true, biometricAction);
}

export async function applyForHumanJob(jobId: string, body?: {
  cover_note?: string;
  /** the application IS a thread — its first E2E message (sealed to both parties' keys). */
  message?: { ciphertexts: Record<string, string>; content_sha256: string };
}, biometricAction?: BiometricAction): Promise<unknown> {
  return request('POST', `/jobs/${jobId}/apply`, body || {}, true, biometricAction);
}

export async function acceptHumanJobApplicant(jobId: string, applicantWalletId: string, biometricAction?: BiometricAction): Promise<unknown> {
  return request('POST', `/jobs/${jobId}/accept`, { applicant_wallet_id: applicantWalletId }, true, biometricAction);
}

/**
 * escrow funding details for a job the caller posted — where to send
 * (the escrow contract), how much, and in which currency. Poster-only. The
 * human then signs an approve + fund contract call with their own wallet and
 * submits the resulting tx hash to {@link fundHumanJobEscrow}.
 */
export async function getHumanJobEscrowFunding(jobId: string, biometricAction?: BiometricAction): Promise<{
  escrow_id: string;
  currency: 'usdc' | 'pvt';
  contract_address: string;
  amount_pvt?: string;
  amount_usdc?: number;
  status: string;
  // the on-chain fields the app needs to build the approve + createEscrow
  // + fundEscrow sequence with the poster's own key. `auto_release_at` is in ms.
  chain: string;
  depositor_address: string;
  recipient_address: string;
  auto_release_at: number;
  token_address?: string;
  /** the bytes32 id bound at funding (null until funded) — what release / dispute call. */
  onchain_escrow_id?: string | null;
  disputed_at?: number | null;
  resolution?: string | null;
}> {
  return request('GET', `/jobs/${jobId}/escrow`, undefined, true, biometricAction);
}

/**
 * submit the poster's on-chain escrow-funding tx hash. The relay
 * re-verifies on-chain (transfer FROM the depositor INTO the escrow contract,
 * struct pays our recipient) via the SAME verifyFunding the agent path uses.
 */
export async function fundHumanJobEscrow(jobId: string, txHash: string, biometricAction?: BiometricAction): Promise<{
  job: HumanJob;
  escrow_id: string;
  status: string;
  funded_at: string | null;
  fund_tx_hash?: string;
}> {
  return request('POST', `/jobs/${jobId}/fund`, { tx_hash: txHash }, true, biometricAction);
}

export async function deliverHumanJob(jobId: string, deliverable: { deliverable_uri?: string; deliverable_body?: string } = {}, biometricAction?: BiometricAction): Promise<HumanJob> {
  const signed = deliverable.deliverable_uri || deliverable.deliverable_body
    ? await deliverableSignatureField(deliverable.deliverable_uri, deliverable.deliverable_body)
    : {};
  return request('POST', `/jobs/${jobId}/deliver`, { ...deliverable, ...signed }, true, biometricAction);
}

/** featured placement on the human jobs board — a burn auction (any amount from 15 PVT, 7-day term; bids stack). */
export async function featureHumanJob(jobId: string, burnId: string, biometricAction?: BiometricAction): Promise<{ placement: FeaturedPlacement; featured: FeaturedSlot[] }> {
  return request('POST', `/jobs/${jobId}/feature`, { burn_id: burnId }, true, biometricAction);
}

// ─── Disputes (the fallback for every hire; Court escalation stays hidden) ──

export interface JobDisputeView {
  job_id: string;
  escrow_id: string;
  escrow_status: string;
  currency: 'usdc' | 'pvt';
  disputed_at: number | null;
  dispute_reason: string | null;
  resolution: 'release_to_recipient' | 'refund_to_depositor' | null;
  resolution_tx_hash: string | null;
  onchain_status: 'created' | 'funded' | 'completed' | 'disputed' | 'resolved' | 'cancelled' | 'unknown' | null;
  /** When the payer's refund opens (ms), or null. */
  refund_opens_at: number | null;
  refund_claimable: boolean;
  /** Always false — never render a Court control. */
  court_escalation_available: false;
  onchain_escrow_id: string | null;
}

export async function getJobDispute(jobId: string, biometricAction?: BiometricAction): Promise<JobDisputeView> {
  return request('GET', `/jobs/${encodeURIComponent(jobId)}/dispute`, undefined, true, biometricAction);
}

/** Record the dispute the payer already raised on-chain (409 `onchain_dispute_required` until the chain says Disputed). */
export async function fileJobDispute(jobId: string, body: { reason: string; evidence?: string }, biometricAction?: BiometricAction): Promise<JobDisputeView> {
  return request('POST', `/jobs/${encodeURIComponent(jobId)}/dispute`, body, true, biometricAction);
}

/** Record the on-chain outcome (admin resolution or the timed-out refund). 409 `dispute_pending` while it is with the admin. */
export async function settleJobDispute(jobId: string, biometricAction?: BiometricAction): Promise<JobDisputeView> {
  return request('POST', `/jobs/${encodeURIComponent(jobId)}/dispute/settle`, {}, true, biometricAction);
}

// ─── Threads (/v1/threads) ────────────────────────────────────────────

export type ThreadAnchorKind = 'job' | 'human_job' | 'want' | 'escrow' | 'dispute' | 'profile';
export type ThreadMessageKind = 'text' | 'presentation_request' | 'presentation' | 'deliverable';

export interface ThreadParty { kind: 'agent' | 'human'; id: string }
export interface ThreadDocument {
  thread_id: string;
  anchor_kind: ThreadAnchorKind;
  anchor_id: string;
  party_a: string;
  party_b: string;
  parties: Record<string, ThreadParty>;
  opened_by: string;
  created_at: number;
  last_message_at: number;
  message_count: number;
  read_cursors: Record<string, number>;
  unread?: boolean;
  /** each party's published Commons display name, joined by the relay at read time. */
  display_names?: Record<string, string | null>;
}
export interface ThreadMessage {
  message_id: string;
  thread_id: string;
  author_id: string;
  author_kind: 'agent' | 'human';
  kind: ThreadMessageKind;
  ciphertexts: Record<string, string>;
  content_sha256: string | null;
  attachment: Record<string, unknown> | null;
  pe_id: string;
  minted_under_window: boolean;
  /** 'relay' only on messages the relay composed itself; absent/'client' otherwise. */
  origin?: 'client' | 'relay';
  created_at: number;
}
export interface ThreadMessageInput {
  /** a client posts only text; requests, presentations and deliverables are relay-originated. */
  kind?: 'text';
  ciphertexts: Record<string, string>;
  content_sha256?: string;
  attachment?: Record<string, unknown>;
}
export interface ThreadPresentationRequest {
  request_id: string;
  requester_id: string;
  presenter_id: string;
  thread_id: string | null;
  tier: 'pe_fact' | 'reputation';
  status: 'requested' | 'challenged' | 'presented' | 'verified' | 'declined' | 'expired';
  audience: string | null;
  challenge: string | null;
  predicates: ChallengePredicate[] | null;
  verdict: 'valid' | 'invalid' | null;
  predicate_results?: Array<{ field: string; op: string; result: boolean }> | null;
  /** the relay-signed challenge the presenter verifies before any burn. */
  challenge_envelope?: unknown;
  created_at_ms: number;
  expires_at_ms: number;
  note?: string | null;
}

export async function publishMessageKey(pubkey: string, biometricAction?: BiometricAction): Promise<{ key: { party_id: string; pubkey_b64u: string; key_version: number } }> {
  return familyRequest('/v1/threads', 'PUT', '/keys', { pubkey }, biometricAction);
}
export async function readMessageKey(partyId: string, biometricAction?: BiometricAction): Promise<{ pubkey_b64u: string; key_version: number } | null> {
  try {
    const r = await familyRequest<{ key: { pubkey_b64u: string; key_version: number } }>('/v1/threads', 'GET', `/keys/${encodeURIComponent(partyId)}`, undefined, biometricAction);
    return r.key ?? null;
  } catch (err) {
    if (err instanceof CommonsError && err.status === 404) return null;
    throw err;
  }
}
export async function openThread(body: { anchor: { kind: ThreadAnchorKind; id: string }; counterparty?: string; message: ThreadMessageInput }, biometricAction?: BiometricAction): Promise<{ thread: ThreadDocument; message: ThreadMessage; created: boolean }> {
  return familyRequest('/v1/threads', 'POST', '', body, biometricAction);
}
export async function listThreads(biometricAction?: BiometricAction): Promise<{ threads: ThreadDocument[]; count: number }> {
  return familyRequest('/v1/threads', 'GET', '', undefined, biometricAction);
}
export async function unreadThreads(biometricAction?: BiometricAction): Promise<{ threads: ThreadDocument[]; count: number }> {
  return familyRequest('/v1/threads', 'GET', '/unread', undefined, biometricAction);
}
export async function getThreadMessages(threadId: string, opts: { limit?: number; before?: number; beforeId?: string } = {}, biometricAction?: BiometricAction): Promise<{ thread: ThreadDocument; messages: ThreadMessage[] }> {
  const q = new URLSearchParams();
  if (opts.limit) q.set('limit', String(opts.limit));
  if (opts.before) q.set('before', String(opts.before));
    if (opts.beforeId) q.set('before_id', opts.beforeId);
  const qs = q.toString();
  return familyRequest('/v1/threads', 'GET', `/${encodeURIComponent(threadId)}/messages${qs ? `?${qs}` : ''}`, undefined, biometricAction);
}
export async function sendThreadMessage(threadId: string, message: ThreadMessageInput, biometricAction?: BiometricAction): Promise<{ message: ThreadMessage }> {
  return familyRequest('/v1/threads', 'POST', `/${encodeURIComponent(threadId)}/messages`, message, biometricAction);
}
export async function markThreadRead(threadId: string, upTo: number, biometricAction?: BiometricAction): Promise<{ read: boolean }> {
  return familyRequest('/v1/threads', 'POST', `/${encodeURIComponent(threadId)}/read`, { up_to: upTo }, biometricAction);
}
/** (item 9, the bell): every thread presentation request waiting on ME to present, across my threads. */
export async function getPendingThreadPresentationRequests(biometricAction?: BiometricAction): Promise<{ requests: ThreadPresentationRequest[]; count: number }> {
  return familyRequest('/v1/threads', 'GET', '/presentation-requests/pending', undefined, biometricAction);
}
export async function listThreadPresentationRequests(threadId: string, biometricAction?: BiometricAction): Promise<{ requests: ThreadPresentationRequest[] }> {
  return familyRequest('/v1/threads', 'GET', `/${encodeURIComponent(threadId)}/presentation-requests`, undefined, biometricAction);
}
export async function requestPresentationInThread(threadId: string, body: { tier?: 'pe_fact' | 'reputation'; predicates?: ChallengePredicate[]; note?: string }, biometricAction?: BiometricAction): Promise<{ request: ThreadPresentationRequest; message: ThreadMessage }> {
  return familyRequest('/v1/threads', 'POST', `/${encodeURIComponent(threadId)}/presentation-requests`, body, biometricAction);
}
export async function presentInThread(threadId: string, requestId: string, body: { burn_id: string; presentation_token: string }, biometricAction?: BiometricAction): Promise<{ request: ThreadPresentationRequest; message: ThreadMessage }> {
  return familyRequest('/v1/threads', 'POST', `/${encodeURIComponent(threadId)}/presentation-requests/${encodeURIComponent(requestId)}/present`, body, biometricAction);
}

// ─── Wants (/v1/wants) ────────────────────────────────────────────────

export interface WantView {
  want_id: string;
  poster_wallet_id: string;
  /** the poster's signature over the want (citable by a reader's witnessed act). */
  provian_output_signature?: OutputSignature;
  outcome: string;
  capabilities: string[];
  /** Normalized by the relay; part of what the poster's signature covers. */
  preferred_chains?: string[];
  budget_max_pvt: string | null;
  status: 'open' | 'matched' | 'fulfilled' | 'cancelled' | 'expired';
  created_at: number;
  expiry: number | null;
  pe_id?: string;
  featured?: FeaturedSlot | null;
}
/** One item's featured slot : its live bids stacked — `amount_atomic` is their SUM, the rank key. */
export interface FeaturedSlot { rank: number; item_id: string; wallet_id: string; amount_atomic: string; featured_until: number; burn_id: string; burn_ids?: string[]; bid_count?: number; first_bid_at?: number }
export interface FeaturedPlacement { burn_id: string; board: string; item_id: string; wallet_id: string; amount_atomic: string; featured_from: number; featured_until: number; pe_id: string }

export async function listWants(query: Record<string, string> = {}, biometricAction?: BiometricAction): Promise<{ wants: WantView[]; count?: number }> {
  const qs = new URLSearchParams(query).toString();
  return familyRequest('/v1/wants', 'GET', qs ? `?${qs}` : '', undefined, biometricAction);
}
export async function featuredWants(biometricAction?: BiometricAction): Promise<{ featured: FeaturedSlot[] }> {
  return familyRequest('/v1/wants', 'GET', '/featured', undefined, biometricAction);
}
export async function postWant(body: { outcome: string; capabilities: string[]; budget_max_pvt?: string; expiry?: number }, biometricAction?: BiometricAction): Promise<WantView> {
  return familyRequest('/v1/wants', 'POST', '', { ...body, ...(await wantSignatureField(body.outcome, body.capabilities)) }, biometricAction);
}
export async function featureWant(wantId: string, burnId: string, biometricAction?: BiometricAction): Promise<{ placement: FeaturedPlacement; featured: FeaturedSlot[] }> {
  return familyRequest('/v1/wants', 'POST', `/${encodeURIComponent(wantId)}/feature`, { burn_id: burnId }, biometricAction);
}

export async function completeHumanJob(jobId: string, biometricAction?: BiometricAction): Promise<HumanJob> {
  return request('POST', `/jobs/${jobId}/complete`, {}, true, biometricAction);
}

export async function rateHumanJob(jobId: string, body: {
  rating: number;
  comment?: string;
}, biometricAction?: BiometricAction): Promise<unknown> {
  return request('POST', `/jobs/${jobId}/rate`, body, true, biometricAction);
}

// ─── Vouching ────────────────────────────────────────────────────────────────
// The free vouch write is RETIRED (F27 /): a vouch is now a costly
// reputation-tier presentation burn an AGENT makes (POST /agent/wallet/:id/vouch/burn,
// agent auth), never a free human tap. Only the read-side survives here.

/** One vouch FOR a profile (people are vouchees too; `voucher_kind` says who vouched). */
export interface ProfileVouch {
  vouch_id: string;
  voucher_wallet_id: string;
  voucher_kind: 'agent' | 'human';
  note: string | null;
  backing_presentation_id: string;
  created_at: number;
}

export async function getVouches(walletId: string, biometricAction?: BiometricAction): Promise<{ vouches: ProfileVouch[] }> {
  const res = await request<{ vouches?: ProfileVouch[] }>('GET', `/agent/${encodeURIComponent(walletId)}/vouches`, undefined, true, biometricAction);
  return { vouches: Array.isArray(res.vouches) ? res.vouches : [] };
}

/** A vouch this person staked (GET /v1/wallet/vouches). */
export interface MyVouch {
  vouch_id: string;
  target_id: string;
  target_kind: 'agent' | 'human' | null;
  note: string | null;
  backing_burn_id: string;
  created_at: number;
}

/**
 * a person vouches for a person or an agent. Rides a live REPUTATION presentation from
 * this person to the target's Commons id (428 `rail_handshake_required` otherwise); refused 403
 * `linked_pair_vouch_refused` for the person's own linked agent.
 */
export async function stakeVouch(targetId: string, note?: string, biometricAction?: BiometricAction): Promise<MyVouch> {
  return familyRequest('/v1/wallet', 'POST', '/vouch', { target_id: targetId, ...(note ? { note } : {}) }, biometricAction);
}

export async function getMyVouches(biometricAction?: BiometricAction): Promise<{ vouches: MyVouch[] }> {
  const res = await familyRequest<{ vouches?: MyVouch[] }>('/v1/wallet', 'GET', '/vouches', undefined, biometricAction);
  return { vouches: Array.isArray(res.vouches) ? res.vouches : [] };
}

// ─── QR Auth ─────────────────────────────────────────────────────────────────

export async function generateQRChallenge(biometricAction?: BiometricAction): Promise<{
  session_id: string;
  challenge_nonce: string;
  qr_data: string;
  expires_at: number;
}> {
  return request('POST', '/auth/challenge', undefined, undefined, biometricAction);
}

export async function confirmQRAuth(body: {
  session_id: string;
  challenge_nonce: string;
  signature: string;
}, biometricAction?: BiometricAction): Promise<void> {
  await request('POST', '/auth/confirm', body, true, biometricAction);
}

export async function pollAuthStatus(sessionId: string, biometricAction?: BiometricAction): Promise<{
  authenticated: boolean;
  wallet_id?: string;
  session_token?: string;
  expires_at?: number;
}> {
  return request('GET', `/auth/status/${sessionId}`, undefined, undefined, biometricAction);
}

// Export types for screens
export type {
  CommonsProfile,
  ForumPost,
  HumanJob,
  HumanJobApplication,
  HumanJobApplicant,
  FeedItem,
  InstitutionInfo,
  CommonsJoinContext,
  PublicationConsent,
  RedactionConfig,
};
