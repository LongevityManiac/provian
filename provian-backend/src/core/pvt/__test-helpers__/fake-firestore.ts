/**
 * Minimal in-memory Firestore stand-in for unit tests in the pvt/ module.
 *
 * Implements only what the recovery + minting code under test calls:
 * collection(name).doc(id).{get,set,update}, plus a no-op WriteBatch.
 *
 * Tests can read raw state via store.get(`${collection}/${id}`).
 */

import {
  compareFirestoreDocumentIds,
  compareFirestoreUtf8Strings,
} from '../../../firestore-document-id';

export { compareFirestoreDocumentIds, compareFirestoreUtf8Strings };

export interface FakeDocSnap {
  /** The document id, as real Firestore exposes on every DocumentSnapshot. */
  id: string;
  exists: boolean;
  data: () => Record<string, unknown> | undefined;
  get: (field: string) => unknown;
  /**
   * Real-Firestore parity: the version of the document this snapshot read (absent for a missing
   * document). Every write stores a new object, so the token is that object's identity; a
   * `{ lastUpdateTime }` precondition on a batched write holds only while it is still current.
   */
  updateTime?: FakeUpdateTime;
}

/** The fake's stand-in for the Timestamp a snapshot's `updateTime` carries. */
export interface FakeUpdateTime {
  readonly isEqual: (other: unknown) => boolean;
}

/** A batched write's precondition (real Firestore's `Precondition`). */
export interface FakePrecondition {
  readonly lastUpdateTime?: FakeUpdateTime;
}

export interface FakeFirestore {
  collection: (name: string) => FakeCollection;
  batch: () => FakeWriteBatch;
  /**
   * Real-Firestore parity for `settings({ ignoreUndefinedProperties })` `true`
   * accepts `undefined` (the relay's client), `false` rejects it (the SDK default,
   * i.e. a bare operator-shell client) — round 2.
   */
  settings: (settings: { ignoreUndefinedProperties?: boolean }) => void;
  runTransaction: <T>(fn: (txn: FakeTransaction) => Promise<T>) => Promise<T>;
  /** Real-Firestore parity: one snapshot per ref, in argument order. */
  getAll: (...refs: FakeDocRef[]) => Promise<FakeDocSnap[]>;
  /** Inspect raw doc state. Key format: `${collection}/${id}`. */
  store: Map<string, Record<string, unknown>>;
  /** Sequence of high-level ops, useful for ordering assertions. */
  ops: string[];
}

export interface FakeTransaction {
  // Mirrors Firestore's overloaded Transaction.get: a DocumentReference resolves
  // to a DocumentSnapshot; a Query/Collection resolves to a QuerySnapshot. Both
  // read COMMITTED state (pending writes are invisible mid-transaction).
  get: {
    (ref: FakeDocRef): Promise<FakeDocSnap>;
    (query: FakeQuery): Promise<FakeQuerySnap>;
  };
  set: (ref: FakeDocRef, data: Record<string, unknown>, opts?: { merge?: boolean }) => void;
  update: (ref: FakeDocRef, data: Record<string, unknown>) => void;
  create: (ref: FakeDocRef, data: Record<string, unknown>) => void;
  delete: (ref: FakeDocRef) => void;
}

/** Minimal query operators supported by the fake. */
export type FakeQueryOp = '==' | '!=' | '>' | '>=' | '<' | '<=' | 'in' | 'array-contains';

export interface FakeQuerySnap {
  empty: boolean;
  size: number;
  docs: Array<FakeDocSnap & { id: string; ref: FakeDocRef }>;
  forEach: (callback: (doc: FakeDocSnap & { id: string; ref: FakeDocRef }) => void) => void;
}

export interface FakeAggregateQuerySnap {
  data: () => { count: number };
}

/** The `AggregateField.sum(field)` shape a fake aggregate reads (`aggregateType`, `_field`). */
export interface FakeAggregateFieldSpec {
  readonly aggregateType?: string;
  readonly _field?: unknown;
}

export interface FakeSumAggregateQuery {
  get: () => Promise<{ data: () => Record<string, number | null> }>;
}

export interface FakeAggregateQuery {
  get: () => Promise<FakeAggregateQuerySnap>;
}

