/**
 * postJob runtime type guards (F39 — guard extension, S2 2026-09-10).
 *
 * The finite-number guard shipped only in escrow.ts. jobs.ts's
 * `budget_usdc` and `deadline_hours` range checks used bare <= / > comparisons,
 * which COERCE a missing/non-number value to a false comparison — so a string
 * or NaN budget persisted and sorted among numeric budgets, and an omitted
 * `deadline_hours` persisted an open job the scheduler never expires.
 *
 * Each `it.each` case is the RED negative control (violating value → the guard
 * reports it BEFORE any Firestore write or PE). The final `describe` is the
 * non-vacuity positive control: a valid numeric body passes both guards
 * and persists once.
 */

import { postJob as postJobRaw } from './jobs';
import { TEST_WINDOW } from '../commons/__test-helpers__/speech';
const postJob = (deps: Parameters<typeof postJobRaw>[0], w: string, wallet: Parameters<typeof postJobRaw>[2], body: Parameters<typeof postJobRaw>[3]) => postJobRaw(deps, w, wallet, body, TEST_WINDOW);
import type { AgentBankDeps, PostJobRequest } from './types';
import type { AgentWalletDocument } from '../agent-wallet/types';

const mockGeneratePE = jest.fn().mockResolvedValue({ peId: 'pe_created', peHash: 'h', prevHash: 'p' });
jest.mock('./pe-utils', () => ({ generatePE: (...a: unknown[]) => mockGeneratePE(...a) }));
jest.mock('./wallet-stats', () => ({ updateWalletStats: jest.fn() }));
jest.mock('../corroboration/CorroborationManager', () => ({
  emitBackendCorroboration: jest.fn(),
  resolveTargetPeHash: jest.fn().mockResolvedValue('hash_target'),
}));

const WALLET: AgentWalletDocument =
  ({ id: 'poster', agent_id: 'agent_poster', address: '0xposter', status: 'active' } as unknown as AgentWalletDocument);

const BODY: PostJobRequest = {
  title: 'Test job',
  description: 'desc',
  required_capabilities: ['x'],
  currency: 'usdc',
  budget_usdc: 100,
  deadline_hours: 24,
  chain: 'base',
};

function makeDeps(): { deps: AgentBankDeps; setMock: jest.Mock; updateMock: jest.Mock } {
  const setMock = jest.fn().mockResolvedValue(undefined);
  const updateMock = jest.fn().mockResolvedValue(undefined);
  const jobRef = { set: setMock, update: updateMock, get: jest.fn() };
  const jobsCollection = { doc: jest.fn(() => jobRef) };
  const db = {
    collection: jest.fn((name: string) => {
      if (name === 'jobs') return jobsCollection;
      throw new Error(`Unexpected collection lookup before guard: ${name}`);
    }),
  };
  return { deps: { db, cache: {} } as unknown as AgentBankDeps, setMock, updateMock };
}

beforeEach(() => jest.clearAllMocks());

describe('postJob — F39 finite-number guards (RED controls)', () => {
  it.each([['50'], ['abc'], [''], [NaN], [Infinity]])(
    'rejects a non-finite budget_usdc (%p) before any Firestore/PE write',
    async (bad) => {
      const { deps, setMock } = makeDeps();
      await expect(
        postJob(deps, WALLET.id, WALLET, { ...BODY, budget_usdc: bad as unknown as number }),
      ).rejects.toThrow(/budget_usdc must be a finite number/);
      expect(setMock).not.toHaveBeenCalled();
      expect(mockGeneratePE).not.toHaveBeenCalled();
    },
  );

  it.each([[undefined], [NaN], [Infinity], ['24']])(
    'rejects a non-finite deadline_hours (%p) before persisting a never-expiring job',
    async (bad) => {
      const { deps, setMock } = makeDeps();
      await expect(
        postJob(deps, WALLET.id, WALLET, { ...BODY, deadline_hours: bad as unknown as number }),
      ).rejects.toThrow(/deadline_hours must be a finite number/);
      expect(setMock).not.toHaveBeenCalled();
      expect(mockGeneratePE).not.toHaveBeenCalled();
    },
  );
});

describe('postJob — non-vacuity positive control', () => {
  it('a valid numeric body passes both guards and persists once', async () => {
    const { deps, setMock } = makeDeps();
    await postJob(deps, WALLET.id, WALLET, { ...BODY });
    expect(setMock).toHaveBeenCalledTimes(1);
    const persisted = setMock.mock.calls[0][0] as { deadline: number };
    expect(Number.isFinite(persisted.deadline)).toBe(true);
  });
});
