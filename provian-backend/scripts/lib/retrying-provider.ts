/**
 * A JsonRpcProvider that retries THROTTLED reads and never retries a real revert.
 *
 * WHY THIS EXISTS — a measured failure, not a hypothetical. During activation P2 the
 * kernel deployed correctly at `0x8b2306be…` and its runtime bytecode verified as
 * an EXACT match, then the deploy script died on its SIXTH read with
 * `missing revert data (… data=null … CALL_EXCEPTION)`. The contract was fine:
 * every one of those getters returns its expected value when called with spacing,
 * and all ten selectors are present in the deployed runtime. The cause was
 * `https://mainnet.base.org` rate-limiting the burst — reproduced deterministically
 * as 3 rapid calls OK then 5 consecutive failures. `server.ts:10828` already
 * documents this hazard for the relay ("public-only fallback silently throttles
 * chain verification"); the operator scripts had no equivalent protection.
 *
 * The consequence was worse than a failed read. The deploy script has no resume,
 * so a mid-sequence death leaves REAL deployed contracts orphaned and a re-run
 * deploys a fresh set. A throttled read must therefore never be allowed to look
 * like a verification failure.
 *
 * THE DISCRIMINATOR, and it is the whole safety argument: a genuine EVM revert
 * carries revert DATA. A throttle/transport failure does not. So this retries only
 * errors WITHOUT revert data, and propagates anything carrying data on the first
 * attempt. A real `require` failure is never silently retried into success, and a
 * contract that genuinely lacks a getter still fails — it just fails for the right
 * reason. Both directions are covered by tests, including the negative control.
 */

import { JsonRpcProvider, type JsonRpcApiProviderOptions, type Networkish } from 'ethers';

export interface RetryOptions {
  /** Total attempts per RPC call, including the first. Must be >= 1. */
  readonly maxAttempts?: number;
  /** Base delay in ms; attempt N waits baseDelayMs * 2^(N-1). */
  readonly baseDelayMs?: number;
  /** Injected for tests so they need no real timers. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Called before each retry, for operator visibility. */
  readonly onRetry?: (info: { method: string; attempt: number; delayMs: number; message: string }) => void;
}

export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_BASE_DELAY_MS = 400;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/**
 * Does this error carry EVM revert data? If so it is a real contract outcome and
 * must NOT be retried.
 *
 * Checked structurally rather than by message text: ethers puts the returned
 * bytes on `.data`, and nests the original under `.error`/`.info.error`. `'0x'` is
 * treated as NO data — an empty return is what a throttled or wrong-address call
 * produces, not a revert reason.
 */
export function carriesRevertData(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number): boolean => {
    if (depth > 4 || typeof node !== 'object' || node === null || seen.has(node)) return false;
    seen.add(node);
    const rec = node as Record<string, unknown>;
    const data = rec.data;
    if (typeof data === 'string' && data.startsWith('0x') && data.length > 2) return true;
    // A decoded custom-error/panic reason is also a real contract outcome.
    if (typeof rec.reason === 'string' && rec.reason.length > 0) return true;
    return walk(rec.error, depth + 1) || walk(rec.info, depth + 1);
  };
  return walk(err, 0);
}

/**
 * JSON-RPC error codes that are DETERMINISTIC client/protocol errors. Retrying
 * them is pure waste: the same request will fail identically every time.
 *
 * Measured, not theorised: the verifier retried `eth_getTransactionReceipt` four
 * times with backoff against a `-32602 Invalid params` caused by passing an
 * `adopted:0x…` marker instead of a tx hash. `-32603` (internal error) is
 * deliberately EXCLUDED — that one genuinely can be transient.
 */
const PERMANENT_RPC_ERROR_CODES = new Set([-32700, -32600, -32601, -32602]);

/** Is this a deterministic client/protocol error that will never succeed on retry? */
export function isPermanentRpcError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number): boolean => {
    if (depth > 4 || typeof node !== 'object' || node === null || seen.has(node)) return false;
    seen.add(node);
    const rec = node as Record<string, unknown>;
    if (typeof rec.code === 'number' && PERMANENT_RPC_ERROR_CODES.has(rec.code)) return true;
    return walk(rec.error, depth + 1) || walk(rec.info, depth + 1);
  };
  return walk(err, 0);
}

