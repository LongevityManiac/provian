/**
 * PE METER mailbox — one page per (batch, recipient), never one document per act.
 *
 * Each guard ships with its RED control beside a positive twin:
 *   - a foreign recipient cannot acknowledge another's item (the page stays whole), the owner can;
 *   - a partially acknowledged page keeps the rest under the same ids; the last ack deletes it;
 *   - a pre-page item document (one per act) lists and acknowledges by its old id, and an id of
 *     the wrong shape for its document (a bare page id, a `.n` on a legacy doc) drops nothing;
 *   - a cursor walk across page boundaries (with and without acks between pages) returns every
 *     item exactly once, in order — counted over a non-empty population.
 */

import { beforeAll, describe, expect, it } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { expireAt, PE_MAILBOX_COLLECTION, PE_MAILBOX_LIFETIME_MS } from './meter-store';
import type { SealedCopy } from './meter-wire';
import {
  MAILBOX_PAGE_BOX_BUDGET,
  ackMailbox,
  listMailbox,
  mailboxItemId,
  mailboxPageId,
  stageSealedCopies,
  type MailboxItem,
} from './pe-mailbox';

const DB = (fake: FakeFirestore) => fake as unknown as Firestore;
const isFake = (db: FakeFirestore | Firestore): db is FakeFirestore => (db as { store?: unknown }).store instanceof Map;
const asDb = (db: FakeFirestore | Firestore): Firestore => (isFake(db) ? DB(db) : db);
const T0 = Date.parse('2026-10-04T00:00:00Z');
const HUMAN = 'human:user_frank';
const OTHER = 'human:user_mallory';

function copies(prefix: string, count: number, boxSize = 64): SealedCopy[] {
  return Array.from({ length: count }, (_, i) => ({
    to: 'linked_human',
    pe_id: `${prefix}_pe_${i}`,
    box: `${prefix}${i}`.padEnd(boxSize, 'x'),
  }));
}

async function stage(fake: FakeFirestore | Firestore, batchHash: string, sealed: SealedCopy[], nowMs: number, to = HUMAN) {
  return stageSealedCopies(asDb(fake), {
    batchHash,
    deviceId: 'dev_atlas',
    actorId: 'agent_atlas',
    sealed,
    resolveRecipient: (alias) => (alias === 'linked_human' ? to : null),
    nowMs,
  });
}

function mailboxDocs(fake: FakeFirestore): [string, Record<string, unknown>][] {
  return [...fake.store.entries()].filter(([k]) => k.startsWith(`${PE_MAILBOX_COLLECTION}/`));
}

async function seedLegacy(fake: FakeFirestore | Firestore, batchHash: string, peId: string, to: string, createdAtMs: number): Promise<string> {
  const id = mailboxItemId(batchHash, peId, to);
  await asDb(fake).collection(PE_MAILBOX_COLLECTION).doc(id).set({
    id, to, pe_id: peId, box: `legacy_box_${peId}`, from_device: 'dev_old', from_actor: 'agent_atlas',
    batch_hash: batchHash, created_at_ms: createdAtMs, expire_at: expireAt(createdAtMs + PE_MAILBOX_LIFETIME_MS),
  });
  return id;
}

async function walk(fake: FakeFirestore | Firestore, recipient: string, limit: number, ackEach: boolean): Promise<MailboxItem[]> {
  const seen: MailboxItem[] = [];
  let after: string | null = null;
  for (let call = 0; call < 200; call += 1) {
    const got = await listMailbox(asDb(fake), recipient, { limit, afterId: after });
    seen.push(...got.items);
    if (ackEach && got.items.length > 0) {
      expect(await ackMailbox(asDb(fake), recipient, got.items.map((i) => i.id))).toBe(got.items.length);
    }
    if (got.next === null) return seen;
    after = got.next;
  }
  throw new Error('cursor walk did not terminate');
}

