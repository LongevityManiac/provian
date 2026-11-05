/**
 * cross-witness COMPLETION takeover, unit level. The exact mirror of
 * `commit-takeover.test.ts` the pre-check decision, the plan construction, the
 * inlet deferral gate, and the in-transaction race guards — each with its RED
 * negative control, because a guard observed only green is not evidence (the
 * run contract). The in-transaction guards ARE the crash/replay property at
 * the store layer: an incumbent that moves (demoted, settled, or registered)
 * between the pre-check and the commit forces MintOnceClaimRaceError, which the
 * accrual turns into the duplicate fallback.
 */

import { describe, it, expect } from '@jest/globals';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { prepareCompletionMintClaim } from './completion-claim';
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
import { ATTESTATION_ENHANCEMENT_WINDOW_MS } from './policy/monetary-accounting';
import {
  applyCompletionTakeoverDecision,
  completionTakeoverWindowOpen,
  evaluateCompletionWitness,
  inspectPreparedCompletionTakeoverInTransaction,
  prepareCompletionTakeoverPlan,
} from './completion-takeover';

const CANONICAL = 'escrow:esc_22222222-2222-4222-8222-222222222222';
const USER = 'agent_deliverer';
const OFFCHAIN_PE = 'pe-delivery';
const ONCHAIN_PE = 'pe-release';
const NOW = 1_800_000_000_000;
const H = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
const ADDR = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;

/** Seed the incumbent OFF-CHAIN witness: its owner claim doc + an eligible pe_history row. */
async function seedIncumbent(
  db: Firestore,
  opts: { mintStatus?: string; witness?: string | null } = {},
): Promise<MintOnceClaimDocument> {
  const prepared = await prepareCompletionMintClaim(db, USER, CANONICAL, OFFCHAIN_PE, NOW);
  const claim = prepared.evidence.claim;
  await db.collection('completion_mint_claims').doc(claim.claim_id)
    .set({ ...claim } as unknown as FirebaseFirestore.DocumentData);
  await db.collection(PE_HISTORY_COLLECTION).doc(OFFCHAIN_PE).set({
    peId: OFFCHAIN_PE,
    userId: USER,
    timestamp: NOW,
    mint_status: opts.mintStatus ?? 'eligible',
    completion_canonical_id: CANONICAL,
    completion_witness: opts.witness === undefined ? 'counterparty_confirmation' : opts.witness,
    economic_snapshot: { recordTimeFactors: { baseActionWeightBps: 10_000 } },
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

describe('evaluateCompletionWitness — the record-time cross-witness decision', () => {
  it('on-chain witness + eligible OFF-CHAIN incumbent + unregistered → takeover', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    await seedIncumbent(db);
    expect(await evaluateCompletionWitness(db, {
      incumbentPeId: OFFCHAIN_PE, newWitness: 'onchain_release',
    })).toBe('takeover');
  });

  it('RED: an OFF-CHAIN witness never takes over (the direction is fixed)', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    await seedIncumbent(db, { witness: 'onchain_release' });
    expect(await evaluateCompletionWitness(db, {
      incumbentPeId: OFFCHAIN_PE, newWitness: 'counterparty_confirmation',
    })).toBe('none');
  });

  it('RED: an ON-CHAIN incumbent is never displaced', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    await seedIncumbent(db, { witness: 'onchain_release' });
    expect(await evaluateCompletionWitness(db, {
      incumbentPeId: OFFCHAIN_PE, newWitness: 'onchain_release',
    })).toBe('none');
  });

  it('RED: an incumbent that is no longer eligible is not taken over', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    await seedIncumbent(db, { mintStatus: 'corroborated_duplicate' });
    expect(await evaluateCompletionWitness(db, {
      incumbentPeId: OFFCHAIN_PE, newWitness: 'onchain_release',
    })).toBe('none');
  });

  it('RED: an incumbent already REGISTERED for settlement is not taken over (none)', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    await seedIncumbent(db);
    await registerClaim(db as unknown as SettlementDb, standardClaim(OFFCHAIN_PE), NOW);
    expect(await evaluateCompletionWitness(db, {
      incumbentPeId: OFFCHAIN_PE, newWitness: 'onchain_release',
    })).toBe('none');
  });

  it('fails closed on a missing incumbent or an unreadable witness marker', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    expect(await evaluateCompletionWitness(db, {
      incumbentPeId: 'nope', newWitness: 'onchain_release',
    })).toBe('none');
    await seedIncumbent(db, { witness: null });
    expect(await evaluateCompletionWitness(db, {
      incumbentPeId: OFFCHAIN_PE, newWitness: 'onchain_release',
    })).toBe('none');
  });
});

