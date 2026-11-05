/**
 * forum data layer — normalization, hot rank, votes, and the comment tree.
 * Each guard carries a RED control: a violating input the guard must catch.
 */
import { describe, it, expect } from 'vitest';
import type { ForumPost } from './CommonsService';
import {
  applyVote,
  appendUnique,
  buildCommentTree,
  challengeChipFor,
  descendantsOf,
  findCommentNode,
  flattenCommentTree,
  hotScore,
  initialsFor,
  isAlreadyVotedError,
  MAX_INLINE_DEPTH,
  MORE_TOPICS,
  normalizeForumPost,
  pathToComment,
  POSTABLE_TOPICS,
  PRIMARY_TOPICS,
  revertVote,
  sortFeed,
  topicLabelKey,
  type NormalizedForumPost,
} from './forumModel';

function post(id: string, over: Partial<ForumPost> = {}): ForumPost {
  return {
    post_id: id,
    pe_id: `pe_${id}`,
    author_wallet_id: `w_${id}`,
    author_type: 'human',
    channel: 'general',
    content: `body ${id}`,
    upvotes: 0,
    downvotes: 0,
    challenge_count: 0,
    created_at: 1_700_000_000_000,
    is_pinned: false,
    is_flagged: false,
    ...over,
  };
}

function reply(id: string, parent: string, over: Partial<ForumPost> = {}): NormalizedForumPost {
  return normalizeForumPost(post(id, { parent_post_id: parent, root_post_id: 'root', ...over }));
}

