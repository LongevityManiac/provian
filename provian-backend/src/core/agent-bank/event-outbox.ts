/**
 * Durable agent-bank event outbox (audit 2026-08-05, finding 14).
 *
 * The route handlers used to fire `processAgentBankEvent(...)` un-awaited AFTER
 * `res.json(...)` — badge reconciliation, badge-qualification PEs, and subscriber
 * webhook delivery all ran in a promise that Cloud Run drops the moment it freezes
 * the instance post-response. On a busy instance that silently loses badges and
 * webhooks.
 *
 * This module makes that work DURABLE without Cloud Tasks (the backend has none):
 * the route AWAITS a single Firestore write recording the event, BEFORE responding,
 * and a scheduler drains the outbox and runs `processAgentBankEvent` for each row.
 * If the instance dies right after responding, the row is still there and the next
 * scheduler tick delivers it.
 *
 * IDEMPOTENCY. Each occurrence is its own auto-id row (no false dedupe — two
 * contributions to the same pool are two events). Double-processing a row is SAFE:
 * badge awards go through the single-winner `agent_badge_award_outbox_v1`
 * (exactly-once), and webhook delivery is at-least-once by contract. The
 * single-winner claim below still prevents two concurrent scheduler ticks from
 * racing the same row, and stale 'processing' rows (a crash mid-process) are
 * reclaimed so nothing is stranded.
 */

import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import type { AgentBankDeps } from './types';
import { type AmountUnit, processAgentBankEvent } from './event-listener';

export const AGENT_BANK_EVENT_OUTBOX_COLLECTION = 'agent_bank_event_outbox_v1';

/** Attempts before a row is parked 'failed' for human inspection. */
export const MAX_EVENT_ATTEMPTS = 5;
/** A 'processing' row older than this is treated as crash-abandoned and reclaimed. */
export const STALE_PROCESSING_MS = 5 * 60 * 1000;

export type AgentBankEventStatus = 'pending' | 'processing' | 'done' | 'failed';

/**
 * TARGETING + CONTEXT. The pre- outbox row carried only the actor
 * wallet_id, so by the time an event reached delivery it named the actor, not the
 * counterparty, and had no entity id — which is why delivery could only broadcast
 * by event type. These fields carry the interaction's parties and identity end to
 * end so delivery can be TARGETED to exactly the parties and the inbox row can name
 * the entity + counterparty. All optional and back-compatible: an event without
 * `recipients` notifies the actor (`wallet_id`) alone.
 */
export interface EventDeliveryContext {
  /** Wallet ids to notify (the parties of the interaction). Defaults to [actor]. */
  recipients?: string[];
  /** The interaction entity id: job_id / escrow_id / promise_id / pool_id / bond_id / claim_id / batch/tx. */
  entityId?: string;
  /** The entity kind: 'job' | 'escrow' | 'promise' | 'pool' | 'bond' | 'court' | 'badge' | 'settlement'. */
  entityType?: string;
  /** recipientWalletId -> that recipient's counterparty wallet id (the OTHER party). */
  counterparties?: Record<string, string>;
  /** Extra event fields carried to the webhook body + inbox row (currency, tx_hash, net amounts, …). */
  data?: Record<string, unknown>;
  /**
   * When true, delivery-only: skip the actor badge/pe_count reconciliation. Used
   * by system-originated notices (settlement) that must NOT bump a recipient's
   * pe_count or economic-activity counters.
   */
  notifyOnly?: boolean;
}

/**
 * What the drain hands the processor: the enqueued context PLUS an idempotency
 * key. `eventKey` (the outbox row id) + `occurredAtMs` (the row's created_at)
 * make the per-recipient inbox write deterministic, so a retried drain row
 * overwrites the same inbox doc instead of appending a duplicate.
 */
export interface ProcessedEventContext extends EventDeliveryContext {
  eventKey?: string;
  occurredAtMs?: number;
}

export interface AgentBankEventRecord {
  wallet_id: string;
  event_type: string;
  transaction_amount: number;
  amount_unit: AmountUnit;
  status: AgentBankEventStatus;
  attempts: number;
  created_at: number;
  updated_at: number;
  claimed_at?: number;
  last_error?: string;
  // Targeting + context. Optional; absent on legacy rows.
  recipients?: string[];
  entity_id?: string;
  entity_type?: string;
  counterparties?: Record<string, string>;
  data?: Record<string, unknown>;
  notify_only?: boolean;
}

export interface EnqueueAgentBankEventInput extends EventDeliveryContext {
  walletId: string;
  eventType: string;
  transactionAmount: number;
  amountUnit?: AmountUnit;
}

/**
 * Targeting for a two-party interaction (depositor↔recipient, poster↔applicant,
 * borrower↔lender, both handshake parties): notify both, and give each recipient
 * the OTHER as its counterparty. One source so every emitter builds the same shape.
 */
export function twoPartyTargeting(
  partyA: string,
  partyB: string,
): { recipients: string[]; counterparties: Record<string, string> } {
  return {
    recipients: [partyA, partyB],
    counterparties: { [partyA]: partyB, [partyB]: partyA },
  };
}

/**
 * Durably record an agent-bank event. AWAIT this before responding — it is the
 * whole point (a dropped promise after res.json is what we are replacing). One
 * small Firestore write; returns the outbox row id.
 */
