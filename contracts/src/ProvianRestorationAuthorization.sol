// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ProvianProtocolPointer} from "./ProvianProtocolPointer.sol";
import {ProvianHashAccount} from "./ProvianHashAccount.sol";
import {ProvianHashAccountFactory} from "./ProvianHashAccountFactory.sol";
import {RecourseOwnerAuthorization} from "./RecourseOwnerAuthorization.sol";
interface IRestorationEvidence {
    function ownerOf(address) external view returns (bytes32);
    function identityAttestor() external view returns (address);
    function consumeTheftEvidence(bytes32 operation, uint256 revision) external returns (bytes32);
    function bindRecovered(bytes32 identity, address account) external;
}
interface IRestorationPoolHistory {
    function determined(bytes32 request) external view returns (bool);
    function poolHistoryReady() external view returns (bool);
    function requiresSnapshotRecovery(bytes32 identity) external view returns (bool);
    function accountedBacking() external view returns (uint256);
    function allocatedRestorations() external view returns (uint256);
}
interface ICompletedRecoveryHistory { function complete() external view returns (bool); }
interface IRestorationCustody {
    function pvt() external view returns (address);
    function encumberedPVT() external view returns (uint256);
}
interface IRestorationKernel {
    function balanceOf(address account) external view returns (uint256);
    function snapshotBalance() external view returns (uint256);
    function predecessorHistory() external view returns (ICompletedRecoveryHistory);
    function registryOperator() external view returns (address);
    function outgoingSequence(address) external view returns (uint256);
    function restorationAuthority() external view returns (address);
    function protocolPointer() external view returns (ProvianProtocolPointer);
    function applyAuthorizedReversal(address[] calldata sources, uint256[] calldata amounts, address destination, uint256 revision) external returns (uint256);
    function importAuthorizedBalance(address destination, uint256 amount) external;
}
/// @notice Immutable kernel-bound proof executor. Both factors and the token
/// operation execute atomically; a failed operation consumes neither factor.
contract ProvianRestorationAuthorization is RecourseOwnerAuthorization {
    address public immutable kernel;
    bytes32 private activeIdentity;
    bytes32 private activeOperation;
    bytes32 private activeCommitment;
    bool private executing;
    bytes32 public immutable restorationRoot;
    address public immutable predecessor;
    uint256 public immutable lastGoodBlock;
    bool public immutable cryptographicBreak;
    uint256 public immutable pendingBreakAmount;
    uint256 public ordinaryImportedBalance;
    bool public institutionHistoryCommitted;
    uint256 public expectedInstitutionCount;
    uint256 public expectedInstitutionAmount;
    uint256 public importedInstitutionCount;
    uint256 public importedInstitutionAmount;
    function commitInstitutionHistory(uint256 count,uint256 amount,bytes32[] calldata proof) external {
        if (!cryptographicBreak || institutionHistoryCommitted || executing) revert InvalidRestoration();
        _verifySnapshot(sha256(abi.encode("Provian institution restoration count",predecessor,lastGoodBlock,count,amount)),proof);
        institutionHistoryCommitted=true;expectedInstitutionCount=count;expectedInstitutionAmount=amount;
    }
    function successionReady() external view returns (bool) {
        if (!IRestorationKernel(kernel).predecessorHistory().complete()) return false;
        if (cryptographicBreak) return reversalHistoryReady() && institutionHistoryCommitted
            && importedInstitutionCount==expectedInstitutionCount && importedInstitutionAmount==expectedInstitutionAmount;
        uint256 total=IRestorationKernel(kernel).snapshotBalance();
        return pendingBreakAmount<=total && ordinaryImportedBalance==total-pendingBreakAmount && reversalHistoryReady();
    }
    bytes32 public immutable hashAccountCodeHash;
    /// @notice A break-specific deterministic account domain. Ordinary
    /// successors discover this factory through their immutable breakOrigin.
    ProvianHashAccountFactory public immutable hashAccountFactory;
    mapping(address => bool) public migratedAddress;
    mapping(bytes32 => bool) private _restoredIdentity;
    function restoredIdentity(bytes32 identity) public view returns (bool) {
        return _restoredIdentity[identity] || (previousAuthorization != address(0)
            && ProvianRestorationAuthorization(previousAuthorization).restoredIdentity(identity));
    }
    function breakOrigin() public view returns (address) {
        if (cryptographicBreak) return address(this);
        return previousAuthorization == address(0) ? address(0)
            : ProvianRestorationAuthorization(previousAuthorization).breakOrigin();
    }
    mapping(bytes32 => bool) private _reversalExecuted;
    bool public reversalHistoryCommitted;
    uint256 public expectedReversalHistory;
    uint256 public importedReversalHistory;
    function reversalHistoryReady() public view returns (bool) {
        if (cryptographicBreak) return reversalHistoryCommitted && importedReversalHistory == expectedReversalHistory;
        return previousAuthorization == address(0) || ProvianRestorationAuthorization(previousAuthorization).reversalHistoryReady();
    }
    function commitReversalHistory(uint256 count, bytes32[] calldata proof) external {
        if (!cryptographicBreak || reversalHistoryCommitted || executing) revert InvalidRestoration();
        _verifySnapshot(sha256(abi.encode("Provian reversal history count", predecessor, lastGoodBlock, count)), proof);
        expectedReversalHistory = count;
        reversalHistoryCommitted = true;
    }
    struct ReversalEvidence { bytes32 identity; uint256 shortfall; bytes32 evidenceHash; }
    mapping(bytes32 => ReversalEvidence) private _reversalEvidence;
    address public immutable previousAuthorization;
    mapping(bytes32 => address) private _recoveredDestination;
    function _priorAuthorization() internal view override returns (address) { return previousAuthorization; }
    function reversalExecuted(bytes32 request) public view returns (bool) {
        return _reversalExecuted[request] || (previousAuthorization != address(0)
            && ProvianRestorationAuthorization(previousAuthorization).reversalExecuted(request));
    }
    function reversalEvidence(bytes32 request) public view returns (ReversalEvidence memory) {
        ReversalEvidence memory evidence = _reversalEvidence[request];
        return evidence.identity != bytes32(0) || previousAuthorization == address(0) ? evidence
            : ProvianRestorationAuthorization(previousAuthorization).reversalEvidence(request);
    }
    function reversalOutcome(bytes32 request) public view returns (bytes32) {
        ReversalEvidence memory evidence = reversalEvidence(request);
        if (evidence.identity == bytes32(0)) return bytes32(0);
        return sha256(abi.encode(request, evidence.identity, recoveredDestination(evidence.identity), evidence.shortfall, evidence.evidenceHash));
    }
    function recoveredDestination(bytes32 identity) public view returns (address) {
        address current = _recoveredDestination[identity];
        return current != address(0) || previousAuthorization == address(0) ? current
            : ProvianRestorationAuthorization(previousAuthorization).recoveredDestination(identity);
    }
    error InvalidRestoration();
    event BalanceMigrated(address indexed previousOwner, address indexed destination, uint256 amount);
    event IdentityRestored(bytes32 indexed identity, address indexed destination, uint256 amount);
    event ReversalHistoryImported(bytes32 indexed request, bytes32 indexed identity, uint256 shortfall, bytes32 evidenceHash);
    event TheftReversed(bytes32 indexed request, bytes32 indexed identity, address indexed destination, uint256 amount, bytes32 evidenceHash);
    constructor(address kernel_, bytes32 root, address previous, uint256 snapshotBlock, bool afterBreak, bytes32 accountCodeHash, uint256 pendingAmount) {
        if (kernel_ == address(0)) revert InvalidRestoration();
        if (afterBreak && pendingAmount != 0) revert InvalidRestoration();
        pendingBreakAmount = pendingAmount;
        kernel = kernel_; restorationRoot = root; predecessor = previous; lastGoodBlock = snapshotBlock;
        cryptographicBreak = afterBreak; hashAccountCodeHash = accountCodeHash;
        if (afterBreak) hashAccountFactory = new ProvianHashAccountFactory();
        if (!afterBreak) {
            (bool ok, bytes memory data) = previous.staticcall(abi.encodeWithSignature("ownerAuthorization()"));
            if (ok && data.length == 32) {
                address prior = abi.decode(data, (address));
                if (prior.code.length == 0 || ProvianRestorationAuthorization(prior).kernel() != previous) revert InvalidRestoration();
                previousAuthorization = prior;
            }
        }
    }
    function _ownerAuthorizationTarget() internal view override returns (address) { return kernel; }
    function bind(bytes32 identity, bytes32 commitment, bytes32 signingRoot) external {
        if (msg.sender != kernel) revert InvalidOwnerAuthorization();
        if (cryptographicBreak && IRestorationEvidence(IRestorationKernel(kernel).registryOperator())
            .identityAttestor().codehash != hashAccountCodeHash) revert InvalidOwnerAuthorization();
        if (cryptographicBreak) {
            IRestorationPoolHistory pool = IRestorationPoolHistory(IRestorationKernel(kernel).protocolPointer().component(8));
            if (!pool.poolHistoryReady() || pool.requiresSnapshotRecovery(identity)) revert InvalidOwnerAuthorization();
        }
        _bindOwnerAuthorization(identity, commitment, signingRoot);
    }
    function execute(bytes32 identity, bytes32 operationHash, OwnerProof calldata proof, bytes calldata payload) external {
        (uint8 kind,) = abi.decode(payload, (uint8, bytes));
        if (executing || kind > 3 || (kind < 2 && msg.sender != IRestorationKernel(kernel).restorationAuthority())
            || (kind >= 2 && snapshotRecoveryPending(identity))) revert InvalidOwnerAuthorization();
        ProvianProtocolPointer livePointer = IRestorationKernel(kernel).protocolPointer();
        livePointer.requireCurrent(livePointer.revision(), 0, kernel);
        executing = true;
        activeCommitment = ownerRecoveryCommitment(identity);
        _consumeOwnerAuthorization(identity, operationHash, proof);
        activeIdentity = identity;
        activeOperation = operationHash;
        _executeOwnerRestoration(payload);
        activeIdentity = bytes32(0);
        activeOperation = bytes32(0);
        activeCommitment = bytes32(0);
        executing = false;
    }
    /// @notice Permissionless exact-balance migration. The immutable snapshot
    /// maps old institutional custody to its verified successor and wallets 1:1.
    function importBalance(address previousOwner, address destination, uint256 amount, bytes32[] calldata proof) external {
        if (cryptographicBreak || previousOwner == address(0) || destination == address(0)
            || migratedAddress[previousOwner] || amount == 0) revert InvalidRestoration();
        bytes32 leaf = sha256(abi.encode("Provian balance succession", predecessor, lastGoodBlock, previousOwner, destination, amount));
        _verifySnapshot(leaf, proof);
        migratedAddress[previousOwner] = true;
        ordinaryImportedBalance += amount;
        IRestorationKernel(kernel).importAuthorizedBalance(destination, amount);
        emit BalanceMigrated(previousOwner, destination, amount);
    }
    /// @notice The frozen snapshot, not a potentially compromised relay key,
    /// establishes an owner's authorization after a cryptographic break.
    mapping(bytes32 => bool) private registeredBreakOwner;
    function snapshotRecoveryPending(bytes32 identity) public view returns (bool) {
        if (restoredIdentity(identity)) return false;
        return registeredBreakOwner[identity] || (previousAuthorization != address(0)
            && ProvianRestorationAuthorization(previousAuthorization).snapshotRecoveryPending(identity));
    }
    function registerBreakOwner(bytes32 identity, uint256 amount, bytes32 secret,
        bytes32 signingRoot, bytes32[] calldata snapshotProof) external {
        address origin = breakOrigin();
        if (origin == address(0) || executing || restoredIdentity(identity)) revert InvalidRestoration();
        bytes32 commitment = sha256(abi.encodePacked(secret, signingRoot));
        ProvianRestorationAuthorization source = ProvianRestorationAuthorization(origin);
        _verifyRoot(sha256(abi.encode("Provian restoration", source.predecessor(), source.lastGoodBlock(),
            identity, amount, commitment)), snapshotProof, source.restorationRoot());
        registeredBreakOwner[identity] = true;
        _bindOwnerAuthorization(identity, commitment, signingRoot);
    }
    /// @notice Preserve institution custody independently of individual owners.
    /// The snapshot commits the exact successor runtime as well as its address;
    /// a caller cannot redirect a bond or escrow balance into a personal account.
    function importInstitutionBalance(address previousInstitution, address destination,
        uint256 amount, bytes32 destinationCodeHash, bytes32[] calldata proof) external {
        if (!cryptographicBreak || executing || previousInstitution == address(0)
            || destination == address(0) || destination == previousInstitution || amount == 0
            || migratedAddress[previousInstitution] || destination.code.length == 0
            || destination.codehash != destinationCodeHash) revert InvalidRestoration();
        _verifySnapshot(sha256(abi.encode("Provian institution restoration", predecessor, lastGoodBlock,
            previousInstitution, destination, amount, destinationCodeHash)), proof);
        (bool ok, bytes memory result) = destination.staticcall(abi.encodeWithSignature("pvt()"));
        if (!ok || result.length != 32 || abi.decode(result, (address)) != kernel) revert InvalidRestoration();
        migratedAddress[previousInstitution] = true;
        ++importedInstitutionCount;importedInstitutionAmount += amount;
        IRestorationKernel(kernel).importAuthorizedBalance(destination, amount);
        emit BalanceMigrated(previousInstitution, destination, amount);
    }
    /// @notice A completed reversal remains completed after a break. Its unpaid
    /// pool remainder follows the same owner's independently recovered address.
    function importReversalHistory(bytes32 request, ReversalEvidence calldata evidence, bytes32[] calldata proof) external {
        if (!cryptographicBreak || executing || !reversalHistoryCommitted || importedReversalHistory >= expectedReversalHistory
            || request == bytes32(0) || reversalExecuted(request)
            || evidence.identity == bytes32(0) || evidence.evidenceHash == bytes32(0)) revert InvalidRestoration();
        _verifySnapshot(sha256(abi.encode("Provian reversal history", predecessor, lastGoodBlock,
            request, evidence.identity, evidence.shortfall, evidence.evidenceHash)), proof);
        _reversalExecuted[request] = true;
        _reversalEvidence[request] = evidence;
        ++importedReversalHistory;
        emit ReversalHistoryImported(request, evidence.identity, evidence.shortfall, evidence.evidenceHash);
    }
    function _verifySnapshot(bytes32 leaf, bytes32[] memory proof) private view {
        _verifyRoot(leaf, proof, restorationRoot);
    }
    function _verifyRoot(bytes32 leaf, bytes32[] memory proof, bytes32 root) private pure {
        if (proof.length > 256) revert InvalidRestoration();
        for (uint256 i; i < proof.length; ++i) {
            bytes32 sibling = proof[i];
            leaf = leaf < sibling ? sha256(abi.encodePacked(leaf, sibling)) : sha256(abi.encodePacked(sibling, leaf));
        }
        if (leaf != root) revert InvalidRestoration();
    }
    struct BreakRestoration {
        bytes32 identity;
        uint256 amount;
        bytes32 originalCommitment;
        ProvianHashAccount destination;
        bytes32 destinationKeyRoot;
        bytes32[] snapshotProof;
    }
    /// @notice A copied preimage cannot substitute the hash-signed destination.
    function _restoreAfterBreak(BreakRestoration memory r) private {
        address origin = breakOrigin();
        if (origin == address(0) || restoredIdentity(r.identity)
            || address(r.destination).codehash != hashAccountCodeHash
            || r.destination.keyCommitment() != r.destinationKeyRoot) revert InvalidRestoration();
        ProvianRestorationAuthorization source = ProvianRestorationAuthorization(origin);
        _verifyRoot(sha256(abi.encode("Provian restoration", source.predecessor(), source.lastGoodBlock(),
            r.identity, r.amount, r.originalCommitment)), r.snapshotProof, source.restorationRoot());
        if (activeCommitment != r.originalCommitment) revert InvalidRestoration();
        bytes32 operation = sha256(abi.encode("Provian cryptographic break", r.identity, r.amount,
            address(r.destination), r.destinationKeyRoot, source.predecessor(), source.lastGoodBlock()));
        _requireOwnerOperation(r.identity, operation);
        _restoredIdentity[r.identity] = true;
        if (r.amount != 0) IRestorationKernel(kernel).importAuthorizedBalance(address(r.destination), r.amount);
        _recoveredDestination[r.identity] = address(r.destination);
        IRestorationEvidence(IRestorationKernel(kernel).registryOperator()).bindRecovered(r.identity, address(r.destination));
        emit IdentityRestored(r.identity, address(r.destination), r.amount);
    }
    struct Reversal {
        bytes32 request;
        bytes32 identity;
        address destination;
        address[] sources;
        uint256[] amounts;
        uint256[] sourceSequences;
        address[] observationAccounts;
        uint256[] observationSequences;
        uint256 poolShortfall;
        bytes32 evidenceHash;
    }
    /// @notice One recovery action can authorize a named loss before its exact
    /// traced sources are determined. The owner fixes the loss and its ceiling;
    /// proceeds follow only independently owner-authorized recovery destinations.
    /// No reusable signing capability is stored.
    struct RestorationIntent {
        bytes32 request;
        bytes32 identity;
        address destination;
        bytes32 lossHash;
        uint256 maximumLoss;
    }
    mapping(bytes32 => RestorationIntent) private _restorationIntents;
    event RestorationIntentAuthorized(bytes32 indexed request, bytes32 indexed identity, address indexed destination,
        bytes32 lossHash, uint256 maximumLoss, bytes32 intentHash);
    event RestorationIntentImported(bytes32 indexed request, bytes32 indexed identity, address indexed destination,
        bytes32 lossHash, uint256 maximumLoss);
    /// @notice A last-good snapshot also preserves owner consent for a pending
    /// theft determination. Its original destination remains part of the scope;
    /// execution follows only the owner's independently recovered current key.
    /// The committed history count includes completed reversals and these
    /// pending intents, so arming cannot omit either kind of existing right.
    function importRestorationIntent(RestorationIntent calldata intent, bytes32[] calldata proof) external {
        if (!cryptographicBreak || executing || !reversalHistoryCommitted || importedReversalHistory >= expectedReversalHistory
            || intent.request == bytes32(0) || intent.identity == bytes32(0) || intent.destination == address(0)
            || intent.lossHash == bytes32(0) || intent.maximumLoss == 0
            || _restorationIntents[intent.request].identity != bytes32(0) || reversalExecuted(intent.request)) revert InvalidRestoration();
        _verifySnapshot(sha256(abi.encode("Provian pending restoration intent", predecessor, lastGoodBlock, intent)), proof);
        _restorationIntents[intent.request] = intent;
        ++importedReversalHistory;
        emit RestorationIntentImported(intent.request, intent.identity, intent.destination, intent.lossHash, intent.maximumLoss);
    }
    function restorationIntent(bytes32 request) public view returns (RestorationIntent memory intent) {
        intent = _restorationIntents[request];
        if (intent.identity == bytes32(0) && previousAuthorization != address(0)) {
            intent = ProvianRestorationAuthorization(previousAuthorization).restorationIntent(request);
        }
    }
    function restorationIntentHash(RestorationIntent memory intent) private pure returns (bytes32) {
        return sha256(abi.encode("Provian bounded restoration intent", intent));
    }
    function scopedReversalHash(RestorationIntent memory intent, Reversal memory reversal) private pure returns (bytes32) {
        return sha256(abi.encode("Provian scoped theft reversal", restorationIntentHash(intent), reversal));
    }
    function _authorizeRestorationIntent(RestorationIntent memory intent, uint256 revision) private {
        IRestorationKernel(kernel).protocolPointer().requireCurrent(revision, 0, kernel);
        if (intent.request == bytes32(0) || intent.identity == bytes32(0) || intent.destination == address(0)
            || intent.lossHash == bytes32(0) || intent.maximumLoss == 0 || reversalExecuted(intent.request)
            || restorationIntent(intent.request).identity != bytes32(0)
            || IRestorationEvidence(IRestorationKernel(kernel).registryOperator()).ownerOf(intent.destination) != bytes32(0)) revert InvalidRestoration();
        bytes32 digest = restorationIntentHash(intent);
        _requireOwnerOperation(intent.identity, digest);
        _restorationIntents[intent.request] = intent;
        _recoveredDestination[intent.identity] = intent.destination;
        IRestorationEvidence(IRestorationKernel(kernel).registryOperator()).bindRecovered(intent.identity, intent.destination);
        emit RestorationIntentAuthorized(intent.request, intent.identity, intent.destination, intent.lossHash, intent.maximumLoss, digest);
    }
    /// @notice The consumed owner proof survives evidence processing as a fixed,
    /// one-use intent. Independent attestation must name the exact refreshed
    /// sources and amounts, and cannot widen the owner's scope.
    function executeRestorationIntent(Reversal calldata reversal, uint256 revision) external {
        if (executing || msg.sender != IRestorationKernel(kernel).restorationAuthority()) revert InvalidOwnerAuthorization();
        IRestorationKernel(kernel).protocolPointer().requireCurrent(revision, 0, kernel);
        RestorationIntent memory intent = restorationIntent(reversal.request);
        // A later independent owner recovery moves existing restoration rights
        // to that owner's current key. The original loss commitment and ceiling
        // remain fixed, and attestation still binds the exact final destination.
        if (intent.identity == bytes32(0) || intent.identity != reversal.identity
            || recoveredDestination(intent.identity) != reversal.destination) revert InvalidRestoration();
        uint256 total = reversal.poolShortfall;
        for (uint256 i; i < reversal.amounts.length; ++i) total += reversal.amounts[i];
        if (total > intent.maximumLoss) revert InvalidRestoration();
        executing = true;
        _reverseTheftAuthorized(reversal, revision, scopedReversalHash(intent, reversal));
        executing = false;
    }
    function reversalOperationHash(Reversal memory reversal) private pure returns (bytes32) {
        return sha256(abi.encode("Provian theft reversal", reversal));
    }
    /// @notice Both authority and exact owner proof are necessary. Source selection
    /// follows the published witnessed-exchange rule; its evidence digest is public.
    function _reverseTheft(Reversal memory reversal, uint256 expectedRevision) private {
        bytes32 operation = reversalOperationHash(reversal);
        _requireOwnerOperation(reversal.identity, operation);
        _reverseTheftAuthorized(reversal, expectedRevision, operation);
    }
    function _reverseTheftAuthorized(Reversal memory reversal, uint256 expectedRevision, bytes32 operation) private {
        if (!reversalHistoryReady() || reversal.request == bytes32(0) || reversalExecuted(reversal.request) || reversal.evidenceHash == bytes32(0)
            || IRestorationPoolHistory(IRestorationKernel(kernel).protocolPointer().component(8)).determined(reversal.request)) revert InvalidRestoration();
        // A protected or unresolved recipient can return the loss before this
        // transaction lands. Fence every observed trail holder, not only the
        // addresses from which this reversal destroys tokens.
        if (reversal.observationAccounts.length == 0
            || reversal.observationAccounts.length != reversal.observationSequences.length) revert InvalidRestoration();
        address previous;
        for (uint256 i; i < reversal.observationAccounts.length; ++i) {
            address account = reversal.observationAccounts[i];
            if (account <= previous || IRestorationKernel(kernel).outgoingSequence(account)
                != reversal.observationSequences[i]) revert InvalidRestoration();
            previous = account;
        }
        if (reversal.sources.length != reversal.sourceSequences.length) revert InvalidRestoration();
        for (uint256 i; i < reversal.sources.length; ++i) {
            if (IRestorationKernel(kernel).outgoingSequence(reversal.sources[i]) != reversal.sourceSequences[i]) revert InvalidRestoration();
        }
        // Member reserve interests and already allocated restorations are
        // witnessed obligations, not gratuitous receipts. Re-evaluate at
        // execution: a contribution or allocation need not change the pool's
        // outgoing sequence. Unencumbered donations remain reachable.
        if (reversal.sources.length != reversal.amounts.length) revert InvalidRestoration();
        address pool = IRestorationKernel(kernel).protocolPointer().component(8);
        uint256 poolDebit;
        for (uint256 i; i < reversal.sources.length; ++i) {
            if (reversal.sources[i] == pool) poolDebit += reversal.amounts[i];
        }
        if (poolDebit != 0) {
            uint256 balance = IRestorationKernel(kernel).balanceOf(pool);
            uint256 encumbered = IRestorationPoolHistory(pool).accountedBacking()
                + IRestorationPoolHistory(pool).allocatedRestorations();
            if (balance < encumbered || poolDebit > balance - encumbered) revert InvalidRestoration();
        }
        // Escrow principal, project contributions, bonds, Court collateral and
        // awards are also witnessed obligations. Their unsolicited surplus is
        // reachable, but a reversal cannot turn another owner's exit insolvent.
        (,, address[10] memory components,) = IRestorationKernel(kernel).protocolPointer().current();
        for (uint256 slot = 3; slot <= 7; ++slot) {
            if (slot == 4) continue; // Promises never retain principal.
            address institution = components[slot];
            uint256 debit;
            for (uint256 i; i < reversal.sources.length; ++i) {
                if (reversal.sources[i] == institution) debit += reversal.amounts[i];
            }
            if (debit == 0) continue;
            if (IRestorationCustody(institution).pvt() != kernel) revert InvalidRestoration();
            uint256 balance = IRestorationKernel(kernel).balanceOf(institution);
            uint256 obligations = IRestorationCustody(institution).encumberedPVT();
            if (balance < obligations || debit > balance - obligations) revert InvalidRestoration();
        }
        if (IRestorationEvidence(IRestorationKernel(kernel).registryOperator()).consumeTheftEvidence(operation, expectedRevision)
            != operation) revert InvalidRestoration();
        _reversalExecuted[reversal.request] = true;
        if (reversal.sources.length != reversal.amounts.length || reversal.destination == address(0)) revert InvalidRestoration();
        uint256 reversed;
        if (reversal.sources.length != 0) {
            reversed = IRestorationKernel(kernel).applyAuthorizedReversal(reversal.sources, reversal.amounts, reversal.destination, expectedRevision);
        }
        _reversalEvidence[reversal.request] = ReversalEvidence(reversal.identity, reversal.poolShortfall, reversal.evidenceHash);
        _recoveredDestination[reversal.identity] = reversal.destination;
        IRestorationEvidence(IRestorationKernel(kernel).registryOperator()).bindRecovered(reversal.identity, reversal.destination);
        emit TheftReversed(reversal.request, reversal.identity, reversal.destination, reversed, reversal.evidenceHash);
    }
    function _requireOwnerOperation(bytes32 identity, bytes32 operation) private view {
        if (activeIdentity != identity || activeOperation != operation) revert InvalidRestoration();
    }
    function _executeOwnerRestoration(bytes calldata payload) private {
        (uint8 kind, bytes memory body) = abi.decode(payload, (uint8, bytes));
        if (kind == 0) {
            (Reversal memory r, uint256 revision) = abi.decode(body, (Reversal, uint256));
            _reverseTheft(r, revision);
        } else if (kind == 1) {
            BreakRestoration memory r = abi.decode(body, (BreakRestoration));
            _restoreAfterBreak(r);
        } else if (kind == 2) {
            (bytes32 identity, address destination, uint256 revision) = abi.decode(body, (bytes32, address, uint256));
            IRestorationKernel(kernel).protocolPointer().requireCurrent(revision, 0, kernel);
            if (destination == address(0)) revert InvalidRestoration();
            _requireOwnerOperation(identity, sha256(abi.encode("Provian ownership recovery", identity, destination)));
            _recoveredDestination[identity] = destination;
            IRestorationEvidence(IRestorationKernel(kernel).registryOperator()).bindRecovered(identity, destination);
        } else if (kind == 3) {
            (RestorationIntent memory intent, uint256 revision) = abi.decode(body, (RestorationIntent, uint256));
            _authorizeRestorationIntent(intent, revision);
        } else revert InvalidRestoration();
    }
}
