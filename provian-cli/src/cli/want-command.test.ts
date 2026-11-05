/**
 * `provian want --budget-max-pvt <whole PVT>` follows every CLI PVT flag: whole PVT on the flag,
 * converted to the relay's atomic units (18 decimals); `--budget-max-pvt-atomic` passes atomic units
 * through. RED control: the pre-fix command sent the flag raw, so `--budget-max-pvt 10` asked for 10 wei.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cmdWant, resolveWantBudgetAtomic } from './commons-institutions-commands';

interface Call { url: string; body?: Record<string, unknown> }
let calls: Call[] = [];
const saved: Record<string, string | undefined> = {};
const ENV = ['PROVIAN_API_KEY', 'PROVIAN_API_SECRET', 'PROVIAN_AGENT_WALLET_ID', 'PROVIAN_RELAY_URL'];

beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.PROVIAN_API_KEY = 'pvn_live_test';
  process.env.PROVIAN_API_SECRET = 'pvns_' + 'x'.repeat(64);
  process.env.PROVIAN_AGENT_WALLET_ID = 'wallet_aw_me';
  process.env.PROVIAN_RELAY_URL = 'https://relay.test';
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return { ok: true, status: 201, json: async () => ({ want_id: 'want_1' }) } as Response;
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('provian want — budget unit', () => {
  it('RED: --budget-max-pvt 10 sends 10 PVT in atomic units, not 10 wei', async () => {
    await cmdWant({ outcome: 'o', capabilities: 'a,b', 'budget-max-pvt': '10' });
    expect(calls[0].url).toBe('https://relay.test/v1/wants');
    expect(calls[0].body?.budget_max_pvt).toBe('10000000000000000000');
    expect(calls[0].body?.budget_max_pvt).not.toBe('10');
  });

  it('--budget-max-pvt-atomic passes atomic units through', async () => {
    await cmdWant({ outcome: 'o', capabilities: 'a', 'budget-max-pvt-atomic': '20500000000000000000' });
    expect(calls[0].body?.budget_max_pvt).toBe('20500000000000000000');
  });

  it('no flag → no budget; malformed flags refused before any network call', async () => {
    await cmdWant({ outcome: 'o', capabilities: 'a' });
    expect('budget_max_pvt' in (calls[0].body ?? {})).toBe(false);
    expect(() => resolveWantBudgetAtomic({ 'budget-max-pvt': '20.5' })).toThrow(/whole number of PVT/);
    expect(() => resolveWantBudgetAtomic({ 'budget-max-pvt-atomic': '1.5' })).toThrow(/atomic units/);
    calls = [];
    await cmdWant({ outcome: 'o', capabilities: 'a', 'budget-max-pvt': '20.5' });
    expect(calls).toEqual([]);
  });
});
