/**
 * item 3 — a real exchange through a DEX router or 0x is labelled and
 * ceiling-counted as a SWAP in both USDC watchers, keyed on its transaction.
 * Driven through each watcher's real scan → claim → classify path; only the chain
 * reads and the emit are injected. Each RED case differs from its GREEN case in
 * the one variable the label reads.
 */
import { describe, it, expect } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import { baseEconomicEvidence, testTxHash } from './__test-helpers__/base-economic-evidence';
import { transactionEvidence, transferLog } from './__test-helpers__/base-transaction-evidence';
import { BASE_USDC_ADDRESS, type BaseTransactionEvidence } from '../onchain/economic-discovery';
import {
  scanOutboundUsdc,
  type OutboundActivityType,
  type OutboundUsdcScanDeps,
  type WatchedOutboundAddress,
} from './outbound-usdc-watcher';
import { scanInboundUsdc, type InboundUsdcScanDeps, type WatchedWallet } from './inbound-usdc-watcher';
import {
  BASE_UNISWAP_ROUTERS,
  VERIFIED_COMMERCE_CUT_LINE_MS,
  WETH_BASE,
  WETH_WITHDRAWAL_TOPIC,
  ZEROX_ALLOWANCE_HOLDER_BASE,
} from './wallet-exchange';

const WALLET = '0xa11ce00000000000000000000000000000000001';
const SETTLER = '0x5e77100000000000000000000000000000000005';
const STRANGER = '0x5000000000000000000000000000000000000005';
const UNISWAP = [...BASE_UNISWAP_ROUTERS][0];
const AFTER = VERIFIED_COMMERCE_CUT_LINE_MS + 60_000;
const BEFORE = VERIFIED_COMMERCE_CUT_LINE_MS - 60_000;

// ---------------------------------------------------------------------------
// OUTBOUND
// ---------------------------------------------------------------------------

interface OutboundCase {
  readonly txTo: string;
  readonly submitter: string;
  readonly blockTimestampMs: number;
  /** The whole transaction, as the second read returns it. */
  readonly transaction: BaseTransactionEvidence;
}

async function outboundLabel(c: OutboundCase): Promise<{
  type: OutboundActivityType | null; keying: string | null; reads: number; errors: number;
}> {
  const db = createFakeFirestore();
  const txHash = c.transaction.transactionHash;
  const watched: WatchedOutboundAddress = {
    address: WALLET, walletId: 'w1', agentId: 'agent1', provenAtBlock: 500, source: 'native_agent',
  };
  let type: OutboundActivityType | null = null;
  let keying: string | null = null;
  let reads = 0;
  const deps: OutboundUsdcScanDeps = {
    db: db as unknown as Firestore,
    chainId: 8453,
    chainName: 'base',
    getBlockNumber: async () => 1999,
    getLogs: async ({ fromBlock, toBlock }) => (1500 >= fromBlock && 1500 <= toBlock ? [{
      txHash, logIndex: 1, blockNumber: 1500, fromAddress: WALLET, toAddress: SETTLER, amountAtomic: '5000000',
    }] : []),
    // The legacy router list (read only before the landing).
    isDexRouter: (a) => BASE_UNISWAP_ROUTERS.has(a.toLowerCase()),
    isStakingContract: () => false,
    listWatchedAddresses: async () => [watched],
    readTransactionEvidence: async (hash) => {
      reads += 1;
      if (hash !== txHash) throw new Error('unexpected_hash');
      return c.transaction;
    },
    verifyActivityEvent: async (addr, event) => baseEconomicEvidence({
      transactionHash: event.txHash,
      logIndex: event.logIndex,
      blockNumber: event.blockNumber,
      fromAddress: addr.address,
      toAddress: event.toAddress,
      amountAtomic: event.amountAtomic,
      transactionSubmitter: c.submitter,
      transactionTo: c.txTo,
      blockTimestampMs: c.blockTimestampMs,
    }),
    emitActivityPE: async (_addr, event, activityType, _metadata, k) => {
      type = activityType;
      keying = k ?? 'log';
      return { peId: `pe_${event.txHash}`, peHash: 'h' };
    },
    now: () => 1_000_000,
  };
  const report = await scanOutboundUsdc(deps, { startBlock: 1000 });
  return { type, keying, reads, errors: report.errors };
}

function usdcSoldFor(asset: string, txTo: string, submitter = WALLET, received = 2n): BaseTransactionEvidence {
  const tx = testTxHash(`out:${asset}:${txTo}:${submitter}:${received}`);
  return transactionEvidence({
    transactionHash: tx,
    fromAddress: submitter,
    toAddress: txTo,
    logs: [
      transferLog(tx, BASE_USDC_ADDRESS, WALLET, SETTLER, 5_000_000n, 1),
      transferLog(tx, asset, SETTLER, WALLET, received, 2),
    ],
  });
}

