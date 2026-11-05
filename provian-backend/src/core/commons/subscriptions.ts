/**
 * SUBSCRIPTION (a staked, flat subscription), using the RAIL
 * HANDSHAKE (burn-to-present, Part 1).
 *
 * An agent subscribes to a TOPIC — a commons feed / alert channel. A subscription
 * is a rail-mediated commitment, so it commits ONLY behind a live commons
 * HANDSHAKE: a burn-backed presentation the agent produced to
 * `RAIL_COMMONS_AUDIENCE` within the finite window. That presentation IS the burn
 * (already consumed globally-single-use in `burn_consumptions` at presentation
 * time) — the subscription does NOT burn again (no stacked burns). ONE commons
 * handshake covers the agent's commons commitments for the window; when it lapses
 * the agent re-presents. No per-action subscription burn is stacked on the handshake.
 *
 * Records to its own plain `commons_subscriptions` collection. Owner-scoped (a
 * subscription is not a public certificate). NOT A PE (no emitted action-type
 * literal → the matrix digest and the monetary signature are
 * untouched). Mints nothing. NOT money-path.
 */

import { v4 as uuidv4 } from 'uuid';
import type { AgentBankDeps } from '../agent-bank/types';
import {
  assertLiveHandshake,
  RailHandshakeError,
  RAIL_COMMONS_AUDIENCE,
} from '../rail/handshake';

export const COMMONS_SUBSCRIPTIONS_COLLECTION = 'commons_subscriptions';

export const TOPIC_MIN_LENGTH = 2;
export const TOPIC_MAX_LENGTH = 128;
/** A topic key: lowercased, alphanumerics + internal separators. */
const TOPIC_RE = /^[a-z0-9](?:[a-z0-9_.:/-]{0,126}[a-z0-9])$/;

export interface SubscriptionDocument {
  readonly subscription_id: string;
  readonly wallet_id: string;
  readonly agent_id: string;
  readonly topic: string;
  readonly chain: string;
  /** The backing commons-handshake presentation's verified on-chain burn + id. */
  readonly backing_burn_id: string;
  readonly backing_presentation_id: string;
  readonly created_at: number;
}

export interface SubscribeInput {
  readonly walletId: string;
  readonly agentWallet: { id: string; agent_id: string } | null | undefined;
  readonly topic: string;
  readonly nowMs?: number;
}

export type SubscribeResult =
  | { ok: true; subscription: SubscriptionDocument }
  | { ok: false; status: number; error: string; reason?: string };

/** Normalize a topic to its canonical key, or null if invalid. */
export function normalizeTopic(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length < TOPIC_MIN_LENGTH || trimmed.length > TOPIC_MAX_LENGTH) return null;
  const lowered = trimmed.toLowerCase();
  if (!TOPIC_RE.test(lowered)) return null;
  return lowered;
}

/**
 * Subscribe behind a live commons handshake. Fail-closed: no live handshake → 428
 * (present to the commons first). The subscription rides the handshake's single
 * burn; it never burns again.
 */
export async function subscribe(
  deps: AgentBankDeps,
  input: SubscribeInput,
): Promise<SubscribeResult> {
  const { walletId, agentWallet } = input;
  const nowMs = input.nowMs ?? Date.now();

  if (!agentWallet || agentWallet.id !== walletId) {
    return { ok: false, status: 403, error: 'Access denied - wallet_id mismatch' };
  }
  const topic = normalizeTopic(input.topic);
  if (topic === null) {
    return { ok: false, status: 400, error: `topic must be ${TOPIC_MIN_LENGTH}-${TOPIC_MAX_LENGTH} chars, lowercase alphanumerics with internal . _ : / -` };
  }

  // RAIL HANDSHAKE gate: a live commons presentation is required before the
  // subscription commits (the presentation IS the burn behind this commitment).
  let handshake;
  try {
    handshake = await assertLiveHandshake(deps.db, walletId, RAIL_COMMONS_AUDIENCE, nowMs);
  } catch (err) {
    if (err instanceof RailHandshakeError) return { ok: false, status: err.status, error: err.message, reason: err.reason };
    throw err;
  }

  const subscriptionId = `sub_${uuidv4()}`;
  const doc: SubscriptionDocument = {
    subscription_id: subscriptionId,
    wallet_id: walletId,
    agent_id: agentWallet.agent_id,
    topic,
    chain: 'base',
    backing_burn_id: handshake.burnId,
    backing_presentation_id: handshake.presentationId,
    created_at: nowMs,
  };
  await deps.db.collection(COMMONS_SUBSCRIPTIONS_COLLECTION).doc(subscriptionId).create(doc as unknown as FirebaseFirestore.DocumentData);
  return { ok: true, subscription: doc };
}

/** Every subscription a wallet holds (owner view). */
export async function subscriptionsByWallet(
  deps: AgentBankDeps,
  walletId: string,
): Promise<SubscriptionDocument[]> {
  const q = await deps.db.collection(COMMONS_SUBSCRIPTIONS_COLLECTION)
    .where('wallet_id', '==', walletId).get();
  return q.docs.map((d) => d.data() as SubscriptionDocument);
}
