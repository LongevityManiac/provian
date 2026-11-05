/**
 * PE meter — the daily batcher against the relay's `/v1/meter/*` answers (the standing rule
 * 2026-10-03). Every relay answer path is driven through a fake relay that applies the relay's
 * own ingest rules (shape, same-batch idempotency, seq / prev_batch_hash / act-chain continuity),
 * with RED controls for each guard.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { keccak256 } from '../keccak256';
import {
  actLeafOf,
  actRecordOf,
  batchHashOf,
  batchLeafOf,
  buildBatch,
  canonicalJson,
  PE_V2_SCHEMA,
  MAX_ACTS_PER_BATCH,
  METER_GENESIS_PREV_HASH,
  peHashOf,
  verifyActInclusion,
  type PeBatch,
  type PeV2,
} from '../meter-wire';
import { deriveMessageKeyPair, openThreadMessage, sealThreadMessage } from '../thread-crypto';
import { MemoryPeStore, FsPeStore, type PeStore, type StoredPe } from './pe-store';
import { buildPeV2 } from './pe-builder';
import { createHttpMeterTransport, type MeterTransport } from './transport';
import { MeterBatcher, parseLineageNote, METER_RELAY_MIN_INTERVAL_MS, METER_RETRY_BASE_MS, METER_STALE_HALT_RECHECK_MS, type MeterBatcherOptions } from './batcher';
import { actInclusionProofFor } from './prove';
import { anchoredLeafOf, meterAnchorBatchIdOf, PE_EXPORT_PE_ANCHOR } from '../pe-export-wire';
import { meterStatusOf, describeMeterStatus } from './status';
import { FakeMeterRelay, TEST_DEVICE_ID, TEST_ACTOR_ID } from './capturing-store.test-support';
import { peStoreCheck, relayMeterCheck } from '../scripts/doctor';
import { ProvianObserver } from '../observer/ProvianObserver';

const NOW = 1_790_000_000_000;

function transportFor(relay: FakeMeterRelay): MeterTransport {
  return createHttpMeterTransport({
    relayUrl: 'https://relay.test',
    boundEnvelope: async (body) => ({ headers: { 'X-Provian-Body-HMAC': 'bound' }, body: JSON.stringify(body) }),
    authHeaders: () => ({ Authorization: 'DeviceKey pdk:pds' }),
    timeoutMs: 5_000,
    fetchImpl: relay.fetch,
  });
}

function batcherFor(store: PeStore, relay: FakeMeterRelay, extra: Partial<MeterBatcherOptions> = {}): MeterBatcher {
  return new MeterBatcher({ store, transport: transportFor(relay), now: () => relay.now, resendDelayMs: 0, ...extra });
}

async function recordN(store: PeStore, n: number, extra: (i: number) => Record<string, unknown> = () => ({})): Promise<StoredPe[]> {
  const out: StoredPe[] = [];
  for (let i = 0; i < n; i++) {
    const head = await store.head();
    const pe = await buildPeV2({
      content: { action_type: 'agent_tool_orchestration', metadata: { tool_count: 1, turn: i, ...extra(i) }, compute: null, geo: null, execution_env: null, parent_goal_pe_id: null },
      deviceId: store.deviceId, prevHash: head.last_pe_hash, timestampMs: NOW - 1_000 + i, peId: `pe_${String(head.count).padStart(24, '0')}`,
    });
    const r = await store.append(pe);
    if (!r.ok) throw new Error('append failed');
    out.push(r.stored);
  }
  return out;
}

function postedBatch(relay: FakeMeterRelay, i: number): PeBatch {
  return JSON.parse(relay.batchPosts()[i].body!) as PeBatch;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('201 — a new batch: built in chain order, persisted before sending, filed with its receipt', () => {
  it('sends unsent PEs as one batch (seq 1 from genesis), files the receipt, then has nothing to send', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    const pes = await recordN(store, 3);
    const report = await batcherFor(store, relay).flush();
    expect(report).toMatchObject({ outcome: 'sent', batchesAccepted: 1, actsAccepted: 3, retryAtMs: null });
    const batch = postedBatch(relay, 0);
    expect(batch.seq).toBe(1);
    expect(batch.prev_batch_hash).toBe(METER_GENESIS_PREV_HASH);
    expect(batch.acts.map((a) => a.pe_id)).toEqual(pes.map((p) => p.pe.pe_id));
    expect(batch.acts.map((a) => a.pe_hash)).toEqual(pes.map((p) => p.pe.pe_hash));
    expect(relay.batchPosts()[0].headers['X-Provian-Body-HMAC']).toBe('bound');
    const last = await store.lastBatch();
    expect(last).toMatchObject({ seq: 1, first_index: 0, count: 3, last_pe_hash: pes[2].pe.pe_hash, actor_id: TEST_ACTOR_ID });
    expect((await store.readReceipt(1))?.totals.eligible).toBe(3);
    expect(await store.inFlight()).toBeNull();
    expect((await batcherFor(store, relay).flush()).outcome).toBe('nothing_to_send');
    // The next PEs go in seq 2, linked to batch 1 and to its last act.
    await recordN(store, 1);
    await batcherFor(store, relay).flush();
    const second = postedBatch(relay, 1);
    expect(second).toMatchObject({ seq: 2, prev_batch_hash: batchHashOf(batch) });
    expect(second.acts[0].prev_hash).toBe(pes[2].pe.pe_hash);
  });

  it('a full batch (MAX_ACTS_PER_BATCH acts) is followed at once by the next one (backlog drain)', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    await recordN(store, MAX_ACTS_PER_BATCH + 2);
    const report = await batcherFor(store, relay, { maxBatchBytes: 10_000_000 }).flush();
    expect(report).toMatchObject({ outcome: 'sent', batchesAccepted: 2, actsAccepted: MAX_ACTS_PER_BATCH + 2 });
    expect(relay.accepted.map((b) => b.acts.length)).toEqual([MAX_ACTS_PER_BATCH, 2]);
  });

  it('a batch capped by wire size waits out the relay\'s 5-minute rule before the rest (it is not "full")', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    await recordN(store, 12, () => ({ padding: 'x'.repeat(400) }));
    const report = await batcherFor(store, relay, { maxBatchBytes: 3_000 }).flush();
    expect(report.batchesAccepted).toBe(1);
    expect(relay.accepted[0].acts.length).toBeLessThan(12);
    expect(report.retryAtMs).toBe(NOW + METER_RELAY_MIN_INTERVAL_MS + 5_000);
    expect(relay.batchPosts().every((p) => p.body!.length <= 3_000)).toBe(true);
  });
});

describe('200 — the SAME batch re-sent after a crash is answered with the same receipt', () => {
  it('relay accepted, answer lost, process restarts: the persisted in-flight batch is re-sent byte for byte → 200, filed once', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meter-crash-'));
    const store = new FsPeStore(TEST_DEVICE_ID, root);
    const relay = new FakeMeterRelay();
    await recordN(store, 2);
    relay.loseNextBatchAnswer = true;
    const first = await batcherFor(store, relay).flush();
    expect(first.outcome).toBe('deferred');
    expect(relay.accepted).toHaveLength(1); // the relay DID take it
    const inflight = await store.inFlight();
    expect(inflight?.batch.seq).toBe(1);
    // Restart: a new store + batcher over the same directory, a later clock.
    relay.now += 60_000;
    const after = await batcherFor(new FsPeStore(TEST_DEVICE_ID, root), relay).flush();
    expect(after).toMatchObject({ outcome: 'sent', batchesAccepted: 1, lastStatus: 200 });
    expect(relay.batchPosts()[1].body).toBe(relay.batchPosts()[0].body);
    expect(relay.accepted).toHaveLength(1);
    expect((await new FsPeStore(TEST_DEVICE_ID, root).listBatches()).map((b) => b.seq)).toEqual([1]);
    expect(await new FsPeStore(TEST_DEVICE_ID, root).inFlight()).toBeNull();
  });

  it('RED control: a REBUILT batch over the same PEs (new created_at_ms) is a different batch — the relay refuses it as a replay', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    const pes = await recordN(store, 2);
    relay.loseNextBatchAnswer = true;
    await batcherFor(store, relay).flush();
    const rebuilt = buildBatch({ device_id: TEST_DEVICE_ID, seq: 1, prev_batch_hash: METER_GENESIS_PREV_HASH, created_at_ms: NOW + 1, pes: pes.map((p) => p.pe) });
    const answer = await transportFor(relay).postBatch(rebuilt);
    expect(answer.status).toBe(409);
    expect((answer.body as { error: string }).error).toBe('batch_replay');
  });

  it('a crash after the receipt was filed but before the in-flight copy was cleared sends nothing twice', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    await recordN(store, 1);
    await batcherFor(store, relay).flush();
    const [accepted] = await store.listBatches();
    const batch = relay.accepted[0];
    await store.setInFlight({ batch, batch_hash: batchHashOf(batch), first_index: 0, count: 1, last_pe_hash: accepted.last_pe_hash, persisted_at_ms: NOW });
    expect((await batcherFor(store, relay).flush()).outcome).toBe('nothing_to_send');
    expect(relay.batchPosts()).toHaveLength(1);
    expect(await store.inFlight()).toBeNull();
  });
});

describe('409 answers', () => {
  it('batch_concurrent / batch_retry: the SAME batch is re-sent unchanged, then accepted', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    await recordN(store, 2);
    relay.script.push(
      (r) => (r.path === '/v1/meter/batch' ? { status: 409, body: { error: 'batch_concurrent' } } : null),
      (r) => (r.path === '/v1/meter/batch' ? { status: 409, body: { error: 'batch_retry', detail: 'novelty' } } : null),
    );
    const report = await batcherFor(store, relay).flush();
    expect(report).toMatchObject({ outcome: 'sent', batchesAccepted: 1 });
    const bodies = relay.batchPosts().map((p) => p.body);
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies).size).toBe(1);
  });

  it('batch_replay with the relay ahead and its last PE one of ours: resync to the relay tip (no PE changed), then continue', async () => {
    const relay = new FakeMeterRelay();
    const original = new MemoryPeStore(TEST_DEVICE_ID);
    const pes = await recordN(original, 2);
    await batcherFor(original, relay).flush(); // relay now at seq 1 over PEs 0..1
    // This machine lost its batch records (not its PEs): the same chain, no batch history.
    const recovered = new MemoryPeStore(TEST_DEVICE_ID);
    for (const p of pes) expect((await recovered.append(p.pe)).ok).toBe(true);
    const [extra] = await recordN(recovered, 1);
    const log = vi.fn();
    const report = await batcherFor(recovered, relay, { log }).flush();
    expect(report).toMatchObject({ outcome: 'sent', batchesAccepted: 1 });
    const batches = await recovered.listBatches();
    expect(batches[0]).toMatchObject({ seq: 1, adopted: true, first_index: 0, count: 2, last_pe_hash: pes[1].pe.pe_hash });
    expect(batches[1]).toMatchObject({ seq: 2, first_index: 2, count: 1 });
    expect(relay.accepted[1].acts[0].pe_hash).toBe(extra.pe.pe_hash);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('resynced to its tip'), expect.anything());
  });

  it('RED: the relay holds a PE this device never made (a diverged chain) — batching HALTS, persisted; no re-chain, no further send', async () => {
    const relay = new FakeMeterRelay();
    const other = new MemoryPeStore(TEST_DEVICE_ID);
    await recordN(other, 1, () => ({ who: 'someone else' }));
    await batcherFor(other, relay).flush();
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const mine = await recordN(store, 2);
    const log = vi.fn();
    const report = await batcherFor(store, relay, { log }).flush();
    expect(report.outcome).toBe('halted');
    expect(report.halt?.reason).toBe('relay_chain_diverged');
    expect(await store.halt()).toMatchObject({ reason: 'relay_chain_diverged' });
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('PE METER HALTED'), expect.anything());
    // PEs untouched.
    expect((await store.readPes(0, 10)).map((p) => p.pe.pe_hash)).toEqual(mine.map((p) => p.pe.pe_hash));
    const posts = relay.batchPosts().length;
    expect((await batcherFor(store, relay).flush()).outcome).toBe('halted');
    expect(relay.batchPosts()).toHaveLength(posts);
  });

  it('RED: the relay is BEHIND this store (relay_behind_local) — halt', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    await recordN(store, 1);
    await batcherFor(store, relay).flush();
    await batcherFor(store, relay).flush();
    await recordN(store, 1);
    await batcherFor(store, relay).flush(); // relay at seq 2
    const amnesiac = new FakeMeterRelay(); // a relay that lost its tip (seq 0)
    amnesiac.script.push((r) => (r.path === '/v1/meter/batch' ? { status: 409, body: { error: 'batch_chain_broken', expected_seq: 1, expected_prev_batch_hash: METER_GENESIS_PREV_HASH, last_pe_hash: METER_GENESIS_PREV_HASH } } : null));
    await recordN(store, 1);
    const report = await batcherFor(store, amnesiac).flush();
    expect(report.halt?.reason).toBe('relay_behind_local');
  });

  it('RED: act_chain_broken — halt (the relay\'s last PE is not where this chain continues from)', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    await recordN(store, 1);
    relay.script.push((r) => (r.path === '/v1/meter/batch' ? { status: 409, body: { error: 'act_chain_broken', act_index: 0, last_pe_hash: 'c'.repeat(64) } } : null));
    const report = await batcherFor(store, relay).flush();
    expect(report.halt?.reason).toBe('act_chain_broken');
  });
});

describe('matching tips are never a divergence (no false relay_chain_diverged halt)', () => {
  // THE DAEMON'S REAL PATH (Grok bot, 2026-10-20). The daemon runs an FsPeStore on disk and drives
  // the batcher through tick() — never flush() on a MemoryPeStore, which is all the tests below this
  // block exercise. These pin the stale-halt recovery on that real path.
  const diskStore = (): { store: FsPeStore; root: string } => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-stale-halt-'));
    return { store: new FsPeStore(TEST_DEVICE_ID, root), root };
  };

  it('REAL PATH: FsPeStore + tick() (a restarted daemon) clears a stale matching-tip halt and drains the queue', async () => {
    const { store, root } = diskStore();
    const relay = new FakeMeterRelay();
    await recordN(store, 2);
    await batcherFor(store, relay).flush();            // relay + device both at seq 1
    await store.setHalt({ reason: 'relay_chain_diverged', detail: 'stale (old daemon)', at_ms: 1 });
    await recordN(store, 1);                            // queued while halted
    const log = vi.fn();
    await batcherFor(new FsPeStore(TEST_DEVICE_ID, root), relay, { log }).tick();  // fresh process
    expect(await store.halt()).toBeNull();
    expect(relay.accepted.at(-1)?.seq).toBe(2);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('cleared a stale relay_chain_diverged halt'), expect.anything());
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('REGRESSION (24-hour stall): a stale halt whose first re-check cannot reach the relay is re-checked on the failure backoff — not a day later', async () => {
    const { store, root } = diskStore();
    const relay = new FakeMeterRelay();
    await recordN(store, 2);
    await batcherFor(store, relay).flush();            // in sync at seq 1
    await store.setHalt({ reason: 'relay_chain_diverged', detail: 'stale (old daemon)', at_ms: 1 });
    await recordN(store, 1);
    const log = vi.fn();
    const daemon = batcherFor(new FsPeStore(TEST_DEVICE_ID, root), relay, { log });
    relay.online = false;                               // the first re-check (at start) cannot reach the relay
    await daemon.tick();
    expect(await store.halt()).toMatchObject({ reason: 'relay_chain_diverged' });
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('relay tip could not be read'), expect.anything());
    relay.online = true;
    relay.now += METER_RETRY_BASE_MS + 1;               // one failure backoff later — NOT 24 hours
    await daemon.tick();                                // the same running daemon, its own schedule
    expect(await store.halt()).toBeNull();              // re-checked and cleared
    expect(relay.accepted.at(-1)?.seq).toBe(2);         // the queue drained
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('a stale-halt re-check whose tip still differs logs BOTH tips once and re-checks hourly (never silent, never daily)', async () => {
    const relay = new FakeMeterRelay();
    const other = new MemoryPeStore(TEST_DEVICE_ID);
    await recordN(other, 1, () => ({ who: 'someone else' }));
    await batcherFor(other, relay).flush();            // relay tip = a chain this device did not make
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    await recordN(store, 2);
    await store.setHalt({ reason: 'relay_chain_diverged', detail: 'genuine', at_ms: 1 });
    const log = vi.fn();
    const b = batcherFor(store, relay, { log });
    const first = await b.flush();
    expect(first.outcome).toBe('halted');
    expect(first.retryAtMs).toBe(relay.now + METER_STALE_HALT_RECHECK_MS);
    await b.flush();                                    // a second re-check with the same answer
    const differs = log.mock.calls.filter((c) => String(c[1]).includes('relay tip still differs'));
    expect(differs).toHaveLength(1);                    // logged once per distinct outcome
    expect(differs[0][2]).toMatchObject({ relay_seq: 1, local_seq: 0 });
    expect(await store.halt()).toMatchObject({ reason: 'relay_chain_diverged' });
  });

  it('doctor relay check: a stale halt with a matching live tip is called stale (not just "halted")', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    await recordN(store, 2);
    await batcherFor(store, relay).flush();            // in sync at seq 1
    await store.setHalt({ reason: 'relay_chain_diverged', detail: 'stale', at_ms: 1 });
    const check = await relayMeterCheck(transportFor(relay), store);
    expect(check).toMatchObject({ name: 'relay', status: 'green' });
    expect(check.detail).toContain('halt is stale');
  });

  it('RED (control): doctor relay check is RED with the exact failure when the meter path cannot reach the relay', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    relay.online = false;
    const check = await relayMeterCheck(transportFor(relay), store);
    expect(check).toMatchObject({ name: 'relay', status: 'red' });
    expect(check.detail).toContain('cannot read the relay (no answer');
  });

  it('RED (control): doctor relay check never calls a halt stale when the live tip differs', async () => {
    const relay = new FakeMeterRelay();
    const other = new MemoryPeStore(TEST_DEVICE_ID);
    await recordN(other, 1, () => ({ who: 'someone else' }));
    await batcherFor(other, relay).flush();
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    await recordN(store, 2);
    await store.setHalt({ reason: 'relay_chain_diverged', detail: 'genuine', at_ms: 1 });
    const check = await relayMeterCheck(transportFor(relay), store);
    expect(check.status).toBe('green');                 // reachable
    expect(check.detail).not.toContain('stale');
    expect(check.detail).toContain('relay tip seq 1, this device seq 0');
  });

  it('RED (control): a halt that is not self-clearing keeps the daily cadence (no retry time)', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    await recordN(store, 2);
    await batcherFor(store, relay).flush();
    await store.setHalt({ reason: 'local_chain_gap', detail: 'x', at_ms: 1 });
    const report = await batcherFor(store, relay).flush();
    expect(report.outcome).toBe('halted');
    expect(report.retryAtMs).toBeNull();
  });

  it('a spurious batch_replay while the relay tip MATCHES this device resumes — no halt', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    await recordN(store, 2);
    await batcherFor(store, relay).flush();            // relay + device both at seq 1
    await recordN(store, 1);                            // one queued record (index 2)
    // Force ONE spurious refusal that routes to resync, while the relay's real tip stays seq 1.
    relay.script.push((r) => (r.path === '/v1/meter/batch'
      ? { status: 409, body: { error: 'batch_replay', expected_seq: 2, expected_prev_batch_hash: relay.tip.batch_hash, last_pe_hash: relay.tip.last_pe_hash } }
      : null));
    const log = vi.fn();
    const report = await batcherFor(store, relay, { log }).flush();
    expect(report.outcome).toBe('sent');                // resumed, not halted
    expect(await store.halt()).toBeNull();              // no false halt recorded
    expect(relay.accepted.at(-1)?.seq).toBe(2);         // the queued record batched as seq 2
    expect(log).toHaveBeenCalledWith('info', expect.stringContaining('relay tip matches this device'), expect.anything());
  });

  it('a stale relay_chain_diverged halt self-clears against a MATCHING tip and resumes queued records (nothing run on the box)', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    await recordN(store, 2);
    await batcherFor(store, relay).flush();            // in sync at seq 1
    await store.setHalt({ reason: 'relay_chain_diverged', detail: 'stale false positive', at_ms: 1 });
    await recordN(store, 1);                            // a queued record that must drain
    const log = vi.fn();
    const report = await batcherFor(store, relay, { log }).flush();
    expect(report.outcome).toBe('sent');                // resumed on its own
    expect(await store.halt()).toBeNull();              // stale halt cleared
    expect(relay.accepted.at(-1)?.seq).toBe(2);         // queued record batched
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('cleared a stale relay_chain_diverged halt'), expect.anything());
  });

  it('RED: a REAL divergence (relay holds a chain this device never made) keeps the halt — never cleared', async () => {
    const relay = new FakeMeterRelay();
    const other = new MemoryPeStore(TEST_DEVICE_ID);
    await recordN(other, 1, () => ({ who: 'someone else' }));
    await batcherFor(other, relay).flush();            // relay tip = a chain this device did not make
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    await recordN(store, 2);
    await store.setHalt({ reason: 'relay_chain_diverged', detail: 'genuine', at_ms: 1 });
    const report = await batcherFor(store, relay).flush();
    expect(report.outcome).toBe('halted');              // genuine mismatch stays halted
    expect(await store.halt()).toMatchObject({ reason: 'relay_chain_diverged' });
    expect(relay.accepted).toHaveLength(1);             // nothing of this device's was sent
  });

  it('RED: a halt with a DIFFERENT reason is never touched, even against a matching tip', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    await recordN(store, 2);
    await batcherFor(store, relay).flush();            // in sync at seq 1
    await store.setHalt({ reason: 'local_chain_gap', detail: 'x', at_ms: 1 });
    const report = await batcherFor(store, relay).flush();
    expect(report.outcome).toBe('halted');
    expect(await store.halt()).toMatchObject({ reason: 'local_chain_gap' });
  });

  it('RED: an UNREADABLE tip never clears a relay_chain_diverged halt (the match must actually be proven)', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    await recordN(store, 2);
    await batcherFor(store, relay).flush();            // in sync at seq 1
    await store.setHalt({ reason: 'relay_chain_diverged', detail: 'stale', at_ms: 1 });
    relay.script.push((r) => (r.path === '/v1/meter/tip' ? { status: 503, body: { error: 'down' } } : null));
    const report = await batcherFor(store, relay).flush();
    expect(report.outcome).toBe('halted');              // could not prove a match → stays halted
    expect(await store.halt()).toMatchObject({ reason: 'relay_chain_diverged' });
  });

  // The next two make the per-field hash checks LOAD-BEARING: a relay tip at the SAME seq but a
  // forked chain (different last PE, or different batch hash) must NEVER self-clear. Without these,
  // the guard could be weakened to `relay.seq === local.seq` alone and resume onto a foreign chain —
  // rewriting sealed PEs. (Each goes RED if its hash comparison is dropped.)
  it('RED (last_pe_hash is load-bearing): same seq, different last PE → the halt is NOT cleared', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    await recordN(store, 2);
    await batcherFor(store, relay).flush();            // in sync at seq 1
    relay.tip = { ...relay.tip, last_pe_hash: 'f'.repeat(64) };  // same seq, forked tip PE
    await store.setHalt({ reason: 'relay_chain_diverged', detail: 'same seq, different last PE', at_ms: 1 });
    const report = await batcherFor(store, relay).flush();
    expect(report.outcome).toBe('halted');
    expect(await store.halt()).toMatchObject({ reason: 'relay_chain_diverged' });
  });

  it('RED (batch_hash is load-bearing): same seq, different batch hash → the halt is NOT cleared', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    await recordN(store, 2);
    await batcherFor(store, relay).flush();            // in sync at seq 1
    relay.tip = { ...relay.tip, batch_hash: 'e'.repeat(64) };    // same seq + last PE, forked framing
    await store.setHalt({ reason: 'relay_chain_diverged', detail: 'same seq, different batch hash', at_ms: 1 });
    const report = await batcherFor(store, relay).flush();
    expect(report.outcome).toBe('halted');
    expect(await store.halt()).toMatchObject({ reason: 'relay_chain_diverged' });
  });
});

describe('429, 400, 403, 413, 5xx and no answer', () => {
  it('429 batch_too_soon: deferred until retry_after_ms; the same batch goes next time', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    await recordN(store, 1);
    relay.script.push((r) => (r.path === '/v1/meter/batch' ? { status: 429, body: { error: 'batch_too_soon', retry_after_ms: 123_000 } } : null));
    const b = batcherFor(store, relay);
    const r1 = await b.flush();
    expect(r1).toMatchObject({ outcome: 'deferred', retryAtMs: NOW + 123_000, lastStatus: 429 });
    expect(await store.inFlight()).not.toBeNull();
    await recordN(store, 1); // new PEs do not join the in-flight batch
    const r2 = await b.flush();
    expect(r2.batchesAccepted).toBe(1);
    expect(relay.batchPosts()[1].body).toBe(relay.batchPosts()[0].body);
    expect(relay.accepted[0].acts).toHaveLength(1);
    // The newer PE waits for the next batch, after the relay's 5-minute rule.
    expect(r2.retryAtMs).toBe(NOW + METER_RELAY_MIN_INTERVAL_MS + 5_000);
    expect((await meterStatusOf(store)).unsent).toBe(1);
  });

  it('429 rate limit (retry_after seconds) is honoured too', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    await recordN(store, 1);
    relay.script.push((r) => (r.path === '/v1/meter/batch' ? { status: 429, body: { error: 'Rate limit exceeded', retry_after: 90 } } : null));
    expect((await batcherFor(store, relay).flush()).retryAtMs).toBe(NOW + 90_000);
  });

  it('no answer / 5xx / 401: deferred with a growing backoff; the SAME batch stays in flight (outcome unknown)', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    await recordN(store, 2);
    const b = batcherFor(store, relay);
    relay.online = false;
    expect((await b.flush()).outcome).toBe('deferred'); // seal targets unreachable: nothing built yet
    relay.online = true;
    relay.script.push((r) => (r.path === '/v1/meter/batch' ? { status: 503, body: { error: 'batch_ingest_failed' } } : null));
    const r2 = await b.flush();
    expect(r2.lastStatus).toBe(503);
    relay.script.push((r) => (r.path === '/v1/meter/batch' ? { status: 401, body: { error: 'Invalid device credentials' } } : null));
    relay.now += 1_000; // a rebuilt batch would now differ (created_at_ms), so "the same bytes" is a real check
    const r3 = await b.flush();
    expect(r3.retryAtMs! - relay.now).toBeGreaterThan(r2.retryAtMs! - NOW);
    relay.now += 1_000;
    const r4 = await b.flush();
    expect(r4.outcome).toBe('sent');
    const bodies = relay.batchPosts().map((p) => p.body);
    expect(new Set(bodies).size).toBe(1); // never rebuilt while the outcome was unknown
  });

  it('RED: 400 batch_invalid halts (a PE is never changed to make a batch pass)', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    await recordN(store, 1);
    relay.script.push((r) => (r.path === '/v1/meter/batch' ? { status: 400, body: { error: 'batch_invalid', code: 'bad_act', act_index: 0 } } : null));
    const report = await batcherFor(store, relay).flush();
    expect(report.halt).toMatchObject({ reason: 'batch_invalid' });
    expect(report.halt?.detail).toContain('bad_act at act 0');
  });

  it('RED: 403 batch_device_mismatch halts', async () => {
    const store = new MemoryPeStore('dev_wrong');
    const relay = new FakeMeterRelay();
    await recordN(store, 1);
    expect((await batcherFor(store, relay).flush()).halt?.reason).toBe('batch_device_mismatch');
  });

  it('413: nothing was committed, so the batch is rebuilt smaller; RED: one PE alone too large halts', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    await recordN(store, 4);
    relay.script.push((r) => (r.path === '/v1/meter/batch' ? { status: 413, body: { error: 'PayloadTooLarge' } } : null));
    const report = await batcherFor(store, relay).flush();
    expect(report.batchesAccepted).toBe(1);
    expect(relay.accepted[0].acts.length).toBeLessThan(4);
    const single = new MemoryPeStore(TEST_DEVICE_ID);
    await recordN(single, 1);
    const big = new FakeMeterRelay();
    big.script.push((r) => (r.path === '/v1/meter/batch' ? { status: 413, body: {} } : null));
    expect((await batcherFor(single, big).flush()).halt?.reason).toBe('pe_too_large');
  });
});

describe('session lineage notes (carried)', () => {
  it('parses the relay note', () => {
    expect(parseLineageNote('lineage_rejected:session_ordinal_gap:expected_ordinal=7')).toEqual({ code: 'session_ordinal_gap', expectedOrdinal: 7 });
    expect(parseLineageNote('lineage_rejected:session_superseded:expected_ordinal=none')).toEqual({ code: 'session_superseded', expectedOrdinal: null });
    expect(parseLineageNote('lineage_rejected:lineage_signature_invalid')).toEqual({ code: 'lineage_signature_invalid', expectedOrdinal: null });
    expect(parseLineageNote('meter_act_older_than_30_days')).toBeNull();
    expect(parseLineageNote(undefined)).toBeNull();
  });

  it('a refused claim on the latest lineage-bearing act reaches onSessionLineageRejected with the relay\'s ordinal', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    await recordN(store, 2, (i) => (i === 1 ? { lineage_marker: true } : {}));
    relay.notes = { 1: 'lineage_rejected:session_ordinal_gap:expected_ordinal=4' };
    const seen: unknown[] = [];
    await batcherFor(store, relay, { onSessionLineageRejected: (info) => seen.push(info) }).flush();
    expect(seen).toEqual([{ code: 'session_ordinal_gap', expectedOrdinal: 4 }]);
  });

  it('RED control: when a LATER PE already carries a lineage claim, the stale refusal is not delivered (it would move the ordinal backwards)', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    await recordN(store, 1);
    // A later PE (not in this batch yet) from a newer session, with its own claim.
    const head = await store.head();
    const later = await buildPeV2({
      content: { action_type: 'compute_session', metadata: {}, compute: null, geo: null, execution_env: null, parent_goal_pe_id: null, economic_session_lineage: { v: 2, id: 'pesl2_newer', session_ordinal: 9 } },
      deviceId: TEST_DEVICE_ID, prevHash: head.last_pe_hash, timestampMs: NOW, peId: 'pe_later',
    });
    relay.notes = { 0: 'lineage_rejected:session_ordinal_gap:expected_ordinal=4' };
    const seen: unknown[] = [];
    const b = batcherFor(store, relay, { onSessionLineageRejected: (info) => seen.push(info), maxBatchBytes: 10_000_000 });
    // Send only PE 0 by appending the later PE after the batch is built: drive the in-flight batch first.
    relay.script.push((r) => (r.path === '/v1/meter/batch' ? { status: 503, body: {} } : null));
    await b.flush(); // batch {PE 0} now in flight
    expect((await store.append(later)).ok).toBe(true);
    await b.flush();
    expect(relay.accepted[0].acts).toHaveLength(1);
    expect(seen).toEqual([]);
  });
});

describe('sealed copies for the linked human', () => {
  it('each PE is sealed (its canonical JSON) to every seal target; only the matching secret opens it', async () => {
    const human = deriveMessageKeyPair('11'.repeat(32));
    const stranger = deriveMessageKeyPair('22'.repeat(32));
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    relay.sealTargets = [{ to: 'linked_human', party_id: 'wallet_human', pubkey_b64u: human.pubkeyB64u, key_version: 1 }];
    const pes = await recordN(store, 2);
    await batcherFor(store, relay).flush();
    const batch = postedBatch(relay, 0);
    expect(batch.sealed).toHaveLength(2);
    expect(batch.sealed!.map((s) => [s.to, s.pe_id])).toEqual(pes.map((p) => ['linked_human', p.pe.pe_id]));
    const opened = JSON.parse(openThreadMessage(human.secretKey, batch.sealed![0].box)) as PeV2;
    expect(canonicalJson(opened)).toBe(canonicalJson(pes[0].pe));
    expect(peHashOf(opened)).toBe(pes[0].pe.pe_hash);
    expect(() => openThreadMessage(stranger.secretKey, batch.sealed![0].box)).toThrow();
    // The sealed copies are outside the batch hash: the batch is the same record either way.
    const { sealed: _s, ...unsealed } = batch;
    expect(batchHashOf(unsealed as PeBatch)).toBe(batchHashOf(batch));
  });

  it('resends the original ciphertext after restart until ACK, without another pricing batch', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meter-transit-'));
    try {
      const human = deriveMessageKeyPair('11'.repeat(32));
      const relay = new FakeMeterRelay();
      relay.sealTargets = [{ to: 'linked_human', party_id: 'wallet_human', pubkey_b64u: human.pubkeyB64u, key_version: 1 }];
      const store = new FsPeStore(TEST_DEVICE_ID, dir);
      await recordN(store, 2);
      await batcherFor(store, relay).flush();
      const original = postedBatch(relay, 0);
      let complete = false;
      const resend = vi.fn(async () => ({ status: 200, body: { complete }, error: null }));
      const reopened = new FsPeStore(TEST_DEVICE_ID, dir);
      const batcher = new MeterBatcher({ store: reopened, transport: { ...transportFor(relay), resendTransit: resend }, now: () => relay.now });
      expect(await batcher.resendUnacknowledged()).toEqual({ resent: 1, acknowledged: 0 });
      expect(resend).toHaveBeenLastCalledWith(batchHashOf(original), original.sealed, undefined, undefined);
      complete = true;
      expect(await batcher.resendUnacknowledged()).toEqual({ resent: 1, acknowledged: 1 });
      expect(await batcher.resendUnacknowledged()).toEqual({ resent: 0, acknowledged: 0 });
      expect(relay.batchPosts()).toHaveLength(1);
      expect((await reopened.listBatches())[0].transit).toBeUndefined();
      expect(fs.readdirSync(path.join(reopened.location, 'transit'))).toEqual([]);
      expect((await reopened.readPes(0, 2)).map(p => p.pe.pe_hash)).toEqual(original.acts.map(a => a.pe_hash));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('persists a fair cursor past a rate-limited prefix without sending extra earning batches', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meter-transit-fair-'));
    try {
      const human = deriveMessageKeyPair('11'.repeat(32)), relay = new FakeMeterRelay();
      relay.sealTargets = [{ to: 'linked_human', party_id: 'wallet_human', pubkey_b64u: human.pubkeyB64u, key_version: 1 }];
      const store = new FsPeStore(TEST_DEVICE_ID, dir);
      for (let i = 0; i < 32; i++) {
        await recordN(store, 1); relay.now += 86_400_000;
        expect((await batcherFor(store, relay).flush()).outcome).toBe('sent');
      }
      const batches = await store.listBatches(); expect(batches).toHaveLength(32);
      let attempts = 0;
      const resend = vi.fn(async (_hash: string, _sealed: readonly unknown[], _receipt?: string, _recipients?: Readonly<Record<string, string>>) => ({ status: ++attempts <= 30 ? 200 : 429, body: { complete: false }, error: null }));
      const make = (held: FsPeStore) => new MeterBatcher({ store: held, transport: { ...transportFor(relay), resendTransit: resend }, now: () => relay.now });
      const first = make(store);
      expect(await first.resendUnacknowledged()).toEqual({ resent: 30, acknowledged: 0 });
      expect(resend.mock.calls).toHaveLength(31);
      expect(await store.transitCursor()).toBe(batches[30].batch_hash);
      // The first thirty remain unacked. Restarting must begin with the blocked tail.
      attempts = 0; resend.mockClear(); relay.now += 86_400_000;
      const next = make(new FsPeStore(TEST_DEVICE_ID, dir));
      await next.tick();
      expect(resend.mock.calls[0][0]).toBe(batches[30].batch_hash);
      expect(resend.mock.calls[1][0]).toBe(batches[31].batch_hash);
      const posts = relay.batchPosts().length;
      relay.now += 3_600_000; await next.tick();
      expect(relay.batchPosts()).toHaveLength(posts);
      expect(posts).toBe(32);
      expect((await store.transitAcknowledged()).size).toBe(0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 20_000);

  it('does not resend old ciphertext to a replacement beneficiary', async () => {
    const human = deriveMessageKeyPair('11'.repeat(32));
    const relay = new FakeMeterRelay();
    relay.sealTargets = [{ to: 'linked_human', party_id: 'wallet_human', pubkey_b64u: human.pubkeyB64u, key_version: 1 }];
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    await recordN(store, 1);
    await batcherFor(store, relay).flush();
    relay.sealTargets = [{ to: 'linked_human', party_id: 'wallet_replacement', pubkey_b64u: human.pubkeyB64u, key_version: 1 }];
    const resend = vi.fn();
    const next = new MeterBatcher({ store, transport: { ...transportFor(relay), resendTransit: resend }, now: () => relay.now });
    expect(await next.resendUnacknowledged()).toEqual({ resent: 0, acknowledged: 0 });
    expect(resend).not.toHaveBeenCalled();
    expect((await store.listBatches())[0].transit).toHaveLength(1);
  });

  it('no targets → no sealed copies; targets are cached (one fetch per hour)', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    await recordN(store, 1);
    const b = batcherFor(store, relay);
    await b.flush();
    await recordN(store, 1);
    relay.now += 6 * 60_000;
    await b.flush();
    expect(relay.accepted.every((x) => x.sealed === undefined)).toBe(true);
    expect(relay.requests.filter((r) => r.path === '/v1/meter/seal-targets')).toHaveLength(1);
  });
});

/** The relay's anchor leaf rule, replicated here only (provian-backend core/pvt/merkle.ts). */
function keccakHex(bytes: Buffer): string {
  return '0x' + keccak256(bytes).toString('hex');
}
function anchorLeaf(batchLeafHex: string): string {
  return keccakHex(Buffer.concat([Buffer.from([0x00]), Buffer.from(batchLeafHex, 'hex')]));
}
function anchorNode(a: string, b: string): string {
  const [x, y] = a <= b ? [a, b] : [b, a];
  return keccakHex(Buffer.concat([Buffer.from([0x01]), Buffer.from(x.slice(2), 'hex'), Buffer.from(y.slice(2), 'hex')]));
}
function anchorTree(leaves: string[]): { root: string; proofOf: (i: number) => string[]; leaves: string[] } {
  const layer0 = [...leaves];
  let size = 1;
  while (size < layer0.length) size *= 2;
  while (layer0.length < size) layer0.push(keccakHex(Buffer.alloc(0)));
  const layers = [layer0];
  while (layers[layers.length - 1].length > 1) {
    const cur = layers[layers.length - 1];
    const next: string[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(anchorNode(cur[i], cur[i + 1]));
    layers.push(next);
  }
  return {
    root: layers[layers.length - 1][0],
    leaves: layer0,
    proofOf: (index) => {
      const proof: string[] = [];
      let i = index;
      for (let l = 0; l < layers.length - 1; l++) { proof.push(layers[l][i % 2 === 0 ? i + 1 : i - 1]); i = Math.floor(i / 2); }
      return proof;
    },
  };
}
function verifyAnchor(leafHash: string, proof: readonly string[], root: string): boolean {
  let node = leafHash;
  for (const sibling of proof) node = anchorNode(node, sibling);
  return node === root;
}

describe('proofs — fetched daily, kept with the batch; an act proven end to end', () => {
  it('act → acts_root (from the device\'s own PEs) → batch leaf → the anchored day root', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    const pes = await recordN(store, 3);
    await batcherFor(store, relay).flush();
    await recordN(store, 2);
    relay.now += 10 * 60_000;
    await batcherFor(store, relay).flush();
    expect(relay.accepted).toHaveLength(2);
    // The day's anchor over every batch leaf that day (plus another device's), relay leaf rule.
    const receipts = [await store.readReceipt(1), await store.readReceipt(2)];
    const dayLeaves = [receipts[0]!.batch_leaf, 'ab'.repeat(32), receipts[1]!.batch_leaf];
    const tree = anchorTree(dayLeaves.map(anchorLeaf));
    relay.proofs = receipts.map((r, k) => {
      const index = k === 0 ? 0 : 2;
      return {
        seq: r!.seq, batch_hash: r!.batch_hash, batch_leaf: r!.batch_leaf, acts_root: r!.acts_root, actor_id: r!.actor_id,
        anchor: { day: '2026-10-03', anchor_batch_id: '0x' + '9'.repeat(64), leaf_index: index, leaf_count: 3, leaf_hash: tree.leaves[index], proof: tree.proofOf(index), merkle_root: tree.root, anchor_tx_hash: '0x' + '7'.repeat(64), anchored_at_ms: relay.now },
      };
    });
    const fetched = await batcherFor(store, relay).fetchProofs();
    expect(fetched).toEqual({ ok: true, fetched: 2, unverified: 0, receivedKept: 0 });
    expect((await store.listProofs()).map((p) => [p.seq, p.verified])).toEqual([[1, true], [2, true]]);

    const result = await actInclusionProofFor(store, pes[1].pe.pe_id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.anchored).toBe(true);
    const hop1 = verifyActInclusion(pes[1].pe, result.proof);
    expect(hop1.ok).toBe(true);
    if (!hop1.ok) return;
    expect(hop1.batch_leaf).toBe(receipts[0]!.batch_leaf);
    const anchor = result.proof.anchor!;
    expect(anchor.contract).toBe('0x889A59A847e490c5Cc91f281468AbAacc100a9fD');
    expect(verifyAnchor(anchorLeaf(hop1.batch_leaf), anchor.proof, anchor.merkle_root)).toBe(true);

    // RED controls: a changed PE fails hop 1; a changed sibling fails hop 2.
    const tampered = { ...pes[1].pe, metadata: { tool_count: 99 } };
    expect(verifyActInclusion(tampered, result.proof).ok).toBe(false);
    const badPath = [...anchor.proof];
    badPath[0] = '0x' + '0'.repeat(64);
    expect(verifyAnchor(anchorLeaf(hop1.batch_leaf), badPath, anchor.merkle_root)).toBe(false);
    // Re-fetching holds nothing twice.
    expect((await batcherFor(store, relay).fetchProofs()).fetched).toBe(0);
  });

  it('RED: a relay proof whose batch leaf does not recompute from this device\'s record is kept as unverified', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    await recordN(store, 1);
    await batcherFor(store, relay).flush();
    const r = (await store.readReceipt(1))!;
    relay.proofs = [{ seq: 1, batch_hash: r.batch_hash, batch_leaf: 'cd'.repeat(32), acts_root: r.acts_root, actor_id: r.actor_id, anchor: { day: 'd', anchor_batch_id: '0x', leaf_index: 0, leaf_count: 1, leaf_hash: '0x', proof: [], merkle_root: '0x', anchor_tx_hash: null, anchored_at_ms: 1 } }];
    expect(await batcherFor(store, relay).fetchProofs()).toEqual({ ok: true, fetched: 1, unverified: 1, receivedKept: 0 });
    expect((await store.listProofs())[0].verified).toBe(false);
  });

  it('a PE not yet batched has no proof', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const [p] = await recordN(store, 1);
    expect(await actInclusionProofFor(store, p.pe.pe_id)).toEqual({ ok: false, reason: 'not_batched_yet' });
    expect(await actInclusionProofFor(store, 'pe_nope')).toEqual({ ok: false, reason: 'pe_not_found' });
  });
});

