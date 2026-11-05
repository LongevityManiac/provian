// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ProvianPoolV3.sol";
import "../src/ProvianPVT9.sol";
import "./MockTokens.sol";
import "./MockEpochClock.sol";

/**
 * @title ProvianPoolV3CostMachineryTest
 * @notice institution parameters-rem -- the Pool-native cost-parameter machinery: bounded, admin-only
 * (the bootstrap admin EOA on live Base), prospective-epoch schedulers whose values
 * activate lazily when the KERNEL epoch reaches them (bound to
 * ProvianPVT9.currentEpoch() via an immutable clock; no local counter, no
 * permissionless epoch-advance, so a queued ladder cannot be collapsed in a
 * single block). Every parameter defaults fail-closed to inert, so with
 * nothing scheduled the contract behaves byte-for-byte as pre-institution parameters (proven
 * directly by the unchanged ProvianPoolV3 / ProvianPoolV3Pass3 suites, and
 * here by the "unset == baseline" tests). Identical machinery shape to
 * ProvianEscrowV4 / ProvianPromiseV3.
 *
 * VALUE-NEUTRAL BY CONSTRUCTION. Every probe rate/duration/limit in this file is an
 * arbitrary, in-range, TEST-ONLY fixture chosen solely to exercise the machinery.
 * NONE is an approval, a recommendation, or a claim about live economics.
 */
