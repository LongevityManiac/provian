// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import "../src/ProvianRecourseCourt.sol";
import {ProvianRecourseEscrow} from "../src/ProvianRecourseEscrow.sol";
import "../src/ProvianRecourseBondPool.sol";
import "./MockTokens.sol";
import "./MockEpochClock.sol";
import "./MockIssuanceIndex.sol";

contract RecourseMockEscrowV3 {
    struct PartySet { address depositor; address recipient; bool set; bool shouldRevert; }
    struct ResolveCall { bytes32 escrowId; bool releaseToRecipient; }

    mapping(bytes32 => PartySet) public partiesByEscrow;
    ResolveCall[] public resolveCalls;

    function setParties(bytes32 escrowId, address depositor, address recipient) external {
        partiesByEscrow[escrowId] = PartySet(depositor, recipient, true, false);
    }

    function setPartiesRevert(bytes32 escrowId) external {
        partiesByEscrow[escrowId] = PartySet(address(0), address(0), false, true);
    }

    function getParties(bytes32 escrowId) external view returns (address depositor, address recipient) {
        PartySet memory p = partiesByEscrow[escrowId];
        if (p.shouldRevert) revert("RecourseMockEscrowV3: forced revert");
        return (p.depositor, p.recipient);
    }

    mapping(bytes32 => uint256) public disputeSettledAt;

    function resolveDispute(bytes32 escrowId, bool releaseToRecipient) external {
        resolveCalls.push(ResolveCall(escrowId, releaseToRecipient));
        disputeSettledAt[escrowId] = block.timestamp;
    }

    function settleOutsideCourt(bytes32 escrowId) external {
        disputeSettledAt[escrowId] = block.timestamp;
    }

    function resolveCallCount() external view returns (uint256) {
        return resolveCalls.length;
    }

    function lastResolveCall() external view returns (bytes32 escrowId, bool release) {
        require(resolveCalls.length > 0, "no calls");
        ResolveCall memory c = resolveCalls[resolveCalls.length - 1];
        return (c.escrowId, c.releaseToRecipient);
    }
}

