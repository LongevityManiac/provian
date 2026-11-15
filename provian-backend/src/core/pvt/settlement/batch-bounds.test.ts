import {
  KERNEL_MAX_RECIPIENTS_PER_BATCH,
  MEASURED_MARGINAL_GAS_PER_STANDARD_CLAIM,
  SETTLEMENT_LOAD_TARGET_RECIPIENTS_PER_BATCH,
  planSettlementBatches,
  type BatchGasModel,
  type BatchLimits,
  type PlannedBatch,
  type SettlementWorkItem,
} from './batch-bounds';

/** Strictly ascending, fixed-length lowercase hex — same order the kernel uses. */
function addr(index: number): string {
  return `0x${index.toString(16).padStart(40, '0')}`;
}

let claimSeq = 0;
function claims(count: number): string[] {
  return Array.from({ length: count }, () => {
    claimSeq += 1;
    return `0x${claimSeq.toString(16).padStart(64, '0')}`;
  });
}

function work(count: number, claimsEach: number): SettlementWorkItem[] {
  return Array.from({ length: count }, (_unused, index) => ({
    contributor: addr(index + 1),
    claimIds: claims(claimsEach),
  }));
}

/** Deliberately loose so a specific bound can be isolated per test. */
const ROOMY_GAS: BatchGasModel = { baseGas: 0, gasPerRecipient: 1, gasPerClaim: 1 };
const ROOMY: BatchLimits = { maxRecipients: 400, maxClaims: 100_000, maxGas: 1_000_000_000 };

function totalClaims(batches: readonly PlannedBatch[]): number {
  return batches.reduce((sum, batch) => sum + batch.claimCount, 0);
}

function planned(result: ReturnType<typeof planSettlementBatches>): readonly PlannedBatch[] {
  if (result.kind !== 'planned') throw new Error(`expected planned, got ${result.reason}`);
  return result.batches;
}

describe('kernel-mirroring constants', () => {
  it('pins the kernel ceiling and the approved operating target', () => {
    expect(KERNEL_MAX_RECIPIENTS_PER_BATCH).toBe(500);
    expect(SETTLEMENT_LOAD_TARGET_RECIPIENTS_PER_BATCH).toBe(400);
    expect(SETTLEMENT_LOAD_TARGET_RECIPIENTS_PER_BATCH).toBeLessThan(KERNEL_MAX_RECIPIENTS_PER_BATCH);
    // Measured in ProvianPVT9Wp4Settlement.t.sol.
    expect(MEASURED_MARGINAL_GAS_PER_STANDARD_CLAIM).toBe(23_283);
  });
});

