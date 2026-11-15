import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { RECOURSE_LANE_COLLECTION, laneLapse, type LaneReport } from './transaction-lane';
import { LANE_HEALTH_DOC, nextLaneHealth, recordLaneHealth } from './transaction-lane-health';

const run = (fields: Partial<LaneReport> = {}): LaneReport => ({ signed: 0, replaced: 0, confirmed: 0, failed: 0, closedUnsigned: 0,
  waiting: 0, lapsed: 0, open: 0, nextNonce: 0, stopReason: null, errors: [], ...fields });
const idle = run({ skipped: 'lane_idle' });

test('a sent or settled transaction clears a stall', () => {
  const stalled = { stalled_since_ms: 100, lapsed_while_stalled: 2, last_progress_at_ms: 50, stop_reason: 'recourse_lane_gas_unavailable' };
  for (const report of [run({ signed: 1 }), run({ confirmed: 1 }), run({ failed: 1 })]) {
    expect(nextLaneHealth(stalled, [report], 1_000)).toEqual({ checked_at_ms: 1_000, last_progress_at_ms: 1_000, stalled_since_ms: null,
      lapsed_while_stalled: 0, stop_reason: null });
  }
});
test('work with nothing sent starts a stall and keeps its start; lapsed requests accumulate', () => {
  const first = nextLaneHealth(undefined, [run({ stopReason: 'recourse_lane_gas_unavailable', waiting: 3 })], 1_000)!;
  expect(first).toMatchObject({ stalled_since_ms: 1_000, lapsed_while_stalled: 0, stop_reason: 'recourse_lane_gas_unavailable' });
  const second = nextLaneHealth({ ...first }, [run({ closedUnsigned: 2, failed: 2, lapsed: 2 })], 61_000)!;
  expect(second).toMatchObject({ stalled_since_ms: 1_000, lapsed_while_stalled: 2, checked_at_ms: 61_000 });
});
test('closing requests unsent is not progress', () => {
  expect(nextLaneHealth(undefined, [run({ closedUnsigned: 3, confirmed: 1, failed: 2, lapsed: 2 })], 5)).toMatchObject({ stalled_since_ms: 5, lapsed_while_stalled: 2 });
});
test('an idle lane ends a stall only when nothing ran out unsent during it', () => {
  expect(nextLaneHealth({ stalled_since_ms: 100, lapsed_while_stalled: 0 }, [idle], 1_000)).toMatchObject({ stalled_since_ms: null, checked_at_ms: 1_000 });
  // The queue emptied because its signatures expired: still stopped until it sends again.
  expect(nextLaneHealth({ stalled_since_ms: 100, lapsed_while_stalled: 4, stop_reason: 'recourse_lane_gas_unavailable' }, [idle], 1_000))
    .toMatchObject({ stalled_since_ms: 100, lapsed_while_stalled: 4, checked_at_ms: 1_000, stop_reason: 'recourse_lane_gas_unavailable' });
});
test('a run that found the lane held by another worker records nothing', () => {
  expect(nextLaneHealth({ stalled_since_ms: 100 }, [run({ skipped: 'lane_busy' })], 1_000)).toBeNull();
  expect(nextLaneHealth(undefined, [], 1_000)).toBeNull();
});
test('expired bindings and stale authorizations are lapses; other closures are not', () => {
  expect(['binding_expired', 'recourse_membership_debit_stale', 'recourse_membership_consent_stale', 'break_authority_stale'].every(laneLapse)).toBe(true);
  expect(['binding_already_bound', 'recourse_membership_debit_leaving', 'binding_duplicate_of_prior', 'already_satisfied'].some(laneLapse)).toBe(false);
});
test('the record is written to the lane collection and survives across runs', async () => {
  const db = createFakeFirestore() as unknown as Firestore;
  await recordLaneHealth(db, [run({ stopReason: 'recourse_lane_gas_unavailable' })], () => 1_000);
  await recordLaneHealth(db, [run({ lapsed: 1, closedUnsigned: 1, failed: 1 })], () => 61_000);
  await recordLaneHealth(db, [idle], () => 121_000);
  const saved = (await db.collection(RECOURSE_LANE_COLLECTION).doc(LANE_HEALTH_DOC).get()).data();
  expect(saved).toEqual({ checked_at_ms: 121_000, last_progress_at_ms: null, stalled_since_ms: 1_000, lapsed_while_stalled: 1,
    stop_reason: 'recourse_lane_gas_unavailable' });
  await recordLaneHealth(db, [run({ signed: 1 })], () => 181_000);
  expect((await db.collection(RECOURSE_LANE_COLLECTION).doc(LANE_HEALTH_DOC).get()).data()).toMatchObject({ stalled_since_ms: null, last_progress_at_ms: 181_000 });
});