export async function enqueueAgentBankEvent(
  db: Firestore,
  input: EnqueueAgentBankEventInput,
): Promise<string> {
  const now = Date.now();
  // Explicit id (not `.doc()` auto-id): deterministic per occurrence and works
  // identically against the real client and the test fake.
  const ref = db.collection(AGENT_BANK_EVENT_OUTBOX_COLLECTION).doc(`abe_${crypto.randomUUID()}`);
  const record: AgentBankEventRecord = {
    wallet_id: input.walletId,
    event_type: input.eventType,
    transaction_amount: input.transactionAmount,
    amount_unit: input.amountUnit ?? 'usdc_whole',
    status: 'pending',
    attempts: 0,
    created_at: now,
    updated_at: now,
    // Persist targeting + context only when supplied (undefined fields are
    // dropped so a legacy-shaped row is byte-for-byte what it always was).
    ...(input.recipients ? { recipients: input.recipients } : {}),
    ...(input.entityId ? { entity_id: input.entityId } : {}),
    ...(input.entityType ? { entity_type: input.entityType } : {}),
    ...(input.counterparties ? { counterparties: input.counterparties } : {}),
    ...(input.data ? { data: input.data } : {}),
    ...(input.notifyOnly ? { notify_only: true } : {}),
  };
  await ref.set(record);
  return ref.id;
}

export interface DrainResult {
  processed: number;
  failed: number;
  reclaimed: number;
  skipped: number;
}

/**
 * Reclaim rows stuck in 'processing' past STALE_PROCESSING_MS (an instance that
 * claimed a row then crashed before finishing). Single-field query on status, so
 * no composite index is needed; the staleness cut is applied in memory.
 */
async function reclaimStaleProcessing(db: Firestore, limit: number): Promise<number> {
  const cutoff = Date.now() - STALE_PROCESSING_MS;
  const snap = await db
    .collection(AGENT_BANK_EVENT_OUTBOX_COLLECTION)
    .where('status', '==', 'processing')
    .limit(limit)
    .get();
  let reclaimed = 0;
  for (const doc of snap.docs) {
    const data = doc.data() as AgentBankEventRecord;
    if ((data.claimed_at ?? data.updated_at ?? 0) > cutoff) continue;
    const ok = await db.runTransaction(async (txn) => {
      const cur = await txn.get(doc.ref);
      const curData = cur.data() as AgentBankEventRecord | undefined;
      if (!cur.exists || !curData || curData.status !== 'processing') return false;
      if ((curData.claimed_at ?? curData.updated_at ?? 0) > cutoff) return false;
      txn.update(doc.ref, { status: 'pending', updated_at: Date.now() });
      return true;
    });
    if (ok) reclaimed++;
  }
  return reclaimed;
}

/** The event-processing step. Injectable ONLY so tests can drive the failure/
 * retry branch ("unreachable branch"); production always uses the real
 * `processAgentBankEvent`. */
export type EventProcessor = (
  deps: AgentBankDeps,
  walletId: string,
  eventType: string,
  transactionAmount: number,
  amountUnit: AmountUnit,
  context?: ProcessedEventContext,
) => Promise<void>;

/**
 * Drain up to `limit` pending events, running `processAgentBankEvent` for each.
 * Single-winner transactional claim (pending → processing) so two concurrent
 * ticks never process the same row. Invoked by the scheduler endpoint.
 */
export async function drainAgentBankEventOutbox(
  deps: AgentBankDeps,
  limit = 50,
  process: EventProcessor = processAgentBankEvent,
): Promise<DrainResult> {
  const db = deps.db;
  const reclaimed = await reclaimStaleProcessing(db, limit);

  const snap = await db
    .collection(AGENT_BANK_EVENT_OUTBOX_COLLECTION)
    .where('status', '==', 'pending')
    .limit(limit)
    .get();

  let processed = 0;
  let failed = 0;
  let skipped = 0;

  for (const doc of snap.docs) {
    // Claim: flip pending → processing atomically, so a concurrent tick that read
    // the same 'pending' snapshot loses the race and skips it.
    const claimed = await db.runTransaction(async (txn) => {
      const cur = await txn.get(doc.ref);
      const data = cur.data() as AgentBankEventRecord | undefined;
      if (!cur.exists || !data || data.status !== 'pending') return null;
      const now = Date.now();
      txn.update(doc.ref, { status: 'processing', attempts: data.attempts + 1, claimed_at: now, updated_at: now });
      return { ...data, attempts: data.attempts + 1 };
    });
    if (!claimed) {
      skipped++;
      continue;
    }

    try {
      await process(
        deps,
        claimed.wallet_id,
        claimed.event_type,
        claimed.transaction_amount,
        claimed.amount_unit,
        {
          recipients: claimed.recipients,
          entityId: claimed.entity_id,
          entityType: claimed.entity_type,
          counterparties: claimed.counterparties,
          data: claimed.data,
          notifyOnly: claimed.notify_only,
          eventKey: doc.ref.id,
          occurredAtMs: claimed.created_at,
        },
      );
      await doc.ref.update({ status: 'done', updated_at: Date.now() });
      processed++;
    } catch (err) {
      const terminal = claimed.attempts >= MAX_EVENT_ATTEMPTS;
      await doc.ref
        .update({
          status: terminal ? 'failed' : 'pending',
          last_error: err instanceof Error ? err.message : String(err),
          updated_at: Date.now(),
        })
        .catch((updateErr: unknown) =>
          console.error('[AgentBankOutbox] failed to record drain error:', updateErr),
        );
      failed++;
    }
  }

  return { processed, failed, reclaimed, skipped };
}
