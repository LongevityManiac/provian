import { createIndexedMeterClaim } from './pending-claim-index';
import { privateRetentionCollection } from '../provenance/private-retention';
/**
 * PE METER — the one-time migration of the relay's stored PEs (, item 10).
 *
 * Before the meter the relay kept every PE twice: the sealed envelope (`provenance_envelopes`) and
 * its priced row (`pe_history`). The meter keeps neither. This module retires both, one PE at a
 * time, without losing a single unit of earned PVT:
 *
 * - its running totals are already in the economic aggregate and actor stats (maintained on
 * every row write since they existed); what the meter now needs as its own totals is folded
 * here — the per-pair outbound relationship (receive authorship) and the human's delegation
 * total;
 * - an act that has not minted yet keeps earning: an eligible act with no settlement claim
 * becomes a meter act key plus its act claims (the SAME claim ids the legacy inlet would have
 * registered, so the kernel's mint-once holds across both paths), a held act becomes a meter
 * held act, and an act whose legacy claim is registered and not yet settled is left in place
 * until it settles (its approver still reads the row) — a re-run then retires it;
 * - an identity-bearing PE (an agent's birth, rotations, links, governance and badge sources)
 * is moved verbatim into `identity_pes_legacy_v1` first, because identity and recovery read it;
 * - the PEs of the named owners (the operator, Atlas) are handed back: sealed to the owner's published
 * message key and placed in their mailbox, which their phone / daemon files in their own
 * storage. An owner with no published key is left in place until they publish one.
 *
 * Every retirement is ONE transaction: fold, hand-back, conversion and both deletes land
 * together or not at all, so a re-run never double-counts and a crash never loses a PE.
 */

import { createHash } from 'crypto';
import admin from 'firebase-admin';
import stableStringify from 'json-stable-stringify';
import type { DocumentReference, Firestore, Transaction } from 'firebase-admin/firestore';
import { canonicalJson } from './meter-wire';
import { fromB64u, sealToKey, toB64u } from './sealed-box';
import {
  expireAt,
  LEGACY_IDENTITY_PES_COLLECTION,
  METER_ACT_KEYS_COLLECTION,
  METER_HELD_ACTS_COLLECTION,
  METER_KEY_LIFETIME_MS,
  METER_PENDING_CLAIMS_COLLECTION,
  PE_MAILBOX_COLLECTION,
  PE_MAILBOX_LIFETIME_MS,
  HUMAN_DELEGATION_TOTALS_COLLECTION,
  LEGACY_PRE_METER_BATCH,
} from './meter-store';
import { COUNTERPARTY_PAIRS_COLLECTION, counterpartyPairDocId, outboundCounterpartyOf } from './counterparty-pairs';
import { IDENTITY_ACT_TYPES } from './identity-acts';
import { actKeyIdentity, type MeterActKeyDoc, type MeterActFacts } from './meter-act-key';
import { buildPendingClaim, meterActClaimId, meterActClaimKey, type MeterActLeg } from './meter-claims';
import { CLAIM_LEDGER_COLLECTION, claimKeyOf } from '../pvt/wp4/durable-settlement-store';
import { resolvePayee, sealedIdentityOf } from '../pvt/wp4/claim-inlet-source';
import { memoizedSettlementDb } from './meter-ingest';
import { CROSS_WITNESS_TAKEOVER_WINDOW_MS } from '../pvt/policy/monetary-accounting';
import { PVT9_ELIGIBILITY_CUT_LINE_MS } from '../pvt/wp-ev/eligibility';
import { PAYOUT_LEG_ROLES, type PayoutLegRole } from '../pvt/wp-ev/payout-legs';
import { COMMONS_COLLECTIONS } from '../commons/types';
import {
  ACTOR_METER_TOTALS_COLLECTION,
  ACTOR_METER_DAY_LIFETIME_MS,
  actorActIncrementOf,
  actorDayIncrementOf,
  applyActorActIncrement,
  applyBeneficiaryAct,
  beneficiaryOf,
  coerceActorMeterTotals,
  financialFactOf,
  stageActorDayIncrement,
  type FinancialFact,
} from './actor-meter-totals';

export const PE_HISTORY = 'pe_history';
export const PROVENANCE_ENVELOPES = 'provenance_envelopes';

