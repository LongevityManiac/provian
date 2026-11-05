/**
 * The accrual-time aggregate's PRE-METER maintenance (M5 close-out): seal
 * atomicity, roll-forward, backfill idempotence, and drift detection by sweep,
 * over legacy `pe_history` rows.
 *
 * PE METER: the dashboard READ no longer touches `pe_history` (no backfill or
 * count() drift check on read, no fold fall-back) — its parity with the pure
 * reference fold is pinned in `economic-aggregate-read.meter.test.ts`. The
 * read-side controls that lived here (drift caught ON READ; frozen + tail ==
 * the Firestore fold) went with the behaviour they pinned.
 *
 * THE RED CONTROLS, each permanent and in-suite:
 * 2. a mutating recovery that SKIPS the delta is detected — a frozen row's
 * points are lowered behind the aggregate's back; the reference
 * comparison names the field;
 * 3. a deliberately CORRUPTED aggregate is caught by drift detection and
 * repaired under CAS;
 *
 * Every snapshot is produced by the REAL kernel; every constant is IMPORTED.
 */

import type { Firestore } from 'firebase-admin/firestore';

jest.mock('../../jurisdiction/jurisdiction-policy', () => ({
  getJurisdictionPolicy: async () => 'immediate',
}));

import type { PEHistoryDocument } from '../../../pe-history';
import { writePEHistory } from '../../../pe-history';
import { PE_BUG_SIGNAL_COLLECTION } from '../../meter/diagnostic-signals';
import { SINGLE_PE_PUSH_THRESHOLD_ENV } from '../../meter/diagnostic-thresholds';
import { createFakeFirestore, type FakeFirestore } from '../__test-helpers__/fake-firestore';
import { WEEK_MS } from '../week-start';
import {
  computeRecordSnapshot,
  disclosedRationalFactor,
  hashRecordEconomicSnapshot,
  type RecordEconomicSnapshot,
} from './monetary-accounting';
import { materializeProposedMonetaryPolicy } from './runtime-monetary-policy';
import { createArmedGenesisPolicyForTest } from '../__test-helpers__/armed-genesis-policy';
import {
  createEmptyGenesisLedgerState,
  hashGenesisCampaignPolicyManifest,
  reserveGenesisCampaignGrant,
  type GenesisReservationLedgerEntry,
} from './genesis-policy-engine';
import { genesisBountyFor } from '../genesis-award-state-machine';
import {
  ECONOMIC_AGGREGATE_COLLECTION,
  ECONOMIC_AGGREGATE_SCHEMA_VERSION,
  FROZEN_CONTRIBUTION_WINDOW_MS,
  PE_HISTORY_AGGREGATE_MARKER_FIELD,
  isAggregateMarked,
  mutatePeHistoryRowWithAggregate,
  parseAggregateDocument,
} from './economic-aggregate';
import {
  backfillIdentityAggregate,
  detectIdentityAggregateDrift,
  rollForwardFrozenAggregate,
} from './economic-aggregate-maintenance';
import {
  foldEconomicAccrualRows,
  type CurrentSettlementProjectionContext,
  type EconomicAccrualProjection,
} from './economic-projection';

const UNIT = 10n ** 18n;
const NOW = Date.UTC(2026, 7, 20, 12, 0, 0);
const DAY = WEEK_MS / 7;
/** the frozen watermark is the 30-day corroboration horizon; "old" rows sit past it. */
const OLD = FROZEN_CONTRIBUTION_WINDOW_MS;
const POLICY = materializeProposedMonetaryPolicy(0);

function db(fake: FakeFirestore): Firestore {
  return fake as unknown as Firestore;
}

function snapshot(peId: string, actionType: string, recordedAtMs: number, actor: string): RecordEconomicSnapshot {
  return computeRecordSnapshot(POLICY, {
    peId,
    economicActorId: actor,
    actionType,
    recordedAtMs,
    occurrenceOrdinal: 1,
    dailyOrdinal: 1,
    exactDuplicate: false,
    uniqueArtifact: false,
    attestationTier: 'software',
    linkageState: 'unlinked',
    evidenceState: 'verified',
    canonicalEventId: null,
    selfReferencing: false,
    sharedBeneficialOwnership: false,
    pairChurnDetected: false,
    sessionLineageId: null,
    genesisReservation: null,
  });
}

