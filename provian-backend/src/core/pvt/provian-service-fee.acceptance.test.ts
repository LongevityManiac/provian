/**
 * ( follow-up) — A SERVICE FEE IS NEVER A PRICE FOR PVT.
 *
 * A transfer whose counterparty is one of Provian's own fee / gas / revenue wallets
 * (`provian-service-wallets.ts`) never mints for the PAYER, on any lane: it records, and seals
 * `record_only` with reason `provian_service_fee`. Driven through each lane's PRODUCTION
 * classification and emit — the outbound USDC watcher (`scanOutboundUsdc` +
 * `buildBaseOutboundDeps.emitActivityPE`), the x402 facilitator lane, the chain-record lane
 * (`runChainRecordWatcherCycle`, native wallets and proven addresses, people and agents, including
 * the hash the phone's batch queues) — into the REAL `generatePE` → REAL `recordPEAccrual` over a
 * fake Firestore. Only chain reads are injected.
 *
 * Every RED case sits beside a GREEN twin that differs in ONE variable (the counterparty is a
 * stranger instead of a Provian wallet) and mints — so a fence that sealed everything record_only
 * could not pass, and a fence that sealed nothing could not either.
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
import { generatePE } from '../agent-bank/pe-utils';
import { meterActRow } from './__test-helpers__/meter-acts';
import type { AgentBankDeps } from '../agent-bank/types';
import { BASE_USDC_ADDRESS, type BaseTransactionEvidence, type CanonicalEconomicLog } from '../onchain/economic-discovery';
import { baseEconomicEvidence } from './__test-helpers__/base-economic-evidence';
import { transactionEvidence, transferLog, TEST_BLOCK, topicOf } from './__test-helpers__/base-transaction-evidence';
import {
  buildBaseOutboundDeps,
  outboundUsdcPeId,
  scanOutboundUsdc,
  type OutboundActivityType,
  type OutboundTransferLog,
  type WatchedOutboundAddress,
} from './outbound-usdc-watcher';
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
import {
  NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION,
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  createNativeWalletRegistrationFence,
  nativeAgentRegistrationIndexId,
  nativeWalletAddressIndexId,
} from './native-wallet-registration';
import { HUMAN_PROVEN_ADDRESSES_COLLECTION, PROVEN_ADDRESSES_COLLECTION } from '../external-address/link';
import { HUMAN_PROVEN_ADDRESS_SCHEMA } from '../external-address/human-link';
import { LIVE_PVT9_TOKEN } from './wallet-exchange';
import { FEE_SETTLED_TOPIC, facilitatorActPeId, type FacilitatorSettlementClaim } from './x402-facilitator-settlement';
import { buildFacilitatorEmit, processFacilitatorSettlement, type FacilitatorLaneDeps } from './x402-facilitator-lane';
import { PAYOUT_FEE_RECIPIENT } from '../payout/payout-terms';
import { PROVIAN_SOLANA_TREASURY } from '../swap/swap-fees';
import {
  PROVIAN_SERVICE_FEE_REASON_CODE,
  PROVIAN_SERVICE_WALLETS_EVM,
  isProvianServiceWallet,
} from './provian-service-wallets';
import crypto from 'crypto';

const OWNER = 'human_owner_1';
const H = { wallet: 'hw1', user: OWNER, address: '0xcccc00000000000000000000000000000000000c' };
const A = { wallet: 'wA', agent: 'agentA', address: '0xaaaa00000000000000000000000000000000000a' };
/** The person's proven outside wallet. */
const P = '0xbeef00000000000000000000000000000000000b';
/** The agent's proven outside wallet. */
const Q = '0xdead00000000000000000000000000000000000d';
const STRANGER = '0x5000000000000000000000000000000000000005';
const SOLANA_STRANGER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const DAI = '0x50c5725949a6f0c72e6c4a641f24049a917db0cb';
const SETTLER = '0x5e77100000000000000000000000000000000b01';
/** The pinned service wallets, read from the module (never re-declared here). */
const [TREASURY, FACILITATOR_GAS, PAYOUT_GAS] = [...PROVIAN_SERVICE_WALLETS_EVM.keys()];
const DAY = PROVEN_ADDRESS_COMMERCE_CUT_LINE_MS + 8 * 3_600_000;
const PROOF_HEAD = TEST_BLOCK - 2_000;
const USDC_TRANSFER_WITH_AUTHORIZATION = '0xe3ee160e';

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
  // The agent is linked to SOMEONE ELSE: no same-owner relation to H, so nothing below is
  // record_only for that reason.
  mockDb.store.set(`agent_wallets/${A.wallet}`, {
    id: A.wallet, agent_id: A.agent, address: A.address, platform: 'claude', status: 'active',
    linked_human_user_id: 'someone_else',
    native_watcher_registration: createNativeWalletRegistrationFence(TEST_BLOCK - 1_000),
  });
  mockDb.store.set(`${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(A.address)}`, {
    schema_version: 'native-wallet-address-index/v1', chain_id: 8453, address: A.address,
    wallet_id: A.wallet, owner_type: 'agent', owner_id: A.agent, created_at_ms: 1,
  });
  mockDb.store.set(`${NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION}/${nativeAgentRegistrationIndexId(A.agent)}`, {
    wallet_id: A.wallet,
  });
  mockDb.store.set(`${HUMAN_PROVEN_ADDRESSES_COLLECTION}/${P}`, {
    schema_version: HUMAN_PROVEN_ADDRESS_SCHEMA, address: P, user_id: H.user, wallet_id: H.wallet, ...proofFields(),
  });
  mockDb.store.set(`${PROVEN_ADDRESSES_COLLECTION}/${Q}`, {
    schema_version: 'proven-address/v2', address: Q, agent_id: A.agent, wallet_id: A.wallet, ...proofFields(),
  });
  // The seller (H) has dealt with the buyer (A) before, so its receive is not unsolicited.
  mockDb.store.set('escrows/e_prior', { depositor_address: H.address, recipient_address: A.address });
}