describe('completionTakeoverWindowOpen — the inlet deferral gate', () => {
  const offchain = { completion_witness: 'counterparty_confirmation', completion_canonical_id: CANONICAL, timestamp: NOW };

  it('an off-chain row is deferred inside the 72h window and offered at its edge', () => {
    expect(completionTakeoverWindowOpen(offchain, NOW + 1)).toBe(true);
    expect(completionTakeoverWindowOpen(offchain, NOW + ATTESTATION_ENHANCEMENT_WINDOW_MS - 1)).toBe(true);
    // `now < recordedAt + WINDOW` — equality does NOT defer (bounded).
    expect(completionTakeoverWindowOpen(offchain, NOW + ATTESTATION_ENHANCEMENT_WINDOW_MS)).toBe(false);
  });

  it('RED: an ON-CHAIN row is never deferred (nothing can take it over)', () => {
    expect(completionTakeoverWindowOpen({ ...offchain, completion_witness: 'onchain_release' }, NOW + 1)).toBe(false);
  });

  it('RED: a row with no completion marker is never deferred', () => {
    expect(completionTakeoverWindowOpen({ timestamp: NOW }, NOW + 1)).toBe(false);
    expect(completionTakeoverWindowOpen({ ...offchain, completion_canonical_id: '  ' }, NOW + 1)).toBe(false);
  });

  it('RED: unreadable data cannot strand a claim — bad timestamp / bad now do not defer', () => {
    expect(completionTakeoverWindowOpen({ ...offchain, timestamp: undefined }, NOW + 1)).toBe(false);
    expect(completionTakeoverWindowOpen({ ...offchain, timestamp: Number.NaN }, NOW + 1)).toBe(false);
    expect(completionTakeoverWindowOpen(offchain, Number.NaN)).toBe(false);
  });
});

describe('prepareCompletionTakeoverPlan — the plan', () => {
  it('produces an OWNER-relation plan for the new owner with the completion_takeover marker', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    const incumbentClaim = await seedIncumbent(db);
    const plan = prepareCompletionTakeoverPlan({
      incumbentClaim, newOwnerPeId: ONCHAIN_PE, newOwnerUserId: USER, nowMs: NOW + 1,
    });
    expect(plan.evidence.relation).toBe('owner');
    expect(plan.evidence.claim.owner_pe_id).toBe(ONCHAIN_PE);
    expect(plan.evidence.claim.claim_id).toBe(incumbentClaim.claim_id); // same slot
    expect(plan.claim_collection).toBe('completion_mint_claims');
    expect(plan.completion_takeover?.incumbent_pe_id).toBe(OFFCHAIN_PE);
    expect(plan.commit_takeover).toBeUndefined();
  });

  it('refuses a self-takeover, a user mismatch, and the wrong claim kind', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    const incumbentClaim = await seedIncumbent(db);
    expect(() => prepareCompletionTakeoverPlan({
      incumbentClaim, newOwnerPeId: OFFCHAIN_PE, newOwnerUserId: USER, nowMs: NOW,
    })).toThrow('completion_takeover_self');
    expect(() => prepareCompletionTakeoverPlan({
      incumbentClaim, newOwnerPeId: ONCHAIN_PE, newOwnerUserId: 'other-user', nowMs: NOW,
    })).toThrow('completion_takeover_user_mismatch');
    expect(() => prepareCompletionTakeoverPlan({
      incumbentClaim: { ...incumbentClaim, claim_kind: 'commit' },
      newOwnerPeId: ONCHAIN_PE, newOwnerUserId: USER, nowMs: NOW,
    })).toThrow('completion_takeover_wrong_kind');
  });
});

