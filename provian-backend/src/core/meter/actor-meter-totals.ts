/**
 * PE METER — the per-actor running totals the user-facing read surfaces need that no other total
 * already carries (: the relay keeps running totals, never PEs).
 *
 * Before the meter, the participation summary, the public profile, the trust profile and the
 * chain-verified financial summary each answered by scanning the actor's stored PEs. Those stores
 * are gone, so each answer is kept as a total, applied ONCE per fresh act by the batch commit
 * (`meter-commit.ts`) — a retried batch replays its receipt and applies nothing — plus the two
 * post-seal transitions that change what a total counts (a held act leaving its hold,
 * `held-acts.ts`; the first corroboration landing on an act, `meter-corroboration.ts`).
 *
 * actor_meter_totals_v1/{actor} lifetime, bounded maps (attestation tiers, a human's
 * beneficiary acts by agent, chain-verified financial
 * totals by executing address). Grows with the number of
 * distinct tiers / agents / addresses, never with history.
 * actor_meter_days_v1/{actor}__{day} one UTC day's small counters (agent actions,
 * corroborated acts). TTL 32 days; a reader reads at most
 * 30 of them by id.
 * network_meter_hours_v1/{hour}__{shard} network-countable acts per commit hour (the Firestore
 * twin of the Redis hourly buckets). TTL 2 days.
 *
 * Identifiers and figures only — never content.
 */

import admin from 'firebase-admin';
import type { DocumentReference, Firestore, Transaction } from 'firebase-admin/firestore';
import { consoleRollupShard } from '../pvt/disposition-rollup';
import { DAY_MS, expireAt } from './meter-store';

export const ACTOR_METER_TOTALS_COLLECTION = 'actor_meter_totals_v1';
export const ACTOR_METER_DAYS_COLLECTION = 'actor_meter_days_v1';
export const NETWORK_METER_HOURS_COLLECTION = 'network_meter_hours_v1';

export const HOUR_MS = 60 * 60 * 1000;
/** Day counters live this long past their day (a reader looks back 30 days). */
export const ACTOR_METER_DAY_LIFETIME_MS = 32 * DAY_MS;
/** Hour counters live this long past their hour (a reader looks back 24 hours). */
export const NETWORK_METER_HOUR_LIFETIME_MS = 2 * DAY_MS;
/** The window the participation summary calls "this month". */
export const PARTICIPATION_WINDOW_DAYS = 30;

/**
 * The agent acts the participation summary has always counted (the historical gate types beside
 * `agent_action`, so an older record keeps counting as the agent act it was).
 */
export const PARTICIPATION_AGENT_ACTION_TYPES: ReadonlySet<string> = new Set([
  'agent_authorization', 'agent_action', 'goal_action_auto_approved',
  'proxied_payment_executed', 'egress_data_executed',
]);

/** The corroboration statuses the participation summary's corroboration rate counts. */
export const PARTICIPATION_CORROBORATED_STATUSES: ReadonlySet<string> = new Set([
  'on_chain_verified', 'merchant_confirmed', 'peer_verified',
]);

/** an unsolicited receive never counts as chain-verified inbound activity. */
export const UNSOLICITED_RECEIVE_REASON_CODE = 'unsolicited_receive_record_only';

// =============================================================================
// Chain-verified financial facts (derived at seal, from RELAY-authored acts only)
// =============================================================================

export type FinancialFactKind = 'usdc_inbound' | 'usdc_outbound' | 'x402' | 'verified_transfer';

/** One act's contribution to the chain-verified financial summary. Figures only. */
export interface FinancialFact {
  readonly kind: FinancialFactKind;
  readonly action_type: string;
  /** USD value the summary buckets (0 when the act carries none). */
  readonly amount_usd: number;
  /** A verified transfer's currency (lowercase); null for the USDC watcher kinds. */
  readonly currency: string | null;
  /** The executing address (lowercase) the summary can be filtered to; null when absent. */
  readonly actor_address: string | null;
}

const OUTBOUND_WATCHER_TYPES: ReadonlySet<string> = new Set(['send', 'swap', 'stake']);
const VERIFIED_TRANSFER_TYPES: ReadonlySet<string> = new Set(['agent_token_transfer', 'agent_native_transfer']);

function finiteOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function lowerOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value.toLowerCase() : null;
}

/**
 * The financial fact of one act, or null. Only the RELAY's own emitters (the USDC watchers, the
 * x402 settlement watcher, `transfer/record`'s on-chain re-check) stamp these flags; the caller
 * passes the metadata of a relay-authored act only — a device act's metadata is never read here.
 */
export function financialFactOf(
  actionType: string,
  metadata: Readonly<Record<string, unknown>>,
  actorAddress: string | null,
): FinancialFact | null {
  const address = lowerOrNull(actorAddress);
  if (actionType === 'receive' && metadata.activity_mapped === true) {
    return { kind: 'usdc_inbound', action_type: actionType, amount_usd: finiteOrZero(metadata.amount_usd), currency: null, actor_address: address };
  }
  if (actionType === 'x402_payment' && metadata.chain_verified === true) {
    return { kind: 'x402', action_type: actionType, amount_usd: finiteOrZero(metadata.amount_usd), currency: null, actor_address: address };
  }
  if (OUTBOUND_WATCHER_TYPES.has(actionType) && metadata.chain_verified === true) {
    return { kind: 'usdc_outbound', action_type: actionType, amount_usd: finiteOrZero(metadata.amount_usd), currency: null, actor_address: address };
  }
  if (VERIFIED_TRANSFER_TYPES.has(actionType) && metadata.verified === true) {
    const currency = lowerOrNull(metadata.currency) ?? (actionType === 'agent_native_transfer' ? 'eth' : 'unknown');
    const atomic = metadata.amount_atomic;
    // USDC transfers contribute to the outbound USDC volume picture (6-decimal atomic units).
    const usd = currency === 'usdc' && typeof atomic === 'string' && /^\d+$/.test(atomic) ? Number(atomic) / 1e6 : 0;
    return { kind: 'verified_transfer', action_type: actionType, amount_usd: usd, currency, actor_address: address };
  }
  return null;
}

/**
 * Whether an act's financial fact counts, judged from its row's disposition : a `receive`
 * counts only with a known, non-unsolicited disposition — a missing one fails closed. Held acts
 * are counted when they leave their hold, never while held.
 */
export function financialFactCounts(fact: FinancialFact, row: Readonly<Record<string, unknown>>): boolean {
  if (fact.kind !== 'usdc_inbound') return true;
  const code = row.disposition_reason_code;
  return typeof code === 'string' && code.length > 0 && code !== UNSOLICITED_RECEIVE_REASON_CODE;
}

export interface FinancialTotals {
  readonly inbound_count: number;
  readonly inbound_usd: number;
  readonly outbound_count: number;
  readonly outbound_usd: number;
  readonly x402_count: number;
  readonly x402_usd: number;
  readonly transfer_count: number;
  readonly transfers_by_currency: Readonly<Record<string, number>>;
  readonly first_at_ms: number | null;
  readonly last_at_ms: number | null;
}

export function emptyFinancialTotals(): FinancialTotals {
  return {
    inbound_count: 0, inbound_usd: 0, outbound_count: 0, outbound_usd: 0,
    x402_count: 0, x402_usd: 0, transfer_count: 0, transfers_by_currency: {},
    first_at_ms: null, last_at_ms: null,
  };
}

export function applyFinancialFact(prior: FinancialTotals, fact: FinancialFact, atMs: number): FinancialTotals {
  const next = { ...prior, transfers_by_currency: { ...prior.transfers_by_currency } };
  switch (fact.kind) {
    case 'usdc_inbound':
      next.inbound_count += 1;
      next.inbound_usd += fact.amount_usd;
      break;
    case 'x402':
      // An x402 settlement is an outbound USDC transfer.
      next.x402_count += 1;
      next.x402_usd += fact.amount_usd;
      next.outbound_count += 1;
      next.outbound_usd += fact.amount_usd;
      break;
    case 'usdc_outbound':
      next.outbound_count += 1;
      next.outbound_usd += fact.amount_usd;
      break;
    case 'verified_transfer': {
      next.transfer_count += 1;
      const currency = fact.currency ?? 'unknown';
      next.transfers_by_currency[currency] = (next.transfers_by_currency[currency] ?? 0) + 1;
      next.outbound_usd += fact.amount_usd;
      break;
    }
  }
  if (Number.isFinite(atMs)) {
    next.first_at_ms = next.first_at_ms === null ? atMs : Math.min(next.first_at_ms, atMs);
    next.last_at_ms = next.last_at_ms === null ? atMs : Math.max(next.last_at_ms, atMs);
  }
  return next;
}

