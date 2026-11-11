import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import * as fs from 'node:fs';
import { atomicReplacePrivateFile } from './durable-private-file';
import type { HashDeliveryRecord } from './hash-account-delivery';

function aad(id: string, sender: string): Buffer {
  if (!/^0x[0-9a-f]{64}$/.test(id) || !/^0x[0-9a-f]{40}$/.test(sender)) throw Error('hash_wallet_delivery_invalid');
  return Buffer.from(JSON.stringify(['provian.hash.delivery.v1', id, sender]));
}
export function readHashDeliveryJournal(file: string, passphrase: string, id: string, sender: string): HashDeliveryRecord | null {
  if (passphrase.length < 8) throw Error('hash_wallet_delivery_passphrase_invalid');
  const binding = aad(id, sender);
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw Error('hash_wallet_delivery_unsafe_file');
    const e = JSON.parse(fs.readFileSync(fd, 'utf8')) as Record<string, unknown>;
    if (!e || Object.keys(e).sort().join(',') !== 'ciphertext,iv,salt,tag,version' || e.version !== 1
      || typeof e.salt !== 'string' || !/^[0-9a-f]{64}$/.test(e.salt) || typeof e.iv !== 'string' || !/^[0-9a-f]{24}$/.test(e.iv)
      || typeof e.tag !== 'string' || !/^[0-9a-f]{32}$/.test(e.tag) || typeof e.ciphertext !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(e.ciphertext)) throw Error('hash_wallet_delivery_envelope_invalid');
    const key = scryptSync(passphrase, Buffer.from(e.salt, 'hex'), 32);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'hex'));
      decipher.setAAD(binding); decipher.setAuthTag(Buffer.from(e.tag, 'hex'));
      const plain = Buffer.concat([decipher.update(Buffer.from(e.ciphertext, 'hex')), decipher.final()]);
      try { return JSON.parse(plain.toString('utf8')) as HashDeliveryRecord; } finally { plain.fill(0); }
    } finally { key.fill(0); }
  } finally { fs.closeSync(fd); }
}
export function writeHashDeliveryJournal(file: string, passphrase: string, id: string, sender: string, record: HashDeliveryRecord): void {
  if (passphrase.length < 8 || record.operation !== id || record.sender !== sender) throw Error('hash_wallet_delivery_invalid');
  const salt = randomBytes(32), iv = randomBytes(12), key = scryptSync(passphrase, salt, 32), plain = Buffer.from(JSON.stringify(record));
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad(id, sender));
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    atomicReplacePrivateFile(file, JSON.stringify({ version: 1, salt: salt.toString('hex'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('hex') }));
    if (JSON.stringify(readHashDeliveryJournal(file, passphrase, id, sender)) !== plain.toString('utf8')) throw Error('hash_wallet_delivery_write_unconfirmed');
  } finally { key.fill(0); plain.fill(0); }
}
