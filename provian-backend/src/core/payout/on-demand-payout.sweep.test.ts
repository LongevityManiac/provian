/**
 * The payout sweep and a request's settlement record, against the in-memory Firestore double:
 * the sweep takes the OLDEST open requests whatever the backlog's size, and a request whose
 * settlement run stopped early stays open, keeping what that run settled until it closes.
 */
import { describe, it, expect } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import {
  advancePayout,
  PAYOUT_REQUESTS_COLLECTION,
  storePaidPayoutRequest,
  sweepPayouts,
  type PayoutDeps,
  type PayoutSettleOutcome,
} from './on-demand-payout';
import type { PayoutChain } from './payout-chain';

const NOW = 1_800_000_000_000;

function makeDeps(db: Firestore, settle: (payee: string) => PayoutSettleOutcome): { deps: PayoutDeps; settled: string[] } {
  const settled: string[] = [];
  const deps: PayoutDeps = {
    db,
    chain: {} as PayoutChain,
    ethUsd: async () => 4000,
    settle: async (payee) => { settled.push(payee); return settle(payee); },
    withGasKeyLease: async (fn) => fn(),
    now: () => NOW,
    sleep: async () => {},
    log: () => {},
  };
  return { deps, settled };
}

function payeeOf(n: number): string {
  return `0x${n.toString(16).padStart(40, '0')}`;
}

async function seedCharged(db: Firestore, key: string, payee: string, createdAtMs: number): Promise<string> {
  const request = storePaidPayoutRequest({
    payee, requestedBy: 'u_fixture', platform: 'app_store', storeTransactionKey: key, readyPointsAtomic: 1n, nowMs: createdAtMs,
  });
  await db.collection(PAYOUT_REQUESTS_COLLECTION).doc(request.request_id).set(request as unknown as Record<string, unknown>);
  return request.request_id;
}

describe('sweepPayouts order', () => {
  it('RED: with a backlog far larger than the limit, the oldest requests are the ones examined', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    const LIMIT = 3;
    const BACKLOG = LIMIT * 5 + 9;
    // Newer requests are written first; the three oldest are written last, so no unordered read
    // bounded by a multiple of the limit reaches them.
    for (let i = 0; i < BACKLOG; i += 1) await seedCharged(db, `newer_${i}`, payeeOf(1000 + i), NOW - 1_000 + i);
    const oldest = [payeeOf(1), payeeOf(2), payeeOf(3)];
    await seedCharged(db, 'oldest_c', oldest[2], NOW - 70_000);
    await seedCharged(db, 'oldest_a', oldest[0], NOW - 90_000);
    await seedCharged(db, 'oldest_b', oldest[1], NOW - 80_000);

    const { deps, settled } = makeDeps(db, () => ({ kind: 'nothing', cycleId: null }));
    const sweep = await sweepPayouts(deps, LIMIT);
    expect(sweep).toEqual({ examined: LIMIT, settled: LIMIT, waiting: 0 });
    expect(settled).toEqual(oldest);
  });

  it('control: the population is non-empty and a request outside the open states is never examined', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    const id = await seedCharged(db, 'closed', payeeOf(7), NOW - 5_000);
    await db.collection(PAYOUT_REQUESTS_COLLECTION).doc(id).set({ state: 'settled' }, { merge: true });
    await seedCharged(db, 'open', payeeOf(8), NOW - 1_000);
    const { deps, settled } = makeDeps(db, () => ({ kind: 'nothing', cycleId: null }));
    expect(await sweepPayouts(deps, 5)).toEqual({ examined: 1, settled: 1, waiting: 0 });
    expect(settled).toEqual([payeeOf(8)]);
  });
});

describe('a settlement run that stopped early', () => {
  it('RED: leaves the request open with what it settled, and the finished run closes it with the cycle total', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    const id = await seedCharged(db, 'partial_same_cycle', payeeOf(21), NOW - 1_000);
    const runs: PayoutSettleOutcome[] = [
      { kind: 'wait', reason: 'transaction_limit', progress: { cycleId: 'cycle-a', claimsSettled: 2, batchesConfirmed: 1, feeWeiSpent: '5' } },
      // The cycle's totals are running totals: the finished run reports all three claims.
      { kind: 'settled', cycleId: 'cycle-a', claimsSettled: 3, batchesConfirmed: 2, feeWeiSpent: '9' },
    ];
    const { deps } = makeDeps(db, () => runs.shift()!);
    expect(await advancePayout(deps, id)).toMatchObject({
      state: 'charged', waiting_reason: 'transaction_limit', settled_at_ms: null, settlement: null,
      settlement_progress: { 'cycle-a': { claims_settled: 2, batches_confirmed: 1, fee_wei_spent: '5' } },
    });
    expect(await advancePayout(deps, id)).toMatchObject({
      state: 'settled',
      settlement: { cycle_id: 'cycle-a', claims_settled: 3, batches_confirmed: 2, fee_wei_spent: '9' },
    });
  });

  it('RED: what an earlier cycle settled is kept when a later cycle finishes with nothing left', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    const id = await seedCharged(db, 'partial_two_cycles', payeeOf(22), NOW - 1_000);
    const runs: PayoutSettleOutcome[] = [
      { kind: 'wait', reason: 'run_time_limit', progress: { cycleId: 'cycle-a', claimsSettled: 2, batchesConfirmed: 1, feeWeiSpent: '5' } },
      { kind: 'wait', reason: 'run_time_limit', progress: { cycleId: 'cycle-b', claimsSettled: 1, batchesConfirmed: 1, feeWeiSpent: '4' } },
      { kind: 'nothing', cycleId: 'cycle-c' },
    ];
    const { deps } = makeDeps(db, () => runs.shift()!);
    expect((await advancePayout(deps, id)).state).toBe('charged');
    expect((await advancePayout(deps, id)).state).toBe('charged');
    expect(await advancePayout(deps, id)).toMatchObject({
      state: 'settled',
      settlement: { cycle_id: 'cycle-c', claims_settled: 3, batches_confirmed: 2, fee_wei_spent: '9' },
    });
  });
});
