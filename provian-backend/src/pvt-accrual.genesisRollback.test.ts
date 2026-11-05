/**
 * PVT9 retirement guard for the old rollback seam. A caller-supplied raw fixed
 * estimate and `isGenesisGrant` flag can no longer create value or manipulate
 * the legacy pool ledger. Current Genesis value exists only in the exact
 * reservation-bound snapshot and a valid reservation is never rolled back.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock cache before importing the unit under test.
class CacheUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CacheUnavailableError';
  }
}

const mockCache = {
  isEnabled: jest.fn<() => boolean>(),
  getUserDailyPECountStrict: jest.fn<(u: string) => Promise<number>>(),
  getUserActionTypeCountStrict: jest.fn<(u: string, a: string) => Promise<number>>(),
  isArtifactHashSeen: jest.fn<(u: string, h: string) => Promise<boolean>>(),
  recordArtifactHash: jest.fn<(u: string, h: string) => Promise<void>>(),
  incrementUserActionTypeCount: jest.fn<(u: string, a: string) => Promise<void>>(),
  incrementHourlyPECount: jest.fn<() => Promise<void>>(),
};

jest.mock('./cache', () => ({
  __esModule: true,
  cache: mockCache,
  CacheUnavailableError,
}));

// Mock writePEHistory so we control the new-vs-duplicate decision (didWrite).
const writePEHistoryMock = jest.fn<(...args: unknown[]) => Promise<boolean>>();
jest.mock('./pe-history', () => ({
  __esModule: true,
  writePEHistory: writePEHistoryMock,
}));

// Device rate limiter: permissive — we drive suppression via the user/cache
// branches so the genesis event type itself never trips a device limit.
jest.mock('./device-pe-rate-limiter', () => ({
  __esModule: true,
  isDeviceRateLimited: () => false,
  checkDevicePERateLimit: async () => ({ allowed: true, anchor: 'unused', reason: 'ok' }),
}));

// The unit under test: assert recordPEAccrual delegates to the real
// release helper. We mock ONLY that one export of genesis-campaign so the
// seam is observable; the helper's ledger effect is covered separately
// (genesis-campaign.test.ts / genesis-milestones.test.ts) against a fake
// Firestore.
const releaseSuppressedGenesisReservationMock =
  jest.fn<(...args: unknown[]) => Promise<boolean>>();
jest.mock('./core/pvt/genesis-campaign', () => ({
  __esModule: true,
  releaseSuppressedGenesisReservation: releaseSuppressedGenesisReservationMock,
}));

// firebase-admin: enough surface for the downstream batch / counter writes.
jest.mock('firebase-admin', () => {
  const noopRef = {
    set: async () => {},
    update: async () => {},
    get: async () => ({ exists: false, data: () => ({}) }),
    collection: () => noopRef,
    doc: () => noopRef,
  };
  const noopBatch = { update: () => noopBatch, set: () => noopBatch, commit: async () => {} };
  const fs = () => ({
    collection: () => noopRef,
    doc: () => noopRef,
    batch: () => noopBatch,
    runTransaction: async (fn: (txn: unknown) => Promise<unknown>) => {
      const txn = {
        get: async () => ({ exists: false, data: () => ({}) }),
        set: () => undefined,
        update: () => undefined,
      };
      return fn(txn);
    },
  });
  return { __esModule: true, default: { firestore: fs }, firestore: fs };
});

type TestBeneficiary = {
  linked: boolean;
  humanWalletId: string | null;
  humanUserId: string | null;
  humanAddress: string | null;
  agentShareBps: number | null;
};
const mockResolveBeneficiary = jest.fn<() => Promise<TestBeneficiary>>(async () => ({
  linked: false,
  humanWalletId: null,
  humanUserId: null,
  humanAddress: null,
  agentShareBps: null,
}));
jest.mock('./core/pvt/beneficiary', () => ({
  __esModule: true,
  resolveBeneficiary: mockResolveBeneficiary,
}));

jest.mock('./core/pvt/pe-weight-framework', () => ({
  __esModule: true,
  calculatePEWeight: () => ({ estimatedPVT: 1.0 }),
  resolveOverride: async () => null,
  getEffectiveAttestationMultiplier: async () => 1.0,
  normalizeAttestationTier: (value: string) => value === 'hardware' ? 'hardware_full' : value,
}));
jest.mock('./core/provenance/pe-type-catalog', () => ({
  __esModule: true,
  getCategoryForActionType: async () => 'agent',
  recordActionTypeObservation: async () => undefined,
}));

// Defer importing the unit under test until after every mock is registered.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { recordPEAccrual } = require('./pvt-accrual') as typeof import('./pvt-accrual');

// A funded-event genesis grant: reserved 300 PVT against wallet `w1`, source
// `0xsrc` (per-source cap key). userId is the ACCRUAL identity (agent_id), which
// is deliberately different from the reservation walletId.
const genesisParams = {
  peId: 'pe_genesis_1',
  userId: 'agent_a1',
  actionType: 'agent_wallet_funded',
  integrationSource: 'pvt_accrual_genesis_rollback_test',
  attestationDepth: 'software' as const,
  peHash: 'hash_g1',
  timestamp: 1_700_000_000_000,
  fixedEstimatedPVT: 300,
  isGenesisGrant: true,
  genesisWalletId: 'w1',
  genesisFundingSourceAddress: '0xsrc',
};

describe('PVT9: legacy raw Genesis estimates cannot mint or roll back a reservation', () => {
  beforeEach(() => {
    writePEHistoryMock.mockReset();
    writePEHistoryMock.mockResolvedValue(true);
    releaseSuppressedGenesisReservationMock.mockReset();
    releaseSuppressedGenesisReservationMock.mockResolvedValue(true);
    mockCache.isEnabled.mockReturnValue(true);
    mockCache.getUserDailyPECountStrict.mockResolvedValue(0);
    mockCache.getUserActionTypeCountStrict.mockResolvedValue(0);
    mockCache.isArtifactHashSeen.mockResolvedValue(false);
    mockCache.recordArtifactHash.mockResolvedValue(undefined);
    mockCache.incrementUserActionTypeCount.mockResolvedValue(undefined);
    mockCache.incrementHourlyPECount.mockResolvedValue(undefined);
    mockResolveBeneficiary.mockResolvedValue({
      linked: false,
      humanWalletId: null,
      humanUserId: null,
      humanAddress: null,
      agentShareBps: null,
    });
  });

  it('records zero and never touches the legacy rollback seam at extreme same-day volume', async () => {
    // Was: hourly count == the 200/hour cap. The volume caps are removed, so
    // extreme volume is no longer a suppression at all — the raw legacy
    // genesis marker still prices 0 on its own, and the seam stays untouched.
    mockCache.getUserDailyPECountStrict.mockResolvedValue(1_000_000);

    await recordPEAccrual(genesisParams);

    const histArg = writePEHistoryMock.mock.calls[0][0] as { estimatedPVT: number };
    expect(histArg.estimatedPVT).toBe(0);
    expect(releaseSuppressedGenesisReservationMock).not.toHaveBeenCalled();
  });

  it('never touches the rollback seam during a Redis outage', async () => {
    mockCache.getUserDailyPECountStrict.mockRejectedValue(
      new CacheUnavailableError('Redis client not configured'),
    );
    mockCache.getUserActionTypeCountStrict.mockRejectedValue(
      new CacheUnavailableError('Redis client not configured'),
    );

    await recordPEAccrual(genesisParams);

    const histArg = writePEHistoryMock.mock.calls[0][0] as { estimatedPVT: number };
    expect(histArg.estimatedPVT).toBe(0);
    expect(releaseSuppressedGenesisReservationMock).not.toHaveBeenCalled();
  });

  it('ignores the raw fixed amount even when cache and limits are healthy', async () => {
    await recordPEAccrual(genesisParams);

    const histArg = writePEHistoryMock.mock.calls[0][0] as { estimatedPVT: number };
    expect(histArg.estimatedPVT).toBe(0);
    expect(releaseSuppressedGenesisReservationMock).not.toHaveBeenCalled();
  });

  it('does NOT release for a non-genesis suppressed PE (Redis outage)', async () => {
    // volume no longer suppresses, so the suppression trigger here is
    // the cache outage — the same non-genesis fence, different (and still
    // real) suppressor.
    mockCache.getUserDailyPECountStrict.mockRejectedValue(
      new CacheUnavailableError('Redis client not configured'),
    );

    await recordPEAccrual({
      ...genesisParams,
      isGenesisGrant: false,
      genesisWalletId: null,
      genesisFundingSourceAddress: null,
    });

    expect(releaseSuppressedGenesisReservationMock).not.toHaveBeenCalled();
  });

  it('does NOT release on a duplicate (didWrite=false) — no double-release', async () => {
    mockCache.getUserDailyPECountStrict.mockRejectedValue(
      new CacheUnavailableError('Redis client not configured'),
    ); // suppressed...
    writePEHistoryMock.mockResolvedValue(false); // ...but the PE was already recorded

    await recordPEAccrual(genesisParams);

    expect(releaseSuppressedGenesisReservationMock).not.toHaveBeenCalled();
  });

  it('does not invoke even a failing legacy rollback dependency', async () => {
    mockCache.getUserDailyPECountStrict.mockRejectedValue(
      new CacheUnavailableError('Redis client not configured'),
    );
    releaseSuppressedGenesisReservationMock.mockRejectedValue(new Error('firestore down'));

    await expect(recordPEAccrual(genesisParams)).resolves.toBeUndefined();
    expect(releaseSuppressedGenesisReservationMock).not.toHaveBeenCalled();
  });
});
