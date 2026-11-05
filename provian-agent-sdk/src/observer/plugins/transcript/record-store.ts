/**
 * record-store — reading JSON transcript records out of a SQLite table.
 *
 * WHY THIS EXISTS (2026-09-07, the Atlas outage): OpenClaw 2026.8.2 moved its
 * session transcripts from `sessions/<uuid>.jsonl` files into a SQLite table,
 * `transcript_events(session_id, seq, event_json, created_at)`. The record
 * format did NOT change — `event_json` holds exactly the line the JSONL file
 * used to hold — but the watcher's discovery layer only understood files, so
 * capture went silently to zero for five days.
 *
 * The lesson encoded here: a container change must never be able to look like
 * "no work happened". A store is a cursor over JSON records; whether those
 * records live in a file (cursor = byte offset) or a table (cursor = row seq)
 * is a detail below the extractor, which is reused byte-for-byte either way.
 *
 * READ-ONLY, ALWAYS. The agent's harness owns this database and is writing to
 * it live, usually in WAL mode. We open read-only and never write, never
 * migrate, never checkpoint, never hold a transaction open across ticks. A
 * watcher that can damage the agent's own state is not a passive witness.
 *
 * NO NATIVE DEPENDENCY. The SDK ships as a single bundled file with no
 * `npm install` on the target machine, so `better-sqlite3` (a native addon) is
 * not available to us. We use Node's built-in `node:sqlite`, which is present
 * from Node 22.5 and stable from Node 24. On an older runtime the module is
 * absent — and that is REPORTED as an unreadable source, never swallowed. See
 * `sqliteAvailability()`; the plugin turns it into a visible zero-sources
 * verdict rather than silence.
 */

import * as fs from 'fs';
import * as zlib from 'zlib';

/** One transcript record plus the cursor position it was read at. */
export interface StoredRecord {
  /**
   * The raw JSON text — handed to `extractLine()` unchanged. Empty when the row holds a record this
   * runtime cannot decode (it still carries its `seq`, so a cursor moves past it and a seed at the
   * end counts it).
   */
  json: string;
  /** Monotonic per-session cursor (the table's `seq`). */
  seq: number;
  /** Row insert time in epoch ms, when the table carries one. */
  createdAtMs: number | null;
}

export interface SqliteAvailability {
  available: boolean;
  /** Why not, in one plain sentence — surfaced in the zero-sources verdict. */
  reason?: string;
}

/**
 * Whether this runtime can read a SQLite store at all.
 *
 * Deliberately a probe rather than a version comparison: `node:sqlite` moved
 * from experimental to stable across releases and is compiled out of some
 * builds, so asking the runtime is the only honest answer.
 */
export function sqliteAvailability(): SqliteAvailability {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('node:sqlite') as { DatabaseSync?: unknown };
    if (typeof mod?.DatabaseSync !== 'function') {
      return { available: false, reason: 'this Node build has no node:sqlite DatabaseSync' };
    }
    return { available: true };
  } catch {
    return {
      available: false,
      reason: 'node:sqlite is unavailable (needs Node 22.5+); the harness keeps its transcripts in a database this runtime cannot open',
    };
  }
}

/** Columns a table must have to be usable as a transcript record store. */
export interface RecordTableSpec {
  table: string;
  /** Column holding the JSON record text. */
  jsonColumn: string;
  /** Monotonic cursor column, unique within a session. */
  seqColumn: string;
  /** Column partitioning rows into sessions. */
  sessionColumn: string;
  /** Optional epoch column (ms or s) used for observed-time carry. */
  createdAtColumn?: string;
  /**
   * Optional column holding the record zstd-compressed (BLOB) when `jsonColumn` is NULL. OpenClaw
   * 2026.9.x stores a large share of its rows this way; read only when the table has the column.
   */
  zstdJsonColumn?: string;
}

type ZstdDecompress = (buf: Uint8Array) => Buffer;

/** Node's zstd decoder (Node 22.15+ / 23.8+), or null on a runtime without one. */
function zstdDecoder(): ZstdDecompress | null {
  const fn = (zlib as unknown as { zstdDecompressSync?: ZstdDecompress }).zstdDecompressSync;
  return typeof fn === 'function' ? fn : null;
}

