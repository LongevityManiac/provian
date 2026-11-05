import { describe, it, expect } from 'vitest';
import { parseArgs, resolveActivePlugins } from './run-daemon';

const DEFAULTS = ['process', 'process_lane', 'git', 'otel', 'transcript', 'llm', 'llm_session'];
const NO_INFERENCE = { hasLlmLog: false, localInferenceDetected: false };

describe('resolveActivePlugins (owner + prerequisite gating, pure)', () => {
  it('the daemon DEFAULT plugin list now includes llm (the producer is on by default, gated by detection)', () => {
    expect(parseArgs([]).plugins).toEqual(DEFAULTS);
  });

  it('agent device on macOS: every default except llm_session (transcript + process_lane included; llm on when a runtime is detected)', () => {
    const set = resolveActivePlugins(DEFAULTS, { ownerType: 'agent', platform: 'darwin', hasLlmLog: false, localInferenceDetected: true });
    expect([...set].sort()).toEqual(['git', 'otel', 'process', 'process_lane', 'transcript']);
  });

  // the foreground AI-app observer is not part of the agent
  // path. On an agent's machine it would record a human's or a computer-use
  // agent's foreground screen time as the agent's work (wrong PE author), so an
  // agent device never runs it — on either platform that ships the helper, and
  // even when --plugins names it explicitly. A human device keeps it.
  describe('llm_session never runs on an agent device', () => {
    for (const platform of ['darwin', 'win32']) {
      it(`agent on ${platform}: dropped from the defaults and from an explicit --plugins list`, () => {
        expect(resolveActivePlugins(DEFAULTS, { ownerType: 'agent', platform, ...NO_INFERENCE }).has('llm_session')).toBe(false);
        expect(resolveActivePlugins(['llm_session'], { ownerType: 'agent', platform, ...NO_INFERENCE }).size).toBe(0);
      });

      // RED control: the same inputs with a HUMAN owner keep llm_session, so the
      // agent assertions above are the owner gate, not the plugin missing from
      // the input or unsupported on the platform.
      it(`RED: human on ${platform} keeps llm_session for the same inputs`, () => {
        expect(resolveActivePlugins(DEFAULTS, { ownerType: 'human', platform, ...NO_INFERENCE }).has('llm_session')).toBe(true);
        expect([...resolveActivePlugins(['llm_session'], { ownerType: 'human', platform, ...NO_INFERENCE })]).toEqual(['llm_session']);
      });
    }
  });

  it('human device: tool lanes OFF (incl. the process lane); git/llm_session remain', () => {
    const set = resolveActivePlugins(DEFAULTS, { ownerType: 'human', platform: 'darwin', ...NO_INFERENCE });
    expect(set.has('transcript')).toBe(false);   // agent-only
    expect(set.has('otel')).toBe(false);         // ← still agent-only
    expect(set.has('process')).toBe(false);      // ← still agent-only
    expect(set.has('process_lane')).toBe(false); // ← the command witness is agent-only
    expect(set.has('git')).toBe(true);
    expect(set.has('llm_session')).toBe(true);
  });

  it('RED: all tool lanes remain agent-device-only (incl. the process lane)', () => {
    const human = resolveActivePlugins(DEFAULTS, { ownerType: 'human', platform: 'darwin', localInferenceDetected: true, hasLlmLog: true });
    expect(human.has('process')).toBe(false);
    expect(human.has('process_lane')).toBe(false);
    expect(human.has('otel')).toBe(false);
    const agent = resolveActivePlugins(DEFAULTS, { ownerType: 'agent', platform: 'darwin', localInferenceDetected: true, hasLlmLog: true });
    expect(agent.has('process')).toBe(true);
    expect(agent.has('process_lane')).toBe(true);
    expect(agent.has('otel')).toBe(true);
  });

  // the process lane is the ONLY lane that can witness an agent on linux with no session
  // files, no model proxy and no OTel (Grok Bot / Muse). It must survive on an agent linux box.
  it('agent on linux keeps process_lane (the command witness for a VM with no other lane)', () => {
    const set = resolveActivePlugins(DEFAULTS, { ownerType: 'agent', platform: 'linux', ...NO_INFERENCE });
    expect(set.has('process_lane')).toBe(true);
    // RED control: the same linux box owned by a HUMAN never runs it.
    const human = resolveActivePlugins(DEFAULTS, { ownerType: 'human', platform: 'linux', ...NO_INFERENCE });
    expect(human.has('process_lane')).toBe(false);
  });

  describe('llm — zero-config local inference (the human-lane producer)', () => {
    it('stays ON with NO env var when a local runtime is detected, on a HUMAN device', () => {
      const set = resolveActivePlugins(DEFAULTS, { ownerType: 'human', platform: 'darwin', hasLlmLog: false, localInferenceDetected: true });
      expect(set.has('llm')).toBe(true);
    });

    it('stays OFF with NO env var when a local runtime is detected, on an AGENT device', () => {
      const set = resolveActivePlugins(DEFAULTS, { ownerType: 'agent', platform: 'linux', hasLlmLog: false, localInferenceDetected: true });
      expect(set.has('llm')).toBe(false);
    });

    it('stays ON when PROVIAN_LLM_LOG is set (the original JSONL source), even with no runtime detected', () => {
      const set = resolveActivePlugins(DEFAULTS, { ownerType: 'human', platform: 'darwin', hasLlmLog: true, localInferenceDetected: false });
      expect(set.has('llm')).toBe(true);
    });

    // RED CONTROL for the gate: with NEITHER signal the plugin is deleted —
    // exactly the pre-fix state on every installed daemon (no env var, and
    // before this change no probe existed, so `llm` never survived here).
    it('RED: deleted when there is neither a detected runtime nor PROVIAN_LLM_LOG', () => {
      const human = resolveActivePlugins(DEFAULTS, { ownerType: 'human', platform: 'darwin', ...NO_INFERENCE });
      expect(human.has('llm')).toBe(false);
      const agent = resolveActivePlugins(DEFAULTS, { ownerType: 'agent', platform: 'darwin', ...NO_INFERENCE });
      expect(agent.has('llm')).toBe(false);
    });
  });

  it('human Linux local inference remains witnessed while native foreground and tools stay off',()=>{
    const set=resolveActivePlugins(DEFAULTS,{ownerType:'human',platform:'linux',hasLlmLog:false,localInferenceDetected:true});
    expect(set.has('llm')).toBe(true);expect(set.has('llm_session')).toBe(false);expect(set.has('transcript')).toBe(false);expect(set.has('otel')).toBe(false);
    expect(resolveActivePlugins(DEFAULTS,{ownerType:'agent',platform:'linux',hasLlmLog:false,localInferenceDetected:true}).has('llm')).toBe(false);
  });

  it('llm_session is darwin/win32 only', () => {
    const linux = resolveActivePlugins(DEFAULTS, { ownerType: 'human', platform: 'linux', ...NO_INFERENCE });
    expect(linux.has('llm_session')).toBe(false);
    expect(linux.has('transcript')).toBe(false); // transcript is platform-agnostic
    const win = resolveActivePlugins(DEFAULTS, { ownerType: 'human', platform: 'win32', ...NO_INFERENCE });
    expect(win.has('llm_session')).toBe(true);
  });

  it('respects an explicit --plugins subset (no resurrection of unrequested plugins)', () => {
    const set = resolveActivePlugins(['transcript'], { ownerType: 'agent', platform: 'darwin', hasLlmLog: true, localInferenceDetected: true });
    expect([...set]).toEqual(['transcript']);
  });
});
