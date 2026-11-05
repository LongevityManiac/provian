/**
 * COMPLETION EARNING, end to end: the PRODUCTION-EFFECT proof.
 *
 * Driven through the REAL pipeline against a fake Firestore — the real
 * `recordPEAccrual` (the deliverer's `human_job_delivered` seal and the
 * watcher's `escrow_completed` seal), the real pending-evidence resolver
 * (`judgePendingEvidenceRow` / `applyPendingEvidenceVerdict` /
 * `sweepPendingEvidence`, with the real `completion-verifier.ts` reading the
 * real job / envelope / registry documents), the real settlement inlet source
 * (`createFirestoreInletSource().loadPage`, the SAME selection the weekly cron
 * reads) and the real eligibility evaluator the kernel batch runs — so the
 * whole chain runs: seal → verify → claim → promote → lift → offer.
 *
 * ── THE LINEAGE-OPTIONAL POLICY IS SUPPLIED, NOT ASSUMED ─────────────────────
 * the live matrix at this commit the five completion types are still
 * `session_lineage_policy: 'required'`, which seals them terminal
 * `record_only` at the lineage gate. Commit B reclassifies them (the digest-
 * moving matrix re-issue that awaits the policy setter signature). This suite supplies a
 * lineage-optional policy for exactly those five rows to the pipeline
 * (`loadRuntimeMonetaryPolicy` mocked over the REAL materialized template —
 * every other row, every multiplier and every weight verbatim), so the proof
 * here does not depend on commit B's generated matrix and stays green across
 * both commits. `reachability` asserts the seal the policy produces before any
 * behaviour is claimed.
 *
 * ── THE RED (ii): PRE-FIX CODE ────────────────────────────────────────────────
 * Proven by SOURCE MUTATION, run once and recorded here (restored byte-identical,
 * sha256-verified):
 * mutation — in `pending-evidence-resolver.ts`, delete the
 * `if (requirement === 'verified_substantive_outcome') { … }` dispatch arm in
 * `judgePendingEvidenceRow` (the pre- shape: the class fell through to
 * `NO_VERIFIER_REASONS` and refused BY NAME as
 * `no_verifier_outcome_runtime_inactive`).
 * observed (2026-09-03, resolver sha256 1546ee6d… before and after the
 * restore) — 15 of this suite's 21 cases go RED: every `promoted` /
 * `awaiting` / `refused_completion_*` / `refused_canonical_event_already_minted`
 * expectation received `refused_no_verifier_for_class` (reason
 * `no_verifier_unknown_evidence_requirement: verified_substantive_outcome`),
 * the sweep reported `promoted: 0`, the row stayed `pending_evidence` with 0
 * settleable value, no completion claim was created, the inlet never offered
 * the deliverer, and the takeover/registration cases could not even reach
 * their second witness. The 6 cases that stayed green are the record-time
 * seals (reachability, the durable-marker RED, the record-time same-owner
 * fence, the unverified watcher row, the best-effort confirmation) — which is
 * exactly the pre-fix world: the delivery could be held, and nothing could
 * ever resolve it.
 * The IN-SUITE controls below cover every other direction: no confirmation →
 * 0, same-owner poster → 0 (record time AND resolve time), the poster's own
 * confirmation → 0, a missing projection → no lift, a late confirmation → no
 * lift, both arrival orders → ONE mint at the on-chain value.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import type { BeneficiaryCacheEntry } from './beneficiary';
import { ORDINARY_ACCRUAL_REPLAY_SOURCE } from './wp11/ordinary-accrual-intake';

let mockDb: FakeFirestore;
jest.mock('firebase-admin', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createFakeFirestore: mk } = require('./__test-helpers__/fake-firestore');
  const db = mk();
  mockDb = db;
  const firestore = Object.assign(() => db, {
    FieldValue: { increment: (n: number) => ({ __increment: n }) },
  });
  return { __esModule: true, default: { firestore }, firestore };
});
jest.mock('../../cache', () => ({
  cache: {
    getUserDailyPECountStrict: jest.fn(async () => 0),
    getUserActionTypeCountStrict: jest.fn(async () => 0),
    isArtifactHashSeen: async () => false,
    recordArtifactHash: async () => {},
    incrementUserActionTypeCount: jest.fn(async () => 1),
    incrementHourlyPECount: jest.fn(async () => {}),
    commitPEAccountingCountersOnce: jest.fn(async () => ({ idempotent: false })),
  },
  CacheUnavailableError: class CacheUnavailableError extends Error {},
}));
const mockResolveBeneficiary = jest.fn<(...a: unknown[]) => Promise<BeneficiaryCacheEntry>>(async () => ({
  linked: false, humanWalletId: null, humanUserId: null, humanAddress: null, agentShareBps: null,
}));
jest.mock('./beneficiary', () => ({ resolveBeneficiary: mockResolveBeneficiary }));
jest.mock('../jurisdiction/jurisdiction-policy', () => ({ getJurisdictionPolicy: async () => 'immediate' }));
jest.mock('./delegation-pe', () => ({ isDelegationQualifying: () => false, createDelegationPE: async () => {} }));
jest.mock('../provenance/pe-type-catalog', () => ({
  getCategoryForActionType: async () => 'institutional',
  recordActionTypeObservation: async () => {},
}));
jest.mock('../foundation-membership/client', () => ({
  loadFoundationMembershipConfig: () => ({ enabled: false }),
  queueInitialMembershipGrants: async () => {},
}));
/**
 * The lineage-optional policy for the FIVE completion types, over the REAL
 * materialized template. Everything else is the live template verbatim.
 */
const COMPLETION_TYPES = [
  'promise_fulfilled', 'job_delivered', 'human_job_delivered',
  'goal_envelope_completed', 'human_job_completed',
] as const;
jest.mock('./policy/runtime-monetary-policy', () => {
  const actual = jest.requireActual('./policy/runtime-monetary-policy') as
    typeof import('./policy/runtime-monetary-policy');
  const base = actual.materializeProposedMonetaryPolicy(0);
  const actions: Record<string, unknown> = { ...base.actions };
  for (const t of ['promise_fulfilled', 'job_delivered', 'human_job_delivered', 'goal_envelope_completed', 'human_job_completed']) {
    actions[t] = Object.freeze({ ...base.actions[t], sessionLineagePolicy: 'optional' });
  }
  const policy = Object.freeze({ ...base, actions: Object.freeze(actions) });
  return { ...actual, loadRuntimeMonetaryPolicy: async () => policy };
});

