// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ProvianPVT9} from "../src/ProvianPVT9.sol";
import {IPVT9BeneficiaryVerifier, IPVT9EligibilityVerifier} from "../src/interfaces/IPVT9Verifiers.sol";

/**
 * @dev TEST DOUBLE ONLY — not a verifier, and never a deployment candidate.
 *
 * It DISCARDS the settlement digest and returns a boolean the test sets, which is exactly
 * what a real verifier must not do. Its purpose is to drive the KERNEL's own paths (a
 * verifier that denies, a verifier that reverts) from tests that are about the kernel.
 *
 * The production eligibility verifier is `src/ProvianPVT9EligibilityVerifier.sol`, which
 * re-derives the digest from the batch it approved and affirms nothing else. Its end-to-end
 * settlement coverage against a real kernel lives in
 * `test/ProvianPVT9EligibilityVerifier.t.sol` section G.
 */
contract MockPVT9Verifier is IPVT9EligibilityVerifier, IPVT9BeneficiaryVerifier {
    bytes32 public expectedEligibilityId;
    uint64 public expectedEligibilityVersion;
    bytes32 public expectedBeneficiaryId;
    uint64 public expectedBeneficiaryVersion;
    bool public eligibilityResult = true;
    bool public beneficiaryResult = true;
    bool public revertEligibility;
    bool public revertBeneficiary;

    constructor(bytes32 eligibilityId, uint64 eligibilityVersion, bytes32 beneficiaryId, uint64 beneficiaryVersion) {
        expectedEligibilityId = eligibilityId;
        expectedEligibilityVersion = eligibilityVersion;
        expectedBeneficiaryId = beneficiaryId;
        expectedBeneficiaryVersion = beneficiaryVersion;
    }

    function setEligibilityResult(bool result) external {
        eligibilityResult = result;
    }

    function setBeneficiaryResult(bool result) external {
        beneficiaryResult = result;
    }

    function setRevertEligibility(bool value) external {
        revertEligibility = value;
    }

    function setRevertBeneficiary(bool value) external {
        revertBeneficiary = value;
    }

    function verifyStandardBatch(bytes32, bytes32 configurationId, uint64 configurationVersion)
        external
        view
        returns (bool)
    {
        if (revertEligibility) revert("eligibility unavailable");
        return eligibilityResult && configurationId == expectedEligibilityId
            && configurationVersion == expectedEligibilityVersion;
    }

    function verifyGenesisBatch(bytes32, bytes32 configurationId, uint64 configurationVersion)
        external
        view
        returns (bool)
    {
        if (revertEligibility) revert("eligibility unavailable");
        return eligibilityResult && configurationId == expectedEligibilityId
            && configurationVersion == expectedEligibilityVersion;
    }

    function verifyBeneficiaryClassifications(bytes32, bytes32 configurationId, uint64 configurationVersion)
        external
        view
        returns (bool)
    {
        if (revertBeneficiary) revert("beneficiary unavailable");
        return beneficiaryResult && configurationId == expectedBeneficiaryId
            && configurationVersion == expectedBeneficiaryVersion;
    }
}

contract MalformedPVT9Verifier {
    fallback() external {
        assembly ("memory-safe") {
            mstore(0, 2)
            return(0, 32)
        }
    }
}

