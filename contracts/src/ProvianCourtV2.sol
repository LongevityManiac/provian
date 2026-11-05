// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IEpochClock} from "./interfaces/IEpochClock.sol";
import {IIssuanceIndex} from "./interfaces/IIssuanceIndex.sol";
import {IPVTBurnable} from "./interfaces/IPVTBurnable.sol";

interface IProvianEscrowV3 {
    function resolveDispute(bytes32 escrowId, bool releaseToRecipient) external;
    function getParties(bytes32 escrowId) external view returns (address depositor, address recipient);
    /// @dev D-486: nonzero once the escrow's dispute left Disputed by any path.
    function disputeSettledAt(bytes32 escrowId) external view returns (uint256);
}

/**
 * @notice Minimal BondPool surface the Court needs to adjudicate bond claims
 *         (WS1 Pass-2). The Court reads the on-chain claim (to bind a panel to a
 *         REAL filed claim and recover its parties) and the bond (to size a slash
 *         from the verdict), and bridges a 2-of-3 panel majority to the BondPool's
 *         `onlyCourt` slashBond / dismissClaim. These two are the ONLY on-chain
 *         sites that decrement BondPool.pendingClaims, so wiring the Court to them
 *         is what makes a frozen respondent bond reachable again.
 */
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
    /// @dev WP13 — closes a claim whose PANEL NEVER ASSEMBLED, refunding the
    ///      claimant's filing fee instead of burning it. See ProvianBondPool.
    function dismissClaimUnadjudicated(address agent, bytes32 claimId) external;
}

/**
 * @title ProvianCourtV2
 * @notice Decentralized arbitration v2 - references EscrowV3, AND (WS1 Pass-2)
 *         adjudicates BondPool claims by bridging a 2-of-3 panel verdict to the
 *         BondPool's onlyCourt slashBond / dismissClaim.
 *
 *      REPUTATION-STAKE DROP. This court once carried a second slash path -
 *      `slashAgentReputation`, which reached into the legacy PVT
 *      `slashReputation` to burn an agent's *staked* PVT. That was
 *      purchased-standing surface: it made reputation something an agent
 *      bought with capital and the court destroyed. Provian reputation is
 *      PE-signal, earned in the provenance layer, so the path is gone and
 *      with it the court's entire PVT reference (import, state variable,
 *      constructor parameter, binding) - `slashAgentReputation` was its ONLY
 *      consumer. PVT9 implements no `slashReputation` at all.
 *
 *      The court's REMAINING slash path is the per-obligation BOND path
 *      below (`castBondClaimVote` -> `bondPool.slashBond`), which is a
 *      different thing entirely: a bond is PVT the agent deliberately
 *      transferred into the pool to collateralize one specific obligation,
 *      slashed only when a 2-of-3 panel finds that obligation failed. That
 *      path is unchanged.
 * @dev Constitutional Note: This is a reference implementation demonstrating one way to build
 *      on the Provian constitutional layer. It is not canonical. Agents are free to deploy
 *      alternative implementations. Human-resolving and Genesis mints use the immutable
 *      99% contributor / 0.5% Provian / 0.5% Foundation treatment. Agent-side mints without
 *      a verified human beneficiary use the applicable prospective Foundation rate and the
 *      contributor receives the residual; linked-beneficiary routing is prospective policy.
 *      On the live Base Pass-3 deployment Frank's EOA is the direct admin/panel authority;
 *      the Foundation Safe and governance paths do not gate it. No admin transfer or handoff
 *      is authorized without separate explicit approval.
 *
 *      WS1 (Pass-2) bond-claim adjudication. The deployed CourtV2 only ever
 *      adjudicated ESCROW disputes; nothing on-chain could resolve a BondPool
 *      claim, so a single filed claim permanently froze the respondent's bonded
 *      PVT (BondPool.slashBond/dismissClaim — the only pendingClaims decrements —
 *      are onlyCourt, and no court called them). This version ADDS a bond-claim
 *      path that GENERALIZES the escrow assignPanel→castVote→resolve pattern:
 *      a panel is assigned to a real filed claim, arbitrators vote a verdict
 *      (Dismiss / SlashPartial / SlashFull), and a 2-of-3 majority bridges to the
 *      BondPool. A slash NEVER originates from the admin or a backend signer — it
 *      requires a 2-of-3 vote landing ON-CHAIN. The admin cannot slash, drain, or
 *      unfreeze a bond; a panel that fails to reach a slash majority by its
 *      deadline can only be finalized to DISMISS (the agent-favorable, no-slash
 *      outcome) via the permissionless finalizeBondClaim — so a deadlocked panel
 *      can never re-freeze a bond, and there is no privileged unfreeze key.
 */
