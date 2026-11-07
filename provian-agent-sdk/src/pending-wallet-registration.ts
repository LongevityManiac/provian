import { guardedFetch as fetch, guardedFetcher } from './guarded-fetch';
import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import { homedir } from 'os';
import * as path from 'path';

import {
  decryptKeystore,
  encryptKeystore,
  type AgentKeystore,
  type EncryptKeystoreParams,
} from './keystore';
import {
  deriveAgentIdentityFromPrivateKey,
  prepareAgentWalletRegistration,
  signMessage,
} from './wallet';
import { ConnectionError, ProvianError } from './errors';
import { isValidConnectionTokenFormat } from './connection-token-format';
import { fetchParentAuthorization, type ParentProofOfAuthorization } from './parent-pop';
import { sealAndEscrow } from './recovery-escrow-seal';
import type {
  AgentWalletConfig,
  AgentWalletRegistrationHandle,
  AgentWalletResult,
  PreparedAgentWalletRegistration,
} from './types';

/**
 * Canonical agent wallet id shape, mirroring the relay's own gate on
 * `parent_wallet_id` (routes/agent-wallet.ts). A malformed parent id fails
 * locally instead of costing a round trip and a 400.
 */
const PARENT_WALLET_ID_PATTERN = /^wallet_aw_[A-Za-z0-9-]{8,128}$/;

export const DEFAULT_PENDING_AGENT_WALLET_REGISTRATION_PATH = path.join(
  homedir(),
  '.provian',
  'pending-agent-wallet-registration.json',
);

interface PendingAgentWalletRegistrationFile {
  schema_version: 'pending-agent-wallet-registration/v1';
  context_sha256: string;
  prepared: Omit<PreparedAgentWalletRegistration, 'privateKey'>;
  encrypted_key: AgentKeystore;
}

interface AuthenticatedPendingSnapshot {
  prepared: PreparedAgentWalletRegistration;
  fileSha256: string;
  priorRequestContext?: Readonly<Record<string, string>>;
}

interface DurableRegistrationAdapter {
  loadAuthenticated(): AuthenticatedPendingSnapshot;
  clearExact(registrationId: string, fileSha256: string): void;
}

interface RegistrationHandleState {
  adapter: DurableRegistrationAdapter;
  registrationId: string;
  fileSha256: string;
}

// Runtime identity is load-bearing in addition to the compile-time opaque
// brand. A fabricated object or copied fields cannot enter the networking path.
const registrationHandles = new WeakMap<object, RegistrationHandleState>();

const GOVERNANCE_KEYS = Object.freeze([
  'pe_coverage_enabled',
  'attestation_enabled',
  'human_oversight_enabled',
  'spending_limits_enabled',
] as const);

function canonicalGovernance(
  governance: AgentWalletConfig['governance'] | undefined,
): AgentWalletConfig['governance'] | undefined {
  if (governance === undefined) return undefined;
  const canonical: NonNullable<AgentWalletConfig['governance']> = {};
  for (const key of GOVERNANCE_KEYS) {
    if (governance[key] !== undefined) canonical[key] = governance[key];
  }
  return canonical;
}

function validateRegistrationConfig(config: AgentWalletConfig): void {
  const governance = config.governance as unknown;
  const acceptedAt = typeof config.constitutionAcceptedAt !== 'string'
    ? null
    : Date.parse(config.constitutionAcceptedAt);
  if (typeof config.relayUrl !== 'string' || !/^https?:\/\//.test(config.relayUrl)
    || typeof config.agentId !== 'string'
    || !/^[a-zA-Z0-9._-]+$/.test(config.agentId)
    || config.agentId.length > 200
    || (config.agentName !== undefined
      && (typeof config.agentName !== 'string'
        || config.agentName.length === 0
        || config.agentName.length > 100))
    || (config.platform !== undefined
      && (typeof config.platform !== 'string'
        || config.platform.length === 0
        || config.platform.length > 50))
    || (config.constitutionAccepted !== undefined
      && typeof config.constitutionAccepted !== 'boolean')
    || (config.constitutionVersion !== undefined
      && (typeof config.constitutionVersion !== 'string'
        || config.constitutionVersion.length === 0
        || config.constitutionVersion.length > 100))
    || (config.constitutionAcceptedAt !== undefined
      && typeof config.constitutionAcceptedAt !== 'string')
    || (acceptedAt !== null
      && (!Number.isFinite(acceptedAt)
        || acceptedAt < 0
        || acceptedAt > Date.now() + 5 * 60 * 1000))
    || (config.parentWalletId !== undefined
      && (typeof config.parentWalletId !== 'string'
        || !PARENT_WALLET_ID_PATTERN.test(config.parentWalletId)))
    || (governance !== undefined
      && (typeof governance !== 'object'
          || governance === null
          || Array.isArray(governance)
          || Object.keys(governance).some((key) =>
            !GOVERNANCE_KEYS.includes(key as typeof GOVERNANCE_KEYS[number]))
          || Object.values(governance).some((value) => typeof value !== 'boolean')))) {
    throw new ProvianError(
      'Agent wallet registration config is malformed or cannot be recovered exactly',
      'INVALID_WALLET_REGISTRATION_CONFIG',
    );
  }
}