describe('pe mailbox: one page per batch and recipient', () => {
  it('holds unacked ciphertext without a TTL, resends it, and never resurrects an acknowledged copy', async () => {
    const fake = createFakeFirestore();
    const sealed = copies('resend', 3);
    await stage(fake, 'resend-batch', sealed, T0);
    expect(mailboxDocs(fake)[0][1].expire_at).toBeUndefined();
    let items = (await listMailbox(DB(fake), HUMAN, { limit: 100 })).items;
    expect(await ackMailbox(DB(fake), HUMAN, [items[0].id])).toBe(1);
    expect((await stage(fake, 'resend-batch', sealed, T0 + 40 * 86_400_000)).pending).toBe(2);
    items = (await listMailbox(DB(fake), HUMAN, { limit: 100 })).items;
    expect(items.map(i => i.pe_id)).toEqual(sealed.slice(1).map(s => s.pe_id));
    expect(await ackMailbox(DB(fake), HUMAN, items.map(i => i.id))).toBe(2);
    expect((await stage(fake, 'resend-batch', sealed, T0 + 50 * 86_400_000)).pending).toBe(0);
    expect(mailboxDocs(fake)).toHaveLength(0);
    expect(JSON.stringify([...fake.store.values()])).not.toContain(sealed[0].box);
  });
  it('stages a batch to one recipient as ONE document and lists its items in order', async () => {
    const fake = createFakeFirestore();
    const sealed = copies('b1', 8);
    const result = await stage(fake, 'batch_1', [...sealed, { to: 'stranger', pe_id: 'b1_pe_0', box: 'nope' }], T0);
    expect(result).toEqual({ staged: 8, refused: 1, pending: 8 });
    const docs = mailboxDocs(fake);
    expect(docs).toHaveLength(1);
    const pageId = mailboxPageId('batch_1', HUMAN, 0);
    expect(docs[0][0]).toBe(`${PE_MAILBOX_COLLECTION}/${pageId}`);
    expect(docs[0][1]).toMatchObject({ id: pageId, to: HUMAN, from_actor: 'agent_atlas', from_device: 'dev_atlas', batch_hash: 'batch_1', created_at_ms: T0 });

    const got = await listMailbox(DB(fake), HUMAN, { limit: 100 });
    expect(got.next).toBeNull();
    expect(got.items.map((i) => i.pe_id)).toEqual(sealed.map((s) => s.pe_id));
    expect(got.items.map((i) => i.box)).toEqual(sealed.map((s) => s.box));
    expect(got.items.map((i) => i.id)).toEqual(sealed.map((_, n) => `${pageId}.${n}`));
    expect(got.items[0]).toEqual({
      id: `${pageId}.0`, to: HUMAN, pe_id: 'b1_pe_0', box: sealed[0].box, from_device: 'dev_atlas',
      from_actor: 'agent_atlas', batch_hash: 'batch_1', created_at_ms: T0,
    });
    // Another recipient sees nothing.
    expect((await listMailbox(DB(fake), OTHER, { limit: 100 })).items).toEqual([]);
  });

  it('is idempotent: a retried batch rewrites the same page identically', async () => {
    const fake = createFakeFirestore();
    await stage(fake, 'batch_1', copies('b1', 8), T0);
    const first = JSON.stringify(mailboxDocs(fake));
    await stage(fake, 'batch_1', copies('b1', 8), T0);
    expect(JSON.stringify(mailboxDocs(fake))).toBe(first);
    expect(mailboxDocs(fake)).toHaveLength(1);
  });

  it('keeps one copy per PE and recipient (a repeated copy replaces the earlier one)', async () => {
    const fake = createFakeFirestore();
    const sealed = copies('b1', 3);
    const result = await stage(fake, 'batch_1', [...sealed, { ...sealed[1], box: 'replacement' }], T0);
    expect(result.staged).toBe(3);
    const got = await listMailbox(DB(fake), HUMAN, { limit: 100 });
    expect(got.items.map((i) => i.box)).toEqual([sealed[0].box, 'replacement', sealed[2].box]);
  });

  it('chunks a large batch so no page passes the box budget, and lists every item', async () => {
    const fake = createFakeFirestore();
    const big = copies('big', 5, 250_000);
    expect(await stage(fake, 'batch_big', big, T0)).toEqual({ staged: 5, refused: 0, pending: 5 });
    const docs = mailboxDocs(fake);
    expect(docs.length).toBe(3); // 2 + 2 + 1 boxes of 250 KB under a 700 KB budget
    for (const [, doc] of docs) {
      const bytes = (doc.items as { box: string }[]).reduce((t, i) => t + i.box.length, 0);
      expect(bytes).toBeLessThanOrEqual(MAILBOX_PAGE_BOX_BUDGET);
    }
    const all = await walk(fake, HUMAN, 2, false);
    expect(all.map((i) => i.pe_id).sort()).toEqual(big.map((b) => b.pe_id).sort());
  });

  it('RED: a foreign recipient cannot acknowledge another\'s items; the recipient can', async () => {
    const fake = createFakeFirestore();
    await stage(fake, 'batch_1', copies('b1', 4), T0);
    const ids = (await listMailbox(DB(fake), HUMAN, { limit: 100 })).items.map((i) => i.id);
    expect(ids).toHaveLength(4);
    expect(await ackMailbox(DB(fake), OTHER, ids)).toBe(0);
    expect((await listMailbox(DB(fake), HUMAN, { limit: 100 })).items.map((i) => i.id)).toEqual(ids);
    expect(await ackMailbox(DB(fake), HUMAN, ids)).toBe(4);
    expect(mailboxDocs(fake)).toHaveLength(0);
  });

  it('a partially acknowledged page keeps the rest under the same ids; the last ack deletes it', async () => {
    const fake = createFakeFirestore();
    await stage(fake, 'batch_1', copies('b1', 8), T0);
    const ids = (await listMailbox(DB(fake), HUMAN, { limit: 100 })).items.map((i) => i.id);
    const acked = [ids[0], ids[3], ids[7]];
    // Duplicates, unknown and malformed ids count nothing.
    expect(await ackMailbox(DB(fake), HUMAN, [...acked, ids[0], 'mp_unknown.1', 'a/b', `${ids[1].split('.')[0]}.x`])).toBe(3);
    const rest = (await listMailbox(DB(fake), HUMAN, { limit: 100 })).items.map((i) => i.id);
    expect(rest).toEqual(ids.filter((id) => !acked.includes(id)));
    expect(mailboxDocs(fake)).toHaveLength(1);
    // Re-acknowledging what is gone drops nothing.
    expect(await ackMailbox(DB(fake), HUMAN, acked)).toBe(0);
    // A bare page id is not an item: the page stays.
    expect(await ackMailbox(DB(fake), HUMAN, [mailboxPageId('batch_1', HUMAN, 0)])).toBe(0);
    expect(mailboxDocs(fake)).toHaveLength(1);
    expect(await ackMailbox(DB(fake), HUMAN, rest)).toBe(5);
    expect(mailboxDocs(fake)).toHaveLength(0);
  });

  it('a pre-page item document lists as a one-item page and acknowledges by its old id', async () => {
    const fake = createFakeFirestore();
    const legacyId = await seedLegacy(fake, 'old_batch', 'pe_old', HUMAN, T0 - 60_000);
    await stage(fake, 'batch_1', copies('b1', 2), T0);
    const got = await listMailbox(DB(fake), HUMAN, { limit: 100 });
    expect(got.items.map((i) => i.id)).toEqual([legacyId, `${mailboxPageId('batch_1', HUMAN, 0)}.0`, `${mailboxPageId('batch_1', HUMAN, 0)}.1`]);
    expect(got.items[0]).toEqual({
      id: legacyId, to: HUMAN, pe_id: 'pe_old', box: 'legacy_box_pe_old', from_device: 'dev_old',
      from_actor: 'agent_atlas', batch_hash: 'old_batch', created_at_ms: T0 - 60_000,
    });
    // RED: the wrong shape of id for a legacy document drops nothing; so does a foreign recipient.
    expect(await ackMailbox(DB(fake), HUMAN, [`${legacyId}.0`])).toBe(0);
    expect(await ackMailbox(DB(fake), OTHER, [legacyId])).toBe(0);
    expect(fake.store.has(`${PE_MAILBOX_COLLECTION}/${legacyId}`)).toBe(true);
    expect(await ackMailbox(DB(fake), HUMAN, [legacyId])).toBe(1);
    expect(fake.store.has(`${PE_MAILBOX_COLLECTION}/${legacyId}`)).toBe(false);
  });

  it('a cursor walk across page boundaries returns every item exactly once, in order', async () => {
    for (const ackEach of [false, true]) {
      const fake = createFakeFirestore();
      const expected: string[] = [];
      for (let i = 0; i < 3; i += 1) expected.push(await seedLegacy(fake, `old_${i}`, `pe_old_${i}`, HUMAN, T0 - 1_000 + i));
      for (let b = 0; b < 6; b += 1) {
        const sealed = copies(`b${b}`, 5);
        await stage(fake, `batch_${b}`, sealed, T0 + b * 3_600_000);
        expected.push(...sealed.map((_, n) => `${mailboxPageId(`batch_${b}`, HUMAN, 0)}.${n}`));
      }
      await stage(fake, 'batch_other', copies('o', 5), T0, OTHER); // never in HUMAN's walk
      for (const limit of [1, 3, 4, 5, 7, 100]) {
        const seen = await walk(fake, HUMAN, limit, false);
        expect(seen.length).toBe(33);
        expect(seen.map((i) => i.id)).toEqual(expected);
      }
      if (ackEach) {
        // The phone's pattern: list a page, acknowledge it, continue from the cursor.
        const seen = await walk(fake, HUMAN, 4, true);
        expect(seen.map((i) => i.id)).toEqual(expected);
        expect(mailboxDocs(fake).every(([, d]) => d.to === OTHER)).toBe(true);
        expect((await listMailbox(DB(fake), HUMAN, { limit: 100 })).items).toEqual([]);
      }
    }
  });

  it('the first page says how many items wait in all; later pages do not; acknowledged and foreign items are not counted', async () => {
    const fake = createFakeFirestore();
    await seedLegacy(fake, 'old_0', 'pe_old_0', HUMAN, T0 - 1_000);
    for (let b = 0; b < 25; b += 1) await stage(fake, `batch_${b}`, copies(`b${b}`, 7), T0 + b * 60_000);
    await stage(fake, 'batch_other', copies('o', 40), T0, OTHER); // RED: another person's items never count
    const first = await listMailbox(DB(fake), HUMAN, { limit: 10 });
    expect(first.items).toHaveLength(10);
    expect(first.waiting).toBe(1 + 25 * 7);
    const second = await listMailbox(DB(fake), HUMAN, { limit: 10, afterId: first.next });
    expect(second.waiting).toBeUndefined();
    // RED: acknowledged items leave the count (a page partly acked counts only what is left).
    expect(await ackMailbox(DB(fake), HUMAN, first.items.map((i) => i.id))).toBe(10);
    expect((await listMailbox(DB(fake), HUMAN, { limit: 10 })).waiting).toBe(1 + 25 * 7 - 10);
    // One page is the whole mailbox: the count is that page.
    const small = createFakeFirestore();
    await stage(small, 'batch_s', copies('s', 3), T0);
    expect(await listMailbox(DB(small), HUMAN, { limit: 100 })).toMatchObject({ next: null, waiting: 3 });
    expect((await listMailbox(DB(createFakeFirestore()), HUMAN, { limit: 100 })).waiting).toBe(0);
  });

  it('an unrecognised cursor (e.g. a pre-page item id) starts over rather than skipping', async () => {
    const fake = createFakeFirestore();
    await stage(fake, 'batch_1', copies('b1', 3), T0);
    const got = await listMailbox(DB(fake), HUMAN, { limit: 100, afterId: mailboxItemId('x', 'y', HUMAN) });
    expect(got.items).toHaveLength(3);
    expect(got.next).toBeNull();
  });
});

