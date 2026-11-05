/** One-time reversal of installer-owned endpoint lines left by retired releases. */
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { grokHomeDir } from './grok-home';
const GROK_PROXY_MARKER = '# provian-proxy';
const TABLE_HEADER = /^\s*\[\s*endpoints\s*\]\s*(#.*)?$/;
const ANY_HEADER = /^\s*\[/;
export function grokConfigPath(home = homedir(), env: NodeJS.ProcessEnv = process.env): string { return path.join(grokHomeDir(home, env), 'config.toml'); }
export function stripGrokRepoint(text: string): { next: string; changed: boolean } {
  const lines = text.split('\n');
  const out: string[] = [];
  let changed = false;
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if (TABLE_HEADER.test(l) && l.includes(GROK_PROXY_MARKER)) {
      // Our header: drop it only if every key line in its table is ours.
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j += 1) if (ANY_HEADER.test(lines[j])) { end = j; break; }
      const body = lines.slice(i + 1, end);
      const foreignKeys = body.filter((b) => /^\s*[A-Za-z0-9_.-]+\s*=/.test(b) && !b.includes(GROK_PROXY_MARKER));
      if (foreignKeys.length === 0) { changed = true; continue; }
      out.push(l.replace(/\s*# provian-proxy\s*$/, ''));
      changed = true;
      continue;
    }
    if (/^\s*(cli_chat_proxy_base_url|models_base_url)\s*=/.test(l) && l.includes(GROK_PROXY_MARKER)) {
      changed = true;
      continue;
    }
    out.push(l);
  }
  const next = out.join('\n').replace(/\n{3,}/g, '\n\n');
  return { next, changed };
}

export interface GrokConfigIO {
  read(p: string): string | null;
  writeAtomic(p: string, content: string): void;
  copy(from: string, to: string): void;
  /**
   * Can the config be rewritten in place? False when the file (or, for a
   * symlink, its target) or its directory is not writable, or a symlink dangles.
   * A missing file whose directory is writable (or creatable) is writable.
   */
  writable?(p: string): boolean;
}

/**
 * Where a write to `p` must land: the symlink's REAL target when `p` is a
 * symlink (a user who keeps ~/.grok/config.toml in a dotfiles repo keeps the
 * link), else `p` itself. Throws on a dangling link.
 */
export function grokConfigWriteTarget(p: string): string {
  let st: fs.Stats;
  try { st = fs.lstatSync(p); } catch { return p; } // missing → create it
  return st.isSymbolicLink() ? fs.realpathSync(p) : p;
}

/**
 * Atomic in-place rewrite that keeps the file what it was: a symlinked config
 * is resolved and its TARGET is replaced atomically (temp file in the target's
 * own directory + rename), so the link survives; the original file mode is
 * preserved (a new file is created 0600).
 */
export function writeGrokConfigAtomic(p: string, content: string): void {
  const target = grokConfigWriteTarget(p);
  let mode = 0o600;
  try { mode = fs.statSync(target).mode & 0o777; } catch { /* new file */ }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.provian-tmp-${process.pid}`);
  fs.writeFileSync(tmp, content, { mode });
  try { fs.chmodSync(tmp, mode); } catch { /* umask already applied the same bits */ }
  fs.renameSync(tmp, target);
}

export const realGrokConfigIO: GrokConfigIO = {
  read: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } },
  writeAtomic: writeGrokConfigAtomic,
  copy: (from, to) => {
    // Back up the CONTENT (a copy of the resolved target), never the link.
    try { fs.copyFileSync(grokConfigWriteTarget(from), to); } catch { /* no original to back up */ }
  },
  writable: (p) => {
    let target: string;
    try { target = grokConfigWriteTarget(p); } catch { return false; } // dangling link
    try {
      fs.accessSync(target, fs.constants.W_OK);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    // The rename lands in the target's directory: it must be writable (or not exist yet).
    let dir = path.dirname(target);
    while (!fs.existsSync(dir)) {
      const up = path.dirname(dir);
      if (up === dir) return false;
      dir = up;
    }
    try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; }
  },
};

/** Remove the repoint (uninstall / proxy opt-out). Never throws. */
export function unrepointGrok(opts: { home?: string; env?: NodeJS.ProcessEnv; io?: GrokConfigIO } = {}): 'removed' | 'absent' | 'error' {
  const io = opts.io ?? realGrokConfigIO;
  const configPath = grokConfigPath(opts.home, opts.env);
  try {
    const have = io.read(configPath);
    if (have === null) { return 'absent'; }
    const { next, changed } = stripGrokRepoint(have);
    if (!changed) { return 'absent'; }
    if (io.writable && !io.writable(configPath)) return 'error';
    io.writeAtomic(configPath, next);
    return 'removed';
  } catch {
    return 'error';
  }
}
