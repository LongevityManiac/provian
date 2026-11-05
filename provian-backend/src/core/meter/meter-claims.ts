import { LEGACY_PRE_METER_BATCH } from './meter-store';
/**
 * PE METER — earnings not yet minted.
 *
 * A pending claim is one settlement claim item waiting for the settlement run. Its units:
 *
 * batch — the ORDINARY case. Every eligible act in one accepted batch that pays the same leg
 * to the same address under the same beneficiary class is ONE claim. Its claim id is
 * derived from the batch hash, which the device chain makes unique, so the kernel's
 * `claimSettled` dedupes it like any other claim. Nothing per act reaches the chain.
 * window — the batch's TAKEOVER-CAPABLE witnesses (a commit or a completion witness), folded the
 * same way: one claim per (leg, address, class) per batch (2026-10-04).
 * Each act carries its own `ready_at_ms` (its 72 h cross-witness takeover window), and
 * the inlet registers an act only once its window has closed — when a run finds some
 * of a claim's acts ready and others waiting it cuts the ready ones into a SLICE (a
 * window claim of its own, `window_part` = the cut instant) and the parent keeps the
 * rest. A higher-base witness that takes an act over before registration takes that
 * act's points out of the parent (`withoutAct`), atomically with the takeover.
 * act — the pre-fold unit of a takeover-capable witness: one claim per act leg, keyed by
 * the act's identity (`deriveLegClaimId`, the pre-meter derivation). Still written for
 * a promoted held act and a carried-over legacy act, and every one already stored keeps
 * settling exactly as before.
 * topup — the additive corroboration lift on an act inside its 30-day horizon
 * (`deriveTopupClaimId`, one per act leg, ever).
 * payout — one payee's ready claims of one settlement run, settled as ONE kernel claim.
 *
 * The kernel claim shape (`claimId`, `recordPointsAtomic`) and the verifier digest are untouched:
 * a claim id is opaque bytes32 to both contracts.
 */

import { createHash } from 'crypto';
import stableStringify from 'json-stable-stringify';
import { deriveLegClaimId, deriveTopupClaimId, type SealedEnvelopeIdentity } from '../pvt/wp-ev/claim-id';
import { PAYOUT_LEG_ROLES, type PayoutLegRole } from '../pvt/wp-ev/payout-legs';
import {
  METER_PENDING_CLAIMS_COLLECTION,
  type MeterPayoutMember,
  type MeterPendingClaim,
  type MeterPendingClaimLeg,
} from './meter-store';

export { METER_PENDING_CLAIMS_COLLECTION };

const LEG_ALTERNATION = PAYOUT_LEG_ROLES.join('|');
// `ma_` / `mt_` carry the act's relay pe id: `pe_m_<hash>` for a device act, `pe_<id>` for an act
// the relay itself authored (webhooks, watchers, institutions). No pre-meter pe id starts `m?_`.
const METER_CLAIM_KEY = new RegExp(`^(?:m[bpw]_[0-9a-f]{48}|m[at]_pe_[A-Za-z0-9_-]{1,200}_(?:${LEG_ALTERNATION}))$`);

/** True for a claim-ledger `pe_id` that is a PE-meter pending claim key (`mb_` / `mw_` / `ma_` / `mt_` / `mp_`). */
export function isMeterClaimKey(peId: string): boolean {
  return METER_CLAIM_KEY.test(peId);
}

const METER_BATCH_CLAIM_ID_DOMAIN = 'provian.pvt9.meter-claim-id.v1';

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** One payee leg of one act, frozen when the act is sealed. */
export interface MeterActLeg {
  readonly leg: PayoutLegRole;
  readonly contributor: string;
  readonly beneficiary_class: number;
  readonly bps: number;
  readonly points_atomic: string;
}

export function meterBatchClaimId(input: {
  readonly batch_hash: string;
  readonly leg: PayoutLegRole;
  readonly contributor: string;
  readonly beneficiary_class: number;
}): string {
  const preimage = stableStringify({
    domain: METER_BATCH_CLAIM_ID_DOMAIN,
    batch_hash: input.batch_hash.toLowerCase(),
    leg: input.leg,
    contributor: input.contributor.toLowerCase(),
    beneficiary_class: input.beneficiary_class,
  });
  if (typeof preimage !== 'string' || preimage === '') throw new Error('meter_claim_id_unserializable');
  return `0x${sha256Hex(preimage)}`;
}

