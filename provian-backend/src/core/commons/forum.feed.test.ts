/**
 * the forum READ surface: the feed (`GET /forum/posts`), the post detail's comment tree,
 * trending, the caller's own vote, the replies inbox, and the speech-window status read.
 *
 * - cursor paging over more than one page yields every row exactly once, in order, for hot / new /
 * top (all-time keyset AND the day/week offset window), per channel and for `all`;
 * - `channel=all` excludes announcements (even when announcements crowd the top of the ranking so a
 * page must read several batches to fill);
 * - top-level only: a reply never enters the feed or trending;
 * - `my_vote` is the CALLER's own vote only (never another wallet's), null when anonymous;
 * - the replies inbox holds replies BY OTHERS to the caller's posts, never self-replies and never
 * another wallet's threads, with the root's title;
 * - the speech-window status is the caller's own live window.
 *
 * RED controls: the no-skip/no-duplicate checker rejects a page run with a dropped or repeated row;
 * a vote by another wallet (and a vote document mis-keyed to the caller but voted by someone else)
 * never surfaces as `my_vote`; another wallet's live window does not make the caller live.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import { getPost, getTrendingPosts, listForumPosts, listMyReplies, withMyVotes, type ForumSort, type ForumTopWindow } from './forum';
import { speechWindowStatus, SPEECH_AUDIENCE } from './speech-window';
import { COMMONS_COLLECTIONS, hotScore, type CommonsDeps, type CommonsForumPost } from './types';
import { ValidationError } from '../agent-bank/errors';
import { RAIL_HANDSHAKE_WINDOW_MS } from '../rail/handshake';
import { seedBurn } from './__test-helpers__/speech';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';

const ME = 'user_me';
const YOU = 'wallet_aw_you';
const THIRD = 'wallet_aw_third';
const HOUR = 60 * 60 * 1000;
const NOW = Date.now();

function makeDeps(db: FakeFirestore): CommonsDeps {
  return {
    db,
    cache: { checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }) },
    peBuffer: { enqueue: () => {} },
    recordPEAccrual: async () => {},
  } as unknown as CommonsDeps;
}

interface Seed { id: string; channel: string; score: number; comments?: number; ageH: number; author?: string; parent?: string | null; root?: string | null; parentAuthor?: string | null; title?: string }
function put(db: FakeFirestore, s: Seed): void {
  const created = NOW - s.ageH * HOUR;
  const post: CommonsForumPost = {
    post_id: s.id, pe_id: `pe_${s.id}`, author_wallet_id: s.author ?? YOU, author_type: 'agent', channel: s.channel,
    title: s.title, content: s.id, parent_post_id: s.parent ?? null, upvotes: Math.max(s.score, 0), downvotes: Math.max(-s.score, 0),
    challenge_count: 0, created_at: created, edited_pe_ids: [], is_pinned: false, is_flagged: false,
    root_post_id: s.root ?? null, depth: s.parent ? 1 : 0, parent_author_wallet_id: s.parentAuthor ?? null,
    reply_count: 0, comment_count: s.comments ?? 0, score: s.score, hot_score: hotScore(s.score, s.comments ?? 0, created),
  };
  db.store.set(`${COMMONS_COLLECTIONS.FORUM_POSTS}/${s.id}`, post as unknown as Record<string, unknown>);
}

/** A varied population: ties on score (id tie-break), spread ages, two channels, announcements, replies. */
function seedFeed(db: FakeFirestore): void {
  const scores = [5, 3, 3, 0, -2, 8, 1, 3, 12, 0, 2, 7, 3, 1];
  scores.forEach((score, i) => put(db, { id: `p_${String(i).padStart(2, '0')}`, channel: i % 3 === 0 ? 'research' : 'general', score, ageH: i * 5 + 1, comments: i % 4 }));
  // Announcements with the HIGHEST hot rank — `all` must page past them.
  for (let i = 0; i < 5; i++) put(db, { id: `a_${i}`, channel: 'announcements', score: 500, ageH: 0.5, comments: 9 });
  // A reply with a huge rank must never enter the feed.
  put(db, { id: 'r_top', channel: 'general', score: 1000, ageH: 0.1, parent: 'p_00', root: 'p_00', parentAuthor: YOU });
  for (const name of ['general', 'research', 'announcements']) db.store.set(`${COMMONS_COLLECTIONS.FORUM_CHANNELS}/${name}`, { name });
}

