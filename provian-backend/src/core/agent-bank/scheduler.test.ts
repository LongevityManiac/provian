/**
 * Scheduler - Unit Tests
 *
 * Verifies that processAutoReleases and processDefaults branch on the escrow
 * or promise `currency` field, emit PVT-shaped PE metadata for PVT settlements,
 * emit USDC-shaped PE metadata for USDC settlements, and (auto-release only)
 * call updateWalletStats for both parties in the settlement's currency.
 *
 * Pre-fix behavior: both paths emitted USDC-shaped metadata regardless of the
 * escrow or promise currency, and processAutoReleases did not call
 * updateWalletStats at all. This test suite exists to lock the fix in place.
 */

import admin from 'firebase-admin';
import { processAutoReleases, processDefaults } from './scheduler';
import type { AgentBankDeps, EscrowDocument, PromiseDocument } from './types';

// linked-job settlement: real 64-hex release tx — the receipt-gated linked-job settlement
// validates the hash shape, so the old '0xrel' style fixture would fail closed.
const TX_RELEASE = `0x${'ab'.repeat(32)}`;

// ---------------------------------------------------------------------------
// Mock modules
// ---------------------------------------------------------------------------

const mockGeneratePE = jest.fn().mockResolvedValue({
  peId: 'pe_mock',
  peHash: 'hash_mock',
  prevHash: 'prev_mock',
});

jest.mock('./pe-utils', () => ({
  generateSchedulerPE: (...args: unknown[]) => mockGeneratePE(...args),
  generatePE: (...args: unknown[]) => mockGeneratePE(...args),
}));

const mockUpdateWalletStats = jest.fn().mockResolvedValue(undefined);

jest.mock('./wallet-stats', () => ({
  updateWalletStats: (...args: unknown[]) => mockUpdateWalletStats(...args),
}));

// Pass-3 #17: processAutoReleases now credits + flips status → completed via the
// atomic creditEscrowStatsOnce (escrow.ts) instead of updateWalletStats + a batch
// status flip. Mock it so the auto-release accounting assertions target the credit
// call. Default: reports it credited (returns true) so `processed` counts it.
const mockCreditEscrowStatsOnce = jest.fn().mockResolvedValue(true);
// Emission is gated by a SEPARATE atomic claim (claimCompletionEmission); default
// to "won the claim" so the PE-emission assertions exercise the happy path.
const mockClaimCompletionEmission = jest.fn().mockResolvedValue(true);

jest.mock('./escrow', () => ({
  creditEscrowStatsOnce: (...args: unknown[]) => mockCreditEscrowStatsOnce(...args),
  claimCompletionEmission: (...args: unknown[]) => mockClaimCompletionEmission(...args),
}));

// ---------------------------------------------------------------------------
// Firestore mock helpers
// ---------------------------------------------------------------------------

/**
 * linked-job settlement: linked-job settlement flows through Firestore transactions on the job
 * ref, so the fake doc is now STATEFUL — plain-field patches (via ref.update or
 * tx.update) apply to the held data so later reads see the flip; FieldValue
 * sentinels (arrayUnion/increment) are recorded in `_patches` but not
 * interpreted. Every patch is captured in `_patches` for assertions.
 */
function applyPlainPatch(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v instanceof admin.firestore.FieldValue) continue; // sentinel — not interpreted
    target[k] = v;
  }
}

function makeQueryDoc(id: string, data: unknown) {
  const held = { ...(data as Record<string, unknown>) };
  const patches: Record<string, unknown>[] = [];
  const ref = {
    id,
    _held: held,
    _patches: patches,
    update: jest.fn(async (patch: Record<string, unknown>) => {
      patches.push(patch);
      applyPlainPatch(held, patch);
    }),
    get: jest.fn(async () => ({ exists: true, id, data: () => held })),
  };
  return {
    id,
    ref,
    data: () => held,
    _patches: patches,
  };
}

function makeQuerySnapshot(docs: ReturnType<typeof makeQueryDoc>[]) {
  return { empty: docs.length === 0, size: docs.length, docs };
}

function makeWalletDocGet(walletId: string) {
  const wallets: Record<string, { agent_id: string; address: string }> = {
    wallet_depositor: { agent_id: 'agent_depositor', address: '0xdeposit' },
    wallet_recipient: { agent_id: 'agent_recipient', address: '0xrecipient' },
    wallet_borrower: { agent_id: 'agent_borrower', address: '0xborrower' },
    wallet_lender: { agent_id: 'agent_lender', address: '0xlender' },
  };
  const data = wallets[walletId];
  return {
    exists: true,
    data: () => data,
    id: walletId,
  };
}

