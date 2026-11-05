import { privateRetentionCollection } from '../provenance/private-retention';
/**
 * THE VERIFIER for the `verified_substantive_outcome` evidence class:
 * a job's OFF-CHAIN counterparty confirmation, bound to the exact job, poster
 * and delivery it confirms.
 *
 * ── FRANK'S RULING (, 2026-08-09; the open question answered 2026-09-03) ──
 * One act, one mint, at the best-supported value. A counterparty completion
 * CORROBORATES the deliverer's already-captured work PE — it lifts, it never
 * double-pays. A genuinely completed job earns whether or not an on-chain
 * escrow release exists; escrow-released jobs keep paying exactly as today.
 *
 * ── THE EVIDENCE MODEL, TYPE BY TYPE ─────────────────────────────────────────
 * `human_job_delivered` the deliverer's WORK PE (`core/commons/human-jobs.ts::
 * deliverHumanJob`; `metadata.job_id`, `counterparty_address` = the poster).
 * VERIFIED when ALL of:
 * (a) the job document names THIS PE as its delivery (`completion_pe_id`),
 * THIS wallet as the accepted applicant, a poster distinct from the
 * applicant, and a status a completed delivery can be in
 * (`in_progress` confirmed, payout pending — or `completed`; never
 * `disputed` / `cancelled` / `refunded` / `open`);
 * (b) the poster's CONFIRMATION exists — `completeHumanJob` stamps
 * `poster_confirmed_at` and pins `confirmation_pe_id`, the poster's
 * `human_job_completed` PE — and that PE binds back: same job id, the
 * poster's wallet, a different economic actor than the deliverer;
 * (c) the poster is a DISTINCT OWNER from the deliverer — the SAME
 * `detectSameOwnerTransfer` the record path runs ("the same-
 * owner fence + a distinct real counterparty is the ENTIRE anti-self-
 * dealing guarantee"). Self-dealing refuses by name and mints 0; a
 * registry read that FAILS refuses as a verifier error (fail closed),
 * never as "not self-dealing";
 * (d) the job's escrow, when it has one, is not disputed / refunded /
 * cancelled (those outcomes contradict a completion);
 * (e) the `completion` mint-once slot for (deliverer, canonical completion
 * id) is not already owned by ANOTHER PE — the on-chain release paid
 * it already (the best-supported witness keeps paying exactly as
 * today, and the off-chain path must not pay again).
 * On PROMOTE the resolver flips the row to eligible, claims the slot, and
 * stamps the confirmation as the row's corroboration (the lift, windowed by
 * the kernel's 72h enhancement rule — scoping verbatim).
 *
 * `human_job_completed` the POSTER's confirmation. Corroboration, never a
 * second act: refused BY NAME, never promoted. (It also never reaches the
 * durable path — `completeHumanJob` carries no durable marker — so it seals
 * record_only; this refusal is the second lock on the same door.)
 *
 * `job_delivered` the agent job board. Every agent job carries an escrow
 * (`acceptApplicant` creates it), so its completion IS the escrow release,
 * which the completion watcher pays as verified `escrow_completed`. There is
 * no poster confirmation record for it; refused by name.
 *
 * `promise_fulfilled` a mobile P2P promise (`PromiseService.ts`). VERIFIED
 * when the relay's wallet-bound `human_promises` close-out record holds BOTH
 * parties' EIP-191 close-out signatures for the same `promise_id`, those two
 * parties are exactly this PE's actor and its named counterparty, AND that
 * counterparty is a distinct owner (`verifyPromiseFulfilled`;). The
 * close-out record moved to the relay under human wallet auth with REAL wallet
 * signatures, so it IS the witness of record — the old forgeable Firebase-
 * anonymous `promise_sync` witness is gone. A self-claim mints 0.
 *
 * `goal_envelope_completed` a Goal Envelope is the human's own policy
 * authorizing THEIR OWN linked agent (`GoalPolicyManager.ts`). Its completion
 * is self-directed: the only conceivable confirmer is the same beneficial
 * owner, so no distinct-counterparty confirmation can exist. Refused by name
 * (`verifyGoalEnvelopeCompleted`); the agent's underlying work is priced
 * through its own PEs and credited by the record_only agent_work_delegated PE.
 *
 * anything else in the class (`agreement_settled`, a future type) — no
 * verifier; refused by name so nothing is guessed at.
 *
 * Every read is a direct document read (job → confirmation PE), never a
 * metadata query; the poster's PE id is pinned on the job by `completeHumanJob`
 * precisely so this binding is a lookup and not a search.
 */

