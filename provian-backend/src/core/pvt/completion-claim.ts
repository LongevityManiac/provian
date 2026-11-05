/**
 * the COMPLETION mint-once claim: one job completion mints ONCE across
 * its two witnesses.
 *
 * ── THE TWO WITNESSES OF ONE ACT ─────────────────────────────────────────────
 * A delivered job can be witnessed twice:
 *
 * (1) ON-CHAIN — the escrow release the institution-completion watcher
 * observes on Base (`EscrowReleased[PVT]` → `escrow_completed` to the
 * recipient; `EscrowResolved[PVT]` released to the recipient →
 * `escrow_resolved`). Chain finality is the evidence; the row seals
 * eligible at record time and mints on the standard lane. This is
 * the BEST-SUPPORTED witness: it keeps paying exactly as it does today.
 *
 * (2) OFF-CHAIN — the poster's counterparty confirmation. The deliverer's
 * `human_job_delivered` PE is the work record; the poster's
 * `human_job_completed` PE is the CORROBORATION of that work, not a second
 * act. The pending-evidence resolver verifies the confirmation against the
 * job document and promotes the deliverer's row (`completion-verifier.ts`).
 * the standing rule : a genuinely completed job earns whether or not
 * an on-chain release exists.
 *
 * Both witnesses claim THIS kind on the SAME document, so whichever arrives
 * first owns the slot and the other records for chain integrity and mints 0 —
 * or, when the off-chain witness arrived first and is still eligible and
 * unregistered, the on-chain witness TAKES OVER the slot (`completion-
 * takeover.ts`), so the value paid is the best-supported one, never the sum.
 *
 * ── THE CANONICAL COMPLETION ID (the exact form, so both sides agree) ─────────
 * `escrow:<escrow_id>` the relay's escrow DOCUMENT id
 * (`esc_<uuid>`), whenever the job carries
 * an escrow. The off-chain side reads it
 * off the job document; the on-chain side
 * resolves it from the observed bytes32
 * id through `escrows.onchain_escrow_id`
 * (pinned at funding, `verifyFunding`).
 * Deliberately NOT the on-chain bytes32:
 * the relay does not derive that id
 * (the depositor chooses it and the relay
 * learns it from the funding receipt), so
 * keying on it would let a confirmation
 * recorded BEFORE funding and a release
 * recorded AFTER it land on two documents.
 * `human_job:<job_id>` a job with NO escrow (`hjob_<uuid>`):
 * only the off-chain witness can exist.
 * `escrow_onchain:<chainId>:<bytes32>` an on-chain release whose escrow the
 * relay never recorded. No off-chain
 * witness can exist for it, so the key
 * only needs to be stable across replays.
 *
 * Subject is the BENEFICIARY economic actor (`owner_user_id`): the recipient's
 * `agent_id` on the watcher side (`agent_wallets` by address) and the sealed
 * `human_job_delivered` row's `userId` on the resolver side — the same value for
 * one agent, so the documents collide. A HUMAN deliverer is never resolved by
 * the watcher (it reads `agent_wallets` only), so for a human the off-chain
 * witness is the only payer and no collision is needed.
 *
 * Prepared read-only here; committed by `writePEHistory` (the watcher's row)
 * or by the resolver's promotion transaction, exactly as every other kind.
 */

import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import {
  prepareMintOnceClaim,
  type PreparedMintOnceClaim,
} from './mint-once-claim';

/** Which witness of a completion a row carries. Persisted on `pe_history`. */
export type CompletionWitness = 'onchain_release' | 'counterparty_confirmation';

const ESCROW_ID = /^esc_[A-Za-z0-9-]{1,120}$/;
const HUMAN_JOB_ID = /^hjob_[A-Za-z0-9-]{1,120}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
/** A mobile promise id is a client-minted UUID (uuidv4) shared by the two parties. */
const PROMISE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$/;

export function completionCanonicalIdForEscrow(escrowId: string): string {
  const id = escrowId.trim();
  if (!ESCROW_ID.test(id)) throw new Error('completion_canonical_escrow_id_invalid');
  return `escrow:${id.toLowerCase()}`;
}

