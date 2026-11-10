// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ProvianHashAccount} from "./ProvianHashAccount.sol";

/// @notice Permanent discovery address for the current protocol deployment.
/// Clients read this contract directly on Base and verify the returned runtime hashes.
/// Updating discovery neither moves assets nor gives the updater token custody.
contract ProvianProtocolPointer {
    // kernel, eligibility verifier, beneficiary verifier, escrow, promises,
    // project pool, bonds, court, Recourse Pool, settlement adapter.
    uint256 public constant COMPONENT_COUNT = 10;
    // Signing commitments rotate inside this curve-independent account. Discovery
    // can never be handed back to a curve-based key or arbitrary contract.
    address public immutable authority;
    uint256 public revision;
    bytes32 public manifestHash;
    address[10] private components;
    bytes32[10] private runtimeHashes;
    mapping(address => bool) public retired;
    error Unauthorized();
    error InvalidManifest();
    error StaleRevision();
    event DeploymentChanged(uint256 indexed revision, bytes32 indexed manifestHash, address[10] components, bytes32[10] runtimeHashes);
    event LegacyContractRetired(address indexed target, bytes32 runtimeHash);

    constructor(address authority_) {
        if (authority_.codehash != keccak256(type(ProvianHashAccount).runtimeCode)
            || ProvianHashAccount(payable(authority_)).keyCommitment() == bytes32(0)) revert InvalidManifest();
        authority = authority_;
    }

    function current() external view returns (uint256, bytes32, address[10] memory, bytes32[10] memory) {
        if (revision == 0) revert InvalidManifest();
        return (revision, manifestHash, components, runtimeHashes);
    }

    function component(uint256 index) external view returns (address target) {
        if (revision == 0 || index >= COMPONENT_COUNT) revert InvalidManifest();
        target = components[index];
        if (index == 2 && target == address(0)) return target;
        if (target.codehash != runtimeHashes[index] || retired[target]) revert InvalidManifest();
    }
    /// @notice Before the first manifest, record the deployments that predate
    /// this pointer. After publication only replacement of a current component
    /// can retire an address; there is no general transaction-denial setter.
    function registerLegacyRetirements(address[] calldata targets, bytes32[] calldata hashes) external {
        if (msg.sender != authority) revert Unauthorized();
        if (revision != 0 || targets.length != hashes.length) revert InvalidManifest();
        for (uint256 i; i < targets.length; ++i) {
            address target = targets[i];
            if (target.code.length == 0 || target == address(this) || hashes[i] != target.codehash) revert InvalidManifest();
            retired[target] = true;
            emit LegacyContractRetired(target, hashes[i]);
        }
    }
    /// @notice Atomic complete-set replacement; a retired address can never return.
    /// Expected revision prevents a stale operator transaction overwriting a newer set.
    function publish(uint256 expectedRevision, address[10] calldata next, bytes32[10] calldata hashes) external {
        if (msg.sender != authority) revert Unauthorized();
        if (revision != expectedRevision) revert StaleRevision();
        // A pool holds token-specific member obligations. Replacing it while
        // retaining that token would strand those obligations outside the
        // current reserve's accounting and reversal protection.
        if (revision != 0 && next[8] != components[8] && next[0] == components[0]) revert InvalidManifest();
        if (revision != 0 && next[0] == components[0]) {
            for (uint256 slot = 3; slot <= 7; ++slot) {
                if (slot != 4 && next[slot] != components[slot]) revert InvalidManifest();
            }
        }
        for (uint256 i; i < COMPONENT_COUNT; ++i) {
            if (i == 2 && next[i] == address(0) && hashes[i] == bytes32(0)) continue;
            if (next[i].code.length == 0 || retired[next[i]] || hashes[i] != next[i].codehash) revert InvalidManifest();
            for (uint256 j; j < i; ++j) if (next[i] == next[j]) revert InvalidManifest();
            // A live component cannot silently change roles in a later manifest.
            for (uint256 j; j < COMPONENT_COUNT; ++j) {
                if (i != j && next[i] == components[j]) revert InvalidManifest();
            }
        }
        for (uint256 i; i < COMPONENT_COUNT; ++i) {
            if (components[i] != address(0) && components[i] != next[i]) retired[components[i]] = true;
        }
        components = next;
        runtimeHashes = hashes;
        ++revision;
        manifestHash = keccak256(abi.encode(block.chainid, address(this), revision, next, hashes));
        emit DeploymentChanged(revision, manifestHash, next, hashes);
    }

    /// @notice Rejects stale or replaced targets immediately before a client signs.
    function requireCurrent(uint256 expectedRevision, uint256 componentIndex, address target) external view {
        if (expectedRevision != revision) revert StaleRevision();
        if (revision == 0 || componentIndex >= COMPONENT_COUNT || components[componentIndex] != target
            || retired[target] || target.codehash != runtimeHashes[componentIndex]) revert InvalidManifest();
    }

}
