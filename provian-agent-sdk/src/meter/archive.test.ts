/**
 * Paid PE Archive — the device side: upload anchored days, drop only confirmed days
 * older than 30 days after reading them back, pull a dropped PE back and present it.
 *
 * Every guard ships its RED beside it : an Archive that is off or full drops nothing; a day
 * younger than 30 days is kept; an object that differs from the confirmed index, or that does not
 * match the PEs held here, drops nothing; no owner key here drops nothing; a drop plan that does not
 * match the store changes nothing; a crash mid-compaction is finished or discarded.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { x25519 } from '@noble/curves/ed25519';
import {
  actRecordOf,
  actsRootOf,
  batchLeafOf,
  METER_GENESIS_PREV_HASH,
  peHashOf,
  PE_V2_SCHEMA,
  utf8Bytes,
  verifyActInclusion,
  type PeV2,
} from '../meter-wire';
import { bytesToB64u, parseArchivePart, type ArchivePartHeader } from '../pe-archive-wire';
import { ArchiveKeeper, type ArchiveObjectAnswer, type ArchiveTransport } from './archive';
import { archiveCacheKey, FileArchiveObjectCache, MemoryArchiveObjectCache, type ArchiveObjectCache } from './archive-cache';
import { FsPeStore, MemoryPeStore, type PeStore, type StoredPeV2 } from './pe-store';
import { peFactFromStore } from './prove';
import type { MeterAnswer } from './transport';

const DEVICE = 'dev_' + 'c3'.repeat(32);
const ACTOR = 'agent_archive_actor';
const WALLET = 'aw_archive_owner';
const HUMAN = 'wallet_linked_human';
const OWNER_SECRET = new Uint8Array(32).fill(0x11);
const HUMAN_SECRET = new Uint8Array(32).fill(0x22);
const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 10, 20, 12); // 2026-11-20
const OLD_DAY_MS = Date.UTC(2026, 9, 1, 6); // 2026-10-01: 50 days old
const RECENT_DAY_MS = Date.UTC(2026, 10, 10, 6); // 2026-11-10: 10 days old

let rand = 1;
function deterministicRandom(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) { rand = (rand * 1103515245 + 12345) & 0x7fffffff; out[i] = rand & 0xff; }
  return out;
}

/** Append `count` PEs at `atMs`, batch them as `seq` accepted that day, and file a verified anchor proof. */
async function addAnchoredDay(store: PeStore, seq: number, atMs: number, count: number, tag = ''): Promise<StoredPeV2[]> {
  const head = await store.head();
  let prev = head.last_pe_hash;
  const pes: StoredPeV2[] = [];
  for (let i = 0; i < count; i++) {
    const base: PeV2 = {
      schema: PE_V2_SCHEMA, pe_id: `pe_${seq}_${i}`, device_id: DEVICE, prev_hash: prev,
      timestamp: atMs + i * 1000, action_type: 'agent_tool_orchestration',
      description: `turn ${seq}.${i}${tag}`, metadata: { tool_count: i + 1, turn_id: `tc:${seq}:${i}` }, compute: null,
    };
    const pe: StoredPeV2 = { ...base, pe_hash: peHashOf(base) };
    const r = await store.append(pe, { recordedAtMs: atMs });
    if (!r.ok) throw new Error(`append failed: ${r.reason}`);
    pes.push(pe);
    prev = pe.pe_hash;
  }
  const actsRoot = actsRootOf(pes.map(actRecordOf));
  const batchHash = seq.toString(16).padStart(2, '0').repeat(32);
  const priorBatch = await store.lastBatch();
  await store.recordBatch({
    seq, batch_hash: batchHash, prev_batch_hash: priorBatch?.batch_hash ?? METER_GENESIS_PREV_HASH, acts_root: actsRoot,
    first_index: head.count, count, last_pe_hash: prev, created_at_ms: atMs, accepted_at_ms: atMs + 60_000,
    actor_id: ACTOR, totals: null,
  }, null);
  const day = new Date(atMs).toISOString().slice(0, 10);
  await store.recordProof({
    seq, batch_hash: batchHash, acts_root: actsRoot, actor_id: ACTOR,
    batch_leaf: batchLeafOf({ device_id: DEVICE, actor_id: ACTOR, seq, batch_hash: batchHash, acts_root: actsRoot }),
    anchor: {
      day, anchor_batch_id: '0x' + '9'.repeat(64), leaf_index: 0, leaf_count: 1,
      leaf_hash: '0x' + '8'.repeat(64), proof: ['0x' + '7'.repeat(64)], merkle_root: '0x' + '6'.repeat(64),
      anchor_tx_hash: '0x' + '5'.repeat(64), anchored_at_ms: atMs + DAY_MS,
    },
    fetched_at_ms: atMs + DAY_MS,
    verified: true,
  });
  return pes;
}

