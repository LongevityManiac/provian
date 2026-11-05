/**
 * Commons avatar proxy (F30).
 *
 * A Commons profile's `avatar_url` is attacker-controlled. Before this, the phone
 * loaded it DIRECTLY as an <Image> source, so every human who opened the Commons
 * registry disclosed their IP + user-agent + browsing time to whatever host the
 * registrant chose (a tracking pixel). The registry now hands the phone a
 * RELAY-side proxy URL instead; the relay fetches the real image server-side and
 * streams it back, so a registrant only ever sees the relay's IP.
 *
 * The server-side fetch is an outbound request, so it obeys Security Invariant #6:
 * https-only, resolve-and-validate against the shared private-IP blocklist, pin
 * the socket to the validated address (no DNS-rebinding TOCTOU — https.request
 * honours the agent lookup, unlike undici fetch), do NOT follow redirects, cap the
 * response size, and require an image content-type. Any failure returns null and
 * the route answers 404 — "Unknown = Block".
 */

import { createHash } from 'crypto';
import { Resolver } from 'dns/promises';
import net from 'net';
import { Agent as HttpsAgent, request as httpsRequest } from 'https';
import { URL } from 'url';
import { isPrivateIp } from '../net/private-ip';
import { pinnedLookup } from '../net/pinned-lookup';
import { startDeadline, raceDeadline, type Deadline } from '../net/bounded-fetch';

/** Max avatar payload the proxy will buffer (2 MiB). */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
/** Socket-IDLE timeout (ms): no bytes in either direction for this long aborts. */
export const AVATAR_FETCH_TIMEOUT_MS = 5000;
/**
 * WALL-CLOCK deadline (ms) for the whole fetch — DNS + connect + TLS +
 * headers + the full body. The idle timeout above alone let an upstream that
 * trickles a byte inside every idle window hold a request (and up to 2 MiB) for
 * hours; this bounds every avatar fetch absolutely.
 */
export const AVATAR_DEADLINE_MS = 8000;
/** Per-query DNS timeout handed to the resolver (the deadline still bounds it). */
export const AVATAR_DNS_TIMEOUT_MS = 2000;
/** Raster image types only. SVG is deliberately excluded (active content). */
export const AVATAR_ALLOWED_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/avif',
]);

export interface FetchedAvatar {
  readonly contentType: string;
  readonly body: Buffer;
}

/** Optional injection seams for tests. Production passes none of them. */
export interface AvatarProxyDeps {
  /** Resolve a hostname to A + AAAA addresses (default: c-ares Resolver, deadline-bounded). */
  resolveHostname?: (hostname: string) => Promise<string[]>;
  /** Override the wall-clock deadline (default AVATAR_DEADLINE_MS). */
  deadlineMs?: number;
  /**
   * Build the https.Agent that pins the socket to the VALIDATED address (default:
   * `new HttpsAgent({ lookup: pinnedLookup(ip) })`). Tests use it to point the pin at a
   * local TLS server; it runs only after the SSRF validation has passed.
   */
  agentForPinnedIp?: (pinnedIp: string) => HttpsAgent;
}

async function defaultResolve(hostname: string, deadline: Deadline): Promise<string[]> {
  // A dedicated resolver per lookup so the deadline can CANCEL its queries.
  const resolver = new Resolver({ timeout: AVATAR_DNS_TIMEOUT_MS, tries: 1 });
  const onAbort = (): void => resolver.cancel();
  deadline.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const [v4, v6] = await Promise.all([
      resolver.resolve4(hostname).catch(() => [] as string[]),
      resolver.resolve6(hostname).catch(() => [] as string[]),
    ]);
    return [...v4, ...v6];
  } finally {
    deadline.signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Fetch a validated https avatar URL server-side, SSRF-guarded and pinned, under one
 * wall-clock deadline. Returns null (never throws) on any validation, network,
 * deadline, size, or type failure.
 */
export async function fetchProxiedAvatar(
  rawUrl: string,
  deps: AvatarProxyDeps = {},
): Promise<FetchedAvatar | null> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;

  const deadline = startDeadline(deps.deadlineMs ?? AVATAR_DEADLINE_MS);
  try {
    // URL.hostname keeps the brackets on an IPv6 literal ("[::1]"); strip them so
    // net.isIP recognises the literal and the private-IP guard fires without a DNS
    // lookup.
    const hostname = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');
    let addresses: string[];
    if (net.isIP(hostname)) {
      if (isPrivateIp(hostname)) return null;
      addresses = [hostname];
    } else {
      try {
        addresses = await raceDeadline(
          deps.resolveHostname ? deps.resolveHostname(hostname) : defaultResolve(hostname, deadline),
          deadline,
        );
      } catch {
        return null; // DNS failure or DNS outlived the deadline — Unknown = Block.
      }
      if (addresses.length === 0) return null;
      for (const addr of addresses) {
        if (isPrivateIp(addr)) return null;
      }
    }

    // Pin the connection to the validated address so DNS cannot rebind between
    // validate and connect. Family derived from the pinned IP.
    const pinnedIp = addresses[0];
    const agent = deps.agentForPinnedIp
      ? deps.agentForPinnedIp(pinnedIp)
      : new HttpsAgent({ lookup: pinnedLookup(pinnedIp) });

    try {
      return await new Promise<FetchedAvatar | null>((resolve) => {
        let settled = false;
        const finish = (value: FetchedAvatar | null): void => {
          if (settled) return;
          settled = true;
          deadline.signal.removeEventListener('abort', onDeadline);
          resolve(value);
        };
        const outbound = httpsRequest(rawUrl, { method: 'GET', agent, timeout: AVATAR_FETCH_TIMEOUT_MS }, (response) => {
          const status = response.statusCode ?? 0;
          // Do NOT follow redirects — a 3xx to a private/other host is an SSRF
          // vector, so a non-2xx is simply "no avatar".
          if (status < 200 || status >= 300) {
            response.resume();
            finish(null);
            return;
          }
          const contentType = String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
          if (!AVATAR_ALLOWED_CONTENT_TYPES.has(contentType)) {
            response.resume();
            finish(null);
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          response.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > AVATAR_MAX_BYTES) {
              outbound.destroy(new Error('avatar_too_large'));
              finish(null);
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => finish({ contentType, body: Buffer.concat(chunks) }));
          response.on('error', () => finish(null));
          response.on('aborted', () => finish(null));
        });
        // The wall-clock deadline: whatever phase the exchange is in (connect, TLS,
        // headers, body), tear the socket down and answer "no avatar".
        const onDeadline = (): void => {
          outbound.destroy(new Error('avatar_deadline'));
          finish(null);
        };
        if (deadline.signal.aborted) onDeadline();
        else deadline.signal.addEventListener('abort', onDeadline, { once: true });
        outbound.on('timeout', () => outbound.destroy(new Error('avatar_timeout')));
        outbound.on('error', () => finish(null));
        outbound.end();
      });
    } finally {
      agent.destroy();
    }
  } finally {
    deadline.clear();
  }
}

