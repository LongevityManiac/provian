/**
 * Court — Arbitrator Eligibility Unit Tests (gate, supersedes)
 *
 * The opt-in gate requires ALL THREE:
 * 1. >= COURT_MIN_COMPLETED_ESCROWS completed escrows AS A PARTY, each with a
 * real counterparty (depositor != recipient — self-escrows do not count);
 * 2. clean standing: zero adverse events (read from the SAME live standing
 * facts the presentation vocabulary exposes);
 * 3. an active bond.
 *
 * Governance score and the stored per-wallet pe_count are GONE from the gate
 * this file asserts they no longer gate, and that each of the three
 * live criteria fails closed (its RED negative control) on a violating input.
 */

import { optInAsArbitrator } from './court';
import type { AgentBankDeps } from './types';
import { SAFETY_LIMITS } from './types';

jest.mock('./pe-utils', () => ({
  generatePE: jest.fn().mockResolvedValue({ peId: 'pe_mock', peHash: 'hash_mock', prevHash: 'prev_mock' }),
  generateSchedulerPE: jest.fn().mockResolvedValue({ peId: 'pe_mock', peHash: 'hash_mock', prevHash: 'prev_mock' }),
}));

jest.mock('../onchain/tx-verifier', () => ({
  verifyEvmContractCall: jest.fn().mockResolvedValue({ ok: true, blockNumber: 12345, confirmations: 5 }),
}));

// Criteria 2 (clean standing) and 3 (active bond) read the presentation
// vocabulary; drive them directly so the escrow query (criterion 1) is the only
// Firestore path this suite exercises.
jest.mock('../presentation/vocabulary', () => ({
  ...jest.requireActual('../presentation/vocabulary'),
  computeActorVocabulary: jest.fn(),
}));
import { computeActorVocabulary, VocabularyUnavailableError } from '../presentation/vocabulary';
const mockVocabulary = computeActorVocabulary as jest.Mock;

// ---------------------------------------------------------------------------
// Minimal Firestore mock
// ---------------------------------------------------------------------------

type DocShape = { exists: boolean; data: () => Record<string, unknown> };

function docOf(data: Record<string, unknown> | null): DocShape {
  return { exists: data !== null, data: () => data as Record<string, unknown> };
}

function collectionMock(
  docsById: Record<string, DocShape | undefined>,
  whereResult: { docs: DocShape[]; size: number; empty: boolean },
) {
  const chain: Record<string, jest.Mock> = {};
  chain.doc = jest.fn((id: string) => ({
    get: jest.fn().mockResolvedValue(docsById[id] ?? docOf(null)),
    set: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
  }));
  chain.where = jest.fn().mockReturnThis();
  chain.orderBy = jest.fn().mockReturnThis();
  chain.limit = jest.fn().mockReturnThis();
  chain.get = jest.fn().mockResolvedValue(whereResult);
  return chain;
}

const SELF = 'wallet_aw_test';
const OTHER = 'wallet_aw_other';

/** An escrow doc as a party of `SELF`. `self` makes both parties SELF (no real counterparty). */
function escrowDoc(side: 'depositor' | 'recipient', self = false): DocShape {
  return docOf({
    depositor_wallet_id: side === 'depositor' ? SELF : (self ? SELF : OTHER),
    recipient_wallet_id: side === 'recipient' ? SELF : (self ? SELF : OTHER),
    status: 'completed',
  });
}

function makeDeps(opts: {
  wallet: Record<string, unknown>;
  existingArbitrator?: Record<string, unknown> | null;
  completedEscrowsAsDepositor?: number;
  completedEscrowsAsRecipient?: number;
  /** Extra completed escrows on the depositor side whose counterparty is SELF (must NOT count). */
  selfEscrowsAsDepositor?: number;
}): AgentBankDeps {
  const walletDoc = docOf(opts.wallet);
  const arbitratorDoc = docOf(opts.existingArbitrator ?? null);

  const depositorDocs: DocShape[] = [
    ...new Array(opts.completedEscrowsAsDepositor ?? 0).fill(0).map(() => escrowDoc('depositor')),
    ...new Array(opts.selfEscrowsAsDepositor ?? 0).fill(0).map(() => escrowDoc('depositor', true)),
  ];
  const recipientDocs: DocShape[] = new Array(opts.completedEscrowsAsRecipient ?? 0)
    .fill(0).map(() => escrowDoc('recipient'));

  let escrowCall = 0;
  const escrowsCollection = collectionMock({}, { docs: [], size: 0, empty: true });
  escrowsCollection.get = jest.fn().mockImplementation(() => {
    const docs = escrowCall++ === 0 ? depositorDocs : recipientDocs;
    return Promise.resolve({ docs, size: docs.length, empty: docs.length === 0 });
  });

  const collections: Record<string, ReturnType<typeof collectionMock>> = {
    agent_wallets: collectionMock({ [SELF]: walletDoc }, { docs: [], size: 0, empty: true }),
    arbitrators: collectionMock({ [SELF]: arbitratorDoc }, { docs: [], size: 0, empty: true }),
    escrows: escrowsCollection,
  };

  const db = {
    collection: jest.fn((name: string) => collections[name] ?? collectionMock({}, { docs: [], size: 0, empty: true })),
    runTransaction: jest.fn(async (fn: any) => fn({ get: jest.fn(), set: jest.fn(), update: jest.fn() })),
  } as unknown as AgentBankDeps['db'];

  return {
    db,
    cache: { checkRateLimit: jest.fn().mockResolvedValue({ allowed: true }) } as unknown as AgentBankDeps['cache'],
    peBuffer: { enqueue: jest.fn() },
    recordPEAccrual: jest.fn().mockResolvedValue(undefined),
  } as unknown as AgentBankDeps;
}

