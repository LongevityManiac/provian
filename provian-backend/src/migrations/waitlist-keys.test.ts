/**
 * Idempotency tests for the waitlist key-migration script.
 * Closes Chunk I L-25 (path (a) migration tested).
 */

import { describe, it, expect } from '@jest/globals';
import { emailToDocId, migrateWaitlistKeys } from './waitlist-keys';

interface DocSnap {
  exists: boolean;
  id: string;
  ref: DocRef;
  data: () => Record<string, unknown>;
}

interface DocRef {
  __key: string;
  delete(): Promise<void>;
  get(): Promise<DocSnap>;
  set(data: Record<string, unknown>): Promise<void>;
}

class StubFirestore {
  store = new Map<string, Record<string, unknown>>();
  private lock: Promise<void> = Promise.resolve();

  collection(name: string) {
    return {
      doc: (id: string) => this.makeRef(`${name}/${id}`, id),
      limit: (n: number) => ({
        get: async () => {
          const docs: DocSnap[] = [];
          for (const [key, value] of this.store.entries()) {
            if (!key.startsWith(`${name}/`)) continue;
            const id = key.slice(name.length + 1);
            docs.push({
              exists: true,
              id,
              ref: this.makeRef(key, id),
              data: () => value,
            });
            if (docs.length >= n) break;
          }
          return { empty: docs.length === 0, docs };
        },
      }),
    };
  }

  private makeRef(fullKey: string, id: string): DocRef {
    return {
      __key: fullKey,
      delete: async () => {
        this.store.delete(fullKey);
      },
      get: async () => ({
        exists: this.store.has(fullKey),
        id,
        ref: this.makeRef(fullKey, id),
        data: () => this.store.get(fullKey) ?? {},
      }),
      set: async (data: Record<string, unknown>) => {
        this.store.set(fullKey, data);
      },
    };
  }

  async runTransaction<T>(fn: (txn: StubTxn) => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((res) => { release = res; });
    const prior = this.lock;
    this.lock = next;
    await prior;
    try {
      const txn = new StubTxn(this.store);
      const result = await fn(txn);
      txn.commit();
      return result;
    } finally {
      release();
    }
  }
}

class StubTxn {
  private writes: Array<() => void> = [];
  constructor(private store: Map<string, Record<string, unknown>>) {}

  async get(ref: DocRef): Promise<DocSnap> {
    return {
      exists: this.store.has(ref.__key),
      id: ref.__key.split('/').pop() || '',
      ref,
      data: () => this.store.get(ref.__key) ?? {},
    };
  }
  set(ref: DocRef, data: Record<string, unknown>): void {
    this.writes.push(() => this.store.set(ref.__key, data));
  }
  delete(ref: DocRef): void {
    this.writes.push(() => this.store.delete(ref.__key));
  }
  commit() {
    for (const w of this.writes) w();
  }
}

describe('migrateWaitlistKeys (Chunk I L-25, path a)', () => {
  it('re-keys legacy random-id rows to sha256(email)', async () => {
    const db = new StubFirestore();
    db.store.set('waitlist/auto_id_xyz', { email: 'alice@example.com', source: 'abundance' });
    db.store.set('waitlist/auto_id_abc', { email: 'bob@example.com', source: 'general' });
    const stats = await migrateWaitlistKeys(db as never);
    expect(stats.migrated).toBe(2);
    expect(db.store.has(`waitlist/${emailToDocId('alice@example.com')}`)).toBe(true);
    expect(db.store.has(`waitlist/${emailToDocId('bob@example.com')}`)).toBe(true);
    expect(db.store.has('waitlist/auto_id_xyz')).toBe(false);
    expect(db.store.has('waitlist/auto_id_abc')).toBe(false);
  });

  it('is idempotent: running twice yields the same store', async () => {
    const db = new StubFirestore();
    db.store.set('waitlist/auto_id_1', { email: 'alice@example.com' });
    await migrateWaitlistKeys(db as never);
    const after1 = new Map(db.store);
    const second = await migrateWaitlistKeys(db as never);
    expect(second.migrated).toBe(0);
    expect(second.skipped_already_keyed).toBeGreaterThanOrEqual(1);
    expect(db.store.size).toBe(after1.size);
    for (const key of after1.keys()) {
      expect(db.store.has(key)).toBe(true);
    }
  });

  it('drops legacy duplicate when target hash-keyed row already exists', async () => {
    const db = new StubFirestore();
    const targetKey = `waitlist/${emailToDocId('alice@example.com')}`;
    db.store.set(targetKey, { email: 'alice@example.com', source: 'abundance' });
    db.store.set('waitlist/auto_id_legacy', { email: 'alice@example.com', source: 'abundance' });
    const stats = await migrateWaitlistKeys(db as never);
    expect(stats.skipped_target_exists).toBe(1);
    expect(stats.migrated).toBe(0);
    expect(db.store.has(targetKey)).toBe(true);
    expect(db.store.has('waitlist/auto_id_legacy')).toBe(false);
  });

  it('skips rows missing an email field', async () => {
    const db = new StubFirestore();
    db.store.set('waitlist/no_email', { source: 'abundance' });
    db.store.set('waitlist/empty_email', { email: '' });
    db.store.set('waitlist/null_email', { email: null });
    const stats = await migrateWaitlistKeys(db as never);
    expect(stats.skipped_missing_email).toBe(3);
    expect(stats.migrated).toBe(0);
    // Rows are left in place - operator can decide what to do.
    expect(db.store.size).toBe(3);
  });

  it('skips rows already keyed correctly', async () => {
    const db = new StubFirestore();
    const id = emailToDocId('alice@example.com');
    db.store.set(`waitlist/${id}`, { email: 'alice@example.com' });
    const stats = await migrateWaitlistKeys(db as never);
    expect(stats.skipped_already_keyed).toBe(1);
    expect(stats.migrated).toBe(0);
  });
});
