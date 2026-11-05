/**
 * output-signing-keys — the REGISTERED public keys a device or a phone signs its outputs with
 * (: "Outputs produced on devices that don't hold the wallet key (the MacBook
 * daemon, phones) are signed with that device's registered key and map to the owner through the
 * same identity index").
 *
 * Which key a signer kind verifies against (one per identity, never per output):
 * device `devices/{device_id}` (status active):
 * - a Secure-Enclave device (`signing_method: secure_enclave_p256`) → its registered
 * `signing_public_key`, the same key its batches are signed with. Nothing new.
 * - a bearer device (HMAC device secret only — a secret no third party can verify) has
 * NO public key, so it registers ONE P-256 output key: `output_signing_public_key`,
 * written by `PUT /v1/devices/me/output-signing-key` under device auth with a
 * proof of possession. This is the minimal addition for that device class.
 * owner → the device's own owner index: a human device's `owner_user_id`; an agent
 * device's agent (`agent_wallets/{owner_wallet_id}.agent_id`) — fail closed.
 * app `app_output_keys_v1/{aok_…}` a phone's hardware PE-attestation key
 * (`provian_pe_attestation`, Secure Enclave / StrongBox; never the wallet key). Phones
 * are not `devices` rows and their key was never registered with the relay, so it is
 * registered ONCE under wallet auth (`POST /v1/wallet/output-signing-key`) with a proof
 * of possession. One document per phone key — bounded by devices, never by history.
 * owner → the registering person's `user_id`.
 *
 * Proof of possession: ECDSA P-256 over SHA-256 of `outputKeyRegistrationMessage(kind, owner,
 * key)` the same verification as an output signature, bound to the identity and the key.
 * A registered key is immutable: a different key for the same device is refused (a silent swap
 * would orphan every output already signed).
 */

import { createPublicKey, verify as cryptoVerify } from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import {
  appOutputKeyId,
  canonicalP256PublicKey,
  outputKeyRegistrationMessage,
} from '../meter/output-signature';

export const APP_OUTPUT_KEYS_COLLECTION = 'app_output_keys_v1';
const APP_OUTPUT_KEY_SCHEMA = 'app-output-key/v1';

export interface AppOutputKeyRecord {
  readonly schema_version: typeof APP_OUTPUT_KEY_SCHEMA;
  readonly key_id: string;
  readonly public_key: string;
  readonly owner_user_id: string;
  readonly status: 'active' | 'revoked';
  readonly created_at_ms: number;
}

/**
 * ECDSA P-256 / SHA-256 verification of a 64-byte r‖s signature (hex) over `message` (UTF-8)
 * against a SEC1 uncompressed public key (hex). Never throws: any malformed input is `false`.
 */
export function verifyP256Sha256(publicKeyHex: string, message: string, sigHex: string): boolean {
  const key = canonicalP256PublicKey(publicKeyHex);
  if (key === null || !/^[0-9a-f]{128}$/.test(sigHex)) return false;
  try {
    const point = Buffer.from(key, 'hex');
    const publicKey = createPublicKey({
      key: {
        kty: 'EC', crv: 'P-256',
        x: point.subarray(1, 33).toString('base64url'),
        y: point.subarray(33, 65).toString('base64url'),
      },
      format: 'jwk',
    });
    return cryptoVerify('sha256', Buffer.from(message, 'utf8'), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sigHex, 'hex'));
  } catch {
    return false;
  }
}

export type OutputKeyRegistration =
  | { readonly ok: true; readonly created: boolean; readonly key_id: string; readonly public_key: string }
  | { readonly ok: false; readonly status: number; readonly error: string };

function readProof(body: unknown): { publicKey: string | null; proof: string | null } {
  const b = (body ?? {}) as { public_key?: unknown; proof?: unknown };
  const proof = typeof b.proof === 'string' ? b.proof.trim().toLowerCase() : null;
  return { publicKey: canonicalP256PublicKey(b.public_key), proof };
}

/**
 * Register a BEARER device's P-256 output key (device auth). Idempotent for the same key; a
 * Secure-Enclave device signs with its registered signing key and needs none.
 */
export async function registerDeviceOutputKey(
  db: Firestore,
  device: { readonly device_id: string; readonly signing_method?: string; readonly status?: string },
  body: unknown,
): Promise<OutputKeyRegistration> {
  if (device.status !== undefined && device.status !== 'active') return { ok: false, status: 403, error: 'device_not_active' };
  if (device.signing_method === 'secure_enclave_p256') {
    return { ok: false, status: 409, error: 'secure_enclave_device_signs_with_its_signing_key' };
  }
  const { publicKey, proof } = readProof(body);
  if (publicKey === null) return { ok: false, status: 400, error: 'public_key must be a SEC1 uncompressed P-256 point (04 || X || Y, hex)' };
  if (proof === null || !verifyP256Sha256(publicKey, outputKeyRegistrationMessage('device', device.device_id, publicKey), proof)) {
    return { ok: false, status: 400, error: 'proof_of_possession_invalid' };
  }
  const ref = db.collection('devices').doc(device.device_id);
  return db.runTransaction(async (txn): Promise<OutputKeyRegistration> => {
    const snap = await txn.get(ref);
    if (!snap.exists) return { ok: false, status: 404, error: 'device_not_found' };
    const current = canonicalP256PublicKey((snap.data() as Record<string, unknown>).output_signing_public_key);
    if (current !== null) {
      return current === publicKey
        ? { ok: true, created: false, key_id: device.device_id, public_key: publicKey }
        : { ok: false, status: 409, error: 'output_key_already_registered' };
    }
    txn.set(ref, { output_signing_public_key: publicKey, output_signing_key_registered_at_ms: Date.now() }, { merge: true });
    return { ok: true, created: true, key_id: device.device_id, public_key: publicKey };
  });
}

