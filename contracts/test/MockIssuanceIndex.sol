// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IIssuanceIndex} from "../src/interfaces/IIssuanceIndex.sol";

/**
 * @title MockIssuanceIndex
 * @notice Test double for the ProvianPVT9 kernel's issuance index (IIssuanceIndex),
 *         faithful to the kernel's actual semantics:
 *
 *           - `trailingAverageForEpoch(e)` returns the mean of `epochTotalIssued`
 *             over the twelve epochs [e-12, e-1];
 *           - it returns a literal 0 for any epoch below TRAILING_AVERAGE_EPOCHS,
 *             which is why an institution's floors are provably inert during the
 *             flat-launch window;
 *           - the averaging is the kernel's exact quotient+remainder form, so a
 *             test comparing against a hand-computed mean matches to the wei.
 *
 *         `setRevert(true)` makes every read revert, so an institution's
 *         fail-closed try/catch is EXERCISED rather than assumed — without it, the
 *         "unreachable kernel resolves to the literal" claim would be a guard that
 *         has never been observed failing.
 *
 *         DEFAULT STATE IS ZERO. A freshly constructed mock reports no issuance at
 *         all, which is exactly the live Base position today (epoch 0, average 0),
 *         so a fixture that simply passes this mock reproduces current behavior
 *         byte-for-byte and any floor that binds in such a test is a real defect.
 */
contract MockIssuanceIndex is IIssuanceIndex {
    /// @dev Matches ProvianPVT9.TRAILING_AVERAGE_EPOCHS.
    uint64 public constant TRAILING_AVERAGE_EPOCHS = 12;

    mapping(uint64 => uint256) public epochTotalIssued;
    bool public reverting;

    error IndexUnavailable();

    /// @notice Seed one epoch's issuance. Test-only.
    function setEpochIssued(uint64 epoch, uint256 amount) external {
        epochTotalIssued[epoch] = amount;
    }

    /// @notice Seed a flat issuance across [from, from + count). Test-only convenience
    ///         for driving the twelve-epoch window to a known average.
    function seedFlat(uint64 from, uint64 count, uint256 amountPerEpoch) external {
        for (uint64 i = from; i < from + count; ++i) {
            epochTotalIssued[i] = amountPerEpoch;
        }
    }

    /// @notice Make every read revert, simulating an unreachable/unarmed kernel.
    function setRevert(bool v) external {
        reverting = v;
    }

    /// @inheritdoc IIssuanceIndex
    function trailingAverageForEpoch(uint64 epoch) external view returns (uint256 average) {
        if (reverting) revert IndexUnavailable();
        if (epoch < TRAILING_AVERAGE_EPOCHS) return 0;
        uint256 quotientTotal;
        uint256 remainderTotal;
        uint64 first = epoch - TRAILING_AVERAGE_EPOCHS;
        for (uint64 i = first; i < epoch; ++i) {
            uint256 issued = epochTotalIssued[i];
            quotientTotal += issued / TRAILING_AVERAGE_EPOCHS;
            remainderTotal += issued % TRAILING_AVERAGE_EPOCHS;
        }
        average = quotientTotal + remainderTotal / TRAILING_AVERAGE_EPOCHS;
    }
}