function canonicalConfig(config: AgentWalletConfig): AgentWalletConfig {
  const governance = canonicalGovernance(config.governance);
  const canonical: AgentWalletConfig = {
    relayUrl: config.relayUrl.replace(/\/$/, ''),
    agentId: config.agentId,
    ...(config.agentName !== undefined ? { agentName: config.agentName } : {}),
    ...(config.platform !== undefined ? { platform: config.platform } : {}),
    constitutionAccepted: config.constitutionAccepted === true,
    ...(config.constitutionVersion !== undefined
      ? { constitutionVersion: config.constitutionVersion }
      : {}),
    ...(config.constitutionAcceptedAt !== undefined
      ? { constitutionAcceptedAt: config.constitutionAcceptedAt }
      : {}),
    ...(config.connectionToken !== undefined ? { connectionToken: config.connectionToken } : {}),
    ...(config.parentWalletId !== undefined ? { parentWalletId: config.parentWalletId } : {}),
    ...(governance !== undefined ? { governance } : {}),
  };
  if (canonical.governance) Object.freeze(canonical.governance);
  return Object.freeze(canonical);
}

// Exported for the installed-base compatibility suite (`installed-base-compat.test.ts`):
// this is the SDK's durable-identity fingerprint. Every fielded snapshot's
// keystore walletId binding was computed from it, so a dropped/added/reordered
// key (e.g. removing the `agent_session_id: null`) would make every
// installed agent unable to resume its own registration. The compat suite pins a
// golden config→contextHash so any such change goes RED before it ships.
export function normalizedContext(config: AgentWalletConfig): Record<string, unknown> {
  return {
    relay_url: config.relayUrl.replace(/\/$/, ''),
    agent_id: config.agentId,
    agent_name: config.agentName || config.agentId,
    platform: config.platform || 'sdk',
    constitution_accepted: config.constitutionAccepted === true,
    constitution_version: config.constitutionVersion ?? null,
    constitution_accepted_at: config.constitutionAcceptedAt ?? null,
    // the relay-session binding is retired; the key stays null so the
    // context hash of every pre-existing sessionless snapshot is unchanged.
    agent_session_id: null,
    ...(config.parentWalletId ? { parent_wallet_id: config.parentWalletId } : {}),
    governance: canonicalGovernance(config.governance) ?? null,
  };
}

export function contextHash(config: AgentWalletConfig): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizedContext(config)), 'utf8')
    .digest('hex');
}

function preparedSnapshot(
  prepared: Omit<PreparedAgentWalletRegistration, 'privateKey'>,
): Record<string, unknown> {
  return {
    schema_version: prepared.schemaVersion,
    registration_id: prepared.registrationId,
    relay_url: prepared.relayUrl,
    agent_id: prepared.agentId,
    agent_name: prepared.agentName,
    platform: prepared.platform,
    constitution_accepted: prepared.constitutionAccepted,
    constitution_version: prepared.constitutionVersion,
    constitution_accepted_at: prepared.constitutionAcceptedAt,
    agent_session_id: prepared.agentSessionId ?? null,
    // CONDITIONAL, matching normalizedContext: present only for a child. Feeds
    // preparedSnapshotHash → the encrypted keystore's walletId binding, so
    // post-hoc tampering of a child's parent_wallet_id breaks the walletId
    // cross-check in readPending and is rejected before any networking. A
    // parentless snapshot omits it and hashes exactly as before.
    ...(prepared.parentWalletId ? { parent_wallet_id: prepared.parentWalletId } : {}),
    governance: canonicalGovernance(prepared.governance) ?? null,
    public_key: prepared.publicKey,
    address: prepared.address,
    chain_addresses: prepared.chainAddresses,
    created_at: prepared.createdAt,
  };
}

function preparedSnapshotHash(
  prepared: Omit<PreparedAgentWalletRegistration, 'privateKey'>,
): string {
  return createHash('sha256')
    .update(JSON.stringify(preparedSnapshot(prepared)), 'utf8')
    .digest('hex');
}

function hasExactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const expected = [
    ...required,
    ...optional.filter((key) => Object.prototype.hasOwnProperty.call(record, key)),
  ].sort();
  return JSON.stringify(Object.keys(record).sort()) === JSON.stringify(expected);
}

function assertExactKeystore(value: unknown): asserts value is AgentKeystore {
  if (!hasExactKeys(value, [
    'version', 'type', 'wallet_id', 'address', 'public_key', 'created_at', 'crypto',
  ])) {
    throw new Error('Pending agent wallet encrypted key schema is invalid');
  }
  const crypto = value.crypto;
  if (!hasExactKeys(crypto, ['cipher', 'ciphertext', 'iv', 'tag', 'kdfparams'])
    || !hasExactKeys(crypto.kdfparams, ['kdf', 'N', 'r', 'p', 'dklen', 'salt'])) {
    throw new Error('Pending agent wallet encrypted key schema is invalid');
  }
}

const PREPARED_REQUIRED_KEYS = [
    'schemaVersion',
    'registrationId',
    'relayUrl',
    'agentId',
    'agentName',
    'platform',
    'constitutionAccepted',
    'constitutionVersion',
    'constitutionAcceptedAt',
    'publicKey',
    'address',
    'chainAddresses',
    'createdAt',
  ] as const;
const PREPARED_OPTIONAL_KEYS = ['agentSessionId', 'governance', 'connectionToken', 'parentWalletId'] as const;

