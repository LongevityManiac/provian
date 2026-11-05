/**
 * The reputation VOCABULARY (Trust Layer build §2.5, run-log ) — the reputation tier's
 * disclosable set, computed LIVE per actor, identical shape for agents and humans, every field a
 * number (metadata only). Sources: `actor_stats_v1` (incrementally maintained at seal), the ONE
 * reference graph's forward + reverse indexes, the institutions (bonds / claims / invalidations),
 * the wallet documents, and the produced-presentation count.
 *
 * continuity.* first seen, chain depth, active days (+ 30/90/365-day windows), streak,
 * registered devices, highest tier
 * work.* PE counts by family × witness class; totals, witnessed, hardware-rooted and
 * witnessed compute volume (+ windows)
 * share.* share of work in bps by witness class / model family / environment class /
 * attested region / attested launch measurement (lifetime + windows)
 * coupling.* independent origins cited; distinct / independent owners
 * consumption.* independent parties who built on this actor's outputs; edge count
 * money.* witnessed financial acts; witnessed inbound payments (`receive` rows, which only
 * the chain lanes derive); escrows completed as provider; promises fulfilled +
 * rate (+ windows); witnessed payment volume (PREDICATE-ONLY, never disclosed raw)
 * standing.* adverse events by type (+ windowed total); bond status; invalidation. ALWAYS
 * PRESENT — never redactable by the presenter ({@link isStandingField}).
 * accountability.* human beneficiary attached; human-directed share of turns; approvals cited/given
 * composition.* model families used; environment classes; attested regions; attested launch
 * measurements
 * presentations.* produced (lifetime, recent, windows)
 * actor.* kind
 *
 * FAIL CLOSED (item 2): every source read either succeeds or throws
 * {@link VocabularyUnavailableError} naming the source — a zero in any fact, every `standing.*`
 * field included, is an OBSERVED zero, never a read failure. A MISSING document is an observed zero
 * (an actor with no stats document has sealed nothing). A stats document whose v2 history is not
 * complete (a v1 document upgraded in place, not yet backfilled) is unavailable, not zero.
 *
 * NEVER-SEEN KEYS (item 5): the dynamic families (`work.<family>.<class>`,
 * `composition.<facet>.<key>`, `share.<dim>[_<window>].<key>`) materialize only the keys that
 * occurred. A field that matches one of {@link DYNAMIC_FIELD_PATTERNS} but did not occur reads 0 —
 * see {@link isKnownVocabularyField}. A field matching no fixed name and no pattern is refused.
 *
 * `governance_score` does not exist here; nothing references it.
 */

import type { Firestore } from 'firebase-admin/firestore';
import {
  readActorStats,
  utcDayKey,
  windowStartDay,
  FINANCIAL_FAMILIES as ACTOR_FINANCIAL_FAMILIES,
  STANDING_TYPE_FIELDS,
  PROMISE_DEFAULTED_TYPES,
  ESCROW_COMPLETED_TYPES,
  HUMAN_APPROVAL_TYPES,
  INBOUND_FINANCIAL_TYPES,
  PROMISE_FULFILLED_TYPES,
  type ActorStatsDayBucket,
  type ActorStatsDoc,
} from '../pvt/actor-stats';
import {
  readActorConsumption,
  readSignerCitedOwners,
  summarizeConsumption,
  type ConsumptionSummary,
  type OriginEdge,
  type SignerOutEdges,
} from '../pvt/origin-reference-graph';
import { countPresentationsProducedSince, PRESENTATION_ACTIVITY_RECENT_WINDOW_MS } from '../commons/presentation-activity';
import { readInvalidationFloorStrict } from '../rail/invalidation';
import { WITNESS_CLASSES } from '../pvt/policy/evidence-class';
import {
  isPredicateOnlyField,
  PAYMENT_VOLUME_FIELD,
  PREDICATE_ONLY_FIELDS,
  VOCABULARY_FIELD_MAX_LENGTH,
  VOCABULARY_WINDOWS,
  windowSuffix,
  type VocabularyWindow,
} from './vocabulary-fields';

/** The relay-side adverse rows (the chain-witnessed ones come from the Standing watcher's set). */
export const RELAY_ADVERSE_ACTION_TYPES: ReadonlySet<string> = new Set([
  'bond_expired_processed', 'promise_broken', 'promise_defaulted',
  'pvt_reputation_slashed',
]);