/** The record text of one row: its JSON column, else its decompressed zstd column, else ''. */
function recordText(r: Record<string, unknown>, spec: RecordTableSpec, zstdCol: string | null): string {
  const json = r[spec.jsonColumn];
  if (typeof json === 'string') return json;
  if (zstdCol === null) return '';
  const blob = r[zstdCol];
  const decode = zstdDecoder();
  if (decode === null || !(blob instanceof Uint8Array)) return '';
  try { return decode(blob).toString('utf8'); } catch { return ''; }
}

/** The spec's zstd column when this table actually has it (older stores do not). */
function presentZstdColumn(db: DatabaseHandle, spec: RecordTableSpec): string | null {
  if (!spec.zstdJsonColumn) return null;
  try {
    const rows = db.prepare(`PRAGMA table_info(${quoteIdent(spec.table)})`).all() as Array<{ name?: unknown }>;
    return rows.some((c) => c.name === spec.zstdJsonColumn) ? spec.zstdJsonColumn : null;
  } catch {
    return null;
  }
}

function quoteIdent(name: string): string {
  // Identifiers come from the validated machine-local description and
  // already matched a strict [A-Za-z0-9_]+ pattern, but interpolation into SQL
  // is never done on trust alone.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`unsafe SQL identifier: ${name}`);
  }
  return `"${name}"`;
}

/** Epoch column tolerated as ms or seconds, matching the extractor's rule. */
export function normalizeEpoch(v: unknown): number | null {
  if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v)) { const parsed = Date.parse(v); return Number.isFinite(parsed) && parsed > 0 ? parsed : null; }
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  if (v >= 1e11) return Math.floor(v);
  if (v >= 1e8) return Math.floor(v * 1000);
  return null;
}

interface DatabaseHandle {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}

function openReadOnly(dbPath: string): DatabaseHandle {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (p: string, o?: Record<string, unknown>) => DatabaseHandle;
  };
  return new DatabaseSync(dbPath, { readOnly: true });
}

/**
 * Open, run `fn`, always close. A connection is never held across ticks: the
 * harness may checkpoint, vacuum, or rotate its WAL between our reads, and a
 * long-lived read connection is exactly what stalls a WAL checkpoint for the
 * process we are supposed to be invisible to.
 */
export function withReadOnlyDb<T>(dbPath: string, fn: (db: DatabaseHandle) => T): T {
  const db = openReadOnly(dbPath);
  try {
    return fn(db);
  } finally {
    try { db.close(); } catch { /* closing a read-only handle cannot lose data */ }
  }
}

/** True when the file exists and carries the SQLite magic header. */
export function looksLikeSqlite(p: string): boolean {
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(16);
      const n = fs.readSync(fd, buf, 0, 16, 0);
      return n === 16 && buf.toString('utf-8', 0, 15) === 'SQLite format 3';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** Every table in the database (best-effort; [] when unreadable). */
export function listTables(dbPath: string): string[] {
  try {
    return withReadOnlyDb(dbPath, (db) => {
      const rows = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table'",
      ).all() as Array<{ name?: unknown }>;
      return rows
        .map((r) => (typeof r.name === 'string' ? r.name : null))
        .filter((n): n is string => n !== null);
    });
  } catch {
    return [];
  }
}

/** Column names of one table (best-effort; [] when unreadable). */
export function listColumns(dbPath: string, table: string): string[] {
  try {
    return withReadOnlyDb(dbPath, (db) => {
      const rows = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{ name?: unknown }>;
      return rows
        .map((r) => (typeof r.name === 'string' ? r.name : null))
        .filter((n): n is string => n !== null);
    });
  } catch {
    return [];
  }
}

/** Session ids present in a record table, with each one's highest cursor. */
export function listSessions(
  dbPath: string,
  spec: RecordTableSpec,
): Array<{ sessionId: string; maxSeq: number }> {
  return withReadOnlyDb(dbPath, (db) => {
      const sql =
        `SELECT ${quoteIdent(spec.sessionColumn)} AS sid, MAX(${quoteIdent(spec.seqColumn)}) AS mx ` +
        `FROM ${quoteIdent(spec.table)} GROUP BY ${quoteIdent(spec.sessionColumn)}`;
      const rows = db.prepare(sql).all() as Array<{ sid?: unknown; mx?: unknown }>;
      const out: Array<{ sessionId: string; maxSeq: number }> = [];
      for (const r of rows) {
        if (typeof r.sid !== 'string') continue;
        const mx = typeof r.mx === 'number' ? r.mx : Number(r.mx);
        out.push({ sessionId: r.sid, maxSeq: Number.isFinite(mx) ? mx : 0 });
      }
      return out;
    });
}

