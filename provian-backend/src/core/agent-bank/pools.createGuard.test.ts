/**
 * createPool runtime type guards (F39 — guard extension, S2 2026-09-10).
 *
 * The finite-number guard shipped only in escrow.ts. pools.ts's
 * `threshold_usdc`, `deadline_hours` and `max_contributors` checks used bare
 * comparisons that COERCE a missing/non-number value to false — so a string or
 * NaN threshold persisted, an omitted `deadline_hours` persisted a NaN deadline
 * the scheduler never expires, and a non-numeric `max_contributors` made the
 * `existingContributors >= pool.max_contributors` cap always false (unbounded).
 *
 * Each `it.each` case is the RED negative control (violating value → the guard
 * reports it BEFORE any Firestore write or PE). The final `describe` is the
 * non-vacuity positive control: a valid numeric body passes all three
 * guards and reaches the creator lookup.
 */

import { createPool } from './pools';
import { NotFoundError } from './errors';
import type { AgentBankDeps, CreatePoolRequest } from './types';

const mockGeneratePE = jest.fn().mockResolvedValue({ peId: 'pe_created', peHash: 'h', prevHash: 'p' });
jest.mock('./pe-utils', () => ({ generatePE: (...a: unknown[]) => mockGeneratePE(...a) }));
jest.mock('./wallet-stats', () => ({ updateWalletStats: jest.fn() }));
jest.mock('../corroboration/CorroborationManager', () => ({
  emitBackendCorroboration: jest.fn(),
  resolveTargetPeHash: jest.fn().mockResolvedValue('hash_target'),
}));

const BODY: CreatePoolRequest = {
  creator_wallet_id: 'wallet_creator',
  target_address: '0x' + '11'.repeat(20),
  target_description: 'fund the thing',
  currency: 'usdc',
  threshold_usdc: 100,
  deadline_hours: 24,
  max_contributors: 5,
  chain: 'base',
};

function makeDeps(): { deps: AgentBankDeps; setMock: jest.Mock; updateMock: jest.Mock } {
  const setMock = jest.fn().mockResolvedValue(undefined);
  const updateMock = jest.fn().mockResolvedValue(undefined);
  const poolRef = { set: setMock, update: updateMock, get: jest.fn() };
  const poolsCollection = { doc: jest.fn(() => poolRef) };
  // Creator absent → a VALID body throws NotFoundError, not a finite-number error.
  const creatorRef = { get: jest.fn().mockResolvedValue({ exists: false }) };
  const agentWalletsCollection = { doc: jest.fn(() => creatorRef) };
  const db = {
    collection: jest.fn((name: string) =>
      name === 'pools' ? poolsCollection : agentWalletsCollection,
    ),
  };
  return { deps: { db, cache: {} } as unknown as AgentBankDeps, setMock, updateMock };
}

beforeEach(() => jest.clearAllMocks());

describe('createPool — F39 finite-number guards (RED controls)', () => {
  it.each([['50'], ['abc'], [''], [NaN], [Infinity]])(
    'rejects a non-finite threshold_usdc (%p) before any Firestore/PE write',
    async (bad) => {
      const { deps, setMock } = makeDeps();
      await expect(
        createPool(deps, { ...BODY, threshold_usdc: bad as unknown as number }),
      ).rejects.toThrow(/threshold_usdc must be a finite number/);
      expect(setMock).not.toHaveBeenCalled();
      expect(mockGeneratePE).not.toHaveBeenCalled();
    },
  );

  it.each([[undefined], [NaN], [Infinity], ['24']])(
    'rejects a non-finite deadline_hours (%p) before persisting a NaN deadline',
    async (bad) => {
      const { deps, setMock } = makeDeps();
      await expect(
        createPool(deps, { ...BODY, deadline_hours: bad as unknown as number }),
      ).rejects.toThrow(/deadline_hours must be a finite number/);
      expect(setMock).not.toHaveBeenCalled();
      expect(mockGeneratePE).not.toHaveBeenCalled();
    },
  );

  it.each([['abc'], [undefined], [NaN], [2.5]])(
    'rejects a non-integer max_contributors (%p) before any write (else the contributor cap is unbounded)',
    async (bad) => {
      const { deps, setMock } = makeDeps();
      await expect(
        createPool(deps, { ...BODY, max_contributors: bad as unknown as number }),
      ).rejects.toThrow(/max_contributors must be an integer/);
      expect(setMock).not.toHaveBeenCalled();
      expect(mockGeneratePE).not.toHaveBeenCalled();
    },
  );
});

describe('createPool — non-vacuity positive control', () => {
  it('a valid numeric body passes all three guards and reaches the creator lookup', async () => {
    const { deps, setMock } = makeDeps();
    await expect(createPool(deps, { ...BODY })).rejects.toBeInstanceOf(NotFoundError);
    await expect(createPool(deps, { ...BODY })).rejects.not.toThrow(/finite number|must be an integer/);
    expect(setMock).not.toHaveBeenCalled(); // threw at the creator lookup, before .set
  });
});