export const FINANCIAL_FAMILIES: ReadonlySet<string> = ACTOR_FINANCIAL_FAMILIES;

export {
  STANDING_FIELD_PREFIX,
  isStandingField,
  VOCABULARY_WINDOWS,
  windowSuffix,
  VOCABULARY_FIELD_MAX_LENGTH,
  PAYMENT_VOLUME_FIELD,
  PREDICATE_ONLY_FIELDS,
  PREDICATE_ONLY_OPS,
  isPredicateOnlyField,
  DYNAMIC_FIELD_PATTERNS,
  NEVER_SEEN_KEY_RULE,
  matchesDynamicFieldPattern,
  isKnownVocabularyField,
  WINDOWED_FACT_BASES,
} from './vocabulary-fields';
export type { VocabularyWindow, DynamicFieldPattern } from './vocabulary-fields';

// =============================================================================
// Fail-closed reads
// =============================================================================

/** A vocabulary source could not be read — no presentation (and no gate) may proceed on it. */
export class VocabularyUnavailableError extends Error {
  readonly source: string;
  readonly detail: string;
  constructor(source: string, detail: string = '') {
    super(`vocabulary_source_unavailable:${source}${detail ? ` (${detail})` : ''}`);
    this.name = 'VocabularyUnavailableError';
    this.source = source;
    this.detail = detail;
  }
}

export function isVocabularyUnavailableError(err: unknown): err is VocabularyUnavailableError {
  return err instanceof VocabularyUnavailableError;
}

async function strictRead<T>(source: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof VocabularyUnavailableError) throw err;
    throw new VocabularyUnavailableError(source, err instanceof Error ? err.message : String(err));
  }
}

export interface VocabularyPrincipal {
  readonly kind: 'agent' | 'human';
  readonly walletId: string;
  /** The `pe_history` userId / economic actor id (agent_id for an agent, user_id for a human). */
  readonly peOwnerUserId: string;
  readonly address: string;
}

export type VocabularyFacts = Readonly<Record<string, number>>;

export interface VocabularyDeps {
  readonly db: Firestore;
  readonly nowMs?: number;
}

/** `.count()` over equality clauses; throws on a read failure or a malformed aggregate. */
async function countWhere(db: Firestore, source: string, collection: string, clauses: ReadonlyArray<readonly [string, string]>): Promise<number> {
  return strictRead(source, async () => {
    let q: FirebaseFirestore.Query = db.collection(collection);
    for (const [f, v] of clauses) q = q.where(f, '==', v);
    const agg = await (q as unknown as { count(): { get(): Promise<{ data(): { count?: unknown } }> } }).count().get();
    const c = agg.data().count;
    if (typeof c !== 'number' || !Number.isSafeInteger(c) || c < 0) throw new Error(`malformed_count:${collection}`);
    return c;
  });
}

function sumTypes(stats: ActorStatsDoc, types: readonly string[]): number {
  let n = 0;
  for (const t of types) n += stats.by_type[t] ?? 0;
  return n;
}

// =============================================================================
// Pure assembly
// =============================================================================

const USDC_ATOMIC_PER_USD = 1_000_000n;

/** Atomic USDC (6 decimals, decimal string) → USD as a number (exact to the cent and beyond). */
export function atomicUsdcToUsdNumber(atomic: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(atomic)) return 0;
  const v = BigInt(atomic);
  return Number(v / USDC_ATOMIC_PER_USD) + Number(v % USDC_ATOMIC_PER_USD) / 1e6;
}

/** floor(count × 10000 / total); 0 when total is 0. */
export function shareBps(count: number, total: number): number {
  if (!(total > 0) || !(count > 0)) return 0;
  return Math.min(10_000, Math.floor((count * 10_000) / total));
}

function rateBps(fulfilled: number, defaulted: number): number {
  return fulfilled + defaulted > 0 ? Math.round((fulfilled * 10_000) / (fulfilled + defaulted)) : 0;
}

function bucketsIn(stats: ActorStatsDoc, nowMs: number, w: number): ActorStatsDayBucket[] {
  const start = windowStartDay(nowMs, w);
  const today = utcDayKey(nowMs);
  const out: ActorStatsDayBucket[] = [];
  for (const [day, bucket] of Object.entries(stats.days)) if (day >= start && day <= today) out.push(bucket);
  return out;
}

