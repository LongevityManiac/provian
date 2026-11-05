/**
 * linked-job settlement — completeHumanJob is a CONFIRMATION RECORD plus a settlement
 * bridge; status='completed' is written ONLY by the receipt-gated settlement
 * path (agent-bank/job-settlement.ts). These tests probe the wired flow:
 *
 * - released escrow ⇒ the same call settles the job (completed +
 * payment_released + receipt anchor) and credits the applicant stat ONCE;
 * - unreleased escrow ⇒ the job honestly stays in_progress with
 * payment_release_pending (NO optimistic 'completed' flip — the pre-linked-job settlement
 * lie this suite exists to lock out);
 * - a re-confirm is idempotent: no duplicate human_job_completed PE.
 */

import admin from 'firebase-admin';
import { completeHumanJob } from './human-jobs';
import { completeEscrow } from '../agent-bank/escrow';
import type { CommonsDeps } from './types';

const mockGeneratePE = jest.fn().mockResolvedValue({ peId: 'pe_mock', peHash: 'h', prevHash: 'p' });
jest.mock('../agent-bank/pe-utils', () => ({
  generatePE: (...args: unknown[]) => mockGeneratePE(...args),
}));

jest.mock('../agent-bank/escrow', () => ({
  createEscrow: jest.fn(),
  completeEscrow: jest.fn(),
}));
const mockCompleteEscrow = completeEscrow as jest.Mock;

const TX_RELEASE = `0x${'12'.repeat(32)}`;

function applyPlainPatch(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v instanceof admin.firestore.FieldValue) continue;
    target[k] = v;
  }
}

function makeStatefulRef(id: string, data: Record<string, unknown>) {
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
  job: Record<string, unknown>;
  escrow?: Record<string, unknown>;
}): {
  deps: CommonsDeps;
  jobDoc: ReturnType<typeof makeStatefulRef>;
  profileDoc: ReturnType<typeof makeStatefulRef>;
} {
  const jobDoc = makeStatefulRef('hjob_1', opts.job);
  const profileDoc = makeStatefulRef('worker', { human_jobs_completed: 0 });

  const escrowRef = {
    get: jest.fn(async () =>
      opts.escrow
        ? { exists: true, data: () => opts.escrow }
        : { exists: false, data: () => undefined },
    ),
  };

  const walletDoc = (id: string) => ({
    get: jest.fn().mockResolvedValue({
      exists: true,
      data: () => ({ agent_id: `agent_${id}`, address: `0x${id}` }),
    }),
  });

  const db = {
    collection: jest.fn().mockImplementation((name: string) => {
      if (name === 'commons_human_jobs') return { doc: jest.fn().mockReturnValue(jobDoc.ref) };
      if (name === 'escrows') return { doc: jest.fn().mockReturnValue(escrowRef) };
      if (name === 'agent_wallets') return { doc: jest.fn().mockImplementation(walletDoc) };
      if (name === 'commons_profiles') return { doc: jest.fn().mockReturnValue(profileDoc.ref) };
      throw new Error(`Unexpected collection lookup: ${name}`);
    }),
    runTransaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        get: async (ref: { get?: () => Promise<unknown> }) =>
          typeof ref?.get === 'function' ? ref.get() : { exists: false, data: () => undefined },
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
  };

  return { deps: { db, cache: {} } as unknown as CommonsDeps, jobDoc, profileDoc };
}

const baseJob = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  job_id: 'hjob_1',
  poster_wallet_id: 'poster',
  status: 'in_progress',
  accepted_applicant_wallet_id: 'worker',
  escrow_id: 'esc_1',
  completion_pe_id: 'pe_delivered',
  ...overrides,
});

const releasedEscrow = {
  escrow_id: 'esc_1',
  depositor_wallet_id: 'poster',
  recipient_wallet_id: 'worker',
  depositor_address: '0xposter',
  recipient_address: '0xworker',
  currency: 'pvt',
  amount_pvt: '5000000000000000000',
  fee_pvt: '25000000000000000',
  net_to_recipient_pvt: '4975000000000000000',
  status: 'completed',
  release_tx_hash: TX_RELEASE,
};

const pePEs = (actionType: string) =>
  mockGeneratePE.mock.calls.filter(
    (c) => (c[1] as { actionType?: string })?.actionType === actionType,
  );

beforeEach(() => {
  mockGeneratePE.mockClear();
  mockCompleteEscrow.mockReset();
});