interface FakePart { readonly line: string; readonly header: ArchivePartHeader; readonly sha256: string; confirmed: boolean }

/** The relay's `/v1/archive/device/*` surface in memory: space accounting, the 402s, confirmation. */
class FakeArchiveRelay implements ArchiveTransport {
  on = true;
  paidBytes = 1_000_000_000;
  usedBytes = 0;
  turnedOnAtMs: number | null = Date.UTC(2026, 8, 1);
  /** Parts are confirmed on store (their batches are anchored) unless this is false. */
  confirmOnStore = true;
  ownerPub = bytesToB64u(x25519.getPublicKey(OWNER_SECRET));
  readonly days = new Map<string, FakePart[]>();
  uploads = 0;
  /** Archive-class reads: each one pays retrieval + egress. */
  fetches = 0;
  /** Tamper hook: rewrite a stored object before it is served. */
  serve: (day: string, bytes: Uint8Array) => Uint8Array = (_d, b) => b;

  async getStatus(): Promise<MeterAnswer> {
    return {
      status: 200, error: null, body: {
        wallet: WALLET,
        archive: {
          on: this.on, paid_bytes: this.paidBytes, used_bytes: this.usedBytes,
          space_exhausted: this.on && this.usedBytes >= this.paidBytes, turned_on_at_ms: this.turnedOnAtMs,
        },
        recipients: [
          { party_id: WALLET, role: 'owner', pubkey_b64u: this.ownerPub },
          { party_id: HUMAN, role: 'linked_human', pubkey_b64u: bytesToB64u(x25519.getPublicKey(HUMAN_SECRET)) },
        ],
      },
    };
  }

  async uploadPart(line: string): Promise<MeterAnswer> {
    this.uploads += 1;
    if (!this.on) return { status: 402, error: 'off', body: { error: 'archive_not_on' } };
    const bytes = utf8Bytes(line);
    const parsed = parseArchivePart(bytes);
    if (!parsed.ok) return { status: 400, error: parsed.error, body: { error: parsed.error } };
    const parts = this.days.get(parsed.header.day) ?? [];
    const same = parts.find((p) => p.header.device_id === parsed.header.device_id && p.header.part === parsed.header.part);
    if (same) return same.sha256 === parsed.sha256 ? { status: 200, error: null, body: { stored: true } } : { status: 409, error: 'conflict', body: { error: 'archive_part_conflict' } };
    if (this.usedBytes + bytes.length > this.paidBytes) {
      return { status: 402, error: 'full', body: { error: 'archive_space_exhausted' } };
    }
    this.usedBytes += bytes.length;
    parts.push({ line, header: parsed.header, sha256: parsed.sha256, confirmed: this.confirmOnStore });
    this.days.set(parsed.header.day, parts);
    return { status: 201, error: null, body: { stored: true } };
  }

  async listDays(): Promise<MeterAnswer> {
    const days = [...this.days.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, parts]) => ({
      day,
      confirmed: parts.every((p) => p.confirmed),
      parts: parts.map((p) => ({
        device_id: p.header.device_id, part: p.header.part, sha256: p.sha256, confirmed: p.confirmed, state: 'stored',
        batches: p.header.batches.map((b) => ({ seq: b.seq, batch_hash: b.batch_hash, first_index: b.first_index, count: b.count })),
      })),
    }));
    return { status: 200, error: null, body: { days, next_after: null } };
  }

  async getDayObject(day: string): Promise<ArchiveObjectAnswer> {
    this.fetches += 1;
    const parts = this.days.get(day);
    if (!parts) return { status: 404, bytes: null, error: 'archive_day_not_found' };
    return { status: 200, bytes: this.serve(day, utf8Bytes(parts.map((p) => p.line).join(''))), error: null };
  }
}