contract ProvianCourtV2 {

    enum DisputeStatus {
        Pending,    // 0
        Resolved,   // 1
        Escalated   // 2
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

    // ---- WS1 (Pass-2): bond-claim adjudication ----

    /// @notice A panel member's verdict on a bond claim. `None` is an invalid
    ///         sentinel (a vote must be one of the three real outcomes).
    enum BondVerdictVote {
        None,         // 0 - invalid sentinel, never a valid vote
        Dismiss,      // 1 - claim is meritless: filing fee burned, no slash
        SlashPartial, // 2 - partial fault: slash MIN_SLASH_PAYOUT_BPS of the bond
        SlashFull     // 3 - full fault: slash the entire bond
    }

    struct BondDispute {
        bytes32 claimId;               // on-chain BondPool claimId being adjudicated
        address agent;                 // bonded respondent, read from the pool at panel assignment
        address[3] panel;
        mapping(address => bool) hasVoted;
        uint8 votesDismiss;
        uint8 votesPartial;
        uint8 votesFull;
        uint256 votingDeadline;
        DisputeStatus status;
    }

    /// @dev ClaimStatus.Filed on ProvianBondPool is enum value 0.
    uint8 private constant CLAIM_FILED = 0;

    // =========================================================================
    // State
    // =========================================================================

    mapping(bytes32 => Dispute) internal disputes;
    mapping(bytes32 => bool) public disputeExists;
    address public admin;
    IProvianEscrowV3 public escrowContract;

    // WS1 (Pass-2) bond-claim adjudication state. The BondPool is wired ONCE,
    // post-deploy, via setBondPool (same one-time-setter deploy-trust model as
    // BondPool.setCourtContract on the other side of the link).
    IProvianBondPool public bondPool;
    bool private bondPoolSet;
    mapping(bytes32 => BondDispute) internal bondDisputes; // keyed by on-chain claimId
    mapping(bytes32 => bool) public bondDisputeExists;

    /**
     * @notice A prospectively-scheduled cost value. `exists` distinguishes
     *         "an override was scheduled" from "unset". Mirrors ProvianPVT9's
     *         `ScheduledUint256` shape and the Escrow/Promise/Pool machinery.
     */
    struct ScheduledUint256 {
        bool exists;
        uint256 value;
    }

    /// @notice Immutable epoch clock — the ProvianPVT9 kernel on live Base. Read via
    ///         `currentEpoch()` to time the prospective panel-voting-period schedule
    ///         (see IEpochClock). Bound once at construction: no setter, so binding the
    ///         clock introduces no new settable-address authority.
    IEpochClock public immutable epochClock;

    // =========================================================================
    // WP13 — Arbitrator PER-CASE collateral (directive item 3; reverses D-021)
    //
    // A selected arbitrator posts collateral FOR THE CASE THEY WERE SELECTED TO,
    // it is locked for the voting window, and it is returned IN FULL absent proven
    // misconduct. It is a STAKE, never a fee.
    //
    // BOND-SHAPED STAKE, NOT PURCHASED STANDING. This is emphatically NOT the
    // reputation stake the court dropped. Selection is UNCHANGED: panels are still
    // admin-assigned from an OFF-CHAIN eligibility set earned by governance score,
    // PE count, completed escrows and a clean default record — there is no on-chain
    // candidate registry, no sortition, and no pre-posted pool anyone can buy into.
    // Collateral attaches AFTER selection, to one specific case, exactly the way a
    // performance bond attaches to one specific obligation. Nobody can buy a seat.
    //
    // WHY NOT OPT-IN-BY-POSTING: drawing panels from a set of people who have already
    // posted would convert collateral into standing you purchase and would stop being
    // per-case. That is the thing D-021 and the reputation-stake drop both reject.
    //
    // THE GRIEFING PROBLEM THIS SOLVES: with collateral attached to a SELECTED seat, a
    // panelist who simply never posts would stall the panel to its deadline, and the
    // only permissionless exit (finalizeBondClaim) is Dismiss-only — a win for the
    // respondent and a loss for the claimant who did pay a filing fee. So a
    // non-posting seat is FORFEITED and REPLACED within a bounded number of rounds,
    // and an incomplete panel is NOT dismissable.
    //
    // WHAT FORFEITURE COSTS — AND THE HONEST LIMIT. A non-poster has staked nothing
    // yet, so there is NO on-chain principal to slash and this contract does not
    // pretend otherwise. The consequence is exclusion from future selection: the
    // forfeiture is emitted on-chain for the off-chain eligibility criteria to
    // consume (they already carry a "no defaults in 90 days" test). On-chain,
    // forfeiting costs a non-poster nothing. Inventing a penalty here would require a
    // standing stake, which would reintroduce the pre-posted pool above.
    //
    // THE PREDICATE WITH REAL TEETH is the one where principal HAS been staked:
    // POSTED-BUT-DID-NOT-VOTE. That is objectively provable on-chain and is slashed
    // (burned). It fires ONLY when the case ran to its voting deadline; when a 2-of-3
    // majority resolved the case early the remaining seat had no opportunity to
    // matter and is returned in full. Subjective misconduct (bad-faith voting,
    // collusion) is NOT on-chain provable and is deliberately NOT implemented —
    // "Unknown = Block, not warn" cuts against slashing on an unprovable claim.
    //
    // SLASHED COLLATERAL IS BURNED. Not to the admin (no drain path), and not to a
    // dispute party — paying a party would give someone an incentive to lobby for
    // panel failure.
    // =========================================================================

    /// @notice Immutable PVT binding for arbitrator collateral ONLY. This is NOT a
    ///         return of the dropped `slashAgentReputation` path: that burned an
    ///         agent's *staked* reputation, whereas this custodies and returns a
    ///         per-case stake. The court still cannot touch a bond except through a
    ///         2-of-3 verdict bridged to the BondPool.
    IPVTBurnable public immutable pvt;

    /// @notice Immutable issuance index — the ProvianPVT9 kernel on live Base. Bound
    ///         once at construction: no setter, no new settable-address authority.
    IIssuanceIndex public immutable issuanceIndex;

    /// @notice Which case family a collateral posting belongs to. Escrow-dispute ids
    ///         and bond-claim ids are both bytes32 and live in SEPARATE mappings, so
    ///         posting state is namespaced by family to make a cross-family id
    ///         collision impossible.
    uint8 internal constant CASE_ESCROW = 1;
    uint8 internal constant CASE_BOND = 2;

    /// @notice Baseline arbitrator collateral: 10% of the BondPool's level-2 base bond,
    ///         indexed at the SAME ppm ratio as level 2 so the two move together.
    ///         Derived rather than named as its own ppm because level 2's exact anchor
    ///         at one tenth (7.5 ppm) is not an integer under a 1e6 denominator.
    ///         Resolves to 75 PVT today, identical to 10% of the live 750 PVT L2 bond.
    ///         No cross-contract read, so it does not depend on `setBondPool` firing.
    uint256 public constant ARBITRATOR_COLLATERAL_BASELINE = 750e18;
    uint256 public constant ARBITRATOR_COLLATERAL_INDEX_PPM = 75;
    uint256 public constant ARBITRATOR_COLLATERAL_DIVISOR = 10;
    uint256 public constant INDEX_PPM_DENOMINATOR = 1_000_000;

    /// @notice Bounded posting window for a newly assigned/replaced seat. Ships at
    ///         1 day — not invented, it is `PANEL_VOTING_PERIOD_MIN`, the nearest
    ///         existing literal in this contract — inside an immutable [6h, 7d] band.
    uint256 public constant PANEL_POSTING_WINDOW_MIN = 6 hours;
    uint256 public constant PANEL_POSTING_WINDOW_MAX = 7 days;
    uint256 public constant DEFAULT_PANEL_POSTING_WINDOW = 1 days;
    mapping(uint64 => ScheduledUint256) public scheduledPanelPostingWindow;
    uint64[] public panelPostingWindowEpochs;

    /// @notice How many REPLACEMENT rounds may follow the initial assignment before a
    ///         case is declared unassemblable. Rounds are GLOBAL — one window covers
    ///         every unposted seat at once — so seats are NOT a multiplier on latency.
    ///
    ///         LATENCY BOUND (asserted by test): worst case from assignment to a
    ///         terminal state is
    ///             (1 + MAX_REPLACEMENT_ROUNDS) x PANEL_POSTING_WINDOW_MAX
    ///           + PANEL_VOTING_PERIOD_MAX
    ///           = 4 x 7d + 14d = 42 days,
    ///         inside the BondPool's 60-day CLAIM_RESOLUTION_TIMEOUT with 18 days to
    ///         spare. Note that timeout runs from the claim's FILING, not from panel
    ///         assignment, so those 18 days are the budget for assignment latency.
    ///         At the SHIPPED values (1-day window, 48-hour vote) it is 6 days.
    uint8 public constant MAX_REPLACEMENT_ROUNDS = 3;

    /**
     * @notice Per-case seat-posting state. `postedMask` bit i is set when seat i has
     *         posted; a fully posted panel is 0x7. `requiredCollateral` is snapshotted
     *         AT ASSIGNMENT — the grandfathering rule, so a rise in the indexed floor
     *         can never retroactively enlarge what an already-seated panel owes.
     */
    struct PanelPosting {
        bool exists;
        uint8 postedMask;
        uint8 round;
        uint64 postingDeadline;
        uint256 requiredCollateral;
        uint256[3] postedAmount;
    }

    mapping(bytes32 => PanelPosting) internal panelPostings;

    /// @notice Set when a case reached a terminal state BY DEADLINE EXPIRY rather than
    ///         by a vote majority. This is the exact discriminator the absenteeism
    ///         predicate needs: only here is a posted-but-silent seat at fault.
    mapping(bytes32 => bool) public resolvedByDeadline;

    /// @notice D-486 fix 2: caseKey => the case was closed because its escrow settled
    ///         outside the Court (admin resolution or the escrow's own timeout).
    mapping(bytes32 => bool) public settledOutsideCourt;

    // =========================================================================
    // WP13 addendum — ARBITRATOR FEE SHARE (directive item 1; D-168)
    //
    // D-166 gave arbitrators a per-case COLLATERAL and no income: they posted a
    // stake, locked it, carried the absenteeism-burn risk, and earned nothing. The
    // rational strategy under that design is to never post — so panels never form and
    // every bond dispute ends in a Dismiss-only timeout. That is the DEFAULT outcome,
    // not an edge case. This closes it with income, not a penalty: the absence of the
    // fee IS the only consequence of not posting, and the fee is what guarantees an
    // arbitrator who WANTS the seat, so a non-poster is simply replaced by someone who
    // does. (No cooldown, no non-posting penalty — that is the slashReputation species
    // WP9 dropped.)
    //
    // FUNDING. The reward IS the claim PROCESSING FEE — the fee the pool already charges
    // the respondent's bond for adjudicating a claim (30 PVT at the shipped literal,
    // issuance-indexed by D-165). It used to go 100% to Provian Tech; it now funds the
    // panel that did the adjudicating. No number is invented: the pool is the existing
    // fee literal and the split is the existing panel size (3). At resolution the pool
    // routes the collected fee here (`fundBondClaimReward`, onlyBondPool) and this
    // contract splits it into three equal SEAT shares.
    //
    // WHO IS PAID. Each seat that BOTH posted AND recorded a vote claims its share at
    // `settleArbitratorCollateral` (alongside its collateral). A seat that posted but
    // never voted — including a third seat a 2-of-3 majority resolved past before it
    // could — FORFEITS its share, which is BURNED on the IPVTBurnable path. Forfeited
    // shares are NEVER redistributed to the other seats: redistribution would pay
    // arbitrators to want their colleagues to fail. Burning also feeds the burn-anchored
    // model. (Distinct from the COLLATERAL rule: a no-opportunity third seat gets its
    // stake back — it did nothing wrong — but earns no fee, because it did no work.)
    //
    // WHY ALL THREE SHARES ALWAYS RESOLVE. The fee is routed only from slashBond /
    // dismissClaim, and both require a FULLY POSTED panel to reach (voting and
    // finalisation revert `PanelNotFullyPosted`). So every seat has posted when a reward
    // exists, every seat is settle-able, and no share is ever stranded. The only
    // no-verdict terminal path (`closeUnassembledBondClaim`) charges no processing fee.
    //
    // KNOWN LIMITATION, ACCEPTED — NOT A TO-DO (D-173): REGISTRY DOMINANCE. An attacker
    // who accumulates enough reputation-earned seats can capture panels faster than
    // replacement exhausts them. It is a SELECTION-design problem, not a punishment one:
    // no penalty reaches it, and no selection design has been approved. Inventing one
    // here — in the contract that adjudicates every bond claim and every escrow dispute —
    // would put an unreviewed mechanism on the highest-risk surface in the tree, which is
    // worse than shipping with the exposure named. It is therefore ACCEPTED for this
    // deployment. Wiring the successor set CLOSES THE WINDOW on it: a fix afterwards needs
    // a redeploy of this contract, not a parameter.
    //
    // SUPERSEDED IN ITS CONCLUSION BY D-174 — READ THIS FIRST. Everything below about the
    // PRINCIPAL FEE remains true and is still pinned by WP13EscrowFeeShareInfeasible.t.sol:
    // a SHARE of that fee cannot pay an escrow panel. What is no longer true is the
    // consequence D-171 drew from it — that escrow arbitrators therefore earn nothing.
    // They now earn a share of EscrowV4's SEPARATE flat `disputeAdjudicationFee`, which
    // is not a share of the principal fee and so meets none of the obstacles below. The
    // paragraph's closing line ("a NEW number, Frank's to approve") was also wrong on its
    // own terms: no new number was needed — the fee is the BondPool's existing 30 PVT
    // claims-processing literal at the same 3 ppm floor. See the D-174 block further down.
    //
    // RESOLVED AGAINST SOURCE, NOT DEFERRED (D-171): ESCROW-DISPUTE ARBITRATORS CANNOT BE
    // PAID THIS WAY. They carry the same collateral and the same no-income problem, and it
    // was resolved against EscrowV4's actual fee model rather than left open. EscrowV4 has
    // NO dispute fee. Its only fee is `escrow.pvt_principal_fee` — 50 bps of PRINCIPAL, in
    // the escrow's SETTLEMENT currency — and both branches are already spent:
    //   - PVT-principal: the fee is BURNED AT FUNDING (`EscrowV4.fundEscrow`), before a
    //     dispute can exist. Nothing survives to resolution to pay a panel with. Holding it
    //     instead would change what the escrow custodies on the primary rail and contradict
    //     the byte-frozen catalog's recorded disposition for that cost id
    //     (`fee_burned_at_funding` / `depositor_refund_is_net_of_already_burned_fee`).
    //   - USDC-principal: the fee is USDC. This contract has NO USDC binding, and its
    //     forfeiture rail is `IPVTBurnable.burn` — a self-burn of PVT. USDC cannot be burned
    //     on it, and the only other destinations are redistribution (forbidden: it pays
    //     panelists to want their colleagues to fail) or a wallet (a drain path). There is
    //     no compliant destination for a forfeited USDC share.
    // The economics fail independently of the plumbing. A per-seat share of a PROPORTIONAL
    // fee is principal/600, so against the 75 PVT collateral the return is ~0.22% on a
    // 100 PVT escrow and 2.2% at 1,000 PVT, reaching 22.2% only at the backend's 10,000 PVT
    // principal cap and break-even (reward == stake) at 45,000 PVT — 4.5x that cap. It is
    // not a floor but a variable that collapses on exactly the small disputes that will
    // dominate. Worse, the rate's immutable band floor is 0 bps, so the "income" is
    // schedulable to nothing; the bond processing fee is not, because D-165 gave it an
    // issuance-indexed FLOOR. Nor is there anything to index: EscrowV4 contains no
    // `_indexFloor` — a bps rate is dimensionless and has no PVT amount to index.
    // Escrow's no-panel path also degrades DIFFERENTLY from the bond rail's Dismiss-only
    // default: `escalateDispute` → `resolveEscalatedDispute` (onlyAdmin, either verdict),
    // with EscrowV4's 30-day permissionless refund-to-depositor as the backstop. The
    // failure mode is centralized adjudication, not a fixed one-sided outcome.
    // Paying escrow panels therefore requires a fee that does not exist. D-174 CREATED
    // THAT FEE without inventing a number — see the block below. Everything above about
    // the principal fee stands; only "and so escrow panels cannot be paid" does not.
    /// @notice Per bond-claim (case key) reward share owed to EACH posted-and-voted seat.
    ///         Set once by `fundBondClaimReward`; read (not zeroed) by each seat's
    ///         settlement, which is itself one-shot, so each seat is paid/burned at most once.
    mapping(bytes32 => uint256) public bondRewardSharePerSeat;
    /// @notice Guards `fundBondClaimReward` against double-funding a claim.
    mapping(bytes32 => bool) public bondRewardFunded;

    // =========================================================================
    // WP13 addendum-3 — ESCROW ADJUDICATION FEE (D-174)
    //
    // D-171's STOP stands and is not reversed: a SHARE OF THE PRINCIPAL FEE still
    // cannot pay an escrow panel, for exactly the reasons recorded above. What
    // D-171 named as the real fix is what this is — EscrowV4's NEW flat, PVT-
    // denominated `disputeAdjudicationFee`, which is not a share of anything and so
    // needs no PVT/USDC conversion and no price read. Proportionality was the
    // blocker; PVT never was.
    //
    // SAME SHAPE AS THE BOND RAIL, ONE STRUCTURAL DIFFERENCE. Funding arrives through
    // an `onlyEscrow` call mirroring `fundBondClaimReward`, is split three ways, and
    // is paid at settlement only to a seat that POSTED AND VOTED — a forfeited share
    // BURNS on `IPVTBurnable` and is never redistributed. The difference is TIMING,
    // and it is the reason for the sweep below. The bond fee is routed at RESOLUTION,
    // which is only reachable through a FULLY POSTED panel, so all three bond shares
    // are always claimable. The escrow fee is charged at ESCALATION — BEFORE a panel
    // exists — so a seat may never post, and a share belonging to a seat that never
    // posted can never be claimed (`settleArbitratorCollateral` requires a posted
    // stake). `burnUnclaimableEscrowReward` is the terminal disposition for exactly
    // those shares: paid to a seat that earned it, or burned, never redistributed.
    //
    // THE LIMIT OF THAT CLAIM, STATED PRECISELY BECAUSE AN EARLIER DRAFT OVERSTATED IT.
    // The shares of seats that NEVER POSTED always resolve — the 42-day `aged` backstop
    // reaches them even when an admin assigns a panel and then abandons it without opening
    // a replacement round, which is the case that defeats `_assemblyFailed` (it requires
    // `round >= MAX_REPLACEMENT_ROUNDS`, and only the onlyAdmin `replaceEscrowPanelSeat`
    // advances `round`). What does NOT always resolve is the share of a seat that DID post
    // in such an abandoned case: settlement requires terminality, that case never becomes
    // terminal, and so its share waits indefinitely — exactly as its COLLATERAL already
    // does, on both case families, on the shipped contract. That is the pre-existing
    // panel-liveness gate rather than anything this fee introduces, and closing it would
    // mean changing `_assemblyFailed` for bond claims too. Out of scope here; declared
    // rather than papered over, and pinned by an executable test.
    //
    // WHY ASSIGNMENT IS GATED ON THE FEE. Without the gate the fee would be optional —
    // an admin could seat a panel that nobody paid for, and arbitrators would be back
    // to D-166's collateral-without-income, which is the whole defect this closes. The
    // gate is what makes the fee "the cost of invoking adjudication" rather than a
    // voluntary donation. Its consequence is deliberate and is preserved elsewhere:
    // when nobody pays, no panel forms, and the dispute resolves through EscrowV4's
    // untouched admin `resolveDispute` and 30-day permissionless depositor refund.
    //
    // ACCEPTED, NAMED LIMITATION. The unassigned-case sweep fires 42 days after
    // funding — this contract's OWN worst-case assemble-to-terminal bound, derived
    // below, not a new number — and once swept, assignment is closed. At the shipped
    // 30-day escrow dispute timeout that is always AFTER the escrow itself became
    // permissionlessly refundable, so the sweep can only ever dispose of a fee on a
    // case that is already over. If the escrow's dispute timeout were SCHEDULED above
    // 42 days (Frank-only, prospective, band ceiling 180 days), a sweep could close
    // panel assignment while that dispute is still live; the dispute would then resolve
    // by admin `resolveDispute` or by its own timeout. Stated rather than mechanised:
    // reading EscrowV4's timeout from here would widen the V3-compatible escrow
    // interface this contract deliberately binds.
    // =========================================================================

    /// @notice Per escrow-dispute (case key) reward share owed to EACH posted-and-voted
    ///         seat. Set once by `fundEscrowDisputeReward`; read (not zeroed) by each
    ///         seat's settlement, which is itself one-shot per seat.
    mapping(bytes32 => uint256) public escrowRewardSharePerSeat;
    /// @notice Guards `fundEscrowDisputeReward` against double-funding, and is the
    ///         precondition `assignPanel` checks: no fee, no panel.
    mapping(bytes32 => bool) public escrowRewardFunded;
    /// @notice When the fee arrived. Only consumed by the never-assigned sweep, to hold
    ///         it off until this contract's own worst-case assembly latency has elapsed.
    mapping(bytes32 => uint64) public escrowRewardFundedAt;
    /// @notice Set once `burnUnclaimableEscrowReward` has disposed of the unclaimable
    ///         shares. One-shot, and (for a never-assigned case) closes assignment.
    mapping(bytes32 => bool) public escrowRewardSwept;

    /// @notice How long after funding an escrow reward may be swept when NO panel was
    ///         ever assigned. DERIVED, not invented: it is this contract's own
    ///         documented worst-case assignment-to-terminal latency (see
    ///         MAX_REPLACEMENT_ROUNDS) — every posting window that could be opened,
    ///         plus a full voting period — so a panel that could still realistically be
    ///         assembled is never swept out from under. Resolves to 4 x 7d + 14d = 42d.
    uint256 public constant UNASSIGNED_REWARD_BURN_DELAY =
        (1 + uint256(MAX_REPLACEMENT_ROUNDS)) * PANEL_POSTING_WINDOW_MAX + PANEL_VOTING_PERIOD_MAX;

    // =========================================================================
    // WP5 — Court-native COST parameter: panel voting period
    //
    // WP5 owns Court's COST parameters only; WP9 owns Court MECHANICS
    // (collateral, panels, votes, evidence, appeals, objective slashes). The only
    // Court cost parameter with a LIVE enforced contract literal today is the
    // panel voting period — the 48-hour deadline armed in assignPanel /
    // assignBondClaimPanel (court.panel_voting_period in the approved catalog).
    // Every other court.* cost row is not_implemented (its mechanic is WP9's) or
    // targets the dropped reputation stake, so it is deferred to WP9 and gets NO
    // machinery here.
    //
    // FAIL-CLOSED: unset → the historical 48-hour (172,800 s) literal stands
    // byte-for-byte. Bound to ProvianPVT9.currentEpoch() via `epochClock`, resolved
    // lazily at read time; no local counter, no permissionless epoch-advance.
    // =========================================================================

    // --- court.panel_voting_period — seconds, 1d–14d ---
    /// @notice Immutable band for the panel voting period: floor 1 day, ceiling
    ///         14 days. Overrides the live 48-hour (172,800 s) literal.
    uint256 public constant PANEL_VOTING_PERIOD_MIN = 1 days;   // 86,400
    uint256 public constant PANEL_VOTING_PERIOD_MAX = 14 days;  // 1,209,600
    /// @notice The historical panel voting period (48 hours) that stands when no
    ///         override is active.
    uint256 public constant DEFAULT_PANEL_VOTING_PERIOD = 48 hours; // 172,800
    mapping(uint64 => ScheduledUint256) public scheduledPanelVotingPeriod;
    /// @notice Epochs at which a panel-voting-period override was scheduled. Empty →
    ///         the 48-hour literal stands (see assignPanel / assignBondClaimPanel).
    uint64[] public panelVotingPeriodEpochs;

    // =========================================================================
    // Events
    // =========================================================================

    event PanelAssigned(bytes32 indexed escrowId, address arb0, address arb1, address arb2, uint256 votingDeadline);
    event VoteCast(bytes32 indexed escrowId, address indexed arbitrator, bool releaseToRecipient);
    event Verdict(bytes32 indexed escrowId, bool releaseToRecipient, uint8 votesForRelease, uint8 votesForRefund);
    event Escalated(bytes32 indexed escrowId);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);

    // WS1 (Pass-2) bond-claim adjudication events.
    event BondPoolSet(address indexed bondPool);
    event BondPanelAssigned(bytes32 indexed claimId, address indexed agent, address arb0, address arb1, address arb2, uint256 votingDeadline);
    event BondVoteCast(bytes32 indexed claimId, address indexed arbitrator, BondVerdictVote verdict);
    event BondClaimResolved(bytes32 indexed claimId, address indexed agent, BondVerdictVote verdict, uint256 slashAmount);

    // WP5 cost-parameter machinery
    event PanelVotingPeriodScheduled(uint64 indexed effectiveEpoch, uint256 periodSeconds);

    // WP13 arbitrator per-case collateral
    event PanelPostingWindowScheduled(uint64 indexed effectiveEpoch, uint256 windowSeconds);
    event ArbitratorCollateralPosted(
        bytes32 indexed caseKey, address indexed arbitrator, uint8 seat, uint256 amount
    );
    /// @notice A seat was vacated for failing to post inside its window. Emitted for the
    ///         OFF-CHAIN eligibility criteria to consume — on-chain this costs the
    ///         non-poster nothing, because they never staked anything (see the block above).
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
    /// @notice A POSTED seat that never voted while the case ran to its deadline. The
    ///         one objectively-provable misconduct predicate; the stake is BURNED.
    event ArbitratorCollateralSlashed(
        bytes32 indexed caseKey, address indexed arbitrator, uint8 seat, uint256 amount
    );
    event PanelAssemblyFailed(bytes32 indexed caseKey, uint8 rounds);

    // WP13 addendum — arbitrator fee share (D-168)
    /// @notice The claim processing fee arrived from the pool and was split into seat
    ///         shares. `burnedDust` is the 3-way division remainder, burned immediately.
    event BondClaimRewardFunded(
        bytes32 indexed caseKey, uint256 totalAmount, uint256 sharePerSeat, uint256 burnedDust
    );
    /// @notice A seat that posted AND voted was paid its fee share.
    event ArbitratorRewardPaid(
        bytes32 indexed caseKey, address indexed arbitrator, uint8 seat, uint256 amount
    );
    /// @notice A seat that posted but never voted forfeited its share; it is BURNED,
    ///         never redistributed to the other seats.
    event ArbitratorRewardForfeited(
        bytes32 indexed caseKey, address indexed arbitrator, uint8 seat, uint256 amount
    );

    // WP13 addendum-3 — escrow adjudication fee (D-174)
    /// @notice The flat escrow adjudication fee arrived from the Escrow at escalation
    ///         and was split into seat shares. `burnedDust` is the 3-way division
    ///         remainder, burned immediately.
    event EscrowDisputeRewardFunded(
        bytes32 indexed caseKey, uint256 totalAmount, uint256 sharePerSeat, uint256 burnedDust
    );
    /// @notice Shares that can never be claimed — the shares of seats that never posted
    ///         collateral — were BURNED. `seats` is how many shares were disposed of.
    event EscrowRewardSwept(bytes32 indexed caseKey, uint8 seats, uint256 burnedAmount);
    /// @notice D-486: an escrow case closed because the escrow settled outside the Court.
    event DisputeSettledOutsideCourt(bytes32 indexed escrowId, uint256 settledAt, bool ranToVotingDeadline);

    // =========================================================================
    // Errors
    // =========================================================================

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
    // WS1 (Pass-2) bond-claim adjudication errors.
    error BondPoolNotSet();
    error BondPoolAlreadySet();
    error BondClaimNotFiled();
    error InvalidBondVerdict();
    // WP5 cost-parameter machinery
    error PolicyNotProspective();
    error PolicyAlreadyScheduled();
    error CostOutOfDomain();
    // WP13 arbitrator per-case collateral
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
    // WP13 addendum — arbitrator fee share (D-168)
    error NotBondPool();
    error RewardAlreadyFunded();
    // WP13 addendum-3 — escrow adjudication fee (D-174)
    error NotEscrow();
    error AdjudicationFeeNotPaid();
    error RewardNotFunded();
    error RewardAlreadySwept();
    error NothingUnclaimable();
    error SweepDelayNotElapsed();
    // D-486
    error EscrowSettledOutsideCourt();
    error EscrowNotSettledOutsideCourt();

    // =========================================================================
    // Constructor
    // =========================================================================

    /// @dev The PVT parameter is BACK, but for a different purpose than the one that
    ///      was removed. The court's former PVT reference existed solely to reach
    ///      `IPVT.slashReputation` and burn an agent's *staked* reputation — purchased
    ///      standing, destroyed by the court — and that path is gone for good (PVT9
    ///      implements no `slashReputation`). The binding here custodies ARBITRATOR
    ///      PER-CASE COLLATERAL: PVT a selected panelist posts for one case and gets
    ///      back in full unless they took a seat and then never voted. Bond slashing
    ///      still goes exclusively through the BondPool (wired one-time via
    ///      `setBondPool`), which holds the bonded PVT itself; this contract can never
    ///      reach a bond except through a 2-of-3 verdict.
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

    // =========================================================================
    // WP5 — Cost-parameter epoch machinery (kernel-clock-bound; WP-CLK)
    //
    // The activation clock is ProvianPVT9.currentEpoch() via `epochClock`. A
    // scheduled value for epoch E is resolved lazily at read time as "the value at
    // the greatest scheduled epoch <= currentEpoch()" (forward-fill). No local
    // counter, no permissionless epoch-advance. Identical in shape to
    // ProvianEscrowV4 / ProvianPromiseV3 / ProvianPoolV3.
    // =========================================================================

    /// @notice The current activation epoch, from the immutable kernel clock. Fails
    ///         CLOSED to 0 if the kernel is unarmed / has not started, so the 48-hour
    ///         literal stands and panel assignment never bricks.
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

    /// @dev Prospectivity guard for the scheduler.
    function _requireScheduleEpoch(uint64 effectiveEpoch) private view {
        if (effectiveEpoch <= _currentEpoch()) revert PolicyNotProspective();
    }

    /// @dev Resolve the active value: the value scheduled at the greatest epoch <=
    ///      currentEpoch(), else unset. Scans the append-only, admin-only-grown array.
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

    /// @notice The panel-voting-period override active at the current kernel epoch, as
    ///         (exists, value). exists == false → the 48-hour literal stands.
    function activePanelVotingPeriod() public view returns (bool exists, uint256 value) {
        ScheduledUint256 memory a = _resolveActive(scheduledPanelVotingPeriod, panelVotingPeriodEpochs);
        return (a.exists, a.value);
    }

    /// @dev The panel voting period effective now: the active override, else the
    ///      48-hour default. Read by assignPanel / assignBondClaimPanel.
    function _panelVotingPeriod() internal view returns (uint256) {
        (bool exists, uint256 value) = activePanelVotingPeriod();
        return exists ? value : DEFAULT_PANEL_VOTING_PERIOD;
    }

    /// @notice Schedule the panel voting period (seconds) — the window a panel has to
    ///         vote before a dispute can be escalated / finalized — to take effect
    ///         when `effectiveEpoch` opens. Admin-only (Frank's EOA on live Base),
    ///         bounded to the immutable [1 day, 14 days] band, prospective, one value
    ///         per epoch. Until scheduled AND active, the 48-hour literal stands.
    function schedulePanelVotingPeriod(uint64 effectiveEpoch, uint256 periodSeconds) external onlyAdmin {
        _requireScheduleEpoch(effectiveEpoch);
        if (periodSeconds < PANEL_VOTING_PERIOD_MIN || periodSeconds > PANEL_VOTING_PERIOD_MAX) revert CostOutOfDomain();
        if (scheduledPanelVotingPeriod[effectiveEpoch].exists) revert PolicyAlreadyScheduled();
        scheduledPanelVotingPeriod[effectiveEpoch] = ScheduledUint256({exists: true, value: periodSeconds});
        panelVotingPeriodEpochs.push(effectiveEpoch);
        emit PanelVotingPeriodScheduled(effectiveEpoch, periodSeconds);
    }

    // =========================================================================
    // WP13 — posting window + arbitrator collateral resolution
    // =========================================================================

    /// @notice The seat-posting window override active at the current kernel epoch.
    function activePanelPostingWindow() public view returns (bool exists, uint256 value) {
        ScheduledUint256 memory a = _resolveActive(scheduledPanelPostingWindow, panelPostingWindowEpochs);
        return (a.exists, a.value);
    }

    /// @dev The posting window effective now: the active override, else the 1-day default.
    function _panelPostingWindow() internal view returns (uint256) {
        (bool exists, uint256 value) = activePanelPostingWindow();
        return exists ? value : DEFAULT_PANEL_POSTING_WINDOW;
    }

    /// @notice Schedule the seat-posting window. Admin-only, bounded to the immutable
    ///         [6h, 7d] band, prospective, one value per epoch — the same shape as
    ///         `schedulePanelVotingPeriod`. The band's upper end is what keeps the
    ///         asserted latency bound inside CLAIM_RESOLUTION_TIMEOUT.
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

    /// @notice The trailing-12-epoch average issuance, or 0 when unmeasured. Fails
    ///         CLOSED exactly like `_currentEpoch`, so an unarmed or unreachable kernel
    ///         leaves the baseline collateral standing rather than bricking assignment.
    function _trailingIssuance() internal view returns (uint256) {
        try issuanceIndex.trailingAverageForEpoch(_currentEpoch()) returns (uint256 avg) {
            return avg;
        } catch {
            return 0;
        }
    }

    /// @notice The arbitrator collateral required for a case assigned RIGHT NOW:
    ///         `max(baseline, ppm x trailing average) / 10` — one tenth of the
    ///         indexed level-2 bond, at level 2's own ratio. A MINIMUM on a cost,
    ///         never a maximum; with a thin index it is exactly 75 PVT.
    function arbitratorCollateral() public view returns (uint256) {
        uint256 avg = _trailingIssuance();
        uint256 fromIndex = (ARBITRATOR_COLLATERAL_INDEX_PPM * avg) / INDEX_PPM_DENOMINATOR;
        uint256 base = fromIndex > ARBITRATOR_COLLATERAL_BASELINE ? fromIndex : ARBITRATOR_COLLATERAL_BASELINE;
        return base / ARBITRATOR_COLLATERAL_DIVISOR;
    }

    /// @dev Namespaced posting key. Escrow ids and claim ids are both bytes32 and are
    ///      drawn from different spaces, so they are separated here rather than trusted
    ///      not to collide.
    function _caseKey(uint8 family, bytes32 id) internal pure returns (bytes32) {
        return keccak256(abi.encode(family, id));
    }

    /// @dev Arm a freshly assigned panel's posting window and snapshot the collateral
    ///      requirement for the life of the case (grandfathering).
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

    /// @dev A case is unassemblable once the LAST permitted replacement round has
    ///      elapsed with the panel still incomplete.
    function _assemblyFailed(PanelPosting storage p) internal view returns (bool) {
        return p.exists && !_fullyPosted(p) && p.round >= MAX_REPLACEMENT_ROUNDS
            && block.timestamp > p.postingDeadline;
    }

    /// @dev D-486 fix 1: an assigned bond panel that never fully posted and has sat past
    ///      its last posting deadline by the same abandonment backstop the escrow reward
    ///      sweep uses. `_assemblyFailed` needs the admin to spend every replacement
    ///      round; without this, a round-0 panel an admin never touched could hold a
    ///      claim (and the seats that did post) open forever now that the pool no longer
    ///      lets the claim expire under a live panel.
    function _bondPanelAbandoned(PanelPosting storage p) internal view returns (bool) {
        return p.exists && !_fullyPosted(p)
            && block.timestamp >= uint256(p.postingDeadline) + UNASSIGNED_REWARD_BURN_DELAY;
    }

    /// @dev D-486 fix 2: close a still-Pending escrow case whose escrow already settled
    ///      outside the Court (admin `resolveDispute` or the escrow's permissionless
    ///      timeout). The case becomes Resolved, so every posted seat can settle. It
    ///      counts as having run to its voting deadline ONLY when a fully posted panel's
    ///      deadline passed before the escrow settled — the existing default rule, so a
    ///      seat that sat silent through its whole vote is still burned, and every other
    ///      posted seat gets its collateral back. Returns true when it closed the case.
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

    /// @dev D-486 fix 2: no panel action on a case whose escrow already settled.
    function _requireEscrowStillDisputed(bytes32 escrowId) internal view {
        if (escrowContract.disputeSettledAt(escrowId) != 0) revert EscrowSettledOutsideCourt();
    }

    /// @notice D-486 fix 2: permissionlessly close an escrow case whose escrow settled
    ///         outside the Court. `settleArbitratorCollateral` and
    ///         `burnUnclaimableEscrowReward` do this themselves; this only makes the
    ///         closure visible without waiting for a seat to settle.
    function closeExternallySettledDispute(bytes32 escrowId) external {
        if (!disputeExists[escrowId]) revert DisputeNotFound();
        if (!_syncOutsideSettlement(escrowId)) revert EscrowNotSettledOutsideCourt();
    }

    /// @notice D-486 fix 1: true while `claimId` has an assigned panel that has not
    ///         resolved. The BondPool refuses `expireStaleClaim` while this holds.
    function bondClaimCaseOpen(bytes32 claimId) external view returns (bool) {
        return bondDisputeExists[claimId] && bondDisputes[claimId].status == DisputeStatus.Pending;
    }

    function _seatOf(address[3] storage panel, address who) internal view returns (uint8 seat, bool found) {
        for (uint8 i = 0; i < 3; i++) {
            if (panel[i] == who) return (i, true);
        }
        return (0, false);
    }

    /// @dev Pull one seat's collateral and, when the THIRD seat lands, arm the voting
    ///      deadline. Arming on the third post rather than at assignment is deliberate:
    ///      a slow-but-complete panel is never penalised for the time it spent
    ///      assembling, and the full voting window is always available to it.
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
        p.postedMask |= uint8(1 << seat);

        emit ArbitratorCollateralPosted(caseKey, msg.sender, seat, amount);

        if (_fullyPosted(p)) {
            return (true, block.timestamp + votingPeriod);
        }
        return (false, 0);
    }

    /// @dev Replace ONE unposted seat after its window lapsed. Rounds are GLOBAL: the
    ///      first replacement made after the deadline opens a new window covering EVERY
    ///      unposted seat, and further replacements inside that window do not consume
    ///      another round. That is what keeps seats out of the latency product.
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

        // GLOBAL ROUNDS. A replacement is admissible when either
        //   (a) the current window has LAPSED — which opens the next round, or
        //   (b) a replacement round is already open — so every OTHER unposted seat can
        //       be swapped inside that same window without consuming another round.
        // (b) is what keeps seats out of the latency product: one window covers the
        // whole sweep. The initial (round 0) window must lapse before any replacement,
        // so a seat still inside its original posting window can never be taken away.
        bool windowLapsed = block.timestamp > p.postingDeadline;
        if (!windowLapsed && p.round == 0) revert PostingWindowStillOpen();

        // Replacement re-runs the SAME on-chain conflict-of-interest and distinctness
        // checks assignment does. Party exclusion is not weakened by replacement.
        if (newArb == partyA || newArb == partyB) revert ArbitratorIsParty();
        for (uint8 i = 0; i < 3; i++) {
            if (i != seat && panel[i] == newArb) revert DuplicateArbitrator();
        }

        // Open the next global window only when the current one has actually lapsed.
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

    /// @notice Settle ONE seat's posted collateral once its case is terminal.
    ///         PERMISSIONLESS by design: the outcome is a function of on-chain state,
    ///         not of who calls, so an absent arbitrator cannot dodge a burn by simply
    ///         never claiming, and a diligent one never depends on anyone's cooperation.
    ///
    ///         Returns the stake IN FULL unless the single provable misconduct
    ///         predicate holds — the seat posted, the case ran to its VOTING DEADLINE,
    ///         and the seat never voted — in which case the stake is BURNED. A seat that
    ///         voted, or whose case was resolved early by a 2-of-3 majority, is always
    ///         returned: a majority that resolves at the second vote leaves the third
    ///         seat no opportunity to matter, so it is not at fault.
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

        // Zero FIRST: settlement is one-shot per seat regardless of branch.
        p.postedAmount[seat] = 0;

        if (resolvedByDeadline[caseKey] && !voted) {
            pvt.burn(amount);
            emit ArbitratorCollateralSlashed(caseKey, arb, seat, amount);
        } else {
            bool ok = pvt.transfer(arb, amount);
            if (!ok) revert TransferFailed();
            emit ArbitratorCollateralReturned(caseKey, arb, seat, amount);
        }

        // WP13 addendum (D-168), extended to escrow disputes by addendum-3 (D-174): pay
        // this seat's ARBITRATOR FEE SHARE in the SAME one-shot settlement as its
        // collateral (postedAmount[seat] was zeroed above, so a second call reverts
        // before reaching here — the reward is paid/burned at most once per seat).
        //
        // BOTH FAMILIES, ONE RULE. A bond share exists only for a claim that was
        // adjudicated (slashBond/dismissClaim routed the processing fee in via
        // fundBondClaimReward); an escrow share exists only for a dispute someone paid
        // to escalate (fundEscrowDisputeReward). Unfunded cases read 0 and this is inert.
        //
        // Paid iff the seat VOTED: posting alone cannot claim it, because a seat that
        // never voted did no work. Otherwise the share is BURNED, never redistributed to
        // the other seats — redistribution would pay arbitrators to want their colleagues
        // to fail. This is a STRICTER test than the collateral burn above: a
        // no-opportunity third seat (an early 2-of-3 majority resolved past it) gets its
        // STAKE back — resolvedByDeadline was false, it was not at fault — yet still
        // earns NO fee, because earning requires having voted.
        uint256 rewardShare = family == CASE_BOND
            ? bondRewardSharePerSeat[caseKey]
            : escrowRewardSharePerSeat[caseKey];
        if (rewardShare != 0) {
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

    /// @notice Receive the claim PROCESSING FEE from the pool at bond-claim resolution and
    ///         split it into three equal SEAT shares to be claimed at settlement (D-168).
    ///         The pool has ALREADY transferred `amount` PVT to this contract; this records
    ///         the per-seat share and burns the 3-way division remainder so no dust is
    ///         stranded. Sum distributed/burned across the three seats + this dust == amount
    ///         (value-conserving). onlyBondPool: only the wired pool may fund a reward, and
    ///         a claim can be funded once (slashBond/dismissClaim resolve a claim exactly
    ///         once). This adds no admin authority and no drain path — the money leaves by
    ///         the same posted-and-voted rule the collateral does.
    function fundBondClaimReward(bytes32 claimId, uint256 amount) external {
        if (msg.sender != address(bondPool)) revert NotBondPool();
        bytes32 caseKey = _caseKey(CASE_BOND, claimId);
        if (bondRewardFunded[caseKey]) revert RewardAlreadyFunded();
        bondRewardFunded[caseKey] = true;

        uint256 share = amount / 3;
        bondRewardSharePerSeat[caseKey] = share;
        uint256 dust = amount - share * 3;
        if (dust != 0) pvt.burn(dust);

        emit BondClaimRewardFunded(caseKey, amount, share, dust);
    }

    /// @notice Receive the flat ESCROW ADJUDICATION FEE from the escrow at escalation and
    ///         split it into three equal SEAT shares to be claimed at settlement (D-174).
    ///         The escrow has ALREADY routed `amount` PVT here in the same call; this
    ///         records the per-seat share and burns the 3-way division remainder so no
    ///         dust is stranded. `onlyEscrow`: only the wired escrow may fund a reward.
    ///         One-shot per escrow — a second escalation reverts, which unwinds the
    ///         escrow's transfer too, so nobody is charged twice. Adds no admin
    ///         authority and no drain path: the money leaves only by the same
    ///         posted-and-voted rule the collateral does, or by burning.
    function fundEscrowDisputeReward(bytes32 escrowId, uint256 amount) external {
        if (msg.sender != address(escrowContract)) revert NotEscrow();
        bytes32 caseKey = _caseKey(CASE_ESCROW, escrowId);
        if (escrowRewardFunded[caseKey]) revert RewardAlreadyFunded();
        escrowRewardFunded[caseKey] = true;
        escrowRewardFundedAt[caseKey] = uint64(block.timestamp);

        uint256 share = amount / 3;
        escrowRewardSharePerSeat[caseKey] = share;
        uint256 dust = amount - share * 3;
        if (dust != 0) pvt.burn(dust);

        emit EscrowDisputeRewardFunded(caseKey, amount, share, dust);
    }

    /// @notice Burn the escrow-dispute reward shares that can NEVER be claimed: the
    ///         shares of seats that never posted collateral. PERMISSIONLESS, one-shot,
    ///         and burn-only — there is no recipient, so this is not a drain path and
    ///         forfeited value is never redistributed to the seats that did post.
    ///
    /// @dev Two admissible situations, and nothing else:
    ///        1. A panel WAS assigned and the case is terminal (resolved/escalated, or
    ///           assembly failed). No further posting is possible on either branch, so
    ///           the unposted seats are final.
    ///        2. A panel was NEVER assigned and `UNASSIGNED_REWARD_BURN_DELAY` has
    ///           elapsed since funding. All three shares are unclaimable. Sweeping also
    ///           closes assignment (see `assignPanel`), so a panel can never be seated
    ///           into a case whose reward has already been burned.
    ///      Seats that DID post are untouched here: their shares resolve through
    ///      `settleArbitratorCollateral`, which is itself permissionless.
    function burnUnclaimableEscrowReward(bytes32 escrowId) external {
        bytes32 caseKey = _caseKey(CASE_ESCROW, escrowId);
        if (!escrowRewardFunded[caseKey]) revert RewardNotFunded();
        if (escrowRewardSwept[caseKey]) revert RewardAlreadySwept();

        // The ABANDONMENT backstop is needed on BOTH branches, but it must be measured
        // from a DIFFERENT instant on each, and getting that wrong introduces a grief.
        //
        // Never assigned: the clock runs from FUNDING, because nothing else has happened.
        //
        // Assigned: it runs from `postingDeadline` — the instant the panel stopped being
        // fillable — and NOT from funding. Measuring the assigned case from funding would
        // make a panel that an admin legitimately assigns more than 42 days after
        // escalation instantly sweepable, killing a live panel before its seats could
        // post. `postingDeadline` is re-armed by every replacement round, so an actively
        // worked case keeps pushing the backstop out and only a genuinely abandoned one
        // reaches it.
        //
        // The assigned branch needs a backstop at all because `_assemblyFailed` requires
        // `round >= MAX_REPLACEMENT_ROUNDS`, and only the onlyAdmin `replaceEscrowPanelSeat`
        // advances `round` — so a panel abandoned at round 0 is NEVER terminal, and without
        // this the fee would be neither payable nor burnable for the life of the contract.
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
            // Count from `postedMask`, NEVER from `postedAmount`: settlement ZEROES
            // `postedAmount[seat]`, so counting amounts would classify an
            // already-settled seat as "never posted" and burn its share a second time
            // — paying out and burning the same share, which would eat another case's
            // funds. The mask is the durable record of having posted and is never cleared.
            for (uint8 i = 0; i < 3; i++) {
                if (p.postedMask & uint8(1 << i) == 0) unclaimable++;
            }
        }

        if (unclaimable == 0) revert NothingUnclaimable();
        escrowRewardSwept[caseKey] = true;

        uint256 burned = escrowRewardSharePerSeat[caseKey] * unclaimable;
        if (burned != 0) pvt.burn(burned);

        emit EscrowRewardSwept(caseKey, unclaimable, burned);
    }

    // ---- WP13 posting views ----

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

    // =========================================================================
    // Functions
    // =========================================================================

    /**
     * @notice Assign a 3-member arbitration panel to a dispute.
     * @dev Two on-chain invariants are enforced here:
     *        1. Panel members are distinct (DuplicateArbitrator).
     *        2. No panel member is a party to the underlying escrow -
     *           enforced by calling escrowContract.getParties(escrowId) and
     *           rejecting any arbs[i] == depositor or recipient
     *           (ArbitratorIsParty).
     *      The backend (provian-backend/src/core/agent-bank/court.ts) also
     *      screens candidate panels for conflicts of interest prior to
     *      submission, but the on-chain check here is authoritative.
     *      Only the Court admin may call this function.
     */
    function assignPanel(bytes32 escrowId, address[3] calldata arbs) external onlyAdmin {
        if (disputeExists[escrowId]) revert DisputeAlreadyExists();
        // WP13 addendum-3 (D-174): no adjudication fee, no panel. This is what makes the
        // fee the COST OF INVOKING ADJUDICATION rather than an optional donation, and
        // what guarantees a seated arbitrator has income to earn. Its deliberate
        // consequence — an unpaid dispute never gets a panel — resolves on EscrowV4's
        // untouched rails (admin resolveDispute, or the 30-day permissionless refund to
        // the depositor). A swept case is closed: its reward has already been burned, so
        // a panel seated now could never be paid.
        bytes32 feeKey = _caseKey(CASE_ESCROW, escrowId);
        if (!escrowRewardFunded[feeKey] || escrowRewardSwept[feeKey]) revert AdjudicationFeeNotPaid();
        _requireEscrowStillDisputed(escrowId);
        if (arbs[0] == address(0) || arbs[1] == address(0) || arbs[2] == address(0)) {
            revert InvalidAddress();
        }
        if (arbs[0] == arbs[1] || arbs[0] == arbs[2] || arbs[1] == arbs[2]) {
            revert DuplicateArbitrator();
        }

        // On-chain conflict-of-interest check: arbitrators cannot be escrow parties
        (address depositor, address recipient) = escrowContract.getParties(escrowId);
        for (uint256 i = 0; i < 3; i++) {
            if (arbs[i] == depositor || arbs[i] == recipient) {
                revert ArbitratorIsParty();
            }
        }

        Dispute storage d = disputes[escrowId];
        d.escrowId = escrowId;
        d.panel = arbs;
        // WP13: the voting deadline is NOT armed here. It arms when the THIRD seat
        // posts its collateral (`_postCollateral`), so a panel is never charged for the
        // time it spent assembling. Until then it reads 0, which is the "not yet armed"
        // sentinel every downstream guard checks via `_fullyPosted`.
        d.votingDeadline = 0;
        d.status = DisputeStatus.Pending;
        disputeExists[escrowId] = true;

        // WP13: arm the seat-posting window and snapshot this case's collateral
        // requirement for its whole life (grandfathering).
        _armPosting(_caseKey(CASE_ESCROW, escrowId));

        emit PanelAssigned(escrowId, arbs[0], arbs[1], arbs[2], d.votingDeadline);
    }

    /// @notice A selected escrow-dispute panelist posts their per-case collateral.
    ///         Must land inside the seat-posting window; the third post arms the
    ///         voting deadline for the whole panel.
    function postEscrowCollateral(bytes32 escrowId) external {
        if (!disputeExists[escrowId]) revert DisputeNotFound();
        Dispute storage d = disputes[escrowId];
        if (d.status != DisputeStatus.Pending) revert DisputeNotPending();

        bytes32 caseKey = _caseKey(CASE_ESCROW, escrowId);
        // Once the reward has been swept, this seat's share is already BURNED. Letting it
        // post now would let it claim a share that no longer exists — paying out of another
        // case's funds. A sweep therefore closes posting, which is safe because a sweep only
        // ever happens on a case that is terminal or abandoned past the 42-day backstop.
        if (escrowRewardSwept[caseKey]) revert RewardAlreadySwept();
        _requireEscrowStillDisputed(escrowId);
        (bool nowFull, uint256 deadline) = _postCollateral(caseKey, d.panel, _panelVotingPeriod());
        if (nowFull) {
            d.votingDeadline = deadline;
            emit PanelFullyPosted(caseKey, deadline);
        }
    }

    /// @notice Replace an escrow-dispute seat that failed to post inside its window.
    ///         Same `onlyAdmin` authority that fills every seat today — this adds no
    ///         new authority and invents no arbitrator registry; selection remains
    ///         off-chain. Re-runs party exclusion and distinctness.
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
        // WP13: voting opens only once ALL THREE seats have posted. Until then the
        // deadline is unarmed and a partial panel cannot start deciding.
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

    /// @notice Escalate a dispute whose panel voted itself to a standstill, OR whose
    ///         panel could never be assembled inside its bounded replacement rounds.
    /// @dev WP13 splits the two cases explicitly. A fully-posted panel escalates the
    ///      way it always did, once its voting deadline lapses — and that path now sets
    ///      `resolvedByDeadline`, which is what makes a posted-but-silent seat
    ///      slashable. An UNASSEMBLED panel escalates only after the last permitted
    ///      replacement round has elapsed, so a still-fillable seat can never be used
    ///      to shortcut a live dispute to the admin.
    function escalateDispute(bytes32 escrowId) external {
        if (!disputeExists[escrowId]) revert DisputeNotFound();

        Dispute storage d = disputes[escrowId];
        if (d.status != DisputeStatus.Pending) revert DisputeNotPending();
        // D-486 fix 2: a case whose escrow already settled is closed by
        // `closeExternallySettledDispute`, never escalated.
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

    /**
     * @notice Admin resolves an escalated dispute (fallback when panel voting fails).
     *         Only callable by admin, only on escalated disputes.
     */
    function resolveEscalatedDispute(bytes32 escrowId, bool releaseToRecipient) external onlyAdmin {
        if (!disputeExists[escrowId]) revert DisputeNotFound();
        Dispute storage d = disputes[escrowId];
        require(d.status == DisputeStatus.Escalated, "Not escalated");

        d.status = DisputeStatus.Resolved;
        escrowContract.resolveDispute(escrowId, releaseToRecipient);
        emit Verdict(escrowId, releaseToRecipient, d.votesForRelease, d.votesForRefund);
    }

    // =========================================================================
    // Reputation-stake slashing: REMOVED.
    //
    // `slashAgentReputation(bytes32,address,uint256,address)` and its
    // `disputeSlashed` ledger used to live here. They called the legacy
    // `IPVT.slashReputation` to burn an agent's *staked* PVT after a resolved
    // escrow dispute — reputation as purchased standing, destroyed by the
    // court. Provian reputation is PE-signal, so the whole path is deleted
    // rather than reimplemented, and the court's PVT reference went with it
    // (this was its only consumer). PVT9 implements no `slashReputation`.
    //
    // The deployed PVTv8's `reputationStakes` ledger is untouched and stays
    // as-is on-chain: immutable, empty (`totalStaked == 0`), unreachable.
    // This drop is about the live path, not rewriting history.
    //
    // The bond path below is NOT this and is unchanged.
    // =========================================================================

    // =========================================================================
    // WS1 (Pass-2): Bond-claim adjudication
    //
    // Generalizes the escrow assignPanel→castVote→resolve pattern to BondPool
    // claims. A slash ONLY fires from a 2-of-3 panel majority landing on-chain
    // here — never from the admin, never from a backend signer. The BondPool's
    // slashBond/dismissClaim stay onlyCourt; this contract is that court.
    // =========================================================================

    /// @notice One-time wiring of the BondPool this court adjudicates claims for.
    ///         Mirrors BondPool.setCourtContract on the other side of the link:
    ///         set once at deploy, then immutable. Until set, the bond-claim
    ///         entry points fail closed (BondPoolNotSet).
    function setBondPool(address _bondPool) external onlyAdmin {
        if (bondPoolSet) revert BondPoolAlreadySet();
        if (_bondPool == address(0)) revert InvalidAddress();
        bondPool = IProvianBondPool(_bondPool);
        bondPoolSet = true;
        emit BondPoolSet(_bondPool);
    }

    /// @notice Assign a 3-member panel to a REAL filed BondPool claim.
    /// @dev Fails closed unless the claim exists on the pool and is still Filed
    ///      (BondClaimNotFiled). The bonded respondent + the claimant are read
    ///      from the pool and excluded from the panel (ArbitratorIsParty), so a
    ///      party can never sit on their own claim. Only the Court admin may
    ///      assign (Frank's EOA on live Base Pass-3); assignment grants NO
    ///      slash power — only a subsequent on-chain 2-of-3 vote can slash.
    function assignBondClaimPanel(bytes32 claimId, address[3] calldata arbs) external onlyAdmin {
        if (!bondPoolSet) revert BondPoolNotSet();
        if (bondDisputeExists[claimId]) revert DisputeAlreadyExists();
        if (arbs[0] == address(0) || arbs[1] == address(0) || arbs[2] == address(0)) {
            revert InvalidAddress();
        }
        if (arbs[0] == arbs[1] || arbs[0] == arbs[2] || arbs[1] == arbs[2]) {
            revert DuplicateArbitrator();
        }

        // Bind to a real, still-open claim and recover its parties on-chain.
        if (!bondPool.claimExists(claimId)) revert BondClaimNotFiled();
        (address claimant, address agent, , uint8 cstatus, ) = bondPool.claims(claimId);
        if (cstatus != CLAIM_FILED) revert BondClaimNotFiled();

        // Conflict-of-interest: no panelist may be the bonded agent or the claimant.
        for (uint256 i = 0; i < 3; i++) {
            if (arbs[i] == agent || arbs[i] == claimant) revert ArbitratorIsParty();
        }

        BondDispute storage d = bondDisputes[claimId];
        d.claimId = claimId;
        d.agent = agent;
        d.panel = arbs;
        // WP13: unarmed until the third seat posts — same rule as the escrow panel.
        d.votingDeadline = 0;
        d.status = DisputeStatus.Pending;
        bondDisputeExists[claimId] = true;

        _armPosting(_caseKey(CASE_BOND, claimId));

        emit BondPanelAssigned(claimId, agent, arbs[0], arbs[1], arbs[2], d.votingDeadline);
    }

    /// @notice A selected bond-claim panelist posts their per-case collateral.
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

    /// @notice Replace a bond-claim seat that failed to post inside its window.
    ///         Re-reads the claim's parties from the pool so party exclusion is
    ///         enforced on the replacement exactly as on the original assignment.
    function replaceBondClaimPanelSeat(bytes32 claimId, uint8 seat, address newArb) external onlyAdmin {
        if (!bondPoolSet) revert BondPoolNotSet();
        if (!bondDisputeExists[claimId]) revert DisputeNotFound();
        BondDispute storage d = bondDisputes[claimId];
        if (d.status != DisputeStatus.Pending) revert DisputeNotPending();

        (address claimant, address agent, , , ) = bondPool.claims(claimId);
        _replaceSeat(_caseKey(CASE_BOND, claimId), d.panel, seat, newArb, agent, claimant);
    }

    /// @notice Close a bond claim whose PANEL COULD NEVER BE ASSEMBLED, after the last
    ///         permitted replacement round has elapsed. Permissionless, and it routes
    ///         to the pool's REFUNDING closure so the claimant is not charged a filing
    ///         fee for a panel the system failed to seat.
    ///
    /// @dev This is the terminal state for the liveness rule, and it is deliberately
    ///      NOT a dismissal on the merits: no verdict was ever reached, so the fee goes
    ///      back rather than being burned as a frivolous-claim deterrent. Reaching this
    ///      path at all requires admin inaction or collusion — the respondent neither
    ///      chooses arbitrators nor may sit on the panel — which is already the trust
    ///      assumption of admin-assigned panels; it is not claimed to be unreachable.
    ///      The BondPool's permissionless 60-day `expireStaleClaim` remains the
    ///      unchanged outer backstop.
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

    /// @notice A panel member votes a verdict on a bond claim. A 2-of-3 majority
    ///         for any single verdict resolves the claim and bridges to the pool:
    ///         Dismiss → BondPool.dismissClaim; SlashPartial → slashBond at the
    ///         MIN_SLASH_PAYOUT_BPS floor of the bond; SlashFull → slashBond at the
    ///         full bond. If all three panelists vote and no verdict reaches 2 (a
    ///         1/1/1 split), the claim resolves to Dismiss — a slash requires a
    ///         clear majority, so an indecisive panel never slashes ("Unknown =
    ///         Block, not warn": when the verdict is unclear, do NOT slash).
    function castBondClaimVote(bytes32 claimId, BondVerdictVote verdict) external {
        if (verdict == BondVerdictVote.None) revert InvalidBondVerdict();
        if (!bondDisputeExists[claimId]) revert DisputeNotFound();

        BondDispute storage d = bondDisputes[claimId];
        if (d.status != DisputeStatus.Pending) revert DisputeNotPending();
        // WP13: a partial panel cannot vote — voting opens on the third posting.
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

        // Resolve on a 2-of-3 majority for a single verdict. A slash fires ONLY
        // here, driven by votes on-chain.
        if (d.votesDismiss >= 2) {
            _resolveBondDismiss(d, claimId);
        } else if (d.votesFull >= 2) {
            _resolveBondSlash(d, claimId, BondVerdictVote.SlashFull);
        } else if (d.votesPartial >= 2) {
            _resolveBondSlash(d, claimId, BondVerdictVote.SlashPartial);
        } else if (d.votesDismiss + d.votesPartial + d.votesFull == 3) {
            // All three voted with no 2-majority (1/1/1): resolve conservatively
            // to Dismiss. No slash without a clear majority.
            _resolveBondDismiss(d, claimId);
        }
    }

    /// @notice Finalize a bond claim whose panel never reached a slash majority
    ///         by its deadline. Permissionless (no privileged key) and can ONLY
    ///         dismiss — the agent-favorable, no-slash outcome — so a deadlocked
    ///         or under-voted panel can never permanently freeze the bond, and no
    ///         admin/keeper can slash or unfreeze. (A slash majority would have
    ///         auto-resolved in castBondClaimVote, so a still-Pending claim here
    ///         has no slash mandate.)
    /// @dev WP13 adds ONE precondition and changes nothing else: the panel must be
    ///      FULLY POSTED. That is precisely the griefing path being closed — with
    ///      collateral attached to a selected seat, a panelist who never posts could
    ///      otherwise stall the case to its deadline and hand the respondent a free
    ///      dismissal at the claimant's expense. An incomplete panel is therefore not
    ///      dismissable; it is replaced, and if it still cannot be seated the case ends
    ///      through `closeUnassembledBondClaim`, which REFUNDS the filing fee.
    ///      Everything else is untouched: still permissionless, still Dismiss-only,
    ///      still unable to slash under any input.
    function finalizeBondClaim(bytes32 claimId) external {
        if (!bondDisputeExists[claimId]) revert DisputeNotFound();
        BondDispute storage d = bondDisputes[claimId];
        if (d.status != DisputeStatus.Pending) revert DisputeNotPending();
        bytes32 caseKey = _caseKey(CASE_BOND, claimId);
        if (!_fullyPosted(panelPostings[caseKey])) revert PanelNotFullyPosted();
        if (block.timestamp <= d.votingDeadline) revert VotingNotExpired();
        // The case ran to its deadline: any seat that posted and never voted is now
        // in default, and `settleArbitratorCollateral` will burn its stake.
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
        // slashAmount lands exactly on the BondPool's [floor, cap] band (partial =
        // floor, full = cap), so the pool's fail-closed bound accepts it.
        bondPool.slashBond(d.agent, slashAmount, claimId);
        emit BondClaimResolved(claimId, d.agent, verdict, slashAmount);
    }

    // =========================================================================
    // View helpers
    // =========================================================================

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

    // ---- WS1 (Pass-2) bond-claim views ----

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

    /**
     * @notice Legacy admin-transfer capability. Gate 1 does not authorize key
     *         rotation, transfer, or handoff; any such action needs separate
     *         explicit approval.
     */
    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert InvalidAddress();
        address oldAdmin = admin;
        admin = newAdmin;
        emit AdminTransferred(oldAdmin, newAdmin);
    }
}
