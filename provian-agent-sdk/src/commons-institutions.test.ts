import {openTestPrivateRequest} from './private-request.test-support';
/**
 * Workstream 4 - Commons institutions SDK tests.
 *
 * Covers:
 *   - constructor validation (walletId / apiKey / apiSecret required)
 *   - currency-discriminated request validation (well-formedness only)
 *   - request-body shape for each method (PVT and USDC paths)
 *   - payAgentPVT number → atomic-unit conversion + rejection rules
 *   - directory search query construction
 *
 * No arbitrary numeric caps are asserted - the SDK rejects malformed input
 * (non-integer strings, negative values) but does not enforce ceilings.
 * The backend is authoritative on policy.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CommonsInstitutions,
  pvtWholeToAtomic,
  coercePvtAmount,
  ProvianValidationError,
  ProvianAuthError,
  type CommonsInstitutionsConfig,
} from './commons-institutions';

function makeMockFetch() {
  const calls: { url: string; init: RequestInit }[] = [];
  const mockFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    // Return a shape that matches each endpoint's response well enough
    // to satisfy the return-type cast without a per-call switch - none of
    // the tests in this file assert on the response body (they assert on
    // the wire request), so a permissive shape is fine.
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as Response;
  };
  return { mockFetch, calls };
}

const BASE_CONFIG: CommonsInstitutionsConfig = {
  relayUrl: 'https://relay.test',
  walletId: 'wallet_aw_test',
  apiKey: 'pvn_live_abc123',
  apiSecret: 'pvns_' + 'x'.repeat(64),
};

describe('CommonsInstitutions - constructor', () => {
  it('rejects missing relayUrl', () => {
    expect(() => new CommonsInstitutions({ ...BASE_CONFIG, relayUrl: '' })).toThrow(ProvianValidationError);
  });
  it('rejects missing walletId', () => {
    expect(() => new CommonsInstitutions({ ...BASE_CONFIG, walletId: '' })).toThrow(ProvianValidationError);
  });
  it('rejects missing apiKey', () => {
    expect(() => new CommonsInstitutions({ ...BASE_CONFIG, apiKey: '' })).toThrow(ProvianAuthError);
  });
  it('rejects missing apiSecret', () => {
    expect(() => new CommonsInstitutions({ ...BASE_CONFIG, apiSecret: '' })).toThrow(ProvianAuthError);
  });
  it('constructs with valid config', () => {
    expect(() => new CommonsInstitutions(BASE_CONFIG)).not.toThrow();
  });
});

describe('pvtWholeToAtomic', () => {
  it('converts 5 → 5e18', () => {
    expect(pvtWholeToAtomic(5)).toBe('5000000000000000000');
  });
  it('converts 0 → 0', () => {
    expect(pvtWholeToAtomic(0)).toBe('0');
  });
  it('rejects NaN', () => {
    expect(() => pvtWholeToAtomic(NaN)).toThrow(ProvianValidationError);
  });
  it('rejects Infinity', () => {
    expect(() => pvtWholeToAtomic(Infinity)).toThrow(ProvianValidationError);
  });
  it('rejects negative', () => {
    expect(() => pvtWholeToAtomic(-1)).toThrow(ProvianValidationError);
  });
  it('rejects fractional', () => {
    expect(() => pvtWholeToAtomic(1.5)).toThrow(ProvianValidationError);
  });
  it('rejects values past Number.MAX_SAFE_INTEGER (precision-loss boundary)', () => {
    // MAX_SAFE_INTEGER itself is exactly representable; the next integer above
    // it is not. Any plausible whole-PVT amount lives far below this - the
    // check exists to steer callers to bigint/string when they try to pass
    // a quantity large enough to be ambiguous in IEEE 754.
    const tooLarge = Number.MAX_SAFE_INTEGER + 2; // strictly > MAX_SAFE_INTEGER
    expect(() => pvtWholeToAtomic(tooLarge)).toThrow(ProvianValidationError);
  });
});

describe('coercePvtAmount', () => {
  it('accepts bigint', () => {
    expect(coercePvtAmount(42n)).toBe('42');
  });
  it('accepts a BigInt-as-string', () => {
    expect(coercePvtAmount('1000000000000000000')).toBe('1000000000000000000');
  });
  it('accepts whole number → atomic', () => {
    expect(coercePvtAmount(1)).toBe('1000000000000000000');
  });
  it('rejects negative bigint', () => {
    expect(() => coercePvtAmount(-1n)).toThrow(ProvianValidationError);
  });
  it('rejects a non-integer string', () => {
    expect(() => coercePvtAmount('1.5')).toThrow(ProvianValidationError);
  });
  it('rejects a sign-prefixed string', () => {
    expect(() => coercePvtAmount('-5')).toThrow(ProvianValidationError);
  });
  it('accepts a very large well-formed string without a ceiling', () => {
    // BigInt is arbitrary precision. No cap.
    const huge = '999999999999999999999999999999';
    expect(coercePvtAmount(huge)).toBe(huge);
  });
});

describe('createEscrow - PVT path', () => {
  let institutions: CommonsInstitutions;
  let calls: { url: string; init: RequestInit }[];

  beforeEach(() => {
    const mock = makeMockFetch();
    calls = mock.calls;
    institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mock.mockFetch });
  });

  it('posts to /v1/escrow/create with currency: pvt', async () => {
    await institutions.createEscrow({
      currency: 'pvt',
      amount_pvt: '1000000000000000000',
      recipient_wallet_id: 'wallet_recipient',
      description: 'Atlas delivers the protocol spec document',
      deliverables: 'docs/PE_PROTOCOL_SPEC.md',
      deadline_hours: 72,
    });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://relay.test/v1/escrow/create');
    expect(calls[0].init.method).toBe('POST');
    const body = openTestPrivateRequest(JSON.parse(calls[0].init.body as string),calls[0].url,calls[0].init.headers);
    expect(body.currency).toBe('pvt');
    expect(body.amount_pvt).toBe('1000000000000000000');
    expect(body.amount_usdc).toBeUndefined();
    expect(body.depositor_wallet_id).toBe('wallet_aw_test');
    expect(body.recipient_wallet_id).toBe('wallet_recipient');
    expect(body.chain).toBe('base');
  });

  it('rejects a non-integer PVT amount string', async () => {
    await expect(
      institutions.createEscrow({
        currency: 'pvt',
        amount_pvt: '1.5' as unknown as string,
        recipient_wallet_id: 'wallet_r',
        description: 'd',
        deliverables: 'x',
        deadline_hours: 1,
      }),
    ).rejects.toThrow(ProvianValidationError);
  });

  it('accepts a very large well-formed PVT amount', async () => {
    await expect(
      institutions.createEscrow({
        currency: 'pvt',
        amount_pvt: '999999999999999999999999999999',
        recipient_wallet_id: 'wallet_r',
        description: 'long enough description text',
        deliverables: 'x',
        deadline_hours: 24,
      }),
    ).resolves.toBeDefined();
  });
});

describe('createEscrow - USDC path', () => {
  let institutions: CommonsInstitutions;
  let calls: { url: string; init: RequestInit }[];

  beforeEach(() => {
    const mock = makeMockFetch();
    calls = mock.calls;
    institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mock.mockFetch });
  });

  it('posts to /v1/escrow/create with currency: usdc', async () => {
    await institutions.createEscrow({
      currency: 'usdc',
      amount_usdc: 100,
      recipient_wallet_id: 'wallet_r',
      description: 'USDC escrow for testing',
      deliverables: 'x',
      deadline_hours: 24,
    });
    const body = openTestPrivateRequest(JSON.parse(calls[0].init.body as string),calls[0].url,calls[0].init.headers);
    expect(body.currency).toBe('usdc');
    expect(body.amount_usdc).toBe(100);
    expect(body.amount_pvt).toBeUndefined();
  });

  it('rejects negative USDC', async () => {
    await expect(
      institutions.createEscrow({
        currency: 'usdc',
        amount_usdc: -1,
        recipient_wallet_id: 'wallet_r',
        description: 'x',
        deliverables: 'x',
        deadline_hours: 1,
      }),
    ).rejects.toThrow(ProvianValidationError);
  });
});

describe('createPromise - PVT path', () => {
  let institutions: CommonsInstitutions;
  let calls: { url: string; init: RequestInit }[];

  beforeEach(() => {
    const mock = makeMockFetch();
    calls = mock.calls;
    institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mock.mockFetch });
  });

  it('posts borrower_wallet_id + principal_pvt + repay_pvt', async () => {
    await institutions.createPromise({
      currency: 'pvt',
      principal_pvt: '10000000000000000000',
      repay_pvt: '11000000000000000000',
      purpose: 'gpu rental',
      deadline_hours: 168,
    });
    const body = openTestPrivateRequest(JSON.parse(calls[0].init.body as string),calls[0].url,calls[0].init.headers);
    expect(body.borrower_wallet_id).toBe('wallet_aw_test');
    expect(body.currency).toBe('pvt');
    expect(body.principal_pvt).toBe('10000000000000000000');
    expect(body.repay_pvt).toBe('11000000000000000000');
  });

  it('rejects repay < principal', async () => {
    await expect(
      institutions.createPromise({
        currency: 'pvt',
        principal_pvt: '100',
        repay_pvt: '99',
        purpose: 'x',
        deadline_hours: 24,
      }),
    ).rejects.toThrow(/repay_pvt must be ≥ principal_pvt/);
  });
});

describe('createPool - PVT path', () => {
  let institutions: CommonsInstitutions;
  let calls: { url: string; init: RequestInit }[];

  beforeEach(() => {
    const mock = makeMockFetch();
    calls = mock.calls;
    institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mock.mockFetch });
  });

  it('posts creator_wallet_id + threshold_pvt', async () => {
    await institutions.createPool({
      currency: 'pvt',
      threshold_pvt: '50000000000000000000',
      target_address: '0xabc',
      target_description: 'compute cluster rental',
      deadline_hours: 168,
      max_contributors: 25,
    });
    const body = openTestPrivateRequest(JSON.parse(calls[0].init.body as string),calls[0].url,calls[0].init.headers);
    expect(body.creator_wallet_id).toBe('wallet_aw_test');
    expect(body.threshold_pvt).toBe('50000000000000000000');
    expect(body.threshold_usdc).toBeUndefined();
  });
});

describe('postJob - PVT path', () => {
  let institutions: CommonsInstitutions;
  let calls: { url: string; init: RequestInit }[];

  beforeEach(() => {
    const mock = makeMockFetch();
    calls = mock.calls;
    institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mock.mockFetch });
  });

  it('posts currency + budget_pvt', async () => {
    await institutions.postJob({
      currency: 'pvt',
      budget_pvt: '100000000000000000000',
      title: 'Benchmark a model',
      description: 'Run MMLU on claude-opus-4-7',
      required_capabilities: ['gpu_inference'],
      deadline_hours: 72,
    });
    // postJob re-points onto the ONE Commons board (the agent-only board answers 410).
    expect(calls[0].url).toBe('https://relay.test/v1/commons/jobs/post');
    const body = openTestPrivateRequest(JSON.parse(calls[0].init.body as string),calls[0].url,calls[0].init.headers);
    expect(body.currency).toBe('pvt');
    expect(body.budget_pvt).toBe('100000000000000000000');
    expect(body.budget_usdc).toBeUndefined();
    expect(body.skills_required).toEqual(['gpu_inference']);
    expect(body.required_capabilities).toBeUndefined();
    expect(body.seeking).toBe('agent');
  });
});

describe('searchAgents', () => {
  let institutions: CommonsInstitutions;
  let calls: { url: string; init: RequestInit }[];

  beforeEach(() => {
    const mock = makeMockFetch();
    calls = mock.calls;
    institutions = new CommonsInstitutions({
      ...BASE_CONFIG,
      fetch: async (url, init) => {
        mock.calls.push({ url: String(url), init: init ?? {} });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            agents: [
              {
                wallet_id: 'w1',
                agent_id: 'a1',
                display_name: 'Atlas',
                address: '0x1',
                capabilities: ['code'],
                description: 'd',
                availability: 'available',
                hourly_rate_pvt: '5000000000000000000',
                hourly_rate_usdc: 10,
                preferred_chains: ['base'],
                pe_count: 1200,
                created_at: 0,
                updated_at: 0,
              },
            ],
          }),
        } as Response;
      },
    });
  });

  it('builds the query string correctly and returns rate fields', async () => {
    const profiles = await institutions.searchAgents({
      capability: 'code',
      limit: 10,
    });
    expect(calls[0].url).toContain('/v1/agents/directory');
    expect(calls[0].url).toContain('capability=code');
    expect(calls[0].url).toContain('limit=10');
    expect(profiles[0].hourly_rate_pvt).toBe('5000000000000000000');
    expect(profiles[0].hourly_rate_usdc).toBe(10);
  });
});

describe('payAgentPVT', () => {
  let institutions: CommonsInstitutions;
  let calls: { url: string; init: RequestInit }[];

  beforeEach(() => {
    const mock = makeMockFetch();
    calls = mock.calls;
    institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mock.mockFetch });
  });

  it('converts whole PVT (number) to atomic units', async () => {
    await institutions.payAgentPVT({
      recipientWalletId: 'wallet_r',
      amount: 5,
      memo: 'coffee for Atlas - morning coding session',
    });
    const body = openTestPrivateRequest(JSON.parse(calls[0].init.body as string),calls[0].url,calls[0].init.headers);
    expect(body.currency).toBe('pvt');
    expect(body.amount_pvt).toBe('5000000000000000000');
    expect(body.deliverables).toBe('agent_payment');
    expect(body.auto_release_hours).toBe(24);
    expect(body.chain).toBe('base');
  });

  it('accepts bigint directly', async () => {
    await institutions.payAgentPVT({
      recipientWalletId: 'wallet_r',
      amount: 7000000000000000000n,
      memo: 'payment for signal corroboration work',
    });
    const body = openTestPrivateRequest(JSON.parse(calls[0].init.body as string),calls[0].url,calls[0].init.headers);
    expect(body.amount_pvt).toBe('7000000000000000000');
  });

  it('accepts a BigInt-as-string', async () => {
    await institutions.payAgentPVT({
      recipientWalletId: 'wallet_r',
      amount: '1234567890000000000',
      memo: 'payment for early-stage code review',
    });
    const body = openTestPrivateRequest(JSON.parse(calls[0].init.body as string),calls[0].url,calls[0].init.headers);
    expect(body.amount_pvt).toBe('1234567890000000000');
  });

  it('rejects memo shorter than 20 chars', async () => {
    await expect(
      institutions.payAgentPVT({
        recipientWalletId: 'wallet_r',
        amount: 1,
        memo: 'short',
      }),
    ).rejects.toThrow(/≥ 20 chars/);
  });

  it('rejects missing recipientWalletId', async () => {
    await expect(
      institutions.payAgentPVT({
        recipientWalletId: '',
        amount: 1,
        memo: 'this memo is plenty long enough',
      }),
    ).rejects.toThrow(/recipientWalletId/);
  });

  it('rejects a fractional number amount (steers to bigint/string)', async () => {
    await expect(
      institutions.payAgentPVT({
        recipientWalletId: 'wallet_r',
        amount: 1.5,
        memo: 'memo long enough for validation',
      }),
    ).rejects.toThrow(/whole number|fractional|bigint/i);
  });

  it('rejects a negative bigint', async () => {
    await expect(
      institutions.payAgentPVT({
        recipientWalletId: 'wallet_r',
        amount: -1n,
        memo: 'negative amount test case here',
      }),
    ).rejects.toThrow(/non-negative/);
  });
});

// ---------------------------------------------------------------------------
// Type-level tests - confirm the discriminated union rejects mixed-currency
// shapes at compile time. These are `any` cast smoke tests that the TS
// compiler flags before the test runs. If typechecking passes and the
// following assignments are commented out, we know the compiler accepted
// them (which would be a bug); if they must stay commented to pass tsc, the
// union is doing its job.
// ---------------------------------------------------------------------------

describe('types - discriminated currency union', () => {
  it('rejects { currency: "pvt", amount_usdc: X } at compile time (runtime smoke test)', async () => {
    // Runtime proxy for a compile-time check - if someone accidentally
    // widens the union, validateEscrowRequest still rejects via the
    // "no amount_pvt present" path, surfacing the bug at runtime too.
    const bad = {
      currency: 'pvt',
      amount_usdc: 100,  // wrong key for 'pvt' branch
      recipient_wallet_id: 'wallet_r',
      description: 'description long enough for validator',
      deliverables: 'x',
      deadline_hours: 24,
    } as unknown as import('./commons-institutions').CreateEscrowRequest;
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: makeMockFetch().mockFetch });
    // amount_pvt is missing → validator fails
    await expect(() => institutions.createEscrow(bad)).rejects.toThrow(ProvianValidationError);
  });
});
