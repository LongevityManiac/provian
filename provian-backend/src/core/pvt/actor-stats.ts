/**
 * actor-stats — the incrementally-maintained per-actor counters the reputation VOCABULARY (Trust
 * Layer build §2.5, run-log ) is computed from. ONE document per economic actor
 * (`actor_stats_v1/<actor id>`), bumped in a single read-modify-write transaction at every seal
 * (best-effort — a stats failure never fails a seal), backfilled from `pe_history`.
 *
 * Everything here is a COUNT, a timestamp, a rank, or a witnessed amount — metadata only. Map keys
 * are sanitized identifiers (an action type, a `family__class` pair, a model FAMILY, an environment
 * class, a coarse region code, a launch-measurement digest); no free text, no serial, no prompt, no
 * path.
 *
 * (item 8) — actor-stats/v2 adds LIVE HISTORY:
 * - `days` one bucket per UTC day (`YYYY-MM-DD`), pruned to the last
 * {@link ACTOR_STATS_DAY_WINDOW_DAYS} UTC days on every bump, so the vocabulary answers the
 * fixed 30/90/365-day windows from the same seal-time counters as the lifetime facts.
 * - `measurements` attested launch measurements (SEALED admitted hardware reports only).
 * - `payment_volume_atomic` chain-witnessed Base USDC (6-decimal atomic units, decimal string —
 * an arbitrary on-chain amount can exceed 2^53, so it is summed with BigInt and never rounded).
 * - `regions` now counts ONLY a witnessed PE whose SEALED hardware summary says
 * `admitted === true` (the client-declared `metadata.attested_region` fallback is gone).
 * - `history_complete` false for a v1 document a live bump upgraded in place — its v2-only
 * fields (days, measurements, payment volume, attested-only regions) then cover only the PEs
 * sealed since the upgrade, so the vocabulary REFUSES to answer from it (fail closed, item 2)
 * until the backfill rebuilds it from the ledger and sets it true. A document created fresh at
 * v2 is complete from its first PE.
 *
 * Firestore field names are never dotted here (a dotted key is a field PATH in `update`), so the
 * family×class map uses `__` and every write is a whole-document transactional `set`. The day
 * buckets are persisted as compact JSON strings (one string field per day): 366 buckets of nested
 * maps would otherwise cost tens of thousands of automatic single-field index entries against
 * Firestore's 40,000-per-document ceiling.
 *
 * NEVER a pricing or mint input: nothing on the accrual, settlement, eligibility, or monetary path
 * reads this document. Its only readers are the presentation vocabulary and the Court's arbitrator
 * gate (which reads the vocabulary).
 */

import type { Firestore } from 'firebase-admin/firestore';
import type { WitnessClass } from './policy/evidence-class';
import { normalizeWitnessClass } from './policy/evidence-class';
import { assertBaseUsdcTransferEvidence } from '../onchain/economic-discovery';
import { normalizeCounterparty } from '../meter/counterparty-pairs';
// The measurement reader lives with the hardware verifiers (measured observer, 2026-10-10): the
// vocabulary fact and the pricing rule read the SAME bytes through ONE function.
import { measurementKey, hardwareMeasurementOf } from '../hardware/measurement';
export { measurementKey, hardwareMeasurementOf };

export const ACTOR_STATS_COLLECTION = 'actor_stats_v1';
export const ACTOR_STATS_SCHEMA = 'actor-stats/v2';
export const ACTOR_STATS_SCHEMA_V1 = 'actor-stats/v1';

/** Bounded map sizes — a runaway key space (a million distinct action types) cannot grow the doc. */
export const ACTOR_STATS_MAX_TYPE_KEYS = 512;
export const ACTOR_STATS_MAX_FACET_KEYS = 64;
/** Per-day facet bounds (models / environments / regions, and measurements) — keeps 366 buckets
 *  well under the 1 MiB document ceiling even for an adversarial key stream. */
export const ACTOR_STATS_MAX_DAY_FACET_KEYS = 6;
export const ACTOR_STATS_MAX_DAY_MEASUREMENT_KEYS = 4;
/** Trust layer extension (2026-10-10): attested issuer roots per day, and the distinct INBOUND PAYERS
 *  (a payment rail asks for payments from independent parties: the lifetime map is wider than the
 *  other facets because a rail is paid by many; the day map is narrow to keep 366 buckets small). */
export const ACTOR_STATS_MAX_DAY_ISSUER_KEYS = 4;
export const ACTOR_STATS_MAX_PAYER_KEYS = 256;
export const ACTOR_STATS_MAX_DAY_PAYER_KEYS = 12;
/** Day buckets retained: the last 366 UTC days (today plus the 365 before it). */
export const ACTOR_STATS_DAY_WINDOW_DAYS = 366;
export const DAY_MS = 24 * 60 * 60 * 1000;

// =============================================================================
// Shared type sets (the vocabulary's windowed facts use the SAME sets as the lifetime ones)
// =============================================================================

/** Families whose witnessed rows count as `money.witnessed_financial`. */
export const FINANCIAL_FAMILIES: ReadonlySet<string> = new Set(['wallet', 'x402', 'financial']);

/** Adverse standing by type → vocabulary field. */
export const STANDING_TYPE_FIELDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['standing.bond_slashed', ['bond_slashed']],
  // The on-chain `BondAbandoned` burn is the event; the relay's `bond_abandonment_processed` row
  // mirrors the same burn on the same agent and is NOT a second adverse event.
  ['standing.bond_abandoned', ['bond_abandoned']],
  ['standing.bond_expired', ['bond_expired_processed']],
  ['standing.bond_autonomy_downgraded', ['bond_autonomy_downgraded']],
  ['standing.claims_dismissed_as_claimant', ['bond_claim_dismissed']],
  ['standing.court_verdicts_against', ['court_verdict']],
  ['standing.arbitrator_seats_forfeited', ['court_arbitrator_seat_forfeited']],
  ['standing.arbitrator_collateral_slashed', ['court_arbitrator_collateral_slashed']],
  // a person's one-sided "broken" marks nobody — `promise_broken` is a
  // record on the tapper's own chain and is NOT a Standing type.
  ['standing.promises_defaulted', ['promise_defaulted']],
  ['standing.reputation_slashed', ['pvt_reputation_slashed']],
  // two relay-witnessed events, each counted once on the LOSING party (see countsAsAdverse).
  ['standing.hire_disputes_lost', ['escrow_resolved']],
  ['standing.challenges_upheld_against', ['commons_challenge_resolved']],
];

/** Every adverse action type (the union of {@link STANDING_TYPE_FIELDS}) — `standing.adverse_events`. */
export const ADVERSE_STANDING_TYPES: ReadonlySet<string> = new Set(STANDING_TYPE_FIELDS.flatMap(([, types]) => [...types]));