/** Every row exactly once, in the expected order — returns the defect, or null. */
function pagingDefect(collected: string[], expected: string[]): string | null {
  const seen = new Set<string>();
  for (const id of collected) {
    if (seen.has(id)) return `duplicate ${id}`;
    seen.add(id);
  }
  for (const id of expected) if (!seen.has(id)) return `skipped ${id}`;
  if (collected.length !== expected.length) return `extra rows: ${collected.length} vs ${expected.length}`;
  for (let i = 0; i < expected.length; i++) if (collected[i] !== expected[i]) return `order at ${i}: ${collected[i]} vs ${expected[i]}`;
  return null;
}

async function pageAll(db: FakeFirestore, opts: { channel: string; sort: ForumSort; window?: ForumTopWindow }, pageSize: number): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const r = await listForumPosts(makeDeps(db), { ...opts, page_size: pageSize, cursor });
    pages += 1;
    expect(r.posts.length).toBeLessThanOrEqual(pageSize);
    ids.push(...r.posts.map((p) => p.post_id));
    if (!r.next_cursor) break;
    cursor = r.next_cursor;
    if (pages > 50) throw new Error('runaway paging');
  }
  return { ids, pages };
}

/** The expected order, computed independently from the stored rows. */
function expectedOrder(db: FakeFirestore, channel: string, field: 'hot_score' | 'created_at' | 'score', sinceMs?: number): string[] {
  return [...db.store.entries()]
    .filter(([k]) => k.startsWith(`${COMMONS_COLLECTIONS.FORUM_POSTS}/`))
    .map(([, v]) => v as unknown as CommonsForumPost)
    .filter((p) => p.parent_post_id === null)
    .filter((p) => (channel === 'all' ? p.channel !== 'announcements' : p.channel === channel))
    .filter((p) => sinceMs === undefined || p.created_at >= sinceMs)
    .sort((a, b) => (Number(b[field]) - Number(a[field])) || (a.post_id < b.post_id ? -1 : 1))
    .map((p) => p.post_id);
}

