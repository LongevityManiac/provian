/**
 * HUMAN outbound send/swap: the MONEY-OUTCOME proof + the anti-self-farming
 * answer. Drives the REAL recordPEAccrual against a fake Firestore with the EXACT
 * params the watcher's emit hands generatePE for a human native address (proven in
 * the sibling `outbound-usdc-watcher.human.test.ts` ownerType:'human',
 * userId=user_id, actionType:'send'/'swap', counterpartyAddress, and the durable
 * `throwOnError` the watcher's awaitAccrual emit sets — pe-utils awaitAccrual →
 * throwOnError).
 *
 * The load-bearing claim: sending to yourself does NOT earn. The same-owner fence
 * (`detectSameOwnerTransfer`) resolves the counterparty from the SAME
 * `native_wallet_address_index_v1` that carries human wallet addresses, so a
 * human→own-wallet or human→self send/swap seals `record_only` (0 PVT), while a
 * send to a genuinely distinct counterparty mints. Mirrors the (B) harness of
 * mobile-chat-earning / device-witnessed-earning.
 */

import { describe, expect, it, jest } from '@jest/globals';
import type { BeneficiaryCacheEntry } from './beneficiary';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import { NATIVE_WALLET_ADDRESS_INDEX_COLLECTION, nativeWalletAddressIndexId } from './native-wallet-registration';

const HUMAN_USER = 'huser1';
const HUMAN_WALLET = 'hw1';
const HUMAN_ADDR = '0x1111111111111111111111111111111111111111';
const HUMAN_SECOND_WALLET = 'hw2';
const HUMAN_SECOND_ADDR = '0x2222222222222222222222222222222222222222';
const DISTINCT_COUNTERPARTY = '0x4444444444444444444444444444444444444444';

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
  cache: {
    getUserDailyPECountStrict: jest.fn(async () => 0),
    getUserActionTypeCountStrict: jest.fn(async () => 0),
    isArtifactHashSeen: async () => false,
    recordArtifactHash: async () => {},
    incrementUserActionTypeCount: jest.fn(async () => 1),
    incrementHourlyPECount: jest.fn(async () => {}),
    commitPEAccountingCountersOnce: jest.fn(async () => ({ idempotent: false })),
  },
  CacheUnavailableError: class CacheUnavailableError extends Error {},
}));
const mockResolveBeneficiary = jest.fn<(...a: unknown[]) => Promise<BeneficiaryCacheEntry>>(async () => ({
  linked: false, humanWalletId: null, humanUserId: null, humanAddress: null, agentShareBps: null,
}));
jest.mock('./beneficiary', () => ({ resolveBeneficiary: mockResolveBeneficiary }));
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

// eslint-disable-next-line import/first
import { recordPEAccrual, type RecordPEAccrualParams } from '../../pvt-accrual';

const TIMESTAMP = Date.UTC(2026, 7, 18, 12, 0);
let seq = 0;

interface PeRow {
  mint_status: string;
  mint_disposition: string;
  estimatedPVT: number;
  disposition_reason_code?: string;
}

/** Seed the human's OWN wallet address(es) into the native index the fence reads. */
function seedHumanOwnAddresses(): void {
  for (const [walletId, addr] of [
    [HUMAN_WALLET, HUMAN_ADDR],
    [HUMAN_SECOND_WALLET, HUMAN_SECOND_ADDR],
  ] as const) {
    mockDb.store.set(`${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(addr)}`, {
      schema_version: 'native-wallet-address-index/v1',
      chain_id: 8453, address: addr, wallet_id: walletId,
      owner_type: 'human', owner_id: HUMAN_USER, created_at_ms: 1,
    });
  }
}

