// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {ProvianHashAccount} from "../src/ProvianHashAccount.sol";
import {ProvianHashAccountFactory} from "../src/ProvianHashAccountFactory.sol";

contract ProvianHashAccountFactoryTest is Test {
    function testPermissionlessDeploymentCannotChangeOwnerRoot() public {
        ProvianHashAccountFactory factory = new ProvianHashAccountFactory();
        bytes32 root = sha256("owner test root");
        address expected = factory.accountAddress(root);
        vm.prank(address(0xbad));
        ProvianHashAccount account = factory.deploy(root);
        assertEq(address(account), expected);
        assertEq(account.keyCommitment(), root);
        assertEq(account.nonce(), 0);
        assertEq(address(account).codehash, keccak256(type(ProvianHashAccount).runtimeCode));
        assertEq(address(factory.deploy(root)), expected);
        assertTrue(factory.accountAddress(sha256("another test root")) != expected);
        bytes32 nextRoot = sha256("next test root");
        vm.expectRevert(ProvianHashAccount.InvalidSignature.selector);
        account.execute(address(0xbad), 0, 100_000, "", nextRoot, "", "");
        assertEq(account.keyCommitment(), root);
    }
    function testFactoryDomainsAndZeroRootRefusal() public {
        ProvianHashAccountFactory first = new ProvianHashAccountFactory();
        ProvianHashAccountFactory second = new ProvianHashAccountFactory();
        bytes32 root = sha256("test root");
        assertTrue(first.accountAddress(root) != second.accountAddress(root));
        vm.expectRevert(ProvianHashAccountFactory.InvalidRoot.selector);
        first.deploy(bytes32(0));
    }
}
