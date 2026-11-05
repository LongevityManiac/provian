/**
 * Unit tests for the push dispatcher (relay -> phone push routing).
 *
 * Covers the invariant that broke delivery end-to-end before this module
 * existed: Expo tokens (`ExponentPushToken[...]`) must go to the Expo push
 * service, native tokens must go to FCM, and a mixed batch must split correctly.
 * Also covers receipt handling + pruning of permanently-invalid tokens.
 *
 * All transports are injected fakes - no real Firebase / Expo network calls.
 */

import type {
  ExpoPushMessage,
  ExpoPushTicket,
  ExpoPushReceipt,
  ExpoPushReceiptId,
} from 'expo-server-sdk';
import type { MulticastMessage, BatchResponse, SendResponse } from 'firebase-admin/messaging';
import {
  sendPush,
  sendPushToUser,
  pruneUserTokens,
  classifyToken,
  isExpoToken,
  tokenPrefix,
  resolvePushToken,
  type PushTransports,
  type PushMessage,
} from './pushDispatcher';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';

const EXPO_A = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const EXPO_B = 'ExpoPushToken[bbbbbbbbbbbbbbbbbbbbbb]';
const FCM_A = 'fRtGaXfcm-native-token-AAAA:APA91bValidLooking';
const FCM_B = 'dHqZbWfcm-native-token-BBBB:APA91bAnotherOne';

// --- Fake-transport builder ---------------------------------------------------

interface FakeConfig {
  /** Map token -> Expo ticket to return for that token. Defaults to `ok`. */
  expoTickets?: Record<string, ExpoPushTicket>;
  /** Map receipt-id -> receipt. Only consulted for tickets that returned `ok`. */
  expoReceipts?: Record<string, ExpoPushReceipt>;
  /** Map FCM token -> per-token SendResponse. Defaults to success. */
  fcmResponses?: Record<string, SendResponse>;
  /** Chunk size for Expo messages (default: no splitting). */
  expoChunkSize?: number;
  /** Chunk size for receipt ids (default: no splitting). */
  receiptChunkSize?: number;
  /** When set, sendExpo rejects (network failure). */
  expoThrows?: boolean;
  /** When set, sendFcm rejects (network failure). */
  fcmThrows?: boolean;
}

interface FakeTransports extends PushTransports {
  sentExpo: ExpoPushMessage[][];
  sentFcm: MulticastMessage[];
  fetchedReceiptIds: ExpoPushReceiptId[][];
}

function makeFakeTransports(cfg: FakeConfig = {}): FakeTransports {
  const sentExpo: ExpoPushMessage[][] = [];
  const sentFcm: MulticastMessage[] = [];
  const fetchedReceiptIds: ExpoPushReceiptId[][] = [];
  // Deterministic receipt id per token: r::<token>. Lets receipt config key by
  // "r::<token>" so tests don't have to thread ids through.
  const receiptIdFor = (token: string): string => `r::${token}`;

  const chunk = <T>(items: T[], size?: number): T[][] => {
    if (!size || size >= items.length) return items.length ? [items] : [];
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
  };

  return {
    sentExpo,
    sentFcm,
    fetchedReceiptIds,

    async sendFcm(message: MulticastMessage): Promise<BatchResponse> {
      sentFcm.push(message);
      if (cfg.fcmThrows) throw new Error('FCM network down');
      const tokens = message.tokens;
      const responses: SendResponse[] = tokens.map(
        (t) => cfg.fcmResponses?.[t] ?? ({ success: true, messageId: `m::${t}` } as SendResponse),
      );
      return {
        responses,
        successCount: responses.filter((r) => r.success).length,
        failureCount: responses.filter((r) => !r.success).length,
      };
    },

    async sendExpo(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]> {
      sentExpo.push(messages);
      if (cfg.expoThrows) throw new Error('Expo network down');
      return messages.map((m) => {
        const to = m.to as string;
        return cfg.expoTickets?.[to] ?? ({ status: 'ok', id: receiptIdFor(to) } as ExpoPushTicket);
      });
    },

    async getExpoReceipts(ids: ExpoPushReceiptId[]): Promise<{ [id: string]: ExpoPushReceipt }> {
      fetchedReceiptIds.push(ids);
      const out: { [id: string]: ExpoPushReceipt } = {};
      for (const id of ids) {
        // id is r::<token>; look up by that id (test keys receipts by id).
        out[id] = cfg.expoReceipts?.[id] ?? ({ status: 'ok' } as ExpoPushReceipt);
      }
      return out;
    },

    chunkExpo: (messages) => chunk(messages, cfg.expoChunkSize),
    chunkReceiptIds: (ids) => chunk(ids, cfg.receiptChunkSize),
  };
}

