import { createHash, randomBytes, randomUUID } from 'crypto';
import * as fs from 'fs';
import { homedir } from 'os';
import * as path from 'path';

export const DEFAULT_PENDING_DEVICE_REGISTRATION_PATH = path.join(
  homedir(), '.provian', 'pending-device-registration.json',
);

export interface PendingDeviceRegistrationContext {
  relay_url: string;
  authorization_sha256: string;
  owner_type: 'human' | 'agent';
  device_name: string;
  platform: string;
  attestation_capability: string;
  hardware_signing_required: boolean;
  signing_method: 'bearer' | 'secure_enclave_p256';
  signing_public_key: string | null;
  signing_key_alias: string | null;
}

export interface PendingDeviceRegistration {
  schema_version: 'provian-device-registration/v2';
  context: PendingDeviceRegistrationContext;
  context_sha256: string;
  registration_id: string;
  device_key: string;
  device_secret: string;
  created_at_ms: number;
}

interface InstalledDeviceRegistration {
  registrationId?: string;
  deviceKey?: string;
  deviceSecret?: string;
  relayUrl?: string;
  deviceId?: string;
  ownerType?: 'human' | 'agent';
  agentWalletId?: string;
  signingMethod?: 'bearer' | 'secure_enclave_p256';
  signingKeyAlias?: string;
}

const PENDING_KEYS = [
  'context',
  'context_sha256',
  'created_at_ms',
  'device_key',
  'device_secret',
  'registration_id',
  'schema_version',
] as const;
const CONTEXT_KEYS = [
  'attestation_capability',
  'authorization_sha256',
  'device_name',
  'hardware_signing_required',
  'owner_type',
  'platform',
  'relay_url',
  'signing_key_alias',
  'signing_method',
  'signing_public_key',
] as const;
const REGISTRATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{15,127}$/;

function canonicalContext(
  context: PendingDeviceRegistrationContext,
): PendingDeviceRegistrationContext {
  return {
    relay_url: context.relay_url,
    authorization_sha256: context.authorization_sha256,
    owner_type: context.owner_type,
    device_name: context.device_name,
    platform: context.platform,
    attestation_capability: context.attestation_capability,
    hardware_signing_required: context.hardware_signing_required,
    signing_method: context.signing_method,
    signing_public_key: context.signing_public_key,
    signing_key_alias: context.signing_key_alias,
  };
}

function contextHash(context: PendingDeviceRegistrationContext): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalContext(context)), 'utf8')
    .digest('hex');
}

function validateContext(context: PendingDeviceRegistrationContext): void {
  if (typeof context.relay_url !== 'string' || context.relay_url.trim().length === 0
    || !/^[a-f0-9]{64}$/.test(context.authorization_sha256)
    || (context.owner_type !== 'human' && context.owner_type !== 'agent')
    || typeof context.device_name !== 'string' || context.device_name.trim().length === 0
    || context.device_name.length > 100
    || typeof context.platform !== 'string' || context.platform.trim().length === 0
    || context.platform.length > 50
    || typeof context.attestation_capability !== 'string'
    || context.attestation_capability.length === 0
    || typeof context.hardware_signing_required !== 'boolean'
    || (context.signing_method !== 'bearer'
      && context.signing_method !== 'secure_enclave_p256')
    || (context.signing_public_key !== null
      && !/^(?:04)?[a-fA-F0-9]{128}$/.test(context.signing_public_key))
    || (context.signing_key_alias !== null
      && !/^[A-Za-z0-9_.:@-]{1,128}$/.test(context.signing_key_alias))
    || (context.signing_method === 'bearer'
      && (context.signing_public_key !== null || context.signing_key_alias !== null))
    || (context.signing_method === 'secure_enclave_p256'
      && (context.signing_public_key === null || context.signing_key_alias === null))
    || (context.hardware_signing_required && context.signing_method !== 'secure_enclave_p256')) {
    throw new Error('Device registration context is malformed');
  }
}