/**
 * ONE ADVERSE EVENT, ONCE, ON THE PARTY AT FAULT. An adverse TYPE is not enough: the relay
 * also seals record rows of the same type on parties who did nothing wrong (the winner of a Court
 * verdict, the lender of a defaulted promise) and mirrors of events the chain watcher already
 * witnessed. Two rules decide whether a sealed row counts against its actor:
 *
 * - {@link CHAIN_WITNESSED_ADVERSE_TYPES}: the Standing watcher attributes these from the on-chain
 * event to the party the event names (a verdict to the escrow LOSER). Only the watcher's row
 * counts — it carries `metadata.standing === 'adverse'` and its `canonical_event_id`. A
 * relay-composed row of the same type (court.ts seals `court_verdict` on BOTH escrow parties)
 * is a record, never a second or misplaced adverse event.
 * ONE exception keeps a verdict from vanishing: the watcher reads Base only, so a relay verdict
 * row settled on any OTHER chain counts on the LOSING party (`standingRelayLoserOffBase`) — there
 * is no watcher row for it to double.
 * - {@link NOT_AT_FAULT_ROLES}: a relay-witnessed adverse type sealed on both sides of a bilateral
 * record counts only on the side at fault; the row's `metadata.role` names the side.
 *
 * The set must equal the watcher's adverse action types (`STANDING_ADVERSE_ACTION_TYPES`); the
 * suite binds the two so a new chain-witnessed adverse event cannot be added to one and not the other.
 */
export const CHAIN_WITNESSED_ADVERSE_TYPES: ReadonlySet<string> = new Set([
  'bond_slashed', 'bond_abandoned', 'bond_autonomy_downgraded', 'bond_claim_dismissed',
  'court_verdict', 'court_arbitrator_seat_forfeited', 'court_arbitrator_collateral_slashed',
]);

/** Per adverse type: the `metadata.role` values that name the WRONGED side of a bilateral row. */
export const NOT_AT_FAULT_ROLES: Readonly<Record<string, ReadonlySet<string>>> = {
  promise_defaulted: new Set(['lender']),
};

/**
 * LOSER-ONLY types. These action types are ordinary records on most rows (the winner of a
 * dispute, the challenger, every non-hire escrow resolution); a row counts ONLY when its sealed
 * metadata names its actor as the losing party of the event:
 *
 * - `escrow_resolved` a HIRE dispute (`metadata.hire_job_id`) settled by the escrow admin or the
 * timeout refund, on the party the chain did not pay (`standingHireDisputeLost`).
 * - `commons_challenge_resolved` an UPHELD Commons challenge, on the challenged party's own row
 * (`metadata.role === 'challenged'`, `standingChallengeUpheldAgainst`).
 */
export const LOSER_ONLY_ADVERSE_TYPES: ReadonlySet<string> = new Set(['escrow_resolved', 'commons_challenge_resolved']);

/** The two facts of a sealed row the adverse rule reads (derived by {@link deriveCompositionSignals}). */
export interface StandingRowFacts {
  readonly standingRole?: string | null;
  readonly standingChainAdverse?: boolean;
  readonly standingRelayLoserOffBase?: boolean;
  readonly standingPairedBondSlash?: boolean;
  readonly standingHireDisputeLost?: boolean;
  readonly standingChallengeUpheldAgainst?: boolean;
}

/** The one chain the Standing watcher reads (Base mainnet). */
export const STANDING_WATCHED_CHAIN_ID = 8453;

/**
 * True when whether a row of `actionType` counts against its actor is decided by the row's sealed
 * metadata (the watcher evidence, or the side of a bilateral record). Without the envelope the
 * answer is UNKNOWN — the backfill and the reconcile refuse to settle such a row either way.
 */
export function adverseDecisionNeedsEnvelope(actionType: string | null): boolean {
  return actionType !== null
    && (CHAIN_WITNESSED_ADVERSE_TYPES.has(actionType) || actionType in NOT_AT_FAULT_ROLES || LOSER_ONLY_ADVERSE_TYPES.has(actionType));
}

/** Pure: does a sealed row of `actionType` count as ONE adverse event against its actor? */
export function countsAsAdverse(actionType: string | null, row: StandingRowFacts | null | undefined): boolean {
  if (actionType === null || !ADVERSE_STANDING_TYPES.has(actionType)) return false;
  if (actionType === 'escrow_resolved') return row?.standingHireDisputeLost === true;
  if (actionType === 'commons_challenge_resolved') return row?.standingChallengeUpheldAgainst === true;
  if (CHAIN_WITNESSED_ADVERSE_TYPES.has(actionType)) {
    if (row?.standingChainAdverse === true) {
      // a bond slash is ONE adverse event. The BondPool emits `AutonomyDowngrade` in the same
      // call when the slash drops the bond below its requirement; that downgrade row is the slash's
      // own consequence and is not counted again. A downgrade with no slash in its transaction counts.
      return !(actionType === 'bond_autonomy_downgraded' && row.standingPairedBondSlash === true);
    }
    return actionType === 'court_verdict' && row?.standingRelayLoserOffBase === true;
  }
  const role = typeof row?.standingRole === 'string' ? row.standingRole : null;
  if (role !== null && NOT_AT_FAULT_ROLES[actionType]?.has(role)) return false;
  return true;
}
export const PROMISE_FULFILLED_TYPES: readonly string[] = ['promise_settled', 'promise_fulfilled'];
export const PROMISE_DEFAULTED_TYPES: readonly string[] = ['promise_defaulted'];
export const ESCROW_COMPLETED_TYPES: readonly string[] = ['escrow_completed'];
export const HUMAN_APPROVAL_TYPES: readonly string[] = ['human_approval'];
/**
 * Inbound financial acts — `money.witnessed_inbound` (reference-gate run, 2026-10-09). A `receive`
 * is derived ONLY by the chain lanes (the inbound USDC watcher, the chain-record lane's inbound
 * scan, the x402 facilitator lane) from a transaction the recipient did not sign; no device, phone
 * or relay/action route admits it as a submitted act, so every `receive` row is chain-witnessed
 * and the lifetime `by_type` count IS the witnessed inbound count.
 */
export const INBOUND_FINANCIAL_TYPES: readonly string[] = ['receive'];

/**
 * Every action type the vocabulary reads BY NAME from `by_type`. These keys are exempt from the
 * `by_type` key cap : the cap exists to bound permissionless type spam, and it must never
 * let that spam hide a named fact — a `standing.*` zero is an observed zero (item 2).
 */
export const VOCABULARY_NAMED_TYPES: ReadonlySet<string> = new Set([
  ...ADVERSE_STANDING_TYPES,
  ...PROMISE_FULFILLED_TYPES,
  ...PROMISE_DEFAULTED_TYPES,
  ...ESCROW_COMPLETED_TYPES,
  ...HUMAN_APPROVAL_TYPES,
  ...INBOUND_FINANCIAL_TYPES,
]);

// =============================================================================
// Document shape
// =============================================================================

