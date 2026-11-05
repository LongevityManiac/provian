/** Per-package sha256 adapter for `meter-wire.ts` (the SDK uses @noble/hashes, no Node crypto). */
import { sha256 } from '@noble/hashes/sha256';

export function sha256Bytes(data: Uint8Array): Uint8Array {
  return sha256(data);
}
