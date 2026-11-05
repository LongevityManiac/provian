/**
 * the SPEECH-WINDOW BUDGET (money path).
 *
 * the operator’s invariant: the maximum a wallet can mint from speech inside one window is LESS THAN the
 * burn that opened it. This suite pins the rule by construction and its RED controls:
 * - strict `<` a PE landing exactly ON the budget is refused;
 * - the sum over a window never reaches the budget, however many PEs;
 * - a replayed PE (same pe_id) is idempotent — it never consumes twice;
 * - a refused PE consumes nothing (the next, smaller PE can still land);
 * - the rate: 10_000 bps = 1 point per burned PVT (RED: a 20_000 bps rate would let speech
 * out-mint its burn, so the constant is pinned).
 */
import { describe, it, expect } from '@jest/globals';
import {
  SPEECH_BUDGET_RATE_BPS,
  SPEECH_WINDOW_BUDGETS_COLLECTION,
  SPEECH_WINDOW_RESERVATIONS_COLLECTION,
  reserveSpeechWindowBudget,
  speechWindowAdmits,
  speechWindowBudgetAtomic,
} from './speech-window-budget';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import type { Firestore } from 'firebase-admin/firestore';

const PVT = 1_000_000_000_000_000_000n;
const BURN = 5n * PVT; // the pe_fact presentation floor
const NOW = 1_800_000_000_000;

function input(peId: string, points: bigint, burn: bigint = BURN) {
  return {
    peId, walletId: 'wallet_a', actionType: 'commons_post_created',
    burnId: 'b'.repeat(64), burnAmountAtomic: burn.toString(), pointsAtomic: points.toString(), timestampMs: NOW,
  };
}

describe('the pure rule', () => {
  it('budget = burn × 10_000 / 10_000 = the burn (1 point per burned PVT)', () => {
    expect(SPEECH_BUDGET_RATE_BPS).toBe(10_000);
    expect(speechWindowBudgetAtomic(BURN)).toBe(BURN);
  });

  it('admits STRICTLY below the budget: exactly ON the budget is refused', () => {
    expect(speechWindowAdmits(0n, BURN - 1n, BURN)).toBe(true);
    expect(speechWindowAdmits(0n, BURN, BURN)).toBe(false);
    expect(speechWindowAdmits(BURN - 1n, 1n, BURN)).toBe(false);
  });

  it('RED: a rate above 10_000 bps would let speech out-mint its burn (the constant is pinned at 10_000)', () => {
    const overRate = speechWindowBudgetAtomic(BURN, 20_000);
    expect(overRate).toBeGreaterThan(BURN);
    expect(speechWindowBudgetAtomic(BURN, SPEECH_BUDGET_RATE_BPS)).toBeLessThanOrEqual(BURN);
  });
});

