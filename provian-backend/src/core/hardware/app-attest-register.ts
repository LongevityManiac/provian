/**
 * App Attest REGISTRATION (§2.9): verify a one-time attestation object against the pinned Apple
 * root and record the attested Secure-Enclave key for this human, so every later mobile PE can
 * carry an assertion from it. The attestation's clientDataHash is the canonical registration
 * binding: sha256(canonicalJson({ purpose, key_id, user_id })) — the app computes the same bytes.
 *
 * the binding names the ACCOUNT (`user_id`), so an attestation object made for one account
 * cannot be replayed to register the key under another; and the registry binds each key to one
 * account globally (`app_attest_key_owner_v1`), refusing a second account `key_bound_to_other_account`.
 * Keys registered under the older `{ purpose, key_id }` binding are already in the registry and stay
 * valid for assertions — only NEW registrations must carry the account-bound binding.
 */
import crypto, { type X509Certificate } from 'crypto';
import { canonicalJson } from './binding';
import { verifyAppleAppAttest } from './apple-app-attest';
import { decodeCbor, mapGet } from './cbor';
import { parseCertificate } from './x509';
import { APP_ATTEST_REGISTER_PURPOSE, KEY_BOUND_TO_OTHER_ACCOUNT, type AppAttestKeyDoc, type AppAttestKeyStore } from './app-attest-keys';
import type { AppleAssertionDeps } from './apple-app-attest-assertion';

export function appAttestRegistrationNonce(keyIdB64: string, userId: string): Buffer {
  return crypto.createHash('sha256').update(canonicalJson({ purpose: APP_ATTEST_REGISTER_PURPOSE, key_id: keyIdB64, user_id: userId })).digest();
}

export type AppAttestRegisterResult =
  | { ok: true; created: boolean; signer_key_sha256: string; environment: 'production' | 'development' }
  | { ok: false; reason: string; status?: 409 };

export async function registerAppAttestKey(
  store: AppAttestKeyStore,
  params: { userId: string; keyId: unknown; attestation: unknown; appleAppId: string | null; nowMs: number },
  /** Test seam only: the pinned Apple roots (production passes nothing and uses the real pin). */
  rootsOverride?: { readonly apple_app_attest?: readonly X509Certificate[] },
): Promise<AppAttestRegisterResult> {
  const keyId = typeof params.keyId === 'string' && /^[A-Za-z0-9+/=_-]{20,128}$/.test(params.keyId) ? params.keyId : null;
  if (!keyId) return { ok: false, reason: 'key_id_malformed' };
  if (typeof params.attestation !== 'string') return { ok: false, reason: 'attestation_missing' };
  const verdict = verifyAppleAppAttest({ scheme: 'apple_app_attest', attestation: params.attestation, key_id: keyId }, {
    bindingNonce: appAttestRegistrationNonce(keyId, params.userId),
    actorKeyFingerprints: new Set<string>(),
    nowMs: params.nowMs,
    appleAppId: params.appleAppId,
    ...(rootsOverride ? { rootsOverride } : {}),
  });
  const environment: 'production' | 'development' = verdict.reason === 'development_aaguid' ? 'development' : 'production';
  if (!verdict.admitted && verdict.reason !== 'development_aaguid') return { ok: false, reason: verdict.reason };
  // The attested public key: the credential certificate (x5c[0]) of the attestation object.
  let jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  try {
    const obj = decodeCbor(Buffer.from(params.attestation, 'base64'));
    const x5c = mapGet(mapGet(obj, 'attStmt'), 'x5c');
    const cred = Array.isArray(x5c) && Buffer.isBuffer(x5c[0]) ? parseCertificate(x5c[0]) : null;
    if (!cred) return { ok: false, reason: 'cred_cert_missing' };
    const exported = cred.publicKey.export({ format: 'jwk' }) as { kty?: string; crv?: string; x?: string; y?: string };
    if (exported.kty !== 'EC' || exported.crv !== 'P-256' || !exported.x || !exported.y) return { ok: false, reason: 'cred_key_not_p256' };
    jwk = { kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y };
  } catch {
    return { ok: false, reason: 'attestation_malformed' };
  }
  const doc: AppAttestKeyDoc = {
    user_id: params.userId,
    key_id: keyId,
    public_key_jwk: jwk,
    signer_key_sha256: verdict.fields?.signer_key_sha256 ?? '',
    issuer_root_fingerprint: verdict.fields?.issuer_root_fingerprint ?? '',
    environment,
    counter: 0,
    attested_at_ms: params.nowMs,
    last_asserted_at_ms: null,
  };
  const outcome = await store.register(doc);
  if ('refused' in outcome) return { ok: false, reason: KEY_BOUND_TO_OTHER_ACCOUNT, status: 409 };
  return { ok: true, created: outcome.created, signer_key_sha256: doc.signer_key_sha256, environment };
}

/** The assertion registry the mobile lane hands the admit function, scoped to ONE human. */
export function appleAssertionDepsFor(store: AppAttestKeyStore, userId: string, nowMs: number): AppleAssertionDeps {
  return {
    async lookup(keyIdB64) {
      const d = await store.lookup(userId, keyIdB64);
      return d ? { public_key_jwk: d.public_key_jwk, signer_key_sha256: d.signer_key_sha256, issuer_root_fingerprint: d.issuer_root_fingerprint, environment: d.environment, counter: d.counter } : null;
    },
    async advance(keyIdB64, counter) {
      return store.advance(userId, keyIdB64, counter, nowMs);
    },
  };
}
