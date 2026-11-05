// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPVTBurnable} from "./interfaces/IPVTBurnable.sol";
import {IEpochClock} from "./interfaces/IEpochClock.sol";
import {IIssuanceIndex} from "./interfaces/IIssuanceIndex.sol";

/// @notice The Court side of the WP13-addendum arbitrator reward (D-168). At bond-claim
///         resolution the pool routes the claim PROCESSING FEE — the fee charged for
///         adjudicating the claim — to the Court, which pays it to the arbitrators who
///         actually adjudicated (posted AND voted) and burns the shares of seats that did
///         not. The pool never learns who voted (that state lives in the Court); it just
///         forwards the collected fee and the claim id, and the Court distributes. Guarded
///         `onlyBondPool` on the Court side. See ProvianCourtV2.fundBondClaimReward.
interface IArbitratorRewardSink {
    function fundBondClaimReward(bytes32 claimId, uint256 amount) external;
}

/// @notice D-486: the Court's view of whether a claim is under a live panel. While it
///         is, the claim's outcome belongs to the Court, which terminates every case on
///         its own (vote, permissionless finalize, or the unassembled-panel close).
interface IBondClaimCourt {
    function bondClaimCaseOpen(bytes32 claimId) external view returns (bool);
}

/**
 * @title ProvianBondPool
 * @notice Decentralized agent insurance via PVT performance bonds.
 *         Agents self-collateralize by bonding PVT. Claims are adjudicated by
 *         the Provian Court. Smart contracts slash bonds autonomously.
 *
 *         Provian Technologies does NOT custody bonded assets, does NOT adjudicate
 *         claims, does NOT guarantee payouts, and does NOT underwrite any risk.
 *         All bond collateral is held by this autonomous smart contract. Claims
 *         are adjudicated by independent Court panels. Provian Technologies
 *         charges infrastructure fees for platform access.
 *
 * @dev Constitutional Note: This is a reference implementation demonstrating one way to build
 *      on the Provian constitutional layer. It is not canonical. Agents are free to deploy
 *      alternative implementations. Human-resolving and Genesis mints use the immutable
 *      99% contributor / 0.5% Provian / 0.5% Foundation treatment. Agent-side mints without
 *      a verified human beneficiary use the applicable prospective Foundation rate and the
 *      contributor receives the residual; linked-beneficiary routing is prospective policy.
 *
 *      On the live Base Pass-3 deployment, `admin == executor ==` Frank's EOA.
 *      The ConstitutionExecutor, Foundation Safe, proposals, votes, and timelocks do not gate
 *      its parameter setters. No transferAdmin, handoff, renunciation, interposition, or
 *      no-bypass regime is authorized without separate explicit approval.
 *
 *      DESIGN INVARIANT: NO function exists that allows admin to withdraw, redirect,
 *      or drain bonded PVT. The only ways PVT leaves this contract are:
 *        1. slashBond   - Court verdict → 80% to claimant, 20% burned; the claim
 *                         PROCESSING FEE (WP13/D-168) → the ARBITRATOR PANEL via the Court
 *        2. withdrawBond - Agent withdraws their own bond
 *        3. processAbandonment - Anyone triggers after grace period → 100% burned
 *        4. dismissClaim - Court dismisses → filing fee burned; processing fee → the
 *                         ARBITRATOR PANEL via the Court (WP13/D-168)
 *        5. Fees (deposit/renewal) to provianTechWallet - infrastructure fees, not custody.
 *           The claim PROCESSING FEE used to land here too; as of WP13/D-168 it funds the
 *           panel that adjudicated the claim (posted-and-voted arbitrators, forfeited
 *           shares burned) — not an admin drain, the money leaves by rule to the workers.
 *        6. expireStaleClaim - permissionless timeout → filing fee burned
 *        7. dismissClaimUnadjudicated (WP13) - Court closes a claim whose PANEL NEVER
 *           ASSEMBLED → the claimant's OWN filing fee is returned to them. Moves no
 *           bonded collateral and pays no third party, so it is not a drain path: it
 *           is the same custodied fee going back where it came from.
 */
