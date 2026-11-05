/**
 * PE ARCHIVE PULL-BACK CACHE — one pull-back serves repeated use (: "opening or
 * presenting the same archived day repeatedly must not re-fetch it each time").
 *
 * Every read of an Archive-class object pays retrieval plus egress, and each CLI call / daemon
 * restart builds a fresh keeper, so the in-memory map alone re-fetched the same day again and
 * again. This cache keeps the day object exactly as the relay served it: NDJSON of sealed parts,
 * ciphertext sealed to the owner — the same bytes the Archive holds. Opening it still needs the
 * owner's key; nothing opened is ever written here.
 *
 * It lives OUTSIDE the PE store (a sibling `archive-cache/`), because the store never deletes a PE
 * and this directory is bounded: its oldest `.pea` files are evicted. Losing any of them costs one
 * re-fetch, never a PE.
 */

import * as fs from 'fs';
import * as path from 'path';

export const DEFAULT_ARCHIVE_CACHE_MAX_BYTES = 256 * 1024 * 1024;
const CACHE_SUFFIX = '.pea';

/** Raw day objects keyed `${wallet}/${day}`. A miss or a read failure is `null`, never a throw. */
export interface ArchiveObjectCache {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
}

export function archiveCacheKey(wallet: string, day: string): string {
  return `${wallet}/${day}`;
}

/** The cache beside the PE store root: `<root's parent>/archive-cache` (`~/.provian/archive-cache`). */
export function defaultArchiveCacheDir(peStoreRoot: string): string {
  return path.join(path.dirname(path.resolve(peStoreRoot)), 'archive-cache');
}

export class MemoryArchiveObjectCache implements ArchiveObjectCache {
  readonly objects = new Map<string, Uint8Array>();

  async get(key: string): Promise<Uint8Array | null> {
    const hit = this.objects.get(key);
    return hit === undefined ? null : new Uint8Array(hit);
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.objects.set(key, new Uint8Array(bytes));
  }
}

function safeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, '_');
}

export class FileArchiveObjectCache implements ArchiveObjectCache {
  constructor(readonly dir: string, readonly maxBytes: number = DEFAULT_ARCHIVE_CACHE_MAX_BYTES) {}

  /** `<wallet>__<day>.pea`, every character outside [A-Za-z0-9_.-] replaced. */
  fileFor(key: string): string {
    const slash = key.lastIndexOf('/');
    const name = slash < 0 ? safeSegment(key) : `${safeSegment(key.slice(0, slash))}__${safeSegment(key.slice(slash + 1))}`;
    return path.join(this.dir, `${name}${CACHE_SUFFIX}`);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const file = this.fileFor(key);
    try {
      const bytes = new Uint8Array(fs.readFileSync(file));
      // A hit is recent use: eviction takes the least recently used day first.
      try { const now = new Date(); fs.utimesSync(file, now, now); } catch { /* read-only is fine */ }
      return bytes;
    } catch {
      return null;
    }
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    if (bytes.length > this.maxBytes) return; // one object larger than the whole cache is not kept
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = this.fileFor(key);
    // Write then rename: a reader never sees a half-written object (a torn one would only cost a re-fetch).
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, bytes, { mode: 0o600 });
    fs.renameSync(tmp, file);
    this.evict(file);
  }

  /** Oldest `.pea` files in this directory go first until the total fits; nothing else is touched. */
  private evict(keep: string): void {
    let names: string[];
    try { names = fs.readdirSync(this.dir); } catch { return; }
    const files: { file: string; size: number; mtimeMs: number }[] = [];
    for (const name of names) {
      if (!name.endsWith(CACHE_SUFFIX)) continue;
      const file = path.join(this.dir, name);
      try {
        const st = fs.lstatSync(file);
        if (st.isFile()) files.push({ file, size: st.size, mtimeMs: st.mtimeMs });
      } catch { /* raced with another process */ }
    }
    let total = files.reduce((sum, f) => sum + f.size, 0);
    if (total <= this.maxBytes) return;
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const f of files) {
      if (total <= this.maxBytes) break;
      if (f.file === keep) continue;
      try { fs.unlinkSync(f.file); total -= f.size; } catch { /* already gone */ }
    }
  }
}
