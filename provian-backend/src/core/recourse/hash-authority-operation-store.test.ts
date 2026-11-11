import { createHash } from 'crypto';
import { sha256 } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { hashAccountCall, hashAccountIntentDigest } from './hash-account-data';
import { HASH_AUTHORITY_OPERATIONS, openHashAuthorityOperationStore } from './hash-authority-operation-store';
import { isPrivateCollection, encodePrivateRecord, decodePrivateRecord, privateStorageId } from '../provenance/private-store';
const a = (n: number): string => '0x' + n.toString(16).padStart(40, '0');
const h = (n: number): string => '0x' + n.toString(16).padStart(64, '0');
function fixture() {
  const fake = createFakeFirestore(), store = openHashAuthorityOperationStore(fake as unknown as Firestore), slot = h(1);
  // Public shape fixture only; local cryptographic signature verification lives
  // in the durable preparer's real-SLH tests and is mandatory before exposure.
  const operation = { chainId: '8453', account: a(1), target: a(2), nonce: '0', value: '0', callGas: '2000000', data: '0x1234',
    nextCommitment: h(2), publicKey: h(3), signingRoot: sha256(h(3)), signature: '0x' + '00'.repeat(7856) };
  const record = { schema: 'provian.durable-hash-authority.v1', planDigest: h(4), accountRuntimeHash: h(5), operation,
    nextItemId: 'public-vault-reference', intentDigest: hashAccountIntentDigest(operation), verifiedBlock: { number: 100, hash: h(100) },
    transaction: { chainId: '8453', to: operation.account, value: '0', data: hashAccountCall(operation) } };
  return { fake, store, slot, record, path: `${HASH_AUTHORITY_OPERATIONS}/${slot.slice(2)}` };
}
test('immutable public operation persists and reads back without exposing key material', async () => {
  const f = fixture(); expect(await f.store.read(f.slot)).toBeNull();
  await f.store.create(f.slot, f.record); expect(await f.store.read(f.slot)).toEqual(f.record);
  expect(f.fake.store.size).toBe(1); expect(JSON.stringify([...f.fake.store.values()])).not.toContain('seed');
  await expect(f.store.create(f.slot, f.record)).rejects.toThrow(/slot_exists/);
  await expect(f.store.create(f.slot, { ...f.record, nextItemId: 'replacement' })).rejects.toThrow(/slot_exists/);
  expect(await f.store.read(f.slot)).toEqual(f.record);
});
test.each(['top', 'operation', 'transaction', 'checkpoint'])('credential-shaped extra %s fields refuse before any write', async mode => {
  const f = fixture(), value: Record<string, unknown> = structuredClone(f.record);
  if (mode === 'top') value.seed = 'must-not-store';
  else {
    const key = mode === 'checkpoint' ? 'verifiedBlock' : mode;
    value[key] = { ...(value[key] as Record<string, unknown>), seed: 'must-not-store' };
  }
  await expect(f.store.create(f.slot, value)).rejects.toThrow(); expect(f.fake.store.size).toBe(0);
});
test.each(['slot', 'payload', 'hash', 'transaction'])('stored %s corruption cannot produce a usable operation', async mode => {
  const f = fixture(); await f.store.create(f.slot, f.record);
  const row = f.fake.store.get(f.path)!;
  if (mode === 'slot') row.slot = h(99);
  if (mode === 'payload') row.payload = String(row.payload) + ' ';
  if (mode === 'hash') row.payloadHash = h(99);
  if (mode === 'transaction') {
    const changed = structuredClone(f.record); changed.transaction.to = a(99);
    row.payload = JSON.stringify(changed); row.payloadHash = '0x' + createHash('sha256').update(String(row.payload)).digest('hex');
  }
  f.fake.store.set(f.path, row);
  await expect(f.store.read(f.slot)).rejects.toThrow(/record_corrupt|transaction_changed/);
});
test('invalid slots and oversized records never open a new operation slot', async () => {
  const f = fixture();
  await expect(f.store.create('../other', f.record)).rejects.toThrow(/slot_invalid/);
  await expect(f.store.read('../other')).rejects.toThrow(/slot_invalid/);
  await expect(f.store.create(f.slot, { ...f.record, nextItemId: 'x'.repeat(700_000) })).rejects.toThrow(/record_too_large/);
  expect(f.fake.store.size).toBe(0);
});
test('non-enumerable serialization hooks cannot persist credential fields', async () => {
  const f = fixture(), expected = structuredClone(f.record);
  Object.defineProperty(f.record.operation, 'toJSON', { value: () => ({ ...f.record.operation, seed: 'private-seed-must-stay-in-vault' }) });
  await f.store.create(f.slot, f.record);
  expect(JSON.stringify([...f.fake.store.values()])).not.toContain('private-seed-must-stay-in-vault');
  expect(await f.store.read(f.slot)).toEqual(expected);
});
test('operation slots route through encrypted payloads and opaque document identifiers', async () => {
  const f = fixture(), prior = process.env.RELAY_SIGNING_KEY;
  process.env.RELAY_SIGNING_KEY = 'public-local-test-key-for-operation-store';
  try {
    expect(isPrivateCollection(HASH_AUTHORITY_OPERATIONS)).toBe(true);
    await f.store.create(f.slot, f.record);
    const logical = f.fake.store.get(f.path)!, id = f.slot.slice(2);
    const physical = privateStorageId(HASH_AUTHORITY_OPERATIONS, id);
    expect(physical).toMatch(/^pv1_[0-9a-f]{64}$/); expect(physical).not.toContain(id);
    const encrypted = encodePrivateRecord(HASH_AUTHORITY_OPERATIONS, id, logical);
    const serialized = JSON.stringify(encrypted);
    expect(serialized).not.toContain(f.record.operation.signature);
    expect(serialized).not.toContain(f.record.nextItemId);
    expect(decodePrivateRecord(HASH_AUTHORITY_OPERATIONS, physical, encrypted, f.fake).data).toEqual(logical);
    const altered = { ...encrypted, body: { ...encrypted.body, tag: Buffer.alloc(16) } };
    expect(() => decodePrivateRecord(HASH_AUTHORITY_OPERATIONS, physical, altered, f.fake)).toThrow();
  } finally {
    if (prior === undefined) delete process.env.RELAY_SIGNING_KEY; else process.env.RELAY_SIGNING_KEY = prior;
  }
});
