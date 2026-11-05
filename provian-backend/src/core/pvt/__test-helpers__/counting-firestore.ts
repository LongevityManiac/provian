/**
 * Wraps a (fake) Firestore so a test can count how many documents queries on one collection
 * returned. Used to pin that a scan reads only the rows it needs (cost tracks activity,
 * not history), with the old full-collection scan as the RED control.
 */
import type { Firestore } from 'firebase-admin/firestore';

export interface CountingFirestore {
  readonly db: Firestore;
  /** Documents returned by `get()` on queries or collections of `collectionName`. */
  readonly docsRead: () => number;
}

function wrapQuery(target: object, onDocs: (n: number) => void): object {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value !== 'function') return value;
      if (prop === 'get') {
        return async (...args: unknown[]) => {
          const snap = await (value as (...a: unknown[]) => Promise<{ size?: number; docs?: unknown[] }>).apply(obj, args);
          if (snap && Array.isArray(snap.docs)) onDocs(snap.docs.length);
          return snap;
        };
      }
      if (prop === 'doc') return (value as (...a: unknown[]) => unknown).bind(obj);
      return (...args: unknown[]) => {
        const result = (value as (...a: unknown[]) => unknown).apply(obj, args);
        return result && typeof result === 'object' && typeof (result as { get?: unknown }).get === 'function'
          ? wrapQuery(result as object, onDocs)
          : result;
      };
    },
  });
}

export function countingFirestore(db: Firestore, collectionName: string): CountingFirestore {
  let count = 0;
  const wrapped = new Proxy(db as unknown as object, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (prop === 'collection' && typeof value === 'function') {
        return (name: string, ...rest: unknown[]) => {
          const collection = (value as (...a: unknown[]) => object).apply(obj, [name, ...rest]);
          return name === collectionName ? wrapQuery(collection, (n) => { count += n; }) : collection;
        };
      }
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(obj) : value;
    },
  }) as unknown as Firestore;
  return { db: wrapped, docsRead: () => count };
}
