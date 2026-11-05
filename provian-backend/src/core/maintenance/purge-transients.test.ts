import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import {
  purgeTransientCollections,
  purgeOrphanedApiKeyIndex,
  TRANSIENT_PURGE_RULES,
  MAX_DELETES_PER_COLLECTION,
  MAX_ORPHAN_DELETES_PER_RUN,
} from './purge-transients';

// Fixed reference epoch so retention boundaries are deterministic (no Date.now()).
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

type Fake = ReturnType<typeof createFakeFirestore>;
const asDb = (f: Fake) => f as unknown as Firestore;
const seed = (f: Fake, coll: string, id: string, data: Record<string, unknown>) =>
  f.store.set(`${coll}/${id}`, data);
const keysIn = (f: Fake, coll: string) =>
  [...f.store.keys()].filter((k) => k.startsWith(`${coll}/`));

describe('purgeTransientCollections', () => {
  it('deletes relay_requests older than 30 days and keeps newer ones', async () => {
    const f = createFakeFirestore();
    seed(f, 'relay_requests', 'old', { created_at: NOW - 31 * DAY });
    seed(f, 'relay_requests', 'boundary_inside', { created_at: NOW - 29 * DAY });
    seed(f, 'relay_requests', 'recent', { created_at: NOW - 1 * DAY });

    const res = await purgeTransientCollections(asDb(f), NOW);

    expect(res.deleted.relay_requests).toBe(1);
    expect(f.store.has('relay_requests/old')).toBe(false);
    expect(f.store.has('relay_requests/boundary_inside')).toBe(true);
    expect(f.store.has('relay_requests/recent')).toBe(true);
    expect(res.cutoffs.relay_requests).toBe(NOW - 30 * DAY);
  });

  it('prunes expired tokens / nonces / rate-limit windows past the 2-day grace', async () => {
    const f = createFakeFirestore();
    seed(f, 'connection_tokens', 'stale', { expires_at: NOW - 3 * DAY });
    seed(f, 'connection_tokens', 'fresh', { expires_at: NOW - 1 * DAY });
    seed(f, 'setup_tokens', 'stale', { expires_at: NOW - 3 * DAY });
    seed(f, 'consumed_nonces', 'stale', { expires_at: NOW - 3 * DAY });
    seed(f, 'rate_limits', 'stale', { window_start: NOW - 3 * DAY });
    seed(f, 'rate_limits', 'fresh', { window_start: NOW - 1 * DAY });

    const res = await purgeTransientCollections(asDb(f), NOW);

    expect(res.deleted.connection_tokens).toBe(1);
    expect(res.deleted.setup_tokens).toBe(1);
    expect(res.deleted.consumed_nonces).toBe(1);
    expect(res.deleted.rate_limits).toBe(1);
    expect(f.store.has('connection_tokens/fresh')).toBe(true);
    expect(f.store.has('rate_limits/fresh')).toBe(true);
  });

  it('never deletes docs missing the retention field (and does not loop)', async () => {
    const f = createFakeFirestore();
    seed(f, 'relay_requests', 'no_created_at', { status: 'pending' });
    seed(f, 'consumed_nonces', 'no_expiry', { consumed_at: NOW - 99 * DAY });

    const res = await purgeTransientCollections(asDb(f), NOW);

    expect(res.deleted.relay_requests).toBe(0);
    expect(res.deleted.consumed_nonces).toBe(0);
    expect(f.store.has('relay_requests/no_created_at')).toBe(true);
    expect(f.store.has('consumed_nonces/no_expiry')).toBe(true);
  });

  it('drains more than one page (pagination loop)', async () => {
    const f = createFakeFirestore();
    for (let i = 0; i < 600; i++) {
      seed(f, 'relay_requests', `r${i}`, { created_at: NOW - 40 * DAY });
    }
    const res = await purgeTransientCollections(asDb(f), NOW);

    expect(res.deleted.relay_requests).toBe(600);
    expect(keysIn(f, 'relay_requests')).toHaveLength(0);
    expect(res.capped).not.toContain('relay_requests');
  });

  it('touches only the configured collections, leaving durable data alone', async () => {
    const f = createFakeFirestore();
    seed(f, 'pe_history', 'pe1', { timestamp: NOW - 400 * DAY });
    seed(f, 'agent_wallets', 'w1', { created_at: NOW - 400 * DAY });
    seed(f, 'relay_requests', 'old', { created_at: NOW - 40 * DAY });

    await purgeTransientCollections(asDb(f), NOW);

    const configured = new Set(TRANSIENT_PURGE_RULES.map((r) => r.collection));
    expect(configured.has('pe_history')).toBe(false);
    expect(configured.has('agent_wallets')).toBe(false);
    expect(f.store.has('pe_history/pe1')).toBe(true);
    expect(f.store.has('agent_wallets/w1')).toBe(true);
    expect(f.store.has('relay_requests/old')).toBe(false);
  });

  it('reports a collection as capped when a run hits the per-run ceiling', async () => {
    const f = createFakeFirestore();
    // One over the ceiling: the run deletes exactly MAX and flags it; the
    // remainder is left for the next daily run (never silently dropped).
    for (let i = 0; i < MAX_DELETES_PER_COLLECTION + 1; i++) {
      seed(f, 'relay_requests', `r${i}`, { created_at: NOW - 40 * DAY });
    }
    const res = await purgeTransientCollections(asDb(f), NOW);

    expect(res.deleted.relay_requests).toBe(MAX_DELETES_PER_COLLECTION);
    expect(res.capped).toContain('relay_requests');
    expect(keysIn(f, 'relay_requests')).toHaveLength(1);
  });
});

