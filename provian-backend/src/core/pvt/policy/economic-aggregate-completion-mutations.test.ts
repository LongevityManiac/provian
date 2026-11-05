/**
 * M5 × the two COMPLETION-EARNING post-seal mutations hold the
 * accrual-time aggregate invariant (`economic-aggregate.ts` header, item 2:
 * EVERY post-seal mutation of a pe_history economic field applies its
 * (−before, +after) delta through the aggregate primitive, in the SAME
 * transaction as the mutation):
 *
 * 1. the completion-TAKEOVER DEMOTION — the on-chain release displacing the
 * off-chain confirmation witness writes `mint_status:
 * 'corroborated_duplicate'` on the incumbent inside the taker's seal
 * transaction (`writePEHistory` → `applyCompletionTakeoverDecision`). A
 * non-`eligible` row projects ZERO (`projectCurrentSettlementInputAtomic`),
 * so the incumbent's settlement input must LEAVE the aggregate there;
 * 2. the completion PROMOTION — `applyCompletionPromotionInTransaction` flips
 * `pending_evidence → eligible` (+ the lift) in the resolver's transaction.
 * A held row projects ZERO; the promoted row's (lifted) input must ENTER —
 * including when the row was ALREADY FROZEN at 72h before the promotion
 * landed, in which case the FROZEN sums move, not the live tail.
 *
 * Driven through the REAL pipeline against the fake Firestore, exactly as
 * `completion-earning.acceptance.test.ts` drives it (the same harness): the real
 * `recordPEAccrual` seals, the real resolver judges + applies, the real read
 * (`readEconomicAccrualProjection`, frozen + tail) is reconciled against the
 * real reference fold. The frozen membership is produced by the maintenance
 * roll-forward, never by hand-editing a watermark.
 *
 * ── THE TWO REDS, by SOURCE MUTATION — run 2026-09-04, restored
 * byte-identical (sha256 verified before and after) ─────────────────────────
 *
 * RED-DEMOTION — in `src/pe-history.ts`, inside the
 * `for (const decision of completionTakeoverDecisions)` loop, delete the
 * `aggregateWriter.applyMutation(decision.incumbentBefore …,
 * demotedCompletionIncumbentRow(decision, params.timestamp) …)` call (leave
 * `applyCompletionTakeoverDecision` the demotion itself still lands).
 * pe-history.ts sha256 8e68595f… before, a55fcbc3… mutated, 8e68595f… restored.
 * observed: 1 of 6 RED — 'the demoted incumbent's lifted input LEAVES the
 * frozen sum in the taker's seal transaction' fails at its first sum
 * assertion: `frozen_projection_rated_atomic` after the takeover is
 * "1100000000000000000" (the incumbent's lifted 1.1× input, still counted),
 * expected "0". The read-parity assertion sits downstream of that and was
 * not reached. The other 5 cases stay green (the mutation touches only the
 * demotion delta; the promotion cases and the two rollback controls do not
 * exercise it).
 *
 * RED-PROMOTION — in `src/core/pvt/completion-promotion.ts`, delete the
 * `aggregateWriter.applyMutation(before …, after …)` call (leave the `load`
 * and the `commit`; with nothing applied nothing is touched, so the writer
 * writes no document — the exact pre-fix aggregate state).
 * completion-promotion.ts sha256 8223e390… before, d976eca7… mutated,
 * 8223e390… restored.
 * observed: 4 of 6 RED —
 * · 'a promotion of a row ALREADY FROZEN at 72h moves the FROZEN sum' * `frozen_projection_rated_atomic` 0n, expected 1100000000000000000n;
 * · 'late confirmation … at the SEALED value' 0n, expected
 * 800000000000000000n (the unlifted 0.8× base);
 * · 'a promotion INSIDE the window (tail row) writes the aggregate in the
 * same transaction' aggregate version 1, expected 2 — no aggregate write
 * happened in the promotion's transaction;
 * · 'an injected aggregate-write failure rolls the PROMOTION back' * resolved instead of rejected — nothing was written to the aggregate
 * collection, so there was nothing to fail.
 * The two takeover cases stayed GREEN under this mutation, and that is
 * informative rather than a gap: their incumbent is promoted while still in
 * the tail and enters the frozen sum through the maintenance roll-forward,
 * which reads the row's live state — so the demotion delta had a correct
 * input to remove. The frozen-promotion cases are the ones a roll-forward
 * can never rescue, which is exactly why they are the load-bearing ones.
 *
 * The vacuous shapes, checked by name: every case asserts the evaluated
 * population (`total_pes`, `frozen_pes`) before asserting a sum; the expected
 * values are read off the ROW through the live pricing function
 * (`corroborationLiftedRecordPointsAtomic`), never declared as literals the
 * code under test also declares; and the RED controls above prove each
 * assertion can fail.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { createFakeFirestore, type FakeFirestore } from '../__test-helpers__/fake-firestore';
import type { BeneficiaryCacheEntry } from '../beneficiary';
import { ORDINARY_ACCRUAL_REPLAY_SOURCE } from '../wp11/ordinary-accrual-intake';

let mockDb: FakeFirestore;
jest.mock('firebase-admin', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createFakeFirestore: mk } = require('../__test-helpers__/fake-firestore');
  const db = mk();
  mockDb = db;
  const firestore = Object.assign(() => db, {
    FieldValue: { increment: (n: number) => ({ __increment: n }) },
  });
  return { __esModule: true, default: { firestore }, firestore };
});
jest.mock('../../../cache', () => ({
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
jest.mock('../beneficiary', () => ({ resolveBeneficiary: mockResolveBeneficiary }));
jest.mock('../../jurisdiction/jurisdiction-policy', () => ({ getJurisdictionPolicy: async () => 'immediate' }));
jest.mock('../delegation-pe', () => ({ isDelegationQualifying: () => false, createDelegationPE: async () => {} }));
jest.mock('../../provenance/pe-type-catalog', () => ({
  getCategoryForActionType: async () => 'institutional',
  recordActionTypeObservation: async () => {},
}));
jest.mock('../../foundation-membership/client', () => ({
  loadFoundationMembershipConfig: () => ({ enabled: false }),
  queueInitialMembershipGrants: async () => {},
}));
/**
 * The lineage-optional policy for the FIVE completion types, over the REAL
 * materialized template — the same supply the acceptance suite makes and for
 * the same reason (its header). Everything else is the live template verbatim.
 */