/** One UTC day of live history. Every count is a PE count unless named otherwise. */
export interface ActorStatsDayBucket {
  /** PEs sealed. */
  readonly n: number;
  /** PEs by witness class. */
  readonly wc: Readonly<Record<string, number>>;
  /** Witnessed compute tokens (same rule as `witnessed_compute_tokens`). */
  readonly tok: number;
  /** Witnessed financial PEs (same rule as `money.witnessed_financial`). */
  readonly fin: number;
  /** Chain-witnessed Base USDC, atomic units (decimal string). */
  readonly pay: string;
  /** Adverse events (same type set as `standing.adverse_events`). */
  readonly adv: number;
  /** Promises fulfilled / defaulted. */
  readonly pf: number;
  readonly pd: number;
  /** Model families / environment classes / attested regions / attested measurements, by PE count. */
  readonly m: Readonly<Record<string, number>>;
  readonly e: Readonly<Record<string, number>>;
  readonly r: Readonly<Record<string, number>>;
  readonly ms: Readonly<Record<string, number>>;
  /** Witnessed INBOUND payments (`receive` rows — same rule as `money.witnessed_inbound`). */
  readonly inb: number;
  /** Attested issuer roots (sha256 fingerprint of the pinned root an admitted report reached), by PE count. */
  readonly is: Readonly<Record<string, number>>;
  /** Distinct inbound payers (counterparty address of a chain-witnessed `receive` the same-owner fence passed), by PE count. */
  readonly py: Readonly<Record<string, number>>;
  /**
   * Chain-continuity records sealed : idle `compute_session` records. They
   * count toward the day's activity and nothing else — never `n`, never a class or facet map.
   */
  readonly cr: number;
}

export interface ActorStatsDoc {
  readonly schema_version: typeof ACTOR_STATS_SCHEMA;
  readonly actor_id: string;
  readonly first_pe_at_ms: number | null;
  readonly last_pe_at_ms: number | null;
  /** Acts of work sealed — every sealed PE except a chain-continuity record (see `continuity_records`). */
  readonly pe_count: number;
  /**
   * Chain-continuity records sealed : an idle `compute_session` sealed
   * `skipped_no_output` is continuity, not work. It moves the continuity facts (first / last
   * seen, active days, streak, chain depth) and no work count, class share, facet or money fact.
   */
  readonly continuity_records: number;
  /** Distinct UTC days with at least one sealed PE. */
  readonly active_days: number;
  /** The last UTC day (yyyy-mm-dd) a PE sealed on — the streak's anchor. */
  readonly last_active_day: string | null;
  readonly streak_days: number;
  /** The best attestation rank ever sealed (see {@link attestationRank}). */
  readonly highest_attestation_rank: number;
  /** PE count by action type (bounded). */
  readonly by_type: Readonly<Record<string, number>>;
  /**
   * Adverse events by action type — rows that passed {@link countsAsAdverse}; what every
   * `standing.*` count and `money.promises_defaulted` read. NEVER `by_type`, which counts
   * every row of a type, the wronged party's included. `null` only for a document last written
   * before whose `by_type` already holds an adverse type: its split is unknown until the
   * backfill re-folds it, and the vocabulary refuses to serve it as a zero.
   */
  readonly adverse_by_type: Readonly<Record<string, number>> | null;
  /** PE count by `<family>__<witness class>` (bounded). */
  readonly by_family_class: Readonly<Record<string, number>>;
  /** Sum of tokens a NON-actor witness observed. */
  readonly witnessed_compute_tokens: number;
  /** Sum of the actor-declared token figures (recorded; prices nothing). */
  readonly declared_compute_tokens: number;
  /** Sum of `independentOriginCount` across sealed PEs (Coupling). */
  readonly independent_origins_cited: number;
  /** `pe:` consumption edges this actor cited that resolve to a `human_approval` PE (Accountability). */
  readonly approvals_cited: number;
  /** Transcript supervision totals (Accountability: human-directed share of turns). */
  readonly supervision_human_turns: number;
  readonly supervision_total_turns: number;
  /** Model FAMILIES observed on this actor's PEs (Composition), by count. */
  readonly models: Readonly<Record<string, number>>;
  /** Environment classes observed (Composition). */
  readonly environments: Readonly<Record<string, number>>;
  /** Coarse attested regions — witnessed PEs with a SEALED admitted hardware report only. */
  readonly regions: Readonly<Record<string, number>>;
  /** Attested launch measurements — witnessed PEs with a SEALED admitted hardware report only. */
  readonly measurements: Readonly<Record<string, number>>;
  /** Attested issuer roots (the pinned root fingerprint an admitted report reached) — same rule. */
  readonly issuers: Readonly<Record<string, number>>;
  /**
   * Distinct INBOUND PAYERS: the counterparty address of every chain-witnessed `receive` the
   * same-owner / shared-beneficial-owner fence PASSED (an operator moving money between its own
   * wallets never counts). Address-distinct, not identity-distinct beyond the fence.
   */
  readonly payers: Readonly<Record<string, number>>;
  /** Chain-witnessed Base USDC volume, atomic units (decimal string; BigInt-summed). */
  readonly payment_volume_atomic: string;
  /** Live history, one bucket per UTC day, pruned to the last {@link ACTOR_STATS_DAY_WINDOW_DAYS}. */
  readonly days: Readonly<Record<string, ActorStatsDayBucket>>;
  /** False when a live bump upgraded a v1 document in place (see the module note). */
  readonly history_complete: boolean;
  /**
   * what the last backfill fold of this document covered, so a bump for a row the fold
   * already counted skips WITHOUT a marker document per row (which capped a fold at one
   * transaction's worth of markers). Every row the fold read is either named in
   * `fold_recent_pe_ids` (rows young enough that their seal-time bump may still be in flight) or
   * was created (server time) before `fold_floor_ms`. Both ride the SAME write as the counters.
   * `null` / `[]` on a document no backfill has written.
   */
  readonly fold_floor_ms: number | null;
  readonly fold_recent_pe_ids: readonly string[];
  readonly updated_at_ms: number;
}

export function emptyActorStats(actorId: string): ActorStatsDoc {
  return {
    schema_version: ACTOR_STATS_SCHEMA,
    actor_id: actorId,
    first_pe_at_ms: null,
    last_pe_at_ms: null,
    pe_count: 0,
    continuity_records: 0,
    active_days: 0,
    last_active_day: null,
    streak_days: 0,
    highest_attestation_rank: 0,
    by_type: {},
    adverse_by_type: {},
    by_family_class: {},
    witnessed_compute_tokens: 0,
    declared_compute_tokens: 0,
    independent_origins_cited: 0,
    approvals_cited: 0,
    supervision_human_turns: 0,
    supervision_total_turns: 0,
    models: {},
    environments: {},
    regions: {},
    measurements: {},
    issuers: {},
    payers: {},
    payment_volume_atomic: '0',
    days: {},
    history_complete: true,
    fold_floor_ms: null,
    fold_recent_pe_ids: [],
    updated_at_ms: 0,
  };
}

export function emptyDayBucket(): ActorStatsDayBucket {
  return { n: 0, wc: {}, tok: 0, fin: 0, pay: '0', adv: 0, pf: 0, pd: 0, m: {}, e: {}, r: {}, ms: {}, inb: 0, is: {}, py: {}, cr: 0 };
}