// eslint-disable-next-line import/first
import { recordPEAccrual, type RecordPEAccrualParams } from '../../pvt-accrual';
// eslint-disable-next-line import/first
import {
  ORDINARY_ACCRUAL_INTAKE_COLLECTION,
  buildOrdinaryAccrualIntake,
} from './wp11/ordinary-accrual-intake';
// eslint-disable-next-line import/first
import {
  CLAIM_LEDGER_COLLECTION,
  claimKeyOf,
  registerClaim,
  type NewClaimInput,
  type SettlementDb,
} from './wp4/durable-settlement-store';
// eslint-disable-next-line import/first
import { corroborationLiftedRecordPointsAtomic } from './policy/economic-projection';
// eslint-disable-next-line import/first
import type { PEHistoryDocument } from '../../pe-history';
// eslint-disable-next-line import/first
import {
  PENDING_EVIDENCE_RESOLUTION_COLLECTION,
  applyPendingEvidenceVerdict,
  hashResolutionEvidence,
  judgePendingEvidenceRow,
  sweepPendingEvidence,
  type HeldPendingEvidenceRow,
  type PendingEvidenceResolverDeps,
} from './pending-evidence-resolver';
// eslint-disable-next-line import/first
import { completionCanonicalIdForEscrow, completionClaimDocId } from './completion-claim';
// eslint-disable-next-line import/first
import { createFirestoreInletSource } from './wp4/claim-inlet-source';
// eslint-disable-next-line import/first
import { evaluateEligibility, PVT9_ELIGIBILITY_CUT_LINE_MS } from './wp-ev/eligibility';
// eslint-disable-next-line import/first
import { ATTESTATION_ENHANCEMENT_WINDOW_MS } from './policy/monetary-accounting';
// eslint-disable-next-line import/first
import { PROPOSED_ATTESTATION_MULTIPLIERS_BPS } from './policy/proposed-monetary-policy';
// eslint-disable-next-line import/first
import {
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  nativeWalletAddressIndexId,
} from './native-wallet-registration';
// eslint-disable-next-line import/first
import { GENESIS_PREV_HASH } from '../pe/constants';
// eslint-disable-next-line import/first
import { cache as mockedCache } from '../../cache';
// eslint-disable-next-line import/first
import { backfillPendingCachePEs } from './pending-cache-backfill';
// eslint-disable-next-line import/first
import type { RedisCache } from '../../cache';
// eslint-disable-next-line import/first
import type { Firestore } from 'firebase-admin/firestore';

/** Post cut-line, so the eligibility evaluator's fence admits the rows. */
const T0 = PVT9_ELIGIBILITY_CUT_LINE_MS + 10 * 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const DELIVERER = 'agent_deliverer';
const DELIVERER_WALLET = 'wallet_aw_deliverer';
const DELIVERER_ADDR = `0x${'d1'.repeat(20)}`;
const POSTER_WALLET = 'user_poster';
const POSTER_ADDR = `0x${'e2'.repeat(20)}`;
const JOB = 'hjob_11111111-1111-4111-8111-111111111111';
const ESCROW = 'esc_22222222-2222-4222-8222-222222222222';
const ONCHAIN_ESCROW = `0x${'ab'.repeat(32)}`;
const RELEASE_TX = `0x${'f3'.repeat(32)}`;
const DELIVERY_PE = 'pe_delivery';
const RELEASE_PE = 'pe_release';
const CONFIRMATION_PE = 'pe_confirmation';
const CANONICAL = completionCanonicalIdForEscrow(ESCROW);

interface PeRow {
  mint_status: string;
  mint_disposition: string;
  estimatedPVT: number;
  corroboration_status: string;
  corroboration_received_at: number | null;
  completion_witness: string | null;
  completion_canonical_id: string | null;
  economic_snapshot: { recordPointsAtomic: string } | null;
  economic_eligibility_projection: unknown;
  disposition_reason_code: string;
}

/** The deliverer's `human_job_delivered` seal — the shape `deliverHumanJob` fires. */
function deliveryParams(over: Partial<RecordPEAccrualParams> = {}): RecordPEAccrualParams {
  return {
    peId: DELIVERY_PE,
    userId: DELIVERER,
    actionType: 'human_job_delivered',
    integrationSource: 'agent_bank_generate_pe',
    attestationDepth: 'software',
    peHash: `h_${DELIVERY_PE}`,
    timestamp: T0,
    durableReplaySource: ORDINARY_ACCRUAL_REPLAY_SOURCE,
    counterpartyAddress: POSTER_ADDR,
    walletAddress: DELIVERER_ADDR,
    ownerType: 'agent',
    ...over,
  } as RecordPEAccrualParams;
}

/** The completion watcher's verified `escrow_completed` seal for the SAME job. */
function releaseParams(over: Partial<RecordPEAccrualParams> = {}): RecordPEAccrualParams {
  return {
    peId: RELEASE_PE,
    userId: DELIVERER,
    actionType: 'escrow_completed',
    integrationSource: 'agent_bank_generate_pe',
    attestationDepth: 'software',
    peHash: `h_${RELEASE_PE}`,
    timestamp: T0 + 2 * HOUR,
    durableReplaySource: ORDINARY_ACCRUAL_REPLAY_SOURCE,
    economicEvidenceState: 'verified',
    economicCanonicalEventId: `8453:${RELEASE_TX}:0`,
    completionCanonicalId: CANONICAL,
    counterpartyAddress: POSTER_ADDR,
    walletAddress: DELIVERER_ADDR,
    ownerType: 'agent',
    ...over,
  } as RecordPEAccrualParams;
}