describe('received-PE batch proofs — fetched in the daily proofs step and KEPT (PE export)', () => {
  async function receivedFixture() {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    const draft: PeV2 = { schema: PE_V2_SCHEMA, pe_id: 'pe_relay_1', device_id: 'relay:a1', prev_hash: METER_GENESIS_PREV_HASH, timestamp: NOW, action_type: 'receive' };
    const pe = { ...draft, pe_hash: peHashOf(draft) };
    const b = buildBatch({ device_id: 'relay:a1', seq: 1, prev_batch_hash: METER_GENESIS_PREV_HASH, created_at_ms: NOW, pes: [pe] });
    const batch_hash = batchHashOf(b);
    const leaf = batchLeafOf({ device_id: 'relay:a1', actor_id: TEST_ACTOR_ID, seq: 1, batch_hash, acts_root: b.acts_root });
    await store.recordReceived({
      mailbox_id: 'mb_r', pe_id: pe.pe_id, pe, pe_hash: pe.pe_hash, hash_checked: true, from_device: 'relay:a1',
      from_actor: TEST_ACTOR_ID, batch_hash, created_at_ms: NOW, received_at_ms: NOW,
    });
    const record = {
      batch_hash, device_id: 'relay:a1', actor_id: TEST_ACTOR_ID, seq: 1, acts_root: b.acts_root, batch_leaf: leaf, day: '2026-10-03',
      accepted_at_ms: NOW, anchored: false, chain_id: 8453, anchor_contract: PE_EXPORT_PE_ANCHOR, anchor: null as unknown,
      act_leaves: [actLeafOf(actRecordOf(pe))],
    };
    const anchor = {
      day: '2026-10-03', anchor_batch_id: meterAnchorBatchIdOf('2026-10-03'), leaf_index: 0, leaf_count: 1, leaf_hash: anchoredLeafOf(leaf),
      proof: [] as string[], merkle_root: anchoredLeafOf(leaf), anchor_tx_hash: '0x' + '7'.repeat(64), anchored_at_ms: NOW,
    };
    return { store, relay, record, anchor, batch_hash };
  }
  const batchProofRequests = (relay: FakeMeterRelay): number => relay.requests.filter((r) => r.path === '/v1/meter/batch-proofs').length;

  it('keeps the record once the day is anchored, and never asks for a kept one again', async () => {
    const { store, relay, record, anchor, batch_hash } = await receivedFixture();
    relay.batchRecords[batch_hash] = record;
    expect((await batcherFor(store, relay).fetchProofs()).receivedKept).toBe(0); // not anchored yet: asked again tomorrow
    expect(await store.listReceivedProofs()).toEqual([]);
    relay.batchRecords[batch_hash] = { ...record, anchored: true, anchor };
    expect((await batcherFor(store, relay).fetchProofs()).receivedKept).toBe(1);
    expect((await store.listReceivedProofs()).map((p) => [p.batch_hash, p.anchored])).toEqual([[batch_hash, true]]);
    const asked = batchProofRequests(relay);
    expect(asked).toBe(2);
    await batcherFor(store, relay).fetchProofs();
    expect(batchProofRequests(relay)).toBe(asked);
  });

  it('RED: a record whose anchor path does not fold to its root, or names another device, is not kept', async () => {
    const { store, relay, record, anchor, batch_hash } = await receivedFixture();
    relay.batchRecords[batch_hash] = { ...record, anchored: true, anchor: { ...anchor, merkle_root: '0x' + '33'.repeat(32) } };
    expect((await batcherFor(store, relay).fetchProofs()).receivedKept).toBe(0);
    relay.batchRecords[batch_hash] = { ...record, device_id: 'relay:other', anchored: true, anchor };
    expect((await batcherFor(store, relay).fetchProofs()).receivedKept).toBe(0);
    expect(await store.listReceivedProofs()).toEqual([]);
    // The control: the same record, correct, is kept.
    relay.batchRecords[batch_hash] = { ...record, anchored: true, anchor };
    expect((await batcherFor(store, relay).fetchProofs()).receivedKept).toBe(1);
  });
});

