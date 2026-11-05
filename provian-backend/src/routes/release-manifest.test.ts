/**
 * The release-manifest serving route (self-update channel). Its ONE
 * security-relevant property is negative: it must never serve a half-written
 * envelope (an unsigned manifest puts a bad_signature warning in every daemon's
 * log for a fault that is ours) and it must never echo key material.
 *
 * Unauthenticated by design — the manifest is a public fact (the current bundle's
 * version + hash), its integrity from a signature the SDK verifies against a
 * compiled-in key, not from who may fetch it.
 */

import express from 'express';
import request from 'supertest';
import { createReleaseManifestRouter, RELEASE_COLLECTION, RELEASE_DOCUMENT } from './release-manifest';

const SERVED_SHA = 'a'.repeat(64);

function appWith(
  doc: { exists: boolean; data?: () => unknown },
  servedBundleSha256: string | null = SERVED_SHA,
) {
  const db = {
    collection: (name: string) => {
      expect(name).toBe(RELEASE_COLLECTION);
      return {
        doc: (id: string) => {
          expect(id).toBe(RELEASE_DOCUMENT);
          return { get: async () => doc };
        },
      };
    },
  } as never;
  const app = express();
  app.use('/v1/catalog/release', createReleaseManifestRouter({
    db,
    resolveServedBundleSha256: () => servedBundleSha256,
  }));
  return app;
}

const MANIFEST = {
  version: 7,
  issued_at: '2026-09-13T00:00:00.000Z',
  bundle: { sha256: SERVED_SHA, bytes: 369599 },
};

describe('GET /v1/catalog/release', () => {
  it('serves a complete signed envelope, unauthenticated', async () => {
    const res = await request(appWith({
      exists: true,
      data: () => ({ manifest: MANIFEST, signature: 'ab12' }),
    })).get('/v1/catalog/release');
    expect(res.status).toBe(200);
    expect(res.body.manifest.version).toBe(7);
    expect(res.body.signature).toBe('ab12');
  });

  it('404s when nothing is published — a safe answer; the daemon keeps its bundle', async () => {
    const res = await request(appWith({ exists: false })).get('/v1/catalog/release');
    expect(res.status).toBe(404);
  });

  it('THE CONTROL — refuses to serve a manifest with NO signature', async () => {
    const res = await request(appWith({
      exists: true,
      data: () => ({ manifest: MANIFEST }),
    })).get('/v1/catalog/release');
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('version');
  });

  it('THE CONTROL — refuses to serve a signature with NO manifest', async () => {
    const res = await request(appWith({
      exists: true,
      data: () => ({ signature: 'ab12' }),
    })).get('/v1/catalog/release');
    expect(res.status).toBe(404);
  });

  it('never leaks key material — only manifest and signature are returned', async () => {
    const res = await request(appWith({
      exists: true,
      data: () => ({
        manifest: MANIFEST,
        signature: 'ab12',
        published_at: 123,
        public_key: 'deadbeef',
        signing_key: 'MUST_NOT_APPEAR',
      }),
    })).get('/v1/catalog/release');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['manifest', 'signature']);
    expect(JSON.stringify(res.body)).not.toContain('MUST_NOT_APPEAR');
  });

  // (1B) — atomic publish, enforced at serve time.
  describe('serve-side atomicity gate ((1B))', () => {
    it('serves the manifest when its bundle sha256 IS the bundle this revision serves', async () => {
      const res = await request(appWith(
        { exists: true, data: () => ({ manifest: MANIFEST, signature: 'ab12' }) },
        MANIFEST.bundle.sha256,
      )).get('/v1/catalog/release');
      expect(res.status).toBe(200);
      expect(res.body.manifest.version).toBe(7);
    });

    it('THE CONTROL — WITHHOLDS (409 pending) a manifest whose bundle is NOT the one this revision serves', async () => {
      // the pre- route this served 200 — a daemon would fetch it and
      // fail-close on bundle_hash_mismatch. Now it is withheld as pending.
      const res = await request(appWith(
        { exists: true, data: () => ({ manifest: MANIFEST, signature: 'ab12' }) },
        'b'.repeat(64), // this revision serves a DIFFERENT bundle
      )).get('/v1/catalog/release');
      expect(res.status).toBe(409);
      expect(res.body.pending).toBe(true);
      // Never leaks the manifest ahead of its bundle.
      expect(JSON.stringify(res.body)).not.toContain('version');
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('404s (fail-closed) when this revision has NO servable bundle — never serves a manifest it cannot back', async () => {
      const res = await request(appWith(
        { exists: true, data: () => ({ manifest: MANIFEST, signature: 'ab12' }) },
        null, // no bundle available on this revision
      )).get('/v1/catalog/release');
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('version');
    });

    it('404s when the manifest bundle sha256 is malformed (no string to compare)', async () => {
      const res = await request(appWith(
        { exists: true, data: () => ({ manifest: { version: 7, issued_at: 'x', bundle: {} }, signature: 'ab12' }) },
        SERVED_SHA,
      )).get('/v1/catalog/release');
      expect(res.status).toBe(404);
    });
  });
});
