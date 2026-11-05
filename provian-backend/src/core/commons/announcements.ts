/**
 * Provian Commons — Operator Announcements + Broadcast
 *
 * The operator's channel to reach every participant. There is no user email on
 * file, so the town-square forum is the communication path: the operator posts a
 * PINNED post to the `announcements` forum channel, and (optionally) a push
 * notification fans out to every opted-in human user.
 *
 * AUTHORITY BOUNDARY — this is a COMMS capability only. It is gated by an
 * explicit, env-configured operator allowlist (`OPERATOR_COMMONS_WALLETS`,
 * comma-separated on-chain addresses). That allowlist holds NO economic, mint,
 * settlement, or custody authority; it is entirely separate from the PVT9 admin
 * EOA. It authorizes exactly one thing: writing a pinned announcement post and
 * broadcasting a notification about it. The gate is fail-closed — an empty or
 * unset env means NOBODY can announce.
 */

import type { Firestore } from 'firebase-admin/firestore';
import type { CommonsDeps, CommonsForumPost } from './types';
import { COMMONS_COLLECTIONS } from './types';
import { createPost } from './forum';
import type { SpeechWindow } from './speech-window';
import { ValidationError, ForbiddenError } from '../agent-bank/errors';
import type { PushMessage, SendPushResult } from '../notifications/pushDispatcher';
import { ANNOUNCEMENTS_CHANNEL, isOperatorCommonsWallet } from './operator';

export { ANNOUNCEMENTS_CHANNEL, isOperatorCommonsWallet, operatorCommonsWallets } from './operator';

/** Absolute ceiling on a single broadcast fan-out (backstop against runaway). */
const DEFAULT_MAX_BROADCAST_USERS = 20_000;

/**
 * Create a pinned operator announcement in the `announcements` channel.
 *
 * Enforces the operator gate itself (defense in depth — never relies solely on
 * a route check). The post is a normal forum PE (`commons_post_created`, which MINTS at its
 * evidence-class base under); the `announcements` channel + `is_pinned` mark it as official.
 */
export async function createOperatorAnnouncement(
  deps: CommonsDeps,
  operator: { walletId: string; agentId: string; actorAddress: string | null; isAgent?: boolean },
  body: { title?: string; content: string },
  // an announcement is Commons speech like any other post — the operator's own live
  // presentation window (asserted at the route) backs it and bounds what it mints.
  window: SpeechWindow,
): Promise<CommonsForumPost> {
  const operatorAddress = operator.actorAddress;
  if (operatorAddress === null || !isOperatorCommonsWallet(operatorAddress)) {
    throw new ForbiddenError('Not authorized to post announcements');
  }
  if (!body || typeof body.content !== 'string' || !body.content.trim()) {
    throw new ValidationError('Announcement content is required');
  }

  const post = await createPost(
    deps,
    {
      walletId: operator.walletId,
      agentId: operator.agentId,
      // The operator gate above required a real (allowlisted) address.
      actorAddress: operatorAddress,
      isAgent: operator.isAgent === true,
    },
    {
      channel: ANNOUNCEMENTS_CHANNEL,
      title: body.title,
      content: body.content,
    },
    window,
  );

  // Pin it so the app can surface the latest announcement as a banner. Done as
  // a follow-up update rather than threading a flag through createPost, keeping
  // the shared post-creation path untouched.
  await deps.db
    .collection(COMMONS_COLLECTIONS.FORUM_POSTS)
    .doc(post.post_id)
    .update({ is_pinned: true });

  return { ...post, is_pinned: true };
}

// ─── Broadcast fan-out ────────────────────────────────────────────────────────

export interface AnnouncementBroadcastDeps {
  db: Firestore;
  /** The push transport (pushDispatcher.sendPush). Injected for testability. */
  sendPush: (tokens: string[], msg: PushMessage) => Promise<SendPushResult>;
  /** Prune permanently-invalid tokens (pushDispatcher.pruneUserTokens). */
  pruneUserTokens: (db: Firestore, userId: string, invalid: string[]) => Promise<void>;
  /** Optional structured logger; defaults to console.log. */
  log?: (message: string) => void;
}

