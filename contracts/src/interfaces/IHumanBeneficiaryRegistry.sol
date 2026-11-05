// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IHumanBeneficiaryRegistry
 * @notice Registry consulted by ProvianPVTv4 at mint time to determine the
 *         Foundation-share rate for each contributor.
 *
 *         Two query methods are exposed intentionally:
 *
 *         - `isHumanBeneficiaryChain` answers the rate-gating question: does
 *           this wallet's beneficiary chain terminate at a verified human
 *           within HOP_LIMIT hops? During PreVerification (stub registry),
 *           this returns true for every wallet so every mint gets the human
 *           Foundation rate.
 *
 *         - `hasDeclaredHumanBeneficiary` answers the composition-tracking
 *           question: has this wallet declared a human beneficiary in the
 *           registry? This is distinct from the rate-gating question because
 *           the composition metric must reflect real declaration data even
 *           during PreVerification when every mint gets the human rate.
 *
 *         Hop walking is the registry implementation's responsibility. PVTv4
 *         asks a single binary question per mint and never walks chains itself.
 */
interface IHumanBeneficiaryRegistry {
    /// @notice Does this wallet's beneficiary chain terminate at a verified
    ///         human within HOP_LIMIT hops? Used for rate gating at mint time.
    function isHumanBeneficiaryChain(address wallet) external view returns (bool);

    /// @notice Has this wallet declared a human beneficiary in the registry?
    ///         Used for composition-metric tracking, independent of chain
    ///         verification state.
    function hasDeclaredHumanBeneficiary(address wallet) external view returns (bool);

    /// @notice Maximum hops the registry walks when evaluating
    ///         isHumanBeneficiaryChain. Fixed at 3 by protocol.
    function HOP_LIMIT() external view returns (uint256);
}