interface RowSpec {
  peId: string;
  ageMs: number;
  actionType?: string;
  userId?: string;
  beneficiary?: string | null;
  mintStatus?: PEHistoryDocument['mint_status'];
  marked?: boolean;
  category?: string;
  genesisFixedAtomic?: bigint;
}

/**
 * A REAL Genesis reservation, issued by the reservation kernel against the
 * armed test manifest — never a hand-edited snapshot, which the settlement
 * kernel rightly refuses. Its `reserved_at_ms` (the window start) is what the
 * row's timestamp must be; it sits well past the frozen window from NOW.
 */
function genesisReservationFor(peId: string, walletId: string): GenesisReservationLedgerEntry {
  const manifest = createArmedGenesisPolicyForTest();
  const now = manifest.window.start_ms;
  const anchor = { anchor_kind: 'agent_id', anchor_id: walletId };
  const result = reserveGenesisCampaignGrant({
    manifest,
    activation: {
      approval_status: 'approved_by_frank',
      approval_manifest_sha256: `sha256:${'c'.repeat(64)}`,
      approval_signature: {
        scheme: 'sshsig-ed25519',
        signer_identity: 'frank',
        namespace: 'provian-pvt-policy',
        public_key_sha256: `sha256:${'e'.repeat(64)}`,
        armored_signature: 'test-only-structured-signature',
      },
      frank_approval_audit_id: 'frank-test-approval',
      approved_policy_version: manifest.policy_version,
      approved_policy_manifest_hash: hashGenesisCampaignPolicyManifest(manifest),
      approved_monetary_policy_template_hash: `sha256:${'d'.repeat(64)}`,
      effective_at_ms: now,
      admission_closed_at_ms: null,
      admission_close_audit_id: null,
      grants_enabled: true,
      genesis_kill_switch_active: false,
      canonical_pvt_manifest_id: 'pvt9-test-manifest',
      ledger_namespace: 'aggregate-read-test-ledger',
      prior_reservations_reconciled: true,
      operator_activation_audit_id: 'operator-test-activation',
    },
    state: createEmptyGenesisLedgerState('aggregate-read-test-ledger'),
    input: {
      pe_id: peId,
      action_type: 'genesis_signup',
      wallet_id: walletId,
      economic_actor_id: walletId,
      immutable_anchor: anchor,
      qualifying_act_evidence: {
        verification_status: 'verified',
        evidence_id: 'agent-signup-proof',
        evidence_hash: `sha256:${'a'.repeat(64)}`,
        subject_wallet_id: walletId,
        canonical_bounty_key: 'genesis_signup',
        qualifying_act: genesisBountyFor('genesis_signup').qualifying_act,
        immutable_anchor_kind: anchor.anchor_kind,
        immutable_anchor_id: anchor.anchor_id,
        qualifying_act_at_ms: now,
      },
    },
    observation_context: {
      verification_status: 'verified',
      observed_at_ms: now,
      wallet_created: {
        wallet_id: walletId,
        created_at_ms: now,
        evidence_id: 'agent-authoritative-wallet-record',
        evidence_hash: `sha256:${'b'.repeat(64)}`,
        source: 'authoritative_wallet_record',
      },
    },
    activation_approval_verifier: () => true,
  });
  if (!result.allowed) throw new Error(result.reason);
  return result.reservation;
}

function genesisSnapshot(peId: string, walletId: string): RecordEconomicSnapshot {
  const reservation = genesisReservationFor(peId, walletId);
  return computeRecordSnapshot(POLICY, {
    peId,
    economicActorId: walletId,
    actionType: 'genesis_signup',
    recordedAtMs: reservation.reserved_at_ms,
    occurrenceOrdinal: 1,
    dailyOrdinal: 1,
    exactDuplicate: false,
    uniqueArtifact: false,
    attestationTier: 'software',
    linkageState: 'unlinked',
    evidenceState: 'verified',
    canonicalEventId: reservation.reservation_id,
    selfReferencing: false,
    sharedBeneficialOwnership: false,
    pairChurnDetected: false,
    sessionLineageId: null,
    genesisReservation: reservation,
  });
}

