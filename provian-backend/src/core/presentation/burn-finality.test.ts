/**
 * burns accepted at one-block inclusion are finalized, or revoked with every
 * relay-held benefit they back.
 *
 * RED controls (each shown failing with its protection removed — recorded in the landing commit):
 * - a provisional benefit is revoked when its burn does not finalize (every benefit class);
 * - a burn cannot be consumed twice across the provisional → final / revoked transition;
 * - a FINAL burn can never be revoked;
 * - an RPC error is waited out, never read as failure — at ANY age (past the deadline the
 * burn is stalled and alarmed, never revoked; see also burn-finality.d487a.test.ts).
 */
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import type { Firestore } from 'firebase-admin/firestore';
import {
  BURN_FINALITY_DEADLINE_MS,
  BURN_NOT_FOUND_REVOKE_AFTER_MS,
  BURN_REVOCATIONS_COLLECTION,
  finalizeBurn,
  revokeBurn,
  scheduleBurnFinalization,
  speechPeWindowBurnFinal,
  sweepBurnFinality,
} from './burn-finality';
import { assertBurnRowUsable, BurnConsumptionError, BURN_REVOKED } from '../commons/burn-consumption';
import type { TxVerificationResult } from '../onchain/tx-verifier';
import { buildSpeechWindowAct, SPEECH_WINDOW_ACTS_COLLECTION } from '../commons/speech-window-acts';

const B = 'b'.repeat(64);
const OTHER = 'c'.repeat(64);
const TX = `0x${'a'.repeat(64)}`;
const ADDR = '0x1111111111111111111111111111111111111111';
const T0 = 1_790_000_000_000;

function provisionalRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tx_hash: TX, chain: 'base', wallet_id: 'wallet_aw_1', owner_kind: 'agent', owner_id: 'agent_1',
    burner_address: ADDR, amount_atomic: '15000000000000000000', status: 'recorded', verified: true,
    block_number: 100, recorded_at: T0, accepted_at: T0, finality: 'provisional', ...extra,
  };
}

/** PE METER: the speech-window record `generatePE` writes beside a speech act made under a pass. */
function speechAct(fs: FakeFirestore, peId: string, burnId: string, actionType: string, metadata: Record<string, unknown>): void {
  fs.store.set(`${SPEECH_WINDOW_ACTS_COLLECTION}/${peId}`, {
    ...buildSpeechWindowAct({ peId, burnId, actionType, metadata, nowMs: T0 }),
  });
}

