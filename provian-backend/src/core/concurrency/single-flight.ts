/**
 * Single-flight: coalesce concurrent computations of the same key so N
 * simultaneous cache misses do one unit of work instead of N.
 *
 * WHY (H2). `/v1/pvt/network-stats` recomputes from a full `wallets` scan
 * whenever its 30-second Redis entry lapses. Without coalescing, every request
 * that arrives during that window is its own miss and its own full scan — the
 * classic cache stampede, where the cost of a miss is multiplied by the request
 * rate exactly when the endpoint is busiest.
 *
 * SCOPE, STATED HONESTLY: this is IN-PROCESS. Cloud Run runs several instances,
 * so it coalesces within one instance, not across the fleet — the worst case
 * goes from "one scan per concurrent request" to "one scan per instance per
 * cache window", not to one globally. A distributed lock would close the rest,
 * at the cost of a Redis round trip on the hot path and a lock-expiry failure
 * mode; that trade is not worth making for a 30-second read cache. Do not
 * describe this as a distributed guarantee.
 *
 * The entry is removed as soon as the promise settles, so a failure is never
 * cached: the next caller retries rather than inheriting an old rejection.
 */

const inFlight = new Map<string, Promise<unknown>>();

/**
 * Run `compute` for `key`, or join the run already in progress.
 *
 * Every joiner receives the SAME result — including the same rejection, so a
 * failure surfaces to all of them rather than being swallowed for all but one.
 */
export function singleFlight<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing !== undefined) return existing as Promise<T>;

  // `compute()` is invoked inside the try so a SYNCHRONOUS throw is turned into
  // a rejected promise rather than escaping past the cleanup and leaving the key
  // wedged in the map forever.
  let run: Promise<T>;
  try {
    run = compute();
  } catch (error) {
    return Promise.reject(error);
  }

  const tracked = run.finally(() => {
    // Only delete OUR entry: a later flight for the same key may already have
    // replaced it, and deleting that one would wedge its joiners.
    if (inFlight.get(key) === tracked) inFlight.delete(key);
  });
  inFlight.set(key, tracked);
  return tracked;
}

/** Test-only: number of flights currently in progress. */
export function inFlightCount(): number {
  return inFlight.size;
}
