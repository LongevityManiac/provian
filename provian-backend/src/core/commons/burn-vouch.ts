/**
 * work package O4 — VOUCH (a costly trust signal), brought under the RAIL HANDSHAKE
 * (burn-to-present, Part 1) as a GATED action class.
 *
 * A vouch is a TRUST ACT: the voucher spends standing to tell the network a third
 * party is credible. ruling GATES it, exactly like escrow /
 * jobs / bonds / pledges / subscriptions / standing-export: the voucher must hold
 * a live, burn-backed PRESENTATION to the vouchee before the vouch commits. That
 * presentation IS the vouch's burn artifact — the vouch does NOT burn again.
 *
 * FOLD, DON'T STACK — how the two burns reconcile to ONE. The shipped vouch
 * carried its OWN per-item scarcity burn (`product:'vouch'`, 15-PVT floor), and a
 * naive gate would ALSO require a presentation burn — two burns for one act. Both
 * burns were always the SAME 15-PVT BondPool filing-fee-family literal at the
 * REPUTATION tier (`PRESENTATION_FLOOR_BY_TIER.reputation === 15e18 ===` the old
 * `vouch` floor `15e18`), so they FOLD onto ONE: the voucher presents a
 * reputation-tier presentation to the vouchee (one 15-PVT burn, consumed once in
 * the GLOBAL single-use `burn_consumptions` ledger as `product:'presentation'`),
 * and the vouch rides that presentation via the live handshake. That single burn
 * does BOTH jobs — anti-sybil QUANTITY control (each distinct trust relationship
 * costs a fresh 15-PVT burn; a shared handshake cannot be established for free)
 * and trust-act QUALITY control (a reputation presentation *proves the voucher
 * has standing* to vouch). Neither job is dropped; neither is double-charged.
 *
 * WHY REPUTATION-TIER specifically: the handshake gate requires the backing
 * presentation be `'reputation'` (not the cheaper 5-PVT `pe_fact`). A vouch is a
 * standing claim, and the 15-PVT scarcity floor must survive the fold — a 5-PVT
 * `pe_fact` handshake would both fail to prove standing and quietly reduce the
 * scarcity burn. `assertLiveHandshake(..., 'reputation')` enforces it.
 *
 * PER-RELATIONSHIP, in-window (matches the other classes and the spirit):
 * ONE reputation handshake to a vouchee covers the voucher's vouches to that
 * vouchee for the finite window — a SECOND vouch to the same party in-window
 * commits with NO new presentation. To vouch for a DIFFERENT party, or after the
 * window lapses / an adverse presenter-side event closes it early, the voucher
 * re-presents (a fresh 15-PVT burn). Event-based invalidation (key rotation,
 * slash / forfeiture, bond abandonment / expiry, reputation downgrade) is keyed
 * on the VOUCHER (the presenter/committer) and honored by the gate.
 *
 * NAME REGISTRY stays UNGATED (unchanged): registering a name is a naming/scarcity
 * act, not a claim about the registrant's trustworthiness to a counterparty — no
 * third party relies on the registrant's standing — so it keeps its own per-name
 * scarcity burn (`product:'name_registry'`). Vouch differs because it IS a trust
 * act; that is the whole basis of gating it and not the name registry.
 *
 * NOT A PE (mirrors the other O-series wants/names): no emitted action-type
 * literal, so the action-policy matrix digest and the monetary
 * signature are untouched. Mints nothing; consumes an already-provenance-anchored
 * burn (through the presentation). Reads only the handshake — touches no burn
 * ledger of its own. Records the vouch to its own plain `commons_burn_vouches`
 * collection.
 */

import { v4 as uuidv4 } from 'uuid';
import type { Firestore } from 'firebase-admin/firestore';
import type { AgentBankDeps } from '../agent-bank/types';
import { assertLiveHandshake, findLiveHandshake, RailHandshakeError, type RailHandshake } from '../rail/handshake';
import { resolveHumanWallet } from '../presentation/principal';

export const COMMONS_BURN_VOUCHES_COLLECTION = 'commons_burn_vouches';

export const VOUCH_NOTE_MAX_LENGTH = 280;
/** An agent id: non-empty, printable, bounded. Kept liberal (external ids vary). */
const AGENT_ID_MAX_LENGTH = 128;

/** A vouch id: `vouch_<uuid>` (one per committing act within a handshake). */
const VOUCH_ID_RE = /^vouch_[0-9a-f-]{36}$/;

