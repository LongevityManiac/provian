/**
 * FEATURED PLACEMENT is a burn auction on the global single-use ledger.
 * One burn = one bid; the bid is the burn's verified amount (floor 15 PVT, no ceiling).
 * one item, one slot, burns STACK (rank = sum of the item's unexpired bids, ties to the
 * earlier first bid); a placement ENDS the moment its item closes (no refund).
 * RED controls: a burn under the floor, a foreign burn, a burn already spent, a board item the
 * bidder does not own, a closed item, a missing item — all refused before any write; a closed
 * item's live bids never list.
 */
import { describe, it, expect } from '@jest/globals';
import { bidFeatured, listFeatured, featuredRankOf, isFeaturedItemOpen, FEATURED_TERM_MS, type FeaturedBoard } from './featured';
import { ForbiddenError, NotFoundError, ValidationError } from '../agent-bank/errors';
import type { AgentBankDeps } from '../agent-bank/types';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { seedBurn } from './__test-helpers__/speech';

const PVT = 1_000_000_000_000_000_000n;
const NOW = 1_800_000_000_000;
const A = 'wallet_aw_a';
const B = 'wallet_aw_b';

function deps(db: FakeFirestore): AgentBankDeps {
  return { db, cache: { checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }) }, peBuffer: { enqueue: () => {} }, recordPEAccrual: async () => {} } as unknown as AgentBankDeps;
}
const actor = (id: string) => ({ walletId: id, agentId: `agent_${id}`, actorAddress: `0x${id}`, isAgent: true });
const ok = async () => {};

const COLLECTION: Record<FeaturedBoard, string> = { wants: 'commons_wants', jobs: 'jobs', human_jobs: 'commons_human_jobs' };
function seedItem(db: FakeFirestore, board: FeaturedBoard, id: string, status = 'open', extra: Record<string, unknown> = {}): void {
  db.store.set(`${COLLECTION[board]}/${id}`, { status, ...(board === 'wants' ? { expiry: null } : {}), ...extra });
}
function setStatus(db: FakeFirestore, board: FeaturedBoard, id: string, status: string): void {
  const doc = db.store.get(`${COLLECTION[board]}/${id}`) as Record<string, unknown>;
  db.store.set(`${COLLECTION[board]}/${id}`, { ...doc, status });
}
const burn = (n: number) => n.toString(16).padStart(64, '0');
async function bid(db: FakeFirestore, board: FeaturedBoard, itemId: string, who: string, burnId: string, nowMs: number) {
  return bidFeatured(deps(db), { board, itemId, actor: actor(who), burnId, assertBiddable: ok, nowMs });
}

