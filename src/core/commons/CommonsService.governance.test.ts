/**
 * Pass-2 WS-Commons #33 — the "PE Types" tab hits the right endpoint.
 *
 * getPETypeProposals must GET /v1/commons/governance/pe-types (the dedicated,
 * live-catalog-backed route). The old wiring abused
 * getGovernanceProposals('pe_type') → /governance/proposals?status=pe_type,
 * an invalid economic-proposal status that always returned empty.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as CommonsService from './CommonsService';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeFetchMock(body: unknown) {
  return vi.fn((_url: string, _init?: RequestInit): Promise<Response> =>
    Promise.resolve(jsonResponse(body)),
  );
}

describe('CommonsService.getPETypeProposals (#33)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GETs /v1/commons/governance/pe-types (NOT the economic-proposals route)', async () => {
    const fetchMock = makeFetchMock({
      proposals: [
        {
          proposal_id: 'custom_signal',
          action_type: 'custom_signal',
          description: 'A custom corroboration signal',
          use_case: 'Third-party attestation',
          upvotes: 5,
          status: 'active',
          proposer_wallet_id: 'wal_author',
          created_at: 200,
        },
      ],
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await CommonsService.getPETypeProposals();
    expect(res.proposals[0].action_type).toBe('custom_signal');
    // proposal_id == action_type so the upvote endorses the right catalog entry.
    expect(res.proposals[0].proposal_id).toBe('custom_signal');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url.endsWith('/v1/commons/governance/pe-types')).toBe(true);
    expect(url).not.toContain('status=pe_type');
    expect(init?.method).toBe('GET');
  });
});
