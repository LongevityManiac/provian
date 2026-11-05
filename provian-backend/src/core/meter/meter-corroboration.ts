import { createIndexedMeterClaim } from './pending-claim-index';
import { FieldValue } from 'firebase-admin/firestore';
import { accrualEndedAt } from '../pvt/accrual-end-line';
import { privateRetentionCollection } from '../provenance/private-retention';
/**
 * PE METER — a corroboration landing on a metered act.
 *
 * Today's rule, unchanged: a recognized third-party corroboration inside the act's horizon
 * (30 days post-cut-line) lifts the act's attestation tier, and the lift is paid as an ADDITIVE
 * top-up — one per act leg, ever, never a rewind of the act's own claim. On the meter there is
 * no `pe_history` row for a settlement run to re-read, so the top-up is computed here, at the
 * moment the corroboration lands, from the act key (the act's sealed row + its frozen legs), and
 * written as a pending claim. First observation wins: a repeat cannot move the instant.
 */

import type { Firestore } from 'firebase-admin/firestore';
import type { PEHistoryDocument } from '../../pe-history';
import { corroborationLiftedRecordPointsAtomic } from '../pvt/policy/economic-projection';
import { attestationEnhancementWindowMsFor } from '../pvt/policy/monetary-accounting';
import { topupDeltasFor } from '../pvt/wp4/attestation-topup-inlet-source';
import type { PayoutLegRole } from '../pvt/wp-ev/payout-legs';
import {
  ACTOR_METER_DAY_LIFETIME_MS,
  ACTOR_METER_TOTALS_COLLECTION,
  coerceActorMeterTotals,
  isCorroborationStatus,
  PARTICIPATION_CORROBORATED_STATUSES,
  stageActorDayIncrement,
  utcDay,
} from './actor-meter-totals';
import { buildPendingClaim, meterTopupClaimId, meterTopupClaimKey, type MeterActLeg } from './meter-claims';
import { METER_ACT_KEYS_COLLECTION, METER_DEMOTED_ACT_STATUSES, METER_PENDING_CLAIMS_COLLECTION } from './meter-store';
import type { MeterActKeyDoc } from './meter-act-key';
import { actKeyIdentity } from './meter-act-key';

const RECOGNIZED = new Set(['on_chain_verified', 'merchant_confirmed', 'peer_verified', 'service_grant_attested']);

