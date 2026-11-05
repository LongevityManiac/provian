/**
 * cross-witness commit TAKEOVER, unit level.
 *
 * The pre-check decision, the plan construction, and the in-transaction race
 * guards — each with its RED negative control, because a guard observed only
 * green is not evidence (the run contract). The in-transaction guards ARE the
 * crash/replay property at the store layer: an incumbent that moves (demoted,
 * settled, or registered) between the pre-check and the commit forces
 * MintOnceClaimRaceError, which the accrual turns into the duplicate fallback.
 */

import { describe, it, expect } from '@jest/globals';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { prepareCommitMintClaim } from './commit-mint-claim';
import {
  MintOnceClaimRaceError,
  type MintOnceClaimDocument,
} from './mint-once-claim';
import {
  CLAIM_LEDGER_COLLECTION,
  PE_HISTORY_COLLECTION,
  claimKeyOf,
  registerClaim,
  type NewClaimInput,
  type SettlementDb,
} from './wp4/durable-settlement-store';
import {
  applyCommitTakeoverDecision,
  evaluateCommitWitness,
  inspectPreparedCommitTakeoverInTransaction,
  prepareCommitTakeoverPlan,
  recordIncumbentCommitCorroboration,
  COMMIT_CROSS_WITNESS_CORROBORATION_STATUS,
} from './commit-takeover';

const COMMIT = 'deadbeef'.repeat(5); // valid 40-hex git sha
const USER = 'user-1';
const DAEMON_PE = 'pe-daemon';
const FORGE_PE = 'pe-forge';
const NOW = 1_800_000_000_000;
const H = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
const ADDR = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;

/** Seed the incumbent daemon: its owner claim doc + an eligible pe_history row. */
async function seedIncumbent(
  db: Firestore,
  opts: { baseWeightBps?: number; mintStatus?: string } = {},
): Promise<MintOnceClaimDocument> {
  const prepared = await prepareCommitMintClaim(db, USER, COMMIT, DAEMON_PE, NOW);
  const claim = prepared.evidence.claim;
  await db.collection('commit_mint_claims').doc(claim.claim_id)
    .set({ ...claim } as unknown as FirebaseFirestore.DocumentData);
  await db.collection(PE_HISTORY_COLLECTION).doc(DAEMON_PE).set({
    peId: DAEMON_PE,
    userId: USER,
    mint_status: opts.mintStatus ?? 'eligible',
    economic_snapshot: {
      recordTimeFactors: { baseActionWeightBps: opts.baseWeightBps ?? 10_000 },
    },
  } as FirebaseFirestore.DocumentData);
  return claim;
}

function standardClaim(peId: string): NewClaimInput {
  return {
    leg: 'sole',
    pe_id: peId,
    claim_id: H(1),
    lane: 'standard',
    contributor: ADDR(0xa1),
    beneficiary_class: 1,
    record_points_atomic: '1000000000000000000',
  };
}

