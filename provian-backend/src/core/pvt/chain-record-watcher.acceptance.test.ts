/**
 * the MONEY OUTCOME of the chain-record lane, driven through the lane's
 * PRODUCTION emit (`buildChainRecordWatcherDeps.emitActPE`) into the REAL
 * `generatePE` and the REAL `recordPEAccrual` over a fake Firestore. Only the
 * chain read is injected (a verified transaction). Nothing economic is
 * re-implemented: every verdict below is the unchanged 09-23 fence speaking.
 *
 * the operator’s three negative controls, each beside the GREEN case that differs from
 * it in exactly one variable:
 * 1. a transfer between two wallets of ONE owner mints 0 (vs. a stranger: mints);
 * 2. a first receive from a stranger mints 0 (vs. a counterparty this wallet
 * has sent to through the lane: mints);
 * 3. a transaction observed twice mints once (a replayed observation, a second
 * record of the same tx, and a second source sealing the same event).
 * Plus the ceiling: the 26th lane send of a UTC day does not mint.
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
import { actRecorded, meterActRow, meterActRows, relayIntake } from './__test-helpers__/meter-acts';
import { METER_ACT_KEY_FIELDS, PE_HISTORY_FIELDS } from '../../__test-helpers__/pe-doc-fixtures';
import { generatePE } from '../agent-bank/pe-utils';
import type { AgentBankDeps } from '../agent-bank/types';
import {
  CHAIN_RECORD_MINT_CUT_LINE_MS,
  CHAIN_RECORD_OBSERVATIONS_COLLECTION,
  buildChainRecordWatcherDeps,
  chainRecordEnqueue,
  chainRecordObservationId,
  chainRecordPeId,
  runChainRecordWatcherCycle,
} from './chain-record-watcher';
import { hashBaseTransactionEvidence, type BaseTransactionEvidence, type EvmTransactionEvidence } from '../onchain/economic-discovery';
import { LIFI_DIAMOND, LIFI_TRANSFER_STARTED_TOPIC, MULTICHAIN_COMMERCE_CUT_LINE_MS } from './wallet-exchange';
import { inboundUsdcPeId } from './inbound-usdc-watcher';
import {
  NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION,
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  createNativeWalletRegistrationFence,
  nativeAgentRegistrationIndexId,
  nativeWalletAddressIndexId,
} from './native-wallet-registration';

const OWNER = 'human_owner_1';
const A = { wallet: 'wA', agent: 'agentA', address: '0xaaaa00000000000000000000000000000000000a' };
const B = { wallet: 'wB', agent: 'agentB', address: '0xbbbb00000000000000000000000000000000000b' };
const STRANGER = '0x5000000000000000000000000000000000000005';
const BLOCK = 60_000_000;
const DAY = Date.UTC(2026, 9, 1, 12, 0);

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

function seedAgent(w: typeof A, linkedHuman: string | null): void {
  mockDb.store.set(`agent_wallets/${w.wallet}`, {
    id: w.wallet, agent_id: w.agent, address: w.address, platform: 'claude', status: 'active',
    linked_human_user_id: linkedHuman,
    native_watcher_registration: createNativeWalletRegistrationFence(BLOCK - 1_000),
  });
  mockDb.store.set(`${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(w.address)}`, {
    schema_version: 'native-wallet-address-index/v1', chain_id: 8453, address: w.address,
    wallet_id: w.wallet, owner_type: 'agent', owner_id: w.agent, created_at_ms: 1,
  });
  mockDb.store.set(`${NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION}/${nativeAgentRegistrationIndexId(w.agent)}`, {
    wallet_id: w.wallet,
  });
}

let txSeq = 0;
function nextTx(): string {
  txSeq += 1;
  return `0x${txSeq.toString(16).padStart(64, '0')}`;
}

function nativeSend(tx: string, to: string, timestampMs = DAY): BaseTransactionEvidence {
  const base: Omit<BaseTransactionEvidence, 'evidenceHash'> = {
    schemaVersion: 'base-transaction-evidence/v1',
    chainId: 8453,
    transactionHash: tx,
    blockNumber: BLOCK,
    blockHash: `0x${'bb'.repeat(32)}`,
    blockTimestampMs: timestampMs,
    confirmationFloor: 12,
    providerOperatorIds: ['op-a', 'op-b'],
    fromAddress: A.address,
    toAddress: to,
    valueWei: '1000000000000',
    inputEmpty: true,
    transactionSelector: null,
    logs: [],
  };
  return { ...base, evidenceHash: hashBaseTransactionEvidence(base) };
}

const chain = new Map<string, BaseTransactionEvidence>();

async function record(tx: string, walletId = A.wallet, source: 'transfer_record' | 'swap_record' = 'transfer_record'): Promise<void> {
  const e = chainRecordEnqueue(mockDb as unknown as Firestore, { txHash: tx, walletId, source });
  await mockDb.runTransaction(async (txn) => { await e.read(txn as never); e.write(txn as never, `pe_record_${tx.slice(-6)}`); });
}

async function cycle(): Promise<void> {
  await runChainRecordWatcherCycle({
    ...buildChainRecordWatcherDeps(realDeps()),
    verifyTransaction: async (tx) => {
      const ev = chain.get(tx);
      if (!ev) throw new Error('economic_evidence_pending:transaction_unavailable');
      return ev;
    },
    now: () => DAY + 86_400_000,
  }, { batch: 100 });
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

/** The inbound USDC watcher's receive emit, in its production shape. */
async function inboundReceive(from: string, tx: string): Promise<Record<string, unknown>> {
  const peId = inboundUsdcPeId(8453, tx, 0);
  await generatePE(realDeps(), {
    walletId: A.wallet,
    agentId: A.agent,
    actorAddress: A.address,
    actionType: 'receive',
    ownerType: 'agent',
    walletAddress: A.address,
    counterpartyAddress: from,
    metadata: { tx_hash: tx, log_index: 0, verified: true, finality_confirmations: 12, asset: 'USDC' },
    observedCanonicalEventId: `8453:${tx}:0`,
    peIdOverride: peId,
    timestampOverride: DAY + 1_000,
    awaitAccrual: true,
  });
  return sealed(peId);
}

