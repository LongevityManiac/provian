/**
 * computeDeterministicBatchId — moved from the retired PVTv8 mint engine
 * (minting-engine.snapshot.test.ts) with the function itself. The pinned vector
 * was computed from the engine's derivation before the move, so a change to the
 * derivation (which would orphan every historical snapshot anchor-recovery
 * re-derives) fails here, not silently.
 */
import { computeDeterministicBatchId } from './batch-id';

describe('computeDeterministicBatchId', () => {
  const root = '0x' + 'aa'.repeat(32);

  it('matches the pinned pre-move derivation vector', () => {
    expect(computeDeterministicBatchId(['pe_2', 'pe_1', 'pe_3'], root)).toBe(
      '0xeacc9b61463f2e3f6f2e9c4a7558457e91daadb484315bddb56b63c5385b3ed6',
    );
  });

  it('RED control: a different PE set does not reproduce the pinned vector', () => {
    expect(computeDeterministicBatchId(['pe_1', 'pe_2'], root)).not.toBe(
      '0xeacc9b61463f2e3f6f2e9c4a7558457e91daadb484315bddb56b63c5385b3ed6',
    );
  });

  it('depends on the SET of PE IDs, not their input order (sorted internally)', () => {
    expect(computeDeterministicBatchId(['pe_1', 'pe_2'], root)).toBe(
      computeDeterministicBatchId(['pe_2', 'pe_1'], root),
    );
  });

  it('changes when merkleRoot changes', () => {
    expect(
      computeDeterministicBatchId(['pe_1'], '0x' + 'aa'.repeat(32)),
    ).not.toBe(
      computeDeterministicBatchId(['pe_1'], '0x' + 'bb'.repeat(32)),
    );
  });

  it('does not mutate its input array', () => {
    const peIds = ['pe_2', 'pe_1'];
    computeDeterministicBatchId(peIds, root);
    expect(peIds).toEqual(['pe_2', 'pe_1']);
  });
});
