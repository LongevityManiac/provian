/**
 * forumFeedSource — where the feed and the post page get their data, with a deliberate
 * fallback to the pre- relay.
 *
 * The new relay serves `GET /forum/posts` (ranked, cursor-paged, top-level only) and a post detail
 * with the whole reply tree (`comments`). A relay that predates 404s the list route and returns
 * only direct `replies`. Rather than show an empty forum, the feed then reads the legacy routes —
 * `/forum/channel/:name` per topic (merged for "All") — and ranks client-side with the same hot
 * formula, as one page. After a 404 the new route is not retried for LEGACY_RETRY_MS.
 *
 * Network calls are injected (`FeedDeps`) so the fallback is unit-tested.
 */
import { CommonsError, type ForumPost, type ForumPostDetail } from './CommonsService';
import {
  ANNOUNCEMENTS_CHANNEL,
  descendantsOf,
  POSTABLE_TOPICS,
  normalizeForumPost,
  sortFeed,
  type FeedSort,
  type FeedWindow,
  type NormalizedForumPost,
} from './forumModel';

export interface FeedQuery {
  /** 'all' or a channel name. */
  channel: string;
  sort: FeedSort;
  window: FeedWindow;
  cursor: string | null;
  pageSize?: number;
}

export interface FeedPage {
  posts: NormalizedForumPost[];
  nextCursor: string | null;
  /** True when the page came from the legacy routes (one page, ranked on the phone). */
  legacy: boolean;
}

export interface FeedDeps {
  getForumPosts: (p: { channel?: string; sort?: FeedSort; window?: FeedWindow; cursor?: string | null; page_size?: number }) => Promise<{ posts: ForumPost[]; next_cursor: string | null }>;
  getChannelPosts: (channel: string, p?: { page_size?: number }) => Promise<{ posts: ForumPost[] }>;
  now?: () => number;
}

/** After the list route 404s, use the legacy routes for this long before probing again. */
export const LEGACY_RETRY_MS = 10 * 60_000;
export const DEFAULT_PAGE_SIZE = 25;
const LEGACY_CHANNEL_PAGE = 50;

let legacyUntil = 0;

export function isRouteMissing(err: unknown): boolean {
  return err instanceof CommonsError && err.status === 404;
}

function topLevel(p: ForumPost): boolean {
  return !p.parent_post_id;
}

async function legacyChannel(deps: FeedDeps, channel: string): Promise<ForumPost[]> {
  const r = await deps.getChannelPosts(channel, { page_size: LEGACY_CHANNEL_PAGE });
  return Array.isArray(r.posts) ? r.posts : [];
}

async function loadLegacyPage(q: FeedQuery, deps: FeedDeps, now: number): Promise<FeedPage> {
  // The legacy routes are one page; a cursor means "the rest", and there is none.
  if (q.cursor) return { posts: [], nextCursor: null, legacy: true };
  let raw: ForumPost[];
  if (q.channel === 'all') {
    const settled = await Promise.allSettled(POSTABLE_TOPICS.map((c) => legacyChannel(deps, c)));
    const ok = settled.filter((s): s is PromiseFulfilledResult<ForumPost[]> => s.status === 'fulfilled');
    if (ok.length === 0) {
      const firstErr = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
      throw firstErr?.reason ?? new Error('forum unavailable');
    }
    raw = ok.flatMap((s) => s.value);
  } else {
    raw = await legacyChannel(deps, q.channel);
  }
  const seen = new Set<string>();
  const posts = raw
    .filter((p) => p && typeof p.post_id === 'string' && topLevel(p) && (q.channel !== 'all' || p.channel !== ANNOUNCEMENTS_CHANNEL))
    .filter((p) => (seen.has(p.post_id) ? false : (seen.add(p.post_id), true)))
    .map(normalizeForumPost);
  return { posts: sortFeed(posts, q.sort, q.window, now), nextCursor: null, legacy: true };
}

/** One page of the feed: the list route, or the legacy routes when the relay lacks it. */
export async function loadFeedPage(q: FeedQuery, deps: FeedDeps): Promise<FeedPage> {
  const now = deps.now ? deps.now() : Date.now();
  if (now < legacyUntil) return loadLegacyPage(q, deps, now);
  try {
    const r = await deps.getForumPosts({
      channel: q.channel,
      sort: q.sort,
      window: q.sort === 'top' ? q.window : undefined,
      cursor: q.cursor,
      page_size: q.pageSize ?? DEFAULT_PAGE_SIZE,
    });
    const posts = (Array.isArray(r.posts) ? r.posts : [])
      .filter((p) => p && typeof p.post_id === 'string')
      .map(normalizeForumPost);
    return { posts, nextCursor: typeof r.next_cursor === 'string' && r.next_cursor ? r.next_cursor : null, legacy: false };
  } catch (err) {
    if (!isRouteMissing(err)) throw err;
    legacyUntil = now + LEGACY_RETRY_MS;
    return loadLegacyPage(q, deps, now);
  }
}

/** The newest top-level announcement (the pinned card), or null. Never throws. */
export async function loadLatestAnnouncement(deps: FeedDeps): Promise<NormalizedForumPost | null> {
  try {
    const page = await loadFeedPage({ channel: ANNOUNCEMENTS_CHANNEL, sort: 'new', window: 'all', cursor: null, pageSize: 1 }, deps);
    const top = [...page.posts].sort((a, b) => b.created_at - a.created_at)[0];
    return top ?? null;
  } catch {
    return null;
  }
}

export interface PostThread {
  /** The post this page is about (a top-level post, or the comment the page is rooted at). */
  post: NormalizedForumPost;
  /** The top-level post of the tree when `post` is itself a reply (null when `post` is the root). */
  root: NormalizedForumPost | null;
  /** Every descendant in the tree (legacy relay: direct replies only). */
  comments: NormalizedForumPost[];
  /** The id the comment tree hangs from (always `post.post_id`). */
  treeRootId: string;
  legacy: boolean;
}

/**
 * Normalize a post detail for the post page. A relay returns the whole tree (`comments`) and,
 * for a reply, its `root`. A legacy relay returns only direct `replies` they become depth-1
 * comments of the requested post.
 */
export function toPostThread(detail: ForumPostDetail): PostThread {
  const post = normalizeForumPost(detail.post);
  const root = detail.root ? normalizeForumPost(detail.root) : null;
  if (Array.isArray(detail.comments)) {
    // The relay returns the WHOLE tree of the top-level post; a page rooted at a comment shows
    // only that comment's descendants.
    const all = detail.comments.filter((c) => c && typeof c.post_id === 'string').map(normalizeForumPost);
    const isRoot = !post.parent_post_id;
    return {
      post,
      root: isRoot ? null : root,
      comments: isRoot ? all.filter((c) => c.post_id !== post.post_id) : descendantsOf(post.post_id, all),
      treeRootId: post.post_id,
      legacy: false,
    };
  }
  const replies = (Array.isArray(detail.replies) ? detail.replies : [])
    .filter((c) => c && typeof c.post_id === 'string')
    .map((c) => normalizeForumPost({ ...c, parent_post_id: c.parent_post_id ?? post.post_id, root_post_id: c.root_post_id ?? post.post_id }));
  return { post, root: null, comments: replies, treeRootId: post.post_id, legacy: true };
}

/** Test-only. */
export function __resetFeedSourceForTests(): void {
  legacyUntil = 0;
}