contract RecourseProvianRecourseCourtTest is Test {
    ProvianRecourseCourt public court;
    RecourseMockEscrowV3 public escrow;

    MockPVT public pvt;

    address public admin = address(0xA01);
    address public newAdmin = address(0xA02);
    address public depositor = address(0xB01);
    address public recipient = address(0xB02);
    address public arb1 = address(0xC01);
    address public arb2 = address(0xC02);
    address public arb3 = address(0xC03);
    address public outsider = address(0xD01);

    bytes32 public constant ESCROW_ID = keccak256("escrow-1");

    uint256 public constant VOTING_WINDOW = 48 hours;

    uint256 public constant ADJ_FEE = 30e18;

    function setUp() public {
        escrow = new RecourseMockEscrowV3();
        pvt = new MockPVT();
        court = new ProvianRecourseCourt(admin, address(escrow), address(new MockEpochClock(0)), address(pvt), address(new MockIssuanceIndex()));

        escrow.setParties(ESCROW_ID, depositor, recipient);

        address[4] memory arbs = [arb1, arb2, arb3, outsider];
        for (uint256 i = 0; i < arbs.length; i++) {
            pvt.mint(arbs[i], 1_000_000e18);
            vm.prank(arbs[i]);
            pvt.approve(address(court), type(uint256).max);
        }

        _fundAdj(court, address(escrow), ESCROW_ID);
    }

    function _fundAdj(ProvianRecourseCourt c, address escrowAddr, bytes32 escrowId) internal {
        pvt.mint(address(c), ADJ_FEE);
        vm.prank(escrowAddr);
        c.fundEscrowDisputeReward(escrowId, ADJ_FEE);
    }

    function _postAll(bytes32 escrowId, address[3] memory panel) internal {
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(panel[i]);
            court.postEscrowCollateral(escrowId);
        }
    }

    function _validPanel() internal view returns (address[3] memory) {
        return [arb1, arb2, arb3];
    }

    function _assignDefaultPanel() internal {
        _assignDefaultPanelUnposted();
        _postAll(ESCROW_ID, _validPanel());
    }

    function _assignDefaultPanelUnposted() internal {
        vm.prank(admin);
        court.assignPanel(ESCROW_ID, _validPanel());
    }

    function test_constructor_setsAllAddresses() public view {
        assertEq(court.admin(), admin);
        assertEq(address(court.escrowContract()), address(escrow));
    }

    function test_constructor_rejectsZeroAdmin() public {
        address clk = address(new MockEpochClock(0));
        address idx = address(new MockIssuanceIndex());
        vm.expectRevert(ProvianRecourseCourt.InvalidAddress.selector);
        new ProvianRecourseCourt(address(0), address(escrow), clk, address(pvt), idx);
    }

    function test_constructor_rejectsZeroEscrow() public {
        address clk = address(new MockEpochClock(0));
        address idx = address(new MockIssuanceIndex());
        vm.expectRevert(ProvianRecourseCourt.InvalidAddress.selector);
        new ProvianRecourseCourt(admin, address(0), clk, address(pvt), idx);
    }

    function test_constructor_rejectsZeroEpochClock() public {
        address idx = address(new MockIssuanceIndex());
        vm.expectRevert(ProvianRecourseCourt.InvalidAddress.selector);
        new ProvianRecourseCourt(admin, address(escrow), address(0), address(pvt), idx);
    }

    function test_constructor_rejectsZeroPvt() public {
        address clk = address(new MockEpochClock(0));
        address idx = address(new MockIssuanceIndex());
        vm.expectRevert(ProvianRecourseCourt.InvalidAddress.selector);
        new ProvianRecourseCourt(admin, address(escrow), clk, address(0), idx);
    }

    function test_constructor_rejectsZeroIssuanceIndex() public {
        address clk = address(new MockEpochClock(0));
        vm.expectRevert(ProvianRecourseCourt.InvalidAddress.selector);
        new ProvianRecourseCourt(admin, address(escrow), clk, address(pvt), address(0));
    }

    function test_assignPanel_onlyAdmin() public {
        vm.prank(outsider);
        vm.expectRevert(ProvianRecourseCourt.OnlyAdmin.selector);
        court.assignPanel(ESCROW_ID, _validPanel());
    }

    function test_resolveEscalatedDispute_onlyAdmin() public {
        _assignDefaultPanel();
        vm.warp(block.timestamp + VOTING_WINDOW + 1);
        court.escalateDispute(ESCROW_ID);
        vm.prank(outsider);
        vm.expectRevert(ProvianRecourseCourt.OnlyAdmin.selector);
        court.resolveEscalatedDispute(ESCROW_ID, true);
    }

    function test_transferAdmin_rotates() public {
        vm.prank(admin);
        court.transferAdmin(newAdmin);
        assertEq(court.admin(), newAdmin);

        vm.prank(admin);
        vm.expectRevert(ProvianRecourseCourt.OnlyAdmin.selector);
        court.assignPanel(ESCROW_ID, _validPanel());
    }

    function test_transferAdmin_rejectsZero() public {
        vm.prank(admin);
        vm.expectRevert(ProvianRecourseCourt.InvalidAddress.selector);
        court.transferAdmin(address(0));
    }

    function test_assignPanel_happyPath_setsState() public {

        vm.expectEmit(true, false, false, true, address(court));
        emit ProvianRecourseCourt.PanelAssigned(ESCROW_ID, arb1, arb2, arb3, 0);
        vm.prank(admin);
        court.assignPanel(ESCROW_ID, _validPanel());

        assertTrue(court.disputeExists(ESCROW_ID));
        address[3] memory panel = court.getPanel(ESCROW_ID);
        assertEq(panel[0], arb1);
        assertEq(panel[1], arb2);
        assertEq(panel[2], arb3);
        assertEq(uint8(court.getDisputeStatus(ESCROW_ID)), uint8(ProvianRecourseCourt.DisputeStatus.Pending));
        assertEq(court.getVotingDeadline(ESCROW_ID), 0, "unarmed until the panel is seated");

        _postAll(ESCROW_ID, _validPanel());
        assertEq(court.getVotingDeadline(ESCROW_ID), block.timestamp + VOTING_WINDOW);
    }

    function test_assignPanel_rejectsZeroAddress() public {
        address[3] memory bad = [address(0), arb2, arb3];
        vm.prank(admin);
        vm.expectRevert(ProvianRecourseCourt.InvalidAddress.selector);
        court.assignPanel(ESCROW_ID, bad);

        bad = [arb1, address(0), arb3];
        vm.prank(admin);
        vm.expectRevert(ProvianRecourseCourt.InvalidAddress.selector);
        court.assignPanel(ESCROW_ID, bad);

        bad = [arb1, arb2, address(0)];
        vm.prank(admin);
        vm.expectRevert(ProvianRecourseCourt.InvalidAddress.selector);
        court.assignPanel(ESCROW_ID, bad);
    }

    function test_assignPanel_rejectsDuplicateArbitrators() public {

        address[3] memory p1 = [arb1, arb1, arb3];
        vm.prank(admin);
        vm.expectRevert(ProvianRecourseCourt.DuplicateArbitrator.selector);
        court.assignPanel(ESCROW_ID, p1);

        address[3] memory p2 = [arb1, arb2, arb1];
        vm.prank(admin);
        vm.expectRevert(ProvianRecourseCourt.DuplicateArbitrator.selector);
        court.assignPanel(ESCROW_ID, p2);

        address[3] memory p3 = [arb1, arb2, arb2];
        vm.prank(admin);
        vm.expectRevert(ProvianRecourseCourt.DuplicateArbitrator.selector);
        court.assignPanel(ESCROW_ID, p3);
    }

    function test_assignPanel_rejectsDepositorAsPanelist() public {
        address[3] memory bad = [depositor, arb2, arb3];
        vm.prank(admin);
        vm.expectRevert(ProvianRecourseCourt.ArbitratorIsParty.selector);
        court.assignPanel(ESCROW_ID, bad);
    }

    function test_assignPanel_rejectsRecipientAsPanelist() public {
        address[3] memory bad = [arb1, recipient, arb3];
        vm.prank(admin);
        vm.expectRevert(ProvianRecourseCourt.ArbitratorIsParty.selector);
        court.assignPanel(ESCROW_ID, bad);
    }

    function test_assignPanel_rejectsExistingDispute() public {
        _assignDefaultPanel();
        vm.prank(admin);
        vm.expectRevert(ProvianRecourseCourt.DisputeAlreadyExists.selector);
        court.assignPanel(ESCROW_ID, _validPanel());
    }

    function test_assignPanel_propagatesEscrowGetPartiesRevert() public {

        bytes32 badEscrow = keccak256("getParties-reverts");
        escrow.setPartiesRevert(badEscrow);
        _fundAdj(court, address(escrow), badEscrow);
        vm.prank(admin);
        vm.expectRevert("RecourseMockEscrowV3: forced revert");
        court.assignPanel(badEscrow, _validPanel());
    }

    function test_castVote_happyPath_emitsEvent() public {
        _assignDefaultPanel();
        vm.expectEmit(true, true, false, true, address(court));
        emit ProvianRecourseCourt.VoteCast(ESCROW_ID, arb1, true);
        vm.prank(arb1);
        court.castVote(ESCROW_ID, true);

        (uint8 forRelease, uint8 forRefund) = court.getVoteCounts(ESCROW_ID);
        assertEq(forRelease, 1);
        assertEq(forRefund, 0);
        assertTrue(court.hasArbitratorVoted(ESCROW_ID, arb1));
    }

    function test_castVote_rejectsNonPanelist() public {
        _assignDefaultPanel();
        vm.prank(outsider);
        vm.expectRevert(ProvianRecourseCourt.NotPanelMember.selector);
        court.castVote(ESCROW_ID, true);
    }

    function test_castVote_rejectsDoubleVote() public {
        _assignDefaultPanel();
        vm.prank(arb1);
        court.castVote(ESCROW_ID, true);
        vm.prank(arb1);
        vm.expectRevert(ProvianRecourseCourt.AlreadyVoted.selector);
        court.castVote(ESCROW_ID, false);
    }

    function test_castVote_rejectsAfterDeadline() public {
        _assignDefaultPanel();
        vm.warp(block.timestamp + VOTING_WINDOW + 1);
        vm.prank(arb1);
        vm.expectRevert(ProvianRecourseCourt.VotingClosed.selector);
        court.castVote(ESCROW_ID, true);
    }

    function test_castVote_acceptsAtExactDeadline() public {

        _assignDefaultPanel();
        uint256 deadline = court.getVotingDeadline(ESCROW_ID);
        vm.warp(deadline);
        vm.prank(arb1);
        court.castVote(ESCROW_ID, true);
        (uint8 forRelease,) = court.getVoteCounts(ESCROW_ID);
        assertEq(forRelease, 1);
    }

    function test_castVote_rejectsUnknownDispute() public {
        vm.prank(arb1);
        vm.expectRevert(ProvianRecourseCourt.DisputeNotFound.selector);
        court.castVote(keccak256("never-assigned"), true);
    }

    function test_castVote_rejectsOnResolvedDispute() public {
        _assignDefaultPanel();
        vm.prank(arb1);
        court.castVote(ESCROW_ID, true);
        vm.prank(arb2);
        court.castVote(ESCROW_ID, true);
        vm.prank(arb3);
        vm.expectRevert(ProvianRecourseCourt.DisputeNotPending.selector);
        court.castVote(ESCROW_ID, false);
    }

    function test_castVote_twoForRelease_autoResolvesRelease() public {
        _assignDefaultPanel();
        vm.prank(arb1);
        court.castVote(ESCROW_ID, true);
        vm.expectEmit(true, false, false, true, address(court));
        emit ProvianRecourseCourt.Verdict(ESCROW_ID, true, 2, 0);
        vm.prank(arb2);
        court.castVote(ESCROW_ID, true);

        assertEq(uint8(court.getDisputeStatus(ESCROW_ID)), uint8(ProvianRecourseCourt.DisputeStatus.Resolved));
        assertEq(escrow.resolveCallCount(), 1);
        (bytes32 id, bool release) = escrow.lastResolveCall();
        assertEq(id, ESCROW_ID);
        assertTrue(release);
    }

    function test_castVote_twoForRefund_autoResolvesRefund() public {
        _assignDefaultPanel();
        vm.prank(arb1);
        court.castVote(ESCROW_ID, false);
        vm.prank(arb2);
        court.castVote(ESCROW_ID, false);

        assertEq(uint8(court.getDisputeStatus(ESCROW_ID)), uint8(ProvianRecourseCourt.DisputeStatus.Resolved));
        (, bool release) = escrow.lastResolveCall();
        assertFalse(release);
    }

    function test_castVote_splitVote_thirdBreaksTie() public {
        _assignDefaultPanel();
        vm.prank(arb1);
        court.castVote(ESCROW_ID, true);
        vm.prank(arb2);
        court.castVote(ESCROW_ID, false);

        assertEq(uint8(court.getDisputeStatus(ESCROW_ID)), uint8(ProvianRecourseCourt.DisputeStatus.Pending));
        assertEq(escrow.resolveCallCount(), 0);

        vm.prank(arb3);
        court.castVote(ESCROW_ID, true);

        assertEq(uint8(court.getDisputeStatus(ESCROW_ID)), uint8(ProvianRecourseCourt.DisputeStatus.Resolved));
        (, bool release) = escrow.lastResolveCall();
        assertTrue(release);
    }

    function test_castVote_singleVoteDoesNotResolve() public {
        _assignDefaultPanel();
        vm.prank(arb1);
        court.castVote(ESCROW_ID, true);
        assertEq(uint8(court.getDisputeStatus(ESCROW_ID)), uint8(ProvianRecourseCourt.DisputeStatus.Pending));
        assertEq(escrow.resolveCallCount(), 0);
    }

    function test_escalateDispute_happyPath() public {
        _assignDefaultPanel();
        vm.warp(block.timestamp + VOTING_WINDOW + 1);
        vm.expectEmit(true, false, false, false, address(court));
        emit ProvianRecourseCourt.Escalated(ESCROW_ID);
        court.escalateDispute(ESCROW_ID);

        assertEq(uint8(court.getDisputeStatus(ESCROW_ID)), uint8(ProvianRecourseCourt.DisputeStatus.Escalated));
    }

    function test_escalateDispute_rejectsBeforeDeadline() public {
        _assignDefaultPanel();
        vm.expectRevert(ProvianRecourseCourt.VotingNotExpired.selector);
        court.escalateDispute(ESCROW_ID);
    }

    function test_escalateDispute_rejectsAlreadyResolved() public {
        _assignDefaultPanel();
        vm.prank(arb1);
        court.castVote(ESCROW_ID, true);
        vm.prank(arb2);
        court.castVote(ESCROW_ID, true);
        vm.warp(block.timestamp + VOTING_WINDOW + 1);
        vm.expectRevert(ProvianRecourseCourt.DisputeNotPending.selector);
        court.escalateDispute(ESCROW_ID);
    }

    function test_escalateDispute_rejectsDoubleEscalate() public {
        _assignDefaultPanel();
        vm.warp(block.timestamp + VOTING_WINDOW + 1);
        court.escalateDispute(ESCROW_ID);
        vm.expectRevert(ProvianRecourseCourt.DisputeNotPending.selector);
        court.escalateDispute(ESCROW_ID);
    }

    function test_escalateDispute_rejectsUnknown() public {
        vm.expectRevert(ProvianRecourseCourt.DisputeNotFound.selector);
        court.escalateDispute(keccak256("never"));
    }

    function test_resolveEscalatedDispute_happyPath() public {
        _assignDefaultPanel();
        vm.warp(block.timestamp + VOTING_WINDOW + 1);
        court.escalateDispute(ESCROW_ID);

        vm.prank(admin);
        court.resolveEscalatedDispute(ESCROW_ID, false);

        assertEq(uint8(court.getDisputeStatus(ESCROW_ID)), uint8(ProvianRecourseCourt.DisputeStatus.Resolved));
        assertEq(escrow.resolveCallCount(), 1);
        (, bool release) = escrow.lastResolveCall();
        assertFalse(release);
    }

    function test_resolveEscalatedDispute_rejectsNonEscalated() public {
        _assignDefaultPanel();
        vm.prank(admin);
        vm.expectRevert(bytes("Not escalated"));
        court.resolveEscalatedDispute(ESCROW_ID, true);
    }

    bytes4 internal constant SLASH_AGENT_REPUTATION_SELECTOR =
        bytes4(keccak256("slashAgentReputation(bytes32,address,uint256,address)"));

    bytes4 internal constant PVT_GETTER_SELECTOR = bytes4(keccak256("pvt()"));

    function _runtimeContainsSelector(address who, bytes4 selector) internal view returns (bool) {
        bytes memory code = who.code;
        if (code.length < 4) return false;
        for (uint256 i = 0; i + 4 <= code.length; i++) {
            if (
                code[i] == selector[0] && code[i + 1] == selector[1] &&
                code[i + 2] == selector[2] && code[i + 3] == selector[3]
            ) return true;
        }
        return false;
    }

    function _resolveDispute() internal {
        _assignDefaultPanel();
        vm.prank(arb1);
        court.castVote(ESCROW_ID, true);
        vm.prank(arb2);
        court.castVote(ESCROW_ID, true);
    }

    function test_noReputationSlash_selectorNotDispatched() public {

        _resolveDispute();
        vm.prank(admin);
        (bool ok, ) = address(court).call(
            abi.encodeWithSelector(
                SLASH_AGENT_REPUTATION_SELECTOR, ESCROW_ID, depositor, uint256(100e18), recipient
            )
        );
        assertFalse(ok, "slashAgentReputation must no longer be dispatchable");
    }

    function test_noReputationSlash_selectorAbsentFromRuntime() public view {
        assertFalse(
            _runtimeContainsSelector(address(court), SLASH_AGENT_REPUTATION_SELECTOR),
            "slashAgentReputation selector must not appear in the deployed court"
        );
    }

    function test_pvtReference_existsForCollateralOnly_notReputationSlash() public view {
        assertTrue(
            _runtimeContainsSelector(address(court), PVT_GETTER_SELECTOR),
            "institution deployment: the court binds PVT for arbitrator collateral"
        );
        assertEq(address(court.pvt()), address(pvt), "bound to the token under test");

        assertFalse(
            _runtimeContainsSelector(address(court), SLASH_AGENT_REPUTATION_SELECTOR),
            "reputation-stake slashing must stay gone"
        );
        assertFalse(
            _runtimeContainsSelector(address(court), bytes4(keccak256("slashReputation(address,uint256)"))),
            "the court must not reach any slashReputation surface"
        );

        assertFalse(
            _runtimeContainsSelector(address(court), bytes4(keccak256("withdrawCollateral(address,uint256)"))),
            "no admin drain of custodied collateral"
        );
    }

    function test_noReputationSlash_fullLifecycleCallsOnlyTheEscrow() public {

        address clockAddr = address(court.epochClock());
        address indexAddr = address(court.issuanceIndex());
        address pvtAddr = address(court.pvt());
        vm.startStateDiffRecording();

        _resolveDispute();

        bytes32 second = keccak256("escrow-2");
        escrow.setParties(second, depositor, recipient);
        _fundAdj(court, address(escrow), second);
        vm.prank(admin);
        court.assignPanel(second, _validPanel());

        _postAll(second, _validPanel());
        vm.warp(block.timestamp + VOTING_WINDOW + 1);
        court.escalateDispute(second);
        vm.prank(admin);
        court.resolveEscalatedDispute(second, true);

        Vm.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();

        uint256 outboundCalls;
        uint256 pvtCalls;
        for (uint256 i = 0; i < accesses.length; i++) {
            Vm.AccountAccess memory a = accesses[i];
            if (a.accessor != address(court)) continue;
            if (
                a.kind != VmSafe.AccountAccessKind.Call &&
                a.kind != VmSafe.AccountAccessKind.StaticCall &&
                a.kind != VmSafe.AccountAccessKind.DelegateCall &&
                a.kind != VmSafe.AccountAccessKind.CallCode
            ) continue;
            outboundCalls++;

            assertTrue(
                a.account == address(escrow) || a.account == clockAddr
                    || a.account == indexAddr || a.account == pvtAddr,
                "court called a contract outside {escrow, epoch clock, issuance index, PVT}"
            );
            if (a.account == pvtAddr && a.data.length >= 4) {
                bytes4 sel = bytes4(a.data);
                assertTrue(
                    sel == bytes4(keccak256("transferFrom(address,address,uint256)"))
                        || sel == bytes4(keccak256("transfer(address,uint256)"))
                        || sel == bytes4(keccak256("burn(uint256)")),
                    "court touched PVT with a selector Recourseoutside the collateral set"
                );
                pvtCalls++;
            }
        }

        assertGt(outboundCalls, 0, "state-diff recording captured no outbound calls");

        assertGt(pvtCalls, 0, "no PVT calls recorded - the collateral selector check ran over nothing");
    }

    function test_views_revertOnUnknownDispute() public {
        bytes32 never = keccak256("never");
        vm.expectRevert(ProvianRecourseCourt.DisputeNotFound.selector);
        court.getPanel(never);
        vm.expectRevert(ProvianRecourseCourt.DisputeNotFound.selector);
        court.getVoteCounts(never);
        vm.expectRevert(ProvianRecourseCourt.DisputeNotFound.selector);
        court.hasArbitratorVoted(never, arb1);
        vm.expectRevert(ProvianRecourseCourt.DisputeNotFound.selector);
        court.getDisputeStatus(never);
        vm.expectRevert(ProvianRecourseCourt.DisputeNotFound.selector);
        court.getVotingDeadline(never);
    }

    function test_e2e_realEscrowAndCourt_happyPath() public {

        MockUSDC usdc = new MockUSDC();
        MockPVT realPvt = new MockPVT();
        address e2eAdmin = address(0xEE01);
        address feeWallet = address(0xEE02);
        address e2eDepositor = address(0xEE10);
        address e2eRecipient = address(0xEE20);
        address e2eArb1 = address(0xEE31);
        address e2eArb2 = address(0xEE32);
        address e2eArb3 = address(0xEE33);

        realPvt;
        ProvianRecourseEscrow realEscrow = new ProvianRecourseEscrow(e2eAdmin, feeWallet, address(usdc), address(pvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), RecourseInstitutionSeeds.SeedManifest(address(0),0,bytes32(0),bytes32(0),0,0));
        ProvianRecourseCourt realCourt = new ProvianRecourseCourt(e2eAdmin, address(realEscrow), address(new MockEpochClock(0)), address(pvt), address(new MockIssuanceIndex()));
        vm.prank(e2eAdmin);
        realEscrow.setCourtContract(address(realCourt));

        uint256 amount = 1000e6;
        usdc.mint(e2eDepositor, amount);
        vm.prank(e2eDepositor);
        usdc.approve(address(realEscrow), type(uint256).max);

        bytes32 escrowId = keccak256("e2e-escrow");
        uint256 deadline = block.timestamp + 1 days;
        vm.prank(e2eDepositor);
        realEscrow.createEscrow(escrowId, e2eRecipient, amount, deadline, ProvianRecourseEscrow.Currency.USDC);
        vm.prank(e2eDepositor);
        realEscrow.fundEscrow(escrowId, false );

        vm.prank(e2eDepositor);
        realEscrow.disputeEscrow(escrowId);

        _fundAdj(realCourt, address(realEscrow), escrowId);
        address[3] memory panel = [e2eArb1, e2eArb2, e2eArb3];
        vm.prank(e2eAdmin);
        realCourt.assignPanel(escrowId, panel);

        for (uint256 i = 0; i < 3; i++) {
            pvt.mint(panel[i], 1_000_000e18);
            vm.prank(panel[i]);
            pvt.approve(address(realCourt), type(uint256).max);
            vm.prank(panel[i]);
            realCourt.postEscrowCollateral(escrowId);
        }

        vm.prank(e2eArb1);
        realCourt.castVote(escrowId, true);
        vm.prank(e2eArb2);
        realCourt.castVote(escrowId, true);

        assertEq(
            uint8(realCourt.getDisputeStatus(escrowId)),
            uint8(ProvianRecourseCourt.DisputeStatus.Resolved),
            "Court resolved"
        );

        uint256 expectedFee = (amount * 50) / 10000;
        assertEq(usdc.balanceOf(e2eRecipient), amount - expectedFee, "recipient paid");
        assertEq(usdc.balanceOf(feeWallet), expectedFee, "fee wallet paid");
    }

    function test_e2e_realEscrow_rejectsPartyAsPanelist() public {

        MockUSDC usdc = new MockUSDC();
        MockPVT realPvt = new MockPVT();
        address e2eAdmin = address(0xEF01);
        address feeWallet = address(0xEF02);
        address e2eDepositor = address(0xEF10);
        address e2eRecipient = address(0xEF20);
        address e2eArb2 = address(0xEF32);
        address e2eArb3 = address(0xEF33);

        realPvt;
        ProvianRecourseEscrow realEscrow = new ProvianRecourseEscrow(e2eAdmin, feeWallet, address(usdc), address(pvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), RecourseInstitutionSeeds.SeedManifest(address(0),0,bytes32(0),bytes32(0),0,0));
        ProvianRecourseCourt realCourt = new ProvianRecourseCourt(e2eAdmin, address(realEscrow), address(new MockEpochClock(0)), address(pvt), address(new MockIssuanceIndex()));
        vm.prank(e2eAdmin);
        realEscrow.setCourtContract(address(realCourt));

        bytes32 escrowId = keccak256("e2e-party");
        usdc.mint(e2eDepositor, 100e6);
        vm.prank(e2eDepositor);
        usdc.approve(address(realEscrow), type(uint256).max);
        vm.prank(e2eDepositor);
        realEscrow.createEscrow(escrowId, e2eRecipient, 100e6, block.timestamp + 1 days, ProvianRecourseEscrow.Currency.USDC);
        vm.prank(e2eDepositor);
        realEscrow.fundEscrow(escrowId, false);
        vm.prank(e2eDepositor);
        realEscrow.disputeEscrow(escrowId);

        _fundAdj(realCourt, address(realEscrow), escrowId);
        address[3] memory bad = [e2eDepositor, e2eArb2, e2eArb3];
        vm.prank(e2eAdmin);
        vm.expectRevert(ProvianRecourseCourt.ArbitratorIsParty.selector);
        realCourt.assignPanel(escrowId, bad);
    }

    function testFuzz_assignPanel_rejectsPartyAsPanelist(uint256 salt, uint8 whichSlot) public {

        whichSlot = whichSlot % 3;
        bytes32 eid = keccak256(abi.encode("fuzz-party", salt));
        address dep = address(uint160(uint256(keccak256(abi.encode("dep", salt))) | 1));
        address rec = address(uint160(uint256(keccak256(abi.encode("rec", salt))) | 1));
        vm.assume(dep != rec);
        escrow.setParties(eid, dep, rec);
        _fundAdj(court, address(escrow), eid);

        address[3] memory p = [address(0xA1), address(0xA2), address(0xA3)];
        p[whichSlot] = dep;
        vm.prank(admin);
        vm.expectRevert(ProvianRecourseCourt.ArbitratorIsParty.selector);
        court.assignPanel(eid, p);

        p = [address(0xB1), address(0xB2), address(0xB3)];
        p[whichSlot] = rec;
        vm.prank(admin);
        vm.expectRevert(ProvianRecourseCourt.ArbitratorIsParty.selector);
        court.assignPanel(eid, p);
    }

    function testFuzz_castVote_voteSumEqualsVotersAct(bool v1, bool v2) public {

        _assignDefaultPanel();
        vm.prank(arb1);
        court.castVote(ESCROW_ID, v1);
        if (v1 != v2 || !v1) {

        }
        if (v1 == v2) {

            vm.prank(arb2);
            court.castVote(ESCROW_ID, v2);
            (uint8 forRelease, uint8 forRefund) = court.getVoteCounts(ESCROW_ID);
            assertEq(forRelease + forRefund, 2);
            assertEq(
                uint8(court.getDisputeStatus(ESCROW_ID)),
                uint8(ProvianRecourseCourt.DisputeStatus.Resolved)
            );
        } else {

            vm.prank(arb2);
            court.castVote(ESCROW_ID, v2);
            (uint8 forRelease, uint8 forRefund) = court.getVoteCounts(ESCROW_ID);
            assertEq(forRelease + forRefund, 2);
            assertEq(
                uint8(court.getDisputeStatus(ESCROW_ID)),
                uint8(ProvianRecourseCourt.DisputeStatus.Pending)
            );
        }
    }
}

