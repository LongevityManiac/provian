// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProvianPVT9} from "./ProvianPVT9.sol";
import {IPVT9EligibilityVerifier} from "./interfaces/IPVT9Verifiers.sol";

/**
 * @title ProvianPVT9EligibilityVerifier
 * @notice The production eligibility verifier for the PVT9 settlement kernel.
 *
 * @dev This is a COMMITMENT ORACLE, not a policy interpreter.
 *
 * The kernel reaches a verifier through `STATICCALL` and hands it only an opaque
 * `settlementDigest` plus the verifier's own `configurationId`/`version`
 * (`ProvianPVT9._verifyEligibility`). It cannot see a single PE field, so no
 * eligibility rule can be evaluated here. Eligibility is decided OFF-CHAIN by the
 * evaluator that assembles the batch; this contract's only job is to attest:
 *
 *     "I independently re-derived this exact digest from the recipients and claims
 *      I was given, and I approved that batch."
 *
 * The digest preimage (`ProvianPVT9.computeSettlementDigest`) is reproducible from
 * public inputs, which is what makes that attestation checkable. Because the
 * settlement-time call is a `STATICCALL`, the approval must be recorded in a prior
 * state-changing transaction that carries the whole batch — there is no way to hand
 * the batch to a `view` function. `approveStandardBatch`/`approveGenesisBatch`
 * therefore take the batch, never a digest: a digest cannot be injected, only derived.
 *
 * Fail-closed everywhere. `verifyStandardBatch`/`verifyGenesisBatch` return `true`
 * only when every one of these holds, and `false` otherwise:
 *   - the contract is not under administrative hold,
 *   - the chain id still matches the one this verifier was deployed against,
 *   - `configurationId` and `configurationVersion` match this deployment exactly,
 *   - the digest is non-zero and carries a live approval,
 *   - that approval was recorded for the SAME lane now asking.
 *
 * The kernel treats a revert, a short return, and any word other than exactly `1` as
 * identical denials, so returning `false` is a complete denial — it reverts the whole
 * settlement (`ProvianPVT9._requireTrueVerifierResult`).
 *
 * Configuration is immutable. A new eligibility policy version means deploying a new
 * verifier and calling `scheduleEligibilityVerifier` on the kernel for a future epoch,
 * which is the kernel's own designed path; it is not an in-place upgrade.
 */