function assertExactPrepared(
  value: unknown,
): asserts value is Omit<PreparedAgentWalletRegistration, 'privateKey'> {
  if (!hasExactKeys(value, PREPARED_REQUIRED_KEYS, PREPARED_OPTIONAL_KEYS)) {
    throw new Error('Pending agent wallet prepared snapshot schema is invalid');
  }
  // `solana` is OPTIONAL: snapshots written before Solana support carry only
  // `evm`; newer ones carry the same-seed Solana address too.
  if (!hasExactKeys(value.chainAddresses, ['evm'], ['solana'])) {
    throw new Error('Pending agent wallet chain-address schema is invalid');
  }
  if (value.governance !== undefined) {
    if (!hasExactKeys(value.governance, [], [
      'pe_coverage_enabled',
      'attestation_enabled',
      'human_oversight_enabled',
      'spending_limits_enabled',
    ]) || Object.values(value.governance).some((entry) => typeof entry !== 'boolean')) {
      throw new Error('Pending agent wallet governance schema is invalid');
    }
  }
  if (value.schemaVersion !== 'prepared-agent-wallet-registration/v1'
    || typeof value.registrationId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{15,127}$/.test(value.registrationId)
    || typeof value.agentId !== 'string'
    || !/^[a-zA-Z0-9._-]{1,200}$/.test(value.agentId)
    || typeof value.relayUrl !== 'string'
    || !/^https?:\/\//.test(value.relayUrl)
    || typeof value.agentName !== 'string'
    || value.agentName.length === 0
    || value.agentName.length > 100
    || typeof value.platform !== 'string'
    || value.platform.length === 0
    || value.platform.length > 50
    || typeof value.constitutionAccepted !== 'boolean'
    || typeof value.constitutionVersion !== 'string'
    || value.constitutionVersion.length === 0
    || value.constitutionVersion.length > 100
    || typeof value.constitutionAcceptedAt !== 'string'
    || !Number.isFinite(Date.parse(value.constitutionAcceptedAt))
    || Date.parse(value.constitutionAcceptedAt) < 0
    || Date.parse(value.constitutionAcceptedAt) > Date.now() + 5 * 60 * 1000
    || typeof value.createdAt !== 'string'
    || !Number.isFinite(Date.parse(value.createdAt))
    || Date.parse(value.createdAt) < 0
    || Date.parse(value.createdAt) > Date.now() + 5 * 60 * 1000
    || (value.agentSessionId !== undefined
      && (typeof value.agentSessionId !== 'string'
        || !/^[A-Za-z0-9._:-]{1,256}$/.test(value.agentSessionId)))
    // 14-vs-16: a real connection code is a 14-char `PROV-XXXX-XXXX`. The old
    // `/^[A-Za-z0-9_-]{16,256}$/` guard's 16-char minimum rejected every real code
    // at resume ("prepared snapshot values are invalid"). Delegate to the canonical
    // shape, the same fix the relay resolvers already carry.
    || (value.connectionToken !== undefined
      && !isValidConnectionTokenFormat(value.connectionToken))
    // A child snapshot's parent id is reread from disk and goes straight into
    // the create request, so validate its shape here — the same canonical agent
    // wallet id the relay's own gate enforces.
    || (value.parentWalletId !== undefined
      && (typeof value.parentWalletId !== 'string'
        || !PARENT_WALLET_ID_PATTERN.test(value.parentWalletId)))
    || typeof value.publicKey !== 'string'
    || !/^[0-9a-f]{128}$/.test(value.publicKey)
    || typeof value.address !== 'string'
    || !/^0x[0-9a-fA-F]{40}$/.test(value.address)
    || typeof value.chainAddresses.evm !== 'string'
    || value.chainAddresses.evm.toLowerCase() !== value.address.toLowerCase()) {
    throw new Error('Pending agent wallet prepared snapshot values are invalid');
  }
}

function readPrivateFile(filePath: string): string {
  const noFollow = process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW;
  let fd: number;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  } catch {
    throw new Error(`Pending wallet registration at ${filePath} must be a private regular file`);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
      throw new Error(`Pending wallet registration at ${filePath} must be a 0600 regular file`);
    }
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function readPending(
  config: AgentWalletConfig,
  passphrase: string,
  filePath: string,
): AuthenticatedPendingSnapshot {
  const raw = readPrivateFile(filePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Pending agent wallet registration is malformed; refusing to replace it');
  }
  if (!hasExactKeys(parsed, ['schema_version', 'context_sha256', 'prepared', 'encrypted_key'])
    || parsed.schema_version !== 'pending-agent-wallet-registration/v1'
    || parsed.context_sha256 !== contextHash(config)) {
    throw new Error(
      'Pending agent wallet registration does not match this agent/config; refusing to create a second identity',
    );
  }
  if (!parsed.prepared || typeof parsed.prepared !== 'object' || Array.isArray(parsed.prepared)) throw new Error('Invalid pending prepared record');
  const known = new Set<string>([...PREPARED_REQUIRED_KEYS, ...PREPARED_OPTIONAL_KEYS]);
  const currentFields: Record<string, unknown> = {};
  const priorRequestContext: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.prepared)) {
    if (known.has(key)) currentFields[key] = value;
    else {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || /key|secret|token|password|mnemonic|credential/.test(key)
        || ['__proto__','constructor','prototype'].includes(key) || typeof value !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/.test(value)) throw new Error('Invalid historical pending request context');
      priorRequestContext[key] = value;
    }
  }
  assertExactPrepared(currentFields);
  assertExactKeystore(parsed.encrypted_key);
  const prepared = currentFields;
  const expectedPrepared = {
    ...preparedSnapshot(prepared),
    relay_url: config.relayUrl.replace(/\/$/, ''),
    agent_id: config.agentId,
    agent_name: config.agentName || config.agentId,
    platform: config.platform || 'sdk',
    constitution_accepted: config.constitutionAccepted === true,
    // A config that names a version is bound by context_sha256. A config that
    // names none got the SDK default of the release that prepared it, so the
    // sealed value replays as-is: a registration prepared before the Network
    // Constitution relabel keeps its retry identity. Tampering with the sealed
    // value still fails the encrypted key's snapshot-hash binding below.
    constitution_version: config.constitutionVersion || prepared.constitutionVersion,
    constitution_accepted_at: config.constitutionAcceptedAt || prepared.createdAt,
    // the relay-session binding is retired; the key stays null so the
    // context hash of every pre-existing sessionless snapshot is unchanged.
    agent_session_id: null,
    governance: config.governance ?? null,
  };
  const decrypted = decryptKeystore(parsed.encrypted_key, passphrase);
  const derived = deriveAgentIdentityFromPrivateKey(decrypted.privateKey);
  if (JSON.stringify(preparedSnapshot(prepared)) !== JSON.stringify(expectedPrepared)
    || decrypted.walletId !== `pending:${prepared.registrationId}:${preparedSnapshotHash(prepared)}`
    || decrypted.address.toLowerCase() !== prepared.address.toLowerCase()
    || decrypted.publicKey.toLowerCase() !== prepared.publicKey.toLowerCase()
    || derived.address.toLowerCase() !== prepared.address.toLowerCase()
    || derived.publicKey.toLowerCase() !== prepared.publicKey.toLowerCase()) {
    throw new Error('Pending agent wallet registration key binding is invalid');
  }
  return {
    prepared: { ...prepared, privateKey: decrypted.privateKey },
    fileSha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
    ...(Object.keys(priorRequestContext).length === 0 ? {} : {priorRequestContext}),
  };
}

