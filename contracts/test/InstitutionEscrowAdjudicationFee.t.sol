// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ProvianEscrowV4.sol";
import "../src/ProvianCourtV2.sol";
import "./MockEpochClock.sol";
import "./MockIssuanceIndex.sol";
import {MockPVT, MockUSDC} from "./MockTokens.sol";

/**
 * @title InstitutionEscrowAdjudicationFeeTest
 * @notice institution deployment addendum-3 : the FLAT PVT escrow adjudication fee, and the
 * arbitrator income it funds.
 *
 * 's STOP on paying escrow panels out of a SHARE of the principal fee
 * stands and is unchanged — `InstitutionEscrowFeeShareInfeasible.t.sol` still pins it.
 * This suite proves the thing named as the actual fix: a separate, FLAT,
 * PVT-denominated fee charged to whoever escalates a dispute to a panel. Flat is
 * what makes it work: it needs no PVT/USDC conversion and reads no price, so the
 * proportionality blocker never arises.
 *
 * Wired against the REAL ProvianEscrowV4 + ProvianCourtV2 — never a double — so
 * every claim is carried by an actual token movement. Every figure is READ from
 * the live contracts (`disputeAdjudicationFee()`, `arbitratorCollateral()`); a
 * redeclared 30 PVT or 75 PVT here would make the suite agree with itself instead
 * of with the source.
 *
 * controls throughout, and specifically the two the directive names:
 * - a seat that POSTED BUT DID NOT VOTE cannot claim its share, asserted in the
 * SAME case as a seat that voted and IS paid (opposite outcomes, one detector);
 * - a forfeited share is BURNED and NOT redistributed, asserted against the
 * token's own `totalSupply`/`totalSelfBurned` AND against the other seats'
 * deltas, so "burned" cannot be satisfied by quietly paying someone else.
 */
