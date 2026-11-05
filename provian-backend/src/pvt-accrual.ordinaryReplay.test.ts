/**
 * activation P4 / regression: an ORDINARY best-effort accrual that dies between
 * the pe_history seal and its derived-effect block must be COMPLETABLE by a bare
 * re-fire of recordPEAccrual, exactly once, with the wallet aggregates applied —
 * and doing so must NOT reclassify the caller as durable or perturb the sealed
 * economic snapshot, and must never mint.
 *
 * This is the jest-suite counterpart to scripts/wp12-ordinary-intake-canary.ts
 * (which proves the same property end-to-end against the Firestore emulator).
 * Here the crash is injected deterministically at the `after_pe_history`
 * boundary via `durableTestCrashAt`, and replay is the exact production shape:
 * recordPEAccrual with NO throwOnError.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { FakeFirestore } from './core/pvt/__test-helpers__/fake-firestore';

// Realistic fake Firestore singleton shared by recordPEAccrual + writePEHistory
// + resumeDurableAccrualEffects, so the co-committed pvt_accrual_effects outbox
// is a real document the replay can consume.
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

const incrementHourlyPECount = jest.fn<(...a: unknown[]) => Promise<void>>();
jest.mock('./cache', () => ({
  __esModule: true,
  cache: {
    getUserDailyPECountStrict: async () => 0,
    getUserActionTypeCountStrict: async () => 0,
    isArtifactHashSeen: async () => false,
    recordArtifactHash: async () => undefined,
    incrementHourlyPECount: (...a: unknown[]) => incrementHourlyPECount(...a),
    commitPEAccountingCountersOnce: async () => ({ idempotent: false }),
    isEnabled: () => true,
  },
  CacheUnavailableError: class CacheUnavailableError extends Error {},
}));

jest.mock('./core/pvt/beneficiary', () => ({
  __esModule: true,
  resolveBeneficiary: async () => ({
    linked: false,
    humanWalletId: null,
    humanUserId: null,
    humanAddress: null,
    agentShareBps: null,
  }),
}));

jest.mock('./core/jurisdiction/jurisdiction-policy', () => ({
  __esModule: true,
  getJurisdictionPolicy: async () => 'immediate',
}));

jest.mock('./core/pvt/delegation-pe', () => ({
  __esModule: true,
  isDelegationQualifying: () => false,
  createDelegationPE: async () => undefined,
}));

const recordActionTypeObservation = jest.fn<(...a: unknown[]) => Promise<void>>();
jest.mock('./core/provenance/pe-type-catalog', () => ({
  __esModule: true,
  recordActionTypeObservation: (...a: unknown[]) => recordActionTypeObservation(...a),
  getCategoryForActionType: async () => 'agent',
}));

jest.mock('./core/foundation-membership/client', () => ({
  __esModule: true,
  loadFoundationMembershipConfig: () => ({ enabled: false }),
  queueInitialMembershipGrants: async () => undefined,
}));

import { recordPEAccrual } from './pvt-accrual';

const USER = 'agent_ordinary_replay';
const WALLET_KEY = `wallets/wallet_${USER}`;

type Row = Record<string, unknown>;
const peHistory = (peId: string): Row | undefined => mockDb.store.get(`pe_history/${peId}`);
const outbox = (peId: string): Row | undefined => mockDb.store.get(`pvt_accrual_effects/${peId}`);
const wallet = (): Row | undefined => mockDb.store.get(WALLET_KEY);

function seedWallet(): void {
  mockDb.store.set(WALLET_KEY, {
    user_id: USER,
    agent_id: USER,
    address: '0x00000000000000000000000000000000000000aa',
    owner_type: 'human',
  });
}

function params(peId: string, over: Record<string, unknown> = {}) {
  return {
    peId,
    userId: USER,
    actionType: 'agent_authorization',
    integrationSource: 'pvt_accrual_ordinary_replay_test',
    attestationDepth: 'software',
    peHash: `hash_${peId}`,
    timestamp: Date.UTC(2026, 6, 4, 12, 0),
    jurisdiction_context: 'US',
    // ORDINARY best-effort: throwOnError intentionally unset.
    ...over,
  } as Parameters<typeof recordPEAccrual>[0];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.store.clear();
  mockDb.ops.length = 0;
  seedWallet();
});

describe('ordinary accrual crash/replay completeness ', () => {
  it('a crash after the pe_history seal is completable by a bare re-fire, applying the wallet aggregates', async () => {
    const peId = 'pe_crash_after_seal';

    // Crash the ordinary accrual right after the pe_history seal, before the
    // derived-effect block. The ordinary lane swallows the injected throw.
    await recordPEAccrual(params(peId, { durableTestCrashAt: 'after_pe_history' }));

    // The PE is sealed and the outbox co-committed, but the effect is NOT yet
    // applied — this is exactly the state the pre-fix code could never recover.
    expect(peHistory(peId)).toBeDefined();
    expect(outbox(peId)).toBeDefined();
    expect((outbox(peId) as Row).state).toBe('pending');
    expect((wallet() as Row).pe_count).toBeUndefined();
    expect((wallet() as Row).pvt_earned).toBeUndefined();

    // Replay is the production shape: recordPEAccrual with no throwOnError.
    await recordPEAccrual(params(peId));

    expect((wallet() as Row).pe_count).toBe(1);
    expect((wallet() as Row).pvt_earned).toBe(0);
    expect((outbox(peId) as Row).state).toBe('complete');
  });

  it('replaying a fully-applied accrual is a no-op (idempotent)', async () => {
    const peId = 'pe_clean_then_replay';

    await recordPEAccrual(params(peId));
    expect((wallet() as Row).pe_count).toBe(1);
    expect((outbox(peId) as Row).state).toBe('complete');

    // Re-fire the identical params: the "pe_history exists" guard resumes an
    // already-complete outbox, which is a no-op.
    await recordPEAccrual(params(peId));
    await recordPEAccrual(params(peId));

    expect((wallet() as Row).pe_count).toBe(1);
    expect((wallet() as Row).pvt_earned).toBe(0);
    // The fuzzy 24h display counter is bumped once, on first application only.
    expect(incrementHourlyPECount).toHaveBeenCalledTimes(1);
  });

  it('double-replay after a crash never double-applies', async () => {
    const peId = 'pe_crash_double_replay';

    await recordPEAccrual(params(peId, { durableTestCrashAt: 'after_pe_history' }));
    await recordPEAccrual(params(peId)); // replay 1 → applies
    await recordPEAccrual(params(peId)); // replay 2 → no-op
    await recordPEAccrual(params(peId)); // replay 3 → no-op

    expect((wallet() as Row).pe_count).toBe(1);
    expect((wallet() as Row).pvt_earned).toBe(0);
    expect(incrementHourlyPECount).toHaveBeenCalledTimes(1);
  });

  it('stays ordinary: sealed disposition is record_only, zero-valued, and never mints', async () => {
    const peId = 'pe_stays_ordinary';

    await recordPEAccrual(params(peId));

    const hist = peHistory(peId) as Row;
    expect(hist.mint_status).toBe('record_only');
    expect(hist.mint_disposition).toBe('record_only');
    expect(hist.disposition_reason_code).toBe('policy_record_only');
    expect(hist.estimatedPVT).toBe(0);
    // The outbox is a SEPARATE document, not a field of the sealed pe_history
    // row, so it cannot perturb the sealed economic_snapshot_hash.
    expect(hist.durable_accrual_effect).toBeUndefined();
    const snap = hist.economic_snapshot as { mintDisposition?: string; recordPointsAtomic?: string } | null;
    expect(snap?.mintDisposition).toBe('record_only');

    const ob = outbox(peId) as Row;
    const payload = ob.payload as { estimatedPvt?: number; agentPvt?: number; humanPvt?: number; redisCountersRequired?: boolean };
    expect(payload.estimatedPvt).toBe(0);
    expect(payload.agentPvt).toBe(0);
    expect(payload.humanPvt).toBe(0);
    // Record-only ⇒ never consumes Redis rate/novelty/cap authority on replay.
    expect(payload.redisCountersRequired).toBe(false);
    // No mint: the wallet earns zero PVT.
    expect((wallet() as Row).pvt_earned).toBe(0);
  });

  it('fail-closed: a sealed PE with NO co-committed outbox leaves state untouched (never guesses an effect)', async () => {
    const peId = 'pe_legacy_no_outbox';

    // Simulate a legacy PE sealed BEFORE the intake/outbox existed: pe_history
    // present, no pvt_accrual_effects row. A replay must not fabricate effects.
    mockDb.store.set(`pe_history/${peId}`, {
      peId,
      userId: USER,
      actionType: 'agent_authorization',
      timestamp: Date.UTC(2026, 6, 4, 12, 0),
      mint_status: 'record_only',
    });

    await recordPEAccrual(params(peId));

    expect(outbox(peId)).toBeUndefined();
    expect((wallet() as Row).pe_count).toBeUndefined();
    expect((wallet() as Row).pvt_earned).toBeUndefined();
    expect(incrementHourlyPECount).not.toHaveBeenCalled();
  });
});
