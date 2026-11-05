/**
 * RAIL HANDSHAKE — event-based invalidation (Part C2) + RED controls.
 *
 * Every property ships a RED negative control: a deliberately violating input the
 * guard must reject, asserted failing, so no test is a pass-over-the-empty-set.
 * - forward-only floor: raising the floor kills earlier presentations; a LATER
 * presentation survives (RED: without the floor, the earlier one would live).
 * - monotonic: a lower/older event never lowers an existing floor.
 * - config-gated: a reason OUTSIDE the enabled set is a no-op (RED: enabled, it writes).
 * - fail-safe config: a malformed window / empty event override falls back to
 * the default, never a wider window or a silently-empty set.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import {
  invalidateHandshakes,
  readInvalidationFloor,
  resolveRailHandshakeConfig,
  isInvalidationReason,
  ALL_INVALIDATION_REASONS,
  HANDSHAKE_WINDOW_MIN_MS,
  RAIL_HANDSHAKE_INVALIDATIONS_COLLECTION,
} from './invalidation';
import { RAIL_HANDSHAKE_WINDOW_MS } from './handshake';

// ── Minimal in-memory Firestore double: collection().doc().get()/.set() + runTransaction ──
type Row = Record<string, unknown>;
type Store = Map<string, Map<string, Row>>;
function coll(store: Store, name: string): Map<string, Row> {
  let c = store.get(name);
  if (!c) { c = new Map(); store.set(name, c); }
  return c;
}
function makeDoc(store: Store, collection: string, id: string) {
  return {
    id,
    async get() {
      const row = coll(store, collection).get(id);
      return { exists: row !== undefined, data: () => (row ? { ...row } : undefined) };
    },
    async set(data: Row, opts?: { merge?: boolean }) {
      const prev = opts?.merge ? coll(store, collection).get(id) ?? {} : {};
      coll(store, collection).set(id, { ...prev, ...data });
    },
  };
}
function makeDb(store: Store): Pick<Firestore, 'collection'> & {
  runTransaction: <T>(fn: (t: unknown) => Promise<T>) => Promise<T>;
} {
  const db = {
    collection: (name: string) => ({ doc: (id: string) => makeDoc(store, name, id) }),
    async runTransaction<T>(fn: (t: unknown) => Promise<T>): Promise<T> {
      const txn = {
        async get(ref: { get: () => Promise<{ exists: boolean; data: () => Row | undefined }> }) {
          return ref.get();
        },
        set(ref: { set: (d: Row, o?: { merge?: boolean }) => Promise<void> }, d: Row, o?: { merge?: boolean }) {
          void ref.set(d, o);
        },
      };
      return fn(txn);
    },
  };
  return db as unknown as Pick<Firestore, 'collection'> & {
    runTransaction: <T>(fn: (t: unknown) => Promise<T>) => Promise<T>;
  };
}

let store: Store;
beforeEach(() => { store = new Map(); });

describe('invalidation floor — write + read', () => {
  it('raises the floor and stores the reason class', async () => {
    const db = makeDb(store);
    const r = await invalidateHandshakes(db, 'aw1', 'key_rotation', 1000);
    expect(r.written).toBe(true);
    const floor = await readInvalidationFloor(db, 'aw1');
    expect(floor?.invalidatedAfterMs).toBe(1000);
    expect(floor?.reasonClass).toBe('key_rotation');
  });

  it('is MONOTONIC — a later event with a smaller nowMs never lowers the floor', async () => {
    const db = makeDb(store);
    await invalidateHandshakes(db, 'aw1', 'bond_slashed', 5000);
    await invalidateHandshakes(db, 'aw1', 'bond_expired', 3000); // older clock
    const floor = await readInvalidationFloor(db, 'aw1');
    expect(floor?.invalidatedAfterMs).toBe(5000); // floor did not drop
    // reason_class reflects the latest WRITE that was accepted; the 3000 write
    // still merged its reason but never lowered the floor — the floor is the guard.
  });

  it('a newer event moves the floor FORWARD and updates the reason', async () => {
    const db = makeDb(store);
    await invalidateHandshakes(db, 'aw1', 'bond_slashed', 5000);
    await invalidateHandshakes(db, 'aw1', 'key_rotation', 9000);
    const floor = await readInvalidationFloor(db, 'aw1');
    expect(floor?.invalidatedAfterMs).toBe(9000);
    expect(floor?.reasonClass).toBe('key_rotation');
  });

  it('reads null when no floor exists (the common case)', async () => {
    expect(await readInvalidationFloor(makeDb(store), 'nobody')).toBeNull();
  });

  it('writes to the per-presenter doc keyed by wallet id', async () => {
    const db = makeDb(store);
    await invalidateHandshakes(db, 'awX', 'reputation_downgrade', 42);
    expect(coll(store, RAIL_HANDSHAKE_INVALIDATIONS_COLLECTION).has('awX')).toBe(true);
  });
});

describe('config gate (RED controls)', () => {
  it('a reason OUTSIDE the enabled set is a no-op', async () => {
    const db = makeDb(store);
    const r = await invalidateHandshakes(db, 'aw1', 'key_rotation', 1000, {
      env: { RAIL_HANDSHAKE_INVALIDATION_EVENTS: 'bond_slashed' }, // key_rotation NOT enabled
    });
    expect(r.written).toBe(false);
    expect(r.reason).toBe('reason_disabled');
    expect(await readInvalidationFloor(db, 'aw1')).toBeNull();
  });

  it('RED control: the SAME reason WITH it enabled DOES write (guard is reachable)', async () => {
    const db = makeDb(store);
    const r = await invalidateHandshakes(db, 'aw1', 'bond_slashed', 1000, {
      env: { RAIL_HANDSHAKE_INVALIDATION_EVENTS: 'bond_slashed' },
    });
    expect(r.written).toBe(true);
    expect((await readInvalidationFloor(db, 'aw1'))?.invalidatedAfterMs).toBe(1000);
  });

  it('rejects an unknown reason and invalid args', async () => {
    const db = makeDb(store);
    // @ts-expect-error — deliberately off the closed union
    expect((await invalidateHandshakes(db, 'aw1', 'not_a_reason', 1000)).written).toBe(false);
    expect((await invalidateHandshakes(db, '', 'key_rotation', 1000)).written).toBe(false);
    expect((await invalidateHandshakes(db, 'aw1', 'key_rotation', 0)).written).toBe(false);
  });
});

describe('config resolution — fail-safe', () => {
  it('defaults to the 7-day window and ALL reasons when env is empty', () => {
    const c = resolveRailHandshakeConfig({});
    expect(c.windowMs).toBe(RAIL_HANDSHAKE_WINDOW_MS);
    for (const r of ALL_INVALIDATION_REASONS) expect(c.enabledReasons.has(r)).toBe(true);
  });

  it('honors a valid window override', () => {
    const c = resolveRailHandshakeConfig({ RAIL_HANDSHAKE_WINDOW_MS: String(HANDSHAKE_WINDOW_MIN_MS) });
    expect(c.windowMs).toBe(HANDSHAKE_WINDOW_MIN_MS);
  });

  it('RED: a below-bound / malformed / negative window falls back to the default (never wider, never smaller than MIN)', () => {
    expect(resolveRailHandshakeConfig({ RAIL_HANDSHAKE_WINDOW_MS: '1' }).windowMs).toBe(RAIL_HANDSHAKE_WINDOW_MS);
    expect(resolveRailHandshakeConfig({ RAIL_HANDSHAKE_WINDOW_MS: 'garbage' }).windowMs).toBe(RAIL_HANDSHAKE_WINDOW_MS);
    expect(resolveRailHandshakeConfig({ RAIL_HANDSHAKE_WINDOW_MS: '999999999999999' }).windowMs).toBe(RAIL_HANDSHAKE_WINDOW_MS);
  });

  it('honors an enabled-event override', () => {
    const c = resolveRailHandshakeConfig({ RAIL_HANDSHAKE_INVALIDATION_EVENTS: 'key_rotation, bond_slashed' });
    expect(c.enabledReasons.has('key_rotation')).toBe(true);
    expect(c.enabledReasons.has('bond_slashed')).toBe(true);
    expect(c.enabledReasons.has('bond_expired')).toBe(false);
  });

  it('RED: an override naming ZERO valid reasons falls back to the full default set (never silently empty)', () => {
    const c = resolveRailHandshakeConfig({ RAIL_HANDSHAKE_INVALIDATION_EVENTS: 'bogus, nonsense' });
    expect(c.enabledReasons.size).toBe(ALL_INVALIDATION_REASONS.length);
  });
});

describe('reason guard', () => {
  it('accepts every listed reason and rejects others', () => {
    for (const r of ALL_INVALIDATION_REASONS) expect(isInvalidationReason(r)).toBe(true);
    expect(isInvalidationReason('slash')).toBe(false);
    expect(isInvalidationReason(42)).toBe(false);
  });
});
