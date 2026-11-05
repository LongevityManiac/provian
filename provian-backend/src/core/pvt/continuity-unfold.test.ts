/**
 * Continuity is not work — the one-time repair of documents that folded
 * chain-continuity records as work. RED controls: a count that does not reconcile, an ambiguous facet,
 * and an underflow all refuse; the repaired document reads exactly what the new fold would have built.
 */
import { describe, it, expect } from '@jest/globals';
import { applyActorStatsBump, emptyActorStats, type ActorStatsBump, type ActorStatsDoc, type CompositionSignals } from './actor-stats';
import {
  applyContinuityUnfold, applyContinuityUnfoldToActorTotals, applyContinuityUnfoldToBeneficiaryTotals, continuityTotalsOf,
  planContinuityUnfold, type RetainedAct,
} from './continuity-unfold';
import { coerceActorMeterTotals } from '../meter/actor-meter-totals';
import { assembleVocabulary } from '../presentation/vocabulary';

const T0 = Date.UTC(2026, 9, 10, 12);
const DAY = '2026-10-10';
const MS = `sha256:${'79'.repeat(32)}`;
const IS = '59'.repeat(32);

const comp = (over: Partial<CompositionSignals>): CompositionSignals => ({
  modelFamilies: [], environmentClass: null, hardwareRegion: null, hardwareMeasurement: null,
  witnessedPaymentAtomic: null, supervisionHumanTurns: null, supervisionTotalTurns: null, ...over,
});
const idle = (over: Partial<ActorStatsBump> = {}): ActorStatsBump => ({
  actorId: 'p', actionType: 'compute_session', family: 'other', witnessClass: 'hardware_rooted', timestampMs: T0,
  attestationTier: 'software', witnessObservedTokens: null, bodyDeclaredTokens: null, independentOriginCount: 0,
  approvalsCited: 0, composition: comp({ environmentClass: 'vm', hardwareMeasurement: MS, hardwareIssuer: IS }), ...over,
});
const coding = (over: Partial<ActorStatsBump> = {}): ActorStatsBump => idle({ actionType: 'coding_session', family: 'agent', composition: null, witnessClass: 'device_tier', ...over });

/** The retained row the relay keeps for a work act: an act key with its exact stats bump. */
const keyOf = (b: ActorStatsBump, i = 0): RetainedAct => ({
  relayPeId: `pe_work_${i}_${b.actionType}_${String(b.witnessClass)}`, bucketDay: DAY, actionType: b.actionType, mintStatus: 'eligible',
  witnessClass: String(b.witnessClass), family: b.family, composition: b.composition, compositionKnown: true,
  tier: 'software', beneficiary: 'human_h', deviceId: 'dev_vm', workCounters: 0,
});

/** The pre-ruling fold of the presenter's day: 27 idle measured records + 3 coding acts. */
function presenterDay(): { stats: ActorStatsDoc; work: ActorStatsBump[] } {
  let s = emptyActorStats('p');
  const work = [coding({ witnessClass: 'hardware_rooted', composition: comp({ hardwareMeasurement: MS, hardwareIssuer: IS }) }), coding(), coding()];
  for (let i = 0; i < 27; i += 1) s = applyActorStatsBump(s, idle(), T0);
  for (const w of work) s = applyActorStatsBump(s, w, T0);
  return { stats: s, work };
}

/** The presenter's own store: its 27 continuity records on the day (it confirms the residual). */
const STORE = Array.from({ length: 27 }, () => ({ bucketDay: DAY, deviceId: 'dev_vm' as string | null, environmentClass: 'vm', modelFamilies: [] as string[], workCounters: 0 }));
const plan = (stats: ActorStatsDoc, retained: RetainedAct[], expected: number, store: typeof STORE | undefined = STORE) => planContinuityUnfold({
  actorId: 'p', stats, expectedRecords: expected, retained, residualFromDay: '2026-10-07', continuityFamily: 'other', store,
});

