import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import {
  MULTICHAIN_SCAN_CURSORS_COLLECTION,
  MULTICHAIN_SCAN_INTERVAL_MS,
  MULTICHAIN_SCAN_RUN_INTERVAL_MS,
  findBlockAtOrAfter,
  readAlchemyTransfers,
  resolveMultichainEntry,
  runChainRecordMultichainScan,
  type MultichainRegistryEntry,
  type MultichainScanDeps,
  type RpcSend,
} from './chain-record-multichain-scan';
import { CHAIN_RECORD_OBSERVATIONS_COLLECTION, chainRecordObservationId, provenObservationWalletId } from './chain-record-watcher';
import { HUMAN_PROVEN_ADDRESSES_COLLECTION } from '../external-address/link';

const A = '0xa11ce00000000000000000000000000000000001';
const B = '0xb0b0000000000000000000000000000000000002';
const TX1 = `0x${'11'.repeat(32)}`;
const TX2 = `0x${'22'.repeat(32)}`;
const TX3 = `0x${'33'.repeat(32)}`;
const LANDING = 900;

describe('runChainRecordMultichainScan', () => {
  let db: FakeFirestore;
  let now: number;
  let safe: number;
  let registry: MultichainRegistryEntry[];
  let resolve: jest.Mock<MultichainScanDeps['resolve']>;
  let getTransfers: jest.Mock<MultichainScanDeps['getTransfers']>;
  let blockTransactions: jest.Mock<MultichainScanDeps['blockTransactions']>;
  const deps = (): MultichainScanDeps => ({
    db: db as unknown as Firestore,
    listRegistry: async () => registry,
    resolve,
    getSafeHead: async () => safe,
    blockAtOrAfter: async () => LANDING,
    getTransfers,
    blockTransactions,
    now: () => now,
  });

  beforeEach(() => {
    db = createFakeFirestore();
    now = 1_900_000_000_000;
    safe = 1_000;
    registry = [
      { address: A, kinds: new Set(['native']) },
      { address: B, kinds: new Set(['agent_proven']) },
    ];
    resolve = jest.fn(async (entry) => entry.address === A
      ? { address: A, walletId: 'wallet_a', ownerType: 'human' as const }
      : { address: B, walletId: provenObservationWalletId(B), ownerType: 'agent' as const });
    blockTransactions = jest.fn(async () => [TX1, TX3]);
    getTransfers = jest.fn(async ({ direction, toBlock }) => ({
      transfers: direction === 'to' ? [{ hash: TX1, blockNumber: 905 }] : [{ hash: TX2, blockNumber: 910 }],
      throughBlock: toBlock,
    }));
  });

  it('first sight reads from the chain\'s landing block (nothing since the landing is skipped) up to the safe head', async () => {
    const r = await runChainRecordMultichainScan(deps());
    expect(r).toMatchObject({ watched: 2, resolved: 2, scanned: 4, queued: 8 });
    expect(getTransfers).toHaveBeenCalledWith(expect.objectContaining({ chain: 'arbitrum', fromBlock: LANDING, toBlock: 1_000 }));
    expect(db.store.get(`${CHAIN_RECORD_OBSERVATIONS_COLLECTION}/${chainRecordObservationId(TX1, 'wallet_a', 42161)}`))
      .toMatchObject({ chain_id: 42161, source: 'multichain_scan', owner_type: 'human', status: 'pending' });
    expect(db.store.get(`${CHAIN_RECORD_OBSERVATIONS_COLLECTION}/${chainRecordObservationId(TX2, provenObservationWalletId(B), 10)}`))
      .toMatchObject({ chain_id: 10 });
    expect(db.store.get(`${MULTICHAIN_SCAN_CURSORS_COLLECTION}/42161_${A}`)).toMatchObject({ next_block: 1_001 });
  });

  it('RED: a second run inside the run interval does nothing at all (no registry read)', async () => {
    await runChainRecordMultichainScan(deps());
    const listRegistry = jest.fn(async () => registry);
    now += MULTICHAIN_SCAN_RUN_INTERVAL_MS - 1;
    const r = await runChainRecordMultichainScan({ ...deps(), listRegistry });
    expect(r.skipped).toBe('ran_recently');
    expect(listRegistry).not.toHaveBeenCalled();
  });

  it('RED: an address scanned within its interval is not read again, even when the run is due', async () => {
    await runChainRecordMultichainScan(deps());
    getTransfers.mockClear();
    now += MULTICHAIN_SCAN_RUN_INTERVAL_MS;
    safe = 1_020;
    const r = await runChainRecordMultichainScan(deps());
    expect(r.scanned).toBe(0);
    expect(getTransfers).not.toHaveBeenCalled();
    now += MULTICHAIN_SCAN_INTERVAL_MS;
    expect((await runChainRecordMultichainScan(deps())).scanned).toBe(4);
  });

  it('RED: a failed read leaves the cursor at the landing and queues nothing for that address', async () => {
    getTransfers.mockRejectedValue(new Error('provider down'));
    const r = await runChainRecordMultichainScan(deps());
    expect(r.queued).toBe(0);
    expect(r.errors.length).toBe(4);
    expect(db.store.get(`${MULTICHAIN_SCAN_CURSORS_COLLECTION}/42161_${A}`)).toBeUndefined();
  });

  it('a read cut by the page bound passes only the blocks both directions read, and stays due', async () => {
    getTransfers.mockImplementation(async ({ direction, toBlock }) => ({
      transfers: [{ hash: direction === 'to' ? TX1 : TX2, blockNumber: direction === 'to' ? 905 : 950 }],
      throughBlock: direction === 'to' ? 920 : toBlock,
    }));
    await runChainRecordMultichainScan(deps());
    const cursor = db.store.get(`${MULTICHAIN_SCAN_CURSORS_COLLECTION}/42161_${A}`) as { next_block: number; scanned_at_ms: number };
    expect(cursor.next_block).toBe(921);
    expect(cursor.scanned_at_ms).toBe(0);
    expect(db.store.get(`${CHAIN_RECORD_OBSERVATIONS_COLLECTION}/${chainRecordObservationId(TX2, 'wallet_a', 42161)}`)).toBeUndefined();
    expect(db.store.get(`${CHAIN_RECORD_OBSERVATIONS_COLLECTION}/${chainRecordObservationId(TX1, 'wallet_a', 42161)}`)).toBeDefined();
  });

  it('RED (flooded block): a page bound filled inside the first block queues every transaction of that block and passes it; it never stalls', async () => {
    // One transaction emitting thousands of transfers to the address fills every page at the landing block.
    getTransfers.mockImplementation(async ({ direction }) => ({
      transfers: direction === 'to' ? [{ hash: TX1, blockNumber: LANDING }] : [],
      throughBlock: direction === 'to' ? LANDING - 1 : safe,
    }));
    await runChainRecordMultichainScan(deps(), { maxAddresses: 1 });
    expect(blockTransactions).toHaveBeenCalledWith('arbitrum', LANDING);
    const cursor = db.store.get(`${MULTICHAIN_SCAN_CURSORS_COLLECTION}/42161_${A}`) as { next_block: number };
    expect(cursor.next_block).toBe(LANDING + 1);
    // The other transaction in that block (an act the flood would have hidden) is queued.
    expect(db.store.get(`${CHAIN_RECORD_OBSERVATIONS_COLLECTION}/${chainRecordObservationId(TX3, 'wallet_a', 42161)}`)).toBeDefined();
  });

  it('RED: a flooded block too large to list is refused (the cursor stays), never skipped', async () => {
    getTransfers.mockImplementation(async ({ direction }) => ({
      transfers: [], throughBlock: direction === 'to' ? LANDING - 1 : safe,
    }));
    blockTransactions.mockResolvedValue(Array.from({ length: 5_001 }, (_, i) => `0x${i.toString(16).padStart(64, '0')}`));
    const r = await runChainRecordMultichainScan(deps(), { maxAddresses: 1 });
    expect(r.errors.map((e) => e.error)).toContain('multichain_flooded_block_too_large');
    expect(db.store.get(`${MULTICHAIN_SCAN_CURSORS_COLLECTION}/42161_${A}`)).toBeUndefined();
  });

  it('control: an ordinary read never lists a block', async () => {
    await runChainRecordMultichainScan(deps());
    expect(blockTransactions).not.toHaveBeenCalled();
  });

  it('resolves only the run\'s slice, in rotation, so every address is reached under a small cap', async () => {
    await runChainRecordMultichainScan(deps(), { maxAddresses: 1 });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0][0].address).toBe(A);
    now += MULTICHAIN_SCAN_RUN_INTERVAL_MS;
    await runChainRecordMultichainScan(deps(), { maxAddresses: 1 });
    expect(resolve.mock.calls[1][0].address).toBe(B);
  });

  it('RED: an address that does not resolve (a contract-proven one) is never scanned', async () => {
    resolve.mockImplementation(async () => null);
    const r = await runChainRecordMultichainScan(deps());
    expect(r).toMatchObject({ resolved: 0, scanned: 0 });
    expect(getTransfers).not.toHaveBeenCalled();
  });
});

