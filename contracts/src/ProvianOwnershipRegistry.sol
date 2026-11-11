// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {ProvianProtocolPointer} from "./ProvianProtocolPointer.sol";
import {ProvianHashAccount} from "./ProvianHashAccount.sol";
import {RecourseAddressConsent} from "./RecourseAddressConsent.sol";

interface IRegisteredRecourseKernel {
    function registryOperator() external view returns (address);
    function restorationAuthority() external view returns (address);
    function ownerAuthorization() external view returns (address);
    function bindRestorationOwner(bytes32 identity, bytes32 commitment, bytes32 signingRoot) external;
}
interface IRegisteredRecoursePool {
    function registryOperator() external view returns (address);
    function bind(bytes32 identity, address account) external;
}
interface IRegisteredOwnerAuthorization {
    function recoveredDestination(bytes32 identity) external view returns (address);
    function breakOrigin() external view returns (address);
    function predecessor() external view returns (address);
    function lastGoodBlock() external view returns (uint256);
}
/// @notice Each public identifier names one original address and its individual
/// recovery lineage. The owner-to-address portfolio exists only in the relay.
/// An identity attestation AND address possession are required to register;
/// neither signer can replace an existing recovery commitment alone.
contract ProvianOwnershipRegistry {
    ProvianProtocolPointer public immutable pointer;
    address public immutable identityAttestor;
    address public immutable previousRegistry;
    bool public immutable afterCryptographicBreak;
    mapping(address => bytes32) private _ownerOf;
    mapping(address => uint256) private _boundBlock;
    /// @dev The ABI's historical `identity` name means an address binding here,
    /// never a relay owner ID. Independently bound addresses cannot share it.
    function addressBinding(address origin) public view returns (bytes32) {
        if (origin == address(0)) revert InvalidBinding();
        return sha256(abi.encode("Provian address recovery binding", block.chainid, address(pointer), origin));
    }
    function ownerOf(address account) public view returns (bytes32) {
        bytes32 identity = _ownerOf[account];
        return identity != bytes32(0) || previousRegistry == address(0) ? identity
            : ProvianOwnershipRegistry(previousRegistry).ownerOf(account);
    }
    function boundBlock(address account) public view returns (uint256) {
        uint256 bound = _boundBlock[account];
        return bound != 0 || previousRegistry == address(0) ? bound
            : ProvianOwnershipRegistry(previousRegistry).boundBlock(account);
    }
    mapping(bytes32 => bool) public admittedEvidence;
    mapping(bytes32 => bool) public consumedEvidence;
    mapping(bytes32 => bool) public consumedBinding;
    mapping(bytes32 => uint256) public bindingBlock;
    struct Binding {
        bytes32 identity;
        address account;
        bytes32 recoveryCommitment;
        bytes32 signingRoot;
        address kernel;
        bytes32 nonce;
        uint256 expiresAtMs;
    }
    error InvalidBinding();
    event OwnershipBound(bytes32 indexed identity, address indexed account, address indexed kernel,
        bytes32 recoveryCommitment, bytes32 signingRoot, bytes32 digest);
    constructor(ProvianProtocolPointer pointer_, address attestor_, bool afterBreak_) {
        if (address(pointer_).code.length == 0 || attestor_ == address(0)) revert InvalidBinding();
        pointer = pointer_; identityAttestor = attestor_; afterCryptographicBreak = afterBreak_;
        if (afterBreak_ && attestor_.codehash != keccak256(type(ProvianHashAccount).runtimeCode)) revert InvalidBinding();
        // Ordinary succession keeps each historical binding and its original
        // effective block. A break starts new hash-secured address bindings.
        if (pointer_.revision() != 0 && !afterBreak_) {
            address prior = IRegisteredRecourseKernel(pointer_.component(0)).registryOperator();
            if (prior.code.length == 0 || address(ProvianOwnershipRegistry(prior).pointer()) != address(pointer_)) revert InvalidBinding();
            previousRegistry = prior;
        }
    }
    function bindingDigest(Binding calldata b) public view returns (bytes32) {
        bytes memory message = abi.encodePacked("Provian ownership binding\nchain:", Strings.toString(block.chainid),
            "\nkernel:", Strings.toHexString(b.kernel), "\nidentity:", Strings.toHexString(uint256(b.identity), 32),
            "\naddress:", Strings.toHexString(b.account), "\nrecovery:", Strings.toHexString(uint256(b.recoveryCommitment), 32),
            "\nhash-authority:", Strings.toHexString(uint256(b.signingRoot), 32),
            "\nnonce:", Strings.toHexString(uint256(b.nonce), 32), "\nexpires:", Strings.toString(b.expiresAtMs));
        return MessageHashUtils.toEthSignedMessageHash(message);
    }
    function bind(Binding calldata b, bytes calldata ownerSignature, bytes calldata identitySignature, uint256 revision) external {
        _bind(b, ownerSignature, identitySignature, revision, bindingDigest(b));
    }
    function memberBindingDigest(Binding calldata b, RecourseAddressConsent.ConsentAuthorization calldata consent) public view returns (bytes32) {
        return MessageHashUtils.toEthSignedMessageHash(sha256(abi.encode("Provian atomic member address binding",
            block.chainid, address(this), address(pointer), b, consent)));
    }
    /// @notice An existing private member adds one independent address with its
    /// recovery commitment and pool consent in the same transaction. No sibling
    /// identifiers or private membership key enter either signed payload.
    function bindWithConsent(Binding calldata b, bytes calldata ownerSignature, bytes calldata identitySignature,
        uint256 revision, RecourseAddressConsent.ConsentAuthorization calldata consent,
        bytes calldata consentOwnerSignature, bytes calldata consentAttestorSignature) external {
        if (consent.binding != b.identity || consent.account != b.account || !consent.joined
            || consent.revision != revision) revert InvalidBinding();
        // This attestation cannot be stripped and replayed through plain bind.
        _bind(b, ownerSignature, identitySignature, revision, memberBindingDigest(b, consent));
        RecourseAddressConsent(pointer.component(8)).setAddressConsent(consent, consentOwnerSignature, consentAttestorSignature);
    }
    function _bind(Binding calldata b, bytes calldata ownerSignature, bytes calldata identitySignature, uint256 revision, bytes32 identityDigest) private {
        bytes32 existing = ownerOf(b.account);
        // A reset registry must not replace an unissued snapshot owner's
        // independent commitment through a prospective address binding.
        if (existing == bytes32(0) && _boundBeforeBreak(b.account)) revert InvalidBinding();
        if (b.identity == bytes32(0) || b.account == address(0)
            || b.recoveryCommitment == bytes32(0) || b.signingRoot == bytes32(0) || b.nonce == bytes32(0)
            || b.expiresAtMs < block.timestamp * 1000 || b.expiresAtMs > (block.timestamp + 300) * 1000
            || (existing == bytes32(0) ? b.identity != addressBinding(b.account) : existing != b.identity)) revert InvalidBinding();
        // A curve-independent attestor admits only curve-independent accounts.
        // This preserves secure prospective binding after a cryptographic break.
        if (identityAttestor.codehash == keccak256(type(ProvianHashAccount).runtimeCode)
            && b.account.codehash != identityAttestor.codehash) revert InvalidBinding();
        pointer.requireCurrent(revision, 0, b.kernel);
        (,, address[10] memory components,) = pointer.current();
        address pool = components[8];
        if (IRegisteredRecourseKernel(b.kernel).registryOperator() != address(this)
            || IRegisteredRecoursePool(pool).registryOperator() != address(this)) revert InvalidBinding();
        bytes32 digest = bindingDigest(b);
        if (identityAttestor == IRegisteredRecourseKernel(b.kernel).restorationAuthority()
            || consumedBinding[digest] || !SignatureChecker.isValidSignatureNow(b.account, digest, ownerSignature)
            || !SignatureChecker.isValidSignatureNow(identityAttestor, identityDigest, identitySignature)) revert InvalidBinding();
        consumedBinding[digest] = true;
        bindingBlock[digest] = block.number;
        _ownerOf[b.account] = b.identity;
        if (boundBlock(b.account) == 0) _boundBlock[b.account] = block.number;
        IRegisteredRecourseKernel(b.kernel).bindRestorationOwner(b.identity, b.recoveryCommitment, b.signingRoot);
        IRegisteredRecoursePool(pool).bind(b.identity, b.account);
        emit OwnershipBound(b.identity, b.account, b.kernel, b.recoveryCommitment, b.signingRoot, digest);
    }
    /// @dev First-bound blocks are append-only. Even a broken old signing key
    /// cannot backdate a new binding into a published cutoff. Follow earlier
    /// origins too: an unclaimed entitlement may survive several resets and
    /// ordinary successors. Recovery enters through bindRecovered instead.
    function _boundBeforeBreak(address account) private view returns (bool) {
        address origin = IRegisteredOwnerAuthorization(
            IRegisteredRecourseKernel(pointer.component(0)).ownerAuthorization()).breakOrigin();
        uint256 ceiling = type(uint256).max;
        while (origin != address(0)) {
            IRegisteredOwnerAuthorization history = IRegisteredOwnerAuthorization(origin);
            uint256 cutoff = history.lastGoodBlock();
            if (cutoff == 0 || cutoff >= ceiling) revert InvalidBinding();
            address previousKernel = history.predecessor();
            ProvianOwnershipRegistry previous = ProvianOwnershipRegistry(
                IRegisteredRecourseKernel(previousKernel).registryOperator());
            if (address(previous.pointer()) != address(pointer)) revert InvalidBinding();
            uint256 bound = previous.boundBlock(account);
            if (bound != 0 && bound <= cutoff) return true;
            ceiling = cutoff;
            origin = IRegisteredOwnerAuthorization(
                IRegisteredRecourseKernel(previousKernel).ownerAuthorization()).breakOrigin();
        }
        return false;
    }
    event RecoveredAddressBound(bytes32 indexed identity, address indexed account, address indexed kernel);
    /// @notice The immutable executor has just consumed the independent owner
    /// proof. A recovered address retains that identity for future recourse.
    function bindRecovered(bytes32 identity, address account) external {
        address kernel = pointer.component(0);
        if (msg.sender != IRegisteredRecourseKernel(kernel).ownerAuthorization() || identity == bytes32(0)
            || account == address(0) || IRegisteredOwnerAuthorization(msg.sender).recoveredDestination(identity) != account
            || (ownerOf(account) != bytes32(0) && ownerOf(account) != identity)) revert InvalidBinding();
        _ownerOf[account] = identity;
        if (boundBlock(account) == 0) _boundBlock[account] = block.number;
        address pool = pointer.component(8);
        if (IRegisteredRecoursePool(pool).registryOperator() != address(this)) revert InvalidBinding();
        IRegisteredRecoursePool(pool).bind(identity, account);
        emit RecoveredAddressBound(identity, account, kernel);
    }

    struct TheftEvidence {
        address kernel; bytes32 operation; bytes32 identity; address lossAccount;
        uint256 lossBlock; bytes32 checkpointHash; bytes32 membershipHash; uint256 revision;
        uint256 bindingLogIndex; uint256 lossLogIndex;
    }
    /// @dev Historical evidence does not revive an old address's bind or spend
    /// authority. Append-only first-bound blocks cannot be backdated after a
    /// reset, and only a registry at a cutoff containing the loss can attest it.
    function _evidenceBindingBlock(address account, bytes32 identity, uint256 lossBlock) private view returns (uint256) {
        uint256 current = boundBlock(account);
        if (ownerOf(account) == identity && current != 0 && current <= lossBlock) return current;
        address origin = IRegisteredOwnerAuthorization(
            IRegisteredRecourseKernel(pointer.component(0)).ownerAuthorization()).breakOrigin();
        uint256 ceiling = type(uint256).max;
        while (origin != address(0)) {
            IRegisteredOwnerAuthorization history = IRegisteredOwnerAuthorization(origin);
            uint256 cutoff = history.lastGoodBlock();
            if (cutoff == 0 || cutoff >= ceiling) revert InvalidBinding();
            if (cutoff < lossBlock) return 0;
            address historicalKernel = history.predecessor();
            ProvianOwnershipRegistry previous = ProvianOwnershipRegistry(
                IRegisteredRecourseKernel(historicalKernel).registryOperator());
            if (address(previous.pointer()) != address(pointer)) revert InvalidBinding();
            uint256 bound = previous.boundBlock(account);
            if (previous.ownerOf(account) == identity && bound != 0 && bound <= lossBlock) return bound;
            ceiling = cutoff;
            origin = IRegisteredOwnerAuthorization(
                IRegisteredRecourseKernel(historicalKernel).ownerAuthorization()).breakOrigin();
        }
        return 0;
    }
    event TheftEvidenceAdmitted(bytes32 indexed operation, bytes32 indexed identity, bytes32 digest);
    function evidenceDigest(TheftEvidence calldata e) public view returns (bytes32) {
        return MessageHashUtils.toEthSignedMessageHash(sha256(abi.encode("Provian theft evidence", block.chainid, address(this), e)));
    }
    function admitTheftEvidence(TheftEvidence calldata e, bytes calldata signature) external {
        pointer.requireCurrent(e.revision, 0, e.kernel);
        uint256 bound = _evidenceBindingBlock(e.lossAccount, e.identity, e.lossBlock);
        if (e.operation == bytes32(0) || e.identity == bytes32(0) || e.checkpointHash == bytes32(0)
            || e.membershipHash == bytes32(0) || e.lossBlock >= block.number
            || bound == 0
            || (bound == e.lossBlock && e.lossLogIndex <= e.bindingLogIndex)
            || identityAttestor == IRegisteredRecourseKernel(e.kernel).restorationAuthority()
            || IRegisteredRecourseKernel(e.kernel).registryOperator() != address(this)
            || !SignatureChecker.isValidSignatureNow(identityAttestor, evidenceDigest(e), signature)) revert InvalidBinding();
        bytes32 key = keccak256(abi.encode(e.kernel, e.operation, e.revision));
        if (consumedEvidence[key]) revert InvalidBinding();
        admittedEvidence[key] = true;
        emit TheftEvidenceAdmitted(e.operation, e.identity, evidenceDigest(e));
    }
    function consumeTheftEvidence(bytes32 operation, uint256 revision) external returns (bytes32) {
        address kernel = pointer.component(0);
        pointer.requireCurrent(revision, 0, kernel);
        if (msg.sender != IRegisteredRecourseKernel(kernel).ownerAuthorization()
            || identityAttestor == IRegisteredRecourseKernel(kernel).restorationAuthority()) revert InvalidBinding();
        bytes32 key = keccak256(abi.encode(kernel, operation, revision));
        if (!admittedEvidence[key] || consumedEvidence[key]) revert InvalidBinding();
        consumedEvidence[key] = true;
        return operation;
    }
}
