// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ProvianEscrowV4.sol";
import "./MockEpochClock.sol";
import "../src/ProvianPromiseV3.sol";
import "../src/ProvianPoolV3.sol";
import "./MockTokens.sol";
import {MockIssuanceIndex} from "./MockIssuanceIndex.sol";

/**
 * @title ProvianAgentBankHalmos
 * @notice Symbolic proofs of currency-isolation properties for V4 Agent Bank
 *         using Halmos + Z3.
 *
 *         Halmos proves these properties hold for ALL possible inputs (in the
 *         constrained symbolic ranges) using SMT. Foundry fuzz tests sample
 *         random inputs; Halmos proves universal quantification.
 *
 *         Run with:
 *           halmos --contract ProvianAgentBankHalmos --solver-timeout-assertion 30000
 *
 *         Halmos does not support vm.expectRevert(). All revert paths use
 *         try/catch. Keep symbolic state surface minimal so the SMT solver
 *         terminates within the timeout.
 *
 *         Properties proven:
 *           AB-CI1: PVT-principal fund never credits feeWallet PVT.
 *           AB-CI2: PVT-principal fund never moves any USDC.
 *           AB-CI3: USDC-principal fund without discount never burns PVT.
 *           AB-CI4: Currency field is immutable across the full lifecycle.
 *           AB-CI5: PVT-principal fund with payFeeInPVT == true ALWAYS reverts.
 *           AB-CI6: Promise PVT settle never credits feeWallet PVT.
 *           AB-CI7: Pool PVT execute burns exactly fee, target gets exactly net.
 */
