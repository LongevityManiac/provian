/**
 * PVT - Merkle Tree Construction
 *
 * Builds binary Merkle trees from PE leaves for on-chain anchoring.
 * Leaf hashing uses solidityPackedKeccak256 to match contract verification.
 * Pairs are sorted (smaller hash first) to ensure deterministic trees.
 */

import { keccak256, solidityPacked } from 'ethers';

// =============================================================================
// TYPES
// =============================================================================

export interface MerkleLeaf {
  peId: string;
  walletAddress: string;
  actionType: string;
  timestamp: number;
  basePoints: bigint; // wei-scale (1e18 = 1 PVT) - bigint required for values > 2^53
}

export interface MerkleTree {
  root: string;
  leaves: string[];       // Leaf hashes (sorted)
  layers: string[][];     // All layers bottom-up
}

export interface MerkleProof {
  leaf: string;
  proof: string[];
  leafIndex: number;
}

// =============================================================================
// LEAF HASHING
// =============================================================================

/**
 * Hash a PE leaf using solidityPackedKeccak256 to match on-chain verification.
 *
 * [chunk-i] Leaves are tagged with 0x00 byte prefix so they occupy a
 * hash space disjoint from internal Merkle nodes (which are tagged
 * with 0x01 in this implementation and in the on-chain verifier). This
 * forecloses second-preimage attacks where an attacker could submit an
 * internal-node hash as a leaf.
 */
export function hashLeaf(
  peId: string,
  walletAddress: string,
  actionType: string,
  timestamp: number,
  basePoints: bigint,
): string {
  return keccak256(
    solidityPacked(
      ['bytes1', 'string', 'address', 'string', 'uint256', 'uint256'],
      ['0x00', peId, walletAddress, actionType, timestamp, basePoints],
    ),
  );
}

// =============================================================================
// TREE CONSTRUCTION
// =============================================================================

/**
 * Hash an envelope-hash leaf for the daily PE anchoring path (WP7,
 * anchor-everything). The leaf DATA is the PE's existing canonical envelope
 * hash (the sha256 hex stored as `pe_history.peHash` / `provenance_envelopes.hash`)
 * — no re-canonicalization of envelope content. The 0x00 byte is the same
 * leaf-domain tag the on-chain verifyPE requires (leaves and internal nodes
 * occupy disjoint hash spaces).
 *
 * leaf = keccak256(0x00 || bytes32(sha256_envelope_hash))
 */
export function hashEnvelopeHashLeaf(envelopeHashHex: string): string {
  const normalized = normalizeEnvelopeHash(envelopeHashHex);
  return keccak256(solidityPacked(['bytes1', 'bytes32'], ['0x00', normalized]));
}

/**
 * Normalize a sha256 envelope hash to 0x-prefixed lowercase bytes32 hex.
 * Throws on anything that is not exactly 32 bytes of hex — a malformed hash
 * must never become a leaf (Unknown = Block).
 */
export function normalizeEnvelopeHash(envelopeHashHex: string): string {
  const stripped = envelopeHashHex.startsWith('0x') || envelopeHashHex.startsWith('0X')
    ? envelopeHashHex.slice(2)
    : envelopeHashHex;
  if (!/^[0-9a-fA-F]{64}$/.test(stripped)) {
    throw new Error(`Invalid envelope hash (need 32-byte hex): ${envelopeHashHex}`);
  }
  return `0x${stripped.toLowerCase()}`;
}

/**
 * Build a binary Merkle tree from PE leaves.
 *
 * 1. Hash each leaf
 * 2. Sort leaf hashes lexicographically
 * 3. Pad to next power of 2 with zero hashes
 * 4. Build tree bottom-up with sorted pair hashing
 */
export function buildMerkleTree(leaves: MerkleLeaf[]): MerkleTree {
  if (leaves.length === 0) {
    return { root: keccak256('0x'), leaves: [], layers: [[]] };
  }

  // Hash all leaves
  const hashes = leaves.map((leaf) =>
    hashLeaf(leaf.peId, leaf.walletAddress, leaf.actionType, leaf.timestamp, leaf.basePoints),
  );

  // Sort lexicographically
  hashes.sort();

  return buildTreeFromOrderedLeafHashes(hashes);
}

