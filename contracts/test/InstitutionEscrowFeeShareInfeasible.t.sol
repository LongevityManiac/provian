// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ProvianEscrowV4.sol";
import "../src/ProvianCourtV2.sol";
import "./MockEpochClock.sol";
import "./MockIssuanceIndex.sol";
import {MockPVT, MockUSDC} from "./MockTokens.sol";

/**
 * @title InstitutionEscrowFeeShareInfeasibleTest
 * @notice institution deployment addendum-2 item 1. The directive asked for 's arbitrator
 * FEE SHARE to be extended from bond claims to ESCROW disputes. Resolved against
 * EscrowV4's actual fee model, it CANNOT be — and this suite pins the four source
 * facts that make it so, against the REAL ProvianEscrowV4 + ProvianCourtV2, so the
 * conclusion is re-checked on every run instead of rotting in a comment.
 *
 * The facts, each with its own control:
 * 1. EscrowV4 has NO dispute fee. Its only fee is 50 bps of PRINCIPAL, and on
 * the PVT branch it is BURNED AT FUNDING — nothing survives to pay a panel.
 * 2. On the USDC branch the fee IS held, and is paid out in USDC. The Court has
 * no USDC binding and its forfeiture rail is `IPVTBurnable.burn`, so a
 * forfeited USDC share has no compliant destination.
 * 3. The reward is CASE_BOND-only: an escrow seat earns its collateral back and
 * nothing more, even when a real reward exists under the same bytes32 id.
 * 4. The economics are a variable, not a floor — a per-seat share of a
 * PROPORTIONAL fee rises with principal and can be scheduled to exactly 0.
 *
 * throughout. Every claim here could pass vacuously if written carelessly
 * ("nothing was paid" over an empty population; "the fee was burned" over a zero
 * fee), so each test asserts its population is NON-EMPTY first, and the
 * burned/held and paid/not-paid pairs are asserted as OPPOSITE outcomes of the
 * SAME detector rather than one side alone. The economics numbers are READ from
 * the live contracts (`arbitratorCollateral()`, and the fee off a real escrow),
 * never redeclared here — a redeclared 50 bps or 75 PVT would make this suite
 * agree with itself instead of with the source.
 */
