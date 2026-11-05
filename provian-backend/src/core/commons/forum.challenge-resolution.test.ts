/**
 * forum challenges resolve by BURN-TO-PRESENT, not Court (unit layer).
 *
 * A challenger stakes a burn (reserved on the global single-use ledger, product `challenge_stake`)
 * and names one predicate from the presentation vocabulary. The author answers by presenting
 * against it inside the window (verify-at-submit):
 * predicate true → challenge `answered`, the stake stays CONSUMED (it burned);
 * predicate false → challenge `upheld`, the stake RETURNS (its marker is released) and the post
 * is flagged;
 * no presentation → the challenge stands (`upheld`) when the window lapses; the stake returns.
 * Only the outcome is public; the predicate never renders on the post.
 *
 * RED controls: a release only removes the marker THIS challenge reserved (product + ref match);
 * a non-author cannot answer; a resolved challenge is terminal; a lapsed window settles on the
 * author's late answer and refuses it.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockVerify = jest.fn<(...args: unknown[]) => Promise<{ verdict: string; predicate_results: unknown[]; reason?: string; presenter?: { sub: string; presenter_address: string; burn_id: string } }>>();
jest.mock('../pe/presentation-submit-verify', () => ({
  verifyFreshPresentationToken: (...args: unknown[]) => mockVerify(...args),
}));

import {
  ANSWER_CLAIM_TTL_MS,
  answerChallenge,
  getChallenge,
  getPost,
  resolveChallenge,
  settleExpiredChallenge,
  sweepChallengeStanding,
  toPublicChallenge,
} from './forum';
import { COMMONS_COLLECTIONS } from './types';
import type { CommonsDeps, CommonsChallenge, CommonsForumPost } from './types';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { seedBurn } from './__test-helpers__/speech';
import { relayIntakes } from '../pvt/__test-helpers__/meter-acts';

/**
 * PE METER (2026-10-03): the relay keeps no readable PE. A Commons act is staged in its chain-tip
 * transaction as an intake whose act record carries the PE's pricing projection (metadata,
 * agent_id, wallet_id … — everything but identity and free text); the stub accrual never prices it,
 * so the intakes ARE the sealed acts. A pre-meter envelope (`provenance_envelopes`, read only by the
 * legacy answer-outcome fallback) still counts, so "exactly one answer PE" spans both homes.
 */
function actsOfType(db: FakeFirestore, type: string): Array<Record<string, unknown>> {
  const legacy = [...db.store.entries()]
    .filter(([k]) => k.startsWith('provenance_envelopes/'))
    .map(([, v]) => v as Record<string, unknown>)
    .filter((e) => e.action_type === type);
  const staged = relayIntakes(db.store)
    .filter((i) => i.act.action_type === type)
    .map((i) => ({ ...i.act.pricing, pe_id: i.pe_id, action_type: i.act.action_type }));
  return [...legacy, ...staged];
}

function makeDeps(db: FakeFirestore): CommonsDeps {
  return {
    db,
    cache: { checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }) },
    peBuffer: { enqueue: () => {} },
    recordPEAccrual: async () => {},
  } as unknown as CommonsDeps;
}

const CHALLENGER = 'wallet_aw_challenger';
const AUTHOR = 'wallet_aw_author';
const POST_ID = 'post_under_challenge';
const CHALLENGE_ID = `${POST_ID}__${CHALLENGER}`;
const STAKE_BURN = 'c'.repeat(64);
const ANSWER_BURN = 'd'.repeat(64);
const STAKE = 15_000_000_000_000_000_000n;
const NOW = 1_800_000_000_000;
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function seedPost(db: FakeFirestore, over: Partial<CommonsForumPost> = {}): void {
  db.store.set(`${COMMONS_COLLECTIONS.FORUM_POSTS}/${POST_ID}`, {
    post_id: POST_ID, pe_id: 'pe_post', author_wallet_id: AUTHOR, author_type: 'agent',
    channel: 'general', content: 'a contested claim', upvotes: 0, downvotes: 0,
    challenge_count: 1, created_at: NOW - 1000, is_pinned: false, is_flagged: false, parent_post_id: null,
    ...over,
  });
}

function seedChallenge(db: FakeFirestore, over: Partial<CommonsChallenge> = {}): void {
  db.store.set(`${COMMONS_COLLECTIONS.CHALLENGES}/${CHALLENGE_ID}`, {
    challenge_id: CHALLENGE_ID, pe_id: 'pe_challenge', post_id: POST_ID,
    challenger_wallet_id: CHALLENGER, author_wallet_id: AUTHOR, reason: 'unsupported',
    predicate: { field: 'work.sealed_count', op: 'gte', threshold: 10 },
    stake_burn_id: STAKE_BURN, stake_amount_atomic: STAKE.toString(), stake_status: 'reserved',
    audience: `challenge:${CHALLENGE_ID}`, challenge_nonce: 'ab'.repeat(32),
    status: 'open', window_expires_at: NOW + WINDOW_MS, created_at: NOW,
    ...over,
  });
  db.store.set(`burn_consumptions/${STAKE_BURN}`, {
    burn_id: STAKE_BURN, product: 'challenge_stake', wallet_id: CHALLENGER, ref: CHALLENGE_ID, consumed_at: NOW,
  });
  seedBurn(db, STAKE_BURN, CHALLENGER, STAKE);
}

function seedWallets(db: FakeFirestore): void {
  db.store.set(`agent_wallets/${CHALLENGER}`, { id: CHALLENGER, agent_id: 'agent_challenger', address: '0xchallenger', status: 'active' });
  db.store.set(`agent_wallets/${AUTHOR}`, { id: AUTHOR, agent_id: 'agent_author', address: '0xauthor', status: 'active' });
  db.store.set(`${COMMONS_COLLECTIONS.PROFILES}/${AUTHOR}`, { status: 'active', participant_type: 'agent' });
}

const AUTHOR_ACTOR = { walletId: AUTHOR, agentId: 'agent_author', actorAddress: '0xauthor', isAgent: true };
const VERIFY_DEPS = { publicKeys: [], peAnchorContract: null };
// The co-signed presenter binding a VALID token carries: the author's own id/address + the burn it consumed.
const PRESENTER = { sub: AUTHOR, presenter_address: AUTHOR_ACTOR.actorAddress.toLowerCase(), burn_id: ANSWER_BURN };
const read = (db: FakeFirestore) => db.store.get(`${COMMONS_COLLECTIONS.CHALLENGES}/${CHALLENGE_ID}`) as unknown as CommonsChallenge;
const readPost = (db: FakeFirestore) => db.store.get(`${COMMONS_COLLECTIONS.FORUM_POSTS}/${POST_ID}`) as unknown as CommonsForumPost;

