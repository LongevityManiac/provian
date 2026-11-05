/**
 * the leg-sum audit: classifier, correction plan, and `--apply` against a fake ledger.
 *
 * Fixtures are built by the SAME arithmetic the inlet uses (`linkedAgentLegs`)
 * rather than pasted numbers, so a fixture can never describe a split production could not have
 * written. Every correcting test asserts the ledger sums to EXACTLY the reference total after,
 * and every "report only" test asserts the store did not move.
 */

import { createFakeFirestore } from '../__test-helpers__/fake-firestore';
import type { PEHistoryDocument } from '../../../pe-history';
import { GENESIS_PREV_HASH } from '../../pe/constants';
import { canonicalAgentBeneficiaryShareBps } from '../../agent-wallet/beneficiary-relationship';
import { hashBeneficiaryRoutingSnapshot, type BeneficiaryRoutingSnapshot } from '../beneficiary-routing';
import {
  ATTESTATION_HORIZON_CUT_LINE_MS,
  computeRecordSnapshot,
  hashRecordEconomicSnapshot,
} from '../policy/monetary-accounting';
import { materializeProposedMonetaryPolicy } from '../policy/runtime-monetary-policy';
import { deriveLegClaimId, type SealedEnvelopeIdentity } from '../wp-ev/claim-id';
import { linkedAgentLegs, type PayoutLegRole } from '../wp-ev/payout-legs';
import { runClaimInlet } from './claim-inlet';
import {
  AGENT_WALLETS_COLLECTION,
  ENVELOPES_COLLECTION,
  PE_HISTORY_COLLECTION,
  WALLETS_COLLECTION,
  createFirestoreInletSource,
} from './claim-inlet-source';
import {
  CLAIM_LEDGER_COLLECTION,
  claimKeyOf,
  registerClaim,
  type SettlementDb,
} from './durable-settlement-store';
import {
  classifyPe,
  completeSplitCandidates,
  planCorrection,
  runLegSumAudit,
  type AuditActRow,
  type AuditDb,
  type AuditPeInput,
} from './leg-sum-audit';
import { PE_SPLIT_COLLECTION, parseFrozenSplit, type FrozenSplitDoc } from './pe-split';
import { AGENT_RECOVERY_ESCROW_COLLECTION } from '../../agent-recovery-escrow';
import { NATIVE_WALLET_ADDRESS_INDEX_COLLECTION, nativeWalletAddressIndexId } from '../native-wallet-registration';

type Db = SettlementDb & AuditDb & { store: Map<string, Record<string, unknown>> };

const T = '1000000000000000000';
const ADDR_HUMAN = '0x00000000000000000000000000000000000000a1';
const ADDR_AGENT = '0x00000000000000000000000000000000000000a2';
const ADDR_EXTRA_PAYEE = '0x2222222222222222222222222222222222222222';
const RECORDED = ATTESTATION_HORIZON_CUT_LINE_MS + 60_000;
const NOW = RECORDED + 3_600_000;
const H = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;

function db(): Db {
  return createFakeFirestore() as unknown as Db;
}

// ── Arithmetic fixtures, from the inlet's own functions ──────────────────────

function linkedPoints(total: string): Record<'agent' | 'beneficiary', string> {
  const split = linkedAgentLegs({ agentAddress: ADDR_AGENT, humanAddress: ADDR_HUMAN, agentShareBps: 2000, totalPointsAtomic: total });
  if (split.kind !== 'legs') throw new Error('fixture');
  return { agent: split.legs[0].pointsAtomic, beneficiary: split.legs[1].pointsAtomic };
}

function extraPoints(total: string, bps: number): {beneficiary: string} {
  return {beneficiary: (BigInt(total) * BigInt(bps) / 10_000n).toString()};
}

function row(leg: PayoutLegRole, points: string, over: Partial<AuditActRow> = {}): AuditActRow {
  return {
    leg, claimId: H(PAYOUT_INDEX[leg]), contributor: leg === 'beneficiary' ? ADDR_EXTRA_PAYEE : leg === 'agent' ? ADDR_AGENT : ADDR_HUMAN,
    beneficiaryClass: 1, pointsAtomic: points, settled: false, settledTxHash: null, settledBatchId: null, reservedBatchId: null,
    ...over,
  };
}
const PAYOUT_INDEX: Record<PayoutLegRole, number> = { sole: 1, agent: 2, beneficiary: 3 };

