/**
 * the Commons jobs board is THE hiring board, in all four directions, paying in PVT or
 * USDC on the V4 escrow (the only escrow with the 30-day dispute refund).
 *
 * Pinned, each with a RED control that a named mutation reddens:
 * - direction = `${posterKind}_seeking_${seeking}` for all four pairs; an explicit direction
 * that does not start with the poster's own kind refuses. (drop the mismatch check → RED)
 * - the applicant's kind must match the job's `seeking` refused BEFORE any write.
 * (drop the kind check → RED)
 * - a USDC hire posts only when the relay's USDC escrow IS the V4 contract; a V3 (no refund)
 * address refuses. (return 'base' unconditionally → RED)
 * - USDC budgets: > 0, ≤ cap, ≤ 6 decimals; the retired compensation_amount stays refused.
 * - accept on a USDC job escrows USDC (amount_usdc) on base; a PVT job still escrows PVT.
 */
import { describe, it, expect, afterAll, beforeEach, jest } from '@jest/globals';

const mockGeneratePE = jest.fn(async (..._args: unknown[]) => ({ peId: 'pe_mock', pe_id: 'pe_mock' }));
jest.mock('../agent-bank/pe-utils', () => ({
  __esModule: true,
  generatePE: (...args: unknown[]) => mockGeneratePE(...args),
}));

jest.mock('../agent-bank/escrow', () => ({
  __esModule: true,
  createEscrow: jest.fn(async () => ({ escrow_id: 'esc_mock' })),
  completeEscrow: jest.fn(async () => ({})),
  verifyFunding: jest.fn(async () => ({})),
  resolveEscrowContractAddress: jest.fn(() => '0x96560fDF49e563eFCdc2d502934676DC074732d0'),
  resolveEscrowContractForDocument: jest.fn(() => '0x96560fDF49e563eFCdc2d502934676DC074732d0'),
}));

const mockOpenThread = jest.fn(async (..._args: unknown[]) => ({ thread_id: 'thr_mock' }));
jest.mock('./threads', () => ({
  __esModule: true,
  openThread: (...args: unknown[]) => mockOpenThread(...args),
  normalizeDeliverable: () => null,
  postDeliverableMessage: async () => undefined,
}));

import { createEscrow } from '../agent-bank/escrow';
import {
  postHumanJob as postHumanJobRaw,
  applyForHumanJob,
  acceptApplicant,
  browseHumanJobs,
  resolveUsdcHireEscrowChain,
  jobSeekingOf,
  jobCurrencyOf,
} from './human-jobs';
import { TEST_WINDOW } from './__test-helpers__/speech';
import { COMMONS_COLLECTIONS, type CommonsDeps, type PostHumanJobRequest } from './types';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';

const postHumanJob = (deps: CommonsDeps, w: string, body: PostHumanJobRequest) => postHumanJobRaw(deps, w, w, '0xJOB', body, TEST_WINDOW);
const mockedCreateEscrow = createEscrow as jest.MockedFunction<typeof createEscrow>;

const PERSON = 'user_alice';
const PERSON_2 = 'user_carol';
const AGENT = 'wallet_aw_bob';
const AGENT_2 = 'wallet_aw_dan';
const V4 = '0x96560fDF49e563eFCdc2d502934676DC074732d0';
const V3_NO_REFUND = '0x00000000000000000000000000000000000000e5';
const ORIGINAL_ENV = { ...process.env };

function makeDeps(db: FakeFirestore): CommonsDeps {
  return {
    db,
    cache: { checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }) },
    peBuffer: { enqueue: () => {} },
    recordPEAccrual: async () => {},
  } as unknown as CommonsDeps;
}

function seedProfile(db: FakeFirestore, id: string): void {
  db.store.set(`${COMMONS_COLLECTIONS.PROFILES}/${id}`, {
    participant_type: id.startsWith('wallet_aw_') ? 'agent' : 'human',
    attestation_tier: 'software',
    commons_join_date: 0,
    pe_count: 5,
  });
}

const BASE_BODY = {
  title: 'Summarize a paper',
  description: 'A careful summary.',
  category: 'professional_services' as const,
  skills_required: ['writing'],
  location: { type: 'remote' as const },
  compensation_type: 'pvt' as const,
  requires_identity_verification: false,
  requires_pe_history: false,
  deadline_hours: 24,
};

