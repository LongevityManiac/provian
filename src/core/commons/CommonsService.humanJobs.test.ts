/**
 * C6 / C7 (Pass-2 Human-Jobs seams): the new authenticated human-jobs reads.
 *
 * C7: getMyHumanJobs must hit the authenticated, server-scoped /jobs/mine
 *     (NOT a public browse) so the "Mine"/"Completed" tabs only ever show the
 *     caller's own jobs.
 * C6: getHumanJobApplications must hit the per-job applications endpoint with
 *     auth, so the management UI can list applicants.
 *
 * A Commons session token is seeded so getAuthHeaders short-circuits to a Bearer
 * header (the deterministic auth path that doesn't pull in RelayAPIService).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as SecureStore from 'expo-secure-store';
import * as CommonsService from './CommonsService';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Typed fetch stub so .mock.calls[0] destructures as [url, init] under tsc.
function makeFetchMock(body: unknown) {
  return vi.fn((_url: string, _init?: RequestInit): Promise<Response> =>
    Promise.resolve(jsonResponse(body)),
  );
}

describe('CommonsService human-jobs authenticated reads', () => {
  beforeEach(async () => {
    await SecureStore.setItemAsync('commons_session_token', 'sess_token_123');
  });
  afterEach(async () => {
    await SecureStore.deleteItemAsync('commons_session_token');
    vi.unstubAllGlobals();
  });

  it('getMyHumanJobs (C7) GETs the authenticated /jobs/mine with query + Bearer', async () => {
    const fetchMock = makeFetchMock({
      posted: [{ job_id: 'A' }],
      assigned: [{ job_id: 'C' }],
      total: 2,
      has_more: false,
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await CommonsService.getMyHumanJobs({ status: 'completed' });
    expect(res.posted[0].job_id).toBe('A');
    expect(res.assigned[0].job_id).toBe('C');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url.endsWith('/v1/commons/jobs/mine?status=completed')).toBe(true);
    expect(init?.method).toBe('GET');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sess_token_123');
  });

  it('getMyHumanJobs hits /jobs/mine with no query when called bare', async () => {
    const fetchMock = makeFetchMock({ posted: [], assigned: [], total: 0, has_more: false });
    vi.stubGlobal('fetch', fetchMock);

    await CommonsService.getMyHumanJobs();
    const [url] = fetchMock.mock.calls[0];
    expect(url.endsWith('/v1/commons/jobs/mine')).toBe(true);
  });

  it('getHumanJobApplications (C6) GETs the per-job applications endpoint with Bearer', async () => {
    const fetchMock = makeFetchMock({ applications: [] });
    vi.stubGlobal('fetch', fetchMock);

    await CommonsService.getHumanJobApplications('hjob_42');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url.endsWith('/v1/commons/jobs/hjob_42/applications')).toBe(true);
    expect(init?.method).toBe('GET');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sess_token_123');
  });
});
