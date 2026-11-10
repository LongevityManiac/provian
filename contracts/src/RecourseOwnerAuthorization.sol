// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ProvianOwnerProofVerifier} from "./crypto/ProvianOwnerProofVerifier.sol";

/// @notice Curve-independent, destination-bound consent for restoration.
/// At bind the owner commits SHA256(recoverySecret || signingRoot).
/// The signing key is independently generated/domain-derived; it MUST NOT be
/// derived from recoverySecret, whose preimage is revealed in a restoration.
interface IPriorOwnerAuthorization {
    function ownerRecoveryCommitment(bytes32 identity) external view returns (bytes32);
    function ownerSigningRoot(bytes32 identity) external view returns (bytes32);
    function ownerAuthorizationNonce(bytes32 identity) external view returns (uint256);
    function ownerUsedSigningRoot(bytes32 identity, bytes32 root) external view returns (bool);
    function ownerUsedRecoveryCommitment(bytes32 identity, bytes32 commitment) external view returns (bool);
}
abstract contract RecourseOwnerAuthorization {
    // Constructed here rather than supplied by a caller. Solidity emits a
    // STATICCALL to its verifier; no proof can replace this implementation.
    ProvianOwnerProofVerifier private immutable proofVerifier = new ProvianOwnerProofVerifier();
    struct OwnerProof {
        bytes32 recoverySecret;
        bytes32 signingRoot;
        bytes32 nextCommitment;
        bytes32 nextSigningRoot;
        bytes publicKey;
        bytes signature;
    }
    mapping(bytes32 => bytes32) private _ownerRecoveryCommitment;
    mapping(bytes32 => bytes32) private _ownerSigningRoot;
    mapping(bytes32 => uint256) private _ownerAuthorizationNonce;
    mapping(bytes32 => mapping(bytes32 => bool)) private _ownerUsedSigningRoot;
    mapping(bytes32 => mapping(bytes32 => bool)) private _ownerUsedRecoveryCommitment;
    error InvalidOwnerAuthorization();
    event OwnerAuthorizationBound(bytes32 indexed identity, bytes32 commitment, bytes32 signingRoot);
    event OwnerAuthorizationConsumed(bytes32 indexed identity, uint256 nonce, bytes32 indexed intent, bytes32 nextCommitment, bytes32 nextSigningRoot);

    function _priorAuthorization() internal view virtual returns (address) { return address(0); }
    function ownerRecoveryCommitment(bytes32 identity) public view returns (bytes32) {
        if (_ownerRecoveryCommitment[identity] != bytes32(0) || _priorAuthorization() == address(0)) return _ownerRecoveryCommitment[identity];
        return IPriorOwnerAuthorization(_priorAuthorization()).ownerRecoveryCommitment(identity);
    }
    function ownerSigningRoot(bytes32 identity) public view returns (bytes32) {
        if (_ownerRecoveryCommitment[identity] != bytes32(0) || _priorAuthorization() == address(0)) return _ownerSigningRoot[identity];
        return IPriorOwnerAuthorization(_priorAuthorization()).ownerSigningRoot(identity);
    }
    function ownerAuthorizationNonce(bytes32 identity) public view returns (uint256) {
        if (_ownerRecoveryCommitment[identity] != bytes32(0) || _priorAuthorization() == address(0)) return _ownerAuthorizationNonce[identity];
        return IPriorOwnerAuthorization(_priorAuthorization()).ownerAuthorizationNonce(identity);
    }
    function ownerUsedSigningRoot(bytes32 identity, bytes32 root) public view returns (bool) {
        return _ownerUsedSigningRoot[identity][root] || (_priorAuthorization() != address(0)
            && IPriorOwnerAuthorization(_priorAuthorization()).ownerUsedSigningRoot(identity, root));
    }
    function ownerUsedRecoveryCommitment(bytes32 identity, bytes32 commitment) public view returns (bool) {
        return _ownerUsedRecoveryCommitment[identity][commitment] || (_priorAuthorization() != address(0)
            && IPriorOwnerAuthorization(_priorAuthorization()).ownerUsedRecoveryCommitment(identity, commitment));
    }
    /// @dev A retired executor is immutable and cannot execute after the pointer
    /// changes. Its current generation and complete used-key history remain the
    /// authority for an ordinary successor; no caller supplies replacement state.
    function _inheritOwner(bytes32 identity) private {
        if (_ownerRecoveryCommitment[identity] != bytes32(0) || _priorAuthorization() == address(0)) return;
        IPriorOwnerAuthorization prior = IPriorOwnerAuthorization(_priorAuthorization());
        _ownerRecoveryCommitment[identity] = prior.ownerRecoveryCommitment(identity);
        _ownerSigningRoot[identity] = prior.ownerSigningRoot(identity);
        _ownerAuthorizationNonce[identity] = prior.ownerAuthorizationNonce(identity);
    }
    /// @dev Integrating registry authenticates first ownership binding. It cannot
    /// replace an existing owner's authorization, even with its operator key.
    function _bindOwnerAuthorization(bytes32 identity, bytes32 commitment, bytes32 signingRoot) internal {
        _inheritOwner(identity);
        if (identity == bytes32(0) || commitment == bytes32(0) || signingRoot == bytes32(0)) revert InvalidOwnerAuthorization();
        if (_ownerRecoveryCommitment[identity] != bytes32(0)) {
            if (_ownerRecoveryCommitment[identity] != commitment || _ownerSigningRoot[identity] != signingRoot) revert InvalidOwnerAuthorization();
            return;
        }
        _ownerRecoveryCommitment[identity] = commitment;
        _ownerSigningRoot[identity] = signingRoot;
        _ownerUsedSigningRoot[identity][signingRoot] = true;
        _ownerUsedRecoveryCommitment[identity][commitment] = true;
        emit OwnerAuthorizationBound(identity, commitment, signingRoot);
    }
    function _ownerAuthorizationTarget() internal view virtual returns (address) { return address(this); }
    /// @notice The operation hash binds either the exact reversal or a bounded
    /// loss intent and its recovery destination. Kernel/chain/nonce prevent cross-use.
    function ownerAuthorizationDigest(bytes32 identity, bytes32 operationHash,
        bytes32 nextCommitment, bytes32 nextSigningRoot) public view returns (bytes32) {
        return sha256(abi.encode("Provian restoration owner authorization", block.chainid,
            _ownerAuthorizationTarget(), identity, ownerRecoveryCommitment(identity), ownerAuthorizationNonce(identity), operationHash,
            nextCommitment, nextSigningRoot));
    }
    /// @dev Value-moving restoration additionally requires restoration authority.
    /// State rolls back with a failed operation. Stateless hash signatures remain
    /// secure when an owner restores an earlier encrypted backup.
    function _consumeOwnerAuthorization(bytes32 identity, bytes32 operationHash, OwnerProof calldata proof) internal {
        _inheritOwner(identity);
        if (identity == bytes32(0) || operationHash == bytes32(0) || proof.nextCommitment == bytes32(0)
            || proof.nextSigningRoot == bytes32(0) || ownerUsedSigningRoot(identity, proof.nextSigningRoot)
            || ownerUsedRecoveryCommitment(identity, proof.nextCommitment)
            || proof.signingRoot != _ownerSigningRoot[identity]
            || sha256(abi.encodePacked(proof.recoverySecret, proof.signingRoot)) != _ownerRecoveryCommitment[identity]
            || sha256(proof.publicKey) != proof.signingRoot) revert InvalidOwnerAuthorization();
        bytes32 intent = ownerAuthorizationDigest(identity, operationHash, proof.nextCommitment, proof.nextSigningRoot);
        if (!proofVerifier.verify(intent, proof.signature, proof.publicKey)) revert InvalidOwnerAuthorization();
        uint256 nonce = _ownerAuthorizationNonce[identity]++;
        _ownerRecoveryCommitment[identity] = proof.nextCommitment;
        _ownerSigningRoot[identity] = proof.nextSigningRoot;
        _ownerUsedSigningRoot[identity][proof.nextSigningRoot] = true;
        _ownerUsedRecoveryCommitment[identity][proof.nextCommitment] = true;
        emit OwnerAuthorizationConsumed(identity, nonce, intent, proof.nextCommitment, proof.nextSigningRoot);
    }
}
