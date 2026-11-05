import {openTestPrivateRequest} from './private-request.test-support';
/**
 * Remote presentation channel — SDK client. Mocks fetch to assert the
 * exact relay URLs + methods + bodies, that the API secret NEVER leaks into a URL
 * or body, and that the manual respondToPresentationRequest wiring burns+presents
 * then posts the token back. Every guard is paired with its RED control :
 * a non-'challenged' request is refused before any money moves, and a request
 * missing its composed challenge is refused.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommonsInstitutions, type CommonsInstitutionsConfig } from './commons-institutions';

const BASE_CONFIG: CommonsInstitutionsConfig = {
  relayUrl: 'https://relay.test',
  walletId: 'wallet_aw_test',
  apiKey: 'pvn_live_abc123',
  apiSecret: 'pvns_' + 'x'.repeat(64),
};

type Call = { url: string; method: string; body: string | undefined; headers: Record<string, string> };

function stubFetch(response: unknown, status = 200): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.stringify(openTestPrivateRequest(JSON.parse(String(init.body)),String(input),init?.headers)) : undefined, headers });
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return response; },
    } as Response;
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function assertNoSecretLeak(calls: Call[]) {
  for (const c of calls) {
    expect(c.url).not.toContain(BASE_CONFIG.apiSecret);
    if (c.body) expect(c.body).not.toContain(BASE_CONFIG.apiSecret);
    // The secret rides ONLY in the Authorization header (Bearer key:secret).
    expect(c.headers.authorization ?? c.headers.Authorization).toContain(BASE_CONFIG.apiSecret);
  }
}

describe('CommonsInstitutions.requestPresentation', () => {
  it('POSTs to /v1/agent/wallet/:id/presentation-request with tier+note and returns the agent-facing request', async () => {
    const { fetch, calls } = stubFetch({ request: { request_id: 'preq_1', status: 'requested', tier: 'reputation', expires_at_ms: 999 } }, 201);
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch });
    const out = await institutions.requestPresentation({ tier: 'reputation', note: 'confirm my standing' });
    expect(out).toEqual({ request_id: 'preq_1', status: 'requested', tier: 'reputation', expires_at_ms: 999 });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://relay.test/v1/agent/wallet/wallet_aw_test/presentation-request');
    expect(JSON.parse(calls[0].body!)).toEqual({ tier: 'reputation', note: 'confirm my standing' });
    assertNoSecretLeak(calls);
  });

  it('omits tier/note from the body when not supplied', async () => {
    const { fetch, calls } = stubFetch({ request: { request_id: 'preq_2', status: 'requested' } }, 201);
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch });
    await institutions.requestPresentation();
    expect(JSON.parse(calls[0].body!)).toEqual({});
  });
});

describe('CommonsInstitutions.listPresentationRequests', () => {
  it('GETs the agent list (with optional status filter) and never returns the note', async () => {
    const { fetch, calls } = stubFetch({ requests: [
      { request_id: 'preq_1', tier: 'reputation', status: 'challenged', audience: 'aud', challenge: 'chal', predicates: [{ field: 'x' }], burn_id: null, presentation_token: null, verdict: null, predicate_results: null },
    ] });
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch });
    const rows = await institutions.listPresentationRequests('challenged');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe('https://relay.test/v1/agent/wallet/wallet_aw_test/presentation-requests?status=challenged');
    expect(rows[0]).not.toHaveProperty('note');
    expect(rows[0].audience).toBe('aud');
    expect(rows[0].challenge).toBe('chal');
    assertNoSecretLeak(calls);
  });
});

describe('CommonsInstitutions.submitPresentationForRequest', () => {
  it('POSTs burn_id + presentation_token to the present-back route', async () => {
    const { fetch, calls } = stubFetch({ request: { request_id: 'preq_1', status: 'presented' } });
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch });
    const out = await institutions.submitPresentationForRequest({ requestId: 'preq_1', burnId: 'b'.repeat(64), presentationToken: 'TOKEN' });
    expect(out).toEqual({ request_id: 'preq_1', status: 'presented' });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://relay.test/v1/agent/wallet/wallet_aw_test/presentation-requests/preq_1/present');
    expect(JSON.parse(calls[0].body!)).toEqual({ burn_id: 'b'.repeat(64), presentation_token: 'TOKEN' });
    assertNoSecretLeak(calls);
  });

  it('RED: throws (no network) on a missing requestId/burnId/token', async () => {
    const { fetch, calls } = stubFetch({});
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch });
    await expect(institutions.submitPresentationForRequest({ requestId: '', burnId: 'b', presentationToken: 't' })).rejects.toThrow(/requestId/);
    await expect(institutions.submitPresentationForRequest({ requestId: 'preq_1', burnId: '', presentationToken: 't' })).rejects.toThrow(/burnId/);
    await expect(institutions.submitPresentationForRequest({ requestId: 'preq_1', burnId: 'b', presentationToken: '' })).rejects.toThrow(/presentationToken/);
    expect(calls).toHaveLength(0); // never touched the network
  });
});

describe('CommonsInstitutions.respondToPresentationRequest (manual convenience)', () => {
  let institutions: CommonsInstitutions;
  let respondSpy: ReturnType<typeof vi.spyOn>;
  let submitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    institutions = new CommonsInstitutions(BASE_CONFIG);
    respondSpy = vi.spyOn(institutions, 'respondToChallenge').mockResolvedValue({
      token: 'TOKEN', tier: 'reputation', burnId: 'burn_1', txHash: '0xburn', burnAmountAtomic: (15n * 10n ** 18n).toString(), presentation: {},
      requesterVerdict: { status: 'unverified', envelope: { audience: 'aud', challenge: 'chal' } },
    });
    submitSpy = vi.spyOn(institutions, 'submitPresentationForRequest').mockResolvedValue({ request_id: 'preq_1', status: 'presented' });
  });

  it('burns+presents the composed challenge, THEN posts the token back (burn before submit)', async () => {
    const out = await institutions.respondToPresentationRequest(
      { request_id: 'preq_1', status: 'challenged', tier: 'reputation', audience: 'aud', challenge: 'chal', predicates: [{ field: 'x', op: 'gte', threshold: 1 }] },
      { privateKeyHex: 'a'.repeat(64), rpcUrl: 'https://rpc.test' },
    );
    expect(out.status).toBe('presented');
    expect(out.token).toBe('TOKEN');
    expect(respondSpy).toHaveBeenCalledWith(
      { audience: 'aud', challenge: 'chal', predicates: [{ field: 'x', op: 'gte', threshold: 1 }] },
      expect.objectContaining({ privateKeyHex: 'a'.repeat(64), rpcUrl: 'https://rpc.test', tier: 'reputation' }),
    );
    expect(submitSpy).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'preq_1', burnId: 'burn_1', presentationToken: 'TOKEN' }));
    expect(respondSpy.mock.invocationCallOrder[0]).toBeLessThan(submitSpy.mock.invocationCallOrder[0]);
  });

  // RED CONTROLS — the guard fires and NOTHING is burned/submitted (no money moves).
  it('RED: refuses a request that is not `challenged` — never burns', async () => {
    await expect(institutions.respondToPresentationRequest(
      { request_id: 'preq_1', status: 'requested', audience: 'aud', challenge: 'chal', predicates: null },
      { privateKeyHex: 'a'.repeat(64), rpcUrl: 'https://rpc.test' },
    )).rejects.toThrow(/'challenged'/);
    expect(respondSpy).not.toHaveBeenCalled();
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('RED: refuses a challenged request missing its composed audience/challenge — never burns', async () => {
    await expect(institutions.respondToPresentationRequest(
      { request_id: 'preq_1', status: 'challenged', audience: null, challenge: null, predicates: null },
      { privateKeyHex: 'a'.repeat(64), rpcUrl: 'https://rpc.test' },
    )).rejects.toThrow(/composed audience/);
    expect(respondSpy).not.toHaveBeenCalled();
    expect(submitSpy).not.toHaveBeenCalled();
  });
});
