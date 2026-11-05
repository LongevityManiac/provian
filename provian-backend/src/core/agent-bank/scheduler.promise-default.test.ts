/**
 * addendum — the RELAY-OBSERVED default sweep
 * (`processDefaults`), the first of the two default paths.
 *
 * the operator’s RED control #1: "a funded promise past its deadline becomes defaulted
 * with no lender action." That is the first test here, paired with its non-vacuous
 * negative controls (a not-yet-due promise is NOT flipped; an on-chain-unbound
 * promise is skipped). The sweep seals NO PE (proof arrives only via the lender's
 * on-chain markDefault upgrade, covered in promises.default.test.ts).
 *
 * Uses the rich fake Firestore (transactions + doc.ref + real enqueue writes) so
 * the flip and the outbox rows are exercised for real, not asserted over a mock.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import type { AgentBankDeps, PromiseDocument } from './types';
import { AGENT_BANK_EVENT_OUTBOX_COLLECTION } from './event-outbox';

// A relay-observed default seals NO PE. Mock the emitter so we can assert it is
// never called (the meaningful RED assertion), non-vacuous against the on-chain
// upgrade path that DOES emit (promises.default.test.ts).
const mockGeneratePE = jest.fn(async () => ({ peId: 'pe_mock', peHash: 'h', prevHash: 'p' }));
jest.mock('./pe-utils', () => ({
  generatePE: (...args: unknown[]) => (mockGeneratePE as (...a: unknown[]) => unknown)(...args),
  generateSchedulerPE: (...args: unknown[]) => (mockGeneratePE as (...a: unknown[]) => unknown)(...args),
}));

// eslint-disable-next-line import/first
import { processDefaults } from './scheduler';

function fundedPastDue(over: Partial<PromiseDocument> = {}): PromiseDocument {
  return {
    promise_id: 'promise_test',
    borrower_wallet_id: 'wallet_borrower',
    lender_wallet_id: 'wallet_lender',
    borrower_address: '0xborrower',
    lender_address: '0xlender',
    currency: 'usdc',
    chain: 'base',
    principal_usdc: 50,
    repay_usdc: 52.5,
    fee_usdc: 0.13,
    net_to_lender_usdc: 52.37,
    purpose: 'test',
    deadline: Date.now() - 60_000, // past due
    status: 'funded',
    onchain_promise_id: `0x${'ab'.repeat(32)}`,
    borrower_snapshot: {} as PromiseDocument['borrower_snapshot'],
    pe_ids: ['pe_created'],
    created_at: Date.now() - 100_000,
    updated_at: Date.now() - 100_000,
    ...over,
  } as PromiseDocument;
}

let fs: FakeFirestore;
function makeDeps(promise: PromiseDocument | null): AgentBankDeps {
  fs = createFakeFirestore();
  if (promise) fs.store.set('promises/promise_test', promise as unknown as Record<string, unknown>);
  return { db: fs } as unknown as AgentBankDeps;
}

function stored(): PromiseDocument {
  return fs.store.get('promises/promise_test') as unknown as PromiseDocument;
}

function outboxRows(): Array<Record<string, unknown>> {
  return [...fs.store.entries()]
    .filter(([k]) => k.startsWith(`${AGENT_BANK_EVENT_OUTBOX_COLLECTION}/`))
    .map(([, v]) => v);
}

beforeEach(() => {
  mockGeneratePE.mockClear();
});

describe('processDefaults — relay-observed default sweep ', () => {
  it('RED#1 — a funded promise PAST its deadline becomes defaulted (relay_observed) with NO lender action, seals no PE, notifies both parties', async () => {
    const deps = makeDeps(fundedPastDue());

    const processed = await processDefaults(deps);

    expect(processed).toBe(1);
    // The relay flipped it with no lender call anywhere in this path.
    expect(stored().status).toBe('defaulted');
    expect(stored().default_proof).toBe('relay_observed');
    expect(stored().defaulted_at).toBeGreaterThan(0);
    // No on-chain proof yet ⇒ no default_tx_hash, and crucially NO PE.
    expect(stored().default_tx_hash).toBeUndefined();
    expect(mockGeneratePE).not.toHaveBeenCalled();
    // Outbox: one row per party, both marked relay_observed.
    const rows = outboxRows();
    expect(rows).toHaveLength(2);
    const wallets = rows.map((r) => r.wallet_id).sort();
    expect(wallets).toEqual(['wallet_borrower', 'wallet_lender']);
    for (const r of rows) {
      expect(r.event_type).toBe('promise_defaulted');
      expect(r.entity_id).toBe('promise_test');
      expect((r.data as Record<string, unknown>).proof).toBe('relay_observed');
    }
  });

  it('NEGATIVE — a funded promise NOT yet past its deadline is left funded (no flip, no outbox)', async () => {
    const deps = makeDeps(fundedPastDue({ deadline: Date.now() + 60_000 }));

    const processed = await processDefaults(deps);

    expect(processed).toBe(0);
    expect(stored().status).toBe('funded');
    expect(stored().default_proof).toBeUndefined();
    expect(outboxRows()).toHaveLength(0);
  });

  it('NEGATIVE — a past-due promise with NO on-chain identity is skipped (Unknown = Block), not marked defaulted', async () => {
    const deps = makeDeps(fundedPastDue({ onchain_promise_id: undefined }));

    const processed = await processDefaults(deps);

    expect(processed).toBe(0);
    expect(stored().status).toBe('funded');
    expect(outboxRows()).toHaveLength(0);
  });

  it('NEGATIVE — an ALREADY-defaulted promise is not in the funded query and is not re-swept', async () => {
    const deps = makeDeps(fundedPastDue({ status: 'defaulted', default_proof: 'relay_observed' }));

    const processed = await processDefaults(deps);

    expect(processed).toBe(0);
    expect(outboxRows()).toHaveLength(0);
  });

  it('empty population — no funded promises ⇒ 0 (supplementary smoke; behavioral coverage is the RED above)', async () => {
    const deps = makeDeps(null);
    expect(await processDefaults(deps)).toBe(0);
  });
});