describe('mailbox — PEs sealed to this agent are filed, verified, then acknowledged', () => {
  function sealedItem(pe: PeV2, pubkeyB64u: string, id: string): Record<string, unknown> {
    const box = sealThreadMessage(canonicalJson(pe), { p: pubkeyB64u }).ciphertexts.p;
    return { id, to: 'agent:a1', pe_id: pe.pe_id, box, from_device: 'dev_phone', from_actor: 'human_1', batch_hash: 'h', created_at_ms: NOW };
  }

  it('opens with the agent\'s message key, files the PE (outside this device\'s chain), acks; leaves what it cannot open', async () => {
    const agent = deriveMessageKeyPair('33'.repeat(32));
    const other = deriveMessageKeyPair('44'.repeat(32));
    const foreignStore = new MemoryPeStore('dev_other');
    const [theirs] = await recordN(foreignStore, 1);
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    const forged = { ...theirs.pe, metadata: { forged: true } }; // keeps the old pe_hash: mismatch
    relay.mailbox = [
      sealedItem(theirs.pe, agent.pubkeyB64u, 'mb_ok'),
      sealedItem(theirs.pe, other.pubkeyB64u, 'mb_wrong_key'),
      sealedItem(forged as PeV2, agent.pubkeyB64u, 'mb_forged'),
    ];
    const keyCopy = new Uint8Array(agent.secretKey);
    const report = await batcherFor(store, relay, { messageSecretKey: async () => new Uint8Array(keyCopy) }).drainMailbox();
    expect(report).toMatchObject({ ok: true, received: 1, acked: 1, unopenable: 2 });
    const received = await store.listReceived();
    expect(received.map((r) => [r.mailbox_id, r.pe_hash, r.hash_checked])).toEqual([['mb_ok', theirs.pe.pe_hash, true]]);
    expect((await store.head()).count).toBe(0); // not part of this device's own chain
    expect(relay.mailbox.map((m) => m.id)).toEqual(['mb_wrong_key', 'mb_forged']);
    // Filed once even if the relay hands it out again (an ack lost in transit).
    relay.mailbox.push(sealedItem(theirs.pe, agent.pubkeyB64u, 'mb_ok'));
    const again = await batcherFor(store, relay, { messageSecretKey: async () => new Uint8Array(keyCopy) }).drainMailbox();
    expect(again).toMatchObject({ received: 0, acked: 1 });
    expect(await store.listReceived()).toHaveLength(1);
  });

  it('a pre-meter (v1) PE handed back by the relay is filed verbatim in legacy, once; RED: a v1 box naming another id is left', async () => {
    const agent = deriveMessageKeyPair('33'.repeat(32));
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    const v1 = { id: 'pe_legacy_1', hash: 'ab'.repeat(32), prev_hash: 'genesis', timestamp: NOW - 1000, action_type: 'coding_session', user_id: 'atlas' };
    const box = (body: Record<string, unknown>) => sealThreadMessage(canonicalJson(body), { p: agent.pubkeyB64u }).ciphertexts.p;
    relay.mailbox = [
      { id: 'mb_legacy', to: 'agent:a1', pe_id: 'pe_legacy_1', box: box(v1), from_device: 'relay:atlas', from_actor: 'atlas', batch_hash: '', created_at_ms: NOW },
      { id: 'mb_wrong_id', to: 'agent:a1', pe_id: 'pe_other', box: box(v1), from_device: 'relay:atlas', from_actor: 'atlas', batch_hash: '', created_at_ms: NOW },
    ];
    const keyCopy = new Uint8Array(agent.secretKey);
    const report = await batcherFor(store, relay, { messageSecretKey: async () => new Uint8Array(keyCopy) }).drainMailbox();
    expect(report).toMatchObject({ ok: true, received: 1, acked: 1, unopenable: 1 });
    expect((await store.listLegacy()).map((l) => [l.pe_id, l.envelope.hash])).toEqual([['pe_legacy_1', v1.hash]]);
    expect(await store.listReceived()).toHaveLength(0);
    expect(relay.mailbox.map((m) => m.id)).toEqual(['mb_wrong_id']);
    relay.mailbox = [{ id: 'mb_legacy_again', to: 'agent:a1', pe_id: 'pe_legacy_1', box: box(v1), created_at_ms: NOW }];
    const again = await batcherFor(store, relay, { messageSecretKey: async () => new Uint8Array(keyCopy) }).drainMailbox();
    expect(again).toMatchObject({ received: 0, acked: 1 });
    expect(await store.listLegacy()).toHaveLength(1);
  });

  it('checks one head, skips unchanged mailboxes, and notices arrivals during a drain', async () => {
    const relay = new FakeMeterRelay(), store = new MemoryPeStore(TEST_DEVICE_ID), base = transportFor(relay);
    let version = 'first'; const peekMailbox = vi.fn(async () => ({ status: 200, error: null, body: { version } }));
    const getMailbox = vi.fn(base.getMailbox), transport = { ...base, peekMailbox, getMailbox };
    const b = batcherFor(store, relay, { transport, messageSecretKey: async () => new Uint8Array(32) });
    await b.checkMailbox(); expect(getMailbox).toHaveBeenCalledTimes(1);
    await b.checkMailbox(); expect(getMailbox).toHaveBeenCalledTimes(1); expect(peekMailbox).toHaveBeenCalledTimes(2);
    version = 'second'; getMailbox.mockImplementationOnce(async () => { version = 'third'; return { status: 200, error: null, body: { items: [], next_after: null } }; });
    await b.checkMailbox(); await b.checkMailbox(); expect(getMailbox).toHaveBeenCalledTimes(3);
    await b.checkMailbox(); expect(getMailbox).toHaveBeenCalledTimes(3);
  });
  it('never caches malformed items, failed acknowledgements, unavailable heads, or absent keys', async () => {
    const relay = new FakeMeterRelay(), store = new MemoryPeStore(TEST_DEVICE_ID), base = transportFor(relay);
    const peekMailbox = vi.fn(async () => ({ status: 200, error: null, body: { version: 'unchanged' } })), getMailbox = vi.fn(base.getMailbox);
    const transport = { ...base, peekMailbox, getMailbox }, agent = deriveMessageKeyPair('33'.repeat(32));
    const b = batcherFor(store, relay, { transport, messageSecretKey: async () => new Uint8Array(agent.secretKey) });
    relay.mailbox = [{ malformed: true }]; await b.checkMailbox(); await b.checkMailbox(); expect(getMailbox).toHaveBeenCalledTimes(2);
    const [theirs] = await recordN(new MemoryPeStore('dev_other'), 1); relay.mailbox = [sealedItem(theirs.pe, agent.pubkeyB64u, 'ack_failure')];
    transport.ackMailbox = vi.fn(async () => ({ status: 503, error: null, body: {} }));
    await b.checkMailbox(); await b.checkMailbox(); expect(transport.ackMailbox).toHaveBeenCalledTimes(2);
    relay.mailbox = []; peekMailbox.mockImplementation(async () => ({ status: 404, error: null, body: { version: '' } }));
    await b.checkMailbox(); await b.checkMailbox(); expect(getMailbox).toHaveBeenCalledTimes(6);
    const key = vi.fn(async (): Promise<Uint8Array | null> => null), noKey = batcherFor(store, relay, { transport, messageSecretKey: key });
    peekMailbox.mockImplementation(async () => ({ status: 200, error: null, body: { version: 'unchanged' } }));
    await noKey.checkMailbox(); await noKey.checkMailbox(); expect(key).toHaveBeenCalledTimes(2);
  });

  it('no wallet key on this machine: the mailbox is skipped, logged once, nothing acked', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    relay.mailbox = [{ id: 'mb_1', pe_id: 'pe_1', box: 'x' }];
    const log = vi.fn();
    const b = batcherFor(store, relay, { log });
    expect(await b.drainMailbox()).toMatchObject({ skipped: 'no_key' });
    await b.drainMailbox();
    expect(log.mock.calls.filter((c) => String(c[1]).includes('mailbox items stay on the relay'))).toHaveLength(1);
    expect(relay.requests.filter((r) => r.path.startsWith('/v1/meter/mailbox'))).toHaveLength(0);
  });
});