import { METER_ACT_KEYS_COLLECTION, METER_HELD_ACTS_COLLECTION } from '../meter/meter-store';
import type { MeterActKeyDoc } from '../meter/meter-act-key';
import type admin from 'firebase-admin';
import { ClosedCrossWitnessOccurrenceError, type PreparedMintOnceClaim } from './mint-once-claim';
import {
  completionCanonicalIdForEscrow,
  completionCanonicalIdForHumanJob,
  completionCanonicalIdForPromise,
  prepareCompletionMintClaim,
} from './completion-claim';
import { detectSameOwnerTransfer, isResolvableCounterpartyAddress } from './policy/same-owner-detection';
import { HUMAN_PROMISES_COLLECTION, type HumanPromiseDocument } from '../human-promises/types';
import { verifyHumanPromiseSignature } from '../human-promises/promise-signing';

/** The minimal held-row facts this verifier reads. */
export interface CompletionVerificationRow {
  readonly peId: string;
  readonly userId: string;
  readonly actionType: string;
  readonly timestamp: number;
}

/** Everything the resolver needs to PROMOTE a verified off-chain completion. */
export interface CompletionPromotionFacts {
  readonly jobId: string;
  readonly posterWalletId: string;
  /** The `completion` mint-once claim key; see `completion-claim.ts`. */
  readonly canonicalId: string;
  /** The poster's `human_job_completed` PE — the corroboration. */
  readonly confirmationPeId: string;
  /** The confirmation's sealed record instant — the authoritative observation time. */
  readonly confirmationTimestampMs: number;
  /** Read-only prepared claim (relation `owner`); committed by the resolver's transaction. */
  readonly claim: PreparedMintOnceClaim;
}

export type CompletionVerification =
  | { readonly kind: 'promote'; readonly facts: CompletionPromotionFacts }
  /** The poster has not confirmed (yet). Stays pending; re-judged each pass. */
  | { readonly kind: 'awaiting'; readonly reason: string }
  | {
    readonly kind: 'refused';
    readonly outcome:
      | 'refused_no_verifier_for_class'
      | 'refused_completion_binding'
      | 'refused_completion_self_dealing'
      /**
       * the poster's address is absent or is
       * not a well-formed EVM address (a wallet id persisted as
       * `poster_address`), so the distinct-owner fence CANNOT run. Unknown =
       * Block — never "distinct owner". Stays pending, never promoted.
       */
      | 'refused_completion_counterparty_unresolvable'
      | 'refused_canonical_event_already_minted'
      | 'refused_verifier_error';
    readonly reason: string;
  };

/** The Commons job document fields this verifier reads (`core/commons/types.ts::HumanJob`). */
interface HumanJobFacts {
  readonly poster_wallet_id: string;
  readonly poster_address: string | null;
  readonly accepted_applicant_wallet_id: string | null;
  readonly completion_pe_id: string | null;
  readonly status: string;
  readonly escrow_id: string | null;
  readonly poster_confirmed_at: number | null;
  readonly confirmation_pe_id: string | null;
}

/** The sealed-envelope fields this verifier reads (`agent-bank/pe-utils.ts::buildStoredDoc`). */
interface EnvelopeFacts {
  readonly action_type: string;
  readonly wallet_id: string;
  readonly user_id: string;
  readonly timestamp: number;
  readonly counterparty_address: string | null;
  readonly job_id: string | null;
  /** Top-level `promise_id` a `promise_completion_premium` PE carries (server.ts:8066). */
  readonly promise_id: string | null;
  /** The actor's resolved EVM address (mobile submit sets `actor_address`). */
  readonly actor_address: string | null;
}

const HUMAN_JOBS_COLLECTION = 'commons_human_jobs';
const ENVELOPES_COLLECTION = 'provenance_envelopes';
const ESCROWS_COLLECTION = 'escrows';

/** Job statuses a genuinely completed delivery can be observed in. */
const COMPLETABLE_JOB_STATUSES: ReadonlySet<string> = new Set(['in_progress', 'completed']);
/** Escrow statuses that CONTRADICT a completion. */
const CONTRADICTING_ESCROW_STATUSES: ReadonlySet<string> = new Set(['disputed', 'refunded', 'cancelled']);

