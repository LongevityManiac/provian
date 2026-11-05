/**
 * pkg-owner-resolver — `pkg:` owner resolution via registry lookup (Trust Layer build, the operator
 * 2026-09-16 §2.11). The owner of a package origin is its PUBLISHER — the registry user that
 * published the cited version (`versions[v]._npmUser.name`), falling back to the package's first
 * maintainer. Expressed as the owner party `npm-user:<login>` so a package a signer publishes
 * itself resolves same-party only if the signer's identity set carries that login (it does not
 * today — the fence is conservative: an unknown publisher is an INDEPENDENT external party, which
 * is what a third-party dependency is).
 *
 * Rule-by-identifier-type, not a catalog: only the npm registry today (the coordinates the SDK
 * emits are `pkg:npm:<name>[@<version>]`); another registry is another rule, additive.
 *
 * Best-effort and fail-closed: a registry failure, an unknown package, or a malformed coordinate
 * resolves to `null` (recorded, counts zero — never guessed). Lookups are cached (Redis, 24 h) so
 * the accrual never spends more than one registry round-trip per package version per day.
 */

import type { RedisCache } from '../../cache';
import type { InputOrigin } from '../provenance/input-origins';

const PKG_NPM_RE = /^(?:pkg:npm[:/]|npm:)(@?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?)(?:@([0-9A-Za-z.+-]{1,64}))?$/i;
const CACHE_TTL_SECONDS = 24 * 60 * 60;
const REGISTRY = 'https://registry.npmjs.org';
const FETCH_TIMEOUT_MS = 4000;
/** Uncached registry lookups per resolve call (one PE): bounded egress. */
export const MAX_PKG_LOOKUPS_PER_PE = 8;

export interface ParsedNpmCoordinate {
  readonly name: string;
  readonly version: string | null;
}

export function parseNpmCoordinate(originIdentifier: string): ParsedNpmCoordinate | null {
  const m = PKG_NPM_RE.exec(originIdentifier.trim());
  if (!m) return null;
  return { name: m[1].toLowerCase(), version: m[2] ?? null };
}

export function npmOwner(login: string): string {
  return `npm-user:${login.toLowerCase()}`;
}

type Fetcher = (url: string, init: { signal: AbortSignal; redirect: 'manual' }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** Look one coordinate up (uncached). Exported for the RED controls. */
export async function lookupNpmPublisher(
  coord: ParsedNpmCoordinate,
  fetcher: Fetcher = fetch as unknown as Fetcher,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const encoded = coord.name.startsWith('@')
      ? `@${encodeURIComponent(coord.name.slice(1))}`
      : encodeURIComponent(coord.name);
    // `redirect:'manual'`: the pinned registry host is the whole allowlist; a redirect is refused.
    const res = await fetcher(`${REGISTRY}/${encoded}`, { signal: controller.signal, redirect: 'manual' });
    if (!res.ok) return null;
    const doc = await res.json() as {
      versions?: Record<string, { _npmUser?: { name?: unknown } }>;
      maintainers?: Array<{ name?: unknown }>;
      'dist-tags'?: { latest?: unknown };
    };
    const v = coord.version
      ?? (typeof doc['dist-tags']?.latest === 'string' ? doc['dist-tags']!.latest : null);
    const user = v && doc.versions?.[v]?._npmUser?.name;
    if (typeof user === 'string' && user.length > 0) return npmOwner(user);
    const maintainer = doc.maintainers?.[0]?.name;
    if (typeof maintainer === 'string' && maintainer.length > 0) return npmOwner(maintainer);
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve every `pkg:`/`npm:` origin among `origins` to an owner party (or null). Cached per
 * coordinate. Never throws; a cache outage degrades to a direct lookup, and a lookup failure to null.
 */
export async function resolvePkgOwners(
  cache: RedisCache | null | undefined,
  origins: readonly InputOrigin[],
  fetcher?: Fetcher,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  let lookups = 0;
  for (const o of origins) {
    const id = o.origin_identifier;
    if (out.has(id)) continue;
    const coord = parseNpmCoordinate(id);
    if (coord === null) continue;
    const key = `pkgowner:npm:${coord.name}@${coord.version ?? 'latest'}`;
    let cached: string | null | undefined;
    try {
      cached = (await cache?.get<string | null>(key)) ?? undefined;
      if (cached === undefined) {
        const marker = await cache?.get<string>(`${key}:miss`);
        if (marker === 'miss') cached = null;
      }
    } catch {
      cached = undefined;
    }
    if (cached !== undefined) { out.set(id, cached); continue; }
    // Past the per-PE bound the coordinate stays UNRESOLVED (null owner → the origin records
    // unresolved, never guessed); it is not cached as a miss so a later PE can still resolve it.
    if (lookups >= MAX_PKG_LOOKUPS_PER_PE) { out.set(id, null); continue; }
    lookups += 1;
    const owner = await lookupNpmPublisher(coord, fetcher);
    out.set(id, owner);
    try {
      if (owner !== null) await cache?.set(key, owner, CACHE_TTL_SECONDS);
      else await cache?.set(`${key}:miss`, 'miss', CACHE_TTL_SECONDS);
    } catch {
      // best-effort cache
    }
  }
  return out;
}
