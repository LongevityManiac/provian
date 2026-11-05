/**
 * `provian fleet-code` : any linked agent issues a one-hour,
 * single-use link code for another of its human's agents. RED control: an
 * unlinked agent's 403 not_linked comes back as an error result, never a code.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cmdFleetCode } from './commons-institutions-commands';

const ENV = ['PROVIAN_API_KEY', 'PROVIAN_API_SECRET', 'PROVIAN_AGENT_WALLET_ID', 'PROVIAN_RELAY_URL'];
const saved: Record<string, string | undefined> = {};
const CODE = 'PROV-HJKM-2345';
let calls: Array<{ url: string; method?: string }> = [];

function stub(status: number, body: unknown): void {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method });
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
  });
}

beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.PROVIAN_API_KEY = 'pvn_live_test';
  process.env.PROVIAN_API_SECRET = 'pvns_' + 'x'.repeat(64);
  process.env.PROVIAN_AGENT_WALLET_ID = 'wallet_aw_main';
  process.env.PROVIAN_RELAY_URL = 'https://relay.test';
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('provian fleet-code', () => {
  it('issues a code via POST /v1/agent/wallet/:id/fleet-code and returns it with the install line', async () => {
    const install_line = { sh: `curl -sSL -H 'x-provian-token: ${CODE}' "https://relay.test/v1/bootstrap/agent" | sh`, powershell: 'irm …' };
    stub(201, { code: CODE, expires_at: 1_900_000_000_000, install_line });
    const out = await cmdFleetCode({});
    expect(calls).toEqual([{ url: 'https://relay.test/v1/agent/wallet/wallet_aw_main/fleet-code', method: 'POST' }]);
    expect(out).toMatchObject({ code: CODE, expires_at: 1_900_000_000_000, install_line });
  });

  it('RED control: an unlinked agent (403 not_linked) is an error, not a code', async () => {
    stub(403, { error: 'not_linked' });
    const out = await cmdFleetCode({});
    expect(out.status).toBe('error');
    expect(JSON.stringify(out)).not.toContain('PROV-');
  });

  it('missing credentials never calls the relay', async () => {
    delete process.env.PROVIAN_API_KEY;
    stub(201, {});
    const out = await cmdFleetCode({});
    expect(out.status).toBe('error');
    expect(calls).toHaveLength(0);
  });
});
