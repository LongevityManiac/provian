/**
 * the Commons hire from the CLI: one board, four directions, PVT or USDC, with the
 * dispute fallback. Asserts the wire request each command drives (through the SDK's
 * CommonsInstitutions) and the refusals that must fire before any network or signing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { run } from './commands';
import { openPrivateAuthenticatedRequest } from '../../../provian-backend/src/core/meter/private-pricing';
import {
  cmdPostJob,
  cmdJobs,
  cmdJobFund,
  cmdJobDeliver,
  cmdJobRelease,
  cmdVouch,
  cmdMarket,
} from './commons-institutions-commands';

interface Call { url: string; method?: string; body?: unknown }

let calls: Call[] = [];
let responder: (c: Call) => { status?: number; body: unknown } = () => ({ body: {} });
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['PROVIAN_API_KEY', 'PROVIAN_API_SECRET', 'PROVIAN_AGENT_WALLET_ID', 'PROVIAN_RELAY_URL', 'PROVIAN_AGENT_PRIVATE_KEY', 'PROVIAN_BASE_RPC_URL'];

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.PROVIAN_API_KEY = 'pvn_live_test';
  process.env.PROVIAN_API_SECRET = 'pvns_' + 'x'.repeat(64);
  process.env.PROVIAN_AGENT_WALLET_ID = 'wallet_aw_me';
  process.env.PROVIAN_RELAY_URL = 'https://relay.test';
  calls = [];
  responder = () => ({ body: {} });
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const call: Call = { url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    if (call.body && typeof call.body === 'object' && 'private_request' in call.body) {
      const req = { body: call.body, originalUrl: new URL(call.url).pathname };
      openPrivateAuthenticatedRequest(req, process.env.PROVIAN_API_SECRET!);
      call.body = req.body;
    }
    calls.push(call);
    const { status = 200, body } = responder(call);
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('post-job on the ONE Commons board', () => {
  it('posts seeking + currency + budget to /v1/commons/jobs/post (USDC, hiring a person)', async () => {
    responder = () => ({ status: 201, body: { job_id: 'hjob_1' } });
    await cmdPostJob({ currency: 'usdc', seeking: 'human', budget: '40', title: 't', description: 'd', 'deadline-hours': '48', location: 'on_site' });
    expect(calls[0].url).toBe('https://relay.test/v1/commons/jobs/post');
    expect(calls[0].body).toMatchObject({ seeking: 'human', currency: 'usdc', budget_usdc: 40, location: { type: 'on_site' }, category: 'other' });
  });

  it('defaults to seeking agent and maps --capabilities onto skills_required (PVT)', async () => {
    await cmdPostJob({ currency: 'pvt', budget: '100', title: 't', description: 'd', capabilities: 'a,b', 'deadline-hours': '72' });
    expect(calls[0].body).toMatchObject({ seeking: 'agent', currency: 'pvt', budget_pvt: '100000000000000000000', skills_required: ['a', 'b'] });
  });

  it('refuses a --seeking that is neither agent nor human, before the network', async () => {
    const r = await cmdPostJob({ currency: 'pvt', seeking: 'robot', budget: '1', title: 't', description: 'd', 'deadline-hours': '1' });
    expect((r as { status?: string }).status).toBe('error');
    expect(calls).toHaveLength(0);
  });
});

describe('jobs / market / deliver routing', () => {
  it('jobs browse encodes the filters; run() dispatches `provian jobs`', async () => {
    responder = () => ({ body: { jobs: [], total: 0, featured: [] } });
    await run(['node', 'provian', 'jobs', 'browse', '--seeking', 'agent', '--posted-by', 'human', '--currency', 'usdc']);
    expect(calls[0].url).toBe('https://relay.test/v1/commons/jobs?seeking=agent&posted_by=human&currency=usdc');
    await cmdJobs('applications', { job: 'hjob_1' });
    expect(calls[1].url).toBe('https://relay.test/v1/commons/jobs/hjob_1/applications');
  });

  it('market --stats and market --seeking all', async () => {
    await cmdMarket({ stats: true });
    await cmdMarket({ seeking: 'all' });
    expect(calls.map((c) => c.url)).toEqual([
      'https://relay.test/v1/commons/market/stats',
      'https://relay.test/v1/commons/market/jobs?seeking=all',
    ]);
  });

  it('job-deliver routes hjob_ to the Commons board and a legacy job_ to its old route', async () => {
    await cmdJobDeliver({ job: 'hjob_1', uri: 'https://example.com/r' });
    await cmdJobDeliver({ job: 'job_legacy' });
    expect(calls.map((c) => c.url)).toEqual([
      'https://relay.test/v1/commons/jobs/hjob_1/deliver',
      'https://relay.test/v1/jobs/job_legacy/deliver',
    ]);
    expect(calls[0].body).toEqual({ deliverable_uri: 'https://example.com/r' });
  });
});

describe('money legs — key intake + record-only paths', () => {
  // RED control (F35 carried into the hire): a key on argv must never be used to sign. Mutation
  // that reddens it: read flags['private-key'] in hireSigner.
  it('RED: job-fund with the key only on argv refuses before any network', async () => {
    const r = await cmdJobFund({ job: 'hjob_1', 'private-key': 'a'.repeat(64), 'rpc-url': 'https://rpc.test' });
    expect((r as { status?: string }).status).toBe('error');
    expect(String((r as { error?: string }).error)).toContain('PROVIAN_AGENT_PRIVATE_KEY');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('job-fund --tx-hash re-records a mined funding without signing', async () => {
    const hash = '0x' + 'b'.repeat(64);
    await cmdJobFund({ job: 'hjob_1', 'tx-hash': hash });
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://relay.test/v1/commons/jobs/hjob_1/fund', body: { tx_hash: hash } });
  });

  it('job-release --record-only POSTs /complete; without it and without a key it refuses', async () => {
    await cmdJobRelease({ job: 'hjob_1', 'record-only': true });
    expect(calls[0].url).toBe('https://relay.test/v1/commons/jobs/hjob_1/complete');
    const r = await cmdJobRelease({ job: 'hjob_1' });
    expect((r as { status?: string }).status).toBe('error');
    expect(calls).toHaveLength(1);
  });
});

describe('vouch', () => {
  it('vouches through the agent route and surfaces the linked-pair refusal as a typed code', async () => {
    await cmdVouch({ target: 'user_2', note: 'reliable' });
    expect(calls[0]).toMatchObject({ url: 'https://relay.test/v1/agent/wallet/wallet_aw_me/vouch/burn', body: { target_agent_id: 'user_2', note: 'reliable' } });
    responder = () => ({ status: 403, body: { error: 'An agent cannot vouch for its own linked human', reason: 'linked_pair_vouch_refused' } });
    const r = await cmdVouch({ target: 'user_mine' });
    expect((r as { code?: string }).code).toBe('LINKED_PAIR_VOUCH_REFUSED');
  });

  it('--mine and --for read the vouch lists', async () => {
    responder = () => ({ body: { vouches: [] } });
    await cmdVouch({ mine: true });
    await cmdVouch({ for: 'user_2' });
    expect(calls.map((c) => c.url)).toEqual([
      'https://relay.test/v1/agent/wallet/wallet_aw_me/vouches',
      'https://relay.test/v1/commons/agent/user_2/vouches',
    ]);
  });
});
