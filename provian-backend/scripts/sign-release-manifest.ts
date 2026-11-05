/**
 * sign-release-manifest — publish a signed daemon-release manifest.
 *
 * The self-update channel's signer. It reads the EXACT bundle the relay serves
 * (`bootstrap-bundle/agent.js`), computes its sha256 + byte length, builds a
 * release manifest at an operator-supplied monotonic version, signs the canonical
 * bytes with the release-signing key (Secret Manager `release-signing-key`, rotated in;
 * the bundle must pin that key — `releaseSigningKeyRefusal`), and writes the finished envelope to Firestore
 * `release_manifest/current`. The relay's serving route holds no key material.
 *
 * A daemon (self-update is DEFAULT ON, opt-out `PROVIAN_SELF_UPDATE=0`;
 * close, the operator ) fetches this manifest, verifies the signature against the
 * key compiled into its build, downloads the bundle from `/v1/bootstrap/agent.js`,
 * and refuses to run bytes whose hash does not match THIS manifest. So the version
 * here must be strictly greater than the last published version, and the bundle on
 * disk here must be the one the relay serves.
 *
 * The key is fetched into memory for one signature and is never written to disk,
 * logged, or passed as a command-line argument (the lesson).
 *
 * The version guard is enforced HERE, not left to the operator :
 * a daemon applies a manifest only when its version is strictly higher than the one
 * it runs, so publishing a number at or below the currently published one is
 * accepted by the relay, served, and then silently refused `not_newer` by every
 * daemon — v23 over a served v26 stranded the whole fleet on the old build. The
 * publish reads `release_manifest/current` and refuses unless the new version is
 * strictly greater, before signing and again inside the write transaction; a
 * current document whose version cannot be read is refused too (unknown = block).
 *
 * Run: npx ts-node scripts/sign-release-manifest.ts --version <N> [--node-min 20.0.0] [--measurements <path>] [--dry-run]
 */

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
// The document the serving route reads — one source, so the publish writes exactly where daemons fetch from.
import { RELEASE_COLLECTION, RELEASE_DOCUMENT } from '../src/routes/release-manifest';

// the rotated release key. The previous one (`harness-catalog-signing-key`, public key
// 29ade696…) was exposed; its versions are disabled and it signs nothing.
const SECRET_NAME = 'release-signing-key';
// The manifest shape, canonical bytes, key rule and measurement pins live in ONE module the relay
// also reads (`core/release/release-manifest-wire.ts`); re-exported here for this script's suite.
import {
  RETIRED_RELEASE_PUBLIC_KEYS,
  releaseSigningKeyRefusal,
  stableStringify,
  validateReleaseManifestForSigning,
  buildReleaseManifest,
  parseObserverMeasurements,
  type ReleaseManifest,
  type ObserverMeasurementPin,
} from '../src/core/release/release-manifest-wire';
export { RETIRED_RELEASE_PUBLIC_KEYS, releaseSigningKeyRefusal, stableStringify, validateReleaseManifestForSigning, buildReleaseManifest, parseObserverMeasurements };
export type { ReleaseManifest, ObserverMeasurementPin };
const BUNDLE_PATH = path.join(__dirname, '..', 'bootstrap-bundle', 'agent.js');
/**
 * Measured observer : the measurements the signed release channel pins for the
 * signed observer release — checked in beside the bundle, cumulative, read by `--measurements` (or
 * this default when the file exists). The relay prices a verified TPM / Nitro / GCP / Azure / NVIDIA
 * attestation at `hardware_rooted` only when its platform-produced measurement is one of these.
 */
const MEASUREMENTS_PATH = path.join(__dirname, '..', 'bootstrap-bundle', 'observer-measurements.json');

/**
 * The published version recorded in a `release_manifest/current` document:
 * `null` when nothing has been published, a positive integer when one has, and
 * `'unreadable'` when a document exists but its version cannot be read — which
 * the guard refuses, because the version a daemon runs could be anything.
 */