export interface FakeQuery {
  where: (field: string, op: FakeQueryOp, value: unknown) => FakeQuery;
  orderBy: (field: unknown, dir?: 'asc' | 'desc') => FakeQuery;
  limit: (n: number) => FakeQuery;
  offset: (n: number) => FakeQuery;
  /**
   * Ordered-value cursor pagination is implemented faithfully. Document-snapshot
   * cursors remain a no-op for legacy update-removes-the-match loops in this fake.
   */
  startAfter: (...values: unknown[]) => FakeQuery;
  startAt: (...values: unknown[]) => FakeQuery;
  endAt: (...values: unknown[]) => FakeQuery;
  endBefore: (...values: unknown[]) => FakeQuery;
  /**
   * Field projection, implemented FAITHFULLY: returned docs contain ONLY the
   * named fields (like real Firestore). A pass-through here would mask the
   * exact bug class the loose-mock lesson (2026-06-28) warns about — code
   * reading a field its select() never asked for gets undefined in prod but
   * a value from a permissive fake.
   */
  select: (...fields: string[]) => FakeQuery;
  count: () => FakeAggregateQuery;
  aggregate: (spec: Record<string, FakeAggregateFieldSpec>) => FakeSumAggregateQuery;
  get: () => Promise<FakeQuerySnap>;
}

export interface FakeCollection extends FakeQuery {
  doc: (id: string) => FakeDocRef;
}

export interface FakeDocRef {
  id: string;
  collectionPath: string;
  /** Real-Firestore parity: the document's full path (`collection/id`). */
  path: string;
  get: () => Promise<FakeDocSnap>;
  set: (data: Record<string, unknown>, opts?: { merge?: boolean }) => Promise<void>;
  update: (data: Record<string, unknown>) => Promise<void>;
  create: (data: Record<string, unknown>) => Promise<void>;
  delete: () => Promise<void>;
  /** Subcollection under this doc (path `${collection}/${id}/${sub}`). */
  collection: (name: string) => FakeCollection;
}

export interface FakeWriteBatch {
  set: (ref: FakeDocRef, data: Record<string, unknown>, opts?: { merge?: boolean }) => void;
  create: (ref: FakeDocRef, data: Record<string, unknown>) => void;
  /**
   * Real-Firestore parity: a `{ lastUpdateTime }` precondition fails the WHOLE batch
   * (FAILED_PRECONDITION, code 9) when the document has been written since that snapshot.
   */
  update: (ref: FakeDocRef, data: Record<string, unknown>, precondition?: FakePrecondition) => void;
  delete: (ref: FakeDocRef) => void;
  commit: () => Promise<void>;
}

