/**
 * Agent Bank - Webhook Subscriptions
 *
 * HMAC-signed webhook delivery system. Agents subscribe to event types
 * and receive HMAC-SHA256 signed payloads when matching events occur.
 *
 * Follows the GitHub/Stripe pattern: secrets stored server-side,
 * payloads signed with HMAC-SHA256, recipients verify via X-Provian-Signature header.
 *
 * Deactivates subscriptions after 10 consecutive delivery failures.
 */

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { URL } from 'url';
import dns from 'dns/promises';
import net from 'net';
import { Agent as HttpsAgent, request as httpsRequest } from 'https';
import { bumpOpsCounter } from '../observability/ops-counters';
import { isPrivateIp } from '../net/private-ip';
import { pinnedLookup } from '../net/pinned-lookup';
import { startDeadline, raceDeadline, DeadlineExceededError, type Deadline } from '../net/bounded-fetch';
import {
  SAFETY_LIMITS,
  type AgentBankDeps,
  type WebhookSubscriptionDocument,
  type WebhookEventType,
  type CreateWebhookRequest,
} from './types';
import type { AgentWalletDocument } from '../agent-wallet/types';
import { ValidationError, NotFoundError, ForbiddenError } from './errors';
import { generatePE } from './pe-utils';

const MAX_CONSECUTIVE_FAILURES = 10;

// #7: Concurrency limiter for webhook deliveries
const MAX_CONCURRENT_DELIVERIES = 5;

// DNS validation cache (60s TTL) - returns validated IP addresses (resolve-and-pin)
const dnsValidationCache = new Map<string, { validUntil: number; addresses: string[] }>();
const DNS_CACHE_TTL_MS = 60_000;

/**
 * Resolve and validate webhook URL DNS, returning pinned IPs.
 * Prevents SSRF via DNS rebinding by pinning the resolved IP for delivery.
 */
async function resolveAndValidateWebhookUrl(url: string): Promise<string[]> {
  const parsed = new URL(url);
  const hostname = parsed.hostname;

  // Check cache first
  const cacheEntry = dnsValidationCache.get(hostname);
  if (cacheEntry && Date.now() < cacheEntry.validUntil) {
    return cacheEntry.addresses;
  }

  let addresses: string[];

  // Block IP-literal hostnames that are obviously private (IPv4 or IPv6)
  if (net.isIP(hostname)) {
    if (isPrivateIP(hostname)) {
      throw new ValidationError('Webhook URL must not target private or internal IP addresses');
    }
    addresses = [hostname];
  } else {
    // Phase 2.23 (D3-H-7): query BOTH A and AAAA records and reject if
    // any address resolves to a private range. The previous code only
    // checked resolve4 - an attacker could publish a public A record
    // and a private AAAA record, and node-fetch / undici would happily
    // dial the IPv6 private address since it has higher precedence on
    // dual-stack hosts.
    try {
      const [v4, v6] = await Promise.all([
        dns.resolve4(hostname).catch(() => [] as string[]),
        dns.resolve6(hostname).catch(() => [] as string[]),
      ]);
      addresses = [...v4, ...v6];

      if (addresses.length === 0) {
        throw new ValidationError(`Webhook URL hostname could not be resolved: ${hostname}`);
      }

      for (const addr of addresses) {
        if (isPrivateIP(addr)) {
          throw new ValidationError('Webhook URL must not resolve to private or internal IP addresses');
        }
      }
    } catch (err: unknown) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError(`Webhook URL hostname could not be resolved: ${hostname}`);
    }
  }

  if (addresses.length === 0) {
    throw new ValidationError('Webhook URL hostname resolved to no addresses');
  }

  // [LEAK FIX] Sweep expired entries before adding the new one. The prior code
  // only checked the freshness of the requested entry - every other expired
  // entry leaked indefinitely. O(N) per call but N stays small with this sweep.
  const now = Date.now();
  for (const [host, entry] of dnsValidationCache) {
    if (now > entry.validUntil) {
      dnsValidationCache.delete(host);
    }
  }
  dnsValidationCache.set(hostname, { validUntil: now + DNS_CACHE_TTL_MS, addresses });
  return addresses;
}

/**
 * Validate webhook URL at registration time (no pinning needed, just validation).
 */
async function validateWebhookUrl(url: string): Promise<void> {
  await resolveAndValidateWebhookUrl(url);
}

