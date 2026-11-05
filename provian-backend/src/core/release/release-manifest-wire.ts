/**
 * The signed daemon-release manifest — the ONE shape, canonical bytes and key rule shared by the
 * out-of-band signer (`scripts/sign-release-manifest.ts`) and the relay's in-process readers
 * (`core/hardware/pinned-measurements.ts`, the measured-observer pricing rule).
 *
 * Canonical JSON with sorted keys MUST match the SDK verifier's `canonicalJson`
 * (`provian-agent-sdk/src/observer/release-signature.ts`) BYTE FOR BYTE. The two live in separate
 * packages and cannot share an import, so this is an independent declaration bound to the SDK's
 * by a golden vector (`sign-release-manifest.test.ts` pins the canonical bytes of a sample
 * manifest; the SDK's `self-update.test.ts` verifies a signature over the SAME object).
 */

import { createHash } from 'crypto';
import { isHardwareScheme, type HardwareScheme } from '../hardware/roots';
import { measurementKey } from '../hardware/measurement';

/** Public keys that must never sign a release again. */
export const RETIRED_RELEASE_PUBLIC_KEYS: readonly string[] = Object.freeze([
  '29ade696293550fa238c0443e557429be2df9ce01bfc15b11d2179c08eaceb6d',
]);

export const RELEASE_MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
/** The most observer measurements one release may pin. */
export const RELEASE_MAX_OBSERVER_MEASUREMENTS = 64;

/**
 * One measurement the signed release channel pins for a signed observer release (measured
 * observer,): the platform-produced launch measurement of the published image
 * the release runs on — a Confidential Space container image digest, a TPM PCR digest of a
 * published VM image's measured boot, a Nitro enclave image PCR0, an SEV-SNP launch measurement,
 * an NVIDIA measurement record digest. The operator cannot choose it: the platform produces it at
 * launch. A verified attestation carrying one of these prices at `hardware_rooted`.
 */
export interface ObserverMeasurementPin {
  readonly scheme: HardwareScheme;
  /** The measurement exactly as the relay's verifier extracts it (`hardwareMeasurementOf`). */
  readonly measurement: string;
  /** Which signed release / image the measurement belongs to (for the record; never matched on). */
  readonly note?: string;
}

export interface ReleaseManifest {
  version: number;
  issued_at: string;
  bundle: { sha256: string; bytes: number; node_min?: string };
  /** Measured observer: absent on releases that pin nothing (byte-identical to before). */
  observer_measurements?: ObserverMeasurementPin[];
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

const HEX64 = /^[0-9a-f]{64}$/;
const SEMVERISH = /^\d{1,4}(\.\d{1,5}){0,2}$/;

/**
 * Refuse to publish a release signed by a key the bundle does not pin. Daemons verify a
 * manifest against the ONE key compiled into the bundle they run, so in steady state the signing
 * key must be the key the published bundle pins: a mismatch would strand every daemon that applies
 * it (every later release would read as `bad_signature`). A retired key is refused outright.
 * Returns the refusal reason, or null when the key may sign. A rotation's single transition release
 * (old key signing a bundle that pins the new one) is the one deliberate exception, made by hand.
 */
export function releaseSigningKeyRefusal(publicKeyHex: string, bundle: Buffer): string | null {
  if (!/^[0-9a-f]{64}$/.test(publicKeyHex)) return 'signing public key is not 32 hex bytes';
  if (RETIRED_RELEASE_PUBLIC_KEYS.includes(publicKeyHex)) return `signing key ${publicKeyHex.slice(0, 8)}… is retired `;
  if (!bundle.includes(Buffer.from(publicKeyHex, 'utf8'))) return `the bundle does not pin signing key ${publicKeyHex.slice(0, 8)}…`;
  return null;
}

/**
 * Parse an untrusted pin list fail-closed: `null` unless EVERY entry is a known scheme with a
 * well-formed measurement (the exact form the verifier extracts), no duplicates, within the cap.
 * `undefined`/`null` input is an empty list (a release that pins nothing).
 */
export function parseObserverMeasurements(raw: unknown): ObserverMeasurementPin[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > RELEASE_MAX_OBSERVER_MEASUREMENTS) return null;
  const out: ObserverMeasurementPin[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
    const e = entry as Record<string, unknown>;
    if (!isHardwareScheme(e.scheme) || e.scheme === 'apple_app_attest') return null;
    const measurement = measurementKey(e.measurement);
    if (measurement === null || measurement !== e.measurement) return null;
    const key = pinKey(e.scheme, measurement);
    if (seen.has(key)) return null;
    seen.add(key);
    if (e.note !== undefined && (typeof e.note !== 'string' || e.note.length > 200)) return null;
    out.push({ scheme: e.scheme, measurement, ...(typeof e.note === 'string' ? { note: e.note } : {}) });
  }
  return out;
}

/** The set key a pin is matched under: the scheme AND the measurement, never the measurement alone. */
export function pinKey(scheme: string, measurement: string): string {
  return `${scheme}\n${measurement}`;
}

/**
 * Structural validation BEFORE signing — an independent mirror of the SDK's
 * `validateReleaseManifest` (which ignores fields it does not know, so a pin list never strands a
 * daemon), so a malformed manifest is refused at the signer rather than published and rejected
 * fleet-wide. Reports EVERY problem.
 */
export function validateReleaseManifestForSigning(value: unknown): string[] {
  const problems: string[] = [];
  const m = value as ReleaseManifest | null;
  if (!m || typeof m !== 'object') return ['manifest is not an object'];
  if (typeof m.version !== 'number' || !Number.isInteger(m.version) || m.version < 1) {
    problems.push('version must be a positive integer');
  }
  if (typeof m.issued_at !== 'string' || m.issued_at.length === 0 || m.issued_at.length > 64) {
    problems.push('issued_at must be a short string');
  }
  const b = m.bundle;
  if (!b || typeof b !== 'object') problems.push('bundle spec is missing');
  else {
    if (typeof b.sha256 !== 'string' || !HEX64.test(b.sha256)) problems.push('bundle.sha256 must be a 64-hex digest');
    if (typeof b.bytes !== 'number' || !Number.isInteger(b.bytes) || b.bytes < 1 || b.bytes > RELEASE_MAX_BUNDLE_BYTES) {
      problems.push('bundle.bytes must be a positive integer within the size cap');
    }
    if (b.node_min !== undefined && (typeof b.node_min !== 'string' || !SEMVERISH.test(b.node_min))) {
      problems.push('bundle.node_min must be a version string');
    }
  }
  if (m.observer_measurements !== undefined && parseObserverMeasurements(m.observer_measurements) === null) {
    problems.push('observer_measurements must be a bounded list of {scheme, measurement, note?} with a measured scheme and a well-formed measurement, no duplicates');
  }
  return problems;
}

/** Build a manifest from the actual bundle bytes at an operator-supplied version. */
export function buildReleaseManifest(
  bundle: Buffer,
  version: number,
  nodeMin?: string,
  issuedAt?: string,
  observerMeasurements?: readonly ObserverMeasurementPin[],
): ReleaseManifest {
  return {
    version,
    issued_at: issuedAt ?? new Date().toISOString(),
    bundle: {
      sha256: createHash('sha256').update(bundle).digest('hex'),
      bytes: bundle.length,
      ...(nodeMin ? { node_min: nodeMin } : {}),
    },
    ...(observerMeasurements && observerMeasurements.length > 0 ? { observer_measurements: [...observerMeasurements] } : {}),
  };
}
