/**
 * PE METER — the relay's own state.
 *
 * The relay is a meter, not an archive. Per actor it keeps identity, links, escrows and
 * recovery state, running totals (reputation vocabulary incl. adverse facts), per-pair
 * relationship counts, and earnings not yet minted. Work prices in memory per batch:
 *
 * meter_act_keys_v1/{relayPeId} minimal output trust or cross-witness evidence, plus unresolved
 * held recovery inputs. New unpaid keys remain until claims complete, then at least 30 days;
 * old keys keep their original TTL. Outputless single-lane acts have no key after resolution.
 * meter_pending_claims_v1/{key} earnings not yet minted, retained through payment and anchoring.
 * meter_batches_v1/{batch_hash} compact batch economics through settlement, anchoring and delivery.
 * meter_occurrence_sets_v1/{packed leaf} permanent exact actor-wide replay membership.
 * meter_device_tips_v1/{device} the latest accepted batch per device (replay refusal).
 * meter_held_acts_v1/{relayPeId} an act held pending evidence/cache/review; never expires
 * (held work is earned work in escrow).
 * pe_mailbox_v1/{page} one batch's PEs sealed to one owner / linked human (a page,
 * chunked when large), until acknowledgement; legacy pages keep their TTL (`pe-mailbox.ts`).
 * meter_pair_counts_v1/{a}__{b} relationship counts (dealt-with, citations).
 * meter_anchor_days_v1/{day} the day's anchored batch leaves, 30 days, for proofs.
 *
 * Every TTL field is a Firestore Timestamp (`expire_at`) — a number never expires.
 */

import type { SealedEnvelopeIdentity } from '../pvt/wp-ev/claim-id';
import { Timestamp } from 'firebase-admin/firestore';

export const METER_DEVICE_TIPS_COLLECTION = 'meter_device_tips_v1';
export const METER_BATCHES_COLLECTION = 'meter_batches_v1';
export const METER_ACT_KEYS_COLLECTION = 'meter_act_keys_v1';
export const METER_PENDING_CLAIMS_COLLECTION = 'meter_pending_claims_v1';
export const METER_HELD_ACTS_COLLECTION = 'meter_held_acts_v1';
/**
 * The `mint_status` values that withdraw a metered act's earnings (a takeover, a bug demotion):
 * the settlement gate refuses a claim carrying such an act, and no corroboration lifts one.
 */
export const METER_DEMOTED_ACT_STATUSES: ReadonlySet<string> = new Set(['corroborated_duplicate', 'record_only', 'ineligible', 'ineligible_terminal']);
export const PE_MAILBOX_COLLECTION = 'pe_mailbox_v1';
export const METER_PAIR_COUNTS_COLLECTION = 'meter_pair_counts_v1';
export const METER_ANCHOR_DAYS_COLLECTION = 'meter_anchor_days_v1';
export const HUMAN_DELEGATION_TOTALS_COLLECTION = 'human_delegation_totals_v1';
/**
 * Identity-bearing PEs sealed BEFORE the meter (an agent's birth, key rotations, links, share
 * changes, governance and badge sources), moved here verbatim from `provenance_envelopes` by the
 * legacy migration: identity and recovery state the relay keeps (item 7), point-read by id.
 */
export const LEGACY_IDENTITY_PES_COLLECTION = 'identity_pes_legacy_v1';

/** The batch marker the PE meter migration gave every act it carried over from pe_history. */
export const LEGACY_PRE_METER_BATCH = 'legacy_pre_meter';

/** The TTL field every expiring meter document carries (a Firestore Timestamp). */
export const METER_TTL_FIELD = 'expire_at';

/** The device id a relay-authored act batches under (its one-act relay batch). */
export function relayDeviceId(actorId: string): string {
  return `relay:${actorId}`;
}

import { DAY_MS } from './meter-constants';
export { DAY_MS, METER_KEY_LIFETIME_MS, PE_MAILBOX_LIFETIME_MS, METER_MIN_BATCH_INTERVAL_MS } from './meter-constants';
/** A settled pending claim is kept this long for operator views, then Firestore's TTL drops it. */
export const METER_SETTLED_CLAIM_LIFETIME_MS = 30 * DAY_MS;
/** A relay act's staged intake (`meter_relay_acts_v1`) lives this long for the replay sweep. */
export const METER_RELAY_ACT_LIFETIME_MS = 7 * DAY_MS;
export const METER_ANCHOR_DAY_LIFETIME_MS = 30 * DAY_MS;
/** An act whose timestamp is further than this in the future is refused (clock skew). */
export const METER_MAX_FUTURE_SKEW_MS = 10 * 60 * 1000;

export function expireAt(ms: number): Timestamp {
  return Timestamp.fromMillis(ms);
}

/**
 * The relay's id for an act: derived from the device's pe_hash, so it is globally unique (the
 * hash covers device_id and pe_id) and deterministic (a retried batch maps every act to the same
 * id, which is what makes each act's mint-once claims self-owned on retry). A client-chosen
 * pe_id is never used as a relay key — two devices could choose the same one.
 */