// isPrivateIP now lives in ../net/private-ip (shared with the Commons avatar
// proxy) so there is ONE blocklist, not two that can drift. Aliased to the old
// local name to keep the call sites below unchanged.
const isPrivateIP = isPrivateIp;

/**
 * Create a new webhook subscription.
 * Returns the HMAC secret once - agent must store it.
 */
export async function createWebhookSubscription(
  deps: AgentBankDeps,
  walletId: string,
  wallet: AgentWalletDocument,
  body: CreateWebhookRequest,
): Promise<{ subscription_id: string; secret: string }> {
  if (!body.url || typeof body.url !== 'string') {
    throw new ValidationError('url is required');
  }

  try {
    new URL(body.url);
  } catch {
    throw new ValidationError('url must be a valid URL');
  }

  if (!body.url.startsWith('https://')) {
    throw new ValidationError('url must use HTTPS');
  }

  // SSRF prevention: block private IPs, cloud metadata, internal services
  await validateWebhookUrl(body.url);

  if (!Array.isArray(body.events) || body.events.length === 0) {
    throw new ValidationError('events must be a non-empty array');
  }

  // Check subscription limit
  const existing = await deps.db.collection('webhook_subscriptions')
    .where('wallet_id', '==', walletId)
    .where('is_active', '==', true)
    .get();

  if (existing.size >= SAFETY_LIMITS.MAX_WEBHOOK_SUBSCRIPTIONS) {
    throw new ValidationError(`Maximum ${SAFETY_LIMITS.MAX_WEBHOOK_SUBSCRIPTIONS} active subscriptions`);
  }

  const subscriptionId = `wh_${uuidv4()}`;
  const secret = crypto.randomBytes(32).toString('hex');
  const now = Date.now();

  const doc: WebhookSubscriptionDocument = {
    subscription_id: subscriptionId,
    wallet_id: walletId,
    url: body.url,
    events: body.events,
    secret,
    is_active: true,
    consecutive_failures: 0,
    created_at: now,
    updated_at: now,
  };

  await deps.db.collection('webhook_subscriptions').doc(subscriptionId).set(doc);

  // Generate PE
  await generatePE(deps, {
    walletId,
    agentId: wallet.agent_id,
    actorAddress: wallet.address,
    actionType: 'webhook_subscribed',
    metadata: {
      subscription_id: subscriptionId,
      events: body.events,
      url: body.url,
    },
  });

  return { subscription_id: subscriptionId, secret };
}

/**
 * List webhook subscriptions for a wallet. Secrets are masked.
 */
export async function listWebhookSubscriptions(
  deps: AgentBankDeps,
  walletId: string,
): Promise<Omit<WebhookSubscriptionDocument, 'secret'>[]> {
  const snap = await deps.db.collection('webhook_subscriptions')
    .where('wallet_id', '==', walletId)
    .orderBy('created_at', 'desc')
    .get();

  return snap.docs.map((doc) => {
    const data = doc.data() as WebhookSubscriptionDocument;
    const { secret: _secret, ...rest } = data;
    return rest;
  });
}

/**
 * Delete a webhook subscription. Verifies ownership.
 */
export async function deleteWebhookSubscription(
  deps: AgentBankDeps,
  walletId: string,
  subscriptionId: string,
): Promise<void> {
  const docRef = deps.db.collection('webhook_subscriptions').doc(subscriptionId);
  const doc = await docRef.get();

  if (!doc.exists) {
    throw new NotFoundError('Subscription not found');
  }

  const data = doc.data() as WebhookSubscriptionDocument;
  if (data.wallet_id !== walletId) {
    throw new ForbiddenError('Not your subscription');
  }

  await docRef.delete();
}

/**
 * Dispatch a webhook event to all matching active subscriptions.
 * HMAC-SHA256 signs the payload with each subscription's secret.
 * Deactivates subscriptions after MAX_CONSECUTIVE_FAILURES failures.
 *
 * Fire-and-forget - errors are logged but not thrown.
 */
export async function dispatchWebhookEvent(
  deps: AgentBankDeps,
  eventType: WebhookEventType,
  payload: Record<string, unknown>,
): Promise<void> {
  const snap = await deps.db.collection('webhook_subscriptions')
    .where('events', 'array-contains', eventType)
    .where('is_active', '==', true)
    .get();

  if (snap.empty) return;

  const subscriptions = snap.docs.map((subDoc) => ({
    ref: subDoc.ref,
    sub: subDoc.data() as WebhookSubscriptionDocument,
  }));

  // Broadcast: every subscriber to this type gets the same body. Used ONLY for
  // genuinely network-wide events (e.g. action_type_activated). Per-interaction
  // events use dispatchTargetedEvent so they never fan out network-wide by type.
  await deliverToSubscriptions(subscriptions, eventType, () => ({
    event: eventType,
    ...payload,
    delivered_at: Date.now(),
  }));
}

