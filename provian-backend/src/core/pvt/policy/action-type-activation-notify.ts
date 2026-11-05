import { privateRetentionCollection } from '../../provenance/private-retention';
/**
 * Phase 4 — submitter activation notice (item 05).
 *
 * When a previously-unpriced action type goes LIVE (the reconciler marks its
 * ruling live on the served, digest-matched matrix), the agents and humans who
 * already submitted that type learn it now earns. The trigger is the reconciler's
 * live transition — NEVER the classify route, which cannot make a type earn.
 *
 * Channels, matching the two submitter kinds:
 * - humans: sendPushToUser with data.type:'action_type_activated' (per distinct
 * submitter user id, idempotent on (action_type, user) via a marker so a
 * re-run never double-notifies);
 * - agents (network-wide): one HMAC-signed `action_type_activated` webhook per
 * live type to every subscribed agent (idempotent per type via a marker);
 * - agents (per submitter, new-type intake 2026-10-22): an agent that SUBMITTED
 * the type is told directly — an `action_type_activated` event in its own
 * inbox (the pull channel, reached with no webhook endpoint) plus a TARGETED
 * webhook to that agent's own subscription, idempotent on (action_type, agent
 * wallet) via a marker. A submitter is an agent when its `actor_id`
 * resolves to an agent wallet (by `agent_id`, the id agent acts key under, or
 * by wallet doc id); every other submitter is a human and is pushed.
 *
 * Submitters are EVERY actor that submitted the type: the `actor_id` on each of its
 * pending-policy observations (kept until the queue row is purged, so a review that takes
 * longer than the 31-day act-key window still reaches them) united with its 31-day act keys,
 * both paged to the end.
 *
 * The message states the rule: envelopes sealed from effective_at forward earn
 * under the row's weight; envelopes sealed earlier remain records. It carries the
 * effective timestamp and the public /proposals/<type> link.
 *
 * READ-mostly: it reads the pending-policy observations, the 31-day act keys, the agent wallets, the matrix and the activation
 * doc, and writes only idempotency markers, agent inbox events and the ruling's fan-out timestamp.
 * No mint authority.
 */

import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { sendPushToUser } from '../../notifications/pushDispatcher';
import { PROPOSED_ACTION_POLICY_ENTRIES } from './proposed-action-policy';
import {
  MONETARY_STATUS_COLLECTION,
  MONETARY_STATUS_DOCUMENT,
} from './monetary-activation-status';
import {
  listPolicyRulings,
  markPolicyRulingFanoutComplete,
} from './policy-rulings';
import type { WebhookEventType } from '../../agent-bank/types';
import { deterministicInboxEventId, writeInboxEvent } from '../../agent-bank/agent-inbox';
import { METER_ACT_KEYS_COLLECTION } from '../../meter/meter-store';
import { scanQueryUnordered } from '../../provenance/query-pages';
import { PENDING_POLICY_OBSERVATION_COLLECTION } from './pending-policy-queue';

export const ACTIVATION_NOTIFY_MARKER_COLLECTION = 'pvt_action_type_activation_notify_v1';
/** Page size for the submitter scans (observations + act keys); every page is read, never capped. */
export const ACTIVATION_NOTIFY_PE_SCAN_LIMIT = 500;
export const ACTIVATION_NOTIFY_RULING_WORK_LIMIT = 20;

export type ActivationWebhookDispatcher = (
  eventType: WebhookEventType,
  payload: Record<string, unknown>,
) => Promise<void>;

/** Wraps dispatchTargetedEvent(agentBankDeps, …): delivers only to the named agent wallets. */
export type ActivationTargetedWebhookDispatcher = (args: {
  eventType: WebhookEventType;
  recipients: string[];
  entityId?: string | null;
  entityType?: string | null;
  data?: Record<string, unknown>;
}) => Promise<void>;

/** Writes one agent inbox event (defaults to `writeInboxEvent`); injected for tests. */
export type ActivationInboxWriter = typeof writeInboxEvent;

export interface ActivationNotifyDeps {
  now?: number;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  pushToUser?: typeof sendPushToUser;
  /** Wraps dispatchWebhookEvent(agentBankDeps, …); injected for tests. */
  dispatchWebhook?: ActivationWebhookDispatcher;
  /** Wraps dispatchTargetedEvent(agentBankDeps, …) for the per-agent-submitter webhook. */
  dispatchTargetedWebhook?: ActivationTargetedWebhookDispatcher;
  /** The agent inbox writer (default `writeInboxEvent`). */
  writeInbox?: ActivationInboxWriter;
  /** Submitter-scan page size (default {@link ACTIVATION_NOTIFY_PE_SCAN_LIMIT}); never a cap. */
  peScanLimit?: number;
  rulingWorkLimit?: number;
}

function markerId(prefix: string, ...parts: string[]): string {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p, 'utf8').update('\0', 'utf8');
  return `${prefix}__${h.digest('hex').slice(0, 40)}`;
}

