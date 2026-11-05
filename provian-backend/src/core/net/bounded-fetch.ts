/**
 * Bounded outbound reads — ONE wall-clock deadline and ONE byte cap per
 * outbound request, held across connect + headers + the full body read.
 *
 * The defect this closes: every relay outbound read was bounded only at its first
 * phase. `fetchWithTimeout` cleared its abort timer the moment `fetch()` resolved at
 * the response HEADERS, so the `await res.json()` that followed was unbounded in both
 * time and size; the avatar proxy and webhook delivery used `https.request`'s
 * `timeout` option, which is a socket-IDLE timer — an upstream that trickles one byte
 * inside every idle window resets it forever. A hostile or broken upstream could pin
 * a request (and its buffered bytes) for hours.
 *
 * The rule here: a request gets a single deadline started before the first byte
 * leaves (before DNS, where there is DNS) and cleared only after the last byte of the
 * body is in hand; the body is stream-read and the transfer is ABORTED the moment it
 * passes the cap — never buffered whole and measured afterwards.
 *
 * SSRF enforcement (Security Invariant #6) is untouched by this module: it bounds how
 * long and how much, never where. Callers that fetch attacker-influenced hosts keep
 * their resolve-and-validate + pinned-socket path and use `startDeadline` /
 * `raceDeadline` around it.
 */

/** The request outlived its wall-clock deadline (any phase: DNS, connect, headers, body). */
export class DeadlineExceededError extends Error {
  public readonly deadlineMs: number;
  constructor(deadlineMs: number) {
    super(`deadline of ${deadlineMs} ms exceeded`);
    this.name = 'DeadlineExceededError';
    this.deadlineMs = deadlineMs;
  }
}

/** The upstream body passed the byte cap; the transfer was aborted, not buffered. */
export class ResponseTooLargeError extends Error {
  public readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`upstream response exceeded ${maxBytes} bytes`);
    this.name = 'ResponseTooLargeError';
    this.maxBytes = maxBytes;
  }
}

/** One wall-clock deadline. `signal` aborts when it fires; `clear()` disarms it. */
export interface Deadline {
  readonly ms: number;
  readonly signal: AbortSignal;
  expired(): boolean;
  clear(): void;
}

export function startDeadline(ms: number): Deadline {
  if (!Number.isFinite(ms) || ms <= 0) throw new RangeError(`deadline must be a positive number of ms, got ${ms}`);
  const controller = new AbortController();
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    controller.abort(new DeadlineExceededError(ms));
  }, ms);
  // Never keep the process alive just to fire a deadline.
  if (typeof timer.unref === 'function') timer.unref();
  return {
    ms,
    signal: controller.signal,
    expired: () => fired,
    clear: () => clearTimeout(timer),
  };
}

/**
 * Race work that cannot itself be cancelled (a DNS query, an injected resolver)
 * against a deadline. Rejects with DeadlineExceededError when the deadline fires
 * first; `onExpire` lets the caller cancel the underlying work (e.g. Resolver.cancel).
 */
export function raceDeadline<T>(work: Promise<T>, deadline: Deadline, onExpire?: () => void): Promise<T> {
  if (deadline.signal.aborted) {
    onExpire?.();
    work.catch(() => undefined);
    return Promise.reject(new DeadlineExceededError(deadline.ms));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      onExpire?.();
      reject(new DeadlineExceededError(deadline.ms));
    };
    deadline.signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        deadline.signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        deadline.signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Stream-read a fetch body up to `maxBytes`. Past the cap the reader is cancelled
 * and `onOverflow` runs (callers abort the underlying connection there), then
 * ResponseTooLargeError is thrown — the excess is never accumulated.
 */
export async function readBodyBounded(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  onOverflow: () => void,
): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      onOverflow();
      reader.cancel().catch(() => undefined);
      throw new ResponseTooLargeError(maxBytes);
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks, total);
}

type FetchImpl = typeof fetch;
type FetchInit = Parameters<typeof fetch>[1];
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

export interface BoundedFetchOptions {
  /** Wall-clock budget for connect + headers + the WHOLE body. */
  readonly deadlineMs: number;
  /** Largest body accepted; the transfer is aborted the moment it passes this. */
  readonly maxBytes: number;
  /** Injection seam for tests; defaults to the global (undici) fetch. */
  readonly fetchImpl?: FetchImpl;
}

/** Statuses a Response may not be constructed with a body for. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * fetch() with one deadline over the whole exchange and a byte cap on the body.
 * Resolves to a Response whose body is ALREADY fully read (so a later `.json()` /
 * `.text()` is instant and cannot block). Throws DeadlineExceededError or
 * ResponseTooLargeError; any other fetch failure propagates unchanged.
 */
export async function fetchBounded(
  url: string,
  init: FetchInit,
  options: BoundedFetchOptions,
): Promise<FetchResponse> {
  const { deadlineMs, maxBytes } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const deadline = startDeadline(deadlineMs);
  // One controller aborts the connection for EITHER reason (deadline or cap), so
  // an oversized body stops downloading instead of draining in the background.
  const controller = new AbortController();
  const abortOnDeadline = (): void => controller.abort();
  deadline.signal.addEventListener('abort', abortOnDeadline, { once: true });
  const callerSignal = init?.signal ?? null;
  const abortOnCaller = (): void => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', abortOnCaller, { once: true });
  }
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      controller.abort();
      throw new ResponseTooLargeError(maxBytes);
    }
    const body = await readBodyBounded(res.body, maxBytes, () => controller.abort());
    return new Response(NULL_BODY_STATUSES.has(res.status) ? null : body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  } catch (err) {
    if (err instanceof ResponseTooLargeError) throw err;
    if (deadline.expired()) throw new DeadlineExceededError(deadlineMs);
    throw err;
  } finally {
    deadline.clear();
    deadline.signal.removeEventListener('abort', abortOnDeadline);
    callerSignal?.removeEventListener('abort', abortOnCaller);
  }
}
