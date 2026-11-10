// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Successor institution with explicit PVT custody obligations.
/// Direct donations do not increase obligations; recorded exits remain backed.

import {IEpochClock} from "./interfaces/IEpochClock.sol";
import {IIssuanceIndex} from "./interfaces/IIssuanceIndex.sol";
import {IPVTBurnable} from "./interfaces/IPVTBurnable.sol";

interface IProvianEscrowV3 {
    function resolveDispute(bytes32 escrowId, bool releaseToRecipient) external;
    function getParties(bytes32 escrowId) external view returns (address depositor, address recipient);
    
    function disputeSettledAt(bytes32 escrowId) external view returns (uint256);
}

interface IProvianBondPool {
    function claims(bytes32 claimId) external view returns (
        address claimant, address agent, uint256 filingFee, uint8 status, uint256 filedAt
    );
    function claimExists(bytes32 claimId) external view returns (bool);
    function bonds(address agent) external view returns (
        uint256 amount, uint8 autonomyLevel, uint256 createdAt, uint256 lastRenewalAt,
        uint256 renewalDeadline, uint8 status, uint256 pendingClaims
    );
    function MIN_SLASH_PAYOUT_BPS() external view returns (uint256);
    function MAX_BPS() external view returns (uint256);
    function slashBond(address agent, uint256 slashAmount, bytes32 claimId) external;
    function dismissClaim(address agent, bytes32 claimId) external;

    function dismissClaimUnadjudicated(address agent, bytes32 claimId) external;
}

