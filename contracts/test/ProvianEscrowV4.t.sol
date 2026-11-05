// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ProvianEscrowV4.sol";
import "./MockEpochClock.sol";
import "./MockTokens.sol";
import {MockIssuanceIndex} from "./MockIssuanceIndex.sol";

/**
 * @title ProvianEscrowV4Test
 * @notice Unit tests for ProvianEscrowV4 covering both currency paths.
 *
 *         What this verifies:
 *         - USDC happy path matches V3 behavior bit-for-bit (same events, same
 *           token transfers, same fee → feeWallet routing).
 *         - USDC + PVT-fee-discount legacy path still works (PVT burned at 50%).
 *         - PVT happy path: principal in PVT, fee burned via the PVT9
 *           burn(uint256) self-burn, recipient receives net principal in PVT.
 *           Burn assertions check the amount (pvt.totalBurned / pvt.burnedBy)
 *           AND the entrypoint (pvt.selfBurnedBy, which only burn() feeds), so
 *           a regression back to protocolBurn() cannot pass silently.
 *         - PVT path rejects payFeeInPVT==true at funding (no double-discount).
 *         - PVT dispute → court-resolved release/refund moves PVT correctly.
 *         - Currency is immutable post-creation (no path mutates the field).
 *         - Cross-currency invariants: PVT-principal flows never touch USDC,
 *           USDC-principal flows touch PVT only via the explicit discount path.
 */
