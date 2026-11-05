/**
 * Per-instance request/error counters for the operator console.
 *
 * These are IN-MEMORY, per-Cloud-Run-instance, and reset on restart — advisory,
 * not authoritative. Authoritative throughput and 5xx rate come from Cloud
 * Monitoring (`run.googleapis.com/request_count`), which the console links to.
 * We deliberately do NOT write Firestore per request (a write on the hot path is
 * cost and latency this earns nothing); a plain integer bump on `res.finish` is
 * free. The console reports these alongside a clear "this instance only" note.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface ConsoleCountersSnapshot {
  readonly instance_started_at_ms: number;
  readonly uptime_ms: number;
  readonly requests_total: number;
  readonly by_status_class: Readonly<Record<'2xx' | '3xx' | '4xx' | '5xx' | 'other', number>>;
  readonly endpoint_errors: number;
  readonly note: string;
}

const state = {
  started: Date.now(),
  total: 0,
  c2: 0,
  c3: 0,
  c4: 0,
  c5: 0,
  cOther: 0,
  endpointErrors: 0,
};

/** Express middleware: bump the per-instance counters when each response finishes. */
export function consoleRequestCounterMiddleware(): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.on('finish', () => {
      state.total += 1;
      const code = res.statusCode;
      if (code >= 200 && code < 300) state.c2 += 1;
      else if (code >= 300 && code < 400) state.c3 += 1;
      else if (code >= 400 && code < 500) state.c4 += 1;
      else if (code >= 500) state.c5 += 1;
      else state.cOther += 1;
    });
    next();
  };
}

/** Called from the endpoint-error funnel to count handled errors on this instance. */
export function recordConsoleEndpointError(): void {
  state.endpointErrors += 1;
}

export function readConsoleCounters(nowMs: number = Date.now()): ConsoleCountersSnapshot {
  return {
    instance_started_at_ms: state.started,
    uptime_ms: nowMs - state.started,
    requests_total: state.total,
    by_status_class: {
      '2xx': state.c2,
      '3xx': state.c3,
      '4xx': state.c4,
      '5xx': state.c5,
      other: state.cOther,
    },
    endpoint_errors: state.endpointErrors,
    note: 'Per-instance, in-memory, resets on restart. Authoritative rates: Cloud Monitoring run.googleapis.com/request_count.',
  };
}

/** Test-only: reset the module state. */
export function __resetConsoleCountersForTest(nowMs: number = Date.now()): void {
  state.started = nowMs;
  state.total = 0;
  state.c2 = 0;
  state.c3 = 0;
  state.c4 = 0;
  state.c5 = 0;
  state.cOther = 0;
  state.endpointErrors = 0;
}
