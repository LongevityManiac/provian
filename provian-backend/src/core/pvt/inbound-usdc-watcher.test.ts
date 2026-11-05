/**
 * Inbound USDC watcher tests (genesis Part A).
 *
 * Covers: pure amount/bucket helpers, detection + funding-PE emission,
 * dust skip, exactly-once dedup (in-run and across a re-scan), checkpoint
 * advance, farm-likelihood metadata (first-funding, burst, source fan-out,
 * circular-source hint), bounty_eligible stamping (decoupled from emission),
 * and claim-release on emit failure.
 */

import crypto from 'crypto';
import stableStringify from 'json-stable-stringify';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import {
  scanInboundUsdc,
  atomicUsdcToUsd,
  amountBucket,
  type InboundTransferLog,
  type WatchedWallet,
  type InboundUsdcScanDeps,
} from './inbound-usdc-watcher';
import { baseEconomicEvidence, testTxHash } from './__test-helpers__/base-economic-evidence';
import {
  hashBaseUsdcTransferEvidence,
  type BaseUsdcTransferEvidence,
} from '../onchain/economic-discovery';

const WALLET: WatchedWallet = {
  walletId: 'w1',
  agentId: 'a1',
  address: '0x1111111111111111111111111111111111111111',
  createdAtMs: 1_000,
  eligibilityStartBlock: 0,
};
const SOURCE = '0x2222222222222222222222222222222222222222';

function log(overrides: Partial<InboundTransferLog> = {}): InboundTransferLog {
  return {
    txHash: testTxHash(overrides.txHash ?? 'tx'),
    logIndex: overrides.logIndex ?? 0,
    blockNumber: overrides.blockNumber ?? 100,
    fromAddress: overrides.fromAddress ?? SOURCE,
    toAddress: overrides.toAddress ?? WALLET.address,
    amountAtomic: overrides.amountAtomic ?? '5000000', // $5
  };
}

interface Captured {
  wallet: WatchedWallet;
  event: { txHash: string; amountUsd: number; fromAddress: string };
  metadata: Record<string, unknown>;
}

function makeDeps(
  fake: FakeFirestore,
  logs: InboundTransferLog[],
  opts: {
    head?: number;
    wallets?: WatchedWallet[];
    emitThrows?: boolean;
    captured?: Captured[];
    verificationError?: Error;
  } = {},
): InboundUsdcScanDeps {
  return {
    db: fake as unknown as Firestore,
    chainId: 8453,
    chainName: 'base',
    getBlockNumber: async () => opts.head ?? 999,
    getLogs: async ({ fromBlock, toBlock, toAddresses }) => {
      const addresses = new Set(toAddresses.map((address) => address.toLowerCase()));
      return logs.filter((entry) => entry.blockNumber >= fromBlock
        && entry.blockNumber <= toBlock
        && addresses.has(entry.toAddress.toLowerCase()));
    },
    listWatchedWallets: async () => opts.wallets ?? [WALLET],
    verifyFundingEvent: async (wallet, event) => {
      if (opts.verificationError) throw opts.verificationError;
      return baseEconomicEvidence({
        transactionHash: event.txHash,
        logIndex: event.logIndex,
        blockNumber: event.blockNumber,
        fromAddress: event.fromAddress,
        toAddress: wallet.address,
        amountAtomic: event.amountAtomic,
      });
    },
    emitFundingPE: async (wallet, event, metadata) => {
      if (opts.emitThrows) throw new Error('emit boom');
      opts.captured?.push({ wallet, event: { txHash: event.txHash, amountUsd: event.amountUsd, fromAddress: event.fromAddress }, metadata });
      return { peId: `pe_${event.txHash}_${event.logIndex}`, peHash: 'h' };
    },
    now: () => 5_000,
  };
}

function resealClaimPayload(row: Record<string, unknown>): void {
  row.payload_hash = `0x${crypto.createHash('sha256')
    .update(stableStringify(row.payload)!)
    .digest('hex')}`;
}

