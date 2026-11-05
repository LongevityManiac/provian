// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {ProvianPVT9} from "../src/ProvianPVT9.sol";
import {ProvianPVT9EligibilityVerifier} from "../src/ProvianPVT9EligibilityVerifier.sol";
import {ProvianBondPool} from "../src/ProvianBondPool.sol";
import {ProvianCourtV2} from "../src/ProvianCourtV2.sol";
import {ProvianEscrowV4} from "../src/ProvianEscrowV4.sol";

/// Surfaces of the DEPLOYED set, declared here so the RED side runs the bytecode
/// that is live on Base, never this repo's edited source.
interface IOldPVT {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

interface IOldBondPool {
    function bonds(address) external view returns (uint256, uint8, uint256, uint256, uint256, uint8, uint256);
    function claims(bytes32) external view returns (address, address, uint256, uint8, uint256);
    function fileClaim(address agent, bytes32 claimId) external;
    function expireStaleClaim(bytes32 claimId) external;
    function processAbandonment(address agent) external;
    function postBond(uint8 autonomyLevel, uint256 trustDiscountBps) external;
    function withdrawBond() external;
    function renewalGracePeriod() external view returns (uint256);
    function abandonmentPeriod() external view returns (uint256);
}

interface IOldCourt {
    function assignBondClaimPanel(bytes32 claimId, address[3] calldata arbs) external;
    function postBondClaimCollateral(bytes32 claimId) external;
    function castBondClaimVote(bytes32 claimId, uint8 verdict) external;
    function finalizeBondClaim(bytes32 claimId) external;
    function settleArbitratorCollateral(uint8 family, bytes32 id, uint8 seat) external;
    function assignPanel(bytes32 escrowId, address[3] calldata arbs) external;
    function postEscrowCollateral(bytes32 escrowId) external;
    function castVote(bytes32 escrowId, bool releaseToRecipient) external;
    function escalateDispute(bytes32 escrowId) external;
    function getBondVotingDeadline(bytes32 claimId) external view returns (uint256);
    function getVotingDeadline(bytes32 escrowId) external view returns (uint256);
    function arbitratorCollateral() external view returns (uint256);
}

interface IOldEscrow {
    function createEscrow(bytes32, address, uint256, uint256, uint8) external;
    function fundEscrow(bytes32, bool) external;
    function disputeEscrow(bytes32) external;
    function delegateToCourt(bytes32) external;
    function resolveDispute(bytes32, bool) external;
}

interface IERC20Min {
    function approve(address, uint256) external returns (bool);
}

/**
 * RED controls for the three institution fixes on a Base MAINNET FORK.
 *
 * Each scenario runs twice on the same fork:
 * - against the DEPLOYED institutions (0x007CeCa7 Court, 0xC7D699da BondPool,
 * 0xc7380927 EscrowV4, bound to kernel 0x4Bf02d5C), which must FAIL the invariant;
 * - against a successor set deployed on the fork from this repo's source, bound to a
 * successor kernel, which must PASS it.
 * The successor pool is constructed exactly as the migration will construct it: the
 * live x402-test-agent bond carried as a seed, read off the deployed pool at fork time.
 *
 * forge test --root contracts --match-contract SuccessorMigrationFork -vv
 */
contract SuccessorMigrationForkTest is Test {
    address internal constant ADMIN = 0xCa37a15A64213b2ACD1784ae3f8e6Cbd4600D9D3;
    address internal constant FEE_WALLET = 0x086e0F377af1245B8888540f39e99A42a7daF1dA;
    address internal constant FOUNDATION = 0x94F3D06ca027dFD1e6cCaa1117b050E08D5EA936;
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    address internal constant OLD_KERNEL = 0x4Bf02d5C9bC4306c38603EF2aA164f2f2273bcd7;
    address internal constant OLD_ESCROW = 0xc738092785698DCfB28af5a016e69c7AD2b97164;
    address internal constant OLD_BOND = 0xC7D699da369f261672cb1A1F765F32dEa26F4676;
    address internal constant OLD_COURT = 0x007CeCa70086EDC96a0E8CfC9f4340CAEf35a580;
    /// The live bonded agent (x402-test-agent).
    address internal constant BONDED = 0x5E645329ea23a84d6FB6006376f0B2b5E3B575F5;

    uint8 internal constant CASE_ESCROW = 1;
    uint8 internal constant CASE_BOND = 2;
    uint8 internal constant SLASH_FULL = 3;

    ProvianPVT9 internal kernel;
    ProvianBondPool internal bond;
    ProvianCourtV2 internal court;
    ProvianEscrowV4 internal escrow;

    address internal claimant = makeAddr("claimant");
    address internal arb1 = makeAddr("arb1");
    address internal arb2 = makeAddr("arb2");
    address internal arb3 = makeAddr("arb3");
    address internal depositor = makeAddr("depositor");
    address internal recipient = makeAddr("recipient");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        // The set as deployed, one block before the retirement (hold tx at 51,823,789):
        // the RED controls run against the contracts exactly as they served, not as held.
        vm.createSelectFork(
            vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")),
            vm.envOr("SUCCESSOR_MIGRATION_FORK_BLOCK", uint256(51_823_788))
        );
        require(OLD_BOND.code.length > 0 && OLD_COURT.code.length > 0, "fork: deployed set missing");
        _deploySuccessor();
    }

