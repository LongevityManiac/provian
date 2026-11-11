// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProvianProtocolPointer} from "./ProvianProtocolPointer.sol";
import {FullPrecisionMath} from "./libraries/FullPrecisionMath.sol";
import {ProvianPVT9} from "./ProvianPVT9.sol";
import {RecourseIssuanceTickets} from "./RecourseIssuanceTickets.sol";

interface IMemberContributionCollector {
    function collectMintContribution(address memberAddress, uint256 gross, uint256 minted, uint64 epoch) external;
}

/// @notice Settles the unchanged kernel and collects opted-in contributions atomically.
/// The submitter has no arbitrary-call, approval, withdrawal or token-transfer capability.
contract ProvianMemberSettlement {
    using FullPrecisionMath for uint256;
    ProvianProtocolPointer public immutable pointer;
    ProvianPVT9 public immutable kernel;
    address public immutable submitter;
    IMemberContributionCollector public immutable pool;

    error Unauthorized();
    error InvalidConfiguration();

    constructor(ProvianPVT9 kernel_, address submitter_, IMemberContributionCollector pool_, ProvianProtocolPointer pointer_) {
        if (address(pointer_).code.length == 0) revert InvalidConfiguration();
        pointer = pointer_;
        if (address(kernel_).code.length == 0 || submitter_ == address(0) || address(pool_) == address(0)) {
            revert InvalidConfiguration();
        }
        kernel = kernel_;
        submitter = submitter_;
        pool = pool_;
    }

    /// @notice Wrap the already-approved kernel calldata without changing its
    /// claims or digest. Only the two settlement selectors can reach the kernel;
    /// exact tickets are installed, consumed and closed in this transaction.
    function settleMemberBatch(bytes calldata kernelCall, RecourseIssuanceTickets.IssuanceContext calldata context,
        RecourseIssuanceTickets.IssuanceTicket[] calldata tickets, bytes calldata attestorSignature) external {
        if (msg.sender != submitter) revert Unauthorized();
        pointer.requireCurrent(context.revision, 9, address(this));
        pointer.requireCurrent(context.revision, 0, address(kernel));
        pointer.requireCurrent(context.revision, 8, address(pool));
        if (kernelCall.length < 4 + 7 * 32) revert InvalidConfiguration();
        bytes4 selector = bytes4(kernelCall[:4]);
        if ((context.lane == 0 && selector != ProvianPVT9.settleStandardPEBatch.selector)
            || (context.lane == 1 && selector != ProvianPVT9.settleGenesisPEBatch.selector)
            || context.lane > 1) revert InvalidConfiguration();
        (bytes32 batchId, uint64 epoch, bytes32 policyHash) = abi.decode(kernelCall[4:100], (bytes32, uint64, bytes32));
        if (batchId != context.batchId || epoch != context.epoch || policyHash != context.policyHash) revert InvalidConfiguration();
        RecourseIssuanceTickets ticketPool = RecourseIssuanceTickets(address(pool));
        ticketPool.installIssuanceTickets(context, tickets, attestorSignature);
        (bool success, bytes memory reason) = address(kernel).call(kernelCall);
        if (!success) assembly ("memory-safe") { revert(add(reason, 32), mload(reason)) }
        ProvianPVT9.BatchRecord memory record = kernel.getBatchRecord(batchId);
        if (!record.settled || uint8(record.lane) != context.lane || record.epoch != epoch
            || record.policyHash != policyHash || record.settlementDigest != context.settlementDigest) revert InvalidConfiguration();
        ticketPool.finishIssuanceTickets(batchId);
    }

    function cancelMemberBatch(bytes32 batchId, uint256 revision) external {
        if (msg.sender != submitter) revert Unauthorized();
        pointer.requireCurrent(revision, 9, address(this));
        pointer.requireCurrent(revision, 0, address(kernel));
        pointer.requireCurrent(revision, 8, address(pool));
        if (kernel.getBatchRecord(batchId).settled) revert InvalidConfiguration();
        RecourseIssuanceTickets(address(pool)).cancelIssuanceBatch(batchId, revision);
    }

    function settleStandardPEBatch(
        bytes32 batchId, uint64 epoch, bytes32 policyHash, uint256 cursorStart, uint256 cursorEnd,
        ProvianPVT9.StandardRecipient[] calldata recipients, ProvianPVT9.StandardPEClaim[] calldata requests
    ) external {
        if (msg.sender != submitter) revert Unauthorized();
        uint256 revision = pointer.revision();
        pointer.requireCurrent(revision, 9, address(this));
        pointer.requireCurrent(revision, 0, address(kernel));
        uint256[] memory beforeBalances = new uint256[](recipients.length);
        for (uint256 i; i < recipients.length; ++i) {
            beforeBalances[i] = kernel.balanceOf(recipients[i].contributor);
        }
        kernel.settleStandardPEBatch(batchId, epoch, policyHash, cursorStart, cursorEnd, recipients, requests);
        ProvianPVT9.BatchRecord memory record = kernel.getBatchRecord(batchId);
        ProvianPVT9.EpochPolicy memory policy = kernel.getEpochPolicy(epoch);
        // Capture every mint before collection: a monthly burn may touch a later recipient.
        for (uint256 i; i < recipients.length; ++i) {
            address recipient = recipients[i].contributor;
            beforeBalances[i] = _contributorMint(recipient, beforeBalances[i], record, policy);
        }
        uint256 cursor;
        for (uint256 i; i < recipients.length; ++i) {
            uint256 points;
            for (uint256 j; j < recipients[i].claimCount; ++j) points += requests[cursor++].recordPointsAtomic;
            uint256 gross = points.mulDiv(policy.mintRate, 1 ether);
            pool.collectMintContribution(recipients[i].contributor, gross, beforeBalances[i], epoch);
        }
    }

    function settleGenesisPEBatch(
        bytes32 batchId, uint64 epoch, bytes32 policyHash, uint256 cursorStart, uint256 cursorEnd,
        ProvianPVT9.GenesisRecipient[] calldata recipients, ProvianPVT9.GenesisPEClaim[] calldata requests
    ) external {
        if (msg.sender != submitter) revert Unauthorized();
        uint256 revision = pointer.revision();
        pointer.requireCurrent(revision, 9, address(this));
        pointer.requireCurrent(revision, 0, address(kernel));
        uint256[] memory beforeBalances = new uint256[](recipients.length);
        for (uint256 i; i < recipients.length; ++i) {
            beforeBalances[i] = kernel.balanceOf(recipients[i].contributor);
        }
        kernel.settleGenesisPEBatch(batchId, epoch, policyHash, cursorStart, cursorEnd, recipients, requests);
        ProvianPVT9.BatchRecord memory record = kernel.getBatchRecord(batchId);
        ProvianPVT9.EpochPolicy memory policy = kernel.getEpochPolicy(epoch);
        for (uint256 i; i < recipients.length; ++i) {
            address recipient = recipients[i].contributor;
            beforeBalances[i] = _contributorMint(recipient, beforeBalances[i], record, policy);
        }
        uint256 cursor;
        for (uint256 i; i < recipients.length; ++i) {
            uint256 gross;
            for (uint256 j; j < recipients[i].claimCount; ++j) gross += requests[cursor++].reservedGrossAtomic;
            pool.collectMintContribution(recipients[i].contributor, gross, beforeBalances[i], epoch);
        }
    }

    function _contributorMint(address account, uint256 beforeBalance,
        ProvianPVT9.BatchRecord memory record, ProvianPVT9.EpochPolicy memory policy
    ) private view returns (uint256 amount) {
        amount = kernel.balanceOf(account) - beforeBalance;
        // Protocol allocations remain intact even if their destination also earned work.
        if (account == policy.provianTreasury) amount -= record.provianTotal;
        if (account == policy.foundationTreasury) amount -= record.foundationTotal;
    }
}
