// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ProvianEscrowV4.sol";
import "../src/ProvianPVT9.sol";
import "./MockTokens.sol";
import "./MockEpochClock.sol";
import {MockIssuanceIndex} from "./MockIssuanceIndex.sol";

/**
 * @title ProvianEscrowV4CostMachineryTest
 * @notice institution parameters (session 2) + activation clock -- the Escrow-native cost-parameter machinery:
 * bounded, admin-only (the bootstrap admin EOA on live Base), prospective-epoch
 * schedulers whose values activate lazily when the KERNEL epoch reaches them
 * (activation clock: bound to ProvianPVT9.currentEpoch() via an immutable clock; the
 * local counter and the permissionless openNextEpoch() are gone, so a queued
 * ladder cannot be collapsed in a single block). Every parameter defaults
 * fail-closed to inert, so with nothing scheduled the contract behaves
 * byte-for-byte as pre-institution parameters (proven directly by the unchanged ProvianEscrowV4
 * / ProvianEscrowV4Pass3 suites, and here by the "unset == baseline literal"
 * tests).
 *
 * VALUE-NEUTRAL BY CONSTRUCTION. Every probe rate/duration in this file is an
 * arbitrary, in-range, TEST-ONLY fixture chosen solely to exercise the machinery.
 * NONE is an approval, a recommendation, or a claim about live economics.
 */
