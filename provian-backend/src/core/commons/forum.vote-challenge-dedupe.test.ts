/**
 * F28/F29 (S2 2026-09-10) — atomic dedupe on forum votes and challenges.
 *
 * voteOnPost checked for a duplicate with a read-then-write query and wrote the
 * vote (uuid id) AFTER, so N concurrent votes by one wallet all passed the check
 * and each incremented the post's upvotes and the author's
 * forum_upvotes_received. challengePost had NO dedupe and NO rate limit, an
 * unbounded PE + challenge_count amplifier. Both now key the entity by
 * (post, wallet) and create it INSIDE the PE transaction, and vote_type is
 * validated; challengePost also carries a rate limit.
 *
 * RED controls (fail on the pre-fix code): concurrent votes → the post gains
 * only ONE upvote (was N); concurrent challenges → challenge_count is 1 (was N);
 * an invalid vote_type is rejected (was silently counted as a downvote).
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { voteOnPost as voteOnPostRaw, challengePost as challengePostRaw } from './forum';
import { TEST_WINDOW, actorOf, seedBurn } from './__test-helpers__/speech';

const voteOnPost = (deps: Parameters<typeof voteOnPostRaw>[0], w: string, a: string, addr: string | null, postId: string, body: Parameters<typeof voteOnPostRaw>[3]) =>
  voteOnPostRaw(deps, actorOf(w, a, addr), postId, body, TEST_WINDOW);
/** a challenge names a predicate and stakes a burn (floor 15 PVT). */
const STAKE = 15_000_000_000_000_000_000n;
const PREDICATE = { field: 'work.sealed_count', op: 'gte' as const, threshold: 10 };
const challengePost = (deps: Parameters<typeof challengePostRaw>[0], w: string, a: string, addr: string | null, postId: string, body: { reason: string; burn_id?: string }) =>
  challengePostRaw(deps, actorOf(w, a, addr), postId, { predicate: PREDICATE, burn_id: body.burn_id ?? BURN_1, reason: body.reason }, TEST_WINDOW);
const BURN_1 = '1'.repeat(64);
const BURN_2 = '2'.repeat(64);
import { ValidationError, ForbiddenError } from '../agent-bank/errors';
import { COMMONS_COLLECTIONS } from './types';
import type { CommonsDeps } from './types';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';

const VOTER = 'wallet_voter';
const AUTHOR = 'wallet_author';
const POST_ID = 'post_1';

function makeDeps(db: FakeFirestore, allowRate = true): CommonsDeps {
  return {
    db,
    cache: { checkRateLimit: async () => ({ allowed: allowRate, retryAfter: allowRate ? 0 : 30 }) },
    peBuffer: { enqueue: () => {} },
    recordPEAccrual: async () => {},
  } as unknown as CommonsDeps;
}

function seed(db: FakeFirestore, voter = VOTER): void {
  db.store.set(`${COMMONS_COLLECTIONS.PROFILES}/${voter}`, { status: 'active', participant_type: 'agent' });
  db.store.set(`${COMMONS_COLLECTIONS.PROFILES}/${AUTHOR}`, { status: 'active', forum_upvotes_received: 0 });
  db.store.set(`${COMMONS_COLLECTIONS.FORUM_POSTS}/${POST_ID}`, {
    post_id: POST_ID, pe_id: 'pe_post', author_wallet_id: AUTHOR, author_type: 'agent',
    channel: 'general', content: 'x', upvotes: 0, downvotes: 0, challenge_count: 0, created_at: 0,
  });
}

