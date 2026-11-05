/**
 * forumModel — the pure data layer of the Reddit-style forum: topic metadata, post
 * normalization (legacy rows lack the counters), the Reddit hot rank, client-side sorting
 * for the legacy fallback, the optimistic vote, and the comment tree.
 *
 * No React, no network: everything here is unit-tested (forumModel.test.ts).
 */
import type { ForumPost } from './CommonsService';

// ─── Topics ──────────────────────────────────────────────────────────────────

/** The announcement channel: never a topic chip, only the pinned card at the top of the feed. */
export const ANNOUNCEMENTS_CHANNEL = 'announcements';

/** Topic chips shown directly (in order). The relay's channel names never change; labels are i18n. */
export const PRIMARY_TOPICS = ['general', 'introductions', 'technical', 'jobs', 'human-jobs'] as const;

/** Dormant-institution channels, tucked under "More topics". */
export const MORE_TOPICS = ['governance', 'proposals', 'court-watch', 'market-talk'] as const;

/** Every channel a person may post to from the composer (announcements excluded). */
export const POSTABLE_TOPICS: readonly string[] = [...PRIMARY_TOPICS, ...MORE_TOPICS];

export type TopicIcon =
  | 'chatbubbles-outline' | 'hand-right-outline' | 'code-slash-outline' | 'briefcase-outline'
  | 'people-outline' | 'document-text-outline' | 'bulb-outline' | 'hammer-outline'
  | 'storefront-outline' | 'megaphone-outline' | 'pricetag-outline';

const TOPIC_ICONS: Record<string, TopicIcon> = {
  general: 'chatbubbles-outline',
  introductions: 'hand-right-outline',
  technical: 'code-slash-outline',
  jobs: 'briefcase-outline',
  'human-jobs': 'people-outline',
  governance: 'document-text-outline',
  proposals: 'bulb-outline',
  'court-watch': 'hammer-outline',
  'market-talk': 'storefront-outline',
  announcements: 'megaphone-outline',
};

export function topicIcon(channel: string): TopicIcon {
  return TOPIC_ICONS[channel] ?? 'pricetag-outline';
}

/** The i18n key for a channel's friendly label (`commonsForum.topic.human_jobs`, …). */
export function topicLabelKey(channel: string): string {
  return `commonsForum.topic.${channel.replace(/-/g, '_')}`;
}

/** True for a channel the app knows a friendly label for. Unknown channels render as `#name`. */
export function isKnownTopic(channel: string): boolean {
  return channel in TOPIC_ICONS;
}

// ─── Normalization ───────────────────────────────────────────────────────────

/** A forum post with every field present (legacy rows defaulted). */
export type NormalizedForumPost = ForumPost & {
  root_post_id: string | null;
  depth: number;
  reply_count: number;
  comment_count: number;
  score: number;
  hot_score: number;
  my_vote: 'upvote' | 'downvote' | null;
  /** False when the relay row predates the counters, so the comment count is not known. */
  counts_known: boolean;
};

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Default every field a legacy row lacks: numbers → 0 (score falls back to up − down), root →
 * null, my_vote → null. `counts_known` records whether `comment_count` came from the relay.
 */
export function normalizeForumPost(raw: ForumPost): NormalizedForumPost {
  const upvotes = num(raw.upvotes);
  const downvotes = num(raw.downvotes);
  const score = typeof raw.score === 'number' && Number.isFinite(raw.score) ? raw.score : upvotes - downvotes;
  const commentCount = num(raw.comment_count);
  const hasParent = typeof raw.parent_post_id === 'string' && raw.parent_post_id.length > 0;
  const root = typeof raw.root_post_id === 'string' && raw.root_post_id.length > 0 ? raw.root_post_id : null;
  const myVote = raw.my_vote === 'upvote' || raw.my_vote === 'downvote' ? raw.my_vote : null;
  return {
    ...raw,
    upvotes,
    downvotes,
    challenge_count: num(raw.challenge_count),
    root_post_id: root,
    depth: num(raw.depth, hasParent ? 1 : 0),
    reply_count: num(raw.reply_count),
    comment_count: commentCount,
    score,
    hot_score: typeof raw.hot_score === 'number' && Number.isFinite(raw.hot_score)
      ? raw.hot_score
      : hotScore(score, commentCount, num(raw.created_at)),
    my_vote: myVote,
    counts_known: typeof raw.comment_count === 'number',
  };
}

/**
 * The Reddit hot rank, byte-for-byte the relay formula (contract):
 * s = score + comment_count, order = log10(max(|s|,1)), sign = s>0?1:s<0?-1:0,
 * hot = round((sign*order + created_at_seconds/45000) * 1e7) / 1e7.
 */
export function hotScore(score: number, commentCount: number, createdAtMs: number): number {
  const s = score + commentCount;
  const order = Math.log10(Math.max(Math.abs(s), 1));
  const sign = s > 0 ? 1 : s < 0 ? -1 : 0;
  return Math.round((sign * order + createdAtMs / 1000 / 45000) * 1e7) / 1e7;
}

