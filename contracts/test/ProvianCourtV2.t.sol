// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import "../src/ProvianCourtV2.sol";
import {ProvianEscrowV4} from "../src/ProvianEscrowV4.sol";
import "../src/ProvianBondPool.sol";
import "./MockTokens.sol"; // MockUSDC + MockPVT
import "./MockEpochClock.sol";
import "./MockIssuanceIndex.sol";

/*
 * ============================================================================
 * PROVIAN COURT V2 - TESTS
 * ============================================================================
 *
 * CourtV2 does NOT custody PVT or any tokens. It is a pure state machine that
 * (a) records a 3-member panel for an escrow dispute, (b) tallies votes,
 * (c) forwards a release/refund decision to the Escrow contract on majority,
 * and (d) supports admin-escalation fallback after deadline.
 *
 * REPUTATION-STAKE DROP: the court used to carry a fifth behaviour -
 * `slashAgentReputation`, burning an agent's *staked* PVT through the legacy
 * `IPVT.slashReputation` after a resolved dispute. That was purchased
 * standing, and Provian reputation is PE-signal, so it is deleted along with
 * the court's entire PVT reference. Section 5 below now PROVES its absence
 * rather than exercising it.
 *
 * Tests exercise:
 *   1. Constructor / access control
 *   2. Panel validation (distinct members, no zero addresses, non-party)
 *   3. Voting (panel-only, no double vote, deadline, resolution triggers)
 *   4. Escalation + admin resolveEscalatedDispute fallback
 *   5. ABSENCE of any reputation-slash path (no `slashAgentReputation`, no
 *      `pvt()` reference, nothing reaching `IPVT.slashReputation`)
 *   6. Admin rotation via transferAdmin
 *   7. View helpers (revert on unknown, correct values)
 *   8. Composed "real EscrowV3 + Court" end-to-end happy path
 *   9. Invariants - vote-count bounds, status monotonicity,
 *      panel-party-exclusion
 *  10. Bond-claim adjudication (ProvianCourtV2BondClaimTest) - the court's
 *      one REMAINING slash path, per-obligation and unchanged by the drop.
 *
 * Non-custody note: Court sends no tokens. Its only off-contract effects are
 * IProvianEscrowV3.resolveDispute(id, releaseToRecipient) during a verdict
 * and, on the bond path, BondPool.slashBond / dismissClaim. All external
 * calls are to contracts the test harness controls.
 * ============================================================================
 */

/**
 * @title MockEscrowV3
 * @notice Records every call and exposes configurable `getParties` so panel
 *         validation edge cases (zero addresses, duplicate parties,
 *         party-as-panelist, getParties reverts) can be driven from tests.
 *         Emits no events - tests read state directly.
 */
contract MockEscrowV3 {
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
        if (p.shouldRevert) revert("MockEscrowV3: forced revert");
        return (p.depositor, p.recipient);
    }

    /// @dev mirrors the real escrow, which stamps the settlement time on every
    ///      exit from Disputed; the Court reads it to close cases settled elsewhere.
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

