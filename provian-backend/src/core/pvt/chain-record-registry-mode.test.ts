/**
 * the chain-record scan and the proven-EOA nonce scanner in registry mode.
 *
 * - A registry address the scan has not asked about since its fence (it entered after the
 * cursor passed its fence) gets a held range from its fence, which the repaired-row backfill
 * drains: its past receive is queued (RED: the same row without a registry entry is not).
 * - A proven EOA's own transactions are found in the full blocks from B_F on (RED twins: a
 * transaction before B_F, and a contract wallet's, are not queued by the full-block read).
 * - The nonce scanner, once B_F is fixed, migrates to bounded ranges: a proven address the
 * round-robin never reached gets a range from its fence to B_F - 1 (RED: an address outside
 * the registry gets none), and covers above the scan's cursor only while that scan lags
 * (RED: within the lag allowance it reads nothing above B_F).
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import crypto from 'crypto';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import { transferLog } from './__test-helpers__/base-transaction-evidence';
import type { CanonicalEconomicLog, SignedTransactionPointer } from '../onchain/economic-discovery';
import {
  CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID,
  CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION,
  CHAIN_RECORD_SCAN_SET_ASIDE_COLLECTION,
  buildChainRecordInboundScanDeps,
  runChainRecordInboundScan,
  type ChainRecordInboundScanDeps,
} from './chain-record-inbound-scan';
import {
  PROVEN_OUTBOUND_CURSOR_PREFIX,
  PROVEN_OUTBOUND_FLOOR_BLOCK,
  runChainRecordProvenOutboundScan,
  type ProvenOutboundScanDeps,
} from './chain-record-proven-outbound-scan';
import { PROVEN_OUTBOUND_FULL_BLOCK_DOC, provenOutboundRangeId, openProvenOutboundRange } from './proven-outbound-ranges';
import { CHAIN_RECORD_OBSERVATIONS_COLLECTION, chainRecordObservationId, provenObservationWalletId } from './chain-record-watcher';
import { NATIVE_WALLET_ADDRESS_INDEX_COLLECTION, nativeWalletAddressIndexId } from './native-wallet-registration';
import { WATCHER_ADDRESS_ADMISSION_COLLECTION, watcherAddressAdmissionDocIdFor } from './watcher-address-admission';
import { HUMAN_PROVEN_ADDRESSES_COLLECTION } from '../external-address/link';
import { HUMAN_PROVEN_ADDRESS_SCHEMA } from '../external-address/human-link';
import { addWatchRegistryEntries } from './watch-registry';
import { ensureWatchRegistrySeeded } from './watch-registry-reconcile';

const ensureWatchRegistrySeededForTest = (db: FakeFirestore) => ensureWatchRegistrySeeded(db as unknown as Firestore, 1);

const N = '0xa9e7700000000000000000000000000000000002';
const P = '0xbeef00000000000000000000000000000000000b';
const C = '0xc0de00000000000000000000000000000000000c';
const STRANGER = '0x5000000000000000000000000000000000000005';
const DAI = '0x50c5725949a6f0c72e6c4a641f24049a917db0cb';
const HEAD = PROVEN_OUTBOUND_FLOOR_BLOCK + 100_000;
const FINAL = HEAD - 12;
const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const at = (block: number, log: CanonicalEconomicLog): CanonicalEconomicLog => ({ ...log, blockNumber: block });
const sha = (v: string) => `sha256:${crypto.createHash('sha256').update(v).digest('hex')}`;

function personProven(address: string, provenAt: number, method: 'eip191_eoa' | 'eip1271_contract' = 'eip191_eoa') {
  return {
    schema_version: HUMAN_PROVEN_ADDRESS_SCHEMA, address, user_id: `u-${address.slice(2, 6)}`, wallet_id: `hw-${address.slice(2, 6)}`,
    economic_eligibility: 'active_go_forward_only', proven_at_ms: 1_000, proven_at_block: provenAt,
    proof_observed_head_block: provenAt - 1, proof_block_number: provenAt - 12, proof_block_hash: `0x${'ab'.repeat(32)}`,
    proof_min_confirmations: 12, proof_rpc_operator_ids: ['op-a', 'op-b'], chain: 'base', chain_id: 8453,
    proof_method: method, signature_hash: sha('s'),
    proof_evidence: {
      schema_version: 'external-address-control-proof/v1', challenge_id_sha256: sha('c'), challenge_message_sha256: sha('m'),
      signature_sha256: sha('s'), proof_method: method, verified_at_ms: 1_000,
    },
    initial_reputation_tier: 0, baseline_nonce: 0, created_at: 1_000,
  };
}

function seedNative(db: FakeFirestore, address: string, fence: number): void {
  db.store.set(`${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(address)}`, {
    schema_version: 'native-wallet-address-index/v1', chain_id: 8453, address,
    wallet_id: 'aw1', owner_type: 'agent', owner_id: 'aw1_owner', created_at_ms: 1,
  });
  db.store.set(`${WATCHER_ADDRESS_ADMISSION_COLLECTION}/${watcherAddressAdmissionDocIdFor('inbound', 8453, address)}`, {
    schema_version: 'pvt-watcher-address-admission/v3', direction: 'inbound', chain_id: 8453, address,
    wallet_id: 'aw1', agent_id: 'aw1_owner', eligibility_start_block: fence, state: 'live',
    backfill_next_block: fence, catch_up_through_block: fence - 1, membership_generation: 1,
    generation_fenced_at_registration: true, revision: 1, created_at_ms: 1, updated_at_ms: 1,
  });
}

const setScanCheckpoint = (db: FakeFirestore, next: number) => db.store.set(
  `${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID}`,
  { schema_version: 'chain-record-inbound-scan-checkpoint/v1', next_block: next, updated_at_ms: 1 },
);

describe('chain-record scan, registry mode', () => {
  let db: FakeFirestore;
  let logs: CanonicalEconomicLog[];
  let signed: SignedTransactionPointer[];
  const deps = (): ChainRecordInboundScanDeps => ({
    ...buildChainRecordInboundScanDeps(db as unknown as Firestore),
    getCompactWindow: undefined,
    initialFromBlock: async head => Math.max(0, head - 900),
    useRegistry: true,
    getHead: async () => HEAD,
    getLogs: async (a) => logs.filter((l) => l.blockNumber >= a.fromBlock && l.blockNumber <= a.toBlock
      && a.toAddresses.includes(`0x${l.topics[2].slice(-40)}`)),
    getBlockTransfers: async ({ fromBlock, toBlock, fromAddresses }) => ({
      natives: [],
      signed: signed.filter((s) => s.blockNumber >= fromBlock && s.blockNumber <= toBlock && fromAddresses.has(s.fromAddress)),
    }),
    // The held-range backfill reads native transfers per window; none in these fixtures.
    getNativeTransfers: async () => [],
    getInternalTransfers: async () => [],
    now: () => 1,
  });
  const obs = (txHash: string, walletId: string) => db.store.get(
    `${CHAIN_RECORD_OBSERVATIONS_COLLECTION}/${chainRecordObservationId(txHash, walletId)}`,
  ) as Record<string, unknown> | undefined;

  beforeEach(() => {
    db = createFakeFirestore();
    logs = [];
    signed = [];
  });

  it('global logs resolve only watched registry recipients; a foreign owner query is unreachable', async () => {
    seedNative(db, N, FINAL - 100);
    await addWatchRegistryEntries(db as unknown as Firestore, [{ kind: 'native', address: N }], 1);
    await ensureWatchRegistrySeededForTest(db);
    setScanCheckpoint(db, FINAL - 10);
    const collection = db.collection.bind(db);
    let foreignLookups = 0;
    jest.spyOn(db, 'collection').mockImplementation(name => {
      const ref = collection(name);
      if (name !== HUMAN_PROVEN_ADDRESSES_COLLECTION) return ref;
      return { ...ref, doc: id => {
        if (id === STRANGER) { foreignLookups++; throw new Error('foreign recipient must never load owner state'); }
        return ref.doc(id);
      } };
    });
    const known = at(FINAL - 1, transferLog(tx(800), DAI, STRANGER, N, 5n, 0));
    const foreign = at(FINAL - 1, transferLog(tx(801), DAI, N, STRANGER, 5n, 0));
    const r = await runChainRecordInboundScan({ ...deps(), getCompactWindow: async () => ({
      logs: [known, foreign], transfers: { natives: [], signed: [] }, internals: [],
    }) });
    expect(r.error).toBeNull(); expect(r.queued).toBe(1); expect(r.skipped).toBe(1);
    expect(foreignLookups).toBe(0);
    expect(obs(tx(800), 'aw1')).toMatchObject({ status: 'pending' });
    expect(obs(tx(801), 'aw1')).toBeUndefined();
  });

  /** One run over an empty network (seeds registry + marks, fixes B_F), then N registers late. */
  async function lateNative(withRegistryEntry: boolean): Promise<void> {
    setScanCheckpoint(db, FINAL - 100);
    expect((await runChainRecordInboundScan(deps(), { maxLogCalls: 10_000 })).error).toBeNull();
    seedNative(db, N, FINAL - 300);
    if (withRegistryEntry) await addWatchRegistryEntries(db as unknown as Firestore, [{ kind: 'native', address: N }], 1);
    // A receive in the range the cursor passed before N was in the registry.
    logs = [at(FINAL - 200, transferLog(tx(1), DAI, STRANGER, N, 5n, 0))];
  }

  it('a registry address whose fence the cursor already passed is backfilled from its fence', async () => {
    await lateNative(true);
    const r = await runChainRecordInboundScan(deps(), { maxLogCalls: 10_000 });
    expect(r.error).toBeNull();
    expect(obs(tx(1), 'aw1')).toMatchObject({ status: 'pending', source: 'inbound_scan' });
  });

  it('RED CONTROL — the same row with no registry entry is not asked about', async () => {
    await lateNative(false);
    const r = await runChainRecordInboundScan(deps(), { maxLogCalls: 10_000 });
    expect(r.error).toBeNull();
    expect(obs(tx(1), 'aw1')).toBeUndefined();
  });

  it('a late range stopped on budget survives its row turning malformed, and finishes once repaired', async () => {
    await lateNative(true);
    const lateKey = () => [...db.store.keys()].find((k) => k.startsWith(`${CHAIN_RECORD_SCAN_SET_ASIDE_COLLECTION}/`)
      && (db.store.get(k) as { key?: string }).key === `late_${N}`);
    // A budget that ends the backfill after its first window, before the receive at FINAL - 200.
    await runChainRecordInboundScan(deps(), { maxLogCalls: 40, blockChunk: 20 });
    expect(obs(tx(1), 'aw1')).toBeUndefined();
    const stopped = lateKey();
    expect(stopped).toBeDefined();
    expect((db.store.get(stopped!) as { backfill_next_block: number }).backfill_next_block).toBeLessThanOrEqual(FINAL - 200);

    // The row turns malformed: the late range must stay held (the old release deleted it).
    const indexKey = `${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(N)}`;
    const good = db.store.get(indexKey) as Record<string, unknown>;
    db.store.set(indexKey, { ...good, owner_type: 'robot' });
    await runChainRecordInboundScan(deps(), { maxLogCalls: 10_000 });
    expect(lateKey()).toBeDefined();

    // Repaired: the range resumes and the receive is found.
    db.store.set(indexKey, good);
    await runChainRecordInboundScan(deps(), { maxLogCalls: 10_000 });
    expect(obs(tx(1), 'aw1')).toMatchObject({ source: 'inbound_scan' });
    expect(lateKey()).toBeUndefined();
  });

  it('a held row stored without an address survives a contest on the address it repairs to', async () => {
    // Negative control: the index row's address field is malformed, so the hold
    // carries no address; once repaired, the address it names is contested.
    seedNative(db, N, FINAL - 300);
    setScanCheckpoint(db, FINAL - 100);
    await runChainRecordInboundScan(deps(), { maxLogCalls: 10_000 });
    const indexKey = `${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(N)}`;
    const good = db.store.get(indexKey) as Record<string, unknown>;
    db.store.set(indexKey, { ...good, address: 'not-an-address' });
    logs = [at(FINAL + 50, transferLog(tx(2), DAI, STRANGER, N, 5n, 0))];
    const later = (h: number) => ({ ...deps(), getHead: async () => h });
    await runChainRecordInboundScan(later(HEAD + 100), { maxLogCalls: 10_000 });
    expect(obs(tx(2), 'aw1')).toBeUndefined();

    db.store.set(indexKey, good);
    const rival = `${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/address_rival`;
    db.store.set(rival, { ...good, wallet_id: 'aw2', owner_id: 'aw2_owner' });
    await runChainRecordInboundScan(later(HEAD + 150), { maxLogCalls: 10_000 });
    expect(obs(tx(2), 'aw1')).toBeUndefined();

    db.store.delete(rival);
    await runChainRecordInboundScan(later(HEAD + 200), { maxLogCalls: 10_000 });
    expect(obs(tx(2), 'aw1')).toMatchObject({ source: 'inbound_scan' });
  });

  it('a proven EOA\'s own transaction in the full blocks from B_F is queued; before B_F and a contract wallet\'s are not', async () => {
    db.store.set(`${HUMAN_PROVEN_ADDRESSES_COLLECTION}/${P}`, personProven(P, FINAL - 5_000));
    db.store.set(`${HUMAN_PROVEN_ADDRESSES_COLLECTION}/${C}`, personProven(C, FINAL - 5_000, 'eip1271_contract'));
    setScanCheckpoint(db, FINAL - 100);
    // B_F already fixed at FINAL - 50: the nonce scanner owns everything below it.
    db.store.set(`${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${PROVEN_OUTBOUND_FULL_BLOCK_DOC}`, {
      schema_version: 'chain-record-proven-outbound-full-block/v1', block: FINAL - 50, fixed_at_ms: 1,
    });
    signed = [
      { transactionHash: tx(10), blockNumber: FINAL - 20, fromAddress: P },
      { transactionHash: tx(11), blockNumber: FINAL - 80, fromAddress: P },
      { transactionHash: tx(12), blockNumber: FINAL - 20, fromAddress: C },
    ];
    const r = await runChainRecordInboundScan(deps(), { maxLogCalls: 10_000 });
    expect(r.error).toBeNull();
    expect(r).toMatchObject({ signed_transactions_seen: 3, proven_outbound_queued: 1 });
    expect(obs(tx(10), provenObservationWalletId(P))).toMatchObject({ source: 'proven_outbound_scan', owner_type: 'human' });
    expect(obs(tx(11), provenObservationWalletId(P))).toBeUndefined();
    expect(obs(tx(12), provenObservationWalletId(C))).toBeUndefined();
  });

  it('the first registry run fixes B_F at its own start block, once', async () => {
    setScanCheckpoint(db, FINAL - 100);
    await runChainRecordInboundScan(deps(), { maxLogCalls: 10_000 });
    const fixed = db.store.get(`${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${PROVEN_OUTBOUND_FULL_BLOCK_DOC}`);
    expect(fixed).toMatchObject({ block: FINAL - 100 });
    await runChainRecordInboundScan({ ...deps(), getHead: async () => HEAD + 50 }, { maxLogCalls: 10_000 });
    expect(db.store.get(`${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${PROVEN_OUTBOUND_FULL_BLOCK_DOC}`)).toEqual(fixed);
  });
});