let db: FakeFirestore;
beforeEach(() => {
  mockVerify.mockReset();
  db = createFakeFirestore();
  seedPost(db); seedChallenge(db); seedWallets(db);
  seedBurn(db, ANSWER_BURN, AUTHOR, 5_000_000_000_000_000_000n);
  jest.spyOn(Date, 'now').mockReturnValue(NOW + 1000);
});

describe('answerChallenge — the author presents against the predicate', () => {
  it('predicate TRUE → answered; the stake stays consumed (it burned); the post is not flagged', async () => {
    mockVerify.mockResolvedValue({ verdict: 'valid', presenter: PRESENTER, predicate_results: [{ field: 'work.sealed_count', op: 'gte', result: true }] });
    const out = await answerChallenge(makeDeps(db), AUTHOR_ACTOR, CHALLENGE_ID, { burn_id: ANSWER_BURN, presentation_token: 'tok' }, VERIFY_DEPS);
    expect(out.status).toBe('answered');
    expect(out.resolution).toBe('predicate_true');
    expect(out.stake_status).toBe('consumed');
    expect(out.answer_pe_id).toBeTruthy();
    expect(out.answer_burn_id).toBe(ANSWER_BURN);
    expect(out.resolution_pe_id).toBeTruthy();
    // The verify call was bound to the challenge's own audience + nonce and ONLY its predicate.
    const [input] = mockVerify.mock.calls[0] as [{ audience: string; challenge: string; predicates: unknown[] }];
    expect(input.audience).toBe(`challenge:${CHALLENGE_ID}`);
    expect(input.challenge).toBe('ab'.repeat(32));
    expect(input.predicates).toEqual([{ field: 'work.sealed_count', op: 'gte', threshold: 10 }]);
    const stored = read(db);
    expect(stored.status).toBe('answered');
    expect(db.store.get(`burn_consumptions/${STAKE_BURN}`)).toBeDefined();
    expect(db.store.get(`burn_consumption_releases/${STAKE_BURN}__${CHALLENGE_ID}`)).toBeUndefined();
    expect(readPost(db).is_flagged).toBe(false);
  });

  it('the sealed answer carries its own outcome on the claim, so an expiry can finish it (RED: only the PE id was stored)', async () => {
    mockVerify.mockResolvedValue({ verdict: 'valid', presenter: PRESENTER, predicate_results: [{ field: 'work.sealed_count', op: 'gte', result: true }] });
    const out = await answerChallenge(makeDeps(db), AUTHOR_ACTOR, CHALLENGE_ID, { burn_id: ANSWER_BURN, presentation_token: 'tok' }, VERIFY_DEPS);
    expect(read(db).answer_claim).toMatchObject({ answer_pe_id: out.answer_pe_id, predicate_true: true, answer_burn_id: ANSWER_BURN });
  });

  it('predicate FALSE → upheld; the stake returns (marker released, release audited); the post is flagged', async () => {
    mockVerify.mockResolvedValue({ verdict: 'valid', presenter: PRESENTER, predicate_results: [{ field: 'work.sealed_count', op: 'gte', result: false }] });
    const out = await answerChallenge(makeDeps(db), AUTHOR_ACTOR, CHALLENGE_ID, { burn_id: ANSWER_BURN, presentation_token: 'tok' }, VERIFY_DEPS);
    expect(out.status).toBe('upheld');
    expect(out.resolution).toBe('predicate_false');
    // A VALID token whose predicate is false: the claim stores the predicate's result, not the verdict.
    expect(read(db).answer_claim).toMatchObject({ answer_pe_id: out.answer_pe_id, predicate_true: false });
    expect(out.stake_status).toBe('released');
    expect(db.store.get(`burn_consumptions/${STAKE_BURN}`)).toBeUndefined();
    const release = db.store.get(`burn_consumption_releases/${STAKE_BURN}__${CHALLENGE_ID}`) as { reason?: string; product?: string } | undefined;
    expect(release?.reason).toBe('predicate_false');
    expect(release?.product).toBe('challenge_stake');
    expect(readPost(db).is_flagged).toBe(true);
  });

  it('an INVALID token (wrong binding / expired) counts as predicate not held → upheld, stake returns', async () => {
    mockVerify.mockResolvedValue({ verdict: 'invalid', predicate_results: [], reason: 'bad_signature' });
    const out = await answerChallenge(makeDeps(db), AUTHOR_ACTOR, CHALLENGE_ID, { burn_id: ANSWER_BURN, presentation_token: 'tok' }, VERIFY_DEPS);
    expect(out.status).toBe('upheld');
    expect(out.stake_status).toBe('released');
  });

  it('RED: only the challenged post\'s author can answer', async () => {
    mockVerify.mockResolvedValue({ verdict: 'valid', presenter: PRESENTER, predicate_results: [{ result: true }] });
    await expect(
      answerChallenge(makeDeps(db), { walletId: CHALLENGER, agentId: 'agent_challenger', actorAddress: '0xchallenger', isAgent: true }, CHALLENGE_ID, { burn_id: ANSWER_BURN, presentation_token: 'tok' }, VERIFY_DEPS),
    ).rejects.toThrow(/author/);
    expect(mockVerify).not.toHaveBeenCalled();
    expect(read(db).status).toBe('open');
  });

  it('RED: a lapsed window SETTLES the challenge (stands) and refuses the late answer', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW + WINDOW_MS + 1);
    mockVerify.mockResolvedValue({ verdict: 'valid', presenter: PRESENTER, predicate_results: [{ result: true }] });
    await expect(
      answerChallenge(makeDeps(db), AUTHOR_ACTOR, CHALLENGE_ID, { burn_id: ANSWER_BURN, presentation_token: 'tok' }, VERIFY_DEPS),
    ).rejects.toThrow(/lapsed/);
    expect(mockVerify).not.toHaveBeenCalled();
    const stored = read(db);
    expect(stored.status).toBe('upheld');
    expect(stored.resolution).toBe('no_presentation');
    expect(stored.stake_status).toBe('released');
    expect(db.store.get(`burn_consumptions/${STAKE_BURN}`)).toBeUndefined();
  });

  it('a resolved challenge is terminal', async () => {
    seedChallenge(db, { status: 'answered', resolution: 'predicate_true', stake_status: 'consumed' });
    await expect(
      answerChallenge(makeDeps(db), AUTHOR_ACTOR, CHALLENGE_ID, { burn_id: ANSWER_BURN, presentation_token: 'tok' }, VERIFY_DEPS),
    ).rejects.toThrow(/already answered/);
  });
});