describe('status (doctor) and the daemon wiring', () => {
  it('reports PEs stored and where, last batch seq/time/totals, unsent, proofs, mailbox; red only when halted', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    await recordN(store, 3);
    await batcherFor(store, relay).flush();
    await recordN(store, 2);
    const status = await meterStatusOf(store);
    expect(status).toMatchObject({ pes_stored: 5, unsent: 2, last_batch: { seq: 1, acts: 3, accepted_at_ms: NOW }, proofs_fetched: 0, mailbox_received: 0, halted: null });
    expect(describeMeterStatus(status)).toContain('5 PE(s) stored at memory');
    const check = await peStoreCheck(store);
    expect(check.status).toBe('green');
    expect(check.detail).toContain('proving an act requires keeping its PE');
    await store.setHalt({ reason: 'relay_chain_diverged', detail: 'x', at_ms: 1 });
    expect((await peStoreCheck(store)).status).toBe('red');
    expect((await peStoreCheck(null)).status).toBe('skip');
  });

  it('the daemon (meterBatching) migrates the legacy outbox, says where PEs live once, and sends the first batch at start', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meter-daemon-'));
    const outboxDir = path.join(home, 'pe-outbox');
    fs.mkdirSync(outboxDir);
    fs.writeFileSync(path.join(outboxDir, '000000000000001-aa.json'), JSON.stringify({
      v: 1, id: '000000000000001-aa', idempotency_key: 'pe_' + '5'.repeat(32), body: { action_type: 'coding_session', metadata: { commit_sha: 'abc' } },
      created_at_ms: 1, attempts: 1, next_attempt_at_ms: 1, last_status: null, last_error: null,
    }));
    const relay = new FakeMeterRelay();
    vi.stubGlobal('fetch', relay.fetch);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const make = (): ProvianObserver => new ProvianObserver({
      idleThresholdMs: 30_000, maxSessionMs: 900_000, tickIntervalMs: 2_000_000_000, plugins: [],
      relayUrl: 'https://relay.test', logLevel: 'error',
      credentials: { deviceKey: 'pdk_test', deviceSecret: 'pds_test', relayUrl: 'https://relay.test', deviceId: TEST_DEVICE_ID },
      sessionOrdinalPath: path.join(home, 'ordinal.json'),
      peOutboxDir: outboxDir, peStoreDir: path.join(home, 'pe-store'), meterBatching: true,
    });
    const o1 = make();
    await o1.start();
    await vi.waitFor(() => expect(relay.accepted).toHaveLength(1));
    await o1.stop();
    expect(fs.existsSync(`${outboxDir}.migrated`)).toBe(true);
    expect(relay.accepted[0].acts[0].action_type).toBe('coding_session');
    const notices = () => log.mock.calls.filter((c) => String(c[0]).includes('Your PEs live on this machine'));
    expect(notices()).toHaveLength(1);
    expect(String(notices()[0][0])).toContain(path.join(home, 'pe-store', TEST_DEVICE_ID));
    const o2 = make();
    await o2.start();
    await o2.stop();
    expect(notices()).toHaveLength(1); // once
    vi.unstubAllGlobals();
  });

  it('RED control: without meterBatching (tests, embedders) nothing is sent', async () => {
    const relay = new FakeMeterRelay();
    vi.stubGlobal('fetch', relay.fetch);
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    await recordN(store, 1);
    const o = new ProvianObserver({
      idleThresholdMs: 30_000, maxSessionMs: 900_000, tickIntervalMs: 2_000_000_000, plugins: [],
      relayUrl: 'https://relay.test', logLevel: 'error', peStore: store,
      credentials: { deviceKey: 'pdk_test', deviceSecret: 'pds_test', relayUrl: 'https://relay.test', deviceId: TEST_DEVICE_ID },
    });
    await o.start();
    await o.stop();
    expect(relay.batchPosts()).toHaveLength(0);
    vi.unstubAllGlobals();
  });
});

