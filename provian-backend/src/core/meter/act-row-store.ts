import { privateRetentionCollection, protectRetainedFields } from '../provenance/private-retention';
/**
 * ONE place to read an act's priced row, wherever it lives.
 *
 * A metered act's row lives inside its 31-day act key (`meter_act_keys_v1/{relayPeId}.row`); a
 * pre-meter act's row lived in `pe_history/{peId}` until the meter migration deleted every PE
 * row. The mint-once duplicate cross-check, commit/completion takeover and the incumbent
 * corroboration all ask the same question ("what did the incumbent seal as, and may it still
 * change?") and must get the same answer from either home, so they read through here.
 *
 * Neither home present means the incumbent's record is gone (expired act key, or a legacy row
 * the migration retired). Callers treat that as "the slot is owned and closed": never a
 * takeover, never a second mint.
 */

import type { DocumentReference, Firestore, Transaction } from 'firebase-admin/firestore';
import { METER_ACT_KEYS_COLLECTION } from './meter-store';

const LEGACY_PE_HISTORY_COLLECTION = 'pe_history';

export interface ActRowHandle {
  readonly home: 'meter' | 'legacy';
  readonly ref: DocumentReference;
  readonly row: Record<string, unknown>;
}

function rowFromSnapshot(
  home: 'meter' | 'legacy',
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!data) return null;
  if (home === 'legacy') return data;
  const row = data.row;
  return row !== null && typeof row === 'object' && !Array.isArray(row)
    ? (row as Record<string, unknown>)
    : null;
}

export async function readActRow(db: Firestore, peId: string): Promise<ActRowHandle | null> {
  const meterRef = privateRetentionCollection(db, METER_ACT_KEYS_COLLECTION).doc(peId);
  const meter = await meterRef.get();
  const meterRow = meter.exists ? rowFromSnapshot('meter', meter.data()) : null;
  if (meterRow !== null) return { home: 'meter', ref: meterRef, row: meterRow };
  const legacyRef = db.collection(LEGACY_PE_HISTORY_COLLECTION).doc(peId);
  const legacy = await legacyRef.get();
  const legacyRow = legacy.exists ? rowFromSnapshot('legacy', legacy.data()) : null;
  return legacyRow !== null ? { home: 'legacy', ref: legacyRef, row: legacyRow } : null;
}

export async function readActRowInTransaction(
  db: Firestore,
  txn: Transaction,
  peId: string,
): Promise<ActRowHandle | null> {
  const meterRef = privateRetentionCollection(db, METER_ACT_KEYS_COLLECTION).doc(peId);
  const legacyRef = db.collection(LEGACY_PE_HISTORY_COLLECTION).doc(peId);
  // Both reads happen before any write in the caller's transaction (Firestore requires it).
  const [meter, legacy] = await Promise.all([txn.get(meterRef), txn.get(legacyRef)]);
  const meterRow = meter.exists ? rowFromSnapshot('meter', meter.data()) : null;
  if (meterRow !== null) return { home: 'meter', ref: meterRef, row: meterRow };
  const legacyRow = legacy.exists ? rowFromSnapshot('legacy', legacy.data()) : null;
  return legacyRow !== null ? { home: 'legacy', ref: legacyRef, row: legacyRow } : null;
}

/** Update mutable row fields (mint_status, corroboration_*, audit trail) in either home. */
export function updateActRowInTransaction(
  txn: Transaction,
  handle: ActRowHandle,
  patch: Readonly<Record<string, unknown>>,
): void {
  if (handle.home === 'legacy') {
    txn.update(handle.ref, { ...patch });
    return;
  }
  const nested: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(patch)) nested[`row.${field}`] = value;
  txn.update(handle.ref, protectRetainedFields(METER_ACT_KEYS_COLLECTION, nested));
}
