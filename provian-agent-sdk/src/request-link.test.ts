import { describe, it, expect, vi } from 'vitest';
import { requestLink } from './request-link';

function fakeFetch(status: number, body: unknown, capture?: (url: string, init: RequestInit) => void) {
  return vi.fn(async (url: string, init: RequestInit) => {
    capture?.(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const BASE = {
  relayUrl: 'https://api.provian.ai',
  walletId: 'wallet_aw_1',
  connectionToken: 'PROV-ABCD-EFGH',
  apiKey: 'pvn_live_key',
  apiSecret: 'pvns_secret',
};

describe('requestLink', () => {
  it('POSTs to the right URL with agent-API-key auth and the connection token in the body', async () => {
    let seenUrl = '';
    let seenInit: RequestInit = {};
    const fetchImpl = fakeFetch(201, { request_id: 'inv_x', status: 'pending' }, (u, i) => { seenUrl = u; seenInit = i; });

    const res = await requestLink({ ...BASE, fetchImpl });

    expect(seenUrl).toBe('https://api.provian.ai/v1/agent/wallet/wallet_aw_1/request-link');
    expect(seenInit.method).toBe('POST');
    expect((seenInit.headers as Record<string, string>).Authorization).toBe('Bearer pvn_live_key:pvns_secret');
    expect(JSON.parse(seenInit.body as string)).toEqual({ connection_token: 'PROV-ABCD-EFGH' });
    expect(res).toEqual({ ok: true, status: 201, requestId: 'inv_x', linkStatus: 'pending' });
  });

  it('reports already_linked', async () => {
    const res = await requestLink({ ...BASE, fetchImpl: fakeFetch(200, { status: 'already_linked' }) });
    expect(res.ok).toBe(true);
    expect(res.linkStatus).toBe('already_linked');
  });

  it('surfaces the relay error code on failure', async () => {
    const res = await requestLink({ ...BASE, fetchImpl: fakeFetch(404, { error: 'connection_token_issuer_unresolved' }) });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(res.error).toBe('connection_token_issuer_unresolved');
  });

  it('trims a trailing slash on the relay URL (no double slash)', async () => {
    let seenUrl = '';
    await requestLink({ ...BASE, relayUrl: 'https://api.provian.ai/', fetchImpl: fakeFetch(201, {}, (u) => { seenUrl = u; }) });
    expect(seenUrl).toBe('https://api.provian.ai/v1/agent/wallet/wallet_aw_1/request-link');
  });

  it('returns a network_error result instead of throwing', async () => {
    const throwing = (async () => { throw new Error('boom'); }) as unknown as typeof fetch;
    const res = await requestLink({ ...BASE, fetchImpl: throwing });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(0);
    expect(res.error).toContain('network_error');
  });
});
