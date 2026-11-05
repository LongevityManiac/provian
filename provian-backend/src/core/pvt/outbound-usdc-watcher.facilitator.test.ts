/**
 * — the outbound USDC watcher labels the PAYMENT leg of a Provian facilitator
 * settlement `x402_payment` (so it seals under the same x402 claim the facilitator lane uses), and
 * leaves the seller's fee leg exactly as it was. Driven through `scanOutboundUsdc` with injected
 * chain reads; the label is what the injected emit receives.
 */
import { describe, it, expect } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import { baseEconomicEvidence, testTxHash } from './__test-helpers__/base-economic-evidence';
import { transactionEvidence, transferLog, topicOf } from './__test-helpers__/base-transaction-evidence';
import { BASE_USDC_ADDRESS, type BaseTransactionEvidence, type CanonicalEconomicLog } from '../onchain/economic-discovery';
import {
  scanOutboundUsdc,
  type OutboundActivityType,
  type OutboundTransferLog,
  type OutboundUsdcScanDeps,
} from './outbound-usdc-watcher';
import { FEE_SETTLED_TOPIC } from './x402-facilitator-settlement';

const BUYER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SELLER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SETTLER = '0x5e77100000000000000000000000000000000b01';
const FEE = '0xa37fc594e98e951571c771c9e77cdc73f67d3efb';
const TX = testTxHash('facilitator-settlement');

function feeSettled(buyer: string, seller: string, value: bigint): CanonicalEconomicLog {
  return {
    ...transferLog(TX, SETTLER, buyer, seller, 0n, 3),
    topics: [FEE_SETTLED_TOPIC, topicOf(buyer), topicOf(seller), topicOf(BASE_USDC_ADDRESS)],
    data: `0x${value.toString(16).padStart(64, '0')}${(300n).toString(16).padStart(64, '0')}`,
  };
}

function wholeTx(withFeeSettled: boolean): BaseTransactionEvidence {
  return transactionEvidence({
    transactionHash: TX, fromAddress: FEE, toAddress: SETTLER, blockTimestampMs: 1_000_000,
    logs: [
      transferLog(TX, BASE_USDC_ADDRESS, BUYER, SELLER, 1_000_000n, 1),
      transferLog(TX, BASE_USDC_ADDRESS, SELLER, FEE, 300n, 2),
      ...(withFeeSettled ? [feeSettled(BUYER, SELLER, 1_000_000n)] : []),
    ],
  });
}

async function scan(opts: {
  watched: 'buyer' | 'seller';
  settler: string | null;
  withFeeSettled?: boolean;
  reader?: boolean;
}): Promise<{ labels: OutboundActivityType[]; errors: number; metadata: Record<string, unknown>[] }> {
  const db = createFakeFirestore();
  const watchedAddress = opts.watched === 'buyer' ? BUYER : SELLER;
  const log: OutboundTransferLog = opts.watched === 'buyer'
    ? { txHash: TX, logIndex: 1, blockNumber: 1500, fromAddress: BUYER, toAddress: SELLER, amountAtomic: '1000000' }
    : { txHash: TX, logIndex: 2, blockNumber: 1500, fromAddress: SELLER, toAddress: FEE, amountAtomic: '300' };
  const labels: OutboundActivityType[] = [];
  const metadata: Record<string, unknown>[] = [];
  const deps: OutboundUsdcScanDeps = {
    db: db as unknown as Firestore,
    chainId: 8453,
    chainName: 'base',
    getBlockNumber: async () => 1999,
    getLogs: async ({ fromBlock, toBlock }) => (log.blockNumber >= fromBlock && log.blockNumber <= toBlock ? [log] : []),
    isDexRouter: () => false,
    isStakingContract: () => false,
    listWatchedAddresses: async () => [{
      address: watchedAddress, walletId: 'w1', agentId: 'agent1', provenAtBlock: 500, source: 'native_agent',
    }],
    facilitatorSettler: opts.settler,
    ...(opts.reader === false ? {} : { readTransactionEvidence: async () => wholeTx(opts.withFeeSettled ?? true) }),
    verifyActivityEvent: async (addr, event) => baseEconomicEvidence({
      transactionHash: event.txHash,
      logIndex: event.logIndex,
      blockNumber: event.blockNumber,
      fromAddress: addr.address,
      toAddress: event.toAddress,
      amountAtomic: event.amountAtomic,
      transactionSubmitter: FEE,
      transactionTo: SETTLER,
      transactionSelector: '0x12345678',
      blockTimestampMs: 1_000_000,
    }),
    emitActivityPE: async (_addr, event, activityType, meta) => {
      labels.push(activityType);
      metadata.push(meta);
      return { peId: `pe_${event.logIndex}`, peHash: 'h' };
    },
    now: () => 1_000_000,
  };
  const report = await scanOutboundUsdc(deps, { startBlock: 1000 });
  return { labels, errors: report.errors, metadata };
}

describe('outbound USDC watcher × the x402 facilitator settler', () => {
  it('GREEN: the buyer\'s payment leg through the settler is labelled x402_payment', async () => {
    expect((await scan({ watched: 'buyer', settler: SETTLER })).labels).toEqual(['x402_payment']);
  });

  it('RED: the seller\'s fee leg in the same transaction stays a send', async () => {
    expect((await scan({ watched: 'seller', settler: SETTLER })).labels).toEqual(['send']);
  });

  it('RED: with no settler configured the same leg is a send (the pre-B1 label)', async () => {
    expect((await scan({ watched: 'buyer', settler: null })).labels).toEqual(['send']);
  });

  it('RED: a settler transaction without FeeSettled naming the leg stays a send', async () => {
    expect((await scan({ watched: 'buyer', settler: SETTLER, withFeeSettled: false })).labels).toEqual(['send']);
  });

  it('Unknown = Block: without the whole-transaction reader the leg is NOT emitted (kept pending)', async () => {
    const result = await scan({ watched: 'buyer', settler: SETTLER, reader: false });
    expect(result.labels).toEqual([]);
    expect(result.errors).toBeGreaterThan(0);
  });
});
