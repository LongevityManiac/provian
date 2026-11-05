/**
 * COMMONS presentation surfacing (Part D) — the two aggregates + RED controls.
 *
 * Non-vacuous: each count is asserted over a POPULATED collection (a pass over an
 * empty collection would be meaningless). RED controls: a wallet with zero
 * presentations reads 0; the recent window EXCLUDES an old presentation the
 * lifetime count includes (so the window actually filters).
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import {
  getPresentationActivity,
  getNetworkPresentationVolume,
  PRESENTATION_ACTIVITY_RECENT_WINDOW_MS,
} from './presentation-activity';
import { COMMONS_PRESENTATIONS_COLLECTION } from '../presentation/service';

type Row = Record<string, unknown>;
type Store = Map<string, Map<string, Row>>;
function coll(store: Store, name: string): Map<string, Row> {
  let c = store.get(name);
  if (!c) { c = new Map(); store.set(name, c); }
  return c;
}
// A query supporting where() chains + count().get() over the in-memory store.
class FakeQuery {
  constructor(private store: Store, private collection: string, private cons: [string, string, unknown][] = []) {}
  where(field: string, op: string, value: unknown): FakeQuery {
    return new FakeQuery(this.store, this.collection, [...this.cons, [field, op, value]]);
  }
  count() {
    const rows = [...coll(this.store, this.collection).values()].filter((d) =>
      this.cons.every(([f, op, v]) => {
        if (op === '==') return d[f] === v;
        if (op === '>=') return typeof d[f] === 'number' && (d[f] as number) >= (v as number);
        return false;
      }),
    );
    return { get: async () => ({ data: () => ({ count: rows.length }) }) };
  }
}
function makeDb(store: Store): Pick<Firestore, 'collection'> {
  return {
    collection: (name: string) => new FakeQuery(store, name) as unknown as ReturnType<Firestore['collection']>,
  } as unknown as Pick<Firestore, 'collection'>;
}
const NOW = 1_800_000_000_000;
function seed(store: Store, walletId: string, recordedAt: number, id = `${walletId}_${recordedAt}`): void {
  coll(store, COMMONS_PRESENTATIONS_COLLECTION).set(id, { wallet_id: walletId, recorded_at: recordedAt });
}

let store: Store;
beforeEach(() => { store = new Map(); });

describe('profile presentation activity', () => {
  it('counts lifetime + recent for a wallet (non-vacuous: populated)', async () => {
    seed(store, 'aw1', NOW - 1000);
    seed(store, 'aw1', NOW - 2000);
    seed(store, 'aw1', NOW - PRESENTATION_ACTIVITY_RECENT_WINDOW_MS - 5000); // outside recent
    seed(store, 'aw2', NOW - 1000); // different wallet
    const act = await getPresentationActivity(makeDb(store), 'aw1', NOW);
    expect(act.lifetime).toBe(3);
    expect(act.recent).toBe(2); // the old one is excluded
    expect(act.recent_window_days).toBe(30);
  });

  it('RED: a wallet with no presentations reads 0/0', async () => {
    seed(store, 'aw2', NOW - 1000);
    const act = await getPresentationActivity(makeDb(store), 'aw1', NOW);
    expect(act.lifetime).toBe(0);
    expect(act.recent).toBe(0);
  });

  it('RED: the recent window actually filters (old presentation counts lifetime, not recent)', async () => {
    seed(store, 'aw1', NOW - PRESENTATION_ACTIVITY_RECENT_WINDOW_MS - 1);
    const act = await getPresentationActivity(makeDb(store), 'aw1', NOW);
    expect(act.lifetime).toBe(1);
    expect(act.recent).toBe(0);
  });
});

describe('ecosystem presentation volume', () => {
  it('counts the whole collection (non-vacuous: populated)', async () => {
    seed(store, 'aw1', NOW - 1000);
    seed(store, 'aw2', NOW - 1000);
    seed(store, 'aw3', NOW - 1000);
    expect((await getNetworkPresentationVolume(makeDb(store))).total).toBe(3);
  });

  it('RED: an empty network reads 0', async () => {
    expect((await getNetworkPresentationVolume(makeDb(store))).total).toBe(0);
  });
});
