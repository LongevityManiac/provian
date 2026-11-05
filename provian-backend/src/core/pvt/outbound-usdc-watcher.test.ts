/**
 * Outbound USDC log watcher - classification (incl. the gasless-x402 gap it
 * closes), standard-path routing, no-retro fence, per-log dedup, and finality.
 */

import crypto from 'crypto';
import stableStringify from 'json-stable-stringify';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';

// buildBaseOutboundDeps.emitActivityPE calls the module-level generatePE; mock it
// so the emit-metadata (Option B chain_verified stamping) can be inspected in
// isolation, without exercising the real chain-tip / accrual machinery. The
// scanOutboundUsdc tests below inject their own fake emitActivityPE, so they never
// touch generatePE and are unaffected by this mock.
jest.mock('../agent-bank/pe-utils', () => ({
  generatePE: jest.fn(async () => ({ peId: 'pe_test', peHash: 'h', prevHash: 'p' })),
}));
jest.mock('../onchain/tx-verifier', () => ({
  verifyEvmUsdcTransfer: jest.fn(async () => ({ ok: true, confirmations: 12 })),
}));

import {
  buildBaseOutboundDeps,
  classifyOutbound,
  enumerateNativeAgentOutboundAddresses,
  scanOutboundUsdc,
  withRateLimitRetry,
  type OutboundActivityEvent,
  type OutboundActivityType,
  type OutboundTransferLog,
  type OutboundTxInfo,
  type OutboundUsdcScanDeps,
  type WatchedOutboundAddress,
} from './outbound-usdc-watcher';
import {
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  nativeWalletAddressIndexId,
  createNativeWalletRegistrationFence,
} from './native-wallet-registration';
import { generatePE } from '../agent-bank/pe-utils';
import type { AgentBankDeps } from '../agent-bank/types';
import { baseEconomicEvidence, testTxHash } from './__test-helpers__/base-economic-evidence';
import {
  writeProvenAddress,
  createProvenAddressProofEvidence,
  PROVEN_ADDRESS_CHAIN,
  PROVEN_ADDRESS_CHAIN_ID,
  PROVEN_ADDRESS_SCHEMA,
  type ProvenAddressRecord,
} from '../external-address/link';

const PROVEN = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FACILITATOR = '0xcccccccccccccccccccccccccccccccccccccccc';
const ROUTER = '0x2626664c2603336e57b271c5c0b26f421741e481'; // Uniswap SwapRouter02 (Base)
const STAKING = '0x5747a0000000000000000000000000000000000a';
const COUNTERPARTY = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const EIP3009_TRANSFER_WITH_AUTHORIZATION = '0xe3ee160e';

const isDexRouter = (a: string) => a.toLowerCase() === ROUTER;
const isStakingContract = (a: string) => a.toLowerCase() === STAKING;

function resealClaimPayload(row: Record<string, unknown>): void {
  row.payload_hash = `0x${crypto.createHash('sha256')
    .update(stableStringify(row.payload)!)
    .digest('hex')}`;
}

describe('classifyOutbound (the x402 gap + swap/stake/send)', () => {
  it('classifies a facilitator-submitted transfer as x402_payment (nonce scanner would miss it)', () => {
    // Gasless EIP-3009: the payer SIGNED, but a facilitator SUBMITTED and paid gas.
    // submitter (tx.from) !== the token sender (Transfer.from) => x402_payment.
    expect(
      classifyOutbound({
        transferFrom: PROVEN,
        submitter: FACILITATOR,
        txTo: USDC,
        txSelector: EIP3009_TRANSFER_WITH_AUTHORIZATION,
        isDexRouter,
        isStakingContract,
      }),
    ).toBe('x402_payment');
  });

  it('classifies a self-submitted transfer to a known DEX router as swap', () => {
    expect(
      classifyOutbound({ transferFrom: PROVEN, submitter: PROVEN, txTo: ROUTER, txSelector: null, isDexRouter, isStakingContract }),
    ).toBe('swap');
  });

  it('classifies a self-submitted transfer to a known staking contract as stake', () => {
    expect(
      classifyOutbound({ transferFrom: PROVEN, submitter: PROVEN, txTo: STAKING, txSelector: null, isDexRouter, isStakingContract }),
    ).toBe('stake');
  });

  it('classifies an ordinary self-submitted transfer as send', () => {
    expect(
      classifyOutbound({ transferFrom: PROVEN, submitter: PROVEN, txTo: COUNTERPARTY, txSelector: null, isDexRouter, isStakingContract }),
    ).toBe('send');
  });

  it('falls back to send when the submitting tx is unavailable (no misclassification)', () => {
    expect(
      classifyOutbound({ transferFrom: PROVEN, submitter: null, txTo: null, txSelector: null, isDexRouter, isStakingContract }),
    ).toBe('send');
  });

  it('is case-insensitive on the submitter vs sender comparison', () => {
    expect(
      classifyOutbound({
        transferFrom: PROVEN.toUpperCase(),
        submitter: PROVEN,
        txTo: COUNTERPARTY,
        txSelector: null,
        isDexRouter,
        isStakingContract,
      }),
    ).toBe('send');
  });

  it.each([
    ['ERC-20 transferFrom', USDC, '0x23b872dd'],
    ['smart-wallet relay', '0xdddddddddddddddddddddddddddddddddddddddd', '0x6a761202'],
  ])('does not grant x402 economics to a relayed %s', (_name, txTo, txSelector) => {
    expect(classifyOutbound({
      transferFrom: PROVEN,
      submitter: FACILITATOR,
      txTo,
      txSelector,
      isDexRouter,
      isStakingContract,
    })).toBe('send');
  });
});

// ---------------------------------------------------------------------------
// scanOutboundUsdc integration
// ---------------------------------------------------------------------------

interface Emitted {
  address: string;
  activityType: OutboundActivityType;
  toAddress: string;
  amountUsd: number;
  metadata: Record<string, unknown>;
}

function usdc(atomic: string, over: Partial<OutboundTransferLog> = {}): OutboundTransferLog {
  return {
    txHash: canonicalTestHash(over.txHash ?? 'tx1'),
    logIndex: over.logIndex ?? 0,
    blockNumber: over.blockNumber ?? 1000,
    fromAddress: over.fromAddress ?? PROVEN,
    toAddress: over.toAddress ?? COUNTERPARTY,
    amountAtomic: atomic,
  };
}

function canonicalTestHash(value: string): string {
  return /^0x[0-9a-fA-F]{64}$/.test(value) ? value.toLowerCase() : testTxHash(value);
}

function evidenceFor(
  addr: WatchedOutboundAddress,
  event: OutboundActivityEvent,
  info: OutboundTxInfo,
) {
  return baseEconomicEvidence({
    transactionHash: event.txHash,
    logIndex: event.logIndex,
    blockNumber: event.blockNumber,
    fromAddress: addr.address,
    toAddress: event.toAddress,
    amountAtomic: event.amountAtomic,
    transactionSubmitter: info.submitter ?? addr.address,
    transactionTo: info.to,
    transactionSelector: info.selector ?? null,
    blockTimestampMs: 1_000_000,
  });
}

