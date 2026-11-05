/**
 * — the MONEY OUTCOME of the facilitator lane, driven through its PRODUCTION emit
 * (`buildFacilitatorEmit`) and the chain watchers' production emits (`buildBaseOutboundDeps
 *.emitActivityPE`, `buildBaseInboundDeps.emitFundingPE`, `buildChainRecordWatcherDeps
 *.emitActPE`) into the REAL `generatePE` and the REAL `recordPEAccrual` over a fake Firestore.
 * Only the chain read is injected. Nothing economic is re-implemented here.
 *
 * the invariant: one transaction mints once per actor however many lanes see it. Proven in both
 * orders for both parties, with the RED control that makes the proof non-vacuous: the SAME two
 * lanes keyed on DIVERGENT anchors (the pre-B1 `send` label on the buyer's leg; another log for the
 * seller) both mint.
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
import { actRecorded, meterActRow } from './__test-helpers__/meter-acts';
import type { AgentBankDeps } from '../agent-bank/types';
import { BASE_USDC_ADDRESS, type BaseTransactionEvidence, type CanonicalEconomicLog } from '../onchain/economic-discovery';
import { transactionEvidence, transferLog, TEST_BLOCK, topicOf } from './__test-helpers__/base-transaction-evidence';
import { buildBaseInboundDeps, inboundUsdcPeId } from './inbound-usdc-watcher';
import { buildBaseOutboundDeps, outboundUsdcPeId } from './outbound-usdc-watcher';
import { buildChainRecordWatcherDeps, chainRecordPeId, deriveChainRecordAct } from './chain-record-watcher';
import {
  NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION,
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  createNativeWalletRegistrationFence,
  nativeAgentRegistrationIndexId,
  nativeWalletAddressIndexId,
} from './native-wallet-registration';
import { FEE_SETTLED_TOPIC, facilitatorActPeId, type FacilitatorSettlementClaim } from './x402-facilitator-settlement';
import {
  FACILITATOR_SETTLEMENTS_COLLECTION,
  buildFacilitatorEmit,
  processFacilitatorSettlement,
  submitFacilitatorSettlement,
  type FacilitatorLaneDeps,
} from './x402-facilitator-lane';

const OWNER = 'human_owner_1';
const H = { wallet: 'hw1', user: OWNER, address: '0xcccc00000000000000000000000000000000000c' };
const A = { wallet: 'wA', agent: 'agentA', address: '0xaaaa00000000000000000000000000000000000a' };
const STRANGER = '0x5000000000000000000000000000000000000005';
const SETTLER = '0x5e77100000000000000000000000000000000b01';
const FEE = '0xa37fc594e98e951571c771c9e77cdc73f67d3efb';
const PVT = '0x8811441914381143b9408c5c32247367f86f173a';
const DAY = Date.UTC(2026, 9, 4, 12, 0, 0);

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

/** The seller (H) has dealt with the buyer (A) before, so its receive is not unsolicited. */
function sellerHasDealtWithBuyer(): void {
  mockDb.store.set('escrows/e_prior', { depositor_address: H.address, recipient_address: A.address });
}

let txSeq = 0xb100;
function nextTx(): string {
  txSeq += 1;
  return `0x${txSeq.toString(16).padStart(64, '0')}`;
}

function feeSettled(tx: string, buyer: string, seller: string, token: string, value: bigint, fee: bigint, logIndex: number): CanonicalEconomicLog {
  return {
    ...transferLog(tx, SETTLER, buyer, seller, 0n, logIndex),
    topics: [FEE_SETTLED_TOPIC, topicOf(buyer), topicOf(seller), topicOf(token)],
    data: `0x${value.toString(16).padStart(64, '0')}${fee.toString(16).padStart(64, '0')}`,
  };
}

/** A facilitator settlement: buyer → seller `amount` of `asset` (log 1), seller → FEE 300 USDC (log 2), FeeSettled (log 3). */
function settlementTx(tx: string, buyer: string, seller: string, asset = BASE_USDC_ADDRESS, amount = 1_000_000n): BaseTransactionEvidence {
  return transactionEvidence({
    transactionHash: tx, fromAddress: FEE, toAddress: SETTLER, blockTimestampMs: DAY,
    logs: [
      transferLog(tx, asset, buyer, seller, amount, 1),
      transferLog(tx, BASE_USDC_ADDRESS, seller, FEE, 300n, 2),
      feeSettled(tx, buyer, seller, asset, amount, 300n, 3),
    ],
  });
}

