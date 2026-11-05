/**
 * pvt-accrual volume behavior + Redis-down handling.
 *
 * History of this suite:
 * - Audit Pass 2, Fix 4: per-user HOURLY/DAILY caps recorded (not dropped)
 * over-limit PEs with 0 PVT, and Redis-down stopped failing permissive.
 * - H-6 : Redis-down split off into mint_status='pending_cache'
 * (reclassifiable) vs the terminal rate-limit 'ineligible'.
 * - the daily volume bound moved from price to
 * qualification (50/day ordinal).
 * - ALL THREE per-user volume ceilings are REMOVED —
 * the 200/hour cap, the 2000/day cap, and the 50/day qualification
 * ordinal. PVT is an exponential currency: volume alone never zeroes,
 * reprices, or disqualifies an act. This suite now encodes that as the
 * invariant: an act prices IDENTICALLY at any same-day volume, and the
 * only remaining suppressions here are evidence-layer ones (Redis-down →
 * pending_cache, exact duplicates, device setup limits, per-action
 * identity anti-farm caps — none of which read volume).
 *
 * Post- behavior under test:
 * - cache unavailable: PE records with mintStatus='pending_cache'
 * (cacheUnavailable true), estimatedPVT=0. Audit row exists.
 * - any same-day volume (daily ordinal 50, 51, 2000, 1e6): the act prices
 * exactly the same as at zero volume. deviceRateLimited stays false.
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
  // Strict variants (2026-05-13): throw CacheUnavailableError on outage.
  // (the hourly counter is no longer read by accrual at all.)
  getUserDailyPECountStrict: jest.fn<(u: string) => Promise<number>>(),
  getUserActionTypeCountStrict: jest.fn<(u: string, a: string) => Promise<number>>(),
  isArtifactHashSeen: jest.fn<(u: string, h: string) => Promise<boolean>>(),
  recordArtifactHash: jest.fn<(u: string, h: string) => Promise<void>>(),
  incrementHourlyPECount: jest.fn<() => Promise<void>>(),
};

jest.mock('./cache', () => ({
  __esModule: true,
  cache: mockCache,
  CacheUnavailableError,
}));

// Mock writePEHistory so we can assert what flags it received.
const writePEHistoryMock = jest.fn<(...args: unknown[]) => Promise<boolean>>();
jest.mock('./pe-history', () => ({
  __esModule: true,
  writePEHistory: writePEHistoryMock,
}));

// This unit isolates record-time gating. Model the acknowledged durable-source
// contract without exercising the separate derived-effects state machine.
jest.mock('./core/pvt/durable-accrual-effects', () => ({
  __esModule: true,
  DURABLE_ACCRUAL_EFFECTS_COLLECTION: 'pvt_accrual_effects',
  createDurableAccrualEffect: (payload: unknown) => ({ payload }),
  resumeDurableAccrualEffects: async () => undefined,
}));

// Mock the device-pe-rate-limiter to keep it permissive (we're only testing
// the volume + Redis-down branches here; the device setup limit has its own
// suite and is NOT a volume cap).
jest.mock('./device-pe-rate-limiter', () => ({
  __esModule: true,
  isDeviceRateLimited: () => false,
  checkDevicePERateLimit: async () => ({ allowed: true, anchor: 'unused', reason: 'ok' }),
}));

// Mock firebase-admin so admin.firestore() returns enough to satisfy the
// downstream batch / counter writes. We don't assert anything about Firestore
// writes here - only on writePEHistory.
jest.mock('firebase-admin', () => {
  const noopRef = {
    set: async () => {},
    update: async () => {},
    get: async () => ({ exists: false, data: () => ({}) }),
    collection: () => noopRef,
    doc: () => noopRef,
  };
  const noopBatch = { update: () => noopBatch, set: () => noopBatch, commit: async () => {} };
  return {
    __esModule: true,
    default: {
      firestore: () => ({
        collection: () => noopRef,
        doc: () => noopRef,
        batch: () => noopBatch,
        runTransaction: async (fn: (txn: unknown) => Promise<unknown>) => {
          const txn = {
            get: async () => ({ exists: false, data: () => ({}) }),
            set: () => undefined,
            update: () => undefined,
            create: () => undefined,
          };
          return fn(txn);
        },
      }),
    },
    firestore: () => ({
      collection: () => noopRef,
      doc: () => noopRef,
      batch: () => noopBatch,
      runTransaction: async (fn: (txn: unknown) => Promise<unknown>) => {
        const txn = {
          get: async () => ({ exists: false, data: () => ({}) }),
          set: () => undefined,
          update: () => undefined,
          create: () => undefined,
        };
        return fn(txn);
      },
    }),
  };
});

type TestBeneficiary = {
  linked: boolean;
  humanWalletId: string | null;
  humanUserId: string | null;
  humanAddress: string | null;
  agentShareBps: number | null;
};

// Beneficiary resolution and category catalog calls - keep them inert by default.
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

// F-A6-1: the delegation-credit PE fires from the accrual on a qualifying
// linked-agent source (a SECOND pe_history write, into the human's chain). These
// suites isolate the beneficiary SPLIT and the rate-limit volume, not that
// credit — so stub the emit (the same isolation `durableOutbox.acceptance.test.ts`
// uses). The emit's own behaviour is proven in `pvt-accrual.delegationEmit.test.ts`.
jest.mock('./core/pvt/delegation-pe', () => ({
  __esModule: true,
  isDelegationQualifying: () => false,
  createDelegationPE: async () => {},
}));

// Some other pvt-accrual deps that read Firestore - stub them so the test
// only exercises the volume + Redis-down branches we care about.
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

const baseParams = {
  peId: 'pe_test_1',
  userId: 'user_abc',
  actionType: 'send',
  integrationSource: 'pvt_accrual_rate_limit_test',
  attestationDepth: 'software' as const,
  peHash: 'hash',
  timestamp: Date.now(),
  economicEvidenceState: 'verified' as const,
  economicCanonicalEventId: 'base:8453:0xrate-limit-test:0',
  mintValueUsd: 40,
  counterpartyAddress: '0x2222222222222222222222222222222222222222',
  throwOnError: true,
};

/** The zero-volume price every volume scenario below must match exactly. */
const ZERO_VOLUME_PRICE = 2.0;