describe('bidFeatured', () => {
  it('refuses a new paid bid on a hidden prelaunch listing before consuming the burn', async () => {
    const db = createFakeFirestore();
    const burnId = burn(91);
    seedItem(db, 'human_jobs', 'hjob_test', 'open', { public_visibility: 'hidden_prelaunch_test' });
    seedBurn(db, burnId, A, 20n * PVT);
    await expect(bid(db, 'human_jobs', 'hjob_test', A, burnId, NOW)).rejects.toThrow('item not found');
    expect(db.store.has(`burn_consumptions/${burnId}`)).toBe(false);
    expect(db.store.has(`commons_featured_placements/${burnId}`)).toBe(false);
  });

  it('consumes the burn, creates the placement, seals a record-only PE, and ranks by amount', async () => {
    const db = createFakeFirestore();
    seedItem(db, 'wants', 'want_a');
    seedItem(db, 'wants', 'want_b');
    seedBurn(db, '1'.repeat(64), A, 15n * PVT);
    seedBurn(db, '2'.repeat(64), B, 40n * PVT);
    const pa = await bid(db, 'wants', 'want_a', A, '1'.repeat(64), NOW);
    const pb = await bid(db, 'wants', 'want_b', B, '2'.repeat(64), NOW + 1);
    expect(pa.amount_atomic).toBe((15n * PVT).toString());
    expect(pa.featured_until).toBe(NOW + FEATURED_TERM_MS);
    expect(pa.pe_id).toBeTruthy();
    const marker = db.store.get(`burn_consumptions/${'1'.repeat(64)}`) as { product: string; ref: string };
    expect(marker.product).toBe('featured_placement');
    expect(marker.ref).toBe('wants:want_a');
    const slots = await listFeatured(deps(db), 'wants', NOW + 2);
    expect(slots.map((s) => [s.rank, s.item_id])).toEqual([[1, 'want_b'], [2, 'want_a']]);
    expect((await featuredRankOf(deps(db), 'wants', 'want_a', NOW + 2))?.rank).toBe(2);
    expect(pb.board).toBe('wants');
    // lapsed after the term
    expect(await listFeatured(deps(db), 'wants', NOW + FEATURED_TERM_MS + 1)).toEqual([]);
  });

  it('a bid above the floor is the burn\'s full verified amount — no ceiling', async () => {
    const db = createFakeFirestore();
    seedItem(db, 'human_jobs', 'hjob_big');
    const amount = 12_345n * PVT + 678n;
    seedBurn(db, burn(90), A, amount);
    const p = await bid(db, 'human_jobs', 'hjob_big', A, burn(90), NOW);
    expect(p.amount_atomic).toBe(amount.toString());
    expect((await listFeatured(deps(db), 'human_jobs', NOW + 1))[0].amount_atomic).toBe(amount.toString());
  });

  it('RED: a burn under the 15-PVT floor is refused before any write', async () => {
    const db = createFakeFirestore();
    seedItem(db, 'jobs', 'job_1');
    seedBurn(db, '3'.repeat(64), A, 15n * PVT - 1n);
    await expect(bidFeatured(deps(db), { board: 'jobs', itemId: 'job_1', actor: actor(A), burnId: '3'.repeat(64), assertBiddable: ok })).rejects.toThrow(/burn/i);
    expect(db.store.get(`burn_consumptions/${'3'.repeat(64)}`)).toBeUndefined();
    expect(db.store.get(`commons_featured_placements/${'3'.repeat(64)}`)).toBeUndefined();
  });

  it('RED: another wallet\'s burn is refused', async () => {
    const db = createFakeFirestore();
    seedItem(db, 'jobs', 'job_1');
    seedBurn(db, '4'.repeat(64), B, 20n * PVT);
    await expect(bidFeatured(deps(db), { board: 'jobs', itemId: 'job_1', actor: actor(A), burnId: '4'.repeat(64), assertBiddable: ok })).rejects.toThrow(/different wallet/);
  });

  it('RED: one burn buys ONE bid (global single-use)', async () => {
    const db = createFakeFirestore();
    seedItem(db, 'human_jobs', 'hjob_1');
    seedItem(db, 'human_jobs', 'hjob_2');
    seedBurn(db, '5'.repeat(64), A, 20n * PVT);
    await bidFeatured(deps(db), { board: 'human_jobs', itemId: 'hjob_1', actor: actor(A), burnId: '5'.repeat(64), assertBiddable: ok });
    await expect(bidFeatured(deps(db), { board: 'human_jobs', itemId: 'hjob_2', actor: actor(A), burnId: '5'.repeat(64), assertBiddable: ok })).rejects.toThrow(/already/i);
    expect(await listFeatured(deps(db), 'human_jobs', Date.now())).toHaveLength(1);
  });

  it('RED: the board\'s own ownership check runs inside the transaction and refuses before any write', async () => {
    const db = createFakeFirestore();
    seedItem(db, 'jobs', 'job_x');
    seedBurn(db, '6'.repeat(64), A, 20n * PVT);
    await expect(bidFeatured(deps(db), {
      board: 'jobs', itemId: 'job_x', actor: actor(A), burnId: '6'.repeat(64),
      assertBiddable: async () => { throw new ForbiddenError('Only the poster can feature a job'); },
    })).rejects.toBeInstanceOf(ForbiddenError);
    expect(db.store.get(`burn_consumptions/${'6'.repeat(64)}`)).toBeUndefined();
  });

  it.each([
    ['wants', 'matched'], ['wants', 'cancelled'], ['wants', 'fulfilled'],
    ['human_jobs', 'in_progress'], ['human_jobs', 'completed'], ['human_jobs', 'cancelled'], ['human_jobs', 'refunded'], ['human_jobs', 'disputed'],
  ] as Array<[FeaturedBoard, string]>)('RED: a %s item that is %s cannot be bid on — refused before any write', async (board, status) => {
    const db = createFakeFirestore();
    seedItem(db, board, 'item_closed', status);
    seedBurn(db, burn(7), A, 20n * PVT);
    await expect(bid(db, board, 'item_closed', A, burn(7), NOW)).rejects.toBeInstanceOf(ValidationError);
    expect(db.store.get(`burn_consumptions/${burn(7)}`)).toBeUndefined();
    expect(db.store.get(`commons_featured_placements/${burn(7)}`)).toBeUndefined();
  });

  it('RED: an expired want and a missing item cannot be bid on', async () => {
    const db = createFakeFirestore();
    seedItem(db, 'wants', 'want_old', 'open', { expiry: NOW - 1 });
    seedBurn(db, burn(8), A, 20n * PVT);
    await expect(bid(db, 'wants', 'want_old', A, burn(8), NOW)).rejects.toBeInstanceOf(ValidationError);
    await expect(bid(db, 'wants', 'want_ghost', A, burn(8), NOW)).rejects.toBeInstanceOf(NotFoundError);
    expect(db.store.get(`burn_consumptions/${burn(8)}`)).toBeUndefined();
  });
});