function input(rows: AuditActRow[], over: Partial<AuditPeInput> = {}): AuditPeInput {
  return {
    peId: 'pe-1', peKey: 'pe-1', actRows: rows, topupRowCount: 0,
    basePointsAtomic: T, liftedPointsAtomic: T, mintStatus: 'eligible', historyExists: true,
    agentShareBps: null, routingInvalid: false, split: null, bugDemoted: false,
    ...over,
  };
}

const SETTLED = { settled: true, settledTxHash: H(0xbeef), settledBatchId: H(0xb0) };

describe('leg-sum audit — the classifier', () => {
  it('CONFORMING: a sole act at 100%, and a linked act at its sealed 20/80', () => {
    expect(classifyPe(input([row('sole', T)])).status).toBe('conforming');
    const linked = linkedPoints(T);
    const finding = classifyPe(input([row('agent', linked.agent), row('beneficiary', linked.beneficiary)], { agentShareBps: 2000 }));
    expect(finding.status).toBe('conforming');
    expect(finding.impliedBps).toBe(10_000);
  });

  it('OVER (the 102% shape): sole@100% plus a beneficiary leg — the beneficiary row is the excess', () => {
    const extraLeg = extraPoints(T, 200);
    const finding = classifyPe(input([row('sole', T), row('beneficiary', extraLeg.beneficiary)]));
    expect(finding.status).toBe('over');
    expect(finding.excessLegs).toEqual(['beneficiary']);
    expect(finding.referenceTotalAtomic).toBe(T);
    expect(finding.impliedBps).toBe(10_200);
  });

  it('UNDER (the short shape): only the beneficiary leg of a linked act — the agent\'s 20% is missing', () => {
    const linked = linkedPoints(T);
    const finding = classifyPe(input([row('beneficiary', linked.beneficiary, SETTLED)], { agentShareBps: 2000 }));
    expect(finding.status).toBe('under');
    expect(finding.missingLegs).toEqual([{ leg: 'agent', bps: 2000, pointsAtomic: linked.agent }]);
    expect(finding.impliedBps).toBe(8_000);
    expect(finding.settledLegs).toEqual([{ leg: 'beneficiary', pointsAtomic: linked.beneficiary, txHash: H(0xbeef), batchId: H(0xb0) }]);
  });

  it('UNEXPLAINED (the mixed shape): legs cut from two different totals match no complete split', () => {
    const lifted = ((BigInt(T) * 10_000n) / 8_000n).toString();
    const finding = classifyPe(input(
      [row('agent', linkedPoints(T).agent), row('beneficiary', linkedPoints(lifted).beneficiary)],
      { agentShareBps: 2000, liftedPointsAtomic: lifted },
    ));
    expect(finding.status).toBe('unexplained');
  });

  it('FROZEN: rows matching the split conform; a row outside it is a violation', () => {
    const split: FrozenSplitDoc = {
      schema_version: 'pvt9-pe-split/v1', pe_id: 'pe-1', pe_key: 'pe-1', lane: 'standard',
      total_points_atomic: T, base_points_atomic: T, resolved_at_ms: 1, origin: 'inlet_resolution', source_fields: {},
      legs: [{ leg: 'sole', contributor: ADDR_HUMAN, beneficiary_class: 1, bps: 10_000, record_points_atomic: T, claim_id: H(1) }],
    };
    const parsed = parseFrozenSplit(split, 'pe-1');
    expect(classifyPe(input([row('sole', T)], { split: parsed })).status).toBe('frozen_conforming');
    expect(classifyPe(input([row('sole', T), row('beneficiary', '1')], { split: parsed })).status).toBe('frozen_violation');
    expect(classifyPe(input([], { split: parsed })).status).toBe('frozen_incomplete');
  });
});