export function meterBatchClaimKey(input: {
  readonly batch_hash: string;
  readonly leg: PayoutLegRole;
  readonly contributor: string;
  readonly beneficiary_class: number;
}): string {
  return `mb_${sha256Hex(`${input.batch_hash}|${input.leg}|${input.contributor.toLowerCase()}|${input.beneficiary_class}`).slice(0, 48)}`;
}

const METER_WINDOW_CLAIM_ID_DOMAIN = 'provian.pvt9.meter-window-claim-id.v1';

/** Which window claim: the batch's own (`part` 0, the parent) or a slice a run cut (`part` = the cut instant). */
export interface MeterWindowClaimIdentity {
  readonly batch_hash: string;
  readonly leg: PayoutLegRole;
  readonly contributor: string;
  readonly beneficiary_class: number;
  readonly part: number;
}

function assertWindowPart(part: number): void {
  if (!Number.isSafeInteger(part) || part < 0) throw new Error('meter_window_part_invalid');
}

/**
 * A window claim's kernel claim id. Unique: one parent per (batch, leg, address, class), whose
 * batch hash the device chain makes unique, and each slice of it is cut at a distinct instant.
 * Opaque bytes32 to the kernel and the verifier, like every other claim id.
 */
export function meterWindowClaimId(input: MeterWindowClaimIdentity): string {
  assertWindowPart(input.part);
  const preimage = stableStringify({
    domain: METER_WINDOW_CLAIM_ID_DOMAIN,
    batch_hash: input.batch_hash.toLowerCase(),
    leg: input.leg,
    contributor: input.contributor.toLowerCase(),
    beneficiary_class: input.beneficiary_class,
    part: input.part,
  });
  if (typeof preimage !== 'string' || preimage === '') throw new Error('meter_window_claim_id_unserializable');
  return `0x${sha256Hex(preimage)}`;
}

export function meterWindowClaimKey(input: MeterWindowClaimIdentity): string {
  assertWindowPart(input.part);
  const preimage = ['window', input.batch_hash, input.leg, input.contributor.toLowerCase(), String(input.beneficiary_class), String(input.part)].join('|');
  return `mw_${sha256Hex(preimage).slice(0, 48)}`;
}

export function meterActClaimKey(relayPeId: string, leg: PayoutLegRole): string {
  return `ma_${relayPeId}_${leg}`;
}

export function meterTopupClaimKey(relayPeId: string, leg: PayoutLegRole): string {
  return `mt_${relayPeId}_${leg}`;
}

export function meterActClaimId(identity: SealedEnvelopeIdentity, leg: PayoutLegRole): string {
  const derived = deriveLegClaimId(identity, leg);
  if (derived.kind !== 'derived') throw new Error(`meter_act_claim_id_${derived.reason}`);
  return derived.claimId;
}

export function meterTopupClaimId(identity: SealedEnvelopeIdentity, leg: PayoutLegRole): string {
  const derived = deriveTopupClaimId(identity, leg);
  if (derived.kind !== 'derived') throw new Error(`meter_topup_claim_id_${derived.reason}`);
  return derived.claimId;
}

/** The act-key fields that name where an act's earnings went. */
export interface ActClaimHome {
  readonly relay_pe_id: string;
  readonly unit: 'batch' | 'act' | 'window' | 'none';
  readonly batch_hash: string;
  readonly legs: readonly MeterActLeg[] | null;
}

/**
 * The claim key that FIRST holds one paying leg of an act: its batch claim, its window claim's
 * parent (a slice the act was later cut into is named by the parent's `moved`), or its own act
 * claim. Null for a leg that pays nothing, or an act whose earnings went into no claim.
 */
