import { guardedFetch as fetch, guardedFetcher } from './guarded-fetch';
/**
 * at-rest-secret-health — the daemon's pre-flight check that its wallet
 * key is still usable AND recoverable.
 *
 * The agent wallet keystore is encrypted at rest under a random local secret
 * (`~/.provian/agent-keystore.secret`). If that secret is lost with the keystore
 * still present, the key can neither be used locally NOR — absent a phone escrow
 * recovered. The daemon refuses to earn without the secret and raises a
 * durable alarm, preventing accrual to an unusable wallet key.
 *
 * This module is pure + injectable so the verdict is unit-testable without a real
 * HOME. The daemon calls `checkAtRestSecretHealth()` before it registers any
 * earning plugin; `reportRecoveryAlarm()` posts the durable relay alarm the
 * Command Center surfaces.
 *
 * DELIBERATE non-trigger: a MISSING keystore is `ok`. A capture-only agent device
 * (registered by a device invite, no local wallet) legitimately runs without one;
 * the rule targets the Atlas shape — keystore PRESENT, secret GONE.
 */

import { hostname } from 'node:os';
import { loadKeystore, decryptKeystore, getDefaultKeystorePath, type AgentKeystore } from './keystore';
import { readLocalKeystoreSecret, LOCAL_KEYSTORE_SECRET_PATH } from './local-keystore-secret';

export type AtRestSecretReason =
  | 'at_rest_secret_missing'
  | 'at_rest_secret_nondecrypting';

export type AtRestSecretHealth =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: AtRestSecretReason };

export interface AtRestSecretHealthDeps {
  /** Load the agent keystore (or null if absent). Defaults to the real keystore file. */
  loadKeystore?: (path?: string) => AgentKeystore | null;
  /** Read the at-rest secret (or null if absent/malformed). Defaults to the real file. */
  readSecret?: (path?: string) => string | null;
  /** Try to decrypt; throws on a wrong secret. Defaults to the real cipher. */
  tryDecrypt?: (keystore: AgentKeystore, secret: string) => void;
  keystorePath?: string;
  secretPath?: string;
}

/**
 * Verdict for whether this machine's agent wallet key is usable + recoverable.
 * `ok` when there is no keystore to protect, or the keystore decrypts under the
 * present at-rest secret. Otherwise a specific reason the daemon alarms on and
 * refuses to earn under.
 */
export function checkAtRestSecretHealth(deps: AtRestSecretHealthDeps = {}): AtRestSecretHealth {
  const load = deps.loadKeystore ?? loadKeystore;
  const readSecret = deps.readSecret ?? readLocalKeystoreSecret;
  const tryDecrypt = deps.tryDecrypt ?? ((ks: AgentKeystore, secret: string) => { decryptKeystore(ks, secret); });
  const keystorePath = deps.keystorePath ?? getDefaultKeystorePath();
  const secretPath = deps.secretPath ?? LOCAL_KEYSTORE_SECRET_PATH;

  const keystore = load(keystorePath);
  if (!keystore) return { ok: true }; // nothing to protect — capture-only device.

  const secret = readSecret(secretPath);
  if (!secret) return { ok: false, reason: 'at_rest_secret_missing' };

  try {
    tryDecrypt(keystore, secret);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'at_rest_secret_nondecrypting' };
  }
}

/** Human-readable one-liner for the loud daemon log. Never prints any key material. */
export function describeAtRestSecretFailure(reason: AtRestSecretReason): string {
  if (reason === 'at_rest_secret_missing') {
    return `Your agent wallet keystore is present but its at-rest secret (${LOCAL_KEYSTORE_SECRET_PATH}) is GONE — the key cannot be used on this machine and, without a phone escrow, cannot be recovered. This daemon will NOT earn until it is recovered (re-key or restore from the Provian app).`;
  }
  return `Your agent wallet keystore cannot be decrypted with the at-rest secret on this machine — the two do not match. This daemon will NOT earn until the key is recovered (re-key or restore from the Provian app).`;
}

/**
 * Best-effort durable alarm to the relay so the Command Center surfaces this
 * unrecoverable agent. Uses the agent API credentials on this machine
 * (`~/.provian/agent-credentials.json`); when they are absent it cannot post
 * (the local refusal still stands). Never throws.
 */
export async function reportRecoveryAlarm(
  input: { relayUrl: string; walletId: string; apiKey: string; apiSecret: string; reason: AtRestSecretReason },
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  fetchImpl = guardedFetcher(fetchImpl);
  try {
    const url = `${input.relayUrl.replace(/\/+$/, '')}/v1/agent/wallet/${input.walletId}/recovery-alarm`;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.apiKey}:${input.apiSecret}` },
      body: JSON.stringify({ reason: input.reason, host: hostname().slice(0, 120) }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Best-effort "healthy again" report. Called on a HEALTHY agent-device daemon start so any
 * outstanding recovery alarm auto-clears from the Command Center without manual intervention. The
 * relay endpoint is idempotent (no-op when no alarm is active), so this is safe to post on every
 * start. Never throws.
 */
export async function reportRecoveryHealthy(
  input: { relayUrl: string; walletId: string; apiKey: string; apiSecret: string },
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  fetchImpl = guardedFetcher(fetchImpl);
  try {
    const url = `${input.relayUrl.replace(/\/+$/, '')}/v1/agent/wallet/${input.walletId}/recovery-alarm/clear`;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.apiKey}:${input.apiSecret}` },
      body: JSON.stringify({ host: hostname().slice(0, 120) }),
    });
    if (!res.ok) return false;
    // Report whether an alarm was ACTUALLY cleared (`cleared:true`), not merely that the idempotent
    // no-op POST returned 200 — so the daemon only logs "cleared" when there was something to clear.
    const body = (await res.json().catch(() => ({}))) as { cleared?: boolean };
    return body.cleared === true;
  } catch {
    return false;
  }
}