/**
 * Classes in this family that have NO server-verifiable counterparty
 * confirmation today, each with the reason it is refused. Stated as data so the
 * refusal names the missing verifier rather than saying "unsupported".
 */
export const SUBSTANTIVE_OUTCOME_NO_VERIFIER_REASONS: Readonly<Record<string, string>> = Object.freeze({
  human_job_completed:
    'completion_confirmation_is_corroboration_not_an_act: the poster\'s confirmation lifts the '
    + 'deliverer\'s human_job_delivered and never mints on its own',
  job_delivered:
    'completion_agent_job_settles_via_escrow_release: every agent-board job carries an escrow, so '
    + 'its completion is the on-chain release the completion watcher pays as escrow_completed',
  // `promise_fulfilled` now has a verifier (`verifyPromiseFulfilled`); it is no
  // longer refused by class. It is intentionally NOT in this table.
  goal_envelope_completed:
    'goal_envelope_is_self_directed_no_distinct_counterparty: a Goal Envelope is the human\'s own '
    + 'policy authorizing THEIR OWN linked agent, so its completion has no distinct counterparty to '
    + 'confirm it (the same beneficial owner); the agent\'s underlying work is priced through its '
    + 'own PEs and credited by the record_only agent_work_delegated PE — an unverifiable self-claim '
    + 'mints 0',
});

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readJob(data: Record<string, unknown> | undefined): HumanJobFacts | null {
  if (data === undefined) return null;
  const poster = str(data.poster_wallet_id);
  const status = str(data.status);
  if (poster === null || status === null) return null;
  return {
    poster_wallet_id: poster,
    poster_address: str(data.poster_address),
    accepted_applicant_wallet_id: str(data.accepted_applicant_wallet_id),
    completion_pe_id: str(data.completion_pe_id),
    status,
    escrow_id: str(data.escrow_id),
    poster_confirmed_at: typeof data.poster_confirmed_at === 'number'
      && Number.isFinite(data.poster_confirmed_at)
      ? data.poster_confirmed_at
      : null,
    confirmation_pe_id: str(data.confirmation_pe_id),
  };
}

function readEnvelope(data: Record<string, unknown> | undefined): EnvelopeFacts | null {
  if (data === undefined) return null;
  const actionType = str(data.action_type);
  const walletId = str(data.wallet_id);
  const userId = str(data.user_id);
  const timestamp = data.timestamp;
  if (actionType === null || walletId === null || userId === null
    || typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp)) {
    return null;
  }
  const metadata = typeof data.metadata === 'object' && data.metadata !== null
    ? data.metadata as Record<string, unknown>
    : {};
  return {
    action_type: actionType,
    wallet_id: walletId,
    user_id: userId,
    timestamp,
    counterparty_address: str(data.counterparty_address),
    job_id: str(metadata.job_id),
    // `promise_id` is a top-level PE field (server.ts:8066), not metadata.
    promise_id: str(data.promise_id),
    actor_address: str(data.actor_address),
  };
}


/**
 * The facts of one sealed act. PE METER: a metered act's identifier facts live on its act key
 * (`facts`, identifiers only) — or on its held-act record while it is held, which never expires;
 * a pre-meter act's on its envelope until the migration. Null when none is present or the facts are
 * malformed.
 */
async function readActFacts(db: admin.firestore.Firestore, peId: string): Promise<EnvelopeFacts | null> {
  const [key, held] = await Promise.all([
    privateRetentionCollection(db, METER_ACT_KEYS_COLLECTION).doc(peId).get(),
    privateRetentionCollection(db, METER_HELD_ACTS_COLLECTION).doc(peId).get(),
  ]);
  // A held act (including every pre-meter act the migration moved into a hold) carries its act
  // key, facts included, on the held-act record, which never expires.
  const keyDoc = key.exists
    ? key.data() as Partial<MeterActKeyDoc>
    : held.exists ? (held.data() as { key?: Partial<MeterActKeyDoc> }).key : undefined;
  if (keyDoc !== undefined) {
    const facts = keyDoc.facts;
    if (!facts || facts.wallet_id === null) return null;
    return {
      action_type: facts.action_type,
      wallet_id: facts.wallet_id,
      user_id: facts.user_id,
      timestamp: facts.timestamp,
      counterparty_address: facts.counterparty_address,
      job_id: facts.job_id,
      promise_id: facts.promise_id,
      actor_address: facts.actor_address,
    };
  }
  const snap = await db.collection(ENVELOPES_COLLECTION).doc(peId).get();
  return readEnvelope(snap.exists ? snap.data() : undefined);
}

