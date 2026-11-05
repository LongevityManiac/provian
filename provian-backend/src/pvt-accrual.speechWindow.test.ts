/**
 * the SPEECH-WINDOW BUDGET, driven through the LIVE accrual (`recordPEAccrual`), not the
 * pure module: what one window mints is STRICTLY LESS than the burn that opened it.
 *
 * A speech PE sealed under a live window (`params.speechWindow`) charges the window's ledger with
 * its record points in the same transaction; the PE that would carry the window's sum TO OR PAST
 * the burn seals `record_only` with `speech_window_budget_exhausted` recorded, points kept, never
 * minted. RED control: a zero burn exhausts on the first act; deleting the accrual's speech block
 * (or inverting `speechBudgetExhausted`) turns the exhausted row eligible and fails here.
 * (review defect 5: the wiring had no behavioral test.)
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

import type { FakeFirestore } from './core/pvt/__test-helpers__/fake-firestore';

// Realistic fake Firestore singleton shared by recordPEAccrual + writePEHistory
// + resumeDurableAccrualEffects, so the co-committed pvt_accrual_effects outbox
// is a real document the replay can consume.
let mockDb: FakeFirestore;
jest.mock('firebase-admin', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createFakeFirestore: mk } = require('./core/pvt/__test-helpers__/fake-firestore');
  const db = mk();
  mockDb = db;
  const firestore = Object.assign(() => db, {
    FieldValue: { increment: (n: number) => ({ __increment: n }) },
  });
  return { __esModule: true, default: { firestore }, firestore };
});

const incrementHourlyPECount = jest.fn<(...a: unknown[]) => Promise<void>>();
jest.mock('./cache', () => ({
  __esModule: true,
  cache: {
    getUserDailyPECountStrict: async () => 0,
    getUserActionTypeCountStrict: async () => 0,
    isArtifactHashSeen: async () => false,
    recordArtifactHash: async () => undefined,
    incrementHourlyPECount: (...a: unknown[]) => incrementHourlyPECount(...a),
    commitPEAccountingCountersOnce: async () => ({ idempotent: false }),
    isEnabled: () => true,
  },
  CacheUnavailableError: class CacheUnavailableError extends Error {},
}));

jest.mock('./core/pvt/beneficiary', () => ({
  __esModule: true,
  resolveBeneficiary: async () => ({
    linked: false,
    humanWalletId: null,
    humanUserId: null,
    humanAddress: null,
    agentShareBps: null,
  }),
}));

jest.mock('./core/jurisdiction/jurisdiction-policy', () => ({
  __esModule: true,
  getJurisdictionPolicy: async () => 'immediate',
}));

jest.mock('./core/pvt/delegation-pe', () => ({
  __esModule: true,
  isDelegationQualifying: () => false,
  createDelegationPE: async () => undefined,
}));

const recordActionTypeObservation = jest.fn<(...a: unknown[]) => Promise<void>>();
jest.mock('./core/provenance/pe-type-catalog', () => ({
  __esModule: true,
  recordActionTypeObservation: (...a: unknown[]) => recordActionTypeObservation(...a),
  getCategoryForActionType: async () => 'agent',
}));

jest.mock('./core/foundation-membership/client', () => ({
  __esModule: true,
  loadFoundationMembershipConfig: () => ({ enabled: false }),
  queueInitialMembershipGrants: async () => undefined,
}));


// The policy must be ARMED for a speech row to be eligible at all (the fake Firestore holds no
// activation document, which reads as inactive → everything record_only).
jest.mock('./core/pvt/policy/runtime-monetary-policy', () => {
  const actual = jest.requireActual('./core/pvt/policy/runtime-monetary-policy') as Record<string, unknown>;
  return { ...actual, loadRuntimeMonetaryPolicy: async () => (actual.materializeProposedMonetaryPolicy as (n: number) => unknown)(0) };
});

import { recordPEAccrual } from './pvt-accrual';
import { ORDINARY_ACCRUAL_REPLAY_SOURCE } from './core/pvt/wp11/ordinary-accrual-intake';
import { SPEECH_WINDOW_BUDGETS_COLLECTION, SPEECH_WINDOW_RESERVATIONS_COLLECTION } from './core/pvt/speech-window-budget';

const USER = 'wallet_aw_speech';
const WALLET_KEY = `wallets/wallet_${USER}`;
const BURN = 'a'.repeat(64);
const ONE = 10n ** 18n;

type Row = Record<string, unknown>;
const peHistory = (peId: string): Row | undefined => mockDb.store.get(`pe_history/${peId}`);
const ledger = (): Row | undefined => mockDb.store.get(`${SPEECH_WINDOW_BUDGETS_COLLECTION}/${BURN}`);

function seedWallet(): void {
  mockDb.store.set(WALLET_KEY, { user_id: USER, agent_id: USER, address: '0x00000000000000000000000000000000000000ab', owner_type: 'agent' });
  // The durable lane's streak/aggregate refs resolve the AGENT wallet document by id.
  mockDb.store.set(`agent_wallets/${USER}`, { id: USER, agent_id: USER, address: '0x00000000000000000000000000000000000000ab', status: 'active', owner_type: 'agent' });
}

function speech(peId: string, burnAmountAtomic: bigint, over: Record<string, unknown> = {}) {
  return {
    peId,
    userId: USER,
    actionType: 'commons_post_created',
    integrationSource: 'agent_bank_generate_pe',
    attestationDepth: 'software',
    peHash: `hash_${peId}`,
    timestamp: Date.UTC(2026, 8, 22, 12, 0),
    jurisdiction_context: 'US',
    durableReplaySource: ORDINARY_ACCRUAL_REPLAY_SOURCE,
    witnessClass: 'relay_verified',
    economicEvidenceState: 'verified',
    ownerType: 'agent',
    walletAddress: '0x00000000000000000000000000000000000000ab',
    speechWindow: { burnId: BURN, burnAmountAtomic: burnAmountAtomic.toString() },
    throwOnError: true,
    ...over,
  } as unknown as Parameters<typeof recordPEAccrual>[0];
}

beforeEach(() => {
  jest.clearAllMocks();
  recordActionTypeObservation.mockResolvedValue(undefined);
  incrementHourlyPECount.mockResolvedValue(undefined);
  mockDb.store.clear();
  mockDb.ops.length = 0;
  seedWallet();
});

describe(' speech-window budget through the live accrual', () => {
  it('a speech act under a live window seals ELIGIBLE and charges the window ledger with its points', async () => {
    await recordPEAccrual(speech('pe_speech_1', 2n * ONE));
    const hist = peHistory('pe_speech_1') as Row;
    expect(hist.mint_disposition).toBe('eligible');
    const points = BigInt(String((hist.economic_snapshot as { recordPointsAtomic: string }).recordPointsAtomic));
    expect(points).toBeGreaterThan(0n);
    const led = ledger() as Row;
    expect(BigInt(String(led.consumed_atomic))).toBe(points);
    expect(mockDb.store.get(`${SPEECH_WINDOW_RESERVATIONS_COLLECTION}/pe_speech_1`)).toBeDefined();
  });

  it('INVARIANT: Σ minted speech in one window < the burn; the act that would reach it seals record_only (speech_window_budget_exhausted) with its points kept', async () => {
    const burn = 2n * ONE;
    let minted = 0n;
    let exhaustedAt: string | null = null;
    for (let i = 1; i <= 8; i += 1) {
      const peId = `pe_speech_loop_${i}`;
      await recordPEAccrual(speech(peId, burn));
      const hist = peHistory(peId) as Row;
      const snap = hist.economic_snapshot as { recordPointsAtomic: string; mintDisposition: string };
      if (hist.mint_disposition === 'eligible') {
        minted += BigInt(snap.recordPointsAtomic);
      } else {
        expect(hist.mint_disposition).toBe('record_only');
        expect(hist.disposition_reason_code).toBe('speech_window_budget_exhausted');
        expect(BigInt(snap.recordPointsAtomic)).toBeGreaterThan(0n); // recorded, never suppressed
        exhaustedAt = peId;
        break;
      }
    }
    expect(exhaustedAt).not.toBeNull();
    expect(minted).toBeGreaterThan(0n);
    expect(minted).toBeLessThan(burn);
    expect(BigInt(String((ledger() as Row).consumed_atomic))).toBe(minted);
  });

  it('RED control: a ZERO burn exhausts on the very first act (nothing mints under a window that bought nothing)', async () => {
    await recordPEAccrual(speech('pe_speech_zero', 0n));
    const hist = peHistory('pe_speech_zero') as Row;
    expect(hist.mint_disposition).toBe('record_only');
    expect(hist.disposition_reason_code).toBe('speech_window_budget_exhausted');
  });

  it('NO PASS, NO MINT (2026-09-23): the SAME speech act with NO pass seals record_only under its own reason (speech_no_live_pass_record_only), points kept, ledger untouched', async () => {
    await recordPEAccrual(speech('pe_speech_nopass', 0n, { speechWindow: null }));
    const hist = peHistory('pe_speech_nopass') as Row;
    expect(hist.mint_disposition).toBe('record_only');
    expect(hist.disposition_reason_code).toBe('speech_no_live_pass_record_only');
    const snap = hist.economic_snapshot as { recordPointsAtomic: string };
    expect(BigInt(snap.recordPointsAtomic)).toBeGreaterThan(0n); // recorded, never suppressed
    expect(ledger()).toBeUndefined();
    expect(mockDb.store.get(`${SPEECH_WINDOW_RESERVATIONS_COLLECTION}/pe_speech_nopass`)).toBeUndefined();
  });

  it('every speech row is covered: each of the ten speech types with no pass seals speech_no_live_pass_record_only (population printed, never empty)', async () => {
    const { COMMONS_SPEECH_ACTION_TYPES } = await import('./core/pvt/policy/proposed-action-policy');
    expect(COMMONS_SPEECH_ACTION_TYPES.length).toBe(10);
    for (const actionType of COMMONS_SPEECH_ACTION_TYPES) {
      const peId = `pe_nopass_${actionType}`;
      await recordPEAccrual(speech(peId, 0n, { speechWindow: null, actionType }));
      const hist = peHistory(peId) as Row;
      expect([actionType, hist.mint_disposition]).toEqual([actionType, 'record_only']);
      expect([actionType, hist.disposition_reason_code]).toEqual([actionType, 'speech_no_live_pass_record_only']);
    }
  });

  it('RED control: a NON-speech row with no pass is untouched by the rule (the seal above is the rule, not the lane)', async () => {
    await recordPEAccrual(speech('pe_nonspeech_nopass', 0n, { speechWindow: null, actionType: 'agent_action' }));
    const hist = peHistory('pe_nonspeech_nopass') as Row;
    expect(hist.disposition_reason_code).not.toBe('speech_no_live_pass_record_only');
    // agent_action here awaits its canonical event (pending_evidence) — still on the mint path,
    // never sealed record_only by the speech rule.
    expect(hist.mint_disposition).not.toBe('record_only');
  });

  it('QUOTE == SEAL for speech: the estimator with a pass quotes what a pass seals, and without one quotes what no pass seals — disposition, reason, and points', async () => {
    const { estimateFromRecordPath } = await import('./core/pvt/policy/record-path-estimate');
    const { COMMONS_SPEECH_ACTION_TYPES } = await import('./core/pvt/policy/proposed-action-policy');
    let evaluated = 0;
    for (const actionType of COMMONS_SPEECH_ACTION_TYPES) {
      for (const pass of [true, false]) {
        mockDb.store.clear();
        seedWallet();
        const peId = `pe_parity_${actionType}_${pass}`;
        const at = Date.UTC(2026, 8, 22, 12, 0);
        await recordPEAccrual(speech(peId, 1000n * ONE, { actionType, timestamp: at, ...(pass ? {} : { speechWindow: null }) }));
        const hist = peHistory(peId) as Row;
        const snap = hist.economic_snapshot as { recordPointsAtomic: string };
        const quote = await estimateFromRecordPath(mockDb as unknown as Parameters<typeof estimateFromRecordPath>[0], {
          actionType,
          attestationTier: 'software',
          witnessClass: 'relay_verified',
          evidenceState: 'verified',
          linkageState: 'unlinked',
          durableSubmissionPath: true,
          occurrenceOrdinal: 1,
          dailyOrdinal: 1,
          speechPassLive: pass,
          recordedAtMs: at,
        });
        expect([actionType, pass, quote.mint_disposition]).toEqual([actionType, pass, hist.mint_disposition]);
        expect([actionType, pass, quote.mint_reason_code]).toEqual([actionType, pass, hist.disposition_reason_code]);
        expect([actionType, pass, quote.record_points_atomic]).toEqual([actionType, pass, snap.recordPointsAtomic]);
        evaluated += 1;
      }
    }
    expect(evaluated).toBe(20);
  });
});
