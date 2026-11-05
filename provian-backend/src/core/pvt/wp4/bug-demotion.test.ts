import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../__test-helpers__/fake-firestore';
import {
  BUG_DEMOTION_COLLECTION,
  CLAIM_LEDGER_COLLECTION,
  acquireCycleLease,
  claimKeyOf,
  registerClaim,
  reserveBatch,
  type NewClaimInput,
  type SettlementDb,
} from './durable-settlement-store';
import {
  demoteBugProducedPe,
  type BugDetector,
} from './bug-demotion';

const HASH = `0x${'1'.repeat(64)}`;
const POLICY = `0x${'2'.repeat(64)}`;
const CLAIM = `0x${'3'.repeat(64)}`;
const BATCH = `0x${'4'.repeat(64)}`;
const CONTRIBUTOR = `0x${'5'.repeat(40)}`;
const PE = 'pe_bug_fixture';
const NOW = 1_000_000;

const claim: NewClaimInput = {
  pe_id: PE,
  leg: 'sole',
  claim_id: CLAIM,
  lane: 'standard',
  contributor: CONTRIBUTOR,
  beneficiary_class: 1,
  record_points_atomic: '100',
};

const provingDetector: BugDetector = {
  id: 'fixture-producer-bug',
  version: '1',
  async prove() {
    return {
      detector_id: 'fixture-producer-bug',
      detector_version: '1',
      evidence: { impossible_fixture_marker: true },
    };
  },
};

async function seedEligible(db: Firestore): Promise<void> {
  await db.collection('pe_history').doc(PE).set({
    peId: PE,
    timestamp: NOW,
    category: 'agent_action',
    mint_status: 'eligible',
    mint_disposition: 'eligible',
    economic_snapshot_hash: HASH,
    economic_snapshot: { immutable: 'must-survive' },
    record_points_atomic: '100',
    estimated_pvt_atomic: '100',
    estimatedPVT: 0.0000000000000001,
  });
  await registerClaim(db as unknown as SettlementDb, claim, NOW);
}

describe('detector-backed single-PE bug demotion', () => {
  it('refuses unknown detectors and a detector that cannot prove the bug', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    await seedEligible(db);
    expect(await demoteBugProducedPe({
      db, peId: PE, detectorId: 'operator-reason', expectedSnapshotHash: HASH, execute: true,
    })).toEqual({ kind: 'refused', reason: 'unknown_or_unshipped_bug_detector' });
    expect(await demoteBugProducedPe({
      db, peId: PE, detectorId: 'null', expectedSnapshotHash: HASH, execute: true,
      detectors: { null: { id: 'null', version: '1', prove: async () => null } },
    })).toEqual({ kind: 'refused', reason: 'bug_not_proved' });
    expect((await db.collection('pe_history').doc(PE).get()).data()).toMatchObject({
      mint_status: 'eligible', mint_disposition: 'eligible',
    });
  });

  it('dry-runs without writes, then demotes only derived eligibility and leaves the sealed snapshot intact', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    await seedEligible(db);
    const input = {
      db, peId: PE, detectorId: provingDetector.id, expectedSnapshotHash: HASH,
      detectors: { [provingDetector.id]: provingDetector }, nowMs: NOW + 1,
    };
    expect(await demoteBugProducedPe({ ...input, execute: false }))
      .toMatchObject({ kind: 'dry_run_proved', claim_rows: 1 });
    expect((await db.collection(BUG_DEMOTION_COLLECTION).doc(PE).get()).exists).toBe(false);

    const result = await demoteBugProducedPe({ ...input, execute: true });
    expect(result).toMatchObject({ kind: 'demoted', claim_rows: 1 });
    const row = (await db.collection('pe_history').doc(PE).get()).data()!;
    expect(row).toMatchObject({
      mint_status: 'record_only', mint_disposition: 'record_only',
      estimated_pvt_atomic: '0', economic_snapshot_hash: HASH,
      economic_snapshot: { immutable: 'must-survive' },
    });
    expect((await db.collection(CLAIM_LEDGER_COLLECTION).doc(claimKeyOf(PE, 'sole')).get()).data())
      .toMatchObject({ settled: false, bug_demotion_id: (result as { demotion_id: string }).demotion_id });
    expect(await registerClaim(db as unknown as SettlementDb, claim, NOW + 2))
      .toEqual({ kind: 'rejected', reason: 'pe_bug_demoted' });
    expect(await demoteBugProducedPe({ ...input, execute: true }))
      .toEqual({ kind: 'already_demoted', demotion_id: (result as { demotion_id: string }).demotion_id });
    const settlementDb = db as unknown as SettlementDb;
    await acquireCycleLease(settlementDb, {
      cycleId: 'post-demotion', workerId: 'worker', nowMs: NOW + 3, leaseTtlMs: 60_000,
      epoch: 0, policyHash: POLICY, signer: CONTRIBUTOR, baseNonce: 1,
      limits: { max_transactions: 10, max_fee_wei_total: '1000000' }, cursorStart: 0n,
    });
    expect(await reserveBatch(settlementDb, {
      cycleId: 'post-demotion', workerId: 'worker', nowMs: NOW + 4,
      batchId: BATCH, lane: 'standard', epoch: 0, policyHash: POLICY,
      cursorStart: 0n, cursorEnd: 1n, recipientCount: 1, claimCount: 1,
      totalMintedAtomic: 100n, calldata: '0x01',
      members: [{ pe_id: PE, leg: 'sole', claim_id: CLAIM }],
      // the refusal now names the unsettleable member, so the runner can re-select.
    })).toEqual({ kind: 'refused', reason: 'claim_not_settleable', claimKeys: [claimKeyOf(PE, 'sole')] });
  });

  it('cannot demote a claim after it has entered an in-flight batch', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    const settlementDb = db as unknown as SettlementDb;
    await seedEligible(db);
    await acquireCycleLease(settlementDb, {
      cycleId: 'cycle', workerId: 'worker', nowMs: NOW, leaseTtlMs: 60_000,
      epoch: 0, policyHash: POLICY, signer: CONTRIBUTOR, baseNonce: 1,
      limits: { max_transactions: 10, max_fee_wei_total: '1000000' }, cursorStart: 0n,
    });
    expect((await reserveBatch(settlementDb, {
      cycleId: 'cycle', workerId: 'worker', nowMs: NOW + 1,
      batchId: BATCH, lane: 'standard', epoch: 0, policyHash: POLICY,
      cursorStart: 0n, cursorEnd: 1n, recipientCount: 1, claimCount: 1,
      totalMintedAtomic: 100n, calldata: '0x01',
      members: [{ pe_id: PE, leg: 'sole', claim_id: CLAIM }],
    })).kind).toBe('reserved');

    expect(await demoteBugProducedPe({
      db, peId: PE, detectorId: provingDetector.id, expectedSnapshotHash: HASH, execute: true,
      detectors: { [provingDetector.id]: provingDetector }, nowMs: NOW + 2,
    })).toEqual({ kind: 'refused', reason: 'claim_reserved_or_in_flight' });
    expect((await db.collection('pe_history').doc(PE).get()).data()).toMatchObject({ mint_status: 'eligible' });
  });
});