function persistPending(
  config: AgentWalletConfig,
  prepared: PreparedAgentWalletRegistration,
  passphrase: string,
  filePath: string,
  kdfParams?: EncryptKeystoreParams['kdfParams'],
): void {
  const { privateKey: _privateKey, ...publicPrepared } = prepared;
  const payload: PendingAgentWalletRegistrationFile = {
    schema_version: 'pending-agent-wallet-registration/v1',
    context_sha256: contextHash(config),
    prepared: publicPrepared,
    encrypted_key: encryptKeystore({
      privateKey: prepared.privateKey,
      address: prepared.address,
      publicKey: prepared.publicKey,
      walletId: `pending:${prepared.registrationId}:${preparedSnapshotHash(publicPrepared)}`,
      passphrase,
      createdAt: prepared.createdAt,
      kdfParams,
    }),
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = fs.openSync(tempPath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(tempPath, filePath);
    const directoryFd = fs.openSync(path.dirname(filePath), 'r');
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error('pending_agent_wallet_registration_already_exists');
  } finally {
    try { fs.unlinkSync(tempPath); } catch { /* linked or already removed */ }
  }
}

class FileDurableRegistrationAdapter implements DurableRegistrationAdapter {
  constructor(
    private readonly config: AgentWalletConfig,
    private readonly passphrase: string,
    private readonly filePath: string,
  ) {}

  loadAuthenticated(): AuthenticatedPendingSnapshot {
    return readPending(this.config, this.passphrase, this.filePath);
  }

  clearExact(registrationId: string, fileSha256: string): void {
    const current = this.loadAuthenticated();
    if (current.prepared.registrationId !== registrationId
      || current.fileSha256 !== fileSha256) {
      throw new Error('Pending agent wallet registration changed before acknowledgement');
    }
    fs.unlinkSync(this.filePath);
    const directoryFd = fs.openSync(path.dirname(this.filePath), 'r');
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  }
}

function issueHandle(
  adapter: DurableRegistrationAdapter,
  snapshot: AuthenticatedPendingSnapshot,
): AgentWalletRegistrationHandle {
  const handle = Object.freeze(Object.create(null)) as AgentWalletRegistrationHandle;
  registrationHandles.set(handle, {
    adapter,
    registrationId: snapshot.prepared.registrationId,
    fileSha256: snapshot.fileSha256,
  });
  return handle;
}

function loadHandleSnapshot(handle: AgentWalletRegistrationHandle): {
  state: RegistrationHandleState;
  snapshot: AuthenticatedPendingSnapshot;
} {
  const state = typeof handle === 'object' && handle !== null
    ? registrationHandles.get(handle as object)
    : undefined;
  if (!state) {
    throw new ProvianError(
      'An authenticated durable registration handle is required before networking',
      'DURABLE_REGISTRATION_HANDLE_REQUIRED',
    );
  }
  const snapshot = state.adapter.loadAuthenticated();
  if (snapshot.prepared.registrationId !== state.registrationId
    || snapshot.fileSha256 !== state.fileSha256) {
    throw new ProvianError(
      'The durable pending registration changed after its handle was issued',
      'DURABLE_REGISTRATION_CHANGED',
    );
  }
  return { state, snapshot };
}

/**
 * Load the one encrypted pending identity, or create and durably persist it
 * before returning an opaque immutable handle. The raw snapshot and key are
 * never returned to the caller. Concurrent callers converge on the same file.
 */
export async function loadOrCreatePendingAgentWalletRegistration(
  inputConfig: AgentWalletConfig,
  passphrase: string,
  filePath: string = DEFAULT_PENDING_AGENT_WALLET_REGISTRATION_PATH,
  kdfParams?: EncryptKeystoreParams['kdfParams'],
): Promise<AgentWalletRegistrationHandle> {
  validateRegistrationConfig(inputConfig);
  const config = canonicalConfig(inputConfig);
  const adapter = new FileDurableRegistrationAdapter(config, passphrase, filePath);
  if (fs.existsSync(filePath)) return issueHandle(adapter, adapter.loadAuthenticated());
  try {
    await prepareAgentWalletRegistration(config, (prepared) => {
      persistPending(config, prepared, passphrase, filePath, kdfParams);
    });
  } catch (error) {
    if ((error as Error).message !== 'pending_agent_wallet_registration_already_exists') {
      throw error;
    }
  }
  return issueHandle(adapter, adapter.loadAuthenticated());
}

/**
 * Supplies the parent's authorization for a parent-spawned child registration.
 * The relay binds the parent-challenge to the parent's REGISTERED public key, so
 * the parent authorizes by signing with its own private key — the same key the
 * parent proved at its own creation. The key is read only to sign the
 * parent-challenge in-process; it is never persisted, logged, or returned.
 */
export interface ParentAuthorizationProvider {
  /** The parent agent's hex-encoded secp256k1 private key (64 hex chars),
   *  matching the public key registered to `config.parentWalletId`. */
  parentPrivateKey: string;
}

/** Options for {@link resumeAgentWalletRegistration}. */
export interface ResumeAgentWalletRegistrationOptions {
  /** Entry point that initiates registration. The programmatic SDK uses npm_sdk. */
  registrationChannel?: 'install_line' | 'npm_sdk' | 'cli';
  /**
   * REQUIRED when the durable snapshot carries a `parentWalletId` (a
   * parent-spawned child); FORBIDDEN otherwise. Resume fails closed on either
   * half of the mismatch: a child registration without parentAuthorization
   * throws `PARENT_AUTHORIZATION_REQUIRED` (never sends a parentless create for
   * a child), and parentAuthorization supplied for a parentless registration
   * throws `PARENT_AUTHORIZATION_WITHOUT_PARENT`.
   */
  parentAuthorization?: ParentAuthorizationProvider;
}

/**
 * Resume only through an SDK-issued opaque handle. The adapter rereads and
 * authenticates the exact durable bytes before the challenge and again before
 * the create request; no caller-owned mutable object supplies network fields.
 *
 * When the durable snapshot is a parent-spawned child (its `parentWalletId` was
 * sealed at prepare time), pass `options.parentAuthorization` with the parent's
 * key: resume then fetches `/parent-challenge`, signs it with the parent key,
 * and includes `parent_wallet_id` + `parent_proof_of_authorization` on create.
 * The relay verifies the parent PoP, inherits the parent's beneficiary snapshot
 * onto the child, and enforces the 128-child cap. The child is an agent with
 * its own wallet and key, so it draws its own Genesis grant within the window
 * and the per-wallet ceiling, like any other agent (/10-01,
 * superseding).
 */
export async function resumeAgentWalletRegistration(
  handle: AgentWalletRegistrationHandle,
  options?: ResumeAgentWalletRegistrationOptions,
): Promise<AgentWalletResult> {
  let loaded = loadHandleSnapshot(handle);
  let prepared = loaded.snapshot.prepared;

  // Fail closed on the parent/authorization mismatch BEFORE any networking, so a
  // misconfigured child (or parent signer supplied for a parentless wallet) is
  // rejected with zero relay calls. parentWalletId is sealed and cannot change
  // across the two authenticated reads below (loadHandleSnapshot would throw
  // DURABLE_REGISTRATION_CHANGED), so this presence check is authoritative here.
  if (prepared.parentWalletId && !options?.parentAuthorization) {
    throw new ProvianError(
      'This registration is a parent-spawned child (parent_wallet_id was sealed at prepare time); resume requires options.parentAuthorization carrying the parent key',
      'PARENT_AUTHORIZATION_REQUIRED',
    );
  }
  if (!prepared.parentWalletId && options?.parentAuthorization) {
    throw new ProvianError(
      'options.parentAuthorization was supplied but this registration has no parent_wallet_id; prepare the child with config.parentWalletId set',
      'PARENT_AUTHORIZATION_WITHOUT_PARENT',
    );
  }

  const challengeUrl = `${prepared.relayUrl}/v1/agent/wallet/challenge`
    + `?public_key=${encodeURIComponent(prepared.publicKey)}`
    + `&registration_id=${encodeURIComponent(prepared.registrationId)}`
    + `&agent_id=${encodeURIComponent(prepared.agentId)}`;
  let challengeResponse: Response;
  try {
    challengeResponse = await fetch(challengeUrl, { method: 'GET' });
  } catch (error) {
    throw new ConnectionError(`Failed to reach relay: ${(error as Error).message}`, { cause: error });
  }
  if (!challengeResponse.ok) {
    const errorBody = await challengeResponse.text();
    let parsed: { error?: string } | null;
    try { parsed = JSON.parse(errorBody) as { error?: string }; } catch { parsed = null; }
    throw new ProvianError(
      parsed?.error || `HTTP ${challengeResponse.status}: ${challengeResponse.statusText}`,
      `HTTP_${challengeResponse.status}`,
    );
  }
  const challengePayload = await challengeResponse.json() as {
    challenge_id?: unknown;
    challenge?: unknown;
    registration_exists?: unknown;
  };
  if (typeof challengePayload.challenge_id !== 'string'
    || challengePayload.challenge_id.length === 0
    || typeof challengePayload.challenge !== 'string'
    || challengePayload.challenge.length === 0) {
    throw new ProvianError('Relay returned a malformed wallet challenge', 'MALFORMED_WALLET_CHALLENGE');
  }

  // Close a challenge/create mutation window: the POST is built only from a
  // second authenticated read of the same exact durable bytes.
  loaded = loadHandleSnapshot(handle);
  prepared = loaded.snapshot.prepared;
  const signature = signMessage(prepared.privateKey, challengePayload.challenge);

  // --- Parent authorization (HIGH-2 Wave 4 /) ---
  // For a child snapshot, obtain the parent proof-of-authorization now. The PoP
  // is ephemeral (bound to {parent_wallet_id, child_address} with a short TTL)
  // and is NOT part of the durable snapshot or the relay fingerprint, so it is
  // fetched + signed fresh from the SECOND authenticated read on every resume
  // attempt. The presence of options.parentAuthorization is already guaranteed
  // for a child by the fail-closed check at the top of this function.
  let parentProof: ParentProofOfAuthorization | undefined;
  if (prepared.parentWalletId && options?.parentAuthorization) {
    try {
      parentProof = await fetchParentAuthorization({
        relayUrl: prepared.relayUrl,
        parentWalletId: prepared.parentWalletId,
        childAddress: prepared.address,
        parentPrivateKey: options.parentAuthorization.parentPrivateKey,
      });
    } catch (error) {
      // Surfaces the relay's own parent-challenge error (e.g. 404
      // parent_wallet_id not found, 400 not active, 503 cache) or a network
      // failure, without fabricating a create attempt.
      throw new ProvianError(
        `Failed to obtain parent authorization: ${(error as Error).message}`,
        'PARENT_CHALLENGE_FAILED',
      );
    }
  }

  if (loaded.snapshot.priorRequestContext && challengePayload.registration_exists === undefined) {
    throw new ProvianError('The relay could not confirm this pending registration; its key is preserved.', 'REGISTRATION_STATE_UNKNOWN');
  }
  const createUrl = `${prepared.relayUrl}/v1/agent/wallet/create`;
  let response: Response;
  try {
    response = await fetch(createUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(loaded.snapshot.priorRequestContext && challengePayload.registration_exists === true
          ? {prior_request_context: loaded.snapshot.priorRequestContext} : {}),
        registration_id: prepared.registrationId,
        registration_channel: options?.registrationChannel ?? 'npm_sdk',
        agent_name: prepared.agentName,
        agent_id: prepared.agentId,
        platform: prepared.platform,
        constitution_accepted: prepared.constitutionAccepted,
        constitution_version: prepared.constitutionVersion,
        constitution_accepted_at: prepared.constitutionAcceptedAt,
        governance: prepared.governance,
        public_key: prepared.publicKey,
        challenge_id: challengePayload.challenge_id,
        signature,
        // the agent's self-sovereign per-chain addresses (Solana derived
        // from its own key, which the relay never holds). The relay pins the EVM
        // leg to the PoP-verified address and stores the Solana address
        // display-only so the app can show + fund it. Does not affect the PoP
        // signature (which is over the challenge, not the body).
        ...(prepared.chainAddresses ? { chain_addresses: prepared.chainAddresses } : {}),
        ...(prepared.agentSessionId ? { agent_session_id: prepared.agentSessionId } : {}),
        ...(prepared.connectionToken ? { connection_token: prepared.connectionToken } : {}),
        // Parent-spawned child: parent_wallet_id + the parent PoP go together or
        // not at all (the relay links the child to its parent from them). Both are
        // absent for an ordinary parentless wallet. `parentProof` is guaranteed
        // present whenever prepared.parentWalletId is set (the fail-closed block
        // above), so this never sends a bare parent_wallet_id without its PoP.
        ...(prepared.parentWalletId && parentProof
          ? {
            parent_wallet_id: prepared.parentWalletId,
            parent_proof_of_authorization: parentProof,
          }
          : {}),
      }),
    });
  } catch (error) {
    throw new ConnectionError(`Failed to reach relay: ${(error as Error).message}`, { cause: error });
  }
  if (!response.ok) {
    const errorBody = await response.text();
    let parsed: { error?: string } | null;
    try { parsed = JSON.parse(errorBody) as { error?: string }; } catch { parsed = null; }
    throw new ProvianError(
      parsed?.error || `HTTP ${response.status}: ${response.statusText}`,
      `HTTP_${response.status}`,
    );
  }

  const result = await response.json() as {
    wallet_id?: unknown;
    address?: unknown;
    public_key?: unknown;
    api_key?: unknown;
    api_secret?: unknown;
    pe_chain_root?: unknown;
    badges?: unknown;
    welcome?: unknown;
    recovery_anchor_pubkey?: unknown;
  };
  if (typeof result.wallet_id !== 'string'
    || !/^wallet_aw_[A-Za-z0-9_-]+$/.test(result.wallet_id)
    || typeof result.address !== 'string'
    || !/^0x[0-9a-fA-F]{40}$/.test(result.address)
    || typeof result.public_key !== 'string'
    || !/^[0-9a-f]{128}$/.test(result.public_key)
    || typeof result.api_key !== 'string'
    || !/^pvn_live_[0-9a-f]{32}$/.test(result.api_key)
    || typeof result.api_secret !== 'string'
    || !/^pvns_[0-9a-f]{64}$/.test(result.api_secret)
    || typeof result.pe_chain_root !== 'string'
    || result.pe_chain_root.length === 0
    || !Array.isArray(result.badges)
    || (result.recovery_anchor_pubkey !== undefined
      && (typeof result.recovery_anchor_pubkey !== 'string'
        || !/^[A-Za-z0-9_-]{43}$/.test(result.recovery_anchor_pubkey)))) {
    throw new ProvianError(
      'Relay returned a malformed wallet identity or credential response; pending registration must be retained',
      'MALFORMED_WALLET_RESPONSE',
    );
  }
  if (result.address.toLowerCase() !== prepared.address.toLowerCase()) {
    throw new ProvianError(
      `Relay-derived address ${result.address} does not match locally-derived address ${prepared.address}`,
      'ADDRESS_MISMATCH',
    );
  }
  if (result.public_key.toLowerCase() !== prepared.publicKey.toLowerCase()) {
    throw new ProvianError(
      'Relay-returned public key does not match the durable wallet key',
      'PUBLIC_KEY_MISMATCH',
    );
  }
  // / OPEN_ITEMS L381: every agent is escrowed for recovery AT BIRTH. When the relay names
  // the key to seal to (the inviting code's anchor, its issuer's published anchor, or — for a
  // parent-spawned child — the inherited human's published anchor), seal THIS key to it on this
  // machine and escrow the ciphertext before returning, on every creation path (the hosted
  // install, `onboard`, `createChildAgentWallet`, a programmatic create).
  //
  // An escrow failure NEVER throws here: the response above just issued an API credential (and on
  // the relay's lost-response replay it has already revoked the previous one), so throwing would
  // drop the only valid credential. Instead the result says `recoveryEscrowed: false` with the
  // reason; every caller persists the credential first and then retries or reports (the bootstrap's
  // own escrow step, the daemon heal), and re-calling resume on the same durable registration
  // escrows again. No anchor = no human at birth: nothing to seal to yet (its daemon escrows once
  // it links). Escrow is only how the linked human can restore the key; it never holds earnings,
  // so the agent mints and can be paid out whether or not it is escrowed.
  let recoveryEscrowed = false;
  let recoveryEscrowError: string | undefined;
  if (typeof result.recovery_anchor_pubkey === 'string') {
    try {
      await sealAndEscrow({
        relayUrl: prepared.relayUrl,
        walletId: result.wallet_id,
        apiKey: result.api_key,
        apiSecret: result.api_secret,
        privateKey: prepared.privateKey,
        anchorPubkeyB64u: result.recovery_anchor_pubkey,
      });
      recoveryEscrowed = true;
    } catch (error) {
      recoveryEscrowError = (error as Error).message || 'recovery escrow failed';
    }
  }
  return {
    recoveryEscrowed,
    ...(recoveryEscrowError !== undefined ? { recoveryEscrowError } : {}),
    address: result.address,
    chainAddresses: prepared.chainAddresses,
    privateKey: prepared.privateKey,
    publicKey: prepared.publicKey,
    walletId: result.wallet_id,
    apiKey: result.api_key,
    apiSecret: result.api_secret,
    createdAt: prepared.createdAt,
    firstEnvelopeId: result.pe_chain_root,
    badges: result.badges as string[],
    welcome: typeof result.welcome === 'object' && result.welcome !== null
      ? result.welcome as Record<string, unknown>
      : {},
    // the phone's recovery anchor now rides the create response (it used
    // to arrive on the retired connect response).
    ...(typeof result.recovery_anchor_pubkey === 'string'
      ? { recoveryAnchorPubkey: result.recovery_anchor_pubkey }
      : {}),
  };
}