export function publishedReleaseVersion(doc: unknown): number | null | 'unreadable' {
  if (doc === undefined || doc === null) return null;
  const version = (doc as { manifest?: { version?: unknown } }).manifest?.version;
  if (typeof version === 'number' && Number.isInteger(version) && version >= 1) return version;
  return 'unreadable';
}

/**
 * The refusal for publishing `next` over `published`, or null when the publish
 * may proceed. A version at or below the currently published one is refused.
 */
export function releaseVersionRefusal(published: number | null | 'unreadable', next: number): string | null {
  if (published === 'unreadable') {
    return 'the currently published release manifest has no readable version; refusing to publish over it';
  }
  if (published !== null && next <= published) {
    return `version ${next} is not above the currently published version ${published}; `
      + `every daemon would refuse it as not newer — publish ${published + 1} or higher`;
  }
  return null;
}

export class ReleaseVersionNotAdvancingError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ReleaseVersionNotAdvancingError';
  }
}

/** The Firestore surface the publish needs — narrow, so the guard is testable without a live project. */
export interface ReleaseDocRef { get(): Promise<{ exists: boolean; data(): unknown }> }
export interface ReleaseTransaction {
  get(ref: ReleaseDocRef): Promise<{ exists: boolean; data(): unknown }>;
  set(ref: ReleaseDocRef, data: Record<string, unknown>): unknown;
}
export interface ReleaseStore {
  releaseRef(): ReleaseDocRef;
  runTransaction<T>(fn: (tx: ReleaseTransaction) => Promise<T>): Promise<T>;
}

/** Read the published version outside a transaction (the pre-sign check). */
export async function readPublishedReleaseVersion(store: ReleaseStore): Promise<number | null | 'unreadable'> {
  const snap = await store.releaseRef().get();
  return snap.exists ? publishedReleaseVersion(snap.data()) : null;
}

/**
 * Write the signed envelope ONLY if its version is strictly above the one
 * published at write time — checked inside the same transaction as the write, so
 * a concurrent publish cannot slip a lower version in between the check and the set.
 */
export async function publishReleaseEnvelope(
  store: ReleaseStore,
  envelope: { manifest: ReleaseManifest; signature: string; public_key: string },
  now: number = Date.now(),
): Promise<void> {
  await store.runTransaction(async (tx) => {
    const ref = store.releaseRef();
    const snap = await tx.get(ref);
    const refusal = releaseVersionRefusal(snap.exists ? publishedReleaseVersion(snap.data()) : null, envelope.manifest.version);
    if (refusal) throw new ReleaseVersionNotAdvancingError(refusal);
    tx.set(ref, { ...envelope, published_at: now });
  });
}

function firestoreReleaseStore(db: import('firebase-admin/firestore').Firestore): ReleaseStore {
  const ref = db.collection(RELEASE_COLLECTION).doc(RELEASE_DOCUMENT);
  return {
    releaseRef: () => ref,
    runTransaction: (fn) => db.runTransaction((tx) => fn({
      get: (r) => tx.get(r as typeof ref),
      set: (r, data) => tx.set(r as typeof ref, data),
    })),
  };
}