contract ProvianCourtV2Test is Test {
    ProvianCourtV2 public court;
    MockEscrowV3 public escrow;
    /// @dev institution deployment: the court now custodies arbitrator per-case collateral, so it binds
    ///      a PVT token. Panelists are funded and approved in setUp so the existing
    ///      escrow-dispute tests can post before voting.
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

    /// @dev EscrowV4's shipped flat adjudication fee (`disputeAdjudicationFee()`
    ///      with a thin index). Asserted against the real contract, rather than merely
    /// declared here, in InstitutionEscrowAdjudicationFee.t.sol.
    uint256 public constant ADJ_FEE = 30e18;

    function setUp() public {
        escrow = new MockEscrowV3();
        pvt = new MockPVT();
        court = new ProvianCourtV2(admin, address(escrow), address(new MockEpochClock(0)), address(pvt), address(new MockIssuanceIndex()));

        // Default: ESCROW_ID has distinct non-panelist parties.
        escrow.setParties(ESCROW_ID, depositor, recipient);

        // institution deployment: fund + approve every arbitrator this suite seats, so posting the
        // per-case collateral is never the thing that fails a pre-existing test.
        address[4] memory arbs = [arb1, arb2, arb3, outsider];
        for (uint256 i = 0; i < arbs.length; i++) {
            pvt.mint(arbs[i], 1_000_000e18);
            vm.prank(arbs[i]);
            pvt.approve(address(court), type(uint256).max);
        }

        // `assignPanel` is gated on the flat escrow adjudication fee having
        // been routed in from the wired escrow. The default case is pre-funded here so
        // no pre-existing panel/vote test has to care; tests using another escrow id
        // call `_fundAdj` themselves.
        _fundAdj(court, address(escrow), ESCROW_ID);
    }

    /// @dev The escrow's fee routing, impersonated. In production `EscrowV4.delegateToCourt`
    ///      pulls the flat fee from the escalating party and forwards it to the Court in
    ///      the same call; here the PVT is minted straight to the Court and the wired
    ///      escrow address is pranked, which is the same end state. The routing itself
    /// is proven against the REAL EscrowV4 in InstitutionEscrowAdjudicationFee.t.sol.
    function _fundAdj(ProvianCourtV2 c, address escrowAddr, bytes32 escrowId) internal {
        pvt.mint(address(c), ADJ_FEE);
        vm.prank(escrowAddr);
        c.fundEscrowDisputeReward(escrowId, ADJ_FEE);
    }

    /// @dev institution deployment helper: seat the panel fully so voting is open. Every pre-existing
    ///      test that votes now goes through this first — a partial panel cannot vote.
    function _postAll(bytes32 escrowId, address[3] memory panel) internal {
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(panel[i]);
            court.postEscrowCollateral(escrowId);
        }
    }

    function _validPanel() internal view returns (address[3] memory) {
        return [arb1, arb2, arb3];
    }

    /// @dev institution deployment: assignment alone no longer opens voting — all three seats must post
    ///      their per-case collateral first. This helper does both, so every
    ///      pre-existing test that assigns-then-votes keeps exercising the behaviour it
    ///      was written for. Use `_assignDefaultPanelUnposted` when the UNSEATED state
    ///      is the thing under test.
    function _assignDefaultPanel() internal {
        _assignDefaultPanelUnposted();
        _postAll(ESCROW_ID, _validPanel());
    }

    function _assignDefaultPanelUnposted() internal {
        vm.prank(admin);
        court.assignPanel(ESCROW_ID, _validPanel());
    }

    // =========================================================================
    // CONSTRUCTOR + ACCESS CONTROL
    // =========================================================================

    function test_constructor_setsAllAddresses() public view {
        assertEq(court.admin(), admin);
        assertEq(address(court.escrowContract()), address(escrow));
    }

    function test_constructor_rejectsZeroAdmin() public {
        address clk = address(new MockEpochClock(0)); // hoisted so expectRevert targets the Court create
        address idx = address(new MockIssuanceIndex()); // hoisted for the same reason
        vm.expectRevert(ProvianCourtV2.InvalidAddress.selector);
        new ProvianCourtV2(address(0), address(escrow), clk, address(pvt), idx);
    }

    function test_constructor_rejectsZeroEscrow() public {
        address clk = address(new MockEpochClock(0));
        address idx = address(new MockIssuanceIndex());
        vm.expectRevert(ProvianCourtV2.InvalidAddress.selector);
        new ProvianCourtV2(admin, address(0), clk, address(pvt), idx);
    }

    function test_constructor_rejectsZeroEpochClock() public {
        address idx = address(new MockIssuanceIndex());
        vm.expectRevert(ProvianCourtV2.InvalidAddress.selector);
        new ProvianCourtV2(admin, address(escrow), address(0), address(pvt), idx);
    }

    /// @notice institution deployment: the two new constructor references are zero-checked like the rest,
    ///         so a court can never be deployed unable to custody collateral or unable
    ///         to resolve its cost floors.
    function test_constructor_rejectsZeroPvt() public {
        address clk = address(new MockEpochClock(0));
        address idx = address(new MockIssuanceIndex());
        vm.expectRevert(ProvianCourtV2.InvalidAddress.selector);
        new ProvianCourtV2(admin, address(escrow), clk, address(0), idx);
    }

    function test_constructor_rejectsZeroIssuanceIndex() public {
        address clk = address(new MockEpochClock(0));
        vm.expectRevert(ProvianCourtV2.InvalidAddress.selector);
        new ProvianCourtV2(admin, address(escrow), clk, address(pvt), address(0));
    }

    function test_assignPanel_onlyAdmin() public {
        vm.prank(outsider);
        vm.expectRevert(ProvianCourtV2.OnlyAdmin.selector);
        court.assignPanel(ESCROW_ID, _validPanel());
    }

    function test_resolveEscalatedDispute_onlyAdmin() public {
        _assignDefaultPanel();
        vm.warp(block.timestamp + VOTING_WINDOW + 1);
        court.escalateDispute(ESCROW_ID);
        vm.prank(outsider);
        vm.expectRevert(ProvianCourtV2.OnlyAdmin.selector);
        court.resolveEscalatedDispute(ESCROW_ID, true);
    }

    function test_transferAdmin_rotates() public {
        vm.prank(admin);
        court.transferAdmin(newAdmin);
        assertEq(court.admin(), newAdmin);

        // Old admin is powerless.
        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.OnlyAdmin.selector);
        court.assignPanel(ESCROW_ID, _validPanel());
    }

    function test_transferAdmin_rejectsZero() public {
        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.InvalidAddress.selector);
        court.transferAdmin(address(0));
    }

    // =========================================================================
    // PANEL VALIDATION (distinct + non-party + on-chain enforcement)
    // =========================================================================

    function test_assignPanel_happyPath_setsState() public {
        // institution deployment: the assignment event now carries a ZERO voting deadline — the window
        // opens when the third seat posts, so a panel is never charged for the time it
        // spent assembling.
        vm.expectEmit(true, false, false, true, address(court));
        emit ProvianCourtV2.PanelAssigned(ESCROW_ID, arb1, arb2, arb3, 0);
        vm.prank(admin);
        court.assignPanel(ESCROW_ID, _validPanel());

        assertTrue(court.disputeExists(ESCROW_ID));
        address[3] memory panel = court.getPanel(ESCROW_ID);
        assertEq(panel[0], arb1);
        assertEq(panel[1], arb2);
        assertEq(panel[2], arb3);
        assertEq(uint8(court.getDisputeStatus(ESCROW_ID)), uint8(ProvianCourtV2.DisputeStatus.Pending));
        assertEq(court.getVotingDeadline(ESCROW_ID), 0, "unarmed until the panel is seated");

        // ...and it arms to exactly the resolved voting period on the third posting.
        _postAll(ESCROW_ID, _validPanel());
        assertEq(court.getVotingDeadline(ESCROW_ID), block.timestamp + VOTING_WINDOW);
    }

    function test_assignPanel_rejectsZeroAddress() public {
        address[3] memory bad = [address(0), arb2, arb3];
        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.InvalidAddress.selector);
        court.assignPanel(ESCROW_ID, bad);

        bad = [arb1, address(0), arb3];
        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.InvalidAddress.selector);
        court.assignPanel(ESCROW_ID, bad);

        bad = [arb1, arb2, address(0)];
        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.InvalidAddress.selector);
        court.assignPanel(ESCROW_ID, bad);
    }

    function test_assignPanel_rejectsDuplicateArbitrators() public {
        // a == b, a == c, b == c all rejected.
        address[3] memory p1 = [arb1, arb1, arb3];
        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.DuplicateArbitrator.selector);
        court.assignPanel(ESCROW_ID, p1);

        address[3] memory p2 = [arb1, arb2, arb1];
        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.DuplicateArbitrator.selector);
        court.assignPanel(ESCROW_ID, p2);

        address[3] memory p3 = [arb1, arb2, arb2];
        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.DuplicateArbitrator.selector);
        court.assignPanel(ESCROW_ID, p3);
    }

    function test_assignPanel_rejectsDepositorAsPanelist() public {
        address[3] memory bad = [depositor, arb2, arb3];
        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.ArbitratorIsParty.selector);
        court.assignPanel(ESCROW_ID, bad);
    }

    function test_assignPanel_rejectsRecipientAsPanelist() public {
        address[3] memory bad = [arb1, recipient, arb3];
        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.ArbitratorIsParty.selector);
        court.assignPanel(ESCROW_ID, bad);
    }

    function test_assignPanel_rejectsExistingDispute() public {
        _assignDefaultPanel();
        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.DisputeAlreadyExists.selector);
        court.assignPanel(ESCROW_ID, _validPanel());
    }

    function test_assignPanel_propagatesEscrowGetPartiesRevert() public {
        // If escrow.getParties reverts, panel assignment must not silently
        // succeed with no party check.
        bytes32 badEscrow = keccak256("getParties-reverts");
        escrow.setPartiesRevert(badEscrow);
        _fundAdj(court, address(escrow), badEscrow);
        vm.prank(admin);
        vm.expectRevert("MockEscrowV3: forced revert");
        court.assignPanel(badEscrow, _validPanel());
    }

    // =========================================================================
    // CAST VOTE
    // =========================================================================

    function test_castVote_happyPath_emitsEvent() public {
        _assignDefaultPanel();
        vm.expectEmit(true, true, false, true, address(court));
        emit ProvianCourtV2.VoteCast(ESCROW_ID, arb1, true);
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
        vm.expectRevert(ProvianCourtV2.NotPanelMember.selector);
        court.castVote(ESCROW_ID, true);
    }

    function test_castVote_rejectsDoubleVote() public {
        _assignDefaultPanel();
        vm.prank(arb1);
        court.castVote(ESCROW_ID, true);
        vm.prank(arb1);
        vm.expectRevert(ProvianCourtV2.AlreadyVoted.selector);
        court.castVote(ESCROW_ID, false);
    }

    function test_castVote_rejectsAfterDeadline() public {
        _assignDefaultPanel();
        vm.warp(block.timestamp + VOTING_WINDOW + 1);
        vm.prank(arb1);
        vm.expectRevert(ProvianCourtV2.VotingClosed.selector);
        court.castVote(ESCROW_ID, true);
    }

    function test_castVote_acceptsAtExactDeadline() public {
        // Behavior pin: `block.timestamp > deadline` is strict, so voting
        // AT exactly `votingDeadline` is still allowed.
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
        vm.expectRevert(ProvianCourtV2.DisputeNotFound.selector);
        court.castVote(keccak256("never-assigned"), true);
    }

    function test_castVote_rejectsOnResolvedDispute() public {
        _assignDefaultPanel();
        vm.prank(arb1);
        court.castVote(ESCROW_ID, true);
        vm.prank(arb2);
        court.castVote(ESCROW_ID, true); // resolves
        vm.prank(arb3);
        vm.expectRevert(ProvianCourtV2.DisputeNotPending.selector);
        court.castVote(ESCROW_ID, false);
    }

    // =========================================================================
    // RESOLUTION TRIGGERS (2-of-3 majority)
    // =========================================================================

    function test_castVote_twoForRelease_autoResolvesRelease() public {
        _assignDefaultPanel();
        vm.prank(arb1);
        court.castVote(ESCROW_ID, true);
        vm.expectEmit(true, false, false, true, address(court));
        emit ProvianCourtV2.Verdict(ESCROW_ID, true, 2, 0);
        vm.prank(arb2);
        court.castVote(ESCROW_ID, true);

        assertEq(uint8(court.getDisputeStatus(ESCROW_ID)), uint8(ProvianCourtV2.DisputeStatus.Resolved));
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

        assertEq(uint8(court.getDisputeStatus(ESCROW_ID)), uint8(ProvianCourtV2.DisputeStatus.Resolved));
        (, bool release) = escrow.lastResolveCall();
        assertFalse(release);
    }

    function test_castVote_splitVote_thirdBreaksTie() public {
        _assignDefaultPanel();
        vm.prank(arb1);
        court.castVote(ESCROW_ID, true);
        vm.prank(arb2);
        court.castVote(ESCROW_ID, false);
        // 1-1 split - dispute still Pending.
        assertEq(uint8(court.getDisputeStatus(ESCROW_ID)), uint8(ProvianCourtV2.DisputeStatus.Pending));
        assertEq(escrow.resolveCallCount(), 0);

        vm.prank(arb3);
        court.castVote(ESCROW_ID, true);
        // 2 for release, 1 against → resolved.
        assertEq(uint8(court.getDisputeStatus(ESCROW_ID)), uint8(ProvianCourtV2.DisputeStatus.Resolved));
        (, bool release) = escrow.lastResolveCall();
        assertTrue(release);
    }

    function test_castVote_singleVoteDoesNotResolve() public {
        _assignDefaultPanel();
        vm.prank(arb1);
        court.castVote(ESCROW_ID, true);
        assertEq(uint8(court.getDisputeStatus(ESCROW_ID)), uint8(ProvianCourtV2.DisputeStatus.Pending));
        assertEq(escrow.resolveCallCount(), 0);
    }

    // =========================================================================
    // ESCALATION + ADMIN FALLBACK
    // =========================================================================

    function test_escalateDispute_happyPath() public {
        _assignDefaultPanel();
        vm.warp(block.timestamp + VOTING_WINDOW + 1);
        vm.expectEmit(true, false, false, false, address(court));
        emit ProvianCourtV2.Escalated(ESCROW_ID);
        court.escalateDispute(ESCROW_ID); // permissionless after deadline

        assertEq(uint8(court.getDisputeStatus(ESCROW_ID)), uint8(ProvianCourtV2.DisputeStatus.Escalated));
    }

    function test_escalateDispute_rejectsBeforeDeadline() public {
        _assignDefaultPanel();
        vm.expectRevert(ProvianCourtV2.VotingNotExpired.selector);
        court.escalateDispute(ESCROW_ID);
    }

    function test_escalateDispute_rejectsAlreadyResolved() public {
        _assignDefaultPanel();
        vm.prank(arb1);
        court.castVote(ESCROW_ID, true);
        vm.prank(arb2);
        court.castVote(ESCROW_ID, true);
        vm.warp(block.timestamp + VOTING_WINDOW + 1);
        vm.expectRevert(ProvianCourtV2.DisputeNotPending.selector);
        court.escalateDispute(ESCROW_ID);
    }

    function test_escalateDispute_rejectsDoubleEscalate() public {
        _assignDefaultPanel();
        vm.warp(block.timestamp + VOTING_WINDOW + 1);
        court.escalateDispute(ESCROW_ID);
        vm.expectRevert(ProvianCourtV2.DisputeNotPending.selector);
        court.escalateDispute(ESCROW_ID);
    }

    function test_escalateDispute_rejectsUnknown() public {
        vm.expectRevert(ProvianCourtV2.DisputeNotFound.selector);
        court.escalateDispute(keccak256("never"));
    }

    function test_resolveEscalatedDispute_happyPath() public {
        _assignDefaultPanel();
        vm.warp(block.timestamp + VOTING_WINDOW + 1);
        court.escalateDispute(ESCROW_ID);

        vm.prank(admin);
        court.resolveEscalatedDispute(ESCROW_ID, false);

        assertEq(uint8(court.getDisputeStatus(ESCROW_ID)), uint8(ProvianCourtV2.DisputeStatus.Resolved));
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

    // =========================================================================
    // NO REPUTATION-SLASH PATH (reputation-stake drop)
    //
    //   The court used to expose `slashAgentReputation(bytes32,address,
    //   uint256,address)`, which called the legacy `IPVT.slashReputation` to
    //   burn an agent's *staked* PVT after a resolved dispute. Reputation in
    //   Provian is PE-signal, never purchased standing, so that path and the
    //   court's whole PVT reference are gone.
    //
    //   These tests prove the ABSENCE four independent ways: the dispatcher
    //   rejects the selector, the selector is not in the deployed runtime, the
    //   `pvt()` getter is not there either, and a full dispute lifecycle calls
    //   nothing but the escrow. Re-adding the function fails the first three;
    //   routing a slash through the verdict path fails the fourth.
    // =========================================================================

    /// @dev Selector of the deleted `slashAgentReputation(bytes32,address,uint256,address)`.
    bytes4 internal constant SLASH_AGENT_REPUTATION_SELECTOR =
        bytes4(keccak256("slashAgentReputation(bytes32,address,uint256,address)"));

    /// @dev Selector of the deleted public `pvt()` getter.
    bytes4 internal constant PVT_GETTER_SELECTOR = bytes4(keccak256("pvt()"));

    /// @dev True if `who`'s deployed runtime bytecode contains `selector` anywhere.
    ///      The dispatcher compares each external selector as an immediate, so a
    ///      live function always leaves its 4 bytes in the code.
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
        // Even as admin, on a fully resolved dispute - the exact state the old
        // function required - the call finds no function to dispatch to. The
        // court has no fallback, so it reverts.
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

    /// @notice institution deployment CHANGES THIS PROPERTY DELIBERATELY, and narrows it rather than
    ///         dropping it. The court binds PVT again — but for ARBITRATOR PER-CASE
    ///         COLLATERAL, which it custodies and returns, not for reputation-stake
    ///         slashing, which stays gone. "No pvt getter at all" was a PROXY for
    ///         "no reputation slash"; the proxy is now false while the thing it stood
    ///         for is still true, so assert the thing itself.
    function test_pvtReference_existsForCollateralOnly_notReputationSlash() public view {
        assertTrue(
            _runtimeContainsSelector(address(court), PVT_GETTER_SELECTOR),
            "institution deployment: the court binds PVT for arbitrator collateral"
        );
        assertEq(address(court.pvt()), address(pvt), "bound to the token under test");

        // The property that actually matters and is UNCHANGED: no reputation-stake
        // slash exists, by name or by selector, and PVT9 implements none to reach.
        assertFalse(
            _runtimeContainsSelector(address(court), SLASH_AGENT_REPUTATION_SELECTOR),
            "reputation-stake slashing must stay gone"
        );
        assertFalse(
            _runtimeContainsSelector(address(court), bytes4(keccak256("slashReputation(address,uint256)"))),
            "the court must not reach any slashReputation surface"
        );

        // And the binding is collateral-shaped: the court can only move PVT it was
        // handed for a case. There is no admin drain of the collateral pool.
        assertFalse(
            _runtimeContainsSelector(address(court), bytes4(keccak256("withdrawCollateral(address,uint256)"))),
            "no admin drain of custodied collateral"
        );
    }

    function test_noReputationSlash_fullLifecycleCallsOnlyTheEscrow() public {
        // The positive statement: record EVERY outbound call the court makes
        // across a full dispute lifecycle (panel -> votes -> verdict, and
        // escalate -> admin resolve) and assert the escrow is the ONLY VALUE-BEARING
        // contract it ever calls. The one other permitted callee is the read-only
        // institution parameters epoch clock (assignPanel resolves the panel_voting_period through it);
        // it holds no funds and no slash path. A slash reached FROM the lifecycle —
        // by any name, through any reference — would show a THIRD callee here and fail.
        // Scope note: this covers the lifecycle entrypoints only. A re-added
        // standalone admin slash function would not trip this test; that case
        // is what the three selector/runtime tests above are for.
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
        // institution deployment: seat the panel, then let the voting window lapse so this is a genuine
        // deadline escalation rather than an unassembled-panel one.
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
            // institution deployment widens the permitted callee set by exactly two — the read-only
            // issuance index, and the PVT token the court custodies collateral in —
            // and then TIGHTENS the claim: every PVT call must be one of the three
            // collateral movements. A reputation slash reached from the lifecycle, by
            // any name or reference, still fails here.
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
                    "court touched PVT with a selector outside the collateral set"
                );
                pvtCalls++;
            }
        }

        // Guard the guard: if the recording captured nothing, the loop above
        // would pass vacuously. Resolving two disputes must produce calls.
        assertGt(outboundCalls, 0, "state-diff recording captured no outbound calls");
        // Guard the NEW half of the guard too: if the court never touched PVT, the
        // selector check above would be an assertion over an empty population.
        assertGt(pvtCalls, 0, "no PVT calls recorded - the collateral selector check ran over nothing");
    }

    // =========================================================================
    // VIEW HELPERS - unknown-dispute reverts
    // =========================================================================

    function test_views_revertOnUnknownDispute() public {
        bytes32 never = keccak256("never");
        vm.expectRevert(ProvianCourtV2.DisputeNotFound.selector);
        court.getPanel(never);
        vm.expectRevert(ProvianCourtV2.DisputeNotFound.selector);
        court.getVoteCounts(never);
        vm.expectRevert(ProvianCourtV2.DisputeNotFound.selector);
        court.hasArbitratorVoted(never, arb1);
        vm.expectRevert(ProvianCourtV2.DisputeNotFound.selector);
        court.getDisputeStatus(never);
        vm.expectRevert(ProvianCourtV2.DisputeNotFound.selector);
        court.getVotingDeadline(never);
    }

    // =========================================================================
    // COMPOSED END-TO-END - real ProvianEscrowV4 + real ProvianCourtV2
    //
    // Uses the actual ProvianEscrowV4 contract (not MockEscrowV3) so the
    // IProvianEscrowV3 interface wiring is exercised against the real
    // getParties + resolveDispute implementation. Happy path only:
    //   1. Depositor creates an escrow
    //   2. Depositor funds it with USDC
    //   3. Depositor raises a dispute
    //   4. Admin assigns a panel (Court's on-chain getParties call hits
    //      the real Escrow)
    //   5. Two arbitrators vote for release - auto-resolves
    //   6. Escrow releases funds to recipient net of fee
    //
    // A fork-flavored version against the sprint Base mainnet deployment
    // is planned for ProvianCommonsFork.t.sol at sprint end.
    // =========================================================================

    function test_e2e_realEscrowAndCourt_happyPath() public {
        // Fresh stack with the real ProvianEscrowV4.
        MockUSDC usdc = new MockUSDC();
        MockPVT realPvt = new MockPVT();
        address e2eAdmin = address(0xEE01);
        address feeWallet = address(0xEE02);
        address e2eDepositor = address(0xEE10);
        address e2eRecipient = address(0xEE20);
        address e2eArb1 = address(0xEE31);
        address e2eArb2 = address(0xEE32);
        address e2eArb3 = address(0xEE33);

        // the Court reads `disputeSettledAt`, which only EscrowV4 carries, and
        // the deployed Court is only ever bound to EscrowV4 (no setter), so the
        // composed stack is the V4 one.
        realPvt;
        ProvianEscrowV4 realEscrow = new ProvianEscrowV4(e2eAdmin, feeWallet, address(usdc), address(pvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), new ProvianEscrowV4.EscrowSeed[](0));
        ProvianCourtV2 realCourt = new ProvianCourtV2(e2eAdmin, address(realEscrow), address(new MockEpochClock(0)), address(pvt), address(new MockIssuanceIndex()));
        vm.prank(e2eAdmin);
        realEscrow.setCourtContract(address(realCourt));

        // Fund depositor + create + fund an escrow.
        uint256 amount = 1000e6; // 1,000 USDC
        usdc.mint(e2eDepositor, amount);
        vm.prank(e2eDepositor);
        usdc.approve(address(realEscrow), type(uint256).max);

        bytes32 escrowId = keccak256("e2e-escrow");
        uint256 deadline = block.timestamp + 1 days;
        vm.prank(e2eDepositor);
        realEscrow.createEscrow(escrowId, e2eRecipient, amount, deadline, ProvianEscrowV4.Currency.USDC);
        vm.prank(e2eDepositor);
        realEscrow.fundEscrow(escrowId, false /* payFeeInPVT */);

        // Raise dispute.
        vm.prank(e2eDepositor);
        realEscrow.disputeEscrow(escrowId);

        // Admin assigns panel; Court's getParties call hits real Escrow.
        // assignment is gated on the adjudication fee, routed in by the wired escrow.
        _fundAdj(realCourt, address(realEscrow), escrowId);
        address[3] memory panel = [e2eArb1, e2eArb2, e2eArb3];
        vm.prank(e2eAdmin);
        realCourt.assignPanel(escrowId, panel);

        // institution deployment: every seat posts its per-case collateral before voting opens. The
        // court here binds `pvt` (the suite-level MockPVT), so fund and approve there.
        for (uint256 i = 0; i < 3; i++) {
            pvt.mint(panel[i], 1_000_000e18);
            vm.prank(panel[i]);
            pvt.approve(address(realCourt), type(uint256).max);
            vm.prank(panel[i]);
            realCourt.postEscrowCollateral(escrowId);
        }

        // Two arbitrators vote for release.
        vm.prank(e2eArb1);
        realCourt.castVote(escrowId, true);
        vm.prank(e2eArb2);
        realCourt.castVote(escrowId, true);

        // Dispute resolved + escrow released.
        assertEq(
            uint8(realCourt.getDisputeStatus(escrowId)),
            uint8(ProvianCourtV2.DisputeStatus.Resolved),
            "Court resolved"
        );

        // Recipient received principal minus 0.5% fee.
        uint256 expectedFee = (amount * 50) / 10000; // 0.5%
        assertEq(usdc.balanceOf(e2eRecipient), amount - expectedFee, "recipient paid");
        assertEq(usdc.balanceOf(feeWallet), expectedFee, "fee wallet paid");
    }

    function test_e2e_realEscrow_rejectsPartyAsPanelist() public {
        // Same composed stack, but admin tries to use depositor as a panelist.
        // Real Escrow's getParties() must feed Court's on-chain check,
        // producing ArbitratorIsParty rather than silently succeeding.
        MockUSDC usdc = new MockUSDC();
        MockPVT realPvt = new MockPVT();
        address e2eAdmin = address(0xEF01);
        address feeWallet = address(0xEF02);
        address e2eDepositor = address(0xEF10);
        address e2eRecipient = address(0xEF20);
        address e2eArb2 = address(0xEF32);
        address e2eArb3 = address(0xEF33);

        // the Court reads `disputeSettledAt`, which only EscrowV4 carries, and
        // the deployed Court is only ever bound to EscrowV4 (no setter), so the
        // composed stack is the V4 one.
        realPvt;
        ProvianEscrowV4 realEscrow = new ProvianEscrowV4(e2eAdmin, feeWallet, address(usdc), address(pvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), new ProvianEscrowV4.EscrowSeed[](0));
        ProvianCourtV2 realCourt = new ProvianCourtV2(e2eAdmin, address(realEscrow), address(new MockEpochClock(0)), address(pvt), address(new MockIssuanceIndex()));
        vm.prank(e2eAdmin);
        realEscrow.setCourtContract(address(realCourt));

        bytes32 escrowId = keccak256("e2e-party");
        usdc.mint(e2eDepositor, 100e6);
        vm.prank(e2eDepositor);
        usdc.approve(address(realEscrow), type(uint256).max);
        vm.prank(e2eDepositor);
        realEscrow.createEscrow(escrowId, e2eRecipient, 100e6, block.timestamp + 1 days, ProvianEscrowV4.Currency.USDC);
        vm.prank(e2eDepositor);
        realEscrow.fundEscrow(escrowId, false);
        vm.prank(e2eDepositor);
        realEscrow.disputeEscrow(escrowId);

        // Attempt panel with depositor as arb[0]. fund first, so the refusal
        // under test is the PARTY check and not the (earlier) adjudication-fee gate.
        _fundAdj(realCourt, address(realEscrow), escrowId);
        address[3] memory bad = [e2eDepositor, e2eArb2, e2eArb3];
        vm.prank(e2eAdmin);
        vm.expectRevert(ProvianCourtV2.ArbitratorIsParty.selector);
        realCourt.assignPanel(escrowId, bad);
    }

    // =========================================================================
    // FUZZ - parameter sweep on panel + voting
    // =========================================================================

    function testFuzz_assignPanel_rejectsPartyAsPanelist(uint256 salt, uint8 whichSlot) public {
        // With configurable parties, any slot that equals depositor or
        // recipient must revert ArbitratorIsParty.
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
        vm.expectRevert(ProvianCourtV2.ArbitratorIsParty.selector);
        court.assignPanel(eid, p);

        p = [address(0xB1), address(0xB2), address(0xB3)];
        p[whichSlot] = rec;
        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.ArbitratorIsParty.selector);
        court.assignPanel(eid, p);
    }

    function testFuzz_castVote_voteSumEqualsVotersAct(bool v1, bool v2) public {
        // Cast two distinct arbitrator votes; the two boolean fuzz inputs
        // determine release vs refund. Sum should always equal 2 (one
        // vote per arbitrator, counted into exactly one bucket).
        _assignDefaultPanel();
        vm.prank(arb1);
        court.castVote(ESCROW_ID, v1);
        if (v1 != v2 || !v1) {
            // Second vote won't resolve if v1 != v2 (split) OR both false
            // (need 2 for refund - second vote here resolves it). So
            // only cast+assert when no resolution has fired.
        }
        if (v1 == v2) {
            // Both same → after second vote, resolved (2-0).
            vm.prank(arb2);
            court.castVote(ESCROW_ID, v2);
            (uint8 forRelease, uint8 forRefund) = court.getVoteCounts(ESCROW_ID);
            assertEq(forRelease + forRefund, 2);
            assertEq(
                uint8(court.getDisputeStatus(ESCROW_ID)),
                uint8(ProvianCourtV2.DisputeStatus.Resolved)
            );
        } else {
            // Split → pending, still need third vote.
            vm.prank(arb2);
            court.castVote(ESCROW_ID, v2);
            (uint8 forRelease, uint8 forRefund) = court.getVoteCounts(ESCROW_ID);
            assertEq(forRelease + forRefund, 2);
            assertEq(
                uint8(court.getDisputeStatus(ESCROW_ID)),
                uint8(ProvianCourtV2.DisputeStatus.Pending)
            );
        }
    }
}

