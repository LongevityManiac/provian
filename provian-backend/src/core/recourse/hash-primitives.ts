import { createHash, hkdfSync } from 'crypto';

/** Node implementation of the SDK's SHA-256/HKDF byte primitives. */
export const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(bytes).digest());
export function hkdf(hash: typeof sha256, key: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  if (hash !== sha256) throw Error('recourse_hash_algorithm_invalid');
  return new Uint8Array(hkdfSync('sha256', key, salt, info, length));
}
export const bytesToHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
export function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) throw Error('recourse_hash_hex_invalid');
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}
export const utf8ToBytes = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, 'utf8'));
