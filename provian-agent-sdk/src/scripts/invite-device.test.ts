/**
 * invite-device tests.
 *
 * Covers:
 *   (a) runInviteDevice posts to /v1/agent/wallet/:wallet_id/device-invite with
 *       Bearer pvn_live_:pvns_ auth and body { email, device_name?, message? }.
 *   (b) the 0600-enforced agent-credentials loader refuses files more permissive
 *       than 0600.
 *   (c) the response never carries the token (contract is { sent, expires_at }).
 *   (d) email validation (regex + length) fails before any network call.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runInviteDevice,
  assertValidEmail,
  type InviteDeviceDeps,
} from './invite-device-flow';
import { loadAgentCredentialsFile } from './agent-credentials-file';

const API_KEY = 'pvn_live_abcdef1234567890';
const API_SECRET = 'pvns_' + 'a'.repeat(64);
const WALLET_ID = 'wallet_aw_atlas';

function makeMockFetch(
  response: { status?: number; json?: unknown; text?: string },
): { fetch: typeof globalThis.fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const status = response.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => response.json ?? {},
      text: async () => response.text ?? '',
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

function baseDeps(over: Partial<InviteDeviceDeps>, fetchImpl: typeof globalThis.fetch): InviteDeviceDeps {
  return {
    relayUrl: 'https://relay.test',
    walletId: WALLET_ID,
    email: 'bob@example.com',
    creds: { apiKey: API_KEY, apiSecret: API_SECRET },
    fetch: fetchImpl,
    ...over,
  };
}

describe('runInviteDevice', () => {
  it('POSTs to /v1/agent/wallet/:wallet_id/device-invite with agent API auth', async () => {
    const { fetch, calls } = makeMockFetch({ status: 200, json: { sent: true, expires_at: 1_700_000_000_000 } });
    const result = await runInviteDevice(baseDeps({}, fetch));

    expect(result.status).toBe('sent');
    expect((result as { status: 'sent'; expiresAt: number }).expiresAt).toBe(1_700_000_000_000);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://relay.test/v1/agent/wallet/${WALLET_ID}/device-invite`);
    expect(calls[0].init?.method).toBe('POST');

    const auth = (calls[0].init?.headers as Record<string, string>).Authorization;
    expect(auth).toBe(`Bearer ${API_KEY}:${API_SECRET}`);
    expect(auth.startsWith('Bearer pvn_live_')).toBe(true);
    expect(auth.includes(':pvns_')).toBe(true);
  });

  it('sends body { email } and includes device_name / message only when provided', async () => {
    const { fetch, calls } = makeMockFetch({ status: 200, json: { sent: true, expires_at: 1 } });
    await runInviteDevice(baseDeps({ deviceName: "Bob's CI box", message: 'hi bob' }, fetch));
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body).toEqual({ email: 'bob@example.com', device_name: "Bob's CI box", message: 'hi bob' });
  });

  it('omits device_name / message when not provided', async () => {
    const { fetch, calls } = makeMockFetch({ status: 200, json: { sent: true, expires_at: 1 } });
    await runInviteDevice(baseDeps({}, fetch));
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body).toEqual({ email: 'bob@example.com' });
    expect('device_name' in body).toBe(false);
    expect('message' in body).toBe(false);
  });

  it('trims the email before sending', async () => {
    const { fetch, calls } = makeMockFetch({ status: 200, json: { sent: true, expires_at: 1 } });
    await runInviteDevice(baseDeps({ email: '  bob@example.com  ' }, fetch));
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.email).toBe('bob@example.com');
  });

  it('never surfaces a token (response is { sent, expires_at } only)', async () => {
    // Even if a misbehaving relay echoed a token field, runInviteDevice maps
    // only sent + expiresAt; nothing token-shaped escapes the result.
    const { fetch } = makeMockFetch({ status: 200, json: { sent: true, expires_at: 5, token: 'leaked' } });
    const result = await runInviteDevice(baseDeps({}, fetch));
    expect(result).toEqual({ status: 'sent', expiresAt: 5 });
    expect(JSON.stringify(result)).not.toContain('leaked');
  });

  it('rejects a malformed email before any network call', async () => {
    const { fetch, calls } = makeMockFetch({ status: 200, json: { sent: true, expires_at: 1 } });
    const result = await runInviteDevice(baseDeps({ email: 'not-an-email' }, fetch));
    expect(result.status).toBe('error');
    expect(calls).toHaveLength(0);
  });

  it('rejects an over-length email before any network call', async () => {
    const { fetch, calls } = makeMockFetch({ status: 200, json: { sent: true, expires_at: 1 } });
    const longLocal = 'a'.repeat(250);
    const result = await runInviteDevice(baseDeps({ email: `${longLocal}@x.io` }, fetch));
    expect(result.status).toBe('error');
    expect(calls).toHaveLength(0);
  });

  it('returns error on non-2xx with the relay error detail', async () => {
    const { fetch } = makeMockFetch({ status: 429, json: { error: 'rate_limited' } });
    const result = await runInviteDevice(baseDeps({}, fetch));
    expect(result.status).toBe('error');
    expect((result as { status: 'error'; error: string }).error).toContain('429');
    expect((result as { status: 'error'; error: string }).error).toContain('rate_limited');
  });

  it('returns error when the relay omits { sent, expires_at }', async () => {
    const { fetch } = makeMockFetch({ status: 200, json: { ok: true } });
    const result = await runInviteDevice(baseDeps({}, fetch));
    expect(result.status).toBe('error');
  });

  it('returns error when the network call throws', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;
    const result = await runInviteDevice(baseDeps({}, fetch));
    expect(result.status).toBe('error');
    expect((result as { status: 'error'; error: string }).error).toContain('ECONNREFUSED');
  });
});

describe('assertValidEmail', () => {
  it('accepts a normal address', () => {
    expect(() => assertValidEmail('bob@example.com')).not.toThrow();
  });
  it('rejects empty / whitespace', () => {
    expect(() => assertValidEmail('   ')).toThrow();
  });
  it('rejects addresses with no @', () => {
    expect(() => assertValidEmail('bobexample.com')).toThrow();
  });
  it('rejects addresses over 254 chars', () => {
    expect(() => assertValidEmail('a'.repeat(250) + '@x.io')).toThrow();
  });
});

describe('loadAgentCredentialsFile 0600 enforcement', () => {
  let tmpDir: string;
  let credsPath: string;
  const goodJson = JSON.stringify({ api_key: API_KEY, api_secret: API_SECRET, wallet_id: WALLET_ID });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-agentcreds-'));
    credsPath = path.join(tmpDir, 'agent-credentials.json');
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('loads valid creds at mode 0600', () => {
    fs.writeFileSync(credsPath, goodJson, { mode: 0o600 });
    fs.chmodSync(credsPath, 0o600);
    const loaded = loadAgentCredentialsFile(credsPath);
    expect(loaded).not.toBeNull();
    expect(loaded?.api_key).toBe(API_KEY);
    expect(loaded?.api_secret).toBe(API_SECRET);
    expect(loaded?.wallet_id).toBe(WALLET_ID);
  });

  it('refuses a world-readable (0644) creds file', () => {
    if (os.platform() === 'win32') return; // POSIX-only check
    fs.writeFileSync(credsPath, goodJson, { mode: 0o644 });
    fs.chmodSync(credsPath, 0o644);
    const loaded = loadAgentCredentialsFile(credsPath);
    expect(loaded).toBeNull();
  });

  it('refuses a group-readable (0640) creds file', () => {
    if (os.platform() === 'win32') return;
    fs.writeFileSync(credsPath, goodJson, { mode: 0o640 });
    fs.chmodSync(credsPath, 0o640);
    const loaded = loadAgentCredentialsFile(credsPath);
    expect(loaded).toBeNull();
  });

  it('returns null for a missing file', () => {
    expect(loadAgentCredentialsFile(path.join(tmpDir, 'nope.json'))).toBeNull();
  });

  it('returns null when api_key prefix is wrong even at 0600', () => {
    fs.writeFileSync(credsPath, JSON.stringify({ api_key: 'bad', api_secret: API_SECRET }), { mode: 0o600 });
    fs.chmodSync(credsPath, 0o600);
    expect(loadAgentCredentialsFile(credsPath)).toBeNull();
  });
});