describe('purgeOrphanedApiKeyIndex', () => {
  it('deletes entries with no live agent_wallets doc, keeps live entries (even if old)', async () => {
    const f = createFakeFirestore();
    seed(f, 'agent_wallets', 'wallet_live', { status: 'active' });
    // live entry, deliberately OLD created_at — must survive (kept by wallet_id, not age)
    seed(f, 'api_key_index', 'pfx_live', { wallet_id: 'wallet_live', created_at: NOW - 100 * DAY });
    seed(f, 'api_key_index', 'pfx_orphan1', { wallet_id: 'wallet_gone1', created_at: NOW - 100 * DAY });
    seed(f, 'api_key_index', 'pfx_orphan2', { wallet_id: 'wallet_gone2', created_at: NOW - 100 * DAY });

    const res = await purgeOrphanedApiKeyIndex(asDb(f), NOW);

    expect(res.aborted).toBe(false);
    expect(res.liveWallets).toBe(1);
    expect(res.deleted).toBe(2);
    expect(f.store.has('api_key_index/pfx_live')).toBe(true);
    expect(f.store.has('api_key_index/pfx_orphan1')).toBe(false);
    expect(f.store.has('api_key_index/pfx_orphan2')).toBe(false);
  });

  it('walks beyond a full kept page without rereading it, and deletes only the aged orphans', async () => {
    const f = createFakeFirestore();
    seed(f, 'agent_wallets', 'wallet_live', { status: 'active' });
    for (let i = 0; i < 500; i++) seed(f, 'api_key_index', 'a' + String(i).padStart(4, '0'), { wallet_id: 'wallet_live', created_at: NOW - 100 * DAY });
    for (let i = 0; i < 301; i++) seed(f, 'api_key_index', 'z' + String(i).padStart(4, '0'), { wallet_id: 'gone', created_at: NOW - 100 * DAY });
    const res = await purgeOrphanedApiKeyIndex(asDb(f), NOW);
    expect(res).toMatchObject({ aborted: false, scanned: 801, deleted: 301, capped: false });
    expect(keysIn(f, 'api_key_index')).toHaveLength(500);
  });

  it('keeps orphans younger than the 24h grace window', async () => {
    const f = createFakeFirestore();
    seed(f, 'agent_wallets', 'wallet_live', {});
    seed(f, 'api_key_index', 'recent_orphan', { wallet_id: 'gone', created_at: NOW - 60 * 60 * 1000 });

    const res = await purgeOrphanedApiKeyIndex(asDb(f), NOW);

    expect(res.deleted).toBe(0);
    expect(f.store.has('api_key_index/recent_orphan')).toBe(true);
  });

  it('ABORTS and deletes nothing when agent_wallets is empty (safety guard)', async () => {
    const f = createFakeFirestore();
    seed(f, 'api_key_index', 'orphan', { wallet_id: 'gone', created_at: NOW - 100 * DAY });

    const res = await purgeOrphanedApiKeyIndex(asDb(f), NOW);

    expect(res.aborted).toBe(true);
    expect(res.reason).toBe('agent_wallets empty');
    expect(res.deleted).toBe(0);
    expect(f.store.has('api_key_index/orphan')).toBe(true);
  });

  it('never deletes an entry missing wallet_id (unknown = keep)', async () => {
    const f = createFakeFirestore();
    seed(f, 'agent_wallets', 'wallet_live', {});
    seed(f, 'api_key_index', 'no_wid', { created_at: NOW - 100 * DAY });

    const res = await purgeOrphanedApiKeyIndex(asDb(f), NOW);

    expect(res.deleted).toBe(0);
    expect(f.store.has('api_key_index/no_wid')).toBe(true);
  });

  it('respects the per-run delete cap', async () => {
    const f = createFakeFirestore();
    seed(f, 'agent_wallets', 'wallet_live', {});
    for (let i = 0; i < MAX_ORPHAN_DELETES_PER_RUN + 1; i++) {
      seed(f, 'api_key_index', `o${i}`, { wallet_id: 'gone', created_at: NOW - 100 * DAY });
    }
    const res = await purgeOrphanedApiKeyIndex(asDb(f), NOW);

    expect(res.deleted).toBe(MAX_ORPHAN_DELETES_PER_RUN);
    expect(res.capped).toBe(true);
    expect(keysIn(f, 'api_key_index')).toHaveLength(1);
  });
});
