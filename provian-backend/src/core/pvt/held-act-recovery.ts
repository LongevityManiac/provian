/**
 * PE METER — the two payee recoveries for METERED held acts.
 *
 *  1. BENEFICIARY PENDING. A linked-agent act parked `beneficiary_pending` (its human beneficiary
 *     address could not be resolved) is restored to `eligible` once the committed route resolves
 *     — the exact rule the retired PVTv8 `minting-engine.ts::recoverBeneficiaryPendingPEs`
 *     applied to pre-meter `pe_history` rows (`judgeBeneficiaryPendingRow` is that rule): a row whose
 *     economic binding or routing evidence is invalid becomes `record_only`; a resolvable route
 *     with well-formed record points becomes `eligible`; anything else stays parked. The human's
 *     share is NEVER rerouted to the agent. For a held act the transition is `resolveHeldAct`, so
 *     a restored act also resolves its payee legs and gets its own act-unit pending claims.
 *
 *  2. PAYEE RETRY. An act whose row is `eligible` but whose payee could not be resolved waits in
 *     `meter_held_acts_v1` under `payee_<reason>` (written by the batch commit at seal, or by
 *     `resolveHeldAct` when a promotion's payee refused). Nothing about the act needs judging
 *     again — only its payee — so the retry is `resolveHeldAct(db, id, {}, { nowMs })`: a no-op
 *     patch that re-resolves the payee and, if it now resolves, creates the claims and removes the
 *     hold; if it still refuses, the act stays held under the (possibly new) reason.
 *
 * Both walk `listHeldActs` pages (bounded, resumable from a durable cursor per held reason) —
 * never a scan proportional to an actor's history. Pre-meter `pe_history` rows are untouched here.
 */

import type { Firestore } from 'firebase-admin/firestore';
import type { PEHistoryDocument } from '../../pe-history';
import { hashRecordEconomicSnapshot } from './policy/monetary-accounting';
import { assertBeneficiaryRoutingEvidence } from './beneficiary-routing';
import { resolveCommittedBeneficiaryAddress } from './mint-recipient-resolver';
import type { PayeeRefusalReason } from './wp4/claim-inlet-source';
import type { HeldActOutcome } from '../meter/held-acts';
import { HELD_ACT_SWEEP_CURSOR_COLLECTION, walkHeldActs } from './held-act-sweep';

const ATOMIC = /^(0|[1-9][0-9]*)$/;

/**
 * Every `PayeeRefusalReason`, as the `payee_<reason>` held reason it becomes. `satisfies` plus the
 * exhaustiveness check below make adding a refusal reason without adding it here a type error, so
 * a new reason can never leave its acts held with no retry.
 */
const PAYEE_REFUSAL_REASONS = [
  'actor_unresolvable',
  'payee_wallet_not_found',
  'payee_wallet_unusable',
  'payee_identity_ambiguous',
  'linked_agent_routing_invalid',
  'linked_agent_routing_uncommitted',
  'linked_agent_split_refused',
] as const satisfies readonly PayeeRefusalReason[];
type MissingPayeeReason = Exclude<PayeeRefusalReason, (typeof PAYEE_REFUSAL_REASONS)[number]>;
const PAYEE_REASONS_EXHAUSTIVE: MissingPayeeReason extends never ? true : never = true;
void PAYEE_REASONS_EXHAUSTIVE;

export const PAYEE_HELD_REASONS: readonly string[] = Object.freeze(
  PAYEE_REFUSAL_REASONS.map((reason) => `payee_${reason}`),
);

export type BeneficiaryPendingJudgement =
  | { readonly kind: 'invalid' }
  | { readonly kind: 'resolved' }
  | { readonly kind: 'unresolved' };

/**
 * THE beneficiary-pending rule, for one parked row (pre-meter or metered). `addressCache` dedups
 * the committed-address lookups across one pass, exactly as the pre-meter sweep always did.
 */
