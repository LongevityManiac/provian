/**
 * Re-audit MED-2 regression test: the Firestore fallback rate limit at
 * /v1/wallet/agent/create must check-and-increment atomically. Two concurrent
 * requests crossing the threshold cannot both succeed.
 *
 * Tests use an in-memory Firestore stub whose runTransaction serializes
 * concurrent transactions (the production behaviour).
 */

import { describe, it, expect } from '@jest/globals';
import { firestoreFallbackRateLimit } from './agent-wallet';

interface DocSnap {
  exists: boolean;
  data(): { count: number; window_start: number } | undefined;
}

interface DocRef {
  __key: string;
}

class StubFirestore {
  store = new Map<string, { count: number; window_start: number }>();
  // Lock guarantees serial execution of runTransaction callbacks, mirroring
  // Firestore's optimistic-concurrency commit semantics where one of two
  // concurrent transactions retries.
  private lock: Promise<void> = Promise.resolve();

  collection(name: string) {
    return {
      doc: (id: string): DocRef => ({ __key: `${name}/${id}` }),
    };
  }

  async runTransaction<T>(fn: (txn: StubTransaction) => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((res) => { release = res; });
    const prior = this.lock;
    this.lock = next;
    await prior;
    try {
      const txn = new StubTransaction(this.store);
      const result = await fn(txn);
      txn.commit();
      return result;
    } finally {
      release();
    }
  }
}

class StubTransaction {
  private writes: Array<() => void> = [];
  constructor(private store: Map<string, { count: number; window_start: number }>) {}

  async get(ref: DocRef): Promise<DocSnap> {
    const data = this.store.get(ref.__key);
    return {
      exists: data !== undefined,
      data: () => data,
    };
  }

  set(ref: DocRef, data: { count: number; window_start: number }): void {
    this.writes.push(() => this.store.set(ref.__key, { ...data }));
  }

  update(ref: DocRef, data: Partial<{ count: number; window_start: number }>): void {
    this.writes.push(() => {
      const cur = this.store.get(ref.__key);
      if (!cur) return;
      this.store.set(ref.__key, { ...cur, ...data });
    });
  }

  commit() {
    for (const w of this.writes) w();
  }
}

describe('firestoreFallbackRateLimit (re-audit MED-2)', () => {
  it('first call seeds the doc and returns not-exceeded', async () => {
    const db = new StubFirestore();
    const exceeded = await firestoreFallbackRateLimit(db as any, 'key1', 5, 60_000);
    expect(exceeded).toBe(false);
    expect(db.store.get('rate_limits/key1')?.count).toBe(1);
  });

  it('returns exceeded once count crosses the limit', async () => {
    const db = new StubFirestore();
    for (let i = 0; i < 5; i++) {
      const exceeded = await firestoreFallbackRateLimit(db as any, 'key2', 5, 60_000);
      expect(exceeded).toBe(false);
    }
    const sixth = await firestoreFallbackRateLimit(db as any, 'key2', 5, 60_000);
    expect(sixth).toBe(true);
    // Count should NOT have advanced past the limit.
    expect(db.store.get('rate_limits/key2')?.count).toBe(5);
  });

  it('expired window resets the counter', async () => {
    const db = new StubFirestore();
    db.store.set('rate_limits/key3', { count: 99, window_start: Date.now() - 7_200_000 });
    const exceeded = await firestoreFallbackRateLimit(db as any, 'key3', 100, 3_600_000);
    expect(exceeded).toBe(false);
    expect(db.store.get('rate_limits/key3')?.count).toBe(1);
  });

  it('concurrent calls at the threshold cannot both succeed (atomicity)', async () => {
    const db = new StubFirestore();
    db.store.set('rate_limits/key4', { count: 4, window_start: Date.now() });
    const limit = 5;
    // Fire two calls in parallel. With non-atomic get-then-update both could
    // see count=4, both increment to 5, neither return exceeded. The
    // transaction wrapper serializes them so one succeeds (count -> 5) and
    // the next observes count=5 and returns exceeded.
    const [a, b] = await Promise.all([
      firestoreFallbackRateLimit(db as any, 'key4', limit, 60_000),
      firestoreFallbackRateLimit(db as any, 'key4', limit, 60_000),
    ]);
    const exceededCount = [a, b].filter(Boolean).length;
    expect(exceededCount).toBe(1);
    expect(db.store.get('rate_limits/key4')?.count).toBe(5);
  });

  it('many concurrent callers above the threshold all get rejected after the limit fills', async () => {
    const db = new StubFirestore();
    const limit = 10;
    const N = 25;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        firestoreFallbackRateLimit(db as any, 'key5', limit, 60_000),
      ),
    );
    const allowed = results.filter((r) => r === false).length;
    const denied = results.filter((r) => r === true).length;
    expect(allowed).toBe(limit);
    expect(denied).toBe(N - limit);
    expect(db.store.get('rate_limits/key5')?.count).toBe(limit);
  });
});
