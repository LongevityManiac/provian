/**
 * completeEscrow - linked /v1/jobs + Commons human-job advancement.
 *
 * linked-job settlement: when an escrow with a linked job document is completed, the job is
 * advanced through the RECEIPT-GATED settlement path (job-settlement.ts →
 * evaluateInstitutionTransition): the flip happens in a guarded transaction
 * anchored to the on-chain release tx hash, dual-party settlement PEs are
 * emitted once, and a missing receipt hash fails closed (job left un-advanced
 * for retry). Mirrors the auto-release tests in scheduler.test.ts so the two
 * release paths produce the same end state.
 */

import admin from 'firebase-admin';
import { completeEscrow } from './escrow';
import { emitBackendCorroboration, resolveTargetPeHash } from '../corroboration/CorroborationManager';
import type { AgentBankDeps, EscrowDocument, EscrowSettleResult } from './types';

const mockEmitCorroboration = emitBackendCorroboration as jest.Mock;
const mockResolveTargetPeHash = resolveTargetPeHash as jest.Mock;

/** Flush the fire-and-forget corroboration IIFE scheduled by completeEscrow. */
const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// linked-job settlement: real 64-hex release tx — the receipt-gated settlement validates the
// hash shape, so the old '0xrelease' style fixtures would fail closed.
const TX_RELEASE = `0x${'cd'.repeat(32)}`;

const mockGeneratePE = jest.fn().mockResolvedValue({
  peId: 'pe_mock',
  peHash: 'hash_mock',
  prevHash: 'prev_mock',
});

jest.mock('./pe-utils', () => ({
  generatePE: (...args: unknown[]) => mockGeneratePE(...args),
  generateSchedulerPE: (...args: unknown[]) => mockGeneratePE(...args),
}));

const mockUpdateWalletStats = jest.fn().mockResolvedValue(undefined);

jest.mock('./wallet-stats', () => ({
  updateWalletStats: (...args: unknown[]) => mockUpdateWalletStats(...args),
}));

jest.mock('../corroboration/CorroborationManager', () => ({
  emitBackendCorroboration: jest.fn(),
  // Pass-2 #5: completeEscrow now resolves the REAL target PE hash before
  // emitting corroboration. Return a non-empty hash so the emit fires.
  resolveTargetPeHash: jest.fn().mockResolvedValue('hash_escrow_created'),
}));

const baseEscrow: EscrowDocument = {
  escrow_id: 'escrow_test',
  depositor_wallet_id: 'wallet_depositor',
  recipient_wallet_id: 'wallet_recipient',
  depositor_address: '0xdeposit',
  recipient_address: '0xrecipient',
  description: 'test escrow',
  deliverables: 'agent_payment',
  status: 'funded',
  chain: 'base',
  currency: 'usdc',
  amount_usdc: 100,
  fee_usdc: 0.5,
  net_to_recipient_usdc: 99.5,
  deadline: 0,
  auto_release_at: 0,
  created_at: 0,
  updated_at: 0,
  pe_ids: ['pe_escrow_created'],
} as unknown as EscrowDocument;

/** Apply plain-field patches; FieldValue sentinels are recorded, not interpreted. */
function applyPlainPatch(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v instanceof admin.firestore.FieldValue) continue;
    target[k] = v;
  }
}

/** Stateful linked-job doc: guarded settlement transactions read + flip it. */
function makeJobDoc(id: string, data: Record<string, unknown>) {
  const held = { ...data };
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
  return { id, ref, data: () => held, _patches: patches };
}

