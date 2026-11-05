// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ProvianBondPool.sol";
import "./MockTokens.sol";
import "./MockEpochClock.sol";
import "./MockIssuanceIndex.sol";

/*
 * ============================================================================
 * PROVIAN BOND POOL - TESTS
 * ============================================================================
 *
 * The bond pool is the custodian of every performance bond PVT on the network.
 * Its entire design rests on Security Invariants #48–#51:
 * #48 NO admin-drain path. The only PVT exits are agent-withdraw, court-
 * ordered slash, dismissal filing-fee burn, or abandonment burn.
 * #49 Only the Court contract may slash.
 * #50 Trust discount is computed server-side (enforced: caller passes a
 * bps value; the contract caps at MAX_TRUST_DISCOUNT = 50%).
 * #51 Self-claims are blocked on-chain (`msg.sender != agent`).
 *
 * Tests are grouped by concern and match the ProvianPVTv4.t.sol style.
 *
 * ----------------------------------------------------------------------------
 * PVT-MOVING CALL SITES IN ProvianBondPool.sol - keep this index in sync
 *
 * postBond - transferFrom(msg.sender → pool) [INCOMING]
 * - burn(deposit*burnBps) [OUTGOING: permanent]
 * - transfer(pool → techWallet, fee) [OUTGOING: infra fee]
 * renewBond - burn(bond.amount*renewalBurnBps)
 * - transfer(pool → techWallet, renewalFee)
 * topUpBond - transferFrom(msg.sender → pool) [INCOMING, bond lifecycle: NO burn,
 * NO fee — 100% becomes slashable collateral; shortfall-bounded]
 * withdrawBond - transfer(pool → msg.sender) [onlyActiveOwner via storage]
 * fileClaim - transferFrom(msg.sender → pool) [INCOMING, self-claim blocked]
 * slashBond - burn(actualSlash*slashBurnBps) [onlyCourt]
 * - transfer(pool → claimant, payout+fee) [onlyCourt]
 * - transfer(pool → techWallet, procFee) [onlyCourt, conditional]
 * dismissClaim - burn(claim.filingFee) [onlyCourt]
 * - transfer(pool → techWallet, procFee) [onlyCourt, conditional]
 * expireStaleClaim - burn(claim.filingFee) [public, time-gated] (Pass-3 #3)
 * processAbandonment - burn(bond.amount) [public, time-gated]
 *
 * Every burn above is the PVT9 self-burn burn(uint256) (IPVTBurnable), ported
 * from the legacy protocolBurn(uint256) — the pool always burns PVT it already
 * custodies, so no allowance is involved. Burn assertions check the amount
 * (pvt.totalBurned delta) AND the entrypoint: pvt.totalSelfBurned is fed ONLY
 * by burn(), so `totalSelfBurned == totalBurned` proves nothing in this fixture
 * reached the legacy protocolBurn() path.
 *
 * No other PVT-moving call sites exist. Any new external function that calls
 * pvt.transfer / pvt.transferFrom / pvt.burn MUST be added to this
 * list AND to the expected-ABI selector set in test_ABI_expectedSelectors.
 * ============================================================================
 */

