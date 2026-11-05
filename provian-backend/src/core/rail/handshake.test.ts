/**
 * RAIL HANDSHAKE — the on-rail commitment gate + RED controls.
 *
 * Security properties, each with a permanent RED control a mutation reddens, and
 * each paired with a non-vacuous reachability proof (a live handshake DOES pass,
 * so no refusal is a pass-over-the-empty-population):
 * - missing-handshake-blocks-commit: no presentation → 428.
 * - expired-window: a presentation older than the finite window → 428.
 * - wrong-relationship: a live presentation to a DIFFERENT counterparty → 428.
 * - wrong-committer: a live presentation by a DIFFERENT wallet → 428.
 * REACHABILITY: a live in-window presentation to the exact counterparty passes,
 * and the freshest live one wins when several exist.
 */
import { describe, it, expect } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import {
  assertLiveHandshake,
  findLiveHandshake,
  readHandshakeState,
  RailHandshakeError,
  RAIL_COMMONS_AUDIENCE,
  RAIL_HANDSHAKE_WINDOW_MS,
} from './handshake';
import { RAIL_HANDSHAKE_INVALIDATIONS_COLLECTION } from './invalidation';
import { COMMONS_PRESENTATIONS_COLLECTION } from '../presentation/service';

type Row = Record<string, unknown>;
type Store = Map<string, Map<string, Row>>;
function coll(store: Store, name: string): Map<string, Row> {
  let c = store.get(name);
  if (!c) { c = new Map(); store.set(name, c); }
  return c;
}
class FakeQuery {
  constructor(private store: Store, private collection: string, private constraints: [string, unknown][] = []) {}
  where(field: string, _op: string, value: unknown): FakeQuery {
    return new FakeQuery(this.store, this.collection, [...this.constraints, [field, value]]);
  }
  async get(): Promise<{ docs: { id: string; data: () => Row }[] }> {
    let rows = [...coll(this.store, this.collection).entries()];
    for (const [f, v] of this.constraints) rows = rows.filter(([, d]) => d[f] === v);
    return { docs: rows.map(([id, d]) => ({ id, data: () => ({ ...d }) })) };
  }
}
class FakeCollection {
  constructor(private store: Store, private name: string) {}
  where(field: string, op: string, value: unknown): FakeQuery {
    return new FakeQuery(this.store, this.name).where(field, op, value);
  }
  doc(id: string) {
    const store = this.store;
    const name = this.name;
    return {
      id,
      async get() {
        const row = coll(store, name).get(id);
        return { exists: row !== undefined, data: () => (row ? { ...row } : undefined) };
      },
    };
  }
}
function makeDb(store: Store): Pick<Firestore, 'collection'> {
  return { collection: (name: string) => new FakeCollection(store, name) } as unknown as Pick<Firestore, 'collection'>;
}

const NOW = 1_800_000_000_000; // fixed clock; no Date.now() reliance
/** Seed a `commons_presentations` record (what producing a presentation writes). */
function seedPresentation(
  store: Store,
  over: { walletId: string; audience: string; recordedAt: number; burnId?: string; pid?: string },
): void {
  const burnId = over.burnId ?? `burn_${over.walletId}_${over.audience}_${over.recordedAt}`;
  coll(store, COMMONS_PRESENTATIONS_COLLECTION).set(burnId, {
    presentation_id: over.pid ?? `pres_${burnId}`,
    tier: 'reputation',
    wallet_id: over.walletId,
    presenter_kind: 'agent',
    presenter_address: '0xabc',
    audience: over.audience,
    burn_id: burnId,
    recorded_at: over.recordedAt,
  });
}

let store: Store;
beforeEach(() => { store = new Map(); });

