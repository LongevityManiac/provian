/**
 * sign-release-manifest — the signer must not publish a manifest the fleet will
 * reject, and its canonicalizer must not drift from the SDK verifier's.
 *
 * The signer lives in provian-backend/scripts; the SDK's `canonicalJson` and
 * `validateReleaseManifest` live in @provian/agent-sdk and cannot be imported
 * across the package boundary. So the two canonicalizers are independent
 * declarations bound to agreement by a GOLDEN VECTOR: the sha256 of the canonical
 * bytes of a fixed sample manifest is pinned here AND in the SDK's
 * self-update.test over the SAME object. A change to either canonicalizer breaks
 * one suite. (CLAUDE.md pitfall #55 — byte-identical canonicalization across
 * packages; same discipline as the harness-catalog signer.)
 */
import { createHash, generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from 'crypto';
import {
  stableStringify,
  validateReleaseManifestForSigning,
  buildReleaseManifest,
  releaseSigningKeyRefusal,
  RETIRED_RELEASE_PUBLIC_KEYS,
} from '../scripts/sign-release-manifest';

// The SAME fixed object pinned in the SDK's self-update.test canonical-parity test.
const SAMPLE = {
  version: 1,
  issued_at: '2026-09-13T00:00:00.000Z',
  bundle: {
    sha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    bytes: 369599,
    node_min: '20.0.0',
  },
};
const SAMPLE_CANONICAL_SHA256 = 'a9ec4aad329416ad40ff49360f51796bf595636040977931a4b90f0cb267b6f9';
// The SAME object with observer measurements (measured observer, 2026-10-10) — pinned in BOTH suites
// so the daemon verifies a measured release over exactly the bytes the signer signed.
const SAMPLE_MEASURED = {
  ...SAMPLE,
  observer_measurements: [
    { scheme: 'tpm2_quote', measurement: 'sha256:' + '07'.repeat(32), note: 'illustrative measured-boot digest' },
    { scheme: 'gcp_confidential_space', measurement: 'sha256:' + 'ef'.repeat(32) },
  ],
};
const SAMPLE_MEASURED_CANONICAL_SHA256 = '82dbb1f8eae9e3699bb0a503a8e5b00189f286a0eb8d17f970c526351d86f449';

describe('release-manifest canonicalization', () => {
  it('GOLDEN VECTOR — the sample manifest canonical bytes hash to the pinned sha (drift guard)', () => {
    const sha = createHash('sha256').update(stableStringify(SAMPLE)).digest('hex');
    expect(sha).toBe(SAMPLE_CANONICAL_SHA256);
  });
  it('GOLDEN VECTOR (measured) — a manifest carrying observer_measurements hashes to the pinned sha in both packages', () => {
    expect(createHash('sha256').update(stableStringify(SAMPLE_MEASURED)).digest('hex')).toBe(SAMPLE_MEASURED_CANONICAL_SHA256);
    expect(validateReleaseManifestForSigning(SAMPLE_MEASURED)).toEqual([]);
    // RED: a pin the signer must refuse (App Attest carries no measurement; a rewritten digest).
    expect(validateReleaseManifestForSigning({ ...SAMPLE, observer_measurements: [{ scheme: 'apple_app_attest', measurement: 'sha256:' + '07'.repeat(32) }] })).toHaveLength(1);
    expect(validateReleaseManifestForSigning({ ...SAMPLE, observer_measurements: [{ scheme: 'tpm2_quote', measurement: 'sha256: 07' }] })).toHaveLength(1);
  });

  it('a signature over the canonical bytes verifies, and a flipped byte does not', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const msg = Buffer.from(stableStringify(SAMPLE), 'utf8');
    const sig = nodeSign(null, msg, privateKey);
    expect(nodeVerify(null, msg, publicKey, sig)).toBe(true);
    const tampered = Buffer.from(msg);
    tampered[0] ^= 0x01;
    expect(nodeVerify(null, tampered, publicKey, sig)).toBe(false);
  });
});

describe('buildReleaseManifest', () => {
  it('computes sha256 + byte length of the real bundle bytes', () => {
    const bundle = Buffer.from('provian agent bundle bytes');
    const m = buildReleaseManifest(bundle, 5, undefined, '2026-09-13T00:00:00.000Z');
    expect(m.version).toBe(5);
    expect(m.bundle.bytes).toBe(bundle.length);
    expect(m.bundle.sha256).toBe(createHash('sha256').update(bundle).digest('hex'));
    expect(m.bundle.node_min).toBeUndefined();
  });

  it('includes node_min only when supplied', () => {
    const m = buildReleaseManifest(Buffer.from('x'), 5, '26.0.0');
    expect(m.bundle.node_min).toBe('26.0.0');
  });
});

describe('validateReleaseManifestForSigning refuses a malformed manifest', () => {
  const base = (): any => JSON.parse(JSON.stringify(SAMPLE));

  it('version 0 is refused', () => {
    const m = base(); m.version = 0;
    expect(validateReleaseManifestForSigning(m).some((p) => /version/.test(p))).toBe(true);
  });

  it('a non-hex sha256 is refused', () => {
    const m = base(); m.bundle.sha256 = 'not-a-hash';
    expect(validateReleaseManifestForSigning(m).some((p) => /sha256/.test(p))).toBe(true);
  });

  it('a zero byte length is refused', () => {
    const m = base(); m.bundle.bytes = 0;
    expect(validateReleaseManifestForSigning(m).some((p) => /bytes/.test(p))).toBe(true);
  });

  it('a malformed node_min is refused', () => {
    const m = base(); m.bundle.node_min = 'twenty';
    expect(validateReleaseManifestForSigning(m).some((p) => /node_min/.test(p))).toBe(true);
  });

  it('NEGATIVE CONTROL — the untouched sample produces NO problems', () => {
    expect(validateReleaseManifestForSigning(base())).toEqual([]);
  });
});

