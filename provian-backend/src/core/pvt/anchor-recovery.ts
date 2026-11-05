/**
 * PVT - Anchor Recovery
 *
 * Validates that a previously-minted batch can be safely re-anchored on
 * PEAnchor by reconstructing its merkleRoot and deterministic batchId from
 * the immutable snapshot persisted at mint time.
 *
 * Invariants (enforced here, not assumed by callers):
 *   1. NEVER calls or returns input for mintFromPEs. Recovery is anchor-only.
 *   2. Refuses if the snapshot is missing.
 *   3. Refuses if recomputed merkleRoot OR recomputed batchId disagrees with
 *      the on-chain BatchMinted event.
 *   4. Returns `already_anchored` if PEAnchor.batches(batchId).exists is true.
 *   5. Only returns AnchorRetryPlan when the snapshot is valid AND the batch
 *      is unanchored. The plan is forensic/read-only output: legacy callers
 *      must not broadcast it. The fenced mint-claim recovery path is the only
 *      path allowed to submit or finalize an anchor transaction.
 *
 * Mint-first, anchor-second ordering is preserved: this module assumes the
 * mint already happened (BatchMinted event exists) and only ever proposes
 * anchorBatch retries.
 */

import { ethers } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import type { PVTMintBatchSnapshotDocument } from '../agent-bank/types';
import { buildMerkleTree, type MerkleLeaf } from './merkle';
import { computeDeterministicBatchId } from './batch-id';

// =============================================================================
// TYPES
// =============================================================================

export interface AnchorRecoveryDeps {
  db: Firestore;
  peAnchorContract: ethers.Contract;
}

/**
 * Aggregate event shape consumed by recovery - narrow on purpose so callers
 * can populate it from a parsed log, a Firestore mirror, or a test stub
 * without coupling to ethers.
 */
export interface BatchMintedEventLike {
  batchId: string;
  merkleRoot: string;
  /** Optional - used for richer logging only; not validated. */
  txHash?: string;
  blockNumber?: number;
}

export type AnchorRecoveryStatus =
  | 'snapshot_missing'
  | 'merkle_root_mismatch'
  | 'batch_id_mismatch'
  | 'already_anchored'
  | 'ready_to_anchor';

export interface AnchorRecoveryResult {
  batchId: string;
  status: AnchorRecoveryStatus;
  /** Populated only when status === 'ready_to_anchor'. */
  retryPlan?: AnchorRetryPlan;
  /** Human-readable detail (mismatch values, snapshot lookup error, etc). */
  detail?: string;
}

/**
 * Pure forensic data describing the historical anchorBatch arguments.
 * Recovery never sends the transaction itself, and callers must not use this
 * object to bypass mint-claim ownership/finality recovery.
 */
export interface AnchorRetryPlan {
  batchId: string;
  merkleRoot: string;
  peCount: number;
  timestamp: number;
  epochNumber: number;
}

// =============================================================================
// SNAPSHOT LOAD + VALIDATE
// =============================================================================

const SNAPSHOTS_COLLECTION = 'pvt_mint_batch_snapshots';

export async function loadSnapshot(
  db: Firestore,
  batchId: string,
): Promise<PVTMintBatchSnapshotDocument | null> {
  const ref = db.collection(SNAPSHOTS_COLLECTION).doc(batchId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  return snap.data() as PVTMintBatchSnapshotDocument;
}

/**
 * Recompute the merkle root from a snapshot's leaf payloads. Uses the same
 * buildMerkleTree() the retired PVTv8 minting engine used at mint time, so any drift in
 * leaf encoding will surface as a mismatch.
 */
export function recomputeMerkleRoot(snapshot: PVTMintBatchSnapshotDocument): string {
  const leaves: MerkleLeaf[] = snapshot.leaves.map((l) => ({
    peId: l.peId,
    walletAddress: l.walletAddress,
    actionType: l.actionType,
    timestamp: l.timestamp,
    basePoints: BigInt(l.basePoints),
  }));
  const tree = buildMerkleTree(leaves);
  return tree.root;
}

/**
 * Recompute the deterministic batchId from a snapshot. Mirrors
 * batch-id.computeDeterministicBatchId so a contract upgrade or PE-id
 * encoding change would produce a recovery refusal rather than a silent
 * mismatch on retry.
 */
export function recomputeBatchId(snapshot: PVTMintBatchSnapshotDocument): string {
  return computeDeterministicBatchId(snapshot.sorted_pe_ids, snapshot.merkle_root);
}

// =============================================================================
// PE ANCHOR PROBE
// =============================================================================

/**
 * Returns true when PEAnchor.batches(batchId).exists is true on-chain.
 * Any RPC error is treated as "unknown" → caller is expected to refuse the
 * retry plan rather than risk a duplicate anchor.
 */
export async function isAlreadyAnchored(
  peAnchorContract: ethers.Contract,
  batchId: string,
): Promise<boolean> {
  const batch = await peAnchorContract.batches(batchId);
  // Tuple/struct return - different ethers shapes; check both.
  if (typeof batch === 'object' && batch !== null) {
    if ('exists' in batch) {
      return Boolean((batch as { exists: unknown }).exists);
    }
    // Tuple form: (merkleRoot, peCount, timestamp, epochNumber, exists)
    if (Array.isArray(batch) && batch.length >= 5) {
      return Boolean(batch[4]);
    }
  }
  return false;
}

// =============================================================================
// MAIN ENTRY
// =============================================================================

/**
 * Validate a BatchMinted event against the persisted snapshot and report
 * whether the batch is safely anchorable. Never writes to chain.
 */
export async function validateAnchorRecovery(
  deps: AnchorRecoveryDeps,
  event: BatchMintedEventLike,
): Promise<AnchorRecoveryResult> {
  const { batchId, merkleRoot } = event;

  const snapshot = await loadSnapshot(deps.db, batchId);
  if (!snapshot) {
    return {
      batchId,
      status: 'snapshot_missing',
      detail: `no snapshot for batchId ${batchId}; refusing recovery`,
    };
  }

  const recomputedRoot = recomputeMerkleRoot(snapshot);
  if (recomputedRoot.toLowerCase() !== merkleRoot.toLowerCase()) {
    return {
      batchId,
      status: 'merkle_root_mismatch',
      detail: `event root ${merkleRoot} != recomputed ${recomputedRoot}`,
    };
  }

  const recomputedBatchId = recomputeBatchId(snapshot);
  if (recomputedBatchId.toLowerCase() !== batchId.toLowerCase()) {
    return {
      batchId,
      status: 'batch_id_mismatch',
      detail: `event batchId ${batchId} != recomputed ${recomputedBatchId}`,
    };
  }

  const anchored = await isAlreadyAnchored(deps.peAnchorContract, batchId);
  if (anchored) {
    return { batchId, status: 'already_anchored' };
  }

  return {
    batchId,
    status: 'ready_to_anchor',
    retryPlan: { ...snapshot.anchor_args },
  };
}
