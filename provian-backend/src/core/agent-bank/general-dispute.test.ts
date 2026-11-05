/**
 * General Dispute - Court Mandate Expansion Tests
 */

import {
  fileGeneralDispute,
  submitEvidence,
  assignGeneralDisputePanel,
  castGeneralDisputeVote,
  getGeneralDispute,
  listMyGeneralDisputes,
  processGeneralDisputeDeadlines,
} from './court';
import type { AgentBankDeps } from './types';
import type { AgentWalletDocument } from '../agent-wallet/types';

// agent directory: minimal acting-wallet doc for the kill-switch-first machine gate.
const ACTING_WALLET = { status: 'active' } as unknown as AgentWalletDocument;

// ---------------------------------------------------------------------------
// Mock Firestore document and collection
// ---------------------------------------------------------------------------

function createMockDoc(data: Record<string, unknown> | null) {
  return {
    exists: data !== null,
    data: () => data,
    id: (data?.dispute_id || data?.wallet_id || 'mock-id') as string,
    ref: {
      update: jest.fn().mockResolvedValue(undefined),
    },
  };
}

function createMockCollection(docs: ReturnType<typeof createMockDoc>[] = []) {
  const chain: Record<string, jest.Mock> = {};

  chain.doc = jest.fn().mockReturnValue({
    get: jest.fn().mockResolvedValue(docs[0] || createMockDoc(null)),
    set: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
  });
  chain.where = jest.fn().mockReturnThis();
  chain.orderBy = jest.fn().mockReturnThis();
  chain.limit = jest.fn().mockReturnThis();
  chain.get = jest.fn().mockResolvedValue({
    docs,
    empty: docs.length === 0,
    size: docs.length,
  });
  chain.count = jest.fn().mockReturnValue({
    get: jest.fn().mockResolvedValue({ data: () => ({ count: docs.length }) }),
  });

  return chain;
}