// Queue timestamps and the cycle clock must share the fixture's time, even after its calendar day.
beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(DAY);
  mockDb.store.clear();
  mockDb.ops.length = 0;
  chain.clear();
  seedAgent(A, OWNER);
  seedAgent(B, OWNER);
});

afterEach(() => { jest.spyOn(Date, 'now').mockRestore(); });

describe('a chain-verified transfer record MINTS through the lane', () => {
  it('GREEN: a native send to a stranger → one eligible send, non-zero', async () => {
    const tx = nextTx();
    chain.set(tx, nativeSend(tx, STRANGER));
    await record(tx);
    await cycle();
    const row = sealed(chainRecordPeId(tx));
    expect(row).toMatchObject({ actionType: 'send', mint_status: 'eligible', mint_disposition: 'eligible' });
    expect(row.estimatedPVT).toEqual(expect.any(Number));
    expect(row.estimatedPVT as number).toBeGreaterThan(0);
    // The REAL meter commit wrote the act key in exactly the shape the shared fixture builder
    // (`makeMeterActKeyDoc`) seeds for prior acts, its row in exactly the pe_history shape, and the
    // staged intake was consumed by that same commit.
    const key = mockDb.store.get(`meter_act_keys_v1/${chainRecordPeId(tx)}`) as Record<string, unknown>;
    expect(Object.keys(key).sort()).toEqual([...METER_ACT_KEY_FIELDS].sort());
    for (const field of Object.keys(row)) expect(PE_HISTORY_FIELDS).toContain(field);
    expect(row.peHash).toBe(key.pe_hash);
    expect(relayIntake(mockDb.store, chainRecordPeId(tx))).toBeUndefined();
  });

  it('RED (control 1): a transfer between two wallets of ONE owner mints 0', async () => {
    const tx = nextTx();
    chain.set(tx, nativeSend(tx, B.address));
    await record(tx);
    await cycle();
    const row = sealed(chainRecordPeId(tx));
    expect(row).toMatchObject({
      actionType: 'send',
      mint_disposition: 'record_only',
      disposition_reason_code: 'self_or_shared_beneficial_ownership',
      estimatedPVT: 0,
    });
  });

  it('RED (control 1, not blanket): unlink B from the owner and the SAME send mints', async () => {
    seedAgent(B, 'someone_else');
    const tx = nextTx();
    chain.set(tx, nativeSend(tx, B.address));
    await record(tx);
    await cycle();
    expect(sealed(chainRecordPeId(tx))).toMatchObject({ mint_disposition: 'eligible' });
  });

  it('RED: a transaction mined before the landing seals nothing at all', async () => {
    const tx = nextTx();
    chain.set(tx, nativeSend(tx, STRANGER, CHAIN_RECORD_MINT_CUT_LINE_MS - 1));
    await record(tx);
    await cycle();
    expect(historyRows()).toHaveLength(0);
    // Neither priced nor staged: the relay recorded no act for this tx at all.
    expect(actRecorded(mockDb.store, chainRecordPeId(tx))).toBe(false);
  });
});

