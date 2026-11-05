import {openTestPrivateRequest} from './private-request.test-support';
/**
 * Agent-to-agent jobs lifecycle SDK wrappers.
 *
 * the agent-only `/v1/jobs` board folded into the ONE Commons board. postJob /
 * listAvailableJobs / applyToJob / acceptApplicant re-point there (asserted below);
 * deliverJob / getMyJobs stay on `/v1/jobs` for in-flight legacy jobs.
 *
 * Each test asserts on the wire request the SDK constructs (URL, method,
 * body, query params) and the parsing of the response into the typed
 * return shape. Backend behavior is owned by provian-backend and is
 * exercised by its own tests; here we verify the SDK transport contract.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CommonsInstitutions,
  ProvianValidationError,
  ProvianAuthError,
  ProvianNetworkError,
  type CommonsInstitutionsConfig,
  type JobResponse,
  type AcceptApplicantResponse,
  type MyJobsResponse,
} from './commons-institutions';

interface CapturedCall {
  url: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

function makeMockFetch(responder: (call: CapturedCall) => { status?: number; body: unknown }) {
  const calls: CapturedCall[] = [];
  const mockFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let parsed: unknown = undefined;
    if (typeof init?.body === 'string') {
      try { parsed = openTestPrivateRequest(JSON.parse(init.body),String(url),init.headers); } catch { parsed = init.body; }
    }
    const call: CapturedCall = {
      url: String(url),
      method: init?.method,
      body: parsed,
      headers: { ...(init?.headers as Record<string, string> | undefined) },
    };
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

const SAMPLE_JOB: JobResponse = {
  job_id: 'job_test_123',
  poster_wallet_id: 'wallet_aw_test',
  title: 'Benchmark a model',
  description: 'Run inference benchmarks across three GPUs',
  required_capabilities: ['gpu_inference'],
  currency: 'usdc',
  budget_usdc: 100,
  deadline_hours: 48,
  deadline: 1700000000000,
  status: 'open',
  applications: [],
  pe_ids: ['pe_123'],
  created_at: 1700000000000,
  updated_at: 1700000000000,
};

describe('CommonsInstitutions.listAvailableJobs', () => {
  let mock: ReturnType<typeof makeMockFetch>;
  let institutions: CommonsInstitutions;

  beforeEach(() => {
    mock = makeMockFetch(() => ({ body: { jobs: [SAMPLE_JOB], count: 1 } }));
    institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mock.mockFetch });
  });

  it('re-points to GET /v1/commons/jobs?seeking=agent&status=open (the agent-only board folded)', async () => {
    const result = await institutions.listAvailableJobs();
    expect(mock.calls[0].url).toBe('https://relay.test/v1/commons/jobs?status=open&seeking=agent');
    expect(mock.calls[0].method).toBe('GET');
    expect(result.jobs).toHaveLength(1);
    expect(result.count).toBe(1);
  });

  it('maps limit → page_size and offset through to the Commons board', async () => {
    await institutions.listAvailableJobs({ limit: 20, offset: 10 });
    const url = mock.calls[0].url;
    expect(url.startsWith('https://relay.test/v1/commons/jobs?')).toBe(true);
    expect(url).toContain('page_size=20');
    expect(url).toContain('offset=10');
  });

  // RED control for the "never silently drop a filter" rule: re-point listAvailableJobs to
  // forward `capability` (or ignore it) and this goes red — the Commons board has no such
  // filter, so a dropped one would return jobs the caller asked to exclude.
  it('REFUSES the old board-only filters (capability) instead of silently dropping them', async () => {
    await expect(institutions.listAvailableJobs({ capability: 'gpu_inference' })).rejects.toThrow(/capability is not supported/);
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects negative min_budget at the SDK boundary', async () => {
    await expect(institutions.listAvailableJobs({ min_budget: -1 })).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects non-integer limit', async () => {
    await expect(institutions.listAvailableJobs({ limit: 1.5 })).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects negative offset', async () => {
    await expect(institutions.listAvailableJobs({ offset: -1 })).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });

  it('maps page → offset (page 3 of 25 → offset 50) and refuses max_budget / sort', async () => {
    await institutions.listAvailableJobs({ page: 3, limit: 25 });
    expect(mock.calls[0].url).toContain('offset=50');
    expect(mock.calls[0].url).toContain('page_size=25');
    await expect(institutions.listAvailableJobs({ max_budget: 500 })).rejects.toThrow(/max_budget is not supported/);
    await expect(institutions.listAvailableJobs({ sort: 'budget_desc' })).rejects.toThrow(/sort is not supported/);
    expect(mock.calls).toHaveLength(1);
  });

  it('rejects max_budget < min_budget at the SDK boundary', async () => {
    await expect(institutions.listAvailableJobs({ min_budget: 100, max_budget: 50 })).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects negative max_budget', async () => {
    await expect(institutions.listAvailableJobs({ max_budget: -1 })).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects non-positive page', async () => {
    await expect(institutions.listAvailableJobs({ page: 0 })).rejects.toThrow(ProvianValidationError);
    await expect(institutions.listAvailableJobs({ page: 1.5 })).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });

  it('surfaces 401 from the relay as ProvianAuthError', async () => {
    mock = makeMockFetch(() => ({ status: 401, body: { error: 'Authentication required' } }));
    institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mock.mockFetch });
    await expect(institutions.listAvailableJobs()).rejects.toThrow(ProvianAuthError);
  });
});

describe('CommonsInstitutions.applyToJob', () => {
  let mock: ReturnType<typeof makeMockFetch>;
  let institutions: CommonsInstitutions;

  beforeEach(() => {
    mock = makeMockFetch(() => ({ body: SAMPLE_JOB }));
    institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mock.mockFetch });
  });

  it('re-points to POST /v1/commons/jobs/:id/apply with the proposal as the cover_note', async () => {
    await institutions.applyToJob('hjob_test_123', { proposal: 'I have run this exact benchmark on H100s twice this month.' });
    expect(mock.calls[0].url).toBe('https://relay.test/v1/commons/jobs/hjob_test_123/apply');
    expect(mock.calls[0].method).toBe('POST');
    expect(mock.calls[0].body).toEqual({ cover_note: 'I have run this exact benchmark on H100s twice this month.' });
  });

  it('url-encodes the jobId path segment', async () => {
    await institutions.applyToJob('job/with slash', { proposal: 'sufficiently long proposal text for the validator.' });
    expect(mock.calls[0].url).toBe('https://relay.test/v1/commons/jobs/job%2Fwith%20slash/apply');
  });

  it('rejects empty proposal at the SDK boundary', async () => {
    await expect(institutions.applyToJob('job_test_123', { proposal: '' })).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects proposal longer than 1000 chars', async () => {
    await expect(institutions.applyToJob('job_test_123', { proposal: 'x'.repeat(1001) })).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });

  it('surfaces 404 from the relay as ProvianNetworkError with status 404', async () => {
    mock = makeMockFetch(() => ({ status: 404, body: { error: 'Job not found' } }));
    institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mock.mockFetch });
    await expect(
      institutions.applyToJob('job_missing', { proposal: 'long enough proposal text to satisfy the validator.' }),
    ).rejects.toMatchObject({ name: 'ProvianNetworkError', httpStatus: 404 });
  });
});

describe('CommonsInstitutions.acceptApplicant', () => {
  let mock: ReturnType<typeof makeMockFetch>;
  let institutions: CommonsInstitutions;
  const acceptResponse: AcceptApplicantResponse = {
    job: { ...SAMPLE_JOB, status: 'assigned', assigned_wallet_id: 'wallet_aw_worker' } as unknown as JobResponse,
    escrow_id: 'escrow_test_456',
  };

  beforeEach(() => {
    mock = makeMockFetch(() => ({ body: acceptResponse }));
    institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mock.mockFetch });
  });

  it('re-points to POST /v1/commons/jobs/:id/accept { applicant_wallet_id } and returns escrow_id', async () => {
    const result = await institutions.acceptApplicant('hjob_test_123', 'wallet_aw_worker');
    expect(mock.calls[0].url).toBe('https://relay.test/v1/commons/jobs/hjob_test_123/accept');
    expect(mock.calls[0].method).toBe('POST');
    expect(mock.calls[0].body).toEqual({ applicant_wallet_id: 'wallet_aw_worker' });
    expect(result.escrow_id).toBe('escrow_test_456');
  });

  it('rejects missing jobId', async () => {
    await expect(institutions.acceptApplicant('', 'wallet_aw_worker')).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects missing applicantWalletId', async () => {
    await expect(institutions.acceptApplicant('job_test_123', '')).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });

  it('surfaces 403 from the relay as ProvianAuthError', async () => {
    mock = makeMockFetch(() => ({ status: 403, body: { error: 'Only the job poster can accept applicants' } }));
    institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mock.mockFetch });
    await expect(institutions.acceptApplicant('job_test_123', 'wallet_aw_worker')).rejects.toThrow(ProvianAuthError);
  });
});

describe('CommonsInstitutions.deliverJob', () => {
  let mock: ReturnType<typeof makeMockFetch>;
  let institutions: CommonsInstitutions;

  beforeEach(() => {
    mock = makeMockFetch(() => ({ body: { ...SAMPLE_JOB, status: 'delivered' } }));
    institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mock.mockFetch });
  });

  it('POSTs /v1/jobs/:id/deliver with empty body', async () => {
    const result = await institutions.deliverJob('job_test_123');
    expect(mock.calls[0].url).toBe('https://relay.test/v1/jobs/job_test_123/deliver');
    expect(mock.calls[0].method).toBe('POST');
    expect(mock.calls[0].body).toEqual({});
    expect(result.status).toBe('delivered');
  });

  it('rejects missing jobId', async () => {
    await expect(institutions.deliverJob('')).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });

  it('surfaces 400 (not assigned) as ProvianNetworkError', async () => {
    mock = makeMockFetch(() => ({ status: 400, body: { error: 'Job must be in assigned status to deliver' } }));
    institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mock.mockFetch });
    await expect(institutions.deliverJob('job_test_123')).rejects.toMatchObject({
      name: 'ProvianNetworkError',
      httpStatus: 400,
    });
  });
});

describe('CommonsInstitutions.getMyJobs', () => {
  let mock: ReturnType<typeof makeMockFetch>;
  let institutions: CommonsInstitutions;
  const myJobsResponse: MyJobsResponse = {
    posted: [SAMPLE_JOB],
    assigned: [{ ...SAMPLE_JOB, job_id: 'job_other', poster_wallet_id: 'wallet_other' }],
    total: 2,
    has_more: false,
  };

  beforeEach(() => {
    mock = makeMockFetch(() => ({ body: myJobsResponse }));
    institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mock.mockFetch });
  });

  it('GETs /v1/jobs/my-jobs with no query params when no filters supplied', async () => {
    const result = await institutions.getMyJobs();
    expect(mock.calls[0].url).toBe('https://relay.test/v1/jobs/my-jobs');
    expect(mock.calls[0].method).toBe('GET');
    expect(result.posted).toHaveLength(1);
    expect(result.assigned).toHaveLength(1);
    expect(result.total).toBe(2);
    expect(result.has_more).toBe(false);
  });

  it('encodes status, role, sort, limit, offset into the query string', async () => {
    await institutions.getMyJobs({
      status: 'completed',
      role: 'posted',
      sort: 'updated_desc',
      limit: 25,
      offset: 50,
    });
    const url = mock.calls[0].url;
    expect(url.startsWith('https://relay.test/v1/jobs/my-jobs?')).toBe(true);
    expect(url).toContain('status=completed');
    expect(url).toContain('role=posted');
    expect(url).toContain('sort=updated_desc');
    expect(url).toContain('limit=25');
    expect(url).toContain('offset=50');
  });

  it('rejects non-positive limit', async () => {
    await expect(institutions.getMyJobs({ limit: 0 })).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects negative offset', async () => {
    await expect(institutions.getMyJobs({ offset: -1 })).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });

  it('surfaces 401 as ProvianAuthError', async () => {
    mock = makeMockFetch(() => ({ status: 401, body: { error: 'Authentication required' } }));
    institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mock.mockFetch });
    await expect(institutions.getMyJobs()).rejects.toThrow(ProvianAuthError);
  });
});
