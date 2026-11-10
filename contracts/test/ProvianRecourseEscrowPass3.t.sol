// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ProvianRecourseEscrow.sol";
import "./MockEpochClock.sol";
import "./MockIssuanceIndex.sol";
import "../src/ProvianRecourseCourt.sol";
import "./MockTokens.sol";

contract RecourseProvianRecourseEscrowPass3Test is Test {
    ProvianRecourseEscrow public escrow;
    MockUSDC public usdc;
    MockPVT public pvt;

    address public admin = address(0xA01);
    address public feeWallet = address(0xFEE);
    address public depositor = address(0xD01);
    address public recipient = address(0xD02);
    address public court = address(0xC07);
    address public keeper = address(0xBEEF);

    uint256 public constant USDC_AMOUNT = 1000e6;
    uint256 public constant PVT_AMOUNT = 1000e18;
    uint256 public constant USDC_FEE = 5e6;
    uint256 public constant PVT_FEE = 5e18;

    function setUp() public {
        usdc = new MockUSDC();
        pvt = new MockPVT();
        escrow = new ProvianRecourseEscrow(admin, feeWallet, address(usdc), address(pvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), new ProvianRecourseEscrow.EscrowSeed[](0));

        usdc.mint(depositor, 100_000e6);
        pvt.mint(depositor, 100_000e18);
        vm.startPrank(depositor);
        usdc.approve(address(escrow), type(uint256).max);
        pvt.approve(address(escrow), type(uint256).max);
        vm.stopPrank();

        vm.prank(admin);
        escrow.setCourtContract(court);
    }

    function _disputedUSDC() internal returns (bytes32 id) {
        id = keccak256(abi.encode("usdc-disp", block.timestamp, gasleft()));
        vm.prank(depositor);
        escrow.createEscrow(id, recipient, USDC_AMOUNT, block.timestamp + 1 days, ProvianRecourseEscrow.Currency.USDC);
        vm.prank(depositor);
        escrow.fundEscrow(id, false);
        vm.prank(depositor);
        escrow.disputeEscrow(id);
    }

    function test_4_disputed_oldExitsAreAllDeadEnds() public {
        bytes32 id = _disputedUSDC();

        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(
            ProvianRecourseEscrow.InvalidStatus.selector, ProvianRecourseEscrow.Status.Funded, ProvianRecourseEscrow.Status.Disputed));
        escrow.releaseEscrow(id);

        vm.warp(block.timestamp + 2 days);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(
            ProvianRecourseEscrow.InvalidStatus.selector, ProvianRecourseEscrow.Status.Funded, ProvianRecourseEscrow.Status.Disputed));
        escrow.releaseEscrow(id);

        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(
            ProvianRecourseEscrow.InvalidStatus.selector, ProvianRecourseEscrow.Status.Created, ProvianRecourseEscrow.Status.Disputed));
        escrow.cancelEscrow(id);

        assertEq(usdc.balanceOf(address(escrow)), USDC_AMOUNT);
    }

    function test_4_claimDisputeTimeout_refundsDepositor_USDC() public {
        uint256 depBefore = usdc.balanceOf(depositor);
        bytes32 id = _disputedUSDC();

        vm.prank(keeper);
        vm.expectRevert(ProvianRecourseEscrow.DisputeTimeoutNotReached.selector);
        escrow.claimDisputeTimeout(id);

        vm.warp(block.timestamp + escrow.DISPUTE_RESOLUTION_TIMEOUT() + 1);
        vm.prank(keeper);
        escrow.claimDisputeTimeout(id);

        assertEq(usdc.balanceOf(depositor), depBefore - USDC_FEE);
        assertEq(usdc.balanceOf(feeWallet), USDC_FEE);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        (, , , , , ProvianRecourseEscrow.Status status, , ) = escrow.escrows(id);
        assertEq(uint8(status), uint8(ProvianRecourseEscrow.Status.Resolved));
    }

    function test_4_claimDisputeTimeout_refundsDepositor_PVT() public {
        uint256 depBefore = pvt.balanceOf(depositor);
        bytes32 id = keccak256("pvt-timeout");
        vm.prank(depositor);
        escrow.createEscrow(id, recipient, PVT_AMOUNT, block.timestamp + 1 days, ProvianRecourseEscrow.Currency.PVT);
        vm.prank(depositor);
        escrow.fundEscrow(id, false);
        vm.prank(depositor);
        escrow.disputeEscrow(id);

        vm.warp(block.timestamp + escrow.DISPUTE_RESOLUTION_TIMEOUT() + 1);
        vm.prank(keeper);
        escrow.claimDisputeTimeout(id);

        assertEq(pvt.balanceOf(depositor), depBefore - PVT_FEE);
        assertEq(pvt.balanceOf(recipient), 0);
        assertEq(pvt.balanceOf(address(escrow)), 0);
        assertEq(pvt.balanceOf(feeWallet), 0);
    }

    function test_4_claimDisputeTimeout_revertsIfNotDisputed() public {
        bytes32 id = keccak256("funded-only");
        vm.prank(depositor);
        escrow.createEscrow(id, recipient, USDC_AMOUNT, block.timestamp + 1 days, ProvianRecourseEscrow.Currency.USDC);
        vm.prank(depositor);
        escrow.fundEscrow(id, false);

        vm.warp(block.timestamp + 60 days);
        vm.expectRevert(abi.encodeWithSelector(
            ProvianRecourseEscrow.InvalidStatus.selector, ProvianRecourseEscrow.Status.Disputed, ProvianRecourseEscrow.Status.Funded));
        escrow.claimDisputeTimeout(id);
    }

    function test_4_courtHasPriority_thenTimeoutClosed() public {
        bytes32 id = _disputedUSDC();

        vm.prank(court);
        escrow.resolveDispute(id, true);
        assertEq(usdc.balanceOf(recipient), USDC_AMOUNT - USDC_FEE);

        vm.warp(block.timestamp + escrow.DISPUTE_RESOLUTION_TIMEOUT() + 1);
        vm.expectRevert(abi.encodeWithSelector(
            ProvianRecourseEscrow.InvalidStatus.selector, ProvianRecourseEscrow.Status.Disputed, ProvianRecourseEscrow.Status.Resolved));
        escrow.claimDisputeTimeout(id);
    }

    function test_4_afterTimeout_courtCannotOverride() public {
        bytes32 id = _disputedUSDC();
        vm.warp(block.timestamp + escrow.DISPUTE_RESOLUTION_TIMEOUT() + 1);
        vm.prank(keeper);
        escrow.claimDisputeTimeout(id);

        vm.prank(court);
        vm.expectRevert(abi.encodeWithSelector(
            ProvianRecourseEscrow.InvalidStatus.selector, ProvianRecourseEscrow.Status.Disputed, ProvianRecourseEscrow.Status.Resolved));
        escrow.resolveDispute(id, true);
    }

    function test_18_evidence_atomicPushToBlacklistedReverts() public {
        MockBlacklistUSDC bl = new MockBlacklistUSDC();
        bl.mint(address(this), 100e6);
        bl.setBlacklisted(recipient, true);
        vm.expectRevert(abi.encodeWithSelector(MockBlacklistUSDC.AccountBlacklisted.selector, recipient));
        bl.transfer(recipient, 1e6);
    }

    function _escrowWithBlacklistUSDC() internal returns (ProvianRecourseEscrow e, MockBlacklistUSDC bl) {
        bl = new MockBlacklistUSDC();
        e = new ProvianRecourseEscrow(admin, feeWallet, address(bl), address(pvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), new ProvianRecourseEscrow.EscrowSeed[](0));
        vm.prank(admin);
        e.setCourtContract(court);
        bl.mint(depositor, 100_000e6);
        vm.prank(depositor);
        bl.approve(address(e), type(uint256).max);
    }

    function test_18_resolveRelease_toBlacklistedRecipient_creditsPull_USDC() public {
        (ProvianRecourseEscrow e, MockBlacklistUSDC bl) = _escrowWithBlacklistUSDC();
        bytes32 id = keccak256("bl-release");
        vm.prank(depositor);
        e.createEscrow(id, recipient, USDC_AMOUNT, block.timestamp + 1 days, ProvianRecourseEscrow.Currency.USDC);
        vm.prank(depositor);
        e.fundEscrow(id, false);
        vm.prank(depositor);
        e.disputeEscrow(id);

        bl.setBlacklisted(recipient, true);

        vm.prank(court);
        e.resolveDispute(id, true);

        assertEq(bl.balanceOf(recipient), 0);
        assertEq(e.pendingWithdrawal(id), USDC_AMOUNT - USDC_FEE);
        assertEq(e.pendingBeneficiary(id), recipient);
        assertEq(bl.balanceOf(feeWallet), USDC_FEE);
        (, , , , , ProvianRecourseEscrow.Status status, , ) = e.escrows(id);
        assertEq(uint8(status), uint8(ProvianRecourseEscrow.Status.Resolved));

        vm.expectRevert(abi.encodeWithSelector(MockBlacklistUSDC.AccountBlacklisted.selector, recipient));
        e.withdrawResolvedFunds(id);
        assertEq(e.pendingWithdrawal(id), USDC_AMOUNT - USDC_FEE);

        bl.setBlacklisted(recipient, false);
        vm.prank(keeper);
        e.withdrawResolvedFunds(id);
        assertEq(bl.balanceOf(recipient), USDC_AMOUNT - USDC_FEE);
        assertEq(e.pendingWithdrawal(id), 0);

        vm.expectRevert(ProvianRecourseEscrow.NothingToWithdraw.selector);
        e.withdrawResolvedFunds(id);
    }

    function test_18_resolveRelease_toBlacklistedRecipient_creditsPull_PVT() public {
        MockBlacklistPVT blpvt = new MockBlacklistPVT();
        ProvianRecourseEscrow e = new ProvianRecourseEscrow(admin, feeWallet, address(usdc), address(blpvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), new ProvianRecourseEscrow.EscrowSeed[](0));
        vm.prank(admin);
        e.setCourtContract(court);
        blpvt.mint(depositor, 100_000e18);
        vm.prank(depositor);
        blpvt.approve(address(e), type(uint256).max);

        bytes32 id = keccak256("bl-release-pvt");
        vm.prank(depositor);
        e.createEscrow(id, recipient, PVT_AMOUNT, block.timestamp + 1 days, ProvianRecourseEscrow.Currency.PVT);
        vm.prank(depositor);
        e.fundEscrow(id, false);
        assertEq(e.encumberedPVT(), PVT_AMOUNT - PVT_FEE);
        blpvt.mint(address(e), 17 ether);
        vm.prank(depositor);
        e.disputeEscrow(id);

        blpvt.setBlacklisted(recipient, true);
        vm.prank(court);
        e.resolveDispute(id, true);

        assertEq(blpvt.balanceOf(recipient), 0);
        assertEq(e.pendingWithdrawal(id), PVT_AMOUNT - PVT_FEE);
        assertEq(e.encumberedPVT(), PVT_AMOUNT - PVT_FEE);

        blpvt.setBlacklisted(recipient, false);
        e.withdrawResolvedFunds(id);
        assertEq(blpvt.balanceOf(recipient), PVT_AMOUNT - PVT_FEE);
        assertEq(e.encumberedPVT(), 0);
        assertEq(blpvt.balanceOf(address(e)), 17 ether);
    }

    function test_18_happyPath_unchanged_noPullCredit() public {
        bytes32 id = _disputedUSDC();
        vm.prank(court);
        escrow.resolveDispute(id, true);
        assertEq(usdc.balanceOf(recipient), USDC_AMOUNT - USDC_FEE);
        assertEq(usdc.balanceOf(feeWallet), USDC_FEE);
        assertEq(escrow.pendingWithdrawal(id), 0);
        assertEq(escrow.pendingBeneficiary(id), address(0));
    }

    function test_18_e2e_castVote_releaseToBlacklistedRecipient_recordsVerdict() public {
        MockBlacklistUSDC bl = new MockBlacklistUSDC();
        MockPVT realPvt = new MockPVT();
        address e2eAdmin = address(0xEA);

        realPvt;

        ProvianRecourseEscrow realEscrow = new ProvianRecourseEscrow(e2eAdmin, feeWallet, address(bl), address(pvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), new ProvianRecourseEscrow.EscrowSeed[](0));
        ProvianRecourseCourt realCourt = new ProvianRecourseCourt(e2eAdmin, address(realEscrow), address(new MockEpochClock(0)), address(pvt), address(new MockIssuanceIndex()));
        vm.prank(e2eAdmin);
        realEscrow.setCourtContract(address(realCourt));

        address dep = address(0x1111);
        address rec = address(0x2222);
        bl.mint(dep, 10_000e6);
        vm.prank(dep);
        bl.approve(address(realEscrow), type(uint256).max);

        bytes32 id = keccak256("e2e-bl");
        vm.prank(dep);
        realEscrow.createEscrow(id, rec, USDC_AMOUNT, block.timestamp + 1 days, ProvianRecourseEscrow.Currency.USDC);
        vm.prank(dep);
        realEscrow.fundEscrow(id, false);
        vm.prank(dep);
        realEscrow.disputeEscrow(id);

        bl.setBlacklisted(rec, true);

        _escalate(realEscrow, id);
        address[3] memory panel = [address(0xA1), address(0xA2), address(0xA3)];
        vm.prank(e2eAdmin);
        realCourt.assignPanel(id, panel);
        _seatPanel(realCourt, id, panel);

        vm.prank(panel[0]);
        realCourt.castVote(id, true);

        vm.prank(panel[1]);
        realCourt.castVote(id, true);

        assertEq(uint8(realCourt.getDisputeStatus(id)), uint8(ProvianRecourseCourt.DisputeStatus.Resolved));
        (uint8 forRelease,) = realCourt.getVoteCounts(id);
        assertEq(forRelease, 2);
        assertEq(realEscrow.pendingWithdrawal(id), USDC_AMOUNT - USDC_FEE);
        assertEq(bl.balanceOf(feeWallet), USDC_FEE);

        bl.setBlacklisted(rec, false);
        realEscrow.withdrawResolvedFunds(id);
        assertEq(bl.balanceOf(rec), USDC_AMOUNT - USDC_FEE);
    }

    function test_18_resolveRefund_toBlacklistedDepositor_creditsPull() public {
        (ProvianRecourseEscrow e, MockBlacklistUSDC bl) = _escrowWithBlacklistUSDC();
        uint256 depStart = bl.balanceOf(depositor);
        bytes32 id = keccak256("bl-refund-dep");
        vm.prank(depositor);
        e.createEscrow(id, recipient, USDC_AMOUNT, block.timestamp + 1 days, ProvianRecourseEscrow.Currency.USDC);
        vm.prank(depositor);
        e.fundEscrow(id, false);
        vm.prank(depositor);
        e.disputeEscrow(id);

        bl.setBlacklisted(depositor, true);
        vm.prank(court);
        e.resolveDispute(id, false);

        assertEq(e.pendingWithdrawal(id), USDC_AMOUNT - USDC_FEE);
        assertEq(e.pendingBeneficiary(id), depositor);
        assertEq(bl.balanceOf(feeWallet), USDC_FEE);

        bl.setBlacklisted(depositor, false);
        e.withdrawResolvedFunds(id);

        assertEq(bl.balanceOf(depositor), depStart - USDC_FEE);
    }

    function test_4_claimDisputeTimeout_toBlacklistedDepositor_creditsPull() public {
        (ProvianRecourseEscrow e, MockBlacklistUSDC bl) = _escrowWithBlacklistUSDC();
        bytes32 id = keccak256("bl-timeout-dep");
        vm.prank(depositor);
        e.createEscrow(id, recipient, USDC_AMOUNT, block.timestamp + 1 days, ProvianRecourseEscrow.Currency.USDC);
        vm.prank(depositor);
        e.fundEscrow(id, false);
        vm.prank(depositor);
        e.disputeEscrow(id);

        bl.setBlacklisted(depositor, true);
        vm.warp(block.timestamp + e.DISPUTE_RESOLUTION_TIMEOUT() + 1);
        vm.prank(keeper);
        e.claimDisputeTimeout(id);
        assertEq(e.pendingWithdrawal(id), USDC_AMOUNT - USDC_FEE);
        assertEq(e.pendingBeneficiary(id), depositor);
    }

    function test_4_latePanelRace_timeoutWins_fundsSafe() public {
        MockUSDC u = new MockUSDC();
        MockPVT p = new MockPVT();
        address e2eAdmin = address(0xEA5);
        p;
        ProvianRecourseEscrow esc = new ProvianRecourseEscrow(e2eAdmin, feeWallet, address(u), address(pvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), new ProvianRecourseEscrow.EscrowSeed[](0));
        ProvianRecourseCourt crt = new ProvianRecourseCourt(e2eAdmin, address(esc), address(new MockEpochClock(0)), address(pvt), address(new MockIssuanceIndex()));
        vm.prank(e2eAdmin);
        esc.setCourtContract(address(crt));

        address dep = address(0x1111);
        address rec = address(0x2222);
        u.mint(dep, 10_000e6);
        vm.prank(dep);
        u.approve(address(esc), type(uint256).max);

        bytes32 id = keccak256("late-panel");
        vm.prank(dep);
        esc.createEscrow(id, rec, USDC_AMOUNT, block.timestamp + 400 days, ProvianRecourseEscrow.Currency.USDC);
        vm.prank(dep);
        esc.fundEscrow(id, false);
        vm.prank(dep);
        esc.disputeEscrow(id);
        uint256 escDeadline = esc.disputeDeadline(id);

        vm.warp(escDeadline - 1 hours);
        _escalate(esc, id);
        address[3] memory panel = [address(0xA1), address(0xA2), address(0xA3)];
        vm.prank(e2eAdmin);
        crt.assignPanel(id, panel);

        _seatPanel(crt, id, panel);
        uint256 courtDeadline = crt.getVotingDeadline(id);
        vm.prank(panel[0]);
        crt.castVote(id, true);

        vm.warp(escDeadline + 1);
        assertLt(block.timestamp, courtDeadline);

        uint256 depBefore = u.balanceOf(dep);
        vm.prank(keeper);
        esc.claimDisputeTimeout(id);
        assertEq(u.balanceOf(dep), depBefore + (USDC_AMOUNT - USDC_FEE));

        vm.prank(panel[1]);
        vm.expectRevert(ProvianRecourseCourt.EscrowSettledOutsideCourt.selector);
        crt.castVote(id, true);

        assertEq(u.balanceOf(rec), 0);
        assertEq(esc.pendingWithdrawal(id), 0);
        (, , , , , ProvianRecourseEscrow.Status st, , ) = esc.escrows(id);
        assertEq(uint8(st), uint8(ProvianRecourseEscrow.Status.Resolved));

        (, , , , uint256 required, , ) = crt.getPanelPosting(1, id);
        for (uint8 i = 0; i < 3; i++) {
            uint256 before = pvt.balanceOf(panel[i]);
            crt.settleArbitratorCollateral(1, id, i);
            assertGe(pvt.balanceOf(panel[i]), before + required, "seat stake returned");
        }
        assertEq(uint8(crt.getDisputeStatus(id)), uint8(ProvianRecourseCourt.DisputeStatus.Resolved));
        assertTrue(crt.settledOutsideCourt(keccak256(abi.encode(uint8(1), id))));
    }

    function _escalate(ProvianRecourseEscrow esc, bytes32 id) internal {
        address payer = address(0xFEE9);
        pvt.mint(payer, esc.disputeAdjudicationFee());
        vm.prank(payer);
        pvt.approve(address(esc), type(uint256).max);
        vm.prank(payer);
        esc.delegateToCourt(id);
    }

    function _seatPanel(ProvianRecourseCourt c, bytes32 id, address[3] memory panel) internal {
        for (uint256 i = 0; i < 3; i++) {
            pvt.mint(panel[i], 1_000_000e18);
            vm.prank(panel[i]);
            pvt.approve(address(c), type(uint256).max);
            vm.prank(panel[i]);
            c.postEscrowCollateral(id);
        }
    }

}
