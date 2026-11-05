/**
 * release-manifest — serve the signed daemon-release manifest to observer daemons.
 *
 *, the self-update channel. PUBLIC and UNAUTHENTICATED, because the manifest is not a
 * secret — it names the current bundle's version + hash. Its integrity is the
 * Ed25519 signature the SDK verifies against a key COMPILED INTO ITS BUILD (the
 * existing release-signing key — no new signer), never
 * from who was allowed to fetch it.
 *
 * The relay does not sign on the request path. The signed manifest is produced
 * out of band by `scripts/sign-release-manifest.ts`, which reads the private key
 * from Secret Manager (`harness-catalog-signing-key`) and stores a finished
 * envelope in Firestore. So this route holds no key material at all, and the
 * daemon downloads the actual bundle bytes from `/v1/bootstrap/agent.js` and
 * refuses to run them unless their hash matches THIS signed manifest.
 */

import { Router, type Request, type Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';

export const RELEASE_COLLECTION = 'release_manifest';
export const RELEASE_DOCUMENT = 'current';

export interface ReleaseManifestDeps {
  db: Firestore;
  /**
   * (1B): the sha256 of the bundle THIS revision serves at
   * `/v1/bootstrap/agent.js` (via `served-bundle.ts`, the same source the bootstrap
   * route serves), or null when no bundle is available on this revision. The route
   * serves the signed manifest ONLY when its `bundle.sha256` equals this value —
   * so a daemon can never fetch a manifest whose bundle is not already in place at
   * its exact hash. When the manifest is ahead of (or behind) this revision's
   * bundle, the route answers 409 "pending" rather than a manifest the daemon would
   * fail-close on; the daemon retries on its next tick.
   */
  resolveServedBundleSha256: () => string | null;
}

export function createReleaseManifestRouter(deps: ReleaseManifestDeps): Router {
  const { db, resolveServedBundleSha256 } = deps;
  const router = Router();

  // GET / — the current signed release envelope, or:
  //   404 when none is published (or a half-written envelope, or this revision has
  //       no bundle to serve) — a daemon keeps running its current bundle;
  //   409 `{ pending: true }` when a signed manifest EXISTS but its bundle sha256 is
  //       not the bundle THIS revision serves (a publish/deploy is mid-flight). The
  //       manifest is deliberately WITHHELD so no daemon can fetch it ahead of its
  //       bundle and fail-close on a hash mismatch; the daemon fast-retries.
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const doc = await db.collection(RELEASE_COLLECTION).doc(RELEASE_DOCUMENT).get();
      if (!doc.exists) {
        res.status(404).json({ error: 'No release published' });
        return;
      }
      const data = doc.data() as { manifest?: unknown; signature?: unknown } | undefined;
      if (!data?.manifest || typeof data.signature !== 'string') {
        // Never serve a half-written envelope: an unsigned manifest is refused by
        // the SDK anyway, and shipping one would put a bad-signature warning in
        // every daemon's log for a fault that is entirely ours.
        res.status(404).json({ error: 'No release published' });
        return;
      }

      // (1B) — atomic publish, enforced at serve time. The manifest names a
      // bundle sha256; the bundle it names is served from THIS revision. Serve the
      // manifest ONLY when the two agree, so the pair is self-consistent from any
      // single daemon request. A mismatch (either direction) means the bundle for
      // this manifest is not in place on this revision — withhold with 409 so the
      // daemon retries, never a manifest it would fail-close on.
      const manifestBundleSha256 = (data.manifest as { bundle?: { sha256?: unknown } }).bundle?.sha256;
      const servedSha256 = resolveServedBundleSha256();
      if (typeof manifestBundleSha256 !== 'string' || servedSha256 === null) {
        // A malformed manifest or a revision with no servable bundle: nothing safe
        // to offer. Fail closed as "no release" (a daemon keeps current bytes).
        res.status(404).json({ error: 'No release published' });
        return;
      }
      if (manifestBundleSha256 !== servedSha256) {
        // Manifest ahead of / behind this revision's bundle — a publish is in
        // flight. No caching: the consistent state is imminent and the daemon
        // should re-check soon.
        res.setHeader('Cache-Control', 'no-store');
        res.status(409).json({ pending: true, error: 'Release pending: bundle not yet in place' });
        return;
      }

      // Short cache: the manifest changes rarely and a stale copy is harmless (the
      // SDK refuses anything not strictly newer, and re-verifies the bundle hash).
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json({ manifest: data.manifest, signature: data.signature });
    } catch (error) {
      console.error('[ReleaseManifest] read error:', error);
      res.status(500).json({ error: 'Failed to read release manifest' });
    }
  });

  return router;
}