/**
 * Build a Merkle tree from already-computed leaf hashes, PRESERVING the
 * caller's leaf order (no lexicographic re-sort). Used by the daily PE
 * anchoring path, where leaf order is normative — (timestamp asc, envelope_id
 * asc) — and a leaf's index in the input array IS its `leaf_index` in the
 * anchored batch. Pair sorting still happens per-level inside
 * buildTreeFromOrderedLeafHashes, so proofs verify against the same on-chain
 * verifyPE rule as mint batches.
 *
 * Leaf hashes must already carry the 0x00 leaf-domain tag
 * (see hashEnvelopeHashLeaf / hashLeaf).
 */
export function buildMerkleTreeFromLeafHashes(orderedLeafHashes: string[]): MerkleTree {
  if (orderedLeafHashes.length === 0) {
    return { root: keccak256('0x'), leaves: [], layers: [[]] };
  }
  return buildTreeFromOrderedLeafHashes([...orderedLeafHashes]);
}

/**
 * Shared tree body: pad to next power of 2 with zero hashes, then build
 * bottom-up with 0x01-tagged sorted-pair hashing (matches on-chain verifyPE).
 * Leaf order is taken as given — callers own the ordering rule.
 */
function buildTreeFromOrderedLeafHashes(hashes: string[]): MerkleTree {
  // Pad to next power of 2
  const targetSize = nextPowerOf2(hashes.length);
  const zeroHash = keccak256('0x');
  while (hashes.length < targetSize) {
    hashes.push(zeroHash);
  }

  const layers: string[][] = [hashes];

  // Build tree bottom-up
  let currentLayer = hashes;
  while (currentLayer.length > 1) {
    const nextLayer: string[] = [];
    for (let i = 0; i < currentLayer.length; i += 2) {
      const left = currentLayer[i];
      const right = currentLayer[i + 1];
      // Sort pair to match contract verification (smaller hash first).
      // [chunk-i] Internal nodes are tagged with 0x01 prefix, disjoint
      // from leaves which carry 0x00, matching the on-chain verifyPE.
      const hash = left <= right
        ? keccak256(solidityPacked(['bytes1', 'bytes32', 'bytes32'], ['0x01', left, right]))
        : keccak256(solidityPacked(['bytes1', 'bytes32', 'bytes32'], ['0x01', right, left]));
      nextLayer.push(hash);
    }
    layers.push(nextLayer);
    currentLayer = nextLayer;
  }

  return {
    root: currentLayer[0],
    leaves: hashes,
    layers,
  };
}

// =============================================================================
// PROOF GENERATION
// =============================================================================

/**
 * Generate a Merkle proof for a leaf at a given index.
 * Returns the sibling path from leaf to root.
 */
export function generateProof(tree: MerkleTree, leafIndex: number): MerkleProof {
  if (leafIndex < 0 || leafIndex >= tree.leaves.length) {
    throw new Error(`Leaf index ${leafIndex} out of bounds (0-${tree.leaves.length - 1})`);
  }

  const proof: string[] = [];
  let index = leafIndex;

  for (let layer = 0; layer < tree.layers.length - 1; layer++) {
    const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
    if (siblingIndex < tree.layers[layer].length) {
      proof.push(tree.layers[layer][siblingIndex]);
    }
    index = Math.floor(index / 2);
  }

  return {
    leaf: tree.leaves[leafIndex],
    proof,
    leafIndex,
  };
}

// =============================================================================
// PROOF VERIFICATION (off-chain mirror of ProvianPEAnchor.verifyPE)
// =============================================================================

/**
 * Walk a Merkle proof exactly as the on-chain verifyPE does:
 * sorted pairs, 0x01 internal-node tag. `leafValue` must already be the
 * leaf-domain hash (0x00-tagged — see hashLeaf / hashEnvelopeHashLeaf).
 */
export function verifyMerkleProof(leafValue: string, proof: string[], root: string): boolean {
  let computed = leafValue;
  for (const sibling of proof) {
    computed = computed <= sibling
      ? keccak256(solidityPacked(['bytes1', 'bytes32', 'bytes32'], ['0x01', computed, sibling]))
      : keccak256(solidityPacked(['bytes1', 'bytes32', 'bytes32'], ['0x01', sibling, computed]));
  }
  return computed === root;
}

// =============================================================================
// HELPERS
// =============================================================================

function nextPowerOf2(n: number): number {
  if (n <= 1) return 1;
  let p = 1;
  while (p < n) p *= 2;
  return p;
}