function keeperFor(store: PeStore, relay: FakeArchiveRelay, secret: Uint8Array | null = OWNER_SECRET, objectCache: ArchiveObjectCache | null = null): ArchiveKeeper {
  return new ArchiveKeeper({
    store, transport: relay, now: () => NOW, randomBytes: deterministicRandom,
    messageSecretKey: async () => (secret === null ? null : new Uint8Array(secret)),
    objectCache,
  });
}

async function twoDays(store: PeStore): Promise<{ old: StoredPeV2[]; recent: StoredPeV2[] }> {
  const old = await addAnchoredDay(store, 1, OLD_DAY_MS, 3);
  const recent = await addAnchoredDay(store, 2, RECENT_DAY_MS, 2);
  return { old, recent };
}

function fsStore(): { store: FsPeStore; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-archive-'));
  return { store: new FsPeStore(DEVICE, root), root };
}

describe('ArchiveKeeper — upload, confirm, drop the confirmed day older than 30 days', () => {
  it('uploads both anchored days sealed to the owner and the linked human, and drops only the 50-day-old one', async () => {
    const { store } = fsStore();
    const { old, recent } = await twoDays(store);
    const relay = new FakeArchiveRelay();
    const report = await keeperFor(store, relay).run();
    expect(report).toMatchObject({ state: 'ran', uploaded_days: 2, dropped_days: 1, dropped_pes: 3, space_exhausted: false });
    // Sealed to both parties: each party opens with its own key.
    const part = relay.days.get('2026-10-01')![0];
    expect(part.header.recipients.map((r) => r.party_id).sort()).toEqual([HUMAN, WALLET].sort());
    // The old day's PEs are pointers now; the recent day stays whole.
    for (const pe of old) {
      expect(await store.findPe(pe.pe_id)).toBeNull();
      expect(await store.findArchived(pe.pe_id)).toMatchObject({ day: '2026-10-01', wallet: WALLET, pe_hash: pe.pe_hash });
    }
    for (const pe of recent) expect((await store.findPe(pe.pe_id))?.pe).toEqual(pe);
    expect((await store.listArchivedDays()).map((d) => d.day)).toEqual(['2026-10-01']);
    // The chain head never moved, and a fresh process reads the same head and keeps appending.
    const reopened = new FsPeStore(DEVICE, store.location.slice(0, -DEVICE.length - 1));
    expect(await reopened.head()).toEqual(await store.head());
    const more = await addAnchoredDay(reopened, 3, NOW - DAY_MS, 1);
    expect((await reopened.findPe(more[0].pe_id))?.pe).toEqual(more[0]);
    // Running again uploads nothing new for the old days and drops nothing twice.
    const again = await keeperFor(reopened, relay).run();
    expect(again.dropped_pes).toBe(0);
  });

  it('pulls a dropped PE back from the Archive and it presents like a local one (both proof hops intact)', async () => {
    const { store } = fsStore();
    const { old } = await twoDays(store);
    const relay = new FakeArchiveRelay();
    const keeper = keeperFor(store, relay);
    await keeper.run();
    expect(await store.findPe(old[1].pe_id)).toBeNull();
    const fresh = keeperFor(store, relay); // nothing cached: the day is pulled
    const r = await peFactFromStore(store, `${old[1].pe_id}:${old[1].pe_hash}`, fresh);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fact.pe).toEqual(old[1]);
    expect(r.fact.inclusion.anchor?.day).toBe('2026-10-01');
    expect(verifyActInclusion(r.fact.pe, r.fact.inclusion).ok).toBe(true);
    // RED: without the archive source, the dropped PE is reported, never silently missing.
    expect(await peFactFromStore(store, old[1].pe_id)).toMatchObject({ ok: false, reason: 'archived_unavailable' });
    // RED: a wrong hash for a dropped PE is refused before any pull.
    expect(await peFactFromStore(store, `${old[1].pe_id}:${'0'.repeat(64)}`, fresh)).toMatchObject({ ok: false, reason: 'envelope_hash_mismatch' });
  });

  it('a linked human opens the same day with their own key; a stranger cannot', async () => {
    const store = new MemoryPeStore(DEVICE, 'memory');
    await twoDays(store);
    const relay = new FakeArchiveRelay();
    await keeperFor(store, relay).run();
    const human = keeperFor(store, relay, HUMAN_SECRET);
    const asHuman = await human.pullDay('2026-10-01', HUMAN);
    expect(asHuman.ok).toBe(true);
    const stranger = keeperFor(store, relay, new Uint8Array(32).fill(0x33));
    expect(await stranger.pullDay('2026-10-01', HUMAN)).toMatchObject({ ok: false });
  });
});