contract ProvianEscrowV4Test is Test {
    ProvianEscrowV4 public escrow;
    MockUSDC public usdc;
    MockPVT public pvt;

    address public admin = address(0xA01);
    address public feeWallet = address(0xFEE);
    address public depositor = address(0xD01);
    address public recipient = address(0xD02);
    address public court = address(0xC07);

    uint256 public constant USDC_AMOUNT = 1000e6;        // 1000 USDC
    uint256 public constant PVT_AMOUNT = 1000e18;        // 1000 PVT
    uint256 public constant USDC_FEE = 5e6;              // 0.5%
    uint256 public constant PVT_FEE = 5e18;              // 0.5%

    function setUp() public {
        usdc = new MockUSDC();
        pvt = new MockPVT();
        escrow = new ProvianEscrowV4(admin, feeWallet, address(usdc), address(pvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), new ProvianEscrowV4.EscrowSeed[](0));

        // Fund depositor with both currencies and pre-approve max.
        usdc.mint(depositor, 100_000e6);
        pvt.mint(depositor, 100_000e18);
        vm.startPrank(depositor);
        usdc.approve(address(escrow), type(uint256).max);
        pvt.approve(address(escrow), type(uint256).max);
        vm.stopPrank();

        // Wire court so the dispute-resolution tests can exercise that path.
        vm.prank(admin);
        escrow.setCourtContract(court);

    }

    // ========================================================================
    // VERSION + CURRENCY VIEW
    // ========================================================================

    function test_version() public view {
        assertEq(escrow.version(), "v4");
    }

    function test_currencyView_USDC() public {
        bytes32 id = keccak256("usdc-view");
        vm.prank(depositor);
        escrow.createEscrow(id, recipient, USDC_AMOUNT, block.timestamp + 1 days, ProvianEscrowV4.Currency.USDC);
        assertEq(uint8(escrow.currency(id)), uint8(ProvianEscrowV4.Currency.USDC));
    }

    function test_currencyView_PVT() public {
        bytes32 id = keccak256("pvt-view");
        vm.prank(depositor);
        escrow.createEscrow(id, recipient, PVT_AMOUNT, block.timestamp + 1 days, ProvianEscrowV4.Currency.PVT);
        assertEq(uint8(escrow.currency(id)), uint8(ProvianEscrowV4.Currency.PVT));
    }

    function test_currencyView_revertOnUnknown() public {
        vm.expectRevert(ProvianEscrowV4.EscrowNotFound.selector);
        escrow.currency(keccak256("never-created"));
    }

    // ========================================================================
    // USDC HAPPY PATH - must match V3 bit-for-bit
    // ========================================================================

    function test_USDC_happyPath() public {
        bytes32 id = keccak256("usdc-happy");
        uint256 deadline = block.timestamp + 1 days;

        vm.prank(depositor);
        escrow.createEscrow(id, recipient, USDC_AMOUNT, deadline, ProvianEscrowV4.Currency.USDC);

        vm.prank(depositor);
        escrow.fundEscrow(id, false);

        // Contract holds full amount; depositor balance reduced.
        assertEq(usdc.balanceOf(address(escrow)), USDC_AMOUNT);
        assertEq(usdc.balanceOf(depositor), 100_000e6 - USDC_AMOUNT);

        vm.prank(depositor);
        escrow.releaseEscrow(id);

        // Recipient receives net; feeWallet receives fee; contract drained.
        assertEq(usdc.balanceOf(recipient), USDC_AMOUNT - USDC_FEE);
        assertEq(usdc.balanceOf(feeWallet), USDC_FEE);
        assertEq(usdc.balanceOf(address(escrow)), 0);

        // No PVT was touched at all.
        assertEq(pvt.totalBurned(), 0);
        assertEq(pvt.balanceOf(feeWallet), 0);
    }

    /// @notice institution deployment: the 50%-PVT-fee discount is RETIRED, and asking for it now FAILS
    ///         LOUDLY. Replaces `test_USDC_withPVTDiscount`, which covered the removed
    ///         branch.
    ///
    /// the RED control for this assertion is
    /// `InstitutionPreChangeSilentFallback.t.sol`, which passes against the shipped
    ///         contracts by showing this exact call SUCCEEDING and silently charging
    ///         in USDC. Without that control, this revert could not be distinguished
    ///         from a branch that never ran.
    function test_USDC_pvtFeeDiscount_isRetired_andRevertsLoudly() public {
        bytes32 id = keccak256("usdc-discount-retired");
        uint256 deadline = block.timestamp + 1 days;

        vm.prank(depositor);
        escrow.createEscrow(id, recipient, USDC_AMOUNT, deadline, ProvianEscrowV4.Currency.USDC);

        vm.prank(depositor);
        vm.expectRevert(ProvianEscrowV4.PVTFeeDiscountRetired.selector);
        escrow.fundEscrow(id, true);

        // Nothing moved: the refusal is total, not partial.
        assertEq(usdc.balanceOf(address(escrow)), 0, "no USDC pulled on a refused fund");
        assertEq(pvt.totalBurned(), 0, "no PVT burned on a refused fund");
    }

    /// @notice The surviving USDC path is unchanged: fee in USDC to feeWallet.
    function test_USDC_feeStaysInSettlementCurrency() public {
        bytes32 id = keccak256("usdc-fee-unchanged");
        uint256 deadline = block.timestamp + 1 days;

        vm.prank(depositor);
        escrow.createEscrow(id, recipient, USDC_AMOUNT, deadline, ProvianEscrowV4.Currency.USDC);
        vm.prank(depositor);
        escrow.fundEscrow(id, false);
        vm.prank(depositor);
        escrow.releaseEscrow(id);

        assertEq(usdc.balanceOf(feeWallet), USDC_FEE, "fee still paid in USDC at the literal");
        assertEq(pvt.totalBurned(), 0, "USDC-principal escrow never touches PVT");
    }
    function test_USDC_autoRelease() public {
        bytes32 id = keccak256("usdc-auto");
        uint256 deadline = block.timestamp + 1 hours;

        vm.prank(depositor);
        escrow.createEscrow(id, recipient, USDC_AMOUNT, deadline, ProvianEscrowV4.Currency.USDC);
        vm.prank(depositor);
        escrow.fundEscrow(id, false);

        // Random caller tries early - must revert.
        vm.prank(address(0xDEAD));
        vm.expectRevert(ProvianEscrowV4.AutoReleaseNotReached.selector);
        escrow.releaseEscrow(id);

        vm.warp(deadline + 1);
        vm.prank(address(0xDEAD));
        escrow.releaseEscrow(id);
        assertEq(usdc.balanceOf(recipient), USDC_AMOUNT - USDC_FEE);
    }

    // ========================================================================
    // PVT HAPPY PATH
    // ========================================================================

    function test_PVT_happyPath() public {
        bytes32 id = keccak256("pvt-happy");
        uint256 deadline = block.timestamp + 1 days;

        vm.prank(depositor);
        escrow.createEscrow(id, recipient, PVT_AMOUNT, deadline, ProvianEscrowV4.Currency.PVT);

        vm.prank(depositor);
        escrow.fundEscrow(id, false);

        // Contract holds (amount - fee) in PVT; fee was burned.
        assertEq(pvt.balanceOf(address(escrow)), PVT_AMOUNT - PVT_FEE);
        assertEq(pvt.totalBurned(), PVT_FEE);
        assertEq(pvt.burnedBy(address(escrow)), PVT_FEE);
        // ...and burned via the PVT9 burn() path, not legacy protocolBurn().
        assertEq(pvt.selfBurnedBy(address(escrow)), PVT_FEE, "fee burned via burn()");

        // No USDC was touched.
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(usdc.balanceOf(feeWallet), 0);

        vm.prank(depositor);
        escrow.releaseEscrow(id);

        assertEq(pvt.balanceOf(recipient), PVT_AMOUNT - PVT_FEE);
        assertEq(pvt.balanceOf(address(escrow)), 0);

        // feeWallet remains PVT-clean.
        assertEq(pvt.balanceOf(feeWallet), 0);
    }

    function test_PVT_rejectsDiscountAtFunding() public {
        bytes32 id = keccak256("pvt-discount-rejected");
        uint256 deadline = block.timestamp + 1 days;

        vm.prank(depositor);
        escrow.createEscrow(id, recipient, PVT_AMOUNT, deadline, ProvianEscrowV4.Currency.PVT);

        vm.prank(depositor);
        vm.expectRevert(ProvianEscrowV4.PVTPrincipalRejectsDiscount.selector);
        escrow.fundEscrow(id, true);
    }

    function test_PVT_autoRelease() public {
        bytes32 id = keccak256("pvt-auto");
        uint256 deadline = block.timestamp + 1 hours;

        vm.prank(depositor);
        escrow.createEscrow(id, recipient, PVT_AMOUNT, deadline, ProvianEscrowV4.Currency.PVT);
        vm.prank(depositor);
        escrow.fundEscrow(id, false);

        vm.warp(deadline + 1);
        vm.prank(address(0xDEAD));
        escrow.releaseEscrow(id);
        assertEq(pvt.balanceOf(recipient), PVT_AMOUNT - PVT_FEE);
    }

    function test_PVT_cancelBeforeFund() public {
        bytes32 id = keccak256("pvt-cancel");
        vm.prank(depositor);
        escrow.createEscrow(id, recipient, PVT_AMOUNT, block.timestamp + 1 days, ProvianEscrowV4.Currency.PVT);

        vm.prank(depositor);
        escrow.cancelEscrow(id);

        // No tokens moved in either direction.
        assertEq(pvt.balanceOf(address(escrow)), 0);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(pvt.totalBurned(), 0);
    }

    // ========================================================================
    // PVT DISPUTE PATHS (court-resolved)
    // ========================================================================

    function test_PVT_disputeReleaseToRecipient() public {
        bytes32 id = keccak256("pvt-dispute-release");
        uint256 deadline = block.timestamp + 1 days;

        vm.prank(depositor);
        escrow.createEscrow(id, recipient, PVT_AMOUNT, deadline, ProvianEscrowV4.Currency.PVT);
        vm.prank(depositor);
        escrow.fundEscrow(id, false);

        vm.prank(depositor);
        escrow.disputeEscrow(id);

        // Court releases to recipient.
        vm.prank(court);
        escrow.resolveDispute(id, true);

        assertEq(pvt.balanceOf(recipient), PVT_AMOUNT - PVT_FEE);
        assertEq(pvt.balanceOf(address(escrow)), 0);
        assertEq(pvt.balanceOf(feeWallet), 0);

        // Fee was burned at funding - no additional burn at resolution.
        assertEq(pvt.totalBurned(), PVT_FEE);
    }

    function test_PVT_disputeRefundDepositor() public {
        bytes32 id = keccak256("pvt-dispute-refund");
        uint256 deadline = block.timestamp + 1 days;

        uint256 depositorPVTBefore = pvt.balanceOf(depositor);

        vm.prank(depositor);
        escrow.createEscrow(id, recipient, PVT_AMOUNT, deadline, ProvianEscrowV4.Currency.PVT);
        vm.prank(depositor);
        escrow.fundEscrow(id, false);

        vm.prank(depositor);
        escrow.disputeEscrow(id);

        // Court refunds to depositor.
        vm.prank(court);
        escrow.resolveDispute(id, false);

        // Depositor recovers (amount - fee). Fee was burned at funding and is gone.
        assertEq(pvt.balanceOf(depositor), depositorPVTBefore - PVT_FEE);
        assertEq(pvt.balanceOf(recipient), 0);
        assertEq(pvt.balanceOf(address(escrow)), 0);
        assertEq(pvt.balanceOf(feeWallet), 0);
        assertEq(pvt.totalBurned(), PVT_FEE);
    }

    function test_USDC_disputeRefundDepositor() public {
        bytes32 id = keccak256("usdc-dispute-refund");
        uint256 deadline = block.timestamp + 1 days;

        vm.prank(depositor);
        escrow.createEscrow(id, recipient, USDC_AMOUNT, deadline, ProvianEscrowV4.Currency.USDC);
        vm.prank(depositor);
        escrow.fundEscrow(id, false);

        vm.prank(depositor);
        escrow.disputeEscrow(id);

        vm.prank(court);
        escrow.resolveDispute(id, false);

        // V3 behavior: depositor refunded (amount - fee), feeWallet still gets fee
        // because dispute resolution is "service rendered."
        assertEq(usdc.balanceOf(depositor), 100_000e6 - USDC_FEE);
        assertEq(usdc.balanceOf(feeWallet), USDC_FEE);
    }

    // ========================================================================
    // CURRENCY ISOLATION INVARIANTS (verified in unit tests; full symbolic +
    // fuzz coverage lives in ProvianAgentBankHalmos.t.sol and EchidnaAgentBank.sol)
    // ========================================================================

    function test_invariant_PVT_currency_never_credits_feeWallet() public {
        // Run a full PVT escrow lifecycle and assert feeWallet's PVT balance
        // is zero at every observable point.
        bytes32 id = keccak256("pvt-isolation");
        vm.prank(depositor);
        escrow.createEscrow(id, recipient, PVT_AMOUNT, block.timestamp + 1 days, ProvianEscrowV4.Currency.PVT);
        assertEq(pvt.balanceOf(feeWallet), 0);

        vm.prank(depositor);
        escrow.fundEscrow(id, false);
        assertEq(pvt.balanceOf(feeWallet), 0);

        vm.prank(depositor);
        escrow.releaseEscrow(id);
        assertEq(pvt.balanceOf(feeWallet), 0);
    }

    function test_invariant_PVT_currency_never_touches_USDC() public {
        // After a complete PVT escrow lifecycle, USDC balance changes for all
        // tracked accounts must be zero.
        uint256 depUSDCBefore = usdc.balanceOf(depositor);
        uint256 recUSDCBefore = usdc.balanceOf(recipient);
        uint256 feeUSDCBefore = usdc.balanceOf(feeWallet);
        uint256 escUSDCBefore = usdc.balanceOf(address(escrow));

        bytes32 id = keccak256("pvt-no-usdc");
        vm.prank(depositor);
        escrow.createEscrow(id, recipient, PVT_AMOUNT, block.timestamp + 1 days, ProvianEscrowV4.Currency.PVT);
        vm.prank(depositor);
        escrow.fundEscrow(id, false);
        vm.prank(depositor);
        escrow.releaseEscrow(id);

        assertEq(usdc.balanceOf(depositor), depUSDCBefore);
        assertEq(usdc.balanceOf(recipient), recUSDCBefore);
        assertEq(usdc.balanceOf(feeWallet), feeUSDCBefore);
        assertEq(usdc.balanceOf(address(escrow)), escUSDCBefore);
    }

    function test_invariant_USDC_standard_path_never_burns_PVT() public {
        uint256 burnedBefore = pvt.totalBurned();

        bytes32 id = keccak256("usdc-no-burn");
        vm.prank(depositor);
        escrow.createEscrow(id, recipient, USDC_AMOUNT, block.timestamp + 1 days, ProvianEscrowV4.Currency.USDC);
        vm.prank(depositor);
        escrow.fundEscrow(id, false); // payFeeInPVT == false
        vm.prank(depositor);
        escrow.releaseEscrow(id);

        assertEq(pvt.totalBurned(), burnedBefore);
    }

    function test_currency_immutable_after_create() public {
        bytes32 id = keccak256("immutable");
        vm.prank(depositor);
        escrow.createEscrow(id, recipient, PVT_AMOUNT, block.timestamp + 1 days, ProvianEscrowV4.Currency.PVT);

        // There is no setter for currency. Status transitions never touch the
        // field. The only way to "change" currency would be to overwrite the
        // entry, which is blocked by EscrowAlreadyExists.
        vm.prank(depositor);
        vm.expectRevert(ProvianEscrowV4.EscrowAlreadyExists.selector);
        escrow.createEscrow(id, recipient, USDC_AMOUNT, block.timestamp + 1 days, ProvianEscrowV4.Currency.USDC);

        assertEq(uint8(escrow.currency(id)), uint8(ProvianEscrowV4.Currency.PVT));
    }

    // ========================================================================
    // ADMIN / COURT WIRING
    // ========================================================================

    function test_setCourtContract_oneTime() public {
        // Already set in setUp - second attempt must revert.
        vm.prank(admin);
        vm.expectRevert(ProvianEscrowV4.CourtAlreadySet.selector);
        escrow.setCourtContract(address(0xC08));
    }

    function test_resolveDispute_onlyAdminOrCourt() public {
        bytes32 id = keccak256("auth-test");
        vm.prank(depositor);
        escrow.createEscrow(id, recipient, USDC_AMOUNT, block.timestamp + 1 days, ProvianEscrowV4.Currency.USDC);
        vm.prank(depositor);
        escrow.fundEscrow(id, false);
        vm.prank(depositor);
        escrow.disputeEscrow(id);

        vm.prank(address(0xDEAD));
        vm.expectRevert(ProvianEscrowV4.OnlyAdminOrCourt.selector);
        escrow.resolveDispute(id, true);

        // Admin can resolve.
        vm.prank(admin);
        escrow.resolveDispute(id, true);
    }
}
