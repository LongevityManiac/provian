/**
 * the PVT9-native settlement-rate reader, RED-controlled.
 *
 * Proves: (1) the factor is `mintRate / 1e18` the exact numerator/denominator
 * `projectCurrentSettlementPEAtomic` multiplies (`roleInput × num / denom`), so a
 * dashboard number = eligible points × the real kernel rate; (2) a non-positive
 * rate → `null` (unavailable → PE-count fallback, never a fabricated number);
 * (3) the reader fails closed on an RPC error; (4) success/failure caching.
 */

import { describe, expect, it, jest } from '@jest/globals';
import {
  buildSettlementProjectionContext,
  readPvt9SettlementFactors,
  __resetPvt9SettlementFactorsCacheForTest,
  MINT_RATE_SCALE_ATOMIC,
  RATE_CACHE_TTL_MS,
  RATE_NEGATIVE_CACHE_TTL_MS,
  type EpochRateObservation,
} from './pvt9-settlement-factors';

const KERNEL = '0x8811441914381143b9408c5C32247367F86F173A';
const ONE = MINT_RATE_SCALE_ATOMIC; // 1e18

/** Reproduce the exact projection arithmetic: roleInput × numerator / denominator. */
function projectPvtAtomic(pointsAtomic: bigint, factor: { numerator: string; denominator: string }): bigint {
  return (pointsAtomic * BigInt(factor.numerator)) / BigInt(factor.denominator);
}

describe('buildSettlementProjectionContext — the factor is mintRate / 1e18', () => {
  it('GREEN: a 1.0× rate (1e18) projects points 1:1', () => {
    const ctx = buildSettlementProjectionContext({
      epoch: 4n, mintRateAtomic: ONE, blockNumber: 50673010, kernelAddress: KERNEL, nowMs: 1000,
    });
    expect(ctx).not.toBeNull();
    expect(ctx!.globalMintRate.numerator).toBe(ONE.toString());
    expect(ctx!.globalMintRate.denominator).toBe(ONE.toString());
    expect(ctx!.globalMintRate.source).toBe(`${KERNEL}.getEpochPolicy(4).mintRate`);
    expect(ctx!.projectedAtMs).toBe(1000);
    // 5 record points at 1.0× → 5 PVT.
    expect(projectPvtAtomic(5n * ONE, ctx!.globalMintRate)).toBe(5n * ONE);
  });

  it('GREEN: a 0.5× rate (5e17) halves; a 2.0× rate (2e18) doubles', () => {
    const half = buildSettlementProjectionContext({ epoch: 4n, mintRateAtomic: ONE / 2n, blockNumber: 1, kernelAddress: KERNEL, nowMs: 0 })!;
    const dbl = buildSettlementProjectionContext({ epoch: 4n, mintRateAtomic: 2n * ONE, blockNumber: 1, kernelAddress: KERNEL, nowMs: 0 })!;
    expect(projectPvtAtomic(10n * ONE, half.globalMintRate)).toBe(5n * ONE);
    expect(projectPvtAtomic(10n * ONE, dbl.globalMintRate)).toBe(20n * ONE);
  });

  it('RED CONTROL: a zero or negative rate returns null (never a 0 factor / fabricated number)', () => {
    expect(buildSettlementProjectionContext({ epoch: 4n, mintRateAtomic: 0n, blockNumber: 1, kernelAddress: KERNEL, nowMs: 0 })).toBeNull();
    expect(buildSettlementProjectionContext({ epoch: 4n, mintRateAtomic: -1n, blockNumber: 1, kernelAddress: KERNEL, nowMs: 0 })).toBeNull();
  });
});

describe('readPvt9SettlementFactors — fail-closed + caching', () => {
  const obs = (mintRateAtomic: bigint): EpochRateObservation => ({
    epoch: 4n, mintRateAtomic, blockNumber: 50673010, kernelAddress: KERNEL,
  });

  it('returns the real factor when the reader succeeds', async () => {
    __resetPvt9SettlementFactorsCacheForTest();
    let t = 0;
    const ctx = await readPvt9SettlementFactors({ readEpochRate: async () => obs(ONE), now: () => t });
    expect(ctx).not.toBeNull();
    expect(ctx!.globalMintRate.numerator).toBe(ONE.toString());
  });

  it('RED CONTROL: an RPC/adapter error fails closed to null (PE-count fallback, not a wrong number)', async () => {
    __resetPvt9SettlementFactorsCacheForTest();
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = await readPvt9SettlementFactors({
      readEpochRate: async () => { throw new Error('base rpc down'); },
      now: () => 0,
    });
    expect(ctx).toBeNull();
    spy.mockRestore();
  });

  it('caches success for 60s and a failure for 15s (bounds RPC on outage)', async () => {
    __resetPvt9SettlementFactorsCacheForTest();
    let t = 0;
    let calls = 0;
    const read = async () => { calls += 1; return obs(ONE); };
    await readPvt9SettlementFactors({ readEpochRate: read, now: () => t });
    expect(calls).toBe(1);
    t = RATE_CACHE_TTL_MS - 1;
    await readPvt9SettlementFactors({ readEpochRate: read, now: () => t }); // cached
    expect(calls).toBe(1);
    t = RATE_CACHE_TTL_MS + 1;
    await readPvt9SettlementFactors({ readEpochRate: read, now: () => t }); // re-read
    expect(calls).toBe(2);

    // Failure negative-cache is shorter (15s).
    __resetPvt9SettlementFactorsCacheForTest();
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    let ft = 0; let fcalls = 0;
    const fread = async (): Promise<EpochRateObservation> => { fcalls += 1; throw new Error('down'); };
    await readPvt9SettlementFactors({ readEpochRate: fread, now: () => ft });
    ft = RATE_NEGATIVE_CACHE_TTL_MS - 1;
    await readPvt9SettlementFactors({ readEpochRate: fread, now: () => ft }); // cached-null
    expect(fcalls).toBe(1);
    ft = RATE_NEGATIVE_CACHE_TTL_MS + 1;
    await readPvt9SettlementFactors({ readEpochRate: fread, now: () => ft }); // re-read
    expect(fcalls).toBe(2);
    spy.mockRestore();
  });
});
