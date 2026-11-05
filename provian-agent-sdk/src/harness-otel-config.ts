/**
 * harness-otel-config — the agent self-configures its OWN telemetry exporter.
 *
 * Background. Tool-call capture has two witnesses: the transcript watcher
 * (pull, zero harness cooperation) and OpenTelemetry spans (push). For OpenClaw
 * the push witness was believed live because
 * `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` was set in its config —
 * but an endpoint is an ADDRESS, not an exporter. OpenClaw ships a
 * `diagnostics-otel` exporter that is OFF unless `diagnostics.otel.enabled` is
 * exactly `true`, and it was never switched on. Five days of tool work reached
 * a receiver that was listening correctly to a process emitting nothing.
 *
 * This is not "modify the harness" — the standing rule against telling users to
 * patch third-party harness code still holds. This writes a documented CONFIG
 * key in the agent's own config file, which the agent is entitled to set for
 * itself, and it is what makes the second witness real.
 *
 * CONTENT CAPTURE IS OFF, ALWAYS. `captureContent: false` is written
 * explicitly rather than left to a default, because a default is something a
 * future release can change underneath us. Provian's whole capture discipline
 * is structure-only: names, counts, timestamps, error flags. Turning span
 * content capture on would put prompts and tool arguments into telemetry, and
 * no capture improvement is worth that.
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';

export const OPENCLAW_CONFIG = (home: string = homedir()): string =>
  path.join(home, '.openclaw', 'openclaw.json');

export interface OtelConfigOutcome {
  changed: boolean;
  /** Why nothing was changed, when nothing was. */
  reason?: 'already_enabled' | 'no_config' | 'unreadable' | 'unwritable';
  backupPath?: string;
  configPath: string;
}

/**
 * The desired shape, merged over whatever is already there.
 *
 * `diagnostics.enabled` must not be `false` and `diagnostics.otel.enabled` must
 * be exactly `true` for OpenClaw to construct the exporter; traces default on
 * once enabled. Everything else in the file is preserved untouched — this is a
 * merge, never a rewrite, because the file is the agent's whole configuration.
 */
export function mergeOtelConfig(cfg: Record<string, unknown>): {
  next: Record<string, unknown>;
  changed: boolean;
} {
  const diagnostics = isRecord(cfg.diagnostics) ? { ...cfg.diagnostics } : {};
  const otel = isRecord(diagnostics.otel) ? { ...diagnostics.otel } : {};

  const alreadyOn =
    diagnostics.enabled !== false &&
    otel.enabled === true &&
    otel.traces !== false &&
    otel.captureContent === false;
  if (alreadyOn) return { next: cfg, changed: false };

  otel.enabled = true;
  otel.traces = true;
  // Explicit, never defaulted. See the module docblock.
  otel.captureContent = false;
  if (diagnostics.enabled === false) diagnostics.enabled = true;
  diagnostics.otel = otel;
  return { next: { ...cfg, diagnostics }, changed: true };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export interface OtelConfigIO {
  read(p: string): string | null;
  write(p: string, content: string): void;
  copy(from: string, to: string): void;
  exists(p: string): boolean;
}

export const realOtelIO: OtelConfigIO = {
  read: (p) => { try { return fs.readFileSync(p, 'utf-8'); } catch { return null; } },
  write: (p, content) => {
    // Atomic: the harness reads this file at will and a torn write would break
    // the agent outright. Same-directory temp so the rename cannot cross devices.
    const tmp = `${p}.provian-tmp-${process.pid}`;
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, p);
  },
  copy: (from, to) => fs.copyFileSync(from, to),
  exists: (p) => { try { fs.statSync(p); return true; } catch { return false; } },
};

/**
 * Turn the OpenClaw OTel exporter on, idempotently, preserving the file.
 *
 * A backup is written first because this edits a file the agent depends on to
 * run at all; if anything about the merge were ever wrong, the operator has the
 * original beside it rather than a git-less regret.
 */
export function enableOpenClawOtel(
  home: string = homedir(),
  io: OtelConfigIO = realOtelIO,
): OtelConfigOutcome {
  const configPath = OPENCLAW_CONFIG(home);
  if (!io.exists(configPath)) return { changed: false, reason: 'no_config', configPath };
  const raw = io.read(configPath);
  if (raw === null) return { changed: false, reason: 'unreadable', configPath };

  let cfg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return { changed: false, reason: 'unreadable', configPath };
    cfg = parsed;
  } catch {
    return { changed: false, reason: 'unreadable', configPath };
  }

  const { next, changed } = mergeOtelConfig(cfg);
  if (!changed) return { changed: false, reason: 'already_enabled', configPath };

  const backupPath = `${configPath}.provian-bak`;
  try {
    io.copy(configPath, backupPath);
    io.write(configPath, `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    return { changed: false, reason: 'unwritable', configPath };
  }
  return { changed: true, backupPath, configPath };
}