// =============================================================================
// Composition signals — derived from a PE's metadata at each lane (metadata-only)
// =============================================================================

/** The structural signals a lane derives from the PE it is sealing. */
export interface CompositionSignals {
  readonly modelFamilies: readonly string[];
  readonly environmentClass: string | null;
  /**
   * Coarse region from the SEALED, ADMITTED hardware witness summary — retained at every witnessed lane class. Never from request metadata.
   */
  readonly hardwareRegion: string | null;
  /** The scheme's launch measurement from the SEALED, ADMITTED hardware witness (same rule). */
  readonly hardwareMeasurement: string | null;
  /** The pinned issuer root (sha256 fingerprint) the SEALED, ADMITTED report reached (same rule). */
  readonly hardwareIssuer?: string | null;
  /**
   * The inbound payer of a `receive` row the accrual's same-owner fence PASSED (set by the accrual
   * itself from the verified counterparty, never from metadata); counted under chain_witnessed only.
   */
  readonly inboundPayer?: string | null;
  /**
   * Base USDC atomic amount from VERIFIED chain evidence (`metadata.economic_evidence` passing
   * `assertBaseUsdcTransferEvidence`, `metadata.verified === true`) — set only when the lane's
   * witness class is `chain_witnessed`. A self-reported amount is never read.
   */
  readonly witnessedPaymentAtomic: string | null;
  readonly supervisionHumanTurns: number | null;
  readonly supervisionTotalTurns: number | null;
  /** `metadata.role` of a bilateral institution row (borrower / lender / depositor / recipient). */
  readonly standingRole?: string | null;
  /** True only for a Standing-watcher row of adverse polarity (`metadata.standing`, with its canonical event id). */
  readonly standingChainAdverse?: boolean;
  /**
   * True only for a relay verdict row on the LOSING escrow party whose settlement chain the Standing
   * watcher does not read (`metadata.chain_id` a number other than Base) — the one relay row that counts.
   */
  readonly standingRelayLoserOffBase?: boolean;
  /** A watcher `bond_autonomy_downgraded` row whose transaction also slashed the same agent's bond. */
  readonly standingPairedBondSlash?: boolean;
  /** A hire-dispute `escrow_resolved` row on the party the chain did not pay. */
  readonly standingHireDisputeLost?: boolean;
  /** The challenged party's own row of an upheld Commons challenge. */
  readonly standingChallengeUpheldAgainst?: boolean;
}

/** What the lane knows beyond the metadata: its relay-assigned class and the SEALED witness. */
export interface CompositionLaneContext {
  /** The relay-assigned witness class of THIS PE (never a submitter value). */
  readonly witnessClass?: WitnessClass | string | null;
  /** The sealed summary `sealedHardwareWitness()` produced for THIS PE (never the raw slot). */
  readonly sealedHardwareWitness?: unknown;
}

const KEY_RE = /^[a-z0-9_:-]{1,64}$/;
const ATOMIC_RE = /^(0|[1-9][0-9]{0,77})$/;

/** A bounded, sanitized map key — lowercase identifier characters only, or null. */
export function statsKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const k = raw.trim().toLowerCase().replace(/[^a-z0-9_:-]/g, '_').slice(0, 64);
  return KEY_RE.test(k) ? k : null;
}


/**
 * The model FAMILY of a model identifier — the vendor/series token before any version, size or
 * date suffix (`claude-sonnet-4-5` → `claude`, `gpt-4o-mini` → `gpt`, `gemini-2.5-pro` → `gemini`,
 * `meta-llama/Llama-3.1-70B` → `llama`, `anthropic/claude-3` → `claude`). Never the full id (a full
 * id can carry a private deployment name); null when nothing identifier-like is present.
 */
export function modelFamilyOf(model: unknown): string | null {
  if (typeof model !== 'string') return null;
  const lowered = model.trim().toLowerCase();
  if (lowered.length === 0) return null;
  // Drop a provider/org prefix (`anthropic/…`, `openai:…`).
  const tail = lowered.split(/[/:]/).filter((s) => s.length > 0).pop() ?? '';
  // Well-known families whose ids embed the family after a vendor token.
  for (const fam of ['claude', 'gpt', 'gemini', 'llama', 'mistral', 'mixtral', 'qwen', 'deepseek', 'grok', 'command', 'phi', 'o1', 'o3', 'o4']) {
    if (tail === fam || tail.startsWith(`${fam}-`) || tail.startsWith(`${fam}_`) || tail.startsWith(`${fam}.`)) return fam;
  }
  const first = tail.split(/[-_.\s]/)[0] ?? '';
  const fam = first.replace(/[0-9]+$/, '');
  return statsKey(fam.length > 0 ? fam : first);
}

function readNonNegInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
}


/**
 * The attested facts of a SEALED hardware witness — only when the relay-assigned class is
 * server-verified and the sealed summary itself says `admitted === true`, regardless of price
 * class. Anything else (a raw
 * request slot, a present-but-unverifiable report, a client-declared region) yields nothing.
 */
export function attestedHardwareFacts(
  witnessClass: unknown,
  sealed: unknown,
): { region: string | null; measurement: string | null; issuer: string | null } {
  const hw = asRecord(sealed);
  if (!hw || hw.admitted !== true) return { region: null, measurement: null, issuer: null };
  return { region: statsKey(hw.region), measurement: hardwareMeasurementOf(hw), issuer: issuerKey(hw.issuer_root_fingerprint) };
}

const ISSUER_RE = /^[0-9a-f]{64}$/;

/** A pinned-root fingerprint (sha256 hex) as a facet key, or null. */
export function issuerKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const k = raw.trim().toLowerCase();
  return ISSUER_RE.test(k) ? k : null;
}

/**
 * The payer facet key of a `receive` row: its verified counterparty address, only when the caller's
 * same-owner fence PASSED (`independent`). Null for every other action type.
 */
export function inboundPayerKey(actionType: string, counterparty: string | null | undefined, independent: boolean): string | null {
  if (!independent || !INBOUND_FINANCIAL_TYPES.includes(actionType)) return null;
  return statsKey(normalizeCounterparty(counterparty));
}

/** The composition signals with the accrual's inbound payer attached (a null payer changes nothing). */
export function withInboundPayer(comp: CompositionSignals | null, payer: string | null): CompositionSignals | null {
  if (payer === null) return comp;
  return { ...(comp ?? EMPTY_COMPOSITION), inboundPayer: payer };
}

const EMPTY_COMPOSITION: CompositionSignals = Object.freeze({
  modelFamilies: [], environmentClass: null, hardwareRegion: null, hardwareMeasurement: null,
  witnessedPaymentAtomic: null, supervisionHumanTurns: null, supervisionTotalTurns: null,
});

/**
 * The chain-witnessed Base USDC amount (atomic) of a PE — only when the relay-assigned class is
 * `chain_witnessed`, `metadata.verified === true`, and `metadata.economic_evidence` passes the full
 * `assertBaseUsdcTransferEvidence` check (Base, USDC token address, two-operator quorum, evidence
 * hash). A self-reported `amountAtomic` (sovereign x402, device metadata) is never read.
 */
