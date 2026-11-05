/**
 * the MONEY OUTCOME of the commerce ruling for humans, non-USDC receives
 * and the one swap label, driven through each lane's PRODUCTION emit
 * (`buildChainRecordWatcherDeps.emitActPE`, `buildBaseOutboundDeps
 *.emitActivityPE`, `buildBaseInboundDeps.emitFundingPE`) into the REAL
 * `generatePE` and the REAL `recordPEAccrual` over a fake Firestore. Only the
 * chain read is injected. Nothing economic is re-implemented: every verdict is
 * the unchanged 09-23 fence speaking.
 *
 * the operator’s negative controls for, each beside the GREEN case that differs
 * in one variable:
 * - a HUMAN same-owner transfer mints 0 (vs. the same human send to a stranger: mints);
 * - a first non-USDC receive from a stranger mints 0 (vs. one from a counterparty
 * the wallet has sent to through the lane: mints);
 * plus 's three, re-run on the new paths: a same-owner transfer, a first
 * stranger receive, and a transaction observed twice (by two lanes) mints once;
 * and the swap label moves the act onto the `swap` ceiling.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import type { FakeFirestore } from './__test-helpers__/fake-firestore';


let mockDb: FakeFirestore;
jest.mock('firebase-admin', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createFakeFirestore: mk } = require('./__test-helpers__/fake-firestore');
  const db = mk();
  mockDb = db;
  const firestore = Object.assign(() => db, {
    FieldValue: { increment: (n: number) => ({ __increment: n }) },
  });
  return { __esModule: true, default: { firestore }, firestore };
});
jest.mock('../../cache', () => ({
  __esModule: true,
  cache: {
    getUserDailyPECountStrict: async () => 0,
    getUserActionTypeCountStrict: async () => 0,
    isArtifactHashSeen: async () => false,
    recordArtifactHash: async () => {},
    incrementUserActionTypeCount: async () => 1,
    incrementHourlyPECount: async () => {},
    commitPEAccountingCountersOnce: async () => ({ idempotent: false }),
  },
  CacheUnavailableError: class CacheUnavailableError extends Error {},
}));
jest.mock('./beneficiary', () => ({
  resolveBeneficiary: async () => ({
    linked: false, humanWalletId: null, humanUserId: null, humanAddress: null, agentShareBps: null,
  }),
}));
jest.mock('../jurisdiction/jurisdiction-policy', () => ({ getJurisdictionPolicy: async () => 'immediate' }));
jest.mock('./delegation-pe', () => ({ isDelegationQualifying: () => false, createDelegationPE: async () => {} }));
jest.mock('../provenance/pe-type-catalog', () => ({
  getCategoryForActionType: async () => 'financial',
  recordActionTypeObservation: async () => {},
}));
jest.mock('../foundation-membership/client', () => ({
  loadFoundationMembershipConfig: () => ({ enabled: false }),
  queueInitialMembershipGrants: async () => {},
}));


import type { Firestore } from 'firebase-admin/firestore';
import { recordPEAccrual } from '../../pvt-accrual';
import { actRecorded, meterActRow, meterActRows } from './__test-helpers__/meter-acts';
import type { AgentBankDeps } from '../agent-bank/types';
import {
  buildChainRecordWatcherDeps,
  chainRecordEnqueue,
  chainRecordPeId,
  enqueueChainRecordObservation,
  runChainRecordWatcherCycle,
  type ChainRecordSource,
} from './chain-record-watcher';
import { BASE_USDC_ADDRESS, type BaseTransactionEvidence } from '../onchain/economic-discovery';
import { buildBaseInboundDeps, inboundUsdcPeId } from './inbound-usdc-watcher';
import { buildBaseOutboundDeps, outboundUsdcPeId } from './outbound-usdc-watcher';
import { VERIFIED_COMMERCE_CUT_LINE_MS, WETH_WITHDRAWAL_TOPIC, ZEROX_ALLOWANCE_HOLDER_BASE } from './wallet-exchange';
import { transactionEvidence, transferLog, TEST_BLOCK } from './__test-helpers__/base-transaction-evidence';
import {
  NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION,
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  createNativeWalletRegistrationFence,
  nativeAgentRegistrationIndexId,
  nativeWalletAddressIndexId,
} from './native-wallet-registration';

const OWNER = 'human_owner_1';
const H = { wallet: 'hw1', user: OWNER, address: '0xcccc00000000000000000000000000000000000c' };
const A = { wallet: 'wA', agent: 'agentA', address: '0xaaaa00000000000000000000000000000000000a' };
const STRANGER = '0x5000000000000000000000000000000000000005';
const SETTLER = '0x5e77100000000000000000000000000000000005';
const DAI = '0x50c5725949a6f0c72e6c4a641f24049a917db0cb';
const WETH = '0x4200000000000000000000000000000000000006';
const DAY = VERIFIED_COMMERCE_CUT_LINE_MS + 8 * 3_600_000;

function realDeps(): AgentBankDeps {
  return {
    db: mockDb,
    cache: {},
    peBuffer: { enqueue: () => {} },
    recordPEAccrual: (p: Record<string, unknown>) => recordPEAccrual(
      p as unknown as Parameters<typeof recordPEAccrual>[0],
    ),
  } as unknown as AgentBankDeps;
}

function seedHuman(): void {
  mockDb.store.set(`wallets/${H.wallet}`, {
    id: H.wallet, user_id: H.user, address: H.address,
    native_watcher_registration: createNativeWalletRegistrationFence(TEST_BLOCK - 1_000),
  });
  mockDb.store.set(`${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(H.address)}`, {
    schema_version: 'native-wallet-address-index/v1', chain_id: 8453, address: H.address,
    wallet_id: H.wallet, owner_type: 'human', owner_id: H.user, created_at_ms: 1,
  });
}

function seedAgent(linkedHuman: string | null): void {
  mockDb.store.set(`agent_wallets/${A.wallet}`, {
    id: A.wallet, agent_id: A.agent, address: A.address, platform: 'claude', status: 'active',
    linked_human_user_id: linkedHuman,
    native_watcher_registration: createNativeWalletRegistrationFence(TEST_BLOCK - 1_000),
  });
  mockDb.store.set(`${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(A.address)}`, {
    schema_version: 'native-wallet-address-index/v1', chain_id: 8453, address: A.address,
    wallet_id: A.wallet, owner_type: 'agent', owner_id: A.agent, created_at_ms: 1,
  });
  mockDb.store.set(`${NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION}/${nativeAgentRegistrationIndexId(A.agent)}`, {
    wallet_id: A.wallet,
  });
}

let txSeq = 0x5040;
function nextTx(): string {
  txSeq += 1;
  return `0x${txSeq.toString(16).padStart(64, '0')}`;
}

const chain = new Map<string, BaseTransactionEvidence>();

function humanNativeSend(tx: string, to: string, ts = DAY): BaseTransactionEvidence {
  return transactionEvidence({
    transactionHash: tx, fromAddress: H.address, toAddress: to, valueWei: '1000000000000', inputEmpty: true,
    blockTimestampMs: ts,
  });
}

function daiReceive(tx: string, from: string, to: string, extra: ReturnType<typeof transferLog>[] = []): BaseTransactionEvidence {
  return transactionEvidence({
    transactionHash: tx, fromAddress: from, toAddress: DAI, blockTimestampMs: DAY,
    logs: [...extra, transferLog(tx, DAI, from, to, 10n ** 18n, 9)],
  });
}

/** The app's send/swap record queueing its tx, as the mobile route does (in the record's transaction). */
async function appRecord(tx: string, source: ChainRecordSource = 'app_send_record'): Promise<void> {
  const e = chainRecordEnqueue(mockDb as unknown as Firestore, { txHash: tx, walletId: H.wallet, source, ownerType: 'human' });
  await mockDb.runTransaction(async (txn) => { await e.read(txn as never); e.write(txn as never, `pe_app_${tx.slice(-6)}`); });
}

