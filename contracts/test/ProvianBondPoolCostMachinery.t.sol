// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ProvianBondPool.sol";
import "../src/ProvianPVT9.sol";
import "./MockTokens.sol";
import "./MockEpochClock.sol";
import "./MockIssuanceIndex.sol";

/**
 * @title ProvianBondPoolCostMachineryTest
 * @notice institution parameters-rem -- the Bond-native cost-parameter machinery: an ADDITIVE,
 * kernel-clock-bound, prospective-epoch OVERLAY on the settable bond cost
 * params (mirroring the merged Escrow/Promise/Pool/Court machinery). Each
 * activeX() resolves the scheduled override at the kernel epoch, else the
 * existing storage var -- so with nothing scheduled (the shipped state) every
 * lifecycle read is the pre-institution parameters value (proven by the unchanged ProvianBondPool
 * suites and the "unset == default" tests here). The pre-existing immediate
 * updateX setters, velocity caps, and BOND_PARAM_WINDOW are untouched.
 *
 * VALUE-NEUTRAL BY CONSTRUCTION. Every probe here is an arbitrary in-range TEST-ONLY
 * fixture. None is an approval, a recommendation, or a claim about live economics.
 */
contract ProvianBondPoolCostMachineryTest is Test {
    ProvianBondPool public bond;
    MockPVT public pvt;
    MockEpochClock public clock;

    address public admin = address(0xA01);
    address public tech = address(0x7EC4);
    address public executor = address(0xE0A);
    address public court = address(0xC0F7);
    address public stranger = address(0xBAD);
    address public agent = address(0xA6E7);
    address public claimant = address(0xC1A1);

    uint256 internal constant EPOCH_START = 1_000_000;
    uint256 internal constant EPOCH_DURATION = 7 days;

    // Baselines (the recalibrated storage defaults).
    uint256 internal constant DEF_DEPOSIT_BURN = 200;
    uint256 internal constant DEF_DEPOSIT_FEE = 100;
    uint256 internal constant DEF_RENEWAL_BURN = 100;
    uint256 internal constant DEF_RENEWAL_FEE = 50;
    uint256 internal constant DEF_SLASH_PAYOUT = 8000;
    uint256 internal constant DEF_FILING_FEE = 15e18;
    uint256 internal constant DEF_PROCESSING_FEE = 30e18;
    uint256 internal constant DEF_RENEWAL_PERIOD = 90 days;
    uint256 internal constant DEF_ABANDONMENT = 180 days;
    uint256 internal constant DEF_L2 = 750e18;
    uint256 internal constant DEF_L3 = 3000e18;
    uint256 internal constant DEF_MAX_DEPOSIT = 7500e18;

    // TEST-ONLY probes, all in-range and distinct from the baselines. NOT approvals.
    uint256 internal constant PROBE_DEPOSIT_BURN = 300;
    uint256 internal constant PROBE_DEPOSIT_FEE = 200;
    uint256 internal constant PROBE_RENEWAL_BURN = 200;
    uint256 internal constant PROBE_RENEWAL_FEE = 100;
    uint256 internal constant PROBE_SLASH_BURN = 3000;
    uint256 internal constant PROBE_SLASH_PAYOUT = 7000;
    uint256 internal constant PROBE_PROCESSING_FEE = 50e18;
    uint256 internal constant PROBE_FILING_FEE = 25e18;
    uint256 internal constant PROBE_RENEWAL_PERIOD = 120 days;
    uint256 internal constant PROBE_ABANDONMENT = 200 days;
    uint256 internal constant PROBE_L2 = 1000e18;
    uint256 internal constant PROBE_L3 = 4000e18;
    uint256 internal constant PROBE_MAX_DEPOSIT = 10000e18;

    function setUp() public {
        pvt = new MockPVT();
        clock = new MockEpochClock(uint64(EPOCH_START));
        vm.warp(EPOCH_START); // kernel epoch 0
        // institution deployment/courtContract must implement fundBondClaimReward (slashBond/dismissClaim
        // route the processing fee to it), so wire the minimal sink mock, not an EOA.
        court = address(new MockCourtRewardSink());
        bond = new ProvianBondPool(admin, tech, address(pvt), address(clock), address(new MockIssuanceIndex()), new ProvianBondPool.BondSeed[](0), new ProvianBondPool.BpsSeed[](0));
        vm.startPrank(admin);
        bond.setExecutor(executor);
        bond.setCourtContract(court);
        vm.stopPrank();

        pvt.mint(agent, 1_000_000e18);
        pvt.mint(claimant, 1_000_000e18);
        vm.prank(agent);
        pvt.approve(address(bond), type(uint256).max);
        vm.prank(claimant);
        pvt.approve(address(bond), type(uint256).max);
    }

    function _toEpoch(uint64 n) internal {
        vm.warp(EPOCH_START + uint256(n) * EPOCH_DURATION);
    }

    function _postBond(uint8 level) internal returns (uint256 locked) {
        vm.prank(agent);
        bond.postBond(level, 0);
        (locked,,,,,,) = bond.bonds(agent);
    }

    // ========================================================================
    // Epoch machinery (shared logic, exercised on depositBurnBps)
    // ========================================================================

    function test_bond_epoch_startsAtZero_firstSchedulableIsOne() public view {
        assertEq(bond.earliestSchedulableEpoch(), 1);
    }

    function test_bond_clockAdvance_movesSchedulableEpoch() public {
        _toEpoch(1);
        assertEq(bond.earliestSchedulableEpoch(), 2);
        _toEpoch(2);
        assertEq(bond.earliestSchedulableEpoch(), 3);
    }

    function test_bond_noPermissionlessOpenNextEpoch() public {
        (bool ok,) = address(bond).call(abi.encodeWithSignature("openNextEpoch()"));
        assertFalse(ok);
        (bool ok2,) = address(bond).call(abi.encodeWithSignature("lastOpenedEpoch()"));
        assertFalse(ok2);
    }

    function test_bond_ladder_nonCollapsibleInSingleBlock() public {
        vm.startPrank(executor);
        bond.scheduleDepositBurnBps(1, 10);
        bond.scheduleDepositBurnBps(2, 20);
        bond.scheduleDepositBurnBps(3, 30);
        vm.stopPrank();

        (bool e0,) = bond.activeDepositBurnBps();
        assertFalse(e0);
        _toEpoch(1);
        (bool e1, uint256 a1) = bond.activeDepositBurnBps();
        assertTrue(e1);
        assertEq(a1, 10, "epoch 1 -> rung 1, not collapsed rung 3");
        (bool ok,) = address(bond).call(abi.encodeWithSignature("openNextEpoch()"));
        assertFalse(ok);
        (, uint256 a1still) = bond.activeDepositBurnBps();
        assertEq(a1still, 10, "ladder cannot collapse in a single block");
        _toEpoch(3);
        (, uint256 a3) = bond.activeDepositBurnBps();
        assertEq(a3, 30);
    }

    function test_bond_forwardFill_valuePersistsUntilNextSchedule() public {
        vm.startPrank(executor);
        bond.scheduleDepositBurnBps(1, 10);
        bond.scheduleDepositBurnBps(3, 30);
        vm.stopPrank();
        _toEpoch(2);
        (, uint256 a2) = bond.activeDepositBurnBps();
        assertEq(a2, 10, "epoch 2 (unscheduled) carries rung 1 forward");
    }

    function test_bond_outOfOrderSchedule_resolvesByEpoch() public {
        vm.startPrank(executor);
        bond.scheduleDepositBurnBps(3, 30);
        bond.scheduleDepositBurnBps(1, 10);
        vm.stopPrank();
        _toEpoch(1);
        (, uint256 a1) = bond.activeDepositBurnBps();
        assertEq(a1, 10);
    }

    function test_bond_unarmedKernel_failsClosedToBaseline() public {
        vm.prank(executor);
        bond.scheduleDepositBurnBps(1, PROBE_DEPOSIT_BURN);
        clock.disarm();
        (bool active,) = bond.activeDepositBurnBps();
        assertFalse(active, "unarmed clock -> epoch 0 -> no override");
        // getRequiredBond must resolve to the baseline ladder and not brick.
        assertEq(bond.getRequiredBond(2, 0), DEF_L2, "unarmed -> baseline L2");
    }

    function test_bond_realKernelBinding_unarmedFailsClosed() public {
        ProvianPVT9 realKernel = new ProvianPVT9();
        ProvianBondPool boundBond = new ProvianBondPool(admin, tech, address(pvt), address(realKernel), address(new MockIssuanceIndex()), new ProvianBondPool.BondSeed[](0), new ProvianBondPool.BpsSeed[](0));
        vm.expectRevert(ProvianPVT9.EpochZeroNotArmed.selector);
        realKernel.currentEpoch();
        assertEq(boundBond.earliestSchedulableEpoch(), 1, "unarmed real kernel -> epoch 0");
        assertEq(boundBond.getRequiredBond(2, 0), DEF_L2, "unarmed real kernel -> baseline L2");
    }

    function test_bond_openingUnscheduledEpoch_leavesInert() public {
        _toEpoch(1);
        (bool a,) = bond.activeDepositBurnBps();
        assertFalse(a);
        assertEq(bond.getRequiredBond(2, 0), DEF_L2);
    }

    // ========================================================================
    // Authority + prospectivity + one-per-epoch (shared; on depositBurnBps)
    // ========================================================================

    function test_bond_schedule_revertsForNonExecutor() public {
        vm.prank(stranger);
        vm.expectRevert(ProvianBondPool.OnlyExecutor.selector);
        bond.scheduleDepositBurnBps(1, PROBE_DEPOSIT_BURN);
    }

    function test_bond_schedule_adminIsNotExecutor() public {
        // Authority is onlyExecutor, not onlyAdmin (matches the immediate setters).
        vm.prank(admin);
        vm.expectRevert(ProvianBondPool.OnlyExecutor.selector);
        bond.scheduleDepositBurnBps(1, PROBE_DEPOSIT_BURN);
    }

    function test_bond_schedule_rejectsCurrentEpoch() public {
        vm.prank(executor);
        vm.expectRevert(ProvianBondPool.PolicyNotProspective.selector);
        bond.scheduleDepositBurnBps(0, PROBE_DEPOSIT_BURN);
    }

    function test_bond_schedule_rejectsAlreadyOpenedEpoch() public {
        _toEpoch(1);
        vm.prank(executor);
        vm.expectRevert(ProvianBondPool.PolicyNotProspective.selector);
        bond.scheduleDepositBurnBps(1, PROBE_DEPOSIT_BURN);
    }

    function test_bond_schedule_rejectsReschedulingTakenEpoch() public {
        vm.startPrank(executor);
        bond.scheduleDepositBurnBps(1, PROBE_DEPOSIT_BURN);
        vm.expectRevert(ProvianBondPool.PolicyAlreadyScheduled.selector);
        bond.scheduleDepositBurnBps(1, PROBE_DEPOSIT_BURN + 1);
        vm.stopPrank();
        (, uint256 v) = bond.scheduledDepositBurnBps(1);
        assertEq(v, PROBE_DEPOSIT_BURN);
    }

    // ========================================================================
    // Per-scheduler bounds (each band pinned) + event
    // ========================================================================

    function test_bond_depositBurn_bounds() public {
        uint256 max = bond.BOND_DEPOSIT_BURN_BPS_MAX();
        vm.startPrank(executor);
        vm.expectRevert(ProvianBondPool.CostOutOfDomain.selector);
        bond.scheduleDepositBurnBps(1, max + 1);
        bond.scheduleDepositBurnBps(1, max); // ceiling in-band
        bond.scheduleDepositBurnBps(2, 0); // zero floor in-band
        vm.stopPrank();
    }

    function test_bond_depositFee_bounds() public {
        uint256 max = bond.BOND_DEPOSIT_FEE_BPS_MAX();
        vm.prank(executor);
        vm.expectRevert(ProvianBondPool.CostOutOfDomain.selector);
        bond.scheduleDepositFeeBps(1, max + 1);
    }

    function test_bond_renewalBurn_bounds() public {
        uint256 max = bond.BOND_RENEWAL_BURN_BPS_MAX();
        vm.prank(executor);
        vm.expectRevert(ProvianBondPool.CostOutOfDomain.selector);
        bond.scheduleRenewalBurnBps(1, max + 1);
    }

    function test_bond_renewalFee_bounds() public {
        uint256 max = bond.BOND_RENEWAL_FEE_BPS_MAX();
        vm.prank(executor);
        vm.expectRevert(ProvianBondPool.CostOutOfDomain.selector);
        bond.scheduleRenewalFeeBps(1, max + 1);
    }

    function test_bond_processingFee_bounds() public {
        uint256 max = bond.MAX_FEE();
        vm.prank(executor);
        vm.expectRevert(ProvianBondPool.CostOutOfDomain.selector);
        bond.scheduleClaimsProcessingFee(1, max + 1);
    }

    function test_bond_filingFee_bounds() public {
        uint256 max = bond.MAX_FILING_FEE();
        vm.prank(executor);
        vm.expectRevert(ProvianBondPool.CostOutOfDomain.selector);
        bond.scheduleClaimFilingFee(1, max + 1);
    }

    function test_bond_renewalPeriod_bounds() public {
        uint256 lo = bond.MIN_RENEWAL_PERIOD();
        uint256 hi = bond.MAX_RENEWAL_PERIOD();
        vm.startPrank(executor);
        vm.expectRevert(ProvianBondPool.CostOutOfDomain.selector);
        bond.scheduleRenewalPeriod(1, lo - 1);
        vm.expectRevert(ProvianBondPool.CostOutOfDomain.selector);
        bond.scheduleRenewalPeriod(1, hi + 1);
        vm.stopPrank();
    }

    function test_bond_abandonmentPeriod_bounds() public {
        uint256 lo = bond.MIN_ABANDONMENT_PERIOD();
        uint256 hi = bond.MAX_ABANDONMENT_PERIOD();
        vm.startPrank(executor);
        vm.expectRevert(ProvianBondPool.CostOutOfDomain.selector);
        bond.scheduleAbandonmentPeriod(1, lo - 1);
        vm.expectRevert(ProvianBondPool.CostOutOfDomain.selector);
        bond.scheduleAbandonmentPeriod(1, hi + 1);
        vm.stopPrank();
    }

    function test_bond_maxDeposit_bounds() public {
        uint256 lo = bond.MIN_MAX_BOND_DEPOSIT();
        uint256 hi = bond.MAX_MAX_BOND_DEPOSIT();
        vm.startPrank(executor);
        vm.expectRevert(ProvianBondPool.CostOutOfDomain.selector);
        bond.scheduleMaxBondDeposit(1, lo - 1);
        vm.expectRevert(ProvianBondPool.CostOutOfDomain.selector);
        bond.scheduleMaxBondDeposit(1, hi + 1);
        vm.stopPrank();
    }

    function test_bond_slashShares_couplingInvariants() public {
        vm.startPrank(executor);
        // sum must equal MAX_BPS
        vm.expectRevert(ProvianBondPool.SlashBpsInvariant.selector);
        bond.scheduleSlashShares(1, 3000, 6000); // sums to 9000
        // payout must be >= MIN_SLASH_PAYOUT_BPS (50%)
        vm.expectRevert(ProvianBondPool.SlashPayoutBelowFloor.selector);
        bond.scheduleSlashShares(1, 6000, 4000); // payout 4000 < 5000, sum ok
        // valid coupled pair
        bond.scheduleSlashShares(1, PROBE_SLASH_BURN, PROBE_SLASH_PAYOUT);
        vm.stopPrank();
        (bool e, uint256 b, uint256 p) = bond.activeSlashShares();
        assertFalse(e, "still inert at epoch 0");
        assertEq(b, 0);
        assertEq(p, 0);
    }

    function test_bond_baseBonds_couplingInvariants() public {
        uint256 lo = bond.MIN_BASE_BOND();
        uint256 hi = bond.MAX_BASE_BOND();
        vm.startPrank(executor);
        vm.expectRevert(ProvianBondPool.BaseBondOutOfBounds.selector);
        bond.scheduleBaseBonds(1, lo - 1, PROBE_L3); // L2 below floor
        vm.expectRevert(ProvianBondPool.BaseBondOutOfBounds.selector);
        bond.scheduleBaseBonds(1, PROBE_L2, hi + 1); // L3 above ceiling
        vm.expectRevert(ProvianBondPool.BaseBondOutOfBounds.selector);
        bond.scheduleBaseBonds(1, 5000e18, 4000e18); // L3 < L2
        bond.scheduleBaseBonds(1, PROBE_L2, PROBE_L3); // valid
        vm.stopPrank();
    }

    function test_bond_maxDeposit_rejectsBelowActiveL3() public {
        // active L3 is the 3000-PVT baseline; a cap below it must revert.
        vm.prank(executor);
        vm.expectRevert(ProvianBondPool.ParameterOutOfBounds.selector);
        bond.scheduleMaxBondDeposit(1, DEF_L3 - 1);
    }

    function test_bond_schedule_emitsEvent() public {
        vm.expectEmit(true, false, false, true, address(bond));
        emit ProvianBondPool.DepositBurnBpsScheduled(1, PROBE_DEPOSIT_BURN);
        vm.prank(executor);
        bond.scheduleDepositBurnBps(1, PROBE_DEPOSIT_BURN);
    }

    function test_bond_scheduleBaseBonds_emitsEvent() public {
        vm.expectEmit(true, false, false, true, address(bond));
        emit ProvianBondPool.BaseBondsScheduled(1, PROBE_L2, PROBE_L3);
        vm.prank(executor);
        bond.scheduleBaseBonds(1, PROBE_L2, PROBE_L3);
    }

    // ========================================================================
    // Baseline (unset == storage default) at the lifecycle reads
    // ========================================================================

    function test_bond_baseBonds_unset_getRequiredBondUsesDefaults() public view {
        assertEq(bond.getRequiredBond(2, 0), DEF_L2, "unset -> L2 750");
        assertEq(bond.getRequiredBond(3, 0), DEF_L3, "unset -> L3 3000");
    }

    function test_bond_depositShares_unset_postBondBurnsBaseline() public {
        uint256 burnedBefore = pvt.totalBurned();
        uint256 locked = _postBond(2);
        // totalDeposit = ceil(750e18 * 10000 / (10000 - 200 - 100)); burn = totalDeposit*200/10000.
        uint256 required = DEF_L2;
        uint256 rem = 10000 - DEF_DEPOSIT_BURN - DEF_DEPOSIT_FEE;
        uint256 totalDeposit = (required * 10000 + rem - 1) / rem;
        uint256 expectBurn = (totalDeposit * DEF_DEPOSIT_BURN) / 10000;
        assertEq(pvt.totalBurned() - burnedBefore, expectBurn, "unset -> 200-bps deposit burn");
        assertEq(locked, totalDeposit - expectBurn - (totalDeposit * DEF_DEPOSIT_FEE) / 10000, "locked = 97% baseline");
    }

    // ========================================================================
    // Override drives the lifecycle (per param)
    // ========================================================================

    function _openBaseBonds(uint256 l2, uint256 l3) internal {
        vm.prank(executor);
        bond.scheduleBaseBonds(1, l2, l3);
        _toEpoch(1);
    }

    function test_bond_baseBonds_override_drivesGetRequiredBond() public {
        _openBaseBonds(PROBE_L2, PROBE_L3);
        assertEq(bond.getRequiredBond(2, 0), PROBE_L2, "override drives L2");
        assertEq(bond.getRequiredBond(3, 0), PROBE_L3, "override drives L3");
        assertTrue(PROBE_L2 != DEF_L2);
    }

    function test_bond_depositBurn_override_drivesPostBondBurn() public {
        vm.prank(executor);
        bond.scheduleDepositBurnBps(1, PROBE_DEPOSIT_BURN);
        _toEpoch(1);
        uint256 burnedBefore = pvt.totalBurned();
        _postBond(2);
        uint256 rem = 10000 - PROBE_DEPOSIT_BURN - DEF_DEPOSIT_FEE;
        uint256 totalDeposit = (DEF_L2 * 10000 + rem - 1) / rem;
        uint256 expectBurn = (totalDeposit * PROBE_DEPOSIT_BURN) / 10000;
        assertEq(pvt.totalBurned() - burnedBefore, expectBurn, "override drives the deposit burn");
    }

    function test_bond_maxDeposit_override_gatesPostBond() public {
        // The cap must stay >= the active L3 lock (3000 PVT) per the scheduler's
        // invariant, but an L3 bond GROSSES above its lock (lock / 0.97 ~= 3092 PVT).
        // A cap exactly at the L3 lock (3000 PVT) therefore admits the schedule yet
        // gates the L3 bond's gross deposit -> DepositExceedsCap.
        vm.prank(executor);
        bond.scheduleMaxBondDeposit(1, DEF_L3); // 3000 PVT == active L3; below the L3 gross
        _toEpoch(1);
        vm.prank(agent);
        vm.expectRevert(ProvianBondPool.DepositExceedsCap.selector);
        bond.postBond(3, 0);
    }

    function test_bond_renewalPeriod_override_drivesRenewalDeadline() public {
        vm.prank(executor);
        bond.scheduleRenewalPeriod(1, PROBE_RENEWAL_PERIOD);
        _toEpoch(1);
        _postBond(2);
        (,,,, uint256 renewalDeadline,,) = bond.bonds(agent);
        assertEq(renewalDeadline, block.timestamp + PROBE_RENEWAL_PERIOD, "override drives the renewal deadline");
    }

    function test_bond_renewalShares_override_drivesRenewCost() public {
        _postBond(2);
        (uint256 amountBefore,,,,,,) = bond.bonds(agent);
        vm.startPrank(executor);
        bond.scheduleRenewalBurnBps(1, PROBE_RENEWAL_BURN);
        bond.scheduleRenewalFeeBps(1, PROBE_RENEWAL_FEE);
        vm.stopPrank();
        _toEpoch(1);
        vm.prank(agent);
        bond.renewBond();
        (uint256 amountAfter,,,,,,) = bond.bonds(agent);
        uint256 expectCost =
            (amountBefore * PROBE_RENEWAL_BURN) / 10000 + (amountBefore * PROBE_RENEWAL_FEE) / 10000;
        assertEq(amountBefore - amountAfter, expectCost, "override drives the renewal burn+fee");
    }

    function test_bond_filingFee_override_drivesFileClaim() public {
        _postBond(2);
        vm.prank(executor);
        bond.scheduleClaimFilingFee(1, PROBE_FILING_FEE);
        _toEpoch(1);
        bytes32 claimId = keccak256("c1");
        vm.prank(claimant);
        bond.fileClaim(agent, claimId);
        (,, uint256 filingFee,,) = bond.claims(claimId);
        assertEq(filingFee, PROBE_FILING_FEE, "override drives the charged filing fee");
        assertTrue(PROBE_FILING_FEE != DEF_FILING_FEE);
    }

    function test_bond_slashShares_override_drivesSlashSplit() public {
        _postBond(3);
        (uint256 locked,,,,,,) = bond.bonds(agent);
        vm.prank(executor);
        bond.scheduleSlashShares(1, PROBE_SLASH_BURN, PROBE_SLASH_PAYOUT);
        _toEpoch(1);

        bytes32 claimId = keccak256("slash1");
        vm.prank(claimant);
        bond.fileClaim(agent, claimId);

        // Slash the full bond via the wired court; the claimant receives payout + filing fee.
        uint256 claimantBefore = pvt.balanceOf(claimant);
        (,, uint256 filingFee,,) = bond.claims(claimId);
        vm.prank(court);
        bond.slashBond(agent, locked, claimId);
        uint256 expectPayout = (locked * PROBE_SLASH_PAYOUT) / 10000;
        assertEq(
            pvt.balanceOf(claimant) - claimantBefore, expectPayout + filingFee, "override drives the slash payout split"
        );
    }

    function test_bond_processingFee_override_drivesDismissDeduction() public {
        _postBond(2);
        (uint256 lockedBefore,,,,,,) = bond.bonds(agent);
        vm.prank(executor);
        bond.scheduleClaimsProcessingFee(1, PROBE_PROCESSING_FEE);
        _toEpoch(1);
        bytes32 claimId = keccak256("dismiss1");
        vm.prank(claimant);
        bond.fileClaim(agent, claimId);
        vm.prank(court);
        bond.dismissClaim(agent, claimId);
        (uint256 lockedAfter,,,,,,) = bond.bonds(agent);
        assertEq(lockedBefore - lockedAfter, PROBE_PROCESSING_FEE, "override drives the dismissal processing-fee deduction");
    }

    function test_bond_abandonmentPeriod_override_drivesAbandonmentTiming() public {
        _postBond(2);
        (,,,, uint256 renewalDeadline,,) = bond.bonds(agent);
        vm.prank(executor);
        bond.scheduleAbandonmentPeriod(1, PROBE_ABANDONMENT);
        _toEpoch(1);
        uint256 grace = bond.renewalGracePeriod();
        // Just before the (override) abandonment window: must still revert.
        vm.warp(renewalDeadline + grace + PROBE_ABANDONMENT - 1);
        vm.expectRevert(ProvianBondPool.GracePeriodNotExpired.selector);
        bond.processAbandonment(agent);
        // Exactly at the window: succeeds.
        vm.warp(renewalDeadline + grace + PROBE_ABANDONMENT);
        bond.processAbandonment(agent);
        (, , , , , ProvianBondPool.BondStatus status, ) = bond.bonds(agent);
        assertEq(uint256(status), uint256(ProvianBondPool.BondStatus.Abandoned));
    }

    // ========================================================================
    // Review hardening -- immutable bounds pinned to the frozen catalog
    // ========================================================================

    function test_bond_immutableBounds_matchTheFrozenCatalogRanges() public view {
        assertEq(bond.BOND_DEPOSIT_BURN_BPS_MAX(), 1000);
        assertEq(bond.BOND_DEPOSIT_FEE_BPS_MAX(), 500);
        assertEq(bond.BOND_RENEWAL_BURN_BPS_MAX(), 500);
        assertEq(bond.BOND_RENEWAL_FEE_BPS_MAX(), 250);
        assertEq(bond.MAX_FEE(), 1000e18, "processing-fee ceiling = 1000 PVT");
        assertEq(bond.MAX_FILING_FEE(), 500e18, "filing-fee ceiling = 500 PVT");
        assertEq(bond.MIN_RENEWAL_PERIOD(), 30 days);
        assertEq(bond.MAX_RENEWAL_PERIOD(), 365 days);
        assertEq(bond.MIN_ABANDONMENT_PERIOD(), 90 days);
        assertEq(bond.MAX_ABANDONMENT_PERIOD(), 730 days);
        assertEq(bond.MIN_BASE_BOND(), 100e18);
        assertEq(bond.MAX_BASE_BOND(), 50000e18);
        assertEq(bond.MIN_MAX_BOND_DEPOSIT(), 1000e18);
        assertEq(bond.MAX_MAX_BOND_DEPOSIT(), 250000e18);
        assertEq(bond.MIN_SLASH_PAYOUT_BPS(), 5000);
    }
}