export interface BurnVouchDocument {
  readonly vouch_id: string;
  /** The voucher's Commons id (an agent's wallet id; a person's user id). */
  readonly voucher_wallet_id: string;
  /** The voucher's agent id (a person's user id when `voucher_kind === 'human'`). */
  readonly voucher_agent_id: string;
  /** 'human' for a person's vouch; absent on agent vouches (agent). */
  readonly voucher_kind?: 'agent' | 'human';
  /** The vouchee reference the vouch keys on: an agent's agent_id, or a person's user id. */
  readonly target_agent_id: string;
  /** the vouchee's Commons id (agent wallet id / person user id), when known. */
  readonly target_party_id?: string;
  /** the vouchee's kind, when known. */
  readonly target_kind?: 'agent' | 'human';
  readonly note: string | null;
  readonly chain: string;
  /** The backing reputation-handshake presentation's verified on-chain burn (the
   *  destroyed value + proof of standing behind this vouch) and presentation id. */
  readonly backing_burn_id: string;
  readonly backing_presentation_id: string;
  readonly created_at: number;
}

export interface StakeVouchInput {
  readonly walletId: string;
  readonly agentWallet: { id: string; agent_id: string } | null | undefined;
  readonly targetAgentId: string;
  readonly note?: string | null;
  readonly nowMs?: number;
}

export type StakeVouchResult =
  | { ok: true; vouch: BurnVouchDocument }
  | { ok: false; status: number; error: string; reason?: string };

function normalizeAgentId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > AGENT_ID_MAX_LENGTH) return null;
  return trimmed;
}

/** the machine-readable refusal for the excluded (beneficiary-linked) pair. */
export const LINKED_PAIR_VOUCH_REFUSED = 'linked_pair_vouch_refused';

type AgentLinkRead =
  | { ok: true; agentId: string; linkedHumanRefs: Set<string> }
  | { ok: false; error: string };

/** Every reference a string that names the agent's linked human could take (lowercased). */
function linkedRefsOf(row: Record<string, unknown>): Set<string> {
  const refs = new Set<string>();
  for (const key of ['linked_human_user_id', 'linked_human_wallet_id', 'linked_human_address']) {
    const v = row[key];
    if (typeof v === 'string' && v.trim().length > 0) refs.add(v.trim().toLowerCase());
  }
  return refs;
}

/** Read an agent wallet's own record (agent id + linked-human references). Fail-closed. */
async function readAgentLink(db: Firestore, walletId: string): Promise<AgentLinkRead> {
  try {
    const snap = await db.collection('agent_wallets').doc(walletId).get();
    if (!snap.exists) return { ok: false, error: 'voucher agent wallet record not found' };
    const row = (snap.data() ?? {}) as Record<string, unknown>;
    return { ok: true, agentId: typeof row.agent_id === 'string' ? row.agent_id : walletId, linkedHumanRefs: linkedRefsOf(row) };
  } catch {
    return { ok: false, error: 'could not read the voucher agent wallet record' };
  }
}

/**
 * Stake a vouch behind a live REPUTATION rail handshake to the vouchee. Fail-
 * closed: no live reputation handshake → 428 (present to the vouchee first). The
 * vouch rides the handshake's single burn; it never burns again (fold, don't
 * stack). The handshake audience is the `target_agent_id` (the vouchee reference
 * the vouch already keys on), so the voucher's reputation presentation to that
 * vouchee IS the handshake.
 */
