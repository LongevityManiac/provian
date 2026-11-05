/**
 * The legacy PE outbox. the PE meter device mode no
 * longer submits single PEs, so nothing new is queued here; the file format and its pure answer
 * classifier remain because the daemon migrates any entries left at upgrade into the PE store
 * (`meter/migrate-outbox.ts`, tested in `meter/meter.test.ts`). The client-level outbox and
 * drain behaviour these suites once covered is replaced by the batcher's own suite.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PeOutbox, classifySubmitAnswer, outboxBackoffMs, OUTBOX_MAX_BACKOFF_MS } from './pe-outbox';

describe('classifySubmitAnswer', () => {
  it('no answer at all (proxy gone, reset, DNS) is retryable', () => {
    expect(classifySubmitAnswer(null)).toBe('retryable');
  });
  it('5xx, 429, 408, auth and proxy-auth answers are retryable — a record is never thrown away on a guess', () => {
    for (const s of [500, 502, 503, 504, 429, 408, 401, 403, 407]) expect(classifySubmitAnswer(s)).toBe('retryable');
  });
  it('content rejections are final', () => {
    for (const s of [400, 404, 413, 422]) expect(classifySubmitAnswer(s)).toBe('rejected');
  });
  it('a content-hash duplicate means the relay already holds it; chain contention is retryable', () => {
    expect(classifySubmitAnswer(409, '{"error":"duplicate"}')).toBe('accepted');
    expect(classifySubmitAnswer(409, '{"error":"chain_contention"}')).toBe('retryable');
  });
  it('backoff doubles from 30 s and caps at one hour', () => {
    expect(outboxBackoffMs(1)).toBe(30_000);
    expect(outboxBackoffMs(2)).toBe(60_000);
    expect(outboxBackoffMs(40)).toBe(OUTBOX_MAX_BACKOFF_MS);
  });
});

describe('PeOutbox file format (what the PE-meter migration reads)', () => {
  it('the backoff cap is five minutes', () => {
    expect(OUTBOX_MAX_BACKOFF_MS).toBe(5 * 60 * 1000);
    expect(outboxBackoffMs(40)).toBe(5 * 60 * 1000);
  });

  it('an enqueued entry is one 0600 JSON file carrying the logical body and its key; rejected entries move aside, never deleted', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-outbox-'));
    const outbox = new PeOutbox(dir);
    outbox.enqueue({ body: { action_type: 'coding_session' }, idempotencyKey: 'pe_' + 'c'.repeat(32), status: null, error: 'down' });
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(dir, files[0])).mode & 0o777).toBe(0o600);
    const [entry] = outbox.due(Number.MAX_SAFE_INTEGER);
    expect(entry.body).toEqual({ action_type: 'coding_session' });
    expect(entry.idempotency_key).toBe('pe_' + 'c'.repeat(32));
    outbox.reject(entry, 400, 'bad');
    expect(outbox.size()).toBe(0);
    expect(fs.readdirSync(path.join(dir, 'rejected'))).toHaveLength(1);
  });
});
