// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {IPVTBurnable} from "./interfaces/IPVTBurnable.sol";
import {IEpochClock} from "./interfaces/IEpochClock.sol";
import {IIssuanceIndex} from "./interfaces/IIssuanceIndex.sol";

/**
 * @dev The Court surface this escrow routes the ADJUDICATION FEE into (D-174).
 *      Mirrors the BondPool-side `IArbitratorRewardSink` exactly, and is guarded
 *      `onlyEscrow` on the Court side. See ProvianCourtV2.fundEscrowDisputeReward.
 */
interface IArbitratorRewardSink {
    function fundEscrowDisputeReward(bytes32 escrowId, uint256 amount) external;
}

/**
 * @title ProvianEscrowV4
 * @notice Trustless escrow v4 - supports PVT as a first-class principal currency
 *         alongside USDC. Each escrow is denominated in exactly one currency at
 *         creation, immutable for its lifetime. USDC flows match V3 bit-for-bit.
 *         PVT-principal flows settle entirely in PVT with the fee burned.
 *
 * @dev Currency convention:
 *      - Currency.USDC: amount and fee in USDC's 6 decimals (1 USDC = 1e6).
 *      - Currency.PVT:  amount and fee in PVT's 18 decimals (1 PVT = 1e18).
 *      Off-chain consumers MUST read `currency(escrowId)` (or the struct field)
 *      before interpreting any raw amount. Cross-currency operations are
 *      structurally impossible: PVT-principal escrows never touch USDC
 *      accounting, and since WP13 retired the 50%-fee-discount path a
 *      USDC-principal escrow never touches PVT at all.
 *
 * @dev Court compatibility: getParties(bytes32) and resolveDispute(bytes32,bool)
 *      preserve their V3 signatures so existing ProvianCourtV2 deployments can
 *      adjudicate V4 escrows without modification.
 *
 * @dev Constitutional Note: This is a reference implementation. It is not
 *      canonical. Human-resolving and Genesis mints use the immutable 99% contributor /
 *      0.5% Provian / 0.5% Foundation treatment. Agent-side mints without a verified
 *      human beneficiary use the applicable prospective Foundation rate and contributor
 *      residual. On live Base Pass-3 the admin is Frank's EOA; no transferAdmin or authority
 *      handoff is authorized without separate explicit approval.
 */
