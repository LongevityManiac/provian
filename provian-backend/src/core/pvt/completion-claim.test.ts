/**
 * the `completion` mint-once claim: binding, canonical-id derivation,
 * and the on-chain side's escrow → canonical-id resolution. Each guard is shown
 * FAILING on a violating input, never only green.
 */

import { describe, it, expect } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import {
  completionCanonicalIdForEscrow,
  completionCanonicalIdForHumanJob,
  completionCanonicalIdForOnchainEscrow,
  completionClaimDocId,
  prepareCompletionMintClaim,
  resolveEscrowCompletionCanonicalId,
} from './completion-claim';
import {
  mintOnceClaimCollectionFor,
  parseClaim,
  MINT_ONCE_CLAIM_SCHEMA_VERSION,
} from './mint-once-claim';

const USER = 'agent_deliverer';
const ESCROW = 'esc_22222222-2222-4222-8222-222222222222';
const JOB = 'hjob_11111111-1111-4111-8111-111111111111';
const ONCHAIN = `0x${'ab'.repeat(32)}`;
const NOW = 1_800_000_000_000;

describe('the canonical completion id — the exact forms both witnesses derive', () => {
  it('escrow / human_job / escrow_onchain forms, lowercased', () => {
    expect(completionCanonicalIdForEscrow(ESCROW)).toBe(`escrow:${ESCROW}`);
    expect(completionCanonicalIdForHumanJob(JOB)).toBe(`human_job:${JOB}`);
    expect(completionCanonicalIdForOnchainEscrow(8453, ONCHAIN.toUpperCase().replace('0X', '0x')))
      .toBe(`escrow_onchain:8453:${ONCHAIN}`);
  });

  it('RED: a malformed id is refused, never coerced', () => {
    expect(() => completionCanonicalIdForEscrow('hjob_notanescrow')).toThrow('completion_canonical_escrow_id_invalid');
    expect(() => completionCanonicalIdForHumanJob('esc_notajob')).toThrow('completion_canonical_job_id_invalid');
    expect(() => completionCanonicalIdForOnchainEscrow(8453, '0x1234')).toThrow('completion_canonical_onchain_id_invalid');
    expect(() => completionCanonicalIdForOnchainEscrow(0, ONCHAIN)).toThrow('completion_canonical_chain_id_invalid');
  });
});