export type PendingDeviceRegistrationBaseContext = Omit<
  PendingDeviceRegistrationContext,
  'signing_method' | 'signing_public_key' | 'signing_key_alias'
>;

function validateBaseContext(context: PendingDeviceRegistrationBaseContext): void {
  validateContext({
    ...context,
    signing_method: context.hardware_signing_required
      ? 'secure_enclave_p256'
      : 'bearer',
    signing_public_key: context.hardware_signing_required ? '04'.padEnd(130, '0') : null,
    signing_key_alias: context.hardware_signing_required ? 'validation-only' : null,
  });
}

function hasPathEntry(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return true;
  }
}

function readPrivateFile(filePath: string): string {
  const noFollow = process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW;
  let fd: number;
  try {
    const pathStat = fs.lstatSync(filePath);
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
      throw new Error('Pending device registration must be a private regular file');
    }
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Pending device')) throw error;
    throw new Error('Pending device registration is missing, unreadable, or unsafe');
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()
      || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
      throw new Error('Pending device registration must be a private 0600 regular file');
    }
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function parsePending(raw: string, expectedContextHash?: string): PendingDeviceRegistration {
  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    value = parsed as Record<string, unknown>;
  } catch {
    throw new Error('Pending device registration is malformed; refusing replacement');
  }
  const keys = Object.keys(value).sort();
  const pendingContext = value.context;
  if (!pendingContext || typeof pendingContext !== 'object' || Array.isArray(pendingContext)) {
    throw new Error('Pending device registration is contradictory; refusing replacement');
  }
  const contextKeys = Object.keys(pendingContext).sort();
  if (contextKeys.length !== CONTEXT_KEYS.length
    || contextKeys.some((key, index) => key !== CONTEXT_KEYS[index])) {
    throw new Error('Pending device registration is contradictory; refusing replacement');
  }
  validateContext(pendingContext as unknown as PendingDeviceRegistrationContext);
  const persistedContextHash = contextHash(
    pendingContext as unknown as PendingDeviceRegistrationContext,
  );
  if (keys.length !== PENDING_KEYS.length
    || keys.some((key, index) => key !== PENDING_KEYS[index])
    || value.schema_version !== 'provian-device-registration/v2'
    || typeof value.context_sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.context_sha256)
    || value.context_sha256 !== persistedContextHash
    || (expectedContextHash !== undefined && value.context_sha256 !== expectedContextHash)
    || typeof value.registration_id !== 'string'
    || !REGISTRATION_ID.test(value.registration_id)
    || typeof value.device_key !== 'string'
    || !/^pdk_[a-f0-9]{32}$/.test(value.device_key)
    || typeof value.device_secret !== 'string'
    || !/^pds_[a-f0-9]{64}$/.test(value.device_secret)
    || typeof value.created_at_ms !== 'number'
    || !Number.isSafeInteger(value.created_at_ms)
    || value.created_at_ms < 0) {
    throw new Error('Pending device registration is contradictory; refusing replacement');
  }
  return value as unknown as PendingDeviceRegistration;
}

function baseContextMatches(
  pending: PendingDeviceRegistration,
  expected: PendingDeviceRegistrationBaseContext,
): boolean {
  return pending.context.relay_url === expected.relay_url
    && pending.context.authorization_sha256 === expected.authorization_sha256
    && pending.context.owner_type === expected.owner_type
    && pending.context.device_name === expected.device_name
    && pending.context.platform === expected.platform
    && pending.context.attestation_capability === expected.attestation_capability
    && pending.context.hardware_signing_required === expected.hardware_signing_required;
}

function fsyncParentDirectory(filePath: string): void {
  const directoryFd = fs.openSync(path.dirname(filePath), 'r');
  try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
}

function createPendingFile(filePath: string, pending: PendingDeviceRegistration): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const fd = fs.openSync(temporaryPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(pending, null, 2)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.linkSync(temporaryPath, filePath);
    fsyncParentDirectory(filePath);
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch { /* linked or never created */ }
  }
}

