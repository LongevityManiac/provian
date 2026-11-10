// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ProvianRecourseProjectPool.sol";
import "./MockTokens.sol";
import "./MockEpochClock.sol";

contract RecourseProvianRecourseProjectPoolPass3Test is Test {
    ProvianRecourseProjectPool public pool;
    MockBlacklistUSDC public usdc;
    MockPVT public pvt;

    address public admin = address(0xA01);
    address public feeWallet = address(0xFEE);
    address public creator = address(0xCAA);
    address public target = address(0x7AA);
    address public cA = address(0xC01);
    address public cB = address(0xC02);
    address public cC = address(0xC03);
    address public keeper = address(0xBEEF);

    function setUp() public {
        usdc = new MockBlacklistUSDC();
        pvt = new MockPVT();
        pool = new ProvianRecourseProjectPool(admin, feeWallet, address(usdc), address(pvt), address(new MockEpochClock(0)));

        address[4] memory funded = [creator, cA, cB, cC];
        for (uint256 i = 0; i < funded.length; i++) {
            usdc.mint(funded[i], 100_000e6);
            vm.prank(funded[i]);
            usdc.approve(address(pool), type(uint256).max);
        }
    }

    function test_5_evidence_tokenRevertsToBlacklisted() public {
        usdc.setBlacklisted(cB, true);
        usdc.mint(address(this), 10e6);
        vm.expectRevert(abi.encodeWithSelector(MockBlacklistUSDC.AccountBlacklisted.selector, cB));
        usdc.transfer(cB, 1e6);
    }
    function testPVTRefundCreditRemainsEncumberedUntilSuccessfulPull() public {
        MockBlacklistPVT token = new MockBlacklistPVT();
        ProvianRecourseProjectPool subject = new ProvianRecourseProjectPool(admin, feeWallet, address(usdc), address(token), address(new MockEpochClock(0)));
        bytes32 id = keccak256("PVT refund obligation TEST ONLY");
        vm.prank(creator); subject.createPool(id, target, 1000 ether, block.timestamp + 1 days, ProvianRecourseProjectPool.Currency.PVT);
        token.mint(cA, 300 ether); token.mint(address(subject), 17 ether);
        vm.startPrank(cA); token.approve(address(subject), 300 ether); subject.contribute(id, 300 ether); vm.stopPrank();
        assertEq(subject.encumberedPVT(), 300 ether);
        token.setBlacklisted(cA, true);
        vm.warp(block.timestamp + 2 days); subject.refundPool(id);
        assertEq(subject.encumberedPVT(), 300 ether);
        assertEq(subject.pendingRefunds(id, cA), 300 ether);
        token.setBlacklisted(cA, false);
        vm.prank(cA); subject.claimPendingRefund(id);
        assertEq(subject.encumberedPVT(), 0);
        assertEq(token.balanceOf(address(subject)), 17 ether);
    }

    function test_5_refundPool_isolatesBlacklistedContributor() public {
        bytes32 id = keccak256("refund-pool");
        vm.prank(creator);
        pool.createPool(id, target, 1000e6, block.timestamp + 1 days, ProvianRecourseProjectPool.Currency.USDC);

        vm.prank(cA); pool.contribute(id, 200e6);
        vm.prank(cB); pool.contribute(id, 200e6);
        vm.prank(cC); pool.contribute(id, 200e6);

        uint256 aBefore = usdc.balanceOf(cA);
        uint256 cBefore = usdc.balanceOf(cC);
        uint256 bBefore = usdc.balanceOf(cB);

        usdc.setBlacklisted(cB, true);

        vm.prank(admin);
        pool.refundPool(id);

        assertEq(usdc.balanceOf(cA), aBefore + 200e6);
        assertEq(usdc.balanceOf(cC), cBefore + 200e6);

        assertEq(pool.pendingRefunds(id, cB), 200e6);
        assertEq(usdc.balanceOf(cB), bBefore);

        (, , , , , , ProvianRecourseProjectPool.Status status, ) = pool.pools(id);
        assertEq(uint8(status), uint8(ProvianRecourseProjectPool.Status.Refunded));

        vm.prank(cB);
        vm.expectRevert(abi.encodeWithSelector(MockBlacklistUSDC.AccountBlacklisted.selector, cB));
        pool.claimPendingRefund(id);
        assertEq(pool.pendingRefunds(id, cB), 200e6);

        usdc.setBlacklisted(cB, false);
        vm.prank(cB);
        pool.claimPendingRefund(id);
        assertEq(usdc.balanceOf(cB), bBefore + 200e6);
        assertEq(usdc.balanceOf(cB), 100_000e6);
        assertEq(pool.pendingRefunds(id, cB), 0);

        vm.prank(cB);
        vm.expectRevert(ProvianRecourseProjectPool.NothingToClaim.selector);
        pool.claimPendingRefund(id);
    }

    function test_5_refundPool_postDeadline_permissionless_isolates() public {
        bytes32 id = keccak256("refund-deadline");
        vm.prank(creator);
        pool.createPool(id, target, 1000e6, block.timestamp + 1 days, ProvianRecourseProjectPool.Currency.USDC);
        vm.prank(cA); pool.contribute(id, 100e6);
        vm.prank(cB); pool.contribute(id, 100e6);

        usdc.setBlacklisted(cB, true);
        vm.warp(block.timestamp + 2 days);

        vm.prank(keeper);
        pool.refundPool(id);

        assertEq(usdc.balanceOf(cA), 100_000e6);
        assertEq(pool.pendingRefunds(id, cB), 100e6);
    }

    function test_5_executePool_excess_isolatesBlacklistedContributor() public {
        bytes32 id = keccak256("exec-excess");
        vm.prank(creator);
        pool.createPool(id, target, 1000e6, block.timestamp + 1 days, ProvianRecourseProjectPool.Currency.USDC);

        vm.prank(cA); pool.contribute(id, 500e6);
        vm.prank(cB); pool.contribute(id, 400e6);
        vm.prank(cC); pool.contribute(id, 300e6);

        uint256 aBefore = usdc.balanceOf(cA);
        uint256 cBefore = usdc.balanceOf(cC);
        uint256 bBefore = usdc.balanceOf(cB);

        usdc.setBlacklisted(cB, true);

        uint256 aExcess = 83_333333;
        uint256 bExcess = 66_666666;
        uint256 cExcess = 50_000001;

        vm.prank(creator);
        pool.executePool(id, false);

        assertEq(usdc.balanceOf(target), 995e6);
        assertEq(usdc.balanceOf(feeWallet), 5e6);

        assertEq(usdc.balanceOf(cA), aBefore + aExcess);
        assertEq(usdc.balanceOf(cC), cBefore + cExcess);
        assertEq(pool.pendingRefunds(id, cB), bExcess);
        assertEq(usdc.balanceOf(cB), bBefore);

        usdc.setBlacklisted(cB, false);
        vm.prank(cB);
        pool.claimPendingRefund(id);
        assertEq(usdc.balanceOf(cB), bBefore + bExcess);

        assertEq(uint256(995e6) + 5e6 + aExcess + bExcess + cExcess, uint256(1200e6));
    }

    function test_5_executePool_blacklistedTarget_reverts_thenRefundRescues() public {
        bytes32 id = keccak256("bad-target");
        vm.prank(creator);
        pool.createPool(id, target, 1000e6, block.timestamp + 1 days, ProvianRecourseProjectPool.Currency.USDC);
        vm.prank(cA); pool.contribute(id, 600e6);
        vm.prank(cB); pool.contribute(id, 600e6);

        usdc.setBlacklisted(target, true);

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(MockBlacklistUSDC.AccountBlacklisted.selector, target));
        pool.executePool(id, false);

        (, , , , , , ProvianRecourseProjectPool.Status status, ) = pool.pools(id);
        assertEq(uint8(status), uint8(ProvianRecourseProjectPool.Status.Funded));

        vm.prank(admin);
        pool.refundPool(id);
        assertEq(usdc.balanceOf(cA), 100_000e6);
        assertEq(usdc.balanceOf(cB), 100_000e6);
    }

    function test_5_refundPool_happyPath_unchanged() public {
        bytes32 id = keccak256("refund-happy");
        vm.prank(creator);
        pool.createPool(id, target, 1000e6, block.timestamp + 1 days, ProvianRecourseProjectPool.Currency.USDC);
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
