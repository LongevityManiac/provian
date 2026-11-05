/**
 * `npx @provian/agent-sdk doctor` — local inference surfacing (the human-lane producer).
 * Each scanner / check ships with the negative control that proves it can
 * say "no": a compute_session submit is not inference capture, an undetected
 * machine is not green, a running runtime with no log is RED with the exact
 * override to set.
 */
import { describe, it, expect } from 'vitest';
import { inferenceEmissionFromLog, localInferenceCheck, localInferenceReport } from './doctor';
import type { LocalInferenceProbe } from '../observer/plugins/local-inference/runtimes';

type Detection = LocalInferenceProbe['runtimes'][number];

function probeWith(over: Partial<Detection>, jsonl: string | null = null): LocalInferenceProbe {
  const ollama: Detection = {
    runtime: 'ollama', baseUrl: 'http://127.0.0.1:11434', reachable: false, installed: false,
    loadedModels: [], logPath: null, tokensObservable: false, ...over,
  };
  return { detected: ollama.reachable || ollama.installed || jsonl !== null, jsonlLogPath: jsonl, runtimes: [ollama] };
}

describe('inferenceEmissionFromLog', () => {
  it('green when the daemon submitted an inference_session PE', () => {
    const line = '[observer info] session PE submitted {"action_type":"inference_session","pe_id":"pe_i1","duration_ms":42000}';
    expect(inferenceEmissionFromLog(line)).toBe('green');
  });
  // NEGATIVE CONTROLS: a compute_session submit, a plugin PE, or an empty log
  // is NOT inference capture — never a false green.
  it('unknown for compute_session / plugin PEs / empty logs', () => {
    expect(inferenceEmissionFromLog('[observer info] session PE submitted {"action_type":"compute_session","pe_id":"pe_c"}')).toBe('unknown');
    expect(inferenceEmissionFromLog('[observer info] plugin PE submitted {"plugin":"git","action_type":"coding_session","pe_id":"pe_g"}')).toBe('unknown');
    expect(inferenceEmissionFromLog('')).toBe('unknown');
  });
});

describe('localInferenceCheck', () => {
  it('green: running AND its log is tailable', () => {
    const c = localInferenceCheck(probeWith({ reachable: true, installed: true, loadedModels: ['llama3.1:8b'], logPath: '/x/server.log' }));
    expect(c.status).toBe('green');
    expect(c.detail).toContain('ollama (running');
    expect(c.detail).toContain('inference_session');
  });
  it('RED: running but NO log found → red with the exact env override to set', () => {
    const c = localInferenceCheck(probeWith({ reachable: true, installed: true }));
    expect(c.status).toBe('red');
    expect(c.detail).toContain('PROVIAN_OLLAMA_LOG');
  });
  it('skip: installed but not running (login-order race) — says it will be witnessed once started', () => {
    const c = localInferenceCheck(probeWith({ installed: true }));
    expect(c.status).toBe('skip');
    expect(c.detail).toContain('installed, not running');
  });
  it('skip: nothing local at all', () => {
    const c = localInferenceCheck(probeWith({}));
    expect(c.status).toBe('skip');
    expect(c.detail).toMatch(/^none detected/);
  });
  it('green: a JSONL source alone is witnessable', () => {
    expect(localInferenceCheck(probeWith({}, '/tmp/inference.jsonl')).status).toBe('green');
  });
});

describe('localInferenceReport', () => {
  it('lists only detected runtimes and reports witnessability', () => {
    const r = localInferenceReport(probeWith({ reachable: true, installed: true, loadedModels: ['m'], logPath: '/l' }));
    expect(r.detected).toBe(true);
    expect(r.witnessable).toBe(true);
    expect(r.runtimes).toEqual([{ runtime: 'ollama', reachable: true, installed: true, models: ['m'], log: '/l' }]);
  });
  it('RED: an undetected machine reports detected=false, no runtimes, not witnessable', () => {
    const r = localInferenceReport(probeWith({}));
    expect(r.detected).toBe(false);
    expect(r.runtimes).toEqual([]);
    expect(r.witnessable).toBe(false);
    expect(r.summary).toMatch(/^none detected/);
  });
});
