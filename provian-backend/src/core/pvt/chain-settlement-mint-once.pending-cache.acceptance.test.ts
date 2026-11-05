/**
 * MINT-ONCE UNDER A REDIS OUTAGE for the two CHAIN-SETTLEMENT kinds — `x402`
 * (`x402_payment`, keyed (payer, settlement tx)) and `financial_settlement`
 * (the rest of the `base_chain_financial_settlement` family, keyed (settling
 * address, canonical log identity)). The exact hole d06cc643 closed for the
 * `completion` kind, closed here for the two kinds it reported still open:
 *
 * the seal guarded both claims with `!cacheUnavailable`, so a chain-verified
 * row sealed `pending_cache` during an outage carried NO claim; the hourly
 * backfill later flipped it to `eligible` without ever claiming the slot;
 * a second chain-verified source of the SAME settlement then claimed the
 * free slot and minted too — ONE act, TWO eligible rows.
 *
 * Driven through the REAL pipeline against a fake Firestore: the real
 * `recordPEAccrual` in the exact shape the outbound-USDC watcher fires
 * (`awaitAccrual: true` → `throwOnError`, the durable-effects outbox, no
 * ordinary intake) and, for the pre-fix belt-and-braces control, ALSO the
 * ordinary-intake shape; the real `backfillPendingCachePEs`; the real claim
 * modules. Nothing economic is re-implemented here.
 *
 * Every case is a NEGATIVE CONTROL : each was observed RED on d06cc643
 * before the fix, and the pre-fix reading is recorded inline at the assertion.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import type { BeneficiaryCacheEntry } from './beneficiary';

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
// eslint-disable-next-line import/first
import {
  ORDINARY_ACCRUAL_INTAKE_COLLECTION,
  ORDINARY_ACCRUAL_REPLAY_SOURCE,
  buildOrdinaryAccrualIntake,
} from './wp11/ordinary-accrual-intake';
// eslint-disable-next-line import/first
import { mintOnceClaimCollectionFor, type MintOnceClaimEvidence } from './mint-once-claim';
// eslint-disable-next-line import/first
import { x402ClaimDocId } from './x402-tx-mint-claim';
// eslint-disable-next-line import/first
import { backfillPendingCachePEs } from './pending-cache-backfill';
// eslint-disable-next-line import/first
import { cache as mockedCache } from '../../cache';
// eslint-disable-next-line import/first
import type { RedisCache } from '../../cache';
// eslint-disable-next-line import/first
import type { Firestore } from 'firebase-admin/firestore';
// eslint-disable-next-line import/first
import crypto from 'crypto';

const T0 = Date.UTC(2026, 8, 4, 12, 0);
const HOUR = 60 * 60 * 1000;
const AGENT = 'agent_settler';
const AGENT_WALLET = 'wallet_aw_settler';
const ADDR = `0x${'a1'.repeat(20)}`;
const CP = `0x${'c2'.repeat(20)}`;
const X402_TX = `0x${'f4'.repeat(32)}`;
const SEND_TX = `0x${'e5'.repeat(32)}`;
const SEND_EVENT = `8453:${SEND_TX}:3`;
const FIRST_PE = 'pe_first_witness';
const SECOND_PE = 'pe_second_witness';

type Kind = 'x402' | 'financial_settlement';
type Shape = 'watcher' | 'mainline';

interface PeRow {
  mint_status: string;
  mint_disposition: string;
  estimatedPVT: number;
  pending_cache_outcome?: string;
  mint_once_claim_evidence: MintOnceClaimEvidence[] | null;
  mint_once_claim_evidence_hash: string | null;
}

/** The chain-verified params the outbound-USDC watcher emits for ONE settlement. */
function settlementParams(kind: Kind, peId: string, shape: Shape): RecordPEAccrualParams {
  const base = {
    peId,
    userId: AGENT,
    integrationSource: 'agent_bank_generate_pe',
    attestationDepth: 'software',
    peHash: `h_${peId}`,
    timestamp: T0,
    counterpartyAddress: CP,
    walletAddress: ADDR,
    ownerType: 'agent',
    economicEvidenceState: 'verified',
    ...(shape === 'watcher'
      ? { throwOnError: true }
      : { durableReplaySource: ORDINARY_ACCRUAL_REPLAY_SOURCE }),
  };
  if (kind === 'x402') {
    return {
      ...base,
      actionType: 'x402_payment',
      x402PayerAddress: ADDR,
      x402SettlementTxHash: X402_TX,
      x402ChainVerified: true,
      economicCanonicalEventId: `8453:${X402_TX}:0`,
    } as RecordPEAccrualParams;
  }
  return {
    ...base,
    actionType: 'send',
    economicCanonicalEventId: SEND_EVENT,
  } as RecordPEAccrualParams;
}