/**
 * TARGETED dispatch : deliver an event ONLY to the wallets that are party
 * to the interaction, with a per-recipient body that names the entity and THAT
 * recipient's counterparty — never network-wide by type. A subscriber to
 * e.g. `escrow_funded` no longer receives every funded escrow on the network,
 * only those it is a party to.
 *
 * The event-type index query is reused (it stays a single-field query, no new
 * composite index), then filtered in memory to the recipient set — recipient
 * sets are small (both parties, or a pool's contributors), so this is cheap.
 */
export async function dispatchTargetedEvent(
  deps: AgentBankDeps,
  args: {
    eventType: WebhookEventType;
    recipients: string[];
    actorWalletId?: string | null;
    entityId?: string | null;
    entityType?: string | null;
    counterparties?: Record<string, string>;
    data?: Record<string, unknown>;
  },
): Promise<void> {
  const recipientSet = new Set(args.recipients.filter((r) => typeof r === 'string' && r.length > 0));
  if (recipientSet.size === 0) return;

  const snap = await deps.db.collection('webhook_subscriptions')
    .where('events', 'array-contains', args.eventType)
    .where('is_active', '==', true)
    .get();
  if (snap.empty) return;

  const subscriptions = snap.docs
    .map((subDoc) => ({ ref: subDoc.ref, sub: subDoc.data() as WebhookSubscriptionDocument }))
    .filter(({ sub }) => recipientSet.has(sub.wallet_id));
  if (subscriptions.length === 0) return;

  await deliverToSubscriptions(subscriptions, args.eventType, (sub) => ({
    event: args.eventType,
    entity_id: args.entityId ?? null,
    entity_type: args.entityType ?? null,
    counterparty_wallet: args.counterparties?.[sub.wallet_id] ?? null,
    actor_wallet_id: args.actorWalletId ?? null,
    ...(args.data ?? {}),
    delivered_at: Date.now(),
  }));
}

/**
 * Deliver a body (built per-subscription so a targeted event can carry a
 * recipient-specific counterparty) to each subscription, HMAC-signed, SSRF/DNS
 * pinned, with the shared failure-backoff. Fire-and-forget: errors are counted,
 * never thrown.
 */
async function deliverToSubscriptions(
  subscriptions: { ref: FirebaseFirestore.DocumentReference; sub: WebhookSubscriptionDocument }[],
  eventType: WebhookEventType,
  buildBody: (sub: WebhookSubscriptionDocument) => Record<string, unknown>,
): Promise<void> {
  // #7: Limit concurrent deliveries with a semaphore pattern
  for (let i = 0; i < subscriptions.length; i += MAX_CONCURRENT_DELIVERIES) {
    const batch = subscriptions.slice(i, i + MAX_CONCURRENT_DELIVERIES);
    await Promise.allSettled(
      batch.map(async ({ ref, sub }) => {
        const body = JSON.stringify(buildBody(sub));

        const signature = crypto
          .createHmac('sha256', sub.secret)
          .update(body)
          .digest('hex');

        // ONE wall-clock deadline over the whole delivery — DNS
        // resolve-and-validate, connect, TLS, request write, and response headers.
        // The request's own `timeout` is only a socket-IDLE timer, which an endpoint
        // trickling a byte per window resets forever.
        const deadline = startDeadline(WEBHOOK_DELIVERY_DEADLINE_MS);
        try {
          // Resolve-and-pin: DNS validated + pinned to prevent rebinding TOCTOU.
          // A rejected (private/SSRF) URL is its OWN advisory counter, not a generic
          // delivery failure, but still drives the backoff via incrementFailureCount.
          let pinnedIPs: string[];
          try {
            pinnedIPs = await raceDeadline(resolveAndValidateWebhookUrl(sub.url), deadline);
          } catch (urlErr) {
            if (urlErr instanceof DeadlineExceededError) {
              // DNS outlived the delivery budget: a failed delivery, not an SSRF refusal.
              bumpOpsCounter('webhook.failed');
            } else {
              bumpOpsCounter('webhook.url_rejected');
            }
            await incrementFailureCount(ref, sub);
            return;
          }

          // F22: pin the SOCKET to the pre-validated IP so DNS cannot rebind
          // between validate and connect. The previous code passed this
          // https.Agent to the global `fetch` as `agent` — but Node's fetch is
          // undici, which IGNORES `agent` (it takes `dispatcher`), so the custom
          // lookup NEVER ran and the connection re-resolved via the OS resolver at
          // fetch time (a live rebinding TOCTOU behind a dead guard). `https.request`
          // DOES honour an https.Agent's `lookup`, so the connection goes to the
          // validated address and nowhere else (`pinnedLookup` derives the family from
          // the pinned IP and answers Node 20's `all: true` lookup shape —).
          // Redirects are NOT followed (https.request does not follow them), so a 3xx
          // is a delivery failure — the intent of the old redirect:'error'.
          const pinnedIp = pinnedIPs[0];
          const agent = new HttpsAgent({ lookup: pinnedLookup(pinnedIp) });

          let status = 0;
          try {
            status = await postWebhookPinned({
              url: sub.url,
              agent,
              body,
              headers: {
                'X-Provian-Signature': `sha256=${signature}`,
                'X-Provian-Event': eventType,
              },
              deadline,
            });
          } finally {
            agent.destroy();
          }

          if (status >= 200 && status < 300) {
            bumpOpsCounter('webhook.delivered');
            // Reset failure counter on success
            if (sub.consecutive_failures > 0) {
              await ref.update({
                consecutive_failures: 0,
                updated_at: Date.now(),
              });
            }
          } else {
            bumpOpsCounter('webhook.failed');
            await incrementFailureCount(ref, sub);
          }
        } catch {
          bumpOpsCounter('webhook.failed');
          await incrementFailureCount(ref, sub);
        } finally {
          deadline.clear();
        }
      }),
    );
  }
}

