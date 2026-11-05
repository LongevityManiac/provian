// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {IPVTBurnable} from "./interfaces/IPVTBurnable.sol";
import {IEpochClock} from "./interfaces/IEpochClock.sol";

/**
 * @title ProvianPromiseV3
 * @notice On-chain reputation-backed IOUs v3 - supports PVT as a first-class
 *         principal currency alongside USDC. Each promise is denominated in
 *         exactly one currency at creation, immutable for its lifetime.
 *         USDC flows match V2 bit-for-bit. PVT-principal flows settle entirely
 *         in PVT with the fee burned via burn().
 *
 * @dev Currency convention:
 *      - Currency.USDC: principal/repayAmount/fee in USDC's 6 decimals.
 *      - Currency.PVT:  principal/repayAmount/fee in PVT's 18 decimals.
 *      Off-chain consumers MUST read `currency(promiseId)` before interpreting
 *      raw amount values.
 *
 * @dev Constitutional Note: This is a reference implementation. It is not
 *      canonical. Human-resolving and Genesis mints use the immutable 99% contributor /
 *      0.5% Provian / 0.5% Foundation treatment. Agent-side mints without a verified
 *      human beneficiary use the applicable prospective Foundation rate and contributor
 *      residual. On live Base the admin is Frank's EOA; no transferAdmin or authority
 *      handoff is authorized without separate explicit approval.
 */