// ─── Route-side bounds ─────────────────────────────────────────────

/**
 * Per-transport-IP requests per minute on the public avatar route. A registry page
 * renders one avatar per visible profile and the response carries a one-hour
 * client Cache-Control, so a real viewer stays far below this.
 */
export const AVATAR_RATE_LIMIT_PER_MIN = 120;
/** How long a fetched avatar is served from cache. */
export const AVATAR_CACHE_HIT_TTL_S = 300;
/** How long a FAILED fetch (deadline, too large, wrong type, SSRF refusal) is remembered. */
export const AVATAR_CACHE_MISS_TTL_S = 60;
/** Larger avatars are served but not cached (keeps each cache value small). */
export const AVATAR_CACHE_MAX_BYTES = 256 * 1024;

/** The two cache operations the helper needs (RedisCache satisfies it). */
export interface AvatarCache {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
}

/** Parse a cached entry: undefined = no usable entry (fetch), null = a cached failure. */
function readCachedAvatar(raw: unknown): FetchedAvatar | null | undefined {
  if (raw === null || raw === undefined) return undefined;
  let entry: unknown = raw;
  if (typeof raw === 'string') {
    try {
      entry = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (!entry || typeof entry !== 'object') return undefined;
  const e = entry as { ok?: unknown; ct?: unknown; b64?: unknown };
  if (e.ok === false) return null;
  if (e.ok === true && typeof e.ct === 'string' && AVATAR_ALLOWED_CONTENT_TYPES.has(e.ct) && typeof e.b64 === 'string') {
    return { contentType: e.ct, body: Buffer.from(e.b64, 'base64') };
  }
  return undefined;
}

/**
 * Serve an avatar through a short cache keyed on (wallet, sha256(avatar_url)) — a
 * profile that changes its avatar_url is never served the old image. Both outcomes
 * are cached: a success for AVATAR_CACHE_HIT_TTL_S (when small), a failure for
 * AVATAR_CACHE_MISS_TTL_S, so a slow or hostile host costs at most one bounded
 * fetch per window.
 */
export async function fetchAvatarCached(
  cache: AvatarCache,
  walletId: string,
  avatarUrl: string,
  fetchAvatar: (url: string) => Promise<FetchedAvatar | null>,
): Promise<FetchedAvatar | null> {
  const digest = createHash('sha256').update(avatarUrl).digest('hex').slice(0, 32);
  const cacheKey = `commons:avatar:v1:${walletId}:${digest}`;
  const cached = readCachedAvatar(await cache.get<unknown>(cacheKey));
  if (cached !== undefined) return cached;

  const fetched = await fetchAvatar(avatarUrl);
  if (fetched === null) {
    await cache.set(cacheKey, JSON.stringify({ ok: false }), AVATAR_CACHE_MISS_TTL_S);
  } else if (fetched.body.length <= AVATAR_CACHE_MAX_BYTES) {
    await cache.set(
      cacheKey,
      JSON.stringify({ ok: true, ct: fetched.contentType, b64: fetched.body.toString('base64') }),
      AVATAR_CACHE_HIT_TTL_S,
    );
  }
  return fetched;
}
