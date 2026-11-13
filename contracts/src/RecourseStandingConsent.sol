// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {RecourseAddressConsent, RecourseAddressConsentState} from "./RecourseAddressConsent.sol";
import {RecourseMembershipRules} from "./RecourseMembershipRules.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ProvianProtocolPointer} from "./ProvianProtocolPointer.sol";

interface IStandingMembershipHost {
    function pointer() external view returns (ProvianProtocolPointer);
    function pvt() external view returns (address);
    function registryOperator() external view returns (address);
    function poolHistoryReady() external view returns (bool);
    function requiresSnapshotRecovery(bytes32) external view returns(bool);
    function consentAccount(bytes32) external view returns (address);
    function addressConsent(bytes32) external view returns (uint256 nonce, uint256 generation, bool joined);
    function debitNonce(bytes32) external view returns (uint256);
    function monthlyRule(uint256) external view returns (RecourseMembershipRules.MonthlyRule memory);
    function calendarMonth(uint256) external pure returns (uint256);
    function applyStandingConsent(bytes32 binding, address account, uint256 nonce, bool joined) external returns (uint256);
    function collectStandingDebit(RecourseAddressConsent.DebitAuthorization calldata debit) external;
}
interface IStandingRestorationAuthority { function restorationAuthority() external view returns (address); }
interface IStandingIdentityAttestor { function identityAttestor() external view returns (address); }
interface IMembershipDepartureAccount {
    function isValidMembershipDepartureSignature(bytes32 digest, bytes calldata proof) external view returns (bytes4);
}