export type FeedSort = 'hot' | 'new' | 'top';
export type FeedWindow = 'day' | 'week' | 'all';

const WINDOW_MS: Record<FeedWindow, number> = { day: 86_400_000, week: 7 * 86_400_000, all: Number.POSITIVE_INFINITY };

/** Client-side ranking (the legacy fallback only — the relay ranks server-side). */
export function sortFeed(posts: NormalizedForumPost[], sort: FeedSort, window: FeedWindow = 'all', now: number = Date.now()): NormalizedForumPost[] {
  const list = sort === 'top' ? posts.filter((p) => now - p.created_at <= WINDOW_MS[window]) : [...posts];
  if (sort === 'new') return list.sort((a, b) => b.created_at - a.created_at);
  if (sort === 'top') return list.sort((a, b) => b.score - a.score || b.created_at - a.created_at);
  return list.sort((a, b) => b.hot_score - a.hot_score || b.created_at - a.created_at);
}

/** Merge a fetched page into the list, never duplicating a post id (a later page can overlap). */
export function appendUnique<T extends { post_id: string }>(existing: T[], page: T[]): T[] {
  const seen = new Set(existing.map((p) => p.post_id));
  const out = [...existing];
  for (const p of page) {
    if (seen.has(p.post_id)) continue;
    seen.add(p.post_id);
    out.push(p);
  }
  return out;
}

// ─── Voting ──────────────────────────────────────────────────────────────────

/**
 * The optimistic vote: add one to the chosen side and the score and mark `my_vote`. A post the
 * caller already voted on is returned unchanged (votes are one-shot — no un-vote, no switch).
 */
export function applyVote<T extends NormalizedForumPost>(post: T, vote: 'upvote' | 'downvote'): T {
  if (post.my_vote) return post;
  return vote === 'upvote'
    ? { ...post, upvotes: post.upvotes + 1, score: post.score + 1, my_vote: 'upvote' }
    : { ...post, downvotes: post.downvotes + 1, score: post.score - 1, my_vote: 'downvote' };
}

/** Undo an optimistic vote that the relay refused for a reason other than "already voted". */
export function revertVote<T extends NormalizedForumPost>(post: T, vote: 'upvote' | 'downvote'): T {
  if (post.my_vote !== vote) return post;
  return vote === 'upvote'
    ? { ...post, upvotes: Math.max(0, post.upvotes - 1), score: post.score - 1, my_vote: null }
    : { ...post, downvotes: Math.max(0, post.downvotes - 1), score: post.score + 1, my_vote: null };
}

/** True when a relay error is the duplicate-vote refusal (shown as the voted state, never raw). */
export function isAlreadyVotedError(err: unknown): boolean {
  return err instanceof Error && /already voted/i.test(err.message);
}

// ─── Comment tree ────────────────────────────────────────────────────────────

export interface CommentNode {
  comment: NormalizedForumPost;
  /** Depth below the tree root (1 = a direct reply to the post). */
  level: number;
  children: CommentNode[];
  /** Every descendant beneath this node (for "N more replies" on a collapsed branch). */
  descendantCount: number;
}

export type CommentSort = 'best' | 'new';

function compareComments(sort: CommentSort) {
  return (a: CommentNode, b: CommentNode): number =>
    sort === 'new'
      ? b.comment.created_at - a.comment.created_at
      : b.comment.score - a.comment.score || a.comment.created_at - b.comment.created_at;
}

/**
 * Build the reply tree under `rootId` from the flat `comments` list (the relay returns every
 * descendant, created_at asc). Defensive by construction:
 *  - a comment id seen twice keeps its first row (no duplicate render);
 *  - a comment whose parent is missing from the list (an orphan: parent past the 500 cap, or
 *    deleted) attaches directly under the root rather than vanishing;
 *  - a parent cycle (A→B→A) cannot recurse forever: each node is placed exactly once, and a
 *    comment whose parent chain loops is attached under the root;
 *  - the root itself, if present in `comments`, is skipped.
 */
export function buildCommentTree(rootId: string, comments: NormalizedForumPost[], sort: CommentSort = 'best'): CommentNode[] {
  const byId = new Map<string, NormalizedForumPost>();
  for (const c of comments) {
    if (!c || typeof c.post_id !== 'string' || c.post_id === rootId) continue;
    if (!byId.has(c.post_id)) byId.set(c.post_id, c);
  }

  // Resolve each comment's effective parent: its real parent when that parent is in the list and
  // the parent chain terminates (reaches the root or an orphan) without looping; otherwise the root.
  const chainTerminates = (id: string): boolean => {
    const seen = new Set<string>();
    let cur: string | null = id;
    while (cur !== null) {
      if (seen.has(cur)) return false; // cycle
      seen.add(cur);
      const row = byId.get(cur);
      const parent: string | null = row?.parent_post_id ?? null;
      if (!parent || parent === rootId || !byId.has(parent)) return true;
      cur = parent;
    }
    return true;
  };
  const effectiveParent = new Map<string, string>();
  for (const [id, row] of byId) {
    const parent = row.parent_post_id ?? null;
    effectiveParent.set(id, parent && parent !== rootId && byId.has(parent) && chainTerminates(id) ? parent : rootId);
  }

  const nodes = new Map<string, CommentNode>();
  for (const [id, row] of byId) nodes.set(id, { comment: row, level: 1, children: [], descendantCount: 0 });
  const top: CommentNode[] = [];
  for (const [id, node] of nodes) {
    const parent = effectiveParent.get(id) ?? rootId;
    if (parent === rootId) top.push(node);
    else nodes.get(parent)?.children.push(node);
  }

  const cmp = compareComments(sort);
  const finish = (list: CommentNode[], level: number): number => {
    list.sort(cmp);
    let total = 0;
    for (const n of list) {
      n.level = level;
      n.descendantCount = finish(n.children, level + 1);
      total += 1 + n.descendantCount;
    }
    return total;
  };
  finish(top, 1);
  return top;
}

