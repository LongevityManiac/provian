/**
 * FootprintStore - Local SQLite Storage for Energy Entries
 *
 * All data stored on-device only (Provian stores NOTHING).
 * Mirrors the pattern from AI Footprint's db.ts using expo-sqlite.
 *
 * Drop into: src/core/footprint/FootprintStore.ts
 */

import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import type {
  FootprintEntry,
  FootprintSource,
  EnergyConfidence,
  EnergyEstimationMethod,
} from './types';

let db: SQLiteDatabase | null = null;

const getDatabase = async (): Promise<SQLiteDatabase> => {
  if (!db) {
    db = await openDatabaseAsync('provian_footprint.db');
  }
  return db;
};

// ─────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────

export async function initFootprintDB(): Promise<void> {
  const database = await getDatabase();

  await database.withExclusiveTransactionAsync(async (tx) => {
    await tx.execAsync(`
      CREATE TABLE IF NOT EXISTS footprint_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        source TEXT NOT NULL,
        total_wh REAL NOT NULL,
        confidence TEXT NOT NULL,
        method TEXT NOT NULL,
        char_count INTEGER,
        token_count INTEGER,
        image_count INTEGER,
        video_seconds INTEGER,
        envelope_id TEXT,
        action_type TEXT,
        provider_id TEXT,
        model_id TEXT,
        note TEXT,
        archived INTEGER DEFAULT 0
      );
    `);

    // Index for time-range queries
    await tx.execAsync(`
      CREATE INDEX IF NOT EXISTS idx_footprint_timestamp
      ON footprint_entries (timestamp)
      WHERE archived = 0;
    `);

    // Index for PE linkage lookups (deduplication)
    await tx.execAsync(`
      CREATE INDEX IF NOT EXISTS idx_footprint_envelope
      ON footprint_entries (envelope_id)
      WHERE envelope_id IS NOT NULL;
    `);
  });
}

// ─────────────────────────────────────────────────────────────────
// WRITE
// ─────────────────────────────────────────────────────────────────

export async function addEntry(
  entry: Omit<FootprintEntry, 'id'>
): Promise<FootprintEntry> {
  const database = await getDatabase();

  // Deduplicate: skip if we already have this envelope_id
  if (entry.envelopeId) {
    const existing = await database.getFirstAsync<{ id: number }>(
      'SELECT id FROM footprint_entries WHERE envelope_id = ? LIMIT 1;',
      entry.envelopeId
    );
    if (existing) {
      return { ...entry, id: existing.id.toString() };
    }
  }

  const result = await database.runAsync(
    `INSERT INTO footprint_entries
      (timestamp, source, total_wh, confidence, method,
       char_count, token_count, image_count, video_seconds,
       envelope_id, action_type, provider_id, model_id, note, archived)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    entry.timestamp,
    entry.source,
    entry.totalWh,
    entry.confidence,
    entry.method,
    entry.charCount ?? null,
    entry.tokenCount ?? null,
    entry.imageCount ?? null,
    entry.videoSeconds ?? null,
    entry.envelopeId ?? null,
    entry.actionType ?? null,
    entry.providerId ?? null,
    entry.modelId ?? null,
    entry.note ?? null,
    entry.archived ? 1 : 0
  );

  return { ...entry, id: result.lastInsertRowId.toString() };
}

// ─────────────────────────────────────────────────────────────────
// READ
// ─────────────────────────────────────────────────────────────────

interface RawRow {
  id: number;
  timestamp: number;
  source: string;
  total_wh: number;
  confidence: string;
  method: string;
  char_count: number | null;
  token_count: number | null;
  image_count: number | null;
  video_seconds: number | null;
  envelope_id: string | null;
  action_type: string | null;
  provider_id: string | null;
  model_id: string | null;
  note: string | null;
  archived: number;
}

function rowToEntry(row: RawRow): FootprintEntry {
  return {
    id: row.id.toString(),
    timestamp: row.timestamp,
    source: row.source as FootprintSource,
    totalWh: row.total_wh,
    confidence: row.confidence as EnergyConfidence,
    method: row.method as EnergyEstimationMethod,
    charCount: row.char_count ?? undefined,
    tokenCount: row.token_count ?? undefined,
    imageCount: row.image_count ?? undefined,
    videoSeconds: row.video_seconds ?? undefined,
    envelopeId: row.envelope_id ?? undefined,
    actionType: row.action_type ?? undefined,
    providerId: row.provider_id ?? undefined,
    modelId: row.model_id ?? undefined,
    note: row.note ?? undefined,
    archived: row.archived === 1,
  };
}

export async function getEntries(sinceTimestamp?: number): Promise<FootprintEntry[]> {
  const database = await getDatabase();

  const query = sinceTimestamp
    ? 'SELECT * FROM footprint_entries WHERE archived = 0 AND timestamp >= ? ORDER BY timestamp DESC;'
    : 'SELECT * FROM footprint_entries WHERE archived = 0 ORDER BY timestamp DESC;';

  const params = sinceTimestamp ? [sinceTimestamp] : [];
  const rows = await database.getAllAsync<RawRow>(query, ...params);
  return rows.map(rowToEntry);
}

export async function getTotalWh(sinceTimestamp?: number): Promise<number> {
  const database = await getDatabase();

  const query = sinceTimestamp
    ? 'SELECT SUM(total_wh) as total FROM footprint_entries WHERE archived = 0 AND timestamp >= ?;'
    : 'SELECT SUM(total_wh) as total FROM footprint_entries WHERE archived = 0;';

  const params = sinceTimestamp ? [sinceTimestamp] : [];
  const result = await database.getFirstAsync<{ total: number | null }>(query, ...params);
  return result?.total ?? 0;
}

export async function getEntryByEnvelopeId(envelopeId: string): Promise<FootprintEntry | null> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<RawRow>(
    'SELECT * FROM footprint_entries WHERE envelope_id = ? LIMIT 1;',
    envelopeId
  );
  return row ? rowToEntry(row) : null;
}

export async function getRecentEntries(limit: number = 20): Promise<FootprintEntry[]> {
  const database = await getDatabase();
  const rows = await database.getAllAsync<RawRow>(
    'SELECT * FROM footprint_entries WHERE archived = 0 ORDER BY timestamp DESC LIMIT ?;',
    limit
  );
  return rows.map(rowToEntry);
}

// ─────────────────────────────────────────────────────────────────
// DELETE / ARCHIVE
// ─────────────────────────────────────────────────────────────────

export async function archiveAllEntries(): Promise<void> {
  const database = await getDatabase();
  await database.runAsync('UPDATE footprint_entries SET archived = 1 WHERE archived = 0;');
}

export async function deleteAllEntries(): Promise<void> {
  const database = await getDatabase();
  await database.runAsync('DELETE FROM footprint_entries;');
}

export async function deleteEntry(id: string): Promise<void> {
  const database = await getDatabase();
  await database.runAsync('UPDATE footprint_entries SET archived = 1 WHERE id = ?;', parseInt(id));
}

// ─────────────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────────────

export const FootprintStore = {
  init: initFootprintDB,
  addEntry,
  getEntries,
  getTotalWh,
  getEntryByEnvelopeId,
  getRecentEntries,
  archiveAllEntries,
  deleteAllEntries,
  deleteEntry,
};
