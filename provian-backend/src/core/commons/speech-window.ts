/**
 * COMMONS SPEECH WINDOW ("a presentation opens a voice": the gate handshake in Provian's own room).
 *
 * the standing rule: Commons speech is priced by the presentation handshake, the 08-19 shape (fold,
 * never stack). Writing to the Commons — a forum post, reply, vote, flag or challenge; a want post;
 * a job post; opening a thread with a wallet you have no relationship with — requires a LIVE
 * PRESENTATION WINDOW opened by ONE burn at the existing burn-consumption floors. Inside an open
 * relationship nothing further is required. Humans and agents identically.
 *
 * This module is the ONE place that answers "may this actor speak here now, and against which burn" *
 * - {@link resolveSpeechCommitter} maps a Commons actor (human user id or agent wallet id) to the
 * TWO ids the rail uses — the presenter wallet id its presentations are recorded under
 * (`commons_presentations.wallet_id` the agent wallet id, or the human's first-party
 * `wallets/{doc}` id) and the audience id OTHER parties present to (the Commons wallet id).
 * - {@link findLiveSpeechWindow} derives the window read-only from the presentation the actor
 * already produced (`findLiveHandshake`) and attaches the backing burn's verified on-chain
 * amount — the budget the speech PEs sealed under this window are bounded by
 * (`core/pvt/speech-window-budget.ts`).
 * - {@link assertSpeechWindow} is the gate every speech writer calls at its commitment point;
 * it throws {@link SpeechWindowRequiredError} (HTTP 428, `rail_handshake_required`) carrying
 * `present_to` so a client can open the window and retry.
 * - {@link hasOpenRelationship} is the "inside an open relationship" test for bilateral
 * speech (threads): a live handshake in EITHER direction, an existing escrow / job / human job
 * / general dispute / thread between the two wallets, or a beneficiary link.
 *
 * Read-only: touches no burn ledger, no PE, no action-type literal. The burn itself was consumed
 * (single-use) when the presentation was produced; speech never burns again.
 */

import type { Firestore } from 'firebase-admin/firestore';
import {
  findLiveHandshake,
  RailHandshakeError,
  RAIL_COMMONS_AUDIENCE,
  RAIL_HANDSHAKE_REQUIRED_REASON,
  RAIL_HANDSHAKE_REQUIRED_STATUS,
  type RailHandshake,
} from '../rail/handshake';
import { PVT_BURN_RECORDS_COLLECTION, parseAmountAtomic } from './burn-consumption';
import { resolveHumanWallet } from '../presentation/principal';

/** A Commons party: an agent wallet or a human account, by its Commons wallet id. */
export interface PartyRef {
  readonly kind: 'agent' | 'human';
  /** The Commons wallet id: `wallet_aw_…` for an agent, the user id for a human. */
  readonly id: string;
}

/** The two rail identities of one Commons actor. */
export interface SpeechCommitter {
  readonly party: PartyRef;
  /** The id this actor's OWN presentations are recorded under (`commons_presentations.wallet_id`). */
  readonly presenterWalletId: string;
  /** The audience string other parties present TO when they address this actor. */
  readonly audienceId: string;
}

/** A live speech window: the backing handshake plus the burn amount that bounds its speech budget. */
export interface SpeechWindow extends RailHandshake {
  /** The backing burn's verified on-chain amount (atomic PVT units, 0n if unreadable — fail-closed). */
  readonly burnAmountAtomic: bigint;
  readonly audience: string;
}

export class SpeechWindowRequiredError extends RailHandshakeError {
  constructor(
    /** The audience the caller must present to (burn-to-present) to open the window. */
    public readonly presentTo: string,
  ) {
    super(
      RAIL_HANDSHAKE_REQUIRED_STATUS,
      presentTo === RAIL_COMMONS_AUDIENCE
        ? 'a live presentation window is required to write to the Commons: present (burn-to-present) to provian:commons first'
        : 'a live presentation window is required to open a thread with a wallet you have no relationship with: present (burn-to-present) to that wallet first',
      RAIL_HANDSHAKE_REQUIRED_REASON,
    );
    this.name = 'SpeechWindowRequiredError';
  }
}

export const SPEECH_AUDIENCE = RAIL_COMMONS_AUDIENCE;

export function partyRefOf(auth: { walletId: string; isAgent: boolean }): PartyRef {
  return { kind: auth.isAgent ? 'agent' : 'human', id: auth.walletId };
}

export function isAgentPartyId(id: string): boolean {
  return id.startsWith('wallet_aw_');
}

