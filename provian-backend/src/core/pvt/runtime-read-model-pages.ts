import type { Firestore } from 'firebase-admin/firestore';
import { createHash, randomUUID } from 'crypto';

export const RUNTIME_READ_MODEL_PAGES_COLLECTION = 'pvt_runtime_read_model_pages_v1';
const PAGE_BYTES = 500_000;
export interface RuntimeReadModelPages {
  generation: string;
  fields: Record<string, { page_count: number; item_count: number }>;
}

/** JSON pages avoid Firestore's nested-map overhead as well as its document limit.
 * There is no item limit: every source row is retained in an immutable generation. */
export function partitionRuntimeRows(rows: readonly unknown[]): string[] {
  const pages: string[] = [];
  let page: string[] = [];
  let bytes = 2;
  for (const row of rows) {
    const json = JSON.stringify(row);
    if (json === undefined) throw new Error('runtime read model row is not serializable');
    const size = Buffer.byteLength(json, 'utf8');
    if (size + 2 > PAGE_BYTES) throw new Error('runtime read model row exceeds document transport size');
    if (page.length && bytes + size + 1 > PAGE_BYTES) {
      pages.push(`[${page.join(',')}]`);
      page = []; bytes = 2;
    }
    page.push(json); bytes += size + (page.length > 1 ? 1 : 0);
  }
  if (page.length) pages.push(`[${page.join(',')}]`);
  return pages;
}

export async function publishRuntimePages(db: Firestore, observedAt: number,
  fields: Record<string, readonly unknown[]>): Promise<RuntimeReadModelPages> {
  const generation = randomUUID();
  const manifest: RuntimeReadModelPages = { generation, fields: {} };
  const pages = db.collection(RUNTIME_READ_MODEL_PAGES_COLLECTION);
  for (const [field, rows] of Object.entries(fields)) {
    const chunks = partitionRuntimeRows(rows);
    manifest.fields[field] = { page_count: chunks.length, item_count: rows.length };
    for (let index = 0; index < chunks.length; index++) {
      const itemsJson = chunks[index];
      await pages.doc(`${generation}:${field}:${index}`).create({
        generation, field, index, observed_at_ms: observedAt, items_json: itemsJson,
        sha256: createHash('sha256').update(itemsJson).digest('hex'),
      });
    }
  }
  return manifest;
}

/** Reclaim derived pages only; never remove the current generation. A full day
 * of old generations remains available to readers that already loaded a root. */
export async function cleanRuntimePages(db: Firestore, observedAt: number): Promise<void> {
  const old = await db.collection(RUNTIME_READ_MODEL_PAGES_COLLECTION)
    .where('observed_at_ms', '<', observedAt - 86_400_000).limit(400).get();
  if (old.empty) return;
  await db.runTransaction(async (tx) => {
    const root = await tx.get(db.collection('pvt_runtime_read_model_v1').doc('current'));
    const generation = root.data()?.pages?.generation;
    if (typeof generation !== 'string') return;
    for (const doc of old.docs) if (doc.data().generation !== generation) tx.delete(doc.ref);
  });
}
