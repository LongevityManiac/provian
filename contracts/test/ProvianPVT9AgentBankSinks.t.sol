// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Test.sol";
import {ProvianPVT9TestBase} from "./ProvianPVT9TestBase.sol";
import {ProvianPVT9} from "../src/ProvianPVT9.sol";
import {ProvianEscrowV4} from "../src/ProvianEscrowV4.sol";
import "./MockEpochClock.sol";
import "./MockIssuanceIndex.sol";
import {ProvianPromiseV3} from "../src/ProvianPromiseV3.sol";
import {ProvianPoolV3} from "../src/ProvianPoolV3.sol";
import {ProvianBondPool} from "../src/ProvianBondPool.sol";
import {MockUSDC} from "./MockTokens.sol";

/**
 * @title ProvianPVT9AgentBankSinksTest
 * @notice The permanent real-`ProvianPVT9` integration test for the four Agent
 * Bank fee-burn sinks (Escrow / Promise / Pool / Bond).
 *
 * WHY THIS EXISTS. The fee-burn port swapped every sink from the legacy
 * gated `protocolBurn(uint256)` to PVT9's ungated self-burn
 * `burn(uint256)`. The merged sink suites exercise that swap only
 * against `MockPVT` / `MockBlacklistPVT`, which makes the MOCK the sole
 * on-chain arbiter of the port's correctness: if the mock's `burn`
 * ever drifts from `ProvianPVT9._burn`, those suites stay green while
 * real behavior diverges. This suite closes that gap by wiring all four
 * sinks to the REAL token and asserting against it.
 *
 * WHAT IT ASSERTS — the four institution parameters acceptance criteria, value-neutrally:
 * - VALUE CONSERVATION: the fee leaves `totalSupply` exactly, is
 * debited from the sink's own balance exactly, and no PVT is
 * created anywhere. A whole-system ledger identity
 * (sum of every tracked balance == `totalSupply`) is re-checked
 * after every operation.
 * - SELF-ONLY DEBIT: exactly one `Burned` event per operation, whose
 * holder is the sink itself — never a user, never a third party.
 * - NO CROSS-ASSET DERIVATION: the PVT-principal paths are
 * conversion-free. institution deployment REMOVED `pvtUsdcRate` outright, and
 * the actors are deliberately FUNDED with USDC and approved to the
 * sinks so that a cross-asset pull would succeed — then asserted
 * not to have happened, at both the sink and the actor end.
 * - FAIL-CLOSED: the real token reverts `InsufficientBalance` on an
 * over-burn rather than silently under-burning.
 *
 * WHAT IT DELIBERATELY DOES NOT ASSERT: any specific fee amount, rate,
 * or cap. Every expected value is READ from the emitted `Burned` event
 * or from the sink's own public parameters — never chosen here. The
 * PVT-native cost catalog is proposal-only and unapproved
 * (`proposed-pvt-cost-catalog.ts`, all 81 rows
 * `requires_frank_approval`), so pinning a number here would assert an
 * economic value nobody approved. Conservation holds for ANY fee, which
 * is exactly the property that is safe to pin today.
 */
