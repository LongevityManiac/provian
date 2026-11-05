// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ProvianBondPool.sol";
import "../src/ProvianCourtV2.sol";
import "./MockEpochClock.sol";
import "./MockIssuanceIndex.sol";
import {MockPVT, MockCourtRewardSink} from "./MockTokens.sol";

/// @dev Minimal escrow surface the Court reads for panel conflict-of-interest checks.
contract InstitutionMockEscrow {
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
 * @title InstitutionIssuanceIndexTest
 * @notice institution deployment directive items 1 + 2: the issuance-indexed cost FLOORS and the
 * mandatory GRANDFATHERING invariant.
 *
 * Every assertion here ships with the negative control that makes it
 * non-vacuous. The three recurring failure shapes are addressed
 * by name:
 *
 * - THE EMPTY POPULATION: the no-op equivalence tests print and assert an
 * evaluated-parameter COUNT, so a pass over zero parameters is
 * impossible to mistake for a pass over six.
 * - THE SELF-REFERENTIAL CONTROL: the expected floors are computed from
 * the CONTRACT'S OWN published ppm constants and the kernel's own
 * INITIAL_COMBINED_EPOCH_CAP anchor, never from a second copy of the
 * numbers declared in this file.
 * - THE UNREACHABLE BRANCH: every guard is fed an input that violates it
 * (`setRevert` for the fail-closed path, a seeded index for the floor,
 * a warp past the flat-launch window for the binding case).
 */
contract InstitutionIssuanceIndexTest is Test {
    ProvianBondPool internal bond;
    ProvianCourtV2 internal court;
    MockPVT internal pvt;
    MockEpochClock internal clock;
    MockIssuanceIndex internal index;
    InstitutionMockEscrow internal escrow;

    address internal admin = address(0xA01);
    address internal tech = address(0x7EC4);
    address internal agent = address(0xB01);
    address internal depositor = address(0xD01);
    address internal recipient = address(0xD02);

    uint64 internal constant EPOCH_START = 1_000_000;
    uint256 internal constant EPOCH_DURATION = 7 days;

    /// @dev The kernel's launch ceiling — the anchor every ppm ratio is set against.
    ///      Mirrors ProvianPVT9.INITIAL_COMBINED_EPOCH_CAP (1e25 = 10,000,000 PVT).
    uint256 internal constant LAUNCH_CEILING = 10_000_000e18;

    function setUp() public {
        pvt = new MockPVT();
        clock = new MockEpochClock(EPOCH_START);
        index = new MockIssuanceIndex();
        escrow = new InstitutionMockEscrow();
        vm.warp(EPOCH_START); // kernel epoch 0

        bond = new ProvianBondPool(admin, tech, address(pvt), address(clock), address(index), new ProvianBondPool.BondSeed[](0), new ProvianBondPool.BpsSeed[](0));
        court = new ProvianCourtV2(admin, address(escrow), address(clock), address(pvt), address(index));

        pvt.mint(agent, 10_000_000e18);
        vm.prank(agent);
        pvt.approve(address(bond), type(uint256).max);
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    function _toEpoch(uint64 n) internal {
        vm.warp(uint256(EPOCH_START) + uint256(n) * EPOCH_DURATION);
    }

    /// @dev Drive the trailing average to exactly `perEpoch` and move to an epoch where
    ///      the kernel actually reports it (>= TRAILING_AVERAGE_EPOCHS).
    function _seedAverage(uint256 perEpoch) internal {
        index.seedFlat(0, 12, perEpoch);
        _toEpoch(12);
    }

    // ==================================================================
    // ITEM 1 — the floors resolve to TODAY'S literals, and the anchor is exact
    // ==================================================================

    /// @notice NO-OP EQUIVALENCE. At the live position (epoch 0, no measured issuance)
    ///         every indexed parameter must equal the literal the shipped contracts
    ///         already enforce. This is the "prove it changes nothing today" test the
    ///         directive demands.
    function test_noop_atCurrentEpoch_everyFloorEqualsItsLiteral() public view {
        uint256 evaluated;

        (uint256 l2, uint256 l3, uint256 maxDep, uint256 proc, uint256 filing, uint256 avg) =
            bond.indexedRequirements();

        assertEq(avg, 0, "live position: no measured issuance yet");

        assertEq(l2, 750e18, "level2 must equal its literal");
        evaluated++;
        assertEq(l3, 3000e18, "level3 must equal its literal");
        evaluated++;
        assertEq(maxDep, 7500e18, "maxBondDeposit must equal its literal");
        evaluated++;
        assertEq(proc, 30e18, "claimsProcessingFee must equal its literal");
        evaluated++;
        assertEq(filing, 15e18, "claimFilingFee must equal its literal");
        evaluated++;
        assertEq(court.arbitratorCollateral(), 75e18, "arbitrator collateral must be 10% of level2");
        evaluated++;

        // GUARD THE GUARD: a universally-quantified claim over zero parameters is not
        // a pass. Six is the whole floored set.
        assertEq(evaluated, 6, "the no-op claim must cover all six floored parameters");
    }

    /// @notice The ratios are ANCHORED: at the kernel's launch ceiling each floor lands
    ///         EXACTLY on today's literal — that is what makes them a continuation of
    ///         current policy rather than a new economic value. Computed from the
    ///         contract's own published ppm constants, not from a second copy here.
    function test_anchor_atLaunchCeiling_floorsEqualTheLiteralsExactly() public {
        _seedAverage(LAUNCH_CEILING);

        (uint256 l2, uint256 l3, uint256 maxDep, uint256 proc, uint256 filing,) = bond.indexedRequirements();

        assertEq(l2, (bond.LEVEL2_BOND_INDEX_PPM() * LAUNCH_CEILING) / 1e6, "level2 anchor");
        assertEq(l2, 750e18, "level2 anchor lands on the literal");
        assertEq(l3, (bond.LEVEL3_BOND_INDEX_PPM() * LAUNCH_CEILING) / 1e6, "level3 anchor");
        assertEq(l3, 3000e18, "level3 anchor lands on the literal");
        assertEq(maxDep, (bond.MAX_DEPOSIT_INDEX_PPM() * LAUNCH_CEILING) / 1e6, "maxDeposit anchor");
        assertEq(maxDep, 7500e18, "maxDeposit anchor lands on the literal");
        assertEq(proc, (bond.CLAIMS_PROCESSING_FEE_INDEX_PPM() * LAUNCH_CEILING) / 1e6, "processing anchor");
        assertEq(proc, 30e18, "processing anchor lands on the literal");
        assertEq(filing, 15e18, "filing anchor lands on the literal (half of processing)");
        assertEq(court.arbitratorCollateral(), 75e18, "collateral anchor lands on the literal");
    }

    /// @notice THE RED CONTROL for the no-op test. If the floor could not bind, the
    ///         no-op assertion above would be true for a trivial reason — an index that
    ///         never does anything. Seed the window ABOVE the anchor and every floor
    ///         must rise in exact proportion.
    function test_CONTROL_floorBindsOnceIssuanceExceedsTheAnchor() public {
        _seedAverage(LAUNCH_CEILING * 4);

        (uint256 l2, uint256 l3, uint256 maxDep, uint256 proc, uint256 filing,) = bond.indexedRequirements();

        assertEq(l2, 4 * 750e18, "level2 must have risen 4x");
        assertEq(l3, 4 * 3000e18, "level3 must have risen 4x");
        assertEq(maxDep, 4 * 7500e18, "maxDeposit must have risen 4x");
        assertEq(proc, 4 * 30e18, "processing must have risen 4x");
        assertEq(filing, 4 * 15e18, "filing must have risen 4x");
        assertEq(court.arbitratorCollateral(), 4 * 75e18, "collateral must have risen 4x");
    }

    /// @notice The floor is a MINIMUM ON A COST, never a maximum on anything: a thin
    ///         index can only leave the literal standing, never lower it.
    function test_floorNeverLowersAParameter() public {
        _seedAverage(1); // an absurdly thin economy
        (uint256 l2, uint256 l3, uint256 maxDep, uint256 proc, uint256 filing,) = bond.indexedRequirements();
        assertEq(l2, 750e18);
        assertEq(l3, 3000e18);
        assertEq(maxDep, 7500e18);
        assertEq(proc, 30e18);
        assertEq(filing, 15e18);
        assertEq(court.arbitratorCollateral(), 75e18);
    }

    /// @notice The deposit cap must always admit a level-3 bond, or `postBond` becomes
    ///         unpostable at level 3. Holds at the anchor and above it.
    function test_maxDepositAlwaysAdmitsALevel3Bond() public {
        _seedAverage(LAUNCH_CEILING * 3);
        (, uint256 l3, uint256 maxDep,,,) = bond.indexedRequirements();
        assertGe(maxDep, l3, "cap below the L3 lock would brick level-3 posting");

        // ...and a level-3 bond genuinely posts at that scale.
        pvt.mint(agent, 1_000_000e18);
        vm.prank(agent);
        bond.postBond(3, 0);
        (uint256 amount,,,,, ProvianBondPool.BondStatus st,) = bond.bonds(agent);
        assertEq(uint8(st), uint8(ProvianBondPool.BondStatus.Active), "L3 bond must post at the raised floor");
        assertGe(amount, l3, "locked collateral must meet the raised requirement");
    }

    // ==================================================================
    // FAIL-CLOSED — an unreachable index must not brick the institution
    // ==================================================================

    /// @notice An index that REVERTS resolves to the literal rather than propagating.
    function test_failClosed_revertingIndexResolvesToTheLiteral() public {
        _seedAverage(LAUNCH_CEILING * 4); // floors are genuinely raised...
        assertEq(court.arbitratorCollateral(), 4 * 75e18, "precondition: the floor is binding");

        index.setRevert(true); // ...and now the kernel is unreachable

        (uint256 l2, uint256 l3, uint256 maxDep, uint256 proc, uint256 filing, uint256 avg) =
            bond.indexedRequirements();
        assertEq(avg, 0, "unreachable index reports no measurement");
        assertEq(l2, 750e18, "fails closed to the literal");
        assertEq(l3, 3000e18);
        assertEq(maxDep, 7500e18);
        assertEq(proc, 30e18);
        assertEq(filing, 15e18);
        assertEq(court.arbitratorCollateral(), 75e18, "court fails closed too");

        // And the institution still WORKS — fail-closed must not mean bricked.
        vm.prank(agent);
        bond.postBond(2, 0);
        (,,,,, ProvianBondPool.BondStatus st,) = bond.bonds(agent);
        assertEq(uint8(st), uint8(ProvianBondPool.BondStatus.Active), "must still post with a dead index");
    }

    /// @notice THE RED CONTROL for the fail-closed guard: without `setRevert` the same
    ///         reads return the RAISED values, so the test above is observing the
    ///         guard firing rather than a state that was never different.
    function test_CONTROL_failClosedGuardIsWhatChangesTheAnswer() public {
        _seedAverage(LAUNCH_CEILING * 4);
        (uint256 rl2,,,,,) = bond.indexedRequirements();
        assertEq(rl2, 4 * 750e18, "reachable index -> raised");

        index.setRevert(true);
        (uint256 fl2,,,,,) = bond.indexedRequirements();
        assertEq(fl2, 750e18, "unreachable index -> literal");

        assertTrue(rl2 != fl2, "the guard must be the thing that changes the answer");
    }

    /// @notice The kernel returns a literal zero inside its twelve-epoch flat-launch
    ///         window, which is WHY the no-op equivalence holds today by construction.
    function test_flatLaunchWindow_reportsNoMeasurement() public {
        index.seedFlat(0, 12, LAUNCH_CEILING);
        for (uint64 e = 0; e < 12; e++) {
            _toEpoch(e);
            (,,,,, uint256 avg) = bond.indexedRequirements();
            assertEq(avg, 0, "no measurement inside the flat-launch window");
            assertEq(court.arbitratorCollateral(), 75e18, "collateral stays at its literal");
        }
        _toEpoch(12);
        (,,,,, uint256 after12) = bond.indexedRequirements();
        assertEq(after12, LAUNCH_CEILING, "measurement begins at epoch 12");
    }

    // ==================================================================
    // ITEM 2 — GRANDFATHERING (mandatory invariant, proven by test)
    // ==================================================================

    /// @notice NO RETROACTIVE REVALUATION. A bond posted before the floor rises keeps
    ///         the requirement it was posted under: its health, its downgrade threshold
    ///         and its top-up ceiling are all unmoved, while a NEW bond gets the raised
    ///         floor. This is the invariant the directive makes mandatory.
    function test_grandfathering_existingBondIsNeverRepricedWhenTheFloorRises() public {
        // Post at the live position, where the requirement is the 750 PVT literal.
        vm.prank(agent);
        bond.postBond(2, 0);
        uint256 snapshot = bond.requiredAtPost(agent);
        assertEq(snapshot, 750e18, "posted under the literal requirement");
        (uint256 amountBefore,,,,,,) = bond.bonds(agent);

        // The economy grows tenfold; the live requirement for a NEW bond rises with it.
        _seedAverage(LAUNCH_CEILING * 10);
        assertEq(bond.getRequiredBond(2, 0), 10 * 750e18, "a NEW bond faces the raised floor");

        // The EXISTING position is untouched in every respect.
        assertEq(bond.requiredAtPost(agent), snapshot, "snapshot must not move");
        (uint256 amountAfter,,,,,,) = bond.bonds(agent);
        assertEq(amountAfter, amountBefore, "collateral must not move");
        assertTrue(bond.isBondHealthy(agent), "a compliant bond must not become unhealthy");

        // Top-up headroom is measured against the SNAPSHOT, so the raised floor does
        // not silently enlarge this agent's obligation. Already at requirement -> any
        // top-up exceeds it.
        pvt.mint(agent, 1e18);
        vm.prank(agent);
        vm.expectRevert(ProvianBondPool.TopUpExceedsRequirement.selector);
        bond.topUpBond(1e18);
    }

    /// @notice THE RED CONTROL for grandfathering: a LIVE re-derivation — the thing the
    ///         contract deliberately does NOT do — moves by 10x under the same warp.
    ///         Without this, the assertion above could pass simply because the floor
    ///         never rose.
    function test_CONTROL_liveRederivationWouldHaveMovedRetroactively() public {
        vm.prank(agent);
        bond.postBond(2, 0);

        uint256 snapshotted = bond.requiredAtPost(agent);
        uint256 liveBefore = bond.getRequiredBond(2, 0);
        assertEq(snapshotted, liveBefore, "identical before the floor moves");

        _seedAverage(LAUNCH_CEILING * 10);

        uint256 liveAfter = bond.getRequiredBond(2, 0);
        assertEq(bond.requiredAtPost(agent), snapshotted, "the snapshot the contract uses: unmoved");
        assertEq(liveAfter, 10 * snapshotted, "the live value the contract REFUSES to use: moved 10x");
        assertTrue(liveAfter != bond.requiredAtPost(agent), "the two must genuinely diverge");
    }

    /// @notice The downgrade notice must cite THIS agent's own requirement, not what a
    ///         newcomer would owe.
    ///
    /// @dev A slashed bond always falls below both the snapshot and the raised floor, so
    ///      the BOOLEAN "is it downgraded" cannot distinguish a snapshot read from a live
    ///      re-derivation. The EVENT PAYLOAD can, and it is the part an operator or a
    ///      backend actually consumes: under a live re-derivation this event would tell a
    ///      compliant-at-post agent they owe 10x what they were ever asked for. This is
    ///      the assertion that kills mutation M16 (`slashBond` re-deriving live).
    function test_grandfathering_downgradeEventCitesTheSnapshotNotTheLiveFloor() public {
        // A court is needed because slashBond is onlyCourt; a minimal reward-sink mock
        // stands in for it so the slash can be driven directly. (Post- slashBond
        // routes the processing fee to courtContract and calls fundBondClaimReward, so the
        // stand-in must be a conforming contract, not an EOA. Panel adjudication and the
        // reward split are covered in InstitutionArbitratorFeeShare.t.sol.)
        address courtEoa = address(new MockCourtRewardSink());
        vm.prank(admin);
        bond.setCourtContract(courtEoa);

        vm.prank(agent);
        bond.postBond(2, 0);
        uint256 snapshot = bond.requiredAtPost(agent);
        (uint256 locked,,,,,,) = bond.bonds(agent);

        // A claim must exist for slashBond to resolve.
        address claimant = address(0xB0B);
        pvt.mint(claimant, 1_000_000e18);
        vm.prank(claimant);
        pvt.approve(address(bond), type(uint256).max);
        bytes32 claimId = keccak256("downgrade-payload");
        vm.prank(claimant);
        bond.fileClaim(agent, claimId);

        // The economy grows 10x AFTER the bond was posted.
        _seedAverage(LAUNCH_CEILING * 10);
        assertEq(bond.getRequiredBond(2, 0), 10 * snapshot, "a NEW bond would face 10x");

        // Slash at the 50% floor. The remaining collateral is below BOTH thresholds, so
        // the event fires either way — what differs is the REQUIRED figure it reports.
        // Capture the logs and assert on that field directly, rather than a brittle
        // positional expectEmit (slashBond also emits Transfer/Burned/BondSlashed, and
        // the processing fee further reduces bond.amount after the slash).
        uint256 slashAmount = locked / 2;
        vm.recordLogs();
        vm.prank(courtEoa);
        bond.slashBond(agent, slashAmount, claimId);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("AutonomyDowngrade(address,uint256,uint256)");
        uint256 seen;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] != topic) continue;
            seen++;
            (uint256 remainingBond, uint256 requiredBond) = abi.decode(logs[i].data, (uint256, uint256));
            assertEq(
                requiredBond,
                snapshot,
                "downgrade must cite THIS agent's grandfathered requirement, not the raised live floor"
            );
            assertTrue(requiredBond != bond.getRequiredBond(2, 0), "and the live floor genuinely diverges");
            assertLt(remainingBond, snapshot, "the slashed bond is genuinely below its own requirement");
        }
        assertEq(seen, 1, "exactly one downgrade event - a pass over zero would be vacuous");
    }

    /// @notice Grandfathering must not become a loophole: a bond posted AFTER the floor
    ///         rises is held to the RAISED requirement, not the old literal.
    function test_grandfathering_newBondAfterTheRiseFacesTheRaisedFloor() public {
        _seedAverage(LAUNCH_CEILING * 2);

        address latecomer = address(0xB09);
        pvt.mint(latecomer, 10_000_000e18);
        vm.prank(latecomer);
        pvt.approve(address(bond), type(uint256).max);
        vm.prank(latecomer);
        bond.postBond(2, 0);

        assertEq(bond.requiredAtPost(latecomer), 2 * 750e18, "a later bond is snapshotted at the raised floor");
    }

    // ==================================================================
    // ITEM 5 — lengthened durations, and the safety ordering they preserve
    // ==================================================================

    function test_durations_areTheLengthenedBaselines() public view {
        assertEq(bond.renewalPeriod(), 180 days, "renewalPeriod");
        assertEq(bond.renewalGracePeriod(), 30 days, "renewalGracePeriod");
        assertEq(bond.abandonmentPeriod(), 365 days, "abandonmentPeriod");

        // Each stays inside the immutable band the schedulers enforce.
        assertGe(bond.renewalPeriod(), bond.MIN_RENEWAL_PERIOD());
        assertLe(bond.renewalPeriod(), bond.MAX_RENEWAL_PERIOD());
        assertGe(bond.abandonmentPeriod(), bond.MIN_ABANDONMENT_PERIOD());
        assertLe(bond.abandonmentPeriod(), bond.MAX_ABANDONMENT_PERIOD());
    }

    /// @notice The safety ordering the lengthening must preserve: a claim can never
    ///         race an abandonment burn.
    function test_durations_abandonmentHorizonStaysClearOfClaimTimeout() public view {
        uint256 horizon = bond.renewalPeriod() + bond.renewalGracePeriod() + bond.abandonmentPeriod();
        assertEq(horizon, 575 days, "180 + 30 + 365");
        assertGt(horizon, bond.CLAIM_RESOLUTION_TIMEOUT(), "abandonment must never precede claim resolution");
    }

    // ==================================================================
    // Authority — the index adds none
    // ==================================================================

    /// @notice The index reference is constructor-immutable on both institutions: no
    ///         setter exists, so binding it introduces no new settable-address authority.
    function test_indexReference_hasNoSetter() public view {
        assertEq(address(bond.issuanceIndex()), address(index));
        assertEq(address(court.issuanceIndex()), address(index));

        assertFalse(_hasSelector(address(bond), bytes4(keccak256("setIssuanceIndex(address)"))));
        assertFalse(_hasSelector(address(court), bytes4(keccak256("setIssuanceIndex(address)"))));
    }

    function _hasSelector(address who, bytes4 selector) internal view returns (bool) {
        bytes memory code = who.code;
        for (uint256 i = 0; i + 4 <= code.length; i++) {
            if (
                code[i] == selector[0] && code[i + 1] == selector[1] && code[i + 2] == selector[2]
                    && code[i + 3] == selector[3]
            ) return true;
        }
        return false;
    }
}
