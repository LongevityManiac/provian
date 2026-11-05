import { isDeepStrictEqual } from 'util';
import { createHash, createHmac } from 'crypto';
import type { Firestore, DocumentSnapshot, Transaction } from 'firebase-admin/firestore';
import { privateRetentionCollection, privateRetentionKey } from '../provenance/private-retention';
import { NoveltyCounterConflictError } from './batch-pricing-counters';
import { BATCH_OCCURRENCES_COLLECTION, OCCURRENCE_LEAF_LIMIT, nodeMembers, occurrenceNodeId, packFingerprints, type OccurrenceNode } from './occurrence-tree';
import { OccurrenceResidency, OCCURRENCE_STATES, occurrenceDueDay, occurrenceStateId, occurrenceDueRef, occurrenceDueRecord } from './occurrence-residency';
export { BATCH_OCCURRENCES_COLLECTION } from './occurrence-tree';

/** Permanent exact membership across every device; bare 32-byte fingerprints, never indexed per entry. */
export function relayOccurrenceDigest(peId: string): string {
  return createHash('sha256').update(`meter-relay-occurrence:v1\0${peId}`).digest('hex');
}
export function crossWitnessOccurrenceDigest(collection: string, claimId: string): string {
  return createHash('sha256').update(`meter-cross-witness:v1\0${collection}\0${claimId}`).digest('hex');
}
interface ReadNode { snap: DocumentSnapshot; node: OccurrenceNode; members: Set<string>; added: Set<string> }
const contexts = new WeakMap<Firestore, BatchOccurrences>();
export function bindBatchOccurrences(db: Firestore, occurrences: BatchOccurrences): void { contexts.set(db, occurrences); }
export function batchOccurrencesFor(db: Firestore): BatchOccurrences | undefined { return contexts.get(db); }
function sameVersion(prior: DocumentSnapshot, current: DocumentSnapshot): boolean {
  if (prior.exists !== current.exists) return false;
  if (!prior.exists) return true;
  if (prior.updateTime && current.updateTime) return prior.updateTime.isEqual(current.updateTime);
  // Handwritten stores lack native timestamps; compare the complete immutable read instead.
  return isDeepStrictEqual(prior.data(), current.data());
}
export class BatchOccurrences {
  private readonly nodes = new Map<string, Promise<ReadNode>>();
  private readonly loaded = new Map<string, ReadNode>();
  private readonly legacy = new Map<string, Promise<Set<string>>>();
  private readonly actors = new Map<string, Promise<DocumentSnapshot>>();
  private readonly residency: OccurrenceResidency;
  constructor(private readonly db: Firestore, residency?: OccurrenceResidency, private readonly touchActivity = true) { this.residency = residency ?? new OccurrenceResidency(db); }
  private actor(actor: string): Promise<DocumentSnapshot> {
    let promise = this.actors.get(actor);
    if (!promise) { promise = this.residency.hot(actor); this.actors.set(actor, promise); }
    return promise;
  }
  private async load(actor: string, prefix: string): Promise<ReadNode> {
    await this.actor(actor);
    const id = occurrenceNodeId(actor, prefix);
    if (!this.nodes.has(id)) this.nodes.set(id, (async () => {
      const snap = await this.db.collection(BATCH_OCCURRENCES_COLLECTION).doc(id).get();
      const node: OccurrenceNode = snap.exists ? snap.data() as OccurrenceNode : { actor_id: actor, prefix, revision: 0, split: false, fingerprints: Buffer.alloc(0) };
      const read = { snap, node, members: new Set(nodeMembers(node, actor, prefix)), added: new Set<string>() };
      this.loaded.set(id, read); return read;
    })());
    return this.nodes.get(id)!;
  }
  private legacyMembers(actor: string): Promise<Set<string>> {
    if (!this.legacy.has(actor)) this.legacy.set(actor, (async () => {
      const carry = await this.db.collection('meter_occurrence_carry_v1').doc('live').get();
      if (carry.data()?.complete === true) return new Set<string>();
      const snap = await privateRetentionCollection(this.db, 'device_occurrence_mint_claims').where('owner_user_id', '==', actor).get();
      const members = new Set<string>();
      for (const doc of snap.docs) {
        const claim = doc.data();
        if (claim.claim_kind !== 'device_occurrence' || claim.subject_id !== actor
          || typeof claim.event_id !== 'string' || !/^[a-f0-9]{64}$/.test(claim.event_id)) throw new Error('meter_legacy_occurrence_invalid');
        members.add(claim.event_id);
      }
      return members;
    })());
    return this.legacy.get(actor)!;
  }
  async claim(actor: string, occurrence: string): Promise<boolean> {
    const legacy = (await this.legacyMembers(actor)).has(occurrence);
    return await this.remember(actor, occurrence) && !legacy;
  }
  private member(actor: string, occurrence: string): string {
    if (!/^[a-f0-9]{64}$/.test(occurrence)) throw new Error('meter_occurrence_invalid');
    return createHmac('sha256', privateRetentionKey()).update(`meter-occurrence:v1\0${actor}\0${occurrence}`).digest('hex');
  }
  async contains(actor: string, occurrence: string): Promise<boolean> {
    const member = this.member(actor, occurrence); let prefix = '';
    for (;;) {
      const read = await this.load(actor, prefix);
      if (read.node.split) { prefix = member.slice(0, prefix.length + 1); continue; }
      return read.members.has(member) || read.added.has(member);
    }
  }
  async remember(actor: string, occurrence: string): Promise<boolean> {
    const member = this.member(actor, occurrence); let prefix = '';
    for (;;) {
      const read = await this.load(actor, prefix);
      if (read.node.split) { prefix = member.slice(0, prefix.length + 1); continue; }
      if (read.members.has(member) || read.added.has(member)) return false;
      read.added.add(member); return true;
    }
  }
  async inspect(txn: Transaction): Promise<void> {
    for (const [actor, pending] of this.actors) {
      const prior = await pending, current = await txn.get(prior.ref ?? this.db.collection(OCCURRENCE_STATES).doc(occurrenceStateId(actor)));
      if (!sameVersion(prior, current)) throw new NoveltyCounterConflictError();
    }
    for (const read of this.loaded.values()) {
      const current = await txn.get(read.snap.ref ?? this.db.collection(BATCH_OCCURRENCES_COLLECTION).doc(occurrenceNodeId(read.node.actor_id, read.node.prefix)));
      if (!sameVersion(read.snap, current)) throw new NoveltyCounterConflictError();
    }
  }
  commit(txn: Transaction): void {
    const now = Date.now();
    for (const actor of this.touchActivity ? this.actors.keys() : []) {
      txn.set(occurrenceDueRef(this.db, actor), occurrenceDueRecord(actor, now));
      txn.set(this.db.collection(OCCURRENCE_STATES).doc(occurrenceStateId(actor)), {
      actor_id: actor, residency: 'hot', last_active_at_ms: now, archive_due_day: occurrenceDueDay(now),
      });
    }
    for (const read of this.loaded.values()) {
      if (read.added.size === 0) continue;
      const members = [...read.members, ...read.added].sort(), { members: _legacy, ...prior } = read.node;
      const node = { ...prior, revision: prior.revision + 1, fingerprints: packFingerprints(members) };
      if (members.length <= OCCURRENCE_LEAF_LIMIT) txn.set(read.snap.ref ?? this.db.collection(BATCH_OCCURRENCES_COLLECTION).doc(occurrenceNodeId(read.node.actor_id, read.node.prefix)), node);
      else {
        txn.set(read.snap.ref ?? this.db.collection(BATCH_OCCURRENCES_COLLECTION).doc(occurrenceNodeId(read.node.actor_id, read.node.prefix)), { ...node, split: true, fingerprints: Buffer.alloc(0) });
        for (const digit of '0123456789abcdef') {
          const prefix = node.prefix + digit;
          txn.create(this.db.collection(BATCH_OCCURRENCES_COLLECTION).doc(occurrenceNodeId(node.actor_id, prefix)), {
            actor_id: node.actor_id, prefix, revision: 1, split: false, fingerprints: packFingerprints(members.filter(m => m.startsWith(prefix))),
          });
        }
      }
    }
  }
}
