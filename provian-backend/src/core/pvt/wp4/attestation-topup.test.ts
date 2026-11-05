/**
 * the additive attestation top-up, end to end on the fake Firestore.
 *
 * The thing under test is an INVARIANT, not a feature: holding work and evidence constant
 * and moving only WHEN the corroborating witness lands must never lower total payout
 * (FC-003), now that settlement (weekly, and on demand) routinely mints an act BEFORE its corroboration
 * arrives. Every "it" below pins one edge of that invariant with its RED control.
 */

import { createFakeFirestore } from '../__test-helpers__/fake-firestore';
import type { PEHistoryDocument } from '../../../pe-history';
import { GENESIS_PREV_HASH } from '../../pe/constants';
import {
  ATTESTATION_ENHANCEMENT_HORIZON_MS,
  ATTESTATION_ENHANCEMENT_WINDOW_MS,
  ATTESTATION_HORIZON_CUT_LINE_MS,
  computeRecordSnapshot,
  hashRecordEconomicSnapshot,
} from '../policy/monetary-accounting';
import { materializeProposedMonetaryPolicy } from '../policy/runtime-monetary-policy';
import { corroborationLiftedRecordPointsAtomic } from '../policy/economic-projection';
import { deriveClaimId as deriveClaimIdRaw, deriveLegClaimId, deriveTopupClaimId as deriveTopupClaimIdRaw, type ClaimIdResult, type SealedEnvelopeIdentity } from '../wp-ev/claim-id';
import type { PayoutLegRole } from '../wp-ev/payout-legs';

const derived = (r: ClaimIdResult): { claimId: string } => {
  if (r.kind !== 'derived') throw new Error(`expected derived, got ${JSON.stringify(r)}`);
  return r;
};
const deriveClaimId = (pe: SealedEnvelopeIdentity): { claimId: string } => derived(deriveClaimIdRaw(pe));
const deriveTopupClaimId = (pe: SealedEnvelopeIdentity, leg: PayoutLegRole): { claimId: string } => derived(deriveTopupClaimIdRaw(pe, leg));
import { PAYOUT_LEG_ROLES } from '../wp-ev/payout-legs';
import { verifyClaimIdentity, type ProposedClaim, type RecordedClaim } from './claim-identity';
import { runClaimInlet, type ClaimInletReport } from './claim-inlet';
import {
  ENVELOPES_COLLECTION,
  PE_HISTORY_COLLECTION,
  WALLETS_COLLECTION,
  createFirestoreInletSource,
} from './claim-inlet-source';
import {
  CLAIM_LEDGER_COLLECTION,
  acquireCycleLease,
  applyConfirmedBatch,
  claimKeyOf,
  recordAttempt,
  recordMinedReceipt,
  registerClaim,
  reserveBatch,
  validateNewClaim,
  writeLedgerSettlement,
  type NewClaimInput,
  type SettlementDb,
} from './durable-settlement-store';
import {
  createAttestationTopupInletSource,
  topupDeltasFor,
  topupSweepFloorMs,
} from './attestation-topup-inlet-source';

const ADDR_HUMAN = '0x00000000000000000000000000000000000000a1';
const RECORDED = ATTESTATION_HORIZON_CUT_LINE_MS + 60_000; // a post-ship PE
const POINTS = '1000000000000000000';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const H = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;

type Db = SettlementDb & { store: Map<string, Record<string, unknown>> };
function db(): Db {
  return createFakeFirestore() as unknown as Db;
}

const IDENTITY = {
  id: 'pe-1', prev_hash: GENESIS_PREV_HASH, hash: `0x${'11'.repeat(32)}`,
  timestamp: RECORDED, action_type: 'compute_session', user_id: 'user-1',
};

function envelope(): Record<string, unknown> {
  return { ...IDENTITY, counterparty_address: null, counterparty_type: null };
}

/**
 * A `compute_session` sealed at the software tier. the carve-out a recognized
 * third-party corroboration lifts it software (8000 bps) → corroborated (10000 bps): the
 * lifted total is exactly 1.25× the sealed base. No replication pack, no tx hash — the
 * seal is the only evidence, exactly the production shape.
 */
function sealed(overrides: Partial<PEHistoryDocument> = {}): Partial<PEHistoryDocument> {
  const snapshot = computeRecordSnapshot(materializeProposedMonetaryPolicy(0), {
    peId: 'pe-1',
    economicActorId: 'user-1',
    actionType: 'compute_session',
    recordedAtMs: RECORDED,
    occurrenceOrdinal: 1,
    dailyOrdinal: 1,
    exactDuplicate: false,
    uniqueArtifact: false,
    attestationTier: 'software',
    linkageState: 'unlinked',
    evidenceState: 'verified',
    canonicalEventId: 'compute_session:lineage-1',
    selfReferencing: false,
    sharedBeneficialOwnership: false,
    pairChurnDetected: false,
    sessionLineageId: 'lineage-1',
    genesisReservation: null,
  });
  return {
    peId: 'pe-1',
    userId: 'user-1',
    actionType: 'compute_session',
    timestamp: RECORDED,
    attestationDepth: 'software',
    attestation_verified: true,
    mint_status: 'eligible',
    mint_disposition: 'eligible',
    record_points_atomic: snapshot.recordPointsAtomic,
    replication_pack: null,
    corroboration_status: 'none',
    corroboration_received_at: null,
    economic_snapshot: snapshot,
    economic_snapshot_hash: hashRecordEconomicSnapshot(snapshot),
    ...overrides,
  } as Partial<PEHistoryDocument>;
}

