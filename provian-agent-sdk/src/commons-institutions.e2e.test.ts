import {openTestPrivateRequest} from './private-request.test-support';
/**
 * End-to-end SDK trace verification for an agent→agent hire on the ONE Commons board.
 *
 * the agent-only `/v1/jobs` board folded into the Commons hiring board
 * (`/v1/commons/jobs`), which people and agents share in all four directions. This walks
 * the canonical agent→agent happy path using ONLY SDK methods (no raw HTTP) against a mock
 * backend that returns realistic state transitions:
 *
 * 1. Agent A: postJob (re-pointed) -> POST /v1/commons/jobs/post (seeking 'agent')
 * 2. Agent B: listAvailableJobs (re-pt) -> GET /v1/commons/jobs?status=open&seeking=agent
 * 3. Agent B: applyToJob (re-pointed) -> POST /v1/commons/jobs/:id/apply
 * 4. Agent A: acceptApplicant (re-pt) -> POST /v1/commons/jobs/:id/accept (returns escrow_id)
 * 5. Agent A: recordCommonsJobFunding -> POST /v1/commons/jobs/:id/fund
 * 6. Agent B: deliverHumanJob -> POST /v1/commons/jobs/:id/deliver
 * 7. Agent A: completeHumanJob -> POST /v1/commons/jobs/:id/complete
 *
 * The on-chain legs (createEscrow/approve/fundEscrow, releaseEscrow) are covered with a
 * mock viem transport in agent-institutions.commonsHire.test.ts; here the fund tx hash is a stand-in
 * and the release is the relay record, so the trace isolates the relay contract.
 */

import { describe, it, expect } from 'vitest';
import { CommonsInstitutions, type CommonsInstitutionsConfig } from './commons-institutions';

const POSTER_CONFIG: CommonsInstitutionsConfig = {
  relayUrl: 'https://relay.test',
  walletId: 'wallet_aw_poster',
  apiKey: 'pvn_live_poster',
  apiSecret: 'pvns_' + 'a'.repeat(64),
};

const APPLICANT_CONFIG: CommonsInstitutionsConfig = {
  relayUrl: 'https://relay.test',
  walletId: 'wallet_aw_applicant',
  apiKey: 'pvn_live_applicant',
  apiSecret: 'pvns_' + 'b'.repeat(64),
};

interface JobState {
  job_id: string;
  poster_wallet_id: string;
  title: string;
  description: string;
  skills_required: string[];
  seeking: 'agent' | 'human';
  direction: string;
  currency: 'usdc';
  budget_usdc: number;
  status: 'open' | 'in_progress' | 'completed';
  applicant_count: number;
  accepted_applicant_wallet_id?: string;
  escrow_id?: string;
  delivered_at?: number;
  completed_at?: number;
  payment_released?: boolean;
}

interface EscrowState {
  escrow_id: string;
  status: 'created' | 'funded' | 'completed';
  fund_tx_hash?: string;
}

function walletOf(init?: RequestInit): string {
  const auth = new Headers(init?.headers).get('Authorization') ?? '';
  return auth.includes('pvn_live_poster') ? POSTER_CONFIG.walletId : APPLICANT_CONFIG.walletId;
}

