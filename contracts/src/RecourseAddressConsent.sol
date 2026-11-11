// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @notice Public state describes one address's consent, never an owner's bill.
abstract contract RecourseAddressConsentState {
    struct AddressConsent {
        uint256 nonce;
        uint256 generation;
        bool joined;
    }
    struct ConsentPeriod { uint256 startBlock; uint256 endBlock; }
    mapping(bytes32 => AddressConsent) public addressConsent;
    mapping(bytes32 => mapping(uint256 => ConsentPeriod)) public consentPeriods;
    mapping(bytes32 => uint256) public debitNonce;
}

/// @notice Owner-wide invoices, earnings, grace and portfolio links stay private.
/// An eligibility attestor has no wallet-debit authority: each debit additionally
/// requires the owner's exact payer, month, amounts and one-use nonce mandate.
abstract contract RecourseAddressConsent is RecourseAddressConsentState {
    struct ConsentAuthorization {
        bytes32 binding; address account; uint256 nonce; bool joined;
        uint256 revision; bytes32 ruleHash; uint256 expiresAt;
    }
    struct DebitAuthorization {
        bytes32 binding; address payer; uint256 month; uint256 burn; uint256 reserve;
        uint256 nonce; uint256 generation; uint256 revision; bytes32 ruleHash; uint256 expiresAt;
    }
    error InvalidAddressConsent();
    event AddressConsentChanged(bytes32 indexed binding, uint256 indexed generation, bool joined, uint256 nonce);
    event MembershipDebitExecuted(bytes32 indexed digest, bytes32 indexed binding, address indexed payer,
        uint256 month, uint256 burn, uint256 reserve, uint256 nonce);
    event MembershipDebitCancelled(bytes32 indexed binding, uint256 indexed nonce);

    function _consentOwner(bytes32 binding) internal virtual returns (address);
    function _consentAttestor() internal view virtual returns (address);
    function _consentDomain() internal view virtual returns (address pointer, address kernel);
    function _consentCurrent(uint256 revision) internal view virtual;
    function _consentRule(uint256 month) internal view virtual returns (bytes32 ruleHash);
    function _consentMonth() internal view virtual returns (uint256);
    function _executeMembershipDebit(bytes32 binding, address payer, uint256 burn, uint256 reserve) internal virtual;

    function consentDigest(ConsentAuthorization calldata consent) public view returns (bytes32) {
        (address pointer, address kernel) = _consentDomain();
        return MessageHashUtils.toEthSignedMessageHash(sha256(abi.encode(
            "Provian address membership consent", block.chainid, pointer, kernel, address(this), consent)));
    }
    function debitDigest(DebitAuthorization calldata debit) public view returns (bytes32) {
        (address pointer, address kernel) = _consentDomain();
        return MessageHashUtils.toEthSignedMessageHash(sha256(abi.encode(
            "Provian exact membership debit", block.chainid, pointer, kernel, address(this), debit)));
    }
    function _signature(address signer, bytes32 digest, bytes calldata signature) private view returns (bool) {
        return signer != address(0) && SignatureChecker.isValidSignatureNow(signer, digest, signature);
    }
    function _expiry(uint256 expiresAt) private view {
        if (expiresAt < block.timestamp || expiresAt > block.timestamp + 300) revert InvalidAddressConsent();
    }
    /// @notice A common sponsor may submit independent consents. The payload
    /// includes no private owner, sibling, billing-address or invoice reference.
    function setAddressConsent(ConsentAuthorization calldata consent, bytes calldata ownerSignature,
        bytes calldata attestorSignature) external {
        _consentCurrent(consent.revision); _expiry(consent.expiresAt);
        address owner = _consentOwner(consent.binding);
        AddressConsent storage current = addressConsent[consent.binding];
        bytes32 digest = consentDigest(consent);
        if (consent.binding == bytes32(0) || owner == address(0) || consent.account != owner
            || consent.nonce != current.nonce || consent.joined == current.joined
            || consent.ruleHash != _consentRule(_consentMonth())
            || !_signature(owner, digest, ownerSignature)
            || !_signature(_consentAttestor(), digest, attestorSignature)) revert InvalidAddressConsent();
        ++current.nonce;
        current.joined = consent.joined;
        if (consent.joined) {
            ++current.generation;
            consentPeriods[consent.binding][current.generation] = ConsentPeriod(block.number, 0);
        } else {
            consentPeriods[consent.binding][current.generation].endBlock = block.number;
            // Any signed, unexecuted invoice for the former period is revoked.
            ++debitNonce[consent.binding];
        }
        emit AddressConsentChanged(consent.binding, current.generation, consent.joined, consent.nonce);
    }
    /// @notice Exact authorization, not a standing debit mandate. Allowance alone,
    /// an attestor signature alone, or a changed payer/amount can never collect.
    function executeMembershipDebit(DebitAuthorization calldata debit, bytes calldata ownerSignature,
        bytes calldata attestorSignature) external {
        _consentCurrent(debit.revision); _expiry(debit.expiresAt);
        address owner = _consentOwner(debit.binding);
        AddressConsent storage current = addressConsent[debit.binding];
        bytes32 digest = debitDigest(debit);
        uint256 nowMonth = _consentMonth();
        if (debit.binding == bytes32(0) || owner == address(0) || debit.payer != owner
            || !current.joined || debit.generation != current.generation || debit.nonce != debitNonce[debit.binding]
            || debit.month > nowMonth || nowMonth - debit.month > 1 || debit.ruleHash != _consentRule(debit.month)
            || (debit.burn == 0 && debit.reserve == 0) || !_signature(owner, digest, ownerSignature)
            || !_signature(_consentAttestor(), digest, attestorSignature)) revert InvalidAddressConsent();
        ++debitNonce[debit.binding];
        _executeMembershipDebit(debit.binding, owner, debit.burn, debit.reserve);
        emit MembershipDebitExecuted(digest, debit.binding, owner, debit.month, debit.burn, debit.reserve, debit.nonce);
    }
    /// @notice Cancel before selecting another payer. A cancelled or consumed
    /// nonce cannot later debit the old payer, even if a sponsor retained bytes.
    function cancelMembershipDebit(bytes32 binding, uint256 expectedNonce) external {
        address owner = _consentOwner(binding);
        if (owner == address(0) || msg.sender != owner || debitNonce[binding] != expectedNonce) revert InvalidAddressConsent();
        ++debitNonce[binding];
        emit MembershipDebitCancelled(binding, expectedNonce);
    }
}
