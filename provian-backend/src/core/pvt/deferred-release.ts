import { retainComplianceDecision } from '../jurisdiction/location-retention';
import { complianceForRow } from '../jurisdiction/mint-compliance';
/**
 * Deferred PE Release Processor
 *
 * When a jurisdiction's policy changes from 'deferred' to 'immediate',
 * this processor gradually transitions accumulated PEs from 'deferred'
 * to 'eligible' status, respecting the graduated release ceiling.
 *
 * Called by the scheduler. Does NOT mint PVT - it only changes
 * mint_status from 'deferred' to 'eligible'. The normal minting
 * engine then picks them up.
 *
 * Release never reprices. Only a valid committed record-time snapshot can move
 * back to eligible; malformed or legacy rows become zero-valued record-only.
 */

import { relayDb } from '../../firestore-db';
import type { Query, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { hashRecordEconomicSnapshot, type RecordEconomicSnapshot } from './policy/monetary-accounting';
import { mutatePeHistoryRowWithAggregate } from './policy/economic-aggregate';
import {
  collectAcrossShards,
  readPeHistoryReaderMode,
  withIndexShard,
} from './pe-history-index-shard';
import { walkHeldActs } from './held-act-sweep';

/** PE METER — the per-jurisdiction cursors of the walk over metered acts held `deferred`. */
export const DEFERRED_RELEASE_HELD_CURSOR_COLLECTION = 'pvt_deferred_release_held_cursor_v1';
/** Pages of held acts one run may walk looking for its jurisdiction's acts. */
export const DEFERRED_RELEASE_HELD_MAX_PAGES = 10;

function heldCursorDocId(jurisdiction: string): string {
  // A Firestore doc id may not contain '/'; a jurisdiction is an ISO code, but never trust it.
  return `j_${encodeURIComponent(jurisdiction)}`;
}

function numberOrInfinity(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

export interface DeferredReleaseConfig {
  jurisdiction: string;            // ISO country code
  daily_ceiling_percent: number;   // Max % of trailing 12-epoch avg daily mint volume
  re_attestation_required: boolean;
  activated_at: number;            // Unix ms - authorized prospective policy event; the operator-EOA-direct during bootstrap unless separately handed off
  active: boolean;                 // Whether this release is currently active
}

/**
 * Process one batch of deferred PE releases for a jurisdiction.
 * Returns the number of PEs transitioned to 'eligible'.
 */
export async function processDeferredReleaseBatch(
  config: DeferredReleaseConfig,
  trailingDailyMintAvg: number,  // Average PEs minted per day over trailing 12 epochs
): Promise<number> {
  const db = relayDb();

  // Calculate ceiling for this run
  const ceiling = Math.floor(trailingDailyMintAvg * (config.daily_ceiling_percent / 100));
  if (ceiling <= 0) return 0;

  // Query deferred PEs for this jurisdiction, oldest first.
  //
  // H5 — in SHARDED reader mode this fans out across every index shard
  // (each shard's oldest `ceiling` rows) and merges oldest-first, served by
  // (index_shard, mint_status, jurisdiction_context, timestamp); in LEGACY mode
  // it is the original single query. The mode is read from the migration
  // marker, which the backfill flips only once every row carries the field.
  const mode = await readPeHistoryReaderMode(db);
  const deferredQuery = (shard: number | null): Query => withIndexShard(db.collection('pe_history'), shard)
    .where('mint_status', '==', 'deferred')
    .where('jurisdiction_context', '==', config.jurisdiction)
    .orderBy('timestamp', 'asc');
  const docs: QueryDocumentSnapshot[] = mode === 'sharded'
    ? await collectAcrossShards(deferredQuery, {
      limit: ceiling,
      orderBy: (doc) => numberOrInfinity(doc.data().timestamp),
      map: (doc) => doc,
    })
    : (await deferredQuery(null).limit(ceiling).get()).docs;

  // Transition each PE from 'deferred' to 'eligible'.
  //
  // M5 — ONE TRANSACTION PER ROW, through the aggregate-aware mutation
  // primitive, instead of one WriteBatch for the page. A release flips a row
  // from a zero projection to eligible (and a legacy row to record-only), which
  // moves the accrual-time aggregate; that delta must land atomically with the
  // row write or the dashboard shows the wrong earnings. Rows are independent
  // of each other, so page-level atomicity bought nothing. The "still deferred"
  // precondition makes an overlapping run exactly-once per row.
  //
  // PE METER: the same primitive transitions a METERED held act through
  // `resolveHeldAct` (it delegates whenever a held record exists for the id), which on
  // release also resolves the act's payee and creates its pending claims.
  const nowMs = Date.now();
  const release = async (peId: string, patch: Record<string, unknown>): Promise<boolean> => {
    const { outcome } = await mutatePeHistoryRowWithAggregate(db, peId, patch, {
      nowMs,
      expect: (before) => before.mint_status === 'deferred',
    });
    return outcome === 'applied';
  };
  let count = 0;

  /** The release rule for ONE deferred row — a pre-meter `pe_history` row or a held act's row. */
  const releaseOne = async (peId: string, pe: Record<string, unknown>): Promise<void> => {
    const compliance = await complianceForRow(pe, db);
    if (compliance.policy !== 'immediate') { await retainComplianceDecision(db, peId, pe, compliance, nowMs); return; }
    // Optional: re-attestation check
    if (config.re_attestation_required) {
      // Verify hash chain integrity is still valid
      // (lightweight check - not full re-computation)
      if (!pe.peHash || !pe.userId) {
        console.log(`[Deferred Release] Skipping PE ${peId} - failed re-attestation`);
        return;
      }
    }

    const economicSnapshot = pe.economic_snapshot as RecordEconomicSnapshot | null | undefined;
    const snapshotHash = pe.economic_snapshot_hash;
    let exact = false;
    try {
      exact = economicSnapshot !== null
        && economicSnapshot !== undefined
        && typeof economicSnapshot === 'object'
        && typeof snapshotHash === 'string'
        && hashRecordEconomicSnapshot(economicSnapshot) === snapshotHash
        && economicSnapshot.peId === peId
        && economicSnapshot.actionType === pe.actionType
        && economicSnapshot.recordedAtMs === pe.timestamp
        && economicSnapshot.mintDisposition === 'eligible';
    } catch {
      exact = false;
    }
    if (!exact || !economicSnapshot) {
      await release(peId, {
        mint_status: 'record_only',
        mint_disposition: 'record_only',
        disposition_reason_code: 'unverifiable_evidence_record_only',
        estimatedPVT: 0,
        estimated_pvt_atomic: '0',
        economic_eligibility_projection: null,
        deferred_release_outcome: 'invalid_snapshot_record_only',
      });
      return;
    }

    const applied = await release(peId, {
      mint_status: 'eligible',
      mint_disposition: 'eligible',
      disposition_reason_code: 'policy_eligible',
      estimatedPVT: Number(BigInt(economicSnapshot.recordPointsAtomic)) / 1e18,
      estimated_pvt_atomic: economicSnapshot.recordPointsAtomic,
      record_points_atomic: economicSnapshot.recordPointsAtomic,
      economic_eligibility_projection: null,
      deferred_release_outcome: 'eligible_exact_snapshot',
      // deferred_since is preserved as audit evidence; economics stay sealed.
    });
    if (applied) count++;
  };

  for (const doc of docs) {
    await releaseOne(doc.id, doc.data());
  }

  // PE METER — metered acts held `deferred`, under the SAME per-run ceiling: the pre-meter rows
  // above took their share first (every pre-meter row predates every metered act, so oldest-first
  // still holds across the two populations), and the held acts of this jurisdiction take what is
  // left, walked from a per-jurisdiction resumable cursor (relay-pe-id order). The held-act index
  // carries no jurisdiction, so the walk filters it in memory under a bounded page budget.
  const remaining = ceiling - docs.length;
  if (remaining > 0) {
    let taken = 0;
    await walkHeldActs(db, 'deferred', {
      cursor: {
        collection: DEFERRED_RELEASE_HELD_CURSOR_COLLECTION,
        docId: heldCursorDocId(config.jurisdiction),
      },
      nowMs,
      limit: Math.min(500, Math.max(remaining, 100)),
      maxPages: DEFERRED_RELEASE_HELD_MAX_PAGES,
      stop: () => taken >= remaining,
    }, async (held) => {
      if (held.row.jurisdiction_context !== config.jurisdiction) return;
      taken += 1;
      await releaseOne(held.relayPeId, held.row);
    });
  }

  console.log(`[Deferred Release] Transitioned ${count} PEs from deferred to eligible for ${config.jurisdiction}`);
  return count;
}