contract ProvianAgentBankHalmos is Test {
    ProvianEscrowV4 public escrow;
    ProvianPromiseV3 public promiseContract;
    ProvianPoolV3 public pool;
    MockUSDC public usdc;
    MockPVT public pvt;

    address constant ADMIN = address(0xA01);
    address constant FEE_WALLET = address(0xFEE);
    address constant DEPOSITOR = address(0xD01);
    address constant RECIPIENT = address(0xD02);
    address constant LENDER = address(0xB02);
    address constant CREATOR = address(0xCAA);
    address constant TARGET = address(0x7AA);

    function setUp() public {
        usdc = new MockUSDC();
        pvt = new MockPVT();
        escrow = new ProvianEscrowV4(ADMIN, FEE_WALLET, address(usdc), address(pvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), new ProvianEscrowV4.EscrowSeed[](0));
        promiseContract = new ProvianPromiseV3(ADMIN, FEE_WALLET, address(usdc), address(pvt), address(new MockEpochClock(0)));
        pool = new ProvianPoolV3(ADMIN, FEE_WALLET, address(usdc), address(pvt), address(new MockEpochClock(0)));

        // Pre-fund and approve to keep symbolic surface small (don't make
        // initial balances symbolic - only the operation inputs).
        usdc.mint(DEPOSITOR, 10_000e6);
        pvt.mint(DEPOSITOR, 10_000e18);
        usdc.mint(LENDER, 10_000e6);
        pvt.mint(LENDER, 10_000e18);
        usdc.mint(CREATOR, 10_000e6);
        pvt.mint(CREATOR, 10_000e18);

        vm.prank(DEPOSITOR);
        usdc.approve(address(escrow), type(uint256).max);
        vm.prank(DEPOSITOR);
        pvt.approve(address(escrow), type(uint256).max);

        vm.prank(LENDER);
        usdc.approve(address(promiseContract), type(uint256).max);
        vm.prank(LENDER);
        pvt.approve(address(promiseContract), type(uint256).max);
        vm.prank(DEPOSITOR);
        usdc.approve(address(promiseContract), type(uint256).max);
        vm.prank(DEPOSITOR);
        pvt.approve(address(promiseContract), type(uint256).max);

        vm.prank(CREATOR);
        usdc.approve(address(pool), type(uint256).max);
        vm.prank(CREATOR);
        pvt.approve(address(pool), type(uint256).max);

        // institution deployment: the PVT/USDC rate and its discount path are RETIRED, so there is no
        // longer a rate to establish. The PVT-principal property below is unaffected:
        // it asserts that payFeeInPVT==true on a PVT escrow always reverts, which is
        // still true (PVTPrincipalRejectsDiscount), and is now ALSO true on the USDC
        // side for a different reason (PVTFeeDiscountRetired).
    }

    // ========================================================================
    // AB-CI1: PVT-principal fund never credits feeWallet PVT.
    // ========================================================================

    function check_AB_CI1_pvtFund_neverCreditsFeeWalletPVT(
        bytes32 escrowId,
        uint256 amount,
        uint256 deadlineDelta
    ) public {
        vm.assume(amount > 0 && amount <= 1000e18);
        vm.assume(deadlineDelta > 0 && deadlineDelta < 365 days);

        uint256 feeWalletPVTBefore = pvt.balanceOf(FEE_WALLET);

        vm.prank(DEPOSITOR);
        try escrow.createEscrow(
            escrowId, RECIPIENT, amount, block.timestamp + deadlineDelta,
            ProvianEscrowV4.Currency.PVT
        ) {} catch {
            return;
        }

        vm.prank(DEPOSITOR);
        try escrow.fundEscrow(escrowId, false) {} catch {
            return;
        }

        // Property: feeWallet's PVT balance MUST be unchanged.
        assert(pvt.balanceOf(FEE_WALLET) == feeWalletPVTBefore);
    }

    // ========================================================================
    // AB-CI2: PVT-principal fund never moves any USDC.
    // ========================================================================

    function check_AB_CI2_pvtFund_neverMovesUSDC(
        bytes32 escrowId,
        uint256 amount,
        uint256 deadlineDelta
    ) public {
        vm.assume(amount > 0 && amount <= 1000e18);
        vm.assume(deadlineDelta > 0 && deadlineDelta < 365 days);

        uint256 depUSDCBefore = usdc.balanceOf(DEPOSITOR);
        uint256 recUSDCBefore = usdc.balanceOf(RECIPIENT);
        uint256 escUSDCBefore = usdc.balanceOf(address(escrow));
        uint256 feeUSDCBefore = usdc.balanceOf(FEE_WALLET);

        vm.prank(DEPOSITOR);
        try escrow.createEscrow(
            escrowId, RECIPIENT, amount, block.timestamp + deadlineDelta,
            ProvianEscrowV4.Currency.PVT
        ) {} catch {
            return;
        }

        vm.prank(DEPOSITOR);
        try escrow.fundEscrow(escrowId, false) {} catch {
            return;
        }

        // Property: NO USDC balance for any tracked account changed.
        assert(usdc.balanceOf(DEPOSITOR) == depUSDCBefore);
        assert(usdc.balanceOf(RECIPIENT) == recUSDCBefore);
        assert(usdc.balanceOf(address(escrow)) == escUSDCBefore);
        assert(usdc.balanceOf(FEE_WALLET) == feeUSDCBefore);
    }

    // ========================================================================
    // AB-CI3: USDC-principal fund WITHOUT discount never burns PVT.
    // ========================================================================

    function check_AB_CI3_usdcFundNoDiscount_neverBurnsPVT(
        bytes32 escrowId,
        uint256 amount,
        uint256 deadlineDelta
    ) public {
        vm.assume(amount > 0 && amount <= 1000e6);
        vm.assume(deadlineDelta > 0 && deadlineDelta < 365 days);

        uint256 burnedBefore = pvt.totalBurned();

        vm.prank(DEPOSITOR);
        try escrow.createEscrow(
            escrowId, RECIPIENT, amount, block.timestamp + deadlineDelta,
            ProvianEscrowV4.Currency.USDC
        ) {} catch {
            return;
        }

        vm.prank(DEPOSITOR);
        try escrow.fundEscrow(escrowId, false) {} catch {
            return;
        }

        // Property: pvt.totalBurned MUST NOT increase when payFeeInPVT == false.
        assert(pvt.totalBurned() == burnedBefore);
    }

    // ========================================================================
    // AB-CI4: Currency field is immutable across the full lifecycle.
    //         Holds for any sequence of valid operations.
    // ========================================================================

    function check_AB_CI4_currencyImmutable_PVT_lifecycle(
        bytes32 escrowId,
        uint256 amount,
        uint256 deadlineDelta
    ) public {
        vm.assume(amount > 0 && amount <= 1000e18);
        vm.assume(deadlineDelta > 1 hours && deadlineDelta < 365 days);

        vm.prank(DEPOSITOR);
        try escrow.createEscrow(
            escrowId, RECIPIENT, amount, block.timestamp + deadlineDelta,
            ProvianEscrowV4.Currency.PVT
        ) {} catch {
            return;
        }
        assert(escrow.currency(escrowId) == ProvianEscrowV4.Currency.PVT);

        vm.prank(DEPOSITOR);
        try escrow.fundEscrow(escrowId, false) {} catch {
            return;
        }
        assert(escrow.currency(escrowId) == ProvianEscrowV4.Currency.PVT);

        vm.prank(DEPOSITOR);
        try escrow.releaseEscrow(escrowId) {} catch {
            return;
        }
        assert(escrow.currency(escrowId) == ProvianEscrowV4.Currency.PVT);
    }

    function check_AB_CI4_currencyImmutable_USDC_lifecycle(
        bytes32 escrowId,
        uint256 amount,
        uint256 deadlineDelta
    ) public {
        vm.assume(amount > 0 && amount <= 1000e6);
        vm.assume(deadlineDelta > 1 hours && deadlineDelta < 365 days);

        vm.prank(DEPOSITOR);
        try escrow.createEscrow(
            escrowId, RECIPIENT, amount, block.timestamp + deadlineDelta,
            ProvianEscrowV4.Currency.USDC
        ) {} catch {
            return;
        }
        assert(escrow.currency(escrowId) == ProvianEscrowV4.Currency.USDC);

        vm.prank(DEPOSITOR);
        try escrow.fundEscrow(escrowId, false) {} catch {
            return;
        }
        assert(escrow.currency(escrowId) == ProvianEscrowV4.Currency.USDC);

        vm.prank(DEPOSITOR);
        try escrow.releaseEscrow(escrowId) {} catch {
            return;
        }
        assert(escrow.currency(escrowId) == ProvianEscrowV4.Currency.USDC);
    }

    // ========================================================================
    // AB-CI5: PVT-principal fund with payFeeInPVT == true ALWAYS reverts.
    //         Universally quantified across all inputs.
    // ========================================================================

    function check_AB_CI5_pvtFundWithDiscount_alwaysReverts(
        bytes32 escrowId,
        uint256 amount,
        uint256 deadlineDelta
    ) public {
        vm.assume(amount > 0 && amount <= 1000e18);
        vm.assume(deadlineDelta > 0 && deadlineDelta < 365 days);

        vm.prank(DEPOSITOR);
        try escrow.createEscrow(
            escrowId, RECIPIENT, amount, block.timestamp + deadlineDelta,
            ProvianEscrowV4.Currency.PVT
        ) {} catch {
            return;
        }

        vm.prank(DEPOSITOR);
        try escrow.fundEscrow(escrowId, true) {
            // MUST NOT REACH - payFeeInPVT==true on a PVT escrow must always revert.
            assert(false);
        } catch {
            assert(true);
        }
    }

    // ========================================================================
    // AB-CI6: Promise PVT settle never credits feeWallet PVT.
    // ========================================================================

    function check_AB_CI6_promisePVTSettle_neverCreditsFeeWalletPVT(
        bytes32 promiseId,
        uint256 principal,
        uint256 repay,
        uint256 deadlineDelta
    ) public {
        vm.assume(principal > 0 && principal <= 1000e18);
        vm.assume(repay >= principal && repay <= 2000e18);
        vm.assume(deadlineDelta > 0 && deadlineDelta < 365 days);

        uint256 feeWalletPVTBefore = pvt.balanceOf(FEE_WALLET);

        vm.prank(DEPOSITOR); // borrower
        try promiseContract.createPromise(
            promiseId, principal, repay, block.timestamp + deadlineDelta,
            ProvianPromiseV3.Currency.PVT
        ) {} catch {
            return;
        }

        vm.prank(LENDER);
        try promiseContract.fundPromise(promiseId) {} catch {
            return;
        }

        vm.prank(DEPOSITOR);
        try promiseContract.settlePromise(promiseId, false) {} catch {
            return;
        }

        // Property: feeWallet's PVT balance MUST be unchanged across the lifecycle.
        assert(pvt.balanceOf(FEE_WALLET) == feeWalletPVTBefore);
    }

    // ========================================================================
    // AB-CI7: Pool PVT execute burns exactly fee, target gets exactly net.
    // ========================================================================

    function check_AB_CI7_poolPVTExecute_burnsFeeTargetNet(
        bytes32 poolId,
        uint256 threshold,
        uint256 deadlineDelta
    ) public {
        // Constrain to reachable single-contributor case so the symbolic state
        // stays tractable. Multi-contributor coverage lives in the fuzz suite.
        vm.assume(threshold >= 1000 && threshold <= 1000e18);
        vm.assume(deadlineDelta > 0 && deadlineDelta < 365 days);

        uint256 expectedFee = (threshold * 5) / 1000;
        uint256 expectedNet = threshold - expectedFee;

        uint256 burnedBefore = pvt.totalBurned();
        uint256 targetPVTBefore = pvt.balanceOf(TARGET);
        uint256 feeWalletPVTBefore = pvt.balanceOf(FEE_WALLET);
        uint256 feeWalletUSDCBefore = usdc.balanceOf(FEE_WALLET);

        vm.prank(CREATOR);
        try pool.createPool(
            poolId, TARGET, threshold, block.timestamp + deadlineDelta,
            ProvianPoolV3.Currency.PVT
        ) {} catch {
            return;
        }

        vm.prank(CREATOR);
        try pool.contribute(poolId, threshold) {} catch {
            return;
        }

        vm.prank(CREATOR);
        try pool.executePool(poolId, false) {} catch {
            return;
        }

        // Properties:
        //   - PVT burned exactly fee.
        //   - Target received exactly net.
        //   - feeWallet untouched in PVT and in USDC.
        assert(pvt.totalBurned() == burnedBefore + expectedFee);
        assert(pvt.balanceOf(TARGET) == targetPVTBefore + expectedNet);
        assert(pvt.balanceOf(FEE_WALLET) == feeWalletPVTBefore);
        assert(usdc.balanceOf(FEE_WALLET) == feeWalletUSDCBefore);
    }
}