/*
 * ============================================================================
 * INVARIANT HARNESS
 * ============================================================================
 * Randomly pokes the Court state machine over many disputes and verifies
 * three properties hold at all times:
 *
 *   1. monotonicStatus - once a dispute leaves Pending, it never returns.
 *   2. voteSumBounded  - forRelease + forRefund ≤ 3 for every dispute.
 *   3. panelHasNoDuplicates - all three panelists remain distinct.
 *
 * The harder invariant - "no panelist is a party to the dispute" - is
 * exercised by design because the mock escrow enforces getParties() at
 * assignment time. We pin it as a property here regardless as a second
 * line of defence against any future change to the assignment path.
 * ============================================================================
 */

contract CourtHandler is Test {
    ProvianCourtV2 public court;
    MockEscrowV3 public escrow;
    MockPVT public pvt;

    address public admin;
    address[6] public arbs;
    address[4] public parties;

    bytes32[] public createdEscrowIds;
    // Track "have we ever seen this dispute in a given status?" Once set, stays set.
    // Invariant checks that a dispute in `wasResolved` remains Resolved, and a
    // dispute in `wasEscalated` remains Escalated or becomes Resolved - never
    // anything else.
    mapping(bytes32 => bool) public wasResolved;
    mapping(bytes32 => bool) public wasEscalated;

    constructor(ProvianCourtV2 _court, MockEscrowV3 _escrow, address _admin, MockPVT _pvt) {
        court = _court;
        escrow = _escrow;
        admin = _admin;
        pvt = _pvt;
        for (uint256 i = 0; i < 6; i++) arbs[i] = address(uint160(0xAAAA0 + i));
        for (uint256 i = 0; i < 4; i++) parties[i] = address(uint160(0xBBBB0 + i));
    }

    /// @dev Capture terminal-status observations for every tracked dispute
    ///      at the end of every handler call. Monotonic: once a dispute has
    ///      been observed Resolved/Escalated, the flag stays true even if
    ///      (hypothetically) the live status were to change.
    function _observeAll() internal {
        for (uint256 i = 0; i < createdEscrowIds.length; i++) {
            bytes32 eid = createdEscrowIds[i];
            ProvianCourtV2.DisputeStatus s = court.getDisputeStatus(eid);
            if (s == ProvianCourtV2.DisputeStatus.Resolved) wasResolved[eid] = true;
            else if (s == ProvianCourtV2.DisputeStatus.Escalated) wasEscalated[eid] = true;
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
        // assignment is gated on the adjudication fee. Without this the
        // try/catch below would swallow every AdjudicationFeeNotPaid and leave
        // `createdEscrowIds` EMPTY — the invariants would then hold vacuously over a
        // zero-item population, which is exactly the failure shape names.
        // `test_invariantPopulation_isNonEmpty` asserts the population is non-empty.
        // Fund only once per id. The fuzzer replays salts, and `eid` is derived from
        // (salt, createdEscrowIds.length) — which does NOT advance when the assignment
        // below lands in the catch — so the same id recurs and a second funding would
        // revert RewardAlreadyFunded OUTSIDE the try, aborting the whole handler call.
        bytes32 feeKey = keccak256(abi.encode(uint8(1) /* CASE_ESCROW */, eid));
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

contract ProvianCourtV2InvariantTest is Test {
    ProvianCourtV2 public court;
    MockEscrowV3 public escrow;
    CourtHandler public handler;
    MockPVT public pvt;

    address public admin = address(0xA01);

    function setUp() public {
        escrow = new MockEscrowV3();
        pvt = new MockPVT();
        court = new ProvianCourtV2(admin, address(escrow), address(new MockEpochClock(0)), address(pvt), address(new MockIssuanceIndex()));

        handler = new CourtHandler(court, escrow, admin, pvt);
        targetContract(address(handler));
    }

    /// @notice Status transitions respect the allowed DAG:
    ///           Pending -> Resolved | Escalated
    ///           Escalated -> Resolved (admin fallback)
    ///         Forbidden: Resolved -> anything, Escalated -> Pending.
    ///         The handler records wasResolved / wasEscalated monotonically
    ///         across every action; this invariant asserts those flags
    ///         imply the corresponding current status constraints.
    function invariant_statusRespectsTransitionDAG() public view {
        uint256 n = handler.disputeCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 eid = handler.disputeAt(i);
            ProvianCourtV2.DisputeStatus s = court.getDisputeStatus(eid);
            if (handler.wasResolved(eid)) {
                assertEq(
                    uint8(s),
                    uint8(ProvianCourtV2.DisputeStatus.Resolved),
                    "dispute that was Resolved is no longer Resolved"
                );
            } else if (handler.wasEscalated(eid)) {
                assertTrue(
                    s == ProvianCourtV2.DisputeStatus.Escalated
                        || s == ProvianCourtV2.DisputeStatus.Resolved,
                    "dispute that was Escalated moved to an illegal state"
                );
            }
        }
    }

    // / THE POPULATION CONTROL.
    //
    // The three invariants above are universally quantified over `createdEscrowIds`, so
    // all three hold VACUOUSLY if the handler never manages to create a dispute — and
    // adding the adjudication-fee gate to `assignPanel` made exactly that a live risk,
    // because the handler swallows an assignment failure in a `try/catch`. The gate is
    // why `createDispute` now routes the fee first.
    //
    // Deterministic, not an `afterInvariant` population assertion: the fuzzer legitimately
    // picks `createDispute` zero times in some individual runs, so a per-run check is
    // flaky, and a flaky control gets deleted.
    //
    // (An earlier version of this block also claimed Foundry EXCLUDES an `IS_TEST()`
    // handler from invariant targeting, and that the suite had therefore always been
    // vacuous. That was WRONG and was disproved in review: forge's own per-selector table
    // reports `CourtHandler | createDispute | ~3,150 calls | 0 reverts` with the handler
    // declared `is Test`. The handler is targeted; the claim and the control that asserted
    // it are gone. See.)

    /// @dev Removing the handler's adjudication-fee funding turns this RED, because
    ///      `assignPanel` then reverts into the handler's `try/catch` and nothing is ever
    ///      pushed — while all three invariants above stay green.
    function test_CONTROL_handlerActuallyPopulates() public {
        assertEq(handler.disputeCount(), 0, "population must start empty, or this proves nothing");
        handler.createDispute(7, 0, 1, 0, 1, 2);
        assertGt(handler.disputeCount(), 0, "handler creates NO disputes - every invariant above is vacuous");
    }

    /// @notice forRelease + forRefund never exceeds the panel size.
    function invariant_voteSumBounded() public view {
        uint256 n = handler.disputeCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 eid = handler.disputeAt(i);
            (uint8 forRelease, uint8 forRefund) = court.getVoteCounts(eid);
            assertLe(uint256(forRelease) + uint256(forRefund), 3, "vote sum > panel size");
        }
    }

    /// @notice No duplicate panelists and no panelist equals an escrow party.
    function invariant_panelPropertiesHold() public view {
        uint256 n = handler.disputeCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 eid = handler.disputeAt(i);
            address[3] memory panel = court.getPanel(eid);
            // Distinct.
            assertTrue(panel[0] != panel[1]);
            assertTrue(panel[0] != panel[2]);
            assertTrue(panel[1] != panel[2]);
            // Non-party.
            (address dep, address rec) = escrow.getParties(eid);
            for (uint256 j = 0; j < 3; j++) {
                assertTrue(panel[j] != dep, "panelist == depositor");
                assertTrue(panel[j] != rec, "panelist == recipient");
            }
        }
    }
}