let txSeq = 0xfee00;
function nextTx(): string {
  txSeq += 1;
  return `0x${txSeq.toString(16).padStart(64, '0')}`;
}
const chain = new Map<string, BaseTransactionEvidence>();

function sealed(peId: string): Record<string, unknown> {
  const row = meterActRow(mockDb.store, peId);
  if (!row) throw new Error(`no metered act for ${peId}`);
  return row;
}
function minted(peId: string): boolean {
  const row = sealed(peId);
  return row.mint_status === 'eligible' && (row.estimatedPVT as number) > 0;
}
function expectServiceFee(peId: string, actionType: string): void {
  expect(sealed(peId)).toMatchObject({
    actionType,
    mint_status: 'record_only',
    mint_disposition: 'record_only',
    disposition_reason_code: PROVIAN_SERVICE_FEE_REASON_CODE,
    estimatedPVT: 0,
  });
}

// ---------------------------------------------------------------------------------------------
// The outbound USDC watcher: the production classification AND the production emit.
// ---------------------------------------------------------------------------------------------

const watchedA: WatchedOutboundAddress = {
  address: A.address, walletId: A.wallet, agentId: A.agent, provenAtBlock: 500, source: 'native_agent',
};
const watchedH: WatchedOutboundAddress = {
  address: H.address, walletId: H.wallet, agentId: H.user, provenAtBlock: 500, source: 'native_human',
};

async function outboundScan(opts: {
  watched: WatchedOutboundAddress;
  txHash: string;
  logIndex: number;
  to: string;
  amountAtomic: string;
  submitter: string;
  txTo: string;
  selector: string | null;
}): Promise<{ labels: OutboundActivityType[]; errors: number; peId: string }> {
  const log: OutboundTransferLog = {
    txHash: opts.txHash, logIndex: opts.logIndex, blockNumber: 1500,
    fromAddress: opts.watched.address, toAddress: opts.to, amountAtomic: opts.amountAtomic,
  };
  const labels: OutboundActivityType[] = [];
  const productionEmit = buildBaseOutboundDeps(realDeps()).emitActivityPE;
  const report = await scanOutboundUsdc({
    db: mockDb as unknown as Firestore,
    chainId: 8453,
    chainName: 'base',
    getBlockNumber: async () => 1999,
    getLogs: async ({ fromBlock, toBlock }) => (log.blockNumber >= fromBlock && log.blockNumber <= toBlock ? [log] : []),
    isDexRouter: () => false,
    isStakingContract: () => false,
    listWatchedAddresses: async () => [opts.watched],
    facilitatorSettler: SETTLER,
    readTransactionEvidence: async (tx) => {
      const found = chain.get(tx);
      if (!found) throw new Error('economic_evidence_pending:transaction_unavailable');
      return found;
    },
    verifyActivityEvent: async (addr, event) => baseEconomicEvidence({
      transactionHash: event.txHash,
      logIndex: event.logIndex,
      blockNumber: event.blockNumber,
      fromAddress: addr.address,
      toAddress: event.toAddress,
      amountAtomic: event.amountAtomic,
      transactionSubmitter: opts.submitter,
      transactionTo: opts.txTo,
      transactionSelector: opts.selector,
      blockTimestampMs: DAY,
    }),
    emitActivityPE: async (addr, event, activityType, meta, keying) => {
      labels.push(activityType);
      return productionEmit(addr, event, activityType, meta, keying);
    },
    now: () => DAY + 3_600_000,
  }, { startBlock: 1000 });
  return { labels, errors: report.errors, peId: outboundUsdcPeId(8453, opts.txHash, opts.logIndex) };
}

