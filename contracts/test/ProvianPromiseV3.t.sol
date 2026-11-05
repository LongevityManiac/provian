// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ProvianPromiseV3.sol";
import "./MockEpochClock.sol";
import "./MockTokens.sol";

/**
 * @title ProvianPromiseV3Test
 * @notice Unit tests for ProvianPromiseV3 covering both currency paths.
 *
 *         Verifies USDC parity with V2, PVT-principal flows (lender funds in
 *         PVT, borrower settles in PVT, fee burned via the PVT9 burn(uint256)
 *         self-burn), default flow currency-agnostic, and currency-isolation
 *         properties. Burn assertions check the amount (pvt.totalBurned) AND
 *         the entrypoint (pvt.selfBurnedBy, which only burn() feeds), so a
 *         regression back to protocolBurn() cannot pass silently.
 */
contract ProvianPromiseV3Test is Test {
    ProvianPromiseV3 public promiseContract;
    MockUSDC public usdc;
    MockPVT public pvt;

    address public admin = address(0xA01);
    address public feeWallet = address(0xFEE);
    address public borrower = address(0xB01);
    address public lender = address(0xB02);

    uint256 public constant USDC_PRINCIPAL = 1000e6;
    uint256 public constant USDC_REPAY = 1100e6;
    uint256 public constant USDC_FEE = (USDC_REPAY * 25) / 10000; // 2.75 USDC
    uint256 public constant PVT_PRINCIPAL = 1000e18;
    uint256 public constant PVT_REPAY = 1100e18;
    uint256 public constant PVT_FEE = (PVT_REPAY * 25) / 10000;   // 2.75 PVT

    function setUp() public {
        usdc = new MockUSDC();
        pvt = new MockPVT();
        promiseContract = new ProvianPromiseV3(admin, feeWallet, address(usdc), address(pvt), address(new MockEpochClock(0)));

        // Fund both parties in both currencies, pre-approve max.
        usdc.mint(borrower, 100_000e6);
        usdc.mint(lender, 100_000e6);
        pvt.mint(borrower, 100_000e18);
        pvt.mint(lender, 100_000e18);

        vm.startPrank(borrower);
        usdc.approve(address(promiseContract), type(uint256).max);
        pvt.approve(address(promiseContract), type(uint256).max);
        vm.stopPrank();

        vm.startPrank(lender);
        usdc.approve(address(promiseContract), type(uint256).max);
        pvt.approve(address(promiseContract), type(uint256).max);
        vm.stopPrank();

    }

    // ========================================================================
    // VERSION + CURRENCY VIEW
    // ========================================================================

    function test_version() public view {
        assertEq(promiseContract.version(), "v3");
    }

    function test_currencyView_PVT() public {
        bytes32 id = keccak256("pvt-promise-view");
        vm.prank(borrower);
        promiseContract.createPromise(id, PVT_PRINCIPAL, PVT_REPAY, block.timestamp + 1 days, ProvianPromiseV3.Currency.PVT);
        assertEq(uint8(promiseContract.currency(id)), uint8(ProvianPromiseV3.Currency.PVT));
    }

    function test_currencyView_revertOnUnknown() public {
        vm.expectRevert(ProvianPromiseV3.PromiseNotFound.selector);
        promiseContract.currency(keccak256("never-created"));
    }

    // ========================================================================
    // USDC HAPPY PATH (V2 parity)
    // ========================================================================

    function test_USDC_happyPath() public {
        bytes32 id = keccak256("usdc-happy");
        uint256 deadline = block.timestamp + 7 days;

        vm.prank(borrower);
        promiseContract.createPromise(id, USDC_PRINCIPAL, USDC_REPAY, deadline, ProvianPromiseV3.Currency.USDC);

        vm.prank(lender);
        promiseContract.fundPromise(id);
        // Lender → borrower direct transfer of principal.
        assertEq(usdc.balanceOf(borrower), 100_000e6 + USDC_PRINCIPAL);
        assertEq(usdc.balanceOf(lender), 100_000e6 - USDC_PRINCIPAL);

        vm.prank(borrower);
        promiseContract.settlePromise(id, false);
        // Borrower → lender (repay - fee) + borrower → feeWallet (fee).
        assertEq(usdc.balanceOf(lender), 100_000e6 - USDC_PRINCIPAL + (USDC_REPAY - USDC_FEE));
        assertEq(usdc.balanceOf(feeWallet), USDC_FEE);
        assertEq(pvt.totalBurned(), 0);
    }

    /// @notice institution deployment: the 50%-PVT-fee discount is RETIRED and now FAILS LOUDLY.
    /// Replaces `test_USDC_withPVTDiscount`. RED control:
    /// `InstitutionPreChangeSilentFallback.t.sol` shows this same call SUCCEEDING
    ///         against the shipped contract while silently charging in USDC.
    function test_USDC_pvtFeeDiscount_isRetired_andRevertsLoudly() public {
        bytes32 id = keccak256("usdc-discount-retired");
        uint256 deadline = block.timestamp + 7 days;

        vm.prank(borrower);
        promiseContract.createPromise(id, USDC_PRINCIPAL, USDC_REPAY, deadline, ProvianPromiseV3.Currency.USDC);
        vm.prank(lender);
        promiseContract.fundPromise(id);

        vm.prank(borrower);
        vm.expectRevert(ProvianPromiseV3.PVTFeeDiscountRetired.selector);
        promiseContract.settlePromise(id, true);

        assertEq(pvt.totalBurned(), 0, "no PVT burned on a refused settle");
    }

    /// @notice The surviving USDC path is unchanged: fee in USDC to feeWallet.
    function test_USDC_feeStaysInSettlementCurrency() public {
        bytes32 id = keccak256("usdc-fee-unchanged");
        vm.prank(borrower);
        promiseContract.createPromise(id, USDC_PRINCIPAL, USDC_REPAY, block.timestamp + 7 days, ProvianPromiseV3.Currency.USDC);
        vm.prank(lender);
        promiseContract.fundPromise(id);
        vm.prank(borrower);
        promiseContract.settlePromise(id, false);

        assertEq(usdc.balanceOf(feeWallet), USDC_FEE, "fee still paid in USDC at the literal");
        assertEq(pvt.totalBurned(), 0, "USDC-principal promise never touches PVT");
    }
    function test_PVT_happyPath() public {
        bytes32 id = keccak256("pvt-happy");
        uint256 deadline = block.timestamp + 7 days;

        uint256 borrowerPVTBefore = pvt.balanceOf(borrower);
        uint256 lenderPVTBefore = pvt.balanceOf(lender);

        vm.prank(borrower);
        promiseContract.createPromise(id, PVT_PRINCIPAL, PVT_REPAY, deadline, ProvianPromiseV3.Currency.PVT);

        vm.prank(lender);
        promiseContract.fundPromise(id);
        // Lender → borrower direct PVT transfer.
        assertEq(pvt.balanceOf(borrower), borrowerPVTBefore + PVT_PRINCIPAL);
        assertEq(pvt.balanceOf(lender), lenderPVTBefore - PVT_PRINCIPAL);

        vm.prank(borrower);
        promiseContract.settlePromise(id, false);
        // Borrower → lender (repay - fee) direct, + fee burned.
        assertEq(pvt.balanceOf(lender), lenderPVTBefore - PVT_PRINCIPAL + (PVT_REPAY - PVT_FEE));
        assertEq(pvt.balanceOf(borrower), borrowerPVTBefore + PVT_PRINCIPAL - PVT_REPAY);
        assertEq(pvt.totalBurned(), PVT_FEE);
        // ...and burned via the PVT9 burn() path, not legacy protocolBurn().
        assertEq(pvt.selfBurnedBy(address(promiseContract)), PVT_FEE, "fee burned via burn()");
        // No USDC was touched.
        assertEq(usdc.balanceOf(feeWallet), 0);
    }

    function test_PVT_settle_rejectsDiscount() public {
        bytes32 id = keccak256("pvt-discount-reject");
        vm.prank(borrower);
        promiseContract.createPromise(id, PVT_PRINCIPAL, PVT_REPAY, block.timestamp + 1 days, ProvianPromiseV3.Currency.PVT);
        vm.prank(lender);
        promiseContract.fundPromise(id);

        vm.prank(borrower);
        vm.expectRevert(ProvianPromiseV3.PVTPrincipalRejectsDiscount.selector);
        promiseContract.settlePromise(id, true);
    }

    function test_PVT_default() public {
        bytes32 id = keccak256("pvt-default");
        uint256 deadline = block.timestamp + 1 days;

        vm.prank(borrower);
        promiseContract.createPromise(id, PVT_PRINCIPAL, PVT_REPAY, deadline, ProvianPromiseV3.Currency.PVT);
        vm.prank(lender);
        promiseContract.fundPromise(id);

        // Anyone after deadline + grace period can mark default.
        vm.warp(deadline + promiseContract.DEFAULT_GRACE_PERIOD() + 1);
        vm.prank(address(0xDEAD));
        promiseContract.markDefault(id);

        // Default is currency-agnostic - only flips status, no token movement.
        // Borrower keeps the principal they were lent (lender takes the loss).
        assertEq(pvt.balanceOf(borrower), 100_000e18 + PVT_PRINCIPAL);
        assertEq(pvt.balanceOf(lender), 100_000e18 - PVT_PRINCIPAL);
    }

    function test_default_gracePeriod_blocksThirdParty() public {
        bytes32 id = keccak256("pvt-default-grace");
        uint256 deadline = block.timestamp + 1 days;

        vm.prank(borrower);
        promiseContract.createPromise(id, PVT_PRINCIPAL, PVT_REPAY, deadline, ProvianPromiseV3.Currency.PVT);
        vm.prank(lender);
        promiseContract.fundPromise(id);

        // Just past deadline but still in grace - third party blocked.
        vm.warp(deadline + 1);
        vm.prank(address(0xDEAD));
        vm.expectRevert(ProvianPromiseV3.OnlyBorrower.selector);
        promiseContract.markDefault(id);

        // Lender (party) can still call during grace.
        vm.prank(lender);
        promiseContract.markDefault(id);
    }

    // ========================================================================
    // CURRENCY ISOLATION
    // ========================================================================

    function test_invariant_PVT_promise_never_touches_USDC() public {
        uint256 borrowerUSDCBefore = usdc.balanceOf(borrower);
        uint256 lenderUSDCBefore = usdc.balanceOf(lender);
        uint256 feeUSDCBefore = usdc.balanceOf(feeWallet);

        bytes32 id = keccak256("pvt-no-usdc");
        vm.prank(borrower);
        promiseContract.createPromise(id, PVT_PRINCIPAL, PVT_REPAY, block.timestamp + 1 days, ProvianPromiseV3.Currency.PVT);
        vm.prank(lender);
        promiseContract.fundPromise(id);
        vm.prank(borrower);
        promiseContract.settlePromise(id, false);

        assertEq(usdc.balanceOf(borrower), borrowerUSDCBefore);
        assertEq(usdc.balanceOf(lender), lenderUSDCBefore);
        assertEq(usdc.balanceOf(feeWallet), feeUSDCBefore);
    }

    function test_invariant_PVT_settle_burns_fee_never_credits_feeWallet() public {
        bytes32 id = keccak256("pvt-fee-burned");
        vm.prank(borrower);
        promiseContract.createPromise(id, PVT_PRINCIPAL, PVT_REPAY, block.timestamp + 1 days, ProvianPromiseV3.Currency.PVT);
        vm.prank(lender);
        promiseContract.fundPromise(id);

        uint256 burnedBefore = pvt.totalBurned();
        uint256 selfBurnedBefore = pvt.selfBurnedBy(address(promiseContract));

        vm.prank(borrower);
        promiseContract.settlePromise(id, false);

        assertEq(pvt.totalBurned(), burnedBefore + PVT_FEE);
        assertEq(pvt.selfBurnedBy(address(promiseContract)), selfBurnedBefore + PVT_FEE, "fee burned via burn()");
        assertEq(pvt.balanceOf(feeWallet), 0);
    }

    function test_currency_immutable_after_create() public {
        bytes32 id = keccak256("immutable-promise");
        vm.prank(borrower);
        promiseContract.createPromise(id, PVT_PRINCIPAL, PVT_REPAY, block.timestamp + 1 days, ProvianPromiseV3.Currency.PVT);

        vm.prank(borrower);
        vm.expectRevert(ProvianPromiseV3.PromiseAlreadyExists.selector);
        promiseContract.createPromise(id, USDC_PRINCIPAL, USDC_REPAY, block.timestamp + 1 days, ProvianPromiseV3.Currency.USDC);

        assertEq(uint8(promiseContract.currency(id)), uint8(ProvianPromiseV3.Currency.PVT));
    }
}
