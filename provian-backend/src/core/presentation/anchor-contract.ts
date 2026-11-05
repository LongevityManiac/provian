/**
 * The canonical PEAnchor read contract for relay-side presentation verification (item 3).
 *
 * The public `/v1/present/verify` route has always verified pe_fact proofs against the deployed
 * PEAnchor on Base. The relay's verify-at-submit paths (Commons thread requests, the remote
 * channel, forum challenge answers) passed `null` and returned `onchain_checked:false`. They now
 * read the SAME contract — built the same way `server.ts` builds it for the public route
 * (`buildPeAnchorReadContract` over the Base provider; provider-only, no key material). Memoized:
 * the contract object is immutable and the provider factory is itself cached.
 */

import { buildPeAnchorReadContract } from '../pvt/pe-anchor-runtime';
import { getChainProvider } from '../onchain/rpc-provider';

export interface PeAnchorVerifyContract {
  verifyPE(batchId: string, peHash: string, proof: string[]): Promise<boolean>;
}

let memo: { contract: PeAnchorVerifyContract | null } | null = null;

export function canonicalPeAnchorReadContract(): PeAnchorVerifyContract | null {
  if (!memo) {
    const c = buildPeAnchorReadContract(() => getChainProvider('base'));
    memo = { contract: c as unknown as PeAnchorVerifyContract | null };
  }
  return memo.contract;
}

/** Test-only: forget the memoized contract. */
export function resetCanonicalPeAnchorReadContract(): void {
  memo = null;
}
