/**
 * Operator RULINGS sidecar for the pending-policy queue.
 *
 * The pending-policy queue row is fail-closed reality (record_only until a signed
 * matrix row makes a type earn). The operator's TRIAGE of a queued type — decline
 * it, decline it as an alias of a canonical type, or commit to building it — is a
 * separate, lighter record kept HERE, keyed by the same `sha256(action_type)` as
 * the queue. It carries NO mint authority: nothing in this collection can make a
 * type eligible. The only path to an eligible row is the signed matrix path
 * (emitter + verifier + matrix row + SSHSIG + deploy); this sidecar is how the
 * public /proposals page shows "declined: reason" / "building" for a type before
 * (or instead of) that PR lands, and how the reconciler records when a built type
 * actually goes live on the served, digest-matched matrix.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { actionPolicyDocumentId, isValidPolicyActionType } from './pending-policy-queue';
import { ACTION_POLICY_CATEGORIES, type ActionPolicyCategory } from './types';

function validateActionType(actionType: string): void {
  if (!actionType.trim() || !isValidPolicyActionType(actionType)) {
    throw new Error('action_type_invalid');
  }
}

export const POLICY_RULINGS_COLLECTION = 'pvt_policy_rulings';

export type PolicyRulingKind = 'declined' | 'alias' | 'building';

/** The two dispositions an operator may PROPOSE (non-binding). */
export type ProposedDisposition = 'eligible' | 'record_only';

/**
 * The exact weights an operator may propose, in bps. A closed set on purpose: a
 * proposal is a hand-off to the signed matrix ceremony, not a free-text price, so
 * it is constrained to the same values a matrix row can carry (0 for record-only;
 * 0.5×/1×/2×/3× and the 10× setup grant for eligible).
 *
 * NON-BINDING. Nothing under `core/pvt/**` reads `proposed_*` to price anything —
 * these fields ride the rulings SIDECAR and only prefill the GitHub issue.
 */
// : 40000 = the hardware_rooted class base (4.0×).
export const PROPOSED_WEIGHT_BPS_SET: readonly number[] = [0, 5000, 10000, 20000, 30000, 40000, 100000];
const PROPOSED_WEIGHT_BPS_VALUES: ReadonlySet<number> = new Set(PROPOSED_WEIGHT_BPS_SET);
const ACTION_POLICY_CATEGORY_SET: ReadonlySet<string> = new Set<string>(ACTION_POLICY_CATEGORIES);
const REVIEWER_NOTES_MAX = 1000;

export interface PolicyRulingDoc {
  action_type: string;
  ruling: PolicyRulingKind;
  /** Free-ish reason label for declined/alias (operator-supplied, capped). */
  reason_code: string | null;
  /** For `alias`: the canonical action type this is an alias of. */
  canonical_type: string | null;
  /** For `building`: the prefilled GitHub issue URL. */
  issue_url: string | null;
  /** Operator's PROPOSED disposition (non-binding sidecar; never priced). */
  proposed_disposition?: ProposedDisposition | null;
  /** Operator's PROPOSED weight in bps (∈ PROPOSED_WEIGHT_BPS_SET; non-binding). */
  proposed_weight_bps?: number | null;
  /** Operator's PROPOSED category (∈ ACTION_POLICY_CATEGORIES; non-binding). */
  proposed_category?: ActionPolicyCategory | null;
  /** Free-text operator note (≤1000 chars), allowed on any ruling kind. */
  reviewer_notes?: string | null;
  ruled_at: number;
  ruled_by: string;
  /** F55: the caller-asserted x-operator-id (forensics), or null. Never trusted
   * as the ruling's audit identity — that is `ruled_by`. */
  ruled_asserted_operator_id?: string | null;
  /**
   * Set by the reconciler when the type is observed LIVE on the served,
   * digest-matched matrix. Null until then. A live ruling is terminal.
   */
  live_at: number | null;
  /**
   * Set by the activation-notify fan-out (Phase 4) once the submitter
   * notice for this now-live type has been dispatched. Absent/null until then;
   * the fan-out job skips a ruling once this is set. Never blocks going live.
   */
  activation_fanout_at?: number | null;
}

export interface SetPolicyRulingInput {
  actionType: string;
  ruling: PolicyRulingKind;
  reasonCode?: string | null;
  canonicalType?: string | null;
  issueUrl?: string | null;
  /** Non-binding proposal fields (sidecar only). */
  proposedDisposition?: ProposedDisposition | null;
  proposedWeightBps?: number | null;
  proposedCategory?: string | null;
  reviewerNotes?: string | null;
  operatorId: string;
  /** F55: the caller-asserted x-operator-id, recorded for forensics — never the
   *  primary audit identity (that is `operatorId`, the nginx x-ops-basic-user). */
  assertedOperatorId?: string | null;
  now?: number;
}

export async function getPolicyRuling(
  db: Firestore,
  actionType: string,
): Promise<PolicyRulingDoc | null> {
  const snap = await db.collection(POLICY_RULINGS_COLLECTION)
    .doc(actionPolicyDocumentId(actionType)).get();
  return snap.exists ? (snap.data() as PolicyRulingDoc) : null;
}

export async function listPolicyRulings(db: Firestore): Promise<PolicyRulingDoc[]> {
  const snap = await db.collection(POLICY_RULINGS_COLLECTION).get();
  return snap.docs.map((d) => d.data() as PolicyRulingDoc);
}

/**
 * Mark a ruling LIVE (the reconciler's write): the type is now present on the
 * served, digest-matched matrix. Idempotent; only moves null → live_at.
 */
export async function markPolicyRulingLive(
  db: Firestore,
  actionType: string,
  now: number = Date.now(),
): Promise<boolean> {
  const ref = db.collection(POLICY_RULINGS_COLLECTION).doc(actionPolicyDocumentId(actionType));
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) return false;
    const current = snap.data() as PolicyRulingDoc;
    if (current.live_at) return false;
    txn.update(ref, { live_at: now });
    return true;
  });
}

/**
 * Mark a live ruling's submitter activation notice as fanned out (Phase 4).
 * Idempotent; only moves absent/null → a timestamp on a ruling that is already live.
 */
export async function markPolicyRulingFanoutComplete(
  db: Firestore,
  actionType: string,
  now: number = Date.now(),
): Promise<boolean> {
  const ref = db.collection(POLICY_RULINGS_COLLECTION).doc(actionPolicyDocumentId(actionType));
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) return false;
    const current = snap.data() as PolicyRulingDoc;
    if (!current.live_at || current.activation_fanout_at) return false;
    txn.update(ref, { activation_fanout_at: now });
    return true;
  });
}