/** Every post_id in a tree, depth-first. */
function ids(nodes: ReturnType<typeof buildCommentTree>): string[] {
  const out: string[] = [];
  const walk = (list: ReturnType<typeof buildCommentTree>) => {
    for (const n of list) {
      out.push(n.comment.post_id);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

describe('topics', () => {
  it('announcements is never a chip or a postable topic', () => {
    expect(POSTABLE_TOPICS).not.toContain('announcements');
    expect([...PRIMARY_TOPICS, ...MORE_TOPICS]).toHaveLength(9);
  });
  it('maps channel names to i18n keys with dashes folded', () => {
    expect(topicLabelKey('court-watch')).toBe('commonsForum.topic.court_watch');
    expect(topicLabelKey('general')).toBe('commonsForum.topic.general');
  });
});

describe('normalizeForumPost', () => {
  it('defaults every missing field on a legacy row', () => {
    const n = normalizeForumPost(post('a', { upvotes: 3, downvotes: 1 }));
    expect(n.root_post_id).toBeNull();
    expect(n.depth).toBe(0);
    expect(n.reply_count).toBe(0);
    expect(n.comment_count).toBe(0);
    expect(n.score).toBe(2); // up − down when score is absent
    expect(n.my_vote).toBeNull();
    expect(n.counts_known).toBe(false);
    expect(Number.isFinite(n.hot_score)).toBe(true);
  });
  it('keeps relay values when present', () => {
    const n = normalizeForumPost(post('a', { score: 7, comment_count: 4, my_vote: 'upvote', root_post_id: null, depth: 0 }));
    expect(n.score).toBe(7);
    expect(n.comment_count).toBe(4);
    expect(n.my_vote).toBe('upvote');
    expect(n.counts_known).toBe(true);
  });
  it('RED: garbage numbers and an unknown vote never leak through', () => {
    const bad = post('a', { score: Number.NaN, comment_count: Number.POSITIVE_INFINITY });
    (bad as { my_vote?: unknown }).my_vote = 'sideways';
    (bad as { upvotes: unknown }).upvotes = 'lots';
    const n = normalizeForumPost(bad);
    expect(n.upvotes).toBe(0);
    expect(n.comment_count).toBe(0);
    expect(n.my_vote).toBeNull();
    expect(Number.isFinite(n.score)).toBe(true);
  });
  it('a reply with no depth defaults to depth 1', () => {
    expect(normalizeForumPost(post('r', { parent_post_id: 'p' })).depth).toBe(1);
  });
});

describe('hotScore (relay formula)', () => {
  it('matches the contract formula', () => {
    const created = 1_758_000_000_000;
    const expected = Math.round((1 * Math.log10(12) + created / 1000 / 45000) * 1e7) / 1e7;
    expect(hotScore(10, 2, created)).toBe(expected);
  });
  it('a net-negative post ranks below a zero post of the same age', () => {
    expect(hotScore(-5, 0, 1_758_000_000_000)).toBeLessThan(hotScore(0, 0, 1_758_000_000_000));
  });
});

describe('sortFeed / appendUnique', () => {
  const now = 1_758_000_000_000;
  const old = normalizeForumPost(post('old', { created_at: now - 10 * 86_400_000, score: 50 }));
  const fresh = normalizeForumPost(post('fresh', { created_at: now - 3_600_000, score: 1 }));
  it('new orders by time; top by score; top/day drops older posts', () => {
    expect(sortFeed([old, fresh], 'new', 'all', now).map((p) => p.post_id)).toEqual(['fresh', 'old']);
    expect(sortFeed([fresh, old], 'top', 'all', now).map((p) => p.post_id)).toEqual(['old', 'fresh']);
    expect(sortFeed([fresh, old], 'top', 'day', now).map((p) => p.post_id)).toEqual(['fresh']);
  });
  it('RED: an overlapping page never duplicates a post', () => {
    const merged = appendUnique([old, fresh], [fresh, normalizeForumPost(post('x'))]);
    expect(merged.map((p) => p.post_id)).toEqual(['old', 'fresh', 'x']);
  });
});

describe('votes', () => {
  it('applies an optimistic upvote once', () => {
    const p = normalizeForumPost(post('a', { upvotes: 1 }));
    const v = applyVote(p, 'upvote');
    expect(v.upvotes).toBe(2);
    expect(v.score).toBe(2);
    expect(v.my_vote).toBe('upvote');
  });
  it('RED: a second vote (either way) is a no-op — votes are one-shot', () => {
    const v = applyVote(normalizeForumPost(post('a')), 'upvote');
    expect(applyVote(v, 'upvote')).toBe(v);
    expect(applyVote(v, 'downvote')).toBe(v);
  });
  it('reverts only the vote it applied', () => {
    const v = applyVote(normalizeForumPost(post('a')), 'downvote');
    expect(revertVote(v, 'upvote')).toBe(v);
    const r = revertVote(v, 'downvote');
    expect(r.my_vote).toBeNull();
    expect(r.downvotes).toBe(0);
    expect(r.score).toBe(0);
  });
  it('recognizes the relay duplicate-vote refusal', () => {
    expect(isAlreadyVotedError(new Error('Already voted on this post'))).toBe(true);
    expect(isAlreadyVotedError(new Error('Rate limited'))).toBe(false);
    expect(isAlreadyVotedError('Already voted')).toBe(false);
  });
});

describe('buildCommentTree', () => {
  it('nests replies under their parents and counts descendants', () => {
    const tree = buildCommentTree('root', [
      reply('a', 'root'),
      reply('b', 'a'),
      reply('c', 'b'),
      reply('d', 'root'),
    ]);
    expect(tree.map((n) => n.comment.post_id).sort()).toEqual(['a', 'd']);
    const a = tree.find((n) => n.comment.post_id === 'a');
    expect(a?.descendantCount).toBe(2);
    expect(a?.children[0].level).toBe(2);
    expect(a?.children[0].children[0].level).toBe(3);
  });
  it('best puts the higher score first; new puts the newest first', () => {
    const cs = [reply('low', 'root', { score: 1, created_at: 2 }), reply('high', 'root', { score: 9, created_at: 1 })];
    expect(buildCommentTree('root', cs, 'best').map((n) => n.comment.post_id)).toEqual(['high', 'low']);
    expect(buildCommentTree('root', cs, 'new').map((n) => n.comment.post_id)).toEqual(['low', 'high']);
  });
  it('RED: an orphan (parent missing) is attached under the root, not dropped', () => {
    const tree = buildCommentTree('root', [reply('a', 'root'), reply('orphan', 'ghost')]);
    expect(ids(tree).sort()).toEqual(['a', 'orphan']);
    expect(tree.map((n) => n.comment.post_id)).toContain('orphan');
  });
  it('RED: a parent cycle neither crashes nor duplicates', () => {
    const tree = buildCommentTree('root', [reply('x', 'y'), reply('y', 'x'), reply('z', 'x'), reply('ok', 'root')]);
    const all = ids(tree);
    expect(all.sort()).toEqual(['ok', 'x', 'y', 'z']);
    expect(new Set(all).size).toBe(all.length);
  });
  it('RED: a duplicated row and the root itself render once / not at all', () => {
    const tree = buildCommentTree('root', [reply('a', 'root'), reply('a', 'root', { content: 'dup' }), normalizeForumPost(post('root'))]);
    expect(ids(tree)).toEqual(['a']);
    expect(tree[0].comment.content).toBe('body a');
  });
  it('a self-parented row is placed once under the root', () => {
    const tree = buildCommentTree('root', [reply('self', 'self')]);
    expect(ids(tree)).toEqual(['self']);
  });
});

describe('flattenCommentTree', () => {
  const chain = [reply('l1', 'root'), reply('l2', 'l1'), reply('l3', 'l2'), reply('l4', 'l3'), reply('l5', 'l4')];
  it(`renders up to depth ${MAX_INLINE_DEPTH} then one "continue" row`, () => {
    const rows = flattenCommentTree(buildCommentTree('root', chain), new Set());
    expect(rows.map((r) => (r.kind === 'comment' ? r.node.comment.post_id : `continue:${r.parentId}:${r.count}`))).toEqual([
      'l1', 'l2', 'l3', 'continue:l3:2',
    ]);
  });
  it('each row carries its ancestor ids (one per guide line)', () => {
    const rows = flattenCommentTree(buildCommentTree('root', chain), new Set());
    expect(rows.map((r) => r.ancestors)).toEqual([[], ['l1'], ['l1', 'l2'], ['l1', 'l2', 'l3']]);
    expect(rows.map((r) => r.guides)).toEqual([0, 1, 2, 3]);
  });
  it('a collapsed branch hides its subtree', () => {
    const rows = flattenCommentTree(buildCommentTree('root', chain), new Set(['l1']));
    expect(rows).toHaveLength(1);
    expect(rows[0].kind === 'comment' && rows[0].collapsed).toBe(true);
  });
  it('finds the path to a comment and the node', () => {
    const tree = buildCommentTree('root', chain);
    expect(pathToComment(tree, 'l4')).toEqual(['l1', 'l2', 'l3', 'l4']);
    expect(pathToComment(tree, 'nope')).toBeNull();
    expect(findCommentNode(tree, 'l5')?.level).toBe(5);
  });
});

describe('descendantsOf', () => {
  it('keeps only the subtree of the given comment', () => {
    const all = [reply('a', 'root'), reply('b', 'a'), reply('c', 'b'), reply('d', 'root')];
    expect(descendantsOf('a', all).map((c) => c.post_id)).toEqual(['b', 'c']);
  });
  it('RED: a cycle inside the subtree terminates', () => {
    const all = [reply('b', 'a'), reply('a', 'b')];
    expect(descendantsOf('a', all).map((c) => c.post_id)).toEqual(['b']);
  });
});

describe('challengeChipFor / initialsFor', () => {
  it('prefers the resolved outcome, else Questioned for an open challenge', () => {
    expect(challengeChipFor({ open: 1, answered: 0, upheld: 0 }, 1)).toBe('questioned');
    expect(challengeChipFor({ open: 0, answered: 1, upheld: 0 }, 1)).toBe('proof_shown');
    expect(challengeChipFor({ open: 1, answered: 1, upheld: 1 }, 3)).toBe('upheld');
    expect(challengeChipFor(undefined, 2)).toBe('questioned');
    expect(challengeChipFor(undefined, 0)).toBeNull();
  });
  it('builds initials from a name or an address', () => {
    expect(initialsFor('Maya Chen', 'w')).toBe('MC');
    expect(initialsFor('atlas', 'w')).toBe('AT');
    expect(initialsFor(null, '0xab12')).toBe('AB');
    expect(initialsFor('  ', '')).toBe('?');
  });
});
