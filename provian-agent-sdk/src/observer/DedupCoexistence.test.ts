/**
 * Tests for PluginPE.skipDedupClaim coexistence semantics.
 *
 * A plugin that emits PEs in a different signal dimension than the generic
 * compute/inference/coding session family (currently LLMSessionPlugin and its
 * ai_conversation PE) can set skipDedupClaim on each emitted PE. The observer
 * must:
 *
 *   1. Submit the PE without consulting isClaimed().
 *   2. Not call claim() on the registry for that window.
 *
 * A plugin that emits PEs without skipDedupClaim must retain current dedup
 * behavior exactly: if the window is already claimed, the PE is dropped; if
 * not, submission claims the window.
 *
 * We drive submitPluginPE through the public plugin loop: register a stub
 * plugin with a scripted drainPEs() sequence, run a single tick, and inspect
 * the captured fetch bodies and registry state.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ProvianObserver } from './ProvianObserver';
import type { ObserverPlugin } from './plugins/PluginInterface';
import type { PluginContribution, PluginPE, SessionState } from './types';
import type { ProvianCredentials } from '../scripts/credentials';
import { CapturingPeStore } from '../meter/capturing-store.test-support';

// PE meter: a lane's PE is recorded in this device's PE store (no network); the suite reads what
// was recorded there instead of the old `POST /v1/pe/submit` wire bodies.
let currentStore = new CapturingPeStore();

class StubPlugin implements ObserverPlugin {
  readonly name: string;
  private queue: PluginPE[];

  constructor(name: string, queue: PluginPE[]) {
    this.name = name;
    this.queue = queue;
  }

  async init(): Promise<void> { /* noop */ }
  async start(): Promise<void> { /* noop */ }
  async stop(): Promise<void> { /* noop */ }

  tick(_session: SessionState | null): PluginContribution | null {
    return null;
  }

  drainPEs(): PluginPE[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }
}

function makeObserver(): ProvianObserver {
  const creds: ProvianCredentials = {
    deviceKey: 'pdk_test',
    deviceSecret: 'pds_test',
    relayUrl: 'https://relay.test',
  };
  return new ProvianObserver({
    idleThresholdMs: 30_000,
    maxSessionMs: 15 * 60 * 1000,
    tickIntervalMs: 1000,
    plugins: [],
    relayUrl: 'https://relay.test',
    credentials: creds,
    logLevel: 'error',
    peStore: currentStore,
  });
}

function stubFetch(): { spy: ReturnType<typeof vi.fn>; bodies: Record<string, unknown>[] } {
  currentStore = new CapturingPeStore();
  const bodies = currentStore.bodies;
  let peCounter = 0;
  const spy = vi.fn(async () => {
    peCounter += 1;
    return new Response(
      JSON.stringify({ pe_id: `pe_stub_${peCounter}`, estimated_pvt: 1 }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    ) as unknown as Response;
  });
  vi.stubGlobal('fetch', spy);
  return { spy, bodies };
}

// Access the private runTick via a cast so we can drive a single tick
// deterministically without relying on setInterval.
type ObserverPrivate = { runTick: () => Promise<void> };

describe('ProvianObserver + skipDedupClaim coexistence', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('submits a skipDedupClaim PE and does NOT claim its window', async () => {
    const { bodies } = stubFetch();
    const observer = makeObserver();

    const pe: PluginPE = {
      actionType: 'ai_conversation',
      windowStart: 1000,
      windowEnd: 2000,
      metadata: { provider: 'claude', duration_ms: 1000 },
      skipDedupClaim: true,
    };
    observer.registerPlugin(new StubPlugin('llm_session_plugin', [pe]));

    await (observer as unknown as ObserverPrivate).runTick();

    expect(bodies).toHaveLength(1);
    expect(bodies[0].action_type).toBe('ai_conversation');
    expect(observer.deduplicationRegistry.size()).toBe(0);
  });

  it('submits a normal PE and DOES claim its window', async () => {
    const { bodies } = stubFetch();
    const observer = makeObserver();

    const pe: PluginPE = {
      actionType: 'coding_session',
      windowStart: 1000,
      windowEnd: 2000,
    };
    observer.registerPlugin(new StubPlugin('git', [pe]));

    await (observer as unknown as ObserverPrivate).runTick();

    expect(bodies).toHaveLength(1);
    expect(observer.deduplicationRegistry.size()).toBe(1);
    const claim = observer.deduplicationRegistry.all()[0];
    expect(claim.start).toBe(1000);
    expect(claim.end).toBe(2000);
    expect(claim.plugin).toBe('git');
  });

  it('does NOT block a normal PE when an ai_conversation window overlaps', async () => {
    const { bodies } = stubFetch();
    const observer = makeObserver();

    const aiPE: PluginPE = {
      actionType: 'ai_conversation',
      windowStart: 1000,
      windowEnd: 5000,
      skipDedupClaim: true,
    };
    const codingPE: PluginPE = {
      actionType: 'coding_session',
      windowStart: 2000,
      windowEnd: 3000,
    };

    observer.registerPlugin(new StubPlugin('llm_session_plugin', [aiPE]));
    observer.registerPlugin(new StubPlugin('git', [codingPE]));

    await (observer as unknown as ObserverPrivate).runTick();

    expect(bodies).toHaveLength(2);
    const types = bodies.map(b => b.action_type);
    expect(types).toContain('ai_conversation');
    expect(types).toContain('coding_session');
    // Only the coding_session claim is recorded.
    expect(observer.deduplicationRegistry.size()).toBe(1);
    expect(observer.deduplicationRegistry.all()[0].plugin).toBe('git');
  });

  it('suppresses a normal PE whose window overlaps a prior normal claim (existing dedup preserved)', async () => {
    const { bodies } = stubFetch();
    const observer = makeObserver();

    // Pre-seed a normal claim directly to keep the test deterministic
    // (the two-tick path through submitPluginPE produces the same effect).
    observer.deduplicationRegistry.claim(1000, 3000, 'pe_seed', 'git');

    const codingPE: PluginPE = {
      actionType: 'coding_session',
      windowStart: 2000,
      windowEnd: 4000,
    };
    observer.registerPlugin(new StubPlugin('git', [codingPE]));

    await (observer as unknown as ObserverPrivate).runTick();

    expect(bodies).toHaveLength(0);
    // The seeded claim is still the only one on record.
    expect(observer.deduplicationRegistry.size()).toBe(1);
  });

  it('still submits skipDedupClaim PEs when a prior normal claim covers the same window', async () => {
    const { bodies } = stubFetch();
    const observer = makeObserver();

    observer.deduplicationRegistry.claim(1000, 3000, 'pe_seed', 'git');

    const aiPE: PluginPE = {
      actionType: 'ai_conversation',
      windowStart: 1500,
      windowEnd: 2500,
      skipDedupClaim: true,
    };
    observer.registerPlugin(new StubPlugin('llm_session_plugin', [aiPE]));

    await (observer as unknown as ObserverPrivate).runTick();

    expect(bodies).toHaveLength(1);
    expect(bodies[0].action_type).toBe('ai_conversation');
    expect(observer.deduplicationRegistry.size()).toBe(1); // unchanged
  });
});