/**
 * Records for MANY sessions of one database, on a SINGLE connection.
 *
 * WHY THIS EXISTS: `readRecordsAfter` opens and closes the database per call.
 * That is right for one read, and catastrophic for a fleet of sessions — the
 * OpenClaw store on a working agent held 291 of them, so a per-session read on
 * the observer's 1 s tick meant ~291 opens per second against a 758 MB database
 * the harness is writing to live. Measured cost: the daemon went from ~0.1 % CPU
 * to ~18 %. A passive witness that taxes the machine it observes is not passive,
 * and contending with the harness's own WAL is exactly what "a watcher can never
 * break the agent" forbids.
 *
 * One open, N cheap indexed queries, one close.
 */
export function readRecordsAfterMulti(
  dbPath: string,
  spec: RecordTableSpec,
  cursors: ReadonlyMap<string, number>,
  limit: number,
): Map<string, StoredRecord[]> {
  const out = new Map<string, StoredRecord[]>();
  if (cursors.size === 0) return out;
  return withReadOnlyDb(dbPath, (db) => {
    const zstdCol = presentZstdColumn(db, spec);
    const cols = [quoteIdent(spec.seqColumn), quoteIdent(spec.jsonColumn)];
    if (spec.createdAtColumn) cols.push(quoteIdent(spec.createdAtColumn));
    if (zstdCol) cols.push(quoteIdent(zstdCol));
    const sql =
      `SELECT ${cols.join(', ')} FROM ${quoteIdent(spec.table)} ` +
      `WHERE ${quoteIdent(spec.sessionColumn)} = ? AND ${quoteIdent(spec.seqColumn)} > ? ` +
      `ORDER BY ${quoteIdent(spec.seqColumn)} ASC LIMIT ?`;
    const stmt = db.prepare(sql);
    for (const [sessionId, afterSeq] of cursors) {
      const rows = stmt.all(sessionId, afterSeq, limit) as Array<Record<string, unknown>>;
      if (rows.length === 0) continue;
      const recs: StoredRecord[] = [];
      for (const r of rows) {
        const seq = r[spec.seqColumn];
        if (typeof seq !== 'number') continue;
        recs.push({
          json: recordText(r, spec, zstdCol),
          seq,
          createdAtMs: spec.createdAtColumn ? normalizeEpoch(r[spec.createdAtColumn]) : null,
        });
      }
      if (recs.length > 0) out.set(sessionId, recs);
    }
    return out;
  });
}

/**
 * Records for one session strictly after `afterSeq`, in cursor order.
 *
 * `limit` bounds a single pull so a session that grew by thousands of rows
 * between ticks cannot stall the observer loop; the remainder arrives on the
 * next tick because the cursor advanced.
 */
export function readRecordsAfter(
  dbPath: string,
  spec: RecordTableSpec,
  sessionId: string,
  afterSeq: number,
  limit: number,
): StoredRecord[] {
  return withReadOnlyDb(dbPath, (db) => {
    const zstdCol = presentZstdColumn(db, spec);
    const cols = [quoteIdent(spec.seqColumn), quoteIdent(spec.jsonColumn)];
    if (spec.createdAtColumn) cols.push(quoteIdent(spec.createdAtColumn));
    if (zstdCol) cols.push(quoteIdent(zstdCol));
    const sql =
      `SELECT ${cols.join(', ')} FROM ${quoteIdent(spec.table)} ` +
      `WHERE ${quoteIdent(spec.sessionColumn)} = ? AND ${quoteIdent(spec.seqColumn)} > ? ` +
      `ORDER BY ${quoteIdent(spec.seqColumn)} ASC LIMIT ?`;
    const rows = db.prepare(sql).all(sessionId, afterSeq, limit) as Array<Record<string, unknown>>;
    const out: StoredRecord[] = [];
    for (const r of rows) {
      const seq = r[spec.seqColumn];
      if (typeof seq !== 'number') continue;
      out.push({
        json: recordText(r, spec, zstdCol),
        seq,
        createdAtMs: spec.createdAtColumn ? normalizeEpoch(r[spec.createdAtColumn]) : null,
      });
    }
    return out;
  });
}
