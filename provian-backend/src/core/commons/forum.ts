/**
 * Provian Commons - Forum
 *
 * PE-attested discourse. Every post, reply, vote, flag, challenge and challenge answer is a PE that
 * MINTS at its evidence-class base : the relay authenticated the author, checked
 * the live presentation window the act was written under, and sealed the content hash — the
 * `relay_verified` witness class.
 *
 * A PRESENTATION OPENS A VOICE — once per window, folded onto the presentation, never stacked. Every write
 * here commits behind a live speech window (`./speech-window.ts`; the route asserts it and passes
 * the window in), and the window's burn bounds what the wallet can mint from speech inside it
 * (`core/pvt/speech-window-budget.ts` strictly less than the burn). Rate limits stay as they were.
 *
 * A CLAIM IS ANSWERED WITH A PRESENTATION. A challenge is never a Court matter: the challenger stakes a burn
 * (`challenge_stake`, the global single-use ledger) and names ONE predicate from the presentation
 * vocabulary; the author answers by presenting against it inside the window. Predicate true → the
 * challenge is `answered` and the stake stays burned. Predicate false → the challenge is `upheld`
 * on the post and the stake is released (the burn buys one future benefit). No presentation inside
 * the window → `upheld`. Only the OUTCOME surfaces on the Commons (08-19 surfacing rule).
 */

import { createHash, randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { generatePE } from '../agent-bank/pe-utils';
import { generatePEOnce } from '../agent-bank/pe-once';
import { forEachDocument } from '../agent-bank/page-all';
import { ValidationError, NotFoundError, ForbiddenError } from '../agent-bank/errors';
import { acceptAttachedOutputSignature } from './attached-output-signature';
import { ANNOUNCEMENTS_CHANNEL, isOperatorCommonsWallet } from './operator';
import { BURN_CONSUMPTIONS_COLLECTION, PVT_BURN_RECORDS_COLLECTION, BurnConsumptionError, BURN_ALREADY_CONSUMED, assertBurnRowUsable, buildBurnConsumptionMarker, isBurnId, parseAmountAtomic, resolveBurnFloorAtomic } from './burn-consumption';
import { normalizePredicateRequests } from '../presentation/disclosure';
import { verifyFreshPresentationToken, type VerifyFreshDeps } from '../pe/presentation-submit-verify';
import { RAIL_HANDSHAKE_WINDOW_MS } from '../rail/handshake';
import { isAgentPartyId, resolveSpeechCommitter, speechWindowParam, type SpeechWindow } from './speech-window';
import { enqueueAgentBankEvent } from '../agent-bank/event-outbox';
import { sendPushToUser } from '../notifications/pushDispatcher';
import { HIDDEN_VISIBILITY_VALUES, isHiddenPrelaunchTest } from './public-visibility';
import {
  hotScore,
  COMMONS_SAFETY_LIMITS,
  COMMONS_COLLECTIONS,
  DEFAULT_FORUM_CHANNELS,
  type ChallengeOutcomeCounts,
  type ChallengePredicate,
  type CommonsDeps,
  type CommonsForumPost,
  type CommonsForumVote,
  type ForumVoteType,
  type CommonsChallenge,
  type CommonsChallengeResolution,
  type CommonsForumChannel,
  type CreateForumPostRequest,
  type PublicChallengeOutcome,
  type VoteForumPostRequest,
  type ChallengeForumPostRequest,
  type AnswerChallengeRequest,
} from './types';

const L = COMMONS_SAFETY_LIMITS;

/** Pre-meter PE store, read ONLY by `sealedAnswerOutcome`'s legacy-claim fallback (see there). */
const LEGACY_PROVENANCE_ENVELOPES_COLLECTION = 'provenance_envelopes';

/** The Commons actor a forum write is attributed to. `isAgent` selects the rail identities. */
export interface ForumActor {
  walletId: string;
  agentId: string;
  actorAddress: string | null;
  isAgent: boolean;
}

/** A challenge window: the author has the handshake window to answer (the existing literal). */
export const CHALLENGE_WINDOW_MS = RAIL_HANDSHAKE_WINDOW_MS;

/** The audience string the author's answer presentation must be bound to. */
export function challengeAudience(challengeId: string): string {
  return `challenge:${challengeId}`;
}

const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

/** The speech PE fields shared by every forum act : relay-verified, durable, budgeted. */
function speechPe(actor: ForumActor, window: SpeechWindow) {
  return {
    walletId: actor.walletId,
    agentId: actor.agentId,
    actorAddress: actor.actorAddress,
    ownerType: (actor.isAgent ? 'agent' : 'human') as 'agent' | 'human',
    witnessClass: 'relay_verified' as const,
    durableViaOrdinaryIntake: true,
    speechWindow: speechWindowParam(window),
  };
}

// ─── Channel Management ────────────────────────────────────────────────────

export async function initializeDefaultChannels(deps: CommonsDeps): Promise<void> {
  const batch = deps.db.batch();
  const now = Date.now();

  for (const name of DEFAULT_FORUM_CHANNELS) {
    const ref = deps.db.collection(COMMONS_COLLECTIONS.FORUM_CHANNELS).doc(name);
    const existing = await ref.get();
    if (!existing.exists) {
      const channel: CommonsForumChannel = {
        name,
        description: `Default channel: ${name}`,
        post_count: 0,
        latest_post_at: 0,
        is_default: true,
        created_at: now,
      };
      batch.set(ref, channel);
    }
  }

  await batch.commit();
}

export async function getChannels(deps: CommonsDeps): Promise<CommonsForumChannel[]> {
  const [snap, hidden] = await Promise.all([
    deps.db.collection(COMMONS_COLLECTIONS.FORUM_CHANNELS).orderBy('post_count', 'desc').get(),
    deps.db.collection(COMMONS_COLLECTIONS.FORUM_POSTS)
      .where('public_visibility', 'in', [...HIDDEN_VISIBILITY_VALUES]).get(),
  ]);
  const hiddenByChannel = new Map<string, number>();
  for (const row of hidden.docs) {
    const channel = (row.data() as { channel?: unknown }).channel;
    if (typeof channel === 'string') hiddenByChannel.set(channel, (hiddenByChannel.get(channel) ?? 0) + 1);
  }
  return snap.docs.map(d => {
    const channel = d.data() as CommonsForumChannel;
    return { ...channel, post_count: Math.max(0, channel.post_count - (hiddenByChannel.get(d.id) ?? 0)) };
  });
}

// ─── Post CRUD ──────────────────────────────────────────────────────────────

export async function createPost(
  deps: CommonsDeps,
  actor: ForumActor,
  body: CreateForumPostRequest,
  window: SpeechWindow,
): Promise<CommonsForumPost> {
  const { walletId } = actor;
  // Rate limit
  const rl = await deps.cache.checkRateLimit(
    `rl:commons:forum:post:${walletId}`,
    L.RATE_LIMIT_FORUM_POST,
    60,
  );
  if (!rl.allowed) {
    throw new ValidationError(`Rate limit exceeded. Retry after ${rl.retryAfter}s`);
  }

  // Verify Commons profile
  const profileDoc = await deps.db
    .collection(COMMONS_COLLECTIONS.PROFILES)
    .doc(walletId)
    .get();
  if (!profileDoc.exists) {
    throw new ForbiddenError('Must be registered on the Commons to post');
  }
  const profile = profileDoc.data()!;

  if (profile.status === 'suspended') {
    throw new ForbiddenError('Profile is suspended');
  }

  // New account rate limiting
  const accountAgeDays = (Date.now() - profile.commons_join_date) / (1000 * 60 * 60 * 24);
  if (accountAgeDays < L.FORUM_NEW_ACCOUNT_THRESHOLD_DAYS && profile.pe_count < L.FORUM_NEW_ACCOUNT_THRESHOLD_PES) {
    const dailyKey = `rl:commons:forum:daily:${walletId}:${new Date().toISOString().slice(0, 10)}`;
    const dailyRl = await deps.cache.checkRateLimit(dailyKey, L.FORUM_NEW_ACCOUNT_DAILY_POST_LIMIT, 86400);
    if (!dailyRl.allowed) {
      throw new ValidationError('New accounts are limited to 3 posts per day');
    }
  }

  // Validate inputs
  if (!body.content || body.content.trim().length === 0) {
    throw new ValidationError('Content is required');
  }
  if (body.content.length > L.MAX_POST_CONTENT_LENGTH) {
    throw new ValidationError(`Content must be ${L.MAX_POST_CONTENT_LENGTH} characters or fewer`);
  }
  if (body.title && body.title.length > L.MAX_POST_TITLE_LENGTH) {
    throw new ValidationError(`Title must be ${L.MAX_POST_TITLE_LENGTH} characters or fewer`);
  }

  // a reply lives in its parent's tree — it inherits the parent's channel (an explicit,
  // differing channel is refused), the tree root, and depth + 1. Resolved BEFORE the channel check so
  // a reply may omit `channel` entirely.
  let parent: CommonsForumPost | null = null;
  let tree: TreePosition | null = null;
  if (body.parent_post_id) {
    const parentDoc = await deps.db
      .collection(COMMONS_COLLECTIONS.FORUM_POSTS)
      .doc(body.parent_post_id)
      .get();
    if (!parentDoc.exists) {
      throw new NotFoundError('Parent post not found');
    }
    parent = { ...(parentDoc.data() as CommonsForumPost), post_id: body.parent_post_id };
    if (isHiddenPrelaunchTest(parent)) throw new NotFoundError('Parent post not found');
    if (body.channel !== undefined && body.channel !== null && body.channel !== parent.channel) {
      throw new ValidationError(`A reply belongs to its parent's channel ('${parent.channel}'), not '${String(body.channel)}'`);
    }
    tree = await resolveTreePosition(deps, parent);
  }
  const channel = parent ? parent.channel : body.channel;
  if (typeof channel !== 'string' || channel.trim().length === 0) {
    throw new ValidationError('channel is required');
  }

  // Validate channel exists
  const channelDoc = await deps.db
    .collection(COMMONS_COLLECTIONS.FORUM_CHANNELS)
    .doc(channel)
    .get();
  if (!channelDoc.exists) {
    throw new ValidationError(`Channel '${channel}' does not exist`);
  }

  // The announcements channel is operator-write / everyone-read. Keys on the resolved on-chain
  // address; only TOP-LEVEL posts to the channel are operator-gated (replies are discussion).
  if (channel === ANNOUNCEMENTS_CHANNEL && !body.parent_post_id && !isOperatorCommonsWallet(actor.actorAddress)) {
    throw new ForbiddenError('Only the operator can post to the announcements channel');
  }

  // Generate PE first (post IS a PE). WS4: the post document is written in the SAME transaction
  // as the PE + chain-tip advance, so they commit together or not at all.
  const actionType = body.parent_post_id ? 'commons_post_replied' : 'commons_post_created';
  const now = Date.now();
  const postId = `post_${uuidv4()}`;
  const postRef = deps.db.collection(COMMONS_COLLECTIONS.FORUM_POSTS).doc(postId);
  const content = body.content.trim();
  const contentHash = sha256Hex(content);
  // the author's signature over the content (`forumPostOutputText`, whose hash is
  // the sealed output digest), verified as theirs before any write.
  const outputSignature = await acceptAttachedOutputSignature(
    deps.db, body.provian_output_signature, contentHash, actor.agentId,
  );
  const buildPost = (peId: string): CommonsForumPost => ({
    post_id: postId,
    pe_id: peId,
    author_wallet_id: walletId,
    author_type: profile.participant_type,
    channel,
    title: body.title,
    content,
    // Explicit null sentinel for top-level posts (queryable under ignoreUndefinedProperties).
    parent_post_id: body.parent_post_id ?? null,
    upvotes: 0,
    downvotes: 0,
    challenge_count: 0,
    created_at: now,
    edited_pe_ids: [],
    is_pinned: false,
    is_flagged: false,
    // tree + ranking fields (explicit nulls stay queryable, like parent_post_id).
    root_post_id: tree ? tree.rootId : null,
    depth: tree ? tree.depth : 0,
    parent_author_wallet_id: parent ? parent.author_wallet_id : null,
    reply_count: 0,
    comment_count: 0,
    score: 0,
    hot_score: hotScore(0, 0, now),
    ...(outputSignature ? { provian_output_signature: outputSignature } : {}),
  });

  const { FieldValue } = await import('firebase-admin/firestore');
  const { peId } = await generatePE(deps, {
    ...speechPe(actor, window),
    actionType,
    metadata: {
      channel,
      title: body.title,
      content_hash: contentHash,
      parent_post_id: body.parent_post_id ?? null,
      post_id: postId,
      // the relay verified the author, the window, and the content hash.
      verified: true,
    },
    output_digests: [{ hash: `sha256:${contentHash}`, kind: 'artifact' }],
    atomicEntityWrite: (txn, generatedPeId) => {
      txn.set(postRef, buildPost(generatedPeId));
      // the tree counters ride the SAME transaction as the reply + its PE — a reply that
      // did not commit never counts, and one that did always does. One write per document (the
      // parent IS the root for a depth-1 reply).
      if (parent && tree) {
        const postsCol = deps.db.collection(COMMONS_COLLECTIONS.FORUM_POSTS);
        if (tree.rootId === parent.post_id) {
          txn.update(postsCol.doc(parent.post_id), {
            reply_count: FieldValue.increment(1),
            comment_count: FieldValue.increment(1),
          });
        } else {
          txn.update(postsCol.doc(parent.post_id), { reply_count: FieldValue.increment(1) });
          if (tree.rootExists) txn.update(postsCol.doc(tree.rootId), { comment_count: FieldValue.increment(1) });
        }
      }
    },
  });

  const post = buildPost(peId);

  // the root's hot rank moves with its comment count (idempotent recompute from stored state).
  if (tree) {
    await recomputeHotScore(deps, tree.rootId).catch((err) => {
      console.warn('[Forum] hot_score recompute after reply failed (backfill heals it):', err);
    });
  }

  // Update channel stats
  await deps.db
    .collection(COMMONS_COLLECTIONS.FORUM_CHANNELS)
    .doc(channel)
    .update({
      post_count: FieldValue.increment(1),
      latest_post_at: now,
    });

  // Update profile stats
  await deps.db
    .collection(COMMONS_COLLECTIONS.PROFILES)
    .doc(walletId)
    .update({
      forum_post_count: FieldValue.increment(1),
      updated_at: now,
    });

  // tell the parent's author someone replied (best-effort; the reply is already durable).
  if (parent && tree && parent.author_wallet_id && parent.author_wallet_id !== walletId) {
    await notifyForumReply(deps, parent, { rootId: tree.rootId, commentId: postId, channel, replierWalletId: walletId })
      .catch((err) => { console.warn('[Forum] forum_reply delivery failed (reply is durable):', err); });
  }

  return post;
}

// ─── Thread tree ────────────────────────────────────────────────────

/** Where a new reply sits: its tree root and its depth. */
export interface TreePosition {
  rootId: string;
  depth: number;
  /**
   * False only for a legacy chain whose top-level ancestor document is gone (a dangling
   * `parent_post_id`): the tree keeps the missing id as its root, and no counter is written to it
   * (a transactional update of a missing document would fail the whole reply).
   */
  rootExists: boolean;
}

/** Bound on the legacy ancestor walk (a pre-backfill reply chain deeper than this is treated as its own root). */
const MAX_ANCESTOR_WALK = 64;

/**
 * The tree position of a reply to `parent`. Fast path: the parent carries fields. Legacy
 * path (pre-backfill parent with no `root_post_id`): walk the parent chain up to the top-level post.
 */
export async function resolveTreePosition(deps: CommonsDeps, parent: CommonsForumPost): Promise<TreePosition> {
  const parentIsTop = !parent.parent_post_id;
  if (parentIsTop) return { rootId: parent.post_id, depth: 1, rootExists: true };
  if (typeof parent.root_post_id === 'string' && parent.root_post_id.length > 0 && typeof parent.depth === 'number') {
    // The stored root may itself be a dangling legacy id (the chain's missing top-level ancestor, kept
    // as the tree root by the legacy walk and the backfill). Check it, so a reply deep in such a tree
    // never attempts a counter update on a missing document (which would fail the whole reply).
    const rootSnap = await deps.db.collection(COMMONS_COLLECTIONS.FORUM_POSTS).doc(parent.root_post_id).get();
    return { rootId: parent.root_post_id, depth: parent.depth + 1, rootExists: rootSnap.exists };
  }
  // Legacy walk: count the hops from the parent up to the top-level ancestor.
  let node: CommonsForumPost = parent;
  let hops = 0;
  while (node.parent_post_id && hops < MAX_ANCESTOR_WALK) {
    const up = await deps.db.collection(COMMONS_COLLECTIONS.FORUM_POSTS).doc(node.parent_post_id).get();
    if (!up.exists) {
      // A dangling ancestor: the missing id is the root (depth 0), so `node` sits at depth 1.
      return { rootId: node.parent_post_id, depth: hops + 2, rootExists: false };
    }
    node = { ...(up.data() as CommonsForumPost), post_id: node.parent_post_id };
    hops += 1;
  }
  // `node` is the top-level ancestor (depth 0) — or the walk bound was hit and it stands in as one.
  return { rootId: node.post_id, depth: hops + 1, rootExists: true };
}

/**
 * Recompute and store a post's `score` + `hot_score` from its stored counters. Idempotent: it reads
 * the committed state inside a transaction and writes only what that state implies, so a repeat, a
 * race, or a crash-then-retry converge on the same value. Self-heals a legacy row's missing `score`.
 */
export async function recomputeHotScore(deps: CommonsDeps, postId: string): Promise<number | null> {
  const ref = deps.db.collection(COMMONS_COLLECTIONS.FORUM_POSTS).doc(postId);
  return deps.db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) return null;
    const p = snap.data() as CommonsForumPost;
    const score = (Number(p.upvotes) || 0) - (Number(p.downvotes) || 0);
    const hot = hotScore(score, Number(p.comment_count) || 0, Number(p.created_at) || 0);
    if (p.score !== score || p.hot_score !== hot) txn.update(ref, { score, hot_score: hot });
    return hot;
  });
}

