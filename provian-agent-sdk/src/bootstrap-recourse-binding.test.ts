import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keccak256 } from './keccak256';

const persistedCreds: Array<Record<string, string>> = [];
const persistedKeys: Array<Record<string, unknown>> = [];
let tmpDir = '';

vi.mock('./scripts/agent-credentials-file', async (orig) => ({
  ...(await orig<object>()),
  persistAgentCredentialsFile: (c: Record<string, string>) => { persistedCreds.push(c); return '/tmp/creds'; },
}));
const bind = vi.hoisted(() => ({ calls: [] as Array<{ options: unknown }>, fail: null as Error | null, hang: false }));
vi.mock('./recourse', () => ({ bindRecourseOwnership: async (_config: unknown, _input: unknown, options: unknown) => {
  bind.calls.push({ options });
  if (bind.hang) return new Promise(() => undefined);
  if (bind.fail) throw bind.fail;
  return { status: 'pending' };
} }));
vi.mock('./keystore', async (orig) => ({
  ...(await orig<object>()),
  persistAgentWalletKey: (k: Record<string, unknown>) => { persistedKeys.push(k); return { path: '/tmp/ks' }; },
}));
vi.mock('./local-keystore-secret', async (orig) => ({
  ...(await orig<object>()),
  loadOrCreateLocalKeystoreSecret: () => 'local-at-rest-secret-0123456789',
}));
vi.mock('./pending-wallet-registration', async (orig) => {
  const actual = await orig<typeof import('./pending-wallet-registration')>();
  return {
    ...actual,
    loadOrCreatePendingAgentWalletRegistration: (cfg: Parameters<typeof actual.loadOrCreatePendingAgentWalletRegistration>[0], pass: string) =>
      actual.loadOrCreatePendingAgentWalletRegistration(cfg, pass, path.join(tmpDir, 'pending.json'), { N: 1 << 10, r: 8, p: 1, dklen: 32 }),
  };
});

import { defaultBootstrapDeps } from './bootstrap-flow';

const ANCHOR = 'B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw';
const creds = (n: string) => ({ api_key: `pvn_live_${n.repeat(32)}`, api_secret: `pvns_${n.repeat(64)}` });

function relay(script: Array<{ createStatus: number; creds: { api_key: string; api_secret: string }; escrowStatus: number }>) {
  let createN = 0;
  const escrowAuths: string[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/wallet/challenge')) {
      return { ok: true, status: 200, json: async () => ({ challenge_id: `ch${createN}`, challenge: 'a'.repeat(64) }) };
    }
    const step = script[Math.min(createN === 0 ? 0 : createN - 1, script.length - 1)];
    if (url.endsWith('/recovery-escrow')) {
      escrowAuths.push(String((init?.headers as Record<string, string>).Authorization));
      return { ok: step.escrowStatus < 300, status: step.escrowStatus, json: async () => ({}) };
    }
    const s = script[createN++];
    const body = JSON.parse(String(init?.body)) as { public_key: string };
    return {
      ok: true,
      status: s.createStatus,
      json: async () => ({
        wallet_id: 'wallet_aw_safe0001',
        address: `0x${keccak256(Buffer.from(body.public_key, 'hex')).subarray(12).toString('hex')}`,
        public_key: body.public_key, ...s.creds, pe_chain_root: 'pe_birth', badges: [],
        recovery_anchor_pubkey: ANCHOR, ...(s.createStatus === 200 ? { recovered: true } : {}),
      }),
    };
  });
  return { fetchMock, escrowAuths };
}

const input = { relayUrl: 'https://relay.test', agentId: 'agent-bind', agentName: 'Bind', connectionToken: 'PROV-FLTC-6789', registrationChannel: 'install_line' as const };
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-bind-')); persistedCreds.length = 0; persistedKeys.length = 0;
  bind.calls.length = 0; bind.fail = null; bind.hang = false; });
afterEach(() => { vi.unstubAllGlobals(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('an agent install never waits for or fails on its Recourse binding', () => {
  it('submits the binding without waiting for it to land on chain', async () => {
    const { fetchMock } = relay([{ createStatus: 201, creds: creds('a'), escrowStatus: 200 }]);
    vi.stubGlobal('fetch', fetchMock);
    const wallet = await defaultBootstrapDeps(fetchMock as unknown as typeof fetch).createWallet(input);
    expect(wallet.walletId).toBe('wallet_aw_safe0001');
    expect(bind.calls).toHaveLength(1);
    expect(bind.calls[0].options).toMatchObject({ wait: false, onSigned: expect.any(Function) });
  });
  it('RED CONTROL: a relay refusal or an expired signature leaves the install complete', async () => {
    const { fetchMock } = relay([{ createStatus: 201, creds: creds('a'), escrowStatus: 200 }]);
    vi.stubGlobal('fetch', fetchMock);
    bind.fail = new Error('recourse_request_refused:503');
    const wallet = await defaultBootstrapDeps(fetchMock as unknown as typeof fetch).createWallet(input);
    expect(wallet.apiKey).toBe(creds('a').api_key);
    expect(persistedCreds.at(-1)).toMatchObject({ api_key: creds('a').api_key });
  });
});
