/**
 * device-witnessed compute HARD per-occurrence mint-once (the residual
 * (b) fix).
 *
 * Build A ('0ebb1363') made the body-bound device-witnessed compute families
 * (compute_session / inference_session / agent_tool_orchestration /
 * agent_api_orchestration) MINT, but dedup'd them with ONLY the SOFT
 * per-UTC-day artifact-novelty claim. That claim sets `uniqueArtifact`, never
 * `exactDuplicate`, and `noveltyBps` floors at 3,000 bps (0.3x) — so an identical
 * body-bound replay minted AGAIN (decayed, never zero), and the day scope reset
 * the novelty every UTC day. That is the operator’s option (b): a replayed identical
 * body-bound submission can mint more than once. The sovereign path does
 * not have this — it carries a HARD `occurrence` claim keyed on the canonical
 * event, so a replay records 0. This suite pins the fix that gives the
 * device families the same hard mint-once via the new `device_occurrence` claim.
 *
 * RED negative control, IN-SUITE and PERMANENT: the final block feeds the
 * PRE-FIX construction — a device-witnessed submission carrying ONLY
 * `artifact_hash` (no `deviceWitnessedOccurrenceHash`, exactly Build A) — and
 * asserts the replay STILL mints and is NOT `corroborated_duplicate`. That block
 * is the hole this fix closes; it is green here to prove the fix's own
 * assertions above are not vacuous (remove the `device_occurrence` wiring and the
 * "replay records 0" pins redden while this control stays green).
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { createHash } from 'crypto';
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

const DAY1 = Date.UTC(2026, 7, 10, 12, 0);
const DAY2 = Date.UTC(2026, 7, 11, 12, 0); // a DIFFERENT UTC day → the artifact scope resets
let seq = 0;

interface Sealed {
  disposition: string;
  mintStatus: string;
  estimatedPVT: number;
  exactDuplicate: boolean | undefined;
  uniqueArtifact: boolean | undefined;
}

function canonical(actionType: string, eventId: string): string {
  return `${actionType}:${eventId}`;
}
function canonicalHash(actionType: string, eventId: string): string {
  return createHash('sha256').update(canonical(actionType, eventId)).digest('hex');
}

/**
 * Seal a BODY-BOUND device-witnessed compute PE. `withHardClaim=false` reproduces
 * the PRE-FIX Build A construction (artifact_hash only, no device_occurrence).
 */
async function seal(
  actionType: string,
  eventId: string,
  opts: { withHardClaim?: boolean; timestamp?: number } = {},
): Promise<Sealed> {
  const withHardClaim = opts.withHardClaim ?? true;
  const peId = `pe_dev_${seq++}`;
  const hash = canonicalHash(actionType, eventId);
  await recordPEAccrual({
    peId,
    userId: 'human1',
    actionType,
    integrationSource: 'device_pe_submit_test',
    attestationDepth: 'software', // bearer daemon → software 0.8x (SE is a lift, never required)
    peHash: `h_${peId}`,
    timestamp: opts.timestamp ?? DAY1,
    deviceAttestationId: `dev_${peId}`,
    // The device-witnessed verified overlay's output (device body-binding IS the
    // record-time verifier). throwOnError forces the durable seal, mirroring the
    // route's durableViaOrdinaryIntake without an intake-row fixture.
    economicEvidenceState: 'verified',
    economicCanonicalEventId: canonical(actionType, eventId),
    artifact_hash: hash,
    ...(withHardClaim ? { deviceWitnessedOccurrenceHash: hash } : {}),
    throwOnError: true,
  } as Parameters<typeof recordPEAccrual>[0]);
  const row = mockDb.store.get(`pe_history/${peId}`) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`no pe_history row for ${actionType}/${eventId}`);
  const snap = row.economic_snapshot as Record<string, unknown> | null;
  const factors = snap?.recordTimeFactors as Record<string, unknown> | undefined;
  return {
    disposition: String(row.mint_disposition),
    mintStatus: String(row.mint_status ?? '-'),
    estimatedPVT: Number(row.estimatedPVT ?? 0),
    exactDuplicate: factors?.exactDuplicate as boolean | undefined,
    uniqueArtifact: factors?.uniqueArtifact as boolean | undefined,
  };
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
  seq = 0;
});

