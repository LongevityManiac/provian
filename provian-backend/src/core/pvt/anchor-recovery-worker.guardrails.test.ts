import { runAnchorRecoveryWorker } from './anchor-recovery-worker';

describe('retired legacy anchor-recovery execution guardrail', () => {
  it.each([
    { execute: true },
    { execute: true, maxAnchorsPerRun: 1 },
    { execute: true, maxGasUsdPerRun: 1 },
    { execute: true, gasPriceCeilingGwei: 1 },
  ])('cannot be re-enabled by legacy option set %#', async (options) => {
    const anchorBatch = jest.fn();
    const queryFilter = jest.fn();
    await expect(runAnchorRecoveryWorker({
      db: {} as never,
      pvtContract: { queryFilter } as never,
      peAnchorContract: { anchorBatch } as never,
    }, options)).rejects.toThrow(
      'anchor_recovery_execute_retired_use_mint_claim_recovery',
    );
    expect(queryFilter).not.toHaveBeenCalled();
    expect(anchorBatch).not.toHaveBeenCalled();
  });
});
