/**
 * Tests for the activation operator-script RPC retry wrapper.
 *
 * The load-bearing property is NOT "it retries". It is that it retries the RIGHT
 * errors: a throttled read (no revert data) is retried, and a genuine EVM revert
 * (revert data present) is propagated on the FIRST attempt and never retried into
 * a false success. Both directions are asserted, and the negative control is the
 * revert case — without it, a wrapper that retried everything would pass every
 * test here while silently converting real contract failures into hangs.
 */

import {
  carriesRevertData,
  isPermanentRpcError,
  RetryingJsonRpcProvider,
  waitForCode,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_BASE_DELAY_MS,
} from '../../../../scripts/lib/retrying-provider';

/**
 * A provider whose underlying transport is a scripted queue. Subclasses the real
 * class and stubs only `JsonRpcProvider.prototype.send`, so the retry logic under
 * test is the real one.
 */
function makeProvider(
  outcomes: Array<'ok' | unknown>,
  opts: { maxAttempts?: number } = {},
): { provider: RetryingJsonRpcProvider; calls: () => number; delays: number[] } {
  const delays: number[] = [];
  let i = 0;
  const provider = new RetryingJsonRpcProvider(
    'http://127.0.0.1:0',
    undefined,
    { batchMaxCount: 1 },
    {
      maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      baseDelayMs: DEFAULT_BASE_DELAY_MS,
      sleep: async (ms: number) => { delays.push(ms); },
    },
  );
  // Replace the transport, not the retry loop.
  const proto = Object.getPrototypeOf(Object.getPrototypeOf(provider)) as {
    send: (m: string, p: unknown) => Promise<unknown>;
  };
  jest.spyOn(proto, 'send').mockImplementation(async () => {
    const outcome = outcomes[Math.min(i, outcomes.length - 1)];
    i += 1;
    if (outcome === 'ok') return '0x32';
    throw outcome;
  });
  return { provider, calls: () => i, delays };
}

/** The exact throttle error observed on Base: CALL_EXCEPTION with data === null. */
const THROTTLE_ERROR = Object.assign(new Error('missing revert data'), {
  code: 'CALL_EXCEPTION',
  data: null,
  reason: null,
});

/** A genuine revert: ethers puts the returned bytes on `.data`. */
const REAL_REVERT = Object.assign(new Error('execution reverted'), {
  code: 'CALL_EXCEPTION',
  // Error(string) selector + payload — real revert data.
  data: '0x08c379a00000000000000000000000000000000000000000000000000000000000000020',
});

afterEach(() => { jest.restoreAllMocks(); });

describe('carriesRevertData — the discriminator the whole safety argument rests on', () => {
  it('says NO for the measured Base throttle error (data === null)', () => {
    expect(carriesRevertData(THROTTLE_ERROR)).toBe(false);
  });

  it('says NO for an empty 0x return, which is what a throttled/wrong-address call yields', () => {
    expect(carriesRevertData(Object.assign(new Error('x'), { data: '0x' }))).toBe(false);
  });

  it('says YES for a genuine revert carrying data', () => {
    expect(carriesRevertData(REAL_REVERT)).toBe(true);
  });

  it('says YES for a decoded revert reason', () => {
    expect(carriesRevertData(Object.assign(new Error('x'), { reason: 'InvalidActivationDates' }))).toBe(true);
  });

  it('finds revert data NESTED under .error / .info.error', () => {
    expect(carriesRevertData({ info: { error: { data: '0xdeadbeef' } } })).toBe(true);
    expect(carriesRevertData({ error: { data: '0xdeadbeef' } })).toBe(true);
  });

  it('does not crash or false-positive on junk, null, or a cycle', () => {
    expect(carriesRevertData(null)).toBe(false);
    expect(carriesRevertData('a string')).toBe(false);
    expect(carriesRevertData(new Error('plain'))).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.error = cyclic;
    expect(carriesRevertData(cyclic)).toBe(false);
  });
});