/*
 * ============================================================================
 * WS1 (Pass-2): BOND-CLAIM ADJUDICATION - composed real BondPool + real Court
 * ============================================================================
 *
 * The deployed CourtV2 could only resolve ESCROW disputes; nothing on-chain
 * could resolve a BondPool claim, so one filed claim permanently froze the
 * respondent's bonded PVT (slashBond/dismissClaim are the only pendingClaims
 * decrements and are onlyCourt — and no court called them). These tests compose
 * a REAL ProvianBondPool + REAL ProvianCourtV2, wired together, and prove the new
 * bond-claim path end-to-end against the real slashBond/dismissClaim:
 *   - a 2-of-3 panel verdict drives slashBond (full = cap, partial = floor) or
 *     dismissClaim, decrementing pendingClaims and UNBLOCKING withdrawBond;
 *   - a slash NEVER originates from the admin or any non-Court caller;
 *   - the magnitude maps exactly onto the BondPool's [floor, cap] band;
 *   - a deadlocked / under-voted panel can only finalize to DISMISS (no freeze,
 *     no admin slash).
 * MockPVT lets anyone protocolBurn, so no protocol-contract registration is
 * needed here (that authorization axis is covered in PVT-specific tests).
 * ============================================================================
 */
contract ProvianCourtV2BondClaimTest is Test {
    ProvianCourtV2 public court;
    ProvianBondPool public bondPool;
    MockEscrowV3 public escrow;
    MockPVT public pvt;

    address public admin = address(0xA01);
    address public techWallet = address(0xA02);
    address public agent = address(0xB01);       // bonded respondent
    address public claimant = address(0xB02);
    address public arb1 = address(0xC01);
    address public arb2 = address(0xC02);
    address public arb3 = address(0xC03);
    address public outsider = address(0xD01);

    uint256 public constant MAX_BPS = 10000;
    uint256 public constant MIN_SLASH_PAYOUT_BPS = 5000; // 50% floor
    uint256 public constant SLASH_PAYOUT_BPS = 8000;     // 80% to claimant
    uint256 public constant FILING_FEE = 15e18;
    uint256 public constant CLAIMS_PROCESSING_FEE = 30e18;
    uint256 public constant VOTING_WINDOW = 48 hours;
    uint256 public constant FUND = 1_000_000e18;

    function setUp() public {
        escrow = new MockEscrowV3();
        pvt = new MockPVT();
        bondPool = new ProvianBondPool(admin, techWallet, address(pvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), new ProvianBondPool.BondSeed[](0), new ProvianBondPool.BpsSeed[](0));
        court = new ProvianCourtV2(admin, address(escrow), address(new MockEpochClock(0)), address(pvt), address(new MockIssuanceIndex()));

        // Wire the two sides of the link (both one-time setters, admin only).
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

        // institution deployment: fund + approve the panelists so posting per-case collateral is never
        // the reason a pre-existing bond-claim test fails.
        address[3] memory arbs = _panel();
        for (uint256 i = 0; i < 3; i++) {
            pvt.mint(arbs[i], FUND);
            vm.prank(arbs[i]);
            pvt.approve(address(court), type(uint256).max);
        }
    }

    /// @dev institution deployment: seat every panel seat so the voting window opens.
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

    /// Post an L2 bond for `agent` and file a claim; returns (claimId, locked).
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

    /// @dev institution deployment: assignment no longer opens voting — all three seats must post first.
    ///      This helper does both so pre-existing tests keep their original meaning.
    ///      Use `_assignUnposted` where the UNSEATED state is under test.
    function _assign(bytes32 claimId) internal {
        _assignUnposted(claimId);
        _postAllBond(claimId);
    }

    function _assignUnposted(bytes32 claimId) internal {
        vm.prank(admin);
        court.assignBondClaimPanel(claimId, _panel());
    }

    // =====================================================================
    // setBondPool wiring
    // =====================================================================

    function test_setBondPool_oneTimeOnly() public {
        ProvianCourtV2 fresh = new ProvianCourtV2(admin, address(escrow), address(new MockEpochClock(0)), address(pvt), address(new MockIssuanceIndex()));
        vm.prank(admin);
        fresh.setBondPool(address(bondPool));
        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.BondPoolAlreadySet.selector);
        fresh.setBondPool(address(bondPool));
    }

    function test_setBondPool_onlyAdmin() public {
        ProvianCourtV2 fresh = new ProvianCourtV2(admin, address(escrow), address(new MockEpochClock(0)), address(pvt), address(new MockIssuanceIndex()));
        vm.prank(outsider);
        vm.expectRevert(ProvianCourtV2.OnlyAdmin.selector);
        fresh.setBondPool(address(bondPool));
    }

    function test_setBondPool_rejectsZero() public {
        ProvianCourtV2 fresh = new ProvianCourtV2(admin, address(escrow), address(new MockEpochClock(0)), address(pvt), address(new MockIssuanceIndex()));
        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.InvalidAddress.selector);
        fresh.setBondPool(address(0));
    }

    function test_assignBondPanel_revertsIfBondPoolUnset() public {
        ProvianCourtV2 fresh = new ProvianCourtV2(admin, address(escrow), address(new MockEpochClock(0)), address(pvt), address(new MockIssuanceIndex()));
        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.BondPoolNotSet.selector);
        fresh.assignBondClaimPanel(keccak256("x"), _panel());
    }

    // =====================================================================
    // Panel assignment validation
    // =====================================================================

    function test_assignBondPanel_happyPath() public {
        (bytes32 claimId, ) = _postAndFile("happy");
        // institution deployment: the assignment event carries a ZERO deadline — the window opens on the
        // third posting, so a panel is never charged for the time it spent assembling.
        vm.expectEmit(true, true, false, true, address(court));
        emit ProvianCourtV2.BondPanelAssigned(claimId, agent, arb1, arb2, arb3, 0);
        _assignUnposted(claimId);

        assertTrue(court.bondDisputeExists(claimId));
        assertEq(court.getBondDisputeAgent(claimId), agent);
        address[3] memory p = court.getBondPanel(claimId);
        assertEq(p[0], arb1);
        assertEq(uint8(court.getBondDisputeStatus(claimId)), uint8(ProvianCourtV2.DisputeStatus.Pending));
        assertEq(court.getBondVotingDeadline(claimId), 0, "unarmed until the panel is seated");

        _postAllBond(claimId);
        assertEq(court.getBondVotingDeadline(claimId), block.timestamp + VOTING_WINDOW);
    }

    function test_assignBondPanel_onlyAdmin() public {
        (bytes32 claimId, ) = _postAndFile("only-admin");
        vm.prank(outsider);
        vm.expectRevert(ProvianCourtV2.OnlyAdmin.selector);
        court.assignBondClaimPanel(claimId, _panel());
    }

    function test_assignBondPanel_rejectsNonFiledClaim() public {
        // No bond / no claim on the pool for this id.
        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.BondClaimNotFiled.selector);
        court.assignBondClaimPanel(keccak256("never-filed"), _panel());
    }

    function test_assignBondPanel_rejectsResolvedClaim() public {
        // A claim already slashed is no longer Filed → cannot be re-paneled.
        (bytes32 claimId, ) = _postAndFile("resolved");
        _assign(claimId);
        vm.prank(arb1);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.SlashFull);
        vm.prank(arb2);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.SlashFull); // resolves + slashes

        // The same on-chain claimId is now Upheld; a NEW dispute over it fails closed.
        ProvianCourtV2 fresh = new ProvianCourtV2(admin, address(escrow), address(new MockEpochClock(0)), address(pvt), address(new MockIssuanceIndex()));
        vm.prank(admin);
        fresh.setBondPool(address(bondPool));
        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.BondClaimNotFiled.selector);
        fresh.assignBondClaimPanel(claimId, _panel());
    }

    function test_assignBondPanel_rejectsAgentAsPanelist() public {
        (bytes32 claimId, ) = _postAndFile("agent-panelist");
        address[3] memory bad = [agent, arb2, arb3];
        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.ArbitratorIsParty.selector);
        court.assignBondClaimPanel(claimId, bad);
    }

    function test_assignBondPanel_rejectsClaimantAsPanelist() public {
        (bytes32 claimId, ) = _postAndFile("claimant-panelist");
        address[3] memory bad = [arb1, claimant, arb3];
        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.ArbitratorIsParty.selector);
        court.assignBondClaimPanel(claimId, bad);
    }

    function test_assignBondPanel_rejectsDuplicateAndZero() public {
        (bytes32 claimId, ) = _postAndFile("dup-zero");
        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.DuplicateArbitrator.selector);
        court.assignBondClaimPanel(claimId, [arb1, arb1, arb3]);
        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.InvalidAddress.selector);
        court.assignBondClaimPanel(claimId, [arb1, address(0), arb3]);
    }

    function test_assignBondPanel_rejectsAlreadyAssigned() public {
        (bytes32 claimId, ) = _postAndFile("already");
        _assign(claimId);
        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.DisputeAlreadyExists.selector);
        court.assignBondClaimPanel(claimId, _panel());
    }

    // =====================================================================
    // Voting + resolution (2-of-3 majority)
    // =====================================================================

    function test_bondClaim_fullSlash_unblocksWithdraw() public {
        (bytes32 claimId, uint256 locked) = _postAndFile("full");
        _assign(claimId);

        uint256 claimantBefore = pvt.balanceOf(claimant);
        uint256 burnedBefore = pvt.totalBurned();

        vm.prank(arb1);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.SlashFull);
        vm.expectEmit(true, true, false, true, address(court));
        emit ProvianCourtV2.BondClaimResolved(claimId, agent, ProvianCourtV2.BondVerdictVote.SlashFull, locked);
        vm.prank(arb2);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.SlashFull);

        // Full slash: 80% of the whole bond to claimant + filing fee back; bond drained.
        uint256 expectedClaimant = (locked * SLASH_PAYOUT_BPS) / MAX_BPS;
        assertEq(pvt.balanceOf(claimant), claimantBefore + expectedClaimant + FILING_FEE, "claimant payout");
        assertEq(pvt.totalBurned(), burnedBefore + (locked - expectedClaimant), "burn 20%");

        (uint256 amtAfter, , , , , , uint256 pending) = bondPool.bonds(agent);
        assertEq(amtAfter, 0, "bond drained by full slash");
        assertEq(pending, 0, "pendingClaims decremented");
        assertEq(uint8(court.getBondDisputeStatus(claimId)), uint8(ProvianCourtV2.DisputeStatus.Resolved));

        // THE FIX: the previously-frozen bond can now be withdrawn (no pending claims).
        vm.prank(agent);
        bondPool.withdrawBond(); // would revert ClaimsPending before the fix
        (, , , , , ProvianBondPool.BondStatus finalStatus,) = bondPool.bonds(agent);
        assertEq(uint8(finalStatus), uint8(ProvianBondPool.BondStatus.Withdrawn));
    }

    function test_bondClaim_partialSlash_floorAmount() public {
        (bytes32 claimId, uint256 locked) = _postAndFile("partial");
        _assign(claimId);
        uint256 floorAmt = (locked * MIN_SLASH_PAYOUT_BPS) / MAX_BPS;

        uint256 claimantBefore = pvt.balanceOf(claimant);

        vm.prank(arb1);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.SlashPartial);
        vm.expectEmit(true, true, false, true, address(court));
        emit ProvianCourtV2.BondClaimResolved(claimId, agent, ProvianCourtV2.BondVerdictVote.SlashPartial, floorAmt);
        vm.prank(arb2);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.SlashPartial);

        uint256 expectedClaimant = (floorAmt * SLASH_PAYOUT_BPS) / MAX_BPS;
        assertEq(pvt.balanceOf(claimant), claimantBefore + expectedClaimant + FILING_FEE, "partial payout");

        (uint256 amtAfter, , , , , , uint256 pending) = bondPool.bonds(agent);
        assertEq(amtAfter, locked - floorAmt - CLAIMS_PROCESSING_FEE, "bond reduced by 50% + proc fee");
        assertEq(pending, 0, "pendingClaims decremented");

        // Bond still has collateral but withdrawal is now unblocked.
        vm.prank(agent);
        bondPool.withdrawBond();
    }

    function test_bondClaim_dismiss_burnsFeeNoSlash() public {
        (bytes32 claimId, uint256 locked) = _postAndFile("dismiss");
        _assign(claimId);

        uint256 claimantBefore = pvt.balanceOf(claimant);
        uint256 burnedBefore = pvt.totalBurned();

        vm.prank(arb1);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.Dismiss);
        vm.expectEmit(true, true, false, true, address(court));
        emit ProvianCourtV2.BondClaimResolved(claimId, agent, ProvianCourtV2.BondVerdictVote.Dismiss, 0);
        vm.prank(arb2);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.Dismiss);

        // Dismiss: filing fee burned, claimant NOT refunded, no slash.
        assertEq(pvt.balanceOf(claimant), claimantBefore, "claimant not refunded on dismiss");
        assertEq(pvt.totalBurned(), burnedBefore + FILING_FEE, "filing fee burned");

        (uint256 amtAfter, , , , , , uint256 pending) = bondPool.bonds(agent);
        // Only the processing fee left the bond (no slash).
        assertEq(amtAfter, locked - CLAIMS_PROCESSING_FEE, "bond unslashed (minus proc fee)");
        assertEq(pending, 0, "pendingClaims decremented");

        vm.prank(agent);
        bondPool.withdrawBond(); // unblocked
    }

    function test_bondClaim_splitVote_resolvesDismiss() public {
        // 1 dismiss + 1 partial + 1 full → no 2-majority → resolves to Dismiss
        // on the 3rd vote (no slash without a clear majority).
        (bytes32 claimId, uint256 locked) = _postAndFile("split");
        _assign(claimId);

        vm.prank(arb1);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.Dismiss);
        vm.prank(arb2);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.SlashPartial);
        assertEq(uint8(court.getBondDisputeStatus(claimId)), uint8(ProvianCourtV2.DisputeStatus.Pending));

        vm.prank(arb3);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.SlashFull);

        // Resolved as Dismiss: no slash.
        assertEq(uint8(court.getBondDisputeStatus(claimId)), uint8(ProvianCourtV2.DisputeStatus.Resolved));
        (uint256 amtAfter, , , , , , uint256 pending) = bondPool.bonds(agent);
        assertEq(amtAfter, locked - CLAIMS_PROCESSING_FEE, "no slash on 1/1/1 split");
        assertEq(pending, 0);
    }

    function test_bondClaim_singleVoteDoesNotResolve() public {
        (bytes32 claimId, ) = _postAndFile("single");
        _assign(claimId);
        vm.prank(arb1);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.SlashFull);
        assertEq(uint8(court.getBondDisputeStatus(claimId)), uint8(ProvianCourtV2.DisputeStatus.Pending));
        (, , , , , , uint256 pending) = bondPool.bonds(agent);
        assertEq(pending, 1, "still frozen pending more votes");
    }

    function test_castBondVote_rejectsNonPanelist() public {
        (bytes32 claimId, ) = _postAndFile("nonpanelist");
        _assign(claimId);
        vm.prank(outsider);
        vm.expectRevert(ProvianCourtV2.NotPanelMember.selector);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.SlashFull);
    }

    function test_castBondVote_rejectsDoubleVote() public {
        (bytes32 claimId, ) = _postAndFile("double");
        _assign(claimId);
        vm.prank(arb1);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.SlashFull);
        vm.prank(arb1);
        vm.expectRevert(ProvianCourtV2.AlreadyVoted.selector);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.Dismiss);
    }

    function test_castBondVote_rejectsNoneVerdict() public {
        (bytes32 claimId, ) = _postAndFile("none");
        _assign(claimId);
        vm.prank(arb1);
        vm.expectRevert(ProvianCourtV2.InvalidBondVerdict.selector);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.None);
    }

    function test_castBondVote_rejectsAfterDeadline() public {
        (bytes32 claimId, ) = _postAndFile("deadline");
        _assign(claimId);
        vm.warp(block.timestamp + VOTING_WINDOW + 1);
        vm.prank(arb1);
        vm.expectRevert(ProvianCourtV2.VotingClosed.selector);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.SlashFull);
    }

    function test_castBondVote_rejectsUnknownClaim() public {
        vm.prank(arb1);
        vm.expectRevert(ProvianCourtV2.DisputeNotFound.selector);
        court.castBondClaimVote(keccak256("never-assigned"), ProvianCourtV2.BondVerdictVote.SlashFull);
    }

    function test_castBondVote_rejectsOnResolved() public {
        (bytes32 claimId, ) = _postAndFile("post-resolve");
        _assign(claimId);
        vm.prank(arb1);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.SlashFull);
        vm.prank(arb2);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.SlashFull); // resolves
        vm.prank(arb3);
        vm.expectRevert(ProvianCourtV2.DisputeNotPending.selector);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.Dismiss);
    }

    // =====================================================================
    // Deadline finalization (permissionless dismiss; never a slash, never admin)
    // =====================================================================

    function test_finalizeBondClaim_dismissesAfterDeadline() public {
        (bytes32 claimId, uint256 locked) = _postAndFile("finalize");
        _assign(claimId);
        // Only one vote cast; panel never reaches a majority.
        vm.prank(arb1);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.SlashFull);

        vm.warp(block.timestamp + VOTING_WINDOW + 1);
        // Permissionless: anyone can finalize, and the ONLY outcome is dismiss.
        vm.prank(outsider);
        court.finalizeBondClaim(claimId);

        assertEq(uint8(court.getBondDisputeStatus(claimId)), uint8(ProvianCourtV2.DisputeStatus.Resolved));
        (uint256 amtAfter, , , , , , uint256 pending) = bondPool.bonds(agent);
        assertEq(amtAfter, locked - CLAIMS_PROCESSING_FEE, "deadline finalize never slashes");
        assertEq(pending, 0, "freeze lifted by finalize");

        vm.prank(agent);
        bondPool.withdrawBond(); // unblocked, no admin involved
    }

    function test_finalizeBondClaim_rejectsBeforeDeadline() public {
        (bytes32 claimId, ) = _postAndFile("finalize-early");
        _assign(claimId);
        vm.expectRevert(ProvianCourtV2.VotingNotExpired.selector);
        court.finalizeBondClaim(claimId);
    }

    function test_finalizeBondClaim_rejectsResolved() public {
        (bytes32 claimId, ) = _postAndFile("finalize-resolved");
        _assign(claimId);
        vm.prank(arb1);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.Dismiss);
        vm.prank(arb2);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.Dismiss); // resolved
        vm.warp(block.timestamp + VOTING_WINDOW + 1);
        vm.expectRevert(ProvianCourtV2.DisputeNotPending.selector);
        court.finalizeBondClaim(claimId);
    }

    // =====================================================================
    // Non-custody / trust: only the Court (not admin, not EOAs) can slash
    // =====================================================================

    function test_adminCannotSlashDirectly() public {
        (bytes32 claimId, uint256 locked) = _postAndFile("admin-cant");
        // Admin is NOT the court — slashBond is onlyCourt. Admin cannot slash,
        // drain, or unfreeze a bond directly.
        vm.prank(admin);
        vm.expectRevert(ProvianBondPool.OnlyCourt.selector);
        bondPool.slashBond(agent, locked, claimId);
        vm.prank(admin);
        vm.expectRevert(ProvianBondPool.OnlyCourt.selector);
        bondPool.dismissClaim(agent, claimId);
    }
}

