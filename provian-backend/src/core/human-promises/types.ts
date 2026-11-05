/**
 * Human P2P promise — relay data model + state machine.
 *
 * The `human_promises/{promise_id}` collection replaces the Firestore
 * `promise_sync` side-channel. Where `promise_sync` was keyed by forgeable
 * Firebase-anonymous uids with no wallet binding, this collection is written
 * ONLY by the relay (Admin SDK) under human wallet auth, and every agreement is a
 * REAL EIP-191 wallet signature over the promise digest.
 *
 * Terms live as E2E ciphertext the relay cannot read: each party stores their OWN
 * seed-derived self-encrypted copy of the plaintext terms (decryptable only by
 * that party's wallet key), so a party who recovers their wallet on a new phone
 * recovers their terms. Plaintext never reaches the relay; the relay holds only
 * the digest the signatures cover.
 */

export type HumanPromiseStatus =
  | 'pending'
  | 'accepted'
  | 'fulfilled'
  | 'broken'
  | 'disputed'
  | 'expired'
  | 'offered'
  | 'countered'
  | 'rejected';

/**
 * The EXACT transition table the mobile client enforces
 * (`src/core/promises/PromiseService.ts` VALID_TRANSITIONS). Held here verbatim so
 * the relay is the same state machine — every state, every edge, terminal states
 * terminal. If the client table changes, this must change with it.
 */
export const HUMAN_PROMISE_VALID_TRANSITIONS: Record<HumanPromiseStatus, ReadonlySet<HumanPromiseStatus>> = {
  pending: new Set(['accepted', 'rejected', 'expired', 'countered', 'offered']),
  accepted: new Set(['fulfilled', 'broken', 'disputed', 'expired']),
  offered: new Set(['accepted', 'countered', 'rejected', 'expired']),
  countered: new Set(['accepted', 'countered', 'rejected', 'expired']),
  fulfilled: new Set([]), // terminal
  broken: new Set([]), // terminal
  disputed: new Set(['fulfilled', 'broken', 'expired']),
  expired: new Set([]), // terminal
  rejected: new Set([]), // terminal
};

/** Terminal states — no further transition may leave them. */
export const HUMAN_PROMISE_TERMINAL_STATUSES: ReadonlySet<HumanPromiseStatus> = new Set([
  'fulfilled',
  'broken',
  'expired',
  'rejected',
]);

export function isValidHumanPromiseTransition(
  from: HumanPromiseStatus,
  to: HumanPromiseStatus,
): boolean {
  const allowed = HUMAN_PROMISE_VALID_TRANSITIONS[from];
  return !!allowed && allowed.has(to);
}

/**
 * A party's terms/accept/counter agreement record, keyed by their lowercased EVM
 * address in `parties`. `signed_digest` is the digest THIS signature covers — on a
 * counter the digest changes, so the non-countering party's `signed_digest` goes
 * stale and they must re-sign (via accept) before `accepted` is valid again.
 */
export interface HumanPromisePartyRecord {
  address: string;
  role: 'creator' | 'acceptor';
  signature: string;
  /** The digest this signature is over. */
  signed_digest: string;
  signed_at: number;
  /** Seed-derived self-encrypted terms, opaque to the relay. */
  terms_ciphertext: string;
}

/** A party's close-out (fulfillment) attestation, keyed by lowercased address. */
export interface HumanPromiseCloseoutRecord {
  address: string;
  /** EIP-191 over the `closeout` phase message for the current digest. */
  signature: string;
  signed_at: number;
}

export interface HumanPromiseDocument {
  promise_id: string;
  /** hex sha256 the agreement signatures cover; updated on a counter. */
  digest: string;
  status: HumanPromiseStatus;
  creator_address: string;
  creator_user_id: string;
  acceptor_address: string | null;
  acceptor_user_id: string | null;
  /** Terms/accept/counter signers, ≤ 2 keys (creator + one acceptor). */
  parties: Record<string, HumanPromisePartyRecord>;
  /** Close-out signers, ≤ 2 keys, a subset of `parties` keys. */
  closeout: Record<string, HumanPromiseCloseoutRecord>;
  created_at: number;
  updated_at: number;
  /** Auto-purge after this instant (30 days from create). */
  expires_at: number;
}

export const HUMAN_PROMISES_COLLECTION = 'human_promises';

/** 30-day TTL, matching the retired promise_sync client TTL. */
export const HUMAN_PROMISE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
