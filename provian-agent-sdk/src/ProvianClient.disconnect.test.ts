/**
 * ProvianClient.disconnect — there is no relay session to revoke.
 *
 * - Sovereign mode: clears local state, never calls the relay.
 * - Device mode: clears the connected flag, never calls the relay.
 * - Idempotent either way.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ProvianClient } from './ProvianClient';

describe('ProvianClient.disconnect', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('sovereign mode: clears local state without any relay call', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const client = new ProvianClient({ relayUrl: 'https://relay.test', agentId: 'agent-1' });
    await client.connect();
    fetchSpy.mockClear();
    const res = await client.disconnect();
    expect(res).toEqual({ revoked: true });
    expect(client.isConnected()).toBe(false);
    // RED half: the retired DELETE /v1/relay/agent/session must never fire.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('device mode: clears connected flag and returns success without calling the relay', async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchSpy);
    const client = new ProvianClient({ relayUrl: 'https://relay.test', deviceKey: 'pdk_x', deviceSecret: 'pds_y' });
    await client.connect();
    fetchSpy.mockClear();
    const res = await client.disconnect();
    expect(res).toEqual({ revoked: true });
    expect(client.isConnected()).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('idempotent: calling disconnect twice is safe', async () => {
    const client = new ProvianClient({ relayUrl: 'https://relay.test' });
    expect(await client.disconnect()).toEqual({ revoked: true });
    expect(await client.disconnect()).toEqual({ revoked: true });
  });
});
