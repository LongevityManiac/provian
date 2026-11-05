// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FullPrecisionMath} from "./libraries/FullPrecisionMath.sol";
import {IPVT9BeneficiaryVerifier, IPVT9EligibilityVerifier} from "./interfaces/IPVT9Verifiers.sol";

/// @title ProvianPVT9
/// @notice Fresh, non-upgradeable PVT token and bounded PE settlement kernel.
contract ProvianPVT9 {
    using FullPrecisionMath for uint256;

    string public constant name = "Provian Value Token";
    string public constant symbol = "PVT";
    string public constant VERSION = "v9";
    uint8 public constant decimals = 18;

    address public constant BOOTSTRAP_ADMIN = 0xCa37a15A64213b2ACD1784ae3f8e6Cbd4600D9D3;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant PROVIAN_BPS = 50;
    uint256 public constant HUMAN_FOUNDATION_BPS = 50;
    uint256 public constant HUMAN_CONTRIBUTOR_BPS = 9_900;
    uint256 public constant MAX_AGENT_FOUNDATION_BPS = BPS_DENOMINATOR - PROVIAN_BPS;

    uint256 public constant GENESIS_HUMAN_SIGNUP_GROSS = 75 ether;
    uint256 public constant GENESIS_AGENT_SIGNUP_GROSS = 75 ether;
    uint256 public constant GENESIS_DEVICE_LINK_GROSS = 25 ether;
    uint256 public constant GENESIS_WALLET_GROSS_CEILING = 500 ether;

    uint256 public constant EPOCH_DURATION = 7 days;
    uint64 public constant FLAT_LAUNCH_EPOCHS = 12;
    uint64 public constant TRAILING_AVERAGE_EPOCHS = 12;
    uint256 public constant TRAILING_AVERAGE_MULTIPLIER = 2;
    uint256 public constant INITIAL_GENESIS_EPOCH_CAP = 7_500_000 ether;
    uint256 public constant INITIAL_COMBINED_EPOCH_CAP = 10_000_000 ether;
    uint256 public constant INITIAL_MIN_MINT_RATE = 0.5 ether;
    uint256 public constant INITIAL_MAX_MINT_RATE = 2 ether;
    uint256 public constant MAX_RECIPIENTS_PER_BATCH = 500;

    bytes32 private constant KERNEL_RULES_DOMAIN = keccak256("provian.pvt9.kernel-rules.v1");
    bytes32 private constant EPOCH_POLICY_DOMAIN = keccak256("provian.pvt9.epoch-policy.v1");
    bytes32 private constant STANDARD_CLAIMS_DOMAIN = keccak256("provian.pvt9.standard-claims.v1");
    bytes32 private constant GENESIS_CLAIMS_DOMAIN = keccak256("provian.pvt9.genesis-claims.v1");
    bytes32 private constant SETTLEMENT_DOMAIN = keccak256("provian.pvt9.settlement.v1");
    bytes32 private constant GENESIS_ANCHOR_DOMAIN = keccak256("provian.pvt9.genesis-anchor.v1");

    uint8 public constant GENESIS_HUMAN_SIGNUP = 0;
    uint8 public constant GENESIS_AGENT_SIGNUP = 1;
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

    /// @dev D-486 successor. Two changes from the D-195 kernel, both confined to arming:
    ///      (1) the epoch-zero cap policy is an arming input (`combinedCapMode`,
    ///          `genesisCap`, `fixedCombinedCap`), validated as `scheduleCapPolicy`
    ///          validates a scheduled one. Epoch zero is the one epoch no schedule can
    ///          reach, so before this it always opened on the INITIAL_* Automatic caps;
    ///      (2) `genesisStartsAt` may precede `epochZeroStartsAt`, so a successor can
    ///          carry a Genesis window that opened under its predecessor. Qualification
    ///          stays bounded by [genesisStartsAt, genesisEndsAt] and by block time, and
    ///          nothing settles before epoch zero starts.
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
    mapping(uint64 => uint256) public epochGenesisIssued;
    mapping(uint64 => uint256) public epochTotalIssued;
    mapping(bytes32 => BatchRecord) private _batchRecords;
    mapping(bytes32 => bool) public claimSettled;
    mapping(bytes32 => bool) public genesisAnchorUsed;
    mapping(bytes32 => uint256) public genesisWalletGrossIssued;

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
        if (spender == address(0)) revert InvalidAddress();
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 available = allowance[from][msg.sender];
        if (available < amount) revert InsufficientAllowance();
        if (available != type(uint256).max) {
            allowance[from][msg.sender] = available - amount;
            emit Approval(from, msg.sender, available - amount);
        }
        _transfer(from, to, amount);
        return true;
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    function burnFrom(address holder, uint256 amount) external {
        uint256 available = allowance[holder][msg.sender];
        if (available < amount) revert InsufficientAllowance();
        if (available != type(uint256).max) {
            allowance[holder][msg.sender] = available - amount;
            emit Approval(holder, msg.sender, available - amount);
        }
        _burn(holder, amount);
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

    function armEpochZero(EpochZeroConfig calldata config) external onlyBootstrapAdmin {
        if (epochZeroArmed) revert EpochZeroAlreadyArmed();
        if (operationalMinter == address(0)) revert OperationalMinterUnconfigured();
        if (
            config.epochZeroStartsAt <= block.timestamp || config.genesisStartsAt == 0
                || config.genesisEndsAt <= config.genesisStartsAt || config.genesisEndsAt <= config.epochZeroStartsAt
        ) revert InvalidActivationDates();
        if (config.initialMintRate < INITIAL_MIN_MINT_RATE || config.initialMintRate > INITIAL_MAX_MINT_RATE) {
            revert InitialMintRateOutOfRange();
        }
        if (config.provianTreasury == address(0) || config.foundationTreasury == address(0)) {
            revert InvalidAddress();
        }
        if (config.combinedCapMode == CombinedCapMode.Automatic && config.fixedCombinedCap != 0) {
            revert InvalidConfiguration();
        }
        _requireConfiguredVerifier(config.eligibilityVerifier);

        epochZeroArmed = true;
        epochZeroStartsAt = config.epochZeroStartsAt;
        genesisStartsAt = config.genesisStartsAt;
        genesisEndsAt = config.genesisEndsAt;
        nextFinalizedCursor = config.initialFinalizedCursor;

        _activeMintRate = config.initialMintRate;
        _activeGenesisCap = config.genesisCap;
        _activeCombinedCapMode = config.combinedCapMode;
        _activeFixedCombinedCap = config.fixedCombinedCap;
        _activeProvianTreasury = config.provianTreasury;
        _activeFoundationTreasury = config.foundationTreasury;
        _activeAgentFoundationBps = HUMAN_FOUNDATION_BPS;
        _activeEligibilityVerifier = config.eligibilityVerifier;

        EpochPolicy memory policy = _writeEpochPolicy(0);
        emit EpochZeroArmed(
            config.epochZeroStartsAt,
            config.genesisStartsAt,
            config.genesisEndsAt,
            config.initialFinalizedCursor,
            policy.policyHash
        );
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

    function scheduleMintRate(uint64 effectiveEpoch, uint256 mintRate) external onlyBootstrapAdmin {
        _requireScheduleEpoch(effectiveEpoch);
        if (mintRate == 0) revert InvalidConfiguration();
        if (scheduledMintRates[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledMintRates[effectiveEpoch] = ScheduledUint256({exists: true, value: mintRate});
        emit MintRateScheduled(effectiveEpoch, mintRate);
    }

    function scheduleAgentFoundationRate(uint64 effectiveEpoch, uint256 foundationBps) external onlyBootstrapAdmin {
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
        onlyBootstrapAdmin
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
        onlyBootstrapAdmin
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
        onlyBootstrapAdmin
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
    ) external onlyBootstrapAdmin {
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
        uint64 nextEpoch = lastOpenedEpoch + 1;
        uint256 startsAt = uint256(epochZeroStartsAt) + uint256(nextEpoch) * EPOCH_DURATION;
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
        _validateStandardInputs(policy, recipients, claims);

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

        uint256[] memory contributorMints = new uint256[](recipients.length);
        uint256 claimIndex;
        uint256 grossInput;
        uint256 contributorTotal;
        uint256 foundationTotal;

        for (uint256 i = 0; i < recipients.length; ++i) {
            uint256 points;
            uint256 recipientClaimCount = recipients[i].claimCount;
            for (uint256 j = 0; j < recipientClaimCount; ++j) {
                StandardPEClaim calldata claim = claims[claimIndex++];
                if (claimSettled[claim.claimId]) revert ClaimAlreadySettled();
                claimSettled[claim.claimId] = true;
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

            contributorMints[i] = contributorShare;
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
        _mintRecipients(recipients, contributorMints);
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
        _validateGenesisInputs(recipients, claims);

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

        uint256[] memory contributorMints = new uint256[](recipients.length);
        uint256 claimIndex;
        uint256 grossInput;
        uint256 contributorTotal;
        uint256 foundationTotal;

        for (uint256 i = 0; i < recipients.length; ++i) {
            uint256 recipientGross;
            uint256 recipientClaimCount = recipients[i].claimCount;
            for (uint256 j = 0; j < recipientClaimCount; ++j) {
                GenesisPEClaim calldata claim = claims[claimIndex++];
                if (claimSettled[claim.claimId]) revert ClaimAlreadySettled();
                claimSettled[claim.claimId] = true;

                bytes32 anchorKey = genesisAnchorKey(claim.grantType, claim.oneTimeAnchor);
                if (genesisAnchorUsed[anchorKey]) revert GenesisAnchorAlreadyUsed();
                genesisAnchorUsed[anchorKey] = true;

                uint256 walletGross = genesisWalletGrossIssued[claim.walletId] + claim.reservedGrossAtomic;
                if (walletGross > GENESIS_WALLET_GROSS_CEILING) revert GenesisWalletCeilingExceeded();
                genesisWalletGrossIssued[claim.walletId] = walletGross;
                recipientGross += claim.reservedGrossAtomic;
            }

            uint256 contributorShare = recipientGross.mulDiv(HUMAN_CONTRIBUTOR_BPS, BPS_DENOMINATOR);
            uint256 foundationShare = recipientGross.mulDiv(HUMAN_FOUNDATION_BPS, BPS_DENOMINATOR);
            contributorMints[i] = contributorShare;
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
        _mintGenesisRecipients(recipients, contributorMints);
        _mint(policy.provianTreasury, provianTotal);
        _mint(policy.foundationTreasury, foundationTotal);
    }

    function getEpochPolicy(uint64 epoch) external view returns (EpochPolicy memory) {
        return _epochPolicies[epoch];
    }

    function getBatchRecord(bytes32 batchId) external view returns (BatchRecord memory) {
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
            uint256 timeEpoch = (block.timestamp - epochZeroStartsAt) / EPOCH_DURATION;
            if (timeEpoch > type(uint64).max) revert ArithmeticDomainExceeded();
            // forge-lint: disable-next-line(unsafe-typecast)
            uint64 activeTimeEpoch = uint64(timeEpoch);
            if (activeTimeEpoch > boundary) boundary = activeTimeEpoch;
        }
        if (boundary == type(uint64).max) revert ArithmeticDomainExceeded();
        return boundary + 1;
    }

    function currentEpoch() external view returns (uint64) {
        if (!epochZeroArmed) revert EpochZeroNotArmed();
        if (block.timestamp < epochZeroStartsAt) revert EpochNotStarted();
        uint256 epoch = (block.timestamp - epochZeroStartsAt) / EPOCH_DURATION;
        if (epoch > type(uint64).max) revert ArithmeticDomainExceeded();
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(epoch);
    }

    function kernelRulesHash() public pure returns (bytes32) {
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

    function trailingAverageForEpoch(uint64 epoch) public view returns (uint256 average) {
        if (epoch < TRAILING_AVERAGE_EPOCHS) return 0;
        uint256 quotientTotal;
        uint256 remainderTotal;
        uint64 first = epoch - TRAILING_AVERAGE_EPOCHS;
        for (uint64 i = first; i < epoch; ++i) {
            uint256 issued = epochTotalIssued[i];
            quotientTotal += issued / TRAILING_AVERAGE_EPOCHS;
            remainderTotal += issued % TRAILING_AVERAGE_EPOCHS;
        }
        average = quotientTotal + remainderTotal / TRAILING_AVERAGE_EPOCHS;
    }

    function _writeEpochPolicy(uint64 epoch) private returns (EpochPolicy memory policy) {
        _requireConfiguredVerifier(_activeEligibilityVerifier);
        if (_activeAgentFoundationBps != HUMAN_FOUNDATION_BPS) {
            _requireConfiguredVerifier(_activeBeneficiaryVerifier);
        }

        uint256 startsAt = uint256(epochZeroStartsAt) + uint256(epoch) * EPOCH_DURATION;
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
        uint256 activeEpoch = (block.timestamp - epochZeroStartsAt) / EPOCH_DURATION;
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
        if (_batchRecords[batchId].settled) revert BatchAlreadySettled();
        if (recipientCount == 0) revert EmptyBatch();
        if (recipientCount > MAX_RECIPIENTS_PER_BATCH) revert TooManyRecipients();
        if (cursorEnd <= cursorStart) revert InvalidCursorRange();
        if (cursorStart != nextFinalizedCursor) revert CursorDiscontinuity();
        if (cursorEnd - cursorStart != claimCount) revert ClaimRangeMismatch();
    }

    function _validateStandardInputs(
        EpochPolicy memory policy,
        StandardRecipient[] calldata recipients,
        StandardPEClaim[] calldata claims
    ) private view {
        if (claims.length == 0) revert EmptyBatch();
        uint256 expectedClaims;
        address previous;
        bool differential = policy.agentFoundationBps != HUMAN_FOUNDATION_BPS;
        for (uint256 i = 0; i < recipients.length; ++i) {
            StandardRecipient calldata recipient = recipients[i];
            if (recipient.contributor <= previous) revert RecipientsNotStrictlyOrdered();
            previous = recipient.contributor;
            if (recipient.claimCount == 0 || expectedClaims + recipient.claimCount > claims.length) {
                revert ClaimRangeMismatch();
            }
            if (uint8(recipient.beneficiaryClass) > uint8(BeneficiaryClass.AutonomousAgent)) {
                revert BeneficiaryClassificationInvalid();
            }
            if (differential && recipient.beneficiaryClass == BeneficiaryClass.Unknown) {
                revert BeneficiaryClassificationRequired();
            }
            expectedClaims += recipient.claimCount;
        }
        if (expectedClaims != claims.length) revert ClaimRangeMismatch();
        for (uint256 i = 0; i < claims.length; ++i) {
            if (claims[i].claimId == bytes32(0) || claims[i].recordPointsAtomic == 0) revert InvalidClaim();
            if (claimSettled[claims[i].claimId]) revert ClaimAlreadySettled();
        }
    }

    function _validateGenesisInputs(GenesisRecipient[] calldata recipients, GenesisPEClaim[] calldata claims)
        private
        view
    {
        if (claims.length == 0) revert EmptyBatch();
        uint256 expectedClaims;
        address previous;
        uint64 lastQualifyingAt = genesisAdmissionClosed ? genesisAdmissionCutoff : genesisEndsAt;
        for (uint256 i = 0; i < recipients.length; ++i) {
            GenesisRecipient calldata recipient = recipients[i];
            if (recipient.contributor <= previous) revert RecipientsNotStrictlyOrdered();
            previous = recipient.contributor;
            if (recipient.claimCount == 0 || expectedClaims + recipient.claimCount > claims.length) {
                revert ClaimRangeMismatch();
            }
            expectedClaims += recipient.claimCount;
        }
        if (expectedClaims != claims.length) revert ClaimRangeMismatch();
        for (uint256 i = 0; i < claims.length; ++i) {
            GenesisPEClaim calldata claim = claims[i];
            if (
                claim.claimId == bytes32(0) || claim.walletId == bytes32(0) || claim.oneTimeAnchor == bytes32(0)
                    || claim.reservedGrossAtomic == 0
            ) revert InvalidClaim();
            if (claimSettled[claim.claimId]) revert ClaimAlreadySettled();
            if (
                claim.qualifiedAt < genesisStartsAt || claim.qualifiedAt > lastQualifyingAt
                    || claim.qualifiedAt > block.timestamp
            ) revert GenesisQualificationOutsideWindow();
            uint256 maximum = genesisGrantMaximum(claim.grantType);
            if (claim.reservedGrossAtomic > maximum) revert InvalidGenesisGrant();
            if (genesisAnchorUsed[genesisAnchorKey(claim.grantType, claim.oneTimeAnchor)]) {
                revert GenesisAnchorAlreadyUsed();
            }
            if (genesisWalletGrossIssued[claim.walletId] > GENESIS_WALLET_GROSS_CEILING - claim.reservedGrossAtomic) {
                revert GenesisWalletCeilingExceeded();
            }
        }
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
        (bool success, bytes memory result) = verifier.staticcall(callData);
        if (!success || result.length != 32) revert VerificationFailed();
        uint256 verdict;
        assembly ("memory-safe") {
            verdict := mload(add(result, 32))
        }
        if (verdict != 1) revert VerificationFailed();
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
        uint256 nextGenesisIssued = epochGenesisIssued[policy.epoch] + genesisIssued;
        if (nextGenesisIssued > policy.genesisCap) revert GenesisEpochCapExceeded();
        uint256 nextTotalIssued = epochTotalIssued[policy.epoch] + totalMinted;
        if (nextTotalIssued > policy.combinedCap) revert CombinedEpochCapExceeded();
        if (totalSupply > type(uint256).max - totalMinted) revert ArithmeticDomainExceeded();

        epochGenesisIssued[policy.epoch] = nextGenesisIssued;
        epochTotalIssued[policy.epoch] = nextTotalIssued;
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

    function _mintRecipients(StandardRecipient[] calldata recipients, uint256[] memory amounts) private {
        for (uint256 i = 0; i < recipients.length; ++i) {
            _mint(recipients[i].contributor, amounts[i]);
        }
    }

    function _mintGenesisRecipients(GenesisRecipient[] calldata recipients, uint256[] memory amounts) private {
        for (uint256 i = 0; i < recipients.length; ++i) {
            _mint(recipients[i].contributor, amounts[i]);
        }
    }

    function _mint(address to, uint256 amount) private {
        if (amount == 0) return;
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function _transfer(address from, address to, uint256 amount) private {
        if (to == address(0)) revert InvalidAddress();
        if (balanceOf[from] < amount) revert InsufficientBalance();
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    function _burn(address holder, uint256 amount) private {
        if (balanceOf[holder] < amount) revert InsufficientBalance();
        balanceOf[holder] -= amount;
        totalSupply -= amount;
        emit Transfer(holder, address(0), amount);
        emit Burned(holder, amount);
    }

    function _requireScheduleEpoch(uint64 effectiveEpoch) private view {
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
        if (foundationBps == HUMAN_FOUNDATION_BPS) return;
        _requireConfiguredVerifier(_effectiveBeneficiaryVerifierAt(effectiveEpoch));

        (bool hasNextRate, uint64 nextRateEpoch) = _nextAgentFoundationRateScheduleAfter(effectiveEpoch);
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
        if (config.verifier != address(0)) return;
        if (_effectiveAgentFoundationRateAt(effectiveEpoch) != HUMAN_FOUNDATION_BPS) {
            revert VerifierStateInvalid();
        }

        (bool hasNextVerifier, uint64 nextVerifierEpoch) = _nextBeneficiaryVerifierScheduleAfter(effectiveEpoch);
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

    function _nextAgentFoundationRateScheduleAfter(uint64 effectiveEpoch)
        private
        view
        returns (bool exists, uint64 nextEpoch)
    {
        for (uint256 i = 0; i < _agentFoundationRateScheduleEpochs.length; ++i) {
            uint64 rateEpoch = _agentFoundationRateScheduleEpochs[i];
            if (rateEpoch > effectiveEpoch && (!exists || rateEpoch < nextEpoch)) {
                exists = true;
                nextEpoch = rateEpoch;
            }
        }
    }

    function _nextBeneficiaryVerifierScheduleAfter(uint64 effectiveEpoch)
        private
        view
        returns (bool exists, uint64 nextEpoch)
    {
        for (uint256 i = 0; i < _beneficiaryVerifierScheduleEpochs.length; ++i) {
            uint64 verifierEpoch = _beneficiaryVerifierScheduleEpochs[i];
            if (verifierEpoch > effectiveEpoch && (!exists || verifierEpoch < nextEpoch)) {
                exists = true;
                nextEpoch = verifierEpoch;
            }
        }
    }
}