/**
 * Resolve the rail identities of a Commons actor. An agent presents under its own wallet id; a
 * human presents under its first-party `wallets/{doc}` id (the id `resolveHumanPrincipal` binds
 * presentations to) — never client-supplied. Fail-closed: a human with no first-party wallet has
 * no presenter id and therefore no window (`presenterWalletId: ''` → no handshake can match).
 */
export async function resolveSpeechCommitter(
  db: Firestore,
  auth: { walletId: string; isAgent: boolean },
): Promise<SpeechCommitter> {
  const party = partyRefOf(auth);
  if (party.kind === 'agent') {
    return { party, presenterWalletId: party.id, audienceId: party.id };
  }
  const wallet = await resolveHumanWallet(db, party.id);
  return {
    party,
    presenterWalletId: wallet.ok ? wallet.walletId : '',
    audienceId: party.id,
  };
}

/** Resolve the presenter wallet id of ANY party ref (the counterpart of `resolveSpeechCommitter`). */
export async function presenterWalletIdOf(db: Firestore, party: PartyRef): Promise<string> {
  if (party.kind === 'agent') return party.id;
  const wallet = await resolveHumanWallet(db, party.id);
  return wallet.ok ? wallet.walletId : '';
}

async function readBurnAmountAtomic(db: Pick<Firestore, 'collection'>, burnId: string): Promise<bigint> {
  try {
    const snap = await db.collection(PVT_BURN_RECORDS_COLLECTION).doc(burnId).get();
    if (!snap.exists) return 0n;
    const row = snap.data() as Record<string, unknown> | undefined;
    if (!row || row.status !== 'recorded' || row.verified !== true) return 0n;
    return parseAmountAtomic(row.amount_atomic);
  } catch {
    return 0n;
  }
}

/**
 * The freshest live speech window for (committer → audience), or null. Derived read-only from
 * the committer's own presentations; the backing burn amount is read from the verified burn row
 * (0n if it cannot be read — a window with no readable burn admits no minting speech).
 */
export async function findLiveSpeechWindow(
  db: Firestore,
  committer: SpeechCommitter,
  audience: string,
  nowMs: number,
): Promise<SpeechWindow | null> {
  if (!committer.presenterWalletId) return null;
  const hs = await findLiveHandshake(db, committer.presenterWalletId, audience, nowMs);
  if (!hs) return null;
  const burnAmountAtomic = await readBurnAmountAtomic(db, hs.burnId);
  return { ...hs, audience, burnAmountAtomic };
}

/**
 * The speech gate. Call at the COMMITMENT point of every Commons write. Returns the live window
 * (the caller threads it into `generatePE({ speechWindow })` so the sealed PE is budget-bounded)
 * or throws a 428 {@link SpeechWindowRequiredError}.
 */
export async function assertSpeechWindow(
  db: Firestore,
  auth: { walletId: string; isAgent: boolean },
  audience: string,
  nowMs: number,
): Promise<SpeechWindow> {
  const committer = await resolveSpeechCommitter(db, auth);
  const window = await findLiveSpeechWindow(db, committer, audience, nowMs);
  if (!window) throw new SpeechWindowRequiredError(audience);
  return window;
}

/**
 * the caller's own Commons speech-window status (the app's "talking pass" indicator).
 * Read-only; derived exactly the way {@link assertSpeechWindow} derives it, so the indicator can never
 * say "live" when a write would be refused (or the reverse).
 */
export async function speechWindowStatus(
  db: Firestore,
  auth: { walletId: string; isAgent: boolean },
  nowMs: number,
): Promise<{ live: boolean; expires_at: number | null; audience: typeof SPEECH_AUDIENCE }> {
  const committer = await resolveSpeechCommitter(db, auth);
  const window = await findLiveSpeechWindow(db, committer, SPEECH_AUDIENCE, nowMs);
  return { live: window !== null, expires_at: window ? window.expiresAt : null, audience: SPEECH_AUDIENCE };
}

/** The `generatePE` parameter derived from a live window (the budget the accrual enforces). */
export function speechWindowParam(window: SpeechWindow): { burnId: string; burnAmountAtomic: string } {
  return { burnId: window.burnId, burnAmountAtomic: window.burnAmountAtomic.toString() };
}

// ─── Open relationships (bilateral speech) ─────────────────────────────────

async function anyDoc(q: FirebaseFirestore.Query): Promise<boolean> {
  try {
    const snap = await q.limit(1).get();
    return !snap.empty;
  } catch {
    return false; // fail-closed: an unreadable relationship is no relationship
  }
}

/**
 * A thread between the pair that still stands. a thread opened cold on a burn that
 * never reached finality is marked `revoked` and no longer counts as a relationship.
 */
