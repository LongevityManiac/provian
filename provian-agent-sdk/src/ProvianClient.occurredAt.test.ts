/**
 * A re-read transcript turn carries its own time onto the sealed PE : the
 * observer passes the lane's `occurredAtMs` through, and the client stamps
 * `min(occurredAtMs, now)` never a future time, never the emission time for an old turn.
 * RED controls: a future occurredAt is clamped to now; an absent / implausible one is now.
 */
import { describe, it, expect } from 'vitest';
import { MemoryPeStore } from './meter/pe-store';
import { ProvianClient } from './ProvianClient';
import { SUBMIT_OBSERVED_PE } from './observed-submit';
import { ProvianObserver } from './observer/ProvianObserver';
import type { PluginPE } from './observer/types';

async function sealedTimestamp(occurredAtMs: number | undefined, key: string): Promise<number> {
  const store = new MemoryPeStore('dev_t', `memory:${key}`);
  const client = new ProvianClient({ relayUrl: 'https://relay.test', deviceKey: 'pdk_x', deviceSecret: 'pds_x', deviceId: 'dev_t', peStore: store });
  await client[SUBMIT_OBSERVED_PE]({
    actionType: 'agent_tool_orchestration', success: true, metadata: { tool_count: 1 },
    idempotencyKey: `tt_${key.padEnd(20, '0')}`,
    ...(occurredAtMs !== undefined ? { occurredAtMs } : {}),
  });
  const stored = await store.findByIdempotencyKey(`tt_${key.padEnd(20, '0')}`);
  if (!stored) throw new Error('not stored');
  return stored.pe.timestamp;
}

describe('occurredAtMs → the sealed PE timestamp', () => {
  it('an old turn is sealed at its own time', async () => {
    const then = Date.now() - 3 * 24 * 60 * 60 * 1000;
    expect(await sealedTimestamp(then, 'old')).toBe(then);
  });

  it('RED: a future occurredAt is clamped to now; absent or implausible means now', async () => {
    const before = Date.now();
    for (const [v, k] of [[Date.now() + 10 * 60 * 1000, 'future'], [undefined, 'absent'], [42, 'tiny']] as const) {
      const ts = await sealedTimestamp(v, k);
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(Date.now());
    }
  });

  it('the observer passes a plugin PE\'s occurredAtMs through to the client report', () => {
    const pe: PluginPE = { actionType: 'agent_tool_orchestration', description: 'x', windowStart: 1, windowEnd: 2, occurredAtMs: 1_791_000_002_000, idempotencyKey: 'tt_abcdefabcdefabcdef' };
    const fakeThis = { executionEnv: () => ({}) };
    const report = (ProvianObserver.prototype as unknown as { reportFor: (pe: PluginPE, s: null) => Record<string, unknown> }).reportFor.call(fakeThis, pe, null);
    expect(report.occurredAtMs).toBe(1_791_000_002_000);
    expect(report.idempotencyKey).toBe('tt_abcdefabcdefabcdef');
  });
});
