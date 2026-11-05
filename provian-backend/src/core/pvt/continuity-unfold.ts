/**
 * Continuity is not work — the one-time repair of `actor_stats_v1` documents
 * that folded chain-continuity records (an idle `compute_session` sealed `skipped_no_output`)
 * as acts of work before the ruling landed. From the landing forward the seal folds them as
 * continuity (`ActorStatsBump.continuity`); this moves each historic one the same way: out of every
 * work count, class, facet and share, into `continuity_records` and the day's `cr`.
 *
 * Nothing here touches a sealed PE, a claim, an act key, a page or any money path: the only writes
 * are the vocabulary-counter document and the act totals the old fold also bumped
 * (`actor_meter_totals_v1` the actor's attestation tiers, a linked human's acts by agent) — display
 * and vocabulary counters nothing on the accrual, settlement, eligibility or monetary path reads.
 *
 * WHICH records (relay records only — the relay keeps no per-act record of a continuity record since
 *, so they are found two ways, and their total must equal the count the economic aggregate
 * already keeps for the actor, `pes_by_mint_status.skipped_no_output`, less those the new fold has
 * already counted as continuity):
 * - RETAINED: before a continuity record kept its priced row on the batch's act page (or an
 * act key). Its row names its sealed witness class and family; an act key also carries the exact
 * stats bump.
 * - RESIDUAL: from 's landing day on, a day's folded count `n` less every act the relay
 * retained for that day (act keys, page rows, held acts) is the day's continuity records. Their
 * witness classes are the day's class counts less the retained acts'. A held act released since
 * keeps no row anywhere, so the residual alone could mistake it for continuity: a residual day is
 * accepted ONLY when the actor's own store (its PEs and receipts) names exactly that many
 * continuity records on that day.
 *
 * NOT REACHABLE: a continuity record sealed before the meter (a `pe_history` row). The legacy
 * migration retired those rows and no relay record names which were idle, so such a record is never
 * found here and stays where the old fold put it. The count check is the guard: an actor whose
 * aggregate expects more records than the relay can find refuses (`count_mismatch`) and is left
 * unchanged; it never moves a subset.
 *
 * A record moves only when it added no OTHER work counter (compute tokens, origins, approvals,
 * supervision, payment): an act key's exact bump shows it, else the owner's store must cover the day
 * and show none, or the actor's lifetime counters are all zero (then no record of it added any) (`work_counters_unconfirmed` / `continuity_carries_work_counters` refuse). A residual
 * record's act-total keys (tier, beneficiary) are those of the day's retained device-lane acts from
 * the same device — the same lane resolves tier and link the same way; none, or a disagreement,
 * refuses (`residual_totals_ambiguous`).
 *
 * Facets a page row does not carry (environment, model, hardware region / measurement / issuer) are
 * deduced per day and per facet, from the day bucket less the facets the act keys state exactly:
 * - nothing left over → the continuity records carry none of it;
 * - every act whose facet the relay did not record is a continuity record → they carry all of it
 * (an act the relay kept no row for — a pre-meter act folded by the legacy migration — counts as
 * unrecorded and is never continuity);
 * - one value left over, covering every act whose facet the relay did not record → each carries it;
 * - otherwise the device's own store (the owner's PEs) decides, when supplied; else REFUSE.
 * Every subtraction must land at zero or above. Any refusal leaves the actor's document unchanged.
 */

import {
  emptyDayBucket,
  type ActorStatsDayBucket,
  type ActorStatsDoc,
  type CompositionSignals,
} from './actor-stats';
import { measurementKey } from '../hardware/measurement';
import { isDeviceObservationActionType } from '../provenance/device-observation-types';
import type { ActorMeterTotalsDoc } from '../meter/actor-meter-totals';