/** Statuses a PE waits in; it becomes a meter held act. */
const HELD = new Set(['pending_evidence', 'pending_review', 'pending_cache', 'beneficiary_pending', 'deferred']);
/** Statuses that never mint again: retire. */
/**
 * Statuses that never mint again (`pe-history.ts`): settled, record-only, compliance-ineligible, a
 * demoted duplicate witness, an output-less compute session, an anti-farm cap, an unverified x402
 * self-report.
 */
const TERMINAL = new Set([
  'minted', 'record_only', 'ineligible',
  'corroborated_duplicate', 'skipped_no_output', 'farm_capped', 'x402_unverified',
]);
/** Statuses whose mint is in flight or deferred to a later epoch/run: they wait, by name. */
const IN_FLIGHT = new Set(['minting', 'genesis_epoch_deferred', 'epoch_headroom_deferred', 'settlement_retry_deferred']);

export type LedgerState = 'none' | 'all_settled' | 'unsettled';

export type LegacyDisposition =
  | { readonly kind: 'retire' }
  | { readonly kind: 'convert' }
  | { readonly kind: 'hold'; readonly heldReason: string }
  | { readonly kind: 'wait'; readonly reason: string };

/**
 * PURE: what becomes of one stored PE. `row` is its pe_history row (null for an envelope with no
 * row), `ledger` the state of its legacy settlement claims.
 */
export function classifyLegacyPe(input: {
  readonly row: Record<string, unknown> | null;
  readonly ledger: LedgerState;
  /** True when this PE's Genesis qualification was denied (terminal: it never reserves or pays). */
  readonly genesisDenied?: boolean;
}): LegacyDisposition {
  // A legacy claim that is registered and unsettled: its approver reads this PE. Wait for it.
  if (input.ledger === 'unsettled') return { kind: 'wait', reason: 'legacy_claim_unsettled' };
  const row = input.row;
  if (row === null) return { kind: 'retire' };
  const status = String(row.mint_status ?? '');
  if (TERMINAL.has(status) || input.ledger === 'all_settled') return { kind: 'retire' };
  if (HELD.has(status)) return { kind: 'hold', heldReason: status };
  if (IN_FLIGHT.has(status)) {
    // A pre-cut-line deferral was a legacy engine's state; no engine processes it and PVT9 never
    // mints a pre-cut-line act, so it can never mint: nothing to carry.
    const ts = typeof row.timestamp === 'number' ? row.timestamp : NaN;
    if (Number.isFinite(ts) && ts < PVT9_ELIGIBILITY_CUT_LINE_MS) return { kind: 'retire' };
    return { kind: 'wait', reason: `mint_in_flight:${status}` };
  }
  if (status === 'eligible') {
    const ts = typeof row.timestamp === 'number' ? row.timestamp : NaN;
    const points = String(row.record_points_atomic ?? '0');
    // Pre-cut-line and zero-point rows can never mint : nothing to carry.
    if (!Number.isFinite(ts) || ts < PVT9_ELIGIBILITY_CUT_LINE_MS || !/^[0-9]+$/.test(points) || BigInt(points) === 0n) {
      return { kind: 'retire' };
    }
    // A Genesis grant settles from its reservation on the Genesis lane, which binds to this PE.
    // A denied qualification is terminal: no reservation, nothing ever pays.
    if (row.is_genesis_grant === true) {
      return input.genesisDenied === true ? { kind: 'retire' } : { kind: 'wait', reason: 'genesis_unsettled' };
    }
    return { kind: 'convert' };
  }
  return { kind: 'wait', reason: `unknown_status:${status || 'none'}` };
}

/** Every ledger key a legacy claim on this PE could carry (each leg, act and top-up). */
export function legacyLedgerRefs(db: Firestore, peId: string): DocumentReference[] {
  const refs: DocumentReference[] = [];
  for (const leg of PAYOUT_LEG_ROLES) {
    refs.push(db.collection(CLAIM_LEDGER_COLLECTION).doc(claimKeyOf(peId, leg)));
    refs.push(db.collection(CLAIM_LEDGER_COLLECTION).doc(claimKeyOf(peId, leg, 'attestation_topup')));
  }
  return refs;
}

export function ledgerStateOf(snaps: readonly { readonly exists: boolean; data(): unknown }[]): LedgerState {
  const present = snaps.filter((s) => s.exists);
  if (present.length === 0) return 'none';
  return present.every((s) => (s.data() as { settled?: unknown } | undefined)?.settled === true)
    ? 'all_settled'
    : 'unsettled';
}

