import * as fs from 'node:fs';
import * as path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { loadKeystore, withDecryptedKey, type AgentKeystore } from './keystore';
import { deriveAddressFromPrivateKey } from './wallet';
import { tryAcquireFileLock } from './meter/file-lock';
import { atomicReplacePrivateFile } from './durable-private-file';
import { durableDirectory } from './durable-directory';
import { validateAgentHashBackup } from './break-recovery-store';

const aad = Buffer.from('provian.agent-recovery-backup/v1');
const rootFiles = new Set(['agent-keystore.json', 'agent-keystore.retired.json', 'agent-credentials.json',
  'rotation-journal.json', 'recourse-recovery.json', 'active-hash-wallet.json', 'pending-sweep.json', 'legacy-sweep-complete.json']);
const recordDirectories = new Set(['rotations', 'recoveries', 'break-recoveries', 'hash-wallet-history', 'hash-wallet-operations', 'hash-deliveries']);
interface Payload { version: 1; walletId: string; localPassphrase: string; files: Record<string, string> }
function allowed(name: string): boolean {
  if (rootFiles.has(name)) return true;
  const parts = name.split('/');
  if (parts.length === 2 && recordDirectories.has(parts[0]) && /^[A-Za-z0-9_-]+\.json$/.test(parts[1])) return true;
  return parts.length === 3 && parts[0] === 'evm-nonces' && /^[0-9]+_0x[0-9a-f]{40}(?:_[A-Za-z0-9_-]{1,128})?$/.test(parts[1])
    && /^(?:head|v[1-9][0-9]*\.json)$/.test(parts[2]);
}
function readPrivate(file: string): Buffer {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw Error('recovery_backup_unsafe_file');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
function names(directory: string): string[] {
  const files: string[] = [];
  const walk = (relative: string) => {
    const target = path.join(directory, relative);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) throw Error('recovery_backup_symlink');
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(target).sort()) {
        // Nonce CAS temporary files are never a committed operation. The two
        // complete scans below detect concurrent changes to committed state.
        if (relative.startsWith('evm-nonces') && /^(?:tmp-|head-|compact-)/.test(name)) continue;
        walk(`${relative}/${name}`);
      }
    } else {
      if (!stat.isFile() || !allowed(relative)) throw Error('recovery_backup_unknown_record');
      files.push(relative);
    }
  };
  for (const name of [...rootFiles, ...recordDirectories, 'evm-nonces']) walk(name);
  return files.sort();
}
function capture(directory: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of names(directory)) {
    const bytes = readPrivate(path.join(directory, name));
    try { result[name] = bytes.toString('base64'); } finally { bytes.fill(0); }
  }
  return result;
}
async function validate(payload: unknown): Promise<Payload> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Error('recovery_backup_invalid');
  const row = payload as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'files,localPassphrase,version,walletId' || row.version !== 1
    || typeof row.walletId !== 'string' || !/^wallet_aw_[A-Za-z0-9_-]+$/.test(row.walletId)
    || typeof row.localPassphrase !== 'string' || row.localPassphrase.length < 8 || !row.files || typeof row.files !== 'object' || Array.isArray(row.files)) throw Error('recovery_backup_invalid');
  const files = row.files as Record<string, unknown>;
  for (const [name, value] of Object.entries(files)) {
    if (!allowed(name) || typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
      || Buffer.from(value, 'base64').toString('base64') !== value) throw Error('recovery_backup_invalid_record');
  }
  if (typeof files['agent-keystore.json'] !== 'string') throw Error('recovery_backup_keystore_missing');
  const bytes = Buffer.from(files['agent-keystore.json'], 'base64');
  try {
    const keystore = JSON.parse(bytes.toString('utf8')) as AgentKeystore;
    if (keystore.wallet_id !== row.walletId) throw Error('recovery_backup_wallet_changed');
    await withDecryptedKey(keystore, row.localPassphrase, async key => {
      if (deriveAddressFromPrivateKey(key.privateKey).toLowerCase() !== keystore.address.toLowerCase()) throw Error('recovery_backup_wallet_changed');
    });
  } finally { bytes.fill(0); }
  return row as unknown as Payload;
}
function decrypt(raw: Buffer, backupPassphrase: string): unknown {
  if (backupPassphrase.length < 8) throw Error('recovery_backup_passphrase_invalid');
  const envelope = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  if (envelope.format !== 'provian-agent-recovery-backup-v1' || typeof envelope.salt !== 'string' || !/^[0-9a-f]{64}$/.test(envelope.salt)
    || typeof envelope.iv !== 'string' || !/^[0-9a-f]{24}$/.test(envelope.iv) || typeof envelope.tag !== 'string' || !/^[0-9a-f]{32}$/.test(envelope.tag)
    || typeof envelope.ciphertext !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(envelope.ciphertext)) throw Error('recovery_backup_invalid');
  const key = scryptSync(backupPassphrase, Buffer.from(envelope.salt, 'hex'), 32);
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'hex'));
    cipher.setAAD(aad); cipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
    const plain = Buffer.concat([cipher.update(Buffer.from(envelope.ciphertext, 'hex')), cipher.final()]);
    try { return JSON.parse(plain.toString('utf8')); } finally { plain.fill(0); }
  } finally { key.fill(0); }
}

