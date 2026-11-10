// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
/// @dev Requires forge test --ffi. The fixed executable accepts only public test
/// seeds and digests; no production key, environment secret or user command.
abstract contract SlhTestSigner is Test {
    function slhPublic(uint256 index) internal returns (bytes memory pk) {
        (pk,) = slhSign(index, bytes32(0));
    }
    function slhSign(uint256 index, bytes32 digest) internal returns (bytes memory pk, bytes memory signature) {
        string[] memory cmd = new string[](4);
        cmd[0] = "node"; cmd[1] = "test/helpers/slh-sign.mjs";
        cmd[2] = vm.toString(abi.encodePacked(bytes32(index), bytes16(uint128(index))));
        cmd[3] = vm.toString(digest);
        return abi.decode(vm.ffi(cmd), (bytes, bytes));
    }
}
