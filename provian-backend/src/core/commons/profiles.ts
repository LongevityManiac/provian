import { ownerParticipantClass } from '../identity/participant-class';
import {publicProjection} from './projection-privacy';
/**
 * Provian Commons - Profile Management
 *
 * Handles Commons registration, profile CRUD, and trust metric aggregation.
 * Reads from existing PE history - does not create parallel data stores.
 */

import { v4 as uuidv4 } from 'uuid';
import { generatePE } from '../agent-bank/pe-utils';
import { ValidationError, NotFoundError, ForbiddenError } from '../agent-bank/errors';
import {
  COMMONS_SAFETY_LIMITS,
  COMMONS_COLLECTIONS,
  type CommonsDeps,
  type CommonsProfile,
  type RegisterRequest,
  type JoinRequest,
  type UpdateProfileRequest,
  type CourtRecord,
  type IdentityVerificationLevel,
  type CommonsJoinMethod,
} from './types';
import { computeWalletAttestationTier } from './wallet-reads';
import { countVisibleAgentPEs } from '../agent-wallet/agent-pe-activity';
import { isTestPlatformWallet } from '../pvt/genesis-award-state-machine';
import { isHiddenPrelaunchTest } from './public-visibility';
import { isDisplayNameSetByHuman } from '../agent-wallet/human-agent-name';
import { isMessagePubkey, publishMessageKey, readMessageKey } from './message-keys';

const L = COMMONS_SAFETY_LIMITS;

/** Stable wire reason for an agent intentionally excluded from public Commons. */
export const COMMONS_TEST_PLATFORM_EXCLUSION = 'test_platform_excluded';

export type JoinCommonsResult =
  | {
      profile: CommonsProfile;
      registration_pe_id: string;
      already_member?: boolean;
      excluded_test?: false;
    }
  | {
      profile: null;
      registration_pe_id: '';
      already_member: false;
      excluded_test: true;
    };

/** Max length of a profile avatar URL (F30). */
export const AVATAR_URL_MAX_LEN = 512;

/**
 * Validate an optional profile `avatar_url` (F30). Absent/empty is fine (no
 * avatar). When present it MUST be an absolute https URL within the length cap;
 * anything else throws. This is one half of the F30 fix — the other is serving
 * the image through the relay-side avatar proxy so a registrant never sees a
 * viewer's IP (the stored URL here is what that proxy fetches server-side, never
 * a URL the phone loads directly).
 */
