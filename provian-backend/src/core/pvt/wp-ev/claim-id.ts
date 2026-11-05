/**
 * WP-EV — deriving a settlement `claimId` from a sealed Provenance Envelope.
 *
 * The PE is the event. Its identity is intrinsic to the provenance record and is never
 * assigned by a settler, so `claimId` is a deterministic content hash over the PE's
 * IMMUTABLE identity fields. `src/core/pvt/wp4/claim-identity.ts` deliberately left this
 * derivation undefined ("a protocol decision that belongs with the PE schema, not with the
 * settler") and enforces only that whatever derivation is used stays stable. This module
 * is that derivation, and it makes the stability it enforces structural rather than
 * clerical: a claim id cannot drift, because nothing chooses it.
 *
 * That closes the standard-lane double mint pinned in
 * `contracts/test/ProvianPVT9Wp4Settlement.t.sol::test_standardLane_freshClaimIdForSameWork_doubleMints`.
 * The kernel dedupes on `claimId` alone and carries no PE identity, so re-settling the same
 * work under a freshly minted id mints twice and nothing on-chain notices. A claim id
 * forced by PE content cannot be freshly minted for a PE that already has one.
 *
 * WHICH FIELDS ARE IDENTITY
 *
 * Only fields from `provenance_envelopes` — the sealed record, where the sole post-seal
 * mutations are `hidden` and `durability: provisional -> final`. Nothing from `pe_history`,
 * which is where every enrichment lives (corroboration status, mint_status transitions, the
 * 72h attestation-enhancement repricing, anchor fields).
 *
 * Nine writers populate `provenance_envelopes` and they do not agree on which fields are
 * present: `agent_id` is absent on the mobile/device/provisional paths, `wallet_id` and
 * `actor_address` are absent on the relay/authorization paths, `attestation_type` on two.
 * A derivation that is undefined for some writers is not deterministic, so the preimage is
 * the universally-present, set-once intersection:
 *
 * id | prev_hash | hash | timestamp | action_type | user_id
 *
 * `created_at` is excluded: it equals `timestamp` for `generatePE` but is a separate
 * `Date.now()` on the mobile and on-ramp writers.
 *
 * Attestation tier plays no part. Identity and tamper-evidence are intrinsic to a
 * software-attested PE exactly as to a hardware-attested one.
 *
 * Pure: nothing here reads Firestore, signs, submits, or opens a connection.
 */

import { createHash } from 'crypto';
import stableStringify from 'json-stable-stringify';
import { GENESIS_PREV_HASH } from '../../pe/constants';
import { PAYOUT_LEG_ROLES, type PayoutLegRole } from './payout-legs';

/** Domain separator. Any change to the preimage MUST bump this. */
const CLAIM_ID_DOMAIN = 'provian.pvt9.claim-id.v1';

const ZERO_BYTES32 = `0x${'0'.repeat(64)}`;

/**
 * The identity projection of a sealed PE. Callers may pass the whole stored document —
 * every other property is ignored by construction, which is what keeps enrichment out of
 * the preimage.
 */
export interface SealedEnvelopeIdentity {
  readonly id: string;
  readonly prev_hash: string;
  readonly hash: string;
  readonly timestamp: number;
  readonly action_type: string;
  /** Null on paths that record no owning user; `undefined` is normalized to null. */
  readonly user_id?: string | null;
}

export type ClaimIdRejection =
  | 'missing_id'
  | 'missing_prev_hash'
  | 'missing_hash'
  | 'invalid_timestamp'
  | 'missing_action_type'
  | 'invalid_user_id'
  | 'preimage_unserializable'
  | 'degenerate_claim_id'
  | 'invalid_leg';

