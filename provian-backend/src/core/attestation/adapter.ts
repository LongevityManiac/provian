/**
 * Production wiring for the Android Key Attestation verifier.
 *
 * This is the only impure module in core/attestation: it owns the embedded
 * Google roots, the cached fetch of Google's revocation status list, and the
 * system clock. The verifier core (verify.ts) stays pure and receives all of
 * these as injected values, so unit tests bypass this module entirely.
 *
 * Defaults chosen for production:
 *   - trust anchors: the embedded Google hardware-attestation roots
 *   - minSecurityLevel: TrustedEnvironment (StrongBox -> hardware_full, TEE ->
 *     hardware_tpm)
 *   - requireVerifiedBoot: true (a rooted / unlocked device must NOT earn the
 *     Google-attested tier; "Unknown = Block")
 */
import { buildTrustAnchorSet, type TrustAnchorSet } from './roots';
import { GOOGLE_HW_ATTESTATION_ROOTS } from './google-roots';
import { verifyAndroidKeyAttestation } from './verify';
import type {
  AndroidAttestationResult,
  AttestationPolicy,
  RevocationStatusSource,
} from './types';
import { failure } from './types';

/** Max certs accepted in a registration chain (DoS bound). */
const MAX_CHAIN_CERTS = 10;
/** Max base64 length per cert (~12KB DER). */
const MAX_CERT_B64_LEN = 16384;

const STATUS_URL = 'https://android.googleapis.com/attestation/status';
const STATUS_CACHE_KEY = 'android:attestation:status';
const STATUS_TTL_SECONDS = 3600;

let cachedAnchors: TrustAnchorSet | null = null;

/** The embedded Google roots, parsed once. */
export function productionAnchors(): TrustAnchorSet {
  if (!cachedAnchors) {
    cachedAnchors = buildTrustAnchorSet(GOOGLE_HW_ATTESTATION_ROOTS);
  }
  return cachedAnchors;
}

interface GoogleStatusList {
  entries?: Record<string, { status?: string; reason?: string }>;
}

/** Minimal fetch shape so this module needs no DOM lib types. */
export type FetchLike = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

export interface RevocationCache {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
}

/**
 * Build a revocation source from Google's status list, served from cache and
 * refreshed via fetch on a miss. If neither the cache nor the fetch yields a
 * usable list, the source reports `available: false` so the verifier fails
 * closed (refuses to promote) rather than treating an unknown serial as valid.
 */
export async function loadRevocationSource(
  cache: RevocationCache,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<RevocationStatusSource> {
  let list: GoogleStatusList | null = null;
  try {
    list = await cache.get<GoogleStatusList>(STATUS_CACHE_KEY);
  } catch {
    list = null;
  }
  if (!list) {
    try {
      const resp = await fetchImpl(STATUS_URL);
      if (resp.ok) {
        const parsed = (await resp.json()) as GoogleStatusList;
        if (parsed && typeof parsed === 'object') {
          list = parsed;
          await cache.set(STATUS_CACHE_KEY, parsed, STATUS_TTL_SECONDS).catch(() => undefined);
        }
      }
    } catch {
      list = null;
    }
  }
  const entries = list?.entries;
  if (!entries || typeof entries !== 'object') {
    return { available: false, isRevoked: () => ({ revoked: false }) };
  }
  return {
    available: true,
    isRevoked: (serialHex: string) => {
      const entry = entries[serialHex];
      if (entry && (entry.status === 'REVOKED' || entry.status === 'SUSPENDED')) {
        return { revoked: true, reason: entry.reason };
      }
      return { revoked: false };
    },
  };
}

export interface RegistrationChainInput {
  /** Base64-encoded DER certificates, leaf-first, from KeyStore.getCertificateChain. */
  certChainB64: readonly string[];
  /** The server nonce bytes baked into the key (from the consumed challenge). */
  expectedChallenge: Uint8Array;
  /** The registered device key, 130-hex SEC1 uncompressed P-256 point. */
  registeredSigningPublicKeyHex: string;
  cache: RevocationCache;
  /** Overrides for tests; production uses embedded anchors + Date.now(). */
  anchors?: TrustAnchorSet;
  revocation?: RevocationStatusSource;
  now?: number;
  policy?: AttestationPolicy;
  fetchImpl?: FetchLike;
}

/**
 * Verify an Android attestation chain presented at device registration.
 * Decodes the base64 DER chain (with DoS bounds), resolves the production trust
 * anchors and revocation source unless overridden, and runs the pure verifier.
 */
export async function verifyAndroidRegistrationChain(
  input: RegistrationChainInput,
): Promise<AndroidAttestationResult> {
  if (!Array.isArray(input.certChainB64) || input.certChainB64.length === 0) {
    return failure('CHAIN_EMPTY', 'cert_chain must be a non-empty array');
  }
  if (input.certChainB64.length > MAX_CHAIN_CERTS) {
    return failure('CHAIN_PARSE', `cert_chain exceeds ${MAX_CHAIN_CERTS} certificates`);
  }
  const derChain: Uint8Array[] = [];
  for (const b64 of input.certChainB64) {
    if (typeof b64 !== 'string' || b64.length === 0 || b64.length > MAX_CERT_B64_LEN) {
      return failure('CHAIN_PARSE', 'each cert_chain entry must be a base64 string within bounds');
    }
    derChain.push(new Uint8Array(Buffer.from(b64, 'base64')));
  }

  const anchors = input.anchors ?? productionAnchors();
  const revocation =
    input.revocation ?? (await loadRevocationSource(input.cache, input.fetchImpl));

  return verifyAndroidKeyAttestation({
    derChain,
    expectedChallenge: input.expectedChallenge,
    registeredSigningPublicKeyHex: input.registeredSigningPublicKeyHex,
    anchors,
    revocation,
    now: input.now ?? Date.now(),
    policy: input.policy ?? { requireVerifiedBoot: true, minSecurityLevel: 'TrustedEnvironment' },
  });
}
