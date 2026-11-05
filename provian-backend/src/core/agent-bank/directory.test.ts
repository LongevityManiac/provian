/**
 * Workstream 3: Agent Directory hourly_rate_pvt validation tests.
 *
 * Mocks Firestore and the dependency surface that registerCapabilities
 * touches; focuses on input validation rather than persistence.
 */

// registerCapabilities writes the LIVE visible-PE count onto the
// directory doc (the stored per-wallet tally is gone). Mock the live counter so
// this validation-focused suite needs no pe_history fixtures.
jest.mock('../agent-wallet/agent-pe-activity', () => ({
  countVisibleAgentPEs: jest.fn().mockResolvedValue(0),
}));

import { registerCapabilities } from './directory';
import type { AgentBankDeps, RegisterCapabilitiesRequest } from './types';
import type { AgentWalletDocument } from '../agent-wallet/types';

function makeMockDeps(): AgentBankDeps {
  const setMock = jest.fn().mockResolvedValue(undefined);
  const getMock = jest.fn().mockResolvedValue({ exists: false, data: () => undefined });
  // The PE chain advance helper inside generatePE runs inside a transaction.
  // The mock simulates a tip-less chain so the writer accepts the new PE.
  const runTransactionMock = jest.fn().mockImplementation(async (fn: (txn: unknown) => Promise<unknown>) => {
    const tx = {
      get: jest.fn().mockResolvedValue({ exists: false, data: () => undefined }),
      set: jest.fn(),
      update: jest.fn(),
      // cutover reconciliation: the ordinary-accrual intake co-write uses txn.create.
      create: jest.fn(),
    };
    return fn(tx);
  });
  return {
    db: {
      collection: () => ({
        doc: () => ({
          get: getMock,
          set: setMock,
          update: jest.fn().mockResolvedValue(undefined),
        }),
        // PE METER: generatePE resolves whom the relay-authored PE is sealed to; a non-`wallet_aw_`
        // wallet id resolves as a person through `wallets where user_id == actor`. No key → no copy.
        where: () => ({ get: jest.fn().mockResolvedValue({ empty: true, docs: [] }) }),
      }),
      runTransaction: runTransactionMock,
    } as unknown as AgentBankDeps['db'],
    cache: { checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, retryAfter: 0 }) } as unknown as AgentBankDeps['cache'],
    peBuffer: { enqueue: jest.fn() },
    recordPEAccrual: jest.fn().mockResolvedValue(undefined),
  };
}

const TEST_WALLET: AgentWalletDocument = {
  id: 'wallet_test',
  agent_id: 'agent_test',
  display_name: 'Test',
  platform: 'sdk',
  address: '0x1111111111111111111111111111111111111111',
  public_key: 'a'.repeat(128),
  api_key_hash: 'hash',
  api_key_salt: 'salt',
  api_key_prefix: 'prefix',
  governance: {
    pe_coverage_enabled: false,
    attestation_enabled: false,
    human_oversight_enabled: false,
    spending_limits_enabled: false,
    full_governance: false,
  },
  badges: [],
  streak_days: 0,
  last_pe_date: null,
  chains: ['base'],
  callback_url: null,
  linked_human_wallet_id: null,
  linked_human_user_id: null,
  linked_human_address: null,
  parent_wallet_id: null,
  operational_reserve_ratio: null,
  children_wallet_ids: [],
  economic_activity_usd: 0,
  x402_payment_count: 0,
  attestation_count: 0,
  rotation_count: 0,
  status: 'active',
  created_at: Date.now(),
  updated_at: Date.now(),
};

const VALID_BODY: RegisterCapabilitiesRequest = {
  capabilities: ['code-review'],
  description: 'desc',
  availability: 'available',
};

describe('registerCapabilities - hourly_rate_pvt validation', () => {
  it('refuses test-platform agents before any public directory write', async () => {
    const deps = makeMockDeps();
    await expect(
      registerCapabilities(deps, 'wallet_test', { ...TEST_WALLET, platform: 'test' }, VALID_BODY),
    ).rejects.toThrow('test_platform_excluded');
    expect(deps.recordPEAccrual).not.toHaveBeenCalled();
  });

  it('accepts a valid PVT rate string', async () => {
    const deps = makeMockDeps();
    const profile = await registerCapabilities(deps, 'wallet_test', TEST_WALLET, {
      ...VALID_BODY,
      hourly_rate_pvt: (50n * 10n ** 18n).toString(), // 50 PVT/hr
    });
    expect(profile.hourly_rate_pvt).toBe('50000000000000000000');
  });

  it('rejects a non-numeric PVT rate string', async () => {
    const deps = makeMockDeps();
    await expect(
      registerCapabilities(deps, 'wallet_test', TEST_WALLET, {
        ...VALID_BODY,
        hourly_rate_pvt: 'not-a-number',
      }),
    ).rejects.toThrow(/non-negative integer string/);
  });

  it('rejects a fractional PVT rate string (non-integer)', async () => {
    const deps = makeMockDeps();
    await expect(
      registerCapabilities(deps, 'wallet_test', TEST_WALLET, {
        ...VALID_BODY,
        hourly_rate_pvt: '1.5',
      }),
    ).rejects.toThrow(/non-negative integer string/);
  });

  it('accepts a very large well-formed PVT rate without an arbitrary ceiling', async () => {
    // BigInt is arbitrary precision. This value is a 30-digit integer, orders
    // of magnitude beyond any plausible rate. Validation is well-formedness
    // only; the market decides what's reasonable.
    const deps = makeMockDeps();
    const hugeRate = '999999999999999999999999999999';
    const profile = await registerCapabilities(deps, 'wallet_test', TEST_WALLET, {
      ...VALID_BODY,
      hourly_rate_pvt: hugeRate,
    });
    expect(profile.hourly_rate_pvt).toBe(hugeRate);
  });

  it('omits hourly_rate_pvt when not provided', async () => {
    const deps = makeMockDeps();
    const profile = await registerCapabilities(deps, 'wallet_test', TEST_WALLET, VALID_BODY);
    expect(profile.hourly_rate_pvt).toBeUndefined();
  });

  it('treats empty string as absent', async () => {
    const deps = makeMockDeps();
    const profile = await registerCapabilities(deps, 'wallet_test', TEST_WALLET, {
      ...VALID_BODY,
      hourly_rate_pvt: '',
    });
    expect(profile.hourly_rate_pvt).toBeUndefined();
  });

  it('accepts both PVT and USDC rates simultaneously', async () => {
    const deps = makeMockDeps();
    const profile = await registerCapabilities(deps, 'wallet_test', TEST_WALLET, {
      ...VALID_BODY,
      hourly_rate_pvt: (10n * 10n ** 18n).toString(),
      hourly_rate_usdc: 50,
    });
    expect(profile.hourly_rate_pvt).toBe('10000000000000000000');
    expect(profile.hourly_rate_usdc).toBe(50);
  });
});
