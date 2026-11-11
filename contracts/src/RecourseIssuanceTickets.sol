// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @notice Exact recipient tickets exist only during one settlement transaction.
/// The relay attests the private owner-wide eligibility and rounding remainder;
/// the chain independently bounds diversion by actual gross and contributor mint.
/// No owner total, shared invoice, portfolio identifier or remainder is public.
abstract contract RecourseIssuanceTickets {
    struct IssuanceContext {
        bytes32 batchId; uint8 lane; uint64 epoch; bytes32 policyHash;
        bytes32 settlementDigest; uint256 revision; uint256 month; bytes32 membershipRuleHash;
    }
    struct IssuanceTicket {
        address account; uint256 gross; uint256 contributor; uint256 contribution;
        uint256 consentNonce; bool protectedMember;
    }
    mapping(bytes32 => bool) public cancelledIssuanceBatch;
    bytes32 private constant SPACE = keccak256("Provian atomic issuance tickets");
    error InvalidIssuanceTicket();
    event IssuanceTicketConsumed(bytes32 indexed batchId, uint256 indexed ordinal, address indexed account,
        uint256 gross, uint256 contribution, bytes32 membershipRuleHash);
    event IssuanceBatchCancelled(bytes32 indexed batchId);
    function _issuanceDomain() internal view virtual returns (address pointer, address kernel, address adapter);
    function _issuanceAttestor() internal view virtual returns (address);
    function _issuanceCurrent(uint256 revision) internal view virtual;
    function _issuanceMonth() internal view virtual returns (uint256);
    function _issuanceRule(uint256 month) internal view virtual returns (bytes32 ruleHash, uint16 bps);
    function _issuanceConsent(address account) internal view virtual returns (bool joined, uint256 nonce);
    function _issuanceBatchRecord(bytes32 batchId) internal view virtual returns (bool settled, bytes32 digest);
    function _creditTicketContribution(address account, uint256 contribution) internal virtual;

    function issuanceDigest(IssuanceContext calldata context, IssuanceTicket[] calldata tickets) public view returns (bytes32) {
        (address pointer, address kernel,) = _issuanceDomain();
        return MessageHashUtils.toEthSignedMessageHash(sha256(abi.encode(
            "Provian private membership issuance", block.chainid, pointer, kernel, address(this), context, tickets)));
    }
    function _slot(uint256 field, uint256 index) private pure returns (bytes32) { return keccak256(abi.encode(SPACE, field, index)); }
    function _get(uint256 field, uint256 index) private view returns (uint256 value) {
        bytes32 slot = _slot(field, index); assembly ("memory-safe") { value := tload(slot) }
    }
    function _put(uint256 field, uint256 index, uint256 value) private {
        bytes32 slot = _slot(field, index); assembly ("memory-safe") { tstore(slot, value) }
    }
    function _adapter() private view {
        (,, address adapter) = _issuanceDomain();
        if (msg.sender != adapter) revert InvalidIssuanceTicket();
    }
    /// @dev Adapter calls install -> kernel settlement -> finish atomically.
    /// Transient slots cannot be carried to a later transaction or reused by a
    /// direct kernel caller. The kernel's own batch replay fence remains binding.
    function installIssuanceTickets(IssuanceContext calldata context, IssuanceTicket[] calldata tickets,
        bytes calldata attestorSignature) external {
        _adapter(); _issuanceCurrent(context.revision);
        (bytes32 ruleHash, uint16 bps) = _issuanceRule(context.month);
        (bool alreadySettled,) = _issuanceBatchRecord(context.batchId);
        if (context.batchId == bytes32(0) || context.settlementDigest == bytes32(0) || context.policyHash == bytes32(0)
            || context.lane > 1 || context.month != _issuanceMonth() || context.membershipRuleHash != ruleHash
            || bps > 10000 || tickets.length == 0 || _get(0, 0) != 0 || cancelledIssuanceBatch[context.batchId] || alreadySettled
            || !SignatureChecker.isValidSignatureNow(_issuanceAttestor(), issuanceDigest(context, tickets), attestorSignature)) {
            revert InvalidIssuanceTicket();
        }
        _put(0, 0, uint256(context.batchId)); _put(1, 0, tickets.length); _put(2, 0, 0);
        _put(3, 0, uint256(context.settlementDigest)); _put(4, 0, context.revision);
        _put(5, 0, uint256(ruleHash));
        for (uint256 i; i < tickets.length; ++i) {
            IssuanceTicket calldata ticket = tickets[i];
            (bool joined, uint256 nonce) = _issuanceConsent(ticket.account);
            if (ticket.account == address(0) || ticket.contributor > ticket.gross || ticket.consentNonce != nonce
                || (ticket.protectedMember && !joined)) revert InvalidIssuanceTicket();
            if (!ticket.protectedMember) {
                if (ticket.contribution != 0) revert InvalidIssuanceTicket();
            } else {
                // The private owner remainder chooses floor or ceil by at most
                // one atomic unit. Protocol allocations can never be diverted.
                uint256 fraction = (ticket.gross % 10000) * bps;
                uint256 floor = (ticket.gross / 10000) * bps + fraction / 10000;
                uint256 ceil = floor + (fraction % 10000 == 0 ? 0 : 1);
                if (floor > ticket.contributor) floor = ticket.contributor;
                if (ceil > ticket.contributor) ceil = ticket.contributor;
                if (ticket.contribution < floor || ticket.contribution > ceil) revert InvalidIssuanceTicket();
            }
            _put(10, i, uint160(ticket.account)); _put(11, i, ticket.gross); _put(12, i, ticket.contributor);
            _put(13, i, ticket.contribution); _put(14, i, nonce);
        }
    }
    function _consumeIssuanceTicket(address account, uint256 gross, uint256 contributor) internal returns (uint256 contribution) {
        (, address kernel,) = _issuanceDomain();
        uint256 cursor = _get(2, 0);
        if (msg.sender != kernel || _get(0, 0) == 0 || cursor >= _get(1, 0)) revert InvalidIssuanceTicket();
        _issuanceCurrent(_get(4, 0));
        (, uint256 nonce) = _issuanceConsent(account);
        if (_get(10, cursor) != uint160(account) || _get(11, cursor) != gross || _get(12, cursor) != contributor
            || _get(14, cursor) != nonce) revert InvalidIssuanceTicket();
        contribution = _get(13, cursor);
        _put(2, 0, cursor + 1);
        _creditTicketContribution(account, contribution);
        emit IssuanceTicketConsumed(bytes32(_get(0, 0)), cursor, account, gross, contribution, bytes32(_get(5, 0)));
    }
    function finishIssuanceTickets(bytes32 batchId) external {
        _adapter();
        (bool settled, bytes32 digest) = _issuanceBatchRecord(batchId);
        if (batchId == bytes32(0) || _get(0, 0) != uint256(batchId) || _get(2, 0) != _get(1, 0)
            || !settled || digest != bytes32(_get(3, 0))) revert InvalidIssuanceTicket();
        _issuanceCurrent(_get(4, 0));
        // Clear the active context for another independent batch in this same
        // transaction; its install overwrites every ticket before any callback.
        _put(0, 0, 0);
    }
    /// @notice A finalized cancellation is the private ledger's release proof
    /// for an abandoned batch. A reverted transaction alone proves no such thing.
    function cancelIssuanceBatch(bytes32 batchId, uint256 revision) external {
        _adapter(); _issuanceCurrent(revision);
        (bool settled,) = _issuanceBatchRecord(batchId);
        if (batchId == bytes32(0) || _get(0, 0) != 0 || cancelledIssuanceBatch[batchId] || settled) revert InvalidIssuanceTicket();
        cancelledIssuanceBatch[batchId] = true;
        emit IssuanceBatchCancelled(batchId);
    }
}
