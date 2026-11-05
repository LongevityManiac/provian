/**
 * the forum thread tree, its counters, votes, the hot rank, and `forum_reply` delivery.
 *
 * - a reply inherits its parent's channel, tree root and depth + 1 (at depth 2+ too), and records
 * the parent's author (the replies-inbox key);
 * - the parent's `reply_count` and the root's `comment_count` move INSIDE the reply's PE
 * transaction: a reply that did not commit counts nothing;
 * - a vote's `upvotes`/`downvotes`/`score` move inside the vote's PE transaction, and the stored
 * hot rank is recomputed after every vote and every new comment;
 * - `forum_reply` goes to the parent's author (agent → notify-only webhook outbox, human → push),
 * never to the replier themself.
 *
 * RED controls (each guard fed a violating input): a channel-mismatched reply is refused and writes
 * nothing; a PE transaction forced to fail after the reply document was buffered leaves every counter
 * where it was; a vote whose transaction fails moves no counter and does not burn the one-shot vote;
 * a self-reply sends no notification.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const pushCalls: Array<{ userId: string; message: Record<string, unknown> }> = [];
jest.mock('../notifications/pushDispatcher', () => ({
  sendPushToUser: async (_db: unknown, userId: string, message: Record<string, unknown>) => {
    pushCalls.push({ userId, message });
    return { successCount: 1, failureCount: 0, invalidTokens: [], expoCount: 0, fcmCount: 1, hadTokens: true };
  },
}));

import { createPost as createPostRaw, voteOnPost as voteOnPostRaw, recomputeHotScore, resolveTreePosition } from './forum';
import { TEST_WINDOW, actorOf } from './__test-helpers__/speech';
import { COMMONS_COLLECTIONS, hotScore, type CommonsDeps, type CommonsForumPost } from './types';
import { ValidationError } from '../agent-bank/errors';
import { AGENT_BANK_EVENT_OUTBOX_COLLECTION } from '../agent-bank/event-outbox';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { METER_RELAY_ACTS_COLLECTION } from '../meter/meter-relay-authored';

const HUMAN = 'user_frank';
const AGENT = 'wallet_aw_atlas';
const OTHER = 'wallet_aw_other';
const DAY = 24 * 60 * 60 * 1000;

function makeDeps(db: FakeFirestore): CommonsDeps {
  return {
    db,
    cache: { checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }) },
    peBuffer: { enqueue: () => {} },
    recordPEAccrual: async () => {},
  } as unknown as CommonsDeps;
}

function seed(db: FakeFirestore): void {
  for (const [id, type] of [[HUMAN, 'human'], [AGENT, 'agent'], [OTHER, 'agent']] as const) {
    db.store.set(`${COMMONS_COLLECTIONS.PROFILES}/${id}`, {
      status: 'active', participant_type: type, commons_join_date: Date.now() - 40 * DAY, pe_count: 100, display_name: id,
    });
  }
  db.store.set(`${COMMONS_COLLECTIONS.FORUM_CHANNELS}/general`, { name: 'general', post_count: 0 });
  db.store.set(`${COMMONS_COLLECTIONS.FORUM_CHANNELS}/research`, { name: 'research', post_count: 0 });
}

const isAgentId = (id: string) => id.startsWith('wallet_aw_');
const createPost = (db: FakeFirestore, walletId: string, body: Parameters<typeof createPostRaw>[2]) =>
  createPostRaw(makeDeps(db), actorOf(walletId, `agent_${walletId}`, null, isAgentId(walletId)), body, TEST_WINDOW);
const vote = (db: FakeFirestore, walletId: string, postId: string, voteType: 'upvote' | 'downvote') =>
  voteOnPostRaw(makeDeps(db), actorOf(walletId, `agent_${walletId}`, null, isAgentId(walletId)), postId, { vote_type: voteType }, TEST_WINDOW);
const postOf = (db: FakeFirestore, id: string) => db.store.get(`${COMMONS_COLLECTIONS.FORUM_POSTS}/${id}`) as unknown as CommonsForumPost;
const postCount = (db: FakeFirestore) => [...db.store.keys()].filter((k) => k.startsWith(`${COMMONS_COLLECTIONS.FORUM_POSTS}/`)).length;
// PE METER: a relay-authored act commits with the post as its staged intake (the stub accrual never
// prices it), so the intake rows ARE the PE population; the relay keeps no readable PE.
const peCount = (db: FakeFirestore) => [...db.store.keys()].filter((k) => k.startsWith(`${METER_RELAY_ACTS_COLLECTION}/`)).length;
const outbox = (db: FakeFirestore) => [...db.store.entries()]
  .filter(([k]) => k.startsWith(`${AGENT_BANK_EVENT_OUTBOX_COLLECTION}/`))
  .map(([, v]) => v as Record<string, unknown>);

beforeEach(() => { pushCalls.length = 0; });

describe(' tree fields + counters', () => {
  let db: FakeFirestore;
  beforeEach(() => { db = createFakeFirestore(); seed(db); });

  it('a top-level post carries the tree + ranking fields at their origin', async () => {
    const root = await createPost(db, HUMAN, { channel: 'general', title: 'Root', content: 'hello' });
    const stored = postOf(db, root.post_id);
    expect(stored.root_post_id).toBeNull();
    expect(stored.depth).toBe(0);
    expect(stored.parent_author_wallet_id).toBeNull();
    expect(stored.reply_count).toBe(0);
    expect(stored.comment_count).toBe(0);
    expect(stored.score).toBe(0);
    expect(stored.hot_score).toBe(hotScore(0, 0, stored.created_at));
  });

  it('replies inherit channel/root/depth at every depth; parent reply_count and root comment_count move', async () => {
    const root = await createPost(db, HUMAN, { channel: 'general', title: 'Root', content: 'hello' });
    // Depth 1 — no channel in the body: it defaults to the parent's.
    const r1 = await createPost(db, AGENT, { content: 'first', parent_post_id: root.post_id });
    expect(r1.channel).toBe('general');
    expect(r1.root_post_id).toBe(root.post_id);
    expect(r1.depth).toBe(1);
    expect(r1.parent_author_wallet_id).toBe(HUMAN);
    expect(postOf(db, root.post_id).reply_count).toBe(1);
    expect(postOf(db, root.post_id).comment_count).toBe(1);

    // Depth 2 — an explicit, MATCHING channel is accepted.
    const r2 = await createPost(db, HUMAN, { channel: 'general', content: 'second', parent_post_id: r1.post_id });
    expect(r2.root_post_id).toBe(root.post_id);
    expect(r2.depth).toBe(2);
    expect(r2.parent_author_wallet_id).toBe(AGENT);
    // Depth 3.
    const r3 = await createPost(db, OTHER, { content: 'third', parent_post_id: r2.post_id });
    expect(r3.root_post_id).toBe(root.post_id);
    expect(r3.depth).toBe(3);
    expect(r3.parent_author_wallet_id).toBe(HUMAN);

    const storedRoot = postOf(db, root.post_id);
    expect(storedRoot.reply_count).toBe(1); // direct children only
    expect(storedRoot.comment_count).toBe(3); // every descendant
    expect(postOf(db, r1.post_id).reply_count).toBe(1);
    expect(postOf(db, r2.post_id).reply_count).toBe(1);
    expect(postOf(db, r3.post_id).reply_count).toBe(0);
    // comment_count lives on the root only.
    expect(postOf(db, r1.post_id).comment_count).toBe(0);
    // The root's hot rank followed its comment count.
    expect(storedRoot.hot_score).toBe(hotScore(0, 3, storedRoot.created_at));
    expect(storedRoot.hot_score).toBeGreaterThan(hotScore(0, 0, storedRoot.created_at));
  });

  it('RED: a reply naming a different channel than its parent is refused and writes nothing', async () => {
    const root = await createPost(db, HUMAN, { channel: 'general', title: 'Root', content: 'hello' });
    const before = { posts: postCount(db), pes: peCount(db) };
    expect(before.pes).toBeGreaterThan(0); // the PE count is a real population, not a vacuous 0 === 0
    await expect(createPost(db, AGENT, { channel: 'research', content: 'wrong room', parent_post_id: root.post_id }))
      .rejects.toBeInstanceOf(ValidationError);
    expect(postCount(db)).toBe(before.posts);
    expect(peCount(db)).toBe(before.pes);
    expect(postOf(db, root.post_id).reply_count).toBe(0);
    expect(postOf(db, root.post_id).comment_count).toBe(0);
  });

  it('a top-level post still requires a channel', async () => {
    await expect(createPost(db, HUMAN, { content: 'nowhere' })).rejects.toThrow(/channel is required/);
  });

  it('a pre-backfill (legacy) parent chain is walked to its root', async () => {
    db.store.set(`${COMMONS_COLLECTIONS.FORUM_POSTS}/legacy_root`, {
      post_id: 'legacy_root', author_wallet_id: HUMAN, author_type: 'human', channel: 'general', content: 'old', parent_post_id: null, created_at: 1, upvotes: 0, downvotes: 0,
    });
    db.store.set(`${COMMONS_COLLECTIONS.FORUM_POSTS}/legacy_reply`, {
      post_id: 'legacy_reply', author_wallet_id: AGENT, author_type: 'agent', channel: 'general', content: 'old reply', parent_post_id: 'legacy_root', created_at: 2, upvotes: 0, downvotes: 0,
    });
    const pos = await resolveTreePosition(makeDeps(db), postOf(db, 'legacy_reply'));
    expect(pos).toEqual({ rootId: 'legacy_root', depth: 2, rootExists: true });
    const r = await createPost(db, OTHER, { content: 'new under old', parent_post_id: 'legacy_reply' });
    expect(r.root_post_id).toBe('legacy_root');
    expect(r.depth).toBe(2);
    expect(postOf(db, 'legacy_root').comment_count).toBe(1);
    expect(postOf(db, 'legacy_reply').reply_count).toBe(1);
  });

  it('a dangling legacy chain keeps the missing id as its root and never writes a counter to it', async () => {
    db.store.set(`${COMMONS_COLLECTIONS.FORUM_POSTS}/orphan`, {
      post_id: 'orphan', author_wallet_id: AGENT, author_type: 'agent', channel: 'general', content: 'orphaned', parent_post_id: 'gone', created_at: 2, upvotes: 0, downvotes: 0,
    });
    expect(await resolveTreePosition(makeDeps(db), postOf(db, 'orphan'))).toEqual({ rootId: 'gone', depth: 2, rootExists: false });
    const r = await createPost(db, OTHER, { content: 'under the orphan', parent_post_id: 'orphan' });
    expect(r.root_post_id).toBe('gone');
    expect(r.depth).toBe(2);
    expect(postOf(db, 'orphan').reply_count).toBe(1);
    // The fake would CREATE a missing doc on update; real Firestore would fail the reply. Neither happens.
    expect(db.store.has(`${COMMONS_COLLECTIONS.FORUM_POSTS}/gone`)).toBe(false);
  });

  it("RED : a reply DEEPER in a dangling tree (fast path) never writes a counter to the missing root", async () => {
    db.store.set(`${COMMONS_COLLECTIONS.FORUM_POSTS}/orphan`, {
      post_id: 'orphan', author_wallet_id: AGENT, author_type: 'agent', channel: 'general', content: 'orphaned', parent_post_id: 'gone', created_at: 2, upvotes: 0, downvotes: 0,
    });
    const r1 = await createPost(db, OTHER, { content: 'depth 2', parent_post_id: 'orphan' });
    // r1 carries fields whose root is the MISSING id — the next reply takes the fast path.
    expect(await resolveTreePosition(makeDeps(db), postOf(db, r1.post_id))).toEqual({ rootId: 'gone', depth: 3, rootExists: false });
    const r2 = await createPost(db, HUMAN, { content: 'depth 3', parent_post_id: r1.post_id });
    expect(r2.root_post_id).toBe('gone');
    expect(postOf(db, r1.post_id).reply_count).toBe(1);
    expect(db.store.has(`${COMMONS_COLLECTIONS.FORUM_POSTS}/gone`)).toBe(false);
  });

  it('the fast path still reports an existing root as existing', async () => {
    const root = await createPost(db, HUMAN, { channel: 'general', title: 'R', content: 'root' });
    const c1 = await createPost(db, AGENT, { content: 'c1', parent_post_id: root.post_id });
    expect(await resolveTreePosition(makeDeps(db), postOf(db, c1.post_id))).toEqual({ rootId: root.post_id, depth: 2, rootExists: true });
  });
});

describe('RED: a failed PE transaction increments nothing', () => {
  it('the reply is buffered, the counter write throws → no reply, no PE, no counter moved', async () => {
    // forum_posts transaction writes: #1 the root's set, #2 the reply's set, #3 the root counter update.
    const db = createFakeFirestore({ failTxnWriteOccurrence: { collection: COMMONS_COLLECTIONS.FORUM_POSTS, occurrence: 3 } });
    seed(db);
    const root = await createPost(db, HUMAN, { channel: 'general', title: 'Root', content: 'hello' });
    const pesBefore = peCount(db);
    expect(pesBefore).toBeGreaterThan(0);
    await expect(createPost(db, AGENT, { content: 'doomed', parent_post_id: root.post_id })).rejects.toThrow(/Injected/);
    expect(postCount(db)).toBe(1);
    expect(peCount(db)).toBe(pesBefore);
    expect(postOf(db, root.post_id).reply_count).toBe(0);
    expect(postOf(db, root.post_id).comment_count).toBe(0);
    expect(pushCalls).toHaveLength(0);
  });
});

describe(' votes: counters in the PE transaction, hot rank recomputed', () => {
  let db: FakeFirestore;
  beforeEach(() => { db = createFakeFirestore(); seed(db); });

  it('an upvote and a downvote move upvotes/downvotes/score and the stored hot rank', async () => {
    const root = await createPost(db, HUMAN, { channel: 'general', title: 'Root', content: 'hello' });
    await vote(db, AGENT, root.post_id, 'upvote');
    let p = postOf(db, root.post_id);
    expect(p.upvotes).toBe(1);
    expect(p.score).toBe(1);
    expect(p.hot_score).toBe(hotScore(1, 0, p.created_at));
    await vote(db, OTHER, root.post_id, 'downvote');
    p = postOf(db, root.post_id);
    expect(p.downvotes).toBe(1);
    expect(p.score).toBe(0);
    expect(p.hot_score).toBe(hotScore(0, 0, p.created_at));
    // The one-shot rule still holds (no un-vote, no re-vote).
    await expect(vote(db, AGENT, root.post_id, 'downvote')).rejects.toThrow(/Already voted/);
    expect(postOf(db, root.post_id).score).toBe(0);
  });

  it('RED: a vote whose PE transaction fails moves no counter and leaves the vote uncast', async () => {
    const failing = createFakeFirestore({ failTxnWriteOccurrence: { collection: COMMONS_COLLECTIONS.FORUM_POSTS, occurrence: 1 } });
    seed(failing);
    failing.store.set(`${COMMONS_COLLECTIONS.FORUM_POSTS}/p1`, {
      post_id: 'p1', author_wallet_id: HUMAN, author_type: 'human', channel: 'general', content: 'x', parent_post_id: null,
      upvotes: 0, downvotes: 0, score: 0, comment_count: 0, created_at: 1_000, hot_score: hotScore(0, 0, 1_000),
    });
    await expect(vote(failing, AGENT, 'p1', 'upvote')).rejects.toThrow(/Injected/);
    expect(postOf(failing, 'p1').upvotes).toBe(0);
    expect(postOf(failing, 'p1').score).toBe(0);
    expect(failing.store.get(`${COMMONS_COLLECTIONS.VOTES}/p1__${AGENT}`)).toBeUndefined();
    // The vote was never cast, so casting it now succeeds (it is not "Already voted").
    await vote(failing, AGENT, 'p1', 'upvote');
    expect(postOf(failing, 'p1').score).toBe(1);
  });

  it('recomputeHotScore is idempotent and self-heals a legacy row with no score', async () => {
    db.store.set(`${COMMONS_COLLECTIONS.FORUM_POSTS}/legacy`, {
      post_id: 'legacy', author_wallet_id: HUMAN, channel: 'general', content: 'x', parent_post_id: null, upvotes: 5, downvotes: 2, created_at: 90_000_000,
    });
    const h1 = await recomputeHotScore(makeDeps(db), 'legacy');
    const h2 = await recomputeHotScore(makeDeps(db), 'legacy');
    expect(h1).toBe(h2);
    expect(postOf(db, 'legacy').score).toBe(3);
    expect(postOf(db, 'legacy').hot_score).toBe(hotScore(3, 0, 90_000_000));
    await expect(recomputeHotScore(makeDeps(db), 'missing')).resolves.toBeNull();
  });
});

describe('hotScore — the ordering properties the feed relies on', () => {
  const T = 1_800_000_000_000;
  it('matches the contract formula on a worked value', () => {
    // s = 9 + 1 = 10 → order 1, sign +1; seconds/45000 = 40000.
    // Independent literals (T / 1000 / 45000 = 40000 exactly).
    expect(hotScore(9, 1, T)).toBe(40001);
    expect(hotScore(0, 0, T)).toBe(40000);
    expect(hotScore(-10, 0, T)).toBe(39999);
    expect(hotScore(99, 1, T)).toBe(40002);
  });
  it('more score ranks higher at the same age; a newer post ranks higher at the same score', () => {
    expect(hotScore(10, 0, T)).toBeGreaterThan(hotScore(1, 0, T));
    expect(hotScore(1, 0, T + 1000)).toBeGreaterThan(hotScore(1, 0, T));
    expect(hotScore(-5, 0, T)).toBeLessThan(hotScore(0, 0, T));
    // Comments count toward activity like score does.
    expect(hotScore(0, 10, T)).toBe(hotScore(10, 0, T));
  });
  it('ten times the activity buys exactly 45,000 s (12.5 h) of age', () => {
    expect(hotScore(10, 0, T - 45_000_000)).toBe(hotScore(1, 0, T));
    // RED: one second older and the 10x post falls behind.
    expect(hotScore(10, 0, T - 45_001_000)).toBeLessThan(hotScore(1, 0, T));
  });
  it('non-finite inputs never produce NaN', () => {
    expect(Number.isFinite(hotScore(Number.NaN, Number.NaN, Number.NaN))).toBe(true);
  });
});

describe('forum_reply delivery', () => {
  let db: FakeFirestore;
  beforeEach(() => { db = createFakeFirestore(); seed(db); });

  it('a human parent author is pushed the root id, the comment id and the channel (never content)', async () => {
    const root = await createPost(db, HUMAN, { channel: 'general', title: 'Root', content: 'hello' });
    const r = await createPost(db, AGENT, { content: 'secret words', parent_post_id: root.post_id });
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0].userId).toBe(HUMAN);
    expect(pushCalls[0].message.data).toEqual({ type: 'forum_reply', post_id: root.post_id, comment_id: r.post_id, channel: 'general' });
    expect(JSON.stringify(pushCalls[0].message)).not.toContain('secret words');
  });

  it('an agent parent author gets a notify-only forum_reply webhook event carrying the ROOT id', async () => {
    const root = await createPost(db, HUMAN, { channel: 'general', title: 'Root', content: 'hello' });
    const r1 = await createPost(db, AGENT, { content: 'agent comment', parent_post_id: root.post_id });
    pushCalls.length = 0;
    const r2 = await createPost(db, OTHER, { content: 'reply to agent', parent_post_id: r1.post_id });
    const events = outbox(db).filter((e) => e.event_type === 'forum_reply');
    expect(events).toHaveLength(1);
    expect(events[0].recipients).toEqual([AGENT]);
    expect(events[0].notify_only).toBe(true);
    expect(events[0].data).toEqual({ type: 'forum_reply', post_id: root.post_id, comment_id: r2.post_id, channel: 'general' });
    expect(pushCalls).toHaveLength(0);
  });

  it('RED: replying to your own post notifies nobody', async () => {
    const root = await createPost(db, HUMAN, { channel: 'general', title: 'Root', content: 'hello' });
    await createPost(db, HUMAN, { content: 'talking to myself', parent_post_id: root.post_id });
    expect(pushCalls).toHaveLength(0);
    expect(outbox(db).filter((e) => e.event_type === 'forum_reply')).toHaveLength(0);
  });
});