describe('reserveSpeechWindowBudget (transactional ledger)', () => {
  it('a window of 5 PVT admits 1.6-point PEs while the sum stays below 5, then refuses', async () => {
    const db = createFakeFirestore();
    const p = 1_600_000_000_000_000_000n; // 1.6 points: human / beneficiary-linked first act
    const d1 = await reserveSpeechWindowBudget(db as unknown as Firestore, input('pe_1', p));
    const d2 = await reserveSpeechWindowBudget(db as unknown as Firestore, input('pe_2', p));
    const d3 = await reserveSpeechWindowBudget(db as unknown as Firestore, input('pe_3', p));
    const d4 = await reserveSpeechWindowBudget(db as unknown as Firestore, input('pe_4', p)); // 6.4 ≥ 5
    expect([d1.exhausted, d2.exhausted, d3.exhausted, d4.exhausted]).toEqual([false, false, false, true]);
    expect(BigInt(d3.consumedAtomic)).toBe(3n * p);
    expect(BigInt(d4.consumedAtomic)).toBe(3n * p); // a refusal consumes nothing
    expect(BigInt(d3.consumedAtomic)).toBeLessThan(BURN);
    const ledger = db.store.get(`${SPEECH_WINDOW_BUDGETS_COLLECTION}/${'b'.repeat(64)}`) as { admitted_pe_count: number; refused_pe_count: number };
    expect(ledger.admitted_pe_count).toBe(3);
    expect(ledger.refused_pe_count).toBe(1);
  });

  it('INVARIANT: for any sequence, Σ admitted points < burn (strict)', async () => {
    const db = createFakeFirestore();
    let sum = 0n;
    const sizes = [1_600n, 1_120n, 640n, 480n, 480n, 480n, 480n, 480n, 480n].map((m) => m * (PVT / 1000n));
    for (let i = 0; i < sizes.length; i++) {
      const d = await reserveSpeechWindowBudget(db as unknown as Firestore, input(`pe_${i}`, sizes[i]));
      if (!d.exhausted) sum += sizes[i];
      expect(BigInt(d.consumedAtomic)).toBe(sum);
      expect(sum).toBeLessThan(BURN);
    }
    expect(sum).toBeGreaterThan(0n);
  });

  it('RED: a PE landing exactly on the budget is refused (a "≤" rule would admit it)', async () => {
    const db = createFakeFirestore();
    const d = await reserveSpeechWindowBudget(db as unknown as Firestore, input('pe_exact', BURN));
    expect(d.exhausted).toBe(true);
    expect(BigInt(d.consumedAtomic)).toBe(0n);
  });

  it('a replayed PE is idempotent: the same pe_id never consumes twice', async () => {
    const db = createFakeFirestore();
    const p = 1_600_000_000_000_000_000n;
    const first = await reserveSpeechWindowBudget(db as unknown as Firestore, input('pe_same', p));
    const again = await reserveSpeechWindowBudget(db as unknown as Firestore, input('pe_same', p));
    expect(first.idempotent).toBe(false);
    expect(again.idempotent).toBe(true);
    expect(again.exhausted).toBe(false);
    expect(again.consumedAtomic).toBe(first.consumedAtomic);
    expect([...db.store.keys()].filter((k) => k.startsWith(`${SPEECH_WINDOW_RESERVATIONS_COLLECTION}/`))).toHaveLength(1);
  });

  it('a refused PE stays refused on replay (the reservation records the refusal)', async () => {
    const db = createFakeFirestore();
    const d1 = await reserveSpeechWindowBudget(db as unknown as Firestore, input('pe_big', BURN + 1n));
    const d2 = await reserveSpeechWindowBudget(db as unknown as Firestore, input('pe_big', BURN + 1n));
    expect(d1.exhausted).toBe(true);
    expect(d2.exhausted).toBe(true);
    expect(d2.idempotent).toBe(true);
  });

  it('a window with an unreadable burn (0) admits nothing', async () => {
    const db = createFakeFirestore();
    const d = await reserveSpeechWindowBudget(db as unknown as Firestore, input('pe_zero', 1n, 0n));
    expect(d.exhausted).toBe(true);
  });

  it('malformed input throws (the caller treats a throw as exhausted — Unknown = Block)', async () => {
    const db = createFakeFirestore();
    await expect(reserveSpeechWindowBudget(db as unknown as Firestore, { ...input('pe_x', 1n), burnAmountAtomic: '-5' })).rejects.toThrow(/burn_amount_invalid/);
    await expect(reserveSpeechWindowBudget(db as unknown as Firestore, { ...input('pe_x', 1n), pointsAtomic: '1.5' })).rejects.toThrow(/points_invalid/);
    await expect(reserveSpeechWindowBudget(db as unknown as Firestore, { ...input('', 1n) })).rejects.toThrow(/input_invalid/);
  });
});


describe('speech reservation follows the successful seal', () => {
  it('a retried preview stages its successful result only once', async () => {
    const { BatchPricingCounters } = await import('../meter/batch-pricing-counters');
    const fake = createFakeFirestore(); const db = fake as unknown as Firestore;
    const allocation = new BatchPricingCounters();
    const transact = db.runTransaction.bind(db);
    const preview = jest.spyOn(db, 'runTransaction').mockImplementation(async work => {
      await transact(work); // discarded read-only preview, then Firestore retries it
      return transact(work);
    });
    const result = await reserveSpeechWindowBudget(db, { ...input('retry-preview', 2n * PVT), sealCounters: allocation });
    preview.mockRestore();
    expect(result.consumedAtomic).toBe((2n * PVT).toString());
    await db.runTransaction(async txn => { await allocation.inspect(txn); allocation.commit(txn); });
    expect((await db.collection(SPEECH_WINDOW_BUDGETS_COLLECTION).doc('b'.repeat(64)).get()).data()?.admitted_pe_count).toBe(1);
  });

  it('an abandoned pricing attempt consumes no budget; commit applies it once', async () => {
    const { BatchPricingCounters } = await import('../meter/batch-pricing-counters');
    const fake = createFakeFirestore(); const db = fake as unknown as Firestore;
    const allocation = new BatchPricingCounters();
    const request = { ...input('deferred-price', 3n * PVT), sealCounters: allocation };
    await reserveSpeechWindowBudget(db, request);
    expect((await db.collection(SPEECH_WINDOW_RESERVATIONS_COLLECTION).doc('deferred-price').get()).exists).toBe(false);
    expect((await db.collection(SPEECH_WINDOW_BUDGETS_COLLECTION).doc('b'.repeat(64)).get()).exists).toBe(false);
    await db.runTransaction(async txn => { await allocation.inspect(txn); allocation.commit(txn); });
    expect((await db.collection(SPEECH_WINDOW_RESERVATIONS_COLLECTION).doc('deferred-price').get()).exists).toBe(true);
    expect((await db.collection(SPEECH_WINDOW_BUDGETS_COLLECTION).doc('b'.repeat(64)).get()).data()?.consumed_atomic).toBe((3n * PVT).toString());
  });
});