/**
 * Verify ONE held `verified_substantive_outcome` row. Read-only apart from the
 * injected registries: it performs no writes, so the resolver can apply the
 * promotion transactionally.
 */
export async function verifySubstantiveOutcomeCompletion(
  db: admin.firestore.Firestore,
  row: CompletionVerificationRow,
  options: { readonly nowMs: number },
): Promise<CompletionVerification> {
  try {
    switch (row.actionType) {
      case 'human_job_delivered':
        return await verifyHumanJobDelivery(db, row, options);
      // F-A1-3 (second half): the two mobile-produced members of the class.
      case 'promise_fulfilled':
        return await verifyPromiseFulfilled(db, row, options);
      case 'goal_envelope_completed':
        return verifyGoalEnvelopeCompleted(row);
      default: {
        const named = SUBSTANTIVE_OUTCOME_NO_VERIFIER_REASONS[row.actionType];
        return {
          kind: 'refused',
          outcome: 'refused_no_verifier_for_class',
          reason: named
            ?? `no_verifier_substantive_outcome_confirmation_undefined_for_type: ${row.actionType}`,
        };
      }
    }
  } catch (error) {
    if (error instanceof ClosedCrossWitnessOccurrenceError) return {
      kind: 'refused', outcome: 'refused_canonical_event_already_minted', reason: 'canonical_event_ownership_preserved_at_cutover',
    };
    // Fail CLOSED. A read that threw is not evidence of anything.
    return {
      kind: 'refused',
      outcome: 'refused_verifier_error',
      reason: `completion_verifier_threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * F-A1-3 — `goal_envelope_completed`. A Goal Envelope is the human's own policy
 * authorizing THEIR OWN linked agent to pursue an outcome (GoalPolicyManager,
 * hard_confirm at selection). Its completion is a SELF-DIRECTED act: the only
 * conceivable "counterparty" is the human confirming their own agent, which is
 * the SAME beneficial owner — the exact self-dealing the completion class refuses.
 * There is therefore NO distinct-counterparty confirmation this can ever bind to;
 * the agent's underlying work is priced through its own PEs (and credited into the
 * human's chain by the record_only `agent_work_delegated` delegation PE), never a
 * second time here. So this verifier holds to the standard and correctly mints 0:
 * an unverifiable self-claim mints 0. It is a considered refusal,
 * not an unhandled type.
 */
function verifyGoalEnvelopeCompleted(row: CompletionVerificationRow): CompletionVerification {
  return {
    kind: 'refused',
    outcome: 'refused_no_verifier_for_class',
    reason: SUBSTANTIVE_OUTCOME_NO_VERIFIER_REASONS.goal_envelope_completed
      ?? `no_verifier_goal_envelope_self_directed: ${row.actionType}`,
  };
}

async function verifyHumanJobDelivery(
  db: admin.firestore.Firestore,
  row: CompletionVerificationRow,
  options: { readonly nowMs: number },
): Promise<CompletionVerification> {
  const refuse = (reason: string): CompletionVerification => ({
    kind: 'refused', outcome: 'refused_completion_binding', reason,
  });

  // (1) THE DELIVERY ENVELOPE — the sealed record, bound to the held row.
  const delivery = await readActFacts(db, row.peId);
  if (delivery === null) return refuse('delivery_envelope_missing_or_malformed');
  if (delivery.action_type !== 'human_job_delivered') return refuse('delivery_envelope_action_type_mismatch');
  if (delivery.user_id !== row.userId) return refuse('delivery_envelope_actor_mismatch');
  if (delivery.job_id === null) return refuse('delivery_envelope_job_id_missing');

  // (2) THE JOB DOCUMENT must agree with the delivery in every field it names.
  const jobSnap = await db.collection(HUMAN_JOBS_COLLECTION).doc(delivery.job_id).get();
  const job = readJob(jobSnap.exists ? jobSnap.data() : undefined);
  if (job === null) return refuse('job_missing_or_malformed');
  if (job.accepted_applicant_wallet_id !== delivery.wallet_id) return refuse('job_applicant_mismatch');
  if (job.completion_pe_id !== row.peId) return refuse('job_completion_pe_mismatch');
  if (job.poster_wallet_id === job.accepted_applicant_wallet_id) return refuse('job_poster_is_applicant');
  if (!COMPLETABLE_JOB_STATUSES.has(job.status)) return refuse(`job_status_not_completable: ${job.status}`);

  // (3) THE COUNTERPARTY CONFIRMATION — absent means not yet, never refused.
  if (job.poster_confirmed_at === null || job.confirmation_pe_id === null) {
    return { kind: 'awaiting', reason: 'awaiting_counterparty_confirmation' };
  }
  const confirmation = await readActFacts(db, job.confirmation_pe_id);
  if (confirmation === null) return refuse('confirmation_envelope_missing_or_malformed');
  if (confirmation.action_type !== 'human_job_completed') return refuse('confirmation_action_type_mismatch');
  if (confirmation.wallet_id !== job.poster_wallet_id) return refuse('confirmation_not_by_poster');
  if (confirmation.job_id !== delivery.job_id) return refuse('confirmation_job_id_mismatch');
  if (confirmation.user_id === row.userId) return refuse('confirmation_actor_is_deliverer');
  if (confirmation.timestamp < row.timestamp) return refuse('confirmation_predates_delivery');

  // (4) THE POSTER IS A DISTINCT OWNER. The same detector the record path ran,
  // re-run here against the registries as they stand now. No address → the
  // fence cannot run → refuse (the counterparty IS the anti-self-dealing
  // guarantee,); a failed read → refuse as an error, never as absence.
  //
  // "no address" includes a NON-EMPTY string
  // that is not a well-formed EVM address. `str()` rejected only the empty
  // string, so a wallet id persisted as `poster_address` (reachable through the
  // Commons session-token branch) passed this guard, `detectSameOwnerTransfer`
  // normalized it to null and answered `no_counterparty_address` with
  // `unresolvable:false`, and the branch below read that as "distinct owner" —
  // promoting a human's job delivered by their own linked agent, the exact
  // self-dealing forbids. Refused BY NAME now, and held (re-judged each
  // pass; never a claim, never a promotion).
  const posterAddress = delivery.counterparty_address ?? job.poster_address;
  if (!isResolvableCounterpartyAddress(posterAddress)) {
    return {
      kind: 'refused',
      outcome: 'refused_completion_counterparty_unresolvable',
      reason: posterAddress === null
        ? 'poster_address_unresolved'
        : 'poster_address_not_an_evm_address',
    };
  }
  const ownership = await detectSameOwnerTransfer(db, {
    economicActorId: row.userId,
    counterpartyAddress: posterAddress,
  });
  if (ownership.unresolvable) {
    return {
      kind: 'refused',
      outcome: 'refused_verifier_error',
      reason: `same_owner_check_unresolvable: ${ownership.reason}`,
    };
  }
  if (ownership.selfReferencing || ownership.sharedBeneficialOwnership) {
    return {
      kind: 'refused',
      outcome: 'refused_completion_self_dealing',
      reason: `completion_self_dealing: ${ownership.reason}`,
    };
  }

  // (5) THE ESCROW, when there is one, must not contradict the completion.
  if (job.escrow_id !== null) {
    const escrowSnap = await db.collection(ESCROWS_COLLECTION).doc(job.escrow_id).get();
    if (escrowSnap.exists) {
      const status = str((escrowSnap.data() as Record<string, unknown> | undefined)?.status);
      if (status !== null && CONTRADICTING_ESCROW_STATUSES.has(status)) {
        return refuse(`escrow_status_contradicts_completion: ${status}`);
      }
    }
  }

  // (6) THE MINT-ONCE SLOT. Prepared read-only; a slot already owned by ANOTHER
  // PE (the on-chain release) means the best-supported witness already paid.
  const canonicalId = job.escrow_id !== null
    ? completionCanonicalIdForEscrow(job.escrow_id)
    : completionCanonicalIdForHumanJob(delivery.job_id);
  const claim = await prepareCompletionMintClaim(db, row.userId, canonicalId, row.peId, options.nowMs);
  if (claim.evidence.relation === 'duplicate') {
    return {
      kind: 'refused',
      outcome: 'refused_canonical_event_already_minted',
      reason: `canonical_event_minted_by_${claim.evidence.claim.owner_pe_id}`,
    };
  }

  return {
    kind: 'promote',
    facts: {
      jobId: delivery.job_id,
      posterWalletId: job.poster_wallet_id,
      canonicalId,
      confirmationPeId: job.confirmation_pe_id,
      confirmationTimestampMs: confirmation.timestamp,
      claim,
    },
  };
}

/**
 * `promise_fulfilled`. A mobile P2P promise between two parties. The
 * witness of record is now the relay's WALLET-BOUND close-out record.
 *
 * ── THE WITNESS: the `human_promises` close-out record ───────────────────────
 * The human promise lifecycle moved from the forgeable Firebase-anonymous
 * `promise_sync` side-channel to `human_promises` on the relay, written only
 * under human wallet auth with REAL EIP-191 signatures. A `fulfilled` close-out
 * therefore carries BOTH parties' EIP-191 close-out signatures over the agreed
 * digest — neither side can forge the other's — so that record IS the safe,
 * address-bound proof that both parties mutually closed the promise. This
 * verifier promotes ONLY when:
 * (a) the row's own promise_fulfilled PE names a resolvable counterparty EVM
 * address the DISTINCT-OWNER fence clears (the entire anti-self-dealing
 * guarantee, kept exactly as before);
 * (b) the relay's close-out record for the same promise_id names EXACTLY this
 * PE's actor and its named counterparty as the two parties (binding the PE's
 * self-reported naming to the authoritative wallet-bound record); and
 * (c) BOTH parties' close-out signatures are present AND re-verify against their
 * party addresses over the record's digest (defense in depth — the witness
 * is re-checked, not merely trusted).
 * Absent both close-out signatures → awaiting (not yet closed out), never
 * refused. A self-claim (same beneficial owner) mints 0.
 */
async function verifyPromiseFulfilled(
  db: admin.firestore.Firestore,
  row: CompletionVerificationRow,
  options: { readonly nowMs: number },
): Promise<CompletionVerification> {
  const refuse = (reason: string): CompletionVerification => ({
    kind: 'refused', outcome: 'refused_completion_binding', reason,
  });

  // (1) THE FULFILLMENT ENVELOPE — the row's own sealed promise_fulfilled PE.
  const fulfillment = await readActFacts(db, row.peId);
  if (fulfillment === null) return refuse('promise_fulfillment_envelope_missing_or_malformed');
  if (fulfillment.action_type !== 'promise_fulfilled') return refuse('promise_fulfillment_action_type_mismatch');
  if (fulfillment.user_id !== row.userId) return refuse('promise_fulfillment_actor_mismatch');
  if (fulfillment.promise_id === null) return refuse('promise_fulfillment_promise_id_missing');

  // (2) THE NAMED COUNTERPARTY must be a resolvable EVM address — the party the
  // fence runs against. No address (a purely-local / legacy fulfillment PE that
  // never stamped `counterparty_address`) → the fence cannot run → Unknown =
  // Block. Fail closed, held, never promoted. The row's own actor address must be
  // resolvable too — it is one of the two parties of record.
  const counterpartyAddress = fulfillment.counterparty_address;
  if (!isResolvableCounterpartyAddress(counterpartyAddress)) {
    return {
      kind: 'refused',
      outcome: 'refused_completion_counterparty_unresolvable',
      reason: counterpartyAddress === null
        ? 'promise_counterparty_address_unresolved'
        : 'promise_counterparty_address_not_an_evm_address',
    };
  }
  if (!isResolvableCounterpartyAddress(fulfillment.actor_address)) {
    return {
      kind: 'refused',
      outcome: 'refused_completion_counterparty_unresolvable',
      reason: 'promise_actor_address_unresolved',
    };
  }

  // (3) THE COUNTERPARTY IS A DISTINCT OWNER. The SAME detector the record path
  // and the human-job verifier run. Self-dealing (a promise a human "made" to
  // their own linked agent, or two wallets one owner controls) refuses by name
  // and mints 0; a registry read that FAILS refuses as a verifier error (fail
  // closed), never as "distinct owner".
  const ownership = await detectSameOwnerTransfer(db, {
    economicActorId: row.userId,
    counterpartyAddress,
  });
  if (ownership.unresolvable) {
    return {
      kind: 'refused',
      outcome: 'refused_verifier_error',
      reason: `same_owner_check_unresolvable: ${ownership.reason}`,
    };
  }
  if (ownership.selfReferencing || ownership.sharedBeneficialOwnership) {
    return {
      kind: 'refused',
      outcome: 'refused_completion_self_dealing',
      reason: `promise_self_dealing: ${ownership.reason}`,
    };
  }

  // (4) THE WITNESS — the relay's wallet-bound close-out record for this promise.
  const promiseSnap = await db.collection(HUMAN_PROMISES_COLLECTION).doc(fulfillment.promise_id).get();
  if (!promiseSnap.exists) {
    // No relay record yet (never created/synced through the relay rail) → cannot
    // witness the close-out. Held, re-judged each pass; never promoted.
    return { kind: 'awaiting', reason: 'awaiting_human_promise_relay_record' };
  }
  const promise = promiseSnap.data() as HumanPromiseDocument;
  const actorLc = fulfillment.actor_address.toLowerCase();
  const counterpartyLc = counterpartyAddress.toLowerCase();
  const creator = (promise.creator_address ?? '').toLowerCase();
  const acceptor = (promise.acceptor_address ?? '').toLowerCase();

  // (4a) The two parties of record must be EXACTLY {this PE's actor, its named
  // counterparty}. This binds the PE's self-reported naming to the authoritative
  // wallet-bound record — a PE naming a counterparty who is not the other party
  // of the promise cannot free-ride the record.
  const partiesOfRecord = new Set([creator, acceptor]);
  const partiesFromPe = new Set([actorLc, counterpartyLc]);
  if (partiesOfRecord.size !== 2 || partiesFromPe.size !== 2
    || creator === '' || acceptor === ''
    || !partiesOfRecord.has(actorLc) || !partiesOfRecord.has(counterpartyLc)) {
    return refuse('promise_relay_parties_mismatch');
  }

  // (4b) BOTH parties' close-out signatures must be present AND re-verify against
  // their party address over the record's agreed digest. Absent → awaiting.
  const closeout = promise.closeout ?? {};
  const creatorCloseout = closeout[creator];
  const acceptorCloseout = closeout[acceptor];
  if (!creatorCloseout || !acceptorCloseout) {
    return { kind: 'awaiting', reason: 'awaiting_both_closeout_signatures' };
  }
  const creatorOk = verifyHumanPromiseSignature({
    phase: 'closeout', promiseId: fulfillment.promise_id, digest: promise.digest,
    signature: creatorCloseout.signature, expectedAddress: creator,
  });
  const acceptorOk = verifyHumanPromiseSignature({
    phase: 'closeout', promiseId: fulfillment.promise_id, digest: promise.digest,
    signature: acceptorCloseout.signature, expectedAddress: acceptor,
  });
  if (!creatorOk || !acceptorOk) {
    // A present-but-invalid close-out signature is not evidence of anything.
    return refuse('promise_closeout_signature_invalid');
  }

  // The authoritative observation time is when the close-out became mutual (the
  // later of the two close-out signatures). Drives the kernel's enhancement window.
  const confirmationTimestampMs = Math.max(
    typeof creatorCloseout.signed_at === 'number' ? creatorCloseout.signed_at : 0,
    typeof acceptorCloseout.signed_at === 'number' ? acceptorCloseout.signed_at : 0,
  ) || options.nowMs;

  // (5) THE MINT-ONCE SLOT — per (actor, promise). Each of the two distinct-owner
  // parties claims its OWN slot for its own confirmed side; a re-submitted
  // fulfillment by the SAME actor collides here and mints 0.
  const canonicalId = completionCanonicalIdForPromise(fulfillment.promise_id);
  const claim = await prepareCompletionMintClaim(db, row.userId, canonicalId, row.peId, options.nowMs);
  if (claim.evidence.relation === 'duplicate') {
    return {
      kind: 'refused',
      outcome: 'refused_canonical_event_already_minted',
      reason: `canonical_event_minted_by_${claim.evidence.claim.owner_pe_id}`,
    };
  }

  return {
    kind: 'promote',
    facts: {
      // For a promise, jobId is the promise id and posterWalletId the counterparty
      // address of record — the promoter uses neither (it commits the claim, the
      // corroboration source + its timestamp, and the canonical id).
      jobId: fulfillment.promise_id,
      posterWalletId: counterpartyLc,
      canonicalId,
      // The witness is the relay close-out record, not a PE; the promoter stores
      // this as the row's corroboration_source (an audit string, not a PE id).
      confirmationPeId: `human_promise_closeout:${fulfillment.promise_id}`,
      confirmationTimestampMs,
      claim,
    },
  };
}
