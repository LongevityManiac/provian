// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import "../src/crypto/SlhDsaSha2128s.sol";
contract SlhVerificationHarness {
    function verify(bytes32 message, bytes calldata signature, bytes calldata pk) external view returns (bool) {
        return SlhDsaSha2128s.verify(message, signature, pk);
    }
}
contract SlhDsaSha2128sTest is Test {
    SlhVerificationHarness verifier = new SlhVerificationHarness();
    function vector(uint256 index) private view returns (bytes32 message, bytes memory signature, bytes memory pk) {
        string memory json = vm.readFile("test/fixtures/slh-dsa-128s.json");
        string memory base = string.concat("[", vm.toString(index), "]");
        return (vm.parseJsonBytes32(json, string.concat(base, ".message")),
            vm.parseJsonBytes(json, string.concat(base, ".signature")), vm.parseJsonBytes(json, string.concat(base, ".publicKey")));
    }
    function testIndependentOpenSslVectorsAndStatelessRepeatedKey() public view {
        for (uint256 i; i < 3; ++i) {
            (bytes32 m, bytes memory s, bytes memory pk) = vector(i);
            uint256 before = gasleft();
            assertTrue(verifier.verify(m, s, pk));
            uint256 used = before - gasleft();
            console2.log("SLH-DSA verify gas", used);
            assertLt(used, 10_000_000);
        }
    }
    function testRejectSubstitutionsAndMalformedLengths() public view {
        (bytes32 m, bytes memory s, bytes memory pk) = vector(0);
        assertFalse(verifier.verify(bytes32(uint256(m) ^ 1), s, pk));
        pk[0] ^= 0x01;
        assertFalse(verifier.verify(m, s, pk));
        pk[0] ^= 0x01;
        assertFalse(verifier.verify(m, new bytes(7855), pk));
        assertFalse(verifier.verify(m, new bytes(7857), pk));
        assertFalse(verifier.verify(m, s, new bytes(31)));
        assertFalse(verifier.verify(m, s, new bytes(33)));
        s[0] ^= 0x01;
        assertFalse(verifier.verify(m, s, pk));
    }
    function testFuzzRejectMutatedSignature(uint16 offset, uint8 bit) public view {
        (bytes32 m, bytes memory s, bytes memory pk) = vector(1);
        s[uint256(offset) % s.length] ^= bytes1(uint8(1 << (bit % 8)));
        assertFalse(verifier.verify(m, s, pk));
    }
}
