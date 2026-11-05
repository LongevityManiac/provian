// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ProvianEscrowV4.sol";
import "./MockEpochClock.sol";
import "./MockIssuanceIndex.sol";
import "../src/ProvianCourtV2.sol";
import "./MockTokens.sol"; // MockUSDC, MockPVT, MockBlacklistUSDC, MockBlacklistPVT

/**
 * @title ProvianEscrowV4Pass3Test
 * @notice Pass-3 failure-path regression suite for ProvianEscrowV4.
 *
 *   #4  — EscrowV4 Disputed state had NO permissionless / timeout exit; admin or
 *         court inaction froze a good-faith depositor's principal indefinitely.
 *         Fix: claimDisputeTimeout — a symmetric, permissionless auto-refund to
 *         the depositor after DISPUTE_RESOLUTION_TIMEOUT.
 *   #18 — castVote → resolveDispute(true) pushed to the recipient in the SAME tx,
 *         so a reverting/blacklisted recipient reverted the whole vote and only
 *         the depositor-favorable outcome was reachable. Fix: the party payout is
 *         push-with-pull-fallback (_payoutOrCredit), so a reverting recipient can
 *         never revert the resolution/vote; funds sit as a pull credit.
 *
 * Each block includes the fail-before evidence (the frozen dead-ends / the token
 * revert that would have bricked an atomic push) alongside the pass-after proof.
 */