describe('inspectPreparedCompletionTakeoverInTransaction — the in-txn race guards', () => {
  async function runInspect(db: Firestore, plan: ReturnType<typeof prepareCompletionTakeoverPlan>) {
    return db.runTransaction((txn) => inspectPreparedCompletionTakeoverInTransaction(db, txn, plan));
  }

  it('happy path returns the overwrite + demotion decision, and applying it re-owns + demotes', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    const incumbentClaim = await seedIncumbent(db);
    const plan = prepareCompletionTakeoverPlan({
      incumbentClaim, newOwnerPeId: ONCHAIN_PE, newOwnerUserId: USER, nowMs: NOW + 1,
    });
    const decision = await runInspect(db, plan);
    expect(decision.incumbentPeId).toBe(OFFCHAIN_PE);
    expect(decision.newOwnerClaim.owner_pe_id).toBe(ONCHAIN_PE);

    await db.runTransaction(async (txn) => {
      applyCompletionTakeoverDecision(db, txn, decision, NOW + 1);
    });
    const claimAfter = await db.collection('completion_mint_claims').doc(incumbentClaim.claim_id).get();
    expect((claimAfter.data() as Record<string, unknown>).owner_pe_id).toBe(ONCHAIN_PE);
    const incAfter = (await db.collection(PE_HISTORY_COLLECTION).doc(OFFCHAIN_PE).get()).data() as Record<string, unknown>;
    expect(incAfter.mint_status).toBe('corroborated_duplicate');
    expect(incAfter.completion_takeover_demoted_by_pe_id).toBe(ONCHAIN_PE);
    // The sealed snapshot is untouched.
    expect(incAfter.economic_snapshot).toEqual({ recordTimeFactors: { baseActionWeightBps: 10_000 } });
  });

  it('RED (crash/replay): the incumbent DEMOTED mid-flight → MintOnceClaimRaceError', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    const incumbentClaim = await seedIncumbent(db);
    const plan = prepareCompletionTakeoverPlan({
      incumbentClaim, newOwnerPeId: ONCHAIN_PE, newOwnerUserId: USER, nowMs: NOW + 1,
    });
    await db.collection(PE_HISTORY_COLLECTION).doc(OFFCHAIN_PE).update({ mint_status: 'corroborated_duplicate' });
    await expect(runInspect(db, plan)).rejects.toBeInstanceOf(MintOnceClaimRaceError);
  });

  it('RED (crash/replay): the incumbent REGISTERED for settlement mid-flight → race (never strand)', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    const incumbentClaim = await seedIncumbent(db);
    const plan = prepareCompletionTakeoverPlan({
      incumbentClaim, newOwnerPeId: ONCHAIN_PE, newOwnerUserId: USER, nowMs: NOW + 1,
    });
    await registerClaim(db as unknown as SettlementDb, standardClaim(OFFCHAIN_PE), NOW);
    expect((await db.collection(CLAIM_LEDGER_COLLECTION).doc(claimKeyOf(OFFCHAIN_PE, 'sole')).get()).exists).toBe(true);
    await expect(runInspect(db, plan)).rejects.toBeInstanceOf(MintOnceClaimRaceError);
    // …and the incumbent is untouched in both dimensions: the sealed value stands.
    const after = (await db.collection(PE_HISTORY_COLLECTION).doc(OFFCHAIN_PE).get()).data() as Record<string, unknown>;
    expect(after.mint_status).toBe('eligible');
    expect(after.economic_snapshot).toEqual({ recordTimeFactors: { baseActionWeightBps: 10_000 } });
  });

  it('RED (crash/replay): the claim doc RE-OWNED by a third party mid-flight → race', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    const incumbentClaim = await seedIncumbent(db);
    const plan = prepareCompletionTakeoverPlan({
      incumbentClaim, newOwnerPeId: ONCHAIN_PE, newOwnerUserId: USER, nowMs: NOW + 1,
    });
    await db.collection('completion_mint_claims').doc(incumbentClaim.claim_id).set({
      ...incumbentClaim, owner_pe_id: 'pe-third-party',
    } as unknown as FirebaseFirestore.DocumentData);
    await expect(runInspect(db, plan)).rejects.toBeInstanceOf(MintOnceClaimRaceError);
  });

  it('RED (crash/replay): the incumbent that became an ON-CHAIN witness mid-flight → race', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    const incumbentClaim = await seedIncumbent(db);
    const plan = prepareCompletionTakeoverPlan({
      incumbentClaim, newOwnerPeId: ONCHAIN_PE, newOwnerUserId: USER, nowMs: NOW + 1,
    });
    await db.collection(PE_HISTORY_COLLECTION).doc(OFFCHAIN_PE).update({ completion_witness: 'onchain_release' });
    await expect(runInspect(db, plan)).rejects.toBeInstanceOf(MintOnceClaimRaceError);
  });
});
