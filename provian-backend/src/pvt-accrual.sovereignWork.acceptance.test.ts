import { NOVELTY_COUNTERS_COLLECTION } from './core/meter/batch-pricing-counters';
/**
 * / sovereign agent-work: base-weight earning with decay, and the
 * bounds that regulate it. (reverses 's evidence-axis zeroing.)
 *
 * The compute_or_work family (evidence_requirement === 'verified_compute_or_work')
 * is `eligible` + session-lineage OPTIONAL and `external_proof_priced` the
 * attestation table for this family prices self-attested work at a DISCOUNT
 * (software 0.8x, social 0.5x — base weight, priced down by novelty decay, never
 * a terminal zero); a replication pack (software_verified) is CAPPED at the flat
 * 1.0x (the operator’s amendment — parity with proof, not the ladder's 1.2x); and
 * the externally-proven tiers (hardware*, TEE, corroborated) price at the
 * family's flat 10,000 bps LIFT, byte-identical to what and the 3b
 * neutrality paid.
 *
 * WHY: the sovereign per-occurrence key binding proves the claim is AUTHENTIC —
 * a NECESSARY admission condition (bare submissions with no server-verified
 * evidence stay fenced at pending_evidence / 0) — and self-attested/observed
 * work then EARNS base weight. The Sybil bound for the family is the per-device
 * daemon plus the real inference cost of producing observed work, NOT a cap on
 * the evidence axis (; removed the volume caps on the same
 * principle): a self-signed swarm of DISTINCT occurrences earns in proportion,
 * and novelty decay drives repetition toward the floor.
 *
 * the operator required every regulating bound enumerated with its live value
 * and pinned by a RED control. This suite pins:
 * - self-attested earning (software 0.8x, eligible — the reversal)
 * - occurrence mint-once (the second use of one occurrence mints 0)
 * - novelty decay (ordinaryNoveltyBps by occurrence ordinal, on 0.8x)
 * - flat weight (effectiveActionWeightBps constant across volume)
 * - volume-flatness (the 51st act mints like the 50th)
 * - full value on proof (hardware / on_chain_verified byte-identical to pre-change)
 * - the bare-submission fence (no verified evidence → 0, unchanged)
 *
 * RED control : temporarily setting the evidence-priced `software` tier
 * back to 0 (the zero) reddens exactly the self-attested earning
 * assertions below while every proven-path pin stays green — executed and
 * recorded in the commit.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { createFakeFirestore, type FakeFirestore } from './core/pvt/__test-helpers__/fake-firestore';
import type { BeneficiaryCacheEntry } from './core/pvt/beneficiary';

let mockDb: FakeFirestore;
jest.mock('firebase-admin', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createFakeFirestore: mk } = require('./core/pvt/__test-helpers__/fake-firestore');
  const db = mk();
  mockDb = db;
  const firestore = Object.assign(() => db, {
    FieldValue: { increment: (n: number) => ({ __increment: n }) },
  });
  return { __esModule: true, default: { firestore }, firestore };
});

const mockDaily = jest.fn<() => Promise<number>>(async () => 0);
const mockActionType = jest.fn<() => Promise<number>>(async () => 0);
jest.mock('./cache', () => ({
  cache: {
    getUserDailyPECountStrict: (...a: unknown[]) => mockDaily(...(a as [])),
    getUserActionTypeCountStrict: (...a: unknown[]) => mockActionType(...(a as [])),
    isArtifactHashSeen: async () => false,
    recordArtifactHash: async () => {},
    incrementUserActionTypeCount: jest.fn(async () => 1),
    incrementHourlyPECount: jest.fn(async () => {}),
    commitPEAccountingCountersOnce: jest.fn(async () => ({ idempotent: false })),
  },
  CacheUnavailableError: class CacheUnavailableError extends Error {},
}));

const mockResolveBeneficiary = jest.fn<
  (...args: unknown[]) => Promise<BeneficiaryCacheEntry>
>(async () => ({
  linked: false, humanWalletId: null, humanUserId: null, humanAddress: null, agentShareBps: null,
}));
jest.mock('./core/pvt/beneficiary', () => ({ resolveBeneficiary: mockResolveBeneficiary }));
jest.mock('./core/jurisdiction/jurisdiction-policy', () => ({ getJurisdictionPolicy: async () => 'immediate' }));
jest.mock('./core/pvt/delegation-pe', () => ({
  isDelegationQualifying: () => false, createDelegationPE: async () => {},
}));
jest.mock('./core/provenance/pe-type-catalog', () => ({
  getCategoryForActionType: async () => 'compute', recordActionTypeObservation: async () => {},
}));
jest.mock('./core/foundation-membership/client', () => ({
  loadFoundationMembershipConfig: () => ({ enabled: false }), queueInitialMembershipGrants: async () => {},
}));

import { recordPEAccrual } from './pvt-accrual';

const TS = Date.UTC(2026, 7, 10, 12, 0);
const SIGNER = '0x1111111111111111111111111111111111111111';
let seq = 0;

interface Sealed {
  disposition: string;
  reasonCode: string;
  mintStatus: string;
  estimatedPVT: number;
  weightBps: number | undefined;
  noveltyBps: number | undefined;
  attestationBps: number | undefined;
  recordPointsAtomic: string | undefined;
}

async function seal(
  actionType: string,
  occurrenceId: string | null,
  over: Record<string, unknown> = {},
): Promise<Sealed> {
  const peId = `pe_sw_${seq++}`;
  const bound = occurrenceId !== null
    ? {
      economicEvidenceState: 'verified' as const,
      economicCanonicalEventId: `sovereign_work:${SIGNER.toLowerCase()}:${occurrenceId}`,
      sovereignWorkOccurrenceId: occurrenceId,
      sovereignWorkSignerAddress: SIGNER,
      throwOnError: true, // durable seal (mirrors the route's durableViaOrdinaryIntake)
    }
    : {};
  await recordPEAccrual({
    peId,
    userId: 'agent1',
    actionType,
    integrationSource: 'sovereign_work_test',
    attestationDepth: 'software',
    peHash: `h_${peId}`,
    timestamp: TS,
    deviceAttestationId: `dev_${peId}`,
    ...bound,
    ...over,
  } as Parameters<typeof recordPEAccrual>[0]);
  const row = mockDb.store.get(`pe_history/${peId}`) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`no pe_history row for ${actionType}`);
  const snap = row.economic_snapshot as Record<string, unknown> | null;
  const factors = snap?.recordTimeFactors as Record<string, unknown> | undefined;
  return {
    disposition: String(row.mint_disposition),
    reasonCode: String(row.disposition_reason_code ?? snap?.mintReasonCode ?? '-'),
    mintStatus: String(row.mint_status ?? '-'),
    estimatedPVT: Number(row.estimatedPVT ?? 0),
    weightBps: factors?.effectiveActionWeightBps as number | undefined,
    noveltyBps: factors?.noveltyBps as number | undefined,
    attestationBps: factors?.attestationMultiplierBps as number | undefined,
    recordPointsAtomic: snap?.recordPointsAtomic as string | undefined,
  };
}

/** The externally-proven variant: a hardware-attested submission of the same act. */
async function sealProven(
  actionType: string,
  occurrenceId: string | null,
  over: Record<string, unknown> = {},
): Promise<Sealed> {
  return seal(actionType, occurrenceId, { attestationDepth: 'hardware_full', ...over });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDaily.mockResolvedValue(0);
  mockActionType.mockResolvedValue(0);
  mockResolveBeneficiary.mockResolvedValue({
    linked: false, humanWalletId: null, humanUserId: null, humanAddress: null, agentShareBps: null,
  });
  mockDb.store.clear();
  mockDb.ops.length = 0;
});

