/**
 * PVT Base-only chain guard.
 *
 * The relay consolidates PVT principal on Base and rejects PVT on
 * Arbitrum/Optimism (provian-backend/src/core/agent-bank/pvt-principal-config.ts,
 * isPvtPrincipalEnabledForChain, default allowlist = Base-only). The SDK
 * mirrors that allowlist via PVT_PRINCIPAL_CHAINS and fails a misrouted PVT
 * request client-side, before the network round trip, instead of letting the
 * relay 400 it. USDC stays available on every chain.
 *
 * These tests assert:
 *   - PVT + an explicit non-Base chain throws and NEVER hits the network
 *   - PVT + Base (explicit or default) succeeds
 *   - USDC + any chain is unaffected by the guard
 *   - the guard covers all chain-bearing primitives: escrow, promise, pool,
 *     and the payAgentPVT convenience wrapper (which routes through escrow)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CommonsInstitutions,
  ProvianValidationError,
  PVT_PRINCIPAL_CHAINS,
  type CommonsInstitutionsConfig,
} from './commons-institutions';

interface CapturedCall {
  url: string;
  method?: string;
  body?: Record<string, unknown>;
}

function makeMockFetch() {
  const calls: CapturedCall[] = [];
  const mockFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let parsed: Record<string, unknown> | undefined;
    if (typeof init?.body === 'string') {
      try { parsed = JSON.parse(init.body) as Record<string, unknown>; } catch { parsed = undefined; }
    }
    calls.push({ url: String(url), method: init?.method, body: parsed });
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

const ONE_PVT = '1000000000000000000';

describe('PVT_PRINCIPAL_CHAINS', () => {
  it('is Base-only, mirroring the relay default allowlist', () => {
    expect([...PVT_PRINCIPAL_CHAINS]).toEqual(['base']);
  });
});

describe('CommonsInstitutions PVT Base-only guard', () => {
  let mock: ReturnType<typeof makeMockFetch>;
  let institutions: CommonsInstitutions;

  beforeEach(() => {
    mock = makeMockFetch();
    institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mock.mockFetch });
  });

  // --- Rejected: PVT on a non-Base chain, before any network call ---

  for (const chain of ['arbitrum', 'optimism'] as const) {
    it(`rejects a PVT escrow on '${chain}' without hitting the network`, async () => {
      await expect(
        institutions.createEscrow({
          currency: 'pvt',
          amount_pvt: ONE_PVT,
          recipient_wallet_id: 'wallet_aw_xyz',
          description: 'PVT escrow that should be blocked client-side',
          deliverables: 'spec.md',
          deadline_hours: 72,
          chain,
        }),
      ).rejects.toBeInstanceOf(ProvianValidationError);
      expect(mock.calls).toHaveLength(0);
    });

    it(`rejects a PVT promise on '${chain}'`, async () => {
      await expect(
        institutions.createPromise({
          currency: 'pvt',
          principal_pvt: ONE_PVT,
          repay_pvt: ONE_PVT,
          purpose: 'gpu rental that should be blocked client-side',
          deadline_hours: 168,
          chain,
        }),
      ).rejects.toBeInstanceOf(ProvianValidationError);
      expect(mock.calls).toHaveLength(0);
    });

    it(`rejects a PVT pool on '${chain}'`, async () => {
      await expect(
        institutions.createPool({
          currency: 'pvt',
          threshold_pvt: ONE_PVT,
          target_address: '0xabc',
          target_description: 'cluster rental that should be blocked client-side',
          deadline_hours: 168,
          max_contributors: 10,
          chain,
        }),
      ).rejects.toBeInstanceOf(ProvianValidationError);
      expect(mock.calls).toHaveLength(0);
    });

    it(`rejects payAgentPVT on '${chain}' (routes through escrow)`, async () => {
      await expect(
        institutions.payAgentPVT({
          recipientWalletId: 'wallet_aw_xyz',
          amount: 5,
          memo: 'payment that should be blocked client-side',
          chain,
        }),
      ).rejects.toBeInstanceOf(ProvianValidationError);
      expect(mock.calls).toHaveLength(0);
    });
  }

  it('error names the offending chain and Base', async () => {
    await expect(
      institutions.createEscrow({
        currency: 'pvt',
        amount_pvt: ONE_PVT,
        recipient_wallet_id: 'wallet_aw_xyz',
        description: 'PVT escrow that should be blocked client-side',
        deliverables: 'spec.md',
        deadline_hours: 72,
        chain: 'arbitrum',
      }),
    ).rejects.toThrow(/PVT is only available on base.*arbitrum/i);
  });

  // --- Allowed: PVT on Base (explicit or defaulted) ---

  it('allows a PVT escrow on explicit base', async () => {
    await institutions.createEscrow({
      currency: 'pvt',
      amount_pvt: ONE_PVT,
      recipient_wallet_id: 'wallet_aw_xyz',
      description: 'PVT escrow on base, should succeed',
      deliverables: 'spec.md',
      deadline_hours: 72,
      chain: 'base',
    });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].body).toMatchObject({ currency: 'pvt', chain: 'base', amount_pvt: ONE_PVT });
  });

  it('allows a PVT escrow when chain is omitted (defaults to base)', async () => {
    await institutions.createEscrow({
      currency: 'pvt',
      amount_pvt: ONE_PVT,
      recipient_wallet_id: 'wallet_aw_xyz',
      description: 'PVT escrow with default chain, should succeed',
      deliverables: 'spec.md',
      deadline_hours: 72,
    });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].body).toMatchObject({ currency: 'pvt', chain: 'base' });
  });

  it('allows payAgentPVT on default base', async () => {
    await institutions.payAgentPVT({
      recipientWalletId: 'wallet_aw_xyz',
      amount: 5,
      memo: 'payment on base, should succeed',
    });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].body).toMatchObject({ currency: 'pvt', chain: 'base' });
  });

  // --- USDC is unaffected by the PVT guard ---

  it('allows a USDC escrow on arbitrum (guard is PVT-only)', async () => {
    await institutions.createEscrow({
      currency: 'usdc',
      amount_usdc: 100,
      recipient_wallet_id: 'wallet_aw_xyz',
      description: 'USDC escrow on arbitrum, should succeed',
      deliverables: 'spec.md',
      deadline_hours: 72,
      chain: 'arbitrum',
    });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].body).toMatchObject({ currency: 'usdc', chain: 'arbitrum' });
  });

  it('allows a USDC pool on optimism', async () => {
    await institutions.createPool({
      currency: 'usdc',
      threshold_usdc: 1000,
      target_address: '0xabc',
      target_description: 'USDC pool on optimism, should succeed',
      deadline_hours: 168,
      max_contributors: 10,
      chain: 'optimism',
    });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].body).toMatchObject({ currency: 'usdc', chain: 'optimism' });
  });
});
