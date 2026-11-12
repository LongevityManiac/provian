// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {RecourseInstitutionSeeds} from "./RecourseInstitutionSeeds.sol";

/// @notice Successor institution with explicit PVT custody obligations.
/// Direct donations do not increase obligations; recorded exits remain backed.

import {IPVTBurnable} from "./interfaces/IPVTBurnable.sol";
import {IEpochClock} from "./interfaces/IEpochClock.sol";
import {IIssuanceIndex} from "./interfaces/IIssuanceIndex.sol";

interface IArbitratorRewardSink {
    function fundBondClaimReward(bytes32 claimId, uint256 amount) external;
}

interface IBondClaimCourt {
    function bondClaimCaseOpen(bytes32 claimId) external view returns (bool);
}

contract ProvianRecourseBondPool is RecourseInstitutionSeeds {

    enum BondStatus {
        None,       
        Active,     
        Withdrawn,  
        Abandoned   
    }

    enum ClaimStatus {
        Filed,      
        Upheld,     
        Dismissed   
    }

    struct Bond {
        uint256 amount;            
        uint8 autonomyLevel;       
        uint256 createdAt;
        uint256 lastRenewalAt;
        uint256 renewalDeadline;
        BondStatus status;
        uint256 pendingClaims;
    }

    struct Claim {
        address claimant;
        address agent;
        uint256 filingFee;
        ClaimStatus status;
        uint256 filedAt;
    }

    struct BondSeed {
        address agent;
        uint256 amount;
        uint8 autonomyLevel;
        uint256 createdAt;
        uint256 lastRenewalAt;
        uint256 renewalDeadline;
        uint256 requiredAtPost;
    }

    struct BpsSeed {
        uint8 param;
        uint256 bps;
    }

    struct ScheduledUint256 {
        bool exists;
        uint256 value;
    }

    struct ScheduledPair {
        bool exists;
        uint256 a;
        uint256 b;
    }

    mapping(address => Bond) public bonds;
    mapping(bytes32 => Claim) public claims;
    mapping(bytes32 => bool) public claimExists;

    address public admin;
    address public provianTechWallet;
    IPVTBurnable public pvt;
    
    uint256 public encumberedPVT;
    address public courtContract;
    bool private courtContractSet;
    address public executor;
    bool private executorSet;

    uint256 public level2BaseBond = 750e18;     
    uint256 public level3BaseBond = 3000e18;    
    uint256 public maxBondDeposit = 7500e18;    
    uint256 public constant MAX_TRUST_DISCOUNT = 5000;       

    uint256 public depositBurnBps = 200;                     
    uint256 public depositFeeBps = 100;                      
    uint256 public renewalBurnBps = 100;                     
    uint256 public renewalFeeBps = 50;                       
    uint256 public slashBurnBps = 2000;                      
    uint256 public slashPayoutBps = 8000;                    
    uint256 public claimsProcessingFee = 30e18;              
    uint256 public claimFilingFee = 15e18;                   

    uint256 public renewalPeriod = 180 days;
    uint256 public renewalGracePeriod = 30 days;
    uint256 public abandonmentPeriod = 365 days;

    uint256 public constant MAX_BPS = 10000;
    uint256 public constant MAX_FEE = 1000e18;               
    uint256 public constant MAX_FILING_FEE = 500e18;          
    uint256 public constant MIN_RENEWAL_PERIOD = 30 days;
    uint256 public constant MAX_RENEWAL_PERIOD = 365 days;
    uint256 public constant MIN_ABANDONMENT_PERIOD = 90 days;
    uint256 public constant MAX_ABANDONMENT_PERIOD = 730 days;

    uint256 public constant MIN_BASE_BOND = 100e18;
    uint256 public constant MAX_BASE_BOND = 50000e18;
    uint256 public constant MIN_MAX_BOND_DEPOSIT = 1000e18;
    uint256 public constant MAX_MAX_BOND_DEPOSIT = 250000e18;

    uint256 public constant MIN_SLASH_PAYOUT_BPS = 5000;     

    uint256 public constant CLAIM_RESOLUTION_TIMEOUT = 60 days;

    IEpochClock public immutable epochClock;

    IIssuanceIndex public immutable issuanceIndex;

    uint256 public constant INDEX_PPM_DENOMINATOR = 1_000_000;
    uint256 public constant LEVEL2_BOND_INDEX_PPM = 75;
    uint256 public constant LEVEL3_BOND_INDEX_PPM = 300;
    uint256 public constant MAX_DEPOSIT_INDEX_PPM = 750;
    uint256 public constant CLAIMS_PROCESSING_FEE_INDEX_PPM = 3;

    mapping(address => uint256) public requiredAtPost;

    uint256 public constant BOND_DEPOSIT_BURN_BPS_MAX = 1_000; 
    uint256 public constant BOND_DEPOSIT_FEE_BPS_MAX = 500;    
    uint256 public constant BOND_RENEWAL_BURN_BPS_MAX = 500;   
    uint256 public constant BOND_RENEWAL_FEE_BPS_MAX = 250;    

    mapping(uint64 => ScheduledUint256) public scheduledDepositBurnBps;
    uint64[] public depositBurnBpsEpochs;
    mapping(uint64 => ScheduledUint256) public scheduledDepositFeeBps;
    uint64[] public depositFeeBpsEpochs;
    mapping(uint64 => ScheduledUint256) public scheduledRenewalBurnBps;
    uint64[] public renewalBurnBpsEpochs;
    mapping(uint64 => ScheduledUint256) public scheduledRenewalFeeBps;
    uint64[] public renewalFeeBpsEpochs;
    mapping(uint64 => ScheduledUint256) public scheduledClaimsProcessingFee;
    uint64[] public claimsProcessingFeeEpochs;
    mapping(uint64 => ScheduledUint256) public scheduledClaimFilingFee;
    uint64[] public claimFilingFeeEpochs;
    mapping(uint64 => ScheduledUint256) public scheduledRenewalPeriod;
    uint64[] public renewalPeriodEpochs;
    mapping(uint64 => ScheduledUint256) public scheduledAbandonmentPeriod;
    uint64[] public abandonmentPeriodEpochs;
    mapping(uint64 => ScheduledUint256) public scheduledMaxBondDeposit;
    uint64[] public maxBondDepositEpochs;

    mapping(uint64 => ScheduledPair) public scheduledSlashShares;
    uint64[] public slashSharesEpochs;

    mapping(uint64 => ScheduledPair) public scheduledBaseBonds;
    uint64[] public baseBondsEpochs;

    event BondPosted(address indexed agent, uint256 totalDeposit, uint256 lockedAmount, uint8 autonomyLevel);
    event BondRenewed(address indexed agent, uint256 newDeadline);
    event BondToppedUp(address indexed agent, uint256 amount, uint256 newBondAmount);
    event BondSlashed(address indexed agent, bytes32 indexed claimId, address indexed claimant, uint256 claimantAmount, uint256 burnedAmount);
    event BondWithdrawn(address indexed agent, uint256 returnedAmount);
    event ClaimFiled(bytes32 indexed claimId, address indexed claimant, address indexed agent);
    event ClaimDismissed(bytes32 indexed claimId, address indexed agent);
    
    event ClaimExpired(bytes32 indexed claimId, address indexed agent);
    
    event ClaimClosedUnadjudicated(
        bytes32 indexed claimId, address indexed agent, address indexed claimant, uint256 refundedFee
    );
    event BondAbandoned(address indexed agent, uint256 burnedAmount);

    event BondCarried(address indexed agent, uint256 lockedAmount, uint8 autonomyLevel, uint256 renewalDeadline);
    event AutonomyDowngrade(address indexed agent, uint256 remainingBond, uint256 requiredBond);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);
    event CourtContractSet(address indexed court);
    event ExecutorWired(address indexed governance);

    event DepositBurnBpsScheduled(uint64 indexed effectiveEpoch, uint256 bps);
    event DepositFeeBpsScheduled(uint64 indexed effectiveEpoch, uint256 bps);
    event RenewalBurnBpsScheduled(uint64 indexed effectiveEpoch, uint256 bps);
    event RenewalFeeBpsScheduled(uint64 indexed effectiveEpoch, uint256 bps);
    event SlashSharesScheduled(uint64 indexed effectiveEpoch, uint256 burnBps, uint256 payoutBps);
    event ClaimsProcessingFeeScheduled(uint64 indexed effectiveEpoch, uint256 feeAtomic);
    event ClaimFilingFeeScheduled(uint64 indexed effectiveEpoch, uint256 feeAtomic);
    event RenewalPeriodScheduled(uint64 indexed effectiveEpoch, uint256 periodSeconds);
    event AbandonmentPeriodScheduled(uint64 indexed effectiveEpoch, uint256 periodSeconds);
    event BaseBondsScheduled(uint64 indexed effectiveEpoch, uint256 level2, uint256 level3);
    event MaxBondDepositScheduled(uint64 indexed effectiveEpoch, uint256 maxDeposit);

    error OnlyAdmin();
    error OnlyCourt();
    error OnlyExecutor();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidAutonomyLevel();
    error InvalidTrustDiscount();
    error BondAlreadyExists();
    error BondNotFound();
    error BondNotActive();
    error ClaimsPending();
    error ClaimAlreadyExists();
    error ClaimNotFound();
    error ClaimAlreadyResolved();
    error SelfClaimNotAllowed();
    error InsufficientBond();
    error InsufficientDeposit();
    error GracePeriodNotExpired();
    error TransferFailed();
    error CourtAlreadySet();
    error ExecutorAlreadySet();
    error ParameterOutOfBounds();
    error SlashBpsInvariant();
    error BaseBondOutOfBounds();
    error SlashPayoutBelowFloor();
    error DepositExceedsCap();
    error SlashAmountOutOfBounds();
    error ClaimNotExpired();
    error TopUpExceedsRequirement();
    
    error PolicyNotProspective();
    error PolicyAlreadyScheduled();
    error CostOutOfDomain();
    
    error ClaimUnderAdjudication();
    error InvalidSeed();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert OnlyAdmin();
        _;
    }

    modifier onlyCourt() {
        if (msg.sender != courtContract || courtContract == address(0)) revert OnlyCourt();
        _;
    }

    modifier onlyExecutor() {
        if (msg.sender != executor || executor == address(0)) revert OnlyExecutor();
        _;
    }

    constructor(
        address _admin,
        address _provianTechWallet,
        address _pvt,
        address _epochClock,
        address _issuanceIndex,
        SeedManifest memory seedManifest,
        BpsSeed[] memory seedBps
    ) RecourseInstitutionSeeds(_pvt, 2, seedManifest) {
        if (
            _admin == address(0) || _provianTechWallet == address(0) || _pvt == address(0)
                || _epochClock == address(0) || _issuanceIndex == address(0)
        ) {
            revert InvalidAddress();
        }
        admin = _admin;
        provianTechWallet = _provianTechWallet;
        pvt = IPVTBurnable(_pvt);
        epochClock = IEpochClock(_epochClock);
        issuanceIndex = IIssuanceIndex(_issuanceIndex);


        if (seedBps.length > 4) revert InvalidSeed();
        for (uint256 i = 0; i < seedBps.length; ++i) {
            _seedBpsSchedule(seedBps[i].param, seedBps[i].bps);
        }
    }

    function _applyCustodySeed(bytes calldata data) internal override returns (uint256) {
        BondSeed memory s = abi.decode(data, (BondSeed));
            if (
                s.agent == address(0) || (s.autonomyLevel != 2 && s.autonomyLevel != 3) || s.amount == 0
                    || s.requiredAtPost == 0 || s.createdAt == 0 || s.lastRenewalAt < s.createdAt
                    || s.renewalDeadline < s.lastRenewalAt || bonds[s.agent].status != BondStatus.None
            ) revert InvalidSeed();
            bonds[s.agent] = Bond({
                amount: s.amount,
                autonomyLevel: s.autonomyLevel,
                createdAt: s.createdAt,
                lastRenewalAt: s.lastRenewalAt,
                renewalDeadline: s.renewalDeadline,
                status: BondStatus.Active,
                pendingClaims: 0
            });
            requiredAtPost[s.agent] = s.requiredAtPost;
            encumberedPVT += s.amount;
            emit BondCarried(s.agent, s.amount, s.autonomyLevel, s.renewalDeadline);
        return s.amount;
    }

    function _seedBpsSchedule(uint8 param, uint256 bps) private {
        if (param == 0) {
            _writeEpochZeroSchedule(scheduledDepositBurnBps, depositBurnBpsEpochs, BOND_DEPOSIT_BURN_BPS_MAX, bps);
            emit DepositBurnBpsScheduled(0, bps);
        } else if (param == 1) {
            _writeEpochZeroSchedule(scheduledDepositFeeBps, depositFeeBpsEpochs, BOND_DEPOSIT_FEE_BPS_MAX, bps);
            emit DepositFeeBpsScheduled(0, bps);
        } else if (param == 2) {
            _writeEpochZeroSchedule(scheduledRenewalBurnBps, renewalBurnBpsEpochs, BOND_RENEWAL_BURN_BPS_MAX, bps);
            emit RenewalBurnBpsScheduled(0, bps);
        } else if (param == 3) {
            _writeEpochZeroSchedule(scheduledRenewalFeeBps, renewalFeeBpsEpochs, BOND_RENEWAL_FEE_BPS_MAX, bps);
            emit RenewalFeeBpsScheduled(0, bps);
        } else {
            revert InvalidSeed();
        }
    }

    function _writeEpochZeroSchedule(
        mapping(uint64 => ScheduledUint256) storage sched,
        uint64[] storage epochs,
        uint256 maxBps,
        uint256 bps
    ) private {
        if (bps > maxBps) revert CostOutOfDomain();
        if (sched[0].exists) revert PolicyAlreadyScheduled();
        sched[0] = ScheduledUint256({exists: true, value: bps});
        epochs.push(0);
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

    function indexedRequirements()
        external
        view
        returns (
            uint256 level2,
            uint256 level3,
            uint256 maxDeposit,
            uint256 processingFee,
            uint256 filingFee,
            uint256 trailingAverage
        )
    {
        (level2, level3) = _effBaseBonds();
        return (
            level2,
            level3,
            _effMaxBondDeposit(),
            _effClaimsProcessingFee(),
            _effClaimFilingFee(),
            _trailingIssuance()
        );
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

    function _resolvePair(
        mapping(uint64 => ScheduledPair) storage sched,
        uint64[] storage epochs
    ) private view returns (ScheduledPair memory) {
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
        if (!found) return ScheduledPair({exists: false, a: 0, b: 0});
        return sched[best];
    }

    function activeDepositBurnBps() public view returns (bool exists, uint256 value) {
        ScheduledUint256 memory r = _resolveActive(scheduledDepositBurnBps, depositBurnBpsEpochs);
        return (r.exists, r.value);
    }

    function activeDepositFeeBps() public view returns (bool exists, uint256 value) {
        ScheduledUint256 memory r = _resolveActive(scheduledDepositFeeBps, depositFeeBpsEpochs);
        return (r.exists, r.value);
    }

    function activeRenewalBurnBps() public view returns (bool exists, uint256 value) {
        ScheduledUint256 memory r = _resolveActive(scheduledRenewalBurnBps, renewalBurnBpsEpochs);
        return (r.exists, r.value);
    }

    function activeRenewalFeeBps() public view returns (bool exists, uint256 value) {
        ScheduledUint256 memory r = _resolveActive(scheduledRenewalFeeBps, renewalFeeBpsEpochs);
        return (r.exists, r.value);
    }

    function activeClaimsProcessingFee() public view returns (bool exists, uint256 value) {
        ScheduledUint256 memory r = _resolveActive(scheduledClaimsProcessingFee, claimsProcessingFeeEpochs);
        return (r.exists, r.value);
    }

    function activeClaimFilingFee() public view returns (bool exists, uint256 value) {
        ScheduledUint256 memory r = _resolveActive(scheduledClaimFilingFee, claimFilingFeeEpochs);
        return (r.exists, r.value);
    }

    function activeRenewalPeriod() public view returns (bool exists, uint256 value) {
        ScheduledUint256 memory r = _resolveActive(scheduledRenewalPeriod, renewalPeriodEpochs);
        return (r.exists, r.value);
    }

    function activeAbandonmentPeriod() public view returns (bool exists, uint256 value) {
        ScheduledUint256 memory r = _resolveActive(scheduledAbandonmentPeriod, abandonmentPeriodEpochs);
        return (r.exists, r.value);
    }

    function activeMaxBondDeposit() public view returns (bool exists, uint256 value) {
        ScheduledUint256 memory r = _resolveActive(scheduledMaxBondDeposit, maxBondDepositEpochs);
        return (r.exists, r.value);
    }

    function activeSlashShares() public view returns (bool exists, uint256 burnBps, uint256 payoutBps) {
        ScheduledPair memory r = _resolvePair(scheduledSlashShares, slashSharesEpochs);
        return (r.exists, r.a, r.b);
    }

    function activeBaseBonds() public view returns (bool exists, uint256 level2, uint256 level3) {
        ScheduledPair memory r = _resolvePair(scheduledBaseBonds, baseBondsEpochs);
        return (r.exists, r.a, r.b);
    }

    function _effDepositBurnBps() internal view returns (uint256) {
        (bool e, uint256 v) = activeDepositBurnBps();
        return e ? v : depositBurnBps;
    }

    function _effDepositFeeBps() internal view returns (uint256) {
        (bool e, uint256 v) = activeDepositFeeBps();
        return e ? v : depositFeeBps;
    }

    function _effRenewalBurnBps() internal view returns (uint256) {
        (bool e, uint256 v) = activeRenewalBurnBps();
        return e ? v : renewalBurnBps;
    }

    function _effRenewalFeeBps() internal view returns (uint256) {
        (bool e, uint256 v) = activeRenewalFeeBps();
        return e ? v : renewalFeeBps;
    }

    function _effClaimsProcessingFee() internal view returns (uint256) {
        (bool e, uint256 v) = activeClaimsProcessingFee();
        return _indexFloor(e ? v : claimsProcessingFee, CLAIMS_PROCESSING_FEE_INDEX_PPM, _trailingIssuance());
    }

    function _effClaimFilingFee() internal view returns (uint256) {
        (bool e, uint256 v) = activeClaimFilingFee();
        uint256 baseline = e ? v : claimFilingFee;
        uint256 derivedFloor =
            _indexFloor(0, CLAIMS_PROCESSING_FEE_INDEX_PPM, _trailingIssuance()) / 2;
        return derivedFloor > baseline ? derivedFloor : baseline;
    }

    function _effRenewalPeriod() internal view returns (uint256) {
        (bool e, uint256 v) = activeRenewalPeriod();
        return e ? v : renewalPeriod;
    }

    function _effAbandonmentPeriod() internal view returns (uint256) {
        (bool e, uint256 v) = activeAbandonmentPeriod();
        return e ? v : abandonmentPeriod;
    }

    function _effMaxBondDeposit() internal view returns (uint256) {
        (bool e, uint256 v) = activeMaxBondDeposit();
        uint256 avg = _trailingIssuance();
        uint256 floored = _indexFloor(e ? v : maxBondDeposit, MAX_DEPOSIT_INDEX_PPM, avg);
        (, uint256 effL3) = _effBaseBonds();
        return floored > effL3 ? floored : effL3;
    }

    function _effSlashShares() internal view returns (uint256 burnBps, uint256 payoutBps) {
        (bool e, uint256 b, uint256 p) = activeSlashShares();
        return e ? (b, p) : (slashBurnBps, slashPayoutBps);
    }

    function _effBaseBonds() internal view returns (uint256 level2, uint256 level3) {
        (bool e, uint256 a, uint256 b) = activeBaseBonds();
        (uint256 baseL2, uint256 baseL3) = e ? (a, b) : (level2BaseBond, level3BaseBond);
        uint256 avg = _trailingIssuance();
        return (
            _indexFloor(baseL2, LEVEL2_BOND_INDEX_PPM, avg),
            _indexFloor(baseL3, LEVEL3_BOND_INDEX_PPM, avg)
        );
    }

    function scheduleDepositBurnBps(uint64 effectiveEpoch, uint256 bps) external onlyExecutor whenCustodyReady {
        _requireScheduleEpoch(effectiveEpoch);
        if (bps > BOND_DEPOSIT_BURN_BPS_MAX) revert CostOutOfDomain();
        if (scheduledDepositBurnBps[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledDepositBurnBps[effectiveEpoch] = ScheduledUint256({exists: true, value: bps});
        depositBurnBpsEpochs.push(effectiveEpoch);
        emit DepositBurnBpsScheduled(effectiveEpoch, bps);
    }

    function scheduleDepositFeeBps(uint64 effectiveEpoch, uint256 bps) external onlyExecutor whenCustodyReady {
        _requireScheduleEpoch(effectiveEpoch);
        if (bps > BOND_DEPOSIT_FEE_BPS_MAX) revert CostOutOfDomain();
        if (scheduledDepositFeeBps[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledDepositFeeBps[effectiveEpoch] = ScheduledUint256({exists: true, value: bps});
        depositFeeBpsEpochs.push(effectiveEpoch);
        emit DepositFeeBpsScheduled(effectiveEpoch, bps);
    }

    function scheduleRenewalBurnBps(uint64 effectiveEpoch, uint256 bps) external onlyExecutor whenCustodyReady {
        _requireScheduleEpoch(effectiveEpoch);
        if (bps > BOND_RENEWAL_BURN_BPS_MAX) revert CostOutOfDomain();
        if (scheduledRenewalBurnBps[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledRenewalBurnBps[effectiveEpoch] = ScheduledUint256({exists: true, value: bps});
        renewalBurnBpsEpochs.push(effectiveEpoch);
        emit RenewalBurnBpsScheduled(effectiveEpoch, bps);
    }

    function scheduleRenewalFeeBps(uint64 effectiveEpoch, uint256 bps) external onlyExecutor whenCustodyReady {
        _requireScheduleEpoch(effectiveEpoch);
        if (bps > BOND_RENEWAL_FEE_BPS_MAX) revert CostOutOfDomain();
        if (scheduledRenewalFeeBps[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledRenewalFeeBps[effectiveEpoch] = ScheduledUint256({exists: true, value: bps});
        renewalFeeBpsEpochs.push(effectiveEpoch);
        emit RenewalFeeBpsScheduled(effectiveEpoch, bps);
    }

    function scheduleSlashShares(uint64 effectiveEpoch, uint256 burnBps, uint256 payoutBps) external onlyExecutor whenCustodyReady {
        _requireScheduleEpoch(effectiveEpoch);
        if (burnBps + payoutBps != MAX_BPS) revert SlashBpsInvariant();
        if (payoutBps < MIN_SLASH_PAYOUT_BPS) revert SlashPayoutBelowFloor();
        if (scheduledSlashShares[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledSlashShares[effectiveEpoch] = ScheduledPair({exists: true, a: burnBps, b: payoutBps});
        slashSharesEpochs.push(effectiveEpoch);
        emit SlashSharesScheduled(effectiveEpoch, burnBps, payoutBps);
    }

    function scheduleClaimsProcessingFee(uint64 effectiveEpoch, uint256 feeAtomic) external onlyExecutor whenCustodyReady {
        _requireScheduleEpoch(effectiveEpoch);
        if (feeAtomic > MAX_FEE) revert CostOutOfDomain(); 
        if (scheduledClaimsProcessingFee[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledClaimsProcessingFee[effectiveEpoch] = ScheduledUint256({exists: true, value: feeAtomic});
        claimsProcessingFeeEpochs.push(effectiveEpoch);
        emit ClaimsProcessingFeeScheduled(effectiveEpoch, feeAtomic);
    }

    function scheduleClaimFilingFee(uint64 effectiveEpoch, uint256 feeAtomic) external onlyExecutor whenCustodyReady {
        _requireScheduleEpoch(effectiveEpoch);
        if (feeAtomic > MAX_FILING_FEE) revert CostOutOfDomain(); 
        if (scheduledClaimFilingFee[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledClaimFilingFee[effectiveEpoch] = ScheduledUint256({exists: true, value: feeAtomic});
        claimFilingFeeEpochs.push(effectiveEpoch);
        emit ClaimFilingFeeScheduled(effectiveEpoch, feeAtomic);
    }

    function scheduleRenewalPeriod(uint64 effectiveEpoch, uint256 periodSeconds) external onlyExecutor whenCustodyReady {
        _requireScheduleEpoch(effectiveEpoch);
        if (periodSeconds < MIN_RENEWAL_PERIOD || periodSeconds > MAX_RENEWAL_PERIOD) revert CostOutOfDomain();
        if (scheduledRenewalPeriod[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledRenewalPeriod[effectiveEpoch] = ScheduledUint256({exists: true, value: periodSeconds});
        renewalPeriodEpochs.push(effectiveEpoch);
        emit RenewalPeriodScheduled(effectiveEpoch, periodSeconds);
    }

    function scheduleAbandonmentPeriod(uint64 effectiveEpoch, uint256 periodSeconds) external onlyExecutor whenCustodyReady {
        _requireScheduleEpoch(effectiveEpoch);
        if (periodSeconds < MIN_ABANDONMENT_PERIOD || periodSeconds > MAX_ABANDONMENT_PERIOD) revert CostOutOfDomain();
        if (scheduledAbandonmentPeriod[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledAbandonmentPeriod[effectiveEpoch] = ScheduledUint256({exists: true, value: periodSeconds});
        abandonmentPeriodEpochs.push(effectiveEpoch);
        emit AbandonmentPeriodScheduled(effectiveEpoch, periodSeconds);
    }

    function scheduleBaseBonds(uint64 effectiveEpoch, uint256 newLevel2, uint256 newLevel3) external onlyExecutor whenCustodyReady {
        _requireScheduleEpoch(effectiveEpoch);
        if (newLevel2 < MIN_BASE_BOND || newLevel2 > MAX_BASE_BOND) revert BaseBondOutOfBounds();
        if (newLevel3 < MIN_BASE_BOND || newLevel3 > MAX_BASE_BOND) revert BaseBondOutOfBounds();
        if (newLevel3 < newLevel2) revert BaseBondOutOfBounds();
        if (scheduledBaseBonds[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledBaseBonds[effectiveEpoch] = ScheduledPair({exists: true, a: newLevel2, b: newLevel3});
        baseBondsEpochs.push(effectiveEpoch);
        emit BaseBondsScheduled(effectiveEpoch, newLevel2, newLevel3);
    }

    function scheduleMaxBondDeposit(uint64 effectiveEpoch, uint256 newMax) external onlyExecutor whenCustodyReady {
        _requireScheduleEpoch(effectiveEpoch);
        if (newMax < MIN_MAX_BOND_DEPOSIT || newMax > MAX_MAX_BOND_DEPOSIT) revert CostOutOfDomain();
        (, uint256 effL3) = _effBaseBonds();
        if (newMax < effL3) revert ParameterOutOfBounds();
        if (scheduledMaxBondDeposit[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledMaxBondDeposit[effectiveEpoch] = ScheduledUint256({exists: true, value: newMax});
        maxBondDepositEpochs.push(effectiveEpoch);
        emit MaxBondDepositScheduled(effectiveEpoch, newMax);
    }

    function postBond(uint8 autonomyLevel, uint256 trustDiscountBps) external whenCustodyReady {
        if (autonomyLevel != 2 && autonomyLevel != 3) revert InvalidAutonomyLevel();
        if (trustDiscountBps > MAX_TRUST_DISCOUNT) revert InvalidTrustDiscount();
        if (bonds[msg.sender].status == BondStatus.Active) revert BondAlreadyExists();

        if (bonds[msg.sender].pendingClaims != 0) revert ClaimsPending();

        uint256 requiredBond = getRequiredBond(autonomyLevel, trustDiscountBps);

        uint256 effDepositBurn = _effDepositBurnBps();
        uint256 effDepositFee = _effDepositFeeBps();

        uint256 depositRemainingBps = MAX_BPS - effDepositBurn - effDepositFee;
        uint256 totalDeposit = (requiredBond * MAX_BPS + depositRemainingBps - 1) / depositRemainingBps;

        if (totalDeposit == 0) revert InvalidAmount();
        if (totalDeposit > _effMaxBondDeposit()) revert DepositExceedsCap();

        bool ok = pvt.transferFrom(msg.sender, address(this), totalDeposit);
        if (!ok) revert TransferFailed();

        uint256 burnAmount = (totalDeposit * effDepositBurn) / MAX_BPS;
        uint256 feeAmount = (totalDeposit * effDepositFee) / MAX_BPS;
        uint256 lockedAmount = totalDeposit - burnAmount - feeAmount;
        encumberedPVT += lockedAmount;

        pvt.burn(burnAmount);

        bool feeOk = pvt.transfer(provianTechWallet, feeAmount);
        if (!feeOk) revert TransferFailed();

        bonds[msg.sender] = Bond({
            amount: lockedAmount,
            autonomyLevel: autonomyLevel,
            createdAt: block.timestamp,
            lastRenewalAt: block.timestamp,
            renewalDeadline: block.timestamp + _effRenewalPeriod(),
            status: BondStatus.Active,
            pendingClaims: 0
        });

        requiredAtPost[msg.sender] = getRequiredBond(autonomyLevel, 0);

        emit BondPosted(msg.sender, totalDeposit, lockedAmount, autonomyLevel);
    }

    function renewBond() external whenCustodyReady {
        Bond storage bond = bonds[msg.sender];
        if (bond.status != BondStatus.Active) revert BondNotActive();

        uint256 burnAmount = (bond.amount * _effRenewalBurnBps()) / MAX_BPS;
        uint256 feeAmount = (bond.amount * _effRenewalFeeBps()) / MAX_BPS;
        uint256 totalCost = burnAmount + feeAmount;

        if (bond.amount <= totalCost) revert InsufficientBond();

        bond.amount -= totalCost;
        encumberedPVT -= totalCost;

        pvt.burn(burnAmount);

        bool feeOk = pvt.transfer(provianTechWallet, feeAmount);
        if (!feeOk) revert TransferFailed();

        bond.lastRenewalAt = block.timestamp;
        bond.renewalDeadline = block.timestamp + _effRenewalPeriod();

        emit BondRenewed(msg.sender, bond.renewalDeadline);
    }

    function topUpBond(uint256 amount) external whenCustodyReady {
        Bond storage bond = bonds[msg.sender];
        if (bond.status != BondStatus.Active) revert BondNotActive();
        if (amount == 0) revert InvalidAmount();

        uint256 requiredLock = requiredAtPost[msg.sender];
        if (bond.amount + amount > requiredLock) revert TopUpExceedsRequirement();

        bool ok = pvt.transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();

        bond.amount += amount;
        encumberedPVT += amount;

        emit BondToppedUp(msg.sender, amount, bond.amount);
    }

    function withdrawBond() external whenCustodyReady {
        Bond storage bond = bonds[msg.sender];
        if (bond.status != BondStatus.Active) revert BondNotActive();
        if (bond.pendingClaims > 0) revert ClaimsPending();

        uint256 returnAmount = bond.amount;
        encumberedPVT -= returnAmount;
        bond.amount = 0;
        bond.status = BondStatus.Withdrawn;

        bool ok = pvt.transfer(msg.sender, returnAmount);
        if (!ok) revert TransferFailed();

        emit BondWithdrawn(msg.sender, returnAmount);
    }

    function fileClaim(address agent, bytes32 claimId) external whenCustodyReady {
        if (msg.sender == agent) revert SelfClaimNotAllowed();
        if (claimExists[claimId]) revert ClaimAlreadyExists();
        if (bonds[agent].status != BondStatus.Active) revert BondNotActive();

        uint256 effFilingFee = _effClaimFilingFee();
        
        bool ok = pvt.transferFrom(msg.sender, address(this), effFilingFee);
        if (!ok) revert TransferFailed();
        encumberedPVT += effFilingFee;

        claims[claimId] = Claim({
            claimant: msg.sender,
            agent: agent,
            filingFee: effFilingFee,
            status: ClaimStatus.Filed,
            filedAt: block.timestamp
        });
        claimExists[claimId] = true;

        bonds[agent].pendingClaims += 1;

        emit ClaimFiled(claimId, msg.sender, agent);
    }

    function slashBond(
        address agent,
        uint256 slashAmount,
        bytes32 claimId
    ) external onlyCourt whenCustodyReady {
        Bond storage bond = bonds[agent];
        if (bond.status != BondStatus.Active) revert BondNotActive();

        Claim storage claim = claims[claimId];
        if (!claimExists[claimId]) revert ClaimNotFound();
        if (claim.status != ClaimStatus.Filed) revert ClaimAlreadyResolved();
        if (claim.agent != agent) revert InvalidAddress();

        uint256 slashFloor = (bond.amount * MIN_SLASH_PAYOUT_BPS) / MAX_BPS;
        if (slashAmount < slashFloor || slashAmount > bond.amount) {
            revert SlashAmountOutOfBounds();
        }
        uint256 actualSlash = slashAmount;

        (, uint256 effPayoutBps) = _effSlashShares();
        uint256 claimantAmount = (actualSlash * effPayoutBps) / MAX_BPS;
        uint256 burnAmount = actualSlash - claimantAmount;

        bond.amount -= actualSlash;
        encumberedPVT -= actualSlash + claim.filingFee;
        bond.pendingClaims -= 1;
        claim.status = ClaimStatus.Upheld;

        pvt.burn(burnAmount);

        uint256 totalToClaimant = claimantAmount + claim.filingFee;
        bool payOk = pvt.transfer(claim.claimant, totalToClaimant);
        if (!payOk) revert TransferFailed();

        uint256 effProcessingFee = _effClaimsProcessingFee();
        if (bond.amount >= effProcessingFee) {
            bond.amount -= effProcessingFee;
            encumberedPVT -= effProcessingFee;
            bool feeOk = pvt.transfer(courtContract, effProcessingFee);
            if (!feeOk) revert TransferFailed();
            IArbitratorRewardSink(courtContract).fundBondClaimReward(claimId, effProcessingFee);
        }

        uint256 required = requiredAtPost[agent];
        if (bond.amount < required) {
            emit AutonomyDowngrade(agent, bond.amount, required);
        }

        emit BondSlashed(agent, claimId, claim.claimant, claimantAmount, burnAmount);
    }

    function dismissClaim(address agent, bytes32 claimId) external onlyCourt whenCustodyReady {
        Claim storage claim = claims[claimId];
        if (!claimExists[claimId]) revert ClaimNotFound();
        if (claim.status != ClaimStatus.Filed) revert ClaimAlreadyResolved();
        if (claim.agent != agent) revert InvalidAddress();

        claim.status = ClaimStatus.Dismissed;
        bonds[agent].pendingClaims -= 1;

        encumberedPVT -= claim.filingFee;
        pvt.burn(claim.filingFee);

        Bond storage bond = bonds[agent];
        uint256 effProcessingFee = _effClaimsProcessingFee();
        if (bond.amount >= effProcessingFee) {
            bond.amount -= effProcessingFee;
            encumberedPVT -= effProcessingFee;
            bool feeOk = pvt.transfer(courtContract, effProcessingFee);
            if (!feeOk) revert TransferFailed();
            IArbitratorRewardSink(courtContract).fundBondClaimReward(claimId, effProcessingFee);
        }

        emit ClaimDismissed(claimId, agent);
    }

    function dismissClaimUnadjudicated(address agent, bytes32 claimId) external onlyCourt whenCustodyReady {
        Claim storage claim = claims[claimId];
        if (!claimExists[claimId]) revert ClaimNotFound();
        if (claim.status != ClaimStatus.Filed) revert ClaimAlreadyResolved();
        if (claim.agent != agent) revert InvalidAddress();

        claim.status = ClaimStatus.Dismissed;
        bonds[agent].pendingClaims -= 1;

        uint256 refund = claim.filingFee;
        encumberedPVT -= refund;
        bool ok = pvt.transfer(claim.claimant, refund);
        if (!ok) revert TransferFailed();

        emit ClaimClosedUnadjudicated(claimId, agent, claim.claimant, refund);
    }

    function expireStaleClaim(bytes32 claimId) external whenCustodyReady {
        Claim storage claim = claims[claimId];
        if (!claimExists[claimId]) revert ClaimNotFound();
        if (claim.status != ClaimStatus.Filed) revert ClaimAlreadyResolved();
        if (block.timestamp < claim.filedAt + CLAIM_RESOLUTION_TIMEOUT) revert ClaimNotExpired();

        if (courtContract != address(0) && IBondClaimCourt(courtContract).bondClaimCaseOpen(claimId)) {
            revert ClaimUnderAdjudication();
        }

        address agent = claim.agent;
        claim.status = ClaimStatus.Dismissed;
        bonds[agent].pendingClaims -= 1;

        encumberedPVT -= claim.filingFee;
        pvt.burn(claim.filingFee);

        emit ClaimExpired(claimId, agent);
    }

    function processAbandonment(address agent) external whenCustodyReady {
        Bond storage bond = bonds[agent];
        if (bond.status != BondStatus.Active) revert BondNotActive();

        if (block.timestamp < bond.renewalDeadline + renewalGracePeriod + _effAbandonmentPeriod()) {
            revert GracePeriodNotExpired();
        }

        if (bond.pendingClaims > 0) revert ClaimsPending();

        uint256 burnAmount = bond.amount;
        encumberedPVT -= burnAmount;
        bond.amount = 0;
        bond.status = BondStatus.Abandoned;

        pvt.burn(burnAmount);

        emit BondAbandoned(agent, burnAmount);
    }

    function getRequiredBond(uint8 autonomyLevel, uint256 trustDiscountBps) public view returns (uint256) {

        (uint256 effL2, uint256 effL3) = _effBaseBonds();
        uint256 baseBond;
        if (autonomyLevel == 2) {
            baseBond = effL2;
        } else if (autonomyLevel == 3) {
            baseBond = effL3;
        } else {
            return 0;
        }

        if (trustDiscountBps > MAX_TRUST_DISCOUNT) {
            trustDiscountBps = MAX_TRUST_DISCOUNT;
        }

        return (baseBond * (MAX_BPS - trustDiscountBps)) / MAX_BPS;
    }

    function isBondHealthy(address agent) external view returns (bool) {
        Bond storage bond = bonds[agent];
        return bond.status == BondStatus.Active && block.timestamp <= bond.renewalDeadline;
    }

    function setCourtContract(address _court) external onlyAdmin whenCustodyReady {
        if (courtContractSet) revert CourtAlreadySet();
        if (_court == address(0)) revert InvalidAddress();
        courtContract = _court;
        courtContractSet = true;
        emit CourtContractSet(_court);
    }

    function setExecutor(address _executor) external onlyAdmin whenCustodyReady {
        if (executorSet) revert ExecutorAlreadySet();
        if (_executor == address(0)) revert InvalidAddress();
        executor = _executor;
        executorSet = true;
        emit ExecutorWired(_executor);
    }

    function transferAdmin(address newAdmin) external onlyAdmin whenCustodyReady {
        if (newAdmin == address(0)) revert InvalidAddress();
        address oldAdmin = admin;
        admin = newAdmin;
        emit AdminTransferred(oldAdmin, newAdmin);
    }
}