function seed(fs: FakeFirestore, burnId = B, suffix = ''): void {
  const s = fs.store;
  s.set(`pvt_burn_records/${burnId}`, provisionalRow());
  s.set(`burn_consumptions/${burnId}`, { burn_id: burnId, product: 'presentation', wallet_id: 'wallet_aw_1', ref: 'jti', consumed_at: T0 });
  s.set(`commons_presentations/${burnId}`, { burn_id: burnId, wallet_id: 'wallet_aw_1', audience: 'provian:commons', recorded_at: T0 });
  s.set(`commons_featured_placements/${burnId}`, { burn_id: burnId, board: 'wants', item_id: 'w1', amount_atomic: '15' });
  s.set(`commons_name_claims/alice${suffix}`, { name: `alice${suffix}`, burn_id: burnId, wallet_id: 'wallet_aw_1' });
  s.set(`commons_burn_vouches/v${suffix}`, { backing_burn_id: burnId, target_agent_id: 'x' });
  s.set(`commons_pledges/p${suffix}`, { backing_burn_id: burnId });
  s.set(`commons_subscriptions/s${suffix}`, { backing_burn_id: burnId });
  s.set(`commons_challenges/c${suffix}`, { challenge_id: `c${suffix}`, post_id: `P${suffix}`, stake_burn_id: burnId, status: 'open' });
  s.set(`commons_forum_posts/P${suffix}`, { post_id: `P${suffix}`, challenge_count: 1, is_flagged: false });
  s.set(`commons_challenges/ans${suffix}`, {
    challenge_id: `ans${suffix}`, post_id: `Q${suffix}`, stake_burn_id: 'd'.repeat(64), status: 'answered', stake_status: 'consumed',
    resolution: 'predicate_true', resolved_at: T0, answer_burn_id: burnId, answer_pe_id: 'pe_ans',
  });
  s.set(`presentation_requests_v1/r${suffix}`, { request_id: `r${suffix}`, status: 'presented', burn_id: burnId, verdict: 'valid' });
  s.set(`commons_threads/t${suffix}`, { thread_id: `t${suffix}`, party_a: 'a', party_b: 'b', opened_under_burn_id: burnId });
  s.set(`speech_window_budgets/${burnId}`, { burn_id: burnId, budget_atomic: '15', consumed_atomic: '2' });
  // Speech made under the pass: a post, an upvote, a flag.
  s.set(`speech_window_reservations/pe_post${suffix}`, { pe_id: `pe_post${suffix}`, burn_id: burnId, action_type: 'commons_post_created' });
  speechAct(fs, `pe_post${suffix}`, burnId, 'commons_post_created', { post_id: `S${suffix}` });
  s.set(`commons_forum_posts/S${suffix}`, { post_id: `S${suffix}`, author_wallet_id: 'wallet_aw_1' });
  s.set(`speech_window_reservations/pe_vote${suffix}`, { pe_id: `pe_vote${suffix}`, burn_id: burnId, action_type: 'commons_vote_cast' });
  speechAct(fs, `pe_vote${suffix}`, burnId, 'commons_vote_cast', { post_id: `V${suffix}`, vote_id: `V${suffix}__wallet_aw_1`, vote_type: 'upvote' });
  s.set(`commons_votes/V${suffix}__wallet_aw_1`, { vote_id: `V${suffix}__wallet_aw_1`, post_id: `V${suffix}`, vote_type: 'upvote', pe_id: `pe_vote${suffix}` });
  s.set(`commons_forum_posts/V${suffix}`, { post_id: `V${suffix}`, author_wallet_id: `author${suffix}`, upvotes: 3, downvotes: 0, score: 3 });
  s.set(`commons_profiles/author${suffix}`, { forum_upvotes_received: 3 });
  s.set(`speech_window_reservations/pe_flag${suffix}`, { pe_id: `pe_flag${suffix}`, burn_id: burnId, action_type: 'commons_post_flagged' });
  speechAct(fs, `pe_flag${suffix}`, burnId, 'commons_post_flagged', { post_id: `F${suffix}` });
  s.set(`commons_forum_posts/F${suffix}`, { post_id: `F${suffix}`, is_flagged: true });
  s.set(`commons_forum_posts/F${suffix}/flags/wallet_aw_1`, { post_id: `F${suffix}`, wallet_id: 'wallet_aw_1', pe_id: `pe_flag${suffix}` });
}

function deps(fs: FakeFirestore, verdict: TxVerificationResult | (() => TxVerificationResult), nowMs = T0 + 30_000) {
  const verify = jest.fn(async () => (typeof verdict === 'function' ? verdict() : verdict));
  return { db: fs as unknown as Firestore, now: () => nowMs, verify, verifyMock: verify };
}

function expectAllRevoked(fs: FakeFirestore, suffix = ''): void {
  const s = fs.store;
  expect(s.get(`pvt_burn_records/${B}`)).toMatchObject({ status: 'revoked', verified: false, finality: 'failed' });
  expect(s.has(`commons_presentations/${B}`)).toBe(false);
  expect(s.has(`commons_featured_placements/${B}`)).toBe(false);
  expect(s.has(`commons_name_claims/alice${suffix}`)).toBe(false);
  expect(s.has(`commons_burn_vouches/v${suffix}`)).toBe(false);
  expect(s.has(`commons_pledges/p${suffix}`)).toBe(false);
  expect(s.has(`commons_subscriptions/s${suffix}`)).toBe(false);
  expect(s.has(`commons_challenges/c${suffix}`)).toBe(false);
  expect(s.get(`commons_forum_posts/P${suffix}`)).toMatchObject({ challenge_count: 0, is_flagged: false });
  expect(s.get(`commons_challenges/ans${suffix}`)).toMatchObject({ status: 'open', stake_status: 'reserved' });
  expect(s.get(`commons_challenges/ans${suffix}`)).not.toHaveProperty('answer_burn_id');
  expect(s.get(`presentation_requests_v1/r${suffix}`)).toMatchObject({ burn_revoked: true, verdict: 'invalid' });
  expect(s.get(`commons_threads/t${suffix}`)).toMatchObject({ revoked: true });
  expect(s.get(`speech_window_budgets/${B}`)).toMatchObject({ revoked: true });
  expect(s.get(`commons_forum_posts/S${suffix}`)).toMatchObject({ public_visibility: 'hidden_revoked_burn' });
  expect(s.has(`commons_votes/V${suffix}__wallet_aw_1`)).toBe(false);
  expect(s.get(`commons_forum_posts/V${suffix}`)).toMatchObject({ upvotes: 2, score: 2 });
  expect(s.get(`commons_profiles/author${suffix}`)).toMatchObject({ forum_upvotes_received: 2 });
  expect(s.has(`commons_forum_posts/F${suffix}/flags/wallet_aw_1`)).toBe(false);
  expect(s.get(`commons_forum_posts/F${suffix}`)).toMatchObject({ is_flagged: false });
}

