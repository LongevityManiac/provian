/**
 * PE METER — output trust and cross-witness keys, retained for the corroboration window.
 *
 * It holds the act's PRICED ROW (the exact object `buildPEHistoryRow` produces — the same row the
 * pre-meter relay stored forever in `pe_history`, minus every free-text field), the payee legs
 * frozen at seal time, and the identity fields the act's own claim ids derive from. It exists so
 * that, inside the ruled 30-day window:
 * - a retried batch re-derives the act's outcome instead of pricing it twice (idempotency),
 * - a duplicate witness can verify the slot's owner (mint-once cross-check),
 * - a higher-base witness can take a commit/completion over,
 * - a corroboration can be paid as a top-up.
 * It is never a readable PE: it carries no description, no content, and no envelope.
 */

import type { PEHistoryDocument } from '../../pe-history';
import type { SealedEnvelopeIdentity } from '../pvt/wp-ev/claim-id';
import { financialFactOf, type FinancialFact } from './actor-meter-totals';
import type { MeterActLeg } from './meter-claims';
import type { MeterActSideInputs } from './meter-seal';

export interface MeterActKeyDoc {
  readonly schema: 'provian.meter-act-key.v1';
  /** New minimal keys remain while their claims are unpaid; legacy TTLs are untouched. */
  readonly pending_retention_v1?: true;
  readonly relay_pe_id: string;
  /** The device's own pe_id (display/correlation only; never a relay key). */
  readonly client_pe_id: string;
  readonly pe_hash: string;
  readonly prev_hash: string;
  readonly device_id: string;
  readonly batch_hash: string;
  readonly actor_id: string;
  readonly timestamp: number;
  readonly action_type: string;
  readonly row: Record<string, unknown>;
  /** Frozen payee legs (eligible acts only), null otherwise. */
  readonly legs: readonly MeterActLeg[] | null;
  /**
   * Which pending-claim unit the act's earnings went into: `batch`, `window` (a takeover-capable
   * witness, folded per batch since ), `act` (a pre-fold takeover-capable witness or a
   * promoted held act), or `none`.
   */
  readonly unit: 'batch' | 'act' | 'window' | 'none';
  readonly held_reason: string | null;
  /** Per-act inputs the batch commit applies (stats bump, delegation, corroboration target). */
  readonly side: MeterActSideInputs;
  readonly created_at_ms: number;
  /**
   * The act's identifier facts — who, which wallet, which counterparty, which job or promise —
   * that a later verifier binds to (the completion verifier's delivery/confirmation/fulfilment
   * checks). Identifiers only, never content. Absent on keys sealed before it existed.
   */
  readonly facts?: MeterActFacts | null;
  /**
   * The human the act's row names as beneficiary (`row.beneficiary_wallet_id`), lifted to the top
   * level so the beneficiary's live projection tail is an indexed query (`row` is not indexed).
   * Set once at seal; the row field never changes after. Absent on keys sealed before it existed.
   */
  readonly beneficiary_id?: string | null;
  /** Null only for a Genesis grant until it mints (see `meter-seal.ts`). */
  readonly expire_at: FirebaseFirestore.Timestamp | null;
}

export interface MeterActFacts {
  readonly action_type: string;
  readonly wallet_id: string | null;
  readonly user_id: string;
  readonly timestamp: number;
  readonly counterparty_address: string | null;
  readonly actor_address: string | null;
  readonly job_id: string | null;
  readonly promise_id: string | null;
  /**
   * The act's chain-verified financial figures (kind, USD amount, currency, executing address),
   * present only on a RELAY-authored financial act (`actor-meter-totals.ts`). Figures, not content.
   */
  readonly financial?: FinancialFact;
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The facts of one act, from its act record and what the lane knows about its submitter. */
export function actFactsOf(
  act: { readonly action_type: string; readonly timestamp: number; readonly pricing: Readonly<Record<string, unknown>> },
  lane: {
    readonly actorId: string;
    readonly walletId?: string | null;
    readonly counterpartyAddress?: string | null;
    readonly actorAddress?: string | null;
    /**
     * True ONLY for an act the relay itself authored (a watcher, `transfer/record`): its metadata
     * flags (`chain_verified`, `activity_mapped`, `verified`) were stamped by the relay after an
     * on-chain check. A device's metadata is never trusted for financial facts.
     */
    readonly relayAuthored?: boolean;
  },
): MeterActFacts {
  const metadata = act.pricing.metadata;
  const meta = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  const actorAddress = strOrNull(act.pricing.actor_address) ?? strOrNull(lane.actorAddress);
  const financial = lane.relayAuthored === true ? financialFactOf(act.action_type, meta, actorAddress) : null;
  return {
    action_type: act.action_type,
    wallet_id: strOrNull(act.pricing.wallet_id) ?? strOrNull(lane.walletId),
    user_id: lane.actorId,
    timestamp: act.timestamp,
    counterparty_address: strOrNull(act.pricing.counterparty_address) ?? strOrNull(lane.counterpartyAddress),
    actor_address: actorAddress,
    job_id: strOrNull(meta.job_id),
    promise_id: strOrNull(act.pricing.promise_id),
    ...(financial !== null ? { financial } : {}),
  };
}

/** Free-text fields never kept by the relay, even for 31 days. */
const FREE_TEXT_ROW_FIELDS = ['inputSummary', 'outputSummary'] as const;

export function slimActRow(doc: PEHistoryDocument): Record<string, unknown> {
  const row: Record<string, unknown> = { ...(doc as unknown as Record<string, unknown>) };
  for (const field of FREE_TEXT_ROW_FIELDS) row[field] = null;
  return row;
}

/** The output trust row retains the sealed price and frozen payees, never the act body. */
export function outputTrustKey(key: MeterActKeyDoc): MeterActKeyDoc {
  const fields = ['peId', 'peHash', 'userId', 'actionType', 'category', 'timestamp', 'attestationDepth',
    'mint_status', 'mint_disposition', 'record_points_atomic', 'economic_snapshot', 'economic_snapshot_hash',
    'economic_aggregate_applied', 'economic_eligibility_projection', 'economic_eligibility_projection_hash',
    'beneficiary_wallet_id', 'beneficiary_agent_id', 'corroboration_status', 'corroboration_received_at',
    'corroboration_source', 'replication_pack', 'witness_class', 'output_digests'];
  return { ...key, facts: null, row: Object.fromEntries(fields.filter(f => f in key.row).map(f => [f, key.row[f]])),
    side: { statsBump: null, delegation: null, corroborateIncumbentPeId: null, outputDigestsIndexed: false, effect: null } };
}

/** The identity an act's own claim ids derive from (act unit + top-ups). */
export function actKeyIdentity(key: Pick<MeterActKeyDoc, 'relay_pe_id' | 'prev_hash' | 'pe_hash' | 'timestamp' | 'action_type' | 'actor_id'>): SealedEnvelopeIdentity {
  return {
    id: key.relay_pe_id,
    prev_hash: key.prev_hash,
    hash: key.pe_hash,
    timestamp: key.timestamp,
    action_type: key.action_type,
    user_id: key.actor_id,
  };
}