// ---------------------------------------------------------------------------------------------
// The x402 facilitator lane.
// ---------------------------------------------------------------------------------------------

function feeSettled(tx: string, buyer: string, seller: string, value: bigint, fee: bigint, logIndex: number): CanonicalEconomicLog {
  return {
    ...transferLog(tx, SETTLER, buyer, seller, 0n, logIndex),
    topics: [FEE_SETTLED_TOPIC, topicOf(buyer), topicOf(seller), topicOf(BASE_USDC_ADDRESS)],
    data: `0x${value.toString(16).padStart(64, '0')}${fee.toString(16).padStart(64, '0')}`,
  };
}

/** buyer → seller 1 USDC (log 1), seller → `feeRecipient` 300 (log 2), FeeSettled (log 3). */
function settlementTx(tx: string, buyer: string, seller: string, feeRecipient: string): BaseTransactionEvidence {
  return transactionEvidence({
    transactionHash: tx, fromAddress: FACILITATOR_GAS, toAddress: SETTLER, blockTimestampMs: DAY,
    logs: [
      transferLog(tx, BASE_USDC_ADDRESS, buyer, seller, 1_000_000n, 1),
      transferLog(tx, BASE_USDC_ADDRESS, seller, feeRecipient, 300n, 2),
      feeSettled(tx, buyer, seller, 1_000_000n, 300n, 3),
    ],
  });
}

function laneDeps(): FacilitatorLaneDeps {
  return {
    db: mockDb as unknown as Firestore,
    env: { FACILITATOR_SETTLER_ADDRESS: SETTLER },
    verifyBaseTransaction: async (tx) => {
      const found = chain.get(tx);
      if (!found) throw new Error('economic_evidence_pending:transaction_unavailable');
      return found;
    },
    getSolanaTransaction: async () => null,
    emit: buildFacilitatorEmit(realDeps()),
    now: () => DAY + 3_600_000,
  };
}

function claimOf(tx: string, buyer: string, seller: string): FacilitatorSettlementClaim {
  return {
    chain: 'base', txHash: tx, buyer, seller, asset: BASE_USDC_ADDRESS, amount: '1000000', fee: '300', scheme: 'eip3009',
  };
}

// ---------------------------------------------------------------------------------------------
// The chain-record lane.
// ---------------------------------------------------------------------------------------------

const ethSend = (tx: string, from: string, to: string) => transactionEvidence({
  transactionHash: tx, fromAddress: from, toAddress: to, valueWei: '1000000000000', inputEmpty: true, blockTimestampMs: DAY,
});
const tokenTransfer = (tx: string, token: string, signer: string, from: string, to: string) => transactionEvidence({
  transactionHash: tx, fromAddress: signer, toAddress: token, blockTimestampMs: DAY,
  logs: [transferLog(tx, token, from, to, 10n ** 18n, 9)],
});

async function queueNative(tx: string, walletId: string, source: ChainRecordSource, ownerType?: 'human'): Promise<void> {
  const e = chainRecordEnqueue(mockDb as unknown as Firestore, {
    txHash: tx, walletId, source, ...(ownerType ? { ownerType } : {}),
  });
  await mockDb.runTransaction(async (txn) => { await e.read(txn as never); e.write(txn as never, `pe_record_${tx.slice(-6)}`); });
}
async function queueProven(tx: string, address: string, ownerType: 'human' | 'agent', source: ChainRecordSource): Promise<void> {
  await enqueueChainRecordObservation(mockDb as unknown as Firestore, {
    txHash: tx, walletId: provenObservationWalletId(address), source, ownerType,
  }, DAY);
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

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(DAY + 3_600_000);
  mockDb.store.clear();
  mockDb.ops.length = 0;
  chain.clear();
  seed();
});