export interface AnnouncementBroadcastResult {
  usersScanned: number;
  usersOptedOut: number;
  usersWithoutTokens: number;
  usersPushed: number;
  pushSuccess: number;
  pushFailure: number;
  tokensPruned: number;
  /** True if the user scan hit the safety ceiling and stopped early. */
  capped: boolean;
}

/**
 * Broadcast an announcement push to every opted-in human user.
 *
 * Opt-out semantics (default ON): a user is skipped only if
 * `user_preferences/{userId}.notifications.announcements === false`. A missing
 * doc or absent field means the user receives operator announcements.
 *
 * Pages over the `users` collection by document id. Bounded by `maxUsers` (logs
 * when capped — never a silent truncation). This is inline over the current
 * pre-launch user base; at 10k+ users move it to a queued/segmented fan-out
 * (see the approval-scan-cost note in OPEN_ITEMS).
 */
export async function broadcastAnnouncementPush(
  deps: AnnouncementBroadcastDeps,
  announcement: { postId: string; title: string; body: string },
  options?: { maxUsers?: number; pageSize?: number },
): Promise<AnnouncementBroadcastResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const maxUsers = options?.maxUsers ?? DEFAULT_MAX_BROADCAST_USERS;
  const pageSize = Math.min(Math.max(options?.pageSize ?? 500, 1), 1000);
  const { FieldPath } = await import('firebase-admin/firestore');

  const result: AnnouncementBroadcastResult = {
    usersScanned: 0,
    usersOptedOut: 0,
    usersWithoutTokens: 0,
    usersPushed: 0,
    pushSuccess: 0,
    pushFailure: 0,
    tokensPruned: 0,
    capped: false,
  };

  const message: PushMessage = {
    title: announcement.title,
    body: announcement.body,
    data: {
      type: 'commons_announcement',
      postId: announcement.postId,
      channel: ANNOUNCEMENTS_CHANNEL,
    },
    priority: 'high',
  };

  let lastId: string | null = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (result.usersScanned >= maxUsers) {
      result.capped = true;
      break;
    }
    let query = deps.db
      .collection('users')
      .orderBy(FieldPath.documentId())
      .limit(pageSize) as FirebaseFirestore.Query;
    if (lastId) query = query.startAfter(lastId);

    const snap = await query.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      result.usersScanned++;
      const userId = doc.id;

      const tokens = ((doc.data() as { fcm_tokens?: string[] }).fcm_tokens || []).filter(Boolean);
      if (tokens.length === 0) {
        result.usersWithoutTokens++;
        continue;
      }

      // Opt-out check (default ON): only an explicit `false` suppresses.
      const prefDoc = await deps.db.collection('user_preferences').doc(userId).get();
      const prefs = prefDoc.exists ? (prefDoc.data() as { notifications?: { announcements?: boolean } }) : undefined;
      if (prefs?.notifications?.announcements === false) {
        result.usersOptedOut++;
        continue;
      }

      try {
        const push = await deps.sendPush(tokens, message);
        result.pushSuccess += push.successCount;
        result.pushFailure += push.failureCount;
        if (push.invalidTokens.length > 0) {
          await deps.pruneUserTokens(deps.db, userId, push.invalidTokens);
          result.tokensPruned += push.invalidTokens.length;
        }
        result.usersPushed++;
      } catch (err) {
        result.pushFailure += tokens.length;
        log(`[Announce] push error for user ${userId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    lastId = snap.docs[snap.docs.length - 1].id;
    if (snap.size < pageSize) break;
  }

  log(
    `[Announce] broadcast post=${announcement.postId} scanned=${result.usersScanned} pushed=${result.usersPushed} ` +
      `optedOut=${result.usersOptedOut} noTokens=${result.usersWithoutTokens} ` +
      `pushSuccess=${result.pushSuccess} pushFailure=${result.pushFailure} pruned=${result.tokensPruned}` +
      (result.capped ? ` CAPPED at maxUsers=${maxUsers}` : ''),
  );

  return result;
}
