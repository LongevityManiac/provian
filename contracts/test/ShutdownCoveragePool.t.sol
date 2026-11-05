// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ProvianPoolV3.sol";
import "./MockTokens.sol";
import "./MockEpochClock.sol";

/**
 * @title ShutdownCoveragePoolTest
 * @notice Shutdown coverage (2026-10-20): no contributor's money may depend on the relay,
 *         a Provian scheduler, or a Provian-held key. Before this change a Funded pool left
 *         ProvianPoolV3 only through the creator's `executePool` or the ADMIN's `refundPool`,
 *         so a creator who never executed stranded every contributor behind Provian's key.
 *         Past the pool's own deadline anyone may now refund a Funded pool.
 *
 *         RED control: `test_fundedPool_pastDeadline_anyoneRefunds_*` fail against the prior
 *         source (`refundPool` reverted `InvalidStatus(Open, Funded)` for every non-admin
 *         caller); recorded in the commit that adds this file.
 */
contract ShutdownCoveragePoolTest is Test {
    ProvianPoolV3 public pool;
    MockUSDC public usdc;
    MockPVT public pvt;

    address public admin = address(0xA01);
    address public feeWallet = address(0xFEE);
    address public creator = address(0xCAA);
    address public target = address(0x7AA);
    address public contributorA = address(0xC01);
    address public contributorB = address(0xC02);
    address public stranger = address(0xDEAD);

    function setUp() public {
        usdc = new MockUSDC();
        pvt = new MockPVT();
        pool = new ProvianPoolV3(admin, feeWallet, address(usdc), address(pvt), address(new MockEpochClock(0)));
        address[3] memory funded = [creator, contributorA, contributorB];
        for (uint256 i = 0; i < funded.length; i++) {
            usdc.mint(funded[i], 100_000e6);
            pvt.mint(funded[i], 100_000e18);
            vm.startPrank(funded[i]);
            usdc.approve(address(pool), type(uint256).max);
            pvt.approve(address(pool), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _fundedPool(bytes32 id, ProvianPoolV3.Currency cur, uint256 threshold, uint256 deadline) internal {
        vm.prank(creator);
        pool.createPool(id, target, threshold, deadline, cur);
        vm.prank(contributorA);
        pool.contribute(id, (threshold * 6) / 10);
        vm.prank(contributorB);
        pool.contribute(id, (threshold * 6) / 10); // over-funds: 120% of threshold
        (, , , , , , ProvianPoolV3.Status status, ) = pool.pools(id);
        assertEq(uint8(status), uint8(ProvianPoolV3.Status.Funded), "fixture must be Funded");
    }

    function test_fundedPool_pastDeadline_anyoneRefunds_USDC() public {
        bytes32 id = keccak256("funded-usdc");
        uint256 deadline = block.timestamp + 7 days;
        _fundedPool(id, ProvianPoolV3.Currency.USDC, 1000e6, deadline);
        uint256 aBefore = usdc.balanceOf(contributorA);
        uint256 bBefore = usdc.balanceOf(contributorB);

        vm.warp(deadline);
        vm.prank(stranger);
        pool.refundPool(id);

        assertEq(usdc.balanceOf(contributorA), aBefore + 600e6);
        assertEq(usdc.balanceOf(contributorB), bBefore + 600e6);
        assertEq(usdc.balanceOf(address(pool)), 0);
        assertEq(usdc.balanceOf(target), 0);
        assertEq(usdc.balanceOf(feeWallet), 0);
        (, , , , , , ProvianPoolV3.Status status, ) = pool.pools(id);
        assertEq(uint8(status), uint8(ProvianPoolV3.Status.Refunded));
    }

    function test_fundedPool_pastDeadline_anyoneRefunds_PVT() public {
        bytes32 id = keccak256("funded-pvt");
        uint256 deadline = block.timestamp + 7 days;
        _fundedPool(id, ProvianPoolV3.Currency.PVT, 1000e18, deadline);
        uint256 aBefore = pvt.balanceOf(contributorA);
        uint256 bBefore = pvt.balanceOf(contributorB);

        vm.warp(deadline + 1);
        vm.prank(contributorA); // a contributor, not the creator or admin
        pool.refundPool(id);

        assertEq(pvt.balanceOf(contributorA), aBefore + 600e18);
        assertEq(pvt.balanceOf(contributorB), bBefore + 600e18);
        assertEq(pvt.balanceOf(address(pool)), 0);
        assertEq(pvt.totalBurned(), 0, "a refund burns nothing");
    }

    // Controls: the new exit opens only at the deadline and only for an unexecuted pool.

    function test_fundedPool_beforeDeadline_strangerCannotRefund() public {
        bytes32 id = keccak256("funded-early");
        uint256 deadline = block.timestamp + 7 days;
        _fundedPool(id, ProvianPoolV3.Currency.USDC, 1000e6, deadline);
        vm.warp(deadline - 1);
        vm.prank(stranger);
        vm.expectRevert(ProvianPoolV3.DeadlineNotReached.selector);
        pool.refundPool(id);
    }

    function test_executedPool_cannotBeRefunded() public {
        bytes32 id = keccak256("funded-executed");
        uint256 deadline = block.timestamp + 7 days;
        _fundedPool(id, ProvianPoolV3.Currency.USDC, 1000e6, deadline);
        vm.prank(creator);
        pool.executePool(id, false);
        vm.warp(deadline + 1);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                ProvianPoolV3.InvalidStatus.selector, ProvianPoolV3.Status.Open, ProvianPoolV3.Status.Executed
            )
        );
        pool.refundPool(id);
    }

    function test_creatorMayStillExecute_pastDeadline_untilRefunded() public {
        bytes32 id = keccak256("funded-late-execute");
        uint256 deadline = block.timestamp + 7 days;
        _fundedPool(id, ProvianPoolV3.Currency.USDC, 1000e6, deadline);
        vm.warp(deadline + 1 days);
        vm.prank(creator);
        pool.executePool(id, false);
        assertEq(usdc.balanceOf(target), 995e6);
    }

    function test_refundedPool_cannotThenBeExecuted() public {
        bytes32 id = keccak256("funded-refund-then-execute");
        uint256 deadline = block.timestamp + 7 days;
        _fundedPool(id, ProvianPoolV3.Currency.USDC, 1000e6, deadline);
        vm.warp(deadline);
        vm.prank(stranger);
        pool.refundPool(id);
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(
                ProvianPoolV3.InvalidStatus.selector, ProvianPoolV3.Status.Funded, ProvianPoolV3.Status.Refunded
            )
        );
        pool.executePool(id, false);
    }

    function test_refundTwice_reverts() public {
        bytes32 id = keccak256("funded-refund-twice");
        uint256 deadline = block.timestamp + 7 days;
        _fundedPool(id, ProvianPoolV3.Currency.USDC, 1000e6, deadline);
        vm.warp(deadline);
        vm.prank(stranger);
        pool.refundPool(id);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                ProvianPoolV3.InvalidStatus.selector, ProvianPoolV3.Status.Open, ProvianPoolV3.Status.Refunded
            )
        );
        pool.refundPool(id);
    }
}
