/**
 * bounded outbound reads. Every relay proxy read (Alchemy RPC, explorer,
 * swap quotes, Solana reads) goes through fetchBounded via server.ts
 * `fetchWithTimeout`. RED controls against a real local HTTP server:
 * - an upstream that sends headers promptly and then TRICKLES the body is aborted
 * by the wall-clock deadline (the old helper cleared its timer at the headers, so
 * the body read ran unbounded);
 * - an oversized body is aborted at the cap — the server sees the connection close
 * long before it could send everything (the old `.json()` buffered the lot).
 */
import { describe, it, expect, afterEach } from '@jest/globals';
import http from 'http';
import type { AddressInfo } from 'net';
import {
  fetchBounded,
  raceDeadline,
  startDeadline,
  DeadlineExceededError,
  ResponseTooLargeError,
} from './bounded-fetch';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

const servers: http.Server[] = [];
const timers: NodeJS.Timeout[] = [];

async function serve(handler: Handler): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

afterEach(async () => {
  while (timers.length) clearInterval(timers.pop());
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => {
    s.closeAllConnections();
    s.close(() => resolve());
  })));
});

/** Resolve to the outcome, or to 'still-open' if the call has not settled by `ms`. */
async function settleWithin<T>(p: Promise<T>, ms: number): Promise<{ value?: T; error?: unknown } | 'still-open'> {
  let sentinel: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p.then((value) => ({ value }), (error: unknown) => ({ error })),
      new Promise<'still-open'>((resolve) => { sentinel = setTimeout(() => resolve('still-open'), ms); }),
    ]);
  } finally {
    clearTimeout(sentinel);
  }
}

/** Headers at once, then one body byte every 50 ms forever — never idle, never done. */
const trickleBody: Handler = (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.write('[');
  timers.push(setInterval(() => res.write(' '), 50));
};

describe('fetchBounded — one deadline across connect + headers + body ', () => {
  it('RED: a body trickled under any idle timer is aborted by the wall-clock deadline', async () => {
    const url = await serve(trickleBody);
    const started = Date.now();
    const outcome = await settleWithin(
      fetchBounded(url, undefined, { deadlineMs: 400, maxBytes: 1024 * 1024 }).then((r) => r.json()),
      3000,
    );
    expect(outcome).not.toBe('still-open');
    expect((outcome as { error?: unknown }).error).toBeInstanceOf(DeadlineExceededError);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('headers that never complete are aborted by the same deadline', async () => {
    const url = await serve((req) => {
      req.socket.write('HTTP/1.1 200 OK\r\n');
      timers.push(setInterval(() => req.socket.write('X-Pad: a\r\n'), 50));
    });
    const outcome = await settleWithin(fetchBounded(url, undefined, { deadlineMs: 400, maxBytes: 1024 }), 3000);
    expect((outcome as { error?: unknown }).error).toBeInstanceOf(DeadlineExceededError);
  });

  it('RED: an oversized streamed body is aborted at the cap, never buffered whole', async () => {
    const TOTAL = 64 * 1024 * 1024;
    const CHUNK = Buffer.alloc(64 * 1024, 0x20);
    let sent = 0;
    let closed = false;
    const url = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }); // no content-length: streamed
      res.on('close', () => { closed = true; });
      const pump = (): void => {
        while (!closed && sent < TOTAL) {
          sent += CHUNK.length;
          if (!res.write(CHUNK)) { res.once('drain', pump); return; }
        }
        if (sent >= TOTAL) res.end();
      };
      pump();
    });
    const outcome = await settleWithin(
      fetchBounded(url, undefined, { deadlineMs: 10_000, maxBytes: 1024 * 1024 }),
      8000,
    );
    expect((outcome as { error?: unknown }).error).toBeInstanceOf(ResponseTooLargeError);
    // Give the server a beat to observe the abort, then prove it never sent the lot.
    await new Promise((r) => setTimeout(r, 200));
    expect(closed).toBe(true);
    expect(sent).toBeLessThan(TOTAL / 4);
  });

  it('a declared Content-Length over the cap is refused before the body is read', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(10 * 1024 * 1024) });
      res.write('{');
      timers.push(setInterval(() => res.write(' '), 50));
    });
    const outcome = await settleWithin(fetchBounded(url, undefined, { deadlineMs: 5000, maxBytes: 1024 }), 3000);
    expect((outcome as { error?: unknown }).error).toBeInstanceOf(ResponseTooLargeError);
  });

  it('control: a legitimate body within cap and deadline is returned intact (status + JSON)', async () => {
    const payload = { jsonrpc: '2.0', id: 1, result: { transfers: Array.from({ length: 50 }, (_, i) => ({ i })) } };
    const url = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
    const res = await fetchBounded(url, undefined, { deadlineMs: 5000, maxBytes: 1024 * 1024 });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
  });

  it('control: a 4xx upstream keeps its status and body; a 204 has no body', async () => {
    const url4 = await serve((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end('{"error":"limit"}');
    });
    const r4 = await fetchBounded(url4, undefined, { deadlineMs: 5000, maxBytes: 1024 });
    expect(r4.status).toBe(429);
    expect(await r4.json()).toEqual({ error: 'limit' });
    const url2 = await serve((_req, res) => { res.writeHead(204); res.end(); });
    const r2 = await fetchBounded(url2, undefined, { deadlineMs: 5000, maxBytes: 1024 });
    expect(r2.status).toBe(204);
  });

  it('a body exactly at the cap is accepted (the cap is inclusive)', async () => {
    const url = await serve((_req, res) => { res.writeHead(200); res.end(Buffer.alloc(1024, 0x61)); });
    const res = await fetchBounded(url, undefined, { deadlineMs: 5000, maxBytes: 1024 });
    expect((await res.arrayBuffer()).byteLength).toBe(1024);
  });
});

describe('raceDeadline', () => {
  it('rejects a never-settling promise when the deadline fires, and runs onExpire', async () => {
    const deadline = startDeadline(100);
    let cancelled = false;
    const never = new Promise<string[]>(() => undefined);
    await expect(raceDeadline(never, deadline, () => { cancelled = true; })).rejects.toBeInstanceOf(DeadlineExceededError);
    expect(cancelled).toBe(true);
  });

  it('passes a value that arrives in time straight through', async () => {
    const deadline = startDeadline(1000);
    await expect(raceDeadline(Promise.resolve(['203.0.113.7']), deadline)).resolves.toEqual(['203.0.113.7']);
    deadline.clear();
  });

  it('refuses a non-positive deadline', () => {
    expect(() => startDeadline(0)).toThrow(RangeError);
  });
});
