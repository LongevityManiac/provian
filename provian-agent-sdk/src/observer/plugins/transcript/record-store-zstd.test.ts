/**
 * OpenClaw 2026.9.x stores many transcript rows zstd-compressed (`event_zstd`, `event_json` NULL).
 * The reader decodes them, and every row carries its seq even when it cannot be decoded — so a
 * cursor moves past it and a seed at the end counts it (the 2026-10-07 re-read began with a seed
 * that stopped at the last plain row). RED: an older store without the column still reads.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { readRecordsAfter, readRecordsAfterMulti, sqliteAvailability } from './record-store';
const RECORD_TABLE = {table:'transcript_events',jsonColumn:'event_json',seqColumn:'seq',sessionColumn:'session_id',createdAtColumn:'created_at',zstdJsonColumn:'event_zstd'};

const zstd = (zlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync;
const can = sqliteAvailability().available && typeof zstd === 'function';

function makeDb(withZstd: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-zstd-'));
  const file = path.join(dir, 'agent.sqlite');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (p: string) => { exec(s: string): void; prepare(s: string): { run(...a: unknown[]): void }; close(): void } };
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, created_at INTEGER${withZstd ? ', event_zstd BLOB' : ''})`);
  const ins = db.prepare(withZstd
    ? 'INSERT INTO transcript_events (session_id, seq, event_json, created_at, event_zstd) VALUES (?, ?, ?, ?, ?)'
    : 'INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)');
  ins.run(...['s1', 0, '{"n":0}', 1_791_000_000_000, ...(withZstd ? [null] : [])]);
  if (withZstd) {
    ins.run('s1', 1, null, 1_791_000_000_001, zstd!(Buffer.from('{"n":1}')));
    ins.run('s1', 2, null, 1_791_000_000_002, Buffer.from('not zstd'));
  }
  db.close();
  return file;
}

describe.skipIf(!can)('record-store reads zstd-compressed rows', () => {
  it('decodes event_zstd; an undecodable row keeps its seq with empty text', () => {
    const file = makeDb(true);
    const rows = readRecordsAfter(file, RECORD_TABLE, 's1', -1, 10);
    expect(rows.map((r) => [r.seq, r.json])).toEqual([[0, '{"n":0}'], [1, '{"n":1}'], [2, '']]);
    const multi = readRecordsAfterMulti(file, RECORD_TABLE, new Map([['s1', 0]]), 10).get('s1')!;
    expect(multi.map((r) => r.seq)).toEqual([1, 2]);
  });

  it('RED control: a store without the column reads as before', () => {
    const file = makeDb(false);
    expect(readRecordsAfter(file, RECORD_TABLE, 's1', -1, 10).map((r) => r.json)).toEqual(['{"n":0}']);
  });
});