contract ProvianEscrowV4CostMachineryTest is Test {
    ProvianEscrowV4 public escrow;
    MockUSDC public usdc;
    MockPVT public pvt;
    MockEpochClock public clock;

    address public admin = address(0xA01);
    address public feeWallet = address(0xFEE);
    address public depositor = address(0xD01);
    address public recipient = address(0xD02);
    address public stranger = address(0xBAD);

    // Kernel-epoch clock fixture. EPOCH_START is a nonzero base; the clock is armed
    // there and setUp warps to it, so the suite begins at kernel epoch 0. `_toEpoch`
    // advances real time so the institution's currentEpoch() reads the target epoch.
    uint256 internal constant EPOCH_START = 1_000_000;
    uint256 internal constant EPOCH_DURATION = 7 days; // matches ProvianPVT9.EPOCH_DURATION

    uint256 internal constant PVT_AMOUNT = 1000e18;

    // TEST-ONLY probe fee: 25 bps. Inside 0–1000, deliberately different from the
    // 50-bps baseline literal. NOT an approval.
    uint256 internal constant PROBE_FEE_BPS = 25;

    // TEST-ONLY probe principal cap: 500 PVT. Inside [1 PVT, 1,000,000 PVT]. NOT an approval.
    uint256 internal constant PROBE_CAP = 500e18;

    // TEST-ONLY probe durations: 7-day period, 30-day deadline. Inside [1h, 90d],
    // deliberately distinct so "tighter bound wins" can tell them apart. NOT approvals.
    uint256 internal constant PROBE_PERIOD = 7 days;
    uint256 internal constant PROBE_DEADLINE = 30 days;

    // TEST-ONLY probe dispute timeout: 60 days. Inside [2 days, 180 days], different
    // from the 30-day baseline constant. NOT an approval.
    uint256 internal constant PROBE_TIMEOUT = 60 days;

    function setUp() public {
        usdc = new MockUSDC();
        pvt = new MockPVT();
        clock = new MockEpochClock(uint64(EPOCH_START));
        vm.warp(EPOCH_START); // kernel epoch 0
        escrow = new ProvianEscrowV4(admin, feeWallet, address(usdc), address(pvt), address(clock), address(new MockIssuanceIndex()), new ProvianEscrowV4.EscrowSeed[](0));

        pvt.mint(depositor, 1_000_000e18);
        vm.prank(depositor);
        pvt.approve(address(escrow), type(uint256).max);
    }

    /// @dev Advance real time so the kernel clock (and thus the institution) reads
    ///      epoch `n`. The ONLY way to activate a scheduled override -- there is no
    ///      permissionless epoch-advance to collapse a ladder.
    function _toEpoch(uint64 n) internal {
        vm.warp(EPOCH_START + uint256(n) * EPOCH_DURATION);
    }

    /// @dev Create + fund a PVT-principal escrow and return the fee PVT burned at funding.
    function _createAndFundPVT(bytes32 id, uint256 amount) internal returns (uint256 feeBurned) {
        uint256 burnedBefore = pvt.totalBurned();
        vm.startPrank(depositor);
        escrow.createEscrow(id, recipient, amount, block.timestamp + 1 days, ProvianEscrowV4.Currency.PVT);
        escrow.fundEscrow(id, false);
        vm.stopPrank();
        return pvt.totalBurned() - burnedBefore;
    }

    /// @dev Create (only) a PVT-principal escrow -- the principal cap is enforced at creation.
    function _createPVT(bytes32 id, uint256 amount) internal {
        vm.prank(depositor);
        escrow.createEscrow(id, recipient, amount, block.timestamp + 1 days, ProvianEscrowV4.Currency.PVT);
    }

    /// @dev Schedule a principal cap for epoch 1 (prospective at epoch 0) and advance to it.
    function _setAndOpenCap(uint256 cap) internal {
        vm.prank(admin);
        escrow.schedulePrincipalCap(1, cap);
        _toEpoch(1);
    }

    /// @dev Create (only) a PVT escrow whose auto-release window is `window` seconds from now.
    function _createPVTWithWindow(bytes32 id, uint256 window) internal {
        vm.prank(depositor);
        escrow.createEscrow(id, recipient, PVT_AMOUNT, block.timestamp + window, ProvianEscrowV4.Currency.PVT);
    }

    function _setAndOpenPeriod(uint256 period) internal {
        vm.prank(admin);
        escrow.scheduleAutoReleasePeriod(1, period);
        _toEpoch(1);
    }

    function _setAndOpenDeadline(uint256 deadline) internal {
        vm.prank(admin);
        escrow.scheduleAgreementDeadline(1, deadline);
        _toEpoch(1);
    }

    /// @dev Schedule BOTH duration bounds for epoch 1 and advance to it.
    function _setAndOpenBothDurations(uint256 period, uint256 deadline) internal {
        vm.startPrank(admin);
        escrow.scheduleAutoReleasePeriod(1, period);
        escrow.scheduleAgreementDeadline(1, deadline);
        vm.stopPrank();
        _toEpoch(1);
    }

    /// @dev Create + fund + dispute a PVT escrow (far-future autoReleaseAt so the
    ///      dispute is allowed), and return the armed `disputeDeadline`.
    function _createFundDisputePVT(bytes32 id) internal returns (uint256 armedDeadline) {
        vm.startPrank(depositor);
        escrow.createEscrow(id, recipient, PVT_AMOUNT, block.timestamp + 180 days, ProvianEscrowV4.Currency.PVT);
        escrow.fundEscrow(id, false);
        escrow.disputeEscrow(id);
        vm.stopPrank();
        return escrow.disputeDeadline(id);
    }

    function _setAndOpenDisputeTimeout(uint256 timeoutSeconds) internal {
        vm.prank(admin);
        escrow.scheduleDisputeTimeout(1, timeoutSeconds);
        _toEpoch(1);
    }

    // ========================================================================
    // Epoch machinery (kernel-clock-bound; activation clock)
    // ========================================================================

    function test_escrow_epoch_startsAtZero_firstSchedulableIsOne() public view {
        assertEq(escrow.earliestSchedulableEpoch(), 1, "first schedulable epoch is 1 at epoch 0");
    }

    /// @dev activation clock: advancing the kernel clock (real time) is the ONLY way to move the
    ///      current epoch -- there is no local counter and no openNextEpoch.
    function test_escrow_clockAdvance_movesSchedulableEpoch() public {
        _toEpoch(1);
        assertEq(escrow.earliestSchedulableEpoch(), 2, "at epoch 1, earliest schedulable is 2");
        _toEpoch(2);
        assertEq(escrow.earliestSchedulableEpoch(), 3, "at epoch 2, earliest schedulable is 3");
    }

    /// @dev activation clock: the permissionless untimed openNextEpoch() (and the lastOpenedEpoch
    ///      counter) are GONE. Their old selectors must not resolve to any function.
    function test_escrow_noPermissionlessOpenNextEpoch() public {
        (bool ok,) = address(escrow).call(abi.encodeWithSignature("openNextEpoch()"));
        assertFalse(ok, "openNextEpoch() must no longer exist");
        (bool ok2,) = address(escrow).call(abi.encodeWithSignature("lastOpenedEpoch()"));
        assertFalse(ok2, "lastOpenedEpoch storage/getter must no longer exist");
    }

    /// @dev activation clock non-collapsibility: a queued ladder (epochs 1/2/3) activates exactly
    ///      one rung per kernel epoch and CANNOT be collapsed in a single block.
    function test_escrow_ladder_nonCollapsibleInSingleBlock() public {
        uint256 v1 = 10;
        uint256 v2 = 20;
        uint256 v3 = 30;
        vm.startPrank(admin);
        escrow.scheduleFeeBps(1, v1);
        escrow.scheduleFeeBps(2, v2);
        escrow.scheduleFeeBps(3, v3);
        vm.stopPrank();

        (bool e0,) = escrow.activeFeeBps();
        assertFalse(e0, "no rung is active at epoch 0");

        _toEpoch(1);
        (bool e1, uint256 a1) = escrow.activeFeeBps();
        assertTrue(e1, "rung 1 active at epoch 1");
        assertEq(a1, v1, "epoch 1 resolves to rung 1, not a collapsed rung 3");
        (, uint256 a1again) = escrow.activeFeeBps();
        assertEq(a1again, v1, "within one block the rung is fixed -- repeated reads do not advance it");
        (bool ok,) = address(escrow).call(abi.encodeWithSignature("openNextEpoch()"));
        assertFalse(ok, "no call can advance the epoch inside a block");
        (, uint256 a1still) = escrow.activeFeeBps();
        assertEq(a1still, v1, "the ladder cannot be collapsed to rung 3 in a single block");

        _toEpoch(2);
        (, uint256 a2) = escrow.activeFeeBps();
        assertEq(a2, v2, "epoch 2 resolves to rung 2");
        _toEpoch(3);
        (, uint256 a3) = escrow.activeFeeBps();
        assertEq(a3, v3, "epoch 3 resolves to rung 3");
    }

    /// @dev Forward-fill: a value persists across epochs with no schedule of their own,
    ///      until a later scheduled epoch replaces it.
    function test_escrow_forwardFill_valuePersistsUntilNextSchedule() public {
        vm.startPrank(admin);
        escrow.scheduleFeeBps(1, 10);
        escrow.scheduleFeeBps(3, 30); // epoch 2 deliberately skipped
        vm.stopPrank();

        _toEpoch(1);
        (, uint256 a1) = escrow.activeFeeBps();
        assertEq(a1, 10, "rung 1 active at epoch 1");
        _toEpoch(2);
        (, uint256 a2) = escrow.activeFeeBps();
        assertEq(a2, 10, "epoch 2 (unscheduled) carries rung 1 forward");
        _toEpoch(3);
        (, uint256 a3) = escrow.activeFeeBps();
        assertEq(a3, 30, "rung 3 replaces it at epoch 3");
    }

    /// @dev Out-of-order scheduling resolves by epoch, not by insertion order.
    function test_escrow_outOfOrderSchedule_resolvesByEpoch() public {
        vm.startPrank(admin);
        escrow.scheduleFeeBps(3, 30); // farther epoch scheduled first
        escrow.scheduleFeeBps(1, 10); // nearer epoch scheduled second
        vm.stopPrank();

        _toEpoch(1);
        (, uint256 a1) = escrow.activeFeeBps();
        assertEq(a1, 10, "epoch 1 resolves to its own value despite being scheduled second");
        _toEpoch(3);
        (, uint256 a3) = escrow.activeFeeBps();
        assertEq(a3, 30, "epoch 3 resolves to its value");
    }

    /// @dev Fail-closed on an unarmed kernel: if the clock reverts, currentEpoch() is
    ///      treated as 0, every override is inert, and the historical literal stands --
    ///      createEscrow must NOT brick.
    function test_escrow_unarmedKernel_failsClosedToBaseline() public {
        vm.prank(admin);
        escrow.scheduleFeeBps(1, PROBE_FEE_BPS);
        clock.disarm();

        (bool active,) = escrow.activeFeeBps();
        assertFalse(active, "an unarmed clock resolves to epoch 0 -> no override active");

        uint256 feeBurned = _createAndFundPVT(keccak256("unarmed"), PVT_AMOUNT);
        assertEq(feeBurned, (PVT_AMOUNT * 5) / 1000, "unarmed kernel must fall back to the 50-bps baseline, not brick");
    }

    /// @dev activation clock real-kernel binding: an Escrow bound to a real (unarmed) ProvianPVT9
    ///      reads its ACTUAL currentEpoch(), which reverts EpochZeroNotArmed. The
    ///      institution's fail-closed try/catch treats that as epoch 0, so createEscrow
    ///      still succeeds at the baseline fee. Proves the binding is to the real
    ///      kernel's real reverting API (IEpochClock == ProvianPVT9.currentEpoch()),
    ///      not just to the mock.
    function test_escrow_realKernelBinding_unarmedFailsClosed() public {
        ProvianPVT9 realKernel = new ProvianPVT9();
        ProvianEscrowV4 boundEscrow =
            new ProvianEscrowV4(admin, feeWallet, address(usdc), address(pvt), address(realKernel), address(realKernel), new ProvianEscrowV4.EscrowSeed[](0));

        // Sanity: the real kernel really does revert when unarmed.
        vm.expectRevert(ProvianPVT9.EpochZeroNotArmed.selector);
        realKernel.currentEpoch();

        // The institution catches that revert and resolves epoch 0.
        assertEq(boundEscrow.earliestSchedulableEpoch(), 1, "unarmed real kernel resolves to epoch 0 (earliest schedulable 1)");

        // createEscrow + fund must succeed at the 50-bps baseline (no brick on the real revert).
        uint256 burnedBefore = pvt.totalBurned();
        vm.startPrank(depositor);
        pvt.approve(address(boundEscrow), type(uint256).max);
        boundEscrow.createEscrow(keccak256("rk"), recipient, PVT_AMOUNT, block.timestamp + 1 days, ProvianEscrowV4.Currency.PVT);
        boundEscrow.fundEscrow(keccak256("rk"), false);
        vm.stopPrank();
        assertEq(
            pvt.totalBurned() - burnedBefore, (PVT_AMOUNT * 5) / 1000, "unarmed real kernel must fall back to the baseline fee"
        );
    }

    // ========================================================================
    // scheduleFeeBps -- authority
    // ========================================================================

    function test_escrow_scheduleFeeBps_revertsForNonAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(ProvianEscrowV4.OnlyAdmin.selector);
        escrow.scheduleFeeBps(1, PROBE_FEE_BPS);

        (bool exists,) = escrow.scheduledFeeBps(1);
        assertFalse(exists, "a rejected schedule must leave no state");
    }

    // ========================================================================
    // scheduleFeeBps -- prospectivity (rejects non-prospective epochs)
    // ========================================================================

    function test_escrow_scheduleFeeBps_rejectsCurrentEpoch() public {
        vm.prank(admin);
        vm.expectRevert(ProvianEscrowV4.PolicyNotProspective.selector);
        escrow.scheduleFeeBps(0, PROBE_FEE_BPS);
    }

    function test_escrow_scheduleFeeBps_rejectsAlreadyOpenedEpoch() public {
        _toEpoch(1); // kernel now at epoch 1
        vm.prank(admin);
        vm.expectRevert(ProvianEscrowV4.PolicyNotProspective.selector);
        escrow.scheduleFeeBps(1, PROBE_FEE_BPS);
    }

    // ========================================================================
    // scheduleFeeBps -- one value per epoch (rejects re-scheduling a taken epoch)
    // ========================================================================

    function test_escrow_scheduleFeeBps_rejectsReschedulingTakenEpoch() public {
        vm.startPrank(admin);
        escrow.scheduleFeeBps(1, PROBE_FEE_BPS);
        vm.expectRevert(ProvianEscrowV4.PolicyAlreadyScheduled.selector);
        escrow.scheduleFeeBps(1, PROBE_FEE_BPS + 1);
        vm.stopPrank();

        (bool exists, uint256 value) = escrow.scheduledFeeBps(1);
        assertTrue(exists, "the original schedule stands");
        assertEq(value, PROBE_FEE_BPS, "a taken epoch's value cannot be overwritten");
    }

    // ========================================================================
    // scheduleFeeBps -- immutable bounds
    // ========================================================================

    function test_escrow_scheduleFeeBps_rejectsAboveMax() public {
        uint256 overMax = escrow.FEE_BPS_MAX() + 1;
        vm.prank(admin);
        vm.expectRevert(ProvianEscrowV4.CostOutOfDomain.selector);
        escrow.scheduleFeeBps(1, overMax);
    }

    function test_escrow_scheduleFeeBps_acceptsCeilingAndZeroFloor() public {
        uint256 ceiling = escrow.FEE_BPS_MAX();
        vm.startPrank(admin);
        escrow.scheduleFeeBps(1, ceiling); // exactly the ceiling is in-band
        escrow.scheduleFeeBps(2, 0); // a zero fee is inside the 0-floor band
        vm.stopPrank();

        (, uint256 v1) = escrow.scheduledFeeBps(1);
        (, uint256 v2) = escrow.scheduledFeeBps(2);
        assertEq(v1, ceiling, "ceiling value stored");
        assertEq(v2, 0, "zero value stored (0 is a legal fee, not 'unset')");
    }

    // ========================================================================
    // scheduleFeeBps -- event
    // ========================================================================

    function test_escrow_scheduleFeeBps_emitsEvent() public {
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ProvianEscrowV4.FeeBpsScheduled(3, PROBE_FEE_BPS);
        vm.prank(admin);
        escrow.scheduleFeeBps(3, PROBE_FEE_BPS);
    }

    // ========================================================================
    // Activation only when the scheduled epoch is reached (lazily)
    // ========================================================================

    function test_escrow_feeBps_scheduledButInertUntilEpochOpens() public {
        vm.prank(admin);
        escrow.scheduleFeeBps(1, PROBE_FEE_BPS);

        (bool active,) = escrow.activeFeeBps();
        assertFalse(active, "a scheduled override is inert until the kernel reaches its epoch");
    }

    function test_escrow_feeBps_activatesExactlyWhenItsEpochOpens() public {
        vm.prank(admin);
        escrow.scheduleFeeBps(1, PROBE_FEE_BPS);
        _toEpoch(1);

        (bool active, uint256 value) = escrow.activeFeeBps();
        assertTrue(active, "override becomes active when the kernel reaches its epoch");
        assertEq(value, PROBE_FEE_BPS, "the active value is exactly what was scheduled");
    }

    /// @dev Reaching an epoch that had NOTHING scheduled must leave every parameter
    ///      inert ("unset stays unset"). Without the resolver's "found" guard an empty
    ///      epoch could read as {exists:true, value:0} and silently zero every fee.
    function test_escrow_openingUnscheduledEpoch_leavesEverythingInert() public {
        _toEpoch(1); // kernel reaches epoch 1 with no schedule for any parameter

        (bool feeActive, uint256 feeValue) = escrow.activeFeeBps();
        assertFalse(feeActive, "an unscheduled epoch must not activate the fee override");
        assertEq(feeValue, 0, "no fee override value may be read from an empty epoch");

        (bool capActive, uint256 capValue) = escrow.activePrincipalCap();
        assertFalse(capActive, "an unscheduled epoch must not activate the principal cap");
        assertEq(capValue, 0, "no cap value may be read from an empty epoch");

        (bool periodActive, uint256 periodValue) = escrow.activeAutoReleasePeriod();
        assertFalse(periodActive, "an unscheduled epoch must not activate the auto-release period");
        assertEq(periodValue, 0, "no period value may be read from an empty epoch");

        (bool deadlineActive, uint256 deadlineValue) = escrow.activeAgreementDeadline();
        assertFalse(deadlineActive, "an unscheduled epoch must not activate the agreement deadline");
        assertEq(deadlineValue, 0, "no deadline value may be read from an empty epoch");

        (bool timeoutActive, uint256 timeoutValue) = escrow.activeDisputeTimeout();
        assertFalse(timeoutActive, "an unscheduled epoch must not activate the dispute timeout");
        assertEq(timeoutValue, 0, "no dispute-timeout value may be read from an empty epoch");

        // A PVT escrow created+funded at the empty epoch must succeed (gates inert)
        // and burn the 50-bps baseline fee.
        uint256 feeBurned = _createAndFundPVT(keccak256("carry-forward"), PVT_AMOUNT);
        assertEq(feeBurned, (PVT_AMOUNT * 5) / 1000, "an unscheduled epoch must leave the baseline fee intact");
    }

    // ========================================================================
    // Fail-closed: unset == byte-for-byte baseline
    // ========================================================================

    function test_escrow_fee_unset_chargesTheBaseline50bpsLiteral() public {
        uint256 feeBurned = _createAndFundPVT(keccak256("unset-fee"), PVT_AMOUNT);
        assertEq(feeBurned, (PVT_AMOUNT * 5) / 1000, "unset fee must equal the 50-bps baseline literal");
    }

    function test_escrow_fee_unset_nonRoundAmount_exactBaselineRounding() public {
        // `(amount * 5) / 1000` truncates AFTER the multiply. For amount = 12_345:
        // (12345*5)/1000 = 61, but (12345/1000)*5 = 60 -- this test kills that refactor.
        uint256 amount = 12_345;
        uint256 feeBurned = _createAndFundPVT(keccak256("unset-fee-nonround"), amount);
        assertEq(feeBurned, (amount * 5) / 1000, "non-round unset fee must match the exact multiply-then-divide literal");
        assertEq(feeBurned, 61, "explicit: (12345*5)/1000 == 61, not 60");
    }

    // ========================================================================
    // End-to-end: an activated override actually drives the charged fee
    // ========================================================================

    function test_escrow_fee_openedOverride_drivesTheChargedFee() public {
        vm.prank(admin);
        escrow.scheduleFeeBps(1, PROBE_FEE_BPS);
        _toEpoch(1);

        uint256 feeBurned = _createAndFundPVT(keccak256("override-fee"), PVT_AMOUNT);
        assertEq(
            feeBurned, (PVT_AMOUNT * PROBE_FEE_BPS) / 10_000, "an activated override must be the fee that is charged/burned"
        );
        assertTrue(feeBurned != (PVT_AMOUNT * 5) / 1000, "probe fee must differ from the baseline literal");
    }

    // ========================================================================
    // escrow.pvt_principal_cap -- schedule / bounds / apply / enforcement
    // ========================================================================

    function test_escrow_schedulePrincipalCap_revertsForNonAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(ProvianEscrowV4.OnlyAdmin.selector);
        escrow.schedulePrincipalCap(1, PROBE_CAP);
    }

    function test_escrow_schedulePrincipalCap_rejectsNonProspectiveEpoch() public {
        vm.prank(admin);
        vm.expectRevert(ProvianEscrowV4.PolicyNotProspective.selector);
        escrow.schedulePrincipalCap(0, PROBE_CAP);
    }

    function test_escrow_schedulePrincipalCap_rejectsReschedulingTakenEpoch() public {
        vm.startPrank(admin);
        escrow.schedulePrincipalCap(1, PROBE_CAP);
        vm.expectRevert(ProvianEscrowV4.PolicyAlreadyScheduled.selector);
        escrow.schedulePrincipalCap(1, PROBE_CAP + 1e18);
        vm.stopPrank();

        (, uint256 value) = escrow.scheduledPrincipalCap(1);
        assertEq(value, PROBE_CAP, "a taken epoch's cap cannot be overwritten");
    }

    function test_escrow_schedulePrincipalCap_rejectsBelowFloor() public {
        uint256 belowFloor = escrow.PRINCIPAL_CAP_MIN() - 1;
        vm.prank(admin);
        vm.expectRevert(ProvianEscrowV4.CostOutOfDomain.selector);
        escrow.schedulePrincipalCap(1, belowFloor);
    }

    function test_escrow_schedulePrincipalCap_rejectsAboveCeiling() public {
        uint256 aboveCeiling = escrow.PRINCIPAL_CAP_MAX() + 1;
        vm.prank(admin);
        vm.expectRevert(ProvianEscrowV4.CostOutOfDomain.selector);
        escrow.schedulePrincipalCap(1, aboveCeiling);
    }

    function test_escrow_schedulePrincipalCap_acceptsFloorAndCeiling() public {
        uint256 floor = escrow.PRINCIPAL_CAP_MIN();
        uint256 ceiling = escrow.PRINCIPAL_CAP_MAX();
        vm.startPrank(admin);
        escrow.schedulePrincipalCap(1, floor); // exactly the floor is in-band
        escrow.schedulePrincipalCap(2, ceiling); // exactly the ceiling is in-band
        vm.stopPrank();

        (, uint256 v1) = escrow.scheduledPrincipalCap(1);
        (, uint256 v2) = escrow.scheduledPrincipalCap(2);
        assertEq(v1, floor, "floor value stored");
        assertEq(v2, ceiling, "ceiling value stored");
    }

    function test_escrow_schedulePrincipalCap_emitsEvent() public {
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ProvianEscrowV4.PrincipalCapScheduled(1, PROBE_CAP);
        vm.prank(admin);
        escrow.schedulePrincipalCap(1, PROBE_CAP);
    }

    function test_escrow_principalCap_inertUntilEpochOpens_thenActive() public {
        vm.prank(admin);
        escrow.schedulePrincipalCap(1, PROBE_CAP);

        (bool activeBefore,) = escrow.activePrincipalCap();
        assertFalse(activeBefore, "cap inert until the kernel reaches its epoch");

        _toEpoch(1);
        (bool activeAfter, uint256 value) = escrow.activePrincipalCap();
        assertTrue(activeAfter, "cap active once the kernel reaches its epoch");
        assertEq(value, PROBE_CAP, "active cap is exactly what was scheduled");
    }

    // --- fail-closed: unset cap does not gate (byte-for-byte baseline) ---

    function test_escrow_principalCap_unset_allowsAmountFarAboveAnyCap() public {
        _createPVT(keccak256("huge-uncapped"), 900_000e18);
        assertEq(
            uint256(escrow.currency(keccak256("huge-uncapped"))),
            uint256(ProvianEscrowV4.Currency.PVT),
            "unset cap must not gate any PVT amount"
        );
    }

    // --- gate PVT strictly above the cap; allow at/below; USDC exempt ---

    function test_escrow_principalCap_gatesPVTStrictlyAboveCap() public {
        _setAndOpenCap(PROBE_CAP);
        vm.prank(depositor);
        vm.expectRevert(ProvianEscrowV4.PrincipalCapExceeded.selector);
        escrow.createEscrow(
            keccak256("over"), recipient, PROBE_CAP + 1, block.timestamp + 1 days, ProvianEscrowV4.Currency.PVT
        );
    }

    function test_escrow_principalCap_allowsPVTExactlyAtCap() public {
        _setAndOpenCap(PROBE_CAP);
        _createPVT(keccak256("at-cap"), PROBE_CAP);
        assertEq(
            uint256(escrow.currency(keccak256("at-cap"))),
            uint256(ProvianEscrowV4.Currency.PVT),
            "amount exactly at the cap must be accepted"
        );
    }

    function test_escrow_principalCap_doesNotGateUSDCEscrows() public {
        _setAndOpenCap(PROBE_CAP);
        vm.prank(depositor);
        escrow.createEscrow(
            keccak256("usdc-exempt"),
            recipient,
            PROBE_CAP + 1e18,
            block.timestamp + 1 days,
            ProvianEscrowV4.Currency.USDC
        );
        assertEq(
            uint256(escrow.currency(keccak256("usdc-exempt"))),
            uint256(ProvianEscrowV4.Currency.USDC),
            "USDC escrow must be created despite exceeding the PVT cap value"
        );
    }

    // ========================================================================
    // escrow.maximum_auto_release_period -- schedule / bounds / apply / enforce
    // ========================================================================

    function test_escrow_scheduleAutoReleasePeriod_revertsForNonAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(ProvianEscrowV4.OnlyAdmin.selector);
        escrow.scheduleAutoReleasePeriod(1, PROBE_PERIOD);
    }

    function test_escrow_scheduleAutoReleasePeriod_rejectsNonProspectiveEpoch() public {
        vm.prank(admin);
        vm.expectRevert(ProvianEscrowV4.PolicyNotProspective.selector);
        escrow.scheduleAutoReleasePeriod(0, PROBE_PERIOD);
    }

    function test_escrow_scheduleAutoReleasePeriod_rejectsReschedulingTakenEpoch() public {
        vm.startPrank(admin);
        escrow.scheduleAutoReleasePeriod(1, PROBE_PERIOD);
        vm.expectRevert(ProvianEscrowV4.PolicyAlreadyScheduled.selector);
        escrow.scheduleAutoReleasePeriod(1, PROBE_PERIOD + 1 hours);
        vm.stopPrank();
        (, uint256 value) = escrow.scheduledAutoReleasePeriod(1);
        assertEq(value, PROBE_PERIOD, "a taken epoch's period cannot be overwritten");
    }

    function test_escrow_scheduleAutoReleasePeriod_rejectsBelowFloor() public {
        uint256 belowFloor = escrow.AUTO_RELEASE_PERIOD_MIN() - 1;
        vm.prank(admin);
        vm.expectRevert(ProvianEscrowV4.CostOutOfDomain.selector);
        escrow.scheduleAutoReleasePeriod(1, belowFloor);
    }

    function test_escrow_scheduleAutoReleasePeriod_rejectsAboveCeiling() public {
        uint256 aboveCeiling = escrow.AUTO_RELEASE_PERIOD_MAX() + 1;
        vm.prank(admin);
        vm.expectRevert(ProvianEscrowV4.CostOutOfDomain.selector);
        escrow.scheduleAutoReleasePeriod(1, aboveCeiling);
    }

    function test_escrow_scheduleAutoReleasePeriod_acceptsFloorAndCeiling() public {
        uint256 floor = escrow.AUTO_RELEASE_PERIOD_MIN();
        uint256 ceiling = escrow.AUTO_RELEASE_PERIOD_MAX();
        vm.startPrank(admin);
        escrow.scheduleAutoReleasePeriod(1, floor);
        escrow.scheduleAutoReleasePeriod(2, ceiling);
        vm.stopPrank();
        (, uint256 v1) = escrow.scheduledAutoReleasePeriod(1);
        (, uint256 v2) = escrow.scheduledAutoReleasePeriod(2);
        assertEq(v1, floor, "floor value stored");
        assertEq(v2, ceiling, "ceiling value stored");
    }

    function test_escrow_scheduleAutoReleasePeriod_emitsEvent() public {
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ProvianEscrowV4.AutoReleasePeriodScheduled(1, PROBE_PERIOD);
        vm.prank(admin);
        escrow.scheduleAutoReleasePeriod(1, PROBE_PERIOD);
    }

    function test_escrow_autoReleasePeriod_inertUntilOpen_thenActive() public {
        vm.prank(admin);
        escrow.scheduleAutoReleasePeriod(1, PROBE_PERIOD);
        (bool activeBefore,) = escrow.activeAutoReleasePeriod();
        assertFalse(activeBefore, "period inert until the kernel reaches its epoch");
        _toEpoch(1);
        (bool activeAfter, uint256 value) = escrow.activeAutoReleasePeriod();
        assertTrue(activeAfter, "period active once the kernel reaches its epoch");
        assertEq(value, PROBE_PERIOD);
    }

    function test_escrow_autoReleasePeriod_gatesWindowStrictlyAbove() public {
        _setAndOpenPeriod(PROBE_PERIOD); // deadline stays unset -- isolates the period gate
        vm.prank(depositor);
        vm.expectRevert(ProvianEscrowV4.AutoReleasePeriodExceeded.selector);
        escrow.createEscrow(
            keccak256("period-over"),
            recipient,
            PVT_AMOUNT,
            block.timestamp + PROBE_PERIOD + 1,
            ProvianEscrowV4.Currency.PVT
        );
    }

    function test_escrow_autoReleasePeriod_allowsWindowExactlyAt() public {
        _setAndOpenPeriod(PROBE_PERIOD);
        _createPVTWithWindow(keccak256("period-at"), PROBE_PERIOD); // strict > -> at-bound allowed
        assertEq(uint256(escrow.currency(keccak256("period-at"))), uint256(ProvianEscrowV4.Currency.PVT));
    }

    // ========================================================================
    // escrow.maximum_agreement_deadline -- schedule / bounds / apply / enforce
    // ========================================================================

    function test_escrow_scheduleAgreementDeadline_revertsForNonAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(ProvianEscrowV4.OnlyAdmin.selector);
        escrow.scheduleAgreementDeadline(1, PROBE_DEADLINE);
    }

    function test_escrow_scheduleAgreementDeadline_rejectsNonProspectiveEpoch() public {
        vm.prank(admin);
        vm.expectRevert(ProvianEscrowV4.PolicyNotProspective.selector);
        escrow.scheduleAgreementDeadline(0, PROBE_DEADLINE);
    }

    function test_escrow_scheduleAgreementDeadline_rejectsReschedulingTakenEpoch() public {
        vm.startPrank(admin);
        escrow.scheduleAgreementDeadline(1, PROBE_DEADLINE);
        vm.expectRevert(ProvianEscrowV4.PolicyAlreadyScheduled.selector);
        escrow.scheduleAgreementDeadline(1, PROBE_DEADLINE + 1 hours);
        vm.stopPrank();
        (, uint256 value) = escrow.scheduledAgreementDeadline(1);
        assertEq(value, PROBE_DEADLINE, "a taken epoch's deadline cannot be overwritten");
    }

    function test_escrow_scheduleAgreementDeadline_rejectsBelowFloor() public {
        uint256 belowFloor = escrow.AGREEMENT_DEADLINE_MIN() - 1;
        vm.prank(admin);
        vm.expectRevert(ProvianEscrowV4.CostOutOfDomain.selector);
        escrow.scheduleAgreementDeadline(1, belowFloor);
    }

    function test_escrow_scheduleAgreementDeadline_rejectsAboveCeiling() public {
        uint256 aboveCeiling = escrow.AGREEMENT_DEADLINE_MAX() + 1;
        vm.prank(admin);
        vm.expectRevert(ProvianEscrowV4.CostOutOfDomain.selector);
        escrow.scheduleAgreementDeadline(1, aboveCeiling);
    }

    function test_escrow_scheduleAgreementDeadline_acceptsFloorAndCeiling() public {
        uint256 floor = escrow.AGREEMENT_DEADLINE_MIN();
        uint256 ceiling = escrow.AGREEMENT_DEADLINE_MAX();
        vm.startPrank(admin);
        escrow.scheduleAgreementDeadline(1, floor);
        escrow.scheduleAgreementDeadline(2, ceiling);
        vm.stopPrank();
        (, uint256 v1) = escrow.scheduledAgreementDeadline(1);
        (, uint256 v2) = escrow.scheduledAgreementDeadline(2);
        assertEq(v1, floor, "floor value stored");
        assertEq(v2, ceiling, "ceiling value stored");
    }

    function test_escrow_scheduleAgreementDeadline_emitsEvent() public {
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ProvianEscrowV4.AgreementDeadlineScheduled(1, PROBE_DEADLINE);
        vm.prank(admin);
        escrow.scheduleAgreementDeadline(1, PROBE_DEADLINE);
    }

    function test_escrow_agreementDeadline_inertUntilOpen_thenActive() public {
        vm.prank(admin);
        escrow.scheduleAgreementDeadline(1, PROBE_DEADLINE);
        (bool activeBefore,) = escrow.activeAgreementDeadline();
        assertFalse(activeBefore, "deadline inert until the kernel reaches its epoch");
        _toEpoch(1);
        (bool activeAfter, uint256 value) = escrow.activeAgreementDeadline();
        assertTrue(activeAfter, "deadline active once the kernel reaches its epoch");
        assertEq(value, PROBE_DEADLINE);
    }

    function test_escrow_agreementDeadline_gatesWindowStrictlyAbove() public {
        _setAndOpenDeadline(PROBE_DEADLINE); // period stays unset -- isolates the deadline gate
        vm.prank(depositor);
        vm.expectRevert(ProvianEscrowV4.AgreementDeadlineExceeded.selector);
        escrow.createEscrow(
            keccak256("deadline-over"),
            recipient,
            PVT_AMOUNT,
            block.timestamp + PROBE_DEADLINE + 1,
            ProvianEscrowV4.Currency.PVT
        );
    }

    function test_escrow_agreementDeadline_allowsWindowExactlyAt() public {
        _setAndOpenDeadline(PROBE_DEADLINE);
        _createPVTWithWindow(keccak256("deadline-at"), PROBE_DEADLINE);
        assertEq(uint256(escrow.currency(keccak256("deadline-at"))), uint256(ProvianEscrowV4.Currency.PVT));
    }

    // ========================================================================
    // Duration bounds: unset -> unbounded (baseline); both set -> tighter wins
    // ========================================================================

    function test_escrow_durations_unset_allowWindowFarAboveCeiling() public {
        _createPVTWithWindow(keccak256("huge-window"), 180 days);
        assertEq(
            uint256(escrow.currency(keccak256("huge-window"))),
            uint256(ProvianEscrowV4.Currency.PVT),
            "unset duration bounds must not gate any future window"
        );
    }

    function test_escrow_bothDurationCaps_tighterBoundWins() public {
        // Period 30d (loose), deadline 7d (tight). A 20-day window is inside the
        // period but exceeds the deadline -> the tighter deadline bound rejects it.
        _setAndOpenBothDurations(30 days, 7 days);
        vm.prank(depositor);
        vm.expectRevert(ProvianEscrowV4.AgreementDeadlineExceeded.selector);
        escrow.createEscrow(
            keccak256("tighter-wins"), recipient, PVT_AMOUNT, block.timestamp + 20 days, ProvianEscrowV4.Currency.PVT
        );
    }

    // ========================================================================
    // Review hardening -- bounds-vs-catalog pin, enforcement placement, currency
    // ========================================================================

    /// @dev Pin every immutable bound to the frozen cost catalog's declared range as a
    ///      raw integer, NOT via arithmetic (which would move with a typo).
    function test_escrow_immutableBounds_matchTheFrozenCatalogRanges() public view {
        assertEq(escrow.FEE_BPS_MAX(), 1000, "fee ceiling = 1000 bps");
        assertEq(escrow.PRINCIPAL_CAP_MIN(), 1e18, "cap floor = 1 PVT");
        assertEq(escrow.PRINCIPAL_CAP_MAX(), 1_000_000e18, "cap ceiling = 1,000,000 PVT");
        assertEq(escrow.AUTO_RELEASE_PERIOD_MIN(), 3600, "auto-release floor = 1 hour");
        assertEq(escrow.AUTO_RELEASE_PERIOD_MAX(), 7_776_000, "auto-release ceiling = 90 days");
        assertEq(escrow.AGREEMENT_DEADLINE_MIN(), 3600, "deadline floor = 1 hour");
        assertEq(escrow.AGREEMENT_DEADLINE_MAX(), 7_776_000, "deadline ceiling = 90 days");
        assertEq(escrow.DISPUTE_TIMEOUT_MIN(), 172_800, "dispute-timeout floor = 2 days");
        assertEq(escrow.DISPUTE_TIMEOUT_MAX(), 15_552_000, "dispute-timeout ceiling = 180 days");
    }

    /// @dev Locks the enforcement placement: the duration checks sit AFTER the
    ///      future-timestamp check, so `releaseWindow = autoReleaseAt - now` cannot
    ///      underflow. A past `autoReleaseAt` must revert `InvalidDeadline`, never a panic.
    function test_escrow_pastAutoReleaseAt_revertsInvalidDeadlineNotPanic() public {
        vm.prank(depositor);
        vm.expectRevert(ProvianEscrowV4.InvalidDeadline.selector);
        escrow.createEscrow(
            keccak256("past"), recipient, PVT_AMOUNT, block.timestamp - 1, ProvianEscrowV4.Currency.PVT
        );
    }

    /// @dev The duration bounds are currency-agnostic -- a USDC escrow whose window
    ///      exceeds the active period is gated exactly like a PVT one.
    function test_escrow_durationBounds_gateUSDCEscrowsToo() public {
        _setAndOpenPeriod(PROBE_PERIOD); // deadline unset
        vm.prank(depositor);
        vm.expectRevert(ProvianEscrowV4.AutoReleasePeriodExceeded.selector);
        escrow.createEscrow(
            keccak256("usdc-window-over"),
            recipient,
            1000e6,
            block.timestamp + PROBE_PERIOD + 1,
            ProvianEscrowV4.Currency.USDC
        );
    }

    // ========================================================================
    // escrow.dispute_resolution_timeout -- schedule / bounds / apply / enforce
    //   (override-else-default: unset -> the live 30-day constant)
    // ========================================================================

    function test_escrow_scheduleDisputeTimeout_revertsForNonAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(ProvianEscrowV4.OnlyAdmin.selector);
        escrow.scheduleDisputeTimeout(1, PROBE_TIMEOUT);
    }

    function test_escrow_scheduleDisputeTimeout_rejectsNonProspectiveEpoch() public {
        vm.prank(admin);
        vm.expectRevert(ProvianEscrowV4.PolicyNotProspective.selector);
        escrow.scheduleDisputeTimeout(0, PROBE_TIMEOUT);
    }

    function test_escrow_scheduleDisputeTimeout_rejectsReschedulingTakenEpoch() public {
        vm.startPrank(admin);
        escrow.scheduleDisputeTimeout(1, PROBE_TIMEOUT);
        vm.expectRevert(ProvianEscrowV4.PolicyAlreadyScheduled.selector);
        escrow.scheduleDisputeTimeout(1, PROBE_TIMEOUT + 1 days);
        vm.stopPrank();
        (, uint256 value) = escrow.scheduledDisputeTimeout(1);
        assertEq(value, PROBE_TIMEOUT, "a taken epoch's timeout cannot be overwritten");
    }

    function test_escrow_scheduleDisputeTimeout_rejectsBelowFloor() public {
        uint256 belowFloor = escrow.DISPUTE_TIMEOUT_MIN() - 1;
        vm.prank(admin);
        vm.expectRevert(ProvianEscrowV4.CostOutOfDomain.selector);
        escrow.scheduleDisputeTimeout(1, belowFloor);
    }

    function test_escrow_scheduleDisputeTimeout_rejectsAboveCeiling() public {
        uint256 aboveCeiling = escrow.DISPUTE_TIMEOUT_MAX() + 1;
        vm.prank(admin);
        vm.expectRevert(ProvianEscrowV4.CostOutOfDomain.selector);
        escrow.scheduleDisputeTimeout(1, aboveCeiling);
    }

    function test_escrow_scheduleDisputeTimeout_acceptsFloorAndCeiling() public {
        uint256 floor = escrow.DISPUTE_TIMEOUT_MIN();
        uint256 ceiling = escrow.DISPUTE_TIMEOUT_MAX();
        vm.startPrank(admin);
        escrow.scheduleDisputeTimeout(1, floor);
        escrow.scheduleDisputeTimeout(2, ceiling);
        vm.stopPrank();
        (, uint256 v1) = escrow.scheduledDisputeTimeout(1);
        (, uint256 v2) = escrow.scheduledDisputeTimeout(2);
        assertEq(v1, floor, "floor value stored");
        assertEq(v2, ceiling, "ceiling value stored");
    }

    function test_escrow_scheduleDisputeTimeout_emitsEvent() public {
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ProvianEscrowV4.DisputeTimeoutScheduled(1, PROBE_TIMEOUT);
        vm.prank(admin);
        escrow.scheduleDisputeTimeout(1, PROBE_TIMEOUT);
    }

    function test_escrow_disputeTimeout_inertUntilOpen_thenActive() public {
        vm.prank(admin);
        escrow.scheduleDisputeTimeout(1, PROBE_TIMEOUT);
        (bool activeBefore,) = escrow.activeDisputeTimeout();
        assertFalse(activeBefore, "timeout override inert until the kernel reaches its epoch");
        _toEpoch(1);
        (bool activeAfter, uint256 value) = escrow.activeDisputeTimeout();
        assertTrue(activeAfter, "timeout override active once the kernel reaches its epoch");
        assertEq(value, PROBE_TIMEOUT);
    }

    // --- fail-closed: unset -> the historical 30-day constant (byte-for-byte) ---

    function test_escrow_disputeTimeout_unset_armsThirtyDayConstant() public {
        uint256 armed = _createFundDisputePVT(keccak256("timeout-unset"));
        assertEq(armed, block.timestamp + 30 days, "unset dispute timeout must arm the 30-day baseline");
        assertEq(escrow.DISPUTE_RESOLUTION_TIMEOUT(), 30 days, "the baseline constant is 30 days");
    }

    // --- end-to-end: an activated override drives the armed dispute deadline ---

    function test_escrow_disputeTimeout_openedOverride_drivesArmedDeadline() public {
        _setAndOpenDisputeTimeout(PROBE_TIMEOUT); // 60 days
        uint256 armed = _createFundDisputePVT(keccak256("timeout-override"));
        assertEq(armed, block.timestamp + PROBE_TIMEOUT, "activated override must drive the armed dispute deadline");
        assertTrue(armed != block.timestamp + 30 days, "probe timeout must differ from the 30-day baseline");
    }
}