export function chainWitnessedUsdcAtomic(witnessClass: unknown, metadata: unknown): string | null {
  const md = asRecord(metadata);
  if (witnessClass !== 'chain_witnessed' || !md || md.verified !== true) return null;
  try {
    const evidence = assertBaseUsdcTransferEvidence(md.economic_evidence as Parameters<typeof assertBaseUsdcTransferEvidence>[0]);
    return ATOMIC_RE.test(evidence.amountAtomic) ? evidence.amountAtomic : null;
  } catch {
    return null;
  }
}

/**
 * Derive the composition signals from a PE's metadata + execution environment + the lane's own
 * context. Reads ONLY the one-field-away signals the lanes already record (§2.11):
 * `metadata.model`, `metadata.inference.models[]`, `execution_env.environment_class`,
 * `metadata.supervision.{human_opened_turns,total_turns}`; the attested region / measurement come
 * ONLY from `lane.sealedHardwareWitness` under a witnessed lane class (a `hardware_witness` key in
 * the metadata is ignored — it may be the raw request slot), and the witnessed payment ONLY from
 * verified evidence under a `chain_witnessed` class. Null when nothing is present.
 */
export function deriveCompositionSignals(
  metadata: unknown,
  executionEnv: unknown,
  lane: CompositionLaneContext = {},
): CompositionSignals | null {
  const md = asRecord(metadata) ?? {};
  const env = asRecord(executionEnv) ?? {};

  const families = new Set<string>();
  const one = modelFamilyOf(md.model);
  if (one) families.add(one);
  const inference = asRecord(md.inference);
  const models = Array.isArray(inference?.models) ? inference!.models as unknown[] : (Array.isArray(md.models) ? md.models as unknown[] : []);
  for (const m of models.slice(0, 16)) {
    const f = modelFamilyOf(typeof m === 'string' ? m : asRecord(m)?.model);
    if (f) families.add(f);
  }

  const environmentClass = statsKey(env.environment_class ?? md.environment_class);
  const attested = attestedHardwareFacts(lane.witnessClass ?? null, lane.sealedHardwareWitness);
  const witnessedPaymentAtomic = chainWitnessedUsdcAtomic(lane.witnessClass ?? null, md);

  const sup = asRecord(md.supervision);
  const supervisionHumanTurns = readNonNegInt(sup?.human_opened_turns);
  const supervisionTotalTurns = readNonNegInt(sup?.total_turns);

  const standingRole = statsKey(md.role);
  const standingChainAdverse = md.standing === 'adverse'
    && typeof md.canonical_event_id === 'string' && md.canonical_event_id.length > 0;
  const lostVerdict = (md.role === 'depositor' && md.verdict === 'release_to_recipient')
    || (md.role === 'recipient' && md.verdict === 'refund_to_depositor');
  const standingRelayLoserOffBase = lostVerdict
    && typeof md.chain_id === 'number' && Number.isSafeInteger(md.chain_id) && md.chain_id !== STANDING_WATCHED_CHAIN_ID;
  const standingPairedBondSlash = standingChainAdverse && md.paired_bond_slash === true;
  const lostResolution = (md.role === 'depositor' && md.resolution === 'release_to_recipient')
    || (md.role === 'recipient' && md.resolution === 'refund_to_depositor');
  const standingHireDisputeLost = lostResolution && typeof md.hire_job_id === 'string' && md.hire_job_id.length > 0;
  const standingChallengeUpheldAgainst = md.role === 'challenged' && md.status === 'upheld'
    && typeof md.challenge_id === 'string' && md.challenge_id.length > 0;

  if (families.size === 0 && environmentClass === null && attested.region === null && attested.measurement === null
    && attested.issuer === null && witnessedPaymentAtomic === null && supervisionTotalTurns === null
    && standingRole === null && !standingChainAdverse) {
    return null;
  }
  return {
    ...(standingRole !== null ? { standingRole } : {}),
    ...(standingChainAdverse ? { standingChainAdverse } : {}),
    ...(standingRelayLoserOffBase ? { standingRelayLoserOffBase } : {}),
    ...(standingPairedBondSlash ? { standingPairedBondSlash } : {}),
    ...(standingHireDisputeLost ? { standingHireDisputeLost } : {}),
    ...(standingChallengeUpheldAgainst ? { standingChallengeUpheldAgainst } : {}),
    modelFamilies: [...families].sort(),
    environmentClass,
    hardwareRegion: attested.region,
    hardwareMeasurement: attested.measurement,
    hardwareIssuer: attested.issuer,
    witnessedPaymentAtomic,
    supervisionHumanTurns: supervisionTotalTurns === null ? null : (supervisionHumanTurns ?? 0),
    supervisionTotalTurns,
  };
}

// =============================================================================
// Attestation rank
// =============================================================================

/** Numeric rank of an attestation tier (0 = unknown/none … 5 = hardware_full) — for "highest tier". */
export function attestationRank(tier: unknown): number {
  switch (typeof tier === 'string' ? tier : '') {
    case 'hardware_full': return 5;
    case 'hardware_partial': return 4;
    case 'corroborated': return 3;
    case 'software_verified': return 2;
    case 'software': return 1;
    default: return 0;
  }
}

// =============================================================================
// The bump — one transaction per sealed PE
// =============================================================================

export interface ActorStatsBump {
  readonly actorId: string;
  /** The sealed PE this bump counts — the idempotence key (`actor_stats_applied/{peId}`). */
  readonly peId?: string | null;
  /**
   * The pe_history row's server creation time, when the caller READ the row (the Standing
   * reconcile). A row created before the document's `fold_floor_ms` was counted by that fold. The
   * seal-time bump never sets it: its row is new, so it is either in the fold's recent list or
   * was written after the fold read the ledger.
   */
  readonly rowCreateTimeMs?: number | null;
  readonly actionType: string;
  /** The action's family (the accrual's `PVTCategory` / the matrix category). */
  readonly family: string;
  readonly witnessClass: WitnessClass | string;
  readonly timestampMs: number;
  readonly attestationTier: string | null;
  readonly witnessObservedTokens: number | null;
  readonly bodyDeclaredTokens: number | null;
  readonly independentOriginCount: number;
  readonly approvalsCited: number;
  readonly composition: CompositionSignals | null;
  /**
   * True for a chain-continuity record ({@link isContinuityStatsRow}): the bump moves the continuity
   * facts only. Absent / false for every act of work.
   */
  readonly continuity?: boolean;
}

/**
 * the standing rule : an idle `compute_session` continuity record is continuity, not work.
 * The SAME predicate as 's `isChainContinuityRecord` (`core/meter/meter-seal.ts`), read off a
 * sealed row: a `compute_session` sealed `skipped_no_output`. Its minting treatment is 's,
 * unchanged; this decides only which counters it moves.
 */
export function isContinuityStatsRow(row: Readonly<Record<string, unknown>>): boolean {
  return row.actionType === 'compute_session' && row.mint_status === 'skipped_no_output';
}

