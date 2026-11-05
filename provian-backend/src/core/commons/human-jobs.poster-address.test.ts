/**
 * F-A1-5 — postHumanJob resolves a payable poster EVM address at persist time.
 *
 * The Commons session-token branch passes a resolved address OR null (d06cc643).
 * A null poster_address refuses the deliverer's off-chain completion earning
 * (refused_completion_counterparty_unresolvable). This proves postHumanJob now
 * persists a RESOLVABLE poster_address whenever the poster has one on record —
 * under either wallet key shape — so a genuine session-token post is payable.
 * Non-blocking: a genuinely address-less poster still posts (the escrow release
 * is the primary pay), and poster_address is null only then.
 */
import { describe, it, expect, afterAll } from '@jest/globals';
import { postHumanJob as postHumanJobRaw } from './human-jobs';
import { TEST_WINDOW } from './__test-helpers__/speech';
const postHumanJob = (deps: Parameters<typeof postHumanJobRaw>[0], w: string, a: string, addr: string | null, body: Parameters<typeof postHumanJobRaw>[4]) => postHumanJobRaw(deps, w, a, addr, body, TEST_WINDOW);
import { _resetPvtPrincipalConfigForTests } from '../agent-bank/pvt-principal-config';
import { COMMONS_COLLECTIONS } from './types';
import type { CommonsDeps } from './types';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';

const CONTRACT = '0x0000000000000000000000000000000000000001';
const ALICE = 'wallet_alice';
const ALICE_ADDR = `0x${'a1'.repeat(20)}`;
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
  process.env.ESCROW_V4_CONTRACT_ADDRESS = CONTRACT;
  process.env.PROMISE_V3_CONTRACT_ADDRESS = CONTRACT;
  process.env.POOL_V3_CONTRACT_ADDRESS = CONTRACT;
  process.env.PVT_CONTRACT_ADDRESS_BASE = CONTRACT;
  _resetPvtPrincipalConfigForTests();
}

afterAll(() => { process.env = ORIGINAL_ENV; _resetPvtPrincipalConfigForTests(); });

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

function seedProfile(db: FakeFirestore, wallet: string): void {
  db.store.set(`${COMMONS_COLLECTIONS.PROFILES}/${wallet}`, {
    participant_type: 'human', attestation_tier: 'software',
  });
}

describe('F-A1-5 — postHumanJob poster address resolution', () => {
  it('uses the caller-passed EVM address directly when present', async () => {
    enablePvtPrincipal();
    const db = createFakeFirestore();
    seedProfile(db, ALICE);
    const job = await postHumanJob(makeDeps(db) as unknown as CommonsDeps, ALICE, ALICE, ALICE_ADDR, POST_BODY);
    expect(job.poster_address).toBe(ALICE_ADDR);
  });

  it('resolves from the wallets record (user_id query) when the branch passed null', async () => {
    enablePvtPrincipal();
    const db = createFakeFirestore();
    seedProfile(db, ALICE);
    db.store.set('wallets/some_doc', { user_id: ALICE, address: ALICE_ADDR });
    const job = await postHumanJob(makeDeps(db) as unknown as CommonsDeps, ALICE, ALICE, null, POST_BODY);
    expect(job.poster_address).toBe(ALICE_ADDR); // was null before F-A1-5
  });

  it('F-A1-5 fallback: resolves from the wallets DOC by id when the user_id query misses', async () => {
    enablePvtPrincipal();
    const db = createFakeFirestore();
    seedProfile(db, ALICE);
    // No wallets doc keyed by user_id; the record lives under the walletId as doc id.
    db.store.set(`wallets/${ALICE}`, { address: ALICE_ADDR });
    const job = await postHumanJob(makeDeps(db) as unknown as CommonsDeps, ALICE, ALICE, null, POST_BODY);
    expect(job.poster_address).toBe(ALICE_ADDR);
  });

  // the resolution CAN observe absence — a genuinely address-less poster
  // persists null (and the post still succeeds; the escrow release is the pay).
  it('RED — a poster with no on-record address persists null and still posts (non-blocking)', async () => {
    enablePvtPrincipal();
    const db = createFakeFirestore();
    seedProfile(db, ALICE);
    const job = await postHumanJob(makeDeps(db) as unknown as CommonsDeps, ALICE, ALICE, null, POST_BODY);
    expect(job.poster_address).toBeNull();
    expect(job.job_id).toMatch(/^hjob_/); // the post is NOT blocked
  });
});