async function scanQueued(tx: string, walletId: string, ownerType: 'human' | 'agent'): Promise<void> {
  await enqueueChainRecordObservation(mockDb as unknown as Firestore, { txHash: tx, walletId, source: 'inbound_scan', ownerType }, DAY);
}

async function cycle(): Promise<void> {
  await runChainRecordWatcherCycle({
    ...buildChainRecordWatcherDeps(realDeps()),
    verifyTransaction: async (tx) => {
      const found = chain.get(tx);
      if (!found) throw new Error('economic_evidence_pending:transaction_unavailable');
      return found;
    },
    now: () => DAY + 86_400_000,
  }, { batch: 200 });
}

function sealed(peId: string): Record<string, unknown> {
  // PE METER: the priced row lives in the act's 31-day act key, never a pe_history row.
  const row = meterActRow(mockDb.store, peId);
  if (!row) throw new Error(`no metered act for ${peId}`);
  return row;
}

function historyRows(): Array<Record<string, unknown>> {
  return meterActRows(mockDb.store);
}

// Queue timestamps and the cycle clock must share the fixture's time, even after its calendar day.
beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(DAY);
  mockDb.store.clear();
  mockDb.ops.length = 0;
  chain.clear();
  seedHuman();
  seedAgent(OWNER);
});

