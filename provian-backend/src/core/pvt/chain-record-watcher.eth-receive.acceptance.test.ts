/**
 * 2026-10-01 (the invariant: , reinstated 09-30; it carves out no
 * asset) — ETH RECEIVES MINT, for native wallets and proven addresses, people and
 * agents, on the unchanged / terms. The money outcome is driven through
 * the chain-record lane's PRODUCTION emit into the REAL `generatePE` → REAL
 * `recordPEAccrual` over a fake Firestore; only chain reads are injected.
 *
 * the operator’s negative controls, each beside the GREEN twin that differs in one variable:
 * - a FIRST ETH receive from a stranger mints 0 (vs. one from a counterparty
 * the wallet has dealt with: mints);
 * - an ETH transfer between a person's wallet and their own proven address
 * mints 0, in both directions (vs. the same ETH from a dealt stranger: mints).
 * Also: the `receive` ceiling (50 per actor per UTC day), one transaction
 * mints once per actor, and nothing before the landing mints.
 *
 * The suite runs on the fixture's clock, never the wall clock: a record's queue
 * stamp is `Date.now()`, and from 2026-10-03T00:00Z (the cycle instant) a real
 * stamp was later than the cycle, so 14 of 28 failed. RED control at the end.
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
import { actRecorded, meterActIds, meterActRow, meterActRows } from './__test-helpers__/meter-acts';
import type { AgentBankDeps } from '../agent-bank/types';
import {
  ETH_RECEIVE_COMMERCE_CUT_LINE_MS,
  INTERNAL_ETH_RECEIVE_CUT_LINE_MS,
  PROVEN_ADDRESS_COMMERCE_CUT_LINE_MS,
  buildChainRecordWatcherDeps,
  chainRecordEnqueue,
  chainRecordPeId,
  enqueueChainRecordObservation,
  provenObservationWalletId,
  runChainRecordWatcherCycle,
  type ChainRecordSource,
} from './chain-record-watcher';
import {
  BASE_USDC_ADDRESS,
  type BaseInternalEthEvidence,
  type BaseTransactionEvidence,
  type InternalEthFrame,
} from '../onchain/economic-discovery';
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
const DAY = Math.max(PROVEN_ADDRESS_COMMERCE_CUT_LINE_MS, ETH_RECEIVE_COMMERCE_CUT_LINE_MS, INTERNAL_ETH_RECEIVE_CUT_LINE_MS) + 4 * 3_600_000;
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
/** The agreed trace of a transaction (both trace legs), when one is readable. */
const traces = new Map<string, BaseInternalEthEvidence>();

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
async function cycle(at = DAY + 86_400_000): Promise<void> {
  await runChainRecordWatcherCycle({
    ...buildChainRecordWatcherDeps(realDeps()),
    verifyTransaction: async (tx) => {
      const found = chain.get(tx);
      if (!found) throw new Error('economic_evidence_pending:transaction_unavailable');
      return found;
    },
    readInternalEth: async (tx) => {
      const found = traces.get(tx);
      if (!found) throw new Error('economic_discovery_trace_unavailable');
      return found;
    },
    now: () => at,
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
  traces.clear();
  seed();
});

afterEach(() => { jest.spyOn(Date, 'now').mockRestore(); });


const B = { wallet: 'wB', agent: 'agentB', address: '0xb0b0000000000000000000000000000000000b0b' };
function seedUnlinkedAgent(): void {
  mockDb.store.set(`agent_wallets/${B.wallet}`, {
    id: B.wallet, agent_id: B.agent, address: B.address, platform: 'claude', status: 'active',
    native_watcher_registration: createNativeWalletRegistrationFence(TEST_BLOCK - 1_000),
  });
  mockDb.store.set(`${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(B.address)}`, {
    schema_version: 'native-wallet-address-index/v1', chain_id: 8453, address: B.address,
    wallet_id: B.wallet, owner_type: 'agent', owner_id: B.agent, created_at_ms: 1,
  });
  mockDb.store.set(`${NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION}/${nativeAgentRegistrationIndexId(B.agent)}`, { wallet_id: B.wallet });
}

/** An ETH receive observation as the inbound scan queues it. */
async function queueInbound(tx: string, walletId: string, ownerType: 'human' | 'agent'): Promise<void> {
  await enqueueChainRecordObservation(mockDb as unknown as Firestore, {
    txHash: tx, walletId, source: 'inbound_scan', ownerType,
  }, DAY);
}
const receivePe = (tx: string) => chainRecordPeId(tx, 'receive');
/** ETH that arrived inside a transaction: keyed on the transaction AND the recipient. */
const internalPe = (tx: string, recipient: string) => chainRecordPeId(`${tx}:eth:${recipient}`, 'receive');
/** The internal-ETH receive PE of `tx`, whichever watched address received it (one per test). */
function internalPeFor(tx: string): string {
  const ids = [H.address, A.address, P, Q, '0xb0b0000000000000000000000000000000000b0b'].map((a) => internalPe(tx, a));
  return ids.find((id) => meterActRow(mockDb.store, id) !== undefined) ?? ids[0];
}
/** A later cycle, past any retry back-off. */
const LATER = DAY + 2 * 86_400_000;

/** The agreed trace of `evidence` carrying exactly `frames` (as both trace legs return it). */
function traceOf(evidence: BaseTransactionEvidence, frames: InternalEthFrame[]): BaseInternalEthEvidence {
  return {
    schemaVersion: 'base-internal-eth-evidence/v1',
    transactionHash: evidence.transactionHash,
    blockNumber: evidence.blockNumber,
    blockHash: evidence.blockHash,
    providerOperatorIds: ['alchemy', 'drpc'],
    frames,
    evidenceHash: `0x${crypto.createHash('sha256').update(JSON.stringify(frames)).digest('hex')}`,
  };
}

/** The wallet deals with `counterparty` first: an ETH send it signed, recorded and minted by the lane. */

describe('ETH receives on a PERSON\'s native wallet', () => {
  it('NEGATIVE CONTROL: a FIRST ETH receive from a stranger mints 0', async () => {
    const tx = nextTx();
    chain.set(tx, ethSend(tx, STRANGER, H.address));
    await queueInbound(tx, H.wallet, 'human');
    await cycle();
    // The PE id is the `receive` namespace over the bare tx hash: the native leg's key.
    expect(sealed(receivePe(tx))).toMatchObject({
      actionType: 'receive', userId: OWNER, mint_disposition: 'record_only',
      disposition_reason_code: 'unsolicited_receive_record_only', estimatedPVT: 0,
    });
  });

  it('GREEN twin: after the person sent to that address, its ETH receive mints, as the person', async () => {
    const send = nextTx();
    chain.set(send, ethSend(send, H.address, STRANGER));
    await appRecord(send);
    await cycle();
    expect(sealed(chainRecordPeId(send))).toMatchObject({ actionType: 'send', mint_status: 'eligible' });
    const tx = nextTx();
    chain.set(tx, ethSend(tx, STRANGER, H.address));
    await queueInbound(tx, H.wallet, 'human');
    await cycle();
    const row = sealed(receivePe(tx));
    expect(row).toMatchObject({ actionType: 'receive', userId: OWNER, mint_status: 'eligible', mint_disposition: 'eligible' });
    expect(row.estimatedPVT as number).toBeGreaterThan(0);
  });
});

describe('ETH between a person\'s wallet and their OWN proven address mints 0, both ways', () => {
  it('NEGATIVE CONTROL: ETH from the person\'s native wallet arriving at their proven address — the receive mints 0', async () => {
    const tx = nextTx();
    chain.set(tx, ethSend(tx, H.address, P));
    await queueProven(tx, P, 'human', 'inbound_scan');
    await cycle();
    expect(sealed(receivePe(tx))).toMatchObject({
      actionType: 'receive', userId: OWNER, mint_disposition: 'record_only',
      disposition_reason_code: 'self_or_shared_beneficial_ownership', estimatedPVT: 0,
    });
  });

  it('NEGATIVE CONTROL: ETH from the proven address arriving at the person\'s native wallet — the receive mints 0', async () => {
    const tx = nextTx();
    chain.set(tx, ethSend(tx, P, H.address));
    await queueInbound(tx, H.wallet, 'human');
    await cycle();
    expect(sealed(receivePe(tx))).toMatchObject({
      actionType: 'receive', userId: OWNER, mint_disposition: 'record_only',
      disposition_reason_code: 'self_or_shared_beneficial_ownership', estimatedPVT: 0,
    });
  });

  it('GREEN twin: ETH from a counterparty the proven address has dealt with mints, as the person', async () => {
    const send = nextTx();
    chain.set(send, ethSend(send, P, STRANGER));
    await queueProven(send, P, 'human', 'proven_outbound_scan');
    await cycle();
    const tx = nextTx();
    chain.set(tx, ethSend(tx, STRANGER, P));
    await queueProven(tx, P, 'human', 'inbound_scan');
    await cycle();
    expect(sealed(receivePe(tx))).toMatchObject({ actionType: 'receive', userId: OWNER, mint_status: 'eligible' });
  });
});

describe('ETH receives for AGENTS: native wallet and proven address', () => {
  it('NEGATIVE CONTROL: a first ETH receive from a stranger on the agent\'s native wallet mints 0', async () => {
    const tx = nextTx();
    chain.set(tx, ethSend(tx, STRANGER, A.address));
    await queueInbound(tx, A.wallet, 'agent');
    await cycle();
    expect(sealed(receivePe(tx))).toMatchObject({ actionType: 'receive', userId: A.agent, mint_disposition: 'record_only', estimatedPVT: 0 });
  });

  it('GREEN: after the agent sent to that address, its ETH receive on the native wallet mints', async () => {
    const send = nextTx();
    chain.set(send, ethSend(send, A.address, STRANGER));
    const e = chainRecordEnqueue(mockDb as unknown as Firestore, { txHash: send, walletId: A.wallet, source: 'transfer_record' });
    await mockDb.runTransaction(async (txn) => { await e.read(txn as never); e.write(txn as never, 'pe_rec_agent'); });
    await cycle();
    const tx = nextTx();
    chain.set(tx, ethSend(tx, STRANGER, A.address));
    await queueInbound(tx, A.wallet, 'agent');
    await cycle();
    expect(sealed(receivePe(tx))).toMatchObject({ actionType: 'receive', userId: A.agent, mint_status: 'eligible' });
  });

  it('GREEN: the agent\'s proven address — a dealt counterparty\'s ETH mints, as the agent; a stranger\'s first does not', async () => {
    const send = nextTx();
    chain.set(send, ethSend(send, Q, STRANGER));
    await queueProven(send, Q, 'agent', 'proven_outbound_scan');
    await cycle();
    const tx = nextTx();
    chain.set(tx, ethSend(tx, STRANGER, Q));
    await queueProven(tx, Q, 'agent', 'inbound_scan');
    await cycle();
    expect(sealed(receivePe(tx))).toMatchObject({ actionType: 'receive', userId: A.agent, mint_status: 'eligible' });
    const other = '0x6000000000000000000000000000000000000006';
    const tx2 = nextTx();
    chain.set(tx2, ethSend(tx2, other, Q));
    await queueProven(tx2, Q, 'agent', 'inbound_scan');
    await cycle();
    expect(sealed(receivePe(tx2))).toMatchObject({ mint_disposition: 'record_only', disposition_reason_code: 'unsolicited_receive_record_only' });
  });

  it('NEGATIVE CONTROL: ETH from the person\'s wallet to their own linked agent mints 0 for the agent', async () => {
    const tx = nextTx();
    chain.set(tx, ethSend(tx, H.address, A.address));
    await queueInbound(tx, A.wallet, 'agent');
    await cycle();
    expect(sealed(receivePe(tx))).toMatchObject({ mint_disposition: 'record_only', disposition_reason_code: 'self_or_shared_beneficial_ownership' });
  });
});

describe('the unchanged invariants', () => {
  it('one transaction mints once per actor: the sender\'s send and the recipient\'s receive are two acts, each once, however often it is queued', async () => {
    seedUnlinkedAgent();
    // B deals with H first (an ETH send B signed), so H\'s later ETH to B is a dealt receive.
    const deal = nextTx();
    chain.set(deal, ethSend(deal, B.address, H.address));
    const e = chainRecordEnqueue(mockDb as unknown as Firestore, { txHash: deal, walletId: B.wallet, source: 'transfer_record' });
    await mockDb.runTransaction(async (txn) => { await e.read(txn as never); e.write(txn as never, 'pe_rec_b'); });
    await cycle();
    const tx = nextTx();
    chain.set(tx, ethSend(tx, H.address, B.address));
    await appRecord(tx);
    await queueInbound(tx, B.wallet, 'agent');
    await queueInbound(tx, B.wallet, 'agent');
    await cycle();
    await cycle();
    const ofTx = meterActIds(mockDb.store).filter((id) => id === receivePe(tx) || id === chainRecordPeId(tx));
    expect(ofTx).toHaveLength(2);
    expect(sealed(receivePe(tx))).toMatchObject({ actionType: 'receive', userId: B.agent, mint_status: 'eligible' });
    expect(sealed(chainRecordPeId(tx))).toMatchObject({ actionType: 'send', userId: OWNER, mint_status: 'eligible' });
    // Queued twice, cycled twice: still one receive row for B in all of history.
    expect(historyRows().filter((r) => r.actionType === 'receive' && r.userId === B.agent)).toHaveLength(1);
  });

  it('the receive ceiling applies: after 50 minted receives in a UTC day, the next ETH receive is capped', async () => {
    const send = nextTx();
    chain.set(send, ethSend(send, H.address, STRANGER));
    await appRecord(send);
    await cycle();
    for (let i = 0; i < 51; i += 1) {
      const tx = nextTx();
      chain.set(tx, ethSend(tx, STRANGER, H.address, DAY + 1_000 + i));
      await queueInbound(tx, H.wallet, 'human');
    }
    await cycle();
    const receives = historyRows().filter((r) => r.actionType === 'receive');
    expect(receives).toHaveLength(51);
    expect(receives.filter((r) => r.mint_status === 'eligible')).toHaveLength(50);
    const capped = receives.filter((r) => r.mint_status !== 'eligible');
    expect(capped).toHaveLength(1);
    expect(capped[0].estimatedPVT).toBe(0);
  });

  it('RED: an ETH receive before the ETH-receive landing mints nothing (no PE)', async () => {
    const send = nextTx();
    chain.set(send, ethSend(send, H.address, STRANGER));
    await appRecord(send);
    await cycle();
    const tx = nextTx();
    chain.set(tx, ethSend(tx, STRANGER, H.address, ETH_RECEIVE_COMMERCE_CUT_LINE_MS - 1));
    await queueInbound(tx, H.wallet, 'human');
    await cycle();
    expect(actRecorded(mockDb.store, receivePe(tx))).toBe(false);
  });

  it('native value with calldata into the wallet: not a plain transfer, but ETH arriving inside the transaction (2026-10-01)', async () => {
    const tx = nextTx();
    const evidence = transactionEvidence({
      transactionHash: tx, fromAddress: STRANGER, toAddress: H.address, valueWei: '1000', inputEmpty: false,
      transactionSelector: '0x12345678', blockTimestampMs: DAY,
    });
    chain.set(tx, evidence);
    await queueInbound(tx, H.wallet, 'human');
    // With no readable trace the lane waits: nothing is sealed on one read alone.
    await cycle();
    expect(historyRows()).toHaveLength(0);
    traces.set(tx, traceOf(evidence, [{ traceAddress: [], kind: 'call', fromAddress: STRANGER, toAddress: H.address, valueWei: '1000' }]));
    await cycle(LATER);
    // A first receive from a stranger: recorded, mints 0.
    expect(sealed(internalPe(tx, H.address))).toMatchObject({ actionType: 'receive', mint_disposition: 'record_only', estimatedPVT: 0 });
  });
});

// =============================================================================
// 2026-10-01 — ETH THAT ARRIVES INSIDE A TRANSACTION MINTS on the same
// terms as a plain ETH receive: a smart wallet's (Coinbase's) or any contract's
// internal transfer, for native wallets and proven addresses, people and agents.
// The counterparty is the address that sent the ETH.
// =============================================================================

/** A Coinbase-style smart wallet, run through a bundler and the ERC-4337 EntryPoint. */
const SMART_WALLET = '0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a';
const BUNDLER = '0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0';
const ENTRY_POINT = '0x0000000071727de22e5e9d8baf0edac6f37da032';
const ETH = '700000000000000';

/** `sender` (a smart wallet or contract) sends `to` ETH inside a bundler's transaction. */
function internalSend(tx: string, sender: string, to: string, ts = DAY): BaseTransactionEvidence {
  const evidence = transactionEvidence({
    transactionHash: tx, fromAddress: BUNDLER, toAddress: ENTRY_POINT, valueWei: '0', inputEmpty: false,
    transactionSelector: '0x765e827f', blockTimestampMs: ts,
  });
  chain.set(tx, evidence);
  traces.set(tx, traceOf(evidence, [{ traceAddress: [0, 0, 0], kind: 'call', fromAddress: sender, toAddress: to, valueWei: ETH }]));
  return evidence;
}

/** The person deals with `counterparty` first: an ETH send the person signed, recorded and minted. */
async function personDealsWith(counterparty: string): Promise<void> {
  const send = nextTx();
  chain.set(send, ethSend(send, H.address, counterparty));
  await appRecord(send);
  await cycle();
  expect(sealed(chainRecordPeId(send))).toMatchObject({ actionType: 'send', mint_status: 'eligible' });
}

describe('ETH that arrives INSIDE a transaction (internal transfer) — a person\'s native wallet', () => {
  it('NEGATIVE CONTROL: a FIRST internal ETH receive from a stranger\'s smart wallet mints 0', async () => {
    const tx = nextTx();
    internalSend(tx, SMART_WALLET, H.address);
    await queueInbound(tx, H.wallet, 'human');
    await cycle();
    expect(sealed(internalPeFor(tx))).toMatchObject({
      actionType: 'receive', userId: OWNER, mint_disposition: 'record_only',
      disposition_reason_code: 'unsolicited_receive_record_only', estimatedPVT: 0,
    });
  });

  it('GREEN twin: after the person sent to that smart wallet, its internal ETH mints, as the person', async () => {
    await personDealsWith(SMART_WALLET);
    const tx = nextTx();
    internalSend(tx, SMART_WALLET, H.address);
    await queueInbound(tx, H.wallet, 'human');
    await cycle();
    const row = sealed(internalPeFor(tx));
    expect(row).toMatchObject({ actionType: 'receive', userId: OWNER, mint_status: 'eligible', mint_disposition: 'eligible' });
    expect(row.estimatedPVT as number).toBeGreaterThan(0);
  });

  it('NEGATIVE CONTROL: internal ETH from the person\'s OWN proven smart wallet to their Provian wallet mints 0', async () => {
    const tx = nextTx();
    internalSend(tx, P, H.address);
    await queueInbound(tx, H.wallet, 'human');
    await cycle();
    expect(sealed(internalPeFor(tx))).toMatchObject({
      actionType: 'receive', userId: OWNER, mint_disposition: 'record_only',
      disposition_reason_code: 'self_or_shared_beneficial_ownership', estimatedPVT: 0,
    });
  });

  it('RED: ETH a Provian institution sends is the institution watcher\'s; and a call INTO an institution derives nothing', async () => {
    await personDealsWith(SMART_WALLET);
    const escrow = [...(await import('./chain-record-watcher')).CHAIN_RECORD_INSTITUTION_TARGETS][0];
    const fromInstitution = nextTx();
    internalSend(fromInstitution, escrow, H.address);
    await queueInbound(fromInstitution, H.wallet, 'human');
    const intoInstitution = nextTx();
    const evidence = transactionEvidence({
      transactionHash: intoInstitution, fromAddress: BUNDLER, toAddress: escrow, valueWei: '0', inputEmpty: false,
      transactionSelector: '0x12345678', blockTimestampMs: DAY,
    });
    chain.set(intoInstitution, evidence);
    traces.set(intoInstitution, traceOf(evidence, [{ traceAddress: [0], kind: 'call', fromAddress: SMART_WALLET, toAddress: H.address, valueWei: ETH }]));
    await queueInbound(intoInstitution, H.wallet, 'human');
    await cycle();
    expect(actRecorded(mockDb.store, internalPeFor(fromInstitution))).toBe(false);
    expect(actRecorded(mockDb.store, internalPeFor(intoInstitution))).toBe(false);
  });

  it('RED: before the internal-ETH landing nothing mints, even from a dealt counterparty (no PE)', async () => {
    await personDealsWith(SMART_WALLET);
    const tx = nextTx();
    internalSend(tx, SMART_WALLET, H.address, INTERNAL_ETH_RECEIVE_CUT_LINE_MS - 1);
    await queueInbound(tx, H.wallet, 'human');
    await cycle();
    expect(actRecorded(mockDb.store, internalPeFor(tx))).toBe(false);
    // GREEN twin: at the landing instant it mints.
    const at = nextTx();
    internalSend(at, SMART_WALLET, H.address, INTERNAL_ETH_RECEIVE_CUT_LINE_MS);
    await queueInbound(at, H.wallet, 'human');
    await cycle();
    expect(sealed(internalPeFor(at))).toMatchObject({ actionType: 'receive', mint_status: 'eligible' });
  });

  it('RED: a trace that cannot be read on both legs, or names another block, waits — never mints on one read', async () => {
    await personDealsWith(SMART_WALLET);
    const tx = nextTx();
    const evidence = internalSend(tx, SMART_WALLET, H.address);
    traces.set(tx, { ...traces.get(tx)!, blockHash: `0x${'cd'.repeat(32)}` });
    await queueInbound(tx, H.wallet, 'human');
    await cycle();
    expect(actRecorded(mockDb.store, internalPeFor(tx))).toBe(false);
    traces.delete(tx);
    await cycle(DAY + 86_400_000 + 3_600_000);
    expect(actRecorded(mockDb.store, internalPeFor(tx))).toBe(false);
    // Once both legs agree on the verified block, it mints.
    traces.set(tx, traceOf(evidence, [{ traceAddress: [0, 0, 0], kind: 'call', fromAddress: SMART_WALLET, toAddress: H.address, valueWei: ETH }]));
    await cycle(LATER);
    expect(sealed(internalPeFor(tx))).toMatchObject({ actionType: 'receive', mint_status: 'eligible' });
  });
});

describe('ETH that arrives INSIDE a transaction — agents, and proven addresses', () => {
  it('NEGATIVE CONTROL + GREEN: the agent\'s native wallet — a stranger\'s first internal ETH mints 0; a dealt one mints, as the agent', async () => {
    const first = nextTx();
    internalSend(first, SMART_WALLET, A.address);
    await queueInbound(first, A.wallet, 'agent');
    await cycle();
    expect(sealed(internalPeFor(first))).toMatchObject({ actionType: 'receive', userId: A.agent, mint_disposition: 'record_only', estimatedPVT: 0 });
    const send = nextTx();
    chain.set(send, ethSend(send, A.address, SMART_WALLET));
    const e = chainRecordEnqueue(mockDb as unknown as Firestore, { txHash: send, walletId: A.wallet, source: 'transfer_record' });
    await mockDb.runTransaction(async (txn) => { await e.read(txn as never); e.write(txn as never, 'pe_rec_agent_sw'); });
    await cycle();
    const tx = nextTx();
    internalSend(tx, SMART_WALLET, A.address);
    await queueInbound(tx, A.wallet, 'agent');
    await cycle();
    expect(sealed(internalPeFor(tx))).toMatchObject({ actionType: 'receive', userId: A.agent, mint_status: 'eligible' });
  });

  it('GREEN: the agent\'s proven address receives a dealt counterparty\'s internal ETH — mints, as the agent', async () => {
    const send = nextTx();
    chain.set(send, ethSend(send, Q, SMART_WALLET));
    await queueProven(send, Q, 'agent', 'proven_outbound_scan');
    await cycle();
    const tx = nextTx();
    internalSend(tx, SMART_WALLET, Q);
    await queueProven(tx, Q, 'agent', 'inbound_scan');
    await cycle();
    expect(sealed(internalPeFor(tx))).toMatchObject({ actionType: 'receive', userId: A.agent, mint_status: 'eligible' });
  });

  it('NEGATIVE CONTROL: internal ETH from the person\'s native wallet\'s smart-wallet route into their own proven address mints 0', async () => {
    const tx = nextTx();
    internalSend(tx, H.address, P);
    await queueProven(tx, P, 'human', 'inbound_scan');
    await cycle();
    expect(sealed(internalPeFor(tx))).toMatchObject({
      actionType: 'receive', userId: OWNER, mint_disposition: 'record_only', disposition_reason_code: 'self_or_shared_beneficial_ownership',
    });
  });
});

describe('ETH that arrives inside a transaction — the unchanged invariants', () => {
  const USDT = '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2';
  const WETH = '0x4200000000000000000000000000000000000006';
  const SETTLER = '0x5e77e70000000000000000000000000000000005';
  const ALLOWANCE_HOLDER = '0x0000000000001ff3684f28c67538d4d072c22734';

  it('NEGATIVE CONTROL: a swap that pays out ETH mints ONCE, as the swap — never also as a receive', async () => {
    const tx = nextTx();
    const amount = 5n * 10n ** 17n;
    const evidence = transactionEvidence({
      transactionHash: tx, fromAddress: H.address, toAddress: ALLOWANCE_HOLDER, valueWei: '0', inputEmpty: false,
      transactionSelector: '0x2213bc0b', blockTimestampMs: DAY,
      logs: [
        transferLog(tx, USDT, H.address, SETTLER, 10n ** 9n, 1),
        {
          ...transferLog(tx, WETH, SETTLER, WETH, amount, 2),
          // WETH9 Withdrawal(src, wad): the settler unwraps the ETH it pays out.
          topics: ['0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65', `0x${SETTLER.slice(2).padStart(64, '0')}`],
        },
      ],
    });
    chain.set(tx, evidence);
    traces.set(tx, traceOf(evidence, [
      { traceAddress: [0, 3], kind: 'call', fromAddress: WETH, toAddress: SETTLER, valueWei: amount.toString() },
      { traceAddress: [0, 4], kind: 'call', fromAddress: SETTLER, toAddress: H.address, valueWei: amount.toString() },
    ]));
    // Found twice: the app's swap record AND the trace scan's pointer for the ETH payout.
    const e = chainRecordEnqueue(mockDb as unknown as Firestore, { txHash: tx, walletId: H.wallet, source: 'app_swap_record', ownerType: 'human' });
    await mockDb.runTransaction(async (txn) => { await e.read(txn as never); e.write(txn as never, 'pe_app_swap'); });
    await queueInbound(tx, H.wallet, 'human');
    await cycle();
    await cycle(LATER);
    const ofTx = historyRows().filter((r) => r.userId === OWNER && (r.actionType === 'swap' || r.actionType === 'receive'));
    expect(ofTx).toHaveLength(1);
    expect(ofTx[0]).toMatchObject({ actionType: 'swap', mint_status: 'eligible' });
    expect(actRecorded(mockDb.store, internalPeFor(tx))).toBe(false);
  });

  it('one transaction mints once: a DAI receive and internal ETH to the same wallet in one transaction are ONE receive', async () => {
    await personDealsWith(SMART_WALLET);
    const tx = nextTx();
    const evidence = transactionEvidence({
      transactionHash: tx, fromAddress: BUNDLER, toAddress: ENTRY_POINT, valueWei: '0', inputEmpty: false,
      transactionSelector: '0x765e827f', blockTimestampMs: DAY,
      logs: [transferLog(tx, DAI, SMART_WALLET, H.address, 10n ** 18n, 4)],
    });
    chain.set(tx, evidence);
    traces.set(tx, traceOf(evidence, [{ traceAddress: [0, 0, 1], kind: 'call', fromAddress: SMART_WALLET, toAddress: H.address, valueWei: ETH }]));
    await queueInbound(tx, H.wallet, 'human');
    await queueInbound(tx, H.wallet, 'human');
    await cycle();
    await cycle(LATER);
    expect(historyRows().filter((r) => r.actionType === 'receive' && r.userId === OWNER)).toHaveLength(1);
  });

  it('the receive ceiling is shared: after 50 plain ETH receives in a UTC day, an internal one is capped', async () => {
    await personDealsWith(STRANGER);
    await personDealsWith(SMART_WALLET);
    for (let i = 0; i < 50; i += 1) {
      const tx = nextTx();
      chain.set(tx, ethSend(tx, STRANGER, H.address, DAY + 1_000 + i));
      await queueInbound(tx, H.wallet, 'human');
    }
    const last = nextTx();
    internalSend(last, SMART_WALLET, H.address, DAY + 5_000);
    await queueInbound(last, H.wallet, 'human');
    await cycle();
    const receives = historyRows().filter((r) => r.actionType === 'receive');
    expect(receives).toHaveLength(51);
    expect(receives.filter((r) => r.mint_status === 'eligible')).toHaveLength(50);
    expect(sealed(internalPeFor(last)).mint_status).not.toBe('eligible');
    expect(sealed(internalPeFor(last)).estimatedPVT).toBe(0);
  });
});

describe('ETH that arrives inside a transaction — ', () => {
  it('one transaction paying SEVERAL Provian recipients: each recipient\'s receive is its own act, each mints once', async () => {
    seedUnlinkedAgent();
    await personDealsWith(SMART_WALLET);
    const deal = nextTx();
    chain.set(deal, ethSend(deal, B.address, SMART_WALLET));
    const e = chainRecordEnqueue(mockDb as unknown as Firestore, { txHash: deal, walletId: B.wallet, source: 'transfer_record' });
    await mockDb.runTransaction(async (txn) => { await e.read(txn as never); e.write(txn as never, 'pe_rec_b_sw'); });
    await cycle();
    // One UserOp batch: the smart wallet pays H and B.
    const tx = nextTx();
    const evidence = transactionEvidence({
      transactionHash: tx, fromAddress: BUNDLER, toAddress: ENTRY_POINT, valueWei: '0', inputEmpty: false,
      transactionSelector: '0x765e827f', blockTimestampMs: DAY,
    });
    chain.set(tx, evidence);
    traces.set(tx, traceOf(evidence, [
      { traceAddress: [0, 0, 0], kind: 'call', fromAddress: SMART_WALLET, toAddress: H.address, valueWei: ETH },
      { traceAddress: [0, 0, 1], kind: 'call', fromAddress: SMART_WALLET, toAddress: B.address, valueWei: ETH },
    ]));
    await queueInbound(tx, H.wallet, 'human');
    await queueInbound(tx, B.wallet, 'agent');
    await queueInbound(tx, B.wallet, 'agent');
    await cycle();
    await cycle(LATER);
    expect(sealed(internalPe(tx, H.address))).toMatchObject({ actionType: 'receive', userId: OWNER, mint_status: 'eligible' });
    expect(sealed(internalPe(tx, B.address))).toMatchObject({ actionType: 'receive', userId: B.agent, mint_status: 'eligible' });
    // Still one receive per recipient for this transaction, however often it was queued.
    expect(historyRows().filter((r) => r.actionType === 'receive' && r.userId === B.agent)).toHaveLength(1);
  });

  it('NEGATIVE CONTROL: the person routes ETH through a contract to their OWN linked agent — the verified signer is the same owner: mints 0', async () => {
    const FORWARDER = '0xf0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0';
    // The agent has dealt with the forwarder (a minted send), so authorship alone would let it mint.
    const deal = nextTx();
    chain.set(deal, ethSend(deal, A.address, FORWARDER));
    const e = chainRecordEnqueue(mockDb as unknown as Firestore, { txHash: deal, walletId: A.wallet, source: 'transfer_record' });
    await mockDb.runTransaction(async (txn) => { await e.read(txn as never); e.write(txn as never, 'pe_rec_a_fw'); });
    await cycle();
    const tx = nextTx();
    const evidence = transactionEvidence({
      transactionHash: tx, fromAddress: H.address, toAddress: FORWARDER, valueWei: ETH, inputEmpty: false,
      transactionSelector: '0x12345678', blockTimestampMs: DAY,
    });
    chain.set(tx, evidence);
    traces.set(tx, traceOf(evidence, [
      { traceAddress: [], kind: 'call', fromAddress: H.address, toAddress: FORWARDER, valueWei: ETH },
      { traceAddress: [0], kind: 'call', fromAddress: FORWARDER, toAddress: A.address, valueWei: ETH },
    ]));
    await queueInbound(tx, A.wallet, 'agent');
    await cycle();
    expect(sealed(internalPe(tx, A.address))).toMatchObject({
      actionType: 'receive', userId: A.agent, mint_disposition: 'record_only',
      disposition_reason_code: 'self_or_shared_beneficial_ownership', estimatedPVT: 0,
    });
    // GREEN twin: the same forwarder paying the agent in a STRANGER's transaction mints.
    const green = nextTx();
    const ev2 = transactionEvidence({
      transactionHash: green, fromAddress: STRANGER, toAddress: FORWARDER, valueWei: ETH, inputEmpty: false,
      transactionSelector: '0x12345678', blockTimestampMs: DAY,
    });
    chain.set(green, ev2);
    traces.set(green, traceOf(ev2, [
      { traceAddress: [], kind: 'call', fromAddress: STRANGER, toAddress: FORWARDER, valueWei: ETH },
      { traceAddress: [0], kind: 'call', fromAddress: FORWARDER, toAddress: A.address, valueWei: ETH },
    ]));
    await queueInbound(green, A.wallet, 'agent');
    await cycle(LATER);
    expect(sealed(internalPe(green, A.address))).toMatchObject({ actionType: 'receive', userId: A.agent, mint_status: 'eligible' });
  });
});

describe('ETH that arrives inside a transaction — ', () => {
  it('seals as CHAIN-witnessed and carries the financial-settlement claim on (recipient address, tx), like a plain ETH receive', async () => {
    await personDealsWith(SMART_WALLET);
    const tx = nextTx();
    internalSend(tx, SMART_WALLET, H.address);
    await queueInbound(tx, H.wallet, 'human');
    await cycle();
    const peId = internalPe(tx, H.address);
    // PE METER: no envelope is stored; the witness class is sealed on the act's priced row.
    const row = sealed(peId);
    expect(row.witness_class).toBe('chain_witnessed');
    expect(row.mint_status).toBe('eligible');
    const claim = JSON.stringify(row.mint_once_claim_evidence);
    expect(claim).toContain(tx);
    expect(claim.toLowerCase()).toContain(H.address);
    // The plain ETH receive carries the same kind of claim (the twin this must match).
    const plain = nextTx();
    chain.set(plain, ethSend(plain, SMART_WALLET, H.address));
    await queueInbound(plain, H.wallet, 'human');
    await cycle();
    expect(sealed(receivePe(plain)).witness_class).toBe('chain_witnessed');
    expect(JSON.stringify(sealed(receivePe(plain)).mint_once_claim_evidence)).toContain(plain);
  });
});

describe('the fixture clock (2026-10-03: 14 of 28 failed once the wall clock passed the cycle instant)', () => {
  it('the suite reads the fixture\'s clock, not the wall clock', () => {
    expect(Date.now()).toBe(DAY);
  });

  it('RED control: a record stamped on a wall clock past the cycle instant is not yet due — the send never seals, so the receive cannot mint', async () => {
    // The old shape: the queue stamp is the real clock, just past the cycle instant.
    jest.spyOn(Date, 'now').mockReturnValue(DAY + 86_400_000 + 1);
    const send = nextTx();
    chain.set(send, ethSend(send, H.address, STRANGER));
    await appRecord(send);
    await cycle();
    expect(actRecorded(mockDb.store, chainRecordPeId(send))).toBe(false);
    const tx = nextTx();
    chain.set(tx, ethSend(tx, STRANGER, H.address));
    await queueInbound(tx, H.wallet, 'human');
    await cycle();
    expect(sealed(receivePe(tx))).toMatchObject({
      mint_disposition: 'record_only', disposition_reason_code: 'unsolicited_receive_record_only', estimatedPVT: 0,
    });
  });

  it('GREEN twin: the same record stamped on the fixture clock is due — the send seals and the dealt receive mints', async () => {
    const send = nextTx();
    chain.set(send, ethSend(send, H.address, STRANGER));
    await appRecord(send);
    await cycle();
    expect(sealed(chainRecordPeId(send))).toMatchObject({ actionType: 'send', mint_status: 'eligible' });
    const tx = nextTx();
    chain.set(tx, ethSend(tx, STRANGER, H.address));
    await queueInbound(tx, H.wallet, 'human');
    await cycle();
    expect(sealed(receivePe(tx))).toMatchObject({ actionType: 'receive', mint_status: 'eligible' });
  });
});