export function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The oldest UTC day a window of `days` days (today included) reaches, relative to `nowMs`. */
export function windowStartDay(nowMs: number, days: number): string {
  return utcDayKey(nowMs - (Math.max(1, days) - 1) * DAY_MS);
}

function bumpKey(
  map: Readonly<Record<string, number>>,
  key: string | null,
  cap: number,
  exempt?: ReadonlySet<string>,
): Record<string, number> {
  const next: Record<string, number> = { ...map };
  if (key === null) return next;
  if (!(key in next) && Object.keys(next).length >= cap && !(exempt?.has(key) ?? false)) return next;
  next[key] = (next[key] ?? 0) + 1;
  return next;
}

function addAtomic(a: string, b: string | null): string {
  if (b === null || !ATOMIC_RE.test(b)) return a;
  const base = ATOMIC_RE.test(a) ? BigInt(a) : 0n;
  return (base + BigInt(b)).toString();
}

function readAtomicSignal(v: unknown): string | null {
  return typeof v === 'string' && ATOMIC_RE.test(v) ? v : null;
}

/** Drop day buckets older than the retained window (relative to `nowMs`). */
function pruneDays(days: Readonly<Record<string, ActorStatsDayBucket>>, oldestDay: string): Record<string, ActorStatsDayBucket> {
  const out: Record<string, ActorStatsDayBucket> = {};
  for (const [day, bucket] of Object.entries(days)) if (day >= oldestDay) out[day] = bucket;
  return out;
}

/**
 * The types that counted as adverse BY TYPE ALONE before the only rows whose split a
 * pre- document cannot state. Fixed history, not the live Standing set: the loser-only
 * types (`escrow_resolved`, `commons_challenge_resolved`) never counted before they carried their
 * loser metadata, so a document holding them is not "unknown".
 */
export const PRE_SPLIT_ADVERSE_TYPES: ReadonlySet<string> = new Set([
  'bond_slashed', 'bond_abandoned', 'bond_abandonment_processed', 'bond_expired_processed',
  'bond_autonomy_downgraded', 'bond_claim_dismissed', 'court_verdict', 'court_arbitrator_seat_forfeited',
  'court_arbitrator_collateral_slashed', 'promise_defaulted', 'promise_broken', 'pvt_reputation_slashed',
]);

/** True when a `by_type` map holds any adverse action type (a pre- document's unknown split). */
export function hasAdverseTypeKey(byType: Readonly<Record<string, number>>): boolean {
  for (const t of PRE_SPLIT_ADVERSE_TYPES) if ((byType[t] ?? 0) > 0) return true;
  return false;
}

