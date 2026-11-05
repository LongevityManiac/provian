import { describe, it, expect, vi, afterEach } from 'vitest';
import { ProvianClient } from './ProvianClient';
import { SUBMIT_OBSERVED_PE } from './observed-submit';
import { ConnectionError } from './errors';

const RELAY = 'https://api.provian.ai';

// the relay agent-session channel (POST /v1/relay/agent/connect, the
// connect PoP challenge, `Bearer {session_id}`) is REMOVED. A client is either in
// device mode (the witness that records PEs) or in sovereign mode (relayUrl only;
// every authenticated call is signed by the agent's own key at the call site).
describe('the relay agent-session channel is gone', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('RED: a connectionToken config is refused at construction (no silent keyless session)', () => {
    expect(() => new ProvianClient({ relayUrl: RELAY, connectionToken: 'PROV-ABCD-EFGH', agentId: 'atlas' } as never))
      .toThrow(/agent-session channel was removed/);
    expect(() => new ProvianClient({ relayUrl: RELAY, agentWalletId: 'wallet_aw_x', agentWalletKeyHex: 'ab'.repeat(32) } as never))
      .toThrow(/agent-session channel was removed/);
  });

  it('sovereign mode: connect() probes GET /v1/sdk/version, never POSTs a connect, never sends a bearer', async () => {
    const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', headers: (init?.headers as Record<string, string>) ?? {} });
      return new Response('{}', { status: 200 });
    }));
    const client = new ProvianClient({ relayUrl: RELAY, agentId: 'atlas' });
    const res = await client.connect();
    expect(res.success).toBe(true);
    expect(client.isConnected()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${RELAY}/v1/sdk/version`);
    expect(calls[0].method).toBe('GET');
    expect(calls.some((c) => c.url.includes('/v1/relay/agent/connect'))).toBe(false);
    expect(Object.keys(calls[0].headers).map((k) => k.toLowerCase())).not.toContain('authorization');
  });

  it('sovereign mode: connect() fails CLOSED on an unreachable relay', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const client = new ProvianClient({ relayUrl: RELAY });
    await expect(client.connect()).rejects.toBeInstanceOf(ConnectionError);
    expect(client.isConnected()).toBe(false);
  });

  it("sovereign mode: connect() fails CLOSED when the probe answers non-2xx ", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
    const client = new ProvianClient({ relayUrl: RELAY });
    await expect(client.connect()).rejects.toBeInstanceOf(ConnectionError);
    expect(client.isConnected()).toBe(false);
  });

  it('no public report method exists; the internal observed-PE submitter throws NO_WITNESS_PATH without device credentials and never posts', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const client = new ProvianClient({ relayUrl: RELAY });
    await client.connect();
    fetchSpy.mockClear();
    const surface = client as unknown as Record<string, unknown>;
    expect(surface.reportAction).toBeUndefined();
    expect(surface.reportWorkProduct).toBeUndefined();
    await expect(client[SUBMIT_OBSERVED_PE]({
      actionType: 'agent_tool_orchestration',
      description: 'a sovereign client with no registered device',
      success: true,
    })).rejects.toMatchObject({ code: 'NO_WITNESS_PATH' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// Fail-closed tests for audit Pass-3 #37 (device-mode connect() must NOT report
// success on an unreachable / unauthorized relay) and the #10 per-request
// timeout mechanism as it applies to the connect probe. "Unknown = Block, Not
// Warn." (Moved from ProvianClient.failClosed.test.ts when the governance
// approval path was retired.)

/** A fetch mock that hangs until its AbortSignal fires, then rejects (like undici). */
function hangingSignalAwareFetch() {
  return vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal) {
      if (signal.aborted) reject(new DOMException('aborted', 'AbortError'));
      else signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }
  })) as unknown as typeof fetch;
}

describe('#37 device-mode connect() fails closed on an unreachable / unauthorized relay', () => {
  const deviceCfg = { relayUrl: 'https://relay.test', deviceKey: 'pdk', deviceSecret: 'pds' };
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('throws (does NOT return { success:true }) when the OPTIONS probe rejects (unreachable)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const client = new ProvianClient(deviceCfg);
    await expect(client.connect()).rejects.toBeInstanceOf(ConnectionError);
    expect(client.isConnected()).toBe(false);
  });

  it('throws when the probe is unauthorized (401)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));
    const client = new ProvianClient(deviceCfg);
    await expect(client.connect()).rejects.toThrow(/rejected by the relay/i);
    expect(client.isConnected()).toBe(false);
  });

  it('throws when the probe hangs past the per-request timeout (the #10 mechanism)', async () => {
    vi.stubGlobal('fetch', hangingSignalAwareFetch());
    const client = new ProvianClient({ ...deviceCfg, requestTimeout: 30 });
    await expect(client.connect()).rejects.toBeInstanceOf(ConnectionError);
    expect(client.isConnected()).toBe(false);
  });

  it('still succeeds on a reachable relay (200) — regression guard', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const client = new ProvianClient(deviceCfg);
    const res = await client.connect();
    expect(res.success).toBe(true);
    expect(client.isConnected()).toBe(true);
  });
});
