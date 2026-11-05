/**
 * The dashboard / allocation READ, backed by the accrual-time aggregates — on the PE meter.
 *
 * PE METER : the relay no longer stores PEs. Every act's contribution
 * lands in its identities' aggregates in the SAME transaction as its batch commit
 * (`meter-commit.ts`), and every later change of an act's economic fields (held-act release,
 * settlement writeback, takeover demotion, a sweep's patch) moves the aggregate as
 * (−before, +after). So the read is:
 *
 * 1. the stored totals (counts, record points, Genesis gross) — ENTIRELY from the aggregate,
 * one point read per identity, whatever the identity's history;
 * 2. the settlement projection = the FROZEN sums (rows at or below the watermark) + the LIVE
 * TAIL, folded from the identity's live act keys above the watermark. Act keys live 31 days
 * (a Genesis grant's until it mints), so the tail is bounded by the key TTL, never by
 * history. An act key's row carries its CURRENT state (a corroboration landing on it, its
 * `minted` writeback), which is why the tail reads it live.
 *
 * What it no longer does, and why:
 * - no backfill on read and no `count()` drift check against `pe_history` there are no rows to
 * fold or count. The aggregate written at commit is the record;
 * - no roll-forward of the watermark on read (a write in a read path); the tail already covers
 * every live key above it. An eligible act that is still unminted when its key expires (31
 * days; standard settlement runs daily with a per-payee interval) drops out of the live projection — its earnings are untouched
 * (they are pending claims), only this display projection stops showing them;
 * - no fall-back to a full-history fold: that fold read `pe_history`, which is gone.
 */

import type { Firestore } from 'firebase-admin/firestore';
import type { PEHistoryDocument } from '../../../pe-history';
import { streamLiveActKeys } from '../../meter/owner-reads';
import { getWeekStart } from '../week-start';
import {
  ECONOMIC_AGGREGATE_COLLECTION,
  emptyRoleAggregate,
  frozenSettlementInput,
  frozenSettlementInputByCategory,
  isAggregateMarked,
  parseAggregateDocument,
  parseSignedAtomic,
  rowContribution,
  type AggregateRole,
  type RoleAggregate,
} from './economic-aggregate';
import {
  addSettlementInput,
  appendSettlementInput,
  emptyEconomicAccrualTotals,
  finalizeEconomicAccrualProjection,
  resolveContributorIdentities,
  type CurrentSettlementProjectionContext,
  type EconomicAccrualProjection,
} from './economic-projection';

export type { EconomicAccrualProjection } from './economic-projection';

export interface ReadEconomicAccrualOptions {
  readonly nowMs?: number;
  readonly settlementProjection?: CurrentSettlementProjectionContext | null;
  /** Tail page size (tests use small pages to exercise the cursor). */
  readonly tailPageSize?: number;
}

/** What the read did — surfaced for tests and the slow-miss log. */
export interface AggregateReadTrace {
  /** Live act keys folded into the projection tail. */
  tailActKeys: number;
  timingsMs?: {
    identities: number;
    aggregates: number;
    tail: number;
  };
}

interface Target {
  readonly identity: string;
  readonly role: AggregateRole;
}

/** The act-key field an identity is keyed by, per role (both top-level and indexed). */
const ACT_KEY_ROLE_FIELD: Readonly<Record<AggregateRole, 'actor_id' | 'beneficiary_id'>> = Object.freeze({
  contributor: 'actor_id',
  beneficiary: 'beneficiary_id',
});

async function readRoleAggregates(db: Firestore, targets: readonly Target[]): Promise<RoleAggregate[]> {
  const identities = [...new Set(targets.map((t) => t.identity))];
  const docs = new Map(await Promise.all(identities.map(async (identity) => {
    const snap = await db.collection(ECONOMIC_AGGREGATE_COLLECTION).doc(identity).get();
    return [identity, snap.exists ? parseAggregateDocument(identity, snap.data()) : null] as const;
  })));
  // A missing (or other-schema) document is an identity with no metered acts yet: empty totals.
  return targets.map((t) => docs.get(t.identity)?.roles[t.role] ?? emptyRoleAggregate());
}

/**
 * The aggregate-backed read. Same result shape as before the meter; `trace` (optional) receives
 * what the read did.
 */