contract RecourseCourtHandler is Test {
    ProvianRecourseCourt public court;
    RecourseMockEscrowV3 public escrow;
    MockPVT public pvt;

    address public admin;
    address[6] public arbs;
    address[4] public parties;

    bytes32[] public createdEscrowIds;

    mapping(bytes32 => bool) public wasResolved;
    mapping(bytes32 => bool) public wasEscalated;

    constructor(ProvianRecourseCourt _court, RecourseMockEscrowV3 _escrow, address _admin, MockPVT _pvt) {
        court = _court;
        escrow = _escrow;
        admin = _admin;
        pvt = _pvt;
        for (uint256 i = 0; i < 6; i++) arbs[i] = address(uint160(0xAAAA0 + i));
        for (uint256 i = 0; i < 4; i++) parties[i] = address(uint160(0xBBBB0 + i));
    }

    function _observeAll() internal {
        for (uint256 i = 0; i < createdEscrowIds.length; i++) {
            bytes32 eid = createdEscrowIds[i];
            ProvianRecourseCourt.DisputeStatus s = court.getDisputeStatus(eid);
            if (s == ProvianRecourseCourt.DisputeStatus.Resolved) wasResolved[eid] = true;
            else if (s == ProvianRecourseCourt.DisputeStatus.Escalated) wasEscalated[eid] = true;
        }
    }

    function createDispute(uint256 salt, uint8 depIdx, uint8 recIdx, uint8 a1, uint8 a2, uint8 a3) external {
        depIdx = depIdx % 4;
        recIdx = recIdx % 4;
        if (depIdx == recIdx) return;
        address dep = parties[depIdx];
        address rec = parties[recIdx];

        a1 = a1 % 6;
        a2 = a2 % 6;
        a3 = a3 % 6;
        if (a1 == a2 || a1 == a3 || a2 == a3) return;
        address p1 = arbs[a1];
        address p2 = arbs[a2];
        address p3 = arbs[a3];
        if (p1 == dep || p1 == rec || p2 == dep || p2 == rec || p3 == dep || p3 == rec) return;

        bytes32 eid = keccak256(abi.encode("inv-dispute", salt, createdEscrowIds.length));
        if (court.disputeExists(eid)) return;

        escrow.setParties(eid, dep, rec);

        bytes32 feeKey = keccak256(abi.encode(uint8(1) , eid));
        if (!court.escrowRewardFunded(feeKey)) {
            pvt.mint(address(court), 30e18);
            vm.prank(address(escrow));
            court.fundEscrowDisputeReward(eid, 30e18);
        }
        vm.prank(admin);
        try court.assignPanel(eid, [p1, p2, p3]) {
            createdEscrowIds.push(eid);
        } catch {}
        _observeAll();
    }

    function castVote(uint256 disputeIdx, uint256 arbIdx, bool release) external {
        if (createdEscrowIds.length == 0) return;
        bytes32 eid = createdEscrowIds[disputeIdx % createdEscrowIds.length];
        address[3] memory panel = court.getPanel(eid);
        address voter = panel[arbIdx % 3];
        vm.prank(voter);
        try court.castVote(eid, release) {} catch {}
        _observeAll();
    }

    function warpAndEscalate(uint256 disputeIdx) external {
        if (createdEscrowIds.length == 0) return;
        bytes32 eid = createdEscrowIds[disputeIdx % createdEscrowIds.length];
        uint256 deadline = court.getVotingDeadline(eid);
        vm.warp(deadline + 1);
        try court.escalateDispute(eid) {} catch {}
        _observeAll();
    }

    function resolveEscalated(uint256 disputeIdx, bool release) external {
        if (createdEscrowIds.length == 0) return;
        bytes32 eid = createdEscrowIds[disputeIdx % createdEscrowIds.length];
        vm.prank(admin);
        try court.resolveEscalatedDispute(eid, release) {} catch {}
        _observeAll();
    }

    function disputeCount() external view returns (uint256) {
        return createdEscrowIds.length;
    }

    function disputeAt(uint256 i) external view returns (bytes32) {
        return createdEscrowIds[i];
    }
}