function row(spec: RowSpec): PEHistoryDocument {
  const userId = spec.userId ?? 'user-1';
  const s = spec.genesisFixedAtomic !== undefined
    ? genesisSnapshot(spec.peId, userId)
    : snapshot(spec.peId, spec.actionType ?? 'wallet_created', NOW - spec.ageMs, userId);
  if (spec.genesisFixedAtomic !== undefined && s.recordPointsAtomic !== spec.genesisFixedAtomic.toString()) {
    throw new Error(`genesis fixture expected ${spec.genesisFixedAtomic} got ${s.recordPointsAtomic}`);
  }
  const ts = s.recordedAtMs;
  return {
    peId: spec.peId,
    userId,
    actionType: s.actionType,
    timestamp: ts,
    category: spec.category ?? 'wallet',
    mint_status: spec.mintStatus ?? (s.mintDisposition === 'eligible' ? 'eligible' : 'record_only'),
    mint_disposition: s.mintDisposition,
    attestationDepth: 'software',
    corroboration_status: 'none',
    corroboration_received_at: null,
    economic_snapshot: s,
    economic_snapshot_hash: hashRecordEconomicSnapshot(s),
    record_points_atomic: s.recordPointsAtomic,
    beneficiary_wallet_id: spec.beneficiary ?? null,
    // Rows seeded straight into the store are PRE-EXISTING rows: unmarked, the
    // backfill's to fold. `marked: true` is reserved for the defect the RED-1
    // control constructs (a marked row whose aggregate write never happened).
    ...(spec.marked === true ? { [PE_HISTORY_AGGREGATE_MARKER_FIELD]: ECONOMIC_AGGREGATE_SCHEMA_VERSION } : {}),
  } as unknown as PEHistoryDocument;
}

function seedRows(fake: FakeFirestore, rows: readonly PEHistoryDocument[]): void {
  for (const pe of rows) fake.store.set(`pe_history/${pe.peId}`, pe as unknown as Record<string, unknown>);
}

/** The pure reference fold over the legacy rows a user is read under (contributor + beneficiary). */
function referenceFold(
  fake: FakeFirestore,
  userId: string,
  options: { nowMs: number; settlementProjection?: CurrentSettlementProjectionContext | null },
): EconomicAccrualProjection {
  const rows: Array<{ row: PEHistoryDocument; role: 'contributor' | 'beneficiary' }> = [];
  for (const [key, value] of fake.store) {
    if (!key.startsWith('pe_history/')) continue;
    const pe = value as unknown as PEHistoryDocument;
    if (pe.userId === userId) rows.push({ row: pe, role: 'contributor' });
    if (pe.beneficiary_wallet_id === userId) rows.push({ row: pe, role: 'beneficiary' });
  }
  return foldEconomicAccrualRows(rows, options);
}

/** Backfill an identity's aggregate and roll its watermark forward to the horizon. */
async function prime(fake: FakeFirestore, identity = 'user-1'): Promise<void> {
  await backfillIdentityAggregate(db(fake), identity, { nowMs: NOW });
  await rollForwardFrozenAggregate(db(fake), identity, 'contributor', {
    cutoffMs: NOW - FROZEN_CONTRIBUTION_WINDOW_MS, nowMs: NOW,
  });
}

/** A non-unit rate so the rounding note in the module header is exercised. */
function context(num = 1n, den = 3n): CurrentSettlementProjectionContext {
  return {
    projectedAtMs: NOW,
    globalMintRate: disclosedRationalFactor(num, den, 'test', 'block:1'),
  };
}

/**
 * A population on BOTH sides of the watermark: frozen rows (older than the horizon,
 * incl. a Genesis fixed grant, a minted row, a beneficiary leg and a foreign
 * row that must never leak), a tail row inside the window, and one legacy
 * unmarked row.
 */
