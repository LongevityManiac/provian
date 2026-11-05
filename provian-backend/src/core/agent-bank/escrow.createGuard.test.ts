/**
 * createEscrow guards (Pass-2 WS3 C2).
 *
 * C2: createEscrow used to write the escrow doc + escrow_created PE BEFORE the
 * route resolved the per-chain contract address, so a chain with no configured
 * env var produced an orphaned, unfundable escrow + PE (the route then 400'd at
 * its own resolve, and the agent never got a funding address). The fix resolves
 * + validates the funding target FIRST (fail fast, no writes) and writes the doc
 * ONCE with pe_ids populated (no set→update window).
 *
 * These tests use the REAL chain-registry + errors, controlling resolution via
 * env vars, so the actual fail-fast path (resolveEscrowContractAddress →
 * requireAddressOrThrow → ValidationError) is exercised end to end.
 */

import { createEscrow, ValidationError } from './escrow';
import type { AgentBankDeps, CreateEscrowRequest } from './types';

const mockGeneratePE = jest.fn().mockResolvedValue({ peId: 'pe_created', peHash: 'h', prevHash: 'p' });
jest.mock('./pe-utils', () => ({ generatePE: (...a: unknown[]) => mockGeneratePE(...a) }));
jest.mock('./wallet-stats', () => ({ updateWalletStats: jest.fn() }));
jest.mock('../corroboration/CorroborationManager', () => ({
  emitBackendCorroboration: jest.fn(),
  resolveTargetPeHash: jest.fn().mockResolvedValue('hash_target'),
}));
// createEscrow never calls these, but escrow.ts imports them at module level.
jest.mock('../onchain/tx-verifier', () => ({
  verifyTransfer: jest.fn(),
  verifyOnchainEscrowFunding: jest.fn(),
}));

const ORIG_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIG_ENV };
});

const BODY: CreateEscrowRequest = {
  depositor_wallet_id: 'wallet_dep',
  recipient_wallet_id: 'wallet_rec',
  currency: 'usdc',
  amount_usdc: 100,
  description: 'work',
  deliverables: 'deliver',
  deadline_hours: 24,
  auto_release_hours: 48,
  chain: 'base',
};

function makeDeps(): { deps: AgentBankDeps; setMock: jest.Mock; updateMock: jest.Mock } {
  const setMock = jest.fn().mockResolvedValue(undefined);
  const updateMock = jest.fn().mockResolvedValue(undefined);
  const escrowDocRef = { set: setMock, update: updateMock };

  // Rate-limit query: .where().where().count().get()
  const countGet = jest.fn().mockResolvedValue({ data: () => ({ count: 0 }) });
  const whereChain = { where: jest.fn(), count: jest.fn(() => ({ get: countGet })) };
  whereChain.where.mockReturnValue(whereChain);
  const escrowCollection = {
    where: jest.fn(() => whereChain),
    doc: jest.fn(() => escrowDocRef),
  };

  const depositorRef = {
    get: jest.fn().mockResolvedValue({ exists: true, data: () => ({ agent_id: 'agent_dep', address: '0xdep' }) }),
  };
  const recipientRef = {
    get: jest.fn().mockResolvedValue({ exists: true, data: () => ({ agent_id: 'agent_rec', address: '0xrec' }) }),
  };
  const agentWalletCollection = {
    doc: jest.fn((id: string) => (id === 'wallet_dep' ? depositorRef : recipientRef)),
  };

  const db = {
    collection: jest.fn((name: string) => (name === 'escrows' ? escrowCollection : agentWalletCollection)),
  };
  return { deps: { db, cache: {} } as unknown as AgentBankDeps, setMock, updateMock };
}

describe('createEscrow - C2 fail-fast contract resolution', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws ValidationError with NO Firestore/PE side effects when the chain has no configured contract', async () => {
    delete process.env.ESCROW_CONTRACT_ADDRESS;
    delete process.env.ESCROW_CONTRACT_ADDRESS_BASE;
    const { deps, setMock, updateMock } = makeDeps();

    await expect(createEscrow(deps, BODY)).rejects.toBeInstanceOf(ValidationError);

    // The whole point of C2: no orphaned escrow doc, no escrow_created PE.
    expect(setMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('on success, writes the escrow doc ONCE with pe_ids populated (no set→update window)', async () => {
    process.env.ESCROW_CONTRACT_ADDRESS_BASE = '0x' + '11'.repeat(20);
    const { deps, setMock, updateMock } = makeDeps();

    const doc = await createEscrow(deps, BODY);

    expect(mockGeneratePE).toHaveBeenCalledTimes(1);
    // Single atomic write, with the creation PE already attached.
    expect(setMock).toHaveBeenCalledTimes(1);
    expect(updateMock).not.toHaveBeenCalled();
    expect(setMock.mock.calls[0][0]).toMatchObject({
      escrow_id: doc.escrow_id,
      status: 'created',
      pe_ids: ['pe_created'],
    });
    expect(doc.pe_ids).toEqual(['pe_created']);
  });
});

