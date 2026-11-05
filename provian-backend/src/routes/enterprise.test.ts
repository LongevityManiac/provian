/**
 * F40 — POST /v1/enterprise/pilot must key its per-IP limiter on the
 * trust-proxy-resolved req.ip, NOT the LEFTMOST X-Forwarded-For entry (which the
 * client fully controls). RED control: with `X-Forwarded-For: 1.1.1.1, 2.2.2.2`
 * behind `trust proxy 1`, req.ip is the RIGHTMOST hop (2.2.2.2 — what a real edge
 * appends); the limiter key must use that, never the attacker-chosen 1.1.1.1.
 */
import { describe, it, expect, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

jest.mock('../email', () => ({ send: jest.fn(async () => true) }));

import { createEnterpriseRouter } from './enterprise';

function harness() {
  const rateKeys: string[] = [];
  const cache = {
    checkRateLimit: jest.fn(async (key: string) => {
      rateKeys.push(key);
      return { allowed: true } as { allowed: boolean; retryAfter?: number };
    }),
  };
  const db = {
    collection: () => ({
      doc: () => ({
        set: jest.fn(async () => undefined),
        update: jest.fn(async () => undefined),
      }),
    }),
  } as unknown as import('firebase-admin/firestore').Firestore;

  const app = express();
  app.set('trust proxy', 1); // mirror server.ts
  app.use(express.json());
  app.use('/v1/enterprise', createEnterpriseRouter({ db, cache }));
  return { app, rateKeys };
}

describe('POST /v1/enterprise/pilot per-IP limiter key (F40)', () => {
  const body = { name: 'A', email: 'a@example.com', company: 'C', role: 'R' };

  it('RED: keys on req.ip (rightmost XFF hop), not the attacker-chosen leftmost entry', async () => {
    const { app, rateKeys } = harness();
    const res = await request(app)
      .post('/v1/enterprise/pilot')
      .set('X-Forwarded-For', '1.1.1.1, 2.2.2.2')
      .send(body);
    expect(res.status).toBe(201);
    const ipKey = rateKeys.find((k) => k.startsWith('enterprise:ip:'));
    expect(ipKey).toBe('enterprise:ip:2.2.2.2'); // req.ip, the trusted rightmost hop
    expect(ipKey).not.toContain('1.1.1.1'); // never the attacker-chosen leftmost
  });

  it('two requests from the same client (varying only the leftmost XFF) hit the SAME bucket', async () => {
    const { app, rateKeys } = harness();
    await request(app).post('/v1/enterprise/pilot').set('X-Forwarded-For', 'AAA, 9.9.9.9').send(body);
    await request(app).post('/v1/enterprise/pilot').set('X-Forwarded-For', 'BBB, 9.9.9.9').send(body);
    const ipKeys = rateKeys.filter((k) => k.startsWith('enterprise:ip:'));
    expect(ipKeys).toEqual(['enterprise:ip:9.9.9.9', 'enterprise:ip:9.9.9.9']);
  });
});
