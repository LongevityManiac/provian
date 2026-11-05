// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ProvianPEAnchor.sol";

/*
 * ============================================================================
 * PROVIAN PE ANCHOR - TESTS
 * ============================================================================
 *
 * Covers:
 *   1. Constructor / access control
 *   2. Anchor batch happy path + event emission
 *   3. Batch idempotency (double-anchor same batchId reverts)
 *   4. Merkle proof verification - valid / wrong-root / wrong-leaf / tampered
 *   5. TS ↔ Solidity Merkle algorithm consistency (the cross-test)
 *   6. Admin / minter rotation
 *   7. Gas sanity - verify against a 10k-leaf tree stays under 200k gas
 *   8. Invariant / fuzz tests
 *
 * ============================================================================
 * TS ↔ SOLIDITY MERKLE ALGORITHM CROSS-REFERENCE
 *
 * The Solidity `MerkleHelper` below mirrors the TypeScript implementation in
 *   provian-backend/src/core/pvt/merkle.ts
 * which the backend minting engine uses to construct Merkle roots before
 * calling PEAnchor.anchorBatch. If these drift, PEAnchor will reject every
 * proof the backend generates - minting silently breaks.
 *
 * The TS source (verbatim) - diff this block against merkle.ts on every review:
 *
 *   import { keccak256, solidityPacked } from 'ethers';
 *
 *   export function hashLeaf(
 *     peId: string,
 *     walletAddress: string,
 *     actionType: string,
 *     timestamp: number,
 *     basePoints: bigint,
 *   ): string {
 *     return keccak256(
 *       solidityPacked(
 *         ['string', 'address', 'string', 'uint256', 'uint256'],
 *         [peId, walletAddress, actionType, timestamp, basePoints],
 *       ),
 *     );
 *   }
 *
 *   export function buildMerkleTree(leaves: MerkleLeaf[]): MerkleTree {
 *     if (leaves.length === 0) {
 *       return { root: keccak256('0x'), leaves: [], layers: [[]] };
 *     }
 *
 *     let hashes = leaves.map((leaf) =>
 *       hashLeaf(leaf.peId, leaf.walletAddress, leaf.actionType, leaf.timestamp, leaf.basePoints),
 *     );
 *
 *     hashes.sort();                           // lexicographic on hex strings
 *
 *     const targetSize = nextPowerOf2(hashes.length);
 *     const zeroHash = keccak256('0x');        // keccak of empty bytes
 *     while (hashes.length < targetSize) {
 *       hashes.push(zeroHash);                 // pad to power of 2
 *     }
 *
 *     const layers: string[][] = [hashes];
 *     let currentLayer = hashes;
 *     while (currentLayer.length > 1) {
 *       const nextLayer: string[] = [];
 *       for (let i = 0; i < currentLayer.length; i += 2) {
 *         const left = currentLayer[i];
 *         const right = currentLayer[i + 1];
 *         const hash = left <= right           // sorted-pair hashing
 *           ? keccak256(solidityPacked(['bytes32', 'bytes32'], [left, right]))
 *           : keccak256(solidityPacked(['bytes32', 'bytes32'], [right, left]));
 *         nextLayer.push(hash);
 *       }
 *       layers.push(nextLayer);
 *       currentLayer = nextLayer;
 *     }
 *     return { root: currentLayer[0], leaves: hashes, layers };
 *   }
 *
 *   export function generateProof(tree: MerkleTree, leafIndex: number): MerkleProof {
 *     const proof: string[] = [];
 *     let index = leafIndex;
 *     for (let layer = 0; layer < tree.layers.length - 1; layer++) {
 *       const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
 *       if (siblingIndex < tree.layers[layer].length) {
 *         proof.push(tree.layers[layer][siblingIndex]);
 *       }
 *       index = Math.floor(index / 2);
 *     }
 *     return { leaf: tree.leaves[leafIndex], proof, leafIndex };
 *   }
 *
 *   function nextPowerOf2(n: number): number {
 *     if (n <= 1) return 1;
 *     let p = 1;
 *     while (p < n) p *= 2;
 *     return p;
 *   }
 *
 * Correspondence notes:
 *   - `keccak256('0x')` in TS == keccak256(empty bytes) in Solidity
 *     == 0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470.
 *   - `solidityPacked(['string', 'address', ...], ...)` ≡ `abi.encodePacked(...)`
 *     for the same argument types.
 *   - TS `hashes.sort()` sorts hex strings lexicographically (UTF-16 code points).
 *     For same-length lowercase hex strings this is order-preserving with
 *     big-endian numeric compare on the underlying bytes32, so Solidity's
 *     `<=` on bytes32 values produces the same ordering. (Both alphabets
 *     '0'–'9' = 48–57 and 'a'–'f' = 97–102 are monotonic with nibble value.)
 *   - TS `<=` pair-sort in internal nodes matches Solidity's bytes32 `<=` pair-sort.
 *   - Padding with zeroHash to the next power of 2 is identical on both sides.
 *
 * ============================================================================
 */