function buildDeps(opts: {
  logs: OutboundTransferLog[];
  txInfo: Record<string, OutboundTxInfo>;
  provenAtBlock?: number;
  head?: number;
  emitted: Emitted[];
  emitThrowOn?: string; // txHash whose emit throws
  verificationError?: Error;
}): { deps: OutboundUsdcScanDeps; db: ReturnType<typeof createFakeFirestore> } {
  const db = createFakeFirestore();
  const watched: WatchedOutboundAddress[] = [
    {
      address: PROVEN,
      walletId: 'w1',
      agentId: 'agent1',
      provenAtBlock: opts.provenAtBlock ?? 500,
      source: 'external_proven',
    },
  ];
  const txInfo = new Map(
    Object.entries(opts.txInfo).map(([key, value]) => [canonicalTestHash(key), value]),
  );
  const deps: OutboundUsdcScanDeps = {
    db: db as unknown as Firestore,
    chainId: 8453,
    chainName: 'base',
    getBlockNumber: async () => opts.head ?? 1999,
    getLogs: async ({ fromBlock, toBlock }) =>
      opts.logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock),
    isDexRouter,
    isStakingContract,
    listWatchedAddresses: async () => watched,
    verifyActivityEvent: async (addr, event) => {
      if (opts.verificationError) throw opts.verificationError;
      const info = txInfo.get(event.txHash);
      if (!info) throw new Error('test_transaction_info_missing');
      return evidenceFor(addr, event, info);
    },
    emitActivityPE: async (addr, event, activityType, metadata) => {
      if (opts.emitThrowOn && event.txHash === canonicalTestHash(opts.emitThrowOn)) {
        throw new Error('emit boom');
      }
      opts.emitted.push({
        address: addr.address,
        activityType,
        toAddress: event.toAddress,
        amountUsd: event.amountUsd,
        metadata,
      });
      return { peId: `pe_${event.txHash}_${event.logIndex}`, peHash: 'h' };
    },
    now: () => 1_000_000,
  };
  return { deps, db };
}