describe(' base-weight earning — a self-signed binding records AND earns the discount', () => {
  it('the verified SELF-SIGNED binding seals ELIGIBLE at the software discount (0.8x)', async () => {
    const s = await seal('agent_action', 'occ-alpha-0001');
    expect(s.disposition).toBe('eligible');
    expect(s.reasonCode).toBe('policy_eligible');
    expect(s.estimatedPVT).toBeGreaterThan(0);
    expect(s.attestationBps).toBe(8_000); // software 0.8x — the ladder's self-attested discount
    expect(s.weightBps).toBe(10_000);     // compute category, flat 1.0x weight (untouched)
    // 1e18 × 1.0 weight × 1.0 novelty × 1.0 daily × 1.0 linkage × 0.8 attestation
    expect(s.recordPointsAtomic).toBe('800000000000000000');
  });

  it('a self-signed swarm of DISTINCT occurrences EARNS in proportion — the Sybil bound is real inference cost, not a zero floor (, reverses the fuse)', async () => {
    // Each act is a first occurrence of its own type (ordinal 1) and pays the full
    // 0.8x; volume never zeroes it. The swarm is not capped — it pays real
    // inference cost per act, which with the per-device daemon IS the bound. RED
    // control for this block: set the evidence-priced software tier back to 0 and
    // every assertion here reddens while the proven-path pins below stay green.
    for (const daily of [0, 49, 50, 1_000_000] as const) {
      // Each independent volume fixture starts at ordinal 1. Distinct occurrences of the
      // SAME type in one fixture now correctly advance the durable novelty counter.
      for (const k of mockDb.store.keys()) if (k.startsWith(NOVELTY_COUNTERS_COLLECTION + '/')) mockDb.store.delete(k);
      mockActionType.mockResolvedValue(0);
      mockDaily.mockResolvedValue(daily);
      const s = await seal('agent_work_product_code', `occ-swarm-${daily}`);
      expect(s.disposition).toBe('eligible');
      expect(s.estimatedPVT).toBeGreaterThan(0);
      expect(s.recordPointsAtomic).toBe('800000000000000000'); // 0.8x, volume-flat
    }
  });

  // SAFETY : a BARE submission — no binding, no verified evidence — must
  // still pay 0. This fence is UNCHANGED by without a server-stamped
  // verified evidence state the row seals pending_evidence (the family's verifier
  // acts at record time; a bare self-report never provides it), so it never
  // reaches eligible and mints nothing. The floor here is the EVIDENCE gate, not
  // the attestation tier — un-zeroing the software discount does not revalue it.
  it('SAFETY: a bare compute_or_work submission (no binding, no verified evidence) pays 0', async () => {
    const s = await seal('agent_action', null);
    expect(s.disposition).not.toBe('eligible');
    expect(s.estimatedPVT).toBe(0);
  });
});