contract RecourseProvianRecourseCourtInvariantTest is Test {
    ProvianRecourseCourt public court;
    RecourseMockEscrowV3 public escrow;
    RecourseCourtHandler public handler;
    MockPVT public pvt;

    address public admin = address(0xA01);

    function setUp() public {
        escrow = new RecourseMockEscrowV3();
        pvt = new MockPVT();
        court = new ProvianRecourseCourt(admin, address(escrow), address(new MockEpochClock(0)), address(pvt), address(new MockIssuanceIndex()));

        handler = new RecourseCourtHandler(court, escrow, admin, pvt);
        targetContract(address(handler));
    }

    function invariant_statusRespectsTransitionDAG() public view {
        uint256 n = handler.disputeCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 eid = handler.disputeAt(i);
            ProvianRecourseCourt.DisputeStatus s = court.getDisputeStatus(eid);
            if (handler.wasResolved(eid)) {
                assertEq(
                    uint8(s),
                    uint8(ProvianRecourseCourt.DisputeStatus.Resolved),
                    "dispute that was Resolved is no longer Resolved"
                );
            } else if (handler.wasEscalated(eid)) {
                assertTrue(
                    s == ProvianRecourseCourt.DisputeStatus.Escalated
                        || s == ProvianRecourseCourt.DisputeStatus.Resolved,
                    "dispute that was Escalated moved to an illegal state"
                );
            }
        }
    }

    function test_CONTROL_handlerActuallyPopulates() public {
        assertEq(handler.disputeCount(), 0, "population must start empty, or this proves nothing");
        handler.createDispute(7, 0, 1, 0, 1, 2);
        assertGt(handler.disputeCount(), 0, "handler creates NO disputes - every invariant above is vacuous");
    }

    function invariant_voteSumBounded() public view {
        uint256 n = handler.disputeCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 eid = handler.disputeAt(i);
            (uint8 forRelease, uint8 forRefund) = court.getVoteCounts(eid);
            assertLe(uint256(forRelease) + uint256(forRefund), 3, "vote sum > panel size");
        }
    }

    function invariant_panelPropertiesHold() public view {
        uint256 n = handler.disputeCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 eid = handler.disputeAt(i);
            address[3] memory panel = court.getPanel(eid);

            assertTrue(panel[0] != panel[1]);
            assertTrue(panel[0] != panel[2]);
            assertTrue(panel[1] != panel[2]);

            (address dep, address rec) = escrow.getParties(eid);
            for (uint256 j = 0; j < 3; j++) {
                assertTrue(panel[j] != dep, "panelist == depositor");
                assertTrue(panel[j] != rec, "panelist == recipient");
            }
        }
    }
}

