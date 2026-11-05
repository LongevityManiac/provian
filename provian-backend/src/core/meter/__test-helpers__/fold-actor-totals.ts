/**
 * Test helper: build an actor's `actor_meter_totals_v1` document by folding acts through the
 * PRODUCTION path the meter commit runs at seal (`actFactsOf` → `actorActIncrementOf` →
 * `applyActorActIncrement`), so a suite never asserts a property of a hand-built totals doc.
 */

import { actFactsOf } from '../meter-act-key';
import {
  actorActIncrementOf,
  applyActorActIncrement,
  coerceActorMeterTotals,
  type ActorMeterTotalsDoc,
} from '../actor-meter-totals';

export interface FoldedAct {
  readonly actionType: string;
  readonly metadata?: Record<string, unknown>;
  readonly timestamp: number;
  readonly attestationDepth?: string;
  readonly corroborationStatus?: string;
  readonly dispositionReasonCode?: string | null;
  readonly actorAddress?: string | null;
  /** Defaults to true (a watcher / transfer/record act); false = a device act. */
  readonly relayAuthored?: boolean;
  readonly held?: boolean;
}

export function foldActorTotals(
  actorId: string,
  acts: readonly FoldedAct[],
  base: ActorMeterTotalsDoc = coerceActorMeterTotals(actorId, null),
): ActorMeterTotalsDoc {
  let totals = base;
  for (const act of acts) {
    const facts = actFactsOf(
      { action_type: act.actionType, timestamp: act.timestamp, pricing: { metadata: act.metadata ?? {}, actor_address: act.actorAddress ?? null } },
      { actorId, relayAuthored: act.relayAuthored ?? true },
    );
    const row: Record<string, unknown> = {
      userId: actorId,
      actionType: act.actionType,
      timestamp: act.timestamp,
      attestationDepth: act.attestationDepth ?? 'software',
      corroboration_status: act.corroborationStatus ?? 'none',
      disposition_reason_code: act.dispositionReasonCode ?? null,
    };
    const inc = actorActIncrementOf(row, facts, act.held === true);
    if (inc === null) throw new Error('foldActorTotals: fixture row produced no increment');
    totals = applyActorActIncrement(totals, inc, act.timestamp);
  }
  return totals;
}
