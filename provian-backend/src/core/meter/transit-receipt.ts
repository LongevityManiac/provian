import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { canonicalJson, type SealedCopy } from './meter-wire';
import { privateRetentionKey } from '../provenance/private-retention';

export function transitDigest(sealed: readonly SealedCopy[]): string {
  return createHash('sha256').update(canonicalJson(sealed)).digest('hex');
}

/** Proof that this device's batch was accepted. Authorizes ciphertext redelivery only. */
export function transitReceipt(actor: string, device: string, batchHash: string, recipients: Readonly<Record<string, string>> = {}, sealed: readonly SealedCopy[] = []): string {
  return createHmac('sha256', privateRetentionKey()).update(JSON.stringify(['provian-transit-receipt:v1', actor, device, batchHash,
    Object.entries(recipients).sort(([a], [b]) => a.localeCompare(b)), transitDigest(sealed)])).digest('hex');
}
export function validTransitReceipt(receipt: unknown, actor: string, device: string, batchHash: string, recipients: Readonly<Record<string, string>> = {}, sealed: readonly SealedCopy[] = []): boolean {
  return typeof receipt === 'string' && /^[a-f0-9]{64}$/.test(receipt)
    && timingSafeEqual(Buffer.from(receipt, 'hex'), Buffer.from(transitReceipt(actor, device, batchHash, recipients, sealed), 'hex'));
}
