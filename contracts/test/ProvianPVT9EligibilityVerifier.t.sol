// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ProvianPVT9} from "../src/ProvianPVT9.sol";
import {ProvianPVT9EligibilityVerifier} from "../src/ProvianPVT9EligibilityVerifier.sol";
import {IPVT9EligibilityVerifier} from "../src/interfaces/IPVT9Verifiers.sol";

/// @dev A verifier that reverts. The kernel must treat it as a denial, not a pass.
contract RevertingVerifier is IPVT9EligibilityVerifier {
    function verifyStandardBatch(bytes32, bytes32, uint64) external pure returns (bool) {
        revert("eligibility unavailable");
    }

    function verifyGenesisBatch(bytes32, bytes32, uint64) external pure returns (bool) {
        revert("eligibility unavailable");
    }
}

/// @dev Returns fewer than 32 bytes. `result.length != 32` must deny.
contract ShortReturnVerifier {
    fallback() external {
        assembly {
            mstore(0, 1)
            return(0, 4)
        }
    }
}

/// @dev Returns a truthy-but-not-canonical word. Only an exact `1` may pass.
contract NonCanonicalTrueVerifier {
    fallback() external {
        assembly {
            mstore(0, 2)
            return(0, 32)
        }
    }
}

/// @dev Affirms everything, so the KERNEL's own accept/reject behaviour can be observed
/// without the oracle in the loop. Used only by the over-restriction differential.
contract AlwaysTrueVerifier is IPVT9EligibilityVerifier {
    function verifyStandardBatch(bytes32, bytes32, uint64) external pure returns (bool) {
        return true;
    }

    function verifyGenesisBatch(bytes32, bytes32, uint64) external pure returns (bool) {
        return true;
    }
}

/// @dev Kernels whose mirrored constants disagree with the verifier's copies.
contract DivergentRecipientCapKernel {
    uint256 public constant MAX_RECIPIENTS_PER_BATCH = 499;
    uint8 public constant GENESIS_DEVICE_LINK = 2;
}

contract DivergentGrantTypeKernel {
    uint256 public constant MAX_RECIPIENTS_PER_BATCH = 500;
    uint8 public constant GENESIS_DEVICE_LINK = 3;
}

/**
 * @notice WP-EV — the production eligibility verifier as a commitment oracle.
 *
 * These tests prove the property the kernel cannot check for itself: that the verifier
 * affirms ONLY digests it derived from a batch it was given and approved, and denies
 * every alteration of that batch.
 */
