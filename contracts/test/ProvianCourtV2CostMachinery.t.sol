// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ProvianCourtV2.sol";
import "../src/ProvianPVT9.sol";
import "./MockEpochClock.sol";
import "./MockIssuanceIndex.sol";
import {MockPVT} from "./MockTokens.sol";

/// @dev Minimal escrow the Court reads for panel conflict-of-interest checks.
contract CostMockEscrow {
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

/// @dev Minimal BondPool exposing just what assignBondClaimPanel reads: a Filed claim
///      and its parties. slash/dismiss are unused by the voting-period tests.
contract CostMockBondPool {
    struct C {
        address claimant;
        address agent;
        uint256 filingFee;
        uint8 status;
        uint256 filedAt;
    }

    mapping(bytes32 => C) internal _claims;
    mapping(bytes32 => bool) public claimExists;

    function fileMockClaim(bytes32 claimId, address claimant, address agent) external {
        _claims[claimId] = C(claimant, agent, 0, 0 /* Filed */, block.timestamp);
        claimExists[claimId] = true;
    }

    function claims(bytes32 claimId) external view returns (address, address, uint256, uint8, uint256) {
        C memory c = _claims[claimId];
        return (c.claimant, c.agent, c.filingFee, c.status, c.filedAt);
    }

    function bonds(address) external pure returns (uint256, uint8, uint256, uint256, uint256, uint8, uint256) {
        return (0, 0, 0, 0, 0, 0, 0);
    }

    function MIN_SLASH_PAYOUT_BPS() external pure returns (uint256) {
        return 5000;
    }

    function MAX_BPS() external pure returns (uint256) {
        return 10000;
    }

    function slashBond(address, uint256, bytes32) external {}
    function dismissClaim(address, bytes32) external {}
}

/**
 * @title ProvianCourtV2CostMachineryTest
 * @notice institution parameters-rem -- the Court's single COST parameter, the panel voting period,
 * on the kernel-clock-bound machinery (bound to ProvianPVT9.currentEpoch();
 * no local counter, no permissionless epoch-advance). Unset → the historical
 * 48-hour literal stands byte-for-byte (proven by the unchanged ProvianCourtV2
 * suite and the "unset == 48h" tests). agent directory owns Court MECHANICS; every other
 * court.* cost row is not_implemented / dropped-reputation and is deferred to agent directory.
 *
 * VALUE-NEUTRAL BY CONSTRUCTION. The probe period is an arbitrary in-range TEST-ONLY
 * fixture. It is not an approval, a recommendation, or a claim about live economics.
 */
contract ProvianCourtV2CostMachineryTest is Test {
    ProvianCourtV2 public court;
    CostMockEscrow public escrow;
    /// @dev institution deployment: the court custodies arbitrator per-case collateral, so it binds PVT.
    MockPVT public courtPvt;
    CostMockBondPool public bondPool;
    MockEpochClock public clock;

    address public admin = address(0xA01);
    address public stranger = address(0xBAD);
    address public arb1 = address(0xC01);
    address public arb2 = address(0xC02);
    address public arb3 = address(0xC03);
    address public depositor = address(0xD01);
    address public recipient = address(0xD02);

    uint256 internal constant EPOCH_START = 1_000_000;
    uint256 internal constant EPOCH_DURATION = 7 days;

    uint256 internal constant DEFAULT_PERIOD = 48 hours; // 172,800
    uint256 internal constant PROBE_PERIOD = 7 days;      // inside [1d, 14d], != 48h. NOT an approval.

    function setUp() public {
        escrow = new CostMockEscrow();
        bondPool = new CostMockBondPool();
        courtPvt = new MockPVT();
        clock = new MockEpochClock(uint64(EPOCH_START));
        vm.warp(EPOCH_START); // kernel epoch 0
        court = new ProvianCourtV2(admin, address(escrow), address(clock), address(courtPvt), address(new MockIssuanceIndex()));
        vm.prank(admin);
        court.setBondPool(address(bondPool));

        // institution deployment: fund + approve the three panelists this suite seats, so posting the
        // per-case collateral never becomes the reason a voting-period test fails.
        address[3] memory arbs = _panel();
        for (uint256 i = 0; i < 3; i++) {
            courtPvt.mint(arbs[i], 1_000_000e18);
            vm.prank(arbs[i]);
            courtPvt.approve(address(court), type(uint256).max);
        }
    }

    function _toEpoch(uint64 n) internal {
        vm.warp(EPOCH_START + uint256(n) * EPOCH_DURATION);
    }

    function _panel() internal view returns (address[3] memory) {
        return [arb1, arb2, arb3];
    }

    /// @dev the escrow's flat adjudication fee, routed in by the wired escrow.
    ///      `assignPanel` is gated on it, so every escrow-panel fixture escalates first.
    function _fundAdj(ProvianCourtV2 c, bytes32 id) internal {
        courtPvt.mint(address(c), 30e18);
        vm.prank(address(escrow));
        c.fundEscrowDisputeReward(id, 30e18);
    }

    function _assignEscrowPanel(bytes32 id) internal returns (uint256 deadline) {
        escrow.setParties(id, depositor, recipient);
        _fundAdj(court, id);
        vm.prank(admin);
        court.assignPanel(id, _panel());
        // institution deployment: assignment no longer arms the voting deadline — the third collateral
        // posting does. Seat the panel so this helper still returns the armed
        // deadline, which is what every voting-period assertion here is about.
        address[3] memory arbs = _panel();
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(arbs[i]);
            court.postEscrowCollateral(id);
        }
        return court.getVotingDeadline(id);
    }

    function _assignBondPanel(bytes32 claimId) internal returns (uint256 deadline) {
        bondPool.fileMockClaim(claimId, depositor, recipient); // claimant, agent (neither is a panelist)
        vm.prank(admin);
        court.assignBondClaimPanel(claimId, _panel());
        // institution deployment: same — seat the panel so the deadline is armed.
        address[3] memory arbs = _panel();
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(arbs[i]);
            court.postBondClaimCollateral(claimId);
        }
        return court.getBondVotingDeadline(claimId);
    }

    function _setAndOpenPeriod(uint256 period) internal {
        vm.prank(admin);
        court.schedulePanelVotingPeriod(1, period);
        _toEpoch(1);
    }

    // ========================================================================
    // Epoch machinery
    // ========================================================================

    function test_court_epoch_startsAtZero_firstSchedulableIsOne() public view {
        assertEq(court.earliestSchedulableEpoch(), 1);
    }

    function test_court_clockAdvance_movesSchedulableEpoch() public {
        _toEpoch(1);
        assertEq(court.earliestSchedulableEpoch(), 2);
        _toEpoch(2);
        assertEq(court.earliestSchedulableEpoch(), 3);
    }

    function test_court_noPermissionlessOpenNextEpoch() public {
        (bool ok,) = address(court).call(abi.encodeWithSignature("openNextEpoch()"));
        assertFalse(ok);
        (bool ok2,) = address(court).call(abi.encodeWithSignature("lastOpenedEpoch()"));
        assertFalse(ok2);
    }

    function test_court_ladder_nonCollapsibleInSingleBlock() public {
        vm.startPrank(admin);
        court.schedulePanelVotingPeriod(1, 1 days);
        court.schedulePanelVotingPeriod(2, 2 days);
        court.schedulePanelVotingPeriod(3, 3 days);
        vm.stopPrank();

        (bool e0,) = court.activePanelVotingPeriod();
        assertFalse(e0);

        _toEpoch(1);
        (bool e1, uint256 a1) = court.activePanelVotingPeriod();
        assertTrue(e1);
        assertEq(a1, 1 days, "epoch 1 resolves to rung 1, not a collapsed rung 3");
        (bool ok,) = address(court).call(abi.encodeWithSignature("openNextEpoch()"));
        assertFalse(ok);
        (, uint256 a1still) = court.activePanelVotingPeriod();
        assertEq(a1still, 1 days, "the ladder cannot be collapsed in a single block");

        _toEpoch(2);
        (, uint256 a2) = court.activePanelVotingPeriod();
        assertEq(a2, 2 days);
        _toEpoch(3);
        (, uint256 a3) = court.activePanelVotingPeriod();
        assertEq(a3, 3 days);
    }

    function test_court_forwardFill_valuePersistsUntilNextSchedule() public {
        vm.startPrank(admin);
        court.schedulePanelVotingPeriod(1, 1 days);
        court.schedulePanelVotingPeriod(3, 3 days); // epoch 2 skipped
        vm.stopPrank();
        _toEpoch(1);
        (, uint256 a1) = court.activePanelVotingPeriod();
        assertEq(a1, 1 days);
        _toEpoch(2);
        (, uint256 a2) = court.activePanelVotingPeriod();
        assertEq(a2, 1 days, "epoch 2 (unscheduled) carries rung 1 forward");
        _toEpoch(3);
        (, uint256 a3) = court.activePanelVotingPeriod();
        assertEq(a3, 3 days);
    }

    function test_court_outOfOrderSchedule_resolvesByEpoch() public {
        vm.startPrank(admin);
        court.schedulePanelVotingPeriod(3, 3 days);
        court.schedulePanelVotingPeriod(1, 1 days);
        vm.stopPrank();
        _toEpoch(1);
        (, uint256 a1) = court.activePanelVotingPeriod();
        assertEq(a1, 1 days);
        _toEpoch(3);
        (, uint256 a3) = court.activePanelVotingPeriod();
        assertEq(a3, 3 days);
    }

    function test_court_unarmedKernel_failsClosedToBaseline() public {
        vm.prank(admin);
        court.schedulePanelVotingPeriod(1, PROBE_PERIOD);
        clock.disarm();
        (bool active,) = court.activePanelVotingPeriod();
        assertFalse(active, "unarmed clock -> epoch 0 -> no override");

        uint256 deadline = _assignEscrowPanel(keccak256("unarmed"));
        assertEq(deadline, block.timestamp + DEFAULT_PERIOD, "unarmed kernel must arm the 48h baseline, not brick");
    }

    function test_court_realKernelBinding_unarmedFailsClosed() public {
        ProvianPVT9 realKernel = new ProvianPVT9();
        ProvianCourtV2 bound =
            new ProvianCourtV2(admin, address(escrow), address(realKernel), address(courtPvt), address(realKernel));

        vm.expectRevert(ProvianPVT9.EpochZeroNotArmed.selector);
        realKernel.currentEpoch();

        assertEq(bound.earliestSchedulableEpoch(), 1, "unarmed real kernel resolves to epoch 0");

        bytes32 id = keccak256("rk");
        escrow.setParties(id, depositor, recipient);
        _fundAdj(bound, id);
        vm.prank(admin);
        bound.assignPanel(id, _panel());

        // institution deployment: the SAME unarmed kernel is bound as the issuance index here, so this
        // also proves the collateral floor fails closed to its baseline rather than
        // bricking assignment — `arbitratorCollateral()` must resolve, not revert.
        assertEq(
            bound.arbitratorCollateral(),
            bound.ARBITRATOR_COLLATERAL_BASELINE() / bound.ARBITRATOR_COLLATERAL_DIVISOR(),
            "unarmed real kernel -> baseline collateral, not a revert"
        );

        // Seat the panel so the voting window opens, then assert the 48h baseline.
        address[3] memory arbs = _panel();
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(arbs[i]);
            courtPvt.approve(address(bound), type(uint256).max);
            vm.prank(arbs[i]);
            bound.postEscrowCollateral(id);
        }
        assertEq(bound.getVotingDeadline(id), block.timestamp + DEFAULT_PERIOD, "unarmed real kernel -> 48h baseline");
    }

    function test_court_openingUnscheduledEpoch_leavesInert() public {
        _toEpoch(1);
        (bool a, uint256 v) = court.activePanelVotingPeriod();
        assertFalse(a);
        assertEq(v, 0);
        uint256 deadline = _assignEscrowPanel(keccak256("carry"));
        assertEq(deadline, block.timestamp + DEFAULT_PERIOD, "an unscheduled epoch keeps the 48h baseline");
    }

    // ========================================================================
    // schedulePanelVotingPeriod -- authority / prospectivity / one-per-epoch / bounds / event
    // ========================================================================

    function test_court_schedule_revertsForNonAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(ProvianCourtV2.OnlyAdmin.selector);
        court.schedulePanelVotingPeriod(1, PROBE_PERIOD);
        (bool exists,) = court.scheduledPanelVotingPeriod(1);
        assertFalse(exists);
    }

    function test_court_schedule_rejectsCurrentEpoch() public {
        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.PolicyNotProspective.selector);
        court.schedulePanelVotingPeriod(0, PROBE_PERIOD);
    }

    function test_court_schedule_rejectsAlreadyOpenedEpoch() public {
        _toEpoch(1);
        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.PolicyNotProspective.selector);
        court.schedulePanelVotingPeriod(1, PROBE_PERIOD);
    }

    function test_court_schedule_rejectsReschedulingTakenEpoch() public {
        vm.startPrank(admin);
        court.schedulePanelVotingPeriod(1, PROBE_PERIOD);
        vm.expectRevert(ProvianCourtV2.PolicyAlreadyScheduled.selector);
        court.schedulePanelVotingPeriod(1, PROBE_PERIOD + 1 days);
        vm.stopPrank();
        (, uint256 value) = court.scheduledPanelVotingPeriod(1);
        assertEq(value, PROBE_PERIOD);
    }

    function test_court_schedule_rejectsBelowFloor() public {
        uint256 belowFloor = court.PANEL_VOTING_PERIOD_MIN() - 1;
        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.CostOutOfDomain.selector);
        court.schedulePanelVotingPeriod(1, belowFloor);
    }

    function test_court_schedule_rejectsAboveCeiling() public {
        uint256 aboveCeiling = court.PANEL_VOTING_PERIOD_MAX() + 1;
        vm.prank(admin);
        vm.expectRevert(ProvianCourtV2.CostOutOfDomain.selector);
        court.schedulePanelVotingPeriod(1, aboveCeiling);
    }

    function test_court_schedule_acceptsFloorAndCeiling() public {
        uint256 floor = court.PANEL_VOTING_PERIOD_MIN();
        uint256 ceiling = court.PANEL_VOTING_PERIOD_MAX();
        vm.startPrank(admin);
        court.schedulePanelVotingPeriod(1, floor);
        court.schedulePanelVotingPeriod(2, ceiling);
        vm.stopPrank();
        (, uint256 v1) = court.scheduledPanelVotingPeriod(1);
        (, uint256 v2) = court.scheduledPanelVotingPeriod(2);
        assertEq(v1, floor);
        assertEq(v2, ceiling);
    }

    function test_court_schedule_emitsEvent() public {
        vm.expectEmit(true, false, false, true, address(court));
        emit ProvianCourtV2.PanelVotingPeriodScheduled(1, PROBE_PERIOD);
        vm.prank(admin);
        court.schedulePanelVotingPeriod(1, PROBE_PERIOD);
    }

    function test_court_scheduledButInertUntilEpochOpens() public {
        vm.prank(admin);
        court.schedulePanelVotingPeriod(1, PROBE_PERIOD);
        (bool active,) = court.activePanelVotingPeriod();
        assertFalse(active);
    }

    // ========================================================================
    // Fail-closed baseline: unset -> 48h at BOTH panel-assignment sites
    // ========================================================================

    function test_court_escrowPanel_unset_arms48hBaseline() public {
        uint256 deadline = _assignEscrowPanel(keccak256("escrow-baseline"));
        assertEq(deadline, block.timestamp + DEFAULT_PERIOD, "unset -> 48h at assignPanel");
        assertEq(court.DEFAULT_PANEL_VOTING_PERIOD(), 48 hours, "the baseline constant is 48 hours");
    }

    function test_court_bondPanel_unset_arms48hBaseline() public {
        uint256 deadline = _assignBondPanel(keccak256("bond-baseline"));
        assertEq(deadline, block.timestamp + DEFAULT_PERIOD, "unset -> 48h at assignBondClaimPanel");
    }

    // ========================================================================
    // End-to-end: an activated override drives the armed deadline at BOTH sites
    // ========================================================================

    function test_court_escrowPanel_openedOverride_drivesArmedDeadline() public {
        _setAndOpenPeriod(PROBE_PERIOD);
        uint256 deadline = _assignEscrowPanel(keccak256("escrow-override"));
        assertEq(deadline, block.timestamp + PROBE_PERIOD, "activated override drives the escrow-panel deadline");
        assertTrue(PROBE_PERIOD != DEFAULT_PERIOD, "probe must differ from the 48h baseline");
    }

    function test_court_bondPanel_openedOverride_drivesArmedDeadline() public {
        _setAndOpenPeriod(PROBE_PERIOD);
        uint256 deadline = _assignBondPanel(keccak256("bond-override"));
        assertEq(deadline, block.timestamp + PROBE_PERIOD, "activated override drives the bond-panel deadline");
    }

    // ========================================================================
    // Review hardening -- immutable bounds pinned to the frozen catalog
    // ========================================================================

    function test_court_immutableBounds_matchTheFrozenCatalogRange() public view {
        assertEq(court.PANEL_VOTING_PERIOD_MIN(), 86_400, "panel-voting-period floor = 1 day");
        assertEq(court.PANEL_VOTING_PERIOD_MAX(), 1_209_600, "panel-voting-period ceiling = 14 days");
        assertEq(court.DEFAULT_PANEL_VOTING_PERIOD(), 172_800, "baseline = 48 hours = 172,800 s");
    }
}