describe('ArchiveKeeper — RED: nothing is deleted unless the day is confirmed, read back and matched', () => {
  async function heldEverything(store: PeStore, pes: readonly StoredPeV2[]): Promise<void> {
    for (const pe of pes) expect((await store.findPe(pe.pe_id))?.pe).toEqual(pe);
    expect((await store.listArchivedDays?.()) ?? []).toEqual([]);
  }

  it('RED: an Archive that is OFF (never paid) uploads nothing and drops nothing', async () => {
    const { store } = fsStore();
    const { old, recent } = await twoDays(store);
    const relay = new FakeArchiveRelay();
    relay.on = false;
    relay.paidBytes = 0;
    const report = await keeperFor(store, relay).run();
    expect(report).toMatchObject({ state: 'off', uploaded_days: 0, dropped_days: 0, dropped_pes: 0 });
    expect(relay.uploads).toBe(0);
    await heldEverything(store, [...old, ...recent]);
  });

  it('RED: an EXHAUSTED Archive (paid space used up, next GB unpaid) keeps every new day here and drops nothing of it', async () => {
    const { store } = fsStore();
    const { old, recent } = await twoDays(store);
    const relay = new FakeArchiveRelay();
    relay.paidBytes = 10; // smaller than any sealed part
    const report = await keeperFor(store, relay).run();
    expect(report).toMatchObject({ state: 'ran', uploaded_days: 0, dropped_days: 0, dropped_pes: 0, space_exhausted: true });
    expect(relay.days.size).toBe(0);
    await heldEverything(store, [...old, ...recent]);
    expect(await store.archiveState()).toMatchObject({ on: true, space_exhausted: true });
    // The sealed part waits in the outbox; once the next GB is paid it goes and the day drops.
    relay.paidBytes = 1_000_000_000;
    const paid = await keeperFor(store, relay).run();
    expect(paid).toMatchObject({ uploaded_days: 2, dropped_days: 1, dropped_pes: 3, space_exhausted: false });
  });

  it('RED: a day stored but NOT confirmed (a batch not anchored yet) is not dropped', async () => {
    const { store } = fsStore();
    const { old, recent } = await twoDays(store);
    const relay = new FakeArchiveRelay();
    relay.confirmOnStore = false;
    const report = await keeperFor(store, relay).run();
    expect(report).toMatchObject({ uploaded_days: 2, dropped_days: 0 });
    await heldEverything(store, [...old, ...recent]);
  });

  it('RED: a confirmed day younger than 30 days is never dropped', async () => {
    const { store } = fsStore();
    const recent = await addAnchoredDay(store, 1, Date.UTC(2026, 9, 22, 6), 2); // 29 days before NOW
    const relay = new FakeArchiveRelay();
    const report = await keeperFor(store, relay).run();
    expect(report).toMatchObject({ uploaded_days: 1, dropped_days: 0 });
    await heldEverything(store, recent);
  });

  it('RED: an object that differs from the confirmed index, or that opens to different PEs, drops nothing', async () => {
    const { store } = fsStore();
    const { old } = await twoDays(store);
    const relay = new FakeArchiveRelay();
    relay.serve = () => utf8Bytes('{"tampered":true}\n');
    const first = await keeperFor(store, relay).run();
    expect(first.dropped_days).toBe(0);
    await heldEverything(store, old);
    // A part re-sealed from DIFFERENT PEs under the same confirmed sha is impossible to fake (the
    // sha would differ); a confirmed index whose sha does not match the object is refused:
    relay.serve = (_d, b) => b;
    const stored = relay.days.get('2026-10-01')!;
    relay.days.set('2026-10-01', [{ ...stored[0], sha256: 'f'.repeat(64) }]);
    const second = await keeperFor(store, relay).run();
    expect(second.dropped_days).toBe(0);
    expect(second.detail).toBe('archive_object_differs_from_confirmed_index');
    await heldEverything(store, old);
  });

  it('RED: without the owner key on this machine, days are not verified and nothing is dropped', async () => {
    const { store } = fsStore();
    const { old } = await twoDays(store);
    const relay = new FakeArchiveRelay();
    await keeperFor(store, relay).run(); // uploaded and dropped with the key...
    const { store: other } = fsStore();
    const otherPes = await twoDays(other);
    // ...but a machine without the key never drops (it also refuses to upload without a published key check).
    const report = await keeperFor(other, relay, null).run();
    expect(report.dropped_days).toBe(0);
    await heldEverything(other, otherPes.old);
    expect(old.length).toBe(3);
  });

  it('RED: a relay publishing a different owner key gets no upload at all', async () => {
    const { store } = fsStore();
    await twoDays(store);
    const relay = new FakeArchiveRelay();
    relay.ownerPub = bytesToB64u(x25519.getPublicKey(new Uint8Array(32).fill(0x44)));
    const report = await keeperFor(store, relay).run();
    expect(report).toMatchObject({ uploaded_days: 0, dropped_days: 0, detail: 'owner_key_unavailable' });
    expect(relay.uploads).toBe(0);
  });
});

