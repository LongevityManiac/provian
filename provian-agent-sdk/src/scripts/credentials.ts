import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { atomicReplacePrivateFile } from '../durable-private-file';

export type DeviceOwnerType = 'human' | 'agent';
export type DeviceSigningMethod = 'bearer' | 'secure_enclave_p256';

export interface ProvianCredentials {
  deviceKey: string;
  deviceSecret: string;
  relayUrl: string;
  deviceId?: string;
  registrationId?: string;
  deviceName?: string;
  githubUsername?: string; // Used to detect personal repos for rich PE descriptions
  /**
   * Which kind of actor this device belongs to. Drives observer plugin
   * activation and is informational for developers - the backend already
   * knows the device's owner from the `devices` collection and applies
   * beneficiary resolution / PVT split automatically.
   *
   * Absent or 'human' → PEs attribute to the human wallet, which keeps the
   * full contributor allocation after the immutable treasury split;
   * ProcessPlugin and OTelPlugin stay dormant.
   *
   * 'agent' → all three default plugins active. Backend forces
   * attestationDepth='software' for agent-owned devices, which triggers
   * resolveBeneficiary() and a record-time beneficiary snapshot (20/80 by
   * default, with exact agent share prospectively bounded to 5-50%).
   */
  ownerType?: DeviceOwnerType;
  /** Agent wallet ID when ownerType='agent'. Informational. */
  agentWalletId?: string;
  /**
   * Per-PE signing method for outbound submissions.
   *   - 'bearer' (default / absent) - use DeviceKey:DeviceSecret in the Authorization header.
   *   - 'secure_enclave_p256' - canonicalize the payload, SHA-256 it, sign via the
   *     `provian-se-sign` CLI against the SE-resident key identified by
   *     `signingKeyAlias`, and send a DeviceSignature header. The bearer secret
   *     stays on disk as a fallback but is not used for signed submissions.
   */
  signingMethod?: DeviceSigningMethod;
  /**
   * Secure Enclave key alias, set only when signingMethod === 'secure_enclave_p256'.
   * Passed to `provian-se-sign --sign --key-alias <alias>`.
   */
  signingKeyAlias?: string;
}

const PROVIAN_DIR = path.join(homedir(), '.provian');
const CREDENTIALS_PATH = path.join(PROVIAN_DIR, 'credentials');
const DEFAULT_RELAY_URL = 'https://api.provian.ai';

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

function parseCredentialsFile(content: string): Partial<ProvianCredentials> {
  const values: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const exportPrefix = line.startsWith('export ') ? 'export ' : '';
    const body = exportPrefix ? line.slice(exportPrefix.length).trim() : line;
    const eq = body.indexOf('=');
    if (eq === -1) continue;

    const key = body.slice(0, eq).trim();
    const value = unquote(body.slice(eq + 1));
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      throw new Error(`Duplicate credentials field ${key}`);
    }
    values[key] = value;
  }

  const rawOwnerType = (values.PROVIAN_OWNER_TYPE || '').toLowerCase();
  const ownerType: DeviceOwnerType | undefined =
    rawOwnerType === 'agent' ? 'agent' : rawOwnerType === 'human' ? 'human' : undefined;

  const rawSigningMethod = (values.PROVIAN_SIGNING_METHOD || '').toLowerCase();
  const signingMethod: DeviceSigningMethod | undefined =
    rawSigningMethod === 'secure_enclave_p256' ? 'secure_enclave_p256'
    : rawSigningMethod === 'bearer' ? 'bearer'
    : undefined;

  return {
    deviceKey: values.PROVIAN_DEVICE_KEY,
    deviceSecret: values.PROVIAN_DEVICE_SECRET,
    relayUrl: values.PROVIAN_RELAY_URL,
    deviceId: values.PROVIAN_DEVICE_ID,
    registrationId: values.PROVIAN_DEVICE_REGISTRATION_ID,
    deviceName: values.PROVIAN_DEVICE_NAME,
    githubUsername: values.PROVIAN_GITHUB_USERNAME,
    ownerType,
    agentWalletId: values.PROVIAN_AGENT_WALLET_ID,
    signingMethod,
    signingKeyAlias: values.PROVIAN_SIGNING_KEY_ALIAS,
  };
}

export function getProvianDir(): string {
  return PROVIAN_DIR;
}

export function getCredentialsPath(): string {
  return CREDENTIALS_PATH;
}

export function getHookLogPath(): string {
  return path.join(PROVIAN_DIR, 'hook.log');
}