afterEach(() => { jest.spyOn(Date, 'now').mockRestore(); });

describe('fixtures bind to the real wallets', () => {
  it('the three EVM service wallets are the treasury (= payout fee recipient), the facilitator gas EOA and the payout gas EOA', () => {
    expect([TREASURY, FACILITATOR_GAS, PAYOUT_GAS].every((a) => isProvianServiceWallet(a))).toBe(true);
    expect(TREASURY).toBe(PAYOUT_FEE_RECIPIENT);
    expect(isProvianServiceWallet(STRANGER)).toBe(false);
    expect(LIVE_PVT9_TOKEN).not.toBeNull();
  });
});

describe('the x402 facilitator fee leg (seller → facilitator gas EOA, inside the settler tx)', () => {
  it('RED: the outbound watcher labels it send and the seal records it at 0 — provian_service_fee', async () => {
    const tx = nextTx();
    chain.set(tx, settlementTx(tx, A.address, H.address, FACILITATOR_GAS));
    const { labels, errors, peId } = await outboundScan({
      watched: watchedH, txHash: tx, logIndex: 2, to: FACILITATOR_GAS, amountAtomic: '300',
      submitter: FACILITATOR_GAS, txTo: SETTLER, selector: '0x12345678',
    });
    expect(errors).toBe(0);
    expect(labels).toEqual(['send']);
    expectServiceFee(peId, 'send');
    expect(sealed(peId)).toMatchObject({ userId: OWNER });
  });

  it('GREEN twin: the identical leg to a non-Provian recipient mints a send', async () => {
    const tx = nextTx();
    chain.set(tx, settlementTx(tx, A.address, H.address, STRANGER));
    const { labels, peId } = await outboundScan({
      watched: watchedH, txHash: tx, logIndex: 2, to: STRANGER, amountAtomic: '300',
      submitter: FACILITATOR_GAS, txTo: SETTLER, selector: '0x12345678',
    });
    expect(labels).toEqual(['send']);
    expect(minted(peId)).toBe(true);
  });

  it('the settlement\'s OWN acts still mint once per actor while the fee leg in the same tx is record_only', async () => {
    const tx = nextTx();
    chain.set(tx, settlementTx(tx, A.address, H.address, FACILITATOR_GAS));
    const outcome = await processFacilitatorSettlement(laneDeps(), claimOf(tx, A.address, H.address));
    expect(outcome.status).toBe('recorded');
    const fee = await outboundScan({
      watched: watchedH, txHash: tx, logIndex: 2, to: FACILITATOR_GAS, amountAtomic: '300',
      submitter: FACILITATOR_GAS, txTo: SETTLER, selector: '0x12345678',
    });
    const buyer = facilitatorActPeId('base', tx, 'buyer');
    const seller = facilitatorActPeId('base', tx, 'seller');
    expect(sealed(buyer)).toMatchObject({ actionType: 'x402_payment', userId: A.agent, mint_status: 'eligible' });
    expect(sealed(seller)).toMatchObject({ actionType: 'receive', userId: OWNER, mint_status: 'eligible' });
    expect(minted(buyer)).toBe(true);
    expect(minted(seller)).toBe(true);
    expectServiceFee(fee.peId, 'send');
  });

  it('the buyer\'s payment leg seen by the outbound watcher is still the x402_payment it was, and mints', async () => {
    const tx = nextTx();
    chain.set(tx, settlementTx(tx, A.address, H.address, FACILITATOR_GAS));
    const { labels, peId } = await outboundScan({
      watched: watchedA, txHash: tx, logIndex: 1, to: H.address, amountAtomic: '1000000',
      submitter: FACILITATOR_GAS, txTo: SETTLER, selector: '0x12345678',
    });
    expect(labels).toEqual(['x402_payment']);
    expect(minted(peId)).toBe(true);
  });
});