/**
 * The same walk against the Firestore EMULATOR (real ordered query + startAt/startAfter cursors,
 * real transactions). Skipped unless FIRESTORE_EMULATOR_HOST is set; recipients are unique per run.
 */
const emulatorSuite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
emulatorSuite('pe mailbox on the Firestore emulator', () => {
  let db: Firestore;
  const RUN = `r${Date.now().toString(36)}`;
  beforeAll(async () => {
    process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT ?? 'demo-meter';
    const admin = (await import('firebase-admin')).default;
    if (admin.apps.length === 0) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
    db = admin.firestore();
  });

  it('walks every item exactly once across pages, acks partially, and refuses a foreign ack', async () => {
    const me = `human:mb_${RUN}`;
    const other = `human:mb_other_${RUN}`;
    const expected: string[] = [];
    for (let i = 0; i < 2; i += 1) expected.push(await seedLegacy(db, `old_${RUN}_${i}`, `pe_old_${i}`, me, T0 - 1_000 + i));
    for (let b = 0; b < 5; b += 1) {
      const sealed = copies(`b${b}`, 4);
      await stage(db, `batch_${RUN}_${b}`, sealed, T0 + b * 3_600_000, me);
      expected.push(...sealed.map((_, n) => `${mailboxPageId(`batch_${RUN}_${b}`, me, 0)}.${n}`));
    }
    await stage(db, `batch_${RUN}_other`, copies('o', 3), T0, other);
    for (const limit of [1, 3, 5, 100]) {
      expect((await walk(db, me, limit, false)).map((i) => i.id)).toEqual(expected);
    }
    // RED: the other recipient cannot drop my items.
    expect(await ackMailbox(db, other, expected)).toBe(0);
    // A partial ack keeps the rest of that page.
    expect(await ackMailbox(db, me, [expected[2], expected[3]])).toBe(2);
    const rest = expected.filter((_, i) => i !== 2 && i !== 3);
    expect((await walk(db, me, 3, false)).map((i) => i.id)).toEqual(rest);
    expect((await walk(db, me, 4, true)).map((i) => i.id)).toEqual(rest);
    expect((await listMailbox(db, me, { limit: 100 })).items).toEqual([]);
    expect((await listMailbox(db, other, { limit: 100 })).items).toHaveLength(3);
  });
});
