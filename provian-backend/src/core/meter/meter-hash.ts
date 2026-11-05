/** Per-package sha256 adapter for `meter-wire.ts` (the relay uses Node's crypto). */
import { createHash } from 'crypto';

export function sha256Bytes(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest());
}
