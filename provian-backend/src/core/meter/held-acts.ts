import { prepareLocationCopyFence } from '../jurisdiction/location-copy-erasure';
import { planComplianceRetention, prepareComplianceRetention, retainComplianceDecision } from '../jurisdiction/location-retention';
import { complianceForRow } from '../jurisdiction/mint-compliance';
import { prepareRetireRecoveredMintOnceMetadata } from '../pvt/mint-once-claim';
import { createIndexedMeterClaim } from './pending-claim-index';
import { singleScanQuery } from '../provenance/private-store';
import type { BatchPricingCounters } from './batch-pricing-counters';
import { privateRetentionCollection } from '../provenance/private-retention';
import { prepareRelayHeldCompaction } from './compact-relay-held';
/**
 * PE METER — held acts: an act that waits on something (evidence, a cache read, review, a payee,
 * an epoch release) before it can mint.
 *
 * , carried: a held act never expires. The batch commit writes it to
 * `meter_held_acts_v1/{relay_pe_id}` with a copy of its act key (`key`, no TTL), so it outlives
 * the 31-day key. Every sweep that once walked `pe_history` for its hold status (pending-evidence,
 * registry hold, completion promotion, deferred release, pending-cache backfill, beneficiary
 * pending) enumerates held acts here and resolves each through `resolveHeldAct`, the ONE
 * transition for a metered held act:
 *
 * still held → the held record (and the live key, if any) take the patch;
 * eligible → the act's payee legs resolve, its own act-unit pending claims are created
 * (each carrying the act identity), the live key takes the legs, the held
 * record is removed;
 * terminal → the held record is removed; the live key takes the patch.
 *
 * Every transition lands its aggregate delta in the same transaction, like
 * `mutatePeHistoryRowWithAggregate` does for a pre-meter row.
 */

