import { describe, expect, test } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import {
  WATCHER_ENUMERATION_HEALTH_COLLECTION,
  WATCHER_ENUMERATION_HEALTH_MAX_ITEMS,
  WatcherEnumerationExclusionLog,
  countExclusions,
  persistWatcherEnumerationHealth,
  type WatcherEnumerationExclusion,
} from './watcher-enumeration-health';

const reason = (klass: string, id: string) =>
  new Error(`watched_address_enumeration_invalid:${klass}:${id}`);

describe('watcher enumeration exclusion classification ', () => {
  test('a wallet-missing reason is an orphaned index row; an authority fault is invalid', async () => {
    const fake = createFakeFirestore();
    const log = new WatcherEnumerationExclusionLog();
    log.record(reason('agent_wallet_missing', 'gone'));
    log.record(reason('native_wallet_missing', 'gone-out'));
    log.record(reason('agent_registration_index', 'atlas'));
    const out = await log.classify(fake as unknown as Firestore);
    expect(out).toEqual([
      { wallet_id: 'gone', reason: expect.stringContaining('agent_wallet_missing'), kind: 'orphaned_index_row' },
      { wallet_id: 'gone-out', reason: expect.stringContaining('native_wallet_missing'), kind: 'orphaned_index_row' },
      { wallet_id: 'atlas', reason: expect.stringContaining('agent_registration_index'), kind: 'invalid_authority' },
    ]);
    expect(countExclusions(out)).toEqual({ excluded_wallets: 1, orphaned_index_rows: 2 });
  });

  test('a back-check reason is orphaned only when no wallet document of either class exists', async () => {
    const fake = createFakeFirestore();
    fake.store.set('agent_wallets/alive', { id: 'alive' });
    const log = new WatcherEnumerationExclusionLog();
    log.record(reason('agent_address_index_missing', 'alive'));
    log.record(reason('agent_address_index_missing', 'deleted'));
    const out = await log.classify(fake as unknown as Firestore);
    expect(out.map((item) => [item.wallet_id, item.kind])).toEqual([
      ['alive', 'invalid_authority'],
      ['deleted', 'orphaned_index_row'],
    ]);
  });

  test('duplicate reasons collapse to one exclusion', async () => {
    const log = new WatcherEnumerationExclusionLog();
    log.record(reason('agent_birth_authority', 'w'));
    log.record(reason('agent_birth_authority', 'w'));
    expect(await log.classify(createFakeFirestore() as unknown as Firestore)).toHaveLength(1);
  });
});

describe('persistWatcherEnumerationHealth ', () => {
  test('keeps exact counts, caps items, and orders paging items ahead of orphaned rows', async () => {
    const fake = createFakeFirestore();
    const exclusions: WatcherEnumerationExclusion[] = [];
    for (let i = 0; i < WATCHER_ENUMERATION_HEALTH_MAX_ITEMS + 5; i += 1) {
      exclusions.push({ wallet_id: `o${i}`, reason: `orphan-${i}`, kind: 'orphaned_index_row' });
    }
    exclusions.push({ wallet_id: 'atlas', reason: 'invalid', kind: 'invalid_authority' });
    const doc = await persistWatcherEnumerationHealth(fake as unknown as Firestore, 'inbound_usdc', {
      watchedCount: 4,
      exclusions,
      now: 100,
    });
    expect(doc.excluded_wallets).toBe(1);
    expect(doc.orphaned_index_rows).toBe(WATCHER_ENUMERATION_HEALTH_MAX_ITEMS + 5);
    expect(doc.exclusions).toHaveLength(WATCHER_ENUMERATION_HEALTH_MAX_ITEMS);
    expect(doc.exclusions[0]).toMatchObject({ wallet_id: 'atlas', kind: 'invalid_authority' });
    expect(fake.store.get(`${WATCHER_ENUMERATION_HEALTH_COLLECTION}/inbound_usdc`)).toMatchObject({
      watched_count: 4,
      checked_at_ms: 100,
    });
  });

  test('first_seen carries forward only for the same wallet and reason', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await persistWatcherEnumerationHealth(db, 'outbound_usdc', {
      watchedCount: 1,
      exclusions: [{ wallet_id: 'w', reason: 'a', kind: 'invalid_authority' }],
      now: 10,
    });
    const second = await persistWatcherEnumerationHealth(db, 'outbound_usdc', {
      watchedCount: 1,
      exclusions: [
        { wallet_id: 'w', reason: 'a', kind: 'invalid_authority' },
        { wallet_id: 'w', reason: 'b', kind: 'invalid_authority' },
      ],
      now: 50,
    });
    expect(second.exclusions.map((item) => [item.reason, item.first_seen_at_ms])).toEqual([
      ['a', 10],
      ['b', 50],
    ]);
  });
});