afterEach(() => { jest.spyOn(Date, 'now').mockRestore(); });

describe(' item 1 — a HUMAN\'s send mints through the same chain-verified lane', () => {
  it('GREEN: the human\'s app send of ETH to a stranger → one eligible send, attributed to the human, non-zero', async () => {
    const tx = nextTx();
    chain.set(tx, humanNativeSend(tx, STRANGER));
    await appRecord(tx);
    await cycle();
    const row = sealed(chainRecordPeId(tx));
    expect(row).toMatchObject({ actionType: 'send', mint_status: 'eligible', mint_disposition: 'eligible', userId: OWNER });
    expect(row.estimatedPVT as number).toBeGreaterThan(0);
  });

  it('RED (control): the human\'s transfer to their OWN linked agent mints 0', async () => {
    const tx = nextTx();
    chain.set(tx, humanNativeSend(tx, A.address));
    await appRecord(tx);
    await cycle();
    expect(sealed(chainRecordPeId(tx))).toMatchObject({
      actionType: 'send', mint_disposition: 'record_only',
      disposition_reason_code: 'self_or_shared_beneficial_ownership', estimatedPVT: 0,
    });
  });

  it('RED (control not blanket): link the agent to someone else and the SAME send mints', async () => {
    seedAgent('someone_else');
    const tx = nextTx();
    chain.set(tx, humanNativeSend(tx, A.address));
    await appRecord(tx);
    await cycle();
    expect(sealed(chainRecordPeId(tx))).toMatchObject({ mint_disposition: 'eligible' });
  });

  it('GREEN: the human\'s WETH → DAI swap through 0x mints as one swap', async () => {
    const tx = nextTx();
    chain.set(tx, transactionEvidence({
      transactionHash: tx, fromAddress: H.address, toAddress: ZEROX_ALLOWANCE_HOLDER_BASE, blockTimestampMs: DAY,
      logs: [transferLog(tx, WETH, H.address, SETTLER, 5n, 1), transferLog(tx, DAI, SETTLER, H.address, 9n, 2)],
    }));
    await appRecord(tx, 'app_swap_record');
    await cycle();
    expect(sealed(chainRecordPeId(tx))).toMatchObject({ actionType: 'swap', mint_status: 'eligible' });
  });

  it('GREEN (review r1 defect 3): the human\'s DAI → native ETH swap through 0x mints as one swap', async () => {
    const tx = nextTx();
    chain.set(tx, transactionEvidence({
      transactionHash: tx, fromAddress: H.address, toAddress: ZEROX_ALLOWANCE_HOLDER_BASE, blockTimestampMs: DAY,
      logs: [
        transferLog(tx, DAI, H.address, SETTLER, 5n, 1),
        { ...transferLog(tx, WETH, SETTLER, SETTLER, 3n, 2), topics: [WETH_WITHDRAWAL_TOPIC, `0x${SETTLER.slice(2).padStart(64, '0')}`] },
      ],
    }));
    await appRecord(tx, 'app_swap_record');
    await cycle();
    expect(sealed(chainRecordPeId(tx))).toMatchObject({ actionType: 'swap', mint_status: 'eligible' });
  });

  it('RED: a human send mined before the landing seals nothing', async () => {
    const tx = nextTx();
    chain.set(tx, humanNativeSend(tx, STRANGER, VERIFIED_COMMERCE_CUT_LINE_MS - 1));
    await appRecord(tx);
    await cycle();
    expect(historyRows()).toHaveLength(0);
  });
});

