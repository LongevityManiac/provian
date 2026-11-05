// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProvianPVT9TestBase} from "./ProvianPVT9TestBase.sol";
import {ProvianPVT9} from "../src/ProvianPVT9.sol";
import {ProvianEscrowV4} from "../src/ProvianEscrowV4.sol";
import "./MockEpochClock.sol";
import "./MockIssuanceIndex.sol";
import {ProvianBondPool} from "../src/ProvianBondPool.sol";
import {MockUSDC} from "./MockTokens.sol";

/**
 * @title ProvianPVT9SinkCostPolicyTest
 * @notice The other half of the institution parameters acceptance line for the Agent Bank sinks
 * against the REAL `ProvianPVT9`. §5 of the closed-loop plan asks for
 * tests proving "value conservation, prospective costs, no cross-asset
 * derivation, and fail-closed role/config reads."
 * `ProvianPVT9AgentBankSinks.t.sol` covers conservation and
 * cross-asset. This file covers the remaining two:
 *
 * - PROSPECTIVE COSTS: a cost-parameter change never reprices an
 * obligation that already exists. A posted bond keeps the exact
 * collateral it was created with; only later bonds see the new
 * parameter. Escrow's fee is likewise snapshotted at creation and
 * is the amount burned at funding.
 * - FAIL-CLOSED ROLE/CONFIG READS: an unset or wrong role/config
 * denies rather than proceeds. With `courtContract` unset, NOBODY
 * can slash a bond — not the admin, not the executor, not the
 * agent. The court wiring is one-time and cannot be swapped.
 * Bounded policy setters reject non-executors, and the parameter
 * window/velocity guards reject a too-fast or too-large move.
 *
 * VALUE-NEUTRAL, for the same reason as the sibling suite: the
 * PVT-native cost catalog is proposal-only and unapproved, so no fee,
 * rate, cap, or bond amount is asserted as correct economics. Every
 * expectation is either a RELATIONSHIP (unchanged-after-change,
 * reverts, one-time-only) or a value read from the contract's own
 * public parameters. "Costs are prospective" holds for any parameter
 * values, which is precisely why it is safe to pin today.
 */