async function anyLiveThread(q: FirebaseFirestore.Query): Promise<boolean> {
  try {
    const snap = await q.limit(20).get();
    return snap.docs.some((d) => (d.data() as { revoked?: unknown }).revoked !== true);
  } catch {
    return false; // fail-closed
  }
}

/** A live handshake between the pair in EITHER direction (a → b first), or null. */
async function liveHandshakeBetween(
  db: Firestore,
  a: PartyRef,
  b: PartyRef,
  nowMs: number,
): Promise<{ burnId: string } | null> {
  const [ca, cb] = await Promise.all([
    resolveSpeechCommitter(db, { walletId: a.id, isAgent: a.kind === 'agent' }),
    resolveSpeechCommitter(db, { walletId: b.id, isAgent: b.kind === 'agent' }),
  ]);
  const [abLive, baLive] = await Promise.all([
    ca.presenterWalletId ? findLiveHandshake(db, ca.presenterWalletId, cb.audienceId, nowMs) : null,
    cb.presenterWalletId ? findLiveHandshake(db, cb.presenterWalletId, ca.audienceId, nowMs) : null,
  ]);
  const live = abLive ?? baLive;
  return live ? { burnId: live.burnId } : null;
}

/** A relationship that stands without any burn: a beneficiary link, a shared institution, a live thread. */
async function standingRelationship(db: Firestore, a: PartyRef, b: PartyRef): Promise<boolean> {
  // Beneficiary link: agent ↔ its linked human.
  const agent = a.kind === 'agent' ? a : b.kind === 'agent' ? b : null;
  const human = a.kind === 'human' ? a : b.kind === 'human' ? b : null;
  if (agent && human) {
    try {
      const aw = await db.collection('agent_wallets').doc(agent.id).get();
      const linked = aw.exists ? (aw.data() as { linked_human_user_id?: unknown }).linked_human_user_id : null;
      if (typeof linked === 'string' && linked === human.id) return true;
    } catch { /* fail-closed */ }
  }

  const pairs: Array<[string, string]> = [[a.id, b.id], [b.id, a.id]];
  const checks: Array<Promise<boolean>> = [];
  for (const [x, y] of pairs) {
    checks.push(anyDoc(db.collection('escrows').where('depositor_wallet_id', '==', x).where('recipient_wallet_id', '==', y)));
    checks.push(anyDoc(db.collection('jobs').where('poster_wallet_id', '==', x).where('assigned_wallet_id', '==', y)));
    checks.push(anyDoc(db.collection('commons_human_jobs').where('poster_wallet_id', '==', x).where('accepted_applicant_wallet_id', '==', y)));
    checks.push(anyDoc(db.collection('general_disputes').where('filed_by', '==', x).where('respondent', '==', y)));
    checks.push(anyLiveThread(db.collection('commons_threads').where('party_a', '==', x).where('party_b', '==', y)));
  }
  const results = await Promise.all(checks);
  return results.some(Boolean);
}

/**
 * Whether two Commons parties already stand in an OPEN relationship, so bilateral speech between
 * them needs no further window. Any one of:
 *  - a live handshake in EITHER direction (a → b or b → a),
 *  - an escrow, agent job, human job, or general dispute between them (any status, both orders),
 *  - an existing thread between them that was not revoked,
 *  - a beneficiary link (the agent's `linked_human_user_id` is the human).
 * Two equality filters per query (no orderBy) so every read serves from automatic indexes.
 */
export async function hasOpenRelationship(
  db: Firestore,
  a: PartyRef,
  b: PartyRef,
  nowMs: number,
): Promise<boolean> {
  if (a.id === b.id) return true;
  if (await liveHandshakeBetween(db, a, b, nowMs)) return true;
  return standingRelationship(db, a, b);
}

/** What an open relationship stands on — `standing` (no burn), or a live handshake's burn. */
export type RelationshipBasis = { readonly kind: 'standing' } | { readonly kind: 'handshake'; readonly burnId: string };

/**
 * the same relationship as {@link hasOpenRelationship}, naming its BASIS, so a thread
 * opened on a handshake alone can record the burn it stands on (and be revoked if that burn never
 * reaches finality). A standing relationship wins over a handshake — it needs no burn.
 */
export async function openRelationshipBasis(
  db: Firestore,
  a: PartyRef,
  b: PartyRef,
  nowMs: number,
): Promise<RelationshipBasis | null> {
  if (a.id === b.id) return { kind: 'standing' };
  const [handshake, standing] = await Promise.all([
    liveHandshakeBetween(db, a, b, nowMs),
    standingRelationship(db, a, b),
  ]);
  if (standing) return { kind: 'standing' };
  return handshake ? { kind: 'handshake', burnId: handshake.burnId } : null;
}
