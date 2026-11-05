/**
 * Device-credential resolution for the stdio MCP server.
 *
 * Reads/writes ~/.provian/credentials — the SDK's env-format device file
 * (KEY=VALUE lines, 0600) — so the MCP server, the CLI, and the observer all
 * share ONE registered device per machine instead of minting one each.
 *
 * Safety rule: file credentials are reused only when PROVIAN_OWNER_TYPE=agent.
 * A human-owned device file (from `register-device` without --agent) is left
 * alone — submitting agent PEs through a human device would silently attribute
 * them to the human's wallet. Env vars (PROVIAN_DEVICE_KEY/SECRET) are treated
 * as explicit operator intent and used as-is.
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { createHash, randomBytes, randomUUID } from 'crypto';
import type { DeviceAuth, PendingDeviceRegistration } from './core/types';

export const DEVICE_CREDS_PATH = path.join(homedir(), '.provian', 'credentials');
export const MCP_PENDING_DEVICE_REGISTRATION_PATH = path.join(
  homedir(),
  '.provian',
  'pending-mcp-device-registration.json',
);
const DEFAULT_RELAY_URL = 'https://api.provian.ai';

interface PersistedPendingDeviceRegistration {
  schema_version: 'provian-mcp-device-registration/v1';
  context_sha256: string;
  registration_id: string;
  device_key: string;
  device_secret: string;
  created_at_ms: number;
}

interface BoundDeviceCredentialsFile {
  deviceKey: string;
  deviceSecret: string;
  deviceId: string;
  walletId: string;
  registrationId: string;
}

const PENDING_KEYS = [
  'context_sha256',
  'created_at_ms',
  'device_key',
  'device_secret',
  'registration_id',
  'schema_version',
] as const;
const DEVICE_KEY = /^pdk_[a-f0-9]{32}$/;
const DEVICE_SECRET = /^pds_[a-f0-9]{64}$/;
const REGISTRATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{15,127}$/;

function hasPathEntry(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return true;
  }
}

function readPrivateText(filePath: string, label: string): string {
  const noFollow = process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW;
  let fd: number;
  try {
    const pathStat = fs.lstatSync(filePath);
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
      throw new Error(`${label} must be a private regular file`);
    }
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    throw new Error(`${label} is missing, unreadable, or unsafe`);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()
      || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
      throw new Error(`${label} must be a private 0600 regular file`);
    }
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncParentDirectory(filePath: string): void {
  const directoryFd = fs.openSync(path.dirname(filePath), 'r');
  try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
}

function pendingContextHash(context: {
  owner_key: string;
  device_name: string;
  platform: string;
}): string {
  return createHash('sha256').update(JSON.stringify({
    owner_key: context.owner_key,
    device_name: context.device_name,
    platform: context.platform,
  })).digest('hex');
}

function parsePendingRegistration(
  raw: string,
  expectedContextHash?: string,
): PersistedPendingDeviceRegistration {
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    parsed = value as Record<string, unknown>;
  } catch {
    throw new Error('Pending MCP device registration is malformed; refusing to replace an ambiguous identity');
  }
  const keys = Object.keys(parsed).sort();
  if (keys.length !== PENDING_KEYS.length
    || keys.some((key, index) => key !== PENDING_KEYS[index])
    || parsed.schema_version !== 'provian-mcp-device-registration/v1'
    || typeof parsed.context_sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(parsed.context_sha256)
    || (expectedContextHash !== undefined && parsed.context_sha256 !== expectedContextHash)
    || typeof parsed.registration_id !== 'string'
    || !REGISTRATION_ID.test(parsed.registration_id)
    || typeof parsed.device_key !== 'string'
    || !DEVICE_KEY.test(parsed.device_key)
    || typeof parsed.device_secret !== 'string'
    || !DEVICE_SECRET.test(parsed.device_secret)
    || typeof parsed.created_at_ms !== 'number'
    || !Number.isSafeInteger(parsed.created_at_ms)
    || parsed.created_at_ms < 0) {
    throw new Error(
      'Pending MCP device registration does not match this agent/context; refusing to create a second ambiguous identity',
    );
  }
  return parsed as unknown as PersistedPendingDeviceRegistration;
}

/**
 * Persist a stable pending registration before the caller is allowed to send
 * the first network request. Atomic rename means a crash yields either no
 * request identity (and therefore no request) or the complete reusable one.
 */
