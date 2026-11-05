/**
 * F21 (, corrected 2026-09-10) — the legacy per-wallet `callback_url`
 * webhook delivery is RETIRED, not hardened.
 *
 * the standing rule: retire the legacy delivery leg entirely; the
 * targeted webhooks + the per-recipient durable inbox supersede it. S1 removed
 * the `sendWebhook` call site and the function (commit e28c3998). This suite is
 * the negative control the retirement shipped without: it proves,
 * behaviourally, that
 *
 * (1) a wallet with `callback_url` set is NEVER contacted at that URL when its
 * event is processed — the legacy `fetch`-based leg is gone — while
 * (2) the SAME event still reaches that wallet through the durable inbox,
 * so retiring the callback drops nothing on the floor (the "delivery test"),
 * (3) and the fetch spy the (1) assertion depends on DEMONSTRABLY observes a
 * POST to the callback host when one is made — so the zero in (1) is the
 * removed leg, not a dead spy over an empty population.
 *
 * It binds to the real pipeline (`processAgentBankEvent` → `reconcileActor` +
 * `deliverInteractionEvent`), which is exactly where the deleted delivery lived,
 * so the control exercises the code path that used to leak, not a stub.
 *
 * The legacy leg used the Node global `fetch`; nothing else on this path does
 * (the targeted webhook uses `https.request`; the inbox is Firestore-only),
 * so a `fetch` spy is a clean, sufficient witness for "the callback was contacted".
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { processAgentBankEvent } from './event-listener';
import { twoPartyTargeting } from './event-outbox';
import { AGENT_INBOX_SUBCOLLECTION, type AgentInboxEvent } from './agent-inbox';
import type { AgentBankDeps } from './types';
import type { AgentWalletDocument } from '../agent-wallet/types';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from '../pvt/policy/proposed-genesis-policy';

const A = 'wallet_aw_actor';
const B = 'wallet_aw_counterparty';
const LEGACY_CALLBACK = 'https://legacy-callback.example/hook';

function depsFor(db: FakeFirestore): AgentBankDeps {
  return { db } as unknown as AgentBankDeps;
}

/** A minimal actor wallet doc that carries a `callback_url` and triggers NO badge
 *  award (so `reconcileActor` runs its full body — the exact function that used to
 *  deliver to the callback — without diverting into the badge-outbox path). All
 *  stats sit below every threshold and `created_at` is AFTER the Genesis cutoff, so
 *  `evaluateBadges` returns nothing new. */
function actorWalletWithCallback(): Partial<AgentWalletDocument> {
  return {
    id: A,
    agent_id: 'agent_actor',
    address: '0x00000000000000000000000000000000000000aa',
    status: 'active',
    badges: [],
    economic_activity_usd: 0,
    x402_payment_count: 0,
    streak_days: 0,
    linked_human_wallet_id: null,
    // After the Genesis window end → not a genesis_agent badge. DERIVED from the policy: the
    // literal 1_793_000_000_000 that sat here fell INSIDE the window when extended it.
    created_at: (PROPOSED_GENESIS_CAMPAIGN_POLICY.window.end_ms as number) + 86_400_000,
    callback_url: LEGACY_CALLBACK,
  };
}

function inboxRowsFor(db: FakeFirestore, walletId: string): AgentInboxEvent[] {
  const prefix = `agent_wallets/${walletId}/${AGENT_INBOX_SUBCOLLECTION}/`;
  return [...db.store.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, data]) => data as unknown as AgentInboxEvent);
}

describe('F21 — legacy callback_url delivery is retired (control)', () => {
  let fetchCalls: string[];
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    fetchCalls = [];
    originalFetch = globalThis.fetch;
    // Record every fetch target; resolve without touching the network so any
    // surviving legacy delivery would be captured, not thrown.
    globalThis.fetch = jest.fn((input: unknown) => {
      const url = typeof input === 'string'
        ? input
        : String((input as { url?: unknown })?.url ?? input);
      fetchCalls.push(url);
      return Promise.resolve({ ok: true, status: 200 } as Response);
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('never contacts the callback_url, yet still delivers the event to the wallet via the inbox', async () => {
    const db = createFakeFirestore();
    const now = 1_780_000_000_000;
    db.store.set(`agent_wallets/${A}`, actorWalletWithCallback() as Record<string, unknown>);

    await processAgentBankEvent(
      depsFor(db),
      A, // actor — the wallet that carries the legacy callback_url
      'escrow_funded',
      5,
      'pvt_whole',
      {
        ...twoPartyTargeting(A, B),
        entityId: 'escrow_1',
        entityType: 'escrow',
        eventKey: 'abe_row_1',
        occurredAtMs: now,
      },
    );

    // (1) The legacy leg is dead: the whole pipeline ran and made ZERO fetches —
    // in particular none to the callback host.
    expect(fetchCalls.filter((u) => u.includes('legacy-callback.example'))).toEqual([]);
    expect(fetchCalls).toEqual([]);

    // (2) Delivery test: the event still reached the wallet through the
    // durable inbox — non-vacuity for (1), since the pipeline demonstrably
    // delivered, just not via the callback.
    const actorInbox = inboxRowsFor(db, A);
    expect(actorInbox.length).toBe(1);
    expect(actorInbox[0]).toMatchObject({
      event: 'escrow_funded',
      entity_id: 'escrow_1',
      counterparty_wallet: B,
      actor_wallet_id: A,
    });
  });

  it('RED control — the fetch spy DOES observe a POST to the callback host, so the zero above is the removed leg, not a dead spy', async () => {
    // If the legacy delivery still existed, THIS is the call it would have made.
    // Making it by hand proves the spy in the test above would have caught it.
    await globalThis.fetch(LEGACY_CALLBACK, { method: 'POST', body: '{}' });
    expect(fetchCalls).toEqual([LEGACY_CALLBACK]);
  });
});
