/**
 * the standing rule : an idle `compute_session` continuity record (sealed
 * `skipped_no_output`) is continuity, not work. It moves the continuity facts (first / last seen,
 * chain depth, active days, streak) and leaves every work count, class share and composition fact —
 * `work.*`, `share.*`, `composition.*` and anything a gate reads as acts. 's minting treatment
 * is unchanged; sealed PEs are untouched.
 */
import { describe, it, expect } from '@jest/globals';
import {
  applyActorStatsBump, coerceActorStats, decodeDayBucket, emptyActorStats, encodeDayBucket, isContinuityStatsRow,
  serializeActorStats, type ActorStatsBump, type ActorStatsDoc, type CompositionSignals,
} from './actor-stats';
import { bumpFromHistoryRow } from './actor-stats-backfill';
import { assembleVocabulary } from '../presentation/vocabulary';
import { statsBumpOfOutcome } from '../meter/meter-commit';
import { isChainContinuityRecord } from '../meter/meter-seal';
import type { MeterActOutcome } from '../meter/meter-seal';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 10, 12);
const MEASUREMENT = `sha256:${'79'.repeat(32)}`;
const ISSUER = '59'.repeat(32);

function comp(over: Partial<CompositionSignals>): CompositionSignals {
  return {
    modelFamilies: [], environmentClass: null, hardwareRegion: null, hardwareMeasurement: null,
    witnessedPaymentAtomic: null, supervisionHumanTurns: null, supervisionTotalTurns: null, ...over,
  };
}

/** The bump a measured device's record contributes (the VM of the proof: vTPM, pinned measurement). */
function measured(over: Partial<ActorStatsBump>): ActorStatsBump {
  return {
    actorId: 'presenter', actionType: 'compute_session', family: 'other', witnessClass: 'hardware_rooted',
    timestampMs: T0, attestationTier: 'software', witnessObservedTokens: null, bodyDeclaredTokens: null,
    independentOriginCount: 0, approvalsCited: 0,
    composition: comp({ environmentClass: 'vm', hardwareMeasurement: MEASUREMENT, hardwareIssuer: ISSUER }),
    ...over,
  };
}

const base = {
  principal: { kind: 'agent' as const, walletId: 'w_p', peOwnerUserId: 'presenter', address: '0xabc' },
  nowMs: T0,
  inEdges: [],
  outEdges: { signer: 'presenter', owners: new Map<string, boolean>(), totalEdges: 0 },
  registeredDevices: 1, bondActive: 0, openBondClaimsAgainst: 0, invalidationActive: 0,
  humanBeneficiary: 0, linkedAgents: 0, presentationsProduced: 0, presentationsRecent: 0,
  presentationsWindowed: { 30: 0, 90: 0, 365: 0 },
};
const vocab = (stats: ActorStatsDoc) => assembleVocabulary({ ...base, stats });

/** Every fact a gate reads as acts. */
const ACT_FACT = /^(work|share|composition|money)\./;

/**
 * The guard under test: the act facts that differ between two vocabularies, plus how many act facts
 * it compared (a pass over zero facts is not a pass).
 */
function actFactDiff(before: Readonly<Record<string, number>>, after: Readonly<Record<string, number>>): { compared: number; moved: string[] } {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)].filter((k) => ACT_FACT.test(k)));
  const moved = [...keys].filter((k) => (before[k] ?? 0) !== (after[k] ?? 0)).sort();
  return { compared: keys.size, moved };
}

/** One minted act a day earlier, so the comparison has work facts to compare. */
function withOneAct(): ActorStatsDoc {
  return applyActorStatsBump(emptyActorStats('presenter'), measured({
    actionType: 'coding_session', family: 'agent', timestampMs: T0 - DAY,
  }), T0 - DAY);
}