/** Register a phone's P-256 PE-attestation key as its output key (wallet auth). Idempotent. */
export async function registerAppOutputKey(
  db: Firestore,
  userId: string,
  body: unknown,
  nowMs: number,
): Promise<OutputKeyRegistration> {
  if (userId.length === 0 || userId.includes(':')) return { ok: false, status: 400, error: 'invalid_user' };
  const { publicKey, proof } = readProof(body);
  if (publicKey === null) return { ok: false, status: 400, error: 'public_key must be a SEC1 uncompressed P-256 point (04 || X || Y, hex)' };
  if (proof === null || !verifyP256Sha256(publicKey, outputKeyRegistrationMessage('app', userId, publicKey), proof)) {
    return { ok: false, status: 400, error: 'proof_of_possession_invalid' };
  }
  const keyId = appOutputKeyId(publicKey);
  const ref = db.collection(APP_OUTPUT_KEYS_COLLECTION).doc(keyId);
  return db.runTransaction(async (txn): Promise<OutputKeyRegistration> => {
    const snap = await txn.get(ref);
    if (snap.exists) {
      const rec = snap.data() as Partial<AppOutputKeyRecord>;
      // One key, one owner: a key another account registered is refused.
      return rec.owner_user_id === userId
        ? { ok: true, created: false, key_id: keyId, public_key: publicKey }
        : { ok: false, status: 409, error: 'output_key_bound_to_other_owner' };
    }
    const record: AppOutputKeyRecord = {
      schema_version: APP_OUTPUT_KEY_SCHEMA, key_id: keyId, public_key: publicKey,
      owner_user_id: userId, status: 'active', created_at_ms: nowMs,
    };
    txn.set(ref, record);
    return { ok: true, created: true, key_id: keyId, public_key: publicKey };
  });
}

/** What a device / app signer resolves to: the key to verify with, and the owning actor. */
export interface RegisteredOutputKey {
  readonly publicKey: string;
  readonly actorId: string;
}

/**
 * A registered device's output key and owner, or null (unknown / revoked device, no key, owner not
 * resolvable). A read that throws propagates (the caller resolves to no owner).
 */
export async function readDeviceOutputKey(db: Firestore, deviceId: string): Promise<RegisteredOutputKey | null> {
  const snap = await db.collection('devices').doc(deviceId).get();
  if (!snap.exists) return null;
  const d = snap.data() as Record<string, unknown>;
  if (d.status !== 'active' || d.device_id !== deviceId) return null;
  const publicKey = d.signing_method === 'secure_enclave_p256'
    ? canonicalP256PublicKey(d.signing_public_key)
    : canonicalP256PublicKey(d.output_signing_public_key);
  if (publicKey === null) return null;
  if (d.owner_type === 'human') {
    return typeof d.owner_user_id === 'string' && d.owner_user_id.length > 0 ? { publicKey, actorId: d.owner_user_id } : null;
  }
  if (d.owner_type !== 'agent' || typeof d.owner_wallet_id !== 'string' || d.owner_wallet_id.length === 0) return null;
  // An agent device keys its work under the agent's `agent_id`; resolved here fail-CLOSED.
  const wallet = await db.collection('agent_wallets').doc(d.owner_wallet_id).get();
  const agentId = wallet.exists ? (wallet.data() as Record<string, unknown>).agent_id : null;
  return typeof agentId === 'string' && agentId.length > 0 ? { publicKey, actorId: agentId } : null;
}

/** A registered app output key and its owner, or null (unknown / revoked / malformed). */
export async function readAppOutputKey(db: Firestore, keyId: string): Promise<RegisteredOutputKey | null> {
  const snap = await db.collection(APP_OUTPUT_KEYS_COLLECTION).doc(keyId).get();
  if (!snap.exists) return null;
  const r = snap.data() as Partial<AppOutputKeyRecord>;
  if (r.schema_version !== APP_OUTPUT_KEY_SCHEMA || r.status !== 'active' || r.key_id !== keyId) return null;
  const publicKey = canonicalP256PublicKey(r.public_key);
  if (publicKey === null || appOutputKeyId(publicKey) !== keyId) return null;
  return typeof r.owner_user_id === 'string' && r.owner_user_id.length > 0 ? { publicKey, actorId: r.owner_user_id } : null;
}
