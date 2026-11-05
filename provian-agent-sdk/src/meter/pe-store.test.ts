/**
 * PE meter — the device's own PE store, the PE v2 builder, and the client's record path
 * (: a PE lives with its owner and is never deleted).
 *
 * Every guard here ships its RED control beside it : a chain that does not continue is
 * refused, a torn write is healed but a corrupt one is not, a live lock is never robbed, a
 * resubmitted key never records twice, a failing mirror never blocks the record.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProvianClient } from '../ProvianClient';
import { SUBMIT_OBSERVED_PE, QUEUE_OBSERVED_PE } from '../observed-submit';
import {
  actRecordOf,
  canonicalJson,
  hardwareNonceOfAct,
  METER_GENESIS_PREV_HASH,
  peHashOf,
  PE_V2_SCHEMA,
  type PeV2,
} from '../meter-wire';
import { FsPeStore, MemoryPeStore, PeStoreCorruptError, defaultPeStoreRoot, type StoredPeV2 } from './pe-store';
import {openPrivatePricing} from '../../../provian-backend/src/core/meter/private-pricing';
import { buildPeV2, peContentFromV1Body } from './pe-builder';
import { tryAcquireFileLock, removeJudgedLock, unlinkIfStill, clearAbandonedGuard, UNREADABLE_GRACE_MS, TAKEOVER_GUARD_STALE_MS } from './file-lock';
import { migrateLegacyOutbox, migrationKeyOf } from './migrate-outbox';
import { PeOutbox } from '../pe-outbox';
import { TEST_DEVICE_ID } from './capturing-store.test-support';
import type { HardwareWitnessInput } from '../hardware-witness';

const DEVICE = { relayUrl: 'https://relay.test', deviceKey: 'pdk_' + 'a'.repeat(32), deviceSecret: 'pds_' + 'b'.repeat(64) };

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pe-store-'));
}

function fsClient(root: string, extra: Record<string, unknown> = {}): ProvianClient {
  return new ProvianClient({ ...DEVICE, deviceId: TEST_DEVICE_ID, peStoreRoot: root, ...extra });
}

async function record(client: ProvianClient, n: number, prefix = 'step'): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = await client[SUBMIT_OBSERVED_PE]({ actionType: 'agent_tool_orchestration', success: true, metadata: { tool_count: i + 1, turn: `${prefix}-${i}` } });
    if (!r || !('pe_id' in r)) throw new Error('not recorded');
    ids.push(r.pe_id);
  }
  return ids;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('PE v2 chain — built, hashed and chained on the device, kept across a restart', () => {
  it('records a hash-chained PE v2 per observation, with no network at all', async () => {
    const fetchSpy = vi.fn(async () => { throw new TypeError('offline'); });
    vi.stubGlobal('fetch', fetchSpy);
    const root = tmpRoot();
    const client = fsClient(root);
    const ids = await record(client, 3);
    expect(fetchSpy).not.toHaveBeenCalled();
    const store = await client.getPeStore();
    expect(store.location).toBe(path.join(root, TEST_DEVICE_ID));
    const pes = await store.readPes(0, 10);
    expect(pes.map((p) => p.pe.pe_id)).toEqual(ids);
    expect(pes[0].pe.prev_hash).toBe(METER_GENESIS_PREV_HASH);
    for (let i = 0; i < pes.length; i++) {
      const pe = pes[i].pe;
      expect(pe.schema).toBe(PE_V2_SCHEMA);
      expect(pe.device_id).toBe(TEST_DEVICE_ID);
      expect(pe.pe_id).toMatch(/^pe_[0-9a-f]{24}$/);
      expect(pe.pe_hash).toBe(peHashOf(pe));
      if (i > 0) expect(pe.prev_hash).toBe(pes[i - 1].pe.pe_hash);
    }
    expect((await store.head()).last_pe_hash).toBe(pes[2].pe.pe_hash);
  });

  it('survives a restart: a fresh process reads the same chain and continues it from the persisted head', async () => {
    const root = tmpRoot();
    await record(fsClient(root), 2, 'first-run');
    // "Restart": a new client and a new store instance over the same directory.
    const second = fsClient(root);
    await record(second, 1, 'second-run');
    const reread = new FsPeStore(TEST_DEVICE_ID, root);
    const pes = await reread.readPes(0, 10);
    expect(pes).toHaveLength(3);
    expect(pes[2].pe.prev_hash).toBe(pes[1].pe.pe_hash);
    expect(pes.every((p) => p.pe.pe_hash === peHashOf(p.pe))).toBe(true);
    expect(fs.statSync(reread.pesFile).mode & 0o777).toBe(0o600);
  });

  it('carries the v1 fields (cited_pe_ids dropped) and keeps description out of the act record', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const client = new ProvianClient({ ...DEVICE, peStore: store });
    await client[SUBMIT_OBSERVED_PE]({
      actionType: 'coding_session', description: 'Structural coding_session record (3 files, 40 lines)', success: true,
      metadata: { commit_sha: 'abc' }, compute: null, cited_pe_ids: ['pe_old'], parent_goal_pe_id: 'pe_goal',
      output_digests: [{ hash: 'sha256:' + 'e'.repeat(64), kind: 'commit' }],
    });
    const [stored] = await store.readPes(0, 1);
    expect(stored.pe.description).toBe('Structural coding_session record (3 files, 40 lines)');
    expect('cited_pe_ids' in stored.pe).toBe(false);
    expect(stored.pe.parent_goal_pe_id).toBe('pe_goal');
    expect(stored.pe.metadata).toEqual({ commit_sha: 'abc', success: true });
    const act = actRecordOf(stored.pe);
    expect('description' in act.pricing).toBe(false); // free text never reaches the relay
    expect(openPrivatePricing(act,String(stored.pe.private_commitment)).metadata).toEqual({ commit_sha: 'abc', success: true });
    expect(JSON.stringify(act)).not.toContain('commit_sha');
  });

  it('keeps the description pre-validation: a refused description records nothing', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const client = new ProvianClient({ ...DEVICE, peStore: store });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await client[SUBMIT_OBSERVED_PE]({ actionType: 'coding_session', description: 'too short', success: true })).toBeNull();
    expect((await store.head()).count).toBe(0);
  });

  it('refuses content that cannot be hashed canonically (a non-finite number) — never recorded, reported "rejected"', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const client = new ProvianClient({ ...DEVICE, peStore: store });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await client[SUBMIT_OBSERVED_PE]({ actionType: 'compute_session', success: true, metadata: { load: Number.NaN } })).toBeNull();
    expect(client.lastSubmitOutcome).toBe('rejected');
    expect((await store.head()).count).toBe(0);
  });

  it('a resubmission under the same idempotency key answers with the PE already recorded — also after a restart', async () => {
    const root = tmpRoot();
    const key = 'pe_turn_key_0000000001';
    const first = await fsClient(root)[SUBMIT_OBSERVED_PE]({ actionType: 'agent_tool_orchestration', success: true, idempotencyKey: key });
    const again = await fsClient(root)[SUBMIT_OBSERVED_PE]({ actionType: 'agent_tool_orchestration', success: true, idempotencyKey: key });
    expect(first && 'pe_id' in first ? first.pe_id : null).toBe(again && 'pe_id' in again ? again.pe_id : 'x');
    expect(again && 'idempotent_replay' in again ? again.idempotent_replay : false).toBe(true);
    expect((await new FsPeStore(TEST_DEVICE_ID, root).head()).count).toBe(1);
    // RED control: a different key is a different PE.
    await fsClient(root)[SUBMIT_OBSERVED_PE]({ actionType: 'agent_tool_orchestration', success: true, idempotencyKey: 'pe_turn_key_0000000002' });
    expect((await new FsPeStore(TEST_DEVICE_ID, root).head()).count).toBe(2);
  });

  it('QUEUE_OBSERVED_PE (the shutdown path) records the same way and says true only when on disk', async () => {
    const root = tmpRoot();
    const client = fsClient(root);
    expect(await client[QUEUE_OBSERVED_PE]({ actionType: 'agent_tool_orchestration', success: true })).toBe(true);
    expect((await new FsPeStore(TEST_DEVICE_ID, root).head()).count).toBe(1);
    expect(await client[QUEUE_OBSERVED_PE]({ actionType: 'agent_tool_orchestration', description: 'nope', success: true })).toBe(false);
  });

  it('the default store lives under PROVIAN_PE_STORE_DIR, one directory per device id', () => {
    expect(defaultPeStoreRoot({ PROVIAN_PE_STORE_DIR: '/srv/pe' }, '/home/x')).toBe('/srv/pe');
    expect(defaultPeStoreRoot({}, '/home/x')).toBe(path.join('/home/x', '.provian', 'pe-store'));
    expect(new FsPeStore('dev_one', '/srv/pe').location).toBe(path.join('/srv/pe', 'dev_one'));
    expect(() => new FsPeStore('../escape', '/srv/pe')).toThrow(/device_id_invalid/);
  });

  it('a store for a different device than the credentials is refused', async () => {
    const client = new ProvianClient({ ...DEVICE, deviceId: 'dev_a', peStore: new MemoryPeStore('dev_b') });
    await expect(client.getPeStore()).rejects.toThrow(/belongs to device dev_b/);
  });

  it('a device whose credentials carry no id learns it once from the relay tip', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ device_id: 'dev_from_tip', seq: 0 }), { status: 200 })));
    const root = tmpRoot();
    const client = new ProvianClient({ ...DEVICE, peStoreRoot: root });
    expect((await client.getPeStore()).deviceId).toBe('dev_from_tip');
    // RED control: a relay that cannot say → nothing recorded, reported as failed (not dropped silently).
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const orphan = new ProvianClient({ ...DEVICE, peStoreRoot: root });
    expect(await orphan[SUBMIT_OBSERVED_PE]({ actionType: 'compute_session', success: true })).toBeNull();
    expect(orphan.lastSubmitOutcome).toBe('failed');
  });
});

describe('the store refuses anything that does not continue the chain', () => {
  async function pe(store: MemoryPeStore | FsPeStore, overrides: Partial<StoredPeV2> = {}): Promise<StoredPeV2> {
    const head = await store.head();
    const built = await buildPeV2({
      content: { action_type: 'compute_session', metadata: {}, compute: null, geo: null, execution_env: null, parent_goal_pe_id: null },
      deviceId: store.deviceId, prevHash: head.last_pe_hash, timestampMs: 1_790_000_000_000, peId: `pe_${String(head.count).padStart(24, '0')}`,
    });
    return { ...built, ...overrides };
  }

  for (const kind of ['memory', 'fs'] as const) {
    it(`${kind}: a stale prev_hash is head_moved; a wrong hash or device is invalid (RED controls)`, async () => {
      const store = kind === 'memory' ? new MemoryPeStore(TEST_DEVICE_ID) : new FsPeStore(TEST_DEVICE_ID, tmpRoot());
      const first = await pe(store);
      expect((await store.append(first)).ok).toBe(true);
      const stale = await pe(store, { prev_hash: METER_GENESIS_PREV_HASH });
      const r1 = await store.append(stale);
      expect(r1.ok === false && r1.reason).toBe('head_moved');
      const forged = await pe(store, { pe_hash: 'f'.repeat(64) });
      const r2 = await store.append(forged);
      expect(r2.ok === false && r2.reason === 'invalid' && r2.detail).toBe('pe_hash_mismatch');
      const foreign = await pe(store);
      const r3 = await store.append({ ...foreign, device_id: 'dev_other', pe_hash: peHashOf({ ...foreign, device_id: 'dev_other' }) });
      expect(r3.ok === false && r3.reason === 'invalid' && r3.detail).toBe('device_mismatch');
      expect((await store.head()).count).toBe(1);
    });
  }

  it('fs: a torn final line (an append that never returned) is healed; the chain continues', async () => {
    const root = tmpRoot();
    const store = new FsPeStore(TEST_DEVICE_ID, root);
    const a = await pe(store);
    await store.append(a);
    fs.appendFileSync(store.pesFile, '{"i":1,"at":1,"pe":{"schema":"provian.pe.v2","pe_i'); // torn
    const fresh = new FsPeStore(TEST_DEVICE_ID, root); // a restart after the crash
    const b = await pe(fresh);
    expect(b.prev_hash).toBe(a.pe_hash);
    expect((await fresh.append(b)).ok).toBe(true);
    const all = await new FsPeStore(TEST_DEVICE_ID, root).readPes(0, 10);
    expect(all.map((p) => p.pe.pe_id)).toEqual([a.pe_id, b.pe_id]);
  });

  it('fs: a PE fsynced before its head was written (crash) is adopted on the next read', async () => {
    const root = tmpRoot();
    const store = new FsPeStore(TEST_DEVICE_ID, root);
    await store.append(await pe(store));
    const headFile = path.join(store.location, 'head.json');
    const before = fs.readFileSync(headFile, 'utf8');
    await store.append(await pe(store), { idempotencyKey: 'pe_crash_key_00000001' });
    fs.writeFileSync(headFile, before); // the head write "never happened"
    fs.rmSync(path.join(store.location, 'idem'), { recursive: true, force: true }); // nor the index
    const fresh = new FsPeStore(TEST_DEVICE_ID, root);
    expect((await fresh.head()).count).toBe(2);
    expect(await fresh.findByIdempotencyKey('pe_crash_key_00000001')).not.toBeNull();
  });

  /** A second PE built on the SAME head as `first` (what two racing appends produce). */
  async function forkOf(store: FsPeStore, prevHash: string, index: number, tag: string): Promise<string> {
    const built = await buildPeV2({
      content: { action_type: 'coding_session', metadata: { commit_sha: tag }, compute: null, geo: null, execution_env: null, parent_goal_pe_id: null },
      deviceId: store.deviceId, prevHash, timestampMs: 1_790_000_000_000, peId: `pe_fork_${tag}`,
    });
    return JSON.stringify({ i: index, at: 1_790_000_000_003, pe: built }) + '\n';
  }

  function quarantined(store: FsPeStore): string[] {
    return fs.readdirSync(store.location).filter((f) => f.startsWith('quarantine-'));
  }

  it('a fork past the head (two appends on one head; the first head won) is quarantined byte for byte and the chain continues', async () => {
    const root = tmpRoot();
    const store = new FsPeStore(TEST_DEVICE_ID, root);
    const p0 = await pe(store);
    await store.append(p0);
    const a = await pe(store);
    await store.append(a);
    const fork = await forkOf(store, p0.pe_hash, 1, 'b');
    fs.appendFileSync(store.pesFile, fork);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const fresh = new FsPeStore(TEST_DEVICE_ID, root);
    const c = await pe(fresh);
    expect(c.prev_hash).toBe(a.pe_hash);
    expect((await fresh.append(c)).ok).toBe(true);
    expect((await fresh.readPes(0, 10)).map((x) => x.pe.pe_id)).toEqual([p0.pe_id, a.pe_id, c.pe_id]);
    const q = quarantined(fresh);
    expect(q.length).toBe(1);
    expect(fs.readFileSync(path.join(fresh.location, q[0]), 'utf8')).toBe(fork);
    expect(stderr.mock.calls.some(([line]) => String(line).includes('moved to'))).toBe(true);
  });

  it('the same fork when the second writer\'s head won (head bytes land mid-file) heals to the valid chain', async () => {
    const root = tmpRoot();
    const store = new FsPeStore(TEST_DEVICE_ID, root);
    const p0 = await pe(store);
    await store.append(p0);
    const afterP0 = fs.statSync(store.pesFile).size;
    const a = await pe(store);
    await store.append(a);
    const fork = await forkOf(store, p0.pe_hash, 1, 'b-wins');
    fs.appendFileSync(store.pesFile, fork);
    const forkPe = JSON.parse(fork).pe as StoredPeV2;
    fs.writeFileSync(path.join(store.location, 'head.json'), JSON.stringify({ count: 2, last_pe_hash: forkPe.pe_hash, bytes: afterP0 + Buffer.byteLength(fork) }));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const fresh = new FsPeStore(TEST_DEVICE_ID, root);
    expect(await fresh.head()).toEqual({ count: 2, last_pe_hash: a.pe_hash });
    expect(quarantined(fresh).length).toBe(1);
  });

  it(' review: the repair writes the head before the cut, so a crash in between leaves the fork-past-head shape the first test heals', () => {
    // A crash after the cut but before the head would leave a head naming the QUARANTINED PE over a
    // file holding the other one (silently broken when both lines are the same length).
    const src = fs.readFileSync(path.join(__dirname, 'pe-store.ts'), 'utf8');
    const body = src.slice(src.indexOf('private quarantineForkLocked'), src.indexOf('private reconcileHeadStrictLocked'));
    const headAt = body.indexOf('atomicReplacePrivateFile(this.headPath');
    const cutAt = body.indexOf('fs.ftruncateSync(pfd, bytes)');
    expect(headAt).toBeGreaterThan(0);
    expect(cutAt).toBeGreaterThan(0);
    expect(headAt).toBeLessThan(cutAt);
  });

  it('RED: a fork that would cut below a batch already sent stops the store — nothing is rewritten', async () => {
    const root = tmpRoot();
    const store = new FsPeStore(TEST_DEVICE_ID, root);
    const p0 = await pe(store);
    await store.append(p0);
    const garbage = JSON.stringify({ i: 1, at: 1, pe: { schema: PE_V2_SCHEMA, pe_id: 'pe_x', device_id: TEST_DEVICE_ID, prev_hash: 'nope', timestamp: 1, action_type: 'x', pe_hash: '0'.repeat(64) } }) + '\n';
    fs.appendFileSync(store.pesFile, garbage);
    fs.writeFileSync(path.join(store.location, 'batch-head.json'), JSON.stringify({ batch: { first_index: 0, count: 2 }, next_offset: null }));
    const sizeBefore = fs.statSync(store.pesFile).size;
    const fresh = new FsPeStore(TEST_DEVICE_ID, root);
    await expect(fresh.append(await pe(new MemoryPeStore(TEST_DEVICE_ID)))).rejects.toBeInstanceOf(PeStoreCorruptError);
    expect(fs.statSync(store.pesFile).size).toBe(sizeBefore);
    expect(quarantined(fresh)).toEqual([]);
  });

  it('RED: a head claiming bytes an intact chain does not have is not a fork — nothing to quarantine, the store stops', async () => {
    const root = tmpRoot();
    const store = new FsPeStore(TEST_DEVICE_ID, root);
    await store.append(await pe(store));
    await store.append(await pe(store));
    const headFile = path.join(store.location, 'head.json');
    const head = JSON.parse(fs.readFileSync(headFile, 'utf8')) as { count: number; last_pe_hash: string; bytes: number };
    fs.writeFileSync(headFile, JSON.stringify({ ...head, bytes: head.bytes + 5 }));
    const fresh = new FsPeStore(TEST_DEVICE_ID, root);
    await expect(fresh.head()).rejects.toBeInstanceOf(PeStoreCorruptError);
    expect(JSON.parse(fs.readFileSync(headFile, 'utf8')).bytes).toBe(head.bytes + 5);
    expect(quarantined(fresh)).toEqual([]);
  });

  it('RED: a file shorter than its head (PEs missing) is not a fork — the store stops, nothing is rewritten', async () => {
    const root = tmpRoot();
    const store = new FsPeStore(TEST_DEVICE_ID, root);
    await store.append(await pe(store));
    await store.append(await pe(store));
    const cut = fs.statSync(store.pesFile).size - 10;
    fs.truncateSync(store.pesFile, cut);
    const fresh = new FsPeStore(TEST_DEVICE_ID, root);
    await expect(fresh.head()).rejects.toBeInstanceOf(PeStoreCorruptError);
    expect(fs.statSync(store.pesFile).size).toBe(cut);
    expect(quarantined(fresh)).toEqual([]);
  });

  it('a hardware witness signs the act nonce of the PE without its slot; the pe_hash covers the slot', async () => {
    let seen = '';
    const witness = async (nonce: string): Promise<HardwareWitnessInput> => { seen = nonce; return { scheme: 'tpm2_quote', nonce_binding: 'body_sha256', quote: 'AA', signature: 'BB' }; };
    const built = await buildPeV2({
      content: { action_type: 'compute_session', metadata: { a: 1 }, compute: null, geo: null, execution_env: null, parent_goal_pe_id: null },
      deviceId: TEST_DEVICE_ID, prevHash: METER_GENESIS_PREV_HASH, timestampMs: 1_790_000_000_000, peId: 'pe_witnessed', hardwareWitness: witness,
    });
    const { hardware_witness: slot, pe_hash: _h, ...bare } = built;
    expect(slot).toEqual({ scheme: 'tpm2_quote', nonce_binding: 'body_sha256', quote: 'AA', signature: 'BB' });
    expect(seen).toBe(hardwareNonceOfAct(actRecordOf(bare as PeV2)));
    // The relay recomputes the same nonce from the act it receives (it omits the slot itself).
    expect(hardwareNonceOfAct(actRecordOf(built))).toBe(seen);
    expect(built.pe_hash).toBe(peHashOf(built));
    // RED control: the nonce binds the chain position — another prev_hash, another nonce.
    expect(hardwareNonceOfAct(actRecordOf({ ...(bare as PeV2), prev_hash: 'a'.repeat(64) }))).not.toBe(seen);
    // A producer that throws never blocks the record.
    const unwitnessed = await buildPeV2({
      content: { action_type: 'compute_session', metadata: {}, compute: null, geo: null, execution_env: null, parent_goal_pe_id: null },
      deviceId: TEST_DEVICE_ID, prevHash: METER_GENESIS_PREV_HASH, timestampMs: 1, peId: 'pe_plain', hardwareWitness: async () => { throw new Error('tpm gone'); },
    });
    expect('hardware_witness' in unwitnessed).toBe(false);
  });
});