function mergeMaps(buckets: readonly ActorStatsDayBucket[], pick: (b: ActorStatsDayBucket) => Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of buckets) for (const [k, n] of Object.entries(pick(b))) out[k] = (out[k] ?? 0) + n;
  return out;
}

function setFact(facts: Record<string, number>, field: string, value: number): void {
  if (field.length <= VOCABULARY_FIELD_MAX_LENGTH) facts[field] = value;
}

/** Share facts for one dimension: only keys that occurred (a never-seen key reads 0 via the patterns). */
function setShares(facts: Record<string, number>, prefix: string, counts: Readonly<Record<string, number>>, total: number): void {
  for (const [k, n] of Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))) {
    if (n > 0) setFact(facts, `${prefix}.${k}`, shareBps(n, total));
  }
}

/** Pure: the vocabulary facts from already-read inputs. Exported for the suite (RED controls). */
export function assembleVocabulary(input: {
  readonly principal: VocabularyPrincipal;
  readonly stats: ActorStatsDoc;
  readonly nowMs: number;
  /** The actor's in-edges (summarized here), or — the live read — `consumption` already summarized. */
  readonly inEdges?: readonly OriginEdge[];
  /** The Consumption summary from the actor's per-pair citation counts (wins over `inEdges`). */
  readonly consumption?: ConsumptionSummary;
  readonly outEdges: SignerOutEdges;
  readonly registeredDevices: number;
  readonly bondActive: number;
  readonly openBondClaimsAgainst: number;
  readonly invalidationActive: number;
  readonly humanBeneficiary: number;
  readonly linkedAgents: number;
  readonly presentationsProduced: number;
  readonly presentationsRecent: number;
  readonly presentationsWindowed: Readonly<Record<VocabularyWindow, number>>;
}): VocabularyFacts {
  const { stats, nowMs } = input;
  const facts: Record<string, number> = {};

  // Continuity
  facts['continuity.first_seen_ms'] = stats.first_pe_at_ms ?? 0;
  facts['continuity.last_seen_ms'] = stats.last_pe_at_ms ?? 0;
  // Chain depth counts every record in the actor's chains: its acts of work AND its chain-continuity
  // records (: continuity stays in the continuity vocabulary, never in work.*).
  facts['continuity.chain_depth'] = stats.pe_count + stats.continuity_records;
  facts['continuity.active_days'] = stats.active_days;
  facts['continuity.streak_days'] = stats.streak_days;
  facts['continuity.registered_devices'] = input.registeredDevices;
  facts['continuity.highest_attestation_rank'] = stats.highest_attestation_rank;

  // Work — by family × witness class; every class key always present per family seen.
  let witnessedTotal = 0;
  let hardwareRootedTotal = 0;
  const byClass: Record<string, number> = {};
  const families = new Set<string>();
  for (const key of Object.keys(stats.by_family_class)) {
    const idx = key.lastIndexOf('__');
    if (idx > 0) families.add(key.slice(0, idx));
  }
  for (const family of [...families].sort()) {
    for (const cls of WITNESS_CLASSES) {
      const n = stats.by_family_class[`${family}__${cls}`] ?? 0;
      setFact(facts, `work.${family}.${cls}`, n);
      byClass[cls] = (byClass[cls] ?? 0) + n;
      if (cls !== 'actor_declared') witnessedTotal += n;
      if (cls === 'hardware_rooted') hardwareRootedTotal += n;
    }
  }
  facts['work.total'] = stats.pe_count;
  facts['work.witnessed'] = witnessedTotal;
  // Headline aggregate across families so a profile shows the hardware-rooted count at a glance
  // (App Attest / TPM / Nitro …), not only the per-family breakdown.
  facts['work.hardware_rooted'] = hardwareRootedTotal;
  facts['work.witnessed_compute_tokens'] = stats.witnessed_compute_tokens;

  // Coupling — what this actor cites.
  let independentOwners = 0;
  for (const counted of input.outEdges.owners.values()) if (counted) independentOwners += 1;
  facts['coupling.independent_origins_cited'] = stats.independent_origins_cited;
  facts['coupling.distinct_owners'] = input.outEdges.owners.size;
  facts['coupling.independent_owners'] = independentOwners;

  // Consumption — who built on this actor's outputs (reverse index; ring-flagged edges excluded).
  const consumption = input.consumption ?? summarizeConsumption(input.inEdges ?? []);
  facts['consumption.independent_parties'] = consumption.independent_consumers;
  facts['consumption.edges'] = consumption.consumption_edges;
  facts['consumption.ring_excluded'] = consumption.ring_excluded_edges;

  // Money witnessed
  let witnessedFinancial = 0;
  for (const [key, n] of Object.entries(stats.by_family_class)) {
    const idx = key.lastIndexOf('__');
    if (idx <= 0) continue;
    const family = key.slice(0, idx);
    const cls = key.slice(idx + 2);
    if (FINANCIAL_FAMILIES.has(family) && cls !== 'actor_declared') witnessedFinancial += n;
  }
  const fulfilled = sumTypes(stats, PROMISE_FULFILLED_TYPES);
  // adverse counts read `adverse_by_type` (rows that count against THIS actor), never
  // `by_type` (every row of the type, the wronged party's included). `readActorVocabulary` has
  // already refused a document whose split is unknown (null).
  const adverseByType = stats.adverse_by_type ?? {};
  const sumAdverse = (types: readonly string[]): number => types.reduce((a, t) => a + (adverseByType[t] ?? 0), 0);
  const defaulted = sumAdverse(PROMISE_DEFAULTED_TYPES);
  facts['money.witnessed_financial'] = witnessedFinancial;
  // Witnessed INBOUND payments (reference-gate run, 2026-10-09): a gate at a payment rail asks
  // whether this actor has been PAID by others, not whether it has spent. `receive` rows exist only
  // where a chain lane derived them from a transaction the recipient did not sign, so the named
  // lifetime count is exact and needs no class split; a never-paid actor reads an observed 0.
  facts['money.witnessed_inbound'] = sumTypes(stats, INBOUND_FINANCIAL_TYPES);
  // Trust layer extension (2026-10-10): distinct parties that PAID this actor — the counterparty of
  // every chain-witnessed `receive` the same-owner fence passed (an operator paying itself from its
  // own wallets adds nothing). Counted from the landing forward.
  facts['money.independent_payers'] = Object.keys(stats.payers).length;
  facts['money.escrows_completed_as_provider'] = sumTypes(stats, ESCROW_COMPLETED_TYPES);
  facts['money.promises_fulfilled'] = fulfilled;
  facts['money.promises_defaulted'] = defaulted;
  facts['money.promise_fulfillment_rate_bps'] = rateBps(fulfilled, defaulted);
  // PREDICATE-ONLY: present here so a predicate can be evaluated; the disclosure never emits it.
  facts[PAYMENT_VOLUME_FIELD] = atomicUsdcToUsdNumber(stats.payment_volume_atomic);

  // Standing — ALWAYS PRESENT.
  let adverseTotal = 0;
  for (const [field, types] of STANDING_TYPE_FIELDS) {
    const n = sumAdverse(types);
    facts[field] = n;
    adverseTotal += n;
  }
  facts['standing.adverse_events'] = adverseTotal;
  facts['standing.bond_active'] = input.bondActive > 0 ? 1 : 0;
  facts['standing.open_bond_claims_against'] = input.openBondClaimsAgainst;
  facts['standing.invalidation_active'] = input.invalidationActive > 0 ? 1 : 0;

  // Accountability
  facts['accountability.human_beneficiary'] = input.humanBeneficiary > 0 ? 1 : 0;
  facts['accountability.linked_agents'] = input.linkedAgents;
  facts['accountability.human_directed_turn_share_bps'] = stats.supervision_total_turns > 0
    ? Math.round((stats.supervision_human_turns * 10_000) / stats.supervision_total_turns)
    : 0;
  facts['accountability.supervised_turns'] = stats.supervision_total_turns;
  facts['accountability.human_approvals_cited'] = input.principal.kind === 'human'
    ? consumption.own_approvals_cited
    : stats.approvals_cited;
  facts['accountability.human_approvals_given'] = sumTypes(stats, HUMAN_APPROVAL_TYPES);

  // Composition
  facts['composition.model_families'] = Object.keys(stats.models).length;
  for (const [fam, n] of Object.entries(stats.models).sort()) setFact(facts, `composition.model.${fam}`, n);
  facts['composition.environment_classes'] = Object.keys(stats.environments).length;
  for (const [env, n] of Object.entries(stats.environments).sort()) setFact(facts, `composition.env.${env}`, n);
  facts['composition.attested_regions'] = Object.keys(stats.regions).length;
  for (const [region, n] of Object.entries(stats.regions).sort()) setFact(facts, `composition.region.${region}`, n);
  facts['composition.measurements'] = Object.keys(stats.measurements).length;
  for (const [digest, n] of Object.entries(stats.measurements).sort()) setFact(facts, `composition.measurement.${digest}`, n);
  facts['composition.attested_issuers'] = Object.keys(stats.issuers).length;
  for (const [fp, n] of Object.entries(stats.issuers).sort()) setFact(facts, `composition.issuer.${fp}`, n);

  // Share of work (lifetime) — bps of work.total.
  const total = stats.pe_count;
  setShares(facts, 'share.witness', byClass, total);
  setShares(facts, 'share.model', stats.models, total);
  setShares(facts, 'share.env', stats.environments, total);
  setShares(facts, 'share.region', stats.regions, total);
  setShares(facts, 'share.measurement', stats.measurements, total);
  setShares(facts, 'share.issuer', stats.issuers, total);

  // Presentations produced (§2.7: the produced count IS the activity stat; nothing counts verifies).
  facts['presentations.produced'] = input.presentationsProduced;
  facts['presentations.produced_recent'] = input.presentationsRecent;

  // Fixed windows (UTC-day granular; the day buckets are seal-time live history).
  for (const w of VOCABULARY_WINDOWS) {
    const sfx = windowSuffix(w);
    const buckets = bucketsIn(stats, nowMs, w);
    let n = 0; let declared = 0; let hw = 0; let tok = 0; let fin = 0; let adv = 0; let pf = 0; let pd = 0; let active = 0; let inb = 0;
    let pay = 0n;
    for (const b of buckets) {
      n += b.n;
      declared += b.wc.actor_declared ?? 0;
      hw += b.wc.hardware_rooted ?? 0;
      tok += b.tok; fin += b.fin; adv += b.adv; pf += b.pf; pd += b.pd; inb += b.inb;
      // A day with only continuity records is still an active day.
      if (b.n > 0 || b.cr > 0) active += 1;
      pay += BigInt(b.pay);
    }
    facts[`work.total${sfx}`] = n;
    facts[`work.witnessed${sfx}`] = n - declared;
    facts[`work.hardware_rooted${sfx}`] = hw;
    facts[`work.witnessed_compute_tokens${sfx}`] = tok;
    facts[`continuity.active_days${sfx}`] = active;
    facts[`money.witnessed_financial${sfx}`] = fin;
    facts[`money.witnessed_inbound${sfx}`] = inb;
    facts[`money.independent_payers${sfx}`] = Object.keys(mergeMaps(buckets, (b) => b.py)).length;
    facts[`money.promises_fulfilled${sfx}`] = pf;
    facts[`money.promises_defaulted${sfx}`] = pd;
    facts[`money.promise_fulfillment_rate_bps${sfx}`] = rateBps(pf, pd);
    facts[`${PAYMENT_VOLUME_FIELD}${sfx}`] = atomicUsdcToUsdNumber(pay.toString());
    facts[`standing.adverse_events${sfx}`] = adv;
    facts[`presentations.produced${sfx}`] = input.presentationsWindowed[w];
    setShares(facts, `share.witness${sfx}`, mergeMaps(buckets, (b) => b.wc), n);
    setShares(facts, `share.model${sfx}`, mergeMaps(buckets, (b) => b.m), n);
    setShares(facts, `share.env${sfx}`, mergeMaps(buckets, (b) => b.e), n);
    setShares(facts, `share.region${sfx}`, mergeMaps(buckets, (b) => b.r), n);
    setShares(facts, `share.measurement${sfx}`, mergeMaps(buckets, (b) => b.ms), n);
    setShares(facts, `share.issuer${sfx}`, mergeMaps(buckets, (b) => b.is), n);
  }

  facts['actor.is_agent'] = input.principal.kind === 'agent' ? 1 : 0;
  return Object.freeze(facts);
}