describe('resolveMultichainEntry', () => {
  it('a person-proven EOA is watched under proven:<address>; a contract proof is not watched off Base', async () => {
    const db = createFakeFirestore();
    db.store.set(`${HUMAN_PROVEN_ADDRESSES_COLLECTION}/${A}`, { proof_method: 'eip191_eoa' });
    db.store.set(`${HUMAN_PROVEN_ADDRESSES_COLLECTION}/${B}`, { proof_method: 'eip1271_contract' });
    expect(await resolveMultichainEntry(db as unknown as Firestore, { address: A, kinds: new Set(['human_proven']) }))
      .toEqual({ address: A, walletId: provenObservationWalletId(A), ownerType: 'human' });
    expect(await resolveMultichainEntry(db as unknown as Firestore, { address: B, kinds: new Set(['human_proven']) })).toBeNull();
  });
});

describe('readAlchemyTransfers', () => {
  const page = (hashes: Array<[string, number]>, pageKey?: string) => ({
    transfers: hashes.map(([hash, block]) => ({ hash, blockNum: `0x${block.toString(16)}` })),
    ...(pageKey ? { pageKey } : {}),
  });
  it('reads every page and passes the whole window when the last page has no key', async () => {
    const send = jest.fn<RpcSend>()
      .mockResolvedValueOnce(page([[TX1, 10]], 'k1'))
      .mockResolvedValueOnce(page([[TX2, 12]]));
    const r = await readAlchemyTransfers(send, { address: A, direction: 'to', fromBlock: 5, toBlock: 50 });
    expect(r).toEqual({ transfers: [{ hash: TX1, blockNumber: 10 }, { hash: TX2, blockNumber: 12 }], throughBlock: 50 });
    expect((send.mock.calls[1][1][0] as Record<string, unknown>).pageKey).toBe('k1');
  });
  it('RED: cut by the page bound, it passes only the blocks before the last one seen', async () => {
    const send = jest.fn<RpcSend>().mockResolvedValue(page([[TX1, 30]], 'more'));
    const r = await readAlchemyTransfers(send, { address: A, direction: 'from', fromBlock: 5, toBlock: 50 }, 2);
    expect(r.throughBlock).toBe(29);
  });
  it('RED: a malformed reply throws (the cursor never moves past it)', async () => {
    await expect(readAlchemyTransfers(jest.fn<RpcSend>().mockResolvedValue({}), { address: A, direction: 'to', fromBlock: 1, toBlock: 2 }))
      .rejects.toThrow('multichain_discovery_reply_invalid');
    await expect(readAlchemyTransfers(jest.fn<RpcSend>().mockResolvedValue(page([[TX1, 1]]).transfers.length ? { transfers: [{ hash: TX1 }] } : {}), { address: A, direction: 'to', fromBlock: 1, toBlock: 2 }))
      .rejects.toThrow('multichain_discovery_transfer_invalid');
  });
});

describe('findBlockAtOrAfter', () => {
  const chain: RpcSend = async (_m, params) => ({ timestamp: `0x${(1_000 + Number(BigInt(params[0] as string)) * 2).toString(16)}` });
  it('finds the first block at or after the instant', async () => {
    // block n has timestamp 1000 + 2n seconds; 1101 s → first block at or after is n = 51 (1102 s).
    expect(await findBlockAtOrAfter(chain, 1_101_000, 500)).toBe(51);
    expect(await findBlockAtOrAfter(chain, 1_100_000, 500)).toBe(50);
  });
  it('an instant past the high block is high + 1', async () => {
    expect(await findBlockAtOrAfter(chain, 9_999_999_000, 500)).toBe(501);
  });
});
