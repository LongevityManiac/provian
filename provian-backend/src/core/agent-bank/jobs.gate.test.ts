/**
 * linked-job settlement — the jobs route's draft transitions are wired through the ONE
 * institution state machine (`evaluateInstitutionTransition`), kill switch
 * FIRST. These tests probe the ACTUAL wired module (the functions the route
 * handlers call), not the machine in isolation:
 *
 * - kill-switch-first: a non-active acting wallet is blocked BEFORE any
 * validation, Firestore write, or escrow creation;
 * - Unknown = Block: a transition from an unmodeled source state refuses;
 * - createEscrow() reuse: acceptApplicant funds the job through the ONE
 * escrow path (pitfalls #25/#35) — no parallel escrow write, and the
 * auto-escrow inherits the job's currency + chain;
 * - self-dealing guards: an agent can neither apply to nor accept its own
 * job (accept is poster-only, so a non-poster — including the applicant —
 * cannot assign the job to themselves).
 */

import { postJob as postJobRaw, applyToJob, acceptApplicant, deliverJob } from './jobs';
import { TEST_WINDOW } from '../commons/__test-helpers__/speech';
const postJob = (deps: Parameters<typeof postJobRaw>[0], w: string, wallet: Parameters<typeof postJobRaw>[2], body: Parameters<typeof postJobRaw>[3]) => postJobRaw(deps, w, wallet, body, TEST_WINDOW);
import { createEscrow } from './escrow';
import type { AgentBankDeps, JobDocument } from './types';
import type { AgentWalletDocument } from '../agent-wallet/types';

const mockGeneratePE = jest.fn().mockResolvedValue({ peId: 'pe_mock', peHash: 'h', prevHash: 'p' });
jest.mock('./pe-utils', () => ({
  generatePE: (...args: unknown[]) => mockGeneratePE(...args),
}));

jest.mock('./escrow', () => ({
  createEscrow: jest.fn().mockResolvedValue({ escrow_id: 'esc_auto' }),
}));
const mockCreateEscrow = createEscrow as jest.Mock;

jest.mock('../corroboration/CorroborationManager', () => ({
  emitBackendCorroboration: jest.fn(),
  resolveTargetPeHash: jest.fn().mockResolvedValue('h'),
}));

const activeWallet = (id: string): AgentWalletDocument =>
  ({ id, agent_id: `agent_${id}`, address: `0x${id}`, status: 'active' } as unknown as AgentWalletDocument);

const suspendedWallet = (id: string): AgentWalletDocument =>
  ({ id, agent_id: `agent_${id}`, address: `0x${id}`, status: 'suspended' } as unknown as AgentWalletDocument);

function baseJob(overrides: Partial<JobDocument> = {}): JobDocument {
  return {
    job_id: 'job_1',
    poster_wallet_id: 'poster',
    poster_address: '0xposter',
    title: 'Test job',
    description: 'desc',
    required_capabilities: ['x'],
    currency: 'usdc',
    budget_usdc: 100,
    chain: 'base',
    deadline_hours: 24,
    deadline: Date.now() + 86_400_000,
    status: 'open',
    applications: [],
    pe_ids: ['pe_posted'],
    created_at: 0,
    updated_at: 0,
    ...overrides,
  } as JobDocument;
}

/** deps whose db throws on ANY touch — proves the gate ran before all I/O. */
function untouchableDeps(): AgentBankDeps {
  return {
    db: {
      collection: () => {
        throw new Error('Firestore touched before the gate');
      },
    },
  } as unknown as AgentBankDeps;
}