const chain = new Map<string, BaseTransactionEvidence>();

function claimOf(tx: string, buyer: string, seller: string, asset = BASE_USDC_ADDRESS, amount = '1000000'): FacilitatorSettlementClaim {
  return {
    chain: 'base', txHash: tx, buyer, seller, asset, amount, fee: '300',
    scheme: asset === BASE_USDC_ADDRESS ? 'eip3009' : 'permit2',
  };
}

function laneDeps(over: Partial<FacilitatorLaneDeps> = {}): FacilitatorLaneDeps {
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
    ...over,
  };
}

/** The outbound USDC watcher's production emit of the buyer's leg (log 1). */
async function watcherBuyer(tx: string, label: 'x402_payment' | 'send'): Promise<string> {
  await buildBaseOutboundDeps(realDeps()).emitActivityPE(
    { address: A.address, walletId: A.wallet, agentId: A.agent, provenAtBlock: 0, source: 'native_agent' },
    { txHash: tx, logIndex: 1, blockNumber: TEST_BLOCK, toAddress: H.address, amountUsd: 1, amountAtomic: '1000000', observedAtMs: DAY },
    label,
    { verified: true, finality_confirmations: 12, tx_hash: tx, log_index: 1, asset: 'USDC' },
  );
  return outboundUsdcPeId(8453, tx, 1);
}

/** The inbound USDC watcher's production emit of the seller's receive of log `logIndex`. */
async function watcherSeller(tx: string, logIndex = 1): Promise<string> {
  await buildBaseInboundDeps(realDeps()).emitFundingPE(
    { walletId: H.wallet, agentId: H.user, address: H.address, createdAtMs: 1, eligibilityStartBlock: 0, ownerType: 'human' },
    { txHash: tx, logIndex, blockNumber: TEST_BLOCK, fromAddress: A.address, amountUsd: 1, amountAtomic: '1000000', observedAtMs: DAY },
    { verified: true, finality_confirmations: 12, tx_hash: tx, log_index: logIndex, asset: 'USDC' },
  );
  return inboundUsdcPeId(8453, tx, logIndex);
}

function sealed(peId: string): Record<string, unknown> {
  const row = meterActRow(mockDb.store, peId);
  if (!row) throw new Error(`no metered act for ${peId}`);
  return row;
}

function minted(peId: string): boolean {
  const row = sealed(peId);
  return row.mint_status === 'eligible' && (row.estimatedPVT as number) > 0;
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(DAY + 3_600_000);
  mockDb.store.clear();
  mockDb.ops.length = 0;
  chain.clear();
  seedHuman();
  seedAgent('someone_else'); // a different owner: the buyer and seller are not the same owner
  sellerHasDealtWithBuyer();
});

afterEach(() => { jest.spyOn(Date, 'now').mockRestore(); });