describe('leg-sum audit — the correction plan', () => {
  const extraLeg = extraPoints(T, 200);
  const linked = linkedPoints(T);

  it('over, excess unsettled beside a settled leg → delete the excess', () => {
    const plan = planCorrection(classifyPe(input([row('sole', T, SETTLED), row('beneficiary', extraLeg.beneficiary)])));
    expect(plan.kind).toBe('delete_excess_and_freeze');
  });

  it('over, excess ALREADY SETTLED → report only (a mint cannot be undone)', () => {
    const plan = planCorrection(classifyPe(input([row('sole', T, SETTLED), row('beneficiary', extraLeg.beneficiary, SETTLED)])));
    expect(plan).toEqual({ kind: 'report_only', reason: 'over_excess_already_settled_or_reserved' });
  });

  it('over, excess RESERVED in an in-flight batch → report only', () => {
    const plan = planCorrection(classifyPe(input([row('sole', T, SETTLED), row('beneficiary', extraLeg.beneficiary, { reservedBatchId: H(9) })])));
    expect(plan.kind).toBe('report_only');
  });

  it('anything mismatched with NOTHING settled or reserved → re-freeze from a fresh resolution', () => {
    expect(planCorrection(classifyPe(input([row('sole', T), row('beneficiary', extraLeg.beneficiary)]))).kind).toBe('reset_and_freeze');
    expect(planCorrection(classifyPe(input([row('beneficiary', linked.beneficiary)], { agentShareBps: 2000 }))).kind)
      .toBe('reset_and_freeze');
    // …but only for a PE the inlet will select again.
    expect(planCorrection(classifyPe(input([row('sole', T), row('beneficiary', extraLeg.beneficiary)], { mintStatus: 'minted' }))))
      .toEqual({ kind: 'report_only', reason: 'pe_not_eligible_for_reinlet' });
  });

  it('under beside a SETTLED leg → register the missing legs at the settled legs\' pricing', () => {
    const plan = planCorrection(classifyPe(input([row('beneficiary', linked.beneficiary, SETTLED)], { agentShareBps: 2000 })));
    expect(plan.kind).toBe('register_missing_and_freeze');
  });

  it('conforming → none; top-up rows or an unexplained settled set → report only', () => {
    expect(planCorrection(classifyPe(input([row('sole', T)]))).kind).toBe('none');
    expect(planCorrection(classifyPe(input([row('sole', T), row('beneficiary', extraLeg.beneficiary)], { topupRowCount: 1 }))))
      .toEqual({ kind: 'report_only', reason: 'topup_rows_present' });
    const lifted = ((BigInt(T) * 10_000n) / 8_000n).toString();
    expect(planCorrection(classifyPe(input(
      [row('agent', linkedPoints(T).agent, SETTLED), row('beneficiary', linkedPoints(lifted).beneficiary)],
      { agentShareBps: 2000, liftedPointsAtomic: lifted },
    ))).kind).toBe('report_only');
  });
});

// ── --apply against a fake ledger ────────────────────────────────────────────

function identity(peId: string, actor: string): SealedEnvelopeIdentity {
  return {
    id: peId, prev_hash: GENESIS_PREV_HASH, hash: `0x${'22'.repeat(31)}${peId.length.toString(16).padStart(2, '0')}`,
    timestamp: RECORDED, action_type: 'compute_session', user_id: actor,
  };
}

function claimId(peId: string, actor: string, leg: PayoutLegRole): string {
  const derived = deriveLegClaimId(identity(peId, actor), leg);
  if (derived.kind !== 'derived') throw new Error('fixture');
  return derived.claimId;
}

function sealed(peId: string, actor: string, over: Partial<PEHistoryDocument> = {}): Partial<PEHistoryDocument> {
  const snapshot = computeRecordSnapshot(materializeProposedMonetaryPolicy(0), {
    peId, economicActorId: actor, actionType: 'compute_session', recordedAtMs: RECORDED,
    occurrenceOrdinal: 1, dailyOrdinal: 1, exactDuplicate: false, uniqueArtifact: false,
    attestationTier: 'software', linkageState: 'unlinked', evidenceState: 'verified',
    canonicalEventId: `compute_session:${peId}`, selfReferencing: false, sharedBeneficialOwnership: false,
    pairChurnDetected: false, sessionLineageId: `lineage-${peId}`, genesisReservation: null,
  });
  return {
    peId, userId: actor, actionType: 'compute_session', timestamp: RECORDED, attestationDepth: 'software',
    attestation_verified: true, mint_status: 'eligible', mint_disposition: 'eligible',
    record_points_atomic: snapshot.recordPointsAtomic, replication_pack: null, corroboration_status: 'none',
    corroboration_received_at: null, economic_snapshot: snapshot, economic_snapshot_hash: hashRecordEconomicSnapshot(snapshot),
    ...over,
  } as Partial<PEHistoryDocument>;
}

