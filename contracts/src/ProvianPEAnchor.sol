// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ProvianPEAnchor
 * @notice On-chain Merkle root storage for Provenance Envelope batches.
 *         Stores batch roots, verifies individual PE inclusion via Merkle proofs.
 * @dev This token-agnostic legacy deployment is reused by the live v8 stack.
 *      Its admin/minter roles are operational anchoring roles, not PVT9 economic
 *      setters and not an alternate gate on Frank's bootstrap authority. Gate 1
 *      authorizes no admin transfer or authority handoff.
 */
contract ProvianPEAnchor {

    // =========================================================================
    // Types
    // =========================================================================

    struct Batch {
        bytes32 merkleRoot;
        uint256 peCount;
        uint256 timestamp;
        uint256 epochNumber;
        bool exists;
    }

    // =========================================================================
    // State
    // =========================================================================

    address public admin;
    address public minter;                            // Backend minting service (same as PVT minter)

    mapping(bytes32 => Batch) public batches;

    // =========================================================================
    // Events
    // =========================================================================

    event BatchAnchored(
        bytes32 indexed batchId,
        bytes32 indexed merkleRoot,
        uint256 peCount,
        uint256 timestamp,
        uint256 epochNumber
    );
    event MinterUpdated(address indexed oldMinter, address indexed newMinter);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);

    // =========================================================================
    // Errors
    // =========================================================================

    error InvalidAddress();
    error OnlyAdmin();
    error OnlyMinter();
    error BatchAlreadyAnchored();
    error BatchNotFound();
    error InvalidProof();

    // =========================================================================
    // Constructor
    // =========================================================================

    constructor(address _admin, address _minter) {
        if (_admin == address(0) || _minter == address(0)) revert InvalidAddress();
        admin = _admin;
        minter = _minter;
    }

    // =========================================================================
    // Modifiers
    // =========================================================================

    modifier onlyAdmin() {
        if (msg.sender != admin) revert OnlyAdmin();
        _;
    }

    modifier onlyMinter() {
        if (msg.sender != minter) revert OnlyMinter();
        _;
    }

    // =========================================================================
    // Functions
    // =========================================================================

    /**
     * @notice Anchor a PE batch Merkle root on-chain.
     * @param batchId     Unique batch identifier
     * @param merkleRoot  Merkle root of the PE batch
     * @param peCount     Number of PEs in the batch
     * @param timestamp   Batch creation timestamp
     * @param epochNumber PVT epoch number
     */
    function anchorBatch(
        bytes32 batchId,
        bytes32 merkleRoot,
        uint256 peCount,
        uint256 timestamp,
        uint256 epochNumber
    ) external onlyMinter {
        if (batches[batchId].exists) revert BatchAlreadyAnchored();

        batches[batchId] = Batch({
            merkleRoot: merkleRoot,
            peCount: peCount,
            timestamp: timestamp,
            epochNumber: epochNumber,
            exists: true
        });

        emit BatchAnchored(batchId, merkleRoot, peCount, timestamp, epochNumber);
    }

    /**
     * @notice Verify a PE is included in an anchored batch via Merkle proof.
     * @param batchId      The batch to verify against
     * @param peHash       Hash of the PE leaf. Must be the leaf-domain hash
     *                     produced off-chain as
     *                     keccak256(abi.encodePacked(bytes1(0x00), leafData)).
     *                     The 0x00 prefix is leaf domain separation
     *                     (chunk-i): leaves and internal nodes occupy
     *                     disjoint hash spaces, foreclosing second-preimage
     *                     attacks where an internal-node hash could be
     *                     submitted as a leaf.
     * @param merkleProof  Array of sibling hashes (bottom-up)
     * @return valid       True if the proof is valid
     */
    function verifyPE(
        bytes32 batchId,
        bytes32 peHash,
        bytes32[] calldata merkleProof
    ) external view returns (bool valid) {
        Batch storage batch = batches[batchId];
        if (!batch.exists) revert BatchNotFound();

        bytes32 computedHash = peHash;
        for (uint256 i = 0; i < merkleProof.length; i++) {
            bytes32 proofElement = merkleProof[i];
            // [chunk-i] Internal nodes are tagged with 0x01 to occupy a
            // hash space disjoint from leaves (which carry 0x00 in their
            // off-chain construction). Pair sorting is preserved.
            if (computedHash <= proofElement) {
                computedHash = keccak256(abi.encodePacked(bytes1(0x01), computedHash, proofElement));
            } else {
                computedHash = keccak256(abi.encodePacked(bytes1(0x01), proofElement, computedHash));
            }
        }

        return computedHash == batch.merkleRoot;
    }

    /**
     * @notice Get batch details.
     * @param batchId The batch identifier
     * @return merkleRoot The Merkle root
     * @return peCount    Number of PEs
     * @return timestamp  Creation timestamp
     * @return epochNumber PVT epoch
     * @return exists     Whether the batch exists
     */
    function getBatch(bytes32 batchId) external view returns (
        bytes32 merkleRoot,
        uint256 peCount,
        uint256 timestamp,
        uint256 epochNumber,
        bool exists
    ) {
        Batch storage b = batches[batchId];
        return (b.merkleRoot, b.peCount, b.timestamp, b.epochNumber, b.exists);
    }

    /**
     * @notice Update the minter address. Used to rotate the backend signing key.
     * @param newMinter New minter address
     */
    function setMinter(address newMinter) external onlyAdmin {
        if (newMinter == address(0)) revert InvalidAddress();
        address oldMinter = minter;
        minter = newMinter;
        emit MinterUpdated(oldMinter, newMinter);
    }

    /**
     * @notice Legacy admin-transfer capability. Gate 1 does not authorize key
     *         rotation, transfer, or handoff; separate explicit approval is required.
     */
    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert InvalidAddress();
        address oldAdmin = admin;
        admin = newAdmin;
        emit AdminTransferred(oldAdmin, newAdmin);
    }
}
