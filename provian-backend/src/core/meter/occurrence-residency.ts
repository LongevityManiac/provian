import { createHash, createHmac, randomUUID } from 'crypto';
import type { DocumentSnapshot, Firestore, Timestamp } from 'firebase-admin/firestore';
import { encodePrivateRecord, decodePrivateRecord, privateStorageId } from '../provenance/private-store';
import { createGcsArchiveObjectStore, type ArchiveObjectStore } from '../archive/archive-objects';
import { privateRetentionKey } from '../provenance/private-retention';
import { BATCH_OCCURRENCES_COLLECTION, OCCURRENCE_LEAF_LIMIT, nodeMembers, occurrenceNodeId, packFingerprints, unpackFingerprints, type OccurrenceNode } from './occurrence-tree';

export const OCCURRENCE_DUE = 'meter_occurrence_due_v1';
export const OCCURRENCE_STATES = 'meter_occurrence_states_v1';
export const OCCURRENCE_DORMANCY_MS = 90 * 86_400_000;
export const OCCURRENCE_ARCHIVE_BUCKET = 'provian-ai-pe-archive';
const MANIFEST_NODES = 128;
const MANIFEST_MAX_BYTES = 256 * 1024;
interface ObjectRef { path: string; sha256: string }
interface ArchivedNode {
  prefix: string;
  revision: number;
  split: boolean;
  count: number;
  stamp: readonly [number, number];
  object: ObjectRef | null;
}
interface Manifest { nodes: ArchivedNode[]; previous: ObjectRef | null }
interface BuildCursor { previous: ObjectRef; last_prefix: string; nodes: number; count: number; manifests: number }
interface TransferCursor { object: ObjectRef | null; offset: number; nodes: number; count: number }
export interface OccurrenceArchive extends ObjectRef { count: number; bytes: number; nodes: number; manifests: number }
export interface OccurrenceState {
  actor_id: string;
  residency: 'hot' | 'archiving' | 'cold' | 'restoring';
  last_active_at_ms: number;
  archive_due_day: string;
  operation_id?: string;
  archive?: OccurrenceArchive;
  archive_build?: BuildCursor;
  delete_cursor?: TransferCursor;
  restore_cursor?: TransferCursor;
}
export function occurrenceStateId(actor: string): string { return createHash('sha256').update(actor).digest('hex'); }
export function occurrenceDueDay(lastActive: number): string { return new Date(lastActive + OCCURRENCE_DORMANCY_MS).toISOString().slice(0, 10); }
function stateOf(snap: DocumentSnapshot, actor: string): OccurrenceState | null {
  if (!snap.exists) return null;
  const state = snap.data() as OccurrenceState;
  if (state.actor_id !== actor || !['hot', 'archiving', 'cold', 'restoring'].includes(state.residency)
    || !Number.isSafeInteger(state.last_active_at_ms) || typeof state.archive_due_day !== 'string') throw new Error('meter_occurrence_residency_invalid');
  return state;
}
function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function sameStamp(at: Timestamp | undefined, expected: readonly [number, number]): boolean {
  return at?.seconds === expected[0] && at.nanoseconds === expected[1];
}
/** Bounded leaf objects and chained manifests; no whole-actor array or history-sized buffer. */
export class OccurrenceResidency {
  private archiveStore: ArchiveObjectStore | undefined;
  private manifestCache: { path: string; sha256: string; base: string; value: Manifest } | undefined;
  constructor(private readonly db: Firestore, store?: ArchiveObjectStore) { this.archiveStore = store; }
  private store(): ArchiveObjectStore { return this.archiveStore ??= createGcsArchiveObjectStore(OCCURRENCE_ARCHIVE_BUCKET, undefined, async () => true); }
  private ref(actor: string): FirebaseFirestore.DocumentReference { return this.db.collection(OCCURRENCE_STATES).doc(occurrenceStateId(actor)); }
  private nodeRef(actor: string, prefix: string): FirebaseFirestore.DocumentReference { return this.db.collection(BATCH_OCCURRENCES_COLLECTION).doc(occurrenceNodeId(actor, prefix)); }
  async hot(actor: string): Promise<DocumentSnapshot> {
    for (;;) {
      const snap = await this.ref(actor).get(), state = stateOf(snap, actor);
      if (!state || state.residency === 'hot') return snap;
      if (state.residency === 'archiving') await this.finishArchive(actor, state);
      else await this.restore(actor, state);
    }
  }
  private async *liveNodes(actor: string, prefix = '', after?: string): AsyncGenerator<{ node: OccurrenceNode; stamp: readonly [number, number] }> {
    if (after !== undefined && prefix <= after && !after.startsWith(prefix)) return;
    const snap = await this.nodeRef(actor, prefix).get();
    if (!snap.exists) {
      if (prefix === '') return;
      throw new Error('meter_occurrence_tree_missing');
    }
    const node = snap.data() as OccurrenceNode;
    nodeMembers(node, actor, prefix);
    if (!snap.updateTime) throw new Error('meter_occurrence_node_version_missing');
    if (after === undefined || prefix > after) yield { node, stamp: [snap.updateTime.seconds, snap.updateTime.nanoseconds] };
    if (node.split) for (const digit of '0123456789abcdef') yield* this.liveNodes(actor, prefix + digit, after);
  }
  private async readObject(object: ObjectRef, maxBytes: number): Promise<Buffer> {
    if (!object || !/^dedupe\/v1\/[a-f0-9]{64}\/[a-zA-Z0-9-]+\/(?:node-[a-f0-9]*|manifest-[a-f0-9]{64})\.(?:bin|json)$/.test(object.path)
      || !/^[a-f0-9]{64}$/.test(object.sha256)) throw new Error('meter_occurrence_archive_invalid');
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of this.store().openRead(object.path)) {
      const bytes = Buffer.from(chunk as Uint8Array); length += bytes.length;
      if (length > maxBytes) throw new Error('meter_occurrence_archive_size');
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks);
    if (digest(bytes) !== object.sha256) throw new Error('meter_occurrence_archive_integrity');
    return bytes;
  }
  private async put(path: string, bytes: Buffer): Promise<ObjectRef> {
    const object = { path, sha256: digest(bytes) };
    try { await this.store().create(path, bytes); }
    catch (error) { if (!(error instanceof Error) || error.message !== 'archive_object_exists') throw error; }
    await this.readObject(object, Math.max(bytes.length, 1)); // full checksum before any live deletion
    return object;
  }
  private async nodeBytes(node: ArchivedNode): Promise<Buffer> {
    if (!/^[a-f0-9]{0,64}$/.test(node.prefix) || !Number.isSafeInteger(node.count) || node.count < 0 || node.count > OCCURRENCE_LEAF_LIMIT
      || !Number.isSafeInteger(node.revision) || node.revision < 0 || typeof node.split !== 'boolean'
      || node.split && node.count !== 0 || !Array.isArray(node.stamp) || node.stamp.length !== 2 || !node.stamp.every(Number.isSafeInteger)) throw new Error('meter_occurrence_archive_node_invalid');
    const bytes = node.object ? await this.readObject(node.object, OCCURRENCE_LEAF_LIMIT * 32) : Buffer.alloc(0);
    const members = unpackFingerprints(bytes);
    if (members.length !== node.count || members.some(member => !member.startsWith(node.prefix))) throw new Error('meter_occurrence_archive_count');
    return bytes;
  }
  async archive(actor: string, nowMs: number, deadlineMs = Number.POSITIVE_INFINITY): Promise<boolean> {
    const token = randomUUID();
    const started = await this.db.runTransaction(async txn => {
      const ref = this.ref(actor), snap = await txn.get(ref), state = stateOf(snap, actor);
      if (state?.residency === 'cold') { txn.delete(occurrenceDueRef(this.db, actor)); return false; }
      if (!state || state.residency !== 'hot' || nowMs - state.last_active_at_ms < OCCURRENCE_DORMANCY_MS) return false;
      const rootRef = this.nodeRef(actor, ''), root = await txn.get(rootRef);
      // Format fence: old writers require members[]. Their in-flight CAS fails on this change;
      // a retry cannot read the binary-only root. New writers additionally check residency.
      const node: OccurrenceNode = root.exists ? root.data() as OccurrenceNode : { actor_id: actor, prefix: '', revision: 0, split: false, fingerprints: Buffer.alloc(0) };
      const members = nodeMembers(node, actor, '');
      txn.set(rootRef, { actor_id: actor, prefix: '', revision: node.revision + 1, split: node.split, fingerprints: packFingerprints(members) });
      txn.set(ref, { ...state, residency: 'archiving', operation_id: token }); return true;
    });
    const state = stateOf(await this.ref(actor).get(), actor);
    if (state?.residency === 'archiving') await this.finishArchive(actor, state, deadlineMs);
    else if (state?.residency === 'restoring') await this.restore(actor, state, deadlineMs);
    return started;
  }
  private base(actor: string, token: string): string {
    const subject = createHmac('sha256', privateRetentionKey()).update('meter-cold-actor:v1\0' + actor).digest('hex');
    return `dedupe/v1/${subject}/${token}`;
  }
  private async manifest(object: ObjectRef, base: string): Promise<Manifest> {
    if (this.manifestCache?.path === object.path && this.manifestCache.sha256 === object.sha256 && this.manifestCache.base === base) return this.manifestCache.value;
    if (!object.path.startsWith(base + '/manifest-')) throw new Error('meter_occurrence_manifest_scope');
    const value = JSON.parse((await this.readObject(object, MANIFEST_MAX_BYTES)).toString('utf8')) as Manifest;
    if (!Array.isArray(value.nodes) || value.nodes.length > MANIFEST_NODES || !('previous' in value)
      || value.previous && !value.previous.path.startsWith(base + '/manifest-')) throw new Error('meter_occurrence_manifest_invalid');
    for (const node of value.nodes) if (node.object && node.object.path !== `${base}/node-${node.prefix}.bin`) throw new Error('meter_occurrence_node_scope');
    this.manifestCache = { ...object, base, value };
    return value;
  }
  private sameCursor(a: TransferCursor, b: TransferCursor): boolean {
    return a.object?.path === b.object?.path && a.object?.sha256 === b.object?.sha256 && a.offset === b.offset && a.nodes === b.nodes && a.count === b.count;
  }
  private async finishArchive(actor: string, initial: OccurrenceState, deadlineMs = Number.POSITIVE_INFINITY): Promise<void> {
    const ref = this.ref(actor), token = initial.operation_id;
    if (!token) throw new Error('meter_occurrence_archive_operation_missing');
    const base = this.base(actor, token);
    let archive = initial.archive;
    if (!archive || !archive.path.startsWith(base + '/')) {
      const build = initial.archive_build;
      let previous: ObjectRef | null = build?.previous ?? null, page: ArchivedNode[] = [], nodes = build?.nodes ?? 0,
        count = build?.count ?? 0, manifests = build?.manifests ?? 0, last = build?.last_prefix;
      const flush = async (): Promise<boolean> => {
        const bytes = Buffer.from(JSON.stringify({ nodes: page, previous }));
        previous = await this.put(`${base}/manifest-${digest(bytes)}.json`, bytes); manifests++;
        const checkpoint: BuildCursor = { previous, nodes, count, manifests, last_prefix: last! };
        page = [];
        return this.db.runTransaction(async txn => {
          const snap = await txn.get(ref), state = stateOf(snap, actor);
          if (state?.residency !== 'archiving' || state.operation_id !== token) return false;
          if (state.archive?.path.startsWith(base + '/')) return false;
          if ((state.archive_build?.nodes ?? 0) > nodes) return false;
          if ((state.archive_build?.nodes ?? 0) === nodes && state.archive_build?.previous.path !== previous!.path) return false;
          txn.set(ref, { ...state, archive_build: checkpoint }); return true;
        });
      };
      for await (const { node, stamp } of this.liveNodes(actor, '', last)) {
        const bytes = packFingerprints(nodeMembers(node, actor, node.prefix));
        const object = bytes.length ? await this.put(`${base}/node-${node.prefix}.bin`, bytes) : null;
        page.push({ prefix: node.prefix, revision: node.revision, split: node.split, count: bytes.length / 32, stamp, object });
        nodes++; count += bytes.length / 32; last = node.prefix;
        if (page.length === MANIFEST_NODES || Date.now() >= deadlineMs) { if (!await flush() || Date.now() >= deadlineMs) return; }
      }
      if (page.length && !await flush()) return;
      if (!previous) throw new Error('meter_occurrence_archive_root_missing');
      const actualNodes = (await this.db.collection(BATCH_OCCURRENCES_COLLECTION).where('actor_id', '==', actor).count().get()).data().count;
      if (actualNodes !== nodes) throw new Error('meter_occurrence_tree_orphans');
      archive = { ...previous, count, bytes: count * 32, nodes, manifests };
      const attached = await this.db.runTransaction(async txn => {
        const snap = await txn.get(ref), state = stateOf(snap, actor);
        if (state?.residency !== 'archiving' || state.operation_id !== token || state.archive?.path.startsWith(base + '/')) return false;
        txn.set(ref, { ...state, archive, delete_cursor: { object: archive, offset: 0, nodes: 0, count: 0 } }); return true;
      });
      if (!attached) return;
    }
    let state = stateOf(await ref.get(), actor);
    if (state?.residency !== 'archiving' || state.operation_id !== token) return;
    let cursor: TransferCursor = state.delete_cursor ?? { object: archive, offset: 0, nodes: 0, count: 0 };
    while (cursor.object) {
      const manifest = await this.manifest(cursor.object, base);
      if (cursor.offset >= manifest.nodes.length) throw new Error('meter_occurrence_delete_cursor_invalid');
      const node = manifest.nodes[cursor.offset]; await this.nodeBytes(node);
      const next: TransferCursor = { object: cursor.offset + 1 === manifest.nodes.length ? manifest.previous : cursor.object,
        offset: cursor.offset + 1 === manifest.nodes.length ? 0 : cursor.offset + 1, nodes: cursor.nodes + 1, count: cursor.count + node.count };
      const deleted = await this.db.runTransaction(async txn => {
        const snap = await txn.get(ref), currentState = stateOf(snap, actor);
        if (currentState?.residency !== 'archiving' || currentState.operation_id !== token || !currentState.delete_cursor || !this.sameCursor(currentState.delete_cursor, cursor)) return false;
        const nodeRef = this.nodeRef(actor, node.prefix), current = await txn.get(nodeRef);
        if (!(node.prefix === '' && current.get('_meter_residency_fence') === token)) {
          if (current.exists && !sameStamp(current.updateTime, node.stamp)) throw new Error('meter_occurrence_archive_writer_drift');
          if (node.prefix === '') txn.set(nodeRef, { actor_id: actor, prefix: '', _meter_residency_fence: token });
          else if (current.exists) txn.delete(nodeRef);
        }
        txn.set(ref, { ...currentState, delete_cursor: next }); return true;
      });
      if (!deleted) return;
      cursor = next;
      if (Date.now() >= deadlineMs) return;
    }
    if (cursor.nodes !== archive.nodes || cursor.count !== archive.count) throw new Error('meter_occurrence_manifest_incomplete');
    await this.db.runTransaction(async txn => {
      const snap = await txn.get(ref), currentState = stateOf(snap, actor);
      if (currentState?.residency === 'archiving' && currentState.operation_id === token) {
        const { archive_build: _build, delete_cursor: _cursor, ...cold } = currentState;
        txn.set(ref, { ...cold, residency: 'cold', archive });
        txn.delete(occurrenceDueRef(this.db, actor));
      }
    });
  }
  private async restore(actor: string, initial: OccurrenceState, deadlineMs = Number.POSITIVE_INFINITY): Promise<void> {
    const ref = this.ref(actor);
    if (initial.residency === 'cold') await this.db.runTransaction(async txn => {
      const snap = await txn.get(ref), state = stateOf(snap, actor);
      if (state?.residency === 'cold') txn.set(ref, { ...state, residency: 'restoring', restore_cursor: { object: state.archive, offset: 0, nodes: 0, count: 0 } });
    });
    const state = stateOf(await ref.get(), actor);
    if (state?.residency !== 'restoring') return;
    const token = state.operation_id, archive = state.archive;
    if (!token || !archive || !state.restore_cursor) throw new Error('meter_occurrence_archive_missing');
    const base = this.base(actor, token); let cursor = state.restore_cursor;
    while (cursor.object) {
      const manifest = await this.manifest(cursor.object, base);
      if (cursor.offset >= manifest.nodes.length) throw new Error('meter_occurrence_restore_cursor_invalid');
      const node = manifest.nodes[cursor.offset], bytes = await this.nodeBytes(node);
      const next: TransferCursor = { object: cursor.offset + 1 === manifest.nodes.length ? manifest.previous : cursor.object,
        offset: cursor.offset + 1 === manifest.nodes.length ? 0 : cursor.offset + 1, nodes: cursor.nodes + 1, count: cursor.count + node.count };
      const written = await this.db.runTransaction(async txn => {
        const snap = await txn.get(ref), current = stateOf(snap, actor);
        if (current?.residency !== 'restoring' || current.operation_id !== token || !current.restore_cursor || !this.sameCursor(current.restore_cursor, cursor)) return false;
        txn.set(this.nodeRef(actor, node.prefix), { actor_id: actor, prefix: node.prefix, revision: node.revision, split: node.split, fingerprints: bytes });
        txn.set(ref, { ...current, restore_cursor: next }); return true;
      });
      if (!written) return;
      cursor = next;
      if (Date.now() >= deadlineMs) return;
    }
    if (cursor.nodes !== archive.nodes || cursor.count !== archive.count) throw new Error('meter_occurrence_restore_integrity');
    const actualNodes = (await this.db.collection(BATCH_OCCURRENCES_COLLECTION).where('actor_id', '==', actor).count().get()).data().count;
    if (actualNodes !== archive.nodes) {
      if (stateOf(await ref.get(), actor)?.residency !== 'restoring') return;
      throw new Error('meter_occurrence_restore_integrity');
    }
    await this.db.runTransaction(async txn => {
      const snap = await txn.get(ref), current = stateOf(snap, actor);
      if (current?.residency === 'restoring' && current.operation_id === token) {
        const { restore_cursor: _cursor, ...hot } = current; const now = Date.now();
        txn.set(ref, { ...hot, residency: 'hot', last_active_at_ms: now, archive_due_day: occurrenceDueDay(now) });
        txn.set(occurrenceDueRef(this.db, actor), occurrenceDueRecord(actor, now));
      }
    });
  }
}