export async function judgeBeneficiaryPendingRow(
  db: Firestore,
  peId: string,
  data: PEHistoryDocument,
  addressCache: Map<string, string | null>,
): Promise<BeneficiaryPendingJudgement> {
  const snapshot = data.economic_snapshot;
  let route: ReturnType<typeof assertBeneficiaryRoutingEvidence>;
  try {
    if (!snapshot
      || !data.economic_snapshot_hash
      || hashRecordEconomicSnapshot(snapshot) !== data.economic_snapshot_hash
      || snapshot.peId !== data.peId
      || snapshot.economicActorId !== data.userId
      || snapshot.actionType !== data.actionType
      || snapshot.recordedAtMs !== data.timestamp) {
      throw new Error('beneficiary_pending_economic_binding_invalid');
    }
    route = assertBeneficiaryRoutingEvidence({
      peId: data.peId,
      economicActorId: data.userId,
      recordedAtMs: data.timestamp,
      linkageState: snapshot.recordTimeFactors.linkageState,
      beneficiaryAgentShareBps: snapshot.recordTimeFactors.beneficiaryAgentShareBps,
      fixedGrantSource: snapshot.recordTimeFactors.fixedGrantSource,
      routingSnapshot: data.beneficiary_routing_snapshot,
      routingSnapshotHash: data.beneficiary_routing_snapshot_hash,
      beneficiaryWalletId: data.beneficiary_wallet_id,
      pvtSplit: data.pvt_split,
    });
    if (!route) throw new Error('beneficiary_pending_route_missing');
  } catch (error) {
    console.error(`[PVT Mint] Invalid parked beneficiary route for ${peId}:`, error);
    return { kind: 'invalid' };
  }
  const benId = route.human_user_id;
  const routeKey = `${route.human_wallet_id}:${benId}:${route.human_address}`;
  if (!addressCache.has(routeKey)) {
    try {
      addressCache.set(routeKey, await resolveCommittedBeneficiaryAddress(db, route));
    } catch (error) {
      console.error(`[PVT Mint] Beneficiary registry unavailable for ${benId}:`, error);
      addressCache.set(routeKey, null);
    }
  }
  return addressCache.get(routeKey) === route.human_address ? { kind: 'resolved' } : { kind: 'unresolved' };
}

/** The patch a parked row whose binding/route is invalid (or whose points are malformed) takes. */
export function beneficiaryPendingRecordOnlyPatch(nowMs: number): Record<string, unknown> {
  return {
    mint_status: 'record_only',
    mint_disposition: 'record_only',
    disposition_reason_code: 'unverifiable_evidence_record_only',
    estimatedPVT: 0,
    estimated_pvt_atomic: '0',
    economic_eligibility_projection: null,
    mint_status_updated_at: nowMs,
  };
}

/**
 * The patch a parked row whose route resolved takes: `eligible` at its own record points, or
 * record-only when those points are not a well-formed atomic amount.
 */
export function beneficiaryPendingRestorePatch(recordPoints: unknown, nowMs: number): Record<string, unknown> {
  if (typeof recordPoints !== 'string' || !ATOMIC.test(recordPoints)) {
    return beneficiaryPendingRecordOnlyPatch(nowMs);
  }
  return {
    mint_status: 'eligible',
    mint_disposition: 'eligible',
    disposition_reason_code: 'policy_eligible',
    estimatedPVT: Number(BigInt(recordPoints)) / 1e18,
    estimated_pvt_atomic: recordPoints,
    mint_status_updated_at: nowMs,
  };
}

export interface HeldActRecoveryOptions {
  readonly nowMs: number;
  readonly limit?: number;
  readonly maxPages?: number;
}

export interface BeneficiaryPendingHeldActResult {
  scanned: number;
  restored_eligible: number;
  /** Restored, but the payee still refused: eligible, now held under `payee_<reason>`. */
  restored_awaiting_payee: number;
  record_only: number;
  still_pending: number;
  /** The act moved under the transaction (another pass resolved it); judged again next pass. */
  moved: number;
  errors: number;
}

