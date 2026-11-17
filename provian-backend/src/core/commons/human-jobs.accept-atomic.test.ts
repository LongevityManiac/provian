/**
 * acceptApplicant changes the job and the application in ONE transaction, only
 * while the job is still open, and always escrows through createEscrow. A job's
 * posting deadline is bounded by the escrow module's own limit, so a posted job
 * never names a deadline its escrow would refuse.
 */
import { describe, it, expect, beforeEach, afterAll, jest } from '@jest/globals';

const mockGeneratePE = jest.fn(async (..._args: unknown[]) => ({ peId: 'pe_mock', pe_id: 'pe_mock' }));
jest.mock('../agent-bank/pe-utils', () => ({
  __esModule: true,
  generatePE: (...args: unknown[]) => mockGeneratePE(...args),
}));

jest.mock('../agent-bank/escrow', () => ({
  __esModule: true,
  createEscrow: jest.fn(),
  completeEscrow: jest.fn(async () => ({})),
}));

import { createEscrow } from '../agent-bank/escrow';
import { SAFETY_LIMITS } from '../agent-bank/types';
import { postHumanJob as postHumanJobRaw, acceptApplicant } from './human-jobs';
import { TEST_WINDOW } from './__test-helpers__/speech';
import { COMMONS_COLLECTIONS, COMMONS_SAFETY_LIMITS, type CommonsDeps } from './types';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';

const mockedCreateEscrow = createEscrow as jest.MockedFunction<typeof createEscrow>;
const ALICE = 'wallet_alice';
const BOB = 'wallet_bob';
const CAROL = 'wallet_carol';
const HOUR_MS = 60 * 60 * 1000;
const ORIGINAL_ENV = { ...process.env };
const JOB_KEY = `${COMMONS_COLLECTIONS.HUMAN_JOBS}/hjob1`;
const APP_KEY = `${COMMONS_COLLECTIONS.HUMAN_JOB_APPLICATIONS}/a1`;

function makeDeps(db: FakeFirestore): CommonsDeps {
  return {
    db,
    cache: { checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }) },
    peBuffer: { enqueue: () => {} },
    recordPEAccrual: async () => {},
  } as unknown as CommonsDeps;
}

function seed(db: FakeFirestore, jobOverrides: Record<string, unknown> = {}): void {
  db.store.set(`${COMMONS_COLLECTIONS.PROFILES}/${ALICE}`, { participant_type: 'human', attestation_tier: 'software' });
  db.store.set(`${COMMONS_COLLECTIONS.PROFILES}/${BOB}`, { participant_type: 'human' });
  db.store.set(`${COMMONS_COLLECTIONS.PROFILES}/${CAROL}`, { participant_type: 'human' });
  db.store.set(JOB_KEY, {
    job_id: 'hjob1',
    poster_wallet_id: ALICE,
    poster_address: '0xJOB',
    title: 'Translate a document',
    description: 'Need a careful human translation.',
    status: 'open',
    budget_pvt: '1000000000000000000',
    ...jobOverrides,
  });
  db.store.set(APP_KEY, { application_id: 'a1', job_id: 'hjob1', applicant_wallet_id: BOB, pe_id: 'pe_bob', applied_at: 100, status: 'pending' });
  db.store.set(`${COMMONS_COLLECTIONS.HUMAN_JOB_APPLICATIONS}/a2`, { application_id: 'a2', job_id: 'hjob1', applicant_wallet_id: CAROL, pe_id: 'pe_carol', applied_at: 101, status: 'pending' });
}

/** createEscrow stand-in: writes the escrow row the real one would, under a fresh id. */
function escrowWriter(db: FakeFirestore, onCreate?: () => void) {
  let n = 0;
  return async () => {
    n += 1;
    const escrowId = `esc_${n}`;
    db.store.set(`escrows/${escrowId}`, { escrow_id: escrowId, status: 'created' });
    onCreate?.();
    return { escrow_id: escrowId } as Awaited<ReturnType<typeof createEscrow>>;
  };
}

beforeEach(() => {
  mockedCreateEscrow.mockReset();
  mockGeneratePE.mockClear();
  process.env = { ...ORIGINAL_ENV, ENABLE_PVT_PRINCIPAL: 'true' };
});
afterAll(() => { process.env = ORIGINAL_ENV; });