const baseWallet = {
  id: SELF,
  agent_id: 'agent-1',
  address: '0xAgent1',
  economic_activity_usd: 100000,
  badges: [],
  streak_days: 30,
  x402_payment_count: 0,
  created_at: Date.now(),
};

// Clean standing + active bond, the passing vocabulary.
function cleanBondedFacts(): Record<string, number> {
  return { 'standing.adverse_events': 0, 'standing.bond_active': 1 };
}

beforeEach(() => {
  mockVocabulary.mockResolvedValue(cleanBondedFacts());
});

describe('optInAsArbitrator — three-criteria gate', () => {
  it('accepts an agent with >=10 real-counterparty escrows, clean standing, and an active bond', async () => {
    const deps = makeDeps({ wallet: baseWallet, completedEscrowsAsDepositor: 10 });
    const result = await optInAsArbitrator(deps, SELF);
    expect(result.wallet_id).toBe(SELF);
    expect(result.is_active).toBe(true);
    expect(result.completed_escrows).toBe(10);
  });

  it('counts completed escrows as depositor AND recipient toward the minimum', async () => {
    const deps = makeDeps({ wallet: baseWallet, completedEscrowsAsDepositor: 6, completedEscrowsAsRecipient: 4 });
    const result = await optInAsArbitrator(deps, SELF);
    expect(result.completed_escrows).toBe(10);
    expect(result.is_active).toBe(true);
  });

  // RED control for criterion 1's real-counterparty filter.
  it('does NOT count self-escrows (depositor === recipient) toward the minimum', async () => {
    const deps = makeDeps({
      wallet: baseWallet,
      completedEscrowsAsDepositor: 9,   // 9 real
      selfEscrowsAsDepositor: 5,        // 5 self-escrows that must be excluded
    });
    await expect(optInAsArbitrator(deps, SELF)).rejects.toThrow(/completed escrows with a real counterparty/);
  });

  // RED control for criterion 1's threshold.
  it('rejects below the completed-escrow minimum', async () => {
    const deps = makeDeps({
      wallet: baseWallet,
      completedEscrowsAsDepositor: SAFETY_LIMITS.COURT_MIN_COMPLETED_ESCROWS - 1,
    });
    await expect(optInAsArbitrator(deps, SELF)).rejects.toThrow(/completed escrows with a real counterparty/);
  });

  // RED control for criterion 2 (clean standing).
  it('rejects an agent with any adverse event on record', async () => {
    mockVocabulary.mockResolvedValue({ 'standing.adverse_events': 1, 'standing.bond_active': 1 });
    const deps = makeDeps({ wallet: baseWallet, completedEscrowsAsDepositor: 10 });
    await expect(optInAsArbitrator(deps, SELF)).rejects.toThrow(/Clean standing required/);
  });

  // RED control for criterion 3 (active bond).
  it('rejects an agent with no active bond', async () => {
    mockVocabulary.mockResolvedValue({ 'standing.adverse_events': 0, 'standing.bond_active': 0 });
    const deps = makeDeps({ wallet: baseWallet, completedEscrowsAsDepositor: 10 });
    await expect(optInAsArbitrator(deps, SELF)).rejects.toThrow(/active bond is required/);
  });

  // RED control for item 2 (Unknown = Block): a standing source that cannot be read denies the
  // seat and writes no arbitrator record — it is never read as a clean zero.
  it('denies the seat when a standing source is unavailable (the seat write is never reached)', async () => {
    mockVocabulary.mockRejectedValue(new VocabularyUnavailableError('bonds', 'boom'));
    const deps = makeDeps({ wallet: baseWallet, completedEscrowsAsDepositor: 10 });
    await expect(optInAsArbitrator(deps, SELF)).rejects.toThrow(/Standing could not be read \(source: bonds\)/);
    // The arbitrators collection is never even opened (the gate stops before the seat write).
    expect((deps.db.collection as jest.Mock).mock.calls.map((c) => c[0])).not.toContain('arbitrators');
  });
});

describe('optInAsArbitrator — governance/PE-tally gates are gone ', () => {
  it('admits an agent regardless of any governance score or stored PE tally (neither is read)', async () => {
    // No governance_score / pe_count on the wallet at all — the gate never touches them.
    const deps = makeDeps({ wallet: baseWallet, completedEscrowsAsDepositor: 10 });
    const result = await optInAsArbitrator(deps, SELF);
    expect(result.is_active).toBe(true);
    // The stored counters are not written onto the arbitrator record either.
    expect(result).not.toHaveProperty('governance_score');
    expect(result).not.toHaveProperty('pe_count');
  });

  it('no longer exposes governance-score / PE-count / stake thresholds', () => {
    expect(SAFETY_LIMITS).not.toHaveProperty('COURT_MIN_GOVERNANCE_SCORE');
    expect(SAFETY_LIMITS).not.toHaveProperty('COURT_MIN_PE_COUNT');
    expect(SAFETY_LIMITS).not.toHaveProperty('COURT_MIN_STAKE_PVT');
  });
});
