// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {IPVTBurnable} from "./interfaces/IPVTBurnable.sol";
import {IEpochClock} from "./interfaces/IEpochClock.sol";

/**
 * @title ProvianPoolV3
 * @notice Collective funding pools v3 - supports PVT as a first-class principal
 *         currency alongside USDC. Each pool is denominated in exactly one
 *         currency at creation; all contributions to that pool MUST be in that
 *         currency. USDC flows match V2 bit-for-bit. PVT-principal flows settle
 *         entirely in PVT with the fee burned via burn() at executePool.
 *
 * @dev Currency convention:
 *      - Currency.USDC: threshold/fee/contributions in USDC's 6 decimals.
 *      - Currency.PVT:  threshold/fee/contributions in PVT's 18 decimals.
 *      Off-chain consumers MUST read `currency(poolId)` before interpreting
 *      raw amount values.
 *
 * @dev Constitutional Note: This is a reference implementation. It is not
 *      canonical. Human-resolving and Genesis mints use the immutable 99% contributor /
 *      0.5% Provian / 0.5% Foundation treatment. Agent-side mints without a verified
 *      human beneficiary use the applicable prospective Foundation rate and contributor
 *      residual. On live Base Pass-3 the admin is Frank's EOA; no transferAdmin or authority
 *      handoff is authorized without separate explicit approval.
 */