describe(' control 2 — the unsolicited-receive rule is unchanged, and lane sends author a relationship', () => {
  it('RED: a first receive from a stranger mints 0', async () => {
    const row = await inboundReceive(STRANGER, nextTx());
    expect(row).toMatchObject({
      actionType: 'receive', mint_disposition: 'record_only', estimatedPVT: 0,
      disposition_reason_code: 'unsolicited_receive_record_only',
    });
  });

  it('GREEN: after the lane minted a send TO that address, a receive FROM it mints', async () => {
    const tx = nextTx();
    chain.set(tx, nativeSend(tx, STRANGER));
    await record(tx);
    await cycle();
    expect(sealed(chainRecordPeId(tx))).toMatchObject({ mint_disposition: 'eligible' });
    const receive = await inboundReceive(STRANGER, nextTx());
    expect(receive).toMatchObject({ actionType: 'receive', mint_disposition: 'eligible' });
  });
});

describe(' control 3 — a transaction observed twice mints once', () => {
  it('the same tx recorded through BOTH routes is one observation and one PE', async () => {
    const tx = nextTx();
    chain.set(tx, nativeSend(tx, STRANGER));
    await record(tx, A.wallet, 'transfer_record');
    await record(tx, A.wallet, 'swap_record');
    await cycle();
    await cycle();
    const eligible = historyRows().filter((r) => r.mint_status === 'eligible');
    expect(eligible).toHaveLength(1);
  });

  it('a replayed observation (crash after emit, before completion) returns the sealed PE — still one mint', async () => {
    const tx = nextTx();
    chain.set(tx, nativeSend(tx, STRANGER));
    await record(tx);
    await cycle();
    const path = `${CHAIN_RECORD_OBSERVATIONS_COLLECTION}/${chainRecordObservationId(tx, A.wallet)}`;
    mockDb.store.set(path, { ...(mockDb.store.get(path) as object), status: 'pending', next_attempt_at_ms: 0 });
    await cycle();
    const rows = historyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mint_status: 'eligible' });
  });

  it('RED: a second SOURCE sealing the same (wallet, event) under another PE id mints 0', async () => {
    const tx = nextTx();
    chain.set(tx, nativeSend(tx, STRANGER));
    await record(tx);
    await cycle();
    const second = 'pe_second_source_1';
    await generatePE(realDeps(), {
      walletId: A.wallet, agentId: A.agent, actorAddress: A.address, actionType: 'send',
      ownerType: 'agent', walletAddress: A.address, counterpartyAddress: STRANGER,
      metadata: { tx_hash: tx, verified: true, finality_confirmations: 12 },
      observedCanonicalEventId: tx,
      peIdOverride: second,
      timestampOverride: DAY + 5_000,
      awaitAccrual: true,
    });
    expect(sealed(chainRecordPeId(tx))).toMatchObject({ mint_status: 'eligible' });
    expect(sealed(second)).toMatchObject({ mint_status: 'corroborated_duplicate', estimatedPVT: 0 });
  });
});

describe('the per-actor daily ceiling bounds the lane', () => {
  it('25 lane sends in one UTC day mint; the 26th does not', async () => {
    const txs: string[] = [];
    for (let i = 0; i < 26; i += 1) {
      const tx = nextTx();
      const to = `0x${(0x6000 + i).toString(16).padStart(40, '0')}`;
      chain.set(tx, nativeSend(tx, to, DAY + i * 1_000));
      await record(tx);
      txs.push(tx);
    }
    await cycle();
    const statuses = txs.map((tx) => sealed(chainRecordPeId(tx)).mint_status);
    expect(statuses.filter((s) => s === 'eligible')).toHaveLength(25);
    const last = sealed(chainRecordPeId(txs[25]));
    expect(last.mint_status).not.toBe('eligible');
    expect(last.estimatedPVT).toBe(0);
  });
});

