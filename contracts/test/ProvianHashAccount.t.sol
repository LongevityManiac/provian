// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SlhTestSigner} from "./helpers/SlhTestSigner.sol";
import {ProvianHashAccount} from "../src/ProvianHashAccount.sol";

contract HashAccountTarget {
    uint256 public value;
    function set(uint256 value_) external { value = value_; }
    function fail() external pure { revert("target failure"); }
    function exhaustGas() external pure { assembly { invalid() } }
}

contract ProvianHashAccountTest is SlhTestSigner {
    ProvianHashAccount internal account;
    HashAccountTarget internal target;
    uint256 internal signingIndex = 1;
    bytes internal publicKeys;
    bytes32 internal nextKey;
    uint256 internal constant CALL_GAS = 100_000;

    function setUp() public {
        vm.chainId(8453);
        publicKeys = slhPublic(signingIndex);
        account = new ProvianHashAccount(sha256(publicKeys));
        target = new HashAccountTarget();
        nextKey = sha256("fresh next key fixture");
    }

    function sign(bytes memory data) internal returns (bytes memory signature) {
        bytes32 digest = account.intentDigest(address(target), 0, CALL_GAS, data, nextKey);
        (, signature) = slhSign(signingIndex, digest);
    }

    function testContractSignaturesBindAccountRootChainAndMessage() public {
        bytes32 message = sha256("ownership binding TEST ONLY");
        (, bytes memory signature) = slhSign(1, account.signatureDigest(message));
        bytes memory proof = abi.encodePacked(publicKeys, signature);
        assertEq(account.isValidSignature(message, proof), bytes4(0x1626ba7e));
        assertEq(account.isValidSignature(sha256("substituted binding"), proof), bytes4(0xffffffff));
        assertEq(account.isValidSignature(message, hex"00"), bytes4(0xffffffff));
        vm.chainId(1);
        assertEq(account.isValidSignature(message, proof), bytes4(0xffffffff));
        vm.chainId(8453);
        ProvianHashAccount other = new ProvianHashAccount(account.keyCommitment());
        assertEq(other.isValidSignature(message, proof), bytes4(0xffffffff));
        bytes memory data = abi.encodeCall(target.set, (42));
        bytes memory executionSignature = sign(data);
        assertTrue(account.execute(address(target), 0, CALL_GAS, data, nextKey, publicKeys, executionSignature));
        assertEq(account.isValidSignature(message, proof), bytes4(0xffffffff));
    }

    function testValidSignatureExecutesAndConsumesRoot() public {
        bytes memory data = abi.encodeCall(target.set, (42));
        bytes memory signature = sign(data);
        assertTrue(account.execute(address(target), 0, CALL_GAS, data, nextKey, publicKeys, signature));
        assertEq(target.value(), 42);
        assertEq(account.nonce(), 1);
        assertEq(account.keyCommitment(), nextKey);
        vm.expectRevert(ProvianHashAccount.InvalidKey.selector);
        account.execute(address(target), 0, CALL_GAS, data, nextKey, publicKeys, signature);
    }

    function testDestinationCalldataAndNextRootCannotBeSubstituted() public {
        bytes memory data = abi.encodeCall(target.set, (42));
        bytes memory signature = sign(data);
        vm.expectRevert(ProvianHashAccount.InvalidSignature.selector);
        account.execute(address(0xDEAD), 0, CALL_GAS, data, nextKey, publicKeys, signature);
        vm.expectRevert(ProvianHashAccount.InvalidSignature.selector);
        account.execute(address(target), 0, CALL_GAS, abi.encodeCall(target.set, (43)), nextKey, publicKeys, signature);
        bytes32 attackerRoot = keccak256("attacker");
        vm.expectRevert(ProvianHashAccount.InvalidSignature.selector);
        account.execute(address(target), 0, CALL_GAS, data, attackerRoot, publicKeys, signature);
        assertEq(account.nonce(), 0);
    }

    function testTargetFailureStillRotatesKey() public {
        bytes memory data = abi.encodeCall(target.fail, ());
        bytes memory signature = sign(data);
        assertFalse(account.execute(address(target), 0, CALL_GAS, data, nextKey, publicKeys, signature));
        assertEq(account.keyCommitment(), nextKey);
        assertEq(account.nonce(), 1);
    }

    function testWrongPreimageAndReusedRootFail() public {
        bytes memory data = abi.encodeCall(target.set, (42));
        bytes memory signature = sign(data);
        signature[0] ^= 0x01;
        vm.expectRevert(ProvianHashAccount.InvalidSignature.selector);
        account.execute(address(target), 0, CALL_GAS, data, nextKey, publicKeys, signature);
        bytes32 initial = account.keyCommitment();
        vm.expectRevert(ProvianHashAccount.InvalidKey.selector);
        account.execute(address(target), 0, CALL_GAS, data, initial, publicKeys, signature);
    }

    function testSecondSuccessfulExecutionUsesIndependentNextKey() public {
        bytes memory nextPublic = slhPublic(2);
        nextKey = sha256(nextPublic);
        bytes memory data = abi.encodeCall(target.set, (42));
        bytes memory signature = sign(data);
        assertTrue(account.execute(address(target), 0, CALL_GAS, data, nextKey, publicKeys, signature));
        publicKeys = nextPublic;
        signingIndex = 2;
        nextKey = sha256("third root fixture");
        data = abi.encodeCall(target.set, (43));
        signature = sign(data);
        assertTrue(account.execute(address(target), 0, CALL_GAS, data, nextKey, publicKeys, signature));
        assertEq(target.value(), 43);
        assertEq(account.nonce(), 2);
    }

    function testChainAccountValueAndGasSubstitutionFail() public {
        bytes memory data = abi.encodeCall(target.set, (42));
        bytes memory signature = sign(data);
        ProvianHashAccount other = new ProvianHashAccount(account.keyCommitment());
        vm.expectRevert(ProvianHashAccount.InvalidSignature.selector);
        other.execute(address(target), 0, CALL_GAS, data, nextKey, publicKeys, signature);
        vm.chainId(1);
        vm.expectRevert(ProvianHashAccount.InvalidSignature.selector);
        account.execute(address(target), 0, CALL_GAS, data, nextKey, publicKeys, signature);
        vm.chainId(8453);
        vm.expectRevert(ProvianHashAccount.InvalidSignature.selector);
        account.execute(address(target), 1, CALL_GAS, data, nextKey, publicKeys, signature);
        vm.expectRevert(ProvianHashAccount.InvalidSignature.selector);
        account.execute(address(target), 0, CALL_GAS - 1, data, nextKey, publicKeys, signature);
        assertEq(account.nonce(), 0);
    }

    function testTargetGasExhaustionStillConsumesKey() public {
        bytes memory data = abi.encodeCall(target.exhaustGas, ());
        bytes memory signature = sign(data);
        assertFalse(account.execute(address(target), 0, CALL_GAS, data, nextKey, publicKeys, signature));
        assertEq(account.keyCommitment(), nextKey);
        assertEq(account.nonce(), 1);
    }

    function testInsufficientOuterGasCannotConsumeKeyOrChangeTarget() public {
        bytes memory data = abi.encodeCall(target.set, (42));
        bytes memory signature = sign(data);
        bytes32 original = account.keyCommitment();
        bytes memory callData = abi.encodeCall(account.execute,
            (address(target), 0, CALL_GAS, data, nextKey, publicKeys, signature));
        (bool ok,) = address(account).call{gas: 100_000}(callData);
        assertFalse(ok);
        assertEq(account.nonce(), 0);
        assertEq(account.keyCommitment(), original);
        assertEq(target.value(), 0);
        assertTrue(account.execute(address(target), 0, CALL_GAS, data, nextKey, publicKeys, signature));
    }
}