export function actBaseClaimKeyOf(key: ActClaimHome, leg: MeterActLeg): string | null {
  if (BigInt(leg.points_atomic) <= 0n) return null;
  const payee = { batch_hash: key.batch_hash, leg: leg.leg, contributor: leg.contributor, beneficiary_class: leg.beneficiary_class };
  if (key.unit === 'batch') return meterBatchClaimKey(payee);
  if (key.unit === 'window') return meterWindowClaimKey({ ...payee, part: 0 });
  if (key.unit === 'act') return meterActClaimKey(key.relay_pe_id, leg.leg);
  return null;
}

/** The claim keys an act's earnings sit in: its batch, window or act claim per paying leg, and its top-ups. */
export function actClaimKeysOf(key: ActClaimHome): string[] {
  if (key.legs === null) return [];
  const out: string[] = [];
  for (const leg of key.legs) {
    const base = actBaseClaimKeyOf(key, leg);
    if (base !== null) out.push(base);
    out.push(meterTopupClaimKey(key.relay_pe_id, leg.leg));
  }
  return [...new Set(out)];
}

/** The earliest instant any of these window acts becomes registrable (0 when none waits). */
function earliestReady(acts: readonly MeterPendingClaimLeg[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (const a of acts) min = Math.min(min, a.ready_at_ms ?? 0);
  return Number.isFinite(min) ? min : 0;
}

/**
 * The claim rebuilt over a subset of its acts: points (and a window claim's readiness)
 * recomputed, `extra` applied, the integrity recomputed. Its state and payout link are dropped.
 */
function rebuiltOver(
  claim: MeterPendingClaim,
  acts: readonly MeterPendingClaimLeg[],
  extra: Partial<Omit<MeterPendingClaim, 'state' | 'integrity_sha256'>> = {},
): Omit<MeterPendingClaim, 'state'> {
  const record = { ...claim } as Record<string, unknown>;
  for (const transient of ['state', 'integrity_sha256', 'payout_key', 'aggregated_at_ms', 'registered_at_ms']) delete record[transient];
  const base = {
    ...(record as unknown as Omit<MeterPendingClaim, 'state' | 'integrity_sha256'>),
    ...extra,
    acts,
    record_points_atomic: sumAtomic(acts.map((a) => a.points_atomic)),
    ...(claim.unit === 'window' ? { ready_at_ms: earliestReady(acts) } : {}),
  };
  return { ...base, integrity_sha256: pendingClaimIntegrity(base) };
}

/**
 * Take one demoted act out of a still-`pending` claim: an act or top-up claim is voided; a batch
 * or window claim loses the act's entry and points (voided when nothing is left), its integrity
 * (and a window claim's readiness) recomputed. Null when the claim does not carry the act.
 */
export function withoutAct(claim: MeterPendingClaim, relayPeId: string, nowMs: number): Record<string, unknown> | null {
  if (!claim.acts.some((a) => a.relay_pe_id === relayPeId)) return null;
  const voided = { state: 'void', voided_by: `demotion:${relayPeId}`, voided_at_ms: nowMs };
  if (claim.unit !== 'batch' && claim.unit !== 'window') return voided;
  const acts = claim.acts.filter((a) => a.relay_pe_id !== relayPeId);
  if (acts.length === 0) return voided;
  const trimmed = rebuiltOver(claim, acts);
  return {
    acts: trimmed.acts,
    record_points_atomic: trimmed.record_points_atomic,
    ...(claim.unit === 'window' ? { ready_at_ms: trimmed.ready_at_ms } : {}),
    integrity_sha256: trimmed.integrity_sha256,
  };
}

/** The acts of a window claim whose takeover windows have closed at `nowMs`. */
export function readyWindowActs(claim: Pick<MeterPendingClaim, 'acts'>, nowMs: number): MeterPendingClaimLeg[] {
  return claim.acts.filter((a) => (a.ready_at_ms ?? 0) <= nowMs);
}

/**
 * Cut the ready acts of a pending window PARENT into a SLICE . Returns the slice
 * (a window claim of its own: `window_part` = `nowMs`, its claim id derived from that) and the
 * parent as it must be left: only the acts still waiting, its points and readiness recomputed,
 * and `moved` naming the slice for every act it gave up. Refuses anything but a window parent,
 * a cut that takes nothing, and a cut that takes everything (then the parent itself registers).
 */
export function sliceWindowClaim(parent: MeterPendingClaim, nowMs: number): {
  readonly slice: Omit<MeterPendingClaim, 'state'>;
  readonly parent: Omit<MeterPendingClaim, 'state'>;
} {
  if (parent.unit !== 'window' || (parent.window_part ?? 0) !== 0) throw new Error('meter_window_slice_not_a_parent');
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error('meter_window_part_invalid');
  const ready = readyWindowActs(parent, nowMs);
  const waiting = parent.acts.filter((a) => (a.ready_at_ms ?? 0) > nowMs);
  if (ready.length === 0 || waiting.length === 0) throw new Error('meter_window_slice_not_partial');
  const identity = {
    batch_hash: parent.batch_hash,
    leg: parent.leg as PayoutLegRole,
    contributor: parent.contributor,
    beneficiary_class: parent.beneficiary_class,
    part: nowMs,
  };
  const sliceKey = meterWindowClaimKey(identity);
  const sliceSource = { ...parent } as Record<string, unknown>;
  delete sliceSource.moved;
  const slice = rebuiltOver(sliceSource as unknown as MeterPendingClaim, ready, {
    claim_key: sliceKey,
    claim_id: meterWindowClaimId(identity),
    window_part: nowMs,
    parent_key: parent.claim_key,
    created_at_ms: nowMs,
  });
  const moved: Record<string, string> = { ...(parent.moved ?? {}) };
  for (const a of ready) moved[a.relay_pe_id] = sliceKey;
  return { slice, parent: rebuiltOver(parent, waiting, { moved }) };
}

/** The integrity commitment over everything that decides who is paid how much. */
export function pendingClaimIntegrity(claim: Omit<MeterPendingClaim, 'integrity_sha256' | 'state'>): string {
  const preimage = stableStringify({
    claim_key: claim.claim_key,
    unit: claim.unit,
    batch_hash: claim.batch_hash,
    device_id: claim.device_id,
    actor_id: claim.actor_id,
    leg: claim.leg,
    contributor: claim.contributor,
    beneficiary_class: claim.beneficiary_class,
    record_points_atomic: claim.record_points_atomic,
    acts: claim.acts,
    claim_id: claim.claim_id,
    ready_at_ms: claim.ready_at_ms,
    // Absent on a batch claim (stableStringify drops undefined), so its commitment is unchanged.
    act_identity: claim.act_identity,
    // Present only on a payout claim (likewise dropped when absent).
    members: claim.members,
    // Present only on a window claim (likewise dropped when absent).
    window_part: claim.window_part,
    parent_key: claim.parent_key,
    moved: claim.moved,
  });
  if (typeof preimage !== 'string') throw new Error('meter_pending_claim_unserializable');
  return sha256Hex(preimage);
}

export function buildPendingClaim(input: Omit<MeterPendingClaim, 'schema' | 'integrity_sha256' | 'state'>): MeterPendingClaim {
  const base = { schema: 'provian.meter-pending-claim.v1' as const, ...input };
  return { ...base, state: 'pending', integrity_sha256: pendingClaimIntegrity(base) };
}

/** True when a stored pending claim still matches its own integrity commitment. */
export function pendingClaimIntact(claim: MeterPendingClaim): boolean {
  try {
    return pendingClaimIntegrity(claim) === claim.integrity_sha256;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Payout claims (PE meter cost pass, 2026-10-04)
// ---------------------------------------------------------------------------

const METER_PAYOUT_CLAIM_ID_DOMAIN = 'provian.pvt9.meter-payout-claim-id.v1';

/** Most members one payout claim settles (one transaction marks them all `aggregated`). */
export const MAX_PAYOUT_MEMBERS = 400;

/** Members in canonical order (by claim key); refuses a duplicate key or claim id. */
export function canonicalPayoutMembers(members: readonly MeterPayoutMember[]): MeterPayoutMember[] {
  const sorted = [...members]
    .map((m) => ({ claim_key: m.claim_key, claim_id: m.claim_id.toLowerCase(), points_atomic: m.points_atomic }))
    .sort((a, b) => (a.claim_key < b.claim_key ? -1 : a.claim_key > b.claim_key ? 1 : 0));
  const keys = new Set(sorted.map((m) => m.claim_key));
  const ids = new Set(sorted.map((m) => m.claim_id));
  if (keys.size !== sorted.length || ids.size !== sorted.length) throw new Error('meter_payout_member_duplicate');
  return sorted;
}

/** The payout claim's key: a pure function of its members' keys (so a retry lands on the same doc). */
export function meterPayoutClaimKey(members: readonly MeterPayoutMember[]): string {
  const keys = canonicalPayoutMembers(members).map((m) => m.claim_key);
  return `mp_${sha256Hex(keys.join('|')).slice(0, 48)}`;
}

/**
 * The payout claim's kernel claim id: derived from the payee and its members' own claim ids, each
 * of which derives from its batch hash or act identity. The kernel's `claimSettled` dedupes it; a
 * member is in at most one payout (its `aggregated` state is set in the payout's transaction).
 */
export function meterPayoutClaimId(input: {
  readonly leg: PayoutLegRole;
  readonly contributor: string;
  readonly beneficiary_class: number;
  readonly members: readonly MeterPayoutMember[];
}): string {
  const preimage = stableStringify({
    domain: METER_PAYOUT_CLAIM_ID_DOMAIN,
    leg: input.leg,
    contributor: input.contributor.toLowerCase(),
    beneficiary_class: input.beneficiary_class,
    member_claim_ids: canonicalPayoutMembers(input.members).map((m) => m.claim_id),
  });
  if (typeof preimage !== 'string' || preimage === '') throw new Error('meter_payout_claim_id_unserializable');
  return `0x${sha256Hex(preimage)}`;
}

/** Build the payout claim that settles `members` (all of one leg, address and class) as one claim. */
export function buildPayoutClaim(input: {
  readonly leg: PayoutLegRole;
  readonly contributor: string;
  readonly beneficiary_class: number;
  readonly members: readonly MeterPayoutMember[];
  readonly created_at_ms: number;
}): MeterPendingClaim {
  if (input.members.length === 0 || input.members.length > MAX_PAYOUT_MEMBERS) throw new Error('meter_payout_member_count');
  const members = canonicalPayoutMembers(input.members);
  const base = {
    schema: 'provian.meter-pending-claim.v1' as const,
    claim_key: meterPayoutClaimKey(members),
    unit: 'payout' as const,
    batch_hash: '',
    device_id: '',
    actor_id: '',
    leg: input.leg,
    contributor: input.contributor.toLowerCase(),
    beneficiary_class: input.beneficiary_class,
    record_points_atomic: sumAtomic(members.map((m) => m.points_atomic)),
    acts: [] as MeterPendingClaimLeg[],
    claim_id: meterPayoutClaimId({ ...input, members }),
    created_at_ms: input.created_at_ms,
    ready_at_ms: 0,
    members,
  };
  return { ...base, state: 'pending', integrity_sha256: pendingClaimIntegrity(base) };
}

export function sumAtomic(values: readonly string[]): string {
  let total = 0n;
  for (const v of values) total += BigInt(v);
  return total.toString();
}

/**
 * : aggregate the takeover-capable acts of one batch into one WINDOW claim per
 * (leg, contributor, beneficiary class). Each act keeps its own readiness (`ready_at_ms`, the
 * instant its cross-witness takeover window closes); the claim's `ready_at_ms` is the earliest of
 * them. Deterministic: acts keep batch order.
 */
export function aggregateWindowClaims(input: {
  readonly batch_hash: string;
  readonly device_id: string;
  readonly actor_id: string;
  readonly created_at_ms: number;
  readonly acts: readonly { readonly relay_pe_id: string; readonly legs: readonly MeterActLeg[]; readonly ready_at_ms: number }[];
}): MeterPendingClaim[] {
  const groups = new Map<string, { leg: PayoutLegRole; contributor: string; beneficiary_class: number; acts: MeterPendingClaimLeg[] }>();
  for (const act of input.acts) {
    if (!Number.isSafeInteger(act.ready_at_ms) || act.ready_at_ms < 0) throw new Error('meter_window_ready_invalid');
    for (const leg of act.legs) {
      if (BigInt(leg.points_atomic) <= 0n) continue;
      const key = `${leg.leg}|${leg.contributor.toLowerCase()}|${leg.beneficiary_class}`;
      let group = groups.get(key);
      if (!group) {
        group = { leg: leg.leg, contributor: leg.contributor.toLowerCase(), beneficiary_class: leg.beneficiary_class, acts: [] };
        groups.set(key, group);
      }
      group.acts.push({ relay_pe_id: act.relay_pe_id, points_atomic: leg.points_atomic, ready_at_ms: act.ready_at_ms });
    }
  }
  return [...groups.values()].map((group) => {
    const identity = { batch_hash: input.batch_hash, leg: group.leg, contributor: group.contributor, beneficiary_class: group.beneficiary_class, part: 0 };
    return buildPendingClaim({
      claim_key: meterWindowClaimKey(identity),
      unit: 'window',
      batch_hash: input.batch_hash,
      device_id: input.device_id,
      actor_id: input.actor_id,
      leg: group.leg,
      contributor: group.contributor,
      beneficiary_class: group.beneficiary_class,
      record_points_atomic: sumAtomic(group.acts.map((a) => a.points_atomic)),
      acts: group.acts,
      claim_id: meterWindowClaimId(identity),
      created_at_ms: input.created_at_ms,
      ready_at_ms: earliestReady(group.acts),
      window_part: 0,
    });
  });
}

/**
 * Aggregate the eligible, non-takeover-capable acts of one batch into one pending claim per
 * (leg, contributor, beneficiary class). Deterministic: acts keep batch order.
 */
export function aggregateBatchClaims(input: {
  readonly batch_hash: string;
  readonly device_id: string;
  readonly actor_id: string;
  readonly created_at_ms: number;
  readonly acts: readonly { readonly relay_pe_id: string; readonly legs: readonly MeterActLeg[] }[];
}): MeterPendingClaim[] {
  const groups = new Map<string, { leg: PayoutLegRole; contributor: string; beneficiary_class: number; acts: MeterPendingClaimLeg[] }>();
  for (const act of input.acts) {
    for (const leg of act.legs) {
      if (BigInt(leg.points_atomic) <= 0n) continue;
      const key = `${leg.leg}|${leg.contributor.toLowerCase()}|${leg.beneficiary_class}`;
      let group = groups.get(key);
      if (!group) {
        group = { leg: leg.leg, contributor: leg.contributor.toLowerCase(), beneficiary_class: leg.beneficiary_class, acts: [] };
        groups.set(key, group);
      }
      group.acts.push({ relay_pe_id: act.relay_pe_id, points_atomic: leg.points_atomic });
    }
  }
  return [...groups.values()].map((group) => buildPendingClaim({
    claim_key: meterBatchClaimKey({ batch_hash: input.batch_hash, leg: group.leg, contributor: group.contributor, beneficiary_class: group.beneficiary_class }),
    unit: 'batch',
    batch_hash: input.batch_hash,
    device_id: input.device_id,
    actor_id: input.actor_id,
    leg: group.leg,
    contributor: group.contributor,
    beneficiary_class: group.beneficiary_class,
    record_points_atomic: sumAtomic(group.acts.map((a) => a.points_atomic)),
    acts: group.acts,
    claim_id: meterBatchClaimId({ batch_hash: input.batch_hash, leg: group.leg, contributor: group.contributor, beneficiary_class: group.beneficiary_class }),
    created_at_ms: input.created_at_ms,
    ready_at_ms: 0,
  }));
}

export function isCarriedOverLegacyClaim(claim: Pick<MeterPendingClaim, 'batch_hash' | 'device_id' | 'unit'>): boolean {
  return claim.unit === 'act' && claim.batch_hash === LEGACY_PRE_METER_BATCH && claim.device_id.startsWith('legacy:');
}
