import { createHash } from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { hashAccountCall, hashAccountIntentDigest, parseSignedHashAccountOperation } from './hash-account-data';

export const HASH_AUTHORITY_OPERATIONS = 'recourse_hash_authority_operations_v1';
const maxBytes = 700_000; // Storage transport bound; no member-facing limit.
const digest = (text: string): string => `0x${createHash('sha256').update(text).digest('hex')}`;
const hash = /^0x[0-9a-f]{64}$/;
const fields = ['schema', 'planDigest', 'accountRuntimeHash', 'operation', 'nextItemId', 'intentDigest', 'verifiedBlock', 'transaction'];
function requireValue(value: unknown, reason: string): asserts value {
  if (!value) throw Error(`hash_authority_store_${reason}`);
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'record_invalid');
  const row = value as Record<string, unknown>;
  requireValue(Object.keys(row).sort().join(',') === [...keys].sort().join(','), 'record_invalid');
  return row;
}
/** Public fields only. Seeds remain exclusively in the authority vault. This
 * format check does not replace the caller's independent plan and local
 * signature verification before any executable proof can be exposed. */
function payloadOf(value: unknown): string {
  value = structuredClone(value);
  const row = object(value, fields), block = object(row.verifiedBlock, ['number', 'hash']);
  const transaction = object(row.transaction, ['chainId', 'to', 'value', 'data']);
  const operation = parseSignedHashAccountOperation(row.operation);
  requireValue(row.schema === 'provian.durable-hash-authority.v1'
    && [row.planDigest, row.accountRuntimeHash, row.intentDigest, block.hash].every(value => typeof value === 'string' && hash.test(value))
    && Number.isSafeInteger(block.number) && Number(block.number) > 0
    && typeof row.nextItemId === 'string' && row.nextItemId.length > 0, 'record_invalid');
  requireValue(row.intentDigest === hashAccountIntentDigest(operation) && transaction.chainId === '8453'
    && transaction.to === operation.account && transaction.value === '0' && transaction.data === hashAccountCall(operation), 'transaction_changed');
  const payload = JSON.stringify(value);
  requireValue(Buffer.byteLength(payload) <= maxBytes, 'record_too_large');
  return payload;
}
export interface HashAuthorityOperationStore {
  read(slot: string): Promise<unknown | null>;
  create(slot: string, record: unknown): Promise<void>;
}
/** One immutable document per chain/account/nonce slot. Transactional create
 * elects one operation across competing workers; no update/delete API exists.
 * Use the relay's private-store-wrapped database, which encrypts payloads and
 * HMACs document identifiers. Persistence itself confers no launch authority. */
export function openHashAuthorityOperationStore(db: Firestore): HashAuthorityOperationStore {
  const reference = (slot: string) => {
    requireValue(hash.test(slot), 'slot_invalid');
    return db.collection(HASH_AUTHORITY_OPERATIONS).doc(slot.slice(2));
  };
  return {
    async read(slot: string): Promise<unknown | null> {
      const row = await reference(slot).get();
      if (!row.exists) return null;
      const payload: unknown = row.get('payload');
      requireValue(row.get('slot') === slot && typeof payload === 'string' && Buffer.byteLength(payload) <= maxBytes
        && row.get('payloadHash') === digest(payload), 'record_corrupt');
      let record: unknown;
      try { record = JSON.parse(payload) as unknown; }
      catch { throw Error('hash_authority_store_record_corrupt'); }
      payloadOf(record);
      return record;
    },
    async create(slot: string, record: unknown): Promise<void> {
      const ref = reference(slot), payload = payloadOf(record);
      await db.runTransaction(async tx => {
        requireValue(!(await tx.get(ref)).exists, 'slot_exists');
        tx.create(ref, { slot, payload, payloadHash: digest(payload) });
      });
    },
  };
}