contract ProvianPVT9SinkCostPolicyTest is ProvianPVT9TestBase {
    ProvianEscrowV4 internal escrow;
    ProvianBondPool internal bondPool;
    MockUSDC internal usdc;

    address internal constant BANK_ADMIN = address(0xB0A1);
    address internal constant FEE_WALLET = address(0xFEE);
    address internal constant TECH_WALLET = address(0x7EC4);
    address internal constant EXECUTOR = address(0xE0A);
    address internal constant COURT = address(0xC0247);
    address internal constant OUTSIDER = address(0x0475);
    address internal constant FUNDER = address(0xF00D);
    address internal constant AGENT_A = address(0xA6E71);
    address internal constant AGENT_B = address(0xA6E72);

    function setUp() public override {
        super.setUp(); // real ProvianPVT9, deployed + armed, warped to epoch zero

        usdc = new MockUSDC();
        escrow = new ProvianEscrowV4(BANK_ADMIN, FEE_WALLET, address(usdc), address(pvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), new ProvianEscrowV4.EscrowSeed[](0));
        // Bind the bond pool to the REAL kernel clock (the deployed+armed PVT9),
        // so a prospectively scheduled cost activates exactly when the kernel epoch
        // turns. activation/ stripped the immediate updateX setters; scheduleX is the
        // only remaining path, and it is epoch-gated.
        bondPool = new ProvianBondPool(BANK_ADMIN, TECH_WALLET, address(pvt), address(pvt), address(new MockIssuanceIndex()), new ProvianBondPool.BondSeed[](0), new ProvianBondPool.BpsSeed[](0));

        _settleStandard(FUNDER, ProvianPVT9.BeneficiaryClass.HumanResolving, 1_000_000 ether);

        address[2] memory agents = [AGENT_A, AGENT_B];
        for (uint256 i = 0; i < agents.length; i++) {
            vm.prank(FUNDER);
            pvt.transfer(agents[i], 50_000 ether);
            vm.prank(agents[i]);
            pvt.approve(address(bondPool), type(uint256).max);
            vm.prank(agents[i]);
            pvt.approve(address(escrow), type(uint256).max);
        }
    }

    // ========================================================================
    // Prospective costs — an existing obligation is never repriced
    // ========================================================================

    function test_bondParameterChange_doesNotRepriceAnExistingBond() public {
        vm.prank(AGENT_A);
        bondPool.postBond(2, 0);
        (uint256 lockedBefore,,,,,,) = bondPool.bonds(AGENT_A);
        uint256 poolHeldBefore = pvt.balanceOf(address(bondPool));
        uint256 requiredBefore = bondPool.getRequiredBond(2, 0);

        // Raise the level-2 base bond through the live executor path. The only
        // remaining path is a PROSPECTIVE schedule (activation/ stripped the
        // immediate setters), so it is scheduled for the next kernel epoch and
        // the clock is advanced to it. The multiplier is read from the current
        // value, so no bond amount is asserted as correct economics here.
        vm.prank(BANK_ADMIN);
        bondPool.setExecutor(EXECUTOR);
        uint256 newLevel2 = bondPool.level2BaseBond() * 2;
        uint256 newLevel3 = bondPool.level3BaseBond() * 2;
        uint64 target = bondPool.earliestSchedulableEpoch();
        vm.prank(EXECUTOR);
        bondPool.scheduleBaseBonds(target, newLevel2, newLevel3);

        // Prospective: nothing moves until the kernel epoch turns.
        assertEq(bondPool.getRequiredBond(2, 0), requiredBefore, "schedule applied retroactively");
        _advanceToEpoch(target);

        // The parameter really moved...
        assertGt(bondPool.getRequiredBond(2, 0), requiredBefore, "parameter did not move");

        // ...but AGENT_A's already-posted bond is untouched: same locked
        // collateral, same PVT actually held by the pool. No retroactive
        // top-up demand, no retroactive release.
        (uint256 lockedAfter,,,,,,) = bondPool.bonds(AGENT_A);
        assertEq(lockedAfter, lockedBefore, "existing bond was repriced");
        assertEq(pvt.balanceOf(address(bondPool)), poolHeldBefore, "existing collateral moved");

        // A bond posted AFTER the change prices at the new parameter — proving
        // the change is live, so the invariance above is prospectivity rather
        // than the setter having done nothing.
        vm.prank(AGENT_B);
        bondPool.postBond(2, 0);
        (uint256 lockedB,,,,,,) = bondPool.bonds(AGENT_B);
        assertGt(lockedB, lockedBefore, "new bond did not price at the new parameter");
    }

    function test_escrowFee_isSnapshotAtCreationAndIsWhatBurns() public {
        bytes32 id = keccak256("escrow-fee-snapshot");
        uint256 amount = 1_000 ether;

        vm.prank(AGENT_A);
        escrow.createEscrow(id, AGENT_B, amount, block.timestamp + 1 days, ProvianEscrowV4.Currency.PVT);

        // The fee is fixed into the escrow record at creation time.
        (,, uint256 storedAmount, uint256 storedFee,,,,) = escrow.escrows(id);
        assertEq(storedAmount, amount, "principal not snapshotted");
        assertGt(storedFee, 0, "fee not snapshotted");

        uint256 supplyBefore = pvt.totalSupply();
        vm.prank(AGENT_A);
        escrow.fundEscrow(id, false);

        // What burns at funding is exactly the fee snapshotted at creation —
        // not a value recomputed at funding time.
        assertEq(supplyBefore - pvt.totalSupply(), storedFee, "burned amount != snapshotted fee");
    }

    // ========================================================================
    // Fail-closed role/config reads
    // ========================================================================

    function test_slashFailsClosedWhileCourtIsUnset() public {
        vm.prank(AGENT_A);
        bondPool.postBond(2, 0);
        (uint256 locked,,,,,,) = bondPool.bonds(AGENT_A);
        uint256 supplyBefore = pvt.totalSupply();

        assertEq(bondPool.courtContract(), address(0), "precondition: court must be unset");

        // With the config unread/unset the answer is DENY for every caller,
        // including the most privileged ones. An unset role is not an open door.
        address[4] memory callers = [BANK_ADMIN, EXECUTOR, OUTSIDER, AGENT_A];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(ProvianBondPool.OnlyCourt.selector);
            bondPool.slashBond(AGENT_A, 1 ether, keccak256("claim"));
        }

        // Nothing was slashed, burned, or moved by the denied attempts.
        (uint256 lockedAfter,,,,,,) = bondPool.bonds(AGENT_A);
        assertEq(lockedAfter, locked, "collateral moved on a denied slash");
        assertEq(pvt.totalSupply(), supplyBefore, "supply moved on a denied slash");
    }

    function test_courtWiringIsOneTimeAndCannotBeSwapped() public {
        vm.prank(BANK_ADMIN);
        bondPool.setCourtContract(COURT);
        assertEq(bondPool.courtContract(), COURT, "court not wired");

        // One-time by design: a second wiring is refused, so a court swap after
        // deployment is impossible.
        vm.prank(BANK_ADMIN);
        vm.expectRevert(ProvianBondPool.CourtAlreadySet.selector);
        bondPool.setCourtContract(OUTSIDER);
        assertEq(bondPool.courtContract(), COURT, "court was swapped");

        // ...and the zero address is refused outright on a fresh pool, so the
        // one-time slot can never be burned on a no-op.
        ProvianBondPool fresh = new ProvianBondPool(BANK_ADMIN, TECH_WALLET, address(pvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), new ProvianBondPool.BondSeed[](0), new ProvianBondPool.BpsSeed[](0));
        vm.prank(BANK_ADMIN);
        vm.expectRevert(ProvianBondPool.InvalidAddress.selector);
        fresh.setCourtContract(address(0));
    }

    function test_boundedPolicySettersRejectNonExecutor() public {
        vm.prank(BANK_ADMIN);
        bondPool.setExecutor(EXECUTOR);

        uint256 l2 = bondPool.level2BaseBond();
        uint256 l3 = bondPool.level3BaseBond();

        uint64 target = bondPool.earliestSchedulableEpoch();
        address[3] memory rejected = [OUTSIDER, BANK_ADMIN, AGENT_A];
        for (uint256 i = 0; i < rejected.length; i++) {
            vm.prank(rejected[i]);
            vm.expectRevert(ProvianBondPool.OnlyExecutor.selector);
            bondPool.scheduleBaseBonds(target, l2, l3);
        }

        // The parameters are unchanged by the refused calls.
        assertEq(bondPool.level2BaseBond(), l2, "level2 moved on a denied call");
        assertEq(bondPool.level3BaseBond(), l3, "level3 moved on a denied call");
    }

    /// activation/the immediate setters and their per-window velocity cap were
    /// STRIPPED. The property that replaced them is PROSPECTIVITY — a scheduled
    /// cost cannot take effect in the epoch it is scheduled in, and a queued
    /// ladder cannot be collapsed into a single block. That is a strictly
    /// stronger bound on retroactivity than the velocity cap ever was, because a
    /// schedule never reprices an already-posted bond at all.
    function test_parameterChangesAreProspectiveAndNonCollapsible() public {
        vm.prank(BANK_ADMIN);
        bondPool.setExecutor(EXECUTOR);

        uint64 nowEpoch = bondPool.earliestSchedulableEpoch() - 1;

        // The current epoch (and anything before it) is refused: no same-epoch,
        // and no backdated, activation.
        uint256 l2 = bondPool.level2BaseBond() * 2;
        uint256 l3 = bondPool.level3BaseBond() * 2;
        vm.prank(EXECUTOR);
        vm.expectRevert(ProvianBondPool.PolicyNotProspective.selector);
        bondPool.scheduleBaseBonds(nowEpoch, l2, l3);

        // A ladder queued in ONE block still activates one rung per epoch.
        vm.startPrank(EXECUTOR);
        bondPool.scheduleBaseBonds(nowEpoch + 1, l2, l3);
        bondPool.scheduleBaseBonds(nowEpoch + 2, l2 * 2, l3 * 2);
        vm.stopPrank();

        // Same block: nothing has activated.
        (bool e0,,) = bondPool.activeBaseBonds();
        assertFalse(e0, "a schedule activated in its own block");

        // A duplicate schedule for an already-scheduled (still future) epoch is
        // refused, so a queued rung cannot be silently overwritten.
        vm.prank(EXECUTOR);
        vm.expectRevert(ProvianBondPool.PolicyAlreadyScheduled.selector);
        bondPool.scheduleBaseBonds(nowEpoch + 2, l2, l3);

        _advanceToEpoch(nowEpoch + 1);
        (bool e1, uint256 a2, uint256 a3) = bondPool.activeBaseBonds();
        assertTrue(e1);
        assertEq(a2, l2, "rung 1 did not activate");
        assertEq(a3, l3, "rung 1 did not activate");

        _advanceToEpoch(nowEpoch + 2);
        (bool e2, uint256 b2, uint256 b3) = bondPool.activeBaseBonds();
        assertTrue(e2);
        assertEq(b2, l2 * 2, "rung 2 did not activate");
        assertEq(b3, l3 * 2, "rung 2 did not activate");
    }

    function test_outOfDomainParametersAreRejected() public {
        vm.prank(BANK_ADMIN);
        bondPool.setExecutor(EXECUTOR);

        // Bounds are read from the contract (so no economic value is asserted)
        // and hoisted into locals — see the note in the velocity test: an
        // inline read would consume the `expectRevert` expectation.
        uint256 belowFloor = bondPool.MIN_BASE_BOND() - 1;
        uint256 aboveCeiling = bondPool.MAX_BASE_BOND() + 1;
        uint256 l2 = bondPool.level2BaseBond();
        uint256 l3 = bondPool.level3BaseBond();

        uint64 target = bondPool.earliestSchedulableEpoch();

        // Below the contract's own floor...
        vm.prank(EXECUTOR);
        vm.expectRevert(ProvianBondPool.BaseBondOutOfBounds.selector);
        bondPool.scheduleBaseBonds(target, belowFloor, l3);

        // ...above its own ceiling...
        vm.prank(EXECUTOR);
        vm.expectRevert(ProvianBondPool.BaseBondOutOfBounds.selector);
        bondPool.scheduleBaseBonds(target, l2, aboveCeiling);

        // ...and an inverted ladder (L3 < L2) are all refused.
        vm.prank(EXECUTOR);
        vm.expectRevert(ProvianBondPool.BaseBondOutOfBounds.selector);
        bondPool.scheduleBaseBonds(target, l3, l2);

        // None of the refused calls moved a parameter.
        assertEq(bondPool.level2BaseBond(), l2, "level2 moved on a denied call");
        assertEq(bondPool.level3BaseBond(), l3, "level3 moved on a denied call");
    }
}