contract ProvianEscrowV4 {

    /**
     * @notice Contract version string. Off-chain consumers can dispatch on this.
     */
    string public constant VERSION = "v4";

    /**
     * @notice Currency discriminator. Set at creation, immutable thereafter.
     *         ABI representation is uint8: 0 = USDC, 1 = PVT.
     */
    enum Currency {
        USDC,   // 0 - 6 decimals, principal in USDC, fee to feeWallet (or burned at 50% discount in PVT)
        PVT     // 1 - 18 decimals, principal in PVT, fee always burned in PVT (no discount)
    }

    enum Status {
        Created,    // 0
        Funded,     // 1
        Completed,  // 2
        Disputed,   // 3
        Resolved,   // 4
        Cancelled   // 5
    }

    /**
     * @notice Escrow record. Currency is fixed at creation.
     * @dev `amount` and `fee` decimals depend on `currency`:
     *      - USDC: 6 decimals
     *      - PVT:  18 decimals
     *      `feePaidInPVT` is now ALWAYS FALSE on every path — WP13 retired the only
     *      writer (the PVT-fee discount branch). DO NOT REMOVE THE FIELD: it is the
     *      trailing word of the `escrows(bytes32)` getter tuple, and the backend
     *      identifies the V4 8-word layout against the V3 7-word one by that shape
     *      (`core/onchain/tx-verifier.ts` decodeEscrowStructPrefix,
     *      `core/agent-bank/escrow-release.ts` readEscrowStatus). Both read word 5
     *      positionally, so dropping the field would move nothing they read TODAY —
     *      but it would invalidate the documented version discriminator they are
     *      written against. Keeping it costs one always-zero word.
     */
    struct Escrow {
        address depositor;
        address recipient;
        uint256 amount;
        uint256 fee;
        uint256 autoReleaseAt;
        Status status;
        Currency currency;
        bool feePaidInPVT;
    }

    /**
     * @notice A prospectively-scheduled cost value. `exists` distinguishes
     *         "an override was scheduled" from "unset"; because the scheduled
     *         value may legitimately be 0 (e.g. a 0-bps fee is inside the
     *         escrow.pvt_principal_fee 0–1000 band), a bare `value == 0` cannot
     *         mean "unset". Mirrors ProvianPVT9's `ScheduledUint256` shape.
     */
    struct ScheduledUint256 {
        bool exists;
        uint256 value;
    }

    // =========================================================================
    // State
    // =========================================================================

    mapping(bytes32 => Escrow) public escrows;
    address public admin;
    address public feeWallet;
    IERC20 public usdc;
    IPVTBurnable public pvt;
    // =========================================================================
    // WP13 — `pvtUsdcRate` / `setPVTRate` / the 50%-PVT-fee discount branch: RETIRED.
    //
    // Removed for two INDEPENDENT reasons, either of which is sufficient.
    //
    // 1. IT ORIGINATED A PRICE. `pvtUsdcRate` is a Provian-set PVT/USDC exchange rate
    //    used to size a fee. Provian originates no price and no market, so a
    //    Provian-authored rate is exactly the mechanism that may not be used.
    //
    // 2. IT WAS A LIVE SILENT-FALLBACK BUG. The branch was gated on
    //    `payFeeInPVT && pvtUsdcRate > 0`, and on all three deployed institutions
    //    `pvtUsdcRate` reads 0. A caller passing `payFeeInPVT = true` therefore fell
    //    through to the USDC branch with NO revert, NO event and NO burn — their
    //    instruction was discarded and they could not tell. Proven by the D-062
    //    pre-change control, which passes against the shipped contracts.
    //
    // WHY THE FEE IS NOT RE-DENOMINATED IN PVT. WP13's directive asked for fees in PVT
    // regardless of settlement currency, sized by the index and never by a price read.
    // Those two constraints cannot both hold for a PROPORTIONAL CROSS-CURRENCY fee:
    // USDC principal is 6-dp and PVT is 18-dp, so charging bps-of-principal in PVT
    // needs a x1e12 normalisation, which makes the PVT fee exactly equal the USDC fee
    // in whole units — a hardcoded 1 PVT : 1 USDC peg AUTHORED BY PROVIAN. That is a
    // STRONGER originated-price problem than an oracle read, not a weaker one: an
    // oracle reports a price someone else set, while the constant invents one. It also
    // fails functionally — the same fee is negligible or ruinous depending entirely on
    // where PVT actually trades, which Provian does not control. An index-sized FLAT
    // fee is not a substitute either: regressive on small positions, arbitrary on
    // large. There is no priceless formulation of a proportional cross-currency fee.
    //
    // WHAT STANDS INSTEAD: the fee stays in the SETTLEMENT currency at this contract's
    // existing literal (amount * 5 / 1000), so user cost is unchanged and no valuation
    // is originated. The `IPVTBurnable` binding and the PVT-principal burn path are
    // KEPT INTACT AND REACHABLE, so a PVT-denominated fee can be enabled later without
    // a redeploy — once a genuine third-party DEX exists and an ORACLE-READ version
    // becomes permissible under the standing no-originated-price rule.
    //
    // This is strictly AUTHORITY-REMOVING, the same shape as the WP12/D-018 setter
    // strip: one admin setter and one price input deleted, nothing added.
    // =========================================================================
    address public courtContract;
    bool private courtContractSet;

    /// @notice Immutable epoch clock — the ProvianPVT9 kernel on live Base. Read via
    ///         `currentEpoch()` to time prospective cost-parameter schedules (see
    ///         IEpochClock). Bound once at construction: no setter, so binding the
    ///         clock introduces no new settable-address authority.
    IEpochClock public immutable epochClock;

    // =========================================================================
    // WP13 addendum-3 (D-174) — ESCROW DISPUTE ADJUDICATION FEE.
    //
    // D-171 established that a SHARE OF THE PRINCIPAL FEE cannot pay an escrow
    // arbitration panel, and that finding stands unchanged: the PVT-principal fee is
    // burned at funding, the USDC-principal fee is USDC (which the Court's
    // `IPVTBurnable` forfeiture rail cannot burn), and a proportional share is a ramp
    // rather than a floor. What D-171 named as the fix is what this is — a SEPARATE,
    // FLAT, PVT-denominated fee that is not a share of anything.
    //
    // WHY A FLAT PVT CHARGE WORKS WHERE THE SHARE DID NOT. The blocker was never PVT;
    // it was PROPORTIONALITY. A proportional cross-currency fee needs a PVT/USDC
    // conversion, and Provian originates no price (see the `setPVTRate` retirement
    // block above). A FLAT PVT amount needs no conversion and no price read at all: it
    // is the same 30 PVT whether the escrow settles in USDC or in PVT, because it is
    // not derived from the principal. It is dimensioned in PVT, so unlike the bps rate
    // it INDEXES normally — hence the `IIssuanceIndex` binding below, which is exactly
    // why D-171's "EscrowV4 contains no `_indexFloor` because a bps rate is
    // dimensionless" was right about that fee and does not reach this one.
    //
    // WHO PAYS, AND WHEN. The party who escalates the dispute to a panel, at the moment
    // of escalation (`delegateToCourt`). The precedent is BondPool's `claimFilingFee`:
    // the claimant pays to file, and it is NON-REFUNDABLE — the cost of invoking
    // adjudication, not a deposit against the outcome. It is charged in PVT, pulled
    // from the caller and forwarded to the Court IN THE SAME CALL, so this contract
    // never holds it and its custody posture is unchanged: escrow principal is the only
    // value this contract has ever custodied, and that is still true.
    //
    // WHAT HAPPENS IF NOBODY PAYS. Then no panel is assembled — `assignPanel` on the
    // Court is gated on the fee having been routed — and the dispute resolves on the
    // rails that already exist and are DELIBERATELY UNTOUCHED here: admin/court
    // `resolveDispute`, and the 30-day permissionless `claimDisputeTimeout` that
    // refunds the depositor. The no-panel case therefore still resolves, and still
    // resolves depositor-favorably, which is the conservative outcome when no
    // adjudication happened.
    //
    // NO SCHEDULER, DELIBERATELY. Every other cost parameter on this contract carries a
    // bounded prospective scheduler. This one does not: it is a CONSTANT baseline with
    // an issuance-indexed FLOOR, so it can rise with the economy and can never be
    // scheduled to zero. That is the precise defect D-171 recorded against the bps
    // rate ("the rate's immutable band floor is 0 bps, so the income is schedulable to
    // nothing"), and a constant is the strongest available answer to it. It also adds
    // no new authority: there is no setter to call.
    // =========================================================================

    /// @notice Immutable issuance index — the ProvianPVT9 kernel on live Base, the same
    ///         binding BondPool and CourtV2 carry. Bound once at construction: no
    ///         setter, so this introduces no new settable-address authority. Read only
    ///         through `_trailingIssuance`, which fails CLOSED to 0.
    IIssuanceIndex public immutable issuanceIndex;

    uint256 public constant INDEX_PPM_DENOMINATOR = 1_000_000;

    /// @notice Baseline escrow-dispute adjudication fee. NOT A NEW NUMBER: it is the
    ///         BondPool's `claimsProcessingFee` literal (30 PVT), the fee this system
    ///         already charges for ADJUDICATING a dispute, and it splits across the
    ///         same panel size (3) into the same 10 PVT per seat against the same
    ///         75 PVT arbitrator collateral. The economics are D-168's, unchanged.
    uint256 public constant DISPUTE_ADJUDICATION_FEE_BASELINE = 30e18;
    /// @notice Indexed at the SAME 3 ppm ratio as the claims-processing fee it mirrors
    ///         (`ProvianBondPool.CLAIMS_PROCESSING_FEE_INDEX_PPM`), so the two adjudication
    ///         fees in this system move together rather than drifting apart.
    uint256 public constant DISPUTE_ADJUDICATION_FEE_INDEX_PPM = 3;

    // =========================================================================
    // Pass-3 (audit #4 / #18) — Disputed-state liveness + pull-payment resolution
    //
    //   #4: the Disputed state had NO permissionless or timeout exit. A good-faith
    //       depositor who disputes before autoReleaseAt traded the trustless
    //       auto-release for a resolution that admin/court inaction could freeze
    //       indefinitely. Fix: a symmetric, permissionless auto-refund-to-depositor
    //       timeout (claimDisputeTimeout) so funds can never be frozen.
    //   #18: castVote → resolveDispute(true) pushed USDC/PVT to the recipient in the
    //       SAME tx, so a reverting/blacklisted recipient reverted the whole vote —
    //       only the depositor-favorable outcome was reachable. Fix: the party
    //       payout is pushed with a pull-payment fallback (_payoutOrCredit), so a
    //       reverting recipient can never revert the resolution or the vote.
    // =========================================================================

    /// @notice Once a dispute is filed, if neither admin nor the wired court
    ///         resolves within this window, ANYONE may refund the depositor. This
    ///         is the symmetric counterpart to autoReleaseAt (which lets anyone
    ///         release to the recipient after the timeout). 30 days is ~15x the
    ///         court's 48h vote window, so on-chain adjudication has priority in
    ///         practice: a functional admin assigns a panel promptly and it
    ///         resolves days inside the window. The timeout is a last-resort
    ///         backstop for a NON-functional admin/court. Accepted edge: if a panel
    ///         is assigned within 48h of the deadline, the permissionless timeout
    ///         may finalize (refund the depositor) before the panel's verdict
    ///         executes — a funds-safe, non-custodial, depositor-favorable outcome
    ///         with no double-spend (see test_4_latePanelRace_timeoutWins_fundsSafe).
    uint256 public constant DISPUTE_RESOLUTION_TIMEOUT = 30 days;

    /// @notice escrowId => timestamp after which claimDisputeTimeout is callable.
    ///         Written when disputeEscrow moves an escrow into Disputed; 0 for any
    ///         escrow that was never disputed.
    mapping(bytes32 => uint256) public disputeDeadline;

    /// @notice D-486 fix 2: escrowId => the timestamp its dispute left the Disputed state,
    ///         by any path (the Court's verdict, admin resolution, or the permissionless
    ///         timeout); 0 while it is still Disputed or was never disputed. The Court
    ///         reads it to close a panel whose escrow settled outside the Court, returning
    ///         the panel's collateral instead of stranding or burning it.
    mapping(bytes32 => uint256) public disputeSettledAt;

    /// @notice D-486 migration seed: an unfunded (Created) escrow carried from the
    ///         predecessor, written once in the constructor. Only Created escrows carry:
    ///         they hold no funds. A funded escrow's principal cannot leave the
    ///         predecessor except to one of its own parties, so none is seeded here.
    struct EscrowSeed {
        bytes32 escrowId;
        address depositor;
        address recipient;
        uint256 amount;
        uint256 fee;
        uint256 autoReleaseAt;
        Currency currency;
    }

    /// @notice Pull-payment ledger for a resolution whose party payout could not
    ///         be pushed (recipient/depositor reverts or is blacklisted). At most
    ///         one credited payout per escrow (a resolution pays exactly one party;
    ///         the feeWallet leg is a trusted direct push). Anyone may trigger the
    ///         payout to the stored beneficiary via withdrawResolvedFunds.
    mapping(bytes32 => uint256) public pendingWithdrawal;
    mapping(bytes32 => address) public pendingBeneficiary;

    // =========================================================================
    // WP5 — Escrow-native cost parameters (conversion-free, PVT-native)
    //
    // On-chain home for the five Escrow-rooted rows of the approved PVT cost
    // catalog. Each parameter has its own bounded, admin-only (Frank's EOA on
    // live Base), prospective-epoch scheduler; scheduled values apply only when
    // their epoch opens, mirroring the ProvianPVT9 kernel's schedule/apply/
    // prospectivity machinery (ScheduledUint256 + _requireScheduleEpoch +
    // PolicyAlreadyScheduled + apply-on-open). Immutable min/max bands are
    // compiled in below so even the admin cannot schedule a value the reviewed
    // catalog does not permit.
    //
    // FAIL-CLOSED AT ZERO. Every parameter defaults to inert:
    //   - fee / dispute-timeout carry a live historical literal, so "inert"
    //     means "no override active → the existing literal stands", holding the
    //     baseline byte-for-byte;
    //   - principal cap / auto-release period / agreement deadline have no
    //     historical on-chain gate, so "inert" means "no gate", which is exactly
    //     the current-master behavior.
    // With every parameter unset (the shipped state), createEscrow / fundEscrow /
    // disputeEscrow behave identically to the pre-WP5 contract. No economic value
    // is set here; a value is Frank's separate approval.
    // =========================================================================

    // The activation clock is the immutable ProvianPVT9 kernel epoch (see
    // `epochClock` / IEpochClock). A schedule for epoch E activates exactly when the
    // kernel's currentEpoch() reaches E, resolved lazily at read time — there is no
    // local counter and no permissionless "open epoch" call, so a queued ladder
    // cannot be collapsed in a single block. Epoch 0 (and any pre-arming state where
    // currentEpoch() reverts) leaves every override inert → the historical literal stands.

    // --- escrow.pvt_principal_fee — basis points of gross principal, 0–1000 ---
    /// @notice Immutable upper band for the principal-fee rate (bps). The lower
    ///         band is 0 (a zero fee is permitted), so only the ceiling is gated.
    uint256 public constant FEE_BPS_MAX = 1_000;
    mapping(uint64 => ScheduledUint256) public scheduledFeeBps;
    /// @notice Epochs at which a fee override was scheduled (append-only, admin-only
    ///         growth). Scanned by activeFeeBps() to forward-fill the value effective
    ///         at the kernel's currentEpoch(). Empty → the historical 0.5% (50 bps)
    ///         literal in createEscrow stands, unchanged.
    uint64[] public feeBpsEpochs;

    // --- escrow.pvt_principal_cap — max PVT principal, 1e18–1e24 atomic units ---
    /// @notice Immutable band for the PVT-principal cap: floor 1 PVT, ceiling
    ///         1,000,000 PVT (18-dp atomic units). Denominated in PVT, so the
    ///         cap gates PVT-principal escrows only.
    uint256 public constant PRINCIPAL_CAP_MIN = 1e18;
    uint256 public constant PRINCIPAL_CAP_MAX = 1_000_000e18;
    mapping(uint64 => ScheduledUint256) public scheduledPrincipalCap;
    /// @notice Epochs at which a PVT-principal-cap override was scheduled. Empty → no
    ///         cap is enforced on-chain (pre-WP5 behavior — the backend caps principal).
    uint64[] public principalCapEpochs;

    // --- escrow.maximum_auto_release_period + escrow.maximum_agreement_deadline
    //     Both are duration bounds on seconds, band 1h–90d. V4 has a single
    //     user-supplied timestamp (`autoReleaseAt`), so the two catalog rows both
    //     bound the sole on-chain window `autoReleaseAt - block.timestamp`; the
    //     tighter active bound wins. Distinct storage + setters per the row set.
    uint256 public constant AUTO_RELEASE_PERIOD_MIN = 1 hours; // 3600
    uint256 public constant AUTO_RELEASE_PERIOD_MAX = 90 days; // 7,776,000
    uint256 public constant AGREEMENT_DEADLINE_MIN = 1 hours; // 3600
    uint256 public constant AGREEMENT_DEADLINE_MAX = 90 days; // 7,776,000
    mapping(uint64 => ScheduledUint256) public scheduledAutoReleasePeriod;
    /// @notice Epochs at which a max-auto-release-period override was scheduled. Empty
    ///         → no on-chain bound (pre-WP5: contract accepts any future timestamp).
    uint64[] public autoReleasePeriodEpochs;
    mapping(uint64 => ScheduledUint256) public scheduledAgreementDeadline;
    /// @notice Epochs at which a max-agreement-deadline override was scheduled. Empty
    ///         → no on-chain bound (pre-WP5: the backend bounded the window).
    uint64[] public agreementDeadlineEpochs;

    // --- escrow.dispute_resolution_timeout — seconds, 2d–180d ---
    /// @notice Immutable band for the dispute-resolution timeout: floor 2 days,
    ///         ceiling 180 days. This is an override of the live 30-day constant
    ///         (`DISPUTE_RESOLUTION_TIMEOUT`), not an additive gate.
    uint256 public constant DISPUTE_TIMEOUT_MIN = 2 days; // 172,800
    uint256 public constant DISPUTE_TIMEOUT_MAX = 180 days; // 15,552,000
    mapping(uint64 => ScheduledUint256) public scheduledDisputeTimeout;
    /// @notice Epochs at which a dispute-timeout override was scheduled. Empty → the
    ///         historical `DISPUTE_RESOLUTION_TIMEOUT` (30 days) constant is used.
    uint64[] public disputeTimeoutEpochs;

    // =========================================================================
    // Events - Legacy (USDC-principal). Signatures match V3 exactly.
    // =========================================================================

    event EscrowCreated(
        bytes32 indexed escrowId,
        address indexed depositor,
        address indexed recipient,
        uint256 amount,
        uint256 fee,
        uint256 autoReleaseAt
    );
    event EscrowFunded(bytes32 indexed escrowId, uint256 amount);
    event EscrowReleased(bytes32 indexed escrowId, address indexed recipient, uint256 netAmount, uint256 fee, bool autoRelease);
    event EscrowResolved(bytes32 indexed escrowId, bool releaseToRecipient);
    // WP13: `FeePaidInPVT` is RETIRED with the discount branch that emitted it.

    // =========================================================================
    // Events - PVT-principal. Distinct event types so indexers can subscribe
    // to either currency without filtering on a struct field.
    // =========================================================================

    event EscrowCreatedPVT(
        bytes32 indexed escrowId,
        address indexed depositor,
        address indexed recipient,
        uint256 amount,
        uint256 fee,
        uint256 autoReleaseAt
    );
    event EscrowFundedPVT(bytes32 indexed escrowId, uint256 amount, uint256 feeBurned);
    event EscrowReleasedPVT(bytes32 indexed escrowId, address indexed recipient, uint256 netAmount, bool autoRelease);
    event EscrowResolvedPVT(bytes32 indexed escrowId, bool releaseToRecipient);

    // =========================================================================
    // Events - Shared (no currency-dependent payload).
    // =========================================================================

    event EscrowDisputed(bytes32 indexed escrowId);
    /// @notice D-486: an unfunded escrow carried from the predecessor at construction.
    ///         Distinct from EscrowCreated so no watcher reads the carry as a new escrow.
    event EscrowCarried(
        bytes32 indexed escrowId,
        address indexed depositor,
        address indexed recipient,
        uint256 amount,
        uint256 fee,
        uint256 autoReleaseAt,
        Currency currency
    );
    event EscrowCancelled(bytes32 indexed escrowId);
    event CourtContractSet(address indexed courtContract);
    event DisputeDelegatedToCourt(bytes32 indexed escrowId);
    /// @notice WP13 addendum-3 (D-174): the flat PVT adjudication fee was charged to
    ///         `payer` and routed to the Court to fund the panel. Emitted alongside
    ///         `DisputeDelegatedToCourt`, which is preserved unchanged.
    event DisputeAdjudicationFeePaid(bytes32 indexed escrowId, address indexed payer, uint256 fee);
    // WP13: `PVTRateUpdated` is RETIRED with `setPVTRate`.
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);
    // Pass-3 (#4 / #18)
    event EscrowDisputeTimedOut(bytes32 indexed escrowId);
    event WithdrawalPending(bytes32 indexed escrowId, address indexed beneficiary, uint256 amount);
    event ResolvedFundsWithdrawn(bytes32 indexed escrowId, address indexed beneficiary, uint256 amount);

    // =========================================================================
    // Events - WP5 cost-parameter machinery
    // =========================================================================

    event FeeBpsScheduled(uint64 indexed effectiveEpoch, uint256 bps);
    event PrincipalCapScheduled(uint64 indexed effectiveEpoch, uint256 capAtomic);
    event AutoReleasePeriodScheduled(uint64 indexed effectiveEpoch, uint256 periodSeconds);
    event AgreementDeadlineScheduled(uint64 indexed effectiveEpoch, uint256 deadlineSeconds);
    event DisputeTimeoutScheduled(uint64 indexed effectiveEpoch, uint256 timeoutSeconds);

    // =========================================================================
    // Errors
    // =========================================================================

    error OnlyAdmin();
    error OnlyDepositor();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidDeadline();
    error EscrowAlreadyExists();
    error EscrowNotFound();
    error InvalidStatus(Status expected, Status actual);
    error AutoReleaseNotReached();
    error AutoReleaseAlreadyPassed();
    error TransferFailed();
    error OnlyAdminOrCourt();
    error CourtAlreadySet();
    error CourtNotSet();
    /// @notice WP13: raised when a caller asks to pay the fee in PVT. The discount
    ///         branch is retired, so the request is REFUSED LOUDLY rather than
    ///         silently downgraded to a USDC charge, which is what it used to do.
    error PVTFeeDiscountRetired();
    error PVTPrincipalRejectsDiscount();
    // Pass-3 (#4 / #18)
    error DisputeTimeoutNotReached();
    error NothingToWithdraw();
    // D-486
    error InvalidSeed();
    // WP5 cost-parameter machinery
    error PolicyNotProspective();
    error PolicyAlreadyScheduled();
    error CostOutOfDomain();
    error PrincipalCapExceeded();
    error AutoReleasePeriodExceeded();
    error AgreementDeadlineExceeded();

    // =========================================================================
    // Constructor
    // =========================================================================

    /// @param seedEscrows D-486: unfunded escrows carried from the predecessor; empty on
    ///        a fresh deployment. Each lands exactly as it stood there, in Created.
    constructor(
        address _admin,
        address _feeWallet,
        address _usdc,
        address _pvt,
        address _epochClock,
        address _issuanceIndex,
        EscrowSeed[] memory seedEscrows
    ) {
        if (_admin == address(0) || _feeWallet == address(0) ||
            _usdc == address(0) || _pvt == address(0) || _epochClock == address(0) ||
            _issuanceIndex == address(0)) {
            revert InvalidAddress();
        }
        admin = _admin;
        feeWallet = _feeWallet;
        usdc = IERC20(_usdc);
        pvt = IPVTBurnable(_pvt);
        epochClock = IEpochClock(_epochClock);
        issuanceIndex = IIssuanceIndex(_issuanceIndex);

        for (uint256 i = 0; i < seedEscrows.length; ++i) {
            EscrowSeed memory s = seedEscrows[i];
            if (
                s.escrowId == bytes32(0) || s.depositor == address(0) || s.recipient == address(0) || s.amount == 0
                    || s.fee > s.amount || escrows[s.escrowId].depositor != address(0)
            ) revert InvalidSeed();
            escrows[s.escrowId] = Escrow({
                depositor: s.depositor,
                recipient: s.recipient,
                amount: s.amount,
                fee: s.fee,
                autoReleaseAt: s.autoReleaseAt,
                status: Status.Created,
                currency: s.currency,
                feePaidInPVT: false
            });
            emit EscrowCarried(s.escrowId, s.depositor, s.recipient, s.amount, s.fee, s.autoReleaseAt, s.currency);
        }
    }

    // =========================================================================
    // Modifiers
    // =========================================================================

    modifier onlyAdmin() {
        if (msg.sender != admin) revert OnlyAdmin();
        _;
    }

    modifier onlyAdminOrCourt() {
        if (msg.sender != admin && msg.sender != courtContract) revert OnlyAdminOrCourt();
        _;
    }

    modifier onlyDepositor(bytes32 escrowId) {
        if (msg.sender != escrows[escrowId].depositor) revert OnlyDepositor();
        _;
    }

    // =========================================================================
    // Admin
    // =========================================================================

    // WP13: `setPVTRate` is RETIRED — see the retirement block in State. It was the
    // only writer of the originated PVT/USDC rate, so removing it removes the
    // authority to originate a price at all.

    function setCourtContract(address _court) external onlyAdmin {
        if (_court == address(0)) revert InvalidAddress();
        if (courtContractSet) revert CourtAlreadySet();
        courtContract = _court;
        courtContractSet = true;
        emit CourtContractSet(_court);
    }

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

    /// @notice The trailing-12-epoch average issuance measured by the kernel, or 0 when
    ///         there is no measurement yet. Fails CLOSED exactly like `_currentEpoch`:
    ///         an unarmed, reverting, or pre-window kernel yields 0, which makes the
    ///         index floor inert so the baseline literal stands. A read can never mint,
    ///         burn, or move a token — `trailingAverageForEpoch` is `view`.
    function _trailingIssuance() internal view returns (uint256) {
        try issuanceIndex.trailingAverageForEpoch(_currentEpoch()) returns (uint256 avg) {
            return avg;
        } catch {
            return 0;
        }
    }

    /// @dev The floor rule, identical to BondPool's and Court's: `max(baseline, ppm x
    ///      average / 1e6)`. Because it is a MAX against the baseline it can only ever
    ///      RAISE a cost above its literal and never lower one — with a zero index it
    ///      returns the baseline byte-for-byte.
    function _indexFloor(uint256 baseline, uint256 ppm, uint256 avg) internal pure returns (uint256) {
        uint256 fromIndex = (ppm * avg) / INDEX_PPM_DENOMINATOR;
        return fromIndex > baseline ? fromIndex : baseline;
    }

    /// @notice The FLAT PVT fee charged to escalate a dispute to an arbitration panel
    ///         RIGHT NOW: `max(30 PVT, 3 ppm x trailing average)`. A MINIMUM on a cost,
    ///         never a maximum; with a thin or unmeasured index it is exactly 30 PVT.
    ///         Denominated in PVT regardless of the escrow's settlement currency —
    ///         being flat, it needs no conversion and reads no price.
    function disputeAdjudicationFee() public view returns (uint256) {
        return _indexFloor(
            DISPUTE_ADJUDICATION_FEE_BASELINE,
            DISPUTE_ADJUDICATION_FEE_INDEX_PPM,
            _trailingIssuance()
        );
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

    /// @notice The principal-fee override active at the current kernel epoch, as
    ///         (exists, value). exists == false → the 0.5% literal stands. The
    ///         (bool,uint256) shape matches the pre-WP-CLK public-variable getter.
    function activeFeeBps() public view returns (bool exists, uint256 value) {
        ScheduledUint256 memory a = _resolveActive(scheduledFeeBps, feeBpsEpochs);
        return (a.exists, a.value);
    }

    /// @notice The PVT-principal cap active at the current kernel epoch, as
    ///         (exists, value). exists == false → no on-chain cap.
    function activePrincipalCap() public view returns (bool exists, uint256 value) {
        ScheduledUint256 memory a = _resolveActive(scheduledPrincipalCap, principalCapEpochs);
        return (a.exists, a.value);
    }

    /// @notice The max auto-release period active at the current kernel epoch, as
    ///         (exists, value). exists == false → no on-chain bound.
    function activeAutoReleasePeriod() public view returns (bool exists, uint256 value) {
        ScheduledUint256 memory a = _resolveActive(scheduledAutoReleasePeriod, autoReleasePeriodEpochs);
        return (a.exists, a.value);
    }

    /// @notice The max agreement deadline active at the current kernel epoch, as
    ///         (exists, value). exists == false → no on-chain bound.
    function activeAgreementDeadline() public view returns (bool exists, uint256 value) {
        ScheduledUint256 memory a = _resolveActive(scheduledAgreementDeadline, agreementDeadlineEpochs);
        return (a.exists, a.value);
    }

    /// @notice The dispute-timeout override active at the current kernel epoch, as
    ///         (exists, value). exists == false → the 30-day constant stands.
    function activeDisputeTimeout() public view returns (bool exists, uint256 value) {
        ScheduledUint256 memory a = _resolveActive(scheduledDisputeTimeout, disputeTimeoutEpochs);
        return (a.exists, a.value);
    }

    /// @notice Schedule the principal-fee rate (basis points of gross principal)
    ///         to take effect when `effectiveEpoch` opens. Admin-only (Frank's
    ///         EOA on live Base), bounded to the immutable 0–1000 bps band, and
    ///         prospective. One value per epoch; re-scheduling a taken epoch
    ///         reverts. Until an override is scheduled AND its epoch opens, the
    ///         historical 0.5% literal stands (see createEscrow).
    function scheduleFeeBps(uint64 effectiveEpoch, uint256 bps) external onlyAdmin {
        _requireScheduleEpoch(effectiveEpoch);
        if (bps > FEE_BPS_MAX) revert CostOutOfDomain(); // lower band is 0
        if (scheduledFeeBps[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledFeeBps[effectiveEpoch] = ScheduledUint256({exists: true, value: bps});
        feeBpsEpochs.push(effectiveEpoch);
        emit FeeBpsScheduled(effectiveEpoch, bps);
    }

    /// @notice Schedule the maximum PVT principal accepted into a PVT-principal
    ///         escrow, to take effect when `effectiveEpoch` opens. Admin-only,
    ///         bounded to the immutable [1 PVT, 1,000,000 PVT] band, prospective,
    ///         one value per epoch. Until an override is scheduled AND its epoch
    ///         opens, no on-chain principal cap is enforced (pre-WP5 behavior).
    function schedulePrincipalCap(uint64 effectiveEpoch, uint256 capAtomic) external onlyAdmin {
        _requireScheduleEpoch(effectiveEpoch);
        if (capAtomic < PRINCIPAL_CAP_MIN || capAtomic > PRINCIPAL_CAP_MAX) revert CostOutOfDomain();
        if (scheduledPrincipalCap[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledPrincipalCap[effectiveEpoch] = ScheduledUint256({exists: true, value: capAtomic});
        principalCapEpochs.push(effectiveEpoch);
        emit PrincipalCapScheduled(effectiveEpoch, capAtomic);
    }

    /// @notice Schedule the maximum auto-release period (seconds) — the longest
    ///         allowed `autoReleaseAt - creation` window — to take effect when
    ///         `effectiveEpoch` opens. Admin-only, bounded to the immutable
    ///         [1 hour, 90 days] band, prospective, one value per epoch. Unset →
    ///         no on-chain bound (pre-WP5: any future timestamp was accepted).
    function scheduleAutoReleasePeriod(uint64 effectiveEpoch, uint256 periodSeconds) external onlyAdmin {
        _requireScheduleEpoch(effectiveEpoch);
        if (periodSeconds < AUTO_RELEASE_PERIOD_MIN || periodSeconds > AUTO_RELEASE_PERIOD_MAX) revert CostOutOfDomain();
        if (scheduledAutoReleasePeriod[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledAutoReleasePeriod[effectiveEpoch] = ScheduledUint256({exists: true, value: periodSeconds});
        autoReleasePeriodEpochs.push(effectiveEpoch);
        emit AutoReleasePeriodScheduled(effectiveEpoch, periodSeconds);
    }

    /// @notice Schedule the maximum agreement deadline (seconds) — an independent
    ///         bound on the same `autoReleaseAt - creation` window (V4 has one
    ///         user timestamp) — to take effect when `effectiveEpoch` opens.
    ///         Admin-only, bounded to the immutable [1 hour, 90 days] band,
    ///         prospective, one value per epoch. Unset → no on-chain bound.
    function scheduleAgreementDeadline(uint64 effectiveEpoch, uint256 deadlineSeconds) external onlyAdmin {
        _requireScheduleEpoch(effectiveEpoch);
        if (deadlineSeconds < AGREEMENT_DEADLINE_MIN || deadlineSeconds > AGREEMENT_DEADLINE_MAX) revert CostOutOfDomain();
        if (scheduledAgreementDeadline[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledAgreementDeadline[effectiveEpoch] = ScheduledUint256({exists: true, value: deadlineSeconds});
        agreementDeadlineEpochs.push(effectiveEpoch);
        emit AgreementDeadlineScheduled(effectiveEpoch, deadlineSeconds);
    }

    /// @notice Schedule the dispute-resolution timeout (seconds) — the window
    ///         after which anyone may permissionlessly refund a disputed escrow's
    ///         depositor — to take effect when `effectiveEpoch` opens. Admin-only,
    ///         bounded to the immutable [2 days, 180 days] band, prospective, one
    ///         value per epoch. Until an override is scheduled AND its epoch opens,
    ///         the historical 30-day constant stands (see disputeEscrow).
    function scheduleDisputeTimeout(uint64 effectiveEpoch, uint256 timeoutSeconds) external onlyAdmin {
        _requireScheduleEpoch(effectiveEpoch);
        if (timeoutSeconds < DISPUTE_TIMEOUT_MIN || timeoutSeconds > DISPUTE_TIMEOUT_MAX) revert CostOutOfDomain();
        if (scheduledDisputeTimeout[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledDisputeTimeout[effectiveEpoch] = ScheduledUint256({exists: true, value: timeoutSeconds});
        disputeTimeoutEpochs.push(effectiveEpoch);
        emit DisputeTimeoutScheduled(effectiveEpoch, timeoutSeconds);
    }

    // =========================================================================
    // Escrow Functions
    // =========================================================================

    /**
     * @notice Create an escrow. Currency is fixed at creation.
     * @param escrowId Unique identifier.
     * @param recipient Address receiving funds on release.
     * @param amount Principal in the chosen currency's native decimals
     *               (USDC: 6 decimals; PVT: 18 decimals).
     * @param autoReleaseAt Unix timestamp after which anyone can call release.
     * @param currencyType Currency.USDC for legacy USDC-principal escrows;
     *                     Currency.PVT for PVT-principal escrows (fee burned, no discount).
     */
    function createEscrow(
        bytes32 escrowId,
        address recipient,
        uint256 amount,
        uint256 autoReleaseAt,
        Currency currencyType
    ) external {
        if (recipient == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        // WP5 escrow.pvt_principal_cap — gates PVT-principal escrows only (the
        // cap is PVT-denominated). Unset (the shipped default) → no on-chain cap,
        // matching pre-WP5 (principal was capped in the backend, not here).
        (bool capExists, uint256 capValue) = activePrincipalCap();
        if (currencyType == Currency.PVT && capExists && amount > capValue) {
            revert PrincipalCapExceeded();
        }
        if (autoReleaseAt <= block.timestamp) revert InvalidDeadline();
        // WP5 escrow.maximum_auto_release_period + escrow.maximum_agreement_deadline
        // — both bound the sole on-chain window (autoReleaseAt - now); the tighter
        // active bound wins. `releaseWindow` cannot underflow: the check above
        // guarantees autoReleaseAt > block.timestamp. Unset (shipped) → unbounded,
        // matching pre-WP5 (any future timestamp accepted; the backend bounded it).
        uint256 releaseWindow = autoReleaseAt - block.timestamp;
        (bool maxPeriodExists, uint256 maxPeriodValue) = activeAutoReleasePeriod();
        if (maxPeriodExists && releaseWindow > maxPeriodValue) {
            revert AutoReleasePeriodExceeded();
        }
        (bool maxAgreementExists, uint256 maxAgreementValue) = activeAgreementDeadline();
        if (maxAgreementExists && releaseWindow > maxAgreementValue) {
            revert AgreementDeadlineExceeded();
        }
        if (escrows[escrowId].depositor != address(0)) revert EscrowAlreadyExists();

        // Fee, denominated in the same currency as the principal. Unset (the
        // shipped default) preserves the historical 0.5% (50 bps) literal
        // byte-for-byte; once an override is scheduled and its epoch opens it
        // replaces the rate within the immutable 0–1000 bps band.
        (bool feeExists, uint256 feeValue) = activeFeeBps();
        uint256 fee = feeExists
            ? (amount * feeValue) / 10_000
            : (amount * 5) / 1000;

        escrows[escrowId] = Escrow({
            depositor: msg.sender,
            recipient: recipient,
            amount: amount,
            fee: fee,
            autoReleaseAt: autoReleaseAt,
            status: Status.Created,
            currency: currencyType,
            feePaidInPVT: false
        });

        if (currencyType == Currency.PVT) {
            emit EscrowCreatedPVT(escrowId, msg.sender, recipient, amount, fee, autoReleaseAt);
        } else {
            emit EscrowCreated(escrowId, msg.sender, recipient, amount, fee, autoReleaseAt);
        }
    }

    /**
     * @notice Fund an escrow.
     *
     *         USDC-principal:
     *           - payFeeInPVT == false: the only path. Depositor sends `amount`
     *             USDC; fee sits in contract until release.
     *           - payFeeInPVT == true:  REVERTS (PVTFeeDiscountRetired). WP13 retired
     *             the 50%-discount path because it sized a fee from a Provian-set
     *             PVT/USDC rate. Before WP13 this input was SILENTLY IGNORED whenever
     *             the rate was unset — which it was on every live deployment — so the
     *             caller was charged in USDC without being told. It now fails loudly.
     *
     *         PVT-principal:
     *           - payFeeInPVT MUST be false. The fee is intrinsically in PVT
     *             and is burned at funding time - there is no separate discount.
     *             Passing payFeeInPVT == true reverts with PVTPrincipalRejectsDiscount.
     *
     *         The parameter itself is DELIBERATELY RETAINED rather than deleted: it
     *         keeps the function selector stable for existing encoders, and it is what
     *         lets the retirement be proven by test — a caller that used to be quietly
     *         downgraded now gets an explicit refusal.
     */
    function fundEscrow(bytes32 escrowId, bool payFeeInPVT) external onlyDepositor(escrowId) {
        Escrow storage e = escrows[escrowId];
        if (e.status != Status.Created) {
            revert InvalidStatus(Status.Created, e.status);
        }

        e.status = Status.Funded;

        if (e.currency == Currency.PVT) {
            // PVT-principal: fee is intrinsically PVT, no discount path applicable.
            if (payFeeInPVT) revert PVTPrincipalRejectsDiscount();

            // Pull the full principal; burn the fee portion immediately so the
            // contract's PVT balance reflects only what is owed to the recipient.
            bool ok = pvt.transferFrom(msg.sender, address(this), e.amount);
            if (!ok) revert TransferFailed();
            pvt.burn(e.fee);

            emit EscrowFundedPVT(escrowId, e.amount, e.fee);
            return;
        }

        // USDC-principal from here. WP13: the PVT-fee discount branch is RETIRED, so a
        // caller asking for it now gets a LOUD refusal instead of the old silent
        // fallback that charged them in USDC without saying so.
        if (payFeeInPVT) revert PVTFeeDiscountRetired();

        bool usdcOk = usdc.transferFrom(msg.sender, address(this), e.amount);
        if (!usdcOk) revert TransferFailed();

        emit EscrowFunded(escrowId, e.amount);
    }

    /**
     * @notice Release a funded escrow to the recipient.
     *         Depositor can release at any time; anyone can release after autoReleaseAt.
     */
    function releaseEscrow(bytes32 escrowId) external {
        Escrow storage e = escrows[escrowId];
        if (e.status != Status.Funded) {
            revert InvalidStatus(Status.Funded, e.status);
        }

        bool isAutoRelease = false;
        if (msg.sender != e.depositor) {
            if (block.timestamp < e.autoReleaseAt) revert AutoReleaseNotReached();
            isAutoRelease = true;
        }

        e.status = Status.Completed;

        if (e.currency == Currency.PVT) {
            // Fee was burned at funding; release full remaining principal in PVT.
            uint256 principal = e.amount - e.fee;
            bool ok = pvt.transfer(e.recipient, principal);
            if (!ok) revert TransferFailed();
            emit EscrowReleasedPVT(escrowId, e.recipient, principal, isAutoRelease);
            return;
        }

        // USDC-principal. WP13: the `feePaidInPVT` branch that used to sit here is
        // GONE, not merely unreachable — with the discount retired the flag can never
        // be true, and a branch that cannot be constructed is exactly the kind of
        // untestable guard this codebase refuses to carry.
        uint256 netAmount = e.amount - e.fee;
        bool ok1 = usdc.transfer(e.recipient, netAmount);
        if (!ok1) revert TransferFailed();
        bool ok2 = usdc.transfer(feeWallet, e.fee);
        if (!ok2) revert TransferFailed();
        emit EscrowReleased(escrowId, e.recipient, netAmount, e.fee, isAutoRelease);
    }

    function disputeEscrow(bytes32 escrowId) external onlyDepositor(escrowId) {
        Escrow storage e = escrows[escrowId];
        if (e.status != Status.Funded) {
            revert InvalidStatus(Status.Funded, e.status);
        }
        if (block.timestamp >= e.autoReleaseAt) revert AutoReleaseAlreadyPassed();

        e.status = Status.Disputed;
        // Pass-3 (#4): arm the permissionless refund-to-depositor timeout so a
        // Disputed escrow can never be frozen by admin/court inaction.
        // WP5 escrow.dispute_resolution_timeout — override-else-default. Unset
        // (shipped) keeps the historical 30-day constant byte-for-byte; a
        // scheduled, epoch-activated override replaces it within [2d, 180d].
        (bool timeoutExists, uint256 timeoutValue) = activeDisputeTimeout();
        uint256 timeout = timeoutExists ? timeoutValue : DISPUTE_RESOLUTION_TIMEOUT;
        disputeDeadline[escrowId] = block.timestamp + timeout;
        emit EscrowDisputed(escrowId);
    }

    /**
     * @notice Resolve a disputed escrow. Same currency-branching as release.
     *         Callable by admin or the wired court contract.
     * @dev Pass-3 (#18): the party payout (recipient on release, depositor on
     *      refund) is settled via _payoutOrCredit, which pushes but falls back to
     *      a pull-payment credit if the party reverts/is blacklisted. This makes
     *      the release verdict un-brickable — CourtV2.castVote calls this in the
     *      same tx, and a reverting recipient must not be able to revert the vote.
     */
    function resolveDispute(bytes32 escrowId, bool releaseToRecipient) external onlyAdminOrCourt {
        Escrow storage e = escrows[escrowId];
        if (e.status != Status.Disputed) {
            revert InvalidStatus(Status.Disputed, e.status);
        }

        e.status = Status.Resolved;
        disputeSettledAt[escrowId] = block.timestamp;
        _settleResolution(escrowId, e, releaseToRecipient);
    }

    /**
     * @notice Permissionless dispute-timeout escape (Pass-3 #4). Once
     *         DISPUTE_RESOLUTION_TIMEOUT has elapsed on a Disputed escrow with no
     *         admin/court resolution, ANYONE may refund the depositor. Non-custodial:
     *         funds only ever return to the ORIGINAL depositor — the conservative,
     *         "Unknown = Block" outcome when adjudication never happened. This
     *         guarantees a disputed escrow's principal can never be frozen.
     */
    function claimDisputeTimeout(bytes32 escrowId) external {
        Escrow storage e = escrows[escrowId];
        if (e.status != Status.Disputed) {
            revert InvalidStatus(Status.Disputed, e.status);
        }
        if (block.timestamp < disputeDeadline[escrowId]) revert DisputeTimeoutNotReached();

        e.status = Status.Resolved;
        disputeSettledAt[escrowId] = block.timestamp;
        _settleResolution(escrowId, e, false); // refund the depositor
        emit EscrowDisputeTimedOut(escrowId);
    }

    /**
     * @dev Shared settlement for resolveDispute + claimDisputeTimeout. The PARTY
     *      leg is paid via _payoutOrCredit (pull-payment fallback so a reverting
     *      recipient/depositor can never revert the resolution). The feeWallet leg
     *      stays a direct push — feeWallet is a trusted Provian address and V3 fee
     *      accounting is preserved bit-for-bit.
     */
    function _settleResolution(bytes32 escrowId, Escrow storage e, bool releaseToRecipient) internal {
        address party = releaseToRecipient ? e.recipient : e.depositor;

        if (e.currency == Currency.PVT) {
            // Fee was burned at funding. Held balance = (amount - fee) PVT.
            uint256 held = e.amount - e.fee;
            _payoutOrCredit(escrowId, Currency.PVT, party, held);
            emit EscrowResolvedPVT(escrowId, releaseToRecipient);
            return;
        }

        // USDC-principal. WP13: the `feePaidInPVT` branch is gone with the discount
        // (the flag can no longer be set), leaving the single V3-identical path.
        // Dispute adjudication is "service rendered", so the USDC fee still goes to
        // feeWallet to match V3 behavior.
        uint256 netAmount = e.amount - e.fee;
        _payoutOrCredit(escrowId, Currency.USDC, party, netAmount);
        bool ok = usdc.transfer(feeWallet, e.fee);
        if (!ok) revert TransferFailed();

        emit EscrowResolved(escrowId, releaseToRecipient);
    }

    /**
     * @dev Push `amount` of `cur` to `to`; on failure (the transfer reverts OR
     *      returns false — e.g. a blacklisted/reverting recipient) credit a
     *      pull-payment slot keyed by escrowId so the caller never reverts. At
     *      most one credited payout exists per escrow (a resolution pays exactly
     *      one party). The happy path is unchanged: a normal recipient is paid in
     *      the same tx and nothing is credited.
     */
    function _payoutOrCredit(bytes32 escrowId, Currency cur, address to, uint256 amount) internal {
        if (amount == 0) return;
        bool ok;
        if (cur == Currency.PVT) {
            try pvt.transfer(to, amount) returns (bool r) { ok = r; } catch { ok = false; }
        } else {
            try usdc.transfer(to, amount) returns (bool r) { ok = r; } catch { ok = false; }
        }
        if (!ok) {
            pendingWithdrawal[escrowId] = amount;
            pendingBeneficiary[escrowId] = to;
            emit WithdrawalPending(escrowId, to, amount);
        }
    }

    /**
     * @notice Pull a credited resolution payout (Pass-3 #18). Sends to the stored
     *         beneficiary regardless of caller, so anyone can trigger the payout on
     *         the beneficiary's behalf. If the beneficiary still reverts, the whole
     *         call reverts and the credit is preserved (retryable once unblocked).
     */
    function withdrawResolvedFunds(bytes32 escrowId) external {
        uint256 amount = pendingWithdrawal[escrowId];
        if (amount == 0) revert NothingToWithdraw();
        address to = pendingBeneficiary[escrowId];
        pendingWithdrawal[escrowId] = 0; // effects before interaction

        Currency cur = escrows[escrowId].currency;
        bool ok = (cur == Currency.PVT) ? pvt.transfer(to, amount) : usdc.transfer(to, amount);
        if (!ok) revert TransferFailed();
        emit ResolvedFundsWithdrawn(escrowId, to, amount);
    }

    /**
     * @notice Escalate a disputed escrow to an arbitration panel, paying the FLAT PVT
     *         adjudication fee (D-174). Permissionless — whoever wants adjudication
     *         pays for it. The default outcome without a panel is the permissionless
     *         30-day refund to the DEPOSITOR, so in practice this is the recipient's
     *         call to make, exactly as a bond claimant pays `claimFilingFee` to file.
     *
     * @dev The fee is NON-REFUNDABLE and is routed STRAIGHT THROUGH to the Court in
     *      this same call — `transferFrom(payer -> courtContract)` never credits this
     *      contract, so no escrow-side balance, accounting or custody posture changes.
     *      The Court splits it into three equal seat shares and pays only the seats
     *      that posted AND voted, burning the rest.
     *
     *      Calling this twice reverts: the Court's `fundEscrowDisputeReward` is
     *      one-shot per escrow and its revert unwinds the whole transaction, including
     *      the transfer, so a second caller is never charged.
     *
     *      This function was previously a free no-op that only emitted
     *      `DisputeDelegatedToCourt`. The selector and that event are preserved, so the
     *      relay ABI entry (`core/agent-bank/types.ts`) stays valid; what changes is
     *      that escalation now costs something and now actually enables a panel.
     */
    function delegateToCourt(bytes32 escrowId) external {
        Escrow storage e = escrows[escrowId];
        if (e.status != Status.Disputed) {
            revert InvalidStatus(Status.Disputed, e.status);
        }
        if (courtContract == address(0)) revert CourtNotSet();

        uint256 fee = disputeAdjudicationFee();
        bool ok = pvt.transferFrom(msg.sender, courtContract, fee);
        if (!ok) revert TransferFailed();
        IArbitratorRewardSink(courtContract).fundEscrowDisputeReward(escrowId, fee);

        emit DisputeAdjudicationFeePaid(escrowId, msg.sender, fee);
        emit DisputeDelegatedToCourt(escrowId);
    }

    function cancelEscrow(bytes32 escrowId) external onlyDepositor(escrowId) {
        Escrow storage e = escrows[escrowId];
        if (e.status != Status.Created) {
            revert InvalidStatus(Status.Created, e.status);
        }
        e.status = Status.Cancelled;
        emit EscrowCancelled(escrowId);
    }

    // =========================================================================
    // Views
    // =========================================================================

    /**
     * @notice Currency of an escrow. Off-chain consumers can call this without
     *         decoding the full struct. Returns 0 for USDC, 1 for PVT.
     */
    function currency(bytes32 escrowId) external view returns (Currency) {
        Escrow storage e = escrows[escrowId];
        if (e.depositor == address(0)) revert EscrowNotFound();
        return e.currency;
    }

    /**
     * @notice Get the depositor and recipient. V3-compatible signature so the
     *         existing ProvianCourtV2 can call this contract for panel
     *         conflict-of-interest checks without changes.
     */
    function getParties(bytes32 escrowId) external view returns (address depositor, address recipient) {
        Escrow storage e = escrows[escrowId];
        return (e.depositor, e.recipient);
    }

    /**
     * @notice Contract version. Returns "v4". Constant - included so off-chain
     *         dispatch on contract version is a single call instead of an
     *         address lookup table.
     */
    function version() external pure returns (string memory) {
        return VERSION;
    }
}
