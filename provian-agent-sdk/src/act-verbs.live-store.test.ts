vi.mock('./protocol-runtime', async () => (await import('./__test-helpers__/protocol-runtime.js')).protocolRuntimeFixture);
/**
 * The act verbs read only this device's LIVE PE store, and `balance` reads PVT live from the chain.
 *
 * - After a machine move two device stores can sit under ~/.provian/pe-store. `provian pes` lists only
 *   what the live device (the one in ~/.provian/credentials) can present, and `--pe` for a PE in the
 *   leftover store is refused before any call, naming the live store and `provian pes`.
 *   Non-empty-population control: the leftover store DOES hold presentable PEs (listed directly), so
 *   their absence from `provian pes` is the live-store rule, not an empty store.
 *   RED control (the verbs before this change): `pes` is an unknown command and the refusal names
 *   neither the live store nor `provian pes`.
 * - `balance` passes this agent's Base RPC and address, so PVT is `balanceOf` on the pointer-resolved
 *   kernel, not the relay's cached figure. RED control: before, `balance` printed the relay's 99.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runActVerbCli, defaultActDeps, type ActDeps } from './act-verbs';
import { CommonsInstitutions } from './commons-institutions';
import type { InstalledAgent } from './installed-agent';
import { anchoredStore } from './meter/anchored-store.test-support';
import { FsPeStore } from './meter/pe-store';
import { resolveLocalPeStore } from './meter/local-store';
import { listPresentablePes } from './meter/presentable';
import { protocolRuntimeFixture } from './__test-helpers__/protocol-runtime.js';

const ADDRESS = '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1';
const API_KEY = `pvn_live_${'1'.repeat(32)}`;
const API_SECRET = `pvns_${'2'.repeat(64)}`;
const OLD_DEVICE = 'dev_' + '0d'.repeat(32);
const LIVE_DEVICE = 'dev_' + '1e'.repeat(32);
const RPC = 'https://rpc.test/base';

function harness(deps: Partial<ActDeps>, rpc?: (body: { method: string; params: unknown[] }) => unknown) {
  const calls: string[] = [];
  const rpcBodies: { method: string; params: unknown[] }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith(RPC) && rpc) {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      rpcBodies.push(body);
      const answer = rpc(body);
      return { ok: true, status: 200, json: async () => answer } as Response;
    }
    calls.push(u);
    const token = new URL(u).searchParams.get('token');
    const body = u.includes('/balances')
      ? { eth: '0.001', usdc: '0', chain: 'base', token_address: token, pvt: { status: 'live', balance: '99', available: true, address: token } }
      : { ok: true };
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as unknown as typeof fetch;
  const agent: InstalledAgent = {
    walletId: 'wallet_aw_bot', address: ADDRESS, apiSecret: API_SECRET,
    config: { relayUrl: 'https://relay.test', walletId: 'wallet_aw_bot', apiKey: API_KEY, apiSecret: API_SECRET, fetch: fetchImpl },
    withKey: async (fn) => fn('4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d'),
  };
  const full: ActDeps = {
    loadAgent: () => agent,
    makeInstitutions: (config) => new CommonsInstitutions({ ...config, fetch: fetchImpl }),
    transferToken: vi.fn() as unknown as ActDeps['transferToken'],
    transferNative: vi.fn() as unknown as ActDeps['transferNative'],
    waitForReceipt: vi.fn() as unknown as ActDeps['waitForReceipt'],
    validateEgress: defaultActDeps().validateEgress,
    makeX402Fetch: vi.fn() as unknown as ActDeps['makeX402Fetch'],
    readFile: () => { throw new Error('no files in this test'); },
    env: { PROVIAN_BASE_RPC_URL: RPC },
    confirmations: 12,
    openPeStore: () => ({ ok: false, detail: 'no PE store in this test' }),
    flushMeter: async () => ({ sent: true, detail: 'sent' }),
    openArchive: async () => null,
    mailNotice: () => null,
    actionNotice: () => null,
    clearMailbox: () => undefined,
    acknowledgeHeartbeat: () => undefined,
    ...deps,
  };
  const run = async (verb: string, ...args: string[]) => {
    const out: string[] = [];
    const code = await runActVerbCli(verb, args, full, { stdout: (l) => { out.push(l); } });
    return { code, json: JSON.parse(out.join('\n')) as Record<string, unknown> };
  };
  return { run, calls, rpcBodies };
}

async function twoStores() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-store-two-devices-'));
  const old = await anchoredStore({ deviceId: OLD_DEVICE, idPrefix: 'pe_old', makeStore: (id) => new FsPeStore(id, root) });
  const live = await anchoredStore({ deviceId: LIVE_DEVICE, idPrefix: 'pe_live', pes: 3, makeStore: (id) => new FsPeStore(id, root) });
  // The default dep: the device named in ~/.provian/credentials.
  const openPeStore = () => resolveLocalPeStore({ deviceId: LIVE_DEVICE, root, env: {} });
  return { root, old, live, openPeStore };
}

describe('the live PE store only', () => {
  it('`pes` lists the live device\'s presentable PEs, newest first, and none from a store an earlier device left here', async () => {
    const { old, live, openPeStore } = await twoStores();
    // Control: the leftover store is not empty — it holds presentable PEs of its own.
    expect((await listPresentablePes(old.store)).map((p) => p.pe_id)).toEqual(['pe_old_1', 'pe_old_0']);
    const h = harness({ openPeStore });
    const r = await h.run('pes');
    expect(r.code).toBe(0);
    expect(r.json.device_id).toBe(LIVE_DEVICE);
    const ids = (r.json.presentable as { pe_id: string }[]).map((p) => p.pe_id);
    expect(ids).toEqual(['pe_live_2', 'pe_live_1', 'pe_live_0']);
    expect(ids.some((id) => id.startsWith('pe_old'))).toBe(false);
    expect((r.json.presentable as { pe_hash: string }[])[0].pe_hash).toBe(live.pes[2].pe_hash);
    expect(h.calls).toEqual([]);
  });

  it('`--pe` for a PE in the leftover store is refused before any call, naming the live store and `provian pes`', async () => {
    const { openPeStore } = await twoStores();
    const h = harness({ openPeStore });
    const r = await h.run('present', '--burn-id', 'burn_1', '--audience', 'wallet_aw_req', '--challenge', 'c'.repeat(32), '--pe', 'pe_old_0');
    expect(r.code).toBe(2);
    expect(String(r.json.error)).toMatch(/Cannot present: PE pe_old_0/);
    expect(String(r.json.error)).toContain(LIVE_DEVICE);
    expect(String(r.json.error)).toMatch(/provian pes/);
    expect(h.calls).toEqual([]);
    // The live store's own PE is presentable from the same machine (the refusal is the store rule, not a broken store).
    const ok = await h.run('pes', '--limit', '1');
    expect((ok.json.presentable as { pe_id: string }[]).map((p) => p.pe_id)).toEqual(['pe_live_2']);
  });
});

describe('`balance` reads PVT live', () => {
  const LIVE_ATOMIC = 1723951298670400000000n;
  it('passes this agent\'s RPC and address: PVT is balanceOf on the pointer-resolved kernel, not the relay\'s cached figure', async () => {
    const h = harness({}, () => ({ jsonrpc: '2.0', id: 1, result: '0x' + LIVE_ATOMIC.toString(16) }));
    const r = await h.run('balance');
    expect(r.code).toBe(0);
    const kernel = (await protocolRuntimeFixture.currentProtocolDeployment()).addresses.kernel.toLowerCase();
    expect(r.json).toMatchObject({ pvt: '1723.9512986704', pvt_source: 'chain', pvt_token: kernel });
    expect(h.rpcBodies).toHaveLength(1);
    expect((h.rpcBodies[0].params[0] as { to: string }).to).toBe(kernel);
  });

  it('a failed live read prints no PVT figure and says how to fix it', async () => {
    const h = harness({}, () => ({ jsonrpc: '2.0', id: 1, error: { message: 'rate limited' } }));
    const r = await h.run('balance');
    expect(r.json).toMatchObject({ pvt: null, pvt_available: false, pvt_source: 'chain_unavailable' });
    expect(String(r.json.pvt_error)).toMatch(/rate limited.*--rpc-url/);
  });
});