/** Internal CLI preflight: prove any already-promoted keystore belongs to the
 * exact pending address/public key before a retry can rotate credentials. */
export function assertPendingAgentWalletRegistrationIdentity(
  handle: AgentWalletRegistrationHandle,
  identity: { address: string; publicKey: string },
): void {
  const { snapshot } = loadHandleSnapshot(handle);
  if (snapshot.prepared.address.toLowerCase() !== identity.address.toLowerCase()
    || snapshot.prepared.publicKey.toLowerCase() !== identity.publicKey.toLowerCase()) {
    throw new ProvianError(
      'Existing final keystore does not match the pending registration identity',
      'PENDING_REGISTRATION_FINAL_IDENTITY_MISMATCH',
    );
  }
}

/**
 * Default durable pending-registration path for a child, namespaced by the
 * CHILD's agent id so a parent spawning many children never collides them on the
 * single default parentless path. The agent id is embedded between a fixed
 * prefix and the `.json` suffix (and is constrained to `[a-zA-Z0-9._-]` by
 * config validation), so no value can traverse out of the `.provian` directory.
 */
function defaultChildPendingRegistrationPath(childAgentId: string): string {
  return path.join(
    homedir(),
    '.provian',
    `pending-child-agent-wallet-${childAgentId}.json`,
  );
}

