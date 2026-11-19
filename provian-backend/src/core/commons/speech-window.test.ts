/**
 * the SPEECH WINDOW gate: a presentation opens a voice, once.
 *
 * A Commons write needs a live presentation window (committer → audience) opened by ONE burn at
 * the existing presentation floors; inside the window nothing further is required. The window is
 * derived read-only from `commons_presentations` (the rail handshake) and carries the backing
 * burn's verified amount for the budget. RED controls: no presentation → 428; a lapsed one → 428;
 * a presentation to a DIFFERENT audience → 428; an unreadable burn → 0n (admits no minting).
 */
import { describe, it, expect } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import { RailHandshakeError } from '../rail/handshake';
import {
  assertFundedHandshake,
  SPEECH_AUDIENCE,
  SpeechWindowRequiredError,
  assertSpeechWindow,
  findLiveSpeechWindow,
  hasOpenRelationship,
  resolveSpeechCommitter,
  readTalkingPassAwareHandshakeState,
  resolveTalkingPassFloorAtomic,
  speechWindowParam,
  speechWindowStatus,
} from './speech-window';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { seedBurn } from './__test-helpers__/speech';

const AGENT = 'wallet_aw_agent';
const BURN = 'e'.repeat(64);
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const FIVE_PVT = 5_000_000_000_000_000_000n;
const FIFTEEN_PVT = 15_000_000_000_000_000_000n;

function seedPresentation(db: FakeFirestore, walletId: string, audience: string, recordedAt: number, burnId = BURN, tier: 'pe_fact' | 'reputation' = 'pe_fact'): void {
  db.store.set(`commons_presentations/pres_${walletId}_${audience}_${recordedAt}`, {
    wallet_id: walletId, audience, recorded_at: recordedAt, burn_id: burnId, presentation_id: `jti_${recordedAt}`, tier,
  });
}

describe('assertSpeechWindow', () => {
  it('RED: no presentation to the commons → 428 rail_handshake_required naming the audience to present to', async () => {
    const db = createFakeFirestore();
    const err = await assertSpeechWindow(db as unknown as Firestore, { walletId: AGENT, isAgent: true }, SPEECH_AUDIENCE, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpeechWindowRequiredError);
    expect((err as SpeechWindowRequiredError).status).toBe(428);
    expect((err as SpeechWindowRequiredError).reason).toBe('rail_handshake_required');
    expect((err as SpeechWindowRequiredError).presentTo).toBe(SPEECH_AUDIENCE);
  });

  it('a live presentation to the commons backed by a 15 PVT burn opens the window and carries the burn amount', async () => {
    const db = createFakeFirestore();
    seedPresentation(db, AGENT, SPEECH_AUDIENCE, NOW - DAY);
    seedBurn(db, BURN, AGENT, FIFTEEN_PVT);
    const w = await assertSpeechWindow(db as unknown as Firestore, { walletId: AGENT, isAgent: true }, SPEECH_AUDIENCE, NOW);
    expect(w.burnId).toBe(BURN);
    expect(w.burnAmountAtomic).toBe(FIFTEEN_PVT);
    expect(w.audience).toBe(SPEECH_AUDIENCE);
    expect(speechWindowParam(w)).toEqual({ burnId: BURN, burnAmountAtomic: FIFTEEN_PVT.toString() });
  });

  it('RED: a lapsed presentation (older than the 7-day window) does not open it', async () => {
    const db = createFakeFirestore();
    seedPresentation(db, AGENT, SPEECH_AUDIENCE, NOW - 8 * DAY);
    seedBurn(db, BURN, AGENT, FIFTEEN_PVT);
    await expect(assertSpeechWindow(db as unknown as Firestore, { walletId: AGENT, isAgent: true }, SPEECH_AUDIENCE, NOW)).rejects.toBeInstanceOf(SpeechWindowRequiredError);
  });

  it('RED: a presentation to a DIFFERENT audience does not open the commons window (never stacked, never borrowed)', async () => {
    const db = createFakeFirestore();
    seedPresentation(db, AGENT, 'wallet_aw_other', NOW - DAY);
    seedBurn(db, BURN, AGENT, FIFTEEN_PVT);
    await expect(assertSpeechWindow(db as unknown as Firestore, { walletId: AGENT, isAgent: true }, SPEECH_AUDIENCE, NOW)).rejects.toBeInstanceOf(SpeechWindowRequiredError);
  });

  it('RED: an unreadable / unverified backing burn opens no window at all (fail-closed: it reads 0, under the floor)', async () => {
    const db = createFakeFirestore();
    seedPresentation(db, AGENT, SPEECH_AUDIENCE, NOW - DAY);
    db.store.set(`pvt_burn_records/${BURN}`, { wallet_id: AGENT, status: 'recorded', verified: false, amount_atomic: FIFTEEN_PVT.toString() });
    const committer = await resolveSpeechCommitter(db as unknown as Firestore, { walletId: AGENT, isAgent: true });
    expect(await findLiveSpeechWindow(db as unknown as Firestore, committer, SPEECH_AUDIENCE, NOW)).toBeNull();
    const missing = createFakeFirestore();
    seedPresentation(missing, AGENT, SPEECH_AUDIENCE, NOW - DAY);
    expect(await findLiveSpeechWindow(missing as unknown as Firestore, committer, SPEECH_AUDIENCE, NOW)).toBeNull();
  });

  it('a human with no first-party wallet doc has no presenter id → 428 (fail-closed)', async () => {
    const db = createFakeFirestore();
    await expect(assertSpeechWindow(db as unknown as Firestore, { walletId: 'user_h', isAgent: false }, SPEECH_AUDIENCE, NOW)).rejects.toBeInstanceOf(SpeechWindowRequiredError);
  });
});

