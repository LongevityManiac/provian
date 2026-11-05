/**
 * provian-config — minimal shared reader/writer for `~/.provian/config.json`.
 *
 * The read/write semantics: missing or malformed config is treated as absent
 * (`{}`), writes are 0o700 dir / 0o600 file, 2-space JSON + trailing newline.
 * This is the ONE implementation of the `~/.provian/config.json` file
 * semantics — every consumer routes through it: the newer TranscriptPlugin and
 * `configure --watch-transcripts`, and (as of the tool-turn pass) the two
 * originally-private copies, scripts/llm-session-consent.ts and
 * LLMSessionPlugin.resolveConfig, which formerly hand-rolled the same IO. No
 * private copy remains (the findRedeclaredLiterals discipline).
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';

export const PROVIAN_CONFIG_PATH = path.join(homedir(), '.provian', 'config.json');

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Missing or malformed config reads as `{}` — never throws. */
export function readProvianConfig(configPath: string = PROVIAN_CONFIG_PATH): Record<string, unknown> {
  if (!fs.existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 0o700 dir / 0o600 file, 2-space JSON + trailing newline (consent-module parity). */
export function writeProvianConfig(
  configPath: string,
  config: Record<string, unknown>,
): void {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

/**
 * Read a string[] under the `capture` sub-object (e.g. `capture.transcript_roots`).
 * Non-arrays and non-string entries read as absent — never throws.
 */
export function captureStringArray(cfg: Record<string, unknown>, key: string): string[] {
  const capture = cfg.capture;
  if (!isRecord(capture)) return [];
  const v = capture[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

/** Merge a string[] under `capture.<key>`, preserving sibling keys (consent-module shape). */
export function writeCaptureStringArray(
  configPath: string,
  key: string,
  values: string[],
): void {
  const cfg = readProvianConfig(configPath);
  const capture = isRecord(cfg.capture) ? { ...cfg.capture } : {};
  capture[key] = values;
  cfg.capture = capture;
  writeProvianConfig(configPath, cfg);
}
