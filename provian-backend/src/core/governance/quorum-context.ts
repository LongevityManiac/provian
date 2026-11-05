/**
 * QuorumContext fetcher with a 60-second in-memory cache.
 *
 * Used by the governance read path to compute effective proposal status.
 * Two staticcalls at most per cache interval (totalSupply on PVT +
 * quorumBps on Governance). On RPC failure, falls back to undefined so
 * the caller can emit a best-effort status without a quorum branch.
 *
 * The contract's executeProposal reads both values at finalize time via
 * staticcall; reading them at API read time mirrors that exactly.
 */

import { ethers } from 'ethers';
import type { QuorumContext } from './effective-status';

interface CacheEntry {
  ctx: QuorumContext;
  fetchedAt: number;
}

let cached: CacheEntry | null = null;
const CACHE_TTL_MS = 60_000;

/**
 * Fetch totalSupply + quorumBps with 60s caching. Returns undefined if
 * either call fails so callers can degrade gracefully to no-quorum
 * computation rather than failing the whole request.
 */
export async function getQuorumContext(
  governanceContract: ethers.Contract,
  pvtContract: ethers.Contract,
): Promise<QuorumContext | undefined> {
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.ctx;

  try {
    const [totalSupplyRaw, quorumBpsRaw] = await Promise.all([
      pvtContract.totalSupply(),
      governanceContract.quorumBps(),
    ]);
    const ctx: QuorumContext = {
      totalSupply: BigInt(totalSupplyRaw),
      quorumBps: Number(quorumBpsRaw),
    };
    cached = { ctx, fetchedAt: now };
    return ctx;
  } catch (_error) {
    // Best-effort: do not fail the response on transient RPC issues.
    // Status computation will skip the quorum branch.
    return undefined;
  }
}

/** Test hook - reset cache between unit tests. */
export function _resetQuorumContextCache(): void {
  cached = null;
}
