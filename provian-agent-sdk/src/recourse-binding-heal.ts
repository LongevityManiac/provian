/**
 * recourse-binding-heal — the agent re-signs its Recourse ownership binding on its own.
 *
 * An install never waits for its binding: the relay sends it in the background. A binding
 * signature is valid on chain for five minutes, so if the relay could not send it in time the
 * request closes as expired. The daemon runs this every minute until the relay reports the
 * address bound: while the last signature is still live (or just expired and may yet be
 * reported) it waits; after that it fetches a fresh challenge and signs again.
 *
 * Never throws. Only the address, signature expiry and time are kept on disk; no key material.
 */
import * as fs from 'fs';
import * as path from 'path';
import { bindRecourseOwnership, readRecourseOwnership, type RecourseConfig } from './recourse';
import { loadKeystore, getDefaultKeystorePath, type AgentKeystore } from './keystore';
import { readLocalKeystoreSecret, LOCAL_KEYSTORE_SECRET_PATH } from './local-keystore-secret';

export type BindingHealOutcome = 'bound' | 'pending' | 'signed' | 'no_keystore' | 'failed';
/** After a signature's expiry, how long the relay may still take to report it bound. */
export const BINDING_REPORT_GRACE_MS = 3 * 60_000;
export const RECOURSE_BINDING_STATE_FILE = 'recourse-binding.json';

export interface BindingHealDeps {
  readonly now?: () => number;
  readonly keystorePath?: string;
  readonly loadKeystore?: () => AgentKeystore | null;
  readonly readSecret?: () => string | null;
  readonly readOwnership?: (config: RecourseConfig) => Promise<unknown>;
  readonly bind?: typeof bindRecourseOwnership;
  readonly statePath?: string;
}
interface BindingAttempt { readonly address: string; readonly expiresAtMs: number; readonly signedAtMs: number; }

function readAttempt(file: string): BindingAttempt | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<BindingAttempt>;
    return typeof value.address === 'string' && Number.isSafeInteger(value.expiresAtMs) && Number.isSafeInteger(value.signedAtMs)
      ? value as BindingAttempt : null;
  } catch { return null; }
}
function writeAttempt(file: string, attempt: BindingAttempt): void {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(attempt), { mode: 0o600 });
  fs.renameSync(temporary, file);
}
/** True when the relay reports this exact address bound on chain. */
export function relayReportsBound(ownership: unknown, address: string): boolean {
  if (!ownership || typeof ownership !== 'object' || !('addresses' in ownership) || !Array.isArray(ownership.addresses)) return false;
  return ownership.addresses.some((row: unknown) => !!row && typeof row === 'object'
    && (row as Record<string, unknown>).address === address && (row as Record<string, unknown>).chainBindingStatus === 'confirmed');
}

/** Record a signed binding so the daemon does not re-sign while it may still land. */
export function recordBindingAttempt(keystorePath: string, address: string, now: () => number = Date.now) {
  const file = path.join(path.dirname(keystorePath), RECOURSE_BINDING_STATE_FILE);
  return (binding: { readonly expiresAtMs: number }) => {
    try { writeAttempt(file, { address: address.toLowerCase(), expiresAtMs: binding.expiresAtMs, signedAtMs: now() }); } catch { /* the heal re-signs */ }
  };
}
export async function ensureRecourseBinding(config: RecourseConfig, deps: BindingHealDeps = {}): Promise<BindingHealOutcome> {
  const now = deps.now ?? Date.now;
  const keystorePath = deps.keystorePath ?? getDefaultKeystorePath();
  const statePath = deps.statePath ?? path.join(path.dirname(keystorePath), RECOURSE_BINDING_STATE_FILE);
  let keystore: AgentKeystore | null;
  try { keystore = (deps.loadKeystore ?? (() => loadKeystore(keystorePath)))(); } catch { return 'failed'; }
  if (!keystore || keystore.wallet_id !== config.walletId) return 'no_keystore';
  const address = keystore.address.toLowerCase();
  try {
    if (relayReportsBound(await (deps.readOwnership ?? readRecourseOwnership)(config), address)) return 'bound';
  } catch { return 'failed'; }
  const last = readAttempt(statePath);
  if (last && last.address === address && now() < last.expiresAtMs + BINDING_REPORT_GRACE_MS) return 'pending';
  // The installer's local secret, or the passphrase an npm-created wallet runs its observer with.
  const passphrase = (deps.readSecret ?? (() => readLocalKeystoreSecret(LOCAL_KEYSTORE_SECRET_PATH) ?? process.env.PROVIAN_KEYSTORE_PASSPHRASE ?? null))();
  if (!passphrase) return 'no_keystore';
  try {
    await (deps.bind ?? bindRecourseOwnership)(config, { keystore, passphrase, keystorePath }, { wait: false,
      onSigned: binding => writeAttempt(statePath, { address, expiresAtMs: binding.expiresAtMs, signedAtMs: now() }) });
    return 'signed';
  } catch { return 'failed'; }
}
