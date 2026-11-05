/**
 * A day's download stops when its reader goes away (PE Archive human-path run, 2026-10-07; reviewer
 * defect 5). Each part's object is an Archive-class read that pays retrieval, so a client that
 * disconnects mid-download must not keep the relay reading the rest of the day.
 */
import { describe, it, expect } from '@jest/globals';
import { Readable } from 'stream';
import { openArchiveDayStream } from './archive-service';
import type { ArchiveObjectStore } from './archive-objects';

function slowStore(): { store: ArchiveObjectStore; opened: string[]; destroyed: string[] } {
  const opened: string[] = [];
  const destroyed: string[] = [];
  const store = {
    bucket: 'test',
    async stat() { return null; },
    async create() { throw new Error('unused'); },
    async readRange() { return new Uint8Array(0); },
    openRead(path: string): Readable {
      opened.push(path);
      let sent = 0;
      const r = new Readable({
        read() {
          // A long object: one line now, the rest trickling in.
          if (sent >= 50) { this.push(null); return; }
          sent += 1;
          setTimeout(() => this.push(Buffer.from(`${path}:${sent}\n`)), 2);
        },
      });
      r.on('close', () => { if (sent < 50) destroyed.push(path); });
      return r;
    },
  } as unknown as ArchiveObjectStore;
  return { store, opened, destroyed };
}

const DAY = {
  object_path: 'v1/w/2026-10-07.pea',
  parts: [
    { state: 'stored', object_path: 'v2/w/2026-10-07/d.0.a.pea' },
    { state: 'stored', object_path: 'v2/w/2026-10-07/d.1.b.pea' },
    { state: 'stored', object_path: 'v2/w/2026-10-07/d.2.c.pea' },
  ],
} as never;

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('openArchiveDayStream', () => {
  it('serves every part in order when read to the end (RED baseline: 3 objects opened)', async () => {
    const { store, opened } = slowStore();
    const chunks: string[] = [];
    for await (const c of openArchiveDayStream(store, DAY)) chunks.push(String(c));
    expect(opened).toEqual(['v2/w/2026-10-07/d.0.a.pea', 'v2/w/2026-10-07/d.1.b.pea', 'v2/w/2026-10-07/d.2.c.pea']);
    expect(chunks.join('').split('\n').filter(Boolean)).toHaveLength(150);
  });

  it('a reader that goes away stops the read: the open object is destroyed and no later part is opened', async () => {
    const { store, opened, destroyed } = slowStore();
    const out = openArchiveDayStream(store, DAY);
    out.on('error', () => undefined);
    out.once('data', () => out.destroy());
    out.resume();
    await tick(200);
    expect(opened).toEqual(['v2/w/2026-10-07/d.0.a.pea']);
    expect(destroyed).toEqual(['v2/w/2026-10-07/d.0.a.pea']);
  });
});