contract ProvianPVT9EligibilityVerifierTest is Test {
    ProvianPVT9 internal pvt;
    ProvianPVT9EligibilityVerifier internal verifier;

    /// @dev An independent literal, not a read of either contract's own constant: Solidity
    /// cannot reference a contract-level `constant` as `ProvianPVT9.BOOTSTRAP_ADMIN`, and a
    /// runtime read would make the admin-gated cases pass against any address. Section G
    /// asserts `verifier.BOOTSTRAP_ADMIN() == pvt.BOOTSTRAP_ADMIN()` separately. Move this
    /// deliberately whenever the kernel constant moves.
    address internal constant ADMIN = 0xCa37a15A64213b2ACD1784ae3f8e6Cbd4600D9D3;
    address internal constant MINTER = address(0xBEEF);
    address internal constant APPROVER = address(0xA55E);
    address internal constant OUTSIDER = address(0xBAD1);
    address internal constant PROVIAN_TREASURY = address(0x9111);
    address internal constant FOUNDATION_TREASURY = address(0x9222);
    address internal constant CONTRIBUTOR_A = address(0xC111);
    address internal constant CONTRIBUTOR_B = address(0xC222);
    /// @dev Stands in for CONTRIBUTOR_B in substitution tests; must stay above
    /// CONTRIBUTOR_A so the batch still satisfies the kernel's strict recipient ordering
    /// and the settlement reaches the verifier rather than dying in validation.
    address internal constant SUBSTITUTE = address(0xD333);

    bytes32 internal constant ELIGIBILITY_ID = keccak256("wp-ev.eligibility.v1");
    uint64 internal constant ELIGIBILITY_VERSION = 1;

    uint64 internal epochStart;
    uint64 internal genesisEnd;
    uint256 internal nonce;

    /// Pinned in lockstep with `settlement-batch.test.ts`. See section I.
    bytes32 internal constant VECTOR_STANDARD_CLAIMS_HASH =
        0xd32f6ba25ef8ac5f4b1e598ee7c50b2379ebccd8a16140e4e5cd868d00f31224;
    bytes32 internal constant VECTOR_GENESIS_CLAIMS_HASH =
        0x3043b09a9a61356cc92a7a503c17ab3bbca126c9fc14203db24907c2f3cf9e5a;
    bytes32 internal constant VECTOR_STANDARD_DIGEST =
        0xf52449d4698d5e2b348262aee32250f3591de21d8e6e62043bde07b796b69e93;
    bytes32 internal constant VECTOR_GENESIS_DIGEST =
        0x36cfff46404787bb8126365b71781e86f8cc2c8a05b67ea6b885dc3471cd0f8d;

    struct StdBatch {
        bytes32 batchId;
        uint64 epoch;
        bytes32 policyHash;
        uint256 cursorStart;
        uint256 cursorEnd;
        ProvianPVT9.StandardRecipient[] recipients;
        ProvianPVT9.StandardPEClaim[] claims;
    }

    struct GenBatch {
        bytes32 batchId;
        uint64 epoch;
        bytes32 policyHash;
        uint256 cursorStart;
        uint256 cursorEnd;
        ProvianPVT9.GenesisRecipient[] recipients;
        ProvianPVT9.GenesisPEClaim[] claims;
    }

    function setUp() public {
        pvt = new ProvianPVT9();
        verifier = new ProvianPVT9EligibilityVerifier(pvt, ELIGIBILITY_ID, ELIGIBILITY_VERSION);

        epochStart = uint64(block.timestamp + 1 days);
        genesisEnd = epochStart + uint64(365 days);

        vm.startPrank(ADMIN);
        pvt.appointOperationalMinter(MINTER);
        pvt.armEpochZero(
            ProvianPVT9.EpochZeroConfig({
                epochZeroStartsAt: epochStart,
                genesisStartsAt: epochStart,
                genesisEndsAt: genesisEnd,
                initialMintRate: 1 ether,
                provianTreasury: PROVIAN_TREASURY,
                foundationTreasury: FOUNDATION_TREASURY,
                eligibilityVerifier: ProvianPVT9.VerifierConfig({
                    verifier: address(verifier),
                    configurationId: ELIGIBILITY_ID,
                    version: ELIGIBILITY_VERSION
                }),
                initialFinalizedCursor: 100,
                combinedCapMode: ProvianPVT9.CombinedCapMode.Automatic,
                genesisCap: 7_500_000 ether,
                fixedCombinedCap: 0
            })
        );
        verifier.appointBatchApprover(APPROVER);
        vm.stopPrank();

        vm.warp(epochStart);
    }

    // =====================================================================
    // Fixtures
    // =====================================================================

    function _nextId(string memory tag) internal returns (bytes32) {
        return keccak256(abi.encode(tag, ++nonce));
    }

    /// @dev Two recipients, three claims — enough shape for ordering and range mutations.
    function _standardBatch() internal returns (StdBatch memory b) {
        b.batchId = _nextId("batch");
        b.epoch = pvt.currentEpoch();
        b.policyHash = pvt.getEpochPolicy(b.epoch).policyHash;
        b.cursorStart = pvt.nextFinalizedCursor();
        b.cursorEnd = b.cursorStart + 3;

        b.recipients = new ProvianPVT9.StandardRecipient[](2);
        b.recipients[0] = ProvianPVT9.StandardRecipient({
            contributor: CONTRIBUTOR_A,
            beneficiaryClass: ProvianPVT9.BeneficiaryClass.HumanResolving,
            claimCount: 2
        });
        b.recipients[1] = ProvianPVT9.StandardRecipient({
            contributor: CONTRIBUTOR_B,
            beneficiaryClass: ProvianPVT9.BeneficiaryClass.AutonomousAgent,
            claimCount: 1
        });

        b.claims = new ProvianPVT9.StandardPEClaim[](3);
        b.claims[0] = ProvianPVT9.StandardPEClaim({claimId: _nextId("claim"), recordPointsAtomic: 10 ether});
        b.claims[1] = ProvianPVT9.StandardPEClaim({claimId: _nextId("claim"), recordPointsAtomic: 5 ether});
        b.claims[2] = ProvianPVT9.StandardPEClaim({claimId: _nextId("claim"), recordPointsAtomic: 7 ether});
    }

    function _genesisBatch() internal returns (GenBatch memory b) {
        b.batchId = _nextId("batch");
        b.epoch = pvt.currentEpoch();
        b.policyHash = pvt.getEpochPolicy(b.epoch).policyHash;
        b.cursorStart = pvt.nextFinalizedCursor();
        b.cursorEnd = b.cursorStart + 2;

        b.recipients = new ProvianPVT9.GenesisRecipient[](2);
        b.recipients[0] = ProvianPVT9.GenesisRecipient({contributor: CONTRIBUTOR_A, claimCount: 1});
        b.recipients[1] = ProvianPVT9.GenesisRecipient({contributor: CONTRIBUTOR_B, claimCount: 1});

        b.claims = new ProvianPVT9.GenesisPEClaim[](2);
        b.claims[0] = ProvianPVT9.GenesisPEClaim({
            claimId: _nextId("claim"),
            walletId: _nextId("wallet"),
            oneTimeAnchor: _nextId("anchor"),
            grantType: pvt.GENESIS_HUMAN_SIGNUP(),
            qualifiedAt: epochStart,
            reservedGrossAtomic: pvt.GENESIS_HUMAN_SIGNUP_GROSS()
        });
        b.claims[1] = ProvianPVT9.GenesisPEClaim({
            claimId: _nextId("claim"),
            walletId: _nextId("wallet"),
            oneTimeAnchor: _nextId("anchor"),
            grantType: pvt.GENESIS_DEVICE_LINK(),
            qualifiedAt: epochStart,
            reservedGrossAtomic: pvt.GENESIS_DEVICE_LINK_GROSS()
        });
    }

    /**
     * @dev Deep copy. Element-wise assignment between memory arrays copies the struct
     * POINTER, not the struct, so `out.x[i] = src.x[i]` still aliases — every "alter one
     * field" test would then mutate the approved batch as well and compare a digest to
     * itself. Each element is therefore rebuilt field by field.
     */
    function _clone(StdBatch memory src) internal pure returns (StdBatch memory out) {
        out.batchId = src.batchId;
        out.epoch = src.epoch;
        out.policyHash = src.policyHash;
        out.cursorStart = src.cursorStart;
        out.cursorEnd = src.cursorEnd;
        out.recipients = new ProvianPVT9.StandardRecipient[](src.recipients.length);
        for (uint256 i = 0; i < src.recipients.length; ++i) {
            out.recipients[i] = ProvianPVT9.StandardRecipient({
                contributor: src.recipients[i].contributor,
                beneficiaryClass: src.recipients[i].beneficiaryClass,
                claimCount: src.recipients[i].claimCount
            });
        }
        out.claims = new ProvianPVT9.StandardPEClaim[](src.claims.length);
        for (uint256 i = 0; i < src.claims.length; ++i) {
            out.claims[i] = ProvianPVT9.StandardPEClaim({
                claimId: src.claims[i].claimId,
                recordPointsAtomic: src.claims[i].recordPointsAtomic
            });
        }
    }

    function _clone(GenBatch memory src) internal pure returns (GenBatch memory out) {
        out.batchId = src.batchId;
        out.epoch = src.epoch;
        out.policyHash = src.policyHash;
        out.cursorStart = src.cursorStart;
        out.cursorEnd = src.cursorEnd;
        out.recipients = new ProvianPVT9.GenesisRecipient[](src.recipients.length);
        for (uint256 i = 0; i < src.recipients.length; ++i) {
            out.recipients[i] = ProvianPVT9.GenesisRecipient({
                contributor: src.recipients[i].contributor,
                claimCount: src.recipients[i].claimCount
            });
        }
        out.claims = new ProvianPVT9.GenesisPEClaim[](src.claims.length);
        for (uint256 i = 0; i < src.claims.length; ++i) {
            out.claims[i] = ProvianPVT9.GenesisPEClaim({
                claimId: src.claims[i].claimId,
                walletId: src.claims[i].walletId,
                oneTimeAnchor: src.claims[i].oneTimeAnchor,
                grantType: src.claims[i].grantType,
                qualifiedAt: src.claims[i].qualifiedAt,
                reservedGrossAtomic: src.claims[i].reservedGrossAtomic
            });
        }
    }

    /// @dev The digest the KERNEL would build for this batch, from the kernel's own code.
    function _kernelDigest(StdBatch memory b) internal view returns (bytes32) {
        return pvt.computeSettlementDigest(
            ProvianPVT9.SettlementLane.StandardPE,
            b.batchId,
            b.epoch,
            b.policyHash,
            b.cursorStart,
            b.cursorEnd,
            pvt.hashStandardClaims(b.recipients, b.claims)
        );
    }

    function _kernelDigest(GenBatch memory b) internal view returns (bytes32) {
        return pvt.computeSettlementDigest(
            ProvianPVT9.SettlementLane.GenesisPE,
            b.batchId,
            b.epoch,
            b.policyHash,
            b.cursorStart,
            b.cursorEnd,
            pvt.hashGenesisClaims(b.recipients, b.claims)
        );
    }

    function _approve(StdBatch memory b) internal returns (bytes32) {
        vm.prank(APPROVER);
        return verifier.approveStandardBatch(
            b.batchId, b.epoch, b.policyHash, b.cursorStart, b.cursorEnd, b.recipients, b.claims
        );
    }

    function _approve(GenBatch memory b) internal returns (bytes32) {
        vm.prank(APPROVER);
        return verifier.approveGenesisBatch(
            b.batchId, b.epoch, b.policyHash, b.cursorStart, b.cursorEnd, b.recipients, b.claims
        );
    }

    function _settle(StdBatch memory b) internal {
        vm.prank(MINTER);
        pvt.settleStandardPEBatch(
            b.batchId, b.epoch, b.policyHash, b.cursorStart, b.cursorEnd, b.recipients, b.claims
        );
    }

    function _settle(GenBatch memory b) internal {
        vm.prank(MINTER);
        pvt.settleGenesisPEBatch(
            b.batchId, b.epoch, b.policyHash, b.cursorStart, b.cursorEnd, b.recipients, b.claims
        );
    }

    function _verifyStandard(bytes32 digest) internal view returns (bool) {
        return verifier.verifyStandardBatch(digest, ELIGIBILITY_ID, ELIGIBILITY_VERSION);
    }

    function _verifyGenesis(bytes32 digest) internal view returns (bool) {
        return verifier.verifyGenesisBatch(digest, ELIGIBILITY_ID, ELIGIBILITY_VERSION);
    }

    /// @dev Assert an altered batch is denied: the oracle never derived ITS digest.
    function _assertAlterationDenied(StdBatch memory altered, StdBatch memory approved) internal view {
        bytes32 alteredDigest = _kernelDigest(altered);
        assertTrue(alteredDigest != _kernelDigest(approved), "mutation did not change the digest");
        assertFalse(_verifyStandard(alteredDigest), "altered batch was affirmed");
    }

    // =====================================================================
    // A. The approved batch's real digest verifies
    // =====================================================================

    function test_approvedStandardBatch_realDigest_verifiesTrue() public {
        StdBatch memory b = _standardBatch();
        bytes32 derived = _approve(b);

        assertEq(derived, _kernelDigest(b), "oracle digest differs from the kernel's");
        assertTrue(_verifyStandard(derived));
    }

    function test_approvedGenesisBatch_realDigest_verifiesTrue() public {
        GenBatch memory b = _genesisBatch();
        bytes32 derived = _approve(b);

        assertEq(derived, _kernelDigest(b), "oracle digest differs from the kernel's");
        assertTrue(_verifyGenesis(derived));
    }

    function test_approvalRecordsLaneAndIsIntrospectable() public {
        StdBatch memory b = _standardBatch();
        bytes32 digest = _approve(b);

        (bool approved, ProvianPVT9.SettlementLane lane) = verifier.batchApproval(digest);
        assertTrue(approved);
        assertEq(uint8(lane), uint8(ProvianPVT9.SettlementLane.StandardPE));
    }

    // =====================================================================
    // B. Any alteration of the approved batch is denied
    // =====================================================================

    function test_alteredClaimAmount_isDenied() public {
        StdBatch memory b = _standardBatch();
        _approve(b);

        StdBatch memory altered = _clone(b);
        altered.claims[1].recordPointsAtomic = 5 ether + 1;
        _assertAlterationDenied(altered, b);
    }

    function test_alteredClaimId_isDenied() public {
        StdBatch memory b = _standardBatch();
        _approve(b);

        StdBatch memory altered = _clone(b);
        altered.claims[0].claimId = _nextId("swapped-claim");
        _assertAlterationDenied(altered, b);
    }

    function test_alteredRecipientAddress_isDenied() public {
        StdBatch memory b = _standardBatch();
        _approve(b);

        StdBatch memory altered = _clone(b);
        altered.recipients[1].contributor = SUBSTITUTE;
        _assertAlterationDenied(altered, b);
    }

    function test_alteredBeneficiaryClass_isDenied() public {
        StdBatch memory b = _standardBatch();
        _approve(b);

        StdBatch memory altered = _clone(b);
        altered.recipients[0].beneficiaryClass = ProvianPVT9.BeneficiaryClass.AutonomousAgent;
        _assertAlterationDenied(altered, b);
    }

    function test_reorderedClaims_isDenied() public {
        StdBatch memory b = _standardBatch();
        _approve(b);

        StdBatch memory altered = _clone(b);
        (altered.claims[0], altered.claims[1]) = (altered.claims[1], altered.claims[0]);
        _assertAlterationDenied(altered, b);
    }

    function test_reassignedClaimCounts_isDenied() public {
        StdBatch memory b = _standardBatch();
        _approve(b);

        // Same claims, same recipients, but the split between them moves — recipient A
        // would be paid for one claim instead of two.
        StdBatch memory altered = _clone(b);
        altered.recipients[0].claimCount = 1;
        altered.recipients[1].claimCount = 2;
        _assertAlterationDenied(altered, b);
    }

    function test_alteredEpoch_isDenied() public {
        StdBatch memory b = _standardBatch();
        _approve(b);

        StdBatch memory altered = _clone(b);
        altered.epoch = b.epoch + 1;
        _assertAlterationDenied(altered, b);
    }

    function test_alteredBatchId_isDenied() public {
        StdBatch memory b = _standardBatch();
        _approve(b);

        StdBatch memory altered = _clone(b);
        altered.batchId = _nextId("other-batch");
        _assertAlterationDenied(altered, b);
    }

    function test_alteredPolicyHash_isDenied() public {
        StdBatch memory b = _standardBatch();
        _approve(b);

        StdBatch memory altered = _clone(b);
        altered.policyHash = keccak256("some-other-policy");
        _assertAlterationDenied(altered, b);
    }

    function test_alteredCursorRange_isDenied() public {
        StdBatch memory b = _standardBatch();
        _approve(b);

        StdBatch memory altered = _clone(b);
        altered.cursorStart = b.cursorStart + 1;
        altered.cursorEnd = b.cursorEnd + 1;
        _assertAlterationDenied(altered, b);
    }

    function test_appendedClaim_isDenied() public {
        StdBatch memory b = _standardBatch();
        _approve(b);

        StdBatch memory altered = _clone(b);
        ProvianPVT9.StandardPEClaim[] memory grown = new ProvianPVT9.StandardPEClaim[](4);
        for (uint256 i = 0; i < 3; ++i) grown[i] = altered.claims[i];
        grown[3] = ProvianPVT9.StandardPEClaim({claimId: _nextId("smuggled"), recordPointsAtomic: 1_000 ether});
        altered.claims = grown;
        altered.recipients[1].claimCount = 2;
        altered.cursorEnd = altered.cursorStart + 4;
        _assertAlterationDenied(altered, b);
    }

    function test_droppedClaim_isDenied() public {
        StdBatch memory b = _standardBatch();
        _approve(b);

        StdBatch memory altered = _clone(b);
        ProvianPVT9.StandardPEClaim[] memory shrunk = new ProvianPVT9.StandardPEClaim[](2);
        shrunk[0] = altered.claims[0];
        shrunk[1] = altered.claims[1];
        altered.claims = shrunk;
        altered.recipients[1].claimCount = 0;
        altered.cursorEnd = altered.cursorStart + 2;
        // A zero claimCount is itself invalid, so drop the empty recipient entirely.
        ProvianPVT9.StandardRecipient[] memory one = new ProvianPVT9.StandardRecipient[](1);
        one[0] = altered.recipients[0];
        altered.recipients = one;
        _assertAlterationDenied(altered, b);
    }

    function test_alteredGenesisGrantAmount_isDenied() public {
        GenBatch memory b = _genesisBatch();
        _approve(b);

        GenBatch memory altered = _clone(b);
        altered.claims[1].reservedGrossAtomic = pvt.GENESIS_DEVICE_LINK_GROSS() - 1;
        bytes32 alteredDigest = _kernelDigest(altered);
        assertTrue(alteredDigest != _kernelDigest(b), "mutation did not change the digest");
        assertFalse(_verifyGenesis(alteredDigest));
    }

    function test_alteredGenesisAnchor_isDenied() public {
        GenBatch memory b = _genesisBatch();
        _approve(b);

        GenBatch memory altered = _clone(b);
        altered.claims[0].oneTimeAnchor = _nextId("reused-anchor");
        bytes32 alteredDigest = _kernelDigest(altered);
        assertTrue(alteredDigest != _kernelDigest(b), "mutation did not change the digest");
        assertFalse(_verifyGenesis(alteredDigest));
    }

    // =====================================================================
    // C. Lane, configuration, and unknown-digest denial
    // =====================================================================

    function test_standardApproval_doesNotSatisfyGenesisLane() public {
        StdBatch memory b = _standardBatch();
        bytes32 digest = _approve(b);

        assertTrue(_verifyStandard(digest));
        assertFalse(_verifyGenesis(digest), "standard approval crossed into the genesis lane");
    }

    function test_genesisApproval_doesNotSatisfyStandardLane() public {
        GenBatch memory b = _genesisBatch();
        bytes32 digest = _approve(b);

        assertTrue(_verifyGenesis(digest));
        assertFalse(_verifyStandard(digest), "genesis approval crossed into the standard lane");
    }

    function test_neverApprovedDigest_isDenied() public {
        StdBatch memory b = _standardBatch();
        // Deliberately NOT approved.
        assertFalse(_verifyStandard(_kernelDigest(b)));
    }

    function test_arbitraryDigest_isDenied() public view {
        assertFalse(_verifyStandard(keccak256("anything at all")));
        assertFalse(_verifyGenesis(keccak256("anything at all")));
    }

    function test_zeroDigest_isDenied() public view {
        assertFalse(_verifyStandard(bytes32(0)));
        assertFalse(_verifyGenesis(bytes32(0)));
    }

    function test_wrongConfigurationId_isDenied() public {
        StdBatch memory b = _standardBatch();
        bytes32 digest = _approve(b);

        assertFalse(verifier.verifyStandardBatch(digest, keccak256("other-config"), ELIGIBILITY_VERSION));
        assertFalse(verifier.verifyStandardBatch(digest, bytes32(0), ELIGIBILITY_VERSION));
    }

    function test_wrongConfigurationVersion_isDenied() public {
        StdBatch memory b = _standardBatch();
        bytes32 digest = _approve(b);

        assertFalse(verifier.verifyStandardBatch(digest, ELIGIBILITY_ID, ELIGIBILITY_VERSION + 1));
        assertFalse(verifier.verifyStandardBatch(digest, ELIGIBILITY_ID, 0));
    }

    function test_revokedApproval_isDenied() public {
        StdBatch memory b = _standardBatch();
        bytes32 digest = _approve(b);
        assertTrue(_verifyStandard(digest));

        vm.prank(APPROVER);
        verifier.revokeBatchApproval(digest, ProvianPVT9.SettlementLane.StandardPE);
        assertFalse(_verifyStandard(digest));
    }

    function test_administrativeHold_deniesEveryVerification() public {
        StdBatch memory b = _standardBatch();
        bytes32 digest = _approve(b);
        assertTrue(_verifyStandard(digest));

        vm.prank(ADMIN);
        verifier.placeAdministrativeHold();
        assertFalse(_verifyStandard(digest), "hold did not deny");

        vm.prank(ADMIN);
        verifier.resumeFromAdministrativeHold();
        assertTrue(_verifyStandard(digest), "resume did not restore the approval");
    }

    function test_offDeploymentChain_isDenied() public {
        StdBatch memory b = _standardBatch();
        bytes32 digest = _approve(b);
        assertTrue(_verifyStandard(digest));

        vm.chainId(block.chainid + 1);
        assertFalse(_verifyStandard(digest), "approval survived a chain change");
    }

    // =====================================================================
    // D. Authority is fail-closed
    // =====================================================================

    function test_onlyApproverMayApprove() public {
        StdBatch memory b = _standardBatch();
        vm.prank(OUTSIDER);
        vm.expectRevert(ProvianPVT9EligibilityVerifier.OnlyBatchApprover.selector);
        verifier.approveStandardBatch(
            b.batchId, b.epoch, b.policyHash, b.cursorStart, b.cursorEnd, b.recipients, b.claims
        );
    }

    function test_adminIsNotImplicitlyAnApprover() public {
        StdBatch memory b = _standardBatch();
        vm.prank(ADMIN);
        vm.expectRevert(ProvianPVT9EligibilityVerifier.OnlyBatchApprover.selector);
        verifier.approveStandardBatch(
            b.batchId, b.epoch, b.policyHash, b.cursorStart, b.cursorEnd, b.recipients, b.claims
        );
    }

    function test_revokedApprover_cannotApprove() public {
        vm.prank(ADMIN);
        verifier.revokeBatchApprover();

        StdBatch memory b = _standardBatch();
        vm.prank(APPROVER);
        vm.expectRevert(ProvianPVT9EligibilityVerifier.ApproverUnconfigured.selector);
        verifier.approveStandardBatch(
            b.batchId, b.epoch, b.policyHash, b.cursorStart, b.cursorEnd, b.recipients, b.claims
        );
    }

    function test_onlyAdminMayAppointApproverOrHold() public {
        vm.startPrank(OUTSIDER);
        vm.expectRevert(ProvianPVT9EligibilityVerifier.OnlyBootstrapAdmin.selector);
        verifier.appointBatchApprover(OUTSIDER);
        vm.expectRevert(ProvianPVT9EligibilityVerifier.OnlyBootstrapAdmin.selector);
        verifier.revokeBatchApprover();
        vm.expectRevert(ProvianPVT9EligibilityVerifier.OnlyBootstrapAdmin.selector);
        verifier.placeAdministrativeHold();
        vm.expectRevert(ProvianPVT9EligibilityVerifier.OnlyBootstrapAdmin.selector);
        verifier.resumeFromAdministrativeHold();
        vm.stopPrank();
    }

    function test_approverCannotAppointItself() public {
        vm.prank(APPROVER);
        vm.expectRevert(ProvianPVT9EligibilityVerifier.OnlyBootstrapAdmin.selector);
        verifier.appointBatchApprover(OUTSIDER);
    }

    function test_approvalIsRefusedWhileHeld() public {
        vm.prank(ADMIN);
        verifier.placeAdministrativeHold();

        StdBatch memory b = _standardBatch();
        vm.prank(APPROVER);
        vm.expectRevert(ProvianPVT9EligibilityVerifier.Held.selector);
        verifier.approveStandardBatch(
            b.batchId, b.epoch, b.policyHash, b.cursorStart, b.cursorEnd, b.recipients, b.claims
        );
    }

    function test_doubleApprovalIsRefused() public {
        StdBatch memory b = _standardBatch();
        _approve(b);

        vm.prank(APPROVER);
        vm.expectRevert(ProvianPVT9EligibilityVerifier.BatchAlreadyApproved.selector);
        verifier.approveStandardBatch(
            b.batchId, b.epoch, b.policyHash, b.cursorStart, b.cursorEnd, b.recipients, b.claims
        );
    }

    function test_revokeRequiresTheRecordedLane() public {
        StdBatch memory b = _standardBatch();
        bytes32 digest = _approve(b);

        vm.prank(APPROVER);
        vm.expectRevert(ProvianPVT9EligibilityVerifier.LaneMismatch.selector);
        verifier.revokeBatchApproval(digest, ProvianPVT9.SettlementLane.GenesisPE);

        assertTrue(_verifyStandard(digest), "a mismatched revoke cleared the approval anyway");
    }

    function test_revokedBatchCanBeApprovedAgainAndKeepsItsLane() public {
        StdBatch memory b = _standardBatch();
        bytes32 digest = _approve(b);

        vm.prank(APPROVER);
        verifier.revokeBatchApproval(digest, ProvianPVT9.SettlementLane.StandardPE);
        assertFalse(_verifyStandard(digest));

        // A revocation made in error must be recoverable, and the lane recorded alongside
        // the stale `approved = false` must not be able to come back as the other one.
        assertEq(_approve(b), digest);
        assertTrue(_verifyStandard(digest));
        assertFalse(_verifyGenesis(digest));

        (, ProvianPVT9.SettlementLane lane) = verifier.batchApproval(digest);
        assertEq(uint8(lane), uint8(ProvianPVT9.SettlementLane.StandardPE));
    }

    function test_revokingOneBatchLeavesOthersApproved() public {
        StdBatch memory first = _standardBatch();
        bytes32 firstDigest = _approve(first);
        StdBatch memory second = _standardBatch();
        bytes32 secondDigest = _approve(second);
        assertTrue(firstDigest != secondDigest);

        vm.prank(APPROVER);
        verifier.revokeBatchApproval(firstDigest, ProvianPVT9.SettlementLane.StandardPE);

        assertFalse(_verifyStandard(firstDigest));
        assertTrue(_verifyStandard(secondDigest), "revoking one batch cleared another");
    }

    function test_revokeOfUnknownDigestIsRefused() public {
        vm.prank(APPROVER);
        vm.expectRevert(ProvianPVT9EligibilityVerifier.BatchNotApproved.selector);
        verifier.revokeBatchApproval(keccak256("never approved"), ProvianPVT9.SettlementLane.StandardPE);
    }

    function test_onlyApproverMayRevoke() public {
        StdBatch memory b = _standardBatch();
        bytes32 digest = _approve(b);

        vm.prank(OUTSIDER);
        vm.expectRevert(ProvianPVT9EligibilityVerifier.OnlyBatchApprover.selector);
        verifier.revokeBatchApproval(digest, ProvianPVT9.SettlementLane.StandardPE);
    }

    function test_approvalIsRefusedOffTheDeploymentChain() public {
        StdBatch memory b = _standardBatch();
        vm.chainId(block.chainid + 1);

        vm.prank(APPROVER);
        vm.expectRevert(ProvianPVT9EligibilityVerifier.ChainMismatch.selector);
        verifier.approveStandardBatch(
            b.batchId, b.epoch, b.policyHash, b.cursorStart, b.cursorEnd, b.recipients, b.claims
        );
    }

    // =====================================================================
    // E. Construction is fail-closed
    // =====================================================================

    function test_constructorRejectsUnusableConfiguration() public {
        vm.expectRevert(ProvianPVT9EligibilityVerifier.InvalidConfiguration.selector);
        new ProvianPVT9EligibilityVerifier(ProvianPVT9(address(0)), ELIGIBILITY_ID, ELIGIBILITY_VERSION);

        // A kernel with no code — the kernel's own `_requireConfiguredVerifier` mirror.
        vm.expectRevert(ProvianPVT9EligibilityVerifier.InvalidConfiguration.selector);
        new ProvianPVT9EligibilityVerifier(ProvianPVT9(address(0xDEAD)), ELIGIBILITY_ID, ELIGIBILITY_VERSION);

        vm.expectRevert(ProvianPVT9EligibilityVerifier.InvalidConfiguration.selector);
        new ProvianPVT9EligibilityVerifier(pvt, bytes32(0), ELIGIBILITY_VERSION);

        vm.expectRevert(ProvianPVT9EligibilityVerifier.InvalidConfiguration.selector);
        new ProvianPVT9EligibilityVerifier(pvt, ELIGIBILITY_ID, 0);
    }

    function test_deploymentIsSchedulableByTheKernel() public view {
        // Exactly the conditions `ProvianPVT9._requireConfiguredVerifier` enforces.
        assertTrue(address(verifier) != address(0));
        assertTrue(address(verifier).code.length > 0);
        assertTrue(verifier.CONFIGURATION_ID() != bytes32(0));
        assertTrue(verifier.CONFIGURATION_VERSION() != 0);
    }

    function test_adminMatchesTheKernelsBootstrapAdmin() public view {
        assertEq(verifier.BOOTSTRAP_ADMIN(), pvt.BOOTSTRAP_ADMIN());
    }

    /// The off-chain assembler mirrors this constant to decide whether a resolved
    /// beneficiary classification is required (`settlement-batch.ts::HUMAN_FOUNDATION_BPS`,
    /// asserted equal to 50 there). Pin the kernel side too, so a change fails on both.
    function test_humanFoundationFloorIsTheValueTheAssemblerMirrors() public view {
        assertEq(pvt.HUMAN_FOUNDATION_BPS(), 50);
    }

    /// The kernel requires STRICTLY ascending recipients, so two equal addresses must be
    /// refused. Without this the oracle's `<=` could relax to `<` unnoticed.
    function test_approvalRefusesTwoRecipientsAtTheSameAddress() public {
        StdBatch memory b = _standardBatch();
        b.recipients[1].contributor = b.recipients[0].contributor;

        vm.prank(APPROVER);
        vm.expectRevert(ProvianPVT9EligibilityVerifier.RecipientsNotStrictlyOrdered.selector);
        verifier.approveStandardBatch(
            b.batchId, b.epoch, b.policyHash, b.cursorStart, b.cursorEnd, b.recipients, b.claims
        );

        GenBatch memory g = _genesisBatch();
        g.recipients[1].contributor = g.recipients[0].contributor;
        vm.prank(APPROVER);
        vm.expectRevert(ProvianPVT9EligibilityVerifier.RecipientsNotStrictlyOrdered.selector);
        verifier.approveGenesisBatch(
            g.batchId, g.epoch, g.policyHash, g.cursorStart, g.cursorEnd, g.recipients, g.claims
        );
    }

    // =====================================================================
    // F. Batch shape is refused at approval, never silently committed
    // =====================================================================

    function test_approvalRefusesUnorderedRecipients() public {
        StdBatch memory b = _standardBatch();
        (b.recipients[0], b.recipients[1]) = (b.recipients[1], b.recipients[0]);
        b.recipients[0].claimCount = 2;
        b.recipients[1].claimCount = 1;

        vm.prank(APPROVER);
        vm.expectRevert(ProvianPVT9EligibilityVerifier.RecipientsNotStrictlyOrdered.selector);
        verifier.approveStandardBatch(
            b.batchId, b.epoch, b.policyHash, b.cursorStart, b.cursorEnd, b.recipients, b.claims
        );
    }

    function test_approvalRefusesClaimCountMismatch() public {
        StdBatch memory b = _standardBatch();
        b.recipients[1].claimCount = 2; // sums to 4, but there are 3 claims

        vm.prank(APPROVER);
        vm.expectRevert(ProvianPVT9EligibilityVerifier.ClaimRangeMismatch.selector);
        verifier.approveStandardBatch(
            b.batchId, b.epoch, b.policyHash, b.cursorStart, b.cursorEnd, b.recipients, b.claims
        );
    }

    function test_approvalRefusesCursorRangeMismatch() public {
        StdBatch memory b = _standardBatch();
        b.cursorEnd = b.cursorStart + 2; // 3 claims, 2 cursor slots

        vm.prank(APPROVER);
        vm.expectRevert(ProvianPVT9EligibilityVerifier.ClaimRangeMismatch.selector);
        verifier.approveStandardBatch(
            b.batchId, b.epoch, b.policyHash, b.cursorStart, b.cursorEnd, b.recipients, b.claims
        );
    }

    function test_approvalRefusesInvertedCursorRange() public {
        StdBatch memory b = _standardBatch();
        b.cursorEnd = b.cursorStart;

        vm.prank(APPROVER);
        vm.expectRevert(ProvianPVT9EligibilityVerifier.InvalidCursorRange.selector);
        verifier.approveStandardBatch(
            b.batchId, b.epoch, b.policyHash, b.cursorStart, b.cursorEnd, b.recipients, b.claims
        );
    }

    function test_approvalRefusesZeroClaimIdOrZeroPoints() public {
        StdBatch memory b = _standardBatch();
        StdBatch memory zeroId = _clone(b);
        zeroId.claims[2].claimId = bytes32(0);

        vm.prank(APPROVER);
        vm.expectRevert(ProvianPVT9EligibilityVerifier.InvalidClaim.selector);
        verifier.approveStandardBatch(
            zeroId.batchId,
            zeroId.epoch,
            zeroId.policyHash,
            zeroId.cursorStart,
            zeroId.cursorEnd,
            zeroId.recipients,
            zeroId.claims
        );

        StdBatch memory zeroPoints = _clone(b);
        zeroPoints.claims[2].recordPointsAtomic = 0;
        vm.prank(APPROVER);
        vm.expectRevert(ProvianPVT9EligibilityVerifier.InvalidClaim.selector);
        verifier.approveStandardBatch(
            zeroPoints.batchId,
            zeroPoints.epoch,
            zeroPoints.policyHash,
            zeroPoints.cursorStart,
            zeroPoints.cursorEnd,
            zeroPoints.recipients,
            zeroPoints.claims
        );
    }

    function test_approvalRefusesZeroBatchIdOrZeroPolicyHash() public {
        StdBatch memory b = _standardBatch();

        vm.prank(APPROVER);
        vm.expectRevert(ProvianPVT9EligibilityVerifier.InvalidIdentifier.selector);
        verifier.approveStandardBatch(
            bytes32(0), b.epoch, b.policyHash, b.cursorStart, b.cursorEnd, b.recipients, b.claims
        );

        vm.prank(APPROVER);
        vm.expectRevert(ProvianPVT9EligibilityVerifier.InvalidIdentifier.selector);
        verifier.approveStandardBatch(
            b.batchId, b.epoch, bytes32(0), b.cursorStart, b.cursorEnd, b.recipients, b.claims
        );
    }

    function test_approvalRefusesEmptyBatch() public {
        StdBatch memory b = _standardBatch();
        ProvianPVT9.StandardRecipient[] memory noRecipients = new ProvianPVT9.StandardRecipient[](0);

        vm.prank(APPROVER);
        vm.expectRevert(ProvianPVT9EligibilityVerifier.EmptyBatch.selector);
        verifier.approveStandardBatch(
            b.batchId, b.epoch, b.policyHash, b.cursorStart, b.cursorEnd, noRecipients, b.claims
        );

        ProvianPVT9.StandardPEClaim[] memory noClaims = new ProvianPVT9.StandardPEClaim[](0);
        vm.prank(APPROVER);
        vm.expectRevert(ProvianPVT9EligibilityVerifier.EmptyBatch.selector);
        verifier.approveStandardBatch(
            b.batchId, b.epoch, b.policyHash, b.cursorStart, b.cursorStart, b.recipients, noClaims
        );
    }

    function test_approvalRefusesTooManyRecipients() public {
        uint256 count = pvt.MAX_RECIPIENTS_PER_BATCH() + 1;
        StdBatch memory b = _standardBatch();
        ProvianPVT9.StandardRecipient[] memory many = new ProvianPVT9.StandardRecipient[](count);
        ProvianPVT9.StandardPEClaim[] memory claims = new ProvianPVT9.StandardPEClaim[](count);
        for (uint256 i = 0; i < count; ++i) {
            many[i] = ProvianPVT9.StandardRecipient({
                contributor: address(uint160(0x10000 + i)),
                beneficiaryClass: ProvianPVT9.BeneficiaryClass.HumanResolving,
                claimCount: 1
            });
            claims[i] = ProvianPVT9.StandardPEClaim({claimId: _nextId("bulk"), recordPointsAtomic: 1 ether});
        }

        vm.prank(APPROVER);
        vm.expectRevert(ProvianPVT9EligibilityVerifier.TooManyRecipients.selector);
        verifier.approveStandardBatch(
            b.batchId, b.epoch, b.policyHash, b.cursorStart, b.cursorStart + count, many, claims
        );
    }

    function test_approvalRefusesGenesisUnorderedRecipients() public {
        GenBatch memory b = _genesisBatch();
        (b.recipients[0], b.recipients[1]) = (b.recipients[1], b.recipients[0]);

        vm.prank(APPROVER);
        vm.expectRevert(ProvianPVT9EligibilityVerifier.RecipientsNotStrictlyOrdered.selector);
        verifier.approveGenesisBatch(
            b.batchId, b.epoch, b.policyHash, b.cursorStart, b.cursorEnd, b.recipients, b.claims
        );
    }

    function test_approvalRefusesGenesisClaimCountMismatch() public {
        GenBatch memory b = _genesisBatch();
        b.recipients[1].claimCount = 2; // sums to 3 against 2 claims

        vm.prank(APPROVER);
        vm.expectRevert(ProvianPVT9EligibilityVerifier.ClaimRangeMismatch.selector);
        verifier.approveGenesisBatch(
            b.batchId, b.epoch, b.policyHash, b.cursorStart, b.cursorEnd, b.recipients, b.claims
        );
    }

    function test_approvalRefusesGenesisZeroClaimCount() public {
        GenBatch memory b = _genesisBatch();
        b.recipients[0].claimCount = 0;

        vm.prank(APPROVER);
        vm.expectRevert(ProvianPVT9EligibilityVerifier.ClaimRangeMismatch.selector);
        verifier.approveGenesisBatch(
            b.batchId, b.epoch, b.policyHash, b.cursorStart, b.cursorEnd, b.recipients, b.claims
        );
    }

    function test_approvalRefusesGenesisZeroClaimIdOrAnchor() public {
        GenBatch memory zeroClaim = _genesisBatch();
        zeroClaim.claims[0].claimId = bytes32(0);
        vm.prank(APPROVER);
        vm.expectRevert(ProvianPVT9EligibilityVerifier.InvalidClaim.selector);
        verifier.approveGenesisBatch(
            zeroClaim.batchId,
            zeroClaim.epoch,
            zeroClaim.policyHash,
            zeroClaim.cursorStart,
            zeroClaim.cursorEnd,
            zeroClaim.recipients,
            zeroClaim.claims
        );

        GenBatch memory zeroAnchor = _genesisBatch();
        zeroAnchor.claims[1].oneTimeAnchor = bytes32(0);
        vm.prank(APPROVER);
        vm.expectRevert(ProvianPVT9EligibilityVerifier.InvalidClaim.selector);
        verifier.approveGenesisBatch(
            zeroAnchor.batchId,
            zeroAnchor.epoch,
            zeroAnchor.policyHash,
            zeroAnchor.cursorStart,
            zeroAnchor.cursorEnd,
            zeroAnchor.recipients,
            zeroAnchor.claims
        );
    }

    function test_approvalRefusesGenesisZeroWalletIdOrZeroGrant() public {
        GenBatch memory zeroWallet = _genesisBatch();
        zeroWallet.claims[0].walletId = bytes32(0);
        vm.prank(APPROVER);
        vm.expectRevert(ProvianPVT9EligibilityVerifier.InvalidClaim.selector);
        verifier.approveGenesisBatch(
            zeroWallet.batchId,
            zeroWallet.epoch,
            zeroWallet.policyHash,
            zeroWallet.cursorStart,
            zeroWallet.cursorEnd,
            zeroWallet.recipients,
            zeroWallet.claims
        );

        GenBatch memory zeroGrant = _genesisBatch();
        zeroGrant.claims[1].reservedGrossAtomic = 0;
        vm.prank(APPROVER);
        vm.expectRevert(ProvianPVT9EligibilityVerifier.InvalidClaim.selector);
        verifier.approveGenesisBatch(
            zeroGrant.batchId,
            zeroGrant.epoch,
            zeroGrant.policyHash,
            zeroGrant.cursorStart,
            zeroGrant.cursorEnd,
            zeroGrant.recipients,
            zeroGrant.claims
        );
    }

    function test_constructorPinsTheKernelConstantsItMirrors() public {
        // The mirrored constants are only safe because they are checked against the live
        // kernel at construction. A kernel that disagrees must be undeployable-against.
        // Both stubs are deployed BEFORE `expectRevert`, or the cheatcode would attach to
        // the stub's own construction instead of the verifier's.
        ProvianPVT9 divergentCap = ProvianPVT9(address(new DivergentRecipientCapKernel()));
        ProvianPVT9 divergentGrant = ProvianPVT9(address(new DivergentGrantTypeKernel()));

        vm.expectRevert(ProvianPVT9EligibilityVerifier.KernelDerivationMismatch.selector);
        new ProvianPVT9EligibilityVerifier(divergentCap, ELIGIBILITY_ID, ELIGIBILITY_VERSION);

        vm.expectRevert(ProvianPVT9EligibilityVerifier.KernelDerivationMismatch.selector);
        new ProvianPVT9EligibilityVerifier(divergentGrant, ELIGIBILITY_ID, ELIGIBILITY_VERSION);
    }

    function test_approvalRefusesGenesisOverGrant() public {
        GenBatch memory b = _genesisBatch();
        b.claims[0].reservedGrossAtomic = pvt.GENESIS_HUMAN_SIGNUP_GROSS() + 1;

        vm.prank(APPROVER);
        vm.expectRevert(ProvianPVT9EligibilityVerifier.InvalidGenesisGrant.selector);
        verifier.approveGenesisBatch(
            b.batchId, b.epoch, b.policyHash, b.cursorStart, b.cursorEnd, b.recipients, b.claims
        );
    }

    function test_approvalRefusesUnknownGenesisGrantType() public {
        GenBatch memory b = _genesisBatch();
        b.claims[0].grantType = pvt.GENESIS_DEVICE_LINK() + 1;

        vm.prank(APPROVER);
        vm.expectRevert(ProvianPVT9EligibilityVerifier.InvalidGenesisGrant.selector);
        verifier.approveGenesisBatch(
            b.batchId, b.epoch, b.policyHash, b.cursorStart, b.cursorEnd, b.recipients, b.claims
        );
    }

    // =====================================================================
    // G. End-to-end against the real kernel — this is the mock's replacement
    // =====================================================================

    function test_integration_approvedStandardBatchSettles() public {
        StdBatch memory b = _standardBatch();
        _approve(b);
        _settle(b);

        // 22 points at a 1e18 mint rate = 22 PVT gross; the human 99/0.5/0.5 split applies
        // to both recipients while the agent Foundation rate is still the human floor.
        assertEq(pvt.balanceOf(CONTRIBUTOR_A), uint256(15 ether) * 9_900 / 10_000);
        assertEq(pvt.balanceOf(CONTRIBUTOR_B), uint256(7 ether) * 9_900 / 10_000);
        assertEq(pvt.balanceOf(PROVIAN_TREASURY), uint256(22 ether) * 50 / 10_000);
        assertEq(pvt.balanceOf(FOUNDATION_TREASURY), uint256(22 ether) * 50 / 10_000);
    }

    function test_integration_approvedGenesisBatchSettles() public {
        GenBatch memory b = _genesisBatch();
        _approve(b);
        _settle(b);

        assertEq(pvt.balanceOf(CONTRIBUTOR_A), pvt.GENESIS_HUMAN_SIGNUP_GROSS() * 9_900 / 10_000);
        assertEq(pvt.balanceOf(CONTRIBUTOR_B), pvt.GENESIS_DEVICE_LINK_GROSS() * 9_900 / 10_000);
    }

    function test_integration_unapprovedBatchCannotSettle() public {
        StdBatch memory b = _standardBatch();
        // No approval.
        vm.prank(MINTER);
        vm.expectRevert(ProvianPVT9.VerificationFailed.selector);
        pvt.settleStandardPEBatch(
            b.batchId, b.epoch, b.policyHash, b.cursorStart, b.cursorEnd, b.recipients, b.claims
        );
        assertEq(pvt.totalSupply(), 0, "an unapproved batch minted");
    }

    function test_integration_batchAlteredAfterApprovalCannotSettle() public {
        StdBatch memory b = _standardBatch();
        _approve(b);

        // The minter tries to pay one contributor more than the evaluator approved.
        StdBatch memory altered = _clone(b);
        altered.claims[0].recordPointsAtomic = 10_000 ether;

        vm.prank(MINTER);
        vm.expectRevert(ProvianPVT9.VerificationFailed.selector);
        pvt.settleStandardPEBatch(
            altered.batchId,
            altered.epoch,
            altered.policyHash,
            altered.cursorStart,
            altered.cursorEnd,
            altered.recipients,
            altered.claims
        );
        assertEq(pvt.totalSupply(), 0, "an altered batch minted");
    }

    function test_integration_recipientSubstitutionAfterApprovalCannotSettle() public {
        StdBatch memory b = _standardBatch();
        _approve(b);

        StdBatch memory altered = _clone(b);
        altered.recipients[1].contributor = SUBSTITUTE;

        vm.prank(MINTER);
        vm.expectRevert(ProvianPVT9.VerificationFailed.selector);
        pvt.settleStandardPEBatch(
            altered.batchId,
            altered.epoch,
            altered.policyHash,
            altered.cursorStart,
            altered.cursorEnd,
            altered.recipients,
            altered.claims
        );
        assertEq(pvt.balanceOf(OUTSIDER), 0);
    }

    function test_integration_revokedApprovalCannotSettle() public {
        StdBatch memory b = _standardBatch();
        bytes32 digest = _approve(b);

        vm.prank(APPROVER);
        verifier.revokeBatchApproval(digest, ProvianPVT9.SettlementLane.StandardPE);

        vm.prank(MINTER);
        vm.expectRevert(ProvianPVT9.VerificationFailed.selector);
        pvt.settleStandardPEBatch(
            b.batchId, b.epoch, b.policyHash, b.cursorStart, b.cursorEnd, b.recipients, b.claims
        );
    }

    function test_integration_heldVerifierStopsSettlement() public {
        StdBatch memory b = _standardBatch();
        _approve(b);

        vm.prank(ADMIN);
        verifier.placeAdministrativeHold();

        vm.prank(MINTER);
        vm.expectRevert(ProvianPVT9.VerificationFailed.selector);
        pvt.settleStandardPEBatch(
            b.batchId, b.epoch, b.policyHash, b.cursorStart, b.cursorEnd, b.recipients, b.claims
        );

        vm.prank(ADMIN);
        verifier.resumeFromAdministrativeHold();
        _settle(b);
        assertGt(pvt.totalSupply(), 0, "settlement did not resume");
    }

    /**
     * A Genesis approval buys a standard submission nothing, even with the header copied
     * across verbatim.
     *
     * The mechanism is worth naming precisely, because it is NOT the lane field: the two
     * lanes hash under different domain separators over different struct types, so the
     * standard submission's digest is not "approved for the wrong lane", it is absent from
     * the approval map entirely. The lane field is a second, independent barrier, and it is
     * `test_standardApproval_doesNotSatisfyGenesisLane` /
     * `test_genesisApproval_doesNotSatisfyStandardLane` that exercise it directly.
     */
    function test_integration_genesisApprovalBuysNothingOnTheStandardLane() public {
        GenBatch memory g = _genesisBatch();
        _approve(g);

        ProvianPVT9.StandardRecipient[] memory recipients = new ProvianPVT9.StandardRecipient[](2);
        recipients[0] = ProvianPVT9.StandardRecipient({
            contributor: CONTRIBUTOR_A,
            beneficiaryClass: ProvianPVT9.BeneficiaryClass.HumanResolving,
            claimCount: 1
        });
        recipients[1] = ProvianPVT9.StandardRecipient({
            contributor: CONTRIBUTOR_B,
            beneficiaryClass: ProvianPVT9.BeneficiaryClass.HumanResolving,
            claimCount: 1
        });
        ProvianPVT9.StandardPEClaim[] memory claims = new ProvianPVT9.StandardPEClaim[](2);
        claims[0] = ProvianPVT9.StandardPEClaim({claimId: g.claims[0].claimId, recordPointsAtomic: 1 ether});
        claims[1] = ProvianPVT9.StandardPEClaim({claimId: g.claims[1].claimId, recordPointsAtomic: 1 ether});

        vm.prank(MINTER);
        vm.expectRevert(ProvianPVT9.VerificationFailed.selector);
        pvt.settleStandardPEBatch(
            g.batchId, g.epoch, g.policyHash, g.cursorStart, g.cursorEnd, recipients, claims
        );
    }

    // =====================================================================
    // H. Malformed verifier results are denials (the kernel's side of the contract)
    // =====================================================================

    function _armWith(address eligibilityVerifier) internal returns (ProvianPVT9 token) {
        token = new ProvianPVT9();
        // `armEpochZero` refuses a start at or before now, so this stack gets its own
        // forward timeline rather than reusing the fixture's already-elapsed one.
        uint64 start = uint64(block.timestamp + 1 days);
        vm.startPrank(ADMIN);
        token.appointOperationalMinter(MINTER);
        token.armEpochZero(
            ProvianPVT9.EpochZeroConfig({
                epochZeroStartsAt: start,
                genesisStartsAt: start,
                genesisEndsAt: start + 365 days,
                initialMintRate: 1 ether,
                provianTreasury: PROVIAN_TREASURY,
                foundationTreasury: FOUNDATION_TREASURY,
                eligibilityVerifier: ProvianPVT9.VerifierConfig({
                    verifier: eligibilityVerifier,
                    configurationId: ELIGIBILITY_ID,
                    version: ELIGIBILITY_VERSION
                }),
                initialFinalizedCursor: 100,
                combinedCapMode: ProvianPVT9.CombinedCapMode.Automatic,
                genesisCap: 7_500_000 ether,
                fixedCombinedCap: 0
            })
        );
        vm.stopPrank();
        vm.warp(start);
    }

    function _expectSettlementDenied(ProvianPVT9 token) internal {
        ProvianPVT9.StandardRecipient[] memory recipients = new ProvianPVT9.StandardRecipient[](1);
        recipients[0] = ProvianPVT9.StandardRecipient({
            contributor: CONTRIBUTOR_A,
            beneficiaryClass: ProvianPVT9.BeneficiaryClass.HumanResolving,
            claimCount: 1
        });
        ProvianPVT9.StandardPEClaim[] memory claims = new ProvianPVT9.StandardPEClaim[](1);
        claims[0] = ProvianPVT9.StandardPEClaim({claimId: _nextId("claim"), recordPointsAtomic: 1 ether});

        uint64 epoch = token.currentEpoch();
        bytes32 policyHash = token.getEpochPolicy(epoch).policyHash;
        uint256 cursor = token.nextFinalizedCursor();

        vm.prank(MINTER);
        vm.expectRevert(ProvianPVT9.VerificationFailed.selector);
        token.settleStandardPEBatch(_nextId("batch"), epoch, policyHash, cursor, cursor + 1, recipients, claims);
        assertEq(token.totalSupply(), 0);
    }

    // =====================================================================
    // I. Over-restriction differential
    // =====================================================================

    /**
     * The contract names over-restriction as "the one failure mode this oracle must not
     * introduce": a batch the KERNEL would happily settle but the oracle refuses to approve
     * can never be settled, and since the kernel is immutable there is no way to relax the
     * oracle's opinion after the fact — the affected claims are simply unpayable, and the
     * settler's only recourse is to drop them.
     *
     * These fuzz the batch shape against a kernel wired to an always-true verifier — so the
     * kernel's own accept/reject behaviour is observed with the oracle out of the loop — and
     * assert the implication that matters in one direction only:
     *
     *     the kernel settled it  =>  the oracle would have approved it
     *
     * The converse is deliberately NOT asserted. The oracle may approve batches the kernel
     * then rejects on state it cannot see (cursor continuity, already-settled claims, anchor
     * reuse, the Genesis window); that direction is safe, because the kernel has the last word.
     */
    ProvianPVT9 internal diffKernel;
    ProvianPVT9EligibilityVerifier internal diffOracle;

    function _setUpDifferential() internal {
        diffKernel = _armWith(address(new AlwaysTrueVerifier()));
        diffOracle = new ProvianPVT9EligibilityVerifier(diffKernel, ELIGIBILITY_ID, ELIGIBILITY_VERSION);
        vm.prank(ADMIN);
        diffOracle.appointBatchApprover(APPROVER);
    }

    function testFuzz_standardOracleNeverRefusesWhatTheKernelSettles(
        uint8 recipientSeed,
        uint8 claimSpread,
        uint96 points,
        uint8 classSeed,
        uint8 cursorSkew,
        bool zeroBatchId
    ) public {
        _setUpDifferential();

        uint256 recipientCount = recipientSeed % 7; // 0..6, so empty batches are covered too
        uint256 claimsPerRecipient = 1 + (claimSpread % 3);
        uint256 claimCount = recipientCount * claimsPerRecipient;

        ProvianPVT9.StandardRecipient[] memory recipients = new ProvianPVT9.StandardRecipient[](recipientCount);
        ProvianPVT9.StandardPEClaim[] memory claims = new ProvianPVT9.StandardPEClaim[](claimCount);
        for (uint256 i = 0; i < recipientCount; ++i) {
            recipients[i] = ProvianPVT9.StandardRecipient({
                // forge-lint: disable-next-line(unsafe-typecast)
                contributor: address(uint160(0x5000 + i)),
                beneficiaryClass: ProvianPVT9.BeneficiaryClass(uint8((classSeed + i) % 3)),
                claimCount: claimsPerRecipient
            });
            for (uint256 j = 0; j < claimsPerRecipient; ++j) {
                claims[i * claimsPerRecipient + j] = ProvianPVT9.StandardPEClaim({
                    claimId: keccak256(abi.encode("diff", i, j)),
                    recordPointsAtomic: points
                });
            }
        }

        bytes32 batchId = zeroBatchId ? bytes32(0) : keccak256("diff-batch");
        uint64 epoch = diffKernel.currentEpoch();
        bytes32 policyHash = diffKernel.getEpochPolicy(epoch).policyHash;
        uint256 cursorStart = diffKernel.nextFinalizedCursor() + (cursorSkew % 2);

        bool oracleApproved;
        vm.prank(APPROVER);
        try diffOracle.approveStandardBatch(
            batchId, epoch, policyHash, cursorStart, cursorStart + claimCount, recipients, claims
        ) {
            oracleApproved = true;
        } catch {
            oracleApproved = false;
        }

        vm.prank(MINTER);
        try diffKernel.settleStandardPEBatch(
            batchId, epoch, policyHash, cursorStart, cursorStart + claimCount, recipients, claims
        ) {
            assertTrue(oracleApproved, "kernel settled a batch the oracle refused to approve");
        } catch {} // the kernel rejecting says nothing about the oracle
    }

    function testFuzz_genesisOracleNeverRefusesWhatTheKernelSettles(
        uint8 recipientSeed,
        uint8 grantSeed,
        uint8 cursorSkew,
        bool zeroBatchId,
        bool halfGrant
    ) public {
        _setUpDifferential();

        uint256 recipientCount = recipientSeed % 7;
        uint8 grantType = uint8(grantSeed % 4); // 3 is invalid — the kernel must reject it too
        uint256 maximum = grantType < 3 ? diffKernel.genesisGrantMaximum(grantType) : 0;
        uint256 reserved = halfGrant && maximum > 1 ? maximum / 2 : maximum;

        ProvianPVT9.GenesisRecipient[] memory recipients = new ProvianPVT9.GenesisRecipient[](recipientCount);
        ProvianPVT9.GenesisPEClaim[] memory claims = new ProvianPVT9.GenesisPEClaim[](recipientCount);
        for (uint256 i = 0; i < recipientCount; ++i) {
            // forge-lint: disable-next-line(unsafe-typecast)
            recipients[i] = ProvianPVT9.GenesisRecipient({contributor: address(uint160(0x6000 + i)), claimCount: 1});
            claims[i] = ProvianPVT9.GenesisPEClaim({
                claimId: keccak256(abi.encode("diff-genesis-claim", i)),
                walletId: keccak256(abi.encode("diff-genesis-wallet", i)),
                oneTimeAnchor: keccak256(abi.encode("diff-genesis-anchor", i)),
                grantType: grantType,
                qualifiedAt: uint64(block.timestamp),
                reservedGrossAtomic: reserved
            });
        }

        bytes32 batchId = zeroBatchId ? bytes32(0) : keccak256("diff-genesis-batch");
        uint64 epoch = diffKernel.currentEpoch();
        bytes32 policyHash = diffKernel.getEpochPolicy(epoch).policyHash;
        uint256 cursorStart = diffKernel.nextFinalizedCursor() + (cursorSkew % 2);

        bool oracleApproved;
        vm.prank(APPROVER);
        try diffOracle.approveGenesisBatch(
            batchId, epoch, policyHash, cursorStart, cursorStart + recipientCount, recipients, claims
        ) {
            oracleApproved = true;
        } catch {
            oracleApproved = false;
        }

        vm.prank(MINTER);
        try diffKernel.settleGenesisPEBatch(
            batchId, epoch, policyHash, cursorStart, cursorStart + recipientCount, recipients, claims
        ) {
            assertTrue(oracleApproved, "kernel settled a genesis batch the oracle refused to approve");
        } catch {}
    }

    /// The recipient cap is the one bound where the oracle and the kernel could disagree by
    /// an off-by-one, and fuzzing will not reliably land on it.
    function test_oracleAcceptsExactlyTheKernelsRecipientMaximum() public {
        _setUpDifferential();
        uint256 count = diffKernel.MAX_RECIPIENTS_PER_BATCH();

        ProvianPVT9.StandardRecipient[] memory recipients = new ProvianPVT9.StandardRecipient[](count);
        ProvianPVT9.StandardPEClaim[] memory claims = new ProvianPVT9.StandardPEClaim[](count);
        for (uint256 i = 0; i < count; ++i) {
            recipients[i] = ProvianPVT9.StandardRecipient({
                // forge-lint: disable-next-line(unsafe-typecast)
                contributor: address(uint160(0x7000 + i)),
                beneficiaryClass: ProvianPVT9.BeneficiaryClass.HumanResolving,
                claimCount: 1
            });
            claims[i] = ProvianPVT9.StandardPEClaim({
                claimId: keccak256(abi.encode("cap", i)),
                recordPointsAtomic: 1 ether
            });
        }

        uint64 epoch = diffKernel.currentEpoch();
        bytes32 policyHash = diffKernel.getEpochPolicy(epoch).policyHash;
        uint256 cursorStart = diffKernel.nextFinalizedCursor();

        vm.prank(APPROVER);
        diffOracle.approveStandardBatch(
            keccak256("cap-batch"), epoch, policyHash, cursorStart, cursorStart + count, recipients, claims
        );
        vm.prank(MINTER);
        diffKernel.settleStandardPEBatch(
            keccak256("cap-batch"), epoch, policyHash, cursorStart, cursorStart + count, recipients, claims
        );
    }

    // =====================================================================
    // J. Cross-language digest pin
    // =====================================================================

    /**
     * The off-chain settler recomputes these same preimages in TypeScript
     * (`provian-backend/src/core/pvt/wp-ev/settlement-batch.ts`) so it can prove, before
     * spending a transaction, that the batch it is about to submit is the batch it had
     * approved. That mirror is only worth anything if it is pinned, so both languages
     * assert the SAME constants for the SAME fixed vector — see
     * `settlement-batch.test.ts::cross-language digest vector`. A drift on either side
     * fails a test instead of a mint.
     *
     * The kernel code is etched at a fixed address and the chain id fixed, because the
     * digest binds both and the vector has to be reproducible off-chain.
     */
    address internal constant VECTOR_KERNEL = 0x1111111111111111111111111111111111111111;
    uint256 internal constant VECTOR_CHAIN_ID = 8453;

    function _vectorKernel() internal returns (ProvianPVT9) {
        vm.etch(VECTOR_KERNEL, address(pvt).code);
        vm.chainId(VECTOR_CHAIN_ID);
        return ProvianPVT9(VECTOR_KERNEL);
    }

    function _vectorStandardRecipients() internal pure returns (ProvianPVT9.StandardRecipient[] memory r) {
        r = new ProvianPVT9.StandardRecipient[](2);
        r[0] = ProvianPVT9.StandardRecipient({
            contributor: 0x00000000000000000000000000000000000000A1,
            beneficiaryClass: ProvianPVT9.BeneficiaryClass.HumanResolving,
            claimCount: 1
        });
        r[1] = ProvianPVT9.StandardRecipient({
            contributor: 0x00000000000000000000000000000000000000b2,
            beneficiaryClass: ProvianPVT9.BeneficiaryClass.AutonomousAgent,
            claimCount: 1
        });
    }

    function _vectorStandardClaims() internal pure returns (ProvianPVT9.StandardPEClaim[] memory c) {
        c = new ProvianPVT9.StandardPEClaim[](2);
        c[0] = ProvianPVT9.StandardPEClaim({
            claimId: keccak256("wp-ev.vector.claim.1"),
            recordPointsAtomic: 1 ether
        });
        c[1] = ProvianPVT9.StandardPEClaim({
            claimId: keccak256("wp-ev.vector.claim.2"),
            recordPointsAtomic: 2 ether
        });
    }

    function _vectorGenesisRecipients() internal pure returns (ProvianPVT9.GenesisRecipient[] memory r) {
        r = new ProvianPVT9.GenesisRecipient[](1);
        r[0] = ProvianPVT9.GenesisRecipient({
            contributor: 0x00000000000000000000000000000000000000A1,
            claimCount: 1
        });
    }

    function _vectorGenesisClaims() internal pure returns (ProvianPVT9.GenesisPEClaim[] memory c) {
        c = new ProvianPVT9.GenesisPEClaim[](1);
        c[0] = ProvianPVT9.GenesisPEClaim({
            claimId: keccak256("wp-ev.vector.claim.1"),
            walletId: keccak256("wp-ev.vector.wallet"),
            oneTimeAnchor: keccak256("wp-ev.vector.anchor"),
            grantType: 0,
            qualifiedAt: 1_800_000_000,
            reservedGrossAtomic: 75 ether
        });
    }

    function test_crossLanguageStandardClaimsHashVector() public {
        assertEq(
            _vectorKernel().hashStandardClaims(_vectorStandardRecipients(), _vectorStandardClaims()),
            VECTOR_STANDARD_CLAIMS_HASH
        );
    }

    function test_crossLanguageGenesisClaimsHashVector() public {
        assertEq(
            _vectorKernel().hashGenesisClaims(_vectorGenesisRecipients(), _vectorGenesisClaims()),
            VECTOR_GENESIS_CLAIMS_HASH
        );
    }

    function test_crossLanguageStandardDigestVector() public {
        assertEq(
            _vectorKernel().computeSettlementDigest(
                ProvianPVT9.SettlementLane.StandardPE,
                keccak256("wp-ev.vector.batchId"),
                7,
                keccak256("wp-ev.vector.policy"),
                1_000,
                1_002,
                VECTOR_STANDARD_CLAIMS_HASH
            ),
            VECTOR_STANDARD_DIGEST
        );
    }

    function test_crossLanguageGenesisDigestVector() public {
        assertEq(
            _vectorKernel().computeSettlementDigest(
                ProvianPVT9.SettlementLane.GenesisPE,
                keccak256("wp-ev.vector.batchId"),
                7,
                keccak256("wp-ev.vector.policy"),
                1_000,
                1_001,
                VECTOR_GENESIS_CLAIMS_HASH
            ),
            VECTOR_GENESIS_DIGEST
        );
    }

    /**
     * Closes the loop between the two halves of WP-EV: the digest the ORACLE derives from
     * the batch handed to it is exactly the digest the off-chain settler computed for that
     * same batch (`settlement-batch.test.ts::assembles the vector batch...`, which asserts
     * this same constant after running the entries through `assembleStandardBatch`).
     *
     * Without this, the two sides could each be internally consistent and still disagree
     * about what they had agreed on.
     */
    function test_oracleDerivesTheDigestTheOffChainSettlerComputed() public {
        ProvianPVT9 kernel = _vectorKernel();
        ProvianPVT9EligibilityVerifier vectorVerifier =
            new ProvianPVT9EligibilityVerifier(kernel, ELIGIBILITY_ID, ELIGIBILITY_VERSION);
        vm.prank(ADMIN);
        vectorVerifier.appointBatchApprover(APPROVER);

        vm.prank(APPROVER);
        bytes32 derived = vectorVerifier.approveStandardBatch(
            keccak256("wp-ev.vector.batchId"),
            7,
            keccak256("wp-ev.vector.policy"),
            1_000,
            1_002,
            _vectorStandardRecipients(),
            _vectorStandardClaims()
        );

        assertEq(derived, VECTOR_STANDARD_DIGEST, "oracle derived a digest the settler did not");
        assertTrue(vectorVerifier.verifyStandardBatch(derived, ELIGIBILITY_ID, ELIGIBILITY_VERSION));
    }

    function test_revertingVerifierIsADenial() public {
        _expectSettlementDenied(_armWith(address(new RevertingVerifier())));
    }

    function test_shortReturnVerifierIsADenial() public {
        _expectSettlementDenied(_armWith(address(new ShortReturnVerifier())));
    }

    function test_nonCanonicalTrueVerifierIsADenial() public {
        _expectSettlementDenied(_armWith(address(new NonCanonicalTrueVerifier())));
    }
}