describe('settleExpiredChallenge / resolveChallenge', () => {
  it('inside the window: nothing changes', async () => {
    const c = await settleExpiredChallenge(makeDeps(db), CHALLENGE_ID, NOW + 10);
    expect(c.status).toBe('open');
    expect(db.store.get(`burn_consumptions/${STAKE_BURN}`)).toBeDefined();
  });

  it('after the window with no presentation: the challenge stands and the stake returns', async () => {
    const c = await settleExpiredChallenge(makeDeps(db), CHALLENGE_ID, NOW + WINDOW_MS + 1);
    expect(c.status).toBe('upheld');
    expect(c.resolution).toBe('no_presentation');
    expect(readPost(db).is_flagged).toBe(true);
    expect(db.store.get(`burn_consumptions/${STAKE_BURN}`)).toBeUndefined();
  });

  it('getPost settles lapsed challenges lazily and surfaces ONLY the outcome (never the predicate)', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW + WINDOW_MS + 1);
    const view = await getPost(makeDeps(db), POST_ID);
    expect(view.challenges).toHaveLength(1);
    const pub = view.challenges[0] as unknown as Record<string, unknown>;
    expect(pub.status).toBe('upheld');
    expect(pub.resolution).toBe('no_presentation');
    expect(pub).not.toHaveProperty('predicate');
    expect(pub).not.toHaveProperty('challenge_nonce');
    expect(pub).not.toHaveProperty('stake_burn_id');
    expect(view.challenge_outcomes.upheld).toBe(1);
    expect(toPublicChallenge(read(db))).not.toHaveProperty('predicate');
  });

  it('RED: a release removes ONLY the marker this challenge reserved (product + ref must match)', async () => {
    db.store.set(`burn_consumptions/${STAKE_BURN}`, { burn_id: STAKE_BURN, product: 'vouch', wallet_id: CHALLENGER, ref: 'someone_else', consumed_at: NOW });
    const c = await resolveChallenge(makeDeps(db), CHALLENGE_ID, 'no_presentation', { nowMs: NOW + 5 });
    expect(c.stake_status).toBe('released');
    expect(db.store.get(`burn_consumptions/${STAKE_BURN}`)).toBeDefined();
    expect(db.store.get(`burn_consumption_releases/${STAKE_BURN}__${CHALLENGE_ID}`)).toBeUndefined();
  });

  it('resolve is idempotent on a terminal challenge (no second release, no second PE)', async () => {
    const first = await resolveChallenge(makeDeps(db), CHALLENGE_ID, 'no_presentation', { nowMs: NOW + 5 });
    const again = await resolveChallenge(makeDeps(db), CHALLENGE_ID, 'predicate_true', { nowMs: NOW + 6 });
    expect(again.status).toBe('upheld');
    expect(again.resolution).toBe('no_presentation');
    expect(again.resolution_pe_id).toBe(first.resolution_pe_id);
  });

  it('getChallenge returns the full record (party view) with the predicate', async () => {
    const c = await getChallenge(makeDeps(db), CHALLENGE_ID);
    expect(c.predicate).toEqual({ field: 'work.sealed_count', op: 'gte', threshold: 10 });
  });
});