describe('hasOpenRelationship — bilateral speech inside a relationship needs no further window', () => {
  const A = { kind: 'agent' as const, id: 'wallet_aw_a' };
  const B = { kind: 'agent' as const, id: 'wallet_aw_b' };

  it('RED: two strangers have no relationship', async () => {
    const db = createFakeFirestore();
    expect(await hasOpenRelationship(db as unknown as Firestore, A, B, NOW)).toBe(false);
  });

  it('a live 15 PVT handshake in EITHER direction is a relationship; RED: a 5 PVT one is not', async () => {
    const db = createFakeFirestore();
    seedPresentation(db, B.id, A.id, NOW - DAY);
    seedBurn(db, BURN, B.id, FIVE_PVT);
    expect(await hasOpenRelationship(db as unknown as Firestore, A, B, NOW)).toBe(false);
    expect(await hasOpenRelationship(db as unknown as Firestore, B, A, NOW)).toBe(false);
    seedBurn(db, BURN, B.id, FIFTEEN_PVT);
    expect(await hasOpenRelationship(db as unknown as Firestore, A, B, NOW)).toBe(true);
    expect(await hasOpenRelationship(db as unknown as Firestore, B, A, NOW)).toBe(true);
  });

  it('an escrow / agent job / human job / dispute / thread between them is a relationship (both orders)', async () => {
    for (const [coll, x, y] of [
      ['escrows', 'depositor_wallet_id', 'recipient_wallet_id'],
      ['jobs', 'poster_wallet_id', 'assigned_wallet_id'],
      ['commons_human_jobs', 'poster_wallet_id', 'accepted_applicant_wallet_id'],
      ['general_disputes', 'filed_by', 'respondent'],
      ['commons_threads', 'party_a', 'party_b'],
    ] as const) {
      const db = createFakeFirestore();
      db.store.set(`${coll}/row`, { [x]: B.id, [y]: A.id });
      expect(await hasOpenRelationship(db as unknown as Firestore, A, B, NOW)).toBe(true);
    }
  });

  it('a beneficiary link (agent.linked_human_user_id === human) is a relationship', async () => {
    const db = createFakeFirestore();
    db.store.set(`agent_wallets/${A.id}`, { linked_human_user_id: 'user_h' });
    expect(await hasOpenRelationship(db as unknown as Firestore, A, { kind: 'human', id: 'user_h' }, NOW)).toBe(true);
    expect(await hasOpenRelationship(db as unknown as Firestore, A, { kind: 'human', id: 'user_other' }, NOW)).toBe(false);
  });
});

