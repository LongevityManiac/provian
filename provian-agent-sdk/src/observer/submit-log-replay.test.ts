/**
 * the observer's `plugin PE submitted` line says whether a NEW PE was recorded or a
 * resubmission under the same idempotency key was answered with the PE already made —
 * `doctor` counts only new transcript PEs as real activity. PE meter: the replay is now
 * answered by this device's own PE store (the idempotency index), not by the relay.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { ProvianObserver } from './ProvianObserver';
import type { ObserverPlugin } from './plugins/PluginInterface';
import type { PluginContribution, PluginPE, SessionState } from './types';
import { transcriptPEsRecordedFromLog } from '../scripts/doctor';
import { CapturingPeStore } from '../meter/capturing-store.test-support';

// The stub stands in for the daemon's own transcript lane (a third-party plugin may never emit
// agent_tool_orchestration — see observation-types.test.ts), so it is treated as built in.
vi.mock('./built-in-lanes', () => ({ isBuiltInLane: () => true }));

class StubPlugin implements ObserverPlugin {
  constructor(readonly name: string, private queue: PluginPE[]) {}
  async init(): Promise<void> { /* noop */ }
  async start(): Promise<void> { /* noop */ }
  async stop(): Promise<void> { /* noop */ }
  tick(_session: SessionState | null): PluginContribution | null { return null; }
  drainPEs(): PluginPE[] { const out = this.queue; this.queue = []; return out; }
}

type ObserverPrivate = { runTick: () => Promise<void> };

const KEY = 'pe_mt_test_turn_0001';

async function submittedLine(store: CapturingPeStore): Promise<Record<string, unknown> | undefined> {
  const observer = new ProvianObserver({
    idleThresholdMs: 30_000, maxSessionMs: 15 * 60 * 1000, tickIntervalMs: 1000, plugins: [],
    relayUrl: 'https://relay.test', credentials: { ownerType: 'agent', deviceKey: 'pdk_test', deviceSecret: 'pds_test', relayUrl: 'https://relay.test' },
    logLevel: 'error', peStore: store,
  });
  const lines: Array<{ msg: string; extra?: Record<string, unknown> }> = [];
  const log = observer.log.bind(observer);
  vi.spyOn(observer, 'log').mockImplementation((level, msg, extra) => { lines.push({ msg, extra }); log(level, msg, extra); });
  observer.registerPlugin(new StubPlugin('transcript', [{
    actionType: 'agent_tool_orchestration', windowStart: 1000, windowEnd: 2000, idempotencyKey: KEY, skipDedupClaim: true,
  }]));
  await (observer as unknown as ObserverPrivate).runTick();
  return lines.find((l) => l.msg === 'plugin PE submitted')?.extra;
}

describe('plugin PE submitted carries idempotent_replay ', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('a new PE logs idempotent_replay: false — doctor counts it', async () => {
    const store = new CapturingPeStore();
    const extra = await submittedLine(store);
    expect(extra).toMatchObject({ plugin: 'transcript', pe_id: store.bodies[0].pe_id, idempotent_replay: false });
    expect(transcriptPEsRecordedFromLog(`[observer info] plugin PE submitted ${JSON.stringify(extra)}`)).toBe(1);
  });

  // RED CONTROL: a restart that lost its lane state resubmits the same turn under the same key;
  // the store answers with the PE it already holds, which is logged as a replay and not counted.
  it('a replay logs idempotent_replay: true — doctor does not count it', async () => {
    const store = new CapturingPeStore();
    const first = await submittedLine(store);
    const again = await submittedLine(store); // a second daemon run over the same store
    expect(again).toMatchObject({ pe_id: first?.pe_id, idempotent_replay: true });
    expect(store.bodies).toHaveLength(1);
    expect(transcriptPEsRecordedFromLog(`[observer info] plugin PE submitted ${JSON.stringify(again)}`)).toBe(0);
  });
});