function commitIntake(params: RecordPEAccrualParams): void {
  const doc = buildOrdinaryAccrualIntake({
    prevHash: `prev_${params.peId}`, peHash: params.peHash, accrualParams: params,
  });
  mockDb.store.set(`${ORDINARY_ACCRUAL_INTAKE_COLLECTION}/${params.peId}`, { ...doc });
}
function row(peId: string): PeRow {
  const r = mockDb.store.get(`pe_history/${peId}`) as PeRow | undefined;
  if (!r) throw new Error(`no pe_history row for ${peId}`);
  return r;
}
function fullRow(peId: string): PEHistoryDocument {
  return mockDb.store.get(`pe_history/${peId}`) as unknown as PEHistoryDocument;
}
function points(r: PeRow): bigint {
  return BigInt(r.economic_snapshot?.recordPointsAtomic ?? '0');
}
/** The settleable value the LIVE inlet registers (corroboration-lifted). */
function settleable(peId: string): bigint {
  return BigInt(corroborationLiftedRecordPointsAtomic(fullRow(peId)));
}
async function seal(params: RecordPEAccrualParams): Promise<PeRow> {
  commitIntake(params);
  await recordPEAccrual(params);
  return row(params.peId);
}
function claimOwner(): string | undefined {
  const claim = mockDb.store.get(`completion_mint_claims/${completionClaimDocId(DELIVERER, CANONICAL)}`);
  return claim ? (claim.owner_pe_id as string) : undefined;
}

/** The sealed envelope `generatePE` writes, with the fields the verifier and the inlet read. */
async function seedEnvelope(
  peId: string,
  over: Record<string, unknown> = {},
): Promise<void> {
  await mockDb.collection('provenance_envelopes').doc(peId).set({
    id: peId,
    prev_hash: GENESIS_PREV_HASH,
    hash: `0x${'11'.repeat(32)}`,
    timestamp: T0,
    action_type: 'human_job_delivered',
    user_id: DELIVERER,
    wallet_id: DELIVERER_WALLET,
    agent_id: DELIVERER,
    metadata: { job_id: JOB },
    counterparty_address: POSTER_ADDR,
    counterparty_type: 'agent',
    integration_source: 'agent_bank_generate_pe',
    ...over,
  });
}
async function seedJob(over: Record<string, unknown> = {}): Promise<void> {
  await mockDb.collection('commons_human_jobs').doc(JOB).set({
    job_id: JOB,
    poster_wallet_id: POSTER_WALLET,
    poster_address: POSTER_ADDR,
    accepted_applicant_wallet_id: DELIVERER_WALLET,
    completion_pe_id: DELIVERY_PE,
    status: 'in_progress',
    escrow_id: ESCROW,
    ...over,
  });
}
/** The poster confirms at `at`: `completeHumanJob` seals the PE and pins it on the job. */
async function confirm(at: number): Promise<void> {
  await seedEnvelope(CONFIRMATION_PE, {
    timestamp: at,
    action_type: 'human_job_completed',
    user_id: POSTER_WALLET,
    wallet_id: POSTER_WALLET,
    agent_id: POSTER_WALLET,
    counterparty_address: null,
    counterparty_type: null,
    metadata: { job_id: JOB, applicant_wallet_id: DELIVERER_WALLET, escrow_id: ESCROW },
  });
  await mockDb.collection('commons_human_jobs').doc(JOB)
    .update({ poster_confirmed_at: at, confirmation_pe_id: CONFIRMATION_PE });
}
/** The deliverer as a payee the inlet can resolve. */
async function seedDelivererWallet(): Promise<void> {
  await mockDb.collection('agent_wallets').doc(DELIVERER_WALLET).set({
    id: DELIVERER_WALLET, agent_id: DELIVERER, address: DELIVERER_ADDR, status: 'active',
  });
}
function held(peId: string): HeldPendingEvidenceRow {
  return mockDb.store.get(`pe_history/${peId}`) as unknown as HeldPendingEvidenceRow;
}
function resolverDeps(): PendingEvidenceResolverDeps {
  return {
    db: mockDb as unknown as PendingEvidenceResolverDeps['db'],
    verifyChainReceipt: async () => ({ ok: false, reason: 'not_used_here' }),
    resolveActorAddress: async () => null,
  };
}
/** One resolver pass over ONE row: judge + apply, exactly as the sweep does. */
async function resolve(peId: string, nowMs: number): Promise<string> {
  const deps = resolverDeps();
  const verdict = await judgePendingEvidenceRow(deps, held(peId), { nowMs });
  const evidenceHash = verdict.evidence ? hashResolutionEvidence(verdict.evidence) : null;
  return applyPendingEvidenceVerdict(deps.db, held(peId), verdict, { nowMs }, evidenceHash);
}
function ledgerLeg(peId: string): NewClaimInput {
  return {
    leg: 'sole',
    pe_id: peId,
    claim_id: `0x${'1'.padStart(64, '0')}`,
    lane: 'standard',
    contributor: DELIVERER_ADDR,
    beneficiary_class: 1,
    record_points_atomic: '1000000000000000000',
  };
}
const LIFT_NUM = BigInt(PROPOSED_ATTESTATION_MULTIPLIERS_BPS.corroborated);
const LIFT_DEN = BigInt(PROPOSED_ATTESTATION_MULTIPLIERS_BPS.software);

beforeEach(async () => {
  jest.clearAllMocks();
  mockDb.store.clear();
  mockDb.ops.length = 0;
  await seedJob();
  await seedEnvelope(DELIVERY_PE);
  await seedDelivererWallet();
});

describe('reachability — what the supplied lineage-optional policy actually seals', () => {
  it('a durable human_job_delivered seals pending_evidence with NON-ZERO sealed points (the held population is real)', async () => {
    const r = await seal(deliveryParams());
    expect(r.mint_status).toBe('pending_evidence');
    expect(r.mint_disposition).toBe('pending_evidence');
    expect(r.disposition_reason_code).toBe('awaiting_evidence');
    expect(points(r)).toBeGreaterThan(0n);
    expect(r.estimatedPVT).toBe(0); // held: worth 0 until resolved
    expect(settleable(DELIVERY_PE)).toBe(points(r)); // no lift on a held row
    expect(claimOwner()).toBeUndefined();
  });

  it('RED: WITHOUT the durable inlet the same delivery seals terminal record_only — the marker deliverHumanJob now passes is load-bearing', async () => {
    const r = await seal(deliveryParams({ durableReplaySource: undefined }));
    expect(r.mint_status).toBe('record_only');
    expect(r.mint_disposition).toBe('record_only');
  });

  it('the LIVE lineage-required policy is what commit B moves: with lineage REQUIRED the row seals record_only at the gate', async () => {
    // The mocked policy is the live template with five rows flipped. Seal an
    // untouched lineage-REQUIRED substantive-outcome row (`agreement_settled`,
    // the sixth member of the class, deliberately NOT reclassified) to show the
    // gate itself is real and that the flip is what opens the door.
    const r = await seal(deliveryParams({ peId: 'pe_agreement', peHash: 'h_agreement', actionType: 'agreement_settled' }));
    expect(r.mint_status).toBe('record_only');
    expect(r.disposition_reason_code).toBe('missing_session_lineage_record_only');
  });
});