describe('RetryingJsonRpcProvider', () => {
  it('retries a throttled read and SUCCEEDS — the P2 failure, now survived', () => {
    // 3 rapid calls OK then failures is what Base actually did; here the first
    // three attempts are throttled and the fourth succeeds.
    const { provider, calls, delays } = makeProvider([
      THROTTLE_ERROR, THROTTLE_ERROR, THROTTLE_ERROR, 'ok',
    ]);
    return expect(provider.send('eth_call', [])).resolves.toBe('0x32')
      .then(() => {
        expect(calls()).toBe(4);
        // Exponential backoff, deterministic: 400, 800, 1600.
        expect(delays).toEqual([400, 800, 1600]);
      });
  });

  it('NEGATIVE CONTROL — a GENUINE REVERT is propagated on the FIRST attempt, never retried', async () => {
    // This is the control. A wrapper that retried everything would still pass the
    // test above; it fails here. If revert data were ignored, `calls()` would be
    // maxAttempts and a real contract failure would be delayed and obscured.
    const { provider, calls, delays } = makeProvider([REAL_REVERT, 'ok']);
    await expect(provider.send('eth_call', [])).rejects.toThrow('execution reverted');
    expect(calls()).toBe(1);
    expect(delays).toEqual([]);
  });

  it('gives up after maxAttempts and rethrows the LAST error rather than hanging', async () => {
    const { provider, calls } = makeProvider([THROTTLE_ERROR], { maxAttempts: 3 });
    await expect(provider.send('eth_call', [])).rejects.toThrow('missing revert data');
    expect(calls()).toBe(3);
  });

  it('maxAttempts = 1 disables retry entirely (no silent minimum)', async () => {
    const { provider, calls } = makeProvider([THROTTLE_ERROR], { maxAttempts: 1 });
    await expect(provider.send('eth_call', [])).rejects.toThrow('missing revert data');
    expect(calls()).toBe(1);
  });

  it('succeeds on the first attempt without sleeping when nothing fails', async () => {
    const { provider, calls, delays } = makeProvider(['ok']);
    await expect(provider.send('eth_chainId', [])).resolves.toBe('0x32');
    expect(calls()).toBe(1);
    expect(delays).toEqual([]);
  });

  it('rejects a nonsensical maxAttempts instead of silently defaulting', () => {
    expect(() => new RetryingJsonRpcProvider('http://127.0.0.1:0', undefined, {}, { maxAttempts: 0 }))
      .toThrow(/maxAttempts must be an integer >= 1/);
    expect(() => new RetryingJsonRpcProvider('http://127.0.0.1:0', undefined, {}, { maxAttempts: 2.5 }))
      .toThrow(/maxAttempts must be an integer >= 1/);
  });

  it('the shipped defaults are the reviewed ones', () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(5);
    expect(DEFAULT_BASE_DELAY_MS).toBe(400);
  });
});

