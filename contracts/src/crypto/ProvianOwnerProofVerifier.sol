// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {SlhDsaSha2128s} from "./SlhDsaSha2128s.sol";

/// @notice Stateless verifier deployed by each owner-authorization executor.
/// It holds no key or authority and has no setter, delegatecall or upgrade path.
contract ProvianOwnerProofVerifier {
    function verify(bytes32 digest, bytes calldata signature, bytes calldata publicKey) external view returns (bool) {
        return SlhDsaSha2128s.verify(digest, signature, publicKey);
    }
}
