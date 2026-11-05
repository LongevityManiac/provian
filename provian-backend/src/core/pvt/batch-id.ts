/**
 * [SEC-audit-4.8] Deterministic batchId - same PEs always produce same batchId.
 * Sorted PE IDs + merkle root → keccak256 hash. This ensures the on-chain
 * batchMinted[batchId] check catches crash-and-retry double-mints.
 *
 * Moved here from the retired PVTv8 minting engine (deleted with the PE meter
 * migration, 2026-10-03) so anchor-recovery can still independently re-derive
 * the batchId of a historical snapshot and refuse to act if it doesn't match
 * the on-chain event's batchId. The derivation is byte-identical.
 */

import { ethers } from 'ethers';

export function computeDeterministicBatchId(peIds: string[], merkleRoot: string): string {
  const sortedIds = [...peIds].sort();
  const content = sortedIds.join(',') + ':' + merkleRoot;
  return ethers.keccak256(ethers.toUtf8Bytes(content));
}
