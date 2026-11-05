/**
 * the inbound scan finds non-USDC transfers to watched native wallets and
 * queues them, as pointers, into the chain-record lane. It mints nothing itself.
 * Each RED case differs from a GREEN case in the one variable the guard reads
 *; every pass prints what it evaluated (`logs_seen`, `queued`).
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import { transferLog } from './__test-helpers__/base-transaction-evidence';
import { BASE_USDC_ADDRESS, type CanonicalEconomicLog, type InternalEthTransferPointer, type NativeTransferPointer } from '../onchain/economic-discovery';
import {
  CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID,
  CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION,
  CHAIN_RECORD_SCAN_SET_ASIDE_COLLECTION,
  buildChainRecordInboundScanDeps,
  runChainRecordInboundScan,
  type ChainRecordInboundScanDeps,
  type ChainRecordScanWallet,
} from './chain-record-inbound-scan';
import { CHAIN_RECORD_OBSERVATIONS_COLLECTION, chainRecordObservationId } from './chain-record-watcher';
import { NATIVE_WALLET_ADDRESS_INDEX_COLLECTION, nativeWalletAddressIndexId } from './native-wallet-registration';
import { HUMAN_PROVEN_ADDRESSES_COLLECTION, PROVEN_ADDRESSES_COLLECTION } from '../external-address/link';
import { HUMAN_PROVEN_ADDRESS_SCHEMA } from '../external-address/human-link';
import { provenObservationWalletId } from './chain-record-watcher';
import crypto from 'crypto';

const LEGACY_LOOKBACK_BLOCKS = 900; // Two-second fixture for the thirty-minute initial window.
const HUMAN = '0xa11ce00000000000000000000000000000000001';
const AGENT = '0xa9e7700000000000000000000000000000000002';
const STRANGER = '0x5000000000000000000000000000000000000005';
const DAI = '0x50c5725949a6f0c72e6c4a641f24049a917db0cb';
const ZERO = `0x${'0'.repeat(40)}`;
const HEAD = 10_000;
const FINAL = HEAD - 12;

const wallets: ChainRecordScanWallet[] = [
  { address: HUMAN, walletId: 'hw1', ownerType: 'human', eligibilityStartBlock: 0 },
  { address: AGENT, walletId: 'aw1', ownerType: 'agent', eligibilityStartBlock: 0 },
];

function at(block: number, log: CanonicalEconomicLog): CanonicalEconomicLog {
  return { ...log, blockNumber: block };
}
const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

describe('runChainRecordInboundScan', () => {
  let db: FakeFirestore;
  let chainLogs: CanonicalEconomicLog[];
  let calls: Array<{ fromBlock: number; toBlock: number; toAddresses: readonly string[] }>;
  let failAt: number | null;
  const deps = (over: Partial<ChainRecordInboundScanDeps> = {}): ChainRecordInboundScanDeps => ({
    db: db as unknown as Firestore,
    getHead: async () => HEAD,
    initialFromBlock: async head => Math.max(0, head - LEGACY_LOOKBACK_BLOCKS),
    getLogs: async (args) => {
      calls.push(args);
      if (failAt !== null && args.fromBlock <= failAt && failAt <= args.toBlock) throw new Error('rpc_down');
      return chainLogs.filter((l) => l.blockNumber >= args.fromBlock && l.blockNumber <= args.toBlock);
    },
    listWallets: async () => wallets,
    now: () => 1,
    ...over,
  });
  const obs = (txHash: string, walletId: string) => db.store.get(
    `${CHAIN_RECORD_OBSERVATIONS_COLLECTION}/${chainRecordObservationId(txHash, walletId)}`,
  ) as Record<string, unknown> | undefined;
  const checkpoint = () => (db.store.get(
    `${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID}`,
  ) as { next_block: number } | undefined)?.next_block;

  beforeEach(() => {
    db = createFakeFirestore();
    chainLogs = [];
    calls = [];
    failAt = null;
  });

  it('first run starts a short lookback behind the finalized head and queues a stranger\'s DAI to the human', async () => {
    const block = FINAL - 5;
    chainLogs = [at(block, transferLog(tx(1), DAI, STRANGER, HUMAN, 5n, 0))];
    const r = await runChainRecordInboundScan(deps(), { maxLogCalls: 10_000 });
    expect(r).toMatchObject({ from_block: FINAL - LEGACY_LOOKBACK_BLOCKS, to_block: FINAL, logs_seen: 1, queued: 1 });
    expect(obs(tx(1), 'hw1')).toMatchObject({ status: 'pending', source: 'inbound_scan', owner_type: 'human', record_pe_id: null });
    expect(checkpoint()).toBe(FINAL + 1);
  });

  it('queues an agent recipient as an agent observation (no owner_type field)', async () => {
    chainLogs = [at(FINAL - 1, transferLog(tx(2), DAI, STRANGER, AGENT, 5n, 0))];
    await runChainRecordInboundScan(deps(), { maxLogCalls: 10_000 });
    const doc = obs(tx(2), 'aw1');
    expect(doc).toMatchObject({ source: 'inbound_scan' });
    expect(doc && 'owner_type' in doc).toBe(false);
  });

  it('RED: a mint from the zero address, a USDC log, an unwatched recipient and a zero amount are not queued', async () => {
    chainLogs = [
      at(FINAL - 4, transferLog(tx(3), DAI, ZERO, HUMAN, 5n, 0)),
      at(FINAL - 3, transferLog(tx(4), BASE_USDC_ADDRESS, STRANGER, HUMAN, 5n, 0)),
      at(FINAL - 2, transferLog(tx(5), DAI, STRANGER, `0x${'9'.repeat(40)}`, 5n, 0)),
      at(FINAL - 1, transferLog(tx(6), DAI, STRANGER, HUMAN, 0n, 0)),
    ];
    const r = await runChainRecordInboundScan(deps(), { maxLogCalls: 10_000 });
    expect(r).toMatchObject({ logs_seen: 4, queued: 0, skipped: 4 });
    expect([...db.store.keys()].filter((k) => k.startsWith(CHAIN_RECORD_OBSERVATIONS_COLLECTION))).toHaveLength(0);
  });

  it('RED: a transfer below the wallet\'s registration fence is not queued', async () => {
    chainLogs = [at(FINAL - 1, transferLog(tx(7), DAI, STRANGER, HUMAN, 5n, 0))];
    const r = await runChainRecordInboundScan(deps({
      listWallets: async () => [{ address: HUMAN, walletId: 'hw1', ownerType: 'human', eligibilityStartBlock: FINAL }],
    }), { maxLogCalls: 10_000 });
    expect(r).toMatchObject({ logs_seen: 1, queued: 0 });
  });

  it('a second run resumes at the checkpoint; a log seen twice is queued once', async () => {
    chainLogs = [at(FINAL - 1, transferLog(tx(8), DAI, STRANGER, HUMAN, 5n, 0))];
    await runChainRecordInboundScan(deps(), { maxLogCalls: 10_000 });
    db.store.set(`${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID}`, {
      schema_version: 'chain-record-inbound-scan-checkpoint/v1', next_block: FINAL - 3, updated_at_ms: 1,
    });
    const r = await runChainRecordInboundScan(deps(), { maxLogCalls: 10_000 });
    expect(r).toMatchObject({ from_block: FINAL - 3, queued: 0, already_queued: 1 });
  });

  it('budget: whole windows only — the cursor stops at the last fully-scanned window', async () => {
    db.store.set(`${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID}`, {
      schema_version: 'chain-record-inbound-scan-checkpoint/v1', next_block: 1000, updated_at_ms: 1,
    });
    const r = await runChainRecordInboundScan(deps(), { maxLogCalls: 3, blockChunk: 10, addressBatch: 1 });
    // two wallets → two calls per window; a budget of 3 covers exactly one window.
    expect(r).toMatchObject({ budget_stopped: true, log_calls_used: 2, to_block: 1009 });
    expect(checkpoint()).toBe(1010);
  });

  it('RED: a failed read mid-run keeps the cursor at the last complete window and reports the error', async () => {
    db.store.set(`${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID}`, {
      schema_version: 'chain-record-inbound-scan-checkpoint/v1', next_block: 1000, updated_at_ms: 1,
    });
    failAt = 1025;
    const r = await runChainRecordInboundScan(deps(), { maxLogCalls: 10_000, blockChunk: 10 });
    expect(r).toMatchObject({ error: 'rpc_down', to_block: 1019 });
    expect(checkpoint()).toBe(1020);
  });

  it('an address claimed twice is SET ASIDE (never guessed) and every other wallet keeps scanning', async () => {
    db.store.set(`${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID}`, {
      schema_version: 'chain-record-inbound-scan-checkpoint/v1', next_block: FINAL - 5, updated_at_ms: 1,
    });
    chainLogs = [
      at(FINAL - 2, transferLog(tx(20), DAI, STRANGER, HUMAN, 5n, 0)),
      at(FINAL - 2, transferLog(tx(21), DAI, STRANGER, AGENT, 5n, 0)),
    ];
    const r = await runChainRecordInboundScan(deps({
      listWallets: async () => [...wallets, { address: HUMAN, walletId: 'aw9', ownerType: 'agent', eligibilityStartBlock: 0 }],
    }), { maxLogCalls: 10_000 });
    expect(r.set_aside).toEqual([{ key: `contested_${HUMAN}`, reason: 'chain_record_scan_wallet_contested', address: HUMAN }]);
    expect(obs(tx(21), 'aw1')).toBeDefined(); // the uncontested wallet flowed
    expect(obs(tx(20), 'hw1')).toBeUndefined(); // neither claimant gets the contested address's log
    expect(obs(tx(20), 'aw9')).toBeUndefined();
    expect(checkpoint()).toBe(FINAL + 1);
    for (const call of calls) expect(call.toAddresses).not.toContain(HUMAN);
  });

  it('RED (review r1 defect 2): a wallet list that fails to load stops the run — no block is passed unasked', async () => {
    db.store.set(`${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID}`, {
      schema_version: 'chain-record-inbound-scan-checkpoint/v1', next_block: 1000, updated_at_ms: 1,
    });
    await expect(runChainRecordInboundScan(deps({ listWallets: async () => { throw new Error('firestore_unavailable'); } })))
      .rejects.toThrow('firestore_unavailable');
    expect(checkpoint()).toBe(1000);
  });

  it('RED: a malformed checkpoint is an integrity fault, never a guess', async () => {
    db.store.set(`${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID}`, { next_block: 'x' });
    await expect(runChainRecordInboundScan(deps())).rejects.toThrow('chain_record_scan_checkpoint_invalid');
  });

  it('RED: a log the provider returns outside the requested window stops the run (cursor not advanced past it)', async () => {
    db.store.set(`${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID}`, {
      schema_version: 'chain-record-inbound-scan-checkpoint/v1', next_block: 1000, updated_at_ms: 1,
    });
    const r = await runChainRecordInboundScan(deps({
      getLogs: async (args) => (args.fromBlock === 1010 ? [at(5, transferLog(tx(10), DAI, STRANGER, HUMAN, 5n, 0))] : []),
    }), { maxLogCalls: 10_000, blockChunk: 10 });
    expect(r).toMatchObject({ error: 'chain_record_scan_log_out_of_range', to_block: 1009 });
  });
});

describe('a malformed index row never stops the scan for everyone (, open item)', () => {
  let db: FakeFirestore;
  let chainLogs: CanonicalEconomicLog[];
  const row = (address: string, walletId: string, ownerType: 'agent' | 'human') => ({
    schema_version: 'native-wallet-address-index/v1', chain_id: 8453, address,
    wallet_id: walletId, owner_type: ownerType, owner_id: `${walletId}_owner`, created_at_ms: 1,
  });
  const humanKey = () => `${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(HUMAN)}`;
  const prodDeps = (): ChainRecordInboundScanDeps => ({
    ...buildChainRecordInboundScanDeps(db as unknown as Firestore),
    // Legacy enumeration seams remain covered for held-row repair regressions.
    getCompactWindow: undefined,
    initialFromBlock: async head => Math.max(0, head - LEGACY_LOOKBACK_BLOCKS),
    // The listing path (registry mode has its own suite).
    useRegistry: false,
    getHead: async () => HEAD,
    getLogs: async (args) => chainLogs.filter((l) => l.blockNumber >= args.fromBlock && l.blockNumber <= args.toBlock
      && args.toAddresses.includes(`0x${l.topics[2].slice(-40)}`)),
    // No native transfers in these fixtures; the production reader is never reached.
    getNativeTransfers: async () => [],
    getInternalTransfers: async () => [],
    now: () => 1,
  });
  const setCheckpoint = (next: number) => db.store.set(`${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID}`, {
    schema_version: 'chain-record-inbound-scan-checkpoint/v1', next_block: next, updated_at_ms: 1,
  });
  const obs = (txHash: string, walletId: string) => db.store.get(
    `${CHAIN_RECORD_OBSERVATIONS_COLLECTION}/${chainRecordObservationId(txHash, walletId)}`,
  );
  const heldDocs = () => [...db.store.entries()].filter(([k]) => k.startsWith(`${CHAIN_RECORD_SCAN_SET_ASIDE_COLLECTION}/`));

  beforeEach(() => {
    db = createFakeFirestore();
    chainLogs = [];
    db.store.set(humanKey(), { ...row(HUMAN, 'hw1', 'human'), owner_type: 'robot' }); // malformed
    db.store.set(`${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(AGENT)}`, row(AGENT, 'aw1', 'agent'));
  });

  it('NEGATIVE CONTROL: the malformed row is set aside and visible; every other wallet\'s receives keep scanning', async () => {
    setCheckpoint(FINAL - 30);
    chainLogs = [
      at(FINAL - 20, transferLog(tx(30), DAI, STRANGER, AGENT, 5n, 0)),
      at(FINAL - 20, transferLog(tx(31), DAI, STRANGER, HUMAN, 5n, 0)),
    ];
    const r = await runChainRecordInboundScan(prodDeps(), { maxLogCalls: 10_000 });
    expect(r.error).toBeNull();
    expect(r.watched_wallets).toBe(1);
    expect(r.set_aside).toHaveLength(1);
    expect(r.set_aside[0]).toMatchObject({ key: nativeWalletAddressIndexId(HUMAN), address: HUMAN });
    expect(r.set_aside[0].reason).toContain('watched_address_enumeration_invalid');
    expect(obs(tx(30), 'aw1')).toBeDefined(); // the healthy wallet's receive flowed
    expect(r).toMatchObject({ to_block: FINAL });
    // Visible to the operator: one held record naming the range the scan passed without it.
    const held = heldDocs();
    expect(held).toHaveLength(1);
    expect(held[0][1]).toMatchObject({ address: HUMAN, held_from_block: FINAL - 30, held_through_block: FINAL });
  });

  it('a repaired row is BACKFILLED over exactly its held range, then released', async () => {
    setCheckpoint(FINAL - 30);
    chainLogs = [at(FINAL - 20, transferLog(tx(32), DAI, STRANGER, HUMAN, 5n, 0))];
    await runChainRecordInboundScan(prodDeps(), { maxLogCalls: 10_000 });
    expect(obs(tx(32), 'hw1')).toBeUndefined(); // held, not guessed

    db.store.set(humanKey(), row(HUMAN, 'hw1', 'human')); // the operator repairs it
    const r = await runChainRecordInboundScan(prodDeps(), { maxLogCalls: 10_000 });
    expect(r.set_aside).toHaveLength(0);
    expect(r.backfill_windows).toBeGreaterThan(0);
    expect(r.released).toBe(1);
    expect(obs(tx(32), 'hw1')).toMatchObject({ source: 'inbound_scan', owner_type: 'human' });
    expect(heldDocs()).toHaveLength(0);
  });

  it('a backfill that runs out of budget resumes where it stopped and releases only when complete', async () => {
    setCheckpoint(FINAL - 30);
    chainLogs = [at(FINAL - 3, transferLog(tx(33), DAI, STRANGER, HUMAN, 5n, 0))];
    await runChainRecordInboundScan(prodDeps(), { maxLogCalls: 10_000, blockChunk: 10 });
    db.store.set(humanKey(), row(HUMAN, 'hw1', 'human'));
    // Nothing new to scan in the main pass; 1 backfill window only (1 log call +
    // 10 native block reads + 1 trace call = 12, since 2026-10-01 native ETH and
    // trace discovery).
    const r1 = await runChainRecordInboundScan(prodDeps(), { maxLogCalls: 12, blockChunk: 10 });
    expect(r1).toMatchObject({ backfill_windows: 1, released: 0, budget_stopped: true });
    expect(heldDocs()).toHaveLength(1);
    const r2 = await runChainRecordInboundScan(prodDeps(), { maxLogCalls: 10_000, blockChunk: 10 });
    expect(r2.released).toBe(1);
    expect(obs(tx(33), 'hw1')).toBeDefined();
  });

  it('RED: with the set-aside removed (the old throw), the healthy wallet\'s receive is never queued', async () => {
    setCheckpoint(FINAL - 30);
    chainLogs = [at(FINAL - 20, transferLog(tx(34), DAI, STRANGER, AGENT, 5n, 0))];
    const throwing: ChainRecordInboundScanDeps = {
      ...prodDeps(),
      listWallets: async () => {
        const listed = await prodDeps().listWallets();
        if (listed.some((r) => 'setAside' in r)) throw new Error('watched_address_enumeration_invalid');
        return listed;
      },
    };
    await expect(runChainRecordInboundScan(throwing, { maxLogCalls: 10_000 })).rejects.toThrow();
    expect(obs(tx(34), 'aw1')).toBeUndefined();
  });

  it('a held row whose address left the index is released without a backfill', async () => {
    setCheckpoint(FINAL - 30);
    await runChainRecordInboundScan(prodDeps(), { maxLogCalls: 10_000 });
    db.store.delete(humanKey());
    const r = await runChainRecordInboundScan(prodDeps(), { maxLogCalls: 10_000 });
    expect(r).toMatchObject({ released: 1, backfill_windows: 0 });
    expect(heldDocs()).toHaveLength(0);
  });

  it('RED: a malformed set-aside record is an integrity fault (never silently drops a held range)', async () => {
    setCheckpoint(FINAL - 30);
    db.store.set(`${CHAIN_RECORD_SCAN_SET_ASIDE_COLLECTION}/x`, { schema_version: 'nope' });
    await expect(runChainRecordInboundScan(prodDeps(), { maxLogCalls: 10_000 })).rejects.toThrow('chain_record_scan_set_aside_invalid');
  });
});

describe('buildChainRecordInboundScanDeps — the wallet list is the canonical index itself (review r1 defect 2)', () => {
  const row = (address: string, walletId: string, ownerType: 'agent' | 'human') => ({
    schema_version: 'native-wallet-address-index/v1', chain_id: 8453, address,
    wallet_id: walletId, owner_type: ownerType, owner_id: `${walletId}_owner`, created_at_ms: 1,
  });

  it('every index row is watched — with no per-wallet read, so a missing or unreadable wallet doc cannot drop it', async () => {
    const db = createFakeFirestore();
    db.store.set(`${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(HUMAN)}`, row(HUMAN, 'hw1', 'human'));
    db.store.set(`${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(AGENT)}`, row(AGENT, 'aw1', 'agent'));
    // Neither wallet doc exists: the scan still watches both addresses (the lane resolves later).
    const listed = await buildChainRecordInboundScanDeps(db as unknown as Firestore).listWallets();
    expect([...listed as ChainRecordScanWallet[]].sort((a, b) => a.walletId.localeCompare(b.walletId))).toEqual([
      { address: AGENT, walletId: 'aw1', ownerType: 'agent', eligibilityStartBlock: 0, key: nativeWalletAddressIndexId(AGENT) },
      { address: HUMAN, walletId: 'hw1', ownerType: 'human', eligibilityStartBlock: 0, key: nativeWalletAddressIndexId(HUMAN) },
    ]);
  });

  it('a malformed index row is listed SET ASIDE with its reason (never thrown)', async () => {
    const db = createFakeFirestore();
    db.store.set(`${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(HUMAN)}`, { ...row(HUMAN, 'hw1', 'human'), owner_type: 'robot' });
    const listed = await buildChainRecordInboundScanDeps(db as unknown as Firestore).listWallets();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ setAside: true, key: nativeWalletAddressIndexId(HUMAN), address: HUMAN });
    expect((listed[0] as { reason: string }).reason).toContain('watched_address_enumeration_invalid:native_address_index');
  });
});

describe('2026-10-01 — proven external addresses (a person\'s and an agent\'s) are watched from their proof fence', () => {
  const P = '0xbeef00000000000000000000000000000000000b';
  const Q = '0xdead00000000000000000000000000000000000d';
  const sha = (v: string) => `sha256:${crypto.createHash('sha256').update(v).digest('hex')}`;
  const proof = (provenAt: number) => ({
    economic_eligibility: 'active_go_forward_only', proven_at_ms: 1_000, proven_at_block: provenAt,
    proof_observed_head_block: provenAt - 1, proof_block_number: provenAt - 12, proof_block_hash: `0x${'ab'.repeat(32)}`,
    proof_min_confirmations: 12, proof_rpc_operator_ids: ['op-a', 'op-b'], chain: 'base', chain_id: 8453,
    proof_method: 'eip191_eoa', signature_hash: sha('s'),
    proof_evidence: {
      schema_version: 'external-address-control-proof/v1', challenge_id_sha256: sha('c'), challenge_message_sha256: sha('m'),
      signature_sha256: sha('s'), proof_method: 'eip191_eoa', verified_at_ms: 1_000,
    },
    initial_reputation_tier: 0, baseline_nonce: 0, created_at: 1_000,
  });

  it('lists both registries under `proven:<address>` with their owner and fence; queues an inbound DAI for each', async () => {
    const db = createFakeFirestore();
    db.store.set(`${HUMAN_PROVEN_ADDRESSES_COLLECTION}/${P}`, { schema_version: HUMAN_PROVEN_ADDRESS_SCHEMA, address: P, user_id: 'u1', wallet_id: 'hw1', ...proof(FINAL - 50) });
    db.store.set(`${PROVEN_ADDRESSES_COLLECTION}/${Q}`, { schema_version: 'proven-address/v2', address: Q, agent_id: 'a1', wallet_id: 'wA', ...proof(FINAL - 50) });
    const prod = { ...buildChainRecordInboundScanDeps(db as unknown as Firestore), getCompactWindow: undefined, initialFromBlock: async (head: number) => Math.max(0, head - LEGACY_LOOKBACK_BLOCKS) };
    const listed = await prod.listWallets();
    expect(listed).toEqual(expect.arrayContaining([
      { address: P, walletId: provenObservationWalletId(P), ownerType: 'human', eligibilityStartBlock: FINAL - 50, key: `person_proven_${P}`, proofMethod: 'eip191_eoa' },
      { address: Q, walletId: provenObservationWalletId(Q), ownerType: 'agent', eligibilityStartBlock: FINAL - 50, key: `proven_${Q}`, proofMethod: 'eip191_eoa' },
    ]));
    db.store.set(`${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID}`, {
      schema_version: 'chain-record-inbound-scan-checkpoint/v1', next_block: FINAL - 100, updated_at_ms: 1,
    });
    const logs = [
      at(FINAL - 10, transferLog(tx(40), DAI, STRANGER, P, 5n, 0)),
      at(FINAL - 10, transferLog(tx(41), DAI, STRANGER, Q, 5n, 0)),
      // RED twin: before the proof fence — not queued.
      at(FINAL - 60, transferLog(tx(42), DAI, STRANGER, P, 5n, 0)),
    ];
    const r = await runChainRecordInboundScan({
      ...prod,
      useRegistry: false,
      getHead: async () => HEAD,
    initialFromBlock: async head => Math.max(0, head - LEGACY_LOOKBACK_BLOCKS),
      getLogs: async (a) => logs.filter((l) => l.blockNumber >= a.fromBlock && l.blockNumber <= a.toBlock),
      getNativeTransfers: async () => [],
      getInternalTransfers: async () => [],
      now: () => 1,
    }, { maxLogCalls: 10_000 });
    expect(r.queued).toBe(2);
    const obsOf = (t: string, w: string) => db.store.get(`${CHAIN_RECORD_OBSERVATIONS_COLLECTION}/${chainRecordObservationId(t, provenObservationWalletId(w))}`);
    expect(obsOf(tx(40), P)).toMatchObject({ owner_type: 'human', source: 'inbound_scan' });
    expect(obsOf(tx(41), Q)).toMatchObject({ source: 'inbound_scan' });
    expect(obsOf(tx(42), P)).toBeUndefined();
  });

  it('RED: a proven row that does not validate is SET ASIDE, never watched and never fatal', async () => {
    const db = createFakeFirestore();
    db.store.set(`${HUMAN_PROVEN_ADDRESSES_COLLECTION}/${P}`, { schema_version: HUMAN_PROVEN_ADDRESS_SCHEMA, address: P, user_id: 'u1', wallet_id: 'hw1', ...proof(FINAL - 50), proven_at_block: 7 });
    const listed = await buildChainRecordInboundScanDeps(db as unknown as Firestore).listWallets();
    expect(listed).toEqual([{ setAside: true, key: `person_proven_${P}`, reason: `person_proven_address_invalid:${P}`, address: P }]);
  });
});

describe('2026-10-01 — native ETH receives are discovered from full blocks (carves out no asset)', () => {
  let db: FakeFirestore;
  let natives: NativeTransferPointer[];
  let nativeCalls: Array<{ fromBlock: number; toBlock: number; toAddresses: ReadonlySet<string> }>;
  let nativeFailAt: number | null;
  const eth = (hash: string, block: number, from: string, to: string, valueWei = '1000'): NativeTransferPointer =>
    ({ transactionHash: hash, blockNumber: block, fromAddress: from, toAddress: to, valueWei });
  const deps = (over: Partial<ChainRecordInboundScanDeps> = {}): ChainRecordInboundScanDeps => ({
    db: db as unknown as Firestore,
    getHead: async () => HEAD,
    initialFromBlock: async head => Math.max(0, head - LEGACY_LOOKBACK_BLOCKS),
    getLogs: async () => [],
    getNativeTransfers: async (args) => {
      nativeCalls.push(args);
      if (nativeFailAt !== null && args.fromBlock <= nativeFailAt && nativeFailAt <= args.toBlock) throw new Error('native_rpc_down');
      return natives.filter((t) => t.blockNumber >= args.fromBlock && t.blockNumber <= args.toBlock && args.toAddresses.has(t.toAddress));
    },
    listWallets: async () => wallets,
    now: () => 1,
    ...over,
  });
  const obs = (txHash: string, walletId: string) => db.store.get(
    `${CHAIN_RECORD_OBSERVATIONS_COLLECTION}/${chainRecordObservationId(txHash, walletId)}`,
  ) as Record<string, unknown> | undefined;
  const checkpointAt = (next: number) => db.store.set(`${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID}`, {
    schema_version: 'chain-record-inbound-scan-checkpoint/v1', next_block: next, updated_at_ms: 1,
  });
  const checkpoint = () => (db.store.get(
    `${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID}`,
  ) as { next_block: number } | undefined)?.next_block;

  beforeEach(() => {
    db = createFakeFirestore();
    natives = [];
    nativeCalls = [];
    nativeFailAt = null;
  });

  it('same 1,500 full blocks and durable native observations; paid windows cut log requests from 150 to 3', async () => {
    natives = [eth(tx(160), 1003, STRANGER, HUMAN), eth(tx(161), 2490, STRANGER, AGENT)];
    checkpointAt(1000);
    const old = await runChainRecordInboundScan(deps({getHead:async()=>2511}),{maxLogCalls:10000,blockChunk:10});
    const expected = new Map(db.store);
    expect(nativeCalls.reduce((sum,c)=>sum+c.toBlock-c.fromBlock+1,0)).toBe(1500);
    db=createFakeFirestore();nativeCalls=[];checkpointAt(1000);
    const current=await runChainRecordInboundScan(deps({getHead:async()=>2511}),{maxLogCalls:10000});
    expect(new Map(db.store)).toEqual(expected);
    expect(current.queued).toBe(old.queued);expect(current.queued).toBe(2);
    expect(nativeCalls.reduce((sum,c)=>sum+c.toBlock-c.fromBlock+1,0)).toBe(1500);
    expect(old.log_calls_used-1500).toBe(150);expect(current.log_calls_used-1500).toBe(3);
  });

  it('queues a plain ETH transfer into a watched human and a watched agent, as `inbound_scan` pointers', async () => {
    natives = [eth(tx(60), FINAL - 3, STRANGER, HUMAN), eth(tx(61), FINAL - 2, STRANGER, AGENT)];
    const r = await runChainRecordInboundScan(deps(), { maxLogCalls: 10_000 });
    expect(r).toMatchObject({ native_transfers_seen: 2, queued: 2, error: null });
    expect(obs(tx(60), 'hw1')).toMatchObject({ source: 'inbound_scan', owner_type: 'human', status: 'pending' });
    expect(obs(tx(61), 'aw1')).toMatchObject({ source: 'inbound_scan' });
    // Every window asked for the watched set, nothing else.
    for (const call of nativeCalls) expect([...call.toAddresses].sort()).toEqual([AGENT, HUMAN].sort());
  });

  it('RED: the wallet paying itself, an excluded sender, a zero value and a transfer below the fence are not queued', async () => {
    natives = [
      eth(tx(62), FINAL - 4, HUMAN, HUMAN),
      eth(tx(63), FINAL - 3, ZERO, HUMAN),
      eth(tx(64), FINAL - 2, STRANGER, HUMAN, '0'),
      eth(tx(65), FINAL - 1, STRANGER, AGENT),
    ];
    const r = await runChainRecordInboundScan(deps({
      listWallets: async () => [wallets[0], { ...wallets[1], eligibilityStartBlock: FINAL }],
    }), { maxLogCalls: 10_000 });
    expect(r).toMatchObject({ native_transfers_seen: 4, queued: 0, skipped: 4 });
    // GREEN twin of the last one: at the fence it is queued.
    natives = [eth(tx(66), FINAL, STRANGER, AGENT)];
    checkpointAt(FINAL);
    const g = await runChainRecordInboundScan(deps({
      listWallets: async () => [wallets[0], { ...wallets[1], eligibilityStartBlock: FINAL }],
    }), { maxLogCalls: 10_000 });
    expect(g.queued).toBe(1);
  });

  it('RED: a failed native read holds the cursor at the last complete window — no block is passed unread', async () => {
    checkpointAt(1000);
    natives = [eth(tx(67), 1003, STRANGER, HUMAN)];
    nativeFailAt = 1025;
    const r = await runChainRecordInboundScan(deps(), { maxLogCalls: 10_000, blockChunk: 10 });
    expect(r).toMatchObject({ error: 'native_rpc_down', to_block: 1019 });
    expect(checkpoint()).toBe(1020);
    expect(obs(tx(67), 'hw1')).toBeDefined();
  });

  it('budget: a native window costs one call per block, and only whole windows are taken', async () => {
    checkpointAt(1000);
    // one address batch (1 call) + 10 blocks (10 calls) = 11 per window; a budget of 25 covers two windows.
    const r = await runChainRecordInboundScan(deps(), { maxLogCalls: 25, blockChunk: 10 });
    expect(r).toMatchObject({ budget_stopped: true, log_calls_used: 25, to_block: 1021 });
    expect(checkpoint()).toBe(1022);
  });

  it('RED: the wall-clock guard stops the scan at a whole window', async () => {
    checkpointAt(1000);
    let t = 0;
    const r = await runChainRecordInboundScan(deps({ clock: () => { t += 50; return t; } }), { maxLogCalls: 10_000, blockChunk: 10, maxScanMs: 120 });
    expect(r.budget_stopped).toBe(true);
    expect(r.to_block).toBeLessThan(FINAL);
    expect(checkpoint()).toBe(r.to_block + 1);
  });

  it('a set-aside row repaired later is BACKFILLED for native transfers over its held range too', async () => {
    checkpointAt(1000);
    // Run 1: the human's row is malformed (set aside) while ETH arrives for it.
    natives = [eth(tx(68), 1005, STRANGER, HUMAN)];
    await runChainRecordInboundScan(deps({
      listWallets: async () => [{ setAside: true, key: 'k_human', reason: 'malformed', address: HUMAN }, wallets[1]],
    }), { maxLogCalls: 10_000, blockChunk: 10 });
    expect(obs(tx(68), 'hw1')).toBeUndefined();
    // Run 2: repaired — the backfill finds the ETH it missed.
    const r = await runChainRecordInboundScan(deps({
      listWallets: async () => [{ ...wallets[0], key: 'k_human' }, wallets[1]],
    }), { maxLogCalls: 10_000, blockChunk: 10 });
    expect(r.released).toBe(1);
    expect(obs(tx(68), 'hw1')).toMatchObject({ source: 'inbound_scan', owner_type: 'human' });
  });

  it('RED: a native pointer outside the requested window stops the run', async () => {
    checkpointAt(1000);
    const r = await runChainRecordInboundScan(deps({
      getNativeTransfers: async (a) => (a.fromBlock === 1010 ? [eth(tx(69), 5, STRANGER, HUMAN)] : []),
    }), { maxLogCalls: 10_000, blockChunk: 10 });
    expect(r).toMatchObject({ error: 'chain_record_scan_native_out_of_range', to_block: 1009 });
  });

  it('without a native reader the scan is byte-for-byte the log scan (no native calls, no native cost)', async () => {
    checkpointAt(1000);
    const r = await runChainRecordInboundScan(deps({ getNativeTransfers: undefined }), { maxLogCalls: 3, blockChunk: 10, addressBatch: 1 });
    expect(r).toMatchObject({ log_calls_used: 2, to_block: 1009, native_transfers_seen: 0 });
  });
});

describe('2026-10-01 — ETH that arrives inside a transaction is discovered from the trace (the operator: internal transfers mint)', () => {
  let db: FakeFirestore;
  let traced: InternalEthTransferPointer[];
  let traceCalls: Array<{ fromBlock: number; toBlock: number; toAddresses: readonly string[] }>;
  let traceFailAt: number | null;
  const inner = (hash: string, block: number, from: string, to: string, valueWei = '1000'): InternalEthTransferPointer =>
    ({ transactionHash: hash, blockNumber: block, fromAddress: from, toAddress: to, valueWei });
  const SMART_WALLET = '0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a';
  const deps = (over: Partial<ChainRecordInboundScanDeps> = {}): ChainRecordInboundScanDeps => ({
    db: db as unknown as Firestore,
    getHead: async () => HEAD,
    initialFromBlock: async head => Math.max(0, head - LEGACY_LOOKBACK_BLOCKS),
    getLogs: async () => [],
    getNativeTransfers: async () => [],
    getInternalTransfers: async (args) => {
      traceCalls.push(args);
      if (traceFailAt !== null && args.fromBlock <= traceFailAt && traceFailAt <= args.toBlock) throw new Error('trace_rpc_down');
      return traced.filter((t) => t.blockNumber >= args.fromBlock && t.blockNumber <= args.toBlock && args.toAddresses.includes(t.toAddress));
    },
    listWallets: async () => wallets,
    now: () => 1,
    ...over,
  });
  const obs = (txHash: string, walletId: string) => db.store.get(
    `${CHAIN_RECORD_OBSERVATIONS_COLLECTION}/${chainRecordObservationId(txHash, walletId)}`,
  ) as Record<string, unknown> | undefined;
  const checkpointAt = (next: number) => db.store.set(`${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID}`, {
    schema_version: 'chain-record-inbound-scan-checkpoint/v1', next_block: next, updated_at_ms: 1,
  });
  const checkpoint = () => (db.store.get(
    `${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID}`,
  ) as { next_block: number } | undefined)?.next_block;

  beforeEach(() => {
    db = createFakeFirestore();
    traced = [];
    traceCalls = [];
    traceFailAt = null;
  });

  it('queues ETH a smart wallet sent inside another transaction into a watched human and agent, as `inbound_scan` pointers', async () => {
    traced = [inner(tx(80), FINAL - 3, SMART_WALLET, HUMAN), inner(tx(81), FINAL - 2, SMART_WALLET, AGENT)];
    const r = await runChainRecordInboundScan(deps(), { maxLogCalls: 10_000 });
    expect(r).toMatchObject({ internal_transfers_seen: 2, queued: 2, error: null });
    expect(obs(tx(80), 'hw1')).toMatchObject({ source: 'inbound_scan', owner_type: 'human', status: 'pending' });
    expect(obs(tx(81), 'aw1')).toMatchObject({ source: 'inbound_scan', status: 'pending' });
    // Every trace call asked for the watched addresses, nothing else.
    for (const call of traceCalls) expect([...call.toAddresses].sort()).toEqual([AGENT, HUMAN].sort());
  });

  it('RED: the wallet paying itself, an excluded sender, a zero value and a movement below the fence are not queued', async () => {
    traced = [
      inner(tx(82), FINAL - 4, HUMAN, HUMAN),
      inner(tx(83), FINAL - 3, ZERO, HUMAN),
      inner(tx(84), FINAL - 2, SMART_WALLET, HUMAN, '0'),
      inner(tx(85), FINAL - 1, SMART_WALLET, AGENT),
    ];
    const fenced = async () => [wallets[0], { ...wallets[1], eligibilityStartBlock: FINAL }];
    const r = await runChainRecordInboundScan(deps({ listWallets: fenced }), { maxLogCalls: 10_000 });
    expect(r).toMatchObject({ internal_transfers_seen: 4, queued: 0, skipped: 4 });
    // GREEN twin of the last one: at the fence it is queued.
    traced = [inner(tx(86), FINAL, SMART_WALLET, AGENT)];
    checkpointAt(FINAL);
    const g = await runChainRecordInboundScan(deps({ listWallets: fenced }), { maxLogCalls: 10_000 });
    expect(g.queued).toBe(1);
  });

  it('RED: a failed trace read holds the cursor at the last complete window, and nothing of that window is queued', async () => {
    checkpointAt(1000);
    traced = [inner(tx(87), 1003, SMART_WALLET, HUMAN), inner(tx(88), 1024, SMART_WALLET, HUMAN)];
    traceFailAt = 1025;
    const r = await runChainRecordInboundScan(deps({
      // A native transfer in the failing window: it must NOT be queued either.
      getNativeTransfers: async (a) => (a.fromBlock === 1020
        ? [{ transactionHash: tx(89), blockNumber: 1021, fromAddress: STRANGER, toAddress: HUMAN, valueWei: '5' }]
        : []),
    }), { maxLogCalls: 10_000, blockChunk: 10 });
    expect(r).toMatchObject({ error: 'trace_rpc_down', to_block: 1019 });
    expect(checkpoint()).toBe(1020);
    expect(obs(tx(87), 'hw1')).toBeDefined();
    expect(obs(tx(88), 'hw1')).toBeUndefined();
    expect(obs(tx(89), 'hw1')).toBeUndefined();
  });

  it('budget: a trace window costs one call per address batch beside the log and native calls; only whole windows', async () => {
    checkpointAt(1000);
    // 1 log call + 10 native block reads + 1 trace call = 12 per window; 30 covers two windows.
    const r = await runChainRecordInboundScan(deps(), { maxLogCalls: 30, blockChunk: 10 });
    expect(r).toMatchObject({ budget_stopped: true, log_calls_used: 30, to_block: 1023 });
    expect(checkpoint()).toBe(1024);
    // Two address batches: two trace calls per window, each batch asked once.
    traceCalls = [];
    checkpointAt(1000);
    // 2 log calls + 10 native block reads + 2 trace calls = 14: exactly one window.
    await runChainRecordInboundScan(deps(), { maxLogCalls: 14, blockChunk: 10, addressBatch: 1 });
    expect(traceCalls.map((c) => c.toAddresses)).toEqual([[wallets[0].address], [wallets[1].address]]);
  });

  it('a set-aside row repaired later is BACKFILLED for internal ETH over its held range too', async () => {
    checkpointAt(FINAL - 30);
    traced = [inner(tx(90), FINAL - 25, SMART_WALLET, HUMAN)];
    await runChainRecordInboundScan(deps({
      listWallets: async () => [{ setAside: true, key: 'k_human', reason: 'malformed', address: HUMAN }, wallets[1]],
    }), { maxLogCalls: 10_000, blockChunk: 10 });
    expect(obs(tx(90), 'hw1')).toBeUndefined();
    const r = await runChainRecordInboundScan(deps({
      listWallets: async () => [{ ...wallets[0], key: 'k_human' }, wallets[1]],
    }), { maxLogCalls: 10_000, blockChunk: 10 });
    expect(r.released).toBe(1);
    expect(obs(tx(90), 'hw1')).toMatchObject({ source: 'inbound_scan', owner_type: 'human' });
  });

  it('RED: a trace pointer outside the requested window stops the run', async () => {
    checkpointAt(1000);
    const r = await runChainRecordInboundScan(deps({
      getInternalTransfers: async (a) => (a.fromBlock === 1010 ? [inner(tx(91), 5, SMART_WALLET, HUMAN)] : []),
    }), { maxLogCalls: 10_000, blockChunk: 10 });
    expect(r).toMatchObject({ error: 'chain_record_scan_internal_out_of_range', to_block: 1009 });
  });
});

describe('cost windows preserve all chain discovery and durable outputs',()=>{
 it('500 covered blocks have identical log/native/internal pointers and checkpoints; fewer range reads',async()=>{
  const watched:ChainRecordScanWallet[]=Array.from({length:6},(_,i)=>({address:'0x'+(0x6000+i).toString(16).padStart(40,'0'),walletId:'cost-owner-'+i,ownerType:'human',eligibilityStartBlock:0}));
  const start=FINAL-499;
  const logs=watched.map((w,i)=>at(start+i*99,transferLog(tx(10000+i),DAI,STRANGER,w.address,BigInt(i+1),0)));
  const native=watched.map((w,i)=>({transactionHash:tx(20000+i),blockNumber:start+i*90,fromAddress:STRANGER,toAddress:w.address,valueWei:String(i+123)}));
  const internal=watched.map((w,i)=>({transactionHash:tx(30000+i),blockNumber:start+i*80,fromAddress:STRANGER,toAddress:w.address,valueWei:String(i+987)}));
  const run=async(width:number)=>{
   const db=createFakeFirestore();db.store.set(`${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID}`,{schema_version:'chain-record-inbound-scan-checkpoint/v1',next_block:start,updated_at_ms:1});let logCalls=0,traceCalls=0,nativeBlocks=0;
   const deps:ChainRecordInboundScanDeps={db:db as unknown as Firestore,getHead:async()=>HEAD,listWallets:async()=>watched,now:()=>1,
    getLogs:async a=>{logCalls++;return logs.filter(l=>l.blockNumber>=a.fromBlock&&l.blockNumber<=a.toBlock&&a.toAddresses.includes('0x'+l.topics[2].slice(-40)));},
    getNativeTransfers:async a=>{nativeBlocks+=a.toBlock-a.fromBlock+1;return native.filter(p=>p.blockNumber>=a.fromBlock&&p.blockNumber<=a.toBlock&&a.toAddresses.has(p.toAddress));},
    getInternalTransfers:async a=>{traceCalls++;return internal.filter(p=>p.blockNumber>=a.fromBlock&&p.blockNumber<=a.toBlock&&a.toAddresses.includes(p.toAddress));}};
   const report=await runChainRecordInboundScan(deps,{blockChunk:width,addressBatch:2,maxLogCalls:10000});expect(report).toMatchObject({error:null,queued:18,budget_stopped:false});
   const output=[...db.store.entries()].sort(([a],[b])=>a.localeCompare(b));const replay=await runChainRecordInboundScan(deps,{blockChunk:width,addressBatch:2,maxLogCalls:10000});expect(replay.queued).toBe(0);return {output,logCalls,traceCalls,nativeBlocks};
  };
  const red=await run(10),green=await run(500);expect(green.output).toEqual(red.output);expect(red.logCalls).toBe(150);expect(green.logCalls).toBe(3);expect(red.traceCalls).toBe(150);expect(green.traceCalls).toBe(3);expect(red.nativeBlocks).toBe(500);expect(green.nativeBlocks).toBe(500);
 });
});

// Relay heap OOM, 2026-10-17. From 2026-10-10 23:55Z the trace read of one heavy
// window timed out on every run: `Promise.all` rejected, the run returned, and the
// window's 500-block full-block read ran on behind it unobserved; the cursor,
// written only at the end of a run, never moved, so the same window was re-read
// every five minutes and the relay aborted ~two an hour. Each case below is RED on
// the code before the fix.
describe('runChainRecordInboundScan — reads settle, progress is durable per window', () => {
  let db: FakeFirestore;
  const checkpoint = () => (db.store.get(
    `${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID}`,
  ) as { next_block: number } | undefined)?.next_block;
  const checkpointAt = (next: number) => db.store.set(`${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID}`, {
    schema_version: 'chain-record-inbound-scan-checkpoint/v1', next_block: next, updated_at_ms: 1,
  });
  const tick = () => new Promise((r) => setTimeout(r, 5));
  beforeEach(() => { db = createFakeFirestore(); });

  it('a trace read that fails fast does not return the scan while the window\'s block read is still running', async () => {
    checkpointAt(FINAL - 9);
    let releaseNative: () => void = () => {};
    let nativeSettled = false;
    let returnedWhileNativeRunning: boolean | null = null;
    const scan = runChainRecordInboundScan({
      db: db as unknown as Firestore,
      getHead: async () => HEAD,
    initialFromBlock: async head => Math.max(0, head - LEGACY_LOOKBACK_BLOCKS),
      getLogs: async () => [],
      getNativeTransfers: () => new Promise<NativeTransferPointer[]>((resolve) => { releaseNative = () => { nativeSettled = true; resolve([]); }; }),
      getInternalTransfers: async () => { throw new Error('request timeout'); },
      listWallets: async () => wallets,
      now: () => 1,
    }, { maxLogCalls: 10_000, blockChunk: 10 }).then((r) => { returnedWhileNativeRunning = !nativeSettled; return r; });
    await tick();
    expect(returnedWhileNativeRunning).toBeNull(); // RED before the fix: returned at once, block read left running
    releaseNative();
    const report = await scan;
    expect(returnedWhileNativeRunning).toBe(false);
    expect(report.error).toBe('request timeout');
    expect(checkpoint()).toBe(FINAL - 9); // the failed window is not passed
  });

  it('each completed window is checkpointed before the next is read, held rows first, so a run that dies keeps its progress', async () => {
    checkpointAt(1000);
    const heldKey = 'bad-row';
    let hang: (() => void) | null = null;
    const windows: number[] = [];
    const scan = runChainRecordInboundScan({
      db: db as unknown as Firestore,
      getHead: async () => 1000 + 30 + 12 - 1, // finalized through 1029: three 10-block windows
      getLogs: async (a) => {
        windows.push(a.fromBlock);
        if (a.fromBlock === 1020) await new Promise<void>((resolve) => { hang = resolve; }); // the process "dies" here
        return [];
      },
      listWallets: async () => [...wallets, { setAside: true as const, key: heldKey, reason: 'malformed', address: null }],
      now: () => 1,
    }, { maxLogCalls: 10_000, blockChunk: 10 });
    for (let i = 0; i < 50 && hang === null; i += 1) await tick();
    expect(windows).toEqual([1000, 1010, 1020]);
    // Two windows completed while the third is in flight: their progress is already durable.
    expect(checkpoint()).toBe(1020); // RED before the fix: still 1000 until the run returned
    const held = db.store.get(`${CHAIN_RECORD_SCAN_SET_ASIDE_COLLECTION}/${heldKey}`) as { held_through_block: number } | undefined;
    expect(held?.held_through_block).toBe(1019); // the held row covers every block the cursor passed
    (hang as unknown as () => void)();
    const report = await scan;
    expect(report).toMatchObject({ error: null, to_block: 1029 });
    expect(checkpoint()).toBe(1030);
  });

  it('review r1: a repaired row\'s backfill does not return while its block read is still running', async () => {
    checkpointAt(1000);
    const heldKey = 'repaired-row';
    db.store.set(`${CHAIN_RECORD_SCAN_SET_ASIDE_COLLECTION}/${heldKey}`, {
      schema_version: 'chain-record-scan-set-aside/v1', key: heldKey, reason: 'malformed', address: HUMAN,
      held_from_block: 900, held_through_block: 909, backfill_next_block: 900, first_seen_at_ms: 1, last_seen_at_ms: 1,
    });
    let releaseNative: () => void = () => {};
    let nativeSettled = false;
    let returnedWhileNativeRunning: boolean | null = null;
    const scan = runChainRecordInboundScan({
      db: db as unknown as Firestore,
      getHead: async () => 1000 + 12 - 1, // caught up: nothing new is final, only the backfill reads
      getLogs: async () => [],
      getNativeTransfers: (a) => (a.fromBlock === 900
        ? new Promise<NativeTransferPointer[]>((resolve) => { releaseNative = () => { nativeSettled = true; resolve([]); }; })
        : Promise.resolve([])),
      getInternalTransfers: async (a) => { if (a.fromBlock === 900) throw new Error('trace_down'); return []; },
      listWallets: async () => [{ ...wallets[0], key: heldKey }],
      now: () => 1,
    }, { maxLogCalls: 10_000, blockChunk: 10 }).then((r) => { returnedWhileNativeRunning = !nativeSettled; return r; });
    for (let i = 0; i < 20; i += 1) await tick();
    expect(returnedWhileNativeRunning).toBeNull(); // RED with Promise.all: the backfill returned, the read ran on
    releaseNative();
    const report = await scan;
    expect(returnedWhileNativeRunning).toBe(false);
    expect(report.error).toBe('trace_down');
    expect((db.store.get(`${CHAIN_RECORD_SCAN_SET_ASIDE_COLLECTION}/${heldKey}`) as { backfill_next_block: number }).backfill_next_block).toBe(900);
  });
});
