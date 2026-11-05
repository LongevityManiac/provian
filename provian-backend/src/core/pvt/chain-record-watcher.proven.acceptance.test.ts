/**
 * 2026-10-01 — PROVEN ADDRESSES GET THE SAME COMMERCE TERMS, and a PERSON proves a
 * wallet they already hold. The money outcome, driven through each lane's
 * PRODUCTION emit (the chain-record lane, the outbound and inbound USDC watchers)
 * and the person proof itself into the REAL `generatePE` → REAL `recordPEAccrual`
 * over a fake Firestore. Only chain reads are injected.
 *
 * the operator’s negative controls, each beside the GREEN case that differs in one variable:
 * - a transfer between a person's wallet and their own proven address mints 0
 * (vs. the same send from the proven address to a stranger: mints);
 * - a first non-USDC receive from a stranger on a proven address mints 0
 * (vs. one from a counterparty the person has dealt with: mints);
 * - proving pays nothing (the proof receipt seals record_only, 0 PVT);
 * - nothing before the proof (fence) or the landing (cut line) mints.
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


import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { recordPEAccrual } from '../../pvt-accrual';
import { actRecorded, meterActRow, meterActRows } from './__test-helpers__/meter-acts';
import type { AgentBankDeps } from '../agent-bank/types';
import {
  PROVEN_ADDRESS_COMMERCE_CUT_LINE_MS,
  buildChainRecordWatcherDeps,
  chainRecordEnqueue,
  chainRecordPeId,
  enqueueChainRecordObservation,
  provenObservationWalletId,
  runChainRecordWatcherCycle,
  type ChainRecordSource,
} from './chain-record-watcher';
import { BASE_USDC_ADDRESS, type BaseTransactionEvidence } from '../onchain/economic-discovery';
import { buildBaseInboundDeps, inboundUsdcPeId } from './inbound-usdc-watcher';
import { buildBaseOutboundDeps, outboundUsdcPeId } from './outbound-usdc-watcher';
import { transactionEvidence, transferLog, TEST_BLOCK } from './__test-helpers__/base-transaction-evidence';
import {
  NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION,
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  createNativeWalletRegistrationFence,
  nativeAgentRegistrationIndexId,
  nativeWalletAddressIndexId,
} from './native-wallet-registration';
import { HUMAN_PROVEN_ADDRESSES_COLLECTION, PROVEN_ADDRESSES_COLLECTION } from '../external-address/link';
import { HUMAN_PROVEN_ADDRESS_SCHEMA } from '../external-address/human-link';
import { issuePersonChallenge, provePersonExternalAddress, type ProofChainDeps } from '../external-address';
import { enumeratePersonProvenAddresses } from './person-proven-watched';

const OWNER = 'human_owner_1';
const H = { wallet: 'hw1', user: OWNER, address: '0xcccc00000000000000000000000000000000000c' };
const A = { wallet: 'wA', agent: 'agentA', address: '0xaaaa00000000000000000000000000000000000a' };
/** The person's proven outside wallet. */
const P = '0xbeef00000000000000000000000000000000000b';
/** The agent's proven outside wallet. */
const Q = '0xdead00000000000000000000000000000000000d';
const STRANGER = '0x5000000000000000000000000000000000000005';
const DAI = '0x50c5725949a6f0c72e6c4a641f24049a917db0cb';
const DAY = PROVEN_ADDRESS_COMMERCE_CUT_LINE_MS + 8 * 3_600_000;
const PROOF_HEAD = TEST_BLOCK - 2_000;

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

const sha = (v: string) => `sha256:${crypto.createHash('sha256').update(v).digest('hex')}`;

/** Fields every valid proof record carries (the same check for agents and people). */
function proofFields(provenAtBlock = PROOF_HEAD + 1): Record<string, unknown> {
  const head = provenAtBlock - 1;
  return {
    economic_eligibility: 'active_go_forward_only',
    proven_at_ms: 1_000,
    proven_at_block: provenAtBlock,
    proof_observed_head_block: head,
    proof_block_number: head - 11,
    proof_block_hash: `0x${'ab'.repeat(32)}`,
    proof_min_confirmations: 12,
    proof_rpc_operator_ids: ['op-a', 'op-b'],
    chain: 'base',
    chain_id: 8453,
    proof_method: 'eip191_eoa',
    signature_hash: sha('sig'),
    proof_evidence: {
      schema_version: 'external-address-control-proof/v1',
      challenge_id_sha256: sha('cid'),
      challenge_message_sha256: sha('msg'),
      signature_sha256: sha('sig'),
      proof_method: 'eip191_eoa',
      verified_at_ms: 1_000,
    },
    initial_reputation_tier: 0,
    baseline_nonce: 0,
    created_at: 1_000,
  };
}