describe(' item 2 — a non-USDC receive mints only from a counterparty the recipient has dealt with', () => {
  it('RED (control): a first DAI receive from a stranger mints 0', async () => {
    const tx = nextTx();
    chain.set(tx, daiReceive(tx, STRANGER, H.address));
    await scanQueued(tx, H.wallet, 'human');
    await cycle();
    expect(sealed(chainRecordPeId(`8453:${tx}:9`, 'receive'))).toMatchObject({
      actionType: 'receive', mint_disposition: 'record_only',
      disposition_reason_code: 'unsolicited_receive_record_only', estimatedPVT: 0,
    });
  });

  it('GREEN: after the human\'s lane send TO that address, a DAI receive FROM it mints', async () => {
    const send = nextTx();
    chain.set(send, humanNativeSend(send, STRANGER));
    await appRecord(send);
    await cycle();
    const tx = nextTx();
    chain.set(tx, daiReceive(tx, STRANGER, H.address));
    await scanQueued(tx, H.wallet, 'human');
    await cycle();
    expect(sealed(chainRecordPeId(`8453:${tx}:9`, 'receive'))).toMatchObject({ actionType: 'receive', mint_disposition: 'eligible' });
  });

  it('an AGENT\'s first DAI receive from a stranger mints 0 too (same terms)', async () => {
    const tx = nextTx();
    chain.set(tx, daiReceive(tx, STRANGER, A.address));
    await scanQueued(tx, A.wallet, 'agent');
    await cycle();
    expect(sealed(chainRecordPeId(`8453:${tx}:9`, 'receive'))).toMatchObject({ actionType: 'receive', mint_disposition: 'record_only' });
  });

  it('RED: the agent\'s DAI receive from its OWN linked human mints 0 for SAME OWNER, though it authored the relationship', async () => {
    // The agent sends to its human through the lane: same owner → record_only, but
    // the send authors the relationship, so the receive is not merely unsolicited.
    const send = nextTx();
    chain.set(send, transactionEvidence({
      transactionHash: send, fromAddress: A.address, toAddress: H.address, valueWei: '7', inputEmpty: true, blockTimestampMs: DAY,
    }));
    const e = chainRecordEnqueue(mockDb as unknown as Firestore, { txHash: send, walletId: A.wallet, source: 'transfer_record' });
    await mockDb.runTransaction(async (txn) => { await e.read(txn as never); e.write(txn as never, 'pe_rec_a'); });
    await cycle();
    expect(sealed(chainRecordPeId(send))).toMatchObject({ mint_disposition: 'record_only' });
    const tx = nextTx();
    chain.set(tx, daiReceive(tx, H.address, A.address));
    await scanQueued(tx, A.wallet, 'agent');
    await cycle();
    expect(sealed(chainRecordPeId(`8453:${tx}:9`, 'receive'))).toMatchObject({
      actionType: 'receive', mint_disposition: 'record_only',
      disposition_reason_code: 'self_or_shared_beneficial_ownership',
    });
  });
});