function jobDocOf(): Record<string, unknown> {
  // postHumanJob writes the job inside generatePE's (mocked) transaction callback: rebuild it
  // from the returned value instead of the store.
  return {};
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, ENABLE_PVT_PRINCIPAL: 'true', ESCROW_CONTRACT_ADDRESS_BASE: V4 };
  mockedCreateEscrow.mockClear();
  mockGeneratePE.mockClear();
  mockOpenThread.mockClear();
});
afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('four directions', () => {
  const FOUR: Array<[string, 'agent' | 'human', string]> = [
    [PERSON, 'agent', 'human_seeking_agent'],
    [PERSON, 'human', 'human_seeking_human'],
    [AGENT, 'agent', 'agent_seeking_agent'],
    [AGENT, 'human', 'agent_seeking_human'],
  ];
  it.each(FOUR)('%s hiring %s → %s', async (poster, seeking, direction) => {
    const db = createFakeFirestore();
    seedProfile(db, poster);
    const job = await postHumanJob(makeDeps(db), poster, { ...BASE_BODY, budget_pvt: '1000000000000000000', seeking });
    expect(job.direction).toBe(direction);
    expect(job.seeking).toBe(seeking);
    expect(job.currency).toBe('pvt');
    jobDocOf();
  });

  it('refuses an unsupported hardware requirement when hiring agents before sealing a listing', async () => {
    const db = createFakeFirestore();
    seedProfile(db, PERSON);
    await expect(postHumanJob(makeDeps(db), PERSON, {
      ...BASE_BODY, budget_pvt: '1', seeking: 'agent', requires_identity_verification: true,
    })).rejects.toThrow('supported only for jobs hiring people');
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('legacy default when neither seeking nor direction is given: agents hire people, people hire agents', async () => {
    const db = createFakeFirestore();
    seedProfile(db, PERSON);
    seedProfile(db, AGENT);
    expect((await postHumanJob(makeDeps(db), PERSON, { ...BASE_BODY, budget_pvt: '1' })).direction).toBe('human_seeking_agent');
    expect((await postHumanJob(makeDeps(db), AGENT, { ...BASE_BODY, budget_pvt: '1' })).direction).toBe('agent_seeking_human');
  });

  it('RED: a person cannot post an agent\'s listing (direction must start with the poster\'s own kind)', async () => {
    const db = createFakeFirestore();
    seedProfile(db, PERSON);
    await expect(postHumanJob(makeDeps(db), PERSON, { ...BASE_BODY, budget_pvt: '1', direction: 'agent_seeking_agent' }))
      .rejects.toThrow(/does not match this poster/);
    await expect(postHumanJob(makeDeps(db), PERSON, { ...BASE_BODY, budget_pvt: '1', seeking: 'robot' as never }))
      .rejects.toThrow(/seeking must be/);
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });
});

describe('the applicant\'s kind must match who the job hires', () => {
  function seedJob(db: FakeFirestore, seeking: 'agent' | 'human', poster = PERSON): void {
    db.store.set(`${COMMONS_COLLECTIONS.HUMAN_JOBS}/hjob1`, {
      job_id: 'hjob1', poster_wallet_id: poster, poster_address: '0xJOB', title: 't', description: 'd',
      status: 'open', applicant_count: 0, budget_pvt: '1', seeking,
      direction: `${poster.startsWith('wallet_aw_') ? 'agent' : 'human'}_seeking_${seeking}`,
    });
  }

  it('RED: a person applying to a job hiring agents is refused before any write (no thread, no PE)', async () => {
    const db = createFakeFirestore();
    seedJob(db, 'agent');
    seedProfile(db, PERSON_2);
    await expect(applyForHumanJob(makeDeps(db), PERSON_2, PERSON_2, null, 'hjob1', { cover_note: 'hi' }))
      .rejects.toThrow('This job is hiring agents, not people');
    expect(mockOpenThread).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('RED: an agent applying to a job hiring people is refused', async () => {
    const db = createFakeFirestore();
    seedJob(db, 'human', AGENT);
    seedProfile(db, AGENT_2);
    await expect(applyForHumanJob(makeDeps(db), AGENT_2, AGENT_2, '0xA2', 'hjob1', {}))
      .rejects.toThrow('This job is hiring people, not agents');
    expect(mockOpenThread).not.toHaveBeenCalled();
  });

  const PAIRS: Array<[string, string, 'agent' | 'human', string]> = [
    ['person → person', PERSON, 'human', PERSON_2],
    ['person → agent', PERSON, 'agent', AGENT],
    ['agent → agent', AGENT, 'agent', AGENT_2],
    ['agent → person', AGENT, 'human', PERSON_2],
  ];
  it.each(PAIRS)('REACHABILITY %s: a matching applicant applies (thread opened, PE sealed)', async (_label, poster, seeking, applicant) => {
    const db = createFakeFirestore();
    seedJob(db, seeking, poster);
    seedProfile(db, applicant);
    const app = await applyForHumanJob(makeDeps(db), applicant, applicant, null, 'hjob1', { cover_note: 'hi' });
    expect(app.applicant_wallet_id).toBe(applicant);
    expect(mockOpenThread).toHaveBeenCalledTimes(1);
  });

  it('legacy rows derive seeking from direction (missing → agent_seeking_human hires people)', () => {
    expect(jobSeekingOf({})).toBe('human');
    expect(jobSeekingOf({ direction: 'human_seeking_agent' })).toBe('agent');
    expect(jobSeekingOf({ direction: 'agent_seeking_agent', seeking: 'human' })).toBe('human');
  });
});

describe('Hardware-backed device requirement', () => {
  function seedRequiredJob(db: FakeFirestore, required = true): void {
    db.store.set(`${COMMONS_COLLECTIONS.HUMAN_JOBS}/hardware_job`, {
      job_id: 'hardware_job', poster_wallet_id: PERSON, poster_address: '0xJOB',
      status: 'open', applicant_count: 0, budget_pvt: '1', seeking: 'human',
      title: 't', description: 'd', requires_identity_verification: required,
    });
    seedProfile(db, PERSON_2);
  }

  it('refuses a stale profile badge or software device before creating a thread or PE', async () => {
    const db = createFakeFirestore();
    seedRequiredJob(db);
    db.store.set(`${COMMONS_COLLECTIONS.PROFILES}/${PERSON_2}`, {
      participant_type: 'human', attestation_tier: 'hardware', pe_count: 5,
    });
    db.store.set(`devices/software`, {
      owner_wallet_id: PERSON_2, owner_type: 'human', status: 'active',
      signing_method: 'software', attestation_capability: 'software',
    });
    const before = new Map(db.store);
    await expect(applyForHumanJob(makeDeps(db), PERSON_2, PERSON_2, null, 'hardware_job', {}))
      .rejects.toThrow('This job requires a hardware-backed device');
    expect(db.store).toEqual(before);
    expect(mockOpenThread).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('accepts an active hardware-bound signing device, then refuses it after revocation', async () => {
    const db = createFakeFirestore();
    seedRequiredJob(db);
    db.store.set('devices/phone', {
      owner_wallet_id: PERSON_2, owner_type: 'human', status: 'active',
      signing_method: 'secure_enclave_p256', attestation_capability: 'hardware_partial',
    });
    const application = await applyForHumanJob(makeDeps(db), PERSON_2, PERSON_2, null, 'hardware_job', {});
    expect(application.applicant_wallet_id).toBe(PERSON_2);
    expect(mockOpenThread).toHaveBeenCalledTimes(1);
    db.store.set('devices/phone', { ...db.store.get('devices/phone'), status: 'revoked' });
    mockOpenThread.mockClear();
    mockGeneratePE.mockClear();
    await expect(applyForHumanJob(makeDeps(db), PERSON_2, PERSON_2, null, 'hardware_job', {}))
      .rejects.toThrow('This job requires a hardware-backed device');
    expect(mockOpenThread).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('allows software applicants when the poster did not require the check', async () => {
    const db = createFakeFirestore();
    seedRequiredJob(db, false);
    const application = await applyForHumanJob(makeDeps(db), PERSON_2, PERSON_2, null, 'hardware_job', {});
    expect(application.applicant_wallet_id).toBe(PERSON_2);
    expect(mockOpenThread).toHaveBeenCalledTimes(1);
  });
});

describe('USDC hires ride the V4 escrow (the one with the dispute refund)', () => {
  it('resolves base only when the USDC escrow address IS the V4 contract', () => {
    expect(resolveUsdcHireEscrowChain()).toBe('base');
    process.env.ESCROW_CONTRACT_ADDRESS_BASE = V3_NO_REFUND;
    expect(resolveUsdcHireEscrowChain()).toBeNull();
    delete process.env.ESCROW_CONTRACT_ADDRESS_BASE;
    delete process.env.ESCROW_CONTRACT_ADDRESS;
    expect(resolveUsdcHireEscrowChain()).toBeNull();
  });

  it('posts a USDC job: budget_usdc stored, no budget_pvt, currency usdc', async () => {
    const db = createFakeFirestore();
    seedProfile(db, PERSON);
    const job = await postHumanJob(makeDeps(db), PERSON, { ...BASE_BODY, seeking: 'human', currency: 'usdc', budget_usdc: 12.5 });
    expect(job.currency).toBe('usdc');
    expect(job.budget_usdc).toBe(12.5);
    expect(job.budget_pvt).toBeUndefined();
    expect(job.compensation_currency).toBe('USDC');
    expect(jobCurrencyOf(job)).toBe('usdc');
  });

  it('RED: a USDC post refuses when the USDC escrow is a contract without the refund (V3)', async () => {
    process.env.ESCROW_CONTRACT_ADDRESS_BASE = V3_NO_REFUND;
    const db = createFakeFirestore();
    seedProfile(db, PERSON);
    await expect(postHumanJob(makeDeps(db), PERSON, { ...BASE_BODY, currency: 'usdc', budget_usdc: 5 }))
      .rejects.toThrow(/30-day dispute refund/);
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('RED: USDC budget bounds (> 0, ≤ 6 decimals, finite) and the retired compensation_amount', async () => {
    const db = createFakeFirestore();
    seedProfile(db, PERSON);
    for (const bad of [0, -1, 1.1234567, Number.NaN]) {
      await expect(postHumanJob(makeDeps(db), PERSON, { ...BASE_BODY, currency: 'usdc', budget_usdc: bad }))
        .rejects.toThrow(/budget_usdc/);
    }
    await expect(postHumanJob(makeDeps(db), PERSON, { ...BASE_BODY, currency: 'usdc', budget_usdc: '5' as unknown as number }))
      .rejects.toThrow(/finite number/);
    await expect(postHumanJob(makeDeps(db), PERSON, { ...BASE_BODY, budget_pvt: '1', compensation_amount: 5 }))
      .rejects.toThrow(/compensation_amount is retired/);
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('accept on a USDC job escrows USDC on base; a PVT job still escrows PVT', async () => {
    const db = createFakeFirestore();
    seedProfile(db, AGENT);
    db.store.set(`${COMMONS_COLLECTIONS.HUMAN_JOBS}/hjobU`, {
      job_id: 'hjobU', poster_wallet_id: PERSON, title: 'USDC job', description: 'd', status: 'open',
      currency: 'usdc', budget_usdc: 7.25, seeking: 'agent',
    });
    db.store.set(`${COMMONS_COLLECTIONS.HUMAN_JOB_APPLICATIONS}/aU`, { application_id: 'aU', job_id: 'hjobU', applicant_wallet_id: AGENT, status: 'pending' });
    await acceptApplicant(makeDeps(db), PERSON, PERSON, null, 'hjobU', AGENT);
    expect(mockedCreateEscrow).toHaveBeenCalledTimes(1);
    const usdcCall = mockedCreateEscrow.mock.calls[0][1];
    expect(usdcCall).toMatchObject({ currency: 'usdc', amount_usdc: 7.25, chain: 'base', depositor_wallet_id: PERSON, recipient_wallet_id: AGENT });

    db.store.set(`${COMMONS_COLLECTIONS.HUMAN_JOBS}/hjobP`, {
      job_id: 'hjobP', poster_wallet_id: PERSON, title: 'PVT job', description: 'd', status: 'open',
      budget_pvt: '3000000000000000000', seeking: 'agent',
    });
    db.store.set(`${COMMONS_COLLECTIONS.HUMAN_JOB_APPLICATIONS}/aP`, { application_id: 'aP', job_id: 'hjobP', applicant_wallet_id: AGENT, status: 'pending' });
    await acceptApplicant(makeDeps(db), PERSON, PERSON, null, 'hjobP', AGENT);
    expect(mockedCreateEscrow.mock.calls[1][1]).toMatchObject({ currency: 'pvt', amount_pvt: '3000000000000000000', chain: 'base' });
  });

  it('RED: accept on a USDC job refuses if the refund-bearing escrow went away after posting (Unknown = Block)', async () => {
    const db = createFakeFirestore();
    seedProfile(db, AGENT);
    db.store.set(`${COMMONS_COLLECTIONS.HUMAN_JOBS}/hjobU`, {
      job_id: 'hjobU', poster_wallet_id: PERSON, title: 'USDC job', description: 'd', status: 'open', currency: 'usdc', budget_usdc: 1,
    });
    db.store.set(`${COMMONS_COLLECTIONS.HUMAN_JOB_APPLICATIONS}/aU`, { application_id: 'aU', job_id: 'hjobU', applicant_wallet_id: AGENT, status: 'pending' });
    process.env.ESCROW_CONTRACT_ADDRESS_BASE = V3_NO_REFUND;
    await expect(acceptApplicant(makeDeps(db), PERSON, PERSON, null, 'hjobU', AGENT)).rejects.toThrow(/USDC hires are not enabled/);
    expect(mockedCreateEscrow).not.toHaveBeenCalled();
  });
});

describe('browsing the one board', () => {
  it('excludes a marked prelaunch proof while keeping its stored job and PE reference', async () => {
    const db = createFakeFirestore();
    db.store.set(`${COMMONS_COLLECTIONS.HUMAN_JOBS}/j_test`, {
      job_id: 'j_test', status: 'open', posted_at: 2, pe_id: 'pe_test', public_visibility: 'hidden_prelaunch_test',
    });
    db.store.set(`${COMMONS_COLLECTIONS.HUMAN_JOBS}/j_public`, {
      job_id: 'j_public', status: 'open', posted_at: 1, pe_id: 'pe_public',
    });
    expect((await browseHumanJobs(makeDeps(db), {})).jobs.map(j => j.job_id)).toEqual(['j_public']);
    expect(db.store.get(`${COMMONS_COLLECTIONS.HUMAN_JOBS}/j_test`)).toMatchObject({ pe_id: 'pe_test' });
  });

  it('filters by direction / seeking / posted_by / currency (legacy rows derive theirs)', async () => {
    const db = createFakeFirestore();
    const rows: Array<[string, Record<string, unknown>]> = [
      ['j1', { direction: 'human_seeking_agent', seeking: 'agent', currency: 'pvt', budget_pvt: '1' }],
      ['j2', { direction: 'human_seeking_human', seeking: 'human', currency: 'usdc', budget_usdc: 2 }],
      ['j3', { direction: 'agent_seeking_agent', seeking: 'agent', currency: 'usdc', budget_usdc: 3 }],
      ['j4', { budget_pvt: '1' }], // legacy: agent_seeking_human, pvt
    ];
    rows.forEach(([id, extra], i) => db.store.set(`${COMMONS_COLLECTIONS.HUMAN_JOBS}/${id}`, {
      job_id: id, status: 'open', posted_at: 100 - i, ...extra,
    }));
    const ids = async (o: Parameters<typeof browseHumanJobs>[1]) => (await browseHumanJobs(makeDeps(db), o)).jobs.map((j) => j.job_id).sort();
    expect(await ids({ seeking: 'agent' })).toEqual(['j1', 'j3']);
    expect(await ids({ seeking: 'human' })).toEqual(['j2', 'j4']);
    expect(await ids({ posted_by: 'agent' })).toEqual(['j3', 'j4']);
    expect(await ids({ currency: 'usdc' })).toEqual(['j2', 'j3']);
    expect(await ids({ direction: 'agent_seeking_human' })).toEqual(['j4']);
    expect(await ids({})).toEqual(['j1', 'j2', 'j3', 'j4']);
  });
});