function depsWithJob(job: JobDocument): { deps: AgentBankDeps; jobRef: { update: jest.Mock } } {
  const jobRef = {
    get: jest.fn().mockResolvedValue({ exists: true, data: () => job }),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const db = {
    collection: jest.fn().mockImplementation((name: string) => {
      if (name === 'jobs') return { doc: jest.fn().mockReturnValue(jobRef) };
      if (name === 'escrows') {
        throw new Error('parallel escrow path: jobs must reuse createEscrow()');
      }
      throw new Error(`Unexpected collection lookup: ${name}`);
    }),
  };
  return { deps: { db } as unknown as AgentBankDeps, jobRef };
}

beforeEach(() => {
  mockGeneratePE.mockClear();
  mockCreateEscrow.mockClear();
  mockCreateEscrow.mockResolvedValue({ escrow_id: 'esc_auto' });
});

describe('linked-job settlement gate — kill switch FIRST on every draft transition', () => {
  it('postJob: a suspended wallet is blocked before ANY validation or Firestore write', async () => {
    await expect(
      postJob(untouchableDeps(), 'w1', suspendedWallet('w1'), {
        // Invalid body on purpose: the kill switch must fire FIRST, so the
        // body must never be validated.
        title: '',
        description: '',
        required_capabilities: [],
        deadline_hours: 0,
      }),
    ).rejects.toThrow(/Agent wallet is not active/);
  });

  it('acceptApplicant: a suspended poster is blocked before ownership checks and before createEscrow', async () => {
    const { deps } = depsWithJob(
      baseJob({ applications: [{ wallet_id: 'worker', agent_id: 'a', address: '0xw', proposal: 'p', applied_at: 1 }] }),
    );

    await expect(
      acceptApplicant(deps, 'job_1', 'worker', 'poster', suspendedWallet('poster')),
    ).rejects.toThrow(/Agent wallet is not active/);
    expect(mockCreateEscrow).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('deliverJob: a suspended worker is blocked before the ownership check', async () => {
    const { deps, jobRef } = depsWithJob(baseJob({ status: 'assigned', assigned_wallet_id: 'worker' }));

    await expect(deliverJob(deps, 'job_1', 'worker', suspendedWallet('worker'))).rejects.toThrow(
      /Agent wallet is not active/,
    );
    expect(jobRef.update).not.toHaveBeenCalled();
  });
});

describe('linked-job settlement gate — Unknown = Block on unmodeled source states', () => {
  it('acceptApplicant refuses when the job is not open (completed → assigned is not an edge)', async () => {
    const { deps } = depsWithJob(baseJob({ status: 'completed' }));

    await expect(
      acceptApplicant(deps, 'job_1', 'worker', 'poster', activeWallet('poster')),
    ).rejects.toThrow('Job is no longer open');
    expect(mockCreateEscrow).not.toHaveBeenCalled();
  });

  it('acceptApplicant refuses on a refunded job (terminal states have no outgoing edges)', async () => {
    const { deps } = depsWithJob(baseJob({ status: 'refunded' }));

    await expect(
      acceptApplicant(deps, 'job_1', 'worker', 'poster', activeWallet('poster')),
    ).rejects.toThrow('Job is no longer open');
  });

  it('deliverJob refuses unless the job is assigned (open → delivered is not an edge)', async () => {
    const { deps, jobRef } = depsWithJob(baseJob({ status: 'open' }));

    await expect(deliverJob(deps, 'job_1', 'worker', activeWallet('worker'))).rejects.toThrow(
      'Job must be in assigned status to deliver',
    );
    expect(jobRef.update).not.toHaveBeenCalled();
  });

  it('deliverJob refuses to re-deliver a completed job', async () => {
    const { deps } = depsWithJob(baseJob({ status: 'completed', assigned_wallet_id: 'worker' }));

    await expect(deliverJob(deps, 'job_1', 'worker', activeWallet('worker'))).rejects.toThrow(
      'Job must be in assigned status to deliver',
    );
  });
});

describe('linked-job settlement gate — self-dealing guards stay intact', () => {
  it('an agent cannot apply to its own job', async () => {
    const { deps } = depsWithJob(baseJob());

    await expect(
      applyToJob(deps, 'job_1', 'poster', activeWallet('poster'), { proposal: 'me please' }),
    ).rejects.toThrow('Cannot apply to your own job');
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('only the poster can accept — an applicant cannot assign the job to themselves', async () => {
    const { deps } = depsWithJob(
      baseJob({ applications: [{ wallet_id: 'worker', agent_id: 'a', address: '0xw', proposal: 'p', applied_at: 1 }] }),
    );

    await expect(
      acceptApplicant(deps, 'job_1', 'worker', 'worker', activeWallet('worker')),
    ).rejects.toThrow('Only the job poster can accept applicants');
    expect(mockCreateEscrow).not.toHaveBeenCalled();
  });

  it('only the assigned worker can deliver', async () => {
    const { deps } = depsWithJob(baseJob({ status: 'assigned', assigned_wallet_id: 'worker' }));

    await expect(deliverJob(deps, 'job_1', 'someone_else', activeWallet('someone_else'))).rejects.toThrow(
      'Only the assigned worker can deliver',
    );
  });
});

describe('linked-job settlement gate — createEscrow() reuse (no parallel escrow path)', () => {
  it('acceptApplicant funds the job through createEscrow with the job currency + chain inherited', async () => {
    const job = baseJob({
      currency: 'pvt',
      budget_pvt: '5000000000000000000',
      chain: 'base',
      applications: [{ wallet_id: 'worker', agent_id: 'a', address: '0xw', proposal: 'p', applied_at: 1 }],
    });
    const { deps, jobRef } = depsWithJob(job);
    // agent_wallets lookups are inside createEscrow (mocked) — no extra deps needed.

    const result = await acceptApplicant(deps, 'job_1', 'worker', 'poster', activeWallet('poster'));

    // The ONE escrow path was used — depsWithJob throws on any direct
    // 'escrows' collection write, so reaching here proves no parallel path.
    expect(mockCreateEscrow).toHaveBeenCalledTimes(1);
    expect(mockCreateEscrow.mock.calls[0][1]).toMatchObject({
      depositor_wallet_id: 'poster',
      recipient_wallet_id: 'worker',
      currency: 'pvt',
      amount_pvt: '5000000000000000000',
      chain: 'base',
    });
    expect(result.escrow_id).toBe('esc_auto');
    expect(jobRef.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'assigned', escrow_id: 'esc_auto' }),
    );
    // Both parties' job_accepted PEs.
    expect(
      mockGeneratePE.mock.calls.filter((c) => (c[1] as { actionType?: string })?.actionType === 'job_accepted'),
    ).toHaveLength(2);
  });
});
