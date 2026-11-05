// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProvianPVT9} from "../src/ProvianPVT9.sol";
import {ProvianPVT9TestBase, MalformedPVT9Verifier} from "./ProvianPVT9TestBase.sol";

contract ProvianPVT9CoreTest is ProvianPVT9TestBase {
    function testFreshTokenIsZeroSupplyUnarmedAndPinsImmutableCore() public {
        ProvianPVT9 fresh = new ProvianPVT9();
        assertEq(fresh.totalSupply(), 0);
        assertFalse(fresh.epochZeroArmed());
        assertEq(fresh.operationalMinter(), address(0));
        assertEq(fresh.BOOTSTRAP_ADMIN(), ADMIN);
        assertEq(fresh.PROVIAN_BPS(), 50);
        assertEq(fresh.HUMAN_FOUNDATION_BPS(), 50);
        assertEq(fresh.HUMAN_CONTRIBUTOR_BPS(), 9_900);
        assertEq(fresh.GENESIS_HUMAN_SIGNUP_GROSS(), 75 ether);
        assertEq(fresh.GENESIS_AGENT_SIGNUP_GROSS(), 75 ether);
        assertEq(fresh.GENESIS_DEVICE_LINK_GROSS(), 25 ether);
        assertEq(fresh.GENESIS_WALLET_GROSS_CEILING(), 500 ether);
        assertEq(fresh.EPOCH_DURATION(), 7 days);
    }

    function testEpochZeroRequiresMinterFutureDatesAndOneTimeArm() public {
        ProvianPVT9 fresh = new ProvianPVT9();
        ProvianPVT9.EpochZeroConfig memory config = ProvianPVT9.EpochZeroConfig({
            epochZeroStartsAt: uint64(block.timestamp + 1 days),
            genesisStartsAt: uint64(block.timestamp + 1 days),
            genesisEndsAt: uint64(block.timestamp + 20 days),
            initialMintRate: 1 ether,
            provianTreasury: PROVIAN_TREASURY,
            foundationTreasury: FOUNDATION_TREASURY,
            eligibilityVerifier: ProvianPVT9.VerifierConfig({
                verifier: address(verifier), configurationId: ELIGIBILITY_ID, version: ELIGIBILITY_VERSION
            }),
            initialFinalizedCursor: 0,
            combinedCapMode: ProvianPVT9.CombinedCapMode.Automatic,
            genesisCap: 7_500_000 ether,
            fixedCombinedCap: 0
        });

        vm.prank(ADMIN);
        vm.expectRevert(ProvianPVT9.OperationalMinterUnconfigured.selector);
        fresh.armEpochZero(config);

        vm.prank(ADMIN);
        fresh.appointOperationalMinter(MINTER);
        config.initialMintRate = 0.5 ether - 1;
        vm.prank(ADMIN);
        vm.expectRevert(ProvianPVT9.InitialMintRateOutOfRange.selector);
        fresh.armEpochZero(config);
        config.initialMintRate = 2 ether + 1;
        vm.prank(ADMIN);
        vm.expectRevert(ProvianPVT9.InitialMintRateOutOfRange.selector);
        fresh.armEpochZero(config);
        config.initialMintRate = 1 ether;
        vm.prank(ADMIN);
        fresh.armEpochZero(config);
        vm.prank(ADMIN);
        vm.expectRevert(ProvianPVT9.EpochZeroAlreadyArmed.selector);
        fresh.armEpochZero(config);
    }

    function testUnarmedKernelCannotSettle() public {
        ProvianPVT9 fresh = new ProvianPVT9();
        vm.prank(ADMIN);
        fresh.appointOperationalMinter(MINTER);
        ProvianPVT9.StandardRecipient[] memory recipients = new ProvianPVT9.StandardRecipient[](1);
        recipients[0] = ProvianPVT9.StandardRecipient({
            contributor: address(1), beneficiaryClass: ProvianPVT9.BeneficiaryClass.Unknown, claimCount: 1
        });
        ProvianPVT9.StandardPEClaim[] memory claims = new ProvianPVT9.StandardPEClaim[](1);
        claims[0] = ProvianPVT9.StandardPEClaim({claimId: bytes32(uint256(1)), recordPointsAtomic: 1 ether});
        vm.prank(MINTER);
        vm.expectRevert(ProvianPVT9.EpochZeroNotArmed.selector);
        fresh.settleStandardPEBatch(bytes32(uint256(1)), 0, bytes32(0), 0, 1, recipients, claims);
    }

    function testDefaultAgentRateNeedsNoBeneficiaryVerifierOrHumanLink() public {
        address autonomousAgent = address(0x1001);
        (bytes32 batchId,) = _settleStandard(autonomousAgent, ProvianPVT9.BeneficiaryClass.AutonomousAgent, 100 ether);
        ProvianPVT9.BatchRecord memory record = pvt.getBatchRecord(batchId);
        assertEq(record.grossInput, 100 ether);
        assertEq(record.totalMinted, 100 ether);
        assertEq(pvt.balanceOf(autonomousAgent), 99 ether);
        assertEq(pvt.balanceOf(PROVIAN_TREASURY), 0.5 ether);
        assertEq(pvt.balanceOf(FOUNDATION_TREASURY), 0.5 ether);
        assertEq(_policy(0).agentFoundationBps, 50);
        assertEq(_policy(0).beneficiaryVerifier.verifier, address(0));
    }

    function testHumanStandardSplitIsExact99005050Treatment() public {
        address human = address(0x1001);
        _settleStandard(human, ProvianPVT9.BeneficiaryClass.HumanResolving, 75 ether);
        assertEq(pvt.balanceOf(human), 74.25 ether);
        assertEq(pvt.balanceOf(PROVIAN_TREASURY), 0.375 ether);
        assertEq(pvt.balanceOf(FOUNDATION_TREASURY), 0.375 ether);
        assertEq(pvt.totalSupply(), 75 ether);
    }

    function testGenesisNominalGrantsUseExactGrossAndBypassMintRate() public {
        pvt = _deployAndArm(address(verifier), 2 ether, 0);
        vm.warp(epochStart);

        ProvianPVT9.GenesisRecipient[] memory recipients = new ProvianPVT9.GenesisRecipient[](3);
        recipients[0] = ProvianPVT9.GenesisRecipient({contributor: address(0x1001), claimCount: 1});
        recipients[1] = ProvianPVT9.GenesisRecipient({contributor: address(0x1002), claimCount: 1});
        recipients[2] = ProvianPVT9.GenesisRecipient({contributor: address(0x1003), claimCount: 1});

        ProvianPVT9.GenesisPEClaim[] memory claims = new ProvianPVT9.GenesisPEClaim[](3);
        claims[0] = _genesisClaim(1, 11, 21, pvt.GENESIS_HUMAN_SIGNUP(), 75 ether);
        claims[1] = _genesisClaim(2, 12, 22, pvt.GENESIS_AGENT_SIGNUP(), 75 ether);
        claims[2] = _genesisClaim(3, 13, 23, pvt.GENESIS_DEVICE_LINK(), 25 ether);

        bytes32 batchId = _batchId();
        bytes32 policyHash = _policy(0).policyHash;
        vm.prank(MINTER);
        pvt.settleGenesisPEBatch(batchId, 0, policyHash, 0, 3, recipients, claims);

        ProvianPVT9.BatchRecord memory record = pvt.getBatchRecord(batchId);
        assertEq(record.grossInput, 175 ether);
        assertEq(record.totalMinted, 175 ether);
        assertEq(pvt.balanceOf(address(0x1001)), 74.25 ether);
        assertEq(pvt.balanceOf(address(0x1002)), 74.25 ether);
        assertEq(pvt.balanceOf(address(0x1003)), 24.75 ether);
        assertEq(pvt.balanceOf(PROVIAN_TREASURY), 0.875 ether);
        assertEq(pvt.balanceOf(FOUNDATION_TREASURY), 0.875 ether);
    }

    function testGenesisAcceptsExactTaperedReservationButRejectsAboveNominal() public {
        _settleGenesis(
            address(0x1001), bytes32(uint256(1)), bytes32(uint256(2)), pvt.GENESIS_HUMAN_SIGNUP(), 74.9 ether
        );
        assertEq(pvt.genesisWalletGrossIssued(bytes32(uint256(1))), 74.9 ether);

        _expectGenesisRevert(
            ProvianPVT9.InvalidGenesisGrant.selector,
            address(0x1002),
            bytes32(uint256(3)),
            bytes32(uint256(4)),
            pvt.GENESIS_DEVICE_LINK(),
            25 ether + 1
        );
    }

    function testGenesisOneTimeAnchorCannotReplayUnderNewClaimOrWallet() public {
        bytes32 anchor = keccak256("device-anchor");
        _settleGenesis(address(0x1001), bytes32(uint256(1)), anchor, pvt.GENESIS_DEVICE_LINK(), 25 ether);
        uint256 cursor = pvt.nextFinalizedCursor();
        _expectGenesisRevert(
            ProvianPVT9.GenesisAnchorAlreadyUsed.selector,
            address(0x1002),
            bytes32(uint256(2)),
            anchor,
            pvt.GENESIS_DEVICE_LINK(),
            25 ether
        );
        assertEq(pvt.nextFinalizedCursor(), cursor);
    }

    function testGenesisWalletGrossCeilingAllowsExactly500AndRejectsNextGrant() public {
        bytes32 walletId = keccak256("wallet-at-ceiling");
        ProvianPVT9.GenesisRecipient[] memory recipients = new ProvianPVT9.GenesisRecipient[](1);
        recipients[0] = ProvianPVT9.GenesisRecipient({contributor: address(0x1001), claimCount: 16});
        ProvianPVT9.GenesisPEClaim[] memory claims = new ProvianPVT9.GenesisPEClaim[](16);
        claims[0] = _genesisClaim(1, uint256(walletId), 101, pvt.GENESIS_HUMAN_SIGNUP(), 75 ether);
        claims[1] = _genesisClaim(2, uint256(walletId), 102, pvt.GENESIS_AGENT_SIGNUP(), 75 ether);
        for (uint256 i = 2; i < 16; ++i) {
            claims[i] = _genesisClaim(i + 1, uint256(walletId), 101 + i, pvt.GENESIS_DEVICE_LINK(), 25 ether);
        }

        uint256 cursor = pvt.nextFinalizedCursor();
        bytes32 policyHash = _policy(0).policyHash;
        bytes32 batchId = _batchId();
        vm.prank(MINTER);
        pvt.settleGenesisPEBatch(batchId, 0, policyHash, cursor, cursor + 16, recipients, claims);
        assertEq(pvt.genesisWalletGrossIssued(walletId), 500 ether);

        _expectGenesisRevert(
            ProvianPVT9.GenesisWalletCeilingExceeded.selector,
            address(0x1001),
            walletId,
            keccak256("one-too-many"),
            pvt.GENESIS_DEVICE_LINK(),
            25 ether
        );
    }

    function testAdmissionClosePreservesPreCutoffBacklogAndRejectsLaterQualification() public {
        vm.warp(uint256(epochStart) + 1 days);
        vm.prank(ADMIN);
        pvt.closeGenesisAdmission();
        uint64 cutoff = pvt.genesisAdmissionCutoff();
        assertFalse(pvt.genesisAdmissionOpen());

        _settleGenesis(address(0x1001), bytes32(uint256(1)), bytes32(uint256(2)), pvt.GENESIS_HUMAN_SIGNUP(), 75 ether);

        ProvianPVT9.GenesisRecipient[] memory recipients = new ProvianPVT9.GenesisRecipient[](1);
        recipients[0] = ProvianPVT9.GenesisRecipient({contributor: address(0x1002), claimCount: 1});
        ProvianPVT9.GenesisPEClaim[] memory claims = new ProvianPVT9.GenesisPEClaim[](1);
        claims[0] = ProvianPVT9.GenesisPEClaim({
            claimId: _claimId(),
            walletId: bytes32(uint256(3)),
            oneTimeAnchor: bytes32(uint256(4)),
            grantType: pvt.GENESIS_AGENT_SIGNUP(),
            qualifiedAt: cutoff + 1,
            reservedGrossAtomic: 75 ether
        });
        bytes32 batchId = _batchId();
        bytes32 policyHash = _policy(0).policyHash;
        uint256 cursor = pvt.nextFinalizedCursor();
        vm.prank(MINTER);
        vm.expectRevert(ProvianPVT9.GenesisQualificationOutsideWindow.selector);
        pvt.settleGenesisPEBatch(batchId, 0, policyHash, cursor, cursor + 1, recipients, claims);
    }

    function testOperationalMinterHasNoPolicyAuthorityAndRevocationIsImmediate() public {
        vm.prank(MINTER);
        vm.expectRevert(ProvianPVT9.OnlyBootstrapAdmin.selector);
        pvt.scheduleMintRate(1, 2 ether);

        vm.prank(MINTER);
        vm.expectRevert(ProvianPVT9.OnlyBootstrapAdmin.selector);
        pvt.placeAdministrativeHold();

        vm.prank(ADMIN);
        pvt.revokeOperationalMinter();
        _expectStandardRevert(
            ProvianPVT9.OnlyOperationalMinter.selector, address(0x1001), ProvianPVT9.BeneficiaryClass.Unknown, 1 ether
        );

        vm.prank(ADMIN);
        pvt.appointOperationalMinter(address(0xCAFE));
        assertEq(pvt.operationalMinter(), address(0xCAFE));
        bytes32 policyHash = _policy(0).policyHash;
        vm.prank(MINTER);
        vm.expectRevert(ProvianPVT9.OnlyOperationalMinter.selector);
        pvt.settleStandardPEBatch(
            bytes32(uint256(1)),
            0,
            policyHash,
            100,
            101,
            new ProvianPVT9.StandardRecipient[](0),
            new ProvianPVT9.StandardPEClaim[](0)
        );
    }

    function testAdministrativeHoldIsFrankOnlyImmediateAndStatePreserving() public {
        _settleStandard(address(0x1001), ProvianPVT9.BeneficiaryClass.Unknown, 10 ether);
        uint256 supply = pvt.totalSupply();
        uint256 cursor = pvt.nextFinalizedCursor();
        uint256 issued = pvt.epochTotalIssued(0);

        vm.prank(ADMIN);
        pvt.placeAdministrativeHold();
        bytes32 policyHash = _policy(0).policyHash;
        vm.prank(address(0xCAFE));
        vm.expectRevert(ProvianPVT9.AdministrativeHoldActive.selector);
        pvt.settleStandardPEBatch(
            bytes32(uint256(77)),
            0,
            policyHash,
            cursor,
            cursor + 1,
            new ProvianPVT9.StandardRecipient[](0),
            new ProvianPVT9.StandardPEClaim[](0)
        );
        assertEq(pvt.totalSupply(), supply);
        assertEq(pvt.nextFinalizedCursor(), cursor);
        assertEq(pvt.epochTotalIssued(0), issued);

        vm.prank(MINTER);
        vm.expectRevert(ProvianPVT9.OnlyBootstrapAdmin.selector);
        pvt.resumeFromAdministrativeHold();
        vm.prank(ADMIN);
        pvt.resumeFromAdministrativeHold();
        _settleStandard(address(0x1002), ProvianPVT9.BeneficiaryClass.Unknown, 10 ether);
    }

    function testTreasuryRecipientHasNoAdministrativeAuthorityAndNoHandoffSelectorWorks() public {
        vm.prank(FOUNDATION_TREASURY);
        vm.expectRevert(ProvianPVT9.OnlyBootstrapAdmin.selector);
        pvt.scheduleAgentFoundationRate(1, 100);

        bytes4[8] memory prohibited = [
            bytes4(keccak256("transferAdmin(address)")),
            bytes4(keccak256("renounceAdmin()")),
            bytes4(keccak256("transferOwnership(address)")),
            bytes4(keccak256("renounceOwnership()")),
            bytes4(keccak256("setExecutor(address)")),
            bytes4(keccak256("setGovernanceContract(address)")),
            bytes4(keccak256("upgradeTo(address)")),
            bytes4(keccak256("changeAdmin(address)"))
        ];
        for (uint256 i = 0; i < prohibited.length; ++i) {
            vm.prank(ADMIN);
            (bool ok,) = address(pvt).call(abi.encodeWithSelector(prohibited[i], address(0xCAFE)));
            assertFalse(ok);
        }
        assertEq(pvt.BOOTSTRAP_ADMIN(), ADMIN);
    }

    function testERC20TransfersAllowancesAndHolderAuthorizedBurns() public {
        address holder = address(0x1001);
        address recipient = address(0x1002);
        address spender = address(0x1003);
        _settleStandard(holder, ProvianPVT9.BeneficiaryClass.Unknown, 100 ether);

        vm.prank(holder);
        pvt.transfer(recipient, 10 ether);
        vm.prank(recipient);
        pvt.approve(spender, 5 ether);
        vm.prank(spender);
        pvt.burnFrom(recipient, 5 ether);
        vm.prank(holder);
        pvt.burn(5 ether);

        assertEq(pvt.balanceOf(recipient), 5 ether);
        assertEq(pvt.balanceOf(holder), 84 ether);
        assertEq(pvt.totalSupply(), 90 ether);
    }

    function testBatchClaimAndCursorReplayFencesAreAtomic() public {
        (bytes32 settledBatch, bytes32 settledClaim) =
            _settleStandard(address(0x1001), ProvianPVT9.BeneficiaryClass.Unknown, 10 ether);
        uint256 cursor = pvt.nextFinalizedCursor();
        uint256 supply = pvt.totalSupply();

        ProvianPVT9.StandardRecipient[] memory recipients = new ProvianPVT9.StandardRecipient[](1);
        recipients[0] = ProvianPVT9.StandardRecipient({
            contributor: address(0x1002), beneficiaryClass: ProvianPVT9.BeneficiaryClass.Unknown, claimCount: 1
        });
        ProvianPVT9.StandardPEClaim[] memory claims = new ProvianPVT9.StandardPEClaim[](1);
        claims[0] = ProvianPVT9.StandardPEClaim({claimId: _claimId(), recordPointsAtomic: 1 ether});
        bytes32 policyHash = _policy(0).policyHash;

        vm.prank(MINTER);
        vm.expectRevert(ProvianPVT9.BatchAlreadySettled.selector);
        pvt.settleStandardPEBatch(settledBatch, 0, policyHash, cursor, cursor + 1, recipients, claims);

        claims[0].claimId = settledClaim;
        bytes32 replayClaimBatch = _batchId();
        vm.prank(MINTER);
        vm.expectRevert(ProvianPVT9.ClaimAlreadySettled.selector);
        pvt.settleStandardPEBatch(replayClaimBatch, 0, policyHash, cursor, cursor + 1, recipients, claims);

        claims[0].claimId = _claimId();
        bytes32 oversizedRangeBatch = _batchId();
        vm.prank(MINTER);
        vm.expectRevert(ProvianPVT9.ClaimRangeMismatch.selector);
        pvt.settleStandardPEBatch(oversizedRangeBatch, 0, policyHash, cursor, cursor + 2, recipients, claims);

        bytes32 overlapBatch = _batchId();
        vm.prank(MINTER);
        vm.expectRevert(ProvianPVT9.CursorDiscontinuity.selector);
        pvt.settleStandardPEBatch(overlapBatch, 0, policyHash, cursor - 1, cursor, recipients, claims);

        bytes32 gapBatch = _batchId();
        vm.prank(MINTER);
        vm.expectRevert(ProvianPVT9.CursorDiscontinuity.selector);
        pvt.settleStandardPEBatch(gapBatch, 0, policyHash, cursor + 1, cursor + 2, recipients, claims);
        bytes32 reversalBatch = _batchId();
        vm.prank(MINTER);
        vm.expectRevert(ProvianPVT9.InvalidCursorRange.selector);
        pvt.settleStandardPEBatch(reversalBatch, 0, policyHash, cursor, cursor, recipients, claims);
        assertEq(pvt.totalSupply(), supply);
        assertEq(pvt.nextFinalizedCursor(), cursor);
    }

    function testEligibilityFalseRevertAndMalformedAnswerFailClosedBeforeMint() public {
        verifier.setEligibilityResult(false);
        uint256 cursor = pvt.nextFinalizedCursor();
        _expectStandardRevert(
            ProvianPVT9.VerificationFailed.selector, address(0x1001), ProvianPVT9.BeneficiaryClass.Unknown, 10 ether
        );
        assertEq(pvt.totalSupply(), 0);
        assertEq(pvt.nextFinalizedCursor(), cursor);

        MalformedPVT9Verifier malformed = new MalformedPVT9Verifier();
        ProvianPVT9 malformedToken = _deployAndArm(address(malformed), 1 ether, 0);
        vm.warp(epochStart);
        ProvianPVT9.StandardRecipient[] memory recipients = new ProvianPVT9.StandardRecipient[](1);
        recipients[0] = ProvianPVT9.StandardRecipient({
            contributor: address(0x1001), beneficiaryClass: ProvianPVT9.BeneficiaryClass.Unknown, claimCount: 1
        });
        ProvianPVT9.StandardPEClaim[] memory claims = new ProvianPVT9.StandardPEClaim[](1);
        bytes32 claimId = bytes32(uint256(1));
        claims[0] = ProvianPVT9.StandardPEClaim({claimId: claimId, recordPointsAtomic: 10 ether});
        bytes32 malformedPolicyHash = malformedToken.getEpochPolicy(0).policyHash;
        vm.prank(MINTER);
        vm.expectRevert(ProvianPVT9.VerificationFailed.selector);
        malformedToken.settleStandardPEBatch(bytes32(uint256(2)), 0, malformedPolicyHash, 0, 1, recipients, claims);
        assertEq(malformedToken.totalSupply(), 0);
        assertFalse(malformedToken.claimSettled(claimId));
    }

    function _genesisClaim(uint256 claimId, uint256 walletId, uint256 anchor, uint8 grantType, uint256 amount)
        private
        view
        returns (ProvianPVT9.GenesisPEClaim memory)
    {
        return ProvianPVT9.GenesisPEClaim({
            claimId: bytes32(claimId),
            walletId: bytes32(walletId),
            oneTimeAnchor: bytes32(anchor),
            grantType: grantType,
            qualifiedAt: epochStart,
            reservedGrossAtomic: amount
        });
    }
}
