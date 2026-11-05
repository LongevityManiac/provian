import type { Firestore } from 'firebase-admin/firestore';
import { createIndexedFirestore } from './__test-helpers__/indexed-firestore';
import { NATIVE_WALLET_ADDRESS_INDEX_COLLECTION, nativeWalletAddressIndexId } from './native-wallet-registration';
import { WATCHER_ADDRESS_ADMISSION_COLLECTION, watcherAddressAdmissionDocIdFor } from './watcher-address-admission';
import { addWatchRegistryEntries, markWatchRegistrySeeded, seedWatchMarks, readWatchMarks } from './watch-registry';
import { buildChainRecordInboundScanDeps, runChainRecordInboundScan, CHAIN_RECORD_OWNER_CONCURRENCY,
  CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION, CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID } from './chain-record-inbound-scan';
import { CHAIN_RECORD_OBSERVATIONS_COLLECTION } from './chain-record-watcher';
const FROM = 67_000_000, NOW = Date.UTC(2026, 9, 31), count = 100_000;
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
function seed(db: ReturnType<typeof createIndexedFirestore>['db'], addr: string, id: string) {
  db.store.set(`${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(addr)}`, {
    schema_version: 'native-wallet-address-index/v1', chain_id: 8453, address: addr, wallet_id: id,
    owner_type: 'agent', owner_id: `${id}_owner`, created_at_ms: 1,
  });
  db.store.set(`${WATCHER_ADDRESS_ADMISSION_COLLECTION}/${watcherAddressAdmissionDocIdFor('inbound', 8453, addr)}`, {
    schema_version: 'pvt-watcher-address-admission/v3', direction: 'inbound', chain_id: 8453, address: addr,
    wallet_id: id, agent_id: `${id}_owner`, eligibility_start_block: FROM, state: 'live', backfill_next_block: FROM,
    catch_up_through_block: FROM - 1, membership_generation: 1, generation_fenced_at_registration: true,
    revision: 1, created_at_ms: 1, updated_at_ms: 1,
  });
}
describe('production registry path at 100,000 active addresses', () => {
  it.each([false, true])('covers all active agents with newly-pending=%s and 10ms read/write latency', async pending => {
    const r = createIndexedFirestore(10, 10), db = r.db as unknown as Firestore;
    const addresses = Array.from({ length: count }, (_, i) => address(i + 1000));
    addresses.forEach((addr, i) => seed(r.db, addr, `agent${i}`));
    await addWatchRegistryEntries(db, addresses.map(addr => ({ kind: 'native' as const, address: addr })), 1);
    await markWatchRegistrySeeded(db, 1);
    await seedWatchMarks(db, 'chain_record', pending ? [] : addresses, 1);
    r.db.store.set(`${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID}`, {
      schema_version: 'chain-record-inbound-scan-checkpoint/v1', next_block: FROM,
    });
    const transfers = addresses.map((addr, i) => ({ transactionHash: hash(i + 1), blockNumber: FROM + i % 1500,
      fromAddress: address(1), toAddress: addr, valueWei: '1' }));
    r.startTiming(); const start = Date.now();
    const result = await runChainRecordInboundScan({ ...buildChainRecordInboundScanDeps(db), useRegistry: true,
      getHead: async () => FROM + 1511, now: () => NOW,
      getCompactWindow: async ({ fromBlock, toBlock }) => ({ logs: [], internals: [], transfers: {
        natives: transfers.filter(t => t.blockNumber >= fromBlock && t.blockNumber <= toBlock), signed: [],
      } }),
    });
    const elapsed = Date.now() - start; r.sampleHeap();
    expect(result.error).toBeNull(); expect(result.queued).toBe(count); expect(result.watched_wallets).toBe(count);
    expect(r.db.store.get(`${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID}`)?.next_block).toBe(FROM + 1500);
    expect([...r.db.store.keys()].filter(k => k.startsWith(`${CHAIN_RECORD_OBSERVATIONS_COLLECTION}/`))).toHaveLength(count);
    expect((await readWatchMarks(db, 'chain_record'))?.size).toBe(count);
    expect(r.stats.maxReads).toBeGreaterThan(1); expect(r.stats.maxReads).toBeLessThanOrEqual(CHAIN_RECORD_OWNER_CONCURRENCY * 4);
    console.log(JSON.stringify({ path: 'actual useRegistry=true classifier/fences/queue', active_agents: count, newly_pending: pending,
      owner_read_latency_ms: 10, transaction_or_write_ack_latency_ms: 10, elapsed_ms: elapsed, ...r.stats, peak_heap_delta: r.stats.peakHeap - r.stats.baselineHeap,
      note: 'controlled RPC seam; 100k observations captured, not a production mint SLA' }));
  }, 150_000);
  it('the source-derived equality index retains duplicates and updates rebinds/deletions', async () => {
    const { db } = createIndexedFirestore(); const a = address(5), b = address(6), c = NATIVE_WALLET_ADDRESS_INDEX_COLLECTION;
    db.store.set(`${c}/first`, { address: a }); db.store.set(`${c}/second`, { address: a });
    expect((await db.collection(c).where('address', '==', a).get()).size).toBe(2);
    db.store.set(`${c}/first`, { address: b });
    expect((await db.collection(c).where('address', '==', a).get()).docs.map(d => d.id)).toEqual(['second']);
    expect((await db.collection(c).where('address', '==', b).get()).docs.map(d => d.id)).toEqual(['first']);
    db.store.delete(`${c}/second`); expect((await db.collection(c).where('address', '==', a).get()).empty).toBe(true);
  });
  it('a conflicting source row blocks the actual registry classifier until repaired', async () => {
    const r = createIndexedFirestore(), db = r.db as unknown as Firestore, addr = address(7);
    seed(r.db, addr, 'agent');
    const rival = `${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/rival`;
    const original = r.db.store.get(`${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(addr)}`)!;
    r.db.store.set(rival, { ...original, wallet_id: 'other', owner_id: 'other_owner' });
    await addWatchRegistryEntries(db, [{ kind: 'native', address: addr }], 1);
    await markWatchRegistrySeeded(db, 1);
    await seedWatchMarks(db, 'chain_record', [addr], 1);
    const checkpoint = `${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID}`;
    const run = async () => {
      r.db.store.set(checkpoint, { schema_version: 'chain-record-inbound-scan-checkpoint/v1', next_block: FROM });
      return runChainRecordInboundScan({ ...buildChainRecordInboundScanDeps(db), useRegistry: true,
        getHead: async () => FROM + 12, now: () => NOW,
        getLogs: async () => [], getNativeTransfers: async () => [], getInternalTransfers: async () => [],
        getCompactWindow: async () => ({ logs: [], internals: [], transfers: { signed: [], natives: [{
          transactionHash: hash(1), blockNumber: FROM, fromAddress: address(1), toAddress: addr, valueWei: '1',
        }] } }),
      });
    };
    expect((await run()).queued).toBe(0);
    expect([...r.db.store.keys()].filter(k => k.startsWith(`${CHAIN_RECORD_OBSERVATIONS_COLLECTION}/`))).toHaveLength(0);
    r.db.store.delete(rival);
    expect((await run()).queued).toBe(1);
    expect([...r.db.store.keys()].filter(k => k.startsWith(`${CHAIN_RECORD_OBSERVATIONS_COLLECTION}/`))).toHaveLength(1);
  });
});
