// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProvianProtocolPointer} from "./ProvianProtocolPointer.sol";
import {ProvianPVT9} from "./ProvianPVT9.sol";
import {RecourseIssuanceTickets} from "./RecourseIssuanceTickets.sol";

interface IMemberContributionCollector {
    function collectMintContribution(address memberAddress, uint256 gross, uint256 minted, uint64 epoch) external;
}

/// @notice Settles exact approved kernel calldata with private membership tickets atomically.
/// The submitter has no arbitrary-call, approval, withdrawal or token-transfer capability.
contract ProvianMemberSettlement {
    ProvianProtocolPointer public immutable pointer;
    ProvianPVT9 public immutable kernel;
    address public immutable submitter;
    IMemberContributionCollector public immutable pool;

    bytes32 private constant PROBE_SLOT = keccak256("Provian reverting settlement probe");

    error Unauthorized();
    error InvalidConfiguration();
    error ProbeResult(bool success, bytes result);

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
        if (msg.sender != submitter || probeActive()) revert Unauthorized();
        _validate(kernelCall, context);
        RecourseIssuanceTickets(address(pool)).installIssuanceTickets(context, tickets, attestorSignature);
        _execute(kernelCall, context);
    }

    /// @notice Exercise the actual settlement path without a reusable attestor
    /// authorization. Both successful and failed probes revert all state.
    function probeMemberBatch(bytes calldata kernelCall, RecourseIssuanceTickets.IssuanceContext calldata context,
        RecourseIssuanceTickets.IssuanceTicket[] calldata tickets) external {
        if (msg.sender != submitter) revert Unauthorized();
        (bool success, bytes memory result) = address(this).call(abi.encodeCall(this.executeProbe, (kernelCall, context, tickets)));
        revert ProbeResult(success, result);
    }

    /// @dev Callable only inside probeMemberBatch's unconditionally reverting
    /// frame. Neither the submitter nor any other external caller can commit it.
    function executeProbe(bytes calldata kernelCall, RecourseIssuanceTickets.IssuanceContext calldata context,
        RecourseIssuanceTickets.IssuanceTicket[] calldata tickets) external {
        if (msg.sender != address(this)) revert Unauthorized();
        _validate(kernelCall, context);
        bytes32 slot = PROBE_SLOT;
        assembly ("memory-safe") { tstore(slot, 1) }
        RecourseIssuanceTickets(address(pool)).installIssuanceTickets(context, tickets, hex"");
        _execute(kernelCall, context);
    }

    function probeActive() public view returns (bool active) {
        bytes32 slot = PROBE_SLOT;
        assembly ("memory-safe") { active := tload(slot) }
    }

    function _validate(bytes calldata kernelCall, RecourseIssuanceTickets.IssuanceContext calldata context) private view {
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
    }

    function _execute(bytes calldata kernelCall, RecourseIssuanceTickets.IssuanceContext calldata context) private {
        (bool success, bytes memory reason) = address(kernel).call(kernelCall);
        if (!success) assembly ("memory-safe") { revert(add(reason, 32), mload(reason)) }
        ProvianPVT9.BatchRecord memory record = kernel.getBatchRecord(context.batchId);
        if (!record.settled || uint8(record.lane) != context.lane || record.epoch != context.epoch
            || record.policyHash != context.policyHash || record.settlementDigest != context.settlementDigest) revert InvalidConfiguration();
        RecourseIssuanceTickets(address(pool)).finishIssuanceTickets(context.batchId);
    }

    function cancelMemberBatch(bytes32 batchId, uint256 revision) external {
        if (msg.sender != submitter) revert Unauthorized();
        pointer.requireCurrent(revision, 9, address(this));
        pointer.requireCurrent(revision, 0, address(kernel));
        pointer.requireCurrent(revision, 8, address(pool));
        if (kernel.getBatchRecord(batchId).settled) revert InvalidConfiguration();
        RecourseIssuanceTickets(address(pool)).cancelIssuanceBatch(batchId, revision);
    }

}
