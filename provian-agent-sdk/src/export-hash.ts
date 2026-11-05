/** Per-package keccak-256 adapter for `pe-export-wire.ts` (the anchor's on-chain rules). */
import { keccak_256 } from '@noble/hashes/sha3';

export function keccak256Bytes(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}
