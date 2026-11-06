/**
 * Latency of the requests people and agents wait on, as a fixed-bucket histogram in the ops
 * counters (`http.public_latency.le_<ms>`). Internal routes (`/v1/internal/`: scheduler jobs,
 * queue tasks, settlement runs) are excluded: they run for seconds by design, every few minutes,
 * and in Cloud Run's request_latencies they alone set the service p99. The hot path is one
 * in-memory bump on response finish; the counters flush on their own timer.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { bumpOpsCounter } from './ops-counters';

/** Upper bounds in milliseconds. A reader takes the bound of the bucket holding the percentile. */
export const PUBLIC_LATENCY_BUCKETS_MS = [100, 250, 500, 1000, 2000, 5000, 10000, 30000] as const;
export const PUBLIC_LATENCY_COUNTER_PREFIX = 'http.public_latency.le_';

export function isInternalRoute(path: string): boolean {
  return path === '/v1/internal' || path.startsWith('/v1/internal/');
}

export function publicLatencyBucket(elapsedMs: number): string {
  for (const bound of PUBLIC_LATENCY_BUCKETS_MS) if (elapsedMs <= bound) return `${PUBLIC_LATENCY_COUNTER_PREFIX}${bound}`;
  return `${PUBLIC_LATENCY_COUNTER_PREFIX}inf`;
}

export function publicLatencyMiddleware(
  bump: (key: string) => void = bumpOpsCounter,
  clock: () => bigint = process.hrtime.bigint,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (isInternalRoute(req.path)) { next(); return; }
    const started = clock();
    res.on('finish', () => { bump(publicLatencyBucket(Number(clock() - started) / 1e6)); });
    next();
  };
}
