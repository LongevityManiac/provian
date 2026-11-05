/**
 * origin-independence — the money layer's witness + independence computation (, Prompt 3).
 *
 * `input_origins` (/433/434) records WHERE a PE's inputs came from and whether a witness
 * observed each crossing the process boundary. This module turns that record into an integer
 * `independent_origin_count` used as a pricing multiplier. It answers TWO separate questions per
 * origin, and NEITHER ever puts the PE below its base — an origin that fails a test adds zero to
 * the multiplier; the PE still mints base.
 *
 * 1. WITNESSED — a key that is NOT the actor vouched the origin crossed the boundary. The relay
 * takes this (and the witness's attestation tier) from what it can verify — a registered
 * device, a verified key, an HMAC/chain-verified relay observation — NEVER from the body
 * field (which 1b proved is actor-writable). The actor's OWN registered daemon is a valid
 * witness here; it answers this question, not the independence one.
 * 2. INDEPENDENT — the origin's owner is OUTSIDE the signer's identity set (its wallet + proven
 * external addresses + forge identities + registered devices + linked principal/agent). Same
 * party ⇒ adds zero.
 *
 * `independent_origin_count` = distinct owners that are BOTH witnessed and independent (and not in
 * a closed loop), deduplicated by owner. This module is PURE: the async resolution (relay-
 * authoritative witnessing, owner resolution, identity-set membership, the closed-loop verdict) is
 * done by the caller (`pvt-accrual`) and handed in as an `OriginResolution` per origin. Keeping the
 * decision pure makes every branch a unit test with a RED control.
 */

import type { InputOrigin } from '../provenance/input-origins';

/** Why an origin adds ZERO to the multiplier. `null` means it IS counted. */
export type OriginNotCountedReason =
  | 'unwitnessed'
  | 'private_hashed'
  | 'unresolvable_owner'
  | 'owner_set_unresolvable'
  | 'same_party'
  | 'closed_loop'
  /**
   * Trust Layer build (§2.2): a `pe:` origin — the citer BUILT ON another PE's
   * output. Recorded, witnessed, graph-indexed (it is the cited party's CONSUMPTION in-edge), and
   * adds ZERO to the citer's independence multiplier; the cited party earns nothing either
   * (the 2026-07-31 lineage-dark rule stands). Ordered AFTER `closed_loop` so a `pe:` edge inside a
   * provably-closed ring seals `closed_loop` instead and is excluded from consumption counts.
   */
  | 'consumption_edge'
  /** A `cited_pe_ids` citation migrated into the graph as a `pe:` edge (§2.1): zero mint effect. */
  | 'migrated_citation';

/** The witness identity + the relay-authoritative attestation tier (from registration, never body). */
export interface SealedWitness {
  readonly identity: string;
  readonly tier: string | null;
}

/** The per-origin decision sealed onto the economic snapshot. */
export interface SealedOriginRef {
  readonly origin_identifier: string;
  readonly hash: string;
  /** The owner party a public authority maps the identifier to, or null when unresolvable. */
  readonly owner: string | null;
  /** Relay-authoritative: a non-actor key vouched the origin crossed the boundary. */
  readonly witnessed: boolean;
  /** The witness identity + relay-taken tier, present only when witnessed. */
  readonly witness: SealedWitness | null;
  /** True iff this origin adds to `independent_origin_count`. */
  readonly counted: boolean;
  /** Why NOT counted; null when counted. */
  readonly reason: OriginNotCountedReason | null;
}

/** The already-resolved verdicts the caller feeds in for one origin. */
export interface OriginResolution {
  /** Relay-authoritative witnessed (resolved against a registered device / verified key). */
  readonly witnessed: boolean;
  /** The witness identity + relay-taken tier (present only when witnessed). */
  readonly witness: SealedWitness | null;
  /** The resolved owner party, or null when no resolver maps this identifier yet. */
  readonly owner: string | null;
  /** True when the origin is a private/hashed value with no resolvable public owner. */
  readonly privateHashed: boolean;
  /** True when the signer's identity set could not be resolved — independence is unprovable, so
   * this origin cannot be safely counted (fail-closed, never over-counts). */
  readonly identitySetUnresolvable: boolean;
  /** True when the resolved owner is INSIDE the signer's identity set (same party). */
  readonly sameParty: boolean;
  /** True when the resolved owner sits in a closed loop with the signer's cluster. */
  readonly closedLoop: boolean;
  /**
   * True when the origin is a `pe:` citation (the citer consumed another PE's output). Optional so
   * every pre-existing caller/fixture is unchanged (absent ⇒ false ⇒ byte-identical decisions).
   */
  readonly consumptionEdge?: boolean;
}

export interface OriginIndependenceResult {
  /** Distinct independent, witnessed, non-closed-loop owners. An INTEGER, never fractional. */
  readonly independentOriginCount: number;
  /** The per-origin decision detail, in input order. */
  readonly origins: readonly SealedOriginRef[];
}

/**
 * Decide one origin. The reason ORDER is the fence order: an origin can fail more than one test,
 * and the recorded reason is the FIRST that applies (most fundamental first). Every branch adds
 * ZERO to the count; only the fall-through counts.
 */
export function decideOrigin(origin: InputOrigin, resolution: OriginResolution): SealedOriginRef {
  let counted = false;
  let reason: OriginNotCountedReason | null = null;
  if (!resolution.witnessed) {
    reason = 'unwitnessed';
  } else if (resolution.privateHashed) {
    // A hashed private value: recorded and indexed, but independence is unverifiable.
    reason = 'private_hashed';
  } else if (resolution.owner === null) {
    // No resolver maps this identifier yet — recorded, indexed, counts zero until one exists.
    reason = 'unresolvable_owner';
  } else if (resolution.identitySetUnresolvable) {
    // The signer's identity set could not be resolved — cannot prove this owner is independent.
    reason = 'owner_set_unresolvable';
  } else if (resolution.sameParty) {
    reason = 'same_party';
  } else if (resolution.closedLoop) {
    reason = 'closed_loop';
  } else if (resolution.consumptionEdge === true) {
    // §2.2: a `pe:` consumption edge is recorded and indexed but never counted.
    reason = 'consumption_edge';
  } else {
    counted = true;
  }
  return {
    origin_identifier: origin.origin_identifier,
    hash: origin.hash,
    owner: resolution.owner,
    witnessed: resolution.witnessed,
    witness: resolution.witnessed ? resolution.witness : null,
    counted,
    reason,
  };
}

/**
 * Compute the independence count from decided origins. Deduplicates by OWNER: five origins owned by
 * the same external party count once. Only `counted` origins with a non-null owner contribute.
 */
export function computeOriginIndependence(
  origins: readonly SealedOriginRef[],
): OriginIndependenceResult {
  const distinctOwners = new Set<string>();
  for (const o of origins) {
    if (o.counted && o.owner !== null) distinctOwners.add(o.owner);
  }
  return { independentOriginCount: distinctOwners.size, origins };
}
