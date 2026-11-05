import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import { transactionEvidence } from './__test-helpers__/base-transaction-evidence';
import { runChainRecordInboundScan, CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION, CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID,
  type ChainRecordScanWallet } from './chain-record-inbound-scan';
import { runChainRecordWatcherCycle, CHAIN_RECORD_OBSERVATIONS_COLLECTION, enqueueChainRecordObservation } from './chain-record-watcher';
import type { CompactDiscoveryWindow } from '../onchain/compact-discovery';
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const FROM = 67_000_000, NOW = Date.UTC(2026, 9, 31, 6), OTHER = '0x5000000000000000000000000000000000000005';
function scan(count: number, failRead = false) {
  const fake = createFakeFirestore();
  const db = fake as unknown as Firestore;
  fake.store.set(`${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID}`, { schema_version: 'chain-record-inbound-scan-checkpoint/v1', next_block: FROM });
  const wallets: ChainRecordScanWallet[] = Array.from({ length: count }, (_, i) => ({
    address: address(i + 1000), walletId: `agent${i}`, ownerType: 'agent', eligibilityStartBlock: FROM,
  }));
  const transfers = wallets.map((w, i) => ({ transactionHash: hash(i + 1), blockNumber: FROM + i % 1500,
    fromAddress: OTHER, toAddress: w.address, valueWei: '1' }));
  const deps = { db, getHead: async () => FROM + 1511, now: () => NOW,
    listWallets: async () => wallets, getLogs: async () => { throw new Error('address fanout must not run'); },
    getCompactWindow: async ({ fromBlock, toBlock }: { fromBlock: number; toBlock: number }): Promise<CompactDiscoveryWindow> => {
      if (failRead) throw new Error('independent provider disagreement');
      return { logs: [], transfers: { natives: transfers.filter(t => t.blockNumber >= fromBlock && t.blockNumber <= toBlock), signed: [] }, internals: [] };
    },
  };
  return { fake, db, deps };
}
describe('active watch population, durable enqueue and bounded drain', () => {
  it('queues all 100,000 active wallets across a 1,500-block window; replay resets no observation', async () => {
    const r = scan(100_000), start = Date.now();
    const report = await runChainRecordInboundScan(r.deps);
    expect(report.error).toBeNull(); expect(report.watched_wallets).toBe(100_000); expect(report.queued).toBe(100_000);
    expect([...r.fake.store.keys()].filter(k => k.startsWith(`${CHAIN_RECORD_OBSERVATIONS_COLLECTION}/`))).toHaveLength(100_000);
    expect(r.fake.store.get(`${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID}`)?.next_block).toBe(FROM + 1500);
    r.fake.store.set(`${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID}`, { schema_version: 'chain-record-inbound-scan-checkpoint/v1', next_block: FROM });
    const replay = await runChainRecordInboundScan(r.deps);
    expect(replay.queued).toBe(0); expect(replay.already_queued).toBe(100_000);
    console.log(JSON.stringify({ active_wallets: 100_000, observations: report.queued, replay_duplicates: replay.already_queued,
      synthetic_enqueue_and_replay_ms: Date.now() - start, external_rpc_latency: 'injected; not a production SLA' }));
  }, 30_000);
  it('a provider disagreement writes no observation and never passes the unread range', async () => {
    const r = scan(100, true);
    const report = await runChainRecordInboundScan(r.deps);
    expect(report.error).toContain('provider disagreement'); expect(report.queued).toBe(0);
    expect(r.fake.store.get(`${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID}`)?.next_block).toBe(FROM);
  });
  it('covers a 200ms five-minute interval at 85 seconds per complete 500-block read', async () => {
    const r = scan(3); let elapsed = 0, reads = 0;
    const read = r.deps.getCompactWindow;
    const result = await runChainRecordInboundScan({ ...r.deps, clock: () => elapsed,
      getCompactWindow: async args => { reads++; elapsed += 85_000; return read(args); },
    });
    expect(result.error).toBeNull(); expect(reads).toBe(3); expect(result.queued).toBe(3);
    expect(r.fake.store.get(`${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID}`)?.next_block).toBe(FROM + 1500);
    // A shorter elapsed budget reproduces the original uncovered third window.
    r.fake.store.set(`${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID}`,
      { schema_version: 'chain-record-inbound-scan-checkpoint/v1', next_block: FROM });
    elapsed = 0; reads = 0;
    const stopped = await runChainRecordInboundScan({ ...r.deps, clock: () => elapsed,
      getCompactWindow: async args => { reads++; elapsed += 85_000; return read(args); },
    }, { maxScanMs: 90_000 });
    expect(reads).toBe(2); expect(stopped.budget_stopped).toBe(true);
    expect(r.fake.store.get(`${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID}`)?.next_block).toBe(FROM + 1000);
  });
  it('default drain processes nonempty successful acts beyond the former fifty-row ceiling', async () => {
    const r = scan(1024);
    await runChainRecordInboundScan(r.deps);
    let emitted = 0, concurrent = 0, maximum = 0;
    const result = await runChainRecordWatcherCycle({ db: r.db, now: () => NOW,
      resolveWallet: async walletId => ({ walletId, agentId: walletId, address: address(Number(walletId.slice(5)) + 1000),
        eligibilityStartBlock: FROM, ownerType: 'agent' }),
      verifyTransaction: async txHash => {
        concurrent++; maximum = Math.max(maximum, concurrent); await new Promise<void>(resolve => setImmediate(resolve)); concurrent--;
        const index = Number(BigInt(txHash)) - 1;
        return transactionEvidence({ transactionHash: txHash, fromAddress: OTHER, toAddress: address(index + 1000),
          blockNumber: FROM + index % 1500, blockTimestampMs: NOW - 60_000, inputEmpty: true, valueWei: '1' });
      },
      emitActPE: async (_wallet, act) => { emitted++; return { peId: act.canonicalEventId }; },
    });
    expect(result.leased).toBe(1024); expect(result.emitted).toBe(1024); expect(emitted).toBe(1024);
    expect(maximum).toBeGreaterThan(1); expect(maximum).toBeLessThanOrEqual(16);
    expect(result.errors).toBe(0);
    // A new scan source for the same event cannot reset a completed observation.
    expect(await enqueueChainRecordObservation(r.db, { txHash: hash(1), walletId: 'agent0', source: 'inbound_scan' }, NOW)).toBe(false);
    expect((await runChainRecordWatcherCycle({ db: r.db, now: () => NOW, resolveWallet: async () => { throw new Error('already complete'); },
      verifyTransaction: async () => { throw new Error('already complete'); }, emitActPE: async () => { throw new Error('already complete'); } })).leased).toBe(0);
  });
});