describe('waitForCode — the second half of the lesson: an empty getCode is a SUCCESSFUL response', () => {
  /**
   * The measured failure: ProvianEscrowV4 deployed correctly (tx status 1, block
   * 49114195, 12,101 bytes present) and `getCode` six seconds later returned `0x`
   * from a lagging node. Nothing threw, so the retry wrapper could not help, and
   * the deploy script reported it as a catastrophic verification failure.
   */
  const codeOf = (seq: string[]) => {
    let i = 0;
    return {
      getCode: async () => {
        const v = seq[Math.min(i, seq.length - 1)];
        i += 1;
        return v;
      },
      calls: () => i,
    };
  };

  it('returns immediately when code is present on the first read', async () => {
    const p = codeOf(['0xabcdef']);
    const delays: number[] = [];
    await expect(waitForCode(p, '0x1', { sleep: async (ms) => { delays.push(ms); } }))
      .resolves.toBe('0xabcdef');
    expect(p.calls()).toBe(1);
    expect(delays).toEqual([]);
  });

  it('POLLS THROUGH a lagging empty read and returns the code — the escrow failure, survived', async () => {
    const p = codeOf(['0x', '0x', '0x', '0xabcdef']);
    const delays: number[] = [];
    await expect(waitForCode(p, '0x1', { delayMs: 100, sleep: async (ms) => { delays.push(ms); } }))
      .resolves.toBe('0xabcdef');
    expect(p.calls()).toBe(4);
    expect(delays).toEqual([100, 100, 100]);
  });

  it('NEGATIVE CONTROL — a genuinely codeless address stays EMPTY and is NOT rescued', async () => {
    // The control that keeps this from becoming "retry until it looks fine". A
    // permanently empty address must still come back empty so the caller fails.
    // Without this, polling could be mistaken for a fix that hides a real problem.
    const p = codeOf(['0x']);
    const result = await waitForCode(p, '0x1', { attempts: 4, delayMs: 1, sleep: async () => {} });
    expect(result).toBe('0x');
    expect(p.calls()).toBe(4);
  });

  it('respects the attempt budget exactly and does not sleep after the last try', async () => {
    const p = codeOf(['0x']);
    const delays: number[] = [];
    await waitForCode(p, '0x1', { attempts: 3, delayMs: 7, sleep: async (ms) => { delays.push(ms); } });
    expect(p.calls()).toBe(3);
    expect(delays).toEqual([7, 7]);
  });

  it('rejects a nonsensical attempt budget instead of silently defaulting', async () => {
    await expect(waitForCode(codeOf(['0x']), '0x1', { attempts: 0 }))
      .rejects.toThrow(/attempts must be an integer >= 1/);
  });
});

describe('isPermanentRpcError — deterministic client errors must not be retried', () => {
  /**
   * Measured: the verifier burned four backoff rounds on a `-32602 Invalid params`
   * caused by feeding an `adopted:0x…` marker to eth_getTransactionReceipt. That
   * request could never have succeeded.
   */
  const INVALID_PARAMS = {
    error: { code: -32602, message: 'Invalid params', data: 'invalid string length' },
  };

  it('says YES for -32602 Invalid params (the measured case), nested under .error', () => {
    expect(isPermanentRpcError(INVALID_PARAMS)).toBe(true);
  });

  it('says YES for the other deterministic protocol codes', () => {
    for (const code of [-32700, -32600, -32601]) {
      expect(isPermanentRpcError({ code })).toBe(true);
    }
  });

  it('NEGATIVE CONTROL — -32603 internal error is NOT permanent, because it can be transient', () => {
    // The control that stops this becoming "never retry anything with a code".
    // If -32603 were treated as permanent, a genuinely transient node error would
    // stop being retried and the fix would silently regress.
    expect(isPermanentRpcError({ code: -32603, message: 'Internal error' })).toBe(false);
  });

  it('says NO for the throttle error and for junk', () => {
    expect(isPermanentRpcError(THROTTLE_ERROR)).toBe(false);
    expect(isPermanentRpcError(null)).toBe(false);
    expect(isPermanentRpcError({ code: 'CALL_EXCEPTION' })).toBe(false);
  });

  it('the provider throws a permanent error on attempt 1 and never sleeps', async () => {
    const { provider, calls, delays } = makeProvider([INVALID_PARAMS]);
    await expect(provider.send('eth_getTransactionReceipt', [])).rejects.toBeDefined();
    expect(calls()).toBe(1);
    expect(delays).toEqual([]);
  });

  it('a transient error is still retried — the permanent check did not swallow everything', async () => {
    const { provider, calls } = makeProvider([THROTTLE_ERROR, 'ok']);
    await expect(provider.send('eth_call', [])).resolves.toBe('0x32');
    expect(calls()).toBe(2);
  });
});