function readSigningKey(): Uint8Array {
  // Read via the gcloud CLI (operator-only script; no runtime dep added). The
  // SECRET NAME is the only thing that reaches argv; the key comes back on stdout
  // into a buffer, converted once, never written/logged/interpolated.
  const out = execFileSync('gcloud', [
    'secrets', 'versions', 'access', 'latest',
    `--secret=${SECRET_NAME}`, '--project=provian-ai',
  ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  const hex = out.trim();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('signing key is not 32 hex bytes');
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function parseVersion(): number {
  const i = process.argv.indexOf('--version');
  if (i < 0 || !process.argv[i + 1]) throw new Error('--version <N> is required (monotonic; must exceed the last published)');
  const v = parseInt(process.argv[i + 1], 10);
  if (!Number.isInteger(v) || v < 1) throw new Error('--version must be a positive integer');
  return v;
}

function parseNodeMin(): string | undefined {
  const i = process.argv.indexOf('--node-min');
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** The observer measurements to pin: `--measurements <path>`, else the checked-in default when present. */
function readObserverMeasurements(): ObserverMeasurementPin[] {
  const i = process.argv.indexOf('--measurements');
  const explicit = i >= 0 ? process.argv[i + 1] : undefined;
  const file = explicit ?? (fs.existsSync(MEASUREMENTS_PATH) ? MEASUREMENTS_PATH : undefined);
  if (!file) return [];
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`observer measurements file is not readable JSON: ${file}`); }
  const pins = parseObserverMeasurements(raw);
  if (pins === null) throw new Error(`observer measurements file is malformed (scheme + measurement per entry, measured schemes only, no duplicates): ${file}`);
  return pins;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const version = parseVersion();
  const nodeMin = parseNodeMin();

  let bundle: Buffer;
  try {
    bundle = fs.readFileSync(BUNDLE_PATH);
  } catch {
    console.error(`  Refusing to sign — the bundle is not present at ${BUNDLE_PATH}.`);
    console.error('  Build + stage it first (provian-agent-sdk build:bootstrap, then copy to bootstrap-bundle/agent.js).');
    process.exit(1);
    return;
  }

  const measurements = readObserverMeasurements();
  const manifest = buildReleaseManifest(bundle, version, nodeMin, undefined, measurements);
  const problems = validateReleaseManifestForSigning(manifest);
  if (problems.length > 0) {
    console.error('  Refusing to sign — the manifest is malformed:');
    for (const p of problems) console.error(`    - ${p}`);
    process.exit(1);
  }

  const admin = await import('firebase-admin');

  const { scriptDb } = await import('./lib/script-db');
  if (admin.apps.length === 0) admin.initializeApp();
  const store = firestoreReleaseStore(scriptDb());
  const published = await readPublishedReleaseVersion(store);
  const refusal = releaseVersionRefusal(published, manifest.version);
  if (refusal) {
    console.error(`  Refusing to sign — ${refusal}.`);
    process.exit(1);
    return;
  }
  console.log(`  currently published version ${published ?? 'none'}`);

  const message = stableStringify(manifest);
  console.log(`  release version ${manifest.version}`);
  console.log(`  bundle sha256 ${manifest.bundle.sha256} (${manifest.bundle.bytes} bytes)`);
  console.log(`  observer measurements pinned: ${manifest.observer_measurements?.length ?? 0}`);
  for (const pin of manifest.observer_measurements ?? []) console.log(`    ${pin.scheme} ${pin.measurement}${pin.note ? ` (${pin.note})` : ''}`);
  console.log(`  canonical bytes: ${Buffer.byteLength(message, 'utf8')}`);

  if (dryRun) {
    console.log('  DRY RUN — not signed, not published.');
    return;
  }

  const { ed25519 } = await import('@noble/curves/ed25519.js');
  const key = readSigningKey();
  const pub = Buffer.from(ed25519.getPublicKey(key)).toString('hex');
  const keyRefusal = releaseSigningKeyRefusal(pub, bundle);
  if (keyRefusal) {
    console.error(`  Refusing to sign — ${keyRefusal}.`);
    process.exit(1);
    return;
  }
  const signature = Buffer.from(ed25519.sign(new TextEncoder().encode(message), key)).toString('hex');
  console.log(`  signed with public key ${pub}`);

  // Re-checked inside the write transaction: a publish that raced this one past
  // the pre-sign read still cannot land a version at or below the published one.
  await publishReleaseEnvelope(store, { manifest, signature, public_key: pub });
  console.log(`  published to ${RELEASE_COLLECTION}/${RELEASE_DOCUMENT}`);
}

if (require.main === module) {
  void main().catch((err) => {
    // Never print the error object itself (crypto/GCP throws can carry buffers).
    console.error(`  Could not sign the release manifest: ${err instanceof Error ? err.message : 'unknown error'}`);
    process.exit(1);
  });
}