describe('the claim binding — (beneficiary economic actor, canonical completion id)', () => {
  it('prepares an OWNER plan in the completion collection with the commit-shaped subject', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    const plan = await prepareCompletionMintClaim(db, USER, `escrow:${ESCROW}`, 'pe-delivery', NOW);
    expect(plan.claim_collection).toBe(mintOnceClaimCollectionFor('completion'));
    expect(plan.claim_collection).toBe('completion_mint_claims');
    expect(plan.evidence.relation).toBe('owner');
    expect(plan.evidence.claim.claim_kind).toBe('completion');
    expect(plan.evidence.claim.subject_id).toBe(USER);
    expect(plan.evidence.claim.owner_user_id).toBe(USER);
    expect(plan.evidence.claim.event_id).toBe(`escrow:${ESCROW}`);
    // The document id is the one derivation `mint-once-claim.ts` uses, so the
    // helper and the kernel can never disagree about where a claim lands.
    expect(plan.evidence.claim.claim_id).toBe(completionClaimDocId(USER, `escrow:${ESCROW}`));
  });

  it('a second witness of the SAME job for the SAME beneficiary is a duplicate', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    const first = await prepareCompletionMintClaim(db, USER, `escrow:${ESCROW}`, 'pe-delivery', NOW);
    await db.collection(first.claim_collection).doc(first.evidence.claim.claim_id)
      .set({ ...first.evidence.claim } as unknown as FirebaseFirestore.DocumentData);
    const second = await prepareCompletionMintClaim(db, USER, `escrow:${ESCROW}`, 'pe-release', NOW + 1);
    expect(second.evidence.relation).toBe('duplicate');
    expect(second.evidence.claim.owner_pe_id).toBe('pe-delivery');
  });

  it('RED: a different beneficiary or a different job is a different slot', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    const first = await prepareCompletionMintClaim(db, USER, `escrow:${ESCROW}`, 'pe-delivery', NOW);
    await db.collection(first.claim_collection).doc(first.evidence.claim.claim_id)
      .set({ ...first.evidence.claim } as unknown as FirebaseFirestore.DocumentData);
    const otherUser = await prepareCompletionMintClaim(db, 'agent_other', `escrow:${ESCROW}`, 'pe-x', NOW);
    expect(otherUser.evidence.relation).toBe('owner');
    const otherJob = await prepareCompletionMintClaim(db, USER, `human_job:${JOB}`, 'pe-y', NOW);
    expect(otherJob.evidence.relation).toBe('owner');
  });

  it('RED: the kernel refuses a completion claim whose subject is not the owner or whose event is malformed', () => {
    const base = {
      schema_version: MINT_ONCE_CLAIM_SCHEMA_VERSION,
      claim_kind: 'completion',
      subject_id: USER,
      event_id: `escrow:${ESCROW}`,
      scope_id: null,
      owner_pe_id: 'pe-delivery',
      owner_user_id: USER,
      created_at_ms: NOW,
    };
    const valid = { ...base, claim_id: completionClaimDocId(USER, `escrow:${ESCROW}`) };
    expect(() => parseClaim(valid)).not.toThrow();
    // Subject must BE the owner (the commit shape), never a third party.
    const wrongSubject = { ...base, subject_id: 'someone_else' };
    expect(() => parseClaim({
      ...wrongSubject, claim_id: completionClaimDocId('someone_else', `escrow:${ESCROW}`),
    })).toThrow('mint_once_claim_completion_binding_invalid');
    // The event must be one of the three canonical forms.
    const badEvent = { ...base, event_id: 'txhash:0xdeadbeef' };
    expect(() => parseClaim({
      ...badEvent, claim_id: completionClaimDocId(USER, 'txhash:0xdeadbeef'),
    })).toThrow('mint_once_claim_completion_binding_invalid');
  });
});

describe('resolveEscrowCompletionCanonicalId — the on-chain side agrees with the off-chain side', () => {
  it('one relay escrow pinning the bytes32 id → the SAME `escrow:<escrow_id>` the job document yields', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    await db.collection('escrows').doc(ESCROW).set({
      escrow_id: ESCROW, onchain_escrow_id: ONCHAIN, status: 'completed',
    });
    expect(await resolveEscrowCompletionCanonicalId(db, 8453, ONCHAIN))
      .toBe(completionCanonicalIdForEscrow(ESCROW));
  });

  it('no relay escrow → the chain-qualified form (replay-stable; no off-chain witness can exist)', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    expect(await resolveEscrowCompletionCanonicalId(db, 8453, ONCHAIN))
      .toBe(`escrow_onchain:8453:${ONCHAIN}`);
  });

  it('RED: two relay escrows pinning one on-chain id THROW — a guessed key could pay one job against another', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    await db.collection('escrows').doc('esc_a').set({ escrow_id: 'esc_a', onchain_escrow_id: ONCHAIN });
    await db.collection('escrows').doc('esc_b').set({ escrow_id: 'esc_b', onchain_escrow_id: ONCHAIN });
    await expect(resolveEscrowCompletionCanonicalId(db, 8453, ONCHAIN))
      .rejects.toThrow('completion_canonical_escrow_ambiguous');
  });

  it('RED: a malformed on-chain id is refused before any read', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    await expect(resolveEscrowCompletionCanonicalId(db, 8453, '0xnope'))
      .rejects.toThrow('completion_canonical_onchain_id_invalid');
  });
});