const baseMsg: PushMessage = { title: 'Hi', body: 'There' };

// --- Token classification -----------------------------------------------------

describe('token classification', () => {
  it('classifies ExponentPushToken and ExpoPushToken as expo', () => {
    expect(isExpoToken(EXPO_A)).toBe(true);
    expect(isExpoToken(EXPO_B)).toBe(true);
    expect(classifyToken(EXPO_A)).toBe('expo');
    expect(classifyToken(EXPO_B)).toBe('expo');
  });

  it('classifies native / non-Expo tokens as fcm', () => {
    expect(isExpoToken(FCM_A)).toBe(false);
    expect(classifyToken(FCM_A)).toBe('fcm');
    // A token that merely CONTAINS the substring but doesn't start with it is FCM.
    expect(classifyToken('x-ExponentPushToken[nope]')).toBe('fcm');
  });

  it('tokenPrefix never returns the full token', () => {
    const p = tokenPrefix(EXPO_A);
    expect(p.length).toBeLessThan(EXPO_A.length);
    expect(EXPO_A.startsWith(p.replace('…', ''))).toBe(true);
    expect(p).not.toContain('aaaaaaaaaaaaaaaaaaaaaa');
  });
});

// --- Ingestion field resolution ----------------------------------------------

describe('resolvePushToken', () => {
  it('accepts the legacy fcm_token field', () => {
    expect(resolvePushToken({ fcm_token: FCM_A })).toBe(FCM_A);
  });

  it('accepts the canonical push_token field', () => {
    expect(resolvePushToken({ push_token: EXPO_A })).toBe(EXPO_A);
  });

  it('prefers push_token when both are present', () => {
    expect(resolvePushToken({ push_token: EXPO_A, fcm_token: FCM_A })).toBe(EXPO_A);
  });

  it('returns undefined for empty / missing / non-string values', () => {
    expect(resolvePushToken({})).toBeUndefined();
    expect(resolvePushToken({ push_token: '', fcm_token: '' })).toBeUndefined();
    expect(resolvePushToken({ fcm_token: 123 })).toBeUndefined();
    expect(resolvePushToken(undefined)).toBeUndefined();
    expect(resolvePushToken(null)).toBeUndefined();
  });

  it('falls back to fcm_token when push_token is empty', () => {
    expect(resolvePushToken({ push_token: '', fcm_token: FCM_A })).toBe(FCM_A);
  });
});

// --- Routing ------------------------------------------------------------------

