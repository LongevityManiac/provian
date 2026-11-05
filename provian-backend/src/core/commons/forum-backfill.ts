/**
 * forum backfill planner (pure). Given every stored forum post, derive the tree + ranking
 * fields each row SHOULD carry and return only the rows whose stored values differ — so a second run
 * over its own output plans nothing (idempotent). The script `scripts/backfill-forum-counts.ts` reads
 * prod, calls this, prints the plan, and writes it only with `--apply`.
 *
 * Derivations (the same rules the live writer maintains incrementally):
 * - `root_post_id` / `depth` / `parent_author_wallet_id` by walking `parent_post_id` links. A
 * dangling link (the ancestor document is gone) makes the MISSING id the root (depth 0), exactly as
 * `resolveTreePosition` does at reply time. A cycle (should never exist) is broken at the first
 * repeated node, which is treated as the root.
 * - `reply_count` = the number of posts whose `parent_post_id` is this post.
 * - `comment_count` = on a top-level post, the number of posts whose derived root is it; 0 on replies.
 * - `score` = upvotes − downvotes; `hot_score` = {@link hotScore}(score, comment_count, created_at).
 * - a top-level row whose `parent_post_id` is absent (or empty) gains the explicit `null` sentinel
 * the feed queries on (older rows predate it).
 */
import { hotScore, type CommonsForumPost } from './types';

export interface BackfillRow { id: string; data: Partial<CommonsForumPost> }
export type ForumBackfillFields = Pick<CommonsForumPost,
  'root_post_id' | 'depth' | 'parent_author_wallet_id' | 'reply_count' | 'comment_count' | 'score' | 'hot_score'> & { parent_post_id?: null };
export interface BackfillUpdate { id: string; update: Partial<ForumBackfillFields> }

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const parentOf = (row: BackfillRow): string | null => {
  const p = row.data.parent_post_id;
  return typeof p === 'string' && p.length > 0 ? p : null;
};

export function planForumBackfill(rows: BackfillRow[]): BackfillUpdate[] {
  const byId = new Map(rows.map((r) => [r.id, r]));

  // Root + depth per post (memoised walk).
  const tree = new Map<string, { root: string; depth: number }>();
  const resolve = (id: string): { root: string; depth: number } => {
    const cached = tree.get(id);
    if (cached) return cached;
    // `chain` is the walk from `id` upward; `base` is the resolved node just ABOVE its last element
    // (depth -1 when the chain's last element is itself the top-level root).
    let chain: string[] = [];
    let cur: string = id;
    let base: { root: string; depth: number };
    for (;;) {
      const known = tree.get(cur);
      if (known) { base = known; break; }
      const repeat = chain.indexOf(cur);
      if (repeat >= 0) {
        // A cycle (never produced by the writer): break it at the repeated node, which becomes a root.
        base = { root: cur, depth: 0 };
        tree.set(cur, base);
        chain = chain.slice(0, repeat); // the other cycle members resolve on their own walk
        break;
      }
      const row = byId.get(cur);
      if (!row) { base = { root: cur, depth: 0 }; break; } // dangling: the missing id is the root (depth 0)
      chain.push(cur);
      const parent = parentOf(row);
      if (!parent) { base = { root: cur, depth: -1 }; break; } // top-level: `cur` itself gets depth 0 below
      cur = parent;
    }
    let depth = base.depth;
    for (let i = chain.length - 1; i >= 0; i--) {
      depth += 1;
      tree.set(chain[i], { root: base.root, depth });
    }
    return tree.get(id) ?? base;
  };

  const replyCount = new Map<string, number>();
  const commentCount = new Map<string, number>();
  for (const row of rows) {
    const parent = parentOf(row);
    if (parent) replyCount.set(parent, (replyCount.get(parent) ?? 0) + 1);
  }
  for (const row of rows) {
    const t = resolve(row.id);
    if (t.root !== row.id) commentCount.set(t.root, (commentCount.get(t.root) ?? 0) + 1);
  }

  const out: BackfillUpdate[] = [];
  for (const row of rows) {
    const d = row.data;
    const parent = parentOf(row);
    const t = resolve(row.id);
    const isTop = t.root === row.id;
    const score = num(d.upvotes) - num(d.downvotes);
    const comments = isTop ? commentCount.get(row.id) ?? 0 : 0;
    const want: ForumBackfillFields = {
      root_post_id: isTop ? null : t.root,
      depth: isTop ? 0 : t.depth,
      parent_author_wallet_id: parent ? (byId.get(parent)?.data.author_wallet_id ?? null) : null,
      reply_count: replyCount.get(row.id) ?? 0,
      comment_count: comments,
      score,
      hot_score: hotScore(score, comments, num(d.created_at)),
    };
    const update: Partial<ForumBackfillFields> = {};
    for (const [k, v] of Object.entries(want) as Array<[keyof ForumBackfillFields, unknown]>) {
      if ((d as Record<string, unknown>)[k] !== v) (update as Record<string, unknown>)[k] = v;
    }
    if (!parent && d.parent_post_id !== null) update.parent_post_id = null; // missing field or '' → the queryable sentinel
    if (Object.keys(update).length > 0) out.push({ id: row.id, update });
  }
  return out;
}

/** Apply a plan to rows in memory (what a successful `--apply` leaves behind) — for idempotency checks. */
export function applyForumBackfill(rows: BackfillRow[], plan: BackfillUpdate[]): BackfillRow[] {
  const updates = new Map(plan.map((p) => [p.id, p.update]));
  return rows.map((r) => ({ id: r.id, data: { ...r.data, ...(updates.get(r.id) ?? {}) } }));
}
