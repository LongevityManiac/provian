import { ProgramWitnessRegistry } from '../program-witness';
/**
 * `provian doctor`'s synthetic turn is classified and never minted. Before, the OTel
 * lane queued it as an `agent_tool_orchestration` PE the relay sealed eligible at 1.6 PVT —
 * a turn no agent ran (Atlas's 2026-08-27 doctor run settled one on-chain).
 */
import { describe, it, expect } from 'vitest';
import { OTelPlugin, parseOtlpTracePayload } from './OTelPlugin';
import { buildSyntheticToolTrace, syntheticTraceEmitted } from '../../scripts/doctor';
import { DOCTOR_PROBE_LOG_LINE, isDoctorProbeTrace } from '../doctor-probe';

const TID = 'a1b2c3d4'.repeat(4);

async function run(payload: unknown): Promise<{ pes: ReturnType<OTelPlugin['drainPEs']>; log: string }> {
  const lines: string[] = [];
  const observer = { log: (level: string, msg: string, extra?: Record<string, unknown>) => { lines.push(`[observer ${level}] ${msg} ${JSON.stringify(extra ?? {})}`); } } as unknown as import('../ProvianObserver').ProvianObserver;
  const plugin = new OTelPlugin({ journalPath: null, forceActive: true, programRegistry: {allows:()=>true, identify:()=> 'fixture'} as unknown as ProgramWitnessRegistry });
  await plugin.init(observer);
  plugin.ingestParsedSpans(parseOtlpTracePayload(payload).map(s=>({...s,attributes:{...s.attributes,'gen_ai.response.id':'fixture-real-response'}})));
  const internals = plugin as unknown as {traces: Map<string, unknown>; flushTrace: (acc: unknown, reason: 'idle') => void};
  for (const acc of internals.traces.values()) internals.flushTrace(acc, 'idle');
  await plugin.stop();
  return { pes: plugin.drainPEs(), log: lines.join('\n') };
}

describe('the doctor probe is classified and never minted ', () => {
  it("doctor's own payload queues no PE and logs the classification doctor reads", async () => {
    const { pes, log } = await run(buildSyntheticToolTrace(TID, 'r'.repeat(16), ['1'.repeat(16), '2'.repeat(16)], 1_700_000_000_000));
    expect(pes).toHaveLength(0);
    expect(log).toContain(DOCTOR_PROBE_LOG_LINE);
    expect(syntheticTraceEmitted(log, TID)).toBe(true);
    // No "otel trace" line: a later doctor run must never read an old probe as real OTel work.
    expect(log).not.toMatch(/otel trace|OTel trace/);
  });

  // RED CONTROLS: a real two-tool turn still mints; a near-miss of the probe is ordinary work.
  it('a real two-tool turn, and a trace that only resembles the probe, still mint', async () => {
    const real = buildSyntheticToolTrace(TID, 'r'.repeat(16), ['1'.repeat(16), '2'.repeat(16)], 1_700_000_000_000) as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string; attributes: Array<{ key: string; value: { stringValue: string } }> }> }> }>;
    };
    const spans = real.resourceSpans[0].scopeSpans[0].spans;
    spans[0].name = 'agent turn';
    const r1 = await run(real);
    expect(r1.pes).toHaveLength(1);
    expect(r1.log).not.toContain(DOCTOR_PROBE_LOG_LINE);
    expect(isDoctorProbeTrace('provian doctor synthetic turn', ['provian_doctor_probe_1', 'web_search'])).toBe(false);
    expect(isDoctorProbeTrace('provian doctor synthetic turn', ['provian_doctor_probe_1', 'provian_doctor_probe_2', 'shell'])).toBe(false);
    expect(isDoctorProbeTrace('Provian doctor synthetic turn', ['provian_doctor_probe_1', 'provian_doctor_probe_2'])).toBe(false);
    expect(isDoctorProbeTrace('provian doctor synthetic turn', ['provian_doctor_probe_2', 'provian_doctor_probe_1'])).toBe(true);
  });
});