async function seed(database: Db, history: Partial<PEHistoryDocument>): Promise<void> {
  await database.collection(WALLETS_COLLECTION).doc('w-user-1').set({ user_id: 'user-1', type: 'human', address: ADDR_HUMAN });
  await database.collection(PE_HISTORY_COLLECTION).doc('pe-1').set(history as never);
  await database.collection(ENVELOPES_COLLECTION).doc('pe-1').set(envelope());
}

const INLET = { pageSize: 50, maxPesPerRun: 1_000, maxRunMs: 60_000 };

async function runStandardInlet(database: Db, nowMs: number): Promise<ClaimInletReport> {
  return runClaimInlet(
    { db: database, source: createFirestoreInletSource({ db: database, now: () => nowMs }), now: () => nowMs },
    INLET,
  );
}
async function runTopupInlet(database: Db, nowMs: number): Promise<ClaimInletReport> {
  return runClaimInlet(
    { db: database, source: createAttestationTopupInletSource({ db: database, now: () => nowMs }), now: () => nowMs },
    INLET,
  );
}
function ledgerRow(database: Db, key: string): Record<string, unknown> | undefined {
  return database.store.get(`${CLAIM_LEDGER_COLLECTION}/${key}`);
}
const ACT_KEY = claimKeyOf('pe-1', 'sole');
const TOPUP_KEY = claimKeyOf('pe-1', 'sole', 'attestation_topup');

