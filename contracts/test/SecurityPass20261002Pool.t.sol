// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ProvianPoolV3.sol";
import "./MockTokens.sol";
import "./MockEpochClock.sol";

/**
 * @title Security pass 2026-10-02 (Fable run) — PoolV3 phantom contribution (finding S1-A).
 *
 * ATTACK. `contribute()` never checked that the pool exists. On a never-created poolId the
 * zero-valued struct reads `status == Open`, `threshold == 0`, `currency == USDC`, so a call
 * records `contributions[poolId][A] = X`, pushes A into `contributorList`, takes X USDC and
 * flips the phantom to Funded. `createPool(poolId, …)` only refuses when `creator != 0`, so
 * it then OVERWRITES `PoolInfo` (`totalContributed = 0`, `status = Open`) while A's
 * `contributions` entry and list slot SURVIVE. Honest contributors then fund the pool; A
 * withdraws X through `withdrawContribution`, which subtracts X from a `totalContributed`
 * that never counted it. The honest contributors now have to over-fund the pool by X to
 * reach the threshold, and on `executePool` that X stays in the contract forever: it is
 * neither part of the threshold paid to the target nor part of the pro-rata excess refund,
 * and the contract has no sweep. A gets its X back, so the grief is free.
 *
 * These tests are RED on the pre-fix PoolV3 (the phantom contribution is accepted and the
 * honest contributors' X is stranded) and GREEN once `contribute()` refuses a pool with no
 * creator.
 */
contract SecurityPass20261002PoolTest is Test {
    ProvianPoolV3 internal pool;
    MockUSDC internal usdc;
    MockPVT internal pvt;

    address internal admin = address(0xA01);
    address internal feeWallet = address(0xFEE);
    address internal attacker = address(0xBAD);
    address internal creator = address(0xCAA);
    address internal target = address(0x7AA);
    address internal honestA = address(0xC01);
    address internal honestB = address(0xC02);

    uint256 internal constant THRESHOLD = 1000e6;
    uint256 internal constant PHANTOM = 400e6;

    function setUp() public {
        usdc = new MockUSDC();
        pvt = new MockPVT();
        pool = new ProvianPoolV3(admin, feeWallet, address(usdc), address(pvt), address(new MockEpochClock(0)));
        address[4] memory funded = [attacker, creator, honestA, honestB];
        for (uint256 i = 0; i < funded.length; i++) {
            usdc.mint(funded[i], 100_000e6);
            vm.prank(funded[i]);
            usdc.approve(address(pool), type(uint256).max);
        }
    }

    /// @notice The phantom contribution is the root: a contribution to a pool nobody created
    ///         must be refused outright.
    function test_contributeToNeverCreatedPool_reverts() public {
        bytes32 id = keccak256("not-created-yet");
        vm.prank(attacker);
        vm.expectRevert(ProvianPoolV3.PoolNotFound.selector);
        pool.contribute(id, PHANTOM);
        assertEq(usdc.balanceOf(address(pool)), 0, "the pool must hold nothing for a pool that does not exist");
    }

    /// @notice End-to-end grief: pre-seed, create, let honest money arrive, withdraw the
    ///         phantom, execute. Pre-fix the honest contributors lose PHANTOM to the contract.
    function test_phantomContribution_cannotStrandHonestFunds() public {
        bytes32 id = keccak256("pool-the-attacker-pre-seeds");

        // 1. The attacker pre-seeds the id before anyone creates the pool.
        vm.prank(attacker);
        try pool.contribute(id, PHANTOM) {
            // pre-fix: accepted
        } catch {
            // post-fix: refused — the rest of the scenario cannot start, which is the point.
            vm.prank(creator);
            pool.createPool(id, target, THRESHOLD, block.timestamp + 7 days, ProvianPoolV3.Currency.USDC);
            vm.prank(honestA);
            pool.contribute(id, THRESHOLD);
            vm.prank(creator);
            pool.executePool(id, false);
            // Every honest dollar is accounted for: target got the net, feeWallet the fee.
            assertEq(usdc.balanceOf(address(pool)), 0, "nothing may be stranded in the pool contract");
            return;
        }

        // 2. The creator creates the pool on that id (pre-fix: allowed, struct overwritten).
        vm.prank(creator);
        pool.createPool(id, target, THRESHOLD, block.timestamp + 7 days, ProvianPoolV3.Currency.USDC);

        // 3. Honest money arrives, not yet enough for the threshold.
        vm.prank(honestA);
        pool.contribute(id, 600e6);

        // 4. The attacker pulls the phantom back out — free for the attacker.
        vm.prank(attacker);
        pool.withdrawContribution(id);
        assertEq(usdc.balanceOf(attacker), 100_000e6, "the attacker is made whole");

        // 5. The honest contributors keep funding until the pool reads Funded.
        vm.prank(honestB);
        pool.contribute(id, 800e6);
        (, , , uint256 totalContributed, , , ProvianPoolV3.Status status, ) = pool.pools(id);
        assertEq(uint8(status), uint8(ProvianPoolV3.Status.Funded));

        // 6. Execute: target gets threshold - fee, feeWallet the fee, excess refunded pro rata.
        vm.prank(creator);
        pool.executePool(id, false);

        // The honest contributors paid 1400; the threshold is 1000; the only lawful place for
        // the other 400 is their excess refund. Pre-fix the contract keeps it forever.
        uint256 honestPaid = 600e6 + 800e6;
        uint256 honestBack = (usdc.balanceOf(honestA) - (100_000e6 - 600e6)) + (usdc.balanceOf(honestB) - (100_000e6 - 800e6));
        assertEq(honestPaid - honestBack, THRESHOLD, "honest contributors must be out exactly the threshold");
        assertEq(usdc.balanceOf(address(pool)), 0, "nothing may be stranded in the pool contract");
        assertEq(totalContributed, honestPaid, "totalContributed must equal what honest contributors actually paid");
    }

    /// @notice Negative control for the fix: a real pool still accepts contributions, so the
    ///         guard is not a blanket refusal.
    function test_control_realPoolStillAcceptsContributions() public {
        bytes32 id = keccak256("real-pool");
        vm.prank(creator);
        pool.createPool(id, target, THRESHOLD, block.timestamp + 7 days, ProvianPoolV3.Currency.USDC);
        vm.prank(honestA);
        pool.contribute(id, 250e6);
        assertEq(pool.contributions(id, honestA), 250e6);
    }
}