describe('sendPush routing', () => {
  it('routes an Expo token to the Expo transport only', async () => {
    const t = makeFakeTransports();
    const result = await sendPush([EXPO_A], baseMsg, t);
    expect(t.sentExpo).toHaveLength(1);
    expect(t.sentExpo[0].map((m) => m.to)).toEqual([EXPO_A]);
    expect(t.sentFcm).toHaveLength(0);
    expect(result).toMatchObject({ expoCount: 1, fcmCount: 0, successCount: 1, failureCount: 0 });
  });

  it('routes an FCM token to the FCM transport only', async () => {
    const t = makeFakeTransports();
    const result = await sendPush([FCM_A], baseMsg, t);
    expect(t.sentFcm).toHaveLength(1);
    expect(t.sentFcm[0].tokens).toEqual([FCM_A]);
    expect(t.sentExpo).toHaveLength(0);
    expect(result).toMatchObject({ expoCount: 0, fcmCount: 1, successCount: 1, failureCount: 0 });
  });

  it('splits a mixed batch correctly across both transports', async () => {
    const t = makeFakeTransports();
    const result = await sendPush([EXPO_A, FCM_A, EXPO_B, FCM_B], baseMsg, t);

    // Expo transport got exactly the two Expo tokens, in order.
    expect(t.sentExpo).toHaveLength(1);
    expect(t.sentExpo[0].map((m) => m.to)).toEqual([EXPO_A, EXPO_B]);

    // FCM transport got exactly the two native tokens, in order.
    expect(t.sentFcm).toHaveLength(1);
    expect(t.sentFcm[0].tokens).toEqual([FCM_A, FCM_B]);

    expect(result).toMatchObject({ expoCount: 2, fcmCount: 2, successCount: 4, failureCount: 0, invalidTokens: [] });
  });

  it('deduplicates and drops empty/falsy tokens before sending', async () => {
    const t = makeFakeTransports();
    const result = await sendPush([EXPO_A, EXPO_A, '', FCM_A, FCM_A], baseMsg, t);
    expect(t.sentExpo[0].map((m) => m.to)).toEqual([EXPO_A]);
    expect(t.sentFcm[0].tokens).toEqual([FCM_A]);
    expect(result).toMatchObject({ expoCount: 1, fcmCount: 1 });
  });

  it('makes no transport calls for an empty token list', async () => {
    const t = makeFakeTransports();
    const result = await sendPush([], baseMsg, t);
    expect(t.sentExpo).toHaveLength(0);
    expect(t.sentFcm).toHaveLength(0);
    expect(result).toEqual({ successCount: 0, failureCount: 0, invalidTokens: [], expoCount: 0, fcmCount: 0 });
  });
});

// --- Payload mapping ----------------------------------------------------------

describe('payload mapping', () => {
  it('maps high priority + channel + sound + contentAvailable onto both shapes', async () => {
    const t = makeFakeTransports();
    const msg: PushMessage = {
      title: 'T', body: 'B',
      data: { type: 'x', k: 'v' },
      priority: 'high',
      channelId: 'alerts',
      sound: 'default',
      contentAvailable: true,
    };
    await sendPush([EXPO_A, FCM_A], msg, t);

    const expoMsg = t.sentExpo[0][0];
    expect(expoMsg).toMatchObject({
      to: EXPO_A, title: 'T', body: 'B', data: { type: 'x', k: 'v' },
      priority: 'high', channelId: 'alerts', sound: 'default', _contentAvailable: true,
    });

    const fcm = t.sentFcm[0];
    expect(fcm.notification).toEqual({ title: 'T', body: 'B' });
    expect(fcm.data).toEqual({ type: 'x', k: 'v' });
    expect(fcm.android?.priority).toBe('high');
    expect(fcm.android?.notification?.channelId).toBe('alerts');
    expect(fcm.android?.notification?.sound).toBe('default');
    expect(fcm.apns?.payload?.aps).toMatchObject({ sound: 'default', contentAvailable: true });
  });

  it('omits android/apns config when no priority/sound/channel given', async () => {
    const t = makeFakeTransports();
    await sendPush([FCM_A], baseMsg, t);
    const fcm = t.sentFcm[0];
    expect(fcm.android).toBeUndefined();
    expect(fcm.apns).toBeUndefined();
  });
});

// --- Invalid-token pruning ----------------------------------------------------