function seed(): void {
  mockDb.store.set(`wallets/${H.wallet}`, {
    id: H.wallet, user_id: H.user, address: H.address, type: 'human',
    native_watcher_registration: createNativeWalletRegistrationFence(TEST_BLOCK - 1_000),
  });
  mockDb.store.set(`${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(H.address)}`, {
    schema_version: 'native-wallet-address-index/v1', chain_id: 8453, address: H.address,
    wallet_id: H.wallet, owner_type: 'human', owner_id: H.user, created_at_ms: 1,
  });
  mockDb.store.set(`agent_wallets/${A.wallet}`, {
    id: A.wallet, agent_id: A.agent, address: A.address, platform: 'claude', status: 'active',
    linked_human_user_id: OWNER,
    native_watcher_registration: createNativeWalletRegistrationFence(TEST_BLOCK - 1_000),
  });
  mockDb.store.set(`${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(A.address)}`, {
    schema_version: 'native-wallet-address-index/v1', chain_id: 8453, address: A.address,
    wallet_id: A.wallet, owner_type: 'agent', owner_id: A.agent, created_at_ms: 1,
  });
  mockDb.store.set(`${NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION}/${nativeAgentRegistrationIndexId(A.agent)}`, {
    wallet_id: A.wallet,
  });
  // The person's proven wallet P and the agent's proven wallet Q.
  mockDb.store.set(`${HUMAN_PROVEN_ADDRESSES_COLLECTION}/${P}`, {
    schema_version: HUMAN_PROVEN_ADDRESS_SCHEMA, address: P, user_id: H.user, wallet_id: H.wallet, ...proofFields(),
  });
  mockDb.store.set(`${PROVEN_ADDRESSES_COLLECTION}/${Q}`, {
    schema_version: 'proven-address/v2', address: Q, agent_id: A.agent, wallet_id: A.wallet, ...proofFields(),
  });
}

let txSeq = 0x7050;
function nextTx(): string {
  txSeq += 1;
  return `0x${txSeq.toString(16).padStart(64, '0')}`;
}
const chain = new Map<string, BaseTransactionEvidence>();

const ethSend = (tx: string, from: string, to: string, ts = DAY) => transactionEvidence({
  transactionHash: tx, fromAddress: from, toAddress: to, valueWei: '1000000000000', inputEmpty: true, blockTimestampMs: ts,
});
const daiTransfer = (tx: string, signer: string, from: string, to: string) => transactionEvidence({
  transactionHash: tx, fromAddress: signer, toAddress: DAI, blockTimestampMs: DAY,
  logs: [transferLog(tx, DAI, from, to, 10n ** 18n, 9)],
});

async function queueProven(tx: string, address: string, ownerType: 'human' | 'agent', source: ChainRecordSource): Promise<void> {
  await enqueueChainRecordObservation(mockDb as unknown as Firestore, {
    txHash: tx, walletId: provenObservationWalletId(address), source, ownerType,
  }, DAY);
}
async function appRecord(tx: string): Promise<void> {
  const e = chainRecordEnqueue(mockDb as unknown as Firestore, { txHash: tx, walletId: H.wallet, source: 'app_send_record', ownerType: 'human' });
  await mockDb.runTransaction(async (txn) => { await e.read(txn as never); e.write(txn as never, `pe_app_${tx.slice(-6)}`); });
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
const historyRows = () => meterActRows(mockDb.store);

// Queue timestamps and the cycle clock must share the fixture's time, even after its calendar day.
beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(DAY);
  mockDb.store.clear();
  mockDb.ops.length = 0;
  chain.clear();
  seed();
});

afterEach(() => { jest.spyOn(Date, 'now').mockRestore(); });