function fixture(): PEHistoryDocument[] {
  return [
    row({ peId: 'old-1', ageMs: OLD + 30 * DAY }),
    row({ peId: 'old-2', ageMs: OLD + 10 * DAY, beneficiary: 'human-9' }),
    row({ peId: 'old-3', ageMs: OLD + 5 * DAY, mintStatus: 'minted' }),
    row({ peId: 'old-g', ageMs: OLD + 4 * DAY, genesisFixedAtomic: 75n * UNIT, category: 'wallet' }),
    row({ peId: 'old-rec', ageMs: OLD + 4 * DAY + 1, actionType: 'agent_wallet_created', category: 'agent' }),
    row({ peId: 'ben-1', ageMs: OLD + 6 * DAY, userId: 'agent-7', beneficiary: 'user-1' }),
    row({ peId: 'tail-1', ageMs: 2 * DAY }),
    row({ peId: 'tail-2', ageMs: 1000, beneficiary: 'human-9' }),
    row({ peId: 'foreign', ageMs: 3 * DAY, userId: 'user-2' }),
    row({ peId: 'legacy-unmarked', ageMs: OLD + 8 * DAY, marked: false }),
  ];
}

describe('seal atomicity — the aggregate is written IN the pe_history transaction', () => {
  const RECORDED_AT = NOW - 1000;

  function sealParams(peId: string) {
    const s = snapshot(peId, 'wallet_created', RECORDED_AT, 'user-1');
    return {
      peId,
      userId: 'user-1',
      timestamp: RECORDED_AT,
      actionType: 'wallet_created',
      category: 'wallet' as const,
      attestationDepth: 'software',
      estimatedPVT: 10,
      peHash: 'h',
      jurisdiction_context: 'US',
      mint_disposition: s.mintDisposition,
      disposition_reason_code: s.mintReasonCode,
      policy_review_state: 'not_required' as const,
      policy_review_reason_code: 'known_policy_entry' as const,
      economic_policy_version: s.policyVersion,
      economic_snapshot: s,
      beneficiary_wallet_id: 'human-1',
    };
  }

  it('one seal → the row is born marked and both identities carry its contribution', async () => {
    const fake = createFakeFirestore();
    expect(await writePEHistory(sealParams('pe-seal'), db(fake))).toBe(true);
    const rowDoc = fake.store.get('pe_history/pe-seal')!;
    expect(isAggregateMarked(rowDoc)).toBe(true);
    const user = parseAggregateDocument('user-1', fake.store.get(`${ECONOMIC_AGGREGATE_COLLECTION}/user-1`))!;
    const human = parseAggregateDocument('human-1', fake.store.get(`${ECONOMIC_AGGREGATE_COLLECTION}/human-1`))!;
    expect(user.roles.contributor).toMatchObject({ total_pes: 1, record_points_atomic: (10n * UNIT).toString() });
    expect(human.roles.beneficiary).toMatchObject({ total_pes: 1, record_points_atomic: '0' });
    // The seal and the aggregate write were the same transaction (ops order).
    const sealIndex = fake.ops.indexOf('txn.set:pe_history/pe-seal');
    expect(sealIndex).toBeGreaterThan(-1);
    expect(fake.ops).toContain(`txn.set:${ECONOMIC_AGGREGATE_COLLECTION}/user-1`);
  });

  it('RED: an injected aggregate-write failure rolls the SEAL back — no row, no aggregate', async () => {
    const fake = createFakeFirestore({ failTxnWriteTo: ECONOMIC_AGGREGATE_COLLECTION });
    await expect(writePEHistory(sealParams('pe-seal'), db(fake))).rejects.toThrow('Injected transaction write failure');
    expect(fake.store.has('pe_history/pe-seal')).toBe(false);
    expect(fake.store.has(`${ECONOMIC_AGGREGATE_COLLECTION}/user-1`)).toBe(false);
  });

  it('a duplicate seal leaves the aggregate untouched (dedup guard runs before any write)', async () => {
    const fake = createFakeFirestore();
    await writePEHistory(sealParams('pe-seal'), db(fake));
    const once = fake.store.get(`${ECONOMIC_AGGREGATE_COLLECTION}/user-1`);
    expect(await writePEHistory(sealParams('pe-seal'), db(fake))).toBe(false);
    expect(fake.store.get(`${ECONOMIC_AGGREGATE_COLLECTION}/user-1`)).toEqual(once);
  });

  it('a qualifying seal creates one deterministic bug signal and a duplicate seal cannot duplicate it', async () => {
    const fake = createFakeFirestore();
    const previous = process.env[SINGLE_PE_PUSH_THRESHOLD_ENV];
    process.env[SINGLE_PE_PUSH_THRESHOLD_ENV] = '1';
    try {
      expect(await writePEHistory(sealParams('pe-signal'), db(fake))).toBe(true);
      expect(await writePEHistory(sealParams('pe-signal'), db(fake))).toBe(false);
      expect(fake.store.get(`${PE_BUG_SIGNAL_COLLECTION}/pe-signal`)).toMatchObject({
        pe_id: 'pe-signal', delivered_at_ms: null, delivery_attempts: 0,
      });
      expect(fake.ops.filter((op) => op === `create:${PE_BUG_SIGNAL_COLLECTION}/pe-signal`))
        .toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env[SINGLE_PE_PUSH_THRESHOLD_ENV];
      else process.env[SINGLE_PE_PUSH_THRESHOLD_ENV] = previous;
    }
  });

  it('a bug-signal storage failure cannot block or reclassify the PE seal', async () => {
    const fake = createFakeFirestore({
      failCreateOnce: {
        collection: PE_BUG_SIGNAL_COLLECTION,
        error: Object.assign(new Error('ops signal unavailable'), { code: 13 }),
      },
    });
    const previous = process.env[SINGLE_PE_PUSH_THRESHOLD_ENV];
    process.env[SINGLE_PE_PUSH_THRESHOLD_ENV] = '1';
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await writePEHistory(sealParams('pe-signal-failure'), db(fake))).toBe(true);
      expect(fake.store.get('pe_history/pe-signal-failure')).toMatchObject({
        mint_status: 'eligible', mint_disposition: 'eligible',
      });
      expect(fake.store.has(`${PE_BUG_SIGNAL_COLLECTION}/pe-signal-failure`)).toBe(false);
      // A duplicate submission retries the deterministic signal even though the
      // PE itself correctly deduplicates.
      expect(await writePEHistory(sealParams('pe-signal-failure'), db(fake))).toBe(false);
      expect(fake.store.has(`${PE_BUG_SIGNAL_COLLECTION}/pe-signal-failure`)).toBe(true);
    } finally {
      error.mockRestore();
      if (previous === undefined) delete process.env[SINGLE_PE_PUSH_THRESHOLD_ENV];
      else process.env[SINGLE_PE_PUSH_THRESHOLD_ENV] = previous;
    }
  });
});