contract ProvianPoolV3CostMachineryTest is Test {
    ProvianPoolV3 public pool;
    MockUSDC public usdc;
    MockPVT public pvt;
    MockEpochClock public clock;

    address public admin = address(0xA01);
    address public feeWallet = address(0xFEE);
    address public target = address(0x7A6);
    address public stranger = address(0xBAD);

    uint256 internal constant EPOCH_START = 1_000_000;
    uint256 internal constant EPOCH_DURATION = 7 days; // matches ProvianPVT9.EPOCH_DURATION

    uint256 internal constant PVT_THRESHOLD = 1000e18;

    // TEST-ONLY probes, all in-range and deliberately distinct from the baselines. NOT approvals.
    uint256 internal constant PROBE_FEE_BPS = 25;        // != 50-bps baseline literal
    uint256 internal constant PROBE_CAP = 500e18;        // inside [1 PVT, 1,000,000 PVT]
    uint256 internal constant PROBE_DEADLINE = 30 days;  // inside [1h, 180d]
    uint256 internal constant PROBE_CONTRIBUTORS = 3;    // inside [2, 200], != 200 ceiling

    function setUp() public {
        usdc = new MockUSDC();
        pvt = new MockPVT();
        clock = new MockEpochClock(uint64(EPOCH_START));
        vm.warp(EPOCH_START); // kernel epoch 0
        pool = new ProvianPoolV3(admin, feeWallet, address(usdc), address(pvt), address(clock));
    }

    /// @dev Advance real time so the kernel clock (and thus the institution) reads epoch `n`.
    function _toEpoch(uint64 n) internal {
        vm.warp(EPOCH_START + uint256(n) * EPOCH_DURATION);
    }

    /// @dev Create a PVT pool (deadline 1 day out) and return its stored fee.
    function _createPoolPVT(bytes32 id, uint256 threshold) internal returns (uint256 fee) {
        vm.prank(target);
        pool.createPool(id, target, threshold, block.timestamp + 1 days, ProvianPoolV3.Currency.PVT);
        (,,,, fee,,,) = pool.pools(id);
    }

    /// @dev Create a PVT pool whose funding window is `window` seconds from now.
    function _createPoolPVTWithWindow(bytes32 id, uint256 window) internal {
        vm.prank(target);
        pool.createPool(id, target, PVT_THRESHOLD, block.timestamp + window, ProvianPoolV3.Currency.PVT);
    }

    function _setAndOpenCap(uint256 cap) internal {
        vm.prank(admin);
        pool.scheduleThresholdCap(1, cap);
        _toEpoch(1);
    }

    function _setAndOpenDeadline(uint256 deadline) internal {
        vm.prank(admin);
        pool.scheduleMaximumDeadline(1, deadline);
        _toEpoch(1);
    }

    function _setAndOpenMaxContributors(uint256 n) internal {
        vm.prank(admin);
        pool.scheduleMaxContributors(1, n);
        _toEpoch(1);
    }

    /// @dev Fund `who`, approve the pool, and contribute `amount` to `poolId`.
    function _contribute(bytes32 poolId, address who, uint256 amount) internal {
        pvt.mint(who, amount);
        vm.startPrank(who);
        pvt.approve(address(pool), amount);
        pool.contribute(poolId, amount);
        vm.stopPrank();
    }

    // ========================================================================
    // Epoch machinery (kernel-clock-bound)
    // ========================================================================

    function test_pool_epoch_startsAtZero_firstSchedulableIsOne() public view {
        assertEq(pool.earliestSchedulableEpoch(), 1, "first schedulable epoch is 1 at epoch 0");
    }

    function test_pool_clockAdvance_movesSchedulableEpoch() public {
        _toEpoch(1);
        assertEq(pool.earliestSchedulableEpoch(), 2);
        _toEpoch(2);
        assertEq(pool.earliestSchedulableEpoch(), 3);
    }

    function test_pool_noPermissionlessOpenNextEpoch() public {
        (bool ok,) = address(pool).call(abi.encodeWithSignature("openNextEpoch()"));
        assertFalse(ok, "openNextEpoch() must not exist");
        (bool ok2,) = address(pool).call(abi.encodeWithSignature("lastOpenedEpoch()"));
        assertFalse(ok2, "lastOpenedEpoch must not exist");
    }

    function test_pool_ladder_nonCollapsibleInSingleBlock() public {
        vm.startPrank(admin);
        pool.scheduleFeeBps(1, 10);
        pool.scheduleFeeBps(2, 20);
        pool.scheduleFeeBps(3, 30);
        vm.stopPrank();

        (bool e0,) = pool.activeFeeBps();
        assertFalse(e0, "no rung active at epoch 0");

        _toEpoch(1);
        (bool e1, uint256 a1) = pool.activeFeeBps();
        assertTrue(e1, "rung 1 active at epoch 1");
        assertEq(a1, 10, "epoch 1 resolves to rung 1, not a collapsed rung 3");
        (bool ok,) = address(pool).call(abi.encodeWithSignature("openNextEpoch()"));
        assertFalse(ok, "no call can advance the epoch inside a block");
        (, uint256 a1still) = pool.activeFeeBps();
        assertEq(a1still, 10, "the ladder cannot be collapsed to rung 3 in a single block");

        _toEpoch(2);
        (, uint256 a2) = pool.activeFeeBps();
        assertEq(a2, 20);
        _toEpoch(3);
        (, uint256 a3) = pool.activeFeeBps();
        assertEq(a3, 30);
    }

    function test_pool_forwardFill_valuePersistsUntilNextSchedule() public {
        vm.startPrank(admin);
        pool.scheduleFeeBps(1, 10);
        pool.scheduleFeeBps(3, 30); // epoch 2 skipped
        vm.stopPrank();

        _toEpoch(1);
        (, uint256 a1) = pool.activeFeeBps();
        assertEq(a1, 10);
        _toEpoch(2);
        (, uint256 a2) = pool.activeFeeBps();
        assertEq(a2, 10, "epoch 2 (unscheduled) carries rung 1 forward");
        _toEpoch(3);
        (, uint256 a3) = pool.activeFeeBps();
        assertEq(a3, 30);
    }

    function test_pool_outOfOrderSchedule_resolvesByEpoch() public {
        vm.startPrank(admin);
        pool.scheduleFeeBps(3, 30);
        pool.scheduleFeeBps(1, 10);
        vm.stopPrank();

        _toEpoch(1);
        (, uint256 a1) = pool.activeFeeBps();
        assertEq(a1, 10, "epoch 1 resolves to its own value despite being scheduled second");
        _toEpoch(3);
        (, uint256 a3) = pool.activeFeeBps();
        assertEq(a3, 30);
    }

    function test_pool_unarmedKernel_failsClosedToBaseline() public {
        vm.prank(admin);
        pool.scheduleFeeBps(1, PROBE_FEE_BPS);
        clock.disarm();

        (bool active,) = pool.activeFeeBps();
        assertFalse(active, "an unarmed clock resolves to epoch 0 -> no override active");

        uint256 fee = _createPoolPVT(keccak256("unarmed"), PVT_THRESHOLD);
        assertEq(fee, (PVT_THRESHOLD * 5) / 1000, "unarmed kernel must fall back to the 50-bps baseline, not brick");
    }

    /// @dev Real-kernel binding: a Pool bound to a real (unarmed) ProvianPVT9 reads its
    ///      ACTUAL currentEpoch(), which reverts EpochZeroNotArmed; the fail-closed
    ///      try/catch treats that as epoch 0, so createPool still succeeds at baseline.
    function test_pool_realKernelBinding_unarmedFailsClosed() public {
        ProvianPVT9 realKernel = new ProvianPVT9();
        ProvianPoolV3 bound = new ProvianPoolV3(admin, feeWallet, address(usdc), address(pvt), address(realKernel));

        vm.expectRevert(ProvianPVT9.EpochZeroNotArmed.selector);
        realKernel.currentEpoch();

        assertEq(bound.earliestSchedulableEpoch(), 1, "unarmed real kernel resolves to epoch 0");

        vm.prank(target);
        bound.createPool(keccak256("rk"), target, PVT_THRESHOLD, block.timestamp + 1 days, ProvianPoolV3.Currency.PVT);
        (,,,, uint256 fee,,,) = bound.pools(keccak256("rk"));
        assertEq(fee, (PVT_THRESHOLD * 5) / 1000, "unarmed real kernel must fall back to the baseline fee");
    }

    function test_pool_openingUnscheduledEpoch_leavesEverythingInert() public {
        _toEpoch(1);

        (bool feeA, uint256 feeV) = pool.activeFeeBps();
        assertFalse(feeA, "no fee override at an empty epoch");
        assertEq(feeV, 0);
        (bool capA, uint256 capV) = pool.activeThresholdCap();
        assertFalse(capA);
        assertEq(capV, 0);
        (bool dlA, uint256 dlV) = pool.activeMaximumDeadline();
        assertFalse(dlA);
        assertEq(dlV, 0);
        (bool cA, uint256 cV) = pool.activeMaxContributors();
        assertFalse(cA);
        assertEq(cV, 0);

        uint256 fee = _createPoolPVT(keccak256("carry"), PVT_THRESHOLD);
        assertEq(fee, (PVT_THRESHOLD * 5) / 1000, "an unscheduled epoch must leave the baseline fee intact");
    }

    // ========================================================================
    // pool.pvt_execution_fee
    // ========================================================================

    function test_pool_scheduleFeeBps_revertsForNonAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(ProvianPoolV3.OnlyAdmin.selector);
        pool.scheduleFeeBps(1, PROBE_FEE_BPS);
        (bool exists,) = pool.scheduledFeeBps(1);
        assertFalse(exists, "a rejected schedule leaves no state");
    }

    function test_pool_scheduleFeeBps_rejectsCurrentEpoch() public {
        vm.prank(admin);
        vm.expectRevert(ProvianPoolV3.PolicyNotProspective.selector);
        pool.scheduleFeeBps(0, PROBE_FEE_BPS);
    }

    function test_pool_scheduleFeeBps_rejectsAlreadyOpenedEpoch() public {
        _toEpoch(1);
        vm.prank(admin);
        vm.expectRevert(ProvianPoolV3.PolicyNotProspective.selector);
        pool.scheduleFeeBps(1, PROBE_FEE_BPS);
    }

    function test_pool_scheduleFeeBps_rejectsReschedulingTakenEpoch() public {
        vm.startPrank(admin);
        pool.scheduleFeeBps(1, PROBE_FEE_BPS);
        vm.expectRevert(ProvianPoolV3.PolicyAlreadyScheduled.selector);
        pool.scheduleFeeBps(1, PROBE_FEE_BPS + 1);
        vm.stopPrank();
        (bool exists, uint256 value) = pool.scheduledFeeBps(1);
        assertTrue(exists);
        assertEq(value, PROBE_FEE_BPS, "a taken epoch's value cannot be overwritten");
    }

    function test_pool_scheduleFeeBps_rejectsAboveMax() public {
        uint256 overMax = pool.FEE_BPS_MAX() + 1;
        vm.prank(admin);
        vm.expectRevert(ProvianPoolV3.CostOutOfDomain.selector);
        pool.scheduleFeeBps(1, overMax);
    }

    function test_pool_scheduleFeeBps_acceptsCeilingAndZeroFloor() public {
        uint256 ceiling = pool.FEE_BPS_MAX();
        vm.startPrank(admin);
        pool.scheduleFeeBps(1, ceiling);
        pool.scheduleFeeBps(2, 0);
        vm.stopPrank();
        (, uint256 v1) = pool.scheduledFeeBps(1);
        (, uint256 v2) = pool.scheduledFeeBps(2);
        assertEq(v1, ceiling);
        assertEq(v2, 0, "zero value stored (0 is a legal fee, not 'unset')");
    }

    function test_pool_scheduleFeeBps_emitsEvent() public {
        vm.expectEmit(true, false, false, true, address(pool));
        emit ProvianPoolV3.FeeBpsScheduled(3, PROBE_FEE_BPS);
        vm.prank(admin);
        pool.scheduleFeeBps(3, PROBE_FEE_BPS);
    }

    function test_pool_feeBps_scheduledButInertUntilEpochOpens() public {
        vm.prank(admin);
        pool.scheduleFeeBps(1, PROBE_FEE_BPS);
        (bool active,) = pool.activeFeeBps();
        assertFalse(active, "scheduled override inert until the kernel reaches its epoch");
    }

    function test_pool_fee_unset_chargesTheBaseline50bpsLiteral() public {
        uint256 fee = _createPoolPVT(keccak256("unset-fee"), PVT_THRESHOLD);
        assertEq(fee, (PVT_THRESHOLD * 5) / 1000, "unset fee must equal the 50-bps baseline literal");
    }

    function test_pool_fee_unset_nonRoundAmount_exactBaselineRounding() public {
        // (threshold*5)/1000 truncates AFTER the multiply. For 12_345: (12345*5)/1000 == 61, not 60.
        uint256 amount = 12_345;
        uint256 fee = _createPoolPVT(keccak256("unset-fee-nonround"), amount);
        assertEq(fee, (amount * 5) / 1000);
        assertEq(fee, 61, "explicit: (12345*5)/1000 == 61, not 60");
    }

    function test_pool_fee_openedOverride_drivesTheStoredFee() public {
        vm.prank(admin);
        pool.scheduleFeeBps(1, PROBE_FEE_BPS);
        _toEpoch(1);
        uint256 fee = _createPoolPVT(keccak256("override-fee"), PVT_THRESHOLD);
        assertEq(fee, (PVT_THRESHOLD * PROBE_FEE_BPS) / 10_000, "an activated override must be the fee stored");
        assertTrue(fee != (PVT_THRESHOLD * 5) / 1000, "probe fee must differ from the baseline literal");
    }

    // ========================================================================
    // pool.pvt_threshold_cap
    // ========================================================================

    function test_pool_scheduleThresholdCap_revertsForNonAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(ProvianPoolV3.OnlyAdmin.selector);
        pool.scheduleThresholdCap(1, PROBE_CAP);
    }

    function test_pool_scheduleThresholdCap_rejectsNonProspectiveEpoch() public {
        vm.prank(admin);
        vm.expectRevert(ProvianPoolV3.PolicyNotProspective.selector);
        pool.scheduleThresholdCap(0, PROBE_CAP);
    }

    function test_pool_scheduleThresholdCap_rejectsReschedulingTakenEpoch() public {
        vm.startPrank(admin);
        pool.scheduleThresholdCap(1, PROBE_CAP);
        vm.expectRevert(ProvianPoolV3.PolicyAlreadyScheduled.selector);
        pool.scheduleThresholdCap(1, PROBE_CAP + 1e18);
        vm.stopPrank();
        (, uint256 value) = pool.scheduledThresholdCap(1);
        assertEq(value, PROBE_CAP);
    }

    function test_pool_scheduleThresholdCap_rejectsBelowFloor() public {
        uint256 belowFloor = pool.THRESHOLD_CAP_MIN() - 1;
        vm.prank(admin);
        vm.expectRevert(ProvianPoolV3.CostOutOfDomain.selector);
        pool.scheduleThresholdCap(1, belowFloor);
    }

    function test_pool_scheduleThresholdCap_rejectsAboveCeiling() public {
        uint256 aboveCeiling = pool.THRESHOLD_CAP_MAX() + 1;
        vm.prank(admin);
        vm.expectRevert(ProvianPoolV3.CostOutOfDomain.selector);
        pool.scheduleThresholdCap(1, aboveCeiling);
    }

    function test_pool_scheduleThresholdCap_acceptsFloorAndCeiling() public {
        uint256 floor = pool.THRESHOLD_CAP_MIN();
        uint256 ceiling = pool.THRESHOLD_CAP_MAX();
        vm.startPrank(admin);
        pool.scheduleThresholdCap(1, floor);
        pool.scheduleThresholdCap(2, ceiling);
        vm.stopPrank();
        (, uint256 v1) = pool.scheduledThresholdCap(1);
        (, uint256 v2) = pool.scheduledThresholdCap(2);
        assertEq(v1, floor);
        assertEq(v2, ceiling);
    }

    function test_pool_scheduleThresholdCap_emitsEvent() public {
        vm.expectEmit(true, false, false, true, address(pool));
        emit ProvianPoolV3.ThresholdCapScheduled(1, PROBE_CAP);
        vm.prank(admin);
        pool.scheduleThresholdCap(1, PROBE_CAP);
    }

    function test_pool_thresholdCap_inertUntilEpochOpens_thenActive() public {
        vm.prank(admin);
        pool.scheduleThresholdCap(1, PROBE_CAP);
        (bool before,) = pool.activeThresholdCap();
        assertFalse(before);
        _toEpoch(1);
        (bool after_, uint256 value) = pool.activeThresholdCap();
        assertTrue(after_);
        assertEq(value, PROBE_CAP);
    }

    function test_pool_thresholdCap_unset_allowsThresholdFarAboveAnyCap() public {
        _createPoolPVT(keccak256("huge-uncapped"), 900_000e18);
        assertEq(
            uint256(pool.currency(keccak256("huge-uncapped"))),
            uint256(ProvianPoolV3.Currency.PVT),
            "unset cap must not gate any PVT threshold"
        );
    }

    function test_pool_thresholdCap_gatesPVTStrictlyAboveCap() public {
        _setAndOpenCap(PROBE_CAP);
        vm.prank(target);
        vm.expectRevert(ProvianPoolV3.ThresholdCapExceeded.selector);
        pool.createPool(keccak256("over"), target, PROBE_CAP + 1, block.timestamp + 1 days, ProvianPoolV3.Currency.PVT);
    }

    function test_pool_thresholdCap_allowsPVTExactlyAtCap() public {
        _setAndOpenCap(PROBE_CAP);
        vm.prank(target);
        pool.createPool(keccak256("at-cap"), target, PROBE_CAP, block.timestamp + 1 days, ProvianPoolV3.Currency.PVT);
        assertEq(uint256(pool.currency(keccak256("at-cap"))), uint256(ProvianPoolV3.Currency.PVT));
    }

    function test_pool_thresholdCap_doesNotGateUSDCPools() public {
        _setAndOpenCap(PROBE_CAP);
        vm.prank(target);
        pool.createPool(
            keccak256("usdc-exempt"), target, PROBE_CAP + 1e18, block.timestamp + 1 days, ProvianPoolV3.Currency.USDC
        );
        assertEq(uint256(pool.currency(keccak256("usdc-exempt"))), uint256(ProvianPoolV3.Currency.USDC));
    }

    // ========================================================================
    // pool.maximum_deadline
    // ========================================================================

    function test_pool_scheduleMaximumDeadline_revertsForNonAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(ProvianPoolV3.OnlyAdmin.selector);
        pool.scheduleMaximumDeadline(1, PROBE_DEADLINE);
    }

    function test_pool_scheduleMaximumDeadline_rejectsNonProspectiveEpoch() public {
        vm.prank(admin);
        vm.expectRevert(ProvianPoolV3.PolicyNotProspective.selector);
        pool.scheduleMaximumDeadline(0, PROBE_DEADLINE);
    }

    function test_pool_scheduleMaximumDeadline_rejectsReschedulingTakenEpoch() public {
        vm.startPrank(admin);
        pool.scheduleMaximumDeadline(1, PROBE_DEADLINE);
        vm.expectRevert(ProvianPoolV3.PolicyAlreadyScheduled.selector);
        pool.scheduleMaximumDeadline(1, PROBE_DEADLINE + 1 hours);
        vm.stopPrank();
        (, uint256 value) = pool.scheduledMaximumDeadline(1);
        assertEq(value, PROBE_DEADLINE);
    }

    function test_pool_scheduleMaximumDeadline_rejectsBelowFloor() public {
        uint256 belowFloor = pool.MAXIMUM_DEADLINE_MIN() - 1;
        vm.prank(admin);
        vm.expectRevert(ProvianPoolV3.CostOutOfDomain.selector);
        pool.scheduleMaximumDeadline(1, belowFloor);
    }

    function test_pool_scheduleMaximumDeadline_rejectsAboveCeiling() public {
        uint256 aboveCeiling = pool.MAXIMUM_DEADLINE_MAX() + 1;
        vm.prank(admin);
        vm.expectRevert(ProvianPoolV3.CostOutOfDomain.selector);
        pool.scheduleMaximumDeadline(1, aboveCeiling);
    }

    function test_pool_scheduleMaximumDeadline_acceptsFloorAndCeiling() public {
        uint256 floor = pool.MAXIMUM_DEADLINE_MIN();
        uint256 ceiling = pool.MAXIMUM_DEADLINE_MAX();
        vm.startPrank(admin);
        pool.scheduleMaximumDeadline(1, floor);
        pool.scheduleMaximumDeadline(2, ceiling);
        vm.stopPrank();
        (, uint256 v1) = pool.scheduledMaximumDeadline(1);
        (, uint256 v2) = pool.scheduledMaximumDeadline(2);
        assertEq(v1, floor);
        assertEq(v2, ceiling);
    }

    function test_pool_scheduleMaximumDeadline_emitsEvent() public {
        vm.expectEmit(true, false, false, true, address(pool));
        emit ProvianPoolV3.MaximumDeadlineScheduled(1, PROBE_DEADLINE);
        vm.prank(admin);
        pool.scheduleMaximumDeadline(1, PROBE_DEADLINE);
    }

    function test_pool_maximumDeadline_unset_allowsWindowFarAboveCeiling() public {
        _createPoolPVTWithWindow(keccak256("huge-window"), 180 days);
        assertEq(
            uint256(pool.currency(keccak256("huge-window"))),
            uint256(ProvianPoolV3.Currency.PVT),
            "unset deadline bound must not gate any future window"
        );
    }

    function test_pool_maximumDeadline_gatesWindowStrictlyAbove() public {
        _setAndOpenDeadline(PROBE_DEADLINE);
        vm.prank(target);
        vm.expectRevert(ProvianPoolV3.MaximumDeadlineExceeded.selector);
        pool.createPool(
            keccak256("deadline-over"), target, PVT_THRESHOLD, block.timestamp + PROBE_DEADLINE + 1, ProvianPoolV3.Currency.PVT
        );
    }

    function test_pool_maximumDeadline_allowsWindowExactlyAt() public {
        _setAndOpenDeadline(PROBE_DEADLINE);
        _createPoolPVTWithWindow(keccak256("deadline-at"), PROBE_DEADLINE); // strict > -> at-bound allowed
        assertEq(uint256(pool.currency(keccak256("deadline-at"))), uint256(ProvianPoolV3.Currency.PVT));
    }

    /// @dev The deadline bound is currency-agnostic -- a USDC pool whose window exceeds
    ///      the active bound is gated exactly like a PVT one.
    function test_pool_maximumDeadline_gatesUSDCPoolsToo() public {
        _setAndOpenDeadline(PROBE_DEADLINE);
        vm.prank(target);
        vm.expectRevert(ProvianPoolV3.MaximumDeadlineExceeded.selector);
        pool.createPool(
            keccak256("usdc-window-over"), target, 1000e6, block.timestamp + PROBE_DEADLINE + 1, ProvianPoolV3.Currency.USDC
        );
    }

    /// @dev Locks the enforcement placement: the window check sits AFTER the
    ///      future-timestamp check, so `deadline - now` cannot underflow.
    function test_pool_pastDeadline_revertsInvalidDeadlineNotPanic() public {
        vm.prank(target);
        vm.expectRevert(ProvianPoolV3.InvalidDeadline.selector);
        pool.createPool(keccak256("past"), target, PVT_THRESHOLD, block.timestamp, ProvianPoolV3.Currency.PVT);
    }

    // ========================================================================
    // pool.maximum_contributors
    // ========================================================================

    function test_pool_scheduleMaxContributors_revertsForNonAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(ProvianPoolV3.OnlyAdmin.selector);
        pool.scheduleMaxContributors(1, PROBE_CONTRIBUTORS);
    }

    function test_pool_scheduleMaxContributors_rejectsNonProspectiveEpoch() public {
        vm.prank(admin);
        vm.expectRevert(ProvianPoolV3.PolicyNotProspective.selector);
        pool.scheduleMaxContributors(0, PROBE_CONTRIBUTORS);
    }

    function test_pool_scheduleMaxContributors_rejectsReschedulingTakenEpoch() public {
        vm.startPrank(admin);
        pool.scheduleMaxContributors(1, PROBE_CONTRIBUTORS);
        vm.expectRevert(ProvianPoolV3.PolicyAlreadyScheduled.selector);
        pool.scheduleMaxContributors(1, PROBE_CONTRIBUTORS + 1);
        vm.stopPrank();
        (, uint256 value) = pool.scheduledMaxContributors(1);
        assertEq(value, PROBE_CONTRIBUTORS);
    }

    function test_pool_scheduleMaxContributors_rejectsBelowFloor() public {
        uint256 belowFloor = pool.MAX_CONTRIBUTORS_MIN() - 1; // 1
        vm.prank(admin);
        vm.expectRevert(ProvianPoolV3.CostOutOfDomain.selector);
        pool.scheduleMaxContributors(1, belowFloor);
    }

    function test_pool_scheduleMaxContributors_rejectsAboveCeiling() public {
        uint256 aboveCeiling = pool.MAX_CONTRIBUTORS_MAX() + 1; // 201 -- can never exceed the 200 hard cap
        vm.prank(admin);
        vm.expectRevert(ProvianPoolV3.CostOutOfDomain.selector);
        pool.scheduleMaxContributors(1, aboveCeiling);
    }

    function test_pool_scheduleMaxContributors_acceptsFloorAndCeiling() public {
        uint256 floor = pool.MAX_CONTRIBUTORS_MIN();
        uint256 ceiling = pool.MAX_CONTRIBUTORS_MAX();
        vm.startPrank(admin);
        pool.scheduleMaxContributors(1, floor);
        pool.scheduleMaxContributors(2, ceiling);
        vm.stopPrank();
        (, uint256 v1) = pool.scheduledMaxContributors(1);
        (, uint256 v2) = pool.scheduledMaxContributors(2);
        assertEq(v1, floor);
        assertEq(v2, ceiling);
        assertEq(ceiling, pool.MAX_CONTRIBUTORS_PER_POOL(), "the override ceiling equals the hard cap");
    }

    function test_pool_scheduleMaxContributors_emitsEvent() public {
        vm.expectEmit(true, false, false, true, address(pool));
        emit ProvianPoolV3.MaxContributorsScheduled(1, PROBE_CONTRIBUTORS);
        vm.prank(admin);
        pool.scheduleMaxContributors(1, PROBE_CONTRIBUTORS);
    }

    function test_pool_maxContributors_inertUntilEpochOpens_thenActive() public {
        vm.prank(admin);
        pool.scheduleMaxContributors(1, PROBE_CONTRIBUTORS);
        (bool before,) = pool.activeMaxContributors();
        assertFalse(before);
        _toEpoch(1);
        (bool after_, uint256 value) = pool.activeMaxContributors();
        assertTrue(after_);
        assertEq(value, PROBE_CONTRIBUTORS);
    }

    /// @dev Unset -> the MAX_CONTRIBUTORS_PER_POOL (200) hard cap governs (existing
    ///      behaviour, proven by the unchanged ProvianPoolV3 suite's test_contributorCap_PVT).
    function test_pool_maxContributors_unset_usesTheHardCapConstant() public view {
        (bool exists,) = pool.activeMaxContributors();
        assertFalse(exists, "unset -> the 200 hard cap governs");
        assertEq(pool.MAX_CONTRIBUTORS_PER_POOL(), 200);
    }

    /// @dev An activated override TIGHTENS the contributor gate: with a limit of 3, the
    ///      3rd contributor is accepted (length 2 < 3) and the 4th rejected (length 3 == 3).
    function test_pool_maxContributors_openedOverride_tightensTheGate() public {
        // Create a PVT pool with a huge threshold so it stays Open across contributions.
        vm.prank(target);
        pool.createPool(keccak256("cap3"), target, 1_000_000e18, block.timestamp + 30 days, ProvianPoolV3.Currency.PVT);
        _setAndOpenMaxContributors(3);

        _contribute(keccak256("cap3"), address(0xC001), 1e18);
        _contribute(keccak256("cap3"), address(0xC002), 1e18);
        _contribute(keccak256("cap3"), address(0xC003), 1e18); // 3rd accepted (length was 2 < 3)
        assertEq(pool.getContributorCount(keccak256("cap3")), 3);

        // 4th rejected: length 3 == limit 3.
        address c4 = address(0xC004);
        pvt.mint(c4, 1e18);
        vm.startPrank(c4);
        pvt.approve(address(pool), 1e18);
        vm.expectRevert("ProvianPoolV3: contributor cap reached");
        pool.contribute(keccak256("cap3"), 1e18);
        vm.stopPrank();
    }

    // ========================================================================
    // Review hardening -- immutable bounds pinned to the frozen catalog
    // ========================================================================

    function test_pool_immutableBounds_matchTheFrozenCatalogRanges() public view {
        assertEq(pool.FEE_BPS_MAX(), 1000, "execution-fee ceiling = 1000 bps");
        assertEq(pool.THRESHOLD_CAP_MIN(), 1e18, "threshold-cap floor = 1 PVT");
        assertEq(pool.THRESHOLD_CAP_MAX(), 1_000_000e18, "threshold-cap ceiling = 1,000,000 PVT");
        assertEq(pool.MAXIMUM_DEADLINE_MIN(), 3600, "maximum-deadline floor = 1 hour");
        assertEq(pool.MAXIMUM_DEADLINE_MAX(), 15_552_000, "maximum-deadline ceiling = 180 days");
        assertEq(pool.MAX_CONTRIBUTORS_MIN(), 2, "maximum-contributors floor = 2");
        assertEq(pool.MAX_CONTRIBUTORS_MAX(), 200, "maximum-contributors ceiling = 200");
    }
}
