/**
 * Pass-2 Human-Jobs seams — C5 / C6 / C7 backend regression tests.
 *
 * C5: postHumanJob must REJECT a PVT-budget post when PVT principal is not
 *     enabled for the human-jobs escrow chain (the accept→createEscrow leg
 *     would otherwise fail and strand the job permanently unfillable).
 * C6: getJobApplications must enumerate a job's applicants for the POSTER only
 *     (the data the second-actor management UI accepts against).
 * C7: getMyHumanJobs must be scoped to the caller — only jobs they posted or
 *     are assigned to, never a global browse.
 *
 * These run the REAL writers/readers against the buffering fake Firestore.
 */
import { describe, it, expect, afterAll } from '@jest/globals';
import {
  postHumanJob as postHumanJobRaw,
  getJobApplications,
  getMyHumanJobs,
} from './human-jobs';
import { TEST_WINDOW } from './__test-helpers__/speech';
const postHumanJob = (deps: Parameters<typeof postHumanJobRaw>[0], w: string, a: string, addr: string | null, body: Parameters<typeof postHumanJobRaw>[4]) => postHumanJobRaw(deps, w, a, addr, body, TEST_WINDOW);
import { ForbiddenError } from '../agent-bank/errors';
import { _resetPvtPrincipalConfigForTests } from '../agent-bank/pvt-principal-config';
import { COMMONS_COLLECTIONS } from './types';
import type { CommonsDeps } from './types';
import {
  createFakeFirestore,
  type FakeFirestore,
} from '../pvt/__test-helpers__/fake-firestore';

const ADDR = '0x0000000000000000000000000000000000000001';
const ALICE = 'wallet_alice';
const BOB = 'wallet_bob';
const CAR = 'wallet_car';
const ORIGINAL_ENV = { ...process.env };

function makeDeps(db: FakeFirestore): CommonsDeps {
  return {
    db,
    cache: { checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }) },
    peBuffer: { enqueue: () => {} },
    recordPEAccrual: async () => {},
  } as unknown as CommonsDeps;
}

function enablePvtPrincipal(): void {
  process.env.ENABLE_PVT_PRINCIPAL = 'true';
  process.env.PVT_PRINCIPAL_CHAINS = 'base';
  process.env.ESCROW_V4_CONTRACT_ADDRESS = ADDR;
  process.env.PROMISE_V3_CONTRACT_ADDRESS = ADDR;
  process.env.POOL_V3_CONTRACT_ADDRESS = ADDR;
  process.env.PVT_CONTRACT_ADDRESS_BASE = ADDR;
  _resetPvtPrincipalConfigForTests();
}

function disablePvtPrincipal(): void {
  delete process.env.ENABLE_PVT_PRINCIPAL;
  delete process.env.PVT_PRINCIPAL_CHAINS;
  delete process.env.ESCROW_V4_CONTRACT_ADDRESS;
  delete process.env.PROMISE_V3_CONTRACT_ADDRESS;
  delete process.env.POOL_V3_CONTRACT_ADDRESS;
  delete process.env.PVT_CONTRACT_ADDRESS_BASE;
  _resetPvtPrincipalConfigForTests();
}

afterAll(() => {
  process.env = ORIGINAL_ENV;
  _resetPvtPrincipalConfigForTests();
});

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
  deadline_hours: 24,
};

function seedPosterProfile(db: FakeFirestore, wallet: string): void {
  db.store.set(`${COMMONS_COLLECTIONS.PROFILES}/${wallet}`, {
    participant_type: 'human',
    attestation_tier: 'software',
  });
}

// ─── C5: PVT-principal post-time gate ───────────────────────────────────────

describe('C5 — postHumanJob PVT-principal post gate', () => {
  it('REJECTS a PVT-budget post when PVT principal is OFF for the escrow chain', async () => {
    disablePvtPrincipal();
    const db = createFakeFirestore();
    seedPosterProfile(db, ALICE);

    await expect(
      postHumanJob(makeDeps(db), ALICE, ALICE, '0xJOB', POST_BODY),
    ).rejects.toThrow(/no PVT-principal chain is configured/);

    // Blocked before any write — no job doc, no PE.
    const wrote = [...db.store.keys()].some(
      (k) =>
        k.startsWith(`${COMMONS_COLLECTIONS.HUMAN_JOBS}/`) ||
        k.startsWith('provenance_envelopes/'),
    );
    expect(wrote).toBe(false);
  });

  it('OPENS PVT-budget posting when PVT principal is enabled (4b, Base)', async () => {
    // Inverted from the runtime boundary quarantine: ENABLE_PVT_PRINCIPAL=true now genuinely
    // enables PVT-principal (Base-only), so a PVT-budget post SUCCEEDS. The
    // stale ESCROW_V4/PVT env addresses `enablePvtPrincipal` also sets are
    // IGNORED (canonical institution deployment/PVT9 wins) — posting is unaffected by them.
    enablePvtPrincipal();
    const db = createFakeFirestore();
    seedPosterProfile(db, ALICE);

    const job = await postHumanJob(makeDeps(db), ALICE, ALICE, '0xJOB', POST_BODY);
    expect(job.job_id).toMatch(/^hjob_/);
    expect([...db.store.keys()].some((key) => key.startsWith(`${COMMONS_COLLECTIONS.HUMAN_JOBS}/`))).toBe(true);
  });
});

// ─── C6: poster-only applicant listing ──────────────────────────────────────