describe('scanOutboundUsdc', () => {
  it('maps a gasless x402 payment the nonce scanner missed -> x402_payment on the standard path', async () => {
    const emitted: Emitted[] = [];
    const { deps } = buildDeps({
      logs: [usdc('5000000', { txHash: '0xx402', blockNumber: 1500 })], // $5
      txInfo: {
        '0xx402': {
          submitter: FACILITATOR,
          to: USDC,
          selector: EIP3009_TRANSFER_WITH_AUTHORIZATION,
        },
      },
      emitted,
    });
    const report = await scanOutboundUsdc(deps, { minConfirmations: 5, startBlock: 1000 });
    expect(report.pes_emitted).toBe(1);
    expect(report.by_type.x402_payment).toBe(1);
    expect(emitted[0].activityType).toBe('x402_payment');
    expect(emitted[0].address).toBe(PROVEN);
    expect(emitted[0].amountUsd).toBeCloseTo(5);
  });

  it('maps a relayed transferFrom as send, never as x402', async () => {
    const emitted: Emitted[] = [];
    const { deps } = buildDeps({
      logs: [usdc('5000000', { txHash: '0xtransfer-from', blockNumber: 1500 })],
      txInfo: {
        '0xtransfer-from': {
          submitter: FACILITATOR,
          to: USDC,
          selector: '0x23b872dd',
        },
      },
      emitted,
    });
    const report = await scanOutboundUsdc(deps, { startBlock: 1000 });
    expect(report.by_type).toMatchObject({ send: 1, x402_payment: 0 });
    expect(emitted[0].metadata.tx_selector).toBe('0x23b872dd');
  });

  it('classifies ordinary/send, swap, and stake in one pass', async () => {
    const emitted: Emitted[] = [];
    const { deps } = buildDeps({
      logs: [
        usdc('2000000', { txHash: '0xsend', logIndex: 0, blockNumber: 1500 }),
        usdc('3000000', { txHash: '0xswap', logIndex: 1, blockNumber: 1501, toAddress: ROUTER }),
        usdc('4000000', { txHash: '0xstake', logIndex: 2, blockNumber: 1502, toAddress: STAKING }),
      ],
      txInfo: {
        '0xsend': { submitter: PROVEN, to: COUNTERPARTY },
        '0xswap': { submitter: PROVEN, to: ROUTER },
        '0xstake': { submitter: PROVEN, to: STAKING },
      },
      emitted,
    });
    const report = await scanOutboundUsdc(deps, { startBlock: 1000 });
    expect(report.by_type).toMatchObject({ send: 1, swap: 1, stake: 1, x402_payment: 0 });
    const types = emitted.map((e) => e.activityType).sort();
    expect(types).toEqual(['send', 'stake', 'swap']);
  });

  it('gives same-head activity zero and emits exactly from the H+1 fence', async () => {
    const emitted: Emitted[] = [];
    const { deps } = buildDeps({
      logs: [
        usdc('9000000', { txHash: '0xhead', blockNumber: 499 }),
        usdc('9000000', { txHash: '0xhplus1', blockNumber: 500 }),
      ],
      txInfo: { '0xhplus1': { submitter: PROVEN, to: COUNTERPARTY } },
      provenAtBlock: 500,
      emitted,
    });
    const report = await scanOutboundUsdc(deps, { startBlock: 100 });
    expect(report.pre_proof_skipped).toBe(1);
    expect(report.pes_emitted).toBe(1);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].metadata.tx_hash).toBe(canonicalTestHash('0xhplus1'));
  });

  it('enforces the 12-confirmation Base floor even when a lower value is requested', async () => {
    const emitted: Emitted[] = [];
    const { deps } = buildDeps({
      // Inclusive finality: H=2000 means H-11=1989 has exactly 12 confirmations.
      logs: [usdc('9000000', { txHash: '0xfresh', blockNumber: 1995 })],
      txInfo: { '0xfresh': { submitter: PROVEN, to: COUNTERPARTY } },
      head: 2000,
      emitted,
    });
    const report = await scanOutboundUsdc(deps, { minConfirmations: 10, startBlock: 1000 });
    expect(report.to_block).toBe(1989);
    expect(report.pes_emitted).toBe(0);
  });

  it('includes H-11 and excludes H-10 under the inclusive finality rule', async () => {
    const emitted: Emitted[] = [];
    const { deps } = buildDeps({
      logs: [
        usdc('9000000', { txHash: '0xh-minus-11', blockNumber: 1989 }),
        usdc('9000000', { txHash: '0xh-minus-10', blockNumber: 1990, logIndex: 1 }),
      ],
      txInfo: { '0xh-minus-11': { submitter: PROVEN, to: COUNTERPARTY } },
      head: 2000,
      emitted,
    });
    const report = await scanOutboundUsdc(deps, { startBlock: 1989 });
    expect(report.to_block).toBe(1989);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].metadata.tx_hash).toBe(canonicalTestHash('0xh-minus-11'));
  });

  it('applies maxBlocksPerRun to the inclusive range exactly', async () => {
    const emitted: Emitted[] = [];
    const { deps, db } = buildDeps({ logs: [], txInfo: {}, provenAtBlock: 50, emitted });
    const report = await scanOutboundUsdc(deps, {
      startBlock: 50,
      maxBlocksPerRun: 10,
    });
    expect(report).toMatchObject({ from_block: 50, to_block: 59 });
    expect(db.store.get('activity_outbound_checkpoints/8453'))
      .toMatchObject({ last_processed_block: 59 });
  });

  it('never asks a provider for more than the free-tier 10-block getLogs range ', async () => {
    const emitted: Emitted[] = [];
    const { deps, db } = buildDeps({ logs: [], txInfo: {}, provenAtBlock: 1900, emitted });
    const spans: Array<[number, number]> = [];
    const inner = deps.getLogs;
    // A guard-fake speaking Alchemy's own refusal: any over-cap request THROWS
    // the live 400, so cap compliance is enforced by the fake, not assumed.
    deps.getLogs = async (args) => {
      spans.push([args.fromBlock, args.toBlock]);
      if (args.toBlock - args.fromBlock + 1 > 10) {
        throw new Error(
          'server response 400 Bad Request: Under the Free tier plan, you can make '
          + 'eth_getLogs requests with up to a 10 block range.',
        );
      }
      return inner(args);
    };
    // head 1999, 12 confirmations -> band 1900..1988: 89 blocks, 9 windows.
    const report = await scanOutboundUsdc(deps, { startBlock: 1900, blockChunk: 10 });
    expect(spans.length).toBe(9);
    for (const [from, to] of spans) expect(to - from + 1).toBeLessThanOrEqual(10);
    expect(report).toMatchObject({ budget_stopped: false, log_calls_used: 9 });
    expect(db.store.get('activity_outbound_checkpoints/8453'))
      .toMatchObject({ last_processed_block: 1988 });
  });

  it('NEGATIVE CONTROL — the retired 5,000-block chunk drives the provider 400 and the cursor stays frozen', async () => {
    const emitted: Emitted[] = [];
    const { deps, db } = buildDeps({ logs: [], txInfo: {}, provenAtBlock: 1900, emitted });
    const inner = deps.getLogs;
    deps.getLogs = async (args) => {
      if (args.toBlock - args.fromBlock + 1 > 10) {
        throw new Error(
          'server response 400 Bad Request: Under the Free tier plan, you can make '
          + 'eth_getLogs requests with up to a 10 block range.',
        );
      }
      return inner(args);
    };
    // The pre- default reproduces production exactly: the scan dies on the
    // provider 400 and the durable cursor never gets written.
    await expect(scanOutboundUsdc(deps, { startBlock: 1900, blockChunk: 5_000 }))
      .rejects.toThrow(/10 block range/);
    // The admission layer seeds the checkpoint shell, but the cursor itself
    // never advances — the production wedge (48,192,123, frozen from 07-23).
    expect(db.store.get('activity_outbound_checkpoints/8453'))
      .toMatchObject({ last_processed_block: null });
  });

  it(' addendum — a mid-band provider failure keeps every committed stride segment', async () => {
    const emitted: Emitted[] = [];
    const { deps, db } = buildDeps({ logs: [], txInfo: {}, provenAtBlock: 1000, emitted, head: 2411 });
    // head 2411 → band 1000..2400 (141 windows); stride = 20 windows.
    let calls = 0;
    const inner = deps.getLogs;
    deps.getLogs = async (args) => {
      calls += 1;
      if (calls === 25) throw new Error('provider fell over mid-band');
      return inner(args);
    };
    await expect(scanOutboundUsdc(deps, { startBlock: 1000, blockChunk: 10 })).rejects.toThrow('mid-band');
    // Stride segment 1 (windows 1-20, blocks 1000..1199) committed before the
    // segment-2 throw; only the segment in flight was lost. The old single
    // end-of-band commit kept NOTHING from a cut run — the shape that left the
    // cursor frozen for 24 days.
    expect(db.store.get('activity_outbound_checkpoints/8453'))
      .toMatchObject({ last_processed_block: 1199 });
  });

  it('a call budget stops on a whole window and the cursor resumes exactly there next run', async () => {
    const emitted: Emitted[] = [];
    const { deps, db } = buildDeps({ logs: [], txInfo: {}, provenAtBlock: 1900, emitted });
    const first = await scanOutboundUsdc(deps, { startBlock: 1900, maxLogCallsPerRun: 3, blockChunk: 10 });
    expect(first).toMatchObject({ budget_stopped: true, log_calls_used: 3 });
    expect(db.store.get('activity_outbound_checkpoints/8453'))
      .toMatchObject({ last_processed_block: 1929 });

    const second = await scanOutboundUsdc(deps, { maxLogCallsPerRun: 3, blockChunk: 10 });
    expect(second).toMatchObject({ budget_stopped: true, log_calls_used: 3 });
    expect(db.store.get('activity_outbound_checkpoints/8453'))
      .toMatchObject({ last_processed_block: 1959 });
  });

  it('preserves a null cursor when ownership fails on block zero', async () => {
    const emitted: Emitted[] = [];
    const built = buildDeps({
      logs: [usdc('9000000', { txHash: '0xblock-zero', blockNumber: 0 })],
      txInfo: { '0xblock-zero': { submitter: PROVEN, to: COUNTERPARTY } },
      provenAtBlock: 0,
      head: 11,
      emitted,
    });
    const db = createFakeFirestore({
      failCreateOnce: {
        collection: 'activity_outbound_seen',
        error: Object.assign(new Error('unavailable'), { code: 14 }),
      },
    });
    built.deps.db = db as unknown as Firestore;
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const report = await scanOutboundUsdc(built.deps, { startBlock: 0 });
      expect(report).toMatchObject({ errors: 1, from_block: 0, to_block: 0 });
      expect(db.store.get('activity_outbound_checkpoints/8453'))
        .toMatchObject({ last_processed_block: null });
    } finally {
      consoleError.mockRestore();
    }
  });

  it('rejects duplicate address ownership before watcher admission or checkpoint advance', async () => {
    const emitted: Emitted[] = [];
    const { deps, db } = buildDeps({ logs: [], txInfo: {}, emitted });
    deps.listWatchedAddresses = async () => [
      { address: PROVEN, walletId: 'w1', agentId: 'agent1', provenAtBlock: 500, source: 'external_proven' },
      { address: PROVEN, walletId: 'w2', agentId: 'agent2', provenAtBlock: 500, source: 'external_proven' },
    ];
    await expect(scanOutboundUsdc(deps, { startBlock: 1000 }))
      .rejects.toThrow(`watched_address_enumeration_duplicate:${PROVEN}`);
    expect([...db.store.keys()].some((key) =>
      key.startsWith('pvt_watcher_address_admissions_v1/')
      || key.startsWith('activity_outbound_checkpoints/'))).toBe(false);
  });

  it('is idempotent: a re-scan of the same (tx, logIndex) does not double-emit', async () => {
    const emitted: Emitted[] = [];
    const cfg = {
      logs: [usdc('9000000', { txHash: '0xdup', blockNumber: 1500 })],
      txInfo: { '0xdup': { submitter: PROVEN, to: COUNTERPARTY } as OutboundTxInfo },
      emitted,
    };
    const { deps, db } = buildDeps(cfg);
    await scanOutboundUsdc(deps, { startBlock: 1000 });
    expect(emitted).toHaveLength(1);
    // Second run over the same range (reuse the same db/seen collection).
    const deps2 = buildDeps({ ...cfg }).deps;
    (deps2 as { db: Firestore }).db = db as unknown as Firestore;
    // Re-point checkpoint backwards to force a re-scan of the same block.
    await db.collection('activity_outbound_checkpoints').doc('8453')
      .set({ last_processed_block: 999 }, { merge: true });
    const report2 = await scanOutboundUsdc(deps2, {});
    expect(report2.duplicates_skipped).toBe(1);
    expect(report2.pes_emitted).toBe(0);
    expect(emitted).toHaveLength(1);
  });

  it('between full passes a malformed settled claim still holds the checkpoint at its own block', async () => {
    const emitted: Emitted[] = [];
    const transfer = usdc('9000000', { txHash: '0xmalformed', blockNumber: 1500 });
    const { deps, db } = buildDeps({
      logs: [transfer],
      txInfo: { '0xmalformed': { submitter: PROVEN, to: COUNTERPARTY } as OutboundTxInfo },
      emitted,
    });
    await scanOutboundUsdc(deps, { startBlock: 1000 });
    expect(db.store.get('watcher_recovery_integrity_v1/activity_outbound_seen')).toBeDefined();
    const claimKey = `activity_outbound_seen/8453_${transfer.txHash}_0`;
    const malformed = { ...db.store.get(claimKey)! };
    delete malformed.payload_hash;
    db.store.set(claimKey, malformed);
    await db.collection('activity_outbound_checkpoints').doc('8453')
      .set({ last_processed_block: 999 }, { merge: true });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const report = await scanOutboundUsdc(deps, {});
      // The recovery query reads only unfinished claims, so it does not see this settled one; the
      // rescan meets it, refuses to treat it as a duplicate, and holds the cursor just before it.
      expect(report).toMatchObject({ duplicates_skipped: 0, pes_emitted: 0 });
      expect(report.errors).toBeGreaterThanOrEqual(1);
      expect(emitted).toHaveLength(1);
      expect(db.store.get('activity_outbound_checkpoints/8453'))
        .toMatchObject({ last_processed_block: 1499 });
    } finally {
      consoleError.mockRestore();
    }
  });

  it('holds the checkpoint and surfaces a malformed existing outbound claim', async () => {
    const emitted: Emitted[] = [];
    const transfer = usdc('9000000', { txHash: '0xmalformed', blockNumber: 1500 });
    const cfg = {
      logs: [transfer],
      txInfo: { '0xmalformed': { submitter: PROVEN, to: COUNTERPARTY } as OutboundTxInfo },
      emitted,
    };
    const { deps, db } = buildDeps(cfg);
    await scanOutboundUsdc(deps, { startBlock: 1000 });
    const claimKey = `activity_outbound_seen/8453_${transfer.txHash}_0`;
    const malformed = { ...db.store.get(claimKey)! };
    delete malformed.payload_hash;
    db.store.set(claimKey, malformed);
    await db.collection('activity_outbound_checkpoints').doc('8453')
      .set({ last_processed_block: 999 }, { merge: true });
    // the daily full integrity pass (the first run's clean pass has aged out) pages every
    // claim and blocks the lane on the malformed one, exactly as every run used to.
    db.store.delete('watcher_recovery_integrity_v1/activity_outbound_seen');
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const report = await scanOutboundUsdc(deps, {});
      expect(report).toMatchObject({ duplicates_skipped: 0, pes_emitted: 0 });
      expect(report.errors).toBeGreaterThanOrEqual(1);
      expect(emitted).toHaveLength(1);
      expect(db.store.get('activity_outbound_checkpoints/8453'))
        .toMatchObject({ last_processed_block: 999 });
      expect(consoleError).toHaveBeenCalledWith(
        '[outbound-usdc] malformed durable recovery claim',
        expect.objectContaining({ documentId: claimKey.split('/')[1] }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('does not misclassify a transient claim-create failure as a duplicate', async () => {
    const emitted: Emitted[] = [];
    const { deps } = buildDeps({
      logs: [usdc('9000000', { txHash: '0xcreate', blockNumber: 1500 })],
      txInfo: { '0xcreate': { submitter: PROVEN, to: COUNTERPARTY } },
      emitted,
    });
    const db = createFakeFirestore({
      failCreateOnce: {
        collection: 'activity_outbound_seen',
        error: Object.assign(new Error('unavailable'), { code: 14 }),
      },
    });
    deps.db = db as unknown as Firestore;
    const first = await scanOutboundUsdc(deps, { startBlock: 1400 });
    expect(first).toMatchObject({ errors: 1, duplicates_skipped: 0, pes_emitted: 0 });
    expect(db.store.get('activity_outbound_checkpoints/8453')).toMatchObject({
      last_processed_block: 1499,
    });
    const second = await scanOutboundUsdc(deps, {});
    expect(second.pes_emitted).toBe(1);
  });

  it('keeps a durable claim when emit fails and recovers without re-scanning the block', async () => {
    const emitted: Emitted[] = [];
    const { deps, db } = buildDeps({
      logs: [usdc('9000000', { txHash: '0xfail', blockNumber: 1500 })],
      txInfo: { '0xfail': { submitter: PROVEN, to: COUNTERPARTY } },
      emitted,
      emitThrowOn: '0xfail',
    });
    const report = await scanOutboundUsdc(deps, { startBlock: 1400 });
    expect(report.errors).toBe(1);
    expect(report.pes_emitted).toBe(0);
    // The payload is durable, so the block cursor may advance without losing it.
    const cp = db.store.get('activity_outbound_checkpoints/8453') as { last_processed_block: number };
    expect(cp.last_processed_block).toBe(1988);
    expect(db.store.get(`activity_outbound_seen/8453_${canonicalTestHash('0xfail')}_0`)).toMatchObject({
      state: 'pending_reverification',
    });

    const healthy: OutboundUsdcScanDeps = {
      ...deps,
      getLogs: async () => [],
      emitActivityPE: async (addr, event, activityType, metadata) => {
        emitted.push({ address: addr.address, activityType, toAddress: event.toAddress, amountUsd: event.amountUsd, metadata });
        return { peId: `pe_${event.txHash}`, peHash: 'h' };
      },
    };
    const recovered = await scanOutboundUsdc(healthy, {});
    expect(recovered.pes_emitted).toBe(1);
    expect(db.store.get(`activity_outbound_seen/8453_${canonicalTestHash('0xfail')}_0`)).toMatchObject({ state: 'complete' });
  });

  it('rejects self-consistently resealed owner corruption during recovery', async () => {
    const emitted: Emitted[] = [];
    const { deps, db } = buildDeps({
      logs: [usdc('9000000', { txHash: '0xowner-tamper', blockNumber: 1500 })],
      txInfo: { '0xowner-tamper': { submitter: PROVEN, to: COUNTERPARTY } },
      emitted,
      emitThrowOn: '0xowner-tamper',
    });
    await scanOutboundUsdc(deps, { startBlock: 1400 });
    const key = `activity_outbound_seen/8453_${canonicalTestHash('0xowner-tamper')}_0`;
    const row = db.store.get(key)!;
    ((row.payload as Record<string, unknown>).addr as Record<string, unknown>).walletId =
      'attacker-wallet';
    resealClaimPayload(row);

    const recovered = await scanOutboundUsdc({
      ...deps,
      getLogs: async () => [],
      emitActivityPE: async () => {
        throw new Error('corrupted recovery must not emit');
      },
    }, {});
    expect(recovered).toMatchObject({ pes_emitted: 0, errors: 1 });
    expect(emitted).toEqual([]);
    expect(db.store.get(key)).toMatchObject({ state: 'pending_reverification', pe_id: null });
  });

  it('persists provider disagreement and re-verifies the exact claim later', async () => {
    const emitted: Emitted[] = [];
    const built = buildDeps({
      logs: [usdc('9000000', { txHash: '0xdisagree', blockNumber: 1500 })],
      txInfo: { '0xdisagree': { submitter: PROVEN, to: COUNTERPARTY } },
      emitted,
      verificationError: new Error('economic_discovery_rpc_disagreement:transaction'),
    });
    const first = await scanOutboundUsdc(built.deps, { startBlock: 1000 });
    expect(first).toMatchObject({ pes_emitted: 0, errors: 1 });
    expect(built.db.store.get(`activity_outbound_seen/8453_${canonicalTestHash('0xdisagree')}_0`)).toMatchObject({
      state: 'pending_reverification',
    });

    const recovered = await scanOutboundUsdc({
      ...built.deps,
      getLogs: async () => [],
      verifyActivityEvent: async (addr, event) => evidenceFor(
        addr,
        event,
        { submitter: PROVEN, to: COUNTERPARTY },
      ),
    }, {});
    expect(recovered.pes_emitted).toBe(1);
    expect(emitted).toHaveLength(1);
  });

  it('requires 12 Base confirmations again at the recovery boundary', async () => {
    const emitted: Emitted[] = [];
    const built = buildDeps({
      logs: [usdc('9000000', { txHash: '0xconfirm', blockNumber: 1500 })],
      txInfo: { '0xconfirm': { submitter: PROVEN, to: COUNTERPARTY } },
      emitted,
      verificationError: new Error('economic_evidence_pending:confirmations:11/12'),
    });
    const first = await scanOutboundUsdc(built.deps, { startBlock: 1000 });
    expect(first).toMatchObject({ pes_emitted: 0, errors: 1 });
    const recovered = await scanOutboundUsdc({
      ...built.deps,
      getLogs: async () => [],
      verifyActivityEvent: async (addr, event) => evidenceFor(
        addr,
        event,
        { submitter: PROVEN, to: COUNTERPARTY },
      ),
    }, {});
    expect(recovered.pes_emitted).toBe(1);
  });

  it('records sub-cent transfers as exact provenance metadata', async () => {
    const emitted: Emitted[] = [];
    const { deps } = buildDeps({
      logs: [usdc('1000', { txHash: '0xtiny', blockNumber: 1500 })], // 0.001 USDC
      txInfo: { '0xtiny': { submitter: PROVEN, to: COUNTERPARTY } },
      emitted,
    });
    const report = await scanOutboundUsdc(deps, { dustFloorUsd: 0.01, startBlock: 1000 });
    expect(report.dust_skipped).toBe(0);
    expect(report.pes_emitted).toBe(1);
    expect(emitted[0].amountUsd).toBe(0.001);
  });

  it('stamps x402 payer + settlementTxHash in metadata for cross-source dedup', async () => {
    const emitted: Emitted[] = [];
    const { deps } = buildDeps({
      logs: [usdc('5000000', { txHash: '0xx402meta', blockNumber: 1500 })],
      txInfo: {
        '0xx402meta': {
          submitter: FACILITATOR,
          to: USDC,
          selector: EIP3009_TRANSFER_WITH_AUTHORIZATION,
        },
      },
      emitted,
    });
    await scanOutboundUsdc(deps, { startBlock: 1000 });
    // The scan-layer metadata carries tx_hash; the real emit adds payer +
    // settlementTxHash (see buildBaseOutboundDeps). Assert the scan hands the
    // classifier + tx through so the emitter can build the dedup key.
    expect(emitted[0].activityType).toBe('x402_payment');
    expect(emitted[0].metadata.tx_hash).toBe(canonicalTestHash('0xx402meta'));
    expect(emitted[0].metadata.submitter).toBe(FACILITATOR);
  });
});

// ---------------------------------------------------------------------------
// buildBaseOutboundDeps.emitActivityPE — Option B chain_verified stamping
// ---------------------------------------------------------------------------

describe('buildBaseOutboundDeps.emitActivityPE (Option B chain-verified stamping)', () => {
  const genPEMock = generatePE as jest.Mock;

  const makeDeps = (): OutboundUsdcScanDeps =>
    buildBaseOutboundDeps({
      db: createFakeFirestore() as unknown as Firestore,
    } as unknown as AgentBankDeps);

  const addr: WatchedOutboundAddress = {
    address: PROVEN,
    walletId: 'w1',
    agentId: 'agent1',
    provenAtBlock: 500,
    source: 'external_proven',
  };
  const event = (txHash: string): OutboundActivityEvent => ({
    // Real-shape hash: the emit now seals canonicalLogIdentity (defect
    // 1), whose builder rejects non-64-hex fixtures exactly as production
    // hashes never are.
    txHash: canonicalTestHash(txHash),
    logIndex: 0,
    blockNumber: 1500,
    toAddress: COUNTERPARTY,
    amountUsd: 5,
    amountAtomic: '5000000',
    observedAtMs: 1234,
  });

  beforeEach(() => genPEMock.mockClear());

  it('stamps chain_verified:true (plus payer + settlementTxHash) on an x402 emit — the mint authority', async () => {
    const deps = makeDeps();
    await deps.emitActivityPE(addr, event('0xtxcv'), 'x402_payment', {
      tx_hash: '0xtxcv',
      asset: 'USDC',
      verified: true,
      finality_confirmations: 12,
    });
    expect(genPEMock).toHaveBeenCalledTimes(1);
    const passed = genPEMock.mock.calls[0][1] as { actionType: string; metadata: Record<string, unknown> };
    expect(passed.actionType).toBe('x402_payment');
    // Only a chain-verified watcher emit stamps this; recordPEAccrual mints x402
    // ONLY when it is true. The payer + settlementTxHash key the mint-once dedup.
    expect(passed.metadata.chain_verified).toBe(true);
    expect(passed.metadata.payer).toBe(PROVEN);
    expect(passed.metadata.settlementTxHash).toBe(canonicalTestHash('0xtxcv'));
    expect((genPEMock.mock.calls[0][1] as { awaitAccrual?: boolean }).awaitAccrual).toBe(true);
    expect((genPEMock.mock.calls[0][1] as { timestampOverride?: number }).timestampOverride).toBe(1234);
    expect((genPEMock.mock.calls[0][1] as { peIdOverride?: string }).peIdOverride).toMatch(/^pe_outbound_[0-9a-f]{64}$/);
  });

  it('does NOT stamp chain_verified (or payer/settlement) on a non-x402 emit (send)', async () => {
    const deps = makeDeps();
    await deps.emitActivityPE(addr, event('0xtxsend'), 'send', {
      tx_hash: '0xtxsend',
      asset: 'USDC',
      verified: true,
      finality_confirmations: 12,
    });
    expect(genPEMock).toHaveBeenCalledTimes(1);
    const passed = genPEMock.mock.calls[0][1] as { actionType: string; metadata: Record<string, unknown> };
    expect(passed.actionType).toBe('send');
    expect(passed.metadata.chain_verified).toBeUndefined();
    expect(passed.metadata.payer).toBeUndefined();
    expect(passed.metadata.settlementTxHash).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildBaseOutboundDeps.listWatchedAddresses — platform:'test' exclusion
// (parity with inbound-usdc-watcher.ts:1297 / institution-funding-watcher.ts:1329)
// ---------------------------------------------------------------------------

describe('buildBaseOutboundDeps.listWatchedAddresses (platform:test exclusion)', () => {
  // A valid v2 proven-address record (mirrors external-address/link.test.ts rec()),
  // so it survives listProvenAddresses' strict exactKeys validation.
  const provenRec = (address: string, walletId: string): ProvenAddressRecord => {
    const provenAtMs = 10_000;
    const provenAtBlock = 5_000;
    const observedHead = provenAtBlock - 1;
    const proofEvidence = createProvenAddressProofEvidence({
      challengeId: 'challenge-fixture',
      challengeMessage: 'fixture proof message',
      signature: '0xdeadbeef',
      proofMethod: 'eip191_eoa',
      verifiedAtMs: provenAtMs,
    });
    return {
      schema_version: PROVEN_ADDRESS_SCHEMA,
      economic_eligibility: 'active_go_forward_only',
      address,
      agent_id: walletId,
      wallet_id: walletId,
      proven_at_ms: provenAtMs,
      proven_at_block: provenAtBlock,
      proof_observed_head_block: observedHead,
      proof_block_number: observedHead - 11,
      proof_block_hash: `0x${'ab'.repeat(32)}`,
      proof_min_confirmations: 12,
      proof_rpc_operator_ids: ['operator-a', 'operator-b'],
      chain: PROVEN_ADDRESS_CHAIN,
      chain_id: PROVEN_ADDRESS_CHAIN_ID,
      proof_method: 'eip191_eoa',
      signature_hash: proofEvidence.signature_sha256,
      proof_evidence: proofEvidence,
      initial_reputation_tier: 1,
      baseline_nonce: 7,
      created_at: provenAtMs,
    };
  };

  const ADDR_TEST = '0xabc0000000000000000000000000000000000010';
  const ADDR_PROD = '0xabc0000000000000000000000000000000000020';

  const seed = async (
    testWalletPlatform: string,
    prodWalletPlatform: string,
  ): Promise<ReturnType<typeof createFakeFirestore>> => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await fake.collection('agent_wallets').doc('wtest').set({ platform: testWalletPlatform });
    await fake.collection('agent_wallets').doc('wprod').set({ platform: prodWalletPlatform });
    await writeProvenAddress(db, provenRec(ADDR_TEST, 'wtest'));
    await writeProvenAddress(db, provenRec(ADDR_PROD, 'wprod'));
    return fake;
  };

  it('excludes a proven address whose owning agent wallet is platform:test, keeps the non-test one', async () => {
    const fake = await seed('test', 'production');
    const watched = await buildBaseOutboundDeps({
      db: fake as unknown as Firestore,
    } as unknown as AgentBankDeps).listWatchedAddresses();

    // The non-test wallet is watched (proves the filter is selective, not a blanket
    // empty-population — the vacuous-pass shape the negative-control doctrine warns of).
    expect(watched.map((w) => w.walletId)).toEqual(['wprod']);
    expect(watched.find((w) => w.walletId === 'wtest')).toBeUndefined();
  });

  it('RED: flip the SAME address\'s owner platform test -> production and it IS watched again', async () => {
    // Identical fixture, one variable changed (owner platform). If the exclusion were
    // wired to anything other than platform, this would not flip. It does: the address
    // that was excluded above now appears, so the guard's decision is driven by
    // platform === 'test' and nothing else.
    const fake = await seed('production', 'production');
    const watched = await buildBaseOutboundDeps({
      db: fake as unknown as Firestore,
    } as unknown as AgentBankDeps).listWatchedAddresses();

    expect(watched.map((w) => w.walletId).sort()).toEqual(['wprod', 'wtest']);
    expect(watched.find((w) => w.walletId === 'wtest')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// PER-WALLET FAULT ISOLATION (2026-09-03): an orphaned native index row (its
// wallet doc deleted) must EXCLUDE just that wallet and let the scan proceed —
// the outbound parallel of the inbound watcher's 2026-08-16 fix. Before it, one
// such orphan (agent `prov-item2`) 500'd every outbound tick from 2026-08-13.
// ---------------------------------------------------------------------------
describe('buildBaseOutboundDeps.listWatchedAddresses (per-wallet fault isolation)', () => {
  const HEALTHY = '0xdad0000000000000000000000000000000000091';
  const ORPHAN = '0xdad0000000000000000000000000000000000092';

  const seedAgentIndex = async (
    fake: ReturnType<typeof createFakeFirestore>,
    address: string,
    walletId: string,
    agentId: string,
  ): Promise<void> => {
    await fake.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION)
      .doc(nativeWalletAddressIndexId(address))
      .set({
        schema_version: 'native-wallet-address-index/v1',
        chain_id: 8453,
        address,
        wallet_id: walletId,
        owner_type: 'agent',
        owner_id: agentId,
        created_at_ms: 111,
      });
  };
  const seedHealthyWallet = async (fake: ReturnType<typeof createFakeFirestore>): Promise<void> => {
    await seedAgentIndex(fake, HEALTHY, 'wh', 'agent-healthy');
    await fake.collection('agent_wallets').doc('wh').set({
      id: 'wh',
      agent_id: 'agent-healthy',
      address: HEALTHY,
      platform: 'openai',
      native_watcher_registration: createNativeWalletRegistrationFence(9_000),
    });
  };

  it('excludes an orphaned index row (deleted wallet doc), keeps the healthy wallet, and does NOT throw', async () => {
    const fake = createFakeFirestore();
    await seedHealthyWallet(fake);
    await seedAgentIndex(fake, ORPHAN, 'wallet_aw_gone', 'agent-orphan'); // no agent_wallets/wallet_aw_gone

    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const watched = await buildBaseOutboundDeps({
        db: fake as unknown as Firestore,
      } as unknown as AgentBankDeps).listWatchedAddresses();

      // The healthy wallet survives (non-empty population — not a vacuous all/nothing
      // pass), the orphan is dropped, and the whole cycle did not abort.
      expect(watched.map((w) => w.walletId)).toEqual(['wh']);
      expect(watched.find((w) => w.walletId === 'wallet_aw_gone')).toBeUndefined();
      // The exclusion was logged with the exact reason.
      expect(consoleError).toHaveBeenCalledWith(
        '[outbound-usdc] watched-set enumeration fault; wallet excluded this cycle:',
        expect.objectContaining({
          message: 'watched_address_enumeration_invalid:native_wallet_missing:wallet_aw_gone',
        }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('RED control: the SAME orphan, through the strict enumerator (no exclude sink), THROWS — proving the isolation is doing real work', async () => {
    const fake = createFakeFirestore();
    await seedHealthyWallet(fake);
    await seedAgentIndex(fake, ORPHAN, 'wallet_aw_gone', 'agent-orphan');
    // Without the orchestrator's `onExclude` sink the contract is unchanged:
    // the orphan aborts the whole enumeration (fail-closed). If the tolerant
    // path above were a vacuous pass, this control would not diverge from it.
    await expect(enumerateNativeAgentOutboundAddresses(fake as unknown as Firestore))
      .rejects.toThrow('watched_address_enumeration_invalid:native_wallet_missing:wallet_aw_gone');
  });
});

// Task 1 (/ silent-freeze class): an EMPTY watched set must ADVANCE
// the durable cursor to head, not return early and freeze it. The empty set is
// the normal pre-launch state (all agents platform:'test' → excluded), so a
// bare early-return froze activity_outbound_checkpoints/8453 at 49,679,822 from
// 2026-08-08 while every */30 tick still reported watched_addresses:0 + HTTP 200.
// ---------------------------------------------------------------------------
describe('Task 1 — empty watched set advances the cursor (does not freeze)', () => {
  const emptyDeps = (head: number): OutboundUsdcScanDeps => ({
    db: undefined as unknown as Firestore, // set per-test
    chainId: 8453,
    chainName: 'base',
    getBlockNumber: async () => head,
    getLogs: async () => { throw new Error('getLogs must not run on an empty set'); },
    isDexRouter: () => false,
    isStakingContract: () => false,
    listWatchedAddresses: async () => [], // the empty population under test
    verifyActivityEvent: async () => { throw new Error('verify must not run on an empty set'); },
    emitActivityPE: async () => { throw new Error('emit must not run on an empty set'); },
  });

  it('advances a frozen cursor to head-minConf when the set is empty', async () => {
    const db = createFakeFirestore();
    // Frozen exactly like production: a real prior cursor, well below head.
    db.store.set('activity_outbound_checkpoints/8453', {
      chain_id: 8453,
      last_processed_block: 1000,
      membership_generation: 1,
      updated_at: 500,
    });
    const deps = emptyDeps(2000);
    deps.db = db as unknown as Firestore;

    const report = await scanOutboundUsdc(deps, {});

    // Non-vacuous: the population WAS evaluated and is genuinely empty...
    expect(report.watched_addresses).toBe(0);
    expect(report.pes_emitted).toBe(0);
    // ...and the cursor STILL moved to head - 12 + 1 = 1989. If the fix
    // regressed to `if (empty) return`, this stays 1000 — the freeze.
    expect(db.store.get('activity_outbound_checkpoints/8453')).toMatchObject({
      last_processed_block: 1989,
      membership_generation: 1, // preserved
    });
  });

  it('RED: does NOT move the cursor when it is already at head (no stale churn / no regress)', async () => {
    const db = createFakeFirestore();
    // Cursor already at head-minConf (1989 for head 2000): nothing ahead.
    db.store.set('activity_outbound_checkpoints/8453', {
      chain_id: 8453,
      last_processed_block: 1989,
      membership_generation: 3,
      updated_at: 500,
    });
    const deps = emptyDeps(2000);
    deps.db = db as unknown as Firestore;

    await scanOutboundUsdc(deps, {});

    // Unchanged — updated_at NOT churned, block NOT rewritten. This is what
    // proves the advance is conditional on real progress, so the GREEN test's
    // 1000→1989 move is real work, not an unconditional write.
    expect(db.store.get('activity_outbound_checkpoints/8453')).toMatchObject({
      last_processed_block: 1989,
      updated_at: 500,
    });
  });
});

// ---------------------------------------------------------------------------
// 3d PARITY — a native agent wallet address earns the FULL priced
// chain-financial family (x402 / swap / send) at PARITY with a proven-external
// address on the same on-chain act. The prior x402-only skip is GONE: the
// self-report routes (/transfer/record, /swap/record) are best-effort
// record_only, so the watcher's durable chain-verified seal is the one that
// prices — no double-mint, dedup held per type rather than by excluding types.
// The load-bearing same-owner fence (native self-dealing → record_only) is
// proven per type in same-owner-detection.test.ts; here we prove the ADMISSION
// mints the same for both sources.
// ---------------------------------------------------------------------------
describe(' 3d PARITY — native earns the full chain-financial family', () => {
  // Reuse the harness log-source (PROVEN); SOURCE is the only variable — and it
  // must NO LONGER change whether the activity mints (that is the property under
  // test: native and external are byte-identical earners now).
  const nativeWatched = (source: 'native_agent' | 'external_proven'): WatchedOutboundAddress[] => ([
    { address: PROVEN, walletId: 'w1', agentId: 'agent1', provenAtBlock: 500, source },
  ]);

  it('GREEN: a native address EARNS its own x402 payment', async () => {
    const emitted: Emitted[] = [];
    const { deps } = buildDeps({
      logs: [usdc('5000000', { txHash: '0xnativex402', blockNumber: 1500 })],
      txInfo: {
        '0xnativex402': {
          submitter: FACILITATOR, to: USDC, selector: EIP3009_TRANSFER_WITH_AUTHORIZATION,
        },
      },
      emitted,
    });
    deps.listWatchedAddresses = async () => nativeWatched('native_agent');
    const report = await scanOutboundUsdc(deps, { minConfirmations: 5, startBlock: 1000 });
    expect(report.pes_emitted).toBe(1);
    expect(report.by_type.x402_payment).toBe(1);
    expect(emitted[0].activityType).toBe('x402_payment');
    // The counterparty MUST ride the emit so detectSameOwnerTransfer can run at
    // accrual — the fence is inert without it (the defect on funding rows).
    expect(emitted[0].toAddress).toBe(COUNTERPARTY);
  });

  it('GREEN: a native SEND now EMITS (parity — was skipped pre-)', async () => {
    const emitted: Emitted[] = [];
    const { deps } = buildDeps({
      logs: [usdc('5000000', { txHash: '0xnativesend', blockNumber: 1500 })],
      txInfo: { '0xnativesend': { submitter: PROVEN, to: COUNTERPARTY } }, // submitter==from => send
      emitted,
    });
    deps.listWatchedAddresses = async () => nativeWatched('native_agent');
    const report = await scanOutboundUsdc(deps, { minConfirmations: 5, startBlock: 1000 });
    expect(report.pes_emitted).toBe(1);
    expect(report.by_type.send).toBe(1);
    expect(emitted[0].activityType).toBe('send');
    // Counterparty rides the emit so the same-owner fence can fence self-dealing
    // at accrual (the source→PE labeling is proven in the buildBaseOutboundDeps
    // block below).
    expect(emitted[0].toAddress).toBe(COUNTERPARTY);
  });

  it('GREEN: a native SWAP now EMITS (parity — was skipped pre-)', async () => {
    const emitted: Emitted[] = [];
    const { deps } = buildDeps({
      logs: [usdc('5000000', { txHash: '0xnativeswap', blockNumber: 1500 })],
      txInfo: { '0xnativeswap': { submitter: PROVEN, to: ROUTER } }, // to==router => swap
      emitted,
    });
    deps.listWatchedAddresses = async () => nativeWatched('native_agent');
    const report = await scanOutboundUsdc(deps, { minConfirmations: 5, startBlock: 1000 });
    expect(report.pes_emitted).toBe(1);
    expect(report.by_type.swap).toBe(1);
    expect(emitted[0].activityType).toBe('swap');
  });

  it('PARITY CONTROL: native and external emit the IDENTICAL send with the same type (source no longer gates earning)', async () => {
    const run = async (source: 'native_agent' | 'external_proven'): Promise<Emitted[]> => {
      const emitted: Emitted[] = [];
      const { deps } = buildDeps({
        logs: [usdc('5000000', { txHash: '0xparitysend', blockNumber: 1500 })],
        txInfo: { '0xparitysend': { submitter: PROVEN, to: COUNTERPARTY } },
        emitted,
      });
      deps.listWatchedAddresses = async () => nativeWatched(source);
      const report = await scanOutboundUsdc(deps, { minConfirmations: 5, startBlock: 1000 });
      expect(report.pes_emitted).toBe(1);
      return emitted;
    };
    const native = await run('native_agent');
    const external = await run('external_proven');
    // The ONE variable (source) changed and the mint OUTCOME did not: both emit
    // one `send`. Pre- this control asserted the opposite (native skipped),
    // so a regression to the skip flips native's pes_emitted to 0 and fails here.
    expect(native[0].activityType).toBe('send');
    expect(external[0].activityType).toBe('send');
  });
});

describe('enumerateNativeAgentOutboundAddresses (3d)', () => {
  const NADDR = '0xdad0000000000000000000000000000000000001';
  const seedNativeAgent = async (opts: {
    address?: string;
    walletId?: string;
    agentId?: string;
    platform?: string;
    withWallet?: boolean;
    withFence?: boolean;
    walletAddressOverride?: string;
    observedHead?: number;
  } = {}): Promise<ReturnType<typeof createFakeFirestore>> => {
    const fake = createFakeFirestore();
    const address = (opts.address ?? NADDR).toLowerCase();
    const walletId = opts.walletId ?? 'nw1';
    const agentId = opts.agentId ?? 'nagent1';
    await fake.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION)
      .doc(nativeWalletAddressIndexId(address))
      .set({
        schema_version: 'native-wallet-address-index/v1',
        chain_id: 8453,
        address,
        wallet_id: walletId,
        owner_type: 'agent',
        owner_id: agentId,
        created_at_ms: 111,
      });
    if (opts.withWallet !== false) {
      await fake.collection('agent_wallets').doc(walletId).set({
        id: walletId,
        agent_id: agentId,
        address: opts.walletAddressOverride ?? address,
        platform: opts.platform ?? 'openai',
        ...(opts.withFence === false
          ? {}
          : { native_watcher_registration: createNativeWalletRegistrationFence(opts.observedHead ?? 9_000) }),
      });
    }
    return fake;
  };

  it('admits a valid agent native wallet with the creation-block no-retro fence', async () => {
    const fake = await seedNativeAgent({ observedHead: 9_000 });
    const out = await enumerateNativeAgentOutboundAddresses(fake as unknown as Firestore);
    expect(out).toEqual([{
      address: NADDR,
      walletId: 'nw1',
      agentId: 'nagent1',
      provenAtBlock: 9_001, // eligibility_start_block = observed_head + 1
      source: 'native_agent',
    }]);
  });

  it('excludes a platform:test native wallet — RED control: a production one IS admitted', async () => {
    expect(await enumerateNativeAgentOutboundAddresses(
      (await seedNativeAgent({ platform: 'test' })) as unknown as Firestore,
    )).toEqual([]);
    // One variable changed (platform), and it is admitted — the exclusion is
    // driven by platform==='test' and is not a vacuous empty population.
    expect((await enumerateNativeAgentOutboundAddresses(
      (await seedNativeAgent({ platform: 'production' })) as unknown as Firestore,
    ))).toHaveLength(1);
  });

  it('THROWS (fail-closed) when the wallet doc is missing', async () => {
    const fake = await seedNativeAgent({ withWallet: false });
    await expect(enumerateNativeAgentOutboundAddresses(fake as unknown as Firestore))
      .rejects.toThrow('watched_address_enumeration_invalid:native_wallet_missing:nw1');
  });

  it('THROWS when the wallet address does not match the index authority', async () => {
    const fake = await seedNativeAgent({ walletAddressOverride: '0xdad0000000000000000000000000000000000002' });
    await expect(enumerateNativeAgentOutboundAddresses(fake as unknown as Firestore))
      .rejects.toThrow('watched_address_enumeration_invalid:native_wallet_identity:nw1');
  });

  it('THROWS when the no-retro fence is absent — a native wallet is never admitted fenceless', async () => {
    const fake = await seedNativeAgent({ withFence: false });
    await expect(enumerateNativeAgentOutboundAddresses(fake as unknown as Firestore))
      .rejects.toThrow('watched_address_enumeration_invalid:native_wallet_fence:nw1');
  });
});

// Finding 9 (audit 2026-08-05) — a transient rate limit must self-heal, not abort the scan; a
// non-rate-limit error must surface immediately (never retried); and retries are bounded.
describe('withRateLimitRetry (finding 9 — rate-limit resilience)', () => {
  const noSleep = async () => {};

  it('recovers when a rate-limited read succeeds on a later attempt', async () => {
    let calls = 0;
    const result = await withRateLimitRetry(async () => {
      calls += 1;
      if (calls < 3) throw new Error('HTTP 429 Too Many Requests');
      return 'logs';
    }, { sleep: noSleep });
    expect(result).toBe('logs');
    expect(calls).toBe(3);
  });

  it('RED: a real disagreement (not a rate limit) surfaces immediately, un-retried', async () => {
    let calls = 0;
    await expect(withRateLimitRetry(async () => {
      calls += 1;
      throw new Error('economic_discovery_rpc_disagreement:eth_getLogs');
    }, { sleep: noSleep })).rejects.toThrow('economic_discovery_rpc_disagreement');
    expect(calls).toBe(1); // never retried
  });

  it('gives up after the bounded attempt count on a persistent rate limit', async () => {
    let calls = 0;
    await expect(withRateLimitRetry(async () => {
      calls += 1;
      throw new Error('rate limit exceeded');
    }, { attempts: 3, sleep: noSleep })).rejects.toThrow('rate limit');
    expect(calls).toBe(3);
  });
});
