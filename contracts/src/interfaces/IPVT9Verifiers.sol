// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Narrow verifier interface for exact standard-PE settlement batches.
interface IPVT9EligibilityVerifier {
    function verifyStandardBatch(bytes32 settlementDigest, bytes32 configurationId, uint64 configurationVersion)
        external
        view
        returns (bool);

    function verifyGenesisBatch(bytes32 settlementDigest, bytes32 configurationId, uint64 configurationVersion)
        external
        view
        returns (bool);
}

/// @notice Separate attestation of beneficiary classifications in a batch.
interface IPVT9BeneficiaryVerifier {
    function verifyBeneficiaryClassifications(
        bytes32 settlementDigest,
        bytes32 configurationId,
        uint64 configurationVersion
    ) external view returns (bool);
}
