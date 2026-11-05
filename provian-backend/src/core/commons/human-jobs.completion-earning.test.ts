/**
 * the two PRODUCER changes that make off-chain completion earning
 * reachable, each with its RED control:
 *
 * 1. `deliverHumanJob` takes the DURABLE inlet (`durableViaOrdinaryIntake:
 * true`) with the poster as counterparty — without the marker the
 * deliverer's row seals terminal `record_only` however the poster later
 * confirms (`pvt-accrual.ts::resolveOperationalDisposition`).
 * 2. `completeHumanJob` pins the poster's confirmation PE on the job
 * (`confirmation_pe_id`) and passes NO durable marker — the confirmation
 * is corroboration, never a second earning act.
 *
 * Plus a SOURCE FENCE over the real module: the durable marker appears exactly
 * once in `human-jobs.ts`, inside `deliverHumanJob` so a future edit that
 * marks the confirmation (or any other human-jobs emit) durable trips here,
 * the same discipline `relay-emitter-durability-fence.test.ts` applies to the
 * funding trio.
 */

import { readFileSync } from 'fs';
import { completeHumanJob, deliverHumanJob } from './human-jobs';
import type { CommonsDeps } from './types';
import type { GeneratePEParams } from '../agent-bank/pe-utils';

const mockGeneratePE = jest.fn();
jest.mock('../agent-bank/pe-utils', () => ({
  generatePE: (...args: unknown[]) => mockGeneratePE(...args),
}));
jest.mock('../agent-bank/escrow', () => ({
  createEscrow: jest.fn(),
  completeEscrow: jest.fn(),
}));

/**
 * Bound to production's OWN field names, not copies: `Extract` resolves to the
 * literal only while `GeneratePEParams` declares it, and to `never` the moment
 * it is renamed — so the fence cannot quietly scan for a name production no
 * longer uses (the self-referential-control shape).
 */
const DURABLE_MARKER: Extract<keyof GeneratePEParams, 'durableViaOrdinaryIntake'> = 'durableViaOrdinaryIntake';
const AWAIT_MARKER: Extract<keyof GeneratePEParams, 'awaitAccrual'> = 'awaitAccrual';

function makeJobDeps(job: Record<string, unknown>): { deps: CommonsDeps; held: Record<string, unknown>; patches: Record<string, unknown>[] } {
  const held = { ...job };
  const patches: Record<string, unknown>[] = [];
  const jobRef = {
    id: 'hjob_1',
    get: jest.fn(async () => ({ exists: true, id: 'hjob_1', data: () => held })),
    update: jest.fn(async (patch: Record<string, unknown>) => {
      patches.push(patch);
      Object.assign(held, patch);
    }),
  };
  const escrowRef = { get: jest.fn(async () => ({ exists: false, data: () => undefined })) };
  const db = {
    collection: jest.fn().mockImplementation((name: string) => {
      if (name === 'commons_human_jobs') return { doc: jest.fn().mockReturnValue(jobRef) };
      if (name === 'escrows') return { doc: jest.fn().mockReturnValue(escrowRef) };
      throw new Error(`Unexpected collection lookup: ${name}`);
    }),
  };
  return { deps: { db, cache: {} } as unknown as CommonsDeps, held, patches };
}

beforeEach(() => {
  mockGeneratePE.mockReset();
  mockGeneratePE.mockResolvedValue({ peId: 'pe_generated', peHash: 'h', prevHash: 'p' });
});

describe('deliverHumanJob — the deliverer\'s earning act takes the durable inlet', () => {
  it('passes durableViaOrdinaryIntake: true with the poster as counterparty', async () => {
    const { deps, held } = makeJobDeps({
      job_id: 'hjob_1', status: 'in_progress',
      poster_wallet_id: 'poster', poster_address: '0xposter',
      accepted_applicant_wallet_id: 'worker',
    });
    await deliverHumanJob(deps, 'worker', 'agent_worker', '0xworker', 'hjob_1');
    expect(mockGeneratePE).toHaveBeenCalledTimes(1);
    const params = mockGeneratePE.mock.calls[0][1] as GeneratePEParams;
    expect(params.actionType).toBe('human_job_delivered');
    expect(params[DURABLE_MARKER]).toBe(true);
    expect(params[AWAIT_MARKER]).toBeUndefined();
    expect(params.counterpartyAddress).toBe('0xposter');
    expect(params.metadata).toEqual({ job_id: 'hjob_1' });
    // The job pins the delivery PE the resolver later binds to.
    expect(held.completion_pe_id).toBe('pe_generated');
  });

  it('RED : the delivery PE seals the locator\'s sha256, never the locator; the body stays on the party-only job row', async () => {
    const { deps, held } = makeJobDeps({
      job_id: 'hjob_1', status: 'in_progress',
      poster_wallet_id: 'poster', poster_address: '0xposter',
      accepted_applicant_wallet_id: 'worker',
    });
    const uri = 'https://private.example/deliverable?sig=secret';
    await deliverHumanJob(deps, 'worker', 'agent_worker', '0xworker', 'hjob_1', { deliverable_uri: uri, deliverable_body: 'the body' });
    const params = mockGeneratePE.mock.calls[0][1] as GeneratePEParams;
    expect(JSON.stringify(params)).not.toContain('private.example');
    expect(JSON.stringify(params)).not.toContain('the body');
    const crypto = jest.requireActual<typeof import('crypto')>('crypto');
    expect(params.metadata).toEqual({
      job_id: 'hjob_1',
      deliverable_sha256: crypto.createHash('sha256').update('the body').digest('hex'),
      deliverable_uri_sha256: crypto.createHash('sha256').update(uri).digest('hex'),
    });
    expect(JSON.stringify(params.output_digests)).not.toContain('locator');
    expect((held.deliverable as { body: string; uri: string }).body).toBe('the body');
    expect((held.deliverable as { body: string; uri: string }).uri).toBe(uri);
  });

  it('RED: only the accepted applicant, and only an in-progress job, can deliver', async () => {
    const { deps } = makeJobDeps({
      job_id: 'hjob_1', status: 'in_progress',
      poster_wallet_id: 'poster', poster_address: '0xposter',
      accepted_applicant_wallet_id: 'worker',
    });
    await expect(deliverHumanJob(deps, 'someone_else', 'agent_x', '0xx', 'hjob_1'))
      .rejects.toThrow('Only the accepted applicant can deliver');
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });
});

