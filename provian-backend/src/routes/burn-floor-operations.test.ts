/**
 * work package minimum-burn FLOOR operations route (Part 1,).
 *
 * The floor is a SETTABLE value with a bounded max — the relay-side analogue of
 * the institutions' on-chain scheduleFeeBps. These tests bind the admin gate and
 * the bound with paired controls : a schedule takes effect and is read
 * back (reachability), while wrong/no auth and an out-of-bound value are refused
 * (the strictness controls).
 */
import express from 'express';
import request from 'supertest';
import { createBurnFloorOperationsRouter, BURN_FLOOR_SCHEDULE_PATH, BURN_FLOOR_READ_PATH } from './burn-floor-operations';
import { BURN_FLOOR_MAX_ATOMIC } from '../core/commons/burn-consumption';

const ONE_PVT = 1_000_000_000_000_000_000n;
const ADMIN_KEY = 'test-admin-key';

type Row = Record<string, unknown>;
function fakeDb() {
  const store = new Map<string, Map<string, Row>>();
  const coll = (n: string) => {
    let c = store.get(n);
    if (!c) { c = new Map(); store.set(n, c); }
    return c;
  };
  return {
    collection: (name: string) => ({
      doc: (id: string) => ({
        async get() { const r = coll(name).get(id); return { exists: r !== undefined, data: () => (r ? { ...r } : undefined) }; },
        async set(data: Row, opts?: { merge?: boolean }) {
          coll(name).set(id, opts?.merge ? { ...(coll(name).get(id) ?? {}), ...data } : { ...data });
        },
      }),
    }),
  } as never;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(createBurnFloorOperationsRouter({ db: fakeDb(), now: () => 1000 }));
  return app;
}

describe('work package burn-floor operations route', () => {
  const OLD = { ...process.env };
  beforeEach(() => { process.env.ADMIN_API_KEY = ADMIN_KEY; });
  afterEach(() => { process.env = { ...OLD }; });

  it('rejects unauthenticated + wrong-key requests (401)', async () => {
    const app = buildApp();
    expect((await request(app).get(BURN_FLOOR_READ_PATH)).status).toBe(401);
    expect((await request(app).post(BURN_FLOOR_SCHEDULE_PATH).set('x-admin-key', 'nope').send({ product: 'vouch', amount_atomic: '0' })).status).toBe(401);
  });

  it('GET reports launch-literal floors under admin auth', async () => {
    const res = await request(buildApp()).get(BURN_FLOOR_READ_PATH).set('x-admin-key', ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(res.body.floors.name_registry).toBe((15n * ONE_PVT).toString());
    expect(res.body.floors.standing_export).toBe('0');
    expect(res.body.max_atomic).toBe(BURN_FLOOR_MAX_ATOMIC.toString());
  });

  it('schedules a new floor and reads it back (ratchets on live data)', async () => {
    const app = buildApp();
    const res = await request(app)
      .post(BURN_FLOOR_SCHEDULE_PATH).set('x-admin-key', ADMIN_KEY)
      .send({ product: 'vouch', amount_atomic: (30n * ONE_PVT).toString() });
    expect(res.status).toBe(200);
    expect(res.body.floors.vouch).toBe((30n * ONE_PVT).toString());
    // other products unchanged
    expect(res.body.floors.pledge).toBe((15n * ONE_PVT).toString());
  });

  it('CONTROL: a floor above the bound is refused (400), not clamped', async () => {
    const res = await request(buildApp())
      .post(BURN_FLOOR_SCHEDULE_PATH).set('x-admin-key', ADMIN_KEY)
      .send({ product: 'pledge', amount_atomic: (BURN_FLOOR_MAX_ATOMIC + 1n).toString() });
    expect(res.status).toBe(400);
  });

  it('CONTROL: unknown product and non-integer amount are refused (400)', async () => {
    const app = buildApp();
    expect((await request(app).post(BURN_FLOOR_SCHEDULE_PATH).set('x-admin-key', ADMIN_KEY).send({ product: 'nope', amount_atomic: '0' })).status).toBe(400);
    expect((await request(app).post(BURN_FLOOR_SCHEDULE_PATH).set('x-admin-key', ADMIN_KEY).send({ product: 'vouch', amount_atomic: '12.5' })).status).toBe(400);
  });
});
