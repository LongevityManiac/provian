import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { LIFECYCLE_EVENTS, LIFECYCLE_CURSORS, LIFECYCLE_PENDING, lifecycleRecords, runRecourseLifecycleWatcher, type LifecycleWatcherPort } from './lifecycle-records';
import type { LifecycleSource } from './lifecycle-sources';
import type { CanonicalEconomicLog } from '../onchain/economic-discovery';
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const source: LifecycleSource = { address: `0x${'11'.repeat(20)}`, kind: 'pool', from: 99, through: 101 };
function log(identity = h(1), index = 2): CanonicalEconomicLog {
  const event = LIFECYCLE_EVENTS.pool.encodeEventLog(LIFECYCLE_EVENTS.pool.getEvent('MembershipChanged')!, [identity, true, 1, 24322]);
  return { ...event, address: source.address, blockNumber: 100, blockHash: h(100), transactionHash: h(200),
    transactionIndex: 0, logIndex: index, removed: false };
}
test('only canonical known events become one ordered record per owner and source transaction', () => {
  const records = lifecycleRecords(source, [log(h(2), 4), log(h(1), 3), log(h(1), 2)], 99, 101);
  expect(records).toHaveLength(2);
  expect(records[0]).toMatchObject({ identity: h(1), events: [{ logIndex: 2 }, { logIndex: 3 }] });
  expect(records[0].events[0].values).toMatchObject({ joined: true, generation: '1' });
  for (const bad of [{ ...log(), removed: true }, { ...log(), address: `0x${'22'.repeat(20)}` },
    { ...log(), blockNumber: 102 }]) expect(() => lifecycleRecords(source, [bad], 99, 101)).toThrow('log_invalid');
  expect(() => lifecycleRecords(source, [log(), log()], 99, 101)).toThrow('duplicate');
});
test('a missing owner key preserves its pending record while intake and other owners continue', async () => {
  const fake = createFakeFirestore({ strictTransactionOrder: true }), db = fake as unknown as Firestore;
  let missing = true;
  const record = jest.fn(async (_db: Firestore, event: { identity: string }) => { if (missing && event.identity === h(1)) throw Error('missing owner mailbox'); });
  const port: LifecycleWatcherPort = { sources: async () => [source], logs: async () => [log(), log(h(2), 3)],
    blockHash: async height => h(height), withdrawalOwners: async () => new Map(), record };
  expect(await runRecourseLifecycleWatcher(db, port)).toEqual({ recorded: 1, pendingSources: 1 });
  expect(record).toHaveBeenCalledTimes(2);
  expect(fake.store.get(`${LIFECYCLE_CURSORS}/pool:${source.address}`)?.block).toBe(101);
  expect([...fake.store.keys()].filter(k => k.startsWith(LIFECYCLE_PENDING))).toHaveLength(1);
  missing = false;
  expect(await runRecourseLifecycleWatcher(db, port)).toEqual({ recorded: 1, pendingSources: 0 });
  expect(fake.store.get(`${LIFECYCLE_CURSORS}/pool:${source.address}`)).toEqual({ block: 101, blockHash: h(101) });
  expect(await runRecourseLifecycleWatcher(db, port)).toEqual({ recorded: 0, pendingSources: 0 });
});
test('a changed canonical event block cannot advance the owner chain or the scan cursor', async () => {
  const fake = createFakeFirestore(), db = fake as unknown as Firestore, record = jest.fn();
  const port: LifecycleWatcherPort = { sources: async () => [source], logs: async () => [log()],
    blockHash: async () => h(999), withdrawalOwners: async () => new Map(), record };
  await expect(runRecourseLifecycleWatcher(db, port)).rejects.toThrow('reorg');
  expect(record).not.toHaveBeenCalled();
  expect(fake.store.size).toBe(0);
});

test('a permanently unavailable owner cannot prevent intake or delivery beyond the first scan window', async () => {
  const fake = createFakeFirestore({ strictTransactionOrder: true }), db = fake as unknown as Firestore;
  const later = { ...log(h(2), 3), blockNumber: 700, blockHash: h(700), transactionHash: h(201) };
  const record = jest.fn(async (_db: Firestore, event: { identity: string }) => { if (event.identity === h(1)) throw Error('missing'); });
  const port: LifecycleWatcherPort = { sources: async () => [{ ...source, through: 800 }],
    logs: async range => [log(), later].filter(event => event.blockNumber >= range.fromBlock && event.blockNumber <= range.toBlock),
    blockHash: async height => h(height), withdrawalOwners: async () => new Map(), record };
  expect(await runRecourseLifecycleWatcher(db, port)).toEqual({ recorded: 1, pendingSources: 1 });
  expect(fake.store.get(`${LIFECYCLE_CURSORS}/pool:${source.address}`)?.block).toBe(800);
  expect(await runRecourseLifecycleWatcher(db, port)).toEqual({ recorded: 0, pendingSources: 1 });
  expect(record).toHaveBeenCalledWith(db, expect.objectContaining({ identity: h(2), block: 700 }));
  expect(fake.store.get(`${LIFECYCLE_CURSORS}/pool:${source.address}`)?.block).toBe(800);
});

test('direct monetary outcomes are recorded and a withdrawal requires independent allocation identity', () => {
  const reversal = LIFECYCLE_EVENTS.restoration.encodeEventLog(LIFECYCLE_EVENTS.restoration.getEvent('TheftReversed')!,
    [h(300), h(1), `0x${'33'.repeat(20)}`, 20, h(400)]);
  expect(lifecycleRecords({ ...source, kind: 'restoration' }, [{ ...log(), ...reversal }], 99, 101)[0].events[0])
    .toMatchObject({ name: 'TheftReversed', values: { amount: '20', request: h(300) } });
  const withdrawal = LIFECYCLE_EVENTS.pool.encodeEventLog(LIFECYCLE_EVENTS.pool.getEvent('RestorationWithdrawn')!,
    [h(300), `0x${'33'.repeat(20)}`, 10]);
  expect(() => lifecycleRecords(source, [{ ...log(), ...withdrawal }], 99, 101)).toThrow('identity_invalid');
  const records = lifecycleRecords(source, [{ ...log(), ...withdrawal }], 99, 101, new Map([[h(300), h(1)]]));
  expect(records[0]).toMatchObject({ identity: h(1), events: [{ name: 'RestorationWithdrawn', values: { amount: '10' } }] });
});