/** One act the relay still holds for the actor (an act key or an act-page row). */
export interface RetainedAct {
  /** The relay pe id (an act held AND keyed appears in both collections: it is one act). */
  readonly relayPeId: string;
  /** `utcDayKey(min(timestamp, accepted))` — the day bucket the fold put it in. */
  readonly bucketDay: string;
  readonly actionType: string;
  readonly mintStatus: string | null;
  readonly witnessClass: string;
  readonly family: string;
  /** The exact facets (an act key's stats bump), or null when the relay kept none (an act page). */
  readonly composition: CompositionSignals | null;
  readonly compositionKnown: boolean;
  /** The row's `attestationDepth` (the key `actor_meter_totals_v1.by_attestation_tier` counts). */
  readonly tier: string | null;
  /** The human the row names as beneficiary, when not the actor itself (`beneficiary_acts_by_agent`). */
  readonly beneficiary: string | null;
  /** The device whose batch carried the act (an act key's, or its act page's). */
  readonly deviceId: string | null;
  /**
   * The per-record work counters the fold added for it (tokens, origins, approvals, supervision,
   * payment), from an act key's exact stats bump; null when the relay kept no bump (an act page).
   */
  readonly workCounters: number | null;
}

/** One continuity record's non-hardware facets read from the device's own store (optional evidence). */
export interface StoreContinuityRecord {
  readonly bucketDay: string;
  readonly deviceId: string | null;
  readonly environmentClass: string | null;
  readonly modelFamilies: readonly string[];
  /** The work counters its body would have added (compute tokens, origins, supervision, payment). */
  readonly workCounters: number;
}


export interface DayContinuity {
  n: number;
  wc: Record<string, number>;
  familyClass: Record<string, number>;
  e: Record<string, number>;
  m: Record<string, number>;
  r: Record<string, number>;
  ms: Record<string, number>;
  is: Record<string, number>;
  /** Act totals the old fold also counted (`actor_meter_totals_v1`): by tier, and by beneficiary human. */
  tier: Record<string, number>;
  beneficiary: Record<string, number>;
}

export interface ContinuityUnfoldPlan {
  readonly actorId: string;
  /** Historic continuity records moved by this repair. */
  readonly records: number;
  readonly retained: number;
  readonly residual: number;
  readonly days: Readonly<Record<string, DayContinuity>>;
  /** Per day and facet: how the facet was decided (for the operator's report). */
  readonly decisions: readonly string[];
}

export type ContinuityUnfoldResult =
  | { readonly ok: true; readonly plan: ContinuityUnfoldPlan }
  | { readonly ok: false; readonly reason: string };

export const CONTINUITY_ACTION_TYPE = 'compute_session';
export const CONTINUITY_MINT_STATUS = 'skipped_no_output';

const isContinuityAct = (a: RetainedAct): boolean =>
  a.actionType === CONTINUITY_ACTION_TYPE && a.mintStatus === CONTINUITY_MINT_STATUS;

function emptyDay(): DayContinuity {
  return { n: 0, wc: {}, familyClass: {}, e: {}, m: {}, r: {}, ms: {}, is: {}, tier: {}, beneficiary: {} };
}

function inc(map: Record<string, number>, key: string | null, by = 1): void {
  if (key === null || by === 0) return;
  map[key] = (map[key] ?? 0) + by;
}

function sum(map: Readonly<Record<string, number>>): number {
  return Object.values(map).reduce((a, n) => a + n, 0);
}

type FacetName = 'e' | 'm' | 'r' | 'ms' | 'is';
const FACETS: readonly FacetName[] = ['e', 'm', 'r', 'ms', 'is'];

/** The facet keys one act contributes (the same keys the fold bumps). */
function facetKeys(c: CompositionSignals | null, facet: FacetName): string[] {
  if (c === null) return [];
  switch (facet) {
    case 'e': return c.environmentClass ? [c.environmentClass] : [];
    case 'm': return [...c.modelFamilies];
    case 'r': return c.hardwareRegion ? [c.hardwareRegion] : [];
    case 'ms': { const k = measurementKey(c.hardwareMeasurement ?? null); return k ? [k] : []; }
    case 'is': return c.hardwareIssuer ? [c.hardwareIssuer] : [];
  }
}

/**
 * Pure: plan the repair for one actor. `expectedRecords` = the aggregate's continuity count less the
 * document's `continuity_records` (those the new fold already counted as continuity).
 */
