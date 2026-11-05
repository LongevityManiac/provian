import { BatchPricingCounters, retryNoveltyConflict } from '../meter/batch-pricing-counters';
/**
 * Exact pending-cache recovery.
 *
 * A cache outage is a recoverable operational hold, not authority to recompute
 * economics later. The record-time snapshot therefore preserves exact points
 * under its policy vintage while current projected value remains zero. Once the
 * cache is healthy, this worker stores immutable cache-resolution evidence and
 * projects an otherwise-complete snapshot to eligible.
 *
 * ONE sealed input was never evidence, and recovery now supplies it.
 * With Redis unreadable, record time cannot observe the (user, action, day)
 * occurrence ordinal, so every outage snapshot seals ordinal 1 — FULL novelty.
 * Recovering a cohort at that placeholder price was the Finding B
 * economic hole: an outage window recovered unboundedly at full-novelty
 * pricing (~3.33x the decayed price as the cohort grows). Recovery therefore
 * consumes one occurrence slot per PE against the ORIGINAL record day
 * (distinct ordinals per cohort; the priced total over distinct ordinals is
 * order-invariant) and reprices the row at the sealed vintage with only the
 * novelty factor corrected — never above the sealed price, never touching the
 * sealed snapshot, with the correction written as first-class evidence. Rows
 * reclassified before keep their `eligible_exact_snapshot` outcome and
 * are never repriced.
 *
 * Legacy rows without a valid committed snapshot become record-only. Current
 * Genesis never needs this path: its reservation-bound snapshot bypasses the
 * user/cache rate-limit surface and recovers at its exact fixed grant (fixed
 * grants are novelty-neutral by design). A legacy raw Genesis marker can never
 * re-arm the retired pool ledger.
 *
 * Drain shape (Finding B consumer M1): one run pages through the
 * pending population under a wall-clock budget instead of a single 200-row
 * batch, and a row that errors is skipped past WITHIN the run (the page
 * cursor advances regardless), so a permanently-failing row head-of-line
 * blocks one page slot, not the whole drain. Failed rows stay pending and are
 * re-scanned next run.
 */