/**
 * First-class convenience for an authenticated parent agent to create a CHILD
 * agent wallet end to end. It is a thin, crash-safe composition over the durable
 * two-step primitive — it does NOT introduce a second create path:
 *
 * 1. `loadOrCreatePendingAgentWalletRegistration` generates the child keypair
 * and DURABLY persists it (encrypted) before any networking, sealing the
 * parent_wallet_id into the child's registration identity.
 * 2. `resumeAgentWalletRegistration(handle, { parentAuthorization })` fetches
 * the parent-challenge, signs it with the parent's key, and calls
 * `POST /v1/agent/wallet/create` with parent_wallet_id +
 * parent_proof_of_authorization.
 *
 * The relay then verifies the parent PoP, admits the child as a fully-fledged
 * agent identity with its own wallet and PE chain, inherits the parent's
 * beneficiary snapshot onto it, and enforces the 128-child cap. The child draws
 * its own Genesis grant like any agent with its own wallet (/
 * 10-01, superseding). All of that is relay behavior this method only drives.
 *
 * Crash-safety: if the process dies or the create response is lost, re-call with
 * the same `config`/`filePath`; it resumes the SAME durable child identity and
 * the relay (deduping by registration fingerprint) returns that same wallet with
 * newly rotated credentials. The pending file is retained by design; obtain a
 * handle via the two-step path and call `clearPendingAgentWalletRegistration`
 * when you want to remove it explicitly.
 */
