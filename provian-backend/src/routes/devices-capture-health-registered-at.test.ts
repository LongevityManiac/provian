/**
 * PUT /v1/devices/me/capture-health answers with the device's registration
 * time — the fence a daemon applies before minting a snapshot-written (backfilled)
 * transcript turn (09-07 ruling: turns whose activity predates registration never mint).
 */
import express from 'express';
import request from 'supertest';

const DEVICE = { device_id: 'dev_test', created_at: 1_790_466_108_445, owner_type: 'agent' };
let deviceForRequest: Record<string, unknown> | null = DEVICE;
jest.mock('./middleware/device-auth', () => {
  const actual = jest.requireActual('./middleware/device-auth');
  return {
    ...actual,
    createDeviceAuthMiddleware: () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      (req as unknown as { device: unknown }).device = deviceForRequest;
      next();
    },
  };
});

import { createDeviceSelfRouter } from './devices';

// What Firestore holds for the device (the route reads it fresh); null: no document.
let storedDoc: Record<string, unknown> | null = null;
function app(): { app: express.Express; writes: Array<Record<string, unknown>> } {
  const writes: Array<Record<string, unknown>> = [];
  const db = {
    collection: () => ({ doc: () => ({
      get: async () => ({ exists: storedDoc !== null, data: () => storedDoc ?? undefined }),
      set: async (v: Record<string, unknown>, opts: unknown) => { writes.push({ v, opts }); },
    }) }),
  };
  const a = express();
  a.use(express.json());
  a.use('/v1/devices', createDeviceSelfRouter({ db: db as never, cache: {} as never }));
  return { app: a, writes };
}

describe('PUT /v1/devices/me/capture-health — device_registered_at_ms', () => {
  beforeEach(() => { deviceForRequest = DEVICE; storedDoc = null; });

  it('returns the device record\'s created_at as device_registered_at_ms', async () => {
    const { app: a, writes } = app();
    const res = await request(a).put('/v1/devices/me/capture-health').send({ schema: 'capture_health/v1' });
    expect(res.status).toBe(200);
    expect(res.body.device_registered_at_ms).toBe(DEVICE.created_at);
    expect(writes).toHaveLength(1);
    // The report replaces the stored one whole: a retired field can never linger.
    expect(writes[0].opts).toEqual({ mergeFields: ['capture_health'] });
  });

  it('a device record without a numeric created_at answers null (the daemon holds, never guesses)', async () => {
    deviceForRequest = { device_id: 'dev_x', created_at: 'yesterday' };
    const { app: a } = app();
    const res = await request(a).put('/v1/devices/me/capture-health').send({});
    expect(res.status).toBe(200);
    expect(res.body.device_registered_at_ms).toBeNull();
  });
});

// the card's last activity is the last command the process lane sealed. A daemon
// restarted since knows none, so the relay keeps the last one reported.
describe('PUT /v1/devices/me/capture-health — the last witnessed command survives a daemon restart', () => {
  const stored = (v: unknown) => ({ ...DEVICE, capture_health: { process_last_act_at_ms: v } });
  beforeEach(() => { deviceForRequest = DEVICE; storedDoc = null; });
  const put = async (body: Record<string, unknown>) => {
    const { app: a, writes } = app();
    const res = await request(a).put('/v1/devices/me/capture-health').send(body);
    expect(res.status).toBe(200);
    return (writes[0].v as { capture_health: { process_last_act_at_ms: number | null } }).capture_health.process_last_act_at_ms;
  };

  it('a report with none keeps the stored moment (RED: a report with its own moment replaces it)', async () => {
    storedDoc = stored(1_790_000_000_000);
    expect(await put({})).toBe(1_790_000_000_000);
    expect(await put({ process_last_act_at_ms: 1_790_000_500_000 })).toBe(1_790_000_500_000);
  });

  it('RED: a stored moment that is not a past instant is never carried over', async () => {
    for (const v of ['1790000000000', 0, -1, Number.MAX_SAFE_INTEGER, null]) {
      storedDoc = stored(v);
      expect(await put({})).toBeNull();
    }
    storedDoc = null;
    expect(await put({})).toBeNull();
  });

  it('reads the stored moment fresh, never from the authenticated device (a cache up to 30 s old; RED: the cached copy alone is not used)', async () => {
    deviceForRequest = stored(1_790_000_000_000);       // the cache's copy
    storedDoc = stored(1_790_000_900_000);              // what the last report wrote
    expect(await put({})).toBe(1_790_000_900_000);
    storedDoc = { ...DEVICE };
    expect(await put({})).toBeNull();
  });
});
