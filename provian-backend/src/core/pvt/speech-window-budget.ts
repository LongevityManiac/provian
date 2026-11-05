import { NoveltyCounterConflictError, type BatchPricingCounters } from '../meter/batch-pricing-counters';
import stableStringify from 'json-stable-stringify';
/**
 * SPEECH-WINDOW BUDGET — money path.
 *
 * the operator’s invariant: "the maximum a wallet can mint from speech inside one window is less than
 * the burn that opened the window." This module makes that true BY CONSTRUCTION rather than by
 * tuning: every speech PE sealed under a window reserves its record points against the window's
 * budget in ONE Firestore transaction, and a PE that would carry the running sum to or past the
 * budget seals `record_only` (`speech_window_budget_exhausted`) — recorded, never minted.
 *
 * budget_atomic = burn_amount_atomic × SPEECH_BUDGET_RATE_BPS / 10_000
 * admitted iff consumed_atomic + points_atomic < budget_atomic (STRICT)
 *
 * `SPEECH_BUDGET_RATE_BPS = 10_000` one record point settles to one PVT at the armed epoch
 * `mintRate` of 1.0× (the live kernel rate,), and the contributor receives 99% of a mint, so
 * the PVT a wallet receives from a window's speech is strictly below the burn that opened it. A
 * scheduled mint rate above 1.0× is a prospective policy change and requires updating this constant consistently.
 *
 * Shape mirrors `activity-mint-limits.ts::reserveActivityMintCaps` a per-PE reservation doc makes
 * a replayed accrual (the cutover reconciliation ordinary-intake crash replay) idempotent — the same PE never
 * consumes twice — and the window ledger doc (`speech_window_budgets/{burn_id}`) is the one
 * counter every speech PE of that window contends on. Unknown = Block: any read/write failure is
 * reported as exhausted by the caller (`pvt-accrual.ts`), never as admitted.
 *
 * NO PASS, NO MINT (, fact-base fixes item 1). The invariant covers EVERY speech PE
 * on EVERY surface: a speech PE mints only while the speaker holds a live pass and only inside that
 * pass's budget. Sending inside an open relationship still needs no pass (the gate is unchanged),
 * but a speech PE that reaches the accrual with no pass attached seals `record_only`
 * (`speech_no_live_pass_record_only`) — {@link speechPeNeedsPass} is the one test the accrual
 * applies. The challenge answer keeps its own budget (the answer presentation's burn).
 */

import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { COMMONS_SPEECH_ACTION_TYPES } from './policy/proposed-action-policy';

export const SPEECH_WINDOW_BUDGETS_COLLECTION = 'speech_window_budgets';
export const SPEECH_WINDOW_RESERVATIONS_COLLECTION = 'speech_window_reservations';

/** Record points per burned PVT, in bps. 10_000 = 1 point per PVT (the armed 1.0× epoch rate). */
export const SPEECH_BUDGET_RATE_BPS = 10_000;
const BPS = 10_000n;

export interface SpeechWindowBudgetInput {
  readonly peId: string;
  readonly walletId: string;
  readonly actionType: string;
  /** The window's backing burn id (`burn_consumptions/{burn_id}`). */
  readonly burnId: string;
  /** The backing burn's verified on-chain amount, atomic units (decimal string). */
  readonly burnAmountAtomic: string;
  /** The record points this PE would seal, atomic units (decimal string). */
  readonly pointsAtomic: string;
  readonly timestampMs: number;
  /** Defer ordinal-priced reservations to the same successful seal as their counters. */
  readonly sealCounters?: BatchPricingCounters;
}

export interface SpeechWindowBudgetDecision {
  readonly exhausted: boolean;
  readonly budgetAtomic: string;
  /** Points consumed by this window AFTER this decision (unchanged when exhausted). */
  readonly consumedAtomic: string;
  readonly idempotent: boolean;
}

function parseAtomic(raw: unknown, name: string): bigint {
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw)) return BigInt(raw);
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return BigInt(raw);
  throw new Error(`speech_window_budget_${name}_invalid`);
}

const SPEECH_ACTION_TYPE_SET: ReadonlySet<string> = new Set(COMMONS_SPEECH_ACTION_TYPES);

/**
 * Whether a PE of this action type can mint only under a live pass: true for every speech
 * row (the ONE list the matrix prices, `COMMONS_SPEECH_ACTION_TYPES`). The accrual seals such a PE
 * `record_only` (`speech_no_live_pass_record_only`) when no pass is attached.
 */
export function speechPeNeedsPass(actionType: string): boolean {
  return SPEECH_ACTION_TYPE_SET.has(actionType);
}

/** budget = burn × rate / 10_000. Pure, exported for the tests' RED controls. */
export function speechWindowBudgetAtomic(burnAmountAtomic: bigint, rateBps: number = SPEECH_BUDGET_RATE_BPS): bigint {
  if (!Number.isInteger(rateBps) || rateBps < 0) throw new Error('speech_window_budget_rate_invalid');
  return (burnAmountAtomic * BigInt(rateBps)) / BPS;
}

