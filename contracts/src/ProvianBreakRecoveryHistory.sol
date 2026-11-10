// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ProvianRecoveryHistory} from "./ProvianRecoveryHistory.sol";
import {ProvianPVT9} from "./ProvianPVT9.sol";
import {ProvianHashAccount} from "./ProvianHashAccount.sol";

/// @notice Last-good monetary history after a curve break. The hash-authorized
/// successor publication commits the explicit treasury recovery mapping. Only
/// treasury destinations change; historical policies and economic amounts do not.
contract ProvianBreakRecoveryHistory is ProvianRecoveryHistory {
    struct TreasuryRecovery { address previous; ProvianHashAccount successor; }
    bytes private recoveredState;
    bytes32 public immutable treasuryRecoveryHash;
    constructor(address previous, uint256 cutoff, bytes32 historyRoot, uint256 count,
        State memory source, TreasuryRecovery[] memory recoveries)
        ProvianRecoveryHistory(previous, cutoff, historyRoot, count, source) {
        bytes32 codeHash = keccak256(type(ProvianHashAccount).runtimeCode);
        for (uint256 i; i < recoveries.length; ++i) {
            TreasuryRecovery memory r = recoveries[i];
            if (r.previous == address(0) || address(r.successor).codehash != codeHash
                || r.successor.keyCommitment() == bytes32(0)) revert InvalidHistory();
            bool used = source.provianTreasury == r.previous || source.foundationTreasury == r.previous;
            for (uint256 j; j < source.schedules.length; ++j) {
                EconomicSchedule memory s = source.schedules[j];
                if (s.treasuriesSet && (s.provianTreasury == r.previous || s.foundationTreasury == r.previous)) used = true;
            }
            if (!used) revert InvalidHistory();
            for (uint256 j; j < i; ++j) {
                if (recoveries[j].previous == r.previous || recoveries[j].successor == r.successor) revert InvalidHistory();
            }
        }
        treasuryRecoveryHash = sha256(abi.encode(recoveries));
        source.provianTreasury = _recover(source.provianTreasury, recoveries, codeHash);
        source.foundationTreasury = _recover(source.foundationTreasury, recoveries, codeHash);
        for (uint256 i; i < source.schedules.length; ++i) {
            if (!source.schedules[i].treasuriesSet) continue;
            source.schedules[i].provianTreasury = _recover(source.schedules[i].provianTreasury, recoveries, codeHash);
            source.schedules[i].foundationTreasury = _recover(source.schedules[i].foundationTreasury, recoveries, codeHash);
        }
        recoveredState = abi.encode(source);
    }
    function _recover(address previous, TreasuryRecovery[] memory recoveries, bytes32 codeHash) private view returns (address) {
        for (uint256 i; i < recoveries.length; ++i) if (recoveries[i].previous == previous) return address(recoveries[i].successor);
        if (previous.codehash != codeHash || ProvianHashAccount(payable(previous)).keyCommitment() == bytes32(0)) revert InvalidHistory();
        return previous;
    }
    function sourceState() external view returns (State memory) { return abi.decode(encodedState, (State)); }
    function state() external view override returns (State memory) { return abi.decode(recoveredState, (State)); }
    function afterCryptographicBreak() external pure override returns (bool) { return true; }
    /// @notice Broken curve keys cannot establish a trustworthy retirement of
    /// the old rail. Publication by the permanent hash authority selects the
    /// last-good history; clients refuse the retired deployment thereafter.
    function validArming(ProvianPVT9.EpochZeroConfig calldata config, ProvianPVT9.VerifierConfig calldata beneficiary)
        external view override returns (bool) {
        return _armingMatches(abi.decode(recoveredState, (State)), config, beneficiary);
    }
}