describe('nonce scanner, bounded mode (after B_F)', () => {
  let db: FakeFirestore;
  /** Per address: nonce k consumed in block blocks[address][k]. */
  let blocks: Record<string, number[]>;
  const B_F = FINAL - 1_000;
  const deps = (): ProvenOutboundScanDeps => ({
    db: db as unknown as Firestore,
    useRegistry: true,
    getHead: async () => HEAD,
    getBlockTimestampMs: async height => height * 2000,
    getNonce: async (address, block) => (blocks[address] ?? []).filter((b) => b <= block).length,
    getTransactionByNonce: async (address, nonce, block) =>
      ((blocks[address] ?? [])[nonce] === block ? tx(Number.parseInt(address.slice(2, 6), 16) * 100 + nonce) : null),
    listProven: async () => { throw new Error('bounded_mode_must_not_list'); },
    now: () => 1,
  });
  const obsOf = (address: string, nonce: number) => db.store.get(
    `${CHAIN_RECORD_OBSERVATIONS_COLLECTION}/${chainRecordObservationId(tx(Number.parseInt(address.slice(2, 6), 16) * 100 + nonce), provenObservationWalletId(address))}`,
  );

  beforeEach(async () => {
    db = createFakeFirestore();
    db.store.set(`${HUMAN_PROVEN_ADDRESSES_COLLECTION}/${P}`, personProven(P, FINAL - 5_000));
    db.store.set(`${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${PROVEN_OUTBOUND_FULL_BLOCK_DOC}`, {
      schema_version: 'chain-record-proven-outbound-full-block/v1', block: B_F, fixed_at_ms: 1,
    });
    // P: one transaction below B_F (the nonce scanner's), one above (the full blocks').
    blocks = { [P]: [FINAL - 3_000, FINAL - 10] };
  });

  it('a concurrent discovery extension stays open when the scanner finishes its older range snapshot', async () => {
    await ensureWatchRegistrySeededForTest(db);
    setScanCheckpoint(db, FINAL + 1);
    let extended = false;
    const base = deps();
    const result = await runChainRecordProvenOutboundScan({ ...base, getNonce: async (address, height) => {
      if (!extended && height === B_F - 1) {
        extended = true;
        await openProvenOutboundRange(db as unknown as Firestore,
          { address: P, ownerType: 'human', fromBlock: FINAL - 5_000, throughBlock: FINAL }, 2);
      }
      return base.getNonce(address, height);
    } });
    expect(result.errors).toEqual([]); expect(extended).toBe(true);
    const key = `${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${provenOutboundRangeId(P, FINAL - 5_000)}`;
    expect(db.store.get(key)).toMatchObject({ through_block: FINAL, next_block: B_F, done: false });
    expect(obsOf(P, 1)).toBeUndefined();
    expect((await runChainRecordProvenOutboundScan(deps())).errors).toEqual([]);
    expect(obsOf(P, 1)).toMatchObject({ source: 'proven_outbound_scan' });
    expect(db.store.get(key)).toMatchObject({ next_block: FINAL + 1, done: true });
  });

  it('a proven address the round-robin never reached gets a range from its fence to B_F - 1', async () => {
    await ensureWatchRegistrySeededForTest(db);
    setScanCheckpoint(db, FINAL - 20); // the scan is current
    const r = await runChainRecordProvenOutboundScan(deps());
    expect(r).toMatchObject({ mode: 'bounded', lagging: false, errors: [] });
    expect(db.store.get(`${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${provenOutboundRangeId(P, FINAL - 5_000)}`))
      .toMatchObject({ through_block: B_F - 1, done: true });
    expect(obsOf(P, 0)).toMatchObject({ source: 'proven_outbound_scan' });
    // Above B_F is the full-block read's: not this scan's while the scan is current.
    expect(obsOf(P, 1)).toBeUndefined();
  });

  it('RED CONTROL — an address outside the registry gets no range and its transaction is not found', async () => {
    // The registry is seeded BEFORE P's row exists, so P never enters it (a writer that forgot it).
    db.store.delete(`${HUMAN_PROVEN_ADDRESSES_COLLECTION}/${P}`);
    await ensureWatchRegistrySeededForTest(db);
    db.store.set(`${HUMAN_PROVEN_ADDRESSES_COLLECTION}/${P}`, personProven(P, FINAL - 5_000));
    setScanCheckpoint(db, FINAL - 20);
    await runChainRecordProvenOutboundScan(deps());
    expect(obsOf(P, 0)).toBeUndefined();
  });

  it('a legacy cursor becomes a range ending at B_F - 1, resuming where it stood', async () => {
    await ensureWatchRegistrySeededForTest(db);
    db.store.set(`${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${PROVEN_OUTBOUND_CURSOR_PREFIX}${P}`, {
      schema_version: 'chain-record-proven-outbound-cursor/v1', address: P, next_block: FINAL - 2_000, nonce: 1, updated_at_ms: 1,
    });
    setScanCheckpoint(db, FINAL - 20);
    await runChainRecordProvenOutboundScan(deps());
    expect(db.store.get(`${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${PROVEN_OUTBOUND_CURSOR_PREFIX}${P}`))
      .toMatchObject({ schema_version: 'chain-record-proven-outbound-range/v1', through_block: B_F - 1 });
    // The cursor had passed nonce 0's block: it is not re-walked (the old scan queued it).
    expect(obsOf(P, 0)).toBeUndefined();
  });

  it('while the chain-record scan lags, it covers from that scan\'s cursor to the finalized head', async () => {
    await ensureWatchRegistrySeededForTest(db);
    setScanCheckpoint(db, FINAL - 500); // 500 blocks behind
    const r = await runChainRecordProvenOutboundScan(deps());
    expect(r).toMatchObject({ lagging: true });
    expect(obsOf(P, 1)).toMatchObject({ source: 'proven_outbound_scan' });
  });

  it('RED CONTROL — within the lag allowance it reads nothing above B_F', async () => {
    await ensureWatchRegistrySeededForTest(db);
    setScanCheckpoint(db, FINAL - 100);
    const r = await runChainRecordProvenOutboundScan(deps());
    expect(r).toMatchObject({ lagging: false });
    expect(obsOf(P, 1)).toBeUndefined();
  });
});