contract ProvianPVT9AgentBankSinksTest is ProvianPVT9TestBase {
    ProvianEscrowV4 internal escrow;
    ProvianPromiseV3 internal promiseContract;
    ProvianPoolV3 internal pool;
    ProvianBondPool internal bondPool;
    MockUSDC internal usdc;

    address internal constant BANK_ADMIN = address(0xB0A1);
    address internal constant FEE_WALLET = address(0xFEE);
    address internal constant TECH_WALLET = address(0x7EC4);
    address internal constant FUNDER = address(0xF00D);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant CAROL = address(0xCA401);

    /// keccak256("Burned(address,uint256)") — PVT9's self-burn event.
    bytes32 internal constant BURNED_TOPIC = keccak256("Burned(address,uint256)");

    /// USDC funded to each actor purely so the no-cross-asset check can fail.
    uint256 internal constant USDC_STAKE = 100_000e6;

    function setUp() public override {
        super.setUp(); // deploys + arms the REAL ProvianPVT9, warps to epoch zero

        usdc = new MockUSDC();
        escrow = new ProvianEscrowV4(BANK_ADMIN, FEE_WALLET, address(usdc), address(pvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), new ProvianEscrowV4.EscrowSeed[](0));
        promiseContract = new ProvianPromiseV3(BANK_ADMIN, FEE_WALLET, address(usdc), address(pvt), address(new MockEpochClock(0)));
        pool = new ProvianPoolV3(BANK_ADMIN, FEE_WALLET, address(usdc), address(pvt), address(new MockEpochClock(0)));
        bondPool = new ProvianBondPool(BANK_ADMIN, TECH_WALLET, address(pvt), address(new MockEpochClock(0)), address(new MockIssuanceIndex()), new ProvianBondPool.BondSeed[](0), new ProvianBondPool.BpsSeed[](0));

        // Mint real PVT the only way PVT9 allows: settle a standard PE batch.
        // There is no test-only mint hook on the real token, and adding one
        // would be a PVT9 edit.
        _settleStandard(FUNDER, ProvianPVT9.BeneficiaryClass.HumanResolving, 1_000_000 ether);

        uint256 stake = 50_000 ether;
        vm.startPrank(FUNDER);
        pvt.transfer(ALICE, stake);
        pvt.transfer(BOB, stake);
        pvt.transfer(CAROL, stake);
        vm.stopPrank();

        // Max-approve every sink from every actor so the flows below are about
        // burning, not allowance plumbing.
        //
        // USDC is funded and approved to the same ceiling ON PURPOSE. Every
        // exercised path is PVT-principal and must never touch USDC — but an
        // unfunded, unapproved USDC actor makes that assertion unfalsifiable,
        // since no code path COULD move USDC. Funding + approving arms the
        // no-cross-asset-derivation check so a sink that erroneously pulled
        // USDC would actually succeed at it, and be caught.
        address[3] memory actors = [ALICE, BOB, CAROL];
        address[4] memory sinks = [address(escrow), address(promiseContract), address(pool), address(bondPool)];
        for (uint256 i = 0; i < actors.length; i++) {
            usdc.mint(actors[i], USDC_STAKE);
            for (uint256 j = 0; j < sinks.length; j++) {
                vm.prank(actors[i]);
                pvt.approve(sinks[j], type(uint256).max);
                vm.prank(actors[i]);
                usdc.approve(sinks[j], type(uint256).max);
            }
        }

        _assertLedgerIntact();
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    /**
     * @dev Whole-system value conservation on the REAL token: every PVT ever
     *      minted is either still held by someone or was burned. If a sink ever
     *      created PVT, moved it somewhere untracked, or burned without
     *      reducing supply, this identity breaks.
     */
    function _assertLedgerIntact() internal view {
        uint256 held = pvt.balanceOf(FUNDER) + pvt.balanceOf(ALICE) + pvt.balanceOf(BOB) + pvt.balanceOf(CAROL)
            + pvt.balanceOf(PROVIAN_TREASURY) + pvt.balanceOf(FOUNDATION_TREASURY) + pvt.balanceOf(FEE_WALLET)
            + pvt.balanceOf(TECH_WALLET) + pvt.balanceOf(address(escrow)) + pvt.balanceOf(address(promiseContract))
            + pvt.balanceOf(address(pool)) + pvt.balanceOf(address(bondPool));
        assertEq(held, pvt.totalSupply(), "ledger: held != totalSupply");
    }

    /**
     * @dev Extracts the single PVT9 `Burned` event from the recorded logs and
     *      asserts it was a SELF-burn by `expectedHolder`. Returns the burned
     *      amount, so callers never have to name a fee value.
     */
    function _singleSelfBurn(Vm.Log[] memory logs, address expectedHolder) internal view returns (uint256 amount) {
        uint256 found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(pvt) || logs[i].topics[0] != BURNED_TOPIC) continue;
            found++;
            assertEq(address(uint160(uint256(logs[i].topics[1]))), expectedHolder, "burn holder is not the sink");
            amount = abi.decode(logs[i].data, (uint256));
        }
        assertEq(found, 1, "expected exactly one self-burn");
        assertGt(amount, 0, "fee burn was a no-op");
    }

    /**
     * @dev No PVT-principal path may touch USDC — the conversion-free property.
     *      Checks BOTH ends: no sink or fee wallet accumulated USDC, and every
     *      funded actor still holds its full USDC stake. The second half is
     *      what makes this falsifiable: the actors are funded and have approved
     *      the sinks, so a cross-asset pull would succeed and show up here.
     */
    /// @dev institution deployment: prove the PVT-fee discount is retired on all three USDC-capable
    ///      sinks by exercising the refusal, not by reading a slot that no longer
    /// exists. Its RED control is `InstitutionPreChangeSilentFallback.t.sol`,
    ///      which shows these same calls SUCCEEDING against the shipped contracts.
    function _assertPvtFeeDiscountRetired() internal {
        bytes32 eId = keccak256("wp13-sink-escrow");
        vm.prank(ALICE);
        escrow.createEscrow(eId, BOB, 1000e6, block.timestamp + 1 days, ProvianEscrowV4.Currency.USDC);
        vm.prank(ALICE);
        vm.expectRevert(ProvianEscrowV4.PVTFeeDiscountRetired.selector);
        escrow.fundEscrow(eId, true);

        bytes32 pId = keccak256("wp13-sink-promise");
        vm.prank(ALICE);
        promiseContract.createPromise(pId, 1000e6, 1100e6, block.timestamp + 30 days, ProvianPromiseV3.Currency.USDC);
        vm.prank(BOB);
        promiseContract.fundPromise(pId);
        vm.prank(ALICE);
        vm.expectRevert(ProvianPromiseV3.PVTFeeDiscountRetired.selector);
        promiseContract.settlePromise(pId, true);

        bytes32 poolId = keccak256("wp13-sink-pool");
        vm.prank(ALICE);
        pool.createPool(poolId, CAROL, 1000e6, block.timestamp + 30 days, ProvianPoolV3.Currency.USDC);
        vm.prank(BOB);
        pool.contribute(poolId, 1000e6);
        vm.prank(ALICE);
        vm.expectRevert(ProvianPoolV3.PVTFeeDiscountRetired.selector);
        pool.executePool(poolId, true);
    }

    function _assertNoUsdcMovement() internal view {
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow touched USDC");
        assertEq(usdc.balanceOf(address(promiseContract)), 0, "promise touched USDC");
        assertEq(usdc.balanceOf(address(pool)), 0, "pool touched USDC");
        assertEq(usdc.balanceOf(address(bondPool)), 0, "bond touched USDC");
        assertEq(usdc.balanceOf(FEE_WALLET), 0, "feeWallet received USDC");
        assertEq(usdc.balanceOf(ALICE), USDC_STAKE, "ALICE's USDC moved");
        assertEq(usdc.balanceOf(BOB), USDC_STAKE, "BOB's USDC moved");
        assertEq(usdc.balanceOf(CAROL), USDC_STAKE, "CAROL's USDC moved");
    }

    // ========================================================================
    // Wiring — the sinks really are bound to the real token
    // ========================================================================

    function test_allFourSinksAreWiredToRealPVT9() public {
        assertEq(address(escrow.pvt()), address(pvt), "escrow not on real PVT9");
        assertEq(address(promiseContract.pvt()), address(pvt), "promise not on real PVT9");
        assertEq(address(pool.pvt()), address(pvt), "pool not on real PVT9");
        assertEq(address(bondPool.pvt()), address(pvt), "bond not on real PVT9");

        // Conversion-free by construction: no sink has a PVT/USDC rate set.
        // institution deployment: the cross-asset rate is not merely zero any more — the storage slot,
        // its setter, and the branch that read it are GONE, so there is no rate to
        // assert about. The stronger property is proven directly: asking to pay a fee
        // in PVT is REFUSED rather than silently converted at a Provian-set price.
        _assertPvtFeeDiscountRetired();
    }

    // ========================================================================
    // Sink 1 — Escrow
    // ========================================================================

    function test_escrow_pvtPrincipal_feeBurnConservesValue() public {
        bytes32 id = keccak256("escrow-real-pvt9");
        uint256 amount = 1_000 ether;

        vm.prank(ALICE);
        escrow.createEscrow(id, BOB, amount, block.timestamp + 1 days, ProvianEscrowV4.Currency.PVT);

        uint256 supplyBefore = pvt.totalSupply();
        uint256 aliceBefore = pvt.balanceOf(ALICE);

        vm.recordLogs();
        vm.prank(ALICE);
        escrow.fundEscrow(id, false);
        uint256 burned = _singleSelfBurn(vm.getRecordedLogs(), address(escrow));

        // The fee left the real token's supply, exactly.
        assertEq(pvt.totalSupply(), supplyBefore - burned, "supply drop != burned");
        // The depositor paid principal; the sink holds principal minus the fee.
        assertEq(pvt.balanceOf(ALICE), aliceBefore - amount, "depositor debited wrong amount");
        assertEq(pvt.balanceOf(address(escrow)), amount - burned, "sink holds wrong net");
        assertEq(pvt.balanceOf(FEE_WALLET), 0, "PVT leaked to feeWallet");
        _assertLedgerIntact();

        // Release moves the whole net principal out; nothing sticks to the sink.
        vm.prank(ALICE);
        escrow.releaseEscrow(id);
        assertEq(pvt.balanceOf(BOB), 50_000 ether + amount - burned, "recipient net wrong");
        assertEq(pvt.balanceOf(address(escrow)), 0, "sink retained dust");
        assertEq(pvt.balanceOf(FEE_WALLET), 0, "PVT leaked to feeWallet on release");
        _assertLedgerIntact();
        _assertNoUsdcMovement();
    }

    // ========================================================================
    // Sink 2 — Promise
    // ========================================================================

    function test_promise_pvtPrincipal_feeBurnConservesValue() public {
        bytes32 id = keccak256("promise-real-pvt9");
        uint256 principal = 1_000 ether;
        uint256 repay = 1_100 ether;

        vm.prank(ALICE); // borrower
        promiseContract.createPromise(id, principal, repay, block.timestamp + 7 days, ProvianPromiseV3.Currency.PVT);
        vm.prank(BOB); // lender
        promiseContract.fundPromise(id);

        uint256 supplyBefore = pvt.totalSupply();
        uint256 lenderBefore = pvt.balanceOf(BOB);
        uint256 borrowerBefore = pvt.balanceOf(ALICE);

        vm.recordLogs();
        vm.prank(ALICE);
        promiseContract.settlePromise(id, false);
        uint256 burned = _singleSelfBurn(vm.getRecordedLogs(), address(promiseContract));

        assertEq(pvt.totalSupply(), supplyBefore - burned, "supply drop != burned");
        // Borrower pays the full repay; lender receives it net of the burned fee.
        assertEq(pvt.balanceOf(ALICE), borrowerBefore - repay, "borrower debited wrong amount");
        assertEq(pvt.balanceOf(BOB), lenderBefore + repay - burned, "lender credited wrong amount");
        assertEq(pvt.balanceOf(address(promiseContract)), 0, "sink retained dust");
        assertEq(pvt.balanceOf(FEE_WALLET), 0, "PVT leaked to feeWallet");
        _assertLedgerIntact();
        _assertNoUsdcMovement();
    }

    // ========================================================================
    // Sink 3 — Pool
    // ========================================================================

    function test_pool_pvtPrincipal_feeBurnConservesValue() public {
        bytes32 id = keccak256("pool-real-pvt9");
        uint256 threshold = 1_000 ether;

        vm.prank(ALICE); // creator
        pool.createPool(id, CAROL, threshold, block.timestamp + 7 days, ProvianPoolV3.Currency.PVT);
        vm.prank(BOB); // contributor
        pool.contribute(id, threshold);

        uint256 supplyBefore = pvt.totalSupply();
        uint256 targetBefore = pvt.balanceOf(CAROL);

        vm.recordLogs();
        vm.prank(ALICE);
        pool.executePool(id, false);
        uint256 burned = _singleSelfBurn(vm.getRecordedLogs(), address(pool));

        assertEq(pvt.totalSupply(), supplyBefore - burned, "supply drop != burned");
        assertEq(pvt.balanceOf(CAROL), targetBefore + threshold - burned, "target credited wrong amount");
        assertEq(pvt.balanceOf(address(pool)), 0, "sink retained dust");
        assertEq(pvt.balanceOf(FEE_WALLET), 0, "PVT leaked to feeWallet");
        _assertLedgerIntact();
        _assertNoUsdcMovement();
    }

    // ========================================================================
    // Sink 4 — Bond
    // ========================================================================

    function test_bond_postBond_feeBurnConservesValue() public {
        uint256 required = bondPool.getRequiredBond(2, 0);
        uint256 remainingBps = bondPool.MAX_BPS() - bondPool.depositBurnBps() - bondPool.depositFeeBps();
        uint256 totalDeposit = (required * bondPool.MAX_BPS() + remainingBps - 1) / remainingBps;

        uint256 supplyBefore = pvt.totalSupply();
        uint256 agentBefore = pvt.balanceOf(ALICE);
        uint256 techBefore = pvt.balanceOf(TECH_WALLET);

        vm.recordLogs();
        vm.prank(ALICE);
        bondPool.postBond(2, 0);
        uint256 burned = _singleSelfBurn(vm.getRecordedLogs(), address(bondPool));

        assertEq(pvt.totalSupply(), supplyBefore - burned, "supply drop != burned");
        assertEq(pvt.balanceOf(ALICE), agentBefore - totalDeposit, "agent debited wrong amount");

        // Deposit splits three ways with nothing unaccounted for: burned +
        // infrastructure fee + locked collateral == total deposit.
        uint256 techFee = pvt.balanceOf(TECH_WALLET) - techBefore;
        uint256 locked = pvt.balanceOf(address(bondPool));
        assertEq(burned + techFee + locked, totalDeposit, "deposit split does not conserve");
        assertGt(techFee, 0, "infrastructure fee was a no-op");

        // Collateral is never SHORT, and the excess is bounded rounding dust.
        //
        // `postBond` CEILINGS the gross deposit while the burn and fee splits
        // FLOOR, so the locked remainder absorbs three independent residuals:
        //     locked - required == 0.97·g + f1 + f2
        // where g (< 1) is the ceiling slack on totalDeposit and f1, f2 (< 1
        // each) are the floor residuals on the burn and fee. The sum is
        // strictly under 2.97, so the integer excess is at most 2 — NOT 1. A
        // bound of 1 happens to hold for the current bond ladder but goes
        // falsely red on an in-domain retune (e.g. level-2 base bond 2250e18,
        // reachable via `updateBaseBonds`, lands on 2).
        //
        // The `>=` half is the security-relevant one — under-collateralization
        // was a prior audit finding — and the tight upper bound keeps a real
        // over-lock from hiding behind a bare `>=`.
        assertGe(locked, required, "bond under-collateralized");
        assertLe(locked - required, 2, "locked collateral exceeds required by more than rounding dust");
        assertEq(pvt.balanceOf(FEE_WALLET), 0, "PVT leaked to feeWallet");
        _assertLedgerIntact();
        _assertNoUsdcMovement();
    }

    // ========================================================================
    // Fail-closed — the real token, not the mock, is the arbiter
    // ========================================================================

    function test_realPVT9_failsClosedOnOverBurn() public {
        uint256 held = pvt.balanceOf(ALICE);
        vm.prank(ALICE);
        vm.expectRevert(ProvianPVT9.InsufficientBalance.selector);
        pvt.burn(held + 1);

        // The failed burn changed nothing.
        assertEq(pvt.balanceOf(ALICE), held, "balance moved on a reverted burn");
        _assertLedgerIntact();
    }

    function test_realPVT9_burnIsSelfOnly() public {
        // `burn` debits msg.sender and nobody else: BOB burning cannot reach
        // ALICE's balance. This is the property that makes the sinks' ungated
        // self-burn safe without a protocol-contract registry.
        uint256 aliceBefore = pvt.balanceOf(ALICE);
        uint256 bobBefore = pvt.balanceOf(BOB);
        uint256 supplyBefore = pvt.totalSupply();

        vm.prank(BOB);
        pvt.burn(1 ether);

        assertEq(pvt.balanceOf(ALICE), aliceBefore, "third-party balance moved");
        assertEq(pvt.balanceOf(BOB), bobBefore - 1 ether, "burner not debited");
        assertEq(pvt.totalSupply(), supplyBefore - 1 ether, "supply not reduced");
        _assertLedgerIntact();
    }

    function test_sinksHoldNoPrivilegedPVT9Authority() public {
        // PVT9 grants institutions no entrypoint. A sink is an ordinary holder:
        // it cannot mint, and it cannot burn what it does not hold.
        assertEq(pvt.balanceOf(address(escrow)), 0, "precondition: sink should be empty");
        vm.prank(address(escrow));
        vm.expectRevert(ProvianPVT9.InsufficientBalance.selector);
        pvt.burn(1);

        // ...and it is not the operational minter.
        assertTrue(pvt.operationalMinter() != address(escrow), "sink holds minter role");
        assertTrue(pvt.operationalMinter() != address(promiseContract), "sink holds minter role");
        assertTrue(pvt.operationalMinter() != address(pool), "sink holds minter role");
        assertTrue(pvt.operationalMinter() != address(bondPool), "sink holds minter role");
    }
}