describe('(i) an off-chain human job with a distinct-owner poster confirmation resolves to eligible, non-zero, deliverer as payee', () => {
  it('promotes: eligible + claim owned + corroborated (lifted) + offered by the inlet to the deliverer', async () => {
    const sealed = await seal(deliveryParams());
    await confirm(T0 + HOUR);

    expect(await resolve(DELIVERY_PE, T0 + 2 * HOUR)).toBe('promoted');

    const r = row(DELIVERY_PE);
    expect(r.mint_status).toBe('eligible');
    expect(r.mint_disposition).toBe('eligible');
    expect(r.disposition_reason_code).toBe('policy_eligible');
    expect(r.estimatedPVT).toBeGreaterThan(0);
    expect(r.corroboration_status).toBe('peer_verified');
    expect(r.corroboration_received_at).toBe(T0 + HOUR);
    expect(r.completion_witness).toBe('counterparty_confirmation');
    expect(r.completion_canonical_id).toBe(CANONICAL);
    expect(r.economic_eligibility_projection).not.toBeNull();
    // The sealed snapshot is untouched (mint-once and the lift both live beside it).
    expect(points(r)).toBe(points(sealed));
    // The completion slot is owned by the deliverer's row.
    expect(claimOwner()).toBe(DELIVERY_PE);
    // THE LIFT: the confirmation landed inside the 72h window, so the settleable
    // value is software → corroborated, from the live ladder (never a copied number).
    expect(settleable(DELIVERY_PE)).toBe((points(sealed) * LIFT_NUM) / LIFT_DEN);
    expect(settleable(DELIVERY_PE)).toBeGreaterThan(points(sealed));
    // Durable resolution record, so a second pass is a no-op.
    expect(mockDb.store.get(`${PENDING_EVIDENCE_RESOLUTION_COLLECTION}/${DELIVERY_PE}`)?.outcome).toBe('promoted');
    expect(await resolve(DELIVERY_PE, T0 + 3 * HOUR)).toBe('already_resolved');

    // THE INLET: deferred while the takeover window is open, then OFFERED with
    // the deliverer as payee at the lifted value — and admissible.
    const inside = await createFirestoreInletSource({
      db: mockDb as unknown as SettlementDb, now: () => T0 + 2 * HOUR,
    }).loadPage({ pageSize: 10 });
    expect(inside.readCount).toBe(1);
    expect(inside.candidates).toEqual([]);
    const after = await createFirestoreInletSource({
      db: mockDb as unknown as SettlementDb, now: () => T0 + ATTESTATION_ENHANCEMENT_WINDOW_MS,
    }).loadPage({ pageSize: 10 });
    expect(after.candidates).toHaveLength(1);
    const offered = after.candidates[0];
    expect(offered.peId).toBe(DELIVERY_PE);
    expect(offered.contributor).toBe(DELIVERER_ADDR);
    expect(offered.lane).toBe('standard');
    expect(BigInt((offered as { recordPointsAtomic: string }).recordPointsAtomic))
      .toBe(settleable(DELIVERY_PE));
    expect(evaluateEligibility(offered.eligibility).kind).toBe('eligible');
  });

  it('the SWEEP does the same from the scheduler\'s entry point and reports it', async () => {
    await seal(deliveryParams());
    await confirm(T0 + HOUR);
    const first = await sweepPendingEvidence(resolverDeps(), { nowMs: T0 + 2 * HOUR });
    expect(first.population).toBe(1);
    expect(first.promoted).toBe(1);
    expect(row(DELIVERY_PE).mint_status).toBe('eligible');
    // The row left the held population; nothing is re-promoted.
    const second = await sweepPendingEvidence(resolverDeps(), { nowMs: T0 + 3 * HOUR });
    expect(second.population).toBe(0);
    expect(second.promoted).toBe(0);
  });
});