describe('listFeatured — one item, one slot, burns stack', () => {
  it('bids on one item stack into ONE slot ranked by their sum', async () => {
    const db = createFakeFirestore();
    seedItem(db, 'wants', 'want_stack');
    seedItem(db, 'wants', 'want_single');
    seedBurn(db, burn(1), A, 15n * PVT);
    seedBurn(db, burn(2), A, 20n * PVT);
    seedBurn(db, burn(3), B, 30n * PVT);
    await bid(db, 'wants', 'want_stack', A, burn(1), NOW);
    await bid(db, 'wants', 'want_single', B, burn(3), NOW + 1);
    await bid(db, 'wants', 'want_stack', A, burn(2), NOW + 2);
    const slots = await listFeatured(deps(db), 'wants', NOW + 3);
    // 15 + 20 = 35 > 30: the stacked item outranks a single bid larger than either of its bids.
    expect(slots).toHaveLength(2);
    expect(slots[0]).toMatchObject({
      rank: 1, item_id: 'want_stack', wallet_id: A, amount_atomic: (35n * PVT).toString(),
      bid_count: 2, burn_ids: [burn(1), burn(2)], burn_id: burn(1), first_bid_at: NOW,
      featured_until: NOW + 2 + FEATURED_TERM_MS,
    });
    expect(slots[1]).toMatchObject({ rank: 2, item_id: 'want_single', amount_atomic: (30n * PVT).toString(), bid_count: 1 });
    // RED control: every item appears exactly once.
    expect(new Set(slots.map((s) => s.item_id)).size).toBe(slots.length);
  });

  it('only UNEXPIRED bids count toward the sum', async () => {
    const db = createFakeFirestore();
    seedItem(db, 'human_jobs', 'hjob_a');
    seedItem(db, 'human_jobs', 'hjob_b');
    seedBurn(db, burn(1), A, 25n * PVT);
    seedBurn(db, burn(2), A, 15n * PVT);
    seedBurn(db, burn(3), B, 20n * PVT);
    await bid(db, 'human_jobs', 'hjob_a', A, burn(1), NOW);
    await bid(db, 'human_jobs', 'hjob_b', B, burn(3), NOW + 10);
    await bid(db, 'human_jobs', 'hjob_a', A, burn(2), NOW + 20);
    // Before the first bid lapses: a = 40, b = 20.
    expect((await listFeatured(deps(db), 'human_jobs', NOW + 30)).map((s) => [s.item_id, s.amount_atomic]))
      .toEqual([['hjob_a', (40n * PVT).toString()], ['hjob_b', (20n * PVT).toString()]]);
    // After it lapses: a = 15 (only its second bid), b = 20 → b first.
    const later = await listFeatured(deps(db), 'human_jobs', NOW + FEATURED_TERM_MS + 5);
    expect(later.map((s) => [s.rank, s.item_id, s.amount_atomic, s.bid_count]))
      .toEqual([[1, 'hjob_b', (20n * PVT).toString(), 1], [2, 'hjob_a', (15n * PVT).toString(), 1]]);
  });

  it('ties go to the earlier FIRST bid, not the earlier latest bid', async () => {
    const db = createFakeFirestore();
    seedItem(db, 'wants', 'want_first');
    seedItem(db, 'wants', 'want_second');
    seedBurn(db, burn(1), A, 15n * PVT);
    seedBurn(db, burn(2), B, 20n * PVT);
    seedBurn(db, burn(3), A, 20n * PVT);
    seedBurn(db, burn(4), B, 15n * PVT);
    await bid(db, 'wants', 'want_first', A, burn(1), NOW);       // first bid on want_first
    await bid(db, 'wants', 'want_second', B, burn(2), NOW + 5);  // first bid on want_second
    await bid(db, 'wants', 'want_second', B, burn(4), NOW + 6);
    await bid(db, 'wants', 'want_first', A, burn(3), NOW + 9);   // want_first's LATEST bid is the later one
    const slots = await listFeatured(deps(db), 'wants', NOW + 10);
    expect(slots.map((s) => [s.rank, s.item_id, s.amount_atomic])).toEqual([
      [1, 'want_first', (35n * PVT).toString()],
      [2, 'want_second', (35n * PVT).toString()],
    ]);
  });

  it.each([
    ['wants', 'cancelled'], ['wants', 'matched'], ['wants', 'fulfilled'],
    ['human_jobs', 'in_progress'], ['human_jobs', 'completed'], ['human_jobs', 'cancelled'],
    ['jobs', 'assigned'], ['jobs', 'cancelled'],
  ] as Array<[FeaturedBoard, string]>)('a %s item that becomes %s drops out immediately; the burn stays consumed', async (board, status) => {
    const db = createFakeFirestore();
    seedItem(db, board, 'item_live');
    seedItem(db, board, 'item_closing');
    seedBurn(db, burn(1), A, 15n * PVT);
    seedBurn(db, burn(2), B, 99n * PVT);
    await bid(db, board, 'item_live', A, burn(1), NOW);
    await bid(db, board, 'item_closing', B, burn(2), NOW + 1);
    expect((await listFeatured(deps(db), board, NOW + 2)).map((s) => s.item_id)).toEqual(['item_closing', 'item_live']);
    setStatus(db, board, 'item_closing', status);
    const after = await listFeatured(deps(db), board, NOW + 3);
    expect(after.map((s) => [s.rank, s.item_id])).toEqual([[1, 'item_live']]);
    expect(await featuredRankOf(deps(db), board, 'item_closing', NOW + 3)).toBeNull();
    // No refund: the burn's consumption marker and the placement record both stand.
    expect(db.store.get(`burn_consumptions/${burn(2)}`)).toBeDefined();
    expect(db.store.get(`commons_featured_placements/${burn(2)}`)).toBeDefined();
  });

  it('a want past its expiry and an item that no longer exists drop out', async () => {
    const db = createFakeFirestore();
    seedItem(db, 'wants', 'want_exp', 'open', { expiry: NOW + 100 });
    seedItem(db, 'wants', 'want_gone');
    seedBurn(db, burn(1), A, 15n * PVT);
    seedBurn(db, burn(2), A, 15n * PVT);
    await bid(db, 'wants', 'want_exp', A, burn(1), NOW);
    await bid(db, 'wants', 'want_gone', A, burn(2), NOW);
    expect(await listFeatured(deps(db), 'wants', NOW + 1)).toHaveLength(2);
    db.store.delete('commons_wants/want_gone');
    expect((await listFeatured(deps(db), 'wants', NOW + 101)).map((s) => s.item_id)).toEqual([]);
  });

  it('RED: an item whose read FAILS is not listed (Unknown = block), while a readable open item still is', async () => {
    const db = createFakeFirestore();
    seedItem(db, 'human_jobs', 'hjob_ok');
    seedItem(db, 'human_jobs', 'hjob_flaky');
    seedBurn(db, burn(1), A, 15n * PVT);
    seedBurn(db, burn(2), A, 20n * PVT);
    await bid(db, 'human_jobs', 'hjob_ok', A, burn(1), NOW);
    await bid(db, 'human_jobs', 'hjob_flaky', A, burn(2), NOW);
    // Only the ITEM read throws; the placements query and every other read go through.
    const flakyDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'collection') return Reflect.get(target, prop, receiver);
        return (name: string) => {
          const col = target.collection(name);
          if (name !== 'commons_human_jobs') return col;
          return new Proxy(col, {
            get(c, p, r) {
              if (p !== 'doc') return Reflect.get(c, p, r);
              return (id: string) => (id === 'hjob_flaky'
                ? { get: async () => { throw new Error('UNAVAILABLE'); } }
                : c.doc(id));
            },
          });
        };
      },
    });
    const slots = await listFeatured(deps(flakyDb as FakeFirestore), 'human_jobs', NOW + 1);
    expect(slots.map((s) => s.item_id)).toEqual(['hjob_ok']);
  });

  it('isFeaturedItemOpen: only an open item is featurable (Unknown = block)', () => {
    expect(isFeaturedItemOpen('wants', { status: 'open', expiry: null }, NOW)).toBe(true);
    expect(isFeaturedItemOpen('wants', { status: 'open', expiry: NOW }, NOW)).toBe(false);
    expect(isFeaturedItemOpen('wants', { status: 'matched', expiry: null }, NOW)).toBe(false);
    expect(isFeaturedItemOpen('human_jobs', { status: 'open' }, NOW)).toBe(true);
    expect(isFeaturedItemOpen('human_jobs', { status: 'in_progress' }, NOW)).toBe(false);
    expect(isFeaturedItemOpen('human_jobs', {}, NOW)).toBe(false);
    expect(isFeaturedItemOpen('jobs', undefined, NOW)).toBe(false);
  });
});