describe('completeHumanJob — settlement truth', () => {
  it('settles the job when the escrow is already released: completed + payment_released + receipt', async () => {
    const { deps, jobDoc, profileDoc } = makeDeps({ job: baseJob(), escrow: releasedEscrow });

    const result = await completeHumanJob(deps, 'poster', 'agent_poster', '0xposter', 'hjob_1');

    expect(result.status).toBe('completed');
    const job = jobDoc.data() as Record<string, unknown>;
    expect(job.status).toBe('completed');
    expect(job.payment_released).toBe(true);
    expect(job.payment_release_pending).toBe(false);
    expect(job.settlement_tx_hash).toBe(TX_RELEASE);
    expect(job.poster_confirmed_at as number).toBeGreaterThan(0);
    // Confirmation PE once + dual-party settlement PEs once.
    expect(pePEs('human_job_completed')).toHaveLength(1);
    expect(pePEs('human_job_payment_released')).toHaveLength(2);
    // Applicant stat credited by the settlement winner, atomically marked.
    expect(job.completion_stats_credited).toBe(true);
    expect(profileDoc._patches.length).toBeGreaterThan(0);
  });

  it('does NOT flip to completed while payment is pending — the pre-linked-job settlement optimistic lie is gone', async () => {
    const { deps, jobDoc } = makeDeps({
      job: baseJob(),
      escrow: { ...releasedEscrow, status: 'funded', release_tx_hash: undefined },
    });
    // Pre-timeout, no depositor release: the bridge fails closed.
    mockCompleteEscrow.mockRejectedValue(new Error('Escrow funds are not yet released on-chain.'));

    const result = await completeHumanJob(deps, 'poster', 'agent_poster', '0xposter', 'hjob_1');

    expect(result.status).toBe('in_progress'); // honest: work confirmed, payment pending
    expect(result.payment_release_pending).toBe(true);
    const job = jobDoc.data() as Record<string, unknown>;
    expect(job.status).toBe('in_progress');
    expect(job.poster_confirmed_at as number).toBeGreaterThan(0);
    expect(pePEs('human_job_completed')).toHaveLength(1); // confirmation recorded
    expect(pePEs('human_job_payment_released')).toHaveLength(0); // NO settlement claim
  });

  it('a re-confirm is idempotent: no duplicate human_job_completed PE, bridge retried', async () => {
    const { deps } = makeDeps({
      job: baseJob({ poster_confirmed_at: 111, payment_release_pending: true }),
      escrow: { ...releasedEscrow, status: 'funded', release_tx_hash: undefined },
    });
    mockCompleteEscrow.mockRejectedValue(new Error('still pre-timeout'));

    await completeHumanJob(deps, 'poster', 'agent_poster', '0xposter', 'hjob_1');

    expect(pePEs('human_job_completed')).toHaveLength(0); // already recorded — no duplicate
    expect(mockCompleteEscrow).toHaveBeenCalledTimes(1); // the bridge is retried
  });

  it('poster-only: the worker cannot confirm completion', async () => {
    const { deps } = makeDeps({ job: baseJob(), escrow: releasedEscrow });

    await expect(
      completeHumanJob(deps, 'worker', 'agent_worker', '0xworker', 'hjob_1'),
    ).rejects.toThrow('Only the job poster can confirm completion');
  });

  it('refuses before delivery (no completion_pe_id)', async () => {
    const { deps } = makeDeps({ job: baseJob({ completion_pe_id: undefined }), escrow: releasedEscrow });

    await expect(
      completeHumanJob(deps, 'poster', 'agent_poster', '0xposter', 'hjob_1'),
    ).rejects.toThrow('Work has not been delivered yet');
  });

  it('FAILS CLOSED: a released escrow with no recoverable receipt leaves the job pending, never lies', async () => {
    const { deps, jobDoc } = makeDeps({
      job: baseJob(),
      // Escrow settled but its release tx hash was never recorded/recovered.
      escrow: { ...releasedEscrow, release_tx_hash: undefined },
    });

    const result = await completeHumanJob(deps, 'poster', 'agent_poster', '0xposter', 'hjob_1');

    expect(result.status).toBe('in_progress');
    expect(result.payment_release_pending).toBe(true);
    expect((jobDoc.data() as Record<string, unknown>).payment_released).toBeUndefined();
    expect(pePEs('human_job_payment_released')).toHaveLength(0);
  });
});
