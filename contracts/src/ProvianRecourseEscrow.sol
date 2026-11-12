// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {RecourseInstitutionSeeds} from "./RecourseInstitutionSeeds.sol";

/// @notice Successor institution with explicit PVT custody obligations.
/// Direct donations do not increase obligations; recorded exits remain backed.

import {IERC20} from "./interfaces/IERC20.sol";
import {IPVTBurnable} from "./interfaces/IPVTBurnable.sol";
import {IEpochClock} from "./interfaces/IEpochClock.sol";
import {IIssuanceIndex} from "./interfaces/IIssuanceIndex.sol";

interface IArbitratorRewardSink {
    function fundEscrowDisputeReward(bytes32 escrowId, uint256 amount) external;
}

contract ProvianRecourseEscrow is RecourseInstitutionSeeds {

    string public constant VERSION = "v4";

    enum Currency {
        USDC,   
        PVT     
    }

    enum Status {
        Created,    
        Funded,     
        Completed,  
        Disputed,   
        Resolved,   
        Cancelled   
    }

    struct Escrow {
        address depositor;
        address recipient;
        uint256 amount;
        uint256 fee;
        uint256 autoReleaseAt;
        Status status;
        Currency currency;
        bool feePaidInPVT;
    }

    struct ScheduledUint256 {
        bool exists;
        uint256 value;
    }

    mapping(bytes32 => Escrow) public escrows;
    address public admin;
    address public feeWallet;
    IERC20 public usdc;
    IPVTBurnable public pvt;

    address public courtContract;
    bool private courtContractSet;

    IEpochClock public immutable epochClock;

    IIssuanceIndex public immutable issuanceIndex;

    uint256 public constant INDEX_PPM_DENOMINATOR = 1_000_000;

    uint256 public constant DISPUTE_ADJUDICATION_FEE_BASELINE = 30e18;

    uint256 public constant DISPUTE_ADJUDICATION_FEE_INDEX_PPM = 3;

    uint256 public constant DISPUTE_RESOLUTION_TIMEOUT = 30 days;

    mapping(bytes32 => uint256) public disputeDeadline;

    mapping(bytes32 => uint256) public disputeSettledAt;

    struct EscrowSeed {
        bytes32 escrowId;
        address depositor;
        address recipient;
        uint256 amount;
        uint256 fee;
        uint256 autoReleaseAt;
        Currency currency;
    }

    mapping(bytes32 => uint256) public pendingWithdrawal;
    mapping(bytes32 => address) public pendingBeneficiary;

    uint256 public encumberedPVT;

    uint256 public constant FEE_BPS_MAX = 1_000;
    mapping(uint64 => ScheduledUint256) public scheduledFeeBps;

    uint64[] public feeBpsEpochs;

    uint256 public constant PRINCIPAL_CAP_MIN = 1e18;
    uint256 public constant PRINCIPAL_CAP_MAX = 1_000_000e18;
    mapping(uint64 => ScheduledUint256) public scheduledPrincipalCap;

    uint64[] public principalCapEpochs;

    uint256 public constant AUTO_RELEASE_PERIOD_MIN = 1 hours; 
    uint256 public constant AUTO_RELEASE_PERIOD_MAX = 90 days; 
    uint256 public constant AGREEMENT_DEADLINE_MIN = 1 hours; 
    uint256 public constant AGREEMENT_DEADLINE_MAX = 90 days; 
    mapping(uint64 => ScheduledUint256) public scheduledAutoReleasePeriod;

    uint64[] public autoReleasePeriodEpochs;
    mapping(uint64 => ScheduledUint256) public scheduledAgreementDeadline;

    uint64[] public agreementDeadlineEpochs;

    uint256 public constant DISPUTE_TIMEOUT_MIN = 2 days; 
    uint256 public constant DISPUTE_TIMEOUT_MAX = 180 days; 
    mapping(uint64 => ScheduledUint256) public scheduledDisputeTimeout;

    uint64[] public disputeTimeoutEpochs;

    event EscrowCreated(
        bytes32 indexed escrowId,
        address indexed depositor,
        address indexed recipient,
        uint256 amount,
        uint256 fee,
        uint256 autoReleaseAt
    );
    event EscrowFunded(bytes32 indexed escrowId, uint256 amount);
    event EscrowReleased(bytes32 indexed escrowId, address indexed recipient, uint256 netAmount, uint256 fee, bool autoRelease);
    event EscrowResolved(bytes32 indexed escrowId, bool releaseToRecipient);

    event EscrowCreatedPVT(
        bytes32 indexed escrowId,
        address indexed depositor,
        address indexed recipient,
        uint256 amount,
        uint256 fee,
        uint256 autoReleaseAt
    );
    event EscrowFundedPVT(bytes32 indexed escrowId, uint256 amount, uint256 feeBurned);
    event EscrowReleasedPVT(bytes32 indexed escrowId, address indexed recipient, uint256 netAmount, bool autoRelease);
    event EscrowResolvedPVT(bytes32 indexed escrowId, bool releaseToRecipient);

    event EscrowDisputed(bytes32 indexed escrowId);

    event EscrowCarried(
        bytes32 indexed escrowId,
        address indexed depositor,
        address indexed recipient,
        uint256 amount,
        uint256 fee,
        uint256 autoReleaseAt,
        Currency currency
    );
    event EscrowCancelled(bytes32 indexed escrowId);
    event CourtContractSet(address indexed courtContract);
    event DisputeDelegatedToCourt(bytes32 indexed escrowId);

    event DisputeAdjudicationFeePaid(bytes32 indexed escrowId, address indexed payer, uint256 fee);
    
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);
    
    event EscrowDisputeTimedOut(bytes32 indexed escrowId);
    event WithdrawalPending(bytes32 indexed escrowId, address indexed beneficiary, uint256 amount);
    event ResolvedFundsWithdrawn(bytes32 indexed escrowId, address indexed beneficiary, uint256 amount);

    event FeeBpsScheduled(uint64 indexed effectiveEpoch, uint256 bps);
    event PrincipalCapScheduled(uint64 indexed effectiveEpoch, uint256 capAtomic);
    event AutoReleasePeriodScheduled(uint64 indexed effectiveEpoch, uint256 periodSeconds);
    event AgreementDeadlineScheduled(uint64 indexed effectiveEpoch, uint256 deadlineSeconds);
    event DisputeTimeoutScheduled(uint64 indexed effectiveEpoch, uint256 timeoutSeconds);

    error OnlyAdmin();
    error OnlyDepositor();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidDeadline();
    error EscrowAlreadyExists();
    error EscrowNotFound();
    error InvalidStatus(Status expected, Status actual);
    error AutoReleaseNotReached();
    error AutoReleaseAlreadyPassed();
    error TransferFailed();
    error OnlyAdminOrCourt();
    error CourtAlreadySet();
    error CourtNotSet();

    error PVTFeeDiscountRetired();
    error PVTPrincipalRejectsDiscount();
    
    error DisputeTimeoutNotReached();
    error NothingToWithdraw();
    
    error InvalidSeed();
    
    error PolicyNotProspective();
    error PolicyAlreadyScheduled();
    error CostOutOfDomain();
    error PrincipalCapExceeded();
    error AutoReleasePeriodExceeded();
    error AgreementDeadlineExceeded();

    constructor(
        address _admin,
        address _feeWallet,
        address _usdc,
        address _pvt,
        address _epochClock,
        address _issuanceIndex,
        SeedManifest memory seedManifest
    ) RecourseInstitutionSeeds(_pvt, 1, seedManifest) {
        if (_admin == address(0) || _feeWallet == address(0) ||
            _usdc == address(0) || _pvt == address(0) || _epochClock == address(0) ||
            _issuanceIndex == address(0)) {
            revert InvalidAddress();
        }
        admin = _admin;
        feeWallet = _feeWallet;
        usdc = IERC20(_usdc);
        pvt = IPVTBurnable(_pvt);
        epochClock = IEpochClock(_epochClock);
        issuanceIndex = IIssuanceIndex(_issuanceIndex);


    }

    function _applyCustodySeed(bytes calldata data) internal override returns (uint256) {
        EscrowSeed memory s = abi.decode(data, (EscrowSeed));
            if (
                s.escrowId == bytes32(0) || s.depositor == address(0) || s.recipient == address(0) || s.amount == 0
                    || s.fee > s.amount || escrows[s.escrowId].depositor != address(0)
            ) revert InvalidSeed();
            escrows[s.escrowId] = Escrow({
                depositor: s.depositor,
                recipient: s.recipient,
                amount: s.amount,
                fee: s.fee,
                autoReleaseAt: s.autoReleaseAt,
                status: Status.Created,
                currency: s.currency,
                feePaidInPVT: false
            });
            emit EscrowCarried(s.escrowId, s.depositor, s.recipient, s.amount, s.fee, s.autoReleaseAt, s.currency);
        return s.amount;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert OnlyAdmin();
        _;
    }

    modifier onlyAdminOrCourt() {
        if (msg.sender != admin && msg.sender != courtContract) revert OnlyAdminOrCourt();
        _;
    }

    modifier onlyDepositor(bytes32 escrowId) {
        if (msg.sender != escrows[escrowId].depositor) revert OnlyDepositor();
        _;
    }

    function setCourtContract(address _court) external onlyAdmin whenCustodyReady {
        if (_court == address(0)) revert InvalidAddress();
        if (courtContractSet) revert CourtAlreadySet();
        courtContract = _court;
        courtContractSet = true;
        emit CourtContractSet(_court);
    }

    function transferAdmin(address newAdmin) external onlyAdmin whenCustodyReady {
        if (newAdmin == address(0)) revert InvalidAddress();
        address oldAdmin = admin;
        admin = newAdmin;
        emit AdminTransferred(oldAdmin, newAdmin);
    }

    function _currentEpoch() internal view returns (uint64) {
        try epochClock.currentEpoch() returns (uint64 e) {
            return e;
        } catch {
            return 0;
        }
    }

    function earliestSchedulableEpoch() public view returns (uint64) {
        return _currentEpoch() + 1;
    }

    function _trailingIssuance() internal view returns (uint256) {
        try issuanceIndex.trailingAverageForEpoch(_currentEpoch()) returns (uint256 avg) {
            return avg;
        } catch {
            return 0;
        }
    }

    function _indexFloor(uint256 baseline, uint256 ppm, uint256 avg) internal pure returns (uint256) {
        uint256 fromIndex = (ppm * avg) / INDEX_PPM_DENOMINATOR;
        return fromIndex > baseline ? fromIndex : baseline;
    }

    function disputeAdjudicationFee() public view returns (uint256) {
        return _indexFloor(
            DISPUTE_ADJUDICATION_FEE_BASELINE,
            DISPUTE_ADJUDICATION_FEE_INDEX_PPM,
            _trailingIssuance()
        );
    }

    function _requireScheduleEpoch(uint64 effectiveEpoch) private view {
        if (effectiveEpoch <= _currentEpoch()) revert PolicyNotProspective();
    }

    function _resolveActive(
        mapping(uint64 => ScheduledUint256) storage sched,
        uint64[] storage epochs
    ) private view returns (ScheduledUint256 memory) {
        uint64 nowEpoch = _currentEpoch();
        bool found;
        uint64 best;
        uint256 len = epochs.length;
        for (uint256 i = 0; i < len; ++i) {
            uint64 e = epochs[i];
            if (e <= nowEpoch && (!found || e > best)) {
                best = e;
                found = true;
            }
        }
        if (!found) return ScheduledUint256({exists: false, value: 0});
        return sched[best];
    }

    function activeFeeBps() public view returns (bool exists, uint256 value) {
        ScheduledUint256 memory a = _resolveActive(scheduledFeeBps, feeBpsEpochs);
        return (a.exists, a.value);
    }

    function activePrincipalCap() public view returns (bool exists, uint256 value) {
        ScheduledUint256 memory a = _resolveActive(scheduledPrincipalCap, principalCapEpochs);
        return (a.exists, a.value);
    }

    function activeAutoReleasePeriod() public view returns (bool exists, uint256 value) {
        ScheduledUint256 memory a = _resolveActive(scheduledAutoReleasePeriod, autoReleasePeriodEpochs);
        return (a.exists, a.value);
    }

    function activeAgreementDeadline() public view returns (bool exists, uint256 value) {
        ScheduledUint256 memory a = _resolveActive(scheduledAgreementDeadline, agreementDeadlineEpochs);
        return (a.exists, a.value);
    }

    function activeDisputeTimeout() public view returns (bool exists, uint256 value) {
        ScheduledUint256 memory a = _resolveActive(scheduledDisputeTimeout, disputeTimeoutEpochs);
        return (a.exists, a.value);
    }

    function scheduleFeeBps(uint64 effectiveEpoch, uint256 bps) external onlyAdmin whenCustodyReady {
        _requireScheduleEpoch(effectiveEpoch);
        if (bps > FEE_BPS_MAX) revert CostOutOfDomain(); 
        if (scheduledFeeBps[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledFeeBps[effectiveEpoch] = ScheduledUint256({exists: true, value: bps});
        feeBpsEpochs.push(effectiveEpoch);
        emit FeeBpsScheduled(effectiveEpoch, bps);
    }

    function schedulePrincipalCap(uint64 effectiveEpoch, uint256 capAtomic) external onlyAdmin whenCustodyReady {
        _requireScheduleEpoch(effectiveEpoch);
        if (capAtomic < PRINCIPAL_CAP_MIN || capAtomic > PRINCIPAL_CAP_MAX) revert CostOutOfDomain();
        if (scheduledPrincipalCap[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledPrincipalCap[effectiveEpoch] = ScheduledUint256({exists: true, value: capAtomic});
        principalCapEpochs.push(effectiveEpoch);
        emit PrincipalCapScheduled(effectiveEpoch, capAtomic);
    }

    function scheduleAutoReleasePeriod(uint64 effectiveEpoch, uint256 periodSeconds) external onlyAdmin whenCustodyReady {
        _requireScheduleEpoch(effectiveEpoch);
        if (periodSeconds < AUTO_RELEASE_PERIOD_MIN || periodSeconds > AUTO_RELEASE_PERIOD_MAX) revert CostOutOfDomain();
        if (scheduledAutoReleasePeriod[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledAutoReleasePeriod[effectiveEpoch] = ScheduledUint256({exists: true, value: periodSeconds});
        autoReleasePeriodEpochs.push(effectiveEpoch);
        emit AutoReleasePeriodScheduled(effectiveEpoch, periodSeconds);
    }

    function scheduleAgreementDeadline(uint64 effectiveEpoch, uint256 deadlineSeconds) external onlyAdmin whenCustodyReady {
        _requireScheduleEpoch(effectiveEpoch);
        if (deadlineSeconds < AGREEMENT_DEADLINE_MIN || deadlineSeconds > AGREEMENT_DEADLINE_MAX) revert CostOutOfDomain();
        if (scheduledAgreementDeadline[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledAgreementDeadline[effectiveEpoch] = ScheduledUint256({exists: true, value: deadlineSeconds});
        agreementDeadlineEpochs.push(effectiveEpoch);
        emit AgreementDeadlineScheduled(effectiveEpoch, deadlineSeconds);
    }

    function scheduleDisputeTimeout(uint64 effectiveEpoch, uint256 timeoutSeconds) external onlyAdmin whenCustodyReady {
        _requireScheduleEpoch(effectiveEpoch);
        if (timeoutSeconds < DISPUTE_TIMEOUT_MIN || timeoutSeconds > DISPUTE_TIMEOUT_MAX) revert CostOutOfDomain();
        if (scheduledDisputeTimeout[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledDisputeTimeout[effectiveEpoch] = ScheduledUint256({exists: true, value: timeoutSeconds});
        disputeTimeoutEpochs.push(effectiveEpoch);
        emit DisputeTimeoutScheduled(effectiveEpoch, timeoutSeconds);
    }

    function createEscrow(
        bytes32 escrowId,
        address recipient,
        uint256 amount,
        uint256 autoReleaseAt,
        Currency currencyType
    ) external whenCustodyReady {
        if (recipient == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();

        (bool capExists, uint256 capValue) = activePrincipalCap();
        if (currencyType == Currency.PVT && capExists && amount > capValue) {
            revert PrincipalCapExceeded();
        }
        if (autoReleaseAt <= block.timestamp) revert InvalidDeadline();

        uint256 releaseWindow = autoReleaseAt - block.timestamp;
        (bool maxPeriodExists, uint256 maxPeriodValue) = activeAutoReleasePeriod();
        if (maxPeriodExists && releaseWindow > maxPeriodValue) {
            revert AutoReleasePeriodExceeded();
        }
        (bool maxAgreementExists, uint256 maxAgreementValue) = activeAgreementDeadline();
        if (maxAgreementExists && releaseWindow > maxAgreementValue) {
            revert AgreementDeadlineExceeded();
        }
        if (escrows[escrowId].depositor != address(0)) revert EscrowAlreadyExists();

        (bool feeExists, uint256 feeValue) = activeFeeBps();
        uint256 fee = feeExists
            ? (amount * feeValue) / 10_000
            : (amount * 5) / 1000;

        escrows[escrowId] = Escrow({
            depositor: msg.sender,
            recipient: recipient,
            amount: amount,
            fee: fee,
            autoReleaseAt: autoReleaseAt,
            status: Status.Created,
            currency: currencyType,
            feePaidInPVT: false
        });

        if (currencyType == Currency.PVT) {
            emit EscrowCreatedPVT(escrowId, msg.sender, recipient, amount, fee, autoReleaseAt);
        } else {
            emit EscrowCreated(escrowId, msg.sender, recipient, amount, fee, autoReleaseAt);
        }
    }

    function fundEscrow(bytes32 escrowId, bool payFeeInPVT) external onlyDepositor(escrowId) whenCustodyReady {
        Escrow storage e = escrows[escrowId];
        if (e.status != Status.Created) {
            revert InvalidStatus(Status.Created, e.status);
        }

        e.status = Status.Funded;

        if (e.currency == Currency.PVT) {
            
            if (payFeeInPVT) revert PVTPrincipalRejectsDiscount();

            bool ok = pvt.transferFrom(msg.sender, address(this), e.amount);
            if (!ok) revert TransferFailed();
            pvt.burn(e.fee);
            encumberedPVT += e.amount - e.fee;

            emit EscrowFundedPVT(escrowId, e.amount, e.fee);
            return;
        }

        if (payFeeInPVT) revert PVTFeeDiscountRetired();

        bool usdcOk = usdc.transferFrom(msg.sender, address(this), e.amount);
        if (!usdcOk) revert TransferFailed();

        emit EscrowFunded(escrowId, e.amount);
    }

    function releaseEscrow(bytes32 escrowId) external whenCustodyReady {
        Escrow storage e = escrows[escrowId];
        if (e.status != Status.Funded) {
            revert InvalidStatus(Status.Funded, e.status);
        }

        bool isAutoRelease = false;
        if (msg.sender != e.depositor) {
            if (block.timestamp < e.autoReleaseAt) revert AutoReleaseNotReached();
            isAutoRelease = true;
        }

        e.status = Status.Completed;

        if (e.currency == Currency.PVT) {
            
            uint256 principal = e.amount - e.fee;
            encumberedPVT -= principal;
            bool ok = pvt.transfer(e.recipient, principal);
            if (!ok) revert TransferFailed();
            emit EscrowReleasedPVT(escrowId, e.recipient, principal, isAutoRelease);
            return;
        }

        uint256 netAmount = e.amount - e.fee;
        bool ok1 = usdc.transfer(e.recipient, netAmount);
        if (!ok1) revert TransferFailed();
        bool ok2 = usdc.transfer(feeWallet, e.fee);
        if (!ok2) revert TransferFailed();
        emit EscrowReleased(escrowId, e.recipient, netAmount, e.fee, isAutoRelease);
    }

    function disputeEscrow(bytes32 escrowId) external onlyDepositor(escrowId) whenCustodyReady {
        Escrow storage e = escrows[escrowId];
        if (e.status != Status.Funded) {
            revert InvalidStatus(Status.Funded, e.status);
        }
        if (block.timestamp >= e.autoReleaseAt) revert AutoReleaseAlreadyPassed();

        e.status = Status.Disputed;

        (bool timeoutExists, uint256 timeoutValue) = activeDisputeTimeout();
        uint256 timeout = timeoutExists ? timeoutValue : DISPUTE_RESOLUTION_TIMEOUT;
        disputeDeadline[escrowId] = block.timestamp + timeout;
        emit EscrowDisputed(escrowId);
    }

    function resolveDispute(bytes32 escrowId, bool releaseToRecipient) external onlyAdminOrCourt whenCustodyReady {
        Escrow storage e = escrows[escrowId];
        if (e.status != Status.Disputed) {
            revert InvalidStatus(Status.Disputed, e.status);
        }

        e.status = Status.Resolved;
        disputeSettledAt[escrowId] = block.timestamp;
        _settleResolution(escrowId, e, releaseToRecipient);
    }

    function claimDisputeTimeout(bytes32 escrowId) external whenCustodyReady {
        Escrow storage e = escrows[escrowId];
        if (e.status != Status.Disputed) {
            revert InvalidStatus(Status.Disputed, e.status);
        }
        if (block.timestamp < disputeDeadline[escrowId]) revert DisputeTimeoutNotReached();

        e.status = Status.Resolved;
        disputeSettledAt[escrowId] = block.timestamp;
        _settleResolution(escrowId, e, false); 
        emit EscrowDisputeTimedOut(escrowId);
    }

    function _settleResolution(bytes32 escrowId, Escrow storage e, bool releaseToRecipient) internal {
        address party = releaseToRecipient ? e.recipient : e.depositor;

        if (e.currency == Currency.PVT) {
            
            uint256 held = e.amount - e.fee;
            _payoutOrCredit(escrowId, Currency.PVT, party, held);
            emit EscrowResolvedPVT(escrowId, releaseToRecipient);
            return;
        }

        uint256 netAmount = e.amount - e.fee;
        _payoutOrCredit(escrowId, Currency.USDC, party, netAmount);
        bool ok = usdc.transfer(feeWallet, e.fee);
        if (!ok) revert TransferFailed();

        emit EscrowResolved(escrowId, releaseToRecipient);
    }

    function _payoutOrCredit(bytes32 escrowId, Currency cur, address to, uint256 amount) internal {
        if (amount == 0) return;
        bool ok;
        if (cur == Currency.PVT) {
            try pvt.transfer(to, amount) returns (bool r) { ok = r; } catch { ok = false; }
        } else {
            try usdc.transfer(to, amount) returns (bool r) { ok = r; } catch { ok = false; }
        }
        if (!ok) {
            pendingWithdrawal[escrowId] = amount;
            pendingBeneficiary[escrowId] = to;
            emit WithdrawalPending(escrowId, to, amount);
        } else if (cur == Currency.PVT) {
            encumberedPVT -= amount;
        }
    }

    function withdrawResolvedFunds(bytes32 escrowId) external whenCustodyReady {
        uint256 amount = pendingWithdrawal[escrowId];
        if (amount == 0) revert NothingToWithdraw();
        address to = pendingBeneficiary[escrowId];
        pendingWithdrawal[escrowId] = 0; 

        Currency cur = escrows[escrowId].currency;
        if (cur == Currency.PVT) encumberedPVT -= amount;
        bool ok = (cur == Currency.PVT) ? pvt.transfer(to, amount) : usdc.transfer(to, amount);
        if (!ok) revert TransferFailed();
        emit ResolvedFundsWithdrawn(escrowId, to, amount);
    }

    function delegateToCourt(bytes32 escrowId) external whenCustodyReady {
        Escrow storage e = escrows[escrowId];
        if (e.status != Status.Disputed) {
            revert InvalidStatus(Status.Disputed, e.status);
        }
        if (courtContract == address(0)) revert CourtNotSet();

        uint256 fee = disputeAdjudicationFee();
        bool ok = pvt.transferFrom(msg.sender, courtContract, fee);
        if (!ok) revert TransferFailed();
        IArbitratorRewardSink(courtContract).fundEscrowDisputeReward(escrowId, fee);

        emit DisputeAdjudicationFeePaid(escrowId, msg.sender, fee);
        emit DisputeDelegatedToCourt(escrowId);
    }

    function cancelEscrow(bytes32 escrowId) external onlyDepositor(escrowId) whenCustodyReady {
        Escrow storage e = escrows[escrowId];
        if (e.status != Status.Created) {
            revert InvalidStatus(Status.Created, e.status);
        }
        e.status = Status.Cancelled;
        emit EscrowCancelled(escrowId);
    }

    function currency(bytes32 escrowId) external view returns (Currency) {
        Escrow storage e = escrows[escrowId];
        if (e.depositor == address(0)) revert EscrowNotFound();
        return e.currency;
    }

    function getParties(bytes32 escrowId) external view returns (address depositor, address recipient) {
        Escrow storage e = escrows[escrowId];
        return (e.depositor, e.recipient);
    }

    function version() external pure returns (string memory) {
        return VERSION;
    }
}
