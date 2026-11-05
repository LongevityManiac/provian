/**
 * F-A2-3 — institution pricing, driven through the REAL accrual for EVERY
 * lifecycle type, not just one funding + one completion representative.
 *
 * The seven institution pricing types share a byte-identical matrix row
 * (`mint_disposition: eligible`, `canonical_event_group: institution_lifecycle_
 * event`, `session_lineage_policy: optional`, `evidence_resolution_mode:
 * projection_with_verified_evidence`). Before this suite only `promise_funded`
 * (of 3 funding types) and `escrow_completed` (of 4 completion types) were ever
 * driven through the real `recordPEAccrual` to assert `eligible`; the other five
 * rested on structural identity. Per the operator’s negative-control doctrine an
 * untested pricing path is weak evidence, so this suite drives ALL SEVEN through
 * the real pipeline against a fake Firestore.
 *
 * Each type ships its RED negative control in-suite: the SAME row WITHOUT the
 * trusted-verifier `verified` stamp seals `pending_evidence` and prices 0 — so
 * the `eligible` verdict is proven to be EARNED by the stamp, never a vacuous
 * pass of a structurally-eligible row.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import type { BeneficiaryCacheEntry } from './beneficiary';
import { ORDINARY_ACCRUAL_REPLAY_SOURCE } from './wp11/ordinary-accrual-intake';

let mockDb: FakeFirestore;
jest.mock('firebase-admin', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createFakeFirestore: mk } = require('./__test-helpers__/fake-firestore');
  const db = mk();
  mockDb = db;
  const firestore = Object.assign(() => db, {
    FieldValue: { increment: (n: number) => ({ __increment: n }) },
  });
  return { __esModule: true, default: { firestore }, firestore };
});
jest.mock('../../cache', () => ({
  cache: {
    getUserDailyPECountStrict: jest.fn(async () => 0),
    getUserActionTypeCountStrict: jest.fn(async () => 0),
    isArtifactHashSeen: async () => false,
    recordArtifactHash: async () => {},
    incrementUserActionTypeCount: jest.fn(async () => 1),
    incrementHourlyPECount: jest.fn(async () => {}),
    commitPEAccountingCountersOnce: jest.fn(async () => ({ idempotent: false })),
  },
  CacheUnavailableError: class CacheUnavailableError extends Error {},
}));
const mockResolveBeneficiary = jest.fn<(...a: unknown[]) => Promise<BeneficiaryCacheEntry>>(async () => ({
  linked: false, humanWalletId: null, humanUserId: null, humanAddress: null, agentShareBps: null,
}));
jest.mock('./beneficiary', () => ({ resolveBeneficiary: mockResolveBeneficiary }));
jest.mock('../jurisdiction/jurisdiction-policy', () => ({ getJurisdictionPolicy: async () => 'immediate' }));
jest.mock('./delegation-pe', () => ({ isDelegationQualifying: () => false, createDelegationPE: async () => {} }));
jest.mock('../provenance/pe-type-catalog', () => ({
  getCategoryForActionType: async () => 'institutional',
  recordActionTypeObservation: async () => {},
}));
jest.mock('../foundation-membership/client', () => ({
  loadFoundationMembershipConfig: () => ({ enabled: false }),
  queueInitialMembershipGrants: async () => {},
}));

// eslint-disable-next-line import/first
import { recordPEAccrual, type RecordPEAccrualParams } from '../../pvt-accrual';
// eslint-disable-next-line import/first
import {
  ORDINARY_ACCRUAL_INTAKE_COLLECTION,
  buildOrdinaryAccrualIntake,
} from './wp11/ordinary-accrual-intake';
// eslint-disable-next-line import/first
import { PVT9_ELIGIBILITY_CUT_LINE_MS } from './wp-ev/eligibility';

/** Post cut-line, so the row is not fenced out as legacy. */
const T0 = PVT9_ELIGIBILITY_CUT_LINE_MS + 10 * 24 * 60 * 60 * 1000;
const EARNER = 'agent_earner';
const EARNER_ADDR = `0x${'a1'.repeat(20)}`;
const COUNTERPARTY_ADDR = `0x${'b2'.repeat(20)}`;