describe(' device_occurrence hard mint-once — a body-bound device-witnessed compute PE mints once per canonical event', () => {
  it('the FIRST body-bound submission seals ELIGIBLE and mints (software 0.8x discount)', async () => {
    const s = await seal('compute_session', 'session-alpha-0001');
    expect(s.disposition).toBe('eligible');
    expect(s.mintStatus).toBe('eligible');
    expect(s.estimatedPVT).toBeGreaterThan(0);
    expect(s.exactDuplicate).toBe(false);
  });

  it('a REPLAY of the identical canonical event records 0 (corroborated_duplicate) — the hole is closed', async () => {
    const first = await seal('agent_tool_orchestration', 'trace-once-0001');
    expect(first.disposition).toBe('eligible');
    expect(first.estimatedPVT).toBeGreaterThan(0);

    const replay = await seal('agent_tool_orchestration', 'trace-once-0001');
    // Terminal no-mint dedup — the same state a sovereign occurrence / commit
    // cross-witness duplicate reaches. The sealed snapshot carries exactDuplicate.
    expect(replay.mintStatus).toBe('corroborated_duplicate');
    expect(replay.estimatedPVT).toBe(0);
    expect(replay.exactDuplicate).toBe(true);
  });

  it('the hard block holds ACROSS UTC DAYS — the artifact-novelty scope resets, the device_occurrence claim does not', async () => {
    const first = await seal('inference_session', 'sess-crossday', { timestamp: DAY1 });
    expect(first.estimatedPVT).toBeGreaterThan(0);

    // Next UTC day: the per-day artifact-novelty claim is a fresh owner
    // (uniqueArtifact would be true), but the permanent device_occurrence claim is
    // still a duplicate — so the replay is exactDuplicate and mints 0. This is the
    // cross-day case the SOFT artifact claim alone could never block.
    const nextDay = await seal('inference_session', 'sess-crossday', { timestamp: DAY2 });
    expect(nextDay.mintStatus).toBe('corroborated_duplicate');
    expect(nextDay.estimatedPVT).toBe(0);
    expect(nextDay.exactDuplicate).toBe(true);
  });

  it('RED reachability: a DIFFERENT canonical event mints again (dedup is per-occurrence, not a blanket zero)', async () => {
    const a = await seal('agent_api_orchestration', 'trace-distinct-A');
    const b = await seal('agent_api_orchestration', 'trace-distinct-B');
    expect(a.estimatedPVT).toBeGreaterThan(0);
    expect(b.estimatedPVT).toBeGreaterThan(0);
    expect(b.mintStatus).not.toBe('corroborated_duplicate');
  });

  it('same event, DIFFERENT actor is not a duplicate — the claim is keyed on the economic actor', async () => {
    const first = await seal('compute_session', 'sess-shared');
    expect(first.estimatedPVT).toBeGreaterThan(0);
    // A second actor's identical canonical event is that actor's own first
    // occurrence (distinct work under a distinct daemon), so it mints.
    const peId = `pe_dev_${seq++}`;
    const hash = canonicalHash('compute_session', 'sess-shared');
    await recordPEAccrual({
      peId, userId: 'human2', actionType: 'compute_session',
      integrationSource: 'device_pe_submit_test', attestationDepth: 'software',
      peHash: `h_${peId}`, timestamp: DAY1, deviceAttestationId: `dev_${peId}`,
      economicEvidenceState: 'verified', economicCanonicalEventId: canonical('compute_session', 'sess-shared'),
      artifact_hash: hash, deviceWitnessedOccurrenceHash: hash, throwOnError: true,
    } as Parameters<typeof recordPEAccrual>[0]);
    const row = mockDb.store.get(`pe_history/${peId}`) as Record<string, unknown>;
    expect(String(row.mint_status)).not.toBe('corroborated_duplicate');
    expect(Number(row.estimatedPVT)).toBeGreaterThan(0);
  });
});

describe(' RED NEGATIVE CONTROL — the PRE-FIX Build A construction (artifact_hash only) does NOT block a replay', () => {
  it('WITHOUT the device_occurrence claim, a same-day replay of the identical canonical event STILL mints and is NOT corroborated_duplicate (the hole)', async () => {
    const first = await seal('compute_session', 'sess-hole', { withHardClaim: false });
    expect(first.disposition).toBe('eligible');
    expect(first.estimatedPVT).toBeGreaterThan(0);

    // Same day, same canonical event, but ONLY the soft artifact-novelty claim:
    // the artifact claim makes it a per-day duplicate (uniqueArtifact=false), yet
    // exactDuplicate stays FALSE, so the replay MINTS AGAIN — the exact double-mint
    // this fix closes. If this control ever reddens (replay stops minting) without
    // the device_occurrence wiring, the fix's own pins above have become vacuous.
    const replay = await seal('compute_session', 'sess-hole', { withHardClaim: false });
    expect(replay.exactDuplicate).toBe(false);
    expect(replay.mintStatus).not.toBe('corroborated_duplicate');
    expect(replay.estimatedPVT).toBeGreaterThan(0);
  });
});
