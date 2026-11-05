/**
 * a failed READ during a watcher's per-address resolution is never an exclusion.
 *
 * The watched-set enumerators catch per-wallet faults and EXCLUDE the wallet (Unknown = Block,
 * per wallet). Some of those catch blocks also catch a failed Firestore read, which made a
 * transient read fault exclude a real wallet for one cycle — a payment in that cycle was then
 * skipped. When a watcher resolves ONE address because the chain showed it a payment, it wraps
 * the database in `strictReads` every read failure surfaces as a `WatchReadError`, which the
 * enumerators rethrow instead of excluding, so the resolution HOLDS (the checkpoint stays behind
 * the payment and the next run retries) instead of skipping it.
 */

import type { Firestore } from 'firebase-admin/firestore';

export class WatchReadError extends Error {
  constructor(readonly cause: unknown) {
    super(`watch_read_failed:${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 500));
    this.name = 'WatchReadError';
  }
}

/** Rethrow a read failure; let every other error take the caller's own path. */
export function rethrowWatchReadError(error: unknown): void {
  if (error instanceof WatchReadError) throw error;
}

function wrap(target: object): object {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value !== 'function') return value;
      if (prop === 'get' || prop === 'getAll') {
        return async (...args: unknown[]) => {
          try {
            return await (value as (...a: unknown[]) => Promise<unknown>).apply(obj, args);
          } catch (error) {
            throw error instanceof WatchReadError ? error : new WatchReadError(error);
          }
        };
      }
      return (...args: unknown[]) => {
        const result = (value as (...a: unknown[]) => unknown).apply(obj, args);
        return result !== null && typeof result === 'object' ? wrap(result as object) : result;
      };
    },
  });
}

/** The same database, with every read failure surfacing as a `WatchReadError`. */
export function strictReads(db: Firestore): Firestore {
  return wrap(db as unknown as object) as unknown as Firestore;
}
