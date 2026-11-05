/**
 * Release freshness — the deploy-time guard that the daemon release channel names the bundle the
 * relay serves (ops follow-up 2, 2026-10-07; OPEN_ITEMS).
 *
 * deployed a rebuilt `bootstrap-bundle/agent.js` without signing a release. The release route
 * withholds a manifest whose bundle hash is not the served bundle (409 `pending`, (1B)), so for
 * hours every daemon's update check answered "pending" and the fleet read as "stuck". The gated
 * deploy now judges the live pair after it deploys and finishes only when it is fresh; when stale it
 * signs the next version over the exact bytes the relay serves, then judges again.
 *
 * Pure: the caller fetches the live facts, this decides. Unknown = Block: a fact it cannot read is
 * never fresh.
 */

export interface ReleaseFreshnessFacts {
  /** sha256 of the bytes the relay serves at /v1/bootstrap/agent.js; null when unreadable. */
  readonly servedBundleSha256: string | null;
  /** sha256 of the bundle on disk — the bytes the signer signs; null when unreadable. */
  readonly localBundleSha256: string | null;
  /** HTTP status of GET /v1/catalog/release; null when unreachable. */
  readonly releaseStatus: number | null;
  /** The served manifest's bundle hash (200 only). */
  readonly releaseBundleSha256: string | null;
  /** The currently published version (Firestore `release_manifest/current`); null when unreadable. */
  readonly publishedVersion: number | null;
}

export type ReleaseFreshnessVerdict =
  | { readonly state: 'fresh'; readonly version: number }
  | { readonly state: 'stale'; readonly reason: string; readonly signVersion: number }
  | { readonly state: 'blocked'; readonly reason: string };

const SHA256 = /^[0-9a-f]{64}$/;

export function judgeReleaseFreshness(f: ReleaseFreshnessFacts): ReleaseFreshnessVerdict {
  if (f.servedBundleSha256 === null || !SHA256.test(f.servedBundleSha256)) {
    return { state: 'blocked', reason: 'served bundle unreadable — cannot tell which bytes daemons would download' };
  }
  if (f.releaseStatus === 200) {
    if (f.releaseBundleSha256 === f.servedBundleSha256 && f.publishedVersion !== null) {
      return { state: 'fresh', version: f.publishedVersion };
    }
    // The route never serves a mismatched manifest; a 200 that disagrees is a route defect.
    return { state: 'blocked', reason: 'release route answered 200 with a manifest that does not name the served bundle' };
  }
  if (f.releaseStatus !== 409 && f.releaseStatus !== 404) {
    return { state: 'blocked', reason: `release route answered ${String(f.releaseStatus)} — not judged` };
  }
  if (f.publishedVersion === null || !Number.isSafeInteger(f.publishedVersion) || f.publishedVersion < 0) {
    return { state: 'blocked', reason: 'published release version unreadable — cannot choose a strictly newer one' };
  }
  if (f.localBundleSha256 !== f.servedBundleSha256) {
    return {
      state: 'blocked',
      reason: 'the bundle on disk is not the bundle the relay serves — signing would publish a hash no daemon can download',
    };
  }
  return {
    state: 'stale',
    reason: f.releaseStatus === 409
      ? 'the release endpoint answers pending: the signed manifest names another bundle'
      : 'no release is published for the served bundle',
    signVersion: f.publishedVersion + 1,
  };
}
