// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ProvianPVT9} from "./ProvianPVT9.sol";
import {ProvianProtocolPointer} from "./ProvianProtocolPointer.sol";
import {ProvianRestorationAuthorization} from "./ProvianRestorationAuthorization.sol";
import {RecoursePoolHistory} from "./RecoursePoolHistory.sol";
import {RecourseAddressConsent} from "./RecourseAddressConsent.sol";
import {RecourseIssuanceTickets} from "./RecourseIssuanceTickets.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {RecourseReserveAccounting, IRecourseReserveToken} from "./RecourseReserveAccounting.sol";
import {ProvianMemberSettlement, IMemberContributionCollector} from "./ProvianMemberSettlement.sol";

interface IRecourseIdentityAttestor { function identityAttestor() external view returns (address); }
interface IPreviousRecoursePool { function pvt() external view returns (address); }
interface IRecourseKernelAuthority {
    function restorationAuthority() external view returns (address);
    function ownerAuthorization() external view returns (ProvianRestorationAuthorization);
}
/// @notice Members' discretionary risk-sharing reserve. Contributions are not
/// refundable. Allocated restoration withdrawal works directly on-chain, without
/// the relay or a live restoration authority. There is no admin or surplus exit.
contract ProvianMemberRecoursePool is RecoursePoolHistory, RecourseAddressConsent, RecourseIssuanceTickets {
    ProvianPVT9 public immutable token;
    ProvianMemberSettlement public immutable settlement;
    ProvianProtocolPointer public immutable pointer;
    address public immutable registryOperator;
    address public immutable bootstrapAdmin;
    error Unauthorized();
    error InvalidInput();
    event RestorationDetermined(bytes32 indexed request, bytes32 indexed identity, bytes32 indexed occurrence, bool accepted, uint256 shortfall, bytes32 evidenceHash, uint256 revision);
    struct Determination { bytes32 request; bytes32 identity; bytes32 occurrence; uint256 shortfall; bytes32 evidenceHash; uint256 expectedRevision; uint256 membershipGeneration; uint256 lossBlock; uint256 lossMonth; }

    /// @notice Uniform custody-token accessor used by institution migration.
    function pvt() external view returns (address) { return address(token); }

    constructor(ProvianPVT9 token_, address operator_, address submitter_, ProvianProtocolPointer pointer_, MonthlyRule memory initialRule, PoolSnapshot memory snapshot)
        RecoursePoolHistory(IRecourseReserveToken(address(token_)), snapshot) {
        if (address(token_).code.length == 0 || operator_ == address(0) || address(pointer_).code.length == 0) revert InvalidInput();
        token = token_; pointer = pointer_; registryOperator = operator_; bootstrapAdmin = token_.BOOTSTRAP_ADMIN();
        settlement = new ProvianMemberSettlement(token_, submitter_, IMemberContributionCollector(address(this)), pointer_);
        if (snapshot.entries == 0) {
            if (initialRule.firstMonth != 0) revert InvalidInput();
            _scheduleMonthlyRule(initialRule, calendarMonth(block.timestamp));
        } else {
            ProvianRestorationAuthorization authorization = IRecourseKernelAuthority(address(token_)).ownerAuthorization();
            if (snapshot.afterBreak != authorization.cryptographicBreak() || snapshot.blockNumber != authorization.lastGoodBlock()
                || pointer_.component(8) != snapshot.predecessor
                || IPreviousRecoursePool(snapshot.predecessor).pvt() != authorization.predecessor()) revert InvalidInput();
        }
    }
    function bind(bytes32 identity, address account) external historyReady {
        if (msg.sender != registryOperator) revert Unauthorized();
        if (identity == bytes32(0) || account == address(0) || (ownerOf[account] != bytes32(0) && ownerOf[account] != identity)) revert InvalidInput();
        if (requiresSnapshotRecovery[identity]) {
            ProvianRestorationAuthorization auth = IRecourseKernelAuthority(address(token)).ownerAuthorization();
            if (!auth.restoredIdentity(identity) || auth.recoveredDestination(identity) != account) revert InvalidInput();
            requiresSnapshotRecovery[identity] = false;
        }
        ownerOf[account] = identity;
        if (primaryAddress[identity] == address(0)) primaryAddress[identity] = account;
        _syncRecovery(identity);
        emit AddressBound(identity, account);
    }
    function _syncRecovery(bytes32 identity) private {
        ProvianRestorationAuthorization authorization = IRecourseKernelAuthority(address(token)).ownerAuthorization();
        if (requiresSnapshotRecovery[identity]) {
            if (!authorization.restoredIdentity(identity)) revert InvalidInput();
            requiresSnapshotRecovery[identity] = false;
        }
        uint256 nonce = authorization.ownerAuthorizationNonce(identity);
        if (nonce <= recoveryNonce[identity]) return;
        address destination = authorization.recoveredDestination(identity);
        if (destination == address(0) || (ownerOf[destination] != bytes32(0) && ownerOf[destination] != identity)) revert InvalidInput();
        primaryAddress[identity] = destination;
        if (ownerOf[destination] == bytes32(0)) emit AddressBound(identity, destination);
        ownerOf[destination] = identity;
        recoveryNonce[identity] = nonce;
    }
    function _owner(bytes32 identity) private {
        _syncRecovery(identity);
        if (identity == bytes32(0) || msg.sender != primaryAddress[identity]) revert Unauthorized();
    }
    function _active() private view {
        uint256 revision = pointer.revision();
        pointer.requireCurrent(revision, 8, address(this));
        pointer.requireCurrent(revision, 0, address(token));
    }
    function scheduleMembershipRule(MonthlyRule calldata rule) external historyReady {
        if (msg.sender != bootstrapAdmin) revert Unauthorized();
        _scheduleMonthlyRule(rule, calendarMonth(block.timestamp));
    }
    function _identityAttestor() private view returns (address attestor) {
        attestor = IRecourseIdentityAttestor(registryOperator).identityAttestor();
        if (attestor == address(0) || attestor == IRecourseKernelAuthority(address(token)).restorationAuthority()) revert InvalidInput();
    }
    function _consentOwner(bytes32 binding) internal override returns (address) {
        if (!poolHistoryReady) revert InvalidPoolHistory();
        _syncRecovery(binding);
        return primaryAddress[binding];
    }
    /// @notice The effective signer, including recovery not yet synchronized by
    /// a pool write. A snapshot awaiting owner recovery has no active signer.
    function consentAccount(bytes32 binding) external view returns (address) {
        if (!poolHistoryReady) revert InvalidPoolHistory();
        ProvianRestorationAuthorization auth = IRecourseKernelAuthority(address(token)).ownerAuthorization();
        if (requiresSnapshotRecovery[binding] && !auth.restoredIdentity(binding)) return address(0);
        if (auth.ownerAuthorizationNonce(binding) > recoveryNonce[binding]) return auth.recoveredDestination(binding);
        return primaryAddress[binding];
    }
    function _consentAttestor() internal view override returns (address) { return _identityAttestor(); }
    function _consentDomain() internal view override returns (address, address) { return (address(pointer), address(token)); }
    function _consentCurrent(uint256 revision) internal view override {
        if (!poolHistoryReady) revert InvalidPoolHistory();
        pointer.requireCurrent(revision, 8, address(this)); pointer.requireCurrent(revision, 0, address(token));
    }
    function _consentRule(uint256 month) internal view override returns (bytes32) { return monthlyRule(month).signedRuleHash; }
    function _consentMonth() internal view override returns (uint256) { return calendarMonth(block.timestamp); }
    function _executeMembershipDebit(bytes32 binding, address payer, uint256 burn, uint256 reserve) internal override {
        if (burn != 0) {
            uint256 beforeBalance = token.balanceOf(payer);
            uint256 beforeSupply = token.totalSupply();
            token.burnFrom(payer, burn);
            if (token.balanceOf(payer) + burn != beforeBalance || token.totalSupply() + burn != beforeSupply) revert InvalidInput();
        }
        if (reserve != 0) _contributeReserve(binding, payer, reserve);
    }
    function _issuanceDomain() internal view override returns (address, address, address) {
        return (address(pointer), address(token), address(settlement));
    }
    function _issuanceAttestor() internal view override returns (address) { return _identityAttestor(); }
    function _issuanceCurrent(uint256 revision) internal view override {
        if (!poolHistoryReady) revert InvalidPoolHistory();
        pointer.requireCurrent(revision, 8, address(this)); pointer.requireCurrent(revision, 0, address(token));
        pointer.requireCurrent(revision, 9, address(settlement));
    }
    function _issuanceMonth() internal view override returns (uint256) { return calendarMonth(block.timestamp); }
    function _issuanceRule(uint256 month) internal view override returns (bytes32, uint16) {
        MonthlyRule memory rule = monthlyRule(month); return (rule.signedRuleHash, rule.earningsBps);
    }
    function _issuanceConsent(address account) internal view override returns (bool, uint256) {
        AddressConsent storage consent = addressConsent[ownerOf[account]];
        return (consent.joined, consent.nonce);
    }
    function _issuanceBatchRecord(bytes32 batchId) internal view override returns (bool, bytes32) {
        ProvianPVT9.BatchRecord memory record = token.getBatchRecord(batchId);
        return (record.settled, record.settlementDigest);
    }
    function _creditTicketContribution(address account, uint256 amount) internal override {
        if (amount != 0) _creditIssuanceReserve(ownerOf[account], amount);
    }
    /// @notice The kernel callback consumes the installed exact ticket before
    /// issuing the contributor share. There is no allowance-based issuance path.
    function divertIssuance(address account, uint256 gross, uint256 contributorAmount) external historyReady returns (uint256) {
        return _consumeIssuanceTicket(account, gross, contributorAmount);
    }

    struct LossEligibility {
        Determination determination; bytes32 ruleHash;
        uint256 admissionLogIndex; uint256 lossLogIndex; uint256 closureLogIndex;
    }
    mapping(bytes32 => bool) public approvedLossEligibility;
    event LossEligibilityAdmitted(bytes32 indexed request, bytes32 indexed binding, bytes32 digest);
    function lossEligibilityDigest(LossEligibility calldata evidence) public view returns (bytes32) {
        return MessageHashUtils.toEthSignedMessageHash(sha256(abi.encode("Provian private membership at loss",
            block.chainid, address(pointer), address(token), address(this), evidence)));
    }
    /// @notice The independent attestor checks the private owner calendar and
    /// original canonical consent/binding/loss positions. It cannot allocate
    /// reserves, replace an owner proof, or change a reversal outcome.
    function admitLossEligibility(LossEligibility calldata evidence, bytes calldata signature) external historyReady {
        _active();
        Determination calldata d = evidence.determination;
        ConsentPeriod storage period = consentPeriods[d.identity][d.membershipGeneration];
        if (d.request == bytes32(0) || d.identity == bytes32(0) || d.occurrence == bytes32(0) || d.evidenceHash == bytes32(0)
            || period.startBlock == 0 || d.lossBlock < period.startBlock || d.lossBlock >= block.number
            || (d.lossBlock == period.startBlock && evidence.lossLogIndex <= evidence.admissionLogIndex)
            || (period.endBlock != 0 && (d.lossBlock > period.endBlock
                || (d.lossBlock == period.endBlock && evidence.lossLogIndex >= evidence.closureLogIndex)))
            || (period.endBlock == 0 && evidence.closureLogIndex != 0)
            || d.lossMonth > calendarMonth(block.timestamp) || evidence.ruleHash != monthlyRule(d.lossMonth).signedRuleHash
            || !SignatureChecker.isValidSignatureNow(_identityAttestor(), lossEligibilityDigest(evidence), signature)) revert InvalidInput();
        approvedLossEligibility[sha256(abi.encode(d))] = true;
        emit LossEligibilityAdmitted(d.request, d.identity, lossEligibilityDigest(evidence));
    }
    function withdrawRestoration(bytes32 request, bytes32 identity) external historyReady returns (uint256) {
        _owner(identity);
        return _withdrawRestoration(request, identity, msg.sender);
    }
    /// @notice Anyone can finish an allocated restoration, solely to the
    /// independently recovered owner. No new member signature or arbitrary
    /// destination is accepted; the owner retains the direct withdrawal path.
    function deliverRestoration(bytes32 request, bytes32 identity) external historyReady returns (uint256) {
        _active(); _syncRecovery(identity);
        return _withdrawRestoration(request, identity, primaryAddress[identity]);
    }
    function _authority() private view {
        if (msg.sender != IRecourseKernelAuthority(address(token)).restorationAuthority()) revert Unauthorized();
    }
    function determine(Determination[] calldata accepted) external historyReady {
        _active(); _authority();
        bytes32[] memory requests = new bytes32[](accepted.length);
        bytes32[] memory identities = new bytes32[](accepted.length);
        uint256[] memory shortfalls = new uint256[](accepted.length);
        for (uint256 i; i < accepted.length; ++i) {
            Determination calldata d = accepted[i];
            if (d.shortfall == 0) revert InvalidInput();
            _record(d, true);
            requests[i] = d.request; identities[i] = d.identity; shortfalls[i] = d.shortfall;
        }
        _allocateRestorations(requests, identities, shortfalls);
    }
    /// @notice A complete reversal is an accepted determination with no reserve
    /// allocation. Record its occurrence so it cannot later be reopened.
    function recordReversalOnly(Determination calldata d) external historyReady {
        _active(); _authority();
        if (d.shortfall != 0) revert InvalidInput();
        _record(d, true);
    }
    function decline(Determination calldata d) external historyReady { _active(); _authority(); _record(d, false); }
    function _record(Determination calldata d, bool accepted) private {
        if (d.request == bytes32(0) || d.identity == bytes32(0) || primaryAddress[d.identity] == address(0)
            || d.occurrence == bytes32(0) || d.evidenceHash == bytes32(0) || determined[d.request]
            || occurrenceDetermined[d.identity][d.occurrence] || outcomeRevision[d.identity] != d.expectedRevision) revert InvalidInput();
        if (!IRecourseKernelAuthority(address(token)).ownerAuthorization().reversalHistoryReady()) revert InvalidInput();
        if (accepted) {
            _syncRecovery(d.identity);
            ProvianRestorationAuthorization authorization = IRecourseKernelAuthority(address(token)).ownerAuthorization();
            bytes32 outcome = sha256(abi.encode(d.request, d.identity, primaryAddress[d.identity], d.shortfall, d.evidenceHash));
            if (!approvedLossEligibility[sha256(abi.encode(d))] || authorization.reversalOutcome(d.request) != outcome) revert InvalidInput();
        }
        determined[d.request] = true; occurrenceDetermined[d.identity][d.occurrence] = true;
        emit RestorationDetermined(d.request, d.identity, d.occurrence, accepted, d.shortfall, d.evidenceHash, ++outcomeRevision[d.identity]);
    }
    function calendarMonth(uint256 timestamp) public pure returns (uint256) {
        uint256 z = timestamp / 1 days + 719468;
        uint256 era = z / 146097;
        uint256 doe = z - era * 146097;
        uint256 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        uint256 year = yoe + era * 400;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        uint256 month = mp < 10 ? mp + 3 : mp - 9;
        if (month <= 2) ++year;
        return year * 12 + month - 1;
    }
}
