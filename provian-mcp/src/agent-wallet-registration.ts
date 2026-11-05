import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
} from 'crypto';
import * as fs from 'fs';
import { homedir } from 'os';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';

import {
  deriveAddressFromPrivateKey,
  derivePublicKeyFromPrivateKey,
  generateAgentKeyPair,
} from './core/crypto';
import type { PendingAgentWalletRegistration } from './core/types';

export interface AgentWalletRegistrationContext {
  relay_url: string;
  agent_name: string;
  requested_agent_id: string | null;
  platform: string;
}

export const MCP_PENDING_AGENT_WALLET_PATH = path.join(
  homedir(), '.provian', 'pending-mcp-agent-wallet.json',
);
export const MCP_AGENT_WALLET_IDENTITY_PATH = path.join(
  homedir(), '.provian', 'agent-wallet-identity.json',
);

interface EncryptedPrivateKey {
  cipher: 'aes-256-gcm';
  kdf: 'scrypt';
  N: number;
  r: 8;
  p: 1;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

interface PendingAgentWalletFile {
  schema_version: 'provian-mcp-agent-wallet-pending/v1';
  context_sha256: string;
  registration_id: string;
  agent_id: string;
  agent_name: string;
  platform: string;
  constitution_accepted_at: string;
  public_key: string;
  address: string;
  created_at_ms: number;
  encrypted_private_key: EncryptedPrivateKey;
}

interface FinalAgentWalletFile {
  schema_version: 'provian-mcp-agent-wallet/v1';
  wallet_id: string;
  pending_identity: PendingAgentWalletFile;
}

export type AgentWalletCompletionStage =
  | 'final_identity_durable'
  | 'pending_identity_removed';

export interface CompleteAgentWalletRegistrationOptions {
  passphrase: string;
  context: AgentWalletRegistrationContext;
  pendingPath?: string;
  finalPath?: string;
  afterDurableStage?: (stage: AgentWalletCompletionStage) => void;
}

const PENDING_KEYS = [
  'address',
  'agent_id',
  'agent_name',
  'constitution_accepted_at',
  'context_sha256',
  'created_at_ms',
  'encrypted_private_key',
  'platform',
  'public_key',
  'registration_id',
  'schema_version',
] as const;
const ENCRYPTED_KEY_KEYS = [
  'N',
  'cipher',
  'ciphertext',
  'iv',
  'kdf',
  'p',
  'r',
  'salt',
  'tag',
] as const;
const FINAL_KEYS = ['pending_identity', 'schema_version', 'wallet_id'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
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

function readPrivateJson(filePath: string, label: string): unknown {
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
    return JSON.parse(fs.readFileSync(fd, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    throw new Error(`${label} is malformed`);
  } finally {
    fs.closeSync(fd);
  }
}

function contextHash(context: AgentWalletRegistrationContext): string {
  return createHash('sha256').update(JSON.stringify({
    relay_url: context.relay_url,
    agent_name: context.agent_name,
    requested_agent_id: context.requested_agent_id,
    platform: context.platform,
  }), 'utf8').digest('hex');
}

function validateContext(context: AgentWalletRegistrationContext): void {
  if (typeof context.relay_url !== 'string' || context.relay_url.trim().length === 0
    || typeof context.agent_name !== 'string' || context.agent_name.trim().length === 0
    || context.agent_name.length > 200
    || typeof context.platform !== 'string' || context.platform.trim().length === 0
    || context.platform.length > 64
    || (context.requested_agent_id !== null
      && !/^[A-Za-z0-9._-]{1,128}$/.test(context.requested_agent_id))) {
    throw new Error('MCP wallet registration context is malformed');
  }
}

function aad(file: Omit<PendingAgentWalletFile, 'encrypted_private_key'>): Buffer {
  return Buffer.from(JSON.stringify(file), 'utf8');
}

function deriveKey(passphrase: string, salt: Buffer, N: number): Buffer {
  return scryptSync(passphrase, salt, 32, { N, r: 8, p: 1, maxmem: 256 * N * 8 });
}

function parsePendingFile(
  value: unknown,
  expectedContext?: AgentWalletRegistrationContext,
): PendingAgentWalletFile {
  if (!isRecord(value) || !hasExactKeys(value, PENDING_KEYS)) {
    throw new Error('Pending MCP wallet identity has an unknown or incomplete schema');
  }
  const encrypted = value.encrypted_private_key;
  if (!isRecord(encrypted) || !hasExactKeys(encrypted, ENCRYPTED_KEY_KEYS)) {
    throw new Error('Pending MCP wallet encryption metadata has an unknown or incomplete schema');
  }
  if (value.schema_version !== 'provian-mcp-agent-wallet-pending/v1'
    || typeof value.context_sha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.context_sha256)
    || typeof value.registration_id !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{15,127}$/.test(value.registration_id)
    || typeof value.agent_id !== 'string'
    || !/^[A-Za-z0-9._-]{1,128}$/.test(value.agent_id)
    || typeof value.agent_name !== 'string'
    || value.agent_name.trim().length === 0
    || value.agent_name.length > 200
    || typeof value.platform !== 'string'
    || value.platform.trim().length === 0
    || value.platform.length > 64
    || typeof value.constitution_accepted_at !== 'string'
    || typeof value.created_at_ms !== 'number'
    || !Number.isSafeInteger(value.created_at_ms)
    || value.created_at_ms < 0
    || value.created_at_ms > 8_640_000_000_000_000
    || new Date(value.created_at_ms).toISOString() !== value.constitution_accepted_at
    || typeof value.public_key !== 'string'
    || !/^[0-9a-f]{128}$/.test(value.public_key)
    || typeof value.address !== 'string'
    || !/^0x[0-9a-fA-F]{40}$/.test(value.address)
    || encrypted.cipher !== 'aes-256-gcm'
    || encrypted.kdf !== 'scrypt'
    || typeof encrypted.N !== 'number'
    || !Number.isSafeInteger(encrypted.N)
    || encrypted.N < 1 << 10
    || encrypted.N > 1 << 20
    || (encrypted.N & (encrypted.N - 1)) !== 0
    || encrypted.r !== 8
    || encrypted.p !== 1
    || typeof encrypted.salt !== 'string'
    || !/^[0-9a-f]{64}$/.test(encrypted.salt)
    || typeof encrypted.iv !== 'string'
    || !/^[0-9a-f]{24}$/.test(encrypted.iv)
    || typeof encrypted.tag !== 'string'
    || !/^[0-9a-f]{32}$/.test(encrypted.tag)
    || typeof encrypted.ciphertext !== 'string'
    || !/^[0-9a-f]{64}$/.test(encrypted.ciphertext)) {
    throw new Error('Pending MCP wallet identity is malformed');
  }
  if (expectedContext
    && (value.context_sha256 !== contextHash(expectedContext)
      || value.agent_name !== expectedContext.agent_name
      || value.platform !== expectedContext.platform
      || (expectedContext.requested_agent_id !== null
        && value.agent_id !== expectedContext.requested_agent_id))) {
    throw new Error(
      'Pending MCP wallet identity does not match this relay/request context; refusing replacement',
    );
  }
  return value as unknown as PendingAgentWalletFile;
}

function parseFinalFile(value: unknown): FinalAgentWalletFile {
  if (!isRecord(value) || !hasExactKeys(value, FINAL_KEYS)
    || value.schema_version !== 'provian-mcp-agent-wallet/v1'
    || typeof value.wallet_id !== 'string'
    || !/^wallet_aw_[A-Za-z0-9_-]+$/.test(value.wallet_id)) {
    throw new Error('Completed MCP wallet identity is malformed');
  }
  return {
    schema_version: value.schema_version,
    wallet_id: value.wallet_id,
    pending_identity: parsePendingFile(value.pending_identity),
  };
}

function encryptPrivateKey(
  privateKey: string,
  header: Omit<PendingAgentWalletFile, 'encrypted_private_key'>,
  passphrase: string,
  N: number,
): EncryptedPrivateKey {
  if (passphrase.length < 8) throw new Error('PROVIAN_KEYSTORE_PASSPHRASE must be at least 8 characters');
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt, N), iv);
  cipher.setAAD(aad(header));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(privateKey, 'hex')),
    cipher.final(),
  ]);
  return {
    cipher: 'aes-256-gcm',
    kdf: 'scrypt',
    N,
    r: 8,
    p: 1,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}