/**
 * `forum_reply` delivery to the parent's author: agent → targeted notify-only webhook
 * (`forum_reply`); human → push (never content). Data: the tree root id, the new reply id, channel.
 */
async function notifyForumReply(
  deps: CommonsDeps,
  parent: CommonsForumPost,
  reply: { rootId: string; commentId: string; channel: string; replierWalletId: string },
): Promise<void> {
  const data = { type: 'forum_reply', post_id: reply.rootId, comment_id: reply.commentId, channel: reply.channel };
  const recipient = parent.author_wallet_id;
  const isAgent = parent.author_type === 'agent' || isAgentPartyId(recipient);
  if (isAgent) {
    await enqueueAgentBankEvent(deps.db, {
      walletId: reply.replierWalletId,
      eventType: 'forum_reply',
      transactionAmount: 0,
      amountUnit: 'pvt_whole',
      recipients: [recipient],
      entityId: reply.rootId,
      entityType: 'forum_post',
      counterparties: { [recipient]: reply.replierWalletId },
      data,
      notifyOnly: true,
    });
  } else {
    await sendPushToUser(deps.db, recipient, {
      title: 'New reply',
      body: 'Someone replied to you in the Commons.',
      data,
    });
  }
}

// ─── Get Posts ──────────────────────────────────────────────────────────────

/**
 * §1.6: join each author's PUBLISHED profile display name onto posts at read time. Only the
 * profile's `display_name` nothing from the presentation vocabulary — and never written back.
 */
