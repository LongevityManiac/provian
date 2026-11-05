// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ProvianPoolV3.sol";
import "./MockTokens.sol"; // MockUSDC, MockPVT, MockBlacklistUSDC
import "./MockEpochClock.sol";

/**
 * @title ProvianPoolV3Pass3Test
 * @notice Pass-3 #5 regression suite. Before the fix, refundPool and the
 *         executePool excess-refund loop iterated EVERY contributor atomically
 *         with `if (!ok) revert TransferFailed()`. A single blacklisted/reverting
 *         USDC contributor (Circle USDC reverts to a blacklisted recipient — it
 *         does not return false) aborted the whole loop, permanently freezing ALL
 *         honest contributors' funds with no admin-drain to rescue them.
 *
 *         Fix: each per-contributor payout is push-with-pull-fallback via
 *         _payOrCredit, so a reverting recipient is isolated to itself and every
 *         other contributor is still paid in the same tx. The reverting
 *         contributor recovers their own funds via claimPendingRefund once cleared.
 */
contract ProvianPoolV3Pass3Test is Test {
    ProvianPoolV3 public pool;
    MockBlacklistUSDC public usdc; // blacklist-aware USDC
    MockPVT public pvt;

    address public admin = address(0xA01);
    address public feeWallet = address(0xFEE);
    address public creator = address(0xCAA);
    address public target = address(0x7AA);
    address public cA = address(0xC01);
    address public cB = address(0xC02); // the one we blacklist
    address public cC = address(0xC03);
    address public keeper = address(0xBEEF);

    function setUp() public {
        usdc = new MockBlacklistUSDC();
        pvt = new MockPVT();
        pool = new ProvianPoolV3(admin, feeWallet, address(usdc), address(pvt), address(new MockEpochClock(0)));

        address[4] memory funded = [creator, cA, cB, cC];
        for (uint256 i = 0; i < funded.length; i++) {
            usdc.mint(funded[i], 100_000e6);
            vm.prank(funded[i]);
            usdc.approve(address(pool), type(uint256).max);
        }
    }

    // Fail-before evidence: the token reverts to a blacklisted address, which is
    // what would have bricked the atomic all-contributor loop pre-fix.
    function test_5_evidence_tokenRevertsToBlacklisted() public {
        usdc.setBlacklisted(cB, true);
        usdc.mint(address(this), 10e6);
        vm.expectRevert(abi.encodeWithSelector(MockBlacklistUSDC.AccountBlacklisted.selector, cB));
        usdc.transfer(cB, 1e6);
    }

    // ========================================================================
    // #5 — refundPool: one blacklisted contributor no longer freezes the pool.
    // ========================================================================

    function test_5_refundPool_isolatesBlacklistedContributor() public {
        bytes32 id = keccak256("refund-pool");
        vm.prank(creator);
        pool.createPool(id, target, 1000e6, block.timestamp + 1 days, ProvianPoolV3.Currency.USDC);

        // Three contributors, pool stays Open (600 < 1000).
        vm.prank(cA); pool.contribute(id, 200e6);
        vm.prank(cB); pool.contribute(id, 200e6);
        vm.prank(cC); pool.contribute(id, 200e6);

        uint256 aBefore = usdc.balanceOf(cA);
        uint256 cBefore = usdc.balanceOf(cC);
        uint256 bBefore = usdc.balanceOf(cB); // cB's wallet after contributing

        // cB is blacklisted AFTER contributing (dynamic Circle-style blacklist).
        usdc.setBlacklisted(cB, true);

        // Admin refunds. Pre-fix this reverted entirely (cB's transfer reverts in
        // the loop), freezing cA and cC too. Now it completes and isolates cB.
        vm.prank(admin);
        pool.refundPool(id);

        // Honest contributors refunded directly in the same tx.
        assertEq(usdc.balanceOf(cA), aBefore + 200e6);
        assertEq(usdc.balanceOf(cC), cBefore + 200e6);
        // The blacklisted contributor's refund is a pull credit, not a freeze:
        // its wallet is unchanged (no push landed) and 200e6 waits in the ledger.
        assertEq(pool.pendingRefunds(id, cB), 200e6);
        assertEq(usdc.balanceOf(cB), bBefore);

        // Pool is Refunded (status 3).
        (, , , , , , ProvianPoolV3.Status status, ) = pool.pools(id);
        assertEq(uint8(status), uint8(ProvianPoolV3.Status.Refunded));

        // While blacklisted, cB's own claim reverts and preserves the credit.
        vm.prank(cB);
        vm.expectRevert(abi.encodeWithSelector(MockBlacklistUSDC.AccountBlacklisted.selector, cB));
        pool.claimPendingRefund(id);
        assertEq(pool.pendingRefunds(id, cB), 200e6);

        // Once cleared, cB recovers their own funds (wallet returns to full).
        usdc.setBlacklisted(cB, false);
        vm.prank(cB);
        pool.claimPendingRefund(id);
        assertEq(usdc.balanceOf(cB), bBefore + 200e6);
        assertEq(usdc.balanceOf(cB), 100_000e6);
        assertEq(pool.pendingRefunds(id, cB), 0);

        // Double claim is a clean revert, not a double-pay.
        vm.prank(cB);
        vm.expectRevert(ProvianPoolV3.NothingToClaim.selector);
        pool.claimPendingRefund(id);
    }

    // Post-deadline permissionless refund path is likewise isolated.
    function test_5_refundPool_postDeadline_permissionless_isolates() public {
        bytes32 id = keccak256("refund-deadline");
        vm.prank(creator);
        pool.createPool(id, target, 1000e6, block.timestamp + 1 days, ProvianPoolV3.Currency.USDC);
        vm.prank(cA); pool.contribute(id, 100e6);
        vm.prank(cB); pool.contribute(id, 100e6);

        usdc.setBlacklisted(cB, true);
        vm.warp(block.timestamp + 2 days);

        // Anyone can refund an Open pool past its deadline.
        vm.prank(keeper);
        pool.refundPool(id);

        assertEq(usdc.balanceOf(cA), 100_000e6); // fully restored
        assertEq(pool.pendingRefunds(id, cB), 100e6);
    }

    // ========================================================================
    // #5 — executePool excess: a blacklisted contributor no longer bricks the
    // pro-rata excess distribution (target is still paid, honest excess flows).
    // ========================================================================

    function test_5_executePool_excess_isolatesBlacklistedContributor() public {
        bytes32 id = keccak256("exec-excess");
        vm.prank(creator);
        pool.createPool(id, target, 1000e6, block.timestamp + 1 days, ProvianPoolV3.Currency.USDC);

        // Over-fund: A=500, B=400, C=300 → total 1200, funded; excess 200.
        vm.prank(cA); pool.contribute(id, 500e6);
        vm.prank(cB); pool.contribute(id, 400e6);
        vm.prank(cC); pool.contribute(id, 300e6);

        uint256 aBefore = usdc.balanceOf(cA);
        uint256 cBefore = usdc.balanceOf(cC);
        uint256 bBefore = usdc.balanceOf(cB);

        // cB blacklisted before execution.
        usdc.setBlacklisted(cB, true);

        // Excess = 200e6. Pro-rata (6-decimal floor division):
        //   A = 500e6 * 200e6 / 1200e6 = 83_333333
        //   B = 400e6 * 200e6 / 1200e6 = 66_666666
        //   C (last in list) sweeps the dust = 200e6 - A - B = 50_000001
        uint256 aExcess = 83_333333;
        uint256 bExcess = 66_666666;
        uint256 cExcess = 50_000001;

        vm.prank(creator);
        pool.executePool(id, false);

        // Target paid net; fee to feeWallet.
        assertEq(usdc.balanceOf(target), 995e6);
        assertEq(usdc.balanceOf(feeWallet), 5e6);

        // Honest contributors got their excess directly; cB's is credited.
        assertEq(usdc.balanceOf(cA), aBefore + aExcess);
        assertEq(usdc.balanceOf(cC), cBefore + cExcess);
        assertEq(pool.pendingRefunds(id, cB), bExcess);
        assertEq(usdc.balanceOf(cB), bBefore); // unchanged — pull credit, not a push

        // cB recovers their excess once un-blacklisted.
        usdc.setBlacklisted(cB, false);
        vm.prank(cB);
        pool.claimPendingRefund(id);
        assertEq(usdc.balanceOf(cB), bBefore + bExcess);

        // Conservation: target + fee + all three excess shares == total contributed.
        assertEq(uint256(995e6) + 5e6 + aExcess + bExcess + cExcess, uint256(1200e6));
    }

    // Residual documentation: the executePool TARGET leg is a direct push by
    // design (the target is creator-chosen, not a per-pool attacker). A
    // blacklisted target reverts executePool and rolls back (pool stays Funded),
    // but this is NOT a permanent freeze — refundPool (blacklist-resistant) is
    // the escape and every contributor recovers.
    function test_5_executePool_blacklistedTarget_reverts_thenRefundRescues() public {
        bytes32 id = keccak256("bad-target");
        vm.prank(creator);
        pool.createPool(id, target, 1000e6, block.timestamp + 1 days, ProvianPoolV3.Currency.USDC);
        vm.prank(cA); pool.contribute(id, 600e6);
        vm.prank(cB); pool.contribute(id, 600e6); // total 1200 → Funded

        usdc.setBlacklisted(target, true);

        // executePool reverts because the target payment can't land; state rolls back.
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(MockBlacklistUSDC.AccountBlacklisted.selector, target));
        pool.executePool(id, false);

        // Pool is still Funded (not frozen) → admin refunds and everyone recovers.
        (, , , , , , ProvianPoolV3.Status status, ) = pool.pools(id);
        assertEq(uint8(status), uint8(ProvianPoolV3.Status.Funded));

        vm.prank(admin);
        pool.refundPool(id);
        assertEq(usdc.balanceOf(cA), 100_000e6);
        assertEq(usdc.balanceOf(cB), 100_000e6);
    }

    // Regression: with no blacklist, refundPool pays everyone directly and
    // credits nothing (happy path unchanged).
    function test_5_refundPool_happyPath_unchanged() public {
        bytes32 id = keccak256("refund-happy");
        vm.prank(creator);
        pool.createPool(id, target, 1000e6, block.timestamp + 1 days, ProvianPoolV3.Currency.USDC);
        vm.prank(cA); pool.contribute(id, 300e6);
        vm.prank(cB); pool.contribute(id, 300e6);

        vm.prank(admin);
        pool.refundPool(id);

        assertEq(usdc.balanceOf(cA), 100_000e6);
        assertEq(usdc.balanceOf(cB), 100_000e6);
        assertEq(pool.pendingRefunds(id, cA), 0);
        assertEq(pool.pendingRefunds(id, cB), 0);
    }
}
