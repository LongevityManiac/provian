/**
 * Agent PE activity — the ONE live-count source, on the PE meter.
 *
 * An agent's PE count is shown on several surfaces (the AgentHub card, the AgentDetail screen,
 * the Earn hub, the directory, bonds, invites, the Commons profile). They all read it here so
 * every surface shows the SAME number (never a redeclared count with drifted semantics).
 *
 * PE METER : the relay no longer stores PEs, so nothing here reads a
 * per-PE collection or walks an agent's history:
 * - the count is the agent's running total (`actor_stats_v1.pe_count`, applied once per act);
 * - the recent-activity entries are the agent's live act keys (≤31 days), newest first, behind
 * the caller's limit — priced rows (type, time, disposition), never content;
 * - the beneficiary view's count is the human's running total of this agent's acts that named
 * them as beneficiary (`actor_meter_totals_v1`), and its pending projection is the SAME
 * eligible-only settlement projection the dashboard uses, folded over the
 * agent's live act keys (unminted earnings live there: standard earnings settle on a schedule Provian sets, currently every 30 days, Genesis daily, or on demand
 * through the $1 payout).
 * There is no `hidden` flag any more: hiding a PE is a display choice on the owner's device.
 */

import type { Firestore } from 'firebase-admin/firestore';
import type { PEHistoryDocument } from '../../pe-history';
import { readActorMeterTotals } from '../meter/actor-meter-totals';
import {
  listRecentActKeys,
  readActorPeCount,
  streamLiveActKeys,
} from '../meter/owner-reads';
import {
  addSettlementInput,
  applyGlobalMintRate,
  formatPvtAtomic,
  projectCurrentSettlementInputAtomic,
  projectCurrentSettlementPEAtomic,
  ZERO_SETTLEMENT_INPUT,
  type CurrentSettlementProjectionContext,
  type SettlementInputAtomic,
} from '../pvt/policy/economic-projection';

export interface AgentPEEntry {
  peId: string | null;
  actionType: string | null;
  timestamp: number | null;
  mintStatus: string | null;
  /** Always null: the relay keeps no PE content (the description lives on the owner's device). */
  description: string | null;
  /**
   * The linked human's projected BENEFICIARY settlement PVT for THIS PE (formatted display
   * string), or null. Present only when the caller passes a `beneficiaryUserId` + a live
   * projection context AND this row names that human as its beneficiary. Eligible-only and
   * PENDING; NEVER a record-points value.
   */
  beneficiaryProjectionPvt?: string | null;
}

/**
 * The linked human's beneficiary earnings from ONE agent. DISPLAY/READ-ONLY: every number is the
 * eligible-only settlement projection the dashboard already serves, derived from
 * the per-PE split SEALED at record time through the ONE projection path in
 * `economic-projection.ts` never a re-derived split, never a record-points sum.
 */
export interface AgentBeneficiarySummary {
  /** The agent's acts that named this human as beneficiary (running total). */
  peCount: number;
  /**
   * Sum of the human's PENDING (eligible, not-yet-minted) beneficiary projection across the
   * agent's live acts, formatted. Null when no live settlement factor is available (fail-closed).
   * Rate applied ONCE to the summed rate-free inputs, never per row.
   */
  projectedPendingPvt: string | null;
  projectedPendingPvtAtomic: string | null;
}

export interface AgentPEActivity {
  peCount: number;
  entries: AgentPEEntry[];
  /** Present only when the caller asked for the linked-human beneficiary view. */
  beneficiary?: AgentBeneficiarySummary;
}

/** Page size for the beneficiary projection fold over the agent's live act keys. */
const LIVE_FOLD_PAGE = 500;

export async function fetchAgentPEActivity(
  db: Firestore,
  agentId: string,
  limit: number,
  opts?: {
    /** The linked human's user id — the beneficiary key on the agent's rows. */
    readonly beneficiaryUserId?: string | null;
    /** Live PVT9-native settlement factors; `null` = fail-closed → projection numbers null. */
    readonly projectionContext?: CurrentSettlementProjectionContext | null;
  },
): Promise<AgentPEActivity> {
  const beneficiaryUserId = opts?.beneficiaryUserId ?? null;
  const projectionContext = opts?.projectionContext ?? null;
  // Defensive: only price rows that name THIS human as beneficiary. A row beneficiaried to a
  // PRIOR human (link changed) must never count toward the current human's earnings.
  const isForThisHuman = (row: Record<string, unknown>): boolean =>
    beneficiaryUserId !== null && row.beneficiary_wallet_id === beneficiaryUserId;

  const peCount = await readActorPeCount(db, agentId);
  // Act bodies and recent history are read from the owner's permanent store.
  const entries: AgentPEEntry[] = [];

  let beneficiary: AgentBeneficiarySummary | undefined;
  if (beneficiaryUserId !== null) {
    const totals = await readActorMeterTotals(db, beneficiaryUserId);
    let projectedPendingPvtAtomic: string | null = null;
    if (projectionContext !== null) {
      // Sum the RATE-FREE inputs and apply the mint rate ONCE (the rounding rule in
      // economic-projection.ts) — never per row.
      let inputSum: SettlementInputAtomic = ZERO_SETTLEMENT_INPUT;
      await streamLiveActKeys(db, 'actor_id', agentId, 0, LIVE_FOLD_PAGE, (key) => {
        const row = key.row ?? {};
        if (!isForThisHuman(row)) return;
        const input = projectCurrentSettlementInputAtomic(
          row as unknown as PEHistoryDocument, 'beneficiary', projectionContext.projectedAtMs,
        );
        if (input !== null) inputSum = addSettlementInput(inputSum, input);
      });
      const batches = await db.collection('meter_batches_v1').where('actor_id', '==', agentId)
        .where('per_batch_pricing', '==', true).where('economic_settled', '==', false).get();
      for (const batch of batches.docs) {
        for (const total of (batch.data().economic_totals ?? []) as import('../meter/batch-economics').BatchEconomicTotal[]) {
          if (total.role === 'beneficiary' && total.identity === beneficiaryUserId) {
            inputSum = addSettlementInput(inputSum, { rated: BigInt(total.rated), fixed: BigInt(total.fixed) });
          }
        }
      }
      projectedPendingPvtAtomic = applyGlobalMintRate(inputSum, projectionContext.globalMintRate).toString(10);
    }
    beneficiary = {
      peCount: totals.beneficiary_acts_by_agent[agentId] ?? 0,
      projectedPendingPvt:
        projectedPendingPvtAtomic === null ? null : formatPvtAtomic(projectedPendingPvtAtomic, 1),
      projectedPendingPvtAtomic,
    };
  }

  return { peCount, entries, ...(beneficiary ? { beneficiary } : {}) };
}

/**
 * The agent's live PE count: its running total (`actor_stats_v1.pe_count`), one point read.
 * Name kept for its many callers (sessions list, directory, bonds, invites, Commons profiles).
 */
export async function countVisibleAgentPEs(db: Firestore, agentId: string): Promise<number> {
  return readActorPeCount(db, agentId);
}