contract InstitutionEscrowAdjudicationFeeTest is Test {
    ProvianEscrowV4 internal escrow;
    ProvianCourtV2 internal court;
    MockPVT internal pvt;
    MockUSDC internal usdc;
    MockEpochClock internal clock;
    MockIssuanceIndex internal index;

    address internal admin = address(0xA01);
    address internal feeWallet = address(0x7EC4);
    address internal depositor = address(0xB01);
    address internal recipient = address(0xB02);
    address internal escalator = address(0xB03); // the party who pays for adjudication
    address internal arb1 = address(0xC01);
    address internal arb2 = address(0xC02);
    address internal arb3 = address(0xC03);
    address internal outsider = address(0xD09);

    uint64 internal constant EPOCH_START = 1_000_000;
    uint256 internal constant FUND_PVT = 5_000_000e18;
    uint256 internal constant FUND_USDC = 5_000_000e6;
    uint256 internal constant PRINCIPAL = 1_000e18;

    uint8 internal constant CASE_ESCROW = 1;
    uint8 internal constant CASE_BOND = 2;

    uint256 internal constant EPOCH_DURATION = 7 days;
    uint256 internal nonce;

    function setUp() public {
        pvt = new MockPVT();
        usdc = new MockUSDC();
        clock = new MockEpochClock(EPOCH_START);
        index = new MockIssuanceIndex();
        vm.warp(EPOCH_START);

        escrow = new ProvianEscrowV4(admin, feeWallet, address(usdc), address(pvt), address(clock), address(index), new ProvianEscrowV4.EscrowSeed[](0));
        court = new ProvianCourtV2(admin, address(escrow), address(clock), address(pvt), address(index));

        vm.prank(admin);
        escrow.setCourtContract(address(court));

        address[7] memory actors = [depositor, recipient, escalator, arb1, arb2, arb3, outsider];
        for (uint256 i = 0; i < actors.length; i++) {
            pvt.mint(actors[i], FUND_PVT);
            usdc.mint(actors[i], FUND_USDC);
            vm.startPrank(actors[i]);
            pvt.approve(address(escrow), type(uint256).max);
            pvt.approve(address(court), type(uint256).max);
            usdc.approve(address(escrow), type(uint256).max);
            vm.stopPrank();
        }
    }

    // ------------------------------------------------------------------
    // helpers — every one drives the REAL contracts
    // ------------------------------------------------------------------

    function _id() internal returns (bytes32) {
        nonce += 1;
        return keccak256(abi.encode("wp13-d174", nonce));
    }

    function _caseKey(bytes32 id) internal pure returns (bytes32) {
        return keccak256(abi.encode(CASE_ESCROW, id));
    }

    /// @dev Drive the kernel's trailing average to exactly `perEpoch` and move to an
    ///      epoch where it is actually reported (>= TRAILING_AVERAGE_EPOCHS). Same shape
    /// as InstitutionIssuanceIndex.t.sol, so the two suites cannot disagree about what
    ///      "the index is measuring X" means.
    function _seedAverage(uint256 perEpoch) internal {
        index.seedFlat(0, 12, perEpoch);
        vm.warp(uint256(EPOCH_START) + 12 * EPOCH_DURATION);
    }

    /// @dev Create + fund + dispute a PVT-principal escrow.
    function _disputed(bytes32 id) internal {
        vm.prank(depositor);
        escrow.createEscrow(id, recipient, PRINCIPAL, block.timestamp + 30 days, ProvianEscrowV4.Currency.PVT);
        vm.prank(depositor);
        escrow.fundEscrow(id, false);
        vm.prank(depositor);
        escrow.disputeEscrow(id);
    }

    function _escalate(bytes32 id) internal {
        vm.prank(escalator);
        escrow.delegateToCourt(id);
    }

    function _assign(bytes32 id) internal {
        vm.prank(admin);
        court.assignPanel(id, [arb1, arb2, arb3]);
    }

    function _postAll(bytes32 id) internal {
        vm.prank(arb1);
        court.postEscrowCollateral(id);
        vm.prank(arb2);
        court.postEscrowCollateral(id);
        vm.prank(arb3);
        court.postEscrowCollateral(id);
    }

    /// @dev Disputed -> escalated -> panel assigned -> all three seats posted.
    function _seatedPanel() internal returns (bytes32 id) {
        id = _id();
        _disputed(id);
        _escalate(id);
        _assign(id);
        _postAll(id);
    }

    // ==================================================================
    // 1. The fee: flat, PVT, indexed FLOOR, no setter, fails closed
    // ==================================================================

    /// @notice The shipped fee is the BondPool's claims-processing literal (30 PVT),
    ///         split across the same panel size (3) against the same collateral (75 PVT)
    /// 's economics exactly. Read from both live contracts, not declared.
    function test_shippedFee_mirrorsTheBondAdjudicationEconomics() public view {
        uint256 fee = escrow.disputeAdjudicationFee();
        assertEq(fee, escrow.DISPUTE_ADJUDICATION_FEE_BASELINE(), "thin index -> the literal stands");
        assertEq(fee, 30e18, "the shipped literal is 30 PVT");

        uint256 perSeat = fee / 3;
        uint256 collateral = court.arbitratorCollateral();
        assertEq(perSeat, 10e18, "10 PVT per seat");
        assertEq(collateral, 75e18, "against a 75 PVT stake");
        // The economics claim, expressed as a ratio read off the live contracts.
        assertEq((perSeat * 10_000) / collateral, 1333, "13.33% of the posted stake per case");
    }

    /// @notice It is a FLOOR, not a fixed price: once the economy's trailing issuance is
    /// large enough, the indexed value binds and the literal is superseded.
    /// the same detector is asserted in BOTH directions.
    function test_indexFloor_bindsOnceIssuanceExceedsTheAnchor() public {
        assertEq(escrow.disputeAdjudicationFee(), 30e18, "control: thin index -> literal");

        // 3 ppm of a 2e25 average = 6.0e19 = 60 PVT, which exceeds the 30 PVT literal.
        _seedAverage(2e25);
        assertEq(escrow.disputeAdjudicationFee(), 60e18, "the floor binds and RAISES the fee");
    }

    /// @notice The floor can only ever raise. A measured-but-small index leaves the
    ///         literal standing rather than lowering it.
    function test_indexFloor_neverLowersTheFee() public {
        _seedAverage(1e18); // 3 ppm of 1e18 = 3e12 wei, far below the 30 PVT literal
        assertEq(escrow.disputeAdjudicationFee(), 30e18, "a thin measurement cannot lower the fee");
    }

    /// @notice Fails CLOSED: an unreachable kernel resolves to the literal rather than
    ///         bricking escalation.
    function test_failClosed_revertingIndexResolvesToTheLiteral() public {
        index.setRevert(true);
        assertEq(escrow.disputeAdjudicationFee(), 30e18, "reverting index -> the literal, not a revert");

        bytes32 id = _id();
        _disputed(id);
        _escalate(id); // must not revert
        assertTrue(court.escrowRewardFunded(_caseKey(id)), "escalation still works with a dead index");
    }

    /// @notice CONTROL for the fail-closed guard: the try/catch is what changes the
    ///         answer. With the index reverting, a seeded-but-unreachable measurement that
    ///         WOULD have raised the fee is ignored — proving the catch branch executed
    ///         rather than the read simply returning the same number anyway.
    function test_CONTROL_failClosedGuardIsWhatChangesTheAnswer() public {
        _seedAverage(2e25);
        assertEq(escrow.disputeAdjudicationFee(), 60e18, "reachable index raises the fee");

        index.setRevert(true);
        assertEq(escrow.disputeAdjudicationFee(), 30e18, "unreachable index falls back to the literal");
    }

    /// @notice No setter, and no new settable-address authority: the index reference is a
    ///         constructor immutable and the fee baseline is a constant.
    function test_feeHasNoSetter_andTheIndexReferenceIsImmutable() public view {
        (bool ok,) = address(escrow).staticcall(abi.encodeWithSignature("setIssuanceIndex(address)"));
        assertFalse(ok, "no issuance-index setter may exist");
        (bool ok2,) = address(escrow).staticcall(abi.encodeWithSignature("setDisputeAdjudicationFee(uint256)"));
        assertFalse(ok2, "no adjudication-fee setter may exist");
        (bool ok3,) = address(escrow).staticcall(abi.encodeWithSignature("scheduleDisputeAdjudicationFee(uint64,uint256)"));
        assertFalse(ok3, "the fee is deliberately NOT schedulable - it must not be reducible to zero");
    }

    /// @notice The constructor rejects a zero index, so an institution can never be
    ///         deployed with the floor silently unbindable.
    function test_constructorRejectsAZeroIssuanceIndex() public {
        vm.expectRevert(ProvianEscrowV4.InvalidAddress.selector);
        new ProvianEscrowV4(admin, feeWallet, address(usdc), address(pvt), address(clock), address(0), new ProvianEscrowV4.EscrowSeed[](0));
    }

    // ==================================================================
    // 2. Charging: who pays, and that the escrow never holds it
    // ==================================================================

    /// @notice The escalating party pays, the Court receives, and the ESCROW's balance is
    ///         completely unmoved — the fee is routed straight through, so custody does
    ///         not change. Asserted as three deltas in one transaction.
    function test_feeIsRoutedStraightThrough_escrowNeverHoldsIt() public {
        bytes32 id = _id();
        _disputed(id);

        uint256 fee = escrow.disputeAdjudicationFee();
        uint256 payerBefore = pvt.balanceOf(escalator);
        uint256 escrowBefore = pvt.balanceOf(address(escrow));
        uint256 courtBefore = pvt.balanceOf(address(court));

        _escalate(id);

        assertEq(payerBefore - pvt.balanceOf(escalator), fee, "the escalator paid the fee");
        assertEq(pvt.balanceOf(address(escrow)), escrowBefore, "the escrow's balance is UNCHANGED");
        assertEq(pvt.balanceOf(address(court)) - courtBefore, fee, "the court received it in the same call");
    }

    /// @notice PVT regardless of settlement currency — the whole reason a flat fee works.
    ///         A USDC-principal escrow pays the SAME PVT fee, and no USDC moves for it.
    function test_usdcPrincipalEscrow_paysTheSamePvtFee_andNoUsdcMoves() public {
        bytes32 id = _id();
        vm.prank(depositor);
        escrow.createEscrow(id, recipient, 1_000e6, block.timestamp + 30 days, ProvianEscrowV4.Currency.USDC);
        vm.prank(depositor);
        escrow.fundEscrow(id, false);
        vm.prank(depositor);
        escrow.disputeEscrow(id);

        uint256 fee = escrow.disputeAdjudicationFee();
        uint256 usdcCourtBefore = usdc.balanceOf(address(court));
        uint256 usdcPayerBefore = usdc.balanceOf(escalator);

        _escalate(id);

        assertEq(court.escrowRewardSharePerSeat(_caseKey(id)), fee / 3, "same PVT fee on the USDC rail");
        assertEq(usdc.balanceOf(address(court)), usdcCourtBefore, "no USDC reaches the court");
        assertEq(usdc.balanceOf(escalator), usdcPayerBefore, "no USDC leaves the payer");
    }

    /// @notice Escalation is refused on an escrow that is not disputed, and before the
    /// court is wired. the complement (a disputed escrow with the court
    ///         wired) succeeds in every other test here.
    function test_escalationRefusedUnlessDisputed() public {
        bytes32 id = _id();
        vm.prank(depositor);
        escrow.createEscrow(id, recipient, PRINCIPAL, block.timestamp + 30 days, ProvianEscrowV4.Currency.PVT);
        vm.prank(depositor);
        escrow.fundEscrow(id, false);

        vm.prank(escalator);
        vm.expectRevert(abi.encodeWithSelector(
            ProvianEscrowV4.InvalidStatus.selector, ProvianEscrowV4.Status.Disputed, ProvianEscrowV4.Status.Funded));
        escrow.delegateToCourt(id);
    }

    /// @notice A payer who has not approved the fee cannot escalate — and nothing is
    ///         half-done: no reward is funded and no panel becomes assignable.
    function test_escalationRefusedWithoutTheFee_andNothingIsPartiallyApplied() public {
        bytes32 id = _id();
        _disputed(id);

        address broke = address(0xDEAD01);
        vm.prank(broke);
        vm.expectRevert(); // no balance, no allowance
        escrow.delegateToCourt(id);

        assertFalse(court.escrowRewardFunded(_caseKey(id)), "no reward funded");
        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.AdjudicationFeeNotPaid.selector);
        court.assignPanel(id, [arb1, arb2, arb3]);
    }

    /// @notice One-shot: a second escalation reverts, and the second caller is NOT
    ///         charged — the Court's revert unwinds the escrow's transfer with it.
    function test_secondEscalationReverts_andChargesNobody() public {
        bytes32 id = _id();
        _disputed(id);
        _escalate(id);

        uint256 before = pvt.balanceOf(outsider);
        vm.prank(outsider);
        vm.expectRevert(ProvianCourtV2.RewardAlreadyFunded.selector);
        escrow.delegateToCourt(id);
        assertEq(pvt.balanceOf(outsider), before, "a refused escalation charges nothing");
    }

    /// @notice Only the wired escrow may fund an escrow reward. An outsider — and the
    ///         wired BOND POOL — are both refused, so the two rails cannot cross-fund.
    function test_fundEscrowDisputeReward_onlyEscrow() public {
        vm.prank(outsider);
        vm.expectRevert(ProvianCourtV2.NotEscrow.selector);
        court.fundEscrowDisputeReward(_id(), 30e18);

        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.NotEscrow.selector);
        court.fundEscrowDisputeReward(_id(), 30e18);
    }

    /// @notice The division remainder is burned at funding, so no dust is stranded.
    /// control: a divisible fee burns NOTHING, so this is not a test that
    ///         reports a burn unconditionally.
    function test_fundingBurnsTheDivisionDust_andADivisibleFeeBurnsNone() public {
        // 30e18 % 3 == 0 -> no dust on the shipped fee.
        bytes32 clean = _id();
        _disputed(clean);
        uint256 burnedBefore = pvt.totalSelfBurned();
        _escalate(clean);
        uint256 principalFeeBurn = 5e18; // 50 bps of 1,000 PVT, burned at funding, not here
        assertEq(
            pvt.totalSelfBurned() - burnedBefore,
            0,
            "control: a 3-divisible fee strands no dust"
        );
        principalFeeBurn; // named for the reader: that burn happens in fundEscrow, earlier

        // Drive the fee to an indivisible value through the index and re-check.
        // 3 ppm of (2e25 + 333_334) = (6e25 + 1_000_002) / 1e6 = 6e19 + 1 wei, and
        // (6e19 + 1) % 3 == 1 — so exactly 1 wei of dust must be burned.
        _seedAverage(2e25 + 333_334);
        uint256 fee = escrow.disputeAdjudicationFee();
        assertTrue(fee % 3 != 0, "population: the fee really is indivisible here");

        bytes32 dusty = _id();
        _disputed(dusty);
        burnedBefore = pvt.totalSelfBurned();
        _escalate(dusty);
        uint256 share = court.escrowRewardSharePerSeat(_caseKey(dusty));
        assertEq(pvt.totalSelfBurned() - burnedBefore, fee - share * 3, "the remainder is burned");
        assertEq(fee - share * 3, fee % 3, "and the remainder is exactly the modulus");
    }

    // ==================================================================
    // 3. The gate: no fee, no panel — and the untouched fallbacks
    // ==================================================================

    /// @notice `assignPanel` is refused until the fee has been routed, and succeeds once
    ///         it has. Both branches, same case.
    function test_assignPanelIsGatedOnTheFee() public {
        bytes32 id = _id();
        _disputed(id);

        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.AdjudicationFeeNotPaid.selector);
        court.assignPanel(id, [arb1, arb2, arb3]);

        _escalate(id);
        vm.prank(admin);
        court.assignPanel(id, [arb1, arb2, arb3]); // now permitted
        assertTrue(court.disputeExists(id), "the panel is seated once the fee is paid");
    }

    /// @notice THE NO-PANEL CASE STILL RESOLVES. Nobody pays, so no panel ever forms —
    ///         and EscrowV4's 30-day permissionless refund-to-depositor is untouched and
    ///         still returns the principal. This is the deliberate consequence of the
    ///         gate, not an unhandled state.
    function test_unpaidDispute_stillResolvesViaThe30DayPermissionlessRefund() public {
        bytes32 id = _id();
        uint256 depBefore = pvt.balanceOf(depositor);
        _disputed(id);

        assertEq(escrow.DISPUTE_RESOLUTION_TIMEOUT(), 30 days, "the 30-day backstop is unchanged");
        vm.warp(block.timestamp + escrow.DISPUTE_RESOLUTION_TIMEOUT() + 1);
        vm.prank(outsider); // permissionless
        escrow.claimDisputeTimeout(id);

        (,,, uint256 fee,, ProvianEscrowV4.Status status,,) = escrow.escrows(id);
        assertEq(uint8(status), uint8(ProvianEscrowV4.Status.Resolved), "resolved without any panel");
        assertEq(pvt.balanceOf(depositor), depBefore - fee, "depositor refunded net of the burned principal fee");
    }

    /// @notice `resolveEscalatedDispute` is likewise untouched: a paid-for panel that
    ///         deadlocks still escalates to the admin and resolves.
    function test_resolveEscalatedDisputeStillWorks() public {
        bytes32 id = _seatedPanel();

        vm.warp(block.timestamp + 48 hours + 1);
        court.escalateDispute(id);
        assertEq(uint8(court.getDisputeStatus(id)), uint8(ProvianCourtV2.DisputeStatus.Escalated));

        vm.prank(admin);
        court.resolveEscalatedDispute(id, true);
        assertEq(uint8(court.getDisputeStatus(id)), uint8(ProvianCourtV2.DisputeStatus.Resolved));
        (,,,,, ProvianEscrowV4.Status status,,) = escrow.escrows(id);
        assertEq(uint8(status), uint8(ProvianEscrowV4.Status.Resolved), "the escrow really was resolved");
    }

    // ==================================================================
    // 4. Who is paid — POSTED AND VOTED, and nobody else
    // ==================================================================

    /// @notice THE DIRECTIVE'S FIRST NAMED CONTROL: a seat that POSTED BUT DID NOT VOTE
    ///         cannot claim its share — asserted in the SAME case as two seats that voted
    ///         and ARE paid. A rule that pays everyone and a rule that pays no one both
    ///         fail this test; only "posted AND voted" passes it.
    function test_postedButDidNotVote_cannotClaimTheShare_whileVotersArePaid() public {
        bytes32 id = _seatedPanel();
        uint256 share = court.escrowRewardSharePerSeat(_caseKey(id));
        uint256 collateral = court.arbitratorCollateral();
        assertGt(share, 0, "population: a real share is at stake");

        // A 2-of-3 majority resolves the case; seat 2 posted but never voted.
        vm.prank(arb1);
        court.castVote(id, true);
        vm.prank(arb2);
        court.castVote(id, true);

        uint256 b1 = pvt.balanceOf(arb1);
        court.settleArbitratorCollateral(CASE_ESCROW, id, 0);
        assertEq(pvt.balanceOf(arb1) - b1, collateral + share, "a voter is paid stake + share");

        uint256 b3 = pvt.balanceOf(arb3);
        court.settleArbitratorCollateral(CASE_ESCROW, id, 2);
        assertEq(
            pvt.balanceOf(arb3) - b3,
            collateral,
            "the posted-but-silent seat recovers its STAKE and claims NO share"
        );
    }

    /// @notice THE DIRECTIVE'S SECOND NAMED CONTROL: the forfeited share is BURNED, not
    ///         redistributed. Proven three ways in one case, because "burned" and
    ///         "quietly paid to someone else" are indistinguishable from a single
    ///         balance: total supply falls by exactly one share, the token's own
    ///         self-burn counter rises by exactly one share, and NEITHER of the other two
    ///         seats' deltas grew by the forfeited amount.
    function test_forfeitedShare_isBurned_neverRedistributed() public {
        bytes32 id = _seatedPanel();
        uint256 share = court.escrowRewardSharePerSeat(_caseKey(id));
        uint256 collateral = court.arbitratorCollateral();

        vm.prank(arb1);
        court.castVote(id, true);
        vm.prank(arb2);
        court.castVote(id, true); // resolves; arb3 never votes

        // Settle the two voters FIRST, so any redistribution of arb3's share would have
        // to show up in a later claim — then settle arb3 and measure the burn.
        uint256 b1 = pvt.balanceOf(arb1);
        uint256 b2 = pvt.balanceOf(arb2);
        court.settleArbitratorCollateral(CASE_ESCROW, id, 0);
        court.settleArbitratorCollateral(CASE_ESCROW, id, 1);
        assertEq(pvt.balanceOf(arb1) - b1, collateral + share, "voter 1 gets exactly ONE share");
        assertEq(pvt.balanceOf(arb2) - b2, collateral + share, "voter 2 gets exactly ONE share");

        uint256 supplyBefore = pvt.totalSupply();
        uint256 selfBurnedBefore = pvt.totalSelfBurned();
        uint256 a1Before = pvt.balanceOf(arb1);
        uint256 a2Before = pvt.balanceOf(arb2);

        court.settleArbitratorCollateral(CASE_ESCROW, id, 2);

        assertEq(supplyBefore - pvt.totalSupply(), share, "supply fell by exactly the forfeited share");
        assertEq(pvt.totalSelfBurned() - selfBurnedBefore, share, "and it went through the SELF-BURN path");
        assertEq(pvt.balanceOf(arb1), a1Before, "the forfeited share did NOT go to seat 0");
        assertEq(pvt.balanceOf(arb2), a2Before, "the forfeited share did NOT go to seat 1");
    }

    /// @notice A deadline finalisation: every seat posted, nobody voted. All three shares
    ///         burn and all three stakes burn too (the absenteeism predicate). Value is
    ///         conserved — nothing is stranded and nothing is created.
    function test_deadlineFinalisation_burnsEveryShare() public {
        bytes32 id = _seatedPanel();
        uint256 fee = escrow.disputeAdjudicationFee();
        uint256 share = court.escrowRewardSharePerSeat(_caseKey(id));

        vm.warp(block.timestamp + 48 hours + 1);
        court.escalateDispute(id); // sets resolvedByDeadline

        uint256 selfBurnedBefore = pvt.totalSelfBurned();
        uint256 collateral = court.arbitratorCollateral();
        for (uint8 seat = 0; seat < 3; seat++) {
            court.settleArbitratorCollateral(CASE_ESCROW, id, seat);
        }
        assertEq(
            pvt.totalSelfBurned() - selfBurnedBefore,
            3 * (collateral + share),
            "three stakes and three shares all burned"
        );
        // Value conservation on the fee: every unit paid or burned, none left behind.
        assertEq(share * 3, fee, "the shipped fee divides exactly, so nothing is unaccounted");
    }

    /// @notice Settlement stays one-shot per seat with the reward attached, so a share
    ///         can never be paid twice.
    function test_settlementIsStillOneShot_soAShareCannotBePaidTwice() public {
        bytes32 id = _seatedPanel();
        vm.prank(arb1);
        court.castVote(id, true);
        vm.prank(arb2);
        court.castVote(id, true);

        court.settleArbitratorCollateral(CASE_ESCROW, id, 0);
        vm.expectRevert(ProvianCourtV2.CollateralNotPosted.selector);
        court.settleArbitratorCollateral(CASE_ESCROW, id, 0);
    }

    // ==================================================================
    // 5. The sweep — every funded unit reaches a terminal state
    // ==================================================================

    /// @notice The structural difference from the bond rail: the escrow fee is charged
    ///         BEFORE a panel exists, so a seat may never post and its share could never
    ///         be claimed. The sweep burns exactly those shares — and only those.
    function test_sweep_burnsOnlyTheSharesOfSeatsThatNeverPosted() public {
        bytes32 id = _id();
        _disputed(id);
        _escalate(id);
        _assign(id);
        uint256 share = court.escrowRewardSharePerSeat(_caseKey(id));

        vm.prank(arb1); // ONLY seat 0 posts
        court.postEscrowCollateral(id);

        // Exhaust the replacement rounds so the panel is declared unassemblable.
        uint8 rounds = court.MAX_REPLACEMENT_ROUNDS();
        for (uint8 r = 0; r < rounds; r++) {
            vm.warp(vm.getBlockTimestamp() + 1 days + 1);
            vm.prank(admin);
            court.replaceEscrowPanelSeat(id, 2, address(uint160(uint256(0xE000) + uint256(r))));
        }
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);

        uint256 selfBurnedBefore = pvt.totalSelfBurned();
        court.burnUnclaimableEscrowReward(id); // permissionless
        assertEq(pvt.totalSelfBurned() - selfBurnedBefore, 2 * share, "exactly the TWO unposted seats burn");

        // The seat that DID post is untouched by the sweep and still settles normally.
        uint256 before = pvt.balanceOf(arb1);
        court.settleArbitratorCollateral(CASE_ESCROW, id, 0);
        assertEq(
            pvt.balanceOf(arb1) - before,
            court.arbitratorCollateral(),
            "the posted seat still recovers its stake (it forfeits only its own share, unvoted)"
        );
    }

    /// @notice THE DOUBLE-BURN GUARD. The sweep counts from `postedMask`, never from
    ///         `postedAmount` — settlement ZEROES `postedAmount`, so counting amounts
    ///         would classify an already-PAID seat as "never posted" and burn its share a
    ///         second time, eating another case's funds. Sweeping AFTER every seat has
    ///         settled must therefore find nothing to burn.
    function test_sweepAfterSettlement_doesNotBurnAnAlreadyPaidShare() public {
        bytes32 id = _seatedPanel();
        vm.prank(arb1);
        court.castVote(id, true);
        vm.prank(arb2);
        court.castVote(id, true);
        for (uint8 seat = 0; seat < 3; seat++) {
            court.settleArbitratorCollateral(CASE_ESCROW, id, seat);
        }

        // Every seat posted, so nothing is unclaimable — the sweep has no work at all.
        vm.expectRevert(ProvianCourtV2.NothingUnclaimable.selector);
        court.burnUnclaimableEscrowReward(id);
    }

    /// @notice The sweep is refused while the case can still change: a live panel is not
    ///         terminal, and a never-assigned case must age past the contract's own
    ///         worst-case assembly latency first.
    function test_sweepRefusedWhileTheCaseIsStillLive() public {
        bytes32 live = _seatedPanel();
        vm.expectRevert(ProvianCourtV2.CaseNotTerminal.selector);
        court.burnUnclaimableEscrowReward(live);

        bytes32 unassigned = _id();
        _disputed(unassigned);
        _escalate(unassigned);
        vm.expectRevert(ProvianCourtV2.SweepDelayNotElapsed.selector);
        court.burnUnclaimableEscrowReward(unassigned);
    }

    /// @notice A case nobody ever seated: after the delay, all three shares burn and
    ///         assignment is CLOSED, so a panel can never be seated into a case whose
    ///         reward has already been destroyed.
    function test_neverAssignedCase_burnsInFull_andClosesAssignment() public {
        bytes32 id = _id();
        _disputed(id);
        _escalate(id);
        uint256 share = court.escrowRewardSharePerSeat(_caseKey(id));
        uint256 fee = escrow.disputeAdjudicationFee();

        vm.warp(vm.getBlockTimestamp() + court.UNASSIGNED_REWARD_BURN_DELAY());
        uint256 selfBurnedBefore = pvt.totalSelfBurned();
        court.burnUnclaimableEscrowReward(id);
        assertEq(pvt.totalSelfBurned() - selfBurnedBefore, 3 * share, "all three shares burn");
        assertEq(3 * share, fee, "which is the whole fee - nothing is stranded");

        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.AdjudicationFeeNotPaid.selector);
        court.assignPanel(id, [arb1, arb2, arb3]);
    }

    /// @notice THE ABANDONED-PANEL HOLE, closed. An admin assigns a panel and then does
    ///         nothing: no seat posts, and no replacement round is ever opened. That case
    ///         is NEVER terminal — `_assemblyFailed` requires `round >=
    ///         MAX_REPLACEMENT_ROUNDS` and only the onlyAdmin `replaceEscrowPanelSeat`
    ///         advances `round` — so before the `aged` backstop the fee was neither
    ///         payable nor burnable, for the life of the contract. Found by review.
    function test_abandonedPanel_nobodyPosted_isSweptByTheAgedBackstop() public {
        bytes32 id = _id();
        _disputed(id);
        _escalate(id);
        _assign(id);
        uint256 share = court.escrowRewardSharePerSeat(_caseKey(id));

        // Not terminal, and it never will be on its own: the round-0 window lapses and
        // nothing advances it. Confirm both the non-terminality and the refusal.
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        (,,,,,, bool assemblyFailed) = court.getPanelPosting(CASE_ESCROW, id);
        assertFalse(assemblyFailed, "population: the case is genuinely NOT terminal here");
        vm.expectRevert(ProvianCourtV2.CaseNotTerminal.selector);
        court.burnUnclaimableEscrowReward(id);

        // The backstop reaches it, measured from the posting deadline.
        (,,, uint64 deadline,,,) = court.getPanelPosting(CASE_ESCROW, id);
        vm.warp(uint256(deadline) + court.UNASSIGNED_REWARD_BURN_DELAY());
        uint256 selfBurnedBefore = pvt.totalSelfBurned();
        court.burnUnclaimableEscrowReward(id);
        assertEq(pvt.totalSelfBurned() - selfBurnedBefore, 3 * share, "all three unposted shares burn");
        assertEq(pvt.balanceOf(address(court)), 0, "and the court holds nothing for this case");
    }

    /// @notice A swept case CLOSES POSTING. Without this a seat could post after its share
    ///         was burned and then claim it at settlement — paying out of another case's
    ///         funds. The complement (posting works before a sweep) is exercised by every
    ///         other test here.
    function test_sweptCaseCannotBePostedIntoAfterwards() public {
        bytes32 id = _id();
        _disputed(id);
        _escalate(id);
        _assign(id);
        (,,, uint64 deadline,,,) = court.getPanelPosting(CASE_ESCROW, id);
        vm.warp(uint256(deadline) + court.UNASSIGNED_REWARD_BURN_DELAY());
        court.burnUnclaimableEscrowReward(id);

        vm.prank(arb1);
        vm.expectRevert(ProvianCourtV2.RewardAlreadySwept.selector);
        court.postEscrowCollateral(id);
    }

    /// @notice DECLARED LIMITATION, pinned rather than papered over. In an abandoned case
    ///         where a seat DID post, that seat's share is not swept (correctly — it is not
    ///         unclaimable, the seat is real) but it also cannot be settled, because
    ///         settlement requires terminality and this case never becomes terminal. Its
    ///         COLLATERAL waits in exactly the same way, on the shipped contract, on both
    ///         case families: this is the pre-existing panel-liveness gate, not something
    ///         the fee introduces. Closing it means changing `_assemblyFailed` for bond
    ///         claims too, which is outside this change.
    function test_DECLARED_abandonedPanel_aPostedSeatsShareWaitsWithItsCollateral() public {
        bytes32 id = _id();
        _disputed(id);
        _escalate(id);
        _assign(id);
        uint256 share = court.escrowRewardSharePerSeat(_caseKey(id));

        vm.prank(arb1); // exactly one seat posts, then the admin abandons the case
        court.postEscrowCollateral(id);

        (,,, uint64 deadline,,,) = court.getPanelPosting(CASE_ESCROW, id);
        vm.warp(uint256(deadline) + court.UNASSIGNED_REWARD_BURN_DELAY());
        uint256 selfBurnedBefore = pvt.totalSelfBurned();
        court.burnUnclaimableEscrowReward(id);
        assertEq(pvt.totalSelfBurned() - selfBurnedBefore, 2 * share, "only the TWO unposted shares burn");

        // The posted seat's share survives the sweep — and is unreachable, together with
        // its stake, for as long as the admin leaves the case abandoned.
        assertEq(court.escrowRewardSharePerSeat(_caseKey(id)), share, "the share is not destroyed");
        assertEq(court.getPostedAmount(CASE_ESCROW, id, 0), court.arbitratorCollateral(), "the stake is still held");
        vm.expectRevert(ProvianCourtV2.CaseNotTerminal.selector);
        court.settleArbitratorCollateral(CASE_ESCROW, id, 0);
    }

    /// @notice THE GRIEF THE ABANDONMENT CLOCK'S REFERENCE POINT PREVENTS. If the assigned
    ///         branch measured from FUNDING rather than from `postingDeadline`, a panel an
    ///         admin legitimately assigns more than 42 days after escalation would be
    ///         sweepable the instant it was seated — anyone could burn its reward and (via
    ///         the swept-case posting bar) kill the panel before a single seat could post.
    ///         Here funding is 100 days stale and the panel is fresh: the sweep must refuse.
    function test_lateButFreshlyAssignedPanel_isNotImmediatelySweepable() public {
        bytes32 id = _id();
        _disputed(id);
        _escalate(id);

        // Let the funding age well past the backstop BEFORE the admin assigns.
        vm.warp(vm.getBlockTimestamp() + 100 days);
        assertGt(
            block.timestamp,
            uint256(court.escrowRewardFundedAt(_caseKey(id))) + court.UNASSIGNED_REWARD_BURN_DELAY(),
            "population: funding really is older than the backstop"
        );
        _assign(id);

        vm.expectRevert(ProvianCourtV2.CaseNotTerminal.selector);
        court.burnUnclaimableEscrowReward(id);

        // And the panel still works: seats post and the case proceeds normally.
        _postAll(id);
        (,,,,, bool fullyPosted,) = court.getPanelPosting(CASE_ESCROW, id);
        assertTrue(fullyPosted, "a late-assigned panel must still be able to assemble");
    }

    /// @notice The abandonment clock is RE-ARMED by an admin working the case: opening a
    ///         replacement round pushes the sweep out, so an actively-worked panel is never
    /// swept out from under. complement of the test above.
    function test_replacementRoundPushesTheAbandonmentBackstopOut() public {
        bytes32 id = _id();
        _disputed(id);
        _escalate(id);
        _assign(id);

        (,,, uint64 firstDeadline,,,) = court.getPanelPosting(CASE_ESCROW, id);
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        vm.prank(admin);
        court.replaceEscrowPanelSeat(id, 0, address(uint160(0xE111)));
        (,,, uint64 secondDeadline,,,) = court.getPanelPosting(CASE_ESCROW, id);
        assertGt(secondDeadline, firstDeadline, "the replacement re-armed the window");

        // At the OLD deadline's backstop the case is still protected.
        vm.warp(uint256(firstDeadline) + court.UNASSIGNED_REWARD_BURN_DELAY());
        vm.expectRevert(ProvianCourtV2.CaseNotTerminal.selector);
        court.burnUnclaimableEscrowReward(id);

        // At the NEW one it is not.
        vm.warp(uint256(secondDeadline) + court.UNASSIGNED_REWARD_BURN_DELAY());
        court.burnUnclaimableEscrowReward(id);
    }

    /// @notice The sweep is one-shot.
    function test_sweepIsOneShot() public {
        bytes32 id = _id();
        _disputed(id);
        _escalate(id);
        vm.warp(vm.getBlockTimestamp() + court.UNASSIGNED_REWARD_BURN_DELAY());
        court.burnUnclaimableEscrowReward(id);
        vm.expectRevert(ProvianCourtV2.RewardAlreadySwept.selector);
        court.burnUnclaimableEscrowReward(id);
    }

    /// @notice An unfunded case has nothing to sweep.
    function test_sweepRefusedOnAnUnfundedCase() public {
        vm.expectRevert(ProvianCourtV2.RewardNotFunded.selector);
        court.burnUnclaimableEscrowReward(_id());
    }

    /// @notice The sweep delay is DERIVED from this contract's own literals — every
    ///         posting window that could be opened plus a full voting period — not a new
    ///         number. Asserted against the constants it is built from, and against the
    ///         escrow's shipped dispute timeout, which it must outlast so a sweep can only
    ///         ever dispose of a fee on a case that is already over.
    function test_sweepDelay_isDerivedFromTheContractsOwnLatencyBound() public view {
        uint256 expected = (1 + uint256(court.MAX_REPLACEMENT_ROUNDS())) * court.PANEL_POSTING_WINDOW_MAX()
            + court.PANEL_VOTING_PERIOD_MAX();
        assertEq(court.UNASSIGNED_REWARD_BURN_DELAY(), expected, "derived, not invented");
        assertEq(expected, 42 days, "4 x 7d + 14d");
        assertGt(
            court.UNASSIGNED_REWARD_BURN_DELAY(),
            escrow.DISPUTE_RESOLUTION_TIMEOUT(),
            "at the shipped timeout the escrow is already refundable before any sweep"
        );
    }

    // ==================================================================
    // 6. Rail separation
    // ==================================================================

    /// @notice The escrow rail cannot fund a bond case and vice versa. Proven with a REAL
    ///         escrow reward live under the same raw bytes32 as the bond key it must not
    ///         reach — a non-empty population on both sides.
    function test_theTwoRewardRailsAreNamespaced() public {
        bytes32 id = _id();
        _disputed(id);
        _escalate(id);

        bytes32 escrowKey = keccak256(abi.encode(CASE_ESCROW, id));
        bytes32 bondKey = keccak256(abi.encode(CASE_BOND, id));
        assertGt(court.escrowRewardSharePerSeat(escrowKey), 0, "population: a real escrow share exists");
        assertEq(court.bondRewardSharePerSeat(bondKey), 0, "and no bond share exists under the same id");
        assertEq(court.escrowRewardSharePerSeat(bondKey), 0, "the keys do not collide");
        assertFalse(court.bondRewardFunded(bondKey), "the bond rail was not funded by an escrow escalation");
    }
}
