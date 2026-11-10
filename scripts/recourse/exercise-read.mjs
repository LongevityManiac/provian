/** Retry only rate-limited, read-only fork calls. Never replay a mutation. */
export async function exerciseRead(read, { wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  onRetry = () => {}, attempts = 6 } = {}) {
  for (let attempt = 0; ; ++attempt) {
    try { return await read(); }
    catch (error) {
      const message = `${error?.info?.error?.message ?? ''} ${error?.message ?? ''}`;
      if (attempt + 1 >= attempts || !/\b429\b|rate limit|request limit/i.test(message)) throw error;
      onRetry(attempt + 1);
      await wait(60_000);
    }
  }
}

/** Poll one already-submitted local hash. A temporary upstream refusal while
 * Anvil mines it must never cause a second transaction submission. */
export async function exerciseReceipt(provider, hash, { wait = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 300 } = {}) {
  let failure;
  for (let attempt = 0; attempt < attempts; ++attempt) {
    try {
      const receipt = await provider.send('eth_getTransactionReceipt', [hash]);
      if (receipt) return receipt;
    } catch (error) { failure = error; }
    await wait(100);
  }
  throw failure ?? Error('exercise_receipt_unavailable');
}