function makeDeps(
  docs: ReturnType<typeof makeQueryDoc>[],
  opts: {
    linkedJobs?: ReturnType<typeof makeQueryDoc>[];
    linkedHumanJobs?: ReturnType<typeof makeQueryDoc>[];
    /** When true, the primary collection APPLIES its where() filters (finding 6 control). */
    filterQuery?: boolean;
  } = {},
): AgentBankDeps & { _batch: { update: jest.Mock; commit: jest.Mock } } {
  const batch = {
    update: jest.fn(),
    commit: jest.fn().mockResolvedValue(undefined),
  };

  // Wallet refs carry the wallet id; getAll resolves them, and the
  // per-doc get() serves job-settlement's party reads.
  const walletRef = (id: string) => ({
    id,
    get: jest.fn(async () => makeWalletDocGet(id)),
  });

  const agentWalletsCollection = {
    doc: jest.fn().mockImplementation((id: string) => walletRef(id)),
  };

  // Default: return every seeded doc (the where filter is not modelled). With
  // opts.filterQuery, the accumulated where() clauses are actually applied — so a
  // query like `where('auto_release_at','<=',now)` genuinely excludes future rows.
  const queryClauses: Array<{ field: string; op: string; value: unknown }> = [];
  const primaryCollection: Record<string, unknown> = {
    where: jest.fn((field: string, op: string, value: unknown) => {
      if (opts.filterQuery) queryClauses.push({ field, op, value });
      return primaryCollection;
    }),
    limit: jest.fn(() => primaryCollection),
    get: jest.fn(async () => {
      if (!opts.filterQuery) return makeQuerySnapshot(docs);
      const matched = docs.filter((d) => queryClauses.every((c) => {
        const v = (d.data() as Record<string, unknown>)[c.field] as number;
        switch (c.op) {
          case '==': return v === c.value;
          case '!=': return v !== c.value;
          case '<': return v < (c.value as number);
          case '<=': return v <= (c.value as number);
          case '>': return v > (c.value as number);
          case '>=': return v >= (c.value as number);
          default: return true;
        }
      }));
      return makeQuerySnapshot(matched);
    }),
  };

  // Distinct mocks for `jobs` and `commons_human_jobs` collections so the
  // linked-job lookups don't read back the escrow docs. linked-job settlement: job-settlement
  // queries per-escrow with where('escrow_id','==',id).limit(1), so the fake
  // filters on the actual query value.
  const makeLinkedCollection = (linked: ReturnType<typeof makeQueryDoc>[]) => ({
    where: jest.fn().mockImplementation((field: string, _op: string, value: unknown) => ({
      limit: jest.fn().mockReturnThis(),
      get: jest.fn().mockResolvedValue(
        makeQuerySnapshot(linked.filter((d) => (d.data() as Record<string, unknown>)[field] === value)),
      ),
    })),
  });
  const jobsCollection = makeLinkedCollection(opts.linkedJobs ?? []);
  const commonsHumanJobsCollection = makeLinkedCollection(opts.linkedHumanJobs ?? []);

  const db = {
    batch: jest.fn().mockReturnValue(batch),
    // WS1 idempotency: the credit loop claims stats_credited transactionally.
    // linked-job settlement: job-settlement also runs transactions against the LINKED JOB refs —
    // the fake dispatches tx.get to the ref's own stateful get() when it has
    // one, and applies tx.update patches to the held data so later reads see
    // the flip. Refs without a get() (the escrow claim path) keep reporting
    // 'funded' + uncredited so the claim wins.
    runTransaction: jest.fn(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        get: async (ref: { get?: () => Promise<unknown> }) =>
          typeof ref?.get === 'function'
            ? ref.get()
            : { exists: true, data: () => ({ status: 'funded' }) },
        update: (
          ref: { _held?: Record<string, unknown>; _patches?: Record<string, unknown>[] },
          patch: Record<string, unknown>,
        ) => {
          if (ref?._held && ref?._patches) {
            ref._patches.push(patch);
            applyPlainPatch(ref._held, patch);
          }
        },
        set: jest.fn(),
        create: jest.fn(),
      };
      return fn(tx);
    }),
    collection: jest.fn().mockImplementation((name: string) => {
      if (name === 'agent_wallets') return agentWalletsCollection;
      if (name === 'jobs') return jobsCollection;
      if (name === 'commons_human_jobs') return commonsHumanJobsCollection;
      return primaryCollection;
    }),
    getAll: jest.fn().mockImplementation(async (...refs: Array<{ id: string }>) => {
      return refs.map((ref) => ({
        exists: true,
        id: ref.id,
        data: () => makeWalletDocGet(ref.id).data(),
      }));
    }),
  };

  // WS1: processAutoReleases now performs the real on-chain release via
  // deps.escrowChain before flipping Firestore. Inject a fake that reports a
  // successful release for every escrow so the currency-branching / stats /
  // linked-job assertions below exercise the post-release accounting path.
  // linked-job settlement: the tx hash must be a REAL 64-hex value — it is the settlement
  // receipt the linked-job advancement is gated + deduplicated on.
  const escrowChain = {
    canSign: () => true,
    settle: jest.fn().mockResolvedValue({ status: 'released', txHash: TX_RELEASE, onchainId: '0xid' }),
  };

  return {
    db,
    escrowChain,
    projectId: 'test-project',
    region: 'test-region',
    signerKey: '0xkey',
    _batch: batch,
  } as unknown as AgentBankDeps & { _batch: { update: jest.Mock; commit: jest.Mock } };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseEscrow: Omit<EscrowDocument, 'currency' | 'amount_usdc' | 'fee_usdc' | 'net_to_recipient_usdc'> = {
  escrow_id: 'escrow_test',
  depositor_wallet_id: 'wallet_depositor',
  recipient_wallet_id: 'wallet_recipient',
  depositor_address: '0xdeposit',
  recipient_address: '0xrecipient',
  description: 'test escrow',
  deliverables: 'agent_payment',
  status: 'funded',
  chain: 'base',
  deadline: 0,
  auto_release_at: 0,
  created_at: 0,
  updated_at: 0,
  pe_ids: [],
} as unknown as EscrowDocument;