describe('planSettlementBatches', () => {
  it('bounds claims per transaction — the bound the kernel does not provide', () => {
    // 10 recipients x 100 claims, capped at 250 claims: the recipient cap (400)
    // and gas are both slack, so only the claim bound can be doing the work.
    const batches = planned(
      planSettlementBatches(work(10, 100), { ...ROOMY, maxClaims: 250 }, ROOMY_GAS, 0n),
    );

    expect(batches).toHaveLength(5);
    for (const batch of batches) {
      expect(batch.claimCount).toBeLessThanOrEqual(250);
      expect(batch.recipientCount).toBeLessThanOrEqual(400);
    }
    expect(totalClaims(batches)).toBe(1_000);
  });

  it('bounds recipients per transaction', () => {
    const batches = planned(
      planSettlementBatches(work(10, 1), { ...ROOMY, maxRecipients: 4 }, ROOMY_GAS, 0n),
    );
    expect(batches.map((batch) => batch.recipientCount)).toEqual([4, 4, 2]);
  });

  it('bounds estimated gas per transaction', () => {
    // Only gas is tight: 21k base + 30k/recipient + 23,283/claim, 200k ceiling.
    const gas: BatchGasModel = {
      baseGas: 21_000,
      gasPerRecipient: 30_000,
      gasPerClaim: MEASURED_MARGINAL_GAS_PER_STANDARD_CLAIM,
    };
    const batches = planned(
      planSettlementBatches(work(10, 1), { ...ROOMY, maxGas: 200_000 }, gas, 0n),
    );

    for (const batch of batches) expect(batch.estimatedGas).toBeLessThanOrEqual(200_000);
    expect(batches.length).toBeGreaterThan(1);
    expect(totalClaims(batches)).toBe(10);
  });

  it('emits contiguous monotonic cursor ranges matching each claim count', () => {
    const batches = planned(
      planSettlementBatches(work(9, 7), { ...ROOMY, maxClaims: 20 }, ROOMY_GAS, 1_000n),
    );

    let expectedStart = 1_000n;
    for (const batch of batches) {
      // The kernel demands cursorStart == nextFinalizedCursor and
      // cursorEnd - cursorStart == claimCount.
      expect(batch.cursorStart).toBe(expectedStart);
      expect(batch.cursorEnd - batch.cursorStart).toBe(BigInt(batch.claimCount));
      expectedStart = batch.cursorEnd;
    }
    expect(expectedStart).toBe(1_000n + BigInt(totalClaims(batches)));
  });

  it('loses and duplicates nothing across the split', () => {
    const input = work(37, 11);
    const batches = planned(
      planSettlementBatches(input, { ...ROOMY, maxClaims: 40, maxRecipients: 3 }, ROOMY_GAS, 0n),
    );

    const flattened = batches.flatMap((batch) => batch.items);
    expect(flattened).toEqual(input);

    const allClaims = flattened.flatMap((item) => item.claimIds);
    expect(allClaims).toHaveLength(37 * 11);
    expect(new Set(allClaims).size).toBe(37 * 11);
  });

  it('splits an oversized contributor across consecutive sole-occupant slice batches', () => {
    // The decision the retired `recipient_exceeds_claim_bound` rejection
    // deferred, made in per-batch kernel flooring means a contributor
    // split into N slices can receive up to N-1 wei less than a single-batch
    // settlement — accepted as wei-bounded and deterministic; a whole-plan
    // rejection starved everyone instead.
    const heavy: SettlementWorkItem[] = [
      { contributor: addr(1), claimIds: claims(5) },
      { contributor: addr(2), claimIds: claims(300) },
      { contributor: addr(3), claimIds: claims(4) },
    ];
    const batches = planned(
      planSettlementBatches(heavy, { ...ROOMY, maxClaims: 100 }, ROOMY_GAS, 0n),
    );
    // Neighbors flush around the split; every slice is sole-occupant.
    expect(batches.map((batch) => batch.items.map(
      (item) => [item.contributor, item.claimIds.length],
    ))).toEqual([
      [[addr(1), 5]],
      [[addr(2), 100]],
      [[addr(2), 100]],
      [[addr(2), 100]],
      [[addr(3), 4]],
    ]);
    // Order-preserving, loss-free, duplicate-free across the slices.
    const rejoined = batches.flatMap((batch) => batch.items)
      .filter((item) => item.contributor === addr(2))
      .flatMap((item) => item.claimIds);
    expect(rejoined).toEqual(heavy[1].claimIds);
    expect(new Set(rejoined).size).toBe(300);
    // Cursor contiguity holds straight through the split.
    let cursor = 0n;
    for (const batch of batches) {
      expect(batch.cursorStart).toBe(cursor);
      expect(batch.cursorEnd - batch.cursorStart).toBe(BigInt(batch.claimCount));
      expect(batch.claimCount).toBeLessThanOrEqual(100);
      cursor = batch.cursorEnd;
    }
  });

  it('the slice bound honors the gas model, not just maxClaims', () => {
    // Alone: (maxGas 35 - base 10 - perRecipient 5) / perClaim 2 = 10 claims.
    const gas: BatchGasModel = { baseGas: 10, gasPerRecipient: 5, gasPerClaim: 2 };
    const limits: BatchLimits = { maxRecipients: 10, maxClaims: 1_000, maxGas: 35 };
    const heavy: SettlementWorkItem[] = [{ contributor: addr(1), claimIds: claims(25) }];
    const batches = planned(planSettlementBatches(heavy, limits, gas, 5n));
    expect(batches.map((batch) => batch.claimCount)).toEqual([10, 10, 5]);
    expect(batches.every((batch) => batch.estimatedGas <= 35)).toBe(true);
    expect(batches[0].cursorStart).toBe(5n);
    expect(batches[2].cursorEnd).toBe(30n);
  });

  it('refuses limits above the kernel recipient ceiling', () => {
    expect(
      planSettlementBatches(work(1, 1), { ...ROOMY, maxRecipients: 501 }, ROOMY_GAS, 0n),
    ).toEqual({ kind: 'rejected', reason: 'limits_exceed_kernel_ceiling' });

    // Exactly the kernel ceiling is allowed.
    expect(
      planSettlementBatches(work(1, 1), { ...ROOMY, maxRecipients: 500 }, ROOMY_GAS, 0n).kind,
    ).toBe('planned');
  });

  it('refuses limits under which no batch could ever be emitted', () => {
    const gas: BatchGasModel = { baseGas: 21_000, gasPerRecipient: 30_000, gasPerClaim: 23_283 };
    expect(planSettlementBatches(work(1, 1), { ...ROOMY, maxGas: 1_000 }, gas, 0n)).toEqual({
      kind: 'rejected',
      reason: 'limits_admit_no_batch',
    });
  });

  it('refuses contributors that are duplicated or out of kernel order', () => {
    const duplicated: SettlementWorkItem[] = [
      { contributor: addr(2), claimIds: claims(1) },
      { contributor: addr(2), claimIds: claims(1) },
    ];
    expect(planSettlementBatches(duplicated, ROOMY, ROOMY_GAS, 0n)).toEqual({
      kind: 'rejected',
      reason: 'duplicate_contributor',
      contributor: addr(2),
    });

    const descending: SettlementWorkItem[] = [
      { contributor: addr(9), claimIds: claims(1) },
      { contributor: addr(2), claimIds: claims(1) },
    ];
    expect(planSettlementBatches(descending, ROOMY, ROOMY_GAS, 0n)).toEqual({
      kind: 'rejected',
      reason: 'recipients_not_strictly_ordered',
      contributor: addr(2),
    });
  });

  it('treats mixed-case addresses as the same contributor for ordering', () => {
    // 0xab so the address actually contains hex LETTERS — with a digits-only
    // address `.toUpperCase()` is a no-op and this asserts nothing.
    const mixed: SettlementWorkItem[] = [
      { contributor: addr(0xab).toUpperCase().replace('0X', '0x'), claimIds: claims(1) },
      { contributor: addr(0xab), claimIds: claims(1) },
    ];
    expect(planSettlementBatches(mixed, ROOMY, ROOMY_GAS, 0n)).toEqual({
      kind: 'rejected',
      reason: 'duplicate_contributor',
      contributor: addr(0xab),
    });
  });

  it('refuses a zero-address contributor, which the kernel also rejects', () => {
    // The kernel seeds `address previous` at zero, so `contributor <= previous`
    // constrains the FIRST recipient too — and this would be the batch at
    // cursorStart == nextFinalizedCursor, wedging the whole cycle.
    const withZero: SettlementWorkItem[] = [
      { contributor: `0x${'0'.repeat(40)}`, claimIds: claims(1) },
      { contributor: addr(5), claimIds: claims(1) },
    ];
    expect(planSettlementBatches(withZero, ROOMY, ROOMY_GAS, 0n)).toEqual({
      kind: 'rejected',
      reason: 'recipients_not_strictly_ordered',
      contributor: `0x${'0'.repeat(40)}`,
    });
  });

  it('refuses a claim id repeated anywhere in the plan', () => {
    // The kernel's pre-pass only checks prior state, so an intra-batch
    // duplicate survives validation and reverts inside the mint loop.
    const repeated = claims(1)[0];

    const sameItem: SettlementWorkItem[] = [{ contributor: addr(1), claimIds: [repeated, repeated] }];
    expect(planSettlementBatches(sameItem, ROOMY, ROOMY_GAS, 0n)).toEqual({
      kind: 'rejected', reason: 'duplicate_claim_id', contributor: addr(1),
    });

    const acrossItems: SettlementWorkItem[] = [
      { contributor: addr(1), claimIds: [repeated] },
      { contributor: addr(2), claimIds: [repeated] },
    ];
    expect(planSettlementBatches(acrossItems, ROOMY, ROOMY_GAS, 0n)).toEqual({
      kind: 'rejected', reason: 'duplicate_claim_id', contributor: addr(2),
    });

    // Two hex spellings are one bytes32 on chain.
    const mixedCase: SettlementWorkItem[] = [
      { contributor: addr(1), claimIds: [`0x${'ab'.repeat(32)}`] },
      { contributor: addr(2), claimIds: [`0x${'AB'.repeat(32)}`] },
    ];
    expect(planSettlementBatches(mixedCase, ROOMY, ROOMY_GAS, 0n)).toEqual({
      kind: 'rejected', reason: 'duplicate_claim_id', contributor: addr(2),
    });
  });

  it('refuses malformed limits, gas models, cursors, and work items', () => {
    expect(planSettlementBatches(work(1, 1), { ...ROOMY, maxClaims: 0 }, ROOMY_GAS, 0n).kind)
      .toBe('rejected');
    expect(planSettlementBatches(work(1, 1), { ...ROOMY, maxGas: -1 }, ROOMY_GAS, 0n))
      .toEqual({ kind: 'rejected', reason: 'invalid_limits' });
    expect(planSettlementBatches(work(1, 1), { ...ROOMY, maxRecipients: 1.5 }, ROOMY_GAS, 0n))
      .toEqual({ kind: 'rejected', reason: 'invalid_limits' });
    expect(planSettlementBatches(work(1, 1), ROOMY, { ...ROOMY_GAS, gasPerClaim: 0 }, 0n))
      .toEqual({ kind: 'rejected', reason: 'invalid_gas_model' });
    expect(planSettlementBatches(work(1, 1), ROOMY, { ...ROOMY_GAS, baseGas: -1 }, 0n))
      .toEqual({ kind: 'rejected', reason: 'invalid_gas_model' });
    expect(planSettlementBatches(work(1, 1), ROOMY, ROOMY_GAS, -1n))
      .toEqual({ kind: 'rejected', reason: 'invalid_cursor' });

    for (const bad of [
      { contributor: 'not-an-address', claimIds: claims(1) },
      { contributor: addr(1), claimIds: [] },
      { contributor: addr(1), claimIds: ['0xdeadbeef'] },
    ] satisfies SettlementWorkItem[]) {
      expect(planSettlementBatches([bad], ROOMY, ROOMY_GAS, 0n))
        .toEqual({ kind: 'rejected', reason: 'invalid_work_item' });
    }
  });

  it('refuses a zero claim id, the sentinel the kernel rejects', () => {
    // Sibling of the zero-address recipient: an unset value that satisfies the
    // format regex but reverts `InvalidClaim` on chain.
    expect(
      planSettlementBatches(
        [{ contributor: addr(1), claimIds: [`0x${'0'.repeat(64)}`] }],
        ROOMY,
        ROOMY_GAS,
        0n,
      ),
    ).toEqual({ kind: 'rejected', reason: 'invalid_work_item' });
  });

  it('plans nothing for an empty cycle', () => {
    expect(planSettlementBatches([], ROOMY, ROOMY_GAS, 0n)).toEqual({ kind: 'planned', batches: [] });
  });

  it('respects every bound simultaneously when all three are tight', () => {
    const gas: BatchGasModel = { baseGas: 21_000, gasPerRecipient: 30_000, gasPerClaim: 23_283 };
    const limits: BatchLimits = { maxRecipients: 7, maxClaims: 25, maxGas: 900_000 };
    const batches = planned(planSettlementBatches(work(40, 3), limits, gas, 5n));

    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(batch.recipientCount).toBeLessThanOrEqual(limits.maxRecipients);
      expect(batch.claimCount).toBeLessThanOrEqual(limits.maxClaims);
      expect(batch.estimatedGas).toBeLessThanOrEqual(limits.maxGas);
      expect(batch.recipientCount).toBeGreaterThan(0);
    }
    expect(totalClaims(batches)).toBe(120);
  });
});