// =============================================================================
// The lifetime totals document
// =============================================================================

export interface ActorMeterTotalsDoc {
  readonly schema: 'provian.actor-meter-totals.v1';
  readonly actor_id: string;
  /** Acts by sealed attestation tier. */
  readonly by_attestation_tier: Readonly<Record<string, number>>;
  /** Acts that carry (or later received) a corroboration. */
  readonly corroborated: number;
  /** (A human's document) acts of each linked agent that named this human as beneficiary. */
  readonly beneficiary_acts_by_agent: Readonly<Record<string, number>>;
  /** Chain-verified financial totals, all addresses. */
  readonly financial: FinancialTotals;
  /** The same, per executing address (lowercase). */
  readonly financial_by_address: Readonly<Record<string, FinancialTotals>>;
  readonly updated_at_ms: number;
}

function numberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function nonNeg(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function msOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function coerceFinancial(raw: unknown): FinancialTotals {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyFinancialTotals();
  const r = raw as Record<string, unknown>;
  return {
    inbound_count: nonNeg(r.inbound_count),
    inbound_usd: nonNeg(r.inbound_usd),
    outbound_count: nonNeg(r.outbound_count),
    outbound_usd: nonNeg(r.outbound_usd),
    x402_count: nonNeg(r.x402_count),
    x402_usd: nonNeg(r.x402_usd),
    transfer_count: nonNeg(r.transfer_count),
    transfers_by_currency: numberRecord(r.transfers_by_currency),
    first_at_ms: msOrNull(r.first_at_ms),
    last_at_ms: msOrNull(r.last_at_ms),
  };
}

export function coerceActorMeterTotals(actorId: string, raw: unknown): ActorMeterTotalsDoc {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const byAddressRaw = r.financial_by_address;
  const byAddress: Record<string, FinancialTotals> = {};
  if (byAddressRaw && typeof byAddressRaw === 'object' && !Array.isArray(byAddressRaw)) {
    for (const [address, totals] of Object.entries(byAddressRaw as Record<string, unknown>)) {
      byAddress[address] = coerceFinancial(totals);
    }
  }
  return {
    schema: 'provian.actor-meter-totals.v1',
    actor_id: actorId,
    by_attestation_tier: numberRecord(r.by_attestation_tier),
    corroborated: nonNeg(r.corroborated),
    beneficiary_acts_by_agent: numberRecord(r.beneficiary_acts_by_agent),
    financial: coerceFinancial(r.financial),
    financial_by_address: byAddress,
    updated_at_ms: nonNeg(r.updated_at_ms),
  };
}

function bump(record: Readonly<Record<string, number>>, key: string, by = 1): Record<string, number> {
  return { ...record, [key]: (record[key] ?? 0) + by };
}

/** Is this corroboration status a corroboration at all (the public record's human attestations)? */
export function isCorroborationStatus(status: unknown): boolean {
  return typeof status === 'string' && status.length > 0 && status !== 'none';
}

/** What one fresh act adds to its ACTOR's lifetime totals (the actor's own document). */
export interface ActorActIncrement {
  readonly actorId: string;
  readonly tier: string | null;
  readonly corroborated: boolean;
  /** Counted only when `financialFactCounts` and the act is not held. */
  readonly financial: FinancialFact | null;
  readonly timestampMs: number;
}

export function applyActorActIncrement(prior: ActorMeterTotalsDoc, inc: ActorActIncrement, nowMs: number): ActorMeterTotalsDoc {
  let financial = prior.financial;
  let byAddress = prior.financial_by_address;
  if (inc.financial !== null) {
    financial = applyFinancialFact(financial, inc.financial, inc.timestampMs);
    const address = inc.financial.actor_address;
    if (address !== null) {
      byAddress = {
        ...byAddress,
        [address]: applyFinancialFact(byAddress[address] ?? emptyFinancialTotals(), inc.financial, inc.timestampMs),
      };
    }
  }
  return {
    ...prior,
    by_attestation_tier: inc.tier !== null ? bump(prior.by_attestation_tier, inc.tier) : prior.by_attestation_tier,
    corroborated: prior.corroborated + (inc.corroborated ? 1 : 0),
    financial,
    financial_by_address: byAddress,
    updated_at_ms: nowMs,
  };
}

export function applyBeneficiaryAct(prior: ActorMeterTotalsDoc, agentId: string, nowMs: number): ActorMeterTotalsDoc {
  return { ...prior, beneficiary_acts_by_agent: bump(prior.beneficiary_acts_by_agent, agentId), updated_at_ms: nowMs };
}

/** Only the financial part — a held act leaving its hold. */
export function applyReleasedFinancialFact(prior: ActorMeterTotalsDoc, fact: FinancialFact, atMs: number, nowMs: number): ActorMeterTotalsDoc {
  return applyActorActIncrement(prior, { actorId: prior.actor_id, tier: null, corroborated: false, financial: fact, timestampMs: atMs }, nowMs);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The facts of an act key this module reads (a structural subset of `MeterActFacts`). */
export interface ActFinancialFacts {
  readonly financial?: FinancialFact | null;
}

/** The increment one fresh act contributes, from its priced row and its key's facts. */
export function actorActIncrementOf(
  row: Readonly<Record<string, unknown>>,
  facts: ActFinancialFacts | null | undefined,
  held: boolean,
): ActorActIncrement | null {
  const actorId = str(row.userId);
  if (actorId === null) return null;
  const fact = facts?.financial ?? null;
  return {
    actorId,
    tier: str(row.attestationDepth),
    corroborated: isCorroborationStatus(row.corroboration_status),
    financial: fact !== null && !held && financialFactCounts(fact, row) ? fact : null,
    timestampMs: typeof row.timestamp === 'number' ? row.timestamp : Number.NaN,
  };
}

/** The human a row names as its beneficiary, when it is not the actor itself. */
export function beneficiaryOf(row: Readonly<Record<string, unknown>>): { humanId: string; agentId: string } | null {
  const humanId = str(row.beneficiary_wallet_id);
  const agentId = str(row.userId);
  if (humanId === null || agentId === null || humanId === agentId) return null;
  return { humanId, agentId };
}

// =============================================================================
// Day and hour counters (increment-only writes: no read, no contention)
// =============================================================================

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function actorMeterDayDocId(actorId: string, day: string): string {
  return `${actorId}__${day}`;
}

export interface ActorDayIncrement {
  readonly actorId: string;
  readonly day: string;
  readonly agentActions: number;
  readonly corroborated: number;
}

export function actorDayIncrementOf(row: Readonly<Record<string, unknown>>): ActorDayIncrement | null {
  const actorId = str(row.userId);
  const ts = row.timestamp;
  if (actorId === null || typeof ts !== 'number' || !Number.isFinite(ts)) return null;
  const actionType = str(row.actionType) ?? '';
  const agentActions = PARTICIPATION_AGENT_ACTION_TYPES.has(actionType) ? 1 : 0;
  const corroborated = PARTICIPATION_CORROBORATED_STATUSES.has(String(row.corroboration_status ?? '')) ? 1 : 0;
  if (agentActions === 0 && corroborated === 0) return null;
  return { actorId, day: utcDay(ts), agentActions, corroborated };
}

export function stageActorDayIncrement(txn: Transaction, db: Firestore, inc: ActorDayIncrement): void {
  const dayStartMs = Date.parse(`${inc.day}T00:00:00Z`);
  txn.set(db.collection(ACTOR_METER_DAYS_COLLECTION).doc(actorMeterDayDocId(inc.actorId, inc.day)), {
    actor_id: inc.actorId,
    day: inc.day,
    agent_actions: admin.firestore.FieldValue.increment(inc.agentActions),
    corroborated: admin.firestore.FieldValue.increment(inc.corroborated),
    expire_at: expireAt(dayStartMs + ACTOR_METER_DAY_LIFETIME_MS),
  }, { merge: true });
}

export function networkMeterHourDocId(hour: number, shard: number): string {
  return `${hour}__${shard}`;
}

export const NETWORK_METER_HOUR_SHARDS = 16;

export function stageNetworkHourIncrement(
  txn: Transaction,
  db: Firestore,
  input: { readonly atMs: number; readonly shardKey: string; readonly count: number },
): void {
  if (input.count <= 0) return;
  const hour = Math.floor(input.atMs / HOUR_MS);
  const shard = consoleRollupShard(input.shardKey) % NETWORK_METER_HOUR_SHARDS;
  txn.set(db.collection(NETWORK_METER_HOURS_COLLECTION).doc(networkMeterHourDocId(hour, shard)), {
    hour,
    count: admin.firestore.FieldValue.increment(input.count),
    expire_at: expireAt((hour + 1) * HOUR_MS + NETWORK_METER_HOUR_LIFETIME_MS),
  }, { merge: true });
}

// =============================================================================
// Readers — every one a fixed number of point reads, independent of history
// =============================================================================

interface GetAllCapable {
  getAll?: (...refs: DocumentReference[]) => Promise<FirebaseFirestore.DocumentSnapshot[]>;
}

async function readDocs(db: Firestore, refs: DocumentReference[]): Promise<FirebaseFirestore.DocumentSnapshot[]> {
  if (refs.length === 0) return [];
  const getAll = (db as unknown as GetAllCapable).getAll;
  if (typeof getAll === 'function') return getAll.apply(db, refs);
  return Promise.all(refs.map((ref) => ref.get()));
}

/** The lifetime totals of one actor (an empty document when none exists). */
export async function readActorMeterTotals(db: Firestore, actorId: string): Promise<ActorMeterTotalsDoc> {
  const snap = await db.collection(ACTOR_METER_TOTALS_COLLECTION).doc(actorId).get();
  return coerceActorMeterTotals(actorId, snap.exists ? snap.data() : null);
}

export interface ActorWindowCounts {
  readonly agentActions: number;
  readonly corroborated: number;
}

/** The last `days` UTC days (today included) of an actor's day counters: `days` point reads. */
export async function readActorMeterWindow(
  db: Firestore,
  actorId: string,
  nowMs: number,
  days: number = PARTICIPATION_WINDOW_DAYS,
): Promise<ActorWindowCounts> {
  const span = Math.max(1, Math.min(31, Math.floor(days)));
  const refs = Array.from({ length: span }, (_v, i) => db.collection(ACTOR_METER_DAYS_COLLECTION)
    .doc(actorMeterDayDocId(actorId, utcDay(nowMs - i * DAY_MS))));
  const snaps = await readDocs(db, refs);
  let agentActions = 0;
  let corroborated = 0;
  for (const snap of snaps) {
    if (!snap.exists) continue;
    const d = snap.data() as Record<string, unknown>;
    agentActions += nonNeg(d.agent_actions);
    corroborated += nonNeg(d.corroborated);
  }
  return { agentActions, corroborated };
}

/** Network-countable acts committed in the current and previous 23 hours (the Redis window). */
export async function readNetworkMeter24h(db: Firestore, nowMs: number): Promise<number> {
  const currentHour = Math.floor(nowMs / HOUR_MS);
  const refs: DocumentReference[] = [];
  for (let i = 0; i < 24; i += 1) {
    for (let shard = 0; shard < NETWORK_METER_HOUR_SHARDS; shard += 1) {
      refs.push(db.collection(NETWORK_METER_HOURS_COLLECTION).doc(networkMeterHourDocId(currentHour - i, shard)));
    }
  }
  const snaps = await readDocs(db, refs);
  return snaps.reduce((sum, snap) => sum + (snap.exists ? nonNeg((snap.data() as Record<string, unknown>).count) : 0), 0);
}
