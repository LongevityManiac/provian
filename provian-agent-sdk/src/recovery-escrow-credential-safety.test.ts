/**
 * Reviewer defect (/ L381 birth escrow): the escrow at birth must NEVER cost the agent the API
 * credential the create just issued. On the relay's lost-response REPLAY the previous credential is
 * already revoked, so a create that threw on a transient escrow refusal (503
 * recovery_anchor_check_unavailable, a network error) would leave ~/.provian holding a revoked key.
 *
 * Proven through the real install path: `defaultBootstrapDeps().createWallet` → the real
 * `resumeAgentWalletRegistration` → the real birth escrow, with only the file writers and the
 * durable-registration location redirected to a temp dir. RED control: the escrow 503s on a replay;
 * the replay's fresh credential is still persisted and returned, and resuming again escrows.
 */
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

const input = { relayUrl: 'https://relay.test', agentId: 'agent-safe', agentName: 'Safe', connectionToken: 'PROV-FLTC-6789', registrationChannel: 'install_line' as const };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-cred-safety-'));
  persistedCreds.length = 0;
  persistedKeys.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('a failed birth escrow never loses the credential the create issued', () => {
  it('RED CONTROL: escrow 503 on the lost-response REPLAY → the replay\'s fresh credential is persisted and returned', async () => {
    const { fetchMock } = relay([
      { createStatus: 201, creds: creds('a'), escrowStatus: 503 },   // first attempt: response "lost" after escrow fails
      { createStatus: 200, creds: creds('b'), escrowStatus: 503 },   // replay: old credential revoked, escrow 503 again
    ]);
    vi.stubGlobal('fetch', fetchMock);
    const deps = defaultBootstrapDeps(fetchMock as unknown as typeof fetch);
    await deps.createWallet(input);                        // attempt 1 returns (does not throw)
    const replay = await deps.createWallet(input);         // attempt 2: the replay
    expect(replay.apiKey).toBe(creds('b').api_key);
    expect(replay.recoveryEscrowed).toBeUndefined();       // not escrowed → the bootstrap's own step retries
    expect(replay.recoveryAnchorPubkey).toBe(ANCHOR);
    expect(persistedCreds.at(-1)).toMatchObject({ api_key: creds('b').api_key, api_secret: creds('b').api_secret, wallet_id: 'wallet_aw_safe0001' });
    expect(persistedKeys).toHaveLength(2);
  });

  it('resuming the same durable registration again escrows (with the then-current credential)', async () => {
    const { fetchMock, escrowAuths } = relay([
      { createStatus: 201, creds: creds('a'), escrowStatus: 503 },
      { createStatus: 200, creds: creds('c'), escrowStatus: 200 },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    const deps = defaultBootstrapDeps(fetchMock as unknown as typeof fetch);
    const first = await deps.createWallet(input);
    expect(first.recoveryEscrowed).toBeUndefined();
    const second = await deps.createWallet(input);
    expect(second.recoveryEscrowed).toBe(true);
    expect(escrowAuths.at(-1)).toBe(`Bearer ${creds('c').api_key}:${creds('c').api_secret}`);
    expect(persistedCreds.at(-1)?.api_key).toBe(creds('c').api_key);
  });
});
