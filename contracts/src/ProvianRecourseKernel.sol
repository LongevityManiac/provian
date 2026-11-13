// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RecourseClaimValidation} from "./RecourseClaimValidation.sol";
import {ProvianRecoveryHistory} from "./ProvianRecoveryHistory.sol";
import {ProvianRestorationAuthorization} from "./ProvianRestorationAuthorization.sol";
import {RecourseOwnerAuthorization} from "./RecourseOwnerAuthorization.sol";
import {ProvianProtocolPointer} from "./ProvianProtocolPointer.sol";
import {ProvianHashAccount} from "./ProvianHashAccount.sol";

import {FullPrecisionMath} from "./libraries/FullPrecisionMath.sol";
import {IPVT9BeneficiaryVerifier, IPVT9EligibilityVerifier} from "./interfaces/IPVT9Verifiers.sol";

interface IPredecessorAuthority { function BOOTSTRAP_ADMIN() external view returns (address); }
interface IKernelRegistryMode { function afterCryptographicBreak() external view returns (bool); }
interface IKernelMemberContribution {
    function divertIssuance(address account, uint256 gross, uint256 contributorAmount) external returns (uint256);
}

/// @title ProvianRecourseKernel
/// @notice Fresh, non-upgradeable PVT token and bounded PE settlement kernel.
contract ProvianRecourseKernel {
    using FullPrecisionMath for uint256;

    string public constant name = "Provian Value Token";
    string public constant symbol = "PVT";
    string internal constant VERSION = "v10";
    uint8 public constant decimals = 18;

    address public immutable BOOTSTRAP_ADMIN;
    bytes32 private immutable _kernelRulesHash;
    ProvianRecoveryHistory public immutable predecessorHistory;
    uint256 public immutable snapshotBalance;
    uint256 public restoredBalance;
    event IdentityRestored(bytes32 indexed identity, address indexed account, uint256 amount);
    error InvalidRestoration();

    ProvianRestorationAuthorization public immutable ownerAuthorization;
    ProvianProtocolPointer public immutable protocolPointer;
    address public immutable registryOperator;
    address public restorationAuthority;
    mapping(address => uint256) public outgoingSequence;
    event RestorationAuthorityChanged(address indexed authority);
    event BalanceMigrated(address indexed previousOwner, address indexed destination, uint256 amount);
    event TheftReversed(bytes32 indexed request, bytes32 indexed identity, address indexed destination, uint256 amount, bytes32 evidenceHash);
    struct SuccessionConfig {
        address authority;
        bytes32 root;
        address previousKernel;
        uint256 snapshotBlock;
        uint256 snapshotTotal;
        ProvianRecoveryHistory history;
        ProvianProtocolPointer pointer;
        address registry;
        bool afterCryptographicBreak;
        ProvianRestorationAuthorization authorization;
    }
    RecourseClaimValidation private immutable claimValidation;
    constructor(SuccessionConfig memory config) {
        claimValidation = new RecourseClaimValidation();
        bytes32 accountCodeHash = keccak256(type(ProvianHashAccount).runtimeCode);
        // Deployed first at the predicted kernel address; keeping the executor's
        // creation code outside this constructor preserves the chain init-code limit.
        ownerAuthorization = config.authorization;
        if (address(ownerAuthorization).code.length == 0 || ownerAuthorization.kernel() != address(this)
            || ownerAuthorization.predecessor() != config.previousKernel || ownerAuthorization.restorationRoot() != config.root
            || ownerAuthorization.lastGoodBlock() != config.snapshotBlock
            || ownerAuthorization.hashAccountCodeHash() != accountCodeHash
            || ownerAuthorization.cryptographicBreak() != config.afterCryptographicBreak
            || ownerAuthorization.pendingBreakAmount() > config.snapshotTotal) revert InvalidRestoration();
        address authority = config.authority;
        bytes32 root = config.root;
        address previousKernel = config.previousKernel;
        uint256 snapshotBlock = config.snapshotBlock;
        uint256 snapshotTotal = config.snapshotTotal;
        ProvianRecoveryHistory history_ = config.history;
        if (address(config.pointer).code.length == 0 || config.registry.code.length == 0
            || IKernelRegistryMode(config.registry).afterCryptographicBreak() != config.afterCryptographicBreak) revert InvalidRestoration();
        protocolPointer = config.pointer;
        registryOperator = config.registry;
        restorationAuthority = authority;
        if ((config.afterCryptographicBreak ? authority.codehash != accountCodeHash
                : authority != IPredecessorAuthority(previousKernel).BOOTSTRAP_ADMIN())
            || root == bytes32(0) || previousKernel == address(0)
            || history_.predecessor() != previousKernel || history_.lastGoodBlock() != snapshotBlock
            || history_.afterCryptographicBreak() != config.afterCryptographicBreak) revert InvalidRestoration();
        BOOTSTRAP_ADMIN = address(authority);
        _kernelRulesHash = _computeKernelRulesHash();
        snapshotBalance = snapshotTotal;
        predecessorHistory = history_;
        ProvianRecoveryHistory.State memory prior = history_.baseState();
        epochZeroStartsAt = prior.epochZeroStartsAt;
        genesisStartsAt = prior.genesisStartsAt;
        genesisEndsAt = prior.genesisEndsAt;
        genesisAdmissionClosed = prior.genesisClosed;
        genesisAdmissionCutoff = prior.genesisCutoff;
        lastOpenedEpoch = prior.lastOpenedEpoch;
        nextFinalizedCursor = prior.nextCursor;
        administrativeHold = prior.administrativeHold;
        _activeMintRate = prior.mintRate;
        _activeAgentFoundationBps = prior.agentFoundationBps;
        _activeGenesisCap = prior.genesisCap;
        _activeFixedCombinedCap = prior.combinedCap;
        _activeCombinedCapMode = CombinedCapMode.Fixed;
        _epochGenesisIssued[prior.lastOpenedEpoch] = prior.epochGenesisIssued;
        _epochTotalIssued[prior.lastOpenedEpoch] = prior.epochTotalIssued;
        _inheritedEpochCount = history_.economicRoot() == bytes32(0) ? 0 : prior.lastOpenedEpoch;
        for (uint256 i; i < prior.epochs.length; ++i) {
            ProvianRecoveryHistory.HistoricalEpoch memory epoch = prior.epochs[i];
            // Identical ABI; preserve historical hashes rather than recomputing
            // them in the successor's settlement domain.
            EpochPolicy memory policy = abi.decode(abi.encode(epoch.policy), (EpochPolicy));
            _epochPolicies[policy.epoch] = policy;
            _epochGenesisIssued[policy.epoch] = epoch.genesisIssued;
            _epochTotalIssued[policy.epoch] = epoch.totalIssued;
        }
        for (uint256 i; i < prior.schedules.length; ++i) {
            ProvianRecoveryHistory.EconomicSchedule memory schedule = prior.schedules[i];
            if (schedule.epoch <= prior.lastOpenedEpoch) revert InvalidRestoration();
            if (schedule.mintRateSet) scheduledMintRates[schedule.epoch] = ScheduledUint256(true, schedule.mintRate);
            if (schedule.foundationRateSet) {
                scheduledAgentFoundationRates[schedule.epoch] = ScheduledUint256(true, schedule.foundationRate);
                _agentFoundationRateScheduleEpochs.push(schedule.epoch);
            }
            if (schedule.capsSet) scheduledCapPolicies[schedule.epoch] = ScheduledCapPolicy(true, CombinedCapMode.Fixed, schedule.genesisCap, schedule.combinedCap);
            if (schedule.treasuriesSet) scheduledTreasuries[schedule.epoch] = ScheduledTreasuries(true, schedule.provianTreasury, schedule.foundationTreasury);
            if (schedule.beneficiaryVerifierSet) {
                _scheduledBeneficiaryVerifiers[schedule.epoch] = ScheduledVerifier(true,
                    abi.decode(abi.encode(schedule.beneficiaryVerifier), (VerifierConfig)));
                _beneficiaryVerifierScheduleEpochs.push(schedule.epoch);
            }
            if (schedule.eligibilityVerifierSet) _scheduledEligibilityVerifiers[schedule.epoch] = ScheduledVerifier(true,
                abi.decode(abi.encode(schedule.eligibilityVerifier), (VerifierConfig)));
        }
    }


    function bindRestorationOwner(bytes32 identity, bytes32 commitment, bytes32 signingRoot) external {
        if (msg.sender != registryOperator) revert InvalidRestoration();
        ownerAuthorization.bind(identity, commitment, signingRoot);
    }
    function appointRestorationAuthority(address next) external onlyBootstrapAdmin {
        if (next == address(0)) revert InvalidRestoration();
        restorationAuthority = next;
        emit RestorationAuthorityChanged(next);
    }
    function importAuthorizedBalance(address destination, uint256 amount) external {
        if (msg.sender != address(ownerAuthorization) || destination == address(0)
            || amount == 0 || restoredBalance + amount > snapshotBalance) revert InvalidRestoration();
        restoredBalance += amount;
        _mint(destination, amount);
    }
    function applyAuthorizedReversal(address[] calldata sources, uint256[] calldata amounts,
        address destination, uint256 expectedRevision) external returns (uint256 reversed) {
        if (msg.sender != address(ownerAuthorization) || destination == address(0)
            || sources.length == 0 || sources.length != amounts.length) revert InvalidRestoration();
        protocolPointer.requireCurrent(expectedRevision, 0, address(this));
        uint256 supply = totalSupply;
        for (uint256 i; i < sources.length; ++i) {
            if (sources[i] == address(0) || sources[i] == destination || amounts[i] == 0) revert InvalidRestoration();
            _burn(sources[i], amounts[i]);
            reversed += amounts[i];
        }
        _mint(destination, reversed);
        assert(totalSupply == supply);
    }

    /// @notice Release-forward clients bind their transaction to discovery at execution.
    /// Ordinary ERC-20 transfers remain permissionless.
    function transferCurrent(address to, uint256 amount, uint256 expectedRevision) external returns (bool) {
        protocolPointer.requireCurrent(expectedRevision, 0, address(this));
        _transfer(msg.sender, to, amount);
        return true;
    }
    function approveCurrent(address spender, uint256 amount, uint256 expectedRevision) external returns (bool) {
        protocolPointer.requireCurrent(expectedRevision, 0, address(this));
        if (protocolPointer.retired(spender)) revert InvalidAddress();
        _approve(spender, amount);
        return true;
    }

    uint256 internal constant BPS_DENOMINATOR = 10_000;
    uint256 public constant PROVIAN_BPS = 50;
    uint256 public constant HUMAN_FOUNDATION_BPS = 50;
    uint256 internal constant HUMAN_CONTRIBUTOR_BPS = 9_900;
    uint256 internal constant MAX_AGENT_FOUNDATION_BPS = BPS_DENOMINATOR - PROVIAN_BPS;

    uint256 internal constant GENESIS_HUMAN_SIGNUP_GROSS = 75 ether;
    uint256 internal constant GENESIS_AGENT_SIGNUP_GROSS = 75 ether;
    uint256 internal constant GENESIS_DEVICE_LINK_GROSS = 25 ether;
    uint256 internal constant GENESIS_WALLET_GROSS_CEILING = 500 ether;

    uint256 public constant EPOCH_DURATION = 7 days;
    uint64 internal constant FLAT_LAUNCH_EPOCHS = 12;
    uint64 internal constant TRAILING_AVERAGE_EPOCHS = 12;
    uint256 internal constant TRAILING_AVERAGE_MULTIPLIER = 2;
    uint256 internal constant INITIAL_GENESIS_EPOCH_CAP = 7_500_000 ether;
    uint256 internal constant INITIAL_COMBINED_EPOCH_CAP = 10_000_000 ether;
    uint256 internal constant INITIAL_MIN_MINT_RATE = 0.5 ether;
    uint256 internal constant INITIAL_MAX_MINT_RATE = 2 ether;
    uint256 public constant MAX_RECIPIENTS_PER_BATCH = 500;

    bytes32 private constant KERNEL_RULES_DOMAIN = keccak256("provian.pvt9.kernel-rules.v1");
    bytes32 private constant EPOCH_POLICY_DOMAIN = keccak256("provian.pvt9.epoch-policy.v1");
    bytes32 private constant STANDARD_CLAIMS_DOMAIN = keccak256("provian.pvt9.standard-claims.v1");
    bytes32 private constant GENESIS_CLAIMS_DOMAIN = keccak256("provian.pvt9.genesis-claims.v1");
    bytes32 private constant SETTLEMENT_DOMAIN = keccak256("provian.pvt9.settlement.v1");
    bytes32 private constant GENESIS_ANCHOR_DOMAIN = keccak256("provian.pvt9.genesis-anchor.v1");

    uint8 internal constant GENESIS_HUMAN_SIGNUP = 0;
    uint8 internal constant GENESIS_AGENT_SIGNUP = 1;
    uint8 public constant GENESIS_DEVICE_LINK = 2;

    enum SettlementLane {
        StandardPE,
        GenesisPE
    }

    enum BeneficiaryClass {
        Unknown,
        HumanResolving,
        AutonomousAgent
    }

    enum CombinedCapMode {
        Automatic,
        Fixed
    }

    struct VerifierConfig {
        address verifier;
        bytes32 configurationId;
        uint64 version;
    }

    /// @dev Carries the original epoch clock and Genesis window.
    struct EpochZeroConfig {
        uint64 epochZeroStartsAt;
        uint64 genesisStartsAt;
        uint64 genesisEndsAt;
        uint256 initialMintRate;
        address provianTreasury;
        address foundationTreasury;
        VerifierConfig eligibilityVerifier;
        uint256 initialFinalizedCursor;
        CombinedCapMode combinedCapMode;
        uint256 genesisCap;
        uint256 fixedCombinedCap;
    }

    struct EpochPolicy {
        bool opened;
        uint64 epoch;
        uint64 startsAt;
        CombinedCapMode combinedCapMode;
        uint256 mintRate;
        uint256 genesisCap;
        uint256 combinedCap;
        address provianTreasury;
        address foundationTreasury;
        uint256 agentFoundationBps;
        VerifierConfig beneficiaryVerifier;
        VerifierConfig eligibilityVerifier;
        bytes32 policyHash;
    }

    struct StandardRecipient {
        address contributor;
        BeneficiaryClass beneficiaryClass;
        uint256 claimCount;
    }

    struct StandardPEClaim {
        bytes32 claimId;
        uint256 recordPointsAtomic;
    }

    struct GenesisRecipient {
        address contributor;
        uint256 claimCount;
    }

    struct GenesisPEClaim {
        bytes32 claimId;
        bytes32 walletId;
        bytes32 oneTimeAnchor;
        uint8 grantType;
        uint64 qualifiedAt;
        uint256 reservedGrossAtomic;
    }

    struct BatchRecord {
        bool settled;
        SettlementLane lane;
        uint64 epoch;
        uint256 finalizedCursorStart;
        uint256 finalizedCursorEnd;
        bytes32 policyHash;
        bytes32 claimsHash;
        bytes32 settlementDigest;
        uint256 grossInput;
        uint256 totalMinted;
        uint256 contributorTotal;
        uint256 provianTotal;
        uint256 foundationTotal;
        uint256 recipientCount;
        uint256 claimCount;
    }

    struct RecipientMint { address account; uint256 amount; uint256 gross; }
    struct ScheduledUint256 {
        bool exists;
        uint256 value;
    }

    struct ScheduledTreasuries {
        bool exists;
        address provianTreasury;
        address foundationTreasury;
    }

    struct ScheduledVerifier {
        bool exists;
        VerifierConfig config;
    }

    struct ScheduledCapPolicy {
        bool exists;
        CombinedCapMode mode;
        uint256 genesisCap;
        uint256 fixedCombinedCap;
    }

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    bool public epochZeroArmed;
    uint64 public epochZeroStartsAt;
    uint64 public genesisStartsAt;
    uint64 public genesisEndsAt;
    bool public genesisAdmissionClosed;
    uint64 public genesisAdmissionCutoff;
    uint64 public lastOpenedEpoch;
    uint256 public nextFinalizedCursor;

    address public operationalMinter;
    bool public administrativeHold;

    mapping(uint64 => EpochPolicy) private _epochPolicies;
    mapping(uint64 => uint256) private _epochGenesisIssued;
    mapping(uint64 => uint256) private _epochTotalIssued;
    uint64 private immutable _inheritedEpochCount;
    mapping(bytes32 => BatchRecord) private _batchRecords;
    mapping(bytes32 => bool) private _claimSettled;
    mapping(bytes32 => bool) private _genesisAnchorUsed;
    mapping(bytes32 => uint256) private _genesisWalletGrossIssued;

    mapping(uint64 => ScheduledUint256) public scheduledMintRates;
    mapping(uint64 => ScheduledUint256) public scheduledAgentFoundationRates;
    mapping(uint64 => ScheduledTreasuries) public scheduledTreasuries;
    mapping(uint64 => ScheduledVerifier) private _scheduledBeneficiaryVerifiers;
    mapping(uint64 => ScheduledVerifier) private _scheduledEligibilityVerifiers;
    mapping(uint64 => ScheduledCapPolicy) public scheduledCapPolicies;

    uint64[] private _agentFoundationRateScheduleEpochs;
    uint64[] private _beneficiaryVerifierScheduleEpochs;

    uint256 private _activeMintRate;
    uint256 private _activeGenesisCap;
    uint256 private _activeFixedCombinedCap;
    CombinedCapMode private _activeCombinedCapMode;
    address private _activeProvianTreasury;
    address private _activeFoundationTreasury;
    uint256 private _activeAgentFoundationBps;
    VerifierConfig private _activeBeneficiaryVerifier;
    VerifierConfig private _activeEligibilityVerifier;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event OperationalMinterUpdated(address indexed previousMinter, address indexed newMinter);
    event AdministrativeHoldPlaced(address indexed administrator);
    event AdministrativeHoldResumed(address indexed administrator);
    event EpochZeroArmed(
        uint64 indexed epochZeroStartsAt,
        uint64 genesisStartsAt,
        uint64 genesisEndsAt,
        uint256 initialFinalizedCursor,
        bytes32 indexed policyHash
    );
    event GenesisAdmissionClosed(uint64 indexed cutoff);
    event MintRateScheduled(uint64 indexed effectiveEpoch, uint256 mintRate);
    event AgentFoundationRateScheduled(uint64 indexed effectiveEpoch, uint256 foundationBps);
    event TreasuryDestinationsScheduled(
        uint64 indexed effectiveEpoch, address indexed provianTreasury, address indexed foundationTreasury
    );
    event BeneficiaryVerifierScheduled(
        uint64 indexed effectiveEpoch, address indexed verifier, bytes32 configurationId, uint64 version
    );
    event EligibilityVerifierScheduled(
        uint64 indexed effectiveEpoch, address indexed verifier, bytes32 configurationId, uint64 version
    );
    event CapPolicyScheduled(
        uint64 indexed effectiveEpoch, CombinedCapMode mode, uint256 genesisCap, uint256 fixedCombinedCap
    );
    event EpochOpened(
        uint64 indexed epoch,
        uint64 startsAt,
        bytes32 indexed policyHash,
        uint256 mintRate,
        uint256 genesisCap,
        uint256 combinedCap
    );
    event SettlementBatchBound(
        bytes32 indexed batchId,
        SettlementLane indexed lane,
        uint64 indexed epoch,
        bytes32 policyHash,
        uint256 finalizedCursorStart,
        uint256 finalizedCursorEnd,
        bytes32 claimsHash,
        bytes32 settlementDigest
    );
    event SettlementBatchMinted(
        bytes32 indexed batchId,
        uint256 grossInput,
        uint256 totalMinted,
        uint256 contributorTotal,
        uint256 provianTotal,
        uint256 foundationTotal,
        uint256 recipientCount,
        uint256 claimCount
    );
    event Burned(address indexed holder, uint256 amount);

    error OnlyBootstrapAdmin();
    error OnlyOperationalMinter();
    error InvalidAddress();
    error InvalidIdentifier();
    error InvalidConfiguration();
    error EpochZeroAlreadyArmed();
    error EpochZeroNotArmed();
    error OperationalMinterUnconfigured();
    error InvalidActivationDates();
    error InitialMintRateOutOfRange();
    error EpochNotStarted();
    error EpochNotReady();
    error EpochNotOpen();
    error EpochMismatch();
    error PolicyHashMismatch();
    error PolicyNotProspective();
    error PolicyAlreadyScheduled();
    error AgentFoundationRateOutOfDomain();
    error AdministrativeHoldActive();
    error AdministrativeHoldAlreadyActive();
    error AdministrativeHoldNotActive();
    error GenesisAdmissionAlreadyClosed();
    error EmptyBatch();
    error TooManyRecipients();
    error RecipientsNotStrictlyOrdered();
    error ClaimRangeMismatch();
    error InvalidClaim();
    error BatchAlreadySettled();
    error ClaimAlreadySettled();
    error InvalidCursorRange();
    error CursorDiscontinuity();
    error BeneficiaryClassificationRequired();
    error BeneficiaryClassificationInvalid();
    error VerifierStateInvalid();
    error VerificationFailed();
    error InvalidGenesisGrant();
    error GenesisAnchorAlreadyUsed();
    error GenesisWalletCeilingExceeded();
    error GenesisQualificationOutsideWindow();
    error GenesisEpochCapExceeded();
    error CombinedEpochCapExceeded();
    error ArithmeticDomainExceeded();
    error InsufficientBalance();
    error InsufficientAllowance();

    function _economicImport() private view returns (bool) { return msg.sender == address(predecessorHistory) && !epochZeroArmed; }
    modifier onlyPolicySetter() {
        if (msg.sender != BOOTSTRAP_ADMIN && !_economicImport()) revert OnlyBootstrapAdmin();
        _;
    }
    modifier onlyBootstrapAdmin() {
        if (msg.sender != BOOTSTRAP_ADMIN) revert OnlyBootstrapAdmin();
        _;
    }

    modifier whenNotHeld() {
        if (administrativeHold) revert AdministrativeHoldActive();
        _;
    }

    modifier onlyOperationalMinter() {
        if (msg.sender != operationalMinter || msg.sender == address(0)) revert OnlyOperationalMinter();
        _;
    }

    function version() external pure returns (string memory) {
        return VERSION;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        _approve(spender, amount);
        return true;
    }

    function _approve(address spender, uint256 amount) private {
        if (spender == address(0)) revert InvalidAddress();
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        _spendAllowance(from, amount);
        _transfer(from, to, amount);
        return true;
    }
    function burn(uint256 amount) external { _burn(msg.sender, amount); }
    function burnFrom(address holder, uint256 amount) external {
        _spendAllowance(holder, amount);
        _burn(holder, amount);
    }
    /// @dev The current pool verifies signed consent and bounded monthly usage
    /// before collection. Its only transferFrom destination is its own reserve.
    /// Other callers retain ordinary ERC-20 allowance semantics.
    function _spendAllowance(address holder, uint256 amount) private {
        uint256 available = allowance[holder][msg.sender];
        if (available < amount) {
            // component authenticates both runtime and non-retirement. These
            // two current addresses are the complete collection authority.
            if (msg.sender != protocolPointer.component(8) || address(this) != protocolPointer.component(0)) revert InsufficientAllowance();
        } else if (available != type(uint256).max) {
            // This branch already established available >= amount.
            unchecked { available -= amount; }
            allowance[holder][msg.sender] = available;
            emit Approval(holder, msg.sender, available);
        }
    }

    function appointOperationalMinter(address newMinter) external onlyBootstrapAdmin {
        if (newMinter == address(0)) revert InvalidAddress();
        address previous = operationalMinter;
        operationalMinter = newMinter;
        emit OperationalMinterUpdated(previous, newMinter);
    }

    function revokeOperationalMinter() external onlyBootstrapAdmin {
        address previous = operationalMinter;
        operationalMinter = address(0);
        emit OperationalMinterUpdated(previous, address(0));
    }

    function placeAdministrativeHold() external onlyBootstrapAdmin {
        if (administrativeHold) revert AdministrativeHoldAlreadyActive();
        administrativeHold = true;
        emit AdministrativeHoldPlaced(msg.sender);
    }

    function resumeFromAdministrativeHold() external onlyBootstrapAdmin {
        if (!administrativeHold) revert AdministrativeHoldNotActive();
        administrativeHold = false;
        emit AdministrativeHoldResumed(msg.sender);
    }

    function claimSettled(bytes32 key) public view returns (bool) {
        return _claimSettled[key] || predecessorHistory.claimSettled(key);
    }
    function genesisAnchorUsed(bytes32 key) public view returns (bool) {
        return _genesisAnchorUsed[key] || predecessorHistory.genesisAnchorUsed(key);
    }
    function genesisWalletGrossIssued(bytes32 key) public view returns (uint256) {
        return _genesisWalletGrossIssued[key] + predecessorHistory.genesisWalletGrossIssued(key);
    }

    function installRecoveredBeneficiaryVerifier(VerifierConfig calldata config) external onlyBootstrapAdmin {
        if (epochZeroArmed || _activeBeneficiaryVerifier.verifier != address(0)) revert InvalidRestoration();
        _requireOptionalVerifier(config);
        _activeBeneficiaryVerifier = config;
    }

    /// @notice Installs secure successor authorities without resetting predecessor economics.
    function armEpochZero(EpochZeroConfig calldata config) external onlyBootstrapAdmin {
        if (epochZeroArmed) revert EpochZeroAlreadyArmed();
        if (predecessorHistory.appliedEconomicEntries(address(this)) != predecessorHistory.economicEntryCount()) revert InvalidRestoration();
        if (!ownerAuthorization.successionReady()) revert InvalidRestoration();
        if (operationalMinter == address(0)) revert OperationalMinterUnconfigured();
        if (!IRecourseBatchHistory(address(predecessorHistory)).validArming(config, _activeBeneficiaryVerifier)) revert InvalidRestoration();
        _requireConfiguredVerifier(config.eligibilityVerifier);
        _activeProvianTreasury = config.provianTreasury;
        _activeFoundationTreasury = config.foundationTreasury;
        _activeEligibilityVerifier = config.eligibilityVerifier;
        epochZeroArmed = true;
        EpochPolicy memory policy = _writeEpochPolicy(lastOpenedEpoch);
        emit EpochZeroArmed(epochZeroStartsAt, genesisStartsAt, genesisEndsAt, nextFinalizedCursor, policy.policyHash);
    }

    function closeGenesisAdmission() external onlyBootstrapAdmin {
        if (!epochZeroArmed) revert EpochZeroNotArmed();
        if (genesisAdmissionClosed) revert GenesisAdmissionAlreadyClosed();
        genesisAdmissionClosed = true;
        uint64 cutoff = block.timestamp < genesisEndsAt ? uint64(block.timestamp) : genesisEndsAt;
        genesisAdmissionCutoff = cutoff;
        emit GenesisAdmissionClosed(cutoff);
    }

    function genesisAdmissionOpen() external view returns (bool) {
        return epochZeroArmed && !genesisAdmissionClosed && block.timestamp >= genesisStartsAt
            && block.timestamp <= genesisEndsAt;
    }

    function scheduleMintRate(uint64 effectiveEpoch, uint256 mintRate) external onlyPolicySetter {
        _requireScheduleEpoch(effectiveEpoch);
        if (mintRate == 0) revert InvalidConfiguration();
        if (scheduledMintRates[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledMintRates[effectiveEpoch] = ScheduledUint256({exists: true, value: mintRate});
        emit MintRateScheduled(effectiveEpoch, mintRate);
    }

    function scheduleAgentFoundationRate(uint64 effectiveEpoch, uint256 foundationBps) external onlyPolicySetter {
        _requireScheduleEpoch(effectiveEpoch);
        if (foundationBps < HUMAN_FOUNDATION_BPS || foundationBps > MAX_AGENT_FOUNDATION_BPS) {
            revert AgentFoundationRateOutOfDomain();
        }
        if (scheduledAgentFoundationRates[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        _requireBeneficiaryVerifierForDifferentialSchedule(effectiveEpoch, foundationBps);
        scheduledAgentFoundationRates[effectiveEpoch] = ScheduledUint256({exists: true, value: foundationBps});
        _agentFoundationRateScheduleEpochs.push(effectiveEpoch);
        emit AgentFoundationRateScheduled(effectiveEpoch, foundationBps);
    }

    function scheduleTreasuryDestinations(uint64 effectiveEpoch, address provianTreasury, address foundationTreasury)
        external
        onlyPolicySetter
    {
        _requireScheduleEpoch(effectiveEpoch);
        if (provianTreasury == address(0) || foundationTreasury == address(0)) revert InvalidAddress();
        if (scheduledTreasuries[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledTreasuries[effectiveEpoch] = ScheduledTreasuries({
            exists: true, provianTreasury: provianTreasury, foundationTreasury: foundationTreasury
        });
        emit TreasuryDestinationsScheduled(effectiveEpoch, provianTreasury, foundationTreasury);
    }

    function scheduleBeneficiaryVerifier(uint64 effectiveEpoch, VerifierConfig calldata config)
        external
        onlyPolicySetter
    {
        _requireScheduleEpoch(effectiveEpoch);
        _requireOptionalVerifier(config);
        if (_scheduledBeneficiaryVerifiers[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        _requireDefaultAgentRateForNullVerifierSchedule(effectiveEpoch, config);
        _scheduledBeneficiaryVerifiers[effectiveEpoch] = ScheduledVerifier({exists: true, config: config});
        _beneficiaryVerifierScheduleEpochs.push(effectiveEpoch);
        emit BeneficiaryVerifierScheduled(effectiveEpoch, config.verifier, config.configurationId, config.version);
    }

    function scheduleEligibilityVerifier(uint64 effectiveEpoch, VerifierConfig calldata config)
        external
        onlyPolicySetter
    {
        _requireScheduleEpoch(effectiveEpoch);
        _requireConfiguredVerifier(config);
        if (_scheduledEligibilityVerifiers[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        _scheduledEligibilityVerifiers[effectiveEpoch] = ScheduledVerifier({exists: true, config: config});
        emit EligibilityVerifierScheduled(effectiveEpoch, config.verifier, config.configurationId, config.version);
    }

    function scheduleCapPolicy(
        uint64 effectiveEpoch,
        CombinedCapMode mode,
        uint256 genesisCap,
        uint256 fixedCombinedCap
    ) external onlyPolicySetter {
        _requireScheduleEpoch(effectiveEpoch);
        if (mode == CombinedCapMode.Automatic && fixedCombinedCap != 0) revert InvalidConfiguration();
        if (scheduledCapPolicies[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledCapPolicies[effectiveEpoch] =
            ScheduledCapPolicy({exists: true, mode: mode, genesisCap: genesisCap, fixedCombinedCap: fixedCombinedCap});
        emit CapPolicyScheduled(effectiveEpoch, mode, genesisCap, fixedCombinedCap);
    }

    function openNextEpoch() external returns (bytes32 policyHash) {
        if (!epochZeroArmed) revert EpochZeroNotArmed();
        if (lastOpenedEpoch == type(uint64).max) revert ArithmeticDomainExceeded();
        uint64 nextEpoch;
        unchecked { nextEpoch = lastOpenedEpoch + 1; }
        uint256 startsAt;
        unchecked { startsAt = uint256(epochZeroStartsAt) + uint256(nextEpoch) * EPOCH_DURATION; }
        if (block.timestamp < startsAt) revert EpochNotReady();

        _applySchedules(nextEpoch);
        EpochPolicy memory policy = _writeEpochPolicy(nextEpoch);
        return policy.policyHash;
    }

    function settleStandardPEBatch(
        bytes32 batchId,
        uint64 epoch,
        bytes32 expectedPolicyHash,
        uint256 finalizedCursorStart,
        uint256 finalizedCursorEnd,
        StandardRecipient[] calldata recipients,
        StandardPEClaim[] calldata claims
    ) external whenNotHeld onlyOperationalMinter {
        EpochPolicy memory policy = _requireSettlementPolicy(epoch, expectedPolicyHash);
        _validateBatchHeader(batchId, finalizedCursorStart, finalizedCursorEnd, recipients.length, claims.length);
        claimValidation.validateStandard(policy.agentFoundationBps != HUMAN_FOUNDATION_BPS, recipients, claims);

        bytes32 claimsHash = hashStandardClaims(recipients, claims);
        bytes32 digest = computeSettlementDigest(
            SettlementLane.StandardPE,
            batchId,
            epoch,
            expectedPolicyHash,
            finalizedCursorStart,
            finalizedCursorEnd,
            claimsHash
        );
        _verifyEligibility(policy.eligibilityVerifier, SettlementLane.StandardPE, digest);
        if (policy.agentFoundationBps != HUMAN_FOUNDATION_BPS) {
            _verifyBeneficiaries(policy.beneficiaryVerifier, digest);
        }

        RecipientMint[] memory contributorMints = new RecipientMint[](recipients.length);
        uint256 claimIndex;
        uint256 grossInput;
        uint256 contributorTotal;
        uint256 foundationTotal;

        for (uint256 i = 0; i < recipients.length; ++i) {
            uint256 points;
            uint256 recipientClaimCount = recipients[i].claimCount;
            for (uint256 j = 0; j < recipientClaimCount; ++j) {
                StandardPEClaim calldata claim = claims[claimIndex++];
                if (claimSettled(claim.claimId)) revert ClaimAlreadySettled();
                _claimSettled[claim.claimId] = true;
                points += claim.recordPointsAtomic;
            }

            uint256 gross = points.mulDiv(policy.mintRate, 1 ether);
            uint256 foundationBps = policy.agentFoundationBps == HUMAN_FOUNDATION_BPS
                || recipients[i].beneficiaryClass == BeneficiaryClass.HumanResolving
                ? HUMAN_FOUNDATION_BPS
                : policy.agentFoundationBps;
            uint256 contributorBps = BPS_DENOMINATOR - PROVIAN_BPS - foundationBps;
            uint256 contributorShare = gross.mulDiv(contributorBps, BPS_DENOMINATOR);
            uint256 foundationShare = gross.mulDiv(foundationBps, BPS_DENOMINATOR);

            contributorMints[i] = RecipientMint(recipients[i].contributor,contributorShare,gross);
            grossInput += gross;
            contributorTotal += contributorShare;
            foundationTotal += foundationShare;
        }

        uint256 provianTotal = grossInput.mulDiv(PROVIAN_BPS, BPS_DENOMINATOR);
        uint256 totalMinted = contributorTotal + foundationTotal + provianTotal;
        _finalizeBatch(
            batchId,
            SettlementLane.StandardPE,
            policy,
            finalizedCursorStart,
            finalizedCursorEnd,
            claimsHash,
            digest,
            grossInput,
            totalMinted,
            contributorTotal,
            provianTotal,
            foundationTotal,
            recipients.length,
            claims.length,
            0
        );
        _mintRecipients(contributorMints);
        _mint(policy.provianTreasury, provianTotal);
        _mint(policy.foundationTreasury, foundationTotal);
    }

    function settleGenesisPEBatch(
        bytes32 batchId,
        uint64 epoch,
        bytes32 expectedPolicyHash,
        uint256 finalizedCursorStart,
        uint256 finalizedCursorEnd,
        GenesisRecipient[] calldata recipients,
        GenesisPEClaim[] calldata claims
    ) external whenNotHeld onlyOperationalMinter {
        EpochPolicy memory policy = _requireSettlementPolicy(epoch, expectedPolicyHash);
        _validateBatchHeader(batchId, finalizedCursorStart, finalizedCursorEnd, recipients.length, claims.length);
        claimValidation.validateGenesis(recipients, claims);

        bytes32 claimsHash = hashGenesisClaims(recipients, claims);
        bytes32 digest = computeSettlementDigest(
            SettlementLane.GenesisPE,
            batchId,
            epoch,
            expectedPolicyHash,
            finalizedCursorStart,
            finalizedCursorEnd,
            claimsHash
        );
        _verifyEligibility(policy.eligibilityVerifier, SettlementLane.GenesisPE, digest);

        RecipientMint[] memory contributorMints = new RecipientMint[](recipients.length);
        uint256 claimIndex;
        uint256 grossInput;
        uint256 contributorTotal;
        uint256 foundationTotal;

        for (uint256 i = 0; i < recipients.length; ++i) {
            uint256 recipientGross;
            uint256 recipientClaimCount = recipients[i].claimCount;
            for (uint256 j = 0; j < recipientClaimCount; ++j) {
                GenesisPEClaim calldata claim = claims[claimIndex++];
                if (claimSettled(claim.claimId)) revert ClaimAlreadySettled();
                _claimSettled[claim.claimId] = true;

                bytes32 anchorKey = genesisAnchorKey(claim.grantType, claim.oneTimeAnchor);
                if (genesisAnchorUsed(anchorKey)) revert GenesisAnchorAlreadyUsed();
                _genesisAnchorUsed[anchorKey] = true;

                uint256 walletGross = genesisWalletGrossIssued(claim.walletId) + claim.reservedGrossAtomic;
                if (walletGross > GENESIS_WALLET_GROSS_CEILING) revert GenesisWalletCeilingExceeded();
                _genesisWalletGrossIssued[claim.walletId] += claim.reservedGrossAtomic;
                recipientGross += claim.reservedGrossAtomic;
            }

            uint256 contributorShare = recipientGross.mulDiv(HUMAN_CONTRIBUTOR_BPS, BPS_DENOMINATOR);
            uint256 foundationShare = recipientGross.mulDiv(HUMAN_FOUNDATION_BPS, BPS_DENOMINATOR);
            contributorMints[i] = RecipientMint(recipients[i].contributor,contributorShare,recipientGross);
            grossInput += recipientGross;
            contributorTotal += contributorShare;
            foundationTotal += foundationShare;
        }

        uint256 provianTotal = grossInput.mulDiv(PROVIAN_BPS, BPS_DENOMINATOR);
        uint256 totalMinted = contributorTotal + foundationTotal + provianTotal;
        _finalizeBatch(
            batchId,
            SettlementLane.GenesisPE,
            policy,
            finalizedCursorStart,
            finalizedCursorEnd,
            claimsHash,
            digest,
            grossInput,
            totalMinted,
            contributorTotal,
            provianTotal,
            foundationTotal,
            recipients.length,
            claims.length,
            totalMinted
        );
        _mintRecipients(contributorMints);
        _mint(policy.provianTreasury, provianTotal);
        _mint(policy.foundationTreasury, foundationTotal);
    }

    function getEpochPolicy(uint64 epoch) external view returns (EpochPolicy memory) {
        if (epoch < _inheritedEpochCount) {
            // The immutable history returns the identical fixed policy ABI.
            // Forward that value without a second struct decode/re-encode.
            address history = address(predecessorHistory);
            bytes4 selector = ProvianRecoveryHistory.historicalPolicy.selector;
            assembly ("memory-safe") {
                let ptr := mload(0x40)
                mstore(ptr,selector)
                mstore(add(ptr,4),epoch)
                let ok := staticcall(gas(),history,ptr,36,ptr,544)
                if and(ok,eq(returndatasize(),544)) { return(ptr,544) }
            }
            revert InvalidRestoration();
        }
        return _epochPolicies[epoch];
    }
    function epochGenesisIssued(uint64 epoch) external view returns (uint256) { return _issuedAt(epoch,true); }
    function epochTotalIssued(uint64 epoch) public view returns (uint256) { return _issuedAt(epoch,false); }
    function _issuedAt(uint64 epoch,bool genesis) private view returns (uint256) {
        if (epoch < _inheritedEpochCount) return predecessorHistory.historicalIssued(epoch,genesis);
        return genesis ? _epochGenesisIssued[epoch] : _epochTotalIssued[epoch];
    }

    function getBatchRecord(bytes32 batchId) external view returns (BatchRecord memory) {
        if (!_batchRecords[batchId].settled) {
            // The immutable history validates and returns the identical 15-word ABI.
            address history = address(predecessorHistory);
            bytes4 selector = IRecourseBatchHistory.getBatchRecord.selector;
            assembly ("memory-safe") {
                let ptr := mload(0x40)
                mstore(ptr,selector)
                mstore(add(ptr,4),batchId)
                let ok := staticcall(gas(),history,ptr,36,ptr,480)
                if and(ok,eq(returndatasize(),480)) { return(ptr,480) }
            }
            revert InvalidRestoration();
        }
        return _batchRecords[batchId];
    }

    function getScheduledBeneficiaryVerifier(uint64 epoch) external view returns (ScheduledVerifier memory) {
        return _scheduledBeneficiaryVerifiers[epoch];
    }

    function getScheduledEligibilityVerifier(uint64 epoch) external view returns (ScheduledVerifier memory) {
        return _scheduledEligibilityVerifiers[epoch];
    }

    function earliestSchedulableEpoch() public view returns (uint64) {
        if (!epochZeroArmed) revert EpochZeroNotArmed();
        uint64 boundary = lastOpenedEpoch;
        if (block.timestamp >= epochZeroStartsAt) {
            uint256 timeEpoch;
            unchecked { timeEpoch = (block.timestamp - epochZeroStartsAt) / EPOCH_DURATION; }
            if (timeEpoch > type(uint64).max) revert ArithmeticDomainExceeded();
            // forge-lint: disable-next-line(unsafe-typecast)
            uint64 activeTimeEpoch = uint64(timeEpoch);
            if (activeTimeEpoch > boundary) boundary = activeTimeEpoch;
        }
        if (boundary == type(uint64).max) revert ArithmeticDomainExceeded();
        unchecked { return boundary + 1; }
    }

    function currentEpoch() external view returns (uint64) {
        if (!epochZeroArmed) revert EpochZeroNotArmed();
        if (block.timestamp < epochZeroStartsAt) revert EpochNotStarted();
        uint256 epoch;
        unchecked { epoch = (block.timestamp - epochZeroStartsAt) / EPOCH_DURATION; }
        if (epoch > type(uint64).max) revert ArithmeticDomainExceeded();
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(epoch);
    }

    function kernelRulesHash() public view returns (bytes32) { return _kernelRulesHash; }

    function _computeKernelRulesHash() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                KERNEL_RULES_DOMAIN,
                BOOTSTRAP_ADMIN,
                PROVIAN_BPS,
                HUMAN_FOUNDATION_BPS,
                HUMAN_CONTRIBUTOR_BPS,
                MAX_AGENT_FOUNDATION_BPS,
                GENESIS_HUMAN_SIGNUP_GROSS,
                GENESIS_AGENT_SIGNUP_GROSS,
                GENESIS_DEVICE_LINK_GROSS,
                GENESIS_WALLET_GROSS_CEILING,
                EPOCH_DURATION,
                FLAT_LAUNCH_EPOCHS,
                TRAILING_AVERAGE_EPOCHS,
                TRAILING_AVERAGE_MULTIPLIER,
                INITIAL_GENESIS_EPOCH_CAP,
                INITIAL_COMBINED_EPOCH_CAP,
                INITIAL_MIN_MINT_RATE,
                INITIAL_MAX_MINT_RATE,
                MAX_RECIPIENTS_PER_BATCH
            )
        );
    }

    function hashStandardClaims(StandardRecipient[] calldata recipients, StandardPEClaim[] calldata claims)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(STANDARD_CLAIMS_DOMAIN, recipients, claims));
    }

    function hashGenesisClaims(GenesisRecipient[] calldata recipients, GenesisPEClaim[] calldata claims)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(GENESIS_CLAIMS_DOMAIN, recipients, claims));
    }

    function computeSettlementDigest(
        SettlementLane lane,
        bytes32 batchId,
        uint64 epoch,
        bytes32 policyHash,
        uint256 finalizedCursorStart,
        uint256 finalizedCursorEnd,
        bytes32 claimsHash
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                SETTLEMENT_DOMAIN,
                block.chainid,
                address(this),
                lane,
                batchId,
                epoch,
                policyHash,
                finalizedCursorStart,
                finalizedCursorEnd,
                claimsHash
            )
        );
    }

    function genesisAnchorKey(uint8 grantType, bytes32 oneTimeAnchor) public pure returns (bytes32) {
        return keccak256(abi.encode(GENESIS_ANCHOR_DOMAIN, grantType, oneTimeAnchor));
    }

    function genesisGrantMaximum(uint8 grantType) public pure returns (uint256) {
        if (grantType == GENESIS_HUMAN_SIGNUP) return GENESIS_HUMAN_SIGNUP_GROSS;
        if (grantType == GENESIS_AGENT_SIGNUP) return GENESIS_AGENT_SIGNUP_GROSS;
        if (grantType == GENESIS_DEVICE_LINK) return GENESIS_DEVICE_LINK_GROSS;
        revert InvalidGenesisGrant();
    }

    function trailingAverageForEpoch(uint64 epoch) public view returns (uint256) {
        return claimValidation.trailingAverageForEpoch(epoch);
    }

    function _writeEpochPolicy(uint64 epoch) private returns (EpochPolicy memory policy) {
        _requireConfiguredVerifier(_activeEligibilityVerifier);
        if (_activeAgentFoundationBps != HUMAN_FOUNDATION_BPS) {
            _requireConfiguredVerifier(_activeBeneficiaryVerifier);
        }

        uint256 startsAt;
        // Both input clocks are uint64; this expression is below 2**84.
        unchecked { startsAt = uint256(epochZeroStartsAt) + uint256(epoch) * EPOCH_DURATION; }
        if (startsAt > type(uint64).max) revert ArithmeticDomainExceeded();
        uint256 combinedCap = _effectiveCombinedCap(epoch);
        policy = EpochPolicy({
            opened: true,
            epoch: epoch,
            // forge-lint: disable-next-line(unsafe-typecast)
            startsAt: uint64(startsAt),
            combinedCapMode: _activeCombinedCapMode,
            mintRate: _activeMintRate,
            genesisCap: _activeGenesisCap,
            combinedCap: combinedCap,
            provianTreasury: _activeProvianTreasury,
            foundationTreasury: _activeFoundationTreasury,
            agentFoundationBps: _activeAgentFoundationBps,
            beneficiaryVerifier: _activeBeneficiaryVerifier,
            eligibilityVerifier: _activeEligibilityVerifier,
            policyHash: bytes32(0)
        });
        policy.policyHash = _hashEpochPolicy(policy);
        _epochPolicies[epoch] = policy;
        lastOpenedEpoch = epoch;
        emit EpochOpened(
            epoch, policy.startsAt, policy.policyHash, policy.mintRate, policy.genesisCap, policy.combinedCap
        );
    }

    function _hashEpochPolicy(EpochPolicy memory policy) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                EPOCH_POLICY_DOMAIN,
                block.chainid,
                address(this),
                kernelRulesHash(),
                genesisStartsAt,
                genesisEndsAt,
                policy.epoch,
                policy.startsAt,
                policy.combinedCapMode,
                policy.mintRate,
                policy.genesisCap,
                policy.combinedCap,
                policy.provianTreasury,
                policy.foundationTreasury,
                policy.agentFoundationBps,
                policy.beneficiaryVerifier,
                policy.eligibilityVerifier
            )
        );
    }

    function _effectiveCombinedCap(uint64 epoch) private view returns (uint256) {
        if (_activeCombinedCapMode == CombinedCapMode.Fixed) return _activeFixedCombinedCap;
        if (epoch < FLAT_LAUNCH_EPOCHS) return INITIAL_COMBINED_EPOCH_CAP;
        uint256 average = trailingAverageForEpoch(epoch);
        if (average > type(uint256).max / TRAILING_AVERAGE_MULTIPLIER) {
            revert ArithmeticDomainExceeded();
        }
        return average * TRAILING_AVERAGE_MULTIPLIER;
    }

    function _applySchedules(uint64 epoch) private {
        ScheduledUint256 storage mintRateSchedule = scheduledMintRates[epoch];
        if (mintRateSchedule.exists) _activeMintRate = mintRateSchedule.value;

        ScheduledUint256 storage agentRateSchedule = scheduledAgentFoundationRates[epoch];
        if (agentRateSchedule.exists) _activeAgentFoundationBps = agentRateSchedule.value;

        ScheduledTreasuries storage treasurySchedule = scheduledTreasuries[epoch];
        if (treasurySchedule.exists) {
            _activeProvianTreasury = treasurySchedule.provianTreasury;
            _activeFoundationTreasury = treasurySchedule.foundationTreasury;
        }

        ScheduledVerifier storage beneficiarySchedule = _scheduledBeneficiaryVerifiers[epoch];
        if (beneficiarySchedule.exists) _activeBeneficiaryVerifier = beneficiarySchedule.config;

        ScheduledVerifier storage eligibilitySchedule = _scheduledEligibilityVerifiers[epoch];
        if (eligibilitySchedule.exists) _activeEligibilityVerifier = eligibilitySchedule.config;

        ScheduledCapPolicy storage capSchedule = scheduledCapPolicies[epoch];
        if (capSchedule.exists) {
            _activeCombinedCapMode = capSchedule.mode;
            _activeGenesisCap = capSchedule.genesisCap;
            _activeFixedCombinedCap = capSchedule.fixedCombinedCap;
        }
    }

    function _requireSettlementPolicy(uint64 epoch, bytes32 expectedPolicyHash)
        private
        view
        returns (EpochPolicy memory policy)
    {
        if (!epochZeroArmed) revert EpochZeroNotArmed();
        if (block.timestamp < epochZeroStartsAt) revert EpochNotStarted();
        uint256 activeEpoch;
        unchecked { activeEpoch = (block.timestamp - epochZeroStartsAt) / EPOCH_DURATION; }
        // forge-lint: disable-next-line(unsafe-typecast)
        if (activeEpoch > type(uint64).max || uint64(activeEpoch) != epoch) revert EpochMismatch();
        policy = _epochPolicies[epoch];
        if (!policy.opened || lastOpenedEpoch != epoch) revert EpochNotOpen();
        if (policy.policyHash == bytes32(0) || expectedPolicyHash != policy.policyHash) {
            revert PolicyHashMismatch();
        }
    }

    function _validateBatchHeader(
        bytes32 batchId,
        uint256 cursorStart,
        uint256 cursorEnd,
        uint256 recipientCount,
        uint256 claimCount
    ) private view {
        if (batchId == bytes32(0)) revert InvalidIdentifier();
        if (_batchRecords[batchId].settled || predecessorHistory.batchUsed(batchId)) revert BatchAlreadySettled();
        if (recipientCount == 0) revert EmptyBatch();
        if (recipientCount > MAX_RECIPIENTS_PER_BATCH) revert TooManyRecipients();
        if (cursorEnd <= cursorStart) revert InvalidCursorRange();
        if (cursorStart != nextFinalizedCursor) revert CursorDiscontinuity();
        unchecked { if (cursorEnd - cursorStart != claimCount) revert ClaimRangeMismatch(); }
    }

    function _verifyEligibility(VerifierConfig memory config, SettlementLane lane, bytes32 digest) private view {
        bytes memory callData = lane == SettlementLane.StandardPE
            ? abi.encodeCall(
                IPVT9EligibilityVerifier.verifyStandardBatch, (digest, config.configurationId, config.version)
            )
            : abi.encodeCall(
                IPVT9EligibilityVerifier.verifyGenesisBatch, (digest, config.configurationId, config.version)
            );
        _requireTrueVerifierResult(config.verifier, callData);
    }

    function _verifyBeneficiaries(VerifierConfig memory config, bytes32 digest) private view {
        _requireTrueVerifierResult(
            config.verifier,
            abi.encodeCall(
                IPVT9BeneficiaryVerifier.verifyBeneficiaryClassifications,
                (digest, config.configurationId, config.version)
            )
        );
    }

    function _requireTrueVerifierResult(address verifier, bytes memory callData) private view {
        if (verifier.code.length == 0) revert VerifierStateInvalid();
        bool valid;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            let success := staticcall(gas(),verifier,add(callData,32),mload(callData),ptr,32)
            valid := and(and(success,eq(returndatasize(),32)),eq(mload(ptr),1))
        }
        if (!valid) revert VerificationFailed();
    }

    function _finalizeBatch(
        bytes32 batchId,
        SettlementLane lane,
        EpochPolicy memory policy,
        uint256 cursorStart,
        uint256 cursorEnd,
        bytes32 claimsHash,
        bytes32 digest,
        uint256 grossInput,
        uint256 totalMinted,
        uint256 contributorTotal,
        uint256 provianTotal,
        uint256 foundationTotal,
        uint256 recipientCount,
        uint256 claimCount,
        uint256 genesisIssued
    ) private {
        uint256 nextGenesisIssued = _epochGenesisIssued[policy.epoch] + genesisIssued;
        if (nextGenesisIssued > policy.genesisCap) revert GenesisEpochCapExceeded();
        uint256 nextTotalIssued = _epochTotalIssued[policy.epoch] + totalMinted;
        if (nextTotalIssued > policy.combinedCap) revert CombinedEpochCapExceeded();
        // Any uint256 is at most its type maximum; this subtraction cannot underflow.
        unchecked { if (totalSupply > type(uint256).max - totalMinted) revert ArithmeticDomainExceeded(); }

        _epochGenesisIssued[policy.epoch] = nextGenesisIssued;
        _epochTotalIssued[policy.epoch] = nextTotalIssued;
        nextFinalizedCursor = cursorEnd;
        _batchRecords[batchId] = BatchRecord({
            settled: true,
            lane: lane,
            epoch: policy.epoch,
            finalizedCursorStart: cursorStart,
            finalizedCursorEnd: cursorEnd,
            policyHash: policy.policyHash,
            claimsHash: claimsHash,
            settlementDigest: digest,
            grossInput: grossInput,
            totalMinted: totalMinted,
            contributorTotal: contributorTotal,
            provianTotal: provianTotal,
            foundationTotal: foundationTotal,
            recipientCount: recipientCount,
            claimCount: claimCount
        });

        emit SettlementBatchBound(
            batchId, lane, policy.epoch, policy.policyHash, cursorStart, cursorEnd, claimsHash, digest
        );
        emit SettlementBatchMinted(
            batchId,
            grossInput,
            totalMinted,
            contributorTotal,
            provianTotal,
            foundationTotal,
            recipientCount,
            claimCount
        );
    }

    function _mintContributor(address account, uint256 amount, uint256 gross) private {
        address pool = protocolPointer.component(8);
        uint256 contribution = IKernelMemberContribution(pool).divertIssuance(account, gross, amount);
        if (contribution > amount) revert InvalidConfiguration();
        unchecked { _mint(account, amount - contribution); }
        _mint(pool, contribution);
    }
    function _mintRecipients(RecipientMint[] memory mints) private {
        for (uint256 i; i < mints.length; ++i) _mintContributor(mints[i].account, mints[i].amount, mints[i].gross);
    }

    function _mint(address to, uint256 amount) private {
        if (amount == 0) return;
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function _transfer(address from, address to, uint256 amount) private {
        if (to == address(0)) revert InvalidAddress();
        _debit(from, amount);
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    function _debit(address holder, uint256 amount) private {
        uint256 balance = balanceOf[holder];
        if (balance < amount) revert InsufficientBalance();
        unchecked { balanceOf[holder] = balance - amount; }
        if (amount != 0) ++outgoingSequence[holder];
    }

    function _burn(address holder, uint256 amount) private {
        _debit(holder, amount);
        totalSupply -= amount;
        emit Transfer(holder, address(0), amount);
        emit Burned(holder, amount);
    }

    function _requireScheduleEpoch(uint64 effectiveEpoch) private view {
        if (_economicImport()) { if (effectiveEpoch <= lastOpenedEpoch) revert InvalidRestoration(); return; }
        if (!epochZeroArmed) revert EpochZeroNotArmed();
        if (effectiveEpoch < earliestSchedulableEpoch()) revert PolicyNotProspective();
    }

    function _requireConfiguredVerifier(VerifierConfig memory config) private view {
        if (
            config.verifier == address(0) || config.verifier.code.length == 0 || config.configurationId == bytes32(0)
                || config.version == 0
        ) revert VerifierStateInvalid();
    }

    function _requireOptionalVerifier(VerifierConfig memory config) private view {
        if (config.verifier == address(0)) {
            if (config.configurationId != bytes32(0) || config.version != 0) revert VerifierStateInvalid();
            return;
        }
        _requireConfiguredVerifier(config);
    }

    function _requireBeneficiaryVerifierForDifferentialSchedule(uint64 effectiveEpoch, uint256 foundationBps)
        private
        view
    {
        if (_economicImport()) return;
        if (foundationBps == HUMAN_FOUNDATION_BPS) return;
        _requireConfiguredVerifier(_effectiveBeneficiaryVerifierAt(effectiveEpoch));

        (bool hasNextRate, uint64 nextRateEpoch) = _nextScheduleAfter(_agentFoundationRateScheduleEpochs,effectiveEpoch);
        for (uint256 i = 0; i < _beneficiaryVerifierScheduleEpochs.length; ++i) {
            uint64 verifierEpoch = _beneficiaryVerifierScheduleEpochs[i];
            if (verifierEpoch > effectiveEpoch && (!hasNextRate || verifierEpoch < nextRateEpoch)) {
                _requireConfiguredVerifier(_scheduledBeneficiaryVerifiers[verifierEpoch].config);
            }
        }
    }

    function _requireDefaultAgentRateForNullVerifierSchedule(uint64 effectiveEpoch, VerifierConfig memory config)
        private
        view
    {
        if (_economicImport()) return;
        if (config.verifier != address(0)) return;
        if (_effectiveAgentFoundationRateAt(effectiveEpoch) != HUMAN_FOUNDATION_BPS) {
            revert VerifierStateInvalid();
        }

        (bool hasNextVerifier, uint64 nextVerifierEpoch) = _nextScheduleAfter(_beneficiaryVerifierScheduleEpochs,effectiveEpoch);
        for (uint256 i = 0; i < _agentFoundationRateScheduleEpochs.length; ++i) {
            uint64 rateEpoch = _agentFoundationRateScheduleEpochs[i];
            if (rateEpoch > effectiveEpoch && (!hasNextVerifier || rateEpoch < nextVerifierEpoch)) {
                if (scheduledAgentFoundationRates[rateEpoch].value != HUMAN_FOUNDATION_BPS) {
                    revert VerifierStateInvalid();
                }
            }
        }
    }

    function _effectiveAgentFoundationRateAt(uint64 effectiveEpoch) private view returns (uint256 foundationBps) {
        foundationBps = _activeAgentFoundationBps;
        uint64 latestEpoch = lastOpenedEpoch;
        for (uint256 i = 0; i < _agentFoundationRateScheduleEpochs.length; ++i) {
            uint64 rateEpoch = _agentFoundationRateScheduleEpochs[i];
            if (rateEpoch > latestEpoch && rateEpoch <= effectiveEpoch) {
                latestEpoch = rateEpoch;
                foundationBps = scheduledAgentFoundationRates[rateEpoch].value;
            }
        }
    }

    function _effectiveBeneficiaryVerifierAt(uint64 effectiveEpoch)
        private
        view
        returns (VerifierConfig memory config)
    {
        config = _activeBeneficiaryVerifier;
        uint64 latestEpoch = lastOpenedEpoch;
        for (uint256 i = 0; i < _beneficiaryVerifierScheduleEpochs.length; ++i) {
            uint64 verifierEpoch = _beneficiaryVerifierScheduleEpochs[i];
            if (verifierEpoch > latestEpoch && verifierEpoch <= effectiveEpoch) {
                latestEpoch = verifierEpoch;
                config = _scheduledBeneficiaryVerifiers[verifierEpoch].config;
            }
        }
    }

    function _nextScheduleAfter(uint64[] storage epochs,uint64 effectiveEpoch)
        private view returns (bool exists,uint64 nextEpoch) {
        for (uint256 i; i < epochs.length; ++i) {
            uint64 epoch = epochs[i];
            if (epoch > effectiveEpoch && (!exists || epoch < nextEpoch)) {
                exists = true; nextEpoch = epoch;
            }
        }
    }

}

interface IRecourseBatchHistory {
    function getBatchRecord(bytes32 key) external view returns (ProvianRecourseKernel.BatchRecord memory);
    function validArming(ProvianRecourseKernel.EpochZeroConfig calldata config, ProvianRecourseKernel.VerifierConfig calldata beneficiary)
        external view returns (bool);
}