export function meterRelayPeId(peHash: string): string {
  if (!/^[0-9a-f]{64}$/.test(peHash)) throw new Error('meter_pe_hash_invalid');
  return `pe_m_${peHash.slice(0, 48)}`;
}

export interface MeterDeviceTip {
  readonly device_id: string;
  readonly actor_id: string;
  readonly seq: number;
  readonly batch_hash: string;
  readonly last_pe_hash: string;
  readonly accepted_at_ms: number;
  /** The receipt returned for the latest batch, so a re-sent batch gets the same answer. */
  readonly receipt: MeterBatchReceipt;
}

export type MeterActDisposition =
  | 'eligible'
  | 'record_only'
  | 'held'
  | 'duplicate'
  | 'refused'
  | 'ineligible';

export interface MeterActReceipt {
  readonly pe_id: string;
  readonly pe_hash: string;
  readonly relay_pe_id: string;
  readonly leaf_index: number;
  readonly disposition: MeterActDisposition;
  readonly reason: string;
  /** Present when the device should act on something (e.g. `lineage_rejected:…`). */
  readonly note?: string;
  readonly record_points_atomic: string;
  readonly mint_status: string | null;
}

export interface MeterBatchReceipt {
  readonly transit_receipt?: string;
  readonly transit_recipients?: Readonly<Record<string, string>>;
  readonly schema: 'provian.pe-batch-receipt.v1';
  readonly device_id: string;
  readonly actor_id: string;
  readonly seq: number;
  readonly batch_hash: string;
  readonly acts_root: string;
  readonly batch_leaf: string;
  readonly accepted_at_ms: number;
  readonly acts: readonly MeterActReceipt[];
  readonly totals: {
    readonly eligible_points_atomic: string;
    readonly acts: number;
    readonly eligible: number;
  };
}

export interface MeterPendingClaimLeg {
  readonly relay_pe_id: string;
  readonly points_atomic: string;
  /**
   * A `window` claim's act only: the instant the act's cross-witness takeover window closes
   * (`timestamp + CROSS_WITNESS_TAKEOVER_WINDOW_MS`). The act's share may be registered from then
   * on, exactly as its own per-act claim's `ready_at_ms` was before the fold (A3, 2026-10-04).
   */
  readonly ready_at_ms?: number;
}

/** One pending claim a payout claim settles (its key, its own claim id and points). */
export interface MeterPayoutMember {
  readonly claim_key: string;
  readonly claim_id: string;
  readonly points_atomic: string;
}

/**
 * Earnings not yet minted. One per (unit, payee leg). A unit is a whole batch (ordinary acts,
 * aggregated: one claim per recipient per batch), a batch's takeover-capable witnesses (`window`:
 * one claim per recipient per batch, each act registrable once its own 72 h takeover window
 * closes — , 2026-10-04), one act (`act`: the pre-fold per-act claim of a
 * takeover-capable witness, a held act's promotion, or a carried-over legacy act), one top-up, or
 * one payout.
 */
export interface MeterPendingClaim {
  readonly schema: 'provian.meter-pending-claim.v1';
  readonly claim_key: string;
  readonly unit: 'batch' | 'act' | 'window' | 'topup' | 'payout';
  readonly batch_hash: string;
  readonly device_id: string;
  readonly actor_id: string;
  readonly leg: string;
  readonly contributor: string;
  readonly beneficiary_class: number;
  readonly record_points_atomic: string;
  readonly acts: readonly MeterPendingClaimLeg[];
  readonly claim_id: string;
  readonly created_at_ms: number;
  /** Registration waits until this instant (takeover window); 0 = ready. */
  readonly ready_at_ms: number;
  /**
   * An `act` / `topup` claim's act identity (the claim id derives from it). Carried on the claim,
   * which is kept until settled, so a settlement held past the act key's 31 days can still
   * re-derive and pay it. Absent on a `batch` claim (its id derives from the batch hash).
   */
  readonly act_identity?: SealedEnvelopeIdentity;
  /**
   * A `payout` claim's members: the ready pending claims of one payee (leg, address, class) it
   * settles as ONE kernel claim (PE meter cost pass, 2026-10-04). Sorted by claim key; its claim id
   * derives from theirs. Absent on every other unit.
   */
  readonly members?: readonly MeterPayoutMember[];
  /**
   * A `window` claim's part: 0 for the batch's own claim (its PARENT); for a SLICE — the acts of a
   * parent whose windows had closed when a settlement run took them while others still waited —
   * the instant that run cut it. The claim id derives from it (`meterWindowClaimId`).
   */
  readonly window_part?: number;
  /** A window SLICE's parent claim key. */
  readonly parent_key?: string;
  /** A window PARENT: each act a run has cut into a slice → that slice's claim key. */
  readonly moved?: Readonly<Record<string, string>>;
  /**
   * `aggregated`: a member of a payout claim (`payout_key`), settled through it. Never registered
   * on its own, never part of another payout.
   */
  readonly state: 'pending' | 'registered' | 'settled' | 'void' | 'aggregated';
  /** The payout claim that took this claim (state `aggregated`, or `settled` through it). Not in the integrity commitment. */
  readonly payout_key?: string;
  readonly integrity_sha256: string;
}
