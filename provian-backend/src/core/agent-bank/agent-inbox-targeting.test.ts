/**
 * WS D2 — inbox TARGETING + IDEMPOTENCY.
 *
 * The invariant: a per-interaction agent-bank event reaches EXACTLY its parties
 * through the durable inbox (D2), carrying each recipient's counterparty, and a
 * retried outbox drain (same row, same occurrence) OVERWRITES the recipient's row
 * rather than appending a duplicate. This binds to the real delivery path
 * (`processAgentBankEvent` → `deliverInteractionEvent` → `writeInboxEvent`), not a
 * stub, so the targeting logic under test is the one production runs.
 *
 * Both controls are in-suite and non-vacuous:
 * • TARGETING control — the SAME call that leaves a non-party with zero rows is
 * shown writing rows for the two parties, and a second call that DOES list the
 * third wallet as a recipient gives it a row. So "non-party excluded" cannot
 * pass because writes never happen; it passes because recipients drives it.
 * • IDEMPOTENCY control — two drains keyed on the SAME (occurredAtMs, eventKey)
 * collapse to one row per recipient, while two drains with a DIFFERENT
 * occurrence produce two. So the dedup cannot pass because writes are silently
 * dropped; it passes because the deterministic id keys on the occurrence.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { processAgentBankEvent } from './event-listener';
import { twoPartyTargeting, type ProcessedEventContext } from './event-outbox';
import { AGENT_INBOX_SUBCOLLECTION, type AgentInboxEvent } from './agent-inbox';
import type { AgentBankDeps } from './types';

function depsFor(db: FakeFirestore): AgentBankDeps {
  // The delivery path reads only `.db` here: no actor wallet doc (reconcileActor
  // returns early) and no webhook subscriptions (dispatchTargetedEvent returns
  // early), so the inbox write is the only observable effect.
  return { db } as unknown as AgentBankDeps;
}

/** Every inbox row stored under a given recipient wallet, oldest-first by id. */
function inboxRowsFor(db: FakeFirestore, walletId: string): AgentInboxEvent[] {
  const prefix = `agent_wallets/${walletId}/${AGENT_INBOX_SUBCOLLECTION}/`;
  return [...db.store.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, data]) => data as unknown as AgentInboxEvent);
}

const A = 'wallet_aw_depositor';
const B = 'wallet_aw_recipient';
const C = 'wallet_aw_bystander';

/** A drain-shaped context: the outbox row id + its created_at make the per-recipient
 *  inbox id deterministic, exactly as `drainAgentBankEventOutbox` supplies them. */
function drainContext(
  parties: { a: string; b: string },
  overrides: Partial<ProcessedEventContext> = {},
): ProcessedEventContext {
  return {
    ...twoPartyTargeting(parties.a, parties.b),
    entityId: 'escrow_123',
    entityType: 'escrow',
    eventKey: 'abe_row_1',
    occurredAtMs: 1_770_000_000_000,
    data: { currency: 'pvt' },
    ...overrides,
  };
}

describe('agent inbox targeting (WS D2)', () => {
  it('delivers a two-party event to exactly the parties, each carrying the OTHER as counterparty', async () => {
    const db = createFakeFirestore();
    await processAgentBankEvent(
      depsFor(db),
      A, // actor
      'escrow_funded',
      5,
      'pvt_whole',
      drainContext({ a: A, b: B }),
    );

    const aRows = inboxRowsFor(db, A);
    const bRows = inboxRowsFor(db, B);
    const cRows = inboxRowsFor(db, C);

    // Non-vacuous: the two parties each received exactly one row...
    expect({ a: aRows.length, b: bRows.length }).toEqual({ a: 1, b: 1 });
    // ...and each row names the OTHER party as its counterparty + carries the entity.
    expect(aRows[0]).toMatchObject({
      event: 'escrow_funded',
      entity_id: 'escrow_123',
      entity_type: 'escrow',
      counterparty_wallet: B,
      actor_wallet_id: A,
      amount: 5,
      amount_unit: 'pvt_whole',
    });
    expect(bRows[0]).toMatchObject({ counterparty_wallet: A, actor_wallet_id: A });
    // TARGETING : the bystander is not a party, so it gets nothing — and
    // this is meaningful precisely because A and B above DID get rows.
    expect({ evaluatedRecipients: [A, B], bystanderRows: cRows.length })
      .toEqual({ evaluatedRecipients: [A, B], bystanderRows: 0 });
  });

  it('RED control — a wallet that IS listed as a recipient receives a row (exclusion is driven by recipients, not by silence)', async () => {
    const db = createFakeFirestore();
    // Deliberately include the third wallet as a party this time.
    await processAgentBankEvent(
      depsFor(db),
      A,
      'escrow_funded',
      5,
      'pvt_whole',
      {
        recipients: [A, B, C],
        counterparties: { [A]: B, [B]: A, [C]: A },
        entityId: 'escrow_123',
        entityType: 'escrow',
        eventKey: 'abe_row_1',
        occurredAtMs: 1_770_000_000_000,
      },
    );
    // The same wallet that was silent when excluded now has a row — proving the
    // previous test's zero was targeting, not a delivery that never fires.
    expect(inboxRowsFor(db, C).length).toBe(1);
    expect(inboxRowsFor(db, C)[0]).toMatchObject({ counterparty_wallet: A });
  });

  it('is idempotent: a re-drained outbox row (same occurrence) overwrites, one row per recipient', async () => {
    const db = createFakeFirestore();
    const ctx = drainContext({ a: A, b: B });
    // Two deliveries of the SAME outbox occurrence (a scheduler retry after a crash
    // between the inbox write and the row's status flip).
    await processAgentBankEvent(depsFor(db), A, 'escrow_funded', 5, 'pvt_whole', ctx);
    await processAgentBankEvent(depsFor(db), A, 'escrow_funded', 5, 'pvt_whole', ctx);

    expect({ a: inboxRowsFor(db, A).length, b: inboxRowsFor(db, B).length }).toEqual({ a: 1, b: 1 });
  });

  it('RED control — a DIFFERENT occurrence is NOT deduped (idempotency keys on the occurrence, not on silence)', async () => {
    const db = createFakeFirestore();
    await processAgentBankEvent(
      depsFor(db),
      A,
      'escrow_funded',
      5,
      'pvt_whole',
      drainContext({ a: A, b: B }, { occurredAtMs: 1_770_000_000_000, eventKey: 'abe_row_1' }),
    );
    await processAgentBankEvent(
      depsFor(db),
      A,
      'escrow_funded',
      5,
      'pvt_whole',
      // A distinct outbox row / occurrence: a genuinely new event, not a retry.
      drainContext({ a: A, b: B }, { occurredAtMs: 1_770_000_099_000, eventKey: 'abe_row_2' }),
    );
    // Two genuine occurrences → two rows per recipient. Proves the dedup above is
    // real overwrite, not a write that quietly no-ops.
    expect({ a: inboxRowsFor(db, A).length, b: inboxRowsFor(db, B).length }).toEqual({ a: 2, b: 2 });
  });
});