describe('B1 — a facilitator settlement is a witnessed PE for buyer and seller', () => {
  it('GREEN: the buyer\'s x402_payment and the seller\'s receive both seal and mint', async () => {
    const tx = nextTx();
    chain.set(tx, settlementTx(tx, A.address, H.address));
    const outcome = await processFacilitatorSettlement(laneDeps(), claimOf(tx, A.address, H.address));
    expect(outcome.status).toBe('recorded');
    const buyer = sealed(facilitatorActPeId('base', tx, 'buyer'));
    const seller = sealed(facilitatorActPeId('base', tx, 'seller'));
    expect(buyer).toMatchObject({ actionType: 'x402_payment', userId: A.agent, mint_status: 'eligible' });
    expect(seller).toMatchObject({ actionType: 'receive', userId: OWNER, mint_status: 'eligible' });
    expect(buyer.estimatedPVT as number).toBeGreaterThan(0);
    expect(seller.estimatedPVT as number).toBeGreaterThan(0);
  });

  it('a party that is not a Provian identity gets no act; the other party still does', async () => {
    const tx = nextTx();
    chain.set(tx, settlementTx(tx, A.address, STRANGER));
    const outcome = await processFacilitatorSettlement(laneDeps(), claimOf(tx, A.address, STRANGER));
    expect(outcome).toMatchObject({
      status: 'recorded',
      acts: [
        { role: 'buyer', recorded: true, action_type: 'x402_payment' },
        { role: 'seller', recorded: false, reason: 'not_a_provian_identity', pe_id: null },
      ],
    });
    expect(actRecorded(mockDb.store, facilitatorActPeId('base', tx, 'seller'))).toBe(false);
    expect(minted(facilitatorActPeId('base', tx, 'buyer'))).toBe(true);
  });

  it('RED (same-owner fence): a person paying their OWN linked agent records both sides at 0', async () => {
    seedAgent(OWNER); // the agent is linked to H: one beneficial owner
    const tx = nextTx();
    chain.set(tx, settlementTx(tx, H.address, A.address));
    await processFacilitatorSettlement(laneDeps(), claimOf(tx, H.address, A.address));
    expect(sealed(facilitatorActPeId('base', tx, 'buyer'))).toMatchObject({
      actionType: 'x402_payment', mint_disposition: 'record_only',
      disposition_reason_code: 'self_or_shared_beneficial_ownership', estimatedPVT: 0,
    });
    expect(sealed(facilitatorActPeId('base', tx, 'seller'))).toMatchObject({
      actionType: 'receive', mint_disposition: 'record_only', estimatedPVT: 0,
    });
  });

  it('control (fence not blanket): link the agent to someone else and the SAME payment mints', async () => {
    seedAgent('someone_else');
    const tx = nextTx();
    chain.set(tx, settlementTx(tx, H.address, A.address));
    await processFacilitatorSettlement(laneDeps(), claimOf(tx, H.address, A.address));
    expect(minted(facilitatorActPeId('base', tx, 'buyer'))).toBe(true);
  });

  it('idempotent: the same settlement reported twice seals the same PEs and mints once', async () => {
    const tx = nextTx();
    chain.set(tx, settlementTx(tx, A.address, H.address));
    const first = await submitFacilitatorSettlement(laneDeps(), claimOf(tx, A.address, H.address));
    const second = await submitFacilitatorSettlement(laneDeps(), claimOf(tx, A.address, H.address));
    // A third run straight through the lane (skipping the stored pointer) replays deterministically.
    const third = await processFacilitatorSettlement(laneDeps(), claimOf(tx, A.address, H.address));
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    const eligible = [...mockDb.store.keys()]
      .filter((k) => k.startsWith('meter_act_keys_v1/'))
      .map((k) => (mockDb.store.get(k) as { row: Record<string, unknown> }).row)
      .filter((r) => r.mint_status === 'eligible');
    expect(eligible).toHaveLength(2);
    expect(mockDb.store.get(`${FACILITATOR_SETTLEMENTS_COLLECTION}/base:${tx}`)).toMatchObject({ status: 'recorded' });
  });

  it('a PVT payment (Permit2): the buyer\'s x402_payment and the seller\'s PVT receive seal', async () => {
    const tx = nextTx();
    chain.set(tx, settlementTx(tx, A.address, H.address, PVT, 10n ** 18n));
    await processFacilitatorSettlement(laneDeps(), claimOf(tx, A.address, H.address, PVT, (10n ** 18n).toString()));
    expect(minted(facilitatorActPeId('base', tx, 'buyer'))).toBe(true);
    const seller = sealed(facilitatorActPeId('base', tx, 'seller'));
    expect(seller).toMatchObject({ actionType: 'receive', mint_status: 'eligible' });
  });
});

