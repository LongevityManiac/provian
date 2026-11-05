/**
 * Escrow fund + complete SDK wrappers.
 *
 * Both endpoints share the same auth model as every other CommonsInstitutions
 * method (Bearer apiKey:apiSecret). Funding requires the depositor to
 * have already broadcast the on-chain transfer; the SDK does not sign
 * EVM transactions for non-payAgentPVT flows.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CommonsInstitutions,
  ProvianValidationError,
  ProvianAuthError,
  ProvianNetworkError,
  type CommonsInstitutionsConfig,
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

const VALID_TX_HASH = '0x' + 'a'.repeat(64);

describe('CommonsInstitutions.fundEscrow', () => {
  let mock: ReturnType<typeof makeMockFetch>;
  let institutions: CommonsInstitutions;

  beforeEach(() => {
    mock = makeMockFetch(() => ({
      body: {
        escrow_id: 'escrow_test_456',
        status: 'funded',
        funded_at: '2026-05-05T11:00:00.000Z',
        fund_tx_hash: VALID_TX_HASH,
      },
    }));
    institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mock.mockFetch });
  });

  it('POSTs /v1/escrow/:id/fund with tx_hash in the body', async () => {
    const result = await institutions.fundEscrow('escrow_test_456', { tx_hash: VALID_TX_HASH });
    expect(mock.calls[0].url).toBe('https://relay.test/v1/escrow/escrow_test_456/fund');
    expect(mock.calls[0].method).toBe('POST');
    expect(mock.calls[0].body).toEqual({ tx_hash: VALID_TX_HASH });
    expect(result.status).toBe('funded');
    expect(result.fund_tx_hash).toBe(VALID_TX_HASH);
  });

  it('rejects empty escrowId at the SDK boundary', async () => {
    await expect(institutions.fundEscrow('', { tx_hash: VALID_TX_HASH })).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects empty tx_hash', async () => {
    await expect(institutions.fundEscrow('escrow_test_456', { tx_hash: '' })).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects malformed tx_hash (not 0x-prefixed 32-byte hex)', async () => {
    await expect(institutions.fundEscrow('escrow_test_456', { tx_hash: 'not-a-hash' })).rejects.toThrow(ProvianValidationError);
    await expect(institutions.fundEscrow('escrow_test_456', { tx_hash: '0x' + 'a'.repeat(63) })).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });

  it('surfaces 400 from the relay (bad tx_hash) as ProvianNetworkError with status 400', async () => {
    mock = makeMockFetch(() => ({ status: 400, body: { error: 'tx_hash does not match expected escrow contract' } }));
    institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mock.mockFetch });
    await expect(institutions.fundEscrow('escrow_test_456', { tx_hash: VALID_TX_HASH })).rejects.toMatchObject({
      name: 'ProvianNetworkError',
      httpStatus: 400,
    });
  });
});

describe('CommonsInstitutions.completeEscrow', () => {
  let mock: ReturnType<typeof makeMockFetch>;
  let institutions: CommonsInstitutions;

  beforeEach(() => {
    mock = makeMockFetch(() => ({
      body: {
        escrow_id: 'escrow_test_456',
        status: 'completed',
        completed_at: '2026-05-05T12:00:00.000Z',
      },
    }));
    institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mock.mockFetch });
  });

  it('POSTs /v1/escrow/:id/complete with empty body', async () => {
    const result = await institutions.completeEscrow('escrow_test_456');
    expect(mock.calls[0].url).toBe('https://relay.test/v1/escrow/escrow_test_456/complete');
    expect(mock.calls[0].method).toBe('POST');
    expect(mock.calls[0].body).toEqual({});
    expect(result.status).toBe('completed');
  });

  it('rejects empty escrowId', async () => {
    await expect(institutions.completeEscrow('')).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });

  it('surfaces 403 (non-depositor caller) as ProvianAuthError', async () => {
    mock = makeMockFetch(() => ({ status: 403, body: { error: 'Only the depositor can complete the escrow' } }));
    institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mock.mockFetch });
    await expect(institutions.completeEscrow('escrow_test_456')).rejects.toThrow(ProvianAuthError);
  });

  it('surfaces 400 (escrow not in funded state) as ProvianNetworkError', async () => {
    mock = makeMockFetch(() => ({ status: 400, body: { error: 'Escrow status is created, expected funded' } }));
    institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mock.mockFetch });
    await expect(institutions.completeEscrow('escrow_test_456')).rejects.toMatchObject({
      name: 'ProvianNetworkError',
      httpStatus: 400,
    });
  });
});