function claimDocId(kind: Kind): string {
  if (kind === 'x402') return x402ClaimDocId(ADDR, X402_TX);
  // The financial-settlement claim id: sha256(lower(subject):lower(event)),
  // exactly as `mint-once-claim.ts::claimIdFor` derives a non-artifact kind.
  return crypto.createHash('sha256')
    .update(`${ADDR.toLowerCase()}:${SEND_EVENT.toLowerCase()}`)
    .digest('hex');
}
function claimPath(kind: Kind): string {
  return `${mintOnceClaimCollectionFor(kind)}/${claimDocId(kind)}`;
}
function claimOwner(kind: Kind): string | undefined {
  const claim = mockDb.store.get(claimPath(kind));
  return claim ? (claim.owner_pe_id as string) : undefined;
}
function row(peId: string): PeRow {
  const r = mockDb.store.get(`pe_history/${peId}`) as PeRow | undefined;
  if (!r) throw new Error(`no pe_history row for ${peId}`);
  return r;
}
function eligibleRows(): string[] {
  return [...mockDb.store.entries()]
    .filter(([k, v]) => k.startsWith('pe_history/') && (v as unknown as PeRow).mint_status === 'eligible')
    .map(([k]) => k.slice('pe_history/'.length))
    .sort();
}
async function seal(params: RecordPEAccrualParams): Promise<PeRow> {
  if (params.durableReplaySource !== undefined) {
    const doc = buildOrdinaryAccrualIntake({
      prevHash: `prev_${params.peId}`, peHash: params.peHash, accrualParams: params,
    });
    mockDb.store.set(`${ORDINARY_ACCRUAL_INTAKE_COLLECTION}/${params.peId}`, { ...doc });
  }
  await recordPEAccrual(params);
  return row(params.peId);
}
/** Redis is DOWN for the next accrual: the Strict counter read throws → cacheUnavailable. */
function redisDownForNextSeal(): void {
  (mockedCache.getUserDailyPECountStrict as jest.Mock<() => Promise<number>>)
    .mockRejectedValueOnce(new Error('redis_unavailable'));
}
/** The backfill's recovered cache: healthy, no limits, exactly-once per PE. */
function recoveredCache(): RedisCache {
  const claims = new Map<string, Record<string, number | boolean>>();
  return {
    isEnabled: () => true,
    getUserDailyPECountStrict: async () => 0,
    getUserActionTypeCountStrict: async () => 0,
    consumeRecoveredPECounterSlot: async (_userId: string, peId: string) => {
      const prior = claims.get(peId);
      if (prior) return { ...prior, idempotent: true };
      const slot = {
        hourlyCountBefore: 0, dailyCountBefore: 0, hourlyCountAfter: 1, dailyCountAfter: 1,
        occurrenceCountBefore: 0, occurrenceCountAfter: 1, idempotent: false,
      };
      claims.set(peId, slot);
      return slot;
    },
  } as unknown as RedisCache;
}
async function backfill(nowMs: number) {
  return backfillPendingCachePEs(recoveredCache(), mockDb as unknown as Firestore, { now: () => nowMs });
}
/**
 * The PRE-FIX row shape, constructed directly from a post-fix seal: the claim
 * doc removed and the row's own mint-once evidence stripped, exactly what a
 * row sealed under the `!cacheUnavailable` guard looked like (no claim, no
 * marker, `pending_cache`).
 */
