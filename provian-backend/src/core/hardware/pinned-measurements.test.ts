/**
 * The measurements the signed release channel pins — read from `release_manifest/current`, verified
 * under the key the SERVED bundle pins, refused on anything else. RED controls per refusal.
 */
import crypto from 'crypto';
import {
  loadPinnedMeasurements, pinnedMeasurementsFromEnvelope, resetPinnedMeasurementsCache,
  NO_PINNED_MEASUREMENTS, PINNED_MEASUREMENTS_CACHE_MS, pinKey,
} from './pinned-measurements';
import { RETIRED_RELEASE_PUBLIC_KEYS, stableStringify, parseObserverMeasurements } from '../release/release-manifest-wire';

function keypair(): { priv: crypto.KeyObject; pubHex: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const x = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
  return { priv: privateKey, pubHex: Buffer.from(x, 'base64url').toString('hex') };
}
const MEASUREMENT = 'sha256:' + '07'.repeat(32);
const manifestOf = (over: Record<string, unknown> = {}) => ({
  version: 71,
  issued_at: '2026-10-10T00:00:00.000Z',
  bundle: { sha256: 'ab'.repeat(32), bytes: 1234 },
  observer_measurements: [{ scheme: 'tpm2_quote', measurement: MEASUREMENT, note: 'observer release 71 on the published CVM image' }],
  ...over,
});
function envelope(priv: crypto.KeyObject, pubHex: string, manifest: Record<string, unknown>) {
  const signature = crypto.sign(null, Buffer.from(stableStringify(manifest), 'utf8'), priv).toString('hex');
  return { manifest, signature, public_key: pubHex, published_at: 1 };
}

describe('pinnedMeasurementsFromEnvelope', () => {
  const { priv, pubHex } = keypair();
  const bundle = Buffer.from(`const RELEASE_PUBLIC_KEY='${pubHex}';`, 'utf8');

  it('GREEN: a manifest signed by the key the served bundle pins yields exactly its pins', () => {
    const v = pinnedMeasurementsFromEnvelope(envelope(priv, pubHex, manifestOf()), bundle);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.version).toBe(71);
    expect([...v.set]).toEqual([pinKey('tpm2_quote', MEASUREMENT)]);
  });
  it('a release that pins nothing verifies to the empty set (byte-identical pre-measured manifests still verify)', () => {
    const m = manifestOf(); delete (m as { observer_measurements?: unknown }).observer_measurements;
    const v = pinnedMeasurementsFromEnvelope(envelope(priv, pubHex, m), bundle);
    expect(v.ok && v.set.size === 0).toBe(true);
  });
  it('RED: one tampered manifest byte → bad_signature, nothing pinned', () => {
    const env = envelope(priv, pubHex, manifestOf());
    const tampered = { ...env, manifest: { ...env.manifest, observer_measurements: [{ scheme: 'tpm2_quote', measurement: 'sha256:' + 'cc'.repeat(32) }] } };
    expect(pinnedMeasurementsFromEnvelope(tampered, bundle)).toEqual({ ok: false, reason: 'bad_signature' });
  });
  it('RED: a key the served bundle does not pin, a retired key, or no served bundle → signing_key_refused', () => {
    const other = keypair();
    expect(pinnedMeasurementsFromEnvelope(envelope(other.priv, other.pubHex, manifestOf()), bundle)).toEqual({ ok: false, reason: 'signing_key_refused' });
    const retired = RETIRED_RELEASE_PUBLIC_KEYS[0];
    const retiredBundle = Buffer.from(`'${retired}'`, 'utf8');
    expect(pinnedMeasurementsFromEnvelope({ ...envelope(priv, pubHex, manifestOf()), public_key: retired }, retiredBundle)).toEqual({ ok: false, reason: 'signing_key_refused' });
    expect(pinnedMeasurementsFromEnvelope(envelope(priv, pubHex, manifestOf()), null)).toEqual({ ok: false, reason: 'signing_key_refused' });
  });
  it('RED: a signed manifest whose pin list is malformed (App Attest pinned, a rewritten digest, a duplicate) → measurements_malformed', () => {
    for (const bad of [
      [{ scheme: 'apple_app_attest', measurement: MEASUREMENT }],
      [{ scheme: 'tpm2_quote', measurement: 'SHA256:' + '07'.repeat(32) }],
      [{ scheme: 'tpm2_quote', measurement: MEASUREMENT }, { scheme: 'tpm2_quote', measurement: MEASUREMENT }],
      [{ scheme: 'tpm2_quote' }],
    ]) {
      expect(parseObserverMeasurements(bad)).toBeNull();
      expect(pinnedMeasurementsFromEnvelope(envelope(priv, pubHex, manifestOf({ observer_measurements: bad })), bundle)).toEqual({ ok: false, reason: 'measurements_malformed' });
    }
  });
  it('RED: no document / a half-written envelope pins nothing', () => {
    expect(pinnedMeasurementsFromEnvelope(null, bundle)).toEqual({ ok: false, reason: 'no_release_published' });
    expect(pinnedMeasurementsFromEnvelope({ manifest: manifestOf() }, bundle)).toEqual({ ok: false, reason: 'envelope_malformed' });
  });
});

describe('loadPinnedMeasurements', () => {
  const { priv, pubHex } = keypair();
  const bundle = Buffer.from(pubHex, 'utf8');
  const dbWith = (doc: unknown, reads: { n: number }) => ({
    collection: () => ({ doc: () => ({ get: async () => { reads.n += 1; return { exists: doc !== null, data: () => doc }; } }) }),
  }) as unknown as Parameters<typeof loadPinnedMeasurements>[0];
  beforeEach(() => resetPinnedMeasurementsCache());

  it('reads the channel once per window; a verified read serves every lane from the cache', async () => {
    const reads = { n: 0 };
    const db = dbWith(envelope(priv, pubHex, manifestOf()), reads);
    const a = await loadPinnedMeasurements(db, { nowMs: 1_000, servedBundle: bundle });
    const b = await loadPinnedMeasurements(db, { nowMs: 1_000 + PINNED_MEASUREMENTS_CACHE_MS - 1, servedBundle: bundle });
    expect(a.has(pinKey('tpm2_quote', MEASUREMENT))).toBe(true);
    expect(b).toBe(a);
    expect(reads.n).toBe(1);
    await loadPinnedMeasurements(db, { nowMs: 1_000 + PINNED_MEASUREMENTS_CACHE_MS, servedBundle: bundle });
    expect(reads.n).toBe(2);
  });
  it('RED: a channel that cannot be verified pins NOTHING and says why; a throwing read pins nothing', async () => {
    const refusals: string[] = [];
    const set = await loadPinnedMeasurements(dbWith(envelope(priv, pubHex, manifestOf()), { n: 0 }), { nowMs: 5_000, servedBundle: null, onRefusal: (r) => refusals.push(r) });
    expect(set.size).toBe(0);
    expect(refusals).toEqual(['signing_key_refused']);
    resetPinnedMeasurementsCache();
    const throwing = { collection: () => ({ doc: () => ({ get: async () => { throw new Error('down'); } }) }) } as unknown as Parameters<typeof loadPinnedMeasurements>[0];
    expect(await loadPinnedMeasurements(throwing, { nowMs: 9_000, servedBundle: bundle })).toBe(NO_PINNED_MEASUREMENTS);
  });
});
