/**
 * Capture-health: the witness lanes a device reports (no Grok hooks
 * intake, no self-report endpoint), detected harness homes (blind-but-healthy),
 * the supervision method, and the Grok repoint state.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildCaptureHealthReport, deriveWitnessLaneNames, detectHarnessHomes } from './capture-health';
import { supervisionFacts, startCaptureHealthHeartbeat } from './run-daemon';
import type { ProvianObserver } from './ProvianObserver';
import * as recordStore from './plugins/transcript/record-store';
import { buildCronBlock } from './service';

describe('heartbeat without agent transcript capture', () => {
  it.each([true, false])('a human daemon reports immediately and every interval, with actual SQLite capability %s and no transcript lane', async (available) => {
    vi.useFakeTimers();
    const capability = vi.spyOn(recordStore, 'sqliteAvailability').mockReturnValue(available ? { available: true } : { available: false, reason: 'unavailable' });
    const reportCaptureHealth = vi.fn().mockResolvedValue({});
    const observer = { reportCaptureHealth, getLastWorkPeAtMs: () => 77 } as unknown as ProvianObserver;
    const timer = startCaptureHealthHeartbeat(observer, null);
    try {
      expect(reportCaptureHealth).toHaveBeenCalledTimes(1);
      expect(reportCaptureHealth.mock.calls[0][0]).toMatchObject({ harnesses: [], total_sources: 0, lane_names: [], last_work_pe_at_ms: 77, sqlite_readable: available });
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(reportCaptureHealth).toHaveBeenCalledTimes(2);
    } finally { clearInterval(timer); capability.mockRestore(); vi.useRealTimers(); }
  });
});

const OFF = { active: false, receiverListening: false, spansEverSeen: false, lastSpanAtMs: null } as never;
const PROXY_OFF = { active: false, listening: false, turnsEverSeen: false, lastTurnAtMs: null, unrecognized: [] } as never;

describe('lane names', () => {
  it('only the observed lanes exist — transcript, otel, model_proxy (never grok_hooks or self_report)', () => {
    expect(deriveWitnessLaneNames({ totalSources: 0, otel: OFF, proxy: PROXY_OFF })).toEqual([]);
    const all = deriveWitnessLaneNames({
      totalSources: 2,
      otel: { active: true, receiverListening: true, spansEverSeen: true, lastSpanAtMs: 1 } as never,
      proxy: { active: true, listening: true, turnsEverSeen: true, lastTurnAtMs: 1, unrecognized: [] } as never,
    });
    expect(all).toEqual(['model_proxy', 'otel', 'transcript']);
  });
});

describe('buildCaptureHealthReport — fields', () => {
  const base = { deviceId: 'd', harnesses: [], nowMs: 100 } as never;
  it('defaults: no homes, supervision unknown, no work PE; no retired intake fields on the wire', () => {
    const r = buildCaptureHealthReport(base) as unknown as Record<string, unknown>;
    expect(r).toMatchObject({ detected_harness_homes: [], supervision_method: 'unknown', cron_alive: null, last_work_pe_at_ms: null });
    const retired = Object.keys(r).filter((k) => k.startsWith('hooks_') || k.startsWith('self_report_'));
    expect(retired).toEqual([]);
  });
  it('carries closed-set homes (an unknown name is dropped), supervision, and the last work PE', () => {
    const r = buildCaptureHealthReport({
      ...(base as object),
      detectedHarnessHomes: ['grok', 'codex', '/etc/passwd', 'grok'],
      supervision: { method: 'cron', cronAlive: false }, lastWorkPeAtMs: 77,
    } as never);
    expect(r).toMatchObject({
      detected_harness_homes: ['codex', 'grok'], supervision_method: 'cron', cron_alive: false, last_work_pe_at_ms: 77,
    });
  });
  it('drops retired per-harness arbitration fields even if an old caller supplies them', () => {
    const r=buildCaptureHealthReport({...(base as object),grokProxyRepoint:'repointed',grokWitnessMode:'proxy',proxyBypassedHarnesses:['demo']} as never);
    expect(Object.keys(r)).not.toEqual(expect.arrayContaining(['grok_proxy_repoint','grok_witness_mode','proxy_bypassed_harnesses']));
    for(const k of ['grok_proxy_repoint','grok_witness_mode','proxy_bypassed_harnesses'])expect(r).not.toHaveProperty(k);
  });
  it('detectHarnessHomes names only known homes that exist', () => {
    expect(detectHarnessHomes('/h', () => true)).toEqual([]); // Only configured programs, never guessed harness homes.
  });
});

describe('supervision', () => {
  it('reads the method from the daemon environment', () => {
    expect(supervisionFacts({ PROVIAN_SUPERVISOR: 'cron' }, 'linux', () => true)).toEqual({ method: 'cron', cronAlive: true });
    expect(supervisionFacts({ PROVIAN_SUPERVISOR: 'detached' }, 'linux', () => true)).toEqual({ method: 'detached', cronAlive: null });
    const ourUnit = () => '0::/user.slice/user@1000.service/app.slice/provian-observer.service\n';
    expect(supervisionFacts({ INVOCATION_ID: 'abc' }, 'linux', () => null, ourUnit)).toEqual({ method: 'systemd', cronAlive: null });
    // RED control: INVOCATION_ID inherited from another unit (an agent harness service) is not our supervisor.
    expect(supervisionFacts({ INVOCATION_ID: 'abc' }, 'linux', () => null, () => '0::/system.slice/grok-harness.service\n')).toEqual({ method: 'unknown', cronAlive: null });
    expect(supervisionFacts({ XPC_SERVICE_NAME: 'ai.provian.observer' }, 'darwin')).toEqual({ method: 'launchd', cronAlive: null });
    expect(supervisionFacts({}, 'win32')).toEqual({ method: 'scheduled_task', cronAlive: null });
    expect(supervisionFacts({}, 'linux')).toEqual({ method: 'unknown', cronAlive: null });
  });
  it('every cron tick marks its daemon PROVIAN_SUPERVISOR=cron', () => {
    const block = buildCronBlock({ command: '/root/.provian/node/bin/node', args: ['/root/.provian/agent.js', 'observe'] }, {}, '/root');
    for (const l of block.split('\n').slice(1, 3)) expect(l).toContain("PROVIAN_SUPERVISOR='cron'");
  });
});