describe(' review r1 defect 1 — both sides of one token transfer are watched: each mints its own act', () => {
  it('a human\'s DAI send to a stranger-linked agent: the human\'s send AND the agent\'s receive both seal (no id collision)', async () => {
    seedAgent('someone_else'); // a different owner: not a same-owner transfer
    // the agent has dealt with the human (it sent to them first), so its receive can mint
    const prior = nextTx();
    chain.set(prior, transactionEvidence({
      transactionHash: prior, fromAddress: A.address, toAddress: H.address, valueWei: '7', inputEmpty: true, blockTimestampMs: DAY,
    }));
    const e = chainRecordEnqueue(mockDb as unknown as Firestore, { txHash: prior, walletId: A.wallet, source: 'transfer_record' });
    await mockDb.runTransaction(async (txn) => { await e.read(txn as never); e.write(txn as never, 'pe_rec_prior'); });
    await cycle();

    const tx = nextTx();
    chain.set(tx, transactionEvidence({
      transactionHash: tx, fromAddress: H.address, toAddress: DAI, blockTimestampMs: DAY,
      logs: [transferLog(tx, DAI, H.address, A.address, 10n ** 18n, 9)],
    }));
    await appRecord(tx);                       // the human's send record
    await scanQueued(tx, A.wallet, 'agent');   // the agent's inbound scan
    await cycle();
    expect(chainRecordPeId(`8453:${tx}:9`, 'receive')).not.toBe(chainRecordPeId(`8453:${tx}:9`, 'send'));
    expect(sealed(chainRecordPeId(`8453:${tx}:9`, 'send'))).toMatchObject({ actionType: 'send', mint_status: 'eligible', userId: OWNER });
    expect(sealed(chainRecordPeId(`8453:${tx}:9`, 'receive'))).toMatchObject({ actionType: 'receive', mint_status: 'eligible', userId: A.agent });
  });
});

describe('a transaction observed twice (or by two lanes) mints once', () => {
  it('an app record and an inbound scan of the same (tx, wallet) are one observation and one PE', async () => {
    const tx = nextTx();
    chain.set(tx, humanNativeSend(tx, STRANGER));
    await appRecord(tx);
    await scanQueued(tx, H.wallet, 'human');
    await cycle();
    await cycle();
    expect(historyRows().filter((r) => r.mint_status === 'eligible')).toHaveLength(1);
  });

  it('RED: a DAI receive in a transaction whose USDC deposit already minted emits nothing more', async () => {
    const send = nextTx();
    chain.set(send, humanNativeSend(send, STRANGER));
    await appRecord(send);
    await cycle(); // the human has now dealt with STRANGER
    const tx = nextTx();
    chain.set(tx, daiReceive(tx, STRANGER, H.address, [transferLog(tx, BASE_USDC_ADDRESS, STRANGER, H.address, 5_000_000n, 3)]));
    // the inbound USDC watcher sealed its receive for log 3, through its production emit
    await buildBaseInboundDeps(realDeps()).emitFundingPE(
      { walletId: H.wallet, agentId: H.user, address: H.address, createdAtMs: 1, eligibilityStartBlock: 0, ownerType: 'human' },
      { txHash: tx, logIndex: 3, blockNumber: TEST_BLOCK, fromAddress: STRANGER, amountUsd: 5, amountAtomic: '5000000', observedAtMs: DAY },
      { verified: true, finality_confirmations: 12, tx_hash: tx, log_index: 3, asset: 'USDC' },
    );
    expect(sealed(inboundUsdcPeId(8453, tx, 3))).toMatchObject({ actionType: 'receive', mint_status: 'eligible' });
    await scanQueued(tx, H.wallet, 'human');
    await cycle();
    expect(actRecorded(mockDb.store, chainRecordPeId(`8453:${tx}:9`, 'receive'))).toBe(false);
  });

  it('a swap seen by BOTH USDC watchers (USDC out and USDC in, one tx) mints once — both keyed on the tx', async () => {
    const tx = nextTx();
    await buildBaseOutboundDeps(realDeps()).emitActivityPE(
      { address: A.address, walletId: A.wallet, agentId: A.agent, provenAtBlock: 0, source: 'native_agent' },
      { txHash: tx, logIndex: 1, blockNumber: TEST_BLOCK, toAddress: SETTLER, amountUsd: 5, amountAtomic: '5000000', observedAtMs: DAY },
      'swap',
      { verified: true, finality_confirmations: 12, tx_hash: tx, log_index: 1, asset: 'USDC' },
      'transaction',
    );
    await buildBaseInboundDeps(realDeps()).emitFundingPE(
      { walletId: A.wallet, agentId: A.agent, address: A.address, createdAtMs: 1, eligibilityStartBlock: 0, ownerType: 'agent' },
      { txHash: tx, logIndex: 4, blockNumber: TEST_BLOCK, fromAddress: SETTLER, amountUsd: 4, amountAtomic: '4000000', observedAtMs: DAY + 1 },
      { verified: true, finality_confirmations: 12, tx_hash: tx, log_index: 4, asset: 'USDC' },
      'swap',
    );
    expect(sealed(outboundUsdcPeId(8453, tx, 1))).toMatchObject({ actionType: 'swap', mint_status: 'eligible' });
    expect(sealed(inboundUsdcPeId(8453, tx, 4))).toMatchObject({ actionType: 'swap', mint_status: 'corroborated_duplicate', estimatedPVT: 0 });
  });
});