/** Socket-IDLE timeout for one webhook delivery (ms). */
export const WEBHOOK_IDLE_TIMEOUT_MS = 5000;
/**
 * wall-clock budget for one delivery (ms) — DNS + connect + TLS + write +
 * response headers. The response body is never read (it is drained and the pinned
 * agent destroyed), so headers are the last phase that can hold the request.
 */
export const WEBHOOK_DELIVERY_DEADLINE_MS = 10_000;

export interface PostWebhookArgs {
  url: string;
  /** The https.Agent whose lookup pins the socket to the validated address. */
  agent: HttpsAgent;
  body: string;
  /** Signature/event headers; Content-Type and Content-Length are set here. */
  headers: Record<string, string>;
  /** The delivery's wall-clock deadline (already running: it covered DNS too). */
  deadline: Deadline;
  idleTimeoutMs?: number;
}

/**
 * POST one signed webhook over the pinned agent and resolve with the response
 * status. Rejects on a network error, the idle timeout, or the wall-clock deadline
 * — whichever comes first; redirects are not followed (https.request never does).
 */
export function postWebhookPinned(args: PostWebhookArgs): Promise<number> {
  const { url, agent, body, headers, deadline } = args;
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, status = 0): void => {
      if (settled) return;
      settled = true;
      deadline.signal.removeEventListener('abort', onDeadline);
      if (err) reject(err);
      else resolve(status);
    };
    const outbound = httpsRequest(url, {
      method: 'POST',
      agent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
      timeout: args.idleTimeoutMs ?? WEBHOOK_IDLE_TIMEOUT_MS,
    }, (response) => {
      response.resume(); // drain the body so the socket can close
      finish(null, response.statusCode ?? 0);
    });
    const onDeadline = (): void => {
      const err = new DeadlineExceededError(deadline.ms);
      outbound.destroy(err);
      finish(err);
    };
    if (deadline.signal.aborted) onDeadline();
    else deadline.signal.addEventListener('abort', onDeadline, { once: true });
    outbound.on('timeout', () => outbound.destroy(new Error('webhook_timeout')));
    outbound.on('error', (err) => finish(err));
    outbound.write(body);
    outbound.end();
  });
}

async function incrementFailureCount(
  ref: FirebaseFirestore.DocumentReference,
  sub: WebhookSubscriptionDocument,
): Promise<void> {
  const newCount = sub.consecutive_failures + 1;
  const updates: Record<string, unknown> = {
    consecutive_failures: newCount,
    updated_at: Date.now(),
  };

  if (newCount >= MAX_CONSECUTIVE_FAILURES) {
    updates.is_active = false;
  }

  await ref.update(updates);
}