/** Pure: apply one bump to a stats document. Exported for the suite and the backfill. */
export function applyActorStatsBump(current: ActorStatsDoc, bump: ActorStatsBump, nowMs: number): ActorStatsDoc {
  const ts = Number.isSafeInteger(bump.timestampMs) && bump.timestampMs > 0 ? bump.timestampMs : nowMs;
  const day = utcDayKey(ts);
  let activeDays = current.active_days;
  let streak = current.streak_days;
  let lastDay = current.last_active_day;
  if (lastDay === null) {
    activeDays = 1; streak = 1; lastDay = day;
  } else if (day > lastDay) {
    activeDays += 1;
    const prev = utcDayKey(Date.parse(`${lastDay}T00:00:00Z`) + DAY_MS);
    streak = prev === day ? streak + 1 : 1;
    lastDay = day;
  } else if (day < lastDay) {
    // A backfilled / late row from an earlier day: it counts as activity but never rewinds the anchor.
    activeDays += 0;
  }
  if (bump.continuity === true) {
    // Continuity, not work : seen times, active days, streak, the day's activity
    // and the continuity count. No work count, class, facet, token, money or standing counter moves.
    const oldest = windowStartDay(nowMs, ACTOR_STATS_DAY_WINDOW_DAYS);
    const cDay = utcDayKey(Math.min(ts, nowMs));
    const cDays = pruneDays(current.days, oldest);
    if (cDay >= oldest) {
      const b = cDays[cDay] ?? emptyDayBucket();
      cDays[cDay] = { ...b, cr: b.cr + 1 };
    }
    return {
      ...current,
      schema_version: ACTOR_STATS_SCHEMA,
      first_pe_at_ms: current.first_pe_at_ms === null ? ts : Math.min(current.first_pe_at_ms, ts),
      last_pe_at_ms: current.last_pe_at_ms === null ? ts : Math.max(current.last_pe_at_ms, ts),
      continuity_records: current.continuity_records + 1,
      active_days: activeDays,
      last_active_day: lastDay,
      streak_days: streak,
      highest_attestation_rank: Math.max(current.highest_attestation_rank, attestationRank(bump.attestationTier)),
      days: cDays,
      updated_at_ms: nowMs,
    };
  }
  const cls = normalizeWitnessClass(bump.witnessClass);
  const family = statsKey(bump.family) ?? 'other';
  const typeKey = statsKey(bump.actionType);
  const witnessed = cls !== 'actor_declared';
  const comp = bump.composition;
  // Attested facts count at every witnessed lane class (the lane already
  // required the SEALED summary's `admitted === true`); witnessed payment ONLY under chain_witnessed.
  const region = statsKey(comp?.hardwareRegion ?? null);
  const measurement = measurementKey(comp?.hardwareMeasurement ?? null);
  const issuer = issuerKey(comp?.hardwareIssuer ?? null);
  // A payer is counted only on a chain-witnessed row (the accrual already applied the same-owner fence).
  const payer = cls === 'chain_witnessed' ? statsKey(comp?.inboundPayer ?? null) : null;
  const inbound = typeKey !== null && INBOUND_FINANCIAL_TYPES.includes(typeKey) ? 1 : 0;
  const payAtomic = cls === 'chain_witnessed' ? readAtomicSignal(comp?.witnessedPaymentAtomic ?? null) : null;
  const witnessedTokens = witnessed ? (readNonNegInt(bump.witnessObservedTokens) ?? 0) : 0;
  const financial = FINANCIAL_FAMILIES.has(family) && witnessed ? 1 : 0;
  const adverse = countsAsAdverse(typeKey, comp) ? 1 : 0;
  const fulfilled = typeKey !== null && PROMISE_FULFILLED_TYPES.includes(typeKey) ? 1 : 0;
  // A default counts against the party at fault only (the lender's row of the same default is a record).
  const defaulted = adverse === 1 && typeKey !== null && PROMISE_DEFAULTED_TYPES.includes(typeKey) ? 1 : 0;
  // A pre- document that already holds an adverse type has an unknown split: it stays null
  // (the vocabulary refuses it) until the backfill re-folds it. Every other document starts at {}.
  const adverseBase = current.adverse_by_type ?? (hasAdverseTypeKey(current.by_type) ? null : {});
  const adverseByType = adverseBase === null
    ? null
    : (adverse === 1 ? bumpKey(adverseBase, typeKey, ACTOR_STATS_MAX_TYPE_KEYS, VOCABULARY_NAMED_TYPES) : adverseBase);
  const modelKeys = (comp?.modelFamilies ?? []).map((f) => statsKey(f)).filter((k): k is string => k !== null);
  const envKey = statsKey(comp?.environmentClass ?? null);

  let models = current.models;
  for (const k of modelKeys) models = bumpKey(models, k, ACTOR_STATS_MAX_FACET_KEYS);

  // Live history: bucket on the declared day, never in the future (a forward-dated body is clamped
  // to the seal time), and only inside the retained window.
  const oldestDay = windowStartDay(nowMs, ACTOR_STATS_DAY_WINDOW_DAYS);
  const bucketDay = utcDayKey(Math.min(ts, nowMs));
  const days = pruneDays(current.days, oldestDay);
  if (bucketDay >= oldestDay) {
    const b = days[bucketDay] ?? emptyDayBucket();
    let m = b.m;
    for (const k of modelKeys) m = bumpKey(m, k, ACTOR_STATS_MAX_DAY_FACET_KEYS);
    days[bucketDay] = {
      n: b.n + 1,
      wc: bumpKey(b.wc, cls, ACTOR_STATS_MAX_DAY_FACET_KEYS),
      tok: b.tok + witnessedTokens,
      fin: b.fin + financial,
      pay: addAtomic(b.pay, payAtomic),
      adv: b.adv + adverse,
      pf: b.pf + fulfilled,
      pd: b.pd + defaulted,
      m,
      e: bumpKey(b.e, envKey, ACTOR_STATS_MAX_DAY_FACET_KEYS),
      r: bumpKey(b.r, region, ACTOR_STATS_MAX_DAY_FACET_KEYS),
      ms: bumpKey(b.ms, measurement, ACTOR_STATS_MAX_DAY_MEASUREMENT_KEYS),
      inb: b.inb + inbound,
      is: bumpKey(b.is, issuer, ACTOR_STATS_MAX_DAY_ISSUER_KEYS),
      py: bumpKey(b.py, payer, ACTOR_STATS_MAX_DAY_PAYER_KEYS),
      cr: b.cr,
    };
  }

  return {
    ...current,
    schema_version: ACTOR_STATS_SCHEMA,
    first_pe_at_ms: current.first_pe_at_ms === null ? ts : Math.min(current.first_pe_at_ms, ts),
    last_pe_at_ms: current.last_pe_at_ms === null ? ts : Math.max(current.last_pe_at_ms, ts),
    pe_count: current.pe_count + 1,
    active_days: activeDays,
    last_active_day: lastDay,
    streak_days: streak,
    highest_attestation_rank: Math.max(current.highest_attestation_rank, attestationRank(bump.attestationTier)),
    by_type: bumpKey(current.by_type, typeKey, ACTOR_STATS_MAX_TYPE_KEYS, VOCABULARY_NAMED_TYPES),
    adverse_by_type: adverseByType,
    by_family_class: bumpKey(current.by_family_class, `${family}__${cls}`, ACTOR_STATS_MAX_FACET_KEYS),
    witnessed_compute_tokens: current.witnessed_compute_tokens + witnessedTokens,
    declared_compute_tokens: current.declared_compute_tokens + (readNonNegInt(bump.bodyDeclaredTokens) ?? 0),
    independent_origins_cited: current.independent_origins_cited + (readNonNegInt(bump.independentOriginCount) ?? 0),
    approvals_cited: current.approvals_cited + (readNonNegInt(bump.approvalsCited) ?? 0),
    supervision_human_turns: current.supervision_human_turns + (readNonNegInt(comp?.supervisionHumanTurns) ?? 0),
    supervision_total_turns: current.supervision_total_turns + (readNonNegInt(comp?.supervisionTotalTurns) ?? 0),
    models,
    environments: bumpKey(current.environments, envKey, ACTOR_STATS_MAX_FACET_KEYS),
    regions: bumpKey(current.regions, region, ACTOR_STATS_MAX_FACET_KEYS),
    measurements: bumpKey(current.measurements, measurement, ACTOR_STATS_MAX_FACET_KEYS),
    issuers: bumpKey(current.issuers, issuer, ACTOR_STATS_MAX_FACET_KEYS),
    payers: bumpKey(current.payers, payer, ACTOR_STATS_MAX_PAYER_KEYS),
    payment_volume_atomic: addAtomic(current.payment_volume_atomic, payAtomic),
    days,
    updated_at_ms: nowMs,
  };
}

// =============================================================================
// Persistence (day buckets as compact JSON strings)
// =============================================================================

function numMap(v: unknown): Record<string, number> {
  const r = asRecord(v);
  if (!r) return {};
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(r)) if (typeof n === 'number' && Number.isFinite(n)) out[k] = n;
  return out;
}

function nonEmpty(m: Readonly<Record<string, number>>): boolean {
  return Object.keys(m).length > 0;
}

/** The compact persisted form of one bucket (zero / empty members omitted; fixed key order). */
export function encodeDayBucket(b: ActorStatsDayBucket): string {
  const o: Record<string, unknown> = { n: b.n };
  if (nonEmpty(b.wc)) o.wc = b.wc;
  if (b.tok) o.tok = b.tok;
  if (b.fin) o.fin = b.fin;
  if (b.pay !== '0') o.pay = b.pay;
  if (b.adv) o.adv = b.adv;
  if (b.pf) o.pf = b.pf;
  if (b.pd) o.pd = b.pd;
  if (nonEmpty(b.m)) o.m = b.m;
  if (nonEmpty(b.e)) o.e = b.e;
  if (nonEmpty(b.r)) o.r = b.r;
  if (nonEmpty(b.ms)) o.ms = b.ms;
  if (b.inb) o.inb = b.inb;
  if (nonEmpty(b.is)) o.is = b.is;
  if (nonEmpty(b.py)) o.py = b.py;
  if (b.cr) o.cr = b.cr;
  return JSON.stringify(o);
}

/** Decode one persisted bucket (a JSON string, or an object — tolerant of either). */
export function decodeDayBucket(raw: unknown): ActorStatsDayBucket | null {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try { v = JSON.parse(raw); } catch { return null; }
  }
  const o = asRecord(v);
  if (!o) return null;
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0);
  return {
    n: n(o.n),
    wc: numMap(o.wc),
    tok: n(o.tok),
    fin: n(o.fin),
    pay: readAtomicSignal(o.pay) ?? '0',
    adv: n(o.adv),
    pf: n(o.pf),
    pd: n(o.pd),
    m: numMap(o.m),
    e: numMap(o.e),
    r: numMap(o.r),
    ms: numMap(o.ms),
    inb: n(o.inb),
    is: numMap(o.is),
    py: numMap(o.py),
    cr: n(o.cr),
  };
}

/** The Firestore document for a stats doc (the day buckets encoded as strings). */
export function serializeActorStats(doc: ActorStatsDoc): Record<string, unknown> {
  const days: Record<string, string> = {};
  for (const [day, bucket] of Object.entries(doc.days)) days[day] = encodeDayBucket(bucket);
  return { ...doc, days };
}