describe('roll-forward — pages never split a millisecond', () => {
  it('drains a page-sized run of rows sharing one timestamp and lands the watermark ON it', async () => {
    const fake = createFakeFirestore();
    const sameTs = OLD + 20 * DAY;
    const rows = [
      row({ peId: 'r-a', ageMs: OLD + 25 * DAY }),
      ...['r-b', 'r-c', 'r-d', 'r-e'].map((peId) => row({ peId, ageMs: sameTs })),
      row({ peId: 'r-f', ageMs: OLD + 15 * DAY }),
      row({ peId: 'r-tail', ageMs: DAY }),
    ];
    seedRows(fake, rows);
    await backfillIdentityAggregate(db(fake), 'user-1', { nowMs: NOW });
    const cutoffMs = NOW - FROZEN_CONTRIBUTION_WINDOW_MS;
    const report = await rollForwardFrozenAggregate(db(fake), 'user-1', 'contributor', { cutoffMs, nowMs: NOW, pageSize: 2 });
    expect(report.rowsFrozen).toBe(6);
    expect(report.frozenThroughMs).toBe(cutoffMs);
    expect(report.pages).toBeGreaterThan(1);
    // The six frozen rows' rate-free input is in the frozen sum; the tail row is not.
    const agg = parseAggregateDocument('user-1', fake.store.get(`${ECONOMIC_AGGREGATE_COLLECTION}/user-1`))!;
    expect(agg.roles.contributor.frozen_pes).toBe(6);
    const frozenOnly = foldEconomicAccrualRows(
      rows.filter((r) => r.peId !== 'r-tail').map((r) => ({ row: r, role: 'contributor' as const })),
      { nowMs: NOW, settlementProjection: context(1n, 1n) },
    );
    expect(agg.roles.contributor.frozen_projection_rated_atomic).toBe(frozenOnly.totalCurrentSettlementProjectionAtomic);
    expect(frozenOnly.totalCurrentSettlementProjectionAtomic).toBe((60n * UNIT).toString());
  });

  it('never advances past the cutoff and never writes when nothing crossed', async () => {
    const fake = createFakeFirestore();
    seedRows(fake, [row({ peId: 'only-tail', ageMs: DAY })]);
    await backfillIdentityAggregate(db(fake), 'user-1', { nowMs: NOW });
    const before = fake.store.get(`${ECONOMIC_AGGREGATE_COLLECTION}/user-1`);
    const report = await rollForwardFrozenAggregate(db(fake), 'user-1', 'contributor', {
      cutoffMs: NOW - FROZEN_CONTRIBUTION_WINDOW_MS, nowMs: NOW,
    });
    expect(report.rowsFrozen).toBe(0);
    expect(fake.store.get(`${ECONOMIC_AGGREGATE_COLLECTION}/user-1`)).toEqual(before);
  });
});