describe('(iii) an unverifiable self-claim mints 0', () => {
  it('no poster confirmation → awaiting; the row stays pending_evidence, worth 0, no claim', async () => {
    await seal(deliveryParams());
    expect(await resolve(DELIVERY_PE, T0 + 2 * HOUR)).toBe('awaiting_counterparty_confirmation');
    expect(row(DELIVERY_PE).mint_status).toBe('pending_evidence');
    expect(row(DELIVERY_PE).estimatedPVT).toBe(0);
    expect(claimOwner()).toBeUndefined();
    // Not persisted: the row stays reachable for the pass after the confirmation lands.
    expect(mockDb.store.get(`${PENDING_EVIDENCE_RESOLUTION_COLLECTION}/${DELIVERY_PE}`)).toBeUndefined();
  });

  it('RED (same-owner fence, RESOLVE time): a poster sharing beneficial ownership with the deliverer is refused by name and mints 0', async () => {
    await seal(deliveryParams());
    await confirm(T0 + HOUR);
    // The poster's address now resolves to the deliverer's own owner.
    await mockDb.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION)
      .doc(nativeWalletAddressIndexId(POSTER_ADDR))
      // A CANONICAL index row (exact key set, schema, chain, address, created_at_ms):
      // the fence binds to the same parser the USDC watchers enumerate with, and
      // since -a an UNUSABLE row is Unknown = Block (pending_review),
      // not a same-owner verdict — so the fixture must be a real row to exercise
      // the fence itself rather than the unusable-shape hold.
      .set({
        schema_version: 'native-wallet-address-index/v1',
        chain_id: 8453,
        address: POSTER_ADDR,
        wallet_id: 'w_self',
        owner_type: 'human',
        owner_id: DELIVERER,
        created_at_ms: 1,
      });
    expect(await resolve(DELIVERY_PE, T0 + 2 * HOUR)).toBe('refused_completion_self_dealing');
    expect(row(DELIVERY_PE).mint_status).toBe('pending_evidence');
    expect(claimOwner()).toBeUndefined();
  });

  it('RED (same-owner fence, RECORD time): a same-owner delivery seals record_only before any resolver runs', async () => {
    await mockDb.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION)
      .doc(nativeWalletAddressIndexId(POSTER_ADDR))
      // A CANONICAL index row (exact key set, schema, chain, address, created_at_ms):
      // the fence binds to the same parser the USDC watchers enumerate with, and
      // since -a an UNUSABLE row is Unknown = Block (pending_review),
      // not a same-owner verdict — so the fixture must be a real row to exercise
      // the fence itself rather than the unusable-shape hold.
      .set({
        schema_version: 'native-wallet-address-index/v1',
        chain_id: 8453,
        address: POSTER_ADDR,
        wallet_id: 'w_self',
        owner_type: 'human',
        owner_id: DELIVERER,
        created_at_ms: 1,
      });
    const r = await seal(deliveryParams());
    expect(r.mint_status).toBe('record_only');
    expect(r.disposition_reason_code).toBe('self_or_shared_beneficial_ownership');
    expect(r.estimatedPVT).toBe(0);
  });

  it('RED: a confirmation that does not bind (wrong job) is refused, never promoted', async () => {
    await seal(deliveryParams());
    await confirm(T0 + HOUR);
    await mockDb.collection('provenance_envelopes').doc(CONFIRMATION_PE)
      .update({ metadata: { job_id: 'hjob_other' } });
    expect(await resolve(DELIVERY_PE, T0 + 2 * HOUR)).toBe('refused_completion_binding');
    expect(row(DELIVERY_PE).mint_status).toBe('pending_evidence');
  });

  it('RED: a disputed job is refused even with a confirmation on file', async () => {
    await seal(deliveryParams());
    await confirm(T0 + HOUR);
    await mockDb.collection('commons_human_jobs').doc(JOB).update({ status: 'disputed' });
    expect(await resolve(DELIVERY_PE, T0 + 2 * HOUR)).toBe('refused_completion_binding');
  });
});

describe('(iv) both an on-chain release and an off-chain confirmation for ONE job → exactly ONE mint at the on-chain value, in BOTH orders', () => {
  beforeEach(async () => {
    // The relay escrow the on-chain id is pinned on — the same one the job carries.
    await mockDb.collection('escrows').doc(ESCROW).set({
      escrow_id: ESCROW, onchain_escrow_id: ONCHAIN_ESCROW, status: 'completed',
    });
  });

  it('WATCHER-FIRST → RESOLVER: the release owns the slot; the off-chain path refuses by name (never pays again)', async () => {
    const release = await seal(releaseParams());
    expect(release.mint_status).toBe('eligible');
    expect(release.completion_witness).toBe('onchain_release');
    expect(release.completion_canonical_id).toBe(CANONICAL);
    expect(claimOwner()).toBe(RELEASE_PE);

    await seal(deliveryParams());
    await confirm(T0 + HOUR);
    expect(await resolve(DELIVERY_PE, T0 + 3 * HOUR)).toBe('refused_canonical_event_already_minted');
    expect(row(DELIVERY_PE).mint_status).toBe('pending_evidence');
    expect(claimOwner()).toBe(RELEASE_PE);

    const eligible = [row(DELIVERY_PE), row(RELEASE_PE)].filter((r) => r.mint_status === 'eligible');
    expect(eligible).toHaveLength(1);
    expect(settleable(RELEASE_PE)).toBe(points(release)); // the on-chain value, verbatim
    expect(settleable(DELIVERY_PE)).toBe(points(row(DELIVERY_PE))); // held, unlifted, unpaid
  });

  it('RESOLVER-FIRST → WATCHER: the release TAKES OVER the eligible, unregistered off-chain incumbent; ONE mint at the on-chain value', async () => {
    await seal(deliveryParams());
    await confirm(T0 + HOUR);
    expect(await resolve(DELIVERY_PE, T0 + 90 * 60 * 1000)).toBe('promoted');
    expect(claimOwner()).toBe(DELIVERY_PE);
    expect(row(DELIVERY_PE).mint_status).toBe('eligible');

    const release = await seal(releaseParams());
    expect(release.mint_status).toBe('eligible');
    expect(claimOwner()).toBe(RELEASE_PE);
    // The off-chain incumbent is demoted — mutable mint_status only; its seal survives.
    const demoted = row(DELIVERY_PE);
    expect(demoted.mint_status).toBe('corroborated_duplicate');
    expect(demoted.economic_snapshot).not.toBeNull();
    expect((fullRow(DELIVERY_PE) as unknown as Record<string, unknown>).completion_takeover_demoted_by_pe_id).toBe(RELEASE_PE);

    const eligible = [row(DELIVERY_PE), row(RELEASE_PE)].filter((r) => r.mint_status === 'eligible');
    expect(eligible).toHaveLength(1);
    // The value paid is the ON-CHAIN row's own — not the off-chain value, not the sum.
    expect(settleable(RELEASE_PE)).toBe(points(release));
    expect(points(release) + points(demoted)).toBeGreaterThan(settleable(RELEASE_PE));
    // The inlet offers the on-chain row (never deferred) and not the demoted one.
    const page = await createFirestoreInletSource({
      db: mockDb as unknown as SettlementDb, now: () => T0 + 3 * HOUR,
    }).loadPage({ pageSize: 10 });
    expect(page.candidates.map((c) => c.peId)).toEqual([RELEASE_PE]);
  });

  it(' verbatim: a release arriving AFTER the off-chain incumbent REGISTERED is refused; the registered value stands (never strand)', async () => {
    await seal(deliveryParams());
    await confirm(T0 + HOUR);
    expect(await resolve(DELIVERY_PE, T0 + 90 * 60 * 1000)).toBe('promoted');
    // The window lapsed and the weekly cron registered the incumbent.
    const late = T0 + ATTESTATION_ENHANCEMENT_WINDOW_MS + 1;
    const page = await createFirestoreInletSource({
      db: mockDb as unknown as SettlementDb, now: () => late,
    }).loadPage({ pageSize: 10 });
    expect(page.candidates.map((c) => c.peId)).toEqual([DELIVERY_PE]);
    await registerClaim(mockDb as unknown as SettlementDb, ledgerLeg(DELIVERY_PE), late);
    expect((await mockDb.collection(CLAIM_LEDGER_COLLECTION).doc(claimKeyOf(DELIVERY_PE, 'sole')).get()).exists).toBe(true);

    const release = await seal(releaseParams({ timestamp: late + HOUR }));
    expect(release.mint_status).toBe('corroborated_duplicate');
    expect(claimOwner()).toBe(DELIVERY_PE);
    expect(row(DELIVERY_PE).mint_status).toBe('eligible');
    const eligible = [row(DELIVERY_PE), row(RELEASE_PE)].filter((r) => r.mint_status === 'eligible');
    expect(eligible).toHaveLength(1);
  });

  it('RED: a release that seals TERMINAL (same-owner) never demotes the good off-chain incumbent', async () => {
    await seal(deliveryParams());
    await confirm(T0 + HOUR);
    expect(await resolve(DELIVERY_PE, T0 + 90 * 60 * 1000)).toBe('promoted');
    const release = await seal(releaseParams({ economicSelfReferencing: true }));
    expect(release.mint_status).toBe('record_only');
    expect(claimOwner()).toBe(DELIVERY_PE);
    expect(row(DELIVERY_PE).mint_status).toBe('eligible');
  });

  it('RED: a verdict-less (unverified) watcher row neither claims nor holds the slot', async () => {
    const release = await seal(releaseParams({ economicEvidenceState: undefined }));
    expect(release.mint_status).toBe('pending_evidence');
    expect(release.completion_witness).toBeNull();
    expect(claimOwner()).toBeUndefined();
  });
});