describe('evaluateCommitWitness — the record-time cross-witness decision', () => {
  it('higher base + eligible incumbent + unregistered → takeover', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    await seedIncumbent(db, { baseWeightBps: 10_000 });
    expect(await evaluateCommitWitness(db, {
      incumbentPeId: DAEMON_PE, newBaseWeightBps: 30_000,
    })).toBe('takeover');
  });

  it('LOWER base + eligible incumbent → corroborate_incumbent (the forge-first winner)', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    await seedIncumbent(db, { baseWeightBps: 30_000 }); // incumbent is the forge
    expect(await evaluateCommitWitness(db, {
      incumbentPeId: DAEMON_PE, newBaseWeightBps: 10_000, // this is the daemon
    })).toBe('corroborate_incumbent');
  });

  it('RED: an EQUAL base is none (same-family duplicate is not a cross-witness)', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    await seedIncumbent(db, { baseWeightBps: 30_000 });
    expect(await evaluateCommitWitness(db, {
      incumbentPeId: DAEMON_PE, newBaseWeightBps: 30_000,
    })).toBe('none');
  });

  it('RED: an incumbent that is no longer eligible is neither taken over nor corroborated', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    await seedIncumbent(db, { baseWeightBps: 10_000, mintStatus: 'corroborated_duplicate' });
    expect(await evaluateCommitWitness(db, {
      incumbentPeId: DAEMON_PE, newBaseWeightBps: 30_000,
    })).toBe('none');
  });

  it('RED: an incumbent already REGISTERED for settlement is not taken over — it is corroborated ', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    await seedIncumbent(db, { baseWeightBps: 10_000 });
    // Any payout leg registered blocks the takeover — ownership never moves. the
    // too-late higher-base witness is still a second real witness, so it corroborates
    // the registered incumbent (the additive top-up carries the lift) instead of 'none'.
    await registerClaim(db as unknown as SettlementDb, standardClaim(DAEMON_PE), NOW);
    expect(await evaluateCommitWitness(db, {
      incumbentPeId: DAEMON_PE, newBaseWeightBps: 30_000,
    })).toBe('corroborate_incumbent');
  });

  describe('across the MINT boundary', () => {
    const RECORDED = 1_800_000_000_000; // post-cut-line (2026-09-09 < 2027-01-15)
    async function seedMinted(db: Firestore, opts: { baseWeightBps: number; timestamp?: number | null }): Promise<void> {
      await seedIncumbent(db, { baseWeightBps: opts.baseWeightBps, mintStatus: 'minted' });
      await db.collection(PE_HISTORY_COLLECTION).doc(DAEMON_PE).set(
        { timestamp: opts.timestamp === undefined ? RECORDED : opts.timestamp } as FirebaseFirestore.DocumentData,
        { merge: true },
      );
    }
    it('a MINTED incumbent inside its 30-day horizon is corroborated by a lower-base witness', async () => {
      const db = createFakeFirestore() as unknown as Firestore;
      await seedMinted(db, { baseWeightBps: 30_000 });
      expect(await evaluateCommitWitness(db, {
        incumbentPeId: DAEMON_PE, newBaseWeightBps: 10_000, nowMs: RECORDED + 20 * 24 * 3600_000,
      })).toBe('corroborate_incumbent');
    });
    it('…and by a too-late HIGHER-base witness (never a takeover of a minted row)', async () => {
      const db = createFakeFirestore() as unknown as Firestore;
      await seedMinted(db, { baseWeightBps: 10_000 });
      expect(await evaluateCommitWitness(db, {
        incumbentPeId: DAEMON_PE, newBaseWeightBps: 30_000, nowMs: RECORDED + 20 * 24 * 3600_000,
      })).toBe('corroborate_incumbent');
    });
    it('RED: past the horizon a minted incumbent gets nothing (late evidence is a record, not value)', async () => {
      const db = createFakeFirestore() as unknown as Firestore;
      await seedMinted(db, { baseWeightBps: 30_000 });
      expect(await evaluateCommitWitness(db, {
        incumbentPeId: DAEMON_PE, newBaseWeightBps: 10_000, nowMs: RECORDED + 31 * 24 * 3600_000,
      })).toBe('none');
    });
    it('RED: a minted incumbent with an unreadable record time is treated as expired', async () => {
      const db = createFakeFirestore() as unknown as Firestore;
      await seedMinted(db, { baseWeightBps: 30_000, timestamp: null });
      expect(await evaluateCommitWitness(db, {
        incumbentPeId: DAEMON_PE, newBaseWeightBps: 10_000, nowMs: RECORDED + 1,
      })).toBe('none');
    });
    it('RED: a demoted duplicate is never a winner, minted or not', async () => {
      const db = createFakeFirestore() as unknown as Firestore;
      await seedIncumbent(db, { baseWeightBps: 30_000, mintStatus: 'corroborated_duplicate' });
      expect(await evaluateCommitWitness(db, {
        incumbentPeId: DAEMON_PE, newBaseWeightBps: 10_000, nowMs: RECORDED + 1,
      })).toBe('none');
    });
  });

  it('fails closed on a missing incumbent or an unreadable base weight', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    expect(await evaluateCommitWitness(db, {
      incumbentPeId: 'nope', newBaseWeightBps: 30_000,
    })).toBe('none');
    // Eligible row but no economic_snapshot → base unreadable → none.
    await db.collection(PE_HISTORY_COLLECTION).doc('pe-baseless').set({
      peId: 'pe-baseless', userId: USER, mint_status: 'eligible',
    } as FirebaseFirestore.DocumentData);
    expect(await evaluateCommitWitness(db, {
      incumbentPeId: 'pe-baseless', newBaseWeightBps: 30_000,
    })).toBe('none');
  });
});

