import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import { atomicReplacePrivateFile } from './durable-private-file';
import type { RotationJournal } from './rotate-key-flow';
import { deriveAgentIdentityFromPrivateKey } from './wallet';
import { decryptKeystore } from './keystore';

const AAD = Buffer.from('provian-rotation-journal/v1');
function key(secret: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error('Invalid rotation encryption secret');
  return createHash('sha256').update(AAD).update(Buffer.from(secret, 'hex')).digest();
}
function validate(journal: RotationJournal, secret: string): void {
  const config = journal.config;
  if (journal.version !== 1 || typeof journal.installed !== 'boolean'
    || !/^wallet_aw_[A-Za-z0-9_-]+$/.test(config.walletId)
    || !/^rotation_[0-9a-f-]{36}$/.test(config.durableRotation.rotationId)
    || !/^pvn_live_[0-9a-f]{32}$/.test(config.durableRotation.apiKey)
    || !/^pvns_[0-9a-f]{64}$/.test(config.durableRotation.apiSecret)) throw new Error('Invalid rotation journal');
  const old = deriveAgentIdentityFromPrivateKey(config.oldPrivateKey);
  const next = deriveAgentIdentityFromPrivateKey(config.newPrivateKey);
  const retired = decryptKeystore(journal.oldKeystore, secret);
  if (old.address.toLowerCase() !== journal.oldAddress.toLowerCase()
    || next.address.toLowerCase() !== journal.newAddress.toLowerCase()
    || next.publicKey !== journal.newPublicKey
    || retired.privateKey !== config.oldPrivateKey.replace(/^0x/, '')
    || journal.oldKeystore.wallet_id !== config.walletId) throw new Error('Rotation journal key binding mismatch');
  if (journal.result && (journal.result.walletId !== config.walletId
    || journal.result.oldAddress.toLowerCase() !== journal.oldAddress.toLowerCase()
    || journal.result.newAddress.toLowerCase() !== journal.newAddress.toLowerCase()
    || journal.result.apiKey !== config.durableRotation.apiKey || journal.result.apiSecret !== config.durableRotation.apiSecret)) throw new Error('Rotation result binding mismatch');
  if (journal.installed && !journal.result) throw new Error('Installed rotation has no result');
}

export function writeRotationJournal(file: string, journal: RotationJournal, secret: string): void {
  validate(journal, secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(secret), iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(journal), 'utf8'), cipher.final()]);
  atomicReplacePrivateFile(file, JSON.stringify({ version: 1, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('hex') }) + '\n');
}
export function readRotationJournal(file: string, secret: string): RotationJournal | null {
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 128 * 1024 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Unsafe rotation journal');
    const envelope = JSON.parse(fs.readFileSync(fd, 'utf8')) as { version: number; iv: string; tag: string; ciphertext: string };
    if (envelope.version !== 1 || !/^[0-9a-f]{24}$/.test(envelope.iv) || !/^[0-9a-f]{32}$/.test(envelope.tag)
      || !/^(?:[0-9a-f]{2})+$/.test(envelope.ciphertext)) throw new Error('Invalid encrypted rotation journal');
    const decipher = createDecipheriv('aes-256-gcm', key(secret), Buffer.from(envelope.iv, 'hex'));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
    const journal = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'hex')), decipher.final()]).toString('utf8')) as RotationJournal;
    validate(journal, secret);
    return journal;
  } finally { fs.closeSync(fd); }
}