describe('a PERSON\'s proven address: same-owner transfers mint 0, real commerce mints, as the person', () => {
  it('NEGATIVE CONTROL: the person\'s native wallet sending to their OWN proven address mints 0', async () => {
    const tx = nextTx();
    chain.set(tx, ethSend(tx, H.address, P));
    await appRecord(tx);
    await cycle();
    expect(sealed(chainRecordPeId(tx))).toMatchObject({
      actionType: 'send', mint_disposition: 'record_only',
      disposition_reason_code: 'self_or_shared_beneficial_ownership', estimatedPVT: 0,
    });
  });

  it('NEGATIVE CONTROL: the proven address sending back to the person\'s native wallet mints 0', async () => {
    const tx = nextTx();
    chain.set(tx, ethSend(tx, P, H.address));
    await queueProven(tx, P, 'human', 'proven_outbound_scan');
    await cycle();
    expect(sealed(chainRecordPeId(tx))).toMatchObject({
      actionType: 'send', userId: OWNER, mint_disposition: 'record_only',
      disposition_reason_code: 'self_or_shared_beneficial_ownership', estimatedPVT: 0,
    });
  });

  it('NEGATIVE CONTROL: DAI from the person\'s native wallet arriving at their proven address — the receive mints 0', async () => {
    const tx = nextTx();
    chain.set(tx, daiTransfer(tx, H.address, H.address, P));
    await queueProven(tx, P, 'human', 'inbound_scan');
    await cycle();
    expect(sealed(chainRecordPeId(`8453:${tx}:9`, 'receive'))).toMatchObject({
      actionType: 'receive', mint_disposition: 'record_only', estimatedPVT: 0,
    });
  });

  it('NEGATIVE CONTROL: the proven address paying the person\'s own linked agent mints 0', async () => {
    const tx = nextTx();
    chain.set(tx, ethSend(tx, P, A.address));
    await queueProven(tx, P, 'human', 'proven_outbound_scan');
    await cycle();
    expect(sealed(chainRecordPeId(tx))).toMatchObject({
      mint_disposition: 'record_only', disposition_reason_code: 'self_or_shared_beneficial_ownership',
    });
  });

  it('GREEN twin: the proven address sending ETH to a stranger mints, attributed to the PERSON', async () => {
    const tx = nextTx();
    chain.set(tx, ethSend(tx, P, STRANGER));
    await queueProven(tx, P, 'human', 'proven_outbound_scan');
    await cycle();
    const row = sealed(chainRecordPeId(tx));
    expect(row).toMatchObject({ actionType: 'send', userId: OWNER, mint_status: 'eligible', mint_disposition: 'eligible' });
    expect(row.estimatedPVT as number).toBeGreaterThan(0);
  });

  it('GREEN: a DAI send from the proven address (a known non-USDC token) mints', async () => {
    const tx = nextTx();
    chain.set(tx, daiTransfer(tx, P, P, STRANGER));
    await queueProven(tx, P, 'human', 'proven_outbound_scan');
    await cycle();
    expect(sealed(chainRecordPeId(`8453:${tx}:9`))).toMatchObject({ actionType: 'send', userId: OWNER, mint_status: 'eligible' });
  });

  it('NEGATIVE CONTROL: a FIRST DAI receive from a stranger on the proven address mints 0', async () => {
    const tx = nextTx();
    chain.set(tx, daiTransfer(tx, STRANGER, STRANGER, P));
    await queueProven(tx, P, 'human', 'inbound_scan');
    await cycle();
    expect(sealed(chainRecordPeId(`8453:${tx}:9`, 'receive'))).toMatchObject({
      actionType: 'receive', userId: OWNER, mint_disposition: 'record_only',
      disposition_reason_code: 'unsolicited_receive_record_only', estimatedPVT: 0,
    });
  });

  it('GREEN twin: after the person dealt with that address, its DAI receive on the proven address mints', async () => {
    const send = nextTx();
    chain.set(send, ethSend(send, P, STRANGER));
    await queueProven(send, P, 'human', 'proven_outbound_scan');
    await cycle();
    const tx = nextTx();
    chain.set(tx, daiTransfer(tx, STRANGER, STRANGER, P));
    await queueProven(tx, P, 'human', 'inbound_scan');
    await cycle();
    expect(sealed(chainRecordPeId(`8453:${tx}:9`, 'receive'))).toMatchObject({ actionType: 'receive', mint_disposition: 'eligible' });
  });

  it('mint-once: one transaction found by both scans is one observation and one PE', async () => {
    const tx = nextTx();
    chain.set(tx, ethSend(tx, P, STRANGER));
    await queueProven(tx, P, 'human', 'proven_outbound_scan');
    await queueProven(tx, P, 'human', 'inbound_scan');
    await cycle();
    await cycle();
    expect(historyRows().filter((r) => r.actionType === 'send')).toHaveLength(1);
  });

  it('RED: an act before the proof\'s H+1 fence mints nothing', async () => {
    mockDb.store.set(`${HUMAN_PROVEN_ADDRESSES_COLLECTION}/${P}`, {
      schema_version: HUMAN_PROVEN_ADDRESS_SCHEMA, address: P, user_id: H.user, wallet_id: H.wallet,
      ...proofFields(TEST_BLOCK + 1),
    });
    const tx = nextTx();
    chain.set(tx, ethSend(tx, P, STRANGER));
    await queueProven(tx, P, 'human', 'proven_outbound_scan');
    await cycle();
    expect(historyRows()).toHaveLength(0);
  });

  it('RED: an act before the proven-address landing mints nothing', async () => {
    const tx = nextTx();
    chain.set(tx, ethSend(tx, P, STRANGER, PROVEN_ADDRESS_COMMERCE_CUT_LINE_MS - 1));
    await queueProven(tx, P, 'human', 'proven_outbound_scan');
    await cycle();
    expect(historyRows()).toHaveLength(0);
  });
});