function makeDeps(opts: {
  escrow?: Partial<EscrowDocument>;
  linkedJob?: ReturnType<typeof makeJobDoc>;
  linkedHumanJob?: ReturnType<typeof makeJobDoc>;
  settleResult?: EscrowSettleResult;
} = {}): {
  deps: AgentBankDeps;
  txUpdates: Array<[unknown, Record<string, unknown>]>;
  escrowRef: { update: jest.Mock };
} {
  const escrowData = { ...baseEscrow, ...(opts.escrow ?? {}) };
  const escrowDocSnapshot = {
    exists: true,
    data: () => escrowData,
  };
  const escrowRef = {
    update: jest.fn(),
    get: jest.fn().mockResolvedValue(escrowDocSnapshot),
  };

  const escrowCollection = {
    doc: jest.fn().mockReturnValue(escrowRef),
  };

  const linkedSnapshot = (doc?: ReturnType<typeof makeJobDoc>) =>
    doc ? { empty: false, docs: [doc] } : { empty: true, docs: [] };

  const jobsCollection = {
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    get: jest.fn().mockResolvedValue(linkedSnapshot(opts.linkedJob)),
  };
  const commonsHumanJobsCollection = {
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    get: jest.fn().mockResolvedValue(linkedSnapshot(opts.linkedHumanJob)),
  };

  const walletDoc = (id: string) => ({
    get: jest.fn().mockResolvedValue({
      exists: true,
      data: () => ({
        agent_id: id === 'wallet_depositor' ? 'agent_depositor' : 'agent_recipient',
        address: id === 'wallet_depositor' ? '0xdeposit' : '0xrecipient',
      }),
    }),
  });

  const agentWalletsCollection = {
    doc: jest.fn().mockImplementation(walletDoc),
  };

  const commonsProfilesCollection = {
    doc: jest.fn().mockImplementation(() => ({})),
  };

  // The escrow claim txn keeps its historical static behavior (tx.get on the
  // escrow ref reports 'funded' so the claim wins; updates are captured in
  // txUpdates). linked-job settlement: job-settlement transactions dispatch to the STATEFUL job
  // refs — reads see the held data, plain-field updates apply to it.
  const txUpdates: Array<[unknown, Record<string, unknown>]> = [];
  const runTransaction = jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      get: async (ref: unknown) => {
        if (ref === escrowRef) return escrowDocSnapshot;
        const r = ref as { get?: () => Promise<unknown> };
        return typeof r?.get === 'function' ? r.get() : { exists: false, data: () => undefined };
      },
      update: (ref: unknown, data: Record<string, unknown>) => {
        txUpdates.push([ref, data]);
        const r = ref as { _held?: Record<string, unknown>; _patches?: Record<string, unknown>[] };
        if (r?._held && r?._patches) {
          r._patches.push(data);
          applyPlainPatch(r._held, data);
        }
      },
      set: jest.fn(),
      create: jest.fn(),
    };
    return fn(tx);
  });

  const db = {
    batch: jest.fn().mockReturnValue({ update: jest.fn(), commit: jest.fn() }),
    runTransaction,
    collection: jest.fn().mockImplementation((name: string) => {
      if (name === 'escrows') return escrowCollection;
      if (name === 'jobs') return jobsCollection;
      if (name === 'commons_human_jobs') return commonsHumanJobsCollection;
      if (name === 'agent_wallets') return agentWalletsCollection;
      if (name === 'commons_profiles') return commonsProfilesCollection;
      throw new Error(`Unexpected collection lookup: ${name}`);
    }),
  };

  // WS1: completeEscrow requires a real on-chain release before flipping
  // Firestore. Inject a fake escrowChain; default to a successful release.
  const escrowChain = {
    canSign: () => true,
    settle: jest.fn().mockResolvedValue(
      opts.settleResult ?? { status: 'released', txHash: TX_RELEASE, onchainId: '0xonchainid' },
    ),
  };

  return {
    deps: { db, escrowChain, projectId: 'test', region: 'test', signerKey: '0xkey' } as unknown as AgentBankDeps,
    txUpdates,
    escrowRef,
  };
}

const jobPeCalls = (actionType: string) =>
  mockGeneratePE.mock.calls.filter(
    (c) => (c[1] as { actionType?: string })?.actionType === actionType,
  );

beforeEach(() => {
  mockGeneratePE.mockClear();
  mockUpdateWalletStats.mockClear();
  mockEmitCorroboration.mockClear();
  mockResolveTargetPeHash.mockClear();
  mockResolveTargetPeHash.mockResolvedValue('hash_escrow_created');
});