describe('the on-demand payout\'s $1 charge (payer → treasury, transferWithAuthorization by the payout gas EOA)', () => {
  it.each<[string, WatchedOutboundAddress]>([
    ['an agent', watchedA],
    ['a person', watchedH],
  ])('RED: %s paying the fee — the watcher labels it x402_payment, the payer gets no mint', async (_who, watched) => {
    const tx = nextTx();
    const { labels, errors, peId } = await outboundScan({
      watched, txHash: tx, logIndex: 0, to: PAYOUT_FEE_RECIPIENT, amountAtomic: '1000000',
      submitter: PAYOUT_GAS, txTo: BASE_USDC_ADDRESS, selector: USDC_TRANSFER_WITH_AUTHORIZATION,
    });
    expect(errors).toBe(0);
    expect(labels).toEqual(['x402_payment']);
    expectServiceFee(peId, 'x402_payment');
    // No x402 reputation either: the fee is not a payment for anything the payer's record counts.
    expect((mockDb.store.get(`agent_wallets/${A.wallet}`) as { x402_payment_count?: unknown }).x402_payment_count)
      .toBeUndefined();
  });

  it('GREEN twin: the identical gasless authorization paid to a non-Provian seller mints', async () => {
    const tx = nextTx();
    const { labels, peId } = await outboundScan({
      watched: watchedA, txHash: tx, logIndex: 0, to: STRANGER, amountAtomic: '1000000',
      submitter: PAYOUT_GAS, txTo: BASE_USDC_ADDRESS, selector: USDC_TRANSFER_WITH_AUTHORIZATION,
    });
    expect(labels).toEqual(['x402_payment']);
    expect(minted(peId)).toBe(true);
  });

  it('a plain (self-submitted) USDC send of the fee to the treasury is a send, and is record_only too', async () => {
    const tx = nextTx();
    const { labels, peId } = await outboundScan({
      watched: watchedA, txHash: tx, logIndex: 0, to: TREASURY, amountAtomic: '1000000',
      submitter: A.address, txTo: BASE_USDC_ADDRESS, selector: '0xa9059cbb',
    });
    expect(labels).toEqual(['send']);
    expectServiceFee(peId, 'send');
  });
});

describe('the chain-record lane (ETH / PVT / DAI to a Provian wallet), every kind of payer', () => {
  it.each<[string, number]>([['treasury', 0], ['facilitator gas EOA', 1], ['payout gas EOA', 2]])(
    'RED: an AGENT native wallet sending ETH to the %s records at 0',
    async (_name, index) => {
      const recipient = [TREASURY, FACILITATOR_GAS, PAYOUT_GAS][index];
      const tx = nextTx();
      chain.set(tx, ethSend(tx, A.address, recipient));
      await queueNative(tx, A.wallet, 'transfer_record');
      await cycle();
      expectServiceFee(chainRecordPeId(tx), 'send');
    },
  );

  it('GREEN twin: the agent sending the same ETH to a stranger mints', async () => {
    const tx = nextTx();
    chain.set(tx, ethSend(tx, A.address, STRANGER));
    await queueNative(tx, A.wallet, 'transfer_record');
    await cycle();
    expect(minted(chainRecordPeId(tx))).toBe(true);
  });

  it('RED: a PERSON\'s app-recorded PVT send to the facilitator gas EOA (the phone batch\'s queued hash) records at 0', async () => {
    const tx = nextTx();
    chain.set(tx, tokenTransfer(tx, LIVE_PVT9_TOKEN as string, H.address, H.address, FACILITATOR_GAS));
    await queueNative(tx, H.wallet, 'app_send_record', 'human');
    await cycle();
    expectServiceFee(chainRecordPeId(`8453:${tx}:9`), 'send');
    expect(sealed(chainRecordPeId(`8453:${tx}:9`))).toMatchObject({ userId: OWNER });
  });

  it('GREEN twin: the person\'s same PVT send to a stranger mints', async () => {
    const tx = nextTx();
    chain.set(tx, tokenTransfer(tx, LIVE_PVT9_TOKEN as string, H.address, H.address, STRANGER));
    await queueNative(tx, H.wallet, 'app_send_record', 'human');
    await cycle();
    expect(minted(chainRecordPeId(`8453:${tx}:9`))).toBe(true);
  });

  it('RED: a person\'s PROVEN address sending ETH to the payout gas EOA records at 0', async () => {
    const tx = nextTx();
    chain.set(tx, ethSend(tx, P, PAYOUT_GAS));
    await queueProven(tx, P, 'human', 'proven_outbound_scan');
    await cycle();
    expectServiceFee(chainRecordPeId(tx), 'send');
  });

  it('GREEN twin: the same proven address sending ETH to a stranger mints', async () => {
    const tx = nextTx();
    chain.set(tx, ethSend(tx, P, STRANGER));
    await queueProven(tx, P, 'human', 'proven_outbound_scan');
    await cycle();
    expect(minted(chainRecordPeId(tx))).toBe(true);
  });

  it('RED: an agent\'s PROVEN address sending DAI to the treasury records at 0', async () => {
    const tx = nextTx();
    chain.set(tx, tokenTransfer(tx, DAI, Q, Q, TREASURY));
    await queueProven(tx, Q, 'agent', 'proven_outbound_scan');
    await cycle();
    expectServiceFee(chainRecordPeId(`8453:${tx}:9`), 'send');
  });

  it('GREEN twin: the agent\'s proven address sending the same DAI to a stranger mints', async () => {
    const tx = nextTx();
    chain.set(tx, tokenTransfer(tx, DAI, Q, Q, STRANGER));
    await queueProven(tx, Q, 'agent', 'proven_outbound_scan');
    await cycle();
    expect(minted(chainRecordPeId(`8453:${tx}:9`))).toBe(true);
  });
});