describe('completeHumanJob — the poster\'s confirmation is corroboration, not a second act', () => {
  it('pins confirmation_pe_id beside poster_confirmed_at and carries NO durable marker', async () => {
    mockGeneratePE.mockResolvedValue({ peId: 'pe_confirmation', peHash: 'h', prevHash: 'p' });
    const { deps, held, patches } = makeJobDeps({
      job_id: 'hjob_1', status: 'in_progress',
      poster_wallet_id: 'poster', poster_address: '0xposter',
      accepted_applicant_wallet_id: 'worker',
      completion_pe_id: 'pe_delivered',
      // No escrow: the off-chain path is the only path for this job.
    });
    await completeHumanJob(deps, 'poster', 'poster', '0xposter', 'hjob_1');
    expect(mockGeneratePE).toHaveBeenCalledTimes(1);
    const params = mockGeneratePE.mock.calls[0][1] as GeneratePEParams;
    expect(params.actionType).toBe('human_job_completed');
    expect(params[DURABLE_MARKER]).toBeUndefined();
    expect(params[AWAIT_MARKER]).toBeUndefined();
    const confirm = patches.find((p) => 'poster_confirmed_at' in p);
    expect(confirm).toBeDefined();
    expect(confirm!.confirmation_pe_id).toBe('pe_confirmation');
    expect(held.confirmation_pe_id).toBe('pe_confirmation');
    expect(typeof held.poster_confirmed_at).toBe('number');
  });

  it('RED: a re-confirm neither emits a second confirmation PE nor re-pins the id', async () => {
    const { deps, held } = makeJobDeps({
      job_id: 'hjob_1', status: 'in_progress',
      poster_wallet_id: 'poster', poster_address: '0xposter',
      accepted_applicant_wallet_id: 'worker',
      completion_pe_id: 'pe_delivered',
      poster_confirmed_at: 111, confirmation_pe_id: 'pe_first',
    });
    await completeHumanJob(deps, 'poster', 'poster', '0xposter', 'hjob_1');
    expect(mockGeneratePE).not.toHaveBeenCalled();
    expect(held.confirmation_pe_id).toBe('pe_first');
  });
});

describe('SOURCE FENCE — the durable marker lives on the delivery emit and nowhere else in human-jobs.ts', () => {
  const source = readFileSync(`${__dirname}/human-jobs.ts`, 'utf8');

  function markerLines(text: string): number[] {
    return text.split('\n')
      .map((line, index) => ([DURABLE_MARKER, AWAIT_MARKER].some((m) => line.includes(`${m}:`)) ? index + 1 : 0))
      .filter((n) => n > 0);
  }

  it('exactly TWO marker assignments: the speech post (inside postHumanJob) and the delivery (inside deliverHumanJob) — never the confirmation', () => {
    // Empty-population guard: the module is real and still emits through generatePE.
    expect(source.length).toBeGreaterThan(1000);
    expect(source).toContain('generatePE(');
    const lines = markerLines(source);
    expect(lines).toHaveLength(2);
    const srcLines = source.split('\n');
    const postStart = srcLines.findIndex((l) => l.includes('export async function postHumanJob')) + 1;
    const postEnd = srcLines.findIndex((l) => l.includes('export async function browseHumanJobs')) + 1;
    const deliverStart = srcLines.findIndex((l) => l.includes('export async function deliverHumanJob')) + 1;
    const completeStart = srcLines.findIndex((l) => l.includes('export async function completeHumanJob')) + 1;
    expect(postStart).toBeGreaterThan(0);
    expect(postEnd).toBeGreaterThan(postStart);
    expect(deliverStart).toBeGreaterThan(postEnd);
    expect(completeStart).toBeGreaterThan(deliverStart);
    // The post's marker rides the speech window : it is budgeted, never a free durable act.
    expect(lines[0]).toBeGreaterThan(postStart);
    expect(lines[0]).toBeLessThan(postEnd);
    expect(srcLines.slice(postStart, postEnd).join('\n')).toContain('speechWindow: speechWindowParam(window)');
    expect(lines[1]).toBeGreaterThan(deliverStart);
    expect(lines[1]).toBeLessThan(completeStart);
  });

  it('RED: the scanner FAILS on the real source with the marker injected into the confirmation emit', () => {
    const injected = source.replace(
      "actionType: 'human_job_completed',",
      `actionType: 'human_job_completed',\n      ${DURABLE_MARKER}: true,`,
    );
    expect(injected).not.toBe(source);
    expect(markerLines(injected)).toHaveLength(3);
  });
});
