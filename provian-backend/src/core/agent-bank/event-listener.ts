/**
 * Agent Bank - Contract Event Listener
 *
 * Listens to EscrowCreated, EscrowFunded, EscrowReleased, etc. events
 * from all three Agent Bank contracts via ethers.js on Base.
 *
 * On each event:
 *   1. Update Firestore document
 *   2. Generate PE(s) for relevant parties
 *   3. Update agent wallet stats
 *   4. Evaluate badges
 *   5. Send webhook callbacks if configured
 *
 * NOTE: Event listening requires an active WebSocket/polling provider.
 * In Cloud Run (stateless), we use polling via scheduled Firestore queries
 * and on-chain event verification in the API layer (verifyFunding, etc.)
 * rather than persistent WebSocket subscriptions.
 *
 * This module provides the core event processing logic that the API routes
 * and scheduler invoke after detecting state changes.
 */

import type { AgentBankDeps, WebhookEventType } from './types';
import type { AgentWalletDocument } from '../agent-wallet/types';
import { evaluateBadges } from '../agent-wallet/badges';
import { countVisibleAgentPEs } from '../agent-wallet/agent-pe-activity';
import {
  awardBadgeFromOutbox,
  badgeAwardOutboxRef,
  badgeIds,
  createPendingBadgeAward,
  reconcileBadgeAwards,
} from '../agent-wallet/badge-provenance';
import { dispatchTargetedEvent } from './webhooks';
import { deterministicInboxEventId, writeInboxEvent } from './agent-inbox';
import type { ProcessedEventContext } from './event-outbox';
import { generatePE } from './pe-utils';

/**
 * Unit discriminator for the `amount` number emitted on webhook payloads.
 *
 *   'usdc_whole' - whole dollars (the historical default; 1 === $1).
 *   'pvt_whole'  - whole PVT units (1 === 1 PVT, i.e. atomic / 1e18).
 *
 * PVT atomic units (18 decimals) can exceed Number.MAX_SAFE_INTEGER once
 * balances get non-trivial, so the webhook carries whole PVT as a number
 * and leaves atomic-unit precision to the Firestore record and any
 * BigInt-as-string API responses. Consumers that need atomic precision
 * should read the primitive document directly, not the webhook.
 *
 * Default when unspecified is 'usdc_whole' for backward compatibility
 * with legacy consumers that predate PVT-principal flows.
 */
export type AmountUnit = 'usdc_whole' | 'pvt_whole';

/**
 * Process a contract event and update wallet stats + evaluate badges.
 *
 * Called by API routes after verifying on-chain events (funding, settlement, etc.)
 * and by the scheduler for automated transitions (auto-release, defaults, refunds).
 *
 * `transactionAmount` semantics depend on `amountUnit`:
 *   - `amountUnit === 'usdc_whole'` (default): whole USD (1 === $1). All
 *     legacy callers fall through this path unchanged.
 *   - `amountUnit === 'pvt_whole'`: whole PVT (1 === 1 PVT). Callers that
 *     already have a BigInt of atomic PVT should convert via
 *     `Number(atomic / 10n ** 18n)` before passing. The badge engine reads
 *     this number as "economic activity" for threshold crossings; PVT
 *     badges are credited on the same field, so the discriminator is
 *     carried in the webhook payload rather than conflated with the number.
 */
export async function processAgentBankEvent(
  deps: AgentBankDeps,
  walletId: string,
  eventType: string,
  transactionAmount: number,
  amountUnit: AmountUnit = 'usdc_whole',
  context: ProcessedEventContext = {},
): Promise<void> {
  // The parties to notify. Defaults to the actor alone (a strictly targeted
  // delivery even for un-updated emitters) — never a network-wide broadcast.
  const recipients = context.recipients && context.recipients.length > 0
    ? Array.from(new Set(context.recipients.filter((r) => typeof r === 'string' && r.length > 0)))
    : [walletId];

  // Actor-side reconciliation (badges, counters, legacy callback) touches only the
  // acting wallet. Skipped for system-originated notices (notifyOnly, e.g. a
  // settlement landing) that must not bump a recipient's pe_count / activity.
  if (!context.notifyOnly) {
    await reconcileActor(deps, walletId, eventType, transactionAmount, amountUnit);
  }

  // TARGETED delivery (D1 webhooks) + INBOX (D2) to every party. This is the
  // change: per-interaction events reach exactly their parties, carrying the
  // entity id and each recipient's counterparty — never fanned out by type.
  await deliverInteractionEvent(deps, {
    eventType,
    actorWalletId: walletId,
    transactionAmount,
    amountUnit,
    recipients,
    context,
  });
}

