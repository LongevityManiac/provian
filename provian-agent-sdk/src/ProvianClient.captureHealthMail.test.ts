/**
 * The capture-health heartbeat answer carries whether Commons mail waits for this agent, so the
 * observer polls for mail only then. RED controls: anything but a literal true is "nothing waits".
 */
import { describe, it, expect, vi } from 'vitest';
import { ProvianClient } from './ProvianClient';

async function answer(body: unknown, status = 200) {
  const client = new ProvianClient({ relayUrl: 'https://relay.test', deviceKey: 'pdk_x', deviceSecret: 'pds_x', deviceId: 'dev_t' });
  vi.spyOn(client as unknown as { fetchWithTimeout: () => Promise<Response> }, 'fetchWithTimeout')
    .mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  return client.reportCaptureHealth({ schema: 'capture_health/v1' });
}

describe('reportCaptureHealth → commonsMailWaiting', () => {
  it('a relay naming waiting mail wakes the poll', async () => {
    expect(await answer({ ok: true, device_registered_at_ms: 1, commons_mail_waiting: true })).toEqual({ deviceRegisteredAtMs: 1, commonsMailWaiting: true });
  });
  it('RED: absent, false or a non-boolean value is nothing waiting', async () => {
    for (const v of [undefined, false, 'true', 1, null]) {
      expect((await answer({ ok: true, commons_mail_waiting: v }))?.commonsMailWaiting).toBe(false);
    }
  });
  it('a failed heartbeat reports nothing and never throws', async () => {
    expect(await answer({ error: 'x' }, 500)).toBeNull();
  });
});
