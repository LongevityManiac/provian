import { createHash } from 'node:crypto';
export function sha256Bytes(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest());
}
