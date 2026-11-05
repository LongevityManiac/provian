/**
 * Class admission on the device/mobile lanes: * the type of work is never the gate, a witness gates RECORDING, the policy setter signature gates EARNING.
 * A never-seen action type witnessed by a non-actor key now RECORDS at zero at every class — even
 * when the old class-admission overlay claims the durable intake row — and earns only once a named
 * row is signed (`pvt-accrual.newTypeIntake.acceptance.test.ts` proves the earn-from-signing side).
 * This suite drives the REAL overlay output through the REAL accrual. The final block is the
 * permanent in-suite RED control : the identical harness mints a named eligible row, so the
 * zeros are not a property of the harness.
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
import { classAdmittedWitnessedFields } from './core/pvt/class-admission-earning';
import type { WitnessClass } from './core/pvt/policy/evidence-class';

const DAY1 = Date.UTC(2026, 8, 25, 12, 0);
const NEVER_SEEN = 'water_sensor_reading_acceptance';
let seq = 0;

interface Sealed {
  disposition: string;
  estimatedPVT: number;
  exactDuplicate: boolean | undefined;
  witnessClass: unknown;
}

/**
 * Seal a never-seen type the way the device route now does: the class-admission overlay's real
 * output spread into the accrual params, at the lane's relay-assigned witness class. `durable`
 * mirrors the co-committed intake row the overlay claims (throwOnError is the fixture-free
 * stand-in the sibling acceptance suites use); `overlay:false` reproduces the pre-fix device lane.
 */
async function seal(opts: { witnessClass: WitnessClass; bodyDigest: string; overlay?: boolean; durable?: boolean; actionType?: string }): Promise<Sealed> {
  const actionType = opts.actionType ?? NEVER_SEEN;
  const peId = `pe_cls_${seq++}`;
  const overlay = (opts.overlay ?? true)
    ? classAdmittedWitnessedFields({
      actionType, classAdmitted: true, witnessClass: opts.witnessClass,
      witnessId: 'device:dev_sensor_1', bodyDigestHex: opts.bodyDigest,
    })
    : {};
  const durable = opts.durable ?? Object.keys(overlay).length > 0;
  await recordPEAccrual({
    peId,
    userId: 'human1',
    actionType,
    integrationSource: 'device_pe_submit_test',
    attestationDepth: 'software',
    peHash: `h_${peId}`,
    timestamp: DAY1,
    deviceAttestationId: 'dev_sensor_1',
    witnessClass: opts.witnessClass,
    ...overlay,
    ...(durable ? { throwOnError: true } : {}),
  } as Parameters<typeof recordPEAccrual>[0]);
  const row = mockDb.store.get(`pe_history/${peId}`) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`no pe_history row for ${peId}`);
  const snap = row.economic_snapshot as Record<string, unknown> | null;
  const factors = snap?.recordTimeFactors as Record<string, unknown> | undefined;
  return {
    disposition: String(row.mint_disposition),
    estimatedPVT: Number(row.estimatedPVT ?? 0),
    exactDuplicate: factors?.exactDuplicate as boolean | undefined,
    witnessClass: row.witness_class,
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

describe('NEW-TYPE INTAKE — a never-seen type witnessed by a non-actor key RECORDS at zero until a row is signed', () => {
  it.each(['device_tier', 'hardware_rooted', 'forge_witnessed', 'chain_witnessed', 'relay_verified'] as const)(
    '%s: record_only and 0 — even with the class overlay\'s durable claim (the witness gates recording, the signature gates earning)',
    async (cls) => {
      const s = await seal({ witnessClass: cls, bodyDigest: 'a'.repeat(64) });
      expect(s.disposition).toBe('record_only');
      expect(s.estimatedPVT).toBe(0);
      expect(s.witnessClass).toBe(cls);
    },
  );

  it('the boundary still holds: the actor\'s own declaration records at ZERO on a durable path', async () => {
    const s = await seal({ witnessClass: 'actor_declared', bodyDigest: 'f'.repeat(64), durable: true });
    expect(s.disposition).not.toBe('eligible');
    expect(s.estimatedPVT).toBe(0);
  });
});

describe('RED NEGATIVE CONTROL — the same harness DOES mint a named eligible row, so the zeros above are not vacuous', () => {
  it('a named eligible witness-class row (human_approval) through the identical overlay + durable path seals ELIGIBLE, nonzero', async () => {
    const s = await seal({ witnessClass: 'device_tier', bodyDigest: '1'.repeat(64), actionType: 'human_approval' });
    expect(s.disposition).toBe('eligible');
    expect(s.estimatedPVT).toBeGreaterThan(0);
  });
});