export async function createChildAgentWallet(
  config: AgentWalletConfig & { parentWalletId: string },
  parentAuthorization: ParentAuthorizationProvider,
  passphrase: string,
  filePath?: string,
  kdfParams?: EncryptKeystoreParams['kdfParams'],
): Promise<AgentWalletResult> {
  if (typeof config.parentWalletId !== 'string'
    || !PARENT_WALLET_ID_PATTERN.test(config.parentWalletId)) {
    throw new ProvianError(
      'createChildAgentWallet requires config.parentWalletId to be a canonical agent wallet id (wallet_aw_...)',
      'PARENT_WALLET_ID_REQUIRED',
    );
  }
  if (typeof parentAuthorization?.parentPrivateKey !== 'string'
    || parentAuthorization.parentPrivateKey.length === 0) {
    throw new ProvianError(
      'createChildAgentWallet requires parentAuthorization.parentPrivateKey (the parent key registered to parentWalletId)',
      'PARENT_AUTHORIZATION_REQUIRED',
    );
  }
  const resolvedPath = filePath ?? defaultChildPendingRegistrationPath(config.agentId);
  const handle = await loadOrCreatePendingAgentWalletRegistration(
    config,
    passphrase,
    resolvedPath,
    kdfParams,
  );
  return resumeAgentWalletRegistration(handle, { parentAuthorization });
}