describe('burn finality ', () => {
  it('RED: a burn that fails finality (reverted) is revoked with EVERY relay-held benefit it backs', async () => {
    const fs = createFakeFirestore({ strictTransactionOrder: true });
    seed(fs);
    seed(fs, OTHER, '_other');
    const d = deps(fs, { ok: false, reason: 'tx_failed' });
    await expect(finalizeBurn(d, B)).resolves.toBe('revoked');
    expectAllRevoked(fs);
    // The audit keeps a copy of everything removed.
    expect([...fs.store.keys()].filter((k) => k.startsWith(`${BURN_REVOCATIONS_COLLECTION}/${B}/benefits/`)).length).toBe(13);
    // Another burn's benefits are untouched.
    expect(fs.store.get(`pvt_burn_records/${OTHER}`)).toMatchObject({ status: 'recorded', finality: 'provisional' });
    expect(fs.store.has(`commons_presentations/${OTHER}`)).toBe(true);
    expect(fs.store.has('commons_name_claims/alice_other')).toBe(true);
    expect(fs.store.has('commons_votes/V_other__wallet_aw_1')).toBe(true);
  });

  it('RED: no matching burn log at finality → revoked', async () => {
    const fs = createFakeFirestore();
    seed(fs);
    await expect(finalizeBurn(deps(fs, { ok: false, reason: 'no_matching_pvt_burn_log' }), B)).resolves.toBe('revoked');
    expectAllRevoked(fs);
  });

  it('a dropped burn is waited out, then revoked after the not-found bound — only on a PROVEN drop ', async () => {
    const fs = createFakeFirestore();
    seed(fs);
    fs.store.set(`pvt_burn_records/${B}`, provisionalRow({ included_block_hash: `0x${'1'.repeat(64)}` }));
    const proveDropped = jest.fn(async () => ({ dropped: true as const, safeHeadNumber: 200, canonicalHashAtHeight: `0x${'2'.repeat(64)}` }));
    const notFound = { ok: false, reason: 'tx_not_found' };
    await expect(finalizeBurn({ ...deps(fs, notFound, T0 + BURN_NOT_FOUND_REVOKE_AFTER_MS - 1), proveDropped }, B)).resolves.toBe('pending');
    expect(proveDropped).not.toHaveBeenCalled();
    expect(fs.store.get(`pvt_burn_records/${B}`)).toMatchObject({ status: 'recorded', finality: 'provisional' });
    expect(fs.store.has(`commons_presentations/${B}`)).toBe(true);
    await expect(finalizeBurn({ ...deps(fs, notFound, T0 + BURN_NOT_FOUND_REVOKE_AFTER_MS), proveDropped }, B)).resolves.toBe('revoked');
    expect(proveDropped).toHaveBeenCalledWith({ txHash: TX, includedBlockNumber: 100, includedBlockHash: `0x${'1'.repeat(64)}` });
    expectAllRevoked(fs);
    expect(fs.store.get(`pvt_burn_records/${B}`)?.revoke_reason).toMatch(/^tx_not_found_dropped_at_safe_depth/);
  });

  it('RED (, inverted from): an RPC error is waited out forever — past the deadline the burn is STALLED, never revoked, and keeps every benefit', async () => {
    const fs = createFakeFirestore();
    seed(fs);
    const rpc = { ok: false, reason: 'rpc_error: economic_finality_rpc_disagreement:receipt' };
    await expect(finalizeBurn(deps(fs, rpc, T0 + BURN_FINALITY_DEADLINE_MS - 1), B)).resolves.toBe('pending');
    await expect(finalizeBurn(deps(fs, { ok: false, reason: 'insufficient_confirmations: 5/12' }, T0 + BURN_FINALITY_DEADLINE_MS - 1), B)).resolves.toBe('pending');
    expect(fs.store.has(`commons_presentations/${B}`)).toBe(true);
    // At the deadline (old code: revoked) and a day later: stalled, still provisional, benefits intact.
    for (const at of [T0 + BURN_FINALITY_DEADLINE_MS, T0 + 24 * 3_600_000]) {
      await expect(finalizeBurn(deps(fs, rpc, at), B)).resolves.toBe('stalled');
      expect(fs.store.get(`pvt_burn_records/${B}`)).toMatchObject({
        status: 'recorded', verified: true, finality: 'provisional', finality_stalled: true,
        finality_stalled_at: T0 + BURN_FINALITY_DEADLINE_MS, finality_stall_reason: rpc.reason,
      });
      expect(fs.store.has(`commons_presentations/${B}`)).toBe(true);
      expect(fs.store.has('commons_name_claims/alice')).toBe(true);
      expect(fs.store.has('commons_votes/V__wallet_aw_1')).toBe(true);
    }
    expect(() => assertBurnRowUsable(fs.store.get(`pvt_burn_records/${B}`), 'wallet_aw_1', 0n)).not.toThrow();
    // The RPC recovers: the stall clears and the burn is final.
    await expect(finalizeBurn(deps(fs, { ok: true, blockNumber: 100, confirmations: 12 }, T0 + 25 * 3_600_000), B)).resolves.toBe('final');
    const row = fs.store.get(`pvt_burn_records/${B}`) as Record<string, unknown>;
    expect(row).toMatchObject({ finality: 'final', finality_stall_cleared_at: T0 + 25 * 3_600_000 });
    expect(row).not.toHaveProperty('finality_stalled');
  });

  it('a burn that reaches finality — even re-included in a different block after a reorg — keeps every benefit', async () => {
    const fs = createFakeFirestore();
    seed(fs);
    const d = deps(fs, { ok: true, blockNumber: 101, blockHash: `0x${'e'.repeat(64)}`, confirmations: 12 });
    await expect(finalizeBurn(d, B)).resolves.toBe('final');
    expect(fs.store.get(`pvt_burn_records/${B}`)).toMatchObject({
      status: 'recorded', verified: true, finality: 'final', block_number: 100, final_block_number: 101,
    });
    expect(fs.store.has(`commons_presentations/${B}`)).toBe(true);
    expect(fs.store.has('commons_name_claims/alice')).toBe(true);
    expect(fs.store.has('commons_votes/V__wallet_aw_1')).toBe(true);
    // Finality asks the verifier at its DEFAULT (12-block) acceptance, never at inclusion.
    expect(d.verifyMock).toHaveBeenCalledWith({ chainId: 8453, txHash: TX, expectedFrom: ADDR, expectedAmountWei: 15_000_000_000_000_000_000n });
    // Final is terminal: a later failing verdict changes nothing.
    await expect(finalizeBurn(deps(fs, { ok: false, reason: 'tx_failed' }), B)).resolves.toBe('skip');
    expect(fs.store.get(`pvt_burn_records/${B}`)).toMatchObject({ finality: 'final' });
  });

  it('RED: a FINAL burn can never be revoked', async () => {
    const fs = createFakeFirestore();
    seed(fs);
    fs.store.set(`pvt_burn_records/${B}`, provisionalRow({ finality: 'final' }));
    await expect(revokeBurn(deps(fs, { ok: true }), B, 'operator')).resolves.toBe(false);
    expect(fs.store.get(`pvt_burn_records/${B}`)).toMatchObject({ status: 'recorded', finality: 'final' });
    expect(fs.store.has(`commons_presentations/${B}`)).toBe(true);
    // A legacy row (recorded before this ruling, at finality — no `finality` field) is final too.
    fs.store.set(`pvt_burn_records/${B}`, { ...provisionalRow(), finality: undefined });
    await expect(revokeBurn(deps(fs, { ok: true }), B, 'operator')).resolves.toBe(false);
    expect(fs.store.has(`commons_presentations/${B}`)).toBe(true);
  });

  it('RED: a burn is consumable exactly once across the provisional → final and provisional → revoked transitions', async () => {
    // Provisional: usable (it was accepted), and its one consumption marker is in place.
    const fs = createFakeFirestore();
    seed(fs);
    const provisional = fs.store.get(`pvt_burn_records/${B}`);
    expect(() => assertBurnRowUsable(provisional, 'wallet_aw_1', 0n)).not.toThrow();
    const marker = fs.store.get(`burn_consumptions/${B}`);
    // → final: the marker is untouched, so the burn stays consumed.
    await finalizeBurn(deps(fs, { ok: true, blockNumber: 100, confirmations: 12 }), B);
    expect(fs.store.get(`burn_consumptions/${B}`)).toEqual(marker);
    // → revoked: the marker is untouched (still consumed) AND the row itself refuses every consumer.
    const fs2 = createFakeFirestore();
    seed(fs2);
    await finalizeBurn(deps(fs2, { ok: false, reason: 'tx_failed' }), B);
    expect(fs2.store.get(`burn_consumptions/${B}`)).toEqual(marker);
    expect(() => assertBurnRowUsable(fs2.store.get(`pvt_burn_records/${B}`), 'wallet_aw_1', 0n)).toThrow(BurnConsumptionError);
  });

  it('a revoked burn\'s benefits are swept again: a folded benefit written in the revocation instant is caught', async () => {
    const fs = createFakeFirestore();
    seed(fs);
    await finalizeBurn(deps(fs, { ok: false, reason: 'tx_failed' }), B);
    fs.store.set('commons_burn_vouches/late', { backing_burn_id: B });
    const d = deps(fs, { ok: true }, T0 + 60_000);
    const counts = await sweepBurnFinality(d);
    expect(counts.reswept).toBe(1);
    expect(fs.store.has('commons_burn_vouches/late')).toBe(false);
  });

  it('the sweep finalizes provisional burns only (final and legacy rows are never re-verified)', async () => {
    const fs = createFakeFirestore();
    fs.store.set(`pvt_burn_records/${B}`, provisionalRow());
    fs.store.set(`pvt_burn_records/${OTHER}`, provisionalRow({ finality: 'final' }));
    fs.store.set(`pvt_burn_records/${'f'.repeat(64)}`, { ...provisionalRow(), finality: undefined });
    const d = deps(fs, { ok: true, blockNumber: 100, confirmations: 12 });
    const counts = await sweepBurnFinality(d);
    expect(counts).toMatchObject({ finalized: 1, revoked: 0, pending: 0, errors: 0 });
    expect(d.verifyMock).toHaveBeenCalledTimes(1);
  });

  it('the in-process finalizer waits for the 12th block, then finalizes', async () => {
    const fs = createFakeFirestore();
    fs.store.set(`pvt_burn_records/${B}`, provisionalRow());
    const d = deps(fs, { ok: true, blockNumber: 100, confirmations: 12 });
    let head = 100;
    const probe = { receiptBlock: async () => 100, headBlock: async () => head };
    const sleeps: number[] = [];
    scheduleBurnFinalization({ ...d, probe, sleep: async (ms) => { sleeps.push(ms); head += 11; } }, B, TX);
    for (let i = 0; i < 20 && fs.store.get(`pvt_burn_records/${B}`)?.finality !== 'final'; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(fs.store.get(`pvt_burn_records/${B}`)).toMatchObject({ finality: 'final' });
    expect(sleeps.length).toBeGreaterThan(0); // it waited for depth before asking the verifier
  });
});

describe('burn finality — (combined review)', () => {
  it('RED 1: a re-sweep of a revoked pass never reverses a LATER vote cast at the same id under another pass', async () => {
    const fs = createFakeFirestore();
    seed(fs);
    await finalizeBurn(deps(fs, { ok: false, reason: 'tx_failed' }), B);
    expect(fs.store.has('commons_votes/V__wallet_aw_1')).toBe(false);
    // The voter opens a new pass (final) and votes on the same post again — same deterministic id.
    fs.store.set('commons_votes/V__wallet_aw_1', { vote_id: 'V__wallet_aw_1', post_id: 'V', vote_type: 'upvote', pe_id: 'pe_vote_W2' });
    fs.store.set('commons_forum_posts/V', { post_id: 'V', author_wallet_id: 'author', upvotes: 3, downvotes: 0, score: 3 });
    await sweepBurnFinality(deps(fs, { ok: true }, T0 + 60_000));
    expect(fs.store.get('commons_votes/V__wallet_aw_1')).toMatchObject({ pe_id: 'pe_vote_W2' });
    expect(fs.store.get('commons_forum_posts/V')).toMatchObject({ upvotes: 3, score: 3 });
  });

  it('RED 4: speech under the pass that sealed record_only (no budget reservation) is still found — through its speech-window record — and revoked', async () => {
    const fs = createFakeFirestore();
    fs.store.set(`pvt_burn_records/${B}`, provisionalRow());
    speechAct(fs, 'pe_ro', B, 'commons_post_created', { post_id: 'RO' });
    fs.store.set('commons_forum_posts/RO', { post_id: 'RO' });
    // Another pass's speech is never touched.
    speechAct(fs, 'pe_other', OTHER, 'commons_post_created', { post_id: 'OTHERPOST' });
    fs.store.set('commons_forum_posts/OTHERPOST', { post_id: 'OTHERPOST' });
    await finalizeBurn(deps(fs, { ok: false, reason: 'tx_failed' }), B);
    expect(fs.store.get('commons_forum_posts/RO')).toMatchObject({ public_visibility: 'hidden_revoked_burn' });
    expect(fs.store.get('commons_forum_posts/OTHERPOST')).not.toHaveProperty('public_visibility');
  });

  it('PE METER RED: a stored envelope is never the source — an act known only by its intake row is counted unresolved, not guessed', async () => {
    const fs = createFakeFirestore();
    fs.store.set(`pvt_burn_records/${B}`, provisionalRow());
    fs.store.set('pvt_ordinary_accrual_intake_v1/pe_legacy', {
      pe_id: 'pe_legacy', action_type: 'commons_post_created',
      accrual_params: { peId: 'pe_legacy', speechWindow: { burnId: B, burnAmountAtomic: '15' } },
    });
    // The retired store still has the act's metadata; reading it would hide LEG.
    fs.store.set('provenance_envelopes/pe_legacy', { action_type: 'commons_post_created', metadata: { post_id: 'LEG' } });
    fs.store.set('commons_forum_posts/LEG', { post_id: 'LEG' });
    await finalizeBurn(deps(fs, { ok: false, reason: 'tx_failed' }), B);
    expect(fs.store.get('commons_forum_posts/LEG')).not.toHaveProperty('public_visibility');
    expect(fs.store.get(`${BURN_REVOCATIONS_COLLECTION}/${B}`)).toMatchObject({ speech_acts_unresolved: 1 });
  });

  it('RED (follow-up): an answer that SEALED on the burn but has not settled loses its claim, so it can never settle as answered on a revoked burn', async () => {
    const fs = createFakeFirestore();
    fs.store.set(`pvt_burn_records/${B}`, provisionalRow());
    const claim = { presentation_jti: 'j', claimed_at: T0, claim_id: 'k', answer_pe_id: 'pe_ans_open', predicate_true: true, answer_burn_id: B };
    fs.store.set('commons_challenges/open_ans', { challenge_id: 'open_ans', post_id: 'Q', stake_burn_id: 'd'.repeat(64), status: 'open', stake_status: 'reserved', answer_claim: claim });
    // Controls: another burn's claim, and a claim still in flight (no burn yet), are never touched.
    fs.store.set('commons_challenges/other_ans', { challenge_id: 'other_ans', post_id: 'Q2', stake_burn_id: 'd'.repeat(64), status: 'open', answer_claim: { ...claim, answer_burn_id: OTHER } });
    fs.store.set('commons_challenges/inflight', { challenge_id: 'inflight', post_id: 'Q3', stake_burn_id: 'd'.repeat(64), status: 'open', answer_claim: { presentation_jti: 'j', claimed_at: T0, claim_id: 'k' } });
    await expect(finalizeBurn(deps(fs, { ok: false, reason: 'tx_failed' }), B)).resolves.toBe('revoked');
    expect(fs.store.get('commons_challenges/open_ans')).toMatchObject({ status: 'open', stake_status: 'reserved', answer_claim: null });
    expect(fs.store.get('commons_challenges/other_ans')).toMatchObject({ answer_claim: { answer_burn_id: OTHER } });
    expect(fs.store.get('commons_challenges/inflight')).toMatchObject({ answer_claim: { claim_id: 'k' } });
    // The withdrawn claim is audited.
    expect([...fs.store.keys()].filter((k) => k.startsWith(`${BURN_REVOCATIONS_COLLECTION}/${B}/benefits/`)).length).toBe(1);
  });

  it('RED 3: a consumer refuses a revoked burn by NAME (the text the app keys on to forget it)', () => {
    const revoked = { ...provisionalRow(), status: 'revoked', verified: false, finality: 'failed' };
    expect(() => assertBurnRowUsable(revoked, 'wallet_aw_1', 0n)).toThrow(BURN_REVOKED);
    // Cross-package pin: src/core/presentation/pendingBurns.ts isRevokedBurnError matches either.
    expect(BURN_REVOKED).toMatch(/\bburn_revoked\b/);
    expect(BURN_REVOKED).toMatch(/did not reach Base finality/i);
  });
});

describe('speechPeWindowBurnFinal (the settlement gate)', () => {
  function withReservation(burnRow: Record<string, unknown> | null): FakeFirestore {
    const fs = createFakeFirestore();
    fs.store.set('speech_window_reservations/pe1', { pe_id: 'pe1', burn_id: B });
    if (burnRow) fs.store.set(`pvt_burn_records/${B}`, burnRow);
    return fs;
  }
  const db = (fs: FakeFirestore) => fs as unknown as Firestore;

  it('holds a speech PE whose window burn is provisional, revoked, or missing', async () => {
    await expect(speechPeWindowBurnFinal(db(withReservation(provisionalRow())), 'pe1', 'commons_post_created')).resolves.toBe(false);
    await expect(speechPeWindowBurnFinal(db(withReservation({ ...provisionalRow(), status: 'revoked', finality: 'failed' })), 'pe1', 'commons_post_created')).resolves.toBe(false);
    await expect(speechPeWindowBurnFinal(db(withReservation(null)), 'pe1', 'commons_post_created')).resolves.toBe(false);
  });

  it('lets it through once the burn is final (or legacy, recorded at finality before this ruling)', async () => {
    await expect(speechPeWindowBurnFinal(db(withReservation(provisionalRow({ finality: 'final' }))), 'pe1', 'commons_post_created')).resolves.toBe(true);
    await expect(speechPeWindowBurnFinal(db(withReservation({ ...provisionalRow(), finality: undefined })), 'pe1', 'commons_post_created')).resolves.toBe(true);
  });

  it('RED 2: a challenge PE is held while its STAKE burn is not final, even under a final pass', async () => {
    const fs = withReservation(provisionalRow({ finality: 'final' }));
    const STAKE = 'e'.repeat(64);
    fs.store.set(`pvt_burn_records/${STAKE}`, { ...provisionalRow(), status: 'revoked', verified: false, finality: 'failed' });
    await expect(speechPeWindowBurnFinal(db(fs), 'pe1', 'commons_claim_challenged', { stake_burn_id: STAKE })).resolves.toBe(false);
    fs.store.set(`pvt_burn_records/${STAKE}`, provisionalRow());
    await expect(speechPeWindowBurnFinal(db(fs), 'pe1', 'commons_claim_challenged', { stake_burn_id: STAKE })).resolves.toBe(false);
    fs.store.set(`pvt_burn_records/${STAKE}`, provisionalRow({ finality: 'final' }));
    await expect(speechPeWindowBurnFinal(db(fs), 'pe1', 'commons_claim_challenged', { stake_burn_id: STAKE })).resolves.toBe(true);
  });

  it('does not touch non-speech PEs, or speech with no window reservation', async () => {
    await expect(speechPeWindowBurnFinal(db(withReservation(provisionalRow())), 'pe1', 'agent_action')).resolves.toBe(true);
    await expect(speechPeWindowBurnFinal(db(createFakeFirestore()), 'pe1', 'commons_post_created')).resolves.toBe(true);
  });
});
