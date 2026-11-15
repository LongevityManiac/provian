/**
 * the settlement cycle's lease must outlive its run budget.
 *
 * `acquireCycleLease` takes the lease once, at cycle start, and nothing renews it. With the old
 * 10-min lease against a 30-min `maxRunMs`, the 2026-09-24 drain reserved batch 0x1af79dfb… at
 * minute ten and then had its attempt refused, leaving a zero-attempt `reserved` batch that
 * every later run aborts on. These tests bind to the PRODUCTION `cycleConfig` (never a copied
 * literal) and drive the real store's lease check late in the run.
 */
import { describe, it, expect } from '@jest/globals';
import { createFakeFirestore } from '../__test-helpers__/fake-firestore';
import { acquireCycleLease, reserveBatch, type SettlementDb } from './durable-settlement-store';
import {
  cycleConfig,
  cycleLeaseCoversRun,
  SETTLEMENT_CYCLE_LEASE_MARGIN_MS,
} from './operator-runtime';

const H = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
const SIGNER = `0x${'b'.repeat(40)}`;
const T0 = 1_790_000_000_000;

/** Acquire a cycle with `leaseTtlMs`, then attempt a reservation `atOffsetMs` into the run. */
async function reserveLateInRun(leaseTtlMs: number, atOffsetMs: number): Promise<string> {
  const db = createFakeFirestore() as unknown as SettlementDb;
  const config = cycleConfig('cycle-lease-test', SIGNER);
  const acquired = await acquireCycleLease(db, {
    cycleId: config.cycleId,
    workerId: config.workerId,
    nowMs: T0,
    leaseTtlMs,
    epoch: 7,
    policyHash: H(0xfeed),
    signer: SIGNER,
    baseNonce: 199,
    limits: { max_transactions: 100, max_fee_wei_total: '100000000000000000' },
    cursorStart: 0n,
  });
  if (acquired.kind !== 'acquired') throw new Error('setup lease failed');
  const reserved = await reserveBatch(db, {
    cycleId: config.cycleId,
    workerId: config.workerId,
    nowMs: T0 + atOffsetMs,
    batchId: H(0x5001),
    lane: 'standard',
    epoch: 7,
    policyHash: H(0xfeed),
    cursorStart: 0n,
    cursorEnd: 1n,
    recipientCount: 1,
    claimCount: 1,
    totalMintedAtomic: 1n,
    calldata: '0xdeadbeef',
    // Unregistered on purpose: the lease check runs BEFORE the member checks, so any refusal
    // other than `lease_not_held` proves the lease was still live at `atOffsetMs`.
    members: [{ leg: 'sole', pe_id: 'pe-unregistered', claim_id: H(1) }],
  });
  return reserved.kind === 'refused' ? reserved.reason : reserved.kind;
}

describe('settlement cycle lease covers the run budget ', () => {
  it('production cycleConfig: lease >= maxRunMs + margin', () => {
    const config = cycleConfig('c', SIGNER);
    expect(config.maxRunMs).toBeGreaterThan(0);
    expect(cycleLeaseCoversRun(config)).toBe(true);
    expect(config.leaseTtlMs - config.maxRunMs).toBeGreaterThanOrEqual(SETTLEMENT_CYCLE_LEASE_MARGIN_MS);
  });

  it('the production lease is still held at the last moment of the run budget', async () => {
    const config = cycleConfig('c', SIGNER);
    const reason = await reserveLateInRun(config.leaseTtlMs, config.maxRunMs);
    expect(reason).not.toBe('lease_not_held');
  });

  it('RED CONTROL: the pre-fix 10-min lease is refused at minute eleven of a 30-min run', async () => {
    const prefix = { leaseTtlMs: 10 * 60 * 1000, maxRunMs: 30 * 60 * 1000 };
    expect(cycleLeaseCoversRun(prefix)).toBe(false);
    expect(await reserveLateInRun(prefix.leaseTtlMs, 11 * 60 * 1000)).toBe('lease_not_held');
  });
});
