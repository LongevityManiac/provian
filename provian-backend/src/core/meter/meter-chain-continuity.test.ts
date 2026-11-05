/**
 * a `compute_session` sealed `skipped_no_output` is a chain-continuity
 * record — it keeps no act key, no act-page row and no mint-once claim on the relay. The end-to-end
 * proof (it stays in the device's chain, the next batch chains off it, no other act moves) is the
 * Firestore-emulator case in `meter-single-lane.emulator.test.ts`. This suite pins the predicate and
 * the lane fact the seal relies on, in the ordinary battery.
 */
import { describe, it, expect } from '@jest/globals';
import type { PEHistoryDocument } from '../../pe-history';
import { isChainContinuityRecord } from './meter-seal';
import { isSingleLaneActType } from './act-witness-lanes';

// Typed against the row builder's own fields, so a renamed field fails to compile here.
type Row = Pick<PEHistoryDocument, 'actionType' | 'mint_status'>;
const row = (r: Row): Record<string, unknown> => r as unknown as Record<string, unknown>;

describe(' chain-continuity record', () => {
  it('a compute_session sealed skipped_no_output is a chain-continuity record', () => {
    expect(isChainContinuityRecord(row({ actionType: 'compute_session', mint_status: 'skipped_no_output' }))).toBe(true);
  });

  it('RED controls: any other status, or any other type, is not', () => {
    for (const mint_status of ['eligible', 'record_only', 'ineligible', 'corroborated_duplicate', 'farm_capped'] as const) {
      expect(isChainContinuityRecord(row({ actionType: 'compute_session', mint_status }))).toBe(false);
    }
    for (const actionType of ['inference_session', 'ai_conversation', 'coding_session']) {
      expect(isChainContinuityRecord(row({ actionType, mint_status: 'skipped_no_output' }))).toBe(false);
    }
    // The snake_case spelling is not a row field: a predicate reading it would never fire.
    expect(isChainContinuityRecord({ action_type: 'compute_session', mint_status: 'skipped_no_output' })).toBe(false);
  });

  it('compute_session is single-lane, so the device batch (the only lane that seals skipped_no_output) never needs its act key', () => {
    expect(isSingleLaneActType('compute_session')).toBe(true);
  });
});