import { relayDb } from '../../firestore-db';
import type { Firestore, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import type { RedisCache } from '../../cache';
import {
  hashRecordEconomicSnapshot,
  type RecordEconomicSnapshot,
} from './policy/monetary-accounting';
import {
  buildPendingCacheEligibilityProjection,
  deriveNoveltyCorrectedRecovery,
  utcDayKeyOfMs,
  type PendingCacheNoveltyCorrection,
} from './pending-cache-resolution';
import {
  assertActivityMintReservationEvidence,
  getActionTypeMintRule,
  type ActivityMintReservationDocument,
} from './activity-mint-limits';
import { mutatePeHistoryRowWithAggregate } from './policy/economic-aggregate';
import { readPeHistoryReaderMode, shardPlan, withIndexShard } from './pe-history-index-shard';
import {
  canonicalMintOnceClaimEvidence,
  mintOnceClaimCollectionFor,
  mintOnceClaimDocId,
  type MintOnceClaimEvidence,
  type MintOnceClaimKind,
} from './mint-once-claim';
import { x402MintClaimKey } from './x402-tx-mint-claim';
import { financialSettlementMintClaimKey } from './financial-settlement-mint-claim';
import { ORDINARY_ACCRUAL_INTAKE_COLLECTION } from './wp11/ordinary-accrual-intake';
import { DURABLE_ACCRUAL_EFFECTS_COLLECTION } from './durable-accrual-effects';
import { HELD_ACT_SWEEP_CURSOR_COLLECTION, walkHeldActs } from './held-act-sweep';

const PENDING_CACHE_AGE_MS = 5 * 60 * 1000;
const BACKFILL_BATCH_SIZE = 200;
/**
 * Wall-clock budget for one run. The hourly cron used to drain at most one
 * 200-row batch (≤4,800/day) — a large outage cohort took weeks while its
 * occurrence-day evidence aged. Paging under a budget drains thousands per
 * run; the scheduler's own request deadline is the outer bound.
 */
const DEFAULT_MAX_RUN_MS = 50_000;
/** PE METER — the cursor doc of the walk over metered acts held `pending_cache`. */
export const PENDING_CACHE_HELD_CURSOR_DOC = 'pending_cache_backfill';
/** Pages of held acts one run may walk (the wall-clock budget is the other bound). */
const PENDING_CACHE_HELD_MAX_PAGES = 50;
const ATOMIC = /^(0|[1-9][0-9]*)$/;

export interface BackfillResult {
  scanned: number;
  reclassified_eligible: number;
  reclassified_ineligible: number;
  reclassified_record_only: number;
  reclassified_pending_evidence: number;
  reclassified_pending_review: number;
  still_pending: number;
  errors: number;
  pages: number;
  stopped_on_budget: boolean;
  /** PE METER — metered held acts examined (also counted in `scanned` and the tallies). */
  held_acts_scanned: number;
}

interface PendingRow {
  peId?: string;
  userId?: string;
  actionType?: string;
  timestamp?: number;
  economic_snapshot?: RecordEconomicSnapshot | null;
  economic_snapshot_hash?: string | null;
  activity_mint_reservation?: ActivityMintReservationDocument | null;
  activity_mint_reservation_hash?: string | null;
  is_genesis_grant?: boolean;
  /** the completion this row witnesses, when the seal prepared its claim. */
  completion_canonical_id?: string | null;
  /** The mint-once claims the seal committed with this row (owner/duplicate evidence). */
  mint_once_claim_evidence?: MintOnceClaimEvidence[] | null;
}

/**
 * Every mint-once slot is inspected. The seal claims a row's slots for every
 * non-terminal seal (including `pending_cache`), but this backfill is the ONE
 * path that turns a held row `eligible` without a verifier, so it must never
 * promote a row whose slot another PE owns — that is exactly the second
 * eligible row of one act — nor a row that SHOULD hold a slot and holds none.
 *
 * ONE inspection over the row's own mint-once markers, no per-kind branch at
 * the decision: the sealed `mint_once_claim_evidence` names every claim the
 * seal committed (kind + claim id), and each is re-read from its collection
 * (`mintOnceClaimCollectionFor`) and compared on `owner_pe_id`. The artifact
 * kind is excluded exactly as `assertMintOnceClaimEvidence` excludes it — a
 * per-UTC-day novelty claim held by another PE is a price factor, not an exact
 * duplicate of the act.
 *
 * A row sealed BEFORE the seal fixes carries NO evidence for the kind its
 * seal skipped, so the claim the seal SHOULD have prepared is reconstructed
 * from the exact replay input — the ordinary-intake `accrual_params` (the
 * mainline shape), or for a durable `throwOnError` caller (the outbound-USDC
 * watcher, the real x402 / financial producer) the durable-effect payload
 * plus the sealed snapshot's record-time factors — through the SAME key
 * derivations the seal uses (`x402MintClaimKey`,
 * `financialSettlementMintClaimKey`, the completion canonical id) and the ONE
 * claim-id derivation (`mintOnceClaimDocId`). Only the three once-guarded
 * kinds need reconstruction: commit / occurrence / device-occurrence claims
 * were never guarded by `cacheUnavailable`, so a `pending_cache` row of those
 * kinds always carries its evidence.
 * no_mint_once_marker → the ordinary recovery applies;
 * owned → this row owns every slot it names; recovery applies;
 * owned_by_other → REFUSE: record `corroborated_duplicate`, 0;
 * unclaimed → a row that should hold a slot and holds none cannot
 * be promoted unattended (Unknown = Block): hold for
 * review;
 * unreadable → its own evidence cannot be parsed: hold for review.
 */
type MintOnceSlotInspection =
  | { readonly kind: 'no_mint_once_marker' }
  | { readonly kind: 'owned'; readonly claimKinds: readonly MintOnceClaimKind[] }
  | {
    readonly kind: 'owned_by_other';
    readonly claimKind: MintOnceClaimKind;
    readonly claimId: string;
    readonly ownerPeId: string;
  }
  | { readonly kind: 'unclaimed'; readonly claimKind: MintOnceClaimKind; readonly claimId: string }
  | { readonly kind: 'unreadable'; readonly reason: string };

interface ExpectedClaim {
  readonly claimKind: MintOnceClaimKind;
  readonly claimId: string;
}

/** The subset of the seal's replay input the three once-guarded claim keys read. */
interface ReplayView {
  readonly actionType: string;
  readonly completionCanonicalId: string | null;
  readonly x402ChainVerified: boolean | null;
  readonly x402PayerAddress: string | null;
  readonly x402SettlementTxHash: string | null;
  readonly economicEvidenceState: string | null;
  readonly economicCanonicalEventId: string | null;
  readonly walletAddress: string | null;
}

const CHAIN_LOG_EVENT_TX = /^\d{1,10}:(0x[0-9a-fA-F]{64}):\d{1,6}$/;

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The replay input the seal ran with, from the durable source that backs THIS
 * row. Ordinary-intake rows carry the exact `RecordPEAccrualParams`; a
 * `throwOnError` row (the watcher) carries no intake, so its view is rebuilt
 * from the durable-effect payload (`x402PayerAddress`, `ownerWalletAddress`)
 * and the sealed snapshot (`evidenceState`, `canonicalEventId`). The watcher
 * stamps `metadata.verified` and `chain_verified` together on one emit and
 * seals the log-granular `chainId:txHash:logIndex` of the SAME `event.txHash`
 * it stamps as the settlement tx (`outbound-usdc-watcher.ts` emitActivityPE),
 * so `evidenceState === 'verified'` stands in for `x402ChainVerified` and the
 * tx segment for the settlement tx. A wrong inference errs to `unclaimed` —
 * a review hold, never a promotion.
 */
async function replayView(
  db: Firestore,
  peId: string,
  data: PendingRow,
  snapshot: RecordEconomicSnapshot,
): Promise<ReplayView | null> {
  const intake = await db.collection(ORDINARY_ACCRUAL_INTAKE_COLLECTION).doc(peId).get();
  if (intake.exists) {
    const params = (intake.data() as { accrual_params?: Record<string, unknown> } | undefined)
      ?.accrual_params;
    if (params && typeof params === 'object') {
      return {
        actionType: str(params.actionType) ?? data.actionType ?? '',
        completionCanonicalId: str(data.completion_canonical_id) ?? str(params.completionCanonicalId),
        x402ChainVerified: params.x402ChainVerified === true,
        x402PayerAddress: str(params.x402PayerAddress),
        x402SettlementTxHash: str(params.x402SettlementTxHash),
        economicEvidenceState: str(params.economicEvidenceState),
        economicCanonicalEventId: str(params.economicCanonicalEventId),
        walletAddress: str(params.walletAddress),
      };
    }
  }
  const effect = await db.collection(DURABLE_ACCRUAL_EFFECTS_COLLECTION).doc(peId).get();
  const payload = effect.exists
    ? (effect.data() as { payload?: Record<string, unknown> } | undefined)?.payload
    : undefined;
  if (!payload || typeof payload !== 'object') {
    // No durable replay source at all: only the row's own markers can speak.
    const completionCanonicalId = str(data.completion_canonical_id);
    if (completionCanonicalId === null) return null;
    return {
      actionType: data.actionType ?? '',
      completionCanonicalId,
      x402ChainVerified: null,
      x402PayerAddress: null,
      x402SettlementTxHash: null,
      economicEvidenceState: null,
      economicCanonicalEventId: null,
      walletAddress: null,
    };
  }
  const factors = snapshot.recordTimeFactors;
  const canonicalEventId = str(factors.canonicalEventId);
  const verified = factors.evidenceState === 'verified';
  const txFromLogIdentity = canonicalEventId === null
    ? null
    : (CHAIN_LOG_EVENT_TX.exec(canonicalEventId)?.[1] ?? null);
  return {
    actionType: data.actionType ?? '',
    completionCanonicalId: str(data.completion_canonical_id),
    x402ChainVerified: verified,
    x402PayerAddress: str(payload.x402PayerAddress),
    x402SettlementTxHash: txFromLogIdentity
      ?? (canonicalEventId !== null && /^0x[0-9a-fA-F]{64}$/.test(canonicalEventId)
        ? canonicalEventId
        : null),
    economicEvidenceState: verified ? 'verified' : factors.evidenceState,
    economicCanonicalEventId: canonicalEventId,
    walletAddress: str(payload.ownerWalletAddress),
  };
}

/** The claims the seal SHOULD have prepared for this row, by the seal's own rules. */
function expectedClaimsFromReplay(
  userId: string,
  view: ReplayView,
  snapshot: RecordEconomicSnapshot,
): ExpectedClaim[] {
  const expected: ExpectedClaim[] = [];
  if (view.completionCanonicalId !== null) {
    expected.push({
      claimKind: 'completion',
      claimId: mintOnceClaimDocId('completion', userId, view.completionCanonicalId),
    });
  }
  const x402Key = x402MintClaimKey(view);
  if (x402Key !== null) {
    expected.push({
      claimKind: 'x402',
      claimId: mintOnceClaimDocId('x402', x402Key.payer, x402Key.settlementTx),
    });
  }
  const financialKey = financialSettlementMintClaimKey({
    ...view,
    canonicalEventGroup: snapshot.recordTimeFactors.canonicalEventGroup,
  });
  if (financialKey !== null) {
    expected.push({
      claimKind: 'financial_settlement',
      claimId: mintOnceClaimDocId(
        'financial_settlement',
        financialKey.settlingAddress,
        financialKey.settlementEventId,
      ),
    });
  }
  return expected;
}

async function inspectMintOnceSlots(
  db: Firestore,
  peId: string,
  userId: string,
  data: PendingRow,
  snapshot: RecordEconomicSnapshot,
): Promise<MintOnceSlotInspection> {
  let evidence: MintOnceClaimEvidence[];
  try {
    evidence = canonicalMintOnceClaimEvidence(data.mint_once_claim_evidence);
  } catch (error) {
    return {
      kind: 'unreadable',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const expected = new Map<MintOnceClaimKind, ExpectedClaim>();
  for (const item of evidence) {
    if (item.claim.claim_kind === 'artifact') continue;
    if (item.relation === 'duplicate') {
      // The row's own evidence already names another owner.
      return {
        kind: 'owned_by_other',
        claimKind: item.claim.claim_kind,
        claimId: item.claim.claim_id,
        ownerPeId: item.claim.owner_pe_id,
      };
    }
    expected.set(item.claim.claim_kind, {
      claimKind: item.claim.claim_kind,
      claimId: item.claim.claim_id,
    });
  }
  const view = await replayView(db, peId, data, snapshot);
  if (view !== null) {
    for (const claim of expectedClaimsFromReplay(userId, view, snapshot)) {
      if (!expected.has(claim.claimKind)) expected.set(claim.claimKind, claim);
    }
  }
  if (expected.size === 0) return { kind: 'no_mint_once_marker' };

  for (const claim of expected.values()) {
    const doc = await db.collection(mintOnceClaimCollectionFor(claim.claimKind))
      .doc(claim.claimId)
      .get();
    if (!doc.exists) return { kind: 'unclaimed', claimKind: claim.claimKind, claimId: claim.claimId };
    const owner = (doc.data() as { owner_pe_id?: unknown } | undefined)?.owner_pe_id;
    if (owner !== peId) {
      return {
        kind: 'owned_by_other',
        claimKind: claim.claimKind,
        claimId: claim.claimId,
        ownerPeId: typeof owner === 'string' ? owner : 'unreadable',
      };
    }
  }
  return { kind: 'owned', claimKinds: [...expected.keys()] };
}

function exactSnapshot(data: PendingRow): RecordEconomicSnapshot | null {
  const snapshot = data.economic_snapshot;
  if (!snapshot || typeof data.economic_snapshot_hash !== 'string') return null;
  try {
    if (hashRecordEconomicSnapshot(snapshot) !== data.economic_snapshot_hash
      || snapshot.peId !== data.peId
      || snapshot.actionType !== data.actionType
      || snapshot.recordedAtMs !== data.timestamp
      || !ATOMIC.test(snapshot.recordPointsAtomic)) {
      return null;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function legacyDisplay(atomic: string): number {
  return Number(BigInt(atomic)) / 1e18;
}

export async function backfillPendingCachePEs(
  cache: RedisCache,
  dbOverride?: Firestore,
  options?: { readonly maxRunMs?: number; readonly now?: () => number },
): Promise<BackfillResult> {
  const result: BackfillResult = {
    scanned: 0,
    reclassified_eligible: 0,
    reclassified_ineligible: 0,
    reclassified_record_only: 0,
    reclassified_pending_evidence: 0,
    reclassified_pending_review: 0,
    still_pending: 0,
    errors: 0,
    pages: 0,
    stopped_on_budget: false,
    held_acts_scanned: 0,
  };
  if (!cache.isEnabled()) {
    console.warn(
      '[PendingCacheBackfill] cache still unavailable - leaving pending_cache PEs untouched',
    );
    return result;
  }

  const db = dbOverride ?? relayDb();
  const now = options?.now ?? Date.now;
  const maxRunMs = options?.maxRunMs ?? DEFAULT_MAX_RUN_MS;
  const startedAt = now();
  const cutoff = startedAt - PENDING_CACHE_AGE_MS;

  // H5 — one paged drain PER INDEX SHARD in sharded reader mode (served
  // by (index_shard, mint_status, timestamp)); the single unsharded drain in
  // legacy mode. Order within a shard is oldest-first; across shards it is
  // shard order — this drain needs completeness, not a global order, and the
  // wall-clock budget spans all shards.
  const mode = await readPeHistoryReaderMode(db);
  shards: for (const shard of shardPlan(mode)) {
    let pageAfter: QueryDocumentSnapshot | undefined;
    for (;;) {
      // Explicit total order (timestamp, then document id) so the page cursor
      // can never skip or repeat rows that share a timestamp. Served by the
      // (mint_status, timestamp) composite index — or its index_shard-led twin
      // — Firestore composite indexes implicitly end on __name__.
      let query = withIndexShard(db.collection('pe_history'), shard)
        .where('mint_status', '==', 'pending_cache')
        .where('timestamp', '<=', cutoff)
        .orderBy('timestamp', 'asc')
        .orderBy('__name__', 'asc')
        .limit(BACKFILL_BATCH_SIZE);
      if (pageAfter !== undefined) query = query.startAfter(pageAfter);
      const page = await query.get();
      if (page.empty) break;
      result.pages += 1;
      result.scanned += page.size;
      pageAfter = page.docs[page.docs.length - 1];

      for (const doc of page.docs) {
        try {
          await reclassifyOne(db, cache, doc.id, doc.data() as PendingRow, result, now);
        } catch (error) {
          console.warn('[PendingCacheBackfill] reclassify failed for PE', doc.id, error);
          result.errors += 1;
          result.still_pending += 1;
        }
      }

      if (page.size < BACKFILL_BATCH_SIZE) break;
      if (now() - startedAt >= maxRunMs) {
        result.stopped_on_budget = true;
        break shards;
      }
    }
  }

  // PE METER — the metered acts held `pending_cache`: the same age gate, the same rule (`reclassifyOne`,
  // whose every write goes through `mutatePeHistoryRowWithAggregate`, which transitions a held act
  // through `resolveHeldAct`), the same Redis-atomic check-and-consume before any `eligible`, under
  // the SAME wall-clock budget. Walked from a durable cursor, so a run the budget cuts short resumes
  // where it stopped instead of re-reading the head.
  if (!result.stopped_on_budget) {
    const held = await walkHeldActs(db, 'pending_cache', {
      cursor: { collection: HELD_ACT_SWEEP_CURSOR_COLLECTION, docId: PENDING_CACHE_HELD_CURSOR_DOC },
      nowMs: now(),
      limit: BACKFILL_BATCH_SIZE,
      maxPages: PENDING_CACHE_HELD_MAX_PAGES,
      stop: () => now() - startedAt >= maxRunMs,
    }, async (heldAct) => {
      const data = heldAct.row as PendingRow;
      // The pre-meter query's age gate (`timestamp <= cutoff`): a fresh act is not yet recoverable.
      if (typeof data.timestamp !== 'number' || data.timestamp > cutoff) return;
      result.scanned += 1;
      result.held_acts_scanned += 1;
      try {
        await reclassifyOne(db, cache, heldAct.relayPeId, data, result, now);
      } catch (error) {
        console.warn('[PendingCacheBackfill] reclassify failed for held act', heldAct.relayPeId, error);
        result.errors += 1;
        result.still_pending += 1;
      }
    });
    result.pages += held.pages;
    if (held.stopped) result.stopped_on_budget = true;
  }

  console.info('[PendingCacheBackfill] complete', result);
  return result;
}

/**
 * Every reclassification lands through the aggregate-aware mutation primitive
 * (M5): the row is re-read inside a transaction, the (−before, +after)
 * delta is applied to the accrual-time aggregate — a recovered row moving from
 * a zero projection to eligible, or a novelty-corrected row moving its
 * record points DOWN — and the patch is written, all atomically. The
 * precondition ("still pending_cache") is what makes two overlapping runs
 * exactly-once on one row: the loser sees `precondition_failed` and counts
 * nothing.
 */
async function writeReclassification(
  db: Firestore,
  peId: string,
  patch: Record<string, unknown>,
  nowMs: number,
  noveltyCounters?: BatchPricingCounters,
): Promise<boolean> {
  const { outcome } = await mutatePeHistoryRowWithAggregate(db, peId, patch, {
    nowMs,
    expect: (before) => before.mint_status === 'pending_cache',
    noveltyCounters,
  });
  return outcome === 'applied';
}

async function reclassifyOne(db: Firestore, cache: RedisCache, peId: string, data: PendingRow,
  result: BackfillResult, now: () => number): Promise<void> {
  return retryNoveltyConflict(() => reclassifyOneAttempt(db, cache, peId, data, result, now));
}

async function reclassifyOneAttempt(
  db: Firestore,
  cache: RedisCache,
  peId: string,
  data: PendingRow,
  result: BackfillResult,
  now: () => number,
): Promise<void> {
  // `peId` is the row's id: a pre-meter `pe_history` document id, or a metered act's relay pe id
  // (its held record's id). The rule is the same for both.
  const recordOnly = async (outcome: string, reasonCode = 'unverifiable_evidence_record_only') => {
    const applied = await writeReclassification(db, peId, {
      mint_status: 'record_only',
      mint_disposition: 'record_only',
      disposition_reason_code: reasonCode,
      estimatedPVT: 0,
      estimated_pvt_atomic: '0',
      economic_eligibility_projection: null,
      pending_cache_reclassified_at: now(),
      pending_cache_outcome: outcome,
    }, now());
    if (applied) result.reclassified_record_only += 1;
  };

  const snapshot = exactSnapshot(data);
  if (snapshot === null) {
    await recordOnly(data.is_genesis_grant === true
      ? 'legacy_genesis_record_only'
      : 'missing_or_invalid_snapshot_record_only');
    return;
  }

  // A reservation-bound Genesis snapshot is already exact and isolated
  // from cache economics. Recover it without consulting any legacy ledger.
  // Fixed grants are novelty-neutral by design, so no ordinal is consumed
  // and no correction applies: the reserved gross IS the recovery value.
  if (snapshot.recordTimeFactors.fixedGrantSource === 'genesis_campaign_reservation'
    && snapshot.mintDisposition === 'eligible') {
    const applied = await writeReclassification(db, peId, {
      mint_status: 'eligible',
      mint_disposition: 'eligible',
      disposition_reason_code: 'policy_eligible',
      estimatedPVT: legacyDisplay(snapshot.recordPointsAtomic),
      estimated_pvt_atomic: snapshot.recordPointsAtomic,
      record_points_atomic: snapshot.recordPointsAtomic,
      economic_eligibility_projection: null,
      pending_cache_reclassified_at: now(),
      pending_cache_outcome: 'exact_genesis_snapshot_recovered',
    }, now());
    if (applied) result.reclassified_eligible += 1;
    return;
  }

  const userId = typeof data.userId === 'string' ? data.userId : '';
  if (!userId || snapshot.economicActorId !== userId) {
    await recordOnly('economic_actor_mismatch_record_only');
    return;
  }

  if (snapshot.mintDisposition !== 'pending_cache') {
    await recordOnly('snapshot_state_mismatch_record_only');
    return;
  }

  // The Redis outage hold must not become a bypass around standing
  // Financial caps. Ruled actions were required to reserve their exact cap
  // slots at record time; missing/tampered evidence is terminal record-only.
  if (getActionTypeMintRule(data.actionType ?? '')) {
    try {
      assertActivityMintReservationEvidence(data.activity_mint_reservation, {
        peId,
        userId,
        actionType: data.actionType!,
        timestampMs: data.timestamp!,
        reservationHash: data.activity_mint_reservation_hash,
      });
    } catch {
      await recordOnly('activity_cap_reservation_invalid_record_only');
      return;
    }
  }

  const gates = new Set(snapshot.recordTimeFactors.unresolvedRecordGates);
  if (gates.has('session_lineage')) {
    await recordOnly('missing_session_lineage_record_only', 'missing_session_lineage_record_only');
    return;
  }
  if (gates.has('registry')) {
    const applied = await writeReclassification(db, peId, {
      mint_status: 'pending_review',
      mint_disposition: 'pending_review',
      disposition_reason_code: 'awaiting_review',
      estimatedPVT: 0,
      estimated_pvt_atomic: '0',
      economic_eligibility_projection: null,
      pending_cache_reclassified_at: now(),
      pending_cache_outcome: 'awaiting_registry',
    }, now());
    if (applied) result.reclassified_pending_review += 1;
    return;
  }
  if (gates.has('evidence') || gates.has('canonical_event')) {
    const applied = await writeReclassification(db, peId, {
      mint_status: 'pending_evidence',
      mint_disposition: 'pending_evidence',
      disposition_reason_code: 'awaiting_evidence',
      estimatedPVT: 0,
      estimated_pvt_atomic: '0',
      economic_eligibility_projection: null,
      pending_cache_reclassified_at: now(),
      pending_cache_outcome: 'awaiting_evidence',
    }, now());
    if (applied) result.reclassified_pending_evidence += 1;
    return;
  }

  // EVERY mint-once slot the row names or should name (generalized from the
  // completion-only check): the row is promoted
  // only if it OWNS each of them. Checked after every non-cache gate and
  // before any Redis slot is consumed, so a refused row consumes nothing.
  // Every refusal lands through the aggregate-aware mutation (M5).
  const slots = await inspectMintOnceSlots(db, peId, userId, data, snapshot);
  if (slots.kind === 'owned_by_other') {
    const applied = await writeReclassification(db, peId, {
      mint_status: 'corroborated_duplicate',
      mint_disposition: 'ineligible_terminal',
      disposition_reason_code: 'exact_duplicate',
      estimatedPVT: 0,
      estimated_pvt_atomic: '0',
      economic_eligibility_projection: null,
      pending_cache_reclassified_at: now(),
      pending_cache_outcome: 'mint_once_slot_owned_by_other_pe',
      mint_once_slot_kind: slots.claimKind,
      mint_once_slot_claim_id: slots.claimId,
      mint_once_slot_owner_pe_id: slots.ownerPeId,
    }, now());
    if (applied) result.reclassified_ineligible += 1;
    return;
  }
  if (slots.kind === 'unclaimed' || slots.kind === 'unreadable') {
    const applied = await writeReclassification(db, peId, {
      mint_status: 'pending_review',
      mint_disposition: 'pending_review',
      disposition_reason_code: 'awaiting_review',
      estimatedPVT: 0,
      estimated_pvt_atomic: '0',
      economic_eligibility_projection: null,
      pending_cache_reclassified_at: now(),
      ...(slots.kind === 'unclaimed'
        ? {
          pending_cache_outcome: 'mint_once_slot_unclaimed_awaiting_review',
          mint_once_slot_kind: slots.claimKind,
          mint_once_slot_claim_id: slots.claimId,
        }
        : {
          pending_cache_outcome: 'mint_once_evidence_unreadable_awaiting_review',
          mint_once_slot_unreadable_reason: slots.reason,
        }),
    }, now());
    if (applied) result.reclassified_pending_review += 1;
    return;
  }

  // One atomic Redis script advances the recovered PE's hourly+daily counters
  // AND its (user, action, ORIGINAL-day) occurrence ordinal exactly once,
  // after every non-cache gate has passed but before eligibility is written.
  // Its per-PE claim makes a Redis-success/Firestore-failure retry idempotent.
  // Any Redis error throws and leaves this row pending.
  //
  // there is NO capacity refusal here — the per-user volume ceilings
  // are removed, so a Redis outage recovers every otherwise-complete snapshot
  // regardless of same-day volume. what volume DOES do is price — the
  // recovered occurrence ordinal below reprices this row at the decayed
  // novelty its event legitimately earned.
  const occurrenceDay = utcDayKeyOfMs(snapshot.recordedAtMs);
  const counters = new BatchPricingCounters();
  const [, occurrenceBefore] = await counters.counts(db, cache, userId, snapshot.actionType, snapshot.recordedAtMs);
  const legacySlot = await cache.consumeRecoveredPECounterSlot(
    userId,
    peId,
    snapshot.actionType,
    occurrenceDay,
  );

  const slot = { ...legacySlot, occurrenceCountBefore: occurrenceBefore, occurrenceCountAfter: occurrenceBefore + 1 };
  counters.stageCounts(userId, snapshot.actionType, snapshot.recordedAtMs);
  const recoveredOrdinal = slot.occurrenceCountBefore + 1;
  const derivation = deriveNoveltyCorrectedRecovery(snapshot, recoveredOrdinal);
  const correction: PendingCacheNoveltyCorrection = {
    occurrence_day: occurrenceDay,
    sealed_occurrence_ordinal: snapshot.recordTimeFactors.occurrenceOrdinal,
    recovered_occurrence_ordinal: recoveredOrdinal,
    sealed_novelty_bps: derivation.sealedNoveltyBps,
    applied_novelty_bps: derivation.appliedNoveltyBps,
    sealed_record_points_atomic: snapshot.recordPointsAtomic,
    corrected_record_points_atomic: derivation.correctedPointsAtomic,
  };

  const observedAt = now();
  const projection = buildPendingCacheEligibilityProjection(
    peId,
    userId,
    data.economic_snapshot_hash!,
    observedAt,
    slot.hourlyCountBefore,
    slot.dailyCountBefore,
    {
      occurrenceDay,
      occurrenceCountBefore: slot.occurrenceCountBefore,
      appliedNoveltyBps: derivation.appliedNoveltyBps,
      correctedRecordPointsAtomic: derivation.correctedPointsAtomic,
    },
  );
  // The novelty-corrected repricing MUTATES this row's settleable points after
  // the fact (record_points_atomic ↓). The aggregate delta for that lower value
  // is applied inside the same transaction as this write — see
  // `writeReclassification`.
  const applied = await writeReclassification(db, peId, {
    mint_status: 'eligible',
    mint_disposition: 'eligible',
    disposition_reason_code: 'policy_eligible',
    estimatedPVT: legacyDisplay(derivation.correctedPointsAtomic),
    estimated_pvt_atomic: derivation.correctedPointsAtomic,
    record_points_atomic: derivation.correctedPointsAtomic,
    economic_eligibility_projection: projection,
    pending_cache_reclassified_at: observedAt,
    pending_cache_outcome: 'eligible_novelty_corrected',
    pending_cache_novelty_correction: correction,
    pending_cache_rate_limit_evidence: {
      hourly_count_before: slot.hourlyCountBefore,
      daily_count_before: slot.dailyCountBefore,
      hourly_count_after: slot.hourlyCountAfter,
      daily_count_after: slot.dailyCountAfter,
      occurrence_count_before: slot.occurrenceCountBefore,
      occurrence_count_after: slot.occurrenceCountAfter,
      occurrence_day: occurrenceDay,
      slot_consumed: true,
      redis_claim_id: peId,
      idempotent_replay: slot.idempotent,
    },
  }, observedAt, counters);
  if (applied) result.reclassified_eligible += 1;
}