export function planContinuityUnfold(input: {
  readonly actorId: string;
  readonly stats: ActorStatsDoc;
  readonly expectedRecords: number;
  readonly retained: readonly RetainedAct[];
  /** The first UTC day on which a continuity record could leave no relay record ('s landing). */
  readonly residualFromDay: string;
  readonly continuityFamily: string;
  /** THIS actor's own continuity records, read from its devices' stores (never another actor's). */
  readonly store?: readonly StoreContinuityRecord[];
}): ContinuityUnfoldResult {
  const { stats } = input;
  if (!Number.isSafeInteger(input.expectedRecords) || input.expectedRecords < 0) {
    return { ok: false, reason: 'expected_records_invalid' };
  }
  if (input.expectedRecords === 0) return { ok: false, reason: 'nothing_to_unfold' };
  if (!stats.history_complete) return { ok: false, reason: 'stats_history_incomplete' };

  const lifetimeCountersZero = stats.witnessed_compute_tokens === 0 && stats.declared_compute_tokens === 0
    && stats.independent_origins_cited === 0 && stats.approvals_cited === 0 && stats.supervision_human_turns === 0
    && stats.supervision_total_turns === 0 && /^0*$/.test(stats.payment_volume_atomic);
  const byDay = new Map<string, RetainedAct[]>();
  const seenIds = new Set<string>();
  for (const a of input.retained) {
    if (seenIds.has(a.relayPeId)) continue;
    seenIds.add(a.relayPeId);
    const list = byDay.get(a.bucketDay) ?? [];
    list.push(a);
    byDay.set(a.bucketDay, list);
  }
  const days: Record<string, DayContinuity> = {};
  const decisions: string[] = [];
  let retainedCount = 0;
  let residualCount = 0;

  const allDays = new Set<string>([...Object.keys(stats.days), ...byDay.keys()]);
  for (const day of [...allDays].sort()) {
    const bucket: ActorStatsDayBucket = stats.days[day] ?? emptyDayBucket();
    const acts = byDay.get(day) ?? [];
    const retainedCont = acts.filter(isContinuityAct);
    const residual = day >= input.residualFromDay ? bucket.n - acts.length : 0;
    if (residual < 0 || bucket.n < acts.length) return { ok: false, reason: `retained_exceeds_bucket:${day}` };
    // Before 's landing an unretained act is a pre-meter act of work the relay kept no row for
    // (folded by the legacy migration): its facets are unrecorded too, and it is never continuity.
    const unretainedWork = day < input.residualFromDay ? bucket.n - acts.length : 0;
    if (retainedCont.length === 0 && residual === 0) continue;
    const dayStore = (input.store ?? []).filter((s) => s.bucketDay === day);
    const storeCovers = dayStore.length === retainedCont.length + residual + bucket.cr;
    if (residual > 0 && !storeCovers) {
      // The store names every continuity record of the day, including those the new fold already
      // counted as continuity (`cr`).
      const relayCount = retainedCont.length + residual + bucket.cr;
      return { ok: false, reason: `residual_unconfirmed:${day}:store_${dayStore.length}_relay_${relayCount}` };
    }
    // The repair moves a record's class, facets and act totals; it can only do that when the record
    // added no other work counter (tokens, origins, approvals, supervision, payment). An act key's
    // bump states it exactly; otherwise the owner's store must cover the day and show none.
    if (retainedCont.some((a) => a.workCounters !== null && a.workCounters !== 0)) {
      return { ok: false, reason: `continuity_carries_work_counters:${day}` };
    }
    if (residual > 0 || retainedCont.some((a) => a.workCounters === null)) {
      // An actor whose every lifetime work counter is zero shows that none of its records added any.
      if (!storeCovers && !lifetimeCountersZero) return { ok: false, reason: `work_counters_unconfirmed:${day}` };
      if (dayStore.some((s) => s.workCounters !== 0)) return { ok: false, reason: `continuity_carries_work_counters:${day}` };
    }
    const d = emptyDay();
    d.n = retainedCont.length + residual;
    retainedCount += retainedCont.length;
    residualCount += residual;

    // Witness class + family: retained rows state theirs; the residual's are the day's class counts
    // less every retained act's.
    for (const a of retainedCont) {
      inc(d.wc, a.witnessClass);
      inc(d.familyClass, `${a.family}__${a.witnessClass}`);
      inc(d.tier, a.tier);
      inc(d.beneficiary, a.beneficiary);
    }
    if (residual > 0) {
      // A residual record keeps no row: its tier and beneficiary are those of the day's retained acts
      // priced by the same lane on the same device (the store names the continuity records' devices),
      // which resolve tier and link exactly as it did. None, or any disagreement, refuses.
      const devices = new Set(dayStore.map((s) => s.deviceId));
      const peers = acts.filter((a) => isDeviceObservationActionType(a.actionType) && a.deviceId !== null && devices.has(a.deviceId));
      const tiers = new Set(peers.map((a) => a.tier));
      const beneficiaries = new Set(peers.map((a) => a.beneficiary));
      if (peers.length === 0 || tiers.size !== 1 || beneficiaries.size !== 1) return { ok: false, reason: `residual_totals_ambiguous:${day}` };
      inc(d.tier, [...tiers][0] ?? null, residual);
      inc(d.beneficiary, [...beneficiaries][0] ?? null, residual);
      decisions.push(`${day} totals: every retained act shares tier ${[...tiers][0]} / beneficiary ${[...beneficiaries][0]} → residual × ${residual}`);
    }
    if (residual > 0) {
      const left: Record<string, number> = { ...bucket.wc };
      for (const a of acts) left[a.witnessClass] = (left[a.witnessClass] ?? 0) - 1;
      for (const [cls, n] of Object.entries(left)) {
        if (n < 0) return { ok: false, reason: `class_underflow:${day}:${cls}` };
      }
      if (sum(left) !== residual) return { ok: false, reason: `residual_class_mismatch:${day}` };
      for (const [cls, n] of Object.entries(left)) {
        inc(d.wc, cls, n);
        inc(d.familyClass, `${input.continuityFamily}__${cls}`, n);
      }
    }

    // Facets.
    const known = acts.filter((a) => a.compositionKnown);
    const unknownActs = acts.filter((a) => !a.compositionKnown);
    const unknownCont = unknownActs.filter(isContinuityAct).length + residual;
    const unknownAll = unknownActs.length + residual + unretainedWork;
    for (const a of retainedCont.filter((x) => x.compositionKnown)) {
      for (const f of FACETS) for (const k of facetKeys(a.composition, f)) inc(d[f], k);
    }
    for (const f of FACETS) {
      const left: Record<string, number> = { ...bucket[f] };
      for (const a of known) for (const k of facetKeys(a.composition, f)) left[k] = (left[k] ?? 0) - 1;
      for (const [k, n] of Object.entries(left)) {
        if (n < 0) return { ok: false, reason: `facet_underflow:${day}:${f}:${k}` };
        if (n === 0) delete left[k];
      }
      const total = sum(left);
      const keys = Object.keys(left);
      if (unknownCont === 0) continue;
      if (total === 0) {
        decisions.push(`${day} ${f}: none left over → continuity carries none`);
        continue;
      }
      if (unknownCont === unknownAll) {
        // Every act whose facet the relay did not record is a continuity record. A record carries at
        // most one key of a single-valued facet, so the left-over cannot exceed the record count.
        if (f !== 'm' && total > unknownCont) return { ok: false, reason: `facet_overflow:${day}:${f}` };
        for (const [k, n] of Object.entries(left)) inc(d[f], k, n);
        decisions.push(`${day} ${f}: every unrecorded act is continuity → ${JSON.stringify(left)}`);
        continue;
      }
      if (f !== 'm' && keys.length === 1 && total === unknownAll) {
        inc(d[f], keys[0], unknownCont);
        decisions.push(`${day} ${f}: one value covers every unrecorded act → ${keys[0]} × ${unknownCont}`);
        continue;
      }
      // Ambiguous on relay records alone: the owner's store decides the non-hardware facets.
      const evidence = (input.store ?? []).filter((s) => s.bucketDay === day);
      if ((f === 'e' || f === 'm') && evidence.length === unknownCont) {
        const fromStore: Record<string, number> = {};
        for (const s of evidence) {
          if (f === 'e') inc(fromStore, s.environmentClass);
          else for (const fam of s.modelFamilies) inc(fromStore, fam);
        }
        for (const [k, n] of Object.entries(fromStore)) {
          if ((left[k] ?? 0) < n) return { ok: false, reason: `store_exceeds_left_over:${day}:${f}:${k}` };
        }
        for (const [k, n] of Object.entries(fromStore)) inc(d[f], k, n);
        decisions.push(`${day} ${f}: decided by the device store → ${JSON.stringify(fromStore)}`);
        continue;
      }
      return { ok: false, reason: `facet_ambiguous:${day}:${f}` };
    }
    days[day] = d;
  }

  const records = retainedCount + residualCount;
  if (records !== input.expectedRecords) {
    return { ok: false, reason: `count_mismatch:found_${records}_expected_${input.expectedRecords}` };
  }
  return { ok: true, plan: { actorId: input.actorId, records, retained: retainedCount, residual: residualCount, days, decisions } };
}