describe('an AGENT\'s proven address gets the same terms in every known token', () => {
  it('GREEN: a DAI send from the agent\'s proven address to a stranger mints, attributed to the agent', async () => {
    const tx = nextTx();
    chain.set(tx, daiTransfer(tx, Q, Q, STRANGER));
    await queueProven(tx, Q, 'agent', 'proven_outbound_scan');
    await cycle();
    expect(sealed(chainRecordPeId(`8453:${tx}:9`))).toMatchObject({ actionType: 'send', userId: A.agent, mint_status: 'eligible' });
  });

  it('NEGATIVE CONTROL: the agent\'s proven address paying its linked human\'s proven address mints 0', async () => {
    const tx = nextTx();
    chain.set(tx, ethSend(tx, Q, P));
    await queueProven(tx, Q, 'agent', 'proven_outbound_scan');
    await cycle();
    expect(sealed(chainRecordPeId(tx))).toMatchObject({
      mint_disposition: 'record_only', disposition_reason_code: 'self_or_shared_beneficial_ownership',
    });
  });

  it('NEGATIVE CONTROL: a first DAI receive from a stranger on the agent\'s proven address mints 0', async () => {
    const tx = nextTx();
    chain.set(tx, daiTransfer(tx, STRANGER, STRANGER, Q));
    await queueProven(tx, Q, 'agent', 'inbound_scan');
    await cycle();
    expect(sealed(chainRecordPeId(`8453:${tx}:9`, 'receive'))).toMatchObject({ actionType: 'receive', mint_disposition: 'record_only' });
  });
});

