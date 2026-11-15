/**
 * the forum routes: auth-optional reads attach ONLY the caller's own vote; the replies inbox
 * and the speech-window read require auth; a reply naming another channel is a 400.
 *
 * RED controls: anonymous `GET /forum/replies/mine` and `GET /speech-window` are 401 (never an empty
 * 200 that could be mistaken for "no replies" / "no pass"); another wallet's vote never appears as the
 * caller's `my_vote`; a bad sort is a 400; a channel-mismatched reply is a 400 and writes nothing.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { Router } from 'express';

const mockAuth: { current: { walletId: string; isAgent: boolean } | null } = { current: null };
jest.mock('./middleware/commons-auth', () => ({
  getAuthenticatedWallet: jest.fn().mockImplementation(async () => (mockAuth.current
    ? { walletId: mockAuth.current.walletId, agentId: mockAuth.current.walletId, actorAddress: null, isAgent: mockAuth.current.isAgent }
    : null)),
}));
jest.mock('../core/commons/speech-window', () => {
  const actual = jest.requireActual('../core/commons/speech-window') as Record<string, unknown>;
  return { ...actual, assertSpeechWindow: async () => ({ burnId: 'b'.repeat(64), burnAmountAtomic: 0n, audience: 'provian:commons', expiresAt: Number.MAX_SAFE_INTEGER }) };
});

import { createCommonsRouter } from './commons';
import { COMMONS_COLLECTIONS, hotScore } from '../core/commons/types';
import { createFakeFirestore, type FakeFirestore } from '../core/pvt/__test-helpers__/fake-firestore';

const ME = 'user_me';
const YOU = 'wallet_aw_you';

interface RouteLayer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: (req: unknown, res: unknown) => unknown }[] } }
function handlerOf(router: Router, method: 'get' | 'post', path: string) {
  const layer = (router as unknown as { stack: RouteLayer[] }).stack.find((l) => l.route?.path === path && l.route?.methods?.[method]);
  if (!layer?.route) throw new Error(`no ${method} ${path}`);
  return layer.route.stack[0].handle as (req: unknown, res: unknown) => Promise<unknown>;
}
async function call(router: Router, method: 'get' | 'post', path: string, opts: { params?: Record<string, string>; query?: Record<string, string>; body?: Record<string, unknown> } = {}) {
  const captured: { status: number; body?: unknown } = { status: 200 };
  const res = {
    status(code: number) { captured.status = code; return this; },
    json(payload: unknown) { captured.body = payload; return this; },
  };
  await handlerOf(router, method, path)({ params: opts.params ?? {}, query: opts.query ?? {}, body: opts.body ?? {}, headers: {} }, res);
  return captured;
}

let db: FakeFirestore;
let router: Router;
beforeEach(() => {
  mockAuth.current = null;
  db = createFakeFirestore();
  const deps = { db, cache: { checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }) }, peBuffer: { enqueue: () => {} }, recordPEAccrual: async () => {} };
  router = createCommonsRouter(deps as unknown as Parameters<typeof createCommonsRouter>[0]);
  db.store.set(`${COMMONS_COLLECTIONS.FORUM_CHANNELS}/general`, { name: 'general' });
  db.store.set(`${COMMONS_COLLECTIONS.FORUM_CHANNELS}/research`, { name: 'research' });
  db.store.set(`${COMMONS_COLLECTIONS.PROFILES}/${ME}`, { status: 'active', participant_type: 'human', commons_join_date: 0, pe_count: 100, display_name: 'Me' });
  db.store.set(`${COMMONS_COLLECTIONS.PROFILES}/${YOU}`, { status: 'active', participant_type: 'agent', commons_join_date: 0, pe_count: 100, display_name: 'You' });
  for (const id of ['p1', 'p2']) {
    db.store.set(`${COMMONS_COLLECTIONS.FORUM_POSTS}/${id}`, {
      post_id: id, author_wallet_id: YOU, author_type: 'agent', channel: 'general', content: id, parent_post_id: null, root_post_id: null, depth: 0,
      upvotes: 1, downvotes: 0, score: 1, comment_count: 0, reply_count: 0, created_at: 1_000, hot_score: hotScore(1, 0, 1_000),
    });
  }
  db.store.set(`${COMMONS_COLLECTIONS.VOTES}/p1__${ME}`, { post_id: 'p1', voter_wallet_id: ME, vote_type: 'upvote' });
  db.store.set(`${COMMONS_COLLECTIONS.VOTES}/p2__${YOU}`, { post_id: 'p2', voter_wallet_id: YOU, vote_type: 'downvote' });
});

describe('GET /forum/posts', () => {
  it('anonymous: my_vote null on every post; authenticated: only the caller\'s own vote', async () => {
    const anon = await call(router, 'get', '/forum/posts', { query: { sort: 'new' } });
    expect(anon.status).toBe(200);
    const anonPosts = (anon.body as { posts: Array<{ post_id: string; my_vote: unknown }> }).posts;
    expect(anonPosts).toHaveLength(2);
    expect(anonPosts.every((p) => p.my_vote === null)).toBe(true);

    mockAuth.current = { walletId: ME, isAgent: false };
    const mine = await call(router, 'get', '/forum/posts', { query: { sort: 'new' } });
    const byId = Object.fromEntries((mine.body as { posts: Array<{ post_id: string; my_vote: unknown }> }).posts.map((p) => [p.post_id, p.my_vote]));
    expect(byId.p1).toBe('upvote');
    expect(byId.p2).toBeNull(); // RED: YOU's downvote on p2 never surfaces as mine
    expect((mine.body as { next_cursor: unknown }).next_cursor).toBeNull();
  });

  it('RED: an unknown sort or window is a 400', async () => {
    expect((await call(router, 'get', '/forum/posts', { query: { sort: 'rising' } })).status).toBe(400);
    expect((await call(router, 'get', '/forum/posts', { query: { sort: 'top', window: 'month' } })).status).toBe(400);
  });

  it('GET /forum/post/:postId carries comments, root and my_vote', async () => {
    mockAuth.current = { walletId: ME, isAgent: false };
    const r = await call(router, 'get', '/forum/post/:postId', { params: { postId: 'p1' } });
    expect(r.status).toBe(200);
    const body = r.body as { post: { my_vote: unknown }; comments: unknown[]; root: unknown; replies: unknown[] };
    expect(body.post.my_vote).toBe('upvote');
    expect(body.comments).toEqual([]);
    expect(body.root).toBeNull();
    expect(body.replies).toEqual([]);
  });
});

describe('auth-required reads', () => {
  it('RED: anonymous replies inbox and speech-window are 401', async () => {
    expect((await call(router, 'get', '/forum/replies/mine')).status).toBe(401);
    expect((await call(router, 'get', '/speech-window')).status).toBe(401);
  });

  it('authenticated: the inbox answers {replies, next_cursor}; the speech window answers its shape', async () => {
    mockAuth.current = { walletId: YOU, isAgent: true };
    const inbox = await call(router, 'get', '/forum/replies/mine');
    expect(inbox.status).toBe(200);
    expect(inbox.body).toEqual({ replies: [], next_cursor: null });
    const sw = await call(router, 'get', '/speech-window');
    expect(sw.status).toBe(200);
    expect(sw.body).toEqual({ live: false, expires_at: null, audience: 'provian:commons' });
  });
});

describe('POST /forum/post/:postId/reply', () => {
  it('channel defaults to the parent\'s; RED: a differing channel is a 400 and writes nothing', async () => {
    mockAuth.current = { walletId: ME, isAgent: false };
    const bad = await call(router, 'post', '/forum/post/:postId/reply', { params: { postId: 'p1' }, body: { channel: 'research', content: 'hi' } });
    expect(bad.status).toBe(400);
    expect(db.store.get(`${COMMONS_COLLECTIONS.FORUM_POSTS}/p1`)?.reply_count).toBe(0);
    const ok = await call(router, 'post', '/forum/post/:postId/reply', { params: { postId: 'p1' }, body: { content: 'hi' } });
    expect(ok.status).toBe(201);
    const created = ok.body as { channel: string; root_post_id: string; depth: number; parent_author_wallet_id: string };
    expect(created).toMatchObject({ channel: 'general', root_post_id: 'p1', depth: 1, parent_author_wallet_id: YOU });
    expect(db.store.get(`${COMMONS_COLLECTIONS.FORUM_POSTS}/p1`)?.reply_count).toBe(1);
    expect(db.store.get(`${COMMONS_COLLECTIONS.FORUM_POSTS}/p1`)?.comment_count).toBe(1);
  });
});