describe('B1 — mint-once: one transaction mints once per actor, whichever lane sees it first', () => {
  it('BUYER, watcher first: the outbound watcher\'s x402_payment mints; the facilitator lane\'s earns nothing', async () => {
    const tx = nextTx();
    chain.set(tx, settlementTx(tx, A.address, H.address));
    const watcherPe = await watcherBuyer(tx, 'x402_payment');
    await processFacilitatorSettlement(laneDeps(), claimOf(tx, A.address, H.address));
    expect(minted(watcherPe)).toBe(true);
    expect(sealed(facilitatorActPeId('base', tx, 'buyer'))).toMatchObject({ actionType: 'x402_payment', estimatedPVT: 0 });
    expect(minted(facilitatorActPeId('base', tx, 'buyer'))).toBe(false);
  });

  it('BUYER, facilitator first: the facilitator lane mints; the outbound watcher\'s x402_payment earns nothing', async () => {
    const tx = nextTx();
    chain.set(tx, settlementTx(tx, A.address, H.address));
    await processFacilitatorSettlement(laneDeps(), claimOf(tx, A.address, H.address));
    const watcherPe = await watcherBuyer(tx, 'x402_payment');
    expect(minted(facilitatorActPeId('base', tx, 'buyer'))).toBe(true);
    expect(sealed(watcherPe)).toMatchObject({ actionType: 'x402_payment', estimatedPVT: 0 });
  });

  it('RED (anchors diverged): the pre-B1 `send` label on the same leg mints AGAIN beside the facilitator\'s x402_payment', async () => {
    const tx = nextTx();
    chain.set(tx, settlementTx(tx, A.address, H.address));
    await processFacilitatorSettlement(laneDeps(), claimOf(tx, A.address, H.address));
    const watcherPe = await watcherBuyer(tx, 'send');
    // Two different claims (x402 vs financial-settlement) → two mints for ONE payment. This is why
    // the outbound watcher now labels the settler's payment leg x402_payment.
    expect(minted(facilitatorActPeId('base', tx, 'buyer'))).toBe(true);
    expect(minted(watcherPe)).toBe(true);
  });

  it('SELLER, watcher first: the inbound USDC watcher\'s receive mints; the facilitator lane\'s earns nothing', async () => {
    const tx = nextTx();
    chain.set(tx, settlementTx(tx, A.address, H.address));
    const watcherPe = await watcherSeller(tx);
    await processFacilitatorSettlement(laneDeps(), claimOf(tx, A.address, H.address));
    expect(minted(watcherPe)).toBe(true);
    expect(sealed(facilitatorActPeId('base', tx, 'seller'))).toMatchObject({ actionType: 'receive', estimatedPVT: 0 });
  });

  it('SELLER, facilitator first: the facilitator lane mints; the inbound watcher\'s receive earns nothing', async () => {
    const tx = nextTx();
    chain.set(tx, settlementTx(tx, A.address, H.address));
    await processFacilitatorSettlement(laneDeps(), claimOf(tx, A.address, H.address));
    const watcherPe = await watcherSeller(tx);
    expect(minted(facilitatorActPeId('base', tx, 'seller'))).toBe(true);
    expect(sealed(watcherPe)).toMatchObject({ actionType: 'receive', estimatedPVT: 0 });
  });

  it('RED (anchors diverged): a receive keyed on ANOTHER log of the tx mints beside the facilitator\'s', async () => {
    const tx = nextTx();
    chain.set(tx, settlementTx(tx, A.address, H.address));
    await processFacilitatorSettlement(laneDeps(), claimOf(tx, A.address, H.address));
    const otherLog = await watcherSeller(tx, 7);
    expect(minted(facilitatorActPeId('base', tx, 'seller'))).toBe(true);
    expect(minted(otherLog)).toBe(true);
  });

  it('SELLER of a PVT payment: the chain-record lane and the facilitator lane share the one claim, in both orders', async () => {
    const lane = buildChainRecordWatcherDeps(realDeps());
    const wallet = {
      walletId: H.wallet, agentId: H.user, address: H.address, eligibilityStartBlock: 0, ownerType: 'human' as const,
    };
    // Facilitator first, then the chain-record lane's emit of the same receive.
    const tx1 = nextTx();
    chain.set(tx1, settlementTx(tx1, A.address, H.address, PVT, 10n ** 18n));
    await processFacilitatorSettlement(laneDeps(), claimOf(tx1, A.address, H.address, PVT, (10n ** 18n).toString()));
    const d1 = deriveChainRecordAct(chain.get(tx1)!, H.address);
    if (d1.status !== 'act') throw new Error('expected a receive');
    expect(d1.act.actionType).toBe('receive');
    await lane.emitActPE(wallet, d1.act, chain.get(tx1)!, { recordPeId: null, source: 'inbound_scan' });
    expect(minted(facilitatorActPeId('base', tx1, 'seller'))).toBe(true);
    expect(sealed(chainRecordPeId(d1.act.canonicalEventId, 'receive'))).toMatchObject({ estimatedPVT: 0 });

    // The chain-record lane first, then the facilitator.
    const tx2 = nextTx();
    chain.set(tx2, settlementTx(tx2, A.address, H.address, PVT, 10n ** 18n));
    const d2 = deriveChainRecordAct(chain.get(tx2)!, H.address);
    if (d2.status !== 'act') throw new Error('expected a receive');
    await lane.emitActPE(wallet, d2.act, chain.get(tx2)!, { recordPeId: null, source: 'inbound_scan' });
    await processFacilitatorSettlement(laneDeps(), claimOf(tx2, A.address, H.address, PVT, (10n ** 18n).toString()));
    expect(minted(chainRecordPeId(d2.act.canonicalEventId, 'receive'))).toBe(true);
    expect(sealed(facilitatorActPeId('base', tx2, 'seller'))).toMatchObject({ estimatedPVT: 0 });
  });
});