/// @notice Immutable pool companion. One owner approval permits bounded monthly
/// collection; its independent exit preimage only revokes that address's consent.
/// Private owner-wide invoices, earnings and grace remain the attestor's inputs.
contract RecourseStandingConsent {
    using SignatureChecker for address;
    IStandingMembershipHost public immutable pool;
    struct RejoinPayment { uint256 month; uint256 burn; uint256 reserve; bytes32 ruleHash; }
    struct StandingAuthorization {
        RecourseAddressConsent.ConsentAuthorization consent;
        bool fixedChargePayer;
        uint256 burnLimit;
        uint256 reserveLimit;
        uint16 earningsBpsLimit;
        bytes32 exitCommitment;
        bytes32 exitSalt;
        uint256 admissionMonth;
        RejoinPayment[] rejoinPayments;
    }
    mapping(bytes32 => RecourseAddressConsentState.StandingMandate) public standingMandate;
    mapping(bytes32 => mapping(uint256 => RecourseAddressConsentState.MonthlyCollection)) public monthlyCollection;
    error InvalidStandingConsent();
    event StandingConsentApproved(bytes32 indexed binding, uint256 indexed consentNonce,
        uint256 burnLimit, uint256 reserveLimit, uint16 earningsBpsLimit, uint256 startMonth, bytes32 exitCommitment, bytes32 exitSalt);
    event MonthlyCollectionRecorded(bytes32 indexed binding, uint256 indexed month, uint256 burn, uint256 reserve);
    constructor() { pool = IStandingMembershipHost(msg.sender); }
    function _current(uint256 revision) private view {
        if (!pool.poolHistoryReady()) revert InvalidStandingConsent();
        ProvianProtocolPointer pointer = pool.pointer();
        pointer.requireCurrent(revision, 8, address(pool)); pointer.requireCurrent(revision, 0, pool.pvt());
    }
    function _expiry(uint256 expiresAt) private view {
        if (expiresAt < block.timestamp || expiresAt > block.timestamp + 300) revert InvalidStandingConsent();
    }
    function _attestor() private view returns (address attestor) {
        attestor = IStandingIdentityAttestor(pool.registryOperator()).identityAttestor();
        if (attestor == address(0) || attestor == IStandingRestorationAuthority(pool.pvt()).restorationAuthority()) revert InvalidStandingConsent();
    }
    function standingConsentDigest(StandingAuthorization calldata authorization) public view returns (bytes32) {
        return MessageHashUtils.toEthSignedMessageHash(sha256(abi.encode("Provian standing membership consent",
            block.chainid, address(pool.pointer()), pool.pvt(), address(pool), authorization)));
    }
    function debitDigest(RecourseAddressConsent.DebitAuthorization calldata debit) public view returns (bytes32) {
        return MessageHashUtils.toEthSignedMessageHash(sha256(abi.encode("Provian standing membership debit",
            block.chainid, address(pool.pointer()), pool.pvt(), address(pool), debit)));
    }
    function setStandingConsent(StandingAuthorization calldata authorization, bytes calldata ownerSignature,
        bytes calldata attestorSignature) external {
        RecourseAddressConsent.ConsentAuthorization calldata c = authorization.consent;
        _current(c.revision); _expiry(c.expiresAt);
        (uint256 nonce,, bool joined) = pool.addressConsent(c.binding);
        uint256 month = pool.calendarMonth(block.timestamp);
        RecourseMembershipRules.MonthlyRule memory rule = pool.monthlyRule(month);
        address owner = pool.consentAccount(c.binding);
        bytes32 digest = standingConsentDigest(authorization);
        RecourseAddressConsentState.StandingMandate storage previous = standingMandate[c.binding];
        if (authorization.admissionMonth != month || !c.joined || c.binding == bytes32(0) || owner == address(0) || c.account != owner
            || c.nonce != nonce || c.ruleHash != rule.signedRuleHash || authorization.exitCommitment == bytes32(0)
            || authorization.burnLimit != (authorization.fixedChargePayer ? rule.participationBurn : 0)
            || authorization.reserveLimit != (authorization.fixedChargePayer ? rule.noEarningsContribution : 0)
            || authorization.earningsBpsLimit != rule.earningsBps
            || authorization.exitSalt == bytes32(0) || authorization.exitSalt == previous.exitSalt
            || authorization.exitCommitment == previous.exitCommitment
            || !owner.isValidSignatureNow(digest, ownerSignature) || !_attestor().isValidSignatureNow(digest, attestorSignature)) revert InvalidStandingConsent();
        // Historical collection requires this fresh owner approval of every
        // exact amount as well as the attestor's private-calendar verification.
        // A failure rolls back every payment and the admission together.
        _collectRejoin(authorization, month);
        uint256 next = pool.applyStandingConsent(c.binding, owner, nonce, true);
        uint256 start = (joined && previous.exitCommitment != bytes32(0)) || (previous.exitCommitment != bytes32(0)
            && previous.closedMonth + 1 >= month) ? previous.startMonth : month;
        uint256 burn = authorization.fixedChargePayer ? rule.participationBurn : 0;
        uint256 reserve = authorization.fixedChargePayer ? rule.noEarningsContribution : 0;
        standingMandate[c.binding] = RecourseAddressConsentState.StandingMandate(burn, reserve, rule.earningsBps,
            start, 0, next, authorization.exitCommitment, authorization.exitSalt, true);
        emit StandingConsentApproved(c.binding, next, burn, reserve, rule.earningsBps, start, authorization.exitCommitment, authorization.exitSalt);
    }
    function _collectRejoin(StandingAuthorization calldata a, uint256 nowMonth) private {
        if (a.rejoinPayments.length == 0) return;
        (,, bool joined) = pool.addressConsent(a.consent.binding);
        if (joined || !a.fixedChargePayer) revert InvalidStandingConsent();
        (, uint256 generation,) = pool.addressConsent(a.consent.binding);
        for (uint256 i; i < a.rejoinPayments.length; ++i) {
            RejoinPayment calldata payment = a.rejoinPayments[i];
            RecourseMembershipRules.MonthlyRule memory rule = pool.monthlyRule(payment.month);
            RecourseAddressConsentState.MonthlyCollection storage collected = monthlyCollection[a.consent.binding][payment.month];
            if (payment.month >= nowMonth || (i != 0 && payment.month <= a.rejoinPayments[i - 1].month)
                || payment.ruleHash != rule.signedRuleHash || (payment.burn == 0 && payment.reserve == 0)
                || collected.burn + payment.burn > rule.participationBurn) revert InvalidStandingConsent();
            // The flat zero-earnings amount is not a ceiling on a percentage
            // invoice. The independently checked exact net reserve is signed by
            // both owner and attestor; gross earnings remain private.
            collected.burn += payment.burn; collected.reserve += payment.reserve;
            RecourseAddressConsent.DebitAuthorization memory d = RecourseAddressConsent.DebitAuthorization(
                a.consent.binding, a.consent.account, payment.month, payment.burn, payment.reserve,
                pool.debitNonce(a.consent.binding), generation, a.consent.revision, payment.ruleHash, a.consent.expiresAt);
            pool.collectStandingDebit(d);
            emit MonthlyCollectionRecorded(d.binding, d.month, collected.burn, collected.reserve);
        }
    }
    function leaveStandingMembership(bytes32 binding, uint256 consentNonce, bytes32 exitSecret, uint256 revision) external {
        _current(revision);
        RecourseAddressConsentState.StandingMandate storage mandate = standingMandate[binding];
        (uint256 nonce,, bool joined) = pool.addressConsent(binding);
        if (!joined || !mandate.active || nonce != consentNonce || mandate.consentNonce != consentNonce
            || sha256(abi.encodePacked(exitSecret)) != mandate.exitCommitment) revert InvalidStandingConsent();
        mandate.active = false; mandate.closedMonth = pool.calendarMonth(block.timestamp);
        pool.applyStandingConsent(binding, address(0), nonce, false);
    }
    /// @notice A recovered owner can close a suspended mandate without renewing
    /// financial consent. Its old exit preimage remains unusable after a break.
    function authenticatedDepartureDigest(RecourseAddressConsent.ConsentAuthorization calldata c) public view returns (bytes32) {
        return MessageHashUtils.toEthSignedMessageHash(sha256(abi.encode("Provian authenticated membership departure",
            block.chainid, address(pool.pointer()), pool.pvt(), address(pool), c.binding, c.account, c.nonce, false)));
    }
    function leaveSuspendedMembership(RecourseAddressConsent.ConsentAuthorization calldata c, bytes calldata ownerSignature) external {
        // Revocation only: current account, deployment and nonce bind the proof.
        // A delayed sponsor must not require another financial approval to exit.
        _current(c.revision);
        RecourseAddressConsentState.StandingMandate storage mandate = standingMandate[c.binding];
        (uint256 nonce,, bool joined) = pool.addressConsent(c.binding);
        address owner = pool.consentAccount(c.binding);
        if (c.joined || !joined || mandate.active || owner == address(0) || c.account != owner
            || nonce != c.nonce || mandate.consentNonce != nonce
            || !_validDeparture(owner, authenticatedDepartureDigest(c), ownerSignature)) revert InvalidStandingConsent();
        mandate.closedMonth = pool.calendarMonth(block.timestamp);
        pool.applyStandingConsent(c.binding, address(0), nonce, false);
    }
    function _validDeparture(address owner,bytes32 digest,bytes calldata proof) private view returns(bool) {
        if (owner.code.length == 0) return owner.isValidSignatureNow(digest,proof);
        // Dedicated domain: the stable root is never consulted by join/renew.
        bytes memory data=abi.encodeCall(IMembershipDepartureAccount.isValidMembershipDepartureSignature,(digest,proof));
        bool valid;
        assembly ("memory-safe") {
            let ptr:=mload(0x40)
            let ok:=staticcall(gas(),owner,add(data,32),mload(data),ptr,32)
            valid:=and(and(ok,eq(returndatasize(),32)),eq(mload(ptr),shl(224,0x1626ba7e)))
        }
        if(valid)return true;
        return owner.isValidSignatureNow(digest,proof);
    }
    function permitsEarnings(bytes32 binding, uint16 bps) external view returns (bool) {
        RecourseAddressConsentState.StandingMandate storage mandate = standingMandate[binding];
        (uint256 nonce,, bool joined) = pool.addressConsent(binding);
        return joined && mandate.active && mandate.consentNonce == nonce && bps <= mandate.earningsBpsLimit;
    }
    function executeStandingDebit(RecourseAddressConsent.DebitAuthorization calldata d, bytes calldata attestorSignature) external {
        _current(d.revision); _expiry(d.expiresAt);
        (uint256 nonce, uint256 generation, bool joined) = pool.addressConsent(d.binding);
        RecourseAddressConsentState.StandingMandate storage mandate = standingMandate[d.binding];
        uint256 month = pool.calendarMonth(block.timestamp);
        if (!joined || !mandate.active || nonce != mandate.consentNonce || d.generation != generation
            || d.payer != pool.consentAccount(d.binding) || d.payer == address(0) || d.nonce != pool.debitNonce(d.binding)
            || d.month < mandate.startMonth || d.month > month || month - d.month > 1
            || (d.reserve != 0 && d.month == month) || (d.burn == 0 && d.reserve == 0)
            || !_attestor().isValidSignatureNow(debitDigest(d), attestorSignature)) revert InvalidStandingConsent();
        RecourseMembershipRules.MonthlyRule memory rule = pool.monthlyRule(d.month);
        if (d.ruleHash != rule.signedRuleHash || rule.participationBurn > mandate.burnLimit
            || rule.noEarningsContribution > mandate.reserveLimit || rule.earningsBps > mandate.earningsBpsLimit) revert InvalidStandingConsent();
        RecourseAddressConsentState.MonthlyCollection storage collected = monthlyCollection[d.binding][d.month];
        if (collected.burn + d.burn > rule.participationBurn || collected.reserve + d.reserve > rule.noEarningsContribution) revert InvalidStandingConsent();
        collected.burn += d.burn; collected.reserve += d.reserve;
        pool.collectStandingDebit(d);
        emit MonthlyCollectionRecorded(d.binding, d.month, collected.burn, collected.reserve);
    }
    /// @notice Only the pool's authenticated, incomplete snapshot import can
    /// restore a mandate or consumed month. No owner/group identifier is accepted.
    function importState(uint8 kind, bytes calldata data) external returns (bytes32 key) {
        if (msg.sender != address(pool) || pool.poolHistoryReady()) revert InvalidStandingConsent();
        if (kind == 9) {
            (bytes32 binding, RecourseAddressConsentState.StandingMandate memory mandate) = abi.decode(data,
                (bytes32, RecourseAddressConsentState.StandingMandate));
            (uint256 nonce,, bool joined) = pool.addressConsent(binding);
            if (binding == bytes32(0) || mandate.earningsBpsLimit > 10000
                || (mandate.active && (!joined || mandate.consentNonce != nonce || mandate.exitCommitment == bytes32(0) || mandate.exitSalt == bytes32(0)))) revert InvalidStandingConsent();
            // A discarded post-cutoff exit may have exposed this preimage.
            // Recovery renews independent exit material before automatic debits resume.
            if (pool.requiresSnapshotRecovery(binding)) mandate.active = false;
            standingMandate[binding] = mandate; return sha256(abi.encode(kind, abi.encode(binding)));
        }
        if (kind == 10) {
            (bytes32 binding, uint256 month, RecourseAddressConsentState.MonthlyCollection memory collected) = abi.decode(data,
                (bytes32, uint256, RecourseAddressConsentState.MonthlyCollection));
            if (binding == bytes32(0) || (collected.burn == 0 && collected.reserve == 0)) revert InvalidStandingConsent();
            monthlyCollection[binding][month] = collected; return sha256(abi.encode(kind, abi.encode(binding, month)));
        }
        revert InvalidStandingConsent();
    }
}
