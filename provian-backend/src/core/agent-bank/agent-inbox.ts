import {INBOX_HEAD_COLLECTION,inboxIdCompare,validInboxHead,recoverDamagedInboxHead} from './inbox-head';
import {isPrivateFirestore} from '../provenance/private-store';
import {PRIVATE_RETENTION_STATE_COLLECTION,PRIVATE_RETENTION_STATE_DOC} from '../provenance/private-retention';
/**
 * Agent inbox (, WS D2) — a per-wallet, cursor-read event feed.
 *
 * The webhook subscription (D1) is a PUSH channel: it only reaches an agent that
 * can host an HTTPS endpoint. A cron-driven / Hermes-class agent that cannot host
 * one still needs to hear its counterparties. The inbox is that PULL channel: the
 * SAME targeted events written durably, per wallet, and read back by cursor with
 * the agent's own API-key auth — so an interaction reaches the second party even
 * with no webhook, and WITHOUT polling the entity read.
 *
 * STORAGE. One row per (recipient, event) under the recipient's own subcollection
 * `agent_wallets/{wallet_id}/inbox_v1/{eventId}`. The event id is time-sortable
 * (`<zero-padded-ms>_<rand>`), so ordering by document id is chronological and the
 * cursor is simply the last id returned — no composite index, naturally per-wallet
 * scoped, and a viewer can only ever read under their own authenticated wallet id.
 */

import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';

export const AGENT_INBOX_SUBCOLLECTION = 'inbox_v1';

/** Default and hard cap on how many inbox events one read returns. */
export const INBOX_DEFAULT_LIMIT = 50;
export const INBOX_MAX_LIMIT = 200;

/** A single inbox event as stored and returned. */
export interface AgentInboxEvent {
  /** The chronological document id; also the pagination cursor. */
  event_id: string;
  event: string;
  /** The interaction entity id (job_id / escrow_id / promise_id / …), when known. */
  entity_id: string | null;
  /** The entity kind (job / escrow / promise / pool / bond / court / settlement …). */
  entity_type: string | null;
  /** The OTHER party in the interaction, from this recipient's point of view. */
  counterparty_wallet: string | null;
  /** The wallet that acted (poster, depositor, funder, …). */
  actor_wallet_id: string | null;
  amount: number | null;
  amount_unit: string | null;
  /** Any extra event-specific fields the emitter attached. */
  data: Record<string, unknown>;
  created_at: number;
}

export interface WriteInboxEventInput {
  recipient: string;
  event: string;
  entityId?: string;
  entityType?: string;
  counterpartyWallet?: string | null;
  actorWalletId?: string | null;
  amount?: number | null;
  amountUnit?: string | null;
  data?: Record<string, unknown>;
  nowMs?: number;
  /**
   * Deterministic event id (idempotency). When supplied, a retried write
   * preserves the original doc instead of appending a duplicate. Build it with
   * {@link deterministicInboxEventId} so it stays chronological.
   */
  eventId?: string;
}