function decryptPrivateKey(file: PendingAgentWalletFile, passphrase: string): string {
  const encrypted = file.encrypted_private_key;
  const { encrypted_private_key: _encrypted, ...header } = file;
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveKey(passphrase, Buffer.from(encrypted.salt, 'hex'), encrypted.N),
    Buffer.from(encrypted.iv, 'hex'),
  );
  decipher.setAAD(aad(header));
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'hex'));
  try {
    const privateKey = Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, 'hex')),
      decipher.final(),
    ]).toString('hex');
    if (!/^[0-9a-f]{64}$/.test(privateKey)
      || deriveAddressFromPrivateKey(privateKey).toLowerCase() !== file.address.toLowerCase()
      || derivePublicKeyFromPrivateKey(privateKey) !== file.public_key) {
      throw new Error('Pending MCP wallet key does not match its declared identity');
    }
    return privateKey;
  } catch {
    throw new Error('Unable to decrypt pending MCP wallet identity');
  }
}

function atomicCreate(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(temp, filePath);
    const dirFd = fs.openSync(path.dirname(filePath), 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } finally {
    try { fs.unlinkSync(temp); } catch { /* linked */ }
  }
}

function fsyncParentDirectory(filePath: string): void {
  const directoryFd = fs.openSync(path.dirname(filePath), 'r');
  try {
    fs.fsyncSync(directoryFd);
  } finally {
    fs.closeSync(directoryFd);
  }
}

