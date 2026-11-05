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
import {
  SPEECH_AUDIENCE,
  SpeechWindowRequiredError,
  assertSpeechWindow,
  findLiveSpeechWindow,
  hasOpenRelationship,
  resolveSpeechCommitter,
  speechWindowParam,
} from './speech-window';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { seedBurn } from './__test-helpers__/speech';

const AGENT = 'wallet_aw_agent';
const BURN = 'e'.repeat(64);
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const FIVE_PVT = 5_000_000_000_000_000_000n;

function seedPresentation(db: FakeFirestore, walletId: string, audience: string, recordedAt: number, burnId = BURN): void {
  db.store.set(`commons_presentations/pres_${walletId}_${audience}_${recordedAt}`, {
    wallet_id: walletId, audience, recorded_at: recordedAt, burn_id: burnId, presentation_id: `jti_${recordedAt}`, tier: 'pe_fact',
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

  it('a live presentation to the commons opens the window and carries the burn amount', async () => {
    const db = createFakeFirestore();
    seedPresentation(db, AGENT, SPEECH_AUDIENCE, NOW - DAY);
    seedBurn(db, BURN, AGENT, FIVE_PVT);
    const w = await assertSpeechWindow(db as unknown as Firestore, { walletId: AGENT, isAgent: true }, SPEECH_AUDIENCE, NOW);
    expect(w.burnId).toBe(BURN);
    expect(w.burnAmountAtomic).toBe(FIVE_PVT);
    expect(w.audience).toBe(SPEECH_AUDIENCE);
    expect(speechWindowParam(w)).toEqual({ burnId: BURN, burnAmountAtomic: FIVE_PVT.toString() });
  });

  it('RED: a lapsed presentation (older than the 7-day window) does not open it', async () => {
    const db = createFakeFirestore();
    seedPresentation(db, AGENT, SPEECH_AUDIENCE, NOW - 8 * DAY);
    seedBurn(db, BURN, AGENT, FIVE_PVT);
    await expect(assertSpeechWindow(db as unknown as Firestore, { walletId: AGENT, isAgent: true }, SPEECH_AUDIENCE, NOW)).rejects.toBeInstanceOf(SpeechWindowRequiredError);
  });

  it('RED: a presentation to a DIFFERENT audience does not open the commons window (never stacked, never borrowed)', async () => {
    const db = createFakeFirestore();
    seedPresentation(db, AGENT, 'wallet_aw_other', NOW - DAY);
    seedBurn(db, BURN, AGENT, FIVE_PVT);
    await expect(assertSpeechWindow(db as unknown as Firestore, { walletId: AGENT, isAgent: true }, SPEECH_AUDIENCE, NOW)).rejects.toBeInstanceOf(SpeechWindowRequiredError);
  });

  it('an unreadable / unverified backing burn yields a window with burnAmountAtomic 0n (admits no minting speech)', async () => {
    const db = createFakeFirestore();
    seedPresentation(db, AGENT, SPEECH_AUDIENCE, NOW - DAY);
    db.store.set(`pvt_burn_records/${BURN}`, { wallet_id: AGENT, status: 'recorded', verified: false, amount_atomic: FIVE_PVT.toString() });
    const committer = await resolveSpeechCommitter(db as unknown as Firestore, { walletId: AGENT, isAgent: true });
    const w = await findLiveSpeechWindow(db as unknown as Firestore, committer, SPEECH_AUDIENCE, NOW);
    expect(w?.burnAmountAtomic).toBe(0n);
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

  it('a live handshake in EITHER direction is a relationship', async () => {
    const db = createFakeFirestore();
    seedPresentation(db, B.id, A.id, NOW - DAY);
    expect(await hasOpenRelationship(db as unknown as Firestore, A, B, NOW)).toBe(true);
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