const basePromise: Omit<PromiseDocument, 'currency' | 'principal_usdc' | 'repay_usdc'> = {
  promise_id: 'promise_test',
  borrower_wallet_id: 'wallet_borrower',
  lender_wallet_id: 'wallet_lender',
  borrower_address: '0xborrower',
  lender_address: '0xlender',
  status: 'funded',
  chain: 'base',
  deadline: 0,
  created_at: 0,
  updated_at: 0,
  pe_ids: [],
} as unknown as PromiseDocument;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockGeneratePE.mockClear();
  mockUpdateWalletStats.mockClear();
  mockCreditEscrowStatsOnce.mockClear();
  mockCreditEscrowStatsOnce.mockResolvedValue(true);
  mockClaimCompletionEmission.mockClear();
  mockClaimCompletionEmission.mockResolvedValue(true);
});

// Finding 6 (audit 2026-08-05) — the scheduler this opens must release a DUE escrow and
// leave a not-yet-due one alone. The gate is the query `auto_release_at <= now`; with the
// filter applied, a future-timeout escrow is excluded and never reaches the chain.
describe('processAutoReleases — due releases, not-yet-due does not (finding 6)', () => {
  function fundedEscrow(id: string, autoReleaseAt: number) {
    return makeQueryDoc(id, {
      ...baseEscrow,
      escrow_id: id,
      status: 'funded',
      auto_release_at: autoReleaseAt,
      currency: 'usdc',
      amount_usdc: '100000000',
      fee_usdc: '500000',
      net_to_recipient_usdc: '99500000',
    });
  }

  it('releases an escrow past auto_release_at but leaves a future-timeout one funded', async () => {
    const now = Date.now();
    const due = fundedEscrow('escrow_due', now - 60_000);
    const future = fundedEscrow('escrow_future', now + 3_600_000);
    const deps = makeDeps([due, future], { filterQuery: true });
    const settleMock = (deps.escrowChain as unknown as { settle: jest.Mock }).settle;

    const processed = await processAutoReleases(deps);

    const settledIds = settleMock.mock.calls.map((c) => (c[0] as { escrow_id: string }).escrow_id);
    expect(settledIds).toEqual(['escrow_due']); // ONLY the due escrow reached the chain
    expect(processed).toBe(1);
  });
});

