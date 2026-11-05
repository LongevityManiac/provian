/**
 * The Archive never deletes, replaces or composes an object (PE Archive human-path run, 2026-10-07).
 *
 * Archive storage class bills 365 days for any object deleted or replaced early, so every object is
 * written once. Pinned three ways: a scan of every Archive source for any delete / compose / rewrite
 * / move / copy call (with a RED control proving the scanner sees one), the store's method surface,
 * and the Cloud Storage adapter's create call (create-only precondition, server-checked MD5,
 * client validation off because on a mismatch it would delete the object).
 */
import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { createGcsArchiveObjectStore, createMemoryArchiveObjectStore, md5Base64 } from './archive-objects';

const ARCHIVE_SOURCES = [
  path.resolve(__dirname, 'archive-objects.ts'),
  path.resolve(__dirname, 'archive-service.ts'),
  path.resolve(__dirname, 'archive-terms.ts'),
  path.resolve(__dirname, 'archive-runtime.ts'),
  path.resolve(__dirname, '../../routes/archive.ts'),
];

const REPLACING_CALL = /\.(delete|deleteFiles|recursiveDelete|combine|compose|rewrite|move|copy|setStorageClass)\(/;

function replacingCalls(text: string, label: string): string[] {
  const out: string[] = [];
  text.split('\n').forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
    if (REPLACING_CALL.test(code)) out.push(`${label}:${i + 1}:${line.trim()}`);
  });
  return out;
}

describe('the Archive writes each object once and never removes or replaces one', () => {
  it('no Archive source calls delete / combine / compose / rewrite / move / copy (scanned files > 0)', () => {
    let scanned = 0;
    const found: string[] = [];
    for (const file of ARCHIVE_SOURCES) {
      found.push(...replacingCalls(fs.readFileSync(file, 'utf8'), path.basename(file)));
      scanned += 1;
    }
    expect(scanned).toBe(ARCHIVE_SOURCES.length);
    expect(found).toEqual([]);
  });

  it('RED control: the scanner catches the calls the old layout made', () => {
    expect(replacingCalls('    await bucket.file(staging).delete({ ignoreNotFound: true });', 'x')).toHaveLength(1);
    expect(replacingCalls('    const [c] = await bucket.combine([path, staging], path);', 'x')).toHaveLength(1);
    expect(replacingCalls('    // bucket.combine is gone', 'x')).toHaveLength(0);
  });

  it('the store has no append, delete or compose method', () => {
    const store = createMemoryArchiveObjectStore() as unknown as Record<string, unknown>;
    for (const m of ['append', 'delete', 'remove', 'combine', 'compose', 'rewrite']) expect(store[m]).toBeUndefined();
    expect(typeof store.create).toBe('function');
  });

  it('create is create-only: a second create at the same path is refused and the first bytes stand', async () => {
    const store = createMemoryArchiveObjectStore();
    const first = await store.create('v2/w/2026-10-07/d.0.aa.pea', new Uint8Array([1, 0x0a]));
    expect(first.md5).toBe(md5Base64(new Uint8Array([1, 0x0a])));
    await expect(store.create('v2/w/2026-10-07/d.0.aa.pea', new Uint8Array([9, 0x0a]))).rejects.toThrow('archive_object_exists');
    expect(Array.from(store.objects.get('v2/w/2026-10-07/d.0.aa.pea')!.bytes)).toEqual([1, 0x0a]);
  });

  it('the Cloud Storage adapter creates with ifGenerationMatch 0, the MD5 in metadata, client validation off — one write, no extra read', async () => {
    const saves: { path: string; opts: Record<string, unknown> }[] = [];
    let metadataReads = 0;
    const fakeBucket = {
      file(p: string) {
        const f = {
          metadata: undefined as Record<string, unknown> | undefined,
          async save(_b: Buffer, opts: Record<string, unknown>) {
            saves.push({ path: p, opts });
            f.metadata = { size: '2', generation: '7', md5Hash: md5Base64(new Uint8Array([1, 0x0a])) };
          },
          async getMetadata() { metadataReads += 1; return [{ size: 2, generation: '7', md5Hash: md5Base64(new Uint8Array([1, 0x0a])) }]; },
        };
        return f;
      },
    };
    const store = createGcsArchiveObjectStore('b', fakeBucket as never);
    const stat = await store.create('v2/w/d/x.pea', new Uint8Array([1, 0x0a]));
    expect(saves).toHaveLength(1);
    expect(saves[0].opts.preconditionOpts).toEqual({ ifGenerationMatch: 0 });
    expect(saves[0].opts.validation).toBe(false);
    expect((saves[0].opts.metadata as Record<string, unknown>).md5Hash).toBe(md5Base64(new Uint8Array([1, 0x0a])));
    expect(stat).toEqual({ size: 2, generation: '7', md5: md5Base64(new Uint8Array([1, 0x0a])) });
    expect(metadataReads).toBe(0);
  });

  it('stat is ONE metadata GET and reads a 404 as absent (never exists() + getMetadata())', async () => {
    let calls = 0;
    const fakeBucket = {
      file(p: string) {
        return {
          async exists() { throw new Error('exists() must not be called'); },
          async getMetadata() {
            calls += 1;
            if (p.endsWith('missing.pea')) { const e = new Error('nf') as Error & { code: number }; e.code = 404; throw e; }
            return [{ size: '5', generation: '9', md5Hash: 'abc=' }];
          },
        };
      },
    };
    const store = createGcsArchiveObjectStore('b', fakeBucket as never);
    expect(await store.stat('v2/w/d/missing.pea')).toBeNull();
    expect(await store.stat('v2/w/d/x.pea')).toEqual({ size: 5, generation: '9', md5: 'abc=' });
    expect(calls).toBe(2);
  });

  it('the adapter turns a precondition failure into archive_object_exists (never an overwrite)', async () => {
    const fakeBucket = {
      file() {
        return { async save() { const e = new Error('precondition') as Error & { code: number }; e.code = 412; throw e; } };
      },
    };
    const store = createGcsArchiveObjectStore('b', fakeBucket as never);
    await expect(store.create('v2/w/d/x.pea', new Uint8Array([1]))).rejects.toThrow('archive_object_exists');
  });
});
