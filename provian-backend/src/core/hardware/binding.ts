/**
 * The NONCE a hardware report must carry to witness THIS submission (§2.9): sha256 over the
 * canonical JSON of the submission body with `hardware_witness` removed. Canonical JSON = keys
 * sorted, no whitespace, `undefined` members dropped — byte-identical to the SDK's
 * `ProvianClient.stableStringify`, the device-auth middleware's canonicalizer, and
 * `json-stable-stringify` on plain JSON data, so every producer computes the same bytes the relay
 * recomputes. A report whose nonce equals anything else witnesses nothing.
 */
import crypto from 'crypto';

export const HARDWARE_WITNESS_FIELD = 'hardware_witness';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined) continue;
    parts.push(JSON.stringify(k) + ':' + canonicalJson(v));
  }
  return '{' + parts.join(',') + '}';
}

/** sha256 over the canonical body without `hardware_witness` (32 bytes). */
/**
 * Fields EXCLUDED from the binding on every side (relay, SDK, app): the slot itself, and the three
 * client-asserted identity keys the relay's global middleware strips IN PLACE before any handler
 * runs (`user_id` / `wallet_id` / `actor_address`, server.ts). Were they bound, the phone would
 * hash a body the relay never sees and every mobile assertion would fail `nonce_not_bound`.
 * Identity is derived from the auth context, never from these keys, so excluding them binds
 * nothing the relay trusts any less.
 */
export const HARDWARE_BINDING_EXCLUDED_FIELDS: readonly string[] = [HARDWARE_WITNESS_FIELD, 'user_id', 'wallet_id', 'actor_address'];

export function hardwareBindingNonce(body: unknown): Buffer {
  const b = (typeof body === 'object' && body !== null && !Array.isArray(body)) ? { ...(body as Record<string, unknown>) } : {};
  for (const k of HARDWARE_BINDING_EXCLUDED_FIELDS) delete b[k];
  return crypto.createHash('sha256').update(canonicalJson(b)).digest();
}

export function hardwareBindingNonceHex(body: unknown): string {
  return hardwareBindingNonce(body).toString('hex');
}
