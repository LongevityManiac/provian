import { localizePushMessage, pushTokenLanguage } from './localization';
/**
 * Push notification dispatcher.
 *
 * Single choke point for every relay -> phone push. The mobile app registers an
 * **Expo** push token (`getExpoPushTokenAsync`, `ExponentPushToken[...]`) and the
 * backend used to deliver EXCLUSIVELY through Firebase Admin
 * `messaging.sendEachForMulticast`, which cannot deliver to Expo tokens - so
 * every agent-authorization ask, hard_confirm goal approval, and security alert
 * silently failed per-token (multicast reports per-token errors, never throws).
 *
 * This module inspects each stored token and routes it to the correct transport:
 *   - `ExponentPushToken[...]` / `ExpoPushToken[...]`  -> Expo push service
 *     (via `expo-server-sdk`, which chunks to 100/request and exposes receipts).
 *   - everything else                                   -> Firebase Admin FCM
 *     multicast (the pre-existing native path).
 *
 * INVARIANT: this is the ONLY module allowed to call
 * `messaging.sendEachForMulticast`. A CI check
 * (`scripts/check-no-direct-multicast.sh`) fails the build if any other file
 * calls it directly. Every send site goes through `sendPush` /
 * `sendPushToUser`.
 *
 * Native FCM token migration on the app is explicitly deferred; because this
 * dispatcher routes by token format, that migration becomes optional - already
 * stored FCM tokens keep working, and any future native token flows straight
 * through the FCM path with no dispatcher change.
 */

import admin from 'firebase-admin';
import { Expo } from 'expo-server-sdk';
import { bumpOpsCounter } from '../observability/ops-counters';
import type {
  ExpoPushMessage,
  ExpoPushTicket,
  ExpoPushReceiptId,
  ExpoPushReceipt,
} from 'expo-server-sdk';
import type {
  MulticastMessage,
  BatchResponse,
  AndroidConfig,
  AndroidNotification,
  Aps,
} from 'firebase-admin/messaging';

// -----------------------------------------------------------------------------
// Normalized message shape (transport-agnostic)
// -----------------------------------------------------------------------------

/**
 * Transport-agnostic push payload. The dispatcher maps this onto both the FCM
 * multicast shape and the Expo message shape, preserving the semantics every
 * existing send site relied on (title, body, data, priority, Android channel).
 */
export interface PushMessage {
  title: string;
  body: string;
  /** Data payload. FCM requires string values; Expo accepts them unchanged. */
  data?: Record<string, string>;
  /** `high` -> FCM `android.priority:'high'` + Expo `priority:'high'`. */
  priority?: 'high' | 'normal';
  /** Android notification channel id (FCM `android.notification.channelId`). */
  channelId?: string;
  /** Notification sound. `'default'` plays the default sound; `null` silences. */
  sound?: 'default' | null;
  /** APNs `content-available` (silent background wake) + Expo `_contentAvailable`. */
  contentAvailable?: boolean;
  /** Per-token locale preferences; keyed by the token's SHA-256, never its raw value. */
  tokenLanguages?: unknown;
}

export type PushTokenType = 'expo' | 'fcm';

export interface SendPushResult {
  /** Tokens the transport accepted for delivery. */
  successCount: number;
  /** Tokens the transport rejected (invalid, unregistered, transient errors). */
  failureCount: number;
  /**
   * Tokens that are PERMANENTLY invalid (device unregistered / malformed) and
   * should be pruned from storage. Deduplicated. Never contains transient
   * failures.
   */
  invalidTokens: string[];
  /** How many tokens were routed to the Expo push service. */
  expoCount: number;
  /** How many tokens were routed to the FCM multicast path. */
  fcmCount: number;
}

// -----------------------------------------------------------------------------
// Token classification
// -----------------------------------------------------------------------------