describe(' full value on proof — externally-proven work in the SAME family is untouched', () => {
  it('a verified hardware-backed act mints at its lane tier without an App Attest lift', async () => {
    const s = await sealProven('agent_action', 'occ-hw-0001');
    expect(s.disposition).toBe('eligible');
    expect(s.reasonCode).toBe('policy_eligible');
    expect(s.weightBps).toBe(10_000); // compute category, flat 1.0x
    // FULL VALUE, UNCHANGED across → 10,000 bps — a proven event's
    // points are byte-identical to the value it paid before this reversal
    // (1e18 × 1.0 weight × 1.0 novelty × 1.0 daily × 1.0 linkage × 1.0
    // attestation = 1 point). Proof is a lift capped at 1.0x — no hardware premium.
    expect(s.attestationBps).toBe(8_000);
    expect(s.recordPointsAtomic).toBe('800000000000000000');
    expect(s.estimatedPVT).toBeGreaterThan(0);
  });

  it('a chain-corroborated act (on_chain_verified → corroborated) prices full value too', async () => {
    const s = await seal('agent_action', 'occ-chain-0001', { attestationDepth: 'on_chain_verified' });
    expect(s.disposition).toBe('eligible');
    expect(s.attestationBps).toBe(10_000);
    expect(s.recordPointsAtomic).toBe('1000000000000000000');
  });
});