describe('every watcher attributes a person\'s proven address to that person', () => {
  it('the shared enumeration lists the person\'s proven address under the person', async () => {
    expect(await enumeratePersonProvenAddresses(mockDb as unknown as Firestore)).toEqual([
      { address: P, walletId: H.wallet, userId: H.user, provenAtBlock: PROOF_HEAD + 1, provenAtMs: 1_000 },
    ]);
  });

  it('RED: a released person wallet is not watched (excluded, never attributed)', async () => {
    mockDb.store.set(`wallets/${H.wallet}`, { ...(mockDb.store.get(`wallets/${H.wallet}`) as object), released_at_ms: 5 });
    const excluded: unknown[] = [];
    expect(await enumeratePersonProvenAddresses(mockDb as unknown as Firestore, (e) => excluded.push(e))).toEqual([]);
    expect(excluded).toHaveLength(1);
  });

  it('outbound USDC watcher: a USDC send from the person\'s proven address mints AS THE PERSON; to their own wallet, 0', async () => {
    const listed = await buildBaseOutboundDeps(realDeps()).listWatchedAddresses();
    const person = listed.find((a) => a.address === P);
    expect(person).toEqual({ address: P, walletId: H.wallet, agentId: H.user, provenAtBlock: PROOF_HEAD + 1, source: 'external_proven_person' });
    const out = buildBaseOutboundDeps(realDeps());
    const tx1 = nextTx();
    await out.emitActivityPE(person!, { txHash: tx1, logIndex: 1, blockNumber: TEST_BLOCK, toAddress: STRANGER, amountUsd: 5, amountAtomic: '5000000', observedAtMs: DAY },
      'send', { verified: true, finality_confirmations: 12, tx_hash: tx1, log_index: 1, asset: 'USDC' }, 'log');
    expect(sealed(outboundUsdcPeId(8453, tx1, 1))).toMatchObject({ actionType: 'send', userId: OWNER, mint_status: 'eligible' });
    const tx2 = nextTx();
    await out.emitActivityPE(person!, { txHash: tx2, logIndex: 1, blockNumber: TEST_BLOCK, toAddress: H.address, amountUsd: 5, amountAtomic: '5000000', observedAtMs: DAY },
      'send', { verified: true, finality_confirmations: 12, tx_hash: tx2, log_index: 1, asset: 'USDC' }, 'log');
    expect(sealed(outboundUsdcPeId(8453, tx2, 1))).toMatchObject({ mint_disposition: 'record_only', estimatedPVT: 0 });
  });

  it('inbound USDC watcher: a USDC receive on the person\'s proven address is the PERSON\'s; from a stranger first, 0', async () => {
    const tx = nextTx();
    await buildBaseInboundDeps(realDeps()).emitFundingPE(
      { walletId: H.wallet, agentId: H.user, address: P, createdAtMs: 1_000, eligibilityStartBlock: PROOF_HEAD + 1,
        ownerType: 'human', isExternalProven: true, provenAtBlock: PROOF_HEAD + 1 },
      { txHash: tx, logIndex: 3, blockNumber: TEST_BLOCK, fromAddress: STRANGER, amountUsd: 5, amountAtomic: '5000000', observedAtMs: DAY },
      { verified: true, finality_confirmations: 12, tx_hash: tx, log_index: 3, asset: 'USDC' },
    );
    expect(sealed(inboundUsdcPeId(8453, tx, 3))).toMatchObject({
      actionType: 'receive', userId: OWNER, mint_disposition: 'record_only', disposition_reason_code: 'unsolicited_receive_record_only',
    });
  });
});

describe('proving pays nothing', () => {
  it('NEGATIVE CONTROL: the person\'s proof receipt seals record_only at 0 PVT through the real accrual', async () => {
    mockDb.store.delete(`${HUMAN_PROVEN_ADDRESSES_COLLECTION}/${P}`);
    const store = new Map<string, unknown>();
    const cache = {
      isEnabled: () => true,
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: unknown) => { store.set(k, v); },
      del: async (k: string) => { store.delete(k); },
      setNx: async (k: string, v: unknown) => { if (store.has(k)) return false; store.set(k, v); return true; },
    };
    const deps = { ...realDeps(), cache } as unknown as AgentBankDeps;
    const chainDeps: ProofChainDeps = {
      getProofFence: async () => ({
        schemaVersion: 'external-proof-fence/v1', chainId: 8453,
        observedHeadBlock: PROOF_HEAD, proofBlockNumber: PROOF_HEAD - 11, proofBlockHash: `0x${'ab'.repeat(32)}`,
        provenAtBlock: PROOF_HEAD + 1, minActivityConfirmations: 12, rpcOperatorIds: ['op-a', 'op-b'],
      }),
      getTransactionCount: async () => 3,
      revalidateProofFence: async () => {},
      verifySignature: async () => ({ ok: true, method: 'eip191_eoa' }),
    };
    const challenge = await issuePersonChallenge(cache as never, { userId: H.user, address: P, now: DAY });
    expect(challenge.message).toContain(`person: ${H.user}`);
    const result = await provePersonExternalAddress(deps, {
      userId: H.user, humanWalletId: H.wallet, address: P, challengeId: challenge.challenge_id, signature: '0xsig', now: DAY,
    }, chainDeps);
    expect(result).toMatchObject({ ok: true, proven_address: P, proven_at_block: PROOF_HEAD + 1 });
    // The proof PE's accrual runs off the request path (no awaitAccrual): let it land.
    for (let i = 0; i < 200 && !meterActRow(mockDb.store, result.pe_id!); i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const row = sealed(result.pe_id!);
    expect(row).toMatchObject({ actionType: 'external_address_proven', userId: OWNER, mint_disposition: 'record_only', estimatedPVT: 0 });
    expect(row.mint_status).not.toBe('eligible');
    expect(mockDb.store.get(`${HUMAN_PROVEN_ADDRESSES_COLLECTION}/${P}`)).toMatchObject({ user_id: H.user, wallet_id: H.wallet });
  });
});