contract ProvianPoolV3 {

    /// @notice Contract version string. Off-chain consumers can dispatch on this.
    string public constant VERSION = "v3";

    /**
     * @notice Currency discriminator. Set at creation, immutable thereafter.
     *         ABI representation is uint8: 0 = USDC, 1 = PVT.
     */
    enum Currency {
        USDC,   // 0 - 6 decimals, contributions in USDC, fee to feeWallet (or burned at 50% discount in PVT)
        PVT     // 1 - 18 decimals, contributions in PVT, fee always burned in PVT (no discount)
    }

    enum Status {
        Open,       // 0
        Funded,     // 1
        Executed,   // 2
        Refunded,   // 3
        Cancelled   // 4
    }

    /**
     * @notice Pool record. Currency is fixed at creation.
     * @dev `threshold`, `totalContributed`, and `fee` decimals depend on `currency`:
     *      - USDC: 6 decimals
     *      - PVT:  18 decimals
     */
    struct PoolInfo {
        address creator;
        address target;
        uint256 threshold;
        uint256 totalContributed;
        uint256 fee;                // threshold * 5 / 1000 (0.5%) unless a WP5 fee override is active
        uint256 deadline;
        Status status;
        Currency currency;
    }

    /**
     * @notice A prospectively-scheduled cost value. `exists` distinguishes
     *         "an override was scheduled" from "unset"; because the scheduled
     *         value may legitimately be 0 (e.g. a 0-bps fee is inside the
     *         pool.pvt_execution_fee 0–1000 band), a bare `value == 0` cannot
     *         mean "unset". Mirrors ProvianPVT9's `ScheduledUint256` shape.
     */
    struct ScheduledUint256 {
        bool exists;
        uint256 value;
    }

    // =========================================================================
    // State
    // =========================================================================

    mapping(bytes32 => PoolInfo) public pools;
    mapping(bytes32 => mapping(address => uint256)) public contributions;
    mapping(bytes32 => address[]) public contributorList;

    /**
     * @notice Pass-3 (audit #5) — pull-payment fallback ledger.
     *
     *         Before this fix, refundPool and the executePool excess-refund loop
     *         iterated EVERY contributor and did `if (!ok) revert TransferFailed()`.
     *         A single blacklisted/reverting USDC contributor (Circle USDC REVERTS
     *         to a blacklisted recipient — it does not return false) aborted the
     *         whole loop, permanently freezing ALL honest contributors' funds with
     *         no admin-drain to rescue them.
     *
     *         Fix: each per-contributor payout is now push-with-pull-fallback via
     *         _payOrCredit. A payout that reverts (or returns false) is caught and
     *         credited here instead of reverting the batch, so a reverting recipient
     *         is isolated to itself. That contributor (once un-blacklisted, or via
     *         a different-timing pull) recovers their own funds with claimPendingRefund;
     *         everyone else is paid in the same tx exactly as before.
     */
    mapping(bytes32 => mapping(address => uint256)) public pendingRefunds;

    address public admin;
    address public feeWallet;
    IERC20 public usdc;
    IPVTBurnable public pvt;
    // =========================================================================
    // WP13 — `pvtUsdcRate` / `setPVTRate` / the 50%-PVT-fee discount branch: RETIRED.
    //
    // Two independent reasons, either sufficient. (1) It ORIGINATED A PRICE: a
    // Provian-set PVT/USDC rate used to size a fee, and Provian originates no price.
    // (2) It was a LIVE SILENT-FALLBACK BUG: gated on `payFeeInPVT && pvtUsdcRate > 0`
    // with the rate reading 0 on every live deployment, so `payFeeInPVT = true` fell
    // through to the USDC branch with no revert, no event and no burn — the caller's
    // instruction was discarded silently. Proven by the D-062 pre-change control.
    //
    // A PVT-denominated PROPORTIONAL fee is NOT re-implemented: USDC is 6-dp and PVT
    // 18-dp, so charging bps-of-principal in PVT needs a x1e12 normalisation that
    // hardcodes a 1 PVT : 1 USDC peg authored by Provian — a stronger originated-price
    // problem than an oracle read, not a weaker one. The fee therefore stays in the
    // SETTLEMENT currency at this contract's existing literal (threshold * 5 / 1000):
    // unchanged user cost, no originated valuation. The `IPVTBurnable` binding and the
    // PVT-principal burn path stay intact and reachable so the lever can be enabled
    // later — via an ORACLE READ, once a genuine third-party DEX exists — without a
    // redeploy. Strictly authority-removing.
    // =========================================================================

    /**
     * @notice Phase 2.22 (audit H-74/H-75/H-76): hard cap on contributorList length.
     *
     *         Without a cap, an attacker could push thousands of distinct
     *         addresses into a pool with 1-wei contributions, then trigger
     *         executePool / refundPool - both functions iterate the list to
     *         settle pro-rata shares, and the L2 block gas limit would cause
     *         the loop to run out of gas, freezing the pool's funds permanently.
     *
     *         The cap also de-duplicates: a contributor that already exists in
     *         the list does not push again (existing behaviour) so the cap counts
     *         unique contributors.
     */
    uint256 public constant MAX_CONTRIBUTORS_PER_POOL = 200;

    /// @notice Immutable epoch clock — the ProvianPVT9 kernel on live Base. Read via
    ///         `currentEpoch()` to time prospective cost-parameter schedules (see
    ///         IEpochClock). Bound once at construction: no setter, so binding the
    ///         clock introduces no new settable-address authority.
    IEpochClock public immutable epochClock;

    // =========================================================================
    // WP5 — Pool-native cost parameters (conversion-free, PVT-native)
    //
    // On-chain home for the four `pool.*` rows of the approved PVT cost catalog.
    // Each parameter has its own bounded, admin-only (Frank's EOA on live Base),
    // prospective-epoch scheduler on the SAME kernel-clock-bound machinery merged
    // for Escrow/Promise (ScheduledUint256 + _requireScheduleEpoch +
    // PolicyAlreadyScheduled + forward-fill _resolveActive). Immutable min/max
    // bands mirror the frozen proposal catalog so even the admin cannot schedule a
    // value the reviewed catalog does not permit.
    //
    // FAIL-CLOSED AT ZERO. Every parameter defaults to inert:
    //   - execution fee carries a live historical literal, so "inert" means "no
    //     override active → the 0.5% (50 bps) literal stands", byte-for-byte;
    //   - maximum_contributors overrides the live MAX_CONTRIBUTORS_PER_POOL=200
    //     ceiling, so "inert" means "the 200 gate stands";
    //   - threshold cap / maximum deadline have no historical on-chain gate, so
    //     "inert" means "no gate", exactly current-master behavior (the backend
    //     bounded them).
    // With every parameter unset (the shipped state), createPool / contribute
    // behave identically to the pre-WP5 contract. No economic value is set here; a
    // value is Frank's separate approval.
    //
    // The activation clock is ProvianPVT9.currentEpoch() via `epochClock`, resolved
    // lazily at read time — no local counter, no permissionless epoch-advance, so a
    // queued schedule ladder cannot be collapsed in a single block. Epoch 0 (and any
    // pre-arming state where currentEpoch() reverts) leaves every override inert.
    // =========================================================================

    // --- pool.pvt_execution_fee — basis points of executed principal, 0–1000 ---
    /// @notice Immutable upper band for the execution-fee rate (bps). The lower
    ///         band is 0 (a zero fee is permitted), so only the ceiling is gated.
    uint256 public constant FEE_BPS_MAX = 1_000;
    mapping(uint64 => ScheduledUint256) public scheduledFeeBps;
    /// @notice Epochs at which a fee override was scheduled (append-only, admin-only
    ///         growth). Scanned by activeFeeBps() to forward-fill the value effective
    ///         at the kernel's currentEpoch(). Empty → the historical 0.5% (50 bps)
    ///         literal in createPool stands, unchanged.
    uint64[] public feeBpsEpochs;

    // --- pool.pvt_threshold_cap — max PVT threshold, 1e18–1e24 atomic units ---
    /// @notice Immutable band for the PVT-threshold cap: floor 1 PVT, ceiling
    ///         1,000,000 PVT (18-dp atomic units). Denominated in PVT, so the cap
    ///         gates PVT-principal pools only.
    uint256 public constant THRESHOLD_CAP_MIN = 1e18;
    uint256 public constant THRESHOLD_CAP_MAX = 1_000_000e18;
    mapping(uint64 => ScheduledUint256) public scheduledThresholdCap;
    /// @notice Epochs at which a PVT-threshold-cap override was scheduled. Empty → no
    ///         cap is enforced on-chain (pre-WP5 behavior — the backend capped it).
    uint64[] public thresholdCapEpochs;

    // --- pool.maximum_deadline — seconds, 1h–180d ---
    /// @notice Immutable band for the maximum funding-deadline window: floor 1 hour,
    ///         ceiling 180 days. Bounds `deadline - block.timestamp` at createPool.
    uint256 public constant MAXIMUM_DEADLINE_MIN = 1 hours;   // 3600
    uint256 public constant MAXIMUM_DEADLINE_MAX = 180 days;  // 15,552,000
    mapping(uint64 => ScheduledUint256) public scheduledMaximumDeadline;
    /// @notice Epochs at which a max-deadline override was scheduled. Empty → no
    ///         on-chain bound (pre-WP5: any future timestamp was accepted).
    uint64[] public maximumDeadlineEpochs;

    // --- pool.maximum_contributors — integer limit, 2–200 ---
    /// @notice Immutable band for the per-pool contributor limit: floor 2, ceiling
    ///         the live MAX_CONTRIBUTORS_PER_POOL hard cap (200). An override may
    ///         only tighten within [2, 200]; it can never raise the 200 ceiling.
    uint256 public constant MAX_CONTRIBUTORS_MIN = 2;
    uint256 public constant MAX_CONTRIBUTORS_MAX = 200;
    mapping(uint64 => ScheduledUint256) public scheduledMaxContributors;
    /// @notice Epochs at which a max-contributors override was scheduled. Empty → the
    ///         historical MAX_CONTRIBUTORS_PER_POOL (200) gate in contribute() stands.
    uint64[] public maxContributorsEpochs;

    // =========================================================================
    // Events - Legacy (USDC-principal). Signatures match V2 exactly.
    // =========================================================================

    event PoolCreated(bytes32 indexed poolId, address indexed creator, address indexed target, uint256 threshold, uint256 deadline);
    event PoolContribution(bytes32 indexed poolId, address indexed contributor, uint256 amount, uint256 totalContributed);
    event PoolExecuted(bytes32 indexed poolId, address indexed target, uint256 netAmount, uint256 fee);
    event PoolRefunded(bytes32 indexed poolId, uint256 contributorCount);
    event PoolWithdrawal(bytes32 indexed poolId, address indexed contributor, uint256 amount);
    // WP13: `FeePaidInPVT` is RETIRED with the discount branch that emitted it.

    // =========================================================================
    // Events - PVT-principal. Distinct event types for indexer ergonomics.
    // =========================================================================

    event PoolCreatedPVT(bytes32 indexed poolId, address indexed creator, address indexed target, uint256 threshold, uint256 deadline);
    event PoolContributionPVT(bytes32 indexed poolId, address indexed contributor, uint256 amount, uint256 totalContributed);
    event PoolExecutedPVT(bytes32 indexed poolId, address indexed target, uint256 netAmount, uint256 feeBurned);
    event PoolRefundedPVT(bytes32 indexed poolId, uint256 contributorCount);
    event PoolWithdrawalPVT(bytes32 indexed poolId, address indexed contributor, uint256 amount);

    // =========================================================================
    // Events - Shared.
    // =========================================================================

    event PoolCancelled(bytes32 indexed poolId);
    // WP13: `PVTRateUpdated` is RETIRED with `setPVTRate`.
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);
    // Pass-3 (#5) pull-payment fallback
    event RefundPending(bytes32 indexed poolId, address indexed contributor, uint256 amount);
    event PendingRefundClaimed(bytes32 indexed poolId, address indexed contributor, uint256 amount);

    // WP5 cost-parameter machinery
    event FeeBpsScheduled(uint64 indexed effectiveEpoch, uint256 bps);
    event ThresholdCapScheduled(uint64 indexed effectiveEpoch, uint256 capAtomic);
    event MaximumDeadlineScheduled(uint64 indexed effectiveEpoch, uint256 deadlineSeconds);
    event MaxContributorsScheduled(uint64 indexed effectiveEpoch, uint256 maxContributors);

    // =========================================================================
    // Errors
    // =========================================================================

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
    /// @notice WP13: raised when a caller asks to pay the fee in PVT. The discount
    ///         branch is retired, so the request is REFUSED LOUDLY rather than
    ///         silently downgraded to a USDC charge, which is what it used to do.
    error PVTFeeDiscountRetired();
    error PVTPrincipalRejectsDiscount();
    error NothingToClaim();
    // WP5 cost-parameter machinery
    error PolicyNotProspective();
    error PolicyAlreadyScheduled();
    error CostOutOfDomain();
    error ThresholdCapExceeded();
    error MaximumDeadlineExceeded();

    // =========================================================================
    // Constructor
    // =========================================================================

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

    // =========================================================================
    // WP5 — Cost-parameter epoch machinery (kernel-clock-bound; WP-CLK)
    //
    // The activation clock is ProvianPVT9.currentEpoch() via `epochClock`. A
    // scheduled value for epoch E is resolved lazily at read time as "the value at
    // the greatest scheduled epoch <= currentEpoch()" (forward-fill). No local
    // counter and no permissionless epoch-advance, so a queued ladder is provably
    // non-collapsible in a single block. Identical in shape to ProvianEscrowV4 /
    // ProvianPromiseV3.
    // =========================================================================

    /// @notice The current activation epoch, from the immutable kernel clock. Fails
    ///         CLOSED: if the kernel is unarmed / has not started, currentEpoch()
    ///         reverts and this returns 0, so every override is inert and the
    ///         historical literal stands.
    function _currentEpoch() internal view returns (uint64) {
        try epochClock.currentEpoch() returns (uint64 e) {
            return e;
        } catch {
            return 0;
        }
    }

    /// @notice The earliest epoch a schedule may target: the epoch after the current
    ///         kernel epoch. A schedule for any epoch <= currentEpoch() is not prospective.
    function earliestSchedulableEpoch() public view returns (uint64) {
        return _currentEpoch() + 1;
    }

    /// @dev Prospectivity guard, reused by every scheduler.
    function _requireScheduleEpoch(uint64 effectiveEpoch) private view {
        if (effectiveEpoch <= _currentEpoch()) revert PolicyNotProspective();
    }

    /// @dev Resolve the active value of a parameter at the current kernel epoch: the
    ///      value scheduled at the greatest epoch <= currentEpoch(), else unset. Scans
    ///      the append-only `epochs` array (admin-only growth). Forward-fill and
    ///      out-of-order scheduling both hold.
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

    /// @notice The execution-fee override active at the current kernel epoch, as
    ///         (exists, value). exists == false → the 0.5% literal stands.
    function activeFeeBps() public view returns (bool exists, uint256 value) {
        ScheduledUint256 memory a = _resolveActive(scheduledFeeBps, feeBpsEpochs);
        return (a.exists, a.value);
    }

    /// @notice The PVT-threshold cap active at the current kernel epoch, as
    ///         (exists, value). exists == false → no on-chain cap.
    function activeThresholdCap() public view returns (bool exists, uint256 value) {
        ScheduledUint256 memory a = _resolveActive(scheduledThresholdCap, thresholdCapEpochs);
        return (a.exists, a.value);
    }

    /// @notice The maximum funding-deadline window active at the current kernel epoch,
    ///         as (exists, value). exists == false → no on-chain bound.
    function activeMaximumDeadline() public view returns (bool exists, uint256 value) {
        ScheduledUint256 memory a = _resolveActive(scheduledMaximumDeadline, maximumDeadlineEpochs);
        return (a.exists, a.value);
    }

    /// @notice The per-pool contributor limit active at the current kernel epoch, as
    ///         (exists, value). exists == false → the MAX_CONTRIBUTORS_PER_POOL (200)
    ///         ceiling stands.
    function activeMaxContributors() public view returns (bool exists, uint256 value) {
        ScheduledUint256 memory a = _resolveActive(scheduledMaxContributors, maxContributorsEpochs);
        return (a.exists, a.value);
    }

    /// @notice Schedule the execution-fee rate (bps of executed principal) to take
    ///         effect when `effectiveEpoch` opens. Admin-only (Frank's EOA on live
    ///         Base), bounded to the immutable 0–1000 bps band, prospective, one
    ///         value per epoch. Until an override is scheduled AND its epoch opens,
    ///         the historical 0.5% literal stands (see createPool).
    function scheduleFeeBps(uint64 effectiveEpoch, uint256 bps) external onlyAdmin {
        _requireScheduleEpoch(effectiveEpoch);
        if (bps > FEE_BPS_MAX) revert CostOutOfDomain(); // lower band is 0
        if (scheduledFeeBps[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledFeeBps[effectiveEpoch] = ScheduledUint256({exists: true, value: bps});
        feeBpsEpochs.push(effectiveEpoch);
        emit FeeBpsScheduled(effectiveEpoch, bps);
    }

    /// @notice Schedule the maximum PVT threshold accepted into a PVT-principal pool,
    ///         to take effect when `effectiveEpoch` opens. Admin-only, bounded to the
    ///         immutable [1 PVT, 1,000,000 PVT] band, prospective, one value per epoch.
    ///         Until scheduled AND active, no on-chain threshold cap is enforced.
    function scheduleThresholdCap(uint64 effectiveEpoch, uint256 capAtomic) external onlyAdmin {
        _requireScheduleEpoch(effectiveEpoch);
        if (capAtomic < THRESHOLD_CAP_MIN || capAtomic > THRESHOLD_CAP_MAX) revert CostOutOfDomain();
        if (scheduledThresholdCap[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledThresholdCap[effectiveEpoch] = ScheduledUint256({exists: true, value: capAtomic});
        thresholdCapEpochs.push(effectiveEpoch);
        emit ThresholdCapScheduled(effectiveEpoch, capAtomic);
    }

    /// @notice Schedule the maximum funding-deadline window (seconds) — the longest
    ///         allowed `deadline - creation` — to take effect when `effectiveEpoch`
    ///         opens. Admin-only, bounded to the immutable [1 hour, 180 days] band,
    ///         prospective, one value per epoch. Unset → no on-chain bound.
    function scheduleMaximumDeadline(uint64 effectiveEpoch, uint256 deadlineSeconds) external onlyAdmin {
        _requireScheduleEpoch(effectiveEpoch);
        if (deadlineSeconds < MAXIMUM_DEADLINE_MIN || deadlineSeconds > MAXIMUM_DEADLINE_MAX) revert CostOutOfDomain();
        if (scheduledMaximumDeadline[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledMaximumDeadline[effectiveEpoch] = ScheduledUint256({exists: true, value: deadlineSeconds});
        maximumDeadlineEpochs.push(effectiveEpoch);
        emit MaximumDeadlineScheduled(effectiveEpoch, deadlineSeconds);
    }

    /// @notice Schedule the per-pool contributor limit to take effect when
    ///         `effectiveEpoch` opens. Admin-only, bounded to the immutable [2, 200]
    ///         band (never above the MAX_CONTRIBUTORS_PER_POOL hard cap), prospective,
    ///         one value per epoch. Unset → the 200 ceiling stands.
    function scheduleMaxContributors(uint64 effectiveEpoch, uint256 maxContributors) external onlyAdmin {
        _requireScheduleEpoch(effectiveEpoch);
        if (maxContributors < MAX_CONTRIBUTORS_MIN || maxContributors > MAX_CONTRIBUTORS_MAX) revert CostOutOfDomain();
        if (scheduledMaxContributors[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledMaxContributors[effectiveEpoch] = ScheduledUint256({exists: true, value: maxContributors});
        maxContributorsEpochs.push(effectiveEpoch);
        emit MaxContributorsScheduled(effectiveEpoch, maxContributors);
    }

    // WP13: `setPVTRate` is RETIRED — see the retirement block in State.

    /// @notice Legacy admin-transfer capability; no use is authorized without
    ///         separate explicit approval.
    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert InvalidAddress();
        address oldAdmin = admin;
        admin = newAdmin;
        emit AdminTransferred(oldAdmin, newAdmin);
    }

    // =========================================================================
    // Pool Functions
    // =========================================================================

    /**
     * @notice Create a pool. Currency is fixed at creation.
     * @param poolId Unique identifier.
     * @param target Address that receives funds when pool executes.
     * @param threshold Target amount in the chosen currency's native decimals.
     * @param deadline Unix timestamp after which an open or unexecuted funded pool can be refunded.
     * @param currencyType Currency.USDC for legacy USDC pools;
     *                     Currency.PVT for PVT-principal pools (fee burned, no discount).
     */
    function createPool(
        bytes32 poolId,
        address target,
        uint256 threshold,
        uint256 deadline,
        Currency currencyType
    ) external {
        if (target == address(0)) revert InvalidAddress();
        if (threshold == 0) revert InvalidAmount();
        // WP5 pool.pvt_threshold_cap — gates PVT-principal pools only (the cap is
        // PVT-denominated). Unset (the shipped default) → no on-chain cap, matching
        // pre-WP5 (the backend capped the threshold, not this contract).
        (bool capExists, uint256 capValue) = activeThresholdCap();
        if (currencyType == Currency.PVT && capExists && threshold > capValue) {
            revert ThresholdCapExceeded();
        }
        if (deadline <= block.timestamp) revert InvalidDeadline();
        // WP5 pool.maximum_deadline — bounds the funding window (deadline - now).
        // `fundingWindow` cannot underflow: the check above guarantees deadline >
        // block.timestamp. Unset (shipped) → unbounded, matching pre-WP5 (any future
        // timestamp accepted; the backend bounded it).
        uint256 fundingWindow = deadline - block.timestamp;
        (bool maxDeadlineExists, uint256 maxDeadlineValue) = activeMaximumDeadline();
        if (maxDeadlineExists && fundingWindow > maxDeadlineValue) {
            revert MaximumDeadlineExceeded();
        }
        if (pools[poolId].creator != address(0)) revert PoolAlreadyExists();

        // Fee, denominated in the same currency as the threshold. Unset (the shipped
        // default) preserves the historical 0.5% (50 bps) literal byte-for-byte; once
        // an override is scheduled and its epoch opens it replaces the rate within the
        // immutable 0–1000 bps band.
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

    /**
     * @notice Contribute to an open pool in its denominated currency.
     */
    function contribute(bytes32 poolId, uint256 amount) external {
        PoolInfo storage p = pools[poolId];
        // Security pass 2026-10-02 (S1-A): a pool nobody created reads as an Open,
        // zero-threshold USDC pool, so a contribution to it used to be recorded and
        // survive the later `createPool` overwrite (`createPool` only refuses when
        // `creator != 0`). The surviving phantom `contributions` entry let its owner
        // withdraw against a `totalContributed` that never counted it, stranding
        // that much of the honest contributors' money in this contract at execute.
        // A contribution exists only for a pool that exists.
        if (p.creator == address(0)) revert PoolNotFound();
        if (p.status != Status.Open) {
            revert InvalidStatus(Status.Open, p.status);
        }
        if (amount == 0) revert InvalidAmount();

        if (contributions[poolId][msg.sender] == 0) {
            // WP5 pool.maximum_contributors — override-else-default. Unset (shipped)
            // keeps the MAX_CONTRIBUTORS_PER_POOL (200) hard cap byte-for-byte; a
            // scheduled, epoch-activated override tightens it within [2, 200] (it can
            // never exceed the 200 ceiling — the scheduler's immutable band enforces that).
            (bool maxExists, uint256 maxValue) = activeMaxContributors();
            uint256 contributorLimit = maxExists ? maxValue : MAX_CONTRIBUTORS_PER_POOL;
            require(
                contributorList[poolId].length < contributorLimit,
                "ProvianPoolV3: contributor cap reached"
            );
            contributorList[poolId].push(msg.sender);
        }

        contributions[poolId][msg.sender] += amount;
        p.totalContributed += amount;

        if (p.currency == Currency.PVT) {
            bool ok = pvt.transferFrom(msg.sender, address(this), amount);
            if (!ok) revert TransferFailed();
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

    /**
     * @notice Execute a funded pool - pay the target, settle the fee, refund
     *         excess contributions pro-rata.
     *
     *         USDC-principal:
     *           - payFeeInPVT == false: standard. target receives (threshold - fee) USDC,
     *             fee USDC sent to feeWallet.
     *           - payFeeInPVT == true:  legacy 50%-discount. Creator/admin pays
     *             discounted PVT fee from their own balance (burned), target
     *             receives the full threshold in USDC.
     *
     *         PVT-principal:
     *           - payFeeInPVT MUST be false. Fee is intrinsically PVT and burned
     *             from the pooled balance. Target receives (threshold - fee) PVT.
     *             Fee comes proportionally from contributors (matches the
     *             standard USDC path's economic incidence).
     */
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

            // Fee burned from pooled PVT.
            netAmount = p.threshold - p.fee;
            pvt.burn(p.fee);

            bool ok = pvt.transfer(p.target, netAmount);
            if (!ok) revert TransferFailed();

            emittedFee = p.fee;
            // Refund excess pro-rata in PVT (handled below in shared block).
        } else {
            // USDC-principal. WP13: the PVT-fee discount branch is RETIRED, so a
            // caller asking for it gets a LOUD refusal instead of the old silent
            // fallback that charged them in USDC without saying so.
            if (payFeeInPVT) revert PVTFeeDiscountRetired();

            netAmount = p.threshold - p.fee;
            bool feeOk = usdc.transfer(feeWallet, p.fee);
            if (!feeOk) revert TransferFailed();
            emittedFee = p.fee;

            bool ok = usdc.transfer(p.target, netAmount);
            if (!ok) revert TransferFailed();
        }

        // Return excess contributions pro-rata.
        // [Finding-38] Last contributor receives any remaining dust to prevent
        // rounding residue from being stranded in the contract.
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
                // Pass-3 (#5): push-with-pull-fallback so one reverting/blacklisted
                // contributor can't revert the whole excess-refund loop.
                _payOrCredit(poolId, p.currency, contribs[i], refund);
            }
        }

        if (p.currency == Currency.PVT) {
            emit PoolExecutedPVT(poolId, p.target, netAmount, emittedFee);
        } else {
            emit PoolExecuted(poolId, p.target, netAmount, emittedFee);
        }
    }

    /**
     * @notice Refund all contributors. Admin can refund Open or Funded pools at
     *         any time. Anyone can refund an Open OR Funded pool past its deadline.
     *         Returns funds in the pool's denominated currency.
     * @dev Shutdown coverage (2026-10-20): a Funded pool used to leave only via the
     *      creator's `executePool` or the admin's refund, so a creator who never
     *      executed stranded every contributor behind a Provian-held key. Past the
     *      pool's own deadline anyone may now return every contribution. No new
     *      number: the gate is the creator-chosen `deadline` that already bounds the
     *      Open refund. The creator keeps `executePool` until the first refund lands;
     *      either outcome pays only the parties (target or contributors).
     */
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
                // Pass-3 (#5): push-with-pull-fallback so one reverting/blacklisted
                // contributor can't revert the whole refund loop and freeze the pool.
                _payOrCredit(poolId, p.currency, contribs[i], contributed);
            }
        }

        if (p.currency == Currency.PVT) {
            emit PoolRefundedPVT(poolId, contribs.length);
        } else {
            emit PoolRefunded(poolId, contribs.length);
        }
    }

    /**
     * @dev Pass-3 (#5): push `amount` of the pool currency to `to`; if the
     *      transfer reverts (blacklisted recipient — Circle USDC reverts, it does
     *      not return false) OR returns false, credit it to the pull ledger instead
     *      of reverting the batch. The happy path is unchanged: a normal contributor
     *      is paid in the same tx and nothing is credited.
     */
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
        }
    }

    /**
     * @notice Pull a contribution/excess refund that could not be pushed because
     *         the recipient reverted at settlement time (Pass-3 #5). Isolates a
     *         reverting contributor so it can never freeze the whole pool.
     */
    function claimPendingRefund(bytes32 poolId) external {
        uint256 amount = pendingRefunds[poolId][msg.sender];
        if (amount == 0) revert NothingToClaim();
        pendingRefunds[poolId][msg.sender] = 0; // effects before interaction

        PoolInfo storage p = pools[poolId];
        bool ok = (p.currency == Currency.PVT)
            ? pvt.transfer(msg.sender, amount)
            : usdc.transfer(msg.sender, amount);
        if (!ok) revert TransferFailed();
        emit PendingRefundClaimed(poolId, msg.sender, amount);
    }

    /**
     * @notice Contributor withdraws their contribution while the pool is Open.
     */
    function withdrawContribution(bytes32 poolId) external {
        PoolInfo storage p = pools[poolId];
        if (p.status != Status.Open) {
            revert InvalidStatus(Status.Open, p.status);
        }

        uint256 amount = contributions[poolId][msg.sender];
        if (amount == 0) revert NoContribution();

        contributions[poolId][msg.sender] = 0;
        p.totalContributed -= amount;
        // SECURITY (audit WS5): remove the contributor from the list on full
        // withdrawal. Without this, contribute -> withdraw -> contribute pushed
        // the same address TWICE (the contribute de-dup only checks balance==0,
        // which is true right after a withdrawal), so refundPool / executePool
        // would later pay that balance twice — a cross-pool fund drain.
        _removeContributor(poolId, msg.sender);

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

    /**
     * @dev Remove a contributor from the pool's list (swap-and-pop). Bounded by
     *      MAX_CONTRIBUTORS_PER_POOL. Called on full withdrawal so the same
     *      address cannot appear twice in contributorList.
     */
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

    // =========================================================================
    // Views
    // =========================================================================

    /**
     * @notice Currency of a pool. Returns 0 for USDC, 1 for PVT.
     */
    function currency(bytes32 poolId) external view returns (Currency) {
        PoolInfo storage p = pools[poolId];
        if (p.creator == address(0)) revert PoolNotFound();
        return p.currency;
    }

    /**
     * @notice Contract version. Returns "v3".
     */
    function version() external pure returns (string memory) {
        return VERSION;
    }
}