function linkedSealed(peId: string, over: Partial<PEHistoryDocument> = {}): Partial<PEHistoryDocument> {
  const snapshot = {
    schema_version: 'beneficiary-routing/v1', pe_id: peId, economic_actor_id: 'agent-1', recorded_at_ms: RECORDED,
    human_wallet_id: 'w-user-1', human_user_id: 'user-1', human_address: ADDR_HUMAN,
    agent_share_bps: canonicalAgentBeneficiaryShareBps({ bps: 2000 })!,
  } as unknown as BeneficiaryRoutingSnapshot;
  return sealed(peId, 'agent-1', {
    beneficiary_routing_snapshot: snapshot,
    beneficiary_routing_snapshot_hash: hashBeneficiaryRoutingSnapshot(snapshot),
    ...over,
  });
}

async function seed(database: Db, peId: string, actor: string, history: Partial<PEHistoryDocument>): Promise<string> {
  await database.collection(WALLETS_COLLECTION).doc('w-user-1').set({ user_id: 'user-1', type: 'human', address: ADDR_HUMAN });
  await database.collection(AGENT_WALLETS_COLLECTION).doc('wallet_aw_agent-1').set({
    id: 'wallet_aw_agent-1', agent_id: 'agent-1', address: ADDR_AGENT, status: 'active',
  });
  await database.collection(PE_HISTORY_COLLECTION).doc(peId).set(history as never);
  await database.collection(ENVELOPES_COLLECTION).doc(peId).set({ ...identity(peId, actor), counterparty_address: null, counterparty_type: null });
  return history.record_points_atomic as string;
}

async function seedRow(
  database: Db, peId: string, actor: string, leg: PayoutLegRole, contributor: string, points: string,
  settled?: { tx: string },
): Promise<void> {
  const result = await registerClaim(database, {
    pe_id: peId, leg, claim_id: claimId(peId, actor, leg), lane: 'standard',
    contributor, beneficiary_class: 1, record_points_atomic: points,
  }, RECORDED);
  if (result.kind !== 'created') throw new Error(`seed row: ${JSON.stringify(result)}`);
  if (settled !== undefined) {
    await database.collection(CLAIM_LEDGER_COLLECTION).doc(claimKeyOf(peId, leg)).set({
      settled: true, settled_tx_hash: settled.tx, settled_batch_id: H(0xb1), settled_at: RECORDED + 1,
    }, { merge: true });
  }
}

function actSum(database: Db, peId: string): bigint {
  return [...database.store.entries()]
    .filter(([key, value]) => key.startsWith(`${CLAIM_LEDGER_COLLECTION}/`) && value.pe_id === peId)
    .reduce((sum, [, value]) => sum + BigInt(value.record_points_atomic as string), 0n);
}