describe('completeEscrow - corroboration emits with a REAL target hash (Pass-2 #5)', () => {
  it('resolves the escrow_created PE hash and passes it (never the empty string)', async () => {
    const { deps } = makeDeps();

    await completeEscrow(deps, 'escrow_test', 'wallet_depositor');
    await flushMicrotasks();

    // The emit site fetched the real hash for the FIRST pe_id (escrow_created).
    expect(mockResolveTargetPeHash).toHaveBeenCalledWith(deps, 'pe_escrow_created');
    // ...and forwarded it to the corroboration manager. Pre-fix this was '',
    // which the manager falsy-guard rejected, so the signal never fired.
    expect(mockEmitCorroboration).toHaveBeenCalledTimes(1);
    expect(mockEmitCorroboration).toHaveBeenCalledWith(
      deps,
      expect.objectContaining({
        targetPeId: 'pe_escrow_created',
        targetPeHash: 'hash_escrow_created',
        signalType: 'escrow_completed',
      }),
    );
    const emitArg = mockEmitCorroboration.mock.calls[0][1] as { targetPeHash: string };
    expect(emitArg.targetPeHash).not.toBe('');
  });

  it('skips the signal (no suppression of a valid one) when the target hash is genuinely missing', async () => {
    const { deps } = makeDeps();
    mockResolveTargetPeHash.mockResolvedValue(''); // target/hash genuinely absent

    await completeEscrow(deps, 'escrow_test', 'wallet_depositor');
    await flushMicrotasks();

    expect(mockResolveTargetPeHash).toHaveBeenCalledWith(deps, 'pe_escrow_created');
    expect(mockEmitCorroboration).not.toHaveBeenCalled();
  });
});

