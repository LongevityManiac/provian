/**
 * PE meter owner reads: the 410 contract, the bounded recent-acts page, the running-total
 * readers, and the owner-data delete (by actor, earnings kept).
 *
 * Each guard ships with its RED control beside a positive twin: another actor's keys never
 * appear in a page; a page walk counts every key exactly once across a boundary; content never
 * leaves in a priced view; the delete keeps unminted earnings and never touches pending claims
 * or another actor's state.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { ACTOR_STATS_COLLECTION, emptyActorStats, emptyDayBucket, utcDayKey } from '../pvt/actor-stats';
import { decodeKeysetCursor } from '../pagination/keyset-cursor';
import { actKeyDocFor } from './__test-helpers__/seed-act-keys';
import { ACTOR_METER_DAYS_COLLECTION, actorMeterDayDocId, utcDay } from './actor-meter-totals';
import { COUNTERPARTY_PAIRS_COLLECTION } from './counterparty-pairs';
import { IDENTITY_ACTS_COLLECTION } from './identity-acts';
import {
  METER_ACT_KEYS_COLLECTION,
  METER_HELD_ACTS_COLLECTION,
  METER_PENDING_CLAIMS_COLLECTION,
  PE_MAILBOX_COLLECTION,
} from './meter-store';
import {
  PE_KEPT_BY_OWNER_BODY,
  RECENT_ACTS_MAX_LIMIT,
  deleteOwnerMeterState,
  listRecentActKeys,
  pricedActView,
  readActorPeTotals,
  readParticipationSummary,
  rowHasUnmintedEarnings,
  sendPeKeptByOwner,
} from './owner-reads';

const DB = (fake: FakeFirestore) => fake as unknown as Firestore;
const T0 = Date.parse('2026-10-01T00:00:00Z');

function seedAct(fake: FakeFirestore, peId: string, actorId: string, timestamp: number, row: Record<string, unknown> = {}): void {
  fake.store.set(`${METER_ACT_KEYS_COLLECTION}/${peId}`, actKeyDocFor({
    peId, userId: actorId, timestamp, actionType: 'coding_session', mint_status: 'record_only', ...row,
  }));
}

describe('sendPeKeptByOwner', () => {
  function sink() {
    const out: { status?: number; body?: Record<string, unknown> } = {};
    return {
      out,
      res: { status(code: number) { out.status = code; return { json(body: unknown) { out.body = body as Record<string, unknown>; return body; } }; } },
    };
  }

  it('answers 410 with the pe_kept_by_owner contract plus context', () => {
    const { out, res } = sink();
    sendPeKeptByOwner(res, { wallet_id: 'w1' });
    expect(out.status).toBe(410);
    expect(out.body).toEqual({ ...PE_KEPT_BY_OWNER_BODY, wallet_id: 'w1' });
    expect(out.body?.detail).toBe('PEs are kept on the owner’s devices; read the local PE store (SDK/daemon) or the app');
  });

  // RED CONTROL: context can never replace the error contract.
  it('context cannot override error or detail', () => {
    const { out, res } = sink();
    sendPeKeptByOwner(res, { error: 'ok', detail: 'here are your PEs' });
    expect(out.body?.error).toBe('pe_kept_by_owner');
    expect(out.body?.detail).toBe(PE_KEPT_BY_OWNER_BODY.detail);
  });
});

describe('listRecentActKeys — bounded, newest first, merged across ids', () => {
  it('merges an identity’s ids newest first and never shows another actor (RED)', async () => {
    const fake = createFakeFirestore();
    seedAct(fake, 'pe_a1', 'agent', T0 + 1);
    seedAct(fake, 'pe_w1', 'wallet', T0 + 3);
    seedAct(fake, 'pe_a2', 'agent', T0 + 2);
    seedAct(fake, 'pe_x', 'stranger', T0 + 9);
    const page = await listRecentActKeys(DB(fake), ['agent', 'wallet', 'agent', ''], { limit: 10 });
    expect(page.acts.map((a) => a.id)).toEqual(['pe_w1', 'pe_a2', 'pe_a1']);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('walks every key exactly once across page boundaries (shared timestamps, id tiebreak)', async () => {
    const fake = createFakeFirestore();
    const ids: string[] = [];
    for (let i = 0; i < 23; i += 1) {
      const id = `pe_${String(i).padStart(3, '0')}`;
      ids.push(id);
      seedAct(fake, id, i % 2 === 0 ? 'agent' : 'wallet', T0 + Math.floor(i / 4)); // 4 keys per ms
    }
    const seen: string[] = [];
    let cursor = null;
    let pages = 0;
    for (;;) {
      const page = await listRecentActKeys(DB(fake), ['agent', 'wallet'], { limit: 5, cursor });
      seen.push(...page.acts.map((a) => a.id));
      pages += 1;
      if (page.nextCursor === null) break;
      cursor = decodeKeysetCursor(page.nextCursor);
      if (pages > 10) throw new Error('walk did not terminate');
    }
    expect(pages).toBe(5);
    expect(new Set(seen).size).toBe(23);
    expect(seen.length).toBe(23);
    expect([...seen].sort()).toEqual(ids);
  });

  // RED CONTROL for the walk above: a page that ignores the cursor sees only the first page.
  it('CONTROL — ignoring the cursor sees the first page only', async () => {
    const fake = createFakeFirestore();
    for (let i = 0; i < 12; i += 1) seedAct(fake, `pe_${i}`, 'agent', T0 + i);
    const first = await listRecentActKeys(DB(fake), ['agent'], { limit: 5 });
    const again = await listRecentActKeys(DB(fake), ['agent'], { limit: 5 });
    expect(first.hasMore).toBe(true);
    expect(again.acts.map((a) => a.id)).toEqual(first.acts.map((a) => a.id));
  });

  it('applies an offset and clamps the limit', async () => {
    const fake = createFakeFirestore();
    for (let i = 0; i < 8; i += 1) seedAct(fake, `pe_${i}`, 'agent', T0 + i);
    const offset = await listRecentActKeys(DB(fake), ['agent'], { limit: 2, offset: 3 });
    expect(offset.acts.map((a) => a.id)).toEqual(['pe_4', 'pe_3']);
    expect(offset.hasMore).toBe(true);
    const huge = await listRecentActKeys(DB(fake), ['agent'], { limit: 10_000 });
    expect(huge.acts.length).toBe(8);
    expect(RECENT_ACTS_MAX_LIMIT).toBe(100);
  });
});

describe('pricedActView — priced rows, never content', () => {
  it('shows type, time, disposition and points, and drops content fields', () => {
    const view = pricedActView({
      id: 'pe_1',
      key: actKeyDocFor({
        peId: 'pe_1', userId: 'agent', timestamp: T0, actionType: 'coding_session',
        mint_status: 'eligible', mint_disposition: 'eligible', record_points_atomic: '10',
        inputSummary: 'SECRET INPUT', outputSummary: 'SECRET OUTPUT', metadata: { prompt: 'SECRET PROMPT' },
      }) as never,
    });
    expect(view).toMatchObject({ peId: 'pe_1', actionType: 'coding_session', mintStatus: 'eligible', recordPointsAtomic: '10', clientPeId: 'client_pe_1' });
    const serialized = JSON.stringify(view);
    for (const secret of ['SECRET INPUT', 'SECRET OUTPUT', 'SECRET PROMPT']) expect(serialized).not.toContain(secret);
  });
});

describe('running-total readers', () => {
  it('readActorPeTotals sums disjoint actor ids once each', async () => {
    const fake = createFakeFirestore();
    fake.store.set(`${ACTOR_STATS_COLLECTION}/agent`, { ...emptyActorStats('agent'), pe_count: 3, by_type: { send: 2, receive: 1 } });
    fake.store.set(`${ACTOR_STATS_COLLECTION}/wallet`, { ...emptyActorStats('wallet'), pe_count: 2, by_type: { send: 1, device_register: 1 } });
    const totals = await readActorPeTotals(DB(fake), ['agent', 'wallet', 'agent', 'missing']);
    expect(totals.peCount).toBe(5);
    expect(totals.byType).toEqual({ send: 3, receive: 1, device_register: 1 });
  });

  it('readParticipationSummary composes stats and the 30 day counters', async () => {
    const fake = createFakeFirestore();
    const now = Date.parse('2026-10-03T12:00:00Z');
    const day = 24 * 60 * 60 * 1000;
    fake.store.set(`${ACTOR_STATS_COLLECTION}/u1`, {
      ...emptyActorStats('u1'),
      pe_count: 40,
      first_pe_at_ms: now - 200 * day,
      by_type: { promise_fulfilled: 3 },
      days: {
        [utcDayKey(now)]: { ...emptyDayBucket(), n: 4 },
        [utcDayKey(now - 10 * day)]: { ...emptyDayBucket(), n: 6 },
        [utcDayKey(now - 45 * day)]: { ...emptyDayBucket(), n: 30 }, // outside the window
      },
    });
    fake.store.set(`${ACTOR_METER_DAYS_COLLECTION}/${actorMeterDayDocId('u1', utcDay(now))}`, { agent_actions: 2, corroborated: 1 });
    fake.store.set(`${ACTOR_METER_DAYS_COLLECTION}/${actorMeterDayDocId('u1', utcDay(now - 10 * day))}`, { agent_actions: 1, corroborated: 4 });
    // RED CONTROL: a day counter outside the 30-day window is not read.
    fake.store.set(`${ACTOR_METER_DAYS_COLLECTION}/${actorMeterDayDocId('u1', utcDay(now - 45 * day))}`, { agent_actions: 99, corroborated: 99 });
    const summary = await readParticipationSummary(DB(fake), 'u1', now);
    expect(summary).toEqual({
      pe_count_total: 40,
      pe_count_this_month: 10,
      corroboration_rate: 0.5,
      agent_hours_this_month: 0,
      agent_actions_this_month: 3,
      promises_kept: 3,
      foundation_member_since: now - 200 * day,
    });
  });

  it('an actor with no totals reports zeros', async () => {
    const summary = await readParticipationSummary(DB(createFakeFirestore()), 'nobody', T0);
    expect(summary.pe_count_total).toBe(0);
    expect(summary.corroboration_rate).toBe(0);
    expect(summary.foundation_member_since).toBeNull();
  });
});

describe('deleteOwnerMeterState — by actor, earnings kept', () => {
  function seedOwner(fake: FakeFirestore, actor: string, count: number): void {
    for (let i = 0; i < count; i += 1) {
      seedAct(fake, `${actor}_ak_${String(i).padStart(4, '0')}`, actor, T0 + i,
        { mint_status: i % 7 === 0 ? 'eligible' : 'record_only' });
    }
    fake.store.set(`${METER_HELD_ACTS_COLLECTION}/${actor}_held_paid`, { actor_id: actor, key: { row: { mint_status: 'record_only' } } });
    fake.store.set(`${METER_HELD_ACTS_COLLECTION}/${actor}_held_payee`, { actor_id: actor, key: { row: { mint_status: 'eligible' } } });
    fake.store.set(`${PE_MAILBOX_COLLECTION}/${actor}_mail_in`, { to: `human:${actor}`, from_actor: 'someone_agent' });
    fake.store.set(`${PE_MAILBOX_COLLECTION}/${actor}_mail_out`, { to: 'human:someone', from_actor: actor });
    fake.store.set(`${IDENTITY_ACTS_COLLECTION}/${actor}_id_1`, { actor_id: actor });
    fake.store.set(`${COUNTERPARTY_PAIRS_COLLECTION}/${actor}_pair_1`, { actor_id: actor });
    fake.store.set(`${METER_PENDING_CLAIMS_COLLECTION}/${actor}_claim_1`, { actor_id: actor, status: 'pending' });
  }

  it('deletes the owner’s meter state across page boundaries, keeping unminted earnings', async () => {
    const fake = createFakeFirestore();
    seedOwner(fake, 'u1', 650); // > 2 delete pages
    seedOwner(fake, 'u2', 5);
    const before = [...fake.store.keys()];

    const deleted = await deleteOwnerMeterState(DB(fake), 'u1');

    const eligibleKeys = Array.from({ length: 650 }, (_v, i) => i).filter((i) => i % 7 === 0).length;
    // act keys (650 − eligible) + held_paid + mail in + mail out + identity act + pair
    expect(deleted).toBe(650 - eligibleKeys + 5);
    const remainingU1Keys = [...fake.store.keys()].filter((k) => k.startsWith(`${METER_ACT_KEYS_COLLECTION}/u1_`));
    expect(remainingU1Keys.length).toBe(eligibleKeys);
    for (const k of remainingU1Keys) expect(rowHasUnmintedEarnings((fake.store.get(k) as { row: unknown }).row)).toBe(true);
    expect(fake.store.has(`${METER_HELD_ACTS_COLLECTION}/u1_held_payee`)).toBe(true);
    expect(fake.store.has(`${METER_HELD_ACTS_COLLECTION}/u1_held_paid`)).toBe(false);
    for (const gone of [`${PE_MAILBOX_COLLECTION}/u1_mail_in`, `${PE_MAILBOX_COLLECTION}/u1_mail_out`, `${IDENTITY_ACTS_COLLECTION}/u1_id_1`, `${COUNTERPARTY_PAIRS_COLLECTION}/u1_pair_1`]) {
      expect(fake.store.has(gone)).toBe(false);
    }
    // RED CONTROLS: pending claims are money-safety state and are never deleted; another actor's
    // state is untouched.
    expect(fake.store.has(`${METER_PENDING_CLAIMS_COLLECTION}/u1_claim_1`)).toBe(true);
    for (const key of before.filter((k) => k.includes('/u2_'))) expect(fake.store.has(key)).toBe(true);
  });

  it('keeps only rows that still carry earnings', () => {
    expect(rowHasUnmintedEarnings({ mint_status: 'eligible' })).toBe(true);
    for (const row of [{ mint_status: 'minted' }, { mint_status: 'record_only' }, null, undefined, [], 'eligible']) {
      expect(rowHasUnmintedEarnings(row)).toBe(false);
    }
  });

  it('an owner with no meter state deletes nothing', async () => {
    const fake = createFakeFirestore();
    seedOwner(fake, 'u2', 3);
    const size = fake.store.size;
    expect(await deleteOwnerMeterState(DB(fake), 'u1')).toBe(0);
    expect(fake.store.size).toBe(size);
  });
});