export async function stakeVouch(
  deps: AgentBankDeps,
  input: StakeVouchInput,
): Promise<StakeVouchResult> {
  const { walletId, agentWallet } = input;
  const nowMs = input.nowMs ?? Date.now();

  if (!agentWallet || agentWallet.id !== walletId) {
    return { ok: false, status: 403, error: 'Access denied - wallet_id mismatch' };
  }
  const targetAgentId = normalizeAgentId(input.targetAgentId);
  if (targetAgentId === null) {
    return { ok: false, status: 400, error: `target_agent_id must be 1-${AGENT_ID_MAX_LENGTH} chars` };
  }
  if (targetAgentId === agentWallet.agent_id || targetAgentId === agentWallet.id) {
    return { ok: false, status: 400, error: 'cannot vouch for yourself' };
  }
  // EXCLUDED PAIR, enforced here at the relay: an agent cannot vouch
  // for its own beneficiary-linked human. The link is read from the agent's own wallet record
  // (never the request); every id the human is known by — user id, first-party wallet doc id,
  // address — is refused. Fail-closed: an unreadable/missing agent record refuses the vouch.
  const link = await readAgentLink(deps.db as unknown as Firestore, walletId);
  if (!link.ok) return { ok: false, status: 503, error: link.error };
  if (link.linkedHumanRefs.has(targetAgentId.toLowerCase())) {
    return { ok: false, status: 403, error: 'An agent cannot vouch for its own linked human', reason: LINKED_PAIR_VOUCH_REFUSED };
  }
  let note: string | null = null;
  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== 'string' || input.note.length > VOUCH_NOTE_MAX_LENGTH) {
      return { ok: false, status: 400, error: `note must be a string of at most ${VOUCH_NOTE_MAX_LENGTH} chars` };
    }
    note = input.note.trim() || null;
  }

  // RAIL HANDSHAKE gate (fold): a live REPUTATION presentation to the vouchee is
  // required before the vouch commits — that presentation IS the vouch's burn
  // (one 15-PVT reputation burn, consumed globally-single-use at present time).
  // Reputation-tier is enforced so the fold preserves the 15-PVT scarcity floor
  // and the "proves standing" property; a 5-PVT pe_fact handshake does NOT pass.
  let handshake;
  try {
    handshake = await assertLiveHandshake(deps.db, walletId, targetAgentId, nowMs, 'reputation');
  } catch (err) {
    if (err instanceof RailHandshakeError) return { ok: false, status: err.status, error: err.message, reason: err.reason };
    throw err;
  }

  const vouchId = `vouch_${uuidv4()}`;
  const doc: BurnVouchDocument = {
    vouch_id: vouchId,
    voucher_wallet_id: walletId,
    voucher_agent_id: agentWallet.agent_id,
    target_agent_id: targetAgentId,
    note,
    chain: 'base',
    backing_burn_id: handshake.burnId,
    backing_presentation_id: handshake.presentationId,
    created_at: nowMs,
  };
  await deps.db
    .collection(COMMONS_BURN_VOUCHES_COLLECTION)
    .doc(vouchId)
    .create(doc as unknown as FirebaseFirestore.DocumentData);
  return { ok: true, vouch: doc };
}

export interface StakeHumanVouchInput {
  /** The authenticated person's user id (their Commons id). Never client-supplied. */
  readonly userId: string;
  /** The vouchee: an agent wallet id (`wallet_aw_…`), an agent id, or a person's user id. */
  readonly targetId: unknown;
  readonly note?: unknown;
  readonly nowMs?: number;
}

type ResolvedTarget =
  | { kind: 'agent'; partyId: string; agentId: string; linkedHumanRefs: Set<string> }
  | { kind: 'human'; partyId: string };

/** Resolve a vouchee reference to a real participant. Null when it names no one. */
async function resolveVouchTarget(db: Firestore, ref: string): Promise<ResolvedTarget | null> {
  // An agent by wallet id …
  if (ref.startsWith('wallet_aw_')) {
    const snap = await db.collection('agent_wallets').doc(ref).get();
    if (!snap.exists) return null;
    const row = (snap.data() ?? {}) as Record<string, unknown>;
    return {
      kind: 'agent',
      partyId: ref,
      agentId: typeof row.agent_id === 'string' ? row.agent_id : ref,
      linkedHumanRefs: linkedRefsOf(row),
    };
  }
  // … or by agent id …
  const byAgentId = await db.collection('agent_wallets').where('agent_id', '==', ref).limit(1).get();
  if (!byAgentId.empty) {
    const doc = byAgentId.docs[0];
    const row = (doc.data() ?? {}) as Record<string, unknown>;
    return { kind: 'agent', partyId: doc.id, agentId: ref, linkedHumanRefs: linkedRefsOf(row) };
  }
  // … or a person on the Commons (a profile keyed by their user id).
  const profile = await db.collection('commons_profiles').doc(ref).get();
  if (profile.exists) {
    const row = (profile.data() ?? {}) as Record<string, unknown>;
    if (row.participant_type === 'agent') return null; // an agent profile must be named by its wallet
    return { kind: 'human', partyId: ref };
  }
  return null;
}

/**
 * a PERSON vouches for any person or agent, on the SAME reputation-presentation burn
 * and floor agents use (fold, don't stack): the person must hold a live REPUTATION presentation
 * to the vouchee (presented under their first-party `wallets/{doc}` id, audience = the vouchee's
 * Commons id); that presentation IS the vouch's single burn and the vouch carries it
 * (`backing_burn_id` / `backing_presentation_id`). One burn, one benefit.
 *
 * EXCLUDED PAIR, enforced here at the relay: a person cannot vouch for their own
 * beneficiary-linked agent (read from the agent's own record). Self-vouch refuses. NOT a PE.
 */
