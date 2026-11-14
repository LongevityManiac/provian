import { SHARED_LEDGER_CURSORS, storeSharedTransfer } from './shared-ledger';
jest.mock('../protocol/runtime', () => ({ currentProtocolDeployment: async () => ({ addresses: { kernel: requireConfiguredPvt9Runtime().address, recoursePool: `0x${'12'.repeat(20)}` }, runtimeHashes: Array(10).fill('0x0000000000000000000000000000000000000000000000000000000000000000') }) }));
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { requireConfiguredPvt9Runtime } from '../pvt/pvt9-base-config.generated';
import { advanceOwnershipLedger } from './ledger-store';
import { RECOURSE_COLLECTIONS, type RegisteredAddress, type TransferEvent } from './ownership';
import type { RecourseChainPort } from './chain-ledger';

const address = `0x${'11'.repeat(20)}`;
const hash = `0x${'ab'.repeat(32)}`;
const nextHash = `0x${'cd'.repeat(32)}`;
const binding: RegisteredAddress = { identity: hash, address,
  kernel: requireConfiguredPvt9Runtime().address.toLowerCase(), boundBlock: 100,
  boundBlockHash: hash, openingBalanceAtomic: '100', bindingDigest: hash, recoveryGeneration: 0, chainBindingStatus: 'confirmed' };
const event: TransferEvent = { block: 101, blockHash: nextHash, transactionHash: hash,
  logIndex: 0, from: `0x${'0'.repeat(40)}`, to: address, amountAtomic: '20' };
const key = `${RECOURSE_COLLECTIONS.addresses}/${address}`;
function port(): RecourseChainPort {
  return { finalizedBlock: async () => 102, blockHash: async n => n === 100 ? hash : nextHash,
    balance: async () => 120n, transfers: async (_kernel, _address, from) => from <= 101 ? [event] : [] };
}
test('direct ledger advancement also rejects a provisional binding', async () => {
  const fake = createFakeFirestore();
  fake.store.set(key, { ...binding, chainBindingStatus: 'pending' });
  await expect(advanceOwnershipLedger(fake as unknown as Firestore, address, 101, port())).rejects.toThrow('binding_pending');
  expect(fake.store.size).toBe(1);
});

test('retry after evidence commit and cursor failure preserves one event and exact totals', async () => {
  const fake = createFakeFirestore({ strictTransactionOrder: true, rejectUndefinedValues: true,
    failTxnWriteOccurrence: { collection: RECOURSE_COLLECTIONS.addresses, occurrence: 1 } });
  fake.store.set(key, { ...binding });
  fake.store.set(`${SHARED_LEDGER_CURSORS}/${binding.kernel}`, { fromBlock: 100, block: 102, blockHash: nextHash });
  await storeSharedTransfer(fake as unknown as Firestore, binding.kernel, address, event);
  const db = fake as unknown as Firestore;
  await expect(advanceOwnershipLedger(db, address, 101, port())).rejects.toThrow('Injected transaction');
  expect(fake.store.get(key)?.checkpoint).toBeUndefined();
  const evidence = () => [...fake.store].filter(([path]) => path.startsWith(`${RECOURSE_COLLECTIONS.events}/`));
  expect(evidence()).toHaveLength(1);
  expect(evidence()[0][1].inbound).toBe('minted');
  const checkpoint = await advanceOwnershipLedger(db, address, 101, port());
  expect(checkpoint).toMatchObject({ balanceAtomic: '120', mintedAtomic: '20', receivedAtomic: '0' });
  expect(await advanceOwnershipLedger(db, address, 102, port())).toMatchObject({ ...checkpoint, block: 102 });
  expect(evidence()).toHaveLength(1);
});

test('conflicting previously persisted evidence refuses cursor advance', async () => {
  const fake = createFakeFirestore({ failTxnWriteOccurrence: { collection: RECOURSE_COLLECTIONS.addresses, occurrence: 1 } });
  fake.store.set(key, { ...binding });
  fake.store.set(`${SHARED_LEDGER_CURSORS}/${binding.kernel}`, { fromBlock: 100, block: 102, blockHash: nextHash });
  await storeSharedTransfer(fake as unknown as Firestore, binding.kernel, address, event);
  const db = fake as unknown as Firestore;
  await expect(advanceOwnershipLedger(db, address, 101, port())).rejects.toThrow();
  const record = [...fake.store].find(([path]) => path.startsWith(`${RECOURSE_COLLECTIONS.events}/`));
  expect(record).toBeDefined();
  fake.store.set(record![0], { ...record![1], amountAtomic: '21' });
  await expect(advanceOwnershipLedger(db, address, 101, port())).rejects.toThrow('recourse_ledger_evidence_conflict');
  expect(fake.store.get(key)?.checkpoint).toBeUndefined();
});

test('a concurrent binding mutation cannot receive the old binding checkpoint', async () => {
  const fake = createFakeFirestore();
  fake.store.set(key, { ...binding });
  fake.store.set(`${SHARED_LEDGER_CURSORS}/${binding.kernel}`, { fromBlock: 100, block: 102, blockHash: nextHash });
  await storeSharedTransfer(fake as unknown as Firestore, binding.kernel, address, event);
  const chain = port();
  chain.balance = async () => {
    fake.store.set(key, { ...binding, bindingDigest: nextHash });
    return 120n;
  };
  await expect(advanceOwnershipLedger(fake as unknown as Firestore, address, 101, chain))
    .rejects.toThrow('recourse_cursor_changed');
  expect(fake.store.get(key)?.checkpoint).toBeUndefined();
});