/** The exact accrual params the watcher's emit produces for a human send/swap. */
function humanFinancialParams(over: Record<string, unknown> = {}): RecordPEAccrualParams {
  const peId = `pe_hout_${seq++}`;
  return {
    peId,
    userId: HUMAN_USER,               // generatePE maps agentId → userId; for a human that is the user_id
    actionType: 'send',
    integrationSource: 'outbound_usdc_watcher',
    attestationDepth: 'software',
    peHash: `h_${peId}`,
    timestamp: TIMESTAMP,
    isDevicePE: false,
    ownerType: 'human',
    walletAddress: HUMAN_ADDR,
    actorAddress: HUMAN_ADDR,
    counterpartyAddress: DISTINCT_COUNTERPARTY,
    // The watcher emits with awaitAccrual → throwOnError: the durable, chain-
    // verified seal. Without it the durability fence alone would force record_only
    // and the same-owner test below would pass vacuously — so this is REQUIRED for
    // the RED controls to be meaningful.
    throwOnError: true,
    // Chain-verified financial evidence (the watcher read the real Transfer log).
    economicEvidenceState: 'verified',
    tx_hash: `0x${'d'.repeat(64)}`,
    ...over,
  } as RecordPEAccrualParams;
}

function row(peId: string): PeRow {
  const r = mockDb.store.get(`pe_history/${peId}`) as PeRow | undefined;
  if (!r) throw new Error(`no pe_history row for ${peId}`);
  return r;
}
async function seal(params: RecordPEAccrualParams): Promise<PeRow> {
  await recordPEAccrual(params);
  return row(params.peId);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.store.clear();
  mockDb.ops.length = 0;
  seedHumanOwnAddresses();
});

describe('a human outbound send/swap MINTS to a distinct counterparty, ZERO to self', () => {
  it('send to a DISTINCT external counterparty → eligible, NON-ZERO', async () => {
    const sealed = await seal(humanFinancialParams({ counterpartyAddress: DISTINCT_COUNTERPARTY }));
    expect(sealed.mint_disposition).toBe('eligible');
    expect(sealed.mint_status).toBe('eligible');
    expect(sealed.estimatedPVT).toBeGreaterThan(0);
  });

  it('swap to a DISTINCT external counterparty → eligible, NON-ZERO', async () => {
    const sealed = await seal(humanFinancialParams({ actionType: 'swap', counterpartyAddress: DISTINCT_COUNTERPARTY }));
    expect(sealed.mint_disposition).toBe('eligible');
    expect(sealed.estimatedPVT).toBeGreaterThan(0);
  });

  it('RED (self-farming): send to the human OWN SECOND wallet (same user_id) → record_only, 0', async () => {
    const sealed = await seal(humanFinancialParams({ counterpartyAddress: HUMAN_SECOND_ADDR }));
    expect(sealed.mint_disposition).toBe('record_only');
    expect(sealed.estimatedPVT).toBe(0);
    expect(sealed.disposition_reason_code).toBe('self_or_shared_beneficial_ownership');
  });

  it('RED (self-farming): send BACK to the human OWN wallet (self-send) → record_only, 0', async () => {
    const sealed = await seal(humanFinancialParams({ counterpartyAddress: HUMAN_ADDR }));
    expect(sealed.mint_disposition).toBe('record_only');
    expect(sealed.estimatedPVT).toBe(0);
    expect(sealed.disposition_reason_code).toBe('self_or_shared_beneficial_ownership');
  });

  it('RED (control that the fence is real, not blanket): flipping ONLY the counterparty to a distinct address mints', async () => {
    // Identical params, one variable changed (counterparty own-wallet → distinct).
    // If the "record_only" above were blanket rather than same-owner-driven, this
    // would also be record_only. It is not.
    const own = await seal(humanFinancialParams({ counterpartyAddress: HUMAN_SECOND_ADDR }));
    const distinct = await seal(humanFinancialParams({ counterpartyAddress: DISTINCT_COUNTERPARTY }));
    expect(own.mint_disposition).toBe('record_only');
    expect(distinct.mint_disposition).toBe('eligible');
  });
});