export async function stakeHumanVouch(
  deps: AgentBankDeps,
  input: StakeHumanVouchInput,
): Promise<StakeVouchResult> {
  const db = deps.db as unknown as Firestore;
  const nowMs = input.nowMs ?? Date.now();
  const userId = input.userId;
  const targetRef = normalizeAgentId(input.targetId);
  if (targetRef === null) {
    return { ok: false, status: 400, error: `target_id must be 1-${AGENT_ID_MAX_LENGTH} chars` };
  }
  let note: string | null = null;
  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== 'string' || input.note.length > VOUCH_NOTE_MAX_LENGTH) {
      return { ok: false, status: 400, error: `note must be a string of at most ${VOUCH_NOTE_MAX_LENGTH} chars` };
    }
    note = input.note.trim() || null;
  }

  const wallet = await resolveHumanWallet(db, userId);
  if (!wallet.ok) return { ok: false, status: wallet.status, error: wallet.error };
  const selfRefs = new Set([userId.toLowerCase(), wallet.walletId.toLowerCase(), wallet.address.toLowerCase()]);
  if (selfRefs.has(targetRef.toLowerCase())) {
    return { ok: false, status: 400, error: 'cannot vouch for yourself' };
  }

  let target: ResolvedTarget | null;
  try {
    target = await resolveVouchTarget(db, targetRef);
  } catch {
    return { ok: false, status: 503, error: 'could not resolve the vouchee' };
  }
  if (target === null) return { ok: false, status: 404, error: 'vouchee not found' };
  if (target.kind === 'human' && selfRefs.has(target.partyId.toLowerCase())) {
    return { ok: false, status: 400, error: 'cannot vouch for yourself' };
  }
  if (target.kind === 'agent') {
    for (const ref of selfRefs) {
      if (target.linkedHumanRefs.has(ref)) {
        return { ok: false, status: 403, error: 'You cannot vouch for your own linked agent', reason: LINKED_PAIR_VOUCH_REFUSED };
      }
    }
  }

  // The handshake: a live REPUTATION presentation from this person's presenter id to the
  // vouchee — addressed to its Commons id, or (agents) to its agent id as agent vouches are.
  let handshake: RailHandshake | null = await findLiveHandshake(db, wallet.walletId, target.partyId, nowMs, undefined, 'reputation');
  if (!handshake && target.kind === 'agent' && target.agentId !== target.partyId) {
    handshake = await findLiveHandshake(db, wallet.walletId, target.agentId, nowMs, undefined, 'reputation');
  }
  if (!handshake) {
    try {
      // Throws the canonical 428 (counts the ops refusal, same message/reason as every gate).
      handshake = await assertLiveHandshake(db, wallet.walletId, target.partyId, nowMs, 'reputation');
    } catch (err) {
      if (err instanceof RailHandshakeError) return { ok: false, status: err.status, error: err.message, reason: err.reason };
      throw err;
    }
  }

  const vouchId = `vouch_${uuidv4()}`;
  const doc: BurnVouchDocument = {
    vouch_id: vouchId,
    voucher_wallet_id: userId,
    voucher_agent_id: userId,
    voucher_kind: 'human',
    target_agent_id: target.kind === 'agent' ? target.agentId : target.partyId,
    target_party_id: target.partyId,
    target_kind: target.kind,
    note,
    chain: 'base',
    backing_burn_id: handshake.burnId,
    backing_presentation_id: handshake.presentationId,
    created_at: nowMs,
  };
  await deps.db
    .collection(COMMONS_BURN_VOUCHES_COLLECTION)
    .doc(vouchId)
    .create(doc as unknown as FirebaseFirestore.DocumentData);
  return { ok: true, vouch: doc };
}

/** Resolve a single vouch by its id. Null if not found or malformed. */
export async function getVouch(
  deps: AgentBankDeps,
  vouchId: string,
): Promise<BurnVouchDocument | null> {
  if (typeof vouchId !== 'string' || !VOUCH_ID_RE.test(vouchId)) return null;
  const snap = await deps.db.collection(COMMONS_BURN_VOUCHES_COLLECTION).doc(vouchId).get();
  return snap.exists ? (snap.data() as BurnVouchDocument) : null;
}

/** Every vouch a wallet has staked. */
export async function vouchesByVoucher(
  deps: AgentBankDeps,
  walletId: string,
): Promise<BurnVouchDocument[]> {
  const q = await deps.db.collection(COMMONS_BURN_VOUCHES_COLLECTION)
    .where('voucher_wallet_id', '==', walletId).get();
  return q.docs.map((d) => d.data() as BurnVouchDocument);
}

/** Every vouch staked FOR a target agent (its costly-signal standing). */
export async function vouchesForTarget(
  deps: AgentBankDeps,
  targetAgentId: string,
): Promise<BurnVouchDocument[]> {
  const q = await deps.db.collection(COMMONS_BURN_VOUCHES_COLLECTION)
    .where('target_agent_id', '==', targetAgentId).get();
  return q.docs.map((d) => d.data() as BurnVouchDocument);
}