describe('recordPEAccrual volume behavior + Redis-down', () => {
  beforeEach(() => {
    writePEHistoryMock.mockReset();
    writePEHistoryMock.mockResolvedValue(true);
    mockCache.isEnabled.mockReturnValue(true);
    mockCache.getUserDailyPECountStrict.mockResolvedValue(0);
    mockCache.getUserActionTypeCountStrict.mockResolvedValue(0);
    mockCache.isArtifactHashSeen.mockResolvedValue(false);
    mockCache.recordArtifactHash.mockResolvedValue(undefined);
    mockCache.incrementHourlyPECount.mockResolvedValue(undefined);
    mockResolveBeneficiary.mockResolvedValue({
      linked: false,
      humanWalletId: null,
      humanUserId: null,
      humanAddress: null,
      agentShareBps: null,
    });
  });

  it('records the PE in pe_history with PVT=0 and cacheUnavailable=true when Redis is disabled (H-6)', async () => {
    // H-6 (audit 2026-05-11): Redis-down used to map to deviceRateLimited
    // → mint_status='ineligible' (terminal). Now it maps to
    // cacheUnavailable → mint_status='pending_cache' (reclassifiable by
    // the pending-cache backfill scheduler).
    //
    // Post- this branch is UNCHANGED and still load-bearing: the daily
    // ordinal (sealed provenance evidence) and the per-action occurrence
    // ordinal (novelty pricing) are unreadable without Redis, so the PE
    // cannot be priced and must defer — this is an evidence hold, never a
    // volume cap.
    mockCache.getUserDailyPECountStrict.mockRejectedValue(
      new CacheUnavailableError('Redis client not configured'),
    );
    mockCache.getUserActionTypeCountStrict.mockRejectedValue(
      new CacheUnavailableError('Redis client not configured'),
    );

    await recordPEAccrual(baseParams);

    expect(writePEHistoryMock).toHaveBeenCalledTimes(1);
    const arg = writePEHistoryMock.mock.calls[0][0] as {
      estimatedPVT: number;
      deviceRateLimited: boolean;
      cacheUnavailable: boolean;
    };
    expect(arg.estimatedPVT).toBe(0);
    // Redis-down is NOT a rate limit; deviceRateLimited stays false.
    expect(arg.deviceRateLimited).toBe(false);
    // cacheUnavailable is the flag; pe-history maps it to pending_cache.
    expect(arg.cacheUnavailable).toBe(true);
  });

  it('records the PE with cacheUnavailable=true when a transient Redis error throws mid-call (strict-counter follow-up)', async () => {
    // The original Fix 4 caught only the unconfigured case via isEnabled().
    // A transient runtime error during get() would silently return 0 and let
    // accrual proceed at full PVT against a stale view. The strict variants
    // throw on those errors and the caller routes to pending_cache.
    mockCache.getUserDailyPECountStrict.mockRejectedValue(
      new CacheUnavailableError('getUserDailyPECount failed: ECONNRESET'),
    );

    await recordPEAccrual(baseParams);

    expect(writePEHistoryMock).toHaveBeenCalledTimes(1);
    const arg = writePEHistoryMock.mock.calls[0][0] as {
      estimatedPVT: number;
      deviceRateLimited: boolean;
      cacheUnavailable: boolean;
    };
    expect(arg.estimatedPVT).toBe(0);
    expect(arg.deviceRateLimited).toBe(false);
    expect(arg.cacheUnavailable).toBe(true);
  });

  it('records the PE normally when the cache is healthy and the user is at zero volume', async () => {
    await recordPEAccrual(baseParams);

    expect(writePEHistoryMock).toHaveBeenCalledTimes(1);
    const arg = writePEHistoryMock.mock.calls[0][0] as {
      estimatedPVT: number;
      deviceRateLimited: boolean;
    };
    expect(arg.estimatedPVT).toBe(ZERO_VOLUME_PRICE);
    expect(arg.deviceRateLimited).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // the three per-user volume ceilings are REMOVED. The invariant is
  // price/qualification FLATNESS across volume: every scenario below must
  // produce EXACTLY the zero-volume outcome. Each ordinal is a former
  // boundary: 50 (the qualification limit), 51 (first formerly-terminal
  // ordinal), 200 (former hourly cap), 2000 (former daily cap), 1e6 (far
  // beyond any former ceiling).
  //
  // NEGATIVE CONTROL : these tests were proven RED against the
  // pre- kernel by temporarily restoring the removed gate (hourly/daily/
  // ordinal refusal in pvt-accrual.ts) and observing every ordinal >= 50
  // seal 0 PVT with deviceRateLimited=true; the gate was then removed again
  // byte-identical. The Redis-down tests above are the standing in-suite
  // control that this harness CAN observe a suppressed (0-PVT) outcome — a
  // hard-wired "always 2.0" accrual would fail them.
  // ---------------------------------------------------------------------------

  for (const priorToday of [49, 50, 51, 200, 2000, 1_000_000]) {
    it(`at ${priorToday} prior same-day events the act pays FULL — no cap, no cut, not terminal`, async () => {
      mockCache.getUserDailyPECountStrict.mockResolvedValue(priorToday);

      await recordPEAccrual(baseParams);

      expect(writePEHistoryMock).toHaveBeenCalledTimes(1);
      const arg = writePEHistoryMock.mock.calls[0][0] as {
        estimatedPVT: number;
        deviceRateLimited: boolean;
        cacheUnavailable: boolean;
        economic_snapshot: { recordTimeFactors: { dailyOrdinal: number } } | null;
      };
      expect(arg.estimatedPVT).toBe(ZERO_VOLUME_PRICE);
      expect(arg.deviceRateLimited).toBe(false);
      expect(arg.cacheUnavailable).toBe(false);
      // The ordinal is still sealed as truthful provenance evidence — the
      // counter records, it just never limits.
      expect(arg.economic_snapshot?.recordTimeFactors.dailyOrdinal).toBe(priorToday + 1);
    });
  }

  it('does not let a legacy raw fixedEstimatedPVT override the sealed policy snapshot (at any volume)', async () => {
    mockCache.getUserDailyPECountStrict.mockResolvedValue(5_000);

    await recordPEAccrual({ ...baseParams, fixedEstimatedPVT: 1500 });

    expect(writePEHistoryMock).toHaveBeenCalledTimes(1);
    const arg = writePEHistoryMock.mock.calls[0][0] as {
      estimatedPVT: number;
      fixed_estimated_pvt_override: boolean;
      is_genesis_grant: boolean;
    };
    expect(arg.estimatedPVT).toBe(ZERO_VOLUME_PRICE);
    expect(arg.fixed_estimated_pvt_override).toBe(false);
    expect(arg.is_genesis_grant).toBe(false);
  });

  it('applies the linked-beneficiary split for ordinary earned PEs', async () => {
    mockResolveBeneficiary.mockResolvedValue({
      linked: true,
      humanWalletId: 'wallet_human_1',
      humanUserId: 'human_1',
      humanAddress: '0x1111111111111111111111111111111111111111',
      agentShareBps: 2_000,
    });

    await recordPEAccrual(baseParams);

    expect(writePEHistoryMock).toHaveBeenCalledTimes(1);
    const arg = writePEHistoryMock.mock.calls[0][0] as {
      pvt_split: { total: number; agent_share: number; human_share: number; ratio: number } | null;
    };
    expect(arg.pvt_split).toEqual({
      total: 4,
      agent_share: 0.8,
      human_share: 3.2,
      ratio: 0.2,
    });
  });

  it('does not let a raw isGenesisGrant flag bypass ordinary beneficiary routing', async () => {
    mockResolveBeneficiary.mockResolvedValue({
      linked: true,
      humanWalletId: 'wallet_human_1',
      humanUserId: 'human_1',
      humanAddress: '0x1111111111111111111111111111111111111111',
      agentShareBps: 2_000,
    });

    await recordPEAccrual({ ...baseParams, fixedEstimatedPVT: 1500, isGenesisGrant: true });

    expect(writePEHistoryMock).toHaveBeenCalledTimes(1);
    const arg = writePEHistoryMock.mock.calls[0][0] as {
      estimatedPVT: number;
      pvt_split: unknown;
      beneficiary_wallet_id: unknown;
      fixed_estimated_pvt_override: boolean;
      is_genesis_grant: boolean;
    };
    expect(arg.estimatedPVT).toBe(4);
    expect(arg.pvt_split).toEqual({
      total: 4,
      agent_share: 0.8,
      human_share: 3.2,
      ratio: 0.2,
    });
    expect(arg.beneficiary_wallet_id).toBe('human_1');
    expect(arg.fixed_estimated_pvt_override).toBe(false);
    expect(arg.is_genesis_grant).toBe(false);
  });
});
