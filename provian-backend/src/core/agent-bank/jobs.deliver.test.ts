/**
 * deliverJob - corroboration emits with a REAL target hash (Pass-2 #5).
 *
 * The corroboration confirms the job's CREATION PE = pe_ids[0] (job_posted),
 * mirroring escrow/promise. Production reality (verified in review): createJob
 * sets jobs.pe_ids = [job_posted_peId] and NOTHING ever appends to it
 * (acceptApplicant generates job_accepted PEs but never writes them to pe_ids),
 * so pe_ids has exactly one element at delivery. The fixture below reflects that
 * (a prior version hand-seeded a two-element array the lifecycle never produces,
 * which masked a wrong-target bug). This pins: the real hash is fetched+forwarded
 * (never ''), and the target is the creation PE.
 */

import { deliverJob } from './jobs';
import { emitBackendCorroboration, resolveTargetPeHash } from '../corroboration/CorroborationManager';
import type { AgentBankDeps, JobDocument } from './types';
import type { AgentWalletDocument } from '../agent-wallet/types';

const mockGeneratePE = jest.fn().mockResolvedValue({ peId: 'pe_delivered', peHash: 'h', prevHash: 'p' });
jest.mock('./pe-utils', () => ({
  generatePE: (...args: unknown[]) => mockGeneratePE(...args),
  generateSchedulerPE: (...args: unknown[]) => mockGeneratePE(...args),
}));

jest.mock('../corroboration/CorroborationManager', () => ({
  emitBackendCorroboration: jest.fn(),
  resolveTargetPeHash: jest.fn().mockResolvedValue('hash_job_accepted'),
}));

const mockEmit = emitBackendCorroboration as jest.Mock;
const mockResolve = resolveTargetPeHash as jest.Mock;
const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const baseJob: JobDocument = {
  assigned_wallet_id: 'wallet_worker',
  status: 'assigned',
  title: 'Test job',
  poster_wallet_id: 'wallet_poster',
  poster_address: '0xposter',
  escrow_id: 'escrow_1',
  // Production shape: createJob sets pe_ids=[job_posted] and nothing appends.
  // The corroboration target is this creation PE (pe_ids[0]).
  pe_ids: ['pe_job_posted'],
} as unknown as JobDocument;

function makeDeps(): AgentBankDeps {
  const jobRef = {
    get: jest.fn().mockResolvedValue({ exists: true, data: () => baseJob }),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const db = {
    collection: jest.fn().mockImplementation((name: string) => {
      if (name === 'jobs') return { doc: jest.fn().mockReturnValue(jobRef) };
      throw new Error(`Unexpected collection lookup: ${name}`);
    }),
  };
  return { db } as unknown as AgentBankDeps;
}

// linked-job settlement: deliverJob now gates through the institution state machine with the
// worker's wallet-suspension state as the kill switch — the fixture must carry
// a real 'active' status (a missing status is Unknown = Block).
const worker: AgentWalletDocument = {
  agent_id: 'agent_worker',
  address: '0xworker',
  status: 'active',
} as AgentWalletDocument;

beforeEach(() => {
  mockGeneratePE.mockClear();
  mockEmit.mockClear();
  mockResolve.mockClear();
  mockResolve.mockResolvedValue('hash_job_accepted');
});

describe('deliverJob - corroboration target + real hash (Pass-2 #5)', () => {
  it('resolves and forwards the creation PE (pe_ids[0]) hash, never the empty string', async () => {
    const deps = makeDeps();

    await deliverJob(deps, 'job_1', 'wallet_worker', worker);
    await flushMicrotasks();

    // Target the creation PE explicitly via pe_ids[0] (the only persisted pe_id).
    expect(mockResolve).toHaveBeenCalledWith(deps, 'pe_job_posted');
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledWith(
      deps,
      expect.objectContaining({
        targetPeId: 'pe_job_posted',
        targetPeHash: 'hash_job_accepted',
        signalType: 'job_delivery_accepted',
      }),
    );
    expect((mockEmit.mock.calls[0][1] as { targetPeHash: string }).targetPeHash).not.toBe('');
  });

  it('skips the signal (no suppression) when the target hash is genuinely missing', async () => {
    const deps = makeDeps();
    mockResolve.mockResolvedValue('');

    await deliverJob(deps, 'job_1', 'wallet_worker', worker);
    await flushMicrotasks();

    expect(mockResolve).toHaveBeenCalledWith(deps, 'pe_job_posted');
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

describe('deliverJob - the delivery PE never carries the private locator ', () => {
  it('RED: the PE seals the deliverable sha256 and the locator sha256 — never the locator or a digest locator', async () => {
    const deps = makeDeps();
    const uri = 'https://private.example/out.tgz?token=secret';
    await deliverJob(deps, 'job_1', 'wallet_worker', worker, { deliverable_uri: uri, deliverable_body: 'body' });
    await flushMicrotasks();
    const params = mockGeneratePE.mock.calls.find((c) => (c[1] as { actionType: string }).actionType === 'job_delivered')?.[1] as {
      metadata: Record<string, unknown>; output_digests: Array<Record<string, unknown>>;
    };
    expect(params).toBeDefined();
    expect(JSON.stringify(params)).not.toContain('private.example');
    expect(params.metadata.deliverable_uri).toBeUndefined();
    const crypto = jest.requireActual<typeof import('crypto')>('crypto');
    expect(params.metadata.deliverable_uri_sha256).toBe(crypto.createHash('sha256').update(uri).digest('hex'));
    expect(params.metadata.deliverable_sha256).toBe(crypto.createHash('sha256').update('body').digest('hex'));
    expect(params.output_digests).toEqual([{ hash: `sha256:${params.metadata.deliverable_sha256}`, kind: 'artifact' }]);
  });
});