function unlinkDurably(filePath: string): void {
  fs.unlinkSync(filePath);
  fsyncParentDirectory(filePath);
}

function decodedPending(
  raw: unknown,
  context: AgentWalletRegistrationContext | undefined,
  passphrase: string,
): { file: PendingAgentWalletFile; registration: PendingAgentWalletRegistration } {
  const file = parsePendingFile(raw, context);
  return {
    file,
    registration: {
      registrationId: file.registration_id,
      agentId: file.agent_id,
      agentName: file.agent_name,
      platform: file.platform,
      constitutionAcceptedAt: file.constitution_accepted_at,
      privateKey: decryptPrivateKey(file, passphrase),
      publicKey: file.public_key,
      address: file.address,
    },
  };
}

function readPending(
  context: AgentWalletRegistrationContext,
  passphrase: string,
  pendingPath: string,
): PendingAgentWalletRegistration {
  return decodedPending(
    readPrivateJson(pendingPath, 'Pending MCP wallet identity'),
    context,
    passphrase,
  ).registration;
}

export function loadOrCreatePendingAgentWalletRegistration(
  context: AgentWalletRegistrationContext,
  passphrase: string,
  pendingPath: string = MCP_PENDING_AGENT_WALLET_PATH,
  scryptN = 1 << 17,
): PendingAgentWalletRegistration {
  validateContext(context);
  if (hasPathEntry(pendingPath)) return readPending(context, passphrase, pendingPath);
  const slug = context.agent_name.toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '') || 'mcp-agent';
  const agentId = context.requested_agent_id ?? `${slug}-${randomBytes(3).toString('hex')}`;
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(agentId)) throw new Error('agent_id format is invalid');
  const keyPair = generateAgentKeyPair();
  const createdAtMs = Date.now();
  const header: Omit<PendingAgentWalletFile, 'encrypted_private_key'> = {
    schema_version: 'provian-mcp-agent-wallet-pending/v1',
    context_sha256: contextHash(context),
    registration_id: `mcp-agent-registration-${randomUUID()}`,
    agent_id: agentId,
    agent_name: context.agent_name,
    platform: context.platform,
    constitution_accepted_at: new Date(createdAtMs).toISOString(),
    public_key: keyPair.publicKey,
    address: keyPair.address,
    created_at_ms: createdAtMs,
  };
  const file: PendingAgentWalletFile = {
    ...header,
    encrypted_private_key: encryptPrivateKey(keyPair.privateKey, header, passphrase, scryptN),
  };
  try {
    atomicCreate(pendingPath, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return readPending(context, passphrase, pendingPath);
  }
  return { ...readPending(context, passphrase, pendingPath) };
}

/** Re-read the encrypted pending bytes after the relay challenge and require
 * them to match the exact identity used for that challenge. The create POST
 * must be built only from this second authenticated snapshot. */