describe('(v) the poster\'s human_job_completed never mints on its own', () => {
  it('a best-effort confirmation (the shape completeHumanJob fires) seals record_only', async () => {
    const r = await seal(deliveryParams({
      peId: CONFIRMATION_PE, peHash: `h_${CONFIRMATION_PE}`, actionType: 'human_job_completed',
      userId: POSTER_WALLET, durableReplaySource: undefined, counterpartyAddress: undefined,
      walletAddress: POSTER_ADDR, ownerType: 'human',
    }));
    expect(r.mint_status).toBe('record_only');
    expect(r.estimatedPVT).toBe(0);
  });

  it('RED: even a FORGED durable confirmation held at pending_evidence is refused by name — corroboration, not an act', async () => {
    // The guard\'s INPUT is widened : the durable marker completeHumanJob
    // never passes is supplied here so the refusal is reachable, not assumed.
    // a completion-family row with NO
    // counterparty now seals `pending_review` (the fence cannot run), so the
    // forged confirmation names the applicant as its counterparty to reach the
    // held population this lock guards.
    const r = await seal(deliveryParams({
      peId: CONFIRMATION_PE, peHash: `h_${CONFIRMATION_PE}`, actionType: 'human_job_completed',
      userId: POSTER_WALLET, counterpartyAddress: DELIVERER_ADDR, walletAddress: POSTER_ADDR, ownerType: 'human',
    }));
    expect(r.mint_status).toBe('pending_evidence');
    const verdict = await judgePendingEvidenceRow(resolverDeps(), held(CONFIRMATION_PE), { nowMs: T0 + HOUR });
    expect(verdict.outcome).toBe('refused_no_verifier_for_class');
    expect(verdict.reason).toMatch(/^completion_confirmation_is_corroboration_not_an_act/);
    expect(await applyPendingEvidenceVerdict(resolverDeps().db, held(CONFIRMATION_PE), verdict, { nowMs: T0 + HOUR }, null))
      .toBe('refused_no_verifier_for_class');
    expect(row(CONFIRMATION_PE).mint_status).toBe('pending_evidence');
  });

  it('RED: the other named refusals in the class — an agent-board delivery and a self-directed goal — mint 0 by name', async () => {
    const jobDelivered = await seal(deliveryParams({
      peId: 'pe_job_delivered', peHash: 'h_jd', actionType: 'job_delivered',
    }));
    expect(jobDelivered.mint_status).toBe('pending_evidence');
    const v1 = await judgePendingEvidenceRow(resolverDeps(), held('pe_job_delivered'), { nowMs: T0 + HOUR });
    expect(v1.outcome).toBe('refused_no_verifier_for_class');
    expect(v1.reason).toMatch(/^completion_agent_job_settles_via_escrow_release/);

    // F-A1-3: `promise_fulfilled` now has a verifier (covered in
    // completion-verifier.promise.test.ts); `goal_envelope_completed` remains a
    // by-name refusal — a Goal Envelope is self-directed (human ↔ own agent), so
    // no distinct counterparty can confirm it.
    const goal = await seal(deliveryParams({
      peId: 'pe_goal', peHash: 'h_goal', actionType: 'goal_envelope_completed',
    }));
    expect(goal.mint_status).toBe('pending_evidence');
    const v2 = await judgePendingEvidenceRow(resolverDeps(), held('pe_goal'), { nowMs: T0 + HOUR });
    expect(v2.outcome).toBe('refused_no_verifier_for_class');
    expect(v2.reason).toMatch(/^goal_envelope_is_self_directed_no_distinct_counterparty/);
  });
});

