// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ProvianRecourseBondPool.sol";
import "./MockTokens.sol";
import "./MockEpochClock.sol";
import "./MockIssuanceIndex.sol";

contract RecourseProvianRecourseBondPoolTest is Test {
    ProvianRecourseBondPool public bondPool;
    MockPVT public pvt;

    address public admin = address(0xA01);
    address public techWallet = address(0xA02);
    address public court = address(0xA03);
    address public governance = address(0xA04);
    address public newAdmin = address(0xA05);
    address public agent = address(0xB01);
    address public claimant = address(0xB02);
    address public rando = address(0xC01);

    uint256 public constant LEVEL_2_BASE = 750e18;
    uint256 public constant LEVEL_3_BASE = 3000e18;
    uint256 public constant MAX_TRUST_DISCOUNT = 5000;
    uint256 public constant MAX_BPS = 10000;

    uint256 public constant DEPOSIT_BURN_BPS = 200;
    uint256 public constant DEPOSIT_FEE_BPS = 100;
    uint256 public constant RENEWAL_BURN_BPS = 100;
    uint256 public constant RENEWAL_FEE_BPS = 50;
    uint256 public constant SLASH_BURN_BPS = 2000;
    uint256 public constant SLASH_PAYOUT_BPS = 8000;

    uint256 public constant MIN_SLASH_PAYOUT_BPS = 5000;
    uint256 public constant FILING_FEE = 15e18;
    uint256 public constant CLAIMS_PROCESSING_FEE = 30e18;

    uint256 public constant RENEWAL_PERIOD = 180 days;
    uint256 public constant RENEWAL_GRACE = 30 days;
    uint256 public constant ABANDONMENT_PERIOD = 365 days;

    uint256 public constant FUND_AMOUNT = 1_000_000e18;

    function setUp() public {
        pvt = new MockPVT();

        court = address(new MockCourtRewardSink());
        bondPool = new ProvianRecourseBondPool(admin, techWallet, address(pvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), RecourseInstitutionSeeds.SeedManifest(address(0),0,bytes32(0),bytes32(0),0,0), new ProvianRecourseBondPool.BpsSeed[](0));

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

    function _grossUpDeposit(uint256 required) internal pure returns (uint256) {
        uint256 remainingBps = MAX_BPS - DEPOSIT_BURN_BPS - DEPOSIT_FEE_BPS;
        return (required * MAX_BPS + remainingBps - 1) / remainingBps;
    }

    function test_constructor_setsAdminTechWalletPvt() public view {
        assertEq(bondPool.admin(), admin);
        assertEq(bondPool.provianTechWallet(), techWallet);
        assertEq(address(bondPool.pvt()), address(pvt));
    }
    function testSeededBondObligationExistsBeforeBackingAndRemainsExact() public {
        ProvianRecourseBondPool.BondSeed[] memory seeds = new ProvianRecourseBondPool.BondSeed[](1);
        seeds[0] = ProvianRecourseBondPool.BondSeed(agent, 750 ether + 1, 2, 1, 1, 180 days + 1, 750 ether);
        bytes memory data = abi.encode(seeds[0]);
        bytes32 domain = sha256(abi.encode("Provian custody snapshot", block.chainid, address(pvt), uint8(2), address(bondPool), uint256(1), bytes32(uint256(1))));
        bytes32 leaf = sha256(abi.encode(domain, uint256(0), sha256(data)));
        ProvianRecourseBondPool carried = new ProvianRecourseBondPool(admin, techWallet, address(pvt),
            address(new MockEpochClock(0)), address(new MockIssuanceIndex()),
            RecourseInstitutionSeeds.SeedManifest(address(bondPool),1,bytes32(uint256(1)),leaf,1,seeds[0].amount), new ProvianRecourseBondPool.BpsSeed[](0));
        assertFalse(carried.custodySeedsReady());
        vm.prank(agent); vm.expectRevert(); carried.postBond(2, 0);
        carried.importCustodySeed(0, data, new bytes32[](0));
        carried.importCustodySeed(0, data, new bytes32[](0));
        assertTrue(carried.custodySeedsReady());
        assertEq(carried.importedCustodySeeds(), 1);
        assertEq(carried.encumberedPVT(), 750 ether + 1);
        vm.prank(agent); vm.expectRevert(); carried.withdrawBond();
        assertEq(carried.encumberedPVT(), 750 ether + 1);
        pvt.mint(address(carried), 750 ether + 18);
        vm.prank(agent); carried.withdrawBond();
        assertEq(carried.encumberedPVT(), 0);
        assertEq(pvt.balanceOf(address(carried)), 17);
    }
    function testEncumbranceTracksBondAndFilingDepositButNotDonations() public {
        pvt.mint(address(bondPool), 17 ether);
        vm.prank(agent); bondPool.postBond(2, 0);
        assertEq(bondPool.encumberedPVT(), pvt.balanceOf(address(bondPool)) - 17 ether);
        vm.prank(agent); bondPool.renewBond();
        assertEq(bondPool.encumberedPVT(), pvt.balanceOf(address(bondPool)) - 17 ether);
        bytes32 id = keccak256("custody obligation TEST ONLY");
        vm.prank(claimant); bondPool.fileClaim(agent, id);
        assertEq(bondPool.encumberedPVT(), pvt.balanceOf(address(bondPool)) - 17 ether);
        vm.prank(court); bondPool.dismissClaimUnadjudicated(agent, id);
        assertEq(bondPool.encumberedPVT(), pvt.balanceOf(address(bondPool)) - 17 ether);
        vm.prank(agent); bondPool.withdrawBond();
        assertEq(bondPool.encumberedPVT(), 0);
        assertEq(pvt.balanceOf(address(bondPool)), 17 ether);
    }

    function test_constructor_rejectsZeroAddresses() public {
        address clk = address(new MockEpochClock(0));
        address idx = address(new MockIssuanceIndex());
        vm.expectRevert(ProvianRecourseBondPool.InvalidAddress.selector);
        new ProvianRecourseBondPool(address(0), techWallet, address(pvt), clk, idx, RecourseInstitutionSeeds.SeedManifest(address(0),0,bytes32(0),bytes32(0),0,0), new ProvianRecourseBondPool.BpsSeed[](0));
        vm.expectRevert(ProvianRecourseBondPool.InvalidAddress.selector);
        new ProvianRecourseBondPool(admin, address(0), address(pvt), clk, idx, RecourseInstitutionSeeds.SeedManifest(address(0),0,bytes32(0),bytes32(0),0,0), new ProvianRecourseBondPool.BpsSeed[](0));
        vm.expectRevert(ProvianRecourseBondPool.InvalidAddress.selector);
        new ProvianRecourseBondPool(admin, techWallet, address(0), clk, idx, RecourseInstitutionSeeds.SeedManifest(address(0),0,bytes32(0),bytes32(0),0,0), new ProvianRecourseBondPool.BpsSeed[](0));
        vm.expectRevert(ProvianRecourseBondPool.InvalidAddress.selector);
        new ProvianRecourseBondPool(admin, techWallet, address(pvt), address(0), idx, RecourseInstitutionSeeds.SeedManifest(address(0),0,bytes32(0),bytes32(0),0,0), new ProvianRecourseBondPool.BpsSeed[](0));

        vm.expectRevert(ProvianRecourseBondPool.InvalidAddress.selector);
        new ProvianRecourseBondPool(admin, techWallet, address(pvt), clk, address(0), RecourseInstitutionSeeds.SeedManifest(address(0),0,bytes32(0),bytes32(0),0,0), new ProvianRecourseBondPool.BpsSeed[](0));
    }

    function test_constants_matchTestMirror() public view {

        assertEq(bondPool.level2BaseBond(), LEVEL_2_BASE);
        assertEq(bondPool.level3BaseBond(), LEVEL_3_BASE);
        assertEq(bondPool.MAX_TRUST_DISCOUNT(), MAX_TRUST_DISCOUNT);
        assertEq(bondPool.MAX_BPS(), MAX_BPS);
    }

    function test_setCourtContract_oneTimeOnly() public {

        ProvianRecourseBondPool fresh = new ProvianRecourseBondPool(admin, techWallet, address(pvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), RecourseInstitutionSeeds.SeedManifest(address(0),0,bytes32(0),bytes32(0),0,0), new ProvianRecourseBondPool.BpsSeed[](0));
        vm.prank(admin);
        fresh.setCourtContract(court);
        vm.prank(admin);
        vm.expectRevert(ProvianRecourseBondPool.CourtAlreadySet.selector);
        fresh.setCourtContract(court);
    }

    function test_setCourtContract_onlyAdmin() public {
        ProvianRecourseBondPool fresh = new ProvianRecourseBondPool(admin, techWallet, address(pvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), RecourseInstitutionSeeds.SeedManifest(address(0),0,bytes32(0),bytes32(0),0,0), new ProvianRecourseBondPool.BpsSeed[](0));
        vm.prank(rando);
        vm.expectRevert(ProvianRecourseBondPool.OnlyAdmin.selector);
        fresh.setCourtContract(court);
    }

    function test_setExecutor_oneTimeOnly() public {
        ProvianRecourseBondPool fresh = new ProvianRecourseBondPool(admin, techWallet, address(pvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), RecourseInstitutionSeeds.SeedManifest(address(0),0,bytes32(0),bytes32(0),0,0), new ProvianRecourseBondPool.BpsSeed[](0));
        vm.prank(admin);
        fresh.setExecutor(governance);
        vm.prank(admin);
        vm.expectRevert(ProvianRecourseBondPool.ExecutorAlreadySet.selector);
        fresh.setExecutor(governance);
    }

    function test_transferAdmin_rotates() public {
        vm.prank(admin);
        bondPool.transferAdmin(newAdmin);
        assertEq(bondPool.admin(), newAdmin);

        ProvianRecourseBondPool fresh = new ProvianRecourseBondPool(admin, techWallet, address(pvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), RecourseInstitutionSeeds.SeedManifest(address(0),0,bytes32(0),bytes32(0),0,0), new ProvianRecourseBondPool.BpsSeed[](0));
        vm.prank(admin);
        fresh.transferAdmin(newAdmin);
        vm.prank(admin);
        vm.expectRevert(ProvianRecourseBondPool.OnlyAdmin.selector);
        fresh.setCourtContract(court);
    }

    function test_transferAdmin_rejectsZero() public {
        vm.prank(admin);
        vm.expectRevert(ProvianRecourseBondPool.InvalidAddress.selector);
        bondPool.transferAdmin(address(0));
    }

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

        assertEq(expectedBurn + expectedFee + expectedLocked, expectedDeposit, "deposit split sums");

        assertEq(pvt.balanceOf(agent), agentBefore - expectedDeposit, "agent debited totalDeposit");
        assertEq(pvt.balanceOf(techWallet), techBefore + expectedFee, "techWallet credited fee");
        assertEq(pvt.totalBurned(), burnedBefore + expectedBurn, "burn recorded");
        assertEq(pvt.totalSelfBurned(), pvt.totalBurned(), "burned via burn(), not protocolBurn()");
        assertEq(pvt.balanceOf(address(bondPool)), expectedLocked, "pool holds locked portion");

        (uint256 amt, uint8 level, , , uint256 deadline, ProvianRecourseBondPool.BondStatus status, uint256 pending) =
            bondPool.bonds(agent);
        assertEq(amt, expectedLocked);
        assertEq(level, 2);
        assertEq(deadline, block.timestamp + RENEWAL_PERIOD);
        assertEq(uint8(status), uint8(ProvianRecourseBondPool.BondStatus.Active));
        assertEq(pending, 0);
    }

    function test_postBond_level3_base20k() public {
        uint256 required = bondPool.getRequiredBond(3, 0);
        assertEq(required, LEVEL_3_BASE, "Level 3 base bond");
        vm.prank(agent);
        bondPool.postBond(3, 0);
        (uint256 amt, uint8 level, , , , ,) = bondPool.bonds(agent);

        assertApproxEqAbs(amt, required, 2);
        assertEq(level, 3);
    }

    function test_postBond_withMaxTrustDiscount_halvesRequired() public {

        uint256 required = bondPool.getRequiredBond(2, MAX_TRUST_DISCOUNT);
        assertEq(required, LEVEL_2_BASE / 2, "50% discount halves required");
    }

    function test_postBond_rejectsInvalidLevel() public {
        vm.prank(agent);
        vm.expectRevert(ProvianRecourseBondPool.InvalidAutonomyLevel.selector);
        bondPool.postBond(1, 0);
        vm.prank(agent);
        vm.expectRevert(ProvianRecourseBondPool.InvalidAutonomyLevel.selector);
        bondPool.postBond(4, 0);
    }

    function test_postBond_rejectsInvalidTrustDiscount() public {

        vm.prank(agent);
        vm.expectRevert(ProvianRecourseBondPool.InvalidTrustDiscount.selector);
        bondPool.postBond(2, 5001);
    }

    function test_postBond_rejectsDuplicateActiveBond() public {
        vm.prank(agent);
        bondPool.postBond(2, 0);
        vm.prank(agent);
        vm.expectRevert(ProvianRecourseBondPool.BondAlreadyExists.selector);
        bondPool.postBond(2, 0);
    }

    function test_postBond_allowsPostAfterWithdrawal() public {

        vm.prank(agent);
        bondPool.postBond(2, 0);
        vm.prank(agent);
        bondPool.withdrawBond();
        vm.prank(agent);
        bondPool.postBond(2, 0);
        (, , , , , ProvianRecourseBondPool.BondStatus status,) = bondPool.bonds(agent);
        assertEq(uint8(status), uint8(ProvianRecourseBondPool.BondStatus.Active));
    }

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
        vm.expectRevert(ProvianRecourseBondPool.BondNotActive.selector);
        bondPool.renewBond();
    }

    function test_PINNED_renewBond_zeroedByFullSlash_trapsAgent() public {

        vm.prank(agent);
        bondPool.postBond(2, 0);
        (uint256 locked, , , , , ,) = bondPool.bonds(agent);

        bytes32 claimId = keccak256("pinned-claim");
        vm.prank(claimant);
        bondPool.fileClaim(agent, claimId);

        vm.prank(court);
        bondPool.slashBond(agent, locked, claimId);

        (uint256 amtAfter, , , , , ProvianRecourseBondPool.BondStatus statusAfter,) = bondPool.bonds(agent);
        assertEq(amtAfter, 0, "bond drained to zero");
        assertEq(uint8(statusAfter), uint8(ProvianRecourseBondPool.BondStatus.Active), "status still Active");

        vm.prank(agent);
        vm.expectRevert(ProvianRecourseBondPool.InsufficientBond.selector);
        bondPool.renewBond();

        vm.prank(agent);
        bondPool.withdrawBond();
        (, , , , , ProvianRecourseBondPool.BondStatus finalStatus,) = bondPool.bonds(agent);
        assertEq(uint8(finalStatus), uint8(ProvianRecourseBondPool.BondStatus.Withdrawn));
    }

    function test_topUpBond_restoresErodedCollateral_noBurnNoFee() public {
        vm.prank(agent);
        bondPool.postBond(2, 0);

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

        (uint256 restored, , , , , ,) = bondPool.bonds(agent);
        assertEq(restored, requiredLock, "collateral restored to requirement");
        assertEq(pvt.balanceOf(agent), agentBefore - shortfall, "agent debited exactly the top-up");
        assertEq(pvt.balanceOf(address(bondPool)), poolBefore + shortfall, "pool holds all of it");
        assertEq(pvt.balanceOf(techWallet), techBefore, "NO fee on top-up");
        assertEq(pvt.totalBurned(), burnedBefore, "NO burn on top-up");
    }

    function test_topUpBond_emitsEvent() public {
        vm.prank(agent);
        bondPool.postBond(2, MAX_TRUST_DISCOUNT);
        (uint256 locked, , , , , ,) = bondPool.bonds(agent);

        vm.expectEmit(true, false, false, true, address(bondPool));
        emit ProvianRecourseBondPool.BondToppedUp(agent, 10e18, locked + 10e18);
        vm.prank(agent);
        bondPool.topUpBond(10e18);
    }

    function test_topUpBond_zeroAmountReverts() public {
        vm.prank(agent);
        bondPool.postBond(2, 0);
        vm.prank(agent);
        vm.expectRevert(ProvianRecourseBondPool.InvalidAmount.selector);
        bondPool.topUpBond(0);
    }

    function test_topUpBond_shortfallBounded_neverAboveRequirement() public {

        vm.prank(agent);
        bondPool.postBond(2, 0);
        vm.prank(agent);
        vm.expectRevert(ProvianRecourseBondPool.TopUpExceedsRequirement.selector);
        bondPool.topUpBond(1);

        vm.prank(claimant);
        bondPool.postBond(2, MAX_TRUST_DISCOUNT);
        (uint256 locked, , , , , ,) = bondPool.bonds(claimant);
        uint256 gap = bondPool.getRequiredBond(2, 0) - locked;

        vm.prank(claimant);
        vm.expectRevert(ProvianRecourseBondPool.TopUpExceedsRequirement.selector);
        bondPool.topUpBond(gap + 1);

        vm.prank(claimant);
        bondPool.topUpBond(gap);
        (uint256 restored, , , , , ,) = bondPool.bonds(claimant);
        assertEq(restored, bondPool.getRequiredBond(2, 0));
    }

    function test_topUpBond_revertsIfNotActive() public {

        vm.prank(agent);
        vm.expectRevert(ProvianRecourseBondPool.BondNotActive.selector);
        bondPool.topUpBond(1e18);

        vm.prank(agent);
        bondPool.postBond(2, 0);
        vm.prank(agent);
        bondPool.withdrawBond();
        vm.prank(agent);
        vm.expectRevert(ProvianRecourseBondPool.BondNotActive.selector);
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

        vm.prank(agent);
        bondPool.postBond(2, MAX_TRUST_DISCOUNT);
        (uint256 locked, , , , , ,) = bondPool.bonds(agent);
        uint256 gap = bondPool.getRequiredBond(2, 0) - locked;
        vm.prank(agent);
        bondPool.topUpBond(gap);

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
        bondPool.renewBond();
        (uint256 amtAfter, , , , , ProvianRecourseBondPool.BondStatus statusAfter,) = bondPool.bonds(agent);
        assertGt(amtAfter, 0);
        assertEq(uint8(statusAfter), uint8(ProvianRecourseBondPool.BondStatus.Active));
    }

    function test_topUpBond_insufficientAllowanceReverts() public {
        vm.prank(agent);
        bondPool.postBond(2, MAX_TRUST_DISCOUNT);
        vm.prank(agent);
        pvt.approve(address(bondPool), 0);
        vm.prank(agent);
        vm.expectRevert();
        bondPool.topUpBond(1e18);
    }

    function test_withdrawBond_returnsLockedAmount() public {
        vm.prank(agent);
        bondPool.postBond(2, 0);
        (uint256 locked, , , , , ,) = bondPool.bonds(agent);
        uint256 agentBefore = pvt.balanceOf(agent);

        vm.prank(agent);
        bondPool.withdrawBond();

        assertEq(pvt.balanceOf(agent), agentBefore + locked, "agent received bond back");
        assertEq(pvt.balanceOf(address(bondPool)), 0, "pool drained for this agent");

        (uint256 amtAfter, , , , , ProvianRecourseBondPool.BondStatus status,) = bondPool.bonds(agent);
        assertEq(amtAfter, 0);
        assertEq(uint8(status), uint8(ProvianRecourseBondPool.BondStatus.Withdrawn));
    }

    function test_withdrawBond_blockedByPendingClaims() public {
        vm.prank(agent);
        bondPool.postBond(2, 0);
        vm.prank(claimant);
        bondPool.fileClaim(agent, keccak256("claim-1"));
        vm.prank(agent);
        vm.expectRevert(ProvianRecourseBondPool.ClaimsPending.selector);
        bondPool.withdrawBond();
    }

    function test_withdrawBond_revertsIfNotActive() public {
        vm.prank(agent);
        vm.expectRevert(ProvianRecourseBondPool.BondNotActive.selector);
        bondPool.withdrawBond();
    }

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

        vm.prank(agent);
        bondPool.postBond(2, 0);
        vm.prank(agent);
        vm.expectRevert(ProvianRecourseBondPool.SelfClaimNotAllowed.selector);
        bondPool.fileClaim(agent, keccak256("self"));
    }

    function test_fileClaim_duplicateClaimIdReverts() public {
        vm.prank(agent);
        bondPool.postBond(2, 0);
        bytes32 id = keccak256("dup");
        vm.prank(claimant);
        bondPool.fileClaim(agent, id);
        vm.prank(rando);
        vm.expectRevert(ProvianRecourseBondPool.ClaimAlreadyExists.selector);
        bondPool.fileClaim(agent, id);
    }

    function test_fileClaim_revertsIfBondNotActive() public {
        vm.prank(claimant);
        vm.expectRevert(ProvianRecourseBondPool.BondNotActive.selector);
        bondPool.fileClaim(agent, keccak256("no-bond"));
    }

    function test_slashBond_onlyCourt_reverts() public {
        vm.prank(agent);
        bondPool.postBond(2, 0);
        bytes32 id = keccak256("slash-onlycourt");
        vm.prank(claimant);
        bondPool.fileClaim(agent, id);

        address[4] memory nonCourt = [admin, governance, agent, rando];
        for (uint256 i = 0; i < nonCourt.length; i++) {
            vm.prank(nonCourt[i]);
            vm.expectRevert(ProvianRecourseBondPool.OnlyCourt.selector);
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

        uint256 slashAmount = 500e18;
        uint256 expectedClaimant = (slashAmount * SLASH_PAYOUT_BPS) / MAX_BPS;
        uint256 expectedBurn = slashAmount - expectedClaimant;
        assertEq(expectedClaimant + expectedBurn, slashAmount, "split sums to slashAmount");

        uint256 claimantBefore = pvt.balanceOf(claimant);
        uint256 techBefore = pvt.balanceOf(techWallet);
        uint256 courtBefore = pvt.balanceOf(court);
        uint256 burnedBefore = pvt.totalBurned();

        vm.prank(court);
        bondPool.slashBond(agent, slashAmount, id);

        assertEq(
            pvt.balanceOf(claimant),
            claimantBefore + expectedClaimant + FILING_FEE,
            "claimant gets payout + filing fee back"
        );
        assertEq(pvt.totalBurned(), burnedBefore + expectedBurn, "burn recorded");
        assertEq(pvt.totalSelfBurned(), pvt.totalBurned(), "burned via burn(), not protocolBurn()");

        assertEq(pvt.balanceOf(techWallet), techBefore, "tech no longer receives the processing fee");
        assertEq(pvt.balanceOf(court) - courtBefore, CLAIMS_PROCESSING_FEE, "panel (Court) got the processing fee");

        (uint256 amtAfter, , , , , , uint256 pending) = bondPool.bonds(agent);
        assertEq(amtAfter, locked - slashAmount - CLAIMS_PROCESSING_FEE, "bond reduced by slash + proc fee");
        assertEq(pending, 0);
    }

    function test_slashBond_rejectsAboveCap() public {
        vm.prank(agent);
        bondPool.postBond(2, 0);
        (uint256 locked, , , , , ,) = bondPool.bonds(agent);
        bytes32 id = keccak256("slash-over-cap");
        vm.prank(claimant);
        bondPool.fileClaim(agent, id);

        vm.prank(court);
        vm.expectRevert(ProvianRecourseBondPool.SlashAmountOutOfBounds.selector);
        bondPool.slashBond(agent, locked + 1, id);
    }

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
        bondPool.slashBond(agent, locked, id);

        uint256 expectedClaimant = (locked * SLASH_PAYOUT_BPS) / MAX_BPS;
        uint256 expectedBurn = locked - expectedClaimant;
        assertEq(pvt.balanceOf(claimant), claimantBefore + expectedClaimant + FILING_FEE);
        assertEq(pvt.totalBurned(), burnedBefore + expectedBurn);
        assertEq(pvt.totalSelfBurned(), pvt.totalBurned(), "burned via burn(), not protocolBurn()");

        (uint256 amtAfter, , , , , , uint256 pending) = bondPool.bonds(agent);
        assertEq(amtAfter, 0, "full slash drains the bond");
        assertEq(pending, 0);
    }

    function test_slashBond_rejectsBelowFloor() public {
        vm.prank(agent);
        bondPool.postBond(2, 0);
        (uint256 locked, , , , , ,) = bondPool.bonds(agent);
        uint256 floorAmt = (locked * MIN_SLASH_PAYOUT_BPS) / MAX_BPS;
        bytes32 id = keccak256("slash-under-floor");
        vm.prank(claimant);
        bondPool.fileClaim(agent, id);

        vm.prank(court);
        vm.expectRevert(ProvianRecourseBondPool.SlashAmountOutOfBounds.selector);
        bondPool.slashBond(agent, floorAmt - 1, id);
    }

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
        bondPool.slashBond(agent, floorAmt, id);

        uint256 expectedClaimant = (floorAmt * SLASH_PAYOUT_BPS) / MAX_BPS;
        assertEq(pvt.balanceOf(claimant), claimantBefore + expectedClaimant + FILING_FEE);

        (uint256 amtAfter, , , , , , uint256 pending) = bondPool.bonds(agent);

        assertEq(amtAfter, locked - floorAmt - CLAIMS_PROCESSING_FEE);
        assertEq(pending, 0);
    }

    function test_PINNED_slashBond_skipsProcessingFeeWhenInsufficient() public {

        vm.prank(agent);
        bondPool.postBond(2, 0);
        (uint256 locked, , , , , ,) = bondPool.bonds(agent);
        bytes32 id = keccak256("slash-tiny-remainder");
        vm.prank(claimant);
        bondPool.fileClaim(agent, id);

        uint256 slashAmount = locked - 20e18;
        uint256 techBefore = pvt.balanceOf(techWallet);
        uint256 courtBefore = pvt.balanceOf(court);
        vm.prank(court);
        bondPool.slashBond(agent, slashAmount, id);

        assertEq(pvt.balanceOf(techWallet), techBefore, "tech received NO processing fee (insufficient bond)");

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

        vm.prank(court);
        bondPool.slashBond(agent, locked, id);

        vm.prank(court);
        vm.expectRevert(ProvianRecourseBondPool.ClaimAlreadyResolved.selector);
        bondPool.slashBond(agent, locked, id);
    }

    function test_slashBond_rejectsMismatchedAgent() public {

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
        bondPool.fileClaim(agent, id);

        vm.prank(court);
        vm.expectRevert(ProvianRecourseBondPool.InvalidAddress.selector);
        bondPool.slashBond(otherAgent, 100e18, id);
    }

    function test_slashBond_rejectsUnknownClaimId() public {
        vm.prank(agent);
        bondPool.postBond(2, 0);
        vm.prank(court);
        vm.expectRevert(ProvianRecourseBondPool.ClaimNotFound.selector);
        bondPool.slashBond(agent, 100e18, keccak256("never-filed"));
    }

    function test_slashBond_emitsDowngradeWhenBelowRequired() public {

        vm.prank(agent);
        bondPool.postBond(3, 0);
        (uint256 locked, , , , , ,) = bondPool.bonds(agent);
        bytes32 id = keccak256("downgrade");
        vm.prank(claimant);
        bondPool.fileClaim(agent, id);

        uint256 slashAmount = locked;

        vm.expectEmit(true, false, false, false, address(bondPool));
        emit ProvianRecourseBondPool.AutonomyDowngrade(agent, 0, 0);
        vm.prank(court);
        bondPool.slashBond(agent, slashAmount, id);

        (uint256 amtAfter, , , , , ,) = bondPool.bonds(agent);
        assertLt(amtAfter, LEVEL_3_BASE, "bond fell below level-3 requirement");
    }

    function test_dismissClaim_onlyCourt_reverts() public {
        vm.prank(agent);
        bondPool.postBond(2, 0);
        bytes32 id = keccak256("dismiss-onlycourt");
        vm.prank(claimant);
        bondPool.fileClaim(agent, id);

        address[4] memory nonCourt = [admin, governance, agent, rando];
        for (uint256 i = 0; i < nonCourt.length; i++) {
            vm.prank(nonCourt[i]);
            vm.expectRevert(ProvianRecourseBondPool.OnlyCourt.selector);
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
        vm.expectRevert(ProvianRecourseBondPool.ClaimAlreadyResolved.selector);
        bondPool.dismissClaim(agent, id);
    }

    function test_processAbandonment_burnsEntireBondAfterWindow() public {
        vm.prank(agent);
        bondPool.postBond(2, 0);
        (uint256 locked, , , , , ,) = bondPool.bonds(agent);

        vm.warp(block.timestamp + RENEWAL_PERIOD + RENEWAL_GRACE + ABANDONMENT_PERIOD + 1);

        uint256 burnedBefore = pvt.totalBurned();
        vm.prank(rando);
        bondPool.processAbandonment(agent);

        assertEq(pvt.totalBurned(), burnedBefore + locked, "entire bond burned");
        assertEq(pvt.totalSelfBurned(), pvt.totalBurned(), "burned via burn(), not protocolBurn()");
        (uint256 amtAfter, , , , , ProvianRecourseBondPool.BondStatus status,) = bondPool.bonds(agent);
        assertEq(amtAfter, 0);
        assertEq(uint8(status), uint8(ProvianRecourseBondPool.BondStatus.Abandoned));
    }

    function test_processAbandonment_revertsBeforeWindow() public {
        vm.prank(agent);
        bondPool.postBond(2, 0);

        vm.warp(block.timestamp + RENEWAL_PERIOD + RENEWAL_GRACE + 1);
        vm.prank(rando);
        vm.expectRevert(ProvianRecourseBondPool.GracePeriodNotExpired.selector);
        bondPool.processAbandonment(agent);
    }

    function test_processAbandonment_revertsIfNotActive() public {
        vm.prank(rando);
        vm.expectRevert(ProvianRecourseBondPool.BondNotActive.selector);
        bondPool.processAbandonment(agent);
    }

    function _armClockHere() internal returns (uint256 startsAt) {
        startsAt = block.timestamp;
        MockEpochClock(address(bondPool.epochClock())).arm(uint64(startsAt));
    }

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
        vm.expectRevert(ProvianRecourseBondPool.OnlyExecutor.selector);
        bondPool.scheduleDepositBurnBps(1, 300);
        vm.prank(admin);
        vm.expectRevert(ProvianRecourseBondPool.OnlyExecutor.selector);
        bondPool.scheduleDepositBurnBps(1, 300);
    }

    function test_scheduleDepositBurnBps_enforcesCap() public {
        vm.prank(governance);
        vm.expectRevert(ProvianRecourseBondPool.CostOutOfDomain.selector);
        bondPool.scheduleDepositBurnBps(1, 1001);
    }

    function test_scheduleSlashShares_mustSumToMaxBps() public {

        vm.prank(governance);
        vm.expectRevert(ProvianRecourseBondPool.SlashBpsInvariant.selector);
        bondPool.scheduleSlashShares(1, 2000, 7999);
    }

    function test_scheduleSlashShares_validPartitionActivatesNextEpoch() public {
        uint256 startsAt = _armClockHere();
        vm.prank(governance);
        bondPool.scheduleSlashShares(1, 3000, 7000);

        (bool e0,,) = bondPool.activeSlashShares();
        assertFalse(e0);
        assertEq(bondPool.slashBurnBps(), 2000);

        vm.warp(startsAt + 7 days);
        (bool e1, uint256 burn, uint256 payout) = bondPool.activeSlashShares();
        assertTrue(e1);
        assertEq(burn, 3000);
        assertEq(payout, 7000);
    }

    function test_scheduleSlashShares_rejectsBelowVictimFloor() public {

        vm.prank(governance);
        vm.expectRevert(ProvianRecourseBondPool.SlashPayoutBelowFloor.selector);
        bondPool.scheduleSlashShares(1, 6000, 4000);
    }

    function test_scheduleBaseBonds_happyAndReflectedInRequired() public {
        uint256 startsAt = _armClockHere();
        vm.prank(governance);
        bondPool.scheduleBaseBonds(1, 1000e18, 2000e18);

        assertEq(bondPool.getRequiredBond(2, 0), 750e18);

        vm.warp(startsAt + 7 days);
        (bool ok, uint256 l2, uint256 l3) = bondPool.activeBaseBonds();
        assertTrue(ok);
        assertEq(l2, 1000e18);
        assertEq(l3, 2000e18);
        assertEq(bondPool.getRequiredBond(2, 0), 1000e18);
        assertEq(bondPool.getRequiredBond(3, 0), 2000e18);
    }

    function test_scheduleBaseBonds_boundsAndL3GteL2() public {
        vm.prank(governance);
        vm.expectRevert(ProvianRecourseBondPool.BaseBondOutOfBounds.selector);
        bondPool.scheduleBaseBonds(1, 50e18, 3000e18);
        vm.prank(governance);
        vm.expectRevert(ProvianRecourseBondPool.BaseBondOutOfBounds.selector);
        bondPool.scheduleBaseBonds(1, 1000e18, 900e18);
    }

    function test_scheduleBaseBonds_onlyExecutor() public {
        vm.prank(rando);
        vm.expectRevert(ProvianRecourseBondPool.OnlyExecutor.selector);
        bondPool.scheduleBaseBonds(1, 1000e18, 2000e18);
    }

    function test_postBond_rejectsDepositOverCap() public {

        uint256 startsAt = _armClockHere();
        vm.prank(governance);
        bondPool.scheduleMaxBondDeposit(1, 3000e18);

        vm.warp(startsAt + 7 days);
        (bool ok, uint256 cap) = bondPool.activeMaxBondDeposit();
        assertTrue(ok);
        assertEq(cap, 3000e18);

        vm.prank(agent);
        vm.expectRevert(ProvianRecourseBondPool.DepositExceedsCap.selector);
        bondPool.postBond(3, 0);
    }

    function test_scheduleRenewalPeriod_boundsEnforced() public {
        vm.prank(governance);
        vm.expectRevert(ProvianRecourseBondPool.CostOutOfDomain.selector);
        bondPool.scheduleRenewalPeriod(1, 29 days);
        vm.prank(governance);
        vm.expectRevert(ProvianRecourseBondPool.CostOutOfDomain.selector);
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
        vm.expectRevert(ProvianRecourseBondPool.CostOutOfDomain.selector);
        bondPool.scheduleAbandonmentPeriod(1, 89 days);
        vm.prank(governance);
        vm.expectRevert(ProvianRecourseBondPool.CostOutOfDomain.selector);
        bondPool.scheduleAbandonmentPeriod(1, 731 days);
    }

    function test_scheduleMaxBondDeposit_boundsEnforced() public {
        uint256 belowFloor = bondPool.MIN_MAX_BOND_DEPOSIT() - 1;
        uint256 aboveCeiling = bondPool.MAX_MAX_BOND_DEPOSIT() + 1;

        vm.prank(governance);
        vm.expectRevert(ProvianRecourseBondPool.CostOutOfDomain.selector);
        bondPool.scheduleMaxBondDeposit(1, belowFloor);

        vm.prank(governance);
        vm.expectRevert(ProvianRecourseBondPool.CostOutOfDomain.selector);
        bondPool.scheduleMaxBondDeposit(1, aboveCeiling);

        (bool exists,) = bondPool.activeMaxBondDeposit();
        assertFalse(exists);
        assertEq(bondPool.maxBondDeposit(), 7500e18);
    }

    function test_scheduleCosts_rejectNonProspectiveEpoch() public {
        assertEq(bondPool.earliestSchedulableEpoch(), 1);

        vm.prank(governance);
        vm.expectRevert(ProvianRecourseBondPool.PolicyNotProspective.selector);
        bondPool.scheduleDepositBurnBps(0, 100);

        vm.prank(governance);
        vm.expectRevert(ProvianRecourseBondPool.PolicyNotProspective.selector);
        bondPool.scheduleBaseBonds(0, 1000e18, 2000e18);

        vm.prank(governance);
        vm.expectRevert(ProvianRecourseBondPool.PolicyNotProspective.selector);
        bondPool.scheduleSlashShares(0, 3000, 7000);

        vm.prank(governance);
        bondPool.scheduleDepositBurnBps(1, 100);
        vm.prank(governance);
        vm.expectRevert(ProvianRecourseBondPool.PolicyAlreadyScheduled.selector);
        bondPool.scheduleDepositBurnBps(1, 200);
    }

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

        string[41] memory signatures = [

            "postBond(uint8,uint256)",
            "renewBond()",
            "topUpBond(uint256)",
            "withdrawBond()",
            "fileClaim(address,bytes32)",
            "slashBond(address,uint256,bytes32)",
            "dismissClaim(address,bytes32)",
            "expireStaleClaim(bytes32)",
            "processAbandonment(address)",
            "setCourtContract(address)",
            "setExecutor(address)",
            "transferAdmin(address)",

            "scheduleDepositBurnBps(uint64,uint256)",
            "scheduleDepositFeeBps(uint64,uint256)",
            "scheduleRenewalBurnBps(uint64,uint256)",
            "scheduleRenewalFeeBps(uint64,uint256)",
            "scheduleSlashShares(uint64,uint256,uint256)",
            "scheduleClaimsProcessingFee(uint64,uint256)",
            "scheduleClaimFilingFee(uint64,uint256)",
            "scheduleRenewalPeriod(uint64,uint256)",
            "scheduleAbandonmentPeriod(uint64,uint256)",

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

        bytes memory code = address(bondPool).code;
        for (uint256 i = 0; i < signatures.length; i++) {
            bytes4 sel = bytes4(keccak256(bytes(signatures[i])));
            assertTrue(
                _selectorInBytecode(code, sel),
                string.concat("expected selector missing: ", signatures[i])
            );
        }
    }

    function testFuzz_getRequiredBond_discountMonotonic(uint256 discount) public view {
        discount = bound(discount, 0, MAX_TRUST_DISCOUNT);
        uint256 r = bondPool.getRequiredBond(2, discount);
        assertLe(r, LEVEL_2_BASE, "discount never raises required");
        if (discount > 0) assertLt(r, LEVEL_2_BASE, "any discount lowers required");
        r = bondPool.getRequiredBond(3, discount);
        assertLe(r, LEVEL_3_BASE);
    }

    function testFuzz_getRequiredBond_clampsOverMax(uint256 discount) public view {

        vm.assume(discount > MAX_TRUST_DISCOUNT);
        uint256 r = bondPool.getRequiredBond(2, discount);
        assertEq(r, bondPool.getRequiredBond(2, MAX_TRUST_DISCOUNT), "over-cap clamps to cap");
    }

    function testFuzz_slashBond_splitAlwaysSumsToActual(uint256 slashAmount) public {
        vm.prank(agent);
        bondPool.postBond(3, 0);
        (uint256 locked, , , , , ,) = bondPool.bonds(agent);

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

        uint256 actualSlash = slashAmount;
        uint256 expectedClaimant = (actualSlash * SLASH_PAYOUT_BPS) / MAX_BPS;
        uint256 expectedBurn = actualSlash - expectedClaimant;

        uint256 toClaimant = pvt.balanceOf(claimant) - claimantBefore;
        uint256 burned = pvt.totalBurned() - burnedBefore;

        uint256 toCourt = pvt.balanceOf(court) - courtBefore;
        uint256 poolDecrease = bondBefore - pvt.balanceOf(address(bondPool));

        assertEq(toClaimant, expectedClaimant + FILING_FEE, "claimant payout correct");
        assertEq(burned, expectedBurn, "burn correct");
        assertEq(pvt.totalSelfBurned(), pvt.totalBurned(), "burned via burn(), not protocolBurn()");
        assertEq(pvt.balanceOf(techWallet), techBefore, "tech no longer receives the processing fee");

        (uint256 amtAfter, , , , , ,) = bondPool.bonds(agent);
        uint256 remainingPreFee = locked - actualSlash;
        uint256 expectedCourtFee = remainingPreFee >= CLAIMS_PROCESSING_FEE ? CLAIMS_PROCESSING_FEE : 0;
        assertEq(toCourt, expectedCourtFee, "processing fee routed to the panel (Court)");
        assertEq(amtAfter, remainingPreFee - expectedCourtFee, "bond.amount correct");

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

        assertGe(locked, required, "locked >= required");
    }
}

