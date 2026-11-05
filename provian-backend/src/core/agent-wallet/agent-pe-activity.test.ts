/**
 * Agent PE activity on the PE meter: the count is the agent's running total, the entries are its
 * live act keys (priced rows, never content), and the beneficiary view's count is the human's
 * running total of this agent's acts — none of it reads a per-PE collection.
 */
import { fetchAgentPEActivity, countVisibleAgentPEs } from './agent-pe-activity';
import type { Firestore } from 'firebase-admin/firestore';
import {
  computeRecordSnapshot,
  disclosedRationalFactor,
  hashRecordEconomicSnapshot,
  type RecordEconomicSnapshot,
} from '../pvt/policy/monetary-accounting';
import { materializeProposedMonetaryPolicy } from '../pvt/policy/runtime-monetary-policy';
import type { CurrentSettlementProjectionContext } from '../pvt/policy/economic-projection';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { ACTOR_STATS_COLLECTION } from '../pvt/actor-stats';
import { ACTOR_METER_TOTALS_COLLECTION } from '../meter/actor-meter-totals';
import { seedActKeys } from '../meter/__test-helpers__/seed-act-keys';

const AGENT_ID = 'agent_df7a5158';

function db(fake: FakeFirestore): Firestore {
  return fake as unknown as Firestore;
}

function withStats(fake: FakeFirestore, actorId: string, peCount: number): void {
  fake.store.set(`${ACTOR_STATS_COLLECTION}/${actorId}`, { schema_version: 'actor-stats/v2', actor_id: actorId, pe_count: peCount });
}

const PES = [
  { peId: 'p1', userId: AGENT_ID, actionType: 'wallet_created', timestamp: 100, mint_status: 'record_only' },
  { peId: 'p2', userId: AGENT_ID, actionType: 'genesis_signup', timestamp: 300, mint_status: 'eligible' },
  { peId: 'p3', userId: AGENT_ID, actionType: 'agent_tool_orchestration', timestamp: 200, mint_status: 'eligible' },
  { peId: 'pX', userId: 'agent_other', actionType: 'badge_earned', timestamp: 400, mint_status: 'record_only' },
];

