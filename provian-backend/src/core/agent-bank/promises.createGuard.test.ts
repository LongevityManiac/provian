/**
 * createPromise runtime type guards (F39 — guard extension, S2 2026-09-10).
 *
 * The finite-number guard shipped only in escrow.ts. This module's
 * `principal_usdc`, `repay_usdc` and `deadline_hours` range checks used bare
 * <= / > / < comparisons, which COERCE a missing/non-number value to a false
 * comparison (`undefined <= 0` is false, `"9" < "10"` is false) — so a string
 * or NaN amount slipped through and persisted a marketplace listing whose fee
 * math coerces silently, and an omitted `deadline_hours` persisted a
 * `deadline: NaN` the scheduler's `.where('deadline','<=',now)` can never match
 * (a never-repaid promise is never defaulted).
 *
 * Each `it.each` case is the RED negative control: it feeds the guard a
 * deliberately violating value and asserts the guard reports the violation
 * BEFORE any Firestore write or PE (never persists a corrupt row). The last
 * `describe` is the non-vacuity positive control: a fully valid numeric
 * body passes all three guards and reaches the borrower lookup (NotFoundError),
 * proving the guards are not hard-wired to reject.
 */

import { createPromise } from './promises';
import { NotFoundError } from './errors';
import type { AgentBankDeps, CreatePromiseRequest } from './types';

const mockGeneratePE = jest.fn().mockResolvedValue({ peId: 'pe_created', peHash: 'h', prevHash: 'p' });
jest.mock('./pe-utils', () => ({ generatePE: (...a: unknown[]) => mockGeneratePE(...a) }));
jest.mock('./wallet-stats', () => ({ updateWalletStats: jest.fn() }));
jest.mock('../corroboration/CorroborationManager', () => ({
  emitBackendCorroboration: jest.fn(),
  resolveTargetPeHash: jest.fn().mockResolvedValue('hash_target'),
}));
// createPromise never calls these on the guard path, but promises.ts imports
// them at module level.
jest.mock('../onchain/tx-verifier', () => ({
  verifyEvmPromiseFunding: jest.fn(),
  verifyEvmPromiseSettlement: jest.fn(),
}));

const BODY: CreatePromiseRequest = {
  borrower_wallet_id: 'wallet_borrower',
  currency: 'usdc',
  principal_usdc: 100,
  repay_usdc: 110,
  deadline_hours: 24,
  purpose: 'lunch money',
  chain: 'base',
};

/**
 * deps whose promises rate-limit count read returns 0, whose promises doc
 * .set/.update are spies, and whose agent_wallets borrower lookup is
 * absent by default (exists:false) so a valid body throws NotFoundError.
 */
function makeDeps(): { deps: AgentBankDeps; setMock: jest.Mock; updateMock: jest.Mock } {
  const setMock = jest.fn().mockResolvedValue(undefined);
  const updateMock = jest.fn().mockResolvedValue(undefined);
  const promiseDocRef = { set: setMock, update: updateMock, get: jest.fn() };

  // Rate-limit query: .where().where().count().get() → count 0
  const countGet = jest.fn().mockResolvedValue({ data: () => ({ count: 0 }) });
  const whereChain = { where: jest.fn(), count: jest.fn(() => ({ get: countGet })) };
  whereChain.where.mockReturnValue(whereChain);
  const promisesCollection = {
    where: jest.fn(() => whereChain),
    doc: jest.fn(() => promiseDocRef),
  };

  // Borrower lookup returns not-found → a VALID body throws NotFoundError, never
  // a finite-number error (the non-vacuity positive control).
  const borrowerRef = { get: jest.fn().mockResolvedValue({ exists: false }) };
  const agentWalletsCollection = { doc: jest.fn(() => borrowerRef) };

  const db = {
    collection: jest.fn((name: string) =>
      name === 'promises' ? promisesCollection : agentWalletsCollection,
    ),
  };
  return { deps: { db, cache: {} } as unknown as AgentBankDeps, setMock, updateMock };
}

beforeEach(() => jest.clearAllMocks());

describe('createPromise — F39 finite-number guards (RED controls)', () => {
  // '50' (numeric string): '50'<=0 false, '50'>MAX false → slipped the range
  // check pre-fix; 'abc'→NaN, ''→0-ish, all coerce both comparisons to false.
  it.each([['50'], ['abc'], ['']])(
    'rejects a string principal_usdc (%p) before any Firestore/PE write',
    async (bad) => {
      const { deps, setMock } = makeDeps();
      await expect(
        createPromise(deps, { ...BODY, principal_usdc: bad as unknown as number }),
      ).rejects.toThrow(/principal_usdc must be a finite number/);
      expect(setMock).not.toHaveBeenCalled();
      expect(mockGeneratePE).not.toHaveBeenCalled();
    },
  );

  it('rejects NaN / Infinity principal_usdc', async () => {
    const { deps, setMock } = makeDeps();
    await expect(createPromise(deps, { ...BODY, principal_usdc: NaN })).rejects.toThrow(/finite number/);
    await expect(createPromise(deps, { ...BODY, principal_usdc: Infinity })).rejects.toThrow(/finite number/);
    expect(setMock).not.toHaveBeenCalled();
  });

  it.each([['9'], ['abc'], [NaN], [Infinity]])(
    'rejects a non-finite repay_usdc (%p) with a valid principal, before any write',
    async (bad) => {
      const { deps, setMock } = makeDeps();
      await expect(
        createPromise(deps, { ...BODY, repay_usdc: bad as unknown as number }),
      ).rejects.toThrow(/repay_usdc must be a finite number/);
      expect(setMock).not.toHaveBeenCalled();
      expect(mockGeneratePE).not.toHaveBeenCalled();
    },
  );

  it.each([[undefined], [NaN], [Infinity], ['24']])(
    'rejects a non-finite deadline_hours (%p) before persisting a NaN deadline',
    async (bad) => {
      const { deps, setMock } = makeDeps();
      await expect(
        createPromise(deps, { ...BODY, deadline_hours: bad as unknown as number }),
      ).rejects.toThrow(/deadline_hours must be a finite number/);
      expect(setMock).not.toHaveBeenCalled();
      expect(mockGeneratePE).not.toHaveBeenCalled();
    },
  );
});

describe('createPromise — non-vacuity positive control', () => {
  it('a valid numeric body passes all three guards and reaches the borrower lookup', async () => {
    const { deps, setMock } = makeDeps();
    // Borrower is absent → NotFoundError, NOT a finite-number error. This proves
    // the guards are not hard-wired to reject valid numeric input.
    await expect(createPromise(deps, { ...BODY })).rejects.toBeInstanceOf(NotFoundError);
    await expect(createPromise(deps, { ...BODY })).rejects.not.toThrow(/finite number/);
    expect(setMock).not.toHaveBeenCalled(); // threw at the lookup, before .set
  });
});
