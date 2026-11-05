/**
 * pe-outbox — a durable, file-backed queue for device PE submissions the relay
 * did not accept (, requirement B).
 *
 * THE DEFECT THIS CLOSES (§3). A device-mode submit that failed — relay
 * unreachable, a proxy dropped the connection, a 5xx, a 429 — was logged and
 * DROPPED (the device submit returned null, the observer moved on).
 * On a box whose egress is a forward proxy or an approval-gated sandbox, that is
 * every PE produced while egress is down.
 *
 * THE CONTRACT.
 * - A submission that did not reach an ACCEPT or a definite REJECT is written
 * here, one JSON file per PE, atomically (temp + rename, 0600), BEFORE the
 * caller is told it failed.
 * - The entry holds the LOGICAL body and the submission's idempotency key, not
 * the signed wire bytes: a Secure Enclave envelope expires after 300 s and a
 * hardware witness binds a fresh nonce, so every retry is re-signed. The
 * idempotency key is what makes the retry safe — the relay commits a key
 * together with the PE it created and answers a replay with that PE, so a
 * submit whose response was lost can never become a second PE.
 * - The daemon drains the queue (oldest first, one at a time, exponential
 * backoff per entry, capped at five minutes; everything goes at once as soon
 * as one submit is accepted). An entry leaves the queue ONLY when
 * the relay accepts it, or when the relay REJECTS its content (a 4xx that a
 * retry can never turn into an accept) — and a rejected entry is moved to
 * `rejected/` with the relay's reason, never deleted.
 * - Mint-once never depends on this queue: the relay's own keys (turn id,
 * commit, occurrence) still decide what mints; the queue only stops the
 * RECORD from being lost.
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';

export function defaultPeOutboxDir(home: string = homedir()): string {
  return path.join(home, '.provian', 'pe-outbox');
}

export interface PeOutboxEntry {
  v: 1;
  /** File stem; sortable by creation time. */
  id: string;
  /** The relay idempotency key this PE was first submitted under. Reused on every retry. */
  idempotency_key: string;
  /** The logical submit body (never signed bytes, never a credential). */
  body: Record<string, unknown>;
  created_at_ms: number;
  attempts: number;
  next_attempt_at_ms: number;
  last_status: number | null;
  last_error: string | null;
}

/** What the relay's answer means for a queued PE. */
export type SubmitDisposition = 'accepted' | 'retryable' | 'rejected';

/**
 * Classify one submit answer. `status` null = no HTTP answer at all (DNS,
 * connect, reset, timeout, a proxy that vanished) → retryable.
 *
 * Rejected = the relay judged the CONTENT and a retry cannot change that
 * (400 validation, 404, 413, 422). Everything else is retryable, including
 * 401/403/407: an auth answer can come from an intercepting proxy or a
 * credential mid-rotation, and a queued record is never thrown away on a
 * guess. A content-hash `duplicate` 409 means the relay already holds it →
 * accepted.
 */
export function classifySubmitAnswer(status: number | null, bodyText = ''): SubmitDisposition {
  if (status === null) return 'retryable';
  if (status >= 200 && status < 300) return 'accepted';
  if (status === 409) {
    return /"error"\s*:\s*"duplicate"/.test(bodyText) ? 'accepted' : 'retryable';
  }
  if (status === 400 || status === 404 || status === 413 || status === 422) return 'rejected';
  return 'retryable';
}

export const OUTBOX_BASE_BACKOFF_MS = 30_000;
/**
 * Five minutes: only the head entry is probed while the relay is unreachable
 * (a drain stops at the first transport failure), so the cap bounds how long a
 * queue can sit after egress returns with no new activity — one request per
 * five minutes while down. A live accept drains everything at once.
 */
export const OUTBOX_MAX_BACKOFF_MS = 5 * 60 * 1000;

export function outboxBackoffMs(attempts: number): number {
  const exp = Math.min(Math.max(attempts - 1, 0), 20);
  return Math.min(OUTBOX_BASE_BACKOFF_MS * 2 ** exp, OUTBOX_MAX_BACKOFF_MS);
}

/** A fresh relay idempotency key (canonical 16–128 chars: here 32 hex). */
export function newIdempotencyKey(): string {
  return `pe_${randomBytes(16).toString('hex')}`;
}

/** The minimal interface ProvianClient needs; the file-backed class implements it. */
export interface PeOutboxLike {
  enqueue(input: { body: Record<string, unknown>; idempotencyKey: string; status: number | null; error: string | null }): string;
  due(nowMs?: number): PeOutboxEntry[];
  recordFailure(entry: PeOutboxEntry, status: number | null, error: string | null, nowMs?: number): void;
  remove(entry: PeOutboxEntry): void;
  reject(entry: PeOutboxEntry, status: number, reason: string): void;
  size(): number;
}

export class PeOutbox implements PeOutboxLike {
  constructor(private readonly dir: string = defaultPeOutboxDir()) {}

  private ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  private fileFor(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private write(entry: PeOutboxEntry): void {
    this.ensureDir();
    const target = this.fileFor(entry.id);
    const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(entry));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
  }

  enqueue(input: { body: Record<string, unknown>; idempotencyKey: string; status: number | null; error: string | null }): string {
    const now = Date.now();
    const id = `${String(now).padStart(15, '0')}-${randomBytes(6).toString('hex')}`;
    this.write({
      v: 1,
      id,
      idempotency_key: input.idempotencyKey,
      body: input.body,
      created_at_ms: now,
      attempts: 1,
      next_attempt_at_ms: now + outboxBackoffMs(1),
      last_status: input.status,
      last_error: input.error ? input.error.slice(0, 300) : null,
    });
    return id;
  }

  private readAll(): PeOutboxEntry[] {
    let names: string[];
    try { names = fs.readdirSync(this.dir); } catch { return []; }
    const out: PeOutboxEntry[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue;
      try {
        const e = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')) as PeOutboxEntry;
        if (e && e.v === 1 && typeof e.idempotency_key === 'string' && e.body && typeof e.body === 'object') out.push(e);
      } catch { /* a torn temp file never has the.json suffix; skip anything unreadable */ }
    }
    return out;
  }

  due(nowMs: number = Date.now()): PeOutboxEntry[] {
    return this.readAll().filter((e) => e.next_attempt_at_ms <= nowMs);
  }

  size(): number {
    return this.readAll().length;
  }

  recordFailure(entry: PeOutboxEntry, status: number | null, error: string | null, nowMs: number = Date.now()): void {
    const attempts = entry.attempts + 1;
    this.write({
      ...entry,
      attempts,
      next_attempt_at_ms: nowMs + outboxBackoffMs(attempts),
      last_status: status,
      last_error: error ? error.slice(0, 300) : null,
    });
  }

  remove(entry: PeOutboxEntry): void {
    try { fs.unlinkSync(this.fileFor(entry.id)); } catch { /* already gone */ }
  }

  reject(entry: PeOutboxEntry, status: number, reason: string): void {
    const rejectedDir = path.join(this.dir, 'rejected');
    fs.mkdirSync(rejectedDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(rejectedDir, `${entry.id}.json`),
      JSON.stringify({ ...entry, rejected_status: status, rejected_reason: reason.slice(0, 500) }),
      { mode: 0o600 },
    );
    this.remove(entry);
  }
}