// The app currently emits `ExponentPushToken[...]`. Newer Expo SDKs also emit
// `ExpoPushToken[...]`; both are Expo-push tokens and must NOT go to FCM. Any
// other shape (raw FCM registration token / APNs) routes to FCM.
const EXPO_TOKEN_RE = /^Expo(nent)?PushToken\[/;

/** True when `token` is an Expo push token (routes to the Expo push service). */
export function isExpoToken(token: string): boolean {
  return EXPO_TOKEN_RE.test(token);
}

/** Classify a stored token by format. Drives both routing and `token_type`. */
export function classifyToken(token: string): PushTokenType {
  return isExpoToken(token) ? 'expo' : 'fcm';
}

/**
 * Extract a push token from a registration request body, accepting the
 * canonical `push_token` and the legacy `fcm_token` (what the mobile app
 * currently sends). `push_token` wins if both are present. Returns undefined
 * when neither is a non-empty string. Format-agnostic - an Expo or a native
 * token is accepted identically and routed by format at send time.
 */
export function resolvePushToken(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as { push_token?: unknown; fcm_token?: unknown };
  if (typeof b.push_token === 'string' && b.push_token) return b.push_token;
  if (typeof b.fcm_token === 'string' && b.fcm_token) return b.fcm_token;
  return undefined;
}

/** Short, non-secret prefix for logging. NEVER log a full push token. */
export function tokenPrefix(token: string): string {
  return `${token.slice(0, 14)}…`;
}

// -----------------------------------------------------------------------------
// Injectable transports (real implementations by default; fakes in tests)
// -----------------------------------------------------------------------------

export interface PushTransports {
  sendFcm(message: MulticastMessage): Promise<BatchResponse>;
  sendExpo(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]>;
  getExpoReceipts(ids: ExpoPushReceiptId[]): Promise<{ [id: string]: ExpoPushReceipt }>;
  chunkExpo(messages: ExpoPushMessage[]): ExpoPushMessage[][];
  chunkReceiptIds(ids: ExpoPushReceiptId[]): ExpoPushReceiptId[][];
}

let expoClient: Expo | undefined;
function getExpoClient(): Expo {
  if (!expoClient) {
    // EXPO_ACCESS_TOKEN is optional - Expo accepts unauthenticated sends, but a
    // token raises rate limits and is recommended for production.
    expoClient = new Expo(
      process.env.EXPO_ACCESS_TOKEN
        ? { accessToken: process.env.EXPO_ACCESS_TOKEN, useFcmV1: true }
        : { useFcmV1: true },
    );
  }
  return expoClient;
}

let defaultTransports: PushTransports | undefined;
function getDefaultTransports(): PushTransports {
  if (!defaultTransports) {
    defaultTransports = {
      // The ONE allowed sendEachForMulticast call site in the codebase.
      sendFcm: (message) => admin.messaging().sendEachForMulticast(message),
      sendExpo: (messages) => getExpoClient().sendPushNotificationsAsync(messages),
      getExpoReceipts: (ids) => getExpoClient().getPushNotificationReceiptsAsync(ids),
      chunkExpo: (messages) => getExpoClient().chunkPushNotifications(messages),
      chunkReceiptIds: (ids) => getExpoClient().chunkPushNotificationReceiptIds(ids),
    };
  }
  return defaultTransports;
}

// -----------------------------------------------------------------------------
// Payload builders
// -----------------------------------------------------------------------------

function toMulticastMessage(tokens: string[], m: PushMessage): MulticastMessage {
  const msg: MulticastMessage = {
    tokens,
    notification: { title: m.title, body: m.body },
  };
  if (m.data) msg.data = m.data;

  const androidNotification: AndroidNotification = {};
  if (m.channelId) androidNotification.channelId = m.channelId;
  if (m.sound === 'default') androidNotification.sound = 'default';

  const android: AndroidConfig = {};
  if (m.priority === 'high') android.priority = 'high';
  if (Object.keys(androidNotification).length > 0) android.notification = androidNotification;
  if (Object.keys(android).length > 0) msg.android = android;

  const aps: Aps = {};
  if (m.sound === 'default') aps.sound = 'default';
  if (m.contentAvailable) aps.contentAvailable = true;
  if (aps.sound !== undefined || aps.contentAvailable !== undefined) {
    msg.apns = { payload: { aps } };
  }

  return msg;
}

function toExpoMessage(to: string, m: PushMessage): ExpoPushMessage {
  const msg: ExpoPushMessage = { to, title: m.title, body: m.body };
  if (m.data) msg.data = m.data;
  if (m.priority === 'high') msg.priority = 'high';
  else if (m.priority === 'normal') msg.priority = 'normal';
  if (m.channelId) msg.channelId = m.channelId;
  if (m.sound === 'default') msg.sound = 'default';
  else if (m.sound === null) msg.sound = null;
  if (m.contentAvailable) msg._contentAvailable = true;
  return msg;
}

// -----------------------------------------------------------------------------
// Core dispatch
// -----------------------------------------------------------------------------

// FCM per-token error codes that mean the TOKEN is permanently invalid. Kept
// deliberately narrow to the two token-specific codes (matching the prior K-10
// logic): `messaging/invalid-argument` is intentionally excluded because it can
// also signal a payload-level problem, which would mass-prune otherwise-valid
// tokens on a message bug.
const FCM_INVALID_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function sendViaFcm(
  tokens: string[],
  message: PushMessage,
  transports: PushTransports,
  result: SendPushResult,
): Promise<void> {
  if (tokens.length === 0) return;
  let batch: BatchResponse;
  try {
    batch = await transports.sendFcm(toMulticastMessage(tokens, message));
  } catch (err) {
    // Whole-batch failure (network / auth). Count as failures but DON'T prune -
    // the tokens themselves may be fine.
    result.failureCount += tokens.length;
    console.error(`[push] FCM batch send failed for ${tokens.length} token(s): ${errMsg(err)}`);
    return;
  }
  result.successCount += batch.successCount;
  result.failureCount += batch.failureCount;
  batch.responses.forEach((resp, idx) => {
    if (resp.success || !resp.error) return;
    const code = resp.error.code;
    if (FCM_INVALID_CODES.has(code)) {
      result.invalidTokens.push(tokens[idx]);
    }
    console.warn(`[push] FCM token ${tokenPrefix(tokens[idx])} failed: ${code}`);
  });
}

async function sendViaExpo(
  tokens: string[],
  message: PushMessage,
  transports: PushTransports,
  result: SendPushResult,
): Promise<void> {
  if (tokens.length === 0) return;

  const messages = tokens.map((to) => toExpoMessage(to, message));
  const chunks = transports.chunkExpo(messages);

  // Tickets correspond 1:1 (by index) with the messages in each chunk, so we
  // walk the original token list in lockstep to map ticket -> token.
  const receiptIdToToken = new Map<string, string>();
  const receiptIds: string[] = [];
  let cursor = 0;

  for (const chunk of chunks) {
    const chunkTokens = tokens.slice(cursor, cursor + chunk.length);
    cursor += chunk.length;

    let tickets: ExpoPushTicket[];
    try {
      tickets = await transports.sendExpo(chunk);
    } catch (err) {
      // Chunk-level failure (network). Count as failures, don't prune.
      result.failureCount += chunk.length;
      console.error(`[push] Expo chunk send failed for ${chunk.length} token(s): ${errMsg(err)}`);
      continue;
    }

    tickets.forEach((ticket, i) => {
      const token = chunkTokens[i];
      if (ticket.status === 'ok') {
        result.successCount += 1;
        receiptIdToToken.set(ticket.id, token);
        receiptIds.push(ticket.id);
        return;
      }
      // status === 'error'
      result.failureCount += 1;
      if (ticket.details?.error === 'DeviceNotRegistered') {
        result.invalidTokens.push(token);
      }
      console.warn(
        `[push] Expo token ${tokenPrefix(token)} ticket error: ${ticket.details?.error ?? ticket.message}`,
      );
    });
  }

  // Fetch receipts (best-effort). Delivery to the underlying APNs/FCM service is
  // asynchronous, so a token accepted at ticket time can still come back
  // DeviceNotRegistered here - prune those too. A failure fetching receipts must
  // NOT change delivery accounting.
  if (receiptIds.length === 0) return;
  try {
    for (const idChunk of transports.chunkReceiptIds(receiptIds)) {
      const receipts = await transports.getExpoReceipts(idChunk);
      for (const [id, receipt] of Object.entries(receipts)) {
        if (receipt.status !== 'error') continue;
        const token = receiptIdToToken.get(id);
        if (receipt.details?.error === 'DeviceNotRegistered' && token) {
          result.invalidTokens.push(token);
        }
        console.warn(
          `[push] Expo receipt ${token ? tokenPrefix(token) : id} error: ${receipt.details?.error ?? receipt.message}`,
        );
      }
    }
  } catch (err) {
    console.warn(`[push] Expo receipt fetch failed: ${errMsg(err)}`);
  }
}

/**
 * Send a push to an explicit list of tokens, routing each to Expo or FCM by
 * format. Never throws for delivery problems - inspect the returned result.
 *
 * The caller is responsible for pruning `result.invalidTokens` from storage
 * (or use `sendPushToUser` / `pruneUserTokens`).
 */
export async function sendPush(
  tokens: string[],
  message: PushMessage,
  transports: PushTransports = getDefaultTransports(),
): Promise<SendPushResult> {
  const clean = Array.from(new Set((tokens || []).filter((t): t is string => typeof t === 'string' && t.length > 0)));
  const expoTokens = clean.filter(isExpoToken);
  const fcmTokens = clean.filter((t) => !isExpoToken(t));

  const result: SendPushResult = {
    successCount: 0,
    failureCount: 0,
    invalidTokens: [],
    expoCount: expoTokens.length,
    fcmCount: fcmTokens.length,
  };

  if (clean.length === 0) return result;

  // Independent transports - run concurrently. Each mutates `result` for its own
  // slice of tokens (disjoint sets), so there's no shared-write race.
  const groups = new Map<string, string[]>();
  for (const token of clean) {
    const language = pushTokenLanguage(message.tokenLanguages, token);
    groups.set(language, [...(groups.get(language) ?? []), token]);
  }
  await Promise.all([...groups].map(async ([language, group]) => {
    const localized = localizePushMessage(message, language);
    await Promise.all([
      sendViaExpo(group.filter(isExpoToken), localized, transports, result),
      sendViaFcm(group.filter(token => !isExpoToken(token)), localized, transports, result),
    ]);
  }));

  result.invalidTokens = Array.from(new Set(result.invalidTokens));
  // Advisory ops counters (single site covers all 9 callers; Map.set only, no I/O).
  bumpOpsCounter('push.sent', result.successCount);
  bumpOpsCounter('push.failed', result.failureCount);
  bumpOpsCounter('push.invalid_tokens', result.invalidTokens.length);
  return result;
}

// -----------------------------------------------------------------------------
// User-scoped helpers (read tokens, send, prune)
// -----------------------------------------------------------------------------

/**
 * Atomically remove permanently-invalid tokens from a user's `fcm_tokens`
 * array. Uses `arrayRemove` so it can't clobber tokens added concurrently by a
 * registration write. Best-effort: logs and swallows on failure.
 */
export async function pruneUserTokens(
  db: FirebaseFirestore.Firestore,
  userId: string,
  invalidTokens: string[],
): Promise<void> {
  if (invalidTokens.length === 0) return;
  try {
    await db.collection('users').doc(userId).update({
      fcm_tokens: admin.firestore.FieldValue.arrayRemove(...invalidTokens),
    });
    console.warn(`[push] Pruned ${invalidTokens.length} invalid token(s) for user ${userId}`);
  } catch (err) {
    console.error(`[push] Failed to prune tokens for user ${userId}: ${errMsg(err)}`);
  }
}

export interface SendPushToUserResult extends SendPushResult {
  /** False when the user had zero registered tokens (nothing was attempted). */
  hadTokens: boolean;
}

/**
 * Look up a user's registered push tokens, dispatch, and prune any that come
 * back permanently invalid. This is the preferred entry point for send sites
 * that only have a user id.
 */
export async function sendPushToUser(
  db: FirebaseFirestore.Firestore,
  userId: string,
  message: PushMessage,
  transports?: PushTransports,
): Promise<SendPushToUserResult> {
  const userDoc = await db.collection('users').doc(userId).get();
  const data = userDoc.exists ? (userDoc.data() as { fcm_tokens?: string[]; push_languages?: unknown }) : undefined;
  const tokens = (data?.fcm_tokens || []).filter(Boolean);

  if (tokens.length === 0) {
    return {
      successCount: 0, failureCount: 0, invalidTokens: [], expoCount: 0, fcmCount: 0, hadTokens: false,
    };
  }

  const result = await sendPush(tokens, { ...message, tokenLanguages: data?.push_languages }, transports);
  await pruneUserTokens(db, userId, result.invalidTokens);
  return { ...result, hadTokens: true };
}

/** Reset the cached transports/Expo client. Test-only. */
export function __resetPushDispatcherForTests(): void {
  defaultTransports = undefined;
  expoClient = undefined;
}
