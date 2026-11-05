// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ProvianPoolV3.sol";
import "./MockTokens.sol";
import "./MockEpochClock.sol";

/**
 * @title ProvianPoolV3Test
 * @notice Unit tests for ProvianPoolV3 covering both currency paths.
 *
 *         Verifies USDC parity with V2, PVT-principal flows (contributions in
 *         PVT, fee burned at executePool from pooled funds via the PVT9
 *         burn(uint256) self-burn, target receives net), refund flows in both
 *         currencies, currency-isolation properties, and that contribute()
 *         routes to the right token automatically based on the pool's currency.
 *
 *         Burn assertions check the amount (pvt.totalBurned) AND the entrypoint
 *         (pvt.selfBurnedBy, which only burn() feeds), so a regression back to
 *         protocolBurn() cannot pass silently.
 */
contract ProvianPoolV3Test is Test {
    ProvianPoolV3 public pool;
    MockUSDC public usdc;
    MockPVT public pvt;

    address public admin = address(0xA01);
    address public feeWallet = address(0xFEE);
    address public creator = address(0xCAA);
    address public target = address(0x7AA);
    address public contributorA = address(0xC01);
    address public contributorB = address(0xC02);
    address public contributorC = address(0xC03);

    uint256 public constant USDC_THRESHOLD = 1000e6;
    uint256 public constant USDC_FEE = 5e6;
    uint256 public constant PVT_THRESHOLD = 1000e18;
    uint256 public constant PVT_FEE = 5e18;

    function setUp() public {
        usdc = new MockUSDC();
        pvt = new MockPVT();
        pool = new ProvianPoolV3(admin, feeWallet, address(usdc), address(pvt), address(new MockEpochClock(0)));

        // Fund three contributors and the creator with both currencies.
        address[4] memory funded = [creator, contributorA, contributorB, contributorC];
        for (uint256 i = 0; i < funded.length; i++) {
            usdc.mint(funded[i], 100_000e6);
            pvt.mint(funded[i], 100_000e18);
            vm.startPrank(funded[i]);
            usdc.approve(address(pool), type(uint256).max);
            pvt.approve(address(pool), type(uint256).max);
            vm.stopPrank();
        }

    }

    // ========================================================================
    // VERSION + CURRENCY VIEW
    // ========================================================================

    function test_version() public view {
        assertEq(pool.version(), "v3");
    }

    function test_currencyView_PVT() public {
        bytes32 id = keccak256("pvt-pool-view");
        vm.prank(creator);
        pool.createPool(id, target, PVT_THRESHOLD, block.timestamp + 1 days, ProvianPoolV3.Currency.PVT);
        assertEq(uint8(pool.currency(id)), uint8(ProvianPoolV3.Currency.PVT));
    }

    function test_currencyView_revertOnUnknown() public {
        vm.expectRevert(ProvianPoolV3.PoolNotFound.selector);
        pool.currency(keccak256("never-created"));
    }

    // ========================================================================
    // USDC HAPPY PATH
    // ========================================================================

    function test_USDC_happyPath() public {
        bytes32 id = keccak256("usdc-pool-happy");
        uint256 deadline = block.timestamp + 7 days;

        vm.prank(creator);
        pool.createPool(id, target, USDC_THRESHOLD, deadline, ProvianPoolV3.Currency.USDC);

        vm.prank(contributorA);
        pool.contribute(id, 600e6);
        vm.prank(contributorB);
        pool.contribute(id, 400e6);

        // Pool should now be Funded.
        vm.prank(creator);
        pool.executePool(id, false);

        assertEq(usdc.balanceOf(target), USDC_THRESHOLD - USDC_FEE);
        assertEq(usdc.balanceOf(feeWallet), USDC_FEE);
        assertEq(pvt.totalBurned(), 0);
    }

    /// @notice institution deployment: the 50%-PVT-fee discount is RETIRED and now FAILS LOUDLY.
    /// Replaces `test_USDC_executeWithPVTDiscount`. RED control:
    /// `InstitutionPreChangeSilentFallback.t.sol` shows this same call SUCCEEDING
    ///         against the shipped contract while silently charging in USDC.
    function test_USDC_pvtFeeDiscount_isRetired_andRevertsLoudly() public {
        bytes32 id = keccak256("usdc-pool-discount-retired");
        uint256 deadline = block.timestamp + 7 days;

        vm.prank(creator);
        pool.createPool(id, target, USDC_THRESHOLD, deadline, ProvianPoolV3.Currency.USDC);
        vm.prank(contributorA);
        pool.contribute(id, USDC_THRESHOLD);

        vm.prank(creator);
        vm.expectRevert(ProvianPoolV3.PVTFeeDiscountRetired.selector);
        pool.executePool(id, true);

        assertEq(pvt.totalBurned(), 0, "no PVT burned on a refused execute");
        assertEq(usdc.balanceOf(target), 0, "no payout on a refused execute");
    }

    /// @notice The surviving USDC path is unchanged: fee in USDC to feeWallet.
    function test_USDC_feeStaysInSettlementCurrency() public {
        bytes32 id = keccak256("usdc-pool-fee-unchanged");
        vm.prank(creator);
        pool.createPool(id, target, USDC_THRESHOLD, block.timestamp + 7 days, ProvianPoolV3.Currency.USDC);
        vm.prank(contributorA);
        pool.contribute(id, USDC_THRESHOLD);
        vm.prank(creator);
        pool.executePool(id, false);

        assertEq(usdc.balanceOf(feeWallet), USDC_FEE, "fee still paid in USDC at the literal");
        assertEq(usdc.balanceOf(target), USDC_THRESHOLD - USDC_FEE, "target gets net");
        assertEq(pvt.totalBurned(), 0, "USDC-principal pool never touches PVT");
    }

    // ========================================================================
    // PVT HAPPY PATH
    // ========================================================================

    function test_PVT_happyPath() public {
        bytes32 id = keccak256("pvt-pool-happy");
        uint256 deadline = block.timestamp + 7 days;

        vm.prank(creator);
        pool.createPool(id, target, PVT_THRESHOLD, deadline, ProvianPoolV3.Currency.PVT);

        vm.prank(contributorA);
        pool.contribute(id, 700e18);
        vm.prank(contributorB);
        pool.contribute(id, 300e18);

        vm.prank(creator);
        pool.executePool(id, false);

        // Target receives (threshold - fee); fee burned from pooled funds.
        assertEq(pvt.balanceOf(target), PVT_THRESHOLD - PVT_FEE);
        assertEq(pvt.totalBurned(), PVT_FEE);
        // ...and burned via the PVT9 burn() path, not legacy protocolBurn().
        assertEq(pvt.selfBurnedBy(address(pool)), PVT_FEE, "fee burned via burn()");
        assertEq(pvt.balanceOf(address(pool)), 0);

        // No USDC was touched.
        assertEq(usdc.balanceOf(target), 0);
        assertEq(usdc.balanceOf(feeWallet), 0);
    }

    function test_PVT_executeRejectsDiscount() public {
        bytes32 id = keccak256("pvt-pool-discount-reject");
        vm.prank(creator);
        pool.createPool(id, target, PVT_THRESHOLD, block.timestamp + 1 days, ProvianPoolV3.Currency.PVT);
        vm.prank(contributorA);
        pool.contribute(id, PVT_THRESHOLD);

        vm.prank(creator);
        vm.expectRevert(ProvianPoolV3.PVTPrincipalRejectsDiscount.selector);
        pool.executePool(id, true);
    }

    function test_PVT_excessRefundedProRata() public {
        bytes32 id = keccak256("pvt-pool-excess");
        vm.prank(creator);
        pool.createPool(id, target, 1000e18, block.timestamp + 1 days, ProvianPoolV3.Currency.PVT);

        // Pool stays Open until a contribution pushes totalContributed >=
        // threshold. Stage A=400 then B=400 keeps it Open, then C=400 crosses
        // 1000 with 200 excess (totalContributed=1200, status flips to Funded).
        vm.prank(contributorA);
        pool.contribute(id, 400e18);
        vm.prank(contributorB);
        pool.contribute(id, 400e18);
        vm.prank(contributorC);
        pool.contribute(id, 400e18);

        uint256 aBefore = pvt.balanceOf(contributorA);
        uint256 bBefore = pvt.balanceOf(contributorB);
        uint256 cBefore = pvt.balanceOf(contributorC);

        vm.prank(creator);
        pool.executePool(id, false);

        // Target receives 995 PVT (1000 - 0.5% fee). Fee burned: 5 PVT.
        assertEq(pvt.balanceOf(target), 1000e18 - 5e18);
        assertEq(pvt.totalBurned(), 5e18);
        // ...and burned via the PVT9 burn() path, not legacy protocolBurn().
        assertEq(pvt.selfBurnedBy(address(pool)), 5e18, "fee burned via burn()");

        // Refund pro-rata: 200 PVT excess split by contribution ratios
        // (A=B=C=400/1200 = 1/3).
        // A: floor(400 * 200 / 1200) PVT, B: same, C (last) absorbs dust.
        // Compute refunds through typed locals so the compiler doesn't try to
        // constant-fold to a non-integer rational.
        uint256 totalContrib = 1200e18;
        uint256 excess = 200e18;
        uint256 contribAmount = 400e18;
        uint256 perContribRefund = (contribAmount * excess) / totalContrib;
        assertEq(pvt.balanceOf(contributorA), aBefore + perContribRefund);
        assertEq(pvt.balanceOf(contributorB), bBefore + perContribRefund);
        // C is the last contributor and absorbs all rounding dust.
        uint256 cRefund = excess - 2 * perContribRefund;
        assertEq(pvt.balanceOf(contributorC), cBefore + cRefund);

        // Pool balance fully drained - target + burn + refunds == totalContributed.
        assertEq(pvt.balanceOf(address(pool)), 0);
    }

    function test_PVT_refundOnDeadline() public {
        bytes32 id = keccak256("pvt-pool-refund");
        uint256 deadline = block.timestamp + 1 days;

        vm.prank(creator);
        pool.createPool(id, target, PVT_THRESHOLD, deadline, ProvianPoolV3.Currency.PVT);

        vm.prank(contributorA);
        pool.contribute(id, 300e18);
        vm.prank(contributorB);
        pool.contribute(id, 200e18);

        uint256 aBefore = pvt.balanceOf(contributorA);
        uint256 bBefore = pvt.balanceOf(contributorB);

        // Open pool, deadline expired - anyone can refund.
        vm.warp(deadline + 1);
        vm.prank(address(0xDEAD));
        pool.refundPool(id);

        assertEq(pvt.balanceOf(contributorA), aBefore + 300e18);
        assertEq(pvt.balanceOf(contributorB), bBefore + 200e18);
        assertEq(pvt.balanceOf(address(pool)), 0);
        assertEq(pvt.totalBurned(), 0);
    }

    function test_PVT_withdrawWhileOpen() public {
        bytes32 id = keccak256("pvt-pool-withdraw");
        vm.prank(creator);
        pool.createPool(id, target, PVT_THRESHOLD, block.timestamp + 1 days, ProvianPoolV3.Currency.PVT);

        vm.prank(contributorA);
        pool.contribute(id, 400e18);

        uint256 aBefore = pvt.balanceOf(contributorA);
        vm.prank(contributorA);
        pool.withdrawContribution(id);
        assertEq(pvt.balanceOf(contributorA), aBefore + 400e18);
    }

    // ========================================================================
    // CURRENCY ISOLATION
    // ========================================================================

    function test_invariant_PVT_pool_never_touches_USDC() public {
        uint256 aUSDCBefore = usdc.balanceOf(contributorA);
        uint256 targetUSDCBefore = usdc.balanceOf(target);
        uint256 feeUSDCBefore = usdc.balanceOf(feeWallet);

        bytes32 id = keccak256("pvt-no-usdc-pool");
        vm.prank(creator);
        pool.createPool(id, target, PVT_THRESHOLD, block.timestamp + 1 days, ProvianPoolV3.Currency.PVT);
        vm.prank(contributorA);
        pool.contribute(id, PVT_THRESHOLD);
        vm.prank(creator);
        pool.executePool(id, false);

        assertEq(usdc.balanceOf(contributorA), aUSDCBefore);
        assertEq(usdc.balanceOf(target), targetUSDCBefore);
        assertEq(usdc.balanceOf(feeWallet), feeUSDCBefore);
    }

    function test_invariant_PVT_pool_burns_fee_never_credits_feeWallet() public {
        bytes32 id = keccak256("pvt-fee-burned-pool");
        vm.prank(creator);
        pool.createPool(id, target, PVT_THRESHOLD, block.timestamp + 1 days, ProvianPoolV3.Currency.PVT);
        vm.prank(contributorA);
        pool.contribute(id, PVT_THRESHOLD);

        uint256 burnedBefore = pvt.totalBurned();
        uint256 selfBurnedBefore = pvt.selfBurnedBy(address(pool));

        vm.prank(creator);
        pool.executePool(id, false);

        assertEq(pvt.totalBurned(), burnedBefore + PVT_FEE);
        assertEq(pvt.selfBurnedBy(address(pool)), selfBurnedBefore + PVT_FEE, "fee burned via burn()");
        assertEq(pvt.balanceOf(feeWallet), 0);
    }

    function test_invariant_USDC_standard_pool_never_burns_PVT() public {
        uint256 burnedBefore = pvt.totalBurned();

        bytes32 id = keccak256("usdc-no-burn-pool");
        vm.prank(creator);
        pool.createPool(id, target, USDC_THRESHOLD, block.timestamp + 1 days, ProvianPoolV3.Currency.USDC);
        vm.prank(contributorA);
        pool.contribute(id, USDC_THRESHOLD);
        vm.prank(creator);
        pool.executePool(id, false);

        assertEq(pvt.totalBurned(), burnedBefore);
    }

    function test_currency_immutable_after_create() public {
        bytes32 id = keccak256("immutable-pool");
        vm.prank(creator);
        pool.createPool(id, target, PVT_THRESHOLD, block.timestamp + 1 days, ProvianPoolV3.Currency.PVT);

        vm.prank(creator);
        vm.expectRevert(ProvianPoolV3.PoolAlreadyExists.selector);
        pool.createPool(id, target, USDC_THRESHOLD, block.timestamp + 1 days, ProvianPoolV3.Currency.USDC);

        assertEq(uint8(pool.currency(id)), uint8(ProvianPoolV3.Currency.PVT));
    }

    // ========================================================================
    // WS5: contribute -> withdraw -> contribute must NOT duplicate a contributor
    // (the double-pay / cross-pool drain regression).
    // ========================================================================

    function test_WS5_noDoublePay_afterWithdrawReContribute() public {
        bytes32 id = keccak256("ws5-double-pay");
        uint256 deadline = block.timestamp + 1 days;
        vm.prank(creator);
        pool.createPool(id, target, PVT_THRESHOLD, deadline, ProvianPoolV3.Currency.PVT);

        // A contributes, fully withdraws, then contributes again. The contribute
        // de-dup only checks balance==0 (true right after withdrawal); before the
        // fix this pushed A into contributorList a SECOND time.
        vm.prank(contributorA);
        pool.contribute(id, 100e18);
        vm.prank(contributorA);
        pool.withdrawContribution(id);
        vm.prank(contributorA);
        pool.contribute(id, 100e18);

        // The list must contain A exactly once.
        assertEq(pool.getContributorCount(id), 1);

        // B contributes too, so a double-pay of A would have to come out of B's
        // (or another pool's) funds — the actual drain vector.
        vm.prank(contributorB);
        pool.contribute(id, 100e18);

        uint256 aBefore = pvt.balanceOf(contributorA);
        uint256 bBefore = pvt.balanceOf(contributorB);

        vm.warp(deadline + 1);
        vm.prank(address(0xDEAD));
        pool.refundPool(id);

        // Each contributor gets back exactly their single contribution; the pool
        // is fully drained with no shortfall (a double-pay would either over-pay
        // A and revert on B, or leave the books unbalanced).
        assertEq(pvt.balanceOf(contributorA), aBefore + 100e18);
        assertEq(pvt.balanceOf(contributorB), bBefore + 100e18);
        assertEq(pvt.balanceOf(address(pool)), 0);
    }

    function test_contributorCap_PVT() public {
        bytes32 id = keccak256("pvt-pool-cap");
        vm.prank(creator);
        pool.createPool(id, target, 100_000e18, block.timestamp + 30 days, ProvianPoolV3.Currency.PVT);

        // Fill to MAX_CONTRIBUTORS_PER_POOL with unique addresses derived
        // from sequential private keys via vm.addr (avoids unsafe-typecast lint).
        uint256 cap = pool.MAX_CONTRIBUTORS_PER_POOL();
        for (uint256 i = 1; i <= cap; i++) {
            address contributor = vm.addr(0x10000 + i);
            pvt.mint(contributor, 1e18);
            vm.prank(contributor);
            pvt.approve(address(pool), 1e18);
            vm.prank(contributor);
            pool.contribute(id, 1e18);
        }

        // Cap+1: must revert.
        address overflow = vm.addr(0x10000 + cap + 1);
        pvt.mint(overflow, 1e18);
        vm.prank(overflow);
        pvt.approve(address(pool), 1e18);
        vm.prank(overflow);
        vm.expectRevert(bytes("ProvianPoolV3: contributor cap reached"));
        pool.contribute(id, 1e18);
    }
}