/**
 * Actor-side reconciliation: badge reconcile, event-driven badge evaluation +
 * its qualification PE, and the legacy per-wallet callback. Returns early if the
 * actor wallet is gone (delivery to the OTHER parties still proceeds).
 */
async function reconcileActor(
  deps: AgentBankDeps,
  walletId: string,
  eventType: string,
  transactionAmount: number,
  amountUnit: AmountUnit,
): Promise<void> {
  const transactionAmountUsd = transactionAmount;
  const walletRef = deps.db.collection('agent_wallets').doc(walletId);
  await reconcileBadgeAwards(deps, walletId);
  const walletDoc = await walletRef.get();
  if (!walletDoc.exists) return;

  const wallet = walletDoc.data() as AgentWalletDocument;

  // Check for new badges after stats update
  const updatedWallet = {
    ...wallet,
    economic_activity_usd: wallet.economic_activity_usd + transactionAmountUsd,
  };

  // This path evaluates event-driven badges (pvt_minter, governance_participant,
  // insured_agent). the PE-count reputation badges read the LIVE count
  // (pe_history), never a stored per-wallet tally; 'governed' is no longer
  // awarded (the governance layer is gone).
  const livePeCount = await countVisibleAgentPEs(deps.db, wallet.agent_id);
  const newBadgeIds = badgeIds(evaluateBadges({
    wallet: updatedWallet,
    eventType,
    livePeCount,
  })).filter((badgeId) => badgeId !== 'pvt_minter'
    && badgeId !== 'governance_participant'
    && badgeId !== 'insured_agent');

  if (newBadgeIds.length > 0) {
    const now = Date.now();
    const outboxRefs = newBadgeIds.map((badgeId) =>
      badgeAwardOutboxRef(deps.db, walletId, badgeId));
    await generatePE(deps, {
      walletId,
      agentId: wallet.agent_id,
      actorAddress: wallet.address,
      actionType: 'policy_updated',
      timestampOverride: now,
      fixedEstimatedPVT: 0,
      metadata: {
        policy_key: 'badge_qualification',
        event_type: eventType,
        amount: transactionAmount,
        amount_unit: amountUnit,
        qualified_badges: newBadgeIds,
        no_pvt: 'badge_qualification_not_earning',
      },
      atomicEntityPrecondition: async (txn) => {
        const [currentWalletSnap, outboxSnaps] = await Promise.all([
          txn.get(walletRef),
          Promise.all(outboxRefs.map((ref) => txn.get(ref))),
        ]);
        const current = currentWalletSnap.exists
          ? currentWalletSnap.data() as AgentWalletDocument
          : null;
        if (!current
          || current.id !== wallet.id
          || current.agent_id !== wallet.agent_id
          || current.address.toLowerCase() !== wallet.address.toLowerCase()
          || current.status !== 'active'
          || !Array.isArray(current.badges)
          || newBadgeIds.some((badgeId) =>
            current.badges.some((badge) => badge.id === badgeId))
          || outboxSnaps.some((snapshot) => snapshot.exists)) {
          throw new Error('agent_badge_qualification_state_changed');
        }
      },
      atomicEntityWrite: (txn, peId, context) => {
        if (!context) throw new Error('agent_badge_qualification_pe_context_missing');
        newBadgeIds.forEach((badgeId, index) => {
          txn.create(outboxRefs[index], createPendingBadgeAward({
            walletId,
            agentId: wallet.agent_id,
            actorAddress: wallet.address,
            badgeId,
            trigger: 'agent_bank_event',
            earnedAtMs: now,
            sourcePeId: peId,
            sourcePeHash: context.newHash,
          }));
        });
      },
    });

    for (const badgeId of newBadgeIds) {
      try {
        await awardBadgeFromOutbox(deps, walletId, badgeId);
      } catch (error) {
        console.warn('[AgentBank] Badge award remains pending:', error);
      }
    }
  }

  // F21: the legacy per-wallet `callback_url` delivery was RETIRED here. It POSTed
  // to an agent-supplied URL through the raw platform `fetch` with `redirect:
  // 'follow'` and NO SSRF validation — a blind SSRF primitive (an agent could set
  // `callback_url` to a private/loopback/metadata target, or an https host that
  // 307-redirects to one). The targeted, HMAC-signed, SSRF-pinned webhook
  // subscriptions plus the durable inbox (deliverInteractionEvent, below, called
  // from processAgentBankEvent for EVERY party) supersede it entirely, so the
  // whole path is removed rather than patched. `callback_url` on the wallet
  // document is now inert (still accepted at registration for identity-fingerprint
  // compatibility, but read by nothing).

  // (Targeted webhook delivery + inbox now happen in deliverInteractionEvent,
  // called from processAgentBankEvent for EVERY party — not only the actor.)
}