describe('C6 — getJobApplications (poster-only)', () => {
  function seedJobWithApplicants(db: FakeFirestore): void {
    db.store.set(`${COMMONS_COLLECTIONS.HUMAN_JOBS}/hjob1`, {
      job_id: 'hjob1',
      poster_wallet_id: ALICE,
      status: 'open',
    });
    db.store.set(`${COMMONS_COLLECTIONS.HUMAN_JOB_APPLICATIONS}/a1`, {
      application_id: 'a1',
      job_id: 'hjob1',
      applicant_wallet_id: BOB,
      pe_id: 'pe_bob',
      applied_at: 100,
      status: 'pending',
    });
    db.store.set(`${COMMONS_COLLECTIONS.HUMAN_JOB_APPLICATIONS}/a2`, {
      application_id: 'a2',
      job_id: 'hjob1',
      applicant_wallet_id: CAR,
      pe_id: 'pe_car',
      applied_at: 200,
      status: 'pending',
    });
    db.store.set(`${COMMONS_COLLECTIONS.PROFILES}/${BOB}`, {
      display_name: 'Bob',
      attestation_tier: 'software',
      pe_count: 3,
    });
    db.store.set(`${COMMONS_COLLECTIONS.PROFILES}/${CAR}`, {
      display_name: 'Car',
      attestation_tier: 'hardware',
      pe_count: 9,
    });
  }

  it('returns enriched applicants for the poster, newest first', async () => {
    const db = createFakeFirestore();
    seedJobWithApplicants(db);

    const apps = await getJobApplications(makeDeps(db), ALICE, 'hjob1');
    // applied_at 200 (Car) before 100 (Bob).
    expect(apps.map((a) => a.applicant_wallet_id)).toEqual([CAR, BOB]);
    expect(apps[0].applicant?.display_name).toBe('Car');
    expect(apps[0].applicant?.attestation_tier).toBe('hardware');
    expect(apps[1].applicant?.pe_count).toBe(3);
  });

  it('forbids a non-poster from listing applicants', async () => {
    const db = createFakeFirestore();
    seedJobWithApplicants(db);

    await expect(
      getJobApplications(makeDeps(db), BOB, 'hjob1'),
    ).rejects.toThrow(ForbiddenError);
  });

  it('tolerates a missing applicant profile (applicant: null)', async () => {
    const db = createFakeFirestore();
    db.store.set(`${COMMONS_COLLECTIONS.HUMAN_JOBS}/hjob1`, {
      job_id: 'hjob1',
      poster_wallet_id: ALICE,
      status: 'open',
    });
    db.store.set(`${COMMONS_COLLECTIONS.HUMAN_JOB_APPLICATIONS}/a1`, {
      application_id: 'a1',
      job_id: 'hjob1',
      applicant_wallet_id: 'ghost_wallet',
      pe_id: 'pe_ghost',
      applied_at: 1,
      status: 'pending',
    });

    const apps = await getJobApplications(makeDeps(db), ALICE, 'hjob1');
    expect(apps).toHaveLength(1);
    expect(apps[0].applicant).toBeNull();
  });
});

// ─── C7: /jobs/mine scoped to the caller ────────────────────────────────────

describe('C7 — getMyHumanJobs (scoped to the caller)', () => {
  it('returns only jobs the caller posted or is assigned to — never others', async () => {
    const db = createFakeFirestore();
    db.store.set(`${COMMONS_COLLECTIONS.HUMAN_JOBS}/A`, {
      job_id: 'A',
      poster_wallet_id: ALICE,
      status: 'open',
      posted_at: 10,
    });
    db.store.set(`${COMMONS_COLLECTIONS.HUMAN_JOBS}/B`, {
      job_id: 'B',
      poster_wallet_id: BOB,
      status: 'open',
      posted_at: 20,
    });
    db.store.set(`${COMMONS_COLLECTIONS.HUMAN_JOBS}/C`, {
      job_id: 'C',
      poster_wallet_id: BOB,
      accepted_applicant_wallet_id: ALICE,
      status: 'in_progress',
      posted_at: 30,
    });

    const result = await getMyHumanJobs(makeDeps(db), ALICE, {});
    expect(result.posted.map((j) => j.job_id)).toEqual(['A']);
    expect(result.assigned.map((j) => j.job_id)).toEqual(['C']);

    const allIds = [...result.posted, ...result.assigned].map((j) => j.job_id);
    expect(allIds).not.toContain('B'); // BOB's unrelated job never leaks to ALICE
  });

  it('returns the job ids the caller APPLIED to — only the caller\'s, and only on the unfiltered read', async () => {
    const db = createFakeFirestore();
    db.store.set(`${COMMONS_COLLECTIONS.HUMAN_JOB_APPLICATIONS}/a1`, { application_id: 'a1', job_id: 'J1', applicant_wallet_id: ALICE });
    db.store.set(`${COMMONS_COLLECTIONS.HUMAN_JOB_APPLICATIONS}/a2`, { application_id: 'a2', job_id: 'J2', applicant_wallet_id: BOB });
    db.store.set(`${COMMONS_COLLECTIONS.HUMAN_JOB_APPLICATIONS}/a3`, { application_id: 'a3', job_id: 'J3', applicant_wallet_id: ALICE });

    const result = await getMyHumanJobs(makeDeps(db), ALICE, {});
    expect([...(result.applied_job_ids ?? [])].sort()).toEqual(['J1', 'J3']);
    // RED control: BOB's application never shows as ALICE's (a query not scoped to the caller fails here).
    expect(result.applied_job_ids).not.toContain('J2');
    // A role-filtered read skips the extra query.
    expect((await getMyHumanJobs(makeDeps(db), ALICE, { role: 'posted' })).applied_job_ids).toBeUndefined();
  });
});
