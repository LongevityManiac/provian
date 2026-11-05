// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ProvianPromiseV3.sol";
import "./MockTokens.sol";
import "./MockEpochClock.sol";

/**
 * @title ProvianPromiseV3CostMachineryTest
 * @notice institution parameters (session 4) + activation clock -- the Promise-native cost-parameter machinery:
 * bounded, admin-only (the bootstrap admin EOA on live Base), prospective-epoch
 * schedulers whose values activate lazily when the KERNEL epoch reaches
 * them (activation clock: bound to ProvianPVT9.currentEpoch() via an immutable clock;
 * the local counter and the permissionless openNextEpoch() are gone, so a
 * queued ladder cannot be collapsed in a single block). Every parameter
 * defaults fail-closed to inert, so with nothing scheduled the contract
 * behaves byte-for-byte as pre-institution parameters (proven directly by the unchanged
 * ProvianPromiseV3 suite, and here by the "unset == baseline literal / gate"
 * tests).
 *
 * VALUE-NEUTRAL BY CONSTRUCTION. Every probe rate/duration/cap in this file is an
 * arbitrary, in-range, TEST-ONLY fixture chosen solely to exercise the machinery.
 * NONE is an approval, a recommendation, or a claim about live economics.
 */
contract ProvianPromiseV3CostMachineryTest is Test {
    ProvianPromiseV3 public promiseContract;
    MockUSDC public usdc;
    MockPVT public pvt;
    MockEpochClock public clock;

    address public admin = address(0xA01);
    address public feeWallet = address(0xFEE);
    address public borrower = address(0xB01);
    address public lender = address(0xB02);
    address public stranger = address(0xBAD);

    // Kernel-epoch clock fixture. EPOCH_START is a nonzero base; the clock is armed
    // there and setUp warps to it, so the suite begins at kernel epoch 0. `_toEpoch`
    // advances real time so the institution's currentEpoch() reads the target epoch.
    uint256 internal constant EPOCH_START = 1_000_000;
    uint256 internal constant EPOCH_DURATION = 7 days; // matches ProvianPVT9.EPOCH_DURATION

    // TEST-ONLY probe fee: 50 bps. Arbitrary, inside the immutable 0–1000 band,
    // deliberately different from the 25-bps baseline literal so an "override took
    // effect" assertion can actually distinguish the two. NOT an approval.
    uint256 internal constant PROBE_FEE_BPS = 50;

    // TEST-ONLY probe principal cap: 500 PVT. Inside [1 PVT, 1,000,000 PVT]. NOT an approval.
    uint256 internal constant PROBE_CAP = 500e18;

    // TEST-ONLY probe deadline window: 30 days. Inside [1 hour, 90 days]. NOT an approval.
    uint256 internal constant PROBE_DEADLINE = 30 days;

    // TEST-ONLY probe default-grace period: 3 days. Inside [0, 30 days], deliberately
    // different from the 24-hour baseline constant. NOT an approval.
    uint256 internal constant PROBE_GRACE = 3 days;

    function setUp() public {
        usdc = new MockUSDC();
        pvt = new MockPVT();
        clock = new MockEpochClock(uint64(EPOCH_START));
        vm.warp(EPOCH_START); // kernel epoch 0
        promiseContract = new ProvianPromiseV3(admin, feeWallet, address(usdc), address(pvt), address(clock));

        // Fund both parties in both currencies, pre-approve max.
        usdc.mint(borrower, 100_000e6);
        usdc.mint(lender, 100_000e6);
        pvt.mint(borrower, 100_000e18);
        pvt.mint(lender, 100_000e18);

        vm.startPrank(borrower);
        usdc.approve(address(promiseContract), type(uint256).max);
        pvt.approve(address(promiseContract), type(uint256).max);
        vm.stopPrank();

        vm.startPrank(lender);
        usdc.approve(address(promiseContract), type(uint256).max);
        pvt.approve(address(promiseContract), type(uint256).max);
        vm.stopPrank();
    }

    /// @dev Advance real time so the kernel clock (and thus the institution) reads
    ///      epoch `n`. This is the ONLY way to activate a scheduled override -- there
    ///      is no permissionless epoch-advance to collapse a ladder.
    function _toEpoch(uint64 n) internal {
        vm.warp(EPOCH_START + uint256(n) * EPOCH_DURATION);
    }

    /// @dev Create (borrower) + fund (lender) + settle (borrower) a PVT-principal
    ///      promise, returning the fee PVT burned at settlement.
    function _createFundSettlePVT(bytes32 id, uint256 principal, uint256 repay)
        internal
        returns (uint256 feeBurned)
    {
        uint256 burnedBefore = pvt.totalBurned();
        vm.prank(borrower);
        promiseContract.createPromise(id, principal, repay, block.timestamp + 1 days, ProvianPromiseV3.Currency.PVT);
        vm.prank(lender);
        promiseContract.fundPromise(id);
        vm.prank(borrower);
        promiseContract.settlePromise(id, false);
        return pvt.totalBurned() - burnedBefore;
    }

    /// @dev Create (only) a PVT-principal promise -- the principal cap is enforced at creation.
    function _createPVT(bytes32 id, uint256 principal) internal {
        vm.prank(borrower);
        promiseContract.createPromise(id, principal, principal, block.timestamp + 1 days, ProvianPromiseV3.Currency.PVT);
    }

    /// @dev Create (only) a USDC-principal promise with an arbitrary principal.
    function _createUSDC(bytes32 id, uint256 principal) internal {
        vm.prank(borrower);
        promiseContract.createPromise(id, principal, principal, block.timestamp + 1 days, ProvianPromiseV3.Currency.USDC);
    }

    /// @dev Schedule a principal cap for epoch 1 (prospective at epoch 0) and advance to it.
    function _setAndOpenCap(uint256 cap) internal {
        vm.prank(admin);
        promiseContract.schedulePrincipalCap(1, cap);
        _toEpoch(1);
    }

    /// @dev Create (only) a PVT promise whose deadline is `window` seconds from now.
    function _createPVTWithWindow(bytes32 id, uint256 window) internal {
        vm.prank(borrower);
        promiseContract.createPromise(id, 1000e18, 1000e18, block.timestamp + window, ProvianPromiseV3.Currency.PVT);
    }

    /// @dev Schedule a maximum-deadline window for epoch 1 and advance to it.
    function _setAndOpenMaxDeadline(uint256 window) internal {
        vm.prank(admin);
        promiseContract.scheduleMaximumDeadline(1, window);
        _toEpoch(1);
    }

    /// @dev Create (borrower) + fund (lender) a PVT promise, leaving it Funded.
    function _createAndFundForDefault(bytes32 id, uint256 deadlineTs) internal {
        vm.prank(borrower);
        promiseContract.createPromise(id, 1000e18, 1000e18, deadlineTs, ProvianPromiseV3.Currency.PVT);
        vm.prank(lender);
        promiseContract.fundPromise(id);
    }

    /// @dev Schedule a default-grace period for epoch 1 and advance to it.
    function _setAndOpenGrace(uint256 grace) internal {
        vm.prank(admin);
        promiseContract.scheduleDefaultGracePeriod(1, grace);
        _toEpoch(1);
    }

    // ========================================================================
    // Epoch machinery (kernel-clock-bound; activation clock)
    // ========================================================================

    function test_promise_epoch_startsAtZero_firstSchedulableIsOne() public view {
        // At kernel epoch 0 the earliest prospective epoch is 1.
        assertEq(promiseContract.earliestSchedulableEpoch(), 1, "first schedulable epoch is 1 at epoch 0");
    }

    /// @dev activation clock: advancing the kernel clock (real time) is the ONLY way to move the
    ///      current epoch -- there is no local counter and no openNextEpoch. As time
    ///      crosses each EPOCH_DURATION boundary the earliest schedulable epoch moves.
    function test_promise_clockAdvance_movesSchedulableEpoch() public {
        _toEpoch(1);
        assertEq(promiseContract.earliestSchedulableEpoch(), 2, "at epoch 1, earliest schedulable is 2");
        _toEpoch(2);
        assertEq(promiseContract.earliestSchedulableEpoch(), 3, "at epoch 2, earliest schedulable is 3");
    }

    /// @dev activation clock: the permissionless untimed openNextEpoch() is GONE. A call to its
    ///      old selector must not resolve to any function (no fallback) -- proving the
    ///      clock can no longer be advanced by an arbitrary caller.
    function test_promise_noPermissionlessOpenNextEpoch() public {
        (bool ok,) = address(promiseContract).call(abi.encodeWithSignature("openNextEpoch()"));
        assertFalse(ok, "openNextEpoch() must no longer exist");
        (bool ok2,) = address(promiseContract).call(abi.encodeWithSignature("lastOpenedEpoch()"));
        assertFalse(ok2, "lastOpenedEpoch storage/getter must no longer exist");
    }

    /// @dev activation clock non-collapsibility: a queued ladder (epochs 1/2/3) activates exactly
    ///      one rung per kernel epoch and CANNOT be collapsed in a single block. Within
    ///      any one block currentEpoch() is fixed, so no sequence of calls advances more
    ///      than the current rung; only real time (7d/epoch) moves it forward.
    function test_promise_ladder_nonCollapsibleInSingleBlock() public {
        uint256 v1 = 10;
        uint256 v2 = 20;
        uint256 v3 = 30;
        vm.startPrank(admin);
        promiseContract.scheduleSettlementFeeBps(1, v1);
        promiseContract.scheduleSettlementFeeBps(2, v2);
        promiseContract.scheduleSettlementFeeBps(3, v3);
        vm.stopPrank();

        // Epoch 0: nothing has activated.
        (bool e0,) = promiseContract.activeSettlementFeeBps();
        assertFalse(e0, "no rung is active at epoch 0");

        // Epoch 1: exactly rung 1 -- not rung 3 -- and it stays rung 1 for the whole block.
        _toEpoch(1);
        (bool e1, uint256 a1) = promiseContract.activeSettlementFeeBps();
        assertTrue(e1, "rung 1 active at epoch 1");
        assertEq(a1, v1, "epoch 1 resolves to rung 1, not a collapsed rung 3");
        (, uint256 a1again) = promiseContract.activeSettlementFeeBps();
        assertEq(a1again, v1, "within one block the rung is fixed -- repeated reads do not advance it");
        // There is no permissionless advance to jump ahead within this block.
        (bool ok,) = address(promiseContract).call(abi.encodeWithSignature("openNextEpoch()"));
        assertFalse(ok, "no call can advance the epoch inside a block");
        (, uint256 a1still) = promiseContract.activeSettlementFeeBps();
        assertEq(a1still, v1, "the ladder cannot be collapsed to rung 3 in a single block");

        // Only real time advances the rung -- one per epoch.
        _toEpoch(2);
        (, uint256 a2) = promiseContract.activeSettlementFeeBps();
        assertEq(a2, v2, "epoch 2 resolves to rung 2");
        _toEpoch(3);
        (, uint256 a3) = promiseContract.activeSettlementFeeBps();
        assertEq(a3, v3, "epoch 3 resolves to rung 3");
    }

    /// @dev Forward-fill: a value persists across epochs that have no schedule of their
    ///      own, until a later scheduled epoch replaces it.
    function test_promise_forwardFill_valuePersistsUntilNextSchedule() public {
        vm.startPrank(admin);
        promiseContract.scheduleSettlementFeeBps(1, 10);
        promiseContract.scheduleSettlementFeeBps(3, 30); // epoch 2 deliberately skipped
        vm.stopPrank();

        _toEpoch(1);
        (, uint256 a1) = promiseContract.activeSettlementFeeBps();
        assertEq(a1, 10, "rung 1 active at epoch 1");
        _toEpoch(2);
        (, uint256 a2) = promiseContract.activeSettlementFeeBps();
        assertEq(a2, 10, "epoch 2 (unscheduled) carries rung 1 forward");
        _toEpoch(3);
        (, uint256 a3) = promiseContract.activeSettlementFeeBps();
        assertEq(a3, 30, "rung 3 replaces it at epoch 3");
    }

    /// @dev Out-of-order scheduling resolves by epoch, not by insertion order: a later
    ///      call for an EARLIER epoch is honored (the resolver tracks the max in-range epoch).
    function test_promise_outOfOrderSchedule_resolvesByEpoch() public {
        vm.startPrank(admin);
        promiseContract.scheduleSettlementFeeBps(3, 30); // farther epoch scheduled first
        promiseContract.scheduleSettlementFeeBps(1, 10); // nearer epoch scheduled second
        vm.stopPrank();

        _toEpoch(1);
        (, uint256 a1) = promiseContract.activeSettlementFeeBps();
        assertEq(a1, 10, "epoch 1 resolves to its own value despite being scheduled second");
        _toEpoch(3);
        (, uint256 a3) = promiseContract.activeSettlementFeeBps();
        assertEq(a3, 30, "epoch 3 resolves to its value");
    }

    /// @dev Fail-closed on an unarmed kernel: if the clock reverts (kernel not armed /
    ///      not started), currentEpoch() is treated as 0, every override is inert, and
    ///      the historical literal stands -- createPromise must NOT brick.
    function test_promise_unarmedKernel_failsClosedToBaseline() public {
        // Schedule an override, then disarm the clock so currentEpoch() reverts.
        vm.prank(admin);
        promiseContract.scheduleSettlementFeeBps(1, PROBE_FEE_BPS);
        clock.disarm();

        (bool active,) = promiseContract.activeSettlementFeeBps();
        assertFalse(active, "an unarmed clock resolves to epoch 0 -> no override active");

        uint256 feeBurned = _createFundSettlePVT(keccak256("unarmed"), 1000e18, 1000e18);
        assertEq(feeBurned, (1000e18 * 25) / 10000, "unarmed kernel must fall back to the 25-bps baseline, not brick");
    }

    // ========================================================================
    // scheduleSettlementFeeBps -- authority
    // ========================================================================

    function test_promise_scheduleSettlementFeeBps_revertsForNonAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(ProvianPromiseV3.OnlyAdmin.selector);
        promiseContract.scheduleSettlementFeeBps(1, PROBE_FEE_BPS);

        (bool exists,) = promiseContract.scheduledSettlementFeeBps(1);
        assertFalse(exists, "a rejected schedule must leave no state");
    }

    // ========================================================================
    // scheduleSettlementFeeBps -- prospectivity (rejects non-prospective epochs)
    // ========================================================================

    function test_promise_scheduleSettlementFeeBps_rejectsCurrentEpoch() public {
        // Epoch 0 is the current (already-in-effect) epoch, not prospective.
        vm.prank(admin);
        vm.expectRevert(ProvianPromiseV3.PolicyNotProspective.selector);
        promiseContract.scheduleSettlementFeeBps(0, PROBE_FEE_BPS);
    }

    function test_promise_scheduleSettlementFeeBps_rejectsAlreadyOpenedEpoch() public {
        _toEpoch(1); // kernel now at epoch 1
        vm.prank(admin);
        vm.expectRevert(ProvianPromiseV3.PolicyNotProspective.selector);
        promiseContract.scheduleSettlementFeeBps(1, PROBE_FEE_BPS);
    }

    // ========================================================================
    // scheduleSettlementFeeBps -- one value per epoch (rejects re-scheduling)
    // ========================================================================

    function test_promise_scheduleSettlementFeeBps_rejectsReschedulingTakenEpoch() public {
        vm.startPrank(admin);
        promiseContract.scheduleSettlementFeeBps(1, PROBE_FEE_BPS);
        vm.expectRevert(ProvianPromiseV3.PolicyAlreadyScheduled.selector);
        promiseContract.scheduleSettlementFeeBps(1, PROBE_FEE_BPS + 1);
        vm.stopPrank();

        (bool exists, uint256 value) = promiseContract.scheduledSettlementFeeBps(1);
        assertTrue(exists, "the original schedule stands");
        assertEq(value, PROBE_FEE_BPS, "a taken epoch's value cannot be overwritten");
    }

    // ========================================================================
    // scheduleSettlementFeeBps -- immutable bounds
    // ========================================================================

    function test_promise_scheduleSettlementFeeBps_rejectsAboveMax() public {
        uint256 overMax = promiseContract.SETTLEMENT_FEE_BPS_MAX() + 1;
        vm.prank(admin);
        vm.expectRevert(ProvianPromiseV3.CostOutOfDomain.selector);
        promiseContract.scheduleSettlementFeeBps(1, overMax);
    }

    function test_promise_scheduleSettlementFeeBps_acceptsCeilingAndZeroFloor() public {
        uint256 ceiling = promiseContract.SETTLEMENT_FEE_BPS_MAX();
        vm.startPrank(admin);
        promiseContract.scheduleSettlementFeeBps(1, ceiling); // exactly the ceiling is in-band
        promiseContract.scheduleSettlementFeeBps(2, 0); // a zero fee is inside the 0-floor band
        vm.stopPrank();

        (, uint256 v1) = promiseContract.scheduledSettlementFeeBps(1);
        (, uint256 v2) = promiseContract.scheduledSettlementFeeBps(2);
        assertEq(v1, ceiling, "ceiling value stored");
        assertEq(v2, 0, "zero value stored (0 is a legal fee, not 'unset')");
    }

    // ========================================================================
    // scheduleSettlementFeeBps -- event
    // ========================================================================

    function test_promise_scheduleSettlementFeeBps_emitsEvent() public {
        vm.expectEmit(true, false, false, true, address(promiseContract));
        emit ProvianPromiseV3.SettlementFeeBpsScheduled(3, PROBE_FEE_BPS);
        vm.prank(admin);
        promiseContract.scheduleSettlementFeeBps(3, PROBE_FEE_BPS);
    }

    // ========================================================================
    // Activation only when the scheduled epoch is reached (lazily)
    // ========================================================================

    function test_promise_feeBps_scheduledButInertUntilEpochOpens() public {
        vm.prank(admin);
        promiseContract.scheduleSettlementFeeBps(1, PROBE_FEE_BPS);

        (bool active,) = promiseContract.activeSettlementFeeBps();
        assertFalse(active, "a scheduled override is inert until the kernel reaches its epoch");
    }

    function test_promise_feeBps_activatesExactlyWhenItsEpochOpens() public {
        vm.prank(admin);
        promiseContract.scheduleSettlementFeeBps(1, PROBE_FEE_BPS);
        _toEpoch(1);

        (bool active, uint256 value) = promiseContract.activeSettlementFeeBps();
        assertTrue(active, "override becomes active when the kernel reaches its epoch");
        assertEq(value, PROBE_FEE_BPS, "the active value is exactly what was scheduled");
    }

    /// @dev Reaching an epoch that had NOTHING scheduled must leave every parameter
    ///      inert ("unset stays unset"). Without the resolver's "found" guard, an empty
    ///      epoch could read as {exists:true, value:0} and silently zero every fee.
    function test_promise_openingUnscheduledEpoch_leavesEverythingInert() public {
        _toEpoch(1); // kernel reaches epoch 1 with no schedule for any parameter

        (bool feeActive, uint256 feeValue) = promiseContract.activeSettlementFeeBps();
        assertFalse(feeActive, "an unscheduled epoch must not activate the fee override");
        assertEq(feeValue, 0, "no fee override value may be read from an empty epoch");

        (bool capActive, uint256 capValue) = promiseContract.activePrincipalCap();
        assertFalse(capActive, "an unscheduled epoch must not activate the principal cap");
        assertEq(capValue, 0, "no cap value may be read from an empty epoch");

        (bool deadlineActive, uint256 deadlineValue) = promiseContract.activeMaximumDeadline();
        assertFalse(deadlineActive, "an unscheduled epoch must not activate the maximum deadline");
        assertEq(deadlineValue, 0, "no deadline value may be read from an empty epoch");

        (bool graceActive, uint256 graceValue) = promiseContract.activeDefaultGracePeriod();
        assertFalse(graceActive, "an unscheduled epoch must not activate the default grace override");
        assertEq(graceValue, 0, "no grace value may be read from an empty epoch");

        // A PVT promise created+funded+settled at the empty epoch must still burn the
        // 25-bps baseline fee (gate inert -> literal stands).
        uint256 feeBurned = _createFundSettlePVT(keccak256("carry-forward"), 1000e18, 1000e18);
        assertEq(feeBurned, (1000e18 * 25) / 10000, "an unscheduled epoch must leave the baseline fee intact");
    }

    // ========================================================================
    // Fail-closed: unset == byte-for-byte baseline
    // ========================================================================

    function test_promise_fee_unset_chargesTheBaseline25bpsLiteral() public {
        uint256 feeBurned = _createFundSettlePVT(keccak256("unset-fee"), 1000e18, 1000e18);
        assertEq(feeBurned, (1000e18 * 25) / 10000, "unset fee must equal the 25-bps baseline literal");
    }

    function test_promise_fee_unset_nonRoundAmount_exactBaselineRounding() public {
        // Locks the EXACT integer rounding of the unset fee literal at a NON-round
        // repayAmount: `(repay * 25) / 10000` truncates AFTER the multiply.
        uint256 repay = 12_345;
        uint256 feeBurned = _createFundSettlePVT(keccak256("unset-fee-nonround"), 1, repay);
        assertEq(feeBurned, (repay * 25) / 10000, "non-round unset fee must match the exact multiply-then-divide literal");
        assertEq(feeBurned, 30, "explicit: (12345*25)/10000 == 30, not 25");
    }

    // ========================================================================
    // End-to-end: an activated override actually drives the charged fee
    // ========================================================================

    function test_promise_fee_openedOverride_drivesTheChargedFee() public {
        vm.prank(admin);
        promiseContract.scheduleSettlementFeeBps(1, PROBE_FEE_BPS);
        _toEpoch(1);

        uint256 feeBurned = _createFundSettlePVT(keccak256("override-fee"), 1000e18, 1000e18);
        assertEq(
            feeBurned, (1000e18 * PROBE_FEE_BPS) / 10_000, "an activated override must be the fee that is charged/burned"
        );
        assertTrue(feeBurned != (1000e18 * 25) / 10000, "probe fee must differ from the baseline literal");
    }

    // ========================================================================
    // promise.pvt_principal_cap -- schedule / bounds / apply / enforcement
    //   (additive gate: unset -> no cap; gates PVT-principal promises only)
    // ========================================================================

    function test_promise_schedulePrincipalCap_revertsForNonAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(ProvianPromiseV3.OnlyAdmin.selector);
        promiseContract.schedulePrincipalCap(1, PROBE_CAP);
    }

    function test_promise_schedulePrincipalCap_rejectsNonProspectiveEpoch() public {
        vm.prank(admin);
        vm.expectRevert(ProvianPromiseV3.PolicyNotProspective.selector);
        promiseContract.schedulePrincipalCap(0, PROBE_CAP);
    }

    function test_promise_schedulePrincipalCap_rejectsReschedulingTakenEpoch() public {
        vm.startPrank(admin);
        promiseContract.schedulePrincipalCap(1, PROBE_CAP);
        vm.expectRevert(ProvianPromiseV3.PolicyAlreadyScheduled.selector);
        promiseContract.schedulePrincipalCap(1, PROBE_CAP + 1e18);
        vm.stopPrank();

        (, uint256 value) = promiseContract.scheduledPrincipalCap(1);
        assertEq(value, PROBE_CAP, "a taken epoch's cap cannot be overwritten");
    }

    function test_promise_schedulePrincipalCap_rejectsBelowFloor() public {
        uint256 belowFloor = promiseContract.PRINCIPAL_CAP_MIN() - 1;
        vm.prank(admin);
        vm.expectRevert(ProvianPromiseV3.CostOutOfDomain.selector);
        promiseContract.schedulePrincipalCap(1, belowFloor);
    }

    function test_promise_schedulePrincipalCap_rejectsAboveCeiling() public {
        uint256 aboveCeiling = promiseContract.PRINCIPAL_CAP_MAX() + 1;
        vm.prank(admin);
        vm.expectRevert(ProvianPromiseV3.CostOutOfDomain.selector);
        promiseContract.schedulePrincipalCap(1, aboveCeiling);
    }

    function test_promise_schedulePrincipalCap_acceptsFloorAndCeiling() public {
        uint256 floor = promiseContract.PRINCIPAL_CAP_MIN();
        uint256 ceiling = promiseContract.PRINCIPAL_CAP_MAX();
        vm.startPrank(admin);
        promiseContract.schedulePrincipalCap(1, floor); // exactly the floor is in-band
        promiseContract.schedulePrincipalCap(2, ceiling); // exactly the ceiling is in-band
        vm.stopPrank();

        (, uint256 v1) = promiseContract.scheduledPrincipalCap(1);
        (, uint256 v2) = promiseContract.scheduledPrincipalCap(2);
        assertEq(v1, floor, "floor value stored");
        assertEq(v2, ceiling, "ceiling value stored");
    }

    function test_promise_schedulePrincipalCap_emitsEvent() public {
        vm.expectEmit(true, false, false, true, address(promiseContract));
        emit ProvianPromiseV3.PrincipalCapScheduled(1, PROBE_CAP);
        vm.prank(admin);
        promiseContract.schedulePrincipalCap(1, PROBE_CAP);
    }

    function test_promise_principalCap_inertUntilEpochOpens_thenActive() public {
        vm.prank(admin);
        promiseContract.schedulePrincipalCap(1, PROBE_CAP);

        (bool activeBefore,) = promiseContract.activePrincipalCap();
        assertFalse(activeBefore, "cap inert until the kernel reaches its epoch");

        _toEpoch(1);
        (bool activeAfter, uint256 value) = promiseContract.activePrincipalCap();
        assertTrue(activeAfter, "cap active once the kernel reaches its epoch");
        assertEq(value, PROBE_CAP, "active cap is exactly what was scheduled");
    }

    // --- fail-closed: unset cap does not gate (byte-for-byte baseline) ---

    function test_promise_principalCap_unset_allowsPrincipalFarAboveAnyCap() public {
        _createPVT(keccak256("huge-uncapped"), 900_000e18);
        assertEq(
            uint256(promiseContract.currency(keccak256("huge-uncapped"))),
            uint256(ProvianPromiseV3.Currency.PVT),
            "unset cap must not gate any PVT principal"
        );
    }

    // --- gate PVT strictly above the cap; allow at/below; USDC exempt ---

    function test_promise_principalCap_gatesPVTStrictlyAboveCap() public {
        _setAndOpenCap(PROBE_CAP);
        vm.prank(borrower);
        vm.expectRevert(ProvianPromiseV3.PrincipalCapExceeded.selector);
        promiseContract.createPromise(
            keccak256("over"), PROBE_CAP + 1, PROBE_CAP + 1, block.timestamp + 1 days, ProvianPromiseV3.Currency.PVT
        );
    }

    function test_promise_principalCap_allowsPVTExactlyAtCap() public {
        _setAndOpenCap(PROBE_CAP);
        _createPVT(keccak256("at-cap"), PROBE_CAP);
        assertEq(
            uint256(promiseContract.currency(keccak256("at-cap"))),
            uint256(ProvianPromiseV3.Currency.PVT),
            "principal exactly at the cap must be accepted"
        );
    }

    function test_promise_principalCap_doesNotGateUSDCPromises() public {
        _setAndOpenCap(PROBE_CAP);
        _createUSDC(keccak256("usdc-exempt"), PROBE_CAP + 1e18);
        assertEq(
            uint256(promiseContract.currency(keccak256("usdc-exempt"))),
            uint256(ProvianPromiseV3.Currency.USDC),
            "USDC promise must be created despite exceeding the PVT cap value"
        );
    }

    // ========================================================================
    // promise.maximum_deadline -- schedule / bounds / apply / enforcement
    //   (additive gate: unset -> any future timestamp; currency-agnostic)
    // ========================================================================

    function test_promise_scheduleMaximumDeadline_revertsForNonAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(ProvianPromiseV3.OnlyAdmin.selector);
        promiseContract.scheduleMaximumDeadline(1, PROBE_DEADLINE);
    }

    function test_promise_scheduleMaximumDeadline_rejectsNonProspectiveEpoch() public {
        vm.prank(admin);
        vm.expectRevert(ProvianPromiseV3.PolicyNotProspective.selector);
        promiseContract.scheduleMaximumDeadline(0, PROBE_DEADLINE);
    }

    function test_promise_scheduleMaximumDeadline_rejectsReschedulingTakenEpoch() public {
        vm.startPrank(admin);
        promiseContract.scheduleMaximumDeadline(1, PROBE_DEADLINE);
        vm.expectRevert(ProvianPromiseV3.PolicyAlreadyScheduled.selector);
        promiseContract.scheduleMaximumDeadline(1, PROBE_DEADLINE + 1 hours);
        vm.stopPrank();
        (, uint256 value) = promiseContract.scheduledMaximumDeadline(1);
        assertEq(value, PROBE_DEADLINE, "a taken epoch's window cannot be overwritten");
    }

    function test_promise_scheduleMaximumDeadline_rejectsBelowFloor() public {
        uint256 belowFloor = promiseContract.MAXIMUM_DEADLINE_MIN() - 1;
        vm.prank(admin);
        vm.expectRevert(ProvianPromiseV3.CostOutOfDomain.selector);
        promiseContract.scheduleMaximumDeadline(1, belowFloor);
    }

    function test_promise_scheduleMaximumDeadline_rejectsAboveCeiling() public {
        uint256 aboveCeiling = promiseContract.MAXIMUM_DEADLINE_MAX() + 1;
        vm.prank(admin);
        vm.expectRevert(ProvianPromiseV3.CostOutOfDomain.selector);
        promiseContract.scheduleMaximumDeadline(1, aboveCeiling);
    }

    function test_promise_scheduleMaximumDeadline_acceptsFloorAndCeiling() public {
        uint256 floor = promiseContract.MAXIMUM_DEADLINE_MIN();
        uint256 ceiling = promiseContract.MAXIMUM_DEADLINE_MAX();
        vm.startPrank(admin);
        promiseContract.scheduleMaximumDeadline(1, floor);
        promiseContract.scheduleMaximumDeadline(2, ceiling);
        vm.stopPrank();
        (, uint256 v1) = promiseContract.scheduledMaximumDeadline(1);
        (, uint256 v2) = promiseContract.scheduledMaximumDeadline(2);
        assertEq(v1, floor, "floor value stored");
        assertEq(v2, ceiling, "ceiling value stored");
    }

    function test_promise_scheduleMaximumDeadline_emitsEvent() public {
        vm.expectEmit(true, false, false, true, address(promiseContract));
        emit ProvianPromiseV3.MaximumDeadlineScheduled(1, PROBE_DEADLINE);
        vm.prank(admin);
        promiseContract.scheduleMaximumDeadline(1, PROBE_DEADLINE);
    }

    function test_promise_maximumDeadline_inertUntilOpen_thenActive() public {
        vm.prank(admin);
        promiseContract.scheduleMaximumDeadline(1, PROBE_DEADLINE);
        (bool activeBefore,) = promiseContract.activeMaximumDeadline();
        assertFalse(activeBefore, "deadline window inert until the kernel reaches its epoch");
        _toEpoch(1);
        (bool activeAfter, uint256 value) = promiseContract.activeMaximumDeadline();
        assertTrue(activeAfter, "deadline window active once the kernel reaches its epoch");
        assertEq(value, PROBE_DEADLINE);
    }

    // --- fail-closed: unset -> any future timestamp accepted (byte-for-byte) ---

    function test_promise_maximumDeadline_unset_allowsWindowFarAboveCeiling() public {
        _createPVTWithWindow(keccak256("huge-window"), 180 days);
        assertEq(
            uint256(promiseContract.currency(keccak256("huge-window"))),
            uint256(ProvianPromiseV3.Currency.PVT),
            "unset deadline bound must not gate any future window"
        );
    }

    // --- gate strictly above the window; allow at/below; currency-agnostic ---

    function test_promise_maximumDeadline_gatesWindowStrictlyAbove() public {
        _setAndOpenMaxDeadline(PROBE_DEADLINE);
        vm.prank(borrower);
        vm.expectRevert(ProvianPromiseV3.MaximumDeadlineExceeded.selector);
        promiseContract.createPromise(
            keccak256("deadline-over"),
            1000e18,
            1000e18,
            block.timestamp + PROBE_DEADLINE + 1,
            ProvianPromiseV3.Currency.PVT
        );
    }

    function test_promise_maximumDeadline_allowsWindowExactlyAt() public {
        _setAndOpenMaxDeadline(PROBE_DEADLINE);
        _createPVTWithWindow(keccak256("deadline-at"), PROBE_DEADLINE); // strict > -> at-bound allowed
        assertEq(uint256(promiseContract.currency(keccak256("deadline-at"))), uint256(ProvianPromiseV3.Currency.PVT));
    }

    function test_promise_maximumDeadline_gatesUSDCPromisesToo() public {
        _setAndOpenMaxDeadline(PROBE_DEADLINE);
        vm.prank(borrower);
        vm.expectRevert(ProvianPromiseV3.MaximumDeadlineExceeded.selector);
        promiseContract.createPromise(
            keccak256("usdc-window-over"),
            1000e6,
            1000e6,
            block.timestamp + PROBE_DEADLINE + 1,
            ProvianPromiseV3.Currency.USDC
        );
    }

    /// @dev Locks the enforcement placement: the window check sits AFTER the
    ///      future-timestamp check, so `deadlineWindow = deadline - now` cannot
    ///      underflow. A past `deadline` must revert InvalidDeadline, never a panic.
    function test_promise_pastDeadline_revertsInvalidDeadlineNotPanic() public {
        vm.prank(borrower);
        vm.expectRevert(ProvianPromiseV3.InvalidDeadline.selector);
        promiseContract.createPromise(
            keccak256("past"), 1000e18, 1000e18, block.timestamp - 1, ProvianPromiseV3.Currency.PVT
        );
    }

    // ========================================================================
    // promise.default_grace_period -- schedule / bounds / apply / enforcement
    //   (override-else-literal: unset -> the live 24-hour DEFAULT_GRACE_PERIOD)
    // ========================================================================

    function test_promise_scheduleDefaultGracePeriod_revertsForNonAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(ProvianPromiseV3.OnlyAdmin.selector);
        promiseContract.scheduleDefaultGracePeriod(1, PROBE_GRACE);
    }

    function test_promise_scheduleDefaultGracePeriod_rejectsNonProspectiveEpoch() public {
        vm.prank(admin);
        vm.expectRevert(ProvianPromiseV3.PolicyNotProspective.selector);
        promiseContract.scheduleDefaultGracePeriod(0, PROBE_GRACE);
    }

    function test_promise_scheduleDefaultGracePeriod_rejectsReschedulingTakenEpoch() public {
        vm.startPrank(admin);
        promiseContract.scheduleDefaultGracePeriod(1, PROBE_GRACE);
        vm.expectRevert(ProvianPromiseV3.PolicyAlreadyScheduled.selector);
        promiseContract.scheduleDefaultGracePeriod(1, PROBE_GRACE + 1 hours);
        vm.stopPrank();
        (, uint256 value) = promiseContract.scheduledDefaultGracePeriod(1);
        assertEq(value, PROBE_GRACE, "a taken epoch's grace cannot be overwritten");
    }

    function test_promise_scheduleDefaultGracePeriod_rejectsAboveMax() public {
        uint256 overMax = promiseContract.DEFAULT_GRACE_PERIOD_MAX() + 1;
        vm.prank(admin);
        vm.expectRevert(ProvianPromiseV3.CostOutOfDomain.selector);
        promiseContract.scheduleDefaultGracePeriod(1, overMax);
    }

    function test_promise_scheduleDefaultGracePeriod_acceptsCeilingAndZeroFloor() public {
        uint256 ceiling = promiseContract.DEFAULT_GRACE_PERIOD_MAX();
        vm.startPrank(admin);
        promiseContract.scheduleDefaultGracePeriod(1, ceiling); // exactly the ceiling is in-band
        promiseContract.scheduleDefaultGracePeriod(2, 0); // a zero grace is inside the 0-floor band
        vm.stopPrank();
        (, uint256 v1) = promiseContract.scheduledDefaultGracePeriod(1);
        (, uint256 v2) = promiseContract.scheduledDefaultGracePeriod(2);
        assertEq(v1, ceiling, "ceiling value stored");
        assertEq(v2, 0, "zero value stored (0 is a legal grace, not 'unset')");
    }

    function test_promise_scheduleDefaultGracePeriod_emitsEvent() public {
        vm.expectEmit(true, false, false, true, address(promiseContract));
        emit ProvianPromiseV3.DefaultGracePeriodScheduled(1, PROBE_GRACE);
        vm.prank(admin);
        promiseContract.scheduleDefaultGracePeriod(1, PROBE_GRACE);
    }

    function test_promise_defaultGracePeriod_inertUntilOpen_thenActive() public {
        vm.prank(admin);
        promiseContract.scheduleDefaultGracePeriod(1, PROBE_GRACE);
        (bool activeBefore,) = promiseContract.activeDefaultGracePeriod();
        assertFalse(activeBefore, "grace override inert until the kernel reaches its epoch");
        _toEpoch(1);
        (bool activeAfter, uint256 value) = promiseContract.activeDefaultGracePeriod();
        assertTrue(activeAfter, "grace override active once the kernel reaches its epoch");
        assertEq(value, PROBE_GRACE);
    }

    // --- fail-closed: unset -> the historical 24-hour constant (byte-for-byte) ---

    function test_promise_grace_unset_matchesBaseline24hBoundary() public {
        uint256 deadline = block.timestamp + 30 days;
        _createAndFundForDefault(keccak256("g-unset"), deadline);

        // 1 second inside the 24h window: a stranger cannot mark default.
        vm.warp(deadline + 24 hours - 1);
        vm.prank(stranger);
        vm.expectRevert(ProvianPromiseV3.OnlyBorrower.selector);
        promiseContract.markDefault(keccak256("g-unset"));

        // Exactly at the 24h boundary (window is exclusive): anyone may now mark it.
        vm.warp(deadline + 24 hours);
        vm.expectEmit(true, true, true, true, address(promiseContract));
        emit ProvianPromiseV3.PromiseDefaultedPVT(keccak256("g-unset"), borrower, lender, 1000e18);
        vm.prank(stranger);
        promiseContract.markDefault(keccak256("g-unset"));
    }

    // --- end-to-end: an activated override drives the grace window ---

    function test_promise_grace_openedOverride_extendsWindowBeyondBaseline() public {
        _setAndOpenGrace(PROBE_GRACE);
        uint256 deadline = block.timestamp + 30 days;
        _createAndFundForDefault(keccak256("g-ext"), deadline);

        vm.warp(deadline + 2 days);
        vm.prank(stranger);
        vm.expectRevert(ProvianPromiseV3.OnlyBorrower.selector);
        promiseContract.markDefault(keccak256("g-ext"));
    }

    function test_promise_grace_openedOverride_strangerAllowedAfterOverrideWindow() public {
        _setAndOpenGrace(PROBE_GRACE);
        uint256 deadline = block.timestamp + 30 days;
        _createAndFundForDefault(keccak256("g-after"), deadline);

        // At exactly the override boundary (exclusive), a stranger may mark default.
        vm.warp(deadline + PROBE_GRACE);
        vm.expectEmit(true, true, true, true, address(promiseContract));
        emit ProvianPromiseV3.PromiseDefaultedPVT(keccak256("g-after"), borrower, lender, 1000e18);
        vm.prank(stranger);
        promiseContract.markDefault(keccak256("g-after"));
    }

    function test_promise_grace_zeroOverride_allowsStrangerImmediatelyAtDeadline() public {
        _setAndOpenGrace(0);
        uint256 deadline = block.timestamp + 30 days;
        _createAndFundForDefault(keccak256("g-zero"), deadline);

        vm.warp(deadline); // block.timestamp == deadline: past the DeadlineNotReached gate
        vm.expectEmit(true, true, true, true, address(promiseContract));
        emit ProvianPromiseV3.PromiseDefaultedPVT(keccak256("g-zero"), borrower, lender, 1000e18);
        vm.prank(stranger);
        promiseContract.markDefault(keccak256("g-zero"));
    }

    // ========================================================================
    // Review hardening -- bounds pinned to the frozen cost catalog
    // ========================================================================

    /// @dev Pin the immutable bounds to the frozen cost catalog's declared ranges as
    ///      raw integers, NOT via arithmetic (which would move with a typo).
    function test_promise_immutableBounds_matchTheFrozenCatalogRanges() public view {
        assertEq(promiseContract.SETTLEMENT_FEE_BPS_MAX(), 1000, "fee ceiling = 1000 bps");
        assertEq(promiseContract.PRINCIPAL_CAP_MIN(), 1e18, "cap floor = 1 PVT");
        assertEq(promiseContract.PRINCIPAL_CAP_MAX(), 1_000_000e18, "cap ceiling = 1,000,000 PVT");
        assertEq(promiseContract.MAXIMUM_DEADLINE_MIN(), 3600, "deadline floor = 1 hour");
        assertEq(promiseContract.MAXIMUM_DEADLINE_MAX(), 7_776_000, "deadline ceiling = 90 days");
        assertEq(promiseContract.DEFAULT_GRACE_PERIOD_MAX(), 2_592_000, "grace ceiling = 30 days");
        assertEq(promiseContract.DEFAULT_GRACE_PERIOD(), 86400, "baseline grace literal = 24 hours = 86400 s");
    }
}