describe('FC-003 across the mint boundary', () => {
  const base = BigInt(sealed().record_points_atomic!);
  const lifted = (base * 10_000n) / 8_000n;
  const corroborated = (observedAt: number): Partial<PEHistoryDocument> => sealed({
    corroboration_status: 'peer_verified',
    corroboration_source: 'peer-9',
    corroboration_received_at: observedAt,
  });

  it('precondition: the fixture really lifts, and only when corroborated', () => {
    expect(lifted).toBeGreaterThan(base);
    expect(corroborationLiftedRecordPointsAtomic(corroborated(RECORDED + HOUR) as PEHistoryDocument)).toBe(lifted.toString());
    // RED CONTROL: the same row uncorroborated settles its verbatim base.
    expect(corroborationLiftedRecordPointsAtomic(sealed() as PEHistoryDocument)).toBe(base.toString());
  });

  it('witness BEFORE registration: the inline lift pays the lifted total; the top-up lane owes nothing', async () => {
    const database = db();
    await seed(database, corroborated(RECORDED + HOUR));
    const std = await runStandardInlet(database, RECORDED + 2 * HOUR);
    expect(std.registered).toBe(1);
    expect(ledgerRow(database, ACT_KEY)).toMatchObject({ record_points_atomic: lifted.toString() });
    const topup = await runTopupInlet(database, RECORDED + 2 * HOUR);
    expect(topup.registered).toBe(0);
    expect(ledgerRow(database, TOPUP_KEY)).toBeUndefined();
  });

  it('witness AFTER registration (row unsettled): the act stays frozen at base and the top-up carries exactly the delta', async () => {
    const database = db();
    await seed(database, sealed());
    const std = await runStandardInlet(database, RECORDED + HOUR);
    expect(std.registered).toBe(1);
    expect(ledgerRow(database, ACT_KEY)).toMatchObject({ record_points_atomic: base.toString() });
    // Nothing owed before the witness lands.
    expect((await runTopupInlet(database, RECORDED + 2 * HOUR)).registered).toBe(0);
    // The corroboration lands on the enrichment row (the act row is untouched — sealed).
    await database.collection(PE_HISTORY_COLLECTION).doc('pe-1').set(
      { corroboration_status: 'peer_verified', corroboration_source: 'peer-9', corroboration_received_at: RECORDED + 5 * DAY },
      { merge: true },
    );
    const topup = await runTopupInlet(database, RECORDED + 5 * DAY + HOUR);
    expect(topup.registered).toBe(1);
    const row = ledgerRow(database, TOPUP_KEY)!;
    expect(row).toMatchObject({
      claim_kind: 'attestation_topup',
      lane: 'standard',
      leg: 'sole',
      contributor: ADDR_HUMAN,
      topup_of_claim_key: ACT_KEY,
      topup_attestation_tier: 'corroborated',
      topup_observed_at_ms: RECORDED + 5 * DAY,
      record_points_atomic: (lifted - base).toString(),
    });
    // THE INVARIANT: act + top-up == the lifted total the witness-first order paid.
    expect(BigInt(ledgerRow(database, ACT_KEY)!.record_points_atomic as string) + BigInt(row.record_points_atomic as string)).toBe(lifted);
    // Sealed-snapshot: the act row's bytes did not move.
    expect(ledgerRow(database, ACT_KEY)).toMatchObject({ record_points_atomic: base.toString(), claim_id: deriveClaimId(IDENTITY).claimId });
    // Distinct claim ids, both derived from the sealed identity.
    expect(row.claim_id).toBe(deriveTopupClaimId(IDENTITY, 'sole').claimId);
    expect(row.claim_id).not.toBe(ledgerRow(database, ACT_KEY)!.claim_id);
  });

  // Shutdown coverage : past the accrual end line no new top-up accrues.
  it('a corroboration observed AT or AFTER the accrual end line lifts nothing and creates no top-up', async () => {
    const saved = process.env.PVT_ACCRUAL_END_MS;
    process.env.PVT_ACCRUAL_END_MS = String(RECORDED + 3 * DAY);
    try {
      // Before the line the lift stands (an act corroborated before shutdown keeps its lift).
      expect(corroborationLiftedRecordPointsAtomic(corroborated(RECORDED + HOUR) as PEHistoryDocument)).toBe(lifted.toString());
      // At the line and after it: the verbatim base.
      expect(corroborationLiftedRecordPointsAtomic(corroborated(RECORDED + 3 * DAY) as PEHistoryDocument)).toBe(base.toString());
      const database = db();
      await seed(database, sealed());
      expect((await runStandardInlet(database, RECORDED + HOUR)).registered).toBe(1);
      await database.collection(PE_HISTORY_COLLECTION).doc('pe-1').set(
        { corroboration_status: 'peer_verified', corroboration_source: 'peer-9', corroboration_received_at: RECORDED + 5 * DAY },
        { merge: true },
      );
      expect((await runTopupInlet(database, RECORDED + 5 * DAY + HOUR)).registered).toBe(0);
      expect(ledgerRow(database, TOPUP_KEY)).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.PVT_ACCRUAL_END_MS;
      else process.env.PVT_ACCRUAL_END_MS = saved;
    }
  });

  it('witness AFTER MINT: a `minted` act inside its horizon is topped up identically', async () => {
    const database = db();
    await seed(database, sealed({ mint_status: 'minted' }));
    // The act settled on an earlier day; its row is on the ledger, settled.
    await registerClaim(database, {
      leg: 'sole', pe_id: 'pe-1', claim_id: deriveClaimId(IDENTITY).claimId, lane: 'standard',
      contributor: ADDR_HUMAN, beneficiary_class: 2, record_points_atomic: base.toString(),
    }, RECORDED + HOUR);
    await database.collection(CLAIM_LEDGER_COLLECTION).doc(ACT_KEY).set({ settled: true, settled_at: RECORDED + 2 * HOUR }, { merge: true });
    await database.collection(PE_HISTORY_COLLECTION).doc('pe-1').set(
      { corroboration_status: 'service_grant_attested', corroboration_source: 'pe-forge', corroboration_received_at: RECORDED + 20 * DAY },
      { merge: true },
    );
    const topup = await runTopupInlet(database, RECORDED + 20 * DAY + HOUR);
    expect(topup.registered).toBe(1);
    expect(ledgerRow(database, TOPUP_KEY)).toMatchObject({ record_points_atomic: (lifted - base).toString(), settled: false });
    expect(ledgerRow(database, ACT_KEY)).toMatchObject({ settled: true, record_points_atomic: base.toString() });
  });

  it('mint-once: the same corroboration seen on every later run tops up ONCE', async () => {
    const database = db();
    await seed(database, sealed({ mint_status: 'minted' }));
    await registerClaim(database, {
      leg: 'sole', pe_id: 'pe-1', claim_id: deriveClaimId(IDENTITY).claimId, lane: 'standard',
      contributor: ADDR_HUMAN, beneficiary_class: 2, record_points_atomic: base.toString(),
    }, RECORDED + HOUR);
    await database.collection(PE_HISTORY_COLLECTION).doc('pe-1').set(
      { corroboration_status: 'peer_verified', corroboration_source: 'peer-9', corroboration_received_at: RECORDED + 3 * DAY },
      { merge: true },
    );
    expect((await runTopupInlet(database, RECORDED + 3 * DAY + HOUR)).registered).toBe(1);
    const first = { ...ledgerRow(database, TOPUP_KEY)! };
    for (const day of [4, 5, 9, 29]) {
      const again = await runTopupInlet(database, RECORDED + day * DAY);
      expect(again.registered).toBe(0);
      expect(again.alreadyRegistered).toBe(0); // filtered before registration: one ledger read, no transaction
    }
    expect(ledgerRow(database, TOPUP_KEY)).toEqual(first);
    // …and even a direct re-registration of the identical top-up is a no-op, never a second row.
    const direct = await registerClaim(database, {
      leg: 'sole', pe_id: 'pe-1', claim_id: first.claim_id as string, lane: 'standard',
      contributor: ADDR_HUMAN, beneficiary_class: 2, record_points_atomic: first.record_points_atomic as string,
      claim_kind: 'attestation_topup', topup_of_claim_key: ACT_KEY, topup_attestation_tier: 'corroborated',
      topup_observed_at_ms: RECORDED + 3 * DAY,
    }, RECORDED + 30 * DAY);
    expect(direct).toEqual({ kind: 'already_registered_identical' });
    expect([...database.store.keys()].filter((k) => k.startsWith(`${CLAIM_LEDGER_COLLECTION}/`))).toHaveLength(2);
  });

  it('horizon: a corroboration observed AFTER 30 days from record time is a record, not value', async () => {
    const database = db();
    await seed(database, sealed({ mint_status: 'minted' }));
    await registerClaim(database, {
      leg: 'sole', pe_id: 'pe-1', claim_id: deriveClaimId(IDENTITY).claimId, lane: 'standard',
      contributor: ADDR_HUMAN, beneficiary_class: 2, record_points_atomic: base.toString(),
    }, RECORDED + HOUR);
    await database.collection(PE_HISTORY_COLLECTION).doc('pe-1').set(
      { corroboration_status: 'peer_verified', corroboration_source: 'peer-9', corroboration_received_at: RECORDED + ATTESTATION_ENHANCEMENT_HORIZON_MS + 1 },
      { merge: true },
    );
    expect((await runTopupInlet(database, RECORDED + 31 * DAY)).registered).toBe(0);
    expect(ledgerRow(database, TOPUP_KEY)).toBeUndefined();
    // RED CONTROL: one millisecond inside the horizon, the identical row IS topped up.
    await database.collection(PE_HISTORY_COLLECTION).doc('pe-1').set(
      { corroboration_received_at: RECORDED + ATTESTATION_ENHANCEMENT_HORIZON_MS },
      { merge: true },
    );
    expect((await runTopupInlet(database, RECORDED + 31 * DAY)).registered).toBe(1);
  });

  it('scope: a PE recorded BEFORE the cut line keeps the legacy 72h window and is never topped up', async () => {
    const database = db();
    const legacyRecorded = ATTESTATION_HORIZON_CUT_LINE_MS - DAY;
    // Same fixture, sealed one day before the cut line.
    const snapshot = computeRecordSnapshot(materializeProposedMonetaryPolicy(0), {
      peId: 'pe-1', economicActorId: 'user-1', actionType: 'compute_session', recordedAtMs: legacyRecorded,
      occurrenceOrdinal: 1, dailyOrdinal: 1, exactDuplicate: false, uniqueArtifact: false,
      attestationTier: 'software', linkageState: 'unlinked', evidenceState: 'verified',
      canonicalEventId: 'compute_session:lineage-1', selfReferencing: false, sharedBeneficialOwnership: false,
      pairChurnDetected: false, sessionLineageId: 'lineage-1', genesisReservation: null,
    });
    const legacy = sealed({
      timestamp: legacyRecorded, mint_status: 'minted',
      economic_snapshot: snapshot, economic_snapshot_hash: hashRecordEconomicSnapshot(snapshot),
      record_points_atomic: snapshot.recordPointsAtomic,
      corroboration_status: 'peer_verified', corroboration_source: 'peer-9',
      corroboration_received_at: legacyRecorded + 5 * DAY, // inside 30d, outside 72h
    });
    await seed(database, legacy);
    await database.collection(ENVELOPES_COLLECTION).doc('pe-1').set({ ...envelope(), timestamp: legacyRecorded });
    await registerClaim(database, {
      leg: 'sole', pe_id: 'pe-1', claim_id: deriveClaimId({ ...IDENTITY, timestamp: legacyRecorded }).claimId, lane: 'standard',
      contributor: ADDR_HUMAN, beneficiary_class: 2, record_points_atomic: snapshot.recordPointsAtomic,
    }, legacyRecorded + HOUR);
    expect((await runTopupInlet(database, legacyRecorded + 6 * DAY)).registered).toBe(0);
    // Both fences hold independently: the window function says 72h for this PE…
    expect(ATTESTATION_ENHANCEMENT_WINDOW_MS).toBeLessThan(5 * DAY);
    // …and the sweep floor never reaches before the cut line.
    expect(topupSweepFloorMs(legacyRecorded + 6 * DAY)).toBe(ATTESTATION_HORIZON_CUT_LINE_MS);
  });

  it('no act row ⇒ no top-up (nothing to add to; the inline lift will carry it at registration)', async () => {
    const database = db();
    await seed(database, corroborated(RECORDED + HOUR));
    expect((await runTopupInlet(database, RECORDED + 2 * HOUR)).registered).toBe(0);
    expect(ledgerRow(database, TOPUP_KEY)).toBeUndefined();
    // RED CONTROL: the registration transaction itself refuses a top-up with no act row.
    const refused = await registerClaim(database, {
      leg: 'sole', pe_id: 'pe-1', claim_id: deriveTopupClaimId(IDENTITY, 'sole').claimId, lane: 'standard',
      contributor: ADDR_HUMAN, beneficiary_class: 2, record_points_atomic: '1',
      claim_kind: 'attestation_topup', topup_of_claim_key: ACT_KEY, topup_attestation_tier: 'corroborated',
      topup_observed_at_ms: RECORDED + HOUR,
    }, RECORDED + 2 * HOUR);
    expect(refused).toEqual({ kind: 'rejected', reason: 'topup_original_claim_missing' });
  });

  it('a Genesis grant and a demoted duplicate are out by construction', async () => {
    for (const overrides of [
      { is_genesis_grant: true, mint_status: 'minted' as const },
      { mint_status: 'corroborated_duplicate' as const },
    ]) {
      const database = db();
      await seed(database, corroborated(RECORDED + DAY));
      await database.collection(PE_HISTORY_COLLECTION).doc('pe-1').set(overrides, { merge: true });
      await registerClaim(database, {
        leg: 'sole', pe_id: 'pe-1', claim_id: deriveClaimId(IDENTITY).claimId, lane: 'standard',
        contributor: ADDR_HUMAN, beneficiary_class: 2, record_points_atomic: base.toString(),
      }, RECORDED + HOUR);
      expect((await runTopupInlet(database, RECORDED + 2 * DAY)).registered).toBe(0);
    }
  });

  it('topupDeltasFor: splits the delta over the act rows in THEIR proportions; Σ act + Σ top-up == lifted exactly', () => {
    // 1000 act points across two legs 80/20; the lift is 1.25× ⇒ delta 250, split 200/50.
    const deltas = topupDeltasFor(1250n, [
      { leg: 'beneficiary', pointsAtomic: 800n },
      { leg: 'agent', pointsAtomic: 200n },
    ]);
    expect(deltas).toEqual([{ leg: 'agent', deltaAtomic: 50n }, { leg: 'beneficiary', deltaAtomic: 200n }]);
    // Remainder goes to the LAST leg in PAYOUT_LEG_ROLES order so the identity holds to the wei.
    const odd = topupDeltasFor(1001n, [{ leg: 'sole', pointsAtomic: 997n }, { leg: 'beneficiary', pointsAtomic: 3n }]);
    expect(odd.reduce((sum, d) => sum + d.deltaAtomic, 0n)).toBe(1n);
    // RED CONTROL: a lifted total at or below what the act rows already carry (impossible by the
    // no-downgrade rule, but the arithmetic must still refuse it) pays nothing, never negative.
    expect(topupDeltasFor(9n, [{ leg: 'sole', pointsAtomic: 9n }])).toEqual([]);
    expect(topupDeltasFor(5n, [{ leg: 'sole', pointsAtomic: 9n }])).toEqual([]);
    expect(topupDeltasFor(5n, [])).toEqual([]);
  });

  /**
   * the leg set at top-up time must be the ACT'S, never a live
   * re-resolution. The beneficiary overlay resolves the second payee's wallet live and drops the leg
   * when that wallet is no longer active; a fresh `resolvePayee` at top-up would therefore
   * hand the departed second payee's paid share to the sole payee as "delta". These two tests seed
   * act rows whose leg set DIFFERS from what live resolution yields today (the fixture has no
   * beneficiary edge at all, so live resolution yields `sole` only) and pin the identity.
   */
  it('RED (over-mint): act rows sole+beneficiary, live resolution sole-only ⇒ the beneficiary share is NOT re-paid to the sole payee', async () => {
    const database = db();
    await seed(database, sealed({ mint_status: 'minted' }));
    const beneficiaryShare = (base * 200n) / 10_000n; // a 200 bps second-payee leg
    const soleShare = base - beneficiaryShare;
    const ADDR_SECOND_PAYEE = '0x00000000000000000000000000000000000000b2';
    await registerClaim(database, {
      leg: 'sole', pe_id: 'pe-1', claim_id: derived(deriveLegClaimId(IDENTITY, 'sole')).claimId, lane: 'standard',
      contributor: ADDR_HUMAN, beneficiary_class: 2, record_points_atomic: soleShare.toString(),
    }, RECORDED + HOUR);
    await registerClaim(database, {
      leg: 'beneficiary', pe_id: 'pe-1', claim_id: derived(deriveLegClaimId(IDENTITY, 'beneficiary')).claimId, lane: 'standard',
      contributor: ADDR_SECOND_PAYEE, beneficiary_class: 2, record_points_atomic: beneficiaryShare.toString(),
    }, RECORDED + HOUR);
    await database.collection(PE_HISTORY_COLLECTION).doc('pe-1').set(
      { corroboration_status: 'peer_verified', corroboration_source: 'peer-9', corroboration_received_at: RECORDED + 3 * DAY },
      { merge: true },
    );
    const topup = await runTopupInlet(database, RECORDED + 3 * DAY + HOUR);
    expect(topup.registered).toBe(2);
    const soleTop = ledgerRow(database, claimKeyOf('pe-1', 'sole', 'attestation_topup'))!;
    const benTop = ledgerRow(database, claimKeyOf('pe-1', 'beneficiary', 'attestation_topup'))!;
    // The sole payee's delta is its OWN share of the lift, not the whole lift minus its own share.
    const overMint = lifted - soleShare;
    expect(BigInt(soleTop.record_points_atomic as string)).toBeLessThan(overMint);
    expect(BigInt(soleTop.record_points_atomic as string)).toBe((lifted - base) * soleShare / base);
    // The second payee is paid on the lift too (their leg is on the act), to the same contributor.
    expect(benTop).toMatchObject({ contributor: ADDR_SECOND_PAYEE, topup_of_claim_key: claimKeyOf('pe-1', 'beneficiary') });
    // THE IDENTITY, to the wei: Σ act rows + Σ top-ups == the lifted total.
    const total = soleShare + beneficiaryShare
      + BigInt(soleTop.record_points_atomic as string) + BigInt(benTop.record_points_atomic as string);
    expect(total).toBe(lifted);
  });

  it('act row sole-only ⇒ the whole delta reaches the act leg; no leg is invented (happy path, not a control)', async () => {
    const database = db();
    await seed(database, sealed({ mint_status: 'minted' }));
    await registerClaim(database, {
      leg: 'sole', pe_id: 'pe-1', claim_id: deriveClaimId(IDENTITY).claimId, lane: 'standard',
      contributor: ADDR_HUMAN, beneficiary_class: 2, record_points_atomic: base.toString(),
    }, RECORDED + HOUR);
    await database.collection(PE_HISTORY_COLLECTION).doc('pe-1').set(
      { corroboration_status: 'peer_verified', corroboration_source: 'peer-9', corroboration_received_at: RECORDED + 3 * DAY },
      { merge: true },
    );
    const topup = await runTopupInlet(database, RECORDED + 3 * DAY + HOUR);
    expect(topup.registered).toBe(1);
    expect(ledgerRow(database, claimKeyOf('pe-1', 'beneficiary', 'attestation_topup'))).toBeUndefined();
    expect(BigInt(ledgerRow(database, TOPUP_KEY)!.record_points_atomic as string) + base).toBe(lifted);
  });

  it('RED (completeness): a PARTIAL act set (one leg of two registered) is never topped up — the missing base share is not handed to the present leg', async () => {
    const database = db();
    await seed(database, sealed({ mint_status: 'eligible' }));
    const beneficiaryShare = (base * 200n) / 10_000n;
    const soleShare = base - beneficiaryShare;
    // Only the `sole` act leg made it before the act inlet's run died; `beneficiary` is missing.
    await registerClaim(database, {
      leg: 'sole', pe_id: 'pe-1', claim_id: derived(deriveLegClaimId(IDENTITY, 'sole')).claimId, lane: 'standard',
      contributor: ADDR_HUMAN, beneficiary_class: 2, record_points_atomic: soleShare.toString(),
    }, RECORDED + HOUR);
    await database.collection(PE_HISTORY_COLLECTION).doc('pe-1').set(
      { corroboration_status: 'peer_verified', corroboration_source: 'peer-9', corroboration_received_at: RECORDED + 3 * DAY },
      { merge: true },
    );
    const report = await runTopupInlet(database, RECORDED + 3 * DAY + HOUR);
    // RED without the Σ(act) ≥ base guard: `sole` would be paid lifted − soleShare, which
    // includes the second payee's whole base share (over-mint / misdirection).
    expect(report.registered).toBe(0);
    expect(ledgerRow(database, TOPUP_KEY)).toBeUndefined();
    // Once the act set is complete, the same corroboration pays exactly the delta, split by share.
    await registerClaim(database, {
      leg: 'beneficiary', pe_id: 'pe-1', claim_id: derived(deriveLegClaimId(IDENTITY, 'beneficiary')).claimId, lane: 'standard',
      contributor: '0x00000000000000000000000000000000000000b2', beneficiary_class: 2, record_points_atomic: beneficiaryShare.toString(),
    }, RECORDED + 3 * DAY + 2 * HOUR);
    expect((await runTopupInlet(database, RECORDED + 4 * DAY)).registered).toBe(2);
    const soleTop = BigInt(ledgerRow(database, TOPUP_KEY)!.record_points_atomic as string);
    const benTop = BigInt(ledgerRow(database, claimKeyOf('pe-1', 'beneficiary', 'attestation_topup'))!.record_points_atomic as string);
    expect(soleShare + beneficiaryShare + soleTop + benTop).toBe(lifted);
  });

  it('RED (mixed split): act legs registered from TWO totals (sole at base, beneficiary at lifted) are refused — never re-split between legs', async () => {
    const database = db();
    await seed(database, sealed({ mint_status: 'eligible' }));
    const beneficiaryShareBase = (base * 200n) / 10_000n;
    const soleShareBase = base - beneficiaryShareBase;
    // The corroboration landed BETWEEN the two act-leg registrations, so the act inlet priced
    // the late beneficiary leg from the LIFTED total (claim-inlet-source re-prices per run).
    const beneficiaryShareLifted = (lifted * 200n) / 10_000n;
    await registerClaim(database, {
      leg: 'sole', pe_id: 'pe-1', claim_id: derived(deriveLegClaimId(IDENTITY, 'sole')).claimId, lane: 'standard',
      contributor: ADDR_HUMAN, beneficiary_class: 2, record_points_atomic: soleShareBase.toString(),
    }, RECORDED + HOUR);
    await registerClaim(database, {
      leg: 'beneficiary', pe_id: 'pe-1', claim_id: derived(deriveLegClaimId(IDENTITY, 'beneficiary')).claimId, lane: 'standard',
      contributor: '0x00000000000000000000000000000000000000b2', beneficiary_class: 2, record_points_atomic: beneficiaryShareLifted.toString(),
    }, RECORDED + 3 * DAY + 2 * HOUR);
    await database.collection(PE_HISTORY_COLLECTION).doc('pe-1').set(
      { corroboration_status: 'peer_verified', corroboration_source: 'peer-9', corroboration_received_at: RECORDED + 3 * DAY },
      { merge: true },
    );
    // Precondition: this set passes a "Σ ≥ base" guard (the round-4 shape) — it must still be refused.
    expect(soleShareBase + beneficiaryShareLifted).toBeGreaterThan(base);
    expect(soleShareBase + beneficiaryShareLifted).toBeLessThan(lifted);
    const logs: string[] = [];
    const report = await runClaimInlet(
      { db: database, source: createAttestationTopupInletSource({ db: database, now: () => RECORDED + 4 * DAY, log: (m) => logs.push(m) }), now: () => RECORDED + 4 * DAY },
      INLET,
    );
    expect(report.registered).toBe(0);
    expect(ledgerRow(database, TOPUP_KEY)).toBeUndefined();
    expect(ledgerRow(database, claimKeyOf('pe-1', 'beneficiary', 'attestation_topup'))).toBeUndefined();
    expect(logs.some((m) => m.includes('non_uniform_act_sets=1'))).toBe(true);
  });

  it('an act set registered wholly POST-lift (Σ == lifted) owes nothing and is not counted as non-uniform', async () => {
    const database = db();
    await seed(database, sealed({ mint_status: 'eligible' }));
    await registerClaim(database, {
      leg: 'sole', pe_id: 'pe-1', claim_id: deriveClaimId(IDENTITY).claimId, lane: 'standard',
      contributor: ADDR_HUMAN, beneficiary_class: 2, record_points_atomic: lifted.toString(),
    }, RECORDED + 3 * DAY + HOUR);
    await database.collection(PE_HISTORY_COLLECTION).doc('pe-1').set(
      { corroboration_status: 'peer_verified', corroboration_source: 'peer-9', corroboration_received_at: RECORDED + 3 * DAY },
      { merge: true },
    );
    const logs: string[] = [];
    const report = await runClaimInlet(
      { db: database, source: createAttestationTopupInletSource({ db: database, now: () => RECORDED + 4 * DAY, log: (m) => logs.push(m) }), now: () => RECORDED + 4 * DAY },
      INLET,
    );
    expect(report.registered).toBe(0);
    expect(logs.some((m) => m.includes('non_uniform_act_sets=0'))).toBe(true);
  });

  it('RED (repair): a run that died between two legs registers the MISSING leg next run, at its own frozen share, and never re-pays the present one', async () => {
    const database = db();
    await seed(database, sealed({ mint_status: 'minted' }));
    const beneficiaryShare = (base * 200n) / 10_000n;
    const soleShare = base - beneficiaryShare;
    const ADDR_SECOND_PAYEE = '0x00000000000000000000000000000000000000b2';
    await registerClaim(database, {
      leg: 'sole', pe_id: 'pe-1', claim_id: derived(deriveLegClaimId(IDENTITY, 'sole')).claimId, lane: 'standard',
      contributor: ADDR_HUMAN, beneficiary_class: 2, record_points_atomic: soleShare.toString(),
    }, RECORDED + HOUR);
    await registerClaim(database, {
      leg: 'beneficiary', pe_id: 'pe-1', claim_id: derived(deriveLegClaimId(IDENTITY, 'beneficiary')).claimId, lane: 'standard',
      contributor: ADDR_SECOND_PAYEE, beneficiary_class: 2, record_points_atomic: beneficiaryShare.toString(),
    }, RECORDED + HOUR);
    // The earlier run registered ONLY the beneficiary top-up before dying.
    const refDelta = (lifted - base) - ((lifted - base) * soleShare) / base;
    await registerClaim(database, {
      leg: 'beneficiary', pe_id: 'pe-1', claim_id: deriveTopupClaimId(IDENTITY, 'beneficiary').claimId, lane: 'standard',
      contributor: ADDR_SECOND_PAYEE, beneficiary_class: 2, record_points_atomic: refDelta.toString(),
      claim_kind: 'attestation_topup', topup_of_claim_key: claimKeyOf('pe-1', 'beneficiary'), topup_attestation_tier: 'corroborated',
      topup_observed_at_ms: RECORDED + 3 * DAY,
    }, RECORDED + 3 * DAY + HOUR);
    await database.collection(PE_HISTORY_COLLECTION).doc('pe-1').set(
      { corroboration_status: 'peer_verified', corroboration_source: 'peer-9', corroboration_received_at: RECORDED + 3 * DAY },
      { merge: true },
    );
    const report = await runTopupInlet(database, RECORDED + 4 * DAY);
    // RED against a whole-PE skip: registered would be 0 and the human's share stranded forever.
    expect(report.registered).toBe(1);
    const soleTop = ledgerRow(database, TOPUP_KEY)!;
    expect(BigInt(soleTop.record_points_atomic as string)).toBe(((lifted - base) * soleShare) / base);
    expect(ledgerRow(database, claimKeyOf('pe-1', 'beneficiary', 'attestation_topup'))).toMatchObject({ record_points_atomic: refDelta.toString() });
    const total = soleShare + beneficiaryShare + BigInt(soleTop.record_points_atomic as string) + refDelta;
    expect(total).toBe(lifted);
    // And a further run pays nothing more.
    expect((await runTopupInlet(database, RECORDED + 5 * DAY)).registered).toBe(0);
  });
});

