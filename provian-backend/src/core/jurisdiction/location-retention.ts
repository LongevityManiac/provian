/** Wallet location retention is tied to a real mint hold/denial, never an authentication. */
import { createHash } from 'crypto';
import { FieldValue, Timestamp, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { actorWalletAddresses, SESSION_COLLECTION, type MintCompliance } from './mint-compliance';

/** Only an opaque event identity, reason and first decision time; contains no location or wallet. */
export const COMPLIANCE_EVENTS_COLLECTION = 'mint_compliance_events_v1';
export interface ComplianceRetentionPlan {
  readonly eventId: string;
  readonly reason: string;
  readonly peId: string;
  readonly actorId: string;
  readonly heldAtMs: number;
  readonly addresses: readonly string[];
}
/** Calendar years, clamped to February 28 when the anniversary is not a leap year. */
export function complianceRetentionDeadline(heldAtMs: number): number {
  if (!Number.isSafeInteger(heldAtMs) || heldAtMs < 0) throw new Error('invalid_compliance_event_time');
  const date = new Date(heldAtMs);
  const month = date.getUTCMonth();
  date.setUTCFullYear(date.getUTCFullYear() + 10);
  if (date.getUTCMonth() !== month) date.setUTCDate(0);
  return date.getTime();
}
export function rowHasComplianceHold(row: Readonly<Record<string, unknown>>): boolean {
  return row.jurisdiction_mint_held === true || row.mint_status === 'pending_compliance'
    || row.mint_status === 'deferred' && row.jurisdiction_compliance_reason === 'jurisdiction_deferred'
    || row.mint_status === 'ineligible' && row.jurisdiction_compliance_reason === 'sdn_hit' && row.jurisdiction_mint_held !== false;
}
export async function planComplianceRetention(db: Firestore, id: string, row: Readonly<Record<string, unknown>>,
  nowMs: number, decision?: MintCompliance, addressCache?: Map<string, Promise<string[]>>): Promise<ComplianceRetentionPlan[]> {
  if (decision ? decision.policy === 'immediate' : !rowHasComplianceHold(row)) return [];
  const reason = decision?.reason ?? String(row.jurisdiction_compliance_reason);
  if (!['jurisdiction_blocked', 'jurisdiction_deferred', 'jurisdiction_unknown', 'sdn_hit', 'sdn_unavailable'].includes(reason)) return [];
  const route = row.beneficiary_routing_snapshot as { human_address?: string } | undefined;
  const actor = String(row.userId ?? '');
  let pending = addressCache?.get(actor);
  if (!pending) { pending = actorWalletAddresses(db, actor); addressCache?.set(actor, pending); }
  const addresses = [...await pending];
  if (route?.human_address && /^0x[0-9a-f]{40}$/i.test(route.human_address)) addresses.push(route.human_address.toLowerCase());
  return [{ eventId: createHash('sha256').update(id).digest('hex'), reason, peId: id, actorId: actor,
    heldAtMs: nowMs, addresses: [...new Set(addresses)] }];
}
export interface PreparedComplianceRetention {
  (): void;
  readonly actorDeadlines: ReadonlyMap<string, number>;
}
/** Read before any writes. The closure commits with the mint's actual disposition. */
export async function prepareComplianceRetention(db: Firestore, txn: Transaction,
  plans: readonly ComplianceRetentionPlan[], nowMs: number): Promise<PreparedComplianceRetention> {
  const unique = [...new Map(plans.map(p => [p.eventId, p])).values()];
  const events = await Promise.all(unique.map(p => txn.get(db.collection(COMPLIANCE_EVENTS_COLLECTION).doc(p.eventId))));
  const { locationErasureId } = await import('./location-copy-erasure');
  const actors = [...new Set(unique.map(p => p.actorId))];
  const erasureMarkers = await Promise.all(actors.map(actor => txn.get(db.collection(COMPLIANCE_EVENTS_COLLECTION).doc(locationErasureId(actor)))));
  const actorDeadlines = new Map<string, number>();
  const addresses = [...new Set(unique.flatMap(p => p.addresses))];
  const locations = await Promise.all(addresses.map(address => txn.get(db.collection(SESSION_COLLECTION).doc(address))));
  const deadlines = new Map<string, number>();
  unique.forEach((plan, i) => {
    const heldAtMs = events[i].exists ? events[i].data()?.held_at_ms as number : plan.heldAtMs;
    const until = complianceRetentionDeadline(heldAtMs);
    // Retrying an old hold cannot recreate its observation after its ten-year deadline.
    if (until <= nowMs) return;
    actorDeadlines.set(plan.actorId, Math.max(actorDeadlines.get(plan.actorId) ?? 0, until));
    for (const address of plan.addresses) deadlines.set(address, Math.max(deadlines.get(address) ?? 0, until));
  });
  const commit = (): void => {
    unique.forEach((plan, i) => { if (!events[i].exists) txn.create(db.collection(COMPLIANCE_EVENTS_COLLECTION).doc(plan.eventId), { reason: plan.reason, held_at_ms: plan.heldAtMs, pe_id: plan.peId, actor_id: plan.actorId, location_expires_at_ms: complianceRetentionDeadline(plan.heldAtMs) }); });
    erasureMarkers.forEach((snap, i) => {
      const until = actorDeadlines.get(actors[i]);
      if (snap.exists && until && until > Number(snap.data()?.retention_until_ms ?? 0)) txn.update(db.collection(COMPLIANCE_EVENTS_COLLECTION).doc(locationErasureId(actors[i])), { retention_until_ms: until });
    });
    locations.forEach((snap, i) => {
      const until = deadlines.get(addresses[i]);
      if (!until) return;
      const before = snap.data() ?? {};
      if (typeof before.retention_until_ms === 'number' && before.retention_until_ms >= until) return;
      // No IP is fabricated if screening failed before a location was observed.
      txn.set(db.collection(SESSION_COLLECTION).doc(addresses[i]), { ...before, address: addresses[i], retention_until_ms: until, expire_at: Timestamp.fromMillis(until) });
    });
  };
  return Object.assign(commit, { actorDeadlines });
}
/** A settlement/recovery gate has actually refused a mint. Rechecks reuse the first event time. */
export async function retainComplianceDecision(db: Firestore, id: string, row: Readonly<Record<string, unknown>>,
  decision: MintCompliance, nowMs = Date.now()): Promise<void> {
  if (decision.policy === 'immediate') return;
  const plans = await planComplianceRetention(db, id, row, nowMs, decision);
  await db.runTransaction(async txn => { const commit = await prepareComplianceRetention(db, txn, plans, nowMs); commit(); });
}
/** Claims can fold many acts; preserve each original mint's clock through every payout shape. */
export async function retainComplianceDecisions(db: Firestore, ids: readonly string[], row: Readonly<Record<string, unknown>>,
  decision: MintCompliance, nowMs = Date.now()): Promise<void> {
  if (decision.policy === 'immediate') return;
  const cache = new Map<string, Promise<string[]>>();
  const unique = [...new Set(ids)];
  // Transport-sized transactions, without imposing an economic or retention-count limit.
  for (let offset = 0; offset < unique.length; offset += 100) {
    const plans = (await Promise.all(unique.slice(offset, offset + 100)
      .map(id => planComplianceRetention(db, id, row, nowMs, decision, cache)))).flat();
    await db.runTransaction(async txn => { const commit = await prepareComplianceRetention(db, txn, plans, nowMs); commit(); });
  }
}
/** Called after wallet release, before account removal. Other wallets and agent identities stay separate. */
export async function deleteWalletLocation(db: Firestore, address: string, nowMs: number): Promise<boolean> {
  if (!/^0x[0-9a-f]{40}$/i.test(address)) return false;
  return db.runTransaction(async txn => {
    const ref = db.collection(SESSION_COLLECTION).doc(address.toLowerCase());
    const snap = await txn.get(ref);
    if (!snap.exists) return false;
    const before = snap.data()!;
    if (typeof before.retention_until_ms === 'number' && before.retention_until_ms > nowMs) {
      txn.set(ref, { ...before, deletion_requested_at_ms: before.deletion_requested_at_ms ?? nowMs });
      return false;
    }
    txn.delete(ref); return true;
  });
}
/** Bounded, indexed hourly expiry; re-read transactionally so a newer hold cannot be erased. */
export async function purgeExpiredWalletLocations(db: Firestore, nowMs = Date.now()): Promise<{ scanned: number; deleted: number; erased_copy_events: number }> {
  const { eraseActorLocationCopies, locationErasureId } = await import('./location-copy-erasure');
  const events = await db.collection(COMPLIANCE_EVENTS_COLLECTION).where('location_expires_at_ms', '<=', nowMs).limit(100).get();
  const actors = new Map<string, Set<string>>();
  for (const event of events.docs) {
    const data = event.data();
    if (typeof data.actor_id !== 'string' || typeof data.pe_id !== 'string') throw new Error('invalid_location_copy_expiry');
    const ids = actors.get(data.actor_id) ?? new Set<string>(); ids.add(data.pe_id); actors.set(data.actor_id, ids);
  }
  // Fence restorations before traversal; a crash leaves the queue entry for an idempotent retry.
  for (const event of events.docs) await event.ref.update({ location_copies_erased_at_ms: nowMs });
  for (const [actor, ids] of actors) {
    const marker = (await db.collection(COMPLIANCE_EVENTS_COLLECTION).doc(locationErasureId(actor)).get()).data();
    let liveRetention = 0;
    if (marker) for (const address of await actorWalletAddresses(db, actor)) {
      const observation = (await db.collection(SESSION_COLLECTION).doc(address).get()).data();
      if (typeof observation?.retention_until_ms === 'number') liveRetention = Math.max(liveRetention, observation.retention_until_ms);
    }
    // At the last retained hold's deadline, also erase ordinary copies kept with a deleted account.
    await eraseActorLocationCopies(db, actor, nowMs, marker && liveRetention <= nowMs ? undefined : ids, ids);
  }
  for (const event of events.docs) await event.ref.update({ location_expires_at_ms: FieldValue.delete(), pe_id: FieldValue.delete(), actor_id: FieldValue.delete() });
  const due = await db.collection(SESSION_COLLECTION).where('retention_until_ms', '<=', nowMs).limit(400).get();
  let deleted = 0;
  for (const doc of due.docs) {
    const removed = await db.runTransaction(async txn => {
      const snap = await txn.get(doc.ref);
      const until = snap.data()?.retention_until_ms;
      if (!snap.exists || typeof until !== 'number' || until > nowMs) return false;
      txn.delete(doc.ref); return true;
    });
    if (removed) deleted++;
  }
  return { scanned: due.size, deleted, erased_copy_events: events.size };
}
