// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @dev The single epoch-clock surface the Agent Bank institution contracts read
 *      to time their prospective cost-parameter schedules. In production this is
 *      the ProvianPVT9 monetary kernel, whose `currentEpoch()` is a pure function
 *      of `block.timestamp` (7-day epochs from a fixed, armed start), so it cannot
 *      be advanced faster than real time — there is no permissionless "open the
 *      next epoch" call to collapse a queued schedule ladder in a single block.
 *
 *      IMPORTANT — fail-closed contract: `currentEpoch()` REVERTS before the
 *      kernel is armed (EpochZeroNotArmed) and before epoch zero has started
 *      (EpochNotStarted). Callers MUST treat a revert as "no schedulable epoch has
 *      begun yet" (epoch 0, all overrides inert → the historical literal stands),
 *      never as a hard failure that bricks the institution. Institutions bind this
 *      as a constructor immutable (no setter, no new settable-address authority).
 *
 *      It deliberately exposes ONLY `currentEpoch()`; institutions never bind to a
 *      concrete ProvianPVT9 type or reach any other kernel surface.
 */
interface IEpochClock {
    /// @notice The current epoch index. Reverts when the clock is unarmed or has
    ///         not started (callers fail closed to epoch 0 / the baseline literal).
    function currentEpoch() external view returns (uint64);
}
