import type { Query, QueryDocumentSnapshot, QuerySnapshot } from 'firebase-admin/firestore';

/** Internal adapter hook: a fixed-snapshot physical scan when the caller restores logical order. */
export const PRIVATE_QUERY_SCAN = Symbol('provian-private-query-scan');
export const PRIVATE_QUERY_PAGER = Symbol('provian-private-query-pager');
export const PRIVATE_QUERY_COMPARE = Symbol('provian-private-query-compare');
type ScanQuery = Query & {
  [PRIVATE_QUERY_SCAN]?: (visit: (doc: QueryDocumentSnapshot) => Promise<void>) => Promise<void>;
  [PRIVATE_QUERY_COMPARE]?: (a: QueryDocumentSnapshot, b: QueryDocumentSnapshot) => number;
  [PRIVATE_QUERY_PAGER]?: () => Promise<(query: Query) => Promise<QuerySnapshot>>;
};

/** One private candidate scan, rather than one full scan for every logical page. */
export async function* queryPages(query: Query, pageSize: number): AsyncGenerator<readonly QueryDocumentSnapshot[]> {
  const size = Math.max(1, Math.floor(pageSize));
  const readPage = createQueryPager();
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    const page = await readPage((cursor ? query.startAfter(cursor) : query).limit(size));
    yield page.docs;
    if (page.docs.length < size) return;
    cursor = page.docs[page.docs.length - 1];
  }
}

/** Caller must restore any observable ordering before it writes or produces output. */
export async function scanQueryUnordered(
  query: Query,
  pageSize: number,
  visit: (doc: QueryDocumentSnapshot) => Promise<void>,
): Promise<void> {
  const scan = (query as ScanQuery)[PRIVATE_QUERY_SCAN];
  if (scan) return scan(visit);
  for await (const page of queryPages(query, pageSize)) for (const doc of page) await visit(doc);
}

/** Operation-scoped reader for existing logical cursor loops. Retains one logical snapshot. Native queries keep their normal per-page get; separate loops need separate readers. */
export function createQueryPager(): <T>(query: {get(): Promise<T>}) => Promise<T> {
  let prepared: Promise<(query: Query) => Promise<QuerySnapshot>> | undefined;
  return async <T>(query: {get(): Promise<T>}): Promise<T> => {
    const prepare = (query as unknown as ScanQuery)[PRIVATE_QUERY_PAGER];
    if (!prepare) return query.get();
    prepared ??= prepare();
    return await (await prepared)(query as unknown as Query) as unknown as T;
  };
}

/** Native scans already visit in query order; private physical scans restore the same order. */
export function compareQueryDocuments(query: Query): (a: QueryDocumentSnapshot, b: QueryDocumentSnapshot) => number {
  return (query as ScanQuery)[PRIVATE_QUERY_COMPARE] ?? (() => 0);
}
