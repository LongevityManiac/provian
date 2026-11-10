// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {SlhDsaSha2128s} from "./crypto/SlhDsaSha2128s.sol";

/// @notice Curve-independent account using stateless SLH-DSA-SHA2-128s signatures.
/// The nonce binds each execution, while root rotation is signed by its predecessor.
contract ProvianHashAccount {
    bytes32 public keyCommitment;
    uint256 public nonce;
    mapping(bytes32 => bool) public usedCommitment;
    bool private executing;

    error InvalidKey();
    error InvalidSignature();
    error ReentrantCall();
    error InsufficientExecutionGas();
    event Executed(uint256 indexed nonce, address indexed target, bool success);

    constructor(bytes32 initialKeyCommitment) {
        if (initialKeyCommitment == bytes32(0)) revert InvalidKey();
        keyCommitment = initialKeyCommitment;
        usedCommitment[initialKeyCommitment] = true;
    }

    receive() external payable {}

    /// @notice Contract-signature domain for ownership and identity attestations.
    /// These signatures cannot be replayed as account executions or on another
    /// chain/account. Callers retain their own nonce and expiry requirements.
    function signatureDigest(bytes32 digest) public view returns (bytes32) {
        return sha256(abi.encode("Provian hash account signature", block.chainid,
            address(this), keyCommitment, digest));
    }
    function isValidSignature(bytes32 digest, bytes calldata proof) external view returns (bytes4) {
        if (proof.length != 32 + 7856) return bytes4(0xffffffff);
        bytes calldata publicKey = proof[:32];
        bytes calldata signature = proof[32:];
        return sha256(publicKey) == keyCommitment
            && SlhDsaSha2128s.verify(signatureDigest(digest), signature, publicKey)
            ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }

    function intentDigest(address target, uint256 value, uint256 callGas, bytes calldata data, bytes32 nextCommitment)
        public view returns (bytes32)
    {
        return sha256(abi.encode("Provian hash account", block.chainid, address(this), nonce,
            target, value, callGas, sha256(data), nextCommitment));
    }

    /// @dev A failed target call still consumes the nonce and installs its signed successor.
    function execute(address target, uint256 value, uint256 callGas, bytes calldata data, bytes32 nextCommitment,
        bytes calldata publicKey, bytes calldata signature
    ) external returns (bool success) {
        if (executing) revert ReentrantCall();
        if (nextCommitment == bytes32(0) || usedCommitment[nextCommitment]) revert InvalidKey();
        if (sha256(publicKey) != keyCommitment || !SlhDsaSha2128s.verify(
            intentDigest(target, value, callGas, data, nextCommitment), signature, publicKey)) revert InvalidSignature();
        executing = true;
        uint256 usedNonce = nonce++;
        keyCommitment = nextCommitment;
        usedCommitment[nextCommitment] = true;
        // Do not copy attacker-sized return data into memory.
        bytes memory callData = data;
        if (gasleft() < callGas + callGas / 63 + 50_000) revert InsufficientExecutionGas();
        assembly ("memory-safe") {
            success := call(callGas, target, value, add(callData, 32), mload(callData), 0, 0)
        }
        executing = false;
        emit Executed(usedNonce, target, success);
    }
}