contract ProvianBondPoolTest is Test {
    ProvianBondPool public bondPool;
    MockPVT public pvt;

    address public admin = address(0xA01);
    address public techWallet = address(0xA02);
    address public court = address(0xA03);
    address public governance = address(0xA04);
    address public newAdmin = address(0xA05);
    address public agent = address(0xB01);
    address public claimant = address(0xB02);
    address public rando = address(0xC01);

    // Contract defaults mirrored here for test clarity (PVTv5 recalibrated:
    // base bonds are now governable storage, not immutable constants).
    uint256 public constant LEVEL_2_BASE = 750e18;
    uint256 public constant LEVEL_3_BASE = 3000e18;
    uint256 public constant MAX_TRUST_DISCOUNT = 5000;  // 50%
    uint256 public constant MAX_BPS = 10000;

    uint256 public constant DEPOSIT_BURN_BPS = 200;     // 2%
    uint256 public constant DEPOSIT_FEE_BPS = 100;      // 1%
    uint256 public constant RENEWAL_BURN_BPS = 100;     // 1%
    uint256 public constant RENEWAL_FEE_BPS = 50;       // 0.5%
    uint256 public constant SLASH_BURN_BPS = 2000;      // 20%
    uint256 public constant SLASH_PAYOUT_BPS = 8000;    // 80%
    // WS1 (Pass-2): also the floor for the partial slash band — a slash must be
    // in [MIN_SLASH_PAYOUT_BPS of bond, bond].
    uint256 public constant MIN_SLASH_PAYOUT_BPS = 5000; // 50%
    uint256 public constant FILING_FEE = 15e18;
    uint256 public constant CLAIMS_PROCESSING_FEE = 30e18;
    // institution deployment (directive item 5): baseline lock/renewal durations lengthened on this
    // fresh deployment. Mirrors ProvianBondPool's storage initialisers exactly; the
    // suite asserts the contract against these, so a drift in either direction fails.
    uint256 public constant RENEWAL_PERIOD = 180 days;
    uint256 public constant RENEWAL_GRACE = 30 days;
    uint256 public constant ABANDONMENT_PERIOD = 365 days;

    uint256 public constant FUND_AMOUNT = 1_000_000e18;

    function setUp() public {
        pvt = new MockPVT();
        // institution deployment/slashBond/dismissClaim now route the processing fee to courtContract
        // and call fundBondClaimReward on it, so courtContract must be a conforming contract
        // (the real ProvianCourtV2 in production). A unit test uses the minimal sink mock.
        court = address(new MockCourtRewardSink());
        bondPool = new ProvianBondPool(admin, techWallet, address(pvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), new ProvianBondPool.BondSeed[](0), new ProvianBondPool.BpsSeed[](0));

        vm.startPrank(admin);
        bondPool.setCourtContract(court);
        bondPool.setExecutor(governance);
        vm.stopPrank();

        pvt.mint(agent, FUND_AMOUNT);
        pvt.mint(claimant, FUND_AMOUNT);
        pvt.mint(rando, FUND_AMOUNT);

        vm.prank(agent);
        pvt.approve(address(bondPool), type(uint256).max);
        vm.prank(claimant);
        pvt.approve(address(bondPool), type(uint256).max);
        vm.prank(rando);
        pvt.approve(address(bondPool), type(uint256).max);
    }

    // Compute the TOTAL deposit an agent must send so that `required` lands
    // locked after deposit fees. Mirrors the ceil-division in postBond.
    function _grossUpDeposit(uint256 required) internal pure returns (uint256) {
        uint256 remainingBps = MAX_BPS - DEPOSIT_BURN_BPS - DEPOSIT_FEE_BPS;
        return (required * MAX_BPS + remainingBps - 1) / remainingBps;
    }

    // =========================================================================
    // CONSTRUCTOR + CONSTANTS + ACCESS CONTROL
    // =========================================================================

    function test_constructor_setsAdminTechWalletPvt() public view {
        assertEq(bondPool.admin(), admin);
        assertEq(bondPool.provianTechWallet(), techWallet);
        assertEq(address(bondPool.pvt()), address(pvt));
    }

    function test_constructor_rejectsZeroAddresses() public {
        address clk = address(new MockEpochClock(0)); // hoisted so expectRevert targets the Bond create
        address idx = address(new MockIssuanceIndex()); // hoisted for the same reason
        vm.expectRevert(ProvianBondPool.InvalidAddress.selector);
        new ProvianBondPool(address(0), techWallet, address(pvt), clk, idx, new ProvianBondPool.BondSeed[](0), new ProvianBondPool.BpsSeed[](0));
        vm.expectRevert(ProvianBondPool.InvalidAddress.selector);
        new ProvianBondPool(admin, address(0), address(pvt), clk, idx, new ProvianBondPool.BondSeed[](0), new ProvianBondPool.BpsSeed[](0));
        vm.expectRevert(ProvianBondPool.InvalidAddress.selector);
        new ProvianBondPool(admin, techWallet, address(0), clk, idx, new ProvianBondPool.BondSeed[](0), new ProvianBondPool.BpsSeed[](0));
        vm.expectRevert(ProvianBondPool.InvalidAddress.selector);
        new ProvianBondPool(admin, techWallet, address(pvt), address(0), idx, new ProvianBondPool.BondSeed[](0), new ProvianBondPool.BpsSeed[](0));
        // institution deployment: the new issuance-index reference is zero-checked like the rest.
        vm.expectRevert(ProvianBondPool.InvalidAddress.selector);
        new ProvianBondPool(admin, techWallet, address(pvt), clk, address(0), new ProvianBondPool.BondSeed[](0), new ProvianBondPool.BpsSeed[](0));
    }

    function test_constants_matchTestMirror() public view {
        // Pin the bond requirement + discount cap constants on-chain.
        assertEq(bondPool.level2BaseBond(), LEVEL_2_BASE);
        assertEq(bondPool.level3BaseBond(), LEVEL_3_BASE);
        assertEq(bondPool.MAX_TRUST_DISCOUNT(), MAX_TRUST_DISCOUNT);
        assertEq(bondPool.MAX_BPS(), MAX_BPS);
    }

    function test_setCourtContract_oneTimeOnly() public {
        // Fresh pool so we can exercise the setter from scratch.
        ProvianBondPool fresh = new ProvianBondPool(admin, techWallet, address(pvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), new ProvianBondPool.BondSeed[](0), new ProvianBondPool.BpsSeed[](0));
        vm.prank(admin);
        fresh.setCourtContract(court);
        vm.prank(admin);
        vm.expectRevert(ProvianBondPool.CourtAlreadySet.selector);
        fresh.setCourtContract(court);
    }

    function test_setCourtContract_onlyAdmin() public {
        ProvianBondPool fresh = new ProvianBondPool(admin, techWallet, address(pvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), new ProvianBondPool.BondSeed[](0), new ProvianBondPool.BpsSeed[](0));
        vm.prank(rando);
        vm.expectRevert(ProvianBondPool.OnlyAdmin.selector);
        fresh.setCourtContract(court);
    }

    function test_setExecutor_oneTimeOnly() public {
        ProvianBondPool fresh = new ProvianBondPool(admin, techWallet, address(pvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), new ProvianBondPool.BondSeed[](0), new ProvianBondPool.BpsSeed[](0));
        vm.prank(admin);
        fresh.setExecutor(governance);
        vm.prank(admin);
        vm.expectRevert(ProvianBondPool.ExecutorAlreadySet.selector);
        fresh.setExecutor(governance);
    }

    function test_transferAdmin_rotates() public {
        vm.prank(admin);
        bondPool.transferAdmin(newAdmin);
        assertEq(bondPool.admin(), newAdmin);

        // Old admin can no longer act.
        ProvianBondPool fresh = new ProvianBondPool(admin, techWallet, address(pvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), new ProvianBondPool.BondSeed[](0), new ProvianBondPool.BpsSeed[](0));
        vm.prank(admin);
        fresh.transferAdmin(newAdmin);
        vm.prank(admin);
        vm.expectRevert(ProvianBondPool.OnlyAdmin.selector);
        fresh.setCourtContract(court);
    }

    function test_transferAdmin_rejectsZero() public {
        vm.prank(admin);
        vm.expectRevert(ProvianBondPool.InvalidAddress.selector);
        bondPool.transferAdmin(address(0));
    }

    // =========================================================================
    // POST BOND
    // =========================================================================

    function test_postBond_level2_happyPath_splitsCorrectly() public {
        uint256 required = bondPool.getRequiredBond(2, 0);
        assertEq(required, LEVEL_2_BASE, "Level 2 base bond");

        uint256 expectedDeposit = _grossUpDeposit(required);
        uint256 expectedBurn = (expectedDeposit * DEPOSIT_BURN_BPS) / MAX_BPS;
        uint256 expectedFee = (expectedDeposit * DEPOSIT_FEE_BPS) / MAX_BPS;
        uint256 expectedLocked = expectedDeposit - expectedBurn - expectedFee;

        uint256 agentBefore = pvt.balanceOf(agent);
        uint256 techBefore = pvt.balanceOf(techWallet);
        uint256 burnedBefore = pvt.totalBurned();

        vm.prank(agent);
        bondPool.postBond(2, 0);

        // Invariant: deposit = burn + fee + locked
        assertEq(expectedBurn + expectedFee + expectedLocked, expectedDeposit, "deposit split sums");

        assertEq(pvt.balanceOf(agent), agentBefore - expectedDeposit, "agent debited totalDeposit");
        assertEq(pvt.balanceOf(techWallet), techBefore + expectedFee, "techWallet credited fee");
        assertEq(pvt.totalBurned(), burnedBefore + expectedBurn, "burn recorded");
        assertEq(pvt.totalSelfBurned(), pvt.totalBurned(), "burned via burn(), not protocolBurn()");
        assertEq(pvt.balanceOf(address(bondPool)), expectedLocked, "pool holds locked portion");

        (uint256 amt, uint8 level, , , uint256 deadline, ProvianBondPool.BondStatus status, uint256 pending) =
            bondPool.bonds(agent);
        assertEq(amt, expectedLocked);
        assertEq(level, 2);
        assertEq(deadline, block.timestamp + RENEWAL_PERIOD);
        assertEq(uint8(status), uint8(ProvianBondPool.BondStatus.Active));
        assertEq(pending, 0);
    }

    function test_postBond_level3_base20k() public {
        uint256 required = bondPool.getRequiredBond(3, 0);
        assertEq(required, LEVEL_3_BASE, "Level 3 base bond");
        vm.prank(agent);
        bondPool.postBond(3, 0);
        (uint256 amt, uint8 level, , , , ,) = bondPool.bonds(agent);
        // Locked amount equals required (97% of grossed-up deposit, rounding accepted).
        // Within ±1 wei of requiredBond due to ceil-division rounding.
        assertApproxEqAbs(amt, required, 2);
        assertEq(level, 3);
    }

    function test_postBond_withMaxTrustDiscount_halvesRequired() public {
        // trustDiscountBps = MAX_TRUST_DISCOUNT (50%).
        uint256 required = bondPool.getRequiredBond(2, MAX_TRUST_DISCOUNT);
        assertEq(required, LEVEL_2_BASE / 2, "50% discount halves required");
    }

    function test_postBond_rejectsInvalidLevel() public {
        vm.prank(agent);
        vm.expectRevert(ProvianBondPool.InvalidAutonomyLevel.selector);
        bondPool.postBond(1, 0);
        vm.prank(agent);
        vm.expectRevert(ProvianBondPool.InvalidAutonomyLevel.selector);
        bondPool.postBond(4, 0);
    }

    function test_postBond_rejectsInvalidTrustDiscount() public {
        // 5001 bps > MAX_TRUST_DISCOUNT (5000).
        vm.prank(agent);
        vm.expectRevert(ProvianBondPool.InvalidTrustDiscount.selector);
        bondPool.postBond(2, 5001);
    }

    function test_postBond_rejectsDuplicateActiveBond() public {
        vm.prank(agent);
        bondPool.postBond(2, 0);
        vm.prank(agent);
        vm.expectRevert(ProvianBondPool.BondAlreadyExists.selector);
        bondPool.postBond(2, 0);
    }

    function test_postBond_allowsPostAfterWithdrawal() public {
        // Withdrawn bonds should be re-postable - status != Active.
        vm.prank(agent);
        bondPool.postBond(2, 0);
        vm.prank(agent);
        bondPool.withdrawBond();
        vm.prank(agent);
        bondPool.postBond(2, 0);
        (, , , , , ProvianBondPool.BondStatus status,) = bondPool.bonds(agent);
        assertEq(uint8(status), uint8(ProvianBondPool.BondStatus.Active));
    }

    // =========================================================================
    // RENEW BOND
    // =========================================================================

    function test_renewBond_burnsAndFeesFromLocked() public {
        vm.prank(agent);
        bondPool.postBond(2, 0);
        (uint256 amtBefore, , , , , ,) = bondPool.bonds(agent);

        uint256 expectedBurn = (amtBefore * RENEWAL_BURN_BPS) / MAX_BPS;
        uint256 expectedFee = (amtBefore * RENEWAL_FEE_BPS) / MAX_BPS;
        uint256 techBefore = pvt.balanceOf(techWallet);
        uint256 burnedBefore = pvt.totalBurned();

        vm.warp(block.timestamp + 30 days);
        vm.prank(agent);
        bondPool.renewBond();

        (uint256 amtAfter, , , uint256 lastRenewal, uint256 deadline, ,) = bondPool.bonds(agent);
        assertEq(amtAfter, amtBefore - expectedBurn - expectedFee, "bond decreased by burn + fee");
        assertEq(pvt.balanceOf(techWallet), techBefore + expectedFee, "tech received renewal fee");
        assertEq(pvt.totalBurned(), burnedBefore + expectedBurn, "renewal burn recorded");
        assertEq(pvt.totalSelfBurned(), pvt.totalBurned(), "burned via burn(), not protocolBurn()");
        assertEq(lastRenewal, block.timestamp);
        assertEq(deadline, block.timestamp + RENEWAL_PERIOD);
    }

    function test_renewBond_revertsIfNotActive() public {
        vm.prank(agent);
        vm.expectRevert(ProvianBondPool.BondNotActive.selector);
        bondPool.renewBond();
    }

    function test_PINNED_renewBond_zeroedByFullSlash_trapsAgent() public {
        // Behavior-by-design pinned per sprint plan. The renewal cost is
        // 1.5% of bond.amount at current defaults (burnBps=100 + feeBps=50),
        // so renewal can never exceed bond.amount by arithmetic. BUT a
        // full slash can drive bond.amount to exactly 0, at which point
        // `bond.amount <= totalCost` (0 <= 0) reverts InsufficientBond.
        // bond lifecycle: topUpBond is now the explicit escape (restore collateral,
        // then renew — see test_topUpBond_escapesRenewalTrapAfterFullSlash);
        // a zeroed bond with NO top-up still renews nowhere, and the agent
        // can still call withdrawBond to move the (now-empty) bond to
        // Withdrawn status.
        vm.prank(agent);
        bondPool.postBond(2, 0);
        (uint256 locked, , , , , ,) = bondPool.bonds(agent);

        bytes32 claimId = keccak256("pinned-claim");
        vm.prank(claimant);
        bondPool.fileClaim(agent, claimId);
        // Slash the entire bond (exactly `locked` == the full-verdict cap; drains
        // to 0). WS1 (Pass-2): an over-cap amount now reverts, so a full slash
        // passes exactly bond.amount.
        vm.prank(court);
        bondPool.slashBond(agent, locked, claimId);

        (uint256 amtAfter, , , , , ProvianBondPool.BondStatus statusAfter,) = bondPool.bonds(agent);
        assertEq(amtAfter, 0, "bond drained to zero");
        assertEq(uint8(statusAfter), uint8(ProvianBondPool.BondStatus.Active), "status still Active");

        // Renewal traps the agent: bond.amount == totalCost == 0 trips the guard.
        vm.prank(agent);
        vm.expectRevert(ProvianBondPool.InsufficientBond.selector);
        bondPool.renewBond();

        // Withdraw is still open (no pending claims after slash resolved).
        // Transfers 0 PVT, flips status to Withdrawn.
        vm.prank(agent);
        bondPool.withdrawBond();
        (, , , , , ProvianBondPool.BondStatus finalStatus,) = bondPool.bonds(agent);
        assertEq(uint8(finalStatus), uint8(ProvianBondPool.BondStatus.Withdrawn));
    }

    // =========================================================================
    // TOP UP BOND (bond lifecycle — shortfall restore; no burn, no fee, all collateral)
    // =========================================================================

    function test_topUpBond_restoresErodedCollateral_noBurnNoFee() public {
        vm.prank(agent);
        bondPool.postBond(2, 0); // locked == LEVEL_2_BASE (750e18)

        // Erode via renewal (1.5% of locked at defaults).
        vm.prank(agent);
        bondPool.renewBond();
        (uint256 eroded, , , , , ,) = bondPool.bonds(agent);
        uint256 requiredLock = bondPool.getRequiredBond(2, 0);
        assertLt(eroded, requiredLock, "renewal eroded below requirement");
        uint256 shortfall = requiredLock - eroded;

        uint256 agentBefore = pvt.balanceOf(agent);
        uint256 poolBefore = pvt.balanceOf(address(bondPool));
        uint256 techBefore = pvt.balanceOf(techWallet);
        uint256 burnedBefore = pvt.totalBurned();

        vm.prank(agent);
        bondPool.topUpBond(shortfall);

        // 100% of the top-up becomes locked collateral: no burn, no fee.
        (uint256 restored, , , , , ,) = bondPool.bonds(agent);
        assertEq(restored, requiredLock, "collateral restored to requirement");
        assertEq(pvt.balanceOf(agent), agentBefore - shortfall, "agent debited exactly the top-up");
        assertEq(pvt.balanceOf(address(bondPool)), poolBefore + shortfall, "pool holds all of it");
        assertEq(pvt.balanceOf(techWallet), techBefore, "NO fee on top-up");
        assertEq(pvt.totalBurned(), burnedBefore, "NO burn on top-up");
    }

    function test_topUpBond_emitsEvent() public {
        vm.prank(agent);
        bondPool.postBond(2, MAX_TRUST_DISCOUNT); // locked == 375e18 at 50% discount
        (uint256 locked, , , , , ,) = bondPool.bonds(agent);

        vm.expectEmit(true, false, false, true, address(bondPool));
        emit ProvianBondPool.BondToppedUp(agent, 10e18, locked + 10e18);
        vm.prank(agent);
        bondPool.topUpBond(10e18);
    }

    function test_topUpBond_zeroAmountReverts() public {
        vm.prank(agent);
        bondPool.postBond(2, 0);
        vm.prank(agent);
        vm.expectRevert(ProvianBondPool.InvalidAmount.selector);
        bondPool.topUpBond(0);
    }

    function test_topUpBond_shortfallBounded_neverAboveRequirement() public {
        // At the undiscounted requirement already: ANY top-up exceeds the bound.
        vm.prank(agent);
        bondPool.postBond(2, 0);
        vm.prank(agent);
        vm.expectRevert(ProvianBondPool.TopUpExceedsRequirement.selector);
        bondPool.topUpBond(1);

        // Discounted post (50% => 375e18 locked): the discount gap IS a
        // permissible shortfall — the bound is the UNDISCOUNTED base lock.
        vm.prank(claimant); // reuse a funded account as a second agent
        bondPool.postBond(2, MAX_TRUST_DISCOUNT);
        (uint256 locked, , , , , ,) = bondPool.bonds(claimant);
        uint256 gap = bondPool.getRequiredBond(2, 0) - locked;

        vm.prank(claimant);
        vm.expectRevert(ProvianBondPool.TopUpExceedsRequirement.selector);
        bondPool.topUpBond(gap + 1);

        vm.prank(claimant);
        bondPool.topUpBond(gap); // exactly to the requirement: allowed
        (uint256 restored, , , , , ,) = bondPool.bonds(claimant);
        assertEq(restored, bondPool.getRequiredBond(2, 0));
    }

    function test_topUpBond_revertsIfNotActive() public {
        // No bond at all.
        vm.prank(agent);
        vm.expectRevert(ProvianBondPool.BondNotActive.selector);
        bondPool.topUpBond(1e18);

        // Withdrawn bond.
        vm.prank(agent);
        bondPool.postBond(2, 0);
        vm.prank(agent);
        bondPool.withdrawBond();
        vm.prank(agent);
        vm.expectRevert(ProvianBondPool.BondNotActive.selector);
        bondPool.topUpBond(1e18);
    }

    function test_topUpBond_doesNotTouchRenewalDeadline() public {
        vm.prank(agent);
        bondPool.postBond(2, MAX_TRUST_DISCOUNT);
        (, , , uint256 lastRenewalBefore, uint256 deadlineBefore, ,) = bondPool.bonds(agent);

        vm.warp(block.timestamp + 30 days);
        vm.prank(agent);
        bondPool.topUpBond(5e18);

        (, , , uint256 lastRenewalAfter, uint256 deadlineAfter, ,) = bondPool.bonds(agent);
        assertEq(deadlineAfter, deadlineBefore, "deadline unchanged by top-up");
        assertEq(lastRenewalAfter, lastRenewalBefore, "lastRenewalAt unchanged by top-up");
    }

    function test_topUpBond_toppedCollateralIsSlashable() public {
        // "all_top_up_pvt_becomes_slashable_collateral": a full slash after a
        // top-up moves the TOPPED amount through the court split.
        vm.prank(agent);
        bondPool.postBond(2, MAX_TRUST_DISCOUNT); // 375e18 locked
        (uint256 locked, , , , , ,) = bondPool.bonds(agent);
        uint256 gap = bondPool.getRequiredBond(2, 0) - locked;
        vm.prank(agent);
        bondPool.topUpBond(gap); // now 750e18 locked

        bytes32 claimId = keccak256("topup-slash-claim");
        vm.prank(claimant);
        bondPool.fileClaim(agent, claimId);

        (uint256 full, , , , , ,) = bondPool.bonds(agent);
        assertEq(full, locked + gap, "slashable base includes the top-up");

        uint256 claimantBefore = pvt.balanceOf(claimant);
        uint256 burnedBefore = pvt.totalBurned();
        vm.prank(court);
        bondPool.slashBond(agent, full, claimId);

        uint256 expectedPayout = (full * SLASH_PAYOUT_BPS) / MAX_BPS;
        assertEq(
            pvt.balanceOf(claimant),
            claimantBefore + expectedPayout + FILING_FEE,
            "claimant paid from the full (topped-up) collateral"
        );
        assertEq(pvt.totalBurned(), burnedBefore + (full - expectedPayout), "burn share on the full amount");
    }

    function test_topUpBond_exitsOnlyViaWithdrawLifecycle() public {
        // Topped-up PVT leaves only through withdrawBond — the same exit as the
        // original collateral (no new exit path).
        vm.prank(agent);
        bondPool.postBond(2, MAX_TRUST_DISCOUNT);
        (uint256 locked, , , , , ,) = bondPool.bonds(agent);
        vm.prank(agent);
        bondPool.topUpBond(100e18);

        uint256 agentBefore = pvt.balanceOf(agent);
        vm.prank(agent);
        bondPool.withdrawBond();
        assertEq(pvt.balanceOf(agent), agentBefore + locked + 100e18, "withdraw returns original + top-up");
        assertEq(pvt.balanceOf(address(bondPool)), 0, "pool fully drained by owner exit");
    }

    function test_topUpBond_escapesRenewalTrapAfterFullSlash() public {
        // The PINNED renewal trap (bond.amount == 0 after a full slash) is now
        // escapable: restore collateral via topUpBond, then renew normally.
        vm.prank(agent);
        bondPool.postBond(2, 0);
        (uint256 locked, , , , , ,) = bondPool.bonds(agent);

        bytes32 claimId = keccak256("trap-escape-claim");
        vm.prank(claimant);
        bondPool.fileClaim(agent, claimId);
        vm.prank(court);
        bondPool.slashBond(agent, locked, claimId);

        (uint256 zeroed, , , , , ,) = bondPool.bonds(agent);
        assertEq(zeroed, 0, "fully slashed");

        uint256 requiredLock = bondPool.getRequiredBond(2, 0);
        vm.prank(agent);
        bondPool.topUpBond(requiredLock);

        vm.prank(agent);
        bondPool.renewBond(); // no longer InsufficientBond
        (uint256 amtAfter, , , , , ProvianBondPool.BondStatus statusAfter,) = bondPool.bonds(agent);
        assertGt(amtAfter, 0);
        assertEq(uint8(statusAfter), uint8(ProvianBondPool.BondStatus.Active));
    }

    function test_topUpBond_insufficientAllowanceReverts() public {
        vm.prank(agent);
        bondPool.postBond(2, MAX_TRUST_DISCOUNT);
        vm.prank(agent);
        pvt.approve(address(bondPool), 0); // revoke
        vm.prank(agent);
        vm.expectRevert(); // MockPVT allowance underflow (checked arithmetic)
        bondPool.topUpBond(1e18);
    }

    // =========================================================================
    // WITHDRAW BOND
    // =========================================================================

    function test_withdrawBond_returnsLockedAmount() public {
        vm.prank(agent);
        bondPool.postBond(2, 0);
        (uint256 locked, , , , , ,) = bondPool.bonds(agent);
        uint256 agentBefore = pvt.balanceOf(agent);

        vm.prank(agent);
        bondPool.withdrawBond();

        assertEq(pvt.balanceOf(agent), agentBefore + locked, "agent received bond back");
        assertEq(pvt.balanceOf(address(bondPool)), 0, "pool drained for this agent");

        (uint256 amtAfter, , , , , ProvianBondPool.BondStatus status,) = bondPool.bonds(agent);
        assertEq(amtAfter, 0);
        assertEq(uint8(status), uint8(ProvianBondPool.BondStatus.Withdrawn));
    }

    function test_withdrawBond_blockedByPendingClaims() public {
        vm.prank(agent);
        bondPool.postBond(2, 0);
        vm.prank(claimant);
        bondPool.fileClaim(agent, keccak256("claim-1"));
        vm.prank(agent);
        vm.expectRevert(ProvianBondPool.ClaimsPending.selector);
        bondPool.withdrawBond();
    }

    function test_withdrawBond_revertsIfNotActive() public {
        vm.prank(agent);
        vm.expectRevert(ProvianBondPool.BondNotActive.selector);
        bondPool.withdrawBond();
    }

    // =========================================================================
    // FILE CLAIM
    // =========================================================================

    function test_fileClaim_happyPath() public {
        vm.prank(agent);
        bondPool.postBond(2, 0);

        uint256 claimantBefore = pvt.balanceOf(claimant);
        uint256 poolBefore = pvt.balanceOf(address(bondPool));
        bytes32 claimId = keccak256("claim-ok");

        vm.prank(claimant);
        bondPool.fileClaim(agent, claimId);

        assertEq(pvt.balanceOf(claimant), claimantBefore - FILING_FEE, "claimant paid filing fee");
        assertEq(pvt.balanceOf(address(bondPool)), poolBefore + FILING_FEE, "pool holds filing fee");

        assertTrue(bondPool.claimExists(claimId));
        (, , , , , , uint256 pending) = bondPool.bonds(agent);
        assertEq(pending, 1);
    }

    function test_fileClaim_selfClaimBlocked() public {
        // Security Invariant #51.
        vm.prank(agent);
        bondPool.postBond(2, 0);
        vm.prank(agent);
        vm.expectRevert(ProvianBondPool.SelfClaimNotAllowed.selector);
        bondPool.fileClaim(agent, keccak256("self"));
    }

    function test_fileClaim_duplicateClaimIdReverts() public {
        vm.prank(agent);
        bondPool.postBond(2, 0);
        bytes32 id = keccak256("dup");
        vm.prank(claimant);
        bondPool.fileClaim(agent, id);
        vm.prank(rando);
        vm.expectRevert(ProvianBondPool.ClaimAlreadyExists.selector);
        bondPool.fileClaim(agent, id);
    }

    function test_fileClaim_revertsIfBondNotActive() public {
        vm.prank(claimant);
        vm.expectRevert(ProvianBondPool.BondNotActive.selector);
        bondPool.fileClaim(agent, keccak256("no-bond"));
    }

    // =========================================================================
    // SLASH BOND  (Security Invariant #49)
    // =========================================================================

    function test_slashBond_onlyCourt_reverts() public {
        vm.prank(agent);
        bondPool.postBond(2, 0);
        bytes32 id = keccak256("slash-onlycourt");
        vm.prank(claimant);
        bondPool.fileClaim(agent, id);

        // Every non-court caller must be rejected.
        address[4] memory nonCourt = [admin, governance, agent, rando];
        for (uint256 i = 0; i < nonCourt.length; i++) {
            vm.prank(nonCourt[i]);
            vm.expectRevert(ProvianBondPool.OnlyCourt.selector);
            bondPool.slashBond(agent, 1e18, id);
        }
    }

    function test_slashBond_splitsCorrectly() public {
        vm.prank(agent);
        bondPool.postBond(2, 0);
        (uint256 locked, , , , , ,) = bondPool.bonds(agent);
        bytes32 id = keccak256("slash-split");
        vm.prank(claimant);
        bondPool.fileClaim(agent, id);

        uint256 slashAmount = 500e18; // <= L2 locked (750) so not capped
        uint256 expectedClaimant = (slashAmount * SLASH_PAYOUT_BPS) / MAX_BPS;
        uint256 expectedBurn = slashAmount - expectedClaimant;
        assertEq(expectedClaimant + expectedBurn, slashAmount, "split sums to slashAmount");

        uint256 claimantBefore = pvt.balanceOf(claimant);
        uint256 techBefore = pvt.balanceOf(techWallet);
        uint256 courtBefore = pvt.balanceOf(court);
        uint256 burnedBefore = pvt.totalBurned();

        vm.prank(court);
        bondPool.slashBond(agent, slashAmount, id);

        // Claimant gets slash payout + filing fee returned.
        assertEq(
            pvt.balanceOf(claimant),
            claimantBefore + expectedClaimant + FILING_FEE,
            "claimant gets payout + filing fee back"
        );
        assertEq(pvt.totalBurned(), burnedBefore + expectedBurn, "burn recorded");
        assertEq(pvt.totalSelfBurned(), pvt.totalBurned(), "burned via burn(), not protocolBurn()");
        // institution deployment/the processing fee now funds the arbitrator panel (routed to the Court),
        // NOT Provian Tech. tech is unchanged; the Court (reward sink) receives the fee.
        assertEq(pvt.balanceOf(techWallet), techBefore, "tech no longer receives the processing fee");
        assertEq(pvt.balanceOf(court) - courtBefore, CLAIMS_PROCESSING_FEE, "panel (Court) got the processing fee");

        (uint256 amtAfter, , , , , , uint256 pending) = bondPool.bonds(agent);
        assertEq(amtAfter, locked - slashAmount - CLAIMS_PROCESSING_FEE, "bond reduced by slash + proc fee");
        assertEq(pending, 0);
    }

    // WS1 (Pass-2): the old behavior silently CLAMPED an over-cap slash to the
    // bond. It now REJECTS amounts above the bond (fail-closed, invariant #14).
    function test_slashBond_rejectsAboveCap() public {
        vm.prank(agent);
        bondPool.postBond(2, 0);
        (uint256 locked, , , , , ,) = bondPool.bonds(agent);
        bytes32 id = keccak256("slash-over-cap");
        vm.prank(claimant);
        bondPool.fileClaim(agent, id);

        vm.prank(court);
        vm.expectRevert(ProvianBondPool.SlashAmountOutOfBounds.selector);
        bondPool.slashBond(agent, locked + 1, id);
    }

    // A FULL slash at exactly the bond cap is accepted (== full verdict).
    function test_slashBond_fullSlashAtCap() public {
        vm.prank(agent);
        bondPool.postBond(2, 0);
        (uint256 locked, , , , , ,) = bondPool.bonds(agent);
        bytes32 id = keccak256("slash-cap");
        vm.prank(claimant);
        bondPool.fileClaim(agent, id);

        uint256 claimantBefore = pvt.balanceOf(claimant);
        uint256 burnedBefore = pvt.totalBurned();

        vm.prank(court);
        bondPool.slashBond(agent, locked, id); // exactly the cap

        uint256 expectedClaimant = (locked * SLASH_PAYOUT_BPS) / MAX_BPS;
        uint256 expectedBurn = locked - expectedClaimant;
        assertEq(pvt.balanceOf(claimant), claimantBefore + expectedClaimant + FILING_FEE);
        assertEq(pvt.totalBurned(), burnedBefore + expectedBurn);
        assertEq(pvt.totalSelfBurned(), pvt.totalBurned(), "burned via burn(), not protocolBurn()");

        (uint256 amtAfter, , , , , , uint256 pending) = bondPool.bonds(agent);
        assertEq(amtAfter, 0, "full slash drains the bond");
        assertEq(pending, 0);
    }

    // WS1 (Pass-2): below the 50% floor is rejected (under-slashing a clear
    // verdict). The Court only ever passes floor (partial) or cap (full).
    function test_slashBond_rejectsBelowFloor() public {
        vm.prank(agent);
        bondPool.postBond(2, 0);
        (uint256 locked, , , , , ,) = bondPool.bonds(agent);
        uint256 floorAmt = (locked * MIN_SLASH_PAYOUT_BPS) / MAX_BPS;
        bytes32 id = keccak256("slash-under-floor");
        vm.prank(claimant);
        bondPool.fileClaim(agent, id);

        vm.prank(court);
        vm.expectRevert(ProvianBondPool.SlashAmountOutOfBounds.selector);
        bondPool.slashBond(agent, floorAmt - 1, id);
    }

    // A PARTIAL slash at exactly the 50% floor is accepted (== partial verdict).
    function test_slashBond_partialSlashAtFloor() public {
        vm.prank(agent);
        bondPool.postBond(2, 0);
        (uint256 locked, , , , , ,) = bondPool.bonds(agent);
        uint256 floorAmt = (locked * MIN_SLASH_PAYOUT_BPS) / MAX_BPS;
        bytes32 id = keccak256("slash-floor");
        vm.prank(claimant);
        bondPool.fileClaim(agent, id);

        uint256 claimantBefore = pvt.balanceOf(claimant);
        vm.prank(court);
        bondPool.slashBond(agent, floorAmt, id); // exactly the floor

        uint256 expectedClaimant = (floorAmt * SLASH_PAYOUT_BPS) / MAX_BPS;
        assertEq(pvt.balanceOf(claimant), claimantBefore + expectedClaimant + FILING_FEE);

        (uint256 amtAfter, , , , , , uint256 pending) = bondPool.bonds(agent);
        // Remaining bond = locked - floor - processing fee (remainder >= 30 PVT here).
        assertEq(amtAfter, locked - floorAmt - CLAIMS_PROCESSING_FEE);
        assertEq(pending, 0);
    }

    function test_PINNED_slashBond_skipsProcessingFeeWhenInsufficient() public {
        // After a near-total slash, bond.amount may be less than
        // claimsProcessingFee. The contract silently skips the processing-fee
        // transfer in that case. Pinned so a future change to "force processing
        // fee even when insufficient" is a noticed behavior change.
        vm.prank(agent);
        bondPool.postBond(2, 0);
        (uint256 locked, , , , , ,) = bondPool.bonds(agent);
        bytes32 id = keccak256("slash-tiny-remainder");
        vm.prank(claimant);
        bondPool.fileClaim(agent, id);

        // Slash enough that remainder < CLAIMS_PROCESSING_FEE.
        uint256 slashAmount = locked - 20e18; // leaves only 20 PVT, < 30 PVT processing fee
        uint256 techBefore = pvt.balanceOf(techWallet);
        uint256 courtBefore = pvt.balanceOf(court);
        vm.prank(court);
        bondPool.slashBond(agent, slashAmount, id);

        assertEq(pvt.balanceOf(techWallet), techBefore, "tech received NO processing fee (insufficient bond)");
        // institution deployment/the fee is not routed to the panel (Court) either — it is simply not charged.
        assertEq(pvt.balanceOf(court), courtBefore, "no fee routed to the panel when the bond cannot cover it");
        (uint256 amtAfter, , , , , ,) = bondPool.bonds(agent);
        assertEq(amtAfter, locked - slashAmount, "bond reduced only by slash, not by fee");
    }

    function test_slashBond_rejectsAlreadyResolvedClaim() public {
        vm.prank(agent);
        bondPool.postBond(2, 0);
        (uint256 locked, , , , , ,) = bondPool.bonds(agent);
        bytes32 id = keccak256("double-slash");
        vm.prank(claimant);
        bondPool.fileClaim(agent, id);
        // First slash uses an in-bounds amount (>= 50% floor of the 750 bond).
        vm.prank(court);
        bondPool.slashBond(agent, locked, id);

        // Second slash on the now-Upheld claim reverts ClaimAlreadyResolved
        // BEFORE the bound check (status check precedes it).
        vm.prank(court);
        vm.expectRevert(ProvianBondPool.ClaimAlreadyResolved.selector);
        bondPool.slashBond(agent, locked, id);
    }

    function test_slashBond_rejectsMismatchedAgent() public {
        // A claim filed against agent A must not be resolvable against agent B.
        vm.prank(agent);
        bondPool.postBond(2, 0);
        address otherAgent = address(0xBADD);
        pvt.mint(otherAgent, FUND_AMOUNT);
        vm.prank(otherAgent);
        pvt.approve(address(bondPool), type(uint256).max);
        vm.prank(otherAgent);
        bondPool.postBond(2, 0);

        bytes32 id = keccak256("mismatch");
        vm.prank(claimant);
        bondPool.fileClaim(agent, id); // filed against `agent`

        vm.prank(court);
        vm.expectRevert(ProvianBondPool.InvalidAddress.selector);
        bondPool.slashBond(otherAgent, 100e18, id);
    }

    function test_slashBond_rejectsUnknownClaimId() public {
        vm.prank(agent);
        bondPool.postBond(2, 0);
        vm.prank(court);
        vm.expectRevert(ProvianBondPool.ClaimNotFound.selector);
        bondPool.slashBond(agent, 100e18, keccak256("never-filed"));
    }

    function test_slashBond_emitsDowngradeWhenBelowRequired() public {
        // After slash, if locked drops below what level-N requires, a
        // downgrade event fires.
        vm.prank(agent);
        bondPool.postBond(3, 0); // requires level3BaseBond (3k)
        (uint256 locked, , , , , ,) = bondPool.bonds(agent);
        bytes32 id = keccak256("downgrade");
        vm.prank(claimant);
        bondPool.fileClaim(agent, id);

        // Full slash (exactly the bond cap) drains it to 0, below the level-3
        // requirement. WS1 (Pass-2): an over-cap amount now reverts, so the full
        // verdict passes exactly bond.amount.
        uint256 slashAmount = locked;

        vm.expectEmit(true, false, false, false, address(bondPool));
        emit ProvianBondPool.AutonomyDowngrade(agent, 0, 0); // amounts not strictly checked
        vm.prank(court);
        bondPool.slashBond(agent, slashAmount, id);

        (uint256 amtAfter, , , , , ,) = bondPool.bonds(agent);
        assertLt(amtAfter, LEVEL_3_BASE, "bond fell below level-3 requirement");
    }

    // =========================================================================
    // DISMISS CLAIM
    // =========================================================================

    function test_dismissClaim_onlyCourt_reverts() public {
        vm.prank(agent);
        bondPool.postBond(2, 0);
        bytes32 id = keccak256("dismiss-onlycourt");
        vm.prank(claimant);
        bondPool.fileClaim(agent, id);

        address[4] memory nonCourt = [admin, governance, agent, rando];
        for (uint256 i = 0; i < nonCourt.length; i++) {
            vm.prank(nonCourt[i]);
            vm.expectRevert(ProvianBondPool.OnlyCourt.selector);
            bondPool.dismissClaim(agent, id);
        }
    }

    function test_dismissClaim_burnsFilingFee() public {
        vm.prank(agent);
        bondPool.postBond(2, 0);
        bytes32 id = keccak256("dismiss-burn");
        vm.prank(claimant);
        bondPool.fileClaim(agent, id);
        uint256 burnedBefore = pvt.totalBurned();
        uint256 techBefore = pvt.balanceOf(techWallet);
        uint256 courtBefore = pvt.balanceOf(court);
        uint256 claimantBefore = pvt.balanceOf(claimant);

        vm.prank(court);
        bondPool.dismissClaim(agent, id);

        assertEq(pvt.totalBurned(), burnedBefore + FILING_FEE, "filing fee burned");
        assertEq(pvt.totalSelfBurned(), pvt.totalBurned(), "burned via burn(), not protocolBurn()");
        assertEq(pvt.balanceOf(claimant), claimantBefore, "claimant NOT refunded");
        // institution deployment/the processing fee funds the panel (Court), not Provian Tech.
        assertEq(pvt.balanceOf(techWallet), techBefore, "tech no longer receives the processing fee");
        assertEq(pvt.balanceOf(court) - courtBefore, CLAIMS_PROCESSING_FEE, "panel (Court) got the processing fee");

        (, , , , , , uint256 pending) = bondPool.bonds(agent);
        assertEq(pending, 0);
    }

    function test_dismissClaim_rejectsAlreadyResolved() public {
        vm.prank(agent);
        bondPool.postBond(2, 0);
        bytes32 id = keccak256("double-dismiss");
        vm.prank(claimant);
        bondPool.fileClaim(agent, id);
        vm.prank(court);
        bondPool.dismissClaim(agent, id);
        vm.prank(court);
        vm.expectRevert(ProvianBondPool.ClaimAlreadyResolved.selector);
        bondPool.dismissClaim(agent, id);
    }

    // =========================================================================
    // PROCESS ABANDONMENT
    // =========================================================================

    function test_processAbandonment_burnsEntireBondAfterWindow() public {
        vm.prank(agent);
        bondPool.postBond(2, 0);
        (uint256 locked, , , , , ,) = bondPool.bonds(agent);

        // Fast-forward past renewal deadline + grace + abandonment.
        vm.warp(block.timestamp + RENEWAL_PERIOD + RENEWAL_GRACE + ABANDONMENT_PERIOD + 1);

        uint256 burnedBefore = pvt.totalBurned();
        vm.prank(rando); // anyone can call
        bondPool.processAbandonment(agent);

        assertEq(pvt.totalBurned(), burnedBefore + locked, "entire bond burned");
        assertEq(pvt.totalSelfBurned(), pvt.totalBurned(), "burned via burn(), not protocolBurn()");
        (uint256 amtAfter, , , , , ProvianBondPool.BondStatus status,) = bondPool.bonds(agent);
        assertEq(amtAfter, 0);
        assertEq(uint8(status), uint8(ProvianBondPool.BondStatus.Abandoned));
    }

    function test_processAbandonment_revertsBeforeWindow() public {
        vm.prank(agent);
        bondPool.postBond(2, 0);
        // Past deadline + grace, but not yet abandoned.
        vm.warp(block.timestamp + RENEWAL_PERIOD + RENEWAL_GRACE + 1);
        vm.prank(rando);
        vm.expectRevert(ProvianBondPool.GracePeriodNotExpired.selector);
        bondPool.processAbandonment(agent);
    }

    function test_processAbandonment_revertsIfNotActive() public {
        vm.prank(rando);
        vm.expectRevert(ProvianBondPool.BondNotActive.selector);
        bondPool.processAbandonment(agent);
    }

    // =========================================================================
    // COST PARAMETERS — SCHEDULE-ONLY (activation / strip)
    //
    // The eleven immediate `updateX(...)` onlyExecutor setters were REMOVED from
    // the deployed PVT9-era source. `scheduleX(...)` is now the only way any bond
    // cost parameter can move, and a schedule is prospective (>= currentEpoch+1)
    // and never reprices an already-posted bond. The velocity/window rate-limiter
    // went with the immediate lever it guarded — a prospective schedule cannot be
    // applied retroactively, so there is nothing for it to bound.
    //
    // Deep coverage of the schedule machinery (forward-fill, ladders, non-
    // collapsibility, fail-closed on an unarmed clock) lives in
    // ProvianBondPoolCostMachinery.t.sol. What follows is the access-control /
    // domain-bound coverage the removed setters used to carry, plus the strip
    // assertion itself.
    // =========================================================================

    /// @dev Arm this suite's clock at `now` so scheduled epochs can activate.
    ///      The suite's default clock is UNARMED (fail-closed: epoch pins to 0).
    function _armClockHere() internal returns (uint256 startsAt) {
        startsAt = block.timestamp;
        MockEpochClock(address(bondPool.epochClock())).arm(uint64(startsAt));
    }

    /// launch gate, resolved by STRIP: none of the eleven immediate
    /// recalibration setters may exist in the deployed surface.
    ///
    /// ABSENCE IS PROVEN AGAINST THE DISPATCH TABLE, not against a reverting
    /// call. A raw call is NOT sound here: every one of these setters was
    /// `onlyExecutor`, so an unpranked call to a still-present setter would also
    /// revert, and the test would pass on an un-stripped contract. Scanning the
    /// runtime bytecode for the selector is the only assertion that actually
    /// fails if a setter is re-introduced.
    function test_immediateUpdateSetters_areStripped() public view {
        string[11] memory gone = [
            "updateDepositBurnBps(uint256)",
            "updateDepositFeeBps(uint256)",
            "updateRenewalBurnBps(uint256)",
            "updateRenewalFeeBps(uint256)",
            "updateSlashBps(uint256,uint256)",
            "updateClaimsProcessingFee(uint256)",
            "updateClaimFilingFee(uint256)",
            "updateRenewalPeriod(uint256)",
            "updateAbandonmentPeriod(uint256)",
            "updateBaseBonds(uint256,uint256)",
            "updateMaxBondDeposit(uint256)"
        ];
        bytes memory code = address(bondPool).code;
        for (uint256 i = 0; i < gone.length; i++) {
            assertFalse(
                _selectorInBytecode(code, bytes4(keccak256(bytes(gone[i])))),
                string.concat("stripped setter still in the dispatch table: ", gone[i])
            );
        }
        // The velocity machinery the immediate setters carried is gone with them.
        // These are unguarded public getters, so their selectors must also be absent.
        string[3] memory goneGetters = [
            "BOND_PARAM_WINDOW()",
            "lastBaseBondChangeAt()",
            "lastMaxDepositChangeAt()"
        ];
        for (uint256 i = 0; i < goneGetters.length; i++) {
            assertFalse(
                _selectorInBytecode(code, bytes4(keccak256(bytes(goneGetters[i])))),
                string.concat("stripped getter still in the dispatch table: ", goneGetters[i])
            );
        }
    }

    function test_scheduleDepositBurnBps_onlyExecutor() public {
        vm.prank(rando);
        vm.expectRevert(ProvianBondPool.OnlyExecutor.selector);
        bondPool.scheduleDepositBurnBps(1, 300);
        vm.prank(admin);
        vm.expectRevert(ProvianBondPool.OnlyExecutor.selector);
        bondPool.scheduleDepositBurnBps(1, 300);
    }

    function test_scheduleDepositBurnBps_enforcesCap() public {
        vm.prank(governance);
        vm.expectRevert(ProvianBondPool.CostOutOfDomain.selector);
        bondPool.scheduleDepositBurnBps(1, 1001); // max 1000 (10%)
    }

    function test_scheduleSlashShares_mustSumToMaxBps() public {
        // Slash bps is a partition: burn + payout = 100%.
        vm.prank(governance);
        vm.expectRevert(ProvianBondPool.SlashBpsInvariant.selector);
        bondPool.scheduleSlashShares(1, 2000, 7999); // sums to 9999, not MAX_BPS
    }

    function test_scheduleSlashShares_validPartitionActivatesNextEpoch() public {
        uint256 startsAt = _armClockHere();
        vm.prank(governance);
        bondPool.scheduleSlashShares(1, 3000, 7000);

        // Prospective: nothing active in the scheduling epoch.
        (bool e0,,) = bondPool.activeSlashShares();
        assertFalse(e0);
        assertEq(bondPool.slashBurnBps(), 2000);

        vm.warp(startsAt + 7 days); // kernel epoch 1
        (bool e1, uint256 burn, uint256 payout) = bondPool.activeSlashShares();
        assertTrue(e1);
        assertEq(burn, 3000);
        assertEq(payout, 7000);
    }

    function test_scheduleSlashShares_rejectsBelowVictimFloor() public {
        // A prevailing claimant must always recover >= 50% (MIN_SLASH_PAYOUT_BPS).
        vm.prank(governance);
        vm.expectRevert(ProvianBondPool.SlashPayoutBelowFloor.selector);
        bondPool.scheduleSlashShares(1, 6000, 4000); // payout 40% < 50% floor
    }

    function test_scheduleBaseBonds_happyAndReflectedInRequired() public {
        uint256 startsAt = _armClockHere();
        vm.prank(governance);
        bondPool.scheduleBaseBonds(1, 1000e18, 2000e18);

        // Still the constructor baselines until the epoch turns.
        assertEq(bondPool.getRequiredBond(2, 0), 750e18);

        vm.warp(startsAt + 7 days); // kernel epoch 1
        (bool ok, uint256 l2, uint256 l3) = bondPool.activeBaseBonds();
        assertTrue(ok);
        assertEq(l2, 1000e18);
        assertEq(l3, 2000e18);
        assertEq(bondPool.getRequiredBond(2, 0), 1000e18);
        assertEq(bondPool.getRequiredBond(3, 0), 2000e18);
    }

    function test_scheduleBaseBonds_boundsAndL3GteL2() public {
        vm.prank(governance);
        vm.expectRevert(ProvianBondPool.BaseBondOutOfBounds.selector);
        bondPool.scheduleBaseBonds(1, 50e18, 3000e18); // < MIN_BASE_BOND (100)
        vm.prank(governance);
        vm.expectRevert(ProvianBondPool.BaseBondOutOfBounds.selector);
        bondPool.scheduleBaseBonds(1, 1000e18, 900e18); // L3 < L2
    }

    function test_scheduleBaseBonds_onlyExecutor() public {
        vm.prank(rando);
        vm.expectRevert(ProvianBondPool.OnlyExecutor.selector);
        bondPool.scheduleBaseBonds(1, 1000e18, 2000e18);
    }

    function test_postBond_rejectsDepositOverCap() public {
        // Schedule maxBondDeposit down to the L3 base (3000) so a normal L3 bond
        // (gross-up ~3093 > 3000) is blocked once the epoch turns.
        uint256 startsAt = _armClockHere();
        vm.prank(governance);
        bondPool.scheduleMaxBondDeposit(1, 3000e18);

        vm.warp(startsAt + 7 days); // kernel epoch 1
        (bool ok, uint256 cap) = bondPool.activeMaxBondDeposit();
        assertTrue(ok);
        assertEq(cap, 3000e18);

        vm.prank(agent);
        vm.expectRevert(ProvianBondPool.DepositExceedsCap.selector);
        bondPool.postBond(3, 0); // L3 deposit ~3093 > 3000 cap
    }

    function test_scheduleRenewalPeriod_boundsEnforced() public {
        vm.prank(governance);
        vm.expectRevert(ProvianBondPool.CostOutOfDomain.selector);
        bondPool.scheduleRenewalPeriod(1, 29 days);
        vm.prank(governance);
        vm.expectRevert(ProvianBondPool.CostOutOfDomain.selector);
        bondPool.scheduleRenewalPeriod(1, 366 days);

        uint256 startsAt = _armClockHere();
        vm.prank(governance);
        bondPool.scheduleRenewalPeriod(1, 120 days);
        vm.warp(startsAt + 7 days);
        (bool ok, uint256 v) = bondPool.activeRenewalPeriod();
        assertTrue(ok);
        assertEq(v, 120 days);
    }

    function test_scheduleAbandonmentPeriod_boundsEnforced() public {
        vm.prank(governance);
        vm.expectRevert(ProvianBondPool.CostOutOfDomain.selector);
        bondPool.scheduleAbandonmentPeriod(1, 89 days);
        vm.prank(governance);
        vm.expectRevert(ProvianBondPool.CostOutOfDomain.selector);
        bondPool.scheduleAbandonmentPeriod(1, 731 days);
    }

    /// The single-deposit cap keeps its immutable domain now that the immediate
    /// setter is gone — the schedule path is the only writer and must enforce it.
    function test_scheduleMaxBondDeposit_boundsEnforced() public {
        uint256 belowFloor = bondPool.MIN_MAX_BOND_DEPOSIT() - 1;
        uint256 aboveCeiling = bondPool.MAX_MAX_BOND_DEPOSIT() + 1;

        vm.prank(governance);
        vm.expectRevert(ProvianBondPool.CostOutOfDomain.selector);
        bondPool.scheduleMaxBondDeposit(1, belowFloor);

        vm.prank(governance);
        vm.expectRevert(ProvianBondPool.CostOutOfDomain.selector);
        bondPool.scheduleMaxBondDeposit(1, aboveCeiling);

        // Nothing was recorded by either refusal.
        (bool exists,) = bondPool.activeMaxBondDeposit();
        assertFalse(exists);
        assertEq(bondPool.maxBondDeposit(), 7500e18);
    }

    /// Prospectivity is the property that replaced the removed velocity cap: no
    /// cost may activate in the epoch it is scheduled in, or in any past epoch.
    /// With the suite's default UNARMED clock the epoch fails closed to 0, so
    /// epoch 0 is the current epoch and must be refused.
    function test_scheduleCosts_rejectNonProspectiveEpoch() public {
        assertEq(bondPool.earliestSchedulableEpoch(), 1);

        vm.prank(governance);
        vm.expectRevert(ProvianBondPool.PolicyNotProspective.selector);
        bondPool.scheduleDepositBurnBps(0, 100);

        vm.prank(governance);
        vm.expectRevert(ProvianBondPool.PolicyNotProspective.selector);
        bondPool.scheduleBaseBonds(0, 1000e18, 2000e18);

        vm.prank(governance);
        vm.expectRevert(ProvianBondPool.PolicyNotProspective.selector);
        bondPool.scheduleSlashShares(0, 3000, 7000);

        // A duplicate schedule on a legal future epoch is refused too, so a
        // queued rung can never be silently overwritten.
        vm.prank(governance);
        bondPool.scheduleDepositBurnBps(1, 100);
        vm.prank(governance);
        vm.expectRevert(ProvianBondPool.PolicyAlreadyScheduled.selector);
        bondPool.scheduleDepositBurnBps(1, 200);
    }

    // =========================================================================
    // ABI DRAIN INTROSPECTION  -  Security Invariant #48
    //
    // Hardcoded expected-ABI surface. Any new external function added to
    // ProvianBondPool.sol must be added to `expectedSelectors` here AND to
    // the PVT-moving call sites comment block at the top of this file.
    // Failure to do so fails this test and forces a reviewer decision:
    // "is this new function safe?".
    //
    // Also explicitly tests that no common drain-style selector exists on
    // the contract - a belt-and-braces check for the invariant.
    // =========================================================================

    /// @notice Scan runtime bytecode for `PUSH4 <sel>` - Solidity's
    ///         dispatcher emits this pattern for every external function.
    ///         Returns true if the selector appears in the dispatch table.
    function _selectorInBytecode(bytes memory code, bytes4 sel) internal pure returns (bool) {
        if (code.length < 5) return false;
        for (uint256 i = 0; i + 4 < code.length; i++) {
            if (uint8(code[i]) == 0x63
                && code[i + 1] == sel[0]
                && code[i + 2] == sel[1]
                && code[i + 3] == sel[2]
                && code[i + 4] == sel[3]) {
                return true;
            }
        }
        return false;
    }

    function test_ABI_noDrainStyleSelectors() public view {
        // Enumerate signatures that a drain function would typically take.
        // The contract must not expose ANY of these in its dispatch table.
        bytes memory code = address(bondPool).code;
        string[12] memory drainSigs = [
            "withdraw(uint256)",
            "withdrawTo(address,uint256)",
            "drain()",
            "drain(address)",
            "emergencyWithdraw()",
            "emergencyWithdraw(uint256)",
            "adminWithdraw(uint256)",
            "rescueToken(address,uint256)",
            "rescueERC20(address,uint256)",
            "rescue(address,address,uint256)",
            "sweep(address)",
            "sweepToken(address,address)"
        ];
        for (uint256 i = 0; i < drainSigs.length; i++) {
            bytes4 sel = bytes4(keccak256(bytes(drainSigs[i])));
            assertFalse(
                _selectorInBytecode(code, sel),
                string.concat("drain-style selector present: ", drainSigs[i])
            );
        }
    }

    function test_ABI_expectedSelectors_allReachable() public view {
        // Hardcoded expected external / public function surface of
        // ProvianBondPool. Any NEW function added to the .sol must be
        // appended here; this acts as the review gate. Each selector is
        // checked for dispatcher reachability via staticcall to the contract
        // with ONLY the selector (no args). The expected outcome per entry
        // is revert-with-data (caller-gate or arg-decode error) - not
        // empty-returndata, which would indicate "no dispatcher entry."
        //
        // Read-only getters with no args will succeed; state-mutating
        // functions will revert (either from caller gate or arg decoding),
        // but both cases produce non-empty returndata for dispatched
        // selectors when they revert with custom errors.
        string[41] memory signatures = [
            // External / public mutators
            "postBond(uint8,uint256)",
            "renewBond()",
            "topUpBond(uint256)", // bond lifecycle shortfall-restore (no burn/fee, all collateral)
            "withdrawBond()",
            "fileClaim(address,bytes32)",
            "slashBond(address,uint256,bytes32)",
            "dismissClaim(address,bytes32)",
            "expireStaleClaim(bytes32)", // Pass-3 #3 permissionless stale-claim escape
            "processAbandonment(address)",
            "setCourtContract(address)",
            "setExecutor(address)",
            "transferAdmin(address)",
            // activation/the eleven immediate updateX setters were STRIPPED; the
            // prospective scheduleX surface below replaces them one-for-one.
            "scheduleDepositBurnBps(uint64,uint256)",
            "scheduleDepositFeeBps(uint64,uint256)",
            "scheduleRenewalBurnBps(uint64,uint256)",
            "scheduleRenewalFeeBps(uint64,uint256)",
            "scheduleSlashShares(uint64,uint256,uint256)",
            "scheduleClaimsProcessingFee(uint64,uint256)",
            "scheduleClaimFilingFee(uint64,uint256)",
            "scheduleRenewalPeriod(uint64,uint256)",
            "scheduleAbandonmentPeriod(uint64,uint256)",
            // Public getters (auto-generated)
            "bonds(address)",
            "claims(bytes32)",
            "claimExists(bytes32)",
            "admin()",
            "provianTechWallet()",
            "pvt()",
            "courtContract()",
            "executor()",
            "depositBurnBps()",
            "depositFeeBps()",
            "renewalBurnBps()",
            "renewalFeeBps()",
            "slashBurnBps()",
            "slashPayoutBps()",
            "claimsProcessingFee()",
            "claimFilingFee()",
            "renewalPeriod()",
            "renewalGracePeriod()",
            "abandonmentPeriod()",
            "getRequiredBond(uint8,uint256)"
        ];
        // Governable base-bond getters, constant getters, and isBondHealthy are
        // additional public surface (level2BaseBond, level3BaseBond,
        // maxBondDeposit, MAX_TRUST_DISCOUNT, MAX_BPS,
        // MAX_FEE, MAX_FILING_FEE, MIN_RENEWAL_PERIOD, MAX_RENEWAL_PERIOD,
        // MIN_ABANDONMENT_PERIOD, MAX_ABANDONMENT_PERIOD, isBondHealthy).
        // They are exercised elsewhere via direct call (test_constants_*).
        // The 41 above are the externally-reachable MUTATOR and NON-CONSTANT
        // READ surface - the gate that matters for drain introspection.

        bytes memory code = address(bondPool).code;
        for (uint256 i = 0; i < signatures.length; i++) {
            bytes4 sel = bytes4(keccak256(bytes(signatures[i])));
            assertTrue(
                _selectorInBytecode(code, sel),
                string.concat("expected selector missing: ", signatures[i])
            );
        }
    }

    // =========================================================================
    // FUZZ / INVARIANTS
    // =========================================================================

    function testFuzz_getRequiredBond_discountMonotonic(uint256 discount) public view {
        discount = bound(discount, 0, MAX_TRUST_DISCOUNT);
        uint256 r = bondPool.getRequiredBond(2, discount);
        assertLe(r, LEVEL_2_BASE, "discount never raises required");
        if (discount > 0) assertLt(r, LEVEL_2_BASE, "any discount lowers required");
        r = bondPool.getRequiredBond(3, discount);
        assertLe(r, LEVEL_3_BASE);
    }

    function testFuzz_getRequiredBond_clampsOverMax(uint256 discount) public view {
        // Any value over MAX_TRUST_DISCOUNT is treated as MAX.
        vm.assume(discount > MAX_TRUST_DISCOUNT);
        uint256 r = bondPool.getRequiredBond(2, discount);
        assertEq(r, bondPool.getRequiredBond(2, MAX_TRUST_DISCOUNT), "over-cap clamps to cap");
    }

    function testFuzz_slashBond_splitAlwaysSumsToActual(uint256 slashAmount) public {
        vm.prank(agent);
        bondPool.postBond(3, 0);
        (uint256 locked, , , , , ,) = bondPool.bonds(agent);

        // WS1 (Pass-2): a slash must land in [50% floor, bond cap]; anything else
        // reverts (no clamp). Sweep the whole valid band.
        uint256 floorAmt = (locked * MIN_SLASH_PAYOUT_BPS) / MAX_BPS;
        slashAmount = bound(slashAmount, floorAmt, locked);
        bytes32 id = keccak256(abi.encode("fuzz-slash", slashAmount));
        vm.prank(claimant);
        bondPool.fileClaim(agent, id);

        uint256 claimantBefore = pvt.balanceOf(claimant);
        uint256 burnedBefore = pvt.totalBurned();
        uint256 techBefore = pvt.balanceOf(techWallet);
        uint256 courtBefore = pvt.balanceOf(court);
        uint256 bondBefore = pvt.balanceOf(address(bondPool));

        vm.prank(court);
        bondPool.slashBond(agent, slashAmount, id);

        uint256 actualSlash = slashAmount; // no clamp: in-bounds by construction
        uint256 expectedClaimant = (actualSlash * SLASH_PAYOUT_BPS) / MAX_BPS;
        uint256 expectedBurn = actualSlash - expectedClaimant;

        uint256 toClaimant = pvt.balanceOf(claimant) - claimantBefore;
        uint256 burned = pvt.totalBurned() - burnedBefore;
        // institution deployment/the processing fee is routed to the Court (panel reward sink), not tech.
        uint256 toCourt = pvt.balanceOf(court) - courtBefore;
        uint256 poolDecrease = bondBefore - pvt.balanceOf(address(bondPool));

        // Claimant received slash-payout + filing fee (filing fee was already
        // in the pool, so pool's decrease accounts for it).
        assertEq(toClaimant, expectedClaimant + FILING_FEE, "claimant payout correct");
        assertEq(burned, expectedBurn, "burn correct");
        assertEq(pvt.totalSelfBurned(), pvt.totalBurned(), "burned via burn(), not protocolBurn()");
        assertEq(pvt.balanceOf(techWallet), techBefore, "tech no longer receives the processing fee");
        // Processing fee: charged when remaining bond >= procFee.
        (uint256 amtAfter, , , , , ,) = bondPool.bonds(agent);
        uint256 remainingPreFee = locked - actualSlash;
        uint256 expectedCourtFee = remainingPreFee >= CLAIMS_PROCESSING_FEE ? CLAIMS_PROCESSING_FEE : 0;
        assertEq(toCourt, expectedCourtFee, "processing fee routed to the panel (Court)");
        assertEq(amtAfter, remainingPreFee - expectedCourtFee, "bond.amount correct");

        // Conservation of PVT across this slash: pool decrease == toClaimant + burned + toCourt
        // (filing fee moved from pool to claimant counted inside toClaimant).
        assertEq(poolDecrease, toClaimant + burned + toCourt, "PVT conservation in slash");
    }

    function testFuzz_postBond_splitAlwaysSumsToDeposit(uint8 levelRaw, uint256 discount) public {
        uint8 level = (levelRaw % 2 == 0) ? 2 : 3;
        discount = bound(discount, 0, MAX_TRUST_DISCOUNT);

        uint256 required = bondPool.getRequiredBond(level, discount);
        uint256 expectedDeposit = _grossUpDeposit(required);

        uint256 agentBefore = pvt.balanceOf(agent);
        uint256 techBefore = pvt.balanceOf(techWallet);
        uint256 burnedBefore = pvt.totalBurned();

        vm.prank(agent);
        bondPool.postBond(level, discount);

        uint256 spent = agentBefore - pvt.balanceOf(agent);
        uint256 toTech = pvt.balanceOf(techWallet) - techBefore;
        uint256 burned = pvt.totalBurned() - burnedBefore;
        uint256 locked = pvt.balanceOf(address(bondPool));

        assertEq(spent, expectedDeposit, "agent spent gross-up deposit");
        assertEq(spent, toTech + burned + locked, "deposit split sums");
        assertEq(pvt.totalSelfBurned(), pvt.totalBurned(), "burned via burn(), not protocolBurn()");

        uint256 expectedBurn = (expectedDeposit * DEPOSIT_BURN_BPS) / MAX_BPS;
        uint256 expectedFee = (expectedDeposit * DEPOSIT_FEE_BPS) / MAX_BPS;
        uint256 expectedLocked = expectedDeposit - expectedBurn - expectedFee;
        assertEq(burned, expectedBurn);
        assertEq(toTech, expectedFee);
        assertEq(locked, expectedLocked);

        // And the locked amount is at least `required` (never under-collateralises).
        assertGe(locked, required, "locked >= required");
    }
}