describe('acceptApplicant is atomic', () => {
  it('accepts: job in progress with its escrow, application accepted, escrow from createEscrow', async () => {
    const db = createFakeFirestore();
    seed(db);
    mockedCreateEscrow.mockImplementation(escrowWriter(db));
    const out = await acceptApplicant(makeDeps(db), ALICE, ALICE, '0xJOB', 'hjob1', BOB);
    expect(mockedCreateEscrow).toHaveBeenCalledTimes(1);
    expect(out.escrow_id).toBe('esc_1');
    expect(db.store.get(JOB_KEY)).toMatchObject({ status: 'in_progress', accepted_applicant_wallet_id: BOB, escrow_id: 'esc_1' });
    expect(db.store.get(APP_KEY)).toMatchObject({ status: 'accepted' });
    expect(db.store.has('escrows/esc_1')).toBe(true);
  });

  it('RED: a job that stopped being open while the escrow was created is not overwritten', async () => {
    const db = createFakeFirestore();
    seed(db);
    mockedCreateEscrow.mockImplementation(escrowWriter(db, () => {
      db.store.set(JOB_KEY, { ...(db.store.get(JOB_KEY) as Record<string, unknown>), status: 'cancelled' });
    }));
    await expect(acceptApplicant(makeDeps(db), ALICE, ALICE, '0xJOB', 'hjob1', BOB)).rejects.toThrow(/not accepting applications/);
    const job = db.store.get(JOB_KEY) as Record<string, unknown>;
    expect(job.status).toBe('cancelled');
    expect(job.accepted_applicant_wallet_id).toBeUndefined();
    expect(job.escrow_id).toBeUndefined();
    expect(db.store.get(APP_KEY)).toMatchObject({ status: 'pending' });
    // The accept that did not land leaves no escrow behind, and records no accept PE.
    expect(db.store.has('escrows/esc_1')).toBe(false);
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('RED: two concurrent accepts for one job — exactly one wins, one escrow remains', async () => {
    const db = createFakeFirestore();
    seed(db);
    mockedCreateEscrow.mockImplementation(escrowWriter(db));
    const deps = makeDeps(db);
    const results = await Promise.allSettled([
      acceptApplicant(deps, ALICE, ALICE, '0xJOB', 'hjob1', BOB),
      acceptApplicant(deps, ALICE, ALICE, '0xJOB', 'hjob1', CAROL),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const job = db.store.get(JOB_KEY) as Record<string, unknown>;
    const escrows = [...db.store.keys()].filter((k) => k.startsWith('escrows/'));
    expect(escrows).toEqual([`escrows/${job.escrow_id as string}`]);
    const accepted = [APP_KEY, `${COMMONS_COLLECTIONS.HUMAN_JOB_APPLICATIONS}/a2`]
      .map((k) => db.store.get(k) as Record<string, unknown>)
      .filter((a) => a.status === 'accepted');
    expect(accepted).toHaveLength(1);
    expect(accepted[0].applicant_wallet_id).toBe(job.accepted_applicant_wallet_id);
  });
});

describe('a posted deadline is one the escrow accepts', () => {
  const POST_BODY = {
    title: 'Translate a document',
    description: 'Need a careful human translation.',
    category: 'professional_services' as const,
    skills_required: ['translation'],
    location: { type: 'remote' as const },
    compensation_type: 'pvt' as const,
    budget_pvt: '1000000000000000000',
    requires_identity_verification: false,
    requires_pe_history: false,
  };
  const post = (db: FakeFirestore, deadlineHours: number) =>
    postHumanJobRaw(makeDeps(db), ALICE, ALICE, '0xJOB', { ...POST_BODY, deadline_hours: deadlineHours }, TEST_WINDOW);

  it('the posting limit is the escrow limit itself', () => {
    expect(COMMONS_SAFETY_LIMITS.MAX_HUMAN_JOB_DEADLINE_HOURS).toBe(SAFETY_LIMITS.MAX_AUTO_RELEASE_HOURS);
  });

  it('RED: posting refuses a deadline one hour past what the escrow accepts', async () => {
    const db = createFakeFirestore();
    seed(db);
    await expect(post(db, SAFETY_LIMITS.MAX_AUTO_RELEASE_HOURS + 1)).rejects.toThrow(/Deadline cannot exceed/);
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('posting at the escrow limit is allowed', async () => {
    const db = createFakeFirestore();
    seed(db);
    const job = await post(db, SAFETY_LIMITS.MAX_AUTO_RELEASE_HOURS);
    expect(job.job_id).toMatch(/^hjob_/);
  });

  it('RED: a job at the posting limit, accepted at once, asks the escrow for a deadline within its limit', async () => {
    const db = createFakeFirestore();
    seed(db, { deadline: Date.now() + COMMONS_SAFETY_LIMITS.MAX_HUMAN_JOB_DEADLINE_HOURS * HOUR_MS });
    mockedCreateEscrow.mockImplementation(escrowWriter(db));
    await acceptApplicant(makeDeps(db), ALICE, ALICE, '0xJOB', 'hjob1', BOB);
    const request = mockedCreateEscrow.mock.calls[0][1] as { deadline_hours: number; auto_release_hours: number };
    expect(request.deadline_hours).toBeGreaterThan(0);
    expect(request.deadline_hours).toBeLessThanOrEqual(SAFETY_LIMITS.MAX_AUTO_RELEASE_HOURS);
    expect(request.auto_release_hours).toBeLessThanOrEqual(SAFETY_LIMITS.MAX_AUTO_RELEASE_HOURS);
  });
});
