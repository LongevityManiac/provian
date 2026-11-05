/**
 * grok-home — where Grok Build lives on this machine, whether it is installed,
 * and the removal of the RETIRED Provian hook file (`~/.grok/hooks/provian.json`).
 *
 * Grok is
 * witnessed like every other harness, by exactly one lane — its session files if
 * it keeps them, otherwise the model proxy, otherwise OTel, otherwise, on
 * the agent's own machine, the process lane. The installer no longer writes the hook
 * file; an installed daemon removes the one an earlier daemon wrote at its next
 * start (a self-update's re-exec supplies one), and uninstall removes it too.
 *
 * OWNERSHIP. Removal touches the file ONLY when it is Provian's: it carries the
 * top-level `_provian` marker object, or (a marker stripped by hand) every
 * handler in it is a loopback `/v1/hooks/grok` http hook or the Provian
 * daemon-start command. A user's own `provian.json` with foreign content is
 * reported, never deleted. Nothing else under `~/.grok/hooks` is read or written.
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';

/** The retired hook file an earlier daemon wrote. */
export const GROK_HOOK_FILENAME = 'provian.json';
/** The marker key every Provian-written hook file carried. */
export const GROK_HOOK_MARKER_KEY = '_provian';

export function grokHomeDir(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const override = typeof env.GROK_HOME === 'string' ? env.GROK_HOME.trim() : '';
  return override.length > 0 ? override : path.join(home, '.grok');
}

/** Where the retired Provian hook file sat. */
export function grokHookFilePath(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  return path.join(grokHomeDir(home, env), 'hooks', GROK_HOOK_FILENAME);
}

export interface GrokDetectIO {
  isDir(p: string): boolean;
  isFile(p: string): boolean;
}

const realDetectIO: GrokDetectIO = {
  isDir: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
  isFile: (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } },
};

/**
 * Is Grok Build installed here? `~/.grok` exists, or its binary is at
 * `~/.grok/bin/grok`, or a `grok` executable is on PATH. Never throws.
 */
export function detectGrok(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  io: GrokDetectIO = realDetectIO,
): boolean {
  const grokHome = grokHomeDir(home, env);
  if (io.isDir(grokHome)) return true;
  if (io.isFile(path.join(grokHome, 'bin', 'grok'))) return true;
  const pathVar = env.PATH ?? env.Path ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  for (const dir of pathVar.split(sep)) {
    if (!dir) continue;
    if (io.isFile(path.join(dir, 'grok')) || io.isFile(path.join(dir, 'grok.exe'))) return true;
  }
  return false;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Is this parsed file Provian's? True when it carries the Provian marker, OR
 * (a marker stripped by hand) every handler in it is a loopback `/v1/hooks/grok`
 * http hook or the Provian daemon-start command. A file with any foreign
 * handler is NOT ours.
 */
export function isProvianGrokHookFile(parsed: unknown): boolean {
  if (!isRecord(parsed)) return false;
  const marker = parsed[GROK_HOOK_MARKER_KEY];
  if (isRecord(marker) && marker.managed_by === 'provian') return true;
  const hooks = parsed.hooks;
  if (!isRecord(hooks)) return false;
  let handlers = 0;
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) return false;
    for (const g of groups) {
      if (!isRecord(g) || !Array.isArray(g.hooks)) return false;
      for (const h of g.hooks) {
        if (!isRecord(h)) return false;
        handlers += 1;
        const url = typeof h.url === 'string' ? h.url : '';
        const loopback = h.type === 'http' && /^http:\/\/127\.0\.0\.1:\d+\/v1\/hooks\/grok$/.test(url);
        // The ensure-running command or the detached restart command an earlier
        // daemon wrote — both Provian's.
        const daemonStart = h.type === 'command' && typeof h.command === 'string'
          && (h.command.includes('observe --ensure-running') || h.command.includes('observe --if-not-running'));
        if (!loopback && !daemonStart) return false;
      }
    }
  }
  return handlers > 0;
}

export interface GrokHookIO {
  read(p: string): string | null;
  remove(p: string): void;
}

export const realGrokHookIO: GrokHookIO = {
  read: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } },
  remove: (p) => { try { fs.unlinkSync(p); } catch { /* already gone */ } },
};

export type GrokHookRemoval = 'removed' | 'absent' | 'foreign' | 'error';

/**
 * Remove the retired Provian Grok hook file — only when it is ours. `error`
 * when it is ours and still there after the attempt. Never throws.
 */
export function removeGrokHooks(opts: { home?: string; env?: NodeJS.ProcessEnv; io?: GrokHookIO } = {}): GrokHookRemoval {
  try {
    const io = opts.io ?? realGrokHookIO;
    const file = grokHookFilePath(opts.home, opts.env);
    const have = io.read(file);
    if (have === null) return 'absent';
    let parsed: unknown = null;
    try { parsed = JSON.parse(have); } catch { parsed = null; }
    if (!isProvianGrokHookFile(parsed)) return 'foreign';
    io.remove(file);
    return io.read(file) === null ? 'removed' : 'error';
  } catch {
    return 'error';
  }
}