/** The pure admission rule: STRICTLY less than the budget. */
export function speechWindowAdmits(consumedAtomic: bigint, pointsAtomic: bigint, budgetAtomic: bigint): boolean {
  return consumedAtomic + pointsAtomic < budgetAtomic;
}

interface LedgerDoc {
  burn_id: string;
  wallet_id: string;
  budget_atomic: string;
  consumed_atomic: string;
  admitted_pe_count: number;
  refused_pe_count: number;
  updated_at: number;
}

interface ReservationDoc {
  pe_id: string;
  burn_id: string;
  wallet_id: string;
  action_type: string;
  points_atomic: string;
  exhausted: boolean;
  budget_atomic: string;
  consumed_after_atomic: string;
  created_at: number;
}

async function readLedger(txn: Transaction, ref: FirebaseFirestore.DocumentReference): Promise<LedgerDoc | null> {
  const snap = await txn.get(ref);
  if (!snap.exists) return null;
  const d = snap.data() as Partial<LedgerDoc> | undefined;
  if (!d || typeof d.consumed_atomic !== 'string') throw new Error('speech_window_budget_ledger_corrupt');
  return d as LedgerDoc;
}

/**
 * Reserve this PE's record points against its window's budget, transactionally. Idempotent per
 * PE. Throws on any malformed input or unreadable ledger (the caller treats a throw as exhausted).
 */
export async function reserveSpeechWindowBudget(
  db: Firestore,
  input: SpeechWindowBudgetInput,
): Promise<SpeechWindowBudgetDecision> {
  if (!input.peId || !input.walletId || !input.burnId || !input.actionType
    || !Number.isSafeInteger(input.timestampMs) || input.timestampMs < 0) {
    throw new Error('speech_window_budget_input_invalid');
  }
  const burnAmount = parseAtomic(input.burnAmountAtomic, 'burn_amount');
  const points = parseAtomic(input.pointsAtomic, 'points');
  const budget = speechWindowBudgetAtomic(burnAmount);

  const ledgerRef = db.collection(SPEECH_WINDOW_BUDGETS_COLLECTION).doc(input.burnId);
  const reservationRef = db.collection(SPEECH_WINDOW_RESERVATIONS_COLLECTION).doc(input.peId);

  const preview = await db.runTransaction(async (txn) => {
    const existing = await txn.get(reservationRef);
    if (existing.exists) {
      const r = existing.data() as ReservationDoc;
      return { decision: {
        exhausted: r.exhausted === true,
        budgetAtomic: r.budget_atomic,
        consumedAtomic: r.consumed_after_atomic,
        idempotent: true,
      }, deferred: null };
    }
    const baseLedger = await readLedger(txn, ledgerRef);
    const ledger = input.sealCounters?.stagedValue<LedgerDoc>(ledgerRef.path) ?? baseLedger;
    const consumed = ledger ? parseAtomic(ledger.consumed_atomic, 'consumed') : 0n;
    const admitted = speechWindowAdmits(consumed, points, budget);
    const consumedAfter = admitted ? consumed + points : consumed;

    const nextLedger: LedgerDoc = {
      burn_id: input.burnId,
      wallet_id: input.walletId,
      budget_atomic: budget.toString(),
      consumed_atomic: consumedAfter.toString(),
      admitted_pe_count: (ledger?.admitted_pe_count ?? 0) + (admitted ? 1 : 0),
      refused_pe_count: (ledger?.refused_pe_count ?? 0) + (admitted ? 0 : 1),
      updated_at: input.timestampMs,
    };
    const reservation: ReservationDoc = {
      pe_id: input.peId,
      burn_id: input.burnId,
      wallet_id: input.walletId,
      action_type: input.actionType,
      points_atomic: points.toString(),
      exhausted: !admitted,
      budget_atomic: budget.toString(),
      consumed_after_atomic: consumedAfter.toString(),
      created_at: input.timestampMs,
    };
    if (!input.sealCounters) {
      txn.set(ledgerRef, nextLedger);
      txn.create(reservationRef, reservation);
    }

    return { decision: {
      exhausted: !admitted,
      budgetAtomic: budget.toString(),
      consumedAtomic: consumedAfter.toString(),
      idempotent: false,
    }, deferred: { baseLedger, nextLedger, reservation } };
  });
  // Firestore can retry its callback. Stage only its successful read result, once.
  if (input.sealCounters && preview.deferred) {
    const { baseLedger, nextLedger, reservation } = preview.deferred;
    input.sealCounters.stageValue(ledgerRef.path, nextLedger);
    input.sealCounters.addHook({
      inspect: async sealTxn => {
        const prior = await sealTxn.get(reservationRef);
        const current = await readLedger(sealTxn, ledgerRef);
        if (prior.exists || stableStringify(current) !== stableStringify(baseLedger)) throw new NoveltyCounterConflictError();
      },
      commit: sealTxn => { sealTxn.set(ledgerRef, nextLedger); sealTxn.create(reservationRef, reservation); },
    });
  }
  return preview.decision;
}