describe('completeEscrow - linked job advancement (linked-job settlement receipt-gated)', () => {
  it('flips the escrow (claim txn) and settles a linked job through the guarded path', async () => {
    const linkedJob = makeJobDoc('job_linked', {
      job_id: 'job_linked',
      escrow_id: 'escrow_test',
      status: 'delivered',
    });
    const { deps, txUpdates, escrowRef } = makeDeps({ linkedJob });

    await completeEscrow(deps, 'escrow_test', 'wallet_depositor');

    // Pass-3 #17: the claim txn flips status WITHOUT stats_credited; the credit +
    // stats_credited marker are a SEPARATE atomic txn that runs AFTER the PEs.
    const escrowUpdates = txUpdates.filter((c) => c[0] === escrowRef);
    const flip = escrowUpdates.find((c) => c[1].status === 'completed');
    expect(flip?.[1]).toMatchObject({ status: 'completed' });
    expect(flip?.[1].completed_at as number).toBeGreaterThan(0);
    expect(escrowUpdates.some((c) => c[1].stats_credited === true)).toBe(true);

    // linked-job settlement: the linked job terminated off the release receipt in the guarded txn.
    const job = linkedJob.data() as Record<string, unknown>;
    expect(job.status).toBe('completed');
    expect(job.completed_at as number).toBeGreaterThan(0);
    expect(job.settlement_tx_hash).toBe(TX_RELEASE);
    // Dual-party job_completed settlement PEs, receipt-linked.
    const calls = jobPeCalls('job_completed');
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => (c[1] as { walletId: string }).walletId).sort()).toEqual(
      ['wallet_depositor', 'wallet_recipient'].sort(),
    );
    expect((calls[0][1] as { metadata: Record<string, unknown> }).metadata.tx_hash).toBe(TX_RELEASE);
  });

  it('only flips the escrow when no job document is linked', async () => {
    const { deps, txUpdates, escrowRef } = makeDeps();

    await completeEscrow(deps, 'escrow_test', 'wallet_depositor');

    expect(txUpdates.find((c) => c[0] === escrowRef)?.[1]).toMatchObject({ status: 'completed' });
    expect(jobPeCalls('job_completed')).toHaveLength(0);
    expect(jobPeCalls('human_job_payment_released')).toHaveLength(0);
  });

  it('settles a linked Commons human-job with payment truth (payment_released, no updated_at)', async () => {
    const linkedHumanJob = makeJobDoc('hjob_linked', {
      job_id: 'hjob_linked',
      escrow_id: 'escrow_test',
      status: 'in_progress',
    });
    const { deps, txUpdates, escrowRef } = makeDeps({ linkedHumanJob });

    await completeEscrow(deps, 'escrow_test', 'wallet_depositor');

    expect(txUpdates.find((c) => c[0] === escrowRef)?.[1]).toMatchObject({ status: 'completed' });
    const job = linkedHumanJob.data() as Record<string, unknown>;
    expect(job.status).toBe('completed');
    expect(job.completed_at as number).toBeGreaterThan(0);
    expect(job.payment_released).toBe(true);
    expect(job.payment_release_pending).toBe(false);
    expect(job.settlement_tx_hash).toBe(TX_RELEASE);
    // commons_human_jobs has no updated_at field; NO patch may set one.
    for (const patch of linkedHumanJob._patches) {
      expect(patch.updated_at).toBeUndefined();
    }
    expect(jobPeCalls('human_job_payment_released')).toHaveLength(2);
  });

  it('settles both an agent-to-agent job and a human-job linked to the same escrow', async () => {
    const linkedJob = makeJobDoc('job_linked', {
      job_id: 'job_linked',
      escrow_id: 'escrow_test',
      status: 'delivered',
    });
    const linkedHumanJob = makeJobDoc('hjob_linked', {
      job_id: 'hjob_linked',
      escrow_id: 'escrow_test',
      status: 'in_progress',
    });
    const { deps } = makeDeps({ linkedJob, linkedHumanJob });

    await completeEscrow(deps, 'escrow_test', 'wallet_depositor');

    expect((linkedJob.data() as Record<string, unknown>).status).toBe('completed');
    expect((linkedHumanJob.data() as Record<string, unknown>).status).toBe('completed');
    expect(jobPeCalls('job_completed')).toHaveLength(2);
    expect(jobPeCalls('human_job_payment_released')).toHaveLength(2);
  });

  it('does NOT double-credit when the escrow was already settled (claim lost)', async () => {
    const { deps } = makeDeps();
    // Simulate another path having already credited: tx.get returns stats_credited.
    (deps.db as unknown as { runTransaction: jest.Mock }).runTransaction = jest.fn(
      async (fn: (tx: unknown) => Promise<void>) => {
        const tx = {
          get: async () => ({ exists: true, data: () => ({ ...baseEscrow, status: 'completed', stats_credited: true }) }),
          update: jest.fn(),
          set: jest.fn(),
          create: jest.fn(),
        };
        return fn(tx);
      },
    );

    await completeEscrow(deps, 'escrow_test', 'wallet_depositor');

    // Claim lost -> early return: no settlement PEs, no stat credits.
    expect(mockGeneratePE).not.toHaveBeenCalled();
    expect(mockUpdateWalletStats).not.toHaveBeenCalled();
  });

  it('REPAIR: an escrow already completed re-settles a stranded linked job off its recorded receipt', async () => {
    // Crash-shaped state: the escrow flipped 'completed' with its release tx
    // recorded, but the linked job was never advanced.
    const linkedJob = makeJobDoc('job_linked', {
      job_id: 'job_linked',
      escrow_id: 'escrow_test',
      status: 'delivered',
    });
    const { deps } = makeDeps({
      linkedJob,
      escrow: {
        status: 'completed',
        release_tx_hash: TX_RELEASE,
        completion_pe_ids: ['pe_done_a', 'pe_done_b'],
        stats_credited: true,
      } as Partial<EscrowDocument>,
    });

    await completeEscrow(deps, 'escrow_test', 'wallet_depositor');

    const job = linkedJob.data() as Record<string, unknown>;
    expect(job.status).toBe('completed');
    expect(job.settlement_tx_hash).toBe(TX_RELEASE);
    expect(jobPeCalls('job_completed')).toHaveLength(2);
  });

  it('FAILS CLOSED: already_released with no recoverable tx hash leaves the job un-advanced', async () => {
    const linkedJob = makeJobDoc('job_linked', {
      job_id: 'job_linked',
      escrow_id: 'escrow_test',
      status: 'delivered',
    });
    const { deps, txUpdates, escrowRef } = makeDeps({
      linkedJob,
      settleResult: { status: 'already_released', onchainId: '0xoid' },
    });

    await completeEscrow(deps, 'escrow_test', 'wallet_depositor');

    // The escrow record still completes (unchanged WS1 contract)...
    expect(txUpdates.find((c) => c[0] === escrowRef)?.[1]).toMatchObject({ status: 'completed' });
    // ...but the job records nothing without settlement evidence.
    const job = linkedJob.data() as Record<string, unknown>;
    expect(job.status).toBe('delivered');
    expect(job.settlement_tx_hash).toBeUndefined();
    expect(jobPeCalls('job_completed')).toHaveLength(0);
  });
});

