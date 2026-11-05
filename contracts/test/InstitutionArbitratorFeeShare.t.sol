// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ProvianBondPool.sol";
import "../src/ProvianCourtV2.sol";
import "./MockEpochClock.sol";
import "./MockIssuanceIndex.sol";
import {MockPVT} from "./MockTokens.sol";

/// @dev Minimal escrow surface for the Court's panel conflict-of-interest checks.
contract InstitutionFeeShareMockEscrow {
    mapping(bytes32 => address) internal dep;
    mapping(bytes32 => address) internal rec;

    function setParties(bytes32 id, address depositor, address recipient) external {
        dep[id] = depositor;
        rec[id] = recipient;
    }

    function getParties(bytes32 id) external view returns (address, address) {
        return (dep[id], rec[id]);
    }

    /// @dev mirrors the real escrow, which stamps the settlement time on every
    ///      exit from Disputed; the Court reads it to close cases settled elsewhere.
    mapping(bytes32 => uint256) public disputeSettledAt;

    function resolveDispute(bytes32 id, bool) external {
        disputeSettledAt[id] = block.timestamp;
    }

    function settleOutsideCourt(bytes32 id) external {
        disputeSettledAt[id] = block.timestamp;
    }
}

/**
 * @title InstitutionArbitratorFeeShareTest
 * @notice institution deployment addendum item 1 : the arbitrator FEE SHARE.
 *
 * gave arbitrators a per-case collateral and NO income; the rational
 * strategy was never to post, so panels never form and every dispute ends in a
 * Dismiss-only timeout. This closes that with income: the claim PROCESSING FEE
 * (30 PVT at the shipped literal), which used to go 100% to Provian Tech, is
 * routed to the panel that adjudicated the claim — split three ways, paid to each
 * seat that BOTH posted AND voted, and BURNED for any seat that did not (never
 * redistributed).
 *
 * Wired against the REAL ProvianBondPool + ProvianCourtV2, so every claim is
 * proven by an actual token movement, not by a mock agreeing with the test.
 *
 * throughout: the "paid" and "burned" branches are asserted in the SAME
 * case (a rule that pays everyone, or burns everyone, fails one side), and the
 * forfeited-share destination is pinned to BURN vs REDISTRIBUTE explicitly.
 */
