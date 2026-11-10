// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ProvianHashAccount} from "./ProvianHashAccount.sol";

/// @notice Permissionless deterministic deployment. The initial hash root alone
/// selects the account; deploying it for someone else grants no authority.
contract ProvianHashAccountFactory {
    error InvalidRoot();
    event AccountDeployed(bytes32 indexed initialRoot, address indexed account);

    function accountAddress(bytes32 initialRoot) public view returns (address) {
        if (initialRoot == bytes32(0)) revert InvalidRoot();
        bytes32 initHash = keccak256(abi.encodePacked(type(ProvianHashAccount).creationCode, abi.encode(initialRoot)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), initialRoot, initHash)))));
    }

    function deploy(bytes32 initialRoot) external returns (ProvianHashAccount account) {
        address expected = accountAddress(initialRoot);
        if (expected.code.length != 0) return ProvianHashAccount(payable(expected));
        account = new ProvianHashAccount{salt: initialRoot}(initialRoot);
        emit AccountDeployed(initialRoot, address(account));
    }
}
