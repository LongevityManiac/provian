// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IEpochClock} from "../src/interfaces/IEpochClock.sol";

/**
 * @title MockEpochClock
 * @notice Test double for the ProvianPVT9 kernel's epoch clock (IEpochClock),
 *         faithful to the kernel's TIME-DERIVED epoch. When armed,
 *         `currentEpoch() = (block.timestamp - startsAt) / EPOCH_DURATION`, so it
 *         advances exactly one epoch per EPOCH_DURATION of real time and CANNOT be
 *         advanced faster — there is no permissionless "open the next epoch" call.
 *         When unarmed, or before `startsAt`, it REVERTS exactly like the real
 *         kernel (EpochZeroNotArmed / EpochNotStarted), so an institution's
 *         fail-closed try/catch is exercised.
 *
 *         Because the epoch is a pure function of block.timestamp, a test drives
 *         institution epochs purely via `vm.warp` and can prove that a queued
 *         schedule ladder is non-collapsible in a single block: within one block
 *         the epoch is fixed, so no sequence of calls can advance more than one rung.
 */
contract MockEpochClock is IEpochClock {
    /// @dev Matches ProvianPVT9.EPOCH_DURATION.
    uint256 public constant EPOCH_DURATION = 7 days;

    bool public armed;
    uint64 public startsAt;

    error NotArmed();
    error NotStarted();

    /// @param _startsAt epoch-zero start timestamp; pass 0 to leave the clock
    ///        UNARMED (currentEpoch() reverts until `arm` is called).
    constructor(uint64 _startsAt) {
        if (_startsAt != 0) {
            armed = true;
            startsAt = _startsAt;
        }
    }

    /// @notice Arm (or re-arm) at a start timestamp. Test-only.
    function arm(uint64 _startsAt) external {
        armed = true;
        startsAt = _startsAt;
    }

    /// @notice Disarm so currentEpoch() reverts (simulates a pre-arming kernel).
    function disarm() external {
        armed = false;
    }

    /// @inheritdoc IEpochClock
    function currentEpoch() external view returns (uint64) {
        if (!armed) revert NotArmed();
        if (block.timestamp < startsAt) revert NotStarted();
        return uint64((block.timestamp - startsAt) / EPOCH_DURATION);
    }
}
