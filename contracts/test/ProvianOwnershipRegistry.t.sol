// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {SlhTestSigner} from "./helpers/SlhTestSigner.sol";
import {ProvianOwnershipRegistry} from "../src/ProvianOwnershipRegistry.sol";
import {ProvianHashAccount} from "../src/ProvianHashAccount.sol";
import {ProvianProtocolPointer} from "../src/ProvianProtocolPointer.sol";

contract RegistryKernelFixture {
    address public registryOperator;
    address public restorationAuthority;
    address public ownerAuthorization;
    mapping(bytes32 => bytes32) public commitments;
    constructor(address registry, address authority, address executor) {
        registryOperator = registry; restorationAuthority = authority; ownerAuthorization = executor;
    }
    function bindRestorationOwner(bytes32 id, bytes32 commitment, bytes32) external {
        require(msg.sender == registryOperator);
        require(commitments[id] == bytes32(0) || commitments[id] == commitment, "commitment_immutable");
        commitments[id] = commitment;
    }
    function collapseRoles(address attestor) external { restorationAuthority = attestor; }
}
contract RegistryPoolFixture {
    address public registryOperator;
    mapping(address => bytes32) public owners;
    constructor(address registry) { registryOperator = registry; }
    function bind(bytes32 identity, address account) external { require(msg.sender == registryOperator); owners[account] = identity; }
}
contract RegistryContractWalletFixture {
    bytes32 public approved;
    function approve(bytes32 digest) external { approved = digest; }
    function isValidSignature(bytes32 digest, bytes calldata) external view returns (bytes4) {
        return digest == approved ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
contract ProvianOwnershipRegistryTest is SlhTestSigner {
    uint256 constant OWNER_KEY = 0x123456;
    uint256 constant EVIDENCE_KEY = 0x654321;
    ProvianProtocolPointer pointer;
    ProvianOwnershipRegistry registry;
    RegistryKernelFixture kernel;
    RegistryPoolFixture pool;
    ProvianOwnershipRegistry.Binding binding;
    function setUp() public {
        vm.chainId(8453); vm.warp(1000); vm.roll(100);
        pointer = new ProvianProtocolPointer(address(new ProvianHashAccount(sha256("pointer signing root TEST ONLY"))));
        registry = new ProvianOwnershipRegistry(pointer, vm.addr(EVIDENCE_KEY), false);
        kernel = new RegistryKernelFixture(address(registry), address(0xA), address(0xB));
        pool = new RegistryPoolFixture(address(registry));
        address[10] memory addresses; bytes32[10] memory hashes;
        for (uint256 i; i < 10; ++i) { addresses[i] = address(uint160(100+i)); vm.etch(addresses[i], hex"00"); hashes[i] = addresses[i].codehash; }
        addresses[0] = address(kernel); hashes[0] = address(kernel).codehash;
        addresses[8] = address(pool); hashes[8] = address(pool).codehash;
        vm.prank(pointer.authority()); pointer.publish(0, addresses, hashes);
        binding = ProvianOwnershipRegistry.Binding(sha256("owner identity TEST ONLY"), vm.addr(OWNER_KEY),
            sha256("recovery commitment TEST ONLY"), sha256("signing root TEST ONLY"), address(kernel), sha256("nonce TEST ONLY"), 1_200_000);
    }
    function testHashAttestorAndOwnerCanBindWithoutCurveSignatures() public {
        bytes memory ownerPublic = slhPublic(1);
        bytes memory attestorPublic = slhPublic(2);
        ProvianHashAccount owner = new ProvianHashAccount(sha256(ownerPublic));
        ProvianHashAccount attestor = new ProvianHashAccount(sha256(attestorPublic));
        registry = new ProvianOwnershipRegistry(pointer, address(attestor), true);
        kernel = new RegistryKernelFixture(address(registry), address(0xA), address(0xB));
        pool = new RegistryPoolFixture(address(registry));
        (,, address[10] memory targets, bytes32[10] memory hashes) = pointer.current();
        targets[0] = address(kernel); hashes[0] = address(kernel).codehash;
        targets[8] = address(pool); hashes[8] = address(pool).codehash;
        vm.prank(pointer.authority()); pointer.publish(1, targets, hashes);
        binding.kernel = address(kernel);
        binding.account = address(owner);
        bytes32 digest = registry.bindingDigest(binding);
        (, bytes memory ownerSig) = slhSign(1, owner.signatureDigest(digest));
        (, bytes memory attestorSig) = slhSign(2, attestor.signatureDigest(digest));
        bytes memory ownerProof = abi.encodePacked(ownerPublic, ownerSig);
        bytes memory attestorProof = abi.encodePacked(attestorPublic, attestorSig);
        binding.account = vm.addr(OWNER_KEY);
        vm.expectRevert(ProvianOwnershipRegistry.InvalidBinding.selector);
        registry.bind(binding, ownerProof, attestorProof, 2);
        binding.account = address(owner);
        vm.expectRevert(ProvianOwnershipRegistry.InvalidBinding.selector);
        registry.bind(binding, ownerProof, ownerProof, 2);
        registry.bind(binding, ownerProof, attestorProof, 2);
        assertEq(registry.ownerOf(address(owner)), binding.identity);
        assertEq(kernel.commitments(binding.identity), binding.recoveryCommitment);
        vm.expectRevert(ProvianOwnershipRegistry.InvalidBinding.selector);
        registry.bind(binding, ownerProof, attestorProof, 2);
    }

    function sig(uint256 key, bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
    function bind() public {
        bytes32 digest = registry.bindingDigest(binding);
        registry.bind(binding, sig(OWNER_KEY, digest), sig(EVIDENCE_KEY, digest), 1);
    }
    function testCanonicalBindingMatchesSharedClientAndRelayBytes() public view {
        string memory json = vm.readFile("test/fixtures/owner-binding.json");
        ProvianOwnershipRegistry.Binding memory b = ProvianOwnershipRegistry.Binding(
            vm.parseJsonBytes32(json, ".identity"), vm.parseJsonAddress(json, ".address"),
            vm.parseJsonBytes32(json, ".recoveryCommitment"), vm.parseJsonBytes32(json, ".signingRoot"),
            vm.parseJsonAddress(json, ".kernel"), vm.parseJsonBytes32(json, ".nonce"), vm.parseJsonUint(json, ".expiresAtMs"));
        assertEq(registry.bindingDigest(b), vm.parseJsonBytes32(json, ".digest"));
    }
    function testRecoveredDestinationBindingRequiresCurrentExecutorAndExactOwnerProofOutput() public {
        address destination = address(0xC);
        vm.mockCall(address(0xB), abi.encodeWithSignature("recoveredDestination(bytes32)", binding.identity), abi.encode(destination));
        vm.expectRevert(ProvianOwnershipRegistry.InvalidBinding.selector);
        registry.bindRecovered(binding.identity, destination);
        vm.prank(address(0xB)); vm.expectRevert(ProvianOwnershipRegistry.InvalidBinding.selector);
        registry.bindRecovered(binding.identity, address(0xD));
        vm.prank(address(0xB)); registry.bindRecovered(binding.identity, destination);
        assertEq(registry.ownerOf(destination), binding.identity);
        assertEq(pool.owners(destination), binding.identity);
        assertEq(registry.boundBlock(destination), block.number);
        bytes32 other = bytes32(uint256(999));
        vm.mockCall(address(0xB), abi.encodeWithSignature("recoveredDestination(bytes32)", other), abi.encode(destination));
        vm.prank(address(0xB)); vm.expectRevert(ProvianOwnershipRegistry.InvalidBinding.selector);
        registry.bindRecovered(other, destination);
    }
    function testBothSignaturesBindKernelAndPoolAtomicallyAndReplayCannotChangeOwner() public {
        bind();
        assertEq(registry.ownerOf(binding.account), binding.identity);
        assertEq(pool.owners(binding.account), binding.identity);
        assertEq(kernel.commitments(binding.identity), binding.recoveryCommitment);
        vm.expectRevert(ProvianOwnershipRegistry.InvalidBinding.selector); this.bind();
        binding.nonce = sha256("second TEST ONLY"); binding.recoveryCommitment = sha256("substitute TEST ONLY");
        vm.expectRevert("commitment_immutable"); this.bind();
        assertEq(kernel.commitments(binding.identity), sha256("recovery commitment TEST ONLY"));
    }
    function testMissingOwnerOrIdentitySignatureCannotRegister() public {
        bytes32 digest = registry.bindingDigest(binding);
        vm.expectRevert(ProvianOwnershipRegistry.InvalidBinding.selector);
        registry.bind(binding, sig(EVIDENCE_KEY, digest), sig(EVIDENCE_KEY, digest), 1);
        vm.expectRevert(ProvianOwnershipRegistry.InvalidBinding.selector);
        registry.bind(binding, sig(OWNER_KEY, digest), sig(OWNER_KEY, digest), 1);
        assertEq(registry.ownerOf(binding.account), bytes32(0));
    }
    function testMutationOfAnyBindingFieldInvalidatesConsent() public {
        bytes32 digest = registry.bindingDigest(binding);
        bytes memory ownerSignature = sig(OWNER_KEY, digest);
        bytes memory evidenceSignature = sig(EVIDENCE_KEY, digest);
        ProvianOwnershipRegistry.Binding memory original = binding;
        for (uint256 i; i < 7; ++i) {
            ProvianOwnershipRegistry.Binding memory changed = original;
            if (i == 0) changed.identity = sha256("substitute identity");
            if (i == 1) changed.account = address(0xD);
            if (i == 2) changed.recoveryCommitment = sha256("substitute commitment");
            if (i == 3) changed.signingRoot = sha256("substitute root");
            if (i == 4) changed.kernel = address(0xD);
            if (i == 5) changed.nonce = sha256("substitute nonce");
            if (i == 6) changed.expiresAtMs++;
            vm.expectRevert(); registry.bind(changed, ownerSignature, evidenceSignature, 1);
        }
        assertEq(registry.ownerOf(original.account), bytes32(0));
    }
    function testContractWalletAndExpiryAndRetiredRevision() public {
        RegistryContractWalletFixture wallet = new RegistryContractWalletFixture();
        binding.account = address(wallet);
        bytes32 digest = registry.bindingDigest(binding); wallet.approve(digest);
        registry.bind(binding, hex"1234", sig(EVIDENCE_KEY, digest), 1);
        assertEq(registry.ownerOf(address(wallet)), binding.identity);
        binding.nonce = sha256("next nonce TEST ONLY"); binding.expiresAtMs = block.timestamp * 1000 - 1;
        digest = registry.bindingDigest(binding); wallet.approve(digest);
        vm.expectRevert(ProvianOwnershipRegistry.InvalidBinding.selector);
        registry.bind(binding, hex"1234", sig(EVIDENCE_KEY, digest), 1);
        binding.expiresAtMs = 1_200_000;
        vm.expectRevert(ProvianProtocolPointer.StaleRevision.selector);
        registry.bind(binding, hex"1234", sig(EVIDENCE_KEY, digest), 0);
    }
    function testEvidenceNeedsIndependentSignerBoundLossOwnerAndExactCheckpoint() public {
        bind(); vm.roll(103);
        ProvianOwnershipRegistry.TheftEvidence memory e = ProvianOwnershipRegistry.TheftEvidence(address(kernel), sha256("exact reversal TEST ONLY"),
            binding.identity, binding.account, 101, sha256("checkpoint TEST ONLY"), sha256("membership TEST ONLY"), 1, 2, 3);
        bytes32 digest = registry.evidenceDigest(e);
        vm.expectRevert(ProvianOwnershipRegistry.InvalidBinding.selector);
        registry.admitTheftEvidence(e, sig(OWNER_KEY, digest));
        bytes memory signature = sig(EVIDENCE_KEY, digest);
        e.checkpointHash = sha256("substituted checkpoint");
        vm.expectRevert(ProvianOwnershipRegistry.InvalidBinding.selector); registry.admitTheftEvidence(e, signature);
        e.checkpointHash = sha256("checkpoint TEST ONLY");
        registry.admitTheftEvidence(e, signature);
        vm.expectRevert(ProvianOwnershipRegistry.InvalidBinding.selector); registry.consumeTheftEvidence(e.operation, 1);
        vm.prank(address(0xB)); assertEq(registry.consumeTheftEvidence(e.operation, 1), e.operation);
        vm.prank(address(0xB)); vm.expectRevert(ProvianOwnershipRegistry.InvalidBinding.selector); registry.consumeTheftEvidence(e.operation, 1);
    }
    function testSameBlockLossMustFollowBindingInAttestedCanonicalLogOrder() public {
        bind(); uint256 bound = registry.boundBlock(binding.account); vm.roll(bound + 1);
        ProvianOwnershipRegistry.TheftEvidence memory e = ProvianOwnershipRegistry.TheftEvidence(address(kernel), sha256("same block reversal TEST ONLY"),
            binding.identity, binding.account, bound, sha256("checkpoint TEST ONLY"), sha256("membership TEST ONLY"), 1, 4, 3);
        bytes memory signature = sig(EVIDENCE_KEY, registry.evidenceDigest(e));
        vm.expectRevert(ProvianOwnershipRegistry.InvalidBinding.selector); registry.admitTheftEvidence(e, signature);
        e.lossLogIndex = 4; signature = sig(EVIDENCE_KEY, registry.evidenceDigest(e));
        vm.expectRevert(ProvianOwnershipRegistry.InvalidBinding.selector); registry.admitTheftEvidence(e, signature);
        e.lossLogIndex = 5; registry.admitTheftEvidence(e, sig(EVIDENCE_KEY, registry.evidenceDigest(e)));
    }
    function testCollapsedAuthorityAndEvidenceRolesFailClosed() public {
        kernel.collapseRoles(vm.addr(EVIDENCE_KEY));
        vm.expectRevert(ProvianOwnershipRegistry.InvalidBinding.selector); this.bind();
    }
    function testOrdinarySuccessionRetainsBindingBlockAndCannotReassignOldAddress() public {
        bind();
        address prior=address(registry);uint256 originalBlock=registry.boundBlock(binding.account);
        registry=new ProvianOwnershipRegistry(pointer,vm.addr(EVIDENCE_KEY),false);
        assertEq(registry.previousRegistry(),prior);
        assertEq(registry.ownerOf(binding.account),binding.identity);
        assertEq(registry.boundBlock(binding.account),originalBlock);
        kernel=new RegistryKernelFixture(address(registry),address(0xA),address(0xB));
        pool=new RegistryPoolFixture(address(registry));
        (,,address[10] memory targets,bytes32[10] memory hashes)=pointer.current();
        targets[0]=address(kernel);hashes[0]=address(kernel).codehash;
        targets[8]=address(pool);hashes[8]=address(pool).codehash;
        vm.prank(pointer.authority());pointer.publish(1,targets,hashes);
        binding.kernel=address(kernel);binding.identity=sha256("other owner TEST ONLY");
        bytes32 digest=registry.bindingDigest(binding);
        bytes memory os=sig(OWNER_KEY,digest);bytes memory es=sig(EVIDENCE_KEY,digest);
        vm.expectRevert(ProvianOwnershipRegistry.InvalidBinding.selector);registry.bind(binding,os,es,2);
        assertEq(registry.ownerOf(binding.account),ProvianOwnershipRegistry(prior).ownerOf(binding.account));
        assertEq(registry.boundBlock(binding.account),originalBlock);
    }
    function testHashSuccessionDoesNotTrustPreBreakCurveBindings() public {
        bind();
        ProvianHashAccount attestor=new ProvianHashAccount(sha256("new hash attestor TEST ONLY"));
        ProvianOwnershipRegistry next=new ProvianOwnershipRegistry(pointer,address(attestor),true);
        assertEq(next.previousRegistry(),address(0));assertEq(next.ownerOf(binding.account),bytes32(0));
    }

}
