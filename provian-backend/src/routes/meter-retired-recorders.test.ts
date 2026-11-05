/**
 * PE meter: the four retired single-PE recorders answer 410 with a pointer to their batch
 * successor, and their real handlers are gone from server.ts.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import express from 'express';
import request from 'supertest';
import { METER_RETIRED_RECORDERS, mountRetiredRecorders } from './meter-retired-recorders';

function app(): express.Express {
  const instance = express();
  instance.use(express.json());
  mountRetiredRecorders(instance);
  return instance;
}

const SERVER_SOURCE = readFileSync(join(__dirname, '..', 'server.ts'), 'utf8');

describe('retired single-PE recorders', () => {
  test('the table names exactly the four retired recorders and their successors', () => {
    expect(METER_RETIRED_RECORDERS).toEqual({
      '/v1/pe/submit': '/v1/meter/batch',
      '/v1/pe/submit/mobile': '/v1/meter/batch/mobile',
      '/v1/relay/action': '/v1/meter/batch/mobile',
      '/v1/relay/work-product': '/v1/meter/batch/mobile',
    });
  });

  test.each(Object.entries(METER_RETIRED_RECORDERS))(
    'POST %s answers 410 pointing at %s',
    async (retired, successor) => {
      const res = await request(app())
        .post(retired)
        .set('Authorization', 'Bearer anything')
        .send({ action_type: 'agent_action' });
      expect(res.status).toBe(410);
      expect(res.body).toMatchObject({ error: 'pe_recorder_retired', use: successor });
    },
  );

  test('RED control: a path outside the table is not intercepted', async () => {
    // Without this, a mount that answered 410 for every POST would pass the cases above.
    for (const live of ['/v1/pe/submit-sovereign', '/v1/meter/batch', '/v1/meter/batch/mobile']) {
      const res = await request(app()).post(live).send({});
      expect(res.status).toBe(404);
    }
  });

  test('server.ts mounts the intercepts ahead of the runtime boundary quarantine', () => {
    const mount = SERVER_SOURCE.indexOf('mountRetiredRecorders(app);');
    const quarantine = SERVER_SOURCE.indexOf('app.use(createPvt9RuntimeBoundary());');
    expect(mount).toBeGreaterThan(-1);
    expect(quarantine).toBeGreaterThan(-1);
    expect(mount).toBeLessThan(quarantine);
  });

  test('no retired recorder has a real handler left in server.ts', () => {
    for (const retired of Object.keys(METER_RETIRED_RECORDERS)) {
      expect(SERVER_SOURCE).not.toContain(`app.post('${retired}',`);
      expect(SERVER_SOURCE).not.toContain(`app.use('${retired}',`);
    }
    // RED control: the same probe finds a handler that IS there.
    expect(SERVER_SOURCE).toContain("app.post('/v1/meter/batch/mobile',");
  });
});
