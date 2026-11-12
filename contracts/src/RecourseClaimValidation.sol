// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ProvianRecourseKernel} from "./ProvianRecourseKernel.sol";
/// @notice Fixed validation code deployed by its kernel. It can read claims,
/// never change policy, balances or the result of settlement.
contract RecourseClaimValidation {
    ProvianRecourseKernel private immutable kernel;
    error EmptyBatch(); error RecipientsNotStrictlyOrdered(); error ClaimRangeMismatch();
    error BeneficiaryClassificationInvalid(); error BeneficiaryClassificationRequired();
    error InvalidClaim(); error ClaimAlreadySettled(); error GenesisQualificationOutsideWindow();
    error InvalidGenesisGrant(); error GenesisAnchorAlreadyUsed(); error GenesisWalletCeilingExceeded();
    constructor() { kernel = ProvianRecourseKernel(msg.sender); }
    function validateStandard(
        bool differential,
        ProvianRecourseKernel.StandardRecipient[] calldata recipients,
        ProvianRecourseKernel.StandardPEClaim[] calldata claims
    ) external view {
        if (claims.length == 0) revert EmptyBatch();
        uint256 expectedClaims;
        address previous;
        for (uint256 i = 0; i < recipients.length; ++i) {
            ProvianRecourseKernel.StandardRecipient calldata recipient = recipients[i];
            if (recipient.contributor <= previous) revert RecipientsNotStrictlyOrdered();
            previous = recipient.contributor;
            if (recipient.claimCount == 0 || expectedClaims + recipient.claimCount > claims.length) {
                revert ClaimRangeMismatch();
            }
            if (uint8(recipient.beneficiaryClass) > uint8(ProvianRecourseKernel.BeneficiaryClass.AutonomousAgent)) {
                revert ProvianRecourseKernel.BeneficiaryClassificationInvalid();
            }
            if (differential && recipient.beneficiaryClass == ProvianRecourseKernel.BeneficiaryClass.Unknown) {
                revert ProvianRecourseKernel.BeneficiaryClassificationRequired();
            }
            expectedClaims += recipient.claimCount;
        }
        if (expectedClaims != claims.length) revert ClaimRangeMismatch();
        for (uint256 i = 0; i < claims.length; ++i) {
            if (claims[i].claimId == bytes32(0) || claims[i].recordPointsAtomic == 0) revert InvalidClaim();
            if (kernel.claimSettled(claims[i].claimId)) revert ClaimAlreadySettled();
        }
    }

    function validateGenesis(ProvianRecourseKernel.GenesisRecipient[] calldata recipients, ProvianRecourseKernel.GenesisPEClaim[] calldata claims)
        external
        view
    {
        if (claims.length == 0) revert EmptyBatch();
        uint256 expectedClaims;
        address previous;
        uint64 lastQualifyingAt = kernel.genesisAdmissionClosed() ? kernel.genesisAdmissionCutoff() : kernel.genesisEndsAt();
        for (uint256 i = 0; i < recipients.length; ++i) {
            ProvianRecourseKernel.GenesisRecipient calldata recipient = recipients[i];
            if (recipient.contributor <= previous) revert RecipientsNotStrictlyOrdered();
            previous = recipient.contributor;
            if (recipient.claimCount == 0 || expectedClaims + recipient.claimCount > claims.length) {
                revert ClaimRangeMismatch();
            }
            expectedClaims += recipient.claimCount;
        }
        if (expectedClaims != claims.length) revert ClaimRangeMismatch();
        for (uint256 i = 0; i < claims.length; ++i) {
            ProvianRecourseKernel.GenesisPEClaim calldata claim = claims[i];
            if (
                claim.claimId == bytes32(0) || claim.walletId == bytes32(0) || claim.oneTimeAnchor == bytes32(0)
                    || claim.reservedGrossAtomic == 0
            ) revert InvalidClaim();
            if (kernel.claimSettled(claim.claimId)) revert ClaimAlreadySettled();
            if (
                claim.qualifiedAt < kernel.genesisStartsAt() || claim.qualifiedAt > lastQualifyingAt
                    || claim.qualifiedAt > block.timestamp
            ) revert GenesisQualificationOutsideWindow();
            uint256 maximum = kernel.genesisGrantMaximum(claim.grantType);
            if (claim.reservedGrossAtomic > maximum) revert InvalidGenesisGrant();
            if (kernel.genesisAnchorUsed(kernel.genesisAnchorKey(claim.grantType, claim.oneTimeAnchor))) {
                revert GenesisAnchorAlreadyUsed();
            }
            if (kernel.genesisWalletGrossIssued(claim.walletId) > 500 ether - claim.reservedGrossAtomic) {
                revert GenesisWalletCeilingExceeded();
            }
        }
    }

    function trailingAverageForEpoch(uint64 epoch) external view returns (uint256 average) {
        if (epoch < 12) return 0;
        uint256 quotientTotal;
        uint256 remainderTotal;
        uint64 first = epoch - 12;
        for (uint64 i = first; i < epoch; ++i) {
            uint256 issued = kernel.epochTotalIssued(i);
            quotientTotal += issued / 12;
            remainderTotal += issued % 12;
        }
        average = quotientTotal + remainderTotal / 12;
    }

}