describe('invalid token detection', () => {
  it('flags FCM tokens with unregistered/invalid codes as invalidTokens', async () => {
    const t = makeFakeTransports({
      fcmResponses: {
        [FCM_A]: { success: false, error: { code: 'messaging/registration-token-not-registered' } } as SendResponse,
        [FCM_B]: { success: false, error: { code: 'messaging/invalid-registration-token' } } as SendResponse,
      },
    });
    const result = await sendPush([FCM_A, FCM_B], baseMsg, t);
    expect(result.failureCount).toBe(2);
    expect(result.successCount).toBe(0);
    expect(result.invalidTokens.sort()).toEqual([FCM_A, FCM_B].sort());
  });

  it('does NOT flag FCM tokens with transient error codes', async () => {
    const t = makeFakeTransports({
      fcmResponses: {
        [FCM_A]: { success: false, error: { code: 'messaging/internal-error' } } as SendResponse,
      },
    });
    const result = await sendPush([FCM_A], baseMsg, t);
    expect(result.failureCount).toBe(1);
    expect(result.invalidTokens).toEqual([]);
  });

  it('flags Expo tokens whose TICKET is DeviceNotRegistered', async () => {
    const t = makeFakeTransports({
      expoTickets: {
        [EXPO_A]: { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
      },
    });
    const result = await sendPush([EXPO_A], baseMsg, t);
    expect(result.failureCount).toBe(1);
    expect(result.invalidTokens).toEqual([EXPO_A]);
  });

  it('prunes Expo tokens whose RECEIPT (fetched after send) is DeviceNotRegistered', async () => {
    const t = makeFakeTransports({
      // Ticket accepted (ok) for delivery...
      expoTickets: { [EXPO_A]: { status: 'ok', id: `r::${EXPO_A}` } },
      // ...but the receipt later reports the device is gone.
      expoReceipts: {
        [`r::${EXPO_A}`]: { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
      },
    });
    const result = await sendPush([EXPO_A], baseMsg, t);
    // Ticket was ok -> counted as a successful send...
    expect(result.successCount).toBe(1);
    // ...but the receipt marks it invalid so it gets pruned.
    expect(result.invalidTokens).toEqual([EXPO_A]);
    expect(t.fetchedReceiptIds).toEqual([[`r::${EXPO_A}`]]);
  });

  it('receipt errors that are NOT DeviceNotRegistered do not prune', async () => {
    const t = makeFakeTransports({
      expoTickets: { [EXPO_A]: { status: 'ok', id: `r::${EXPO_A}` } },
      expoReceipts: {
        [`r::${EXPO_A}`]: { status: 'error', message: 'rate', details: { error: 'MessageRateExceeded' } },
      },
    });
    const result = await sendPush([EXPO_A], baseMsg, t);
    expect(result.invalidTokens).toEqual([]);
  });
});

// --- Chunking -----------------------------------------------------------------

describe('chunking', () => {
  it('sends Expo in chunks and maps ticket -> token across chunk boundaries', async () => {
    // 5 expo tokens, chunk size 2 -> chunks of [2,2,1]. Make the token at global
    // index 3 (chunk 2, local index 1) come back DeviceNotRegistered, and assert
    // that exact token is the one pruned (proves cross-chunk index mapping).
    const tokens = Array.from({ length: 5 }, (_, i) => `ExponentPushToken[chunk${i}xxxxxxxxxxxxxxxx]`);
    const badToken = tokens[3];
    const t = makeFakeTransports({
      expoChunkSize: 2,
      expoTickets: {
        [badToken]: { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
      },
    });
    const result = await sendPush(tokens, baseMsg, t);

    expect(t.sentExpo.map((c) => c.length)).toEqual([2, 2, 1]);
    expect(result.expoCount).toBe(5);
    expect(result.successCount).toBe(4);
    expect(result.failureCount).toBe(1);
    expect(result.invalidTokens).toEqual([badToken]);
  });

  it('fetches receipts in chunks', async () => {
    const tokens = Array.from({ length: 3 }, (_, i) => `ExponentPushToken[rcpt${i}xxxxxxxxxxxxxxxxxx]`);
    const t = makeFakeTransports({ receiptChunkSize: 2 });
    await sendPush(tokens, baseMsg, t);
    // 3 receipt ids, chunk size 2 -> two fetch calls of [2,1].
    expect(t.fetchedReceiptIds.map((c) => c.length)).toEqual([2, 1]);
  });
});

// --- Network failures ---------------------------------------------------------

describe('transport failures', () => {
  it('counts all tokens as failures (no prune) when the FCM batch throws', async () => {
    const t = makeFakeTransports({ fcmThrows: true });
    const result = await sendPush([FCM_A, FCM_B], baseMsg, t);
    expect(result.failureCount).toBe(2);
    expect(result.successCount).toBe(0);
    expect(result.invalidTokens).toEqual([]);
  });

  it('counts Expo chunk as failures (no prune) when sendExpo throws', async () => {
    const t = makeFakeTransports({ expoThrows: true });
    const result = await sendPush([EXPO_A, EXPO_B], baseMsg, t);
    expect(result.failureCount).toBe(2);
    expect(result.successCount).toBe(0);
    expect(result.invalidTokens).toEqual([]);
  });

  it('a mixed batch still delivers to the healthy transport when the other throws', async () => {
    const t = makeFakeTransports({ fcmThrows: true });
    const result = await sendPush([EXPO_A, FCM_A], baseMsg, t);
    expect(result.successCount).toBe(1); // Expo succeeded
    expect(result.failureCount).toBe(1); // FCM failed
    expect(t.sentExpo[0].map((m) => m.to)).toEqual([EXPO_A]);
  });
});

// --- User-scoped helpers ------------------------------------------------------

describe('sendPushToUser', () => {
  it('reads fcm_tokens, dispatches, and reports hadTokens', async () => {
    const db = createFakeFirestore();
    db.store.set('users/u1', { id: 'u1', fcm_tokens: [EXPO_A, FCM_A] });
    const t = makeFakeTransports();

    const result = await sendPushToUser(db as never, 'u1', baseMsg, t);

    expect(result.hadTokens).toBe(true);
    expect(result).toMatchObject({ expoCount: 1, fcmCount: 1, successCount: 2 });
    expect(t.sentExpo[0].map((m) => m.to)).toEqual([EXPO_A]);
    expect(t.sentFcm[0].tokens).toEqual([FCM_A]);
  });

  it('no-ops (hadTokens false) when the user has no tokens', async () => {
    const db = createFakeFirestore();
    db.store.set('users/u1', { id: 'u1', fcm_tokens: [] });
    const t = makeFakeTransports();

    const result = await sendPushToUser(db as never, 'u1', baseMsg, t);

    expect(result.hadTokens).toBe(false);
    expect(t.sentExpo).toHaveLength(0);
    expect(t.sentFcm).toHaveLength(0);
  });

  it('no-ops when the user doc does not exist', async () => {
    const db = createFakeFirestore();
    const t = makeFakeTransports();
    const result = await sendPushToUser(db as never, 'ghost', baseMsg, t);
    expect(result.hadTokens).toBe(false);
  });

  it('prunes invalid tokens from the user doc via arrayRemove', async () => {
    const db = createFakeFirestore();
    db.store.set('users/u1', { id: 'u1', fcm_tokens: [FCM_A, FCM_B] });
    const t = makeFakeTransports({
      fcmResponses: {
        [FCM_A]: { success: false, error: { code: 'messaging/registration-token-not-registered' } } as SendResponse,
      },
    });

    await sendPushToUser(db as never, 'u1', baseMsg, t);

    // The fake applies Firestore transforms, so the invalid token is removed
    // while the valid token remains in the materialized document state.
    expect(db.ops).toContain('update:users/u1');
    expect(db.store.get('users/u1')).toEqual({ id: 'u1', fcm_tokens: [FCM_B] });
  });
});

describe('pruneUserTokens', () => {
  it('uses an atomic arrayRemove transform with exactly the invalid tokens', async () => {
    let capturedUpdate: Record<string, unknown> | undefined;
    const db = {
      collection: () => ({
        doc: () => ({
          update: async (value: Record<string, unknown>) => {
            capturedUpdate = value;
          },
        }),
      }),
    };

    await pruneUserTokens(db as never, 'u1', [FCM_A, FCM_B]);

    const transform = capturedUpdate?.fcm_tokens as {
      constructor?: { name?: string };
      elements?: unknown[];
    };
    expect(transform.constructor?.name).toBe('ArrayRemoveTransform');
    expect(transform.elements).toEqual([FCM_A, FCM_B]);
  });

  it('is a no-op when there are no invalid tokens', async () => {
    const db = createFakeFirestore();
    db.store.set('users/u1', { id: 'u1', fcm_tokens: [FCM_A] });
    await pruneUserTokens(db as never, 'u1', []);
    expect(db.ops).not.toContain('update:users/u1');
    expect(db.store.get('users/u1')).toEqual({ id: 'u1', fcm_tokens: [FCM_A] });
  });

  it('swallows write errors (best-effort)', async () => {
    // A db whose update rejects must not throw out of pruneUserTokens.
    const db = {
      collection: () => ({
        doc: () => ({ update: () => Promise.reject(new Error('firestore down')) }),
      }),
    };
    await expect(pruneUserTokens(db as never, 'u1', [FCM_A])).resolves.toBeUndefined();
  });
});