abstract contract ProvianPVT9TestBase is Test {
    /// @dev Deliberately an independent literal, NOT `ProvianPVT9.BOOTSTRAP_ADMIN`:
    /// `ProvianPVT9Core.t.sol` asserts `BOOTSTRAP_ADMIN() == ADMIN`, so sourcing this
    /// from the contract would make that assertion vacuous. Keep it hand-written and
    /// move it deliberately whenever the kernel constant moves.
    address internal constant ADMIN = 0xCa37a15A64213b2ACD1784ae3f8e6Cbd4600D9D3;
    address internal constant MINTER = address(0xBEEF);
    address internal constant PROVIAN_TREASURY = address(0xA001);
    address internal constant FOUNDATION_TREASURY = address(0xA002);
    bytes32 internal constant ELIGIBILITY_ID = keccak256("eligibility-v1");
    uint64 internal constant ELIGIBILITY_VERSION = 1;
    bytes32 internal constant BENEFICIARY_ID = keccak256("beneficiary-v1");
    uint64 internal constant BENEFICIARY_VERSION = 1;

    ProvianPVT9 internal pvt;
    MockPVT9Verifier internal verifier;
    uint64 internal epochStart;
    uint64 internal genesisEnd;
    uint256 internal nonce;

    function setUp() public virtual {
        verifier = new MockPVT9Verifier(ELIGIBILITY_ID, ELIGIBILITY_VERSION, BENEFICIARY_ID, BENEFICIARY_VERSION);
        pvt = _deployAndArm(address(verifier), 1 ether, 100);
        vm.warp(epochStart);
    }

    function _deployAndArm(address eligibilityVerifier, uint256 initialMintRate, uint256 initialCursor)
        internal
        returns (ProvianPVT9 token)
    {
        token = new ProvianPVT9();
        epochStart = uint64(block.timestamp + 1 days);
        genesisEnd = epochStart + uint64(365 days);

        vm.prank(ADMIN);
        token.appointOperationalMinter(MINTER);
        vm.prank(ADMIN);
        token.armEpochZero(
            ProvianPVT9.EpochZeroConfig({
                epochZeroStartsAt: epochStart,
                genesisStartsAt: epochStart,
                genesisEndsAt: genesisEnd,
                initialMintRate: initialMintRate,
                provianTreasury: PROVIAN_TREASURY,
                foundationTreasury: FOUNDATION_TREASURY,
                eligibilityVerifier: ProvianPVT9.VerifierConfig({
                    verifier: eligibilityVerifier, configurationId: ELIGIBILITY_ID, version: ELIGIBILITY_VERSION
                }),
                initialFinalizedCursor: initialCursor,
                combinedCapMode: ProvianPVT9.CombinedCapMode.Automatic,
                genesisCap: 7_500_000 ether,
                fixedCombinedCap: 0
            })
        );
    }

    function _policy(uint64 epoch) internal view returns (ProvianPVT9.EpochPolicy memory) {
        return pvt.getEpochPolicy(epoch);
    }

    function _batchId() internal returns (bytes32) {
        return keccak256(abi.encode("batch", ++nonce));
    }

    function _claimId() internal returns (bytes32) {
        return keccak256(abi.encode("claim", ++nonce));
    }

    function _settleStandard(
        address contributor,
        ProvianPVT9.BeneficiaryClass beneficiaryClass,
        uint256 recordPointsAtomic
    ) internal returns (bytes32 batchId, bytes32 claimId) {
        ProvianPVT9.StandardRecipient[] memory recipients = new ProvianPVT9.StandardRecipient[](1);
        recipients[0] = ProvianPVT9.StandardRecipient({
            contributor: contributor, beneficiaryClass: beneficiaryClass, claimCount: 1
        });
        ProvianPVT9.StandardPEClaim[] memory claims = new ProvianPVT9.StandardPEClaim[](1);
        claimId = _claimId();
        claims[0] = ProvianPVT9.StandardPEClaim({claimId: claimId, recordPointsAtomic: recordPointsAtomic});
        batchId = _batchId();
        uint64 epoch = pvt.currentEpoch();
        bytes32 policyHash = _policy(epoch).policyHash;
        uint256 cursor = pvt.nextFinalizedCursor();
        vm.prank(MINTER);
        pvt.settleStandardPEBatch(batchId, epoch, policyHash, cursor, cursor + 1, recipients, claims);
    }

    function _settleGenesis(
        address contributor,
        bytes32 walletId,
        bytes32 anchor,
        uint8 grantType,
        uint256 reservedGrossAtomic
    ) internal returns (bytes32 batchId, bytes32 claimId) {
        ProvianPVT9.GenesisRecipient[] memory recipients = new ProvianPVT9.GenesisRecipient[](1);
        recipients[0] = ProvianPVT9.GenesisRecipient({contributor: contributor, claimCount: 1});
        ProvianPVT9.GenesisPEClaim[] memory claims = new ProvianPVT9.GenesisPEClaim[](1);
        claimId = _claimId();
        claims[0] = ProvianPVT9.GenesisPEClaim({
            claimId: claimId,
            walletId: walletId,
            oneTimeAnchor: anchor,
            grantType: grantType,
            qualifiedAt: epochStart,
            reservedGrossAtomic: reservedGrossAtomic
        });
        batchId = _batchId();
        uint64 epoch = pvt.currentEpoch();
        bytes32 policyHash = _policy(epoch).policyHash;
        uint256 cursor = pvt.nextFinalizedCursor();
        vm.prank(MINTER);
        pvt.settleGenesisPEBatch(batchId, epoch, policyHash, cursor, cursor + 1, recipients, claims);
    }

    function _expectStandardRevert(
        bytes4 selector,
        address contributor,
        ProvianPVT9.BeneficiaryClass beneficiaryClass,
        uint256 recordPointsAtomic
    ) internal {
        ProvianPVT9.StandardRecipient[] memory recipients = new ProvianPVT9.StandardRecipient[](1);
        recipients[0] = ProvianPVT9.StandardRecipient({
            contributor: contributor, beneficiaryClass: beneficiaryClass, claimCount: 1
        });
        ProvianPVT9.StandardPEClaim[] memory claims = new ProvianPVT9.StandardPEClaim[](1);
        claims[0] = ProvianPVT9.StandardPEClaim({claimId: _claimId(), recordPointsAtomic: recordPointsAtomic});
        uint64 epoch = pvt.currentEpoch();
        bytes32 policyHash = _policy(epoch).policyHash;
        uint256 cursor = pvt.nextFinalizedCursor();
        bytes32 batchId = _batchId();
        vm.prank(MINTER);
        vm.expectRevert(selector);
        pvt.settleStandardPEBatch(batchId, epoch, policyHash, cursor, cursor + 1, recipients, claims);
    }

    function _expectGenesisRevert(
        bytes4 selector,
        address contributor,
        bytes32 walletId,
        bytes32 anchor,
        uint8 grantType,
        uint256 reservedGrossAtomic
    ) internal {
        ProvianPVT9.GenesisRecipient[] memory recipients = new ProvianPVT9.GenesisRecipient[](1);
        recipients[0] = ProvianPVT9.GenesisRecipient({contributor: contributor, claimCount: 1});
        ProvianPVT9.GenesisPEClaim[] memory claims = new ProvianPVT9.GenesisPEClaim[](1);
        claims[0] = ProvianPVT9.GenesisPEClaim({
            claimId: _claimId(),
            walletId: walletId,
            oneTimeAnchor: anchor,
            grantType: grantType,
            qualifiedAt: epochStart,
            reservedGrossAtomic: reservedGrossAtomic
        });
        uint64 epoch = pvt.currentEpoch();
        bytes32 policyHash = _policy(epoch).policyHash;
        uint256 cursor = pvt.nextFinalizedCursor();
        bytes32 batchId = _batchId();
        vm.prank(MINTER);
        vm.expectRevert(selector);
        pvt.settleGenesisPEBatch(batchId, epoch, policyHash, cursor, cursor + 1, recipients, claims);
    }

    function _scheduleDifferentialRate(uint64 effectiveEpoch, uint256 foundationBps) internal {
        vm.startPrank(ADMIN);
        pvt.scheduleBeneficiaryVerifier(
            effectiveEpoch,
            ProvianPVT9.VerifierConfig({
                verifier: address(verifier), configurationId: BENEFICIARY_ID, version: BENEFICIARY_VERSION
            })
        );
        pvt.scheduleAgentFoundationRate(effectiveEpoch, foundationBps);
        vm.stopPrank();
    }

    function _advanceToEpoch(uint64 targetEpoch) internal {
        vm.warp(uint256(epochStart) + uint256(targetEpoch) * pvt.EPOCH_DURATION());
        while (pvt.lastOpenedEpoch() < targetEpoch) pvt.openNextEpoch();
    }
}
