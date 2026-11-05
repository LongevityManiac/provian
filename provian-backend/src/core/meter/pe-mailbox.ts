import { privateRetentionKey } from '../provenance/private-retention';
/**
 * PE METER — transit: a PE sealed to its recipient, held until acknowledgement.
 *
 * Every PE from a linked agent, or from a human's other devices, is also encrypted to that
 * human (an x25519 sealed box to the human's published recovery anchor, opened only with their
 * seed). The relay holds that ciphertext until the human's phone files it in their own cloud
 * backup and acknowledges it. New transit pages have no TTL; an unacknowledged daemon copy
 * is re-sent from the owner's permanent store. Existing legacy pages keep their original TTL. The
 * agent's own copy remains on the agent's machine. The relay never holds a readable PE: it cannot
 * open a box, and it keeps no copy once the box is acknowledged.
 *
 * PEs the relay itself authors (webhooks, chain watchers, institution events, Genesis) reach
 * their owner the same way (`meter-relay-authored.ts`).
 *
 * STORAGE (cost pass, 2026-10-04): the relay keeps nothing per act. The sealed copies of one batch
 * to one recipient are ONE page document (chunked only when its boxes pass ~700 KB), so a batch
 * costs one write to stage, one read to list and one read + one delete to acknowledge — never one
 * of each per act. An item's id is `<pageId>.<n>` (opaque to clients), which locates its page
 * without a query. A pre-page item document (one doc per act: `id` = its doc id, no `items`) reads
 * as a one-item page whose item id is the doc id, so items staged before this change list and
 * acknowledge unchanged until they are filed or expire.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { createHash, createHmac, randomUUID } from 'crypto';
import { expireAt, METER_BATCHES_COLLECTION, METER_SETTLED_CLAIM_LIFETIME_MS, PE_MAILBOX_COLLECTION } from './meter-store';
import type { SealedCopy } from './meter-wire';

/** Tiny opaque notification head: one point read, no mailbox query or ciphertext retrieval. */
export const PE_MAILBOX_HEADS = 'pe_mailbox_heads_v1';
function mailboxHeadRef(db: Firestore, recipient: string): FirebaseFirestore.DocumentReference {
  const id = createHmac('sha256', privateRetentionKey()).update('meter-mailbox-head:v1\0' + recipient).digest('hex');
  return db.collection(PE_MAILBOX_HEADS).doc(id);
}
export async function peekMailbox(db: Firestore, recipient: string): Promise<{ version: string }> {
  const ref = mailboxHeadRef(db, recipient), snap = await ref.get();
  let value: unknown = snap.data()?.version;
  if (!snap.exists) {
    // The first check ALWAYS drains: the daemon has no previous version, including for legacy pages.
    const version = randomUUID();
    try { await ref.create({ version }); value = version; }
    catch (error) {
      if ((error as { code?: unknown })?.code !== 6) throw error;
      value = (await ref.get()).data()?.version;
    }
  }
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) throw new Error('mailbox_head_invalid');
  return { version: value };
}

export interface MailboxItem {
  readonly id: string;
  readonly to: string;
  readonly pe_id: string;
  readonly box: string;
  readonly from_device: string;
  readonly from_actor: string;
  readonly batch_hash: string;
  readonly created_at_ms: number;
}

/** One sealed copy inside a page. `n` is its stable position in the page (never renumbered). */
export interface MailboxPageItem {
  readonly n: number;
  readonly pe_id: string;
  readonly box: string;
}

/** The stored page: every sealed copy of one batch to one recipient (one chunk of them). */
export interface MailboxPage {
  readonly id: string;
  readonly to: string;
  readonly from_device: string;
  readonly from_actor: string;
  readonly batch_hash: string;
  readonly created_at_ms: number;
  readonly items: readonly MailboxPageItem[];
}