describe('the top-up claim identity', () => {
  it('deriveTopupClaimId is distinct from every act/leg id and deterministic', () => {
    const act = new Set(PAYOUT_LEG_ROLES.map((leg) => derived(deriveLegClaimId(IDENTITY, leg)).claimId));
    const topup = PAYOUT_LEG_ROLES.map((leg) => deriveTopupClaimId(IDENTITY, leg).claimId);
    expect(new Set([...act, ...topup]).size).toBe(PAYOUT_LEG_ROLES.length * 2);
    expect(deriveTopupClaimId(IDENTITY, 'sole')).toEqual(deriveTopupClaimId({ ...IDENTITY }, 'sole'));
    expect(deriveTopupClaimIdRaw(IDENTITY, 'nope' as never)).toEqual({ kind: 'rejected', reason: 'invalid_leg' });
    // Same fail-closed identity rules as the act derivation.
    expect(deriveTopupClaimIdRaw({ ...IDENTITY, hash: '' }, 'sole')).toEqual({ kind: 'rejected', reason: 'missing_hash' });
  });

  it('claimKeyOf: the act kind is byte-neutral; the top-up kind appends a third segment', () => {
    expect(claimKeyOf('PE-1', 'sole')).toBe('pe-1#sole');
    expect(claimKeyOf('PE-1', 'sole', 'act')).toBe('pe-1#sole');
    expect(claimKeyOf('pe-1', 'agent', 'attestation_topup')).toBe('pe-1#agent#attestation_topup');
  });

  it('verifyClaimIdentity keys the top-up beside its act (RED: the same pair WITHOUT the kind is drift + already-settled)', () => {
    const actId = H(1);
    const topupId = H(2);
    const settledAct: RecordedClaim = { peId: 'pe-1', leg: 'sole', claimId: actId, lane: 'standard', settled: true };
    const ledger = new Map<string, RecordedClaim>([[ACT_KEY, settledAct]]);
    const proposal: ProposedClaim = { peId: 'pe-1', leg: 'sole', kind: 'attestation_topup', claimId: topupId, lane: 'standard' };
    expect(verifyClaimIdentity([proposal], ledger)).toEqual({ kind: 'stable' });
    // RED CONTROL — drop the kind and the very same proposal is the double-mint vector.
    const kindless = verifyClaimIdentity([{ ...proposal, kind: undefined }], ledger);
    expect(kindless.kind).toBe('violations');
    if (kindless.kind === 'violations') {
      expect(kindless.violations.map((v) => v.kind).sort()).toEqual(['claim_id_drift', 'pe_already_settled']);
    }
    // A top-up must be on the standard lane.
    const genesisTopup = verifyClaimIdentity([{ ...proposal, lane: 'genesis', genesisAnchorKey: H(9) }], ledger);
    expect(genesisTopup.kind).toBe('violations');
  });

  it('validateNewClaim: the top-up carries its provenance fields, and only a top-up may', () => {
    const topup: NewClaimInput = {
      leg: 'sole', pe_id: 'pe-1', claim_id: H(2), lane: 'standard', contributor: ADDR_HUMAN,
      beneficiary_class: 2, record_points_atomic: '5', claim_kind: 'attestation_topup',
      topup_of_claim_key: ACT_KEY, topup_attestation_tier: 'corroborated', topup_observed_at_ms: RECORDED,
    };
    expect(validateNewClaim(topup)).toBeNull();
    expect(validateNewClaim({ ...topup, topup_of_claim_key: 'pe-2#sole' })).toBe('invalid_topup_of_claim_key');
    expect(validateNewClaim({ ...topup, topup_attestation_tier: '' })).toBe('invalid_topup_attestation_tier');
    expect(validateNewClaim({ ...topup, topup_observed_at_ms: 0 })).toBe('invalid_topup_observed_at');
    expect(validateNewClaim({ ...topup, claim_kind: 'bogus' as never })).toBe('invalid_claim_kind');
    expect(validateNewClaim({ ...topup, claim_kind: undefined })).toBe('topup_fields_on_act_claim');
  });
});