describe('backfill — idempotent by the marker', () => {
  it('a second run marks nothing and changes nothing', async () => {
    const fake = createFakeFirestore();
    seedRows(fake, fixture().map((r) => ({ ...r, [PE_HISTORY_AGGREGATE_MARKER_FIELD]: undefined }) as PEHistoryDocument));
    const first = await backfillIdentityAggregate(db(fake), 'user-1', { nowMs: NOW, pageSize: 4 });
    // 8 rows keyed by user-1 (contributor walk); ben-1 is keyed by agent-7 and
    // is reached only through user-1's BENEFICIARY walk.
    expect(first.roles.map((r) => r.rowsMarked)).toEqual([8, 1]);
    const afterFirst = fake.store.get(`${ECONOMIC_AGGREGATE_COLLECTION}/user-1`);
    const second = await backfillIdentityAggregate(db(fake), 'user-1', { nowMs: NOW, pageSize: 4 });
    expect(second.roles.map((r) => r.rowsMarked)).toEqual([0, 0]);
    expect(fake.store.get(`${ECONOMIC_AGGREGATE_COLLECTION}/user-1`)).toMatchObject({
      roles: (afterFirst as { roles: unknown }).roles,
    });
    // A row marked under user-1's walk was ALSO applied to its beneficiary.
    const human = parseAggregateDocument('human-9', fake.store.get(`${ECONOMIC_AGGREGATE_COLLECTION}/human-9`))!;
    expect(human.roles.beneficiary.total_pes).toBe(2); // old-2 and tail-2
  });
});