describe(' item 3 — the label decides the ceiling: an exchange counts against `swap`, not `send`', () => {
  async function lanSwaps(n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      const tx = nextTx();
      chain.set(tx, transactionEvidence({
        transactionHash: tx, fromAddress: A.address, toAddress: ZEROX_ALLOWANCE_HOLDER_BASE, blockTimestampMs: DAY + i,
        logs: [transferLog(tx, WETH, A.address, SETTLER, 5n, 1), transferLog(tx, DAI, SETTLER, A.address, 9n, 2)],
      }));
      const e = chainRecordEnqueue(mockDb as unknown as Firestore, { txHash: tx, walletId: A.wallet, source: 'swap_record' });
      await mockDb.runTransaction(async (txn) => { await e.read(txn as never); e.write(txn as never, `pe_rec_${i}`); });
    }
    await cycle();
  }
  const usdcOut = async (activityType: 'swap' | 'send'): Promise<Record<string, unknown>> => {
    const tx = nextTx();
    await buildBaseOutboundDeps(realDeps()).emitActivityPE(
      { address: A.address, walletId: A.wallet, agentId: A.agent, provenAtBlock: 0, source: 'native_agent' },
      { txHash: tx, logIndex: 1, blockNumber: TEST_BLOCK, toAddress: SETTLER, amountUsd: 5, amountAtomic: '5000000', observedAtMs: DAY + 60_000 },
      activityType,
      { verified: true, finality_confirmations: 12, tx_hash: tx, log_index: 1, asset: 'USDC' },
      activityType === 'swap' ? 'transaction' : 'log',
    );
    return sealed(outboundUsdcPeId(8453, tx, 1));
  };

  it('after 25 swaps in a UTC day, a USDC exchange labelled swap is capped', async () => {
    await lanSwaps(25);
    expect(historyRows().filter((r) => r.actionType === 'swap' && r.mint_status === 'eligible')).toHaveLength(25);
    const row = await usdcOut('swap');
    expect(row.mint_status).not.toBe('eligible');
    expect(row.estimatedPVT).toBe(0);
  });

  it('RED: the same USDC outflow labelled send (the label) would have minted on the send ceiling', async () => {
    await lanSwaps(25);
    expect((await usdcOut('send')).mint_status).toBe('eligible');
  });
});
