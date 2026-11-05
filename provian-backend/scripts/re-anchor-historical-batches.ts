/**
 * RETIRED — historical independent re-anchoring is not an executable path.
 *
 * This script previously loaded PVT_MINTER_KEY, recomputed historical roots,
 * broadcast anchorBatch directly, waited through a single provider, and only
 * then persisted the transaction hash. That bypassed the atomic accounting mint-claim
 * ownership/fencing and exact-hash recovery protocol.
 *
 * Replacement rule: an anchor may be submitted only by the mint claim that
 * owns the corresponding batch. The claim must persist its signed raw
 * transaction, derived hash, and nonce before broadcast, reconcile the exact
 * BatchAnchored arguments, and reach operator-bound quorum-two 12-confirmation
 * finality. The PVTv8 minting engine (`src/core/pvt/minting-engine.ts`) that
 * wrote these batches was deleted with the PE meter migration; the
 * lease it shared survives in src/core/pvt/mint-worker-coordination.ts.
 *
 * The separate src/core/pvt/anchor-recovery.ts module is forensic/read-only;
 * it cannot broadcast. Historical batches without a qualifying mint claim
 * therefore remain read-only evidence and require a separately reviewed data
 * migration design in a later authorized work package.
 */

export const HISTORICAL_REANCHOR_EXECUTION_RETIRED = true as const;

export function main(): never {
  throw new Error(
    'historical_reanchor_execution_retired_use_mint_claim_owned_recovery',
  );
}

if (require.main === module) {
  main();
}
