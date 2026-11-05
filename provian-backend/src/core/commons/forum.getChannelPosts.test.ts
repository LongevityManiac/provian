/**
 * Pass-2 WS-Commons #15 — getChannelPosts must not 500 on a missing-parent
 * filter, and must list TOP-LEVEL posts (not replies).
 *
 * The bug: the listing filtered `.where('parent_post_id', '==', undefined)`.
 * Under Firestore's ignoreUndefinedProperties:true a top-level post stores no
 * parent_post_id at all, and the SDK throws SYNCHRONOUSLY when you pass
 * `undefined` as a query value → handleError → 500 → every channel listing was
 * empty.
 *
 * The fix: createPost writes an explicit `null` sentinel for top-level posts and
 * getChannelPosts queries `.where('parent_post_id', '==', null)`.
 *
 * The fake Firestore mirrors the real SDK: `.where(field, op, undefined)` throws
 * at build time. So the OLD query form throws here too (fails before the fix),
 * and the NEW `== null` form returns the top-level posts (passes after).
 */
import { describe, it, expect } from '@jest/globals';
import { getChannelPosts, createPost as createPostRaw } from './forum';
import { TEST_WINDOW, actorOf } from './__test-helpers__/speech';
const createPost = (deps: Parameters<typeof createPostRaw>[0], w: string, a: string, addr: string | null, body: Parameters<typeof createPostRaw>[2]) => createPostRaw(deps, actorOf(w, a, addr), body, TEST_WINDOW);
import { COMMONS_COLLECTIONS } from './types';
import type { CommonsDeps, CommonsForumPost } from './types';
import {
  createFakeFirestore,
  type FakeFirestore,
} from '../pvt/__test-helpers__/fake-firestore';

const DAY = 24 * 60 * 60 * 1000;

function makeDeps(db: FakeFirestore): CommonsDeps {
  return {
    db,
    cache: { checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }) },
    peBuffer: { enqueue: () => {} },
    recordPEAccrual: async () => {},
  } as unknown as CommonsDeps;
}

const WALLET = 'wallet_forum_15';

function seedProfileAndChannel(db: FakeFirestore): void {
  db.store.set(`${COMMONS_COLLECTIONS.PROFILES}/${WALLET}`, {
    status: 'active',
    commons_join_date: Date.now() - 40 * DAY, // established → no new-account daily cap
    pe_count: 100,
    participant_type: 'human',
  });
  db.store.set(`${COMMONS_COLLECTIONS.FORUM_CHANNELS}/general`, { channel_id: 'general' });
}

describe('Pass-2 #15 — forum.getChannelPosts top-level listing', () => {
  it('regression guard: the buggy `== undefined` filter throws in the real query builder', () => {
    const db = createFakeFirestore();
    expect(() =>
      db
        .collection(COMMONS_COLLECTIONS.FORUM_POSTS)
        .where('channel', '==', 'general')
        .where('parent_post_id', '==', undefined),
    ).toThrow(/undefined/);
  });

  it('createPost writes a null parent sentinel for top-level posts (queryable)', async () => {
    const db = createFakeFirestore();
    seedProfileAndChannel(db);

    const post = await createPost(makeDeps(db), WALLET, WALLET, '0xFORUM', {
      channel: 'general',
      title: 'Top level',
      content: 'hello commons',
    });

    const stored = db.store.get(
      `${COMMONS_COLLECTIONS.FORUM_POSTS}/${post.post_id}`,
    ) as unknown as CommonsForumPost;
    // Explicit null (not stripped/undefined) so the equality query can match it.
    expect(stored.parent_post_id).toBeNull();
  });

  it('lists top-level posts and excludes replies', async () => {
    const db = createFakeFirestore();
    seedProfileAndChannel(db);

    // Two top-level posts...
    const top1 = await createPost(makeDeps(db), WALLET, WALLET, '0xFORUM', {
      channel: 'general',
      content: 'first',
    });
    const top2 = await createPost(makeDeps(db), WALLET, WALLET, '0xFORUM', {
      channel: 'general',
      content: 'second',
    });
    // ...and a reply to the first (carries a real parent id).
    const reply = await createPost(makeDeps(db), WALLET, WALLET, '0xFORUM', {
      channel: 'general',
      content: 'a reply',
      parent_post_id: top1.post_id,
    });

    const posts = await getChannelPosts(makeDeps(db), 'general', {});
    const ids = posts.map((p) => p.post_id);

    expect(ids).toContain(top1.post_id);
    expect(ids).toContain(top2.post_id);
    expect(ids).not.toContain(reply.post_id);
    expect(posts).toHaveLength(2);
    // Every returned row is genuinely top-level.
    expect(posts.every((p) => p.parent_post_id == null)).toBe(true);
  });

  it('returns an empty array (not a 500) for a channel with no top-level posts', async () => {
    const db = createFakeFirestore();
    seedProfileAndChannel(db);
    await expect(getChannelPosts(makeDeps(db), 'general', {})).resolves.toEqual([]);
  });
});
