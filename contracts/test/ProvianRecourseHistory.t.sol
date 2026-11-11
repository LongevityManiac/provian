import {ProvianHashAccount} from "../src/ProvianHashAccount.sol";
import {ProvianRestorationAuthorization} from "../src/ProvianRestorationAuthorization.sol";
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {RecourseMembershipRules} from "../src/RecourseMembershipRules.sol";
import {RecourseIssuanceTickets} from "../src/RecourseIssuanceTickets.sol";
import {Test} from "forge-std/Test.sol";
import {ProvianRecourseKernel} from "../src/ProvianRecourseKernel.sol";
import {ProvianRecoveryHistory} from "../src/ProvianRecoveryHistory.sol";
import {ProvianHashAccount} from "../src/ProvianHashAccount.sol";
import {ProvianProtocolPointer} from "../src/ProvianProtocolPointer.sol";
import {RecourseMonthlyAccounting} from "../src/RecourseMonthlyAccounting.sol";
import {RecoursePoolHistory} from "../src/RecoursePoolHistory.sol";
import {ProvianMemberRecoursePool} from "../src/ProvianMemberRecoursePool.sol";
import {ProvianPVT9} from "../src/ProvianPVT9.sol";
import {MockPVT9Verifier} from "./ProvianPVT9TestBase.sol";
contract ProvianRecourseHistoryTest is Test {
    address constant ADMIN = 0xCa37a15A64213b2ACD1784ae3f8e6Cbd4600D9D3;
    ProvianRecourseKernel kernel;
    ProvianRecoveryHistory history;
    ProvianProtocolPointer pointer;
    function deployKernel(ProvianRecourseKernel.SuccessionConfig memory config) external returns (ProvianRecourseKernel) {
        vm.mockCall(config.registry, abi.encodeWithSignature("afterCryptographicBreak()"), abi.encode(config.afterCryptographicBreak));
        if (config.previousKernel == address(0x1234) || config.previousKernel == address(0x4567)) vm.mockCall(config.previousKernel, abi.encodeWithSignature("BOOTSTRAP_ADMIN()"), abi.encode(ADMIN));
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        config.authorization = new ProvianRestorationAuthorization(predicted, config.root, config.previousKernel,
            config.snapshotBlock, config.afterCryptographicBreak, keccak256(type(ProvianHashAccount).runtimeCode), 0);
        return new ProvianRecourseKernel(config);
    }
    function setUp() public {
        pointer = new ProvianProtocolPointer(address(new ProvianHashAccount(sha256("pointer signing root TEST ONLY"))));
        ProvianRecoveryHistory.State memory prior;
        prior.provianTreasury = address(0xA001); prior.foundationTreasury = address(0xA002);
        prior.eligibilityVerifier = ProvianPVT9.VerifierConfig(address(0xB001), keccak256("verifier TEST ONLY"), 1);
        prior.beneficiaryVerifier = ProvianPVT9.VerifierConfig(address(0xB002), keccak256("verifier TEST ONLY"), 1);
        vm.mockCall(address(0x1234), abi.encodeWithSignature("administrativeHold()"), abi.encode(true));
        vm.mockCall(address(0x1234), abi.encodeWithSignature("operationalMinter()"), abi.encode(address(0)));
        vm.mockCall(address(0xB001), abi.encodeWithSignature("administrativeHold()"), abi.encode(true));
        vm.mockCall(address(0xB001), abi.encodeWithSignature("batchApprover()"), abi.encode(address(0)));

        prior.epochZeroStartsAt = 1; prior.genesisStartsAt = 1; prior.genesisEndsAt = 100;
        prior.genesisClosed = true; prior.genesisCutoff = 100; prior.lastOpenedEpoch = 3;
        prior.nextCursor = 45; prior.mintRate = 1 ether; prior.agentFoundationBps = 100;
        prior.genesisCap = 7_500_000 ether; prior.combinedCap = 10_000_000 ether;
        prior.epochGenesisIssued = 500 ether; prior.epochTotalIssued = 1000 ether;
        prior.schedules = new ProvianRecoveryHistory.EconomicSchedule[](1);
        prior.schedules[0].epoch = 5;
        prior.schedules[0].mintRateSet = true; prior.schedules[0].mintRate = 2 ether;
        prior.schedules[0].foundationRateSet = true; prior.schedules[0].foundationRate = 200;
        prior.schedules[0].capsSet = true; prior.schedules[0].genesisCap = 6_000_000 ether; prior.schedules[0].combinedCap = 9_000_000 ether;
        prior.schedules[0].treasuriesSet = true;
        prior.schedules[0].provianTreasury = address(0xC001); prior.schedules[0].foundationTreasury = address(0xC002);
        prior.schedules[0].beneficiaryVerifierSet = true;
        prior.schedules[0].beneficiaryVerifier = ProvianPVT9.VerifierConfig(address(0xD001), keccak256("next beneficiary TEST ONLY"), 2);
        prior.schedules[0].eligibilityVerifierSet = true;
        prior.schedules[0].eligibilityVerifier = ProvianPVT9.VerifierConfig(address(0xD002), keccak256("next eligibility TEST ONLY"), 3);
        prior.epochs = new ProvianRecoveryHistory.HistoricalEpoch[](3);
        for (uint64 i; i < 3; ++i) {
            ProvianPVT9.EpochPolicy memory p;
            p.opened = true; p.epoch = i; p.startsAt = 1 + i * 7 days;
            p.combinedCapMode = ProvianPVT9.CombinedCapMode.Fixed;
            p.mintRate = 1 ether; p.genesisCap = 7_500_000 ether; p.combinedCap = 10_000_000 ether;
            p.policyHash = sha256(abi.encode("predecessor policy TEST ONLY", i));
            prior.epochs[i] = ProvianRecoveryHistory.HistoricalEpoch(p, (uint256(i) + 1) * 10 ether, (uint256(i) + 1) * 100 ether);
        }
        bytes32 root = sha256(abi.encode("Provian monetary history", address(0x1234), uint256(100), uint8(0), bytes32(uint256(42)), uint256(1)));
        history = new ProvianRecoveryHistory(address(0x1234), 100, root, 1, prior);
        kernel = this.deployKernel(ProvianRecourseKernel.SuccessionConfig(ADMIN, bytes32(uint256(1)), address(0x1234), 100, 0, history, pointer, address(this), false, ProvianRestorationAuthorization(address(0))));
        ProvianMemberRecoursePool pool = new ProvianMemberRecoursePool(ProvianPVT9(address(kernel)), address(this), address(this), pointer, RecourseMembershipRules.MonthlyRule(0, 100 ether, 100 ether, 100, sha256("signed rule TEST ONLY")), RecoursePoolHistory.PoolSnapshot(address(0), 0, bytes32(0), 0, false));
        address[10] memory targets; bytes32[10] memory hashes;
        for (uint256 i; i < 10; ++i) { targets[i] = address(uint160(100+i)); vm.etch(targets[i], hex"00"); }
        targets[0] = address(kernel); targets[8] = address(pool); targets[9] = address(pool.settlement());
        for (uint256 i; i < 10; ++i) hashes[i] = targets[i].codehash;
        vm.prank(pointer.authority()); pointer.publish(0, targets, hashes);
    }
    function testHistoryImportsOnceAndPreservesClockUsageAndSchedules() public {
        assertFalse(history.complete());
        history.importEntry(0, bytes32(uint256(42)), 1, new bytes32[](0));
        assertTrue(history.complete()); assertTrue(kernel.claimSettled(bytes32(uint256(42))));
        assertFalse(kernel.claimSettled(bytes32(uint256(43))));
        assertEq(kernel.epochZeroStartsAt(), 1); assertEq(kernel.lastOpenedEpoch(), 3);
        assertEq(kernel.nextFinalizedCursor(), 45); assertEq(kernel.epochTotalIssued(3), 1000 ether);
        assertEq(kernel.epochGenesisIssued(3), 500 ether); assertTrue(kernel.genesisAdmissionClosed());
        assertEq(kernel.genesisAdmissionCutoff(), 100);
        (bool exists, uint256 rate) = kernel.scheduledMintRates(5); assertTrue(exists); assertEq(rate, 2 ether);
        (bool treasurySet, address company, address foundation) = kernel.scheduledTreasuries(5);
        assertTrue(treasurySet); assertEq(company, address(0xC001)); assertEq(foundation, address(0xC002));
        assertEq(kernel.getScheduledBeneficiaryVerifier(5).config.verifier, address(0xD001));
        assertEq(kernel.getScheduledEligibilityVerifier(5).config.verifier, address(0xD002));
        assertEq(kernel.getScheduledEligibilityVerifier(5).config.version, 3);
        for (uint64 i; i < 3; ++i) {
            assertEq(kernel.epochTotalIssued(i), (uint256(i) + 1) * 100 ether);
            assertEq(kernel.epochGenesisIssued(i), (uint256(i) + 1) * 10 ether);
            assertEq(kernel.getEpochPolicy(i).policyHash, sha256(abi.encode("predecessor policy TEST ONLY", i)));
        }
        // Institutional calculations use all earlier issuance, not only the
        // imported active epoch. RED: omitting the historical copy yields 1000/12.
        assertEq(kernel.trailingAverageForEpoch(12), uint256(1600 ether) / 12);
        vm.expectRevert(ProvianRecoveryHistory.InvalidHistory.selector);
        history.importEntry(0, bytes32(uint256(42)), 1, new bytes32[](0));
        vm.expectRevert(ProvianRecoveryHistory.InvalidHistory.selector);
        history.importEntry(0, bytes32(uint256(43)), 1, new bytes32[](0));
    }
    function testSettlementCannotRemintPredecessorClaimOrReopenGenesis() public {
        vm.warp(1 + 3 * 7 days + 1 hours);
        bytes32 id = keccak256("verifier TEST ONLY");
        MockPVT9Verifier verifier = new MockPVT9Verifier(id, 1, id, 1);
        ProvianRecourseKernel.VerifierConfig memory config = ProvianRecourseKernel.VerifierConfig(address(verifier), id, 1);
        ProvianRecourseKernel.EpochZeroConfig memory arming = ProvianRecourseKernel.EpochZeroConfig(
            1, 1, 100, 1 ether, address(0xA001), address(0xA002), config, 45,
            ProvianRecourseKernel.CombinedCapMode.Fixed, 7_500_000 ether, 10_000_000 ether);
        vm.startPrank(ADMIN);
        kernel.appointOperationalMinter(address(this)); kernel.installRecoveredBeneficiaryVerifier(config);
        vm.expectRevert(ProvianRecourseKernel.InvalidRestoration.selector); kernel.armEpochZero(arming);
        vm.stopPrank();
        history.importEntry(0, bytes32(uint256(42)), 1, new bytes32[](0));
        vm.prank(ADMIN); kernel.armEpochZero(arming);
        assertFalse(kernel.genesisAdmissionOpen());
        ProvianRecourseKernel.StandardRecipient[] memory recipients = new ProvianRecourseKernel.StandardRecipient[](1);
        recipients[0] = ProvianRecourseKernel.StandardRecipient(address(0x9876), ProvianRecourseKernel.BeneficiaryClass.AutonomousAgent, 1);
        ProvianRecourseKernel.StandardPEClaim[] memory claims = new ProvianRecourseKernel.StandardPEClaim[](1);
        claims[0] = ProvianRecourseKernel.StandardPEClaim(bytes32(uint256(42)), 1 ether);
        bytes32 policyHash = kernel.getEpochPolicy(3).policyHash;
        vm.expectRevert(ProvianRecourseKernel.ClaimAlreadySettled.selector);
        kernel.settleStandardPEBatch(bytes32(uint256(1)), 3, policyHash, 45, 46, recipients, claims);
        assertEq(kernel.totalSupply(), 0);
        claims[0].claimId = bytes32(uint256(43));
        ProvianMemberRecoursePool pool = ProvianMemberRecoursePool(pointer.component(8));
        address adapter=address(pool.settlement());
        vm.prank(ADMIN);kernel.appointOperationalMinter(adapter);
        vm.mockCall(address(this),abi.encodeWithSignature("identityAttestor()"),abi.encode(vm.addr(2)));
        (ProvianPVT9.StandardRecipient[] memory typedRecipients,ProvianPVT9.StandardPEClaim[] memory typedClaims)=
            abi.decode(abi.encode(recipients,claims),(ProvianPVT9.StandardRecipient[],ProvianPVT9.StandardPEClaim[]));
        ProvianPVT9 typed=ProvianPVT9(address(kernel));
        bytes32 digest=typed.computeSettlementDigest(ProvianPVT9.SettlementLane.StandardPE,bytes32(uint256(1)),3,policyHash,45,46,
            typed.hashStandardClaims(typedRecipients,typedClaims));
        uint256 month=pool.calendarMonth(block.timestamp);
        RecourseIssuanceTickets.IssuanceContext memory context=RecourseIssuanceTickets.IssuanceContext(bytes32(uint256(1)),0,3,
            policyHash,digest,1,month,pool.monthlyRule(month).signedRuleHash);
        RecourseIssuanceTickets.IssuanceTicket[] memory tickets=new RecourseIssuanceTickets.IssuanceTicket[](1);
        tickets[0]=RecourseIssuanceTickets.IssuanceTicket(address(0x9876),1 ether,0.985 ether,0,0,false);
        (uint8 v,bytes32 r,bytes32 s)=vm.sign(2,pool.issuanceDigest(context,tickets));
        pool.settlement().settleMemberBatch(abi.encodeCall(ProvianPVT9.settleStandardPEBatch,
            (bytes32(uint256(1)),3,policyHash,45,46,typedRecipients,typedClaims)),context,tickets,abi.encodePacked(r,s,v));
        assertEq(kernel.balanceOf(address(0x9876)), 0.985 ether);
        assertEq(kernel.epochTotalIssued(3), 1001 ether); assertEq(kernel.epochGenesisIssued(3), 500 ether);
    }
    function testSnapshotAndPredecessorCannotBeSubstituted() public {
        vm.expectRevert(ProvianRecourseKernel.InvalidRestoration.selector);
        this.deployKernel(ProvianRecourseKernel.SuccessionConfig(ADMIN, bytes32(uint256(1)), address(0x1234), 101, 0, history, pointer, address(this), false, ProvianRestorationAuthorization(address(0))));
        vm.expectRevert(ProvianRecourseKernel.InvalidRestoration.selector);
        this.deployKernel(ProvianRecourseKernel.SuccessionConfig(ADMIN, bytes32(uint256(1)), address(0x4567), 100, 0, history, pointer, address(this), false, ProvianRestorationAuthorization(address(0))));
        vm.expectRevert(ProvianRecourseKernel.InvalidRestoration.selector);
        this.deployKernel(ProvianRecourseKernel.SuccessionConfig(ADMIN, bytes32(uint256(1)), address(0x1234), 100, 0, history, pointer, address(this), true, ProvianRestorationAuthorization(address(0))));
    }
    function testArmingRefusesChangedEconomicsDestinationsOrLivePredecessor() public {
        ProvianPVT9.VerifierConfig memory verifier = ProvianPVT9.VerifierConfig(address(0xB003), keccak256("verifier TEST ONLY"), 1);
        ProvianPVT9.EpochZeroConfig memory config = ProvianPVT9.EpochZeroConfig(1, 1, 100, 1 ether,
            address(0xA001), address(0xA002), verifier, 45, ProvianPVT9.CombinedCapMode.Fixed, 7_500_000 ether, 10_000_000 ether);
        assertTrue(history.validArming(config, verifier));
        config.provianTreasury = address(0xBAD); assertFalse(history.validArming(config, verifier));
        config.provianTreasury = address(0xA001);
        config.initialFinalizedCursor = 44; assertFalse(history.validArming(config, verifier)); config.initialFinalizedCursor = 45;
        config.eligibilityVerifier.version = 2; assertFalse(history.validArming(config, verifier)); config.eligibilityVerifier.version = 1;
        vm.mockCall(address(0x1234), abi.encodeWithSignature("administrativeHold()"), abi.encode(false));
        assertFalse(history.validArming(config, verifier));
        vm.mockCall(address(0x1234), abi.encodeWithSignature("administrativeHold()"), abi.encode(true));
        vm.mockCall(address(0x1234), abi.encodeWithSignature("operationalMinter()"), abi.encode(address(0xBAD)));
        assertFalse(history.validArming(config, verifier));
        vm.mockCall(address(0x1234), abi.encodeWithSignature("operationalMinter()"), abi.encode(address(0)));
        vm.mockCall(address(0xB001), abi.encodeWithSignature("batchApprover()"), abi.encode(address(0xBAD)));
        assertFalse(history.validArming(config, verifier));
    }
    function testHistoricalEpochOmissionAndInflatedIssuanceAreRejected() public {
        ProvianRecoveryHistory.State memory prior = history.state();
        prior.epochs = new ProvianRecoveryHistory.HistoricalEpoch[](0);
        vm.expectRevert(ProvianRecoveryHistory.InvalidHistory.selector);
        new ProvianRecoveryHistory(address(0x1234), 100, bytes32(uint256(1)), 0, prior);
        prior = history.state(); prior.epochs[1].totalIssued = prior.epochs[1].policy.combinedCap + 1;
        vm.expectRevert(ProvianRecoveryHistory.InvalidHistory.selector);
        new ProvianRecoveryHistory(address(0x1234), 100, bytes32(uint256(1)), 0, prior);
    }
    function testHistoricalBatchReceiptIsExactAndCannotBeSubstitutedOrReimported() public {
        ProvianPVT9.BatchRecord memory record;
        record.settled = true; record.epoch = 2; record.finalizedCursorStart = 40; record.finalizedCursorEnd = 45;
        record.totalMinted = 2 ether; record.contributorTotal = 1.98 ether;
        record.provianTotal = 0.01 ether; record.foundationTotal = 0.01 ether;
        record.policyHash = sha256("historical policy TEST ONLY"); record.settlementDigest = sha256("historical settlement TEST ONLY");
        bytes32 id = sha256("old batch TEST ONLY");
        bytes32 root = sha256(abi.encode("Provian settlement history", address(0x1234), uint256(100), id, sha256(abi.encode(record))));
        ProvianRecoveryHistory copy = new ProvianRecoveryHistory(address(0x1234), 100, root, 1, history.state());
        ProvianRecourseKernel next = this.deployKernel(ProvianRecourseKernel.SuccessionConfig(ADMIN,
            bytes32(uint256(1)), address(0x1234), 100, 0, copy, pointer, address(this), false, ProvianRestorationAuthorization(address(0))));
        assertFalse(next.getBatchRecord(id).settled);
        record.settlementDigest = bytes32(uint256(1));
        vm.expectRevert(ProvianRecoveryHistory.InvalidHistory.selector); copy.importBatch(id, record, new bytes32[](0));
        record.settlementDigest = sha256("historical settlement TEST ONLY");
        copy.importBatch(id, record, new bytes32[](0));
        assertEq(abi.encode(next.getBatchRecord(id)), abi.encode(record)); assertTrue(copy.batchUsed(id)); assertTrue(copy.complete());
        vm.expectRevert(ProvianRecoveryHistory.InvalidHistory.selector); copy.importBatch(id, record, new bytes32[](0));
    }
}
