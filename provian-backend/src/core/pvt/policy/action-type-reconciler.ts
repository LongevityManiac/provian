/**
 * Reconcile "building" rulings to LIVE.
 *
 * When a contributor PR lands an emitter + verifier + matrix row and the operator signs
 * it, the type appears on the SERVED matrix and `monetary_activation.digest_match`
 * is true. This sweep notices that transition and marks the sidecar ruling live —
 * no operator hand-edit. The newly-live list is returned so the caller (a
 * scheduler job) can fan out the submitter activation notice (Phase 4).
 *
 * It is the ONLY writer that closes a ruling as live, and it computes "live" from
 * the served code + the matched activation digest — never from `pvt_action_policies`.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { PROPOSED_ACTION_POLICY_ENTRIES } from './proposed-action-policy';
import {
  MONETARY_STATUS_COLLECTION,
  MONETARY_STATUS_DOCUMENT,
} from './monetary-activation-status';
import { listPolicyRulings, markPolicyRulingLive } from './policy-rulings';
import {
  PENDING_POLICY_COLLECTION,
  actionPolicyDocumentId,
  resolvePendingPolicyActionBySignedMatrix,
  type PendingPolicyQueueDocument,
} from './pending-policy-queue';
import type { MintDisposition } from './monetary-accounting';

const MINTABLE: ReadonlySet<MintDisposition> = new Set<MintDisposition>([
  'eligible', 'pending_evidence', 'pending_review',
]);

async function digestMatches(db: Firestore): Promise<boolean> {
  try {
    const snap = await db.collection(MONETARY_STATUS_COLLECTION).doc(MONETARY_STATUS_DOCUMENT).get();
    return snap.exists && (snap.data() as { digest_match?: boolean }).digest_match === true;
  } catch {
    return false;
  }
}

export interface ReconcileResult {
  readonly digest_match: boolean;
  readonly examined: number;
  readonly newly_live: readonly string[];
}

/**
 * Mark every not-yet-live `building` ruling whose type is now a MINTABLE row on
 * the served, digest-matched matrix as live. Returns the types that transitioned
 * on THIS run (so the caller can notify their submitters exactly once).
 */
export async function reconcileLiveActionTypes(
  db: Firestore,
  now: number = Date.now(),
): Promise<ReconcileResult> {
  const digest_match = await digestMatches(db);
  if (!digest_match) {
    // Nothing is authoritatively live while the served code and the signed
    // activation disagree; do not mark anything.
    return { digest_match, examined: 0, newly_live: [] };
  }
  const liveMintable = new Set(
    PROPOSED_ACTION_POLICY_ENTRIES
      .filter((e) => MINTABLE.has(e.mint_disposition))
      .map((e) => e.action_type),
  );
  const rulings = await listPolicyRulings(db);
  const candidates = rulings.filter(
    (r) => r.ruling === 'building' && !r.live_at && liveMintable.has(r.action_type),
  );
  const newly_live: string[] = [];
  for (const ruling of candidates) {
    const transitioned = await markPolicyRulingLive(db, ruling.action_type, now);
    if (transitioned) newly_live.push(ruling.action_type);
  }
  return { digest_match, examined: candidates.length, newly_live };
}

/**
 * The NAMED rows of the signed matrix, or null when the served code and the
 * signed activation disagree (nothing has "landed" while `digest_match` is not
 * true). Every named row counts — eligible or record_only — because a named row
 * IS the signed ruling for its type.
 */
export async function signedMatrixNamedRows(
  db: Firestore,
): Promise<ReadonlyMap<string, { mintDisposition: string; reasonCode: string }> | null> {
  if (!await digestMatches(db)) return null;
  return new Map(PROPOSED_ACTION_POLICY_ENTRIES.map((e) => [
    e.action_type,
    { mintDisposition: e.mint_disposition, reasonCode: e.reason_code },
  ]));
}

export interface QueueResolutionResult {
  readonly digest_match: boolean;
  readonly examined: number;
  readonly resolved: readonly string[];
}

/**
 * a type's pending-policy queue row resolves when the type
 * lands in the signed matrix. Sweeps every named matrix type's queue row (one
 * batched read) and moves each still-`pending_policy` row to
 * `resolved_signed_matrix`. Runs from the hourly action-type-reconcile job; the
 * 5-minute alert scan also resolves a due row through `landedRowResolver`
 * instead of alerting it, so a landed type never nags again.
 */
export async function resolveQueueRowsLandedInSignedMatrix(
  db: Firestore,
  now: number = Date.now(),
): Promise<QueueResolutionResult> {
  const named = await signedMatrixNamedRows(db);
  if (named === null) return { digest_match: false, examined: 0, resolved: [] };
  const refs = [...named.keys()].map(
    (t) => db.collection(PENDING_POLICY_COLLECTION).doc(actionPolicyDocumentId(t)),
  );
  const snaps = refs.length > 0 ? await db.getAll(...refs) : [];
  const pending = snaps
    .filter((s) => s.exists)
    .map((s) => s.data() as PendingPolicyQueueDocument)
    .filter((d) => d.policy_review_state === 'pending_policy' && named.has(d.action_type));
  const resolved: string[] = [];
  for (const doc of pending) {
    const row = named.get(doc.action_type)!;
    const moved = await resolvePendingPolicyActionBySignedMatrix(db, {
      actionType: doc.action_type,
      matrixMintDisposition: row.mintDisposition,
      matrixReasonCode: row.reasonCode,
      now,
    });
    if (moved) resolved.push(doc.action_type);
  }
  return { digest_match: true, examined: pending.length, resolved };
}

/**
 * For the alert scan: a resolver that closes a due queue row whose type has
 * landed on the signed matrix (returns true → resolved, do not alert). Returns
 * null when nothing has landed authoritatively (digest mismatch), so the scan
 * alerts exactly as before.
 */
export async function landedRowResolver(
  db: Firestore,
  now: number = Date.now(),
): Promise<((doc: PendingPolicyQueueDocument) => Promise<boolean>) | null> {
  const named = await signedMatrixNamedRows(db);
  if (named === null) return null;
  return async (doc) => {
    const row = named.get(doc.action_type);
    if (!row) return false;
    await resolvePendingPolicyActionBySignedMatrix(db, {
      actionType: doc.action_type,
      matrixMintDisposition: row.mintDisposition,
      matrixReasonCode: row.reasonCode,
      now,
    });
    return true;
  };
}