export function completionCanonicalIdForHumanJob(jobId: string): string {
  const id = jobId.trim();
  if (!HUMAN_JOB_ID.test(id)) throw new Error('completion_canonical_job_id_invalid');
  return `human_job:${id.toLowerCase()}`;
}

/**
 * (F-A1-3) — the canonical completion id for a mobile P2P promise. A
 * promise mints once PER PARTY, so the slot is per (actor, promise): each of the
 * two distinct-owner parties who fulfilled their side claims their own slot, and
 * neither party can mint twice for the same promise. Deliberately shares the
 * `promise:` namespace across a promise's two fulfillment PEs so a re-submitted
 * fulfillment by the SAME actor collides on the SAME slot.
 */
export function completionCanonicalIdForPromise(promiseId: string): string {
  const id = promiseId.trim();
  if (!PROMISE_ID.test(id)) throw new Error('completion_canonical_promise_id_invalid');
  return `promise:${id.toLowerCase()}`;
}

export function completionCanonicalIdForOnchainEscrow(chainId: number, onchainEscrowId: string): string {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error('completion_canonical_chain_id_invalid');
  }
  const id = onchainEscrowId.trim();
  if (!BYTES32.test(id)) throw new Error('completion_canonical_onchain_id_invalid');
  return `escrow_onchain:${chainId}:${id.toLowerCase()}`;
}

/**
 * The document id the claim lands on — `sha256(subject:event)` exactly as
 * `mint-once-claim.ts::claimIdFor` derives it for a non-artifact kind (subject
 * trimmed, event lowercased). Mirrors `commitClaimDocId`.
 */
export function completionClaimDocId(userId: string, canonicalId: string): string {
  return crypto.createHash('sha256')
    .update(`${userId.trim()}:${canonicalId.trim().toLowerCase()}`)
    .digest('hex');
}

/**
 * Prepare without mutating Firestore. The caller commits the returned
 * canonical claim together with its pe_history write, or rejects a concurrent
 * race, exactly as every other mint-once kind.
 */
export async function prepareCompletionMintClaim(
  db: Firestore,
  userId: string,
  canonicalId: string,
  peId: string,
  nowMs = Date.now(),
): Promise<PreparedMintOnceClaim> {
  return prepareMintOnceClaim(db, {
    kind: 'completion',
    subjectId: userId,
    eventId: canonicalId,
    peId,
    userId,
    nowMs,
  });
}

/**
 * The ON-CHAIN side's derivation of the canonical completion id for an escrow
 * release: the relay escrow whose pinned `onchain_escrow_id` is the observed
 * bytes32 id. Read-only.
 *
 *  - exactly one relay escrow pins this on-chain id → `escrow:<escrow_id>`, the
 *    same key the off-chain witness derives from the job document;
 *  - none → `escrow_onchain:<chainId>:<bytes32>` (no relay escrow, so no
 *    off-chain witness can exist; the key only has to be replay-stable);
 *  - more than one → THROW. Two relay escrows pinning one on-chain id is the
 *    exact double-credit `escrow_fund_locks` exists to prevent; a claim keyed
 *    on a guess could pay one job's completion against another's. The emitter
 *    fails the emission (no lock, no PE) and the watcher retries the block.
 */
export async function resolveEscrowCompletionCanonicalId(
  db: Firestore,
  chainId: number,
  onchainEscrowId: string,
): Promise<string> {
  const id = onchainEscrowId.trim().toLowerCase();
  if (!BYTES32.test(id)) throw new Error('completion_canonical_onchain_id_invalid');
  const snap = await db.collection('escrows')
    .where('onchain_escrow_id', '==', id)
    .limit(2)
    .get();
  if (snap.docs.length > 1) {
    throw new Error('completion_canonical_escrow_ambiguous');
  }
  if (snap.docs.length === 1) {
    const data = snap.docs[0].data() as { escrow_id?: unknown } | undefined;
    const escrowId = typeof data?.escrow_id === 'string' ? data.escrow_id : snap.docs[0].id;
    return completionCanonicalIdForEscrow(escrowId);
  }
  return completionCanonicalIdForOnchainEscrow(chainId, id);
}