export function occurrenceDueRef(db: Firestore, actor: string): FirebaseFirestore.DocumentReference {
  return db.collection(OCCURRENCE_DUE).doc(privateStorageId(OCCURRENCE_DUE, actor));
}
export function occurrenceDueRecord(actor: string, lastActiveMs: number): FirebaseFirestore.DocumentData {
  return { ...encodePrivateRecord(OCCURRENCE_DUE, actor, { actor_id: actor }), due_at_ms: lastActiveMs + OCCURRENCE_DORMANCY_MS };
}
/** One indexed empty query for an active fleet. Work is checkpointed and bounded per invocation. */
export async function sweepDormantOccurrences(db: Firestore, nowMs = Date.now(), budgetMs = 45_000, store?: ArchiveObjectStore): Promise<{ examined: number; moved: number }> {
  const deadline = Date.now() + budgetMs, residency = new OccurrenceResidency(db, store);
  const due = await db.collection(OCCURRENCE_DUE).where('due_at_ms', '<=', nowMs).limit(50).get();
  let moved = 0, examined = 0;
  for (const doc of due.docs) {
    if (Date.now() >= deadline) break;
    const actor = decodePrivateRecord(OCCURRENCE_DUE, doc.id, doc.data(), db).data.actor_id;
    if (typeof actor !== 'string' || privateStorageId(OCCURRENCE_DUE, actor) !== doc.id) throw new Error('meter_occurrence_due_binding');
    examined++;
    if (await residency.archive(actor, nowMs, deadline)) moved++;
  }
  return { examined, moved };
}
