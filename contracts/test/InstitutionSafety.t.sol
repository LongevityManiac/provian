// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {ProvianBondPool} from "../src/ProvianBondPool.sol";
import {ProvianCourtV2} from "../src/ProvianCourtV2.sol";
import {ProvianEscrowV4} from "../src/ProvianEscrowV4.sol";
import {MockPVT, MockUSDC} from "./MockTokens.sol";
import {MockEpochClock} from "./MockEpochClock.sol";
import {MockIssuanceIndex} from "./MockIssuanceIndex.sol";

/**
 * the three institution invariants, proven against the REAL BondPool, Court and
 * EscrowV4 wired together, plus the migration seeds the successor pool and escrow carry.
 *
 * 1. A bond claim expiring during a live Court panel never locks arbitrator collateral
 * and never lets the agent avoid the slash.
 * 2. Escrow arbitrators keep their collateral when an escrow settles outside the Court.
 * 3. processAbandonment leaves the agent's pending-claim count correct for its next bond.
 *
 * The RED side of each invariant (the deployed predecessor FAILING it) is proven on a Base
 * mainnet fork in SuccessorMigrationFork.t.sol. Here every new guard is also fed its violating
 * input and its complement.
 */
contract InstitutionSafetyTest is Test {
    ProvianBondPool internal bond;
    ProvianCourtV2 internal court;
    ProvianEscrowV4 internal escrow;
    MockPVT internal pvt;
    MockUSDC internal usdc;
    MockEpochClock internal clock;
    MockIssuanceIndex internal index;

    address internal admin = address(0xA01);
    address internal tech = address(0x7EC4);
    address internal agent = address(0xB01);
    address internal claimant = address(0xB02);
    address internal arb1 = address(0xC01);
    address internal arb2 = address(0xC02);
    address internal arb3 = address(0xC03);
    address internal depositor = address(0xD01);
    address internal recipient = address(0xD02);
    address internal stranger = address(0xE99);

    uint64 internal constant T0 = 1_000_000;
    uint256 internal constant FUND = 5_000_000e18;
    uint8 internal constant CASE_ESCROW = 1;
    uint8 internal constant CASE_BOND = 2;

    function setUp() public {
        vm.warp(T0);
        pvt = new MockPVT();
        usdc = new MockUSDC();
        clock = new MockEpochClock(T0);
        index = new MockIssuanceIndex();
        escrow = new ProvianEscrowV4(
            admin, tech, address(usdc), address(pvt), address(clock), address(index), new ProvianEscrowV4.EscrowSeed[](0)
        );
        bond = new ProvianBondPool(
            admin, tech, address(pvt), address(clock), address(index),
            new ProvianBondPool.BondSeed[](0), new ProvianBondPool.BpsSeed[](0)
        );
        court = new ProvianCourtV2(admin, address(escrow), address(clock), address(pvt), address(index));
        vm.startPrank(admin);
        escrow.setCourtContract(address(court));
        bond.setCourtContract(address(court));
        court.setBondPool(address(bond));
        vm.stopPrank();

        address[8] memory actors = [agent, claimant, arb1, arb2, arb3, depositor, recipient, stranger];
        for (uint256 i = 0; i < actors.length; i++) {
            pvt.mint(actors[i], FUND);
            usdc.mint(actors[i], 1_000_000e6);
            vm.startPrank(actors[i]);
            pvt.approve(address(bond), type(uint256).max);
            pvt.approve(address(court), type(uint256).max);
            pvt.approve(address(escrow), type(uint256).max);
            usdc.approve(address(escrow), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _panel() internal view returns (address[3] memory) {
        return [arb1, arb2, arb3];
    }

    function _caseKey(uint8 family, bytes32 id) internal pure returns (bytes32) {
        return keccak256(abi.encode(family, id));
    }

    // ================================================================
    // Fix 1 — a claim under a live panel cannot be expired out from under it
    // ================================================================

    function _bondClaimWithSeatedPanelLate() internal returns (bytes32 claimId, uint256 filedAt) {
        vm.prank(agent);
        bond.postBond(2, 0);
        claimId = keccak256("claim-late-panel");
        vm.prank(claimant);
        bond.fileClaim(agent, claimId);
        // Read back from the pool: under via-IR a local `block.timestamp` read can be
        // reordered past a later vm.warp.
        (,,,, filedAt) = bond.claims(claimId);
        // The panel is seated late — day 59 — so its 48h vote straddles the pool's
        // 60-day expiry. That straddle is exactly the defect.
        vm.warp(filedAt + 59 days);
        vm.prank(admin);
        court.assignBondClaimPanel(claimId, _panel());
        address[3] memory p = _panel();
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(p[i]);
            court.postBondClaimCollateral(claimId);
        }
    }

    function test_fix1_expiryRefusedUnderLivePanel_slashLands_collateralReturns() public {
        (bytes32 claimId, uint256 filedAt) = _bondClaimWithSeatedPanelLate();
        vm.warp(filedAt + 60 days + 1); // expirable by age, panel still voting
        assertTrue(court.bondClaimCaseOpen(claimId));

        vm.prank(agent);
        vm.expectRevert(ProvianBondPool.ClaimUnderAdjudication.selector);
        bond.expireStaleClaim(claimId);

        (uint256 bondBefore,,,,,,) = bond.bonds(agent);
        vm.prank(arb1);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.SlashFull);
        vm.prank(arb2);
        court.castBondClaimVote(claimId, ProvianCourtV2.BondVerdictVote.SlashFull);

        (uint256 bondAfter,,,,,, uint256 pending) = bond.bonds(agent);
        assertEq(bondAfter, 0, "the slash landed: the agent did not avoid it");
        assertGt(bondBefore, 0);
        assertEq(pending, 0);
        assertFalse(court.bondClaimCaseOpen(claimId));

        (,,,, uint256 required,,) = court.getPanelPosting(CASE_BOND, claimId);
        address[3] memory p = _panel();
        for (uint8 i = 0; i < 3; i++) {
            uint256 b = pvt.balanceOf(p[i]);
            court.settleArbitratorCollateral(CASE_BOND, claimId, i);
            assertGe(pvt.balanceOf(p[i]), b + required, "collateral returned, not locked");
        }
    }

    /// Complement: with no panel ever assigned, the 60-day liveness backstop still works.
    function test_fix1_expiryWithoutPanel_stillAllowed() public {
        vm.prank(agent);
        bond.postBond(2, 0);
        bytes32 claimId = keccak256("claim-no-panel");
        vm.prank(claimant);
        bond.fileClaim(agent, claimId);
        vm.warp(block.timestamp + 60 days);
        assertFalse(court.bondClaimCaseOpen(claimId));
        vm.prank(stranger);
        bond.expireStaleClaim(claimId);
        (,,,,,, uint256 pending) = bond.bonds(agent);
        assertEq(pending, 0);
    }

    /// Liveness now owned by the Court: a panel an admin seats and then abandons at
    /// round 0 (one seat posted, nobody replaced) closes permissionlessly after the
    /// abandonment backstop, refunding the claimant and returning the posted seat.
    function test_fix1_abandonedUnassembledPanel_closesWithoutAdmin() public {
        vm.prank(agent);
        bond.postBond(2, 0);
        bytes32 claimId = keccak256("claim-abandoned-panel");
        vm.prank(claimant);
        bond.fileClaim(agent, claimId);
        vm.prank(admin);
        court.assignBondClaimPanel(claimId, _panel());
        vm.prank(arb1);
        court.postBondClaimCollateral(claimId);
        (,,, uint64 postingDeadline, uint256 required,,) = court.getPanelPosting(CASE_BOND, claimId);
        (,,,, uint256 filedAt) = bond.claims(claimId);
        uint256 delay = court.UNASSIGNED_REWARD_BURN_DELAY();

        vm.warp(uint256(postingDeadline) + delay - 1);
        vm.expectRevert(ProvianCourtV2.PanelStillAssemblable.selector);
        court.closeUnassembledBondClaim(claimId);

        // Past the pool's 60-day age, the pool still refuses: the claim is the Court's.
        vm.warp(filedAt + 60 days);
        assertGe(block.timestamp, uint256(postingDeadline) + delay);
        vm.expectRevert(ProvianBondPool.ClaimUnderAdjudication.selector);
        bond.expireStaleClaim(claimId);
        uint256 claimantBefore = pvt.balanceOf(claimant);
        vm.prank(stranger);
        court.closeUnassembledBondClaim(claimId);
        assertEq(pvt.balanceOf(claimant), claimantBefore + 15e18, "filing fee refunded");
        (,,,,,, uint256 pending) = bond.bonds(agent);
        assertEq(pending, 0);
        uint256 b = pvt.balanceOf(arb1);
        court.settleArbitratorCollateral(CASE_BOND, claimId, 0);
        assertEq(pvt.balanceOf(arb1), b + required, "posted seat returned");
    }

    // ================================================================
    // Fix 2 — an escrow settled outside the Court releases its panel's collateral
    // ================================================================

    function _disputedEscrowWithSeatedPanel(bytes32 id) internal {
        vm.prank(depositor);
        escrow.createEscrow(id, recipient, 1_000e6, block.timestamp + 100 days, ProvianEscrowV4.Currency.USDC);
        vm.prank(depositor);
        escrow.fundEscrow(id, false);
        vm.prank(depositor);
        escrow.disputeEscrow(id);
        vm.prank(recipient);
        escrow.delegateToCourt(id); // pays the adjudication fee
        vm.prank(admin);
        court.assignPanel(id, _panel());
        address[3] memory p = _panel();
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(p[i]);
            court.postEscrowCollateral(id);
        }
    }

    function _assertAllSeatsReturned(bytes32 id) internal {
        (,,,, uint256 required,,) = court.getPanelPosting(CASE_ESCROW, id);
        assertGt(required, 0);
        address[3] memory p = _panel();
        for (uint8 i = 0; i < 3; i++) {
            uint256 b = pvt.balanceOf(p[i]);
            court.settleArbitratorCollateral(CASE_ESCROW, id, i);
            assertGe(pvt.balanceOf(p[i]), b + required, "seat keeps its collateral");
        }
        assertEq(uint8(court.getDisputeStatus(id)), uint8(ProvianCourtV2.DisputeStatus.Resolved));
        assertTrue(court.settledOutsideCourt(_caseKey(CASE_ESCROW, id)));
    }

    function test_fix2_adminResolvesOnEscrow_panelKeepsCollateral() public {
        bytes32 id = keccak256("esc-admin");
        _disputedEscrowWithSeatedPanel(id);
        vm.prank(arb1);
        court.castVote(id, true);

        vm.prank(admin);
        escrow.resolveDispute(id, false); // outside the Court

        vm.prank(arb2);
        vm.expectRevert(ProvianCourtV2.EscrowSettledOutsideCourt.selector);
        court.castVote(id, true);
        vm.expectRevert(ProvianCourtV2.EscrowSettledOutsideCourt.selector);
        court.escalateDispute(id);

        _assertAllSeatsReturned(id);
    }

    function test_fix2_escrowTimeout_panelKeepsCollateral() public {
        bytes32 id = keccak256("esc-timeout");
        vm.prank(depositor);
        escrow.createEscrow(id, recipient, 1_000e6, block.timestamp + 100 days, ProvianEscrowV4.Currency.USDC);
        vm.prank(depositor);
        escrow.fundEscrow(id, false);
        vm.prank(depositor);
        escrow.disputeEscrow(id);
        // Panel seated one hour before the escrow's own timeout.
        vm.warp(escrow.disputeDeadline(id) - 1 hours);
        vm.prank(recipient);
        escrow.delegateToCourt(id);
        vm.prank(admin);
        court.assignPanel(id, _panel());
        address[3] memory p = _panel();
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(p[i]);
            court.postEscrowCollateral(id);
        }
        vm.warp(escrow.disputeDeadline(id));
        vm.prank(stranger);
        escrow.claimDisputeTimeout(id);

        vm.prank(stranger);
        court.closeExternallySettledDispute(id);
        _assertAllSeatsReturned(id);
    }

    /// Complement: the misconduct rule survives. A panel whose voting deadline passed
    /// before the escrow settled elsewhere ran to its deadline, so a seat that never
    /// voted is burned while the seat that voted is returned.
    function test_fix2_silentSeatPastDeadline_stillBurned() public {
        bytes32 id = keccak256("esc-silent");
        _disputedEscrowWithSeatedPanel(id);
        vm.prank(arb1);
        court.castVote(id, true);
        vm.warp(court.getVotingDeadline(id) + 1);
        vm.warp(escrow.disputeDeadline(id));
        escrow.claimDisputeTimeout(id);

        (,,,, uint256 required,,) = court.getPanelPosting(CASE_ESCROW, id);
        uint256 b1 = pvt.balanceOf(arb1);
        uint256 b2 = pvt.balanceOf(arb2);
        court.settleArbitratorCollateral(CASE_ESCROW, id, 0);
        court.settleArbitratorCollateral(CASE_ESCROW, id, 1);
        assertGe(pvt.balanceOf(arb1), b1 + required, "voter returned");
        assertEq(pvt.balanceOf(arb2), b2, "silent seat burned");
        assertTrue(court.resolvedByDeadline(_caseKey(CASE_ESCROW, id)));
    }

    function test_fix2_closeRefusedWhileStillDisputed() public {
        bytes32 id = keccak256("esc-live");
        _disputedEscrowWithSeatedPanel(id);
        vm.expectRevert(ProvianCourtV2.EscrowNotSettledOutsideCourt.selector);
        court.closeExternallySettledDispute(id);
        vm.expectRevert(ProvianCourtV2.CaseNotTerminal.selector);
        court.settleArbitratorCollateral(CASE_ESCROW, id, 0);
    }

    /// The Court's own verdict stamps the escrow too, but a case the Court resolved
    /// itself is never re-labelled as settled outside it.
    function test_fix2_courtVerdictIsNotOutsideSettlement() public {
        bytes32 id = keccak256("esc-verdict");
        _disputedEscrowWithSeatedPanel(id);
        vm.prank(arb1);
        court.castVote(id, true);
        vm.prank(arb2);
        court.castVote(id, true);
        assertGt(escrow.disputeSettledAt(id), 0);
        assertFalse(court.settledOutsideCourt(_caseKey(CASE_ESCROW, id)));
        vm.expectRevert(ProvianCourtV2.EscrowNotSettledOutsideCourt.selector);
        court.closeExternallySettledDispute(id);
    }

    // ================================================================
    // Fix 3 — abandonment never strands a pending claim onto the next bond
    // ================================================================

    function _horizon() internal view returns (uint256) {
        (,,,, uint256 deadline,,) = bond.bonds(agent);
        return deadline + bond.renewalGracePeriod() + bond.abandonmentPeriod();
    }

    function test_fix3_abandonmentWaitsForPendingClaim_nextBondStartsClean() public {
        vm.prank(agent);
        bond.postBond(2, 0);
        uint256 horizon = _horizon();

        vm.warp(horizon - 1 days);
        bytes32 claimId = keccak256("claim-at-horizon");
        vm.prank(claimant);
        bond.fileClaim(agent, claimId);

        vm.warp(horizon);
        vm.expectRevert(ProvianBondPool.ClaimsPending.selector);
        bond.processAbandonment(agent);

        vm.warp(horizon - 1 days + 60 days);
        bond.expireStaleClaim(claimId);
        bond.processAbandonment(agent);
        (,,,,, ProvianBondPool.BondStatus st, uint256 pending) = bond.bonds(agent);
        assertEq(uint8(st), uint8(ProvianBondPool.BondStatus.Abandoned));
        assertEq(pending, 0);

        vm.prank(agent);
        bond.postBond(2, 0);
        (,,,,,, uint256 pendingNext) = bond.bonds(agent);
        assertEq(pendingNext, 0, "next bond starts from a true zero");

        // And a claim on the new bond is counted exactly once.
        bytes32 next = keccak256("claim-next-bond");
        vm.prank(claimant);
        bond.fileClaim(agent, next);
        (,,,,,, uint256 one) = bond.bonds(agent);
        assertEq(one, 1);
        vm.prank(agent);
        vm.expectRevert(ProvianBondPool.ClaimsPending.selector);
        bond.withdrawBond();
    }

    /// The postBond guard's violating state cannot arise through the fixed pool, so it is
    /// constructed directly (the predecessor produces it naturally; see the fork suite):
    /// an Abandoned record that still carries a pending count.
    function test_fix3_postBondRefusesStaleCount() public {
        vm.prank(agent);
        bond.postBond(2, 0);
        vm.warp(_horizon());
        bond.processAbandonment(agent);
        bytes32 slot = keccak256(abi.encode(agent, uint256(_bondsSlot())));
        vm.store(address(bond), bytes32(uint256(slot) + 6), bytes32(uint256(1))); // pendingClaims
        (,,,,,, uint256 stale) = bond.bonds(agent);
        assertEq(stale, 1, "stale count constructed");
        vm.prank(agent);
        vm.expectRevert(ProvianBondPool.ClaimsPending.selector);
        bond.postBond(2, 0);
    }

    /// Storage slot of `bonds`, found by probing rather than hard-coded.
    function _bondsSlot() internal returns (uint256) {
        vm.prank(stranger);
        bond.postBond(3, 0);
        (uint256 amount,,,,,,) = bond.bonds(stranger);
        for (uint256 s = 0; s < 64; s++) {
            bytes32 at = keccak256(abi.encode(stranger, s));
            if (uint256(vm.load(address(bond), at)) == amount) return s;
        }
        revert("bonds slot not found");
    }

    // ================================================================
    // Migration seeds
    // ================================================================

    function _bondSeed() internal pure returns (ProvianBondPool.BondSeed memory) {
        return ProvianBondPool.BondSeed({
            agent: address(0x5E64),
            amount: 750e18 + 1,
            autonomyLevel: 2,
            createdAt: 1_789_000_000,
            lastRenewalAt: 1_789_000_000,
            renewalDeadline: 1_789_000_000 + 180 days,
            requiredAtPost: 750e18
        });
    }

    function test_seed_bondCarriedExactly_backingArrivesLater() public {
        ProvianBondPool.BondSeed[] memory bonds_ = new ProvianBondPool.BondSeed[](1);
        bonds_[0] = _bondSeed();
        ProvianBondPool.BpsSeed[] memory bps = new ProvianBondPool.BpsSeed[](2);
        bps[0] = ProvianBondPool.BpsSeed({param: 1, bps: 0});
        bps[1] = ProvianBondPool.BpsSeed({param: 3, bps: 0});
        vm.recordLogs();
        ProvianBondPool pool = new ProvianBondPool(admin, tech, address(pvt), address(clock), address(index), bonds_, bps);

        (uint256 amount, uint8 level, uint256 createdAt, uint256 lastRenewalAt, uint256 deadline,
            ProvianBondPool.BondStatus st, uint256 pending) = pool.bonds(address(0x5E64));
        assertEq(amount, 750e18 + 1);
        assertEq(level, 2);
        assertEq(createdAt, 1_789_000_000);
        assertEq(lastRenewalAt, 1_789_000_000);
        assertEq(deadline, 1_789_000_000 + 180 days);
        assertEq(uint8(st), uint8(ProvianBondPool.BondStatus.Active));
        assertEq(pending, 0);
        assertEq(pool.requiredAtPost(address(0x5E64)), 750e18);
        (bool feeExists, uint256 fee) = pool.activeDepositFeeBps();
        assertTrue(feeExists);
        assertEq(fee, 0);
        (bool renExists, uint256 ren) = pool.activeRenewalFeeBps();
        assertTrue(renExists);
        assertEq(ren, 0);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(logs[i].topics[0] != ProvianBondPool.BondPosted.selector, "carry is not a new post");
        }

        // Unbacked: an exit fails closed on the token, never pays from nothing.
        vm.prank(address(0x5E64));
        vm.expectRevert();
        pool.withdrawBond();
        // Backed by the distribution: the exit pays exactly the carried amount.
        pvt.mint(address(pool), 750e18 + 1);
        vm.prank(address(0x5E64));
        pool.withdrawBond();
        assertEq(pvt.balanceOf(address(0x5E64)), 750e18 + 1);
    }

    function test_seed_invalidBondsAndBpsRefused() public {
        ProvianBondPool.BpsSeed[] memory noBps = new ProvianBondPool.BpsSeed[](0);
        ProvianBondPool.BondSeed[] memory one = new ProvianBondPool.BondSeed[](1);

        one[0] = _bondSeed();
        one[0].autonomyLevel = 4;
        _expectPoolSeedRevert(one, noBps, ProvianBondPool.InvalidSeed.selector);

        one[0] = _bondSeed();
        one[0].agent = address(0);
        _expectPoolSeedRevert(one, noBps, ProvianBondPool.InvalidSeed.selector);

        one[0] = _bondSeed();
        one[0].renewalDeadline = one[0].lastRenewalAt - 1;
        _expectPoolSeedRevert(one, noBps, ProvianBondPool.InvalidSeed.selector);

        ProvianBondPool.BondSeed[] memory dup = new ProvianBondPool.BondSeed[](2);
        dup[0] = _bondSeed();
        dup[1] = _bondSeed();
        _expectPoolSeedRevert(dup, noBps, ProvianBondPool.InvalidSeed.selector);

        ProvianBondPool.BondSeed[] memory noBonds = new ProvianBondPool.BondSeed[](0);
        ProvianBondPool.BpsSeed[] memory bad = new ProvianBondPool.BpsSeed[](1);
        bad[0] = ProvianBondPool.BpsSeed({param: 4, bps: 0});
        _expectPoolSeedRevert(noBonds, bad, ProvianBondPool.InvalidSeed.selector);
        bad[0] = ProvianBondPool.BpsSeed({param: 1, bps: 501});
        _expectPoolSeedRevert(noBonds, bad, ProvianBondPool.CostOutOfDomain.selector);
        ProvianBondPool.BpsSeed[] memory twice = new ProvianBondPool.BpsSeed[](2);
        twice[0] = ProvianBondPool.BpsSeed({param: 1, bps: 0});
        twice[1] = ProvianBondPool.BpsSeed({param: 1, bps: 0});
        _expectPoolSeedRevert(noBonds, twice, ProvianBondPool.PolicyAlreadyScheduled.selector);
    }

    function _expectPoolSeedRevert(
        ProvianBondPool.BondSeed[] memory b,
        ProvianBondPool.BpsSeed[] memory s,
        bytes4 selector
    ) internal {
        vm.expectRevert(selector);
        new ProvianBondPool(admin, tech, address(pvt), address(clock), address(index), b, s);
    }

    function test_seed_unfundedEscrowCarried_depositorFundsIt() public {
        ProvianEscrowV4.EscrowSeed[] memory seeds = new ProvianEscrowV4.EscrowSeed[](1);
        bytes32 id = keccak256("carried-escrow");
        seeds[0] = ProvianEscrowV4.EscrowSeed({
            escrowId: id,
            depositor: depositor,
            recipient: recipient,
            amount: 1e18,
            fee: 5e15,
            autoReleaseAt: block.timestamp + 10 days,
            currency: ProvianEscrowV4.Currency.PVT
        });
        ProvianEscrowV4 esc = new ProvianEscrowV4(admin, tech, address(usdc), address(pvt), address(clock), address(index), seeds);
        (address d, address r, uint256 amt, uint256 fee, uint256 ar, ProvianEscrowV4.Status st, ProvianEscrowV4.Currency cur,) =
            esc.escrows(id);
        assertEq(d, depositor);
        assertEq(r, recipient);
        assertEq(amt, 1e18);
        assertEq(fee, 5e15);
        assertEq(ar, block.timestamp + 10 days);
        assertEq(uint8(st), uint8(ProvianEscrowV4.Status.Created));
        assertEq(uint8(cur), uint8(ProvianEscrowV4.Currency.PVT));

        vm.startPrank(depositor);
        pvt.approve(address(esc), type(uint256).max);
        esc.fundEscrow(id, false);
        vm.stopPrank();
        (,,,,, ProvianEscrowV4.Status funded,,) = esc.escrows(id);
        assertEq(uint8(funded), uint8(ProvianEscrowV4.Status.Funded));

        // Invalid seeds refused: duplicate id, fee above amount.
        ProvianEscrowV4.EscrowSeed[] memory twice = new ProvianEscrowV4.EscrowSeed[](2);
        twice[0] = seeds[0];
        twice[1] = seeds[0];
        vm.expectRevert(ProvianEscrowV4.InvalidSeed.selector);
        new ProvianEscrowV4(admin, tech, address(usdc), address(pvt), address(clock), address(index), twice);
        seeds[0].fee = 2e18;
        vm.expectRevert(ProvianEscrowV4.InvalidSeed.selector);
        new ProvianEscrowV4(admin, tech, address(usdc), address(pvt), address(clock), address(index), seeds);
    }
}