describe('GET /forum/posts — cursor paging', () => {
  let db: FakeFirestore;
  beforeEach(() => { db = createFakeFirestore(); seedFeed(db); });

  it('keeps a marked prelaunch proof in storage but out of feed and direct public reads', async () => {
    const key = `${COMMONS_COLLECTIONS.FORUM_POSTS}/p_00`;
    db.store.set(key, { ...db.store.get(key), public_visibility: 'hidden_prelaunch_test' });
    const first = await listForumPosts(makeDeps(db), { channel: 'research', sort: 'new', page_size: 3 });
    expect(first.posts).toHaveLength(3);
    expect((await pageAll(db, { channel: 'research', sort: 'new' }, 3)).ids).not.toContain('p_00');
    await expect(getPost(makeDeps(db), 'p_00')).rejects.toThrow('Post not found');
    expect(db.store.has(key)).toBe(true);
  });

  const cases: Array<{ sort: ForumSort; field: 'hot_score' | 'created_at' | 'score' }> = [
    { sort: 'hot', field: 'hot_score' }, { sort: 'new', field: 'created_at' }, { sort: 'top', field: 'score' },
  ];
  for (const { sort, field } of cases) {
    for (const channel of ['all', 'general', 'research', 'announcements']) {
      it(`${sort} / channel=${channel}: every row once, in order, across pages`, async () => {
        const expected = expectedOrder(db, channel, field);
        expect(expected.length).toBeGreaterThan(3); // more than one page at page_size 3
        const { ids, pages } = await pageAll(db, { channel, sort }, 3);
        expect(pages).toBeGreaterThan(1);
        expect(pagingDefect(ids, expected)).toBeNull();
      });
    }
  }

  for (const window of ['day', 'week'] as const) {
    it(`top / window=${window}: the offset window pages every in-window row once, by score`, async () => {
      const since = NOW - (window === 'day' ? 24 : 24 * 7) * HOUR;
      const expected = expectedOrder(db, 'all', 'score', since);
      expect(expected.length).toBeGreaterThan(2);
      const { ids, pages } = await pageAll(db, { channel: 'all', sort: 'top', window }, 2);
      expect(pages).toBeGreaterThan(1);
      expect(pagingDefect(ids, expected)).toBeNull();
      // A row older than the window is out.
      if (window === 'day') expect(ids).not.toContain('p_13');
    });
  }

  it('channel=all excludes announcements and replies; an explicit announcements channel includes them', async () => {
    const all = await pageAll(db, { channel: 'all', sort: 'hot' }, 3);
    expect(all.ids.some((id) => id.startsWith('a_'))).toBe(false);
    expect(all.ids).not.toContain('r_top');
    // The first page still fills even though 5 announcements outrank everything.
    const first = await listForumPosts(makeDeps(db), { channel: 'all', sort: 'hot', page_size: 3 });
    expect(first.posts).toHaveLength(3);
    const ann = await listForumPosts(makeDeps(db), { channel: 'announcements', sort: 'hot', page_size: 10 });
    expect(ann.posts.map((p) => p.post_id).sort()).toEqual(['a_0', 'a_1', 'a_2', 'a_3', 'a_4']);
  });

  it('page_size defaults to 25 and caps at 50; a bad cursor or sort is a ValidationError', async () => {
    for (let i = 0; i < 60; i++) put(db, { id: `bulk_${String(i).padStart(2, '0')}`, channel: 'general', score: 0, ageH: 100 + i });
    expect((await listForumPosts(makeDeps(db), { channel: 'general' })).posts).toHaveLength(25);
    expect((await listForumPosts(makeDeps(db), { channel: 'general', page_size: 500 })).posts).toHaveLength(50);
    await expect(listForumPosts(makeDeps(db), { cursor: 'not-a-cursor' })).rejects.toBeInstanceOf(ValidationError);
    await expect(listForumPosts(makeDeps(db), { sort: 'rising' as ForumSort })).rejects.toBeInstanceOf(ValidationError);
    // A window (offset) cursor is refused by a keyset sort and vice versa.
    const w = await listForumPosts(makeDeps(db), { channel: 'all', sort: 'top', window: 'week', page_size: 1 });
    expect(w.next_cursor).not.toBeNull();
    await expect(listForumPosts(makeDeps(db), { sort: 'hot', cursor: w.next_cursor! })).rejects.toBeInstanceOf(ValidationError);
  });

  it('RED: the paging checker catches a dropped row, a repeated row and a misordered row', () => {
    const expected = expectedOrder(db, 'all', 'hot_score');
    expect(pagingDefect(expected.slice(1), expected)).toMatch(/skipped/);
    expect(pagingDefect([...expected, expected[0]], expected)).toMatch(/duplicate/);
    expect(pagingDefect([expected[1], expected[0], ...expected.slice(2)], expected)).toMatch(/order/);
    expect(pagingDefect(expected, expected)).toBeNull();
  });
});