contract InstitutionArbitratorFeeShareTest is Test {
    ProvianBondPool internal bond;
    ProvianCourtV2 internal court;
    MockPVT internal pvt;
    MockEpochClock internal clock;
    MockIssuanceIndex internal index;
    InstitutionFeeShareMockEscrow internal escrow;

    address internal admin = address(0xA01);
    address internal tech = address(0x7EC4);
    address internal agent = address(0xB01); // bonded respondent
    address internal claimant = address(0xB02);
    address internal arb1 = address(0xC01);
    address internal arb2 = address(0xC02);
    address internal arb3 = address(0xC03);
    address internal outsider = address(0xD09);

    uint64 internal constant EPOCH_START = 1_000_000;
    uint256 internal constant FUND = 5_000_000e18;
    uint256 internal constant FILING_FEE = 15e18;

    uint8 internal constant CASE_BOND = 2;
    uint8 internal constant CASE_ESCROW = 1;

    function setUp() public {
        pvt = new MockPVT();
        clock = new MockEpochClock(EPOCH_START);
        index = new MockIssuanceIndex();
        escrow = new InstitutionFeeShareMockEscrow();
        vm.warp(EPOCH_START);

        bond = new ProvianBondPool(admin, tech, address(pvt), address(clock), address(index), new ProvianBondPool.BondSeed[](0), new ProvianBondPool.BpsSeed[](0));
        court = new ProvianCourtV2(admin, address(escrow), address(clock), address(pvt), address(index));

        vm.startPrank(admin);
        bond.setCourtContract(address(court));
        court.setBondPool(address(bond));
        vm.stopPrank();

        address[6] memory actors = [agent, claimant, arb1, arb2, arb3, outsider];
        for (uint256 i = 0; i < actors.length; i++) {
            pvt.mint(actors[i], FUND);
            vm.prank(actors[i]);
            pvt.approve(address(bond), type(uint256).max);
            vm.prank(actors[i]);
            pvt.approve(address(court), type(uint256).max);
        }
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------


    /// @dev EscrowV4 routes a flat PVT adjudication fee to the Court at
    ///      escalation, and `assignPanel` is gated on it having arrived. The wired
    ///      escrow here is a minimal double, so it is impersonated; the REAL routing is
    /// proven end-to-end against ProvianEscrowV4 in InstitutionEscrowAdjudicationFee.t.sol.
    uint256 internal constant ADJ_FEE = 30e18;

    function _fundEscrowAdj(bytes32 escrowId) internal {
        pvt.mint(address(court), ADJ_FEE);
        vm.prank(address(escrow));
        court.fundEscrowDisputeReward(escrowId, ADJ_FEE);
    }

    function _panel() internal view returns (address[3] memory) {
        return [arb1, arb2, arb3];
    }

    function _caseKey(bytes32 claimId) internal pure returns (bytes32) {
        return keccak256(abi.encode(CASE_BOND, claimId));
    }

    /// @dev The effective (indexed) processing fee the pool will actually charge — read
    ///      from the contract's own view so the test binds to the single source, never a
    ///      hand-copied literal. At the shipped thin index this is 30 PVT.
    function _processingFee() internal view returns (uint256) {
        (,,, uint256 processingFee,,) = bond.indexedRequirements();
        return processingFee;
    }

    function _postAndFile(bytes32 salt) internal returns (bytes32 claimId) {
        vm.prank(agent);
        bond.postBond(2, 0);
        claimId = keccak256(abi.encodePacked("feeshare", salt));
        vm.prank(claimant);
        bond.fileClaim(agent, claimId);
    }

    function _assign(bytes32 claimId) internal {
        vm.prank(admin);
        court.assignBondClaimPanel(claimId, _panel());
    }

    function _post(bytes32 claimId, address who) internal {
        vm.prank(who);
        court.postBondClaimCollateral(claimId);
    }

    function _postAll(bytes32 claimId) internal {
        _post(claimId, arb1);
        _post(claimId, arb2);
        _post(claimId, arb3);
    }

    function _vote(bytes32 claimId, address who, ProvianCourtV2.BondVerdictVote v) internal {
        vm.prank(who);
        court.castBondClaimVote(claimId, v);
    }

    /// @dev Settle one seat and return the reward paid to it, isolated from the collateral
    ///      returned in the same call (delta - stake). Stake is read BEFORE settlement,
    ///      when postedAmount[seat] still holds it.
    function _settleAndMeasureReward(bytes32 claimId, uint8 seat, address who)
        internal
        returns (uint256 rewardPaid, uint256 stakeReturned)
    {
        uint256 stake = court.getPostedAmount(CASE_BOND, claimId, seat);
        uint256 before = pvt.balanceOf(who);
        court.settleArbitratorCollateral(CASE_BOND, claimId, seat);
        uint256 delta = pvt.balanceOf(who) - before;
        // A returned seat gets stake (+ reward if it voted); a slashed seat gets 0 stake
        // (+ reward if it voted, though a slashed seat never voted). Decompose by the stake
        // that was posted: if the seat was returned, delta >= stake and reward = delta -
        // stake; if it was collateral-burned, delta < stake and stakeReturned = 0.
        if (delta >= stake) {
            stakeReturned = stake;
            rewardPaid = delta - stake;
        } else {
            stakeReturned = 0;
            rewardPaid = delta; // collateral burned; whatever came back is reward (0 here)
        }
    }

    // ==================================================================
    // Funding: the processing fee becomes the panel reward, not Provian's
    // ==================================================================

    /// @notice The core redirection. On an adjudicated dismissal the processing fee is
    ///         routed to the Court and split into three equal seat shares; Provian Tech
    ///         receives NONE of it (its deposit/renewal fees are a separate, untouched
    ///         line, taken at postBond above).
    function test_processingFee_fundsThePanel_notProvianTech() public {
        bytes32 claimId = _postAndFile("funds");
        _assign(claimId);
        _postAll(claimId);

        uint256 fee = _processingFee();
        assertEq(fee, 30e18, "shipped processing fee is 30 PVT");

        uint256 techBefore = pvt.balanceOf(tech);

        // 1/1/1 split resolves to Dismiss with ALL THREE having voted.
        _vote(claimId, arb1, ProvianCourtV2.BondVerdictVote.Dismiss);
        _vote(claimId, arb2, ProvianCourtV2.BondVerdictVote.SlashPartial);
        _vote(claimId, arb3, ProvianCourtV2.BondVerdictVote.SlashFull);

        bytes32 k = _caseKey(claimId);
        assertTrue(court.bondRewardFunded(k), "the reward was funded at resolution");
        assertEq(court.bondRewardSharePerSeat(k), fee / 3, "the fee is split three ways");
        assertEq(court.bondRewardSharePerSeat(k), 10e18, "== 10 PVT per seat at the shipped fee");
        assertEq(pvt.balanceOf(tech) - techBefore, 0, "Provian Tech gets NO processing fee (it funds the panel)");
    }

    /// @notice Each seat that posted AND voted is paid exactly its share (10 PVT), and
    ///         nothing is burned for the reward (no seat defaulted). The three shares sum
    ///         to the whole fee — the pool is not drained by the first settlement.
    function test_reward_paidToEverySeatThatPostedAndVoted() public {
        bytes32 claimId = _postAndFile("all-paid");
        _assign(claimId);
        _postAll(claimId);

        uint256 share = _processingFee() / 3;
        uint256 stakeEach = court.getPostedAmount(CASE_BOND, claimId, 0); // read BEFORE settle zeroes it

        _vote(claimId, arb1, ProvianCourtV2.BondVerdictVote.Dismiss);
        _vote(claimId, arb2, ProvianCourtV2.BondVerdictVote.SlashPartial);
        _vote(claimId, arb3, ProvianCourtV2.BondVerdictVote.SlashFull); // 1/1/1 -> Dismiss, all voted

        // Captured AFTER resolution (the dismiss already burned the claimant's filing fee).
        // What must not happen now is a REWARD burn during the three settlements.
        uint256 burnedBefore = pvt.totalBurned();

        (uint256 r0, uint256 s0) = _settleAndMeasureReward(claimId, 0, arb1);
        (uint256 r1, uint256 s1) = _settleAndMeasureReward(claimId, 1, arb2);
        (uint256 r2, uint256 s2) = _settleAndMeasureReward(claimId, 2, arb3);

        assertEq(r0, share, "seat 0 paid its share");
        assertEq(r1, share, "seat 1 paid its share");
        assertEq(r2, share, "seat 2 paid its share");
        assertEq(s0 + s1 + s2, 3 * stakeEach, "collateral returned to all three seats");
        assertEq(r0 + r1 + r2, _processingFee(), "the three shares sum to the whole fee");
        // Every seat voted, so no share is forfeited: the three settlements burn nothing.
        assertEq(pvt.totalBurned() - burnedBefore, 0, "no reward burned when every seat voted");
    }

    // ==================================================================
    // Posting alone cannot claim it: a non-voting seat FORFEITS (burns)
    // ==================================================================

    /// @notice THE DISCRIMINATOR (, both branches in one case). A 2-of-3 majority
    ///         resolves early; the third seat posted but never voted. The two voters are
    ///         PAID their share; the silent seat's share is BURNED — and its collateral is
    ///         still RETURNED (it was not at fault, only unpaid). If the rule paid everyone
    ///         the burn assertion fails; if it burned everyone the pay assertions fail.
    function test_nonVotingSeat_forfeitsRewardButKeepsCollateral() public {
        bytes32 claimId = _postAndFile("forfeit");
        _assign(claimId);
        _postAll(claimId);

        uint256 share = _processingFee() / 3;
        uint256 stake = court.getPostedAmount(CASE_BOND, claimId, 2);

        // 2-of-3 dismiss resolves at the second vote; arb3 never gets to vote.
        _vote(claimId, arb1, ProvianCourtV2.BondVerdictVote.Dismiss);
        _vote(claimId, arb2, ProvianCourtV2.BondVerdictVote.Dismiss);

        // Voters: paid.
        (uint256 r0,) = _settleAndMeasureReward(claimId, 0, arb1);
        (uint256 r1,) = _settleAndMeasureReward(claimId, 1, arb2);
        assertEq(r0, share, "voting seat 0 is paid");
        assertEq(r1, share, "voting seat 1 is paid");

        // Non-voter: collateral back, reward burned.
        uint256 burnedBefore = pvt.totalBurned();
        (uint256 r2, uint256 s2) = _settleAndMeasureReward(claimId, 2, arb3);
        assertEq(r2, 0, "the silent third seat earns NO fee");
        assertEq(s2, stake, "but its collateral is still RETURNED (no early-majority fault)");
        assertEq(pvt.totalBurned() - burnedBefore, share, "the forfeited share is BURNED");
    }

    /// @notice FORFEITED SHARES ARE NOT REDISTRIBUTED. In the same 2-of-3 case, the two
    ///         voters are paid EXACTLY one share each — not one-and-a-half — so the silent
    ///         seat's share went to the burn address, never to the seats that did vote.
    ///         (Redistribution would pay arbitrators to want colleagues to fail.)
    function test_forfeitedShare_isBurned_neverRedistributed() public {
        bytes32 claimId = _postAndFile("no-redistribute");
        _assign(claimId);
        _postAll(claimId);

        uint256 share = _processingFee() / 3;

        _vote(claimId, arb1, ProvianCourtV2.BondVerdictVote.Dismiss);
        _vote(claimId, arb2, ProvianCourtV2.BondVerdictVote.Dismiss); // arb3 silent

        (uint256 r0,) = _settleAndMeasureReward(claimId, 0, arb1);
        (uint256 r1,) = _settleAndMeasureReward(claimId, 1, arb2);
        assertEq(r0, share, "voter 0 gets one share, not a slice of the forfeited one");
        assertEq(r1, share, "voter 1 gets one share, not a slice of the forfeited one");
        assertLt(r0, 2 * share, "a redistributed share would show here");
    }

    /// @notice At a DEADLINE finalisation, an absent seat loses BOTH: its collateral is
    /// slashed (the existing rule) AND its fee share is forfeited. The one
    ///         seat that voted keeps its collateral and is paid.
    function test_deadlineFinalize_absentSeatLosesCollateralAndReward() public {
        bytes32 claimId = _postAndFile("deadline");
        _assign(claimId);
        _postAll(claimId);

        uint256 share = _processingFee() / 3;
        uint256 stake0 = court.getPostedAmount(CASE_BOND, claimId, 0);

        _vote(claimId, arb1, ProvianCourtV2.BondVerdictVote.Dismiss); // only arb1 votes
        vm.warp(vm.getBlockTimestamp() + 48 hours + 1);
        court.finalizeBondClaim(claimId); // resolvedByDeadline = true, dismiss

        // The voter: collateral returned + reward paid.
        (uint256 r0, uint256 s0) = _settleAndMeasureReward(claimId, 0, arb1);
        assertEq(s0, stake0, "the voter keeps its collateral");
        assertEq(r0, share, "the voter is paid");

        // An absent seat: collateral BURNED and reward BURNED.
        uint256 stake1 = court.getPostedAmount(CASE_BOND, claimId, 1);
        uint256 burnedBefore = pvt.totalBurned();
        (uint256 r1, uint256 s1) = _settleAndMeasureReward(claimId, 1, arb2);
        assertEq(s1, 0, "absent seat's collateral is not returned");
        assertEq(r1, 0, "absent seat earns no fee");
        assertEq(
            pvt.totalBurned() - burnedBefore,
            stake1 + share,
            "absent seat: collateral + reward both burned"
        );
    }

    // ==================================================================
    // Slash-path funding and its honest edge
    // ==================================================================

    /// @notice A 2-of-3 PARTIAL slash still leaves the bond above the fee, so the panel is
    ///         funded and the two voting arbitrators are paid.
    function test_partialSlash_stillFundsTheReward() public {
        bytes32 claimId = _postAndFile("partial-slash");
        _assign(claimId);
        _postAll(claimId);

        uint256 share = _processingFee() / 3;

        _vote(claimId, arb1, ProvianCourtV2.BondVerdictVote.SlashPartial);
        _vote(claimId, arb2, ProvianCourtV2.BondVerdictVote.SlashPartial); // 2-of-3 partial slash

        bytes32 k = _caseKey(claimId);
        assertTrue(court.bondRewardFunded(k), "partial slash leaves the bond above the fee -> funded");
        (uint256 r0,) = _settleAndMeasureReward(claimId, 0, arb1);
        assertEq(r0, share, "a voting arbitrator on a partial slash is paid");
    }

    /// @notice HONEST EDGE, asserted not hidden. A 2-of-3 FULL slash empties the bond, so
    ///         there is nothing left for the processing fee — no fee is charged and no
    ///         reward is funded. The arbitrators still recover their collateral in full.
    ///         (Inherent to "the fee is drawn from the residual bond"; not introduced by
    ///. A rational agent bonds well above the fee, so this is a corner.)
    function test_fullSlash_emptiesBond_soNoRewardIsFunded() public {
        bytes32 claimId = _postAndFile("full-slash");
        _assign(claimId);
        _postAll(claimId);

        _vote(claimId, arb1, ProvianCourtV2.BondVerdictVote.SlashFull);
        _vote(claimId, arb2, ProvianCourtV2.BondVerdictVote.SlashFull); // 2-of-3 full slash -> bond = 0

        (uint256 bondAmount,,,,,,) = bond.bonds(agent);
        assertEq(bondAmount, 0, "the bond is fully slashed");

        bytes32 k = _caseKey(claimId);
        assertFalse(court.bondRewardFunded(k), "no residual bond -> no processing fee -> no reward");
        assertEq(court.bondRewardSharePerSeat(k), 0, "share is zero");

        // The collateral is still returned in full to the voting arbitrators.
        (uint256 r0, uint256 s0) = _settleAndMeasureReward(claimId, 0, arb1);
        assertEq(r0, 0, "no reward when the bond could not fund the fee");
        assertGt(s0, 0, "but collateral is returned in full");
    }

    // ==================================================================
    // Scope guards: escrow and unassembled panels fund nothing
    // ==================================================================

    /// @notice SUPERSEDED BY, kept and re-scoped rather than deleted. This used to
    ///         assert "an escrow settle pays collateral only, never a reward", on the
    /// premise that escrow arbitrators were out of scope. They no longer
    ///         are: EscrowV4 charges its own FLAT adjudication fee and escrow seats are
    ///         paid from THAT. What still stands — and is what this now pins — is that
    ///         the two rails are SEPARATELY FUNDED and namespaced: an escrow settlement
    ///         is paid out of `escrowRewardSharePerSeat` and never touches
    ///         `bondRewardSharePerSeat`, so no bond respondent's processing fee can
    ///         leak into an escrow panel under a colliding id.
    function test_escrowDispute_paysFromItsOwnFee_neverFromTheBondReward() public {
        bytes32 escrowId = keccak256("escrow-case");
        escrow.setParties(escrowId, address(0xE1), address(0xE2));

        _fundEscrowAdj(escrowId);
        vm.prank(admin);
        court.assignPanel(escrowId, _panel());
        vm.prank(arb1);
        court.postEscrowCollateral(escrowId);
        vm.prank(arb2);
        court.postEscrowCollateral(escrowId);
        vm.prank(arb3);
        court.postEscrowCollateral(escrowId);

        vm.prank(arb1);
        court.castVote(escrowId, true);
        vm.prank(arb2);
        court.castVote(escrowId, true); // 2-of-3 resolves the escrow dispute

        // The bond mapping under the SAME raw id is untouched — the two families are
        // namespaced, so this is a real separation and not an accident of ordering.
        bytes32 escrowKey = keccak256(abi.encode(CASE_ESCROW, escrowId));
        bytes32 bondKey = keccak256(abi.encode(CASE_BOND, escrowId));
        assertEq(court.bondRewardSharePerSeat(bondKey), 0, "no bond reward exists for this id");
        assertEq(court.bondRewardSharePerSeat(escrowKey), 0, "escrow pay must not read the bond mapping");
        uint256 share = court.escrowRewardSharePerSeat(escrowKey);
        assertEq(share, ADJ_FEE / 3, "escrow share is the flat fee split three ways");

        uint256 stake = court.getPostedAmount(CASE_ESCROW, escrowId, 0);
        uint256 before = pvt.balanceOf(arb1);
        court.settleArbitratorCollateral(CASE_ESCROW, escrowId, 0);
        assertEq(
            pvt.balanceOf(arb1) - before,
            stake + share,
            "a voting escrow seat is paid its stake AND its adjudication-fee share"
        );
    }

    /// @notice An unassembled bond claim (panel never seated) funds no reward — the
    ///         processing fee is never charged, and posted seats get their stake back only.
    function test_unassembledPanel_fundsNoReward() public {
        bytes32 claimId = _postAndFile("unassembled");
        _assign(claimId);
        _post(claimId, arb1); // only one seat posts

        uint8 maxRounds = court.MAX_REPLACEMENT_ROUNDS();
        for (uint8 r = 0; r < maxRounds; r++) {
            vm.warp(vm.getBlockTimestamp() + 1 days + 1);
            vm.prank(admin);
            court.replaceBondClaimPanelSeat(claimId, 2, address(uint160(uint256(0xA000) + uint256(r))));
        }
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        court.closeUnassembledBondClaim(claimId);

        bytes32 k = _caseKey(claimId);
        assertFalse(court.bondRewardFunded(k), "no verdict, no processing fee, no reward");

        uint256 stake = court.getPostedAmount(CASE_BOND, claimId, 0);
        uint256 before = pvt.balanceOf(arb1);
        court.settleArbitratorCollateral(CASE_BOND, claimId, 0);
        assertEq(pvt.balanceOf(arb1) - before, stake, "the posted seat gets its stake, and no reward");
    }

    // ==================================================================
    // fundBondClaimReward authority + idempotence + dust
    // ==================================================================

    /// @notice Only the wired pool may fund a reward. An outsider is refused.
    function test_fundBondClaimReward_onlyBondPool() public {
        vm.prank(outsider);
        vm.expectRevert(ProvianCourtV2.NotBondPool.selector);
        court.fundBondClaimReward(keccak256("x"), 30e18);
    }

    /// @notice A claim can be funded once. The real flow resolves a claim exactly once, but
    ///         the guard is proven directly by pranking as the pool: the second call reverts.
    function test_fundBondClaimReward_isFundedOnce() public {
        bytes32 claimId = keccak256("once");
        // Give the Court the funds a real transfer would have delivered (fee divisible by 3
        // -> no dust burn needed for this guard test).
        pvt.mint(address(court), 30e18);

        vm.prank(address(bond));
        court.fundBondClaimReward(claimId, 30e18);
        assertEq(court.bondRewardSharePerSeat(_caseKey(claimId)), 10e18, "share recorded");

        vm.prank(address(bond));
        vm.expectRevert(ProvianCourtV2.RewardAlreadyFunded.selector);
        court.fundBondClaimReward(claimId, 30e18);
    }

    /// @notice The 3-way division remainder (dust) is BURNED at funding, so nothing is
    ///         stranded and the seat share never over-pays. 100 wei -> 33 per seat, 1 burned.
    function test_fundBondClaimReward_burnsDivisionDust() public {
        bytes32 claimId = keccak256("dust");
        pvt.mint(address(court), 100);

        uint256 burnedBefore = pvt.totalBurned();
        vm.prank(address(bond));
        court.fundBondClaimReward(claimId, 100);

        assertEq(court.bondRewardSharePerSeat(_caseKey(claimId)), 33, "floor(100/3) per seat");
        assertEq(pvt.totalBurned() - burnedBefore, 1, "the 1-wei remainder is burned, not stranded");
    }

    /// @notice CONTROL for the dust path: a fee divisible by 3 burns NOTHING. Without this,
    ///         "burns 1 wei" could be consistent with a rule that always burns a wei.
    function test_CONTROL_divisibleFee_burnsNoDust() public {
        bytes32 claimId = keccak256("nodust");
        pvt.mint(address(court), 30e18);

        uint256 burnedBefore = pvt.totalBurned();
        vm.prank(address(bond));
        court.fundBondClaimReward(claimId, 30e18);

        assertEq(court.bondRewardSharePerSeat(_caseKey(claimId)), 10e18);
        assertEq(pvt.totalBurned() - burnedBefore, 0, "a fee divisible by 3 strands and burns nothing");
    }

    // ==================================================================
    // Per-case economics report (the directive asks for this explicitly)
    // ==================================================================

    /// @notice REPORT: share per arbitrator against the 75 PVT posted. At the shipped
    ///         literals: 75 PVT collateral posted per seat, 10 PVT reward per seat on an
    ///         adjudicated case (30 PVT fee / 3), i.e. a 13.33% per-case return on the
    ///         locked stake, with the stake itself returned in full.
    function test_report_perCaseEconomics() public {
        bytes32 claimId = _postAndFile("report");
        _assign(claimId);

        uint256 collateral = court.arbitratorCollateral();
        assertEq(collateral, 75e18, "75 PVT posted per seat");

        uint256 sharePerSeat = _processingFee() / 3;
        assertEq(sharePerSeat, 10e18, "10 PVT reward per seat");

        // 10 / 75 = 13.33% (assert as basis points to avoid a rounded literal).
        assertEq((sharePerSeat * 10000) / collateral, 1333, "13.33% per-case return on the posted stake");
    }
}
