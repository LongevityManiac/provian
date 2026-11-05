// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProvianPVT9} from "../src/ProvianPVT9.sol";
import {ProvianPVT9TestBase} from "./ProvianPVT9TestBase.sol";

/// @notice settlement runtime settlement/epoch-orchestration characterization of the accepted
/// settlement kernel kernel. These tests change nothing in `ProvianPVT9`; they pin the exact
/// kernel-side facts the off-chain settlement runtime settler layer is built against, so that
/// a later kernel or worker change cannot silently invalidate the worker's
/// assumptions.
contract ProvianPVT9Wp4SettlementTest is ProvianPVT9TestBase {
    address internal constant ALICE = address(0xC001);
    address internal constant BOB = address(0xC002);

    uint256 internal constant POINTS = 1_000 ether;
    /// gross = POINTS * 1e18 / 1e18 at the armed 1.0x rate; contributor keeps 9,900 BPS.
    uint256 internal constant CONTRIBUTOR_SHARE = 990 ether;

    // --------------------------------------------------------------------
    // A2 — settlement fence across an epoch boundary
    // --------------------------------------------------------------------

    /// Once wall-clock time crosses into epoch N+1, a batch bound to epoch N is
    /// refused even though epoch N is still the last opened epoch.
    function test_fence_rejectsPriorEpochAfterBoundaryCrossed() public {
        (bytes32 stalePolicyHash, uint256 cursor) = _epochZeroBinding();

        vm.warp(uint256(epochStart) + pvt.EPOCH_DURATION());
        assertEq(pvt.lastOpenedEpoch(), 0, "epoch 1 must not be opened yet");
        assertEq(pvt.currentEpoch(), 1, "wall clock must be in epoch 1");

        _expectSettleRevert(ProvianPVT9.EpochMismatch.selector, 0, stalePolicyHash, cursor);
    }

    /// The other direction: the newly-entered epoch cannot be settled into
    /// until `openNextEpoch()` has actually written its policy.
    function test_fence_rejectsNewEpochBeforeItIsOpened() public {
        (, uint256 cursor) = _epochZeroBinding();

        vm.warp(uint256(epochStart) + pvt.EPOCH_DURATION());

        // Epoch 1 has no policy yet, so there is no non-zero hash to present.
        assertEq(pvt.getEpochPolicy(1).policyHash, bytes32(0), "epoch 1 policy must be unwritten");
        _expectSettleRevert(ProvianPVT9.EpochNotOpen.selector, 1, bytes32(uint256(1)), cursor);
    }

    /// The fence is a fence, not a permanent block: opening the epoch clears it.
    function test_fence_clearsAfterOpenNextEpoch() public {
        (, uint256 cursor) = _epochZeroBinding();

        vm.warp(uint256(epochStart) + pvt.EPOCH_DURATION());
        pvt.openNextEpoch();

        assertEq(pvt.lastOpenedEpoch(), 1, "openNextEpoch must advance the opened epoch");
        bytes32 freshPolicyHash = pvt.getEpochPolicy(1).policyHash;
        assertTrue(freshPolicyHash != bytes32(0), "epoch 1 policy must be written");

        _settle(ALICE, _claimId(), 1, freshPolicyHash, cursor);
        assertEq(pvt.balanceOf(ALICE), CONTRIBUTOR_SHARE, "settlement must succeed once the epoch is open");
    }

    /// A batch prepared in epoch N is NOT resumable across the boundary: the
    /// identical calldata reverts. It must be rebuilt against the new epoch and
    /// policy hash — and because nothing settled, the cursor range and the
    /// per-PE claim ids are unchanged by the rebuild.
    function test_crossBoundaryBatch_isNonResumable_butRebuildsAtSameCursor() public {
        (bytes32 stalePolicyHash, uint256 cursor) = _epochZeroBinding();
        bytes32 claimId = _claimId();

        vm.warp(uint256(epochStart) + pvt.EPOCH_DURATION());
        pvt.openNextEpoch();

        // Same claim, same cursor, stale epoch binding: refused.
        _expectSettleRevert(ProvianPVT9.EpochMismatch.selector, 0, stalePolicyHash, cursor, claimId);

        // Rebound to the new epoch, with the claim id and cursor untouched.
        assertEq(pvt.nextFinalizedCursor(), cursor, "a refused batch must not move the cursor");
        _settle(ALICE, claimId, 1, pvt.getEpochPolicy(1).policyHash, cursor);

        assertEq(pvt.balanceOf(ALICE), CONTRIBUTOR_SHARE, "rebuilt batch must settle exactly once");
        assertEq(pvt.nextFinalizedCursor(), cursor + 1, "cursor advances only on the settled batch");
        assertTrue(pvt.claimSettled(claimId), "the stable claim id is what gets consumed");
    }

    /// `openNextEpoch()` advances exactly one epoch per call, so a missed
    /// scheduler run requires one catch-up call per skipped epoch, and cannot
    /// be run ahead of wall-clock time.
    function test_openNextEpoch_catchUp_isOneCallPerMissedEpoch() public {
        (, uint256 cursor) = _epochZeroBinding();

        vm.warp(uint256(epochStart) + 3 * pvt.EPOCH_DURATION());
        assertEq(pvt.currentEpoch(), 3, "wall clock must be in epoch 3");
        assertEq(pvt.lastOpenedEpoch(), 0, "three epochs must be unopened");

        pvt.openNextEpoch();
        assertEq(pvt.lastOpenedEpoch(), 1, "first catch-up call opens epoch 1 only");
        // Still fenced: the open epoch is not the wall-clock epoch.
        _expectSettleRevert(ProvianPVT9.EpochMismatch.selector, 1, pvt.getEpochPolicy(1).policyHash, cursor);

        pvt.openNextEpoch();
        pvt.openNextEpoch();
        assertEq(pvt.lastOpenedEpoch(), 3, "catch-up completes at the wall-clock epoch");

        // And it cannot be driven past wall-clock time.
        vm.expectRevert(ProvianPVT9.EpochNotReady.selector);
        pvt.openNextEpoch();

        _settle(ALICE, _claimId(), 3, pvt.getEpochPolicy(3).policyHash, cursor);
        assertEq(pvt.balanceOf(ALICE), CONTRIBUTOR_SHARE, "settlement resumes once caught up");
    }

    // --------------------------------------------------------------------
    // Integration invariant — one unified cross-lane cursor
    // --------------------------------------------------------------------

    /// Standard and Genesis do not have independent counters: they consume one
    /// monotonic `nextFinalizedCursor`, so the worker must allocate ranges from
    /// a single sequence and may never run the two lanes concurrently.
    function test_cursor_isOneMonotonicCounterSharedByBothLanes() public {
        (bytes32 policyHash, uint256 start) = _epochZeroBinding();

        _settle(ALICE, _claimId(), 0, policyHash, start);
        assertEq(pvt.nextFinalizedCursor(), start + 1, "standard lane advances the shared cursor");

        // Genesis may not restart at the standard lane's start.
        _expectGenesisSettleRevert(ProvianPVT9.CursorDiscontinuity.selector, 0, policyHash, start);

        _settleGenesisAt(BOB, _claimId(), keccak256("wallet-1"), keccak256("anchor-1"), 0, policyHash, start + 1);
        assertEq(pvt.nextFinalizedCursor(), start + 2, "genesis lane continues the same cursor");

        // And the standard lane must then continue from where Genesis left off.
        _expectSettleRevert(ProvianPVT9.CursorDiscontinuity.selector, 0, policyHash, start + 1);
        _settle(ALICE, _claimId(), 0, policyHash, start + 2);
        assertEq(pvt.nextFinalizedCursor(), start + 3, "the counter never forks per lane");
    }

    // --------------------------------------------------------------------
    // Integration invariant — per-PE claim id stability
    // --------------------------------------------------------------------

    /// Characterization of the hazard the worker must close: the standard lane
    /// dedupes on `claimId` alone and holds no PE identity, so re-settling the
    /// same PE under a freshly derived claim id mints a second time. Nothing
    /// on-chain detects it — claim-id stability is a settler-layer obligation.
    function test_standardLane_freshClaimIdForSameWork_doubleMints() public {
        (bytes32 policyHash, uint256 cursor) = _epochZeroBinding();

        _settle(ALICE, _claimId(), 0, policyHash, cursor);
        assertEq(pvt.balanceOf(ALICE), CONTRIBUTOR_SHARE, "first settlement mints once");

        // Identical recipient and identical points, only the claim id differs.
        _settle(ALICE, _claimId(), 0, policyHash, cursor + 1);
        assertEq(pvt.balanceOf(ALICE), 2 * CONTRIBUTOR_SHARE, "kernel cannot detect the re-derived claim id");
    }

    /// The Genesis lane carries a second, independent net — the typed one-time
    /// anchor — so the same drift is caught on-chain there. Pinning the
    /// asymmetry keeps the worker from assuming the standard lane is covered.
    function test_genesisLane_freshClaimIdIsStillCaughtByTheOneTimeAnchor() public {
        (bytes32 policyHash, uint256 cursor) = _epochZeroBinding();
        bytes32 walletId = keccak256("wallet-1");
        bytes32 anchor = keccak256("anchor-1");

        _settleGenesisAt(BOB, _claimId(), walletId, anchor, 0, policyHash, cursor);
        assertTrue(pvt.genesisAnchorUsed(pvt.genesisAnchorKey(0, anchor)), "anchor is consumed");

        _expectGenesisSettleRevert(
            ProvianPVT9.GenesisAnchorAlreadyUsed.selector, 0, policyHash, cursor + 1, _claimId(), walletId, anchor
        );
    }

    // --------------------------------------------------------------------
    // A3 — claims per transaction are unbounded in the kernel
    // --------------------------------------------------------------------

    /// The kernel's only size bound is `MAX_RECIPIENTS_PER_BATCH`. Claims are
    /// bounded only by the cursor range, so a single recipient may carry more
    /// claims than the entire recipient cap — the un-mineable-batch risk the
    /// settler layer has to bound.
    function test_claimsPerBatch_areNotBoundedByTheRecipientCap() public {
        (bytes32 policyHash, uint256 cursor) = _epochZeroBinding();
        uint256 claimCount = pvt.MAX_RECIPIENTS_PER_BATCH() + 100;

        _settleManyClaims(ALICE, claimCount, policyHash, cursor);

        assertEq(
            pvt.getBatchRecord(_lastBatchId).claimCount,
            claimCount,
            "a batch may carry more claims than the recipient cap"
        );
        assertEq(pvt.getBatchRecord(_lastBatchId).recipientCount, 1, "with a single recipient");
    }

    /// And each additional claim carries an irreducible storage cost, so batch
    /// gas grows without any kernel-side ceiling.
    function test_claimsPerBatch_gasGrowsLinearlyWithNoKernelCeiling() public {
        (bytes32 policyHash, uint256 cursor) = _epochZeroBinding();

        uint256 gasSmall = _settleManyClaims(ALICE, 100, policyHash, cursor);
        uint256 gasLarge = _settleManyClaims(BOB, 600, policyHash, cursor + 100);

        assertGt(gasLarge, gasSmall, "more claims cost more gas");
        uint256 marginalPerClaim = (gasLarge - gasSmall) / 500;
        assertGt(marginalPerClaim, 20_000, "each claim costs at least a cold claim-id write");
    }

    // --------------------------------------------------------------------
    // helpers
    // --------------------------------------------------------------------

    bytes32 private _lastBatchId;

    /// Reads the epoch-zero policy hash and the live cursor in one step.
    function _epochZeroBinding() private view returns (bytes32 policyHash, uint256 cursor) {
        policyHash = pvt.getEpochPolicy(0).policyHash;
        cursor = pvt.nextFinalizedCursor();
    }

    function _oneRecipient(address contributor, uint256 claimCount)
        private
        pure
        returns (ProvianPVT9.StandardRecipient[] memory recipients)
    {
        recipients = new ProvianPVT9.StandardRecipient[](1);
        recipients[0] = ProvianPVT9.StandardRecipient({
            contributor: contributor,
            beneficiaryClass: ProvianPVT9.BeneficiaryClass.HumanResolving,
            claimCount: claimCount
        });
    }

    function _oneClaim(bytes32 claimId) private pure returns (ProvianPVT9.StandardPEClaim[] memory claims) {
        claims = new ProvianPVT9.StandardPEClaim[](1);
        claims[0] = ProvianPVT9.StandardPEClaim({claimId: claimId, recordPointsAtomic: POINTS});
    }

    function _settle(address contributor, bytes32 claimId, uint64 epoch, bytes32 policyHash, uint256 cursor) private {
        _lastBatchId = _batchId();
        vm.prank(MINTER);
        pvt.settleStandardPEBatch(
            _lastBatchId, epoch, policyHash, cursor, cursor + 1, _oneRecipient(contributor, 1), _oneClaim(claimId)
        );
    }

    function _settleManyClaims(address contributor, uint256 claimCount, bytes32 policyHash, uint256 cursor)
        private
        returns (uint256 gasUsed)
    {
        ProvianPVT9.StandardPEClaim[] memory claims = new ProvianPVT9.StandardPEClaim[](claimCount);
        for (uint256 i = 0; i < claimCount; ++i) {
            claims[i] = ProvianPVT9.StandardPEClaim({claimId: _claimId(), recordPointsAtomic: POINTS});
        }
        _lastBatchId = _batchId();

        vm.prank(MINTER);
        uint256 before = gasleft();
        pvt.settleStandardPEBatch(
            _lastBatchId, 0, policyHash, cursor, cursor + claimCount, _oneRecipient(contributor, claimCount), claims
        );
        gasUsed = before - gasleft();
    }

    function _expectSettleRevert(bytes4 selector, uint64 epoch, bytes32 policyHash, uint256 cursor) private {
        _expectSettleRevert(selector, epoch, policyHash, cursor, _claimId());
    }

    function _expectSettleRevert(bytes4 selector, uint64 epoch, bytes32 policyHash, uint256 cursor, bytes32 claimId)
        private
    {
        vm.prank(MINTER);
        vm.expectRevert(selector);
        pvt.settleStandardPEBatch(
            _batchId(), epoch, policyHash, cursor, cursor + 1, _oneRecipient(ALICE, 1), _oneClaim(claimId)
        );
    }

    function _genesisClaim(bytes32 claimId, bytes32 walletId, bytes32 anchor)
        private
        view
        returns (ProvianPVT9.GenesisPEClaim[] memory claims)
    {
        claims = new ProvianPVT9.GenesisPEClaim[](1);
        claims[0] = ProvianPVT9.GenesisPEClaim({
            claimId: claimId,
            walletId: walletId,
            oneTimeAnchor: anchor,
            grantType: pvt.GENESIS_HUMAN_SIGNUP(),
            qualifiedAt: epochStart,
            reservedGrossAtomic: pvt.GENESIS_HUMAN_SIGNUP_GROSS()
        });
    }

    function _genesisRecipient(address contributor)
        private
        pure
        returns (ProvianPVT9.GenesisRecipient[] memory recipients)
    {
        recipients = new ProvianPVT9.GenesisRecipient[](1);
        recipients[0] = ProvianPVT9.GenesisRecipient({contributor: contributor, claimCount: 1});
    }

    function _settleGenesisAt(
        address contributor,
        bytes32 claimId,
        bytes32 walletId,
        bytes32 anchor,
        uint64 epoch,
        bytes32 policyHash,
        uint256 cursor
    ) private {
        _lastBatchId = _batchId();
        // Built before the cheatcode: `_genesisClaim` reads kernel constants
        // externally, which would otherwise consume the prank.
        ProvianPVT9.GenesisRecipient[] memory recipients = _genesisRecipient(contributor);
        ProvianPVT9.GenesisPEClaim[] memory claims = _genesisClaim(claimId, walletId, anchor);

        vm.prank(MINTER);
        pvt.settleGenesisPEBatch(_lastBatchId, epoch, policyHash, cursor, cursor + 1, recipients, claims);
    }

    function _expectGenesisSettleRevert(bytes4 selector, uint64 epoch, bytes32 policyHash, uint256 cursor) private {
        _expectGenesisSettleRevert(
            selector, epoch, policyHash, cursor, _claimId(), keccak256("wallet-x"), keccak256("anchor-x")
        );
    }

    function _expectGenesisSettleRevert(
        bytes4 selector,
        uint64 epoch,
        bytes32 policyHash,
        uint256 cursor,
        bytes32 claimId,
        bytes32 walletId,
        bytes32 anchor
    ) private {
        bytes32 batchId = _batchId();
        ProvianPVT9.GenesisRecipient[] memory recipients = _genesisRecipient(BOB);
        ProvianPVT9.GenesisPEClaim[] memory claims = _genesisClaim(claimId, walletId, anchor);

        vm.prank(MINTER);
        vm.expectRevert(selector);
        pvt.settleGenesisPEBatch(batchId, epoch, policyHash, cursor, cursor + 1, recipients, claims);
    }
}