contract ProvianRecourseCourt {

    enum DisputeStatus {
        Pending,    
        Resolved,   
        Escalated   
    }

    struct Dispute {
        bytes32 escrowId;
        address[3] panel;
        mapping(address => bool) hasVoted;
        uint8 votesForRelease;
        uint8 votesForRefund;
        uint256 votingDeadline;
        DisputeStatus status;
    }

    enum BondVerdictVote {
        None,         
        Dismiss,      
        SlashPartial, 
        SlashFull     
    }

    struct BondDispute {
        bytes32 claimId;               
        address agent;                 
        address[3] panel;
        mapping(address => bool) hasVoted;
        uint8 votesDismiss;
        uint8 votesPartial;
        uint8 votesFull;
        uint256 votingDeadline;
        DisputeStatus status;
    }

    uint8 private constant CLAIM_FILED = 0;

    mapping(bytes32 => Dispute) internal disputes;
    mapping(bytes32 => bool) public disputeExists;
    address public admin;
    IProvianEscrowV3 public escrowContract;

    IProvianBondPool public bondPool;
    bool private bondPoolSet;
    mapping(bytes32 => BondDispute) internal bondDisputes; 
    mapping(bytes32 => bool) public bondDisputeExists;

    struct ScheduledUint256 {
        bool exists;
        uint256 value;
    }

    IEpochClock public immutable epochClock;

    IPVTBurnable public immutable pvt;
    
    uint256 public encumberedPVT;

    IIssuanceIndex public immutable issuanceIndex;

    uint8 internal constant CASE_ESCROW = 1;
    uint8 internal constant CASE_BOND = 2;

    uint256 public constant ARBITRATOR_COLLATERAL_BASELINE = 750e18;
    uint256 public constant ARBITRATOR_COLLATERAL_INDEX_PPM = 75;
    uint256 public constant ARBITRATOR_COLLATERAL_DIVISOR = 10;
    uint256 public constant INDEX_PPM_DENOMINATOR = 1_000_000;

    uint256 public constant PANEL_POSTING_WINDOW_MIN = 6 hours;
    uint256 public constant PANEL_POSTING_WINDOW_MAX = 7 days;
    uint256 public constant DEFAULT_PANEL_POSTING_WINDOW = 1 days;
    mapping(uint64 => ScheduledUint256) public scheduledPanelPostingWindow;
    uint64[] public panelPostingWindowEpochs;

    uint8 public constant MAX_REPLACEMENT_ROUNDS = 3;

    struct PanelPosting {
        bool exists;
        uint8 postedMask;
        uint8 round;
        uint64 postingDeadline;
        uint256 requiredCollateral;
        uint256[3] postedAmount;
    }

    mapping(bytes32 => PanelPosting) internal panelPostings;

    mapping(bytes32 => bool) public resolvedByDeadline;

    mapping(bytes32 => bool) public settledOutsideCourt;

    mapping(bytes32 => uint256) public bondRewardSharePerSeat;
    
    mapping(bytes32 => bool) public bondRewardFunded;

    mapping(bytes32 => uint256) public escrowRewardSharePerSeat;

    mapping(bytes32 => bool) public escrowRewardFunded;

    mapping(bytes32 => uint64) public escrowRewardFundedAt;

    mapping(bytes32 => bool) public escrowRewardSwept;

    uint256 public constant UNASSIGNED_REWARD_BURN_DELAY =
        (1 + uint256(MAX_REPLACEMENT_ROUNDS)) * PANEL_POSTING_WINDOW_MAX + PANEL_VOTING_PERIOD_MAX;

    uint256 public constant PANEL_VOTING_PERIOD_MIN = 1 days;   
    uint256 public constant PANEL_VOTING_PERIOD_MAX = 14 days;  

    uint256 public constant DEFAULT_PANEL_VOTING_PERIOD = 48 hours; 
    mapping(uint64 => ScheduledUint256) public scheduledPanelVotingPeriod;

    uint64[] public panelVotingPeriodEpochs;

    event PanelAssigned(bytes32 indexed escrowId, address arb0, address arb1, address arb2, uint256 votingDeadline);
    event VoteCast(bytes32 indexed escrowId, address indexed arbitrator, bool releaseToRecipient);
    event Verdict(bytes32 indexed escrowId, bool releaseToRecipient, uint8 votesForRelease, uint8 votesForRefund);
    event Escalated(bytes32 indexed escrowId);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);

    event BondPoolSet(address indexed bondPool);
    event BondPanelAssigned(bytes32 indexed claimId, address indexed agent, address arb0, address arb1, address arb2, uint256 votingDeadline);
    event BondVoteCast(bytes32 indexed claimId, address indexed arbitrator, BondVerdictVote verdict);
    event BondClaimResolved(bytes32 indexed claimId, address indexed agent, BondVerdictVote verdict, uint256 slashAmount);

    event PanelVotingPeriodScheduled(uint64 indexed effectiveEpoch, uint256 periodSeconds);

    event PanelPostingWindowScheduled(uint64 indexed effectiveEpoch, uint256 windowSeconds);
    event ArbitratorCollateralPosted(
        bytes32 indexed caseKey, address indexed arbitrator, uint8 seat, uint256 amount
    );

    event ArbitratorSeatForfeited(
        bytes32 indexed caseKey, address indexed arbitrator, uint8 seat, uint8 round
    );
    event ArbitratorSeatReplaced(
        bytes32 indexed caseKey, address indexed oldArbitrator, address indexed newArbitrator, uint8 seat, uint8 round
    );
    event PanelFullyPosted(bytes32 indexed caseKey, uint256 votingDeadline);
    event ArbitratorCollateralReturned(
        bytes32 indexed caseKey, address indexed arbitrator, uint8 seat, uint256 amount
    );

    event ArbitratorCollateralSlashed(
        bytes32 indexed caseKey, address indexed arbitrator, uint8 seat, uint256 amount
    );
    event PanelAssemblyFailed(bytes32 indexed caseKey, uint8 rounds);

    event BondClaimRewardFunded(
        bytes32 indexed caseKey, uint256 totalAmount, uint256 sharePerSeat, uint256 burnedDust
    );
    
    event ArbitratorRewardPaid(
        bytes32 indexed caseKey, address indexed arbitrator, uint8 seat, uint256 amount
    );

    event ArbitratorRewardForfeited(
        bytes32 indexed caseKey, address indexed arbitrator, uint8 seat, uint256 amount
    );

    event EscrowDisputeRewardFunded(
        bytes32 indexed caseKey, uint256 totalAmount, uint256 sharePerSeat, uint256 burnedDust
    );

    event EscrowRewardSwept(bytes32 indexed caseKey, uint8 seats, uint256 burnedAmount);
    
    event DisputeSettledOutsideCourt(bytes32 indexed escrowId, uint256 settledAt, bool ranToVotingDeadline);

    error OnlyAdmin();
    error InvalidAddress();
    error DisputeAlreadyExists();
    error DisputeNotFound();
    error NotPanelMember();
    error AlreadyVoted();
    error VotingClosed();
    error VotingNotExpired();
    error DisputeNotPending();
    error DuplicateArbitrator();
    error ArbitratorIsParty();
    
    error BondPoolNotSet();
    error BondPoolAlreadySet();
    error BondClaimNotFiled();
    error InvalidBondVerdict();
    
    error PolicyNotProspective();
    error PolicyAlreadyScheduled();
    error CostOutOfDomain();
    
    error CollateralAlreadyPosted();
    error CollateralNotPosted();
    error PostingWindowClosed();
    error PostingWindowStillOpen();
    error PanelNotFullyPosted();
    error PanelAlreadyFullyPosted();
    error ReplacementRoundsExhausted();
    error PanelStillAssemblable();
    error SeatAlreadyPosted();
    error InvalidSeat();
    error CaseNotTerminal();
    error TransferFailed();
    
    error NotBondPool();
    error RewardAlreadyFunded();
    
    error NotEscrow();
    error AdjudicationFeeNotPaid();
    error RewardNotFunded();
    error RewardAlreadySwept();
    error NothingUnclaimable();
    error SweepDelayNotElapsed();
    
    error EscrowSettledOutsideCourt();
    error EscrowNotSettledOutsideCourt();

    constructor(
        address _admin,
        address _escrowContract,
        address _epochClock,
        address _pvt,
        address _issuanceIndex
    ) {
        if (
            _admin == address(0) || _escrowContract == address(0) || _epochClock == address(0)
                || _pvt == address(0) || _issuanceIndex == address(0)
        ) {
            revert InvalidAddress();
        }
        admin = _admin;
        escrowContract = IProvianEscrowV3(_escrowContract);
        epochClock = IEpochClock(_epochClock);
        pvt = IPVTBurnable(_pvt);
        issuanceIndex = IIssuanceIndex(_issuanceIndex);
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

    function activePanelVotingPeriod() public view returns (bool exists, uint256 value) {
        ScheduledUint256 memory a = _resolveActive(scheduledPanelVotingPeriod, panelVotingPeriodEpochs);
        return (a.exists, a.value);
    }

    function _panelVotingPeriod() internal view returns (uint256) {
        (bool exists, uint256 value) = activePanelVotingPeriod();
        return exists ? value : DEFAULT_PANEL_VOTING_PERIOD;
    }

    function schedulePanelVotingPeriod(uint64 effectiveEpoch, uint256 periodSeconds) external onlyAdmin {
        _requireScheduleEpoch(effectiveEpoch);
        if (periodSeconds < PANEL_VOTING_PERIOD_MIN || periodSeconds > PANEL_VOTING_PERIOD_MAX) revert CostOutOfDomain();
        if (scheduledPanelVotingPeriod[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledPanelVotingPeriod[effectiveEpoch] = ScheduledUint256({exists: true, value: periodSeconds});
        panelVotingPeriodEpochs.push(effectiveEpoch);
        emit PanelVotingPeriodScheduled(effectiveEpoch, periodSeconds);
    }

    function activePanelPostingWindow() public view returns (bool exists, uint256 value) {
        ScheduledUint256 memory a = _resolveActive(scheduledPanelPostingWindow, panelPostingWindowEpochs);
        return (a.exists, a.value);
    }

    function _panelPostingWindow() internal view returns (uint256) {
        (bool exists, uint256 value) = activePanelPostingWindow();
        return exists ? value : DEFAULT_PANEL_POSTING_WINDOW;
    }

    function schedulePanelPostingWindow(uint64 effectiveEpoch, uint256 windowSeconds) external onlyAdmin {
        _requireScheduleEpoch(effectiveEpoch);
        if (windowSeconds < PANEL_POSTING_WINDOW_MIN || windowSeconds > PANEL_POSTING_WINDOW_MAX) {
            revert CostOutOfDomain();
        }
        if (scheduledPanelPostingWindow[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledPanelPostingWindow[effectiveEpoch] = ScheduledUint256({exists: true, value: windowSeconds});
        panelPostingWindowEpochs.push(effectiveEpoch);
        emit PanelPostingWindowScheduled(effectiveEpoch, windowSeconds);
    }

    function _trailingIssuance() internal view returns (uint256) {
        try issuanceIndex.trailingAverageForEpoch(_currentEpoch()) returns (uint256 avg) {
            return avg;
        } catch {
            return 0;
        }
    }

    function arbitratorCollateral() public view returns (uint256) {
        uint256 avg = _trailingIssuance();
        uint256 fromIndex = (ARBITRATOR_COLLATERAL_INDEX_PPM * avg) / INDEX_PPM_DENOMINATOR;
        uint256 base = fromIndex > ARBITRATOR_COLLATERAL_BASELINE ? fromIndex : ARBITRATOR_COLLATERAL_BASELINE;
        return base / ARBITRATOR_COLLATERAL_DIVISOR;
    }

    function _caseKey(uint8 family, bytes32 id) internal pure returns (bytes32) {
        return keccak256(abi.encode(family, id));
    }

    function _armPosting(bytes32 caseKey) internal {
        PanelPosting storage p = panelPostings[caseKey];
        p.exists = true;
        p.postedMask = 0;
        p.round = 0;
        p.postingDeadline = uint64(block.timestamp + _panelPostingWindow());
        p.requiredCollateral = arbitratorCollateral();
    }

    function _fullyPosted(PanelPosting storage p) internal view returns (bool) {
        return p.postedMask == 0x7;
    }

    function _assemblyFailed(PanelPosting storage p) internal view returns (bool) {
        return p.exists && !_fullyPosted(p) && p.round >= MAX_REPLACEMENT_ROUNDS
            && block.timestamp > p.postingDeadline;
    }

    function _bondPanelAbandoned(PanelPosting storage p) internal view returns (bool) {
        return p.exists && !_fullyPosted(p)
            && block.timestamp >= uint256(p.postingDeadline) + UNASSIGNED_REWARD_BURN_DELAY;
    }

    function _syncOutsideSettlement(bytes32 escrowId) internal returns (bool) {
        Dispute storage d = disputes[escrowId];
        if (d.status != DisputeStatus.Pending) return false;
        uint256 settledAt = escrowContract.disputeSettledAt(escrowId);
        if (settledAt == 0) return false;
        bytes32 caseKey = _caseKey(CASE_ESCROW, escrowId);
        bool ranToDeadline = _fullyPosted(panelPostings[caseKey]) && settledAt > d.votingDeadline;
        if (ranToDeadline) resolvedByDeadline[caseKey] = true;
        d.status = DisputeStatus.Resolved;
        settledOutsideCourt[caseKey] = true;
        emit DisputeSettledOutsideCourt(escrowId, settledAt, ranToDeadline);
        return true;
    }

    function _requireEscrowStillDisputed(bytes32 escrowId) internal view {
        if (escrowContract.disputeSettledAt(escrowId) != 0) revert EscrowSettledOutsideCourt();
    }

    function closeExternallySettledDispute(bytes32 escrowId) external {
        if (!disputeExists[escrowId]) revert DisputeNotFound();
        if (!_syncOutsideSettlement(escrowId)) revert EscrowNotSettledOutsideCourt();
    }

    function bondClaimCaseOpen(bytes32 claimId) external view returns (bool) {
        return bondDisputeExists[claimId] && bondDisputes[claimId].status == DisputeStatus.Pending;
    }

    function _seatOf(address[3] storage panel, address who) internal view returns (uint8 seat, bool found) {
        for (uint8 i = 0; i < 3; i++) {
            if (panel[i] == who) return (i, true);
        }
        return (0, false);
    }

    function _postCollateral(bytes32 caseKey, address[3] storage panel, uint256 votingPeriod)
        internal
        returns (bool nowFull, uint256 votingDeadline)
    {
        PanelPosting storage p = panelPostings[caseKey];
        if (!p.exists) revert DisputeNotFound();
        if (_fullyPosted(p)) revert PanelAlreadyFullyPosted();
        if (block.timestamp > p.postingDeadline) revert PostingWindowClosed();

        (uint8 seat, bool found) = _seatOf(panel, msg.sender);
        if (!found) revert NotPanelMember();
        if (p.postedAmount[seat] != 0) revert SeatAlreadyPosted();

        uint256 amount = p.requiredCollateral;
        bool ok = pvt.transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();

        p.postedAmount[seat] = amount;
        encumberedPVT += amount;
        p.postedMask |= uint8(1 << seat);

        emit ArbitratorCollateralPosted(caseKey, msg.sender, seat, amount);

        if (_fullyPosted(p)) {
            return (true, block.timestamp + votingPeriod);
        }
        return (false, 0);
    }

    function _replaceSeat(
        bytes32 caseKey,
        address[3] storage panel,
        uint8 seat,
        address newArb,
        address partyA,
        address partyB
    ) internal {
        PanelPosting storage p = panelPostings[caseKey];
        if (!p.exists) revert DisputeNotFound();
        if (seat > 2) revert InvalidSeat();
        if (_fullyPosted(p)) revert PanelAlreadyFullyPosted();
        if (p.postedAmount[seat] != 0) revert SeatAlreadyPosted();
        if (newArb == address(0)) revert InvalidAddress();

        bool windowLapsed = block.timestamp > p.postingDeadline;
        if (!windowLapsed && p.round == 0) revert PostingWindowStillOpen();

        if (newArb == partyA || newArb == partyB) revert ArbitratorIsParty();
        for (uint8 i = 0; i < 3; i++) {
            if (i != seat && panel[i] == newArb) revert DuplicateArbitrator();
        }

        if (windowLapsed) {
            uint8 nextRound = p.round + 1;
            if (nextRound > MAX_REPLACEMENT_ROUNDS) revert ReplacementRoundsExhausted();
            p.round = nextRound;
            p.postingDeadline = uint64(block.timestamp + _panelPostingWindow());
        }

        address old = panel[seat];
        panel[seat] = newArb;

        emit ArbitratorSeatForfeited(caseKey, old, seat, p.round);
        emit ArbitratorSeatReplaced(caseKey, old, newArb, seat, p.round);
    }

    function settleArbitratorCollateral(uint8 family, bytes32 id, uint8 seat) external {
        if (seat > 2) revert InvalidSeat();
        bytes32 caseKey = _caseKey(family, id);
        PanelPosting storage p = panelPostings[caseKey];
        if (!p.exists) revert DisputeNotFound();

        uint256 amount = p.postedAmount[seat];
        if (amount == 0) revert CollateralNotPosted();

        address arb;
        bool terminal;
        bool voted;
        if (family == CASE_ESCROW) {
            if (!disputeExists[id]) revert DisputeNotFound();
            _syncOutsideSettlement(id);
            Dispute storage d = disputes[id];
            arb = d.panel[seat];
            terminal = d.status != DisputeStatus.Pending || _assemblyFailed(p);
            voted = d.hasVoted[arb];
        } else if (family == CASE_BOND) {
            if (!bondDisputeExists[id]) revert DisputeNotFound();
            BondDispute storage d = bondDisputes[id];
            arb = d.panel[seat];
            terminal = d.status != DisputeStatus.Pending || _assemblyFailed(p);
            voted = d.hasVoted[arb];
        } else {
            revert InvalidSeat();
        }
        if (!terminal) revert CaseNotTerminal();

        p.postedAmount[seat] = 0;
        encumberedPVT -= amount;

        if (resolvedByDeadline[caseKey] && !voted) {
            pvt.burn(amount);
            emit ArbitratorCollateralSlashed(caseKey, arb, seat, amount);
        } else {
            bool ok = pvt.transfer(arb, amount);
            if (!ok) revert TransferFailed();
            emit ArbitratorCollateralReturned(caseKey, arb, seat, amount);
        }

        uint256 rewardShare = family == CASE_BOND
            ? bondRewardSharePerSeat[caseKey]
            : escrowRewardSharePerSeat[caseKey];
        if (rewardShare != 0) {
            encumberedPVT -= rewardShare;
            if (voted) {
                bool rok = pvt.transfer(arb, rewardShare);
                if (!rok) revert TransferFailed();
                emit ArbitratorRewardPaid(caseKey, arb, seat, rewardShare);
            } else {
                pvt.burn(rewardShare);
                emit ArbitratorRewardForfeited(caseKey, arb, seat, rewardShare);
            }
        }
    }

    function fundBondClaimReward(bytes32 claimId, uint256 amount) external {
        if (msg.sender != address(bondPool)) revert NotBondPool();
        bytes32 caseKey = _caseKey(CASE_BOND, claimId);
        if (bondRewardFunded[caseKey]) revert RewardAlreadyFunded();
        bondRewardFunded[caseKey] = true;

        uint256 share = amount / 3;
        bondRewardSharePerSeat[caseKey] = share;
        encumberedPVT += share * 3;
        uint256 dust = amount - share * 3;
        if (dust != 0) pvt.burn(dust);

        emit BondClaimRewardFunded(caseKey, amount, share, dust);
    }

    function fundEscrowDisputeReward(bytes32 escrowId, uint256 amount) external {
        if (msg.sender != address(escrowContract)) revert NotEscrow();
        bytes32 caseKey = _caseKey(CASE_ESCROW, escrowId);
        if (escrowRewardFunded[caseKey]) revert RewardAlreadyFunded();
        escrowRewardFunded[caseKey] = true;
        escrowRewardFundedAt[caseKey] = uint64(block.timestamp);

        uint256 share = amount / 3;
        escrowRewardSharePerSeat[caseKey] = share;
        encumberedPVT += share * 3;
        uint256 dust = amount - share * 3;
        if (dust != 0) pvt.burn(dust);

        emit EscrowDisputeRewardFunded(caseKey, amount, share, dust);
    }

    function burnUnclaimableEscrowReward(bytes32 escrowId) external {
        bytes32 caseKey = _caseKey(CASE_ESCROW, escrowId);
        if (!escrowRewardFunded[caseKey]) revert RewardNotFunded();
        if (escrowRewardSwept[caseKey]) revert RewardAlreadySwept();

        uint8 unclaimable;
        if (!disputeExists[escrowId]) {
            if (block.timestamp < uint256(escrowRewardFundedAt[caseKey]) + UNASSIGNED_REWARD_BURN_DELAY) {
                revert SweepDelayNotElapsed();
            }
            unclaimable = 3;
        } else {
            _syncOutsideSettlement(escrowId);
            PanelPosting storage p = panelPostings[caseKey];
            Dispute storage d = disputes[escrowId];
            bool abandoned = block.timestamp >= uint256(p.postingDeadline) + UNASSIGNED_REWARD_BURN_DELAY;
            if (d.status == DisputeStatus.Pending && !_assemblyFailed(p) && !abandoned) revert CaseNotTerminal();

            for (uint8 i = 0; i < 3; i++) {
                if (p.postedMask & uint8(1 << i) == 0) unclaimable++;
            }
        }

        if (unclaimable == 0) revert NothingUnclaimable();
        escrowRewardSwept[caseKey] = true;

        uint256 burned = escrowRewardSharePerSeat[caseKey] * unclaimable;
        encumberedPVT -= burned;
        if (burned != 0) pvt.burn(burned);

        emit EscrowRewardSwept(caseKey, unclaimable, burned);
    }

    function getPanelPosting(uint8 family, bytes32 id)
        external
        view
        returns (
            bool exists,
            uint8 postedMask,
            uint8 round,
            uint64 postingDeadline,
            uint256 requiredCollateral,
            bool fullyPosted,
            bool assemblyFailed
        )
    {
        PanelPosting storage p = panelPostings[_caseKey(family, id)];
        return (
            p.exists,
            p.postedMask,
            p.round,
            p.postingDeadline,
            p.requiredCollateral,
            _fullyPosted(p),
            _assemblyFailed(p)
        );
    }

    function getPostedAmount(uint8 family, bytes32 id, uint8 seat) external view returns (uint256) {
        if (seat > 2) revert InvalidSeat();
        return panelPostings[_caseKey(family, id)].postedAmount[seat];
    }

    function assignPanel(bytes32 escrowId, address[3] calldata arbs) external onlyAdmin {
        if (disputeExists[escrowId]) revert DisputeAlreadyExists();

        bytes32 feeKey = _caseKey(CASE_ESCROW, escrowId);
        if (!escrowRewardFunded[feeKey] || escrowRewardSwept[feeKey]) revert AdjudicationFeeNotPaid();
        _requireEscrowStillDisputed(escrowId);
        if (arbs[0] == address(0) || arbs[1] == address(0) || arbs[2] == address(0)) {
            revert InvalidAddress();
        }
        if (arbs[0] == arbs[1] || arbs[0] == arbs[2] || arbs[1] == arbs[2]) {
            revert DuplicateArbitrator();
        }

        (address depositor, address recipient) = escrowContract.getParties(escrowId);
        for (uint256 i = 0; i < 3; i++) {
            if (arbs[i] == depositor || arbs[i] == recipient) {
                revert ArbitratorIsParty();
            }
        }

        Dispute storage d = disputes[escrowId];
        d.escrowId = escrowId;
        d.panel = arbs;

        d.votingDeadline = 0;
        d.status = DisputeStatus.Pending;
        disputeExists[escrowId] = true;

        _armPosting(_caseKey(CASE_ESCROW, escrowId));

        emit PanelAssigned(escrowId, arbs[0], arbs[1], arbs[2], d.votingDeadline);
    }

    function postEscrowCollateral(bytes32 escrowId) external {
        if (!disputeExists[escrowId]) revert DisputeNotFound();
        Dispute storage d = disputes[escrowId];
        if (d.status != DisputeStatus.Pending) revert DisputeNotPending();

        bytes32 caseKey = _caseKey(CASE_ESCROW, escrowId);

        if (escrowRewardSwept[caseKey]) revert RewardAlreadySwept();
        _requireEscrowStillDisputed(escrowId);
        (bool nowFull, uint256 deadline) = _postCollateral(caseKey, d.panel, _panelVotingPeriod());
        if (nowFull) {
            d.votingDeadline = deadline;
            emit PanelFullyPosted(caseKey, deadline);
        }
    }

    function replaceEscrowPanelSeat(bytes32 escrowId, uint8 seat, address newArb) external onlyAdmin {
        if (!disputeExists[escrowId]) revert DisputeNotFound();
        Dispute storage d = disputes[escrowId];
        if (d.status != DisputeStatus.Pending) revert DisputeNotPending();
        _requireEscrowStillDisputed(escrowId);

        (address depositor, address recipient) = escrowContract.getParties(escrowId);
        _replaceSeat(_caseKey(CASE_ESCROW, escrowId), d.panel, seat, newArb, depositor, recipient);
    }

    function castVote(bytes32 escrowId, bool releaseToRecipient) external {
        if (!disputeExists[escrowId]) revert DisputeNotFound();

        Dispute storage d = disputes[escrowId];
        if (d.status != DisputeStatus.Pending) revert DisputeNotPending();
        _requireEscrowStillDisputed(escrowId);

        if (!_fullyPosted(panelPostings[_caseKey(CASE_ESCROW, escrowId)])) revert PanelNotFullyPosted();
        if (block.timestamp > d.votingDeadline) revert VotingClosed();

        bool isPanelMember = false;
        for (uint256 i = 0; i < 3; i++) {
            if (d.panel[i] == msg.sender) {
                isPanelMember = true;
                break;
            }
        }
        if (!isPanelMember) revert NotPanelMember();
        if (d.hasVoted[msg.sender]) revert AlreadyVoted();

        d.hasVoted[msg.sender] = true;

        if (releaseToRecipient) {
            d.votesForRelease++;
        } else {
            d.votesForRefund++;
        }

        emit VoteCast(escrowId, msg.sender, releaseToRecipient);

        if (d.votesForRelease >= 2) {
            d.status = DisputeStatus.Resolved;
            escrowContract.resolveDispute(escrowId, true);
            emit Verdict(escrowId, true, d.votesForRelease, d.votesForRefund);
        } else if (d.votesForRefund >= 2) {
            d.status = DisputeStatus.Resolved;
            escrowContract.resolveDispute(escrowId, false);
            emit Verdict(escrowId, false, d.votesForRelease, d.votesForRefund);
        }
    }

    function escalateDispute(bytes32 escrowId) external {
        if (!disputeExists[escrowId]) revert DisputeNotFound();

        Dispute storage d = disputes[escrowId];
        if (d.status != DisputeStatus.Pending) revert DisputeNotPending();

        _requireEscrowStillDisputed(escrowId);

        bytes32 caseKey = _caseKey(CASE_ESCROW, escrowId);
        PanelPosting storage p = panelPostings[caseKey];
        if (_fullyPosted(p)) {
            if (block.timestamp <= d.votingDeadline) revert VotingNotExpired();
            resolvedByDeadline[caseKey] = true;
        } else {
            if (!_assemblyFailed(p)) revert PanelStillAssemblable();
            emit PanelAssemblyFailed(caseKey, p.round);
        }

        d.status = DisputeStatus.Escalated;
        emit Escalated(escrowId);
    }

    function resolveEscalatedDispute(bytes32 escrowId, bool releaseToRecipient) external onlyAdmin {
        if (!disputeExists[escrowId]) revert DisputeNotFound();
        Dispute storage d = disputes[escrowId];
        require(d.status == DisputeStatus.Escalated, "Not escalated");

        d.status = DisputeStatus.Resolved;
        escrowContract.resolveDispute(escrowId, releaseToRecipient);
        emit Verdict(escrowId, releaseToRecipient, d.votesForRelease, d.votesForRefund);
    }

    function setBondPool(address _bondPool) external onlyAdmin {
        if (bondPoolSet) revert BondPoolAlreadySet();
        if (_bondPool == address(0)) revert InvalidAddress();
        bondPool = IProvianBondPool(_bondPool);
        bondPoolSet = true;
        emit BondPoolSet(_bondPool);
    }

    function assignBondClaimPanel(bytes32 claimId, address[3] calldata arbs) external onlyAdmin {
        if (!bondPoolSet) revert BondPoolNotSet();
        if (bondDisputeExists[claimId]) revert DisputeAlreadyExists();
        if (arbs[0] == address(0) || arbs[1] == address(0) || arbs[2] == address(0)) {
            revert InvalidAddress();
        }
        if (arbs[0] == arbs[1] || arbs[0] == arbs[2] || arbs[1] == arbs[2]) {
            revert DuplicateArbitrator();
        }

        if (!bondPool.claimExists(claimId)) revert BondClaimNotFiled();
        (address claimant, address agent, , uint8 cstatus, ) = bondPool.claims(claimId);
        if (cstatus != CLAIM_FILED) revert BondClaimNotFiled();

        for (uint256 i = 0; i < 3; i++) {
            if (arbs[i] == agent || arbs[i] == claimant) revert ArbitratorIsParty();
        }

        BondDispute storage d = bondDisputes[claimId];
        d.claimId = claimId;
        d.agent = agent;
        d.panel = arbs;
        
        d.votingDeadline = 0;
        d.status = DisputeStatus.Pending;
        bondDisputeExists[claimId] = true;

        _armPosting(_caseKey(CASE_BOND, claimId));

        emit BondPanelAssigned(claimId, agent, arbs[0], arbs[1], arbs[2], d.votingDeadline);
    }

    function postBondClaimCollateral(bytes32 claimId) external {
        if (!bondDisputeExists[claimId]) revert DisputeNotFound();
        BondDispute storage d = bondDisputes[claimId];
        if (d.status != DisputeStatus.Pending) revert DisputeNotPending();

        bytes32 caseKey = _caseKey(CASE_BOND, claimId);
        (bool nowFull, uint256 deadline) = _postCollateral(caseKey, d.panel, _panelVotingPeriod());
        if (nowFull) {
            d.votingDeadline = deadline;
            emit PanelFullyPosted(caseKey, deadline);
        }
    }

    function replaceBondClaimPanelSeat(bytes32 claimId, uint8 seat, address newArb) external onlyAdmin {
        if (!bondPoolSet) revert BondPoolNotSet();
        if (!bondDisputeExists[claimId]) revert DisputeNotFound();
        BondDispute storage d = bondDisputes[claimId];
        if (d.status != DisputeStatus.Pending) revert DisputeNotPending();

        (address claimant, address agent, , , ) = bondPool.claims(claimId);
        _replaceSeat(_caseKey(CASE_BOND, claimId), d.panel, seat, newArb, agent, claimant);
    }

    function closeUnassembledBondClaim(bytes32 claimId) external {
        if (!bondDisputeExists[claimId]) revert DisputeNotFound();
        BondDispute storage d = bondDisputes[claimId];
        if (d.status != DisputeStatus.Pending) revert DisputeNotPending();

        bytes32 caseKey = _caseKey(CASE_BOND, claimId);
        PanelPosting storage p = panelPostings[caseKey];
        if (!_assemblyFailed(p) && !_bondPanelAbandoned(p)) revert PanelStillAssemblable();

        d.status = DisputeStatus.Resolved;
        emit PanelAssemblyFailed(caseKey, p.round);
        bondPool.dismissClaimUnadjudicated(d.agent, claimId);
        emit BondClaimResolved(claimId, d.agent, BondVerdictVote.Dismiss, 0);
    }

    function castBondClaimVote(bytes32 claimId, BondVerdictVote verdict) external {
        if (verdict == BondVerdictVote.None) revert InvalidBondVerdict();
        if (!bondDisputeExists[claimId]) revert DisputeNotFound();

        BondDispute storage d = bondDisputes[claimId];
        if (d.status != DisputeStatus.Pending) revert DisputeNotPending();
        
        if (!_fullyPosted(panelPostings[_caseKey(CASE_BOND, claimId)])) revert PanelNotFullyPosted();
        if (block.timestamp > d.votingDeadline) revert VotingClosed();

        bool isPanelMember = false;
        for (uint256 i = 0; i < 3; i++) {
            if (d.panel[i] == msg.sender) {
                isPanelMember = true;
                break;
            }
        }
        if (!isPanelMember) revert NotPanelMember();
        if (d.hasVoted[msg.sender]) revert AlreadyVoted();

        d.hasVoted[msg.sender] = true;
        if (verdict == BondVerdictVote.Dismiss) {
            d.votesDismiss++;
        } else if (verdict == BondVerdictVote.SlashPartial) {
            d.votesPartial++;
        } else {
            d.votesFull++;
        }

        emit BondVoteCast(claimId, msg.sender, verdict);

        if (d.votesDismiss >= 2) {
            _resolveBondDismiss(d, claimId);
        } else if (d.votesFull >= 2) {
            _resolveBondSlash(d, claimId, BondVerdictVote.SlashFull);
        } else if (d.votesPartial >= 2) {
            _resolveBondSlash(d, claimId, BondVerdictVote.SlashPartial);
        } else if (d.votesDismiss + d.votesPartial + d.votesFull == 3) {

            _resolveBondDismiss(d, claimId);
        }
    }

    function finalizeBondClaim(bytes32 claimId) external {
        if (!bondDisputeExists[claimId]) revert DisputeNotFound();
        BondDispute storage d = bondDisputes[claimId];
        if (d.status != DisputeStatus.Pending) revert DisputeNotPending();
        bytes32 caseKey = _caseKey(CASE_BOND, claimId);
        if (!_fullyPosted(panelPostings[caseKey])) revert PanelNotFullyPosted();
        if (block.timestamp <= d.votingDeadline) revert VotingNotExpired();

        resolvedByDeadline[caseKey] = true;
        _resolveBondDismiss(d, claimId);
    }

    function _resolveBondDismiss(BondDispute storage d, bytes32 claimId) internal {
        d.status = DisputeStatus.Resolved;
        bondPool.dismissClaim(d.agent, claimId);
        emit BondClaimResolved(claimId, d.agent, BondVerdictVote.Dismiss, 0);
    }

    function _resolveBondSlash(BondDispute storage d, bytes32 claimId, BondVerdictVote verdict) internal {
        d.status = DisputeStatus.Resolved;
        (uint256 bondAmount, , , , , , ) = bondPool.bonds(d.agent);
        uint256 slashAmount = verdict == BondVerdictVote.SlashFull
            ? bondAmount
            : (bondAmount * bondPool.MIN_SLASH_PAYOUT_BPS()) / bondPool.MAX_BPS();

        bondPool.slashBond(d.agent, slashAmount, claimId);
        emit BondClaimResolved(claimId, d.agent, verdict, slashAmount);
    }

    function getPanel(bytes32 escrowId) external view returns (address[3] memory) {
        if (!disputeExists[escrowId]) revert DisputeNotFound();
        return disputes[escrowId].panel;
    }

    function getVoteCounts(bytes32 escrowId) external view returns (uint8 forRelease, uint8 forRefund) {
        if (!disputeExists[escrowId]) revert DisputeNotFound();
        Dispute storage d = disputes[escrowId];
        return (d.votesForRelease, d.votesForRefund);
    }

    function hasArbitratorVoted(bytes32 escrowId, address arb) external view returns (bool) {
        if (!disputeExists[escrowId]) revert DisputeNotFound();
        return disputes[escrowId].hasVoted[arb];
    }

    function getDisputeStatus(bytes32 escrowId) external view returns (DisputeStatus) {
        if (!disputeExists[escrowId]) revert DisputeNotFound();
        return disputes[escrowId].status;
    }

    function getVotingDeadline(bytes32 escrowId) external view returns (uint256) {
        if (!disputeExists[escrowId]) revert DisputeNotFound();
        return disputes[escrowId].votingDeadline;
    }

    function getBondPanel(bytes32 claimId) external view returns (address[3] memory) {
        if (!bondDisputeExists[claimId]) revert DisputeNotFound();
        return bondDisputes[claimId].panel;
    }

    function getBondVoteCounts(bytes32 claimId)
        external
        view
        returns (uint8 dismissVotes, uint8 partialVotes, uint8 fullVotes)
    {
        if (!bondDisputeExists[claimId]) revert DisputeNotFound();
        BondDispute storage d = bondDisputes[claimId];
        return (d.votesDismiss, d.votesPartial, d.votesFull);
    }

    function getBondDisputeStatus(bytes32 claimId) external view returns (DisputeStatus) {
        if (!bondDisputeExists[claimId]) revert DisputeNotFound();
        return bondDisputes[claimId].status;
    }

    function getBondDisputeAgent(bytes32 claimId) external view returns (address) {
        if (!bondDisputeExists[claimId]) revert DisputeNotFound();
        return bondDisputes[claimId].agent;
    }

    function hasArbitratorVotedBond(bytes32 claimId, address arb) external view returns (bool) {
        if (!bondDisputeExists[claimId]) revert DisputeNotFound();
        return bondDisputes[claimId].hasVoted[arb];
    }

    function getBondVotingDeadline(bytes32 claimId) external view returns (uint256) {
        if (!bondDisputeExists[claimId]) revert DisputeNotFound();
        return bondDisputes[claimId].votingDeadline;
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert InvalidAddress();
        address oldAdmin = admin;
        admin = newAdmin;
        emit AdminTransferred(oldAdmin, newAdmin);
    }
}