describe('FsPeStore.dropArchivedDay — the only path that removes a PE\'s content', () => {
  it('RED: a plan naming a PE that is not the one held changes NOTHING (byte-identical file)', async () => {
    const { store } = fsStore();
    const pes = await addAnchoredDay(store, 1, OLD_DAY_MS, 3);
    const file = path.join(store.location, 'pes.jsonl');
    const before = fs.readFileSync(file);
    await expect(store.dropArchivedDay({
      day: '2026-10-01', wallet: WALLET, part_sha256s: ['a'.repeat(64)],
      pes: [{ index: 0, pe_id: pes[0].pe_id, pe_hash: pes[0].pe_hash }, { index: 1, pe_id: pes[1].pe_id, pe_hash: 'e'.repeat(64) }],
    })).rejects.toThrow(/pe_store_archive_drop_mismatch/);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    await expect(store.dropArchivedDay({
      day: '2026-10-01', wallet: WALLET, part_sha256s: [], pes: [{ index: 9, pe_id: 'pe_nope', pe_hash: 'e'.repeat(64) }],
    })).rejects.toThrow(/pe_store_archive_drop_mismatch/);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it('keeps every undropped line byte for byte, and is idempotent', async () => {
    const { store } = fsStore();
    const pes = await addAnchoredDay(store, 1, OLD_DAY_MS, 3);
    const file = path.join(store.location, 'pes.jsonl');
    const beforeLines = fs.readFileSync(file, 'utf8').split('\n');
    const plan = { day: '2026-10-01', wallet: WALLET, part_sha256s: ['a'.repeat(64)], pes: [{ index: 1, pe_id: pes[1].pe_id, pe_hash: pes[1].pe_hash }] };
    expect(await store.dropArchivedDay(plan)).toEqual({ dropped: 1 });
    const afterLines = fs.readFileSync(file, 'utf8').split('\n');
    expect(afterLines[0]).toBe(beforeLines[0]);
    expect(afterLines[2]).toBe(beforeLines[2]);
    expect(afterLines[1]).not.toContain('"description"');
    expect(await store.dropArchivedDay(plan)).toEqual({ dropped: 0 });
    expect(await store.listArchivedDays()).toHaveLength(1);
  });

  it('a crash after the compact file was written but before the rename is finished on the next open; a torn compact file is discarded', async () => {
    const { store, root } = fsStore();
    const pes = await addAnchoredDay(store, 1, OLD_DAY_MS, 3);
    const file = path.join(store.location, 'pes.jsonl');
    const original = fs.readFileSync(file);
    await store.dropArchivedDay({ day: '2026-10-01', wallet: WALLET, part_sha256s: [], pes: [{ index: 0, pe_id: pes[0].pe_id, pe_hash: pes[0].pe_hash }] });
    const compacted = fs.readFileSync(file);
    // Simulate the crash window: head already records the compacted size, pes.jsonl is still the original.
    fs.writeFileSync(path.join(store.location, 'pes.jsonl.compact'), compacted);
    fs.writeFileSync(file, original);
    const reopened = new FsPeStore(DEVICE, root);
    expect(await reopened.head()).toEqual({ count: 3, last_pe_hash: pes[2].pe_hash });
    expect(fs.readFileSync(file).equals(compacted)).toBe(true);
    expect(fs.existsSync(path.join(store.location, 'pes.jsonl.compact'))).toBe(false);
    expect(await reopened.findPe(pes[0].pe_id)).toBeNull();
    // RED: a compact file whose size the head never recorded (crash before the head update) is discarded.
    fs.writeFileSync(path.join(store.location, 'pes.jsonl.compact'), compacted.subarray(0, 10));
    const again = new FsPeStore(DEVICE, root);
    expect(await again.head()).toEqual({ count: 3, last_pe_hash: pes[2].pe_hash });
    expect(fs.readFileSync(file).equals(compacted)).toBe(true);
    expect(fs.existsSync(path.join(store.location, 'pes.jsonl.compact'))).toBe(false);
  });
});

describe('ArchiveKeeper — one pull-back serves repeated use (the pull-back cache)', () => {
  const OLD_DAY = '2026-10-01';
  const KEY = archiveCacheKey(WALLET, OLD_DAY);

  class CountingCache extends MemoryArchiveObjectCache {
    puts = 0;
    override async put(key: string, bytes: Uint8Array): Promise<void> {
      this.puts += 1;
      await super.put(key, bytes);
    }
  }

  /** The old day uploaded, confirmed and dropped (by a keeper with no cache); fetch counter reset. */
  async function droppedOldDay(): Promise<{ store: FsPeStore; relay: FakeArchiveRelay; old: StoredPeV2[] }> {
    const { store } = fsStore();
    const { old } = await twoDays(store);
    const relay = new FakeArchiveRelay();
    expect(await keeperFor(store, relay).run()).toMatchObject({ dropped_days: 1, dropped_pes: 3 });
    expect(await store.findPe(old[1].pe_id)).toBeNull();
    relay.fetches = 0;
    return { store, relay, old };
  }

  function cacheDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pe-archive-cache-'));
  }

  it('two keepers (two CLI invocations) sharing the file cache present the same archived PE with ONE Archive read; the file is the served ciphertext', async () => {
    const { store, relay, old } = await droppedOldDay();
    const dir = cacheDir();
    const ref = `${old[1].pe_id}:${old[1].pe_hash}`;
    const first = await peFactFromStore(store, ref, keeperFor(store, relay, OWNER_SECRET, new FileArchiveObjectCache(dir)));
    const second = await peFactFromStore(store, ref, keeperFor(store, relay, OWNER_SECRET, new FileArchiveObjectCache(dir)));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.fact.pe).toEqual(old[1]);
    expect(verifyActInclusion(second.fact.pe, second.fact.inclusion).ok).toBe(true);
    expect(relay.fetches).toBe(1);
    // What sits on disk is exactly what the Archive served (sealed), never the opened PEs.
    const onDisk = fs.readFileSync(new FileArchiveObjectCache(dir).fileFor(KEY));
    expect(onDisk.equals(Buffer.from((await relay.getDayObject(OLD_DAY)).bytes!))).toBe(true);
    expect(onDisk.toString('utf8')).not.toContain('turn 1.1');
    expect(onDisk.toString('utf8')).not.toContain(old[1].pe_id);
  });

  it('RED: the same two invocations with no cache read the Archive twice', async () => {
    const { store, relay, old } = await droppedOldDay();
    const ref = `${old[1].pe_id}:${old[1].pe_hash}`;
    expect((await peFactFromStore(store, ref, keeperFor(store, relay))).ok).toBe(true);
    expect((await peFactFromStore(store, ref, keeperFor(store, relay))).ok).toBe(true);
    expect(relay.fetches).toBe(2);
  });

  /** A valid owner-sealed object for the old day whose part sha256s differ from `relay`'s index. */
  async function otherSealingOfOldDay(tag = ''): Promise<Uint8Array> {
    const { store: other } = fsStore();
    await addAnchoredDay(other, 1, OLD_DAY_MS, 3, tag);
    const relay2 = new FakeArchiveRelay();
    relay2.confirmOnStore = false; // upload only
    await keeperFor(other, relay2).run();
    return (await relay2.getDayObject(OLD_DAY)).bytes!;
  }

  it('the drop path ignores a cached object whose part sha256s differ from the confirmed index and fetches fresh', async () => {
    const { store } = fsStore();
    const { old } = await twoDays(store);
    const relay = new FakeArchiveRelay();
    relay.confirmOnStore = false;
    await keeperFor(store, relay).run(); // uploaded, not confirmed: nothing dropped, nothing fetched
    for (const p of relay.days.get(OLD_DAY)!) p.confirmed = true;
    const cache = new CountingCache();
    const stale = await otherSealingOfOldDay();
    await cache.put(KEY, stale);
    relay.fetches = 0;
    const report = await keeperFor(store, relay, OWNER_SECRET, cache).run();
    expect(report).toMatchObject({ dropped_days: 1, dropped_pes: 3 });
    expect(relay.fetches).toBe(1);
    expect(await store.findPe(old[0].pe_id)).toBeNull();
    // The stale copy stayed as it was (the drop path writes nothing).
    expect(Buffer.from((await cache.get(KEY))!).equals(Buffer.from(stale))).toBe(true);
  });

  it('RED: a cached object matching the confirmed index serves the drop path with ZERO Archive reads', async () => {
    const { store } = fsStore();
    const { old } = await twoDays(store);
    const relay = new FakeArchiveRelay();
    relay.confirmOnStore = false;
    await keeperFor(store, relay).run();
    for (const p of relay.days.get(OLD_DAY)!) p.confirmed = true;
    const cache = new CountingCache();
    await cache.put(KEY, (await relay.getDayObject(OLD_DAY)).bytes!);
    relay.fetches = 0;
    const report = await keeperFor(store, relay, OWNER_SECRET, cache).run();
    expect(report).toMatchObject({ dropped_days: 1, dropped_pes: 3 });
    expect(relay.fetches).toBe(0);
    expect(await store.findPe(old[0].pe_id)).toBeNull();
  });

  it('the drop path never writes the day it drops into the cache (fill: false)', async () => {
    const { store } = fsStore();
    const { old } = await twoDays(store);
    const relay = new FakeArchiveRelay();
    const cache = new CountingCache();
    const report = await keeperFor(store, relay, OWNER_SECRET, cache).run();
    expect(report).toMatchObject({ dropped_days: 1, dropped_pes: 3 });
    expect(relay.fetches).toBe(1);
    expect(cache.puts).toBe(0);
    expect(cache.objects.size).toBe(0);
    // RED: a presentation afterwards (fill by default) does write it — the counter sees puts.
    expect((await peFactFromStore(store, `${old[0].pe_id}:${old[0].pe_hash}`, keeperFor(store, relay, OWNER_SECRET, cache))).ok).toBe(true);
    expect(cache.puts).toBe(1);
    expect(cache.objects.has(KEY)).toBe(true);
  });

  it('a corrupted cached file falls back to a fresh fetch, still opens, and the cache is repaired', async () => {
    const { store, relay, old } = await droppedOldDay();
    const dir = cacheDir();
    const cache = new FileArchiveObjectCache(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cache.fileFor(KEY), '{"not":"a sealed part"}\n');
    const r = await peFactFromStore(store, `${old[2].pe_id}:${old[2].pe_hash}`, keeperFor(store, relay, OWNER_SECRET, cache));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fact.pe).toEqual(old[2]);
    expect(relay.fetches).toBe(1);
    expect(fs.readFileSync(cache.fileFor(KEY)).equals(Buffer.from((await relay.getDayObject(OLD_DAY)).bytes!))).toBe(true);
    // A torn (truncated) cached object is likewise not used.
    const good = fs.readFileSync(cache.fileFor(KEY));
    fs.writeFileSync(cache.fileFor(KEY), good.subarray(0, Math.floor(good.length / 2)));
    relay.fetches = 0;
    expect((await peFactFromStore(store, `${old[0].pe_id}:${old[0].pe_hash}`, keeperFor(store, relay, OWNER_SECRET, cache))).ok).toBe(true);
    expect(relay.fetches).toBe(1);
  });

  it('a cached day that opens but no longer matches the PE\'s pointer is re-fetched once; RED: the same stale object from the Archive is a mismatch', async () => {
    const { store, relay, old } = await droppedOldDay();
    const cache = new MemoryArchiveObjectCache();
    const stale = await otherSealingOfOldDay(' (other)'); // same pe ids, different PEs
    await cache.put(KEY, stale);
    const ref = `${old[1].pe_id}:${old[1].pe_hash}`;
    const r = await peFactFromStore(store, ref, keeperFor(store, relay, OWNER_SECRET, cache));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fact.pe).toEqual(old[1]);
    expect(relay.fetches).toBe(1);
    // RED: when the Archive itself serves that object, the pointer check refuses it.
    const staleRelay = new FakeArchiveRelay();
    staleRelay.serve = () => stale;
    staleRelay.days.set(OLD_DAY, relay.days.get(OLD_DAY)!);
    expect(await keeperFor(store, staleRelay).findArchivedPe(old[1].pe_id)).toMatchObject({ ok: false, reason: 'archive_entry_mismatch' });
  });
});