describe('rail handshake — reachability (non-vacuous)', () => {
  it('a live in-window presentation to the exact counterparty PASSES', async () => {
    seedPresentation(store, { walletId: 'aw1', audience: 'aw2', recordedAt: NOW - 1000 });
    const hs = await assertLiveHandshake(makeDb(store), 'aw1', 'aw2', NOW);
    expect(hs.committerWalletId).toBe('aw1');
    expect(hs.counterparty).toBe('aw2');
    expect(hs.expiresAt).toBe(NOW - 1000 + RAIL_HANDSHAKE_WINDOW_MS);
  });

  it('a commons handshake covers a commons-facing commitment', async () => {
    seedPresentation(store, { walletId: 'aw1', audience: RAIL_COMMONS_AUDIENCE, recordedAt: NOW - 1000 });
    const hs = await assertLiveHandshake(makeDb(store), 'aw1', RAIL_COMMONS_AUDIENCE, NOW);
    expect(hs.counterparty).toBe(RAIL_COMMONS_AUDIENCE);
  });

  it('the FRESHEST live presentation wins when several exist', async () => {
    seedPresentation(store, { walletId: 'aw1', audience: 'aw2', recordedAt: NOW - 5000, pid: 'old' });
    seedPresentation(store, { walletId: 'aw1', audience: 'aw2', recordedAt: NOW - 1000, pid: 'new' });
    const hs = await findLiveHandshake(makeDb(store), 'aw1', 'aw2', NOW);
    expect(hs?.presentationId).toBe('new');
  });
});

describe('rail handshake — RED controls', () => {
  it('RED missing-handshake: no presentation → 428 (and a fresh one then passes)', async () => {
    // Empty population: nothing seeded. The gate MUST refuse, not pass vacuously.
    await expect(assertLiveHandshake(makeDb(store), 'aw1', 'aw2', NOW)).rejects.toMatchObject({
      status: 428, reason: 'rail_handshake_required',
    });
    // non-vacuous: seeding a live presentation flips it to a pass
    seedPresentation(store, { walletId: 'aw1', audience: 'aw2', recordedAt: NOW - 1000 });
    await expect(assertLiveHandshake(makeDb(store), 'aw1', 'aw2', NOW)).resolves.toBeDefined();
  });

  it('RED expired-window: a presentation older than the finite window → 428', async () => {
    // recorded exactly one window + 1ms ago → lapsed.
    seedPresentation(store, { walletId: 'aw1', audience: 'aw2', recordedAt: NOW - RAIL_HANDSHAKE_WINDOW_MS - 1 });
    expect(await findLiveHandshake(makeDb(store), 'aw1', 'aw2', NOW)).toBeNull();
    await expect(assertLiveHandshake(makeDb(store), 'aw1', 'aw2', NOW)).rejects.toBeInstanceOf(RailHandshakeError);
    // non-vacuous: a presentation just INSIDE the window is live
    seedPresentation(store, { walletId: 'aw1', audience: 'aw2', recordedAt: NOW - RAIL_HANDSHAKE_WINDOW_MS + 1000, burnId: 'fresh' });
    expect(await findLiveHandshake(makeDb(store), 'aw1', 'aw2', NOW)).not.toBeNull();
  });

  it('RED wrong-relationship: a live presentation to a DIFFERENT counterparty → 428', async () => {
    seedPresentation(store, { walletId: 'aw1', audience: 'awX', recordedAt: NOW - 1000 });
    // handshake exists for (aw1 → awX) but the commitment is against aw2
    await expect(assertLiveHandshake(makeDb(store), 'aw1', 'aw2', NOW)).rejects.toMatchObject({ status: 428 });
    // non-vacuous: against the actual counterparty it passes
    await expect(assertLiveHandshake(makeDb(store), 'aw1', 'awX', NOW)).resolves.toBeDefined();
  });

  it('RED wrong-committer: a live presentation by a DIFFERENT wallet → 428', async () => {
    seedPresentation(store, { walletId: 'awOther', audience: 'aw2', recordedAt: NOW - 1000 });
    // awOther presented to aw2, but aw1 is committing — aw1 has no handshake
    await expect(assertLiveHandshake(makeDb(store), 'aw1', 'aw2', NOW)).rejects.toMatchObject({ status: 428 });
    // non-vacuous: awOther (who DID present) passes against aw2
    await expect(assertLiveHandshake(makeDb(store), 'awOther', 'aw2', NOW)).resolves.toBeDefined();
  });
});

