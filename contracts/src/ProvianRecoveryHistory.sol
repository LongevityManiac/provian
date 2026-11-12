// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ProvianPVT9} from "./ProvianPVT9.sol";
interface IHistoryPolicyKernel {
    function predecessorHistory() external view returns (address);
    function epochZeroArmed() external view returns (bool);
    function scheduleMintRate(uint64 epoch,uint256 amount) external;
    function scheduleAgentFoundationRate(uint64 epoch,uint256 bps) external;
    function scheduleTreasuryDestinations(uint64 epoch,address provian,address foundation) external;
    function scheduleBeneficiaryVerifier(uint64 epoch,ProvianPVT9.VerifierConfig calldata config) external;
    function scheduleEligibilityVerifier(uint64 epoch,ProvianPVT9.VerifierConfig calldata config) external;
    function scheduleCapPolicy(uint64 epoch,ProvianPVT9.CombinedCapMode mode,uint256 genesis,uint256 combined) external;
}
interface IRetiredSettlementVerifier {
    function administrativeHold() external view returns (bool);
    function batchApprover() external view returns (address);
}

/// @notice Frozen predecessor monetary state. Import proofs are permissionless;
/// the snapshot root, count, clock and economics cannot be changed after deployment.
contract ProvianRecoveryHistory {
    struct EconomicSchedule {
        uint64 epoch;
        bool mintRateSet;
        uint256 mintRate;
        bool foundationRateSet;
        uint256 foundationRate;
        bool capsSet;
        uint256 genesisCap;
        uint256 combinedCap;
        bool treasuriesSet;
        address provianTreasury;
        address foundationTreasury;
        bool beneficiaryVerifierSet;
        ProvianPVT9.VerifierConfig beneficiaryVerifier;
        bool eligibilityVerifierSet;
        ProvianPVT9.VerifierConfig eligibilityVerifier;
    }
    struct HistoricalEpoch {
        ProvianPVT9.EpochPolicy policy;
        uint256 genesisIssued;
        uint256 totalIssued;
    }
    struct State {
        uint64 epochZeroStartsAt;
        uint64 genesisStartsAt;
        uint64 genesisEndsAt;
        bool genesisClosed;
        uint64 genesisCutoff;
        uint64 lastOpenedEpoch;
        uint256 nextCursor;
        bool administrativeHold;
        uint256 mintRate;
        uint256 agentFoundationBps;
        uint256 genesisCap;
        uint256 combinedCap;
        uint256 epochGenesisIssued;
        uint256 epochTotalIssued;
        EconomicSchedule[] schedules;
        HistoricalEpoch[] epochs;
        address provianTreasury;
        address foundationTreasury;
        ProvianPVT9.VerifierConfig beneficiaryVerifier;
        ProvianPVT9.VerifierConfig eligibilityVerifier;
        bytes32 economicRoot;
        uint256 economicCount;
    }
    bytes32 public immutable economicRoot;
    uint256 public immutable economicEntryCount;
    uint256 public immutable historicalEpochCount;
    uint256 public importedEconomicEntries;
    uint64 private lastImportedSchedule;
    mapping(uint256 => bytes) private economicEntries;
    mapping(address => uint256) public appliedEconomicEntries;
    bytes32 public immutable root;
    address public immutable predecessor;
    uint256 public immutable lastGoodBlock;
    uint256 public immutable entryCount;
    uint256 public importedCount;
    bytes internal encodedState;
    mapping(bytes32 => bool) public imported;
    mapping(bytes32 => bool) public claimSettled;
    mapping(bytes32 => bool) public genesisAnchorUsed;
    mapping(bytes32 => uint256) public genesisWalletGrossIssued;
    mapping(bytes32 => bool) public batchUsed;
    mapping(bytes32 => bytes) public batchRecords;
    error InvalidHistory();

    constructor(address predecessor_, uint256 lastGoodBlock_, bytes32 root_, uint256 entryCount_, State memory state_) {
        if (predecessor_ == address(0) || root_ == bytes32(0) || state_.epochZeroStartsAt == 0 || state_.genesisStartsAt == 0
            || state_.genesisEndsAt <= state_.genesisStartsAt || state_.mintRate == 0
            || state_.agentFoundationBps < 50 || state_.agentFoundationBps > 9950
            || state_.provianTreasury == address(0) || state_.foundationTreasury == address(0)
            || state_.eligibilityVerifier.verifier == address(0)
            || state_.eligibilityVerifier.configurationId == bytes32(0) || state_.eligibilityVerifier.version == 0
            || state_.epochGenesisIssued > state_.genesisCap || state_.epochTotalIssued > state_.combinedCap) revert InvalidHistory();
        root = root_;
        predecessor = predecessor_;
        lastGoodBlock = lastGoodBlock_;
        entryCount = entryCount_;
        economicRoot = state_.economicRoot;
        economicEntryCount = state_.economicCount;
        historicalEpochCount = state_.lastOpenedEpoch;
        lastImportedSchedule = state_.lastOpenedEpoch;
        uint64 previousEpoch = state_.lastOpenedEpoch;
        if (state_.economicRoot != bytes32(0)) {
            if (state_.epochs.length != 0 || state_.schedules.length != 0
                || state_.economicCount < state_.lastOpenedEpoch || state_.economicCount == 0) revert InvalidHistory();
        } else if (state_.economicCount != 0 || state_.epochs.length != state_.lastOpenedEpoch) revert InvalidHistory();
        for (uint256 i; i < state_.epochs.length; ++i) {
            HistoricalEpoch memory epoch = state_.epochs[i];
            if (!epoch.policy.opened || epoch.policy.epoch != i
                || epoch.policy.startsAt != state_.epochZeroStartsAt + i * 7 days
                || epoch.genesisIssued > epoch.policy.genesisCap || epoch.genesisIssued > epoch.totalIssued
                || epoch.totalIssued > epoch.policy.combinedCap) revert InvalidHistory();
        }
        for (uint256 i; i < state_.schedules.length; ++i) {
            EconomicSchedule memory next = state_.schedules[i];
            if (next.epoch <= previousEpoch || (next.mintRateSet && next.mintRate == 0)
                || (next.foundationRateSet && (next.foundationRate < 50 || next.foundationRate > 9950))
                || (next.treasuriesSet && (next.provianTreasury == address(0) || next.foundationTreasury == address(0)))) revert InvalidHistory();
            previousEpoch = next.epoch;
        }
        encodedState = abi.encode(state_);
    }
    function baseState() external view virtual returns (State memory) { return abi.decode(encodedState, (State)); }
    function state() external view virtual returns (State memory result) {
        result = abi.decode(encodedState, (State));
        if (economicRoot == bytes32(0)) return result;
        if (importedEconomicEntries != economicEntryCount) revert InvalidHistory();
        result.epochs = new HistoricalEpoch[](historicalEpochCount);
        result.schedules = new EconomicSchedule[](economicEntryCount - historicalEpochCount);
        for (uint256 i; i < economicEntryCount; ++i) {
            if (i < historicalEpochCount) result.epochs[i] = abi.decode(economicEntries[i], (HistoricalEpoch));
            else result.schedules[i - historicalEpochCount] = abi.decode(economicEntries[i], (EconomicSchedule));
        }
    }
    function economicEntry(uint256 index) external view returns (bytes memory data, bool isEpoch) {
        if (index >= importedEconomicEntries) revert InvalidHistory();
        return (economicEntries[index], index < historicalEpochCount);
    }
    function historicalPolicy(uint64 epoch) external view returns (ProvianPVT9.EpochPolicy memory) { return _historical(epoch).policy; }
    function historicalIssued(uint64 epoch,bool genesis) external view returns (uint256) {
        HistoricalEpoch memory value = _historical(epoch); return genesis ? value.genesisIssued : value.totalIssued;
    }
    function _historical(uint64 epoch) private view returns (HistoricalEpoch memory) {
        if (epoch >= historicalEpochCount || epoch >= importedEconomicEntries) revert InvalidHistory();
        return abi.decode(economicEntries[epoch],(HistoricalEpoch));
    }
    /// @notice A callback can install only the next proven source schedule, in
    /// its own unarmed successor. It has no general admin capability.
    function applyEconomicEntry(address kernel,uint256 index) external {
        if (index < appliedEconomicEntries[kernel]) return;
        IHistoryPolicyKernel target=IHistoryPolicyKernel(kernel);
        if (index != appliedEconomicEntries[kernel] || index >= importedEconomicEntries
            || target.predecessorHistory() != address(this) || target.epochZeroArmed()) revert InvalidHistory();
        if (index >= historicalEpochCount) {
            EconomicSchedule memory next=abi.decode(economicEntries[index],(EconomicSchedule));
            if(next.mintRateSet)target.scheduleMintRate(next.epoch,next.mintRate);
            if(next.foundationRateSet)target.scheduleAgentFoundationRate(next.epoch,next.foundationRate);
            if(next.capsSet)target.scheduleCapPolicy(next.epoch,ProvianPVT9.CombinedCapMode.Fixed,next.genesisCap,next.combinedCap);
            if(next.treasuriesSet)target.scheduleTreasuryDestinations(next.epoch,next.provianTreasury,next.foundationTreasury);
            if(next.beneficiaryVerifierSet)target.scheduleBeneficiaryVerifier(next.epoch,next.beneficiaryVerifier);
            if(next.eligibilityVerifierSet)target.scheduleEligibilityVerifier(next.epoch,next.eligibilityVerifier);
        }
        ++appliedEconomicEntries[kernel];
    }
    /// @notice Serial proof imports preserve epoch identity and schedule order.
    /// The root binds exact scalar history and cannot be amended by any caller.
    function importEconomicEntry(uint256 index, bytes calldata data, bytes32[] calldata proof) external {
        if (index >= economicEntryCount || index > importedEconomicEntries || proof.length > 256) revert InvalidHistory();
        bytes32 digest = sha256(abi.encode("Provian economic history", predecessor, lastGoodBlock, index, sha256(data)));
        for (uint256 i; i < proof.length; ++i) {
            bytes32 sibling = proof[i];
            digest = digest < sibling ? sha256(abi.encodePacked(digest, sibling)) : sha256(abi.encodePacked(sibling, digest));
        }
        if (digest != economicRoot) revert InvalidHistory();
        if (index < importedEconomicEntries) {
            if (keccak256(economicEntries[index]) != keccak256(data)) revert InvalidHistory();
            return;
        }
        State memory prior = abi.decode(encodedState, (State));
        if (index < historicalEpochCount) {
            HistoricalEpoch memory epoch = abi.decode(data, (HistoricalEpoch));
            if (!epoch.policy.opened || epoch.policy.epoch != index
                || epoch.policy.startsAt != prior.epochZeroStartsAt + index * 7 days
                || epoch.genesisIssued > epoch.policy.genesisCap || epoch.genesisIssued > epoch.totalIssued
                || epoch.totalIssued > epoch.policy.combinedCap) revert InvalidHistory();
        } else {
            EconomicSchedule memory next = abi.decode(data, (EconomicSchedule));
            if (next.epoch <= lastImportedSchedule || (next.mintRateSet && next.mintRate == 0)
                || (next.foundationRateSet && (next.foundationRate < 50 || next.foundationRate > 9950))
                || (next.treasuriesSet && (next.provianTreasury == address(0) || next.foundationTreasury == address(0)))) revert InvalidHistory();
            lastImportedSchedule = next.epoch;
        }
        economicEntries[index] = data;
        ++importedEconomicEntries;
    }
    function afterCryptographicBreak() external pure virtual returns (bool) { return false; }
    function complete() external view returns (bool) { return importedCount == entryCount && importedEconomicEntries == economicEntryCount; }
    /// @notice Migration changes verifier deployments, never their bound rule
    /// identities or version. Treasuries and economics remain the frozen values.
    /// New settlement cannot start while the predecessor can still mint.
    function validArming(ProvianPVT9.EpochZeroConfig calldata config, ProvianPVT9.VerifierConfig calldata beneficiary)
        external view virtual returns (bool) {
        State memory prior = abi.decode(encodedState, (State));
        if (importedEconomicEntries != economicEntryCount || !_armingMatches(prior, config, beneficiary)) return false;
        ProvianPVT9 old = ProvianPVT9(predecessor);
        IRetiredSettlementVerifier verifier = IRetiredSettlementVerifier(prior.eligibilityVerifier.verifier);
        return old.administrativeHold() && old.operationalMinter() == address(0)
            && verifier.administrativeHold() && verifier.batchApprover() == address(0);
    }
    function _armingMatches(State memory prior, ProvianPVT9.EpochZeroConfig calldata config,
        ProvianPVT9.VerifierConfig calldata beneficiary) internal pure returns (bool) {
        if (config.epochZeroStartsAt != prior.epochZeroStartsAt || config.genesisStartsAt != prior.genesisStartsAt
            || config.genesisEndsAt != prior.genesisEndsAt || config.initialMintRate != prior.mintRate
            || config.initialFinalizedCursor != prior.nextCursor || config.combinedCapMode != ProvianPVT9.CombinedCapMode.Fixed
            || config.genesisCap != prior.genesisCap || config.fixedCombinedCap != prior.combinedCap
            || config.provianTreasury != prior.provianTreasury || config.foundationTreasury != prior.foundationTreasury
            || config.eligibilityVerifier.configurationId != prior.eligibilityVerifier.configurationId
            || config.eligibilityVerifier.version != prior.eligibilityVerifier.version
            || beneficiary.configurationId != prior.beneficiaryVerifier.configurationId
            || beneficiary.version != prior.beneficiaryVerifier.version
            || ((beneficiary.verifier == address(0)) != (prior.beneficiaryVerifier.verifier == address(0)))) return false;
        return true;
    }
    function getBatchRecord(bytes32 key) external view returns (ProvianPVT9.BatchRecord memory result) {
        bytes memory encoded = batchRecords[key];
        if (encoded.length != 0) return abi.decode(encoded, (ProvianPVT9.BatchRecord));
    }

    /// kind: 0 settled claim; 1 consumed Genesis anchor; 2 cumulative wallet gross; 3 used batch.
    function importEntry(uint8 kind, bytes32 key, uint256 value, bytes32[] calldata proof) external {
        if (kind > 3 || key == bytes32(0) || (kind != 2 && value != 1)
            || (kind == 2 && value > 500 ether) || proof.length > 256) revert InvalidHistory();
        bytes32 leaf = sha256(abi.encode("Provian monetary history", predecessor, lastGoodBlock, kind, key, value));
        _consumeProof(leaf, proof);
        if (kind == 0) claimSettled[key] = true;
        else if (kind == 1) genesisAnchorUsed[key] = true;
        else if (kind == 2) {
            if (genesisWalletGrossIssued[key] != 0) revert InvalidHistory();
            genesisWalletGrossIssued[key] = value;
        } else batchUsed[key] = true;
    }

    /// @notice Preserve the exact predecessor settlement record, including its
    /// original domain hashes. A boolean alone cannot support receipt lookup.
    function importBatch(bytes32 key, ProvianPVT9.BatchRecord calldata record, bytes32[] calldata proof) external {
        if (key == bytes32(0) || !record.settled || batchRecords[key].length != 0
            || record.finalizedCursorEnd <= record.finalizedCursorStart
            || record.totalMinted != record.contributorTotal + record.provianTotal + record.foundationTotal
            || proof.length > 256) revert InvalidHistory();
        bytes memory encoded = abi.encode(record);
        _consumeProof(sha256(abi.encode("Provian settlement history", predecessor, lastGoodBlock, key, sha256(encoded))), proof);
        batchUsed[key] = true;
        batchRecords[key] = encoded;
    }

    function _consumeProof(bytes32 leaf, bytes32[] calldata proof) private {
        bytes32 digest = leaf;
        for (uint256 i; i < proof.length; ++i) {
            bytes32 sibling = proof[i];
            digest = digest < sibling ? sha256(abi.encodePacked(digest, sibling)) : sha256(abi.encodePacked(sibling, digest));
        }
        if (digest != root || imported[leaf] || importedCount >= entryCount) revert InvalidHistory();
        imported[leaf] = true;
        ++importedCount;
    }
}