async function stripToPreFixShape(kind: Kind, peId: string): Promise<void> {
  mockDb.store.delete(claimPath(kind));
  await mockDb.collection('pe_history').doc(peId)
    .update({ mint_once_claim_evidence: null, mint_once_claim_evidence_hash: null });
  expect(claimOwner(kind)).toBeUndefined();
  expect(row(peId).mint_once_claim_evidence).toBeNull();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.store.clear();
  mockDb.ops.length = 0;
  // The sovereign agent wallet whose address settles; the x402 derived effects
  // resolve the payer through it and refuse to guess.
  mockDb.store.set(`agent_wallets/${AGENT_WALLET}`, {
    id: AGENT_WALLET, agent_id: AGENT, address: ADDR.toLowerCase(), status: 'active', platform: 'live',
  });
});

describe.each<[Kind]>([['x402'], ['financial_settlement']])('mint-once kind %s under a Redis outage', (kind) => {
  it('reachability: with Redis healthy the chain-verified watcher row seals ELIGIBLE and owns its slot', async () => {
    const first = await seal(settlementParams(kind, FIRST_PE, 'watcher'));
    expect(first.mint_status).toBe('eligible');
    expect(first.estimatedPVT).toBeGreaterThan(0);
    expect(claimOwner(kind)).toBe(FIRST_PE);
    expect(first.mint_once_claim_evidence?.map((e) => [e.claim.claim_kind, e.relation]))
      .toEqual([[kind, 'owner']]);
  });

  it('RED (a): sealed UNDER the outage, the claim is owned AT SEAL TIME — the pending_cache row already holds its slot', async () => {
    redisDownForNextSeal();
    const first = await seal(settlementParams(kind, FIRST_PE, 'watcher'));
    expect(first.mint_status).toBe('pending_cache');
    expect(first.estimatedPVT).toBe(0);
    // Before the fix: `undefined` — the claim was guarded by `!cacheUnavailable`,
    // so the outage seal prepared nothing and the slot stayed FREE.
    expect(claimOwner(kind)).toBe(FIRST_PE);
    expect(first.mint_once_claim_evidence?.map((e) => [e.claim.claim_kind, e.relation]))
      .toEqual([[kind, 'owner']]);
  });

  it('RED (b): outage seal → backfill → a SECOND chain-verified source of the SAME settlement → exactly ONE eligible row, the second refused as corroborated_duplicate', async () => {
    redisDownForNextSeal();
    await seal(settlementParams(kind, FIRST_PE, 'watcher'));

    const result = await backfill(T0 + 10 * HOUR);
    expect(result.scanned).toBe(1);
    expect(result.reclassified_eligible).toBe(1);
    expect(eligibleRows()).toEqual([FIRST_PE]);

    // the negative control: a second chain-verified source of the same
    // settlement arrives after recovery. Before the fix the slot was free, so
    // this row CLAIMED it and sealed eligible beside the recovered one.
    const second = await seal(settlementParams(kind, SECOND_PE, 'watcher'));
    expect(second.mint_status).toBe('corroborated_duplicate');
    expect(second.estimatedPVT).toBe(0);
    expect(eligibleRows()).toEqual([FIRST_PE]);
    expect(claimOwner(kind)).toBe(FIRST_PE);
  });

  it('RED (b, both during the outage): the second source arriving WHILE Redis is down is a duplicate at seal; after recovery exactly ONE eligible row', async () => {
    redisDownForNextSeal();
    await seal(settlementParams(kind, FIRST_PE, 'watcher'));
    redisDownForNextSeal();
    const second = await seal(settlementParams(kind, SECOND_PE, 'watcher'));
    // Before the fix: BOTH sealed pending_cache with no claim; the backfill then
    // promoted both → two eligible rows for one settlement.
    expect(second.mint_status).toBe('corroborated_duplicate');
    expect(claimOwner(kind)).toBe(FIRST_PE);

    const result = await backfill(T0 + 10 * HOUR);
    expect(result.scanned).toBe(1);
    expect(result.reclassified_eligible).toBe(1);
    expect(eligibleRows()).toEqual([FIRST_PE]);
  });

  describe.each<[Shape]>([['watcher'], ['mainline']])('belt and braces on a PRE-FIX-shaped %s row', (shape) => {
    it('RED (c): pending_cache, no claim, slot taken by ANOTHER PE → the backfill REFUSES (corroborated_duplicate, 0), never eligible', async () => {
      redisDownForNextSeal();
      await seal(settlementParams(kind, FIRST_PE, shape));
      await stripToPreFixShape(kind, FIRST_PE);

      // A later chain-verified source of the same settlement legitimately
      // takes the free slot and mints once.
      const second = await seal(settlementParams(kind, SECOND_PE, 'watcher'));
      expect(second.mint_status).toBe('eligible');
      expect(claimOwner(kind)).toBe(SECOND_PE);

      const result = await backfill(T0 + 10 * HOUR);
      expect(result.scanned).toBe(1);
      // Before the fix: reclassified_eligible 1 → two eligible rows.
      expect(result.reclassified_eligible).toBe(0);
      expect(result.reclassified_ineligible).toBe(1);
      expect(row(FIRST_PE).mint_status).toBe('corroborated_duplicate');
      expect(row(FIRST_PE).mint_disposition).toBe('ineligible_terminal');
      expect(row(FIRST_PE).estimatedPVT).toBe(0);
      expect(row(FIRST_PE).pending_cache_outcome).toBe('mint_once_slot_owned_by_other_pe');
      expect(eligibleRows()).toEqual([SECOND_PE]);
      expect(claimOwner(kind)).toBe(SECOND_PE);
      // Idempotent: a second run finds nothing pending.
      expect((await backfill(T0 + 11 * HOUR)).scanned).toBe(0);
    });

    it('RED (d): pending_cache, no claim, slot UNCLAIMED → held for review (Unknown = Block), never promoted unattended', async () => {
      redisDownForNextSeal();
      await seal(settlementParams(kind, FIRST_PE, shape));
      await stripToPreFixShape(kind, FIRST_PE);

      const result = await backfill(T0 + 10 * HOUR);
      expect(result.scanned).toBe(1);
      // Before the fix: reclassified_eligible 1 — promoted with the slot still
      // free for any later source to claim and mint again.
      expect(result.reclassified_eligible).toBe(0);
      expect(result.reclassified_pending_review).toBe(1);
      expect(row(FIRST_PE).mint_status).toBe('pending_review');
      expect(row(FIRST_PE).estimatedPVT).toBe(0);
      expect(row(FIRST_PE).pending_cache_outcome).toBe('mint_once_slot_unclaimed_awaiting_review');
      expect(eligibleRows()).toEqual([]);
      expect(claimOwner(kind)).toBeUndefined();
    });
  });
});

describe('scope: a pending_cache row that carries no mint-once marker recovers as before', () => {
  it('a family row whose canonical event id is NOT tx-keyed prepares no claim by the seal\'s own rule, and still recovers eligible', async () => {
    // `base:8453:…` is the non-log-identity shape the durable-outbox parity
    // suite seals eligible with; `financialSettlementMintClaimKey` refuses it,
    // so the seal prepares no claim and the backfill must not hold it either.
    redisDownForNextSeal();
    const r = await seal({
      ...settlementParams('financial_settlement', 'pe_plain', 'watcher'),
      economicCanonicalEventId: 'base:8453:0xnotalogidentity:0',
    } as RecordPEAccrualParams);
    expect(r.mint_status).toBe('pending_cache');
    expect(r.mint_once_claim_evidence).toEqual([]);
    const result = await backfill(T0 + 10 * HOUR);
    expect(result.scanned).toBe(1);
    expect(result.reclassified_eligible).toBe(1);
    expect(eligibleRows()).toEqual(['pe_plain']);
    expect(claimOwner('financial_settlement')).toBeUndefined();
  });
});