contract ProvianPromiseV3 {

    /// @notice Contract version string. Off-chain consumers can dispatch on this.
    string public constant VERSION = "v3";

    /**
     * @notice Currency discriminator. Set at creation, immutable thereafter.
     *         ABI representation is uint8: 0 = USDC, 1 = PVT.
     */
    enum Currency {
        USDC,   // 0 - 6 decimals, principal in USDC, fee to feeWallet (or burned at 50% discount in PVT)
        PVT     // 1 - 18 decimals, principal in PVT, fee always burned in PVT (no discount)
    }

    enum Status {
        Open,       // 0
        Funded,     // 1
        Settled,    // 2
        Defaulted,  // 3
        Cancelled   // 4
    }

    /**
     * @notice Promise record. Currency is fixed at creation.
     * @dev `principal`, `repayAmount`, and `fee` decimals depend on `currency`:
     *      - USDC: 6 decimals
     *      - PVT:  18 decimals
     *      `feePaidInPVT` is meaningful only for USDC-principal promises.
     *      For PVT-principal promises it is always false (the fee is
     *      intrinsically burned in PVT - no separate discount path).
     */
    struct Promise {
        address borrower;
        address lender;
        uint256 principal;
        uint256 repayAmount;
        uint256 fee;            // gross fee snapshot: unset -> (repayAmount*25)/10000 (0.25%); WP5-overridable
        uint256 deadline;
        Status status;
        Currency currency;
        bool feePaidInPVT;
    }

    /**
     * @notice A prospectively-scheduled cost value. `exists` distinguishes "an
     *         override was scheduled" from "unset"; because a scheduled value may
     *         legitimately be 0 (a 0-bps settlement fee is inside the
     *         promise.pvt_settlement_fee 0–1000 band, and a 0-second grace period
     *         is inside the promise.default_grace_period 0-floor band), a bare
     *         `value == 0` cannot mean "unset". Mirrors ProvianPVT9's
     *         `ScheduledUint256` shape (kernel untouched).
     */
    struct ScheduledUint256 {
        bool exists;
        uint256 value;
    }

    // =========================================================================
    // State
    // =========================================================================

    mapping(bytes32 => Promise) public promises;
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
    // SETTLEMENT currency at this contract's existing literal (repayAmount * 25 /
    // 10000): unchanged user cost, no originated valuation. The `IPVTBurnable` binding
    // and the PVT-principal burn path stay intact and reachable so the lever can be
    // enabled later — via an ORACLE READ, once a genuine third-party DEX exists —
    // without a redeploy. Strictly authority-removing.
    // =========================================================================
    address public admin;

    /// @notice Immutable epoch clock — the ProvianPVT9 kernel on live Base. Read via
    ///         `currentEpoch()` to time prospective cost-parameter schedules (see
    ///         IEpochClock). Bound once at construction: no setter, so binding the
    ///         clock introduces no new settable-address authority.
    IEpochClock public immutable epochClock;

    /**
     * @notice Phase 2.22 (audit): markDefault has a 24-hour grace window after
     *         the deadline where ONLY the borrower or lender can call it. After
     *         the grace period anyone can mark default. This stops front-runners
     *         from racing to default a promise the borrower was actively trying
     *         to settle. Currency-agnostic.
     */
    uint256 public constant DEFAULT_GRACE_PERIOD = 24 hours;

    // =========================================================================
    // WP5 — Promise-native cost parameters (conversion-free, PVT-native)
    //
    // On-chain home for the four Promise-rooted rows of the PVT cost catalog. Each
    // parameter has its own bounded, admin-only (Frank's EOA on live Base),
    // prospective-epoch scheduler; scheduled values apply only when their epoch
    // opens, mirroring the ProvianPVT9 kernel's schedule/apply/prospectivity shape
    // (ScheduledUint256 + _requireScheduleEpoch + PolicyAlreadyScheduled +
    // apply-on-open). Immutable min/max bands are compiled in below so even the
    // admin cannot schedule a value the reviewed catalog does not permit.
    //
    // FAIL-CLOSED TO EXISTING BEHAVIOR, NOT ZERO. Every parameter defaults to inert:
    //   - settlement fee / default-grace carry a live literal, so "inert" means "no
    //     override active -> the existing literal stands", holding the baseline
    //     byte-for-byte;
    //   - principal cap / maximum deadline have no historical on-chain gate, so
    //     "inert" means "no gate", which is exactly the current-master behavior.
    // With every parameter unset (the shipped state), createPromise / markDefault
    // behave identically to the pre-WP5 contract. No economic value is set here; a
    // value is Frank's separate approval.
    // =========================================================================

    // The activation clock is the immutable ProvianPVT9 kernel epoch (see
    // `epochClock` / IEpochClock). A schedule for epoch E activates exactly when the
    // kernel's currentEpoch() reaches E, resolved lazily at read time — there is no
    // local counter and no permissionless "open epoch" call, so a queued ladder
    // cannot be collapsed in a single block. Epoch 0 (and any pre-arming state where
    // currentEpoch() reverts) leaves every override inert → the historical literal stands.

    // --- promise.pvt_settlement_fee — basis points of gross repayment, 0–1000 ---
    /// @notice Immutable upper band for the settlement-fee rate (bps). The lower
    ///         band is 0 (a zero fee is permitted), so only the ceiling is gated.
    uint256 public constant SETTLEMENT_FEE_BPS_MAX = 1_000;
    mapping(uint64 => ScheduledUint256) public scheduledSettlementFeeBps;
    /// @notice Epochs at which a settlement-fee override was scheduled (append-only,
    ///         admin-only growth). Scanned by activeSettlementFeeBps() to forward-fill
    ///         the value effective at the kernel's currentEpoch(). Empty → the
    ///         historical 0.25% (25 bps) literal in createPromise stands, unchanged.
    uint64[] public settlementFeeBpsEpochs;

    // --- promise.pvt_principal_cap — max PVT principal, 1e18–1e24 atomic units ---
    /// @notice Immutable band for the PVT-principal cap: floor 1 PVT, ceiling
    ///         1,000,000 PVT (18-dp atomic units). Denominated in PVT, so the cap
    ///         gates PVT-principal promises only.
    uint256 public constant PRINCIPAL_CAP_MIN = 1e18;
    uint256 public constant PRINCIPAL_CAP_MAX = 1_000_000e18;
    mapping(uint64 => ScheduledUint256) public scheduledPrincipalCap;
    /// @notice Epochs at which a PVT-principal-cap override was scheduled. Empty → no
    ///         cap is enforced on-chain (pre-WP5 behavior — the backend caps principal).
    uint64[] public principalCapEpochs;

    // --- promise.maximum_deadline — max (deadline - creation) window, 1h–90d ---
    /// @notice Immutable band for the maximum deadline window (seconds): floor
    ///         1 hour, ceiling 90 days. Bounds `deadline - block.timestamp` at
    ///         creation. Currency-agnostic (it bounds the promise timeline).
    uint256 public constant MAXIMUM_DEADLINE_MIN = 1 hours; // 3600
    uint256 public constant MAXIMUM_DEADLINE_MAX = 90 days; // 7,776,000
    mapping(uint64 => ScheduledUint256) public scheduledMaximumDeadline;
    /// @notice Epochs at which a maximum-deadline override was scheduled. Empty → no
    ///         on-chain bound (pre-WP5: the contract accepts any future timestamp).
    uint64[] public maximumDeadlineEpochs;

    // --- promise.default_grace_period — markDefault grace window, 0–30d ---
    /// @notice Immutable upper band for the default grace period (seconds): ceiling
    ///         30 days. The lower band is 0 (a zero grace window is permitted — anyone
    ///         may mark default immediately at the deadline), so only the ceiling is
    ///         gated. Overrides the live `DEFAULT_GRACE_PERIOD` (24 h) constant.
    uint256 public constant DEFAULT_GRACE_PERIOD_MAX = 30 days; // 2,592,000
    mapping(uint64 => ScheduledUint256) public scheduledDefaultGracePeriod;
    /// @notice Epochs at which a default-grace override was scheduled. Empty → the
    ///         historical `DEFAULT_GRACE_PERIOD` (24 h) constant is used in markDefault.
    uint64[] public defaultGracePeriodEpochs;

    // =========================================================================
    // Events - Legacy (USDC-principal). Signatures match V2 exactly.
    // =========================================================================

    event PromiseCreated(bytes32 indexed promiseId, address indexed borrower, uint256 principal, uint256 repayAmount, uint256 deadline);
    event PromiseFunded(bytes32 indexed promiseId, address indexed lender, uint256 principal);
    event PromiseSettled(bytes32 indexed promiseId, address indexed lender, uint256 netAmount, uint256 fee);
    event PromiseDefaulted(bytes32 indexed promiseId, address indexed borrower, address indexed lender, uint256 principal);
    // WP13: `FeePaidInPVT` is RETIRED with the discount branch that emitted it.

    // =========================================================================
    // Events - PVT-principal. Distinct event types for indexer ergonomics.
    // =========================================================================

    event PromiseCreatedPVT(bytes32 indexed promiseId, address indexed borrower, uint256 principal, uint256 repayAmount, uint256 deadline);
    event PromiseFundedPVT(bytes32 indexed promiseId, address indexed lender, uint256 principal);
    event PromiseSettledPVT(bytes32 indexed promiseId, address indexed lender, uint256 netAmount, uint256 feeBurned);
    event PromiseDefaultedPVT(bytes32 indexed promiseId, address indexed borrower, address indexed lender, uint256 principal);

    // =========================================================================
    // Events - Shared.
    // =========================================================================

    event PromiseCancelled(bytes32 indexed promiseId);
    // WP13: `PVTRateUpdated` is RETIRED with `setPVTRate`.
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);

    // =========================================================================
    // Events - WP5 cost-parameter machinery
    // =========================================================================

    event SettlementFeeBpsScheduled(uint64 indexed effectiveEpoch, uint256 bps);
    event PrincipalCapScheduled(uint64 indexed effectiveEpoch, uint256 capAtomic);
    event MaximumDeadlineScheduled(uint64 indexed effectiveEpoch, uint256 windowSeconds);
    event DefaultGracePeriodScheduled(uint64 indexed effectiveEpoch, uint256 gracePeriodSeconds);

    // =========================================================================
    // Errors
    // =========================================================================

    error InvalidAddress();
    error InvalidAmount();
    error InvalidDeadline();
    error RepayMustExceedPrincipal();
    error PromiseAlreadyExists();
    error PromiseNotFound();
    error OnlyBorrower();
    error OnlyAdmin();
    error InvalidStatus(Status expected, Status actual);
    error DeadlineNotReached();
    error TransferFailed();
    /// @notice WP13: raised when a caller asks to pay the fee in PVT. The discount
    ///         branch is retired, so the request is REFUSED LOUDLY rather than
    ///         silently downgraded to a USDC charge, which is what it used to do.
    error PVTFeeDiscountRetired();
    error PVTPrincipalRejectsDiscount();
    // WP5 cost-parameter machinery
    error PolicyNotProspective();
    error PolicyAlreadyScheduled();
    error CostOutOfDomain();
    error PrincipalCapExceeded();
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
    // WP5 — Cost-parameter epoch machinery (kernel-clock-bound; WP-CLK)
    //
    // The activation clock is ProvianPVT9.currentEpoch() via `epochClock`. A
    // scheduled value for epoch E is resolved lazily at read time as "the value at
    // the greatest scheduled epoch <= currentEpoch()" (forward-fill: a value
    // persists until a later schedule replaces it). There is no local counter and
    // no permissionless epoch-advance, so a queued ladder is provably
    // non-collapsible in a single block — currentEpoch() is fixed within a block
    // and advances only with real time (one epoch per kernel EPOCH_DURATION).
    // =========================================================================

    /// @notice The current activation epoch, from the immutable kernel clock. Fails
    ///         CLOSED: if the kernel is unarmed / has not started, currentEpoch()
    ///         reverts and this returns 0, so every override is inert and the
    ///         historical literal stands (the institution never bricks on an
    ///         unarmed kernel).
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

    /// @dev Prospectivity guard, reused by every scheduler. Reverts if the target
    ///      epoch is the current epoch or earlier, so an active/past epoch's cost
    ///      snapshot can never be re-priced.
    function _requireScheduleEpoch(uint64 effectiveEpoch) private view {
        if (effectiveEpoch <= _currentEpoch()) revert PolicyNotProspective();
    }

    /// @dev Resolve the active value of a parameter at the current kernel epoch: the
    ///      value scheduled at the greatest epoch <= currentEpoch(), else unset. Scans
    ///      the append-only `epochs` array (admin-only growth — no external party can
    ///      enlarge it). Forward-fill and out-of-order scheduling both hold: the scan
    ///      tracks the maximum in-range epoch regardless of push order.
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

    /// @notice The settlement-fee override active at the current kernel epoch, as
    ///         (exists, value). exists == false → the 0.25% literal stands. The
    ///         (bool,uint256) shape matches the pre-WP-CLK public-variable getter.
    function activeSettlementFeeBps() public view returns (bool exists, uint256 value) {
        ScheduledUint256 memory a = _resolveActive(scheduledSettlementFeeBps, settlementFeeBpsEpochs);
        return (a.exists, a.value);
    }

    /// @notice The PVT-principal cap active at the current kernel epoch, as
    ///         (exists, value). exists == false → no on-chain cap.
    function activePrincipalCap() public view returns (bool exists, uint256 value) {
        ScheduledUint256 memory a = _resolveActive(scheduledPrincipalCap, principalCapEpochs);
        return (a.exists, a.value);
    }

    /// @notice The maximum-deadline window active at the current kernel epoch, as
    ///         (exists, value). exists == false → no on-chain bound.
    function activeMaximumDeadline() public view returns (bool exists, uint256 value) {
        ScheduledUint256 memory a = _resolveActive(scheduledMaximumDeadline, maximumDeadlineEpochs);
        return (a.exists, a.value);
    }

    /// @notice The default-grace override active at the current kernel epoch, as
    ///         (exists, value). exists == false → the 24 h constant stands.
    function activeDefaultGracePeriod() public view returns (bool exists, uint256 value) {
        ScheduledUint256 memory a = _resolveActive(scheduledDefaultGracePeriod, defaultGracePeriodEpochs);
        return (a.exists, a.value);
    }

    /// @notice Schedule the settlement-fee rate (basis points of gross repayment) to
    ///         take effect when `effectiveEpoch` opens. Admin-only (Frank's EOA on
    ///         live Base), bounded to the immutable 0–1000 bps band, and prospective.
    ///         One value per epoch; re-scheduling a taken epoch reverts. Until an
    ///         override is scheduled AND its epoch opens, the historical 0.25% literal
    ///         stands (see createPromise).
    function scheduleSettlementFeeBps(uint64 effectiveEpoch, uint256 bps) external onlyAdmin {
        _requireScheduleEpoch(effectiveEpoch);
        if (bps > SETTLEMENT_FEE_BPS_MAX) revert CostOutOfDomain(); // lower band is 0
        if (scheduledSettlementFeeBps[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledSettlementFeeBps[effectiveEpoch] = ScheduledUint256({exists: true, value: bps});
        settlementFeeBpsEpochs.push(effectiveEpoch);
        emit SettlementFeeBpsScheduled(effectiveEpoch, bps);
    }

    /// @notice Schedule the maximum PVT principal accepted into a PVT-principal
    ///         promise, to take effect when `effectiveEpoch` opens. Admin-only,
    ///         bounded to the immutable [1 PVT, 1,000,000 PVT] band, prospective, one
    ///         value per epoch. Until an override is scheduled AND its epoch opens, no
    ///         on-chain principal cap is enforced (pre-WP5 behavior).
    function schedulePrincipalCap(uint64 effectiveEpoch, uint256 capAtomic) external onlyAdmin {
        _requireScheduleEpoch(effectiveEpoch);
        if (capAtomic < PRINCIPAL_CAP_MIN || capAtomic > PRINCIPAL_CAP_MAX) revert CostOutOfDomain();
        if (scheduledPrincipalCap[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledPrincipalCap[effectiveEpoch] = ScheduledUint256({exists: true, value: capAtomic});
        principalCapEpochs.push(effectiveEpoch);
        emit PrincipalCapScheduled(effectiveEpoch, capAtomic);
    }

    /// @notice Schedule the maximum deadline window (seconds) — the longest allowed
    ///         `deadline - creation` — to take effect when `effectiveEpoch` opens.
    ///         Admin-only, bounded to the immutable [1 hour, 90 days] band,
    ///         prospective, one value per epoch. Until an override is scheduled AND
    ///         its epoch opens, no on-chain bound applies (pre-WP5: the contract
    ///         accepts any future timestamp).
    function scheduleMaximumDeadline(uint64 effectiveEpoch, uint256 windowSeconds) external onlyAdmin {
        _requireScheduleEpoch(effectiveEpoch);
        if (windowSeconds < MAXIMUM_DEADLINE_MIN || windowSeconds > MAXIMUM_DEADLINE_MAX) revert CostOutOfDomain();
        if (scheduledMaximumDeadline[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledMaximumDeadline[effectiveEpoch] = ScheduledUint256({exists: true, value: windowSeconds});
        maximumDeadlineEpochs.push(effectiveEpoch);
        emit MaximumDeadlineScheduled(effectiveEpoch, windowSeconds);
    }

    /// @notice Schedule the default grace period (seconds) — the window after a
    ///         promise's deadline during which ONLY the borrower or lender may
    ///         markDefault — to take effect when `effectiveEpoch` opens. Admin-only,
    ///         bounded to the immutable [0, 30 days] band (a 0 grace is legal), and
    ///         prospective. One value per epoch. Until an override is scheduled AND its
    ///         epoch opens, the historical DEFAULT_GRACE_PERIOD (24 h) constant stands
    ///         (see markDefault).
    function scheduleDefaultGracePeriod(uint64 effectiveEpoch, uint256 gracePeriodSeconds) external onlyAdmin {
        _requireScheduleEpoch(effectiveEpoch);
        if (gracePeriodSeconds > DEFAULT_GRACE_PERIOD_MAX) revert CostOutOfDomain(); // lower band is 0
        if (scheduledDefaultGracePeriod[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledDefaultGracePeriod[effectiveEpoch] = ScheduledUint256({exists: true, value: gracePeriodSeconds});
        defaultGracePeriodEpochs.push(effectiveEpoch);
        emit DefaultGracePeriodScheduled(effectiveEpoch, gracePeriodSeconds);
    }

    // =========================================================================
    // Promise Functions
    // =========================================================================

    /**
     * @notice Create a promise (offer to borrow). Currency is fixed at creation.
     * @param promiseId Unique identifier.
     * @param principal Loan amount in the chosen currency's native decimals.
     * @param repayAmount Total to be repaid (principal + interest), same decimals.
     * @param deadline Unix timestamp by which the borrower must settle.
     * @param currencyType Currency.USDC for legacy USDC promises;
     *                     Currency.PVT for PVT-principal promises (fee burned, no discount).
     */
    function createPromise(
        bytes32 promiseId,
        uint256 principal,
        uint256 repayAmount,
        uint256 deadline,
        Currency currencyType
    ) external {
        if (principal == 0) revert InvalidAmount();
        if (repayAmount < principal) revert RepayMustExceedPrincipal();
        // WP5 promise.pvt_principal_cap — gates PVT-principal promises only (the cap
        // is PVT-denominated). Unset (the shipped default) → no on-chain cap, matching
        // pre-WP5 (principal was capped in the backend, not here).
        (bool capExists, uint256 capValue) = activePrincipalCap();
        if (currencyType == Currency.PVT && capExists && principal > capValue) {
            revert PrincipalCapExceeded();
        }
        if (deadline <= block.timestamp) revert InvalidDeadline();
        // WP5 promise.maximum_deadline — bounds the deadline window (deadline - now);
        // the check above guarantees deadline > block.timestamp, so `deadlineWindow`
        // cannot underflow. Unset (the shipped default) → any future timestamp is
        // accepted, matching pre-WP5 (the backend bounded the window). Currency-
        // agnostic: it bounds the promise timeline, not the currency.
        uint256 deadlineWindow = deadline - block.timestamp;
        (bool maxDeadlineExists, uint256 maxDeadlineValue) = activeMaximumDeadline();
        if (maxDeadlineExists && deadlineWindow > maxDeadlineValue) {
            revert MaximumDeadlineExceeded();
        }
        if (promises[promiseId].borrower != address(0)) revert PromiseAlreadyExists();

        // WP5 promise.pvt_settlement_fee — override-else-literal. Unset (the shipped
        // default) preserves the historical 0.25% (25 bps) literal byte-for-byte;
        // once an override is scheduled and its epoch opens it replaces the rate
        // within the immutable 0–1000 bps band. Denominated in the same currency as
        // the principal, exactly as before.
        (bool feeExists, uint256 feeValue) = activeSettlementFeeBps();
        uint256 fee = feeExists
            ? (repayAmount * feeValue) / 10000
            : (repayAmount * 25) / 10000;

        promises[promiseId] = Promise({
            borrower: msg.sender,
            lender: address(0),
            principal: principal,
            repayAmount: repayAmount,
            fee: fee,
            deadline: deadline,
            status: Status.Open,
            currency: currencyType,
            feePaidInPVT: false
        });

        if (currencyType == Currency.PVT) {
            emit PromiseCreatedPVT(promiseId, msg.sender, principal, repayAmount, deadline);
        } else {
            emit PromiseCreated(promiseId, msg.sender, principal, repayAmount, deadline);
        }
    }

    /**
     * @notice Lender funds an open promise. Transfers principal directly to
     *         the borrower in the promise's denominated currency. The contract
     *         never holds principal (matches V2 architecture).
     */
    function fundPromise(bytes32 promiseId) external {
        Promise storage p = promises[promiseId];
        if (p.status != Status.Open) {
            revert InvalidStatus(Status.Open, p.status);
        }

        p.lender = msg.sender;
        p.status = Status.Funded;

        if (p.currency == Currency.PVT) {
            bool ok = pvt.transferFrom(msg.sender, p.borrower, p.principal);
            if (!ok) revert TransferFailed();
            emit PromiseFundedPVT(promiseId, msg.sender, p.principal);
        } else {
            bool ok = usdc.transferFrom(msg.sender, p.borrower, p.principal);
            if (!ok) revert TransferFailed();
            emit PromiseFunded(promiseId, msg.sender, p.principal);
        }
    }

    /**
     * @notice Borrower settles a funded promise.
     *
     *         USDC-principal:
     *           - payFeeInPVT == false: standard. transferFrom borrower → lender
     *             (repayAmount - fee) and transferFrom borrower → feeWallet (fee).
     *           - payFeeInPVT == true:  legacy 50%-discount. PVT fee burned, full
     *             repayAmount in USDC goes to lender.
     *
     *         PVT-principal:
     *           - payFeeInPVT MUST be false. Fee is intrinsically PVT and burned
     *             via burn(). transferFrom borrower → lender (repayAmount - fee)
     *             then transferFrom borrower → contract (fee) then burn.
     */
    function settlePromise(bytes32 promiseId, bool payFeeInPVT) external {
        Promise storage p = promises[promiseId];
        if (msg.sender != p.borrower) revert OnlyBorrower();
        if (p.status != Status.Funded) {
            revert InvalidStatus(Status.Funded, p.status);
        }

        p.status = Status.Settled;

        if (p.currency == Currency.PVT) {
            if (payFeeInPVT) revert PVTPrincipalRejectsDiscount();

            uint256 netAmount = p.repayAmount - p.fee;

            // Pay lender directly - contract takes no custody of principal.
            bool ok1 = pvt.transferFrom(msg.sender, p.lender, netAmount);
            if (!ok1) revert TransferFailed();

            // Pull fee into contract and burn.
            bool ok2 = pvt.transferFrom(msg.sender, address(this), p.fee);
            if (!ok2) revert TransferFailed();
            pvt.burn(p.fee);

            emit PromiseSettledPVT(promiseId, p.lender, netAmount, p.fee);
            return;
        }

        // USDC-principal. WP13: the PVT-fee discount branch is RETIRED, so a caller
        // asking for it gets a LOUD refusal instead of the old silent fallback that
        // charged them in USDC without saying so.
        if (payFeeInPVT) revert PVTFeeDiscountRetired();

        uint256 usdcNetAmount = p.repayAmount - p.fee;
        bool lenderOk = usdc.transferFrom(msg.sender, p.lender, usdcNetAmount);
        if (!lenderOk) revert TransferFailed();
        bool usdcFeeOk = usdc.transferFrom(msg.sender, feeWallet, p.fee);
        if (!usdcFeeOk) revert TransferFailed();

        emit PromiseSettled(promiseId, p.lender, usdcNetAmount, p.fee);
    }

    /**
     * @notice Mark a funded promise as defaulted after the deadline.
     *         During the 24h grace window, only borrower or lender may call.
     *         Currency-agnostic - only flips status.
     */
    function markDefault(bytes32 promiseId) external {
        Promise storage p = promises[promiseId];
        if (p.status != Status.Funded) {
            revert InvalidStatus(Status.Funded, p.status);
        }
        if (block.timestamp < p.deadline) revert DeadlineNotReached();

        // WP5 promise.default_grace_period — override-else-literal. Unset (the shipped
        // default) keeps the historical DEFAULT_GRACE_PERIOD (24 h) byte-for-byte; a
        // scheduled, epoch-activated override replaces the window within [0, 30 days].
        // A grace of 0 means anyone may mark default immediately at the deadline.
        (bool graceExists, uint256 graceValue) = activeDefaultGracePeriod();
        uint256 grace = graceExists ? graceValue : DEFAULT_GRACE_PERIOD;
        if (block.timestamp < p.deadline + grace) {
            if (msg.sender != p.borrower && msg.sender != p.lender) {
                revert OnlyBorrower();
            }
        }

        p.status = Status.Defaulted;

        if (p.currency == Currency.PVT) {
            emit PromiseDefaultedPVT(promiseId, p.borrower, p.lender, p.principal);
        } else {
            emit PromiseDefaulted(promiseId, p.borrower, p.lender, p.principal);
        }
    }

    function cancelPromise(bytes32 promiseId) external {
        Promise storage p = promises[promiseId];
        if (msg.sender != p.borrower) revert OnlyBorrower();
        if (p.status != Status.Open) {
            revert InvalidStatus(Status.Open, p.status);
        }
        p.status = Status.Cancelled;
        emit PromiseCancelled(promiseId);
    }

    // =========================================================================
    // Views
    // =========================================================================

    /**
     * @notice Currency of a promise. Returns 0 for USDC, 1 for PVT.
     */
    function currency(bytes32 promiseId) external view returns (Currency) {
        Promise storage p = promises[promiseId];
        if (p.borrower == address(0)) revert PromiseNotFound();
        return p.currency;
    }

    /**
     * @notice Contract version. Returns "v3".
     */
    function version() external pure returns (string memory) {
        return VERSION;
    }
}