describe('prepareCommitTakeoverPlan — the plan', () => {
  it('produces an OWNER-relation plan for the new owner with the takeover marker', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    const incumbentClaim = await seedIncumbent(db);
    const plan = prepareCommitTakeoverPlan({
      incumbentClaim, newOwnerPeId: FORGE_PE, newOwnerUserId: USER, nowMs: NOW + 1,
    });
    expect(plan.evidence.relation).toBe('owner');
    expect(plan.evidence.claim.owner_pe_id).toBe(FORGE_PE);
    expect(plan.evidence.claim.claim_id).toBe(incumbentClaim.claim_id); // same slot
    expect(plan.commit_takeover?.incumbent_pe_id).toBe(DAEMON_PE);
    expect(plan.commit_takeover?.incumbent_claim.owner_pe_id).toBe(DAEMON_PE);
  });

  it('refuses a self-takeover and a user mismatch', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    const incumbentClaim = await seedIncumbent(db);
    expect(() => prepareCommitTakeoverPlan({
      incumbentClaim, newOwnerPeId: DAEMON_PE, newOwnerUserId: USER, nowMs: NOW,
    })).toThrow('commit_takeover_self');
    expect(() => prepareCommitTakeoverPlan({
      incumbentClaim, newOwnerPeId: FORGE_PE, newOwnerUserId: 'other-user', nowMs: NOW,
    })).toThrow('commit_takeover_user_mismatch');
  });
});