export function loadOrCreatePendingDeviceRegistration(
  context: PendingDeviceRegistrationContext,
  pendingPath: string = DEFAULT_PENDING_DEVICE_REGISTRATION_PATH,
): PendingDeviceRegistration {
  validateContext(context);
  const expectedContextHash = contextHash(context);
  if (hasPathEntry(pendingPath)) {
    return parsePending(readPrivateFile(pendingPath), expectedContextHash);
  }
  const pending: PendingDeviceRegistration = {
    schema_version: 'provian-device-registration/v2',
    context: canonicalContext(context),
    context_sha256: expectedContextHash,
    registration_id: `device-registration-${randomUUID()}`,
    device_key: `pdk_${randomBytes(16).toString('hex')}`,
    device_secret: `pds_${randomBytes(32).toString('hex')}`,
    created_at_ms: Date.now(),
  };
  try {
    createPendingFile(pendingPath, pending);
    return pending;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return parsePending(readPrivateFile(pendingPath), expectedContextHash);
  }
}

/**
 * Reopen a pre-network identity before any signing-key generation. The full
 * signing method, public key and local key alias are part of the durable
 * snapshot, so an ambiguous retry cannot silently generate or register a
 * different hardware identity.
 */
export function loadPendingDeviceRegistrationForContext(
  context: PendingDeviceRegistrationBaseContext,
  pendingPath: string = DEFAULT_PENDING_DEVICE_REGISTRATION_PATH,
): PendingDeviceRegistration | null {
  validateBaseContext(context);
  if (!hasPathEntry(pendingPath)) return null;
  const pending = parsePending(readPrivateFile(pendingPath));
  if (!baseContextMatches(pending, context)) {
    throw new Error('Pending device registration is contradictory; refusing replacement');
  }
  return pending;
}

function installedMatchesPending(
  installed: InstalledDeviceRegistration,
  pending: PendingDeviceRegistration,
): boolean {
  return installed.registrationId === pending.registration_id
    && installed.deviceKey === pending.device_key
    && installed.deviceSecret === pending.device_secret
    && installed.relayUrl === pending.context.relay_url
    && typeof installed.deviceId === 'string'
    && /^dev_[a-f0-9]{64}$/.test(installed.deviceId)
    && installed.ownerType === pending.context.owner_type
    && (installed.ownerType !== 'agent'
      || (typeof installed.agentWalletId === 'string'
        && /^wallet_aw_[A-Za-z0-9_-]+$/.test(installed.agentWalletId)))
    && installed.signingMethod === pending.context.signing_method
    && (pending.context.signing_method !== 'secure_enclave_p256'
      || installed.signingKeyAlias === pending.context.signing_key_alias);
}

export function clearPendingDeviceRegistration(
  registrationId: string,
  installed: InstalledDeviceRegistration,
  pendingPath: string = DEFAULT_PENDING_DEVICE_REGISTRATION_PATH,
): void {
  if (!hasPathEntry(pendingPath)) return;
  const pending = parsePending(readPrivateFile(pendingPath));
  if (pending.registration_id !== registrationId
    || !installedMatchesPending(installed, pending)) {
    throw new Error('Installed device credentials do not match the pending registration');
  }
  fs.unlinkSync(pendingPath);
  fsyncParentDirectory(pendingPath);
}

/**
 * Close the legal crash state where exact credentials crossed their durable
 * write barrier but pending deletion did not. Returns true only when the
 * pending identity was deleted; callers must then return without networking.
 */
export function reconcileInstalledDeviceRegistration(
  installed: InstalledDeviceRegistration | null,
  pendingPath: string = DEFAULT_PENDING_DEVICE_REGISTRATION_PATH,
): boolean {
  if (!hasPathEntry(pendingPath) || installed === null) return false;
  const pending = parsePending(readPrivateFile(pendingPath));
  if (installed.registrationId !== pending.registration_id) return false;
  if (!installedMatchesPending(installed, pending)) {
    throw new Error('Installed device credentials do not match the pending registration');
  }
  clearPendingDeviceRegistration(pending.registration_id, installed, pendingPath);
  return true;
}