export function validateAvatarUrl(avatarUrl: unknown): void {
  if (avatarUrl === undefined || avatarUrl === null || avatarUrl === '') return;
  if (typeof avatarUrl !== 'string') {
    throw new ValidationError('avatar_url must be a string');
  }
  if (avatarUrl.length > AVATAR_URL_MAX_LEN) {
    throw new ValidationError(`avatar_url must be ${AVATAR_URL_MAX_LEN} characters or fewer`);
  }
  let parsed: URL;
  try {
    parsed = new URL(avatarUrl);
  } catch {
    throw new ValidationError('avatar_url must be a valid absolute URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new ValidationError('avatar_url must use https');
  }
}

/**
 * Validate optional service rate fields. Both are optional - agents/humans
 * can set neither, one, or both. When both are set, PVT is canonical and
 * USDC is the explicit downgrade for clients that can't pay PVT (W3 prompt).
 *
 * Validation is well-formedness only: non-negative integer BigInt string for
 * PVT, non-negative finite number for USDC. No numeric ceiling - BigInt is
 * arbitrary precision, and a ceiling here would be invented policy, not a
 * technical constraint.
 */
function validateServiceRates(
  ratePvt: string | undefined,
  rateUsdc: number | undefined,
): void {
  if (ratePvt !== undefined && ratePvt !== '') {
    if (typeof ratePvt !== 'string' || !/^[0-9]+$/.test(ratePvt)) {
      throw new ValidationError('service_rate_pvt must be a non-negative integer string (BigInt 18d)');
    }
  }
  if (rateUsdc !== undefined) {
    if (typeof rateUsdc !== 'number' || !Number.isFinite(rateUsdc) || rateUsdc < 0) {
      throw new ValidationError('service_rate_usdc must be a non-negative finite number');
    }
  }
}

// ─── Trust Metric Aggregation ───────────────────────────────────────────────

async function aggregateTrustMetrics(
  deps: CommonsDeps,
  walletId: string,
): Promise<{
  pe_count: number;
  promise_fulfillment_rate: number;
  court_record: CourtRecord;
  first_pe_date: number;
}> {
  // PE count is the LIVE count (the actor's running total, `actor_stats_v1` PE meter), never the deleted
  // stored per-wallet tally; governance_score is gone entirely.
  const walletDoc = await deps.db.collection('agent_wallets').doc(walletId).get();
  const walletData = walletDoc.exists ? walletDoc.data() : null;

  // PEs are attributed to an actor id. For an AGENT that key is `agent_wallets.agent_id`;
  // for a HUMAN there is no `agent_wallets` doc and the human's own user id IS the
  // Commons `walletId` (the profile doc id) — human PEs key on it directly. The
  // pre-fix `agentId ? ... : 0` returned 0 for every human profile regardless of
  // real activity. `countVisibleAgentPEs` is userId-generic (name is historical),
  // so both paths read the SAME single count source.
  const agentId = typeof walletData?.agent_id === 'string' ? walletData.agent_id : null;
  const peKeyUserId = agentId ?? walletId;
  const pe_count = await countVisibleAgentPEs(deps.db, peKeyUserId);
  const first_pe_date = walletData?.created_at ?? Date.now();

  // Promise fulfillment rate
  const promisesSnap = await deps.db.collection('promises')
    .where('borrower_wallet_id', '==', walletId)
    .limit(200)
    .get();

  let fulfilled = 0;
  let defaulted = 0;
  promisesSnap.docs.forEach(doc => {
    const d = doc.data();
    if (d.status === 'settled') fulfilled++;
    if (d.status === 'defaulted') defaulted++;
  });
  const total = fulfilled + defaulted;
  const promise_fulfillment_rate = total > 0 ? fulfilled / total : 1.0;

  // Court record
  const court_record: CourtRecord = {
    cases_as_plaintiff: 0,
    cases_as_defendant: 0,
    cases_as_arbitrator: 0,
    wins: 0,
    losses: 0,
    arbitrations_completed: 0,
    slashing_events: 0,
  };

  const disputesSnap = await deps.db.collection('court_disputes')
    .where('parties', 'array-contains', walletId)
    .limit(200)
    .get();

  disputesSnap.docs.forEach(doc => {
    const d = doc.data();
    if (d.depositor_wallet_id === walletId) court_record.cases_as_plaintiff++;
    if (d.recipient_wallet_id === walletId) court_record.cases_as_defendant++;
    if (d.status === 'resolved') {
      if (d.winner_wallet_id === walletId) court_record.wins++;
      else if (d.depositor_wallet_id === walletId || d.recipient_wallet_id === walletId) {
        court_record.losses++;
      }
    }
  });

  const arbitratorDoc = await deps.db.collection('arbitrators').doc(walletId).get();
  if (arbitratorDoc.exists) {
    const ad = arbitratorDoc.data();
    court_record.cases_as_arbitrator = ad?.cases_served ?? 0;
    court_record.arbitrations_completed = ad?.cases_completed ?? 0;
  }

  return { pe_count, promise_fulfillment_rate, court_record, first_pe_date };
}

// ─── Registration ───────────────────────────────────────────────────────────

/**
 * Joining the Commons = reachable. An agent in the Commons can always be messaged:
 * every join publishes its thread message key in the same step (`message_pubkey`), or finds one already
 * published. Refused otherwise, before any profile is written, so no agent wallet is ever in the
 * Commons without a key. Agents derive the key from their wallet key; the relay never sees its secret.
 */
export const COMMONS_MESSAGE_KEY_REQUIRED =
  'message_key_required: an agent joins the Commons with its thread message key. Send message_pubkey '
  + '(deriveMessageKeyPair(walletPrivateKey).pubkeyB64u) with the join, or publish it first at PUT /v1/threads/keys';

/** Publish the supplied agent message key, or confirm one is on file; throws COMMONS_MESSAGE_KEY_REQUIRED. */
async function ensureAgentMessageKey(deps: CommonsDeps, walletId: string, messagePubkey: unknown): Promise<void> {
  if (messagePubkey !== undefined && messagePubkey !== null) {
    if (!isMessagePubkey(messagePubkey)) {
      throw new ValidationError('message_pubkey must be a 32-byte x25519 public key, base64url (43 chars)');
    }
    await publishMessageKey(deps.db, { kind: 'agent', id: walletId }, messagePubkey);
    return;
  }
  if (await readMessageKey(deps.db, walletId)) return;
  throw new ValidationError(COMMONS_MESSAGE_KEY_REQUIRED);
}

export async function registerForCommons(
  deps: CommonsDeps,
  walletId: string,
  agentId: string,
  actorAddress: string | null,
  body: RegisterRequest,
  options?: {
    join_method?: 'autonomous' | 'biometric';
    device_attestation?: string | null;
  },
): Promise<{ profile: CommonsProfile; registration_pe_id: string }> {
  // Test-platform wallets are valid internal actors, but never public Commons
  // participants. Refuse at the canonical writer so neither /register nor a
  // future caller can create a public profile or a commons_profile_created PE.
  if (body.participant_type === 'agent') {
    const agentWalletDoc = await deps.db.collection('agent_wallets').doc(walletId).get();
    if (!agentWalletDoc.exists) {
      throw new ValidationError('Agent wallet not found');
    }
    if (isTestPlatformWallet(agentWalletDoc.data())) {
      throw new ValidationError(COMMONS_TEST_PLATFORM_EXCLUSION);
    }
  }

  // Rate limit
  const rl = await deps.cache.checkRateLimit(
    `rl:commons:register:${walletId}`,
    L.RATE_LIMIT_REGISTRATION,
    60,
  );
  if (!rl.allowed) {
    throw new ValidationError(`Rate limit exceeded. Retry after ${rl.retryAfter}s`);
  }

  // Validate display name
  if (!body.display_name || body.display_name.trim().length === 0) {
    throw new ValidationError('display_name is required');
  }
  if (body.display_name.length > L.MAX_DISPLAY_NAME_LENGTH) {
    throw new ValidationError(`display_name must be ${L.MAX_DISPLAY_NAME_LENGTH} characters or fewer`);
  }
  if (body.bio && body.bio.length > L.MAX_BIO_LENGTH) {
    throw new ValidationError(`bio must be ${L.MAX_BIO_LENGTH} characters or fewer`);
  }
  if (body.skills && body.skills.length > L.MAX_SKILLS_COUNT) {
    throw new ValidationError(`Maximum ${L.MAX_SKILLS_COUNT} skills`);
  }
  // F30: avatar_url must be an https URL within the length cap.
  validateAvatarUrl(body.avatar_url);

  // Workstream 3: validate optional service rates.
  validateServiceRates(body.service_rate_pvt, body.service_rate_usdc);

  // HIGH-5 (Wave 4): leave + rejoin must preserve counters. We accept
  // an existing profile only when its status is 'inactive' (i.e. the
  // wallet has previously left). Active profiles still 409.
  const existingDoc = await deps.db
    .collection(COMMONS_COLLECTIONS.PROFILES)
    .doc(walletId)
    .get();
  let existingProfile: CommonsProfile | null = null;
  if (existingDoc.exists) {
    existingProfile = existingDoc.data() as CommonsProfile;
    if (existingProfile.status !== 'inactive') {
      throw new ValidationError('Already registered on the Commons');
    }
  }

  // Aggregate trust metrics from existing PE history
  const metrics = await aggregateTrustMetrics(deps, walletId);
  // HIGH-8: live attestation tier from active devices.
  const tierResult = await computeWalletAttestationTier(deps, walletId);

  // Reachable before visible: the key is on file before the profile is written.
  if (body.participant_type === 'agent') {
    await ensureAgentMessageKey(deps, walletId, body.message_pubkey);
  }

  // Determine verification level
  let identity_verification_level: IdentityVerificationLevel = 'device_attested';
  // Agents connected through relay inherit owner's attestation
  if (body.participant_type === 'human') {
    identity_verification_level = 'biometric_enrolled';
  }

  // Pull agent directory data if agent
  let capabilities = body.capabilities;
  let agent_framework: string | undefined;
  // Item 5: an agent the linked human has named joins under the human's name, whatever it sends.
  let displayName = body.display_name.trim();
  if (body.participant_type === 'agent') {
    const dirDoc = await deps.db.collection('agent_directory').doc(walletId).get();
    if (dirDoc.exists) {
      const dirData = dirDoc.data();
      capabilities = capabilities || dirData?.capabilities;
      agent_framework = dirData?.agent_framework;
    }
    const agentWalletSnap = await deps.db.collection('agent_wallets').doc(walletId).get();
    const agentWalletData = agentWalletSnap.exists ? agentWalletSnap.data() : undefined;
    if (isDisplayNameSetByHuman(agentWalletData)
      && typeof agentWalletData?.display_name === 'string'
      && agentWalletData.display_name.trim().length > 0) {
      displayName = agentWalletData.display_name;
    }
  }

  const now = Date.now();
  const baseProfile: CommonsProfile = existingProfile ?? {
    wallet_id: walletId,
    participant_type: body.participant_type,
    display_name: displayName,
    avatar_url: body.avatar_url,
    bio: body.bio?.trim(),
    attestation_tier: tierResult.tier,
    identity_verification_level,
    agent_framework,
    capabilities,
    skills: body.skills,
    location: body.location,
    languages: body.languages,
    availability: 'available',
    service_rate_pvt: body.service_rate_pvt && body.service_rate_pvt !== '' ? body.service_rate_pvt : undefined,
    service_rate_usdc: body.service_rate_usdc,
    pe_count: metrics.pe_count,
    promise_fulfillment_rate: metrics.promise_fulfillment_rate,
    court_record: metrics.court_record,
    commons_join_date: now,
    first_pe_date: metrics.first_pe_date,
    human_jobs_completed: 0,
    human_jobs_avg_rating: 0,
    human_jobs_categories: [],
    human_jobs_posted: 0,
    human_jobs_avg_human_rating: 0,
    forum_post_count: 0,
    forum_upvotes_received: 0,
    published_pe_count: 0,
    status: 'active',
    created_at: now,
    updated_at: now,
  };

  // When rehydrating an inactive profile, refresh the trust-metric and
  // tier fields and clear the inactive flag while preserving the
  // earned counters (forum_post_count, human_jobs_*, etc.).
  const profile: CommonsProfile = existingProfile
    ? {
        ...baseProfile,
        // Keep counters as-is; refresh derivable fields.
        display_name: displayName,
        bio: body.bio?.trim() ?? baseProfile.bio,
        avatar_url: body.avatar_url ?? baseProfile.avatar_url,
        attestation_tier: tierResult.tier,
        identity_verification_level,
        agent_framework,
        capabilities: capabilities ?? baseProfile.capabilities,
        skills: body.skills ?? baseProfile.skills,
        location: body.location ?? baseProfile.location,
        languages: body.languages ?? baseProfile.languages,
        pe_count: metrics.pe_count,
        promise_fulfillment_rate: metrics.promise_fulfillment_rate,
        court_record: metrics.court_record,
        availability: 'available',
        status: 'active',
        updated_at: now,
        // Type allows left_at on inactive; we don't carry it forward.
      }
    : baseProfile;
  // Strip left_at if present from the rehydrated record so the
  // schema-clean Firestore doc doesn't carry stale time.
  delete (profile as { left_at?: number }).left_at;

  await deps.db.collection(COMMONS_COLLECTIONS.PROFILES).doc(walletId).set({ ...profile, network_class: await ownerParticipantClass(deps.db, walletId) });

  // HIGH-5: rehydrate the published PE projections that leaveCommons
  // flagged inactive - flip their flag back so consumers stop hiding them.
  if (existingProfile) {
    try {
      const flaggedSnap = await deps.db
        .collection(COMMONS_COLLECTIONS.PUBLISHED_PES)
        .where('published_by', '==', walletId)
        .get();
      const batch = deps.db.batch();
      flaggedSnap.docs.forEach((doc) => batch.update(doc.ref, {
        profile_inactive: false,
        profile_reactivated_at: now,
      }));
      if (!flaggedSnap.empty) await batch.commit();
    } catch (err) {
      console.warn('[Commons] PE re-flag on rejoin failed', err);
    }
  }

  // Determine join method: server-side override for agents ensures
  // the PE always accurately reflects how the join occurred.
  const join_method: CommonsJoinMethod =
    body.participant_type === 'agent' ? 'autonomous' : (body.join_method ?? 'biometric');

  // Generate PE
  const { peId } = await generatePE(deps, {
    walletId,
    agentId,
    actorAddress,
    actionType: 'commons_profile_created',
    metadata: {
      display_name: profile.display_name,
      participant_type: profile.participant_type,
      identity_verification_level: profile.identity_verification_level,
      join_method,
    },
  });

  return { profile, registration_pe_id: peId };
}

// ─── Quick Join (alias for register with auto-population) ───────────────────

export async function joinCommons(
  deps: CommonsDeps,
  walletId: string,
  agentId: string,
  actorAddress: string | null,
  body: JoinRequest,
): Promise<JoinCommonsResult> {
  // Determine participant type from wallet data.
  // Agent wallets exist in the `agent_wallets` collection; human wallets do not.
  const walletDoc = await deps.db.collection('agent_wallets').doc(walletId).get();
  const walletData = walletDoc.exists ? walletDoc.data() : undefined;
  const participantType = walletDoc.exists ? 'agent' : 'human';

  // Live smoke/integration agents deliberately carry platform:'test'. Their
  // bootstrap should continue cleanly, but joining is an internal no-op: no
  // public profile, no public activity counter, and no registration PE. This
  // is checked before the idempotent-profile branch so a leaked legacy profile
  // can never make a test actor look publicly joined again.
  if (participantType === 'agent' && isTestPlatformWallet(walletData)) {
    return {
      profile: null,
      registration_pe_id: '',
      already_member: false,
      excluded_test: true,
    };
  }

  // Idempotent autonomous join (the agent self-service invariant): an agent that
  // ALREADY holds an active Commons profile and re-runs join gets a clean no-op
  // — its existing profile back, NO second `commons_profile_created` PE, and
  // never a 400. This is what makes the default-on bootstrap step, the
  // `join-commons` verb, and AgentBank.joinCommons all safely re-runnable. It is
  // scoped to agents; the human biometric path keeps its existing "Already
  // registered" 400 through registerForCommons. An INACTIVE profile (the agent
  // previously left the Commons) is deliberately NOT a no-op: it falls through
  // to registerForCommons, which rehydrates it and re-emits the join PE.
  if (participantType === 'agent') {
    const existing = await deps.db
      .collection(COMMONS_COLLECTIONS.PROFILES)
      .doc(walletId)
      .get();
    if (existing.exists) {
      const existingProfile = existing.data() as CommonsProfile;
      if (existingProfile.status !== 'inactive') {
        // A re-join is how an agent already in the Commons repairs a missing or rotated key.
        if (body.message_pubkey !== undefined && body.message_pubkey !== null) {
          await ensureAgentMessageKey(deps, walletId, body.message_pubkey);
        }
        return { profile: existingProfile, registration_pe_id: '', already_member: true };
      }
    }
  }

  // Agent wallets always join autonomously - no biometric, no human approval required.
  // Human wallets default to 'biometric' unless the caller explicitly states otherwise.
  const join_method: CommonsJoinMethod =
    participantType === 'agent' ? 'autonomous' : (body.join_method ?? 'biometric');

  // Zero-config autonomous join: when an agent omits display_name, default it to
  // the name it registered its wallet under (agent_wallets.display_name), so an
  // agent need not carry its own display name to appear in the town square. The
  // human path always supplies its own display_name from the app.
  const registeredName = typeof walletData?.display_name === 'string' ? walletData.display_name : '';
  const display_name =
    participantType === 'agent'
      && (!body.display_name || body.display_name.trim().length === 0)
      && registeredName.trim().length > 0
      ? registeredName
      : body.display_name;

  return registerForCommons(deps, walletId, agentId, actorAddress, {
    display_name,
    participant_type: participantType,
    bio: body.bio,
    avatar_url: body.avatar_url,
    join_method,
    message_pubkey: body.message_pubkey,
  });
}

// ─── Leave Commons ──────────────────────────────────────────────────────────

export async function leaveCommons(
  deps: CommonsDeps,
  walletId: string,
): Promise<void> {
  const profileDoc = await deps.db
    .collection(COMMONS_COLLECTIONS.PROFILES)
    .doc(walletId)
    .get();
  if (!profileDoc.exists) {
    throw new NotFoundError('Not registered on the Commons');
  }

  // HIGH-5 (Wave 4): leave preserves state. Counters
  // (forum_post_count, human_jobs_completed, published_pe_count,
  // etc.) stay on the profile so a re-register doesn't reset them
  // - closing the leave/rejoin counter-wipe attack. Mark the doc
  // inactive and flag the published PEs so consumers can render
  // accordingly. Re-register flips both back via registerForCommons.
  const now = Date.now();
  const publishedSnap = await deps.db
    .collection(COMMONS_COLLECTIONS.PUBLISHED_PES)
    .where('published_by', '==', walletId)
    .get();

  const batch = deps.db.batch();
  publishedSnap.docs.forEach((doc) => batch.update(doc.ref, {
    profile_inactive: true,
    profile_left_at: now,
  }));
  batch.update(profileDoc.ref, {
    status: 'inactive',
    left_at: now,
    updated_at: now,
  });
  await batch.commit();
}

// ─── Update Profile ─────────────────────────────────────────────────────────

export async function updateProfile(
  deps: CommonsDeps,
  walletId: string,
  body: UpdateProfileRequest,
): Promise<CommonsProfile> {
  const profileDoc = await deps.db
    .collection(COMMONS_COLLECTIONS.PROFILES)
    .doc(walletId)
    .get();
  if (!profileDoc.exists) {
    throw new NotFoundError('Not registered on the Commons');
  }

  const updates: Record<string, unknown> = { updated_at: Date.now() };

  if (body.display_name !== undefined) {
    if (body.display_name.trim().length === 0) {
      throw new ValidationError('display_name cannot be empty');
    }
    if (body.display_name.length > L.MAX_DISPLAY_NAME_LENGTH) {
      throw new ValidationError(`display_name must be ${L.MAX_DISPLAY_NAME_LENGTH} characters or fewer`);
    }
    // Item 5: once the linked human has named this agent, the human's name holds everywhere —
    // the agent cannot rename its own profile to something else. The canonical flag lives on
    // agent_wallets (a human wallet has no such doc, so humans are unaffected). Re-sending the
    // SAME name is not a change and is allowed.
    const trimmedName = body.display_name.trim();
    const agentWalletSnap = await deps.db.collection('agent_wallets').doc(walletId).get();
    const agentWalletData = agentWalletSnap.exists ? agentWalletSnap.data() : undefined;
    if (isDisplayNameSetByHuman(agentWalletData) && trimmedName !== agentWalletData?.display_name) {
      throw new ValidationError('display_name_set_by_human');
    }
    updates.display_name = trimmedName;
  }
  if (body.bio !== undefined) {
    if (body.bio.length > L.MAX_BIO_LENGTH) {
      throw new ValidationError(`bio must be ${L.MAX_BIO_LENGTH} characters or fewer`);
    }
    updates.bio = body.bio.trim();
  }
  if (body.avatar_url !== undefined) {
    // F30: same validation as registration.
    validateAvatarUrl(body.avatar_url);
    updates.avatar_url = body.avatar_url;
  }
  if (body.skills !== undefined) {
    if (body.skills.length > L.MAX_SKILLS_COUNT) {
      throw new ValidationError(`Maximum ${L.MAX_SKILLS_COUNT} skills`);
    }
    updates.skills = body.skills;
  }
  if (body.capabilities !== undefined) {
    if (body.capabilities.length > L.MAX_CAPABILITIES_COUNT) {
      throw new ValidationError(`Maximum ${L.MAX_CAPABILITIES_COUNT} capabilities`);
    }
    updates.capabilities = body.capabilities;
  }
  if (body.location !== undefined) updates.location = body.location;
  if (body.languages !== undefined) updates.languages = body.languages;
  if (body.availability !== undefined) updates.availability = body.availability;

  // Workstream 3: service rate updates. Send empty string '' or 0 to clear.
  if (body.service_rate_pvt !== undefined || body.service_rate_usdc !== undefined) {
    validateServiceRates(body.service_rate_pvt, body.service_rate_usdc);
    if (body.service_rate_pvt !== undefined) {
      const { FieldValue } = await import('firebase-admin/firestore');
      updates.service_rate_pvt = body.service_rate_pvt === ''
        ? FieldValue.delete()
        : body.service_rate_pvt;
    }
    if (body.service_rate_usdc !== undefined) {
      const { FieldValue } = await import('firebase-admin/firestore');
      updates.service_rate_usdc = body.service_rate_usdc === 0
        ? FieldValue.delete()
        : body.service_rate_usdc;
    }
  }

  await deps.db
    .collection(COMMONS_COLLECTIONS.PROFILES)
    .doc(walletId)
    .update(updates);

  const updated = await deps.db
    .collection(COMMONS_COLLECTIONS.PROFILES)
    .doc(walletId)
    .get();
  return updated.data() as CommonsProfile;
}

// ─── Get Profile (Public) ───────────────────────────────────────────────────

export async function getProfile(
  deps: CommonsDeps,
  walletId: string,
): Promise<CommonsProfile> {
  const profileDoc = await deps.db
    .collection(COMMONS_COLLECTIONS.PROFILES)
    .doc(walletId)
    .get();
  if (!profileDoc.exists) {
    throw new NotFoundError('Profile not found');
  }
  const profile = profileDoc.data() as CommonsProfile;
  if (isHiddenPrelaunchTest(profile)) throw new NotFoundError('Profile not found');
  let walletDoc: FirebaseFirestore.DocumentSnapshot;
  try {
    walletDoc = await deps.db.collection('agent_wallets').doc(walletId).get();
  } catch (err) {
    // Public agent visibility fails closed when the authoritative wallet marker
    // cannot be read. A human profile has no agent-wallet document by design and
    // may still fall back to its stored display count on a transient read error.
    if (profile.participant_type === 'agent') throw err;
    console.warn('[Commons] agent-wallet visibility read failed for human profile', err);
    return profile;
  }
  if (profile.participant_type === 'agent') {
    if (!walletDoc.exists || isTestPlatformWallet(walletDoc.data())) {
      throw new NotFoundError('Profile not found');
    }
  }
  // pe_count is a DISPLAY value stored only at register/rejoin time. Recompute it
  // live so a profile registered before the human-count fix (or with any activity
  // since it last registered) shows the true visible-PE count instead of the stale
  // snapshot (which was 0 for every human). Same userId resolution as
  // aggregateTrustMetrics: agent → agent_id, human → walletId. Read-only display,
  // so fall back to the stored snapshot on a transient read failure.
  try {
    const agentId =
      walletDoc.exists && typeof walletDoc.data()?.agent_id === 'string'
        ? (walletDoc.data()!.agent_id as string)
        : null;
    profile.pe_count = await countVisibleAgentPEs(deps.db, agentId ?? walletId);
  } catch (err) {
    console.warn('[Commons] live pe_count refresh failed; using stored snapshot', err);
  }
  return profile;
}

// ─── Browse Registry ────────────────────────────────────────────────────────

/**
 * The stored `pe_count` is a snapshot taken at register/rejoin time, so a
 * long-lived agent listed in the registry read as its join-day count while its
 * profile page (getProfile) showed the live count. Resolve the same live count
 * getProfile does (agent → agent_id, human → walletId). Display-only: a read
 * failure keeps the stored snapshot.
 */
async function livePeCount(deps: CommonsDeps, profile: CommonsProfile): Promise<number> {
  try {
    const walletDoc = await deps.db.collection('agent_wallets').doc(profile.wallet_id).get();
    const agentId =
      walletDoc.exists && typeof walletDoc.data()?.agent_id === 'string'
        ? (walletDoc.data()!.agent_id as string)
        : null;
    return await countVisibleAgentPEs(deps.db, agentId ?? profile.wallet_id);
  } catch {
    return profile.pe_count;
  }
}

const LIVE_COUNT_CONCURRENCY = 25;

async function withLivePeCounts(deps: CommonsDeps, profiles: CommonsProfile[]): Promise<CommonsProfile[]> {
  const out: CommonsProfile[] = [];
  for (let i = 0; i < profiles.length; i += LIVE_COUNT_CONCURRENCY) {
    const chunk = profiles.slice(i, i + LIVE_COUNT_CONCURRENCY);
    const counts = await Promise.all(chunk.map((p) => livePeCount(deps, p)));
    chunk.forEach((p, j) => out.push({ ...p, pe_count: counts[j] }));
  }
  return out;
}

export async function browseRegistry(
  deps: CommonsDeps,
  options: {
    participant_type?: string;
    capability?: string;
    /** Free text (the app's search box): a case-insensitive substring of the name, bio or a capability. */
    q?: string;
    attestation_tier?: string;
    availability?: string;
    sort_by?: string;
    page_size?: number;
    offset?: number;
  },
): Promise<{ profiles: CommonsProfile[]; total: number }> {
  const pageSize = Math.min(options.page_size || L.REGISTRY_PAGE_SIZE, 100);
  const offset = options.offset && options.offset > 0 ? options.offset : 0;

  // Only `status` + the sort field go to Firestore — that pair is covered by the
  // existing [status, pe_count] / [status, commons_join_date] composite indexes.
  // EVERY optional filter (participant_type, capability, attestation_tier,
  // availability) is applied in memory, the same way the sibling agent directory
  // (directory.ts) does. This removes the deep-filter 500s: an arbitrary
  // combination of optional equality/array filters no longer needs a
  // per-combination composite index that was never built. Bounded by a candidate
  // cap so a browse never scans the whole collection. the governance_score
  // sort key and the min_governance_score filter are gone with the field; the
  // default sort is newest.
  const sortField = options.sort_by === 'pe_count' ? 'pe_count'
    : 'commons_join_date';

  const snap = await deps.db
    .collection(COMMONS_COLLECTIONS.PROFILES)
    .where('status', '==', 'active')
    .orderBy(sortField, 'desc')
    .limit(L.REGISTRY_CANDIDATE_CAP)
    .get();

  let profiles = snap.docs.map(d => d.data() as CommonsProfile)
    .filter(p => !isHiddenPrelaunchTest(p));

  if (options.participant_type) {
    profiles = profiles.filter(p => p.participant_type === options.participant_type);
  }
  if (options.capability) {
    profiles = profiles.filter(p => Array.isArray(p.capabilities) && p.capabilities.includes(options.capability!));
  }
  const needle = typeof options.q === 'string' ? options.q.trim().toLowerCase().slice(0, 100) : '';
  if (needle.length > 0) {
    // In memory like every other optional filter (the candidate set is already bounded).
    profiles = profiles.filter(p => {
      const haystack = [p.display_name, p.bio ?? '', ...(Array.isArray(p.capabilities) ? p.capabilities : [])];
      return haystack.some(v => typeof v === 'string' && v.toLowerCase().includes(needle));
    });
  }
  if (options.attestation_tier) {
    profiles = profiles.filter(p => p.attestation_tier === options.attestation_tier);
  }
  if (options.availability) {
    profiles = profiles.filter(p => p.availability === options.availability);
  }

  // `total` is the filtered candidate count (bounded by the cap); paginate in memory
  // so offset + page_size are honoured after filtering, not before.
  const total = profiles.length;

  // Show live record counts. A pe_count sort must rank by the live count, so it
  // refreshes every filtered candidate (bounded by the cap) before paging; the
  // default (newest) sort only refreshes the page it returns.
  if (sortField === 'pe_count') {
    const live = await withLivePeCounts(deps, profiles);
    live.sort((a, b) => (b.pe_count ?? 0) - (a.pe_count ?? 0));
    return { profiles: live.slice(offset, offset + pageSize), total };
  }
  const paged = await withLivePeCounts(deps, profiles.slice(offset, offset + pageSize));

  return { profiles: paged, total };
}

// ─── Get Published PEs ──────────────────────────────────────────────────────

export async function getPublishedPEs(
  deps: CommonsDeps,
  walletId: string,
  options: {
    institution?: string;
    page_size?: number;
    offset?: number;
  },
): Promise<{ projections: object[]; total: number }> {
  const pageSize = Math.min(options.page_size || 50, 100);

  let query = deps.db
    .collection(COMMONS_COLLECTIONS.PUBLISHED_PES)
    .where('published_by', '==', walletId) as FirebaseFirestore.Query;

  if (options.institution) {
    query = query.where('institution', '==', options.institution);
  }

  query = query.orderBy('published_at', 'desc').limit(pageSize);
  if (options.offset) {
    query = query.offset(options.offset);
  }

  const snap = await query.get();
  const projections = snap.docs.map(d => publicProjection(d.data() as import('./types').PEPublicProjection));

  return { projections, total: projections.length };
}
