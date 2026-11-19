import express from 'express';
import request from 'supertest';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../core/pvt/__test-helpers__/fake-firestore';
import { deterministicDeviceRegistrationIds } from '../core/pvt/genesis-ingress';
import { consumeHumanDeviceToken } from './middleware/device-register-auth';
import { createComputerPairingRouter } from './computer-pairing';

it('scopes the setup command to the paired browser and waits for the exact registered observer', async () => {
  const fake = createFakeFirestore();
  const db = fake as unknown as Firestore;
  const app = express();
  app.use(express.json());
  app.use(createComputerPairingRouter({
    db,
    checkRateLimitStrict: async () => ({ allowed: true }),
    authenticate: (req, res, next) => {
      const wallet = req.get('x-test-wallet');
      if (!wallet) return void res.sendStatus(401);
      req.user = { id: wallet, device_id: 'phone' };
      next();
    },
  }));
  const browserKey = 'a'.repeat(64);
  const start = await request(app).post('/start').send({ browserKey }).expect(201);
  const code: string = start.body.code;
  expect(start.headers['cache-control']).toBe('no-store');
  await request(app).post('/browser-status').send({ browserKey }).expect(200, { state: 'waiting_for_phone' });
  await request(app).post('/confirm').send({ code }).expect(401);
  await request(app).post('/confirm').set('x-test-wallet', 'my-wallet').send({ code }).expect(200);
  await request(app).post('/confirm').set('x-test-wallet', 'other-wallet').send({ code }).expect(404);
  await request(app).post('/browser-status').send({ browserKey: 'b'.repeat(64), code }).expect(404);
  await request(app).post('/phone-status').set('x-test-wallet', 'other-wallet').send({ code }).expect(404);

  const setup = await request(app).post('/browser-status').send({ browserKey }).expect(200);
  const token = String(setup.body.macLinux).match(/x-provian-token: ([0-9a-f]{64})/)?.[1];
  expect(token).toBeDefined();
  expect(setup.body.windows).toContain(token);
  expect(fake.store.get(`setup_tokens/${token}`)).toMatchObject({ user_id: 'my-wallet', used: false });
  const registerId = 'registration-one';
  await expect(consumeHumanDeviceToken(db, token!, registerId, 'consume')).resolves.toEqual({ kind: 'user', userId: 'my-wallet' });
  await expect(consumeHumanDeviceToken(db, token!, 'another-computer', 'consume')).resolves.toEqual({ kind: 'deny' });
  const deviceId = deterministicDeviceRegistrationIds('my-wallet', registerId).deviceId;
  const device = { owner_type: 'human', owner_user_id: 'my-wallet', status: 'active', device_name: 'Example Mac' };
  fake.store.set(`devices/${deviceId}`, device);
  await request(app).post('/phone-status').set('x-test-wallet', 'my-wallet').send({ code })
    .expect(200, { state: 'waiting_for_computer' });

  fake.store.set(`devices/${deviceId}`, { ...device, capture_health: { updated_at: Date.now() } });
  await request(app).post('/phone-status').set('x-test-wallet', 'my-wallet').send({ code })
    .expect(200, { state: 'connected', name: 'Example Mac', deviceId, firstProof: false });
  await request(app).post('/browser-status').send({ browserKey })
    .expect(200, { state: 'connected', name: 'Example Mac', firstProof: false });
});
