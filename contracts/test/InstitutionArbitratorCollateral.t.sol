// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ProvianBondPool.sol";
import "../src/ProvianCourtV2.sol";
import "./MockEpochClock.sol";
import "./MockIssuanceIndex.sol";
import {MockPVT} from "./MockTokens.sol";

/// @dev Minimal escrow surface for the Court's panel conflict-of-interest checks.
contract InstitutionCollateralMockEscrow {
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
 * @title InstitutionArbitratorCollateralTest
 * @notice institution deployment directive item 3: arbitrator PER-CASE collateral, and the panel
 * liveness rule that has to come with it.
 *
 * Wired against the REAL ProvianBondPool, not a double, so the terminal
 * "panel never assembled -> filing fee REFUNDED" claim is proven by an
 * actual token movement rather than by a mock agreeing with the test.
 *
 * throughout: every guard is fed an input that violates it, and the
 * COMPLEMENT of each refusal is asserted too — a guard that refuses
 * everything is just as broken as one that refuses nothing.
 */
contract InstitutionArbitratorCollateralTest is Test {
    ProvianBondPool internal bond;
    ProvianCourtV2 internal court;
    MockPVT internal pvt;
    MockEpochClock internal clock;
    MockIssuanceIndex internal index;
    InstitutionCollateralMockEscrow internal escrow;

    address internal admin = address(0xA01);
    address internal tech = address(0x7EC4);
    address internal agent = address(0xB01); // bonded respondent
    address internal claimant = address(0xB02);
    address internal arb1 = address(0xC01);
    address internal arb2 = address(0xC02);
    address internal arb3 = address(0xC03);
    address internal arb4 = address(0xC04); // replacement
    address internal outsider = address(0xD09);

    uint64 internal constant EPOCH_START = 1_000_000;
    uint256 internal constant FUND = 5_000_000e18;
    uint256 internal constant FILING_FEE = 15e18;

    /// @dev The family discriminator the Court namespaces posting state by.
    uint8 internal constant CASE_BOND = 2;
    uint8 internal constant CASE_ESCROW = 1;

    function setUp() public {
        pvt = new MockPVT();
        clock = new MockEpochClock(EPOCH_START);
        index = new MockIssuanceIndex();
        escrow = new InstitutionCollateralMockEscrow();
        vm.warp(EPOCH_START);

        bond = new ProvianBondPool(admin, tech, address(pvt), address(clock), address(index), new ProvianBondPool.BondSeed[](0), new ProvianBondPool.BpsSeed[](0));
        court = new ProvianCourtV2(admin, address(escrow), address(clock), address(pvt), address(index));

        vm.startPrank(admin);
        bond.setCourtContract(address(court));
        court.setBondPool(address(bond));
        vm.stopPrank();

        address[7] memory actors = [agent, claimant, arb1, arb2, arb3, arb4, outsider];
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

    /// @dev Post an L2 bond and file a claim against it.
    function _postAndFile(bytes32 salt) internal returns (bytes32 claimId) {
        vm.prank(agent);
        bond.postBond(2, 0);
        claimId = keccak256(abi.encodePacked("claim", salt));
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

    // ==================================================================
    // Collateral is a STAKE — returned in full absent proven misconduct
    // ==================================================================

    function test_collateral_isPulledAtPosting_andSnapshottedPerCase() public {
        bytes32 claimId = _postAndFile("stake");
        _assign(claimId);

        uint256 required = court.arbitratorCollateral();
        assertEq(required, 75e18, "shipped collateral is 10% of the level-2 bond");

        uint256 before = pvt.balanceOf(arb1);
        _post(claimId, arb1);
        assertEq(before - pvt.balanceOf(arb1), required, "the stake is actually pulled");
        assertEq(court.getPostedAmount(CASE_BOND, claimId, 0), required, "recorded against the seat");

        (,,,, uint256 snapshot,,) = court.getPanelPosting(CASE_BOND, claimId);
        assertEq(snapshot, required, "the case's requirement is snapshotted at assignment");
    }

    /// @notice GRANDFATHERING for the collateral: a case seated before the floor rises
    ///         keeps the requirement it was seated under.
    function test_collateral_isGrandfatheredAtAssignment() public {
        bytes32 claimId = _postAndFile("grandfathered");
        _assign(claimId);
        (,,,, uint256 snapshot,,) = court.getPanelPosting(CASE_BOND, claimId);
        assertEq(snapshot, 75e18);

        // One seat posts at the original price.
        uint256 before = pvt.balanceOf(arb1);
        _post(claimId, arb1);
        assertEq(before - pvt.balanceOf(arb1), snapshot, "charged the snapshot");

        // Economy grows 10x mid-case.
        index.seedFlat(0, 12, 10_000_000e18 * 10);
        vm.warp(uint256(EPOCH_START) + 12 * 7 days);
        assertEq(court.arbitratorCollateral(), 750e18, "a NEW case would cost 10x");

        // The seated case's requirement is UNMOVED, and the seat that already posted
        // is neither topped up nor re-rated.
        (,,,, uint256 afterRise,,) = court.getPanelPosting(CASE_BOND, claimId);
        assertEq(afterRise, snapshot, "the seated case keeps its original requirement");
        assertEq(court.getPostedAmount(CASE_BOND, claimId, 0), snapshot, "a posted seat is never re-rated");
    }

    function test_collateral_returnedInFullToAnArbitratorWhoVoted() public {
        bytes32 claimId = _postAndFile("returned");
        _assign(claimId);
        _postAll(claimId);

        uint256 stake = court.getPostedAmount(CASE_BOND, claimId, 0);
        uint256 beforeArb1 = pvt.balanceOf(arb1);

        vm.prank(arb1);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.Dismiss);
        vm.prank(arb2);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.Dismiss);
        assertEq(
            uint8(court.getBondDisputeStatus(claimId)),
            uint8(ProvianCourtV2.DisputeStatus.Resolved),
            "2-of-3 resolves, unchanged"
        );

        // institution deployment/settlement now returns the stake AND pays the fee share to a seat
        // that voted, in one call. arb1 voted, so it receives both.
        uint256 share = court.bondRewardSharePerSeat(keccak256(abi.encode(CASE_BOND, claimId)));
        assertGt(share, 0, "the dismissal funded a reward");
        court.settleArbitratorCollateral(CASE_BOND, claimId, 0);
        assertEq(pvt.balanceOf(arb1) - beforeArb1, stake + share, "a voting arbitrator gets its full stake back PLUS its fee share");
    }

    /// @notice A seat that never got to matter is NOT at fault. When a 2-of-3 majority
    ///         resolves at the second vote, the third seat is returned in full.
    function test_collateral_returnedWhenAMajorityResolvedEarly() public {
        bytes32 claimId = _postAndFile("early");
        _assign(claimId);
        _postAll(claimId);

        uint256 stake = court.getPostedAmount(CASE_BOND, claimId, 2);
        uint256 beforeArb3 = pvt.balanceOf(arb3);
        uint256 burnedBefore = pvt.totalBurned();

        vm.prank(arb1);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.Dismiss);
        vm.prank(arb2);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.Dismiss);

        // institution deployment/arb3 never voted, so its FEE SHARE is forfeited (burned) — but its
        // COLLATERAL is still returned (an early majority left it no opportunity, so it is
        // not at fault). The stake comes back; no collateral is slashed.
        uint256 share = court.bondRewardSharePerSeat(keccak256(abi.encode(CASE_BOND, claimId)));
        court.settleArbitratorCollateral(CASE_BOND, claimId, 2);
        assertEq(pvt.balanceOf(arb3) - beforeArb3, stake, "the silent third seat's collateral is returned, not slashed");
        // The dismissal burns the CLAIMANT'S FILING FEE; the silent seat's forfeited fee
        // share burns on top. What must NOT happen is any COLLATERAL burn.
        assertEq(
            pvt.totalBurned() - burnedBefore,
            FILING_FEE + share,
            "filing fee + the silent seat's forfeited reward burn - but no collateral is slashed"
        );
    }

    // ==================================================================
    // The ONE provable misconduct predicate: posted, then never voted
    // ==================================================================

    /// @notice A seat that POSTED and then let the case run to its voting deadline
    ///         without voting is slashed — and the stake is BURNED, not paid to the
    ///         admin and not paid to a dispute party.
    function test_misconduct_postedButNeverVoted_isBurned() public {
        bytes32 claimId = _postAndFile("absent");
        _assign(claimId);
        _postAll(claimId);

        // Only ONE seat votes; the window lapses.
        vm.prank(arb1);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.Dismiss);
        vm.warp(vm.getBlockTimestamp() + 48 hours + 1);
        court.finalizeBondClaim(claimId);

        uint256 stake = court.getPostedAmount(CASE_BOND, claimId, 1);
        uint256 share = court.bondRewardSharePerSeat(keccak256(abi.encode(CASE_BOND, claimId)));
        uint256 burnedBefore = pvt.totalBurned();
        uint256 arb2Before = pvt.balanceOf(arb2);
        uint256 adminBefore = pvt.balanceOf(admin);

        court.settleArbitratorCollateral(CASE_BOND, claimId, 1); // the absent seat

        // institution deployment/an absent seat at a deadline loses BOTH — collateral slashed
        // and fee share forfeited — so the burn is stake + share.
        assertEq(pvt.totalBurned() - burnedBefore, stake + share, "the absent seat's stake AND its forfeited reward are burned");
        assertEq(pvt.balanceOf(arb2), arb2Before, "not returned to the defaulter");
        assertEq(pvt.balanceOf(admin), adminBefore, "and NEVER to the admin");
    }

    /// @notice THE COMPLEMENT — guard the guard. In the very same deadline-expiry case,
    ///         the seat that DID vote is returned in full. Without this, the burn above
    ///         would be consistent with a rule that slashes everyone.
    function test_CONTROL_sameDeadlineCase_theSeatThatVotedIsReturned() public {
        bytes32 claimId = _postAndFile("absent-complement");
        _assign(claimId);
        _postAll(claimId);

        vm.prank(arb1);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.Dismiss);
        vm.warp(vm.getBlockTimestamp() + 48 hours + 1);
        court.finalizeBondClaim(claimId);

        uint256 stake = court.getPostedAmount(CASE_BOND, claimId, 0);
        uint256 share = court.bondRewardSharePerSeat(keccak256(abi.encode(CASE_BOND, claimId)));
        uint256 before = pvt.balanceOf(arb1);
        court.settleArbitratorCollateral(CASE_BOND, claimId, 0);
        // institution deployment/the seat that voted keeps its stake AND is paid its fee share.
        assertEq(pvt.balanceOf(arb1) - before, stake + share, "the seat that voted gets stake + fee share in the SAME case");
    }

    /// @notice Settlement is one-shot per seat: a second call cannot double-pay.
    function test_settlement_isOneShotPerSeat() public {
        bytes32 claimId = _postAndFile("oneshot");
        _assign(claimId);
        _postAll(claimId);
        vm.prank(arb1);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.Dismiss);
        vm.prank(arb2);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.Dismiss);

        court.settleArbitratorCollateral(CASE_BOND, claimId, 0);
        vm.expectRevert(ProvianCourtV2.CollateralNotPosted.selector);
        court.settleArbitratorCollateral(CASE_BOND, claimId, 0);
    }

    /// @notice Settlement is permissionless BUT cannot run on a live case, or an
    ///         arbitrator could withdraw mid-deliberation.
    function test_settlement_refusedWhileTheCaseIsLive() public {
        bytes32 claimId = _postAndFile("live");
        _assign(claimId);
        _postAll(claimId);
        vm.expectRevert(ProvianCourtV2.CaseNotTerminal.selector);
        court.settleArbitratorCollateral(CASE_BOND, claimId, 0);
    }

    // ==================================================================
    // PANEL LIVENESS — the griefing path the collateral would otherwise open
    // ==================================================================

    /// @notice THE CORE LIVENESS CLAIM. A selected arbitrator who simply never posts
    ///         must NOT produce an automatic dismissal — which is a free win for the
    ///         respondent and a loss for the claimant who did pay a filing fee.
    ///
    /// PRE-CHANGE CONTROL: against the shipped contract this same
    ///         sequence DISMISSED the claim, because `finalizeBondClaim` had no
    ///         fully-posted precondition and the deadline was armed at assignment.
    ///         Reproduce with:
    ///           git worktree add /tmp/pre c637fead
    ///           forge test --root contracts --match-test finalizeBondClaim
    function test_liveness_nonPostingSeatDoesNotProduceAnAutomaticDismissal() public {
        bytes32 claimId = _postAndFile("grief");
        _assign(claimId);

        // Two seats post; arb3 stonewalls.
        _post(claimId, arb1);
        _post(claimId, arb2);

        vm.warp(vm.getBlockTimestamp() + 48 hours + 1);

        vm.expectRevert(ProvianCourtV2.PanelNotFullyPosted.selector);
        court.finalizeBondClaim(claimId);

        // The claim is still live and the respondent has gained nothing.
        assertEq(
            uint8(court.getBondDisputeStatus(claimId)),
            uint8(ProvianCourtV2.DisputeStatus.Pending),
            "an incomplete panel must not be dismissable"
        );
        (,,, ProvianBondPool.ClaimStatus status,) = bond.claims(claimId);
        assertEq(uint8(status), uint8(ProvianBondPool.ClaimStatus.Filed), "the claim survives");
    }

    /// @notice THE COMPLEMENT: a FULLY posted panel that under-votes still dismisses at
    ///         its deadline exactly as before. So the new precondition discriminates —
    ///         it has not simply broken finalisation.
    function test_CONTROL_fullyPostedPanelStillDismissesAtDeadline() public {
        bytes32 claimId = _postAndFile("still-dismisses");
        _assign(claimId);
        _postAll(claimId);

        vm.warp(vm.getBlockTimestamp() + 48 hours + 1);
        court.finalizeBondClaim(claimId);

        assertEq(
            uint8(court.getBondDisputeStatus(claimId)),
            uint8(ProvianCourtV2.DisputeStatus.Resolved),
            "a seated panel that under-votes still dismisses, unchanged"
        );
    }

    /// @notice A partial panel cannot vote at all, so the 2-of-3 threshold can never be
    ///         met by two seats while a third is unfilled.
    function test_liveness_partialPanelCannotVote() public {
        bytes32 claimId = _postAndFile("partial");
        _assign(claimId);
        _post(claimId, arb1);
        _post(claimId, arb2);

        vm.prank(arb1);
        vm.expectRevert(ProvianCourtV2.PanelNotFullyPosted.selector);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.SlashFull);
    }

    /// @notice The voting window arms on the THIRD posting, so a slow-but-complete
    ///         panel gets its full window rather than being punished for assembling.
    function test_liveness_votingWindowArmsOnTheThirdPosting() public {
        bytes32 claimId = _postAndFile("arms");
        _assign(claimId);
        assertEq(court.getBondVotingDeadline(claimId), 0, "unarmed at assignment");

        _post(claimId, arb1);
        _post(claimId, arb2);
        assertEq(court.getBondVotingDeadline(claimId), 0, "still unarmed at two seats");

        vm.warp(vm.getBlockTimestamp() + 12 hours); // time spent assembling
        _post(claimId, arb3);
        assertEq(
            court.getBondVotingDeadline(claimId),
            block.timestamp + 48 hours,
            "the full window opens from the third posting, not from assignment"
        );
    }

    // ==================================================================
    // Forfeiture and replacement
    // ==================================================================

    function test_replacement_adminRefillsAVacatedSeat_andPostingResumes() public {
        bytes32 claimId = _postAndFile("replace");
        _assign(claimId);
        _post(claimId, arb1);
        _post(claimId, arb2);

        // arb3's window lapses.
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);

        vm.expectEmit(true, true, false, false, address(court));
        emit ProvianCourtV2.ArbitratorSeatForfeited(
            keccak256(abi.encode(CASE_BOND, claimId)), arb3, 2, 1
        );
        vm.prank(admin);
        court.replaceBondClaimPanelSeat(claimId, 2, arb4);

        address[3] memory p = court.getBondPanel(claimId);
        assertEq(p[2], arb4, "the seat is refilled by the same admin call that fills every seat");

        _post(claimId, arb4);
        assertGt(court.getBondVotingDeadline(claimId), 0, "the panel is now seated and voting opens");
    }

    /// @notice Replacement does NOT weaken party exclusion: the respondent and the
    ///         claimant are still refused, on the replacement path as on assignment.
    function test_replacement_stillExcludesTheParties() public {
        bytes32 claimId = _postAndFile("party-excl");
        _assign(claimId);
        _post(claimId, arb1);
        _post(claimId, arb2);
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);

        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.ArbitratorIsParty.selector);
        court.replaceBondClaimPanelSeat(claimId, 2, agent);

        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.ArbitratorIsParty.selector);
        court.replaceBondClaimPanelSeat(claimId, 2, claimant);

        // ...and the complement: a genuinely independent replacement IS accepted.
        vm.prank(admin);
        court.replaceBondClaimPanelSeat(claimId, 2, arb4);
        assertEq(court.getBondPanel(claimId)[2], arb4);
    }

    function test_replacement_rejectsADuplicateOfASittingArbitrator() public {
        bytes32 claimId = _postAndFile("dupe");
        _assign(claimId);
        _post(claimId, arb1);
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);

        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.DuplicateArbitrator.selector);
        court.replaceBondClaimPanelSeat(claimId, 2, arb1);
    }

    function test_replacement_refusedWhileTheWindowIsStillOpen() public {
        bytes32 claimId = _postAndFile("too-early");
        _assign(claimId);
        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.PostingWindowStillOpen.selector);
        court.replaceBondClaimPanelSeat(claimId, 2, arb4);
    }

    function test_replacement_refusedForASeatThatAlreadyPosted() public {
        bytes32 claimId = _postAndFile("already");
        _assign(claimId);
        _post(claimId, arb1);
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.SeatAlreadyPosted.selector);
        court.replaceBondClaimPanelSeat(claimId, 0, arb4);
    }

    /// @notice ROUNDS ARE GLOBAL. One window covers EVERY unposted seat, so seats are
    ///         not a multiplier on latency — the property the whole bound depends on.
    function test_replacement_roundsAreGlobal_notPerSeat() public {
        bytes32 claimId = _postAndFile("global");
        _assign(claimId);
        _post(claimId, arb1); // seats 1 and 2 stay empty
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);

        vm.startPrank(admin);
        court.replaceBondClaimPanelSeat(claimId, 1, arb4);
        (,, uint8 roundAfterFirst,,,,) = court.getPanelPosting(CASE_BOND, claimId);
        court.replaceBondClaimPanelSeat(claimId, 2, outsider);
        (,, uint8 roundAfterSecond,,,,) = court.getPanelPosting(CASE_BOND, claimId);
        vm.stopPrank();

        assertEq(roundAfterFirst, 1, "the first replacement opens round 1");
        assertEq(roundAfterSecond, 1, "a second seat in the SAME window does not consume another round");
    }

    // ==================================================================
    // Bounded attempts and the terminal state
    // ==================================================================

    /// @notice Replacement is BOUNDED. After MAX_REPLACEMENT_ROUNDS the admin cannot
    ///         keep the case alive forever by reassigning.
    function test_terminal_replacementRoundsAreExhaustible() public {
        bytes32 claimId = _postAndFile("exhaust");
        _assign(claimId);
        _post(claimId, arb1);
        _post(claimId, arb2);

        uint8 maxRounds = court.MAX_REPLACEMENT_ROUNDS();
        for (uint8 r = 0; r < maxRounds; r++) {
            vm.warp(vm.getBlockTimestamp() + 1 days + 1);
            vm.prank(admin);
            court.replaceBondClaimPanelSeat(claimId, 2, address(uint160(uint256(0xE000) + uint256(r))));
        }

        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.ReplacementRoundsExhausted.selector);
        court.replaceBondClaimPanelSeat(claimId, 2, outsider);
    }

    /// @notice THE TERMINAL STATE. When the panel truly cannot be assembled, the claim
    ///         ends and the claimant's filing fee is RETURNED, not burned — otherwise
    ///         the respondent, the one party who benefits from no verdict, profits from
    ///         a failed panel. Proven against the REAL BondPool by token movement.
    function test_terminal_unassembledPanel_refundsTheFilingFee() public {
        bytes32 claimId = _postAndFile("unassembled");
        _assign(claimId);
        _post(claimId, arb1);

        uint8 maxRounds = court.MAX_REPLACEMENT_ROUNDS();
        for (uint8 r = 0; r < maxRounds; r++) {
            vm.warp(vm.getBlockTimestamp() + 1 days + 1);
            vm.prank(admin);
            court.replaceBondClaimPanelSeat(claimId, 2, address(uint160(uint256(0xF000) + uint256(r))));
        }
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);

        uint256 claimantBefore = pvt.balanceOf(claimant);
        uint256 burnedBefore = pvt.totalBurned();
        uint256 techBefore = pvt.balanceOf(tech);

        court.closeUnassembledBondClaim(claimId); // permissionless

        assertEq(pvt.balanceOf(claimant) - claimantBefore, FILING_FEE, "the filing fee is RETURNED");
        assertEq(pvt.totalBurned(), burnedBefore, "and NOT burned");
        assertEq(pvt.balanceOf(tech), techBefore, "no processing fee for a panel that never sat");

        (,,, ProvianBondPool.ClaimStatus status,) = bond.claims(claimId);
        assertEq(uint8(status), uint8(ProvianBondPool.ClaimStatus.Dismissed), "the claim is closed");

        // The respondent's bond is unfrozen, so this is a real liveness exit.
        (,,,,,, uint256 pending) = bond.bonds(agent);
        assertEq(pending, 0, "pendingClaims decremented, withdrawBond unblocked");
    }

    /// @notice THE COMPLEMENT for the terminal state: an ordinary adjudicated dismissal
    ///         still BURNS the fee. So the refund is specific to panel non-assembly and
    ///         has not quietly become the rule for every dismissal.
    function test_CONTROL_ordinaryDismissalStillBurnsTheFilingFee() public {
        bytes32 claimId = _postAndFile("ordinary");
        _assign(claimId);
        _postAll(claimId);

        uint256 claimantBefore = pvt.balanceOf(claimant);
        uint256 burnedBefore = pvt.totalBurned();

        vm.prank(arb1);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.Dismiss);
        vm.prank(arb2);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.Dismiss);

        assertEq(pvt.balanceOf(claimant), claimantBefore, "no refund on the merits");
        assertEq(pvt.totalBurned() - burnedBefore, FILING_FEE, "an adjudicated dismissal still burns");
    }

    /// @notice A case that can STILL be assembled cannot be closed early.
    function test_terminal_refusedWhileThePanelIsStillAssemblable() public {
        bytes32 claimId = _postAndFile("still-live");
        _assign(claimId);
        _post(claimId, arb1);
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);

        vm.expectRevert(ProvianCourtV2.PanelStillAssemblable.selector);
        court.closeUnassembledBondClaim(claimId);
    }

    /// @notice Seats that DID post on a case that never assembled get their stake back —
    ///         they did nothing wrong.
    function test_terminal_postedSeatsAreReturnedOnAFailedAssembly() public {
        bytes32 claimId = _postAndFile("failed-return");
        _assign(claimId);
        _post(claimId, arb1);

        uint8 maxRounds = court.MAX_REPLACEMENT_ROUNDS();
        for (uint8 r = 0; r < maxRounds; r++) {
            vm.warp(vm.getBlockTimestamp() + 1 days + 1);
            vm.prank(admin);
            court.replaceBondClaimPanelSeat(claimId, 2, address(uint160(uint256(0xA000) + uint256(r))));
        }
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        court.closeUnassembledBondClaim(claimId);

        uint256 stake = court.getPostedAmount(CASE_BOND, claimId, 0);
        uint256 before = pvt.balanceOf(arb1);
        court.settleArbitratorCollateral(CASE_BOND, claimId, 0);
        assertEq(pvt.balanceOf(arb1) - before, stake, "a seat that posted is not punished for others' default");
    }

    // ==================================================================
    // THE LATENCY BOUND — asserted, not asserted-about
    // ==================================================================

    /// @notice The whole liveness design deadlocks by construction if the worst-case
    ///         posting + voting latency can exceed the BondPool's claim timeout. Assert
    ///         it at the BAND MAXIMA, which is the only case that matters.
    ///
    ///         (1 + 3 rounds) x 7d window + 14d voting = 42d < 60d timeout.
    ///
    ///         Note the timeout runs from the claim's FILING, not from panel
    ///         assignment, so the 18-day remainder is the budget for assignment latency.
    function test_latencyBound_worstCaseFitsInsideTheClaimTimeout() public view {
        uint256 posting = (1 + uint256(court.MAX_REPLACEMENT_ROUNDS())) * court.PANEL_POSTING_WINDOW_MAX();
        uint256 voting = court.PANEL_VOTING_PERIOD_MAX();
        uint256 worstCase = posting + voting;

        assertEq(posting, 28 days, "4 global windows at the band maximum");
        assertEq(voting, 14 days, "the voting band maximum");
        assertEq(worstCase, 42 days, "worst case assignment -> terminal");

        uint256 timeout = bond.CLAIM_RESOLUTION_TIMEOUT();
        assertEq(timeout, 60 days);
        assertLt(worstCase, timeout, "the panel lifecycle MUST terminate inside the claim timeout");
        assertEq(timeout - worstCase, 18 days, "remaining budget for panel-assignment latency");
    }

    /// @notice At the SHIPPED values the same worst case is 6 days, not 42.
    function test_latencyBound_atShippedValues() public view {
        uint256 posting = (1 + uint256(court.MAX_REPLACEMENT_ROUNDS())) * court.DEFAULT_PANEL_POSTING_WINDOW();
        uint256 voting = court.DEFAULT_PANEL_VOTING_PERIOD();
        assertEq(posting + voting, 6 days, "4 x 1d + 48h at the shipped configuration");
    }

    /// @notice The posting window is schedulable inside an immutable band, on the same
    ///         machinery as every other Court cost parameter, and refuses out-of-band
    ///         values in BOTH directions.
    function test_postingWindow_isBandedAndProspective() public {
        assertEq(court.DEFAULT_PANEL_POSTING_WINDOW(), 1 days);

        // Hoisted: a view call between expectRevert and its target would consume it.
        uint256 belowBand = court.PANEL_POSTING_WINDOW_MIN() - 1;
        uint256 aboveBand = court.PANEL_POSTING_WINDOW_MAX() + 1;

        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.CostOutOfDomain.selector);
        court.schedulePanelPostingWindow(1, belowBand);

        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.CostOutOfDomain.selector);
        court.schedulePanelPostingWindow(1, aboveBand);

        // Prospective only.
        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.PolicyNotProspective.selector);
        court.schedulePanelPostingWindow(0, 2 days);

        // Admin only.
        vm.prank(outsider);
        vm.expectRevert(ProvianCourtV2.OnlyAdmin.selector);
        court.schedulePanelPostingWindow(1, 2 days);

        // ...and the complement: an in-band prospective value from the admin IS taken.
        vm.prank(admin);
        court.schedulePanelPostingWindow(1, 2 days);
        (bool exists,) = court.activePanelPostingWindow();
        assertFalse(exists, "not yet active in the current epoch");
        vm.warp(uint256(EPOCH_START) + 7 days);
        (bool nowExists, uint256 v) = court.activePanelPostingWindow();
        assertTrue(nowExists, "active once its epoch opens");
        assertEq(v, 2 days);
    }

    // ==================================================================
    // Namespacing — an escrow id and a claim id can never collide
    // ==================================================================

    function test_postingState_isNamespacedByCaseFamily() public {
        bytes32 shared = keccak256("same-id-both-families");

        // A bond claim under this id.
        vm.prank(agent);
        bond.postBond(2, 0);
        vm.prank(claimant);
        bond.fileClaim(agent, shared);
        vm.prank(admin);
        court.assignBondClaimPanel(shared, _panel());

        // An escrow dispute under the SAME id.
        escrow.setParties(shared, address(0xE1), address(0xE2));
        _fundEscrowAdj(shared);
        vm.prank(admin);
        court.assignPanel(shared, _panel());

        _post(shared, arb1); // posts to the BOND case
        assertEq(court.getPostedAmount(CASE_BOND, shared, 0), 75e18, "bond family recorded");
        assertEq(court.getPostedAmount(CASE_ESCROW, shared, 0), 0, "escrow family untouched");
    }
}
