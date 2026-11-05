/**
 * /v1/community/subscribe — identity-free community-updates opt-in.
 *
 * Proves the four load-bearing properties: valid emails land in `waitlist`
 * keyed by email hash with NO identity fields; duplicates and suppressed
 * addresses are indistinguishable from fresh signups in the response (no
 * enumeration) while writing nothing new; malformed input and rate limits
 * refuse; a Redis outage fails CLOSED (503), never open.
 */

import express from 'express';
import request from 'supertest';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from '../core/pvt/__test-helpers__/fake-firestore';
import { createCommunityRouter, WAITLIST_COLLECTION } from './community';
import { EMAIL_SUPPRESSION_COLLECTION, emailHash } from '../core/email/suppression';

const asDb = (db: FakeFirestore): Firestore => db as unknown as Firestore;

type RateResult = { allowed: boolean; retryAfter?: number; error?: string };

function appWith(db: FakeFirestore, rate: (key: string) => RateResult = () => ({ allowed: true })) {
  const cache = {
    checkRateLimitStrict: async (key: string) => rate(key),
  } as never;
  const app = express();
  app.use(express.json());
  app.use('/v1/community', createCommunityRouter({ db: asDb(db), cache }));
  return app;
}

describe('/v1/community/subscribe', () => {
  it('subscribes a fresh address: 200, doc keyed by email hash, no identity fields', async () => {
    const db = createFakeFirestore();
    const res = await request(appWith(db))
      .post('/v1/community/subscribe')
      .send({ email: 'Reader.Example@Provian.AI ', source: 'onboarding' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ subscribed: true });

    const snap = await db.collection(WAITLIST_COLLECTION).doc(emailHash('reader.example@provian.ai')).get();
    expect(snap.exists).toBe(true);
    const data = snap.data()!;
    expect(data.email).toBe('reader.example@provian.ai');
    expect(data.source).toBe('onboarding');
    expect(data.createdAt).toEqual(expect.any(Number));
    // Decoupling is structural: assert NO identity-shaped field ever lands.
    for (const forbidden of ['wallet_id', 'wallet_address', 'user_id', 'device_id', 'agent_id']) {
      expect(data[forbidden]).toBeUndefined();
    }
  });

  it('re-subscribing is idempotent: same 200 body, createdAt preserved, no second doc', async () => {
    const db = createFakeFirestore();
    const app = appWith(db);
    await request(app).post('/v1/community/subscribe').send({ email: 'dup@example.com' });
    const first = await db.collection(WAITLIST_COLLECTION).doc(emailHash('dup@example.com')).get();
    const createdAt = first.data()!.createdAt;

    const res = await request(app).post('/v1/community/subscribe').send({ email: 'DUP@example.com' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ subscribed: true });

    const all = await db.collection(WAITLIST_COLLECTION).get();
    expect(all.docs).toHaveLength(1);
    expect(all.docs[0]?.data()?.createdAt).toBe(createdAt);
  });

  it('a suppressed (unsubscribed) address gets the identical 200 and is NOT re-added', async () => {
    const db = createFakeFirestore();
    await db.collection(EMAIL_SUPPRESSION_COLLECTION).doc(emailHash('gone@example.com')).set({
      email_hash: emailHash('gone@example.com'),
      suppressed_at: Date.now(),
    });

    const res = await request(appWith(db)).post('/v1/community/subscribe').send({ email: 'gone@example.com' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ subscribed: true }); // indistinguishable from success
    expect((await db.collection(WAITLIST_COLLECTION).get()).docs).toHaveLength(0); // nothing written
  });

  it('RED: malformed emails refuse with 400 and write nothing', async () => {
    const db = createFakeFirestore();
    const app = appWith(db);
    for (const bad of ['', 'not-an-email', 'a b@c.com', 'no-domain@nodot', `${'x'.repeat(250)}@example.com`]) {
      const res = await request(app).post('/v1/community/subscribe').send({ email: bad });
      expect(res.status).toBe(400);
    }
    expect((await db.collection(WAITLIST_COLLECTION).get()).docs).toHaveLength(0);
  });

  it('RED: an unknown source is coerced to general, never stored verbatim', async () => {
    const db = createFakeFirestore();
    await request(appWith(db))
      .post('/v1/community/subscribe')
      .send({ email: 'src@example.com', source: '<script>alert(1)</script>' });
    const snap = await db.collection(WAITLIST_COLLECTION).doc(emailHash('src@example.com')).get();
    expect(snap.data()!.source).toBe('general');
  });

  it('RED: rate-limited callers get 429 and write nothing', async () => {
    const db = createFakeFirestore();
    const app = appWith(db, () => ({ allowed: false, retryAfter: 60 }));
    const res = await request(app).post('/v1/community/subscribe').send({ email: 'rl@example.com' });
    expect(res.status).toBe(429);
    expect((await db.collection(WAITLIST_COLLECTION).get()).docs).toHaveLength(0);
  });

  it('RED: a Redis outage fails CLOSED with 503, never subscribes', async () => {
    const db = createFakeFirestore();
    const app = appWith(db, () => ({ allowed: false, error: 'rate_limit_unavailable' }));
    const res = await request(app).post('/v1/community/subscribe').send({ email: 'down@example.com' });
    expect(res.status).toBe(503);
    expect((await db.collection(WAITLIST_COLLECTION).get()).docs).toHaveLength(0);
  });
});