describe('completeEscrow - on-chain release truthfulness (WS1)', () => {
  it('records the release tx hash on the escrow when the gas-EOA released', async () => {
    const { deps, txUpdates, escrowRef } = makeDeps({
      settleResult: { status: 'released', txHash: TX_RELEASE, onchainId: '0xoid' },
    });

    const result = await completeEscrow(deps, 'escrow_test', 'wallet_depositor');

    const escrowUpdates = txUpdates.filter((c) => c[0] === escrowRef);
    // The claim txn records the verified on-chain release fields...
    expect(
      escrowUpdates.some(
        (c) => c[1].status === 'completed' && c[1].release_tx_hash === TX_RELEASE && c[1].onchain_escrow_id === '0xoid',
      ),
    ).toBe(true);
    // ...and stats_credited is set in the separate atomic credit txn (#17).
    expect(escrowUpdates.some((c) => c[1].stats_credited === true)).toBe(true);
    expect(result.release_tx_hash).toBe(TX_RELEASE);
  });

  it('records when the depositor already released on-chain (already_released)', async () => {
    const { deps, txUpdates, escrowRef } = makeDeps({
      settleResult: { status: 'already_released', txHash: TX_RELEASE, onchainId: '0xoid' },
    });

    const result = await completeEscrow(deps, 'escrow_test', 'wallet_depositor');

    expect(result.status).toBe('completed');
    const escrowUpdates = txUpdates.filter((c) => c[0] === escrowRef);
    expect(escrowUpdates.some((c) => c[1].status === 'completed')).toBe(true);
    expect(escrowUpdates.some((c) => c[1].stats_credited === true)).toBe(true);
  });

  it('refuses (throws) and does NOT mark completed when funds are not yet released (pre-timeout)', async () => {
    const { deps, txUpdates } = makeDeps({ settleResult: { status: 'pending_pre_timeout' } });

    await expect(completeEscrow(deps, 'escrow_test', 'wallet_depositor')).rejects.toThrow(
      /not yet released on-chain/i,
    );
    // Truthful: no Firestore flip, no settlement PEs when funds are still locked.
    expect(txUpdates).toHaveLength(0);
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('refuses when the release signer is unconfigured', async () => {
    const { deps, txUpdates } = makeDeps({ settleResult: { status: 'unconfigured' } });

    await expect(completeEscrow(deps, 'escrow_test', 'wallet_depositor')).rejects.toThrow(
      /release signer unconfigured|temporarily unavailable/i,
    );
    expect(txUpdates).toHaveLength(0);
  });

  it('refuses when the on-chain release fails', async () => {
    const { deps, txUpdates } = makeDeps({
      settleResult: { status: 'failed', reason: 'release_tx_reverted' },
    });

    await expect(completeEscrow(deps, 'escrow_test', 'wallet_depositor')).rejects.toThrow(
      /on-chain escrow release failed/i,
    );
    expect(txUpdates).toHaveLength(0);
  });
});