describe('continuity unfold', () => {
  it('the presenter: 27 idle records leave every work count; the repaired document equals the new fold', () => {
    const { stats, work } = presenterDay();
    const r = plan(stats, work.map((w, i) => keyOf(w, i)), 27);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan).toMatchObject({ records: 27, retained: 0, residual: 27 });
    const repaired = applyContinuityUnfold(stats, r.plan, T0);

    // What the ruling's fold builds from the same records, for comparison.
    let ruled = emptyActorStats('p');
    for (let i = 0; i < 27; i += 1) ruled = applyActorStatsBump(ruled, idle({ continuity: true }), T0);
    for (const w of work) ruled = applyActorStatsBump(ruled, w, T0);

    const strip = (d: ActorStatsDoc) => ({ ...d, updated_at_ms: 0 });
    expect(strip(repaired)).toEqual(strip(ruled));
    const v = assembleVocabulary({
      principal: { kind: 'agent', walletId: 'w', peOwnerUserId: 'p', address: '0x' }, stats: repaired, nowMs: T0, inEdges: [],
      outEdges: { signer: 'p', owners: new Map(), totalEdges: 0 }, registeredDevices: 1, bondActive: 0, openBondClaimsAgainst: 0,
      invalidationActive: 0, humanBeneficiary: 0, linkedAgents: 0, presentationsProduced: 0, presentationsRecent: 0,
      presentationsWindowed: { 30: 0, 90: 0, 365: 0 },
    });
    expect(v['work.hardware_rooted']).toBe(1);
    expect(v['work.total']).toBe(3);
    expect(v['continuity.chain_depth']).toBe(30);
  });

  it('RED control: a residual day the actor\'s own store does not confirm refuses', () => {
    // A held act released since keeps no row anywhere: the residual alone would call it continuity.
    const { stats, work } = presenterDay();
    expect(plan(stats, work.map((w, i) => keyOf(w, i)), 27, [])).toEqual({ ok: false, reason: `residual_unconfirmed:${DAY}:store_0_relay_27` });
    expect(plan(stats, work.slice(1).map((w, i) => keyOf(w, i + 1)), 28, STORE)).toEqual({ ok: false, reason: `residual_unconfirmed:${DAY}:store_27_relay_28` });
  });

  it('RED control: a count that does not reconcile with the aggregate refuses', () => {
    const { stats, work } = presenterDay();
    expect(plan(stats, work.map((w, i) => keyOf(w, i)), 26)).toEqual({ ok: false, reason: 'count_mismatch:found_27_expected_26' });
    // A work act the relay lost track of would be counted as continuity — the aggregate catches it.
    expect(plan(stats, work.slice(1).map((w, i) => keyOf(w, i + 1)), 27).ok).toBe(false);
  });

  it('RED control: a facet the relay records cannot decide refuses (without the owner\'s store)', () => {
    // Two page rows (facets unrecorded) — one idle, one an act of work — on a day whose two
    // environment values could belong to either.
    let s = emptyActorStats('p');
    s = applyActorStatsBump(s, idle({ witnessClass: 'device_tier', composition: comp({ environmentClass: 'vm' }) }), T0);
    s = applyActorStatsBump(s, coding({ composition: comp({ environmentClass: 'container' }) }), T0);
    const pageRow = (actionType: string, mintStatus: string): RetainedAct => ({
      relayPeId: `pe_page_${actionType}`, bucketDay: '2026-10-05', actionType, mintStatus, witnessClass: 'device_tier', family: 'other',
      // workCounters stated so this control isolates the facet rule (see the work-counter controls).
      composition: null, compositionKnown: false, tier: 'software', beneficiary: null, deviceId: 'dev_a', workCounters: 0,
    });
    const early = { ...s, days: { '2026-10-05': s.days[DAY] } };
    const r = planContinuityUnfold({
      actorId: 'p', stats: early, expectedRecords: 1, residualFromDay: '2026-10-07', continuityFamily: 'other',
      retained: [pageRow('compute_session', 'skipped_no_output'), pageRow('coding_session', 'eligible')],
    });
    expect(r).toEqual({ ok: false, reason: 'facet_ambiguous:2026-10-05:e' });
    // The owner's store decides it.
    const decided = planContinuityUnfold({
      actorId: 'p', stats: early, expectedRecords: 1, residualFromDay: '2026-10-07', continuityFamily: 'other',
      retained: [pageRow('compute_session', 'skipped_no_output'), pageRow('coding_session', 'eligible')],
      store: [{ bucketDay: '2026-10-05', deviceId: 'dev_a', environmentClass: 'vm', modelFamilies: [], workCounters: 0 }],
    });
    expect(decided.ok && decided.plan.days['2026-10-05'].e).toEqual({ vm: 1 });
  });

  it('an act held AND keyed (two collections) is one act, not two', () => {
    const { stats, work } = presenterDay();
    const retained = work.map((w, i) => keyOf(w, i));
    expect(plan(stats, [...retained, retained[0]], 27).ok).toBe(true);
    // RED: the same row under a second id is a second act — the residual drops and the store refuses.
    expect(plan(stats, [...retained, { ...retained[0], relayPeId: 'pe_other' }], 27).ok).toBe(false);
  });

  it('the store count includes the records the new fold already counted as continuity (cr)', () => {
    const { stats, work } = presenterDay();
    // Five more idle records sealed after the deploy: they sit in cr, never in n.
    let after = stats;
    for (let i = 0; i < 5; i += 1) after = applyActorStatsBump(after, idle({ continuity: true }), T0);
    const store32 = [...STORE, ...STORE.slice(0, 5)];
    const r = plan(after, work.map((w, i) => keyOf(w, i)), 27, store32);
    expect(r.ok && r.plan.records).toBe(27);
    // RED: the store without them no longer matches.
    expect(plan(after, work.map((w, i) => keyOf(w, i)), 27, STORE).ok).toBe(false);
  });

  it('the act totals lose the continuity records too: tiers and the linked human\'s acts by agent', () => {
    const { stats, work } = presenterDay();
    const r = plan(stats, work.map((w, i) => keyOf(w, i)), 27);
    if (!r.ok) throw new Error('plan refused');
    expect(continuityTotalsOf(r.plan)).toEqual({ tier: { software: 27 }, beneficiary: { human_h: 27 } });
    const totals = { ...coerceActorMeterTotals('p', null), by_attestation_tier: { software: 30 } };
    expect(applyContinuityUnfoldToActorTotals(totals, r.plan, T0).by_attestation_tier).toEqual({ software: 3 });
    const human = { ...coerceActorMeterTotals('human_h', null), beneficiary_acts_by_agent: { p: 30, other: 4 } };
    expect(applyContinuityUnfoldToBeneficiaryTotals(human, 'p', 27, T0).beneficiary_acts_by_agent).toEqual({ p: 3, other: 4 });
    // RED: totals that never counted them underflow and throw (nothing is written).
    expect(() => applyContinuityUnfoldToActorTotals({ ...totals, by_attestation_tier: { software: 3 } }, r.plan, T0)).toThrow('continuity_unfold_underflow');
  });

  it('RED control: a residual day whose retained acts disagree on tier or beneficiary refuses', () => {
    const { stats, work } = presenterDay();
    const retained = work.map((w, i) => keyOf(w, i));
    retained[1] = { ...retained[1], beneficiary: null };
    expect(plan(stats, retained, 27)).toEqual({ ok: false, reason: `residual_totals_ambiguous:${DAY}` });
  });

  it('RED control: residual act totals come only from the same device\'s device-lane acts', () => {
    const { stats, work } = presenterDay();
    // A Genesis grant keeps no beneficiary (fixed grants skip the split): it must not decide the link.
    const genesisOnly: RetainedAct[] = work.map((w, i) => ({ ...keyOf(w, i), actionType: 'genesis_device_link', beneficiary: null }));
    expect(plan(stats, genesisOnly, 27)).toEqual({ ok: false, reason: `residual_totals_ambiguous:${DAY}` });
    // Acts from another device of the actor do not decide either.
    const otherDevice = work.map((w, i) => ({ ...keyOf(w, i), deviceId: 'dev_phone' }));
    expect(plan(stats, otherDevice, 27)).toEqual({ ok: false, reason: `residual_totals_ambiguous:${DAY}` });
    // The same device's coding acts do.
    expect(plan(stats, work.map((w, i) => keyOf(w, i)), 27).ok).toBe(true);
  });

  it('RED control: a continuity record that added any other work counter refuses', () => {
    const { stats, work } = presenterDay();
    const retained = work.map((w, i) => keyOf(w, i));
    // A store record with compute tokens (the fold counted them as witnessed work).
    const tokenStore = STORE.map((s, i) => (i === 0 ? { ...s, workCounters: 500 } : s));
    expect(plan(stats, retained, 27, tokenStore)).toEqual({ ok: false, reason: `continuity_carries_work_counters:${DAY}` });
    // A retained act key whose exact bump carried counters.
    let s2 = emptyActorStats('p');
    s2 = applyActorStatsBump(s2, idle({ witnessObservedTokens: 40 }), T0);
    s2 = applyActorStatsBump(s2, coding(), T0);
    const early = { ...s2, days: { '2026-10-05': s2.days[DAY] } };
    const contKey: RetainedAct = { ...keyOf(idle(), 9), bucketDay: '2026-10-05', mintStatus: 'skipped_no_output', workCounters: 40 };
    const codingKey: RetainedAct = { ...keyOf(coding(), 8), bucketDay: '2026-10-05' };
    const r = planContinuityUnfold({ actorId: 'p', stats: early, expectedRecords: 1, retained: [contKey, codingKey], residualFromDay: '2026-10-07', continuityFamily: 'other' });
    expect(r).toEqual({ ok: false, reason: 'continuity_carries_work_counters:2026-10-05' });
    // A page row (no bump) without the owner's store cannot show it carried none...
    const pageCont: RetainedAct = { ...contKey, workCounters: null, compositionKnown: false, composition: null };
    const r2 = planContinuityUnfold({ actorId: 'p', stats: early, expectedRecords: 1, retained: [pageCont, codingKey], residualFromDay: '2026-10-07', continuityFamily: 'other' });
    expect(r2).toEqual({ ok: false, reason: 'work_counters_unconfirmed:2026-10-05' });
    // ...unless every lifetime work counter of the actor is zero (no record of it added any).
    let s4 = emptyActorStats('p');
    s4 = applyActorStatsBump(s4, idle(), T0);
    s4 = applyActorStatsBump(s4, coding(), T0);
    const early4 = { ...s4, days: { '2026-10-05': s4.days[DAY] } };
    const r4 = planContinuityUnfold({ actorId: 'p', stats: early4, expectedRecords: 1, retained: [pageCont, codingKey], residualFromDay: '2026-10-07', continuityFamily: 'other' });
    expect(r4.ok).toBe(true);
    // The same key with a zero bump moves.
    let s3 = emptyActorStats('p');
    s3 = applyActorStatsBump(s3, idle(), T0);
    s3 = applyActorStatsBump(s3, coding(), T0);
    const early3 = { ...s3, days: { '2026-10-05': s3.days[DAY] } };
    const ok = planContinuityUnfold({ actorId: 'p', stats: early3, expectedRecords: 1, retained: [{ ...contKey, workCounters: 0 }, codingKey], residualFromDay: '2026-10-07', continuityFamily: 'other' });
    expect(ok.ok).toBe(true);
  });

  it('RED control: an underflow throws and writes nothing', () => {
    const { stats, work } = presenterDay();
    const r = plan(stats, work.map((w, i) => keyOf(w, i)), 27);
    if (!r.ok) throw new Error('plan refused');
    const shrunk = { ...stats, by_type: { ...stats.by_type, compute_session: 3 } };
    expect(() => applyContinuityUnfold(shrunk, r.plan, T0)).toThrow('continuity_unfold_underflow:by_type:compute_session');
  });

  it('nothing to unfold once the records are continuity (a second run is a no-op)', () => {
    const { stats, work } = presenterDay();
    const r = plan(stats, work.map((w, i) => keyOf(w, i)), 27);
    if (!r.ok) throw new Error('plan refused');
    const repaired = applyContinuityUnfold(stats, r.plan, T0);
    expect(plan(repaired, work.map((w, i) => keyOf(w, i)), 27 - repaired.continuity_records)).toEqual({ ok: false, reason: 'nothing_to_unfold' });
  });
});