// All eight institution pricing types the matrix prices `eligible`, split by leg.
// added `escrow_disputed` to the completion leg (chain-witnessed dispute,
// parity with escrow_resolved).
const FUNDING_TYPES = ['promise_funded', 'escrow_funded', 'pool_contributed'] as const;
const COMPLETION_TYPES = ['escrow_completed', 'escrow_resolved', 'escrow_disputed', 'promise_settled', 'pool_executed'] as const;
const ALL_TYPES = [...FUNDING_TYPES, ...COMPLETION_TYPES] as const;

interface PeRow {
  mint_status: string;
  mint_disposition: string;
  estimatedPVT: number;
  economic_snapshot: { recordPointsAtomic: string } | null;
}

/** The verified chain-finality shape a watcher's emit seals (per type). */
function institutionParams(
  actionType: string,
  over: Partial<RecordPEAccrualParams> = {},
): RecordPEAccrualParams {
  const peId = `pe_${actionType}`;
  // A distinct log-granular canonical event id per type (chainId:txHash:logIndex).
  const txHash = `0x${actionType.padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, '0')}`;
  return {
    peId,
    userId: EARNER,
    actionType,
    integrationSource: 'agent_bank_generate_pe',
    attestationDepth: 'software',
    peHash: `h_${peId}`,
    timestamp: T0,
    durableReplaySource: ORDINARY_ACCRUAL_REPLAY_SOURCE,
    economicEvidenceState: 'verified',
    economicCanonicalEventId: `8453:${txHash}:0`,
    counterpartyAddress: COUNTERPARTY_ADDR,
    walletAddress: EARNER_ADDR,
    ownerType: 'agent',
    ...over,
  } as RecordPEAccrualParams;
}

function row(peId: string): PeRow {
  const r = mockDb.store.get(`pe_history/${peId}`) as PeRow | undefined;
  if (!r) throw new Error(`no pe_history row for ${peId}`);
  return r;
}

async function seal(params: RecordPEAccrualParams): Promise<PeRow> {
  const doc = buildOrdinaryAccrualIntake({
    prevHash: `prev_${params.peId}`, peHash: params.peHash, accrualParams: params,
  });
  mockDb.store.set(`${ORDINARY_ACCRUAL_INTAKE_COLLECTION}/${params.peId}`, { ...doc });
  await recordPEAccrual(params);
  return row(params.peId);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.store.clear();
  mockDb.ops.length = 0;
});

describe('F-A2-3 — every institution pricing type prices eligible through the REAL accrual', () => {
  it.each(ALL_TYPES.map((t) => [t]))(
    '%s seals eligible with a verified stamp + canonical event id + durable inlet',
    async (actionType) => {
      const r = await seal(institutionParams(actionType));
      expect(r.mint_status).toBe('eligible');
      expect(r.mint_disposition).toBe('eligible');
      expect(r.estimatedPVT).toBeGreaterThan(0);
      expect(BigInt(r.economic_snapshot?.recordPointsAtomic ?? '0')).toBeGreaterThan(0n);
    },
  );

  it.each(ALL_TYPES.map((t) => [t]))(
    'RED control — %s WITHOUT the verified stamp is NOT eligible (prices 0)',
    async (actionType) => {
      const r = await seal(institutionParams(actionType, { economicEvidenceState: undefined }));
      // The stamp is what earns `eligible`; without it the row holds and prices 0.
      expect(r.mint_status).not.toBe('eligible');
      expect(r.mint_disposition).not.toBe('eligible');
      expect(r.estimatedPVT).toBe(0);
    },
  );

  it('the population is the full EIGHT (no empty-set vacuous pass)', () => {
    // added escrow_disputed to the completion leg (5th completion type).
    expect(new Set(ALL_TYPES).size).toBe(8);
    expect(FUNDING_TYPES).toHaveLength(3);
    expect(COMPLETION_TYPES).toHaveLength(5);
  });
});