describe("RED : top within a window pins its bounds across pages", () => {
  it('a post aging out of the window between pages never shifts the offsets (no skipped row)', async () => {
    const db = createFakeFirestore();
    for (const name of ['general']) db.store.set(`${COMMONS_COLLECTIONS.FORUM_CHANNELS}/${name}`, { name });
    // Four posts inside the day window, ranked by score; the TOP one is 23.9 h old.
    put(db, { id: 'w1', channel: 'general', score: 40, ageH: 23.9 });
    put(db, { id: 'w2', channel: 'general', score: 30, ageH: 2 });
    put(db, { id: 'w3', channel: 'general', score: 20, ageH: 3 });
    put(db, { id: 'w4', channel: 'general', score: 10, ageH: 4 });
    const realNow = Date.now;
    try {
      const first = await listForumPosts(makeDeps(db), { channel: 'general', sort: 'top', window: 'day', page_size: 2 });
      expect(first.posts.map((p) => p.post_id)).toEqual(['w1', 'w2']);
      // 30 minutes pass: w1 is now older than 24 h.
      Date.now = () => realNow() + 30 * 60 * 1000;
      const second = await listForumPosts(makeDeps(db), { channel: 'general', sort: 'top', window: 'day', page_size: 2, cursor: first.next_cursor ?? undefined });
      expect(pagingDefect([...first.posts, ...second.posts].map((p) => p.post_id), ['w1', 'w2', 'w3', 'w4'])).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });
});

describe('my_vote — the caller\'s own vote only', () => {
  let db: FakeFirestore;
  beforeEach(() => {
    db = createFakeFirestore();
    seedFeed(db);
    const v = (postId: string, voter: string, type: 'upvote' | 'downvote') =>
      db.store.set(`${COMMONS_COLLECTIONS.VOTES}/${postId}__${voter}`, { vote_id: `${postId}__${voter}`, pe_id: 'pe', post_id: postId, voter_wallet_id: voter, vote_type: type, created_at: 1 });
    v('p_01', ME, 'upvote');
    v('p_02', ME, 'downvote');
    v('p_04', YOU, 'upvote'); // another wallet's vote
    // A mis-keyed document: keyed to ME, but the stored voter is someone else.
    db.store.set(`${COMMONS_COLLECTIONS.VOTES}/p_05__${ME}`, { post_id: 'p_05', voter_wallet_id: THIRD, vote_type: 'upvote' });
  });

  it('attaches the caller\'s own votes on the feed and null elsewhere', async () => {
    const { ids } = await pageAll(db, { channel: 'all', sort: 'new' }, 50);
    expect(ids.length).toBeGreaterThan(5);
    const page = await listForumPosts(makeDeps(db), { channel: 'all', sort: 'new', page_size: 50, callerWalletId: ME });
    const mine = Object.fromEntries(page.posts.map((p) => [p.post_id, p.my_vote]));
    expect(mine.p_01).toBe('upvote');
    expect(mine.p_02).toBe('downvote');
    // RED: another wallet's vote, and a mis-keyed foreign vote, never surface as the caller's.
    expect(mine.p_04).toBeNull();
    expect(mine.p_05).toBeNull();
    // The other wallet sees ITS vote, not mine.
    const theirs = await withMyVotes(makeDeps(db), page.posts, YOU);
    expect(theirs.find((p) => p.post_id === 'p_04')?.my_vote).toBe('upvote');
    expect(theirs.find((p) => p.post_id === 'p_01')?.my_vote).toBeNull();
  });

  it('anonymous reads carry my_vote null', async () => {
    const page = await listForumPosts(makeDeps(db), { channel: 'all', sort: 'new', page_size: 50 });
    expect(page.posts.length).toBeGreaterThan(0);
    expect(page.posts.every((p) => p.my_vote === null)).toBe(true);
  });
});

describe('post detail comment tree + trending', () => {
  let db: FakeFirestore;
  beforeEach(() => {
    db = createFakeFirestore();
    put(db, { id: 'root', channel: 'general', score: 1, ageH: 10, author: ME, title: 'The root', comments: 3 });
    put(db, { id: 'c1', channel: 'general', score: 0, ageH: 9, author: YOU, parent: 'root', root: 'root', parentAuthor: ME });
    put(db, { id: 'c2', channel: 'general', score: 0, ageH: 8, author: ME, parent: 'c1', root: 'root', parentAuthor: YOU });
    put(db, { id: 'c3', channel: 'general', score: 0, ageH: 7, author: THIRD, parent: 'c2', root: 'root', parentAuthor: ME });
    put(db, { id: 'other_root', channel: 'general', score: 0, ageH: 1, author: THIRD });
    put(db, { id: 'x1', channel: 'general', score: 0, ageH: 0.5, author: YOU, parent: 'other_root', root: 'other_root', parentAuthor: THIRD });
    db.store.set(`${COMMONS_COLLECTIONS.VOTES}/c2__${ME}`, { post_id: 'c2', voter_wallet_id: ME, vote_type: 'upvote' });
  });

  it('returns every descendant oldest-first, the root for a reply, and my_vote on each', async () => {
    const d = await getPost(makeDeps(db), 'root', { callerWalletId: ME });
    expect(d.comments.map((c) => c.post_id)).toEqual(['c1', 'c2', 'c3']);
    expect(d.replies.map((c) => c.post_id)).toEqual(['c1']); // direct children stay for compatibility
    expect(d.root).toBeNull();
    expect(d.comments.find((c) => c.post_id === 'c2')?.my_vote).toBe('upvote');
    expect(d.post.my_vote).toBeNull();
    const fromReply = await getPost(makeDeps(db), 'c2', { callerWalletId: ME });
    expect(fromReply.root?.post_id).toBe('root');
    expect(fromReply.comments.map((c) => c.post_id)).toEqual(['c1', 'c2', 'c3']);
    expect(fromReply.post.my_vote).toBe('upvote');
    const anon = await getPost(makeDeps(db), 'root');
    expect(anon.comments.every((c) => c.my_vote === null)).toBe(true);
  });

  it('a legacy thread (no root_post_id on its replies) still renders its direct replies', async () => {
    const legacy = createFakeFirestore();
    legacy.store.set(`${COMMONS_COLLECTIONS.FORUM_POSTS}/old`, { post_id: 'old', author_wallet_id: ME, channel: 'general', content: 'x', parent_post_id: null, created_at: 1, upvotes: 0, downvotes: 0 });
    legacy.store.set(`${COMMONS_COLLECTIONS.FORUM_POSTS}/old_r`, { post_id: 'old_r', author_wallet_id: YOU, channel: 'general', content: 'y', parent_post_id: 'old', created_at: 2, upvotes: 0, downvotes: 0 });
    const d = await getPost(makeDeps(legacy), 'old');
    expect(d.comments.map((c) => c.post_id)).toEqual(['old_r']);
    const fromReply = await getPost(makeDeps(legacy), 'old_r');
    expect(fromReply.root?.post_id).toBe('old');
    expect(fromReply.comments.map((c) => c.post_id)).toEqual(['old_r']);
  });

  it("RED : an old thread that gains ONE new-style reply still shows its older replies", async () => {
    const legacy = createFakeFirestore();
    legacy.store.set(`${COMMONS_COLLECTIONS.FORUM_POSTS}/old`, { post_id: 'old', author_wallet_id: ME, channel: 'general', content: 'x', parent_post_id: null, created_at: 1, upvotes: 0, downvotes: 0 });
    legacy.store.set(`${COMMONS_COLLECTIONS.FORUM_POSTS}/old_r1`, { post_id: 'old_r1', author_wallet_id: YOU, channel: 'general', content: 'y', parent_post_id: 'old', created_at: 2, upvotes: 0, downvotes: 0 });
    legacy.store.set(`${COMMONS_COLLECTIONS.FORUM_POSTS}/old_r2`, { post_id: 'old_r2', author_wallet_id: THIRD, channel: 'general', content: 'z', parent_post_id: 'old', created_at: 3, upvotes: 0, downvotes: 0 });
    legacy.store.set(`${COMMONS_COLLECTIONS.FORUM_POSTS}/new_r`, { post_id: 'new_r', author_wallet_id: YOU, channel: 'general', content: 'n', parent_post_id: 'old_r1', root_post_id: 'old', depth: 2, created_at: 4, upvotes: 0, downvotes: 0 });
    const d = await getPost(makeDeps(legacy), 'old');
    expect(d.comments.map((c) => c.post_id)).toEqual(['old_r1', 'old_r2', 'new_r']);
    const fromNew = await getPost(makeDeps(legacy), 'new_r');
    expect(fromNew.comments.map((c) => c.post_id)).toEqual(['old_r1', 'old_r2', 'new_r']);
  });

  it('trending is top-level only, by stored hot rank', async () => {
    put(db, { id: 'hot_reply', channel: 'general', score: 10_000, ageH: 0.01, parent: 'root', root: 'root', parentAuthor: ME });
    const posts = await getTrendingPosts(makeDeps(db), { page_size: 10 });
    const ids = posts.map((p) => p.post_id);
    expect(ids).not.toContain('hot_reply');
    expect(ids.every((id) => id === 'root' || id === 'other_root')).toBe(true);
    const hots = posts.map((p) => p.hot_score ?? 0);
    expect([...hots].sort((a, b) => b - a)).toEqual(hots);
  });
});

describe('GET /forum/replies/mine — the replies inbox', () => {
  it('holds replies BY OTHERS to the caller, newest first, with the root title; never self-replies or other threads', async () => {
    const db = createFakeFirestore();
    put(db, { id: 'root', channel: 'general', score: 0, ageH: 50, author: ME, title: 'My question' });
    put(db, { id: 'other_root', channel: 'general', score: 0, ageH: 50, author: THIRD, title: 'Not mine' });
    for (let i = 0; i < 7; i++) {
      put(db, { id: `yours_${i}`, channel: 'general', score: 0, ageH: 40 - i, author: YOU, parent: 'root', root: 'root', parentAuthor: ME });
    }
    put(db, { id: 'self', channel: 'general', score: 0, ageH: 1, author: ME, parent: 'root', root: 'root', parentAuthor: ME });
    put(db, { id: 'theirs', channel: 'general', score: 0, ageH: 1, author: YOU, parent: 'other_root', root: 'other_root', parentAuthor: THIRD });

    const ids: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = await listMyReplies(makeDeps(db), ME, { page_size: 3, cursor });
      pages += 1;
      for (const reply of r.replies) {
        expect(reply.root_title).toBe('My question');
        expect(reply.author_wallet_id).not.toBe(ME);
      }
      ids.push(...r.replies.map((p) => p.post_id));
      cursor = r.next_cursor ?? undefined;
    } while (cursor && pages < 20);
    expect(pages).toBeGreaterThan(1);
    expect(pagingDefect(ids, ['yours_6', 'yours_5', 'yours_4', 'yours_3', 'yours_2', 'yours_1', 'yours_0'])).toBeNull();
    // RED: the self-reply and the other wallet's thread are in the store but never in the inbox.
    expect(db.store.has(`${COMMONS_COLLECTIONS.FORUM_POSTS}/self`)).toBe(true);
    expect(ids).not.toContain('self');
    expect(ids).not.toContain('theirs');
    // The other author's inbox holds 'theirs' and nothing of mine.
    const third = await listMyReplies(makeDeps(db), THIRD, {});
    expect(third.replies.map((p) => p.post_id)).toEqual(['theirs']);
  });
});

