/**
 * MEASURED OBSERVER — the measurements the signed observer release channel pins.
 *
 * The hardware-rooted base pays when the attestation proves Provian's own genuine software produced
 * the record. App Attest proves it by construction. A TPM / AWS Nitro / GCP Confidential / Azure /
 * NVIDIA attestation proves it when the launch measurement the PLATFORM produced at launch — the
 * PCR digest, enclave or SEV-SNP launch measurement, container image digest, or GPU measurement
 * record — is one the relay pins for a signed observer release. The operator cannot choose that
 * measurement; it can only run the published image. Any other measurement stays exactly what it is:
 * verified, recorded, disclosed as a presentation fact, priced at the lane's class.
 *
 * The pins come from the signed release channel and nowhere else: `release_manifest/current`, the
 * Ed25519-signed manifest daemons self-update from (`scripts/sign-release-manifest.ts`). The relay
 * reads the envelope, verifies its signature under the key the SERVED BUNDLE pins (the same rule
 * the signer enforces,), refuses a retired key, and takes `observer_measurements` from the
 * verified manifest. Anything it cannot verify pins NOTHING (Unknown = Block: no lift), never a
 * guess. Sealed PEs are never repriced.
 */
import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { RELEASE_COLLECTION, RELEASE_DOCUMENT } from '../../routes/release-manifest';
import { resolveServedBundle } from '../../routes/served-bundle';
import {
  parseObserverMeasurements,
  pinKey,
  releaseSigningKeyRefusal,
  stableStringify,
  type ObserverMeasurementPin,
} from '../release/release-manifest-wire';

export { pinKey };

/** How long one verified read of the release channel serves lane pricing. */
export const PINNED_MEASUREMENTS_CACHE_MS = 5 * 60 * 1000;

export type PinnedMeasurementRefusal =
  | 'no_release_published'
  | 'envelope_malformed'
  | 'signing_key_refused'
  | 'bad_signature'
  | 'measurements_malformed';

export type PinnedMeasurementVerdict =
  | { readonly ok: true; readonly version: number; readonly pins: readonly ObserverMeasurementPin[]; readonly set: ReadonlySet<string> }
  | { readonly ok: false; readonly reason: PinnedMeasurementRefusal };

/** The empty pin set — what every lane prices against when the channel cannot be verified. */
export const NO_PINNED_MEASUREMENTS: ReadonlySet<string> = Object.freeze(new Set<string>());

function verifyEd25519Hex(message: string, signatureHex: string, publicKeyHex: string): boolean {
  if (!/^[0-9a-f]{128}$/.test(signatureHex) || !/^[0-9a-f]{64}$/.test(publicKeyHex)) return false;
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Pure: the pins a release envelope vouches for, or why it vouches for none. `servedBundle` is the
 * bundle THIS relay serves (the key pinned inside it is the only key a release may be signed with);
 * null when no bundle is available, which refuses — a key that nothing pins is not trusted.
 */
export function pinnedMeasurementsFromEnvelope(envelope: unknown, servedBundle: Buffer | null): PinnedMeasurementVerdict {
  if (envelope === null || typeof envelope !== 'object') return { ok: false, reason: 'no_release_published' };
  const env = envelope as { manifest?: unknown; signature?: unknown; public_key?: unknown };
  if (!env.manifest || typeof env.manifest !== 'object' || typeof env.signature !== 'string' || typeof env.public_key !== 'string') {
    return { ok: false, reason: 'envelope_malformed' };
  }
  if (servedBundle === null || releaseSigningKeyRefusal(env.public_key, servedBundle) !== null) {
    return { ok: false, reason: 'signing_key_refused' };
  }
  if (!verifyEd25519Hex(stableStringify(env.manifest), env.signature, env.public_key)) return { ok: false, reason: 'bad_signature' };
  const manifest = env.manifest as { version?: unknown; observer_measurements?: unknown };
  const pins = parseObserverMeasurements(manifest.observer_measurements);
  if (pins === null || typeof manifest.version !== 'number') return { ok: false, reason: 'measurements_malformed' };
  return { ok: true, version: manifest.version, pins, set: new Set(pins.map((p) => pinKey(p.scheme, p.measurement))) };
}

interface CacheEntry { readonly at: number; readonly set: ReadonlySet<string> }
let cache: CacheEntry | null = null;

/** TEST SEAM: forget the cached read. */
export function resetPinnedMeasurementsCache(): void {
  cache = null;
}

/**
 * The pins every lane prices against: one verified read of the release channel per cache window.
 * Any failure — no document, a signature the served bundle's key does not verify, a malformed
 * list — yields the EMPTY set (nothing lifts), and is cached for the window too, so a broken
 * channel costs one read per window rather than one per act.
 */
export async function loadPinnedMeasurements(
  db: Pick<Firestore, 'collection'>,
  opts: { nowMs?: number; servedBundle?: Buffer | null; onRefusal?: (reason: PinnedMeasurementRefusal) => void } = {},
): Promise<ReadonlySet<string>> {
  const now = opts.nowMs ?? Date.now();
  if (cache && now - cache.at < PINNED_MEASUREMENTS_CACHE_MS) return cache.set;
  let set: ReadonlySet<string> = NO_PINNED_MEASUREMENTS;
  try {
    const doc = await db.collection(RELEASE_COLLECTION).doc(RELEASE_DOCUMENT).get();
    const verdict = pinnedMeasurementsFromEnvelope(doc.exists ? doc.data() : null, opts.servedBundle === undefined ? resolveServedBundle() : opts.servedBundle);
    if (verdict.ok) set = verdict.set;
    else opts.onRefusal?.(verdict.reason);
  } catch {
    set = NO_PINNED_MEASUREMENTS;
  }
  cache = { at: now, set };
  return set;
}