export function loadOrCreatePendingDeviceRegistration(
  context: { owner_key: string; device_name: string; platform: string },
  pendingPath: string = MCP_PENDING_DEVICE_REGISTRATION_PATH,
): PendingDeviceRegistration {
  const contextSha256 = pendingContextHash(context);
  if (hasPathEntry(pendingPath)) {
    const existing = parsePendingRegistration(
      readPrivateText(pendingPath, 'Pending MCP device registration'),
      contextSha256,
    );
    return {
      registrationId: existing.registration_id,
      deviceKey: existing.device_key,
      deviceSecret: existing.device_secret,
    };
  }

  const pending: PersistedPendingDeviceRegistration = {
    schema_version: 'provian-mcp-device-registration/v1',
    context_sha256: contextSha256,
    registration_id: `mcp-device-registration-${randomUUID()}`,
    device_key: `pdk_${randomBytes(16).toString('hex')}`,
    device_secret: `pds_${randomBytes(32).toString('hex')}`,
    created_at_ms: Date.now(),
  };
  fs.mkdirSync(path.dirname(pendingPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${pendingPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const fd = fs.openSync(temporaryPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(pending, null, 2)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // link is create-if-absent (unlike rename, which would replace a winner).
    // Concurrent first-use calls therefore converge on one complete identity.
    try {
      fs.linkSync(temporaryPath, pendingPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const winner = parsePendingRegistration(
        readPrivateText(pendingPath, 'Pending MCP device registration'),
        contextSha256,
      );
      return {
        registrationId: winner.registration_id,
        deviceKey: winner.device_key,
        deviceSecret: winner.device_secret,
      };
    }
    const directoryFd = fs.openSync(path.dirname(pendingPath), 'r');
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch { /* no partial temp file */ }
    throw error;
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch { /* linked file already durable */ }
  }
  return {
    registrationId: pending.registration_id,
    deviceKey: pending.device_key,
    deviceSecret: pending.device_secret,
  };
}

/** Delete only the exact pending identity that just became durable. */
export function clearPendingDeviceRegistration(
  registrationId: string,
  pendingPath: string = MCP_PENDING_DEVICE_REGISTRATION_PATH,
  credsPath: string = DEVICE_CREDS_PATH,
): void {
  if (!hasPathEntry(pendingPath)) return;
  const parsed = parsePendingRegistration(
    readPrivateText(pendingPath, 'Pending MCP device registration'),
  );
  if (parsed.registration_id !== registrationId) {
    throw new Error('Pending MCP device registration changed before acknowledgement');
  }
  const installed = loadBoundDeviceCredentialsFile(credsPath);
  if (!installed
    || installed.registrationId !== parsed.registration_id
    || installed.deviceKey !== parsed.device_key
    || installed.deviceSecret !== parsed.device_secret) {
    throw new Error('Installed device credentials do not match the pending registration');
  }
  fs.unlinkSync(pendingPath);
  fsyncParentDirectory(pendingPath);
}

/** Finish the legal crash state where bound credentials crossed their fsync
 * barrier but pending deletion did not. A legacy/unbound device file is left
 * untouched because it cannot authenticate the pending identity. */
export function reconcileInstalledDeviceRegistration(
  pendingPath: string = MCP_PENDING_DEVICE_REGISTRATION_PATH,
  credsPath: string = DEVICE_CREDS_PATH,
): void {
  if (!hasPathEntry(pendingPath)) return;
  const installed = loadBoundDeviceCredentialsFile(credsPath);
  if (!installed) return;
  clearPendingDeviceRegistration(installed.registrationId, pendingPath, credsPath);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseEnvFormat(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = body.indexOf('=');
    if (eq === -1) continue;
    const key = body.slice(0, eq).trim();
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      throw new Error(`Duplicate device credential field ${key}`);
    }
    values[key] = unquote(body.slice(eq + 1));
  }
  return values;
}

function loadDeviceCredentialValues(credsPath: string): Record<string, string> | null {
  if (!hasPathEntry(credsPath)) return null;
  try {
    return parseEnvFormat(readPrivateText(credsPath, 'Device credentials'));
  } catch {
    return null;
  }
}

export function loadBoundDeviceCredentialsFile(
  credsPath: string = DEVICE_CREDS_PATH,
): BoundDeviceCredentialsFile | null {
  const values = loadDeviceCredentialValues(credsPath);
  if (!values
    || values.PROVIAN_OWNER_TYPE !== 'agent'
    || !DEVICE_KEY.test(values.PROVIAN_DEVICE_KEY || '')
    || !DEVICE_SECRET.test(values.PROVIAN_DEVICE_SECRET || '')
    || !/^dev_[a-f0-9]{64}$/.test(values.PROVIAN_DEVICE_ID || '')
    || !/^wallet_aw_[A-Za-z0-9_-]+$/.test(values.PROVIAN_AGENT_WALLET_ID || '')
    || !REGISTRATION_ID.test(values.PROVIAN_DEVICE_REGISTRATION_ID || '')) return null;
  return {
    deviceKey: values.PROVIAN_DEVICE_KEY,
    deviceSecret: values.PROVIAN_DEVICE_SECRET,
    deviceId: values.PROVIAN_DEVICE_ID,
    walletId: values.PROVIAN_AGENT_WALLET_ID,
    registrationId: values.PROVIAN_DEVICE_REGISTRATION_ID,
  };
}

/** Resolve device credentials: env first, then an agent-owned device file. */
export function resolveLocalDeviceAuth(
  env: NodeJS.ProcessEnv = process.env,
  credsPath: string = DEVICE_CREDS_PATH,
): DeviceAuth | null {
  const envKey = env.PROVIAN_DEVICE_KEY?.trim();
  const envSecret = env.PROVIAN_DEVICE_SECRET?.trim();
  if (envKey && envSecret) return { deviceKey: envKey, deviceSecret: envSecret };

  try {
    const values = loadDeviceCredentialValues(credsPath);
    if (!values || values.PROVIAN_OWNER_TYPE !== 'agent') return null;
    const key = values.PROVIAN_DEVICE_KEY;
    const secret = values.PROVIAN_DEVICE_SECRET;
    if (!DEVICE_KEY.test(key || '') || !DEVICE_SECRET.test(secret || '')) return null;
    return { deviceKey: key, deviceSecret: secret };
  } catch {
    return null;
  }
}

/**
 * Persist device credentials in the SDK's exact file format. Never overwrites
 * an existing file (an already-registered device identity wins). Returns the
 * path written, or null when skipped/failed.
 */
export function persistDeviceCredentialsFile(
  creds: {
    device_key: string;
    device_secret: string;
    device_id?: string;
    device_name?: string;
    wallet_id?: string;
    registration_id?: string;
  },
  credsPath: string = DEVICE_CREDS_PATH,
): string | null {
  try {
    if (!DEVICE_KEY.test(creds.device_key)
      || !DEVICE_SECRET.test(creds.device_secret)
      || typeof creds.device_id !== 'string'
      || !/^dev_[a-f0-9]{64}$/.test(creds.device_id)
      || typeof creds.wallet_id !== 'string'
      || !/^wallet_aw_[A-Za-z0-9_-]+$/.test(creds.wallet_id)
      || typeof creds.registration_id !== 'string'
      || !REGISTRATION_ID.test(creds.registration_id)) return null;
    if (hasPathEntry(credsPath)) return null;
    fs.mkdirSync(path.dirname(credsPath), { recursive: true, mode: 0o700 });
    const lines = [
      '# Provian device credentials',
      `PROVIAN_DEVICE_KEY=${creds.device_key}`,
      `PROVIAN_DEVICE_SECRET=${creds.device_secret}`,
      `PROVIAN_RELAY_URL=${DEFAULT_RELAY_URL}`,
    ];
    lines.push(`PROVIAN_DEVICE_ID=${creds.device_id}`);
    if (creds.device_name) lines.push(`PROVIAN_DEVICE_NAME=${JSON.stringify(creds.device_name)}`);
    lines.push(`PROVIAN_DEVICE_REGISTRATION_ID=${creds.registration_id}`);
    lines.push('PROVIAN_OWNER_TYPE=agent');
    lines.push(`PROVIAN_AGENT_WALLET_ID=${creds.wallet_id}`);
    const temporaryPath = `${credsPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      const fd = fs.openSync(temporaryPath, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, `${lines.join('\n')}\n`, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.linkSync(temporaryPath, credsPath);
      fsyncParentDirectory(credsPath);
    } finally {
      try { fs.unlinkSync(temporaryPath); } catch { /* linked */ }
    }
    const installed = loadBoundDeviceCredentialsFile(credsPath);
    if (!installed
      || installed.deviceKey !== creds.device_key
      || installed.deviceSecret !== creds.device_secret
      || installed.deviceId !== creds.device_id
      || installed.walletId !== creds.wallet_id
      || installed.registrationId !== creds.registration_id) {
      throw new Error('Installed device credentials failed exact verification');
    }
    return credsPath;
  } catch {
    return null;
  }
}