jest.mock('./runtime-monetary-policy', () => {
  const actual = jest.requireActual('./runtime-monetary-policy') as
    typeof import('./runtime-monetary-policy');
  const base = actual.materializeProposedMonetaryPolicy(0);
  const actions: Record<string, unknown> = { ...base.actions };
  for (const t of ['promise_fulfilled', 'job_delivered', 'human_job_delivered', 'goal_envelope_completed', 'human_job_completed']) {
    actions[t] = Object.freeze({ ...base.actions[t], sessionLineagePolicy: 'optional' });
  }
  const policy = Object.freeze({ ...base, actions: Object.freeze(actions) });
  return { ...actual, loadRuntimeMonetaryPolicy: async () => policy };
});

// eslint-disable-next-line import/first
import { recordPEAccrual, type RecordPEAccrualParams } from '../../../pvt-accrual';
// eslint-disable-next-line import/first
import {
  ORDINARY_ACCRUAL_INTAKE_COLLECTION,
  buildOrdinaryAccrualIntake,
} from '../wp11/ordinary-accrual-intake';
// eslint-disable-next-line import/first
import type { PEHistoryDocument } from '../../../pe-history';
// eslint-disable-next-line import/first
import {
  PENDING_EVIDENCE_RESOLUTION_COLLECTION,
  applyPendingEvidenceVerdict,
  hashResolutionEvidence,
  judgePendingEvidenceRow,
  type HeldPendingEvidenceRow,
  type PendingEvidenceResolverDeps,
} from '../pending-evidence-resolver';
// eslint-disable-next-line import/first
import { completionCanonicalIdForEscrow, completionClaimDocId } from '../completion-claim';
// eslint-disable-next-line import/first
import { PVT9_ELIGIBILITY_CUT_LINE_MS } from '../wp-ev/eligibility';
// eslint-disable-next-line import/first
import { ATTESTATION_ENHANCEMENT_WINDOW_MS, disclosedRationalFactor } from './monetary-accounting';
// eslint-disable-next-line import/first
import { GENESIS_PREV_HASH } from '../../pe/constants';
// eslint-disable-next-line import/first
import {
  ECONOMIC_AGGREGATE_COLLECTION,
  FROZEN_CONTRIBUTION_WINDOW_MS,
  isAggregateMarked,
  parseAggregateDocument,
  type RoleAggregate,
} from './economic-aggregate';
// eslint-disable-next-line import/first
import { readEconomicAccrualProjection } from './economic-aggregate-read';
// eslint-disable-next-line import/first
import { rollForwardFrozenAggregate } from './economic-aggregate-maintenance';
// eslint-disable-next-line import/first
import { seedActKeys } from '../../meter/__test-helpers__/seed-act-keys';
// eslint-disable-next-line import/first
import {
  corroborationLiftedRecordPointsAtomic,
  foldEconomicAccrualRows,
  type CurrentSettlementProjectionContext,
  type EconomicAccrualProjection,
} from './economic-projection';
// eslint-disable-next-line import/first
import type { Firestore } from 'firebase-admin/firestore';