describe('processAutoReleases - currency branching (F1)', () => {
  it('emits PVT-shaped PE metadata for PVT escrows', async () => {
    const escrow = {
      ...baseEscrow,
      currency: 'pvt' as const,
      amount_pvt: '100000000000000000000',           // 100 PVT
      fee_pvt: '500000000000000000',                  // 0.5 PVT
      net_to_recipient_pvt: '99500000000000000000',   // 99.5 PVT
    };
    const deps = makeDeps([makeQueryDoc('escrow_test', escrow)]);

    const processed = await processAutoReleases(deps);

    expect(processed).toBe(1);
    expect(mockGeneratePE).toHaveBeenCalledTimes(2);

    const [depositorCall, recipientCall] = mockGeneratePE.mock.calls;
    const depositorMeta = depositorCall[1].metadata;
    const recipientMeta = recipientCall[1].metadata;

    expect(depositorMeta.currency).toBe('pvt');
    expect(depositorMeta.amount_pvt).toBe('100000000000000000000');
    expect(depositorMeta.fee_pvt).toBe('500000000000000000');
    expect(depositorMeta.amount_usdc).toBeUndefined();
    expect(depositorMeta.role).toBe('depositor');
    expect(depositorMeta.auto_released).toBe(true);

    expect(recipientMeta.currency).toBe('pvt');
    expect(recipientMeta.amount_pvt).toBe('100000000000000000000');
    expect(recipientMeta.net_to_recipient_pvt).toBe('99500000000000000000');
    expect(recipientMeta.fee_pvt).toBe('500000000000000000');
    expect(recipientMeta.amount_usdc).toBeUndefined();
    expect(recipientMeta.net_to_recipient_usdc).toBeUndefined();
    expect(recipientMeta.role).toBe('recipient');
  });

  it('emits USDC-shaped PE metadata for USDC escrows', async () => {
    const escrow = {
      ...baseEscrow,
      currency: 'usdc' as const,
      amount_usdc: 100,
      fee_usdc: 0.5,
      net_to_recipient_usdc: 99.5,
    };
    const deps = makeDeps([makeQueryDoc('escrow_test', escrow)]);

    await processAutoReleases(deps);

    const [depositorCall, recipientCall] = mockGeneratePE.mock.calls;
    const depositorMeta = depositorCall[1].metadata;
    const recipientMeta = recipientCall[1].metadata;

    expect(depositorMeta.currency).toBe('usdc');
    expect(depositorMeta.amount_usdc).toBe(100);
    expect(depositorMeta.fee_usdc).toBe(0.5);
    expect(depositorMeta.amount_pvt).toBeUndefined();

    expect(recipientMeta.amount_usdc).toBe(100);
    expect(recipientMeta.net_to_recipient_usdc).toBe(99.5);
    expect(recipientMeta.amount_pvt).toBeUndefined();
    expect(recipientMeta.net_to_recipient_pvt).toBeUndefined();
  });

  it('defaults to USDC when currency is undefined (legacy docs)', async () => {
    const escrow = {
      ...baseEscrow,
      amount_usdc: 50,
      fee_usdc: 0.25,
      net_to_recipient_usdc: 49.75,
    } as unknown as EscrowDocument;
    const deps = makeDeps([makeQueryDoc('escrow_test', escrow)]);

    await processAutoReleases(deps);

    const [depositorCall] = mockGeneratePE.mock.calls;
    expect(depositorCall[1].metadata.currency).toBe('usdc');
    expect(depositorCall[1].metadata.amount_usdc).toBe(50);
  });
});