    // ------------------------------------------------------------------
    // successor set, deployed on the fork exactly as the migration deploys it
    // ------------------------------------------------------------------

    function _deploySuccessor() internal {
        kernel = new ProvianPVT9();
        ProvianPVT9EligibilityVerifier verifier = new ProvianPVT9EligibilityVerifier(
            kernel, 0xe0ee2de78a611198a17183b8505ed321902ba64b6577e2f1cb04a24e37cf23cb, 1
        );
        vm.startPrank(ADMIN);
        kernel.appointOperationalMinter(0xF0Ea014CAa37C34aF5D0a7F646ad7d7A79C09dF7);
        kernel.armEpochZero(
            ProvianPVT9.EpochZeroConfig({
                epochZeroStartsAt: uint64(block.timestamp + 1 hours),
                genesisStartsAt: 1785715200,
                genesisEndsAt: 1798761600,
                initialMintRate: 1 ether,
                provianTreasury: FEE_WALLET,
                foundationTreasury: FOUNDATION,
                eligibilityVerifier: ProvianPVT9.VerifierConfig({
                    verifier: address(verifier),
                    configurationId: 0xe0ee2de78a611198a17183b8505ed321902ba64b6577e2f1cb04a24e37cf23cb,
                    version: 1
                }),
                initialFinalizedCursor: 0,
                combinedCapMode: ProvianPVT9.CombinedCapMode.Fixed,
                genesisCap: type(uint256).max,
                fixedCombinedCap: type(uint256).max
            })
        );
        vm.stopPrank();

        (uint256 amt, uint8 lvl, uint256 created, uint256 renewed, uint256 deadline,,) = IOldBondPool(OLD_BOND).bonds(BONDED);
        ProvianBondPool.BondSeed[] memory seeds = new ProvianBondPool.BondSeed[](1);
        seeds[0] = ProvianBondPool.BondSeed({
            agent: BONDED,
            amount: amt,
            autonomyLevel: lvl,
            createdAt: created,
            lastRenewalAt: renewed,
            renewalDeadline: deadline,
            requiredAtPost: ProvianBondPool(OLD_BOND).requiredAtPost(BONDED)
        });
        ProvianBondPool.BpsSeed[] memory bps = new ProvianBondPool.BpsSeed[](2);
        bps[0] = ProvianBondPool.BpsSeed({param: 1, bps: 0});
        bps[1] = ProvianBondPool.BpsSeed({param: 3, bps: 0});

        escrow = new ProvianEscrowV4(
            ADMIN, FEE_WALLET, USDC, address(kernel), address(kernel), address(kernel), new ProvianEscrowV4.EscrowSeed[](0)
        );
        bond = new ProvianBondPool(ADMIN, FEE_WALLET, address(kernel), address(kernel), address(kernel), seeds, bps);
        court = new ProvianCourtV2(ADMIN, address(escrow), address(kernel), address(kernel), address(kernel));
        vm.startPrank(ADMIN);
        escrow.setCourtContract(address(court));
        court.setBondPool(address(bond));
        bond.setCourtContract(address(court));
        bond.setExecutor(ADMIN);
        vm.stopPrank();
        // The migration distribution backs the carried bond 1:1.
        deal(address(kernel), address(bond), amt, true);
    }

    function _panel() internal view returns (address[3] memory) {
        return [arb1, arb2, arb3];
    }