describe('answerChallenge — bindings the caller cannot supply (review defects 1/2/6)', () => {
  it('RED: a THIRD PARTY\'s valid token cannot answer for the author (presenter.sub ≠ author)', async () => {
    mockVerify.mockResolvedValue({ verdict: 'valid', presenter: { ...PRESENTER, sub: CHALLENGER }, predicate_results: [{ result: true }] });
    await expect(
      answerChallenge(makeDeps(db), AUTHOR_ACTOR, CHALLENGE_ID, { presentation_token: 'tok' }, VERIFY_DEPS),
    ).rejects.toThrow(/author's own/);
    expect(read(db).status).toBe('open');
    expect(read(db).answer_claim ?? null).toBeNull();
  });

  it('RED: a token whose address is not the author\'s is refused', async () => {
    mockVerify.mockResolvedValue({ verdict: 'valid', presenter: { ...PRESENTER, presenter_address: '0xsomeoneelse' }, predicate_results: [{ result: true }] });
    await expect(
      answerChallenge(makeDeps(db), AUTHOR_ACTOR, CHALLENGE_ID, { presentation_token: 'tok' }, VERIFY_DEPS),
    ).rejects.toThrow(/author's own/);
    expect(read(db).status).toBe('open');
  });

  it('RED: the budget burn is the token\'s co-signed burn, and it must be the AUTHOR\'s verified burn — a burn owned by another wallet is refused', async () => {
    const OTHERS_BURN = 'e'.repeat(64);
    seedBurn(db, OTHERS_BURN, CHALLENGER, 15_000_000_000_000_000_000n);
    mockVerify.mockResolvedValue({ verdict: 'valid', presenter: { ...PRESENTER, burn_id: OTHERS_BURN }, predicate_results: [{ result: true }] });
    await expect(
      answerChallenge(makeDeps(db), AUTHOR_ACTOR, CHALLENGE_ID, { presentation_token: 'tok' }, VERIFY_DEPS),
    ).rejects.toThrow(/burn/);
    expect(read(db).status).toBe('open');
  });

  it('RED: a body burn_id that disagrees with the token\'s burn is refused; the body field never selects the budget', async () => {
    mockVerify.mockResolvedValue({ verdict: 'valid', presenter: PRESENTER, predicate_results: [{ result: true }] });
    await expect(
      answerChallenge(makeDeps(db), AUTHOR_ACTOR, CHALLENGE_ID, { burn_id: 'b'.repeat(64), presentation_token: 'tok' }, VERIFY_DEPS),
    ).rejects.toThrow(/does not match/);
    expect(read(db).status).toBe('open');
  });

  it('exactly ONE answer PE for N concurrent answers (the transactional claim)', async () => {
    mockVerify.mockResolvedValue({ verdict: 'valid', presenter: PRESENTER, predicate_results: [{ result: true }] });
    const results = await Promise.allSettled([1, 2, 3].map(() =>
      answerChallenge(makeDeps(db), AUTHOR_ACTOR, CHALLENGE_ID, { presentation_token: 'tok' }, VERIFY_DEPS)));
    const answered = actsOfType(db, 'commons_challenge_answered');
    expect(answered).toHaveLength(1);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(read(db).status).toBe('answered');
  });
});

describe('answerChallenge — the claim never strands a challenge (round-2 defect 2)', () => {
  it('a crash between claim and seal: every submission waits out the claim TTL (in flight), then the retry proceeds with exactly one PE', async () => {
    mockVerify.mockResolvedValue({ verdict: 'valid', presenter: PRESENTER, predicate_results: [{ result: true }] });
    const jti = `ans_${require('crypto').createHash('sha256').update('tok').digest('hex').slice(0, 24)}`;
    // Simulate: the claim committed, the process died before the PE sealed.
    const ref = `${COMMONS_COLLECTIONS.CHALLENGES}/${CHALLENGE_ID}`;
    db.store.set(ref, { ...(db.store.get(ref) as Record<string, unknown>), answer_claim: { presentation_jti: jti, claimed_at: NOW + 1000 } });
    // Inside the TTL every submission is refused — the first answer may still be in flight.
    await expect(answerChallenge(makeDeps(db), AUTHOR_ACTOR, CHALLENGE_ID, { presentation_token: 'tok2' }, VERIFY_DEPS)).rejects.toThrow(/already being answered/);
    await expect(answerChallenge(makeDeps(db), AUTHOR_ACTOR, CHALLENGE_ID, { presentation_token: 'tok' }, VERIFY_DEPS)).rejects.toThrow(/already being answered/);
    // After the TTL the stranded claim is replaced and the answer proceeds (still well inside the 7-day window).
    jest.spyOn(Date, 'now').mockReturnValue(NOW + 1000 + ANSWER_CLAIM_TTL_MS + 1);
    const out = await answerChallenge(makeDeps(db), AUTHOR_ACTOR, CHALLENGE_ID, { presentation_token: 'tok' }, VERIFY_DEPS);
    expect(out.status).toBe('answered');
    const answered = actsOfType(db, 'commons_challenge_answered');
    expect(answered).toHaveLength(1);
  });

  it('a STALE claim (older than the TTL, no PE) is replaced by a fresh answer', async () => {
    mockVerify.mockResolvedValue({ verdict: 'valid', presenter: PRESENTER, predicate_results: [{ result: true }] });
    const ref = `${COMMONS_COLLECTIONS.CHALLENGES}/${CHALLENGE_ID}`;
    db.store.set(ref, { ...(db.store.get(ref) as Record<string, unknown>), answer_claim: { presentation_jti: 'ans_stale', claimed_at: NOW + 1000 - ANSWER_CLAIM_TTL_MS - 1 } });
    const out = await answerChallenge(makeDeps(db), AUTHOR_ACTOR, CHALLENGE_ID, { presentation_token: 'tok' }, VERIFY_DEPS);
    expect(out.status).toBe('answered');
  });

  it('the sealed PE is WRITTEN onto the claim; a crash before resolution + a same-token retry reuses it (one PE, round 3)', async () => {
    mockVerify.mockResolvedValue({ verdict: 'valid', presenter: PRESENTER, predicate_results: [{ result: true }] });
    const ref = `${COMMONS_COLLECTIONS.CHALLENGES}/${CHALLENGE_ID}`;
    const first = await answerChallenge(makeDeps(db), AUTHOR_ACTOR, CHALLENGE_ID, { presentation_token: 'tok' }, VERIFY_DEPS);
    const stored = db.store.get(ref) as { answer_claim?: { answer_pe_id?: string } };
    expect(stored.answer_claim?.answer_pe_id).toBe(first.answer_pe_id); // the write, not a hand-seeded value
    // Simulate a crash AFTER the seal and BEFORE resolution: the challenge is still open, the claim carries the PE.
    db.store.set(ref, { ...(db.store.get(ref) as Record<string, unknown>), status: 'open', resolution: null, answer_pe_id: null, resolved_at: null });
    const retry = await answerChallenge(makeDeps(db), AUTHOR_ACTOR, CHALLENGE_ID, { presentation_token: 'tok' }, VERIFY_DEPS);
    expect(retry.status).toBe('answered');
    expect(retry.answer_pe_id).toBe(first.answer_pe_id);
    const answered = actsOfType(db, 'commons_challenge_answered');
    expect(answered).toHaveLength(1);
  });

  it('a retry of the same answer after the PE sealed but before resolution REUSES the sealed PE (no second PE)', async () => {
    mockVerify.mockResolvedValue({ verdict: 'valid', presenter: PRESENTER, predicate_results: [{ result: true }] });
    const jti = `ans_${require('crypto').createHash('sha256').update('tok').digest('hex').slice(0, 24)}`;
    const ref = `${COMMONS_COLLECTIONS.CHALLENGES}/${CHALLENGE_ID}`;
    // The sealed answer PE as the relay writes it: it names its challenge and carries its outcome.
    db.store.set('provenance_envelopes/pe_prior_answer', { action_type: 'commons_challenge_answered', wallet_id: AUTHOR, metadata: { challenge_id: CHALLENGE_ID, predicate_true: true } });
    db.store.set(ref, { ...(db.store.get(ref) as Record<string, unknown>), answer_claim: { presentation_jti: jti, claimed_at: NOW + 1000, answer_pe_id: 'pe_prior_answer' } });
    const out = await answerChallenge(makeDeps(db), AUTHOR_ACTOR, CHALLENGE_ID, { presentation_token: 'tok' }, VERIFY_DEPS);
    expect(out.status).toBe('answered');
    expect(out.answer_pe_id).toBe('pe_prior_answer');
    const answered = actsOfType(db, 'commons_challenge_answered');
    expect(answered).toHaveLength(1);
  });
});


describe('an upheld challenge is one adverse Standing event on the CHALLENGED party', () => {
  const { deriveCompositionSignals, countsAsAdverse } = jest.requireActual('../pvt/actor-stats') as typeof import('../pvt/actor-stats');
  let db: FakeFirestore;
  beforeEach(() => { db = createFakeFirestore(); seedPost(db); seedChallenge(db); seedWallets(db); });
  const envelopes = (): Array<Record<string, unknown>> => actsOfType(db, 'commons_challenge_resolved');
  const adverseRows = () => envelopes().filter((e) => countsAsAdverse('commons_challenge_resolved', deriveCompositionSignals(e.metadata, null)));

  it('upheld → the author gets their own sealed row and it is the ONE row that counts (RED: before, only the challenger had a row)', async () => {
    const c = await resolveChallenge(makeDeps(db), CHALLENGE_ID, 'predicate_false', { nowMs: NOW + 5 });
    expect(c.status).toBe('upheld');
    const rows = envelopes();
    expect(rows.map((e) => (e.metadata as Record<string, unknown>).role).sort()).toEqual(['challenged', 'challenger']);
    const counted = adverseRows();
    expect(counted).toHaveLength(1);
    expect(counted[0].agent_id).toBe('agent_author');
    expect(db.store.get(`${COMMONS_COLLECTIONS.CHALLENGES}/${CHALLENGE_ID}`)).toMatchObject({ standing_pending: false, challenged_pe_id: expect.any(String) });
    // Only the outcome is public: the Standing bookkeeping never reaches the projection.
    expect(toPublicChallenge(db.store.get(`${COMMONS_COLLECTIONS.CHALLENGES}/${CHALLENGE_ID}`) as unknown as CommonsChallenge)).not.toHaveProperty('challenged_pe_id');
  });

  it('answered (the predicate held) marks nobody', async () => {
    await resolveChallenge(makeDeps(db), CHALLENGE_ID, 'predicate_true', { nowMs: NOW + 5 });
    expect(envelopes()).toHaveLength(1); // the challenger's record only
    expect(adverseRows()).toHaveLength(0);
    expect((db.store.get(`${COMMONS_COLLECTIONS.CHALLENGES}/${CHALLENGE_ID}`) as Record<string, unknown>).standing_pending).toBeUndefined();
  });

  it('the sweep settles a lapsed window nobody read, seals the author\'s row, and never seals it twice', async () => {
    const deps = makeDeps(db);
    // RED: with no reader and no sweep the challenge is still open and nobody is marked.
    expect((db.store.get(`${COMMONS_COLLECTIONS.CHALLENGES}/${CHALLENGE_ID}`) as unknown as CommonsChallenge).status).toBe('open');
    const first = await sweepChallengeStanding(deps, NOW + WINDOW_MS + 1);
    expect(first).toMatchObject({ expired_settled: 1, failures: 0 });
    expect(adverseRows()).toHaveLength(1);
    const again = await sweepChallengeStanding(deps, NOW + WINDOW_MS + 2);
    expect(again).toMatchObject({ expired_settled: 0, standing_sealed: 0, failures: 0 });
    expect(adverseRows()).toHaveLength(1);
  });

  it('a request that died after the terminal write: the sweep seals the row once, even if run twice over the same pending flag', async () => {
    const deps = makeDeps(db);
    // The terminal state as the transaction leaves it, with the row not yet sealed.
    seedChallenge(db, { status: 'upheld', resolution: 'no_presentation', stake_status: 'released', resolved_at: NOW + 5, standing_pending: true } as Partial<CommonsChallenge>);
    expect(adverseRows()).toHaveLength(0);
    expect((await sweepChallengeStanding(deps, NOW + 10)).standing_sealed).toBe(1);
    // Force the flag back (as if the flag update had been lost): the lock still refuses a second row.
    db.store.set(`${COMMONS_COLLECTIONS.CHALLENGES}/${CHALLENGE_ID}`, { ...(db.store.get(`${COMMONS_COLLECTIONS.CHALLENGES}/${CHALLENGE_ID}`) as object), standing_pending: true });
    await sweepChallengeStanding(deps, NOW + 11);
    expect(adverseRows()).toHaveLength(1);
  });

  it('a challenge inside its window is not touched by the sweep', async () => {
    expect(await sweepChallengeStanding(makeDeps(db), NOW + 1)).toMatchObject({ expired_settled: 0, standing_sealed: 0 });
    expect(envelopes()).toHaveLength(0);
  });

  it('an answer claimed in time is never lapsed by the sweep (RED: the sweep upheld the challenge against the author)', async () => {
    const deps = makeDeps(db);
    const after = NOW + WINDOW_MS + 1;
    // In flight: claimed seconds before expiry, answer PE not sealed yet.
    seedChallenge(db, { answer_claim: { presentation_jti: 'ans_x', claimed_at: NOW + WINDOW_MS - 5_000 } } as Partial<CommonsChallenge>);
    expect(await sweepChallengeStanding(deps, after)).toMatchObject({ expired_settled: 0, standing_sealed: 0, failures: 0 });
    expect((db.store.get(`${COMMONS_COLLECTIONS.CHALLENGES}/${CHALLENGE_ID}`) as unknown as CommonsChallenge).status).toBe('open');
    expect(adverseRows()).toHaveLength(0);

    // Sealed a TRUE answer, then the request died before its resolve: the sweep finishes the answer.
    seedChallenge(db, { answer_claim: { presentation_jti: 'ans_x', claimed_at: NOW + WINDOW_MS - 5_000, answer_pe_id: 'pe_ans', predicate_true: true } } as Partial<CommonsChallenge>);
    await sweepChallengeStanding(deps, after);
    expect((db.store.get(`${COMMONS_COLLECTIONS.CHALLENGES}/${CHALLENGE_ID}`) as unknown as CommonsChallenge)).toMatchObject({ status: 'answered', resolution: 'predicate_true' });
    expect(adverseRows()).toHaveLength(0);
  });

  it('a sealed FALSE answer is finished as upheld on its own outcome; a stale claim with no answer lapses', async () => {
    const deps = makeDeps(db);
    seedChallenge(db, { answer_claim: { presentation_jti: 'ans_x', claimed_at: NOW + 10, answer_pe_id: 'pe_ans', predicate_true: false } } as Partial<CommonsChallenge>);
    await sweepChallengeStanding(deps, NOW + WINDOW_MS + 1);
    expect((db.store.get(`${COMMONS_COLLECTIONS.CHALLENGES}/${CHALLENGE_ID}`) as unknown as CommonsChallenge)).toMatchObject({ status: 'upheld', resolution: 'predicate_false' });
    expect(adverseRows()).toHaveLength(1);

    db = createFakeFirestore(); seedPost(db); seedWallets(db);
    seedChallenge(db, { answer_claim: { presentation_jti: 'ans_x', claimed_at: NOW + 10 } } as Partial<CommonsChallenge>);
    await sweepChallengeStanding(makeDeps(db), NOW + WINDOW_MS + 1);
    expect((db.store.get(`${COMMONS_COLLECTIONS.CHALLENGES}/${CHALLENGE_ID}`) as unknown as CommonsChallenge)).toMatchObject({ status: 'upheld', resolution: 'no_presentation' });
  });

  it('every open challenge is read: a lapsed one behind a full first page of live ones is still settled (RED: one fixed page hid it)', async () => {
    const deps = makeDeps(db);
    const base = db.store.get(`${COMMONS_COLLECTIONS.CHALLENGES}/${CHALLENGE_ID}`) as Record<string, unknown>;
    // Two challenges still inside their windows, with ids that sort before the lapsed one.
    for (const id of ['!a', '!b']) db.store.set(`${COMMONS_COLLECTIONS.CHALLENGES}/${id}`, { ...base, challenge_id: id, window_expires_at: NOW + 10 * WINDOW_MS });
    const at = NOW + WINDOW_MS + 1;
    expect(await sweepChallengeStanding(deps, at, 1)).toMatchObject({ expired_settled: 1, failures: 0 });
    expect(adverseRows()).toHaveLength(1);
  });
});

describe('a lapse means the author did not answer — a sealed answer is never settled as unanswered', () => {
  const { deriveCompositionSignals, countsAsAdverse } = jest.requireActual('../pvt/actor-stats') as typeof import('../pvt/actor-stats');
  const key = `${COMMONS_COLLECTIONS.CHALLENGES}/${CHALLENGE_ID}`;
  const envelopesOf = (type: string): Array<Record<string, unknown>> => actsOfType(db, type);
  const adverseOnAuthor = () => envelopesOf('commons_challenge_resolved')
    .filter((e) => countsAsAdverse('commons_challenge_resolved', deriveCompositionSignals(e.metadata, null)));
  const TRUE_ANSWER = { verdict: 'valid', presenter: PRESENTER, predicate_results: [{ field: 'work.sealed_count', op: 'gte', result: true }] };
  const FALSE_ANSWER = { verdict: 'valid', presenter: PRESENTER, predicate_results: [{ field: 'work.sealed_count', op: 'gte', result: false }] };
  const AFTER = NOW + WINDOW_MS + 60 * 60 * 1000; // past the window AND past the claim age

  /** The answering request dies the moment its answer PE has sealed: every later write it makes fails. */
  function dieOnceAnswerSealed(): () => void {
    const realTxn = db.runTransaction.bind(db);
    const realCollection = db.collection.bind(db);
    const sealedNow = (): boolean => envelopesOf('commons_challenge_answered').length > 0;
    (db as unknown as { runTransaction: unknown }).runTransaction = async (fn: never) => {
      if (sealedNow()) throw new Error('process died');
      return realTxn(fn);
    };
    (db as unknown as { collection: unknown }).collection = (name: string) => {
      const col = realCollection(name);
      if (name !== COMMONS_COLLECTIONS.CHALLENGES) return col;
      const realDoc = col.doc.bind(col);
      return Object.assign(Object.create(col) as object, {
        doc: (id: string) => {
          const ref = realDoc(id);
          return Object.assign(Object.create(ref) as object, {
            update: async (patch: never) => { if (sealedNow()) throw new Error('process died'); return ref.update(patch); },
          });
        },
      });
    };
    return () => {
      (db as unknown as { runTransaction: unknown }).runTransaction = realTxn;
      (db as unknown as { collection: unknown }).collection = realCollection;
    };
  }

  it('RED on the old code: the request dies right after the answer seals → the hourly sweep finishes the ANSWER; the author is not marked, the stake stays burned, the post is not flagged', async () => {
    mockVerify.mockResolvedValue(TRUE_ANSWER);
    const revive = dieOnceAnswerSealed();
    await expect(answerChallenge(makeDeps(db), AUTHOR_ACTOR, CHALLENGE_ID, { burn_id: ANSWER_BURN, presentation_token: 'tok' }, VERIFY_DEPS)).rejects.toThrow('process died');
    revive();
    // The answer sealed, and the challenge already shows it — in the same write.
    expect(envelopesOf('commons_challenge_answered')).toHaveLength(1);
    expect(read(db)).toMatchObject({ status: 'open', answer_claim: { answer_pe_id: expect.any(String), predicate_true: true, answer_burn_id: ANSWER_BURN } });

    const swept = await sweepChallengeStanding(makeDeps(db), AFTER);
    expect(swept).toMatchObject({ expired_settled: 0, failures: 0 });
    expect(read(db)).toMatchObject({ status: 'answered', resolution: 'predicate_true', stake_status: 'consumed', answer_burn_id: ANSWER_BURN });
    expect(adverseOnAuthor()).toHaveLength(0);
    expect(read(db).standing_pending).toBeUndefined();
    expect(db.store.get(`burn_consumptions/${STAKE_BURN}`)).toBeDefined();
    expect(db.store.get(`burn_consumption_releases/${STAKE_BURN}__${CHALLENGE_ID}`)).toBeUndefined();
    expect(readPost(db).is_flagged).toBe(false);
  });

  it('the same death with a FALSE answer settles as the answer it was (upheld on predicate_false), never as "no presentation"', async () => {
    mockVerify.mockResolvedValue(FALSE_ANSWER);
    const revive = dieOnceAnswerSealed();
    await expect(answerChallenge(makeDeps(db), AUTHOR_ACTOR, CHALLENGE_ID, { burn_id: ANSWER_BURN, presentation_token: 'tok' }, VERIFY_DEPS)).rejects.toThrow('process died');
    revive();
    await sweepChallengeStanding(makeDeps(db), AFTER);
    expect(read(db)).toMatchObject({ status: 'upheld', resolution: 'predicate_false' });
  });

  it('every other settling path: a read (getChallenge) and the author\'s own late retry also finish the sealed answer', async () => {
    mockVerify.mockResolvedValue(TRUE_ANSWER);
    const revive = dieOnceAnswerSealed();
    await expect(answerChallenge(makeDeps(db), AUTHOR_ACTOR, CHALLENGE_ID, { burn_id: ANSWER_BURN, presentation_token: 'tok' }, VERIFY_DEPS)).rejects.toThrow('process died');
    revive();
    const sealedState = { ...(db.store.get(key) as object) };

    jest.spyOn(Date, 'now').mockReturnValue(AFTER);
    expect(await settleExpiredChallenge(makeDeps(db), CHALLENGE_ID, AFTER)).toMatchObject({ status: 'answered', resolution: 'predicate_true' });

    // The author retries after the window (same token, or a different one): the sealed answer is
    // returned as the outcome — no "window has lapsed", and never a second answer PE.
    for (const token of ['tok', 'another-token']) {
      db.store.set(key, { ...sealedState });
      const out = await answerChallenge(makeDeps(db), AUTHOR_ACTOR, CHALLENGE_ID, { burn_id: ANSWER_BURN, presentation_token: token }, VERIFY_DEPS);
      expect(out).toMatchObject({ status: 'answered', resolution: 'predicate_true' });
    }
    expect(envelopesOf('commons_challenge_answered')).toHaveLength(1);
  });

  it('RED on the old code: a lapse requested for a challenge whose answer has sealed settles with the answer — whoever asks, however stale their read', async () => {
    // The caller read the challenge before the answer sealed and now asks for the lapse.
    seedChallenge(db, { answer_claim: { presentation_jti: 'ans_x', claimed_at: NOW + 10, answer_pe_id: 'pe_ans', predicate_true: true, answer_burn_id: ANSWER_BURN } } as Partial<CommonsChallenge>);
    const out = await resolveChallenge(makeDeps(db), CHALLENGE_ID, 'no_presentation', { nowMs: AFTER });
    expect(out).toMatchObject({ status: 'answered', resolution: 'predicate_true', stake_status: 'consumed', answer_pe_id: 'pe_ans', answer_burn_id: ANSWER_BURN });
    expect(out.resolution_summary).toMatch(/^Answered/);
    expect(adverseOnAuthor()).toHaveLength(0);
    expect(readPost(db).is_flagged).toBe(false);
    // The challenger's record says what happened: the answer, not a lapse.
    expect(envelopesOf('commons_challenge_resolved').map((e) => (e.metadata as Record<string, unknown>).resolution)).toEqual(['predicate_true']);
  });

  it('a lapse requested while an answer is in flight changes nothing; once the claim is stale with no sealed answer, it lapses', async () => {
    seedChallenge(db, { answer_claim: { presentation_jti: 'ans_x', claimed_at: NOW + WINDOW_MS - 1000 } } as Partial<CommonsChallenge>);
    expect((await resolveChallenge(makeDeps(db), CHALLENGE_ID, 'no_presentation', { nowMs: NOW + WINDOW_MS + 1 })).status).toBe('open');
    expect((await resolveChallenge(makeDeps(db), CHALLENGE_ID, 'no_presentation', { nowMs: AFTER })).status).toBe('upheld');
    expect(read(db).resolution).toBe('no_presentation');
  });

  it('no answer can seal on a challenge that has already settled (so "sealed" always means "recorded on an open challenge")', async () => {
    mockVerify.mockResolvedValue(TRUE_ANSWER);
    const realTxn = db.runTransaction.bind(db);
    let fired = false;
    (db as unknown as { runTransaction: unknown }).runTransaction = async (fn: never) => {
      const c = db.store.get(key) as unknown as CommonsChallenge;
      // Between the claim and the seal, the challenge settles (a stale claim lapsed by another process).
      if (!fired && c.answer_claim && !c.answer_claim.answer_pe_id) {
        fired = true;
        db.store.set(key, { ...c, status: 'upheld', resolution: 'no_presentation', stake_status: 'released' });
      }
      return realTxn(fn);
    };
    await expect(answerChallenge(makeDeps(db), AUTHOR_ACTOR, CHALLENGE_ID, { burn_id: ANSWER_BURN, presentation_token: 'tok' }, VERIFY_DEPS))
      .rejects.toThrow(/no longer open to this answer/);
    expect(fired).toBe(true);
    expect(envelopesOf('commons_challenge_answered')).toHaveLength(0); // RED: the old code sealed it anyway
    (db as unknown as { runTransaction: unknown }).runTransaction = realTxn;
  });

  it('a failed seal releases the claim (the author can retry) but never erases a sealed answer', async () => {
    mockVerify.mockResolvedValue(TRUE_ANSWER);
    const realTxn = db.runTransaction.bind(db);
    let calls = 0;
    (db as unknown as { runTransaction: unknown }).runTransaction = async (fn: never) => {
      calls += 1;
      if (calls === 2) throw new Error('chain tip contention'); // the seal transaction
      return realTxn(fn);
    };
    await expect(answerChallenge(makeDeps(db), AUTHOR_ACTOR, CHALLENGE_ID, { burn_id: ANSWER_BURN, presentation_token: 'tok' }, VERIFY_DEPS)).rejects.toThrow();
    (db as unknown as { runTransaction: unknown }).runTransaction = realTxn;
    expect(envelopesOf('commons_challenge_answered')).toHaveLength(0);
    expect(read(db).answer_claim ?? null).toBeNull();
    const retry = await answerChallenge(makeDeps(db), AUTHOR_ACTOR, CHALLENGE_ID, { burn_id: ANSWER_BURN, presentation_token: 'tok' }, VERIFY_DEPS);
    expect(retry.status).toBe('answered');
  });

  it('a seal that commits but whose response is lost (the client re-runs the transaction) is still THE answer: it is finished, never released', async () => {
    mockVerify.mockResolvedValue(TRUE_ANSWER);
    const realTxn = db.runTransaction.bind(db);
    let calls = 0;
    (db as unknown as { runTransaction: unknown }).runTransaction = async (fn: never) => {
      calls += 1;
      if (calls !== 2) return realTxn(fn);
      await realTxn(fn);  // the seal commits on the server…
      return realTxn(fn); // …the response is lost, and the SDK runs the transaction again
    };
    const out = await answerChallenge(makeDeps(db), AUTHOR_ACTOR, CHALLENGE_ID, { burn_id: ANSWER_BURN, presentation_token: 'tok' }, VERIFY_DEPS);
    (db as unknown as { runTransaction: unknown }).runTransaction = realTxn;
    expect(envelopesOf('commons_challenge_answered')).toHaveLength(1);
    expect(out).toMatchObject({ status: 'answered', resolution: 'predicate_true' });
    expect(read(db).answer_claim).toMatchObject({ answer_pe_id: out.answer_pe_id, predicate_true: true });
    expect(adverseOnAuthor()).toHaveLength(0);
  });

  it('a failing request never erases a sealed answer: the claim survives, and the sweep finishes it as the answer', async () => {
    mockVerify.mockResolvedValue(TRUE_ANSWER);
    const realTxn = db.runTransaction.bind(db);
    let calls = 0;
    (db as unknown as { runTransaction: unknown }).runTransaction = async (fn: never) => {
      calls += 1;
      if (calls === 2) { await realTxn(fn); return realTxn(fn); } // commit, then the re-run throws
      if (calls > 3) throw new Error('process died');               // the read-back survives; the finish does not
      return realTxn(fn);
    };
    await expect(answerChallenge(makeDeps(db), AUTHOR_ACTOR, CHALLENGE_ID, { burn_id: ANSWER_BURN, presentation_token: 'tok' }, VERIFY_DEPS)).rejects.toThrow('process died');
    (db as unknown as { runTransaction: unknown }).runTransaction = realTxn;
    expect(read(db)).toMatchObject({ status: 'open', answer_claim: { answer_pe_id: expect.any(String), predicate_true: true } });
    await sweepChallengeStanding(makeDeps(db), AFTER);
    expect(read(db)).toMatchObject({ status: 'answered', resolution: 'predicate_true' });
    expect(adverseOnAuthor()).toHaveLength(0);
  });

  it('a sealed answer IS the outcome, whatever resolution a request passes (RED: a second request could settle a true answer as predicate_false)', async () => {
    seedChallenge(db, { answer_claim: { presentation_jti: 'ans_x', claimed_at: NOW + 10, claim_id: 'a', answer_pe_id: 'pe_ans', predicate_true: true, answer_burn_id: ANSWER_BURN } } as Partial<CommonsChallenge>);
    const out = await resolveChallenge(makeDeps(db), CHALLENGE_ID, 'predicate_false', { nowMs: NOW + 20, answerPeId: 'pe_other' });
    expect(out).toMatchObject({ status: 'answered', resolution: 'predicate_true', stake_status: 'consumed', answer_pe_id: 'pe_ans', answer_burn_id: ANSWER_BURN });
    expect(adverseOnAuthor()).toHaveLength(0);
    expect(readPost(db).is_flagged).toBe(false);

    // The mirror: a sealed FALSE answer is not settled as answered.
    db = createFakeFirestore(); seedPost(db); seedWallets(db);
    seedChallenge(db, { answer_claim: { presentation_jti: 'ans_x', claimed_at: NOW + 10, claim_id: 'a', answer_pe_id: 'pe_ans', predicate_true: false } } as Partial<CommonsChallenge>);
    expect(await resolveChallenge(makeDeps(db), CHALLENGE_ID, 'predicate_true', { nowMs: NOW + 20 })).toMatchObject({ status: 'upheld', resolution: 'predicate_false' });
  });

  it('a claim belongs to ONE request: a stalled request whose claim was taken over (even by the same token) cannot seal onto it, release it, or settle with it', async () => {
    mockVerify.mockResolvedValue(TRUE_ANSWER);
    const realTxn = db.runTransaction.bind(db);
    let calls = 0;
    (db as unknown as { runTransaction: unknown }).runTransaction = async (fn: never) => {
      calls += 1;
      if (calls === 2) {
        // Between this request's claim and its seal, another request with the SAME token takes the claim over.
        const c = db.store.get(key) as unknown as CommonsChallenge;
        db.store.set(key, { ...c, answer_claim: { presentation_jti: c.answer_claim!.presentation_jti, claimed_at: NOW + 2000, claim_id: 'the-other-request' } });
      }
      return realTxn(fn);
    };
    await expect(answerChallenge(makeDeps(db), AUTHOR_ACTOR, CHALLENGE_ID, { burn_id: ANSWER_BURN, presentation_token: 'tok' }, VERIFY_DEPS))
      .rejects.toThrow(/no longer open to this answer/);
    (db as unknown as { runTransaction: unknown }).runTransaction = realTxn;
    expect(envelopesOf('commons_challenge_answered')).toHaveLength(0);
    // The other request's claim is untouched, and the challenge is not settled by the loser.
    expect(read(db)).toMatchObject({ status: 'open', answer_claim: { claim_id: 'the-other-request' } });
    expect(read(db).answer_claim?.answer_pe_id).toBeUndefined();
  });

  it('a later submission with a DIFFERENT verdict cannot change a sealed answer: it gets the sealed outcome', async () => {
    seedChallenge(db, { answer_claim: { presentation_jti: 'ans_x', claimed_at: NOW + 10, claim_id: 'a', answer_pe_id: 'pe_ans', predicate_true: true, answer_burn_id: ANSWER_BURN } } as Partial<CommonsChallenge>);
    mockVerify.mockResolvedValue({ verdict: 'expired', predicate_results: [] }); // the same token, now expired
    const out = await answerChallenge(makeDeps(db), AUTHOR_ACTOR, CHALLENGE_ID, { burn_id: ANSWER_BURN, presentation_token: 'tok' }, VERIFY_DEPS);
    expect(out).toMatchObject({ status: 'answered', resolution: 'predicate_true', answer_pe_id: 'pe_ans' });
    expect(envelopesOf('commons_challenge_answered')).toHaveLength(0); // no second answer PE
  });

  it('a sealed answer whose outcome is not on the claim is read from the answer PE — and is never a lapse when it cannot be read', async () => {
    seedChallenge(db, { answer_claim: { presentation_jti: 'ans_x', claimed_at: NOW + 10, answer_pe_id: 'pe_legacy' } } as Partial<CommonsChallenge>);
    // Unreadable: stays open, on every path.
    expect((await settleExpiredChallenge(makeDeps(db), CHALLENGE_ID, AFTER)).status).toBe('open');
    expect((await resolveChallenge(makeDeps(db), CHALLENGE_ID, 'no_presentation', { nowMs: AFTER })).status).toBe('open');
    // A PE of another challenge, or another type, is not this challenge's answer.
    db.store.set('provenance_envelopes/pe_legacy', { action_type: 'commons_challenge_answered', metadata: { challenge_id: 'other', predicate_true: true } });
    expect((await settleExpiredChallenge(makeDeps(db), CHALLENGE_ID, AFTER)).status).toBe('open');
    db.store.set('provenance_envelopes/pe_legacy', { action_type: 'commons_challenge_answered', metadata: { challenge_id: CHALLENGE_ID, predicate_true: true, presentation_burn_id: ANSWER_BURN } });
    expect(await settleExpiredChallenge(makeDeps(db), CHALLENGE_ID, AFTER)).toMatchObject({ status: 'answered', resolution: 'predicate_true', answer_pe_id: 'pe_legacy', answer_burn_id: ANSWER_BURN });
  });
});

