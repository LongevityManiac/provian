/**
 * Inbound USDC watcher - external-proven address extension (Unit 2).
 *
 * Confirms the no-retroactive-mint fence: a proven external address earns only
 * for activity at or after its stored next-block eligibility fence, while native wallets (no fence)
 * and the external address's own go-forward activity emit normally.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import {
  scanInboundUsdc,
  type InboundTransferLog,
  type WatchedWallet,
  type InboundUsdcScanDeps,
} from './inbound-usdc-watcher';
import { baseEconomicEvidence, testTxHash } from './__test-helpers__/base-economic-evidence';

const NATIVE: WatchedWallet = {
  walletId: 'wn',
  agentId: 'an',
  address: '0x1111111111111111111111111111111111111111',
  createdAtMs: 1_000,
  eligibilityStartBlock: 0,
};
const EXTERNAL: WatchedWallet = {
  walletId: 'ax', // per-wallet ledger keyed by agent id for external
  agentId: 'ax',
  address: '0x2222222222222222222222222222222222222222',
  createdAtMs: 1_000,
  isExternalProven: true,
  provenAtBlock: 200,
  eligibilityStartBlock: 200,
};

interface Captured {
  wallet: WatchedWallet;
  blockNumber: number;
}

function log(toAddress: string, blockNumber: number, txHash: string): InboundTransferLog {
  return {
    txHash: testTxHash(txHash),
    logIndex: 0,
    blockNumber,
    fromAddress: '0x3333333333333333333333333333333333333333',
    toAddress,
    amountAtomic: '5000000', // $5
  };
}

function makeDeps(fake: FakeFirestore, logs: InboundTransferLog[], captured: Captured[]): InboundUsdcScanDeps {
  return {
    db: fake as unknown as Firestore,
    chainId: 8453,
    chainName: 'base',
    getBlockNumber: async () => 100_000,
    getLogs: async () => logs,
    listWatchedWallets: async () => [NATIVE, EXTERNAL],
    verifyFundingEvent: async (wallet, event) => baseEconomicEvidence({
      transactionHash: event.txHash,
      logIndex: event.logIndex,
      blockNumber: event.blockNumber,
      fromAddress: event.fromAddress,
      toAddress: wallet.address,
      amountAtomic: event.amountAtomic,
    }),
    emitFundingPE: async (wallet, event) => {
      captured.push({ wallet, blockNumber: event.blockNumber });
      return { peId: `pe_${event.txHash}`, peHash: 'h' };
    },
    now: () => 5_000,
  };
}

describe('scanInboundUsdc - external no-retro fence', () => {
  it('gives same-head activity zero and emits exactly from the H+1 fence', async () => {
    const fake = createFakeFirestore();
    const captured: Captured[] = [];
    const logs = [
      log(EXTERNAL.address, 199, '0xhead'), // proof head H -> SKIP
      log(EXTERNAL.address, 200, '0xhplus1'), // eligibility fence H+1 -> EMIT
    ];
    const report = await scanInboundUsdc(makeDeps(fake, logs, captured), { startBlock: 0, minConfirmations: 0, blockChunk: 10_000_000, maxBlocksPerRun: 10_000_000 });

    expect(report.pre_proof_skipped).toBe(1);
    expect(report.pes_emitted).toBe(1);
    expect(captured).toHaveLength(1);
    expect(captured[0].blockNumber).toBe(200);
    expect(captured[0].wallet.isExternalProven).toBe(true);
  });

  it('applies no fence to native wallets (they have no prior history)', async () => {
    const fake = createFakeFirestore();
    const captured: Captured[] = [];
    const logs = [
      log(NATIVE.address, 1, '0xnative-early'), // native: no provenAtBlock -> EMIT
    ];
    const report = await scanInboundUsdc(makeDeps(fake, logs, captured), { startBlock: 0, minConfirmations: 0, blockChunk: 10_000_000, maxBlocksPerRun: 10_000_000 });

    expect(report.pre_proof_skipped).toBe(0);
    expect(report.pes_emitted).toBe(1);
    expect(captured[0].wallet.isExternalProven).toBeFalsy();
  });

  it('a proven address with ONLY pre-proof activity earns nothing', async () => {
    const fake = createFakeFirestore();
    const captured: Captured[] = [];
    const logs = [
      log(EXTERNAL.address, 50, '0xa'),
      log(EXTERNAL.address, 199, '0xb'),
    ];
    const report = await scanInboundUsdc(makeDeps(fake, logs, captured), { startBlock: 0, minConfirmations: 0, blockChunk: 10_000_000, maxBlocksPerRun: 10_000_000 });

    expect(report.pre_proof_skipped).toBe(2);
    expect(report.pes_emitted).toBe(0);
    expect(captured).toHaveLength(0);
  });
});