describe('continuity is not work ', () => {
  it('an idle measured device adds continuity and adds no work', () => {
    const before = withOneAct();
    const after = applyActorStatsBump(before, measured({ continuity: true }), T0);
    const vb = vocab(before);
    const va = vocab(after);

    const diff = actFactDiff(vb, va);
    expect(diff.compared).toBeGreaterThan(10);
    expect(diff.moved).toEqual([]);
    expect(va['work.total']).toBe(1);
    expect(va['work.hardware_rooted']).toBe(1);
    expect(va['work.hardware_rooted_30d']).toBe(1);
    expect(va[`composition.measurement.${MEASUREMENT}`]).toBe(1);

    expect(va['continuity.chain_depth']).toBe(vb['continuity.chain_depth'] + 1);
    expect(va['continuity.active_days']).toBe(vb['continuity.active_days'] + 1);
    expect(va['continuity.active_days_30d']).toBe(vb['continuity.active_days_30d'] + 1);
    expect(va['continuity.streak_days']).toBe(2);
    expect(va['continuity.last_seen_ms']).toBe(T0);
    expect(after.continuity_records).toBe(1);
    expect(after.pe_count).toBe(1);
    expect(after.days['2026-10-10']).toMatchObject({ n: 0, cr: 1, wc: {}, e: {}, ms: {}, is: {} });
  });

  it('a minted act adds both — and the guard reports it (RED control)', () => {
    const before = withOneAct();
    const after = applyActorStatsBump(before, measured({}), T0);
    const vb = vocab(before);
    const va = vocab(after);

    const diff = actFactDiff(vb, va);
    expect(diff.moved).toEqual(expect.arrayContaining([
      'work.total', 'work.hardware_rooted', 'work.other.hardware_rooted', `composition.measurement.${MEASUREMENT}`,
      `composition.issuer.${ISSUER}`, 'composition.env.vm',
    ]));
    expect(va['work.total']).toBe(2);
    expect(va['work.hardware_rooted']).toBe(2);
    expect(va['continuity.chain_depth']).toBe(vb['continuity.chain_depth'] + 1);
    expect(va['continuity.active_days']).toBe(vb['continuity.active_days'] + 1);
    expect(after.continuity_records).toBe(0);
  });

  it('RED control: the same idle record folded WITHOUT the ruling moves the work facts', () => {
    // The pre-ruling fold: the continuity record bumped like an act. The guard must see it.
    const before = withOneAct();
    const unruled = applyActorStatsBump(before, measured({ continuity: false }), T0);
    expect(actFactDiff(vocab(before), vocab(unruled)).moved).toContain('work.hardware_rooted');
  });

  it("the presenter's shape: 27 idle measured records + 3 coding acts → hardware_rooted counts the one act", () => {
    let s = emptyActorStats('presenter');
    for (let i = 0; i < 27; i += 1) s = applyActorStatsBump(s, measured({ continuity: true, timestampMs: T0 - i * 60_000 }), T0);
    s = applyActorStatsBump(s, measured({ actionType: 'coding_session', family: 'agent' }), T0);
    for (let i = 0; i < 2; i += 1) {
      s = applyActorStatsBump(s, measured({ actionType: 'coding_session', family: 'agent', witnessClass: 'device_tier', composition: null }), T0);
    }
    const v = vocab(s);
    expect(v['work.total']).toBe(3);
    expect(v['work.hardware_rooted']).toBe(1);
    expect(v['share.witness.hardware_rooted']).toBe(3333);
    expect(v['share.witness.device_tier']).toBe(6666);
    expect(v[`composition.measurement.${MEASUREMENT}`]).toBe(1);
    expect(v['composition.env.vm']).toBe(1);
    expect(v['continuity.chain_depth']).toBe(30);
    expect(v['continuity.active_days_30d']).toBe(1);
  });

  it('a day with only continuity records is an active day in every window', () => {
    const s = applyActorStatsBump(emptyActorStats('presenter'), measured({ continuity: true }), T0);
    const v = vocab(s);
    expect(v['work.total_30d']).toBe(0);
    expect(v['continuity.active_days_30d']).toBe(1);
    expect(v['continuity.active_days_365d']).toBe(1);
    expect(v['continuity.chain_depth']).toBe(1);
  });
});

describe('one predicate, every fold site', () => {
  const outcome = (row: Record<string, unknown>) => ({
    row,
    side: { statsBump: { ...measured({}) } as unknown as Record<string, unknown> },
  }) as unknown as Pick<MeterActOutcome, 'side' | 'row'>;

  it("the batch commit marks a continuity record by 's own predicate", () => {
    const row = { actionType: 'compute_session', mint_status: 'skipped_no_output' };
    expect(isChainContinuityRecord(row)).toBe(true);
    expect(statsBumpOfOutcome(outcome(row))?.continuity).toBe(true);
  });

  it('RED controls: a minted compute_session, or another type sealed skipped_no_output, is work', () => {
    for (const row of [
      { actionType: 'compute_session', mint_status: 'eligible' },
      { actionType: 'compute_session', mint_status: 'record_only' },
      { actionType: 'coding_session', mint_status: 'skipped_no_output' },
    ]) {
      expect(isContinuityStatsRow(row)).toBe(isChainContinuityRecord(row));
      expect(statsBumpOfOutcome(outcome(row))?.continuity).toBeUndefined();
    }
  });

  it('the backfill re-folds a continuity row as continuity, a minted row as work', () => {
    const skipped = bumpFromHistoryRow({ userId: 'presenter', actionType: 'compute_session', mint_status: 'skipped_no_output', timestamp: T0 } as never, null);
    const minted = bumpFromHistoryRow({ userId: 'presenter', actionType: 'compute_session', mint_status: 'eligible', timestamp: T0 } as never, null);
    expect(skipped?.continuity).toBe(true);
    expect(minted?.continuity).toBeUndefined();
  });
});

describe('persistence', () => {
  it('the continuity count round-trips through the stored document', () => {
    const s = applyActorStatsBump(emptyActorStats('presenter'), measured({ continuity: true }), T0);
    const back = coerceActorStats('presenter', serializeActorStats(s));
    expect(back.continuity_records).toBe(1);
    expect(back.days['2026-10-10'].cr).toBe(1);
    expect(decodeDayBucket(encodeDayBucket(back.days['2026-10-10']))?.cr).toBe(1);
  });

  it('a document written before the ruling reads zero continuity records', () => {
    const { continuity_records: _drop, ...older } = serializeActorStats(emptyActorStats('presenter')) as Record<string, unknown>;
    void _drop;
    expect(coerceActorStats('presenter', older).continuity_records).toBe(0);
    expect(decodeDayBucket('{"n":2}')?.cr).toBe(0);
  });
});