contract RecourseProvianRecourseCourtBondClaimTest is Test {
    ProvianRecourseCourt public court;
    ProvianRecourseBondPool public bondPool;
    RecourseMockEscrowV3 public escrow;
    MockPVT public pvt;

    address public admin = address(0xA01);
    address public techWallet = address(0xA02);
    address public agent = address(0xB01);
    address public claimant = address(0xB02);
    address public arb1 = address(0xC01);
    address public arb2 = address(0xC02);
    address public arb3 = address(0xC03);
    address public outsider = address(0xD01);

    uint256 public constant MAX_BPS = 10000;
    uint256 public constant MIN_SLASH_PAYOUT_BPS = 5000;
    uint256 public constant SLASH_PAYOUT_BPS = 8000;
    uint256 public constant FILING_FEE = 15e18;
    uint256 public constant CLAIMS_PROCESSING_FEE = 30e18;
    uint256 public constant VOTING_WINDOW = 48 hours;
    uint256 public constant FUND = 1_000_000e18;

    function setUp() public {
        escrow = new RecourseMockEscrowV3();
        pvt = new MockPVT();
        bondPool = new ProvianRecourseBondPool(admin, techWallet, address(pvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), RecourseInstitutionSeeds.SeedManifest(address(0),0,bytes32(0),bytes32(0),0,0), new ProvianRecourseBondPool.BpsSeed[](0));
        court = new ProvianRecourseCourt(admin, address(escrow), address(new MockEpochClock(0)), address(pvt), address(new MockIssuanceIndex()));

        vm.startPrank(admin);
        bondPool.setCourtContract(address(court));
        court.setBondPool(address(bondPool));
        vm.stopPrank();

        pvt.mint(agent, FUND);
        pvt.mint(claimant, FUND);
        vm.prank(agent);
        pvt.approve(address(bondPool), type(uint256).max);
        vm.prank(claimant);
        pvt.approve(address(bondPool), type(uint256).max);

        address[3] memory arbs = _panel();
        for (uint256 i = 0; i < 3; i++) {
            pvt.mint(arbs[i], FUND);
            vm.prank(arbs[i]);
            pvt.approve(address(court), type(uint256).max);
        }
    }

    function _postAllBond(bytes32 claimId) internal {
        address[3] memory arbs = _panel();
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(arbs[i]);
            court.postBondClaimCollateral(claimId);
        }
    }

    function _panel() internal view returns (address[3] memory) {
        return [arb1, arb2, arb3];
    }

    function _postAndFile(bytes32 salt) internal returns (bytes32 claimId, uint256 locked) {
        vm.prank(agent);
        bondPool.postBond(2, 0);
        (locked, , , , , ,) = bondPool.bonds(agent);
        claimId = keccak256(abi.encode("bond-claim", salt));
        vm.prank(claimant);
        bondPool.fileClaim(agent, claimId);
        (, , , , , , uint256 pending) = bondPool.bonds(agent);
        assertEq(pending, 1, "claim filed bumps pendingClaims");
    }

    function _assign(bytes32 claimId) internal {
        _assignUnposted(claimId);
        _postAllBond(claimId);
    }

    function _assignUnposted(bytes32 claimId) internal {
        vm.prank(admin);
        court.assignBondClaimPanel(claimId, _panel());
    }

    function test_setBondPool_oneTimeOnly() public {
        ProvianRecourseCourt fresh = new ProvianRecourseCourt(admin, address(escrow), address(new MockEpochClock(0)), address(pvt), address(new MockIssuanceIndex()));
        vm.prank(admin);
        fresh.setBondPool(address(bondPool));
        vm.prank(admin);
        vm.expectRevert(ProvianRecourseCourt.BondPoolAlreadySet.selector);
        fresh.setBondPool(address(bondPool));
    }

    function test_setBondPool_onlyAdmin() public {
        ProvianRecourseCourt fresh = new ProvianRecourseCourt(admin, address(escrow), address(new MockEpochClock(0)), address(pvt), address(new MockIssuanceIndex()));
        vm.prank(outsider);
        vm.expectRevert(ProvianRecourseCourt.OnlyAdmin.selector);
        fresh.setBondPool(address(bondPool));
    }

    function test_setBondPool_rejectsZero() public {
        ProvianRecourseCourt fresh = new ProvianRecourseCourt(admin, address(escrow), address(new MockEpochClock(0)), address(pvt), address(new MockIssuanceIndex()));
        vm.prank(admin);
        vm.expectRevert(ProvianRecourseCourt.InvalidAddress.selector);
        fresh.setBondPool(address(0));
    }

    function test_assignBondPanel_revertsIfBondPoolUnset() public {
        ProvianRecourseCourt fresh = new ProvianRecourseCourt(admin, address(escrow), address(new MockEpochClock(0)), address(pvt), address(new MockIssuanceIndex()));
        vm.prank(admin);
        vm.expectRevert(ProvianRecourseCourt.BondPoolNotSet.selector);
        fresh.assignBondClaimPanel(keccak256("x"), _panel());
    }

    function test_assignBondPanel_happyPath() public {
        (bytes32 claimId, ) = _postAndFile("happy");

        vm.expectEmit(true, true, false, true, address(court));
        emit ProvianRecourseCourt.BondPanelAssigned(claimId, agent, arb1, arb2, arb3, 0);
        _assignUnposted(claimId);

        assertTrue(court.bondDisputeExists(claimId));
        assertEq(court.getBondDisputeAgent(claimId), agent);
        address[3] memory p = court.getBondPanel(claimId);
        assertEq(p[0], arb1);
        assertEq(uint8(court.getBondDisputeStatus(claimId)), uint8(ProvianRecourseCourt.DisputeStatus.Pending));
        assertEq(court.getBondVotingDeadline(claimId), 0, "unarmed until the panel is seated");

        _postAllBond(claimId);
        assertEq(court.getBondVotingDeadline(claimId), block.timestamp + VOTING_WINDOW);
    }

    function test_assignBondPanel_onlyAdmin() public {
        (bytes32 claimId, ) = _postAndFile("only-admin");
        vm.prank(outsider);
        vm.expectRevert(ProvianRecourseCourt.OnlyAdmin.selector);
        court.assignBondClaimPanel(claimId, _panel());
    }

    function test_assignBondPanel_rejectsNonFiledClaim() public {

        vm.prank(admin);
        vm.expectRevert(ProvianRecourseCourt.BondClaimNotFiled.selector);
        court.assignBondClaimPanel(keccak256("never-filed"), _panel());
    }

    function test_assignBondPanel_rejectsResolvedClaim() public {

        (bytes32 claimId, ) = _postAndFile("resolved");
        _assign(claimId);
        vm.prank(arb1);
        court.castBondClaimVote(claimId, ProvianRecourseCourt.BondVerdictVote.SlashFull);
        vm.prank(arb2);
        court.castBondClaimVote(claimId, ProvianRecourseCourt.BondVerdictVote.SlashFull);

        ProvianRecourseCourt fresh = new ProvianRecourseCourt(admin, address(escrow), address(new MockEpochClock(0)), address(pvt), address(new MockIssuanceIndex()));
        vm.prank(admin);
        fresh.setBondPool(address(bondPool));
        vm.prank(admin);
        vm.expectRevert(ProvianRecourseCourt.BondClaimNotFiled.selector);
        fresh.assignBondClaimPanel(claimId, _panel());
    }

    function test_assignBondPanel_rejectsAgentAsPanelist() public {
        (bytes32 claimId, ) = _postAndFile("agent-panelist");
        address[3] memory bad = [agent, arb2, arb3];
        vm.prank(admin);
        vm.expectRevert(ProvianRecourseCourt.ArbitratorIsParty.selector);
        court.assignBondClaimPanel(claimId, bad);
    }

    function test_assignBondPanel_rejectsClaimantAsPanelist() public {
        (bytes32 claimId, ) = _postAndFile("claimant-panelist");
        address[3] memory bad = [arb1, claimant, arb3];
        vm.prank(admin);
        vm.expectRevert(ProvianRecourseCourt.ArbitratorIsParty.selector);
        court.assignBondClaimPanel(claimId, bad);
    }

    function test_assignBondPanel_rejectsDuplicateAndZero() public {
        (bytes32 claimId, ) = _postAndFile("dup-zero");
        vm.prank(admin);
        vm.expectRevert(ProvianRecourseCourt.DuplicateArbitrator.selector);
        court.assignBondClaimPanel(claimId, [arb1, arb1, arb3]);
        vm.prank(admin);
        vm.expectRevert(ProvianRecourseCourt.InvalidAddress.selector);
        court.assignBondClaimPanel(claimId, [arb1, address(0), arb3]);
    }

    function test_assignBondPanel_rejectsAlreadyAssigned() public {
        (bytes32 claimId, ) = _postAndFile("already");
        _assign(claimId);
        vm.prank(admin);
        vm.expectRevert(ProvianRecourseCourt.DisputeAlreadyExists.selector);
        court.assignBondClaimPanel(claimId, _panel());
    }

    function test_bondClaim_fullSlash_unblocksWithdraw() public {
        (bytes32 claimId, uint256 locked) = _postAndFile("full");
        _assign(claimId);

        uint256 claimantBefore = pvt.balanceOf(claimant);
        uint256 burnedBefore = pvt.totalBurned();

        vm.prank(arb1);
        court.castBondClaimVote(claimId, ProvianRecourseCourt.BondVerdictVote.SlashFull);
        vm.expectEmit(true, true, false, true, address(court));
        emit ProvianRecourseCourt.BondClaimResolved(claimId, agent, ProvianRecourseCourt.BondVerdictVote.SlashFull, locked);
        vm.prank(arb2);
        court.castBondClaimVote(claimId, ProvianRecourseCourt.BondVerdictVote.SlashFull);

        uint256 expectedClaimant = (locked * SLASH_PAYOUT_BPS) / MAX_BPS;
        assertEq(pvt.balanceOf(claimant), claimantBefore + expectedClaimant + FILING_FEE, "claimant payout");
        assertEq(pvt.totalBurned(), burnedBefore + (locked - expectedClaimant), "burn 20%");

        (uint256 amtAfter, , , , , , uint256 pending) = bondPool.bonds(agent);
        assertEq(amtAfter, 0, "bond drained by full slash");
        assertEq(pending, 0, "pendingClaims decremented");
        assertEq(uint8(court.getBondDisputeStatus(claimId)), uint8(ProvianRecourseCourt.DisputeStatus.Resolved));

        vm.prank(agent);
        bondPool.withdrawBond();
        (, , , , , ProvianRecourseBondPool.BondStatus finalStatus,) = bondPool.bonds(agent);
        assertEq(uint8(finalStatus), uint8(ProvianRecourseBondPool.BondStatus.Withdrawn));
    }

    function test_bondClaim_partialSlash_floorAmount() public {
        (bytes32 claimId, uint256 locked) = _postAndFile("partial");
        _assign(claimId);
        uint256 floorAmt = (locked * MIN_SLASH_PAYOUT_BPS) / MAX_BPS;

        uint256 claimantBefore = pvt.balanceOf(claimant);

        vm.prank(arb1);
        court.castBondClaimVote(claimId, ProvianRecourseCourt.BondVerdictVote.SlashPartial);
        vm.expectEmit(true, true, false, true, address(court));
        emit ProvianRecourseCourt.BondClaimResolved(claimId, agent, ProvianRecourseCourt.BondVerdictVote.SlashPartial, floorAmt);
        vm.prank(arb2);
        court.castBondClaimVote(claimId, ProvianRecourseCourt.BondVerdictVote.SlashPartial);

        uint256 expectedClaimant = (floorAmt * SLASH_PAYOUT_BPS) / MAX_BPS;
        assertEq(pvt.balanceOf(claimant), claimantBefore + expectedClaimant + FILING_FEE, "partial payout");

        (uint256 amtAfter, , , , , , uint256 pending) = bondPool.bonds(agent);
        assertEq(amtAfter, locked - floorAmt - CLAIMS_PROCESSING_FEE, "bond reduced by 50% + proc fee");
        assertEq(pending, 0, "pendingClaims decremented");

        vm.prank(agent);
        bondPool.withdrawBond();
    }

    function test_bondClaim_dismiss_burnsFeeNoSlash() public {
        (bytes32 claimId, uint256 locked) = _postAndFile("dismiss");
        _assign(claimId);

        uint256 claimantBefore = pvt.balanceOf(claimant);
        uint256 burnedBefore = pvt.totalBurned();

        vm.prank(arb1);
        court.castBondClaimVote(claimId, ProvianRecourseCourt.BondVerdictVote.Dismiss);
        vm.expectEmit(true, true, false, true, address(court));
        emit ProvianRecourseCourt.BondClaimResolved(claimId, agent, ProvianRecourseCourt.BondVerdictVote.Dismiss, 0);
        vm.prank(arb2);
        court.castBondClaimVote(claimId, ProvianRecourseCourt.BondVerdictVote.Dismiss);

        assertEq(pvt.balanceOf(claimant), claimantBefore, "claimant not refunded on dismiss");
        assertEq(pvt.totalBurned(), burnedBefore + FILING_FEE, "filing fee burned");

        (uint256 amtAfter, , , , , , uint256 pending) = bondPool.bonds(agent);

        assertEq(amtAfter, locked - CLAIMS_PROCESSING_FEE, "bond unslashed (minus proc fee)");
        assertEq(pending, 0, "pendingClaims decremented");

        vm.prank(agent);
        bondPool.withdrawBond();
    }
    function testCourtEncumbranceTracksCollateralAndRewardsButNotDonations() public {
        pvt.mint(address(court), 17 ether);
        (bytes32 id,) = _postAndFile("custody TEST ONLY");
        _assign(id);
        assertEq(court.encumberedPVT(), pvt.balanceOf(address(court)) - 17 ether);
        vm.prank(arb1); court.castBondClaimVote(id, ProvianRecourseCourt.BondVerdictVote.Dismiss);
        vm.prank(arb2); court.castBondClaimVote(id, ProvianRecourseCourt.BondVerdictVote.Dismiss);
        assertEq(court.encumberedPVT(), pvt.balanceOf(address(court)) - 17 ether);
        for (uint8 seat; seat < 3; ++seat) {
            court.settleArbitratorCollateral(2, id, seat);
            assertEq(court.encumberedPVT(), pvt.balanceOf(address(court)) - 17 ether);
        }
        assertEq(court.encumberedPVT(), 0);
        assertEq(pvt.balanceOf(address(court)), 17 ether);
    }

    function test_bondClaim_splitVote_resolvesDismiss() public {

        (bytes32 claimId, uint256 locked) = _postAndFile("split");
        _assign(claimId);

        vm.prank(arb1);
        court.castBondClaimVote(claimId, ProvianRecourseCourt.BondVerdictVote.Dismiss);
        vm.prank(arb2);
        court.castBondClaimVote(claimId, ProvianRecourseCourt.BondVerdictVote.SlashPartial);
        assertEq(uint8(court.getBondDisputeStatus(claimId)), uint8(ProvianRecourseCourt.DisputeStatus.Pending));

        vm.prank(arb3);
        court.castBondClaimVote(claimId, ProvianRecourseCourt.BondVerdictVote.SlashFull);

        assertEq(uint8(court.getBondDisputeStatus(claimId)), uint8(ProvianRecourseCourt.DisputeStatus.Resolved));
        (uint256 amtAfter, , , , , , uint256 pending) = bondPool.bonds(agent);
        assertEq(amtAfter, locked - CLAIMS_PROCESSING_FEE, "no slash on 1/1/1 split");
        assertEq(pending, 0);
    }

    function test_bondClaim_singleVoteDoesNotResolve() public {
        (bytes32 claimId, ) = _postAndFile("single");
        _assign(claimId);
        vm.prank(arb1);
        court.castBondClaimVote(claimId, ProvianRecourseCourt.BondVerdictVote.SlashFull);
        assertEq(uint8(court.getBondDisputeStatus(claimId)), uint8(ProvianRecourseCourt.DisputeStatus.Pending));
        (, , , , , , uint256 pending) = bondPool.bonds(agent);
        assertEq(pending, 1, "still frozen pending more votes");
    }

    function test_castBondVote_rejectsNonPanelist() public {
        (bytes32 claimId, ) = _postAndFile("nonpanelist");
        _assign(claimId);
        vm.prank(outsider);
        vm.expectRevert(ProvianRecourseCourt.NotPanelMember.selector);
        court.castBondClaimVote(claimId, ProvianRecourseCourt.BondVerdictVote.SlashFull);
    }

    function test_castBondVote_rejectsDoubleVote() public {
        (bytes32 claimId, ) = _postAndFile("double");
        _assign(claimId);
        vm.prank(arb1);
        court.castBondClaimVote(claimId, ProvianRecourseCourt.BondVerdictVote.SlashFull);
        vm.prank(arb1);
        vm.expectRevert(ProvianRecourseCourt.AlreadyVoted.selector);
        court.castBondClaimVote(claimId, ProvianRecourseCourt.BondVerdictVote.Dismiss);
    }

    function test_castBondVote_rejectsNoneVerdict() public {
        (bytes32 claimId, ) = _postAndFile("none");
        _assign(claimId);
        vm.prank(arb1);
        vm.expectRevert(ProvianRecourseCourt.InvalidBondVerdict.selector);
        court.castBondClaimVote(claimId, ProvianRecourseCourt.BondVerdictVote.None);
    }

    function test_castBondVote_rejectsAfterDeadline() public {
        (bytes32 claimId, ) = _postAndFile("deadline");
        _assign(claimId);
        vm.warp(block.timestamp + VOTING_WINDOW + 1);
        vm.prank(arb1);
        vm.expectRevert(ProvianRecourseCourt.VotingClosed.selector);
        court.castBondClaimVote(claimId, ProvianRecourseCourt.BondVerdictVote.SlashFull);
    }

    function test_castBondVote_rejectsUnknownClaim() public {
        vm.prank(arb1);
        vm.expectRevert(ProvianRecourseCourt.DisputeNotFound.selector);
        court.castBondClaimVote(keccak256("never-assigned"), ProvianRecourseCourt.BondVerdictVote.SlashFull);
    }

    function test_castBondVote_rejectsOnResolved() public {
        (bytes32 claimId, ) = _postAndFile("post-resolve");
        _assign(claimId);
        vm.prank(arb1);
        court.castBondClaimVote(claimId, ProvianRecourseCourt.BondVerdictVote.SlashFull);
        vm.prank(arb2);
        court.castBondClaimVote(claimId, ProvianRecourseCourt.BondVerdictVote.SlashFull);
        vm.prank(arb3);
        vm.expectRevert(ProvianRecourseCourt.DisputeNotPending.selector);
        court.castBondClaimVote(claimId, ProvianRecourseCourt.BondVerdictVote.Dismiss);
    }

    function test_finalizeBondClaim_dismissesAfterDeadline() public {
        (bytes32 claimId, uint256 locked) = _postAndFile("finalize");
        _assign(claimId);

        vm.prank(arb1);
        court.castBondClaimVote(claimId, ProvianRecourseCourt.BondVerdictVote.SlashFull);

        vm.warp(block.timestamp + VOTING_WINDOW + 1);

        vm.prank(outsider);
        court.finalizeBondClaim(claimId);

        assertEq(uint8(court.getBondDisputeStatus(claimId)), uint8(ProvianRecourseCourt.DisputeStatus.Resolved));
        (uint256 amtAfter, , , , , , uint256 pending) = bondPool.bonds(agent);
        assertEq(amtAfter, locked - CLAIMS_PROCESSING_FEE, "deadline finalize never slashes");
        assertEq(pending, 0, "freeze lifted by finalize");

        vm.prank(agent);
        bondPool.withdrawBond();
    }

    function test_finalizeBondClaim_rejectsBeforeDeadline() public {
        (bytes32 claimId, ) = _postAndFile("finalize-early");
        _assign(claimId);
        vm.expectRevert(ProvianRecourseCourt.VotingNotExpired.selector);
        court.finalizeBondClaim(claimId);
    }

    function test_finalizeBondClaim_rejectsResolved() public {
        (bytes32 claimId, ) = _postAndFile("finalize-resolved");
        _assign(claimId);
        vm.prank(arb1);
        court.castBondClaimVote(claimId, ProvianRecourseCourt.BondVerdictVote.Dismiss);
        vm.prank(arb2);
        court.castBondClaimVote(claimId, ProvianRecourseCourt.BondVerdictVote.Dismiss);
        vm.warp(block.timestamp + VOTING_WINDOW + 1);
        vm.expectRevert(ProvianRecourseCourt.DisputeNotPending.selector);
        court.finalizeBondClaim(claimId);
    }

    function test_adminCannotSlashDirectly() public {
        (bytes32 claimId, uint256 locked) = _postAndFile("admin-cant");

        vm.prank(admin);
        vm.expectRevert(ProvianRecourseBondPool.OnlyCourt.selector);
        bondPool.slashBond(agent, locked, claimId);
        vm.prank(admin);
        vm.expectRevert(ProvianRecourseBondPool.OnlyCourt.selector);
        bondPool.dismissClaim(agent, claimId);
    }
}