import type { Firestore, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import stableStringify from 'json-stable-stringify';
import type { PEHistoryDocument } from '../../pe-history';
import { EconomicAggregateWriter } from '../pvt/policy/economic-aggregate';
import { CROSS_WITNESS_TAKEOVER_WINDOW_MS } from '../pvt/policy/monetary-accounting';
import { adjustConsoleDispositionRollupInTransaction } from '../pvt/disposition-rollup';
import { resolvePayee } from '../pvt/wp4/claim-inlet-source';
import type { PayoutLegRole } from '../pvt/wp-ev/payout-legs';
import {
  ACTOR_METER_TOTALS_COLLECTION,
  applyReleasedFinancialFact,
  coerceActorMeterTotals,
  financialFactCounts,
} from './actor-meter-totals';
import { actKeyIdentity, type MeterActKeyDoc } from './meter-act-key';
import { buildPendingClaim, meterActClaimId, meterActClaimKey, type MeterActLeg } from './meter-claims';
import { memoizedSettlementDb } from './meter-ingest';
import { isGenesisRow } from './meter-seal';
import {
  expireAt, METER_KEY_LIFETIME_MS,
  METER_ACT_KEYS_COLLECTION,
  METER_HELD_ACTS_COLLECTION,
  METER_PENDING_CLAIMS_COLLECTION,
} from './meter-store';

/** Statuses an act waits in. Anything else is either eligible or terminal. */
export const HELD_MINT_STATUSES: ReadonlySet<string> = new Set([
  'pending_evidence',
  'pending_review',
  'pending_cache',
  'pending_compliance',
  'beneficiary_pending',
  'deferred',
]);

export interface HeldActDoc {
  readonly relay_pe_id: string;
  /** The act's actor (top-level: `key` is not indexed). Absent on records written before it. */
  readonly actor_id?: string;
  readonly held_reason: string;
  readonly key: MeterActKeyDoc;
  readonly created_at_ms: number;
}

export interface HeldActRow {
  readonly relayPeId: string;
  readonly heldReason: string;
  /** The act's priced row (the pe_history-shaped row the sweeps judge). */
  readonly row: Record<string, unknown>;
  readonly key: MeterActKeyDoc;
}

function heldRowOf(doc: QueryDocumentSnapshot): HeldActRow | null {
  const data = doc.data() as Partial<HeldActDoc>;
  const key = data.key;
  if (!key || typeof key !== 'object' || !key.row || typeof data.held_reason !== 'string') return null;
  return { relayPeId: doc.id, heldReason: data.held_reason, row: key.row, key };
}

/**
 * One page of held acts by the status they wait in, ordered by relay pe id (a stable key: a
 * resumed page cannot skip an act). Needs the `(held_reason, relay_pe_id)` index.
 */
/** Each resolver walk shares this source; independent list requests take a fresh snapshot. */
function heldActQuery(db: Firestore, heldReason: string): FirebaseFirestore.Query {
  return privateRetentionCollection(db, METER_HELD_ACTS_COLLECTION)
    .where('held_reason', '==', heldReason).orderBy('relay_pe_id', 'asc');
}

/** Explicit resolver walks share a snapshot; single-page readers retain only their limit. */
export function createHeldActSource(
  db: Firestore,
  heldReason: string,
  options: { readonly startAfter?: string | null; readonly maxResults?: number } = {},
): FirebaseFirestore.Query {
  let query = heldActQuery(db, heldReason);
  if (options.startAfter) query = query.startAfter(options.startAfter);
  if (options.maxResults !== undefined) query = query.limit(options.maxResults);
  return singleScanQuery(query, options.maxResults);
}

export async function listHeldActs(
  db: Firestore,
  heldReason: string,
  options: { readonly limit: number; readonly startAfter?: string | null; readonly source?: FirebaseFirestore.Query },
): Promise<{ readonly rows: HeldActRow[]; readonly next: string | null }> {
  // The page size actually queried. `next` must compare against THIS, not the requested limit:
  // a request above the 500 clamp (or below 1) would otherwise report a full page as the last one
  // and end every walk after its first page.
  const pageSize = Math.max(1, Math.min(500, Math.floor(options.limit)));
  let query = (options.source ?? heldActQuery(db, heldReason)).limit(pageSize);
  if (options.startAfter) query = query.startAfter(options.startAfter);
  const snap = await query.get();
  const rows = snap.docs.map(heldRowOf).filter((r): r is HeldActRow => r !== null);
  const last = snap.docs[snap.docs.length - 1];
  return { rows, next: snap.docs.length === pageSize && last ? last.id : null };
}

export type HeldActOutcome =
  | 'missing'
  | 'precondition_failed'
  | 'still_held'
  | 'promoted'
  | 'promotion_refused'
  | 'released_terminal';

/**
 * Apply `patch` to a held act's row: the one transition every sweep uses for a metered act.
 * `expect` is judged on the row as read inside the transaction. A promotion to `eligible` whose
 * payee cannot be resolved lands the patch (the row is eligible, with its aggregate delta) but
 * keeps the act held under `payee_<reason>` (`promotion_refused`, reason recorded) rather than
 * creating a claim nothing can pay; a later no-op patch re-resolves the payee.
 */
export async function resolveHeldAct(
  db: Firestore,
  relayPeId: string,
  patch: Readonly<Record<string, unknown>>,
  options: {
    readonly nowMs: number;
    readonly expect?: (before: Record<string, unknown>) => boolean;
    readonly noveltyCounters?: BatchPricingCounters;
  },
): Promise<{ readonly outcome: HeldActOutcome; readonly before: Record<string, unknown> | null; readonly reason?: string }> {
  const heldRef = privateRetentionCollection(db, METER_HELD_ACTS_COLLECTION).doc(relayPeId);
  const keyRef = privateRetentionCollection(db, METER_ACT_KEYS_COLLECTION).doc(relayPeId);

  // Payee legs are resolved from the PROMOTED row before the transaction (their reads are not
  // transactional; the transaction re-checks the row they were resolved from).
  const preview = await heldRef.get();
  if (!preview.exists) return { outcome: 'missing', before: null };
  const previewDoc = preview.data() as HeldActDoc;
  const previewAfter = { ...previewDoc.key.row, ...patch };
  if (previewAfter.mint_status === 'eligible') {
    const compliance = await complianceForRow(previewAfter, db);
    if (compliance.policy !== 'immediate') {
      await retainComplianceDecision(db, relayPeId, previewAfter, compliance, options.nowMs);
      return { outcome: 'still_held', before: previewDoc.key.row, reason: compliance.reason };
    }
  }
  let legs: MeterActLeg[] | null = null;
  let refusal: string | null = null;
  if (previewAfter.mint_status === 'eligible' && !isGenesisRow(previewAfter)) {
    const total = String(previewAfter.record_points_atomic ?? '0');
    if (/^[0-9]+$/.test(total) && BigInt(total) > 0n) {
      const payee = await resolvePayee(memoizedSettlementDb(db), previewAfter, total, relayPeId);
      if (payee.kind === 'resolved') {
        legs = payee.legs.map((leg) => ({
          leg: leg.leg,
          contributor: leg.contributor.toLowerCase(),
          beneficiary_class: leg.beneficiaryClass as number,
          bps: leg.bps,
          points_atomic: leg.pointsAtomic,
        }));
      } else {
        refusal = `payee_${payee.reason}`;
      }
    } else {
      legs = [];
    }
  }

  return db.runTransaction(async (txn) => {
    const [heldSnap, keySnap] = [await txn.get(heldRef), await txn.get(keyRef)];
    if (!heldSnap.exists) return { outcome: 'missing' as const, before: null };
    const held = heldSnap.data() as HeldActDoc;
    const before = held.key.row;
    if (options.expect && !options.expect(before)) {
      return { outcome: 'precondition_failed' as const, before };
    }
    if (stableStringify(before) !== stableStringify(previewDoc.key.row)) {
      // The row moved between the preview and the transaction: judge again next pass.
      return { outcome: 'precondition_failed' as const, before };
    }
    await options.noveltyCounters?.inspect(txn);
    const after = { ...before, ...patch };
    const status = String(after.mint_status);
    const promoting = status === 'eligible';
    // A promotion whose payee cannot be resolved still lands the sweep's patch: the act IS
    // eligible (exactly as a pre-meter row the sweep flips, whose payee the settlement inlet then
    // fails to resolve), it simply waits for its payee under `payee_<reason>` — the same shape the
    // batch commit writes for an eligible act whose payee refused at seal. The payee retry pass
    // re-resolves it with a no-op patch. Dropping the patch here would lose the sweep's evidence
    // and leave a `payee_*` hold over a row still in its old status, which a no-op patch can
    // never promote.
    const refused = promoting && refusal !== null;

    const writer = new EconomicAggregateWriter(db, txn, options.nowMs);
    await writer.load(EconomicAggregateWriter.identitiesOf(before, after));

    // A held act's chain-verified financial fact is counted the moment it leaves its hold, never
    // while held (`actor-meter-totals.ts`) — exactly once, since the held record is removed here.
    const leavesHold = !refused && !HELD_MINT_STATUSES.has(status);
    const releasedFact = leavesHold ? held.key.facts?.financial ?? null : null;
    const releaseCounts = releasedFact !== null && financialFactCounts(releasedFact, after);
    const totalsRef = releaseCounts ? db.collection(ACTOR_METER_TOTALS_COLLECTION).doc(held.key.actor_id) : null;
    const totalsSnap = totalsRef !== null ? await txn.get(totalsRef) : null;
    const compact = leavesHold ? await prepareRelayHeldCompaction(db, txn, held.key, after, legs, options.nowMs) : null;

    const retireOwnerMetadata = leavesHold ? await prepareRetireRecoveredMintOnceMetadata(db, txn, relayPeId, after.mint_once_claim_evidence, expireAt(options.nowMs + METER_KEY_LIFETIME_MS)) : () => {};

    const retention = await planComplianceRetention(db, relayPeId, after, options.nowMs);
    const retainLocation = await prepareComplianceRetention(db, txn, retention, options.nowMs);
    await prepareLocationCopyFence(db, txn, String(after.userId ?? ''), [after], options.nowMs, true, retainLocation.actorDeadlines.get(String(after.userId ?? '')));
    if (patch.jurisdiction_context !== undefined || patch.jurisdiction_region !== undefined) patch = { ...patch, jurisdiction_context: after.jurisdiction_context, jurisdiction_region: after.jurisdiction_region };

    // Reads are done; writes follow.
    retainLocation();
    retireOwnerMetadata();
    options.noveltyCounters?.commit(txn);
    const claimRefs: FirebaseFirestore.DocumentReference[] = [];
    if (compact === null && promoting && !refused && legs !== null && legs.length > 0) {
      const identity = actKeyIdentity(held.key);
      for (const leg of legs) {
        if (BigInt(leg.points_atomic) <= 0n) continue;
        const ref = db.collection(METER_PENDING_CLAIMS_COLLECTION).doc(meterActClaimKey(relayPeId, leg.leg as PayoutLegRole));
        claimRefs.push(ref);
        createIndexedMeterClaim(db, txn, ref, buildPendingClaim({
          claim_key: meterActClaimKey(relayPeId, leg.leg as PayoutLegRole),
          unit: 'act',
          batch_hash: held.key.batch_hash,
          device_id: held.key.device_id,
          actor_id: held.key.actor_id,
          leg: leg.leg,
          contributor: leg.contributor,
          beneficiary_class: leg.beneficiary_class,
          record_points_atomic: leg.points_atomic,
          acts: [{ relay_pe_id: relayPeId, points_atomic: leg.points_atomic }],
          claim_id: meterActClaimId(identity, leg.leg as PayoutLegRole),
          act_identity: identity,
          created_at_ms: options.nowMs,
          ready_at_ms: Math.max(options.nowMs, held.key.timestamp + CROSS_WITNESS_TAKEOVER_WINDOW_MS),
        }));
      }
    }

    writer.applyMutation(before as unknown as PEHistoryDocument, after as unknown as PEHistoryDocument);
    compact?.apply(writer);
    adjustConsoleDispositionRollupInTransaction(txn, db, {
      fromDisposition: before.mint_disposition,
      toDisposition: after.mint_disposition,
      sealMs: typeof before.timestamp === 'number' ? before.timestamp : NaN,
      peId: relayPeId,
    });

    const heldReason = refused ? refusal : HELD_MINT_STATUSES.has(status) ? status : null;
    if (heldReason !== null) {
      txn.set(heldRef, {
        held_reason: heldReason,
        key: { row: patch },
        ...(refused ? { refused_at_ms: options.nowMs } : {}),
      }, { merge: true });
    } else {
      txn.delete(heldRef);
    }
    if (compact !== null) compact.write();
    else if (keySnap.exists) {
      txn.set(keyRef, {
        row: patch,
        held_reason: heldReason,
        ...(promoting && !refused && legs !== null ? { legs: legs.length > 0 ? legs : null, unit: legs.length > 0 ? 'act' : 'none' } : {}),
      }, { merge: true });
    }
    if (totalsRef !== null && totalsSnap !== null && releasedFact !== null) {
      const prior = coerceActorMeterTotals(totalsRef.id, totalsSnap.exists ? totalsSnap.data() : null);
      txn.set(totalsRef, { ...applyReleasedFinancialFact(prior, releasedFact, held.key.timestamp, options.nowMs) });
    }
    writer.commit();
    if (refused) return { outcome: 'promotion_refused' as const, before, reason: refusal ?? undefined };
    return {
      outcome: heldReason !== null ? 'still_held' as const : promoting ? 'promoted' as const : 'released_terminal' as const,
      before,
    };
  });
}