describe('the talking pass takes a 15 PVT burn — humans and agents alike, whatever the tier', () => {
  const asAgent = { walletId: AGENT, isAgent: true };

  it('RED: a live 5 PVT pass (the pe_fact floor) does not count — 428 names the 15 PVT burn and says the 5 did not count', async () => {
    const db = createFakeFirestore();
    seedPresentation(db, AGENT, SPEECH_AUDIENCE, NOW - DAY);
    seedBurn(db, BURN, AGENT, FIVE_PVT);
    const err = await assertSpeechWindow(db as unknown as Firestore, asAgent, SPEECH_AUDIENCE, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpeechWindowRequiredError);
    const e = err as SpeechWindowRequiredError;
    expect(e.status).toBe(428);
    expect(e.reason).toBe('rail_handshake_required');
    expect(e.message).toMatch(/at least 15 PVT/);
    expect(e.message).toMatch(/5 PVT burn, which does not count/);
    expect(e.message).toMatch(/provian speech-window --open/);
    expect(e.body()).toEqual({
      error: e.message, reason: 'rail_handshake_required', present_to: SPEECH_AUDIENCE,
      min_burn_atomic: FIFTEEN_PVT.toString(), min_burn_pvt: '15', below_floor_burn_pvt: '5',
    });
    const status = await speechWindowStatus(db as unknown as Firestore, asAgent, NOW);
    expect(status).toEqual({ live: false, expires_at: null, audience: SPEECH_AUDIENCE, min_burn_pvt: '15', below_floor_burn_pvt: '5' });
  });

  it('just under the floor (15 PVT minus one atomic unit) does not count; exactly 15 does', async () => {
    const db = createFakeFirestore();
    seedPresentation(db, AGENT, SPEECH_AUDIENCE, NOW - DAY);
    seedBurn(db, BURN, AGENT, FIFTEEN_PVT - 1n);
    await expect(assertSpeechWindow(db as unknown as Firestore, asAgent, SPEECH_AUDIENCE, NOW)).rejects.toBeInstanceOf(SpeechWindowRequiredError);
    seedBurn(db, BURN, AGENT, FIFTEEN_PVT);
    expect((await assertSpeechWindow(db as unknown as Firestore, asAgent, SPEECH_AUDIENCE, NOW)).burnId).toBe(BURN);
  });

  it('the rule is the burn, not the tier: a 15 PVT pe_fact pass and a 15 PVT reputation pass both count', async () => {
    for (const tier of ['pe_fact', 'reputation'] as const) {
      const db = createFakeFirestore();
      seedPresentation(db, AGENT, SPEECH_AUDIENCE, NOW - DAY, BURN, tier);
      seedBurn(db, BURN, AGENT, FIFTEEN_PVT);
      const w = await assertSpeechWindow(db as unknown as Firestore, asAgent, SPEECH_AUDIENCE, NOW);
      expect(w.tier).toBe(tier);
    }
  });

  it('a human (the phone: reputation tier, 15 PVT) has a live pass through the first-party wallet id', async () => {
    const db = createFakeFirestore();
    db.store.set('wallets/wdoc_h', { user_id: 'user_h', type: 'human', address: `0x${'1'.repeat(40)}` });
    seedPresentation(db, 'wdoc_h', SPEECH_AUDIENCE, NOW - DAY, BURN, 'reputation');
    seedBurn(db, BURN, 'wdoc_h', FIFTEEN_PVT);
    const w = await assertSpeechWindow(db as unknown as Firestore, { walletId: 'user_h', isAgent: false }, SPEECH_AUDIENCE, NOW);
    expect(w.burnAmountAtomic).toBe(FIFTEEN_PVT);
    // RED: the same human with a 5 PVT burn is refused like an agent.
    seedBurn(db, BURN, 'wdoc_h', FIVE_PVT);
    await expect(assertSpeechWindow(db as unknown as Firestore, { walletId: 'user_h', isAgent: false }, SPEECH_AUDIENCE, NOW)).rejects.toBeInstanceOf(SpeechWindowRequiredError);
  });

  it('a fresher 5 PVT pass never hides an older live 15 PVT pass', async () => {
    const db = createFakeFirestore();
    const OLD = 'c'.repeat(64);
    seedPresentation(db, AGENT, SPEECH_AUDIENCE, NOW - 3 * DAY, OLD);
    seedBurn(db, OLD, AGENT, FIFTEEN_PVT);
    seedPresentation(db, AGENT, SPEECH_AUDIENCE, NOW - DAY, BURN);
    seedBurn(db, BURN, AGENT, FIVE_PVT);
    const w = await assertSpeechWindow(db as unknown as Firestore, asAgent, SPEECH_AUDIENCE, NOW);
    expect(w.burnId).toBe(OLD);
    expect(w.expiresAt).toBe(NOW - 3 * DAY + 7 * DAY);
  });

  it('the floor is read from the reputation presentation floor policy, never a literal: scheduled at 20, a 15 PVT pass is refused', async () => {
    const db = createFakeFirestore();
    seedPresentation(db, AGENT, SPEECH_AUDIENCE, NOW - DAY);
    seedBurn(db, BURN, AGENT, FIFTEEN_PVT);
    db.store.set('burn_floor_policy/presentation_reputation', { floor_atomic: (20n * 10n ** 18n).toString() });
    expect(await resolveTalkingPassFloorAtomic(db as unknown as Firestore)).toBe(20n * 10n ** 18n);
    const err = await assertSpeechWindow(db as unknown as Firestore, asAgent, SPEECH_AUDIENCE, NOW).catch((e: unknown) => e);
    expect((err as SpeechWindowRequiredError).body()).toMatchObject({ min_burn_pvt: '20', below_floor_burn_pvt: '15' });
  });
});

