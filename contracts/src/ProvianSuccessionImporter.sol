// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ProvianRecoveryHistory} from "./ProvianRecoveryHistory.sol";
import {ProvianRestorationAuthorization} from "./ProvianRestorationAuthorization.sol";
import {ProvianPVT9} from "./ProvianPVT9.sol";

/// @notice Batches permissionless snapshot proofs. It has no authority, token
/// balance route or arbitrary-call entry point. Every leaf remains checked by
/// its immutable history or restoration executor, in the same transaction.
contract ProvianSuccessionImporter {
    address public immutable history;
    address public immutable authorization;
    error InvalidImport();
    constructor(address history_, address authorization_) {
        if (history_.code.length == 0 || authorization_.code.length == 0 || history_ == authorization_) revert InvalidImport();
        history = history_; authorization = authorization_;
    }
    function importHistory(bytes[] calldata calls) external { _import(history, calls, false); }
    function importBalances(bytes[] calldata calls) external { _import(authorization, calls, true); }
    function _import(address target, bytes[] calldata calls, bool balances) private {
        if (calls.length == 0) revert InvalidImport();
        for (uint256 i; i < calls.length; ++i) {
            bytes calldata data = calls[i];
            if (data.length < 4) revert InvalidImport();
            bytes4 selector = bytes4(data[:4]);
            if (balances ? selector != ProvianRestorationAuthorization.importBalance.selector
                : selector != ProvianRecoveryHistory.importEntry.selector && selector != ProvianRecoveryHistory.importBatch.selector) revert InvalidImport();
            if (balances ? _balanceDone(data) : _historyDone(selector, data)) continue;
            bool ok;
            assembly ("memory-safe") {
                let ptr := mload(0x40)
                calldatacopy(ptr, data.offset, data.length)
                ok := call(gas(), target, 0, ptr, data.length, 0, 0)
            }
            if (!ok) revert InvalidImport();
        }
    }
    function _historyDone(bytes4 selector, bytes calldata data) private view returns (bool) {
        ProvianRecoveryHistory source = ProvianRecoveryHistory(history);
        bytes32 leaf;
        if (selector == ProvianRecoveryHistory.importEntry.selector) {
            (uint8 kind, bytes32 key, uint256 value,) = abi.decode(data[4:], (uint8, bytes32, uint256, bytes32[]));
            leaf = sha256(abi.encode("Provian monetary history", source.predecessor(), source.lastGoodBlock(), kind, key, value));
        } else {
            (bytes32 key, ProvianPVT9.BatchRecord memory record,) = abi.decode(data[4:], (bytes32, ProvianPVT9.BatchRecord, bytes32[]));
            leaf = sha256(abi.encode("Provian settlement history", source.predecessor(), source.lastGoodBlock(), key, sha256(abi.encode(record))));
        }
        // This exact leaf could only be consumed through the target's proof
        // checker. A concurrent permissionless import therefore needs no retry.
        return source.imported(leaf);
    }
    function _balanceDone(bytes calldata data) private view returns (bool) {
        ProvianRestorationAuthorization source = ProvianRestorationAuthorization(authorization);
        (address previousOwner, address destination, uint256 amount, bytes32[] memory proof) =
            abi.decode(data[4:], (address, address, uint256, bytes32[]));
        if (!source.migratedAddress(previousOwner)) return false;
        // The target records consumption by prior owner, so authenticate the
        // exact destination/amount against its immutable root before skipping.
        if (source.cryptographicBreak() || proof.length > 256) revert InvalidImport();
        bytes32 digest = sha256(abi.encode("Provian balance succession", source.predecessor(), source.lastGoodBlock(), previousOwner, destination, amount));
        for (uint256 i; i < proof.length; ++i) {
            bytes32 sibling = proof[i];
            digest = digest < sibling ? sha256(abi.encodePacked(digest, sibling)) : sha256(abi.encodePacked(sibling, digest));
        }
        if (digest != source.restorationRoot()) revert InvalidImport();
        return true;
    }
}
