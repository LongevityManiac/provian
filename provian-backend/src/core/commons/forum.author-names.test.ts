/**
 * §1.6 — forum headers render what the author's Commons profile PUBLISHES: the display name is
 * joined at read time (never stored on the post), and an author without a profile renders the id.
 */
import { describe, it, expect } from '@jest/globals';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { withAuthorNames, getChannelPosts } from './forum';
import type { CommonsDeps } from './types';
import type { CommonsForumPost } from './types';

const post = (id: string, author: string, extra: Partial<CommonsForumPost> = {}): CommonsForumPost => ({
  post_id: id, pe_id: `pe_${id}`, author_wallet_id: author, author_type: 'agent', channel: 'general', content: 'x',
  parent_post_id: null, upvotes: 0, downvotes: 0, challenge_count: 0, created_at: 1, edited_pe_ids: [], is_pinned: false, is_flagged: false, ...extra,
} as CommonsForumPost);

describe('withAuthorNames', () => {
  it('attaches the published display name; an author without a profile gets null; nothing else leaks', async () => {
    const db = createFakeFirestore();
    db.store.set('commons_profiles/wallet_aw_atlas', { wallet_id: 'wallet_aw_atlas', display_name: 'Atlas', bio: 'secret-ish bio', pvt_balance: 999 });
    const deps = { db } as unknown as CommonsDeps;
    const out = await withAuthorNames(deps, [post('p1', 'wallet_aw_atlas'), post('p2', 'wallet_aw_nobody')]);
    expect(out[0].author_display_name).toBe('Atlas');
    expect(out[1].author_display_name).toBeNull();
    expect(JSON.stringify(out)).not.toContain('secret-ish bio');
    expect(JSON.stringify(out)).not.toContain('999');
  });

  it('RED: a blank display name is treated as no name (renders the id), never an empty header', async () => {
    const db = createFakeFirestore();
    db.store.set('commons_profiles/wallet_aw_blank', { wallet_id: 'wallet_aw_blank', display_name: '   ' });
    const out = await withAuthorNames({ db } as unknown as CommonsDeps, [post('p1', 'wallet_aw_blank')]);
    expect(out[0].author_display_name).toBeNull();
  });

  it('the channel read carries the name end to end, and the stored post is never rewritten', async () => {
    const db = createFakeFirestore();
    db.store.set('commons_profiles/wallet_aw_atlas', { wallet_id: 'wallet_aw_atlas', display_name: 'Atlas' });
    db.store.set('commons_forum_posts/p1', { ...post('p1', 'wallet_aw_atlas') } as unknown as Record<string, unknown>);
    const posts = await getChannelPosts({ db } as unknown as CommonsDeps, 'general', {});
    expect(posts.map((p) => p.author_display_name)).toEqual(['Atlas']);
    expect((db.store.get('commons_forum_posts/p1') as Record<string, unknown>).author_display_name).toBeUndefined();
  });
});