describe('fetchAgentPEActivity', () => {
  it('counts from the running total and serves no relay act history', async () => {
    const fake = createFakeFirestore();
    seedActKeys(fake, PES);
    withStats(fake, AGENT_ID, 57); // lifetime total: far more than the live window holds
    const { peCount, entries } = await fetchAgentPEActivity(db(fake), AGENT_ID, 10);
    expect(peCount).toBe(57);
    expect(entries).toEqual([]); // even retained old act rows are never served as history
  });

  it('limit bounds entries but NOT the count', async () => {
    const fake = createFakeFirestore();
    seedActKeys(fake, PES);
    withStats(fake, AGENT_ID, 3);
    const { peCount, entries } = await fetchAgentPEActivity(db(fake), AGENT_ID, 1);
    expect(peCount).toBe(3);
    expect(entries).toEqual([]);
  });

  it('RED: an agent with no totals and no live acts returns count 0 and no entries', async () => {
    const fake = createFakeFirestore();
    seedActKeys(fake, PES.filter((p) => p.userId !== AGENT_ID));
    const { peCount, entries } = await fetchAgentPEActivity(db(fake), AGENT_ID, 10);
    expect(peCount).toBe(0);
    expect(entries).toEqual([]);
  });

  it('reads no per-PE collection', async () => {
    const fake = createFakeFirestore();
    // A planted legacy row must never surface (the relay keeps no PEs).
    fake.store.set('pe_history/legacy', { peId: 'legacy', userId: AGENT_ID, timestamp: 999 });
    fake.store.set('provenance_envelopes/legacy', { id: 'legacy', user_id: AGENT_ID, timestamp: 999 });
    const { peCount, entries } = await fetchAgentPEActivity(db(fake), AGENT_ID, 10);
    expect(peCount).toBe(0);
    expect(entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Beneficiary view: the linked human's projected cut of the agent's eligible work. Every number
// is the eligible-only settlement projection, derived from the sealed per-PE split
// — never a record-points sum. Fixtures build a REAL verifiable snapshot.
// ---------------------------------------------------------------------------
const HUMAN_ID = 'user_human_1';
const OTHER_HUMAN = 'user_human_2';
const UNIT = 10n ** 18n;

function snapshotFor(peId: string, actionType: string, recordedAtMs: number): RecordEconomicSnapshot {
  return computeRecordSnapshot(materializeProposedMonetaryPolicy(0), {
    peId,
    economicActorId: 'user-agent',
    actionType,
    recordedAtMs,
    occurrenceOrdinal: 1,
    dailyOrdinal: 1,
    exactDuplicate: false,
    uniqueArtifact: false,
    attestationTier: 'software',
    linkageState: 'unlinked',
    evidenceState: 'verified',
    canonicalEventId: null,
    selfReferencing: false,
    sharedBeneficialOwnership: false,
    pairChurnDetected: false,
    sessionLineageId: null,
    genesisReservation: null,
  });
}

/** An eligible PE routed to `humanId`, with the agent share overridden + re-hashed. */
function eligibleBeneficiaryPe(
  peId: string,
  humanId: string,
  agentShareBps: number,
  timestamp: number,
): Record<string, unknown> {
  const base = snapshotFor(peId, 'wallet_created', timestamp);
  const snap: RecordEconomicSnapshot = {
    ...base,
    recordTimeFactors: { ...base.recordTimeFactors, beneficiaryAgentShareBps: agentShareBps },
  };
  return {
    peId,
    userId: AGENT_ID,
    actionType: 'wallet_created',
    timestamp,
    category: 'wallet',
    mint_status: 'eligible',
    mint_disposition: snap.mintDisposition,
    attestationDepth: 'software',
    corroboration_status: 'none',
    economic_snapshot: snap,
    economic_snapshot_hash: hashRecordEconomicSnapshot(snap),
    beneficiary_wallet_id: humanId,
  };
}

/** A record_only PE routed to `humanId` — projects 0. */
function recordOnlyBeneficiaryPe(peId: string, humanId: string, timestamp: number): Record<string, unknown> {
  return {
    peId, userId: AGENT_ID, actionType: 'agent_note', timestamp,
    mint_status: 'record_only', beneficiary_wallet_id: humanId,
  };
}

function projectionContext(num: bigint, den: bigint): CurrentSettlementProjectionContext {
  return {
    projectedAtMs: 1_000,
    globalMintRate: disclosedRationalFactor(num, den, '0xPVT9.getEpochPolicy.mintRate', 'base:8453:0xkernel'),
  };
}

function withBeneficiaryTotals(fake: FakeFirestore, humanId: string, byAgent: Record<string, number>): void {
  fake.store.set(`${ACTOR_METER_TOTALS_COLLECTION}/${humanId}`, { beneficiary_acts_by_agent: byAgent });
}

describe('fetchAgentPEActivity — beneficiary view', () => {
  // b1/b2: eligible, routed to HUMAN → 80% of 10 UNIT = 8 UNIT each at rate 1/1.
  // b3: eligible, routed to OTHER_HUMAN → must NOT count for HUMAN.
  // b4: record_only, routed to HUMAN → projects 0.
  const b1 = eligibleBeneficiaryPe('b1', HUMAN_ID, 2000, 100);
  const b2 = eligibleBeneficiaryPe('b2', HUMAN_ID, 2000, 200);
  const b3 = eligibleBeneficiaryPe('b3', OTHER_HUMAN, 2000, 300);
  const b4 = recordOnlyBeneficiaryPe('b4', HUMAN_ID, 50);
  const all = [b1, b2, b3, b4];

  function seeded(): FakeFirestore {
    const fake = createFakeFirestore();
    seedActKeys(fake, all);
    withBeneficiaryTotals(fake, HUMAN_ID, { [AGENT_ID]: 3, agent_unrelated: 9 });
    withBeneficiaryTotals(fake, OTHER_HUMAN, { [AGENT_ID]: 1 });
    return fake;
  }

  it('sums the human 80% share over the live acts and counts from the running total', async () => {
    const res = await fetchAgentPEActivity(db(seeded()), AGENT_ID, 10, {
      beneficiaryUserId: HUMAN_ID,
      projectionContext: projectionContext(1n, 1n),
    });
    expect(res.beneficiary!.peCount).toBe(3); // this agent's entry, not the unrelated agent's 9
    expect(res.beneficiary!.projectedPendingPvtAtomic).toBe((16n * UNIT).toString(10)); // 8 + 8
    expect(res.beneficiary!.projectedPendingPvt).toBe('16.0');
    expect(res.entries).toEqual([]);
    // Wrong-human non-vacuity is pinned by the same fixture's nonzero OTHER_HUMAN control below.
  });

  // RED / wrong-attribution control: the SAME fixture priced for the OTHER human yields a
  // DIFFERENT result. Fails if `isForThisHuman` were dropped.
  it('RED: attribution is per-human — OTHER_HUMAN sees only b3', async () => {
    const res = await fetchAgentPEActivity(db(seeded()), AGENT_ID, 10, {
      beneficiaryUserId: OTHER_HUMAN,
      projectionContext: projectionContext(1n, 1n),
    });
    expect(res.beneficiary!.peCount).toBe(1);
    expect(res.beneficiary!.projectedPendingPvtAtomic).toBe((8n * UNIT).toString(10));
    expect(res.entries).toEqual([]);
  });

  // RED / fail-closed control: no live rate → NO number is fabricated; the count stands.
  it('RED: null projection context yields null PVT (never a fabricated number), count intact', async () => {
    const res = await fetchAgentPEActivity(db(seeded()), AGENT_ID, 10, {
      beneficiaryUserId: HUMAN_ID,
      projectionContext: null,
    });
    expect(res.beneficiary!.peCount).toBe(3);
    expect(res.beneficiary!.projectedPendingPvt).toBeNull();
    expect(res.beneficiary!.projectedPendingPvtAtomic).toBeNull();
    expect(res.entries).toEqual([]);
  });

  // RED / empty-population control: a non-empty live set with NOTHING routed to this human →
  // count 0 and an explicit 0.0 (not null: the rate is present).
  it('RED: no acts for this human over a non-empty set → count 0, projection 0.0', async () => {
    const fake = createFakeFirestore();
    seedActKeys(fake, [b3]);
    const res = await fetchAgentPEActivity(db(fake), AGENT_ID, 10, {
      beneficiaryUserId: HUMAN_ID,
      projectionContext: projectionContext(1n, 1n),
    });
    expect(res.entries).toEqual([]);
    expect(res.beneficiary!.peCount).toBe(0);
    expect(res.beneficiary!.projectedPendingPvtAtomic).toBe('0');
    expect(res.beneficiary!.projectedPendingPvt).toBe('0.0');
  });

  it('omitting opts leaves the payload unchanged (no beneficiary block/field)', async () => {
    const res = await fetchAgentPEActivity(db(seeded()), AGENT_ID, 10);
    expect(res.beneficiary).toBeUndefined();
    expect(res.entries).toEqual([]);
  });
});

describe('countVisibleAgentPEs', () => {
  it('is the agent\'s running total (one point read)', async () => {
    const fake = createFakeFirestore();
    withStats(fake, AGENT_ID, 42);
    expect(await countVisibleAgentPEs(db(fake), AGENT_ID)).toBe(42);
  });

  // RED: another actor's total is never this agent's count.
  it('RED: another actor\'s running total does not leak into this agent\'s count', async () => {
    const fake = createFakeFirestore();
    withStats(fake, 'agent_other', 42);
    expect(await countVisibleAgentPEs(db(fake), AGENT_ID)).toBe(0);
  });
});
