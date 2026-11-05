/**
 * End-to-end: the relay's X-Provian-SDK-* response headers drive the SDK's
 * staleness state and the one-time nudge, through a real ProvianClient.connect.
 *
 * RED negative controls are explicit: a below-minSupported advert triggers the
 * loud path (and, under strictSdkVersion, a connect throw), while an up-to-date
 * advert stays silent — proving the wiring is not hardwired to warn.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ProvianClient } from './ProvianClient';
import { SDK_VERSION } from './version';

const RELAY = 'https://api.provian.ai';

// Serves the sovereign-mode connect probe (GET /v1/sdk/version) with optional X-Provian-SDK-* headers.
function installConnectMock(headers: Record<string, string> | null) {
  const hget = (name: string): string | null => {
    if (!headers) return null;
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? headers[key] : null;
  };
  const mock = vi.fn(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    if (url.endsWith('/v1/sdk/version') && method === 'GET') {
      return {
        ok: true,
        status: 200,
        headers: { get: hget },
        json: async () => ({ session_id: 'sess_1', agent_id: 'agent_1', user_id: 'user_1' }),
        text: async () => '',
      };
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  });
  (globalThis as unknown as { fetch: unknown }).fetch = mock;
  return mock;
}

describe('SDK staleness via relay headers', () => {
  afterEach(() => vi.restoreAllMocks());

  it('warns ONCE and marks stale when the relay advertises a newer latest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installConnectMock({ 'X-Provian-SDK-Latest': '99.0.0', 'X-Provian-SDK-Min': '1.0.0' });

    const client = new ProvianClient({ relayUrl: RELAY, agentId: 'atlas' });
    await client.connect();

    const s = client.getSdkStaleness();
    expect(s.current).toBe(SDK_VERSION);
    expect(s.latest).toBe('99.0.0');
    expect(s.stale).toBe(true);
    expect(s.belowMin).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/newer @provian\/agent-sdk/i);
  });

  it('RED CONTROL: below-minSupported advert logs the loud (error) nudge', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    installConnectMock({ 'X-Provian-SDK-Latest': '99.0.0', 'X-Provian-SDK-Min': '99.0.0' });

    const client = new ProvianClient({ relayUrl: RELAY, agentId: 'atlas' });
    await client.connect();

    expect(client.getSdkStaleness().belowMin).toBe(true);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toMatch(/BELOW the minimum/i);
  });

  it('strictSdkVersion THROWS on connect when below the minimum', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    installConnectMock({ 'X-Provian-SDK-Latest': '99.0.0', 'X-Provian-SDK-Min': '99.0.0' });

    const client = new ProvianClient({
      relayUrl: RELAY,
      agentId: 'atlas',
      strictSdkVersion: true,
    });
    await expect(client.connect()).rejects.toThrow(/below the minimum supported/i);
  });

  it('CONTROL: an up-to-date advert stays silent and connects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    installConnectMock({ 'X-Provian-SDK-Latest': SDK_VERSION, 'X-Provian-SDK-Min': '1.0.0' });

    const client = new ProvianClient({ relayUrl: RELAY, agentId: 'atlas' });
    const res = await client.connect();

    expect(res.success).toBe(true);
    expect(client.getSdkStaleness().stale).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('fail-open: a relay that advertises NOTHING never flags or throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installConnectMock(null); // no headers at all

    const client = new ProvianClient({
      relayUrl: RELAY,
      agentId: 'atlas',
      strictSdkVersion: true, // even strict mode must not throw without a signal
    });
    const res = await client.connect();

    expect(res.success).toBe(true);
    const s = client.getSdkStaleness();
    expect(s.latest).toBeNull();
    expect(s.stale).toBe(false);
    expect(s.belowMin).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
