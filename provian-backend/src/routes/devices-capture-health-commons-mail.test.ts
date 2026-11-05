/**
 * PUT /v1/devices/me/capture-health tells an agent's observer whether Commons mail waits, so an idle
 * agent polls for mail only when there is some instead of holding a connection or polling on a timer.
 */
import express from 'express';
import request from 'supertest';

let deviceForRequest: Record<string, unknown> = {};
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
const waiting = jest.fn<Promise<boolean>, [unknown, string]>();
jest.mock('../core/commons/agent-delivery', () => ({
  ...jest.requireActual('../core/commons/agent-delivery'),
  deliveryWaiting: (db: unknown, wallet: string) => waiting(db, wallet),
}));

import { createDeviceSelfRouter } from './devices';

function app(): express.Express {
  const db = {
    collection: () => ({ doc: () => ({
      get: async () => ({ exists: false, data: () => undefined }),
      set: async () => undefined,
    }) }),
  };
  const a = express();
  a.use(express.json());
  a.use('/v1/devices', createDeviceSelfRouter({ db: db as never, cache: {} as never }));
  return a;
}
const put = () => request(app()).put('/v1/devices/me/capture-health').send({ schema: 'capture_health/v1' });

describe('PUT /v1/devices/me/capture-health — commons_mail_waiting', () => {
  beforeEach(() => { waiting.mockReset(); });

  it('an agent device hears whether its own wallet has mail waiting', async () => {
    deviceForRequest = { device_id: 'dev_a', owner_type: 'agent', owner_wallet_id: 'wallet_aw_1' };
    waiting.mockResolvedValueOnce(true);
    expect((await put()).body.commons_mail_waiting).toBe(true);
    waiting.mockResolvedValueOnce(false);
    expect((await put()).body.commons_mail_waiting).toBe(false);
    expect(waiting.mock.calls.map(c => c[1])).toEqual(['wallet_aw_1', 'wallet_aw_1']);
  });

  it('a failed read says mail waits: the poll itself authenticates and finds nothing if nothing waits', async () => {
    deviceForRequest = { device_id: 'dev_a', owner_type: 'agent', owner_wallet_id: 'wallet_aw_1' };
    waiting.mockRejectedValueOnce(new Error('unavailable'));
    const res = await put();
    expect(res.status).toBe(200);
    expect(res.body.commons_mail_waiting).toBe(true);
  });

  it('a person\'s device reads nothing and hears nothing about Commons delivery', async () => {
    deviceForRequest = { device_id: 'dev_h', owner_type: 'human', owner_wallet_id: 'wallet_h_1' };
    const res = await put();
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('commons_mail_waiting');
    expect(waiting).not.toHaveBeenCalled();
  });
});