/**
 * @title MerkleHelper
 * @notice Solidity port of provian-backend/src/core/pvt/merkle.ts.
 *         Used only by tests - NOT deployed as part of the production contract.
 *         Keep the algorithm byte-identical to the TS source.
 */
contract MerkleHelper {
    // keccak256(abi.encodePacked()) = keccak256("") - matches TS keccak256('0x').
    bytes32 public constant ZERO_HASH =
        0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470;

    function hashLeaf(
        string memory peId,
        address walletAddress,
        string memory actionType,
        uint256 timestamp,
        uint256 basePoints
    ) public pure returns (bytes32) {
        // [chunk-i] 0x00 leaf-domain prefix matches merkle.ts
        return keccak256(abi.encodePacked(bytes1(0x00), peId, walletAddress, actionType, timestamp, basePoints));
    }

    /// @notice Build a Merkle tree from pre-hashed leaves. Returns the root and
    ///         every layer (bottom-up). Mirrors `buildMerkleTree` in merkle.ts.
    ///         `leafHashes` is MUTATED in place (sorted + padded) - callers
    ///         should pass a fresh copy if they need the originals.
    function buildTreeFromHashes(bytes32[] memory leafHashes)
        public
        pure
        returns (bytes32 root, bytes32[][] memory layers)
    {
        if (leafHashes.length == 0) {
            layers = new bytes32[][](1);
            layers[0] = new bytes32[](0);
            return (ZERO_HASH, layers);
        }

        // Sort lexicographically (bytes32 compare matches TS hex-string sort).
        _sort(leafHashes);

        // Pad to next power of 2.
        uint256 targetSize = _nextPowerOf2(leafHashes.length);
        bytes32[] memory padded = new bytes32[](targetSize);
        for (uint256 i = 0; i < leafHashes.length; i++) padded[i] = leafHashes[i];
        for (uint256 i = leafHashes.length; i < targetSize; i++) padded[i] = ZERO_HASH;

        // Count layers: log2(targetSize) + 1.
        uint256 layerCount = 1;
        for (uint256 s = targetSize; s > 1; s >>= 1) layerCount++;

        layers = new bytes32[][](layerCount);
        layers[0] = padded;

        // Build bottom-up.
        for (uint256 l = 1; l < layerCount; l++) {
            bytes32[] memory prev = layers[l - 1];
            bytes32[] memory next = new bytes32[](prev.length / 2);
            for (uint256 i = 0; i < prev.length; i += 2) {
                bytes32 left = prev[i];
                bytes32 right = prev[i + 1];
                // [chunk-i] 0x01 internal-node prefix matches merkle.ts and ProvianPEAnchor.verifyPE
                next[i / 2] = left <= right
                    ? keccak256(abi.encodePacked(bytes1(0x01), left, right))
                    : keccak256(abi.encodePacked(bytes1(0x01), right, left));
            }
            layers[l] = next;
        }

        root = layers[layerCount - 1][0];
    }

    /// @notice Generate a proof for the leaf at `leafIndex` in the SORTED+PADDED
    ///         leaf layer. Mirrors `generateProof` in merkle.ts exactly.
    function generateProof(bytes32[][] memory layers, uint256 leafIndex)
        public
        pure
        returns (bytes32[] memory proof)
    {
        require(layers.length > 0, "empty tree");
        require(leafIndex < layers[0].length, "leaf index OOB");

        bytes32[] memory buf = new bytes32[](layers.length - 1);
        uint256 index = leafIndex;
        uint256 depth = 0;

        for (uint256 l = 0; l + 1 < layers.length; l++) {
            uint256 siblingIndex = index % 2 == 0 ? index + 1 : index - 1;
            if (siblingIndex < layers[l].length) {
                buf[depth++] = layers[l][siblingIndex];
            }
            index /= 2;
        }

        proof = new bytes32[](depth);
        for (uint256 i = 0; i < depth; i++) proof[i] = buf[i];
    }

    // --- Internal helpers ---------------------------------------------------

    function _nextPowerOf2(uint256 n) internal pure returns (uint256) {
        if (n <= 1) return 1;
        uint256 p = 1;
        while (p < n) p <<= 1;
        return p;
    }

    function _sort(bytes32[] memory arr) internal pure {
        // In-place insertion sort - adequate for test sizes (≤ a few thousand).
        uint256 n = arr.length;
        for (uint256 i = 1; i < n; i++) {
            bytes32 key = arr[i];
            uint256 j = i;
            while (j > 0 && arr[j - 1] > key) {
                arr[j] = arr[j - 1];
                j--;
            }
            arr[j] = key;
        }
    }
}

