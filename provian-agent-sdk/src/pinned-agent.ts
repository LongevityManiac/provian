/**
 * The SDK's pinned dispatcher, accepted by every Node's built-in fetch from 20 through 26.
 *
 * The egress guard pins each request to the addresses it approved by handing fetch a `dispatcher`:
 * an `Agent` from the `undici` package whose connector resolves only to those addresses
 * (`pinned-connection.ts`, Security Invariant #6). Node's built-in fetch is a different undici,
 * bundled with Node, and it calls `dispatcher.dispatch(options, handler)`:
 *  - Node 20 / 22 / 24 (undici 6 and 7) hand over a handler with the classic callbacks
 *    (`onConnect`, `onHeaders`, `onData`, `onComplete`, `onError`) — the `undici@6` Agent's own API;
 *  - Node 26 (undici 8) hands over a handler with only the controller callbacks
 *    (`onRequestStart`, `onResponseStart`, `onResponseData`, `onResponseEnd`, `onResponseError`),
 *    which `undici@6` refuses (`UND_ERR_INVALID_ARG`, "invalid onError method") — so before this
 *    module every SDK egress through the built-in fetch, or through a caller's wrapper of it,
 *    failed on Node 26.
 *
 * `PinnedAgent` is that same `undici@6` Agent, connector and all, whose `dispatch` translates a
 * controller-style handler into the classic one — exactly the bridge `undici@7`'s own dispatcher
 * applies (`lib/handler/unwrap-handler.js`, MIT), with a header parser that never writes through a
 * prototype. A classic handler passes through untouched, so Node 20–24 behave byte-for-byte as before.
 * Nothing about WHERE a request may connect changes here: the connector is the pinned one.
 */
import type { Duplex } from 'node:stream';
import { Agent, type Dispatcher } from 'undici';

/** A parsed header block: lowercase name → value(s), on an object with no prototype to write through. */
export type ParsedHeaders = Record<string, string | string[]>;

/** The controller a controller-style handler drives the request with (undici ≥7 / Node 26 fetch). */
export interface DispatchController {
  abort(reason?: Error): void;
  pause(): void;
  resume(): void;
  readonly aborted: boolean;
  readonly paused: boolean;
  readonly reason: Error | null;
  rawHeaders: Buffer[] | string[] | null;
  rawTrailers: string[] | Buffer[] | null;
}

/** The controller-style callbacks (undici ≥7's handler API). */
export interface ControllerDispatchHandler {
  onRequestStart?(controller: DispatchController, context: unknown): void;
  onRequestUpgrade?(controller: DispatchController, statusCode: number, headers: ParsedHeaders, socket: Duplex): void;
  onResponseStarted?(): void;
  onResponseStart?(controller: DispatchController, statusCode: number, headers: ParsedHeaders, statusMessage?: string): void;
  onResponseData?(controller: DispatchController, chunk: Buffer): void;
  onResponseEnd?(controller: DispatchController, trailers: ParsedHeaders): void;
  onResponseError?(controller: DispatchController, error: Error): void;
}

/** True when `handler` speaks the controller API (undici ≥7's own test: an `onRequestStart`). */
export function isControllerHandler(handler: unknown): handler is ControllerDispatchHandler {
  return typeof handler === 'object' && handler !== null
    && typeof (handler as ControllerDispatchHandler).onRequestStart === 'function';
}

/**
 * Raw header pairs → `{ name: value | values }`, decoded latin1 as undici ≥7 does. The result has no
 * prototype and every name is defined as an own property, so `__proto__`, `constructor` or any other
 * name from a server can neither pollute a prototype nor break the parse.
 */
export function parseRawHeaderPairs(raw: ReadonlyArray<Buffer | string | (Buffer | string)[]> | null | undefined): ParsedHeaders {
  const out: ParsedHeaders = Object.create(null) as ParsedHeaders;
  if (!raw) return out;
  const text = (v: Buffer | string): string => (typeof v === 'string' ? v : v.toString('latin1'));
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const nameRaw = raw[i], valueRaw = raw[i + 1];
    if (Array.isArray(nameRaw)) continue;
    const name = text(nameRaw).toLowerCase();
    const values = Array.isArray(valueRaw) ? valueRaw.map(text) : [text(valueRaw)];
    const prior = Object.prototype.hasOwnProperty.call(out, name) ? out[name] : undefined;
    const next = prior === undefined
      ? (values.length === 1 ? values[0] : values)
      : [...(typeof prior === 'string' ? [prior] : prior), ...values];
    Object.defineProperty(out, name, { value: next, enumerable: true, configurable: true, writable: true });
  }
  return out;
}

class BridgeController implements DispatchController {
  #paused = false;
  #aborted = false;
  #reason: Error | null = null;
  readonly #abort: (reason?: Error) => void;
  resumeRead: (() => void) | null = null;
  rawHeaders: Buffer[] | string[] | null = null;
  rawTrailers: string[] | Buffer[] | null = null;

  constructor(abort: (reason?: Error) => void) { this.#abort = abort; }
  pause(): void { this.#paused = true; }
  resume(): void {
    if (this.#paused) { this.#paused = false; this.resumeRead?.(); }
  }
  abort(reason?: Error): void {
    if (this.#aborted) return;
    this.#aborted = true;
    this.#reason = reason ?? null;
    this.#abort(reason);
  }
  get aborted(): boolean { return this.#aborted; }
  get paused(): boolean { return this.#paused; }
  get reason(): Error | null { return this.#reason; }
}

/** A controller-style handler as the classic callbacks the `undici@6` Agent drives (undici ≥7's UnwrapHandler). */
export function classicHandlerFor(handler: ControllerDispatchHandler): Dispatcher.DispatchHandlers {
  let controller: BridgeController | null = null;
  const live = (): BridgeController => (controller ??= new BridgeController(() => undefined));
  return {
    onConnect(abort: (err?: Error) => void, context?: unknown): void {
      controller = new BridgeController(abort);
      handler.onRequestStart?.(controller, context);
    },
    onResponseStarted(): void { handler.onResponseStarted?.(); },
    onUpgrade(statusCode: number, rawHeaders: Buffer[] | string[] | null, socket: Duplex): void {
      const c = live();
      c.rawHeaders = rawHeaders;
      handler.onRequestUpgrade?.(c, statusCode, parseRawHeaderPairs(rawHeaders), socket);
    },
    onHeaders(statusCode: number, rawHeaders: Buffer[], resume: () => void, statusText: string): boolean {
      const c = live();
      c.resumeRead = resume;
      c.rawHeaders = rawHeaders;
      handler.onResponseStart?.(c, statusCode, parseRawHeaderPairs(rawHeaders), statusText);
      return !c.paused;
    },
    onData(chunk: Buffer): boolean {
      const c = live();
      handler.onResponseData?.(c, chunk);
      return !c.paused;
    },
    onComplete(rawTrailers: string[] | null): void {
      const c = live();
      c.rawTrailers = rawTrailers;
      handler.onResponseEnd?.(c, parseRawHeaderPairs(rawTrailers));
    },
    onError(err: Error): void {
      if (typeof handler.onResponseError !== 'function') throw new Error('invalid onError method');
      handler.onResponseError(live(), err);
    },
  };
}

/** The pinned `undici@6` Agent, speaking both handler APIs (see the module comment). */
export class PinnedAgent extends Agent {
  override dispatch(options: Agent.DispatchOptions, handler: Dispatcher.DispatchHandlers): boolean {
    return super.dispatch(options, isControllerHandler(handler) ? classicHandlerFor(handler) : handler);
  }
}
