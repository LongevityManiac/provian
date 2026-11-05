/**
 * Shared loader for ~/.provian/agent-credentials.json.
 *
 * This is the hand-dropped file holding an agent's API key + secret. Current
 * files also bind those credentials to wallet_id + EVM address. It is read by:
 *   - register-device (--agent auto-detect / api-key auth)
 *   - invite-device   (agent-initiated device-invite email)
 *
 * SECURITY: the loader REFUSES a file more permissive than 0600 on POSIX. The
 * file carries a long-lived agent secret; if the user got the chmod wrong we
 * fail loudly rather than treat the secret as world-readable. This 0600 check
 * MUST NOT be weakened by either caller.
 *
 * Factored into its own (side-effect-free) module so invite-device can reuse it
 * without importing register-device.ts, whose top-level `main()` would run on
 * import.
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir, platform as osPlatform } from 'os';
import { atomicReplacePrivateFile } from '../durable-private-file';

export const AGENT_CREDS_PATH = path.join(homedir(), '.provian', 'agent-credentials.json');

export interface AgentCredentialsFile {
  api_key?: string;
  api_secret?: string;
  wallet_id?: string;
  address?: string;
}

const API_KEY_PATTERN = /^pvn_live_[0-9a-f]{32}$/;
const API_SECRET_PATTERN = /^pvns_[0-9a-f]{64}$/;
const CURRENT_CREDENTIAL_KEYS = ['address', 'api_key', 'api_secret', 'wallet_id'] as const;

function hasPathEntry(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return true;
  }
}

function hasBoundWalletIdentity(
  value: AgentCredentialsFile,
): value is AgentCredentialsFile & { wallet_id: string; address: string } {
  return typeof value.wallet_id === 'string'
    && /^wallet_aw_[A-Za-z0-9_-]+$/.test(value.wallet_id)
    && typeof value.address === 'string'
    && /^0x[0-9a-fA-F]{40}$/.test(value.address);
}

export function isExactBoundCredentialsFile(
  value: unknown,
): value is Required<AgentCredentialsFile> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== CURRENT_CREDENTIAL_KEYS.length
    || keys.some((key, index) => key !== CURRENT_CREDENTIAL_KEYS[index])) return false;
  return typeof record.api_key === 'string'
    && API_KEY_PATTERN.test(record.api_key)
    && typeof record.api_secret === 'string'
    && API_SECRET_PATTERN.test(record.api_secret)
    && hasBoundWalletIdentity(record as AgentCredentialsFile);
}

/** Load only the current four-field, production-format wallet-bound shape.
 * Legacy API-only files remain usable by authentication callers but can never
 * prove a completed wallet or authorize ambiguous-response replacement. */
export function loadBoundAgentCredentialsFile(
  credsPath: string = AGENT_CREDS_PATH,
): Required<AgentCredentialsFile> | null {
  const credentials = loadAgentCredentialsFile(credsPath);
  return isExactBoundCredentialsFile(credentials) ? credentials : null;
}

/**
 * Load + validate ~/.provian/agent-credentials.json.
 *
 * Returns null when:
 *   - the file does not exist
 *   - (POSIX) the file mode is more permissive than 0600
 *   - the file is unparseable, or missing/invalid api_key / api_secret
 *
 * A non-null result is guaranteed to have api_key starting with `pvn_live_`
 * and api_secret starting with `pvns_`.
 *
 * `credsPath` is overridable for tests; defaults to AGENT_CREDS_PATH.
 */
export function loadAgentCredentialsFile(credsPath: string = AGENT_CREDS_PATH): AgentCredentialsFile | null {
  const noFollow = osPlatform() === 'win32' ? 0 : fs.constants.O_NOFOLLOW;
  let fd: number;
  try {
    fd = fs.openSync(credsPath, fs.constants.O_RDONLY | noFollow);
  } catch {
    return null;
  }
  try {
    const stat = fs.fstatSync(fd);
    const mode = stat.mode & 0o777;
    if (!stat.isFile() || (osPlatform() !== 'win32' && (mode & 0o077) !== 0)) {
      console.error(`  Error: ${credsPath} must be a private 0600 regular file; refusing to read.`);
      return null;
    }
    const raw = fs.readFileSync(fd, 'utf-8');
    const parsed = JSON.parse(raw) as AgentCredentialsFile;
    if (!parsed.api_key || !parsed.api_secret) return null;
    if (!parsed.api_key.startsWith('pvn_live_')) return null;
    if (!parsed.api_secret.startsWith('pvns_')) return null;
    return parsed;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Atomically persist current agent credentials. Replacing credentials is
 * allowed only for the same wallet, which supports response-loss recovery
 * after the backend transactionally invalidates the previous pair. */
export function persistAgentCredentialsFile(
  credentials: Required<Pick<AgentCredentialsFile, 'api_key' | 'api_secret' | 'wallet_id' | 'address'>>,
  credsPath: string = AGENT_CREDS_PATH,
): string {
  if (!isExactBoundCredentialsFile(credentials)) {
    throw new Error('Refusing to persist malformed or unbound agent credentials');
  }
  const existing = loadAgentCredentialsFile(credsPath);
  if (hasPathEntry(credsPath) && !existing) {
    throw new Error(`Refusing to replace malformed or unsafe credentials file at ${credsPath}`);
  }
  if (existing && !isExactBoundCredentialsFile(existing)) {
    throw new Error(
      'Refusing to replace credentials without an exact authenticated wallet binding',
    );
  }
  if (existing && (existing.wallet_id !== credentials.wallet_id
    || existing.address.toLowerCase() !== credentials.address.toLowerCase())) {
    throw new Error(
      `Refusing to replace credentials for different wallet identity ${existing.wallet_id}/${existing.address}`,
    );
  }
  atomicReplacePrivateFile(credsPath, `${JSON.stringify(credentials, null, 2)}\n`);
  return credsPath;
}