/** An owner whose PEs are handed back, and the key they are sealed to. */
export interface HandBackOwner {
  /** The actor id the PEs carry (`user_id` / `userId`). */
  readonly actorId: string;
  /** Mailbox recipient: `human:<user_id>` or `agent:<agent_id>`. */
  readonly recipient: string;
  /** The owner's published x25519 message key, or null (their PEs wait until they publish one). */
  readonly pubkeyB64u: string | null;
}

export function legacyMailboxId(peId: string, recipient: string): string {
  return `mb_legacy_${createHash('sha256').update(`${peId}|${recipient}`).digest('hex').slice(0, 40)}`;
}

/** True when the envelope belongs in the legacy identity store. */
export function isLegacyIdentityPe(envelope: Record<string, unknown>, pinnedIds: ReadonlySet<string>, peId: string): boolean {
  return pinnedIds.has(peId) || (typeof envelope.action_type === 'string' && IDENTITY_ACT_TYPES.has(envelope.action_type))
    || (typeof envelope.policy_action_type === 'string' && IDENTITY_ACT_TYPES.has(envelope.policy_action_type));
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * A pre-meter act's chain-verified financial fact, read from its sealed envelope's metadata under
 * the same rule the retired financial summary applied to stored envelopes.
 */
function legacyFinancialFact(envelope: Record<string, unknown>): { financial?: FinancialFact } {
  const actionType = str(envelope.action_type);
  if (actionType === null) return {};
  const fact = financialFactOf(actionType, (envelope.metadata ?? {}) as Record<string, unknown>, str(envelope.actor_address));
  return fact === null ? {} : { financial: fact };
}

/** The meter act key a pre-meter act becomes (its priced row, frozen legs, sealed identity). */
export function legacyActKey(input: {
  readonly peId: string;
  readonly row: Record<string, unknown>;
  readonly envelope: Record<string, unknown>;
  readonly actorId: string;
  readonly legs: readonly MeterActLeg[] | null;
  readonly heldReason: string | null;
  readonly nowMs: number;
  readonly expires: boolean;
}): MeterActKeyDoc {
  const identity = sealedIdentityOf(input.peId, input.envelope);
  if (identity === null) throw new Error(`legacy_identity_unavailable:${input.peId}`);
  const facts: MeterActFacts = {
    action_type: identity.action_type,
    wallet_id: str(input.envelope.wallet_id),
    user_id: input.actorId,
    timestamp: identity.timestamp,
    counterparty_address: str(input.envelope.counterparty_address),
    actor_address: str(input.envelope.actor_address),
    job_id: str((input.envelope.metadata as Record<string, unknown> | undefined)?.job_id),
    promise_id: str(input.envelope.promise_id),
    ...legacyFinancialFact(input.envelope),
  };
  return {
    schema: 'provian.meter-act-key.v1',
    relay_pe_id: input.peId,
    client_pe_id: input.peId,
    pe_hash: identity.hash,
    prev_hash: identity.prev_hash,
    device_id: `legacy:${input.actorId}`,
    batch_hash: LEGACY_PRE_METER_BATCH,
    actor_id: input.actorId,
    timestamp: identity.timestamp,
    action_type: identity.action_type,
    row: input.row,
    legs: input.legs === null ? null : [...input.legs],
    unit: input.legs !== null && input.legs.length > 0 ? 'act' : 'none',
    held_reason: input.heldReason,
    side: {
      statsBump: null,
      delegation: null,
      corroborateIncumbentPeId: null,
      outputDigestsIndexed: false,
      effect: null,
      commitOrigins: null,
      outboundCounterparty: null,
    },
    created_at_ms: input.nowMs,
    facts,
    expire_at: input.expires ? expireAt(input.nowMs + METER_KEY_LIFETIME_MS) : null,
  };
}

/**
 * The outcome a pre-meter sealed challenge answer carries, for an OPEN challenge whose answer
 * claim predates stored outcomes — or null when there is nothing to carry. Forum settlement read
 * it from the envelope; once the envelope is retired it must already be on the claim, or the
 * challenge (and its stake burn) would stay open forever.
 */
export function legacyAnswerOutcome(
  challenge: Record<string, unknown> | null,
  envelope: Record<string, unknown> | null,
  peId: string,
): { readonly predicate_true: boolean; readonly answer_burn_id: string | null } | 'not_needed' | 'unreadable' {
  const claim = challenge?.answer_claim as Record<string, unknown> | null | undefined;
  if (!challenge || challenge.status !== 'open' || !claim || claim.answer_pe_id !== peId) return 'not_needed';
  if (typeof claim.predicate_true === 'boolean') return 'not_needed';
  const md = envelope?.metadata as Record<string, unknown> | undefined;
  if (envelope?.action_type !== 'commons_challenge_answered' || !md || md.challenge_id !== challenge.challenge_id
    || typeof md.predicate_true !== 'boolean') return 'unreadable';
  return { predicate_true: md.predicate_true, answer_burn_id: typeof md.presentation_burn_id === 'string' ? md.presentation_burn_id : null };
}

export type LegacyOutcome =
  | { readonly kind: 'retired'; readonly converted: number; readonly held: boolean; readonly handedBack: boolean; readonly identity: boolean }
  | { readonly kind: 'waiting'; readonly reason: string }
  | { readonly kind: 'gone' };

/**
 * Retire one stored PE in one transaction (or leave it, saying why). `apply` false is a dry run:
 * every read and decision, no write.
 */
export async function retireLegacyPe(
  db: Firestore,
  peId: string,
  options: {
    readonly nowMs: number;
    readonly apply: boolean;
    readonly handBack: ReadonlyMap<string, HandBackOwner>;
    readonly identityPinned: ReadonlySet<string>;
    /**
     * Envelope hashes that are the `prev_hash` of a PE whose legacy claim is registered and not yet
     * settled. The batch approver re-checks that link against `provenance_envelopes`, so the
     * predecessor waits until its successor settles (a re-run then retires it).
     */
    readonly predecessorPinned?: ReadonlySet<string>;
    /** PE ids whose Genesis qualification is `denied` (terminal) in the qualification outbox. */
    readonly genesisDenied?: ReadonlySet<string>;
  },
): Promise<LegacyOutcome> {
  const rowRef = db.collection(PE_HISTORY).doc(peId);
  const envRef = db.collection(PROVENANCE_ENVELOPES).doc(peId);
  // Payee legs resolve outside the transaction (their reads are not transactional); the
  // transaction re-checks the row they were resolved from.
  const [rowPreview, envPreview] = await Promise.all([rowRef.get(), envRef.get()]);
  if (!rowPreview.exists && !envPreview.exists) return { kind: 'gone' };
  let legs: MeterActLeg[] | null = null;
  let payeeRefusal: string | null = null;
  const previewRow = rowPreview.exists ? rowPreview.data() as Record<string, unknown> : null;
  if (previewRow !== null && previewRow.mint_status === 'eligible' && previewRow.is_genesis_grant !== true) {
    const total = String(previewRow.record_points_atomic ?? '0');
    if (/^[0-9]+$/.test(total) && BigInt(total) > 0n) {
      const payee = await resolvePayee(memoizedSettlementDb(db), previewRow, total, peId);
      if (payee.kind === 'resolved') {
        legs = payee.legs.map((leg) => ({
          leg: leg.leg,
          contributor: leg.contributor.toLowerCase(),
          beneficiary_class: leg.beneficiaryClass as number,
          bps: leg.bps,
          points_atomic: leg.pointsAtomic,
        }));
      } else {
        payeeRefusal = `payee_${payee.reason}`;
      }
    }
  }

  return db.runTransaction(async (txn: Transaction) => {
    const ledgerRefs = legacyLedgerRefs(db, peId);
    const previewEnvelope = envPreview.exists ? envPreview.data() as Record<string, unknown> : null;
    const previewChallengeId = (previewEnvelope?.metadata as Record<string, unknown> | undefined)?.challenge_id;
    const answeredChallengeId = previewEnvelope?.action_type === 'commons_challenge_answered'
      && typeof previewChallengeId === 'string'
      ? previewChallengeId
      : null;
    const challengeRef = answeredChallengeId !== null
      ? db.collection(COMMONS_COLLECTIONS.CHALLENGES).doc(answeredChallengeId)
      : null;
    // The actor's (and its beneficiary's) running totals, read before any write.
    const previewActor = str(previewRow?.userId) ?? str(previewEnvelope?.user_id);
    const previewBeneficiary = previewRow !== null ? beneficiaryOf(previewRow)?.humanId ?? null : null;
    const totalsIds = [...new Set([previewActor, previewBeneficiary].filter((v): v is string => v !== null))];
    const totalsRefs = totalsIds.map((id) => db.collection(ACTOR_METER_TOTALS_COLLECTION).doc(id));
    const totalsSnaps = await Promise.all(totalsRefs.map((r) => txn.get(r)));
    const [rowSnap, envSnap, keySnap, heldSnap, identitySnap, challengeSnap, ...ledgerSnaps] = await Promise.all([
      txn.get(rowRef), txn.get(envRef),
      txn.get(privateRetentionCollection(db, METER_ACT_KEYS_COLLECTION).doc(peId)),
      txn.get(privateRetentionCollection(db, METER_HELD_ACTS_COLLECTION).doc(peId)),
      txn.get(privateRetentionCollection(db, LEGACY_IDENTITY_PES_COLLECTION).doc(peId)),
      challengeRef !== null ? txn.get(challengeRef) : Promise.resolve(null),
      ...ledgerRefs.map((r) => txn.get(r)),
    ]);
    if (!rowSnap.exists && !envSnap.exists) return { kind: 'gone' as const };
    const row = rowSnap.exists ? rowSnap.data() as Record<string, unknown> : null;
    const envelope = envSnap.exists ? envSnap.data() as Record<string, unknown> : null;
    if (row !== null && previewRow !== null && stableStringify(row) !== stableStringify(previewRow)) {
      return { kind: 'waiting' as const, reason: 'row_moved_retry' };
    }
    const envelopeHash = str(envelope?.hash);
    if (envelopeHash !== null && options.predecessorPinned?.has(envelopeHash) === true) {
      return { kind: 'waiting' as const, reason: 'predecessor_of_unsettled_claim' };
    }
    const disposition = classifyLegacyPe({
      row, ledger: ledgerStateOf(ledgerSnaps), genesisDenied: options.genesisDenied?.has(peId) === true,
    });
    if (disposition.kind === 'wait') return { kind: 'waiting' as const, reason: disposition.reason };
    if ((disposition.kind === 'convert' || disposition.kind === 'hold') && (keySnap.exists || heldSnap.exists)) {
      return { kind: 'waiting' as const, reason: 'meter_record_exists' };
    }
    if ((disposition.kind === 'convert' || disposition.kind === 'hold') && envelope === null) {
      return { kind: 'waiting' as const, reason: 'envelope_missing_for_live_act' };
    }

    const actorId = str(row?.userId) ?? str(envelope?.user_id);
    if (actorId === null) {
      // An envelope with no row and no actor whose wallet no longer exists (a wiped wallet, e.g.
      // the pre- Atlas): nobody is left to hand it back to, it never had a row or a claim,
      // so it is dropped with nothing folded. Any other actor-less record keeps waiting.
      const walletId = str(envelope?.wallet_id);
      if (row !== null || envelope === null || walletId === null) {
        return { kind: 'waiting' as const, reason: 'actor_unknown' };
      }
      const [humanWallet, agentWallet] = await Promise.all([
        txn.get(db.collection('wallets').doc(walletId)),
        txn.get(db.collection('agent_wallets').doc(walletId)),
      ]);
      if (humanWallet.exists || agentWallet.exists) return { kind: 'waiting' as const, reason: 'actor_unknown' };
      // An identity-bearing envelope still moves, verbatim, as on every other retirement.
      const identityOfGone = isLegacyIdentityPe(envelope, options.identityPinned, peId);
      if (identityOfGone && identitySnap.exists && stableStringify(identitySnap.data()) !== stableStringify(envelope)) {
        return { kind: 'waiting' as const, reason: 'identity_copy_conflict' };
      }
      if (options.apply) {
        if (identityOfGone && !identitySnap.exists) txn.set(privateRetentionCollection(db, LEGACY_IDENTITY_PES_COLLECTION).doc(peId), envelope);
        txn.delete(envRef);
      }
      return { kind: 'retired' as const, converted: 0, held: false, handedBack: false, identity: identityOfGone };
    }
    if (actorId !== previewActor) return { kind: 'waiting' as const, reason: 'row_moved_retry' };
    const owner = options.handBack.get(actorId) ?? null;
    if (owner !== null && owner.pubkeyB64u === null) return { kind: 'waiting' as const, reason: 'hand_back_key_missing' };
    if (disposition.kind !== 'retire' && envelope !== null) {
      const identity = sealedIdentityOf(peId, envelope);
      if (identity === null || identity.user_id !== actorId) {
        return { kind: 'waiting' as const, reason: 'identity_user_mismatch' };
      }
    }
    // An open challenge answered by this pre-meter PE: its outcome moves onto the claim first.
    const answer = challengeSnap !== null && challengeSnap.exists
      ? legacyAnswerOutcome(challengeSnap.data() as Record<string, unknown>, envelope, peId)
      : 'not_needed';
    if (answer === 'unreadable') return { kind: 'waiting' as const, reason: 'challenge_answer_unreadable' };
    const identityPe = envelope !== null && isLegacyIdentityPe(envelope, options.identityPinned, peId);
    if (identityPe && identitySnap.exists && stableStringify(identitySnap.data()) !== stableStringify(envelope)) {
      return { kind: 'waiting' as const, reason: 'identity_copy_conflict' };
    }
    if (!options.apply) {
      return {
        kind: 'retired' as const,
        converted: disposition.kind === 'convert' ? (legs?.length ?? 0) : 0,
        held: disposition.kind === 'hold' || (disposition.kind === 'convert' && payeeRefusal !== null),
        handedBack: owner !== null && envelope !== null,
        identity: identityPe,
      };
    }

    // ── writes ──
    let converted = 0;
    let held = false;
    if (disposition.kind === 'convert' && row !== null && envelope !== null) {
      if (payeeRefusal !== null || legs === null) {
        // The payee cannot be resolved now: the act waits as a held act; the payee retry promotes it.
        const key = legacyActKey({ peId, row, envelope, actorId, legs: null, heldReason: payeeRefusal ?? 'payee_unresolved', nowMs: options.nowMs, expires: false });
        txn.set(privateRetentionCollection(db, METER_HELD_ACTS_COLLECTION).doc(peId), {
          relay_pe_id: peId, held_reason: payeeRefusal ?? 'payee_unresolved', key, created_at_ms: options.nowMs,
        });
        held = true;
      } else {
        const key = legacyActKey({ peId, row, envelope, actorId, legs, heldReason: null, nowMs: options.nowMs, expires: true });
        txn.set(privateRetentionCollection(db, METER_ACT_KEYS_COLLECTION).doc(peId), key);
        const identity = actKeyIdentity(key);
        for (const leg of legs) {
          if (BigInt(leg.points_atomic) <= 0n) continue;
          const claimKey = meterActClaimKey(peId, leg.leg as PayoutLegRole);
          createIndexedMeterClaim(db, txn, db.collection(METER_PENDING_CLAIMS_COLLECTION).doc(claimKey), buildPendingClaim({
            claim_key: claimKey,
            unit: 'act',
            batch_hash: key.batch_hash,
            device_id: key.device_id,
            actor_id: actorId,
            leg: leg.leg,
            contributor: leg.contributor,
            beneficiary_class: leg.beneficiary_class,
            record_points_atomic: leg.points_atomic,
            acts: [{ relay_pe_id: peId, points_atomic: leg.points_atomic }],
            claim_id: meterActClaimId(identity, leg.leg as PayoutLegRole),
            act_identity: identity,
            created_at_ms: options.nowMs,
            ready_at_ms: Math.max(options.nowMs, key.timestamp + CROSS_WITNESS_TAKEOVER_WINDOW_MS),
          }));
          converted += 1;
        }
      }
    }
    if (disposition.kind === 'hold' && row !== null && envelope !== null) {
      const key = legacyActKey({ peId, row, envelope, actorId, legs: null, heldReason: disposition.heldReason, nowMs: options.nowMs, expires: false });
      txn.set(privateRetentionCollection(db, METER_HELD_ACTS_COLLECTION).doc(peId), {
        relay_pe_id: peId, held_reason: disposition.heldReason, key, created_at_ms: options.nowMs,
      });
      held = true;
    }

    // Fold: the meter's own per-actor totals for this act.
    const actionType = str(envelope?.action_type) ?? str(row?.actionType) ?? '';
    const counterparty = outboundCounterpartyOf(actionType, str(envelope?.counterparty_address) ?? str(row?.counterpartyAddress));
    if (counterparty !== null) {
      txn.set(db.collection(COUNTERPARTY_PAIRS_COLLECTION).doc(counterpartyPairDocId(actorId, counterparty)), {
        actor_id: actorId,
        counterparty,
        outbound_count: admin.firestore.FieldValue.increment(1),
        last_outbound_at_ms: Math.max(Number(envelope?.timestamp ?? 0), 0),
      }, { merge: true });
    }
    if (actionType === 'agent_work_delegated' && envelope !== null) {
      const meta = (envelope.metadata ?? {}) as Record<string, unknown>;
      const agent = str(meta.source_agent_id);
      if (agent !== null) {
        const total = Number(meta.total_pvt ?? 0);
        const human = Number(meta.beneficiary_share ?? 0);
        txn.set(db.collection(HUMAN_DELEGATION_TOTALS_COLLECTION).doc(actorId), {
          human_user_id: actorId,
          by_agent: {
            [agent]: {
              acts: admin.firestore.FieldValue.increment(1),
              total_pvt: admin.firestore.FieldValue.increment(Number.isFinite(total) ? total : 0),
              human_share_pvt: admin.firestore.FieldValue.increment(Number.isFinite(human) ? human : 0),
            },
          },
          total_acts: admin.firestore.FieldValue.increment(1),
          total_human_share_pvt: admin.firestore.FieldValue.increment(Number.isFinite(human) ? human : 0),
          updated_at_ms: options.nowMs,
        }, { merge: true });
      }
    }

    // The per-actor totals the user-facing reads keep (tiers, corroboration, a human's beneficiary
    // acts, chain-verified financial totals, the 30-day participation counters): what the
    // retired readers counted from this stored PE is folded in once, as a fresh act would be.
    if (row !== null) {
      const fact = envelope !== null ? legacyFinancialFact(envelope).financial ?? null : null;
      const inc = actorActIncrementOf(row, { financial: fact }, held || disposition.kind === 'hold');
      const beneficiary = beneficiaryOf(row);
      totalsRefs.forEach((ref, i) => {
        let doc = coerceActorMeterTotals(ref.id, totalsSnaps[i].exists ? totalsSnaps[i].data() : null);
        let touched = false;
        if (inc !== null && inc.actorId === ref.id) { doc = applyActorActIncrement(doc, inc, options.nowMs); touched = true; }
        if (beneficiary !== null && beneficiary.humanId === ref.id) { doc = applyBeneficiaryAct(doc, beneficiary.agentId, options.nowMs); touched = true; }
        if (touched) txn.set(ref, { ...doc });
      });
      const day = actorDayIncrementOf(row);
      if (day !== null && options.nowMs - Date.parse(`${day.day}T00:00:00Z`) < ACTOR_METER_DAY_LIFETIME_MS) {
        stageActorDayIncrement(txn, db, day);
      }
    }

    if (answer !== 'not_needed' && challengeRef !== null) {
      txn.update(challengeRef, {
        'answer_claim.predicate_true': answer.predicate_true,
        ...(answer.answer_burn_id !== null ? { 'answer_claim.answer_burn_id': answer.answer_burn_id } : {}),
      });
    }

    // Identity and recovery read identity-bearing PEs: they move, verbatim.
    if (identityPe && envelope !== null && !identitySnap.exists) {
      txn.set(privateRetentionCollection(db, LEGACY_IDENTITY_PES_COLLECTION).doc(peId), envelope);
    }

    // Hand back to its owner: sealed to their key, filed by their phone or daemon.
    let handedBack = false;
    if (owner !== null && owner.pubkeyB64u !== null && envelope !== null) {
      const plaintext = Buffer.from(canonicalJson({ ...envelope, id: peId }), 'utf8');
      const box = toB64u(sealToKey(fromB64u(owner.pubkeyB64u), plaintext));
      const id = legacyMailboxId(peId, owner.recipient);
      txn.set(db.collection(PE_MAILBOX_COLLECTION).doc(id), {
        id,
        to: owner.recipient,
        pe_id: peId,
        box,
        from_device: 'relay:pre_meter',
        from_actor: actorId,
        batch_hash: '',
        created_at_ms: options.nowMs,
        expire_at: expireAt(options.nowMs + PE_MAILBOX_LIFETIME_MS),
      });
      handedBack = true;
    }

    if (rowSnap.exists) txn.delete(rowRef);
    if (envSnap.exists) txn.delete(envRef);
    return { kind: 'retired' as const, converted, held, handedBack, identity: identityPe };
  });
}