describe('a RECEIVE from a Provian wallet is not a fee — the rule binds the payer only', () => {
  it('Provian paying a person it has dealt with: the receive mints (never provian_service_fee)', async () => {
    mockDb.store.set('escrows/e_with_treasury', { depositor_address: H.address, recipient_address: TREASURY });
    const tx = nextTx();
    chain.set(tx, tokenTransfer(tx, DAI, TREASURY, TREASURY, H.address));
    await queueNative(tx, H.wallet, 'inbound_scan', 'human');
    await cycle();
    const peId = chainRecordPeId(`8453:${tx}:9`, 'receive');
    expect(sealed(peId).disposition_reason_code).not.toBe(PROVIAN_SERVICE_FEE_REASON_CODE);
    expect(minted(peId)).toBe(true);
  });

  it('…and the unchanged receive-authorship gate still holds a first receive from it at 0', async () => {
    const tx = nextTx();
    chain.set(tx, tokenTransfer(tx, DAI, TREASURY, TREASURY, H.address));
    await queueNative(tx, H.wallet, 'inbound_scan', 'human');
    await cycle();
    expect(sealed(chainRecordPeId(`8453:${tx}:9`, 'receive'))).toMatchObject({
      mint_disposition: 'record_only', disposition_reason_code: 'unsolicited_receive_record_only',
    });
  });
});

describe('Solana service wallets (base58, exact) — the predicate the Solana lanes and the PE Archive reuse', () => {
  async function relayAct(actionType: string, counterparty: string, tag: string): Promise<string> {
    const peId = `pe_solana_${tag}_${nextTx().slice(-6)}`;
    await generatePE(realDeps(), {
      walletId: A.wallet,
      agentId: A.agent,
      actorAddress: A.address,
      actionType,
      ownerType: 'agent',
      walletAddress: A.address,
      counterpartyAddress: counterparty,
      metadata: { tx_hash: `solana:${tag}`, verified: true, finality_confirmations: 32, chain: 'solana' },
      observedCanonicalEventId: `solana:${peId}`,
      peIdOverride: peId,
      timestampOverride: DAY,
      awaitAccrual: true,
    });
    return peId;
  }

  it('RED: a swap whose counterparty is the Solana treasury records at 0', async () => {
    expectServiceFee(await relayAct('swap', PROVIAN_SOLANA_TREASURY, 'fee'), 'swap');
  });

  it('GREEN twin: the same swap with a non-Provian Solana counterparty mints', async () => {
    expect(minted(await relayAct('swap', SOLANA_STRANGER, 'plain'))).toBe(true);
  });

  it('RED: a case-folded copy of the treasury is a DIFFERENT Solana key — not a service fee', async () => {
    const peId = await relayAct('swap', PROVIAN_SOLANA_TREASURY.toLowerCase(), 'folded');
    expect(sealed(peId).disposition_reason_code).not.toBe(PROVIAN_SERVICE_FEE_REASON_CODE);
  });
});
