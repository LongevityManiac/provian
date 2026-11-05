/**
 * PE METER — the per-pair record of whom an actor has paid.
 *
 * Receive authorship asks one question at pricing time: has this actor ever SENT to the
 * counterparty that is now paying it? Before the meter it searched the actor's stored envelopes
 * for an outbound PE to that address. The relay keeps no envelopes now, so the answer is kept as
 * the ruled per-pair record (, item 7: "citation per-pair counts"): one document
 * per (actor, counterparty) the actor has paid, written in the same commit that meters the
 * outbound act. It grows with the number of distinct counterparties, never with history, and the
 * pricing read is a single point read.
 */

import admin from 'firebase-admin';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { isSolanaAddress } from '../external-address/solana-keys';

export const COUNTERPARTY_PAIRS_COLLECTION = 'counterparty_pairs_v1';

/** The acts that establish "this actor has dealt with that counterparty". */
export const OUTBOUND_RELATIONSHIP_ACTION_TYPES: ReadonlySet<string> = new Set(['send', 'x402_payment']);

const EVM_ADDRESS = /^0[xX][0-9a-fA-F]{40}$/;

/**
 * The key a counterparty is recorded and looked up under, or null when it is not an address. An
 * EVM address is lowercased; a Solana address (canonical base58 of 32 bytes) is kept exactly,
 * because base58 is case-significant. A facilitator act on Solana whose counterparty is not a
 * Provian identity names that raw Solana address on BOTH legs (the payment and the receive back),
 * so both must key it the same way, or the receive can never find the payment.
 */
export function normalizeCounterparty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (EVM_ADDRESS.test(trimmed)) return trimmed.toLowerCase();
  return isSolanaAddress(trimmed) ? trimmed : null;
}

export function counterpartyPairDocId(actorId: string, counterparty: string): string {
  return `${actorId}__${normalizeCounterparty(counterparty) ?? counterparty.toLowerCase()}`;
}

/** The counterparty an act records an outbound relationship to, or null. */
export function outboundCounterpartyOf(actionType: string, counterparty: string | null | undefined): string | null {
  if (!OUTBOUND_RELATIONSHIP_ACTION_TYPES.has(actionType)) return null;
  return normalizeCounterparty(counterparty);
}

export function recordOutboundPairInTransaction(
  txn: Transaction,
  db: Firestore,
  input: { readonly actorId: string; readonly counterparty: string; readonly atMs: number },
): void {
  txn.set(db.collection(COUNTERPARTY_PAIRS_COLLECTION).doc(counterpartyPairDocId(input.actorId, input.counterparty)), {
    actor_id: input.actorId,
    counterparty: normalizeCounterparty(input.counterparty) ?? input.counterparty.toLowerCase(),
    outbound_count: admin.firestore.FieldValue.increment(1),
    last_outbound_at_ms: input.atMs,
  }, { merge: true });
}

export async function hasOutboundPair(db: Firestore, actorId: string, counterparty: string): Promise<boolean> {
  const snap = await db.collection(COUNTERPARTY_PAIRS_COLLECTION).doc(counterpartyPairDocId(actorId, counterparty)).get();
  // Only an outbound act ever creates the record, so its existence is the relationship.
  return snap.exists;
}
