// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProvianPVT9} from "../src/ProvianPVT9.sol";
import {FullPrecisionMath} from "../src/libraries/FullPrecisionMath.sol";
import {ProvianPVT9TestBase, MockPVT9Verifier, MalformedPVT9Verifier} from "./ProvianPVT9TestBase.sol";

contract ProvianPVT9PolicyTest is ProvianPVT9TestBase {
    function testFuzzFullPrecisionCrossProductsMatchSafeDecomposition(uint256 rawPoints, uint256 rawRate) public pure {
        uint256 points = (uint256(1) << 180) + (rawPoints % (uint256(1) << 20));
        uint256 rate = (uint256(1) << 80) + (rawRate % (uint256(1) << 20));
        assertGt(points, type(uint256).max / rate);

        // Deliberately divide first so this is an independent, non-overflowing decomposition.
        // forge-lint: disable-next-line(divide-before-multiply)
        uint256 expected = (points / 1 ether) * rate + ((points % 1 ether) * rate) / 1 ether;
        assertEq(FullPrecisionMath.mulDiv(points, rate, 1 ether), expected);
    }

    function testFloorOrderIsPerRecipientThenProvianAtBatchScopeAcrossBothLanes() public {
        ProvianPVT9.StandardRecipient[] memory standardRecipients = new ProvianPVT9.StandardRecipient[](2);
        standardRecipients[0] = ProvianPVT9.StandardRecipient({
            contributor: address(0x1001), beneficiaryClass: ProvianPVT9.BeneficiaryClass.Unknown, claimCount: 1
        });
        standardRecipients[1] = ProvianPVT9.StandardRecipient({
            contributor: address(0x1002), beneficiaryClass: ProvianPVT9.BeneficiaryClass.Unknown, claimCount: 1
        });
        ProvianPVT9.StandardPEClaim[] memory standardClaims = new ProvianPVT9.StandardPEClaim[](2);
        standardClaims[0] = ProvianPVT9.StandardPEClaim({claimId: _claimId(), recordPointsAtomic: 101});
        standardClaims[1] = ProvianPVT9.StandardPEClaim({claimId: _claimId(), recordPointsAtomic: 101});
        uint256 cursor = pvt.nextFinalizedCursor();
        bytes32 policyHash = _policy(0).policyHash;
        bytes32 standardBatchId = _batchId();
        vm.prank(MINTER);
        pvt.settleStandardPEBatch(
            standardBatchId, 0, policyHash, cursor, cursor + 2, standardRecipients, standardClaims
        );
        ProvianPVT9.BatchRecord memory standardRecord = pvt.getBatchRecord(standardBatchId);
        assertEq(standardRecord.grossInput, 202);
        assertEq(standardRecord.contributorTotal, 198);
        assertEq(standardRecord.foundationTotal, 0);
        assertEq(standardRecord.provianTotal, 1);
        assertEq(standardRecord.totalMinted, 199);

        ProvianPVT9.GenesisRecipient[] memory genesisRecipients = new ProvianPVT9.GenesisRecipient[](2);
        genesisRecipients[0] = ProvianPVT9.GenesisRecipient({contributor: address(0x2001), claimCount: 1});
        genesisRecipients[1] = ProvianPVT9.GenesisRecipient({contributor: address(0x2002), claimCount: 1});
        ProvianPVT9.GenesisPEClaim[] memory genesisClaims = new ProvianPVT9.GenesisPEClaim[](2);
        genesisClaims[0] = ProvianPVT9.GenesisPEClaim({
            claimId: _claimId(),
            walletId: bytes32(uint256(1)),
            oneTimeAnchor: bytes32(uint256(11)),
            grantType: pvt.GENESIS_HUMAN_SIGNUP(),
            qualifiedAt: epochStart,
            reservedGrossAtomic: 101
        });
        genesisClaims[1] = ProvianPVT9.GenesisPEClaim({
            claimId: _claimId(),
            walletId: bytes32(uint256(2)),
            oneTimeAnchor: bytes32(uint256(12)),
            grantType: pvt.GENESIS_AGENT_SIGNUP(),
            qualifiedAt: epochStart,
            reservedGrossAtomic: 101
        });
        cursor = pvt.nextFinalizedCursor();
        bytes32 genesisBatchId = _batchId();
        vm.prank(MINTER);
        pvt.settleGenesisPEBatch(genesisBatchId, 0, policyHash, cursor, cursor + 2, genesisRecipients, genesisClaims);
        ProvianPVT9.BatchRecord memory genesisRecord = pvt.getBatchRecord(genesisBatchId);
        assertEq(genesisRecord.grossInput, 202);
        assertEq(genesisRecord.contributorTotal, 198);
        assertEq(genesisRecord.foundationTotal, 0);
        assertEq(genesisRecord.provianTotal, 1);
        assertEq(genesisRecord.totalMinted, 199);
        assertEq(pvt.balanceOf(PROVIAN_TREASURY), 2);
        assertEq(pvt.balanceOf(FOUNDATION_TREASURY), 0);
        assertEq(pvt.totalSupply(), 398);
    }

    function testProspectivePolicySnapshotsRotateDestinationsAndApplyDifferentialRate() public {
        bytes32 eligibilityId2 = keccak256("eligibility-v2");
        bytes32 beneficiaryId2 = keccak256("beneficiary-v2");
        MockPVT9Verifier verifier2 = new MockPVT9Verifier(eligibilityId2, 2, beneficiaryId2, 2);
        address provianTreasury2 = address(0xB001);
        address foundationTreasury2 = address(0xB002);
        ProvianPVT9.EpochPolicy memory policy0Before = _policy(0);

        vm.startPrank(ADMIN);
        pvt.scheduleMintRate(1, 2 ether);
        pvt.scheduleTreasuryDestinations(1, provianTreasury2, foundationTreasury2);
        pvt.scheduleBeneficiaryVerifier(
            1, ProvianPVT9.VerifierConfig({verifier: address(verifier2), configurationId: beneficiaryId2, version: 2})
        );
        pvt.scheduleAgentFoundationRate(1, 1_000);
        pvt.scheduleEligibilityVerifier(
            1, ProvianPVT9.VerifierConfig({verifier: address(verifier2), configurationId: eligibilityId2, version: 2})
        );
        vm.stopPrank();

        _settleStandard(address(0x1000), ProvianPVT9.BeneficiaryClass.Unknown, 10 ether);
        assertEq(pvt.balanceOf(PROVIAN_TREASURY), 0.05 ether);
        assertEq(pvt.balanceOf(FOUNDATION_TREASURY), 0.05 ether);

        vm.warp(uint256(epochStart) + pvt.EPOCH_DURATION());
        vm.prank(ADMIN);
        vm.expectRevert(ProvianPVT9.PolicyNotProspective.selector);
        pvt.scheduleMintRate(1, 3 ether);
        pvt.openNextEpoch();

        ProvianPVT9.EpochPolicy memory policy0After = _policy(0);
        ProvianPVT9.EpochPolicy memory policy1 = _policy(1);
        assertEq(policy0After.policyHash, policy0Before.policyHash);
        assertEq(policy0After.mintRate, 1 ether);
        assertEq(policy0After.agentFoundationBps, 50);
        assertEq(policy0After.provianTreasury, PROVIAN_TREASURY);
        assertEq(policy0After.foundationTreasury, FOUNDATION_TREASURY);
        assertEq(policy1.mintRate, 2 ether);
        assertEq(policy1.agentFoundationBps, 1_000);
        assertEq(policy1.provianTreasury, provianTreasury2);
        assertEq(policy1.foundationTreasury, foundationTreasury2);
        assertEq(policy1.beneficiaryVerifier.verifier, address(verifier2));
        assertEq(policy1.beneficiaryVerifier.configurationId, beneficiaryId2);
        assertEq(policy1.beneficiaryVerifier.version, 2);
        assertEq(policy1.eligibilityVerifier.verifier, address(verifier2));
        assertEq(policy1.eligibilityVerifier.configurationId, eligibilityId2);
        assertEq(policy1.eligibilityVerifier.version, 2);
        assertNotEq(policy1.policyHash, policy0After.policyHash);

        ProvianPVT9.StandardRecipient[] memory recipients = new ProvianPVT9.StandardRecipient[](2);
        recipients[0] = ProvianPVT9.StandardRecipient({
            contributor: address(0x1101), beneficiaryClass: ProvianPVT9.BeneficiaryClass.HumanResolving, claimCount: 1
        });
        recipients[1] = ProvianPVT9.StandardRecipient({
            contributor: address(0x1102), beneficiaryClass: ProvianPVT9.BeneficiaryClass.AutonomousAgent, claimCount: 1
        });
        ProvianPVT9.StandardPEClaim[] memory claims = new ProvianPVT9.StandardPEClaim[](2);
        claims[0] = ProvianPVT9.StandardPEClaim({claimId: _claimId(), recordPointsAtomic: 100 ether});
        claims[1] = ProvianPVT9.StandardPEClaim({claimId: _claimId(), recordPointsAtomic: 100 ether});
        uint256 cursor = pvt.nextFinalizedCursor();
        bytes32 batchId = _batchId();
        vm.prank(MINTER);
        pvt.settleStandardPEBatch(batchId, 1, policy1.policyHash, cursor, cursor + 2, recipients, claims);

        assertEq(pvt.balanceOf(address(0x1101)), 198 ether);
        assertEq(pvt.balanceOf(address(0x1102)), 179 ether);
        assertEq(pvt.balanceOf(provianTreasury2), 2 ether);
        assertEq(pvt.balanceOf(foundationTreasury2), 21 ether);
        assertEq(pvt.balanceOf(PROVIAN_TREASURY), 0.05 ether);
        assertEq(pvt.balanceOf(FOUNDATION_TREASURY), 0.05 ether);
    }

    function testDifferentialClassificationUnknownOutageAndMalformedAnswerFailAtomically() public {
        _scheduleDifferentialRate(1, 1_000);
        _advanceToEpoch(1);

        uint256 cursor = pvt.nextFinalizedCursor();
        _expectStandardRevert(
            ProvianPVT9.BeneficiaryClassificationRequired.selector,
            address(0x1201),
            ProvianPVT9.BeneficiaryClass.Unknown,
            100 ether
        );
        assertEq(pvt.totalSupply(), 0);
        assertEq(pvt.nextFinalizedCursor(), cursor);

        verifier.setRevertBeneficiary(true);
        _expectStandardRevert(
            ProvianPVT9.VerificationFailed.selector,
            address(0x1202),
            ProvianPVT9.BeneficiaryClass.AutonomousAgent,
            100 ether
        );
        assertEq(pvt.totalSupply(), 0);
        assertEq(pvt.nextFinalizedCursor(), cursor);
        verifier.setRevertBeneficiary(false);

        MalformedPVT9Verifier malformed = new MalformedPVT9Verifier();
        vm.prank(ADMIN);
        pvt.scheduleBeneficiaryVerifier(
            2,
            ProvianPVT9.VerifierConfig({
                verifier: address(malformed), configurationId: BENEFICIARY_ID, version: BENEFICIARY_VERSION
            })
        );
        _advanceToEpoch(2);
        _expectStandardRevert(
            ProvianPVT9.VerificationFailed.selector,
            address(0x1203),
            ProvianPVT9.BeneficiaryClass.AutonomousAgent,
            100 ether
        );
        assertEq(pvt.totalSupply(), 0);
        assertEq(pvt.nextFinalizedCursor(), cursor);
    }

    function testAgentFoundationSchedulesRejectIncompleteTransitionsAndOpenSequentially() public {
        vm.prank(ADMIN);
        vm.expectRevert(ProvianPVT9.AgentFoundationRateOutOfDomain.selector);
        pvt.scheduleAgentFoundationRate(1, 9_951);

        // The former checkpoint persisted this incomplete schedule, then froze
        // openNextEpoch at epoch 1 before a same-epoch verifier could be added.
        vm.prank(ADMIN);
        vm.expectRevert(ProvianPVT9.VerifierStateInvalid.selector);
        pvt.scheduleAgentFoundationRate(1, 1_000);
        (bool invalidRateExists, uint256 invalidRate) = pvt.scheduledAgentFoundationRates(1);
        assertFalse(invalidRateExists);
        assertEq(invalidRate, 0);
        assertFalse(pvt.getScheduledBeneficiaryVerifier(1).exists);

        vm.warp(uint256(epochStart) + pvt.EPOCH_DURATION());
        vm.prank(ADMIN);
        vm.expectRevert(ProvianPVT9.PolicyNotProspective.selector);
        pvt.scheduleBeneficiaryVerifier(
            1,
            ProvianPVT9.VerifierConfig({
                verifier: address(verifier), configurationId: BENEFICIARY_ID, version: BENEFICIARY_VERSION
            })
        );
        assertEq(pvt.lastOpenedEpoch(), 0);
        pvt.openNextEpoch();
        assertEq(pvt.lastOpenedEpoch(), 1);
        assertEq(_policy(1).agentFoundationBps, pvt.HUMAN_FOUNDATION_BPS());
        assertEq(_policy(1).beneficiaryVerifier.verifier, address(0));

        // Verifier-first ordering may carry across unopened epochs.
        vm.prank(ADMIN);
        pvt.scheduleBeneficiaryVerifier(
            2,
            ProvianPVT9.VerifierConfig({
                verifier: address(verifier), configurationId: BENEFICIARY_ID, version: BENEFICIARY_VERSION
            })
        );
        vm.prank(ADMIN);
        pvt.scheduleAgentFoundationRate(4, 9_950);
        _advanceToEpoch(4);
        _settleStandard(address(0x1301), ProvianPVT9.BeneficiaryClass.AutonomousAgent, 100 ether);

        assertEq(_policy(4).agentFoundationBps, 9_950);
        assertEq(_policy(4).beneficiaryVerifier.verifier, address(verifier));
        assertEq(pvt.balanceOf(address(0x1301)), 0);
        assertEq(pvt.balanceOf(PROVIAN_TREASURY), 0.5 ether);
        assertEq(pvt.balanceOf(FOUNDATION_TREASURY), 99.5 ether);
        assertEq(pvt.totalSupply(), 100 ether);

        ProvianPVT9.VerifierConfig memory nullVerifier =
            ProvianPVT9.VerifierConfig({verifier: address(0), configurationId: bytes32(0), version: 0});
        vm.prank(ADMIN);
        vm.expectRevert(ProvianPVT9.VerifierStateInvalid.selector);
        pvt.scheduleBeneficiaryVerifier(6, nullVerifier);
        assertFalse(pvt.getScheduledBeneficiaryVerifier(6).exists);

        vm.startPrank(ADMIN);
        pvt.scheduleAgentFoundationRate(6, pvt.HUMAN_FOUNDATION_BPS());
        pvt.scheduleBeneficiaryVerifier(6, nullVerifier);
        vm.stopPrank();
        _advanceToEpoch(6);

        assertEq(pvt.lastOpenedEpoch(), 6);
        assertEq(_policy(6).agentFoundationBps, pvt.HUMAN_FOUNDATION_BPS());
        assertEq(_policy(6).beneficiaryVerifier.verifier, address(0));
        _settleStandard(address(0x1302), ProvianPVT9.BeneficiaryClass.AutonomousAgent, 100 ether);
        assertEq(pvt.balanceOf(address(0x1302)), 99 ether);
    }

    function testProspectiveMintRateHasNoPermanentMaximumAndUsesFullPrecision() public {
        uint256 wideRate = uint256(1) << 100;
        uint256 points = uint256(1) << 200;
        vm.startPrank(ADMIN);
        pvt.scheduleMintRate(1, wideRate);
        pvt.scheduleCapPolicy(1, ProvianPVT9.CombinedCapMode.Fixed, type(uint256).max, type(uint256).max);
        vm.stopPrank();
        _advanceToEpoch(1);

        (bytes32 batchId,) = _settleStandard(address(0x1401), ProvianPVT9.BeneficiaryClass.Unknown, points);
        uint256 expectedGross = (points / 1 ether) * wideRate + ((points % 1 ether) * wideRate) / 1 ether;
        ProvianPVT9.BatchRecord memory record = pvt.getBatchRecord(batchId);
        assertGt(wideRate, pvt.INITIAL_MAX_MINT_RATE());
        assertEq(record.grossInput, expectedGross);
        assertGt(record.totalMinted, 0);
        assertLe(record.totalMinted, expectedGross);

        vm.startPrank(ADMIN);
        pvt.scheduleMintRate(2, type(uint256).max);
        pvt.scheduleCapPolicy(2, ProvianPVT9.CombinedCapMode.Fixed, type(uint256).max, type(uint256).max);
        vm.stopPrank();
        _advanceToEpoch(2);
        uint256 supply = pvt.totalSupply();
        uint256 cursor = pvt.nextFinalizedCursor();
        _expectStandardRevert(
            FullPrecisionMath.MulDivOverflow.selector,
            address(0x1402),
            ProvianPVT9.BeneficiaryClass.Unknown,
            type(uint256).max
        );
        assertEq(pvt.totalSupply(), supply);
        assertEq(pvt.nextFinalizedCursor(), cursor);
    }

    function testCumulativeGenesisAndCombinedCapsAreAtomicAndResetPerEpoch() public {
        vm.prank(ADMIN);
        pvt.scheduleCapPolicy(1, ProvianPVT9.CombinedCapMode.Fixed, 100 ether, 150 ether);
        _advanceToEpoch(1);

        _settleGenesis(address(0x1501), bytes32(uint256(1)), bytes32(uint256(11)), pvt.GENESIS_HUMAN_SIGNUP(), 60 ether);
        _settleStandard(address(0x1502), ProvianPVT9.BeneficiaryClass.Unknown, 80 ether);
        uint256 cursor = pvt.nextFinalizedCursor();

        _expectGenesisRevert(
            ProvianPVT9.GenesisEpochCapExceeded.selector,
            address(0x1503),
            bytes32(uint256(2)),
            bytes32(uint256(12)),
            pvt.GENESIS_HUMAN_SIGNUP(),
            41 ether
        );
        assertEq(pvt.epochGenesisIssued(1), 60 ether);
        assertEq(pvt.epochTotalIssued(1), 140 ether);
        assertEq(pvt.genesisWalletGrossIssued(bytes32(uint256(2))), 0);
        assertEq(pvt.nextFinalizedCursor(), cursor);

        _expectGenesisRevert(
            ProvianPVT9.CombinedEpochCapExceeded.selector,
            address(0x1504),
            bytes32(uint256(3)),
            bytes32(uint256(13)),
            pvt.GENESIS_HUMAN_SIGNUP(),
            40 ether
        );
        assertEq(pvt.epochGenesisIssued(1), 60 ether);
        assertEq(pvt.epochTotalIssued(1), 140 ether);
        assertEq(pvt.nextFinalizedCursor(), cursor);

        _settleStandard(address(0x1505), ProvianPVT9.BeneficiaryClass.Unknown, 10 ether);
        cursor = pvt.nextFinalizedCursor();
        _expectStandardRevert(
            ProvianPVT9.CombinedEpochCapExceeded.selector,
            address(0x1506),
            ProvianPVT9.BeneficiaryClass.Unknown,
            1 ether
        );
        assertEq(pvt.epochGenesisIssued(1), 60 ether);
        assertEq(pvt.epochTotalIssued(1), 150 ether);
        assertEq(pvt.totalSupply(), 150 ether);
        assertEq(pvt.nextFinalizedCursor(), cursor);

        _advanceToEpoch(2);
        _settleGenesis(address(0x1507), bytes32(uint256(4)), bytes32(uint256(14)), pvt.GENESIS_HUMAN_SIGNUP(), 60 ether);
        assertEq(pvt.epochGenesisIssued(2), 60 ether);
        assertEq(pvt.epochTotalIssued(2), 60 ether);
    }

    function testEpochElevenIsFlatAndEpochTwelveUsesTwiceFlooredTrailingAverage() public {
        _settleStandard(address(0x1601), ProvianPVT9.BeneficiaryClass.Unknown, 1 ether);
        _advanceToEpoch(11);
        assertEq(_policy(0).combinedCap, 10_000_000 ether);
        assertEq(_policy(11).combinedCap, 10_000_000 ether);

        _advanceToEpoch(12);
        uint256 flooredAverage = uint256(1 ether) / 12;
        assertEq(pvt.trailingAverageForEpoch(12), flooredAverage);
        assertEq(_policy(12).combinedCap, flooredAverage * 2);
        assertEq(_policy(12).combinedCap, 166_666_666_666_666_666);
    }

    function testZeroTrailingAverageProducesZeroCombinedCapWithoutTenMillionFloor() public {
        _advanceToEpoch(12);
        assertEq(pvt.trailingAverageForEpoch(12), 0);
        assertEq(_policy(12).combinedCap, 0);
        _expectStandardRevert(
            ProvianPVT9.CombinedEpochCapExceeded.selector,
            address(0x1701),
            ProvianPVT9.BeneficiaryClass.Unknown,
            1 ether
        );
        assertEq(pvt.totalSupply(), 0);
    }

    function testPolicyHashAndExactActiveEpochMismatchFailClosed() public {
        (ProvianPVT9.StandardRecipient[] memory recipients, ProvianPVT9.StandardPEClaim[] memory claims) =
            _oneStandard(address(0x1801), bytes32(uint256(1)), 1 ether);
        uint256 cursor = pvt.nextFinalizedCursor();
        bytes32 batchId = _batchId();
        vm.prank(MINTER);
        vm.expectRevert(ProvianPVT9.PolicyHashMismatch.selector);
        pvt.settleStandardPEBatch(batchId, 0, keccak256("stale-policy"), cursor, cursor + 1, recipients, claims);
        assertEq(pvt.totalSupply(), 0);
        assertEq(pvt.nextFinalizedCursor(), cursor);

        vm.warp(uint256(epochStart) + pvt.EPOCH_DURATION());
        bytes32 policy0Hash = _policy(0).policyHash;
        batchId = _batchId();
        vm.prank(MINTER);
        vm.expectRevert(ProvianPVT9.EpochMismatch.selector);
        pvt.settleStandardPEBatch(batchId, 0, policy0Hash, cursor, cursor + 1, recipients, claims);
        assertEq(pvt.totalSupply(), 0);
        assertEq(pvt.nextFinalizedCursor(), cursor);
    }

    function testHardRecipientLimitAllows500AndRejects501BeforeMint() public {
        uint256 recipientCount = pvt.MAX_RECIPIENTS_PER_BATCH();
        ProvianPVT9.StandardRecipient[] memory recipients = new ProvianPVT9.StandardRecipient[](recipientCount);
        ProvianPVT9.StandardPEClaim[] memory claims = new ProvianPVT9.StandardPEClaim[](recipientCount);
        for (uint256 i = 0; i < recipientCount; ++i) {
            recipients[i] = ProvianPVT9.StandardRecipient({
                contributor: address(uint160(i + 1)),
                beneficiaryClass: ProvianPVT9.BeneficiaryClass.Unknown,
                claimCount: 1
            });
            claims[i] = ProvianPVT9.StandardPEClaim({claimId: bytes32(i + 1), recordPointsAtomic: 1 ether});
        }
        uint256 cursor = pvt.nextFinalizedCursor();
        bytes32 policyHash = _policy(0).policyHash;
        vm.prank(MINTER);
        pvt.settleStandardPEBatch(_batchId(), 0, policyHash, cursor, cursor + recipientCount, recipients, claims);
        assertEq(pvt.totalSupply(), 500 ether);
        assertEq(pvt.nextFinalizedCursor(), cursor + 500);

        ProvianPVT9.StandardRecipient[] memory tooMany = new ProvianPVT9.StandardRecipient[](501);
        ProvianPVT9.StandardPEClaim[] memory noClaims = new ProvianPVT9.StandardPEClaim[](0);
        cursor = pvt.nextFinalizedCursor();
        bytes32 batchId = _batchId();
        vm.prank(MINTER);
        vm.expectRevert(ProvianPVT9.TooManyRecipients.selector);
        pvt.settleStandardPEBatch(batchId, 0, policyHash, cursor, cursor + 1, tooMany, noClaims);
        assertEq(pvt.totalSupply(), 500 ether);
        assertEq(pvt.nextFinalizedCursor(), cursor);
    }

    function _oneStandard(address contributor, bytes32 claimId, uint256 points)
        private
        pure
        returns (ProvianPVT9.StandardRecipient[] memory recipients, ProvianPVT9.StandardPEClaim[] memory claims)
    {
        recipients = new ProvianPVT9.StandardRecipient[](1);
        recipients[0] = ProvianPVT9.StandardRecipient({
            contributor: contributor, beneficiaryClass: ProvianPVT9.BeneficiaryClass.Unknown, claimCount: 1
        });
        claims = new ProvianPVT9.StandardPEClaim[](1);
        claims[0] = ProvianPVT9.StandardPEClaim({claimId: claimId, recordPointsAtomic: points});
    }
}
