/**
 * Local credential resolution for the stdio MCP server.
 *
 * Precedence:
 *   1. PROVIAN_API_KEY + PROVIAN_API_SECRET environment variables
 *   2. ~/.provian/agent-credentials.json — the same hand-droppable file the
 *      SDK's register-device / invite-device scripts read
 *
 * The file loader mirrors the SDK's `agent-credentials-file.ts` exactly,
 * including the security posture: on POSIX the file is REFUSED when more
 * permissive than 0600 (it carries a long-lived agent secret; a wrong chmod
 * fails loudly rather than treating the secret as world-readable). Do not
 * weaken the 0600 check.
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir, platform as osPlatform } from 'os';
import { randomBytes } from 'crypto';
import type { ToolAuth } from './core/types';

export const AGENT_CREDS_PATH = path.join(homedir(), '.provian', 'agent-credentials.json');

interface AgentCredentialsFile {
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

function isExactBoundCredentialsFile(
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

/**
 * Load + validate ~/.provian/agent-credentials.json. Returns null when the
 * file is missing, too permissive (POSIX), unparseable, or malformed.
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
      console.error(`provian-mcp: ${credsPath} must be a private 0600 regular file; refusing to read.`);
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

/** Load only the exact current wallet-bound shape. Legacy API-only files may
 * authenticate existing calls but cannot prove completed-wallet recovery. */
export function loadBoundAgentCredentialsFile(
  credsPath: string = AGENT_CREDS_PATH,
): Required<AgentCredentialsFile> | null {
  const credentials = loadAgentCredentialsFile(credsPath);
  return isExactBoundCredentialsFile(credentials) ? credentials : null;
}

/** Resolve credentials: env first, then the credentials file. */
export function resolveLocalAuth(
  env: NodeJS.ProcessEnv = process.env,
  credsPath: string = AGENT_CREDS_PATH,
): ToolAuth | null {
  const envKey = env.PROVIAN_API_KEY?.trim();
  const envSecret = env.PROVIAN_API_SECRET?.trim();
  if (envKey && envSecret) {
    return { apiKey: envKey, apiSecret: envSecret };
  }
  const file = loadAgentCredentialsFile(credsPath);
  if (file?.api_key && file.api_secret) {
    return { apiKey: file.api_key, apiSecret: file.api_secret };
  }
  return null;
}

/**
 * Persist freshly minted credentials to ~/.provian/agent-credentials.json
 * (0600, directory 0700) so subsequent authenticated tool calls work.
 * Replaces only credentials for the same wallet so a response-loss recovery
 * can durably install the newly rotated pair. A different wallet fails closed.
 */
export function persistAgentCredentials(
  creds: { api_key: string; api_secret: string; wallet_id: string; address: string },
  credsPath: string = AGENT_CREDS_PATH,
): string | null {
  try {
    if (!isExactBoundCredentialsFile(creds)) return null;
    const existing = loadAgentCredentialsFile(credsPath);
    if (hasPathEntry(credsPath) && !existing) return null;
    if (existing && !isExactBoundCredentialsFile(existing)) return null;
    if (existing && (existing.wallet_id !== creds.wallet_id
      || existing.address.toLowerCase() !== creds.address.toLowerCase())) return null;
    fs.mkdirSync(path.dirname(credsPath), { recursive: true, mode: 0o700 });
    const temp = `${credsPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(creds, null, 2)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(temp, credsPath);
      fs.chmodSync(credsPath, 0o600);
      const installedFd = fs.openSync(credsPath, 'r');
      try {
        const installed = fs.fstatSync(installedFd);
        if (!installed.isFile()
          || (osPlatform() !== 'win32' && (installed.mode & 0o777) !== 0o600)) {
          throw new Error('installed credentials are not a 0600 regular file');
        }
        fs.fsyncSync(installedFd);
      } finally { fs.closeSync(installedFd); }
      const directoryFd = fs.openSync(path.dirname(credsPath), 'r');
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    } finally {
      try { fs.unlinkSync(temp); } catch { /* renamed */ }
    }
    return credsPath;
  } catch {
    return null;
  }
}
