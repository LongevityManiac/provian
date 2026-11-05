/**
 * served-bundle — the ONE resolver of the bundle bytes THIS relay revision serves
 * at `/v1/bootstrap/agent.js`, and their sha256.
 *
 * (1B): self-update publish atomicity. The signed release manifest
 * (`release_manifest/current`, Firestore) names a bundle sha256 + length, but the
 * bundle it names is served from THIS revision's baked-in file. The manifest is
 * published to Firestore the instant `sign-release-manifest` runs, while the bundle
 * only changes when a new image deploys — so without a gate a daemon can fetch a
 * manifest whose bundle is not yet (or no longer) the one this revision serves, and
 * fail-close on `bundle_hash_mismatch`. The release-manifest route uses this resolver
 * to serve a manifest ONLY when its `bundle.sha256` equals the bundle this revision
 * serves, making publish atomic FROM THE DAEMON'S VIEW: it can never fetch a manifest
 * whose bundle is not already in place at its exact hash and length.
 *
 * The bytes are immutable within a revision (a single baked-in file), so the digest
 * is computed once per path and cached. Both `bootstrap.ts` (which serves the bytes)
 * and `release-manifest.ts` (which gates on the digest) resolve through here, so the
 * two provably agree on what "the served bundle" is.
 */

import * as fs from 'fs';
import { createHash } from 'crypto';

interface CacheEntry {
  bundle: Buffer;
  sha256: string;
}

const cacheByPath = new Map<string, CacheEntry>();

/** The path THIS revision serves the bundle from, or undefined when none is configured. */
export function servedBundlePath(explicit?: string): string | undefined {
  const p = (explicit && explicit.trim()) || process.env.BOOTSTRAP_BUNDLE_PATH;
  return p && p.trim().length > 0 ? p : undefined;
}

/** The served bundle bytes, or null when no bundle is configured/readable (a deploy gap). */
export function resolveServedBundle(explicit?: string): Buffer | null {
  const p = servedBundlePath(explicit);
  if (!p) return null;
  const hit = cacheByPath.get(p);
  if (hit) return hit.bundle;
  try {
    const bundle = fs.readFileSync(p);
    const sha256 = createHash('sha256').update(bundle).digest('hex');
    cacheByPath.set(p, { bundle, sha256 });
    return bundle;
  } catch {
    return null;
  }
}

/** The sha256 of the served bundle, or null when no bundle is available. */
export function resolveServedBundleSha256(explicit?: string): string | null {
  const p = servedBundlePath(explicit);
  if (!p) return null;
  const hit = cacheByPath.get(p);
  if (hit) return hit.sha256;
  return resolveServedBundle(explicit) ? cacheByPath.get(p)!.sha256 : null;
}

/** Test-only: forget the cached bundle so a re-read picks up new bytes. */
export function __clearServedBundleCache(): void {
  cacheByPath.clear();
}
