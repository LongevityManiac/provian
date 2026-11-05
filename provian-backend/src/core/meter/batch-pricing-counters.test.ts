import { BatchPricingCounters } from './batch-pricing-counters';
import type { MeterActOutcome } from './meter-seal';

const DAY = Date.UTC(2026, 9, 8);
function outcome(userId = 'actor', actionType = 'ai_conversation', timestampMs = DAY,
  required = true, replay = false): MeterActOutcome {
  return { replay, key: { side: { effect: { userId, actionType, timestampMs, redisCountersRequired: required } } } } as MeterActOutcome;
}

test('only fresh counter-bearing outcomes advance; actors, action types and UTC days retain their keys', () => {
  const counts = new BatchPricingCounters();
  counts.stage(outcome());
  counts.stage(outcome());
  counts.stage(outcome('actor', 'coding_session'));
  counts.stage(outcome('other'));
  counts.stage(outcome('actor', 'ai_conversation', DAY + 86_400_000));
  expect(counts.offsets('actor', 'ai_conversation', DAY)).toEqual([3, 2]);
  expect(counts.offsets('actor', 'coding_session', DAY)).toEqual([3, 1]);
  expect(counts.offsets('other', 'ai_conversation', DAY)).toEqual([1, 1]);
  expect(counts.offsets('actor', 'ai_conversation', DAY + 86_400_000)).toEqual([1, 1]);
  // RED controls: if any excluded act advances, the same later act is underpriced.
  counts.stage(outcome('actor', 'ai_conversation', DAY, false));
  counts.stage(outcome('actor', 'ai_conversation', DAY, true, true));
  counts.stage({ replay: false } as MeterActOutcome);
  expect(counts.offsets('actor', 'ai_conversation', DAY)).toEqual([3, 2]);
  // Failed ingest/retry discards this local overlay; it mutates no backing counter.
  expect(new BatchPricingCounters().offsets('actor', 'ai_conversation', DAY)).toEqual([0, 0]);
});
