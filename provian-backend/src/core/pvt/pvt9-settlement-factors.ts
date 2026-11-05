/**
 * pvt9-settlement-factors — the CORRECT PVT9-native settlement-rate reader.
 *
 * WHY THIS EXISTS. The dashboard's eligible-only pending-PVT projection needs the
 * mint rate the kernel ACTUALLY applies at settlement. left that dark on
 * purpose: the only factors reader then in the tree, `readContractSettlementFactors`
 * (in the PVTv8 `minting-engine.ts`, since deleted), read PVTv8 economic-state functions (`effectiveMintRate`,
 * `circuitBreakerTripped`, …) that the PVT9 kernel DOES NOT EXPOSE, so aiming it at
 * PVT9 would throw at encode time or show a WRONG number. This module reads the
 * PVT9-native value instead.
 *
 * THE AUTHORITATIVE RATE. `ProvianPVT9.settleStandardPEBatch` converts points → PVT
 * on-chain as `points.mulDiv(policy.mintRate, 1 ether)` (ProvianPVT9.sol:574), where
 * `policy = getEpochPolicy(lastOpenedEpoch)`. The live settlement runtime mirrors
 * this exactly: the chain adapter reads `getEpochPolicy(lastOpenedEpoch).mintRate`
 * (`settlement-chain-adapter.ts:167,180`) and the cycle runner applies
 * `mulDivFloor(points, mintRateAtomic, 1e18)` (`settlement-cycle-runner.ts:300`). So
 * the projection factor is `mintRate / 1e18` read off `getEpochPolicy(lastOpenedEpoch)`
 * numerator/denominator semantics identical to the retired PVTv8 factor, only the
 * on-chain getter differs. `lastOpenedEpoch` (not `currentEpoch`) is used to match
 * the settlement path byte-for-byte: settlement mints against the open epoch, which
 * can lag the time-derived `currentEpoch` until the keeper advances it.
 *
 * FAIL CLOSED. Any read failure, an unconfigured runtime, or a non-positive rate
 * returns `null` → the dashboard shows the PE COUNT ('s guarded fallback),
 * NEVER a record-points sum and NEVER a fabricated rate. Read-only: this module
 * never signs, mints, or writes.
 */

import { ethers } from 'ethers';
import { requireConfiguredPvt9Runtime } from './pvt9-base-config.generated';
import { disclosedRationalFactor } from './policy/monetary-accounting';
import type { CurrentSettlementProjectionContext } from './policy/economic-projection';

/** The on-chain scale for `mintRate` (1 ether), matching ProvianPVT9.sol:574. */
export const MINT_RATE_SCALE_ATOMIC = 10n ** 18n;

/** A cached factor is reused for this long, bounding RPC cost across dashboard reads. */
export const RATE_CACHE_TTL_MS = 60_000;
/** A read FAILURE is remembered this long so an RPC outage does not hit chain per request. */
export const RATE_NEGATIVE_CACHE_TTL_MS = 15_000;

/**
 * PURE: build the projection context from an already-read rate. Exported for a
 * network-free unit test. A non-positive rate yields `null` (unavailable →
 * PE-count fallback), never a zero/negative factor.
 */
export function buildSettlementProjectionContext(input: {
  readonly epoch: bigint;
  readonly mintRateAtomic: bigint;
  readonly blockNumber: number;
  readonly kernelAddress: string;
  readonly nowMs: number;
}): CurrentSettlementProjectionContext | null {
  if (input.mintRateAtomic <= 0n) return null;
  return {
    projectedAtMs: input.nowMs,
    globalMintRate: disclosedRationalFactor(
      input.mintRateAtomic,
      MINT_RATE_SCALE_ATOMIC,
      `${input.kernelAddress}.getEpochPolicy(${input.epoch.toString()}).mintRate`,
      `base:${input.blockNumber}`,
    ),
  };
}

/** The one on-chain read this module needs, injectable for tests. */
export interface EpochRateObservation {
  readonly epoch: bigint;
  readonly mintRateAtomic: bigint;
  readonly blockNumber: number;
  readonly kernelAddress: string;
}

export interface Pvt9SettlementFactorsDeps {
  /** Reads `getEpochPolicy(lastOpenedEpoch).mintRate` + a block ref. */
  readonly readEpochRate: () => Promise<EpochRateObservation>;
  readonly now?: () => number;
}

let cachedContract: ethers.Contract | null = null;
let cachedProvider: ethers.JsonRpcProvider | null = null;

/** Lazily builds a provider-only, read-only PVT9 contract from the generated runtime. */
function defaultReadEpochRate(): () => Promise<EpochRateObservation> {
  return async (): Promise<EpochRateObservation> => {
    if (cachedContract === null || cachedProvider === null) {
      const runtime = requireConfiguredPvt9Runtime();
      cachedProvider = new ethers.JsonRpcProvider(
        process.env.BASE_RPC_URL || 'https://mainnet.base.org',
        runtime.chainId,
      );
      cachedContract = new ethers.Contract(
        runtime.address,
        runtime.abi as ethers.InterfaceAbi,
        cachedProvider,
      );
    }
    // lastOpenedEpoch — the epoch settlement actually mints against (matches the
    // chain adapter's own read), never the time-derived currentEpoch.
    const epoch = BigInt(await cachedContract.lastOpenedEpoch());
    const policy = await cachedContract.getEpochPolicy(epoch);
    const blockNumber = await cachedProvider.getBlockNumber();
    return {
      epoch,
      mintRateAtomic: BigInt(policy.mintRate),
      blockNumber,
      kernelAddress: requireConfiguredPvt9Runtime().address,
    };
  };
}

let cache: { context: CurrentSettlementProjectionContext | null; atMs: number } | null = null;

/**
 * Read the current PVT9 settlement projection context, or `null` if unavailable.
 * In-process memoized (success 60s, failure 15s) so the dashboard read does not
 * hit Base on every request. Fail-closed: any error → `null` → PE-count fallback.
 */
export async function readPvt9SettlementFactors(
  deps: Pvt9SettlementFactorsDeps = { readEpochRate: defaultReadEpochRate() },
): Promise<CurrentSettlementProjectionContext | null> {
  const now = deps.now ?? Date.now;
  const nowMs = now();
  if (cache !== null) {
    const ttl = cache.context === null ? RATE_NEGATIVE_CACHE_TTL_MS : RATE_CACHE_TTL_MS;
    if (nowMs - cache.atMs < ttl) return cache.context;
  }
  let context: CurrentSettlementProjectionContext | null;
  try {
    const obs = await deps.readEpochRate();
    context = buildSettlementProjectionContext({
      epoch: obs.epoch,
      mintRateAtomic: obs.mintRateAtomic,
      blockNumber: obs.blockNumber,
      kernelAddress: obs.kernelAddress,
      nowMs,
    });
  } catch (err) {
    // Read-only, fail-closed: an RPC/adapter error shows the PE count, never a
    // fabricated or stale-wrong rate.
    console.error('[PVT9] settlement-factors read unavailable:', err);
    context = null;
  }
  cache = { context, atMs: nowMs };
  return context;
}

/** Test-only: reset the in-process memo + lazy contract handle. */
export function __resetPvt9SettlementFactorsCacheForTest(): void {
  cache = null;
  cachedContract = null;
  cachedProvider = null;
}
