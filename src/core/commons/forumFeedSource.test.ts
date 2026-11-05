/**
 * feed source — the list route, and the deliberate fallback to the legacy routes when
 * a pre- relay 404s it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CommonsError, type ForumPost } from './CommonsService';
import { __resetFeedSourceForTests, loadFeedPage, loadLatestAnnouncement, toPostThread, type FeedDeps } from './forumFeedSource';

function post(id: string, over: Partial<ForumPost> = {}): ForumPost {
  return {
    post_id: id, pe_id: `pe_${id}`, author_wallet_id: 'w', author_type: 'agent', channel: 'general',
    content: id, upvotes: 0, downvotes: 0, challenge_count: 0, created_at: 1000, is_pinned: false, is_flagged: false, ...over,
  };
}

const notFound = () => new CommonsError('Request failed: 404', 404);

beforeEach(() => __resetFeedSourceForTests());

describe('loadFeedPage — relay', () => {
  it('passes the query through and keeps the cursor', async () => {
    const deps: FeedDeps = {
      getForumPosts: vi.fn(async () => ({ posts: [post('a', { comment_count: 3, score: 2 })], next_cursor: 'c2' })),
      getChannelPosts: vi.fn(),
    };
    const page = await loadFeedPage({ channel: 'all', sort: 'top', window: 'week', cursor: 'c1' }, deps);
    expect(deps.getForumPosts).toHaveBeenCalledWith({ channel: 'all', sort: 'top', window: 'week', cursor: 'c1', page_size: 25 });
    expect(page).toMatchObject({ nextCursor: 'c2', legacy: false });
    expect(page.posts[0].comment_count).toBe(3);
    expect(deps.getChannelPosts).not.toHaveBeenCalled();
  });
  it('RED: a non-404 error is surfaced, not masked by the fallback', async () => {
    const deps: FeedDeps = { getForumPosts: vi.fn(async () => { throw new CommonsError('boom', 500); }), getChannelPosts: vi.fn() };
    await expect(loadFeedPage({ channel: 'all', sort: 'hot', window: 'all', cursor: null }, deps)).rejects.toThrow('boom');
    expect(deps.getChannelPosts).not.toHaveBeenCalled();
  });
});

describe('loadFeedPage — legacy fallback', () => {
  it('merges every topic for "All", drops replies + announcements + duplicates, ranks on the phone', async () => {
    const byChannel: Record<string, ForumPost[]> = {
      general: [post('g1', { created_at: 3000 }), post('reply', { parent_post_id: 'g1' })],
      technical: [post('t1', { channel: 'technical', created_at: 5000 }), post('g1')],
      jobs: [post('ann', { channel: 'announcements', created_at: 9000 })],
    };
    const deps: FeedDeps = {
      getForumPosts: vi.fn(async () => { throw notFound(); }),
      getChannelPosts: vi.fn(async (c: string) => ({ posts: byChannel[c] ?? [] })),
      now: () => 10_000,
    };
    const page = await loadFeedPage({ channel: 'all', sort: 'new', window: 'all', cursor: null }, deps);
    expect(page.legacy).toBe(true);
    expect(page.nextCursor).toBeNull();
    expect(page.posts.map((p) => p.post_id)).toEqual(['t1', 'g1']);
    // the new route is not probed again inside the retry window
    await loadFeedPage({ channel: 'general', sort: 'hot', window: 'all', cursor: null }, deps);
    expect(deps.getForumPosts).toHaveBeenCalledTimes(1);
  });
  it('a cursor on the legacy path returns an empty last page', async () => {
    const deps: FeedDeps = { getForumPosts: vi.fn(async () => { throw notFound(); }), getChannelPosts: vi.fn(async () => ({ posts: [post('a')] })) };
    const page = await loadFeedPage({ channel: 'general', sort: 'hot', window: 'all', cursor: 'x' }, deps);
    expect(page).toEqual({ posts: [], nextCursor: null, legacy: true });
  });
  it('the pinned announcement falls back too, and never throws', async () => {
    const deps: FeedDeps = {
      getForumPosts: vi.fn(async () => { throw notFound(); }),
      getChannelPosts: vi.fn(async (c: string) => ({ posts: c === 'announcements' ? [post('old', { created_at: 1 }), post('new', { created_at: 2 })] : [] })),
    };
    expect((await loadLatestAnnouncement(deps))?.post_id).toBe('new');
    const broken: FeedDeps = { getForumPosts: vi.fn(async () => { throw new Error('offline'); }), getChannelPosts: vi.fn() };
    __resetFeedSourceForTests();
    expect(await loadLatestAnnouncement(broken)).toBeNull();
  });
});

describe('toPostThread', () => {
  it('a detail keeps the whole tree for a top-level post', () => {
    const th = toPostThread({ post: post('root'), replies: [], comments: [post('a', { parent_post_id: 'root' }), post('b', { parent_post_id: 'a' })] });
    expect(th.legacy).toBe(false);
    expect(th.comments.map((c) => c.post_id)).toEqual(['a', 'b']);
    expect(th.treeRootId).toBe('root');
  });
  it('a page rooted at a comment shows only its subtree and links the root', () => {
    const th = toPostThread({
      post: post('a', { parent_post_id: 'root', root_post_id: 'root' }),
      root: post('root'),
      replies: [],
      comments: [post('a', { parent_post_id: 'root' }), post('b', { parent_post_id: 'a' }), post('other', { parent_post_id: 'root' })],
    });
    expect(th.comments.map((c) => c.post_id)).toEqual(['b']);
    expect(th.root?.post_id).toBe('root');
    expect(th.treeRootId).toBe('a');
  });
  it('a legacy detail turns direct replies into depth-1 comments', () => {
    const th = toPostThread({ post: post('root'), replies: [post('r1'), post('r2', { parent_post_id: 'root' })] });
    expect(th.legacy).toBe(true);
    expect(th.comments.map((c) => [c.post_id, c.parent_post_id, c.root_post_id])).toEqual([['r1', 'root', 'root'], ['r2', 'root', 'root']]);
  });
});
