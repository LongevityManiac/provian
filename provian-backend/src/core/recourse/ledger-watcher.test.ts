jest.mock('../protocol/runtime', () => ({ currentProtocolDeployment: async () => ({ addresses: { kernel: requireConfiguredPvt9Runtime().address, recoursePool: `0x${'12'.repeat(20)}` }, runtimeHashes: Array(10).fill('0x0000000000000000000000000000000000000000000000000000000000000000') }) }));
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { requireConfiguredPvt9Runtime } from '../pvt/pvt9-base-config.generated';
import { ERC20_TRANSFER_TOPIC, type CanonicalEconomicLog } from '../onchain/economic-discovery';
import { RECOURSE_COLLECTIONS } from './ownership';
import { runOwnershipLedgerWatcher, type LedgerWatcherPort } from './ledger-watcher';

const kernel = requireConfiguredPvt9Runtime().address.toLowerCase();
const address = `0x${'11'.repeat(20)}`;
const zero = `0x${'0'.repeat(40)}`;
const hash = `0x${'ab'.repeat(32)}`;
const topic = (a: string) => `0x${'0'.repeat(24)}${a.slice(2)}`;
function fixture(failCursor = false) {
  const fake = createFakeFirestore({ strictTransactionOrder: true,
    ...(failCursor ? { failTxnWriteOccurrence: { collection: 'recourse_ledger_cursors', occurrence: 1 } } : {}) });
  fake.store.set(`${RECOURSE_COLLECTIONS.addresses}/${address}`, { kernel, address, identity: hash,
    boundBlock: 100, boundBlockHash: hash, bindingDigest: hash, openingBalanceAtomic: '100', recoveryGeneration: 0, chainBindingStatus: 'confirmed' });
  const log: CanonicalEconomicLog = { address: kernel, topics: [ERC20_TRANSFER_TOPIC, topic(zero), topic(address)],
    data: `0x${(20n).toString(16).padStart(64, '0')}`, blockNumber: 101, blockHash: hash,
    transactionHash: hash, transactionIndex: 0, logIndex: 0, removed: false };
  const logs = jest.fn(async () => [log]);
  const balance = jest.fn(async () => 120n);
  const port: LedgerWatcherPort = { logs, chain: { finalizedBlock: async () => 102, blockHash: async () => hash,
    balance, transfers: async () => [{ block: 101, blockHash: hash, transactionHash: hash,
      logIndex: 0, from: zero, to: address, amountAtomic: '20' }] } };
  return { fake, db: fake as unknown as Firestore, port, logs, balance, log };
}
test('a global cursor retry does not count an already committed inbound twice', async () => {
  const { fake, db, port, logs, balance } = fixture(true);
  await expect(runOwnershipLedgerWatcher(db, port)).rejects.toThrow('Injected transaction');
  expect(fake.store.has(`recourse_ledger_cursors/${kernel}`)).toBe(false);
  expect(await runOwnershipLedgerWatcher(db, port)).toEqual({ through: 102, updated: 0 });
  expect(balance).toHaveBeenCalledTimes(1);
  expect(logs).toHaveBeenCalledTimes(2);
  expect(fake.store.get(`${RECOURSE_COLLECTIONS.addresses}/${address}`)?.checkpoint)
    .toMatchObject({ balanceAtomic: '120', mintedAtomic: '20' });
});
test('quiet holders cause no balance polling', async () => {
  const { db, port, logs, balance } = fixture();
  logs.mockResolvedValue([]);
  expect(await runOwnershipLedgerWatcher(db, port)).toEqual({ through: 102, updated: 0 });
  expect(balance).not.toHaveBeenCalled();
});
test('provisional off-chain admission does not establish an ownership ledger', async () => {
  const { fake, db, port, balance, logs } = fixture();
  fake.store.get(`${RECOURSE_COLLECTIONS.addresses}/${address}`)!.chainBindingStatus = 'pending';
  expect(await runOwnershipLedgerWatcher(db, port)).toEqual({ updated: 0, idle: true });
  expect(balance).not.toHaveBeenCalled(); expect(logs).not.toHaveBeenCalled();
});
test('late binding confirmation catches up even when the shared cursor already passed its transfers', async () => {
  const { fake, db, port, balance, logs } = fixture();
  fake.store.set(`recourse_ledger_cursors/${kernel}`, { block: 102, blockHash: hash });
  fake.store.get(`${RECOURSE_COLLECTIONS.addresses}/${address}`)!.ledgerNeedsCatchup = true;
  expect(await runOwnershipLedgerWatcher(db, port)).toEqual({ through: 102, updated: 1, idle: false });
  expect(balance).toHaveBeenCalledTimes(1); expect(logs).not.toHaveBeenCalled();
  expect(fake.store.get(`${RECOURSE_COLLECTIONS.addresses}/${address}`)).toMatchObject({ ledgerNeedsCatchup: false,
    checkpoint: { balanceAtomic: '120', mintedAtomic: '20' } });
  expect(await runOwnershipLedgerWatcher(db, port)).toEqual({ through: 102, updated: 0, idle: true });
});
test('a malformed transfer cannot advance the global cursor', async () => {
  const { fake, db, port, logs, log } = fixture();
  logs.mockResolvedValue([{ ...log, topics: [ERC20_TRANSFER_TOPIC, topic(zero), hash] }]);
  await expect(runOwnershipLedgerWatcher(db, port)).rejects.toThrow('recourse_watcher_log_invalid');
  expect(fake.store.has(`recourse_ledger_cursors/${kernel}`)).toBe(false);
});
test('failure to persist address evidence leaves the shared interval retryable', async () => {
  const { fake, db, port } = fixture();
  port.chain.balance = async () => { throw new Error('provider unavailable'); };
  await expect(runOwnershipLedgerWatcher(db, port)).rejects.toThrow('provider unavailable');
  expect(fake.store.has(`recourse_ledger_cursors/${kernel}`)).toBe(false);
});
