/**
 * Settlement gas model, calibrated against Base mainnet (, re-derived).
 *
 * The model must size BOTH shapes of backlog into batches the RPC will broadcast:
 * - routing-heavy (many DISTINCT recipients — beneficiary splits fanning out): each recipient
 * is the expensive term (~486k, the one 29-recipient observation on file). The model bounds
 * these to a handful of recipients per tx so the real gasLimit stays under the send cap.
 * - same-recipient (many claims to ONE address — e.g. a large single-payee payout): cheap per
 * claim (~58k measured). The model must NOT over-charge these into dozens of tiny batches
 * (the 2026-09-08 over-sizing that drove a transient RPC drop).
 *
 * Validated against OBSERVED per-recipient / per-claim gas, never against the model itself. The
 * original 2026-09-07 stall was `maxGas` (30M let a 564-claim batch reach ~16.9M real gasLimit),
 * so the RED control below moves `maxGas`, which is the load-bearing bound.
 */
import { describe, it, expect } from '@jest/globals';
import { planSettlementBatches, type SettlementWorkItem } from './batch-bounds';
import {
  cycleConfig,
  SETTLEMENT_GAS_MODEL,
  SETTLEMENT_MAX_BATCH_GAS,
  SETTLEMENT_BROADCASTABLE_GAS_CEILING,
} from './operator-runtime';

// Measured on chain (confirmed settle receipts, gasLimit ≈ gasUsed):
const REAL_GAS_PER_DISTINCT_RECIPIENT = 486_000; // routing-heavy: ~14.1M / 29 recipients
const REAL_GAS_PER_SAME_RECIPIENT_CLAIM = 58_000; // ~846k gasLimit / 12 claims, 1 recipient
// The gasLimit the deployed Alchemy endpoint actually rejected (-32003 "gas limit too high").
const REJECTED_GAS_LIMIT = 16_900_000;
const SIGNER = `0x${'a'.repeat(40)}`;

/** Routing-heavy worst case: one distinct contributor per claim (maximises recipients). */
function splitWork(count: number): SettlementWorkItem[] {
  return Array.from({ length: count }, (_, i) => ({
    contributor: `0x${(i + 1).toString(16).padStart(40, '0')}`,
    claimIds: [`0x${(i + 1).toString(16).padStart(64, '0')}`],
  }));
}

/** Same-recipient backlog: many claims to ONE address (a large single-payee payout). */
function sameRecipientWork(claimCount: number): SettlementWorkItem[] {
  return [{
    contributor: `0x${'e'.repeat(40)}`,
    claimIds: Array.from({ length: claimCount }, (_, i) => `0x${(i + 1).toString(16).padStart(64, '0')}`),
  }];
}

describe('settlement gas model (Base calibration, /)', () => {
  const cfg = cycleConfig('cal', SIGNER);
  // Real gasLimit of a batch, from the two measured terms (whichever the batch's shape implies).
  const realGasLimit = (recipientCount: number, claimCount: number): number =>
    Math.round(
      ((recipientCount * REAL_GAS_PER_DISTINCT_RECIPIENT)
        + (claimCount * REAL_GAS_PER_SAME_RECIPIENT_CLAIM))
      * cfg.gasHeadroomBps / 10_000,
    );

  it('routing-heavy: bounds a fan-out backlog so every real gasLimit stays broadcastable', () => {
    const res = planSettlementBatches(splitWork(60), cfg.batchLimits, cfg.gasModel, 0n);
    expect(res.kind).toBe('planned');
    if (res.kind !== 'planned') return;
    expect(res.batches.length).toBeGreaterThan(1); // never one giant tx
    for (const b of res.batches) {
      expect(realGasLimit(b.recipientCount, b.claimCount)).toBeLessThan(SETTLEMENT_BROADCASTABLE_GAS_CEILING);
      expect(realGasLimit(b.recipientCount, b.claimCount)).toBeLessThan(REJECTED_GAS_LIMIT);
    }
  });

  it('same-recipient: packs a large single-payee backlog efficiently (not dozens of tiny tx)', () => {
    const res = planSettlementBatches(sameRecipientWork(300), cfg.batchLimits, cfg.gasModel, 0n);
    expect(res.kind).toBe('planned');
    if (res.kind !== 'planned') return;
    // The 2026-09-08 defect packed ~12 claims/tx → 27 tx for 320 legs. The fix must do far
    // better: comfortably more than 40 same-recipient claims per batch.
    const biggest = Math.max(...res.batches.map((b) => b.claimCount));
    expect(biggest).toBeGreaterThan(40);
    // And still broadcastable.
    for (const b of res.batches) {
      expect(realGasLimit(b.recipientCount, b.claimCount)).toBeLessThan(REJECTED_GAS_LIMIT);
    }
  });

  it('RED CONTROL: raising maxGas back to the pre- 30M strands a routing-heavy batch', () => {
    const wideLimits = { ...cfg.batchLimits, maxGas: 30_000_000 };
    const res = planSettlementBatches(splitWork(60), wideLimits, cfg.gasModel, 0n);
    expect(res.kind).toBe('planned');
    if (res.kind !== 'planned') return;
    const worst = res.batches
      .map((b) => realGasLimit(b.recipientCount, b.claimCount))
      .reduce((a, x) => Math.max(a, x), 0);
    // With maxGas that high the planner packs a batch whose real gasLimit blows past the
    // endpoint's reject point — the exact stall, reproduced.
    expect(worst).toBeGreaterThan(REJECTED_GAS_LIMIT);
  });

  it('the constants reflect observed reality and keep a full batch broadcastable', () => {
    // The per-DISTINCT-RECIPIENT charge (a claim to a fresh address) must cover the observed
    // routing-heavy cost — this is the split-routing safety the whole model turns on.
    expect(SETTLEMENT_GAS_MODEL.gasPerRecipient + SETTLEMENT_GAS_MODEL.gasPerClaim)
      .toBeGreaterThanOrEqual(REAL_GAS_PER_DISTINCT_RECIPIENT);
    // A full batch at the planning cap, at real routing-heavy gas, stays under the reject point.
    const maxRecipients = Math.floor(
      (SETTLEMENT_MAX_BATCH_GAS - SETTLEMENT_GAS_MODEL.baseGas)
      / (SETTLEMENT_GAS_MODEL.gasPerRecipient + SETTLEMENT_GAS_MODEL.gasPerClaim),
    );
    expect(realGasLimit(maxRecipients, maxRecipients)).toBeLessThan(REJECTED_GAS_LIMIT);
    // The reclaim ceiling sits between the planner's target and the reject point.
    const maxRealAtCap = (SETTLEMENT_MAX_BATCH_GAS * cfg.gasHeadroomBps) / 10_000;
    expect(SETTLEMENT_BROADCASTABLE_GAS_CEILING).toBeLessThan(REJECTED_GAS_LIMIT);
    expect(SETTLEMENT_BROADCASTABLE_GAS_CEILING).toBeGreaterThan(maxRealAtCap);
  });
});