/**
 * Every comment beneath `rootId` (any depth), in the input order. Cycle-safe: each id is visited
 * once. Used when a page is rooted at a comment but the relay returned the whole tree.
 */
export function descendantsOf<T extends { post_id: string; parent_post_id?: string | null }>(rootId: string, comments: T[]): T[] {
  const children = new Map<string, string[]>();
  for (const c of comments) {
    const parent = c.parent_post_id ?? null;
    if (!parent) continue;
    const list = children.get(parent);
    if (list) list.push(c.post_id);
    else children.set(parent, [c.post_id]);
  }
  const keep = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const child of children.get(id) ?? []) {
      if (child === rootId || keep.has(child)) continue;
      keep.add(child);
      queue.push(child);
    }
  }
  return comments.filter((c) => keep.has(c.post_id));
}

/** The deepest level rendered inline; deeper replies are behind "Continue this thread →". */
export const MAX_INLINE_DEPTH = 3;

export type FlatCommentRow =
  /** `ancestors`: the ids from the top-level comment down to this row's parent (one per guide line). */
  | { kind: 'comment'; node: CommentNode; collapsed: boolean; guides: number; ancestors: string[] }
  | { kind: 'continue'; parentId: string; level: number; count: number; guides: number; ancestors: string[] };

/**
 * Flatten the tree for a virtualized list: a collapsed node hides its subtree; a node at
 * MAX_INLINE_DEPTH with children gets one "Continue this thread" row instead of rendering them.
 */
export function flattenCommentTree(tree: CommentNode[], collapsed: ReadonlySet<string>): FlatCommentRow[] {
  const out: FlatCommentRow[] = [];
  const walk = (list: CommentNode[], ancestors: string[]): void => {
    for (const node of list) {
      const id = node.comment.post_id;
      const isCollapsed = collapsed.has(id);
      out.push({ kind: 'comment', node, collapsed: isCollapsed, guides: ancestors.length, ancestors });
      if (isCollapsed || node.children.length === 0) continue;
      const below = [...ancestors, id];
      if (node.level >= MAX_INLINE_DEPTH) {
        out.push({ kind: 'continue', parentId: id, level: node.level + 1, count: node.descendantCount, guides: below.length, ancestors: below });
        continue;
      }
      walk(node.children, below);
    }
  };
  walk(tree, []);
  return out;
}

/** The ids on the path from the root down to `commentId` (to expand a focused comment's branch). */
export function pathToComment(tree: CommentNode[], commentId: string): string[] | null {
  for (const node of tree) {
    if (node.comment.post_id === commentId) return [commentId];
    const sub = pathToComment(node.children, commentId);
    if (sub) return [node.comment.post_id, ...sub];
  }
  return null;
}

/** Find a node by id anywhere in the tree. */
export function findCommentNode(tree: CommentNode[], commentId: string): CommentNode | null {
  for (const node of tree) {
    if (node.comment.post_id === commentId) return node;
    const hit = findCommentNode(node.children, commentId);
    if (hit) return hit;
  }
  return null;
}

// ─── Challenge outcome chip ──────────────────────────────────────────────────

export type ChallengeChip = 'questioned' | 'proof_shown' | 'upheld' | null;

/** The small chip on a post card: an open challenge → "Questioned"; resolved → its outcome. */
export function challengeChipFor(outcomes: { open: number; answered: number; upheld: number } | undefined, challengeCount: number): ChallengeChip {
  if (outcomes) {
    if (outcomes.upheld > 0) return 'upheld';
    if (outcomes.open > 0) return 'questioned';
    if (outcomes.answered > 0) return 'proof_shown';
    return null;
  }
  return challengeCount > 0 ? 'questioned' : null;
}

/** Two-letter initials for an avatar ("Maya Chen" → "MC"; "atlas" → "AT"; an address → its hex). */
export function initialsFor(name: string | null | undefined, fallbackId: string): string {
  const src = (name ?? '').trim();
  if (src) {
    const words = src.split(/\s+/).filter(Boolean);
    const letters = words.length >= 2 ? `${words[0][0]}${words[1][0]}` : src.slice(0, 2);
    return letters.toUpperCase();
  }
  const id = fallbackId.replace(/^0x/i, '');
  return id.slice(0, 2).toUpperCase() || '?';
}
