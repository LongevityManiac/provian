// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {ProvianProtocolPointer} from "../../src/ProvianProtocolPointer.sol";

/// The live protocol set on a Base fork, discovered only through the permanent pointer.
/// The pointer's own runtime hash is checked against the published pin, and `component`
/// refuses any component whose runtime hash differs from the published set or that is retired.
library LiveProtocol {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant KERNEL = 0;
    uint256 internal constant ELIGIBILITY_VERIFIER = 1;
    uint256 internal constant RECOURSE_POOL = 8;

    function component(uint256 index) internal view returns (address) {
        string memory pin = VM.readFile("../config/protocol-pointer.json");
        address pointer = VM.parseJsonAddress(pin, ".address");
        require(pointer.codehash == VM.parseJsonBytes32(pin, ".runtimeHash"), "protocol pointer runtime hash mismatch");
        return ProvianProtocolPointer(pointer).component(index);
    }
}
