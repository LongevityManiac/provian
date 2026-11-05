/**
 * 4b: PVT-principal is ENABLED (Base-only). Human Jobs honors the gate —
 * posting/accepting a PVT-budget job works when ENABLE_PVT_PRINCIPAL=true and is
 * blocked when it is off. (Was the runtime boundary quarantine regression that asserted stale
 * flags could NOT reopen it; the campaign lifts that quarantine.)
 */
import { describe, it, expect, afterAll, beforeEach, jest } from '@jest/globals';

const mockGeneratePE = jest.fn(async (..._args: unknown[]) => ({ pe_id: 'pe_mock' }));
jest.mock('../agent-bank/pe-utils', () => ({
  __esModule: true,
  generatePE: (...args: unknown[]) => mockGeneratePE(...args),
}));

jest.mock('../agent-bank/escrow', () => ({
  __esModule: true,
  createEscrow: jest.fn(async () => ({ escrow_id: 'esc_mock' })),
  completeEscrow: jest.fn(async () => ({})),
}));

import { createEscrow } from '../agent-bank/escrow';
import { postHumanJob as postHumanJobRaw, acceptApplicant } from './human-jobs';
import { TEST_WINDOW } from './__test-helpers__/speech';
const postHumanJob = (deps: Parameters<typeof postHumanJobRaw>[0], w: string, a: string, addr: string | null, body: Parameters<typeof postHumanJobRaw>[4]) => postHumanJobRaw(deps, w, a, addr, body, TEST_WINDOW);
import { getPvtPrincipalChainString } from '../agent-bank/pvt-principal-config';
import { COMMONS_COLLECTIONS, type CommonsDeps } from './types';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';

const mockedCreateEscrow = createEscrow as jest.MockedFunction<typeof createEscrow>;
const ALICE = 'wallet_alice';
const BOB = 'wallet_bob';
const ORIGINAL_ENV = { ...process.env };

function makeDeps(db: FakeFirestore): CommonsDeps {
  return {
    db,
    cache: { checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }) },
    peBuffer: { enqueue: () => {} },
    recordPEAccrual: async () => {},
  } as unknown as CommonsDeps;
}

function seedProfiles(db: FakeFirestore): void {
  db.store.set(`${COMMONS_COLLECTIONS.PROFILES}/${ALICE}`, {
    participant_type: 'human',
    attestation_tier: 'software',
  });
  db.store.set(`${COMMONS_COLLECTIONS.PROFILES}/${BOB}`, { participant_type: 'human' });
}

function seedJobForAccept(db: FakeFirestore): void {
  seedProfiles(db);
  db.store.set(`${COMMONS_COLLECTIONS.HUMAN_JOBS}/hjob1`, {
    job_id: 'hjob1',
    poster_wallet_id: ALICE,
    poster_address: '0xJOB',
    title: 'Translate a document',
    description: 'Need a careful human translation.',
    status: 'open',
    budget_pvt: '1000000000000000000',
  });
  db.store.set(`${COMMONS_COLLECTIONS.HUMAN_JOB_APPLICATIONS}/a1`, {
    application_id: 'a1',
    job_id: 'hjob1',
    applicant_wallet_id: BOB,
    pe_id: 'pe_bob',
    applied_at: 100,
    status: 'pending',
  });
}

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

beforeEach(() => {
  mockedCreateEscrow.mockClear();
  mockGeneratePE.mockClear();
});
afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('Human Jobs PVT-principal enablement (4b, Base-only)', () => {
  describe('ENABLED — ENABLE_PVT_PRINCIPAL="true"', () => {
    beforeEach(() => {
      process.env = { ...ORIGINAL_ENV, ENABLE_PVT_PRINCIPAL: 'true' };
    });

    it('resolves the PVT-principal escrow chain to base', () => {
      expect(getPvtPrincipalChainString()).toBe('base');
    });

    it('is Base-only: PVT_PRINCIPAL_CHAINS cannot widen the chain', () => {
      process.env.PVT_PRINCIPAL_CHAINS = 'arbitrum';
      expect(getPvtPrincipalChainString()).toBe('base');
    });

    it('ALLOWS posting a PVT-budget human job (returns a job past the gate)', async () => {
      // The job doc is written INSIDE generatePE's transaction callback (mocked
      // here), so the gate-passed evidence is the returned job + that generatePE
      // was reached — not a store write.
      const db = createFakeFirestore();
      seedProfiles(db);
      const job = await postHumanJob(makeDeps(db), ALICE, ALICE, '0xJOB', POST_BODY);
      expect(job.job_id).toMatch(/^hjob_/);
      expect(job.budget_pvt).toBe('1000000000000000000');
      expect(mockGeneratePE).toHaveBeenCalled();
    });

    it('acceptApplicant auto-escrows in PVT on base', async () => {
      const db = createFakeFirestore();
      seedJobForAccept(db);
      await acceptApplicant(makeDeps(db), ALICE, ALICE, '0xJOB', 'hjob1', BOB);
      // createEscrow(deps, request) — the escrow request is the SECOND arg.
      expect(mockedCreateEscrow).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ currency: 'pvt', chain: 'base', amount_pvt: '1000000000000000000' }),
      );
    });
  });

  // ── negative control ────────────────────────────────────────────────
  // The SAME operations with the flag OFF must still block. This proves the
  // enablement above is the flag's doing, not an unconditional open (a mutation
  // hardwiring the gate to enabled fails these; hardwiring to disabled fails the
  // ENABLED block above).
  describe('DISABLED — ENABLE_PVT_PRINCIPAL unset (the gate still blocks)', () => {
    beforeEach(() => {
      process.env = { ...ORIGINAL_ENV };
      delete process.env.ENABLE_PVT_PRINCIPAL;
    });

    it('getPvtPrincipalChainString is null', () => {
      expect(getPvtPrincipalChainString()).toBeNull();
    });

    it('BLOCKS posting a PVT-budget job (no job written)', async () => {
      const db = createFakeFirestore();
      seedProfiles(db);
      await expect(postHumanJob(makeDeps(db), ALICE, ALICE, '0xJOB', POST_BODY))
        .rejects.toThrow(/no PVT-principal chain is configured/);
      expect([...db.store.keys()].some((k) => k.startsWith(`${COMMONS_COLLECTIONS.HUMAN_JOBS}/`))).toBe(false);
    });

    it('BLOCKS acceptance before any escrow dependency runs', async () => {
      const db = createFakeFirestore();
      seedJobForAccept(db);
      await expect(acceptApplicant(makeDeps(db), ALICE, ALICE, '0xJOB', 'hjob1', BOB))
        .rejects.toThrow(/not enabled on this relay/);
      expect(mockedCreateEscrow).not.toHaveBeenCalled();
    });
  });
});
