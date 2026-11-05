/**
 * the finality STATE of a recorded PVT burn, read without the finalizer.
 *
 * A leaf module (constants only) so the settlement claim inlet can gate on it without importing the
 * finalizer / revoker (`burn-finality.ts`) and everything that touches.
 */

import { PVT_BURN_RECORDS_COLLECTION } from '../commons/burn-consumption';
import { SPEECH_WINDOW_RESERVATIONS_COLLECTION, speechPeNeedsPass } from '../pvt/speech-window-budget';

export type BurnFinality = 'provisional' | 'final' | 'failed';

/**
 * the burn-finality ops alarm: `system_status/burn_finality` (`{alarm, verdict, …}`), written
 * by the finality sweep while any provisional burn is STALLED, read by the operator alarm check.
 * Here (a leaf) so the alarm reader does not import the finalizer.
 */
export const BURN_FINALITY_STATUS_COLLECTION = 'system_status';
export const BURN_FINALITY_STATUS_DOCUMENT = 'burn_finality';

/** The one read this module needs — satisfied by Firestore and by the settlement store's `SettlementDb`. */
export interface DocReader {
  collection(name: string): {
    doc(id: string): { get(): Promise<{ exists: boolean; data(): unknown }> };
  };
}

/**
 * The finality of a stored burn row. A recorded row with no `finality` was recorded before this
 * ruling, when a burn was recorded only AT finality — it is final. A revoked row is failed.
 */
export function burnFinalityOf(row: Record<string, unknown> | undefined): BurnFinality | null {
  if (!row) return null;
  if (row.status === 'revoked' || row.finality === 'failed') return 'failed';
  if (row.status !== 'recorded') return null;
  if (row.finality === 'provisional') return 'provisional';
  return 'final';
}

async function burnIsFinal(db: DocReader, burnId: unknown): Promise<boolean> {
  if (typeof burnId !== 'string' || burnId.length === 0) return false;
  const burn = await db.collection(PVT_BURN_RECORDS_COLLECTION).doc(burnId).get();
  return burnFinalityOf(burn.exists ? (burn.data() as Record<string, unknown>) : undefined) === 'final';
}

/**
 * settlement gate: a Commons speech PE registers for settlement only once EVERY burn backing
 * it is FINAL — the talking pass it was budgeted under, and (a challenge) the stake it posted
 * (`metadata.stake_burn_id`). `true` = every backing burn is final (or there is none); `false` = hold
 * it (provisional: re-read next run) or never (revoked / unreadable).
 */
export async function speechPeWindowBurnFinal(
  db: DocReader,
  peId: string,
  actionType: unknown,
  metadata?: Record<string, unknown> | null,
): Promise<boolean> {
  if (typeof actionType !== 'string' || !speechPeNeedsPass(actionType)) return true;
  if (metadata && metadata.stake_burn_id !== undefined && !(await burnIsFinal(db, metadata.stake_burn_id))) {
    return false;
  }
  const reservation = await db.collection(SPEECH_WINDOW_RESERVATIONS_COLLECTION).doc(peId).get();
  if (!reservation.exists) return true; // no window budgeted it — nothing burn-backed to hold
  return burnIsFinal(db, (reservation.data() as { burn_id?: unknown } | undefined)?.burn_id);
}