/** Build the chronological, unique (random) document id for an inbox row. */
function inboxEventId(nowMs: number): string {
  // 15 digits holds ms timestamps well past the year 33000, so lexical order over
  // the zero-padded prefix is chronological; the random suffix breaks same-ms ties.
  return `${String(nowMs).padStart(15, '0')}_${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * A chronological BUT deterministic inbox event id: the same (occurredAtMs, key)
 * always yields the same id, so a retried outbox drain preserves the first event rather than
 * duplicates. `key` should be unique per (outbox row, recipient).
 */
export function deterministicInboxEventId(occurredAtMs: number, key: string): string {
  const suffix = crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
  return `${String(occurredAtMs).padStart(15, '0')}_${suffix}`;
}

/**
 * Durably append one event to a recipient's inbox. Best-effort by contract (the
 * caller wraps delivery so a single bad write never fails the drain); returns the
 * event id it wrote.
 */
export async function writeInboxEvent(db: Firestore, input: WriteInboxEventInput): Promise<string> {
  const now = input.nowMs ?? Date.now();
  const eventId = input.eventId ?? inboxEventId(now);
  const row: AgentInboxEvent = {
    event_id: eventId,
    event: input.event,
    entity_id: input.entityId ?? null,
    entity_type: input.entityType ?? null,
    counterparty_wallet: input.counterpartyWallet ?? null,
    actor_wallet_id: input.actorWalletId ?? null,
    amount: input.amount ?? null,
    amount_unit: input.amountUnit ?? null,
    data: input.data ?? {},
    created_at: now,
  };
  const eventRef=db.collection('agent_wallets').doc(input.recipient).collection(AGENT_INBOX_SUBCOLLECTION).doc(eventId);
  const headRef=db.collection(INBOX_HEAD_COLLECTION).doc(input.recipient);
  let headReadFailed = false;
  const append=()=>db.runTransaction(async tx=>{
    headReadFailed = false;
    // Event identities are append-only. Reading also refuses damaged authoritative ciphertext.
    if ((await tx.get(eventRef)).exists) return;
    let head: FirebaseFirestore.DocumentData | undefined;
    try { head=(await tx.get(headRef)).data(); }
    catch (error) { headReadFailed = true; throw error; }
    // Backdated retries must never move the high watermark backwards. Corrupt heads remain
    // uncertified until rebuilt, so reads retain their original complete query path.
    const last=validInboxHead(head)&&inboxIdCompare(head.last_event_id,eventId)>0?head.last_event_id:eventId;
    tx.set(eventRef,row);
    tx.set(headRef,{schema:head&&!validInboxHead(head)?'provian.inbox-head.invalid':'provian.inbox-head.v1',last_event_id:last});
  });
  try{await append();}
  catch(error){
    if(!isPrivateFirestore(db) || !headReadFailed)throw error;
    // Optional head ciphertext/alias corruption must not block the original event write.
    // Recovery marks only that derived head invalid, then retries the same event identity.
    await recoverDamagedInboxHead(db,input.recipient,eventId);
    await append();
  }
  return eventId;
}

export interface ReadInboxResult {
  events: AgentInboxEvent[];
  /** Pass back as `cursor` to continue after the last event; null when caught up. */
  next_cursor: string | null;
}

/**
 * Read a wallet's inbox in chronological order after `cursor`. Cursor is the last
 * `event_id` the caller saw; omit it for the oldest unread page. `next_cursor` is
 * null when the page was not full (caller is caught up).
 */
export async function readInbox(
  db: Firestore,
  walletId: string,
  opts: { cursor?: string | null; limit?: number } = {},
): Promise<ReadInboxResult> {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? INBOX_DEFAULT_LIMIT)), INBOX_MAX_LIMIT);
  const base = db.collection('agent_wallets').doc(walletId).collection(AGENT_INBOX_SUBCOLLECTION);
  try {
  if(opts.cursor) {
    const ready=(await db.collection(PRIVATE_RETENTION_STATE_COLLECTION).doc(PRIVATE_RETENTION_STATE_DOC).get()).data();
    if(ready?.inbox_heads_version===1) {
      const head=(await db.collection(INBOX_HEAD_COLLECTION).doc(walletId).get()).data();
      if(validInboxHead(head)&&inboxIdCompare(opts.cursor,head.last_event_id)>=0) {
        // Also reject an orphan head after a partial restore. A normal read linearizes here;
        // later appends atomically advance the head and appear on the next poll.
        const last=await base.doc(head.last_event_id).get();
        if(last.exists&&last.get('event_id')===head.last_event_id)return {events:[],next_cursor:null};
      }
    }
  }
  } catch { /* A missing/corrupt derived index never replaces the authoritative inbox query. */ }
  // Order by the (chronological) document id. startAfter takes the raw id string.
  let query = base.orderBy('__name__').limit(limit);
  if (opts.cursor) {
    query = base.orderBy('__name__').startAfter(opts.cursor).limit(limit);
  }
  const snap = await query.get();
  const events = snap.docs.map((doc) => doc.data() as AgentInboxEvent);
  const next_cursor = events.length === limit ? events[events.length - 1].event_id : null;
  return { events, next_cursor };
}