describe('(vi) the window rule for the lift', () => {
  it('a confirmation INSIDE the 72h window lifts software → corroborated; AFTER it, the row still promotes at the sealed value', async () => {
    const sealed = await seal(deliveryParams());
    await confirm(T0 + ATTESTATION_ENHANCEMENT_WINDOW_MS + 1);
    expect(await resolve(DELIVERY_PE, T0 + ATTESTATION_ENHANCEMENT_WINDOW_MS + 2 * HOUR)).toBe('promoted');
    expect(row(DELIVERY_PE).mint_status).toBe('eligible');
    expect(row(DELIVERY_PE).corroboration_status).toBe('peer_verified'); // the record stands…
    expect(settleable(DELIVERY_PE)).toBe(points(sealed)); // …the value does not move.
  });

  it('the boundary is exact: a confirmation AT the window edge still lifts', async () => {
    const sealed = await seal(deliveryParams());
    await confirm(T0 + ATTESTATION_ENHANCEMENT_WINDOW_MS);
    expect(await resolve(DELIVERY_PE, T0 + ATTESTATION_ENHANCEMENT_WINDOW_MS + HOUR)).toBe('promoted');
    expect(settleable(DELIVERY_PE)).toBe((points(sealed) * LIFT_NUM) / LIFT_DEN);
  });

  it('RED: without the projection passthrough the lift is unreachable — the kernel reads the sealed pending_evidence and refuses', async () => {
    const sealed = await seal(deliveryParams());
    await confirm(T0 + HOUR);
    expect(await resolve(DELIVERY_PE, T0 + 2 * HOUR)).toBe('promoted');
    expect(settleable(DELIVERY_PE)).toBeGreaterThan(points(sealed));
    // Strip the projection the promotion wrote: the same row now settles at the
    // verbatim base, which is what `corroborationLiftedRecordPointsAtomic`
    // returned before economic-projection.ts passed the projection through.
    const stripped = { ...fullRow(DELIVERY_PE), economic_eligibility_projection: null } as PEHistoryDocument;
    expect(BigInt(corroborationLiftedRecordPointsAtomic(stripped))).toBe(points(sealed));
  });
});

// =============================================================================
// on two RED controls, recorded in-suite.
// =============================================================================

/** The backfill's recovered cache: healthy, no limits, exactly-once per PE. */
function recoveredCache(): RedisCache {
  const claims = new Map<string, Record<string, number | boolean>>();
  return {
    isEnabled: () => true,
    getUserDailyPECountStrict: async () => 0,
    getUserActionTypeCountStrict: async () => 0,
    consumeRecoveredPECounterSlot: async (_userId: string, peId: string) => {
      const prior = claims.get(peId);
      if (prior) return { ...prior, idempotent: true };
      const slot = {
        hourlyCountBefore: 0, dailyCountBefore: 0, hourlyCountAfter: 1, dailyCountAfter: 1,
        occurrenceCountBefore: 0, occurrenceCountAfter: 1, idempotent: false,
      };
      claims.set(peId, slot);
      return slot;
    },
  } as unknown as RedisCache;
}
/** Redis is DOWN for the next accrual: the Strict counter read throws → cacheUnavailable. */
function redisDownForNextSeal(): void {
  (mockedCache.getUserDailyPECountStrict as jest.Mock<() => Promise<number>>).mockRejectedValueOnce(new Error('redis_unavailable'));
}
function eligibleRows(): string[] {
  return [DELIVERY_PE, RELEASE_PE].filter((id) => (mockDb.store.get(`pe_history/${id}`) as PeRow | undefined)?.mint_status === 'eligible');
}
async function backfill(nowMs: number) {
  return backfillPendingCachePEs(recoveredCache(), mockDb as unknown as Firestore, { now: () => nowMs });
}

describe('(vii) the completion claim under a Redis outage: ONE job, ONE mint, in BOTH orders', () => {
  beforeEach(async () => {
    await mockDb.collection('escrows').doc(ESCROW).set({
      escrow_id: ESCROW, onchain_escrow_id: ONCHAIN_ESCROW, status: 'completed',
    });
  });

  it('RED (release-first UNDER pending_cache → resolver → backfill): the slot is claimed AT SEAL, the resolver refuses by name, the backfill promotes exactly ONE row', async () => {
    redisDownForNextSeal();
    const release = await seal(releaseParams());
    expect(release.mint_status).toBe('pending_cache');
    expect(release.estimatedPVT).toBe(0);
    // THE SEAL-TIME CLAIM. Before the fix: `undefined` — the claim was skipped
    // under cacheUnavailable, the marker stayed null, and the slot was FREE.
    expect(claimOwner()).toBe(RELEASE_PE);
    expect(release.completion_witness).toBe('onchain_release');
    expect(release.completion_canonical_id).toBe(CANONICAL);

    await seal(deliveryParams());
    await confirm(T0 + HOUR);
    // Before the fix: `promoted` — the off-chain witness took the free slot.
    expect(await resolve(DELIVERY_PE, T0 + 3 * HOUR)).toBe('refused_canonical_event_already_minted');
    expect(row(DELIVERY_PE).mint_status).toBe('pending_evidence');

    const result = await backfill(T0 + 10 * HOUR);
    expect(result.scanned).toBe(1);
    expect(result.reclassified_eligible).toBe(1);
    // Before the fix: TWO eligible rows for one act (the negative control).
    expect(eligibleRows()).toEqual([RELEASE_PE]);
    expect(claimOwner()).toBe(RELEASE_PE);
    expect(settleable(RELEASE_PE)).toBe(points(row(RELEASE_PE)));
  });

  it('RED (resolver-first → release UNDER pending_cache → backfill): the release takes over at seal even during the outage; after recovery exactly ONE eligible row — the on-chain one', async () => {
    await seal(deliveryParams());
    await confirm(T0 + HOUR);
    expect(await resolve(DELIVERY_PE, T0 + 90 * 60 * 1000)).toBe('promoted');
    expect(claimOwner()).toBe(DELIVERY_PE);

    redisDownForNextSeal();
    const release = await seal(releaseParams());
    expect(release.mint_status).toBe('pending_cache');
    // Before the fix: the claim stayed with DELIVERY_PE (no takeover prepared),
    // the incumbent stayed eligible, and the backfill then made the release
    // eligible too — two eligible rows.
    expect(claimOwner()).toBe(RELEASE_PE);
    expect(row(DELIVERY_PE).mint_status).toBe('corroborated_duplicate');
    expect(eligibleRows()).toEqual([]);

    const result = await backfill(T0 + 10 * HOUR);
    expect(result.reclassified_eligible).toBe(1);
    expect(eligibleRows()).toEqual([RELEASE_PE]);
    expect(claimOwner()).toBe(RELEASE_PE);
  });

  it('RED (belt and braces): a pending_cache completion row whose slot ANOTHER PE owns is never promoted by the backfill — corroborated_duplicate, 0', async () => {
    // The pre-fix shape, constructed directly: a release sealed pending_cache
    // with NO claim and NO marker (the legacy row the seal fix cannot reach).
    redisDownForNextSeal();
    await seal(releaseParams());
    mockDb.store.delete(`completion_mint_claims/${completionClaimDocId(DELIVERER, CANONICAL)}`);
    await mockDb.collection('pe_history').doc(RELEASE_PE)
      .update({ completion_canonical_id: null, completion_witness: null });
    expect(claimOwner()).toBeUndefined();

    await seal(deliveryParams());
    await confirm(T0 + HOUR);
    expect(await resolve(DELIVERY_PE, T0 + 3 * HOUR)).toBe('promoted');
    expect(claimOwner()).toBe(DELIVERY_PE);

    const result = await backfill(T0 + 10 * HOUR);
    expect(result.scanned).toBe(1);
    // Before the fix: reclassified_eligible 1 → two eligible rows.
    expect(result.reclassified_eligible).toBe(0);
    expect(row(RELEASE_PE).mint_status).toBe('corroborated_duplicate');
    expect(row(RELEASE_PE).estimatedPVT).toBe(0);
    expect(eligibleRows()).toEqual([DELIVERY_PE]);
    expect(claimOwner()).toBe(DELIVERY_PE);
    // Idempotent: a second run finds nothing pending.
    expect((await backfill(T0 + 11 * HOUR)).scanned).toBe(0);
  });
});

