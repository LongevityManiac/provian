// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {SlhTestSigner} from "./helpers/SlhTestSigner.sol";
import {ProvianOwnershipRegistry} from "../src/ProvianOwnershipRegistry.sol";
import {ProvianHashAccount} from "../src/ProvianHashAccount.sol";
import {ProvianProtocolPointer} from "../src/ProvianProtocolPointer.sol";
import {ProvianRestorationAuthorization} from "../src/ProvianRestorationAuthorization.sol";
import {RecourseOwnerAuthorization} from "../src/RecourseOwnerAuthorization.sol";

// Real registry, authorization and hash signatures; adapters isolate their
// binding/restoration boundary from unrelated monetary history imports.
contract SnapshotBindingKernel {
    address public registryOperator;
    address public restorationAuthority;
    ProvianRestorationAuthorization public ownerAuthorization;
    ProvianProtocolPointer public protocolPointer;
    mapping(address => uint256) public balanceOf;
    constructor(address registry, ProvianProtocolPointer p, address authority) {
        registryOperator = registry; protocolPointer = p; restorationAuthority = authority;
    }
    function setAuthorization(ProvianRestorationAuthorization auth) external { require(address(ownerAuthorization) == address(0)); ownerAuthorization = auth; }
    function bindRestorationOwner(bytes32 id, bytes32 commitment, bytes32 root) external {
        require(msg.sender == registryOperator); ownerAuthorization.bind(id, commitment, root);
    }
    function importAuthorizedBalance(address destination, uint256 amount) external {
        require(msg.sender == address(ownerAuthorization)); balanceOf[destination] += amount;
    }
}
contract SnapshotBindingPool {
    address public registryOperator;
    constructor(address registry) { registryOperator = registry; }
    function poolHistoryReady() external pure returns (bool) { return true; }
    function requiresSnapshotRecovery(bytes32) external pure returns (bool) { return false; }
    function bind(bytes32, address) external view { require(msg.sender == registryOperator); }
}
contract ProvianOwnershipRegistrySnapshotTest is SlhTestSigner {
    ProvianProtocolPointer pointer;
    ProvianHashAccount oldAccount;
    ProvianHashAccount lateAccount;
    ProvianHashAccount attestor;
    ProvianHashAccount authority;
    ProvianOwnershipRegistry registry;
    SnapshotBindingKernel kernel;
    SnapshotBindingPool pool;
    ProvianRestorationAuthorization authorization;
    bytes32 identity;
    bytes32 secret;
    bytes32 ownerRoot;
    bytes32 commitment;
    uint256 revision;
    function _publish() private {
        address[10] memory targets; bytes32[10] memory hashes;
        for (uint256 i; i < 10; ++i) { targets[i] = address(uint160(100 + i)); vm.etch(targets[i], hex"00"); hashes[i] = targets[i].codehash; }
        targets[0] = address(kernel); hashes[0] = address(kernel).codehash;
        targets[8] = address(pool); hashes[8] = address(pool).codehash;
        vm.prank(pointer.authority()); pointer.publish(revision++, targets, hashes);
    }
    function _bind(ProvianHashAccount account, uint8 spendingSeed, bytes32 recovery) private {
        _bindChecked(account, spendingSeed, recovery, false);
    }
    function _bindChecked(ProvianHashAccount account, uint8 spendingSeed, bytes32 recovery, bool reject) private {
        ProvianOwnershipRegistry.Binding memory b = ProvianOwnershipRegistry.Binding(registry.addressBinding(address(account)),
            address(account), recovery, ownerRoot, address(kernel), sha256(abi.encode("binding TEST ONLY", revision, address(account))), 1_200_000);
        bytes32 digest = registry.bindingDigest(b);
        (bytes memory publicKey, bytes memory signature) = slhSign(spendingSeed, account.signatureDigest(digest));
        (bytes memory attestorKey, bytes memory attestorSignature) = slhSign(2, attestor.signatureDigest(digest));
        if (reject) vm.expectRevert(ProvianOwnershipRegistry.InvalidBinding.selector);
        registry.bind(b, abi.encodePacked(publicKey, signature), abi.encodePacked(attestorKey, attestorSignature), revision);
    }
    function _succeed(bool broken, uint256 cutoff) private {
        address previous = address(kernel);
        registry = new ProvianOwnershipRegistry(pointer, address(attestor), broken);
        kernel = new SnapshotBindingKernel(address(registry), pointer, address(authority)); pool = new SnapshotBindingPool(address(registry));
        bytes32 root = broken ? sha256(abi.encode("Provian restoration", previous, cutoff, identity, uint256(123 ether), commitment)) : sha256("ordinary snapshot TEST ONLY");
        authorization = new ProvianRestorationAuthorization(address(kernel), root, previous, cutoff, broken,
            keccak256(type(ProvianHashAccount).runtimeCode), broken ? 0 : 123 ether);
        kernel.setAuthorization(authorization); _publish();
    }
    function setUp() public {
        vm.chainId(8453); vm.warp(1000); vm.roll(100);
        oldAccount = new ProvianHashAccount(sha256(slhPublic(1))); lateAccount = new ProvianHashAccount(sha256(slhPublic(7)));
        attestor = new ProvianHashAccount(sha256(slhPublic(2))); authority = new ProvianHashAccount(sha256(slhPublic(6)));
        pointer = new ProvianProtocolPointer(address(new ProvianHashAccount(sha256("pointer TEST ONLY"))));
        registry = new ProvianOwnershipRegistry(pointer, address(attestor), false);
        kernel = new SnapshotBindingKernel(address(registry), pointer, address(authority)); pool = new SnapshotBindingPool(address(registry));
        authorization = new ProvianRestorationAuthorization(address(kernel), sha256("initial root TEST ONLY"), address(0x1234), 25, false,
            keccak256(type(ProvianHashAccount).runtimeCode), 0);
        kernel.setAuthorization(authorization); _publish();
        secret = sha256("independent recovery secret TEST ONLY"); ownerRoot = sha256(slhPublic(4));
        commitment = sha256(abi.encodePacked(secret, ownerRoot)); identity = registry.addressBinding(address(oldAccount));
        _bind(oldAccount, 1, commitment);
        vm.roll(170); _bind(lateAccount, 7, commitment);
        vm.roll(200); _succeed(true, 150);
    }
    function _refuseRebindAndRestore(bool different) private {
        bytes32 supplied = different ? sha256("unrelated new recovery TEST ONLY") : commitment;
        _bindChecked(oldAccount, 1, supplied, true);
        assertEq(authorization.ownerRecoveryCommitment(identity), bytes32(0));
        assertFalse(authorization.restoredIdentity(identity));
        authorization.registerBreakOwner(identity, 123 ether, secret, ownerRoot, new bytes32[](0));
        ProvianHashAccount destination = new ProvianHashAccount(sha256(slhPublic(3)));
        address origin = authorization.breakOrigin();
        ProvianRestorationAuthorization source = ProvianRestorationAuthorization(origin);
        bytes32 operation = sha256(abi.encode("Provian cryptographic break", identity, uint256(123 ether), address(destination),
            destination.keyCommitment(), source.predecessor(), source.lastGoodBlock()));
        RecourseOwnerAuthorization.OwnerProof memory proof;
        proof.recoverySecret = secret; proof.signingRoot = ownerRoot;
        proof.nextSigningRoot = sha256(slhPublic(5)); proof.nextCommitment = sha256(abi.encodePacked(sha256("next secret TEST ONLY"), proof.nextSigningRoot));
        (proof.publicKey, proof.signature) = slhSign(4, authorization.ownerAuthorizationDigest(identity, operation, proof.nextCommitment, proof.nextSigningRoot));
        ProvianRestorationAuthorization.BreakRestoration memory restoration = ProvianRestorationAuthorization.BreakRestoration(
            identity, 123 ether, commitment, destination, destination.keyCommitment(), new bytes32[](0));
        vm.prank(address(authority)); authorization.execute(identity, operation, proof, abi.encode(uint8(1), abi.encode(restoration)));
        assertTrue(authorization.restoredIdentity(identity)); assertEq(kernel.balanceOf(address(destination)), 123 ether);
        assertEq(registry.ownerOf(address(destination)), identity);
    }
    function testOldSnapshotAddressCannotReplaceItsOriginalCommitment() public { _refuseRebindAndRestore(true); }
    function testOldSnapshotAddressCannotConsumeItsCommitmentBeforeRestoration() public { _refuseRebindAndRestore(false); }
    function testOrdinarySuccessorStillProtectsUnclaimedBreakOwnership() public { vm.roll(300); _succeed(false, 250); _refuseRebindAndRestore(true); }
    function testRepeatedBreakStillProtectsEarlierUnclaimedOwnership() public { vm.roll(300); _succeed(true, 250); _refuseRebindAndRestore(true); }
    function testPostCutoffBindingCannotBeBackdatedIntoTheSnapshot() public {
        _bind(lateAccount, 7, sha256("new independent commitment TEST ONLY"));
        assertEq(registry.ownerOf(address(lateAccount)), registry.addressBinding(address(lateAccount)));
    }
    function _historicalEvidence(uint256 lossBlock, address lossAccount) private view returns (ProvianOwnershipRegistry.TheftEvidence memory) {
        return ProvianOwnershipRegistry.TheftEvidence(address(kernel), sha256("historical loss TEST ONLY"), identity, lossAccount,
            lossBlock, sha256("checkpoint TEST ONLY"), sha256("membership TEST ONLY"), revision, 4, 5);
    }
    function _evidenceSignature(ProvianOwnershipRegistry.TheftEvidence memory evidence) private returns (bytes memory) {
        (bytes memory pk, bytes memory signature) = slhSign(2, attestor.signatureDigest(registry.evidenceDigest(evidence)));
        return abi.encodePacked(pk, signature);
    }
    function testSnapshotPreservesAdmissionOfTheOriginalPreBreakLoss() public {
        ProvianOwnershipRegistry.TheftEvidence memory evidence = _historicalEvidence(120, address(oldAccount));
        bytes memory signature = _evidenceSignature(evidence);
        registry.admitTheftEvidence(evidence, signature);
        vm.prank(address(authorization));
        assertEq(registry.consumeTheftEvidence(evidence.operation, revision), evidence.operation);
        assertEq(registry.ownerOf(address(oldAccount)), bytes32(0));
    }

    function testOriginalLossAdmissionSurvivesOrdinaryAndRepeatedSuccessors() public {
        vm.roll(300); _succeed(false, 250);
        testSnapshotPreservesAdmissionOfTheOriginalPreBreakLoss();
        vm.roll(400); _succeed(true, 350);
        testSnapshotPreservesAdmissionOfTheOriginalPreBreakLoss();
    }
    function testHistoricalEvidenceCannotBackdateBindingOrUseDiscardedLossBlocks() public {
        for (uint256 i; i < 4; ++i) {
            ProvianOwnershipRegistry.TheftEvidence memory evidence = _historicalEvidence(i == 0 ? 99 : i == 1 ? 160 : 120,
                i == 2 ? address(lateAccount) : address(oldAccount));
            if (i == 2) evidence.identity = registry.addressBinding(address(lateAccount));
            if (i == 3) evidence.identity = sha256("another binding TEST ONLY");
            bytes memory signature = _evidenceSignature(evidence);
            vm.expectRevert(ProvianOwnershipRegistry.InvalidBinding.selector);
            registry.admitTheftEvidence(evidence, signature);
        }
    }
    function testHistoricalSameBlockBindingStillMustPrecedeTheLoss() public {
        ProvianOwnershipRegistry.TheftEvidence memory evidence = _historicalEvidence(100, address(oldAccount));
        evidence.bindingLogIndex = 5; evidence.lossLogIndex = 5;
        bytes memory signature = _evidenceSignature(evidence);
        vm.expectRevert(ProvianOwnershipRegistry.InvalidBinding.selector); registry.admitTheftEvidence(evidence, signature);
        evidence.lossLogIndex = 6; signature = _evidenceSignature(evidence);
        registry.admitTheftEvidence(evidence, signature);
    }

}
