/**
 * harness-otel-config — the second witness, and the content-capture fence.
 *
 * The fence gets a control of its own because it is the one property here that
 * is a privacy commitment rather than a capability: content capture must be
 * written OFF explicitly, and must stay off even if the existing config asked
 * for it.
 */

import { describe, it, expect } from 'vitest';
import { mergeOtelConfig, enableOpenClawOtel, type OtelConfigIO } from './harness-otel-config';

function io(files: Record<string, string>): OtelConfigIO & { files: Record<string, string> } {
  return {
    files,
    read: (p) => files[p] ?? null,
    write: (p, c) => { files[p] = c; },
    copy: (from, to) => { files[to] = files[from]; },
    exists: (p) => p in files,
  };
}

const CFG = '/home/a/.openclaw/openclaw.json';

describe('mergeOtelConfig', () => {
  it('THE ATLAS STATE — an endpoint set but no exporter: enables traces', () => {
    const { next, changed } = mergeOtelConfig({ env: { vars: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' } } });
    expect(changed).toBe(true);
    const d = next.diagnostics as Record<string, Record<string, unknown>>;
    expect(d.otel.enabled).toBe(true);
    expect(d.otel.traces).toBe(true);
  });

  it('THE FENCE — captureContent is written explicitly false, never left to a default', () => {
    const { next } = mergeOtelConfig({});
    const d = next.diagnostics as Record<string, Record<string, unknown>>;
    expect(d.otel.captureContent).toBe(false);
  });

  it('THE FENCE, adversarial — a config asking for content capture has it turned OFF', () => {
    const { next, changed } = mergeOtelConfig({
      diagnostics: { otel: { enabled: true, traces: true, captureContent: true } },
    });
    expect(changed).toBe(true);
    const d = next.diagnostics as Record<string, Record<string, unknown>>;
    expect(d.otel.captureContent).toBe(false);
  });

  it('preserves every unrelated key — this is a merge, not a rewrite', () => {
    const original = {
      env: { vars: { OTEL_SERVICE_NAME: 'openclaw' } },
      plugins: { entries: { browser: { enabled: true } } },
      agents: { defaults: { heartbeat: { isolatedSession: true } } },
    };
    const { next } = mergeOtelConfig(original);
    expect(next.env).toEqual(original.env);
    expect(next.plugins).toEqual(original.plugins);
    expect(next.agents).toEqual(original.agents);
  });

  it('re-enables diagnostics when it was explicitly switched off', () => {
    const { next } = mergeOtelConfig({ diagnostics: { enabled: false } });
    const d = next.diagnostics as Record<string, unknown>;
    expect(d.enabled).toBe(true);
  });

  it('NEGATIVE CONTROL — an already-correct config is left alone (idempotent)', () => {
    const already = { diagnostics: { otel: { enabled: true, traces: true, captureContent: false } } };
    const { next, changed } = mergeOtelConfig(already);
    expect(changed).toBe(false);
    expect(next).toBe(already); // same object: nothing rewritten
  });
});

describe('enableOpenClawOtel', () => {
  it('backs the file up before touching it, and writes valid JSON', () => {
    const f = io({ [CFG]: JSON.stringify({ plugins: { entries: {} } }) });
    const out = enableOpenClawOtel('/home/a', f);
    expect(out.changed).toBe(true);
    expect(out.backupPath).toBe(`${CFG}.provian-bak`);
    expect(f.files[`${CFG}.provian-bak`]).toBe(JSON.stringify({ plugins: { entries: {} } }));
    const written = JSON.parse(f.files[CFG]) as Record<string, Record<string, Record<string, unknown>>>;
    expect(written.diagnostics.otel.enabled).toBe(true);
    expect(written.plugins).toBeDefined();
  });

  it('NEGATIVE CONTROL — no OpenClaw on this machine is a stated reason, not a crash', () => {
    const out = enableOpenClawOtel('/home/a', io({}));
    expect(out.changed).toBe(false);
    expect(out.reason).toBe('no_config');
  });

  it('NEGATIVE CONTROL — malformed JSON is reported, never overwritten', () => {
    const f = io({ [CFG]: '{ this is not json' });
    const out = enableOpenClawOtel('/home/a', f);
    expect(out.changed).toBe(false);
    expect(out.reason).toBe('unreadable');
    // The agent's config is untouched — we do not "fix" a file we cannot parse.
    expect(f.files[CFG]).toBe('{ this is not json');
  });

  it('running twice changes nothing the second time', () => {
    const f = io({ [CFG]: JSON.stringify({}) });
    expect(enableOpenClawOtel('/home/a', f).changed).toBe(true);
    const after = f.files[CFG];
    const second = enableOpenClawOtel('/home/a', f);
    expect(second.changed).toBe(false);
    expect(second.reason).toBe('already_enabled');
    expect(f.files[CFG]).toBe(after);
  });
});