// ── close-out: the publish refuses a version at or below the published one ──
import {
  publishedReleaseVersion,
  releaseVersionRefusal,
  publishReleaseEnvelope,
  readPublishedReleaseVersion,
  ReleaseVersionNotAdvancingError,
  type ReleaseStore,
} from '../scripts/sign-release-manifest';

/** An in-memory `release_manifest/current` with a transactional set. */
function memoryStore(initial: Record<string, unknown> | null): ReleaseStore & { doc: () => Record<string, unknown> | null; writes: number } {
  let current = initial;
  let writes = 0;
  const ref = { get: async () => ({ exists: current !== null, data: () => current }) };
  return {
    releaseRef: () => ref,
    runTransaction: async (fn) => fn({
      get: async () => ({ exists: current !== null, data: () => current }),
      set: (_r, data) => { current = data; writes += 1; },
    }),
    doc: () => current,
    get writes() { return writes; },
  };
}

const envelopeAt = (version: number) => ({
  manifest: { ...SAMPLE, version },
  signature: 'ab'.repeat(64),
  public_key: 'cd'.repeat(32),
});

describe('release publish version guard ', () => {
  it('RED CONTROL — the live incident: v23 over a published v26 is REFUSED and nothing is written', async () => {
    const store = memoryStore({ manifest: { ...SAMPLE, version: 26 }, signature: 'x', published_at: 1 });
    await expect(publishReleaseEnvelope(store, envelopeAt(23))).rejects.toBeInstanceOf(ReleaseVersionNotAdvancingError);
    expect(store.writes).toBe(0);
    expect((store.doc() as { manifest: { version: number } }).manifest.version).toBe(26);
  });

  it('RED CONTROL — re-publishing the SAME version is refused (a daemon on it sees not_newer)', async () => {
    const store = memoryStore({ manifest: { ...SAMPLE, version: 27 }, signature: 'x' });
    await expect(publishReleaseEnvelope(store, envelopeAt(27))).rejects.toThrow(/not above the currently published version 27/);
    expect(store.writes).toBe(0);
  });

  it('RED CONTROL — a published document with no readable version is refused (unknown = block)', async () => {
    const store = memoryStore({ manifest: { issued_at: 'x' }, signature: 'x' });
    expect(await readPublishedReleaseVersion(store)).toBe('unreadable');
    await expect(publishReleaseEnvelope(store, envelopeAt(99))).rejects.toThrow(/no readable version/);
    expect(store.writes).toBe(0);
  });

  it('a strictly higher version publishes, stamped with published_at', async () => {
    const store = memoryStore({ manifest: { ...SAMPLE, version: 27 }, signature: 'x' });
    await publishReleaseEnvelope(store, envelopeAt(28), 1234);
    expect(store.writes).toBe(1);
    expect(store.doc()).toMatchObject({ manifest: { version: 28 }, published_at: 1234 });
  });

  it('the first ever publish (nothing published) proceeds', async () => {
    const store = memoryStore(null);
    expect(await readPublishedReleaseVersion(store)).toBeNull();
    await publishReleaseEnvelope(store, envelopeAt(1));
    expect(store.writes).toBe(1);
  });

  it('the pure refusal: at-or-below refused, above allowed', () => {
    expect(releaseVersionRefusal(26, 23)).toMatch(/publish 27 or higher/);
    expect(releaseVersionRefusal(26, 26)).not.toBeNull();
    expect(releaseVersionRefusal(26, 27)).toBeNull();
    expect(releaseVersionRefusal(null, 1)).toBeNull();
    expect(publishedReleaseVersion({ manifest: { version: 0 } })).toBe('unreadable');
    expect(publishedReleaseVersion({ manifest: { version: 26 } })).toBe(26);
  });
});


describe('the signer only signs with the key the bundle pins ', () => {
  const ROTATED = '2c7555655c152d8c328b1647a0b06d38a26dd32e48b91fb0e0354d563e7805ce';
  const EXPOSED = '29ade696293550fa238c0443e557429be2df9ce01bfc15b11d2179c08eaceb6d';
  const bundlePinning = (k: string) => Buffer.from(`var x=1;const RELEASE_PUBLIC_KEY="${k}";run()`);

  it('the key the bundle pins may sign', () => {
    expect(releaseSigningKeyRefusal(ROTATED, bundlePinning(ROTATED))).toBeNull();
  });

  it('RED: the exposed key is refused even over a bundle that pins it', () => {
    expect(RETIRED_RELEASE_PUBLIC_KEYS).toContain(EXPOSED);
    expect(releaseSigningKeyRefusal(EXPOSED, bundlePinning(EXPOSED))).toMatch(/retired/);
  });

  it('RED: a key the bundle does not pin is refused (it would strand every daemon that applied it)', () => {
    const other = 'ab'.repeat(32);
    expect(releaseSigningKeyRefusal(other, bundlePinning(ROTATED))).toMatch(/does not pin/);
  });

  it('the bundle the relay serves pins the rotated key', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const served = fs.readFileSync(path.join(__dirname, '..', 'bootstrap-bundle', 'agent.js'));
    expect(releaseSigningKeyRefusal(ROTATED, served)).toBeNull();
    expect(served.includes(Buffer.from(EXPOSED))).toBe(false);
  });
});
