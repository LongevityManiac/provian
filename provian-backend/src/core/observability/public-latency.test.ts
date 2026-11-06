import { EventEmitter } from 'events';
import type { Request, Response } from 'express';
import { publicLatencyMiddleware, publicLatencyBucket, isInternalRoute, PUBLIC_LATENCY_BUCKETS_MS } from './public-latency';

function run(path: string, elapsedMs: number): string[] {
  const bumps: string[] = [];
  let now = 1_000_000_000n;
  const res = new EventEmitter() as unknown as Response;
  const next = jest.fn();
  publicLatencyMiddleware(key => bumps.push(key), () => now)({ path } as Request, res, next);
  expect(next).toHaveBeenCalledTimes(1);
  now += BigInt(Math.round(elapsedMs * 1e6));
  (res as unknown as EventEmitter).emit('finish');
  return bumps;
}

it('counts a public request into the bucket holding its latency', () => {
  expect(run('/v1/agent/wallet/abc', 40)).toEqual(['http.public_latency.le_100']);
  expect(run('/v1/witnesses/github/webhook', 2001)).toEqual(['http.public_latency.le_5000']);
  expect(run('/v1/archive/pay', 45_000)).toEqual(['http.public_latency.le_inf']);
});

it('leaves scheduler, task and settlement routes out of the public histogram', () => {
  for (const path of ['/v1/internal/scheduler/chain-record-discovery', '/v1/internal/tasks/github', '/v1/internal/settlement/pvt9-run', '/v1/internal']) {
    expect(isInternalRoute(path)).toBe(true);
    expect(run(path, 20_000)).toEqual([]);
  }
  // A public route whose name merely contains "internal" is still measured.
  expect(isInternalRoute('/v1/internalize')).toBe(false);
  expect(run('/v1/internalize', 20_000)).toEqual(['http.public_latency.le_30000']);
});

it('bucket bounds are inclusive and every bound is reachable', () => {
  for (const bound of PUBLIC_LATENCY_BUCKETS_MS) {
    expect(publicLatencyBucket(bound)).toBe(`http.public_latency.le_${bound}`);
  }
  expect(publicLatencyBucket(30_000.5)).toBe('http.public_latency.le_inf');
});