/**
 * Deliver one per-interaction event to every party : TARGETED HMAC
 * webhooks (D1) to any recipient that subscribed, plus a durable INBOX row per
 * recipient (D2) so a recipient that cannot host an endpoint still hears it by
 * cursor read. The inbox write is idempotent per (outbox row, recipient) so a
 * retried drain overwrites rather than duplicates; the webhook dispatch stays
 * best-effort (its own subscription backoff handles delivery failures).
 */
async function deliverInteractionEvent(
  deps: AgentBankDeps,
  args: {
    eventType: string;
    actorWalletId: string;
    transactionAmount: number;
    amountUnit: AmountUnit;
    recipients: string[];
    context: ProcessedEventContext;
  },
): Promise<void> {
  const { eventType, actorWalletId, transactionAmount, amountUnit, recipients, context } = args;
  const deliveryData: Record<string, unknown> = {
    // Retained for continuity with the legacy shape (reads as whole USDC or whole
    // PVT per amount_unit); the entity id + counterparty are the new context.
    transaction_amount_usd: transactionAmount,
    amount: transactionAmount,
    amount_unit: amountUnit,
    ...(context.data ?? {}),
  };

  // D1 — targeted webhooks (fire-and-forget; never blocks the drain).
  dispatchTargetedEvent(deps, {
    eventType: eventType as WebhookEventType,
    recipients,
    actorWalletId,
    entityId: context.entityId ?? null,
    entityType: context.entityType ?? null,
    counterparties: context.counterparties,
    data: deliveryData,
  }).catch((err) => {
    console.error('[AgentBank] Targeted webhook dispatch failed:', err);
  });

  // D2 — durable inbox, one row per recipient, awaited so a failure re-queues.
  const occurredAtMs = context.occurredAtMs ?? Date.now();
  const eventKey = context.eventKey ?? `${actorWalletId}:${eventType}:${occurredAtMs}`;
  await Promise.all(recipients.map((recipient) =>
    writeInboxEvent(deps.db, {
      recipient,
      event: eventType,
      entityId: context.entityId,
      entityType: context.entityType,
      counterpartyWallet: context.counterparties?.[recipient] ?? null,
      actorWalletId,
      amount: transactionAmount,
      amountUnit,
      data: context.data,
      nowMs: occurredAtMs,
      eventId: deterministicInboxEventId(occurredAtMs, `${eventKey}:${recipient}`),
    }),
  ));
}
// F21: `sendWebhook` (the raw, unvalidated legacy per-wallet callback delivery)
// was removed with its only caller above. Targeted delivery goes through the
// SSRF-pinned `deliverToSubscriptions` in webhooks.ts.
