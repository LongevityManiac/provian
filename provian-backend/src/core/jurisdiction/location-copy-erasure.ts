/** Relay-owned location projections are mutable metadata, never sealed economic inputs. */
import { createHash } from 'crypto';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { visitQueryDocuments } from '../provenance/private-store';
import { actorWalletAddresses, SESSION_COLLECTION } from './mint-compliance';
import { COMPLIANCE_EVENTS_COLLECTION } from './location-retention';
export function locationErasureId(actorId: string): string {
  return 'erasure_' + createHash('sha256').update(actorId).digest('hex');
}
export function eraseRowLocation(row: Record<string, unknown>, nowMs: number): void {
  row.jurisdiction_context = '';
  row.jurisdiction_region = null;
  void nowMs;
}
/** One actor read per batch; conflicts with deletion before any late seal can restore a copy. */
export async function prepareLocationCopyFence(db: Firestore, txn: Transaction, actorId: string,
  rows: readonly Record<string, unknown>[], nowMs: number, checkExpiredEvents = false, retainedInTransactionUntil = 0): Promise<void> {
  const marker = await txn.get(db.collection(COMPLIANCE_EVENTS_COLLECTION).doc(locationErasureId(actorId)));
  const data = marker.data();
  const erasedActor = retainedInTransactionUntil <= nowMs && marker.exists && !(typeof data?.retention_until_ms === 'number' && data.retention_until_ms > nowMs);
  if (erasedActor) for (const row of rows) eraseRowLocation(row, nowMs);
  if (checkExpiredEvents) {
    for (const row of rows) {
      if (typeof row.peId !== 'string') continue;
      const id = createHash('sha256').update(row.peId).digest('hex');
      const event = await txn.get(db.collection(COMPLIANCE_EVENTS_COLLECTION).doc(id));
      if (typeof event.data()?.location_copies_erased_at_ms === 'number') eraseRowLocation(row, nowMs);
    }
  }
}
/** Persist before traversal. In-flight writers read this fence in their disposition transaction. */
export async function beginLocationErasure(db: Firestore, actorId: string, retentionUntilMs: number, nowMs: number): Promise<number> {
  const ref = db.collection(COMPLIANCE_EVENTS_COLLECTION).doc(locationErasureId(actorId));
  const addresses = await actorWalletAddresses(db, actorId);
  return db.runTransaction(async txn => {
    const before = (await txn.get(ref)).data();
    const sessions = await Promise.all(addresses.map(address => txn.get(db.collection(SESSION_COLLECTION).doc(address))));
    const until = Math.max(typeof before?.retention_until_ms === 'number' ? before.retention_until_ms : 0, retentionUntilMs,
      ...sessions.map(s => typeof s.data()?.retention_until_ms === 'number' ? s.data()!.retention_until_ms as number : 0));
    txn.set(ref, { deleted_at_ms: before?.deleted_at_ms ?? nowMs, retention_until_ms: until });
    return until;
  });
}
/** Erase all actor copies on ordinary deletion, or just expired mint identities on legal expiry. */
export async function eraseActorLocationCopies(db: Firestore, actorId: string, nowMs: number,
  selectedPeIds?: ReadonlySet<string>, expiredPeIds?: ReadonlySet<string>): Promise<number> {
  let changed = 0;
  for (const [home, field] of [['pe_history', 'userId'], ['meter_act_keys_v1', 'actor_id'],
    ['meter_held_acts_v1', 'actor_id'], ['meter_batch_acts_v1', 'actor_id']] as const) {
    await visitQueryDocuments(db.collection(home).where(field, '==', actorId), async doc => {
      const didChange = await db.runTransaction(async txn => {
        const snap = await txn.get(doc.ref);
        if (!snap.exists) return false;
        let onlyIds = selectedPeIds;
        if (!selectedPeIds) {
          const fence = await txn.get(db.collection(COMPLIANCE_EVENTS_COLLECTION).doc(locationErasureId(actorId)));
          if (typeof fence.data()?.retention_until_ms === 'number' && fence.data()!.retention_until_ms > nowMs) {
            if (!expiredPeIds) return false;
            onlyIds = expiredPeIds;
          }
        }
        const data = snap.data()!;
        if (data[field] !== actorId) return false;
        const patch: Record<string, unknown> = {};
        const scrub = (id: string, value: unknown, prefix: string): void => {
          if (onlyIds && !onlyIds.has(id)) return;
          if (!value || typeof value !== 'object' || Array.isArray(value)) return;
          const row = value as Record<string, unknown>;
          if (!row.jurisdiction_context && !row.jurisdiction_region) return;
          patch[prefix + 'jurisdiction_context'] = '';
          patch[prefix + 'jurisdiction_region'] = null;
        };
        if (home === 'meter_batch_acts_v1') {
          const acts = data.acts as Record<string, { row?: unknown }> | undefined;
          for (const [id, act] of Object.entries(acts ?? {})) scrub(id, act.row, `acts.${id}.row.`);
        } else if (home === 'meter_held_acts_v1') scrub(doc.id, (data.key as { row?: unknown } | undefined)?.row, 'key.row.');
        else scrub(doc.id, home === 'pe_history' ? data : data.row, home === 'pe_history' ? '' : 'row.');
        if (!Object.keys(patch).length) return false;
        txn.update(doc.ref, patch); return true;
      });
      if (didChange) changed++;
    });
  }
  return changed;
}
