// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ProvianPVT9} from "./ProvianPVT9.sol";
import {ProvianProtocolPointer} from "./ProvianProtocolPointer.sol";
import {ProvianRestorationAuthorization} from "./ProvianRestorationAuthorization.sol";
import {RecoursePoolHistory} from "./RecoursePoolHistory.sol";
import {RecourseMonthlyAccounting} from "./RecourseMonthlyAccounting.sol";
import {RecourseReserveAccounting, IRecourseReserveToken} from "./RecourseReserveAccounting.sol";
import {ProvianMemberSettlement, IMemberContributionCollector} from "./ProvianMemberSettlement.sol";

interface IPreviousRecoursePool { function pvt() external view returns (address); }
interface IRecourseKernelAuthority {
    function restorationAuthority() external view returns (address);
    function ownerAuthorization() external view returns (ProvianRestorationAuthorization);
}
/// @notice Members' discretionary risk-sharing reserve. Contributions are not
/// refundable. Allocated restoration withdrawal works directly on-chain, without
/// the relay or a live restoration authority. There is no admin or surplus exit.
contract ProvianMemberRecoursePool is RecoursePoolHistory, IMemberContributionCollector {
    ProvianPVT9 public immutable token;
    ProvianMemberSettlement public immutable settlement;
    ProvianProtocolPointer public immutable pointer;
    address public immutable registryOperator;
    address public immutable bootstrapAdmin;
    error Unauthorized();
    error InvalidInput();
    event MembershipChanged(bytes32 indexed identity, bool joined, uint256 generation, uint256 month);
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
    function enroll(bytes32 identity) external historyReady {
        _active(); _owner(identity);
        uint256 month = calendarMonth(block.timestamp);
        _joinMonthly(identity, month);
        membershipPeriods[identity][enrollment[identity].generation] = MembershipPeriod(block.number, 0, month);
        _collect(identity, month);
        emit MembershipChanged(identity, true, enrollment[identity].generation, month);
    }
    function leave(bytes32 identity) external historyReady {
        _owner(identity);
        if (membershipPeriods[identity][enrollment[identity].generation].endBlock != 0) revert InvalidInput();
        uint256 month = calendarMonth(block.timestamp);
        _collect(identity, month);
        _closeMembership(identity, month);
    }
    function _closeMembership(bytes32 identity, uint256 month) private {
        uint256 generation = enrollment[identity].generation;
        if (generation == 0 || membershipPeriods[identity][generation].endBlock != 0) return;
        _leaveMonthly(identity, month);
        membershipPeriods[identity][generation].endBlock = block.number;
        emit MembershipChanged(identity, false, generation, month);
    }
    function scheduleMembershipRule(MonthlyRule calldata rule) external historyReady {
        if (msg.sender != bootstrapAdmin) revert Unauthorized();
        _scheduleMonthlyRule(rule, calendarMonth(block.timestamp));
    }
    function settleMonth(bytes32 identity) external historyReady {
        _syncRecovery(identity);
        _collect(identity, calendarMonth(block.timestamp));
    }
    function membershipState(bytes32 identity) external view returns (bool protectedNow, bool grace, uint256 generation, uint256 endMonthExclusive) {
        uint256 month = calendarMonth(block.timestamp);
        Enrollment storage e = enrollment[identity];
        (protectedNow, grace, endMonthExclusive) = _monthlyStatus(identity, month);
        return (protectedNow, grace, e.generation, endMonthExclusive);
    }
    /// @notice Kernel diverts from actual issuance before it reaches any bound
    /// wallet. No allowance or primary-address balance can defeat this diversion.
    function divertIssuance(address account, uint256 gross, uint256 contributorAmount) external historyReady returns (uint256 diverted) {
        if (msg.sender != address(token)) revert Unauthorized();
        bytes32 identity = ownerOf[account];
        if (identity == bytes32(0)) return 0;
        uint256 month = calendarMonth(block.timestamp);
        uint256 due = _recordMonthlyEarnings(identity, month, gross);
        diverted = due < contributorAmount ? due : contributorAmount;
        if (diverted != 0) {
            _creditIssuanceReserve(identity, diverted);
            _creditMonthly(identity, month, month, 0, diverted);
        }
    }
    function collectMintContribution(address account, uint256, uint256, uint64) external historyReady {
        if (msg.sender != address(settlement)) revert Unauthorized();
        bytes32 identity = ownerOf[account];
        if (identity == bytes32(0)) return;
        _syncRecovery(identity);
        _collect(identity, calendarMonth(block.timestamp));
    }
    function _collect(bytes32 identity, uint256 month) private {
        _assessMonthly(identity, month);
        if (!_protectedMonthly(identity, month)) return;
        Enrollment storage e = enrollment[identity];
        for (uint256 m = e.firstUnpaidMonth; m <= month; ++m) _collectInvoice(identity, month, m);
    }
    function _collectInvoice(bytes32 identity, uint256 nowMonth, uint256 month) private {
        address payer = primaryAddress[identity];
        MonthlyObligation storage o = obligations[identity][enrollment[identity].generation][month];
        uint256 burn = o.burnDue - o.burnPaid;
        if (burn != 0 && token.balanceOf(payer) >= burn && token.allowance(payer, address(this)) >= burn) {
            token.burnFrom(payer, burn);
            _creditMonthly(identity, nowMonth, month, burn, 0);
        }
        uint256 reserve = o.reserveDue - o.reservePaid;
        if (reserve != 0 && token.balanceOf(payer) >= reserve && token.allowance(payer, address(this)) >= reserve) {
            _contributeReserve(identity, payer, reserve);
            _creditMonthly(identity, nowMonth, month, 0, reserve);
        }
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
            if (!_memberAtLoss(d) || authorization.reversalOutcome(d.request) != outcome) revert InvalidInput();
        }
        determined[d.request] = true; occurrenceDetermined[d.identity][d.occurrence] = true;
        emit RestorationDetermined(d.request, d.identity, d.occurrence, accepted, d.shortfall, d.evidenceHash, ++outcomeRevision[d.identity]);
    }
    function _memberAtLoss(Determination calldata d) private view returns (bool) {
        MembershipPeriod storage period = membershipPeriods[d.identity][d.membershipGeneration];
        if (period.startBlock == 0 || d.lossBlock < period.startBlock || d.lossBlock >= block.number
            || (period.endBlock != 0 && d.lossBlock > period.endBlock)
            || d.lossMonth < period.startMonth || d.lossMonth > calendarMonth(block.timestamp)) return false;
        // At most one unpaid prior calendar month is within grace. Payments cannot
        // be credited after expiry by the monthly accounting module.
        for (uint256 m = period.startMonth; m + 1 < d.lossMonth; ++m) {
            MonthlyObligation storage o = obligations[d.identity][d.membershipGeneration][m];
            if (!o.initialized || o.burnPaid != o.burnDue
                || o.reservePaid != (o.earnings ? o.reserveDue : o.noEarningsAmount)) return false;
        }
        return true;
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