contract ProvianEscrowV4Pass3Test is Test {
    ProvianEscrowV4 public escrow;
    MockUSDC public usdc;
    MockPVT public pvt;

    address public admin = address(0xA01);
    address public feeWallet = address(0xFEE);
    address public depositor = address(0xD01);
    address public recipient = address(0xD02);
    address public court = address(0xC07);
    address public keeper = address(0xBEEF); // arbitrary permissionless caller

    uint256 public constant USDC_AMOUNT = 1000e6;
    uint256 public constant PVT_AMOUNT = 1000e18;
    uint256 public constant USDC_FEE = 5e6;
    uint256 public constant PVT_FEE = 5e18;

    function setUp() public {
        usdc = new MockUSDC();
        pvt = new MockPVT();
        escrow = new ProvianEscrowV4(admin, feeWallet, address(usdc), address(pvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), new ProvianEscrowV4.EscrowSeed[](0));

        usdc.mint(depositor, 100_000e6);
        pvt.mint(depositor, 100_000e18);
        vm.startPrank(depositor);
        usdc.approve(address(escrow), type(uint256).max);
        pvt.approve(address(escrow), type(uint256).max);
        vm.stopPrank();

        vm.prank(admin);
        escrow.setCourtContract(court);
    }

    // Helper: create + fund + dispute a USDC escrow, return its id.
    function _disputedUSDC() internal returns (bytes32 id) {
        id = keccak256(abi.encode("usdc-disp", block.timestamp, gasleft()));
        vm.prank(depositor);
        escrow.createEscrow(id, recipient, USDC_AMOUNT, block.timestamp + 1 days, ProvianEscrowV4.Currency.USDC);
        vm.prank(depositor);
        escrow.fundEscrow(id, false);
        vm.prank(depositor);
        escrow.disputeEscrow(id);
    }

    // ========================================================================
    // #4 — FAIL-BEFORE: the Disputed state's only pre-fix exits are all dead ends
    // ========================================================================

    function test_4_disputed_oldExitsAreAllDeadEnds() public {
        bytes32 id = _disputedUSDC();

        // releaseEscrow requires Funded — dead.
        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(
            ProvianEscrowV4.InvalidStatus.selector, ProvianEscrowV4.Status.Funded, ProvianEscrowV4.Status.Disputed));
        escrow.releaseEscrow(id);

        // Even a keeper after autoReleaseAt can't release a Disputed escrow.
        vm.warp(block.timestamp + 2 days);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(
            ProvianEscrowV4.InvalidStatus.selector, ProvianEscrowV4.Status.Funded, ProvianEscrowV4.Status.Disputed));
        escrow.releaseEscrow(id);

        // cancelEscrow requires Created — dead.
        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(
            ProvianEscrowV4.InvalidStatus.selector, ProvianEscrowV4.Status.Created, ProvianEscrowV4.Status.Disputed));
        escrow.cancelEscrow(id);

        // Funds are still sitting in the contract with no non-admin/court exit
        // (pre-fix, this is where the depositor's principal froze forever).
        assertEq(usdc.balanceOf(address(escrow)), USDC_AMOUNT);
    }

    // ========================================================================
    // #4 — PASS-AFTER: permissionless dispute-timeout refunds the depositor
    // ========================================================================

    function test_4_claimDisputeTimeout_refundsDepositor_USDC() public {
        uint256 depBefore = usdc.balanceOf(depositor);
        bytes32 id = _disputedUSDC();

        // Before the timeout: the escape is not yet available.
        vm.prank(keeper);
        vm.expectRevert(ProvianEscrowV4.DisputeTimeoutNotReached.selector);
        escrow.claimDisputeTimeout(id);

        // Warp past the timeout; ANYONE can trigger the refund.
        vm.warp(block.timestamp + escrow.DISPUTE_RESOLUTION_TIMEOUT() + 1);
        vm.prank(keeper);
        escrow.claimDisputeTimeout(id);

        // Depositor made whole (amount - fee); feeWallet keeps the fee (mirrors
        // resolveDispute(false)); contract drained; status Resolved.
        assertEq(usdc.balanceOf(depositor), depBefore - USDC_FEE);
        assertEq(usdc.balanceOf(feeWallet), USDC_FEE);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        (, , , , , ProvianEscrowV4.Status status, , ) = escrow.escrows(id);
        assertEq(uint8(status), uint8(ProvianEscrowV4.Status.Resolved));
    }

    function test_4_claimDisputeTimeout_refundsDepositor_PVT() public {
        uint256 depBefore = pvt.balanceOf(depositor);
        bytes32 id = keccak256("pvt-timeout");
        vm.prank(depositor);
        escrow.createEscrow(id, recipient, PVT_AMOUNT, block.timestamp + 1 days, ProvianEscrowV4.Currency.PVT);
        vm.prank(depositor);
        escrow.fundEscrow(id, false); // fee burned at funding
        vm.prank(depositor);
        escrow.disputeEscrow(id);

        vm.warp(block.timestamp + escrow.DISPUTE_RESOLUTION_TIMEOUT() + 1);
        vm.prank(keeper);
        escrow.claimDisputeTimeout(id);

        // Depositor recovers (amount - fee); the fee was already burned at funding.
        assertEq(pvt.balanceOf(depositor), depBefore - PVT_FEE);
        assertEq(pvt.balanceOf(recipient), 0);
        assertEq(pvt.balanceOf(address(escrow)), 0);
        assertEq(pvt.balanceOf(feeWallet), 0);
    }

    function test_4_claimDisputeTimeout_revertsIfNotDisputed() public {
        bytes32 id = keccak256("funded-only");
        vm.prank(depositor);
        escrow.createEscrow(id, recipient, USDC_AMOUNT, block.timestamp + 1 days, ProvianEscrowV4.Currency.USDC);
        vm.prank(depositor);
        escrow.fundEscrow(id, false);

        vm.warp(block.timestamp + 60 days);
        vm.expectRevert(abi.encodeWithSelector(
            ProvianEscrowV4.InvalidStatus.selector, ProvianEscrowV4.Status.Disputed, ProvianEscrowV4.Status.Funded));
        escrow.claimDisputeTimeout(id);
    }

    // Court retains PRIORITY: it can resolve before the timeout, and once it has,
    // the timeout escape is closed (no double-spend of the escrow).
    function test_4_courtHasPriority_thenTimeoutClosed() public {
        bytes32 id = _disputedUSDC();

        // Court resolves to recipient well before the timeout.
        vm.prank(court);
        escrow.resolveDispute(id, true);
        assertEq(usdc.balanceOf(recipient), USDC_AMOUNT - USDC_FEE);

        // The timeout escape now reverts (already Resolved) — no re-drain.
        vm.warp(block.timestamp + escrow.DISPUTE_RESOLUTION_TIMEOUT() + 1);
        vm.expectRevert(abi.encodeWithSelector(
            ProvianEscrowV4.InvalidStatus.selector, ProvianEscrowV4.Status.Disputed, ProvianEscrowV4.Status.Resolved));
        escrow.claimDisputeTimeout(id);
    }

    // Symmetric-outcome sanity: once the timeout has resolved to the depositor,
    // the court can no longer override it (race resolves once, deterministically).
    function test_4_afterTimeout_courtCannotOverride() public {
        bytes32 id = _disputedUSDC();
        vm.warp(block.timestamp + escrow.DISPUTE_RESOLUTION_TIMEOUT() + 1);
        vm.prank(keeper);
        escrow.claimDisputeTimeout(id);

        vm.prank(court);
        vm.expectRevert(abi.encodeWithSelector(
            ProvianEscrowV4.InvalidStatus.selector, ProvianEscrowV4.Status.Disputed, ProvianEscrowV4.Status.Resolved));
        escrow.resolveDispute(id, true);
    }

    // ========================================================================
    // #18 — FAIL-BEFORE evidence: a raw atomic push to a blacklisted recipient
    // reverts (the exact mechanism that bricked castVote pre-fix).
    // ========================================================================

    function test_18_evidence_atomicPushToBlacklistedReverts() public {
        MockBlacklistUSDC bl = new MockBlacklistUSDC();
        bl.mint(address(this), 100e6);
        bl.setBlacklisted(recipient, true);
        vm.expectRevert(abi.encodeWithSelector(MockBlacklistUSDC.AccountBlacklisted.selector, recipient));
        bl.transfer(recipient, 1e6);
    }

    // ========================================================================
    // #18 — PASS-AFTER: resolveDispute(release) to a blacklisted recipient does
    // NOT revert; the net is credited to a pull slot; the fee still reaches
    // feeWallet; the recipient withdraws once un-blacklisted.
    // ========================================================================

    function _escrowWithBlacklistUSDC() internal returns (ProvianEscrowV4 e, MockBlacklistUSDC bl) {
        bl = new MockBlacklistUSDC();
        e = new ProvianEscrowV4(admin, feeWallet, address(bl), address(pvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), new ProvianEscrowV4.EscrowSeed[](0));
        vm.prank(admin);
        e.setCourtContract(court);
        bl.mint(depositor, 100_000e6);
        vm.prank(depositor);
        bl.approve(address(e), type(uint256).max);
    }

    function test_18_resolveRelease_toBlacklistedRecipient_creditsPull_USDC() public {
        (ProvianEscrowV4 e, MockBlacklistUSDC bl) = _escrowWithBlacklistUSDC();
        bytes32 id = keccak256("bl-release");
        vm.prank(depositor);
        e.createEscrow(id, recipient, USDC_AMOUNT, block.timestamp + 1 days, ProvianEscrowV4.Currency.USDC);
        vm.prank(depositor);
        e.fundEscrow(id, false);
        vm.prank(depositor);
        e.disputeEscrow(id);

        // Recipient is blacklisted AFTER funding (Circle-style dynamic blacklist).
        bl.setBlacklisted(recipient, true);

        // The court resolves to the recipient. Pre-fix this reverted (nested
        // TransferFailed) and the verdict was un-executable. Now it succeeds.
        vm.prank(court);
        e.resolveDispute(id, true);

        // Recipient got nothing directly, but the net is a pull credit; the fee
        // still reached feeWallet; the verdict is recorded (status Resolved).
        assertEq(bl.balanceOf(recipient), 0);
        assertEq(e.pendingWithdrawal(id), USDC_AMOUNT - USDC_FEE);
        assertEq(e.pendingBeneficiary(id), recipient);
        assertEq(bl.balanceOf(feeWallet), USDC_FEE);
        (, , , , , ProvianEscrowV4.Status status, , ) = e.escrows(id);
        assertEq(uint8(status), uint8(ProvianEscrowV4.Status.Resolved));

        // While still blacklisted, the pull reverts and preserves the credit.
        vm.expectRevert(abi.encodeWithSelector(MockBlacklistUSDC.AccountBlacklisted.selector, recipient));
        e.withdrawResolvedFunds(id);
        assertEq(e.pendingWithdrawal(id), USDC_AMOUNT - USDC_FEE);

        // Once un-blacklisted, anyone can trigger the recipient's payout.
        bl.setBlacklisted(recipient, false);
        vm.prank(keeper);
        e.withdrawResolvedFunds(id);
        assertEq(bl.balanceOf(recipient), USDC_AMOUNT - USDC_FEE);
        assertEq(e.pendingWithdrawal(id), 0);

        // A second withdraw is a no-op revert (nothing left).
        vm.expectRevert(ProvianEscrowV4.NothingToWithdraw.selector);
        e.withdrawResolvedFunds(id);
    }

    function test_18_resolveRelease_toBlacklistedRecipient_creditsPull_PVT() public {
        MockBlacklistPVT blpvt = new MockBlacklistPVT();
        ProvianEscrowV4 e = new ProvianEscrowV4(admin, feeWallet, address(usdc), address(blpvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), new ProvianEscrowV4.EscrowSeed[](0));
        vm.prank(admin);
        e.setCourtContract(court);
        blpvt.mint(depositor, 100_000e18);
        vm.prank(depositor);
        blpvt.approve(address(e), type(uint256).max);

        bytes32 id = keccak256("bl-release-pvt");
        vm.prank(depositor);
        e.createEscrow(id, recipient, PVT_AMOUNT, block.timestamp + 1 days, ProvianEscrowV4.Currency.PVT);
        vm.prank(depositor);
        e.fundEscrow(id, false);
        vm.prank(depositor);
        e.disputeEscrow(id);

        blpvt.setBlacklisted(recipient, true);
        vm.prank(court);
        e.resolveDispute(id, true); // must not revert

        assertEq(blpvt.balanceOf(recipient), 0);
        assertEq(e.pendingWithdrawal(id), PVT_AMOUNT - PVT_FEE);

        blpvt.setBlacklisted(recipient, false);
        e.withdrawResolvedFunds(id);
        assertEq(blpvt.balanceOf(recipient), PVT_AMOUNT - PVT_FEE);
    }

    // Regression: the happy path (non-reverting recipient) is unchanged — funds
    // are delivered in the same tx and nothing is credited to the pull ledger.
    function test_18_happyPath_unchanged_noPullCredit() public {
        bytes32 id = _disputedUSDC();
        vm.prank(court);
        escrow.resolveDispute(id, true);
        assertEq(usdc.balanceOf(recipient), USDC_AMOUNT - USDC_FEE);
        assertEq(usdc.balanceOf(feeWallet), USDC_FEE);
        assertEq(escrow.pendingWithdrawal(id), 0);
        assertEq(escrow.pendingBeneficiary(id), address(0));
    }

    // ========================================================================
    // #18 — END-TO-END: real EscrowV4 + real CourtV2. Two panel votes to release
    // to a blacklisted recipient. The 2nd vote (which triggers resolveDispute in
    // the same tx) MUST record — pre-fix it reverted with nested TransferFailed.
    // ========================================================================

    function test_18_e2e_castVote_releaseToBlacklistedRecipient_recordsVerdict() public {
        MockBlacklistUSDC bl = new MockBlacklistUSDC();
        MockPVT realPvt = new MockPVT();
        address e2eAdmin = address(0xEA);

        realPvt; // retained: the suite-level `pvt` is bound below so escrow and court share one token
        // escalation routes a PVT fee from the escrow to the court, so the two
        // MUST bind the same token. Binding the suite-level `pvt` (which `_seatPanel`
        // already funds arbitrators in) lets this e2e exercise the REAL escalation path.
        ProvianEscrowV4 realEscrow = new ProvianEscrowV4(e2eAdmin, feeWallet, address(bl), address(pvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), new ProvianEscrowV4.EscrowSeed[](0));
        ProvianCourtV2 realCourt = new ProvianCourtV2(e2eAdmin, address(realEscrow), address(new MockEpochClock(0)), address(pvt), address(new MockIssuanceIndex()));
        vm.prank(e2eAdmin);
        realEscrow.setCourtContract(address(realCourt));

        address dep = address(0x1111);
        address rec = address(0x2222); // will be blacklisted
        bl.mint(dep, 10_000e6);
        vm.prank(dep);
        bl.approve(address(realEscrow), type(uint256).max);

        bytes32 id = keccak256("e2e-bl");
        vm.prank(dep);
        realEscrow.createEscrow(id, rec, USDC_AMOUNT, block.timestamp + 1 days, ProvianEscrowV4.Currency.USDC);
        vm.prank(dep);
        realEscrow.fundEscrow(id, false);
        vm.prank(dep);
        realEscrow.disputeEscrow(id);

        // Blacklist the recipient, then run a real 2-of-3 release vote.
        bl.setBlacklisted(rec, true);
        // escalate through the REAL escrow, paying the REAL flat adjudication
        // fee — `assignPanel` is gated on that fee having been routed in.
        _escalate(realEscrow, id);
        address[3] memory panel = [address(0xA1), address(0xA2), address(0xA3)];
        vm.prank(e2eAdmin);
        realCourt.assignPanel(id, panel);
        _seatPanel(realCourt, id, panel);

        vm.prank(panel[0]);
        realCourt.castVote(id, true);

        // The 2nd release vote resolves the dispute in the SAME tx. This is the
        // exact call that reverted pre-fix. It must now succeed.
        vm.prank(panel[1]);
        realCourt.castVote(id, true);

        // Verdict recorded on-chain; escrow resolved; net credited to a pull slot.
        assertEq(uint8(realCourt.getDisputeStatus(id)), uint8(ProvianCourtV2.DisputeStatus.Resolved));
        (uint8 forRelease,) = realCourt.getVoteCounts(id);
        assertEq(forRelease, 2);
        assertEq(realEscrow.pendingWithdrawal(id), USDC_AMOUNT - USDC_FEE);
        assertEq(bl.balanceOf(feeWallet), USDC_FEE);

        // The blacklisted recipient can still collect once cleared.
        bl.setBlacklisted(rec, false);
        realEscrow.withdrawResolvedFunds(id);
        assertEq(bl.balanceOf(rec), USDC_AMOUNT - USDC_FEE);
    }

    // ========================================================================
    // #18 (symmetric) — the DEPOSITOR-refund branch is likewise pull-safe: a
    // blacklisted depositor on resolveDispute(false) is credited, not a revert.
    // ========================================================================

    function test_18_resolveRefund_toBlacklistedDepositor_creditsPull() public {
        (ProvianEscrowV4 e, MockBlacklistUSDC bl) = _escrowWithBlacklistUSDC();
        uint256 depStart = bl.balanceOf(depositor);
        bytes32 id = keccak256("bl-refund-dep");
        vm.prank(depositor);
        e.createEscrow(id, recipient, USDC_AMOUNT, block.timestamp + 1 days, ProvianEscrowV4.Currency.USDC);
        vm.prank(depositor);
        e.fundEscrow(id, false);
        vm.prank(depositor);
        e.disputeEscrow(id);

        // Blacklist the DEPOSITOR, then the court refunds them.
        bl.setBlacklisted(depositor, true);
        vm.prank(court);
        e.resolveDispute(id, false); // must not revert

        assertEq(e.pendingWithdrawal(id), USDC_AMOUNT - USDC_FEE);
        assertEq(e.pendingBeneficiary(id), depositor);
        assertEq(bl.balanceOf(feeWallet), USDC_FEE);

        // Depositor recovers once cleared.
        bl.setBlacklisted(depositor, false);
        e.withdrawResolvedFunds(id);
        // Started depStart, funded USDC_AMOUNT, refunded (USDC_AMOUNT - USDC_FEE).
        assertEq(bl.balanceOf(depositor), depStart - USDC_FEE);
    }

    // #4 + #18 symmetric: claimDisputeTimeout to a blacklisted depositor credits
    // the pull ledger instead of reverting (the timeout can never be bricked).
    function test_4_claimDisputeTimeout_toBlacklistedDepositor_creditsPull() public {
        (ProvianEscrowV4 e, MockBlacklistUSDC bl) = _escrowWithBlacklistUSDC();
        bytes32 id = keccak256("bl-timeout-dep");
        vm.prank(depositor);
        e.createEscrow(id, recipient, USDC_AMOUNT, block.timestamp + 1 days, ProvianEscrowV4.Currency.USDC);
        vm.prank(depositor);
        e.fundEscrow(id, false);
        vm.prank(depositor);
        e.disputeEscrow(id);

        bl.setBlacklisted(depositor, true);
        vm.warp(block.timestamp + e.DISPUTE_RESOLUTION_TIMEOUT() + 1);
        vm.prank(keeper);
        e.claimDisputeTimeout(id); // must not revert
        assertEq(e.pendingWithdrawal(id), USDC_AMOUNT - USDC_FEE);
        assertEq(e.pendingBeneficiary(id), depositor);
    }

    // ========================================================================
    // #4 — DOCUMENTED RACE (funds-safe): if admin assigns a Court panel in the
    // last 48h of the 30-day window, the permissionless timeout can finalize
    // (refund depositor) before the panel's release verdict executes. Accepted:
    // the timeout is a backstop for a non-functional admin; the outcome is
    // non-custodial (depositor refunded) and no funds are ever double-spent. A
    // functional admin assigns panels promptly, long inside the window.
    // ========================================================================

    function test_4_latePanelRace_timeoutWins_fundsSafe() public {
        MockUSDC u = new MockUSDC();
        MockPVT p = new MockPVT();
        address e2eAdmin = address(0xEA5);
        p; // retained: the suite-level `pvt` is bound below so escrow and court share one token
        ProvianEscrowV4 esc = new ProvianEscrowV4(e2eAdmin, feeWallet, address(u), address(pvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), new ProvianEscrowV4.EscrowSeed[](0));
        ProvianCourtV2 crt = new ProvianCourtV2(e2eAdmin, address(esc), address(new MockEpochClock(0)), address(pvt), address(new MockIssuanceIndex()));
        vm.prank(e2eAdmin);
        esc.setCourtContract(address(crt));

        address dep = address(0x1111);
        address rec = address(0x2222);
        u.mint(dep, 10_000e6);
        vm.prank(dep);
        u.approve(address(esc), type(uint256).max);

        bytes32 id = keccak256("late-panel");
        vm.prank(dep);
        esc.createEscrow(id, rec, USDC_AMOUNT, block.timestamp + 400 days, ProvianEscrowV4.Currency.USDC);
        vm.prank(dep);
        esc.fundEscrow(id, false);
        vm.prank(dep);
        esc.disputeEscrow(id);
        uint256 escDeadline = esc.disputeDeadline(id); // dispute + 30 days

        // Admin assigns a panel just BEFORE the escrow timeout (1h prior), so the
        // Court's 48h vote window straddles the timeout.
        vm.warp(escDeadline - 1 hours);
        _escalate(esc, id);
        address[3] memory panel = [address(0xA1), address(0xA2), address(0xA3)];
        vm.prank(e2eAdmin);
        crt.assignPanel(id, panel);
        // institution deployment: the voting window opens on the third posting, so seat the panel before
        // reading the deadline this test straddles.
        _seatPanel(crt, id, panel);
        uint256 courtDeadline = crt.getVotingDeadline(id); // = escDeadline + 47h
        vm.prank(panel[0]);
        crt.castVote(id, true); // 1 release vote

        // Just past the escrow timeout but still well within the Court's window.
        vm.warp(escDeadline + 1);
        assertLt(block.timestamp, courtDeadline); // sanity: Court voting still open

        // The permissionless timeout finalizes first, refunding the depositor.
        uint256 depBefore = u.balanceOf(dep);
        vm.prank(keeper);
        esc.claimDisputeTimeout(id);
        assertEq(u.balanceOf(dep), depBefore + (USDC_AMOUNT - USDC_FEE));

        // The panel's 2nd release vote can no longer execute the release. the
        // Court now sees the escrow settled outside it and refuses the vote up front
        // (before this it reverted inside the escrow with InvalidStatus). NOT because
        // voting closed. Funds are already safely with the depositor; no double-spend.
        vm.prank(panel[1]);
        vm.expectRevert(ProvianCourtV2.EscrowSettledOutsideCourt.selector);
        crt.castVote(id, true);

        // Recipient never received anything; escrow Resolved; nothing left pending.
        assertEq(u.balanceOf(rec), 0);
        assertEq(esc.pendingWithdrawal(id), 0);
        (, , , , , ProvianEscrowV4.Status st, , ) = esc.escrows(id);
        assertEq(uint8(st), uint8(ProvianEscrowV4.Status.Resolved));

        // fix 2: every seat keeps its collateral. The escrow settled before the
        // panel's voting deadline, so no seat defaulted, and each stake comes back in
        // full through the permissionless settlement.
        (, , , , uint256 required, , ) = crt.getPanelPosting(1, id);
        for (uint8 i = 0; i < 3; i++) {
            uint256 before = pvt.balanceOf(panel[i]);
            crt.settleArbitratorCollateral(1, id, i);
            assertGe(pvt.balanceOf(panel[i]), before + required, "seat stake returned");
        }
        assertEq(uint8(crt.getDisputeStatus(id)), uint8(ProvianCourtV2.DisputeStatus.Resolved));
        assertTrue(crt.settledOutsideCourt(keccak256(abi.encode(uint8(1), id))));
    }

    /// @dev institution deployment: a panel must post per-case collateral before voting opens. Funds and
    ///      approves each seat on the court's bound PVT, then posts all three.
    /// @dev escalate a disputed escrow to a panel through the REAL contract,
    ///      paying the REAL flat adjudication fee. Not a shortcut — this is the only
    ///      way a panel becomes assignable, and it proves the escrow-to-court routing
    ///      end to end rather than pranking the court directly.
    function _escalate(ProvianEscrowV4 esc, bytes32 id) internal {
        address payer = address(0xFEE9);
        pvt.mint(payer, esc.disputeAdjudicationFee());
        vm.prank(payer);
        pvt.approve(address(esc), type(uint256).max);
        vm.prank(payer);
        esc.delegateToCourt(id);
    }

    function _seatPanel(ProvianCourtV2 c, bytes32 id, address[3] memory panel) internal {
        for (uint256 i = 0; i < 3; i++) {
            pvt.mint(panel[i], 1_000_000e18);
            vm.prank(panel[i]);
            pvt.approve(address(c), type(uint256).max);
            vm.prank(panel[i]);
            c.postEscrowCollateral(id);
        }
    }

}