function createMockDeps(overrides?: Partial<AgentBankDeps>): AgentBankDeps {
  // Minimal runTransaction that provides a txn with get/set/update, matching the
  // Firestore contract that pe-chain-validator.advanceChainTipAtomic expects.
  const runTransaction = jest.fn(async (fn: (txn: {
    get: jest.Mock;
    set: jest.Mock;
    update: jest.Mock;
    create: jest.Mock;
  }) => Promise<unknown>) => {
    const txn = {
      get: jest.fn().mockResolvedValue({ exists: false, data: () => null }),
      set: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
      // cutover reconciliation: the ordinary-accrual intake co-write uses txn.create.
      create: jest.fn().mockResolvedValue(undefined),
    };
    return fn(txn);
  });

  return {
    db: {
      collection: jest.fn().mockReturnValue(createMockCollection()),
      runTransaction,
    } as any,
    cache: {
      checkRateLimit: jest.fn().mockResolvedValue({ allowed: true }),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    } as any,
    peBuffer: {
      enqueue: jest.fn(),
    },
    recordPEAccrual: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * PE METER (2026-10-03): `generatePE` no longer enqueues a readable PE. Its act is staged in the
 * tip transaction and priced through the meter: the accrual is called with the act's own type and
 * a `meter` context carrying the committed pe hash. That call is the evidence the PE was generated.
 */
function expectMeteredAct(deps: AgentBankDeps, actionType: string): void {
  expect(deps.peBuffer.enqueue).not.toHaveBeenCalled();
  expect(deps.recordPEAccrual).toHaveBeenCalledWith(expect.objectContaining({
    actionType,
    peHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    meter: expect.objectContaining({ peHash: expect.stringMatching(/^[0-9a-f]{64}$/) }),
  }));
}

function makeWalletData(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wallet_aw_test',
    agent_id: 'agent-1',
    address: '0xabc123',
    // agent directory: the kill-switch-first gate reads the acting/filer wallet's status.
    status: 'active',
    display_name: 'Test Agent',
    ...overrides,
  };
}

// PE METER: a subject PE resolves from its 31-day act key (`meter_act_keys_v1`), whose `facts`
// carry the identity fields standing reads: user_id / wallet_id / counterparty_address.
function actKeyOf(facts: { user_id: string; wallet_id: string | null; counterparty_address: string | null }) {
  return {
    relay_pe_id: 'pe_1',
    actor_id: facts.user_id,
    action_type: 'escrow_completed',
    timestamp: 1_700_000_000_000,
    facts: {
      action_type: 'escrow_completed',
      timestamp: 1_700_000_000_000,
      actor_address: null,
      job_id: null,
      promise_id: null,
      ...facts,
    },
  };
}

function makePEData(overrides: Partial<{ user_id: string; wallet_id: string | null; counterparty_address: string | null }> = {}) {
  return actKeyOf({
    user_id: 'agent-1',
    wallet_id: 'wallet-a',
    counterparty_address: '0xabc123',
    ...overrides,
  });
}

function makeDisputeData(overrides: Record<string, unknown> = {}) {
  return {
    dispute_id: 'gd_test-dispute',
    filed_by: 'wallet-a',
    respondent: 'wallet-b',
    subject_pe_ids: ['pe_1'],
    description: 'Test dispute',
    requested_remedy: 'Refund',
    evidence_pe_ids: [],
    status: 'filed',
    panel_wallet_ids: undefined as string[] | undefined,
    votes: undefined as Record<string, string> | undefined,
    pe_ids: [],
    created_at: Date.now(),
    updated_at: Date.now(),
    filed_at: Date.now(),
    ...overrides,
  };
}

// Mock firebase-admin/firestore FieldValue
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    increment: jest.fn((n: number) => ({ _increment: n })),
  },
  // PE METER: generatePE stages a relay-act intake whose TTL (`expire_at`) is a Firestore
  // Timestamp built by `meter-store.ts::expireAt`.
  Timestamp: {
    fromMillis: jest.fn((ms: number) => ({ _millis: ms })),
  },
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('General Disputes', () => {
  // =========================================================================
  // fileGeneralDispute
  // =========================================================================
  describe('fileGeneralDispute', () => {
    it('successfully files with valid params', async () => {
      const walletA = makeWalletData();
      const walletB = makeWalletData({ agent_id: 'agent-2', address: '0xdef456' });
      const peData = makePEData({ user_id: 'agent-1', wallet_id: 'wallet-a' });

      const agentWalletsCol = createMockCollection();
      agentWalletsCol.doc = jest.fn().mockImplementation((id: string) => ({
        get: jest.fn().mockResolvedValue(
          createMockDoc(id === 'wallet-a' ? walletA : walletB),
        ),
        set: jest.fn().mockResolvedValue(undefined),
        update: jest.fn().mockResolvedValue(undefined),
      }));

      const peHistoryCol = createMockCollection();
      peHistoryCol.doc = jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue(createMockDoc(peData)),
      });

      // No open disputes
      const generalDisputesCol = createMockCollection([]);
      generalDisputesCol.doc = jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue(createMockDoc(null)),
        set: jest.fn().mockResolvedValue(undefined),
        update: jest.fn().mockResolvedValue(undefined),
      });

      const deps = createMockDeps({
        db: {
          collection: jest.fn().mockImplementation((name: string) => {
            if (name === 'agent_wallets') return agentWalletsCol;
            if (name === 'meter_act_keys_v1') return peHistoryCol;
            if (name === 'general_disputes') return generalDisputesCol;
            return createMockCollection();
          }),
          runTransaction: jest.fn(async (fn: any) => fn({
            // agent directory: route transactional reads/writes through the ref's own mocks
            // so the transactional vote/panel/claim paths observe the same docs
            // the direct reads serve (and .update assertions keep working).
            get: jest.fn((ref: any) =>
              ref && typeof ref.get === 'function'
                ? ref.get()
                : Promise.resolve({ exists: false, data: () => null })),
            set: jest.fn().mockResolvedValue(undefined),
            update: jest.fn((ref: any, data: any) =>
              ref && typeof ref.update === 'function' ? ref.update(data) : Promise.resolve(undefined)),
            // cutover reconciliation: the ordinary-accrual intake co-write uses txn.create.
            create: jest.fn().mockResolvedValue(undefined),
          })),
        } as any,
      });

      const result = await fileGeneralDispute(deps, {
        filedBy: 'wallet-a',
        respondent: 'wallet-b',
        subjectPeIds: ['pe_1'],
        description: 'Agent failed to deliver work',
        requestedRemedy: 'Refund payment',
      });

      expect(result.disputeId).toBeDefined();
      expect(result.disputeId).toMatch(/^gd_/);
      expectMeteredAct(deps, 'court_general_dispute_filed');
    });

    it('grants standing when the filer IS the counterparty recorded CHECKSUMMED (casing-audit regression)', async () => {
      // The filer is neither pe.user_id nor pe.wallet_id — standing depends ENTIRELY
      // on the counterparty_address clause. The PE recorded the counterparty
      // checksummed (client-supplied), while the wallet address is lowercase.
      // Pre-fix the byte-exact compare missed and a legitimate counterparty was
      // denied standing; the fix compares case-insensitively. (The standing
      // check reads provenance_envelopes, which carries counterparty_address;
      // pe_history does not — so this clause is now LIVE in production.)
      const LOWER = '0x90f8bf6a479f320ead074411a4b0e7944ea8c9c1';
      const CHECKSUMMED = '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1'; // same address, mixed case
      const walletA = makeWalletData({ agent_id: 'agent-filer', address: LOWER });
      const walletB = makeWalletData({ agent_id: 'agent-2', address: '0xdef456' });

      const agentWalletsCol = createMockCollection();
      agentWalletsCol.doc = jest.fn().mockImplementation((id: string) => ({
        get: jest.fn().mockResolvedValue(createMockDoc(id === 'wallet-a' ? walletA : walletB)),
        set: jest.fn().mockResolvedValue(undefined),
        update: jest.fn().mockResolvedValue(undefined),
      }));

      // PE METER: the act key's `facts` carry the counterparty; the filer appears ONLY as the
      // (checksummed) counterparty there. A legacy pe_history row naming someone else is still
      // served from the retired collection to prove it is no longer read: reading it instead of
      // the act key makes this FAIL (no counterparty there).
      const peHistoryCol = createMockCollection();
      peHistoryCol.doc = jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue(createMockDoc({
          peId: 'pe_1', userId: 'agent-other', peHash: 'h', corroboration_status: 'none',
        })),
      });
      const provenanceEnvelopesCol = createMockCollection();
      provenanceEnvelopesCol.doc = jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue(createMockDoc(actKeyOf({
          user_id: 'agent-other', wallet_id: 'wallet-other', counterparty_address: CHECKSUMMED,
        }))),
      });

      const generalDisputesCol = createMockCollection([]);
      generalDisputesCol.doc = jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue(createMockDoc(null)),
        set: jest.fn().mockResolvedValue(undefined),
        update: jest.fn().mockResolvedValue(undefined),
      });

      const deps = createMockDeps({
        db: {
          collection: jest.fn().mockImplementation((name: string) => {
            if (name === 'agent_wallets') return agentWalletsCol;
            if (name === 'meter_act_keys_v1') return provenanceEnvelopesCol;
            if (name === 'pe_history' || name === 'provenance_envelopes') return peHistoryCol;
            if (name === 'general_disputes') return generalDisputesCol;
            return createMockCollection();
          }),
          runTransaction: jest.fn(async (fn: any) => fn({
            // agent directory: route transactional reads/writes through the ref's own mocks
            // so the transactional vote/panel/claim paths observe the same docs
            // the direct reads serve (and .update assertions keep working).
            get: jest.fn((ref: any) =>
              ref && typeof ref.get === 'function'
                ? ref.get()
                : Promise.resolve({ exists: false, data: () => null })),
            set: jest.fn().mockResolvedValue(undefined),
            update: jest.fn((ref: any, data: any) =>
              ref && typeof ref.update === 'function' ? ref.update(data) : Promise.resolve(undefined)),
            // cutover reconciliation: the ordinary-accrual intake co-write uses txn.create.
            create: jest.fn().mockResolvedValue(undefined),
          })),
        } as any,
      });

      // No throw == standing granted via the case-insensitive counterparty match.
      const result = await fileGeneralDispute(deps, {
        filedBy: 'wallet-a',
        respondent: 'wallet-b',
        subjectPeIds: ['pe_1'],
        description: 'I was the counterparty and the work was not delivered',
        requestedRemedy: 'Refund payment',
      });
      expect(result.disputeId).toMatch(/^gd_/);
    });

    // the governance-score filing gate ("< 10 → reject") is REMOVED.
    // The filer's standing is now the counterparty check + open-dispute cap;
    // there is no governance_score threshold, so this test is deleted.

    it('rejects if filing against self', async () => {
      const walletA = makeWalletData();

      const agentWalletsCol = createMockCollection();
      agentWalletsCol.doc = jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue(createMockDoc(walletA)),
      });

      const deps = createMockDeps({
        db: {
          collection: jest.fn().mockImplementation((name: string) => {
            if (name === 'agent_wallets') return agentWalletsCol;
            return createMockCollection();
          }),

          runTransaction: jest.fn(async (fn: any) => fn({
            // agent directory: route transactional reads/writes through the ref's own mocks
            // so the transactional vote/panel/claim paths observe the same docs
            // the direct reads serve (and .update assertions keep working).
            get: jest.fn((ref: any) =>
              ref && typeof ref.get === 'function'
                ? ref.get()
                : Promise.resolve({ exists: false, data: () => null })),
            set: jest.fn().mockResolvedValue(undefined),
            update: jest.fn((ref: any, data: any) =>
              ref && typeof ref.update === 'function' ? ref.update(data) : Promise.resolve(undefined)),
            // cutover reconciliation: the ordinary-accrual intake co-write uses txn.create.
            create: jest.fn().mockResolvedValue(undefined),
          })),
        } as any,
      });

      await expect(
        fileGeneralDispute(deps, {
          filedBy: 'wallet-a',
          respondent: 'wallet-a',
          subjectPeIds: ['pe_1'],
          description: 'Test',
          requestedRemedy: 'Refund',
        }),
      ).rejects.toThrow(/Cannot file a dispute against yourself/);
    });

    it('rejects if max open disputes exceeded (5)', async () => {
      const walletA = makeWalletData();
      const walletB = makeWalletData({ agent_id: 'agent-2' });
      const peData = makePEData();

      const agentWalletsCol = createMockCollection();
      agentWalletsCol.doc = jest.fn().mockImplementation((id: string) => ({
        get: jest.fn().mockResolvedValue(
          createMockDoc(id === 'wallet-a' ? walletA : walletB),
        ),
        set: jest.fn().mockResolvedValue(undefined),
        update: jest.fn().mockResolvedValue(undefined),
      }));

      const peHistoryCol = createMockCollection();
      peHistoryCol.doc = jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue(createMockDoc(peData)),
      });

      // 5 open disputes already
      const fiveOpenDocs = Array(5).fill(null).map(() => createMockDoc(makeDisputeData()));
      const generalDisputesCol = createMockCollection([]);
      // .where().where().get() returns 5 open disputes
      const whereChain = {
        where: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({
          docs: fiveOpenDocs,
          empty: false,
          size: 5,
        }),
      };
      generalDisputesCol.where = jest.fn().mockReturnValue(whereChain);
      generalDisputesCol.doc = jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue(createMockDoc(null)),
        set: jest.fn().mockResolvedValue(undefined),
        update: jest.fn().mockResolvedValue(undefined),
      });

      const deps = createMockDeps({
        db: {
          collection: jest.fn().mockImplementation((name: string) => {
            if (name === 'agent_wallets') return agentWalletsCol;
            if (name === 'meter_act_keys_v1') return peHistoryCol;
            if (name === 'general_disputes') return generalDisputesCol;
            return createMockCollection();
          }),

          runTransaction: jest.fn(async (fn: any) => fn({
            // agent directory: route transactional reads/writes through the ref's own mocks
            // so the transactional vote/panel/claim paths observe the same docs
            // the direct reads serve (and .update assertions keep working).
            get: jest.fn((ref: any) =>
              ref && typeof ref.get === 'function'
                ? ref.get()
                : Promise.resolve({ exists: false, data: () => null })),
            set: jest.fn().mockResolvedValue(undefined),
            update: jest.fn((ref: any, data: any) =>
              ref && typeof ref.update === 'function' ? ref.update(data) : Promise.resolve(undefined)),
            // cutover reconciliation: the ordinary-accrual intake co-write uses txn.create.
            create: jest.fn().mockResolvedValue(undefined),
          })),
        } as any,
      });

      await expect(
        fileGeneralDispute(deps, {
          filedBy: 'wallet-a',
          respondent: 'wallet-b',
          subjectPeIds: ['pe_1'],
          description: 'Test',
          requestedRemedy: 'Refund',
        }),
      ).rejects.toThrow(/Maximum 5 open disputes/);
    });

    it('rejects if subject PE IDs empty or > 10', async () => {
      const walletA = makeWalletData();
      const walletB = makeWalletData({ agent_id: 'agent-2' });

      const agentWalletsCol = createMockCollection();
      agentWalletsCol.doc = jest.fn().mockImplementation((id: string) => ({
        get: jest.fn().mockResolvedValue(
          createMockDoc(id === 'wallet-a' ? walletA : walletB),
        ),
      }));

      const deps = createMockDeps({
        db: {
          collection: jest.fn().mockImplementation((name: string) => {
            if (name === 'agent_wallets') return agentWalletsCol;
            return createMockCollection();
          }),

          runTransaction: jest.fn(async (fn: any) => fn({
            // agent directory: route transactional reads/writes through the ref's own mocks
            // so the transactional vote/panel/claim paths observe the same docs
            // the direct reads serve (and .update assertions keep working).
            get: jest.fn((ref: any) =>
              ref && typeof ref.get === 'function'
                ? ref.get()
                : Promise.resolve({ exists: false, data: () => null })),
            set: jest.fn().mockResolvedValue(undefined),
            update: jest.fn((ref: any, data: any) =>
              ref && typeof ref.update === 'function' ? ref.update(data) : Promise.resolve(undefined)),
            // cutover reconciliation: the ordinary-accrual intake co-write uses txn.create.
            create: jest.fn().mockResolvedValue(undefined),
          })),
        } as any,
      });

      // Empty
      await expect(
        fileGeneralDispute(deps, {
          filedBy: 'wallet-a',
          respondent: 'wallet-b',
          subjectPeIds: [],
          description: 'Test',
          requestedRemedy: 'Refund',
        }),
      ).rejects.toThrow(/Must provide 1-10 subject PE IDs/);

      // > 10
      const elevenPeIds = Array(11).fill(null).map((_, i) => `pe_${i}`);
      await expect(
        fileGeneralDispute(deps, {
          filedBy: 'wallet-a',
          respondent: 'wallet-b',
          subjectPeIds: elevenPeIds,
          description: 'Test',
          requestedRemedy: 'Refund',
        }),
      ).rejects.toThrow(/Must provide 1-10 subject PE IDs/);
    });

    it('rejects if complainant has no standing on PE', async () => {
      const walletA = makeWalletData({ agent_id: 'agent-1', address: '0xabc' });
      const walletB = makeWalletData({ agent_id: 'agent-2', address: '0xdef' });
      // The act key's facts name a different user_id, wallet_id, and
      // counterparty_address than the filer → no standing.
      const peData = actKeyOf({
        user_id: 'agent-999',
        wallet_id: 'wallet-other',
        counterparty_address: '0xother',
      });

      const agentWalletsCol = createMockCollection();
      agentWalletsCol.doc = jest.fn().mockImplementation((id: string) => ({
        get: jest.fn().mockResolvedValue(
          createMockDoc(id === 'wallet-a' ? walletA : walletB),
        ),
      }));

      const peHistoryCol = createMockCollection();
      peHistoryCol.doc = jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue(createMockDoc(peData)),
      });

      const deps = createMockDeps({
        db: {
          collection: jest.fn().mockImplementation((name: string) => {
            if (name === 'agent_wallets') return agentWalletsCol;
            if (name === 'meter_act_keys_v1') return peHistoryCol;
            return createMockCollection();
          }),

          runTransaction: jest.fn(async (fn: any) => fn({
            // agent directory: route transactional reads/writes through the ref's own mocks
            // so the transactional vote/panel/claim paths observe the same docs
            // the direct reads serve (and .update assertions keep working).
            get: jest.fn((ref: any) =>
              ref && typeof ref.get === 'function'
                ? ref.get()
                : Promise.resolve({ exists: false, data: () => null })),
            set: jest.fn().mockResolvedValue(undefined),
            update: jest.fn((ref: any, data: any) =>
              ref && typeof ref.update === 'function' ? ref.update(data) : Promise.resolve(undefined)),
            // cutover reconciliation: the ordinary-accrual intake co-write uses txn.create.
            create: jest.fn().mockResolvedValue(undefined),
          })),
        } as any,
      });

      await expect(
        fileGeneralDispute(deps, {
          filedBy: 'wallet-a',
          respondent: 'wallet-b',
          subjectPeIds: ['pe_1'],
          description: 'Test',
          requestedRemedy: 'Refund',
        }),
      ).rejects.toThrow(/Complainant has no standing on PE/);
    });
  });

  // =========================================================================
  // submitEvidence
  // =========================================================================
  describe('submitEvidence', () => {
    it('successfully submits during evidence_period', async () => {
      const disputeData = makeDisputeData({
        status: 'evidence_period',
        filed_by: 'wallet-a',
        respondent: 'wallet-b',
        evidence_pe_ids: [],
      });
      const walletA = makeWalletData({ agent_id: 'agent-1', address: '0xabc' });
      const peData = makePEData();

      const disputeDocMock = {
        get: jest.fn().mockResolvedValue(createMockDoc(disputeData)),
        set: jest.fn().mockResolvedValue(undefined),
        update: jest.fn().mockResolvedValue(undefined),
      };

      const generalDisputesCol = createMockCollection();
      generalDisputesCol.doc = jest.fn().mockReturnValue(disputeDocMock);

      const peHistoryCol = createMockCollection();
      peHistoryCol.doc = jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue(createMockDoc(peData)),
      });

      const agentWalletsCol = createMockCollection();
      agentWalletsCol.doc = jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue(createMockDoc(walletA)),
      });

      const deps = createMockDeps({
        db: {
          collection: jest.fn().mockImplementation((name: string) => {
            if (name === 'general_disputes') return generalDisputesCol;
            if (name === 'meter_act_keys_v1') return peHistoryCol;
            if (name === 'agent_wallets') return agentWalletsCol;
            return createMockCollection();
          }),

          runTransaction: jest.fn(async (fn: any) => fn({
            // agent directory: route transactional reads/writes through the ref's own mocks
            // so the transactional vote/panel/claim paths observe the same docs
            // the direct reads serve (and .update assertions keep working).
            get: jest.fn((ref: any) =>
              ref && typeof ref.get === 'function'
                ? ref.get()
                : Promise.resolve({ exists: false, data: () => null })),
            set: jest.fn().mockResolvedValue(undefined),
            update: jest.fn((ref: any, data: any) =>
              ref && typeof ref.update === 'function' ? ref.update(data) : Promise.resolve(undefined)),
            // cutover reconciliation: the ordinary-accrual intake co-write uses txn.create.
            create: jest.fn().mockResolvedValue(undefined),
          })),
        } as any,
      });

      await expect(
        submitEvidence(deps, {
          disputeId: 'gd_test-dispute',
          submittedBy: 'wallet-a',
          evidencePeIds: ['pe_evidence_1'],
        }),
      ).resolves.toBeUndefined();

      expect(disputeDocMock.update).toHaveBeenCalled();
    });

    it('rejects if not a party', async () => {
      const disputeData = makeDisputeData({
        status: 'evidence_period',
        filed_by: 'wallet-a',
        respondent: 'wallet-b',
      });

      const generalDisputesCol = createMockCollection();
      generalDisputesCol.doc = jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue(createMockDoc(disputeData)),
      });

      const deps = createMockDeps({
        db: {
          collection: jest.fn().mockImplementation((name: string) => {
            if (name === 'general_disputes') return generalDisputesCol;
            return createMockCollection();
          }),

          runTransaction: jest.fn(async (fn: any) => fn({
            // agent directory: route transactional reads/writes through the ref's own mocks
            // so the transactional vote/panel/claim paths observe the same docs
            // the direct reads serve (and .update assertions keep working).
            get: jest.fn((ref: any) =>
              ref && typeof ref.get === 'function'
                ? ref.get()
                : Promise.resolve({ exists: false, data: () => null })),
            set: jest.fn().mockResolvedValue(undefined),
            update: jest.fn((ref: any, data: any) =>
              ref && typeof ref.update === 'function' ? ref.update(data) : Promise.resolve(undefined)),
            // cutover reconciliation: the ordinary-accrual intake co-write uses txn.create.
            create: jest.fn().mockResolvedValue(undefined),
          })),
        } as any,
      });

      await expect(
        submitEvidence(deps, {
          disputeId: 'gd_test-dispute',
          submittedBy: 'wallet-outsider',
          evidencePeIds: ['pe_1'],
        }),
      ).rejects.toThrow(/Only dispute parties can submit evidence/);
    });

    it('rejects if not in evidence_period status', async () => {
      const disputeData = makeDisputeData({
        status: 'voting',
        filed_by: 'wallet-a',
        respondent: 'wallet-b',
      });

      const generalDisputesCol = createMockCollection();
      generalDisputesCol.doc = jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue(createMockDoc(disputeData)),
      });

      const deps = createMockDeps({
        db: {
          collection: jest.fn().mockImplementation((name: string) => {
            if (name === 'general_disputes') return generalDisputesCol;
            return createMockCollection();
          }),

          runTransaction: jest.fn(async (fn: any) => fn({
            // agent directory: route transactional reads/writes through the ref's own mocks
            // so the transactional vote/panel/claim paths observe the same docs
            // the direct reads serve (and .update assertions keep working).
            get: jest.fn((ref: any) =>
              ref && typeof ref.get === 'function'
                ? ref.get()
                : Promise.resolve({ exists: false, data: () => null })),
            set: jest.fn().mockResolvedValue(undefined),
            update: jest.fn((ref: any, data: any) =>
              ref && typeof ref.update === 'function' ? ref.update(data) : Promise.resolve(undefined)),
            // cutover reconciliation: the ordinary-accrual intake co-write uses txn.create.
            create: jest.fn().mockResolvedValue(undefined),
          })),
        } as any,
      });

      await expect(
        submitEvidence(deps, {
          disputeId: 'gd_test-dispute',
          submittedBy: 'wallet-a',
          evidencePeIds: ['pe_1'],
        }),
      ).rejects.toThrow(/Cannot submit evidence in voting status/);
    });
  });

  // =========================================================================
  // assignGeneralDisputePanel
  // =========================================================================
  describe('assignGeneralDisputePanel', () => {
    it('successfully assigns panel of 3', async () => {
      const disputeData = makeDisputeData({ status: 'filed' });

      const disputeDocMock = {
        get: jest.fn()
          .mockResolvedValueOnce(createMockDoc(disputeData))  // initial get
          .mockResolvedValueOnce(createMockDoc(disputeData))  // agent directory: fresh read inside the claim txn
          .mockResolvedValueOnce(createMockDoc({              // after update get
            ...disputeData,
            status: 'evidence_period',
            panel_wallet_ids: ['arb-1', 'arb-2', 'arb-3'],
          })),
        set: jest.fn().mockResolvedValue(undefined),
        update: jest.fn().mockResolvedValue(undefined),
      };

      const generalDisputesCol = createMockCollection();
      generalDisputesCol.doc = jest.fn().mockReturnValue(disputeDocMock);

      // Create enough arbitrators (need at least COURT_MIN_ARBITRATORS)
      const arbitrators = Array.from({ length: 20 }, (_, i) => createMockDoc({
        wallet_id: `arb-${i}`,
        address: `0xarb${i}`,
        agent_id: `arb-agent-${i}`,
        is_active: true,
        completed_escrows: 15,
        total_cases: 0,
        majority_votes: 0,
        minority_votes: 0,
      }));

      const arbitratorsCol = createMockCollection(arbitrators);
      const agentWalletsCol = createMockCollection();
      // Mock for arbitrator doc updates
      agentWalletsCol.doc = jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue(createMockDoc(makeWalletData())),
        update: jest.fn().mockResolvedValue(undefined),
      });

      const arbDocUpdate = {
        get: jest.fn().mockResolvedValue(createMockDoc({})),
        update: jest.fn().mockResolvedValue(undefined),
      };
      arbitratorsCol.doc = jest.fn().mockReturnValue(arbDocUpdate);

      const deps = createMockDeps({
        db: {
          collection: jest.fn().mockImplementation((name: string) => {
            if (name === 'general_disputes') return generalDisputesCol;
            if (name === 'arbitrators') return arbitratorsCol;
            if (name === 'agent_wallets') return agentWalletsCol;
            return createMockCollection();
          }),

          runTransaction: jest.fn(async (fn: any) => fn({
            // agent directory: route transactional reads/writes through the ref's own mocks
            // so the transactional vote/panel/claim paths observe the same docs
            // the direct reads serve (and .update assertions keep working).
            get: jest.fn((ref: any) =>
              ref && typeof ref.get === 'function'
                ? ref.get()
                : Promise.resolve({ exists: false, data: () => null })),
            set: jest.fn().mockResolvedValue(undefined),
            update: jest.fn((ref: any, data: any) =>
              ref && typeof ref.update === 'function' ? ref.update(data) : Promise.resolve(undefined)),
            // cutover reconciliation: the ordinary-accrual intake co-write uses txn.create.
            create: jest.fn().mockResolvedValue(undefined),
          })),
        } as any,
      });

      const result = await assignGeneralDisputePanel(deps, 'gd_test-dispute');

      expect(result).toBeDefined();
      expect(disputeDocMock.update).toHaveBeenCalled();
      expectMeteredAct(deps, 'court_panel_assigned');
    });

    it('rejects if dispute not in filed status', async () => {
      const disputeData = makeDisputeData({ status: 'voting' });

      const generalDisputesCol = createMockCollection();
      generalDisputesCol.doc = jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue(createMockDoc(disputeData)),
      });

      const deps = createMockDeps({
        db: {
          collection: jest.fn().mockImplementation((name: string) => {
            if (name === 'general_disputes') return generalDisputesCol;
            return createMockCollection();
          }),

          runTransaction: jest.fn(async (fn: any) => fn({
            // agent directory: route transactional reads/writes through the ref's own mocks
            // so the transactional vote/panel/claim paths observe the same docs
            // the direct reads serve (and .update assertions keep working).
            get: jest.fn((ref: any) =>
              ref && typeof ref.get === 'function'
                ? ref.get()
                : Promise.resolve({ exists: false, data: () => null })),
            set: jest.fn().mockResolvedValue(undefined),
            update: jest.fn((ref: any, data: any) =>
              ref && typeof ref.update === 'function' ? ref.update(data) : Promise.resolve(undefined)),
            // cutover reconciliation: the ordinary-accrual intake co-write uses txn.create.
            create: jest.fn().mockResolvedValue(undefined),
          })),
        } as any,
      });

      await expect(
        assignGeneralDisputePanel(deps, 'gd_test-dispute'),
      ).rejects.toThrow(/Dispute status is voting, expected filed/);
    });
  });

  // =========================================================================
  // castGeneralDisputeVote
  // =========================================================================
  describe('castGeneralDisputeVote', () => {
    it('records a vote', async () => {
      const disputeData = makeDisputeData({
        status: 'voting',
        panel_wallet_ids: ['arb-1', 'arb-2', 'arb-3'],
        votes: {},
      });

      const disputeDocMock = {
        get: jest.fn().mockResolvedValue(createMockDoc(disputeData)),
        update: jest.fn().mockResolvedValue(undefined),
      };

      const generalDisputesCol = createMockCollection();
      generalDisputesCol.doc = jest.fn().mockReturnValue(disputeDocMock);

      const voterWallet = makeWalletData({ agent_id: 'arb-agent-1', address: '0xarb1' });
      const agentWalletsCol = createMockCollection();
      agentWalletsCol.doc = jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue(createMockDoc(voterWallet)),
        update: jest.fn().mockResolvedValue(undefined),
      });

      const deps = createMockDeps({
        db: {
          collection: jest.fn().mockImplementation((name: string) => {
            if (name === 'general_disputes') return generalDisputesCol;
            if (name === 'agent_wallets') return agentWalletsCol;
            if (name === 'arbitrators') return createMockCollection();
            return createMockCollection();
          }),

          runTransaction: jest.fn(async (fn: any) => fn({
            // agent directory: route transactional reads/writes through the ref's own mocks
            // so the transactional vote/panel/claim paths observe the same docs
            // the direct reads serve (and .update assertions keep working).
            get: jest.fn((ref: any) =>
              ref && typeof ref.get === 'function'
                ? ref.get()
                : Promise.resolve({ exists: false, data: () => null })),
            set: jest.fn().mockResolvedValue(undefined),
            update: jest.fn((ref: any, data: any) =>
              ref && typeof ref.update === 'function' ? ref.update(data) : Promise.resolve(undefined)),
            // cutover reconciliation: the ordinary-accrual intake co-write uses txn.create.
            create: jest.fn().mockResolvedValue(undefined),
          })),
        } as any,
      });

      const result = await castGeneralDisputeVote(deps, 'gd_test', 'arb-1', ACTING_WALLET, 'upheld');

      expect(disputeDocMock.update).toHaveBeenCalled();
      expectMeteredAct(deps, 'court_vote_cast');
    });

    it('resolves on 2-vote majority (upheld)', async () => {
      const disputeData = makeDisputeData({
        status: 'voting',
        panel_wallet_ids: ['arb-1', 'arb-2', 'arb-3'],
        votes: { 'arb-1': 'upheld' },
        filed_by: 'wallet-a',
        respondent: 'wallet-b',
        subject_pe_ids: ['pe_1'],
        description: 'Agent failed to deliver',
        evidence_pe_ids: ['pe_ev_1'],
      });

      const disputeDocMock = {
        get: jest.fn().mockResolvedValue(createMockDoc(disputeData)),
        update: jest.fn().mockResolvedValue(undefined),
      };

      const generalDisputesCol = createMockCollection();
      generalDisputesCol.doc = jest.fn().mockReturnValue(disputeDocMock);
      // For the governance impact query: mock .where() chain for upheld disputes
      const whereChain = {
        where: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({ docs: [], empty: true, size: 0 }),
      };
      generalDisputesCol.where = jest.fn().mockReturnValue(whereChain);

      const walletA = makeWalletData({ agent_id: 'agent-a', address: '0xa' });
      const walletB = makeWalletData({ agent_id: 'agent-b', address: '0xb' });
      const arbWallet = makeWalletData({ agent_id: 'arb-agent-2', address: '0xarb2' });

      const agentWalletsCol = createMockCollection();
      agentWalletsCol.doc = jest.fn().mockImplementation((id: string) => ({
        get: jest.fn().mockResolvedValue(
          createMockDoc(
            id === 'wallet-a' ? walletA :
            id === 'wallet-b' ? walletB :
            arbWallet,
          ),
        ),
        update: jest.fn().mockResolvedValue(undefined),
      }));

      const arbitratorsCol = createMockCollection();
      arbitratorsCol.doc = jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue(createMockDoc({})),
        update: jest.fn().mockResolvedValue(undefined),
      });

      const deps = createMockDeps({
        db: {
          collection: jest.fn().mockImplementation((name: string) => {
            if (name === 'general_disputes') return generalDisputesCol;
            if (name === 'agent_wallets') return agentWalletsCol;
            if (name === 'arbitrators') return arbitratorsCol;
            return createMockCollection();
          }),

          runTransaction: jest.fn(async (fn: any) => fn({
            // agent directory: route transactional reads/writes through the ref's own mocks
            // so the transactional vote/panel/claim paths observe the same docs
            // the direct reads serve (and .update assertions keep working).
            get: jest.fn((ref: any) =>
              ref && typeof ref.get === 'function'
                ? ref.get()
                : Promise.resolve({ exists: false, data: () => null })),
            set: jest.fn().mockResolvedValue(undefined),
            update: jest.fn((ref: any, data: any) =>
              ref && typeof ref.update === 'function' ? ref.update(data) : Promise.resolve(undefined)),
            // cutover reconciliation: the ordinary-accrual intake co-write uses txn.create.
            create: jest.fn().mockResolvedValue(undefined),
          })),
        } as any,
      });

      const result = await castGeneralDisputeVote(deps, 'gd_test', 'arb-2', ACTING_WALLET, 'upheld');

      expect(result.status).toBe('resolved');
      expect(result.resolution).toBe('upheld');
    });

    it('resolves as upheld and writes NO governance delta on the respondent ', async () => {
      const disputeData = makeDisputeData({
        status: 'voting',
        panel_wallet_ids: ['arb-1', 'arb-2', 'arb-3'],
        votes: { 'arb-1': 'upheld' },
        filed_by: 'wallet-a',
        respondent: 'wallet-b',
        subject_pe_ids: ['pe_1'],
        description: 'Failed delivery',
        evidence_pe_ids: ['pe_ev_1'],
      });

      const disputeDocMock = {
        get: jest.fn().mockResolvedValue(createMockDoc(disputeData)),
        update: jest.fn().mockResolvedValue(undefined),
      };

      const generalDisputesCol = createMockCollection();
      generalDisputesCol.doc = jest.fn().mockReturnValue(disputeDocMock);
      const whereChain = {
        where: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({ docs: [], empty: true, size: 0 }),
      };
      generalDisputesCol.where = jest.fn().mockReturnValue(whereChain);

      const walletUpdates: Record<string, jest.Mock> = {};
      const agentWalletsCol = createMockCollection();
      agentWalletsCol.doc = jest.fn().mockImplementation((id: string) => {
        const updateFn = jest.fn().mockResolvedValue(undefined);
        walletUpdates[id] = updateFn;
        return {
          get: jest.fn().mockResolvedValue(
            createMockDoc(makeWalletData({ agent_id: `agent-${id}`, address: `0x${id}` })),
          ),
          update: updateFn,
        };
      });

      const arbitratorsCol = createMockCollection();
      arbitratorsCol.doc = jest.fn().mockReturnValue({
        update: jest.fn().mockResolvedValue(undefined),
      });

      const deps = createMockDeps({
        db: {
          collection: jest.fn().mockImplementation((name: string) => {
            if (name === 'general_disputes') return generalDisputesCol;
            if (name === 'agent_wallets') return agentWalletsCol;
            if (name === 'arbitrators') return arbitratorsCol;
            return createMockCollection();
          }),

          runTransaction: jest.fn(async (fn: any) => fn({
            // agent directory: route transactional reads/writes through the ref's own mocks
            // so the transactional vote/panel/claim paths observe the same docs
            // the direct reads serve (and .update assertions keep working).
            get: jest.fn((ref: any) =>
              ref && typeof ref.get === 'function'
                ? ref.get()
                : Promise.resolve({ exists: false, data: () => null })),
            set: jest.fn().mockResolvedValue(undefined),
            update: jest.fn((ref: any, data: any) =>
              ref && typeof ref.update === 'function' ? ref.update(data) : Promise.resolve(undefined)),
            // cutover reconciliation: the ordinary-accrual intake co-write uses txn.create.
            create: jest.fn().mockResolvedValue(undefined),
          })),
        } as any,
      });

      const result = await castGeneralDisputeVote(deps, 'gd_test', 'arb-2', ACTING_WALLET, 'upheld');

      // the verdict resolves the dispute (upheld) but writes NO
      // governance delta — applyGovernanceImpact and the governance_score field
      // are removed. Guard: the resolution runs, and no wallet update carries a
      // governance_score field.
      expect(result.status).toBe('resolved');
      expect(result.resolution).toBe('upheld');
      for (const updateFn of Object.values(walletUpdates)) {
        for (const call of updateFn.mock.calls) {
          expect(call[0]).not.toHaveProperty('governance_score');
        }
      }
    });

    it('resolves as dismissed and writes NO frivolous-filer governance delta ', async () => {
      const disputeData = makeDisputeData({
        status: 'voting',
        panel_wallet_ids: ['arb-1', 'arb-2', 'arb-3'],
        votes: { 'arb-1': 'dismissed' },
        filed_by: 'wallet-a',
        respondent: 'wallet-b',
        subject_pe_ids: ['pe_1'],
        description: 'Frivolous complaint',
        evidence_pe_ids: [],  // no evidence = frivolous
      });

      const disputeDocMock = {
        get: jest.fn().mockResolvedValue(createMockDoc(disputeData)),
        update: jest.fn().mockResolvedValue(undefined),
      };

      const generalDisputesCol = createMockCollection();
      generalDisputesCol.doc = jest.fn().mockReturnValue(disputeDocMock);

      const walletUpdates: Record<string, jest.Mock> = {};
      const agentWalletsCol = createMockCollection();
      agentWalletsCol.doc = jest.fn().mockImplementation((id: string) => {
        const updateFn = jest.fn().mockResolvedValue(undefined);
        walletUpdates[id] = updateFn;
        return {
          get: jest.fn().mockResolvedValue(
            createMockDoc(makeWalletData({ agent_id: `agent-${id}`, address: `0x${id}` })),
          ),
          update: updateFn,
        };
      });

      const arbitratorsCol = createMockCollection();
      arbitratorsCol.doc = jest.fn().mockReturnValue({
        update: jest.fn().mockResolvedValue(undefined),
      });

      const deps = createMockDeps({
        db: {
          collection: jest.fn().mockImplementation((name: string) => {
            if (name === 'general_disputes') return generalDisputesCol;
            if (name === 'agent_wallets') return agentWalletsCol;
            if (name === 'arbitrators') return arbitratorsCol;
            return createMockCollection();
          }),

          runTransaction: jest.fn(async (fn: any) => fn({
            // agent directory: route transactional reads/writes through the ref's own mocks
            // so the transactional vote/panel/claim paths observe the same docs
            // the direct reads serve (and .update assertions keep working).
            get: jest.fn((ref: any) =>
              ref && typeof ref.get === 'function'
                ? ref.get()
                : Promise.resolve({ exists: false, data: () => null })),
            set: jest.fn().mockResolvedValue(undefined),
            update: jest.fn((ref: any, data: any) =>
              ref && typeof ref.update === 'function' ? ref.update(data) : Promise.resolve(undefined)),
            // cutover reconciliation: the ordinary-accrual intake co-write uses txn.create.
            create: jest.fn().mockResolvedValue(undefined),
          })),
        } as any,
      });

      const result = await castGeneralDisputeVote(deps, 'gd_test', 'arb-2', ACTING_WALLET, 'dismissed');

      // a dismissed (frivolous) verdict resolves the dispute but writes
      // NO governance delta — the frivolous-filer score penalty is removed with
      // applyGovernanceImpact. Guard: the resolution runs, and no wallet update
      // carries a governance_score field.
      expect(result.status).toBe('resolved');
      expect(result.resolution).toBe('dismissed');
      for (const updateFn of Object.values(walletUpdates)) {
        for (const call of updateFn.mock.calls) {
          expect(call[0]).not.toHaveProperty('governance_score');
        }
      }
    });

    it('rejects vote from non-panel member', async () => {
      const disputeData = makeDisputeData({
        status: 'voting',
        panel_wallet_ids: ['arb-1', 'arb-2', 'arb-3'],
        votes: {},
      });

      const generalDisputesCol = createMockCollection();
      generalDisputesCol.doc = jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue(createMockDoc(disputeData)),
      });

      const deps = createMockDeps({
        db: {
          collection: jest.fn().mockImplementation((name: string) => {
            if (name === 'general_disputes') return generalDisputesCol;
            return createMockCollection();
          }),

          runTransaction: jest.fn(async (fn: any) => fn({
            // agent directory: route transactional reads/writes through the ref's own mocks
            // so the transactional vote/panel/claim paths observe the same docs
            // the direct reads serve (and .update assertions keep working).
            get: jest.fn((ref: any) =>
              ref && typeof ref.get === 'function'
                ? ref.get()
                : Promise.resolve({ exists: false, data: () => null })),
            set: jest.fn().mockResolvedValue(undefined),
            update: jest.fn((ref: any, data: any) =>
              ref && typeof ref.update === 'function' ? ref.update(data) : Promise.resolve(undefined)),
            // cutover reconciliation: the ordinary-accrual intake co-write uses txn.create.
            create: jest.fn().mockResolvedValue(undefined),
          })),
        } as any,
      });

      await expect(
        castGeneralDisputeVote(deps, 'gd_test', 'wallet-outsider', ACTING_WALLET, 'upheld'),
      ).rejects.toThrow(/Not a panel member/);
    });
  });

  // =========================================================================
  // getGeneralDispute & listMyGeneralDisputes
  // =========================================================================
  describe('getGeneralDispute', () => {
    it('returns dispute document', async () => {
      const disputeData = makeDisputeData();

      const generalDisputesCol = createMockCollection();
      generalDisputesCol.doc = jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue(createMockDoc(disputeData)),
      });

      const deps = createMockDeps({
        db: {
          collection: jest.fn().mockImplementation((name: string) => {
            if (name === 'general_disputes') return generalDisputesCol;
            return createMockCollection();
          }),

          runTransaction: jest.fn(async (fn: any) => fn({
            // agent directory: route transactional reads/writes through the ref's own mocks
            // so the transactional vote/panel/claim paths observe the same docs
            // the direct reads serve (and .update assertions keep working).
            get: jest.fn((ref: any) =>
              ref && typeof ref.get === 'function'
                ? ref.get()
                : Promise.resolve({ exists: false, data: () => null })),
            set: jest.fn().mockResolvedValue(undefined),
            update: jest.fn((ref: any, data: any) =>
              ref && typeof ref.update === 'function' ? ref.update(data) : Promise.resolve(undefined)),
            // cutover reconciliation: the ordinary-accrual intake co-write uses txn.create.
            create: jest.fn().mockResolvedValue(undefined),
          })),
        } as any,
      });

      const result = await getGeneralDispute(deps, 'gd_test-dispute');
      expect(result.dispute_id).toBe('gd_test-dispute');
    });

    it('throws NotFoundError for missing dispute', async () => {
      const generalDisputesCol = createMockCollection();
      generalDisputesCol.doc = jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue(createMockDoc(null)),
      });

      const deps = createMockDeps({
        db: {
          collection: jest.fn().mockImplementation((name: string) => {
            if (name === 'general_disputes') return generalDisputesCol;
            return createMockCollection();
          }),

          runTransaction: jest.fn(async (fn: any) => fn({
            // agent directory: route transactional reads/writes through the ref's own mocks
            // so the transactional vote/panel/claim paths observe the same docs
            // the direct reads serve (and .update assertions keep working).
            get: jest.fn((ref: any) =>
              ref && typeof ref.get === 'function'
                ? ref.get()
                : Promise.resolve({ exists: false, data: () => null })),
            set: jest.fn().mockResolvedValue(undefined),
            update: jest.fn((ref: any, data: any) =>
              ref && typeof ref.update === 'function' ? ref.update(data) : Promise.resolve(undefined)),
            // cutover reconciliation: the ordinary-accrual intake co-write uses txn.create.
            create: jest.fn().mockResolvedValue(undefined),
          })),
        } as any,
      });

      await expect(getGeneralDispute(deps, 'gd_nonexistent')).rejects.toThrow(/not found/i);
    });
  });

  describe('listMyGeneralDisputes', () => {
    it('returns deduplicated disputes sorted by filed_at', async () => {
      const dispute1 = makeDisputeData({ dispute_id: 'gd_1', filed_at: 1000, filed_by: 'wallet-a', respondent: 'wallet-b' });
      const dispute2 = makeDisputeData({ dispute_id: 'gd_2', filed_at: 2000, filed_by: 'wallet-b', respondent: 'wallet-a' });

      const asComplainant = [createMockDoc(dispute1)];
      const asRespondent = [createMockDoc(dispute2)];

      const generalDisputesCol = createMockCollection();
      let callCount = 0;
      generalDisputesCol.where = jest.fn().mockReturnValue({
        orderBy: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            get: jest.fn().mockImplementation(() => {
              callCount++;
              if (callCount === 1) {
                return Promise.resolve({ docs: asComplainant, empty: false, size: 1 });
              }
              return Promise.resolve({ docs: asRespondent, empty: false, size: 1 });
            }),
          }),
        }),
      });

      const deps = createMockDeps({
        db: {
          collection: jest.fn().mockImplementation((name: string) => {
            if (name === 'general_disputes') return generalDisputesCol;
            return createMockCollection();
          }),

          runTransaction: jest.fn(async (fn: any) => fn({
            // agent directory: route transactional reads/writes through the ref's own mocks
            // so the transactional vote/panel/claim paths observe the same docs
            // the direct reads serve (and .update assertions keep working).
            get: jest.fn((ref: any) =>
              ref && typeof ref.get === 'function'
                ? ref.get()
                : Promise.resolve({ exists: false, data: () => null })),
            set: jest.fn().mockResolvedValue(undefined),
            update: jest.fn((ref: any, data: any) =>
              ref && typeof ref.update === 'function' ? ref.update(data) : Promise.resolve(undefined)),
            // cutover reconciliation: the ordinary-accrual intake co-write uses txn.create.
            create: jest.fn().mockResolvedValue(undefined),
          })),
        } as any,
      });

      const result = await listMyGeneralDisputes(deps, 'wallet-a');
      expect(result).toHaveLength(2);
      expect(result[0].dispute_id).toBe('gd_2'); // newer first
    });
  });

  // =========================================================================
  // processGeneralDisputeDeadlines
  // =========================================================================
  describe('processGeneralDisputeDeadlines', () => {
    it('advances evidence_period to voting when deadline passed', async () => {
      const now = Date.now();
      const expiredDispute = makeDisputeData({
        status: 'evidence_period',
        created_at: now - 72 * 60 * 60 * 1000, // 72h ago
        evidence_deadline: now - 1000, // expired
        panel_wallet_ids: ['arb-1', 'arb-2', 'arb-3'],
      });

      const docRef = {
        update: jest.fn().mockResolvedValue(undefined),
      };
      const docWithRef = {
        ...createMockDoc(expiredDispute),
        ref: docRef,
      };

      const generalDisputesCol = createMockCollection();
      // Mock for each .where().limit().get() call
      let whereCallCount = 0;
      generalDisputesCol.where = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnValue({
          get: jest.fn().mockImplementation(() => {
            whereCallCount++;
            if (whereCallCount === 1) {
              // filed disputes
              return Promise.resolve({ docs: [], empty: true, size: 0 });
            }
            return Promise.resolve({ docs: [], empty: true, size: 0 });
          }),
        }),
        get: jest.fn().mockImplementation(() => {
          // evidence_period or voting queries
          return Promise.resolve({ docs: [docWithRef], empty: false, size: 1 });
        }),
      });

      // Re-mock to handle the three status queries
      let queryCount = 0;
      generalDisputesCol.where = jest.fn().mockImplementation(() => {
        queryCount++;
        const statusQuery = {
          where: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          get: jest.fn().mockResolvedValue({ docs: [], empty: true, size: 0 }),
        };
        if (queryCount === 1) {
          // filed disputes: empty
          return statusQuery;
        } else if (queryCount === 2) {
          // evidence_period: one expired dispute
          return {
            ...statusQuery,
            get: jest.fn().mockResolvedValue({ docs: [docWithRef], empty: false, size: 1 }),
          };
        }
        // voting disputes: empty
        return statusQuery;
      });

      const deps = createMockDeps({
        db: {
          collection: jest.fn().mockImplementation((name: string) => {
            if (name === 'general_disputes') return generalDisputesCol;
            return createMockCollection();
          }),

          runTransaction: jest.fn(async (fn: any) => fn({
            // agent directory: route transactional reads/writes through the ref's own mocks
            // so the transactional vote/panel/claim paths observe the same docs
            // the direct reads serve (and .update assertions keep working).
            get: jest.fn((ref: any) =>
              ref && typeof ref.get === 'function'
                ? ref.get()
                : Promise.resolve({ exists: false, data: () => null })),
            set: jest.fn().mockResolvedValue(undefined),
            update: jest.fn((ref: any, data: any) =>
              ref && typeof ref.update === 'function' ? ref.update(data) : Promise.resolve(undefined)),
            // cutover reconciliation: the ordinary-accrual intake co-write uses txn.create.
            create: jest.fn().mockResolvedValue(undefined),
          })),
        } as any,
      });

      const processed = await processGeneralDisputeDeadlines(deps);

      expect(processed).toBe(1);
      expect(docRef.update).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'voting' }),
      );
    });
  });

  // =========================================================================
  // Spam prevention
  // =========================================================================
  describe('spam prevention', () => {
    // the governance-score filing gate ("< 10 → reject") is REMOVED, so
    // the "rejects wallet with governance score < 10" case is deleted. Spam
    // prevention now rests on the open-dispute cap, exercised below.

    it('max 5 open disputes per wallet enforced', async () => {
      const walletA = makeWalletData();
      const walletB = makeWalletData({ agent_id: 'agent-2' });
      const peData = makePEData();

      const agentWalletsCol = createMockCollection();
      agentWalletsCol.doc = jest.fn().mockImplementation((id: string) => ({
        get: jest.fn().mockResolvedValue(
          createMockDoc(id === 'wallet-a' ? walletA : walletB),
        ),
      }));

      const peHistoryCol = createMockCollection();
      peHistoryCol.doc = jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue(createMockDoc(peData)),
      });

      const fiveOpenDocs = Array(5).fill(null).map(() => createMockDoc(makeDisputeData()));
      const generalDisputesCol = createMockCollection();
      const whereChain = {
        where: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({ docs: fiveOpenDocs, empty: false, size: 5 }),
      };
      generalDisputesCol.where = jest.fn().mockReturnValue(whereChain);

      const deps = createMockDeps({
        db: {
          collection: jest.fn().mockImplementation((name: string) => {
            if (name === 'agent_wallets') return agentWalletsCol;
            if (name === 'meter_act_keys_v1') return peHistoryCol;
            if (name === 'general_disputes') return generalDisputesCol;
            return createMockCollection();
          }),

          runTransaction: jest.fn(async (fn: any) => fn({
            // agent directory: route transactional reads/writes through the ref's own mocks
            // so the transactional vote/panel/claim paths observe the same docs
            // the direct reads serve (and .update assertions keep working).
            get: jest.fn((ref: any) =>
              ref && typeof ref.get === 'function'
                ? ref.get()
                : Promise.resolve({ exists: false, data: () => null })),
            set: jest.fn().mockResolvedValue(undefined),
            update: jest.fn((ref: any, data: any) =>
              ref && typeof ref.update === 'function' ? ref.update(data) : Promise.resolve(undefined)),
            // cutover reconciliation: the ordinary-accrual intake co-write uses txn.create.
            create: jest.fn().mockResolvedValue(undefined),
          })),
        } as any,
      });

      await expect(
        fileGeneralDispute(deps, {
          filedBy: 'wallet-a',
          respondent: 'wallet-b',
          subjectPeIds: ['pe_1'],
          description: 'Test',
          requestedRemedy: 'Refund',
        }),
      ).rejects.toThrow(/Maximum 5 open disputes/);
    });
  });
});
