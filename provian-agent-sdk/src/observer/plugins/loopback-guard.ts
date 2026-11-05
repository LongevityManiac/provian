/**
 * loopback-guard — the one request screen shared by the daemon's loopback
 * listeners (OTLP receiver 4318, model proxy 4320)..
 *
 * THE RULE (the operator, as restated 2026-09-26): any local process on a
 * registered device still posts with no user step; a web page in a browser cannot.
 * Binding 127.0.0.1 keeps remote hosts out, but a page the user has open is ALSO
 * "on this machine" it can POST a CORS simple request (text/plain, no-cors) to
 * 127.0.0.1 and the listener would queue a PE, and a DNS-rebinding page can read
 * responses. This screen separates the two populations by what only a browser does:
 *
 * 1. BROWSER-ONLY HEADERS → 403. A browser sends `Origin` on every non-GET/HEAD
 * request and on every CORS-mode request, and current engines send the
 * `Sec-Fetch-Site` / `Sec-Fetch-Dest` (and `Sec-Fetch-User`) metadata on every
 * request to a potentially-trustworthy URL (127.0.0.1 and localhost are).
 * curl, Python, Go, Rust and Node's `http` module send none of them.
 * `Sec-Fetch-Mode` is the one exception that needs care: Node's built-in
 * `fetch` (undici) sends `sec-fetch-mode: cors` BY ITSELF (measured on Node 20
 * and 26), so a local Node client using it looks like that. A browser never
 * sends Mode without Site + Dest, so a lone `sec-fetch-mode: cors` is admitted
 * and any other Mode value (navigate / no-cors / same-origin / websocket) is
 * refused.
 * 2. HOST MUST BE LOOPBACK → 403. The Host header must be exactly
 * `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>` for the port the
 * connection arrived on. A DNS-rebinding page's requests carry the attacker's
 * hostname in Host, so they never reach a handler.
 * 3. CONTENT-TYPE ESSENCE (where the listener takes a structured body) → 415.
 * The MIME type is PARSED (type/subtype before any `;` parameters, token
 * characters only) and compared exactly — never a substring test, so
 * `text/plain; application/json` is `text/plain`. The browser-forgeable simple
 * types (`text/plain`, `application/x-www-form-urlencoded`,
 * `multipart/form-data`) therefore never match.
 *
 * No listener ever emits an `Access-Control-Allow-*` header, so OPTIONS never
 * grants CORS; a preflight carries `Origin` and is refused at step 1 anyway.
 */

import type { IncomingHttpHeaders } from 'http';

export interface LoopbackRefusal {
  status: 403 | 415;
  error: 'browser_request_refused' | 'host_not_loopback' | 'unsupported_media_type';
}

/** Headers only a browser engine attaches. Any one present ⇒ refused. */
export const BROWSER_ONLY_HEADERS: readonly string[] = [
  'origin', 'sec-fetch-site', 'sec-fetch-dest', 'sec-fetch-user',
];

const MIME_TOKEN = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;

/**
 * The MIME type essence (`type/subtype`, lowercased) of a Content-Type value, or
 * null when absent or unparseable. Parameters after the first `;` are dropped.
 */
export function mimeEssence(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  const raw = Array.isArray(value) ? value.join(',') : value;
  const essence = raw.split(';', 1)[0].trim().toLowerCase();
  const slash = essence.indexOf('/');
  if (slash <= 0 || slash !== essence.lastIndexOf('/')) return null;
  const type = essence.slice(0, slash);
  const subtype = essence.slice(slash + 1);
  if (!MIME_TOKEN.test(type) || !MIME_TOKEN.test(subtype)) return null;
  return essence;
}

/** True when a Host header names loopback on exactly `port`. */
export function isLoopbackHost(host: string | string[] | undefined, port: number | null | undefined): boolean {
  if (typeof host !== 'string' || typeof port !== 'number' || !Number.isFinite(port) || port <= 0) return false;
  const h = host.trim().toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`;
}

/** True when the request carries any header a browser (and only a browser) sends. */
export function carriesBrowserMarkers(headers: IncomingHttpHeaders): boolean {
  for (const name of BROWSER_ONLY_HEADERS) {
    if (headers[name] !== undefined) return true;
  }
  const mode = headers['sec-fetch-mode'];
  if (mode !== undefined) {
    // Node's undici fetch sends a lone `sec-fetch-mode: cors`; nothing else is admitted.
    const v = (Array.isArray(mode) ? mode.join(',') : mode).trim().toLowerCase();
    if (v !== 'cors') return true;
  }
  return false;
}

export interface LoopbackScreenOptions {
  /** The local port the connection arrived on (`req.socket.localPort`). */
  port: number | null | undefined;
  /**
   * Accepted Content-Type essences. When set, a request whose essence is not in
   * the list (or has none) is refused 415. Omit for a listener that forwards
   * arbitrary bodies (the model proxy — see ModelProxyPlugin).
   */
  contentTypes?: readonly string[];
}

/**
 * Screen one request. Returns the refusal to send, or null to proceed. Browser
 * markers and Host are checked first, so a browser request is refused with 403
 * whatever its path, method or body.
 */
export function screenLoopbackRequest(
  req: { headers: IncomingHttpHeaders },
  opts: LoopbackScreenOptions,
): LoopbackRefusal | null {
  if (carriesBrowserMarkers(req.headers)) return { status: 403, error: 'browser_request_refused' };
  if (!isLoopbackHost(req.headers.host, opts.port)) return { status: 403, error: 'host_not_loopback' };
  if (opts.contentTypes) {
    const essence = mimeEssence(req.headers['content-type']);
    if (essence === null || !opts.contentTypes.includes(essence)) {
      return { status: 415, error: 'unsupported_media_type' };
    }
  }
  return null;
}

/** Screen only the parts that apply to every request (no body type check). */
export function screenBrowserAndHost(
  req: { headers: IncomingHttpHeaders },
  port: number | null | undefined,
): LoopbackRefusal | null {
  return screenLoopbackRequest(req, { port });
}
