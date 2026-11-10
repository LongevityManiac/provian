// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {SlhTestSigner} from "./helpers/SlhTestSigner.sol";
import {ProvianHashAccount} from "../src/ProvianHashAccount.sol";
import {ProvianProtocolPointer} from "../src/ProvianProtocolPointer.sol";
contract ProvianProtocolPointerTest is SlhTestSigner {
    ProvianProtocolPointer pointer;
    address pointerAuthority;
    address[10] targets;
    bytes32[10] hashes;
    function setUp() public {
        pointer = new ProvianProtocolPointer(address(new ProvianHashAccount(sha256("pointer signing root TEST ONLY"))));
        pointerAuthority = pointer.authority();
        for (uint256 i; i < 10; ++i) {
            targets[i] = address(uint160(100 + i));
            vm.etch(targets[i], hex"60006000f3");
            hashes[i] = targets[i].codehash;
        }
    }
    function testCompleteManifestAndPermanentRetirement() public {
        vm.prank(pointerAuthority); pointer.publish(0, targets, hashes);
        (uint256 rev, bytes32 digest, address[10] memory got, bytes32[10] memory codeHashes) = pointer.current();
        assertEq(rev, 1);
        assertEq(digest, keccak256(abi.encode(block.chainid, address(pointer), rev, targets, hashes)));
        for (uint256 i; i < 10; ++i) { assertEq(got[i], targets[i]); assertEq(codeHashes[i], hashes[i]); }
        address old = targets[0];
        targets[0] = address(999);
        vm.etch(targets[0], hex"60006000f3");
        vm.prank(pointerAuthority); pointer.publish(1, targets, hashes);
        assertTrue(pointer.retired(old));
        pointer.requireCurrent(2, 0, targets[0]);
        vm.expectRevert(ProvianProtocolPointer.StaleRevision.selector);
        pointer.requireCurrent(1, 0, old);
        vm.expectRevert(ProvianProtocolPointer.InvalidManifest.selector);
        pointer.requireCurrent(2, 0, old);
        targets[0] = old;
        vm.expectRevert(ProvianProtocolPointer.InvalidManifest.selector);
        vm.prank(pointerAuthority); pointer.publish(2, targets, hashes);
    }
    function testUnauthorizedEmptyStaleAndMismatchedCodeRefused() public {
        vm.expectRevert(ProvianProtocolPointer.InvalidManifest.selector);
        pointer.current();
        vm.prank(address(7));
        vm.expectRevert(ProvianProtocolPointer.Unauthorized.selector);
        pointer.publish(0, targets, hashes);
        hashes[2] = bytes32(uint256(4));
        vm.expectRevert(ProvianProtocolPointer.InvalidManifest.selector);
        vm.prank(pointerAuthority); pointer.publish(0, targets, hashes);
        hashes[2] = targets[2].codehash;
        vm.prank(pointerAuthority); pointer.publish(0, targets, hashes);
        vm.expectRevert(ProvianProtocolPointer.StaleRevision.selector);
        vm.prank(pointerAuthority); pointer.publish(0, targets, hashes);
        vm.etch(targets[2], hex"00");
        vm.expectRevert(ProvianProtocolPointer.InvalidManifest.selector);
        pointer.requireCurrent(1, 2, targets[2]);
    }
    function testRolesCannotBeSubstituted() public {
        vm.prank(pointerAuthority); pointer.publish(0, targets, hashes);
        (targets[0], targets[1]) = (targets[1], targets[0]);
        vm.expectRevert(ProvianProtocolPointer.InvalidManifest.selector);
        vm.prank(pointerAuthority); pointer.publish(1, targets, hashes);

    }
    function testPoolReplacementRequiresTokenSuccessionToPreserveCustodyProtection() public {
        vm.prank(pointerAuthority); pointer.publish(0, targets, hashes);
        address originalPool = targets[8];
        targets[8] = address(991); vm.etch(targets[8], hex"60006000f3");
        vm.prank(pointerAuthority); vm.expectRevert(ProvianProtocolPointer.InvalidManifest.selector);
        pointer.publish(1, targets, hashes);
        assertEq(pointer.revision(), 1); assertEq(pointer.component(8), originalPool);
        assertFalse(pointer.retired(originalPool));
        targets[0] = address(992); vm.etch(targets[0], hex"60006000f3");
        vm.prank(pointerAuthority); pointer.publish(1, targets, hashes);
        assertTrue(pointer.retired(originalPool)); assertEq(pointer.revision(), 2);
    }
    function testOptionalBeneficiaryVerifierCanBeAbsentButNoOtherComponentCan() public {
        targets[2] = address(0); hashes[2] = bytes32(0);
        vm.prank(pointerAuthority); pointer.publish(0, targets, hashes);
        assertEq(pointer.component(2), address(0));
        targets[1] = address(0); hashes[1] = bytes32(0);
        vm.expectRevert(ProvianProtocolPointer.InvalidManifest.selector);
        vm.prank(pointerAuthority); pointer.publish(1, targets, hashes);
    }
    function testCustodyReplacementRequiresTokenSuccession() public {
        vm.prank(pointerAuthority); pointer.publish(0, targets, hashes);
        for (uint256 slot = 3; slot <= 7; ++slot) {
            if (slot == 4) continue;
            address prior = targets[slot];
            targets[slot] = address(uint160(990 + slot)); vm.etch(targets[slot], hex"60006000f3");
            vm.prank(pointerAuthority); vm.expectRevert(ProvianProtocolPointer.InvalidManifest.selector);
            pointer.publish(1, targets, hashes);
            assertFalse(pointer.retired(prior)); assertEq(pointer.component(slot), prior);
            targets[slot] = prior;
        }
        targets[0] = address(998); targets[3] = address(999);
        vm.etch(targets[0], hex"60006000f3"); vm.etch(targets[3], hex"60006000f3");
        vm.prank(pointerAuthority); pointer.publish(1, targets, hashes);
        assertEq(pointer.revision(), 2);
    }
    function testLegacyRetirementIsCodeBoundAndClosesAtFirstManifest() public {
        address legacy = address(900);
        vm.etch(legacy, hex"60006000f3");
        address[] memory old = new address[](1); old[0] = legacy;
        bytes32[] memory code = new bytes32[](1); code[0] = legacy.codehash;
        vm.prank(address(7));
        vm.expectRevert(ProvianProtocolPointer.Unauthorized.selector);
        pointer.registerLegacyRetirements(old, code);
        code[0] = bytes32(uint256(1));
        vm.expectRevert(ProvianProtocolPointer.InvalidManifest.selector);
        vm.prank(pointerAuthority); pointer.registerLegacyRetirements(old, code);
        code[0] = legacy.codehash;
        vm.prank(pointerAuthority); pointer.registerLegacyRetirements(old, code);
        assertTrue(pointer.retired(legacy));
        address current = targets[0]; targets[0] = legacy;
        vm.expectRevert(ProvianProtocolPointer.InvalidManifest.selector);
        vm.prank(pointerAuthority); pointer.publish(0, targets, hashes);
        targets[0] = current; vm.prank(pointerAuthority); pointer.publish(0, targets, hashes);
        vm.expectRevert(ProvianProtocolPointer.InvalidManifest.selector);
        vm.prank(pointerAuthority); pointer.registerLegacyRetirements(old, code);
    }


    function testAuthorityMustBeExactHashAccountWithLiveCommitment() public {
        vm.expectRevert(ProvianProtocolPointer.InvalidManifest.selector);
        new ProvianProtocolPointer(address(8));
        vm.expectRevert(ProvianProtocolPointer.InvalidManifest.selector);
        new ProvianProtocolPointer(address(this));
        address empty = address(901);
        vm.etch(empty, type(ProvianHashAccount).runtimeCode);
        vm.expectRevert(ProvianProtocolPointer.InvalidManifest.selector);
        new ProvianProtocolPointer(empty);
    }

    function testRealHashAuthorizationPublishesAndRotatesWithoutChangingAuthority() public {
        bytes memory publicKey = slhPublic(1);
        ProvianHashAccount account = new ProvianHashAccount(sha256(publicKey));
        pointer = new ProvianProtocolPointer(address(account));
        bytes32 nextRoot = sha256(slhPublic(2));
        bytes memory data = abi.encodeCall(pointer.publish, (0, targets, hashes));
        bytes32 digest = account.intentDigest(address(pointer), 0, 2_000_000, data, nextRoot);
        (, bytes memory signature) = slhSign(1, digest);
        // A gas sponsor has no authority to publish directly or substitute its manifest.
        vm.prank(address(8)); vm.expectRevert(ProvianProtocolPointer.Unauthorized.selector);
        pointer.publish(0, targets, hashes);
        bytes memory badData = abi.encodeCall(pointer.publish, (1, targets, hashes));
        vm.expectRevert(ProvianHashAccount.InvalidSignature.selector);
        account.execute(address(pointer), 0, 2_000_000, badData, nextRoot, publicKey, signature);
        vm.prank(address(8));
        assertTrue(account.execute(address(pointer), 0, 2_000_000, data, nextRoot, publicKey, signature));
        assertEq(pointer.revision(), 1);
        assertEq(pointer.authority(), address(account));
        assertEq(account.keyCommitment(), nextRoot);
        assertEq(account.nonce(), 1);
    }
}