describe('Arbitrum One and cross-chain swaps mint through the same real fences', () => {
  const AFTER_MULTICHAIN = MULTICHAIN_COMMERCE_CUT_LINE_MS + 60_000;
  const arbSend = (tx: string, to: string): EvmTransactionEvidence => {
    const body: Omit<EvmTransactionEvidence, 'evidenceHash'> = {
      ...nativeSend(tx, to, AFTER_MULTICHAIN), schemaVersion: 'evm-transaction-evidence/v1', chainId: 42161,
    };
    delete (body as { evidenceHash?: string }).evidenceHash;
    return { ...body, evidenceHash: hashBaseTransactionEvidence(body) };
  };
  async function recordOn(tx: string, chainId: number): Promise<void> {
    const e = chainRecordEnqueue(mockDb as unknown as Firestore, { txHash: tx, walletId: A.wallet, source: 'transfer_record', chainId });
    await mockDb.runTransaction(async (txn) => { await e.read(txn as never); e.write(txn as never, `pe_record_${tx.slice(-6)}`); });
  }
  async function cycleOn(evidence: Map<string, EvmTransactionEvidence | BaseTransactionEvidence>): Promise<void> {
    jest.spyOn(Date, 'now').mockReturnValue(AFTER_MULTICHAIN);
    await runChainRecordWatcherCycle({
      ...buildChainRecordWatcherDeps(realDeps()),
      verifyTransaction: async (tx) => {
        const ev = evidence.get(tx);
        if (!ev) throw new Error('economic_evidence_pending:transaction_unavailable');
        return ev;
      },
      readBaseBlockTimestampMs: async () => DAY,
      now: () => AFTER_MULTICHAIN + 3_600_000,
    }, { batch: 100 });
  }

  it('GREEN: an Arbitrum native send to a stranger seals one eligible send, non-zero, under an Arbitrum PE id', async () => {
    const tx = nextTx();
    await recordOn(tx, 42161);
    await cycleOn(new Map([[tx, arbSend(tx, STRANGER)]]));
    const row = sealed(chainRecordPeId(tx, 'send', 42161));
    expect(row).toMatchObject({ actionType: 'send', mint_status: 'eligible' });
    expect(row.estimatedPVT as number).toBeGreaterThan(0);
  });

  it('RED: the same Arbitrum send between two wallets of one owner records only', async () => {
    const tx = nextTx();
    await recordOn(tx, 42161);
    await cycleOn(new Map([[tx, arbSend(tx, B.address)]]));
    expect(sealed(chainRecordPeId(tx, 'send', 42161))).toMatchObject({
      mint_disposition: 'record_only', disposition_reason_code: 'self_or_shared_beneficial_ownership', estimatedPVT: 0,
    });
  });

  it('GREEN: a Base cross-chain swap (Diamond + transfer-started event) seals one eligible swap', async () => {
    const tx = nextTx();
    const body: Omit<BaseTransactionEvidence, 'evidenceHash'> = {
      ...nativeSend(tx, LIFI_DIAMOND, AFTER_MULTICHAIN), inputEmpty: false, transactionSelector: '0x12345678',
      logs: [{
        address: LIFI_DIAMOND, topics: [LIFI_TRANSFER_STARTED_TOPIC], data: '0x', blockNumber: BLOCK,
        blockHash: `0x${'bb'.repeat(32)}`, transactionHash: tx, transactionIndex: 0, logIndex: 0, removed: false,
      }],
    };
    delete (body as { evidenceHash?: string }).evidenceHash;
    await recordOn(tx, 8453);
    await cycleOn(new Map([[tx, { ...body, evidenceHash: hashBaseTransactionEvidence(body) }]]));
    expect(sealed(chainRecordPeId(tx, 'swap'))).toMatchObject({ actionType: 'swap', mint_status: 'eligible' });
  });
});