/** Post cut-line, so the eligibility evaluator's fence admits the rows. */
const T0 = PVT9_ELIGIBILITY_CUT_LINE_MS + 10 * 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
/** A read clock at which a row sealed at T0 is PAST the frozen window. */
const PAST_WINDOW = T0 + FROZEN_CONTRIBUTION_WINDOW_MS + 2 * HOUR;
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

/**
 * The seal path stamps its aggregate writer with `Date.now()` (the week-bucket
 * prune and the projection clock). Pin the wall clock to the scenario's clock
 * so parity between the read and the fold is about the mutations under test,
 * never about the test machine's date.
 */
let clock = T0;
let dateNowSpy: ReturnType<typeof jest.spyOn> | null = null;

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
function fullRow(peId: string): PEHistoryDocument {
  const r = mockDb.store.get(`pe_history/${peId}`);
  if (!r) throw new Error(`no pe_history row for ${peId}`);
  return r as unknown as PEHistoryDocument;
}
/** The row's OWN settleable input, priced by the live function — the expected delta. */
function liftedInput(peId: string): bigint {
  return BigInt(corroborationLiftedRecordPointsAtomic(fullRow(peId)));
}
async function seal(params: RecordPEAccrualParams): Promise<PEHistoryDocument> {
  clock = Math.max(clock, params.timestamp);
  commitIntake(params);
  await recordPEAccrual(params);
  return fullRow(params.peId);
}
function claimOwner(): string | undefined {
  const claim = mockDb.store.get(`completion_mint_claims/${completionClaimDocId(DELIVERER, CANONICAL)}`);
  return claim ? (claim.owner_pe_id as string) : undefined;
}
async function seedEnvelope(peId: string, over: Record<string, unknown> = {}): Promise<void> {
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
async function seedJob(): Promise<void> {
  await mockDb.collection('commons_human_jobs').doc(JOB).set({
    job_id: JOB,
    poster_wallet_id: POSTER_WALLET,
    poster_address: POSTER_ADDR,
    accepted_applicant_wallet_id: DELIVERER_WALLET,
    completion_pe_id: DELIVERY_PE,
    status: 'in_progress',
    escrow_id: ESCROW,
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
async function seedDelivererWallet(): Promise<void> {
  await mockDb.collection('agent_wallets').doc(DELIVERER_WALLET).set({
    id: DELIVERER_WALLET, agent_id: DELIVERER, address: DELIVERER_ADDR, status: 'active',
  });
}
function held(peId: string): HeldPendingEvidenceRow {
  return mockDb.store.get(`pe_history/${peId}`) as unknown as HeldPendingEvidenceRow;
}
function resolverDeps(db: FakeFirestore = mockDb): PendingEvidenceResolverDeps {
  return {
    db: db as unknown as PendingEvidenceResolverDeps['db'],
    verifyChainReceipt: async () => ({ ok: false, reason: 'not_used_here' }),
    resolveActorAddress: async () => null,
  };
}
/** One resolver pass over ONE row: judge + apply, exactly as the sweep does. */
async function resolve(peId: string, nowMs: number, db: FakeFirestore = mockDb): Promise<string> {
  clock = Math.max(clock, nowMs);
  const deps = resolverDeps(db);
  const verdict = await judgePendingEvidenceRow(deps, held(peId), { nowMs });
  const evidenceHash = verdict.evidence ? hashResolutionEvidence(verdict.evidence) : null;
  return applyPendingEvidenceVerdict(deps.db, held(peId), verdict, { nowMs }, evidenceHash);
}

const DB = (): Firestore => mockDb as unknown as Firestore;
function context(nowMs: number): CurrentSettlementProjectionContext {
  return { projectedAtMs: nowMs, globalMintRate: disclosedRationalFactor(1n, 1n, 'test', 'block:1') };
}
function contributorAggregate(): RoleAggregate {
  const raw = mockDb.store.get(`${ECONOMIC_AGGREGATE_COLLECTION}/${DELIVERER}`);
  const parsed = raw ? parseAggregateDocument(DELIVERER, raw) : null;
  if (!parsed) throw new Error('no aggregate for the deliverer');
  return parsed.roles.contributor;
}
function aggregateVersion(): number {
  return (mockDb.store.get(`${ECONOMIC_AGGREGATE_COLLECTION}/${DELIVERER}`)?.version as number) ?? 0;
}
const PARITY_FIELDS: ReadonlyArray<keyof EconomicAccrualProjection> = [
  'totalRecordPointsAtomic',
  'totalCurrentSettlementProjectionAtomic',
  'currentSettlementProjectionByCategoryAtomic',
  'totalPEs',
  'pesByCategory',
  'integrityFailures',
  'projectionFailures',
];
function pick(p: EconomicAccrualProjection): Record<string, unknown> {
  return Object.fromEntries(PARITY_FIELDS.map((f) => [f, p[f]]));
}
/**
 * The real read beside the pure reference fold. PE METER: the read no longer rolls the watermark
 * forward or reads `pe_history`; these legacy rows' roll-forward is the maintenance module's
 * (`rollForwardFrozenAggregate`, exactly what the pre-meter read called), and the read's live tail
 * comes from act keys — so each row's CURRENT state is mirrored into its act key first, as the
 * meter keeps it, and the REAL read composes frozen + tail from those.
 */
async function readAndFold(nowMs: number): Promise<{
  read: EconomicAccrualProjection; fold: EconomicAccrualProjection; rolledForward: string[];
}> {
  clock = Math.max(clock, nowMs);
  const before = mockDb.store.has(`${ECONOMIC_AGGREGATE_COLLECTION}/${DELIVERER}`)
    ? contributorAggregate().frozen_through_ms
    : null;
  const rolled = await rollForwardFrozenAggregate(DB(), DELIVERER, 'contributor', {
    cutoffMs: nowMs - FROZEN_CONTRIBUTION_WINDOW_MS, nowMs,
  });
  // A separate read view: the money path under test keeps reading its legacy rows from
  // `mockDb` (an act key there would become the row's home), while the read sees the
  // aggregates plus each row's current state as an act key.
  const view = createFakeFirestore();
  const rows: Array<{ row: PEHistoryDocument; role: 'contributor' | 'beneficiary' }> = [];
  for (const [key, value] of [...mockDb.store.entries()]) {
    if (!key.startsWith('pe_history/')) {
      view.store.set(key, value);
      continue;
    }
    seedActKeys(view, [value]);
    const pe = value as unknown as PEHistoryDocument;
    if (!isAggregateMarked(pe)) continue;
    if (pe.userId === DELIVERER) rows.push({ row: pe, role: 'contributor' });
    if (pe.beneficiary_wallet_id === DELIVERER) rows.push({ row: pe, role: 'beneficiary' });
  }
  const read = await readEconomicAccrualProjection(view as unknown as Firestore, DELIVERER, {
    nowMs, settlementProjection: context(nowMs),
  });
  const fold = foldEconomicAccrualRows(rows, { nowMs, settlementProjection: context(nowMs) });
  const moved = rolled.rowsFrozen > 0 || rolled.frozenThroughMs !== before;
  return { read, fold, rolledForward: moved ? [`${DELIVERER}:contributor`] : [] };
}
/** Freeze the delivery row through the maintenance roll-forward, and prove it froze. */
async function freezeDeliveryRow(): Promise<RoleAggregate> {
  const { read, fold, rolledForward } = await readAndFold(PAST_WINDOW);
  expect(rolledForward).toContain(`${DELIVERER}:contributor`);
  expect(pick(read)).toEqual(pick(fold));
  const agg = contributorAggregate();
  expect(agg.frozen_through_ms).toBe(PAST_WINDOW - FROZEN_CONTRIBUTION_WINDOW_MS);
  expect(agg.frozen_through_ms).toBeGreaterThanOrEqual(fullRow(DELIVERY_PE).timestamp);
  expect(agg.frozen_pes).toBe(1);
  expect(agg.total_pes).toBe(1);
  return agg;
}

beforeEach(async () => {
  jest.clearAllMocks();
  mockDb.store.clear();
  mockDb.ops.length = 0;
  clock = T0;
  dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => clock);
  await seedJob();
  await seedEnvelope(DELIVERY_PE);
  await seedDelivererWallet();
  // The relay escrow the on-chain id is pinned on — the same one the job carries.
  await mockDb.collection('escrows').doc(ESCROW).set({
    escrow_id: ESCROW, onchain_escrow_id: ONCHAIN_ESCROW, status: 'completed',
  });
});
afterEach(() => {
  dateNowSpy?.mockRestore();
  dateNowSpy = null;
});

describe('the completion PROMOTION applies its aggregate delta in the resolver\'s transaction', () => {
  it('a promotion of a row ALREADY FROZEN at 72h moves the FROZEN sum by exactly the row\'s lifted input', async () => {
    const sealed = await seal(deliveryParams());
    expect(sealed.mint_status).toBe('pending_evidence');
    expect(isAggregateMarked(sealed)).toBe(true);
    // Confirmed INSIDE the window (so the lift applies) …
    await confirm(T0 + HOUR);
    // … but the sweep only reaches the row after it froze: a held row froze at ZERO input.
    const frozenHeld = await freezeDeliveryRow();
    expect(frozenHeld.frozen_projection_rated_atomic).toBe('0');
    expect(frozenHeld.frozen_projection_fixed_atomic).toBe('0');
    const versionBefore = aggregateVersion();

    expect(await resolve(DELIVERY_PE, PAST_WINDOW + HOUR)).toBe('promoted');
    expect(fullRow(DELIVERY_PE).mint_status).toBe('eligible');
    expect(fullRow(DELIVERY_PE).corroboration_status).toBe('peer_verified');

    // THE DELTA, in the frozen part: the row's OWN lifted input, priced by the
    // live function off the row as promoted — greater than the sealed base.
    const expected = liftedInput(DELIVERY_PE);
    expect(expected).toBeGreaterThan(BigInt(sealed.economic_snapshot!.recordPointsAtomic));
    const after = contributorAggregate();
    expect(after.frozen_pes).toBe(1); // still ONE frozen row — it moved, it was not double-counted
    expect(after.total_pes).toBe(1);
    expect(after.frozen_projection_failures).toBe(0);
    expect(BigInt(after.frozen_projection_rated_atomic)).toBe(expected);
    expect(after.frozen_projection_rated_by_category_atomic).toEqual({
      [fullRow(DELIVERY_PE).category as string]: expected.toString(),
    });
    expect(after.frozen_projection_fixed_atomic).toBe('0');
    expect(after.record_points_atomic).toBe(frozenHeld.record_points_atomic); // sealed points never move
    expect(aggregateVersion()).toBe(versionBefore + 1);

    // THE SAME TRANSACTION: the row flip, the aggregate write and the sweep's
    // resolution record committed together (all txn.* ops, no gap between them).
    const ops = mockDb.ops;
    const flip = ops.lastIndexOf(`txn.update:pe_history/${DELIVERY_PE}`);
    const aggregateWrite = ops.lastIndexOf(`txn.set:${ECONOMIC_AGGREGATE_COLLECTION}/${DELIVERER}`);
    const resolution = ops.lastIndexOf(`txn.set:${PENDING_EVIDENCE_RESOLUTION_COLLECTION}/${DELIVERY_PE}`);
    expect(flip).toBeGreaterThan(-1);
    expect(aggregateWrite).toBeGreaterThan(flip);
    expect(resolution).toBeGreaterThan(aggregateWrite);
    expect(ops.slice(flip, resolution + 1).every((op) => op.startsWith('txn.'))).toBe(true);

    // THE READ: frozen (this row) + tail (nothing) == the fold, and it is the lifted value — not 0.
    const { read, fold } = await readAndFold(PAST_WINDOW + 2 * HOUR);
    expect(read.totalPEs).toBe(1);
    expect(read.totalCurrentSettlementProjectionAtomic).toBe(expected.toString());
    expect(pick(read)).toEqual(pick(fold));
  });

  it('late confirmation (after 72h) on an already-frozen row enters at the SEALED value — the delta follows the kernel\'s window rule', async () => {
    const sealed = await seal(deliveryParams());
    const frozenHeld = await freezeDeliveryRow();
    expect(frozenHeld.frozen_projection_rated_atomic).toBe('0');
    await confirm(PAST_WINDOW + HOUR);

    expect(await resolve(DELIVERY_PE, PAST_WINDOW + 2 * HOUR)).toBe('promoted');

    const expected = liftedInput(DELIVERY_PE);
    expect(expected).toBe(BigInt(sealed.economic_snapshot!.recordPointsAtomic)); // no lift: the value does not move
    const after = contributorAggregate();
    expect(after.frozen_pes).toBe(1);
    expect(BigInt(after.frozen_projection_rated_atomic)).toBe(expected);
    const { read, fold } = await readAndFold(PAST_WINDOW + 3 * HOUR);
    expect(read.totalCurrentSettlementProjectionAtomic).toBe(expected.toString());
    expect(pick(read)).toEqual(pick(fold));
  });

  it('a promotion INSIDE the window (tail row) writes the aggregate in the same transaction and the read stays at parity', async () => {
    await seal(deliveryParams());
    await confirm(T0 + HOUR);
    const versionBefore = aggregateVersion();
    expect(versionBefore).toBeGreaterThan(0); // the seal created it

    expect(await resolve(DELIVERY_PE, T0 + 2 * HOUR)).toBe('promoted');

    // A tail row is folded live, so the stored sums do not move — but the
    // writer still ran inside the promotion's transaction (version + 1), which
    // is what makes the frozen case above the same code path, not a special one.
    expect(aggregateVersion()).toBe(versionBefore + 1);
    const agg = contributorAggregate();
    expect(agg.total_pes).toBe(1);
    expect(agg.frozen_pes).toBe(0);
    const expected = liftedInput(DELIVERY_PE);
    const { read, fold } = await readAndFold(T0 + 3 * HOUR);
    expect(read.totalPEs).toBe(1);
    expect(read.totalCurrentSettlementProjectionAtomic).toBe(expected.toString());
    expect(pick(read)).toEqual(pick(fold));
  });

  it('RED: an injected aggregate-write failure rolls the PROMOTION back — row still held, no claim, no resolution record', async () => {
    await seal(deliveryParams());
    await confirm(T0 + HOUR);
    await freezeDeliveryRow();
    const versionBefore = aggregateVersion();
    // The resolver takes its db by parameter: wrap ONLY the transaction so a
    // write to the aggregate collection throws inside the callback (rollback).
    const failing: FakeFirestore = {
      ...mockDb,
      runTransaction: <T>(fn: (txn: Parameters<Parameters<FakeFirestore['runTransaction']>[0]>[0]) => Promise<T>): Promise<T> =>
        mockDb.runTransaction((txn) => fn({
          ...txn,
          set: (ref, data, opts) => {
            if (ref.collectionPath === ECONOMIC_AGGREGATE_COLLECTION) {
              throw new Error('Injected aggregate write failure');
            }
            txn.set(ref, data, opts);
          },
        })),
    };
    await expect(resolve(DELIVERY_PE, PAST_WINDOW + HOUR, failing)).rejects.toThrow('Injected aggregate write failure');
    expect(fullRow(DELIVERY_PE).mint_status).toBe('pending_evidence');
    expect(claimOwner()).toBeUndefined();
    expect(mockDb.store.has(`${PENDING_EVIDENCE_RESOLUTION_COLLECTION}/${DELIVERY_PE}`)).toBe(false);
    expect(aggregateVersion()).toBe(versionBefore);
    expect(contributorAggregate().frozen_projection_rated_atomic).toBe('0');
    // And the same row promotes cleanly afterwards — nothing was half-applied.
    expect(await resolve(DELIVERY_PE, PAST_WINDOW + 2 * HOUR)).toBe('promoted');
    expect(BigInt(contributorAggregate().frozen_projection_rated_atomic)).toBe(liftedInput(DELIVERY_PE));
  });
});

describe('the completion-TAKEOVER DEMOTION applies its aggregate delta in the taker\'s seal transaction', () => {
  it('the demoted incumbent\'s lifted input LEAVES the frozen sum in the taker\'s seal transaction; the taker enters the tail', async () => {
    // The off-chain witness: sealed, confirmed inside the window, promoted (lifted).
    await seal(deliveryParams());
    await confirm(T0 + HOUR);
    expect(await resolve(DELIVERY_PE, T0 + 90 * 60 * 1000)).toBe('promoted');
    expect(claimOwner()).toBe(DELIVERY_PE);
    // It froze at its LIFTED input — the state a real incumbent is in when the
    // weekly cron has not yet registered it (still eligible, unregistered).
    const incumbentInput = liftedInput(DELIVERY_PE);
    const frozenEligible = await freezeDeliveryRow();
    expect(BigInt(frozenEligible.frozen_projection_rated_atomic)).toBe(incumbentInput);
    expect(incumbentInput).toBeGreaterThan(0n);
    const versionBefore = aggregateVersion();

    // The on-chain release lands late and TAKES OVER the slot.
    const release = await seal(releaseParams({ timestamp: PAST_WINDOW + HOUR }));
    expect(release.mint_status).toBe('eligible');
    expect(claimOwner()).toBe(RELEASE_PE);
    const demoted = fullRow(DELIVERY_PE);
    expect(demoted.mint_status).toBe('corroborated_duplicate');
    expect((demoted as unknown as Record<string, unknown>).completion_takeover_demoted_by_pe_id).toBe(RELEASE_PE);

    // THE DELTA: the incumbent's input left the FROZEN sum (it is still a
    // frozen ROW — counted, worth zero); the taker was applied as a tail row.
    const after = contributorAggregate();
    expect(after.frozen_pes).toBe(1);
    expect(after.total_pes).toBe(2);
    expect(after.frozen_projection_rated_atomic).toBe('0');
    expect(after.frozen_projection_rated_by_category_atomic).toEqual({});
    expect(after.frozen_projection_failures).toBe(0);
    // Record points are sealed and never move on a demotion: both rows' points stay counted.
    expect(BigInt(after.record_points_atomic)).toBe(
      BigInt(frozenEligible.record_points_atomic) + BigInt(release.economic_snapshot!.recordPointsAtomic),
    );
    expect(aggregateVersion()).toBe(versionBefore + 1); // ONE write: the seal transaction's

    // THE SAME TRANSACTION as the demotion and the taker's row.
    const ops = mockDb.ops;
    const demotion = ops.lastIndexOf(`txn.update:pe_history/${DELIVERY_PE}`);
    const takerSeal = ops.lastIndexOf(`txn.set:pe_history/${RELEASE_PE}`);
    const aggregateWrite = ops.lastIndexOf(`txn.set:${ECONOMIC_AGGREGATE_COLLECTION}/${DELIVERER}`);
    expect(demotion).toBeGreaterThan(-1);
    expect(takerSeal).toBeGreaterThan(demotion);
    expect(aggregateWrite).toBeGreaterThan(takerSeal);
    expect(ops.slice(demotion, aggregateWrite + 1).every((op) => op.startsWith('txn.'))).toBe(true);

    // THE READ: frozen (the demoted row, 0) + tail (the release) == the fold ==
    // the ON-CHAIN value alone — never the off-chain value, never the sum.
    const releaseInput = liftedInput(RELEASE_PE);
    const { read, fold } = await readAndFold(PAST_WINDOW + 2 * HOUR);
    expect(read.totalPEs).toBe(2);
    expect(read.totalCurrentSettlementProjectionAtomic).toBe(releaseInput.toString());
    expect(fold.totalCurrentSettlementProjectionAtomic).toBe(releaseInput.toString());
    expect(pick(read)).toEqual(pick(fold));
  });

  it('RED: an injected aggregate-write failure rolls the TAKEOVER back — no taker row, incumbent still eligible and still the owner', async () => {
    await seal(deliveryParams());
    await confirm(T0 + HOUR);
    expect(await resolve(DELIVERY_PE, T0 + 90 * 60 * 1000)).toBe('promoted');
    const frozenEligible = await freezeDeliveryRow();
    const versionBefore = aggregateVersion();
    // `recordPEAccrual` reaches the fake through `admin.firestore()`, which
    // returns this very object — so the fault is injected on it and restored.
    const realRunTransaction = mockDb.runTransaction;
    mockDb.runTransaction = <T>(fn: (txn: Parameters<Parameters<FakeFirestore['runTransaction']>[0]>[0]) => Promise<T>): Promise<T> =>
      realRunTransaction((txn) => fn({
        ...txn,
        set: (ref, data, opts) => {
          if (ref.collectionPath === ECONOMIC_AGGREGATE_COLLECTION) {
            throw new Error('Injected aggregate write failure');
          }
          txn.set(ref, data, opts);
        },
      }));
    const params = releaseParams({ timestamp: PAST_WINDOW + HOUR });
    try {
      // `recordPEAccrual` is non-blocking for an ordinary caller (it logs the
      // rolled-back transaction and returns; `throwOnError` would make it a
      // durable caller the ordinary intake rejects) — so the rollback is
      // asserted by STATE: no taker row, and nothing else moved.
      clock = params.timestamp;
      commitIntake(params);
      await recordPEAccrual(params);
    } finally {
      mockDb.runTransaction = realRunTransaction;
    }
    expect(mockDb.store.has(`pe_history/${RELEASE_PE}`)).toBe(false);
    expect(fullRow(DELIVERY_PE).mint_status).toBe('eligible');
    expect(claimOwner()).toBe(DELIVERY_PE);
    expect(aggregateVersion()).toBe(versionBefore);
    expect(contributorAggregate().frozen_projection_rated_atomic).toBe(frozenEligible.frozen_projection_rated_atomic);
  });
});