// Seed a per-presenter invalidation floor (what an adverse event writes).
function seedFloor(store: Store, walletId: string, floorMs: number, reason: string): void {
  coll(store, RAIL_HANDSHAKE_INVALIDATIONS_COLLECTION).set(walletId, {
    wallet_id: walletId,
    invalidated_after_ms: floorMs,
    reason_class: reason,
    updated_at: floorMs,
  });
}

describe('rail handshake — event-based invalidation (Part C2)', () => {
  it('a presentation recorded BEFORE the invalidation floor is DEAD; a fresh one AFTER is live', async () => {
    // Live-by-time presentation at NOW-1000, but the presenter tripped an event at NOW-500.
    seedPresentation(store, { walletId: 'aw1', audience: 'aw2', recordedAt: NOW - 1000 });
    seedFloor(store, 'aw1', NOW - 500, 'key_rotation');
    expect(await findLiveHandshake(makeDb(store), 'aw1', 'aw2', NOW)).toBeNull();
    await expect(assertLiveHandshake(makeDb(store), 'aw1', 'aw2', NOW)).rejects.toMatchObject({ status: 428 });
    // RED control: re-present AFTER the event → live again (floor is forward-only).
    seedPresentation(store, { walletId: 'aw1', audience: 'aw2', recordedAt: NOW - 100, burnId: 'fresh' });
    expect(await findLiveHandshake(makeDb(store), 'aw1', 'aw2', NOW)).not.toBeNull();
  });

  it('the floor is presenter-wide — it kills a commons handshake too', async () => {
    seedPresentation(store, { walletId: 'aw1', audience: RAIL_COMMONS_AUDIENCE, recordedAt: NOW - 1000 });
    seedFloor(store, 'aw1', NOW - 200, 'bond_slashed');
    expect(await findLiveHandshake(makeDb(store), 'aw1', RAIL_COMMONS_AUDIENCE, NOW)).toBeNull();
  });

  it('a floor on a DIFFERENT presenter does not touch this pair (presenter-side only)', async () => {
    seedPresentation(store, { walletId: 'aw1', audience: 'aw2', recordedAt: NOW - 1000 });
    seedFloor(store, 'awOther', NOW, 'bond_slashed');
    expect(await findLiveHandshake(makeDb(store), 'aw1', 'aw2', NOW)).not.toBeNull();
  });
});

describe('rail handshake — HANDSHAKE STATE READ', () => {
  it('reports live / lapsed / invalidated / none with the reason class', async () => {
    // none
    expect((await readHandshakeState(makeDb(store), 'aw1', 'aw2', NOW)).state).toBe('none');
    // live
    seedPresentation(store, { walletId: 'aw1', audience: 'aw2', recordedAt: NOW - 1000 });
    const live = await readHandshakeState(makeDb(store), 'aw1', 'aw2', NOW);
    expect(live.state).toBe('live');
    expect(live.expiresAt).toBe(NOW - 1000 + RAIL_HANDSHAKE_WINDOW_MS);
    // invalidated (with reason readable by both parties)
    seedFloor(store, 'aw1', NOW - 500, 'bond_slashed');
    const inv = await readHandshakeState(makeDb(store), 'aw1', 'aw2', NOW);
    expect(inv.state).toBe('invalidated');
    expect(inv.reasonClass).toBe('bond_slashed');
    // lapsed (old presentation, no floor)
    const store2: Store = new Map();
    seedPresentation(store2, { walletId: 'aw1', audience: 'aw2', recordedAt: NOW - RAIL_HANDSHAKE_WINDOW_MS - 1000 });
    expect((await readHandshakeState(makeDb(store2), 'aw1', 'aw2', NOW)).state).toBe('lapsed');
  });
});
