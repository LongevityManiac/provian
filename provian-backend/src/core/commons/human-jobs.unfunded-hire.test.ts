/**
 * An accepted hire whose escrow was never funded, past the point it ever can be, is closed: the
 * escrow is cancelled, the job reopens, the hired party's application is pending again, and both
 * parties are told (OPEN_ITEMS "An accepted-but-never-funded Commons hire never ends").
 *
 * RED controls: a funded escrow, an escrow with a reported fund tx, a hire still inside its grace,
 * and a job no longer in progress are each left untouched.
 */
import { describe, it, expect, jest } from '@jest/globals';

const notify = jest.fn(async () => undefined);
jest.mock('./job-notify', () => ({ notifyJobCounterparty: (...args: unknown[]) => (notify as (...a: unknown[]) => Promise<void>)(...args) }));

import { closeUnfundedHires, UNFUNDED_HIRE_CLOSE_GRACE_MS } from './human-jobs';
import { COMMONS_COLLECTIONS, type CommonsDeps } from './types';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';

const AUTO_RELEASE = 1_800_000_000_000;
const AFTER = AUTO_RELEASE + UNFUNDED_HIRE_CLOSE_GRACE_MS;

function seedHire(db: FakeFirestore, id: string, escrow: Record<string, unknown>, job: Record<string, unknown> = {}): void {
  db.store.set(`${COMMONS_COLLECTIONS.HUMAN_JOBS}/${id}`, {
    job_id: id, title: `Job ${id}`, poster_wallet_id: 'wallet_poster', accepted_applicant_wallet_id: 'wallet_aw_worker',
    status: 'in_progress', escrow_id: `esc_${id}`, ...job,
  });
  db.store.set(`escrows/esc_${id}`, { escrow_id: `esc_${id}`, status: 'created', auto_release_at: AUTO_RELEASE, ...escrow });
  db.store.set(`${COMMONS_COLLECTIONS.HUMAN_JOB_APPLICATIONS}/app_${id}`, {
    application_id: `app_${id}`, job_id: id, applicant_wallet_id: 'wallet_aw_worker', status: 'accepted',
  });
}

const deps = (db: FakeFirestore) => ({ db } as unknown as CommonsDeps);

describe('closeUnfundedHires', () => {
  it('closes an unfunded hire past its escrow deadline + grace: escrow cancelled, job open, application pending, both told', async () => {
    notify.mockClear();
    const db = createFakeFirestore();
    seedHire(db, 'h1', {});
    const report = await closeUnfundedHires(deps(db), AFTER);
    expect(report).toEqual({ scanned: 1, closed: 1, failures: 0 });
    expect(db.store.get('escrows/esc_h1')).toMatchObject({ status: 'cancelled', cancel_reason: 'unfunded_past_deadline', cancelled_at: AFTER });
    const job = db.store.get(`${COMMONS_COLLECTIONS.HUMAN_JOBS}/h1`) as Record<string, unknown>;
    expect(job).toMatchObject({ status: 'open', unfunded_hire_closed_at: AFTER, lapsed_escrow_ids: ['esc_h1'] });
    expect(job).not.toHaveProperty('escrow_id');
    expect(job).not.toHaveProperty('accepted_applicant_wallet_id');
    expect(db.store.get(`${COMMONS_COLLECTIONS.HUMAN_JOB_APPLICATIONS}/app_h1`)).toMatchObject({ status: 'pending' });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ counterpartyId: 'wallet_aw_worker', event: 'hire_lapsed' }));
    expect(notify).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ counterpartyId: 'wallet_poster', event: 'hire_lapsed' }));
    // A second pass finds nothing to do.
    expect(await closeUnfundedHires(deps(db), AFTER + 1)).toEqual({ scanned: 0, closed: 0, failures: 0 });
  });

  it('RED: a funded escrow, a reported fund tx, a hire inside its grace and a finished job are never closed', async () => {
    notify.mockClear();
    const db = createFakeFirestore();
    seedHire(db, 'funded', { status: 'funded' });
    seedHire(db, 'reported', { fund_tx_hash: `0x${'a'.repeat(64)}` });
    seedHire(db, 'grace', { auto_release_at: AUTO_RELEASE + 1 });
    seedHire(db, 'done', {}, { status: 'completed' });
    const report = await closeUnfundedHires(deps(db), AFTER);
    expect(report.closed).toBe(0);
    expect(report.failures).toBe(0);
    for (const id of ['funded', 'reported', 'grace']) {
      expect(db.store.get(`${COMMONS_COLLECTIONS.HUMAN_JOBS}/${id}`)).toMatchObject({ status: 'in_progress', escrow_id: `esc_${id}` });
      expect(db.store.get(`escrows/esc_${id}`)).not.toMatchObject({ status: 'cancelled' });
    }
    expect(db.store.get(`${COMMONS_COLLECTIONS.HUMAN_JOBS}/done`)).toMatchObject({ status: 'completed' });
    expect(notify).not.toHaveBeenCalled();
  });
});