describe('inspectPreparedCommitTakeoverInTransaction — the in-txn race guards', () => {
  async function runInspect(db: Firestore, plan: ReturnType<typeof prepareCommitTakeoverPlan>) {
    return db.runTransaction((txn) => inspectPreparedCommitTakeoverInTransaction(db, txn, plan));
  }

  it('happy path returns the overwrite + demotion decision', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    const incumbentClaim = await seedIncumbent(db);
    const plan = prepareCommitTakeoverPlan({
      incumbentClaim, newOwnerPeId: FORGE_PE, newOwnerUserId: USER, nowMs: NOW + 1,
    });
    const decision = await runInspect(db, plan);
    expect(decision.incumbentPeId).toBe(DAEMON_PE);
    expect(decision.newOwnerClaim.owner_pe_id).toBe(FORGE_PE);

    // Apply it and confirm the effects: claim re-owned + incumbent demoted.
    await db.runTransaction(async (txn) => {
      applyCommitTakeoverDecision(db, txn, decision, NOW + 1);
    });
    const claimAfter = await db.collection('commit_mint_claims').doc(incumbentClaim.claim_id).get();
    expect((claimAfter.data() as Record<string, unknown>).owner_pe_id).toBe(FORGE_PE);
    const incAfter = await db.collection(PE_HISTORY_COLLECTION).doc(DAEMON_PE).get();
    expect((incAfter.data() as Record<string, unknown>).mint_status).toBe('corroborated_duplicate');
    // The sealed snapshot is untouched.
    expect((incAfter.data() as Record<string, unknown>).economic_snapshot).toBeDefined();
  });

  it('RED (crash/replay): the incumbent DEMOTED mid-flight → MintOnceClaimRaceError', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    const incumbentClaim = await seedIncumbent(db);
    const plan = prepareCommitTakeoverPlan({
      incumbentClaim, newOwnerPeId: FORGE_PE, newOwnerUserId: USER, nowMs: NOW + 1,
    });
    // A concurrent takeover already demoted the incumbent.
    await db.collection(PE_HISTORY_COLLECTION).doc(DAEMON_PE).set({
      peId: DAEMON_PE, userId: USER, mint_status: 'corroborated_duplicate',
      economic_snapshot: { recordTimeFactors: { baseActionWeightBps: 10_000 } },
    } as FirebaseFirestore.DocumentData);
    await expect(runInspect(db, plan)).rejects.toBeInstanceOf(MintOnceClaimRaceError);
  });

  it('RED (crash/replay): the incumbent REGISTERED for settlement mid-flight → race', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    const incumbentClaim = await seedIncumbent(db);
    const plan = prepareCommitTakeoverPlan({
      incumbentClaim, newOwnerPeId: FORGE_PE, newOwnerUserId: USER, nowMs: NOW + 1,
    });
    await registerClaim(db as unknown as SettlementDb, standardClaim(DAEMON_PE), NOW);
    await expect(runInspect(db, plan)).rejects.toBeInstanceOf(MintOnceClaimRaceError);
  });

  it('RED (crash/replay): the claim doc RE-OWNED by a third party mid-flight → race', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    const incumbentClaim = await seedIncumbent(db);
    const plan = prepareCommitTakeoverPlan({
      incumbentClaim, newOwnerPeId: FORGE_PE, newOwnerUserId: USER, nowMs: NOW + 1,
    });
    // Someone changed the claim owner out from under the plan.
    await db.collection('commit_mint_claims').doc(incumbentClaim.claim_id).set({
      ...incumbentClaim, owner_pe_id: 'pe-third-party',
    } as unknown as FirebaseFirestore.DocumentData);
    await expect(runInspect(db, plan)).rejects.toBeInstanceOf(MintOnceClaimRaceError);
  });
});

describe('recordIncumbentCommitCorroboration: first observation wins', () => {
  it('stamps an uncorroborated incumbent (RED half: the write really lands)', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    await seedIncumbent(db, { baseWeightBps: 30_000 });
    await db.collection(PE_HISTORY_COLLECTION).doc(DAEMON_PE).set(
      { corroboration_status: 'none', corroboration_received_at: null } as FirebaseFirestore.DocumentData, { merge: true },
    );
    await recordIncumbentCommitCorroboration(db, { incumbentPeId: DAEMON_PE, corroboratingPeId: FORGE_PE, nowMs: NOW + 5 });
    const after = (await db.collection(PE_HISTORY_COLLECTION).doc(DAEMON_PE).get()).data() as Record<string, unknown>;
    expect(after.corroboration_status).toBe(COMMIT_CROSS_WITNESS_CORROBORATION_STATUS);
    expect(after.corroboration_received_at).toBe(NOW + 5);
  });

  it('never moves an EXISTING recognized corroboration later (a repeat witness cannot push the observation out of the horizon)', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    await seedIncumbent(db, { baseWeightBps: 30_000 });
    await db.collection(PE_HISTORY_COLLECTION).doc(DAEMON_PE).set(
      { corroboration_status: 'peer_verified', corroboration_source: 'peer-1', corroboration_received_at: NOW + 1 } as FirebaseFirestore.DocumentData,
      { merge: true },
    );
    await recordIncumbentCommitCorroboration(db, { incumbentPeId: DAEMON_PE, corroboratingPeId: FORGE_PE, nowMs: NOW + 40 * 24 * 3600_000 });
    const after = (await db.collection(PE_HISTORY_COLLECTION).doc(DAEMON_PE).get()).data() as Record<string, unknown>;
    expect(after.corroboration_status).toBe('peer_verified');
    expect(after.corroboration_source).toBe('peer-1');
    expect(after.corroboration_received_at).toBe(NOW + 1);
  });
});
