import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Interface as ReadlineInterface } from 'readline';
import {
  runLLMSessionConsent,
  osc8,
  printPermissionDeepLinks,
  PERMISSION_DEEP_LINKS,
} from './llm-session-consent';

function tmpConfigPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-consent-test-'));
  return path.join(dir, 'config.json');
}

function writeConfig(p: string, obj: Record<string, unknown>): void {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj));
}

function readConfig(p: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

/**
 * Minimal readline double. Script one answer; `question()` resolves with it.
 */
function fakeReadline(scriptedAnswer: string): ReadlineInterface {
  let consumed = false;
  const rl: Partial<ReadlineInterface> = {
    question: ((_q: string, cb: (answer: string) => void) => {
      if (consumed) throw new Error('fakeReadline: question called twice');
      consumed = true;
      cb(scriptedAnswer);
    }) as ReadlineInterface['question'],
  };
  return rl as ReadlineInterface;
}

function collectOutput(): { lines: string[]; push: (s: string) => void } {
  const lines: string[] = [];
  return { lines, push: (s: string) => lines.push(s) };
}

// =======================================================================
// Existing decision pinning
// =======================================================================

describe('runLLMSessionConsent: existing decision', () => {
  it('returns already-enabled when config already has true', async () => {
    const p = tmpConfigPath();
    writeConfig(p, { capture: { llm_session_enabled: true } });
    const out = collectOutput();
    const result = await runLLMSessionConsent({
      configPath: p, isTTY: true, rl: fakeReadline('n'),
      println: out.push, warn: out.push,
    });
    expect(result).toEqual({ enabled: true, action: 'already-enabled', firstRun: false });
    expect(readConfig(p)).toEqual({ capture: { llm_session_enabled: true } });
  });

  it('returns already-disabled when config already has false', async () => {
    const p = tmpConfigPath();
    writeConfig(p, { capture: { llm_session_enabled: false } });
    const out = collectOutput();
    const result = await runLLMSessionConsent({
      configPath: p, isTTY: true, rl: fakeReadline('y'),
      println: out.push, warn: out.push,
    });
    expect(result).toEqual({ enabled: false, action: 'already-disabled', firstRun: false });
    expect(readConfig(p)).toEqual({ capture: { llm_session_enabled: false } });
  });

  it('treats presence of other capture keys as undecided for llm_session_enabled', async () => {
    const p = tmpConfigPath();
    writeConfig(p, { capture: { other_key: 'foo' } });
    const out = collectOutput();
    const result = await runLLMSessionConsent({
      configPath: p, isTTY: true, rl: fakeReadline('y'),
      println: out.push, warn: out.push,
    });
    expect(result.firstRun).toBe(true);
    expect(result.enabled).toBe(true);
    // Preserve unrelated keys.
    const cfg = readConfig(p);
    expect((cfg.capture as Record<string, unknown>).other_key).toBe('foo');
    expect((cfg.capture as Record<string, unknown>).llm_session_enabled).toBe(true);
  });
});

// =======================================================================
// First-run interactive
// =======================================================================

describe('runLLMSessionConsent: interactive', () => {
  it('accepts on Y and writes true', async () => {
    const p = tmpConfigPath();
    const out = collectOutput();
    const result = await runLLMSessionConsent({
      configPath: p, isTTY: true, rl: fakeReadline('y'),
      println: out.push, warn: out.push, platform: 'darwin',
    });
    expect(result).toEqual({ enabled: true, action: 'accepted', firstRun: true });
    expect(readConfig(p)).toEqual({ capture: { llm_session_enabled: true } });
    // Deep-link URLs are printed after accept on darwin.
    expect(out.lines.join('\n')).toContain(PERMISSION_DEEP_LINKS.accessibility);
    expect(out.lines.join('\n')).toContain(PERMISSION_DEEP_LINKS.inputMonitoring);
  });

  it('accepts on empty answer (default yes)', async () => {
    const p = tmpConfigPath();
    const out = collectOutput();
    const result = await runLLMSessionConsent({
      configPath: p, isTTY: true, rl: fakeReadline(''),
      println: out.push, warn: out.push, platform: 'darwin',
    });
    expect(result.enabled).toBe(true);
  });

  it('declines on n and writes false', async () => {
    const p = tmpConfigPath();
    const out = collectOutput();
    const result = await runLLMSessionConsent({
      configPath: p, isTTY: true, rl: fakeReadline('n'),
      println: out.push, warn: out.push, platform: 'darwin',
    });
    expect(result).toEqual({ enabled: false, action: 'declined', firstRun: true });
    expect(readConfig(p)).toEqual({ capture: { llm_session_enabled: false } });
    // Deep-link URLs NOT printed after decline.
    expect(out.lines.join('\n')).not.toContain(PERMISSION_DEEP_LINKS.accessibility);
  });

  it('does not print macOS deep-links on linux', async () => {
    const p = tmpConfigPath();
    const out = collectOutput();
    await runLLMSessionConsent({
      configPath: p, isTTY: true, rl: fakeReadline('y'),
      println: out.push, warn: out.push, platform: 'linux',
    });
    expect(out.lines.join('\n')).not.toContain(PERMISSION_DEEP_LINKS.accessibility);
  });
});

// =======================================================================
// First-run non-interactive (CI flag + fail-closed)
// =======================================================================

describe('runLLMSessionConsent: non-interactive', () => {
  it('auto-accepts with --skip-llm-session-consent flag', async () => {
    const p = tmpConfigPath();
    const out = collectOutput();
    const result = await runLLMSessionConsent({
      configPath: p, isTTY: false, skipFlag: true,
      println: out.push, warn: out.push, platform: 'darwin',
    });
    expect(result).toEqual({ enabled: true, action: 'auto-accepted', firstRun: true });
    expect(readConfig(p)).toEqual({ capture: { llm_session_enabled: true } });
  });

  it('fails closed (writes false) when non-TTY with no flag', async () => {
    const p = tmpConfigPath();
    const out = collectOutput();
    const result = await runLLMSessionConsent({
      configPath: p, isTTY: false, skipFlag: false,
      println: out.push, warn: out.push, platform: 'darwin',
    });
    expect(result).toEqual({ enabled: false, action: 'no-tty-declined', firstRun: true });
    expect(readConfig(p)).toEqual({ capture: { llm_session_enabled: false } });
  });

  it('throws when interactive mode requested without a readline', async () => {
    const p = tmpConfigPath();
    const out = collectOutput();
    await expect(
      runLLMSessionConsent({
        configPath: p, isTTY: true, println: out.push, warn: out.push,
      }),
    ).rejects.toThrow(/rl is required/);
  });
});

// =======================================================================
// Upgrade path: config exists but has no capture key
// =======================================================================

describe('runLLMSessionConsent: upgrade path', () => {
  it('runs consent when config has no capture section', async () => {
    const p = tmpConfigPath();
    writeConfig(p, { other_top_level: { a: 1 } });
    const out = collectOutput();
    const result = await runLLMSessionConsent({
      configPath: p, isTTY: true, rl: fakeReadline('y'),
      println: out.push, warn: out.push, platform: 'darwin',
    });
    expect(result.firstRun).toBe(true);
    expect(result.enabled).toBe(true);
    const cfg = readConfig(p);
    expect(cfg.other_top_level).toEqual({ a: 1 });
    expect((cfg.capture as Record<string, unknown>).llm_session_enabled).toBe(true);
  });

  it('treats malformed JSON as absent and creates fresh config on decline', async () => {
    const p = tmpConfigPath();
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, '{ not json');
    const out = collectOutput();
    const result = await runLLMSessionConsent({
      configPath: p, isTTY: true, rl: fakeReadline('n'),
      println: out.push, warn: out.push, platform: 'darwin',
    });
    expect(result.enabled).toBe(false);
    expect(result.action).toBe('declined');
    expect(readConfig(p)).toEqual({ capture: { llm_session_enabled: false } });
  });
});

// =======================================================================
// OSC-8 / deep-link helpers
// =======================================================================

describe('osc8', () => {
  it('wraps text with OSC-8 escape sequences', () => {
    const s = osc8('https://example.com', 'click here');
    expect(s).toBe('\x1b]8;;https://example.com\x1b\\click here\x1b]8;;\x1b\\');
  });
});

describe('printPermissionDeepLinks', () => {
  it('is a no-op on non-darwin', () => {
    const lines: string[] = [];
    printPermissionDeepLinks('linux', s => lines.push(s));
    expect(lines).toEqual([]);
  });

  it('prints both deep-links on darwin', () => {
    const lines: string[] = [];
    printPermissionDeepLinks('darwin', s => lines.push(s));
    const joined = lines.join('\n');
    expect(joined).toContain(PERMISSION_DEEP_LINKS.accessibility);
    expect(joined).toContain(PERMISSION_DEEP_LINKS.inputMonitoring);
  });
});
