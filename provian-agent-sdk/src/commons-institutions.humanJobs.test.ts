import {openTestPrivateRequest} from './private-request.test-support';
/**
 * Commons human-jobs SDK wrappers.
 *
 * The /v1/commons/* surface accepts the same Bearer apiKey:apiSecret
 * the agent-institutions routes do; the server's per-route shim at
 * provian-backend/src/server.ts:8558-8568 routes pvn_live_ tokens
 * through authenticateAgent so req.agentWallet is set on the way in.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CommonsInstitutions,
  ProvianValidationError,
  ProvianAuthError,
  type CommonsInstitutionsConfig,
  type HumanJobResponse,
  type PostHumanJobRequest,
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
      try { parsed = openTestPrivateRequest(JSON.parse(init.body),String(url),init.headers); } catch { parsed = init.body; }
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

const SAMPLE_HUMAN_JOB: HumanJobResponse = {
  job_id: 'hjob_test_123',
  pe_id: 'pe_hjob',
  poster_wallet_id: 'wallet_aw_test',
  title: 'Visit a hardware store and verify a SKU is in stock',
  description: 'Drive to the local store, photograph the shelf, send back the photo.',
  category: 'physical_task',
  skills_required: ['local_knowledge'],
  location: { type: 'on_site', region: 'US-TX' },
  compensation_type: 'pvt',
  budget_pvt: '2000000000000000000',
  requires_identity_verification: false,
  requires_pe_history: false,
  status: 'open',
  applicant_count: 0,
  posted_at: 1700000000000,
  posted_by_type: 'agent',
  direction: 'agent_seeking_human',
};

const VALID_POST: PostHumanJobRequest = {
  title: SAMPLE_HUMAN_JOB.title,
  description: SAMPLE_HUMAN_JOB.description,
  category: 'physical_task',
  skills_required: ['local_knowledge'],
  location: { type: 'on_site', region: 'US-TX' },
  compensation_type: 'pvt',
  budget_pvt: '2000000000000000000',
  requires_identity_verification: false,
  requires_pe_history: false,
  deadline_hours: 48,
};

describe('CommonsInstitutions.postHumanJob', () => {
  let mock: ReturnType<typeof makeMockFetch>;
  let institutions: CommonsInstitutions;

  beforeEach(() => {
    mock = makeMockFetch(() => ({ status: 201, body: SAMPLE_HUMAN_JOB }));
    institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mock.mockFetch });
  });

  it('POSTs /v1/commons/jobs/post with the request body', async () => {
    const result = await institutions.postHumanJob(VALID_POST);
    expect(mock.calls[0].url).toBe('https://relay.test/v1/commons/jobs/post');
    expect(mock.calls[0].method).toBe('POST');
    // the SDK now names the currency explicitly (PVT when budget_pvt is the budget).
    expect(mock.calls[0].body).toEqual({ ...VALID_POST, currency: 'pvt' });
    expect(result.job_id).toBe('hjob_test_123');
  });

  it('rejects empty title', async () => {
    await expect(institutions.postHumanJob({ ...VALID_POST, title: '' })).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects malformed budget_pvt', async () => {
    await expect(institutions.postHumanJob({ ...VALID_POST, budget_pvt: '5.0' })).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects non-positive deadline_hours', async () => {
    await expect(institutions.postHumanJob({ ...VALID_POST, deadline_hours: 0 })).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });
});

describe('CommonsInstitutions.applyToHumanJob', () => {
  let mock: ReturnType<typeof makeMockFetch>;
  let institutions: CommonsInstitutions;

  beforeEach(() => {
    mock = makeMockFetch(() => ({
      status: 201,
      body: {
        application_id: 'happ_test',
        job_id: 'hjob_test_123',
        applicant_wallet_id: 'wallet_aw_worker',
        pe_id: 'pe_app',
        cover_note: 'I live two blocks from that store.',
        applied_at: 1700000000000,
        status: 'pending',
      },
    }));
    institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mock.mockFetch });
  });

  it('POSTs /v1/commons/jobs/:id/apply with optional cover_note', async () => {
    await institutions.applyToHumanJob('hjob_test_123', { cover_note: 'I live two blocks from that store.' });
    expect(mock.calls[0].url).toBe('https://relay.test/v1/commons/jobs/hjob_test_123/apply');
    expect(mock.calls[0].method).toBe('POST');
    expect(mock.calls[0].body).toEqual({ cover_note: 'I live two blocks from that store.' });
  });

  it('omits cover_note when not supplied', async () => {
    await institutions.applyToHumanJob('hjob_test_123');
    expect(mock.calls[0].body).toEqual({});
  });

  it('rejects empty jobId', async () => {
    await expect(institutions.applyToHumanJob('')).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });
});

describe('CommonsInstitutions.acceptHumanJobApplicant', () => {
  let mock: ReturnType<typeof makeMockFetch>;
  let institutions: CommonsInstitutions;

  beforeEach(() => {
    mock = makeMockFetch(() => ({
      body: { job: { ...SAMPLE_HUMAN_JOB, status: 'in_progress' }, escrow_id: 'escrow_hj_456' },
    }));
    institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mock.mockFetch });
  });

  it('POSTs /v1/commons/jobs/:id/accept with applicant_wallet_id in the body', async () => {
    const result = await institutions.acceptHumanJobApplicant('hjob_test_123', 'wallet_aw_worker');
    expect(mock.calls[0].url).toBe('https://relay.test/v1/commons/jobs/hjob_test_123/accept');
    expect(mock.calls[0].method).toBe('POST');
    expect(mock.calls[0].body).toEqual({ applicant_wallet_id: 'wallet_aw_worker' });
    expect(result.escrow_id).toBe('escrow_hj_456');
  });

  it('rejects missing applicantWalletId', async () => {
    await expect(institutions.acceptHumanJobApplicant('hjob_test_123', '')).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });

  it('surfaces 403 from the relay as ProvianAuthError', async () => {
    mock = makeMockFetch(() => ({ status: 403, body: { error: 'Only the job poster can accept applicants' } }));
    institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mock.mockFetch });
    await expect(institutions.acceptHumanJobApplicant('hjob_test_123', 'wallet_aw_worker')).rejects.toThrow(ProvianAuthError);
  });
});

describe('CommonsInstitutions.deliverHumanJob', () => {
  let mock: ReturnType<typeof makeMockFetch>;
  let institutions: CommonsInstitutions;

  beforeEach(() => {
    mock = makeMockFetch(() => ({ body: { ...SAMPLE_HUMAN_JOB, status: 'in_progress' } }));
    institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mock.mockFetch });
  });

  it('POSTs /v1/commons/jobs/:id/deliver with empty body', async () => {
    await institutions.deliverHumanJob('hjob_test_123');
    expect(mock.calls[0].url).toBe('https://relay.test/v1/commons/jobs/hjob_test_123/deliver');
    expect(mock.calls[0].method).toBe('POST');
    expect(mock.calls[0].body).toEqual({});
  });

  it('rejects empty jobId', async () => {
    await expect(institutions.deliverHumanJob('')).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });
});

describe('CommonsInstitutions.completeHumanJob', () => {
  let mock: ReturnType<typeof makeMockFetch>;
  let institutions: CommonsInstitutions;

  beforeEach(() => {
    mock = makeMockFetch(() => ({ body: { ...SAMPLE_HUMAN_JOB, status: 'completed' } }));
    institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mock.mockFetch });
  });

  it('POSTs /v1/commons/jobs/:id/complete with empty body', async () => {
    const result = await institutions.completeHumanJob('hjob_test_123');
    expect(mock.calls[0].url).toBe('https://relay.test/v1/commons/jobs/hjob_test_123/complete');
    expect(mock.calls[0].method).toBe('POST');
    expect(mock.calls[0].body).toEqual({});
    expect(result.status).toBe('completed');
  });

  it('rejects empty jobId', async () => {
    await expect(institutions.completeHumanJob('')).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });
});

describe('CommonsInstitutions.rateHumanJob', () => {
  let mock: ReturnType<typeof makeMockFetch>;
  let institutions: CommonsInstitutions;

  beforeEach(() => {
    mock = makeMockFetch(() => ({ status: 201, body: { rating_id: 'rate_test', rating: 5 } }));
    institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mock.mockFetch });
  });

  it('POSTs /v1/commons/jobs/:id/rate with rating + comment', async () => {
    await institutions.rateHumanJob('hjob_test_123', { rating: 5, comment: 'Excellent work, on time.' });
    expect(mock.calls[0].url).toBe('https://relay.test/v1/commons/jobs/hjob_test_123/rate');
    expect(mock.calls[0].method).toBe('POST');
    expect(mock.calls[0].body).toEqual({ rating: 5, comment: 'Excellent work, on time.' });
  });

  it('rejects non-integer rating', async () => {
    await expect(institutions.rateHumanJob('hjob_test_123', { rating: 4.5 })).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects rating outside 1..5', async () => {
    await expect(institutions.rateHumanJob('hjob_test_123', { rating: 0 })).rejects.toThrow(ProvianValidationError);
    await expect(institutions.rateHumanJob('hjob_test_123', { rating: 6 })).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });
});

describe('CommonsInstitutions.getMyHumanJobs', () => {
  let mock: ReturnType<typeof makeMockFetch>;
  let institutions: CommonsInstitutions;

  beforeEach(() => {
    mock = makeMockFetch(() => ({
      body: {
        posted: [SAMPLE_HUMAN_JOB],
        assigned: [],
        total: 1,
        has_more: false,
      },
    }));
    institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mock.mockFetch });
  });

  it('GETs /v1/commons/jobs/mine with no query params when no filters supplied', async () => {
    const result = await institutions.getMyHumanJobs();
    expect(mock.calls[0].url).toBe('https://relay.test/v1/commons/jobs/mine');
    expect(mock.calls[0].method).toBe('GET');
    expect(result.posted).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.has_more).toBe(false);
  });

  it('encodes status, role, sort, limit, offset into the query string', async () => {
    await institutions.getMyHumanJobs({
      status: 'completed',
      role: 'assigned',
      sort: 'posted_asc',
      limit: 10,
      offset: 20,
    });
    const url = mock.calls[0].url;
    expect(url.startsWith('https://relay.test/v1/commons/jobs/mine?')).toBe(true);
    expect(url).toContain('status=completed');
    expect(url).toContain('role=assigned');
    expect(url).toContain('sort=posted_asc');
    expect(url).toContain('limit=10');
    expect(url).toContain('offset=20');
  });

  it('rejects non-positive limit', async () => {
    await expect(institutions.getMyHumanJobs({ limit: 0 })).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects negative offset', async () => {
    await expect(institutions.getMyHumanJobs({ offset: -1 })).rejects.toThrow(ProvianValidationError);
    expect(mock.calls).toHaveLength(0);
  });

  it('surfaces 401 as ProvianAuthError', async () => {
    mock = makeMockFetch(() => ({ status: 401, body: { error: 'Authentication required' } }));
    institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mock.mockFetch });
    await expect(institutions.getMyHumanJobs()).rejects.toThrow(ProvianAuthError);
  });
});
