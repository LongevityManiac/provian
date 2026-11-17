/**
 * rateHumanJob commits the rating, the job's reference to it and the PE in ONE
 * transaction, after re-reading the job and the rater's existing ratings inside
 * it. Runs the real writer and the real generatePE against the fake Firestore.
 */
import { describe, it, expect } from '@jest/globals';
import { rateHumanJob } from './human-jobs';
import { COMMONS_COLLECTIONS, type CommonsDeps } from './types';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { METER_RELAY_ACTS_COLLECTION } from '../meter/meter-relay-authored';

const POSTER = 'wallet_poster';
const WORKER = 'wallet_worker';

function makeDeps(db: FakeFirestore): CommonsDeps {
  return {
    db,
    cache: { checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }) },
    peBuffer: { enqueue: () => {} },
    recordPEAccrual: async () => {},
  } as unknown as CommonsDeps;
}

function seed(db: FakeFirestore, status: string = 'completed'): void {
  db.store.set(`${COMMONS_COLLECTIONS.HUMAN_JOBS}/hjob1`, {
    job_id: 'hjob1',
    poster_wallet_id: POSTER,
    accepted_applicant_wallet_id: WORKER,
    title: 'Translate a document',
    status,
  });
}

const docsIn = (db: FakeFirestore, collection: string): Array<Record<string, unknown>> =>
  [...db.store.entries()].filter(([k]) => k.startsWith(`${collection}/`)).map(([, v]) => v);
const ratings = (db: FakeFirestore) => docsIn(db, COMMONS_COLLECTIONS.HUMAN_JOB_RATINGS);
const ratedActs = (db: FakeFirestore) => docsIn(db, METER_RELAY_ACTS_COLLECTION);

describe('rateHumanJob is atomic', () => {
  it('records the rating, points the job at its PE, and commits the PE with them', async () => {
    const db = createFakeFirestore();
    seed(db);
    const rating = await rateHumanJob(makeDeps(db), POSTER, POSTER, null, 'hjob1', { rating: 5 });
    expect(ratings(db)).toHaveLength(1);
    expect(ratings(db)[0]).toMatchObject({ rating_id: rating.rating_id, pe_id: rating.pe_id, rater_wallet_id: POSTER, ratee_wallet_id: WORKER, rating: 5 });
    expect(db.store.get(`${COMMONS_COLLECTIONS.HUMAN_JOBS}/hjob1`)).toMatchObject({ rating_pe_id: rating.pe_id });
    expect(ratedActs(db)).toHaveLength(1);
  });

  it('RED: two concurrent ratings by one rater leave exactly one rating and one PE', async () => {
    const db = createFakeFirestore();
    seed(db);
    const deps = makeDeps(db);
    const results = await Promise.allSettled([
      rateHumanJob(deps, POSTER, POSTER, null, 'hjob1', { rating: 5 }),
      rateHumanJob(deps, POSTER, POSTER, null, 'hjob1', { rating: 1 }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(refused.reason)).toMatch(/Already rated/);
    expect(ratings(db)).toHaveLength(1);
    expect(ratedActs(db)).toHaveLength(1);
  });

  it('a repeat rating is refused and writes nothing; the other party can still rate', async () => {
    const db = createFakeFirestore();
    seed(db);
    const deps = makeDeps(db);
    await rateHumanJob(deps, POSTER, POSTER, null, 'hjob1', { rating: 4 });
    await expect(rateHumanJob(deps, POSTER, POSTER, null, 'hjob1', { rating: 2 })).rejects.toThrow(/Already rated/);
    expect(ratings(db)).toHaveLength(1);
    expect(ratedActs(db)).toHaveLength(1);
    const second = await rateHumanJob(deps, WORKER, WORKER, null, 'hjob1', { rating: 5 });
    expect(db.store.get(`${COMMONS_COLLECTIONS.HUMAN_JOBS}/hjob1`)).toMatchObject({ human_rating_pe_id: second.pe_id });
    expect(ratings(db)).toHaveLength(2);
  });

  it('a job that is not completed is refused with no rating and no PE', async () => {
    const db = createFakeFirestore();
    seed(db, 'in_progress');
    await expect(rateHumanJob(makeDeps(db), POSTER, POSTER, null, 'hjob1', { rating: 5 })).rejects.toThrow(/completed/);
    expect(ratings(db)).toHaveLength(0);
    expect(ratedActs(db)).toHaveLength(0);
  });
});
