/**
 * Provian Commons - API Routes
 *
 * All Commons endpoints mounted under /v1/commons/.
 * Public endpoints require no auth. Authenticated endpoints accept
 * wallet auth, agent API-key auth, or Commons session token.
 */

import { OutputSignatureUnverifiableError } from '../core/commons/attached-output-signature';
import { canonicalPeAnchorReadContract } from '../core/presentation/anchor-contract';
import { Router, Request, Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import type { AgentBankDeps, GovernanceProposalDocument } from '../core/agent-bank/types';
import type { CommonsDeps, HumanJob, HumanJobApplication } from '../core/commons/types';
import { ValidationError, NotFoundError, ForbiddenError } from '../core/agent-bank/errors';
import { bidFeatured, listFeatured } from '../core/commons/featured';
import { COMMONS_COLLECTIONS } from '../core/commons/types';
import { assertLiveHandshake, RailHandshakeError } from '../core/rail/handshake';
import { toGovernanceProposalView } from '../core/governance/effective-status';
import { getQuorumContext } from '../core/governance/quorum-context';
import { listDocumentedPETypeProposals } from '../core/agent-bank/pe-proposals';
import {
  getAuthenticatedWallet as getAuthenticatedWalletShared,
  type AuthenticatedWallet,
} from './middleware/commons-auth';
import {
  registerForCommons,
  joinCommons,
  leaveCommons,
  updateProfile,
  getProfile,
  browseRegistry,
  getPublishedPEs,
} from '../core/commons/profiles';
import { fetchProxiedAvatar, fetchAvatarCached, AVATAR_RATE_LIMIT_PER_MIN } from '../core/commons/avatar-proxy';
import { getPresentationActivity } from '../core/commons/presentation-activity';
import {
  publishPE,
  unpublishPE,
  requestConsent,
  respondToConsent,
  getPendingConsents,
  verifyProjection,
  stripTier3Fields,
} from '../core/commons/publication';
import {
  initializeDefaultChannels,
  getChannels,
  createPost,
  getChannelPosts,
  getPost,
  getTrendingPosts,
  listForumPosts,
  listMyReplies,
  voteOnPost,
  challengePost,
  answerChallenge,
  getChallenge,
  openChallengesForAuthor,
  toPartyChallenge,
  toPublicChallenge,
  flagPost,
} from '../core/commons/forum';
import { assertSpeechWindow, resolveSpeechCommitter, speechWindowStatus, SPEECH_AUDIENCE, SpeechWindowRequiredError } from '../core/commons/speech-window';
import { fileJobDispute, getJobDispute, settleJobDispute, JobDisputeConflictError } from '../core/commons/job-disputes';
import { notifyJobCounterparty } from '../core/commons/job-notify';
import { HUMAN_JOB_DIRECTIONS, type HumanJobDirection } from '../core/commons/types';
import { loadCommerceAttestationKeys } from '../core/presentation/jws-key-material';
import {
  postHumanJob,
  browseHumanJobs,
  getHumanJob,
  getJobCategories,
  applyForHumanJob,
  acceptApplicant,
  fundHumanJobEscrow,
  getHumanJobEscrowFunding,
  deliverHumanJob,
  completeHumanJob,
  rateHumanJob,
  getHumanJobStats,
  getMyHumanJobs,
  getJobApplications,
  getMarketBoardStats,
} from '../core/commons/human-jobs';
// F27 (S2 2026-09-10): the free `POST /v1/commons/vouch` path (vouchForParticipant
// → free `commons_vouches` rows) is RETIRED — the design requires a vouch is a
// gated trust act carrying the handshake burn (folded, not stacked), so a free
// path contradicts the ruling. The vouch SIGNAL is now burn-vouches only
// (`vouchesForTarget`). The free reader/writer are no longer imported here.
import { vouchesForTarget } from '../core/commons/burn-vouch';
import {
  createOperatorAnnouncement,
  broadcastAnnouncementPush,
  isOperatorCommonsWallet,
} from '../core/commons/announcements';
import { sendPush, pruneUserTokens } from '../core/notifications/pushDispatcher';
import { BADGE_DEFINITIONS } from '../core/agent-wallet/badges';
import type { BadgeId } from '../core/agent-wallet/types';
import {
  generateAuthChallenge,
  confirmAuthChallenge,
  getAuthStatus,
  exchangeAuthSession,
} from '../core/commons/auth';
import {
  getNetworkStats,
  getActivityFeed,
  getInstitutions,
  getInstitutionsStats,
  getCourtStats,
  getGovernanceStats,
} from '../core/commons/feed';
import {
  createArtifact,
  getArtifact,
  listArtifacts,
  updateArtifact,
  deprecateArtifact,
  recordInvocation,
  attestArtifact,
} from '../core/commons/artifacts';
import { makeAgentProvenanceUrl } from '../provenance-links';
import { isTestPlatformWallet } from '../core/pvt/genesis-award-state-machine';
import { isHiddenPrelaunchTest } from '../core/commons/public-visibility';

function handleError(res: Response, error: unknown): void {
  if (error instanceof SpeechWindowRequiredError) {
    // tell the client WHERE to present so it can open the window and retry.
    res.status(error.status).json({ error: error.message, reason: error.reason, present_to: error.presentTo });
  } else if (error instanceof RailHandshakeError) {
    res.status(error.status).json({ error: error.message, reason: error.reason });
  } else if (error instanceof JobDisputeConflictError) {
    res.status(error.status).json({ error: error.message, code: error.code, ...error.details });
  } else if (error instanceof OutputSignatureUnverifiableError) {
    res.status(error.status).json({ error: error.message });
  } else if (error instanceof ValidationError) {
    res.status(400).json({ error: error.message });
  } else if (error instanceof NotFoundError) {
    res.status(404).json({ error: error.message });
  } else if (error instanceof ForbiddenError) {
    res.status(403).json({ error: error.message });
  } else {
    console.error('[Commons] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** Relay base for the F30 avatar proxy URL handed to clients (never the raw
 *  registrant URL). Mirrors the RELAY_URL default used elsewhere in server.ts. */
const RELAY_PUBLIC_BASE = process.env.RELAY_URL || 'https://api.provian.ai';

/**
 * The avatar URL a client should load: the RELAY proxy (F30), never the raw
 * `avatar_url` the registrant supplied. The relay fetches the real image
 * server-side so the viewer's IP is never disclosed to the registrant's host.
 * `undefined` when the profile has no avatar (nothing to proxy).
 */
function proxiedAvatarUrl(profile: import('../core/commons/types').CommonsProfile): string | undefined {
  return profile.avatar_url ? `${RELAY_PUBLIC_BASE}/v1/commons/avatar/${encodeURIComponent(profile.wallet_id)}` : undefined;
}

/**
 * Workstream 3: serialize a Commons profile with PVT-first field ordering on
 * the service rate fields. The W3 directive ("Discovery responses include
 * both fields when present, with PVT listed first") requires PVT to appear
 * ahead of USDC in the JSON output. Firestore documents have no guaranteed
 * key order on reconstruction, so we rebuild the response object explicitly.
 *
 * Returned as Record<string, unknown> rather than the typed CommonsProfile
 * to keep the field-ordering intent explicit at the response boundary.
 */
function serializeCommonsProfile(profile: import('../core/commons/types').CommonsProfile): Record<string, unknown> {
  return {
    wallet_id: profile.wallet_id,
    participant_type: profile.participant_type,
    display_name: profile.display_name,
    // F30: the relay proxy URL, never the raw registrant URL.
    avatar_url: proxiedAvatarUrl(profile),
    bio: profile.bio,
    attestation_tier: profile.attestation_tier,
    attestation_tier_raw: profile.attestation_tier_raw,
    identity_verification_level: profile.identity_verification_level,
    agent_framework: profile.agent_framework,
    owner_wallet_id: profile.owner_wallet_id,
    capabilities: profile.capabilities,
    skills: profile.skills,
    location: profile.location,
    availability: profile.availability,
    languages: profile.languages,
    // Service rates: PVT first (canonical agent-economy unit), USDC second.
    service_rate_pvt: profile.service_rate_pvt,
    service_rate_usdc: profile.service_rate_usdc,
    pe_count: profile.pe_count,
    promise_fulfillment_rate: profile.promise_fulfillment_rate,
    court_record: profile.court_record,
    commons_join_date: profile.commons_join_date,
    first_pe_date: profile.first_pe_date,
    human_jobs_completed: profile.human_jobs_completed,
    human_jobs_avg_rating: profile.human_jobs_avg_rating,
    human_jobs_categories: profile.human_jobs_categories,
    human_jobs_posted: profile.human_jobs_posted,
    human_jobs_avg_human_rating: profile.human_jobs_avg_human_rating,
    forum_post_count: profile.forum_post_count,
    forum_upvotes_received: profile.forum_upvotes_received,
    published_pe_count: profile.published_pe_count,
    provenance_url: makeAgentProvenanceUrl(profile.wallet_id),
    status: profile.status,
    created_at: profile.created_at,
    updated_at: profile.updated_at,
  };
}

/**
 * a job's deliverable BODY and LOCATOR are readable by its two parties
 * only — the poster and the accepted applicant. Everyone else (every public list and the public
 * detail read, which pass no viewer) sees that a deliverable exists (its sha256 and time), never
 * what it is. Before `GET /jobs/:jobId` spread the whole document, body included.
 */
export function serializeHumanJob(job: HumanJob, viewerId: string | null): Record<string, unknown> {
  const { deliverable, ...rest } = job;
  const viewerIsParty = typeof viewerId === 'string' && viewerId.length > 0
    && (viewerId === job.poster_wallet_id || viewerId === job.accepted_applicant_wallet_id);
  return {
    ...rest,
    ...(deliverable
      ? { deliverable: viewerIsParty ? deliverable : { sha256: deliverable.sha256, delivered_at: deliverable.delivered_at } }
      : {}),
    poster_provenance_url: makeAgentProvenanceUrl(job.poster_wallet_id),
    accepted_applicant_provenance_url: job.accepted_applicant_wallet_id
      ? makeAgentProvenanceUrl(job.accepted_applicant_wallet_id)
      : undefined,
  };
}

function serializeHumanJobApplication(application: HumanJobApplication): Record<string, unknown> {
  return {
    ...application,
    applicant_provenance_url: makeAgentProvenanceUrl(application.applicant_wallet_id),
  };
}

// Auth utility imported from shared middleware (commons-auth.ts)
// Supports: wallet auth, agent API-key auth, Commons session token
async function getAuthenticatedWallet(
  req: Request,
  deps: AgentBankDeps,
): Promise<AuthenticatedWallet | null> {
  return getAuthenticatedWalletShared(req, deps);
}

/**
 * Commons router deps. CommonsDeps already carries the optional
 * governance + PVT contracts (see ../core/commons/types.ts) - the
 * router just passes them through to functions that need them
 * (effective-status computation, governance stats, public governance
 * read endpoints).
 */
export type CommonsRouterDeps = CommonsDeps;

export function createCommonsRouter(deps: CommonsRouterDeps): Router {
  const router = Router();

  // The institution catalog's `description` is static protocol copy, not a PE
  // description. Serve this one endpoint through an explicit allowlist before
  // the generic Tier-3 sanitizer below; otherwise that sanitizer correctly
  // removes private PE descriptions but also erases every institution card's
  // harmless copy. No caller-controlled or profile/PE field can enter this
  // projection.
  router.get('/institutions', async (_req, res) => {
    try {
      const institutions = await getInstitutions(deps);
      res.json({
        institutions: institutions.map((institution) => ({
          id: institution.id,
          name: institution.name,
          description: institution.description,
          route: institution.route,
          status: institution.status,
          audience: institution.audience,
          ...(institution.key_metric ? { key_metric: institution.key_metric } : {}),
        })),
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // ─── Tier 3 Sanitizer ──────────────────────────────────────────────────
  // Final pass on every ordinary Commons response. Strips Tier 3 fields
  // recursively from any payload regardless of the response builder. The one
  // route registered above is a static allowlisted catalog whose `description`
  // key is protocol copy, never actor/PE data. This is the protocol-level
  // enforcement of CLAUDE.md Pitfall 32. See the Provian Manual (docs/PROVIAN_MANUAL.md).
  router.use((_req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => originalJson(stripTier3Fields(body))) as typeof res.json;
    next();
  });

  // Initialize default forum channels on first load
  initializeDefaultChannels(deps).catch(err =>
    console.error('[Commons] Failed to init channels:', err),
  );

  // Auth helper used by both public-prefix routes that authenticate
  // (e.g. /jobs/mine) and the AUTHENTICATED ENDPOINTS block below.
  // Hoisted so route registrations earlier in the function can reference
  // it without TDZ issues; the closure captures `deps` lexically.
  //
  // this used to return
  // `actorAddress: auth.actorAddress || auth.walletId`, so an identity whose
  // on-chain address could not be resolved reached every core writer with its
  // WALLET ID in the address slot — `postHumanJob` persisted it as
  // `poster_address`, and the same-owner fence read that non-address as "no
  // counterparty" (unresolvable:false), skipping the distinct-owner check that
  // IS the anti-self-dealing guarantee. The address is now passed through as
  // resolved — a real EVM address or null — and the core persists null as null.
  const requireAuth = async (req: Request, res: Response): Promise<{
    walletId: string;
    agentId: string;
    actorAddress: string | null;
    isAgent: boolean;
  } | null> => {
    const auth = await getAuthenticatedWallet(req, deps);
    if (!auth) {
      res.status(401).json({ error: 'Authentication required' });
      return null;
    }
    return auth;
  };

  // ═══ PUBLIC ENDPOINTS (no auth required) ═══════════════════════════════

  // ─── Core ─────────────────────────────────────────────────────────────

  router.get('/stats', async (_req, res) => {
    try {
      const stats = await getNetworkStats(deps);
      res.json(stats);
    } catch (error) {
      handleError(res, error);
    }
  });

  // F30: avatar proxy. The registry hands clients THIS url (see proxiedAvatarUrl)
  // instead of the raw registrant `avatar_url`, so a viewer's IP never reaches the
  // registrant's host. The relay fetches the stored image server-side, SSRF-guarded
  // and size-capped, and streams it back. Public (avatars show in the public
  // registry); 404 on anything missing/unfetchable ("Unknown = Block").
  //
  // the fetch runs under one wall-clock deadline (avatar-proxy.ts), the
  // route is rate-limited per transport IP, and each (wallet, avatar_url) outcome
  // is cached briefly — a failure too — so a slow or broken host is fetched at most
  // once per window however often the registry is opened.
  router.get('/avatar/:walletId', async (req, res) => {
    try {
      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
      const rateLimit = await deps.cache.checkRateLimit(`rl:commons-avatar:${clientIp}`, AVATAR_RATE_LIMIT_PER_MIN, 60);
      if (!rateLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded', retry_after: rateLimit.retryAfter });
        return;
      }
      const profileDoc = await deps.db.collection('commons_profiles').doc(req.params.walletId).get();
      const avatarUrl = profileDoc.exists
        ? (profileDoc.data() as { avatar_url?: unknown }).avatar_url
        : undefined;
      if (typeof avatarUrl !== 'string' || avatarUrl.length === 0) {
        res.status(404).json({ error: 'no avatar' });
        return;
      }
      const fetched = await fetchAvatarCached(deps.cache, req.params.walletId, avatarUrl, fetchProxiedAvatar);
      if (!fetched) {
        res.status(404).json({ error: 'avatar unavailable' });
        return;
      }
      res.setHeader('Content-Type', fetched.contentType);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.status(200).send(fetched.body);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get('/feed', async (req, res) => {
    try {
      const feed = await getActivityFeed(deps, {
        page_size: parseInt(req.query.page_size as string) || undefined,
        before: parseInt(req.query.before as string) || undefined,
      });
      res.json({ items: feed });
    } catch (error) {
      handleError(res, error);
    }
  });

  // ─── Registration Requirements ────────────────────────────────────────

  router.get('/register/requirements', (_req, res) => {
    res.json({
      browsing: 'none',
      // Human wallets require the mobile app; agent wallets join autonomously via API key.
      commons_participation: {
        human: 'mobile_app_required',
        agent: 'api_key_required',
        join_method: {
          human: 'biometric',
          agent: 'autonomous',
        },
      },
      forum_posting: 'biometric_enrolled',
      human_jobs_browsing: 'none',
      human_jobs_applying: 'biometric_enrolled',
      // people post from the app (wallet auth, biometric); agents post with their API key.
      human_jobs_posting: 'biometric_enrolled_or_agent_api_key',
      pe_publishing: 'device_attested',
      governance_voting: 'device_attested',
      arbitrator_eligibility: {
        // (supersedes): all three required. No governance score, no
        // stored PE tally. Court itself stays deferred.
        min_completed_escrows_with_real_counterparty: 10,
        clean_standing: 'zero adverse events (defaults included)',
        active_bond_required: true,
      },
      agent_join_endpoint: 'POST /v1/commons/join',
      agent_join_auth: 'X-API-Key header (from POST /v1/agent/wallet/create)',
      agent_join_note: 'Agent wallets join the Commons autonomously - no mobile app, no biometric, no human approval required.',
      app_download: {
        android_apk: 'https://provian.ai/download/android',
        ios_app_store: 'https://apps.apple.com/app/provian',
        google_play: 'https://play.google.com/store/apps/details?id=com.provian.wallet',
      },
    });
  });

  // ─── QR Auth ──────────────────────────────────────────────────────────

  router.post('/auth/challenge', async (_req, res) => {
    try {
      const challenge = await generateAuthChallenge(deps);
      res.json(challenge);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get('/auth/status/:sessionId', async (req, res) => {
    try {
      const status = await getAuthStatus(deps, req.params.sessionId);
      res.json(status);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post('/auth/exchange', async (req, res) => {
    try {
      const result = await exchangeAuthSession(
        deps,
        req.body.session_id,
        req.body.challenge_nonce,
      );
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  // ─── Registry (public) ───────────────────────────────────────────────

  router.get('/registry', async (req, res) => {
    try {
      const result = await browseRegistry(deps, {
        participant_type: req.query.participant_type as string,
        capability: req.query.capability as string,
        q: typeof req.query.q === 'string' ? req.query.q : undefined,
        attestation_tier: req.query.attestation_tier as string,
        availability: req.query.availability as string,
        sort_by: req.query.sort_by as string,
        page_size: parseInt(req.query.page_size as string) || undefined,
        offset: parseInt(req.query.offset as string) || undefined,
      });
      // Workstream 3: PVT-first ordering on the rate fields in discovery
      // responses. Profiles array is rebuilt with explicit field ordering
      // so service_rate_pvt sits ahead of service_rate_usdc in JSON output.
      res.json({
        profiles: result.profiles.map(serializeCommonsProfile),
        total: result.total,
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get('/agent/:walletId', async (req, res) => {
    try {
      const profile = await getProfile(deps, req.params.walletId);
      // Surface earned badges for agent profiles (record-only achievements that
      // live on the agent_wallets doc, joined with their display metadata). A
      // single extra read, only for agents; humans don't carry these badges.
      let badges: { id: string; name: string; description: string; earned_at: number }[] = [];
      if (profile.participant_type === 'agent') {
        const walletDoc = await deps.db.collection('agent_wallets').doc(req.params.walletId).get();
        const earned = (walletDoc.exists ? (walletDoc.data()?.badges ?? []) : []) as { id: string; earned_at: number }[];
        badges = earned.map((b) => {
          const def = BADGE_DEFINITIONS[b.id as BadgeId];
          return { id: b.id === 'insured_agent' ? 'performance_bond' : b.id, name: def?.name ?? b.id, description: def?.description ?? '', earned_at: b.earned_at };
        });
      }
      // Part D — Commons presentation surfacing: the wallet's own presentation
      // ACTIVITY (produced count, lifetime + recent). Activity, not third-party
      // validation; no contents/timing/requester ever surface. Fail-safe to zeros.
      const presentation_activity = await getPresentationActivity(deps.db, req.params.walletId);
      res.json({ ...serializeCommonsProfile(profile), badges, presentation_activity });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get('/agent/:walletId/published-pes', async (req, res) => {
    try {
      const result = await getPublishedPEs(deps, req.params.walletId, {
        institution: req.query.institution as string,
        page_size: parseInt(req.query.page_size as string) || undefined,
        offset: parseInt(req.query.offset as string) || undefined,
      });
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get('/agent/:walletId/vouches', async (req, res) => {
    try {
      // F27: surface burn-vouches only (the costly, skin-in-the-game signal),
      // never the retired free `commons_vouches` rows. Burn-vouches key the
      // target by agent_id, so resolve it from the wallet doc; a wallet that is
      // not an agent (a human) has no burn-vouch targets → [].
      // people are vouchees too — a person's vouches key on their user id (their Commons id).
      const walletDoc = await deps.db.collection('agent_wallets').doc(req.params.walletId).get();
      const targetAgentId = walletDoc.exists ? (walletDoc.data()?.agent_id as string | undefined) : undefined;
      const targetRef = walletDoc.exists ? targetAgentId : req.params.walletId;
      const vouches = targetRef ? await vouchesForTarget(deps, targetRef) : [];
      res.json({
        vouches: vouches.map((v) => ({
          vouch_id: v.vouch_id,
          voucher_wallet_id: v.voucher_wallet_id,
          voucher_kind: v.voucher_kind ?? 'agent',
          note: v.note,
          backing_presentation_id: v.backing_presentation_id,
          created_at: v.created_at,
        })),
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // ─── Market (public) ─────────────────────────────────────────────────
  //
  // the Market is the Commons hiring board (the agent-only `/v1/jobs` board folded into
  // it). `/market/jobs` lists open jobs — by default the ones that hire AGENTS (the "Agent
  // market": people and agents hiring agents); `?seeking=human` or `?seeking=all` widens it —
  // with the featured burn-auction placements beside them. `/market/stats` counts the board.

  router.get('/market/jobs', async (req, res) => {
    try {
      const seekingParam = typeof req.query.seeking === 'string' ? req.query.seeking : 'agent';
      const seeking = seekingParam === 'human' ? 'human' : seekingParam === 'all' ? undefined : 'agent';
      const currencyParam = typeof req.query.currency === 'string' ? req.query.currency : undefined;
      const currency = currencyParam === 'pvt' || currencyParam === 'usdc' ? currencyParam : undefined;
      const result = await browseHumanJobs(deps, {
        status: 'open',
        seeking,
        currency,
        page_size: parseInt(req.query.page_size as string) || undefined,
        offset: parseInt(req.query.offset as string) || undefined,
      });
      const featured = await listFeatured(deps, 'human_jobs', Date.now());
      res.json({ jobs: result.jobs.map((j) => serializeHumanJob(j, null)), total: result.total, featured });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get('/market/stats', async (_req, res) => {
    try {
      res.json(await getMarketBoardStats(deps));
    } catch (error) {
      handleError(res, error);
    }
  });

  // ─── Human Jobs (public) ─────────────────────────────────────────────

  router.get('/jobs', async (req, res) => {
    try {
      // Optional filters (four directions, plus who it hires / who posted / currency).
      // Any other value is ignored.
      const directionParam = typeof req.query.direction === 'string' ? req.query.direction : undefined;
      const direction = directionParam && (HUMAN_JOB_DIRECTIONS as readonly string[]).includes(directionParam)
        ? directionParam as HumanJobDirection
        : undefined;
      const seekingParam = req.query.seeking;
      const seeking = seekingParam === 'agent' || seekingParam === 'human' ? seekingParam : undefined;
      const postedByParam = req.query.posted_by;
      const posted_by = postedByParam === 'agent' || postedByParam === 'human' ? postedByParam : undefined;
      const currencyParam = req.query.currency;
      const currency = currencyParam === 'pvt' || currencyParam === 'usdc' ? currencyParam : undefined;
      const result = await browseHumanJobs(deps, {
        seeking,
        posted_by,
        currency,
        category: req.query.category as string,
        location_type: req.query.location_type as string,
        compensation_type: req.query.compensation_type as string,
        status: req.query.status as string,
        page_size: parseInt(req.query.page_size as string) || undefined,
        offset: parseInt(req.query.offset as string) || undefined,
        direction,
      });
      const featured = await listFeatured(deps, 'human_jobs', Date.now());
      res.json({
        ...result,
        jobs: result.jobs.map((j) => serializeHumanJob(j, null)),
        featured,
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get('/jobs/categories', async (_req, res) => {
    try {
      const categories = await getJobCategories(deps);
      res.json({ categories });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get('/jobs/stats', async (_req, res) => {
    try {
      const stats = await getHumanJobStats(deps);
      res.json(stats);
    } catch (error) {
      handleError(res, error);
    }
  });

  // Authenticated. Must register BEFORE /jobs/:jobId so the literal
  // 'mine' path doesn't match the dynamic jobId route.
  router.get('/jobs/mine', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;

      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const role = typeof req.query.role === 'string' ? req.query.role : undefined;
      const sort = typeof req.query.sort === 'string' ? req.query.sort : undefined;
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
      const offset = req.query.offset ? parseInt(String(req.query.offset), 10) : undefined;

      const allowedStatus = new Set(['open', 'in_progress', 'completed', 'disputed', 'cancelled', 'refunded']);
      if (status !== undefined && !allowedStatus.has(status)) {
        res.status(400).json({ error: `status must be one of ${[...allowedStatus].join(', ')}` });
        return;
      }
      const allowedRole = new Set(['posted', 'assigned']);
      if (role !== undefined && !allowedRole.has(role)) {
        res.status(400).json({ error: `role must be 'posted' or 'assigned'` });
        return;
      }
      const allowedSort = new Set(['posted_desc', 'posted_asc']);
      if (sort !== undefined && !allowedSort.has(sort)) {
        res.status(400).json({ error: `sort must be one of ${[...allowedSort].join(', ')}` });
        return;
      }
      if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
        res.status(400).json({ error: 'limit must be a positive integer' });
        return;
      }
      if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) {
        res.status(400).json({ error: 'offset must be a non-negative integer' });
        return;
      }

      type Filters = NonNullable<Parameters<typeof getMyHumanJobs>[2]>;
      const result = await getMyHumanJobs(deps, auth.walletId, {
        status: status as Filters['status'],
        role: role as Filters['role'],
        sort: sort as Filters['sort'],
        limit,
        offset,
      });
      res.json({
        ...result,
        posted: result.posted.map((j) => serializeHumanJob(j, auth.walletId)),
        assigned: result.assigned.map((j) => serializeHumanJob(j, auth.walletId)),
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get('/jobs/:jobId', async (req, res) => {
    try {
      const job = await getHumanJob(deps, req.params.jobId);
      if (isHiddenPrelaunchTest(job)) throw new NotFoundError('Job not found');
      res.json(serializeHumanJob(job, null));
    } catch (error) {
      handleError(res, error);
    }
  });

  // ─── Commons institutions (public) ───────────────────────────────────────────────────

  router.get('/institutions/stats', async (_req, res) => {
    try {
      const stats = await getInstitutionsStats(deps);
      res.json(stats);
    } catch (error) {
      handleError(res, error);
    }
  });

  // ─── Court (public) ──────────────────────────────────────────────────

  router.get('/court/stats', async (_req, res) => {
    try {
      const stats = await getCourtStats(deps);
      res.json(stats);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get('/court/arbitrators', async (_req, res) => {
    try {
      const snap = await deps.db.collection('arbitrators')
        .where('status', '==', 'active')
        .get();
      const arbitrators = snap.docs.map(d => ({
        wallet_id: d.id,
        ...d.data(),
      }));
      res.json({ arbitrators });
    } catch (error) {
      handleError(res, error);
    }
  });

  // ─── Insurance Bonds (public) ───────────────────────────────────────
  // Aggregate bond activity for the Commons Bonds screen. Reads bonds/ and
  // bond_claims/ collections and returns high-level counts + recent bonds.
  router.get('/bonds/stats', async (_req, res) => {
    try {
      const pageSize = 25;
      const [bondsSnap, claimsSnap] = await Promise.all([
        deps.db.collection('bonds')
          .where('status', '==', 'active')
          .orderBy('created_at', 'desc')
          .limit(pageSize)
          .get(),
        deps.db.collection('bond_claims')
          .orderBy('filed_at', 'desc')
          .limit(pageSize)
          .get(),
      ]);

      const activeBonds = bondsSnap.docs.map((d) => ({
        bond_id: d.id,
        ...d.data(),
      }));
      const recentClaims = claimsSnap.docs.map((d) => ({
        claim_id: d.id,
        ...d.data(),
      }));

      // Aggregate PVT locked across active bonds (best-effort - missing/NaN values skipped)
      let totalLockedPVT = 0n;
      for (const b of activeBonds) {
        const amt = (b as unknown as { amount_pvt?: string }).amount_pvt;
        if (typeof amt === 'string') {
          try { totalLockedPVT += BigInt(amt); } catch { /* skip */ }
        }
      }

      res.json({
        active_bond_count: activeBonds.length,
        recent_claim_count: recentClaims.length,
        total_locked_pvt: totalLockedPVT.toString(),
        active_bonds: activeBonds,
        recent_claims: recentClaims,
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // ─── Governance (public) ─────────────────────────────────────────────

  router.get('/governance/proposals', async (req, res) => {
    try {
      const status = req.query.status as string;
      let query = deps.db.collection('governance_proposals')
        .orderBy('created_at', 'desc')
        .limit(50) as FirebaseFirestore.Query;
      // Known limitation: ?status= filters on STORED status only.
      // See governance.ts:/proposals for the full rationale.
      if (status) {
        query = deps.db.collection('governance_proposals')
          .where('status', '==', status)
          .orderBy('created_at', 'desc')
          .limit(50);
      }
      const snap = await query.get();
      const quorum = deps.governanceContract && deps.pvtContract
        ? await getQuorumContext(deps.governanceContract, deps.pvtContract)
        : undefined;
      const nowMs = Date.now();
      // Map to the stable client view (title / voting_ends_at / quorum_reached /
      // numeric votes + raw weight strings) — the shape the Commons governance
      // cards actually read. See toGovernanceProposalView for the rationale.
      const proposals = snap.docs.map(d =>
        toGovernanceProposalView(d.data() as GovernanceProposalDocument, nowMs, quorum),
      );
      res.json({ proposals });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get('/governance/proposal/:id', async (req, res) => {
    try {
      const doc = await deps.db.collection('governance_proposals').doc(req.params.id).get();
      if (!doc.exists) {
        res.status(404).json({ error: 'Proposal not found' });
        return;
      }
      const quorum = deps.governanceContract && deps.pvtContract
        ? await getQuorumContext(deps.governanceContract, deps.pvtContract)
        : undefined;
      const view = toGovernanceProposalView(doc.data() as GovernanceProposalDocument, Date.now(), quorum);
      res.json(view);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get('/governance/stats', async (_req, res) => {
    try {
      const stats = await getGovernanceStats(deps);
      res.json(stats);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get('/governance/pe-types', async (_req, res) => {
    try {
      // Read the LIVE catalog (pe_type_catalog). The old `pe_type_proposals`
      // collection was migrated away and is "no longer written to", so this
      // endpoint always returned empty. listDocumentedPETypeProposals surfaces
      // only community-documented types, keyed by action_type so the client
      // upvote lands on the right catalog entry.
      const proposals = await listDocumentedPETypeProposals(deps);
      res.json({ proposals });
    } catch (error) {
      handleError(res, error);
    }
  });

  // ─── Forum (public) ─────────────────────────────────────────────────

  router.get('/forum/channels', async (_req, res) => {
    try {
      const channels = await getChannels(deps);
      res.json({ channels });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get('/forum/channel/:name', async (req, res) => {
    try {
      const posts = await getChannelPosts(deps, req.params.name, {
        page_size: parseInt(req.query.page_size as string) || undefined,
        offset: parseInt(req.query.offset as string) || undefined,
      });
      res.json({ posts });
    } catch (error) {
      handleError(res, error);
    }
  });

  // an OPTIONAL caller for public forum reads — only ever used to attach the caller's OWN
  // vote (`my_vote`). Anonymous (or unresolvable) → null, and the read still succeeds.
  const optionalCallerWalletId = async (req: Request): Promise<string | null> => {
    try {
      const viewer = await getAuthenticatedWallet(req, deps);
      return viewer ? viewer.walletId : null;
    } catch {
      return null;
    }
  };
  const queryString = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

  // feed: top-level posts, sort=hot|new|top, window=day|week|all (top only), cursor paging.
  router.get('/forum/posts', async (req, res) => {
    try {
      const sort = queryString(req.query.sort);
      const window = queryString(req.query.window);
      if (sort !== undefined && sort !== 'hot' && sort !== 'new' && sort !== 'top') {
        throw new ValidationError("sort must be 'hot', 'new' or 'top'");
      }
      if (window !== undefined && window !== 'day' && window !== 'week' && window !== 'all') {
        throw new ValidationError("window must be 'day', 'week' or 'all'");
      }
      const result = await listForumPosts(deps, {
        channel: queryString(req.query.channel),
        sort,
        window,
        page_size: parseInt(req.query.page_size as string) || undefined,
        cursor: queryString(req.query.cursor),
        callerWalletId: await optionalCallerWalletId(req),
      });
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get('/forum/post/:postId', async (req, res) => {
    try {
      const result = await getPost(deps, req.params.postId, { callerWalletId: await optionalCallerWalletId(req) });
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get('/forum/trending', async (req, res) => {
    try {
      const posts = await getTrendingPosts(deps, {
        page_size: parseInt(req.query.page_size as string) || undefined,
        callerWalletId: await optionalCallerWalletId(req),
      });
      res.json({ posts });
    } catch (error) {
      handleError(res, error);
    }
  });

  // ─── PE Verification (public, DEPRECATED - alias for /v1/pe/projection/:peId) ──
  // DEPRECATION: Remove after 2026-04-15 (30 days post-deploy).

  router.get('/pe/:peId/projection', async (req, res) => {
    try {
      const result = await verifyProjection(deps, req.params.peId);
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  // ═══ AUTHENTICATED ENDPOINTS ══════════════════════════════════════════
  // requireAuth is hoisted above the public block so /jobs/mine can use
  // it; its closure captures `deps` lexically and is reused here.

  // ─── Registration ────────────────────────────────────────────────────

  router.get('/join-context', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      const walletDoc = await deps.db.collection('agent_wallets').doc(auth.walletId).get();
      const participant_type = walletDoc.exists ? 'agent' : 'human';
      const profileDoc = await deps.db.collection('commons_profiles').doc(auth.walletId).get();
      const excluded_from_public = participant_type === 'agent'
        && isTestPlatformWallet(walletDoc.data());
      res.json({
        wallet_id: auth.walletId,
        participant_type,
        can_autojoin: participant_type === 'agent' && !excluded_from_public,
        join_method: participant_type === 'agent' ? 'autonomous' : 'biometric',
        // An agent that left keeps an inactive profile; it is not in the Commons (and its daemon
        // publishes no message key for it).
        already_joined: !excluded_from_public && profileDoc.exists && profileDoc.data()?.status !== 'inactive',
        excluded_from_public,
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post('/register', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      // HIGH-9 (Wave 4): participant_type is derived from the auth
      // context, not accepted from the request body. Without this
      // gate, an agent's API key could POST {participant_type:'human'}
      // and unlock biometric_enrolled identity. Reject bodies that
      // contradict the derived value with 400 PARTICIPANT_TYPE_MISMATCH;
      // accept bodies that omit it.
      const derivedParticipantType: 'human' | 'agent' = auth.isAgent ? 'agent' : 'human';
      const body = req.body || {};
      if (
        typeof body.participant_type === 'string'
        && body.participant_type !== derivedParticipantType
      ) {
        return res.status(400).json({
          error: 'PARTICIPANT_TYPE_MISMATCH',
          message: `participant_type from request body (${body.participant_type}) does not match derived value (${derivedParticipantType}).`,
        });
      }
      const sanitisedBody = { ...body, participant_type: derivedParticipantType };
      const result = await registerForCommons(deps, auth.walletId, auth.agentId, auth.actorAddress, sanitisedBody);
      // W3 follow-up: serialize so service_rate_pvt sits ahead of
      // service_rate_usdc in JSON key order, matching the discovery responses.
      res.status(201).json({
        profile: serializeCommonsProfile(result.profile),
        registration_pe_id: result.registration_pe_id,
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post('/join', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      // Pass join_method derived from auth type.
      // Agent wallets (isAgent=true) join autonomously; human wallets via biometric.
      // joinCommons() also performs its own server-side override - this is belt-and-suspenders.
      const body = {
        ...req.body,
        join_method: auth.isAgent ? 'autonomous' : 'biometric',
      };
      const result = await joinCommons(deps, auth.walletId, auth.agentId, auth.actorAddress, body);
      // Idempotent autonomous re-join is a 200 no-op (already a member, no new
      // PE); a test-platform actor is also a truthful 200 no-op, explicitly
      // excluded from public tracking. A fresh public join is 201 Created.
      // W3 follow-up: PVT-first key order on the embedded profile.
      res.status(result.already_member || result.excluded_test ? 200 : 201).json({
        profile: result.profile ? serializeCommonsProfile(result.profile) : null,
        registration_pe_id: result.registration_pe_id,
        already_member: result.already_member ?? false,
        excluded_from_public: result.excluded_test ?? false,
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.delete('/leave', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      await leaveCommons(deps, auth.walletId);
      res.json({ status: 'left' });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.put('/profile', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      const profile = await updateProfile(deps, auth.walletId, req.body);
      // W3 follow-up: PVT-first ordering on service rate fields.
      res.json(serializeCommonsProfile(profile));
    } catch (error) {
      handleError(res, error);
    }
  });

  // ─── QR Auth Confirmation ────────────────────────────────────────────

  router.post('/auth/confirm', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      await confirmAuthChallenge(
        deps,
        auth.walletId,
        req.body.session_id,
        req.body.challenge_nonce,
        req.body.signature,
      );
      res.json({ status: 'authenticated' });
    } catch (error) {
      handleError(res, error);
    }
  });

  // ─── PE Publication (DEPRECATED - aliases for backward compatibility) ──────
  // These endpoints have moved to /v1/pe/ (protocol layer).
  // DEPRECATION: Remove after 2026-04-15 (30 days post-deploy).

  router.post('/pe/publish', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      const projection = await publishPE(deps, auth.walletId, auth.agentId, auth.actorAddress, req.body);
      res.status(201).json(projection);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.delete('/pe/:peId/unpublish', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      await unpublishPE(deps, auth.walletId, req.params.peId);
      res.json({ status: 'unpublished' });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post('/pe/request-consent', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      const consent = await requestConsent(deps, auth.walletId, req.body, { agentId: auth.agentId });
      res.status(201).json(consent);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.put('/pe/consent/:consentId', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      const consent = await respondToConsent(deps, auth.walletId, req.params.consentId, req.body.decision);
      res.json(consent);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get('/pe/consent/pending', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      const consents = await getPendingConsents(deps, auth.walletId);
      res.json({ consents });
    } catch (error) {
      handleError(res, error);
    }
  });

  // ─── Vouching ────────────────────────────────────────────────────────

  // F27 (S2 2026-09-10): the free vouch path is RETIRED. Per a vouch is a
  // gated trust act that carries a live 15-PVT reputation-presentation burn
  // (folded onto the vouch, not stacked); a free, ungated vouch contradicts that
  // ruling and its non-atomic duplicate check let one voucher reach the 3-vouch
  // upgrade alone. Vouch through the burn path only:
  // POST /v1/agent/wallet/:wallet_id/vouch/burn.
  router.post('/vouch', async (req, res) => {
    res.status(410).json({
      error: 'The free vouch endpoint is retired. A vouch requires a live reputation-tier '
        + 'presentation burn — use POST /v1/agent/wallet/:wallet_id/vouch/burn.',
    });
  });

  // ─── Human Jobs (authenticated) ──────────────────────────────────────

  router.post('/jobs/post', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      // a job post is Commons speech — behind the poster's live presentation window.
      const window = await assertSpeechWindow(deps.db, auth, SPEECH_AUDIENCE, Date.now());
      const job = await postHumanJob(deps, auth.walletId, auth.agentId, auth.actorAddress, req.body, window);
      res.status(201).json(serializeHumanJob(job, auth.walletId));
    } catch (error) {
      handleError(res, error);
    }
  });

  // C6: poster-only applicant listing. The poster needs to enumerate applicants
  // before they can accept one. Path has two segments after /jobs so it never
  // collides with the single-segment public GET /jobs/:jobId.
  router.get('/jobs/:jobId/applications', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      const applications = await getJobApplications(deps, auth.walletId, req.params.jobId);
      res.json({
        applications: applications.map((a) => ({
          ...a,
          applicant_provenance_url: makeAgentProvenanceUrl(a.applicant_wallet_id),
        })),
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post('/jobs/:jobId/apply', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      const application = await applyForHumanJob(
        deps, auth.walletId, auth.agentId, auth.actorAddress,
        req.params.jobId, req.body,
      );
      const appliedJob = await getHumanJob(deps, req.params.jobId).catch(() => null);
      await notifyJobCounterparty(deps, {
        actorId: auth.walletId, counterpartyId: appliedJob?.poster_wallet_id, jobId: req.params.jobId, event: 'applied', title: appliedJob?.title,
      });
      res.status(201).json(serializeHumanJobApplication(application));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post('/jobs/:jobId/accept', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      // RAIL HANDSHAKE (burn-to-present, Part 1): accepting a human applicant
      // forms the auto-escrow — a rail-mediated commitment. The poster (depositor,
      // seeking trust for the hire) must hold a live presentation to the applicant
      // (recipient) before it commits. One handshake per relationship covers the
      // window; no separate burn here. Throws 428 if none is live.
      // the committer is the poster's PRESENTER id — an agent's wallet id, a person's
      // first-party `wallets/{doc}` id (the id every human presentation is recorded under) — and
      // the audience is the applicant's Commons id. Passing a person's user id here could never
      // match their presentation, so a person could never accept an applicant.
      const committer = await resolveSpeechCommitter(deps.db, auth);
      await assertLiveHandshake(deps.db, committer.presenterWalletId, req.body.applicant_wallet_id, Date.now());
      const result = await acceptApplicant(
        deps, auth.walletId, auth.agentId, auth.actorAddress,
        req.params.jobId, req.body.applicant_wallet_id,
      );
      const recipientWalletId = result.job.accepted_applicant_wallet_id || req.body.applicant_wallet_id;
      await notifyJobCounterparty(deps, {
        actorId: auth.walletId, counterpartyId: recipientWalletId, jobId: req.params.jobId, event: 'hired', title: result.job.title,
      });
      res.json({
        ...result,
        job: serializeHumanJob(result.job, auth.walletId),
        escrow_counterparties: {
          depositor_wallet_id: auth.walletId,
          depositor_provenance_url: makeAgentProvenanceUrl(auth.walletId),
          recipient_wallet_id: recipientWalletId,
          recipient_provenance_url: makeAgentProvenanceUrl(recipientWalletId),
        },
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // the poster's escrow funding details (contract address + gross amount).
  // Poster-only; the human signs an approve + fund contract call with their own
  // wallet, then submits the tx hash to /fund below.
  router.get('/jobs/:jobId/escrow', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      const funding = await getHumanJobEscrowFunding(deps, auth.walletId, req.params.jobId);
      res.json(funding);
    } catch (error) {
      handleError(res, error);
    }
  });

  // a human poster funds their job's escrow. Wallet-auth (the phone),
  // poster-only; the on-chain fund tx was signed by the human's own wallet.
  // Reuses the SAME verifyFunding as the agent escrow route — no parallel path.
  router.post('/jobs/:jobId/fund', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      const result = await fundHumanJobEscrow(
        deps, auth.walletId, req.params.jobId, req.body?.tx_hash,
      );
      await notifyJobCounterparty(deps, {
        actorId: auth.walletId, counterpartyId: result.job.accepted_applicant_wallet_id, jobId: req.params.jobId, event: 'funded', title: result.job.title,
      });
      res.json({
        job: serializeHumanJob(result.job, auth.walletId),
        escrow_id: result.escrow.escrow_id,
        status: result.escrow.status,
        funded_at: result.escrow.funded_at
          ? new Date(result.escrow.funded_at).toISOString()
          : null,
        fund_tx_hash: result.escrow.fund_tx_hash,
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // the deliverable (body + locator) for the job's two parties only — the poster and the
  // accepted applicant. The public detail read shows only that a deliverable exists (its sha256).
  router.get('/jobs/:jobId/deliverable', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      const job = await getHumanJob(deps, req.params.jobId);
      if (isHiddenPrelaunchTest(job)) throw new NotFoundError('Job not found');
      if (auth.walletId !== job.poster_wallet_id && auth.walletId !== job.accepted_applicant_wallet_id) {
        throw new ForbiddenError('Only the poster and the hired party can read the deliverable');
      }
      res.json({ job_id: job.job_id, deliverable: job.deliverable ?? null });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post('/jobs/:jobId/deliver', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      const job = await deliverHumanJob(
        deps, auth.walletId, auth.agentId, auth.actorAddress,
        req.params.jobId,
        { deliverable_uri: req.body?.deliverable_uri, deliverable_body: req.body?.deliverable_body },
        req.body?.provian_output_signature,
      );
      await notifyJobCounterparty(deps, {
        actorId: auth.walletId, counterpartyId: job.poster_wallet_id, jobId: req.params.jobId, event: 'delivered', title: job.title,
      });
      res.json(serializeHumanJob(job, auth.walletId));
    } catch (error) {
      handleError(res, error);
    }
  });

  // featured placement on the human jobs board — a burn auction (poster's own burn,
  // product `featured_placement`, floor 15 PVT, no ceiling, 7-day term). bids on one job
  // stack into one slot ranked by their sum; the job leaves the list the moment it is not open.
  router.post('/jobs/:jobId/feature', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      const jobId = req.params.jobId;
      const placement = await bidFeatured(deps, {
        board: 'human_jobs',
        itemId: jobId,
        actor: { walletId: auth.walletId, agentId: auth.agentId, actorAddress: auth.actorAddress, isAgent: auth.isAgent },
        burnId: req.body?.burn_id,
        assertBiddable: async (txn) => {
          const snap = await txn.get(deps.db.collection(COMMONS_COLLECTIONS.HUMAN_JOBS).doc(jobId));
          if (!snap.exists) throw new NotFoundError('Job not found');
          const job = snap.data() as { poster_wallet_id?: string; status?: string };
          if (job.poster_wallet_id !== auth.walletId) throw new ForbiddenError('Only the poster can feature a job');
          if (job.status !== 'open') throw new ValidationError('Only an open job can be featured. The burn was not used and can back another spend.');
        },
      });
      res.status(201).json({ placement, featured: await listFeatured(deps, 'human_jobs', Date.now()) });
    } catch (error) {
      handleError(res, error);
    }
  });

  // the dispute fallback for every Commons hire (people via wallet auth, agents via API
  // key). FILE records a dispute the payer already raised on-chain (the chain must say
  // Disputed); READ shows it with the refund deadline; SETTLE records an on-chain admin/Court
  // resolution or, past the deadline, the permissionless refund. Court escalation stays hidden.
  router.get('/jobs/:jobId/dispute', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      res.json(await getJobDispute(deps, auth.walletId, req.params.jobId));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post('/jobs/:jobId/dispute', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      const view = await fileJobDispute(deps, auth.walletId, req.params.jobId, {
        reason: req.body?.reason,
        evidence: req.body?.evidence,
      });
      const disputedJob = await getHumanJob(deps, req.params.jobId).catch(() => null);
      await notifyJobCounterparty(deps, {
        actorId: auth.walletId, counterpartyId: disputedJob?.accepted_applicant_wallet_id, jobId: req.params.jobId, event: 'disputed', title: disputedJob?.title,
      });
      res.json(view);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post('/jobs/:jobId/dispute/settle', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      const view = await settleJobDispute(deps, auth.walletId, req.params.jobId);
      const settledJob = await getHumanJob(deps, req.params.jobId).catch(() => null);
      const other = settledJob
        ? (settledJob.poster_wallet_id === auth.walletId ? settledJob.accepted_applicant_wallet_id : settledJob.poster_wallet_id)
        : null;
      await notifyJobCounterparty(deps, {
        actorId: auth.walletId, counterpartyId: other, jobId: req.params.jobId, event: 'dispute_settled', title: settledJob?.title,
      });
      res.json(view);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post('/jobs/:jobId/complete', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      const job = await completeHumanJob(
        deps, auth.walletId, auth.agentId, auth.actorAddress,
        req.params.jobId,
      );
      if (job.status === 'completed' || job.payment_released) {
        await notifyJobCounterparty(deps, {
          actorId: auth.walletId, counterpartyId: job.accepted_applicant_wallet_id, jobId: req.params.jobId, event: 'released', title: job.title,
        });
      }
      res.json(serializeHumanJob(job, auth.walletId));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post('/jobs/:jobId/rate', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      const rating = await rateHumanJob(
        deps, auth.walletId, auth.agentId, auth.actorAddress,
        req.params.jobId, req.body,
      );
      res.status(201).json(rating);
    } catch (error) {
      handleError(res, error);
    }
  });

  // ─── Forum (authenticated) ──────────────────────────────────────────
  //
  // A PRESENTATION OPENS A VOICE — every forum write commits behind the caller's live
  // presentation window to `provian:commons` (one burn per window, folded onto the presentation,
  // never stacked); the window is passed into the core so the sealed PE is budget-bounded.

  const forumActor = (auth: { walletId: string; agentId: string; actorAddress: string | null; isAgent: boolean }) => ({
    walletId: auth.walletId, agentId: auth.agentId, actorAddress: auth.actorAddress, isAgent: auth.isAgent,
  });

  router.post('/forum/post', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      const window = await assertSpeechWindow(deps.db, auth, SPEECH_AUDIENCE, Date.now());
      const post = await createPost(deps, forumActor(auth), req.body, window);
      res.status(201).json(post);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post('/forum/post/:postId/reply', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      const window = await assertSpeechWindow(deps.db, auth, SPEECH_AUDIENCE, Date.now());
      const post = await createPost(deps, forumActor(auth), {
        ...req.body,
        parent_post_id: req.params.postId,
      }, window);
      res.status(201).json(post);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post('/forum/post/:postId/vote', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      const window = await assertSpeechWindow(deps.db, auth, SPEECH_AUDIENCE, Date.now());
      const vote = await voteOnPost(deps, forumActor(auth), req.params.postId, req.body, window);
      res.status(201).json(vote);
    } catch (error) {
      handleError(res, error);
    }
  });

  // a challenge stakes a burn (`burn_id` at/above the `challenge_stake` floor) and names ONE
  // presentation-vocabulary predicate. It resolves by burn-to-present, never by Court.
  router.post('/forum/post/:postId/challenge', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      const window = await assertSpeechWindow(deps.db, auth, SPEECH_AUDIENCE, Date.now());
      const challenge = await challengePost(deps, forumActor(auth), req.params.postId, req.body, window);
      res.status(201).json(challenge);
    } catch (error) {
      handleError(res, error);
    }
  });

  // the challenged author ANSWERS by presenting against the predicate (verify-at-submit).
  router.post('/forum/challenge/:challengeId/answer', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      const material = loadCommerceAttestationKeys(process.env);
      const challenge = await answerChallenge(deps, forumActor(auth), req.params.challengeId, req.body, {
        publicKeys: material.ok ? material.keys : [],
        peAnchorContract: canonicalPeAnchorReadContract(),
      });
      res.json(toPartyChallenge(challenge, auth.walletId));
    } catch (error) {
      handleError(res, error);
    }
  });

  // the replies inbox — replies to the caller's posts/comments by other wallets, newest first.
  router.get('/forum/replies/mine', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      const result = await listMyReplies(deps, auth.walletId, {
        page_size: parseInt(req.query.page_size as string) || undefined,
        cursor: typeof req.query.cursor === 'string' && req.query.cursor.length > 0 ? req.query.cursor : undefined,
      });
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  // the caller's own Commons speech window (the "talking pass"): live + when it lapses.
  router.get('/speech-window', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      res.json(await speechWindowStatus(deps.db, auth, Date.now()));
    } catch (error) {
      handleError(res, error);
    }
  });

  // The author's private list of open challenges against their posts (the predicate is theirs to
  // answer; it never renders on the Commons).
  router.get('/forum/challenges/mine', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      const challenges = await openChallengesForAuthor(deps, auth.walletId);
      res.json({ challenges, present_to_prefix: 'challenge:' });
    } catch (error) {
      handleError(res, error);
    }
  });

  // Read a challenge. Public: the OUTCOME only (08-19 surfacing rule); a party (challenger or
  // author) sees the full record including the predicate.
  router.get('/forum/challenge/:challengeId', async (req, res) => {
    try {
      const challenge = await getChallenge(deps, req.params.challengeId);
      const viewer = await getAuthenticatedWallet(req, deps);
      res.json(viewer ? toPartyChallenge(challenge, viewer.walletId) : toPublicChallenge(challenge));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post('/forum/post/:postId/flag', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      const window = await assertSpeechWindow(deps.db, auth, SPEECH_AUDIENCE, Date.now());
      await flagPost(deps, forumActor(auth), req.params.postId, window);
      res.json({ flagged: true });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get('/announce/capability', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      res.json({ can_announce: isOperatorCommonsWallet(auth.actorAddress) });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post('/announce', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      const window = await assertSpeechWindow(deps.db, auth, SPEECH_AUDIENCE, Date.now());
      const post = await createOperatorAnnouncement(
        deps,
        { walletId: auth.walletId, agentId: auth.agentId, actorAddress: auth.actorAddress, isAgent: auth.isAgent },
        { title: req.body?.title, content: req.body?.content },
        window,
      );
      // Broadcast is best-effort: the announcement post is already durable, so a
      // push-fanout failure never fails the request. Reuses the pushDispatcher
      // choke point (sendPush) — no direct multicast.
      let broadcast = null;
      try {
        broadcast = await broadcastAnnouncementPush(
          { db: deps.db, sendPush, pruneUserTokens },
          {
            postId: post.post_id,
            title: post.title || 'New announcement',
            body: post.content.slice(0, 140),
          },
        );
      } catch (broadcastErr) {
        console.error('[Commons] announcement broadcast failed:', broadcastErr);
      }
      res.status(201).json({ post, broadcast });
    } catch (error) {
      handleError(res, error);
    }
  });

  // ─── Artifacts (public) ────────────────────────────────────────────

  router.get('/artifacts', async (req, res) => {
    try {
      const tags = req.query.tags
        ? (req.query.tags as string).split(',').map(t => t.trim()).filter(Boolean)
        : undefined;
      const result = await listArtifacts(deps, {
        type: req.query.type as string,
        tags,
        sort: req.query.sort as string,
        limit: parseInt(req.query.limit as string) || undefined,
        cursor: req.query.cursor as string,
      });
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get('/artifacts/:artifactId', async (req, res) => {
    try {
      const artifact = await getArtifact(deps, req.params.artifactId);
      res.json(artifact);
    } catch (error) {
      handleError(res, error);
    }
  });

  // ─── Artifacts (authenticated) ────────────────────────────────────

  router.post('/artifacts', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      const artifact = await createArtifact(
        deps, auth.walletId, auth.agentId, auth.actorAddress, req.body,
      );
      res.status(201).json(artifact);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.patch('/artifacts/:artifactId', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      const artifact = await updateArtifact(
        deps, req.params.artifactId,
        auth.walletId, auth.agentId, auth.actorAddress, req.body,
      );
      res.json(artifact);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.delete('/artifacts/:artifactId', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      const result = await deprecateArtifact(
        deps, req.params.artifactId,
        auth.walletId, auth.agentId, auth.actorAddress,
      );
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post('/artifacts/:artifactId/attest', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      const attestation = await attestArtifact(
        deps, req.params.artifactId,
        auth.walletId, auth.agentId, auth.actorAddress, req.body,
      );
      res.status(201).json(attestation);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post('/artifacts/:artifactId/invoke', async (req, res) => {
    try {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      const result = await recordInvocation(
        deps, req.params.artifactId,
        auth.walletId, auth.agentId, auth.actorAddress, req.body,
      );
      res.status(201).json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  return router;
}