export function createFakeFirestore(options?: {
  /**
   * Fault injection: when a transaction write (`txn.set`/`update`/`create`)
   * targets this collection, throw synchronously inside the callback so the
   * WHOLE transaction rolls back. Used to assert PE+entity "both land or
   * neither" — e.g. force the entity write to fail and confirm the PE doc and
   * chain-tip advance are rolled back too.
   */
  failTxnWriteTo?: string;
  /** Fail only the Nth transaction write targeting a collection. This permits
   * fault injection after an earlier atomic primary write has committed. */
  failTxnWriteOccurrence?: { collection: string; occurrence: number };
  /**
   * Contention simulation: make the FIRST `runTransaction` call run its callback
   * twice — discard the first attempt's buffered writes (as Firestore does on a
   * commit conflict), invoke `beforeRetry(store)` so the test can advance the
   * contended state (e.g. move the chain tip as a competing writer would), then
   * re-run the callback against the new committed state and commit that attempt.
   * Exercises the pure-on-retry contract of co-writes. One-shot.
   */
  retryFirstTxn?: { beforeRetry?: (store: Map<string, Record<string, unknown>>) => void };
  /** Inject one direct DocumentReference.create failure for a collection. */
  failCreateOnce?: { collection: string; error: Error & { code?: number | string } };
  /**
   * Real-Firestore parity for transaction ordering: enforce "all reads before all
   * writes" a `txn.get` after any `txn.set/update/create/delete` throws exactly
   * as production does. OFF by default (the fake was historically lax), so opt in
   * per test. Catches the class of defect where a transaction reads after writing,
   * which the lax fake silently allowed (registry-hold resolver).
   */
  strictTransactionOrder?: boolean;
  /**
   * Real-Firestore parity for a client WITHOUT `ignoreUndefinedProperties` every
   * write whose data holds `undefined` at any depth throws the SDK's own message
   * (`Cannot use "undefined" as a Firestore value (found in field "…")`), at call
   * time, before anything is written. OFF by default: the relay runs with the
   * setting on and every other suite models that. round 2: the backfill
   * CLI did not set it, and a prod run failed exactly this way.
   */
  rejectUndefinedValues?: boolean;
}): FakeFirestore {
  const store = new Map<string, Record<string, unknown>>();
  // Every write stores a NEW object under its key, so a stored object's identity is its version.
  const versionTokens = new WeakMap<Record<string, unknown>, FakeUpdateTime & { readonly version: Record<string, unknown> }>();
  function updateTimeOf(data: Record<string, unknown> | undefined): FakeUpdateTime | undefined {
    if (data === undefined) return undefined;
    let token = versionTokens.get(data);
    if (token === undefined) {
      const version = data;
      token = {
        version,
        isEqual: (other: unknown) => (other as { version?: unknown } | null)?.version === version,
      };
      versionTokens.set(data, token);
    }
    return token;
  }
  let rejectUndefined = options?.rejectUndefinedValues === true;
  function assertNoUndefined(data: unknown, path = ''): void {
    if (!rejectUndefined) return;
    if (Array.isArray(data)) {
      data.forEach((item, index) => assertNoUndefined(item, `${path}.${index}`));
      return;
    }
    if (data === null || typeof data !== 'object') return;
    const proto = Object.getPrototypeOf(data);
    if (proto !== Object.prototype && proto !== null) return; // transforms, Timestamps
    for (const [field, value] of Object.entries(data as Record<string, unknown>)) {
      const fieldPath = path === '' ? field : `${path}.${field}`;
      if (value === undefined) {
        throw new Error('Value for argument "data" is not a valid Firestore document. '
          + `Cannot use "undefined" as a Firestore value (found in field "${fieldPath}"). `
          + 'If you want to ignore undefined values, enable `ignoreUndefinedProperties`.');
      }
      assertNoUndefined(value, fieldPath);
    }
  }
  const ops: string[] = [];
  const strictTransactionOrder = options?.strictTransactionOrder === true;
  const failTxnWriteTo = options?.failTxnWriteTo;
  const failTxnWriteOccurrence = options?.failTxnWriteOccurrence;
  let matchingTxnWriteCount = 0;
  let pendingRetry = options?.retryFirstTxn;
  let pendingCreateFailure = options?.failCreateOnce;
  // Real Firestore retries conflicting transactions. Serializing commits in
  // this in-memory fake gives Promise.all concurrency tests the same observable
  // all-or-nothing result instead of letting two callbacks commit stale reads.
  let transactionTail: Promise<void> = Promise.resolve();

  function shouldFailTransactionWrite(collectionPath: string): boolean {
    if (collectionPath === failTxnWriteTo) return true;
    if (collectionPath !== failTxnWriteOccurrence?.collection) return false;
    matchingTxnWriteCount += 1;
    return matchingTxnWriteCount === failTxnWriteOccurrence.occurrence;
  }

  function applyFirestoreUpdate(
    previous: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Record<string, unknown> {
    const next = { ...previous };
    for (const [field, value] of Object.entries(update)) {
      const transform = value && typeof value === 'object'
        ? (value as { constructor?: { name?: string } }).constructor?.name
        : null;
      if (transform === 'ArrayUnionTransform') {
        const elements = (value as { elements: unknown[] }).elements;
        const current = Array.isArray(next[field]) ? [...next[field] as unknown[]] : [];
        for (const element of elements) {
          if (!current.some((candidate) => JSON.stringify(candidate) === JSON.stringify(element))) {
            current.push(element);
          }
        }
        next[field] = current;
      } else if (transform === 'ArrayRemoveTransform') {
        const elements = (value as { elements: unknown[] }).elements;
        const current = Array.isArray(next[field]) ? next[field] as unknown[] : [];
        next[field] = current.filter((candidate) =>
          !elements.some((element) => JSON.stringify(candidate) === JSON.stringify(element)));
      } else if (transform === 'NumericIncrementTransform') {
        const operand = (value as { operand: number }).operand;
        next[field] = (typeof next[field] === 'number' ? next[field] as number : 0) + operand;
      } else if (transform === 'DeleteTransform') {
        delete next[field];
      } else if (transform === 'ServerTimestampTransform') {
        next[field] = Date.now();
      } else if (field.includes('.') && !(field in previous)) {
        // Real-Firestore parity: a dotted key in `update()` is a field PATH into nested maps.
        const parts = field.split('.');
        let cursor = next;
        for (const part of parts.slice(0, -1)) {
          const child = cursor[part];
          const copy = child !== null && typeof child === 'object' && !Array.isArray(child)
            ? { ...(child as Record<string, unknown>) }
            : {};
          cursor[part] = copy;
          cursor = copy;
        }
        cursor[parts[parts.length - 1]] = value;
      } else {
        next[field] = value;
      }
    }
    return next;
  }

  // Real-Firestore parity for `set(data, { merge: true })`: nested MAPS merge field by field (a
  // map field the write does not name survives), while arrays, transforms, Timestamps and every
  // other non-plain value replace. The fake was historically shallow, which silently dropped the
  // unnamed fields of a nested map — e.g. a merge of `{ row: patch }` into an act key wiped the
  // rest of its row.
  function isPlainMap(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }
  function mergeSetData(
    previous: Record<string, unknown>,
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    const next: Record<string, unknown> = { ...previous };
    for (const [field, value] of Object.entries(data)) {
      const prior = next[field];
      // Real-Firestore parity: a `FieldValue.increment` in a `set` adds to the stored number (or
      // to 0 when the field or document is absent), exactly as in `update`.
      next[field] = isIncrement(value)
        ? (typeof prior === 'number' ? prior : 0) + value.operand
        : isPlainMap(value) && isPlainMap(prior) ? mergeSetData(prior, value) : value;
    }
    return next;
  }
  function isIncrement(value: unknown): value is { operand: number } {
    return value !== null && typeof value === 'object'
      && (value as { constructor?: { name?: string } }).constructor?.name === 'NumericIncrementTransform'
      && typeof (value as { operand?: unknown }).operand === 'number';
  }

  // A `where` field is a Firestore field PATH: `a.b.c` reads the nested map value, as Firestore does
  // (a top-level key that literally contains a dot still wins, for legacy fixtures).
  function fieldPathValue(data: Record<string, unknown>, field: string): unknown {
    if (field in data || !field.includes('.')) return data[field];
    let cur: unknown = data;
    for (const part of field.split('.')) {
      if (cur === null || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[part];
    }
    return cur;
  }

  // Minimal in-memory query: equality + comparison `where`, `orderBy`, `limit`,
  // `offset`. Filters the live store for the collection (committed state only).
  function makeQuery(name: string): FakeQuery {
    const filters: Array<{ field: string; op: FakeQueryOp; value: unknown }> = [];
    const orders: Array<{ field: unknown; dir: 'asc' | 'desc' }> = [];
    let startCursor: { values: unknown[]; inclusive: boolean } | null = null;
    let implicitIdCursor: string | null = null;
    let endCursor: { values: unknown[]; inclusive: boolean } | null = null;
    let limitN: number | null = null;
    let offsetN = 0;
    let selectedFields: string[] | null = null;
    const cmp = (a: unknown, b: unknown, op: FakeQueryOp): boolean => {
      switch (op) {
        case '==': return a === b;
        case '!=': return a !== b;
        case '>': return (a as number) > (b as number);
        case '>=': return (a as number) >= (b as number);
        case '<': return (a as number) < (b as number);
        case '<=': return (a as number) <= (b as number);
        case 'in': return Array.isArray(b) && b.includes(a);
        case 'array-contains': return Array.isArray(a) && a.includes(b);
      }
    };
    const isDocumentIdField = (field: unknown): boolean => (
      typeof field !== 'string'
      && field !== null
      && typeof (field as { toString?: unknown }).toString === 'function'
      && String(field) === '__name__'
    );
    const orderedValue = (
      row: { id: string; data: Record<string, unknown> },
      field: unknown,
    ): unknown => {
      if (isDocumentIdField(field)) return row.id;
      return typeof field === 'string' ? row.data[field] : undefined;
    };
    const compareValues = (a: unknown, b: unknown, documentId: boolean): number => {
      if (a === b) return 0;
      if (documentId && typeof a === 'string' && typeof b === 'string') {
        return compareFirestoreDocumentIds(a, b);
      }
      if (typeof a === 'string' && typeof b === 'string') {
        return compareFirestoreUtf8Strings(a, b);
      }
      return (a as string | number) > (b as string | number) ? 1 : -1;
    };
    const compareByOrders = (
      row: { id: string; data: Record<string, unknown> },
      values: unknown[],
    ): number => {
      for (let index = 0; index < orders.length; index += 1) {
        const order = orders[index];
        const comparison = compareValues(
          orderedValue(row, order.field),
          values[index],
          isDocumentIdField(order.field),
        );
        if (comparison !== 0) return order.dir === 'desc' ? -comparison : comparison;
      }
      return 0;
    };
    const cursorValuesFor = (values: unknown[]): unknown[] | null => {
      const isDocumentSnapshot = values.length === 1
        && typeof values[0] === 'object'
        && values[0] !== null
        && 'data' in values[0];
      if (isDocumentSnapshot && orders.length > 0) {
        const snapshot = values[0] as {
          id?: unknown;
          get?: (field: string) => unknown;
        };
        return orders.map((order) => {
          if (isDocumentIdField(order.field)) return snapshot.id;
          return typeof order.field === 'string' ? snapshot.get?.(order.field) : undefined;
        });
      }
      if (!isDocumentSnapshot && values.length === orders.length) return [...values];
      return null;
    };
    const q: FakeQuery = {
      where(field, op, value) {
        // Firestore parity: the real SDK rejects an undefined query value
        // SYNCHRONOUSLY at query-build time (you cannot filter on undefined —
        // use null). Reproducing it here is what makes the forum
        // getChannelPosts regression real: the old `== undefined` form throws.
        if (value === undefined) {
          throw new Error(
            `Value for argument "value" is not a valid query constraint: cannot use "undefined" (use null to query for a missing/null field) on field "${field}"`,
          );
        }
        filters.push({ field, op, value });
        return q;
      },
      orderBy(field, dir = 'asc') { orders.push({ field, dir }); return q; },
      limit(n) { limitN = n; return q; },
      offset(n) { offsetN = n; return q; },
      select(...fields) { selectedFields = fields; return q; },
      startAfter(...values) {
        // A document-snapshot cursor on a query with NO explicit order pages in Firestore's implicit
        // document-id order.
        const snap = values.length === 1 && typeof values[0] === 'object' && values[0] !== null && 'data' in values[0]
          ? values[0] as { id?: unknown }
          : null;
        if (snap !== null && orders.length === 0 && typeof snap.id === 'string') {
          implicitIdCursor = snap.id;
          return q;
        }
        const cursor = cursorValuesFor(values);
        if (cursor !== null) startCursor = { values: cursor, inclusive: false };
        return q;
      },
      startAt(...values) {
        const cursor = cursorValuesFor(values);
        if (cursor !== null) startCursor = { values: cursor, inclusive: true };
        return q;
      },
      endAt(...values) {
        const cursor = cursorValuesFor(values);
        if (cursor !== null) endCursor = { values: cursor, inclusive: true };
        return q;
      },
      endBefore(...values) {
        const cursor = cursorValuesFor(values);
        if (cursor !== null) endCursor = { values: cursor, inclusive: false };
        return q;
      },
      count(): FakeAggregateQuery {
        // Aggregate count over the SAME filters (respects an explicit limit, like
        // Firestore's count()). Reuses get() so filter/limit semantics stay in sync.
        return { async get(): Promise<FakeAggregateQuerySnap> {
          const snap = await q.get();
          return { data: () => ({ count: snap.size }) };
        } };
      },
      aggregate(spec: Record<string, FakeAggregateFieldSpec>): FakeSumAggregateQuery {
        // `sum` (and `count`) over the SAME filters, like Firestore's aggregate(): a sum over no
        // numeric value is null, a non-numeric field value is ignored.
        return { async get() {
          const snap = await q.get();
          const out: Record<string, number | null> = {};
          for (const [alias, field] of Object.entries(spec)) {
            if (field.aggregateType === 'count') {
              out[alias] = snap.size;
              continue;
            }
            if (field.aggregateType !== 'sum' || typeof field._field !== 'string') {
              throw new Error(`fake aggregate: unsupported ${String(field.aggregateType)}`);
            }
            let total: number | null = null;
            for (const doc of snap.docs) {
              const v = fieldPathValue(doc.data() as Record<string, unknown>, field._field);
              if (typeof v === 'number' && Number.isFinite(v)) total = (total ?? 0) + v;
            }
            out[alias] = total;
          }
          return { data: () => out };
        } };
      },
      async get(): Promise<FakeQuerySnap> {
        const prefix = `${name}/`;
        let rows = [...store.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([k, data]) => ({ id: k.slice(prefix.length), data }))
          .filter((row) => filters.every((f) => cmp(fieldPathValue(row.data, f.field), f.value, f.op)));
        if (orders.length > 0) {
          rows.sort((x, y) => compareByOrders(
            x,
            orders.map((order) => orderedValue(y, order.field)),
          ));
        }
        if (orders.length === 0) {
          // Firestore's implicit order: by document id.
          rows.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
          if (implicitIdCursor !== null) {
            const after = implicitIdCursor;
            rows = rows.filter((row) => row.id > after);
          }
        }
        if (startCursor !== null) {
          rows = rows.filter((row) => {
            const comparison = compareByOrders(row, startCursor!.values);
            return startCursor!.inclusive ? comparison >= 0 : comparison > 0;
          });
        }
        if (endCursor !== null) {
          rows = rows.filter((row) => {
            const comparison = compareByOrders(row, endCursor!.values);
            return endCursor!.inclusive ? comparison <= 0 : comparison < 0;
          });
        }
        if (offsetN) rows = rows.slice(offsetN);
        if (limitN !== null) rows = rows.slice(0, limitN);
        // select() projection applies to the RETURNED data only — filters and
        // ordering above ran on the full doc, like real Firestore.
        const project = (data: Record<string, unknown>): Record<string, unknown> => {
          if (selectedFields === null) return data;
          const out: Record<string, unknown> = {};
          for (const f of selectedFields) {
            const value = fieldPathValue(data, f);
            if (value === undefined) continue;
            const parts = f.split('.');
            let target = out;
            for (const part of parts.slice(0, -1)) {
              target[part] ??= {};
              target = target[part] as Record<string, unknown>;
            }
            target[parts[parts.length - 1]] = value;
          }
          return out;
        };
        const docs = rows.map((row) => ({
          id: row.id,
          exists: true,
          updateTime: updateTimeOf(row.data),
          data: () => project(row.data),
          get: (field: string) => fieldPathValue(project(row.data), field),
          ref: fs.collection(name).doc(row.id),
        }));
        return {
          empty: rows.length === 0,
          size: rows.length,
          // `ref` mirrors Firestore's QueryDocumentSnapshot.ref so callers that
          // read a doc via a query and then write/transact on it (e.g.
          // bonds.fileClaim → bondSnap.docs[0].ref) work against the fake.
          docs,
          forEach: (callback) => docs.forEach(callback),
        };
      },
    };
    return q;
  }

  const fs: FakeFirestore = {
    store,
    ops,
    collection(name: string): FakeCollection {
      return {
        ...makeQuery(name),
        doc(id: string): FakeDocRef {
          const key = `${name}/${id}`;
          const ref: FakeDocRef = {
            id,
            collectionPath: name,
            path: key,
            async get(): Promise<FakeDocSnap> {
              const data = store.get(key);
              return {
                id,
                exists: data !== undefined,
                updateTime: updateTimeOf(data),
                data: () => data,
                get: (field: string) => data?.[field],
              };
            },
            async set(data, opts) {
              assertNoUndefined(data);
              ops.push(`set:${key}`);
              if (opts?.merge && store.has(key)) {
                store.set(key, mergeSetData(store.get(key)!, data));
              } else {
                store.set(key, mergeSetData({}, data));
              }
            },
            async update(data) {
              assertNoUndefined(data);
              ops.push(`update:${key}`);
              const prev = store.get(key) ?? {};
              store.set(key, applyFirestoreUpdate(prev, data));
            },
            async create(data) {
              assertNoUndefined(data);
              if (pendingCreateFailure?.collection === name) {
                const error = pendingCreateFailure.error;
                pendingCreateFailure = undefined;
                throw error;
              }
              if (store.has(key)) {
                throw Object.assign(new Error(`Document already exists: ${key}`), { code: 6 });
              }
              ops.push(`create:${key}`);
              store.set(key, { ...data });
            },
            async delete() {
              ops.push(`delete:${key}`);
              store.delete(key);
            },
            // Subcollection: a collection whose path nests under this doc, so
            // `col('a').doc('b').collection('c').doc('d')` stores at `a/b/c/d`.
            collection(subName: string): FakeCollection {
              return fs.collection(`${name}/${id}/${subName}`);
            },
          };
          return ref;
        },
      };
    },
    async getAll(...refs: FakeDocRef[]): Promise<FakeDocSnap[]> {
      return Promise.all(refs.map((ref) => ref.get()));
    },
    async runTransaction<T>(fn: (txn: FakeTransaction) => Promise<T>): Promise<T> {
      const predecessor = transactionTail;
      let releaseTurn: (() => void) | undefined;
      transactionTail = new Promise<void>((resolve) => { releaseTurn = resolve; });
      await predecessor;
      try {
      // Real-Firestore parity: writes are BUFFERED during the callback and
      // applied atomically only if the callback resolves. A throw discards every
      // buffered write (rollback). Reads see committed state — pending writes are
      // invisible mid-transaction (Firestore has no read-your-writes). This makes
      // the WS4 "PE + entity both land or neither" atomicity assertions real.
      // One attempt: a fresh buffer + a txn that defers writes into it. Returns
      // the callback result and the buffered writes (applied only on commit).
      const runAttempt = async (): Promise<{ result: T; pending: Array<() => void> }> => {
        const pending: Array<() => void> = [];
        let wroteInTxn = false;
        const noteWrite = (): void => { wroteInTxn = true; };
        const txn: FakeTransaction = {
          get(refOrQuery: FakeDocRef | FakeQuery): Promise<FakeDocSnap> & Promise<FakeQuerySnap> {
            // Real-Firestore parity (opt-in): all reads must precede all writes.
            if (strictTransactionOrder && wroteInTxn) {
              throw new Error(
                'Firestore transactions require all reads to be executed before all writes.',
              );
            }
            // A FakeQuery/FakeCollection exposes `where`; a FakeDocRef does not.
            // Transactional reads (of either shape) see COMMITTED state only,
            // exactly like the fake's non-transactional reads.
            if (typeof (refOrQuery as FakeQuery).where === 'function'
              && typeof (refOrQuery as FakeDocRef).get === 'function'
              && (refOrQuery as FakeDocRef).collectionPath === undefined) {
              return (refOrQuery as FakeQuery).get() as Promise<FakeDocSnap> & Promise<FakeQuerySnap>;
            }
            return (refOrQuery as FakeDocRef).get() as Promise<FakeDocSnap> & Promise<FakeQuerySnap>;
          },
          set(ref: FakeDocRef, data: Record<string, unknown>, setOpts?: { merge?: boolean }) {
            assertNoUndefined(data);
            noteWrite();
            if (shouldFailTransactionWrite(ref.collectionPath)) {
              throw new Error(`Injected transaction write failure for ${ref.collectionPath}`);
            }
            const key = `${ref.collectionPath}/${ref.id}`;
            pending.push(() => {
              ops.push(`txn.set:${key}`);
              if (setOpts?.merge && store.has(key)) {
                store.set(key, mergeSetData(store.get(key)!, data));
              } else {
                store.set(key, mergeSetData({}, data));
              }
            });
          },
          update(ref: FakeDocRef, data: Record<string, unknown>) {
            assertNoUndefined(data);
            noteWrite();
            if (shouldFailTransactionWrite(ref.collectionPath)) {
              throw new Error(`Injected transaction write failure for ${ref.collectionPath}`);
            }
            const key = `${ref.collectionPath}/${ref.id}`;
            pending.push(() => {
              ops.push(`txn.update:${key}`);
              const prev = store.get(key) ?? {};
              store.set(key, applyFirestoreUpdate(prev, data));
            });
          },
          create(ref: FakeDocRef, data: Record<string, unknown>) {
            assertNoUndefined(data);
            noteWrite();
            if (shouldFailTransactionWrite(ref.collectionPath)) {
              throw new Error(`Injected transaction write failure for ${ref.collectionPath}`);
            }
            const key = `${ref.collectionPath}/${ref.id}`;
            // Eager existence check (matches Firestore create-fails-if-exists) so a
            // conflict aborts the callback and rolls the whole transaction back.
            if (store.has(key)) {
              throw Object.assign(new Error(`Document already exists: ${key}`), { code: 6 });
            }
            pending.push(() => {
              ops.push(`txn.create:${key}`);
              store.set(key, { ...data });
            });
          },
          delete(ref: FakeDocRef) {
            noteWrite();
            if (shouldFailTransactionWrite(ref.collectionPath)) {
              throw new Error(`Injected transaction write failure for ${ref.collectionPath}`);
            }
            const key = `${ref.collectionPath}/${ref.id}`;
            pending.push(() => {
              ops.push(`txn.delete:${key}`);
              store.delete(key);
            });
          },
        };
        const result = await fn(txn);
        return { result, pending };
      };

      // One-shot contention simulation: run + discard a first attempt, mutate the
      // contended state, then fall through to the committed attempt below.
      if (pendingRetry) {
        const retry = pendingRetry;
        pendingRetry = undefined; // one-shot
        await runAttempt(); // first attempt's buffered writes are DISCARDED (never applied)
        retry.beforeRetry?.(store);
      }

      const { result, pending } = await runAttempt();
      // Commit: apply buffered writes atomically now that the callback succeeded.
      for (const apply of pending) apply();
      return result;
      } finally {
        releaseTurn?.();
      }
    },
    settings(settings: { ignoreUndefinedProperties?: boolean }): void {
      // Real SDK default is `false` (reject). Tests flip it both ways to model
      // the relay's client (true) and a bare operator-shell client (false).
      if (settings.ignoreUndefinedProperties === true) rejectUndefined = false;
      else if (settings.ignoreUndefinedProperties === false) rejectUndefined = true;
    },
    batch(): FakeWriteBatch {
      const queued: Array<() => void> = [];
      // Real-Firestore parity: a batch is atomic — every precondition (an update's
      // `lastUpdateTime`, a create's absence) is checked before ANY write applies.
      const checks: Array<() => void> = [];
      return {
        set(ref, data, opts) {
          assertNoUndefined(data);
          queued.push(() => {
            ops.push(`batch.set:${ref.collectionPath}/${ref.id}`);
            const key = `${ref.collectionPath}/${ref.id}`;
            if (opts?.merge && store.has(key)) {
              store.set(key, mergeSetData(store.get(key)!, data));
            } else {
              store.set(key, mergeSetData({}, data));
            }
          });
        },
        create(ref, data) {
          assertNoUndefined(data);
          const key = `${ref.collectionPath}/${ref.id}`;
          checks.push(() => {
            if (store.has(key)) {
              throw Object.assign(new Error(`Document already exists: ${key}`), { code: 6 });
            }
          });
          queued.push(() => {
            ops.push(`batch.create:${key}`);
            store.set(key, { ...data });
          });
        },
        update(ref, data, precondition) {
          assertNoUndefined(data);
          const expected = precondition?.lastUpdateTime;
          if (expected !== undefined) {
            const key = `${ref.collectionPath}/${ref.id}`;
            checks.push(() => {
              const current = updateTimeOf(store.get(key));
              if (current === undefined || !expected.isEqual(current)) {
                throw Object.assign(new Error(`FAILED_PRECONDITION: ${key} changed since it was read`), { code: 9 });
              }
            });
          }
          queued.push(() => {
            ops.push(`batch.update:${ref.collectionPath}/${ref.id}`);
            const key = `${ref.collectionPath}/${ref.id}`;
            const prev = store.get(key) ?? {};
            store.set(key, { ...prev, ...data });
          });
        },
        delete(ref) {
          queued.push(() => {
            const key = `${ref.collectionPath}/${ref.id}`;
            ops.push(`batch.delete:${key}`);
            store.delete(key);
          });
        },
        async commit() {
          for (const check of checks) check();
          for (const fn of queued) fn();
        },
      };
    },
  };
  return fs;
}