// =============================================================================
// Live computation (fail closed)
// =============================================================================

/**
 * Compute the live vocabulary for a principal. Every source either reads or throws
 * {@link VocabularyUnavailableError} (never a silent 0). A missing document is an observed zero.
 */
export async function computeActorVocabulary(deps: VocabularyDeps, principal: VocabularyPrincipal): Promise<VocabularyFacts> {
  const { db } = deps;
  const nowMs = deps.nowMs ?? Date.now();
  const actorId = principal.peOwnerUserId;
  if (!actorId || !principal.walletId) throw new VocabularyUnavailableError('principal', 'missing actor or wallet id');
  const since = (w: VocabularyWindow): number => Date.parse(`${windowStartDay(nowMs, w)}T00:00:00Z`);

  const [
    stats, consumption, outEdges, produced, recent, p30, p90, p365, floor,
    registeredDevices, bondActive, openBondClaimsAgainst, humanBeneficiary, linkedAgents,
  ] = await Promise.all([
    strictRead('actor_stats', () => readActorStats(db, actorId)),
    // The actor's whole citation history, from its per-pair counts (never its edges, which live
    // 31 days): bounded by the number of distinct parties, not by history.
    strictRead('reference_graph_in_edges', () => readActorConsumption(db, actorId)),
    strictRead('reference_graph_out_edges', () => readSignerCitedOwners(db, actorId)),
    strictRead('presentations_produced', () => countPresentationsProducedSince(db, principal.walletId, null)),
    strictRead('presentations_produced', () => countPresentationsProducedSince(db, principal.walletId, nowMs - PRESENTATION_ACTIVITY_RECENT_WINDOW_MS)),
    strictRead('presentations_produced', () => countPresentationsProducedSince(db, principal.walletId, since(30))),
    strictRead('presentations_produced', () => countPresentationsProducedSince(db, principal.walletId, since(90))),
    strictRead('presentations_produced', () => countPresentationsProducedSince(db, principal.walletId, since(365))),
    strictRead('invalidation_floor', () => readInvalidationFloorStrict(db, principal.walletId)),
    principal.kind === 'agent'
      ? countWhere(db, 'registered_devices', 'devices', [['owner_wallet_id', principal.walletId]])
      : countWhere(db, 'registered_devices', 'devices', [['user_id', principal.peOwnerUserId]]),
    principal.kind === 'agent'
      ? countWhere(db, 'bonds', 'bonds', [['agent_wallet_id', principal.walletId], ['status', 'active']])
      : Promise.resolve(0), // a human posts no bond: an observed zero, not a read
    principal.kind === 'agent'
      ? countWhere(db, 'bond_claims', 'bond_claims', [['respondent_wallet_id', principal.walletId], ['status', 'filed']])
      : Promise.resolve(0),
    principal.kind === 'agent'
      ? strictRead('agent_wallet', async () => {
        const snap = await db.collection('agent_wallets').doc(principal.walletId).get();
        const d = snap.data() as { linked_human_user_id?: unknown } | undefined;
        return typeof d?.linked_human_user_id === 'string' && d.linked_human_user_id.length > 0 ? 1 : 0;
      })
      : Promise.resolve(0),
    principal.kind === 'human'
      ? countWhere(db, 'linked_agents', 'agent_wallets', [['linked_human_user_id', principal.peOwnerUserId]])
      : Promise.resolve(0),
  ]);

  // A v1 document upgraded in place has only partial v2 history (days / measurements / payment
  // volume / attested-only regions) — unavailable until the backfill completes it, never a zero.
  if (!stats.history_complete) {
    throw new VocabularyUnavailableError('actor_stats_history', 'actor_stats_v1 not yet backfilled to actor-stats/v2');
  }
  // a document last written before the party-at-fault rule that already holds an adverse
  // type cannot say which of those rows count against this actor — unavailable, never a zero.
  if (stats.adverse_by_type === null) {
    throw new VocabularyUnavailableError('actor_stats_standing', 'adverse rows predate the party-at-fault split; re-fold this actor');
  }

  return assembleVocabulary({
    principal,
    stats,
    nowMs,
    consumption,
    outEdges,
    registeredDevices,
    bondActive,
    openBondClaimsAgainst,
    invalidationActive: floor ? 1 : 0,
    humanBeneficiary,
    linkedAgents,
    presentationsProduced: produced,
    presentationsRecent: recent,
    presentationsWindowed: { 30: p30, 90: p90, 365: p365 },
  });
}

/**
 * The owner's own view (GET vocabulary routes): every fact EXCEPT the predicate-only ones, which
 * are listed by name — the raw payment volume is answerable only through a predicate.
 */
export function selfViewOfVocabulary(facts: VocabularyFacts): { facts: Record<string, number>; predicate_only_fields: string[] } {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(facts)) if (!isPredicateOnlyField(k)) out[k] = v;
  return { facts: out, predicate_only_fields: [...PREDICATE_ONLY_FIELDS].sort() };
}