export function ensureProvianDir(): void {
  if (!fs.existsSync(PROVIAN_DIR)) {
    fs.mkdirSync(PROVIAN_DIR, { recursive: true, mode: 0o700 });
  }
}

export function readCredentialsFile(filePath = CREDENTIALS_PATH): Partial<ProvianCredentials> | null {
  const noFollow = process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW;
  let fd: number;
  try {
    const pathStat = fs.lstatSync(filePath);
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) return null;
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  } catch {
    return null;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()
      || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) return null;
    return parseCredentialsFile(fs.readFileSync(fd, 'utf8'));
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

export function writeCredentialsFile(credentials: ProvianCredentials, filePath = CREDENTIALS_PATH): void {
  if (!/^pdk_[a-f0-9]{32}$/.test(credentials.deviceKey)
    || !/^pds_[a-f0-9]{64}$/.test(credentials.deviceSecret)
    || (credentials.deviceId !== undefined
      && !/^dev_[a-f0-9]{64}$/.test(credentials.deviceId))
    || (credentials.registrationId !== undefined
      && !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{15,127}$/.test(credentials.registrationId))) {
    throw new Error('Refusing to persist malformed device credentials');
  }

  const lines = [
    '# Provian device credentials',
    `PROVIAN_DEVICE_KEY=${credentials.deviceKey}`,
    `PROVIAN_DEVICE_SECRET=${credentials.deviceSecret}`,
    `PROVIAN_RELAY_URL=${credentials.relayUrl || DEFAULT_RELAY_URL}`,
  ];

  if (credentials.deviceId) lines.push(`PROVIAN_DEVICE_ID=${credentials.deviceId}`);
  if (credentials.registrationId) {
    lines.push(`PROVIAN_DEVICE_REGISTRATION_ID=${credentials.registrationId}`);
  }
  if (credentials.deviceName) lines.push(`PROVIAN_DEVICE_NAME=${JSON.stringify(credentials.deviceName)}`);
  if (credentials.githubUsername) lines.push(`github_username=${credentials.githubUsername}`);
  if (credentials.ownerType) lines.push(`PROVIAN_OWNER_TYPE=${credentials.ownerType}`);
  if (credentials.agentWalletId) lines.push(`PROVIAN_AGENT_WALLET_ID=${credentials.agentWalletId}`);
  if (credentials.signingMethod) lines.push(`PROVIAN_SIGNING_METHOD=${credentials.signingMethod}`);
  if (credentials.signingKeyAlias) lines.push(`PROVIAN_SIGNING_KEY_ALIAS=${credentials.signingKeyAlias}`);

  atomicReplacePrivateFile(filePath, `${lines.join('\n')}\n`);
}

export function loadCredentials(): ProvianCredentials | null {
  const fileCreds = readCredentialsFile() || {};

  const deviceKey = fileCreds.deviceKey || process.env.PROVIAN_DEVICE_KEY;
  const deviceSecret = fileCreds.deviceSecret || process.env.PROVIAN_DEVICE_SECRET;
  const relayUrl = fileCreds.relayUrl || process.env.PROVIAN_RELAY_URL || DEFAULT_RELAY_URL;
  const deviceId = fileCreds.deviceId || process.env.PROVIAN_DEVICE_ID;
  const registrationId = fileCreds.registrationId || process.env.PROVIAN_DEVICE_REGISTRATION_ID;
  const deviceName = fileCreds.deviceName || process.env.PROVIAN_DEVICE_NAME;

  if (!deviceKey || !deviceSecret) {
    return null;
  }

  const envOwner = (process.env.PROVIAN_OWNER_TYPE || '').toLowerCase();
  const ownerType: DeviceOwnerType | undefined = fileCreds.ownerType
    ?? (envOwner === 'agent' ? 'agent' : envOwner === 'human' ? 'human' : undefined);
  const agentWalletId = fileCreds.agentWalletId || process.env.PROVIAN_AGENT_WALLET_ID;

  const envSigningMethod = (process.env.PROVIAN_SIGNING_METHOD || '').toLowerCase();
  const signingMethod: DeviceSigningMethod | undefined = fileCreds.signingMethod
    ?? (envSigningMethod === 'secure_enclave_p256' ? 'secure_enclave_p256'
      : envSigningMethod === 'bearer' ? 'bearer'
      : undefined);
  const signingKeyAlias = fileCreds.signingKeyAlias || process.env.PROVIAN_SIGNING_KEY_ALIAS;

  return {
    deviceKey,
    deviceSecret,
    relayUrl,
    deviceId,
    registrationId,
    deviceName,
    ownerType,
    agentWalletId,
    signingMethod,
    signingKeyAlias,
  };
}
