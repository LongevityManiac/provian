import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import { transactionEvidence } from './__test-helpers__/base-transaction-evidence';
import { readChainRecordDrainCapacity, runChainRecordWatcherCycle, enqueueChainRecordObservation,
  CHAIN_RECORD_OBSERVATIONS_COLLECTION, type ChainRecordWatcherDeps } from './chain-record-watcher';
const START = Date.UTC(2026, 9, 31, 12), FROM = 67_000_000;
const address = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
const hash = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
function fixture() {
  const fake = createFakeFirestore(), db = fake as unknown as Firestore;
  let verified = 0, emitted = 0, active = 0, peak = 0;
  const deps: ChainRecordWatcherDeps = { db, now: Date.now,
    resolveWallet: async walletId => ({ walletId, agentId: walletId, address: address(Number(walletId.slice(5)) + 1000),
      eligibilityStartBlock: FROM, ownerType: 'agent' }),
    verifyTransaction: async txHash => {
      active++; peak = Math.max(peak, active); verified++;
      // Controlled full external-work envelope per observation, including paired
      // verification and downstream acknowledgement. No chain fact is skipped.
      await new Promise<void>(resolve => setTimeout(resolve, 8_000)); active--;
      const index = Number(BigInt(txHash)) - 1;
      return transactionEvidence({ transactionHash: txHash, fromAddress: address(1), toAddress: address(index + 1000),
        blockNumber: FROM, blockTimestampMs: START - 60_000, inputEmpty: true, valueWei: '1' });
    },
    emitActPE: async (_wallet, act) => { emitted++; return { peId: act.canonicalEventId }; },
  };
  return { fake, db, deps, stats: () => ({ verified, emitted, peak }),
    enqueue: async (start: number, count: number) => {
      for (let i = start; i < start + count; i++) await enqueueChainRecordObservation(db,
        { txHash: hash(i + 1), walletId: `agent${i}`, source: 'inbound_scan' }, Date.now());
    } };
}
describe('transaction-driven chain record drain capacity', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(START); });
  afterEach(() => jest.useRealTimers());
  it('drains one daily transaction from 100,000 agents over twelve successive ticks', async () => {
    const f = fixture(), capacity = readChainRecordDrainCapacity({}); let supplied = 0;
    for (let tick = 0; tick < 12; tick++) {
      jest.setSystemTime(START + tick * 300_000);
      const target = Math.floor((tick + 1) * 100_000 / 288), count = target - supplied;
      await f.enqueue(supplied, count); supplied = target;
      const work = runChainRecordWatcherCycle(f.deps, capacity);
      await jest.advanceTimersByTimeAsync(240_000);
      const report = await work;
      expect(report.emitted).toBe(count); expect(report.errors).toBe(0); expect(report.waiting).toBe(0);
      expect([...f.fake.store.values()].filter(row => row.status === 'pending')).toHaveLength(0);
    }
    expect(supplied).toBe(4166); expect(f.stats()).toEqual({ verified: supplied, emitted: supplied, peak: 16 });
  }, 30_000);
  it('scales the same queue with worker capacity and does no work when empty', async () => {
    const f = fixture(); await f.enqueue(0, 1500);
    const first = runChainRecordWatcherCycle(f.deps, readChainRecordDrainCapacity({}));
    await jest.advanceTimersByTimeAsync(240_000); expect((await first).emitted).toBe(480);
    jest.setSystemTime(START + 300_000);
    const more = runChainRecordWatcherCycle(f.deps, readChainRecordDrainCapacity({ CHAIN_RECORD_DRAIN_CONCURRENCY: '32' }));
    await jest.advanceTimersByTimeAsync(240_000); expect((await more).emitted).toBe(960);
    jest.setSystemTime(START + 600_000);
    const last = runChainRecordWatcherCycle(f.deps, readChainRecordDrainCapacity({}));
    await jest.advanceTimersByTimeAsync(240_000); expect((await last).emitted).toBe(60);
    const before = f.stats();
    expect((await runChainRecordWatcherCycle(f.deps, readChainRecordDrainCapacity({}))).leased).toBe(0);
    expect(f.stats()).toEqual(before); expect(before).toEqual({ verified: 1500, emitted: 1500, peak: 32 });
    expect([...f.fake.store.keys()].filter(k => k.startsWith(`${CHAIN_RECORD_OBSERVATIONS_COLLECTION}/`))).toHaveLength(1500);
  }, 30_000);
  it.each(['0', '-1', '129', '16.5', '16junk', '', '9007199254740992'])('refuses invalid concurrency %s', value => {
    expect(() => readChainRecordDrainCapacity({ CHAIN_RECORD_DRAIN_CONCURRENCY: value })).toThrow('chain_record_capacity_invalid');
  });
  it.each(['999', '300001', 'Infinity', '240000junk', '0'])('refuses invalid budget %s', value => {
    expect(() => readChainRecordDrainCapacity({ CHAIN_RECORD_DRAIN_BUDGET_MS: value })).toThrow('chain_record_capacity_invalid');
  });
});