describe(' bound: occurrence mint-once (pinned on the proven path)', () => {
  it('the SAME (signer, occurrence) mints once; the replay records 0', async () => {
    const first = await sealProven('agent_action', 'occ-once-0001');
    expect(first.disposition).toBe('eligible');
    expect(first.estimatedPVT).toBeGreaterThan(0);

    const replay = await sealProven('agent_action', 'occ-once-0001');
    // Terminal no-mint dedup — the same state a commit/x402 cross-source duplicate reaches.
    expect(replay.mintStatus).toBe('corroborated_duplicate');
    expect(replay.estimatedPVT).toBe(0);
  });

  it('RED reachability: a DIFFERENT occurrence mints again (dedup is occurrence-specific)', async () => {
    const a = await sealProven('agent_action', 'occ-distinct-A');
    const b = await sealProven('agent_action', 'occ-distinct-B');
    expect(a.estimatedPVT).toBeGreaterThan(0);
    expect(b.estimatedPVT).toBeGreaterThan(0);
    expect(b.mintStatus).not.toBe('corroborated_duplicate');
  });
});

describe('no volume bound — volume never zeroes PROVEN sovereign work', () => {
  it('the 51st (and the millionth) qualifying act mints exactly like the 50th', async () => {
    mockDaily.mockResolvedValue(49); // dailyCount 49 → this is the 50th act of the day
    const ok = await sealProven('agent_action', 'occ-cap-ok');
    expect(ok.disposition).toBe('eligible');
    expect(ok.estimatedPVT).toBeGreaterThan(0);

    for (const k of mockDb.store.keys()) if (k.startsWith(NOVELTY_COUNTERS_COLLECTION + '/')) mockDb.store.delete(k);
    mockDaily.mockResolvedValue(50); // the 51st — formerly terminal-zero under
    const beyond = await sealProven('agent_action', 'occ-cap-over');
    expect(beyond.disposition).toBe('eligible');
    expect(beyond.estimatedPVT).toBe(ok.estimatedPVT);

    for (const k of mockDb.store.keys()) if (k.startsWith(NOVELTY_COUNTERS_COLLECTION + '/')) mockDb.store.delete(k);
    mockDaily.mockResolvedValue(1_000_000); // far beyond any former ceiling
    const extreme = await sealProven('agent_action', 'occ-cap-extreme');
    expect(extreme.disposition).toBe('eligible');
    expect(extreme.estimatedPVT).toBe(ok.estimatedPVT);
  });
});

describe(' bound: novelty decays by occurrence ordinal, weight does NOT', () => {
  it('ordinal 1 pays full novelty; the 4th same-type occurrence pays the floor', async () => {
    mockActionType.mockResolvedValue(0); // occurrenceOrdinal = 1
    const first = await sealProven('agent_action', 'occ-novel-1');
    // Carry a real existing count of 3; Redis's mocked next read is now only a mirror.
    for (const [k,v] of mockDb.store) if (k.startsWith(NOVELTY_COUNTERS_COLLECTION + '/')) mockDb.store.set(k, { ...v, count: 3 });
    mockActionType.mockResolvedValue(3); // occurrenceOrdinal = 4
    const fourth = await sealProven('agent_action', 'occ-novel-4');

    expect(first.noveltyBps).toBe(10_000);
    expect(fourth.noveltyBps).toBe(3_000); // ordinaryNoveltyBps floor
    expect(fourth.estimatedPVT).toBeLessThan(first.estimatedPVT);

    // Weight is FLAT — volume never raises it (the only volume effect is novelty).
    expect(first.weightBps).toBe(10_000);
    expect(fourth.weightBps).toBe(10_000);
  });
});