function subtract(map: Readonly<Record<string, number>>, take: Readonly<Record<string, number>>, where: string): Record<string, number> {
  const out: Record<string, number> = { ...map };
  for (const [k, n] of Object.entries(take)) {
    if (n === 0) continue;
    const next = (out[k] ?? 0) - n;
    if (next < 0) throw new Error(`continuity_unfold_underflow:${where}:${k}`);
    if (next === 0) delete out[k]; else out[k] = next;
  }
  return out;
}

/** Pure: apply a plan. Throws (never writes a partial document) when any counter would go negative. */
export function applyContinuityUnfold(stats: ActorStatsDoc, plan: ContinuityUnfoldPlan, nowMs: number): ActorStatsDoc {
  const life = emptyDay();
  const days: Record<string, ActorStatsDayBucket> = { ...stats.days };
  for (const [day, d] of Object.entries(plan.days)) {
    for (const f of ['wc', 'familyClass', ...FACETS] as const) for (const [k, n] of Object.entries(d[f])) inc(life[f], k, n);
    life.n += d.n;
    const b = stats.days[day];
    if (b === undefined) throw new Error(`continuity_unfold_missing_day:${day}`);
    if (b.n < d.n) throw new Error(`continuity_unfold_underflow:${day}:n`);
    days[day] = {
      ...b,
      n: b.n - d.n,
      wc: subtract(b.wc, d.wc, `${day}.wc`),
      e: subtract(b.e, d.e, `${day}.e`),
      m: subtract(b.m, d.m, `${day}.m`),
      r: subtract(b.r, d.r, `${day}.r`),
      ms: subtract(b.ms, d.ms, `${day}.ms`),
      is: subtract(b.is, d.is, `${day}.is`),
      cr: b.cr + d.n,
    };
  }
  if (stats.pe_count < life.n) throw new Error('continuity_unfold_underflow:pe_count');
  return {
    ...stats,
    pe_count: stats.pe_count - life.n,
    continuity_records: stats.continuity_records + life.n,
    by_type: subtract(stats.by_type, { [CONTINUITY_ACTION_TYPE]: life.n }, 'by_type'),
    by_family_class: subtract(stats.by_family_class, life.familyClass, 'by_family_class'),
    environments: subtract(stats.environments, life.e, 'environments'),
    models: subtract(stats.models, life.m, 'models'),
    regions: subtract(stats.regions, life.r, 'regions'),
    measurements: subtract(stats.measurements, life.ms, 'measurements'),
    issuers: subtract(stats.issuers, life.is, 'issuers'),
    days,
    updated_at_ms: nowMs,
  };
}