describe('drift detection — the three skip shapes are caught', () => {
  it('RED 1: an accrual that skipped the aggregate write is caught by the sweep and repaired to the fold', async () => {
    const fake = createFakeFirestore();
    seedRows(fake, fixture());
    await prime(fake);
    // The defect, constructed: a MARKED row appears with no aggregate write.
    seedRows(fake, [row({ peId: 'skipped-write', ageMs: 2 * DAY, marked: true })]);
    const report = await detectIdentityAggregateDrift(db(fake), 'user-1', { nowMs: NOW, repair: true });
    expect(report.drift).toBe(true);
    expect(report.repair).toBe('repaired');
    const agg = parseAggregateDocument('user-1', fake.store.get(`${ECONOMIC_AGGREGATE_COLLECTION}/user-1`))!;
    const fold = referenceFold(fake, 'user-1', { nowMs: NOW });
    expect(agg.roles.contributor.total_pes + agg.roles.beneficiary.total_pes).toBe(fold.totalPEs);
    expect(fold.totalPEs).toBe(10);
    expect(agg.drift_repaired_at_ms).toBe(NOW);
  });

  it('RED 2: a mutating recovery that skipped the delta is named by the reference comparison', async () => {
    const fake = createFakeFirestore();
    seedRows(fake, fixture());
    await prime(fake);
    // The defect, constructed: reprice a FROZEN row's points behind the aggregate.
    const old = fake.store.get('pe_history/old-1')!;
    fake.store.set('pe_history/old-1', {
      ...old,
      record_points_atomic: (4n * UNIT).toString(),
      pending_cache_outcome: 'eligible_novelty_corrected',
    });
    const report = await detectIdentityAggregateDrift(db(fake), 'user-1', { nowMs: NOW, repair: false });
    expect(report.drift).toBe(true);
    const contributor = report.roles.find((r) => r.role === 'contributor')!;
    expect(contributor.evaluatedRows).toBeGreaterThan(0);
    expect(contributor.mismatches).toEqual(expect.arrayContaining([
      'record_points_atomic',
      'frozen_projection_rated_atomic',
    ]));
    expect(report.repair).toBe('repair_disabled');

    // CONTROL: the same repricing THROUGH the primitive leaves no drift.
    const clean = createFakeFirestore();
    seedRows(clean, fixture());
    await prime(clean);
    await mutatePeHistoryRowWithAggregate(db(clean), 'old-1', {
      record_points_atomic: (4n * UNIT).toString(),
      pending_cache_outcome: 'eligible_novelty_corrected',
    }, { nowMs: NOW });
    const cleanReport = await detectIdentityAggregateDrift(db(clean), 'user-1', { nowMs: NOW, repair: false });
    expect(cleanReport.drift).toBe(false);
  });

  it('RED 3: a corrupted stored total is caught and repaired under CAS; an active identity is retried later', async () => {
    const fake = createFakeFirestore();
    seedRows(fake, fixture());
    await prime(fake);
    const key = `${ECONOMIC_AGGREGATE_COLLECTION}/user-1`;
    const stored = fake.store.get(key)!;
    (stored.roles as Record<string, Record<string, unknown>>).contributor.record_points_atomic = '1';
    fake.store.set(key, stored);

    const repaired = await detectIdentityAggregateDrift(db(fake), 'user-1', { nowMs: NOW, repair: true });
    expect(repaired.drift).toBe(true);
    expect(repaired.repair).toBe('repaired');
    const again = await detectIdentityAggregateDrift(db(fake), 'user-1', { nowMs: NOW, repair: true });
    expect(again.drift).toBe(false);

    // CAS: a version bump between the fold and the write is refused, not clobbered.
    // The race is constructed by a db wrapper whose runTransaction (the repair's
    // one and only transaction once the aggregate exists) bumps the stored
    // version — as a concurrent seal would — before delegating.
    const racingFake = createFakeFirestore();
    seedRows(racingFake, fixture());
    await backfillIdentityAggregate(db(racingFake), 'user-1', { nowMs: NOW });
    const corrupt = racingFake.store.get(key)!;
    (corrupt.roles as Record<string, Record<string, unknown>>).contributor.record_points_atomic = '1';
    racingFake.store.set(key, corrupt);
    const racing = {
      ...racingFake,
      runTransaction: <T>(fn: (txn: unknown) => Promise<T>): Promise<T> => {
        const doc = racingFake.store.get(key)!;
        racingFake.store.set(key, { ...doc, version: (doc.version as number) + 1 });
        return racingFake.runTransaction(fn as never);
      },
    };
    const raced = await detectIdentityAggregateDrift(racing as unknown as Firestore, 'user-1', { nowMs: NOW, repair: true });
    expect(raced.drift).toBe(true);
    expect(raced.repair).toBe('identity_active_retry_later');
    // Nothing was clobbered: the corrupted (now version-bumped) document is untouched.
    expect(racingFake.store.get(key)).toMatchObject({ version: (corrupt.version as number) + 1 });
  });

  it('a missing aggregate is backfilled by the sweep, not "repaired" from nothing', async () => {
    const fake = createFakeFirestore();
    seedRows(fake, fixture());
    const report = await detectIdentityAggregateDrift(db(fake), 'user-1', { nowMs: NOW, repair: true });
    expect(report.aggregatePresent).toBe(false);
    expect(report.repair).toBe('aggregate_missing_backfilled');
    const agg = parseAggregateDocument('user-1', fake.store.get(`${ECONOMIC_AGGREGATE_COLLECTION}/user-1`))!;
    expect(agg.roles.contributor.backfill_complete).toBe(true);
  });
});