    function _fundOld(address who, uint256 amount, address spender) internal {
        deal(OLD_KERNEL, who, IOldPVT(OLD_KERNEL).balanceOf(who) + amount);
        vm.prank(who);
        IOldPVT(OLD_KERNEL).approve(spender, type(uint256).max);
    }

    function _fundNew(address who, uint256 amount, address spender) internal {
        // adjust=true: the fresh kernel's totalSupply must cover later burns.
        deal(address(kernel), who, kernel.balanceOf(who) + amount, true);
        vm.prank(who);
        kernel.approve(spender, type(uint256).max);
    }

    // ==================================================================
    // Fix 1 — a claim expiring under a live Court panel
    // ==================================================================

    function test_RED_fix1_deployedSet_expiryUnderLivePanel_escapesSlash_locksCollateral() public {
        bytes32 claimId = keccak256("d486-red-fix1-old");
        _fundOld(claimant, 15e18, OLD_BOND);
        vm.prank(claimant);
        IOldBondPool(OLD_BOND).fileClaim(BONDED, claimId);
        (,,,, uint256 filedAt) = IOldBondPool(OLD_BOND).claims(claimId);

        vm.warp(filedAt + 59 days);
        vm.prank(ADMIN);
        IOldCourt(OLD_COURT).assignBondClaimPanel(claimId, _panel());
        uint256 stake = IOldCourt(OLD_COURT).arbitratorCollateral();
        address[3] memory p = _panel();
        for (uint256 i = 0; i < 3; i++) {
            _fundOld(p[i], stake, OLD_COURT);
            vm.prank(p[i]);
            IOldCourt(OLD_COURT).postBondClaimCollateral(claimId);
        }
        vm.warp(filedAt + 60 days + 1);
        assertLt(block.timestamp, IOldCourt(OLD_COURT).getBondVotingDeadline(claimId), "panel still voting");

        (uint256 bondBefore,,,,,,) = IOldBondPool(OLD_BOND).bonds(BONDED);
        // THE DEFECT: the deployed pool lets anyone expire the claim under the live panel.
        vm.prank(BONDED);
        IOldBondPool(OLD_BOND).expireStaleClaim(claimId);

        // The panel's slash majority can no longer land.
        vm.prank(arb1);
        IOldCourt(OLD_COURT).castBondClaimVote(claimId, SLASH_FULL);
        vm.prank(arb2);
        vm.expectRevert();
        IOldCourt(OLD_COURT).castBondClaimVote(claimId, SLASH_FULL);
        (uint256 bondAfter,,,,,,) = IOldBondPool(OLD_BOND).bonds(BONDED);
        assertEq(bondAfter, bondBefore, "RED: the agent avoided the slash");

        // And after the deadline the case can never turn terminal: collateral is locked.
        vm.warp(IOldCourt(OLD_COURT).getBondVotingDeadline(claimId) + 1);
        vm.expectRevert();
        IOldCourt(OLD_COURT).finalizeBondClaim(claimId);
        for (uint8 i = 0; i < 3; i++) {
            vm.expectRevert(); // CaseNotTerminal
            IOldCourt(OLD_COURT).settleArbitratorCollateral(CASE_BOND, claimId, i);
        }
    }

