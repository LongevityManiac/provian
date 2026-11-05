/**
 * The file-backed PE Archive pull-back cache: atomic writes, a size cap that evicts the oldest
 * cached days, and eviction that never reaches anything but its own `.pea` files. Each guard ships
 * its RED beside it.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { archiveCacheKey, defaultArchiveCacheDir, FileArchiveObjectCache } from './archive-cache';
import { defaultPeStoreRoot } from './pe-store';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'archive-cache-'));
}

function bytes(n: number, fill: number): Uint8Array {
  return new Uint8Array(n).fill(fill);
}

function setMtime(file: string, ms: number): void {
  fs.utimesSync(file, new Date(ms), new Date(ms));
}

describe('FileArchiveObjectCache', () => {
  it('names the file <wallet>__<day>.pea with unsafe characters replaced, and round-trips the bytes', async () => {
    const dir = tmp();
    const cache = new FileArchiveObjectCache(dir);
    const key = archiveCacheKey('aw_x/../y:z', '2026-10-01');
    expect(path.basename(cache.fileFor(key))).toBe('aw_x_.._y_z__2026-10-01.pea');
    expect(path.dirname(cache.fileFor(key))).toBe(dir);
    expect(await cache.get(key)).toBeNull();
    await cache.put(key, bytes(10, 7));
    expect(await cache.get(key)).toEqual(bytes(10, 7));
  });

  it('writes atomically: no temp file is left, and a stray temp file is never read as the object', async () => {
    const dir = tmp();
    const cache = new FileArchiveObjectCache(dir);
    const key = archiveCacheKey('aw_a', '2026-10-01');
    // RED: a half-written temp file beside a missing object is a miss, not a hit.
    fs.writeFileSync(`${cache.fileFor(key)}.${process.pid}.tmp`, 'half');
    expect(await cache.get(key)).toBeNull();
    await cache.put(key, bytes(5, 1));
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    await cache.put(key, bytes(6, 2)); // replaced whole
    expect(await cache.get(key)).toEqual(bytes(6, 2));
  });

  it('evicts the oldest-mtime .pea files past the cap, keeps the newest, and touches nothing else in the directory', async () => {
    const dir = tmp();
    const cache = new FileArchiveObjectCache(dir, 250);
    const k = (d: string): string => archiveCacheKey('aw_e', d);
    await cache.put(k('2026-10-01'), bytes(100, 1));
    await cache.put(k('2026-10-02'), bytes(100, 2));
    setMtime(cache.fileFor(k('2026-10-01')), Date.UTC(2026, 0, 1));
    setMtime(cache.fileFor(k('2026-10-02')), Date.UTC(2026, 0, 2));
    // Foreign files, older than everything and large: not the cache's, never evicted.
    fs.writeFileSync(path.join(dir, 'notes.txt'), bytes(1000, 9));
    fs.writeFileSync(path.join(dir, 'x.pea.tmp'), bytes(1000, 9));
    fs.mkdirSync(path.join(dir, 'sub.pea'));
    for (const n of ['notes.txt', 'x.pea.tmp']) setMtime(path.join(dir, n), Date.UTC(2020, 0, 1));
    // A neighbouring directory's .pea is outside this cache entirely.
    const outside = path.join(path.dirname(dir), `${path.basename(dir)}-neighbour.pea`);
    fs.writeFileSync(outside, bytes(1000, 9));
    setMtime(outside, Date.UTC(2020, 0, 1));

    await cache.put(k('2026-10-03'), bytes(100, 3)); // 300 > 250: the oldest cached day goes
    expect(await cache.get(k('2026-10-01'))).toBeNull();
    expect(await cache.get(k('2026-10-02'))).toEqual(bytes(100, 2));
    expect(await cache.get(k('2026-10-03'))).toEqual(bytes(100, 3));
    expect(fs.existsSync(path.join(dir, 'notes.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'x.pea.tmp'))).toBe(true);
    expect(fs.statSync(path.join(dir, 'sub.pea')).isDirectory()).toBe(true);
    expect(fs.existsSync(outside)).toBe(true);
    fs.unlinkSync(outside);
  });

  it('RED: under the cap nothing is evicted; a hit refreshes recency so the least recently USED day goes first', async () => {
    const dir = tmp();
    const cache = new FileArchiveObjectCache(dir, 250);
    const k = (d: string): string => archiveCacheKey('aw_r', d);
    await cache.put(k('2026-10-01'), bytes(100, 1));
    await cache.put(k('2026-10-02'), bytes(100, 2));
    expect(fs.readdirSync(dir).sort()).toHaveLength(2); // 200 <= 250
    setMtime(cache.fileFor(k('2026-10-01')), Date.UTC(2026, 0, 1));
    setMtime(cache.fileFor(k('2026-10-02')), Date.UTC(2026, 0, 2));
    expect(await cache.get(k('2026-10-01'))).not.toBeNull(); // used now
    await cache.put(k('2026-10-03'), bytes(100, 3));
    expect(await cache.get(k('2026-10-01'))).not.toBeNull();
    expect(await cache.get(k('2026-10-02'))).toBeNull();
  });

  it('an object larger than the whole cap is not kept and evicts nothing', async () => {
    const dir = tmp();
    const cache = new FileArchiveObjectCache(dir, 50);
    await cache.put(archiveCacheKey('aw_b', '2026-10-01'), bytes(40, 1));
    await cache.put(archiveCacheKey('aw_b', '2026-10-02'), bytes(60, 2));
    expect(await cache.get(archiveCacheKey('aw_b', '2026-10-02'))).toBeNull();
    expect(await cache.get(archiveCacheKey('aw_b', '2026-10-01'))).toEqual(bytes(40, 1));
  });

  it('lives beside the PE store, never inside it', () => {
    const root = defaultPeStoreRoot({}, '/home/agent');
    expect(root).toBe(path.join('/home/agent', '.provian', 'pe-store'));
    const dir = defaultArchiveCacheDir(root);
    expect(dir).toBe(path.join('/home/agent', '.provian', 'archive-cache'));
    expect(path.relative(root, dir).startsWith('..')).toBe(true);
  });
});
