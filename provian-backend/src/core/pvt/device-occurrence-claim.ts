/** Exact read-only preparation for a BODY-BOUND device-witnessed occurrence mint claim. */

import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { NoveltyCounterConflictError } from '../meter/batch-pricing-counters';
import { METER_KEY_LIFETIME_MS } from '../meter/meter-constants';
import { expireAt } from '../meter/meter-store';
import {
  prepareMintOnceClaim,
  type PreparedMintOnceClaim,
} from './mint-once-claim';

/**
 * the HARD per-occurrence mint-once for a body-bound device-witnessed
 * compute PE (the residual (b) fix). Build A gave these families only the SOFT
 * per-UTC-day artifact-novelty claim, which never forces `exactDuplicate`, so an
 * identical body-bound replay minted AGAIN — decayed to a 0.3× floor with no
 * lifetime cap, and the day scope reset the `uniqueArtifact` flag. This claim is
 * the exact parallel of the sovereign occurrence claim : the first PE to
 * claim (economic actor, canonical-event digest) mints; a replay of the same
 * canonical event records for chain integrity but earns 0 PVT
 * (`exactDuplicate` → novelty 0 → `corroborated_duplicate`).
 *
 * `canonicalEventHash` is the sha256 of the canonical event id the
 * device-witnessed overlay derives (`deviceWitnessedCanonicalEvent`), so the key
 * is a fixed 64-hex charset — no regex-stranding risk from an arbitrary
 * trace/session id, and it is byte-identical between the co-committed intake row
 * and the live accrual because both are built from the same overlay output.
 *
 * Prepared read-only here; `writePEHistory` commits the returned canonical claim
 * together with the PE row (or rejects a concurrent race), exactly as every other
 * mint-once kind.
 */
export async function prepareDeviceOccurrenceMintClaim(
  db: Firestore,
  userId: string,
  canonicalEventHash: string,
  peId: string,
  nowMs = Date.now(),
): Promise<PreparedMintOnceClaim> {
  return prepareMintOnceClaim(db, {
    kind: 'device_occurrence',
    subjectId: userId,
    eventId: canonicalEventHash,
    peId,
    userId,
    nowMs,
  });
}

/**
 * True when the single-lane occurrence is already claimed by ANY act. A single-lane act keeps no act
 * key, and its relay id derives from its client-supplied pe_hash, so "the claim names this same
 * relay id" is not evidence of a re-read of the same act — on the single-lane cut an existing claim
 * is always a duplicate.
 */
export async function singleLaneOccurrenceClaimed(
  db: Pick<Firestore, 'collection'>,
  plan: PreparedMintOnceClaim,
): Promise<boolean> {
  return (await db.collection(plan.claim_collection).doc(plan.evidence.claim.claim_id).get()).exists;
}

/**
 * Cross-batch mint-once for a single witness lane. An act takes no act
 * key and no per-act transaction, so its occurrence claim rides the BATCH commit's transaction as a
 * pricing-counter hook: `inspect` re-reads the claim there and, if another act took it after
 * pricing read it absent, throws the novelty conflict — the batch reprices, the claim is now
 * present, and this act seals `exactDuplicate` (0 PVT). `commit` creates it with the batch,
 * expiring with every other meter mint-once claim (occurrence + 31 days, one day past the 30-day
 * mint window; nothing in the meter accumulates per act forever). A human_approval's
 * once-ever rests on the request's own seal stamp, not on this claim. Only an OWNER plan (the claim
 * was absent at pricing) becomes a hook.
 */
export function singleLaneOccurrenceClaimHook(
  db: Pick<Firestore, 'collection'>,
  plan: PreparedMintOnceClaim,
  occurrenceAtMs: number,
): { inspect(txn: Transaction): Promise<void>; commit(txn: Transaction): void } {
  if (plan.evidence.relation !== 'owner') throw new Error('single_lane_occurrence_claim_not_owner');
  const claim = plan.evidence.claim;
  const ref = db.collection(plan.claim_collection).doc(claim.claim_id);
  let create = false;
  return {
    async inspect(txn) {
      // Any existing claim — even one naming this relay id, which a later act can reproduce from its
      // client-supplied pe_hash — means the occurrence is taken: reprice (it now reads duplicate).
      const snap = await txn.get(ref);
      if (snap.exists) throw new NoveltyCounterConflictError();
      create = true;
    },
    commit(txn) {
      if (create) txn.create(ref, { ...claim, expire_at: expireAt(occurrenceAtMs + METER_KEY_LIFETIME_MS) });
    },
  };
}