contract RecourseBondPoolHandler is Test {
    ProvianRecourseBondPool public bondPool;
    MockPVT public pvt;

    address public court;
    address[] public agents;
    address[] public claimants;
    mapping(bytes32 => address) public claimToAgent;
    bytes32[] public openClaims;

    constructor(ProvianRecourseBondPool _bondPool, MockPVT _pvt, address _court) {
        bondPool = _bondPool;
        pvt = _pvt;
        court = _court;

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
        discount = discount % 5001;
        (, , , , , ProvianRecourseBondPool.BondStatus status,) = bondPool.bonds(a);
        if (status == ProvianRecourseBondPool.BondStatus.Active) return;
        vm.prank(a);
        try bondPool.postBond(level, discount) {} catch {}
    }

    function fileClaim(uint256 claimantIdx, uint256 agentIdx, uint256 salt) external {
        address a = agents[agentIdx % agents.length];
        address c = claimants[claimantIdx % claimants.length];
        bytes32 id = keccak256(abi.encode("fuzz-claim", a, c, salt, openClaims.length));
        if (bondPool.claimExists(id)) return;
        (, , , , , ProvianRecourseBondPool.BondStatus status,) = bondPool.bonds(a);
        if (status != ProvianRecourseBondPool.BondStatus.Active) return;
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

    function sumActiveBonds() external view returns (uint256 total) {
        for (uint256 i = 0; i < agents.length; i++) {
            (uint256 amt, , , , , ProvianRecourseBondPool.BondStatus status,) = bondPool.bonds(agents[i]);
            if (status == ProvianRecourseBondPool.BondStatus.Active) total += amt;
        }
    }

    function openClaimCount() external view returns (uint256) {
        return openClaims.length;
    }
}

contract RecourseProvianRecourseBondPoolInvariantTest is Test {
    ProvianRecourseBondPool public bondPool;
    MockPVT public pvt;
    RecourseBondPoolHandler public handler;

    address public admin = address(0xA01);
    address public techWallet = address(0xA02);
    address public court = address(0xA03);
    address public governance = address(0xA04);

    uint256 public constant FILING_FEE = 15e18;

    function setUp() public {
        pvt = new MockPVT();
        court = address(new MockCourtRewardSink());
        bondPool = new ProvianRecourseBondPool(admin, techWallet, address(pvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), RecourseInstitutionSeeds.SeedManifest(address(0),0,bytes32(0),bytes32(0),0,0), new ProvianRecourseBondPool.BpsSeed[](0));
        vm.startPrank(admin);
        bondPool.setCourtContract(court);
        bondPool.setExecutor(governance);
        vm.stopPrank();

        handler = new RecourseBondPoolHandler(bondPool, pvt, court);
        targetContract(address(handler));
    }

    function invariant_poolBalance_equalsActiveBondsPlusOpenFilingFees() public view {
        uint256 expected = handler.sumActiveBonds() + (handler.openClaimCount() * FILING_FEE);
        assertEq(pvt.balanceOf(address(bondPool)), expected, "pool balance diverged from expected");
    }
}