describe('GET /speech-window — the caller\'s talking pass', () => {
  const BURN = 'e'.repeat(64);
  const AGENT = 'wallet_aw_speaker';
  const presentation = (db: FakeFirestore, walletId: string, recordedAt: number) =>
    db.store.set(`commons_presentations/pres_${walletId}_${recordedAt}`, {
      wallet_id: walletId, audience: SPEECH_AUDIENCE, recorded_at: recordedAt, burn_id: BURN, presentation_id: `jti_${recordedAt}`, tier: 'pe_fact',
    });

  it('live with its expiry for an agent with a live presentation; not live otherwise', async () => {
    const db = createFakeFirestore();
    seedBurn(db, BURN, AGENT, 5_000_000_000_000_000_000n);
    const t = 1_800_000_000_000;
    expect(await speechWindowStatus(db as unknown as Firestore, { walletId: AGENT, isAgent: true }, t))
      .toEqual({ live: false, expires_at: null, audience: 'provian:commons' });
    presentation(db, AGENT, t - HOUR);
    expect(await speechWindowStatus(db as unknown as Firestore, { walletId: AGENT, isAgent: true }, t))
      .toEqual({ live: true, expires_at: t - HOUR + RAIL_HANDSHAKE_WINDOW_MS, audience: 'provian:commons' });
    // Lapsed.
    expect((await speechWindowStatus(db as unknown as Firestore, { walletId: AGENT, isAgent: true }, t + RAIL_HANDSHAKE_WINDOW_MS)).live).toBe(false);
    // RED: another wallet's live window does not make this caller live.
    expect((await speechWindowStatus(db as unknown as Firestore, { walletId: 'wallet_aw_someone_else', isAgent: true }, t)).live).toBe(false);
  });

  it('a human resolves through their first-party wallet id (the presenter id)', async () => {
    const db = createFakeFirestore();
    const t = 1_800_000_000_000;
    db.store.set('wallets/wdoc_me', { user_id: ME, type: 'human', address: `0x${'1'.repeat(40)}` });
    seedBurn(db, BURN, 'wdoc_me', 5_000_000_000_000_000_000n);
    presentation(db, 'wdoc_me', t - HOUR);
    const s = await speechWindowStatus(db as unknown as Firestore, { walletId: ME, isAgent: false }, t);
    expect(s.live).toBe(true);
    // RED: the same presentation filed under the user id (not the presenter id) opens nothing.
    const wrong = createFakeFirestore();
    wrong.store.set('wallets/wdoc_me', { user_id: ME, type: 'human', address: `0x${'1'.repeat(40)}` });
    presentation(wrong, ME, t - HOUR);
    expect((await speechWindowStatus(wrong as unknown as Firestore, { walletId: ME, isAgent: false }, t)).live).toBe(false);
  });
});