describe('createEscrow - amount_usdc runtime type guard (Pass-3 #2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Contract resolution must PASS so we prove the amount guard rejects BEFORE
    // any persist (the finding: a string amount slips the <=/> range check via
    // coercion, persists a corrupt escrow, then permanently fails funding).
    process.env.ESCROW_CONTRACT_ADDRESS_BASE = '0x' + '11'.repeat(20);
  });

  // '50' (numeric-looking string): '50'<=0 is false and '50'>MAX is false, so the
  // pre-fix range check passed it through. 'abc' → NaN, both comparisons false too.
  it.each([['50'], ['abc'], ['']])(
    'rejects a string amount_usdc (%p) before any Firestore/PE write',
    async (bad) => {
      const { deps, setMock } = makeDeps();
      await expect(
        createEscrow(deps, { ...BODY, amount_usdc: bad as unknown as number }),
      ).rejects.toThrow(/amount_usdc must be a finite number/);
      expect(setMock).not.toHaveBeenCalled();
      expect(mockGeneratePE).not.toHaveBeenCalled();
    },
  );

  it('rejects NaN / Infinity amount_usdc', async () => {
    const { deps, setMock } = makeDeps();
    await expect(createEscrow(deps, { ...BODY, amount_usdc: NaN })).rejects.toThrow(/finite number/);
    await expect(createEscrow(deps, { ...BODY, amount_usdc: Infinity })).rejects.toThrow(/finite number/);
    expect(setMock).not.toHaveBeenCalled();
  });

  it('still accepts a valid numeric amount_usdc (persists once)', async () => {
    const { deps, setMock } = makeDeps();
    await createEscrow(deps, { ...BODY, amount_usdc: 50 });
    expect(setMock).toHaveBeenCalledTimes(1);
  });
});

describe('createEscrow - hours runtime type guard (deadline_hours / auto_release_hours)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Contract resolution + amount must PASS so we prove the HOURS guard is what
    // rejects, before any persist.
    process.env.ESCROW_CONTRACT_ADDRESS_BASE = '0x' + '11'.repeat(20);
  });

  // The exact defect this closes: a missing/non-finite hours field slips the
  // <=/> range check by coercion (undefined<=0 false, undefined>MAX false), then
  // `now + undefined*3600000` = NaN is persisted as auto_release_at / deadline —
  // a corrupt escrow doc whose route serializer throws `RangeError: Invalid time
  // value` (a 500), AFTER the doc + escrow_created PE were already written.
  it.each([
    ['auto_release_hours', undefined],
    ['auto_release_hours', NaN],
    ['auto_release_hours', Infinity],
    ['auto_release_hours', '48'],
    ['deadline_hours', undefined],
    ['deadline_hours', NaN],
    ['deadline_hours', Infinity],
    ['deadline_hours', '24'],
  ])(
    'rejects a non-finite %s (%p) before any Firestore/PE write (never persists a NaN timestamp)',
    async (field, bad) => {
      const { deps, setMock } = makeDeps();
      await expect(
        createEscrow(deps, { ...BODY, [field]: bad as unknown as number }),
      ).rejects.toThrow(new RegExp(`${field} must be a finite number`));
      // The property that matters: no orphaned escrow doc, no escrow_created PE,
      // and therefore no NaN-timestamped escrow the serializer can 500 on.
      expect(setMock).not.toHaveBeenCalled();
      expect(mockGeneratePE).not.toHaveBeenCalled();
    },
  );

  // Positive control (non-vacuity): the guard is NOT hard-wired to reject —
  // a valid hours pair persists ONCE, and the persisted doc carries FINITE
  // auto_release_at / deadline (the exact fields that were NaN pre-fix).
  it('accepts a valid hours pair and persists finite timestamps', async () => {
    const { deps, setMock } = makeDeps();
    await createEscrow(deps, { ...BODY, deadline_hours: 24, auto_release_hours: 48 });
    expect(setMock).toHaveBeenCalledTimes(1);
    const persisted = setMock.mock.calls[0][0] as { auto_release_at: number; deadline: number };
    expect(Number.isFinite(persisted.auto_release_at)).toBe(true);
    expect(Number.isFinite(persisted.deadline)).toBe(true);
  });
});