/** Box + pe-id characters per page before a new chunk starts (Firestore's limit is 1 MiB). */
export const MAILBOX_PAGE_BOX_BUDGET = 700_000;
/** Items per page, whatever their size. */
export const MAILBOX_PAGE_MAX_ITEMS = 500;
/** Pages per WriteBatch commit (each ≤ ~0.7 MB, under the 10 MiB request limit). */
const PAGES_PER_COMMIT = 10;
/** Page transactions an acknowledgement runs at once. */
const ACK_CONCURRENCY = 16;
export const PE_MAILBOX_ACKS_COLLECTION = 'pe_mailbox_acks_v1';
/** Query rounds one list may run (a round reads only the pages it expects to need). */
const LIST_MAX_ROUNDS = 8;
/** Pages the first list round reads (a phone draining hourly finds one or two). */
const LIST_FIRST_ROUND_PAGES = 4;
/** Cursor `n` meaning "past every item of this page". */
const PAGE_END_N = 999_999;

const PAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CURSOR = /^c1\.(\d{1,16})\.([A-Za-z0-9_-]{1,128})\.(\d{1,6})$/;

/** The id of a pre-page item document (one per act). Kept for the legacy shape's tests/tools. */
export function mailboxItemId(batchHash: string, peId: string, to: string): string {
  return `mb_${createHash('sha256').update(`${batchHash}|${peId}|${to}`).digest('hex').slice(0, 40)}`;
}

/** The page holding chunk `chunk` of a batch's sealed copies to `to` (deterministic: retries rewrite it). */
export function mailboxPageId(batchHash: string, to: string, chunk: number): string {
  return `mp_${createHash('sha256').update(`${batchHash}|${to}|${chunk}`).digest('hex').slice(0, 40)}`;
}

/** An item's opaque id: its page and its stable position there. */
export function mailboxPageItemId(pageId: string, n: number): string {
  return `${pageId}.${n}`;
}