/** Pure: the act totals the plan moves (summed over its days): by tier, and by beneficiary human. */
export function continuityTotalsOf(plan: ContinuityUnfoldPlan): { tier: Record<string, number>; beneficiary: Record<string, number> } {
  const tier: Record<string, number> = {};
  const beneficiary: Record<string, number> = {};
  for (const d of Object.values(plan.days)) {
    for (const [k, n] of Object.entries(d.tier)) inc(tier, k, n);
    for (const [k, n] of Object.entries(d.beneficiary)) inc(beneficiary, k, n);
  }
  return { tier, beneficiary };
}

/** Pure: the actor's own act totals without its continuity records (attestation tiers). Throws on underflow. */
export function applyContinuityUnfoldToActorTotals(doc: ActorMeterTotalsDoc, plan: ContinuityUnfoldPlan, nowMs: number): ActorMeterTotalsDoc {
  return { ...doc, by_attestation_tier: subtract(doc.by_attestation_tier, continuityTotalsOf(plan).tier, 'by_attestation_tier'), updated_at_ms: nowMs };
}

/** Pure: a linked human's acts-by-agent without that agent's continuity records. Throws on underflow. */
export function applyContinuityUnfoldToBeneficiaryTotals(doc: ActorMeterTotalsDoc, agentId: string, count: number, nowMs: number): ActorMeterTotalsDoc {
  return { ...doc, beneficiary_acts_by_agent: subtract(doc.beneficiary_acts_by_agent, { [agentId]: count }, 'beneficiary_acts_by_agent'), updated_at_ms: nowMs };
}