/** JsonRpcProvider whose every `send` is retried on non-revert failures. */
export class RetryingJsonRpcProvider extends JsonRpcProvider {
  private readonly retry: Required<Omit<RetryOptions, 'onRetry'>> & Pick<RetryOptions, 'onRetry'>;

  constructor(
    url: string,
    network?: Networkish,
    options?: JsonRpcApiProviderOptions,
    retryOptions: RetryOptions = {},
  ) {
    super(url, network, options);
    const maxAttempts = retryOptions.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error(`retrying-provider: maxAttempts must be an integer >= 1, got ${String(maxAttempts)}`);
    }
    this.retry = {
      maxAttempts,
      baseDelayMs: retryOptions.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
      sleep: retryOptions.sleep ?? defaultSleep,
      onRetry: retryOptions.onRetry,
    };
  }

  override async send(method: string, params: Array<unknown> | Record<string, unknown>): Promise<unknown> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt += 1) {
      try {
        return await super.send(method, params as never);
      } catch (err) {
        lastErr = err;
        // A real contract outcome is final on the first attempt.
        if (carriesRevertData(err)) throw err;
        // So is a deterministic client/protocol error — retrying it is waste.
        if (isPermanentRpcError(err)) throw err;
        if (attempt === this.retry.maxAttempts) break;
        const delayMs = this.retry.baseDelayMs * 2 ** (attempt - 1);
        this.retry.onRetry?.({
          method,
          attempt,
          delayMs,
          message: err instanceof Error ? err.message : String(err),
        });
        await this.retry.sleep(delayMs);
      }
    }
    throw lastErr;
  }
}

/**
 * Poll `getCode` until it returns non-empty, then return it.
 *
 * WHY THIS IS SEPARATE FROM THE RETRY WRAPPER, and it is the second half of the
 * same lesson. `RetryingJsonRpcProvider` retries FAILED calls. But an empty
 * `getCode` is a SUCCESSFUL response carrying wrong data, so nothing throws and
 * nothing retries. That is exactly how P2 died the second time: `ProvianEscrowV4`
 * deployed correctly (tx status 1, block 49114195, and 12,101 bytes of code are
 * there now), yet `getCode` six seconds later hit a lagging public-RPC node and
 * returned `0x` — reported as "runtime length 0 != artifact 24202" and
 * indistinguishable from a catastrophic verification failure.
 *
 * The semantics that matter: immediately after a deployment an empty `getCode` is
 * UNKNOWN, not ABSENT. So poll, bounded — and if it is still empty when the budget
 * runs out, that IS fatal and the caller must treat it so. This never converts a
 * genuinely codeless address into a pass; it only refuses to conclude "no code"
 * from a single read that a lagging node can get wrong.
 */
export async function waitForCode(
  provider: { getCode: (address: string) => Promise<string> },
  address: string,
  opts: {
    readonly attempts?: number;
    readonly delayMs?: number;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly onWait?: (attempt: number) => void;
  } = {},
): Promise<string> {
  const attempts = opts.attempts ?? 10;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(`waitForCode: attempts must be an integer >= 1, got ${String(attempts)}`);
  }
  const delayMs = opts.delayMs ?? 1500;
  const sleep = opts.sleep ?? defaultSleep;
  let code = '0x';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    code = await provider.getCode(address);
    if (code && code !== '0x') return code;
    if (attempt === attempts) break;
    opts.onWait?.(attempt);
    await sleep(delayMs);
  }
  // Still empty after the full budget. Return it and let the caller fail — this
  // function never decides that an address is legitimately codeless.
  return code;
}

/**
 * Build the provider the activation operator scripts use. Paces and retries reads so a
 * throttled endpoint cannot masquerade as a verification failure.
 */
export function createRetryingProvider(url: string, retryOptions: RetryOptions = {}): RetryingJsonRpcProvider {
  return new RetryingJsonRpcProvider(
    url,
    undefined,
    // Serialise: batching is what turns 5 reads into one burst the endpoint rejects.
    { batchMaxCount: 1 },
    {
      onRetry: ({ method, attempt, delayMs }) => {
        console.log(`  [rpc] ${method} attempt ${attempt} failed (no revert data) — retrying in ${delayMs}ms`);
      },
      ...retryOptions,
    },
  );
}