describe('the handshake-state read judges a provian:commons pass by the talking-pass rule', () => {
  it('RED: a live 5 PVT pass reads below_floor (never live), so `speech-window --open` burns the 15 instead of trusting it', async () => {
    const db = createFakeFirestore();
    seedPresentation(db, AGENT, SPEECH_AUDIENCE, NOW - DAY);
    seedBurn(db, BURN, AGENT, FIVE_PVT);
    const st = await readTalkingPassAwareHandshakeState(db as unknown as Firestore, AGENT, SPEECH_AUDIENCE, NOW);
    expect(st.state).toBe('below_floor');
    expect(st).toMatchObject({ min_burn_pvt: '15', below_floor_burn_pvt: '5' });
    expect(st.burnId).toBeUndefined();
    seedBurn(db, BURN, AGENT, FIFTEEN_PVT);
    const live = await readTalkingPassAwareHandshakeState(db as unknown as Firestore, AGENT, SPEECH_AUDIENCE, NOW);
    expect(live).toMatchObject({ state: 'live', burnId: BURN, min_burn_pvt: '15', expiresAt: NOW - DAY + 7 * DAY });
  });

  it('a handshake to a wallet (a rail counterparty) keeps the plain rail state — escrow and jobs keep their tier floors', async () => {
    const db = createFakeFirestore();
    seedPresentation(db, AGENT, 'wallet_aw_other', NOW - DAY);
    seedBurn(db, BURN, AGENT, FIVE_PVT);
    const st = await readTalkingPassAwareHandshakeState(db as unknown as Firestore, AGENT, 'wallet_aw_other', NOW);
    expect(st.state).toBe('live');
    expect(st.min_burn_pvt).toBeUndefined();
  });

  it('no presentation reads none, with the floor named', async () => {
    const db = createFakeFirestore();
    expect(await readTalkingPassAwareHandshakeState(db as unknown as Firestore, AGENT, SPEECH_AUDIENCE, NOW)).toMatchObject({ state: 'none', min_burn_pvt: '15' });
  });
});

describe('escrow and hire handshakes take the same 15 PVT burn', () => {
  const APPLICANT = 'wallet_aw_applicant';

  it('RED: a live 5 PVT handshake to the counterparty does not let an escrow or hire commit — 428 names the 15 PVT floor', async () => {
    const db = createFakeFirestore();
    seedPresentation(db, AGENT, APPLICANT, NOW - DAY);
    seedBurn(db, BURN, AGENT, FIVE_PVT);
    const err = await assertFundedHandshake(db as unknown as Firestore, AGENT, APPLICANT, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RailHandshakeError);
    expect((err as RailHandshakeError).status).toBe(428);
    expect((err as RailHandshakeError).reason).toBe('rail_handshake_required');
    expect((err as Error).message).toMatch(/at least 15 PVT is required before this escrow or hire commits/);
    expect((err as Error).message).toMatch(/5 PVT burn, which does not count/);
  });

  it('a live 15 PVT handshake commits it (either tier); no handshake is refused without a below-floor note', async () => {
    for (const tier of ['pe_fact', 'reputation'] as const) {
      const db = createFakeFirestore();
      seedPresentation(db, AGENT, APPLICANT, NOW - DAY, BURN, tier);
      seedBurn(db, BURN, AGENT, FIFTEEN_PVT);
      expect((await assertFundedHandshake(db as unknown as Firestore, AGENT, APPLICANT, NOW)).burnId).toBe(BURN);
    }
    const none = await assertFundedHandshake(createFakeFirestore() as unknown as Firestore, AGENT, APPLICANT, NOW).catch((e: unknown) => e);
    expect((none as Error).message).not.toMatch(/does not count/);
  });

  it('the phone hire (a person presenting from the first-party wallet id, reputation tier, 15 PVT) still commits', async () => {
    const db = createFakeFirestore();
    db.store.set('wallets/wdoc_h', { user_id: 'user_h', type: 'human', address: `0x${'1'.repeat(40)}` });
    seedPresentation(db, 'wdoc_h', APPLICANT, NOW - DAY, BURN, 'reputation');
    seedBurn(db, BURN, 'wdoc_h', FIFTEEN_PVT);
    const committer = await resolveSpeechCommitter(db as unknown as Firestore, { walletId: 'user_h', isAgent: false });
    expect((await assertFundedHandshake(db as unknown as Firestore, committer.presenterWalletId, APPLICANT, NOW)).burnId).toBe(BURN);
  });

  it('the floor is read from policy: scheduled at 20, a 15 PVT handshake is refused', async () => {
    const db = createFakeFirestore();
    seedPresentation(db, AGENT, APPLICANT, NOW - DAY);
    seedBurn(db, BURN, AGENT, FIFTEEN_PVT);
    db.store.set('burn_floor_policy/presentation_reputation', { floor_atomic: (20n * 10n ** 18n).toString() });
    await expect(assertFundedHandshake(db as unknown as Firestore, AGENT, APPLICANT, NOW)).rejects.toThrow(/at least 20 PVT/);
  });
});
