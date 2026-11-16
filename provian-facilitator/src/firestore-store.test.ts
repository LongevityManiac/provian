/**
 * The production store replaces a seller document on re-registration (`tx.set` without merge), so
 * every field the facilitator does not own must be carried across explicitly. The operator's
 * display marker (`public_visibility`) is one: losing it would put a hidden seller back on the
 * relay's public list the next time it re-registers.
 */
import { describe, expect, it } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { FirestoreStore, SELLERS_COLLECTION } from './firestore-store.js';
import type { SellerRecord } from './store.js';

type Doc = Record<string, unknown>;

function fakeDb(docs: Map<string, Doc>): Firestore {
  const ref = (path: string) => ({ path });
  const db = {
    collection: (name: string) => ({ doc: (id: string) => ref(`${name}/${id}`) }),
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({
      get: async (r: { path: string }) => ({ exists: docs.has(r.path), data: () => docs.get(r.path) }),
      set: (r: { path: string }, data: Doc) => { docs.set(r.path, data); },
    }),
  };
  return db as unknown as Firestore;
}

const record = (over: Partial<SellerRecord> = {}): SellerRecord => ({
  seller_id: 'base:0x1111111111111111111111111111111111111111',
  chain: 'base',
  network: 'eip155:8453',
  address: '0x1111111111111111111111111111111111111111',
  display_name: 'Seller',
  description: '',
  resource_urls: [],
  require_presentation: null,
  pvt_prices: [],
  status: 'active',
  registered_at_ms: 1,
  updated_at_ms: 1,
  ...over,
});

describe('FirestoreStore.upsertSeller', () => {
  it('keeps public_visibility across a re-registration', async () => {
    const docs = new Map<string, Doc>();
    const path = `${SELLERS_COLLECTION}/${record().seller_id}`;
    docs.set(path, { ...record(), public_visibility: 'hidden_prelaunch_test', settlement_count: 3 });
    const next = await new FirestoreStore(fakeDb(docs)).upsertSeller(record({ display_name: 'Renamed', registered_at_ms: 9, updated_at_ms: 9 }));
    expect(next.display_name).toBe('Renamed');
    expect(docs.get(path)).toMatchObject({ public_visibility: 'hidden_prelaunch_test', settlement_count: 3, registered_at_ms: 1 });
  });

  it('a seller without the marker gets none', async () => {
    const docs = new Map<string, Doc>();
    const path = `${SELLERS_COLLECTION}/${record().seller_id}`;
    docs.set(path, { ...record() });
    await new FirestoreStore(fakeDb(docs)).upsertSeller(record({ updated_at_ms: 2 }));
    expect(docs.get(path)).not.toHaveProperty('public_visibility');
  });
});