/** Split one recipient's copies into pages by size (input order kept). */
function chunkItems(copies: readonly { pe_id: string; box: string }[]): MailboxPageItem[][] {
  const chunks: MailboxPageItem[][] = [];
  let current: MailboxPageItem[] = [];
  let bytes = 0;
  for (const copy of copies) {
    const size = copy.box.length + copy.pe_id.length + 16;
    if (current.length > 0 && (bytes + size > MAILBOX_PAGE_BOX_BUDGET || current.length >= MAILBOX_PAGE_MAX_ITEMS)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push({ n: current.length, pe_id: copy.pe_id, box: copy.box });
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Write sealed copies: one page per (batch, recipient, chunk). Idempotent: a retried batch rewrites the same pages. */
export async function stageSealedCopies(
  db: Firestore,
  input: {
    readonly batchHash: string;
    readonly deviceId: string;
    readonly actorId: string;
    readonly sealed: readonly SealedCopy[];
    /**
     * Resolve a copy's `to` alias to its recipient key, or null when this device may not seal to
     * it. Devices name a role, not an identity: `linked_human` (an agent's linked human) or
     * `owner` (a human device's own owner, i.e. their phone). The relay resolves it.
     */
    readonly resolveRecipient: (to: string) => string | null;
    readonly nowMs: number;
  },
): Promise<{ readonly staged: number; readonly refused: number; readonly pending: number }> {
  let refused = 0;
  // recipient → pe_id → box. One copy per (pe, recipient), as the per-item ids always keyed it:
  // a repeated copy replaces the earlier one in place.
  const byRecipient = new Map<string, Map<string, string>>();
  for (const copy of input.sealed) {
    const recipient = input.resolveRecipient(copy.to);
    if (recipient === null) {
      refused += 1;
      continue;
    }
    let copies = byRecipient.get(recipient);
    if (copies === undefined) {
      copies = new Map();
      byRecipient.set(recipient, copies);
    }
    copies.set(copy.pe_id, copy.box);
  }

  let staged = 0;
  const pages: { id: string; doc: Record<string, unknown> }[] = [];
  for (const [recipient, copies] of byRecipient) {
    const chunks = chunkItems([...copies].map(([pe_id, box]) => ({ pe_id, box })));
    chunks.forEach((items, chunk) => {
      const id = mailboxPageId(input.batchHash, recipient, chunk);
      pages.push({
        id,
        doc: {
          id,
          to: recipient,
          from_device: input.deviceId,
          from_actor: input.actorId,
          batch_hash: input.batchHash,
          created_at_ms: input.nowMs,
          items: items.map((i) => ({ n: i.n, pe_id: i.pe_id, box: i.box })),
        },
      });
      staged += items.length;
    });
  }
  let pending = 0;
  for (const page of pages) {
    pending += await db.runTransaction(async txn => {
      const ack = await txn.get(db.collection(PE_MAILBOX_ACKS_COLLECTION).doc(page.id));
      const stored = await txn.get(db.collection(PE_MAILBOX_COLLECTION).doc(page.id));
      const batchRef = db.collection(METER_BATCHES_COLLECTION).doc(input.batchHash);
      const batch = (await txn.get(batchRef)).data();
      for (const snap of [ack, stored]) {
        if (snap.exists && (snap.data()?.from_device !== input.deviceId || snap.data()?.from_actor !== input.actorId)) {
          throw new Error('transit_sender_mismatch');
        }
      }
      const acknowledged = new Set<number>((ack.data()?.ns ?? []) as number[]);
      const items = (page.doc.items as MailboxPageItem[]).filter(it => !acknowledged.has(it.n));
      if (items.length > 0) {
        if (batch?.per_batch_pricing === true && batch.expire_at != null) txn.update(batchRef, { expire_at: null });
        txn.set(db.collection(PE_MAILBOX_COLLECTION).doc(page.id), { ...page.doc, items });
        txn.set(mailboxHeadRef(db, String(page.doc.to)), { version: randomUUID() });
      }
      return items.length;
    });
  }
  return { staged, refused, pending };
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

/**
 * Read a stored document as a page. A pre-page item document (no `items`) is a one-item page whose
 * item id is the document id. Null when the document is neither shape.
 */
export function readMailboxPage(id: string, data: Record<string, unknown> | undefined): { page: MailboxPage; legacy: boolean } | null {
  if (data === undefined) return null;
  const to = typeof data.to === 'string' ? data.to : null;
  const createdAt = typeof data.created_at_ms === 'number' ? data.created_at_ms : null;
  if (to === null || createdAt === null) return null;
  const head = {
    id,
    to,
    from_device: typeof data.from_device === 'string' ? data.from_device : '',
    from_actor: typeof data.from_actor === 'string' ? data.from_actor : '',
    batch_hash: typeof data.batch_hash === 'string' ? data.batch_hash : '',
    created_at_ms: createdAt,
  };
  if (Array.isArray(data.items)) {
    const items: MailboxPageItem[] = [];
    for (const raw of data.items as unknown[]) {
      if (isRecord(raw) && typeof raw.n === 'number' && Number.isSafeInteger(raw.n)
        && typeof raw.pe_id === 'string' && typeof raw.box === 'string') {
        items.push({ n: raw.n, pe_id: raw.pe_id, box: raw.box });
      }
    }
    return { page: { ...head, items }, legacy: false };
  }
  if (typeof data.pe_id !== 'string' || typeof data.box !== 'string') return null;
  return { page: { ...head, items: [{ n: 0, pe_id: data.pe_id, box: data.box }] }, legacy: true };
}

interface ListCursor {
  readonly createdAtMs: number;
  readonly pageId: string;
  /** Items of `pageId` at or before this position were already returned. */
  readonly n: number;
}

function encodeCursor(c: ListCursor): string {
  return `c1.${c.createdAtMs}.${c.pageId}.${c.n}`;
}

/** Null for an absent or unrecognised cursor (e.g. a pre-page item id): the list starts over, which is safe — clients file by item id. */
function decodeCursor(raw: string | null | undefined): ListCursor | null {
  if (!raw) return null;
  const m = CURSOR.exec(raw);
  if (m === null) return null;
  const createdAtMs = Number(m[1]);
  const n = Number(m[3]);
  if (!Number.isSafeInteger(createdAtMs) || !Number.isSafeInteger(n)) return null;
  return { createdAtMs, pageId: m[2], n };
}

/** A recipient's waiting items, oldest first, bounded. `afterId` is the previous answer's opaque `next`. */
export async function listMailbox(
  db: Firestore,
  recipient: string,
  options: { readonly limit: number; readonly afterId?: string | null },
): Promise<{ readonly items: MailboxItem[]; readonly next: string | null; readonly waiting?: number }> {
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit)));
  const want = limit + 1; // one past the page tells whether more wait
  const cursor = decodeCursor(options.afterId);
  const base = db.collection(PE_MAILBOX_COLLECTION)
    .where('to', '==', recipient)
    .orderBy('created_at_ms', 'asc')
    .orderBy('id', 'asc');

  const found: { item: MailboxItem; at: ListCursor }[] = [];
  let start: { createdAtMs: number; id: string; inclusive: boolean } | null = cursor === null
    ? null
    : { createdAtMs: cursor.createdAtMs, id: cursor.pageId, inclusive: true };
  let pageLimit = Math.min(want, LIST_FIRST_ROUND_PAGES);
  let pagesRead = 0;
  let exhausted = false;
  let lastScanned: ListCursor | null = null;
  for (let round = 0; round < LIST_MAX_ROUNDS && found.length < want; round += 1) {
    let query = base.limit(pageLimit);
    if (start !== null) {
      query = start.inclusive ? query.startAt(start.createdAtMs, start.id) : query.startAfter(start.createdAtMs, start.id);
    }
    const snap = await query.get();
    for (const doc of snap.docs) {
      const read = readMailboxPage(doc.id, doc.data());
      const createdAtMs = read?.page.created_at_ms ?? Number(doc.get('created_at_ms'));
      lastScanned = { createdAtMs: Number.isSafeInteger(createdAtMs) ? createdAtMs : 0, pageId: doc.id, n: PAGE_END_N };
      if (read === null) continue; // the query's `to ==` already scopes it to the recipient
      const page = read.page;
      for (const it of page.items) {
        if (cursor !== null && doc.id === cursor.pageId && it.n <= cursor.n) continue;
        found.push({
          item: {
            id: read.legacy ? page.id : mailboxPageItemId(page.id, it.n),
            to: page.to,
            pe_id: it.pe_id,
            box: it.box,
            from_device: page.from_device,
            from_actor: page.from_actor,
            batch_hash: page.batch_hash,
            created_at_ms: page.created_at_ms,
          },
          at: { createdAtMs: page.created_at_ms, pageId: page.id, n: it.n },
        });
      }
    }
    pagesRead += snap.docs.length;
    if (snap.docs.length < pageLimit) {
      exhausted = true;
      break;
    }
    const last = lastScanned;
    if (last === null) break;
    start = { createdAtMs: last.createdAtMs, id: last.pageId, inclusive: false };
    const perPage = Math.max(1, found.length / Math.max(1, pagesRead));
    pageLimit = Math.max(1, Math.min(want, Math.ceil((want - found.length) / perPage) + 1));
  }

  const out = found.slice(0, limit);
  let next: string | null = null;
  if (found.length > limit) {
    next = encodeCursor(out[out.length - 1].at);
  } else if (!exhausted && lastScanned !== null) {
    // Rounds ran out before the end: every item of the scanned pages was returned; resume after them.
    next = encodeCursor(lastScanned);
  }
  // The first page also says how many items wait in all, so the phone can show its progress while
  // it files a backlog. One page is the whole mailbox: no extra read.
  if (cursor === null) {
    const waiting = next === null ? out.length : await countMailbox(db, recipient);
    return { items: out.map((f) => f.item), next, waiting };
  }
  return { items: out.map((f) => f.item), next };
}

/** Pages one count reads per round (each holds up to ~0.7 MB of boxes; kept small to bound memory). */
const COUNT_PAGES_PER_ROUND = 10;
/** Pages one count reads at most; past this the count is a floor. */
const COUNT_MAX_PAGES = 1_000;

/** Every item waiting for `recipient` (a floor past COUNT_MAX_PAGES pages). Reads each page once. */
export async function countMailbox(db: Firestore, recipient: string): Promise<number> {
  const base = db.collection(PE_MAILBOX_COLLECTION)
    .where('to', '==', recipient)
    .orderBy('created_at_ms', 'asc')
    .orderBy('id', 'asc');
  let total = 0;
  let pages = 0;
  let start: { createdAtMs: number; id: string } | null = null;
  while (pages < COUNT_MAX_PAGES) {
    let query = base.limit(COUNT_PAGES_PER_ROUND);
    if (start !== null) query = query.startAfter(start.createdAtMs, start.id);
    const snap = await query.get();
    for (const doc of snap.docs) {
      const read = readMailboxPage(doc.id, doc.data());
      if (read !== null) total += read.page.items.length;
      const createdAtMs = read?.page.created_at_ms ?? Number(doc.get('created_at_ms'));
      start = { createdAtMs: Number.isSafeInteger(createdAtMs) ? createdAtMs : 0, id: doc.id };
    }
    pages += snap.docs.length;
    if (snap.docs.length < COUNT_PAGES_PER_ROUND) break;
  }
  return total;
}

/** Parse an item id into its page and position; `n` null = a pre-page item doc (the id is the doc id). */
function parseItemId(id: string): { pageId: string; n: number | null } | null {
  const dot = id.indexOf('.');
  if (dot < 0) return PAGE_ID.test(id) ? { pageId: id, n: null } : null;
  const pageId = id.slice(0, dot);
  const nText = id.slice(dot + 1);
  if (!PAGE_ID.test(pageId) || !/^\d{1,6}$/.test(nText)) return null;
  return { pageId, n: Number(nText) };
}

/**
 * The recipient filed these in its own storage: drop them. Only its own items can be dropped: a
 * page addressed to anyone else, an unknown id or a malformed one is ignored (not counted). A page
 * left empty is deleted; otherwise only the acknowledged items leave it.
 */
export async function ackMailbox(db: Firestore, recipient: string, ids: readonly string[]): Promise<number> {
  const byPage = new Map<string, { legacy: boolean; ns: Set<number> }>();
  for (const raw of new Set(ids.slice(0, 500).map(String))) {
    const parsed = parseItemId(raw);
    if (parsed === null) continue;
    let entry = byPage.get(parsed.pageId);
    if (entry === undefined) {
      entry = { legacy: false, ns: new Set() };
      byPage.set(parsed.pageId, entry);
    }
    if (parsed.n === null) entry.legacy = true;
    else entry.ns.add(parsed.n);
  }

  const dropPage = (pageId: string, wanted: { legacy: boolean; ns: Set<number> }): Promise<number> => {
    const ref = db.collection(PE_MAILBOX_COLLECTION).doc(pageId);
    return db.runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      if (!snap.exists) return 0;
      const read = readMailboxPage(pageId, snap.data());
      if (read === null || read.page.to !== recipient) return 0;
      const ackRef = db.collection(PE_MAILBOX_ACKS_COLLECTION).doc(pageId);
      const ack = await txn.get(ackRef);
      if (read.legacy) {
        if (!wanted.legacy) return 0;
        txn.delete(ref);
        return 1;
      }
      const keep = read.page.items.filter((it) => !wanted.ns.has(it.n));
      const dropped = read.page.items.length - keep.length;
      if (dropped === 0) return 0;
      const batchRef = db.collection(METER_BATCHES_COLLECTION).doc(read.page.batch_hash);
      const batch = (await txn.get(batchRef)).data();
      const siblings = batch?.per_batch_pricing === true && keep.length === 0
        ? await txn.get(db.collection(PE_MAILBOX_COLLECTION).where('batch_hash', '==', read.page.batch_hash)) : null;
      const noWaiting = keep.length === 0 && siblings !== null && siblings.docs.every(d => d.id === pageId);
      const ns = [...new Set<number>([
        ...((ack.data()?.ns ?? []) as number[]),
        ...read.page.items.filter(it => wanted.ns.has(it.n)).map(it => it.n),
      ])].sort((a, b) => a - b);
      txn.set(ackRef, { id: pageId, to: recipient, from_device: read.page.from_device,
        from_actor: read.page.from_actor, batch_hash: read.page.batch_hash, ns });
      if (batch?.per_batch_pricing === true && batch.anchored === true && batch.settlement_complete === true && noWaiting) {
        txn.update(batchRef, { expire_at: expireAt(Date.now() + METER_SETTLED_CLAIM_LIFETIME_MS) });
      }
      if (keep.length === 0) txn.delete(ref);
      else txn.update(ref, { items: keep.map((it) => ({ n: it.n, pe_id: it.pe_id, box: it.box })) });
      return dropped;
    });
  };

  let dropped = 0;
  const entries = [...byPage];
  for (let i = 0; i < entries.length; i += ACK_CONCURRENCY) {
    const counts = await Promise.all(entries.slice(i, i + ACK_CONCURRENCY).map(([pageId, wanted]) => dropPage(pageId, wanted)));
    dropped += counts.reduce((t, c) => t + c, 0);
  }
  return dropped;
}