/** Restore metered acts held `beneficiary_pending` whose committed route now resolves. */
export async function recoverBeneficiaryPendingHeldActs(
  db: Firestore,
  options: HeldActRecoveryOptions,
): Promise<BeneficiaryPendingHeldActResult> {
  const result: BeneficiaryPendingHeldActResult = {
    scanned: 0,
    restored_eligible: 0,
    restored_awaiting_payee: 0,
    record_only: 0,
    still_pending: 0,
    moved: 0,
    errors: 0,
  };
  const { resolveHeldAct } = await import('../meter/held-acts');
  const addressCache = new Map<string, string | null>();
  await walkHeldActs(db, 'beneficiary_pending', {
    cursor: { collection: HELD_ACT_SWEEP_CURSOR_COLLECTION, docId: 'beneficiary_pending' },
    nowMs: options.nowMs,
    limit: options.limit,
    maxPages: options.maxPages,
  }, async (held) => {
    result.scanned += 1;
    try {
      const judgement = await judgeBeneficiaryPendingRow(
        db, held.relayPeId, held.row as unknown as PEHistoryDocument, addressCache,
      );
      if (judgement.kind === 'unresolved') {
        result.still_pending += 1;
        return;
      }
      const patch = judgement.kind === 'invalid'
        ? beneficiaryPendingRecordOnlyPatch(options.nowMs)
        : beneficiaryPendingRestorePatch(held.row.record_points_atomic, options.nowMs);
      const { outcome } = await resolveHeldAct(db, held.relayPeId, patch, {
        nowMs: options.nowMs,
        expect: (before) => before.mint_status === 'beneficiary_pending',
      });
      if (outcome === 'promoted') result.restored_eligible += 1;
      else if (outcome === 'promotion_refused') result.restored_awaiting_payee += 1;
      else if (outcome === 'released_terminal') result.record_only += 1;
      else result.moved += 1;
    } catch (error) {
      console.warn('[HeldActRecovery] beneficiary-pending recovery failed for held act', held.relayPeId, error);
      result.errors += 1;
    }
  });
  return result;
}

export interface PayeeRetryResult {
  scanned: number;
  /** The payee resolved: claims created, hold removed. */
  promoted: number;
  /** The payee still refuses; the act stays held (its reason may have changed). */
  still_refused: number;
  /** Anything else (`missing`, `precondition_failed`, a row that is no longer eligible). */
  other: number;
  errors: number;
  by_reason: Record<string, number>;
}

/** Re-resolve the payee of every metered act held `payee_<reason>` (bounded, resumable). */
export async function retryHeldActPayees(
  db: Firestore,
  options: HeldActRecoveryOptions,
): Promise<PayeeRetryResult> {
  const result: PayeeRetryResult = { scanned: 0, promoted: 0, still_refused: 0, other: 0, errors: 0, by_reason: {} };
  const { resolveHeldAct } = await import('../meter/held-acts');
  for (const reason of PAYEE_HELD_REASONS) {
    await walkHeldActs(db, reason, {
      cursor: { collection: HELD_ACT_SWEEP_CURSOR_COLLECTION, docId: reason },
      nowMs: options.nowMs,
      limit: options.limit,
      maxPages: options.maxPages,
    }, async (held) => {
      result.scanned += 1;
      result.by_reason[reason] = (result.by_reason[reason] ?? 0) + 1;
      try {
        // A no-op patch: the act's row is already eligible; only its payee is re-resolved.
        const { outcome }: { outcome: HeldActOutcome } = await resolveHeldAct(db, held.relayPeId, {}, {
          nowMs: options.nowMs,
        });
        if (outcome === 'promoted') result.promoted += 1;
        else if (outcome === 'promotion_refused') result.still_refused += 1;
        else result.other += 1;
      } catch (error) {
        console.warn('[HeldActRecovery] payee retry failed for held act', held.relayPeId, error);
        result.errors += 1;
      }
    });
  }
  return result;
}
