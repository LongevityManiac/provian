import { singleScanQuery } from '../provenance/private-store';
/**
 * read EVERY document of a query, a page at a time. The hourly Standing sweeps must reach
 * every candidate: a fixed first page would leave a resolved dispute or a lapsed challenge unseen
 * for as long as earlier documents kept their place in the query.
 *
 * The cursor is the last document of the page, so the query pages in its own order (Firestore's
 * implicit order when none is given: any inequality field, then document id).
 */
import type { Query, QueryDocumentSnapshot } from 'firebase-admin/firestore';

export async function forEachDocument(
  query: Query,
  pageSize: number,
  fn: (doc: QueryDocumentSnapshot) => Promise<void>,
): Promise<void> {
  query = singleScanQuery(query);
  const size = Math.max(1, Math.floor(pageSize));
  let cursor: QueryDocumentSnapshot | null = null;
  for (;;) {
    let q = query.limit(size);
    if (cursor) q = q.startAfter(cursor);
    const page = await q.get();
    for (const doc of page.docs) await fn(doc);
    if (page.docs.length < size) return;
    cursor = page.docs[page.docs.length - 1];
  }
}