describe('inbound-usdc-watcher', () => {
  describe('pure helpers', () => {
    it('atomicUsdcToUsd converts 6-decimal atomic to USD', () => {
      expect(atomicUsdcToUsd('5000000')).toBeCloseTo(5);
      expect(atomicUsdcToUsd('1500000000')).toBeCloseTo(1500);
      expect(atomicUsdcToUsd('5000')).toBeCloseTo(0.005);
      expect(atomicUsdcToUsd('not-a-number')).toBe(0);
    });

    it('amountBucket classifies coarsely', () => {
      expect(amountBucket(0.005)).toBe('dust');
      expect(amountBucket(0.5)).toBe('micro');
      expect(amountBucket(5)).toBe('small');
      expect(amountBucket(50)).toBe('medium');
      expect(amountBucket(500)).toBe('large');
      expect(amountBucket(5000)).toBe('xl');
      expect(amountBucket(50000)).toBe('whale');
    });
  });

  it('detects a deposit, emits one funding PE with farm metadata, advances checkpoint', async () => {
    const fake = createFakeFirestore();
    const captured: Captured[] = [];
    const report = await scanInboundUsdc(makeDeps(fake, [log()], { captured }), { startBlock: 50 });

    expect(report.pes_emitted).toBe(1);
    expect(report.new_fundings).toBe(1);
    expect(captured).toHaveLength(1);

    const m = captured[0].metadata;
    expect(m.funding_source).toBe(SOURCE.toLowerCase());
    expect(m.amount_usd).toBeCloseTo(5);
    expect(m.amount_bucket).toBe('small');
    expect(m.is_first_funding).toBe(true);
    expect(m.wallet_funding_count).toBe(1);
    expect(m.ms_since_wallet_creation).toBe(4_000); // now 5000 - createdAt 1000
    expect(m.source_is_watched_agent).toBe(false);
    expect(m.bounty_eligible).toBe(false); // funding bounties are retired
    expect(m.chain).toBe('base');

    // Base economic finality cannot be configured below 12 confirmations.
    expect(fake.store.get('genesis_inbound_checkpoints/8453')).toMatchObject({ last_processed_block: 988 });
  });

  it('includes H-11 and excludes H-10 under the inclusive 12-confirmation rule', async () => {
    const fake = createFakeFirestore();
    const captured: Captured[] = [];
    const logs = [
      log({ txHash: '0xh-minus-11', blockNumber: 100 }),
      log({ txHash: '0xh-minus-10', blockNumber: 101, logIndex: 1 }),
    ];
    const report = await scanInboundUsdc(
      makeDeps(fake, logs, { captured, head: 111 }),
      { startBlock: 100 },
    );

    expect(report.to_block).toBe(100);
    expect(captured.map((entry) => entry.event.txHash))
      .toEqual([testTxHash('0xh-minus-11')]);
  });

  it('applies maxBlocksPerRun to the inclusive range exactly', async () => {
    const fake = createFakeFirestore();
    const atStart = { ...WALLET, eligibilityStartBlock: 50 };
    const report = await scanInboundUsdc(
      makeDeps(fake, [], { head: 999, wallets: [atStart] }),
      { startBlock: 50, maxBlocksPerRun: 10 },
    );
    expect(report).toMatchObject({ from_block: 50, to_block: 59 });
    expect(fake.store.get('genesis_inbound_checkpoints/8453'))
      .toMatchObject({ last_processed_block: 59 });
  });

  it(' addendum — never asks a provider for more than the free-tier 10-block getLogs range', async () => {
    const fake = createFakeFirestore();
    const live = { ...WALLET, eligibilityStartBlock: 900 };
    const deps = makeDeps(fake, [], { wallets: [live] });
    const spans: Array<[number, number]> = [];
    const inner = deps.getLogs;
    // A guard-fake speaking Alchemy's own refusal — the same 400 that killed
    // the first live inbound scan the moment the recovery wedge cleared.
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
    const report = await scanInboundUsdc(deps, { startBlock: 900, blockChunk: 10 });
    expect(spans.length).toBeGreaterThan(0);
    for (const [from, to] of spans) expect(to - from + 1).toBeLessThanOrEqual(10);
    expect(report).toMatchObject({ budget_stopped: false });
    expect(fake.store.get('genesis_inbound_checkpoints/8453'))
      .toMatchObject({ last_processed_block: 988 });
  });

  it(' addendum — a call budget stops on a whole window and resumes exactly there', async () => {
    const fake = createFakeFirestore();
    const live = { ...WALLET, eligibilityStartBlock: 900 };
    const first = await scanInboundUsdc(
      makeDeps(fake, [], { wallets: [live] }),
      { startBlock: 900, maxLogCallsPerRun: 3, blockChunk: 10 },
    );
    expect(first).toMatchObject({ budget_stopped: true, log_calls_used: 3 });
    expect(fake.store.get('genesis_inbound_checkpoints/8453'))
      .toMatchObject({ last_processed_block: 929 });

    const second = await scanInboundUsdc(
      makeDeps(fake, [], { wallets: [live] }),
      { maxLogCallsPerRun: 3, blockChunk: 10 },
    );
    expect(second).toMatchObject({ budget_stopped: true, log_calls_used: 3 });
    expect(fake.store.get('genesis_inbound_checkpoints/8453'))
      .toMatchObject({ last_processed_block: 959 });
  });

  it('preserves a null cursor when ownership fails on block zero', async () => {
    const fake = createFakeFirestore({
      failCreateOnce: {
        collection: 'genesis_inbound_seen',
        error: Object.assign(new Error('unavailable'), { code: 14 }),
      },
    });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const report = await scanInboundUsdc(
        makeDeps(fake, [log({ txHash: '0xblock-zero', blockNumber: 0 })], { head: 11 }),
        { startBlock: 0 },
      );
      expect(report).toMatchObject({ errors: 1, from_block: 0, to_block: 0 });
      expect(fake.store.get('genesis_inbound_checkpoints/8453'))
        .toMatchObject({ last_processed_block: null });
    } finally {
      consoleError.mockRestore();
    }
  });

  it('rejects duplicate address ownership before watcher admission or checkpoint advance', async () => {
    const fake = createFakeFirestore();
    const conflicting = { ...WALLET, walletId: 'w-conflict', agentId: 'a-conflict' };
    await expect(scanInboundUsdc(
      makeDeps(fake, [], { wallets: [WALLET, conflicting] }),
      { startBlock: 50 },
    )).rejects.toThrow(`watched_address_enumeration_duplicate:${WALLET.address}`);
    expect([...fake.store.keys()].some((key) =>
      key.startsWith('pvt_watcher_address_admissions_v1/')
      || key.startsWith('genesis_inbound_checkpoints/'))).toBe(false);
  });

  it('records every finalized amount while keeping amounts metadata-only', async () => {
    const fake = createFakeFirestore();
    const captured: Captured[] = [];
    const logs = [
      log({ txHash: '0xdust', amountAtomic: '5000' }),
      log({ txHash: '0xsmall', amountAtomic: '500000' }),
    ];
    const report = await scanInboundUsdc(makeDeps(fake, logs, { captured }), { startBlock: 50 });

    expect(report.dust_skipped).toBe(0);
    expect(report.pes_emitted).toBe(2);
    expect(captured.map((entry) => entry.metadata.amount_usd)).toEqual([0.005, 0.5]);
    expect(captured.every((entry) => entry.metadata.bounty_eligible === false)).toBe(true);
  });

  it('dedups duplicate logs within one run (exactly-once emit)', async () => {
    const fake = createFakeFirestore();
    const captured: Captured[] = [];
    const report = await scanInboundUsdc(makeDeps(fake, [log(), log()], { captured }), { startBlock: 50 });
    expect(report.pes_emitted).toBe(1);
    expect(report.duplicates_skipped).toBe(1);
    expect(captured).toHaveLength(1);
  });

  it('dedups across a re-scan of the same range (crash-recovery property)', async () => {
    const fake = createFakeFirestore();
    const captured: Captured[] = [];
    await scanInboundUsdc(makeDeps(fake, [log()], { captured }), { startBlock: 50 });
    expect(captured).toHaveLength(1);

    // Simulate a re-scan over the same block: rewind the checkpoint.
    fake.store.set('genesis_inbound_checkpoints/8453', {
      ...fake.store.get('genesis_inbound_checkpoints/8453'),
      last_processed_block: 50,
    });
    const report2 = await scanInboundUsdc(makeDeps(fake, [log()], { captured }), { startBlock: 50 });
    expect(report2.duplicates_skipped).toBe(1);
    expect(captured).toHaveLength(1); // no second emit
  });

  it('holds the checkpoint when an existing claim is malformed instead of suppressing the event', async () => {
    const fake = createFakeFirestore();
    const captured: Captured[] = [];
    const transfer = log();
    await scanInboundUsdc(makeDeps(fake, [transfer], { captured }), { startBlock: 50 });
    const claimKey = `genesis_inbound_seen/8453_${transfer.txHash}_0`;
    const malformed = { ...fake.store.get(claimKey)! };
    delete malformed.payload_hash;
    fake.store.set(claimKey, malformed);
    fake.store.set('genesis_inbound_checkpoints/8453', {
      ...fake.store.get('genesis_inbound_checkpoints/8453'),
      last_processed_block: 50,
    });
    // the daily full integrity pass (the clean pass the first run recorded has aged out)
    // pages every claim and blocks the lane on the malformed one, exactly as every run used to.
    fake.store.delete('watcher_recovery_integrity_v1/genesis_inbound_seen');
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const report = await scanInboundUsdc(
        makeDeps(fake, [transfer], { captured }),
        { startBlock: 50 },
      );
      expect(report).toMatchObject({
        duplicates_skipped: 0,
        pes_emitted: 0,
      });
      expect(report.errors).toBeGreaterThanOrEqual(1);
      expect(captured).toHaveLength(1);
      expect(fake.store.get('genesis_inbound_checkpoints/8453'))
        .toMatchObject({ last_processed_block: 50 });
      expect(consoleError).toHaveBeenCalledWith(
        '[inbound-usdc] malformed durable recovery claim',
        expect.objectContaining({ documentId: claimKey.split('/')[1] }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('treats transient Firestore create failure as an error, not a duplicate', async () => {
    const fake = createFakeFirestore({
      failCreateOnce: {
        collection: 'genesis_inbound_seen',
        error: Object.assign(new Error('unavailable'), { code: 14 }),
      },
    });
    const captured: Captured[] = [];
    const first = await scanInboundUsdc(makeDeps(fake, [log()], { captured }), { startBlock: 50 });
    expect(first).toMatchObject({ errors: 1, duplicates_skipped: 0, pes_emitted: 0 });
    expect(fake.store.get(`genesis_inbound_seen/8453_${testTxHash('tx')}_0`)).toBeUndefined();
    expect(fake.store.get('genesis_inbound_checkpoints/8453')).toMatchObject({
      last_processed_block: 99,
    });

    const second = await scanInboundUsdc(makeDeps(fake, [log()], { captured }), {});
    expect(second.pes_emitted).toBe(1);
    expect(captured).toHaveLength(1);
  });

  it('tracks first-funding, burst, and source fan-out across deposits', async () => {
    const fake = createFakeFirestore();
    const captured: Captured[] = [];
    // Two deposits to the same wallet from the same source, plus one to a second
    // wallet from the same source (fan-out).
    const w2: WatchedWallet = {
      walletId: 'w2',
      agentId: 'a2',
      address: '0x3333333333333333333333333333333333333333',
      createdAtMs: 2_000,
      eligibilityStartBlock: 0,
    };
    const logs = [
      log({ txHash: '0xt1', logIndex: 0, blockNumber: 100 }),
      log({ txHash: '0xt2', logIndex: 1, blockNumber: 101 }),
      log({ txHash: '0xt3', logIndex: 0, blockNumber: 102, toAddress: w2.address }),
    ];
    await scanInboundUsdc(makeDeps(fake, logs, { captured, wallets: [WALLET, w2] }), { startBlock: 50 });

    expect(captured).toHaveLength(3);
    const [first, second, third] = captured;
    expect(first.metadata.is_first_funding).toBe(true);
    expect(second.metadata.is_first_funding).toBe(false);
    expect(second.metadata.wallet_funding_count).toBe(2);
    expect(second.metadata.ms_since_prev_funding).toBe(0); // same `now`
    // source fan-out counter increments per funding from the source
    expect(first.metadata.source_funding_count).toBe(1);
    expect(second.metadata.source_funding_count).toBe(2);
    expect(third.metadata.source_funding_count).toBe(3);
    expect(third.metadata.is_first_funding).toBe(true); // first for w2
  });

  it('flags circular source when the funder is itself a watched agent wallet', async () => {
    const fake = createFakeFirestore();
    const captured: Captured[] = [];
    const funder: WatchedWallet = {
      walletId: 'wF',
      agentId: 'aF',
      address: '0x4444444444444444444444444444444444444444',
      createdAtMs: 100,
      eligibilityStartBlock: 0,
    };
    const logs = [log({ txHash: '0xcirc', fromAddress: funder.address })];
    await scanInboundUsdc(makeDeps(fake, logs, { captured, wallets: [WALLET, funder] }), { startBlock: 50 });
    expect(captured[0].metadata.source_is_watched_agent).toBe(true);
  });

  it('keeps a durable recovery claim when emit fails', async () => {
    const fake = createFakeFirestore();
    const report = await scanInboundUsdc(makeDeps(fake, [log()], { emitThrows: true }), { startBlock: 50 });
    expect(report.errors).toBe(1);
    expect(report.pes_emitted).toBe(0);
    expect(fake.store.get(`genesis_inbound_seen/8453_${testTxHash('tx')}_0`)).toMatchObject({
      state: 'pending_reverification',
      pe_id: null,
    });
  });

  it('advances the block cursor only after durable ownership and recovers a failed emit from its claim', async () => {
    const fake = createFakeFirestore();
    const captured: Captured[] = [];
    const logs = [
      log({ txHash: '0xok', logIndex: 0, blockNumber: 101 }),
      log({ txHash: '0xbad', logIndex: 0, blockNumber: 102 }),
    ];
    const deps = makeDeps(fake, logs, { captured });
    // Block 101 emits fine; block 102's emit throws transiently.
    deps.emitFundingPE = async (wallet, event, metadata) => {
      if (event.txHash === testTxHash('0xbad')) throw new Error('emit boom');
      captured.push({
        wallet,
        event: { txHash: event.txHash, amountUsd: event.amountUsd, fromAddress: event.fromAddress },
        metadata,
      });
      return { peId: `pe_${event.txHash}`, peHash: 'h' };
    };

    const report = await scanInboundUsdc(deps, { startBlock: 50 });
    expect(report.pes_emitted).toBe(1);
    expect(report.errors).toBe(1);
    expect(fake.store.get('genesis_inbound_checkpoints/8453')).toMatchObject({ last_processed_block: 988 });
    expect(fake.store.get(`genesis_inbound_seen/8453_${testTxHash('0xbad')}_0`)).toMatchObject({
      state: 'pending_reverification',
    });
    expect(fake.store.get(`genesis_inbound_seen/8453_${testTxHash('0xok')}_0`)).toMatchObject({ state: 'complete' });

    // The next run has no logs to re-scan. Recovery leases the stored payload and
    // emits the missing PE independently of the advanced block checkpoint.
    const report2 = await scanInboundUsdc(makeDeps(fake, [], { captured }), {});
    expect(report2.pes_emitted).toBe(1);
    expect(fake.store.get(`genesis_inbound_seen/8453_${testTxHash('0xbad')}_0`)).toMatchObject({ state: 'complete' });
    expect(fake.store.get('genesis_inbound_checkpoints/8453')).toMatchObject({ last_processed_block: 988 });
  });

  it.each([
    ['attribution', (payload: Record<string, unknown>) => {
      (payload.wallet as Record<string, unknown>).agentId = 'attacker-agent';
    }],
    ['USD value', (payload: Record<string, unknown>) => {
      (payload.event as Record<string, unknown>).amountUsd = 500_000;
    }],
    ['unknown payload field', (payload: Record<string, unknown>) => {
      payload.unknown = true;
    }],
  ])('rejects self-consistently resealed %s corruption during recovery', async (_name, mutate) => {
    const fake = createFakeFirestore();
    await scanInboundUsdc(makeDeps(fake, [log()], { emitThrows: true }), { startBlock: 50 });
    const key = `genesis_inbound_seen/8453_${testTxHash('tx')}_0`;
    const row = fake.store.get(key)!;
    mutate(row.payload as Record<string, unknown>);
    resealClaimPayload(row);

    const captured: Captured[] = [];
    const recovered = await scanInboundUsdc(makeDeps(fake, [], { captured }), {});
    expect(recovered).toMatchObject({ pes_emitted: 0, errors: 1 });
    expect(captured).toEqual([]);
    expect(fake.store.get(key)).toMatchObject({ state: 'pending_reverification', pe_id: null });
  });

  it('re-reads Base and rejects a self-consistently rewritten finality snapshot', async () => {
    const fake = createFakeFirestore();
    await scanInboundUsdc(makeDeps(fake, [log()], { emitThrows: true }), { startBlock: 50 });
    const key = `genesis_inbound_seen/8453_${testTxHash('tx')}_0`;
    const row = fake.store.get(key)!;
    const evidence = row.evidence_snapshot as BaseUsdcTransferEvidence;
    const { evidenceHash: _oldHash, ...withoutHash } = evidence;
    const rewritten = { ...withoutHash, blockNumber: withoutHash.blockNumber + 1 };
    row.evidence_snapshot = {
      ...rewritten,
      evidenceHash: hashBaseUsdcTransferEvidence(rewritten),
    };

    const captured: Captured[] = [];
    const recovered = await scanInboundUsdc(makeDeps(fake, [], { captured }), {});
    expect(recovered).toMatchObject({ pes_emitted: 0, errors: 1 });
    expect(captured).toEqual([]);
    expect(fake.store.get(key)).toMatchObject({ state: 'pending_reverification', pe_id: null });
  });

  it('persists provider disagreement without emitting and succeeds on durable re-verification', async () => {
    const fake = createFakeFirestore();
    const captured: Captured[] = [];
    const first = await scanInboundUsdc(makeDeps(fake, [log()], {
      captured,
      verificationError: new Error('economic_discovery_rpc_disagreement:receipt'),
    }), { startBlock: 50 });
    expect(first).toMatchObject({ pes_emitted: 0, errors: 1 });
    expect(captured).toHaveLength(0);
    expect(fake.store.get(`genesis_inbound_seen/8453_${testTxHash('tx')}_0`)).toMatchObject({
      state: 'pending_reverification',
    });

    const recovered = await scanInboundUsdc(makeDeps(fake, [], { captured }), {});
    expect(recovered.pes_emitted).toBe(1);
    expect(captured).toHaveLength(1);
    expect(fake.store.get(`genesis_inbound_seen/8453_${testTxHash('tx')}_0`)).toMatchObject({ state: 'complete' });
  });

  it('requires the full 12-confirmation Base boundary during recovery', async () => {
    const fake = createFakeFirestore();
    const first = await scanInboundUsdc(makeDeps(fake, [log()], {
      verificationError: new Error('economic_evidence_pending:confirmations:11/12'),
    }), { startBlock: 50 });
    expect(first).toMatchObject({ pes_emitted: 0, errors: 1 });
    const recovered = await scanInboundUsdc(makeDeps(fake, [], {
    }), {});
    expect(recovered.pes_emitted).toBe(1);
  });

  it('keeps bounty_eligible=false even when a deprecated funding threshold is supplied', async () => {
    const fake = createFakeFirestore();
    await scanInboundUsdc(makeDeps(fake, [log({ txHash: '0xe', amountAtomic: '5000000' })]), { startBlock: 50 }); // $5
    expect(fake.store.get('genesis_wallet_funding/w1')).toMatchObject({ bounty_eligible: false });
  });

  it('leaves bounty_eligible=false for sub-funding-min deposits (L-1)', async () => {
    const fake = createFakeFirestore();
    await scanInboundUsdc(makeDeps(fake, [log({ txHash: '0xne', amountAtomic: '500000' })]), { startBlock: 50 }); // $0.50
    expect(fake.store.get('genesis_wallet_funding/w1')).toMatchObject({ bounty_eligible: false });
  });

  it('accumulates genesis bounty grants into the report', async () => {
    const fake = createFakeFirestore();
    const deps = makeDeps(fake, [log({ txHash: '0xa' }), log({ txHash: '0xb', logIndex: 1 })]);
    deps.emitFundingPE = async () => ({ peId: 'pe', peHash: 'h', bountyPvt: 750 });
    const report = await scanInboundUsdc(deps, { startBlock: 50 });
    expect(report.pes_emitted).toBe(2);
    expect(report.bounty_pvt_granted).toBeCloseTo(1500);
  });

  it('advances the cursor to head with no wallets to watch (does not freeze)', async () => {
    const fake = createFakeFirestore();
    const report = await scanInboundUsdc(makeDeps(fake, [log()], { wallets: [] }), { startBlock: 50 });
    expect(report.watched_wallets).toBe(0);
    expect(report.pes_emitted).toBe(0);
    // / silent-freeze class fix, parity with the outbound watcher: an
    // empty watched set advances the durable cursor to head - minConf instead of
    // returning early and freezing it. head defaults to 999, minConf 12 → 988.
    // A regression to the old `if (empty) return report` leaves this doc absent.
    expect(fake.store.get('genesis_inbound_checkpoints/8453')).toMatchObject({
      last_processed_block: 988,
    });
  });

  // ===========================================================================
  // SKIP-CYCLE-NOT-CRASH on two-provider disagreement (2026-08-16
  // production-effect audit, item 3): a disagreement that survives
  // economic-discovery's bounded both-legs re-poll ends the cycle as a logged
  // 200 report instead of a thrown 500 — the checkpoint is untouched beyond
  // already-committed segments and the next tick resumes exactly there. The
  // catch matches ONLY the `economic_discovery_rpc_disagreement` class; every
  // other error stays loud. RED control, recorded in the commit: with the
  // narrow catch reverted, the first two tests fail because the scan throws.
  // ===========================================================================
  describe('skip-cycle-not-crash on two-provider disagreement', () => {
    const checkpoint = () => ({
      chain_id: 8453,
      last_processed_block: 100,
      membership_generation: 0,
      updated_at: 1,
    });

    it('a persistent head disagreement resolves with errors=1 and an untouched checkpoint', async () => {
      const fake = createFakeFirestore();
      fake.store.set('genesis_inbound_checkpoints/8453', checkpoint());
      const deps = makeDeps(fake, [log()]);
      deps.getBlockNumber = async () => {
        throw new Error('economic_discovery_rpc_disagreement:head');
      };
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const report = await scanInboundUsdc(deps);
        expect(report.errors).toBe(1);
        expect(report.pes_emitted).toBe(0);
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('cycle skipped'),
          expect.objectContaining({ message: 'economic_discovery_rpc_disagreement:head' }),
        );
      } finally {
        errorSpy.mockRestore();
      }
      expect(fake.store.get('genesis_inbound_checkpoints/8453'))
        .toMatchObject({ last_processed_block: 100 });
    });

    it('a getLogs disagreement ends the cycle as a logged report with the checkpoint held', async () => {
      const fake = createFakeFirestore();
      fake.store.set('genesis_inbound_checkpoints/8453', checkpoint());
      const deps = makeDeps(fake, [log()]);
      deps.getLogs = async () => {
        throw new Error('economic_discovery_rpc_disagreement:logs');
      };
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const report = await scanInboundUsdc(deps);
        expect(report.errors).toBe(1);
      } finally {
        errorSpy.mockRestore();
      }
      expect(fake.store.get('genesis_inbound_checkpoints/8453'))
        .toMatchObject({ last_processed_block: 100 });
    });

    it('NEGATIVE CONTROL — any other head-read error class still throws (the catch is narrow)', async () => {
      const fake = createFakeFirestore();
      fake.store.set('genesis_inbound_checkpoints/8453', checkpoint());
      const deps = makeDeps(fake, [log()]);
      deps.getBlockNumber = async () => {
        throw new Error('provider_unavailable');
      };
      await expect(scanInboundUsdc(deps)).rejects.toThrow('provider_unavailable');
      expect(fake.store.get('genesis_inbound_checkpoints/8453'))
        .toMatchObject({ last_processed_block: 100 });
    });

    it('NEGATIVE CONTROL — a per-claim disagreement stays per-claim (pending), never a cycle skip', async () => {
      // `verifyFundingEvent` runs inside processInboundClaim: its disagreement
      // must keep marking the durable claim pending (recoverable next tick),
      // not convert into the cycle-level skip. The cycle completes and the
      // checkpoint ADVANCES past the claimed event.
      const fake = createFakeFirestore();
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const report = await scanInboundUsdc(makeDeps(fake, [log()], {
          verificationError: new Error('economic_discovery_rpc_disagreement:receipt'),
        }), { startBlock: 50 });
        expect(report.errors).toBe(1);
        expect(report.pes_emitted).toBe(0);
      } finally {
        errorSpy.mockRestore();
      }
      expect(fake.store.get('genesis_inbound_checkpoints/8453'))
        .toMatchObject({ last_processed_block: 988 });
      const claim = fake.store.get(`genesis_inbound_seen/8453_${log().txHash}_0`) as
        Record<string, unknown> | undefined;
      expect(claim).toMatchObject({ state: 'pending_reverification' });
    });
  });
});