function coerceStats(actorId: string, raw: unknown): ActorStatsDoc {
  const base = emptyActorStats(actorId);
  const d = asRecord(raw);
  if (!d) return base;
  const num = (v: unknown, dflt: number) => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);
  const isV2 = d.schema_version === ACTOR_STATS_SCHEMA;
  const days: Record<string, ActorStatsDayBucket> = {};
  if (isV2) {
    for (const [day, bucket] of Object.entries(asRecord(d.days) ?? {})) {
      const decoded = /^\d{4}-\d{2}-\d{2}$/.test(day) ? decodeDayBucket(bucket) : null;
      if (decoded) days[day] = decoded;
    }
  }
  return {
    ...base,
    first_pe_at_ms: typeof d.first_pe_at_ms === 'number' ? d.first_pe_at_ms : null,
    last_pe_at_ms: typeof d.last_pe_at_ms === 'number' ? d.last_pe_at_ms : null,
    pe_count: num(d.pe_count, 0),
    continuity_records: num(d.continuity_records, 0),
    active_days: num(d.active_days, 0),
    last_active_day: typeof d.last_active_day === 'string' ? d.last_active_day : null,
    streak_days: num(d.streak_days, 0),
    highest_attestation_rank: num(d.highest_attestation_rank, 0),
    by_type: numMap(d.by_type),
    // Absent on a document last written before {} when it holds no adverse type (an observed
    // zero), null when it does (unknown split — see ActorStatsDoc.adverse_by_type).
    adverse_by_type: asRecord(d.adverse_by_type)
      ? numMap(d.adverse_by_type)
      : (hasAdverseTypeKey(numMap(d.by_type)) ? null : {}),
    by_family_class: numMap(d.by_family_class),
    witnessed_compute_tokens: num(d.witnessed_compute_tokens, 0),
    declared_compute_tokens: num(d.declared_compute_tokens, 0),
    independent_origins_cited: num(d.independent_origins_cited, 0),
    approvals_cited: num(d.approvals_cited, 0),
    supervision_human_turns: num(d.supervision_human_turns, 0),
    supervision_total_turns: num(d.supervision_total_turns, 0),
    models: numMap(d.models),
    environments: numMap(d.environments),
    // A v1 document's regions were read from request metadata (client-forgeable) — dropped on
    // upgrade; the backfill rebuilds them from sealed witnesses only.
    regions: isV2 ? numMap(d.regions) : {},
    measurements: isV2 ? numMap(d.measurements) : {},
    issuers: isV2 ? numMap(d.issuers) : {},
    payers: isV2 ? numMap(d.payers) : {},
    payment_volume_atomic: isV2 ? (readAtomicSignal(d.payment_volume_atomic) ?? '0') : '0',
    days,
    // A v1 document (or a v2 one not marked complete) has no complete v2 history.
    history_complete: isV2 && d.history_complete === true,
    fold_floor_ms: typeof d.fold_floor_ms === 'number' && Number.isFinite(d.fold_floor_ms) ? d.fold_floor_ms : null,
    fold_recent_pe_ids: Array.isArray(d.fold_recent_pe_ids)
      ? (d.fold_recent_pe_ids as unknown[]).filter((x): x is string => typeof x === 'string')
      : [],
    updated_at_ms: num(d.updated_at_ms, 0),
  };
}

/**
 * Bump the actor's stats for one sealed PE, transactionally (read → apply → set). Throws on a
 * Firestore failure; the accrual wraps it as best-effort (a stats failure never fails a seal).
 */
/**
 * Per-PE idempotence markers. A live bump writes `actor_stats_applied/{peId}` in the
 * same transaction as the counters and SKIPS when the marker already exists — which it does when the
 * backfill already folded that PE (the backfill writes the markers of every recently-sealed row it
 * folded, atomically with its document write), or when the same PE was bumped before.
 */
export const ACTOR_STATS_APPLIED_COLLECTION = 'actor_stats_applied';

export async function bumpActorStats(db: Firestore, bump: ActorStatsBump, nowMs: number = Date.now()): Promise<ActorStatsDoc> {
  return (await bumpActorStatsWithOutcome(db, bump, nowMs)).doc;
}

/** Pure: did the document's last backfill fold already count this row? */
export function countedByFold(current: ActorStatsDoc, bump: Pick<ActorStatsBump, 'peId' | 'rowCreateTimeMs'>): boolean {
  if (typeof bump.peId === 'string' && current.fold_recent_pe_ids.includes(bump.peId)) return true;
  return current.fold_floor_ms !== null
    && typeof bump.rowCreateTimeMs === 'number' && Number.isFinite(bump.rowCreateTimeMs)
    && bump.rowCreateTimeMs < current.fold_floor_ms;
}

/**
 * The bump, reporting whether THIS call counted the row (`applied`) or found it already counted —
 * by an earlier bump's marker or by the backfill's fold. The Standing reconcile reads `applied` so a
 * seal-time bump that lands in the same moment is not reported as a repair.
 */
export async function bumpActorStatsWithOutcome(
  db: Firestore,
  bump: ActorStatsBump,
  nowMs: number = Date.now(),
): Promise<{ doc: ActorStatsDoc; applied: boolean }> {
  if (!bump.actorId) throw new Error('actor_stats_bump_missing_actor');
  const ref = db.collection(ACTOR_STATS_COLLECTION).doc(bump.actorId);
  const markerRef = typeof bump.peId === 'string' && bump.peId.length > 0
    ? db.collection(ACTOR_STATS_APPLIED_COLLECTION).doc(bump.peId)
    : null;
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const marker = markerRef ? await txn.get(markerRef) : null;
    const current = coerceStats(bump.actorId, snap.exists ? snap.data() : null);
    if (marker?.exists) return { doc: current, applied: false }; // a prior bump counted it
    if (countedByFold(current, bump)) {
      // The backfill's fold counted it. Leave a marker so later passes settle on one read.
      if (markerRef) txn.set(markerRef, { actor_id: bump.actorId, by: 'fold', at_ms: nowMs });
      return { doc: current, applied: false };
    }
    const next = applyActorStatsBump(current, bump, nowMs);
    txn.set(ref, serializeActorStats(next));
    if (markerRef) txn.set(markerRef, { actor_id: bump.actorId, by: 'bump', at_ms: nowMs });
    return { doc: next, applied: true };
  });
}

/**
 * Read an actor's stats, or an empty (complete, all-zero) document when none has been written —
 * a missing document is an OBSERVED zero. Throws on a read failure (never a silent zero).
 */
export async function readActorStats(db: Firestore, actorId: string): Promise<ActorStatsDoc> {
  const snap = await db.collection(ACTOR_STATS_COLLECTION).doc(actorId).get();
  return coerceStats(actorId, snap.exists ? snap.data() : null);
}

/** Pure: decode a raw stored document (the backfill's live-doc read and the suites). */
export function coerceActorStats(actorId: string, raw: unknown): ActorStatsDoc {
  return coerceStats(actorId, raw);
}