    function test_GREEN_fix1_successor_expiryRefused_slashLands_collateralReturns() public {
        bytes32 claimId = keccak256("d486-green-fix1");
        _fundNew(claimant, 15e18, address(bond));
        vm.prank(claimant);
        bond.fileClaim(BONDED, claimId);
        (,,,, uint256 filedAt) = bond.claims(claimId);

        vm.warp(filedAt + 59 days);
        vm.prank(ADMIN);
        court.assignBondClaimPanel(claimId, _panel());
        uint256 stake = court.arbitratorCollateral();
        address[3] memory p = _panel();
        for (uint256 i = 0; i < 3; i++) {
            _fundNew(p[i], stake, address(court));
            vm.prank(p[i]);
            court.postBondClaimCollateral(claimId);
        }
        vm.warp(filedAt + 60 days + 1);

        vm.prank(BONDED);
        vm.expectRevert(ProvianBondPool.ClaimUnderAdjudication.selector);
        bond.expireStaleClaim(claimId);

        vm.prank(arb1);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.SlashFull);
        vm.prank(arb2);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.SlashFull);
        (uint256 bondAfter,,,,,,) = bond.bonds(BONDED);
        assertEq(bondAfter, 0, "GREEN: the slash landed");

        for (uint8 i = 0; i < 3; i++) {
            uint256 b = kernel.balanceOf(p[i]);
            court.settleArbitratorCollateral(CASE_BOND, claimId, i);
            assertGe(kernel.balanceOf(p[i]), b + stake, "GREEN: collateral returned");
        }
    }

    // ==================================================================
    // Fix 2 — an escrow settled outside the Court
    // ==================================================================

    function _oldDisputedEscrowWithPanel(bytes32 id) internal {
        deal(USDC, depositor, 1_000e6);
        vm.prank(depositor);
        IERC20Min(USDC).approve(OLD_ESCROW, type(uint256).max);
        vm.prank(depositor);
        IOldEscrow(OLD_ESCROW).createEscrow(id, recipient, 1_000e6, block.timestamp + 100 days, 0);
        vm.prank(depositor);
        IOldEscrow(OLD_ESCROW).fundEscrow(id, false);
        vm.prank(depositor);
        IOldEscrow(OLD_ESCROW).disputeEscrow(id);
        _fundOld(recipient, 1_000e18, OLD_ESCROW);
        vm.prank(recipient);
        IOldEscrow(OLD_ESCROW).delegateToCourt(id);
        vm.prank(ADMIN);
        IOldCourt(OLD_COURT).assignPanel(id, _panel());
        uint256 stake = IOldCourt(OLD_COURT).arbitratorCollateral();
        address[3] memory p = _panel();
        for (uint256 i = 0; i < 3; i++) {
            _fundOld(p[i], stake, OLD_COURT);
            vm.prank(p[i]);
            IOldCourt(OLD_COURT).postEscrowCollateral(id);
        }
    }

    function test_RED_fix2_deployedSet_settledOutsideCourt_panelLosesCollateral() public {
        bytes32 id = keccak256("d486-red-fix2-old");
        _oldDisputedEscrowWithPanel(id);
        uint256 stake = IOldCourt(OLD_COURT).arbitratorCollateral();

        // The escrow settles outside the Court (admin resolution).
        vm.prank(ADMIN);
        IOldEscrow(OLD_ESCROW).resolveDispute(id, false);

        // Locked: the case never turns terminal on its own.
        for (uint8 i = 0; i < 3; i++) {
            vm.expectRevert(); // CaseNotTerminal
            IOldCourt(OLD_COURT).settleArbitratorCollateral(CASE_ESCROW, id, i);
        }
        // The panel cannot vote its way out: a majority reverts inside the escrow.
        vm.prank(arb1);
        IOldCourt(OLD_COURT).castVote(id, true);
        vm.prank(arb2);
        vm.expectRevert();
        IOldCourt(OLD_COURT).castVote(id, true);
        // The only exit is escalation past the deadline, which burns every seat that
        // could not land its vote.
        vm.warp(IOldCourt(OLD_COURT).getVotingDeadline(id) + 1);
        IOldCourt(OLD_COURT).escalateDispute(id);
        address[3] memory p = _panel();
        uint256 lost;
        for (uint8 i = 0; i < 3; i++) {
            uint256 b = IOldPVT(OLD_KERNEL).balanceOf(p[i]);
            IOldCourt(OLD_COURT).settleArbitratorCollateral(CASE_ESCROW, id, i);
            if (IOldPVT(OLD_KERNEL).balanceOf(p[i]) < b + stake) lost++;
        }
        assertEq(lost, 2, "RED: two arbitrators lose their collateral");
    }

    function test_GREEN_fix2_successor_settledOutsideCourt_panelKeepsCollateral() public {
        bytes32 id = keccak256("d486-green-fix2");
        deal(USDC, depositor, 1_000e6);
        vm.prank(depositor);
        IERC20Min(USDC).approve(address(escrow), type(uint256).max);
        vm.prank(depositor);
        escrow.createEscrow(id, recipient, 1_000e6, block.timestamp + 100 days, ProvianEscrowV4.Currency.USDC);
        vm.prank(depositor);
        escrow.fundEscrow(id, false);
        vm.prank(depositor);
        escrow.disputeEscrow(id);
        _fundNew(recipient, 1_000e18, address(escrow));
        vm.prank(recipient);
        escrow.delegateToCourt(id);
        vm.prank(ADMIN);
        court.assignPanel(id, _panel());
        uint256 stake = court.arbitratorCollateral();
        address[3] memory p = _panel();
        for (uint256 i = 0; i < 3; i++) {
            _fundNew(p[i], stake, address(court));
            vm.prank(p[i]);
            court.postEscrowCollateral(id);
        }
        vm.prank(arb1);
        court.castVote(id, true);

        vm.prank(ADMIN);
        escrow.resolveDispute(id, false);

        for (uint8 i = 0; i < 3; i++) {
            uint256 b = kernel.balanceOf(p[i]);
            court.settleArbitratorCollateral(CASE_ESCROW, id, i);
            assertGe(kernel.balanceOf(p[i]), b + stake, "GREEN: every seat keeps its collateral");
        }
    }

    // ==================================================================
    // Fix 3 — abandonment over a pending claim
    // ==================================================================

    function test_RED_fix3_deployedSet_abandonmentStrandsClaim_nextBondMiscounted() public {
        (,,,, uint256 deadline,,) = IOldBondPool(OLD_BOND).bonds(BONDED);
        uint256 horizon =
            deadline + IOldBondPool(OLD_BOND).renewalGracePeriod() + IOldBondPool(OLD_BOND).abandonmentPeriod();

        vm.warp(horizon - 1 days);
        bytes32 stale = keccak256("d486-red-fix3-stale");
        _fundOld(claimant, 30e18, OLD_BOND);
        vm.prank(claimant);
        IOldBondPool(OLD_BOND).fileClaim(BONDED, stale);

        vm.warp(horizon);
        IOldBondPool(OLD_BOND).processAbandonment(BONDED); // THE DEFECT: allowed over a pending claim
        (,,,,,, uint256 left) = IOldBondPool(OLD_BOND).bonds(BONDED);
        assertEq(left, 1, "abandoned with a claim still pending");

        _fundOld(BONDED, 800e18, OLD_BOND);
        vm.prank(BONDED);
        IOldBondPool(OLD_BOND).postBond(2, 0);
        (,,,,,, uint256 reset) = IOldBondPool(OLD_BOND).bonds(BONDED);
        assertEq(reset, 0, "RED: new bond reads 0 while a claim is still pending against the agent");

        bytes32 fresh = keccak256("d486-red-fix3-fresh");
        vm.prank(claimant);
        IOldBondPool(OLD_BOND).fileClaim(BONDED, fresh);
        vm.warp(horizon - 1 days + 60 days);
        IOldBondPool(OLD_BOND).expireStaleClaim(stale); // decrements the NEW bond's count
        (,,,,,, uint256 wrong) = IOldBondPool(OLD_BOND).bonds(BONDED);
        assertEq(wrong, 0, "RED: the fresh claim is pending but the count is 0");
        vm.prank(BONDED);
        IOldBondPool(OLD_BOND).withdrawBond(); // escapes the fresh claim entirely
    }

    function test_GREEN_fix3_successor_abandonmentWaits_countStaysTrue() public {
        (,,,, uint256 deadline,,) = bond.bonds(BONDED);
        uint256 horizon = deadline + bond.renewalGracePeriod() + bond.abandonmentPeriod();

        vm.warp(horizon - 1 days);
        bytes32 stale = keccak256("d486-green-fix3-stale");
        _fundNew(claimant, 30e18, address(bond));
        vm.prank(claimant);
        bond.fileClaim(BONDED, stale);

        vm.warp(horizon);
        vm.expectRevert(ProvianBondPool.ClaimsPending.selector);
        bond.processAbandonment(BONDED);

        vm.warp(horizon - 1 days + 60 days);
        bond.expireStaleClaim(stale);
        bond.processAbandonment(BONDED);
        (,,,,,, uint256 zero) = bond.bonds(BONDED);
        assertEq(zero, 0);

        _fundNew(BONDED, 800e18, address(bond));
        vm.prank(BONDED);
        bond.postBond(2, 0);
        bytes32 fresh = keccak256("d486-green-fix3-fresh");
        vm.prank(claimant);
        bond.fileClaim(BONDED, fresh);
        (,,,,,, uint256 one) = bond.bonds(BONDED);
        assertEq(one, 1, "GREEN: exactly the one pending claim");
        vm.prank(BONDED);
        vm.expectRevert(ProvianBondPool.ClaimsPending.selector);
        bond.withdrawBond();
    }
}
