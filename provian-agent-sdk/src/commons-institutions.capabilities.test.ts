/**
 * registerCapabilities SDK wrapper.
 *
 * Mirrors the backend's RegisterCapabilitiesRequest validation surface
 * at provian-backend/src/core/agent-bank/directory.ts:25-108. The SDK
 * rejects malformed input client-side; the backend is authoritative on
 * any policy or upsert behavior beyond well-formedness.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CommonsInstitutions,
  ProvianValidationError,
  type CommonsInstitutionsConfig,
  type DirectoryProfile,
} from './commons-institutions';

interface CapturedCall {
  url: string;
  method?: string;
  body?: unknown;
}

function makeMockFetch(responder: (call: CapturedCall) => { status?: number; body: unknown }) {
  const calls: CapturedCall[] = [];
  const mockFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let parsed: unknown = undefined;
    if (typeof init?.body === 'string') {
      try { parsed = JSON.parse(init.body); } catch { parsed = init.body; }
    }
    const call: CapturedCall = { url: String(url), method: init?.method, body: parsed };
    calls.push(call);
    const { status = 200, body } = responder(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
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

const SAMPLE_PROFILE: DirectoryProfile = {
  wallet_id: 'wallet_aw_test',
  agent_id: 'agent_test',
  display_name: 'Test Agent',
  address: '0x' + 'a'.repeat(40),
  capabilities: ['gpu_inference'],
  description: 'A test agent',
  availability: 'available',
  preferred_chains: ['base'],
  pe_count: 42,
  created_at: 1700000000000,
  updated_at: 1700000000000,
};

describe('CommonsInstitutions.registerCapabilities', () => {
  let mock: ReturnType<typeof makeMockFetch>;
  let institutions: CommonsInstitutions;

  beforeEach(() => {
    mock = makeMockFetch(() => ({ body: SAMPLE_PROFILE }));
    institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mock.mockFetch });
  });

  it('POSTs /v1/agents/register-capabilities with the canonical body', async () => {
    const result = await institutions.registerCapabilities({
      capabilities: ['gpu_inference', 'eval_metrics'],
      description: 'Runs inference benchmarks across H100s and reports eval metrics.',
      availability: 'available',
      hourly_rate_pvt: '5000000000000000000',
      preferred_chains: ['base', 'arbitrum'],
    });
    expect(mock.calls[0].url).toBe('https://relay.test/v1/agents/register-capabilities');
    expect(mock.calls[0].method).toBe('POST');
    expect(mock.calls[0].body).toEqual({
      capabilities: ['gpu_inference', 'eval_metrics'],
      description: 'Runs inference benchmarks across H100s and reports eval metrics.',
      availability: 'available',
      hourly_rate_pvt: '5000000000000000000',
      preferred_chains: ['base', 'arbitrum'],
    });
    expect(result.wallet_id).toBe('wallet_aw_test');
  });

  it('omits unset optional fields from the body', async () => {
    await institutions.registerCapabilities({
      capabilities: ['gpu_inference'],
      description: 'Minimal listing for the directory.',
      availability: 'available',
    });
    expect(mock.calls[0].body).toEqual({
      capabilities: ['gpu_inference'],
      description: 'Minimal listing for the directory.',
      availability: 'available',
    });
  });

  it('rejects empty capabilities array at the SDK boundary', async () => {
    await expect(institutions.registerCapabilities({
      capabilities: [],
      description: 'Some description that satisfies the validator.',
      availability: 'available',
    })).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects more than 20 capabilities', async () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => `cap_${i}`);
    await expect(institutions.registerCapabilities({
      capabilities: tooMany,
      description: 'Some description.',
      availability: 'available',
    })).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects a capability longer than 64 chars', async () => {
    await expect(institutions.registerCapabilities({
      capabilities: ['x'.repeat(65)],
      description: 'Some description.',
      availability: 'available',
    })).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects empty description', async () => {
    await expect(institutions.registerCapabilities({
      capabilities: ['gpu_inference'],
      description: '',
      availability: 'available',
    })).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects unknown availability value', async () => {
    await expect(institutions.registerCapabilities({
      capabilities: ['gpu_inference'],
      description: 'Some description.',
      availability: 'invalid' as unknown as 'available',
    })).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects malformed hourly_rate_pvt (not a base-10 integer string)', async () => {
    await expect(institutions.registerCapabilities({
      capabilities: ['gpu_inference'],
      description: 'Some description.',
      availability: 'available',
      hourly_rate_pvt: '5.0',
    })).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects negative hourly_rate_usdc', async () => {
    await expect(institutions.registerCapabilities({
      capabilities: ['gpu_inference'],
      description: 'Some description.',
      availability: 'available',
      hourly_rate_usdc: -1,
    })).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });
});
