// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {ProvianRecourseKernel} from "../src/ProvianRecourseKernel.sol";
import {ProvianRecourseEligibilityVerifier} from "../src/ProvianRecourseEligibilityVerifier.sol";
import {LiveProtocol} from "./helpers/LiveProtocol.sol";

/**
 * @title Security pass 2026-10-02 (Fable run) — surface 5: relay-compromise blast radius, BOUNDED.
 *
 * the design requires that the minter and batch-approver keys stay in one Cloud Run process until
 * post-launch hardening. The pass MEASURED what a process that holds both keys could mint on the
 * LIVE kernel: the standard lane prices a claim from a caller-supplied `recordPointsAtomic`
 * with no on-chain bound, and the only ceiling, `policy.combinedCap`, was `type(uint256).max`
 * (uncapped policy, Fixed mode from epoch zero) — ONE approve + ONE settle minted 1e30 PVT,
 * a bound of `type(uint256).max − totalSupply` per transaction pair.
 *
 * ruling (, FIX 2) restores the original launch ceilings — 7.5M Genesis /
 * 10M combined per epoch — through the kernel's existing prospective setter
 * (`scheduleCapPolicy(1, Fixed, 7.5e24, 1e25)`, superseding). These tests PROVE the bound on
 * a fork of the live chain, pranking the live operator keys, from the first epoch the schedule
 * binds:
 *
 * - the S5 exploit (one 1e30-PVT batch) reverts `CombinedEpochCapExceeded`;
 * - an owned process mints at most the 10M combined ceiling per epoch, and the next wei refuses;
 * - the ceiling is per epoch: the next epoch admits another 10M, so the blast radius is 10M PVT
 * gross per 7-day epoch until the bootstrap admin's hold, the only brake (last test).
 *
 * RED control: run against the chain BEFORE the ceiling transaction (Fixed / MAX / MAX) — the 1e30
 * batch settles and `expectRevert` fails. GREEN once the schedule is on the forked chain (the
 * anvil rehearsal, then Base mainnet after the broadcast).
 *
 * The kernel and verifier are the live set, read through the permanent protocol pointer with
 * each runtime hash checked, so the bound is proven on whichever kernel currently settles. The
 * ceilings carried into the successor kernel at succession are asserted here unchanged.
 *
 * BASE_RPC_URL=<fork> forge test --root contracts --match-contract SecurityPass20261002BlastRadius -vv
 */
