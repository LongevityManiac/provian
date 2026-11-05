/**
 * Crash-resumable voluntary rotation. Before any remote identity cut, one
 * fsynced encrypted journal contains BOTH keys and both credential pairs.
 * The journal and retired keystore are never deleted on a sweep result: one
 * ERC-20 balance says nothing about ETH, other chains, or later deposits.
 */
import { formatUnits } from 'viem';
import { randomBytes, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import type { RotateKeyConfig, RotateKeyResult } from './wallet';
import type { AgentKeystore } from './keystore';
import type { RotateKeyAndSweepOptions, SweepResult } from './sweep';
import { atomicReplacePrivateFile } from './durable-private-file';
import * as keystoreModule from './keystore';
import * as walletModule from './wallet';
import * as sweepModule from './sweep';
import * as credentialModule from './scripts/agent-credentials-file';
import { readLocalKeystoreSecret } from './local-keystore-secret';
import { tryAcquireFileLock } from './meter/file-lock';
import { readRotationJournal, writeRotationJournal } from './rotation-journal';

const PVT_DECIMALS = 18;
export interface RotateKeyFlowInput {
  relayUrl: string;
  walletId?: string;
  rpcUrl?: string;
  token?: RotateKeyAndSweepOptions['token'];
  chain?: RotateKeyAndSweepOptions['chain'];
  /** Explicitly begin another rotation after the preceding one is complete. */
  newRotation?: boolean;
}
export interface RotateKeyFlowResult {
  walletId: string; oldAddress: string; newAddress: string; sweep: SweepResult; resumed: boolean;
}
export interface RotateKeyIdentity {
  walletId: string; apiKey: string; apiSecret: string; oldKeystore: AgentKeystore;
  withOldKey<T>(fn: (oldPrivateKey: string) => Promise<T>): Promise<T>;
}
export interface PendingSweep { walletId: string; oldAddress: string; newAddress: string }
export interface RotationJournal {
  version: 1;
  config: RotateKeyConfig & { durableRotation: NonNullable<RotateKeyConfig['durableRotation']> };
  oldKeystore: AgentKeystore;
  newPublicKey: string;
  oldAddress: string;
  newAddress: string;
  installed: boolean;
  result?: RotateKeyResult;
}
export interface RotateKeyFlowDeps {
  loadIdentity(): RotateKeyIdentity | null;
  acquireLock?(): () => void;
  loadLegacyPending?(): PendingSweep | null;
  completeLegacyPending?(): void;
  generateNewKey(): { privateKey: string; publicKey: string; address: string };
  loadJournal(): RotationJournal | null;
  saveJournal(journal: RotationJournal): void;
  rotate(config: RotateKeyConfig): Promise<RotateKeyResult>;
  persistNewKey(params: { privateKey: string; address: string; publicKey: string; walletId: string; apiKey: string; apiSecret: string }): void;
  rotateCredentials(params: { apiKey: string; apiSecret: string; walletId: string; address: string }): void;
  sweepPending(pending: PendingSweep, options: RotateKeyAndSweepOptions): Promise<SweepResult>;
  log(message: string): void;
}
function formatPvt(atomic: string): string {
  try {
    return formatUnits(BigInt(atomic), PVT_DECIMALS);
  } catch {
    return atomic;
  }
}

/** Plain sentences describing a sweep outcome (never a raw stack/relay code). */
export function describeSweep(sweep: SweepResult): string[] {
  if (sweep.swept) {
    return [`Recovered ${formatPvt(sweep.amountAtomic)} ${sweep.token} from the old address to the new one (tx ${sweep.hash}).`];
  }
  switch (sweep.reason) {
    case 'nothing_to_sweep':
      return [`No ${sweep.token} at the old address to move.`];
    case 'insufficient_gas':
      return [
        `${formatPvt(sweep.strandedAtomic)} ${sweep.token} is still at the old address ${sweep.oldAddress} — it has no ETH to pay gas.`,
        'Send a little Base ETH there and run `rotate-key` again to finish the sweep (this will not rotate the key a second time).',
      ];
    case 'sweep_failed':
      return [
        sweep.strandedAtomic === 'unknown'
          ? `Could not confirm the old address balance; nothing was moved. Run \`rotate-key\` again to retry the sweep.`
          : `Could not move the ${formatPvt(sweep.strandedAtomic)} ${sweep.token} at the old address ${sweep.oldAddress} this time. Run \`rotate-key\` again to retry the sweep.`,
      ];
    default:
      return ['The sweep did not complete. Run `rotate-key` again to retry it.'];
  }
}


export async function runRotateKeyFlow(input: RotateKeyFlowInput, deps: RotateKeyFlowDeps = defaultRotateKeyFlowDeps()): Promise<RotateKeyFlowResult> {
  const release = deps.acquireLock?.();
  try { return await runLocked(input, deps); } finally { release?.(); }
}

async function runLocked(input: RotateKeyFlowInput, deps: RotateKeyFlowDeps): Promise<RotateKeyFlowResult> {
  const options: RotateKeyAndSweepOptions = { token: input.token ?? 'PVT', chain: input.chain ?? 'base', ...(input.rpcUrl ? { rpcUrl: input.rpcUrl } : {}) };
  let journal = deps.loadJournal();
  const legacy = !journal ? deps.loadLegacyPending?.() : null;
  if (legacy) {
    if (input.newRotation) throw new Error('Retry the legacy pending sweep before another rotation.');
    if (input.walletId && input.walletId !== legacy.walletId) throw new Error('PROVIAN_WALLET_ID does not match the pending sweep.');
    const sweep = await deps.sweepPending(legacy, options);
    if (sweep.swept || sweep.reason === 'nothing_to_sweep') deps.completeLegacyPending?.();
    for (const line of describeSweep(sweep)) deps.log(line);
    return { ...legacy, sweep, resumed: true };
  }
  const resumed = journal !== null && !input.newRotation;
  if (journal && input.newRotation && !journal.installed) throw new Error('Finish the pending rotation before starting another.');
  if (!journal || input.newRotation) {
    const identity = deps.loadIdentity();
    if (!identity) throw new Error('No agent wallet and credentials were found on this machine to rotate.');
    if (input.walletId && input.walletId.trim() !== identity.walletId) throw new Error('PROVIAN_WALLET_ID does not match the wallet on this machine.');
    const key = deps.generateNewKey();
    journal = await identity.withOldKey(async (oldPrivateKey) => ({
      version: 1 as const,
      config: { relayUrl: input.relayUrl.replace(/\/+$/, ''), walletId: identity.walletId, oldPrivateKey, newPrivateKey: key.privateKey,
        apiKey: identity.apiKey, apiSecret: identity.apiSecret,
        durableRotation: { rotationId: `rotation_${randomUUID()}`, apiKey: `pvn_live_${randomBytes(16).toString('hex')}`, apiSecret: `pvns_${randomBytes(32).toString('hex')}` } },
      oldKeystore: identity.oldKeystore, newPublicKey: key.publicKey,
      oldAddress: identity.oldKeystore.address, newAddress: key.address, installed: false,
    }));
    // This must finish BEFORE the relay call. A failed fsync means no cut.
    deps.saveJournal(journal);
  }
  if (journal.config.relayUrl !== input.relayUrl.replace(/\/+$/, '')
    || (input.walletId && input.walletId.trim() !== journal.config.walletId)) throw new Error('The pending rotation belongs to a different relay or wallet.');
  if (!journal.result) {
    const result = await deps.rotate(journal.config);
    if (result.walletId !== journal.config.walletId || result.newAddress.toLowerCase() !== journal.newAddress.toLowerCase()
      || result.oldAddress.toLowerCase() !== journal.oldAddress.toLowerCase()
      || result.apiKey !== journal.config.durableRotation.apiKey || result.apiSecret !== journal.config.durableRotation.apiSecret) throw new Error('Rotation reply does not match the durable journal.');
    journal.result = result;
    deps.saveJournal(journal);
  }
  // Repeatable atomic installs. The journal remains authoritative if either
  // write, or its fsync, fails; no need to load a half-installed identity.
  const result = journal.result;
  deps.persistNewKey({ privateKey: journal.config.newPrivateKey, address: journal.newAddress,
    publicKey: journal.newPublicKey, walletId: result.walletId, apiKey: result.apiKey, apiSecret: result.apiSecret });
  deps.rotateCredentials({ apiKey: result.apiKey, apiSecret: result.apiSecret, walletId: result.walletId, address: journal.newAddress });
  journal.installed = true;
  deps.saveJournal(journal);
  const pending = { walletId: result.walletId, oldAddress: journal.oldAddress, newAddress: journal.newAddress };
  // The sweep is optional asset movement, NEVER a condition for key retention.
  const sweep = await deps.sweepPending(pending, options);
  deps.log(`Key rotation complete. Retired keys remain encrypted in ~/.provian/rotations for every asset and future deposits. Run rotate-key again to retry a sweep; use --new-rotation only to start another rotation.`);
  for (const line of describeSweep(sweep)) deps.log(line);
  return { ...pending, sweep, resumed };
}

/** Production paths can be redirected to a fixture home without touching a real identity. */
export function defaultRotateKeyFlowDeps(directory: string = path.join(homedir(), '.provian')): RotateKeyFlowDeps {
  const journalPath = path.join(directory, 'rotation-journal.json');
  const keyPath = path.join(directory, 'agent-keystore.json');
  const credsPath = path.join(directory, 'agent-credentials.json');
  const secretPath = path.join(directory, 'agent-keystore.secret');
  const secret = (): string => {
    const value = readLocalKeystoreSecret(secretPath);
    if (!value) throw new Error('The existing keystore secret is missing or invalid; refusing to replace it.');
    return value;
  };
  const load = (): RotationJournal | null => readRotationJournal(journalPath, secret());
  return {
    acquireLock() {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const release = tryAcquireFileLock(path.join(directory, 'rotation.lock'), { timeoutMs: 0, staleMs: 0, syncOnly: false });
      if (!release) throw new Error('Another rotation is running on this machine.');
      return release;
    },
    completeLegacyPending() {
      // The key remains untouched. Atomic rename records completion, survives
      // restart, and lets a future explicit rotation begin.
      fs.renameSync(path.join(directory, 'pending-sweep.json'), path.join(directory, 'legacy-sweep-complete.json'));
      const fd = fs.openSync(directory, 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    },
    loadLegacyPending() {
      const file = path.join(directory, 'pending-sweep.json');
      if (!fs.existsSync(file)) return null;
      const row = JSON.parse(fs.readFileSync(file, 'utf8')) as { wallet_id: string; old_address: string; new_address: string };
      if (!/^wallet_aw_[A-Za-z0-9_-]+$/.test(row.wallet_id) || !/^0x[0-9a-fA-F]{40}$/.test(row.old_address)
        || !/^0x[0-9a-fA-F]{40}$/.test(row.new_address)) throw new Error('Invalid legacy sweep marker');
      return { walletId: row.wallet_id, oldAddress: row.old_address, newAddress: row.new_address };
    },
    loadJournal: load,
    saveJournal(journal) {
      // Addressed by operation id: starting another rotation never overwrites a
      // previous retired key. Archive first; then publish the active journal.
      writeRotationJournal(path.join(directory, 'rotations', `${journal.config.durableRotation.rotationId}.json`), journal, secret());
      writeRotationJournal(journalPath, journal, secret());
    },
    loadIdentity() {
      const ks = keystoreModule;
      const creds = credentialModule;
      const keystore = ks.loadKeystore(keyPath);
      const credentials = creds.loadBoundAgentCredentialsFile(credsPath);
      if (!keystore || !credentials) return null;
      if (keystore.wallet_id !== credentials.wallet_id || keystore.address.toLowerCase() !== credentials.address.toLowerCase()) throw new Error('The keystore and credentials have different identities.');
      return { walletId: keystore.wallet_id, apiKey: credentials.api_key, apiSecret: credentials.api_secret, oldKeystore: keystore,
        withOldKey: <T>(fn: (key: string) => Promise<T>): Promise<T> => ks.withDecryptedKey(keystore, secret(), dk => fn(dk.privateKey)) };
    },
    generateNewKey() { return (walletModule).generateAgentKeyPair(); },
    rotate(config) { return (walletModule).rotateKey(config); },
    persistNewKey(params) {
      (keystoreModule).persistAgentWalletKey({ ...params, passphrase: secret(), filePath: keyPath });
    },
    rotateCredentials(params) {
      // A checked journal authorizes this exact cross-address replacement. No
      // delete-first gap and no relaxation of other credential writers' guards.
      const journal = load();
      if (!journal?.result || journal.config.walletId !== params.walletId || journal.newAddress.toLowerCase() !== params.address.toLowerCase()
        || journal.result.apiKey !== params.apiKey || journal.result.apiSecret !== params.apiSecret) throw new Error('Credential install is not bound to the rotation journal.');
      atomicReplacePrivateFile(credsPath, JSON.stringify({ api_key: params.apiKey, api_secret: params.apiSecret, wallet_id: params.walletId, address: params.address }) + '\n');
    },
    async sweepPending(pending, options) {
      const journal = load();
      // Also preserve the legacy retired keystore/marker created by old builds.
      const ks = keystoreModule;
      const old = journal?.oldKeystore ?? ks.loadKeystore(path.join(directory, 'agent-keystore.retired.json'));
      if (!old || old.address.toLowerCase() !== pending.oldAddress.toLowerCase()) throw new Error('Retired key does not match the pending sweep.');
      return ks.withDecryptedKey(old, secret(), dk => (sweepModule).sweepErc20ToNewKey({ oldPrivateKey: dk.privateKey, newAddress: pending.newAddress, ...options }));
    },
    log(message) { process.stderr.write(`  ${message}\n`); },
  };
}
