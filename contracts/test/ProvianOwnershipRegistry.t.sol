// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {RecourseAddressConsent} from "../src/RecourseAddressConsent.sol";
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
contract RegistryPoolFixture is RecourseAddressConsent {
    address public registryOperator;
    mapping(address => bytes32) public owners;
    mapping(bytes32 => address) public accounts;
    constructor(address registry) { registryOperator = registry; }
    function bind(bytes32 identity, address account) external { require(msg.sender == registryOperator); owners[account] = identity; accounts[identity] = account; }
    function _consentOwner(bytes32 id) internal view override returns(address) { return accounts[id]; }
    function _consentAttestor() internal view override returns(address) { return ProvianOwnershipRegistry(registryOperator).identityAttestor(); }
    function _consentDomain() internal view override returns(address, address) {
        ProvianProtocolPointer p = ProvianOwnershipRegistry(registryOperator).pointer(); return (address(p), p.component(0));
    }
    function _consentCurrent(uint256 revision) internal view override {
        ProvianOwnershipRegistry(registryOperator).pointer().requireCurrent(revision, 8, address(this));
    }
    function _consentRule(uint256) internal pure override returns(bytes32) { return sha256("signed test rule"); }
    function _consentMonth() internal pure override returns(uint256) { return 100; }
    function _executeMembershipDebit(bytes32, address, uint256, uint256) internal pure override { revert("not_a_debit_fixture"); }

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
        vm.mockCall(address(0xB), abi.encodeWithSignature("breakOrigin()"), abi.encode(address(0)));
        pointer = new ProvianProtocolPointer(address(new ProvianHashAccount(sha256("pointer signing root TEST ONLY"))));
        registry = new ProvianOwnershipRegistry(pointer, vm.addr(EVIDENCE_KEY), false);
        kernel = new RegistryKernelFixture(address(registry), address(0xA), address(0xB));
        pool = new RegistryPoolFixture(address(registry));
        address[10] memory addresses; bytes32[10] memory hashes;
        for (uint256 i; i < 10; ++i) { addresses[i] = address(uint160(100+i)); vm.etch(addresses[i], hex"00"); hashes[i] = addresses[i].codehash; }
        addresses[0] = address(kernel); hashes[0] = address(kernel).codehash;
        addresses[8] = address(pool); hashes[8] = address(pool).codehash;
        vm.prank(pointer.authority()); pointer.publish(0, addresses, hashes);
        binding = ProvianOwnershipRegistry.Binding(registry.addressBinding(vm.addr(OWNER_KEY)), vm.addr(OWNER_KEY),
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
        binding.identity = registry.addressBinding(address(owner));
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
    function joinedConsent() private view returns (RecourseAddressConsent.ConsentAuthorization memory) {
        return RecourseAddressConsent.ConsentAuthorization(binding.identity, binding.account, 0, true, 1,
            sha256("signed test rule"), block.timestamp + 200);
    }
    function testBindingAndMemberConsentAreAtomicWithBothIndependentOwnerSignatures() public {
        RecourseAddressConsent.ConsentAuthorization memory c = joinedConsent();
        bytes32 bd = registry.bindingDigest(binding); bytes32 cd = pool.consentDigest(c);
        bytes memory identitySig = sig(EVIDENCE_KEY, registry.memberBindingDigest(binding, c));
        bytes memory ownerSig = sig(OWNER_KEY, bd);
        vm.expectRevert(ProvianOwnershipRegistry.InvalidBinding.selector);
        registry.bind(binding, ownerSig, identitySig, 1);
        registry.bindWithConsent(binding, ownerSig, identitySig, 1, c, sig(OWNER_KEY, cd), sig(EVIDENCE_KEY, cd));
        assertEq(registry.ownerOf(binding.account), binding.identity);
        assertEq(kernel.commitments(binding.identity), binding.recoveryCommitment);
        (uint256 nonce,uint256 generation,bool joined) = pool.addressConsent(binding.identity);
        assertEq(nonce,1); assertEq(generation,1); assertTrue(joined);
    }
    function testRejectedMemberConsentRollsBackTheEntireBindingAndRecoveryCommitment() public {
        RecourseAddressConsent.ConsentAuthorization memory c = joinedConsent();
        bytes32 bd = registry.bindingDigest(binding); bytes32 cd = pool.consentDigest(c);
        bytes memory owner = sig(OWNER_KEY, bd); bytes memory attestor = sig(EVIDENCE_KEY, registry.memberBindingDigest(binding, c));
        bytes memory consentOwner = sig(OWNER_KEY, cd);
        vm.expectRevert(); registry.bindWithConsent(binding, owner, attestor, 1, c, consentOwner, "");
        assertEq(registry.ownerOf(binding.account), bytes32(0));
        assertEq(kernel.commitments(binding.identity), bytes32(0));
        assertEq(pool.owners(binding.account), bytes32(0));
        assertFalse(registry.consumedBinding(bd));
        bytes memory consentAttestor = sig(EVIDENCE_KEY, cd);
        vm.expectRevert(); registry.bindWithConsent(binding, owner, attestor, 1, c, "", consentAttestor);
        assertFalse(registry.consumedBinding(bd));
    }
    function testAtomicMemberBindingCannotConsentForAnotherAddressOrDeparture() public {
        RecourseAddressConsent.ConsentAuthorization memory c = joinedConsent();
        bytes32 bd = registry.bindingDigest(binding); bytes32 cd = pool.consentDigest(c);
        bytes memory owner = sig(OWNER_KEY, bd); bytes memory attestor = sig(EVIDENCE_KEY, registry.memberBindingDigest(binding, c));
        bytes memory co = sig(OWNER_KEY, cd); bytes memory ca = sig(EVIDENCE_KEY, cd);
        c.account = address(0xD);
        vm.expectRevert(ProvianOwnershipRegistry.InvalidBinding.selector); registry.bindWithConsent(binding, owner, attestor, 1, c, co, ca);
        c.account = binding.account; c.binding = bytes32(uint256(5));
        vm.expectRevert(ProvianOwnershipRegistry.InvalidBinding.selector); registry.bindWithConsent(binding, owner, attestor, 1, c, co, ca);
        c.binding = binding.identity; c.joined = false;
        vm.expectRevert(ProvianOwnershipRegistry.InvalidBinding.selector); registry.bindWithConsent(binding, owner, attestor, 1, c, co, ca);
        c.joined = true; c.revision = 2;
        vm.expectRevert(ProvianOwnershipRegistry.InvalidBinding.selector); registry.bindWithConsent(binding, owner, attestor, 1, c, co, ca);
        assertFalse(registry.consumedBinding(bd));
    }
    function _lowerAddress(address account) private pure returns (string memory) {
        bytes memory value = bytes(vm.toString(account));
        for (uint256 i; i < value.length; ++i) if (uint8(value[i]) >= 65 && uint8(value[i]) <= 70) value[i] = bytes1(uint8(value[i]) + 32);
        return string(value);
    }
    function testAtomicBindingDigestMatchesActualSdkSerializer() public {
        RecourseAddressConsent.ConsentAuthorization memory c = joinedConsent();
        string[] memory command = new string[](8);
        command[0] = "node"; command[1] = string.concat(vm.projectRoot(), "/test/helpers/membership-digest.cjs");
        command[2] = "member-binding"; command[3] = "8453";
        command[4] = vm.toString(address(pointer)); command[5] = vm.toString(address(kernel)); command[6] = vm.toString(address(pool));
        command[7] = string.concat('{"registry":"', _lowerAddress(address(registry)), '","binding":{"identity":"', vm.toString(binding.identity),
          '","address":"', _lowerAddress(binding.account), '","recoveryCommitment":"', vm.toString(binding.recoveryCommitment),
          '","signingRoot":"', vm.toString(binding.signingRoot), '","kernel":"', _lowerAddress(binding.kernel), '","nonce":"', vm.toString(binding.nonce),
          '","expiresAtMs":1200000},"consent":{"binding":"', vm.toString(c.binding), '","account":"', _lowerAddress(c.account),
          '","nonce":"0","joined":true,"revision":"1","ruleHash":"', vm.toString(c.ruleHash), '","expiresAt":"1200"}}');
        for (uint256 n = 4; n < 7; ++n) {
            bytes memory value = bytes(command[n]);
            for (uint256 i; i < value.length; ++i) if (uint8(value[i]) >= 65 && uint8(value[i]) <= 70) value[i] = bytes1(uint8(value[i]) + 32);
            command[n] = string(value);
        }
        assertEq(bytes32(vm.ffi(command)), registry.memberBindingDigest(binding, c));
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
        binding.identity = registry.addressBinding(address(wallet));
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

    function testPrivateOwnerCannotBePublishedAsSharedAddressBindingEvenWithBothSignatures() public {
        bind();
        bytes32 first = binding.identity;
        uint256 secondKey = 0x123457;
        binding.account = vm.addr(secondKey);
        binding.nonce = sha256("independent address nonce TEST ONLY");
        bytes32 digest = registry.bindingDigest(binding);
        bytes memory ownerSig = sig(secondKey, digest);
        bytes memory attestorSig = sig(EVIDENCE_KEY, digest);
        vm.expectRevert(ProvianOwnershipRegistry.InvalidBinding.selector);
        registry.bind(binding, ownerSig, attestorSig, 1);
        assertEq(registry.ownerOf(binding.account), bytes32(0));
        binding.identity = registry.addressBinding(binding.account);
        binding.recoveryCommitment = sha256("independent commitment TEST ONLY");
        binding.signingRoot = sha256("independent root TEST ONLY");
        digest = registry.bindingDigest(binding);
        registry.bind(binding, sig(secondKey, digest), sig(EVIDENCE_KEY, digest), 1);
        assertTrue(binding.identity != first);
        assertEq(registry.ownerOf(binding.account), binding.identity);
    }

    function testAddressBindingUsesOnlyPublicDomainAndOneOriginalAddress() public {
        assertEq(registry.addressBinding(binding.account), sha256(abi.encode(
            "Provian address recovery binding", uint256(8453), address(pointer), binding.account)));
        bytes32 original = registry.addressBinding(binding.account);
        vm.chainId(31337);
        assertTrue(registry.addressBinding(binding.account) != original);
        vm.expectRevert(ProvianOwnershipRegistry.InvalidBinding.selector);
        registry.addressBinding(address(0));
    }

}