export async function readEconomicAccrualProjection(
  db: Firestore,
  userId: string,
  options: ReadEconomicAccrualOptions = {},
  trace?: AggregateReadTrace,
): Promise<EconomicAccrualProjection> {
  const startedAt = Date.now();
  const nowMs = options.nowMs ?? Date.now();
  const projectionContext = options.settlementProjection ?? null;
  const tailPageSize = options.tailPageSize ?? 500;
  const identities = await resolveContributorIdentities(db, userId);
  const targets: Target[] = [
    ...identities.map((identity) => ({ identity, role: 'contributor' as const })),
    { identity: userId, role: 'beneficiary' as const },
  ];
  const identitiesAt = Date.now();

  const aggregates = await readRoleAggregates(db, targets);
  const aggregatesAt = Date.now();

  const totals = emptyEconomicAccrualTotals();
  const weekKey = String(getWeekStart(nowMs));
  const tailReads: Promise<void>[] = [];
  let tailActKeys = 0;
  targets.forEach((target, index) => {
    const agg = aggregates[index];
    totals.totalPEs += agg.total_pes;
    totals.integrityFailures += agg.integrity_failures;
    totals.weeklyPEs += agg.pes_by_week_start[weekKey] ?? 0;
    for (const [category, count] of Object.entries(agg.pes_by_category)) {
      totals.counts[category] = (totals.counts[category] ?? 0) + count;
    }
    totals.totalRecordPoints += parseSignedAtomic(agg.record_points_atomic);
    for (const [category, raw] of Object.entries(agg.record_points_by_category_atomic)) {
      totals.recordPointsByCategory[category] = (totals.recordPointsByCategory[category] ?? 0n) + parseSignedAtomic(raw);
    }
    totals.exactGenesisReservedGross += parseSignedAtomic(agg.genesis_gross_atomic);
    for (const [category, raw] of Object.entries(agg.genesis_gross_by_category_atomic)) {
      totals.genesisByCategory[category] = (totals.genesisByCategory[category] ?? 0n) + parseSignedAtomic(raw);
    }
    if (projectionContext === null) return;

    totals.settlementInput = addSettlementInput(totals.settlementInput, {
      rated: parseSignedAtomic(agg.batch_pending_rated_atomic), fixed: parseSignedAtomic(agg.batch_pending_fixed_atomic),
    });
    for (const category of new Set([...Object.keys(agg.batch_pending_rated_by_category_atomic ?? {}),
      ...Object.keys(agg.batch_pending_fixed_by_category_atomic ?? {})])) {
      appendSettlementInput(totals.settlementInputByCategory, category, {
        rated: parseSignedAtomic(agg.batch_pending_rated_by_category_atomic?.[category]),
        fixed: parseSignedAtomic(agg.batch_pending_fixed_by_category_atomic?.[category]),
      });
    }

    totals.projectionFailures += agg.frozen_projection_failures;
    totals.settlementInput = addSettlementInput(totals.settlementInput, frozenSettlementInput(agg));
    for (const [category, input] of Object.entries(frozenSettlementInputByCategory(agg))) {
      appendSettlementInput(totals.settlementInputByCategory, category, input);
    }
    tailReads.push(streamLiveActKeys(
      db,
      ACT_KEY_ROLE_FIELD[target.role],
      target.identity,
      agg.frozen_through_ms,
      tailPageSize,
      (key) => {
        const row = key.row;
        // An unmarked row is in no total; projecting it would show value for an act the count
        // does not include.
        if (row === null || typeof row !== 'object' || !isAggregateMarked(row)) return;
        tailActKeys += 1;
        const c = rowContribution(row as unknown as PEHistoryDocument, target.role, projectionContext.projectedAtMs);
        if (c.integrityFailure) return;
        if (c.settlementInput === null) {
          totals.projectionFailures += 1;
          return;
        }
        appendSettlementInput(totals.settlementInputByCategory, c.category, c.settlementInput);
        totals.settlementInput = addSettlementInput(totals.settlementInput, c.settlementInput);
      },
    ));
  });
  // Each tail contributes only additive totals; the independent identity/role queries run together.
  await Promise.all(tailReads);
  if (trace) {
    const doneAt = Date.now();
    trace.tailActKeys += tailActKeys;
    trace.timingsMs = {
      identities: identitiesAt - startedAt,
      aggregates: aggregatesAt - identitiesAt,
      tail: doneAt - aggregatesAt,
    };
  }

  return finalizeEconomicAccrualProjection(totals, projectionContext);
}

export function emptyAggregateReadTrace(): AggregateReadTrace {
  return { tailActKeys: 0 };
}

/**
 * An identity's acts by CURRENT `mint_status`, for one role, from the aggregate (one point read):
 * how many are unminted (`eligible`) and how many `minted`, without reading any act.
 */
export async function readAggregateMintStatusCounts(
  db: Firestore,
  identity: string,
  role: AggregateRole = 'contributor',
): Promise<Readonly<Record<string, number>>> {
  const [agg] = await readRoleAggregates(db, [{ identity, role }]);
  return agg.pes_by_mint_status;
}