contract InstitutionEscrowFeeShareInfeasibleTest is Test {
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
    address internal arb1 = address(0xC01);
    address internal arb2 = address(0xC02);
    address internal arb3 = address(0xC03);

    uint64 internal constant EPOCH_START = 1_000_000;
    uint256 internal constant EPOCH = 7 days;
    uint256 internal constant FUND_PVT = 5_000_000e18;
    uint256 internal constant FUND_USDC = 5_000_000e6;

    uint8 internal constant CASE_ESCROW = 1;

    /// @dev `escrow.pvt_principal_cap` initial_atomic from the byte-frozen cost catalog —
    ///      a BACKEND literal, deliberately NOT an on-chain constant (asserted unset in
    ///      `test_report_perCaseEconomics_...`). Named here only to express "how far above
    ///      the largest permitted escrow the break-even sits".
    uint256 internal constant BACKEND_PRINCIPAL_CAP = 10_000e18;

    uint256 internal nonce;

    function setUp() public {
        pvt = new MockPVT();
        usdc = new MockUSDC();
        clock = new MockEpochClock(EPOCH_START);
        index = new MockIssuanceIndex();
        vm.warp(EPOCH_START);

        escrow = new ProvianEscrowV4(admin, feeWallet, address(usdc), address(pvt), address(clock), address(index), new ProvianEscrowV4.EscrowSeed[](0));
        court = new ProvianCourtV2(admin, address(escrow), address(clock), address(pvt), address(index));

        vm.startPrank(admin);
        escrow.setCourtContract(address(court));
        // The bond pool is only ever consulted as `msg.sender` by `fundBondClaimReward`,
        // so this test contract stands in for it to prove the CASE_BOND/CASE_ESCROW
        // namespacing without dragging in the whole pool.
        court.setBondPool(address(this));
        vm.stopPrank();

        address[5] memory actors = [depositor, recipient, arb1, arb2, arb3];
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

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _id() internal returns (bytes32) {
        nonce += 1;
        return keccak256(abi.encode("wp13-d171", nonce));
    }

    function _create(bytes32 id, uint256 principal, ProvianEscrowV4.Currency cur)
        internal
        returns (uint256 fee)
    {
        vm.prank(depositor);
        escrow.createEscrow(id, recipient, principal, block.timestamp + 30 days, cur);
        (, , , fee, , , , ) = escrow.escrows(id);
    }

    function _createFunded(bytes32 id, uint256 principal, ProvianEscrowV4.Currency cur)
        internal
        returns (uint256 fee)
    {
        fee = _create(id, principal, cur);
        vm.prank(depositor);
        escrow.fundEscrow(id, false);
    }

    /// @dev The fee the LIVE contract charges on `principal` right now. Reading it off a
    ///      real escrow is what keeps the economics bound to `activeFeeBps()` instead of
    ///      to a rate this test declares for itself.
    function _liveFee(uint256 principal) internal returns (uint256) {
        return _create(_id(), principal, ProvianEscrowV4.Currency.PVT);
    }

    // ---------------------------------------------------------------------
    // 1. The PVT-principal fee is destroyed before a dispute can exist
    // ---------------------------------------------------------------------

    function test_pvtPrincipalFee_isBurnedAtFunding_soNothingSurvivesToPayAPanel() public {
        uint256 principal = 1_000e18;
        bytes32 id = _id();
        uint256 burnedBefore = pvt.totalSelfBurned();

        uint256 fee = _createFunded(id, principal, ProvianEscrowV4.Currency.PVT);

        // Population: the claim below is worthless over a zero fee.
        assertGt(fee, 0, "population: the shipped rate must charge a real fee");
        assertEq(pvt.totalSelfBurned() - burnedBefore, fee, "the fee is SELF-BURNED at funding");
        assertEq(pvt.selfBurnedBy(address(escrow)), fee, "burned BY the escrow, on the IPVTBurnable rail");

        // The contract holds only the net. The second assertion is the control side: if
        // the burn were removed and the fee HELD (the only way to fund an escrow panel),
        // the balance would equal the full principal and this fails.
        assertEq(pvt.balanceOf(address(escrow)), principal - fee, "escrow holds the NET only");
        assertLt(pvt.balanceOf(address(escrow)), principal, "control: a held fee would make these equal");

        // And it is still true at the only moment a panel could be paid.
        vm.prank(depositor);
        escrow.disputeEscrow(id);
        assertEq(
            pvt.balanceOf(address(escrow)),
            principal - fee,
            "no fee pot appears at dispute time - there is nothing to route to the Court"
        );
    }

    /// @notice control for the test above: the same two detectors, opposite outcome.
    ///         On the USDC branch the fee IS held and nothing is burned, which proves the
    ///         "burned / not held" finding is read off the contract rather than hard-wired.
    function test_control_usdcPrincipalFee_isHeldNotBurned_soTheDetectorIsNotHardwired() public {
        uint256 principal = 1_000e6;
        uint256 burnedBefore = pvt.totalSelfBurned();

        uint256 fee = _createFunded(_id(), principal, ProvianEscrowV4.Currency.USDC);

        assertGt(fee, 0, "population: a real fee");
        assertEq(usdc.balanceOf(address(escrow)), principal, "fee HELD on this branch (not burned)");
        assertEq(pvt.totalSelfBurned() - burnedBefore, 0, "and nothing was burned");
    }

    // ---------------------------------------------------------------------
    // 2. The escrow fee that DOES survive to resolution is USDC, which the
    //    Court's forfeiture rail cannot consume
    // ---------------------------------------------------------------------

    function test_usdcFeeLegAtResolution_movesUSDCandZeroPVT_soAForfeitedShareHasNoBurnPath() public {
        bytes32 id = _id();
        uint256 fee = _createFunded(id, 1_000e6, ProvianEscrowV4.Currency.USDC);
        assertGt(fee, 0, "population: a real fee");

        uint256 feeWalletBefore = usdc.balanceOf(feeWallet);
        uint256 burnedBefore = pvt.totalSelfBurned();

        vm.prank(depositor);
        escrow.disputeEscrow(id);
        vm.prank(admin);
        escrow.resolveDispute(id, true);

        // The fee leg of an adjudicated escrow moves USDC, and only USDC.
        assertEq(usdc.balanceOf(feeWallet) - feeWalletBefore, fee, "the surviving fee is paid in USDC");
        assertEq(pvt.totalSelfBurned() - burnedBefore, 0, "no PVT is burned on the escrow fee leg");
        assertEq(pvt.balanceOf(address(court)), 0, "and no PVT reaches the Court to be split");
        // The Court holds no USDC either, so there is nothing it could pay a panel with
        // even if the reward block were made family-generic.
        assertEq(usdc.balanceOf(address(court)), 0, "the Court has no USDC binding at all");
    }

    // ---------------------------------------------------------------------
    // 3. An escrow seat earns NOTHING FROM THE PRINCIPAL FEE — proven while a real
    //    CASE_BOND reward exists under the SAME id, so the claim is not made over an
    //    empty population.
    //
    // RE-SCOPED BY, not deleted. This originally asserted the stronger "an
    // escrow seat earns collateral and nothing more", on 's premise that escrow
    //    arbitrators had no income at all. They now do — but from EscrowV4's SEPARATE
    //    flat adjudication fee, never from the principal fee this suite is about. The
    //    surviving, still-load-bearing claim is the one that made the SHARE infeasible:
    //    no part of the 50-bps principal fee reaches the panel, and no bond reward under
    //    a colliding id does either. `..._panelIncomeIsFlat_...` below pins the
    //    complement — that the income which DOES exist is independent of principal,
    //    which is exactly why it needs no price read.
    // ---------------------------------------------------------------------

    function test_escrowSeatEarnsNothingFromThePrincipalFee_evenWhileARewardExistsUnderTheSameId() public {
        bytes32 id = _id();
        uint256 pool = 30e18;

        // --- Control: fund a genuine CASE_BOND reward for this exact id and read it back.
        vm.recordLogs();
        court.fundBondClaimReward(id, pool);
        (bytes32 bondCaseKey, uint256 sharePerSeat) = _decodeRewardFunded();
        assertGt(sharePerSeat, 0, "control: a real reward exists");
        assertEq(sharePerSeat, pool / 3, "control: split three ways");
        assertEq(
            court.bondRewardSharePerSeat(bondCaseKey),
            sharePerSeat,
            "control: the detector reads a funded share when there is one"
        );

        // --- The claim: run a REAL escrow dispute under the same bytes32 and settle it.
        uint256 principalFee = _createFunded(id, 1_000e18, ProvianEscrowV4.Currency.PVT);
        assertGt(principalFee, 0, "population: a real principal fee was charged and burned");
        vm.prank(depositor);
        escrow.disputeEscrow(id);

        // escalation through the REAL escrow, paying the REAL flat fee. The
        // panel's whole income is this, and it is what the seat deltas below are
        // measured against — so "nothing from the principal fee" is a claim about a
        // seat that IS being paid, not about a seat that is paid nothing.
        uint256 adjFee = escrow.disputeAdjudicationFee();
        vm.prank(depositor);
        escrow.delegateToCourt(id);
        uint256 adjShare = court.escrowRewardSharePerSeat(keccak256(abi.encode(CASE_ESCROW, id)));
        assertEq(adjShare, adjFee / 3, "the flat fee is split across the same panel size");

        uint256 collateral = court.arbitratorCollateral();
        vm.prank(admin);
        court.assignPanel(id, [arb1, arb2, arb3]);
        vm.prank(arb1);
        court.postEscrowCollateral(id);
        vm.prank(arb2);
        court.postEscrowCollateral(id);
        vm.prank(arb3);
        court.postEscrowCollateral(id);

        // A 2-of-3 majority resolves the case, so no seat is at fault and every stake
        // comes back — the cleanest ground on which to ask "and was anything ELSE paid?".
        vm.prank(arb1);
        court.castVote(id, true);
        vm.recordLogs();
        vm.prank(arb2);
        court.castVote(id, true);

        address[3] memory panel = [arb1, arb2, arb3];
        for (uint8 seat = 0; seat < 3; seat++) {
            uint256 before = pvt.balanceOf(panel[seat]);
            court.settleArbitratorCollateral(CASE_ESCROW, id, seat);
            uint256 delta = pvt.balanceOf(panel[seat]) - before;
            // Seat 2 never voted (a 2-of-3 majority resolved past it), so it recovers its
            // stake but forfeits its share — the two branches in one case.
            uint256 expected = seat < 2 ? collateral + adjShare : collateral;
            assertEq(delta, expected, "escrow seat is paid its stake plus ONLY the flat adjudication share");
            // The load-bearing negatives: nothing from the principal fee, and nothing
            // from the bond reward funded under the same raw id.
            assertTrue(delta != collateral + sharePerSeat + adjShare, "NOT stake + adj share + a BOND share");
            assertTrue(delta != collateral + principalFee / 3, "NOT stake + a share of the PRINCIPAL fee");
        }
        assertEq(
            court.bondRewardSharePerSeat(keccak256(abi.encode(CASE_ESCROW, id))),
            0,
            "the escrow family never reads a bond reward share"
        );
    }

    /// @notice The property that makes the flat fee work where a share of the principal
    ///         fee could not: PANEL INCOME IS INDEPENDENT OF PRINCIPAL. Two escrows three
    ///         orders of magnitude apart fund the SAME per-seat share, so no PVT/USDC
    ///         conversion and no price read is ever needed to size it. Every figure is
    ///         READ from the live contracts.
    ///
    /// control: the same two principals are ALSO run through the live
    ///         principal-fee path in the same test, and those DO differ — so a hard-wired
    ///         "everything is equal" test cannot produce this result.
    function test_panelIncomeIsFlat_whileThePrincipalFeeIsNot() public {
        uint256 small = 100e18;
        uint256 large = 100_000e18;

        // Control: the principal fee is proportional, so these two are NOT equal.
        assertTrue(_liveFee(small) != _liveFee(large), "control: the principal fee varies with principal");

        uint256 shareSmall = _escalatedShare(small);
        uint256 shareLarge = _escalatedShare(large);
        assertGt(shareSmall, 0, "population: a real share was funded");
        assertEq(shareSmall, shareLarge, "the flat adjudication share is identical at 100 and 100,000 PVT");
        assertEq(shareSmall, escrow.disputeAdjudicationFee() / 3, "and equals the live flat fee split three ways");
    }

    /// @dev Create + fund + dispute + escalate an escrow of `principal`, returning the
    ///      per-seat share the Court recorded for it.
    function _escalatedShare(uint256 principal) internal returns (uint256) {
        bytes32 id = _id();
        _createFunded(id, principal, ProvianEscrowV4.Currency.PVT);
        vm.prank(depositor);
        escrow.disputeEscrow(id);
        vm.prank(depositor);
        escrow.delegateToCourt(id);
        return court.escrowRewardSharePerSeat(keccak256(abi.encode(CASE_ESCROW, id)));
    }

    // ---------------------------------------------------------------------
    // 4. The counterfactual economics: a variable, not a floor
    // ---------------------------------------------------------------------

    /// @notice The per-case economics the directive asked to be reported. Every input is
    ///         READ from the live contracts. The load-bearing assertion is not any single
    ///         ratio but that the ratios STRICTLY INCREASE with principal: a proportional
    ///         fee cannot put a floor under a fixed stake, which is the whole reason the
    /// pattern does not transfer. A flat escrow fee would fail this test.
    function test_report_perCaseEconomics_escrowCounterfactualIsAVariableNotAFloor() public {
        uint256 collateral = court.arbitratorCollateral();
        assertGt(collateral, 0, "population: a real stake is at risk");

        uint256 r100 = _ratioBps(100e18, collateral);
        uint256 r1k = _ratioBps(1_000e18, collateral);
        uint256 rCap = _ratioBps(BACKEND_PRINCIPAL_CAP, collateral);

        // Today's figures, derived not declared: 75 PVT staked per seat, against a share
        // of principal/600.  100 PVT escrow -> 0.22% · 1,000 -> 2.22% · 10,000 -> 22.2%.
        assertEq(collateral, 75e18, "live arbitrator collateral");
        assertEq(r100, 22, "0.22% of stake on a 100 PVT escrow");
        assertEq(r1k, 222, "2.22% on a 1,000 PVT escrow");
        assertEq(rCap, 2_222, "22.2% at the backend's 10,000 PVT principal cap");

        // THE CLAIM. 's bond reward is a constant 13.33% of stake because the
        // processing fee is FLAT; this one is a ramp, so on the small disputes that will
        // dominate it is a rounding error.
        assertLt(r100, r1k, "the return rises with principal...");
        assertLt(r1k, rCap, "...so it is a variable, never a floor");

        // Break-even (a seat earns back what it stakes), derived from the live rate.
        uint256 feeBps = (_liveFee(BACKEND_PRINCIPAL_CAP) * 10_000) / BACKEND_PRINCIPAL_CAP;
        assertEq(feeBps, 50, "live principal-fee rate");
        uint256 breakEven = (collateral * 3 * 10_000) / feeBps;
        assertEq(breakEven, 45_000e18, "reward == stake only at a 45,000 PVT escrow");
        assertEq(breakEven * 10, BACKEND_PRINCIPAL_CAP * 45, "4.5x the largest escrow the backend permits");

        // And that ceiling is a BACKEND literal: the on-chain cap is unset, which is why
        // it is named as a constant above rather than read from the contract.
        (bool capExists, ) = escrow.activePrincipalCap();
        assertFalse(capExists, "on-chain principal cap is unset; 10,000 PVT is the backend literal");
    }

    /// @notice The sharpest structural difference from the bond fee, and the reason this
    ///         could not be a durable fix even if it were plumbed: the escrow rate's
    ///         immutable band floor is 0 bps, so the "income" is schedulable to nothing.
    /// gave the bond processing fee an issuance-indexed FLOOR; EscrowV4
    ///         contains no `_indexFloor` at all, because a bps rate has no amount to index.
    function test_theEscrowFeeRateCanBeScheduledToZero_soThisIncomeHasNoFloor() public {
        // Control: at the shipped default the rate is live and non-zero.
        assertGt(_liveFee(1_000e18), 0, "control: the shipped rate charges something");

        vm.prank(admin);
        escrow.scheduleFeeBps(1, 0);
        vm.warp(EPOCH_START + EPOCH);

        (bool exists, uint256 value) = escrow.activeFeeBps();
        assertTrue(exists, "the override is active");
        assertEq(value, 0, "0 bps is inside the immutable band");
        assertEq(_liveFee(1_000e18), 0, "so the whole reward pool goes to zero, prospectively and legally");
    }

    // ---------------------------------------------------------------------
    // Log helpers — the case key comes from the contract's OWN event rather
    // than from a re-derivation of `_caseKey` here (a test that
    // recomputes the code's formula agrees with itself, not with the code).
    // ---------------------------------------------------------------------

    function _decodeRewardFunded() internal view returns (bytes32 caseKey, uint256 sharePerSeat) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("BondClaimRewardFunded(bytes32,uint256,uint256,uint256)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == sig) {
                caseKey = logs[i].topics[1];
                (, sharePerSeat, ) = abi.decode(logs[i].data, (uint256, uint256, uint256));
                return (caseKey, sharePerSeat);
            }
        }
        revert("BondClaimRewardFunded not emitted");
    }

    function _countRewardPaid() internal view returns (uint256 n) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("ArbitratorRewardPaid(bytes32,address,uint8,uint256)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == sig) n += 1;
        }
    }

    function _ratioBps(uint256 principal, uint256 collateral) internal returns (uint256) {
        uint256 share = _liveFee(principal) / 3;
        return (share * 10_000) / collateral;
    }
}