export function reloadPendingAgentWalletRegistration(
  context: AgentWalletRegistrationContext,
  passphrase: string,
  expected: PendingAgentWalletRegistration,
  pendingPath: string = MCP_PENDING_AGENT_WALLET_PATH,
): PendingAgentWalletRegistration {
  validateContext(context);
  const reloaded = readPending(context, passphrase, pendingPath);
  if (!isDeepStrictEqual(reloaded, expected)) {
    throw new Error('Pending MCP wallet identity changed after the relay challenge');
  }
  return { ...reloaded };
}

export function completePendingAgentWalletRegistration(
  registrationId: string,
  wallet: { wallet_id: string; address: string },
  options: CompleteAgentWalletRegistrationOptions,
): string {
  validateContext(options.context);
  const pendingPath = options.pendingPath ?? MCP_PENDING_AGENT_WALLET_PATH;
  const finalPath = options.finalPath ?? MCP_AGENT_WALLET_IDENTITY_PATH;
  if (!/^wallet_aw_[A-Za-z0-9_-]+$/.test(wallet.wallet_id)
    || !/^0x[0-9a-fA-F]{40}$/.test(wallet.address)) {
    throw new Error('Completed MCP wallet response has a malformed wallet identity');
  }
  const decoded = decodedPending(
    readPrivateJson(pendingPath, 'Pending MCP wallet identity'),
    options.context,
    options.passphrase,
  );
  const pending = decoded.file;
  if (pending.registration_id !== registrationId
    || pending.address.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error('Pending MCP wallet identity changed before completion');
  }
  const final: FinalAgentWalletFile = {
    schema_version: 'provian-mcp-agent-wallet/v1',
    wallet_id: wallet.wallet_id,
    pending_identity: pending,
  };
  if (hasPathEntry(finalPath)) {
    const existing = parseFinalFile(
      readPrivateJson(finalPath, 'Completed MCP wallet identity'),
    );
    decodedPending(existing.pending_identity, options.context, options.passphrase);
    if (!isDeepStrictEqual(existing, final)) {
      throw new Error('A different final MCP wallet identity already exists');
    }
  } else {
    atomicCreate(finalPath, final);
  }
  options.afterDurableStage?.('final_identity_durable');
  unlinkDurably(pendingPath);
  options.afterDurableStage?.('pending_identity_removed');
  return finalPath;
}

export function loadCompletedAgentWalletIdentity(
  passphrase: string,
  finalPath: string = MCP_AGENT_WALLET_IDENTITY_PATH,
  expectedContext?: AgentWalletRegistrationContext,
): (PendingAgentWalletRegistration & { walletId: string }) | null {
  if (expectedContext) validateContext(expectedContext);
  if (!hasPathEntry(finalPath)) return null;
  const final = parseFinalFile(
    readPrivateJson(finalPath, 'Completed MCP wallet identity'),
  );
  const decoded = decodedPending(final.pending_identity, expectedContext, passphrase);
  const pending = decoded.file;
  return {
    walletId: final.wallet_id,
    ...decoded.registration,
  };
}

/** Remove a retained pending file only after the final encrypted identity and
 * separate exact same-wallet credentials have both been verified by the
 * caller. This is the restart path for a crash after final-identity fsync. */
export function clearCompletedAgentWalletPending(
  passphrase: string,
  expectedContext: AgentWalletRegistrationContext,
  pendingPath: string = MCP_PENDING_AGENT_WALLET_PATH,
  finalPath: string = MCP_AGENT_WALLET_IDENTITY_PATH,
): void {
  validateContext(expectedContext);
  if (!hasPathEntry(pendingPath)) return;
  const pending = decodedPending(
    readPrivateJson(pendingPath, 'Pending MCP wallet identity'),
    expectedContext,
    passphrase,
  ).file;
  const final = parseFinalFile(
    readPrivateJson(finalPath, 'Completed MCP wallet identity'),
  );
  decodedPending(final.pending_identity, expectedContext, passphrase);
  if (!isDeepStrictEqual(final.pending_identity, pending)) {
    throw new Error('Pending MCP wallet identity conflicts with the completed identity');
  }
  unlinkDurably(pendingPath);
}