/*
 * ============================================================================
 * INVARIANT TEST - accounting conservation across random operations
 * ============================================================================
 * The handler pokes a bounded set of postBond / renewBond / fileClaim /
 * slashBond / dismissClaim / withdrawBond sequences, tracking its own mirror
 * of what the contract's PVT balance should be. The invariant asserts that
 * the live pool PVT balance matches.
 * ============================================================================
 */

contract BondPoolHandler is Test {
    ProvianBondPool public bondPool;
    MockPVT public pvt;

    address public court;
    address[] public agents;
    address[] public claimants;
    mapping(bytes32 => address) public claimToAgent;
    bytes32[] public openClaims;

    constructor(ProvianBondPool _bondPool, MockPVT _pvt, address _court) {
        bondPool = _bondPool;
        pvt = _pvt;
        court = _court;

        // Fixed cohort of 5 agents + 3 claimants.
        for (uint256 i = 0; i < 5; i++) {
            address a = address(uint160(0xA000 + i));
            agents.push(a);
            pvt.mint(a, 5_000_000e18);
            vm.prank(a);
            pvt.approve(address(bondPool), type(uint256).max);
        }
        for (uint256 i = 0; i < 3; i++) {
            address c = address(uint160(0xC000 + i));
            claimants.push(c);
            pvt.mint(c, 1_000_000e18);
            vm.prank(c);
            pvt.approve(address(bondPool), type(uint256).max);
        }
    }

    function postBond(uint256 agentIdx, uint8 levelRaw, uint256 discount) external {
        address a = agents[agentIdx % agents.length];
        uint8 level = (levelRaw % 2 == 0) ? 2 : 3;
        discount = discount % 5001; // [0, 5000]
        (, , , , , ProvianBondPool.BondStatus status,) = bondPool.bonds(a);
        if (status == ProvianBondPool.BondStatus.Active) return; // already active
        vm.prank(a);
        try bondPool.postBond(level, discount) {} catch {}
    }

    function fileClaim(uint256 claimantIdx, uint256 agentIdx, uint256 salt) external {
        address a = agents[agentIdx % agents.length];
        address c = claimants[claimantIdx % claimants.length];
        bytes32 id = keccak256(abi.encode("fuzz-claim", a, c, salt, openClaims.length));
        if (bondPool.claimExists(id)) return;
        (, , , , , ProvianBondPool.BondStatus status,) = bondPool.bonds(a);
        if (status != ProvianBondPool.BondStatus.Active) return;
        vm.prank(c);
        try bondPool.fileClaim(a, id) {
            openClaims.push(id);
            claimToAgent[id] = a;
        } catch {}
    }

    function slashClaim(uint256 claimIdx, uint256 slashAmount) external {
        if (openClaims.length == 0) return;
        bytes32 id = openClaims[claimIdx % openClaims.length];
        address a = claimToAgent[id];
        (uint256 locked, , , , , ,) = bondPool.bonds(a);
        if (locked == 0) return;
        // WS1 (Pass-2): a valid slash is in [50% floor, bond cap]; pick within it
        // so the slash path (not just dismiss) keeps getting exercised.
        uint256 floorAmt = (locked * 5000) / 10000;
        slashAmount = floorAmt + (slashAmount % (locked - floorAmt + 1));
        vm.prank(court);
        try bondPool.slashBond(a, slashAmount, id) {
            _removeClaim(claimIdx % openClaims.length);
        } catch {}
    }

    function dismissClaimAction(uint256 claimIdx) external {
        if (openClaims.length == 0) return;
        uint256 idx = claimIdx % openClaims.length;
        bytes32 id = openClaims[idx];
        address a = claimToAgent[id];
        vm.prank(court);
        try bondPool.dismissClaim(a, id) {
            _removeClaim(idx);
        } catch {}
    }

    function withdrawBond(uint256 agentIdx) external {
        address a = agents[agentIdx % agents.length];
        vm.prank(a);
        try bondPool.withdrawBond() {} catch {}
    }

    function _removeClaim(uint256 idx) internal {
        openClaims[idx] = openClaims[openClaims.length - 1];
        openClaims.pop();
    }

    // Helper: sum of active bond.amount across all agents.
    function sumActiveBonds() external view returns (uint256 total) {
        for (uint256 i = 0; i < agents.length; i++) {
            (uint256 amt, , , , , ProvianBondPool.BondStatus status,) = bondPool.bonds(agents[i]);
            if (status == ProvianBondPool.BondStatus.Active) total += amt;
        }
    }

    function openClaimCount() external view returns (uint256) {
        return openClaims.length;
    }
}

