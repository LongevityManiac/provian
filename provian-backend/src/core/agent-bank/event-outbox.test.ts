/**
 * Finding 14 — durable agent-bank event outbox.
 *
 * The defect being closed: route handlers fired `processAgentBankEvent`
 * un-awaited AFTER `res.json`, so Cloud Run dropped badge/webhook work on
 * instance shutdown. The outbox records the event durably BEFORE responding and
 * a scheduler drains it. These tests prove the durable path delivers, is
 * idempotent, retries failures, and reclaims crash-abandoned rows.
 *
 * RED negative controls are marked inline: each guard is fed an input that makes
 * it report the violation, so none can pass vacuously.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import {
  AGENT_BANK_EVENT_OUTBOX_COLLECTION,
  MAX_EVENT_ATTEMPTS,
  STALE_PROCESSING_MS,
  drainAgentBankEventOutbox,
  enqueueAgentBankEvent,
  type AgentBankEventRecord,
} from './event-outbox';
import type { AgentBankDeps } from './types';

function depsFor(db: FakeFirestore): AgentBankDeps {
  // Only `.db` is read by the outbox path (the injected processor stands in for
  // processAgentBankEvent, which is what actually needs the rest of AgentBankDeps).
  return { db } as unknown as AgentBankDeps;
}

/** The fake implements the subset the outbox touches; cast at the boundary. */
function asDb(db: FakeFirestore): Firestore {
  return db as unknown as Firestore;
}

async function rows(db: FakeFirestore): Promise<AgentBankEventRecord[]> {
  const snap = await db.collection(AGENT_BANK_EVENT_OUTBOX_COLLECTION).get();
  return snap.docs.map((d) => d.data() as unknown as AgentBankEventRecord);
}

describe('agent-bank event outbox (finding 14)', () => {
  it('enqueue writes exactly one pending row carrying the event', async () => {
    const db = createFakeFirestore();
    const id = await enqueueAgentBankEvent(asDb(db), {
      walletId: 'wallet_aw_1',
      eventType: 'escrow_funded',
      transactionAmount: 42,
      amountUnit: 'pvt_whole',
    });
    expect(id).toMatch(/^abe_/);
    const all = await rows(db);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      wallet_id: 'wallet_aw_1',
      event_type: 'escrow_funded',
      transaction_amount: 42,
      amount_unit: 'pvt_whole',
      status: 'pending',
      attempts: 0,
    });
  });

  it('drain runs the processor for a pending row and marks it done', async () => {
    const db = createFakeFirestore();
    await enqueueAgentBankEvent(asDb(db), { walletId: 'w1', eventType: 'promise_settled', transactionAmount: 10 });
    const calls: Array<[string, string, number, string]> = [];
    const result = await drainAgentBankEventOutbox(depsFor(db), 50, async (_d, w, e, a, u) => {
      calls.push([w, e, a, u]);
    });
    expect(result.processed).toBe(1);
    expect(calls).toEqual([['w1', 'promise_settled', 10, 'usdc_whole']]);
    expect((await rows(db))[0].status).toBe('done');
  });

  it('RED: a drain over an EMPTY outbox processes zero (no vacuous pass)', async () => {
    const db = createFakeFirestore();
    let called = 0;
    const result = await drainAgentBankEventOutbox(depsFor(db), 50, async () => { called += 1; });
    // Print the evaluated population so a pass over zero is a distinct status.
    expect({ evaluated: (await rows(db)).length, processed: result.processed, called })
      .toEqual({ evaluated: 0, processed: 0, called: 0 });
  });

  it('is idempotent: a second drain does not re-run an already-done row', async () => {
    const db = createFakeFirestore();
    await enqueueAgentBankEvent(asDb(db), { walletId: 'w1', eventType: 'job_posted', transactionAmount: 0 });
    let processedCount = 0;
    const proc = async () => { processedCount += 1; };
    await drainAgentBankEventOutbox(depsFor(db), 50, proc);
    const second = await drainAgentBankEventOutbox(depsFor(db), 50, proc);
    expect(processedCount).toBe(1); // ran once, not twice
    expect(second.processed).toBe(0);
  });

  it('RED: a failing processor retries (status→pending, attempts up), never marks done', async () => {
    const db = createFakeFirestore();
    await enqueueAgentBankEvent(asDb(db), { walletId: 'w1', eventType: 'court_verdict', transactionAmount: 0 });
    const failing = async () => { throw new Error('boom'); };
    const first = await drainAgentBankEventOutbox(depsFor(db), 50, failing);
    expect(first.failed).toBe(1);
    const afterOne = (await rows(db))[0];
    expect(afterOne.status).toBe('pending'); // recoverable, not lost
    expect(afterOne.attempts).toBe(1);
    expect(afterOne.last_error).toContain('boom');
  });

  it('parks a permanently-failing row as failed after MAX_EVENT_ATTEMPTS', async () => {
    const db = createFakeFirestore();
    await enqueueAgentBankEvent(asDb(db), { walletId: 'w1', eventType: 'court_verdict', transactionAmount: 0 });
    const failing = async () => { throw new Error('boom'); };
    for (let i = 0; i < MAX_EVENT_ATTEMPTS; i += 1) {
      await drainAgentBankEventOutbox(depsFor(db), 50, failing);
    }
    const row = (await rows(db))[0];
    expect(row.attempts).toBe(MAX_EVENT_ATTEMPTS);
    expect(row.status).toBe('failed');
    // A failed row is terminal: a further drain does not touch it.
    const after = await drainAgentBankEventOutbox(depsFor(db), 50, failing);
    expect(after.processed + after.failed).toBe(0);
  });

  it('reclaims a crash-abandoned processing row and re-delivers it', async () => {
    const db = createFakeFirestore();
    // Simulate a row a crashed instance left mid-flight: status 'processing',
    // claimed long enough ago to be stale.
    const staleId = 'abe_stale';
    await db.collection(AGENT_BANK_EVENT_OUTBOX_COLLECTION).doc(staleId).set({
      wallet_id: 'w1',
      event_type: 'bond_posted',
      transaction_amount: 0,
      amount_unit: 'usdc_whole',
      status: 'processing',
      attempts: 1,
      created_at: Date.now() - 10 * STALE_PROCESSING_MS,
      updated_at: Date.now() - 10 * STALE_PROCESSING_MS,
      claimed_at: Date.now() - 10 * STALE_PROCESSING_MS,
    });

    let processed = 0;
    const result = await drainAgentBankEventOutbox(depsFor(db), 50, async () => { processed += 1; });
    expect(result.reclaimed).toBe(1);
    expect(processed).toBe(1);
    expect((await rows(db))[0].status).toBe('done');
  });

  it('RED: a FRESH processing row is NOT reclaimed (staleness guard can refuse)', async () => {
    const db = createFakeFirestore();
    await db.collection(AGENT_BANK_EVENT_OUTBOX_COLLECTION).doc('abe_fresh').set({
      wallet_id: 'w1',
      event_type: 'bond_posted',
      transaction_amount: 0,
      amount_unit: 'usdc_whole',
      status: 'processing',
      attempts: 1,
      created_at: Date.now(),
      updated_at: Date.now(),
      claimed_at: Date.now(), // just claimed by a live instance
    });
    let processed = 0;
    const result = await drainAgentBankEventOutbox(depsFor(db), 50, async () => { processed += 1; });
    expect(result.reclaimed).toBe(0);
    expect(processed).toBe(0);
    expect((await rows(db))[0].status).toBe('processing'); // left for its live owner
  });
});