/** Includes every retained owner/spending generation and exact pending delivery,
 * rather than just the original curve key. The separate backup passphrase also
 * encrypts API credentials and the local at-rest secret; neither is exported in
 * cleartext. Export is local and never contacts a relay or signs a transaction. */
export async function exportAgentRecoveryBackup(supplied: { directory: string; destination: string; localPassphrase: string; backupPassphrase: string }): Promise<string> {
  const input = { ...supplied }, directory = path.resolve(input.directory), destination = path.resolve(input.destination);
  if (input.backupPassphrase.length < 8 || destination === directory || destination.startsWith(`${directory}${path.sep}`)) throw Error('recovery_backup_destination_invalid');
  const releases: (() => void)[] = [];
  try {
    for (const name of ['hash-delivery.lock', 'rotation.lock']) {
      const release = tryAcquireFileLock(path.join(directory, name), { timeoutMs: 0, staleMs: 0, syncOnly: false });
      if (!release) throw Error('recovery_backup_transition_in_progress'); releases.push(release);
    }
    const keystore = loadKeystore(path.join(directory, 'agent-keystore.json'));
    if (!keystore) throw Error('recovery_backup_keystore_missing');
    const files = capture(directory);
    const payload = await validate({ version: 1, walletId: keystore.wallet_id, localPassphrase: input.localPassphrase, files });
    validateAgentHashBackup(directory, input.localPassphrase);
    if (JSON.stringify(capture(directory)) !== JSON.stringify(files)) throw Error('recovery_backup_state_changed');
    const plain = Buffer.from(JSON.stringify(payload)), salt = randomBytes(32), iv = randomBytes(12);
    const key = scryptSync(input.backupPassphrase, salt, 32);
    try {
      const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
      const encrypted = JSON.stringify({ format: 'provian-agent-recovery-backup-v1', salt: salt.toString('hex'), iv: iv.toString('hex'),
        tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('hex') });
      durableDirectory(path.dirname(destination)); atomicReplacePrivateFile(destination, encrypted);
      const readback = readPrivate(destination);
      try { if (JSON.stringify(await validate(decrypt(readback, input.backupPassphrase))) !== JSON.stringify(payload)) throw Error('recovery_backup_readback_failed'); }
      finally { readback.fill(0); }
      return destination;
    } finally { plain.fill(0); key.fill(0); }
  } finally { for (const release of releases.reverse()) release(); }
}

/** Restore only into a new directory. Validation precedes all installation; a
 * single directory rename publishes the complete point-in-time state. */
export async function importAgentRecoveryBackup(supplied: { source: string; directory: string; backupPassphrase: string }): Promise<{ directory: string; walletId: string }> {
  const input = { ...supplied }, directory = path.resolve(input.directory), raw = readPrivate(path.resolve(input.source));
  let payload: Payload;
  try { payload = await validate(decrypt(raw, input.backupPassphrase)); } finally { raw.fill(0); }
  try { fs.lstatSync(directory); throw Error('recovery_backup_destination_exists'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const parent = path.dirname(directory); durableDirectory(parent);
  const staging = fs.mkdtempSync(path.join(parent, '.provian-recovery-'));
  try {
    fs.chmodSync(staging, 0o700);
    for (const [name, value] of Object.entries(payload.files)) {
      const target = path.join(staging, name); durableDirectory(path.dirname(target));
      const bytes = Buffer.from(value, 'base64');
      try { const fd = fs.openSync(target, 'wx', 0o600); try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
      finally { bytes.fill(0); }
    }
    atomicReplacePrivateFile(path.join(staging, 'agent-keystore.secret'), payload.localPassphrase);
    validateAgentHashBackup(staging, payload.localPassphrase);
    if (JSON.stringify(capture(staging)) !== JSON.stringify(payload.files)) throw Error('recovery_backup_readback_failed');
    const directories = new Set([staging, ...Object.keys(payload.files).map(name => path.dirname(path.join(staging, name)))]);
    for (const saved of [...directories].sort((a, b) => b.length - a.length)) {
      const fd = fs.openSync(saved, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    fs.renameSync(staging, directory);
    const fd = fs.openSync(parent, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return { directory, walletId: payload.walletId };
  } catch (error) { fs.rmSync(staging, { recursive: true, force: true }); throw error; }
}