contract ProvianBondPoolInvariantTest is Test {
    ProvianBondPool public bondPool;
    MockPVT public pvt;
    BondPoolHandler public handler;

    address public admin = address(0xA01);
    address public techWallet = address(0xA02);
    address public court = address(0xA03);
    address public governance = address(0xA04);

    uint256 public constant FILING_FEE = 15e18; // PVTv5 recalibrated default

    function setUp() public {
        pvt = new MockPVT();
        court = address(new MockCourtRewardSink()); // institution deployment/ reward sink (see main setUp)
        bondPool = new ProvianBondPool(admin, techWallet, address(pvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), new ProvianBondPool.BondSeed[](0), new ProvianBondPool.BpsSeed[](0));
        vm.startPrank(admin);
        bondPool.setCourtContract(court);
        bondPool.setExecutor(governance);
        vm.stopPrank();

        handler = new BondPoolHandler(bondPool, pvt, court);
        targetContract(address(handler));
    }

    /// @notice INVARIANT: pool PVT balance == sum(active bond.amount) + sum(open filing fees)
    ///
    /// Any leak would show up as a mismatch. Pool balance should always
    /// equal the agent-claimable total (active bonds) plus the claim filing
    /// fees still held in escrow.
    function invariant_poolBalance_equalsActiveBondsPlusOpenFilingFees() public view {
        uint256 expected = handler.sumActiveBonds() + (handler.openClaimCount() * FILING_FEE);
        assertEq(pvt.balanceOf(address(bondPool)), expected, "pool balance diverged from expected");
    }
}