export async function recordMeterIncumbentCorroboration(
  db: Firestore,
  input: {
    readonly incumbentPeId: string;
    readonly corroboratingPeId: string;
    readonly nowMs: number;
    readonly status: string;
    /** The audit source recorded on the row; defaults to the corroborating PE id. */
    readonly source?: string;
  },
): Promise<{ readonly topups: number }> {
  const source = input.source ?? input.corroboratingPeId;
  if (!RECOGNIZED.has(input.status)) return { topups: 0 };
  const ref = privateRetentionCollection(db, METER_ACT_KEYS_COLLECTION).doc(input.incumbentPeId);
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) return { topups: 0 };
    const key = snap.data() as MeterActKeyDoc;
    const row = key.row as Record<string, unknown>;
    // First observation wins.
    if (RECOGNIZED.has(String(row.corroboration_status ?? ''))) return { topups: 0 };
    const recordedAt = typeof row.timestamp === 'number' ? row.timestamp : NaN;
    // Shutdown coverage: a corroboration observed at or after the accrual end line tops up nothing.
    const insideHorizon = Number.isFinite(recordedAt)
      && input.nowMs < recordedAt + attestationEnhancementWindowMsFor(recordedAt)
      && !accrualEndedAt(input.nowMs);
    const corroborated = {
      ...row,
      corroboration_status: input.status,
      corroboration_source: source,
      corroboration_received_at: input.nowMs,
    };
    const legs: readonly MeterActLeg[] = Array.isArray(key.legs) ? key.legs : [];
    // A demoted act (taken over, bug-demoted) earns nothing more: its occurrence's value is the
    // taker's, so a corroboration that lands after the demotion is recorded and lifts nothing
    // (the takeover voided any top-up it found pending; this is the one created after it).
    const demoted = METER_DEMOTED_ACT_STATUSES.has(String(row.mint_status ?? ''));
    const deltas = insideHorizon && !demoted && legs.length > 0 && row.mint_disposition === 'eligible'
      ? topupDeltasFor(
        BigInt(corroborationLiftedRecordPointsAtomic(corroborated as unknown as PEHistoryDocument) || '0'),
        legs.map((l) => ({ leg: l.leg, pointsAtomic: BigInt(l.points_atomic) })),
      )
      : [];
    // Every read before any write (Firestore transactions require it).
    const refs = deltas.map((d) => db.collection(METER_PENDING_CLAIMS_COLLECTION)
      .doc(meterTopupClaimKey(key.relay_pe_id, d.leg)));
    const existing = await Promise.all(refs.map((r) => txn.get(r)));
    const batchRef = key.pending_retention_v1 ? db.collection('meter_batches_v1').doc(key.batch_hash) : null;
    const batch = batchRef ? (await txn.get(batchRef)).data() : null;
    const createsPending = deltas.some((_, i) => !existing[i].exists);
    // The actor's running corroboration totals (`actor-meter-totals.ts`): this is the first
    // recognized corroboration on the act (the guard above), so it is counted exactly once here.
    // An act sealed already carrying a non-`none` status was counted by its batch commit.
    const countsLifetime = !isCorroborationStatus(row.corroboration_status);
    const totalsRef = countsLifetime ? db.collection(ACTOR_METER_TOTALS_COLLECTION).doc(key.actor_id) : null;
    const totalsSnap = totalsRef !== null ? await txn.get(totalsRef) : null;

    if (createsPending && batchRef && batch?.per_batch_pricing === true) txn.update(batchRef, { settlement_complete: false, expire_at: null,
      ...(Array.isArray(batch.topup_claim_keys) ? { topup_claim_keys: FieldValue.arrayUnion(...refs.filter((_, i) => !existing[i].exists).map(ref => ref.id)) } : {}),
    });
    txn.update(ref, {
      ...(createsPending && key.pending_retention_v1 ? { expire_at: null } : {}),
      'row.corroboration_status': input.status,
      'row.corroboration_source': source,
      'row.corroboration_received_at': input.nowMs,
    });
    if (totalsRef !== null && totalsSnap !== null) {
      const prior = coerceActorMeterTotals(totalsRef.id, totalsSnap.exists ? totalsSnap.data() : null);
      txn.set(totalsRef, { ...prior, corroborated: prior.corroborated + 1, updated_at_ms: input.nowMs });
    }
    // The participation summary's corroboration rate counts the act on its own day.
    if (PARTICIPATION_CORROBORATED_STATUSES.has(input.status) && Number.isFinite(recordedAt)
      && input.nowMs - recordedAt < ACTOR_METER_DAY_LIFETIME_MS) {
      stageActorDayIncrement(txn, db, {
        actorId: key.actor_id, day: utcDay(recordedAt), agentActions: 0, corroborated: 1,
      });
    }
    const identity = actKeyIdentity(key);
    let written = 0;
    deltas.forEach((d, i) => {
      if (existing[i].exists) return; // one top-up per leg, ever
      const leg = legs.find((l) => l.leg === d.leg) as MeterActLeg;
      createIndexedMeterClaim(db, txn, refs[i], buildPendingClaim({
        claim_key: meterTopupClaimKey(key.relay_pe_id, d.leg as PayoutLegRole),
        unit: 'topup',
        batch_hash: key.batch_hash,
        device_id: key.device_id,
        actor_id: key.actor_id,
        leg: d.leg,
        contributor: leg.contributor,
        beneficiary_class: leg.beneficiary_class,
        record_points_atomic: d.deltaAtomic.toString(),
        acts: [{ relay_pe_id: key.relay_pe_id, points_atomic: d.deltaAtomic.toString() }],
        claim_id: meterTopupClaimId(identity, d.leg as PayoutLegRole),
        act_identity: identity,
        created_at_ms: input.nowMs,
        ready_at_ms: 0,
      }));
      written += 1;
    });
    return { topups: written };
  });
}
