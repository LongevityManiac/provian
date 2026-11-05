/**
 * the forum backfill planner derives every row's tree + ranking fields from the posts
 * themselves, agrees with what the live writer produces, and is idempotent.
 *
 * RED controls: a row whose stored counters were corrupted is re-planned back to the derived truth;
 * a legacy top-level row missing the `parent_post_id` sentinel gains it; a dangling parent makes the
 * missing id the root (never the orphan itself); a cycle terminates.
 */
import { describe, it, expect } from '@jest/globals';
import { applyForumBackfill, planForumBackfill, type BackfillRow } from './forum-backfill';
import { createPost } from './forum';
import { TEST_WINDOW, actorOf } from './__test-helpers__/speech';
import { COMMONS_COLLECTIONS, hotScore, type CommonsDeps, type CommonsForumPost } from './types';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';

const row = (id: string, data: Partial<CommonsForumPost>): BackfillRow => ({ id, data: { post_id: id, author_wallet_id: `author_${id}`, created_at: 1_000_000, upvotes: 0, downvotes: 0, ...data } });

describe('planForumBackfill', () => {
  it('derives root/depth/parent author/counts/score/hot for a legacy tree', () => {
    const rows = [
      row('T', { parent_post_id: null, upvotes: 4, downvotes: 1 }),
      row('A', { parent_post_id: 'T' }),
      row('B', { parent_post_id: 'A' }),
      row('C', { parent_post_id: 'B' }),
      row('D', { parent_post_id: 'T' }),
      row('L', {}), // a legacy top-level row with no sentinel at all
    ];
    const plan = new Map(planForumBackfill(rows).map((p) => [p.id, p.update]));
    expect(plan.get('T')).toEqual({ root_post_id: null, depth: 0, parent_author_wallet_id: null, reply_count: 2, comment_count: 4, score: 3, hot_score: hotScore(3, 4, 1_000_000) });
    expect(plan.get('A')).toMatchObject({ root_post_id: 'T', depth: 1, parent_author_wallet_id: 'author_T', reply_count: 1, comment_count: 0 });
    expect(plan.get('B')).toMatchObject({ root_post_id: 'T', depth: 2, parent_author_wallet_id: 'author_A', reply_count: 1 });
    expect(plan.get('C')).toMatchObject({ root_post_id: 'T', depth: 3, parent_author_wallet_id: 'author_B', reply_count: 0 });
    expect(plan.get('D')).toMatchObject({ root_post_id: 'T', depth: 1, reply_count: 0 });
    // RED: the legacy top-level row gains the queryable null sentinel.
    expect(plan.get('L')).toMatchObject({ parent_post_id: null, root_post_id: null, depth: 0 });
  });

  it('is idempotent: a second run over its own output plans nothing', () => {
    const rows = [row('T', { parent_post_id: null }), row('A', { parent_post_id: 'T' }), row('B', { parent_post_id: 'A' })];
    const after = applyForumBackfill(rows, planForumBackfill(rows));
    expect(planForumBackfill(after)).toEqual([]);
  });

  it('RED: corrupted stored counters are re-planned to the derived truth', () => {
    const rows = [row('T', { parent_post_id: null }), row('A', { parent_post_id: 'T' })];
    const good = applyForumBackfill(rows, planForumBackfill(rows));
    const corrupted = good.map((r) => (r.id === 'T' ? { ...r, data: { ...r.data, comment_count: 99, score: 7 } } : r));
    expect(planForumBackfill(corrupted)).toEqual([{ id: 'T', update: { comment_count: 1, score: 0 } }]);
  });

  it('RED: a dangling parent makes the MISSING id the root; a cycle terminates', () => {
    const plan = new Map(planForumBackfill([
      row('O', { parent_post_id: 'gone' }),
      row('P', { parent_post_id: 'O' }),
      row('X', { parent_post_id: 'Y' }),
      row('Y', { parent_post_id: 'X' }),
    ]).map((p) => [p.id, p.update]));
    expect(plan.get('O')).toMatchObject({ root_post_id: 'gone', depth: 1 });
    expect(plan.get('P')).toMatchObject({ root_post_id: 'gone', depth: 2 });
    expect(plan.get('X')).toBeDefined();
    expect(plan.get('Y')).toBeDefined();
  });

  it('agrees with what the live writer stored (a writer-built tree plans no change)', async () => {
    const db = createFakeFirestore();
    const deps = { db, cache: { checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }) }, peBuffer: { enqueue: () => {} }, recordPEAccrual: async () => {} } as unknown as CommonsDeps;
    for (const id of ['user_a', 'wallet_aw_b']) {
      db.store.set(`${COMMONS_COLLECTIONS.PROFILES}/${id}`, { status: 'active', participant_type: id.startsWith('user') ? 'human' : 'agent', commons_join_date: 0, pe_count: 100 });
    }
    db.store.set(`${COMMONS_COLLECTIONS.FORUM_CHANNELS}/general`, { name: 'general' });
    const who = (id: string) => actorOf(id, `agent_${id}`, null, id.startsWith('wallet_aw_'));
    const root = await createPost(deps, who('user_a'), { channel: 'general', title: 't', content: 'root' }, TEST_WINDOW);
    const r1 = await createPost(deps, who('wallet_aw_b'), { content: 'r1', parent_post_id: root.post_id }, TEST_WINDOW);
    await createPost(deps, who('user_a'), { content: 'r2', parent_post_id: r1.post_id }, TEST_WINDOW);
    await createPost(deps, who('wallet_aw_b'), { content: 'r3', parent_post_id: root.post_id }, TEST_WINDOW);
    const rows: BackfillRow[] = [...db.store.entries()]
      .filter(([k]) => k.startsWith(`${COMMONS_COLLECTIONS.FORUM_POSTS}/`))
      .map(([k, v]) => ({ id: k.slice(COMMONS_COLLECTIONS.FORUM_POSTS.length + 1), data: v as Partial<CommonsForumPost> }));
    expect(rows).toHaveLength(4);
    expect(planForumBackfill(rows)).toEqual([]);
  });
});