describe('voteOnPost — F28 atomic dedupe + vote_type validation', () => {
  let db: FakeFirestore;
  beforeEach(() => { db = createFakeFirestore(); seed(db); });

  it('rejects an invalid vote_type before any write', async () => {
    await expect(
      voteOnPost(makeDeps(db), VOTER, 'agent_v', '0xv', POST_ID, { vote_type: 'super' as unknown as 'upvote' }),
    ).rejects.toBeInstanceOf(ValidationError);
    const post = db.store.get(`${COMMONS_COLLECTIONS.FORUM_POSTS}/${POST_ID}`);
    expect(post?.upvotes).toBe(0);
    expect(post?.downvotes).toBe(0);
  });

  it('RED: concurrent votes by one wallet add exactly ONE upvote', async () => {
    const results = await Promise.allSettled([
      voteOnPost(makeDeps(db), VOTER, 'agent_v', '0xv', POST_ID, { vote_type: 'upvote' }),
      voteOnPost(makeDeps(db), VOTER, 'agent_v', '0xv', POST_ID, { vote_type: 'upvote' }),
      voteOnPost(makeDeps(db), VOTER, 'agent_v', '0xv', POST_ID, { vote_type: 'upvote' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    const post = db.store.get(`${COMMONS_COLLECTIONS.FORUM_POSTS}/${POST_ID}`);
    expect(post?.upvotes).toBe(1);
    const author = db.store.get(`${COMMONS_COLLECTIONS.PROFILES}/${AUTHOR}`);
    expect(author?.forum_upvotes_received).toBe(1);
  });

  it('a sequential re-vote is refused', async () => {
    await voteOnPost(makeDeps(db), VOTER, 'agent_v', '0xv', POST_ID, { vote_type: 'upvote' });
    await expect(
      voteOnPost(makeDeps(db), VOTER, 'agent_v', '0xv', POST_ID, { vote_type: 'upvote' }),
    ).rejects.toThrow(/Already voted/);
  });

  it('requires a Commons profile (positive control the guard is reachable)', async () => {
    const fresh = createFakeFirestore();
    fresh.store.set(`${COMMONS_COLLECTIONS.FORUM_POSTS}/${POST_ID}`, { post_id: POST_ID, author_wallet_id: AUTHOR });
    await expect(
      voteOnPost(makeDeps(fresh), 'stranger', 'agent_s', '0xs', POST_ID, { vote_type: 'upvote' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('challengePost — F29 atomic dedupe + rate limit (+ stake single-use)', () => {
  let db: FakeFirestore;
  beforeEach(() => { db = createFakeFirestore(); seed(db); seedBurn(db, BURN_1, VOTER, STAKE); seedBurn(db, BURN_2, VOTER, STAKE); });

  it('RED: concurrent challenges by one wallet leave challenge_count at 1', async () => {
    const results = await Promise.allSettled([
      challengePost(makeDeps(db), VOTER, 'agent_v', '0xv', POST_ID, { reason: 'bad claim' }),
      challengePost(makeDeps(db), VOTER, 'agent_v', '0xv', POST_ID, { reason: 'bad claim' }),
      challengePost(makeDeps(db), VOTER, 'agent_v', '0xv', POST_ID, { reason: 'bad claim' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const post = db.store.get(`${COMMONS_COLLECTIONS.FORUM_POSTS}/${POST_ID}`);
    expect(post?.challenge_count).toBe(1);
  });

  it('is rate-limited (cache deny → ValidationError, no PE/write)', async () => {
    await expect(
      challengePost(makeDeps(db, false), VOTER, 'agent_v', '0xv', POST_ID, { reason: 'bad claim' }),
    ).rejects.toThrow(/Rate limit exceeded/);
    const post = db.store.get(`${COMMONS_COLLECTIONS.FORUM_POSTS}/${POST_ID}`);
    expect(post?.challenge_count).toBe(0);
  });

  it('a sequential re-challenge is refused', async () => {
    await challengePost(makeDeps(db), VOTER, 'agent_v', '0xv', POST_ID, { reason: 'bad claim' });
    await expect(
      challengePost(makeDeps(db), VOTER, 'agent_v', '0xv', POST_ID, { reason: 'again', burn_id: BURN_2 }),
    ).rejects.toThrow(/already challenged/);
    // The second stake was never reserved.
    expect(db.store.get(`burn_consumptions/${BURN_2}`)).toBeUndefined();
  });

  it('the stake is RESERVED on the global single-use ledger; a sub-floor or foreign burn is refused before any write', async () => {
    await challengePost(makeDeps(db), VOTER, 'agent_v', '0xv', POST_ID, { reason: 'bad claim' });
    const marker = db.store.get(`burn_consumptions/${BURN_1}`) as { product?: string; ref?: string } | undefined;
    expect(marker?.product).toBe('challenge_stake');
    expect(marker?.ref).toBe(`${POST_ID}__${VOTER}`);
    const c = db.store.get(`${COMMONS_COLLECTIONS.CHALLENGES}/${POST_ID}__${VOTER}`) as { stake_status?: string; stake_amount_atomic?: string } | undefined;
    expect(c?.stake_status).toBe('reserved');
    expect(c?.stake_amount_atomic).toBe(STAKE.toString());

    // RED controls: a burn under the 15-PVT floor, and a burn owned by another wallet.
    const other = 'wallet_other';
    db.store.set(`${COMMONS_COLLECTIONS.PROFILES}/${other}`, { status: 'active', participant_type: 'agent' });
    const LOW = '3'.repeat(64);
    seedBurn(db, LOW, other, STAKE - 1n);
    await expect(
      challengePost(makeDeps(db), other, 'agent_o', '0xo', POST_ID, { reason: 'x', burn_id: LOW }),
    ).rejects.toThrow(/burn/i);
    await expect(
      challengePost(makeDeps(db), other, 'agent_o', '0xo', POST_ID, { reason: 'x', burn_id: BURN_2 }),
    ).rejects.toThrow(/different wallet/);
    expect(db.store.get(`${COMMONS_COLLECTIONS.CHALLENGES}/${POST_ID}__${other}`)).toBeUndefined();
    const post = db.store.get(`${COMMONS_COLLECTIONS.FORUM_POSTS}/${POST_ID}`);
    expect(post?.challenge_count).toBe(1);
  });
});