function snapshotStore(database: Db): string {
  return JSON.stringify([...database.store.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

describe('leg-sum audit — --apply', () => {
  it('DRY RUN writes nothing, and reports the settled mismatch with its tx hash and amount', async () => {
    const database = db();
    const total = await seed(database, 'pe-over', 'user-1', sealed('pe-over', 'user-1'));
    const extraLeg = extraPoints(total, 200);
    await seedRow(database, 'pe-over', 'user-1', 'sole', ADDR_HUMAN, total, { tx: H(0xaa01) });
    await seedRow(database, 'pe-over', 'user-1', 'beneficiary', ADDR_EXTRA_PAYEE, extraLeg.beneficiary);
    const before = snapshotStore(database);

    // Page size 1: the two rows of one PE arrive on different pages and are still grouped.
    const report = await runLegSumAudit(database, { apply: false, nowMs: NOW, pageSize: 1 });
    expect(snapshotStore(database)).toBe(before);
    expect(report.mode).toBe('dry_run');
    expect(report.scanned_rows).toBe(2);
    expect(report.standard_pes).toBe(1); // not an empty population
    expect(report.counts).toEqual({ over: 1 });
    expect(report.findings[0].plan.kind).toBe('delete_excess_and_freeze');
    expect(report.findings[0].applied).toBeUndefined();
    expect(report.settled_mismatches[0].settledLegs).toEqual([
      { leg: 'sole', pointsAtomic: total, txHash: H(0xaa01), batchId: H(0xb1) },
    ]);
  });

  it('OVER, excess unsettled: deletes the excess leg and freezes the rest — exactly 100%, and a re-run is a no-op', async () => {
    const database = db();
    const total = await seed(database, 'pe-over', 'user-1', sealed('pe-over', 'user-1'));
    await seedRow(database, 'pe-over', 'user-1', 'sole', ADDR_HUMAN, total, { tx: H(0xaa01) });
    await seedRow(database, 'pe-over', 'user-1', 'beneficiary', ADDR_EXTRA_PAYEE, extraPoints(total, 200).beneficiary);
    expect(actSum(database, 'pe-over')).toBeGreaterThan(BigInt(total)); // RED precondition: over 100%

    const report = await runLegSumAudit(database, { apply: true, nowMs: NOW });
    expect(report.findings[0].applied).toMatchObject({ kind: 'applied', deletedLegs: ['beneficiary'], createdLegs: [] });
    expect(actSum(database, 'pe-over')).toBe(BigInt(total));
    const split = parseFrozenSplit(database.store.get(`${PE_SPLIT_COLLECTION}/pe-over`), 'pe-over');
    expect(split.kind === 'valid' && split.split.legs.map((l) => [l.leg, l.bps])).toEqual([['sole', 10_000]]);

    const before = snapshotStore(database);
    const again = await runLegSumAudit(database, { apply: true, nowMs: NOW + 1 });
    expect(again.counts).toEqual({ frozen_conforming: 1 });
    expect(again.findings).toEqual([]);
    expect(snapshotStore(database)).toBe(before);
  });

  it('OVER, excess ALREADY SETTLED: reported, nothing touched', async () => {
    const database = db();
    const total = await seed(database, 'pe-over', 'user-1', sealed('pe-over', 'user-1'));
    await seedRow(database, 'pe-over', 'user-1', 'sole', ADDR_HUMAN, total, { tx: H(0xaa01) });
    await seedRow(database, 'pe-over', 'user-1', 'beneficiary', ADDR_EXTRA_PAYEE, extraPoints(total, 200).beneficiary, { tx: H(0xaa02) });
    const before = snapshotStore(database);
    const report = await runLegSumAudit(database, { apply: true, nowMs: NOW });
    expect(report.findings[0].plan.kind).toBe('report_only');
    expect(report.findings[0].applied).toEqual({ kind: 'skipped', reason: 'over_excess_already_settled_or_reserved' });
    expect(report.settled_mismatches[0].settledLegs.map((l) => l.txHash).sort())
      .toEqual([H(0xaa01), H(0xaa02)].sort());
    expect(snapshotStore(database)).toBe(before);
  });

  it('UNDER beside a settled leg (the flipped-short linked act): registers the agent leg at its 20% and freezes 100%', async () => {
    const database = db();
    const total = await seed(database, 'pe-short', 'agent-1', linkedSealed('pe-short', { mint_status: 'minted' }));
    const linked = linkedPoints(total);
    await seedRow(database, 'pe-short', 'agent-1', 'beneficiary', ADDR_HUMAN, linked.beneficiary, { tx: H(0xaa03) });
    expect(actSum(database, 'pe-short')).toBeLessThan(BigInt(total)); // RED precondition: short

    const report = await runLegSumAudit(database, { apply: true, nowMs: NOW });
    expect(report.findings[0].status).toBe('under');
    expect(report.findings[0].applied).toMatchObject({ kind: 'applied', deletedLegs: [], createdLegs: ['agent'] });
    expect(database.store.get(`${CLAIM_LEDGER_COLLECTION}/${claimKeyOf('pe-short', 'agent')}`)).toMatchObject({
      contributor: ADDR_AGENT, record_points_atomic: linked.agent, settled: false,
      claim_id: claimId('pe-short', 'agent-1', 'agent'),
    });
    expect(actSum(database, 'pe-short')).toBe(BigInt(total));
    const again = await runLegSumAudit(database, { apply: true, nowMs: NOW + 1 });
    expect(again.counts).toEqual({ frozen_conforming: 1 });
  });

  it('escrow never holds earnings: --apply creates an UN-ESCROWED agent\'s missing leg at once, and a frozen leg the retired gate left withheld registers', async () => {
    const database = db();
    const total = await seed(database, 'pe-gated', 'agent-1', linkedSealed('pe-gated', { mint_status: 'minted' }));
    const linked = linkedPoints(total);
    await seedRow(database, 'pe-gated', 'agent-1', 'beneficiary', ADDR_HUMAN, linked.beneficiary, { tx: H(0xaa05) });
    // Exactly the state the retired gate withheld on: an agent in the native index, no escrow.
    await database.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION).doc(nativeWalletAddressIndexId(ADDR_AGENT))
      .set({ owner_type: 'agent', wallet_id: 'wallet_aw_agent-1' });
    expect(database.store.has(`${AGENT_RECOVERY_ESCROW_COLLECTION}/wallet_aw_agent-1`)).toBe(false);

    const report = await runLegSumAudit(database, { apply: true, nowMs: NOW });
    // RED with the gate re-inserted: createdLegs [], withheldLegs [agent=agent_recovery_escrow_missing].
    expect(report.findings[0].applied).toMatchObject({ kind: 'applied', createdLegs: ['agent'], withheldLegs: [] });
    expect(database.store.get(`${CLAIM_LEDGER_COLLECTION}/${claimKeyOf('pe-gated', 'agent')}`))
      .toMatchObject({ contributor: ADDR_AGENT, record_points_atomic: linked.agent, settled: false });
    expect(actSum(database, 'pe-gated')).toBe(BigInt(total));

    // The shape a gated --apply left in the ledger before 2026-10-07: the split frozen WHOLE, the
    // agent leg with no row. The next --apply registers it at its frozen value (the inlet selects
    // `eligible` only, so nothing else would ever offer a minted PE's leg).
    database.store.delete(`${CLAIM_LEDGER_COLLECTION}/${claimKeyOf('pe-gated', 'agent')}`);
    const split = parseFrozenSplit(database.store.get(`${PE_SPLIT_COLLECTION}/pe-gated`), 'pe-gated');
    expect(split.kind === 'valid' && split.split.legs.map((l) => [l.leg, l.record_points_atomic]))
      .toEqual([['agent', linked.agent], ['beneficiary', linked.beneficiary]]);
    const released = await runLegSumAudit(database, { apply: true, nowMs: NOW + 1 });
    expect(released.counts).toEqual({ frozen_incomplete: 1 });
    // RED with the gate re-inserted: skipped all_missing_legs_withheld:agent=agent_recovery_escrow_missing.
    expect(released.findings[0].applied).toMatchObject({ kind: 'applied', createdLegs: ['agent'], withheldLegs: [] });
    expect(database.store.get(`${CLAIM_LEDGER_COLLECTION}/${claimKeyOf('pe-gated', 'agent')}`))
      .toMatchObject({ contributor: ADDR_AGENT, record_points_atomic: linked.agent });
    expect(actSum(database, 'pe-gated')).toBe(BigInt(total));
    const again = await runLegSumAudit(database, { apply: true, nowMs: NOW + 2 });
    expect(again.counts).toEqual({ frozen_conforming: 1 });
  });

  it('RED (review #1): --apply pins pe_history.mint_status — no leg is added beside a demoted act', async () => {
    const database = db();
    const total = await seed(database, 'pe-demoted', 'agent-1', linkedSealed('pe-demoted', { mint_status: 'corroborated_duplicate' }));
    await seedRow(database, 'pe-demoted', 'agent-1', 'beneficiary', ADDR_HUMAN, linkedPoints(total).beneficiary, { tx: H(0xaa06) });
    const before = snapshotStore(database);
    const report = await runLegSumAudit(database, { apply: true, nowMs: NOW });
    expect(report.findings[0].plan.kind).toBe('register_missing_and_freeze');
    // RED on 0afea45e: applied, the agent row created beside a demoted duplicate.
    expect(report.findings[0].applied?.kind).toBe('skipped');
    expect(snapshotStore(database)).toBe(before);
  });

  it('nothing settled: re-freezes from a fresh resolution, keeps the matching row, and the inlet completes the set atomically', async () => {
    const database = db();
    const total = await seed(database, 'pe-reset', 'agent-1', linkedSealed('pe-reset'));
    const linked = linkedPoints(total);
    await seedRow(database, 'pe-reset', 'agent-1', 'beneficiary', ADDR_HUMAN, linked.beneficiary);

    // Before the correction the inlet refuses to add to the unfrozen set.
    const blocked = await runClaimInlet({
      db: database, source: createFirestoreInletSource({ db: database, now: () => NOW }), now: () => NOW,
    }, { pageSize: 10, maxPesPerRun: 100, maxRunMs: 60_000 });
    expect(blocked.registered).toBe(0);

    const report = await runLegSumAudit(database, { apply: true, nowMs: NOW });
    expect(report.findings[0].plan.kind).toBe('reset_and_freeze');
    expect(report.findings[0].applied).toMatchObject({ kind: 'applied', deletedLegs: [], createdLegs: [] });

    const inlet = await runClaimInlet({
      db: database, source: createFirestoreInletSource({ db: database, now: () => NOW }), now: () => NOW,
    }, { pageSize: 10, maxPesPerRun: 100, maxRunMs: 60_000 });
    expect(inlet.registered).toBe(1);
    expect(actSum(database, 'pe-reset')).toBe(BigInt(total));
    const again = await runLegSumAudit(database, { apply: false, nowMs: NOW + 1 });
    expect(again.counts).toEqual({ frozen_conforming: 1 });
  });

  it('a row that moved between plan and apply refuses state_changed and writes nothing', async () => {
    const database = db();
    const total = await seed(database, 'pe-race', 'user-1', sealed('pe-race', 'user-1'));
    await seedRow(database, 'pe-race', 'user-1', 'sole', ADDR_HUMAN, total, { tx: H(0xaa01) });
    await seedRow(database, 'pe-race', 'user-1', 'beneficiary', ADDR_EXTRA_PAYEE, extraPoints(total, 200).beneficiary);
    // Interpose: the excess leg gets reserved by a settlement run after the scan read it.
    const racing: Db = Object.assign(Object.create(Object.getPrototypeOf(database)), database, {
      runTransaction: async <R,>(fn: Parameters<Db['runTransaction']>[0]): Promise<R> => {
        await database.collection(CLAIM_LEDGER_COLLECTION).doc(claimKeyOf('pe-race', 'beneficiary'))
          .set({ reserved_batch_id: H(0x99) }, { merge: true });
        return database.runTransaction(fn) as Promise<R>;
      },
    });
    const report = await runLegSumAudit(racing, { apply: true, nowMs: NOW });
    expect(report.findings[0].applied).toEqual({ kind: 'skipped', reason: 'state_changed' });
    expect(database.store.get(`${PE_SPLIT_COLLECTION}/pe-race`)).toBeUndefined();
    expect(database.store.get(`${CLAIM_LEDGER_COLLECTION}/${claimKeyOf('pe-race', 'beneficiary')}`)).toBeDefined();
  });
});

describe('archived payout role history', () => {
  it('never repairs a paid historical set by inspecting only its active-role subset', async () => {
    const database = createFakeFirestore();
    const peId = 'pe-archived-set';
    const rows = [
      {leg:'sole',record_points_atomic:'98'},
      {leg:'archived_role',record_points_atomic:'2'},
    ].map((r,i)=>({...r,pe_id:peId,pe_key:peId,claim_key:peId+'#'+r.leg,claim_id:H(900+i),lane:'standard',settled:true,reserved_batch_id:null,settled_batch_id:H(800),settled_tx_hash:H(801)}));
    for(const row of rows)await database.collection(CLAIM_LEDGER_COLLECTION).doc(row.claim_key).set(row);
    await database.collection('pvt9_settlement_batches_v1').doc(H(800)).set({status:'confirmed',applied:true,writebacks_complete:true,finality_verified:true,confirmed_tx_hash:H(801),members:rows.map(({pe_id,leg,claim_id})=>({pe_id,leg,claim_id}))});
    const before=JSON.stringify([...database.store]);
    const report=await runLegSumAudit(database as unknown as AuditDb,{apply:true,nowMs:NOW});
    expect(report.settled_historical_pes_skipped).toBe(1);
    expect(report.unsupported_pes).toEqual([]);
    expect(report.findings).toEqual([]);
    expect(JSON.stringify([...database.store])).toBe(before);
    await database.collection(CLAIM_LEDGER_COLLECTION).doc(rows[0].claim_key).set({settled:false},{merge:true});
    const unbound=await runLegSumAudit(database as unknown as AuditDb,{apply:true,nowMs:NOW});
    expect(unbound.settled_historical_pes_skipped).toBe(0);
    expect(unbound.unsupported_pes).toEqual([peId]);
    expect(unbound.malformed_rows).toBe(2);
    expect(unbound.findings).toEqual([]);
  });
});