function makeFakeBackend() {
  const jobs = new Map<string, JobState>();
  const escrows = new Map<string, EscrowState>();

  const fakeFetch = async (rawUrl: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(rawUrl);
    const path = url.replace('https://relay.test', '');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? openTestPrivateRequest(JSON.parse(init.body),url,init.headers) : null;
    const caller = walletOf(init);

    if (path === '/v1/commons/jobs/post' && method === 'POST') {
      const jobId = `hjob_e2e_${jobs.size + 1}`;
      const job: JobState = {
        job_id: jobId,
        poster_wallet_id: caller,
        title: body.title,
        description: body.description,
        skills_required: body.skills_required,
        seeking: body.seeking,
        direction: `agent_seeking_${body.seeking}`,
        currency: body.currency,
        budget_usdc: body.budget_usdc,
        status: 'open',
        applicant_count: 0,
      };
      jobs.set(jobId, job);
      return jsonOk(job, 201);
    }

    if (path.startsWith('/v1/commons/jobs?') && method === 'GET') {
      const q = new URLSearchParams(path.split('?')[1]);
      const list = Array.from(jobs.values()).filter((j) =>
        j.status === (q.get('status') ?? 'open') && (!q.get('seeking') || j.seeking === q.get('seeking')));
      return jsonOk({ jobs: list, total: list.length, featured: [] });
    }

    const m = path.match(/^\/v1\/commons\/jobs\/([^/]+)\/(apply|accept|fund|deliver|complete)$/);
    if (m && method === 'POST') {
      const job = jobs.get(decodeURIComponent(m[1]));
      if (!job) return jsonErr(404, 'Job not found');
      switch (m[2]) {
        case 'apply':
          if (job.seeking !== 'agent') return jsonErr(400, 'This job is hiring people, not agents');
          job.applicant_count += 1;
          return jsonOk({ application_id: 'happ_1', job_id: job.job_id, applicant_wallet_id: caller, cover_note: body.cover_note, status: 'pending' }, 201);
        case 'accept': {
          if (caller !== job.poster_wallet_id) return jsonErr(403, 'Only the poster can accept');
          const escrowId = `esc_e2e_${escrows.size + 1}`;
          job.status = 'in_progress';
          job.accepted_applicant_wallet_id = body.applicant_wallet_id;
          job.escrow_id = escrowId;
          escrows.set(escrowId, { escrow_id: escrowId, status: 'created' });
          return jsonOk({ job, escrow_id: escrowId });
        }
        case 'fund': {
          const escrow = escrows.get(job.escrow_id ?? '');
          if (!escrow) return jsonErr(400, 'Job has no escrow to fund');
          escrow.status = 'funded';
          escrow.fund_tx_hash = body.tx_hash;
          return jsonOk({ job, escrow_id: escrow.escrow_id, status: 'funded', funded_at: new Date().toISOString(), fund_tx_hash: body.tx_hash });
        }
        case 'deliver':
          if (caller !== job.accepted_applicant_wallet_id) return jsonErr(403, 'Only the hired participant can deliver');
          job.delivered_at = Date.now();
          return jsonOk(job);
        case 'complete': {
          const escrow = escrows.get(job.escrow_id ?? '');
          if (!escrow || escrow.status !== 'funded') return jsonErr(400, 'Escrow is not funded');
          escrow.status = 'completed';
          job.status = 'completed';
          job.completed_at = Date.now();
          job.payment_released = true;
          return jsonOk(job);
        }
      }
    }

    return jsonErr(404, `Unhandled ${method} ${path}`);
  };

  return { fakeFetch, jobs, escrows };
}

function jsonOk(body: unknown, status = 200): Response {
  return { ok: true, status, json: async () => body } as Response;
}

function jsonErr(status: number, error: string): Response {
  return { ok: false, status, json: async () => ({ error }) } as Response;
}

describe('SDK end-to-end: agent→agent hire on the ONE Commons board ', () => {
  it('drives post -> browse -> apply -> accept -> fund -> deliver -> release using only SDK methods', async () => {
    const { fakeFetch, jobs, escrows } = makeFakeBackend();
    const poster = new CommonsInstitutions({ ...POSTER_CONFIG, fetch: fakeFetch });
    const applicant = new CommonsInstitutions({ ...APPLICANT_CONFIG, fetch: fakeFetch });

    // 1. Poster posts an agent→agent USDC job through the re-pointed legacy verb.
    const posted = await poster.postJob({
      title: 'Benchmark a model on three GPUs',
      description: 'Run inference benchmarks across H100, A100, and M4-Pro',
      required_capabilities: ['gpu_inference'],
      currency: 'usdc',
      budget_usdc: 100,
      deadline_hours: 48,
    });
    expect(posted.status).toBe('open');
    expect(posted.poster_wallet_id).toBe(POSTER_CONFIG.walletId);
    expect(posted.seeking).toBe('agent');
    expect(posted.skills_required).toEqual(['gpu_inference']);

    // 2. Applicant browses the agent side of the board.
    const browse = await applicant.listAvailableJobs();
    expect(browse.count).toBe(1);
    expect(browse.jobs[0].job_id).toBe(posted.job_id);

    // 3. Applicant applies.
    const applied = await applicant.applyToJob(posted.job_id, {
      proposal: 'I have run this exact benchmark on H100s twice this month.',
    });
    expect(applied.applicant_wallet_id).toBe(APPLICANT_CONFIG.walletId);

    // 4. Poster accepts the applicant. Creates the escrow record.
    const accepted = await poster.acceptApplicant(posted.job_id, APPLICANT_CONFIG.walletId);
    expect(accepted.job.status).toBe('in_progress');
    expect(accepted.escrow_id).toBeTruthy();

    // 5. Poster records the on-chain funding (the broadcast leg is in commonsHire.test).
    const txHash = '0x' + 'd'.repeat(64);
    const funded = await poster.recordCommonsJobFunding(posted.job_id, txHash);
    expect(funded.status).toBe('funded');
    expect(funded.fund_tx_hash).toBe(txHash);

    // 6. Applicant delivers.
    const delivered = await applicant.deliverHumanJob(posted.job_id, { deliverableUri: 'https://example.com/report' });
    expect(delivered.delivered_at).toBeGreaterThan(0);

    // 7. Poster records the release.
    const completed = await poster.completeHumanJob(posted.job_id);
    expect(completed.status).toBe('completed');
    expect(completed.payment_released).toBe(true);

    expect(escrows.get(accepted.escrow_id)?.status).toBe('completed');
    expect(jobs.get(posted.job_id)?.status).toBe('completed');
  });
});
