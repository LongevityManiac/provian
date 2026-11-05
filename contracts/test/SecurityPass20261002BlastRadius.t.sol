// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {ProvianPVT9} from "../src/ProvianPVT9.sol";
import {ProvianPVT9EligibilityVerifier} from "../src/ProvianPVT9EligibilityVerifier.sol";

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
 * BASE_RPC_URL=<fork> forge test --root contracts --match-contract SecurityPass20261002BlastRadius -vv
 */
contract SecurityPass20261002BlastRadiusTest is Test {
    uint256 internal constant RULED_GENESIS_CAP = 7_500_000e18;
    uint256 internal constant RULED_COMBINED_CAP = 10_000_000e18;

    ProvianPVT9 internal kernel;
    ProvianPVT9EligibilityVerifier internal verifier;
    address internal minter;
    address internal approver;

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));
        kernel = ProvianPVT9(vm.envOr("SP_SUCCESSOR_KERNEL", address(0x8811441914381143b9408c5C32247367F86F173A)));
        verifier = ProvianPVT9EligibilityVerifier(
            vm.envOr("SP_SUCCESSOR_VERIFIER", address(0xb26Fd9d4f3b42911592B96270e8437287DE33406))
        );
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
            ProvianPVT9.StandardRecipient[] memory recipients,
            ProvianPVT9.StandardPEClaim[] memory claims
        )
    {
        epoch = kernel.lastOpenedEpoch();
        policyHash = kernel.getEpochPolicy(epoch).policyHash;
        cursor = kernel.nextFinalizedCursor();
        batchId = keccak256(abi.encode("sp-blast", salt, cursor));
        recipients = new ProvianPVT9.StandardRecipient[](1);
        recipients[0] = ProvianPVT9.StandardRecipient({
            contributor: to, beneficiaryClass: ProvianPVT9.BeneficiaryClass.HumanResolving, claimCount: 1
        });
        claims = new ProvianPVT9.StandardPEClaim[](1);
        claims[0] = ProvianPVT9.StandardPEClaim({claimId: keccak256(abi.encode("sp-blast-claim", salt)), recordPointsAtomic: points});
    }

    /// Approve then settle one single-claim batch as the owned process would.
    function _settle(address to, uint256 points, bytes32 salt) internal {
        (
            bytes32 batchId,
            uint64 epoch,
            bytes32 policyHash,
            uint256 cursor,
            ProvianPVT9.StandardRecipient[] memory recipients,
            ProvianPVT9.StandardPEClaim[] memory claims
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
            ProvianPVT9.StandardRecipient[] memory recipients,
            ProvianPVT9.StandardPEClaim[] memory claims
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
        ProvianPVT9.EpochPolicy memory policy = kernel.getEpochPolicy(epoch);
        emit log_named_uint("bound epoch", epoch);
        emit log_named_uint("epoch genesisCap", policy.genesisCap);
        emit log_named_uint("epoch combinedCap", policy.combinedCap);
        uint256 supplyBefore = kernel.totalSupply();

        _settleExpectRevert(thief, 1e30 * 1e18, "1e30", ProvianPVT9.CombinedEpochCapExceeded.selector);

        assertEq(kernel.totalSupply(), supplyBefore, "nothing minted");
        assertEq(uint8(policy.combinedCapMode), uint8(ProvianPVT9.CombinedCapMode.Fixed), "Fixed mode");
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

        _settleExpectRevert(thief, 1e18, "one-more", ProvianPVT9.CombinedEpochCapExceeded.selector);

        uint64 next = _enterNextEpoch();
        _settle(thief, RULED_COMBINED_CAP, "next-epoch");
        assertEq(kernel.epochTotalIssued(next), RULED_COMBINED_CAP, "another 10M in the next epoch");
        _settleExpectRevert(thief, 1e18, "next-epoch-one-more", ProvianPVT9.CombinedEpochCapExceeded.selector);
    }

    function test_measure_theOnlyBrakeIsTheAdminHold() public {
        address thief = makeAddr("owned-process-recipient-2");
        (
            bytes32 batchId,
            uint64 epoch,
            bytes32 policyHash,
            uint256 cursor,
            ProvianPVT9.StandardRecipient[] memory recipients,
            ProvianPVT9.StandardPEClaim[] memory claims
        ) = _oneClaimBatch(thief, 1e24, "held");
        vm.prank(approver);
        verifier.approveStandardBatch(batchId, epoch, policyHash, cursor, cursor + 1, recipients, claims);

        vm.prank(kernel.BOOTSTRAP_ADMIN());
        kernel.placeAdministrativeHold();
        vm.prank(minter);
        vm.expectRevert(ProvianPVT9.AdministrativeHoldActive.selector);
        kernel.settleStandardPEBatch(batchId, epoch, policyHash, cursor, cursor + 1, recipients, claims);
    }
}
