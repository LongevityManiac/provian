// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Successor institution with explicit PVT custody obligations.
/// Direct donations do not increase obligations; recorded exits remain backed.

import {IERC20} from "./interfaces/IERC20.sol";
import {IPVTBurnable} from "./interfaces/IPVTBurnable.sol";
import {IEpochClock} from "./interfaces/IEpochClock.sol";

contract ProvianRecourseProjectPool {

    string public constant VERSION = "v3";

    enum Currency {
        USDC,   
        PVT     
    }

    enum Status {
        Open,       
        Funded,     
        Executed,   
        Refunded,   
        Cancelled   
    }

    struct PoolInfo {
        address creator;
        address target;
        uint256 threshold;
        uint256 totalContributed;
        uint256 fee;                
        uint256 deadline;
        Status status;
        Currency currency;
    }

    struct ScheduledUint256 {
        bool exists;
        uint256 value;
    }

    mapping(bytes32 => PoolInfo) public pools;
    mapping(bytes32 => mapping(address => uint256)) public contributions;
    mapping(bytes32 => address[]) public contributorList;

    mapping(bytes32 => mapping(address => uint256)) public pendingRefunds;

    uint256 public encumberedPVT;

    address public admin;
    address public feeWallet;
    IERC20 public usdc;
    IPVTBurnable public pvt;

    uint256 public constant MAX_CONTRIBUTORS_PER_POOL = 200;

    IEpochClock public immutable epochClock;

    uint256 public constant FEE_BPS_MAX = 1_000;
    mapping(uint64 => ScheduledUint256) public scheduledFeeBps;

    uint64[] public feeBpsEpochs;

    uint256 public constant THRESHOLD_CAP_MIN = 1e18;
    uint256 public constant THRESHOLD_CAP_MAX = 1_000_000e18;
    mapping(uint64 => ScheduledUint256) public scheduledThresholdCap;

    uint64[] public thresholdCapEpochs;

    uint256 public constant MAXIMUM_DEADLINE_MIN = 1 hours;   
    uint256 public constant MAXIMUM_DEADLINE_MAX = 180 days;  
    mapping(uint64 => ScheduledUint256) public scheduledMaximumDeadline;

    uint64[] public maximumDeadlineEpochs;

    uint256 public constant MAX_CONTRIBUTORS_MIN = 2;
    uint256 public constant MAX_CONTRIBUTORS_MAX = 200;
    mapping(uint64 => ScheduledUint256) public scheduledMaxContributors;

    uint64[] public maxContributorsEpochs;

    event PoolCreated(bytes32 indexed poolId, address indexed creator, address indexed target, uint256 threshold, uint256 deadline);
    event PoolContribution(bytes32 indexed poolId, address indexed contributor, uint256 amount, uint256 totalContributed);
    event PoolExecuted(bytes32 indexed poolId, address indexed target, uint256 netAmount, uint256 fee);
    event PoolRefunded(bytes32 indexed poolId, uint256 contributorCount);
    event PoolWithdrawal(bytes32 indexed poolId, address indexed contributor, uint256 amount);

    event PoolCreatedPVT(bytes32 indexed poolId, address indexed creator, address indexed target, uint256 threshold, uint256 deadline);
    event PoolContributionPVT(bytes32 indexed poolId, address indexed contributor, uint256 amount, uint256 totalContributed);
    event PoolExecutedPVT(bytes32 indexed poolId, address indexed target, uint256 netAmount, uint256 feeBurned);
    event PoolRefundedPVT(bytes32 indexed poolId, uint256 contributorCount);
    event PoolWithdrawalPVT(bytes32 indexed poolId, address indexed contributor, uint256 amount);

    event PoolCancelled(bytes32 indexed poolId);
    
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);
    
    event RefundPending(bytes32 indexed poolId, address indexed contributor, uint256 amount);
    event PendingRefundClaimed(bytes32 indexed poolId, address indexed contributor, uint256 amount);

    event FeeBpsScheduled(uint64 indexed effectiveEpoch, uint256 bps);
    event ThresholdCapScheduled(uint64 indexed effectiveEpoch, uint256 capAtomic);
    event MaximumDeadlineScheduled(uint64 indexed effectiveEpoch, uint256 deadlineSeconds);
    event MaxContributorsScheduled(uint64 indexed effectiveEpoch, uint256 maxContributors);

    error OnlyAdmin();
    error OnlyCreator();
    error OnlyCreatorOrAdmin();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidDeadline();
    error PoolAlreadyExists();
    error PoolNotFound();
    error InvalidStatus(Status expected, Status actual);
    error DeadlineNotReached();
    error NoContribution();
    error TransferFailed();

    error PVTFeeDiscountRetired();
    error PVTPrincipalRejectsDiscount();
    error NothingToClaim();
    
    error PolicyNotProspective();
    error PolicyAlreadyScheduled();
    error CostOutOfDomain();
    error ThresholdCapExceeded();
    error MaximumDeadlineExceeded();

    constructor(address _admin, address _feeWallet, address _usdc, address _pvt, address _epochClock) {
        if (_admin == address(0) || _feeWallet == address(0) ||
            _usdc == address(0) || _pvt == address(0) || _epochClock == address(0)) {
            revert InvalidAddress();
        }
        admin = _admin;
        feeWallet = _feeWallet;
        usdc = IERC20(_usdc);
        pvt = IPVTBurnable(_pvt);
        epochClock = IEpochClock(_epochClock);
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert OnlyAdmin();
        _;
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

    function activeThresholdCap() public view returns (bool exists, uint256 value) {
        ScheduledUint256 memory a = _resolveActive(scheduledThresholdCap, thresholdCapEpochs);
        return (a.exists, a.value);
    }

    function activeMaximumDeadline() public view returns (bool exists, uint256 value) {
        ScheduledUint256 memory a = _resolveActive(scheduledMaximumDeadline, maximumDeadlineEpochs);
        return (a.exists, a.value);
    }

    function activeMaxContributors() public view returns (bool exists, uint256 value) {
        ScheduledUint256 memory a = _resolveActive(scheduledMaxContributors, maxContributorsEpochs);
        return (a.exists, a.value);
    }

    function scheduleFeeBps(uint64 effectiveEpoch, uint256 bps) external onlyAdmin {
        _requireScheduleEpoch(effectiveEpoch);
        if (bps > FEE_BPS_MAX) revert CostOutOfDomain(); 
        if (scheduledFeeBps[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledFeeBps[effectiveEpoch] = ScheduledUint256({exists: true, value: bps});
        feeBpsEpochs.push(effectiveEpoch);
        emit FeeBpsScheduled(effectiveEpoch, bps);
    }

    function scheduleThresholdCap(uint64 effectiveEpoch, uint256 capAtomic) external onlyAdmin {
        _requireScheduleEpoch(effectiveEpoch);
        if (capAtomic < THRESHOLD_CAP_MIN || capAtomic > THRESHOLD_CAP_MAX) revert CostOutOfDomain();
        if (scheduledThresholdCap[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledThresholdCap[effectiveEpoch] = ScheduledUint256({exists: true, value: capAtomic});
        thresholdCapEpochs.push(effectiveEpoch);
        emit ThresholdCapScheduled(effectiveEpoch, capAtomic);
    }

    function scheduleMaximumDeadline(uint64 effectiveEpoch, uint256 deadlineSeconds) external onlyAdmin {
        _requireScheduleEpoch(effectiveEpoch);
        if (deadlineSeconds < MAXIMUM_DEADLINE_MIN || deadlineSeconds > MAXIMUM_DEADLINE_MAX) revert CostOutOfDomain();
        if (scheduledMaximumDeadline[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledMaximumDeadline[effectiveEpoch] = ScheduledUint256({exists: true, value: deadlineSeconds});
        maximumDeadlineEpochs.push(effectiveEpoch);
        emit MaximumDeadlineScheduled(effectiveEpoch, deadlineSeconds);
    }

    function scheduleMaxContributors(uint64 effectiveEpoch, uint256 maxContributors) external onlyAdmin {
        _requireScheduleEpoch(effectiveEpoch);
        if (maxContributors < MAX_CONTRIBUTORS_MIN || maxContributors > MAX_CONTRIBUTORS_MAX) revert CostOutOfDomain();
        if (scheduledMaxContributors[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledMaxContributors[effectiveEpoch] = ScheduledUint256({exists: true, value: maxContributors});
        maxContributorsEpochs.push(effectiveEpoch);
        emit MaxContributorsScheduled(effectiveEpoch, maxContributors);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert InvalidAddress();
        address oldAdmin = admin;
        admin = newAdmin;
        emit AdminTransferred(oldAdmin, newAdmin);
    }

    function createPool(
        bytes32 poolId,
        address target,
        uint256 threshold,
        uint256 deadline,
        Currency currencyType
    ) external {
        if (target == address(0)) revert InvalidAddress();
        if (threshold == 0) revert InvalidAmount();

        (bool capExists, uint256 capValue) = activeThresholdCap();
        if (currencyType == Currency.PVT && capExists && threshold > capValue) {
            revert ThresholdCapExceeded();
        }
        if (deadline <= block.timestamp) revert InvalidDeadline();

        uint256 fundingWindow = deadline - block.timestamp;
        (bool maxDeadlineExists, uint256 maxDeadlineValue) = activeMaximumDeadline();
        if (maxDeadlineExists && fundingWindow > maxDeadlineValue) {
            revert MaximumDeadlineExceeded();
        }
        if (pools[poolId].creator != address(0)) revert PoolAlreadyExists();

        (bool feeExists, uint256 feeValue) = activeFeeBps();
        uint256 fee = feeExists
            ? (threshold * feeValue) / 10_000
            : (threshold * 5) / 1000;

        pools[poolId] = PoolInfo({
            creator: msg.sender,
            target: target,
            threshold: threshold,
            totalContributed: 0,
            fee: fee,
            deadline: deadline,
            status: Status.Open,
            currency: currencyType
        });

        if (currencyType == Currency.PVT) {
            emit PoolCreatedPVT(poolId, msg.sender, target, threshold, deadline);
        } else {
            emit PoolCreated(poolId, msg.sender, target, threshold, deadline);
        }
    }

    function contribute(bytes32 poolId, uint256 amount) external {
        PoolInfo storage p = pools[poolId];

        if (p.creator == address(0)) revert PoolNotFound();
        if (p.status != Status.Open) {
            revert InvalidStatus(Status.Open, p.status);
        }
        if (amount == 0) revert InvalidAmount();

        if (contributions[poolId][msg.sender] == 0) {

            (bool maxExists, uint256 maxValue) = activeMaxContributors();
            uint256 contributorLimit = maxExists ? maxValue : MAX_CONTRIBUTORS_PER_POOL;
            require(
                contributorList[poolId].length < contributorLimit,
                "ProvianRecourseProjectPool: contributor cap reached"
            );
            contributorList[poolId].push(msg.sender);
        }

        contributions[poolId][msg.sender] += amount;
        p.totalContributed += amount;

        if (p.currency == Currency.PVT) {
            bool ok = pvt.transferFrom(msg.sender, address(this), amount);
            if (!ok) revert TransferFailed();
            encumberedPVT += amount;
        } else {
            bool ok = usdc.transferFrom(msg.sender, address(this), amount);
            if (!ok) revert TransferFailed();
        }

        if (p.totalContributed >= p.threshold) {
            p.status = Status.Funded;
        }

        if (p.currency == Currency.PVT) {
            emit PoolContributionPVT(poolId, msg.sender, amount, p.totalContributed);
        } else {
            emit PoolContribution(poolId, msg.sender, amount, p.totalContributed);
        }
    }

    function executePool(bytes32 poolId, bool payFeeInPVT) external {
        PoolInfo storage p = pools[poolId];
        if (msg.sender != p.creator && msg.sender != admin) revert OnlyCreatorOrAdmin();
        if (p.status != Status.Funded) {
            revert InvalidStatus(Status.Funded, p.status);
        }

        p.status = Status.Executed;

        uint256 netAmount;
        uint256 emittedFee;

        if (p.currency == Currency.PVT) {
            if (payFeeInPVT) revert PVTPrincipalRejectsDiscount();

            netAmount = p.threshold - p.fee;
            encumberedPVT -= p.threshold;
            pvt.burn(p.fee);

            bool ok = pvt.transfer(p.target, netAmount);
            if (!ok) revert TransferFailed();

            emittedFee = p.fee;
            
        } else {

            if (payFeeInPVT) revert PVTFeeDiscountRetired();

            netAmount = p.threshold - p.fee;
            bool feeOk = usdc.transfer(feeWallet, p.fee);
            if (!feeOk) revert TransferFailed();
            emittedFee = p.fee;

            bool ok = usdc.transfer(p.target, netAmount);
            if (!ok) revert TransferFailed();
        }

        uint256 excess = p.totalContributed - p.threshold;
        if (excess > 0) {
            address[] storage contribs = contributorList[poolId];
            uint256 totalRefunded = 0;
            uint256 lastIndex = contribs.length - 1;
            for (uint256 i = 0; i < contribs.length; i++) {
                uint256 contributed = contributions[poolId][contribs[i]];
                uint256 refund;
                if (i == lastIndex) {
                    refund = excess - totalRefunded;
                } else {
                    refund = (contributed * excess) / p.totalContributed;
                }
                totalRefunded += refund;

                _payOrCredit(poolId, p.currency, contribs[i], refund);
            }
        }

        if (p.currency == Currency.PVT) {
            emit PoolExecutedPVT(poolId, p.target, netAmount, emittedFee);
        } else {
            emit PoolExecuted(poolId, p.target, netAmount, emittedFee);
        }
    }

    function refundPool(bytes32 poolId) external {
        PoolInfo storage p = pools[poolId];

        if (msg.sender == admin) {
            if (p.status != Status.Open && p.status != Status.Funded) {
                revert InvalidStatus(Status.Open, p.status);
            }
        } else {
            if (p.status != Status.Open && p.status != Status.Funded) {
                revert InvalidStatus(Status.Open, p.status);
            }
            if (block.timestamp < p.deadline) revert DeadlineNotReached();
        }

        p.status = Status.Refunded;

        address[] storage contribs = contributorList[poolId];
        for (uint256 i = 0; i < contribs.length; i++) {
            uint256 contributed = contributions[poolId][contribs[i]];
            if (contributed > 0) {

                _payOrCredit(poolId, p.currency, contribs[i], contributed);
            }
        }

        if (p.currency == Currency.PVT) {
            emit PoolRefundedPVT(poolId, contribs.length);
        } else {
            emit PoolRefunded(poolId, contribs.length);
        }
    }

    function _payOrCredit(bytes32 poolId, Currency cur, address to, uint256 amount) internal {
        if (amount == 0) return;
        bool ok;
        if (cur == Currency.PVT) {
            try pvt.transfer(to, amount) returns (bool r) { ok = r; } catch { ok = false; }
        } else {
            try usdc.transfer(to, amount) returns (bool r) { ok = r; } catch { ok = false; }
        }
        if (!ok) {
            pendingRefunds[poolId][to] += amount;
            emit RefundPending(poolId, to, amount);
        } else if (cur == Currency.PVT) {
            encumberedPVT -= amount;
        }
    }

    function claimPendingRefund(bytes32 poolId) external {
        uint256 amount = pendingRefunds[poolId][msg.sender];
        if (amount == 0) revert NothingToClaim();
        pendingRefunds[poolId][msg.sender] = 0; 

        PoolInfo storage p = pools[poolId];
        if (p.currency == Currency.PVT) encumberedPVT -= amount;
        bool ok = (p.currency == Currency.PVT)
            ? pvt.transfer(msg.sender, amount)
            : usdc.transfer(msg.sender, amount);
        if (!ok) revert TransferFailed();
        emit PendingRefundClaimed(poolId, msg.sender, amount);
    }

    function withdrawContribution(bytes32 poolId) external {
        PoolInfo storage p = pools[poolId];
        if (p.status != Status.Open) {
            revert InvalidStatus(Status.Open, p.status);
        }

        uint256 amount = contributions[poolId][msg.sender];
        if (amount == 0) revert NoContribution();

        contributions[poolId][msg.sender] = 0;
        p.totalContributed -= amount;

        _removeContributor(poolId, msg.sender);

        if (p.currency == Currency.PVT) encumberedPVT -= amount;

        bool ok = (p.currency == Currency.PVT)
            ? pvt.transfer(msg.sender, amount)
            : usdc.transfer(msg.sender, amount);
        if (!ok) revert TransferFailed();

        if (p.currency == Currency.PVT) {
            emit PoolWithdrawalPVT(poolId, msg.sender, amount);
        } else {
            emit PoolWithdrawal(poolId, msg.sender, amount);
        }
    }

    function _removeContributor(bytes32 poolId, address who) private {
        address[] storage list = contributorList[poolId];
        uint256 len = list.length;
        for (uint256 i = 0; i < len; i++) {
            if (list[i] == who) {
                list[i] = list[len - 1];
                list.pop();
                return;
            }
        }
    }

    function getContributorCount(bytes32 poolId) external view returns (uint256) {
        return contributorList[poolId].length;
    }

    function getContributor(bytes32 poolId, uint256 index) external view returns (address) {
        return contributorList[poolId][index];
    }

    function currency(bytes32 poolId) external view returns (Currency) {
        PoolInfo storage p = pools[poolId];
        if (p.creator == address(0)) revert PoolNotFound();
        return p.currency;
    }

    function version() external pure returns (string memory) {
        return VERSION;
    }
}
