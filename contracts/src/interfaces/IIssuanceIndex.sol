// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @dev The single issuance-index surface the Agent Bank institution contracts read
 *      to SIZE PVT-denominated costs and collateral against the measured size of
 *      the economy. In production this is the ProvianPVT9 monetary kernel, whose
 *      `trailingAverageForEpoch(e)` is the mean of `epochTotalIssued` over the
 *      twelve epochs `[e-12, e-1]` — permanently retained, append-only history the
 *      kernel already consumes as its own cap driver.
 *
 *      WHAT THIS IS NOT. The trailing average is a MEASURE of economy size used to
 *      size COSTS AND COLLATERAL ONLY. It is never a lever on issuance, never
 *      applied to an earned balance, and never reduces anyone's holdings or their
 *      claim on the whole. Reading it cannot mint, burn, or move a single token:
 *      the function is `view`, and the institutions bind this interface rather than
 *      a concrete kernel type precisely so no other kernel surface is reachable.
 *
 *      DIRECTION. Every consumer uses it through an `_indexFloor(baseline, ppm)`
 *      that returns `max(baseline, ppm * average / 1e6)`. It is therefore a
 *      MINIMUM on a cost parameter and never a maximum on anything — a thin or
 *      absent index can only leave the historical literal standing, never lower it.
 *
 *      IMPORTANT — fail-closed contract: the kernel returns a literal `0` for any
 *      epoch below its twelve-epoch flat-launch window, and `currentEpoch()` REVERTS
 *      before the kernel is armed. Callers MUST treat both a zero and a revert as
 *      "no measurement yet" (floor inert → the historical literal stands), never as
 *      a hard failure that bricks the institution. Institutions bind this as a
 *      constructor immutable (no setter, no new settable-address authority).
 */
interface IIssuanceIndex {
    /// @notice Mean PVT issued per epoch over the twelve epochs preceding `epoch`.
    ///         Returns 0 inside the flat-launch window (no measurement yet), so a
    ///         caller's floor is inert and the baseline literal stands.
    function trailingAverageForEpoch(uint64 epoch) external view returns (uint256);
}
