// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ProvianBondPool.sol";
import "./MockTokens.sol"; // MockPVT
import "./MockEpochClock.sol";
import "./MockIssuanceIndex.sol";

/**
 * @title ProvianBondPoolPass3Test
 * @notice Pass-3 #3 (contract leg) regression suite.
 *
 *         Before the fix, a filed claim incremented pendingClaims, and the ONLY
 *         decrements (slashBond / dismissClaim, onlyCourt) were reachable only
 *         after Court.assignBondClaimPanel — onlyAdmin AND needing >= 15 eligible
 *         arbitrators. Pre-launch (or under admin inaction / lost-key / malice)
 *         the panel could never form, so withdrawBond reverted ClaimsPending
 *         forever, permanently freezing the respondent's own collateral.
 *
 *         Fix: expireStaleClaim — a permissionless, timeout-gated escape that can
 *         ONLY dismiss (never slash), needs no privileged key, and burns the
 *         filing fee (no external transfer, so a reverting claimant can't brick
 *         it). After CLAIM_RESOLUTION_TIMEOUT the respondent's bond is reachable
 *         again with no admin or panel required.
 */
contract ProvianBondPoolPass3Test is Test {
    ProvianBondPool public bondPool;
    MockPVT public pvt;

    address public admin = address(0xA01);
    address public techWallet = address(0xA02);
    address public court = address(0xA03);
    address public governance = address(0xA04);
    address public agent = address(0xB01);
    address public claimant = address(0xB02);
    address public rando = address(0xC01); // permissionless caller (not admin/court/party)

    uint256 public constant FILING_FEE = 15e18;
    uint256 public constant FUND = 1_000_000e18;

    function setUp() public {
        pvt = new MockPVT();
        court = address(new MockCourtRewardSink()); // institution deployment/courtContract must implement fundBondClaimReward
        bondPool = new ProvianBondPool(admin, techWallet, address(pvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), new ProvianBondPool.BondSeed[](0), new ProvianBondPool.BpsSeed[](0));
        vm.startPrank(admin);
        bondPool.setCourtContract(court);
        bondPool.setExecutor(governance);
        vm.stopPrank();

        pvt.mint(agent, FUND);
        pvt.mint(claimant, FUND);
        vm.prank(agent);
        pvt.approve(address(bondPool), type(uint256).max);
        vm.prank(claimant);
        pvt.approve(address(bondPool), type(uint256).max);
    }

    function _postAndFile(bytes32 claimId) internal returns (uint256 lockedBond) {
        vm.prank(agent);
        bondPool.postBond(2, 0);
        (lockedBond, , , , , , ) = bondPool.bonds(agent);

        vm.prank(claimant);
        bondPool.fileClaim(agent, claimId);
    }

    // ========================================================================
    // FAIL-BEFORE: a filed claim with no panel freezes withdrawBond, and the
    // escape is not yet available before the timeout.
    // ========================================================================

    function test_3_filedClaim_freezesWithdraw_andEscapeNotYetAvailable() public {
        bytes32 claimId = keccak256("frozen");
        _postAndFile(claimId);

        // pendingClaims == 1 → withdrawBond blocked.
        (, , , , , , uint256 pending) = bondPool.bonds(agent);
        assertEq(pending, 1);
        vm.prank(agent);
        vm.expectRevert(ProvianBondPool.ClaimsPending.selector);
        bondPool.withdrawBond();

        // Before CLAIM_RESOLUTION_TIMEOUT the permissionless escape is closed.
        vm.prank(rando);
        vm.expectRevert(ProvianBondPool.ClaimNotExpired.selector);
        bondPool.expireStaleClaim(claimId);

        // Just before the boundary: still closed.
        vm.warp(block.timestamp + bondPool.CLAIM_RESOLUTION_TIMEOUT() - 1);
        vm.prank(rando);
        vm.expectRevert(ProvianBondPool.ClaimNotExpired.selector);
        bondPool.expireStaleClaim(claimId);
    }

    // ========================================================================
    // PASS-AFTER: after the timeout, ANYONE expires the stale claim; the
    // respondent's bond is reachable again.
    // ========================================================================

    function test_3_expireStaleClaim_unfreezesBond_permissionless() public {
        bytes32 claimId = keccak256("expire-me");
        uint256 lockedBond = _postAndFile(claimId);

        uint256 burnedBefore = pvt.totalBurned();
        uint256 agentBalBefore = pvt.balanceOf(agent);

        // Warp past the timeout and let a NON-privileged address expire it.
        vm.warp(block.timestamp + bondPool.CLAIM_RESOLUTION_TIMEOUT() + 1);
        vm.prank(rando);
        bondPool.expireStaleClaim(claimId);

        // Claim dismissed, pendingClaims cleared, filing fee burned.
        (, , , ProvianBondPool.ClaimStatus cstatus, ) = bondPool.claims(claimId);
        assertEq(uint8(cstatus), uint8(ProvianBondPool.ClaimStatus.Dismissed));
        (uint256 bondAmt, , , , , , uint256 pending) = bondPool.bonds(agent);
        assertEq(pending, 0);
        assertEq(pvt.totalBurned(), burnedBefore + FILING_FEE);

        // No slash: the locked bond is untouched (only pendingClaims changed).
        assertEq(bondAmt, lockedBond);

        // The respondent can now withdraw their full bond.
        vm.prank(agent);
        bondPool.withdrawBond();
        assertEq(pvt.balanceOf(agent), agentBalBefore + lockedBond);
    }

    // Expiry can ONLY dismiss — it never routes bonded collateral to anyone.
    // (No claimant payout, no processing fee; just the fee burn + decrement.)
    function test_3_expireStaleClaim_movesNoCollateralToAnyone() public {
        bytes32 claimId = keccak256("no-drain");
        _postAndFile(claimId);
        uint256 claimantBefore = pvt.balanceOf(claimant);
        uint256 techBefore = pvt.balanceOf(techWallet);

        vm.warp(block.timestamp + bondPool.CLAIM_RESOLUTION_TIMEOUT() + 1);
        vm.prank(rando);
        bondPool.expireStaleClaim(claimId);

        // Claimant gets nothing (fee burned, not refunded), tech wallet unchanged.
        assertEq(pvt.balanceOf(claimant), claimantBefore);
        assertEq(pvt.balanceOf(techWallet), techBefore);
    }

    // ========================================================================
    // GUARDS
    // ========================================================================

    function test_3_expireStaleClaim_revertsUnknownClaim() public {
        vm.warp(block.timestamp + 200 days);
        vm.expectRevert(ProvianBondPool.ClaimNotFound.selector);
        bondPool.expireStaleClaim(keccak256("never-filed"));
    }

    function test_3_expireStaleClaim_revertsIfAlreadyResolved() public {
        bytes32 claimId = keccak256("double-expire");
        _postAndFile(claimId);
        vm.warp(block.timestamp + bondPool.CLAIM_RESOLUTION_TIMEOUT() + 1);
        vm.prank(rando);
        bondPool.expireStaleClaim(claimId);

        // Second expiry reverts (already Dismissed).
        vm.prank(rando);
        vm.expectRevert(ProvianBondPool.ClaimAlreadyResolved.selector);
        bondPool.expireStaleClaim(claimId);
    }

    // Mutual exclusion with the Court path: once expired (Dismissed), the Court's
    // dismissClaim/slashBond on the same claimId revert — no double-decrement.
    function test_3_expiredClaim_blocksCourtResolution() public {
        bytes32 claimId = keccak256("court-after-expire");
        _postAndFile(claimId);
        vm.warp(block.timestamp + bondPool.CLAIM_RESOLUTION_TIMEOUT() + 1);
        vm.prank(rando);
        bondPool.expireStaleClaim(claimId);

        // Court can no longer dismiss or slash it.
        vm.prank(court);
        vm.expectRevert(ProvianBondPool.ClaimAlreadyResolved.selector);
        bondPool.dismissClaim(agent, claimId);

        vm.prank(court);
        vm.expectRevert(ProvianBondPool.ClaimAlreadyResolved.selector);
        bondPool.slashBond(agent, 1e18, claimId);
    }

    // The Court fast-path still works and is NOT pre-empted before the timeout:
    // a real panel dismiss (via the wired court) resolves well before 60 days,
    // after which expireStaleClaim correctly refuses (claim already resolved).
    function test_3_courtDismiss_beforeTimeout_thenExpireRefuses() public {
        bytes32 claimId = keccak256("court-first");
        _postAndFile(claimId);

        // Court resolves quickly (as a real 48h panel would via finalizeBondClaim).
        vm.warp(block.timestamp + 3 days);
        vm.prank(court);
        bondPool.dismissClaim(agent, claimId);
        (, , , , , , uint256 pending) = bondPool.bonds(agent);
        assertEq(pending, 0);

        // The stale-claim escape now refuses (nothing left to expire).
        vm.warp(block.timestamp + bondPool.CLAIM_RESOLUTION_TIMEOUT() + 1);
        vm.expectRevert(ProvianBondPool.ClaimAlreadyResolved.selector);
        bondPool.expireStaleClaim(claimId);
    }

    // Multiple stuck claims: each must be expired to fully unfreeze the bond.
    function test_3_multipleStaleClaims_eachDecrements() public {
        vm.prank(agent);
        bondPool.postBond(3, 0);

        bytes32 c1 = keccak256("c1");
        bytes32 c2 = keccak256("c2");
        vm.prank(claimant);
        bondPool.fileClaim(agent, c1);
        vm.prank(claimant);
        bondPool.fileClaim(agent, c2);

        (, , , , , , uint256 pending) = bondPool.bonds(agent);
        assertEq(pending, 2);

        vm.warp(block.timestamp + bondPool.CLAIM_RESOLUTION_TIMEOUT() + 1);

        bondPool.expireStaleClaim(c1);
        (, , , , , , pending) = bondPool.bonds(agent);
        assertEq(pending, 1);
        // Still blocked with one claim outstanding.
        vm.prank(agent);
        vm.expectRevert(ProvianBondPool.ClaimsPending.selector);
        bondPool.withdrawBond();

        bondPool.expireStaleClaim(c2);
        (, , , , , , pending) = bondPool.bonds(agent);
        assertEq(pending, 0);
        vm.prank(agent);
        bondPool.withdrawBond(); // now succeeds
    }
}