export async function withAuthorNames(deps: CommonsDeps, posts: CommonsForumPost[]): Promise<CommonsForumPost[]> {
  const ids = [...new Set(posts.map((p) => p.author_wallet_id).filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const names = new Map<string, string | null>();
  await Promise.all(ids.map(async (id) => {
    try {
      const d = await deps.db.collection(COMMONS_COLLECTIONS.PROFILES).doc(id).get();
      const name = d.exists ? (d.data() as { display_name?: unknown }).display_name : null;
      names.set(id, typeof name === 'string' && name.trim().length > 0 ? name : null);
    } catch {
      names.set(id, null); // a name is cosmetic — a read failure renders the id, never fails the page
    }
  }));
  return posts.map((p) => ({ ...p, author_display_name: names.get(p.author_wallet_id) ?? null }));
}

export async function getChannelPosts(
  deps: CommonsDeps,
  channel: string,
  options: { page_size?: number; offset?: number },
): Promise<CommonsForumPost[]> {
  const pageSize = Math.min(options.page_size || 50, 100);

  // Top-level posts only: query the explicit null sentinel that createPost writes.
  let query = deps.db
    .collection(COMMONS_COLLECTIONS.FORUM_POSTS)
    .where('channel', '==', channel)
    .where('parent_post_id', '==', null)
    .orderBy('created_at', 'desc')
    .limit(100) as FirebaseFirestore.Query;

  if (options.offset) {
    query = query.offset(options.offset);
  }

  const snap = await query.get();
  return withAuthorNames(deps, snap.docs.map(d => d.data() as CommonsForumPost).filter(p => !isHiddenPrelaunchTest(p)).slice(0, pageSize));
}

/** The ONLY projection of a challenge that renders on the Commons: the outcome. */
export function toPublicChallenge(c: CommonsChallenge): PublicChallengeOutcome {
  return {
    challenge_id: c.challenge_id,
    post_id: c.post_id,
    status: c.status,
    resolution: c.resolution ?? null,
    created_at: c.created_at,
    resolved_at: c.resolved_at ?? null,
  };
}

async function challengesForPost(deps: CommonsDeps, postId: string): Promise<CommonsChallenge[]> {
  const snap = await deps.db
    .collection(COMMONS_COLLECTIONS.CHALLENGES)
    .where('post_id', '==', postId)
    .get();
  return snap.docs.map((d) => d.data() as CommonsChallenge);
}

export async function getPost(
  deps: CommonsDeps,
  postId: string,
  opts: { callerWalletId?: string | null } = {},
): Promise<{
  post: CommonsForumPost;
  replies: CommonsForumPost[];
  comments: CommonsForumPost[];
  root: CommonsForumPost | null;
  challenges: PublicChallengeOutcome[];
  challenge_outcomes: ChallengeOutcomeCounts;
}> {
  const postDoc = await deps.db
    .collection(COMMONS_COLLECTIONS.FORUM_POSTS)
    .doc(postId)
    .get();
  if (!postDoc.exists) {
    throw new NotFoundError('Post not found');
  }

  const post = { ...(postDoc.data() as CommonsForumPost), post_id: postId };
  if (isHiddenPrelaunchTest(post)) throw new NotFoundError('Post not found');

  // Direct replies (kept for backward compatibility).
  const repliesSnap = await deps.db
    .collection(COMMONS_COLLECTIONS.FORUM_POSTS)
    .where('parent_post_id', '==', postId)
    .orderBy('created_at', 'asc')
    .limit(100)
    .get();
  const rawReplies = repliesSnap.docs.map(d => d.data() as CommonsForumPost).filter(p => !isHiddenPrelaunchTest(p));

  // the whole tree — every descendant of the tree root, oldest first.
  const rootId = await treeRootIdOf(deps, post);
  const commentsSnap = await deps.db
    .collection(COMMONS_COLLECTIONS.FORUM_POSTS)
    .where('root_post_id', '==', rootId)
    .orderBy('created_at', 'asc')
    .limit(MAX_TREE_COMMENTS)
    .get();
  let rawComments = commentsSnap.docs.map(d => d.data() as CommonsForumPost).filter(p => !isHiddenPrelaunchTest(p));
  // Legacy rows (pre-backfill replies carry no root_post_id) are the root's DIRECT replies (the
  // pre- app only ever replied one level deep). Always merge them in, so an old thread that has
  // since gained one new-style reply never hides its older replies.
  const rootDirect = rootId === postId
    ? rawReplies
    : (await deps.db
      .collection(COMMONS_COLLECTIONS.FORUM_POSTS)
      .where('parent_post_id', '==', rootId)
      .orderBy('created_at', 'asc')
      .limit(MAX_TREE_COMMENTS)
      .get()).docs.map(d => d.data() as CommonsForumPost).filter(p => !isHiddenPrelaunchTest(p));
  const legacy = rootDirect.filter((r) => typeof r.root_post_id !== 'string' || r.root_post_id.length === 0);
  if (legacy.length > 0) {
    const seen = new Set(rawComments.map((c) => c.post_id));
    rawComments = [...rawComments, ...legacy.filter((r) => !seen.has(r.post_id))]
      .sort((a, b) => (Number(a.created_at) || 0) - (Number(b.created_at) || 0))
      .slice(0, MAX_TREE_COMMENTS);
  }
  let rawRoot: CommonsForumPost | null = null;
  if (rootId !== postId) {
    const rootDoc = await deps.db.collection(COMMONS_COLLECTIONS.FORUM_POSTS).doc(rootId).get();
    rawRoot = rootDoc.exists ? { ...(rootDoc.data() as CommonsForumPost), post_id: rootId } : null;
    if (rawRoot && isHiddenPrelaunchTest(rawRoot)) throw new NotFoundError('Post not found');
  }

  // One name join + one vote join over every post the response carries.
  const all = [post, ...rawReplies, ...rawComments, ...(rawRoot ? [rawRoot] : [])];
  const decorated = await withMyVotes(deps, await withAuthorNames(deps, all), opts.callerWalletId ?? null);
  let i = 0;
  const namedPost = decorated[i++];
  const replies = decorated.slice(i, i + rawReplies.length); i += rawReplies.length;
  const comments = decorated.slice(i, i + rawComments.length); i += rawComments.length;
  const root = rawRoot ? decorated[i] : null;

  // settle any challenge whose window lapsed with no presentation (lazy, idempotent), then
  // surface OUTCOMES only.
  const now = Date.now();
  const raw = await challengesForPost(deps, postId);
  const settled: CommonsChallenge[] = [];
  for (const c of raw) {
    if (c.status === 'open' && c.window_expires_at <= now) {
      try {
        settled.push(await settleExpiredChallenge(deps, c.challenge_id, now));
        continue;
      } catch (err) {
        console.warn('[Forum] lazy challenge settle failed (surfacing as-is):', err);
      }
    }
    settled.push(c);
  }
  const counts: ChallengeOutcomeCounts = { open: 0, answered: 0, upheld: 0 };
  for (const c of settled) counts[c.status] += 1;
  const isFlagged = post.is_flagged || counts.upheld > 0;

  return {
    post: { ...namedPost, is_flagged: isFlagged },
    replies,
    comments,
    root,
    challenges: settled.map(toPublicChallenge),
    challenge_outcomes: counts,
  };
}

/** Cap on the comments a post detail returns (the whole tree, oldest first). */
export const MAX_TREE_COMMENTS = 500;

/** The top-level post a post's tree hangs from (walks legacy rows with no `root_post_id`). */
async function treeRootIdOf(deps: CommonsDeps, post: CommonsForumPost): Promise<string> {
  if (!post.parent_post_id) return post.post_id;
  if (typeof post.root_post_id === 'string' && post.root_post_id.length > 0) return post.root_post_id;
  const parentDoc = await deps.db.collection(COMMONS_COLLECTIONS.FORUM_POSTS).doc(post.parent_post_id).get();
  if (!parentDoc.exists) return post.post_id;
  return (await resolveTreePosition(deps, { ...(parentDoc.data() as CommonsForumPost), post_id: post.parent_post_id })).rootId;
}

export async function getTrendingPosts(
  deps: CommonsDeps,
  options: { page_size?: number; callerWalletId?: string | null },
): Promise<CommonsForumPost[]> {
  const pageSize = Math.min(options.page_size || 20, 50);
  const { FieldPath } = await import('firebase-admin/firestore');

  // top-level posts by stored hot rank (the rank already decays with age, so no time filter).
  const snap = await deps.db
    .collection(COMMONS_COLLECTIONS.FORUM_POSTS)
    .where('parent_post_id', '==', null)
    .orderBy('hot_score', 'desc')
    .orderBy(FieldPath.documentId(), 'asc')
    .limit(100)
    .get();

  return withMyVotes(
    deps,
    await withAuthorNames(deps, snap.docs.map(d => d.data() as CommonsForumPost).filter(p => !isHiddenPrelaunchTest(p)).slice(0, pageSize)),
    options.callerWalletId ?? null,
  );
}

// ─── My votes ───────────────────────────────────────────────────────

/**
 * Attach the CALLER's own vote to each post (read-time, never stored). Reads only
 * `commons_votes/{postId}__{callerWalletId}` — the deterministic id the one-shot vote writer creates —
 * and double-checks the stored voter, so another wallet's vote can never surface. Anonymous → null.
 */
export async function withMyVotes(
  deps: CommonsDeps,
  posts: CommonsForumPost[],
  callerWalletId: string | null,
): Promise<CommonsForumPost[]> {
  if (!callerWalletId) return posts.map((p) => ({ ...p, my_vote: null }));
  const ids = [...new Set(posts.map((p) => p.post_id).filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const votes = new Map<string, ForumVoteType | null>();
  await Promise.all(ids.map(async (postId) => {
    try {
      const d = await deps.db.collection(COMMONS_COLLECTIONS.VOTES).doc(`${postId}__${callerWalletId}`).get();
      const v = d.exists ? (d.data() as Partial<CommonsForumVote>) : null;
      votes.set(postId, v && v.voter_wallet_id === callerWalletId && v.post_id === postId
        && (v.vote_type === 'upvote' || v.vote_type === 'downvote') ? v.vote_type : null);
    } catch {
      votes.set(postId, null); // cosmetic: a read failure shows "not voted", never fails the page
    }
  }));
  return posts.map((p) => ({ ...p, my_vote: votes.get(p.post_id) ?? null }));
}

// ─── Feed listing ───────────────────────────────────────────────────

export type ForumSort = 'hot' | 'new' | 'top';
export type ForumTopWindow = 'day' | 'week' | 'all';
const SORT_FIELDS = { hot: 'hot_score', new: 'created_at', top: 'score' } as const;
type ForumSortField = typeof SORT_FIELDS[ForumSort];

export const FORUM_FEED_LIMITS = {
  pageDefault: 25,
  pageMax: 50,
  /** `top` over a day/week window reads at most this many recent posts and ranks them in memory. */
  windowScanMax: 500,
  /** Batches a filtered page (channel=all minus announcements; the replies inbox) may read to fill. */
  maxBatches: 10,
} as const;

const WINDOW_MS: Record<Exclude<ForumTopWindow, 'all'>, number> = { day: 24 * 60 * 60 * 1000, week: 7 * 24 * 60 * 60 * 1000 };

type KeysetCursor = { v: number; id: string };
/**
 * `top` within a window pages by offset over a ranked snapshot. The window's bounds are pinned on the
 * first page (`s` = since, `u` = until) so a post aging out of the window, or a new post arriving,
 * between pages can never shift the offsets (a skipped or repeated row). Score changes between pages
 * can still reorder — inherent to any score-ranked feed.
 */
type OffsetCursor = { o: number; s?: number; u?: number };

function encodeCursor(c: KeysetCursor | OffsetCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(value: string): KeysetCursor | OffsetCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    const row = parsed as Record<string, unknown>;
    if (typeof row.o === 'number' && Number.isSafeInteger(row.o) && row.o >= 0) {
      const keys = Object.keys(row);
      const bound = (k: 's' | 'u') => row[k] === undefined || (typeof row[k] === 'number' && Number.isSafeInteger(row[k]) && (row[k] as number) >= 0);
      if (keys.every((k) => k === 'o' || k === 's' || k === 'u') && bound('s') && bound('u')) {
        return { o: row.o, ...(typeof row.s === 'number' ? { s: row.s } : {}), ...(typeof row.u === 'number' ? { u: row.u } : {}) };
      }
    }
    if (typeof row.v === 'number' && Number.isFinite(row.v) && typeof row.id === 'string' && row.id.length > 0 && Object.keys(row).length === 2) {
      return { v: row.v, id: row.id };
    }
    throw new Error();
  } catch {
    throw new ValidationError('Invalid cursor');
  }
}

function pageSizeOf(raw: number | undefined): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : FORUM_FEED_LIMITS.pageDefault;
  return Math.min(Math.max(n, 1), FORUM_FEED_LIMITS.pageMax);
}

type Snap = FirebaseFirestore.QueryDocumentSnapshot;

/**
 * Keyset pagination with an in-memory filter: read batches after `cursor` until the page is full
 * (plus one to know there is more) or the source is exhausted. The next cursor is the LAST RETURNED
 * row (items filtered out after it are simply re-read and dropped again), or — if the batch budget
 * ran out — the last SCANNED row (everything scanned after the last returned row was filtered out).
 * So no row is ever skipped or repeated across pages.
 */
async function keysetPage(
  fetchBatch: (after: KeysetCursor | null, limit: number) => Promise<Snap[]>,
  keep: (post: CommonsForumPost) => boolean,
  cursorOf: (doc: Snap) => KeysetCursor,
  pageSize: number,
  after: KeysetCursor | null,
): Promise<{ posts: CommonsForumPost[]; next: KeysetCursor | null }> {
  const kept: Array<{ post: CommonsForumPost; doc: Snap }> = [];
  let cursor = after;
  let lastScanned: Snap | null = null;
  let exhausted = false;
  const batch = pageSize + 1;
  for (let i = 0; i < FORUM_FEED_LIMITS.maxBatches && kept.length <= pageSize; i++) {
    const docs = await fetchBatch(cursor, batch);
    for (const doc of docs) {
      lastScanned = doc;
      const post = { ...(doc.data() as CommonsForumPost), post_id: (doc.data() as CommonsForumPost).post_id ?? doc.id };
      if (keep(post)) kept.push({ post, doc });
      if (kept.length > pageSize) break;
    }
    if (docs.length < batch) { exhausted = true; break; }
    if (lastScanned) cursor = cursorOf(lastScanned);
  }
  const page = kept.slice(0, pageSize);
  if (kept.length > pageSize) return { posts: page.map((k) => k.post), next: cursorOf(page[page.length - 1].doc) };
  if (exhausted || !lastScanned) return { posts: page.map((k) => k.post), next: null };
  return { posts: page.map((k) => k.post), next: cursorOf(lastScanned) };
}

export interface ListForumPostsOptions {
  channel?: string;
  sort?: ForumSort;
  window?: ForumTopWindow;
  page_size?: number;
  cursor?: string;
  callerWalletId?: string | null;
}

/**
 * feed: top-level posts, `hot` (stored hot rank) / `new` (created_at) / `top` (score; over a
 * day/week window when asked). `channel=all` excludes the announcements channel.
 */
export async function listForumPosts(
  deps: CommonsDeps,
  options: ListForumPostsOptions = {},
): Promise<{ posts: CommonsForumPost[]; next_cursor: string | null }> {
  const channel = options.channel && options.channel.length > 0 ? options.channel : 'all';
  const sort: ForumSort = options.sort ?? 'hot';
  if (!(sort in SORT_FIELDS)) throw new ValidationError("sort must be 'hot', 'new' or 'top'");
  const window: ForumTopWindow = options.window ?? 'all';
  if (window !== 'day' && window !== 'week' && window !== 'all') throw new ValidationError("window must be 'day', 'week' or 'all'");
  const pageSize = pageSizeOf(options.page_size);
  const cursor = options.cursor ? decodeCursor(options.cursor) : null;
  const keep = (p: CommonsForumPost) => !isHiddenPrelaunchTest(p)
    && (channel !== 'all' || p.channel !== ANNOUNCEMENTS_CHANNEL);

  let posts: CommonsForumPost[];
  let next: KeysetCursor | OffsetCursor | null;
  if (sort === 'top' && window !== 'all') {
    if (cursor && !('o' in cursor)) throw new ValidationError('Invalid cursor');
    ({ posts, next } = await topWindowPage(deps, channel, window, pageSize, cursor && 'o' in cursor ? cursor : { o: 0 }, keep));
  } else {
    if (cursor && !('v' in cursor)) throw new ValidationError('Invalid cursor');
    const sortField: ForumSortField = SORT_FIELDS[sort];
    const { FieldPath } = await import('firebase-admin/firestore');
    let q = deps.db
      .collection(COMMONS_COLLECTIONS.FORUM_POSTS)
      .where('parent_post_id', '==', null) as FirebaseFirestore.Query;
    if (channel !== 'all') {
      q = q.where('channel', '==', channel);
    }
    q = q.orderBy(sortField, 'desc').orderBy(FieldPath.documentId(), 'asc');
    const base = q;
    ({ posts, next } = await keysetPage(
      async (after, limit) => (await (after ? base.startAfter(after.v, after.id) : base).limit(limit).get()).docs,
      keep,
      (doc) => ({ v: Number((doc.data() as Record<string, unknown>)[sortField]) || 0, id: doc.id }),
      pageSize,
      cursor as KeysetCursor | null,
    ));
  }

  const decorated = await withMyVotes(deps, await withAuthorNames(deps, posts), options.callerWalletId ?? null);
  return { posts: decorated, next_cursor: next ? encodeCursor(next) : null };
}

/** `top` over a day/week window: read the window's newest posts, rank by score in memory, offset-page. */
async function topWindowPage(
  deps: CommonsDeps,
  channel: string,
  window: Exclude<ForumTopWindow, 'all'>,
  pageSize: number,
  cursor: OffsetCursor,
  keep: (p: CommonsForumPost) => boolean,
): Promise<{ posts: CommonsForumPost[]; next: OffsetCursor | null }> {
  const offset = cursor.o;
  const until = typeof cursor.u === 'number' ? cursor.u : Date.now();
  const since = typeof cursor.s === 'number' ? cursor.s : until - WINDOW_MS[window];
  let q = deps.db
    .collection(COMMONS_COLLECTIONS.FORUM_POSTS)
    .where('parent_post_id', '==', null) as FirebaseFirestore.Query;
  if (channel !== 'all') {
    q = q.where('channel', '==', channel);
  }
  q = q.where('created_at', '>=', since).where('created_at', '<=', until).orderBy('created_at', 'desc');
  const snap = await q.limit(FORUM_FEED_LIMITS.windowScanMax).get();
  const scoreOf = (p: CommonsForumPost) => (typeof p.score === 'number' ? p.score : (Number(p.upvotes) || 0) - (Number(p.downvotes) || 0));
  const ranked = snap.docs
    .map((d) => ({ ...(d.data() as CommonsForumPost), post_id: (d.data() as CommonsForumPost).post_id ?? d.id }))
    .filter(keep)
    .sort((a, b) => (scoreOf(b) - scoreOf(a)) || (a.post_id < b.post_id ? -1 : a.post_id > b.post_id ? 1 : 0));
  const posts = ranked.slice(offset, offset + pageSize);
  return { posts, next: offset + pageSize < ranked.length ? { o: offset + pageSize, s: since, u: until } : null };
}

// ─── Replies inbox ──────────────────────────────────────────────────

/**
 * Replies to the caller's posts and comments by OTHER wallets, newest first. Keyed on the stored
 * `parent_author_wallet_id`, so it can only ever return rows whose parent the caller wrote; each row
 * carries its tree root's title (read-time).
 */
export async function listMyReplies(
  deps: CommonsDeps,
  callerWalletId: string,
  options: { page_size?: number; cursor?: string } = {},
): Promise<{ replies: CommonsForumPost[]; next_cursor: string | null }> {
  if (!callerWalletId) throw new ForbiddenError('Authentication required');
  const pageSize = pageSizeOf(options.page_size);
  const cursor = options.cursor ? decodeCursor(options.cursor) : null;
  if (cursor && !('v' in cursor)) throw new ValidationError('Invalid cursor');
  const { FieldPath } = await import('firebase-admin/firestore');
  const base = deps.db
    .collection(COMMONS_COLLECTIONS.FORUM_POSTS)
    .where('parent_author_wallet_id', '==', callerWalletId)
    .orderBy('created_at', 'desc')
    .orderBy(FieldPath.documentId(), 'asc');
  const { posts, next } = await keysetPage(
    async (after, limit) => (await (after ? base.startAfter(after.v, after.id) : base).limit(limit).get()).docs,
    (p) => !isHiddenPrelaunchTest(p) && p.author_wallet_id !== callerWalletId && p.parent_author_wallet_id === callerWalletId,
    (doc) => ({ v: Number((doc.data() as Record<string, unknown>).created_at) || 0, id: doc.id }),
    pageSize,
    cursor as KeysetCursor | null,
  );

  // Root titles, one read per distinct root.
  const rootIds = [...new Set(posts.map((p) => p.root_post_id).filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const titles = new Map<string, string | null>();
  await Promise.all(rootIds.map(async (id) => {
    try {
      const d = await deps.db.collection(COMMONS_COLLECTIONS.FORUM_POSTS).doc(id).get();
      const t = d.exists ? (d.data() as { title?: unknown }).title : null;
      titles.set(id, typeof t === 'string' && t.length > 0 ? t : null);
    } catch {
      titles.set(id, null);
    }
  }));
  const withTitles = posts.map((p) => ({ ...p, root_title: p.root_post_id ? titles.get(p.root_post_id) ?? null : null }));
  const decorated = await withMyVotes(deps, await withAuthorNames(deps, withTitles), callerWalletId);
  return { replies: decorated, next_cursor: next ? encodeCursor(next) : null };
}

// ─── Voting ─────────────────────────────────────────────────────────────────

export async function voteOnPost(
  deps: CommonsDeps,
  actor: ForumActor,
  postId: string,
  body: VoteForumPostRequest,
  window: SpeechWindow,
): Promise<CommonsForumVote> {
  const { walletId } = actor;
  // Rate limit
  const rl = await deps.cache.checkRateLimit(
    `rl:commons:forum:vote:${walletId}`,
    L.RATE_LIMIT_FORUM_VOTE,
    60,
  );
  if (!rl.allowed) {
    throw new ValidationError(`Rate limit exceeded. Retry after ${rl.retryAfter}s`);
  }

  // F28 (S2 2026-09-10): validate vote_type.
  if (body.vote_type !== 'upvote' && body.vote_type !== 'downvote') {
    throw new ValidationError("vote_type must be 'upvote' or 'downvote'");
  }

  // Verify Commons profile
  const profileDoc = await deps.db
    .collection(COMMONS_COLLECTIONS.PROFILES)
    .doc(walletId)
    .get();
  if (!profileDoc.exists) {
    throw new ForbiddenError('Must be registered on the Commons to vote');
  }

  // Verify post exists
  const postDoc = await deps.db
    .collection(COMMONS_COLLECTIONS.FORUM_POSTS)
    .doc(postId)
    .get();
  if (!postDoc.exists) {
    throw new NotFoundError('Post not found');
  }

  // F28: the dedupe is ATOMIC — deterministic vote id created INSIDE the PE transaction.
  const now = Date.now();
  const voteId = `${postId}__${walletId}`;
  const voteRef = deps.db.collection(COMMONS_COLLECTIONS.VOTES).doc(voteId);

  const existing = await voteRef.get();
  if (existing.exists) {
    throw new ValidationError('Already voted on this post');
  }

  const buildVote = (peId: string): CommonsForumVote => ({
    vote_id: voteId,
    pe_id: peId,
    post_id: postId,
    voter_wallet_id: walletId,
    vote_type: body.vote_type,
    created_at: now,
  });

  const { FieldValue } = await import('firebase-admin/firestore');
  const field = body.vote_type === 'upvote' ? 'upvotes' : 'downvotes';
  const postRef = deps.db.collection(COMMONS_COLLECTIONS.FORUM_POSTS).doc(postId);

  let peId: string;
  try {
    ({ peId } = await generatePE(deps, {
      ...speechPe(actor, window),
      actionType: 'commons_vote_cast',
      metadata: {
        post_id: postId,
        vote_type: body.vote_type,
        vote_id: voteId,
        verified: true,
      },
      atomicEntityWrite: (txn, generatedPeId) => {
        txn.create(voteRef, buildVote(generatedPeId));
        // the post's counters ride the SAME transaction as the vote + its PE (they used to
        // be a separate post-commit update, so a crash between the two lost the count).
        txn.update(postRef, {
          [field]: FieldValue.increment(1),
          score: FieldValue.increment(body.vote_type === 'upvote' ? 1 : -1),
        });
      },
    }));
  } catch (err) {
    if ((err as { code?: number }).code === 6) {
      throw new ValidationError('Already voted on this post');
    }
    throw err;
  }

  const vote = buildVote(peId);

  // the hot rank follows the score (idempotent recompute from the committed counters).
  await recomputeHotScore(deps, postId).catch((err) => {
    console.warn('[Forum] hot_score recompute after vote failed (backfill heals it):', err);
  });

  // Update author's upvote count if upvote
  if (body.vote_type === 'upvote') {
    const postData = postDoc.data() as CommonsForumPost;
    await deps.db
      .collection(COMMONS_COLLECTIONS.PROFILES)
      .doc(postData.author_wallet_id)
      .update({ forum_upvotes_received: FieldValue.increment(1) });
  }

  return vote;
}

// ─── Challenge (burn-to-present) ────────────────────────────────────────────

/** The vocabulary fields a challenge may name (fixed keys + the dynamic patterns). */
const CHALLENGE_FIELD_RE = /^(continuity|work|coupling|consumption|money|standing|accountability|composition|presentations|actor)\.[a-z0-9_.]+$/;

export function normalizeChallengePredicate(raw: unknown): ChallengePredicate {
  const parsed = normalizePredicateRequests([raw]);
  if (!parsed || parsed.length !== 1) {
    throw new ValidationError('predicate must be one { field, op, threshold | set } request');
  }
  const p = parsed[0] as { field: string; op: ChallengePredicate['op']; threshold?: number; set?: number[] };
  if (!CHALLENGE_FIELD_RE.test(p.field)) {
    throw new ValidationError('predicate.field must name a presentation-vocabulary field');
  }
  return p.set !== undefined
    ? { field: p.field, op: p.op, set: p.set }
    : { field: p.field, op: p.op, threshold: p.threshold };
}

export async function challengePost(
  deps: CommonsDeps,
  actor: ForumActor,
  postId: string,
  body: ChallengeForumPostRequest,
  window: SpeechWindow,
): Promise<CommonsChallenge> {
  const { walletId } = actor;
  // F29 (S2 2026-09-10): rate limit.
  const rl = await deps.cache.checkRateLimit(
    `rl:commons:forum:challenge:${walletId}`,
    L.RATE_LIMIT_FORUM_CHALLENGE,
    60,
  );
  if (!rl.allowed) {
    throw new ValidationError(`Rate limit exceeded. Retry after ${rl.retryAfter}s`);
  }

  // Verify Commons profile
  const profileDoc = await deps.db
    .collection(COMMONS_COLLECTIONS.PROFILES)
    .doc(walletId)
    .get();
  if (!profileDoc.exists) {
    throw new ForbiddenError('Must be registered on the Commons to challenge');
  }

  // Verify post exists
  const postDoc = await deps.db
    .collection(COMMONS_COLLECTIONS.FORUM_POSTS)
    .doc(postId)
    .get();
  if (!postDoc.exists) {
    throw new NotFoundError('Post not found');
  }
  const post = postDoc.data() as CommonsForumPost;
  if (post.author_wallet_id === walletId) {
    throw new ValidationError('Cannot challenge your own post');
  }

  const predicate = normalizeChallengePredicate(body?.predicate);
  if (!isBurnId(body?.burn_id)) {
    throw new ValidationError('burn_id must be a 64-hex burn id (the stake)');
  }
  const burnId = body.burn_id;
  let reason: string | null = null;
  if (body.reason !== undefined && body.reason !== null) {
    if (typeof body.reason !== 'string' || body.reason.trim().length > 500) {
      throw new ValidationError('reason must be a string of at most 500 characters');
    }
    reason = body.reason.trim() || null;
  }

  // The stake floor (schedulable) and the burn-owner identity (an agent's burns are recorded under
  // its wallet id; a human's under its first-party wallet doc id).
  const [minStake, committer] = await Promise.all([
    resolveBurnFloorAtomic(deps.db, 'challenge_stake'),
    resolveSpeechCommitter(deps.db, { walletId, isAgent: actor.isAgent }),
  ]);
  if (!committer.presenterWalletId) {
    throw new ForbiddenError('No first-party wallet to stake from');
  }

  // F29: one challenge per (post, challenger).
  const now = Date.now();
  const challengeId = `${postId}__${walletId}`;
  const challengeRef = deps.db.collection(COMMONS_COLLECTIONS.CHALLENGES).doc(challengeId);
  const burnRef = deps.db.collection(PVT_BURN_RECORDS_COLLECTION).doc(burnId);
  const consumptionRef = deps.db.collection(BURN_CONSUMPTIONS_COLLECTION).doc(burnId);

  const existing = await challengeRef.get();
  if (existing.exists) {
    throw new ValidationError('You have already challenged this post');
  }

  let stakeAmountAtomic = '0';
  const buildChallenge = (peId: string): CommonsChallenge => ({
    challenge_id: challengeId,
    pe_id: peId,
    post_id: postId,
    challenger_wallet_id: walletId,
    author_wallet_id: post.author_wallet_id,
    reason,
    predicate,
    stake_burn_id: burnId,
    stake_amount_atomic: stakeAmountAtomic,
    stake_status: 'reserved',
    audience: challengeAudience(challengeId),
    challenge_nonce: randomBytes(32).toString('hex'),
    status: 'open',
    window_expires_at: now + CHALLENGE_WINDOW_MS,
    created_at: now,
  });

  let peId: string;
  try {
    ({ peId } = await generatePE(deps, {
      ...speechPe(actor, window),
      actionType: 'commons_claim_challenged',
      metadata: {
        post_id: postId,
        challenge_id: challengeId,
        predicate_sha256: sha256Hex(JSON.stringify(predicate)),
        stake_burn_id: burnId,
        verified: true,
      },
      // Read-only half: the stake must be this challenger's verified, unspent burn at/above the
      // floor — checked in the SAME transaction that reserves it (all reads before any write).
      atomicEntityPrecondition: async (txn) => {
        const [burnSnap, consumptionSnap] = await Promise.all([txn.get(burnRef), txn.get(consumptionRef)]);
        const burn = burnSnap.exists ? (burnSnap.data() as Record<string, unknown>) : undefined;
        assertBurnRowUsable(burn, committer.presenterWalletId, minStake);
        if (consumptionSnap.exists) throw new BurnConsumptionError(409, BURN_ALREADY_CONSUMED);
        stakeAmountAtomic = parseAmountAtomic(burn!.amount_atomic).toString();
      },
      atomicEntityWrite: (txn, generatedPeId) => {
        txn.create(challengeRef, buildChallenge(generatedPeId));
        // The stake is RESERVED on the global single-use ledger (product `challenge_stake`).
        txn.create(
          consumptionRef,
          buildBurnConsumptionMarker({ burnId, product: 'challenge_stake', walletId: committer.presenterWalletId, ref: challengeId, nowMs: now }),
        );
      },
    }));
  } catch (err) {
    if ((err as { code?: number }).code === 6) {
      throw new ValidationError('You have already challenged this post');
    }
    if (err instanceof BurnConsumptionError) {
      if (err.status === 404) throw new NotFoundError(err.message);
      if (err.status === 403) throw new ForbiddenError(err.message);
      throw new ValidationError(err.message);
    }
    throw err;
  }

  const challenge = buildChallenge(peId);

  // Update post challenge count
  const { FieldValue } = await import('firebase-admin/firestore');
  await deps.db
    .collection(COMMONS_COLLECTIONS.FORUM_POSTS)
    .doc(postId)
    .update({ challenge_count: FieldValue.increment(1) });

  return challenge;
}

/** Read a challenge by id (the FULL record — the route projects it by caller). */
export async function getChallenge(
  deps: CommonsDeps,
  challengeId: string,
): Promise<CommonsChallenge> {
  const doc = await deps.db
    .collection(COMMONS_COLLECTIONS.CHALLENGES)
    .doc(challengeId)
    .get();
  if (!doc.exists) throw new NotFoundError('Challenge not found');
  const c = doc.data() as CommonsChallenge;
  if (c.status === 'open' && c.window_expires_at <= Date.now()) {
    try { return await settleExpiredChallenge(deps, challengeId, Date.now()); } catch { /* surface as-is */ }
  }
  return c;
}

/** The party-facing projection: the challenger and the author see the predicate; nobody else does. */
export function toPartyChallenge(c: CommonsChallenge, viewerWalletId: string): CommonsChallenge | PublicChallengeOutcome {
  return c.challenger_wallet_id === viewerWalletId || c.author_wallet_id === viewerWalletId
    ? c
    : toPublicChallenge(c);
}

/** Open challenges against a wallet's posts (the author's private "answer these" list). */
export async function openChallengesForAuthor(
  deps: CommonsDeps,
  authorWalletId: string,
): Promise<CommonsChallenge[]> {
  const snap = await deps.db
    .collection(COMMONS_COLLECTIONS.CHALLENGES)
    .where('author_wallet_id', '==', authorWalletId)
    .where('status', '==', 'open')
    .get();
  const now = Date.now();
  return snap.docs.map((d) => d.data() as CommonsChallenge).filter((c) => c.window_expires_at > now);
}

/** Resolve the identity (agent_id + on-chain address) of a wallet for PE attribution. */
async function resolveWalletIdentity(
  deps: CommonsDeps,
  walletId: string,
): Promise<{ agentId: string; actorAddress: string | null; isAgent: boolean }> {
  const walletDoc = await deps.db.collection('agent_wallets').doc(walletId).get();
  if (walletDoc.exists) {
    const w = walletDoc.data() as { agent_id?: string; address?: string };
    return {
      agentId: typeof w.agent_id === 'string' ? w.agent_id : walletId,
      actorAddress: typeof w.address === 'string' && /^0[xX][0-9a-fA-F]{40}$/.test(w.address) ? w.address : null,
      isAgent: true,
    };
  }
  return { agentId: walletId, actorAddress: null, isAgent: false };
}

/**
 * Terminal writer: transition an OPEN challenge to `answered` / `upheld`, settle the stake
 * (consumed on predicate_true; released otherwise), flag the post on `upheld`, and emit the
 * record-only resolution PE under the challenger. Transactional and idempotent: a repeat call
 * on a resolved challenge returns it unchanged.
 */
export async function resolveChallenge(
  deps: CommonsDeps,
  challengeId: string,
  resolution: CommonsChallengeResolution,
  opts: { nowMs?: number; answerPeId?: string; answerBurnId?: string; resolutionSummary?: string } = {},
): Promise<CommonsChallenge> {
  const now = opts.nowMs ?? Date.now();
  const challengeRef = deps.db.collection(COMMONS_COLLECTIONS.CHALLENGES).doc(challengeId);

  const result = await deps.db.runTransaction(async (txn) => {
    const snap = await txn.get(challengeRef);
    if (!snap.exists) throw new NotFoundError('Challenge not found');
    const c = snap.data() as CommonsChallenge;
    if (c.status !== 'open') return { challenge: c, changed: false as const };
    // A LAPSE MEANS THE AUTHOR DID NOT ANSWER. The decision is made here, on the challenge as this
    // transaction reads it, so no caller and no interleaving can lapse an answered challenge:
    //  - an answer that sealed (the claim carries its PE, written in the PE's own transaction)
    //    settles the challenge with THE ANSWER'S outcome, whoever asked for the lapse;
    //  - an answer still in flight (claimed, not yet sealed, inside the claim age) is left alone;
    //  - only a challenge with no answer lapses.
    //
    // And A SEALED ANSWER IS THE OUTCOME, whatever resolution the caller passes: the claim's stored
    // result, PE and burn settle the challenge, so no request can settle it with a different one.
    let effective: CommonsChallengeResolution = resolution;
    let answerPeId = opts.answerPeId;
    let answerBurnId = opts.answerBurnId;
    const claim = c.answer_claim ?? null;
    if (claim && typeof claim.answer_pe_id === 'string') {
      if (typeof claim.predicate_true === 'boolean') {
        effective = claim.predicate_true ? 'predicate_true' : 'predicate_false';
        answerPeId = claim.answer_pe_id;
        answerBurnId = typeof claim.answer_burn_id === 'string' ? claim.answer_burn_id : undefined;
      } else if (resolution === 'no_presentation') {
        // Sealed, outcome not on the claim (a claim written before outcomes were stored): never a
        // lapse. `settleExpiredChallenge` reads the outcome from the answer PE and resolves with it.
        return { challenge: c, changed: false as const };
      }
    } else if (resolution === 'no_presentation' && claim && now - claim.claimed_at < ANSWER_CLAIM_TTL_MS) {
      return { challenge: c, changed: false as const };
    }
    const status = effective === 'predicate_true' ? 'answered' : 'upheld';
    const stakeStatus = effective === 'predicate_true' ? 'consumed' : 'released';
    const summary = (effective === resolution ? opts.resolutionSummary : undefined) ?? (
      effective === 'predicate_true'
        ? 'Answered: the author presented and the predicate held; the stake burned'
        : effective === 'predicate_false'
          ? 'Upheld: the author presented and the predicate did not hold; the stake returned'
          : 'Upheld: no presentation inside the window; the stake returned');
    const consumptionRef = deps.db.collection(BURN_CONSUMPTIONS_COLLECTION).doc(c.stake_burn_id);
    const consumptionSnap = await txn.get(consumptionRef);
    const updates: Partial<CommonsChallenge> = {
      status,
      stake_status: stakeStatus,
      resolution: effective,
      resolved_at: now,
      resolution_summary: summary,
      ...(answerPeId ? { answer_pe_id: answerPeId } : {}),
      ...(answerBurnId ? { answer_burn_id: answerBurnId } : {}),
      // an upheld challenge is one adverse Standing event on the CHALLENGED party. The flag
      // rides the terminal write; it is cleared when that party's row is sealed (below, or by the
      // hourly Standing sweep if this request dies first).
      ...(status === 'upheld' ? { standing_pending: true } : {}),
    };
    txn.update(challengeRef, updates);
    if (stakeStatus === 'released') {
      const marker = consumptionSnap.exists ? (consumptionSnap.data() as Record<string, unknown>) : null;
      // Release ONLY the marker this challenge reserved (product + ref match) — never a burn
      // another product consumed. The release is audited on its own ledger.
      if (marker && marker.product === 'challenge_stake' && marker.ref === challengeId) {
        txn.delete(consumptionRef);
        txn.set(deps.db.collection(COMMONS_COLLECTIONS.BURN_CONSUMPTION_RELEASES).doc(`${c.stake_burn_id}__${challengeId}`), {
          burn_id: c.stake_burn_id,
          product: 'challenge_stake',
          ref: challengeId,
          wallet_id: marker.wallet_id ?? null,
          reason: effective,
          released_at: now,
        });
      }
    }
    if (status === 'upheld') {
      txn.update(deps.db.collection(COMMONS_COLLECTIONS.FORUM_POSTS).doc(c.post_id), { is_flagged: true });
    }
    return { challenge: { ...c, ...updates } as CommonsChallenge, changed: true as const, resolution: effective, status, stakeStatus, summary };
  });

  if (!result.changed) return result.challenge;
  const { status, stakeStatus, summary } = result;
  const settledResolution = result.resolution;

  // Resolution record (record_only) under the challenger — best-effort after the terminal write.
  try {
    const identity = await resolveWalletIdentity(deps, result.challenge.challenger_wallet_id);
    const { peId } = await generatePE(deps, {
      walletId: result.challenge.challenger_wallet_id,
      agentId: identity.agentId,
      actorAddress: identity.actorAddress,
      actionType: 'commons_challenge_resolved',
      metadata: {
        challenge_id: challengeId,
        post_id: result.challenge.post_id,
        resolution: settledResolution,
        status,
        stake_status: stakeStatus,
        resolution_summary: summary,
        role: 'challenger',
      },
    });
    await challengeRef.update({ resolution_pe_id: peId });
    const withChallengerPe = { ...result.challenge, resolution_pe_id: peId };
    if (status !== 'upheld') return withChallengerPe;
    const challengedPeId = await sealUpheldChallengeStanding(deps, withChallengerPe);
    return { ...withChallengerPe, challenged_pe_id: challengedPeId, standing_pending: false };
  } catch (err) {
    console.error('[Forum] challenge resolution PE failed (challenge already resolved):', err);
    return result.challenge;
  }
}

/**
 * seal the CHALLENGED party's own record of an upheld challenge — the row Standing counts
 * (`standing.challenges_upheld_against`). Record-only (the same named matrix row as the challenger's
 * record); sealed exactly once per challenge whoever calls (the resolution request or the sweep).
 */
export async function sealUpheldChallengeStanding(deps: CommonsDeps, challenge: CommonsChallenge): Promise<string> {
  if (challenge.status !== 'upheld') throw new ValidationError('Only an upheld challenge marks the challenged party');
  const identity = await resolveWalletIdentity(deps, challenge.author_wallet_id);
  const { peId } = await generatePEOnce(deps, ['commons_challenge_resolved', challenge.challenge_id, 'challenged'], {
    walletId: challenge.author_wallet_id,
    agentId: identity.agentId,
    actorAddress: identity.actorAddress,
    actionType: 'commons_challenge_resolved',
    metadata: {
      challenge_id: challenge.challenge_id,
      post_id: challenge.post_id,
      resolution: challenge.resolution ?? null,
      status: 'upheld',
      role: 'challenged',
    },
  });
  await deps.db.collection(COMMONS_COLLECTIONS.CHALLENGES).doc(challenge.challenge_id)
    .update({ challenged_pe_id: peId, standing_pending: false });
  return peId;
}

export interface ChallengeStandingSweepReport {
  readonly expired_settled: number;
  readonly standing_sealed: number;
  readonly failures: number;
}

/**
 * Standing sweep for Commons challenges (run by the hourly Standing reconcile): settle every
 * open challenge whose window has lapsed (it is upheld — until now that happened only when someone
 * read it), then seal the challenged party's row for every upheld challenge still waiting for it.
 */
export async function sweepChallengeStanding(deps: CommonsDeps, nowMs: number = Date.now(), pageSize: number = 300): Promise<ChallengeStandingSweepReport> {
  let expired = 0;
  let sealed = 0;
  let failures = 0;
  // Every open challenge is read, a page at a time: a first page of challenges still inside their
  // windows must never hide a lapsed one.
  await forEachDocument(deps.db.collection(COMMONS_COLLECTIONS.CHALLENGES).where('status', '==', 'open'), pageSize, async (doc) => {
    const c = doc.data() as CommonsChallenge;
    if (c.window_expires_at > nowMs) return;
    try {
      const settled = await settleExpiredChallenge(deps, c.challenge_id, nowMs);
      if (settled.status === 'upheld') expired += 1;
    } catch (err) {
      failures += 1;
      console.error('[Forum] expired challenge settlement failed:', c.challenge_id, err);
    }
  });
  await forEachDocument(deps.db.collection(COMMONS_COLLECTIONS.CHALLENGES).where('standing_pending', '==', true), pageSize, async (doc) => {
    const c = doc.data() as CommonsChallenge;
    try {
      await sealUpheldChallengeStanding(deps, c);
      sealed += 1;
    } catch (err) {
      failures += 1;
      console.error('[Forum] upheld challenge Standing row failed:', c.challenge_id, err);
    }
  });
  return { expired_settled: expired, standing_sealed: sealed, failures };
}

/**
 * Settle a challenge whose window has passed: with the author's sealed answer's own outcome when
 * there is one, as a lapse (`no_presentation` → `upheld`) only when the author did not answer.
 */
export async function settleExpiredChallenge(
  deps: CommonsDeps,
  challengeId: string,
  nowMs: number,
): Promise<CommonsChallenge> {
  const doc = await deps.db.collection(COMMONS_COLLECTIONS.CHALLENGES).doc(challengeId).get();
  if (!doc.exists) throw new NotFoundError('Challenge not found');
  const c = doc.data() as CommonsChallenge;
  if (c.status !== 'open' || c.window_expires_at > nowMs) return c;
  // A lapse means the author did not answer. `resolveChallenge` decides that on the challenge as
  // its own transaction reads it (a sealed answer settles with the answer's outcome; an answer in
  // flight is left alone), so this function cannot lapse an answered challenge by reading it early.
  if (typeof c.answer_claim?.answer_pe_id === 'string') return settleSealedAnswer(deps, challengeId, nowMs);
  return resolveChallenge(deps, challengeId, 'no_presentation', { nowMs });
}

/**
 * Settle a challenge whose answer has SEALED with that answer's own outcome: the one stored on the
 * claim, or — for a claim written before outcomes were stored — the one the answer PE carries. An
 * outcome that cannot be read leaves the challenge open; it is never guessed and never a lapse.
 */
async function settleSealedAnswer(deps: CommonsDeps, challengeId: string, nowMs: number): Promise<CommonsChallenge> {
  const doc = await deps.db.collection(COMMONS_COLLECTIONS.CHALLENGES).doc(challengeId).get();
  if (!doc.exists) throw new NotFoundError('Challenge not found');
  const c = doc.data() as CommonsChallenge;
  const claim = c.answer_claim ?? null;
  if (c.status !== 'open' || !claim || typeof claim.answer_pe_id !== 'string') return c;
  if (typeof claim.predicate_true === 'boolean') {
    // `resolveChallenge` settles a sealed claim with the claim's own stored outcome.
    return resolveChallenge(deps, challengeId, claim.predicate_true ? 'predicate_true' : 'predicate_false', { nowMs });
  }
  const outcome = await sealedAnswerOutcome(deps, claim.answer_pe_id, challengeId);
  if (outcome === null) return c;
  return resolveChallenge(deps, challengeId, outcome.predicateTrue ? 'predicate_true' : 'predicate_false', {
    nowMs,
    answerPeId: claim.answer_pe_id,
    ...(outcome.burnId ? { answerBurnId: outcome.burnId } : {}),
  });
}

/**
 * The outcome a sealed answer PE carries (`commons_challenge_answered` for THIS challenge), or null.
 *
 * LEGACY READ, KEPT UNTIL THE PE MIGRATION (PE meter, 2026-10-03). Every answer claim written since
 * outcomes were stored carries `predicate_true` on the claim itself (`answerChallenge` writes it in
 * the claim transaction), so `settleSealedAnswer` never reaches here for a metered answer — and the
 * meter keeps no PE body to read here (an act key holds identifiers, never `metadata`). Only a claim
 * written BEFORE outcomes were stored needs the envelope. Dropping this read would leave such a
 * challenge open forever with its stake burn neither consumed nor released — a stake the
 * challenger can lose — so it stays until the migration settles those claims; it goes with the
 * `provenance_envelopes` collection.
 */
async function sealedAnswerOutcome(
  deps: CommonsDeps,
  answerPeId: string,
  challengeId: string,
): Promise<{ predicateTrue: boolean; burnId: string | null } | null> {
  const snap = await deps.db.collection(LEGACY_PROVENANCE_ENVELOPES_COLLECTION).doc(answerPeId).get();
  if (!snap.exists) return null;
  const pe = snap.data() as { action_type?: unknown; metadata?: Record<string, unknown> };
  const md = pe.metadata;
  if (pe.action_type !== 'commons_challenge_answered' || !md || md.challenge_id !== challengeId) return null;
  if (typeof md.predicate_true !== 'boolean') return null;
  return { predicateTrue: md.predicate_true, burnId: typeof md.presentation_burn_id === 'string' ? md.presentation_burn_id : null };
}

/**
 * The AUTHOR answers a challenge by presenting against its predicate: a fresh presentation token
 * bound to the challenge's own audience + nonce (verify-at-submit, the pattern). The verdict
 * decides the outcome; the author's answer is itself a speech PE (`commons_challenge_answered`),
 * budgeted under the presentation's OWN burn (a claim is answered with a presentation).
 *
 * Three bindings, none of them caller-supplied (review, defects 1/2/6):
 * - the verified token must describe THE AUTHOR (`sub` = the author's presenter id, address =
 * the author's address when known) — a high-standing third party's token cannot answer for them;
 * - the budget burn is the token's co-signed `burn_id`, re-read from `pvt_burn_records` and
 * required to be a verified, recorded burn OWNED BY THE AUTHOR — never a body field;
 * - the answer is CLAIMED in a transaction (`answer_claim`) before the PE is sealed, so concurrent
 * submissions seal exactly one answer PE.
 */
/** A stale answer claim (crash between claim and seal) may be replaced by a different answer after this age. */
export const ANSWER_CLAIM_TTL_MS = 10 * 60 * 1000;

export async function answerChallenge(
  deps: CommonsDeps,
  actor: ForumActor,
  challengeId: string,
  body: AnswerChallengeRequest,
  verifyDeps: VerifyFreshDeps,
): Promise<CommonsChallenge> {
  // Raw read (not the lazily-settling getChallenge): a lapsed window is settled HERE so the late
  // answer is refused with the reason, not a generic terminal-state message.
  const challengeRef = deps.db.collection(COMMONS_COLLECTIONS.CHALLENGES).doc(challengeId);
  const rawDoc = await challengeRef.get();
  if (!rawDoc.exists) throw new NotFoundError('Challenge not found');
  const challenge = rawDoc.data() as CommonsChallenge;
  if (challenge.author_wallet_id !== actor.walletId) {
    throw new ForbiddenError('Only the challenged post\'s author can answer this challenge');
  }
  const now = Date.now();
  if (challenge.status === 'open' && challenge.window_expires_at <= now) {
    const settled = await settleExpiredChallenge(deps, challengeId, now);
    // The author's own answer sealed in time and is finished here (its first request died): that
    // is the answer's outcome, not a lapse.
    if (settled.status !== 'open' && settled.resolution !== 'no_presentation') return settled;
    if (settled.status === 'open') throw new ValidationError('This challenge is already being answered');
    throw new ValidationError('The challenge window has lapsed; the challenge stands');
  }
  if (challenge.status !== 'open') {
    throw new ValidationError(`Challenge is already ${challenge.status}`);
  }
  if (typeof body?.presentation_token !== 'string' || body.presentation_token.length === 0) {
    throw new ValidationError('presentation_token is required');
  }
  if (body.burn_id !== undefined && !isBurnId(body.burn_id)) {
    throw new ValidationError('burn_id, when given, must be a 64-hex burn id');
  }

  const fresh = await verifyFreshPresentationToken(
    { token: body.presentation_token, audience: challenge.audience, challenge: challenge.challenge_nonce, predicates: [challenge.predicate] },
    verifyDeps,
  );

  // Presenter binding: only a VALID token carries a presenter; it must be the author's own.
  const committer = await resolveSpeechCommitter(deps.db, { walletId: actor.walletId, isAgent: actor.isAgent });
  let predicateTrue = false;
  let budget: { burnId: string; burnAmountAtomic: string } | null = null;
  if (fresh.verdict === 'valid') {
    const presenter = fresh.presenter;
    if (!presenter) throw new ValidationError('presentation carries no presenter binding');
    const ownIds = new Set([actor.walletId, committer.presenterWalletId].filter((x): x is string => typeof x === 'string' && x.length > 0));
    if (!ownIds.has(presenter.sub)) {
      throw new ForbiddenError('The presentation must be the author\'s own — it describes another wallet');
    }
    if (actor.actorAddress && presenter.presenter_address && presenter.presenter_address !== actor.actorAddress.toLowerCase()) {
      throw new ForbiddenError('The presentation must be the author\'s own — its address is not the author\'s');
    }
    if (body.burn_id !== undefined && body.burn_id !== presenter.burn_id) {
      throw new ValidationError('burn_id does not match the burn the presentation consumed');
    }
    if (!isBurnId(presenter.burn_id)) throw new ValidationError('presentation carries no valid burn id');
    // The budget burn: the token's co-signed burn, re-read and required to be the author's own
    // verified, recorded burn (the same row check every other burn product applies).
    const burnSnap = await deps.db.collection(PVT_BURN_RECORDS_COLLECTION).doc(presenter.burn_id).get();
    const burnRow = burnSnap.exists ? (burnSnap.data() as Record<string, unknown>) : undefined;
    try {
      assertBurnRowUsable(burnRow, committer.presenterWalletId ?? actor.walletId, 0n);
    } catch (err) {
      if (err instanceof BurnConsumptionError && burnRow && burnRow.wallet_id === actor.walletId
        && burnRow.status === 'recorded' && burnRow.verified === true) {
        // The burn row is keyed by the actor id rather than the presenter id — same wallet.
      } else {
        throw new ValidationError(`presentation burn is not usable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    budget = { burnId: presenter.burn_id, burnAmountAtomic: parseAmountAtomic(burnRow?.amount_atomic).toString() };
    const first = fresh.predicate_results[0] as { result?: unknown } | undefined;
    predicateTrue = first?.result === true;
  }

  // Claim the answer transactionally: exactly one answer PE per challenge. A claim whose answer
  // has sealed IS the answer — any later submission finishes it with its stored outcome. A claim
  // with no sealed PE yet is "in flight" and refuses every other submission (same token or not)
  // for a bounded age (`ANSWER_CLAIM_TTL_MS`), after which a crashed claim may be replaced — never
  // a permanent block, never a second PE for concurrent duplicates.
  const jti = `ans_${createHash('sha256').update(body.presentation_token).digest('hex').slice(0, 24)}`;
  // One id per REQUEST. The token hash (jti) is not enough: the same token can arrive twice and be
  // judged differently (it can expire in between), and a stale claim can be taken over. Only the
  // request that holds the claim may seal onto it or release it.
  const claimId = randomBytes(16).toString('hex');
  let sealedPe: string | null = null;
  await deps.db.runTransaction(async (txn) => {
    const snap = await txn.get(challengeRef);
    const c = snap.data() as CommonsChallenge | undefined;
    if (!c || c.status !== 'open') throw new ValidationError(`Challenge is already ${c?.status ?? 'gone'}`);
    const claim = c.answer_claim ?? null;
    if (claim && typeof claim.answer_pe_id === 'string') {
      // An answer already sealed for this challenge. It is THE answer: finish it with its own
      // outcome — never seal a second one, whatever token this submission carries.
      sealedPe = claim.answer_pe_id;
      return;
    }
    if (claim && now - claim.claimed_at < ANSWER_CLAIM_TTL_MS) {
      throw new ValidationError('This challenge is already being answered');
    }
    txn.update(challengeRef, { answer_claim: { presentation_jti: jti, claimed_at: now, claim_id: claimId } });
  });

  if (sealedPe !== null) {
    // `settleSealedAnswer` takes the outcome from the claim (or, for a claim written before
    // outcomes were stored, from the answer PE) — never from this submission.
    const settled = await settleSealedAnswer(deps, challengeId, now);
    if (settled.status === 'open') throw new ValidationError('This challenge has already been answered');
    return settled;
  }

  let peId: string;
  try {
    // The answer PE — a speech act bounded by the presentation's own burn (budgeted only when the
    // verdict is valid, i.e. when a bound burn exists; an invalid answer records and mints nothing).
    //
    // THE ANSWER AND ITS RECORD ON THE CHALLENGE ARE ONE WRITE. The claim gains the PE id, the
    // predicate's result and the burn in the PE's own transaction, so "the answer sealed" and "the
    // challenge shows the sealed answer" cannot come apart: a request that dies at any point leaves
    // either no answer PE at all, or a challenge every settling path finishes with this answer's
    // outcome. The same transaction requires the challenge to be open and the claim to be this
    // request's, so no answer can seal on a challenge that has already settled.
    const sealed = await generatePE(deps, {
      walletId: actor.walletId,
      agentId: actor.agentId,
      actorAddress: actor.actorAddress,
      ownerType: actor.isAgent ? 'agent' : 'human',
      witnessClass: 'relay_verified',
      ...(budget ? { durableViaOrdinaryIntake: true, speechWindow: budget } : {}),
      actionType: 'commons_challenge_answered',
      metadata: {
        challenge_id: challengeId,
        post_id: challenge.post_id,
        ...(budget ? { presentation_burn_id: budget.burnId } : {}),
        verdict: fresh.verdict,
        predicate_true: predicateTrue,
        verified: fresh.verdict === 'valid',
      },
      atomicEntityPrecondition: async (txn) => {
        const snap = await txn.get(challengeRef);
        const c = snap.data() as CommonsChallenge | undefined;
        const claim = c?.answer_claim ?? null;
        if (!c || c.status !== 'open' || !claim || claim.claim_id !== claimId || typeof claim.answer_pe_id === 'string') {
          throw new ValidationError('This challenge is no longer open to this answer');
        }
      },
      atomicEntityWrite: (txn, newPeId) => {
        txn.update(challengeRef, {
          answer_claim: {
            presentation_jti: jti, claimed_at: now, claim_id: claimId, answer_pe_id: newPeId, predicate_true: predicateTrue,
            ...(budget ? { answer_burn_id: budget.burnId } : {}),
          },
        });
      },
    });
    peId = sealed.peId;
  } catch (err) {
    // The seal can fail AFTER it committed: the transaction's response is lost, the client re-runs
    // it, and the re-run finds this answer already on the claim. So the claim is read before
    // anything is concluded:
    //  - it carries THIS request's sealed answer → the answer stands; finish it (the settlement
    //    takes the outcome stored on the claim);
    //  - it is this request's and unsealed → release it so the author can retry;
    //  - anything else is left exactly as it is. A sealed answer is never erased.
    let sealedPeId: string | null = null;
    await deps.db.runTransaction(async (txn) => {
      const snap = await txn.get(challengeRef);
      const claim = (snap.data() as CommonsChallenge | undefined)?.answer_claim ?? null;
      if (!claim || claim.claim_id !== claimId) return; // another request's claim: never touched
      if (typeof claim.answer_pe_id === 'string') { sealedPeId = claim.answer_pe_id; return; }
      txn.update(challengeRef, { answer_claim: null });
    }).catch(() => undefined);
    if (sealedPeId === null) throw err;
    peId = sealedPeId;
  }

  return resolveChallenge(deps, challengeId, predicateTrue ? 'predicate_true' : 'predicate_false', {
    nowMs: now,
    answerPeId: peId,
    ...(budget ? { answerBurnId: budget.burnId } : {}),
  });
}

// ─── Flag Post ──────────────────────────────────────────────────────────────

export async function flagPost(
  deps: CommonsDeps,
  actor: ForumActor,
  postId: string,
  window: SpeechWindow,
): Promise<void> {
  const { walletId } = actor;
  const profileDoc = await deps.db
    .collection(COMMONS_COLLECTIONS.PROFILES)
    .doc(walletId)
    .get();
  if (!profileDoc.exists) {
    throw new ForbiddenError('Must be registered on the Commons');
  }

  const postRef = deps.db.collection(COMMONS_COLLECTIONS.FORUM_POSTS).doc(postId);
  const postDoc = await postRef.get();
  if (!postDoc.exists) {
    throw new NotFoundError('Post not found');
  }

  // The flag (one per wallet per post) and its PE commit together.
  const flagRef = deps.db.collection(COMMONS_COLLECTIONS.FORUM_POSTS).doc(postId).collection('flags').doc(walletId);
  const existing = await flagRef.get();
  if (existing.exists) throw new ValidationError('Already flagged this post');
  const now = Date.now();
  try {
    await generatePE(deps, {
      ...speechPe(actor, window),
      actionType: 'commons_post_flagged',
      metadata: { post_id: postId, verified: true },
      atomicEntityWrite: (txn, generatedPeId) => {
        txn.create(flagRef, { post_id: postId, wallet_id: walletId, pe_id: generatedPeId, created_at: now });
        txn.update(postRef, { is_flagged: true });
      },
    });
  } catch (err) {
    if ((err as { code?: number }).code === 6) throw new ValidationError('Already flagged this post');
    throw err;
  }
}
