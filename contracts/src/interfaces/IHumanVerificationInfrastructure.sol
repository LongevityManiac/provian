// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IHumanVerificationInfrastructure
 * @notice Interface consumed by ProvianHumanGovernance to determine one-human
 *         voting eligibility and the active-verified-human denominator for
 *         governance thresholds.
 *
 *         The real implementation is outside the W7 scope. Candidates include
 *         Worldcoin, IDKit, or successor systems that combine proof of
 *         personhood with a device-level liveness signal. PVTv4 stores the
 *         address of the selected implementation; only ProvianHumanGovernance
 *         calls it.
 *
 *         Liveness culling semantics: `isActiveVerifiedHuman` returns true
 *         only if a wallet has produced a valid liveness signal within
 *         `getLivenessWindow()`. The launch window is 180 days; the target
 *         mature window is 30 days. `setLivenessWindow` is governance-gated
 *         (one-way toward shorter, enforced inside the implementation).
 */
interface IHumanVerificationInfrastructure {
    /// @notice Is this wallet currently counted as an active verified human?
    ///         Used as the one-vote predicate in ProvianHumanGovernance.
    function isActiveVerifiedHuman(address voter) external view returns (bool);

    /// @notice How many wallets currently satisfy isActiveVerifiedHuman?
    ///         Used as the denominator for supermajority thresholds.
    function activeVerifiedHumanCount() external view returns (uint256);

    /// @notice Current liveness window in seconds.
    function getLivenessWindow() external view returns (uint256);

    /// @notice Set the liveness window. Governance-gated inside the
    ///         implementation; one-way toward shorter.
    function setLivenessWindow(uint256 window) external;
}
