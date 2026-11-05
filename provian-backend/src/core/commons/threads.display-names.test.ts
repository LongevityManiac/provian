/**
 * thread reads carry the parties' PUBLISHED Commons names (`display_names`), read-time only.
 *
 * The rule is the forum's `withAuthorNames` rule: each party's `commons_profiles.display_name`, blank
 * → null, nothing else projected, never written back. An agent party id is its wallet id (the profile
 * doc id); a human party id is the user id — the profile doc id every Commons write uses — with the
 * human's first-party `wallets/{doc}` id as the fallback key. A lookup failure is null, never an error.
 *
 * RED controls: a profile's other fields (bio, pe_count) never ride along; the stored thread document
 * never gains `display_names`; a profile read that throws yields null and the read still succeeds; a
 * third wallet's profile never appears in a thread it is not a party to.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { getThreadView, listThreads, unreadThreadsFor, withThreadDisplayNames, type ThreadDocument } from './threads';
import { COMMONS_COLLECTIONS } from './types';
import type { AgentBankDeps } from '../agent-bank/types';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';

const AGENT = 'wallet_aw_atlas';
const HUMAN = 'user_frank';
const HUMAN2 = 'user_wallet_keyed';
const BLANK = 'wallet_aw_blank';
const STRANGER = 'wallet_aw_stranger';

function deps(db: Pick<FakeFirestore, 'collection'>): AgentBankDeps {
  return { db, cache: { checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }) } } as unknown as AgentBankDeps;
}

function thread(id: string, a: string, b: string, lastAt: number): ThreadDocument {
  const [party_a, party_b] = [a, b].sort();
  const kind = (x: string) => (x.startsWith('wallet_aw_') ? 'agent' : 'human') as 'agent' | 'human';
  return {
    thread_id: id, anchor_kind: 'escrow', anchor_id: `esc_${id}`, party_a, party_b,
    parties: { [a]: { kind: kind(a), id: a }, [b]: { kind: kind(b), id: b } },
    opened_by: a, backing: { kind: 'anchor' }, created_at: 1, last_message_at: lastAt, message_count: 1,
    read_cursors: { [a]: lastAt },
  };
}

let db: FakeFirestore;
beforeEach(() => {
  db = createFakeFirestore();
  db.store.set(`${COMMONS_COLLECTIONS.PROFILES}/${AGENT}`, { display_name: 'Atlas', bio: 'secret bio', pe_count: 9000 });
  db.store.set(`${COMMONS_COLLECTIONS.PROFILES}/${HUMAN}`, { display_name: 'the operator' });
  db.store.set(`${COMMONS_COLLECTIONS.PROFILES}/${BLANK}`, { display_name: '   ' });
  db.store.set(`${COMMONS_COLLECTIONS.PROFILES}/${STRANGER}`, { display_name: 'Stranger' });
  // A human whose profile is keyed by the first-party wallet doc id.
  db.store.set('wallets/wdoc_2', { user_id: HUMAN2, type: 'human', address: `0x${'2'.repeat(40)}` });
  db.store.set(`${COMMONS_COLLECTIONS.PROFILES}/wdoc_2`, { display_name: 'Wallet-Keyed Human' });
  db.store.set(`${COMMONS_COLLECTIONS.THREADS}/t1`, thread('t1', AGENT, HUMAN, 30) as unknown as Record<string, unknown>);
  db.store.set(`${COMMONS_COLLECTIONS.THREADS}/t2`, thread('t2', AGENT, BLANK, 20) as unknown as Record<string, unknown>);
  db.store.set(`${COMMONS_COLLECTIONS.THREADS}/t3`, thread('t3', HUMAN2, AGENT, 10) as unknown as Record<string, unknown>);
});

describe('thread display_names (read-time, published names only)', () => {
  it('listThreads attaches each party\'s published name; blank → null; the human fallback resolves', async () => {
    const threads = await listThreads(deps(db), AGENT);
    expect(threads.map((t) => t.thread_id)).toEqual(['t1', 't2', 't3']);
    expect(threads[0].display_names).toEqual({ [AGENT]: 'Atlas', [HUMAN]: 'the operator' });
    expect(threads[1].display_names).toEqual({ [AGENT]: 'Atlas', [BLANK]: null });
    expect(threads[2].display_names).toEqual({ [AGENT]: 'Atlas', [HUMAN2]: 'Wallet-Keyed Human' });
    // The unread flag still rides along.
    expect(threads.every((t) => typeof t.unread === 'boolean')).toBe(true);
  });

  it('RED: nothing but the name is projected, and the stored thread never gains display_names', async () => {
    const threads = await listThreads(deps(db), AGENT);
    const serialized = JSON.stringify(threads);
    expect(serialized).not.toContain('secret bio');
    expect(serialized).not.toContain('9000');
    // RED: a non-party's profile never appears.
    expect(serialized).not.toContain('Stranger');
    for (const t of threads) {
      expect(Object.keys(t.display_names).sort()).toEqual([t.party_a, t.party_b].sort());
      expect(Object.values(t.display_names).every((v) => v === null || typeof v === 'string')).toBe(true);
    }
    for (const id of ['t1', 't2', 't3']) {
      expect(db.store.get(`${COMMONS_COLLECTIONS.THREADS}/${id}`)).not.toHaveProperty('display_names');
    }
  });

  it('getThreadView and unreadThreadsFor carry the names too', async () => {
    const view = await getThreadView(deps(db), 't1', HUMAN);
    expect(view.display_names).toEqual({ [AGENT]: 'Atlas', [HUMAN]: 'the operator' });
    const unread = await unreadThreadsFor(deps(db), HUMAN);
    expect(unread.map((t) => t.thread_id)).toEqual(['t1']);
    expect(unread[0].display_names[AGENT]).toBe('Atlas');
  });

  it('RED: a profile read that throws yields null names and the read still succeeds', async () => {
    const throwing = {
      collection: (name: string) => {
        if (name === COMMONS_COLLECTIONS.PROFILES) {
          return { doc: () => ({ get: async () => { throw new Error('profiles unavailable'); } }) };
        }
        return db.collection(name);
      },
    };
    const threads = await listThreads(deps(throwing as unknown as FakeFirestore), AGENT);
    expect(threads).toHaveLength(3);
    expect(threads.every((t) => Object.values(t.display_names).every((v) => v === null))).toBe(true);
  });

  it('a party with no profile anywhere is null', async () => {
    const out = await withThreadDisplayNames(deps(db), [thread('t9', 'wallet_aw_nobody', 'user_nobody', 1)]);
    expect(out[0].display_names).toEqual({ wallet_aw_nobody: null, user_nobody: null });
  });
});