describe('settlement writeback of a top-up member', () => {
  const CYCLE = 'cycle-epoch0-1';
  const WORKER = 'worker-a';
  const NOW = 10_000_000;

  it('marks the top-up row settled under its OWN key, leaves the act row and mint_status untouched, and counts topup_settled', async () => {
    const database = db();
    database.store.set('pe_history/pe-1', { mint_status: 'minted' });
    await registerClaim(database, {
      leg: 'sole', pe_id: 'pe-1', claim_id: H(1), lane: 'standard', contributor: ADDR_HUMAN,
      beneficiary_class: 1, record_points_atomic: POINTS,
    }, NOW);
    await database.collection(CLAIM_LEDGER_COLLECTION).doc(ACT_KEY).set({ settled: true, settled_batch_id: H(0x4000), settled_tx_hash: H(0x40), settled_at: NOW }, { merge: true });
    await registerClaim(database, {
      leg: 'sole', pe_id: 'pe-1', claim_id: H(2), lane: 'standard', contributor: ADDR_HUMAN,
      beneficiary_class: 1, record_points_atomic: '250000000000000000', claim_kind: 'attestation_topup',
      topup_of_claim_key: ACT_KEY, topup_attestation_tier: 'corroborated', topup_observed_at_ms: NOW,
    }, NOW + 1);
    const acquired = await acquireCycleLease(database, {
      cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 2, leaseTtlMs: 60_000, epoch: 0, policyHash: H(0xfeed),
      signer: `0x${'be'.repeat(20)}`, baseNonce: 7,
      limits: { max_transactions: 10, max_fee_wei_total: '1000000000000000000' }, cursorStart: 0n,
    });
    expect(acquired.kind).toBe('acquired');
    const reserved = await reserveBatch(database, {
      cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 3, batchId: H(0x5001),
      lane: 'standard', epoch: 0, policyHash: H(0xfeed),
      cursorStart: 0n, cursorEnd: 1n, recipientCount: 1, claimCount: 1,
      totalMintedAtomic: 1n, calldata: '0xdeadbeef',
      members: [{ leg: 'sole' as const, pe_id: 'pe-1', claim_kind: 'attestation_topup' as const, claim_id: H(2) }],
    });
    if (reserved.kind !== 'reserved') throw new Error(`setup: ${JSON.stringify(reserved)}`);
    await recordAttempt(database, {
      cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 4, batchId: H(0x5001),
      attempt: { nonce: reserved.nonce, tx_hash: H(0xa1), kind: 'original', max_fee_per_gas_wei: '1', max_priority_fee_per_gas_wei: '1', gas_limit: '1' },
    });
    await recordMinedReceipt(database, { batchId: H(0x5001), txHash: H(0xa1), nowMs: NOW + 5, status: 'success', blockNumber: 11, gasUsed: 1n, effectiveGasPriceWei: 1n });
    await applyConfirmedBatch(database, { cycleId: CYCLE, batchId: H(0x5001), txHash: H(0xa1), nowMs: NOW + 6 });

    const result = await writeLedgerSettlement(database, { batchId: H(0x5001), nowMs: NOW + 7 });
    expect(result.written).toBe(1);
    expect(result.peHistory).toMatchObject({ minted: 0, already_minted: 0, topup_settled: 1 });
    expect(ledgerRow(database, TOPUP_KEY)).toMatchObject({ settled: true, settled_batch_id: H(0x5001), settled_tx_hash: H(0xa1) });
    // The act row keeps ITS settlement facts (RED: a kind-blind writeback would have re-stamped it).
    expect(ledgerRow(database, ACT_KEY)).toMatchObject({ settled: true, settled_batch_id: H(0x4000), settled_tx_hash: H(0x40) });
    expect(database.store.get('pe_history/pe-1')).toMatchObject({
      mint_status: 'minted',
      attestation_topup_settled_batch_id: H(0x5001),
      attestation_topup_settled_tx_hash: H(0xa1),
    });
  });
});
