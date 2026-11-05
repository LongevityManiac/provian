/**
 * PE METER — one-time migration of the legacy v1 PE outbox (`~/.provian/pe-outbox`,).
 *
 * Entries still queued there at upgrade were never accepted by the relay; they must not be lost.
 * Each is converted into a PE v2 appended to this device's store (a fresh pe_id, timestamp =
 * now), under the entry's own idempotency key — so a migration interrupted by a crash and run
 * again appends nothing twice. Then the outbox directory is retired by renaming it to
 * `<dir>.migrated` (nothing is deleted; `rejected/` entries, which the relay had already judged,
 * stay inside it untouched).
 *
 * The directory is first renamed to `<dir>.migrating` rename is atomic, so of two processes that
 * start at once exactly one takes the migration.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { PeOutboxEntry } from '../pe-outbox';
import { peContentFromV1Body, type PeV2Content } from './pe-builder';

export type MigrationRecordOutcome = 'recorded' | 'replay' | 'refused' | 'failed';

export interface OutboxMigrationReport {
  readonly migrated: number;
  readonly replayed: number;
  readonly skipped: number;
  /** True when a transient failure left `<dir>.migrating` for the next start. */
  readonly incomplete: boolean;
  readonly retiredTo: string | null;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** The key an outbox entry is migrated under: its own, or a deterministic one from its file id. */
export function migrationKeyOf(entry: Pick<PeOutboxEntry, 'id' | 'idempotency_key'>): string {
  if (typeof entry.idempotency_key === 'string' && IDEMPOTENCY_KEY.test(entry.idempotency_key)) return entry.idempotency_key;
  return `mig_${createHash('sha256').update(String(entry.id)).digest('hex').slice(0, 40)}`;
}

export async function migrateLegacyOutbox(input: {
  readonly outboxDir: string;
  readonly record: (content: PeV2Content, idempotencyKey: string) => Promise<MigrationRecordOutcome>;
  readonly log?: (msg: string) => void;
}): Promise<OutboxMigrationReport> {
  const log = input.log ?? (() => undefined);
  const migrating = `${input.outboxDir}.migrating`;
  if (!isDir(migrating)) {
    if (!isDir(input.outboxDir)) return { migrated: 0, replayed: 0, skipped: 0, incomplete: false, retiredTo: null };
    fs.renameSync(input.outboxDir, migrating);
  }
  let names: string[];
  try { names = fs.readdirSync(migrating); } catch { names = []; }
  let migrated = 0;
  let replayed = 0;
  let skipped = 0;
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    let entry: PeOutboxEntry;
    try {
      entry = JSON.parse(fs.readFileSync(path.join(migrating, name), 'utf8')) as PeOutboxEntry;
    } catch {
      skipped += 1;
      continue;
    }
    const content = entry && typeof entry.body === 'object' && entry.body !== null ? peContentFromV1Body(entry.body) : null;
    if (content === null) {
      skipped += 1;
      continue;
    }
    const outcome = await input.record(content, migrationKeyOf(entry));
    if (outcome === 'recorded') migrated += 1;
    else if (outcome === 'replay') replayed += 1;
    else if (outcome === 'refused') skipped += 1;
    else {
      log(`legacy PE outbox migration paused (${migrated} moved so far); it resumes on the next start`);
      return { migrated, replayed, skipped, incomplete: true, retiredTo: null };
    }
  }
  let retiredTo = `${input.outboxDir}.migrated`;
  if (fs.existsSync(retiredTo)) retiredTo = `${retiredTo}-${Date.now()}`;
  fs.renameSync(migrating, retiredTo);
  if (migrated + replayed + skipped > 0) {
    log(`legacy PE outbox migrated: ${migrated} queued PE(s) now kept in this machine's PE store`
      + `${skipped > 0 ? ` (${skipped} unreadable entr${skipped === 1 ? 'y' : 'ies'} left in place)` : ''}; the old queue is at ${retiredTo}`);
  }
  return { migrated, replayed, skipped, incomplete: false, retiredTo };
}
