/**
 * Domain requester key discovery — the relay's ONE outbound fetch for signed challenges.
 *
 * When a presenter produces a presentation against a challenge SIGNED by a domain requester, the
 * relay verifies that signature at issuance against the requester's published key at
 * `https://<domain>/.well-known/provian-requester.json`, so the v2 presentation it co-signs names a
 * VERIFIED requester. That makes this an outbound request, so it obeys Security Invariant #6 the
 * same way the Commons avatar proxy does: https only, resolve-and-validate every address against the
 * shared private-IP blocklist, pin the socket to the validated address (no DNS-rebinding TOCTOU), no
 * redirects, a size cap, a timeout, and fail-closed on anything unexpected.
 *
 * Only the AUTHENTICATED `/present` routes reach this (a presenter with a recorded burn). The public
 * `/v1/present/verify` route never fetches off-relay. Results are cached briefly per domain so one
 * requester's popularity cannot turn the relay into a request amplifier.
 */

import dns from 'dns/promises';
import net from 'net';
import { Agent as HttpsAgent, request as httpsRequest } from 'https';
import { isPrivateIp } from '../net/private-ip';
import { pinnedLookup } from '../net/pinned-lookup';
import { parseRequesterKeyDocument, REQUESTER_WELL_KNOWN_PATH, type RequesterJwk } from './challenge';

export const REQUESTER_KEYS_MAX_BYTES = 64 * 1024;
export const REQUESTER_KEYS_TIMEOUT_MS = 5000;
export const REQUESTER_KEYS_CACHE_MS = 5 * 60 * 1000;
/** The DNS step's own bound (the transfer is bounded by REQUESTER_KEYS_TIMEOUT_MS end to end). */
export const REQUESTER_KEYS_DNS_TIMEOUT_MS = 3000;

/** Race a promise against a deadline; on expiry reject (never a silent success). */
function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
  });
  return Promise.race([p, expiry]).finally(() => { if (timer) clearTimeout(timer); });
}

const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export interface RequesterKeyFetchDeps {
  /** Resolve a hostname to A + AAAA addresses (test seam). */
  readonly resolveHostname?: (hostname: string) => Promise<string[]>;
  /** Perform the pinned GET (test seam). Resolves the body, or null on any non-2xx / failure. */
  readonly get?: (url: string, pinnedIp: string) => Promise<Buffer | null>;
  readonly nowMs?: () => number;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const [v4, v6] = await Promise.all([
    dns.resolve4(hostname).catch(() => [] as string[]),
    dns.resolve6(hostname).catch(() => [] as string[]),
  ]);
  return [...v4, ...v6];
}

function pinnedGet(url: string, pinnedIp: string): Promise<Buffer | null> {
  const agent = new HttpsAgent({ lookup: pinnedLookup(pinnedIp) });
  return new Promise<Buffer | null>((resolve) => {
    // An END-TO-END deadline : the socket `timeout` below is only an idle timer, so a
    // server trickling one byte just under it would otherwise hold the request open indefinitely.
    let done = false;
    const finish = (v: Buffer | null) => { if (!done) { done = true; clearTimeout(deadline); resolve(v); } };
    const deadline = setTimeout(() => { outbound.destroy(new Error('deadline')); finish(null); }, REQUESTER_KEYS_TIMEOUT_MS);
    const outbound = httpsRequest(url, { method: 'GET', agent, timeout: REQUESTER_KEYS_TIMEOUT_MS, headers: { accept: 'application/json' } }, (response) => {
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) { response.resume(); finish(null); return; } // no redirects
      const chunks: Buffer[] = [];
      let total = 0;
      response.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > REQUESTER_KEYS_MAX_BYTES) { outbound.destroy(new Error('too_large')); finish(null); return; }
        chunks.push(chunk);
      });
      response.on('end', () => finish(Buffer.concat(chunks)));
      response.on('error', () => finish(null));
    });
    outbound.on('timeout', () => outbound.destroy(new Error('timeout')));
    outbound.on('error', () => finish(null));
    outbound.end();
  }).finally(() => agent.destroy());
}

const cache = new Map<string, { keys: RequesterJwk[]; atMs: number }>();

/** Test-only: clear the per-domain cache. */
export function clearRequesterKeyCache(): void {
  cache.clear();
}

/**
 * Fetch a domain requester's Ed25519 keys, SSRF-guarded. Throws on any failure (the caller maps a
 * throw to `requester_key_unreachable`, never to a verified identity).
 */
export async function fetchRequesterKeysGuarded(domain: string, deps: RequesterKeyFetchDeps = {}): Promise<RequesterJwk[]> {
  if (!DOMAIN_RE.test(domain)) throw new Error('requester domain is not a DNS hostname');
  const now = deps.nowMs ? deps.nowMs() : Date.now();
  const hit = cache.get(domain);
  if (hit && now - hit.atMs < REQUESTER_KEYS_CACHE_MS) return hit.keys;

  const addresses = await withDeadline((deps.resolveHostname ?? defaultResolve)(domain), REQUESTER_KEYS_DNS_TIMEOUT_MS, 'requester domain resolution');
  if (addresses.length === 0) throw new Error('requester domain does not resolve');
  for (const addr of addresses) {
    if (!net.isIP(addr) || isPrivateIp(addr)) throw new Error('requester domain resolves to a private address');
  }
  const url = `https://${domain}${REQUESTER_WELL_KNOWN_PATH}`;
  // The injected `get` seam gets the same end-to-end bound as the pinned GET.
  const body = await withDeadline((deps.get ?? pinnedGet)(url, addresses[0]), REQUESTER_KEYS_TIMEOUT_MS + 250, 'requester key fetch')
    .catch(() => null);
  if (!body) throw new Error('requester key document unreachable');
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { throw new Error('requester key document is not JSON'); }
  const keys = parseRequesterKeyDocument(parsed);
  if (keys.length === 0) throw new Error('requester key document has no Ed25519 keys');
  cache.set(domain, { keys, atMs: now });
  return keys;
}
