/**
 * runConnectFlow tests - pure flow logic, mock fetch + sleep + onInstallUrl.
 * Uses vitest per provian-agent-sdk/package.json convention.
 */

import { describe, it, expect, vi } from 'vitest';
import { runConnectFlow, type ConnectFlowDeps } from './connect-github-flow';

const STATE = '0123456789abcdef'.repeat(4);

function makeMockFetch(responses: Array<{ status?: number; json?: unknown; text?: string }>): typeof globalThis.fetch {
  const queue = [...responses];
  return vi.fn(async () => {
    const next = queue.shift() ?? { status: 200, json: { status: 'pending' } };
    return {
      ok: (next.status ?? 200) >= 200 && (next.status ?? 200) < 300,
      status: next.status ?? 200,
      json: async () => next.json ?? {},
      text: async () => next.text ?? '',
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
}

function baseDeps(over: Partial<ConnectFlowDeps>): ConnectFlowDeps {
  return {
    relayUrl: 'https://relay.test',
    deviceKey: 'pdk_x',
    deviceSecret: 'pds_y',
    state: STATE,
    timeoutMs: 1_000,
    fetch: makeMockFetch([]),
    sleep: vi.fn(async () => {}),
    onInstallUrl: vi.fn(async () => {}),
    pollIntervalMs: 1,
    ...over,
  };
}

describe('runConnectFlow', () => {
  it('returns completed when start + first poll succeeds', async () => {
    const fetch = makeMockFetch([
      { status: 200, json: { install_url: 'https://github.com/apps/x/installations/new?state=' + STATE, expires_at: Date.now() + 1000 } },
      { status: 200, json: { status: 'completed', install_id: '42', pe_id: 'pe_abc' } },
    ]);
    const onInstallUrl = vi.fn(async () => {});
    const result = await runConnectFlow(baseDeps({ fetch, onInstallUrl }));
    expect(result.status).toBe('completed');
    expect((result as any).install_id).toBe('42');
    expect((result as any).pe_id).toBe('pe_abc');
    expect(onInstallUrl).toHaveBeenCalledTimes(1);
    expect(onInstallUrl).toHaveBeenCalledWith(expect.stringContaining('github.com/apps/x/installations/new'));
  });

  it('polls multiple times until completion', async () => {
    const fetch = makeMockFetch([
      { status: 200, json: { install_url: 'https://github.com/apps/x/installations/new', expires_at: Date.now() + 5000 } },
      { status: 200, json: { status: 'pending' } },
      { status: 200, json: { status: 'pending' } },
      { status: 200, json: { status: 'completed', install_id: '1', pe_id: 'pe_z' } },
    ]);
    const result = await runConnectFlow(baseDeps({ fetch, timeoutMs: 5_000 }));
    expect(result.status).toBe('completed');
  });

  it('returns timeout on expired session', async () => {
    const fetch = makeMockFetch([
      { status: 200, json: { install_url: 'https://github.com/apps/x/installations/new', expires_at: Date.now() + 1000 } },
      { status: 200, json: { status: 'expired' } },
    ]);
    const result = await runConnectFlow(baseDeps({ fetch, timeoutMs: 5_000 }));
    expect(result.status).toBe('timeout');
  });

  it('returns a terminal error when the relay answers conflict (installation owned by another wallet)', async () => {
    const fetch = makeMockFetch([
      { status: 200, json: { install_url: 'https://github.com/apps/x/installations/new', expires_at: Date.now() + 5000 } },
      { status: 200, json: { status: 'conflict', reason: 'installation_already_linked' } },
    ]);
    const result = await runConnectFlow(baseDeps({ fetch, timeoutMs: 5_000 }));
    expect(result.status).toBe('error');
    expect((result as any).error).toContain('installation_already_linked');
  });

  it('returns timeout when poll never returns completion before deadline', async () => {
    const fetch = makeMockFetch([
      { status: 200, json: { install_url: 'https://github.com/apps/x/installations/new', expires_at: Date.now() + 100 } },
      { status: 200, json: { status: 'pending' } },
      { status: 200, json: { status: 'pending' } },
      { status: 200, json: { status: 'pending' } },
    ]);
    const result = await runConnectFlow(baseDeps({ fetch, timeoutMs: 50 }));
    // After polling, deadline is reached before any non-pending response surfaces.
    expect(result.status).toBe('timeout');
  });

  it('returns error when start endpoint fails', async () => {
    const fetch = makeMockFetch([
      { status: 503, text: 'github_connect_not_configured' },
    ]);
    const result = await runConnectFlow(baseDeps({ fetch }));
    expect(result.status).toBe('error');
    expect((result as any).error).toContain('503');
  });

  it('returns error when start response lacks install_url', async () => {
    const fetch = makeMockFetch([
      { status: 200, json: { } }, // missing install_url
    ]);
    const result = await runConnectFlow(baseDeps({ fetch }));
    expect(result.status).toBe('error');
    expect((result as any).error).toContain('install_url');
  });

  it('sends DeviceKey auth on both start and poll', async () => {
    const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization ?? '';
      expect(auth).toBe('DeviceKey pdk_x:pds_y');
      // Differentiate start vs poll
      if (String(url).endsWith('/connect/start')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ install_url: 'https://github.com/apps/x/installations/new', expires_at: Date.now() + 1000 }),
          text: async () => '',
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'completed', install_id: '5', pe_id: 'pe_5' }),
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;
    const result = await runConnectFlow(baseDeps({ fetch }));
    expect(result.status).toBe('completed');
  });

  it('sends state in the POST start body', async () => {
    let observedBody: string | undefined;
    const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/connect/start')) {
        observedBody = init?.body as string | undefined;
        return {
          ok: true,
          status: 200,
          json: async () => ({ install_url: 'https://example/', expires_at: Date.now() + 1000 }),
          text: async () => '',
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'completed', install_id: '7', pe_id: 'pe_7' }),
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;
    await runConnectFlow(baseDeps({ fetch }));
    expect(observedBody).toBeDefined();
    const parsed = JSON.parse(observedBody!);
    expect(parsed.state).toBe(STATE);
  });

  it('sends state in the GET poll query string (URL-encoded)', async () => {
    let observedPollUrl: string | undefined;
    const fetch = vi.fn(async (url: string | URL) => {
      const s = String(url);
      if (s.endsWith('/connect/start')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ install_url: 'https://example/', expires_at: Date.now() + 1000 }),
          text: async () => '',
        } as unknown as Response;
      }
      observedPollUrl = s;
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'completed', install_id: '8', pe_id: 'pe_8' }),
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;
    await runConnectFlow(baseDeps({ fetch }));
    expect(observedPollUrl).toContain(`state=${STATE}`);
  });
});