describe('outbound USDC watcher — the swap label ', () => {
  it('GREEN: USDC → WETH through 0x after the landing is a SWAP keyed on its transaction (called it a send)', async () => {
    const out = await outboundLabel({
      txTo: ZEROX_ALLOWANCE_HOLDER_BASE, submitter: WALLET, blockTimestampMs: AFTER,
      transaction: usdcSoldFor(WETH_BASE, ZEROX_ALLOWANCE_HOLDER_BASE),
    });
    expect(out).toEqual({ type: 'swap', keying: 'transaction', reads: 1, errors: 0 });
  });

  it('RED: the same transaction mined before the landing keeps its old label (send), log-keyed, unread', async () => {
    const out = await outboundLabel({
      txTo: ZEROX_ALLOWANCE_HOLDER_BASE, submitter: WALLET, blockTimestampMs: BEFORE,
      transaction: usdcSoldFor(WETH_BASE, ZEROX_ALLOWANCE_HOLDER_BASE),
    });
    expect(out).toEqual({ type: 'send', keying: 'log', reads: 0, errors: 0 });
  });

  it('RED: through 0x after the landing but nothing different received → send', async () => {
    const out = await outboundLabel({
      txTo: ZEROX_ALLOWANCE_HOLDER_BASE, submitter: WALLET, blockTimestampMs: AFTER,
      transaction: usdcSoldFor(BASE_USDC_ADDRESS, ZEROX_ALLOWANCE_HOLDER_BASE),
    });
    expect(out).toEqual({ type: 'send', keying: 'log', reads: 1, errors: 0 });
  });

  it('RED: after the landing the Uniswap router alone no longer labels a swap — it must exchange', async () => {
    const exchanged = await outboundLabel({
      txTo: UNISWAP, submitter: WALLET, blockTimestampMs: AFTER, transaction: usdcSoldFor(WETH_BASE, UNISWAP),
    });
    const none = await outboundLabel({
      txTo: UNISWAP, submitter: WALLET, blockTimestampMs: AFTER, transaction: usdcSoldFor(WETH_BASE, UNISWAP, WALLET, 0n),
    });
    expect(exchanged.type).toBe('swap');
    expect(none.type).toBe('send');
  });

  it('GREEN (review r1 defect 3): USDC → native ETH through a Uniswap router is still a SWAP after the landing', async () => {
    const tx = testTxHash('out:usdc-to-eth');
    const transaction = transactionEvidence({
      transactionHash: tx, fromAddress: WALLET, toAddress: UNISWAP,
      logs: [
        transferLog(tx, BASE_USDC_ADDRESS, WALLET, SETTLER, 5_000_000n, 1),
        { ...transferLog(tx, WETH_BASE, SETTLER, UNISWAP, 1n, 2), topics: [WETH_WITHDRAWAL_TOPIC, `0x${UNISWAP.slice(2).padStart(64, '0')}`] },
      ],
    });
    const out = await outboundLabel({ txTo: UNISWAP, submitter: WALLET, blockTimestampMs: AFTER, transaction });
    expect(out).toEqual({ type: 'swap', keying: 'transaction', reads: 1, errors: 0 });
  });

  it('RED: a plain transfer to a stranger is a send and costs no second read', async () => {
    const out = await outboundLabel({
      txTo: BASE_USDC_ADDRESS, submitter: WALLET, blockTimestampMs: AFTER,
      transaction: usdcSoldFor(WETH_BASE, BASE_USDC_ADDRESS),
    });
    expect(out).toEqual({ type: 'send', keying: 'log', reads: 0, errors: 0 });
  });

  it('RED: a whole-transaction read that fails leaves the claim pending (no label guessed, nothing emitted)', async () => {
    const db = createFakeFirestore();
    const tx = usdcSoldFor(WETH_BASE, ZEROX_ALLOWANCE_HOLDER_BASE);
    let emitted = 0;
    const deps: OutboundUsdcScanDeps = {
      db: db as unknown as Firestore,
      chainId: 8453,
      chainName: 'base',
      getBlockNumber: async () => 1999,
      getLogs: async ({ fromBlock, toBlock }) => (1500 >= fromBlock && 1500 <= toBlock ? [{
        txHash: tx.transactionHash, logIndex: 1, blockNumber: 1500, fromAddress: WALLET, toAddress: SETTLER, amountAtomic: '5000000',
      }] : []),
      isDexRouter: () => false,
      isStakingContract: () => false,
      listWatchedAddresses: async () => [{ address: WALLET, walletId: 'w1', agentId: 'a1', provenAtBlock: 500, source: 'native_agent' }],
      readTransactionEvidence: async () => { throw new Error('economic_evidence_pending:safe_head:1/2'); },
      verifyActivityEvent: async (addr, event) => baseEconomicEvidence({
        transactionHash: event.txHash, logIndex: event.logIndex, blockNumber: event.blockNumber,
        fromAddress: addr.address, toAddress: event.toAddress, amountAtomic: event.amountAtomic,
        transactionSubmitter: WALLET, transactionTo: ZEROX_ALLOWANCE_HOLDER_BASE, blockTimestampMs: AFTER,
      }),
      emitActivityPE: async () => { emitted += 1; return { peId: 'x', peHash: 'h' }; },
      now: () => 1_000_000,
    };
    const report = await scanOutboundUsdc(deps, { startBlock: 1000 });
    expect(emitted).toBe(0);
    expect(report.errors).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// INBOUND
// ---------------------------------------------------------------------------

async function inboundLabel(c: {
  readonly submitter: string;
  readonly txTo: string;
  readonly blockTimestampMs: number;
  readonly transaction: BaseTransactionEvidence;
}): Promise<{ type: string | null; reads: number }> {
  const db = createFakeFirestore();
  const wallet: WatchedWallet = {
    walletId: 'w1', agentId: 'a1', address: WALLET, createdAtMs: 1_000, eligibilityStartBlock: 0,
  };
  let type: string | null = null;
  let reads = 0;
  const txHash = c.transaction.transactionHash;
  const deps: InboundUsdcScanDeps = {
    db: db as unknown as Firestore,
    chainId: 8453,
    chainName: 'base',
    getBlockNumber: async () => 999,
    getLogs: async ({ fromBlock, toBlock }) => (100 >= fromBlock && 100 <= toBlock ? [{
      txHash, logIndex: 2, blockNumber: 100, fromAddress: SETTLER, toAddress: WALLET, amountAtomic: '5000000',
    }] : []),
    listWatchedWallets: async () => [wallet],
    readTransactionEvidence: async () => { reads += 1; return c.transaction; },
    verifyFundingEvent: async (w, event) => baseEconomicEvidence({
      transactionHash: event.txHash,
      logIndex: event.logIndex,
      blockNumber: event.blockNumber,
      fromAddress: event.fromAddress,
      toAddress: w.address,
      amountAtomic: event.amountAtomic,
      transactionSubmitter: c.submitter,
      transactionTo: c.txTo,
      blockTimestampMs: c.blockTimestampMs,
    }),
    emitFundingPE: async (_w, event, _m, activityType) => {
      type = activityType ?? 'receive';
      return { peId: `pe_${event.txHash}`, peHash: 'h' };
    },
    now: () => 5_000,
  };
  await scanInboundUsdc(deps, { startBlock: 50 });
  return { type, reads };
}

function wethSoldForUsdc(submitter = WALLET, txTo = ZEROX_ALLOWANCE_HOLDER_BASE): BaseTransactionEvidence {
  const tx = testTxHash(`in:${submitter}:${txTo}`);
  return transactionEvidence({
    transactionHash: tx,
    fromAddress: submitter,
    toAddress: txTo,
    logs: [
      transferLog(tx, WETH_BASE, WALLET, SETTLER, 3n, 1),
      transferLog(tx, BASE_USDC_ADDRESS, SETTLER, WALLET, 5_000_000n, 2),
    ],
  });
}

describe('inbound USDC watcher — the proceeds of the wallet\'s own exchange are a swap ', () => {
  it('GREEN: WETH → USDC through 0x signed by the wallet → the USDC deposit is a SWAP, not a receive from the settler', async () => {
    const out = await inboundLabel({
      submitter: WALLET, txTo: ZEROX_ALLOWANCE_HOLDER_BASE, blockTimestampMs: AFTER, transaction: wethSoldForUsdc(),
    });
    expect(out).toEqual({ type: 'swap', reads: 1 });
  });

  it('RED: before the landing the same deposit stays a receive (unread)', async () => {
    const out = await inboundLabel({
      submitter: WALLET, txTo: ZEROX_ALLOWANCE_HOLDER_BASE, blockTimestampMs: BEFORE, transaction: wethSoldForUsdc(),
    });
    expect(out).toEqual({ type: 'receive', reads: 0 });
  });

  it('RED: USDC paid to the wallet in a stranger\'s transaction is a receive (unread)', async () => {
    const out = await inboundLabel({
      submitter: STRANGER, txTo: ZEROX_ALLOWANCE_HOLDER_BASE, blockTimestampMs: AFTER,
      transaction: wethSoldForUsdc(STRANGER),
    });
    expect(out).toEqual({ type: 'receive', reads: 0 });
  });

  it('RED: the wallet\'s own call to 0x that gave nothing different is a receive', async () => {
    const tx = testTxHash('in:refund');
    const refund = transactionEvidence({
      transactionHash: tx,
      fromAddress: WALLET,
      toAddress: ZEROX_ALLOWANCE_HOLDER_BASE,
      logs: [transferLog(tx, BASE_USDC_ADDRESS, SETTLER, WALLET, 5_000_000n, 2)],
    });
    const out = await inboundLabel({
      submitter: WALLET, txTo: ZEROX_ALLOWANCE_HOLDER_BASE, blockTimestampMs: AFTER, transaction: refund,
    });
    expect(out).toEqual({ type: 'receive', reads: 1 });
  });
});
