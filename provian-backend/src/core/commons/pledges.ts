/**
 * PLEDGE (a public commitment backed by destroyed value), using the RAIL HANDSHAKE (burn-to-present, Part 1).
 *
 * An agent makes a PLEDGE — a public, staked commitment to the commons ("I pledge
 * to keep this service free for a year"). A pledge is a rail-mediated commitment,
 * so it commits ONLY behind a live commons HANDSHAKE: a burn-backed presentation
 * the agent produced to `RAIL_COMMONS_AUDIENCE` within the finite window. That
 * presentation IS the burn (the single verified on-chain PVT burn, already
 * consumed globally-single-use in `burn_consumptions` at presentation time) — the
 * pledge does NOT burn again (no stacked burns; single-use is on the
 * presentation). ONE commons handshake covers the agent's commons commitments —
 * pledges, subscriptions, bonds — for the window; when it lapses the agent
 * re-presents. No per-action pledge burn is stacked on the handshake.
 *
 * Records to its own plain `commons_pledges` collection; publicly verifiable via
 * the resolver, which surfaces the backing burn so the "destroyed value" is still
 * checkable. NOT A PE (no emitted action-type literal → the matrix digest
 * and the monetary signature are untouched). Mints nothing. NOT money-path.
 */

import { v4 as uuidv4 } from 'uuid';
import type { AgentBankDeps } from '../agent-bank/types';
import {
  assertLiveHandshake,
  RailHandshakeError,
  RAIL_COMMONS_AUDIENCE,
} from '../rail/handshake';

export const COMMONS_PLEDGES_COLLECTION = 'commons_pledges';

export const PLEDGE_STATEMENT_MIN_LENGTH = 8;
export const PLEDGE_STATEMENT_MAX_LENGTH = 1000;

/** A pledge id: `pledge_<uuid>` (one per committing action within a handshake). */
const PLEDGE_ID_RE = /^pledge_[0-9a-f-]{36}$/;

export interface PledgeDocument {
  readonly pledge_id: string;
  readonly wallet_id: string;
  readonly agent_id: string;
  readonly statement: string;
  readonly chain: string;
  /** The backing commons-handshake presentation's verified on-chain burn (the
   *  destroyed value behind the commitment) and presentation id. */
  readonly backing_burn_id: string;
  readonly backing_presentation_id: string;
  readonly created_at: number;
}

export interface MakePledgeInput {
  readonly walletId: string;
  readonly agentWallet: { id: string; agent_id: string } | null | undefined;
  readonly statement: string;
  readonly nowMs?: number;
}

export type MakePledgeResult =
  | { ok: true; pledge: PledgeDocument }
  | { ok: false; status: number; error: string; reason?: string };

function normalizeStatement(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length < PLEDGE_STATEMENT_MIN_LENGTH || trimmed.length > PLEDGE_STATEMENT_MAX_LENGTH) return null;
  return trimmed;
}

/**
 * Make a pledge behind a live commons handshake. Fail-closed: no live handshake →
 * 428 (present to the commons first). The pledge rides the handshake's single
 * burn; it never burns again.
 */
export async function makePledge(
  deps: AgentBankDeps,
  input: MakePledgeInput,
): Promise<MakePledgeResult> {
  const { walletId, agentWallet } = input;
  const nowMs = input.nowMs ?? Date.now();

  if (!agentWallet || agentWallet.id !== walletId) {
    return { ok: false, status: 403, error: 'Access denied - wallet_id mismatch' };
  }
  const statement = normalizeStatement(input.statement);
  if (statement === null) {
    return {
      ok: false,
      status: 400,
      error: `statement must be ${PLEDGE_STATEMENT_MIN_LENGTH}-${PLEDGE_STATEMENT_MAX_LENGTH} chars`,
    };
  }

  // RAIL HANDSHAKE gate: a live commons presentation is required before the
  // pledge commits (the presentation IS the burn behind this commitment).
  let handshake;
  try {
    handshake = await assertLiveHandshake(deps.db, walletId, RAIL_COMMONS_AUDIENCE, nowMs);
  } catch (err) {
    if (err instanceof RailHandshakeError) return { ok: false, status: err.status, error: err.message, reason: err.reason };
    throw err;
  }

  const pledgeId = `pledge_${uuidv4()}`;
  const doc: PledgeDocument = {
    pledge_id: pledgeId,
    wallet_id: walletId,
    agent_id: agentWallet.agent_id,
    statement,
    chain: 'base',
    backing_burn_id: handshake.burnId,
    backing_presentation_id: handshake.presentationId,
    created_at: nowMs,
  };
  await deps.db.collection(COMMONS_PLEDGES_COLLECTION).doc(pledgeId).create(doc as unknown as FirebaseFirestore.DocumentData);
  return { ok: true, pledge: doc };
}

/** Public verify: resolve a pledge by its id. Null if not found. */
export async function getPledge(
  deps: AgentBankDeps,
  pledgeId: string,
): Promise<PledgeDocument | null> {
  if (typeof pledgeId !== 'string' || !PLEDGE_ID_RE.test(pledgeId)) return null;
  const snap = await deps.db.collection(COMMONS_PLEDGES_COLLECTION).doc(pledgeId).get();
  return snap.exists ? (snap.data() as PledgeDocument) : null;
}

/** Every pledge a wallet has made (owner history). */
export async function pledgesByWallet(
  deps: AgentBankDeps,
  walletId: string,
): Promise<PledgeDocument[]> {
  const q = await deps.db.collection(COMMONS_PLEDGES_COLLECTION)
    .where('wallet_id', '==', walletId).get();
  return q.docs.map((d) => d.data() as PledgeDocument);
}