/** Delete only the exact authenticated pending bytes represented by a valid
 * handle, then fsync the parent directory before reporting success. */
export function clearPendingAgentWalletRegistration(
  handle: AgentWalletRegistrationHandle,
): void {
  const state = typeof handle === 'object' && handle !== null
    ? registrationHandles.get(handle as object)
    : undefined;
  if (!state) {
    throw new ProvianError(
      'An authenticated durable registration handle is required before deletion',
      'DURABLE_REGISTRATION_HANDLE_REQUIRED',
    );
  }
  state.adapter.clearExact(state.registrationId, state.fileSha256);
  registrationHandles.delete(handle as object);
}

/** The plaintext public half of a pending registration — hints only, never authority. */
export interface PendingRegistrationSummary {
  registrationId: string;
  relayUrl: string;
  agentId: string;
  agentName: string;
  publicKey: string;
  connectionToken?: string;
}

/**
 * Read the public half of a pending registration without the passphrase, or null when there is
 * none (or it is unreadable). Used only to rebuild the config `loadOrCreate…` then authenticates
 * in full (a summary that lies fails that check), and to ask the relay whether it holds the
 * registration. Nothing here can send a request on the snapshot's behalf.
 */
export function peekPendingAgentWalletRegistration(
  filePath: string = DEFAULT_PENDING_AGENT_WALLET_REGISTRATION_PATH,
): PendingRegistrationSummary | null {
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown; } catch { return null; }
  const prepared = (parsed as { prepared?: Record<string, unknown> } | null)?.prepared;
  if (!prepared || typeof prepared !== 'object') return null;
  const str = (k: string) => (typeof prepared[k] === 'string' ? prepared[k] as string : undefined);
  const registrationId = str('registrationId'), relayUrl = str('relayUrl'), agentId = str('agentId');
  const agentName = str('agentName'), publicKey = str('publicKey');
  if (!registrationId || !relayUrl || !agentId || !agentName || !publicKey) return null;
  return {
    registrationId, relayUrl, agentId, agentName, publicKey,
    ...(str('connectionToken') ? { connectionToken: str('connectionToken') } : {}),
  };
}

/**
 * Whether the relay already holds this registration: true (resume it exactly as first sent — its
 * request fingerprint binds), false (it never arrived, so it may be rebound), or null when the
 * relay cannot say (unreachable, rate limited, or a relay that predates the flag). A relay that
 * answers 409 holds a registration under that id, so that is true.
 */
export async function relayHoldsPendingRegistration(
  summary: PendingRegistrationSummary,
  fetchImpl: typeof globalThis.fetch = fetch,
): Promise<boolean | null> {
  const url = `${summary.relayUrl}/v1/agent/wallet/challenge`
    + `?public_key=${encodeURIComponent(summary.publicKey)}`
    + `&registration_id=${encodeURIComponent(summary.registrationId)}`
    + `&agent_id=${encodeURIComponent(summary.agentId)}`;
  try {
    const res = await fetchImpl(url, { method: 'GET' });
    if (res.status === 409) return true;
    if (!res.ok) return null;
    const body = await res.json() as { registration_exists?: unknown };
    return typeof body.registration_exists === 'boolean' ? body.registration_exists : null;
  } catch {
    return null;
  }
}

/**
 * Move an unsent pending registration aside (never delete: its key stays encrypted on disk) so
 * a fresh one can be prepared. Callers do this only after the relay said it does not hold it.
 */
export function setAsidePendingAgentWalletRegistration(
  filePath: string = DEFAULT_PENDING_AGENT_WALLET_REGISTRATION_PATH,
  now: () => number = Date.now,
): string {
  const aside = `${filePath}.unsent-${now()}`;
  fs.renameSync(filePath, aside);
  const directoryFd = fs.openSync(path.dirname(filePath), 'r');
  try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  return aside;
}