export type ClaimIdResult =
  | { readonly kind: 'derived'; readonly claimId: string }
  | { readonly kind: 'rejected'; readonly reason: ClaimIdRejection };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Fold the PE id exactly the way `wp4/claim-identity.ts::normalizePeId` folds it — trim and
 * lowercase — so the module that DERIVES an identity and the module that ENFORCES its
 * stability agree on what counts as one PE. If this derivation distinguished two spellings
 * that the stability checker considers the same PE, the checker would see legitimate work as
 * `claim_id_drift`; if it merged two the checker distinguishes, they would collide.
 *
 * To be accurate about what this is NOT: `validateEnvelopeId` (`src/pe-validation.ts`) is a
 * gate rather than a normalizer and applies no case rule, and Firestore document ids are
 * case-sensitive, so `PE-Abc` and `pe-abc` are in fact two distinct documents. Folding them
 * here cannot cause a collision — each carries its own `hash`, which is also in the preimage
 * — so this is agreement with the sibling module, not a claim about the relay.
 */
function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}

/** Hex digests are case-insensitive; casing is not semantic. */
function normalizeHash(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Derive the claim id for a sealed PE.
 *
 * Fail-closed: a PE missing any identity field has no derivable identity and is rejected
 * rather than hashed over a partial preimage.
 */
export function deriveClaimId(pe: SealedEnvelopeIdentity): ClaimIdResult {
  if (!isNonEmptyString(pe?.id)) return { kind: 'rejected', reason: 'missing_id' };
  if (!isNonEmptyString(pe.prev_hash)) return { kind: 'rejected', reason: 'missing_prev_hash' };
  if (!isNonEmptyString(pe.hash)) return { kind: 'rejected', reason: 'missing_hash' };
  if (!isNonEmptyString(pe.action_type)) return { kind: 'rejected', reason: 'missing_action_type' };
  if (typeof pe.timestamp !== 'number' || !Number.isSafeInteger(pe.timestamp) || pe.timestamp < 0) {
    return { kind: 'rejected', reason: 'invalid_timestamp' };
  }
  if (pe.user_id !== undefined && pe.user_id !== null && !isNonEmptyString(pe.user_id)) {
    return { kind: 'rejected', reason: 'invalid_user_id' };
  }

  // `json-stable-stringify` sorts keys but SERIALIZES null-valued keys and OMITS undefined
  // ones, so `user_id` is normalized to an explicit null. Omitting it would silently change
  // the preimage — the same caveat `pe-utils.ts` documents for its extended fields.
  const preimage = stableStringify({
    domain: CLAIM_ID_DOMAIN,
    id: normalizeId(pe.id),
    prev_hash: normalizeHash(pe.prev_hash),
    hash: normalizeHash(pe.hash),
    timestamp: pe.timestamp,
    action_type: pe.action_type,
    user_id: pe.user_id === undefined ? null : pe.user_id,
  });

  // `json-stable-stringify` is typed as possibly returning undefined. It cannot here (the
  // argument is an object literal), but falling back to '' would hash the EMPTY STRING and
  // hand every PE in the batch the same claim id, so this fails closed instead.
  if (typeof preimage !== 'string' || preimage === '') {
    return { kind: 'rejected', reason: 'preimage_unserializable' };
  }

  const claimId = `0x${createHash('sha256').update(preimage).digest('hex')}`;

  // The kernel rejects `claimId == bytes32(0)`; a PE that hashed to it would be unsettleable.
  if (claimId === ZERO_BYTES32) return { kind: 'rejected', reason: 'degenerate_claim_id' };

  return { kind: 'derived', claimId };
}

/**
 * Derive the claim id for ONE PAYOUT LEG of a sealed PE.
 *
 * An act with two payees needs two claim ids, because the kernel dedupes on
 * `claimSettled[claimId]` PER CLAIM ITEM. Two legs of one act settle independently under two
 * ids; a replay of either is refused by the kernel on that id alone.
 *
 * `sole` IS THE IDENTITY CASE, BYTE-IDENTICAL TO `deriveClaimId`. That is load-bearing rather
 * than tidy: every single-payee PE keeps the id it would already have had, so introducing legs
 * changes no existing identity and `claim-identity.ts`'s drift check stays quiet. The role is
 * folded into the preimage ONLY when it is not `sole`.
 *
 * COLLISION-FREEDOM. Two legs of one PE differ only in the `leg` key, and the preimage is a
 * `json-stable-stringify` of a fixed-key object, so distinct roles produce distinct preimages of
 * a domain-separated SHA-256. Across PEs the `hash` field already separates them. The one case
 * needing care is `sole` versus a hypothetical role whose presence serializes identically to its
 * absence — impossible here, since `PayoutLegRole` is a closed set of non-empty strings and the
 * key is omitted only for `sole`. `claim-id.legs.test.ts` proves the whole matrix pairwise.
 */
export function deriveLegClaimId(
  pe: SealedEnvelopeIdentity,
  leg: PayoutLegRole,
): ClaimIdResult {
  if (!PAYOUT_LEG_ROLES.includes(leg)) return { kind: 'rejected', reason: 'invalid_leg' };
  // The identity case, delegated so the two derivations can never drift apart.
  if (leg === 'sole') return deriveClaimId(pe);

  const base = deriveClaimId(pe);
  if (base.kind !== 'derived') return base;

  const preimage = stableStringify({
    domain: CLAIM_ID_DOMAIN,
    id: normalizeId(pe.id),
    prev_hash: normalizeHash(pe.prev_hash),
    hash: normalizeHash(pe.hash),
    timestamp: pe.timestamp,
    action_type: pe.action_type,
    user_id: pe.user_id === undefined ? null : pe.user_id,
    leg,
  });
  if (typeof preimage !== 'string' || preimage === '') {
    return { kind: 'rejected', reason: 'preimage_unserializable' };
  }
  const claimId = `0x${createHash('sha256').update(preimage).digest('hex')}`;
  if (claimId === ZERO_BYTES32) return { kind: 'rejected', reason: 'degenerate_claim_id' };
  return { kind: 'derived', claimId };
}

/**
 * the claim id of the ADDITIVE ATTESTATION TOP-UP for one payout leg.
 *
 * A top-up is a second, distinct claim on the SAME sealed PE and leg: the delta between the
 * tier the act sealed at and the verified attestation upgrade observed inside its horizon.
 * The kernel dedupes on `claimSettled[claimId]` alone, so the top-up needs an id that can
 * never collide with the act's — and never drift, so a corroboration seen twice tops up
 * ONCE. Both properties come from the same shape as the leg derivation: a deterministic
 * content hash over the sealed identity fields, under a DISTINCT domain separator.
 * Distinct domain ⇒ distinct preimage from every `act` id (which carry
 * `CLAIM_ID_DOMAIN`), for every leg including `sole`; the leg is always folded here (no
 * `sole` identity carve-out is needed, because no pre-existing top-up id has to be kept
 * byte-identical). Nothing about WHICH tier or WHAT amount enters the preimage: an act
 * has at most one top-up per leg, by construction, and the amount is settled off the
 * ledger row exactly as the act's is.
 */
const TOPUP_CLAIM_ID_DOMAIN = 'provian.pvt9.claim-id.attestation-topup.v1';

export function deriveTopupClaimId(
  pe: SealedEnvelopeIdentity,
  leg: PayoutLegRole,
): ClaimIdResult {
  if (!PAYOUT_LEG_ROLES.includes(leg)) return { kind: 'rejected', reason: 'invalid_leg' };
  // Validate the identity through the act derivation so a top-up can never be derived
  // for a PE whose act id could not be.
  const base = deriveClaimId(pe);
  if (base.kind !== 'derived') return base;
  const preimage = stableStringify({
    domain: TOPUP_CLAIM_ID_DOMAIN,
    id: normalizeId(pe.id),
    prev_hash: normalizeHash(pe.prev_hash),
    hash: normalizeHash(pe.hash),
    timestamp: pe.timestamp,
    action_type: pe.action_type,
    user_id: pe.user_id === undefined ? null : pe.user_id,
    leg,
  });
  if (typeof preimage !== 'string' || preimage === '') {
    return { kind: 'rejected', reason: 'preimage_unserializable' };
  }
  const claimId = `0x${createHash('sha256').update(preimage).digest('hex')}`;
  if (claimId === ZERO_BYTES32) return { kind: 'rejected', reason: 'degenerate_claim_id' };
  return { kind: 'derived', claimId };
}

/** The sentinel a chain's first PE carries in `prev_hash`. Exported for callers building fixtures. */
export const CLAIM_ID_GENESIS_PREV_HASH = GENESIS_PREV_HASH;
