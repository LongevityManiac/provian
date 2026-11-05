import {privateRecordRange,PRIVATE_RANGE_FIELDS} from '../../src/core/provenance/private-range-index';
import {FieldPath, type Firestore, type QueryDocumentSnapshot, type DocumentSnapshot} from 'firebase-admin/firestore';
import {isDeepStrictEqual} from 'util';
import {PRIVATE_STORE_COLLECTIONS,privateStorageId,privateRecordLookup,decodePrivateRecord} from '../../src/core/provenance/private-store';
import {PRIVATE_RETENTION_STATE_COLLECTION,PRIVATE_RETENTION_STATE_DOC} from '../../src/core/provenance/private-retention';

/** Adds only secret equality/array indexes. Ciphertext, proofs, totals, claims and TTL stay exact.
 * Caller must first drain every writer running the earlier encoder. Completion is committed only
 * after a second complete scan; failed/conflicting rows leave the query gate closed. */
export async function backfillPrivateArrayLookups(db: Firestore, execute: boolean): Promise<{scanned:number;changed:number;verified:number}> {
  const state = db.collection(PRIVATE_RETENTION_STATE_COLLECTION).doc(PRIVATE_RETENTION_STATE_DOC);
  const ready = (await state.get()).data();
  if (ready?.opaque_records_complete !== true || ready.opaque_ids_ready !== true) throw new Error('private array indexes require certified opaque storage');
  // A failed rerun must fall back to complete logical scans; never leave an old certificate open.
  if (execute) await state.set({array_lookup_version:0,range_lookup_version:0},{merge:true});
  const collections = new Set(PRIVATE_STORE_COLLECTIONS);
  let inboxAfter: QueryDocumentSnapshot | undefined;
  for (;;) {
    let q = db.collectionGroup('inbox_v1').orderBy(FieldPath.documentId()).limit(200);
    if (inboxAfter) q = q.startAfter(inboxAfter);
    const page = await q.get();
    for (const doc of page.docs) if (/^agent_wallets\/[^/]+\/inbox_v1$/.test(doc.ref.parent.path)) collections.add(doc.ref.parent.path);
    if (page.size < 200) break;
    inboxAfter = page.docs.at(-1);
  }
  const report = {scanned:0,changed:0,verified:0};
  const patchOf = (collection: string, doc: DocumentSnapshot): Record<string, unknown> | null => {
    if (!doc.exists) return null;
    const old = doc.data()!, logical = decodePrivateRecord(collection,doc.id,old,db);
    if (old._provian_store !== 1 || doc.id !== privateStorageId(collection,logical.id)) throw new Error('uncertified private representation');
    const lookup = privateRecordLookup(logical.data,collection);
    const range = PRIVATE_RANGE_FIELDS[collection] ? privateRecordRange(collection,logical.data) : undefined;
    if (isDeepStrictEqual(old._provian_lookup,lookup) && (range === undefined || isDeepStrictEqual(old._provian_range,range))) return null;
    return {_provian_lookup:lookup,...(range === undefined ? {} : {_provian_range:range})};
  };
  const writeChunk = async (collection: string, initial: readonly DocumentSnapshot[]): Promise<void> => {
    let pending = [...initial];
    while (pending.length) {
      const write = db.batch(), changed: DocumentSnapshot[] = [];
      for (const doc of pending) { const patch = patchOf(collection,doc); if (!patch) continue; write.update(doc.ref,patch,{lastUpdateTime:doc.updateTime!}); changed.push(doc); }
      if (!changed.length) return;
      try { await write.commit(); return; }
      catch (error) {
        const code = (error as {code?:unknown}).code;
        if (![5,9,10].includes(Number(code))) throw error;
        // A current writer or TTL won the race. Re-read and recompute metadata only; never
        // patch an old lookup over a newly encrypted body or resurrect a deleted document.
        pending = await db.getAll(...changed.map(doc=>doc.ref));
      }
    }
  };
  for (const verifying of execute ? [false,true] : [false]) {
    for (const collection of collections) {
      let after: QueryDocumentSnapshot | undefined;
      for (;;) {
        let q = db.collection(collection).orderBy(FieldPath.documentId()).limit(200);
        if (after) q = q.startAfter(after);
        const page = await q.get();
        let staged: DocumentSnapshot[] = [], bytes = 0;
        const flush = async (): Promise<void> => { if (staged.length) await writeChunk(collection,staged); staged=[];bytes=0; };
        for (const doc of page.docs) {
          const patch = patchOf(collection,doc);
          if (verifying) { if (patch) throw new Error('private array lookup verification incomplete'); report.verified++; }
          else {
            report.scanned++;
            if (patch) {
              report.changed++;
              if (execute) {
                const size = Buffer.byteLength(JSON.stringify(patch));
                if (staged.length && (staged.length >= 50 || bytes + size > 4 * 1024 * 1024)) await flush();
                staged.push(doc);bytes+=size;
              }
            }
          }
        }
        await flush();
        if (page.size < 200) break;
        after = page.docs.at(-1);
      }
    }
  }
  if (execute) await state.set({array_lookup_version:1,range_lookup_version:1,array_lookup_completed_at_ms:Date.now()},{merge:true});
  return report;
}