describe('(viii) a poster address that is not an EVM address is UNRESOLVABLE (Unknown = Block), never a distinct owner', () => {
  const NOT_AN_ADDRESS = POSTER_WALLET; // the capture defect: the poster's WALLET ID persisted as poster_address

  async function hideSharedOwnerBehindWalletId(): Promise<void> {
    // The poster's REAL address resolves to the deliverer's own owner — but the
    // records carry the wallet id, so no registry can be asked about it.
    await mockDb.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION)
      .doc(nativeWalletAddressIndexId(POSTER_ADDR))
      .set({
        schema_version: 'native-wallet-address-index/v1',
        chain_id: 8453,
        address: POSTER_ADDR,
        wallet_id: 'w_self',
        owner_type: 'human',
        owner_id: DELIVERER,
        created_at_ms: 1,
      });
  }

  it('RED (RESOLVE time): poster_address = the poster\'s wallet id, shared owner → refused by name and HELD; before the fix it PROMOTED', async () => {
    await seal(deliveryParams());
    await seedJob({ poster_address: NOT_AN_ADDRESS });
    await seedEnvelope(DELIVERY_PE, { counterparty_address: NOT_AN_ADDRESS });
    await confirm(T0 + HOUR);
    await hideSharedOwnerBehindWalletId();
    expect(await resolve(DELIVERY_PE, T0 + 2 * HOUR)).toBe('refused_completion_counterparty_unresolvable');
    expect(row(DELIVERY_PE).mint_status).toBe('pending_evidence');
    expect(row(DELIVERY_PE).estimatedPVT).toBe(0);
    expect(claimOwner()).toBeUndefined();
    expect(mockDb.store.get(`${PENDING_EVIDENCE_RESOLUTION_COLLECTION}/${DELIVERY_PE}`)).toBeUndefined();
  });

  it('RESOLVE time: an ABSENT poster address on both records is the same refusal', async () => {
    await seal(deliveryParams());
    await seedJob({ poster_address: null });
    await seedEnvelope(DELIVERY_PE, { counterparty_address: null });
    await confirm(T0 + HOUR);
    const verdict = await judgePendingEvidenceRow(resolverDeps(), held(DELIVERY_PE), { nowMs: T0 + 2 * HOUR });
    expect(verdict.outcome).toBe('refused_completion_counterparty_unresolvable');
    expect(verdict.reason).toBe('poster_address_unresolved');
    expect(claimOwner()).toBeUndefined();
  });

  it('RESOLVE time: a well-formed poster address with a distinct owner still promotes (the fence is a gate, not a wall)', async () => {
    await seal(deliveryParams());
    await confirm(T0 + HOUR);
    expect(await resolve(DELIVERY_PE, T0 + 2 * HOUR)).toBe('promoted');
  });

  it('RED (RECORD time): a completion-family row whose counterparty is a wallet id seals pending_review — the fence cannot run, so it is not passed', async () => {
    await hideSharedOwnerBehindWalletId();
    const r = await seal(deliveryParams({ counterpartyAddress: NOT_AN_ADDRESS }));
    // Before the fix: `pending_evidence` — `detectSameOwnerTransfer` read the
    // wallet id as "no counterparty" (unresolvable:false) and the row joined the
    // held population a confirmation could promote.
    expect(r.mint_status).toBe('pending_review');
    expect(r.mint_disposition).toBe('pending_review');
    expect(r.disposition_reason_code).toBe('same_owner_unresolvable');
    expect(r.estimatedPVT).toBe(0);
  });

  it('RECORD time: an ABSENT counterparty on a completion-family row seals pending_review too', async () => {
    const r = await seal(deliveryParams({ counterpartyAddress: undefined }));
    expect(r.mint_status).toBe('pending_review');
    expect(r.disposition_reason_code).toBe('same_owner_unresolvable');
  });

  it('RECORD time: the ON-CHAIN witness with a malformed counterparty seals pending_review, and the held row keeps its slot reserved (non-terminal rows reserve)', async () => {
    await mockDb.collection('escrows').doc(ESCROW).set({
      escrow_id: ESCROW, onchain_escrow_id: ONCHAIN_ESCROW, status: 'completed',
    });
    const r = await seal(releaseParams({ counterpartyAddress: 'wallet_aw_poster' }));
    expect(r.mint_status).toBe('pending_review');
    expect(r.estimatedPVT).toBe(0);
    expect(claimOwner()).toBe(RELEASE_PE);
  });

  it('RECORD time: a NON-completion row with no counterparty is untouched by the rule (scope)', async () => {
    const r = await seal(deliveryParams({
      peId: 'pe_other', peHash: 'h_other', actionType: 'agent_work_product_code', counterpartyAddress: undefined,
    }));
    expect(r.mint_status).not.toBe('pending_review');
  });
});