describe('processAutoReleases - atomic credit + status flip (F2 / Pass-3 #17)', () => {
  // The credit + status→completed flip now run in ONE atomic call
  // (creditEscrowStatsOnce), not the old updateWalletStats + a separate batch
  // status flip. This test verifies the atomic credit is invoked (with the escrow
  // + the status-flip metadata folded in) and that the legacy path is gone. The
  // currency/amount routing itself is covered in escrow.disputeResolve.test.ts.
  it('credits via creditEscrowStatsOnce (not updateWalletStats) for a PVT auto-release', async () => {
    const escrow = {
      ...baseEscrow,
      currency: 'pvt' as const,
      amount_pvt: '100000000000000000000',
      fee_pvt: '500000000000000000',
      net_to_recipient_pvt: '99500000000000000000',
    };
    const deps = makeDeps([makeQueryDoc('escrow_test', escrow)]);

    const processed = await processAutoReleases(deps);

    expect(processed).toBe(1);
    expect(mockUpdateWalletStats).not.toHaveBeenCalled();
    expect(mockCreditEscrowStatsOnce).toHaveBeenCalledTimes(1);
    const call = mockCreditEscrowStatsOnce.mock.calls[0];
    const escrowArg = call[2] as EscrowDocument;
    const extraUpdate = call[4] as Record<string, unknown>;
    expect(escrowArg.escrow_id).toBe('escrow_test');
    expect(escrowArg.currency).toBe('pvt');
    // The status flip + settle metadata are folded into the SAME credit txn so a
    // crash before crediting leaves status='funded' for the next tick to retry.
    expect(extraUpdate).toMatchObject({ status: 'completed', auto_released: true });
    expect(extraUpdate.release_tx_hash).toBe(TX_RELEASE);
  });

  it('credits via creditEscrowStatsOnce (not updateWalletStats) for a USDC auto-release', async () => {
    const escrow = {
      ...baseEscrow,
      currency: 'usdc' as const,
      amount_usdc: 100,
      fee_usdc: 0.5,
      net_to_recipient_usdc: 99.5,
    };
    const deps = makeDeps([makeQueryDoc('escrow_test', escrow)]);

    const processed = await processAutoReleases(deps);

    expect(processed).toBe(1);
    expect(mockUpdateWalletStats).not.toHaveBeenCalled();
    expect(mockCreditEscrowStatsOnce).toHaveBeenCalledTimes(1);
    const escrowArg = mockCreditEscrowStatsOnce.mock.calls[0][2] as EscrowDocument;
    expect(escrowArg.currency).toBe('usdc');
    expect(escrowArg.amount_usdc).toBe(100);
  });

  it('does NOT count OR emit PEs when the escrow was already fully settled by another path (dedup)', async () => {
    // A concurrent completeEscrow (or overlapping tick) already credited AND emitted
    // → creditEscrowStatsOnce AND claimCompletionEmission both return false → the
    // scheduler must NOT double-count AND must NOT emit duplicate escrow_completed PEs.
    mockCreditEscrowStatsOnce.mockResolvedValue(false);
    mockClaimCompletionEmission.mockResolvedValue(false);
    const escrow = {
      ...baseEscrow,
      currency: 'usdc' as const,
      amount_usdc: 100,
      fee_usdc: 0.5,
      net_to_recipient_usdc: 99.5,
    };
    const deps = makeDeps([makeQueryDoc('escrow_test', escrow)]);

    const processed = await processAutoReleases(deps);

    expect(processed).toBe(0);
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('emits (recovers) the completion PEs even when the credit was already done by another path', async () => {
    // Credit done elsewhere (crash after credit before PE), but emission still
    // unclaimed → the scheduler wins the emission claim and RECOVERS the PEs, even
    // though it did not perform the credit (processed stays 0 — it did not credit).
    mockCreditEscrowStatsOnce.mockResolvedValue(false);
    mockClaimCompletionEmission.mockResolvedValue(true);
    const escrow = {
      ...baseEscrow,
      currency: 'usdc' as const,
      amount_usdc: 100,
      fee_usdc: 0.5,
      net_to_recipient_usdc: 99.5,
    };
    const deps = makeDeps([makeQueryDoc('escrow_test', escrow)]);

    const processed = await processAutoReleases(deps);

    expect(processed).toBe(0);
    expect(mockGeneratePE).toHaveBeenCalledTimes(2);
  });
});

describe('processDefaults — relay-observed default sweep ', () => {
  // The sweep was UN-retired: the design requires BOTH default paths. `processDefaults`
  // now flips a funded promise past its deadline to `defaulted (relay_observed)`
  // (no lender action, no PE) so reputation reflects it at once; a lender's
  // on-chain markDefault later UPGRADES it to onchain_proven. The full behavioral
  // coverage — the flip, the outbox rows, the "no PE", and the Unknown=Block skip —
  // lives in `scheduler.promise-default.test.ts` (rich fake with real transactions).
  // Here, only the empty-population early return, which this hand-rolled harness
  // models cleanly.
  it('no funded promises past deadline ⇒ 0 (empty-population early return)', async () => {
    const deps = makeDeps([]);
    const processed = await processDefaults(deps);
    expect(processed).toBe(0);
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });
});

describe('processAutoReleases - linked job advancement (linked-job settlement receipt-gated)', () => {
  it('advances a linked /v1/jobs doc through the guarded settlement path with the release receipt', async () => {
    const escrow = {
      ...baseEscrow,
      currency: 'usdc' as const,
      amount_usdc: 100,
      fee_usdc: 0.5,
      net_to_recipient_usdc: 99.5,
    };
    const escrowDoc = makeQueryDoc('escrow_test', escrow);
    const linkedJobDoc = makeQueryDoc('job_linked', {
      job_id: 'job_linked',
      escrow_id: 'escrow_test',
      status: 'delivered',
    });
    const deps = makeDeps([escrowDoc], { linkedJobs: [linkedJobDoc] });

    await processAutoReleases(deps);

    // The job terminated off the release receipt: status flipped in the
    // guarded transaction, anchored to the settlement tx hash.
    const job = linkedJobDoc.data() as Record<string, unknown>;
    expect(job.status).toBe('completed');
    expect(job.completed_at as number).toBeGreaterThan(0);
    expect(job.settlement_tx_hash).toBe(TX_RELEASE);
    // ...and the dual-party job_completed settlement PEs were emitted once.
    const jobPeCalls = mockGeneratePE.mock.calls.filter(
      (c) => (c[1] as { actionType?: string })?.actionType === 'job_completed',
    );
    expect(jobPeCalls).toHaveLength(2);
    expect(jobPeCalls.map((c) => (c[1] as { walletId: string }).walletId).sort()).toEqual(
      ['wallet_depositor', 'wallet_recipient'].sort(),
    );
    const meta = (jobPeCalls[0][1] as { metadata: Record<string, unknown> }).metadata;
    expect(meta.tx_hash).toBe(TX_RELEASE);
    expect(meta.escrow_id).toBe('escrow_test');
    // The escrow's own flip still rides the atomic credit (#17), unchanged.
    const extraUpdate = mockCreditEscrowStatsOnce.mock.calls[0][4] as Record<string, unknown>;
    expect(extraUpdate).toMatchObject({ status: 'completed', auto_released: true });
  });

  it('performs no settlement writes when no job/human-job document is linked', async () => {
    const escrow = {
      ...baseEscrow,
      currency: 'usdc' as const,
      amount_usdc: 50,
      fee_usdc: 0.25,
      net_to_recipient_usdc: 49.75,
    };
    const escrowDoc = makeQueryDoc('escrow_test', escrow);
    const deps = makeDeps([escrowDoc]); // no linked jobs

    await processAutoReleases(deps);

    expect(
      mockGeneratePE.mock.calls.filter(
        (c) => (c[1] as { actionType?: string })?.actionType === 'job_completed',
      ),
    ).toHaveLength(0);
    // The escrow status flip happened via the atomic credit as before.
    expect(mockCreditEscrowStatsOnce).toHaveBeenCalledTimes(1);
  });

  it('advances a linked Commons human-job with payment truth (payment_released, no updated_at)', async () => {
    const escrow = {
      ...baseEscrow,
      currency: 'pvt' as const,
      amount_pvt: '5000000000000000000',
      fee_pvt: '25000000000000000',
      net_to_recipient_pvt: '4975000000000000000',
    };
    const escrowDoc = makeQueryDoc('escrow_test', escrow);
    const linkedHumanJobDoc = makeQueryDoc('hjob_linked', {
      job_id: 'hjob_linked',
      escrow_id: 'escrow_test',
      status: 'in_progress',
      accepted_applicant_wallet_id: 'wallet_recipient',
    });
    const deps = makeDeps([escrowDoc], { linkedHumanJobs: [linkedHumanJobDoc] });

    await processAutoReleases(deps);

    const job = linkedHumanJobDoc.data() as Record<string, unknown>;
    expect(job.status).toBe('completed');
    expect(job.completed_at as number).toBeGreaterThan(0);
    expect(job.payment_released).toBe(true);
    expect(job.payment_release_pending).toBe(false);
    expect(job.settlement_tx_hash).toBe(TX_RELEASE);
    // commons_human_jobs has no updated_at field; NO patch may set one.
    for (const patch of linkedHumanJobDoc._patches) {
      expect(patch.updated_at).toBeUndefined();
    }
    // Dual-party settlement PEs use the Commons settlement action type.
    const hjPeCalls = mockGeneratePE.mock.calls.filter(
      (c) => (c[1] as { actionType?: string })?.actionType === 'human_job_payment_released',
    );
    expect(hjPeCalls).toHaveLength(2);
  });

  it('advances both an agent-to-agent job AND a human-job linked in the same release batch', async () => {
    const escrow1 = {
      ...baseEscrow,
      escrow_id: 'escrow_one',
      currency: 'usdc' as const,
      amount_usdc: 10,
      fee_usdc: 0.05,
      net_to_recipient_usdc: 9.95,
    };
    const escrow2 = {
      ...baseEscrow,
      escrow_id: 'escrow_two',
      currency: 'usdc' as const,
      amount_usdc: 20,
      fee_usdc: 0.1,
      net_to_recipient_usdc: 19.9,
    };
    const linkedAgentJob = makeQueryDoc('job_agent', {
      job_id: 'job_agent',
      escrow_id: 'escrow_one',
      status: 'delivered',
    });
    const linkedHumanJob = makeQueryDoc('hjob_human', {
      job_id: 'hjob_human',
      escrow_id: 'escrow_two',
      status: 'in_progress',
    });
    const deps = makeDeps(
      [makeQueryDoc('escrow_one', escrow1), makeQueryDoc('escrow_two', escrow2)],
      { linkedJobs: [linkedAgentJob], linkedHumanJobs: [linkedHumanJob] },
    );

    await processAutoReleases(deps);

    expect((linkedAgentJob.data() as Record<string, unknown>).status).toBe('completed');
    expect((linkedHumanJob.data() as Record<string, unknown>).status).toBe('completed');
  });

  it('FAILS CLOSED: a release with no recoverable tx hash leaves the job un-advanced for retry', async () => {
    const escrow = {
      ...baseEscrow,
      currency: 'usdc' as const,
      amount_usdc: 100,
      fee_usdc: 0.5,
      net_to_recipient_usdc: 99.5,
    };
    const escrowDoc = makeQueryDoc('escrow_test', escrow);
    const linkedJobDoc = makeQueryDoc('job_linked', {
      job_id: 'job_linked',
      escrow_id: 'escrow_test',
      status: 'delivered',
    });
    const deps = makeDeps([escrowDoc], { linkedJobs: [linkedJobDoc] });
    // Observe path that could not recover the release event's tx hash, and no
    // previously recorded release_tx_hash on the escrow doc.
    (deps.escrowChain!.settle as jest.Mock).mockResolvedValue({
      status: 'already_released',
      onchainId: '0xid',
    });

    await processAutoReleases(deps);

    const job = linkedJobDoc.data() as Record<string, unknown>;
    expect(job.status).toBe('delivered'); // un-advanced — no evidence, no record
    expect(job.settlement_tx_hash).toBeUndefined();
    expect(
      mockGeneratePE.mock.calls.filter(
        (c) => (c[1] as { actionType?: string })?.actionType === 'job_completed',
      ),
    ).toHaveLength(0);
  });

  it('IDEMPOTENT: a second tick with the same release tx records no duplicate job_completed PEs', async () => {
    const escrow = {
      ...baseEscrow,
      currency: 'usdc' as const,
      amount_usdc: 100,
      fee_usdc: 0.5,
      net_to_recipient_usdc: 99.5,
    };
    const escrowDoc = makeQueryDoc('escrow_test', escrow);
    // The job already settled off TX_RELEASE on a prior tick.
    const linkedJobDoc = makeQueryDoc('job_linked', {
      job_id: 'job_linked',
      escrow_id: 'escrow_test',
      status: 'completed',
      completed_at: 123,
      settlement_tx_hash: TX_RELEASE,
      settlement_tx_hashes: [TX_RELEASE],
      settlement_pe_ids: ['pe_prior_a', 'pe_prior_b'],
      settlement_pe_claimed: true,
    });
    const deps = makeDeps([escrowDoc], { linkedJobs: [linkedJobDoc] });

    await processAutoReleases(deps);

    const job = linkedJobDoc.data() as Record<string, unknown>;
    expect(job.status).toBe('completed');
    expect(job.settlement_pe_ids).toEqual(['pe_prior_a', 'pe_prior_b']); // unchanged
    expect(
      mockGeneratePE.mock.calls.filter(
        (c) => (c[1] as { actionType?: string })?.actionType === 'job_completed',
      ),
    ).toHaveLength(0);
  });
});