contract SecurityPass20261002BlastRadiusTest is Test {
    uint256 internal constant RULED_GENESIS_CAP = 7_500_000e18;
    uint256 internal constant RULED_COMBINED_CAP = 10_000_000e18;

    ProvianRecourseKernel internal kernel;
    ProvianRecourseEligibilityVerifier internal verifier;
    address internal minter;
    address internal approver;

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));
        require(block.chainid == 8453, "Fork tests require Base mainnet (chainId 8453)");
        kernel = ProvianRecourseKernel(LiveProtocol.component(LiveProtocol.KERNEL));
        verifier = ProvianRecourseEligibilityVerifier(LiveProtocol.component(LiveProtocol.ELIGIBILITY_VERIFIER));
        require(!kernel.administrativeHold(), "live kernel is held");
        // Each contributor mint also consumes an issuance ticket the identity attestor signed for
        // that exact account and amount on the Recourse Pool. A fork cannot sign one, so the pool's
        // callback is stubbed to divert nothing. That removes a gate rather than adding one: the
        // ceiling is proven with the attestor key also in the owned process's hands.
        vm.mockCall(LiveProtocol.component(LiveProtocol.RECOURSE_POOL),
            abi.encodeWithSignature("divertIssuance(address,uint256,uint256)"), abi.encode(uint256(0)));
        minter = kernel.operationalMinter();
        approver = verifier.batchApprover();
        require(minter != address(0) && approver != address(0), "operators not appointed");
        _openThrough(kernel.currentEpoch());
    }

    function _openThrough(uint64 target) internal {
        while (kernel.lastOpenedEpoch() < target) {
            vm.prank(makeAddr("epoch-opener"));
            kernel.openNextEpoch();
        }
    }

    /// Warp to the start of the next epoch and open it — the first epoch a schedule made now binds.
    function _enterNextEpoch() internal returns (uint64 epoch) {
        epoch = kernel.currentEpoch() + 1;
        vm.warp(uint256(kernel.epochZeroStartsAt()) + uint256(epoch) * kernel.EPOCH_DURATION());
        _openThrough(epoch);
        assertEq(kernel.lastOpenedEpoch(), epoch, "epoch opened");
    }

    function _oneClaimBatch(address to, uint256 points, bytes32 salt)
        internal
        view
        returns (
            bytes32 batchId,
            uint64 epoch,
            bytes32 policyHash,
            uint256 cursor,
            ProvianRecourseKernel.StandardRecipient[] memory recipients,
            ProvianRecourseKernel.StandardPEClaim[] memory claims
        )
    {
        epoch = kernel.lastOpenedEpoch();
        policyHash = kernel.getEpochPolicy(epoch).policyHash;
        cursor = kernel.nextFinalizedCursor();
        batchId = keccak256(abi.encode("sp-blast", salt, cursor));
        recipients = new ProvianRecourseKernel.StandardRecipient[](1);
        recipients[0] = ProvianRecourseKernel.StandardRecipient({
            contributor: to, beneficiaryClass: ProvianRecourseKernel.BeneficiaryClass.HumanResolving, claimCount: 1
        });
        claims = new ProvianRecourseKernel.StandardPEClaim[](1);
        claims[0] = ProvianRecourseKernel.StandardPEClaim({claimId: keccak256(abi.encode("sp-blast-claim", salt)), recordPointsAtomic: points});
    }

    /// Approve then settle one single-claim batch as the owned process would.
    function _settle(address to, uint256 points, bytes32 salt) internal {
        (
            bytes32 batchId,
            uint64 epoch,
            bytes32 policyHash,
            uint256 cursor,
            ProvianRecourseKernel.StandardRecipient[] memory recipients,
            ProvianRecourseKernel.StandardPEClaim[] memory claims
        ) = _oneClaimBatch(to, points, salt);
        vm.prank(approver);
        verifier.approveStandardBatch(batchId, epoch, policyHash, cursor, cursor + 1, recipients, claims);
        vm.prank(minter);
        kernel.settleStandardPEBatch(batchId, epoch, policyHash, cursor, cursor + 1, recipients, claims);
    }

    /// Approve one batch, then expect its settlement to revert with `selector`.
    function _settleExpectRevert(address to, uint256 points, bytes32 salt, bytes4 selector) internal {
        (
            bytes32 batchId,
            uint64 epoch,
            bytes32 policyHash,
            uint256 cursor,
            ProvianRecourseKernel.StandardRecipient[] memory recipients,
            ProvianRecourseKernel.StandardPEClaim[] memory claims
        ) = _oneClaimBatch(to, points, salt);
        vm.prank(approver);
        verifier.approveStandardBatch(batchId, epoch, policyHash, cursor, cursor + 1, recipients, claims);
        vm.prank(minter);
        vm.expectRevert(selector);
        kernel.settleStandardPEBatch(batchId, epoch, policyHash, cursor, cursor + 1, recipients, claims);
    }

    /// The S5 exploit — one 1e30-PVT batch — is refused from the first epoch the ruled ceiling binds.
    function test_bound_theS5BatchIsRefusedByTheCombinedCeiling() public {
        address thief = makeAddr("owned-process-recipient");
        uint64 epoch = _enterNextEpoch();
        ProvianRecourseKernel.EpochPolicy memory policy = kernel.getEpochPolicy(epoch);
        emit log_named_uint("bound epoch", epoch);
        emit log_named_uint("epoch genesisCap", policy.genesisCap);
        emit log_named_uint("epoch combinedCap", policy.combinedCap);
        uint256 supplyBefore = kernel.totalSupply();

        _settleExpectRevert(thief, 1e30 * 1e18, "1e30", ProvianRecourseKernel.CombinedEpochCapExceeded.selector);

        assertEq(kernel.totalSupply(), supplyBefore, "nothing minted");
        assertEq(uint8(policy.combinedCapMode), uint8(ProvianRecourseKernel.CombinedCapMode.Fixed), "Fixed mode");
        assertEq(policy.genesisCap, RULED_GENESIS_CAP, "Genesis ceiling 7.5M per epoch");
        assertEq(policy.combinedCap, RULED_COMBINED_CAP, "combined ceiling 10M per epoch");
    }

    /// An owned process mints at most the 10M combined ceiling in an epoch; the next PVT refuses; the
    /// next epoch admits another 10M (the ceiling is per epoch, the admin hold is the only stop).
    function test_bound_maximumMintablePerEpochIsTheCombinedCeiling() public {
        address thief = makeAddr("owned-process-recipient-max");
        uint64 epoch = _enterNextEpoch();
        uint256 supplyBefore = kernel.totalSupply();
        uint256 headroom = RULED_COMBINED_CAP - kernel.epochTotalIssued(epoch);
        // A multiple of 200 keeps the 99 / 0.5 / 0.5 shares exact, so gross minted == points.
        uint256 points = headroom - (headroom % 200);

        _settle(thief, points, "fill");
        uint256 mintedThisEpoch = kernel.epochTotalIssued(epoch);
        emit log_named_uint("max minted in the bound epoch (wei)", mintedThisEpoch);
        assertLe(mintedThisEpoch, RULED_COMBINED_CAP, "never past the ceiling");
        assertGe(mintedThisEpoch, RULED_COMBINED_CAP - 199, "the ceiling is reachable to the wei");
        assertEq(kernel.totalSupply() - supplyBefore, points, "gross minted == points at mintRate 1.0");

        _settleExpectRevert(thief, 1e18, "one-more", ProvianRecourseKernel.CombinedEpochCapExceeded.selector);

        uint64 next = _enterNextEpoch();
        _settle(thief, RULED_COMBINED_CAP, "next-epoch");
        assertEq(kernel.epochTotalIssued(next), RULED_COMBINED_CAP, "another 10M in the next epoch");
        _settleExpectRevert(thief, 1e18, "next-epoch-one-more", ProvianRecourseKernel.CombinedEpochCapExceeded.selector);
    }

    function test_measure_theOnlyBrakeIsTheAdminHold() public {
        address thief = makeAddr("owned-process-recipient-2");
        (
            bytes32 batchId,
            uint64 epoch,
            bytes32 policyHash,
            uint256 cursor,
            ProvianRecourseKernel.StandardRecipient[] memory recipients,
            ProvianRecourseKernel.StandardPEClaim[] memory claims
        ) = _oneClaimBatch(thief, 1e24, "held");
        vm.prank(approver);
        verifier.approveStandardBatch(batchId, epoch, policyHash, cursor, cursor + 1, recipients, claims);

        vm.prank(kernel.BOOTSTRAP_ADMIN());
        kernel.placeAdministrativeHold();
        vm.prank(minter);
        vm.expectRevert(ProvianRecourseKernel.AdministrativeHoldActive.selector);
        kernel.settleStandardPEBatch(batchId, epoch, policyHash, cursor, cursor + 1, recipients, claims);
    }
}
