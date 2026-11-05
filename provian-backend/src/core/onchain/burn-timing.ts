import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import type { RequestHandler } from 'express';

interface TimingSpan { readonly name: string; readonly start_ms: number; readonly duration_ms: number }
interface TimingContext { readonly id: string; readonly start: number; readonly spans: TimingSpan[] }
const timings = new AsyncLocalStorage<TimingContext>();

/** Opt-in diagnostics contain durations only. They never record a key, body, RPC URL or signed payload. */
export const burnTimingMiddleware: RequestHandler = (req, res, next) => {
  if (req.headers['x-provian-timing'] !== '1' || !/\/(?:present|feature|burn\/record)(?:\/|$)/.test(req.path)) { next(); return; }
  const context: TimingContext = { id: randomUUID(), start: performance.now(), spans: [] };
  res.setHeader('X-Provian-Timing-Id', context.id);
  res.once('finish', () => console.log(JSON.stringify({ event: 'burn_timing', id: context.id,
    duration_ms: performance.now() - context.start, status: res.statusCode, spans: context.spans })));
  timings.run(context, next);
};

export async function timeBurnStep<T>(name: string, run: () => Promise<T>): Promise<T> {
  const context = timings.getStore();
  if (!context) return run();
  const start = performance.now();
  try { return await run(); }
  finally {
    if (context.spans.length < 256) context.spans.push({ name, start_ms: start - context.start, duration_ms: performance.now() - start });
  }
}
