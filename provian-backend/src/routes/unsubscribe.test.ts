/**
 * Finding 17 — the functional /v1/unsubscribe surface. Proves the GET one-click
 * link and the RFC 8058 POST both really suppress, and that a bad token cannot.
 */

import express from 'express';
import request from 'supertest';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from '../core/pvt/__test-helpers__/fake-firestore';
import { createUnsubscribeRouter } from './unsubscribe';
import {
  EMAIL_SUPPRESSION_COLLECTION,
  emailHash,
  isEmailSuppressed,
  signUnsubscribeToken,
} from '../core/email/suppression';

const asDb = (db: FakeFirestore): Firestore => db as unknown as Firestore;

function appWith(db: FakeFirestore) {
  const cache = { checkRateLimit: async () => ({ allowed: true }) } as never;
  const app = express();
  app.use(express.json());
  app.use('/v1/unsubscribe', createUnsubscribeRouter({ db: asDb(db), cache }));
  return app;
}

describe('/v1/unsubscribe (finding 17)', () => {
  const ORIGINAL = process.env.UNSUBSCRIBE_TOKEN_SECRET;
  beforeEach(() => { process.env.UNSUBSCRIBE_TOKEN_SECRET = 'a-sufficiently-long-test-secret-value'; });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.UNSUBSCRIBE_TOKEN_SECRET;
    else process.env.UNSUBSCRIBE_TOKEN_SECRET = ORIGINAL;
  });

  it('GET with a valid token suppresses and renders the confirmation page', async () => {
    const db = createFakeFirestore();
    const token = signUnsubscribeToken('user@example.com')!;
    const res = await request(appWith(db)).get(`/v1/unsubscribe?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/unsubscribed/i);
    expect(await isEmailSuppressed(asDb(db), 'user@example.com')).toBe(true);
  });

  it('RED: GET with an invalid token does NOT suppress and returns 400', async () => {
    const db = createFakeFirestore();
    const res = await request(appWith(db)).get('/v1/unsubscribe?token=not-a-real-token');
    expect(res.status).toBe(400);
    const snap = await db.collection(EMAIL_SUPPRESSION_COLLECTION).get();
    expect(snap.docs).toHaveLength(0); // nothing suppressed
  });

  it('POST (RFC 8058 one-click) with a valid token suppresses and returns JSON', async () => {
    const db = createFakeFirestore();
    const token = signUnsubscribeToken('list@example.com')!;
    const res = await request(appWith(db)).post('/v1/unsubscribe').send({ token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unsubscribed: true });
    const snap = await db.collection(EMAIL_SUPPRESSION_COLLECTION).doc(emailHash('list@example.com')).get();
    expect(snap.exists).toBe(true);
  });

  it('RED: POST with an invalid token returns 400 and suppresses nothing', async () => {
    const db = createFakeFirestore();
    const res = await request(appWith(db)).post('/v1/unsubscribe').send({ token: 'garbage.garbage' });
    expect(res.status).toBe(400);
    expect((await db.collection(EMAIL_SUPPRESSION_COLLECTION).get()).docs).toHaveLength(0);
  });
});