contract ProvianPVT9EligibilityVerifier is IPVT9EligibilityVerifier {
    /// @notice Sole administrator. Identical to `ProvianPVT9.BOOTSTRAP_ADMIN` by
    /// construction, so the verifier answers to exactly the same principal as the kernel.
    address public constant BOOTSTRAP_ADMIN = 0xCa37a15A64213b2ACD1784ae3f8e6Cbd4600D9D3;

    /// @dev Mirrors of the kernel's private domain separators. Every one of these is
    /// cross-checked against the kernel's own hashing functions on each approval, so a
    /// silent drift reverts the approval instead of producing an unusable digest.
    bytes32 private constant STANDARD_CLAIMS_DOMAIN = keccak256("provian.pvt9.standard-claims.v1");
    bytes32 private constant GENESIS_CLAIMS_DOMAIN = keccak256("provian.pvt9.genesis-claims.v1");
    bytes32 private constant SETTLEMENT_DOMAIN = keccak256("provian.pvt9.settlement.v1");

    /// @dev Mirrors `ProvianPVT9.MAX_RECIPIENTS_PER_BATCH`; asserted equal in the
    /// constructor against the live kernel.
    uint256 private constant MAX_RECIPIENTS_PER_BATCH = 500;

    /// @dev Mirrors `ProvianPVT9.GENESIS_DEVICE_LINK`, the highest valid grant type;
    /// asserted equal in the constructor against the live kernel.
    uint8 private constant MAX_GENESIS_GRANT_TYPE = 2;

    /// @notice The settlement kernel this verifier attests for. The digest binds
    /// `address(this)` of the KERNEL, so an approval is useless to any other kernel.
    ProvianPVT9 public immutable KERNEL;

    /// @notice Chain this verifier was deployed against. A post-fork chain cannot reuse
    /// approvals recorded before the fork, and the verifier refuses to operate at all off it.
    uint256 public immutable DEPLOYMENT_CHAIN_ID;

    /// @notice The eligibility configuration this deployment attests under. Immutable:
    /// a policy change is a new deployment plus `scheduleEligibilityVerifier`.
    bytes32 public immutable CONFIGURATION_ID;
    uint64 public immutable CONFIGURATION_VERSION;

    /// @notice Appointed by the admin; the only account that may approve or revoke a
    /// batch. Mirrors the kernel's single `operationalMinter` role.
    address public batchApprover;

    /// @notice Emergency stop. While held, every verification denies, which fail-closes
    /// settlement without touching any recorded approval.
    bool public administrativeHold;

    struct BatchApproval {
        bool approved;
        ProvianPVT9.SettlementLane lane;
    }

    /// @dev digest => approval. Keyed by the digest the oracle DERIVED, never one supplied.
    mapping(bytes32 => BatchApproval) private _approvals;

    event BatchApproverAppointed(address indexed previousApprover, address indexed newApprover);
    event BatchApproverRevoked(address indexed previousApprover);
    event AdministrativeHoldPlaced();
    event AdministrativeHoldResumed();
    event BatchApproved(
        bytes32 indexed settlementDigest,
        ProvianPVT9.SettlementLane indexed lane,
        bytes32 indexed batchId,
        uint64 epoch,
        bytes32 claimsHash,
        uint256 recipientCount,
        uint256 claimCount
    );
    event BatchApprovalRevoked(bytes32 indexed settlementDigest, ProvianPVT9.SettlementLane indexed lane);

    error OnlyBootstrapAdmin();
    error OnlyBatchApprover();
    error ApproverUnconfigured();
    error InvalidConfiguration();
    error ChainMismatch();
    error Held();
    error BatchAlreadyApproved();
    error BatchNotApproved();
    error LaneMismatch();
    error EmptyBatch();
    error TooManyRecipients();
    error InvalidIdentifier();
    error InvalidClaim();
    error InvalidGenesisGrant();
    error ClaimRangeMismatch();
    error InvalidCursorRange();
    error RecipientsNotStrictlyOrdered();
    error KernelDerivationMismatch();

    modifier onlyBootstrapAdmin() {
        if (msg.sender != BOOTSTRAP_ADMIN) revert OnlyBootstrapAdmin();
        _;
    }

    modifier onlyBatchApprover() {
        address approver = batchApprover;
        if (approver == address(0)) revert ApproverUnconfigured();
        if (msg.sender != approver) revert OnlyBatchApprover();
        _;
    }

    modifier whenNotHeld() {
        if (administrativeHold) revert Held();
        _;
    }

    constructor(ProvianPVT9 kernel, bytes32 configurationId, uint64 configurationVersion) {
        // The kernel's own `_requireConfiguredVerifier` rejects a zero id or version, so a
        // deployment that could never be scheduled is refused at construction instead.
        if (address(kernel) == address(0) || address(kernel).code.length == 0) revert InvalidConfiguration();
        if (configurationId == bytes32(0) || configurationVersion == 0) revert InvalidConfiguration();
        if (kernel.MAX_RECIPIENTS_PER_BATCH() != MAX_RECIPIENTS_PER_BATCH) revert KernelDerivationMismatch();
        if (kernel.GENESIS_DEVICE_LINK() != MAX_GENESIS_GRANT_TYPE) revert KernelDerivationMismatch();

        KERNEL = kernel;
        DEPLOYMENT_CHAIN_ID = block.chainid;
        CONFIGURATION_ID = configurationId;
        CONFIGURATION_VERSION = configurationVersion;
    }

    // ---------------------------------------------------------------------------
    // Administration
    // ---------------------------------------------------------------------------

    function appointBatchApprover(address newApprover) external onlyBootstrapAdmin {
        if (newApprover == address(0)) revert InvalidConfiguration();
        address previous = batchApprover;
        batchApprover = newApprover;
        emit BatchApproverAppointed(previous, newApprover);
    }

    function revokeBatchApprover() external onlyBootstrapAdmin {
        address previous = batchApprover;
        batchApprover = address(0);
        emit BatchApproverRevoked(previous);
    }

    function placeAdministrativeHold() external onlyBootstrapAdmin {
        administrativeHold = true;
        emit AdministrativeHoldPlaced();
    }

    function resumeFromAdministrativeHold() external onlyBootstrapAdmin {
        administrativeHold = false;
        emit AdministrativeHoldResumed();
    }

    // ---------------------------------------------------------------------------
    // Approval — the oracle derives the digest; it is never handed one
    // ---------------------------------------------------------------------------

    /**
     * @notice Record that the off-chain evaluator approved this exact standard batch.
     * @dev Returns the digest it derived so the caller can assert against its own copy.
     */
    function approveStandardBatch(
        bytes32 batchId,
        uint64 epoch,
        bytes32 policyHash,
        uint256 finalizedCursorStart,
        uint256 finalizedCursorEnd,
        ProvianPVT9.StandardRecipient[] calldata recipients,
        ProvianPVT9.StandardPEClaim[] calldata claims
    ) external onlyBatchApprover whenNotHeld returns (bytes32 settlementDigest) {
        _requireDeploymentChain();
        _validateHeader(batchId, policyHash, finalizedCursorStart, finalizedCursorEnd, recipients.length, claims.length);
        _validateStandardShape(recipients, claims);

        bytes32 claimsHash = keccak256(abi.encode(STANDARD_CLAIMS_DOMAIN, recipients, claims));
        // Independent cross-check: the kernel's own hashing must agree with the mirror
        // above, or the mirror has drifted and no approval may be recorded.
        if (claimsHash != KERNEL.hashStandardClaims(recipients, claims)) revert KernelDerivationMismatch();

        settlementDigest = _deriveSettlementDigest(
            ProvianPVT9.SettlementLane.StandardPE,
            batchId,
            epoch,
            policyHash,
            finalizedCursorStart,
            finalizedCursorEnd,
            claimsHash
        );

        _recordApproval(
            settlementDigest,
            ProvianPVT9.SettlementLane.StandardPE,
            batchId,
            epoch,
            claimsHash,
            recipients.length,
            claims.length
        );
    }

    /**
     * @notice Record that the off-chain evaluator approved this exact Genesis batch.
     * @dev Returns the digest it derived so the caller can assert against its own copy.
     */
    function approveGenesisBatch(
        bytes32 batchId,
        uint64 epoch,
        bytes32 policyHash,
        uint256 finalizedCursorStart,
        uint256 finalizedCursorEnd,
        ProvianPVT9.GenesisRecipient[] calldata recipients,
        ProvianPVT9.GenesisPEClaim[] calldata claims
    ) external onlyBatchApprover whenNotHeld returns (bytes32 settlementDigest) {
        _requireDeploymentChain();
        _validateHeader(batchId, policyHash, finalizedCursorStart, finalizedCursorEnd, recipients.length, claims.length);
        _validateGenesisShape(recipients, claims);

        bytes32 claimsHash = keccak256(abi.encode(GENESIS_CLAIMS_DOMAIN, recipients, claims));
        if (claimsHash != KERNEL.hashGenesisClaims(recipients, claims)) revert KernelDerivationMismatch();

        settlementDigest = _deriveSettlementDigest(
            ProvianPVT9.SettlementLane.GenesisPE,
            batchId,
            epoch,
            policyHash,
            finalizedCursorStart,
            finalizedCursorEnd,
            claimsHash
        );

        _recordApproval(
            settlementDigest,
            ProvianPVT9.SettlementLane.GenesisPE,
            batchId,
            epoch,
            claimsHash,
            recipients.length,
            claims.length
        );
    }

    /**
     * @notice Withdraw an approval before it settles.
     * @dev The lane must be stated and must match what was recorded, so a mistaken
     * revocation cannot silently clear the other lane's approval.
     */
    function revokeBatchApproval(bytes32 settlementDigest, ProvianPVT9.SettlementLane lane)
        external
        onlyBatchApprover
    {
        BatchApproval storage approval = _approvals[settlementDigest];
        if (!approval.approved) revert BatchNotApproved();
        if (approval.lane != lane) revert LaneMismatch();
        approval.approved = false;
        emit BatchApprovalRevoked(settlementDigest, lane);
    }

    // ---------------------------------------------------------------------------
    // IPVT9EligibilityVerifier — the settlement-time read
    // ---------------------------------------------------------------------------

    function verifyStandardBatch(bytes32 settlementDigest, bytes32 configurationId, uint64 configurationVersion)
        external
        view
        returns (bool)
    {
        return _isAffirmed(settlementDigest, configurationId, configurationVersion, ProvianPVT9.SettlementLane.StandardPE);
    }

    function verifyGenesisBatch(bytes32 settlementDigest, bytes32 configurationId, uint64 configurationVersion)
        external
        view
        returns (bool)
    {
        return _isAffirmed(settlementDigest, configurationId, configurationVersion, ProvianPVT9.SettlementLane.GenesisPE);
    }

    // ---------------------------------------------------------------------------
    // Introspection
    // ---------------------------------------------------------------------------

    function batchApproval(bytes32 settlementDigest)
        external
        view
        returns (bool approved, ProvianPVT9.SettlementLane lane)
    {
        BatchApproval memory approval = _approvals[settlementDigest];
        return (approval.approved, approval.lane);
    }

    // ---------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------

    /**
     * @dev Every clause is a denial the kernel would have to honour anyway; expressing
     * them as `false` rather than a revert keeps the `view` contract total.
     */
    function _isAffirmed(
        bytes32 settlementDigest,
        bytes32 configurationId,
        uint64 configurationVersion,
        ProvianPVT9.SettlementLane lane
    ) private view returns (bool) {
        if (administrativeHold) return false;
        if (block.chainid != DEPLOYMENT_CHAIN_ID) return false;
        if (configurationId != CONFIGURATION_ID) return false;
        if (configurationVersion != CONFIGURATION_VERSION) return false;
        // Redundant by construction — the zero key is never approved, so the lookup below
        // already denies it. Retained as an explicit statement of the fail-closed contract
        // and as insurance if the approval record ever gains a non-zero default. It is the
        // one guard here that no mutation can kill; see WP_EV_RUN_LOG.md.
        if (settlementDigest == bytes32(0)) return false;

        BatchApproval memory approval = _approvals[settlementDigest];
        if (!approval.approved) return false;
        if (approval.lane != lane) return false;
        return true;
    }

    function _deriveSettlementDigest(
        ProvianPVT9.SettlementLane lane,
        bytes32 batchId,
        uint64 epoch,
        bytes32 policyHash,
        uint256 finalizedCursorStart,
        uint256 finalizedCursorEnd,
        bytes32 claimsHash
    ) private view returns (bytes32 digest) {
        digest = keccak256(
            abi.encode(
                SETTLEMENT_DOMAIN,
                block.chainid,
                address(KERNEL),
                lane,
                batchId,
                epoch,
                policyHash,
                finalizedCursorStart,
                finalizedCursorEnd,
                claimsHash
            )
        );
        // The kernel binds its OWN address and chain id into the digest, so asking it to
        // recompute is the only way to prove the mirror above reproduces the exact
        // preimage the settlement path will build.
        bytes32 kernelDigest = KERNEL.computeSettlementDigest(
            lane, batchId, epoch, policyHash, finalizedCursorStart, finalizedCursorEnd, claimsHash
        );
        if (digest != kernelDigest) revert KernelDerivationMismatch();
    }

    function _recordApproval(
        bytes32 settlementDigest,
        ProvianPVT9.SettlementLane lane,
        bytes32 batchId,
        uint64 epoch,
        bytes32 claimsHash,
        uint256 recipientCount,
        uint256 claimCount
    ) private {
        BatchApproval storage approval = _approvals[settlementDigest];
        if (approval.approved) revert BatchAlreadyApproved();
        approval.approved = true;
        approval.lane = lane;
        emit BatchApproved(settlementDigest, lane, batchId, epoch, claimsHash, recipientCount, claimCount);
    }

    function _requireDeploymentChain() private view {
        if (block.chainid != DEPLOYMENT_CHAIN_ID) revert ChainMismatch();
    }

    /**
     * @dev Mirrors the stateless half of `ProvianPVT9._validateBatchHeader`. The stateful
     * clauses (`nextFinalizedCursor` continuity, `_batchRecords[batchId].settled`) are
     * knowingly omitted — the oracle cannot observe them, and the kernel enforces them at
     * settlement. Everything checked here is a hard kernel revert, so refusing to approve
     * a batch that fails it is never more restrictive than the kernel itself.
     */
    function _validateHeader(
        bytes32 batchId,
        bytes32 policyHash,
        uint256 cursorStart,
        uint256 cursorEnd,
        uint256 recipientCount,
        uint256 claimCount
    ) private pure {
        if (batchId == bytes32(0)) revert InvalidIdentifier();
        // A zero policy hash can never match an opened epoch (`_requireSettlementPolicy`).
        if (policyHash == bytes32(0)) revert InvalidIdentifier();
        if (recipientCount == 0 || claimCount == 0) revert EmptyBatch();
        if (recipientCount > MAX_RECIPIENTS_PER_BATCH) revert TooManyRecipients();
        if (cursorEnd <= cursorStart) revert InvalidCursorRange();
        if (cursorEnd - cursorStart != claimCount) revert ClaimRangeMismatch();
    }

    /// @dev Mirrors the stateless half of `ProvianPVT9._validateStandardInputs`.
    function _validateStandardShape(
        ProvianPVT9.StandardRecipient[] calldata recipients,
        ProvianPVT9.StandardPEClaim[] calldata claims
    ) private pure {
        uint256 expectedClaims;
        address previous;
        for (uint256 i = 0; i < recipients.length; ++i) {
            ProvianPVT9.StandardRecipient calldata recipient = recipients[i];
            if (recipient.contributor <= previous) revert RecipientsNotStrictlyOrdered();
            previous = recipient.contributor;
            if (recipient.claimCount == 0 || expectedClaims + recipient.claimCount > claims.length) {
                revert ClaimRangeMismatch();
            }
            if (uint8(recipient.beneficiaryClass) > uint8(ProvianPVT9.BeneficiaryClass.AutonomousAgent)) {
                revert InvalidClaim();
            }
            expectedClaims += recipient.claimCount;
        }
        if (expectedClaims != claims.length) revert ClaimRangeMismatch();
        for (uint256 i = 0; i < claims.length; ++i) {
            if (claims[i].claimId == bytes32(0) || claims[i].recordPointsAtomic == 0) revert InvalidClaim();
        }
    }

    /**
     * @dev Mirrors the stateless half of `ProvianPVT9._validateGenesisInputs`.
     *
     * The per-wallet ceiling and the anchor-reuse check are kernel state the oracle cannot
     * read. The `qualifiedAt` window is deliberately NOT mirrored either: the kernel tests
     * it against `block.timestamp` at SETTLEMENT, which is strictly later than approval, so
     * enforcing it here could reject a batch the kernel would accept. Over-restriction is
     * the one failure mode this contract must not introduce.
     */
    function _validateGenesisShape(
        ProvianPVT9.GenesisRecipient[] calldata recipients,
        ProvianPVT9.GenesisPEClaim[] calldata claims
    ) private view {
        uint256 expectedClaims;
        address previous;
        for (uint256 i = 0; i < recipients.length; ++i) {
            ProvianPVT9.GenesisRecipient calldata recipient = recipients[i];
            if (recipient.contributor <= previous) revert RecipientsNotStrictlyOrdered();
            previous = recipient.contributor;
            if (recipient.claimCount == 0 || expectedClaims + recipient.claimCount > claims.length) {
                revert ClaimRangeMismatch();
            }
            expectedClaims += recipient.claimCount;
        }
        if (expectedClaims != claims.length) revert ClaimRangeMismatch();

        // Read the three fixed grant maxima from the kernel once rather than mirroring the
        // constants, so an over-grant is refused without introducing a second copy of them.
        uint256[3] memory grantMaximum = [
            KERNEL.genesisGrantMaximum(0),
            KERNEL.genesisGrantMaximum(1),
            KERNEL.genesisGrantMaximum(MAX_GENESIS_GRANT_TYPE)
        ];

        for (uint256 i = 0; i < claims.length; ++i) {
            ProvianPVT9.GenesisPEClaim calldata claim = claims[i];
            if (claim.claimId == bytes32(0) || claim.oneTimeAnchor == bytes32(0)) revert InvalidClaim();
            if (claim.walletId == bytes32(0) || claim.reservedGrossAtomic == 0) revert InvalidClaim();
            if (claim.grantType > MAX_GENESIS_GRANT_TYPE) revert InvalidGenesisGrant();
            if (claim.reservedGrossAtomic > grantMaximum[claim.grantType]) revert InvalidGenesisGrant();
        }
    }
}
