/**
 * CommonsInstitutions.inviteDevice tests.
 *
 * Covers:
 *   - POSTs to /v1/agent/wallet/:walletId/device-invite with Bearer
 *     pvn_live_:pvns_ auth.
 *   - body shape { email, device_name?, message? } (optional fields omitted).
 *   - maps the relay response { sent, expires_at } → { sent, expiresAt }.
 *   - the result never carries the token (contract is { sent, expires_at } only).
 *   - email validation (regex + length) before the network call.
 */

import { describe, it, expect } from 'vitest';
import { CommonsInstitutions, ProvianValidationError, type CommonsInstitutionsConfig } from './commons-institutions';

const BASE_CONFIG: CommonsInstitutionsConfig = {
  relayUrl: 'https://relay.test',
  walletId: 'wallet_aw_test',
  apiKey: 'pvn_live_abc123',
  apiSecret: 'pvns_' + 'x'.repeat(64),
};

function makeMockFetch(json: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const mockFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    return {
      ok: true,
      status: 200,
      json: async () => json,
    } as Response;
  };
  return { mockFetch, calls };
}

describe('CommonsInstitutions.inviteDevice', () => {
  it('POSTs to /v1/agent/wallet/:walletId/device-invite with agent auth', async () => {
    const { mockFetch, calls } = makeMockFetch({ sent: true, expires_at: 1_700_000_000_000 });
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch as unknown as typeof fetch });

    const res = await institutions.inviteDevice({ email: 'bob@example.com' });

    expect(res).toEqual({ sent: true, expiresAt: 1_700_000_000_000 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://relay.test/v1/agent/wallet/wallet_aw_test/device-invite');
    expect(calls[0].init.method).toBe('POST');
    const auth = (calls[0].init.headers as Record<string, string>).Authorization;
    expect(auth).toBe('Bearer pvn_live_abc123:pvns_' + 'x'.repeat(64));
  });

  it('sends { email } only, adding device_name / message when provided', async () => {
    const { mockFetch, calls } = makeMockFetch({ sent: true, expires_at: 1 });
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch as unknown as typeof fetch });

    await institutions.inviteDevice({ email: 'bob@example.com', deviceName: 'CI box', message: 'hi' });
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toEqual({ email: 'bob@example.com', device_name: 'CI box', message: 'hi' });
  });

  it('omits optional fields when not provided', async () => {
    const { mockFetch, calls } = makeMockFetch({ sent: true, expires_at: 1 });
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch as unknown as typeof fetch });

    await institutions.inviteDevice({ email: 'bob@example.com' });
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toEqual({ email: 'bob@example.com' });
  });

  it('trims the email before sending', async () => {
    const { mockFetch, calls } = makeMockFetch({ sent: true, expires_at: 1 });
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch as unknown as typeof fetch });

    await institutions.inviteDevice({ email: '  bob@example.com  ' });
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.email).toBe('bob@example.com');
  });

  it('never surfaces a token field from the response', async () => {
    const { mockFetch } = makeMockFetch({ sent: true, expires_at: 9, token: 'leaked' });
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch as unknown as typeof fetch });

    const res = await institutions.inviteDevice({ email: 'bob@example.com' });
    expect(res).toEqual({ sent: true, expiresAt: 9 });
    expect(JSON.stringify(res)).not.toContain('leaked');
  });

  it('rejects a missing email before the network call', async () => {
    const { mockFetch, calls } = makeMockFetch({ sent: true, expires_at: 1 });
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch as unknown as typeof fetch });

    await expect(institutions.inviteDevice({ email: '' })).rejects.toThrow(ProvianValidationError);
    expect(calls).toHaveLength(0);
  });

  it('rejects a malformed email before the network call', async () => {
    const { mockFetch, calls } = makeMockFetch({ sent: true, expires_at: 1 });
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch as unknown as typeof fetch });

    await expect(institutions.inviteDevice({ email: 'not-an-email' })).rejects.toThrow(ProvianValidationError);
    expect(calls).toHaveLength(0);
  });

  it('rejects an over-length email before the network call', async () => {
    const { mockFetch, calls } = makeMockFetch({ sent: true, expires_at: 1 });
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch as unknown as typeof fetch });

    await expect(
      institutions.inviteDevice({ email: 'a'.repeat(250) + '@x.io' }),
    ).rejects.toThrow(ProvianValidationError);
    expect(calls).toHaveLength(0);
  });
});
