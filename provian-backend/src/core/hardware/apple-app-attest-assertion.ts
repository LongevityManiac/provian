/**
 * Apple App Attest ASSERTION — the per-PE witness from an already-attested Secure-Enclave key.
 *
 * assertion = CBOR { signature: DER ECDSA-P256/SHA-256, authenticatorData }. Apple: the signature
 * is over nonce = SHA256(authenticatorData || clientDataHash); our clientDataHash IS the binding
 * nonce. authenticatorData.rpIdHash must equal SHA256(appId) and its counter must ADVANCE past the
 * registry's stored counter (a replayed assertion is refused and never bumps).
 */
import crypto from 'crypto';
import { decodeCbor, mapGet } from './cbor';
import { sha256Hex } from './x509';
import type { HardwareVerifyContext, HardwareWitnessInput, HardwareWitnessVerdict } from './types';

export interface AppleAssertionKeyRecord {
  readonly public_key_jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  readonly signer_key_sha256: string;
  readonly issuer_root_fingerprint: string;
  readonly environment: 'production' | 'development';
  readonly counter: number;
}

export interface AppleAssertionDeps {
  lookup(keyIdB64: string): Promise<AppleAssertionKeyRecord | null>;
  /** Advance the stored counter iff `counter` > stored; false = replay/regression. */
  advance(keyIdB64: string, counter: number): Promise<boolean>;
}

export async function verifyAppleAppAttestAssertion(
  input: HardwareWitnessInput,
  ctx: HardwareVerifyContext,
  deps: AppleAssertionDeps,
): Promise<HardwareWitnessVerdict> {
  const fail = (reason: string): HardwareWitnessVerdict => ({ admitted: false, scheme: 'apple_app_attest', reason, fields: null });
  if (typeof input.assertion !== 'string' || input.assertion.length === 0) return fail('assertion_missing');
  if (typeof input.key_id !== 'string' || input.key_id.length === 0) return fail('key_id_missing');
  if (!ctx.appleAppId) return fail('app_id_not_configured');
  const record = await deps.lookup(input.key_id);
  if (!record) return fail('key_not_registered');
  let raw: Buffer;
  try { raw = Buffer.from(input.assertion, 'base64'); } catch { return fail('assertion_not_base64'); }
  let obj: ReturnType<typeof decodeCbor>;
  try { obj = decodeCbor(raw); } catch { return fail('assertion_malformed'); }
  const signature = mapGet(obj, 'signature');
  const authData = mapGet(obj, 'authenticatorData');
  if (!Buffer.isBuffer(signature) || !Buffer.isBuffer(authData) || authData.length < 37) return fail('assertion_fields');
  const rpIdHash = crypto.createHash('sha256').update(ctx.appleAppId).digest();
  if (!rpIdHash.equals(authData.subarray(0, 32))) return fail('rp_id_mismatch');
  const counter = authData.readUInt32BE(33);
  let key: crypto.KeyObject;
  try { key = crypto.createPublicKey({ key: record.public_key_jwk, format: 'jwk' }); } catch { return fail('stored_key_invalid'); }
  if (ctx.actorKeyFingerprints.has(record.signer_key_sha256)) return fail('signer_is_actor');
  const nonce = crypto.createHash('sha256').update(Buffer.concat([authData, ctx.bindingNonce])).digest();
  let sigOk = false;
  try { sigOk = crypto.verify('sha256', nonce, { key, dsaEncoding: 'der' }, signature); } catch { sigOk = false; }
  const fields = {
    tee_type: 'apple_secure_enclave',
    manufacturer: 'Apple',
    model: record.environment === 'production' ? 'app_attest' : 'app_attest_development',
    report_digest: `sha256:${sha256Hex(raw)}`,
    issuer_root_fingerprint: record.issuer_root_fingerprint,
    signer_key_sha256: record.signer_key_sha256,
    debug_enabled: record.environment !== 'production',
    nonce_bound: sigOk,
  };
  if (!sigOk) return { admitted: false, scheme: 'apple_app_attest', reason: 'assertion_signature_invalid', fields };
  if (!(counter > record.counter)) return { admitted: false, scheme: 'apple_app_attest', reason: 'counter_not_advanced', fields };
  const advanced = await deps.advance(input.key_id, counter);
  if (!advanced) return { admitted: false, scheme: 'apple_app_attest', reason: 'counter_not_advanced', fields };
  if (record.environment !== 'production') return { admitted: false, scheme: 'apple_app_attest', reason: 'development_aaguid', fields };
  return { admitted: true, scheme: 'apple_app_attest', reason: 'verified', fields };
}
