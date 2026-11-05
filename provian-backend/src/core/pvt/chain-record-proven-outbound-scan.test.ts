/**
 * 2026-10-01 — a proven EOA's own transactions are found from its nonce and
 * queued (pointers only) into the chain-record lane. The chain is a fake list of
 * (block, nonce, hash) for the address; every RED case differs from a GREEN one
 * in the one variable the guard reads, and each pass prints what it found.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import {
  PROVEN_OUTBOUND_CURSOR_PREFIX,
  PROVEN_OUTBOUND_FLOOR_BLOCK,
  PROVEN_OUTBOUND_ROTATION_DOC,
  rotateFrom,
  runChainRecordProvenOutboundScan,
  type ProvenOutboundAddress,
  type ProvenOutboundScanDeps,
} from './chain-record-proven-outbound-scan';
import { CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION } from './chain-record-inbound-scan';
import {
  CHAIN_RECORD_OBSERVATIONS_COLLECTION,
  chainRecordObservationId,
  provenObservationWalletId,
} from './chain-record-watcher';

const P = '0xbeef00000000000000000000000000000000000b';
const HEAD = PROVEN_OUTBOUND_FLOOR_BLOCK + 10_000;
const FINAL = HEAD - 12;
const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

describe('runChainRecordProvenOutboundScan', () => {
  let db: FakeFirestore;
  /** The address's consumed nonces: nonce k consumed in block blocks[k]. */
  let blocks: number[];
  /** Nonces consumed with no transaction from the address (EIP-7702 authorizations). */
  let authorizationOnly: Set<number>;
  let proven: ProvenOutboundAddress[];
  const nonceAt = (block: number) => blocks.filter((b) => b <= block).length;
  const deps = (over: Partial<ProvenOutboundScanDeps> = {}): ProvenOutboundScanDeps => ({
    db: db as unknown as Firestore,
    getHead: async () => HEAD,
    getNonce: async (_a, block) => nonceAt(block),
    getTransactionByNonce: async (_a, nonce, block) =>
      (blocks[nonce] === block && !authorizationOnly.has(nonce) ? tx(nonce + 1) : null),
    listProven: async () => proven,
    now: () => 1,
    ...over,
  });
  const queued = () => [...db.store.keys()].filter((k) => k.startsWith(`${CHAIN_RECORD_OBSERVATIONS_COLLECTION}/`));
  /** The observation of the transaction carrying nonce `n` (its hash is tx(n + 1)). */
  const obs = (n: number, address = P) => db.store.get(
    `${CHAIN_RECORD_OBSERVATIONS_COLLECTION}/${chainRecordObservationId(tx(n + 1), provenObservationWalletId(address))}`,
  );
  const cursor = (address = P) => db.store.get(`${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${PROVEN_OUTBOUND_CURSOR_PREFIX}${address}`) as
    { next_block: number; nonce: number | null } | undefined;

  beforeEach(() => {
    db = createFakeFirestore();
    authorizationOnly = new Set();
    proven = [{ address: P, ownerType: 'human', provenAtBlock: FINAL - 500, proofMethod: 'eip191_eoa' }];
    // One transaction before the floor, one after the floor but before the proof,
    // then four after the proof (two in one block).
    blocks = [PROVEN_OUTBOUND_FLOOR_BLOCK - 50, FINAL - 600, FINAL - 400, FINAL - 300, FINAL - 300, FINAL - 5];
  });

  it('finds every transaction the EOA signed from the proof forward, and none before it', async () => {
    const r = await runChainRecordProvenOutboundScan(deps());
    expect(r).toMatchObject({ watched: 1, queued: 4, nonces_without_transaction: 0, errors: [] });
    for (const n of [2, 3, 4, 5]) expect(obs(n)).toMatchObject({ source: 'proven_outbound_scan', owner_type: 'human', wallet_id: provenObservationWalletId(P) });
    expect(obs(0)).toBeUndefined();
    expect(obs(1)).toBeUndefined();
    expect(cursor()).toMatchObject({ next_block: FINAL + 1, nonce: 6 });
  });

  it('a second run finds only what is new; nothing is queued twice', async () => {
    await runChainRecordProvenOutboundScan(deps());
    blocks.push(FINAL + 3);
    const r = await runChainRecordProvenOutboundScan(deps({ getHead: async () => HEAD + 10 }));
    expect(r).toMatchObject({ queued: 1, already_queued: 0 });
    expect(obs(6)).toBeDefined();
    expect(queued()).toHaveLength(5);
  });

  it('RED: a contract wallet (EIP-1271) signs nothing itself and is skipped', async () => {
    proven = [{ ...proven[0], proofMethod: 'eip1271_contract' }];
    const r = await runChainRecordProvenOutboundScan(deps());
    expect(r).toMatchObject({ watched: 0, skipped_contract_wallets: 1, queued: 0 });
    expect(queued()).toHaveLength(0);
  });

  it('an old proof starts at the commerce floor: nothing before it, everything after it', async () => {
    proven = [{ ...proven[0], provenAtBlock: 1 }];
    const r = await runChainRecordProvenOutboundScan(deps());
    expect(cursor()?.next_block).toBe(FINAL + 1);
    expect(r.queued).toBe(5);
    expect(obs(0)).toBeUndefined();
    expect(obs(1)).toBeDefined();
  });

  it('a proof fence ahead of the finalized head waits (cursor parked at the fence, nothing read)', async () => {
    proven = [{ ...proven[0], provenAtBlock: FINAL + 5 }];
    const r = await runChainRecordProvenOutboundScan(deps());
    expect(r).toMatchObject({ queued: 0, calls_used: 0 });
    expect(cursor()).toMatchObject({ next_block: FINAL + 5, nonce: null });
  });

  it('budget: a run that runs out resumes exactly where it stopped, losing nothing', async () => {
    const r1 = await runChainRecordProvenOutboundScan(deps(), { maxCalls: 14 });
    expect(r1.budget_stopped).toBe(true);
    expect(r1.queued).toBeGreaterThan(0);
    expect(r1.queued).toBeLessThan(4);
    const r2 = await runChainRecordProvenOutboundScan(deps());
    expect(r1.queued + r2.queued).toBe(4);
    expect(queued()).toHaveLength(4);
  });

  it('defect 2: a nonce consumed with no transaction (EIP-7702) is passed over, and every later send is still found', async () => {
    // Nonce 3 is an authorization in the same block as the type-4 transaction (nonce 2).
    blocks = [PROVEN_OUTBOUND_FLOOR_BLOCK - 50, FINAL - 600, FINAL - 400, FINAL - 400, FINAL - 300, FINAL - 5];
    authorizationOnly = new Set([3]);
    const r = await runChainRecordProvenOutboundScan(deps());
    expect(r).toMatchObject({ queued: 3, nonces_without_transaction: 1, errors: [] });
    expect(obs(2)).toBeDefined();
    expect(obs(3)).toBeUndefined();
    expect(obs(4)).toBeDefined();
    expect(obs(5)).toBeDefined();
    expect(cursor()).toMatchObject({ nonce: 6, next_block: FINAL + 1 });
  });

  it('RED: a reader that cannot agree (it throws) holds the cursor at that nonce; nothing is passed over', async () => {
    const r = await runChainRecordProvenOutboundScan(deps({
      getTransactionByNonce: async (_a, nonce, block) => {
        if (nonce === 3) throw new Error('economic_discovery_rpc_disagreement:transaction_by_nonce');
        return blocks[nonce] === block ? tx(nonce + 1) : null;
      },
    }));
    expect(r.errors[0]?.error).toContain('rpc_disagreement');
    expect(obs(2)).toBeDefined();
    expect(obs(3)).toBeUndefined();
    expect(obs(4)).toBeUndefined();
    expect(cursor()).toMatchObject({ nonce: 3 });
  });

  it('RED: a nonce that goes DOWN is an integrity fault, never skipped past', async () => {
    await runChainRecordProvenOutboundScan(deps());
    blocks = blocks.slice(0, 3);
    const r = await runChainRecordProvenOutboundScan(deps({ getHead: async () => HEAD + 10 }));
    expect(r.errors[0]?.error).toBe('chain_record_proven_outbound_nonce_regressed');
  });

  it('RED: a malformed cursor is an integrity fault, never a guess', async () => {
    db.store.set(`${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${PROVEN_OUTBOUND_CURSOR_PREFIX}${P}`, { schema_version: 'x' });
    const r = await runChainRecordProvenOutboundScan(deps());
    expect(r.errors[0]?.error).toBe('chain_record_proven_outbound_cursor_invalid');
    expect(queued()).toHaveLength(0);
  });

  it('one address\'s fault does not stop another\'s', async () => {
    const Q = '0xdead00000000000000000000000000000000000d';
    proven = [proven[0], { address: Q, ownerType: 'agent', provenAtBlock: FINAL - 500, proofMethod: 'eip191_eoa' }];
    db.store.set(`${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${PROVEN_OUTBOUND_CURSOR_PREFIX}${P}`, { schema_version: 'x' });
    const r = await runChainRecordProvenOutboundScan(deps());
    expect(r.errors).toHaveLength(1);
    expect(r.queued).toBe(4); // Q's four (the fake chain answers the same history for any address)
    const agentObs = db.store.get(`${CHAIN_RECORD_OBSERVATIONS_COLLECTION}/${chainRecordObservationId(tx(3), provenObservationWalletId(Q))}`) as Record<string, unknown>;
    expect(agentObs).toMatchObject({ source: 'proven_outbound_scan' });
    expect('owner_type' in agentObs).toBe(false);
  });

  it('defect 3: round-robin — with more addresses than one run can afford, every address is reached and none loses a transaction', async () => {
    const addr = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;
    proven = Array.from({ length: 250 }, (_v, i) => ({
      address: addr(i + 1), ownerType: 'agent' as const, provenAtBlock: FINAL - 3000, proofMethod: 'eip191_eoa' as const,
    }));
    const last = proven[proven.length - 1].address;
    // Only the address sorted LAST has history after its proof, and it is older than
    // any short first-sight lookback would reach: a late first turn must not lose it.
    const histories = new Map<string, number[]>([[last, [FINAL - 2000]]]);
    const nonceOf = (a: string, block: number) => (histories.get(a) ?? []).filter((b) => b <= block).length;
    // The head advances between runs, as on chain, so every cursor costs a read each run.
    let head = HEAD;
    const d = deps({
      getHead: async () => head,
      getNonce: async (a, block) => nonceOf(a, block),
      getTransactionByNonce: async (a, nonce, block) => ((histories.get(a) ?? [])[nonce] === block ? tx(nonce + 1) : null),
    });
    let reached = false;
    let runs = 0;
    for (; runs < 10 && !reached; runs += 1) {
      head += 10;
      const r = await runChainRecordProvenOutboundScan(d, { maxCalls: 200 });
      expect(r.errors).toEqual([]);
      reached = obs(0, last) !== undefined;
    }
    console.log(`[defect 3] the last of 250 addresses was reached in run ${runs}`);
    expect(reached).toBe(true);
    expect(cursor(last)).toMatchObject({ nonce: 1 });
    // Every address got a cursor (a turn) within those runs.
    expect(proven.every((p) => cursor(p.address) !== undefined)).toBe(true);
  });

  it('a malformed rotation position only resets the order; the scan still runs', async () => {
    db.store.set(`${CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION}/${PROVEN_OUTBOUND_ROTATION_DOC}`, { schema_version: 'x' });
    const r = await runChainRecordProvenOutboundScan(deps());
    expect(r).toMatchObject({ queued: 4, errors: [] });
  });

  it('rotateFrom starts just after the resume position and wraps', () => {
    const list = ['0x01', '0x02', '0x03'].map((a) => ({ address: a }));
    expect(rotateFrom(list, null).map((t) => t.address)).toEqual(['0x01', '0x02', '0x03']);
    expect(rotateFrom(list, '0x01').map((t) => t.address)).toEqual(['0x02', '0x03', '0x01']);
    expect(rotateFrom(list, '0x03').map((t) => t.address)).toEqual(['0x01', '0x02', '0x03']);
  });
});