// one batch per DAY, plus immediately before any presentation or payout.
describe('daily cadence, pre-use flush and the cross-process send lock', () => {
  it('after a send the next scheduled batch is a day away (was an hour)', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    await recordN(store, 2);
    const b = batcherFor(store, relay);
    await b.tick();
    expect(relay.batchPosts()).toHaveLength(1);
    await recordN(store, 1);
    relay.now += 60 * 60 * 1000 + 1; // an hour later: not due any more
    await b.tick();
    expect(relay.batchPosts()).toHaveLength(1);
    relay.now += 23 * 60 * 60 * 1000; // a day after the send: due
    await b.tick();
    expect(relay.batchPosts()).toHaveLength(2);
  });

  it('flushBeforeUse waits out the relay\'s 5-minute rule once, then sends the latest acts', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    await recordN(store, 2);
    const b = batcherFor(store, relay);
    await b.flush();
    await recordN(store, 1);
    relay.script.push((req) => (req.method === 'POST' && req.path === '/v1/meter/batch'
      ? { status: 429, body: { error: 'batch_too_soon', retry_after_ms: 120_000 } } : null));
    const slept: number[] = [];
    const report = await b.flushBeforeUse({ sleep: async (ms) => { slept.push(ms); relay.now += ms; } });
    expect(slept).toEqual([120_000]);
    expect(report.outcome).toBe('sent');
    expect(relay.accepted.map((a) => a.acts.length)).toEqual([2, 1]);
  });

  it('RED control: without the 429, flushBeforeUse never sleeps', async () => {
    const store = new MemoryPeStore(TEST_DEVICE_ID);
    const relay = new FakeMeterRelay();
    await recordN(store, 2);
    const slept: number[] = [];
    await batcherFor(store, relay).flushBeforeUse({ sleep: async (ms) => { slept.push(ms); } });
    expect(slept).toEqual([]);
  });

  it(' an execve predecessor lock is reclaimed on the first tick (RED: no 15 minute wait)', async () => {
    const { performance } = await import('node:perf_hooks');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meter-execve-lock-'));
    const store = new FsPeStore(TEST_DEVICE_ID, root);
    const relay = new FakeMeterRelay();
    await recordN(store, 2);
    fs.writeFileSync(path.join(store.location, 'send.lock'), `${process.pid}:${Math.floor(performance.timeOrigin) - 1}`);
    await batcherFor(store, relay).tick();
    expect(relay.batchPosts()).toHaveLength(1);
    expect(fs.existsSync(path.join(store.location, 'send.lock'))).toBe(false);
  });

  it('while another process holds the send lock, the daemon\'s tick sends nothing and looks again in a minute', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meter-lock-'));
    const store = new FsPeStore(TEST_DEVICE_ID, root);
    const relay = new FakeMeterRelay();
    await recordN(store, 2);
    // A live holder: this very process's pid (the lock is not syncOnly, so it is respected).
    fs.writeFileSync(path.join(store.location, 'send.lock'), `${process.pid}:${Date.now()}`);
    const b = batcherFor(store, relay);
    await b.tick();
    expect(relay.batchPosts()).toHaveLength(0);
    fs.unlinkSync(path.join(store.location, 'send.lock'));
    relay.now += 61_000;
    await b.tick();
    expect(relay.batchPosts()).toHaveLength(1);
    expect(fs.existsSync(path.join(store.location, 'send.lock'))).toBe(false);
  });
});
