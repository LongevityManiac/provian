/** The sole SDK HTTP egress transport: validated DNS bound to the socket, redirects refused. */
import { pinnedConnector, proxyFor, proxyUrlOf } from './pinned-connection';
import { PinnedAgent } from './pinned-agent';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { validateEgressTarget, type HostResolver } from './egress-guard';

/** The guard refused the destination before any byte left the machine. */
export class EgressRefusedError extends Error {
  readonly code: string;
  constructor(code: string | undefined, reason: string | undefined) {
    super(`egress refused: ${code}: ${reason}`);
    this.name = 'EgressRefusedError';
    this.code = `EGRESS_${code ?? 'REFUSED'}`;
  }
}

export interface GuardedFetchOptions {
  readonly fetchFn?: typeof globalThis.fetch;
  readonly resolveHost?: HostResolver;
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * DNS-over-HTTPS resolvers, addressed by IP so reaching them needs no DNS. Each serves the
 * dns-json shape at the path named here, and each certificate carries its IP as a SAN.
 */
export const DOH_RESOLVERS: readonly string[] = [
  'https://1.1.1.1/dns-query',
  'https://8.8.8.8/resolve',
];

const DOH_TIMEOUT_MS = 8_000;

/**
 * Resolve `hostname` over DNS-over-HTTPS, carried by the same forward proxy as the request.
 *
 * A box whose only egress is a forward proxy often has no DNS of its own (a hosted agent's
 * runtime cell: `getaddrinfo` answers EAI_AGAIN). curl hands the name to the proxy; the guard
 * cannot, because it must check the destination's addresses and pin the tunnel to them
 * (Security Invariant #6). So the guard asks a public resolver, through the proxy, over TLS —
 * and the answer is checked against the blocklist and pinned exactly like a local answer.
 * Returns [] when no resolver answers (the guard then refuses: unknown = block).
 */
/** Successful DNS-over-HTTPS answers, kept for their TTL (at most 5 minutes). */
const DOH_CACHE_MAX_MS = 5 * 60 * 1000;
const dohCache = new Map<string, { ips: string[]; untilMs: number }>();

/** Test seam: forget cached DNS-over-HTTPS answers. */
export function clearDohCache(): void { dohCache.clear(); }

export async function resolveViaDoh(
  hostname: string,
  fetchFn?: typeof globalThis.fetch,
): Promise<string[]> {
  const key = hostname.toLowerCase();
  const cached = dohCache.get(key);
  if (cached && cached.untilMs > Date.now()) return [...cached.ips];
  for (const base of DOH_RESOLVERS) {
    for (const type of ['A', 'AAAA'] as const) {
      try {
        const res = await guardedFetch(
          `${base}?name=${encodeURIComponent(hostname)}&type=${type}`,
          { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(DOH_TIMEOUT_MS) },
          { fetchFn },
        );
        if (!res.ok) { void res.body?.cancel().catch(() => undefined); continue; }
        const body = await res.json() as { Status?: unknown; Answer?: unknown };
        if (body.Status !== 0 || !Array.isArray(body.Answer)) continue;
        const want = type === 'A' ? 1 : 28;
        const records = body.Answer
          .filter((a): a is { type: number; data: string; TTL?: number } => typeof a === 'object' && a !== null
            && (a as { type?: unknown }).type === want && typeof (a as { data?: unknown }).data === 'string')
          .filter(a => isIP(a.data) === (type === 'A' ? 4 : 6));
        const ips = records.map(a => a.data);
        if (ips.length) {
          const ttls = records.map(a => (typeof a.TTL === 'number' && a.TTL >= 0 ? a.TTL * 1000 : 0));
          const ttlMs = Math.min(DOH_CACHE_MAX_MS, ...ttls);
          if (ttlMs > 0) dohCache.set(key, { ips: [...ips], untilMs: Date.now() + ttlMs });
          return ips;
        }
      } catch { /* next resolver */ }
    }
  }
  return [];
}

/**
 * A fake-IP gateway's answer: every name resolves into 198.18.0.0/15 (the benchmark range,
 * RFC 2544), and the gateway maps that address back to the name when the box connects. Such an
 * answer says nothing about where the name really points, so the guard cannot check it.
 */
export function isFakeIpAnswer(ips: readonly string[]): boolean {
  if (ips.length === 0) return false;
  return ips.every((ip) => {
    const m = /^(?:::ffff:)?198\.(18|19)\.(\d{1,3})\.(\d{1,3})$/i.exec(ip);
    return m !== null;
  });
}

/**
 * The resolver the guard uses for `url`, so a destination's REAL addresses are what it checks
 * and pins (Security Invariant #6):
 *  - the box's own DNS answer, when it is a real answer (any blocked address in it refuses);
 *  - DNS-over-HTTPS when that answer is a fake-IP gateway's (all in 198.18.0.0/15): the real
 *    addresses are checked and the connection is pinned to them, never to the gateway's
 *    stand-in address;
 *  - DNS-over-HTTPS through the forward proxy when the box has no DNS at all and a proxy
 *    carries the request. With no proxy and no DNS: no address, refused (unknown = block).
 */
export function egressResolver(url: string, fetchFn?: typeof globalThis.fetch): HostResolver {
  let proxied = false;
  let schemeProxySet = false;
  // The variable names in effect, as proxyFor reads them (lowercase wins), so a message names
  // the one the person must change.
  let proxyVar = 'HTTPS_PROXY';
  const noProxyVar = process.env.no_proxy ? 'no_proxy' : 'NO_PROXY';
  try {
    const parsed = new URL(url);
    proxied = Boolean(proxyFor(parsed));
    const https = parsed.protocol === 'https:';
    proxyVar = https ? (process.env.https_proxy ? 'https_proxy' : 'HTTPS_PROXY') : (process.env.http_proxy ? 'http_proxy' : 'HTTP_PROXY');
    // The proxy that would carry this scheme (as proxyFor reads it), before NO_PROXY applies.
    schemeProxySet = Boolean(https
      ? process.env.https_proxy || process.env.HTTPS_PROXY
      : process.env.http_proxy || process.env.HTTP_PROXY);
  } catch { proxied = false; }
  const proxyExcluded = !proxied && schemeProxySet;
  return async (hostname: string) => {
    let local: string[] = [];
    try { local = (await lookup(hostname, { all: true })).map(r => r.address); } catch { local = []; }
    if (local.length && !isFakeIpAnswer(local)) return local;
    if (local.length === 0 && !proxied) {
      throw new Error(proxyExcluded
        ? `no answer from this machine's DNS; a proxy is set but ${noProxyVar} sends this host direct, so no DNS-over-HTTPS lookup was tried`
        : 'no answer from this machine\'s DNS; no proxy set, so no DNS-over-HTTPS lookup was tried');
    }
    if (proxied && !proxyUrlOf(proxyFor(new URL(url)) ?? '')) {
      throw new Error(`${local.length ? 'this machine\'s DNS gave only a gateway stand-in address (198.18.0.0/15)' : 'no answer from this machine\'s DNS'}; the proxy setting (${proxyVar}) is not an http:// or https:// proxy, so no DNS-over-HTTPS lookup was tried`);
    }
    const real = await resolveViaDoh(hostname, fetchFn);
    if (real.length === 0) {
      throw new Error(local.length
        ? 'this machine\'s DNS gave only a gateway stand-in address (198.18.0.0/15); the DNS-over-HTTPS lookup (1.1.1.1, 8.8.8.8) got no answer'
        : 'no answer from this machine\'s DNS; the DNS-over-HTTPS lookup through the proxy (1.1.1.1, 8.8.8.8) got no answer');
    }
    return real;
  };
}

/**
 * No ambient dispatcher or later DNS lookup can change the approved destination.
 *
 * The pinned dispatcher is a `PinnedAgent` (`pinned-agent.ts`), which every Node's built-in fetch
 * from 20 through 26 accepts — so the default (built-in) fetch, an injected one, and a caller's own
 * wrapper that delegates to the built-in fetch all carry it, on every supported Node.
 */
export async function guardedFetch(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
  options: GuardedFetchOptions = {},
): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input);
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const resolveHost = options.resolveHost ?? egressResolver(url, options.fetchFn);
  const guard = await abortable(validateEgressTarget(url, { resolveHost }), signal);
  if (!guard.ok || !guard.resolvedIps?.length) throw new EgressRefusedError(guard.code, guard.reason);
  const connect = await abortable(pinnedConnector(new URL(url), guard.resolvedIps, options.resolveHost), signal);
  const dispatcher = new PinnedAgent({ connect });
  const cleanup = () => {
    signal?.removeEventListener('abort', cleanup);
    void dispatcher.destroy().catch(() => undefined);
  };
  signal?.addEventListener('abort', cleanup, { once: true });
  if (signal?.aborted) cleanup();
  try {
    const f = options.fetchFn ?? globalThis.fetch;
    const requestInit = { ...init, redirect: 'manual' as const, dispatcher };
    const res = await abortable(f(input, requestInit), signal);
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      void res.body?.cancel().catch(() => undefined);
      throw new Error('egress redirect refused');
    }
    if (!res.body) { cleanup(); return res; }
    const reader = res.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await abortable(reader.read(), signal);
          if (next.done) { controller.close(); cleanup(); }
          else controller.enqueue(next.value);
        } catch (err) { controller.error(err); cleanup(); void reader.cancel().catch(() => undefined); }
      },
      cancel(reason) { cleanup(); return reader.cancel(reason); },
    });
    const response = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    Object.defineProperty(response, 'url', { value: res.url || url });
    return response;
  } catch (err) { cleanup(); throw err; }
}

/** Wrap an injected HTTP implementation as well as the native default. */
export function guardedFetcher(fetchFn?: typeof globalThis.fetch, resolveHost?: HostResolver): typeof globalThis.fetch {
  if (fetchFn === guardedFetch && !resolveHost) return guardedFetch;
  return (input, init) => guardedFetch(input, init, { fetchFn, resolveHost });
}
