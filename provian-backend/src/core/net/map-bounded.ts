/** Run independent reads with bounded concurrency and retain input order. */
export async function mapBounded<T, R>(items: readonly T[], concurrency: number, read: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const workers = Array.from({length: Math.min(items.length, Math.max(1, Math.floor(concurrency)))}, async () => {
    for (;;) {
      if (failed) return;
      const i = next++;
      if (i >= items.length) return;
      try { results[i] = await read(items[i]); }
      catch (error) { failed = true; throw error; }
    }
  });
  const completed = await Promise.allSettled(workers);
  for (const result of completed) if (result.status === 'rejected') throw result.reason;
  return results;
}

/**
 * `Promise.all` that waits for EVERY read to settle before it rethrows the first
 * failure (in input order). `Promise.all` rejects on the first failure and leaves
 * its siblings running unobserved; a caller that moves on (and returns, and lets
 * the next request in) must never leave reads behind it. Relay heap OOM,
 * 2026-10-17: a failed trace read let a 500-block full-block read run on
 * behind every chain-record run.
 */
export async function allSettledOrThrow<T extends readonly unknown[]>(
  reads: { readonly [K in keyof T]: Promise<T[K]> },
): Promise<T> {
  const settled = await Promise.allSettled(reads as readonly Promise<unknown>[]);
  for (const result of settled) if (result.status === 'rejected') throw result.reason;
  return settled.map((result) => (result as PromiseFulfilledResult<unknown>).value) as unknown as T;
}
