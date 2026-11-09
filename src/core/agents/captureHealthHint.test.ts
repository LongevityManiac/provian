/**
 * The "Not receiving work" hint : that agent's capture health and the line to
 * start its observer; the no-launcher state names its fix (follow-up), in all 12 locales.
 *
 * RED controls: the relay's reason set and this map must agree (a reason the relay sends with no line
 * here fails); an unknown string never reads as a reason; a locale missing a line fails.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { CAPTURE_BROKEN_REASONS, CAPTURE_HINT_LINE_KEYS, captureHealthHint } from './captureHealthHint';
import { AGENT_RECORD_LAUNCHER_CMD, AGENT_START_OBSERVER_CMD } from './agentShellCommands';

const localesDir = resolve(__dirname, '../../i18n/locales');
const localeFiles = readdirSync(localesDir).filter((f) => f.endsWith('.json'));
const get = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o);

describe('capture-health hint', () => {
  it('no launcher recorded: the warning, and the fix line "$HOME/.provian/bin/provian" process-lane record', () => {
    expect(captureHealthHint({ reason: 'process_no_launcher', reported: true }))
      .toEqual({ lineKey: 'agentHub.captureNoLauncher', fixCommand: AGENT_RECORD_LAUNCHER_CMD });
    expect(AGENT_RECORD_LAUNCHER_CMD).toBe('"$HOME/.provian/bin/provian" process-lane record');
  });

  it('RED: a computer with a launcher record (healthy, or another reason) does not show the no-launcher warning', () => {
    expect(captureHealthHint({ reason: null, reported: true }).lineKey).toBe('agentHub.captureHealthy');
    expect(captureHealthHint({ reason: 'process_lane_silence', reported: true }).lineKey).toBe('agentHub.captureProcessSilence');
  });

  it('RED: a session-file agent does not (its reasons are its own; no fix command)', () => {
    for (const r of ['no_readable_sources', 'sole_witness_silence', 'session_format_broken'] as const) {
      const h = captureHealthHint({ reason: r, reported: true });
      expect(h.lineKey).not.toBe('agentHub.captureNoLauncher');
      expect(h.fixCommand).toBeNull();
    }
  });

  it('no report yet, and unknown strings, never read as a reason', () => {
    expect(captureHealthHint({ reason: null, reported: false }).lineKey).toBe('agentHub.captureNoReport');
    expect(captureHealthHint({ reason: 'something_new', reported: true }).lineKey).toBe('agentHub.captureHealthy');
  });

  it(' (correction): no running program matching the recorded launcher, and a wrapper change the agent did not re-record, both name their state and offer the re-record line (RED: a session-file reason offers none)', () => {
    expect(captureHealthHint({ reason: 'process_launcher_not_seen', reported: true }))
      .toEqual({ lineKey: 'agentHub.captureLauncherNotSeen', fixCommand: AGENT_RECORD_LAUNCHER_CMD });
    expect(captureHealthHint({ reason: 'process_launcher_changed', reported: true }))
      .toEqual({ lineKey: 'agentHub.captureLauncherChanged', fixCommand: AGENT_RECORD_LAUNCHER_CMD });
    expect(captureHealthHint({ reason: 'session_format_broken', reported: true }).fixCommand).toBeNull();
  });

  it('every reason the relay sends has a line (mirrors routes/devices.ts)', () => {
    const relay = readFileSync(resolve(__dirname, '../../../provian-backend/src/routes/devices.ts'), 'utf8');
    const decl = relay.slice(relay.indexOf('const brokenReason:'), relay.indexOf('=', relay.indexOf('const brokenReason:')));
    const relayReasons = [...decl.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(relayReasons.length).toBe(8);
    expect([...CAPTURE_BROKEN_REASONS].sort()).toEqual(relayReasons);
  });

  it('every line and both send lines exist, translated, in all 12 locales', () => {
    expect(localeFiles).toHaveLength(12);
    const en = JSON.parse(readFileSync(resolve(localesDir, 'en.json'), 'utf8')) as unknown;
    const keys = [...CAPTURE_HINT_LINE_KEYS, 'agentHub.sendFixLine', 'agentHub.sendObserverLine', 'agentHub.copyLine',
      'agentHub.workingStoppedNoTime', 'agentHub.workingStopped', 'agentHub.workingEarning'];
    expect(keys.length).toBe(16);
    for (const file of localeFiles) {
      const json = JSON.parse(readFileSync(resolve(localesDir, file), 'utf8')) as unknown;
      for (const k of keys) {
        expect(typeof get(json, k), `${file} ${k}`).toBe('string');
        if (file !== 'en.json') expect(get(json, k), `${file} ${k}`).not.toBe(get(en, k));
      }
    }
  });

  it('the hint renders the health line and the observer line on both screens', () => {
    const comp = readFileSync(resolve(__dirname, '../../screens/Agent/AgentCaptureHealthHint.tsx'), 'utf8');
    expect(comp).toContain('t(hint.lineKey)');
    expect(comp).toContain("line(t('agentHub.sendObserverLine'), AGENT_START_OBSERVER_CMD)");
    expect(AGENT_START_OBSERVER_CMD).toBe('"$HOME/.provian/bin/provian" observe --if-not-running');
    for (const screen of ['AgentHubScreen.tsx', 'AgentDetailScreen.tsx']) {
      const src = readFileSync(resolve(__dirname, `../../screens/Agent/${screen}`), 'utf8');
      expect(src, screen).toContain('<AgentCaptureHealthHint');
      expect(src, screen).toMatch(/reason=\{[^}]*capture_broken_reason/);
      // The amber split is gone (the correction): no attention reason reaches either screen.
      expect(src, screen).not.toContain('attention');
      expect(src, screen).toContain('workingLine(');
    }
  });

  it('the format-changed line states the restart rule in all 12 locales: nothing to schedule with a service manager, cron or a startup file; a Grok Bot computer keeps its scheduled observe', () => {
    const lines = localeFiles.map((file) => [file, String(get(JSON.parse(readFileSync(resolve(localesDir, file), 'utf8')), 'agentHub.captureFormatBroken'))] as const);
    expect(lines).toHaveLength(12);
    for (const [file, line] of lines) {
      expect(line, file).toContain('Grok Bot');
      expect(line, file).toContain('provian observe --if-not-running');
      expect(line, file).toContain('cron');
    }
    const en = lines.find(([f]) => f === 'en.json')?.[1] ?? '';
    expect(en).toContain('On a machine with a service manager, cron or a startup file, nothing needs scheduling.');
    expect(en).toContain('On a Grok Bot computer, the agent keeps its scheduled provian observe --if-not-running');
    // RED: the earlier line, true only where a startup file is read, claimed nothing needs scheduling anywhere.
    const retired = "The agent's session format changed. The agent sees a notice on its next command, and in every provian command, telling it to describe the new format. Nothing needs scheduling.";
    expect(retired).not.toContain('Grok Bot');
    expect(en).not.toBe(retired);
    for (const [file, line] of lines) expect(line, file).not.toMatch(/Nothing needs scheduling\.$/);
  });
});