describe('the append lock is never robbed from a live process', () => {
  it('a lock held by a live pid is not taken; one left by a dead pid is', () => {
    const dir = tmpRoot();
    const lock = path.join(dir, 'append.lock');
    fs.writeFileSync(lock, `${process.ppid}:${Date.now()}`); // a live process (our parent)
    expect(tryAcquireFileLock(lock, { timeoutMs: 0, staleMs: 60_000, syncOnly: true })).toBeNull();
    fs.writeFileSync(lock, `999999:${Date.now()}`); // no such process
    const release = tryAcquireFileLock(lock, { timeoutMs: 0, staleMs: 60_000, syncOnly: true });
    expect(release).not.toBeNull();
    expect(fs.readFileSync(lock, 'utf8').startsWith(`${process.pid}:`)).toBe(true);
    release!();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it(' RED: a lock caught mid-creation (no holder written yet) is never taken; an old unreadable one is', () => {
    const dir = tmpRoot();
    const lock = path.join(dir, 'append.lock');
    fs.writeFileSync(lock, ''); // a creator between create and write (the pre- window)
    expect(tryAcquireFileLock(lock, { timeoutMs: 0, staleMs: 60_000, syncOnly: true })).toBeNull();
    expect(fs.readFileSync(lock, 'utf8')).toBe('');
    const old = (Date.now() - UNREADABLE_GRACE_MS - 1_000) / 1000;
    fs.utimesSync(lock, old, old); // left by a creator that crashed long ago
    const release = tryAcquireFileLock(lock, { timeoutMs: 0, staleMs: 60_000, syncOnly: true });
    expect(release).not.toBeNull();
    release!();
  });

  it('a lock is created with its holder already inside (never empty to a reader)', () => {
    const dir = tmpRoot();
    const lock = path.join(dir, 'append.lock');
    const release = tryAcquireFileLock(lock, { timeoutMs: 0, staleMs: 60_000, syncOnly: true });
    expect(fs.readFileSync(lock, 'utf8')).toMatch(new RegExp(`^${process.pid}:\\d+$`));
    expect(fs.readdirSync(dir)).toEqual(['append.lock']); // no temp file left behind
    release!();
  });

  it(' review RED: while another taker holds the takeover guard, no taker removes the lock; only an abandoned guard is cleared', () => {
    const dir = tmpRoot();
    const lock = path.join(dir, 'append.lock');
    const guard = `${lock}.takeover`;
    fs.writeFileSync(lock, '999999:1'); // a dead holder
    fs.writeFileSync(guard, `${process.ppid}:${Date.now()}`); // a live taker at work (even if it stalls)
    expect(removeJudgedLock(lock, '999999:1')).toBe(false);
    expect(fs.readFileSync(lock, 'utf8')).toBe('999999:1');
    expect(fs.existsSync(guard)).toBe(true);
    fs.writeFileSync(guard, `999998:${Date.now()}`); // that taker died
    expect(removeJudgedLock(lock, '999999:1')).toBe(false); // clears the abandoned guard only
    expect(fs.existsSync(guard)).toBe(false);
    expect(removeJudgedLock(lock, '999999:1')).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it(' review RED: a guard or lock is unlinked only while it still holds what was judged', () => {
    const dir = tmpRoot();
    const f = path.join(dir, 'append.lock.takeover');
    fs.writeFileSync(f, `${process.pid}:${Date.now()}`); // a fresh guard made after the judgment
    expect(unlinkIfStill(f, '999998:1')).toBe(false);
    expect(fs.existsSync(f)).toBe(true);
    expect(unlinkIfStill(f, fs.readFileSync(f, 'utf8'))).toBe(true);
    expect(fs.existsSync(f)).toBe(false);
    // an old guard of a live pid (pid reuse) is abandoned after TAKEOVER_GUARD_STALE_MS
    fs.writeFileSync(f, `${process.ppid}:${Date.now() - TAKEOVER_GUARD_STALE_MS - 1_000}`);
    expect(clearAbandonedGuard(f, Date.now())).toBe(true);
  });

  it(' RED: a takeover removes only the lock it judged — one that changed hands is kept', () => {
    const dir = tmpRoot();
    const lock = path.join(dir, 'append.lock');
    fs.writeFileSync(lock, `${process.ppid}:${Date.now()}`); // taken by a live process after we judged the dead one
    expect(removeJudgedLock(lock, '999999:1')).toBe(false);
    expect(fs.readFileSync(lock, 'utf8')).toBe(`${process.ppid}:${fs.readFileSync(lock, 'utf8').split(':')[1]}`);
    expect(fs.readdirSync(dir)).toEqual(['append.lock']);
    fs.writeFileSync(lock, '999999:1');
    expect(removeJudgedLock(lock, '999999:1')).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });
});

describe('operator mirror hook (config.peMirror)', () => {
  it('is called with each newly recorded PE', async () => {
    const copies: PeV2[] = [];
    const client = new ProvianClient({ ...DEVICE, peStore: new MemoryPeStore(TEST_DEVICE_ID), peMirror: async (pe) => { copies.push(pe); } });
    const r = await client[SUBMIT_OBSERVED_PE]({ actionType: 'compute_session', success: true });
    await new Promise((resolve) => setImmediate(resolve));
    expect(copies).toHaveLength(1);
    expect(copies[0].pe_id).toBe(r && 'pe_id' in r ? r.pe_id : '');
  });

  it('a failing or hanging mirror never blocks or fails the record (warned once)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const failing = new ProvianClient({ ...DEVICE, peStore: store, peMirror: async () => { throw new Error('bucket down'); } });
    await record(failing, 2);
    await new Promise((resolve) => setImmediate(resolve));
    expect((await store.head()).count).toBe(2);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('PE mirror failed'))).toHaveLength(1);
    const hanging = new ProvianClient({ ...DEVICE, peStore: new MemoryPeStore(TEST_DEVICE_ID), peMirror: () => new Promise<void>(() => undefined) });
    const r = await hanging[SUBMIT_OBSERVED_PE]({ actionType: 'compute_session', success: true });
    expect(r && 'pe_id' in r).toBe(true);
  });
});

describe('legacy outbox migration (the queue at upgrade)', () => {
  function seedOutbox(dir: string): PeOutbox {
    const outbox = new PeOutbox(dir);
    outbox.enqueue({ body: { action_type: 'coding_session', description: 'Structural coding_session record (2 files)', metadata: { commit_sha: 'c1' }, cited_pe_ids: ['pe_x'], compute: null }, idempotencyKey: 'pe_' + '1'.repeat(32), status: null, error: 'down' });
    outbox.enqueue({ body: { action_type: 'agent_tool_orchestration', metadata: { tool_count: 2 }, input_origins: [{ hash: 'sha256:aa', origin_identifier: 'https://e.x/a', witnessed: false }] }, idempotencyKey: 'pe_' + '2'.repeat(32), status: 503, error: 'busy' });
    return outbox;
  }

  function recorderFor(client: ProvianClient) {
    return async (content: Parameters<Parameters<typeof migrateLegacyOutbox>[0]['record']>[0], key: string) => {
      const r = await client[SUBMIT_OBSERVED_PE]({
        actionType: content.action_type, success: true, metadata: content.metadata,
        ...(content.description ? { description: content.description } : {}),
        ...(content.input_origins !== undefined ? { input_origins: content.input_origins as never } : {}),
        idempotencyKey: key,
      });
      if (r && 'pe_id' in r) return 'idempotent_replay' in r && r.idempotent_replay ? 'replay' as const : 'recorded' as const;
      return 'failed' as const;
    };
  }

  it('moves every queued entry into the PE store (fresh pe_id, now) and retires the queue as .migrated', async () => {
    const dir = path.join(tmpRoot(), 'pe-outbox');
    seedOutbox(dir);
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const client = new ProvianClient({ ...DEVICE, peStore: store });
    const before = Date.now();
    const report = await migrateLegacyOutbox({ outboxDir: dir, record: recorderFor(client) });
    expect(report).toMatchObject({ migrated: 2, skipped: 0, incomplete: false, retiredTo: `${dir}.migrated` });
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.readdirSync(`${dir}.migrated`).filter((f) => f.endsWith('.json'))).toHaveLength(2); // nothing deleted
    const pes = await store.readPes(0, 10);
    expect(pes.map((p) => p.pe.action_type)).toEqual(['coding_session', 'agent_tool_orchestration']);
    expect(pes[0].pe.timestamp).toBeGreaterThanOrEqual(before);
    expect('cited_pe_ids' in pes[0].pe).toBe(false);
    expect(pes[0].idempotency_key).toBe('pe_' + '1'.repeat(32));
    expect(pes[1].pe.input_origins).toEqual([{ hash: 'sha256:aa', origin_identifier: 'https://e.x/a', witnessed: false }]);
    // Run again: nothing left, nothing re-recorded.
    expect(await migrateLegacyOutbox({ outboxDir: dir, record: recorderFor(client) })).toMatchObject({ migrated: 0, retiredTo: null });
    expect((await store.head()).count).toBe(2);
  });

  it('RED control: a migration interrupted mid-way and run again records each entry exactly once', async () => {
    const dir = path.join(tmpRoot(), 'pe-outbox');
    seedOutbox(dir);
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const client = new ProvianClient({ ...DEVICE, peStore: store });
    let calls = 0;
    const flaky = async (content: Parameters<ReturnType<typeof recorderFor>>[0], key: string) => {
      calls += 1;
      if (calls === 2) return 'failed' as const; // the process dies on the second entry
      return recorderFor(client)(content, key);
    };
    expect(await migrateLegacyOutbox({ outboxDir: dir, record: flaky })).toMatchObject({ migrated: 1, incomplete: true });
    expect(fs.existsSync(`${dir}.migrating`)).toBe(true);
    const report = await migrateLegacyOutbox({ outboxDir: dir, record: recorderFor(client) });
    expect(report).toMatchObject({ migrated: 1, replayed: 1, incomplete: false });
    expect((await store.head()).count).toBe(2);
  });

  it('peContentFromV1Body / migrationKeyOf', () => {
    expect(peContentFromV1Body({ description: 'x' })).toBeNull();
    expect(migrationKeyOf({ id: 'abc', idempotency_key: 'short' })).toMatch(/^mig_[0-9a-f]{40}$/);
    expect(migrationKeyOf({ id: 'abc', idempotency_key: 'short' })).toBe(migrationKeyOf({ id: 'abc', idempotency_key: '' }));
    expect(canonicalJson(peContentFromV1Body({ action_type: 'a', metadata: [1] }))).toBe(canonicalJson({ action_type: 'a', compute: null, execution_env: null, geo: null, metadata: {}, parent_goal_pe_id: null }));
  });
});

describe('pre-meter PEs handed back by the relay (legacy.jsonl)', () => {
  it('files each once by mailbox id and pe id, and survives a restart', async () => {
    const root = tmpRoot();
    const store = new FsPeStore(TEST_DEVICE_ID, root);
    const item = { mailbox_id: 'mb_1', pe_id: 'pe_v1', envelope: { id: 'pe_v1', hash: 'ab'.repeat(32) }, received_at_ms: 1 };
    expect(await store.recordLegacy(item)).toBe(true);
    expect(await store.recordLegacy({ ...item, mailbox_id: 'mb_2' })).toBe(false); // same PE, redelivered
    const restarted = new FsPeStore(TEST_DEVICE_ID, root);
    expect(await restarted.recordLegacy(item)).toBe(false);
    expect((await restarted.listLegacy()).map((l) => l.pe_id)).toEqual(['pe_v1']);
    expect((await restarted.head()).count).toBe(0); // never part of this device's own chain
  });
});