function publicUrl(
  actionType: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string {
  const base = (env.PROVIAN_PUBLIC_SITE_URL?.trim() || 'https://provian.ai').replace(/\/+$/, '');
  return `${base}/proposals/${encodeURIComponent(actionType)}`;
}

function activationRule(effectiveAtMs: number | null): string {
  const when = typeof effectiveAtMs === 'number' && effectiveAtMs > 0
    ? new Date(effectiveAtMs).toISOString()
    : 'the go-live timestamp';
  return `Envelopes of this type sealed from ${when} forward earn under the row's weight; `
    + 'envelopes sealed earlier remain records.';
}

function weightBpsFor(actionType: string): number | null {
  const entry = PROPOSED_ACTION_POLICY_ENTRIES.find((e) => e.action_type === actionType);
  if (!entry) return null;
  return entry.policy_override_bps ?? entry.base_action_weight_bps;
}

async function readEffectiveAtMs(db: Firestore): Promise<number | null> {
  try {
    const snap = await db.collection(MONETARY_STATUS_COLLECTION).doc(MONETARY_STATUS_DOCUMENT).get();
    if (!snap.exists) return null;
    const v = (snap.data() as { effective_at_ms?: number }).effective_at_ms;
    return typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
}

export interface FanOutOneResult {
  action_type: string;
  webhook_dispatched: boolean;
  humans_seen: number;
  humans_notified: number;
  agents_seen: number;
  agents_notified: number;
  /**
   * False when some submitter could not be reached this run (its kind could not be read, or its
   * inbox write failed): no marker was written for it, and the caller must leave the ruling's
   * fan-out open so the next scheduled run retries it.
   */
  complete: boolean;
}

/**
 * What a submitter `actor_id` is: an agent (its wallet doc id), a human, or UNKNOWN. Agent acts key
 * under the agent's `agent_id` (device acts and relay-authored acts alike); a caller keyed by
 * the wallet doc id resolves too. A read failure answers `unknown` never a guessed kind: the
 * submitter is skipped (no marker) and the ruling's fan-out stays open so the next run retries.
 */
type SubmitterKind = { readonly kind: 'agent'; readonly walletId: string } | { readonly kind: 'human' } | { readonly kind: 'unknown' };

async function submitterKindOf(db: Firestore, actorId: string): Promise<SubmitterKind> {
  try {
    const byAgentId = await db.collection('agent_wallets').where('agent_id', '==', actorId).limit(1).get();
    if (!byAgentId.empty) return { kind: 'agent', walletId: byAgentId.docs[0].id };
    const byDocId = await db.collection('agent_wallets').doc(actorId).get();
    return byDocId.exists ? { kind: 'agent', walletId: byDocId.id } : { kind: 'human' };
  } catch {
    return { kind: 'unknown' };
  }
}

/**
 * Fan out the activation notice for ONE live action type. Idempotent: the webhook
 * is dispatched once (guarded by a per-type marker) and each distinct human
 * submitter is pushed once (guarded by a per-(type,user) marker).
 */
export async function fanOutOneActionTypeActivation(
  db: Firestore,
  actionType: string,
  facts: { effectiveAtMs: number | null; weightBps: number | null },
  deps: ActivationNotifyDeps = {},
): Promise<FanOutOneResult> {
  const env = deps.env ?? process.env;
  const pushToUser = deps.pushToUser ?? sendPushToUser;
  const scanLimit = deps.peScanLimit ?? ACTIVATION_NOTIFY_PE_SCAN_LIMIT;
  const url = publicUrl(actionType, env);
  const rule = activationRule(facts.effectiveAtMs);

  // 1. webhook — once per type (agents subscribe; the subscription dispatch reaches them).
  let webhookDispatched = false;
  const webhookMarkerRef = db.collection(ACTIVATION_NOTIFY_MARKER_COLLECTION)
    .doc(markerId('wh', actionType));
  const webhookMarker = await webhookMarkerRef.get();
  if (!webhookMarker.exists) {
    if (deps.dispatchWebhook) {
      await deps.dispatchWebhook('action_type_activated', {
        action_type: actionType,
        effective_at_ms: facts.effectiveAtMs,
        weight_bps: facts.weightBps,
        public_url: url,
        rule,
      });
    }
    await webhookMarkerRef.set({ action_type: actionType, dispatched_at: deps.now ?? Date.now() });
    webhookDispatched = true;
  }

  // 2. submitters — EVERY one: the union of the type's pending-policy observations (each carries
  //    its submitter's `actor_id` and never ages out, so a review longer than a month still reaches
  //    everyone who submitted while the type was unpriced) and its 31-day act keys (a submitter
  //    whose act was not observed, e.g. one recorded before observations carried `actor_id`). Both
  //    are paged through to the end (`scanLimit` is the PAGE size, never a cap); a scan failure
  // throws, so the ruling's fan-out stays open and the next run retries.
  const userIds = new Set<string>();
  const collect = async (doc: { data(): unknown }): Promise<void> => {
    const uid = (doc.data() as { actor_id?: unknown } | undefined)?.actor_id;
    if (typeof uid === 'string' && uid) userIds.add(uid);
  };
  await scanQueryUnordered(
    db.collection(PENDING_POLICY_OBSERVATION_COLLECTION).where('action_type', '==', actionType),
    scanLimit,
    collect,
  );
  await scanQueryUnordered(
    privateRetentionCollection(db, METER_ACT_KEYS_COLLECTION).where('action_type', '==', actionType),
    scanLimit,
    collect,
  );
  const humanIds: string[] = [];
  const agentWallets = new Set<string>();
  let complete = true;
  for (const userId of userIds) {
    const submitter = await submitterKindOf(db, userId);
    if (submitter.kind === 'agent') agentWallets.add(submitter.walletId);
    else if (submitter.kind === 'human') humanIds.push(userId);
    else complete = false; // unknown: no marker, no guess; retried next run
  }

  // 3. agent submitters — inbox event + targeted webhook, once per (type, agent wallet).
  const writeInbox = deps.writeInbox ?? writeInboxEvent;
  const notice = {
    action_type: actionType,
    effective_at_ms: facts.effectiveAtMs,
    weight_bps: facts.weightBps,
    public_url: url,
    rule,
  };
  let agentsNotified = 0;
  for (const walletId of agentWallets) {
    const markerRef = db.collection(ACTIVATION_NOTIFY_MARKER_COLLECTION)
      .doc(markerId('ag', actionType, walletId));
    if ((await markerRef.get()).exists) continue;
    const nowMs = deps.now ?? Date.now();
    try {
      await writeInbox(db, {
        recipient: walletId,
        event: 'action_type_activated',
        entityId: actionType,
        entityType: 'action_type',
        data: notice,
        nowMs,
        eventId: deterministicInboxEventId(nowMs, `action_type_activated:${actionType}:${walletId}`),
      });
    } catch {
      // The inbox is the agent's durable channel: no marker, fan-out left open, retried next run.
      complete = false;
      continue;
    }
    // The inbox holds the notice: mark it before the best-effort webhook, so a retry never repeats it.
    await markerRef.set({ action_type: actionType, wallet_id: walletId, notified_at: nowMs });
    agentsNotified += 1;
    if (deps.dispatchTargetedWebhook) {
      try {
        await deps.dispatchTargetedWebhook({
          eventType: 'action_type_activated',
          recipients: [walletId],
          entityId: actionType,
          entityType: 'action_type',
          data: notice,
        });
      } catch {
        // best-effort push channel, like the broadcast; the inbox already carries the notice.
      }
    }
  }

  // 4. human submitters — push, once per (type, user).
  let humansNotified = 0;
  for (const userId of humanIds) {
    const markerRef = db.collection(ACTIVATION_NOTIFY_MARKER_COLLECTION)
      .doc(markerId('hu', actionType, userId));
    const existing = await markerRef.get();
    if (existing.exists) continue;
    try {
      await pushToUser(db, userId, {
        title: 'A Provian action type is now earning',
        body: `${actionType} is live. ${rule}`,
        priority: 'normal',
        data: {
          type: 'action_type_activated',
          action_type: actionType,
          effective_at_ms: String(facts.effectiveAtMs ?? ''),
          url,
        },
      });
      humansNotified += 1;
    } catch {
      // best-effort; the marker below prevents an infinite retry storm, and the
      // agent still has the pull path (GET /v1/pe/earning-proposals/:type).
    }
    await markerRef.set({ action_type: actionType, user_id: userId, notified_at: deps.now ?? Date.now() });
  }

  return {
    action_type: actionType,
    webhook_dispatched: webhookDispatched,
    humans_seen: humanIds.length,
    humans_notified: humansNotified,
    agents_seen: agentWallets.size,
    agents_notified: agentsNotified,
    complete,
  };
}

export interface ActivationNotifyResult {
  examined: number;
  fanned_out: FanOutOneResult[];
}

/**
 * Scan live rulings whose submitter notice has not yet been fanned out and fan
 * each. The durable/retry path behind /v1/internal/scheduler/action-type-activation-notify;
 * also invoked best-effort from the reconcile route for prompt delivery.
 */
export async function runActionTypeActivationNotify(
  db: Firestore,
  deps: ActivationNotifyDeps = {},
): Promise<ActivationNotifyResult> {
  const now = deps.now ?? Date.now();
  const workLimit = deps.rulingWorkLimit ?? ACTIVATION_NOTIFY_RULING_WORK_LIMIT;
  const rulings = await listPolicyRulings(db);
  const pending = rulings
    .filter((r) => r.live_at && !r.activation_fanout_at)
    .slice(0, workLimit);
  if (pending.length === 0) return { examined: 0, fanned_out: [] };

  const effectiveAtMs = await readEffectiveAtMs(db);
  const fanned: FanOutOneResult[] = [];
  for (const ruling of pending) {
    const result = await fanOutOneActionTypeActivation(
      db,
      ruling.action_type,
      { effectiveAtMs, weightBps: weightBpsFor(ruling.action_type) },
      deps,
    );
    fanned.push(result);
    // Leave the fan-out open while any submitter is unreached; per-submitter markers keep the retry
    // from repeating anyone already told.
    if (result.complete) await markPolicyRulingFanoutComplete(db, ruling.action_type, now);
  }
  return { examined: pending.length, fanned_out: fanned };
}