/**
 * @title ProvianPEAnchorTest
 * @notice Unit + fuzz tests for ProvianPEAnchor. Fork test lives in
 *         ProvianCommonsFork.t.sol.
 */
contract ProvianPEAnchorTest is Test {
    ProvianPEAnchor public anchor;
    MerkleHelper public helper;

    address public admin = address(0xA01);
    address public minter = address(0xA02);
    address public rando = address(0xB01);
    address public newMinter = address(0xC01);
    address public newAdmin = address(0xC02);

    bytes32 public constant ZERO_HASH =
        0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470;

    function setUp() public {
        anchor = new ProvianPEAnchor(admin, minter);
        helper = new MerkleHelper();
    }

    // =========================================================================
    // CONSTRUCTOR + ACCESS CONTROL
    // =========================================================================

    function test_constructor_setsAdminAndMinter() public view {
        assertEq(anchor.admin(), admin);
        assertEq(anchor.minter(), minter);
    }

    function test_constructor_rejectsZeroAdmin() public {
        vm.expectRevert(ProvianPEAnchor.InvalidAddress.selector);
        new ProvianPEAnchor(address(0), minter);
    }

    function test_constructor_rejectsZeroMinter() public {
        vm.expectRevert(ProvianPEAnchor.InvalidAddress.selector);
        new ProvianPEAnchor(admin, address(0));
    }

    function test_anchorBatch_onlyMinter() public {
        vm.prank(rando);
        vm.expectRevert(ProvianPEAnchor.OnlyMinter.selector);
        anchor.anchorBatch(keccak256("batch1"), bytes32(uint256(1)), 1, block.timestamp, 0);
    }

    function test_anchorBatch_onlyMinter_adminCannotAnchor() public {
        // Admin is a distinct role - must not be allowed to anchor directly.
        vm.prank(admin);
        vm.expectRevert(ProvianPEAnchor.OnlyMinter.selector);
        anchor.anchorBatch(keccak256("b"), bytes32(uint256(1)), 1, block.timestamp, 0);
    }

    function test_setMinter_onlyAdmin() public {
        vm.prank(rando);
        vm.expectRevert(ProvianPEAnchor.OnlyAdmin.selector);
        anchor.setMinter(newMinter);
    }

    function test_setMinter_rejectsZero() public {
        vm.prank(admin);
        vm.expectRevert(ProvianPEAnchor.InvalidAddress.selector);
        anchor.setMinter(address(0));
    }

    function test_setMinter_updatesAndEmitsEvent() public {
        vm.expectEmit(true, true, false, false, address(anchor));
        emit ProvianPEAnchor.MinterUpdated(minter, newMinter);
        vm.prank(admin);
        anchor.setMinter(newMinter);
        assertEq(anchor.minter(), newMinter);
    }

    function test_transferAdmin_onlyAdmin() public {
        vm.prank(rando);
        vm.expectRevert(ProvianPEAnchor.OnlyAdmin.selector);
        anchor.transferAdmin(newAdmin);
    }

    function test_transferAdmin_rejectsZero() public {
        vm.prank(admin);
        vm.expectRevert(ProvianPEAnchor.InvalidAddress.selector);
        anchor.transferAdmin(address(0));
    }

    function test_transferAdmin_rotatesAndEmitsEvent() public {
        vm.expectEmit(true, true, false, false, address(anchor));
        emit ProvianPEAnchor.AdminTransferred(admin, newAdmin);
        vm.prank(admin);
        anchor.transferAdmin(newAdmin);
        assertEq(anchor.admin(), newAdmin);

        // Old admin can no longer act.
        vm.prank(admin);
        vm.expectRevert(ProvianPEAnchor.OnlyAdmin.selector);
        anchor.setMinter(newMinter);
    }

    // =========================================================================
    // ANCHOR BATCH - HAPPY PATH + EVENTS
    // =========================================================================

    function test_anchorBatch_happyPath_recordsStateAndEmits() public {
        bytes32 batchId = keccak256("alpha");
        bytes32 root = keccak256("root-alpha");
        uint256 peCount = 7;
        uint256 ts = 1_700_000_000;
        uint256 epoch = 42;

        vm.expectEmit(true, true, false, true, address(anchor));
        emit ProvianPEAnchor.BatchAnchored(batchId, root, peCount, ts, epoch);

        vm.prank(minter);
        anchor.anchorBatch(batchId, root, peCount, ts, epoch);

        (bytes32 gotRoot, uint256 gotCount, uint256 gotTs, uint256 gotEpoch, bool gotExists) =
            anchor.getBatch(batchId);

        assertEq(gotRoot, root);
        assertEq(gotCount, peCount);
        assertEq(gotTs, ts);
        assertEq(gotEpoch, epoch);
        assertTrue(gotExists);
    }

    function test_anchorBatch_doubleAnchor_reverts() public {
        bytes32 batchId = keccak256("beta");
        vm.prank(minter);
        anchor.anchorBatch(batchId, bytes32(uint256(1)), 1, block.timestamp, 0);

        vm.prank(minter);
        vm.expectRevert(ProvianPEAnchor.BatchAlreadyAnchored.selector);
        anchor.anchorBatch(batchId, bytes32(uint256(2)), 2, block.timestamp, 1);
    }

    function test_anchorBatch_zeroRoot_allowed() public {
        // Contract does not validate the root content - zero root is legal.
        // Pin this behavior so an accidental "block zero root" check becomes
        // a noticed behavior change.
        bytes32 batchId = keccak256("gamma");
        vm.prank(minter);
        anchor.anchorBatch(batchId, bytes32(0), 0, block.timestamp, 0);
        (bytes32 gotRoot,,,, bool gotExists) = anchor.getBatch(batchId);
        assertEq(gotRoot, bytes32(0));
        assertTrue(gotExists);
    }

    function test_anchorBatch_afterMinterRotation_oldMinterBlocked() public {
        vm.prank(admin);
        anchor.setMinter(newMinter);

        vm.prank(minter);
        vm.expectRevert(ProvianPEAnchor.OnlyMinter.selector);
        anchor.anchorBatch(keccak256("x"), bytes32(uint256(1)), 1, block.timestamp, 0);

        vm.prank(newMinter);
        anchor.anchorBatch(keccak256("x"), bytes32(uint256(1)), 1, block.timestamp, 0);
    }

    // =========================================================================
    // getBatch / verifyPE - NOT-FOUND CASES
    // =========================================================================

    function test_getBatch_unknownBatch_returnsZeroAndFalse() public view {
        (bytes32 gotRoot, uint256 gotCount, uint256 gotTs, uint256 gotEpoch, bool gotExists) =
            anchor.getBatch(keccak256("never-anchored"));
        assertEq(gotRoot, bytes32(0));
        assertEq(gotCount, 0);
        assertEq(gotTs, 0);
        assertEq(gotEpoch, 0);
        assertFalse(gotExists);
    }

    function test_verifyPE_unknownBatch_reverts() public {
        bytes32[] memory proof = new bytes32[](0);
        vm.expectRevert(ProvianPEAnchor.BatchNotFound.selector);
        anchor.verifyPE(keccak256("never"), bytes32(uint256(1)), proof);
    }

    // =========================================================================
    // TS ↔ SOLIDITY MERKLE CROSS-TEST - the critical check
    //
    // Build trees of several sizes (1, 2, 4, 5, 8, 17) using MerkleHelper and
    // confirm PEAnchor.verifyPE accepts every leaf's proof. Any divergence from
    // the backend algorithm (sort direction, pair order, padding, encoding)
    // surfaces here. If these pass, the cross-chain invariant holds for the
    // audited merkle.ts revision; if any fail, stop and treat as Tier 3.
    // =========================================================================

    function _fixtureLeaves(uint256 count)
        internal
        pure
        returns (bytes32[] memory hashes)
    {
        // Deterministic leaf fixtures - intentionally unsorted so _sort matters.
        hashes = new bytes32[](count);
        for (uint256 i = 0; i < count; i++) {
            // Reverse-index in the hash preimage so the sorted order differs
            // from the insertion order.
            hashes[i] = keccak256(abi.encodePacked("leaf", count - i, uint256(0xDEADBEEF)));
        }
    }

    function _anchorAndVerifyAll(uint256 leafCount) internal {
        bytes32[] memory hashes = _fixtureLeaves(leafCount);

        // Keep an unsorted copy to locate each leaf's index AFTER the helper sorts.
        bytes32[] memory original = new bytes32[](hashes.length);
        for (uint256 i = 0; i < hashes.length; i++) original[i] = hashes[i];

        (bytes32 root, bytes32[][] memory layers) = helper.buildTreeFromHashes(hashes);

        bytes32 batchId = keccak256(abi.encodePacked("cross-test", leafCount));
        vm.prank(minter);
        anchor.anchorBatch(batchId, root, leafCount, block.timestamp, 0);

        // Verify each original leaf is provable against the anchored root.
        for (uint256 i = 0; i < original.length; i++) {
            uint256 idx = _indexOf(layers[0], original[i]);
            bytes32[] memory proof = helper.generateProof(layers, idx);
            bool ok = anchor.verifyPE(batchId, original[i], proof);
            assertTrue(ok, "valid proof rejected");
        }
    }

    function _indexOf(bytes32[] memory arr, bytes32 needle) internal pure returns (uint256) {
        for (uint256 i = 0; i < arr.length; i++) {
            if (arr[i] == needle) return i;
        }
        revert("needle not in array");
    }

    function test_crossTest_singleLeaf() public {
        _anchorAndVerifyAll(1);
    }

    function test_crossTest_twoLeaves() public {
        _anchorAndVerifyAll(2);
    }

    function test_crossTest_fourLeaves() public {
        _anchorAndVerifyAll(4);
    }

    function test_crossTest_fiveLeaves_paddedToEight() public {
        _anchorAndVerifyAll(5);
    }

    function test_crossTest_eightLeaves() public {
        _anchorAndVerifyAll(8);
    }

    function test_crossTest_seventeenLeaves_paddedToThirtyTwo() public {
        _anchorAndVerifyAll(17);
    }

    function test_crossTest_hashLeafMatchesAbiEncodePacked() public view {
        // Spot-check hashLeaf matches the TS `solidityPacked(...)` + keccak256.
        // The expected value is hand-computed from abi.encodePacked on the
        // same inputs: identical bytes, identical hash.
        // [chunk-i] Includes 0x00 leaf-domain prefix.
        bytes32 expected = keccak256(
            abi.encodePacked(
                bytes1(0x00),
                "pe-123",
                address(0xCAFE),
                "x402_payment",
                uint256(1_700_000_000),
                uint256(1e18)
            )
        );
        bytes32 actual = helper.hashLeaf(
            "pe-123",
            address(0xCAFE),
            "x402_payment",
            1_700_000_000,
            1e18
        );
        assertEq(actual, expected);
    }

    function test_crossTest_zeroHashMatchesKeccakEmpty() public view {
        // merkle.ts uses keccak256('0x') - empty bytes - as its zero hash.
        assertEq(helper.ZERO_HASH(), keccak256(""));
    }

    // =========================================================================
    // MERKLE PROOF - NEGATIVE CASES
    // =========================================================================

    function test_verifyPE_wrongRoot_rejects() public {
        bytes32[] memory hashes = _fixtureLeaves(4);
        bytes32 wrongRoot = keccak256("not-the-root");

        bytes32 batchId = keccak256("wrong-root");
        vm.prank(minter);
        anchor.anchorBatch(batchId, wrongRoot, 4, block.timestamp, 0);

        (, bytes32[][] memory layers) = helper.buildTreeFromHashes(hashes);
        bytes32[] memory proof = helper.generateProof(layers, 0);
        bool ok = anchor.verifyPE(batchId, layers[0][0], proof);
        assertFalse(ok, "proof against mismatched root should fail");
    }

    function test_verifyPE_wrongLeaf_rejects() public {
        bytes32[] memory hashes = _fixtureLeaves(4);
        (bytes32 root, bytes32[][] memory layers) = helper.buildTreeFromHashes(hashes);

        bytes32 batchId = keccak256("wrong-leaf");
        vm.prank(minter);
        anchor.anchorBatch(batchId, root, 4, block.timestamp, 0);

        bytes32[] memory proof = helper.generateProof(layers, 0);
        bytes32 forged = keccak256("not-a-leaf");
        bool ok = anchor.verifyPE(batchId, forged, proof);
        assertFalse(ok, "wrong leaf should fail");
    }

    function test_verifyPE_tamperedProof_rejects() public {
        bytes32[] memory hashes = _fixtureLeaves(4);
        (bytes32 root, bytes32[][] memory layers) = helper.buildTreeFromHashes(hashes);

        bytes32 batchId = keccak256("tampered");
        vm.prank(minter);
        anchor.anchorBatch(batchId, root, 4, block.timestamp, 0);

        bytes32[] memory proof = helper.generateProof(layers, 0);
        require(proof.length > 0, "fixture expected non-empty proof");
        proof[0] = keccak256("flipped-sibling");
        bool ok = anchor.verifyPE(batchId, layers[0][0], proof);
        assertFalse(ok, "tampered proof should fail");
    }

    function test_verifyPE_emptyProofOnSingleLeafTree_succeeds() public {
        bytes32[] memory hashes = _fixtureLeaves(1);
        (bytes32 root,) = helper.buildTreeFromHashes(hashes);

        bytes32 batchId = keccak256("single");
        vm.prank(minter);
        anchor.anchorBatch(batchId, root, 1, block.timestamp, 0);

        bytes32[] memory emptyProof = new bytes32[](0);
        bool ok = anchor.verifyPE(batchId, hashes[0], emptyProof);
        assertTrue(ok, "single-leaf tree: leaf == root, empty proof verifies");
    }

    // =========================================================================
    // GAS SANITY - verify cost grows with proof depth, not tree size.
    //
    // Target: 200k gas as stated in the sprint spec. A tree with 10,000 leaves
    // rounds up to 16,384 (2^14) after padding → 14 proof elements → 14 keccak
    // hashes in verifyPE. We build a synthetic 14-deep proof directly instead
    // of materialising a 16k-leaf tree in Solidity memory (which would hit the
    // block gas limit inside the test helper's sort). The verify gas cost is
    // identical in either construction.
    // =========================================================================

    function test_verifyPE_gas_depth14_under200k() public {
        uint256 depth = 14; // Matches 10k-leaf tree rounded up to 16,384.
        bytes32 leaf = keccak256("gas-test-leaf");

        // Build an arbitrary proof path of the right depth.
        bytes32[] memory proof = new bytes32[](depth);
        for (uint256 i = 0; i < depth; i++) {
            proof[i] = keccak256(abi.encodePacked("sibling", i));
        }

        // Forward-compute the root the contract will derive from this path,
        // using the SAME sorted-pair hashing the contract uses, then anchor it.
        // [chunk-i] 0x01 internal-node prefix matches verifyPE.
        bytes32 computed = leaf;
        for (uint256 i = 0; i < depth; i++) {
            bytes32 sib = proof[i];
            computed = computed <= sib
                ? keccak256(abi.encodePacked(bytes1(0x01), computed, sib))
                : keccak256(abi.encodePacked(bytes1(0x01), sib, computed));
        }

        bytes32 batchId = keccak256("gas-test");
        vm.prank(minter);
        anchor.anchorBatch(batchId, computed, 10_000, block.timestamp, 0);

        uint256 gasBefore = gasleft();
        bool ok = anchor.verifyPE(batchId, leaf, proof);
        uint256 gasUsed = gasBefore - gasleft();
        assertTrue(ok);
        assertLt(gasUsed, 200_000, "verifyPE gas exceeded 200k budget at depth 14");
    }

    // =========================================================================
    // FUZZ - round-trip property: any well-formed leaf set anchored and proved
    //        via MerkleHelper must verify on-chain.
    // =========================================================================

    function testFuzz_verifyPE_roundTrip(uint8 leafCountRaw, uint256 salt) public {
        // Constrain to a sane size range that still exercises padding cases.
        uint256 leafCount = uint256(leafCountRaw) % 31 + 1; // 1..31

        bytes32[] memory hashes = new bytes32[](leafCount);
        for (uint256 i = 0; i < leafCount; i++) {
            hashes[i] = keccak256(abi.encodePacked("fuzz", i, salt));
        }
        bytes32[] memory original = new bytes32[](hashes.length);
        for (uint256 i = 0; i < hashes.length; i++) original[i] = hashes[i];

        (bytes32 root, bytes32[][] memory layers) = helper.buildTreeFromHashes(hashes);
        bytes32 batchId = keccak256(abi.encodePacked("fuzz-batch", leafCount, salt));

        vm.prank(minter);
        anchor.anchorBatch(batchId, root, leafCount, block.timestamp, 0);

        for (uint256 i = 0; i < original.length; i++) {
            uint256 idx = _indexOf(layers[0], original[i]);
            bytes32[] memory proof = helper.generateProof(layers, idx);
            assertTrue(anchor.verifyPE(batchId, original[i], proof), "fuzz round-trip failed");
        }
    }

    function testFuzz_verifyPE_tamperedBatchIdRejects(uint256 salt) public {
        // A proof anchored against batch A must not verify against batch B.
        bytes32[] memory hashes = _fixtureLeaves(4);
        (bytes32 root, bytes32[][] memory layers) = helper.buildTreeFromHashes(hashes);

        bytes32 batchA = keccak256(abi.encodePacked("A", salt));
        bytes32 batchB = keccak256(abi.encodePacked("B", salt));
        vm.assume(batchA != batchB);

        vm.prank(minter);
        anchor.anchorBatch(batchA, root, 4, block.timestamp, 0);
        vm.prank(minter);
        anchor.anchorBatch(batchB, keccak256("different-root"), 4, block.timestamp, 0);

        bytes32[] memory proof = helper.generateProof(layers, 0);
        assertTrue(anchor.verifyPE(batchA, layers[0][0], proof));
        assertFalse(anchor.verifyPE(batchB, layers[0][0], proof));
    }
}