contract ProvianBondPool {

    // =========================================================================
    // Structs & Enums
    // =========================================================================

    enum BondStatus {
        None,       // 0
        Active,     // 1
        Withdrawn,  // 2
        Abandoned   // 3
    }

    enum ClaimStatus {
        Filed,      // 0
        Upheld,     // 1
        Dismissed   // 2
    }

    struct Bond {
        uint256 amount;            // PVT locked (97% of deposit after fees/burns)
        uint8 autonomyLevel;       // 2 or 3
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

    /// @notice D-486 migration seed: an Active bond carried from the predecessor pool,
    ///         written once in the constructor. Carried as-is (amount, level, every
    ///         timestamp, and the `requiredAtPost` grandfathering snapshot) so the bond
    ///         keeps its exact state; it carries no pending claims.
    struct BondSeed {
        address agent;
        uint256 amount;
        uint8 autonomyLevel;
        uint256 createdAt;
        uint256 lastRenewalAt;
        uint256 renewalDeadline;
        uint256 requiredAtPost;
    }

    /// @notice D-486 migration seed: a bps cost override carried from the predecessor
    ///         pool as an epoch-0 schedule, so the value in force there stays in force
    ///         here from the first epoch. `param`: 0 deposit burn, 1 deposit fee,
    ///         2 renewal burn, 3 renewal fee. Bounded exactly like its scheduler.
    struct BpsSeed {
        uint8 param;
        uint256 bps;
    }

    /// @notice A prospectively-scheduled single cost value. Mirrors ProvianPVT9's
    ///         `ScheduledUint256` and the Escrow/Promise/Pool/Court machinery.
    struct ScheduledUint256 {
        bool exists;
        uint256 value;
    }

    /// @notice A prospectively-scheduled COUPLED pair (slash burn/payout; base L2/L3),
    ///         scheduled and resolved atomically so the pairing invariant always holds.
    struct ScheduledPair {
        bool exists;
        uint256 a;
        uint256 b;
    }

    // =========================================================================
    // State
    // =========================================================================

    mapping(address => Bond) public bonds;
    mapping(bytes32 => Claim) public claims;
    mapping(bytes32 => bool) public claimExists;

    address public admin;
    address public provianTechWallet;
    IPVTBurnable public pvt;
    address public courtContract;
    bool private courtContractSet;
    address public executor;
    bool private executorSet;

    // Bounded policy base-bond requirements. PVTv5 moved these from immutable
    // constants to storage so the bond ladder can be recalibrated without a
    // contract redeploy. On live Base, `onlyExecutor` resolves directly to
    // Frank's EOA; governance/executor-contract/Safe paths are non-gating.
    // Recalibrated defaults (2026-06-20): L2 750 PVT, L3 3,000 PVT (4:1).
    uint256 public level2BaseBond = 750e18;     // was immutable LEVEL_2_BASE_BOND = 5,000
    uint256 public level3BaseBond = 3000e18;    // was immutable LEVEL_3_BASE_BOND = 20,000
    uint256 public maxBondDeposit = 7500e18;    // cap on a single bond's total deposit
    uint256 public constant MAX_TRUST_DISCOUNT = 5000;       // 50.00% in basis points

    // Bounded policy rate parameters (Frank-authorized direct setter on live Base)
    uint256 public depositBurnBps = 200;                     // 2.00%
    uint256 public depositFeeBps = 100;                      // 1.00% to Provian Tech
    uint256 public renewalBurnBps = 100;                     // 1.00%
    uint256 public renewalFeeBps = 50;                       // 0.50% to Provian Tech
    uint256 public slashBurnBps = 2000;                      // 20.00% of slash burned
    uint256 public slashPayoutBps = 8000;                    // 80.00% to claimant
    uint256 public claimsProcessingFee = 30e18;              // 30 PVT to Provian Tech (recalibrated)
    uint256 public claimFilingFee = 15e18;                   // 15 PVT filing fee (recalibrated)
    // WP13 (directive item 5) — modestly lengthened lock/renewal durations. These are
    // BASELINE literals on a FRESH deployment, not scheduled overrides: every `active*`
    // stays exists=false. Ladder MAGNITUDES (level2/level3/maxBondDeposit) are
    // deliberately untouched — raising them would worsen cold-start and raise the
    // newcomer's entry ticket, which item 5 forbids.
    //   renewalPeriod       90d -> 180d  (band [MIN_RENEWAL_PERIOD, MAX_RENEWAL_PERIOD] = [30d, 365d])
    //   renewalGracePeriod  14d ->  30d  (NO setter and NO scheduler — a redeploy is the only window)
    //   abandonmentPeriod  180d -> 365d  (band [MIN_ABANDONMENT_PERIOD, MAX_ABANDONMENT_PERIOD] = [90d, 730d])
    // Safety ordering (see the block below) IMPROVES: the abandonment horizon widens
    // from 90+14+180 = 284d to 180+30+365 = 575d, keeping CLAIM_RESOLUTION_TIMEOUT
    // (60d) well clear, so a claim can never race an abandonment burn.
    uint256 public renewalPeriod = 180 days;
    uint256 public renewalGracePeriod = 30 days;
    uint256 public abandonmentPeriod = 365 days;

    // Bounds for direct-setter policy parameters
    uint256 public constant MAX_BPS = 10000;
    uint256 public constant MAX_FEE = 1000e18;               // 1,000 PVT max fee
    uint256 public constant MAX_FILING_FEE = 500e18;          // 500 PVT max filing fee
    uint256 public constant MIN_RENEWAL_PERIOD = 30 days;
    uint256 public constant MAX_RENEWAL_PERIOD = 365 days;
    uint256 public constant MIN_ABANDONMENT_PERIOD = 90 days;
    uint256 public constant MAX_ABANDONMENT_PERIOD = 730 days;

    // Immutable bounds for the base bonds and deposit cap (introduced in PVTv5).
    // No scheduled change may move a base bond outside [MIN_BASE_BOND,
    // MAX_BASE_BOND] or set the cap below the L3 lock requirement. (The former
    // per-window velocity cap belonged to the immediate `updateX` setters, which
    // WP12 stripped from the deployed source — see the WP5-rem block below.)
    uint256 public constant MIN_BASE_BOND = 100e18;
    uint256 public constant MAX_BASE_BOND = 50000e18;
    uint256 public constant MIN_MAX_BOND_DEPOSIT = 1000e18;
    uint256 public constant MAX_MAX_BOND_DEPOSIT = 250000e18;

    // Victim-recovery floor: slashPayoutBps can never be set below this, so a
    // prevailing claimant always recovers at least half of any slash (PVTv5).
    uint256 public constant MIN_SLASH_PAYOUT_BPS = 5000;     // 50%

    // Pass-3 (audit #3, contract leg) — permissionless stale-claim escape.
    //
    //   A filed claim increments pendingClaims, and the ONLY decrements
    //   (slashBond / dismissClaim, onlyCourt) are reachable only after
    //   Court.assignBondClaimPanel — which is onlyAdmin AND needs >= 15 eligible
    //   arbitrators. Pre-launch (or under admin inaction / lost-key / malice) the
    //   panel can never form, so withdrawBond reverts ClaimsPending forever and up
    //   to maxBondDeposit of the respondent's own collateral is permanently frozen,
    //   cheaply griefable for the filing fee.
    //
    //   Fix: after CLAIM_RESOLUTION_TIMEOUT with the claim still Filed (never
    //   adjudicated), ANYONE may permissionlessly expire it — the agent-favorable,
    //   no-slash outcome. This is a pure liveness backstop: it can ONLY dismiss,
    //   never slash, and needs no privileged key, so it cannot be blocked by a
    //   missing/hostile admin. 60 days is >> the Court's 48h vote window (a real
    //   panel, once assigned, resolves via finalizeBondClaim ~48h in), and well
    //   under the 180-day abandonment period, so it never races a live adjudication
    //   and clears the freeze before the bond could be abandonment-burned. The
    //   filing fee is burned (same frivolous-claim deterrent as dismissClaim; no
    //   external transfer, so a blacklisted/reverting claimant can never brick the
    //   escape).
    uint256 public constant CLAIM_RESOLUTION_TIMEOUT = 60 days;

    // =========================================================================
    // WP5-rem — Bond-native cost parameters (conversion-free, PVT-native)
    //
    // An ADDITIVE, kernel-clock-bound, prospective-epoch OVERLAY on the settable
    // bond cost parameters, mirroring the merged Escrow/Promise/Pool/Court machinery
    // (ScheduledUint256 + _requireScheduleEpoch + PolicyAlreadyScheduled + forward-
    // fill _resolveActive). Each `activeX()` resolves the scheduled override active
    // at the kernel epoch, ELSE the existing storage variable / constant — so with
    // NOTHING scheduled (the shipped state) every lifecycle function reads exactly
    // the pre-WP5 value and behaves byte-for-byte as before (proven by the unchanged
    // ProvianBondPool / fork suites).
    //
    // WP12 / D-018 launch gate — RESOLVED BY STRIP. The eleven pre-existing
    // immediate `updateX` (onlyExecutor) setters, their velocity caps, and the
    // BOND_PARAM_WINDOW were the pre-launch baseline-recalibration path; they are
    // REMOVED from the deployed PVT9-era source, so `scheduleX` below is the ONLY
    // way any bond cost parameter can ever move. A scheduled change cannot take
    // effect for at least one kernel epoch and never reprices an already-posted
    // bond, so it needs no velocity cap (the immutable [min,max] bands bound
    // magnitude; prospectivity bounds timing). This mirrors the schedule-only
    // Escrow/Promise/Pool/Court shape exactly. Constructor-set baselines stand
    // until a schedule activates; no value is scheduled at deploy.
    //
    // Immutable min/max bands mirror the frozen proposal catalog exactly. No economic
    // value is set here; a value is Frank's separate approval. Authority is unchanged:
    // the scheduleX setters are onlyExecutor (Frank's EOA on live Base), identical to
    // the immediate setters.
    // =========================================================================

    /// @notice Immutable epoch clock — the ProvianPVT9 kernel on live Base. Bound once
    ///         at construction: no setter, so it adds no new settable-address authority.
    IEpochClock public immutable epochClock;

    // =========================================================================
    // WP13 — Issuance-indexed FLOORS on the PVT-denominated cost parameters
    //
    // Every PVT-denominated bond requirement resolves as
    //   max(existing baseline literal-or-override, ppm x trailing-12-epoch average issuance)
    // so a requirement priced in PVT keeps its real weight as the economy grows,
    // instead of silently melting toward zero. The index is READ ONLY (a `view` on
    // the kernel) and can never mint, burn, or move a token.
    //
    // DIRECTION — this is a MINIMUM on a COST, never a maximum on anything, and
    // never a lever on issuance or on anyone's earned balance. A thin or absent
    // index can only leave the historical literal standing.
    //
    // NO RETROACTIVE REVALUATION — requirements bind at the epoch a bond is POSTED
    // (`requiredAtPost` below). A rising floor never re-rates, tops up, or
    // downgrades an existing bond; it applies to bonds posted after it moves.
    //
    // FAIL-CLOSED — an unarmed or unreachable kernel resolves the index to 0, so
    // every floor is inert and the baseline stands (`_trailingIssuance`).
    //
    // DENOMINATOR IS 1e6 (ppm), not bps: the anchors below are not expressible in
    // basis points (level2 would be 0.75 bps). Each ppm ratio is chosen so that at
    // the kernel's launch ceiling — INITIAL_COMBINED_EPOCH_CAP, 10,000,000 PVT per
    // epoch, verified on live Base — the floor equals TODAY'S literal exactly:
    //   level2        75 ppm x 1e25 = 7.5e20 =   750 PVT  == level2BaseBond
    //   level3       300 ppm x 1e25 = 3.0e21 = 3,000 PVT  == level3BaseBond
    //   maxDeposit   750 ppm x 1e25 = 7.5e21 = 7,500 PVT  == maxBondDeposit
    //   processing     3 ppm x 1e25 = 3.0e19 =    30 PVT  == claimsProcessingFee
    // The filing fee's exact anchor (1.5 ppm) is not an integer under 1e6, so it is
    // DERIVED as half the processing-fee floor — exact, integer-safe, and it holds
    // the 2:1 processing:filing relationship the literals already encode.
    // =========================================================================

    /// @notice Immutable issuance index — the same ProvianPVT9 kernel on live Base,
    ///         read through the narrow `IIssuanceIndex` surface. Bound once at
    ///         construction: no setter, so it adds no new settable-address authority.
    IIssuanceIndex public immutable issuanceIndex;

    /// @notice Parts-per-million of trailing average issuance used to FLOOR each
    ///         PVT-denominated requirement. Immutable: the floor's SHAPE is fixed,
    ///         while its baseline stays schedulable through the existing machinery.
    uint256 public constant INDEX_PPM_DENOMINATOR = 1_000_000;
    uint256 public constant LEVEL2_BOND_INDEX_PPM = 75;
    uint256 public constant LEVEL3_BOND_INDEX_PPM = 300;
    uint256 public constant MAX_DEPOSIT_INDEX_PPM = 750;
    uint256 public constant CLAIMS_PROCESSING_FEE_INDEX_PPM = 3;

    /// @notice The UNDISCOUNTED base lock a bond was required to hold at the epoch it
    ///         was POSTED — the grandfathering snapshot. `slashBond`'s autonomy-downgrade
    ///         threshold and `topUpBond`'s ceiling read THIS, never a live re-derivation,
    ///         so a floor that rises after a bond is posted can never retroactively mark
    ///         that bond unhealthy or shrink its top-up headroom.
    ///
    ///         Deliberately a SEPARATE mapping rather than an eighth `Bond` field: the
    ///         `bonds(address)` public getter's 7-tuple shape is consumed by the Court
    ///         (`IProvianBondPool.bonds`), by the backend's two declared ABIs, and by
    ///         ~20 test destructurings. Appending to the struct would break all of them
    ///         for no semantic gain. This is purely additive.
    mapping(address => uint256) public requiredAtPost;

    // Immutable bps ceilings for the scheduled bps overrides (lower band 0). These
    // MIRROR the inline literals the existing immediate setters already enforce and
    // the frozen catalog's declared ranges.
    uint256 public constant BOND_DEPOSIT_BURN_BPS_MAX = 1_000; // deposit_burn 0–1000
    uint256 public constant BOND_DEPOSIT_FEE_BPS_MAX = 500;    // deposit_protocol_fee 0–500
    uint256 public constant BOND_RENEWAL_BURN_BPS_MAX = 500;   // renewal_burn 0–500
    uint256 public constant BOND_RENEWAL_FEE_BPS_MAX = 250;    // renewal_protocol_fee 0–250

    // --- single-value scheduled overrides (activeX() else the storage var) ---
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

    // --- coupled scheduled overrides (invariant preserved atomically) ---
    /// @notice Slash burn (a) + payout (b) shares. Invariant: a+b == MAX_BPS and
    ///         b >= MIN_SLASH_PAYOUT_BPS (so a is in [0, 5000]).
    mapping(uint64 => ScheduledPair) public scheduledSlashShares;
    uint64[] public slashSharesEpochs;
    /// @notice Base bonds L2 (a) + L3 (b). Invariant: both in [MIN_BASE_BOND,
    ///         MAX_BASE_BOND] and b >= a.
    mapping(uint64 => ScheduledPair) public scheduledBaseBonds;
    uint64[] public baseBondsEpochs;

    // =========================================================================
    // Events
    // =========================================================================

    event BondPosted(address indexed agent, uint256 totalDeposit, uint256 lockedAmount, uint8 autonomyLevel);
    event BondRenewed(address indexed agent, uint256 newDeadline);
    event BondToppedUp(address indexed agent, uint256 amount, uint256 newBondAmount);
    event BondSlashed(address indexed agent, bytes32 indexed claimId, address indexed claimant, uint256 claimantAmount, uint256 burnedAmount);
    event BondWithdrawn(address indexed agent, uint256 returnedAmount);
    event ClaimFiled(bytes32 indexed claimId, address indexed claimant, address indexed agent);
    event ClaimDismissed(bytes32 indexed claimId, address indexed agent);
    // Pass-3 (#3): a stale, never-adjudicated claim was permissionlessly expired.
    event ClaimExpired(bytes32 indexed claimId, address indexed agent);
    // WP13: a claim closed because its PANEL NEVER ASSEMBLED — filing fee refunded.
    event ClaimClosedUnadjudicated(
        bytes32 indexed claimId, address indexed agent, address indexed claimant, uint256 refundedFee
    );
    event BondAbandoned(address indexed agent, uint256 burnedAmount);
    /// @notice D-486: a bond carried from the predecessor pool at construction. Distinct
    ///         from BondPosted so no watcher reads the carry as a new deposit.
    event BondCarried(address indexed agent, uint256 lockedAmount, uint8 autonomyLevel, uint256 renewalDeadline);
    event AutonomyDowngrade(address indexed agent, uint256 remainingBond, uint256 requiredBond);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);
    event CourtContractSet(address indexed court);
    event ExecutorWired(address indexed governance);

    // WP5-rem prospective cost-parameter machinery
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

    // =========================================================================
    // Errors
    // =========================================================================

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
    // WP5-rem prospective cost-parameter machinery
    error PolicyNotProspective();
    error PolicyAlreadyScheduled();
    error CostOutOfDomain();
    // D-486
    error ClaimUnderAdjudication();
    error InvalidSeed();

    // =========================================================================
    // Modifiers
    // =========================================================================

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

    // =========================================================================
    // Constructor
    // =========================================================================

    /// @param seedBonds D-486: Active bonds carried from the predecessor pool. The PVT
    ///        backing them arrives by the migration distribution, not here; until it
    ///        does, any exit reverts on the token's insufficient balance (fails closed).
    /// @param seedBps D-486: bps overrides in force on the predecessor, carried as
    ///        epoch-0 schedules. Both arrays are empty on a fresh deployment.
    constructor(
        address _admin,
        address _provianTechWallet,
        address _pvt,
        address _epochClock,
        address _issuanceIndex,
        BondSeed[] memory seedBonds,
        BpsSeed[] memory seedBps
    ) {
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

        for (uint256 i = 0; i < seedBonds.length; ++i) {
            BondSeed memory s = seedBonds[i];
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
            emit BondCarried(s.agent, s.amount, s.autonomyLevel, s.renewalDeadline);
        }
        for (uint256 i = 0; i < seedBps.length; ++i) {
            _seedBpsSchedule(seedBps[i].param, seedBps[i].bps);
        }
    }

    /// @dev Write one carried bps override as an epoch-0 schedule, under the same
    ///      bounds and one-shot rule as its scheduler. Constructor-only.
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

    // =========================================================================
    // WP5-rem — Cost-parameter epoch machinery (kernel-clock-bound)
    //
    // The activation clock is ProvianPVT9.currentEpoch() via `epochClock`. A
    // scheduled value for epoch E is resolved lazily at read time as "the value at
    // the greatest scheduled epoch <= currentEpoch()" (forward-fill). No local
    // counter, no permissionless epoch-advance. Identical in shape to the merged
    // Escrow/Promise/Pool/Court machinery.
    // =========================================================================

    /// @notice The current activation epoch, from the immutable kernel clock. Fails
    ///         CLOSED to 0 if the kernel is unarmed / has not started, so every
    ///         override is inert and the existing storage value / constant stands.
    function _currentEpoch() internal view returns (uint64) {
        try epochClock.currentEpoch() returns (uint64 e) {
            return e;
        } catch {
            return 0;
        }
    }

    /// @notice The earliest epoch a schedule may target: the epoch after the current one.
    function earliestSchedulableEpoch() public view returns (uint64) {
        return _currentEpoch() + 1;
    }

    /// @dev Prospectivity guard for every scheduler.
    function _requireScheduleEpoch(uint64 effectiveEpoch) private view {
        if (effectiveEpoch <= _currentEpoch()) revert PolicyNotProspective();
    }

    /// @notice The trailing-12-epoch average issuance measured by the kernel, or 0 when
    ///         there is no measurement yet. Fails CLOSED exactly like `_currentEpoch`:
    ///         an unarmed, reverting, or pre-window kernel yields 0, which makes every
    ///         index floor inert so the baseline literal/override stands. A read can
    ///         never mint, burn, or move a token — `trailingAverageForEpoch` is `view`.
    function _trailingIssuance() internal view returns (uint256) {
        try issuanceIndex.trailingAverageForEpoch(_currentEpoch()) returns (uint256 avg) {
            return avg;
        } catch {
            return 0;
        }
    }

    /// @dev The floor rule, in one place: `max(baseline, ppm x average / 1e6)`.
    ///      Because it is a MAX against the baseline, it can only ever RAISE a cost
    ///      parameter above its literal and never lower one — and with a zero index
    ///      it returns the baseline byte-for-byte.
    function _indexFloor(uint256 baseline, uint256 ppm, uint256 avg) internal pure returns (uint256) {
        uint256 fromIndex = (ppm * avg) / INDEX_PPM_DENOMINATOR;
        return fromIndex > baseline ? fromIndex : baseline;
    }

    /// @notice The issuance-indexed floors resolved at the CURRENT epoch, for operators
    ///         and tests: the effective L2 / L3 base bonds, single-deposit cap,
    ///         claims-processing fee and claim-filing fee, each already max'd against
    ///         its baseline. With a thin index every value equals its literal.
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

    /// @dev Resolve a single-value override at the current kernel epoch: the value at
    ///      the greatest scheduled epoch <= currentEpoch(), else unset.
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

    /// @dev Resolve a coupled pair override (same forward-fill rule).
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

    // --- active getters ((exists, value); coupled ones (exists, a, b)) ---

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

    // --- effective-value helpers (override-else-storage) read by the lifecycle ---

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

    /// @dev WP13: override-else-storage, then FLOORED by the issuance index.
    function _effClaimsProcessingFee() internal view returns (uint256) {
        (bool e, uint256 v) = activeClaimsProcessingFee();
        return _indexFloor(e ? v : claimsProcessingFee, CLAIMS_PROCESSING_FEE_INDEX_PPM, _trailingIssuance());
    }

    /// @dev WP13: the filing fee's floor is DERIVED as half the processing-fee floor.
    ///      Its exact anchor (1.5 ppm) is not an integer under a 1e6 denominator, so
    ///      halving the processing floor keeps it exact and integer-safe, and preserves
    ///      the 2:1 processing:filing relationship the literals already encode
    ///      (30 PVT : 15 PVT). Still a MAX against the baseline, so it can only rise.
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

    /// @dev WP13: override-else-storage, floored by the index AND held at or above the
    ///      effective L3 lock. The joint bound is load-bearing: `postBond` rejects a
    ///      deposit above this cap, so a cap that floored independently of L3 could
    ///      leave an L3 bond unpostable. (At the anchored ratios the cap's floor is
    ///      already 2.5x L3's, so the L3 clamp is a belt-and-braces guard against a
    ///      scheduled override, never the binding term in the shipped configuration.)
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

    /// @dev WP13: override-else-storage, then each rung FLOORED by the issuance index at
    ///      its own anchored ratio. Resolved from ONE `_trailingIssuance()` read so a
    ///      single call cannot see two different averages, and so the pair stays ordered
    ///      (L3's ppm is 4x L2's, matching the 4:1 ladder the literals encode).
    function _effBaseBonds() internal view returns (uint256 level2, uint256 level3) {
        (bool e, uint256 a, uint256 b) = activeBaseBonds();
        (uint256 baseL2, uint256 baseL3) = e ? (a, b) : (level2BaseBond, level3BaseBond);
        uint256 avg = _trailingIssuance();
        return (
            _indexFloor(baseL2, LEVEL2_BOND_INDEX_PPM, avg),
            _indexFloor(baseL3, LEVEL3_BOND_INDEX_PPM, avg)
        );
    }

    // --- prospective schedulers (onlyExecutor; Frank's EOA on live Base) ---

    function scheduleDepositBurnBps(uint64 effectiveEpoch, uint256 bps) external onlyExecutor {
        _requireScheduleEpoch(effectiveEpoch);
        if (bps > BOND_DEPOSIT_BURN_BPS_MAX) revert CostOutOfDomain();
        if (scheduledDepositBurnBps[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledDepositBurnBps[effectiveEpoch] = ScheduledUint256({exists: true, value: bps});
        depositBurnBpsEpochs.push(effectiveEpoch);
        emit DepositBurnBpsScheduled(effectiveEpoch, bps);
    }

    function scheduleDepositFeeBps(uint64 effectiveEpoch, uint256 bps) external onlyExecutor {
        _requireScheduleEpoch(effectiveEpoch);
        if (bps > BOND_DEPOSIT_FEE_BPS_MAX) revert CostOutOfDomain();
        if (scheduledDepositFeeBps[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledDepositFeeBps[effectiveEpoch] = ScheduledUint256({exists: true, value: bps});
        depositFeeBpsEpochs.push(effectiveEpoch);
        emit DepositFeeBpsScheduled(effectiveEpoch, bps);
    }

    function scheduleRenewalBurnBps(uint64 effectiveEpoch, uint256 bps) external onlyExecutor {
        _requireScheduleEpoch(effectiveEpoch);
        if (bps > BOND_RENEWAL_BURN_BPS_MAX) revert CostOutOfDomain();
        if (scheduledRenewalBurnBps[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledRenewalBurnBps[effectiveEpoch] = ScheduledUint256({exists: true, value: bps});
        renewalBurnBpsEpochs.push(effectiveEpoch);
        emit RenewalBurnBpsScheduled(effectiveEpoch, bps);
    }

    function scheduleRenewalFeeBps(uint64 effectiveEpoch, uint256 bps) external onlyExecutor {
        _requireScheduleEpoch(effectiveEpoch);
        if (bps > BOND_RENEWAL_FEE_BPS_MAX) revert CostOutOfDomain();
        if (scheduledRenewalFeeBps[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledRenewalFeeBps[effectiveEpoch] = ScheduledUint256({exists: true, value: bps});
        renewalFeeBpsEpochs.push(effectiveEpoch);
        emit RenewalFeeBpsScheduled(effectiveEpoch, bps);
    }

    /// @notice Schedule the slash burn/payout shares (coupled). Preserves the same
    ///         invariants as updateSlashBps: burn + payout == MAX_BPS and payout >=
    ///         MIN_SLASH_PAYOUT_BPS (so burn lands in [0, 5000]).
    function scheduleSlashShares(uint64 effectiveEpoch, uint256 burnBps, uint256 payoutBps) external onlyExecutor {
        _requireScheduleEpoch(effectiveEpoch);
        if (burnBps + payoutBps != MAX_BPS) revert SlashBpsInvariant();
        if (payoutBps < MIN_SLASH_PAYOUT_BPS) revert SlashPayoutBelowFloor();
        if (scheduledSlashShares[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledSlashShares[effectiveEpoch] = ScheduledPair({exists: true, a: burnBps, b: payoutBps});
        slashSharesEpochs.push(effectiveEpoch);
        emit SlashSharesScheduled(effectiveEpoch, burnBps, payoutBps);
    }

    function scheduleClaimsProcessingFee(uint64 effectiveEpoch, uint256 feeAtomic) external onlyExecutor {
        _requireScheduleEpoch(effectiveEpoch);
        if (feeAtomic > MAX_FEE) revert CostOutOfDomain(); // lower band 0
        if (scheduledClaimsProcessingFee[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledClaimsProcessingFee[effectiveEpoch] = ScheduledUint256({exists: true, value: feeAtomic});
        claimsProcessingFeeEpochs.push(effectiveEpoch);
        emit ClaimsProcessingFeeScheduled(effectiveEpoch, feeAtomic);
    }

    function scheduleClaimFilingFee(uint64 effectiveEpoch, uint256 feeAtomic) external onlyExecutor {
        _requireScheduleEpoch(effectiveEpoch);
        if (feeAtomic > MAX_FILING_FEE) revert CostOutOfDomain(); // lower band 0
        if (scheduledClaimFilingFee[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledClaimFilingFee[effectiveEpoch] = ScheduledUint256({exists: true, value: feeAtomic});
        claimFilingFeeEpochs.push(effectiveEpoch);
        emit ClaimFilingFeeScheduled(effectiveEpoch, feeAtomic);
    }

    function scheduleRenewalPeriod(uint64 effectiveEpoch, uint256 periodSeconds) external onlyExecutor {
        _requireScheduleEpoch(effectiveEpoch);
        if (periodSeconds < MIN_RENEWAL_PERIOD || periodSeconds > MAX_RENEWAL_PERIOD) revert CostOutOfDomain();
        if (scheduledRenewalPeriod[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledRenewalPeriod[effectiveEpoch] = ScheduledUint256({exists: true, value: periodSeconds});
        renewalPeriodEpochs.push(effectiveEpoch);
        emit RenewalPeriodScheduled(effectiveEpoch, periodSeconds);
    }

    function scheduleAbandonmentPeriod(uint64 effectiveEpoch, uint256 periodSeconds) external onlyExecutor {
        _requireScheduleEpoch(effectiveEpoch);
        if (periodSeconds < MIN_ABANDONMENT_PERIOD || periodSeconds > MAX_ABANDONMENT_PERIOD) revert CostOutOfDomain();
        if (scheduledAbandonmentPeriod[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledAbandonmentPeriod[effectiveEpoch] = ScheduledUint256({exists: true, value: periodSeconds});
        abandonmentPeriodEpochs.push(effectiveEpoch);
        emit AbandonmentPeriodScheduled(effectiveEpoch, periodSeconds);
    }

    /// @notice Schedule the base bond ladder (coupled). Preserves updateBaseBonds's
    ///         structural bounds: both in [MIN_BASE_BOND, MAX_BASE_BOND] and L3 >= L2.
    ///         (Velocity/window rate-limiting is the immediate setter's concern; a
    ///         scheduled change is prospective and never reprices a posted bond.)
    function scheduleBaseBonds(uint64 effectiveEpoch, uint256 newLevel2, uint256 newLevel3) external onlyExecutor {
        _requireScheduleEpoch(effectiveEpoch);
        if (newLevel2 < MIN_BASE_BOND || newLevel2 > MAX_BASE_BOND) revert BaseBondOutOfBounds();
        if (newLevel3 < MIN_BASE_BOND || newLevel3 > MAX_BASE_BOND) revert BaseBondOutOfBounds();
        if (newLevel3 < newLevel2) revert BaseBondOutOfBounds();
        if (scheduledBaseBonds[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledBaseBonds[effectiveEpoch] = ScheduledPair({exists: true, a: newLevel2, b: newLevel3});
        baseBondsEpochs.push(effectiveEpoch);
        emit BaseBondsScheduled(effectiveEpoch, newLevel2, newLevel3);
    }

    /// @notice Schedule the single-deposit cap. Bounded to [MIN_MAX_BOND_DEPOSIT,
    ///         MAX_MAX_BOND_DEPOSIT] and never below the CURRENTLY-EFFECTIVE L3 lock,
    ///         so an L3 bond can always be posted (matches updateMaxBondDeposit's
    ///         `newMax >= level3BaseBond` invariant, resolved against the effective L3).
    function scheduleMaxBondDeposit(uint64 effectiveEpoch, uint256 newMax) external onlyExecutor {
        _requireScheduleEpoch(effectiveEpoch);
        if (newMax < MIN_MAX_BOND_DEPOSIT || newMax > MAX_MAX_BOND_DEPOSIT) revert CostOutOfDomain();
        (, uint256 effL3) = _effBaseBonds();
        if (newMax < effL3) revert ParameterOutOfBounds();
        if (scheduledMaxBondDeposit[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledMaxBondDeposit[effectiveEpoch] = ScheduledUint256({exists: true, value: newMax});
        maxBondDepositEpochs.push(effectiveEpoch);
        emit MaxBondDepositScheduled(effectiveEpoch, newMax);
    }

    // =========================================================================
    // Bond Operations
    // =========================================================================

    /**
     * @notice Post a PVT performance bond to enable Level 2 or 3 autonomy.
     * @dev Agent must approve this contract to transfer PVT before calling.
     *      2% of deposit is burned, 1% goes to Provian Tech, 97% locked.
     * @param autonomyLevel 2 (auto-approve under threshold) or 3 (full autonomy)
     * @param trustDiscountBps Trust-based discount in basis points (max 5000 = 50%)
     */
    function postBond(uint8 autonomyLevel, uint256 trustDiscountBps) external {
        if (autonomyLevel != 2 && autonomyLevel != 3) revert InvalidAutonomyLevel();
        if (trustDiscountBps > MAX_TRUST_DISCOUNT) revert InvalidTrustDiscount();
        if (bonds[msg.sender].status == BondStatus.Active) revert BondAlreadyExists();
        // D-486 fix 3: a new bond starts from zero pending claims, so no claim may still
        // be pending against this agent's previous bond. processAbandonment now refuses
        // while claims are pending; this is the matching guard at the other end.
        if (bonds[msg.sender].pendingClaims != 0) revert ClaimsPending();

        uint256 requiredBond = getRequiredBond(autonomyLevel, trustDiscountBps);
        // WP5-rem: resolve deposit shares + cap through their prospective overrides
        // (else the storage vars). Unset (shipped) → burn 200 / fee 100 bps, cap 7500 PVT.
        uint256 effDepositBurn = _effDepositBurnBps();
        uint256 effDepositFee = _effDepositFeeBps();
        // Compute total deposit: requiredBond is the locked amount (97%)
        // totalDeposit = requiredBond * 10000 / (10000 - depositBurnBps - depositFeeBps)
        uint256 depositRemainingBps = MAX_BPS - effDepositBurn - effDepositFee;
        uint256 totalDeposit = (requiredBond * MAX_BPS + depositRemainingBps - 1) / depositRemainingBps;

        if (totalDeposit == 0) revert InvalidAmount();
        if (totalDeposit > _effMaxBondDeposit()) revert DepositExceedsCap();

        // Transfer total PVT from agent to this contract
        bool ok = pvt.transferFrom(msg.sender, address(this), totalDeposit);
        if (!ok) revert TransferFailed();

        // Calculate fee splits
        uint256 burnAmount = (totalDeposit * effDepositBurn) / MAX_BPS;
        uint256 feeAmount = (totalDeposit * effDepositFee) / MAX_BPS;
        uint256 lockedAmount = totalDeposit - burnAmount - feeAmount;

        // Burn the burn portion from this contract's own balance (burn() self-burns
        // msg.sender's balance; ungated, no protocol-contract registration required)
        pvt.burn(burnAmount);

        // Infrastructure fee to Provian Tech
        bool feeOk = pvt.transfer(provianTechWallet, feeAmount);
        if (!feeOk) revert TransferFailed();

        // Create bond
        bonds[msg.sender] = Bond({
            amount: lockedAmount,
            autonomyLevel: autonomyLevel,
            createdAt: block.timestamp,
            lastRenewalAt: block.timestamp,
            renewalDeadline: block.timestamp + _effRenewalPeriod(),
            status: BondStatus.Active,
            pendingClaims: 0
        });

        // WP13 GRANDFATHERING — snapshot the UNDISCOUNTED base lock this bond was
        // required to hold AT THIS EPOCH. `slashBond`'s downgrade threshold and
        // `topUpBond`'s ceiling read this snapshot forever after, so a later rise in
        // the indexed floor can never retroactively mark this bond unhealthy or
        // shrink its headroom. Requirements bind at the epoch of posting.
        requiredAtPost[msg.sender] = getRequiredBond(autonomyLevel, 0);

        emit BondPosted(msg.sender, totalDeposit, lockedAmount, autonomyLevel);
    }

    /**
     * @notice Renew an active bond. Burns 1%, sends 0.5% to Provian Tech.
     *         Extends renewal deadline by one renewal period.
     */
    function renewBond() external {
        Bond storage bond = bonds[msg.sender];
        if (bond.status != BondStatus.Active) revert BondNotActive();

        // WP5-rem: resolve renewal burn/fee/period through their prospective overrides
        // (else the storage vars). Unset (shipped) → burn 100 / fee 50 bps, 90-day period.
        uint256 burnAmount = (bond.amount * _effRenewalBurnBps()) / MAX_BPS;
        uint256 feeAmount = (bond.amount * _effRenewalFeeBps()) / MAX_BPS;
        uint256 totalCost = burnAmount + feeAmount;

        if (bond.amount <= totalCost) revert InsufficientBond();

        bond.amount -= totalCost;

        // Burn
        pvt.burn(burnAmount);

        // Fee to Provian Tech
        bool feeOk = pvt.transfer(provianTechWallet, feeAmount);
        if (!feeOk) revert TransferFailed();

        bond.lastRenewalAt = block.timestamp;
        bond.renewalDeadline = block.timestamp + _effRenewalPeriod();

        emit BondRenewed(msg.sender, bond.renewalDeadline);
    }

    /**
     * @notice Top up an active bond's slashable collateral (WP8).
     *
     *         Renewal fees and partial slashes erode `bond.amount` below the
     *         level's base lock requirement (the `AutonomyDowngrade` condition).
     *         This is the explicit shortfall-restore path described by the frozen
     *         cost-catalog row `bond.top_up_collateral_shortfall`:
     *
     *           - NO burn and NO fee: 100% of the transferred PVT becomes
     *             slashable collateral ("all_top_up_pvt_becomes_slashable_
     *             collateral") — no new economic parameter is introduced.
     *           - Bounded by the SHORTFALL against the level's undiscounted base
     *             lock (`max(0, requiredLock - currentCollateral)`), so a top-up
     *             can restore a bond to its requirement but never build an
     *             arbitrary buffer above it. The base lock is <= the max-deposit
     *             cap by standing invariant, so the deposit ceiling is implied.
     *           - Active bonds only. Top-up does not touch the renewal deadline;
     *             reinstating an expired-side lifecycle is renewBond's job.
     *
     *         Exit lifecycle is unchanged: topped-up PVT is withdrawable only via
     *         withdrawBond and slashable only via a Court verdict (slashBond) or
     *         abandonment burn — no new exit path, no custody change.
     * @param amount PVT (atomic) to add to the bond's locked collateral.
     */
    function topUpBond(uint256 amount) external {
        Bond storage bond = bonds[msg.sender];
        if (bond.status != BondStatus.Active) revert BondNotActive();
        if (amount == 0) revert InvalidAmount();

        // Shortfall bound: never above the level's undiscounted base lock AS OF THE
        // EPOCH THIS BOND WAS POSTED (the same grandfathered reference slashBond uses
        // for the AutonomyDowngrade threshold). WP13: read the `requiredAtPost`
        // snapshot, NEVER a live re-derivation — a floor that rose after posting must
        // not silently enlarge this bond's top-up obligation.
        uint256 requiredLock = requiredAtPost[msg.sender];
        if (bond.amount + amount > requiredLock) revert TopUpExceedsRequirement();

        bool ok = pvt.transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();

        bond.amount += amount;

        emit BondToppedUp(msg.sender, amount, bond.amount);
    }

    /**
     * @notice Withdraw an active bond. Returns remaining PVT to the agent.
     *         Blocked if there are pending claims.
     */
    function withdrawBond() external {
        Bond storage bond = bonds[msg.sender];
        if (bond.status != BondStatus.Active) revert BondNotActive();
        if (bond.pendingClaims > 0) revert ClaimsPending();

        uint256 returnAmount = bond.amount;
        bond.amount = 0;
        bond.status = BondStatus.Withdrawn;

        bool ok = pvt.transfer(msg.sender, returnAmount);
        if (!ok) revert TransferFailed();

        emit BondWithdrawn(msg.sender, returnAmount);
    }

    // =========================================================================
    // Claims
    // =========================================================================

    /**
     * @notice File a claim against an agent's bond.
     * @dev Claimant deposits a filing fee (50 PVT). Returned if claim upheld, burned if dismissed.
     *      Self-claims are blocked (agent cannot file against their own bond).
     * @param agent The bonded agent to file against
     * @param claimId Unique claim identifier (generated off-chain)
     */
    function fileClaim(address agent, bytes32 claimId) external {
        if (msg.sender == agent) revert SelfClaimNotAllowed();
        if (claimExists[claimId]) revert ClaimAlreadyExists();
        if (bonds[agent].status != BondStatus.Active) revert BondNotActive();

        // WP5-rem: resolve the filing fee through its prospective override (else the
        // storage var). Unset (shipped) → 15 PVT. Snapshotted into the claim so the
        // amount returned/burned later is exactly what was charged.
        uint256 effFilingFee = _effClaimFilingFee();
        // Transfer filing fee from claimant
        bool ok = pvt.transferFrom(msg.sender, address(this), effFilingFee);
        if (!ok) revert TransferFailed();

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

    /**
     * @notice Court slashes a bond after finding the agent at fault.
     *         80% of slashed amount to claimant, 20% burned.
     *         100 PVT processing fee to Provian Tech.
     *         Filing fee returned to claimant.
     * @dev Only callable by the Court contract.
     * @param agent The bonded agent
     * @param slashAmount Total PVT to slash from the bond
     * @param claimId The claim being resolved
     */
    function slashBond(
        address agent,
        uint256 slashAmount,
        bytes32 claimId
    ) external onlyCourt {
        Bond storage bond = bonds[agent];
        if (bond.status != BondStatus.Active) revert BondNotActive();

        Claim storage claim = claims[claimId];
        if (!claimExists[claimId]) revert ClaimNotFound();
        if (claim.status != ClaimStatus.Filed) revert ClaimAlreadyResolved();
        if (claim.agent != agent) revert InvalidAddress();

        // WS1 (Pass-2) fail-closed slash bound. The Court bridges a 2-of-3 panel
        // verdict to a CONCRETE slash amount: a `partial` verdict maps to
        // MIN_SLASH_PAYOUT_BPS (50%) of the bonded collateral, a `full` verdict to
        // the entire bond. REJECT any amount outside [floor, cap] rather than the
        // old silent clamp, so a malformed or hostile `slashAmount` can never
        // under-slash (below the partial floor) or over-slash (above the bond) —
        // invariant #14 / Court bounds. The `amount` param is preserved so future
        // graduated slashing within this band stays possible without a redeploy.
        // floor = 50% of the bond; cap = the full bond. (When a prior claim has
        // already drained an Active bond to 0, floor == cap == 0 and only a 0
        // amount resolves the residual claim — harmless, still decrements.)
        uint256 slashFloor = (bond.amount * MIN_SLASH_PAYOUT_BPS) / MAX_BPS;
        if (slashAmount < slashFloor || slashAmount > bond.amount) {
            revert SlashAmountOutOfBounds();
        }
        uint256 actualSlash = slashAmount;

        // Split: payout to claimant, remainder burned. WP5-rem: resolve the shares
        // through the prospective override (else the storage vars). Unset (shipped) →
        // 80% payout / 20% burn. The pair always sums to MAX_BPS (schedule-time
        // invariant), so burnAmount == actualSlash * burnBps / MAX_BPS.
        (, uint256 effPayoutBps) = _effSlashShares();
        uint256 claimantAmount = (actualSlash * effPayoutBps) / MAX_BPS;
        uint256 burnAmount = actualSlash - claimantAmount;

        bond.amount -= actualSlash;
        bond.pendingClaims -= 1;
        claim.status = ClaimStatus.Upheld;

        // Burn slashed portion
        pvt.burn(burnAmount);

        // Pay claimant (slash payout + returned filing fee)
        uint256 totalToClaimant = claimantAmount + claim.filingFee;
        bool payOk = pvt.transfer(claim.claimant, totalToClaimant);
        if (!payOk) revert TransferFailed();

        // WP13 addendum (D-168): the claim PROCESSING FEE now funds the ARBITRATOR
        // PANEL, not Provian Tech. It is the fee charged for ADJUDICATING the claim, and
        // the panel is who adjudicated it, so it is routed to the Court, which pays each
        // arbitrator who posted AND voted and BURNS the shares of seats that did not
        // (never redistributed — that would pay panelists to want colleagues to fail).
        // Nothing about the payer or the amount changes: the fee is still drawn from the
        // respondent's bond, still `effProcessingFee`, still charged only when the bond
        // can cover it. Only the recipient moves (provianTechWallet → the panel via the
        // Court). Provian's deposit/renewal fees are untouched. WP5-rem: resolve through
        // the prospective override (else the storage var); unset (shipped) → 30 PVT,
        // issuance-indexed by D-165 — so the reward scales at the same ratio as the fee.
        uint256 effProcessingFee = _effClaimsProcessingFee();
        if (bond.amount >= effProcessingFee) {
            bond.amount -= effProcessingFee;
            bool feeOk = pvt.transfer(courtContract, effProcessingFee);
            if (!feeOk) revert TransferFailed();
            IArbitratorRewardSink(courtContract).fundBondClaimReward(claimId, effProcessingFee);
        }

        // Emit downgrade event if bond falls below its required minimum. WP13: the
        // threshold is the GRANDFATHERED `requiredAtPost` snapshot, never a live
        // re-derivation — a rising indexed floor must not retroactively downgrade an
        // agent whose bond was fully compliant when posted. Only a slash that actually
        // erodes THIS bond below what IT was required to hold can downgrade it.
        uint256 required = requiredAtPost[agent];
        if (bond.amount < required) {
            emit AutonomyDowngrade(agent, bond.amount, required);
        }

        emit BondSlashed(agent, claimId, claim.claimant, claimantAmount, burnAmount);
    }

    /**
     * @notice Court dismisses a claim. Filing fee is burned as frivolous-claim deterrent.
     * @dev Only callable by the Court contract.
     */
    function dismissClaim(address agent, bytes32 claimId) external onlyCourt {
        Claim storage claim = claims[claimId];
        if (!claimExists[claimId]) revert ClaimNotFound();
        if (claim.status != ClaimStatus.Filed) revert ClaimAlreadyResolved();
        if (claim.agent != agent) revert InvalidAddress();

        claim.status = ClaimStatus.Dismissed;
        bonds[agent].pendingClaims -= 1;

        // Burn filing fee as frivolous-claim deterrent
        pvt.burn(claim.filingFee);

        // WP13 addendum (D-168): processing fee funds the ARBITRATOR PANEL, not Provian
        // Tech — see the identical routing in slashBond. A dismiss is still a full
        // adjudication (a 2-of-3 Dismiss verdict, or a deadline/1-1-1 finalisation on a
        // fully-posted panel), so the panel earned the processing fee here too. Payer and
        // amount unchanged; recipient moves to the panel via the Court.
        Bond storage bond = bonds[agent];
        uint256 effProcessingFee = _effClaimsProcessingFee();
        if (bond.amount >= effProcessingFee) {
            bond.amount -= effProcessingFee;
            bool feeOk = pvt.transfer(courtContract, effProcessingFee);
            if (!feeOk) revert TransferFailed();
            IArbitratorRewardSink(courtContract).fundBondClaimReward(claimId, effProcessingFee);
        }

        emit ClaimDismissed(claimId, agent);
    }

    /**
     * @notice Court closes a claim whose PANEL NEVER ASSEMBLED (WP13). The filing fee is
     *         RETURNED to the claimant, not burned, and NO processing fee is charged.
     *
     * @dev Distinct from `dismissClaim` (a panel adjudicated and found the claim
     *      meritless → fee burned as a frivolous-claim deterrent) and from
     *      `expireStaleClaim` (the claim aged out → fee burned). Here the claimant did
     *      everything right and the SYSTEM failed to seat a panel within its bounded
     *      replacement rounds, so burning their fee would charge them for someone
     *      else's default — and would hand a windfall to the respondent, the one party
     *      who benefits from no verdict ever being reached. Charging the respondent a
     *      processing fee for a panel that never sat would be the mirror-image error,
     *      so that is skipped too.
     *
     *      Moves NO bonded collateral: it returns the claimant's own custodied fee and
     *      decrements pendingClaims, so the no-admin-drain invariant (#48) is intact and
     *      a slash still requires a 2-of-3 verdict (#49). `onlyCourt`, exactly like
     *      `dismissClaim` — this adds no authority, only a second outcome the Court can
     *      already reach a worse version of.
     *
     *      The push transfer cannot brick this path: PVT9's `_transfer` has no
     *      blacklist, pause, or hook — it reverts only on a zero recipient or an
     *      insufficient balance, and the claimant is non-zero by construction (they
     *      called `fileClaim`). Were it ever to revert anyway, `expireStaleClaim`
     *      remains the unchanged permissionless 60-day backstop.
     */
    function dismissClaimUnadjudicated(address agent, bytes32 claimId) external onlyCourt {
        Claim storage claim = claims[claimId];
        if (!claimExists[claimId]) revert ClaimNotFound();
        if (claim.status != ClaimStatus.Filed) revert ClaimAlreadyResolved();
        if (claim.agent != agent) revert InvalidAddress();

        claim.status = ClaimStatus.Dismissed;
        bonds[agent].pendingClaims -= 1;

        uint256 refund = claim.filingFee;
        bool ok = pvt.transfer(claim.claimant, refund);
        if (!ok) revert TransferFailed();

        emit ClaimClosedUnadjudicated(claimId, agent, claim.claimant, refund);
    }

    /**
     * @notice Permissionless escape for a stale, never-adjudicated claim (Pass-3 #3).
     *         Callable by ANYONE once CLAIM_RESOLUTION_TIMEOUT has elapsed since the
     *         claim was filed AND the claim is still Filed (no panel ever formed, so
     *         it was never slashed or dismissed). Resolves the claim to Dismissed —
     *         the agent-favorable, no-slash outcome — which decrements pendingClaims
     *         and unblocks the respondent's withdrawBond.
     *
     * @dev This is a LIVENESS backstop, not an adjudication path. It can only ever
     *      DISMISS (never slash): a slash requires a 2-of-3 Court panel verdict
     *      landing on-chain (invariant #49), and a still-Filed claim past its
     *      timeout has no such mandate. It burns the filing fee (same deterrent as
     *      dismissClaim) and moves NO bonded collateral to anyone — so it does not
     *      violate the no-admin-drain invariant (#48) and cannot be bricked by a
     *      reverting claimant. Mutually exclusive with the Court path by claim
     *      status: once expired the claim is Dismissed, so assignBondClaimPanel /
     *      slashBond / dismissClaim on the same claimId revert.
     */
    function expireStaleClaim(bytes32 claimId) external {
        Claim storage claim = claims[claimId];
        if (!claimExists[claimId]) revert ClaimNotFound();
        if (claim.status != ClaimStatus.Filed) revert ClaimAlreadyResolved();
        if (block.timestamp < claim.filedAt + CLAIM_RESOLUTION_TIMEOUT) revert ClaimNotExpired();
        // D-486 fix 1: a claim with a live Court panel is the Court's to resolve.
        // Expiring it here would leave the panel unable to slash (slashBond sees a
        // resolved claim), unable to finalize, and holding arbitrator collateral in a
        // case that can never turn terminal. The Court terminates every case without
        // a privileged key, so the liveness this backstop exists for is kept.
        if (courtContract != address(0) && IBondClaimCourt(courtContract).bondClaimCaseOpen(claimId)) {
            revert ClaimUnderAdjudication();
        }

        address agent = claim.agent;
        claim.status = ClaimStatus.Dismissed;
        bonds[agent].pendingClaims -= 1;

        // Burn the filing fee (frivolous-claim deterrent, matching dismissClaim).
        // No external transfer here, so a blacklisted/reverting claimant can never
        // brick this permissionless escape.
        pvt.burn(claim.filingFee);

        emit ClaimExpired(claimId, agent);
    }

    // =========================================================================
    // Abandonment
    // =========================================================================

    /**
     * @notice Process an abandoned bond. Callable by anyone after the abandonment period.
     *         Burns the entire remaining bond. Maximum deflationary event.
     * @param agent The bonded agent whose bond has been abandoned
     */
    function processAbandonment(address agent) external {
        Bond storage bond = bonds[agent];
        if (bond.status != BondStatus.Active) revert BondNotActive();
        // WP5-rem: resolve the abandonment period through its prospective override
        // (else the storage var); unset (shipped) → 180 days. renewalGracePeriod has
        // no setter (immutable-in-practice) and is read directly.
        if (block.timestamp < bond.renewalDeadline + renewalGracePeriod + _effAbandonmentPeriod()) {
            revert GracePeriodNotExpired();
        }
        // D-486 fix 3: never abandon over a pending claim. The claim must resolve first
        // (Court verdict or the 60-day expiry), so the count is zero when this bond is
        // burned, the next bond starts from a true zero, and a pending claim can never
        // decrement or slash a later bond it was not filed against.
        if (bond.pendingClaims > 0) revert ClaimsPending();

        uint256 burnAmount = bond.amount;
        bond.amount = 0;
        bond.status = BondStatus.Abandoned;

        // Burn entire remaining bond
        pvt.burn(burnAmount);

        emit BondAbandoned(agent, burnAmount);
    }

    // =========================================================================
    // View Functions
    // =========================================================================

    /**
     * @notice Calculate the required bond for a given autonomy level and trust discount.
     * @param autonomyLevel 2 or 3
     * @param trustDiscountBps Basis points of trust discount (max 5000 = 50%)
     * @return Required PVT bond amount (what gets locked, before deposit fees)
     */
    function getRequiredBond(uint8 autonomyLevel, uint256 trustDiscountBps) public view returns (uint256) {
        // WP5-rem: resolve the base ladder through the prospective override (else the
        // storage vars). Unset (shipped) → the recalibrated L2 750 / L3 3000 defaults.
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

    /**
     * @notice Check if an agent has an active, healthy bond.
     */
    function isBondHealthy(address agent) external view returns (bool) {
        Bond storage bond = bonds[agent];
        return bond.status == BondStatus.Active && block.timestamp <= bond.renewalDeadline;
    }

    // =========================================================================
    // Admin Functions
    // =========================================================================

    function setCourtContract(address _court) external onlyAdmin {
        if (courtContractSet) revert CourtAlreadySet();
        if (_court == address(0)) revert InvalidAddress();
        courtContract = _court;
        courtContractSet = true;
        emit CourtContractSet(_court);
    }

    /// @notice One-time wiring of the bounded parameter setter. Historical
    ///         v5-v7 deployments used ProvianConstitutionExecutor; live Base
    ///         Pass-3 wired Frank's EOA directly, then made the pointer immutable.
    function setExecutor(address _executor) external onlyAdmin {
        if (executorSet) revert ExecutorAlreadySet();
        if (_executor == address(0)) revert InvalidAddress();
        executor = _executor;
        executorSet = true;
        emit ExecutorWired(_executor);
    }

    /// @notice Legacy admin-transfer capability. Gate 1 does not authorize its
    ///         use; transfer or handoff requires separate explicit approval.
    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert InvalidAddress();
        address oldAdmin = admin;
        admin = newAdmin;
        emit AdminTransferred(oldAdmin, newAdmin);
    }
}
