// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {SlhTestSigner} from "./helpers/SlhTestSigner.sol";
import {RecourseOwnerAuthorization} from "../src/RecourseOwnerAuthorization.sol";
contract OwnerAuthorizationHarness is RecourseOwnerAuthorization {
    address immutable authority;
    constructor() { authority = msg.sender; }
    function bind(bytes32 id, bytes32 commitment, bytes32 root) external { require(msg.sender == authority); _bindOwnerAuthorization(id, commitment, root); }
    function execute(bytes32 id, bytes32 operation, OwnerProof calldata proof) external {
        require(msg.sender == authority, "not_authority"); _consumeOwnerAuthorization(id, operation, proof);
    }
}
contract SuccessorOwnerAuthorizationHarness is OwnerAuthorizationHarness {
    address immutable prior;
    constructor(address prior_) { prior = prior_; }
    function _priorAuthorization() internal view override returns (address) { return prior; }
}
contract RecourseOwnerAuthorizationTest is SlhTestSigner {
    OwnerAuthorizationHarness auth;
    RecourseOwnerAuthorization.OwnerProof proof;
    bytes32 constant ID = bytes32(uint256(1));
    bytes32 constant OPERATION = keccak256("exact sources amounts destination and remainder TEST ONLY");
    function setUp() public {
        auth = new OwnerAuthorizationHarness();
        proof.publicKey = slhPublic(1);
        proof.recoverySecret = sha256("independent recovery seed TEST ONLY");
        proof.signingRoot = sha256(proof.publicKey);
        proof.nextCommitment = sha256("next recovery commitment TEST ONLY");
        proof.nextSigningRoot = sha256("next signing root TEST ONLY");
        auth.bind(ID, sha256(abi.encodePacked(proof.recoverySecret, proof.signingRoot)), proof.signingRoot);
        bytes32 digest = auth.ownerAuthorizationDigest(ID, OPERATION, proof.nextCommitment, proof.nextSigningRoot);
        (, proof.signature) = slhSign(1, digest);
    }
    function testBothFactorsConsumeExactIntentOnceAndRotate() public {
        auth.execute(ID, OPERATION, proof);
        assertEq(auth.ownerAuthorizationNonce(ID), 1);
        assertEq(auth.ownerRecoveryCommitment(ID), proof.nextCommitment);
        assertEq(auth.ownerSigningRoot(ID), proof.nextSigningRoot);
        vm.expectRevert(RecourseOwnerAuthorization.InvalidOwnerAuthorization.selector);
        auth.execute(ID, OPERATION, proof);
    }
    function testSuccessorKeepsRecoveredGenerationAndRejectsEveryPreviouslyUsedRoot() public {
        bytes32 secondSecret = sha256("generation two secret TEST ONLY");
        proof.nextSigningRoot = sha256(slhPublic(2));
        proof.nextCommitment = sha256(abi.encodePacked(secondSecret, proof.nextSigningRoot));
        (, proof.signature) = slhSign(1, auth.ownerAuthorizationDigest(ID, OPERATION, proof.nextCommitment, proof.nextSigningRoot));
        bytes32 initialCommitment = auth.ownerRecoveryCommitment(ID);
        bytes32 initialRoot = proof.signingRoot;
        auth.execute(ID, OPERATION, proof);
        SuccessorOwnerAuthorizationHarness next = new SuccessorOwnerAuthorizationHarness(address(auth));
        assertEq(next.ownerAuthorizationNonce(ID), 1);
        assertEq(next.ownerRecoveryCommitment(ID), proof.nextCommitment);
        assertEq(next.ownerSigningRoot(ID), proof.nextSigningRoot);
        next.bind(ID, proof.nextCommitment, proof.nextSigningRoot);
        assertEq(next.ownerAuthorizationNonce(ID), 1);
        proof.recoverySecret = secondSecret; proof.publicKey = slhPublic(2); proof.signingRoot = sha256(proof.publicKey);
        proof.nextSigningRoot = initialRoot;
        proof.nextCommitment = sha256("fresh future commitment TEST ONLY");
        (, proof.signature) = slhSign(2, next.ownerAuthorizationDigest(ID, OPERATION, proof.nextCommitment, proof.nextSigningRoot));
        vm.expectRevert(RecourseOwnerAuthorization.InvalidOwnerAuthorization.selector); next.execute(ID, OPERATION, proof);
        proof.nextSigningRoot = sha256(slhPublic(3)); proof.nextCommitment = initialCommitment;
        (, proof.signature) = slhSign(2, next.ownerAuthorizationDigest(ID, OPERATION, proof.nextCommitment, proof.nextSigningRoot));
        vm.expectRevert(RecourseOwnerAuthorization.InvalidOwnerAuthorization.selector); next.execute(ID, OPERATION, proof);
        proof.nextCommitment = sha256("fresh future commitment TEST ONLY");
        (, proof.signature) = slhSign(2, next.ownerAuthorizationDigest(ID, OPERATION, proof.nextCommitment, proof.nextSigningRoot));
        next.execute(ID, OPERATION, proof);
        assertEq(next.ownerAuthorizationNonce(ID), 2);
        assertTrue(next.ownerUsedSigningRoot(ID, initialRoot));
        assertTrue(next.ownerUsedRecoveryCommitment(ID, initialCommitment));
        assertEq(auth.ownerAuthorizationNonce(ID), 1);
    }
    function testOwnerProofWithoutAuthorityCannotExecute() public {
        vm.prank(address(7)); vm.expectRevert("not_authority"); auth.execute(ID, OPERATION, proof);
        assertEq(auth.ownerAuthorizationNonce(ID), 0);
    }
    function testAuthoritySeeingPreimageCannotSubstituteDestinationOrNextRoot() public {
        vm.expectRevert(RecourseOwnerAuthorization.InvalidOwnerAuthorization.selector);
        auth.execute(ID, keccak256("substituted destination"), proof);
        proof.nextSigningRoot = sha256("attacker root");
        vm.expectRevert(RecourseOwnerAuthorization.InvalidOwnerAuthorization.selector);
        auth.execute(ID, OPERATION, proof);
        assertEq(auth.ownerAuthorizationNonce(ID), 0);
    }
    function testWrongPreimageAndRebindingRefused() public {
        proof.recoverySecret = bytes32(uint256(99));
        vm.expectRevert(RecourseOwnerAuthorization.InvalidOwnerAuthorization.selector);
        auth.execute(ID, OPERATION, proof);
        vm.expectRevert(RecourseOwnerAuthorization.InvalidOwnerAuthorization.selector);
        auth.bind(ID, bytes32(uint256(99)), proof.signingRoot);
    }
}
