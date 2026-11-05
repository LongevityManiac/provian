/**
 * PE export (provian.pe-export.v1) — the agent half: one action exports every PE the agent owns,
 * and the verifier checks it with nothing but a Base RPC.
 *
 * The fixture is a real filesystem store tree (two device directories are possible; here one local
 * device) holding every record type: PEs held here, PEs dropped after their day was archived
 * (pointers), an unbatched PE, two accepted batches with receipts and anchor proofs, PEs sealed to
 * the agent from two batches (one whose kept record carries act leaves, one fetched at export time
 * without them, rebuilt from the copies), a pre-meter record, and an Archive holding the dropped day
 * plus another machine's chain. Every keccak/sha256 convention is the wire's own (pinned to a real
 * anchored batch in pe-export-wire.test.ts); day trees are built here with viem as an independent
 * keccak.
 *
 * RED controls: a corrupted pes.jsonl line fails the self-check; a received PE with no obtainable
 * proof is `proof_unavailable` and listed; an archived copy that differs from the pointer is not
 * emitted and is listed; the verifier refuses a tampered file and a root Base does not hold, and
 * contacts only the RPC host.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodePacked, keccak256 } from 'viem';
import {
  actLeafOf,
  actRecordOf,
  batchHashOf,
  batchLeafOf,
  buildBatch,
  METER_GENESIS_PREV_HASH,
  peHashOf,
  PE_V2_SCHEMA,
  type PeV2,
} from '../meter-wire';
import {
  anchoredLeafOf,
  getBatchCalldata,
  meterAnchorBatchIdOf,
  parseExport,
  PE_EXPORT_PE_ANCHOR,
  verifyExportOffline,
  type ExportBodyLine,
} from '../pe-export-wire';
import { buildArchiveEntries, type ArchiveBatchInput, type ArchivePayload } from '../pe-archive-wire';
import { drainMailboxForExport, exportPesToFile, listLocalDeviceStores, mailboxIncompleteOf, selfCheckPeExport, type PeExportArchiveSource } from './export';
import { MeterBatcher } from './batcher';
import { createHttpMeterTransport } from './transport';
import { FakeMeterRelay } from './capturing-store.test-support';
import { canonicalJson } from '../meter-wire';
import { deriveMessageKeyPair, sealThreadMessage } from '../thread-crypto';
import { verifyPeExportFile } from './export-verify';
import { FsPeStore, MemoryPeStore, type MeterAnchorProofWire, type ReceivedBatchProof, type StoredPeV2 } from './pe-store';
import { keepReceivedProofs } from './received-proofs';
import type { MeterAnswer } from './transport';

const DEV_A = 'dev_' + 'a1'.repeat(32);
const DEV_B = 'dev_' + 'b2'.repeat(32);
const DEV_C = 'dev_' + 'c3'.repeat(32);
const RELAY_DEV = 'relay:owner';
const OWNER = 'wallet_aw_owner';
const D1 = '2026-09-01';
const D2 = '2026-09-02';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-export-'));
  tmpDirs.push(d);
  return d;
}

function chainOf(deviceId: string, n: number, tag: string): StoredPeV2[] {
  const out: StoredPeV2[] = [];
  let prev = METER_GENESIS_PREV_HASH;
  for (let i = 0; i < n; i++) {
    const draft: PeV2 = {
      schema: PE_V2_SCHEMA, pe_id: `pe_${tag}_${i}`, device_id: deviceId, prev_hash: prev,
      timestamp: 1_788_000_000_000 + i * 1000, action_type: 'coding_session', description: `${tag} act ${i}`,
      metadata: { turn: i },
    };
    const pe = { ...draft, pe_hash: peHashOf(draft), signature: 'p256sig' } as StoredPeV2;
    out.push(pe);
    prev = pe.pe_hash;
  }
  return out;
}

interface BatchFx {
  device_id: string;
  actor_id: string;
  seq: number;
  first: number;
  pes: StoredPeV2[];
  batch_hash: string;
  acts_root: string;
  batch_leaf: string;
}

function batchFx(deviceId: string, actorId: string, seq: number, first: number, pes: StoredPeV2[]): BatchFx {
  const b = buildBatch({ device_id: deviceId, seq, prev_batch_hash: METER_GENESIS_PREV_HASH, created_at_ms: 1_788_000_100_000 + seq, pes });
  const batch_hash = batchHashOf(b);
  return {
    device_id: deviceId, actor_id: actorId, seq, first, pes, batch_hash, acts_root: b.acts_root,
    batch_leaf: batchLeafOf({ device_id: deviceId, actor_id: actorId, seq, batch_hash, acts_root: b.acts_root }),
  };
}

/** A day tree the way the relay builds it (keccak, 0x00 leaves, 0x01 sorted pairs, padded). */
function dayTree(day: string, leaves: string[]): { root: string; anchorOf: (i: number) => MeterAnchorProofWire } {
  let layer = leaves.map((l) => anchoredLeafOf(l));
  let size = 1;
  while (size < layer.length) size *= 2;
  while (layer.length < size) layer.push(keccak256('0x'));
  const layers = [layer];
  while (layer.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const [a, b] = layer[i] <= layer[i + 1] ? [layer[i], layer[i + 1]] : [layer[i + 1], layer[i]];
      next.push(keccak256(encodePacked(['bytes1', 'bytes32', 'bytes32'], ['0x01', a as `0x${string}`, b as `0x${string}`])));
    }
    layers.push(next);
    layer = next;
  }
  const root = layer[0];
  return {
    root,
    anchorOf: (idx: number) => {
      const proof: string[] = [];
      let i = idx;
      for (let lv = 0; lv < layers.length - 1; lv++) {
        proof.push(layers[lv][i % 2 === 0 ? i + 1 : i - 1]);
        i = Math.floor(i / 2);
      }
      return {
        day, anchor_batch_id: meterAnchorBatchIdOf(day), leaf_index: idx, leaf_count: leaves.length,
        leaf_hash: anchoredLeafOf(leaves[idx]), proof, merkle_root: root, anchor_tx_hash: '0x' + '11'.repeat(32), anchored_at_ms: 5,
      };
    },
  };
}

function archiveInput(b: BatchFx, anchor: MeterAnchorProofWire): ArchiveBatchInput {
  return {
    device_id: b.device_id, actor_id: b.actor_id, seq: b.seq, batch_hash: b.batch_hash, acts_root: b.acts_root,
    batch_leaf: b.batch_leaf, first_index: b.first, pes: b.pes,
    anchor: { day: anchor.day, anchor_batch_id: anchor.anchor_batch_id, leaf_index: anchor.leaf_index, proof: [...anchor.proof], merkle_root: anchor.merkle_root, tx_hash: anchor.anchor_tx_hash },
  };
}

function answerOf(b: BatchFx, anchor: MeterAnchorProofWire | null, withLeaves: boolean): Record<string, unknown> {
  return {
    batch_hash: b.batch_hash, device_id: b.device_id, actor_id: b.actor_id, seq: b.seq, acts_root: b.acts_root,
    batch_leaf: b.batch_leaf, day: anchor?.day ?? null, accepted_at_ms: 9, anchored: anchor !== null, chain_id: 8453,
    anchor_contract: PE_EXPORT_PE_ANCHOR, anchor,
    act_leaves: withLeaves ? b.pes.map((p) => actLeafOf(actRecordOf(p))) : null,
  };
}

/** The mailbox after a drain that filed everything (nothing left waiting on the relay). */
const DRAINED = { waiting: 0, truncated: false, reason: null } as const;

async function fixture(options: { readonly missingReceived?: boolean; readonly tamperArchiveIndex?: number; readonly noOtherMachine?: boolean } = {}) {
  const root = tmp();
  const store = new FsPeStore(DEV_A, root);
  const chainA = chainOf(DEV_A, 6, 'a');
  for (const pe of chainA) {
    const r = await store.append(pe, { recordedAtMs: 1 });
    if (!r.ok) throw new Error('append');
  }
  const a1 = batchFx(DEV_A, OWNER, 1, 0, chainA.slice(0, 3));
  const a2 = batchFx(DEV_A, OWNER, 2, 3, chainA.slice(3, 5));
  // Received: a relay-authored PE (its record kept, with act leaves) and two PEs from another of the
  // owner's devices (record fetched at export time, without act leaves).
  const relayPe = chainOf(RELAY_DEV, 1, 'relay');
  const r1 = batchFx(RELAY_DEV, OWNER, 1, 0, relayPe);
  const chainC = chainOf(DEV_C, 2, 'c');
  const r2 = batchFx(DEV_C, OWNER, 1, 0, chainC);
  const chainB = chainOf(DEV_B, 2, 'b');
  const b1 = batchFx(DEV_B, OWNER, 1, 0, chainB);
  const day1 = dayTree(D1, [a1.batch_leaf, a2.batch_leaf, r1.batch_leaf, r2.batch_leaf]);
  const day2 = dayTree(D2, [b1.batch_leaf]);

  for (const [k, b] of [a1, a2].entries()) {
    await store.recordBatch({
      seq: b.seq, batch_hash: b.batch_hash, prev_batch_hash: k === 0 ? METER_GENESIS_PREV_HASH : a1.batch_hash, acts_root: b.acts_root,
      first_index: b.first, count: b.pes.length, last_pe_hash: b.pes[b.pes.length - 1].pe_hash, created_at_ms: 1, accepted_at_ms: 2,
      actor_id: OWNER, totals: { eligible_points_atomic: '0', acts: b.pes.length, eligible: b.pes.length },
    }, {
      schema: 'provian.pe-batch-receipt.v1', device_id: DEV_A, actor_id: OWNER, seq: b.seq, batch_hash: b.batch_hash, acts_root: b.acts_root,
      batch_leaf: b.batch_leaf, accepted_at_ms: 2,
      acts: b.pes.map((p, i) => ({ pe_id: p.pe_id, pe_hash: p.pe_hash, relay_pe_id: `r_${p.pe_id}`, leaf_index: i, disposition: 'eligible', reason: 'ok', record_points_atomic: '1', mint_status: null })),
      totals: { eligible_points_atomic: '0', acts: b.pes.length, eligible: b.pes.length },
    });
    await store.recordProof({
      seq: b.seq, batch_hash: b.batch_hash, batch_leaf: b.batch_leaf, acts_root: b.acts_root, actor_id: OWNER,
      anchor: day1.anchorOf(k), fetched_at_ms: 3, verified: true,
    });
  }
  // Day D1's first batch is confirmed in the Archive and dropped here (pointers left).
  await store.dropArchivedDay({ day: D1, wallet: OWNER, part_sha256s: ['aa'.repeat(32)], pes: a1.pes.map((p, i) => ({ index: i, pe_id: p.pe_id, pe_hash: p.pe_hash })) });

  const receivedRow = (mailbox: string, b: BatchFx, pe: StoredPeV2) => ({
    mailbox_id: mailbox, pe_id: pe.pe_id, pe, pe_hash: pe.pe_hash, hash_checked: true, from_device: b.device_id,
    from_actor: OWNER, batch_hash: b.batch_hash, created_at_ms: 4, received_at_ms: 5,
  });
  await store.recordReceived(receivedRow('mb_1', r1, relayPe[0]));
  await store.recordReceived(receivedRow('mb_2', r2, chainC[0]));
  await store.recordReceived(receivedRow('mb_3', r2, chainC[1]));
  const kept = answerOf(r1, day1.anchorOf(2), true) as unknown as ReceivedBatchProof;
  await store.recordReceivedProof!({ ...kept, fetched_at_ms: 6 });
  await store.recordLegacy({ mailbox_id: 'mb_legacy', pe_id: 'env_old', envelope: { id: 'env_old', hash: 'f0'.repeat(32), action_type: 'send', timestamp: 1 }, received_at_ms: 7 });

  // The Archive: day D1 (this device's dropped batch, plus a copy of an index still held here) and
  // day D2 (another machine's chain this machine never held).
  const d1Entries = buildArchiveEntries(D1, [archiveInput(a1, day1.anchorOf(0))]).entries;
  const dupEntry = buildArchiveEntries(D1, [archiveInput(a2, day1.anchorOf(1))]).entries[0];
  let entriesA = [...d1Entries, dupEntry];
  if (options.tamperArchiveIndex !== undefined) {
    entriesA = entriesA.map((e) => {
      if (e.index !== options.tamperArchiveIndex) return e;
      const { pe_hash: _h, ...rest } = e.pe;
      void _h;
      const draft = { ...rest, description: 'rewritten in the archive' } as PeV2;
      return { ...e, pe: { ...draft, pe_hash: peHashOf(draft) } };
    });
  }
  const payloads: Record<string, ArchivePayload[]> = {
    [D1]: [{ schema: 'provian.pe-archive-payload.v1', wallet: OWNER, day: D1, device_id: DEV_A, part: 0, entries: entriesA }],
    [D2]: [{ schema: 'provian.pe-archive-payload.v1', wallet: OWNER, day: D2, device_id: DEV_B, part: 0, entries: buildArchiveEntries(D2, [archiveInput(b1, day2.anchorOf(0))]).entries }],
  };
  const pulls: string[] = [];
  const archive: PeExportArchiveSource = {
    readStatus: async () => ({ ok: true, wallet: OWNER, on: true }),
    listDays: async () => ({ ok: true, days: options.noOtherMachine === true ? [{ day: D1 }] : [{ day: D1 }, { day: D2 }] }),
    pullDay: async (day) => {
      pulls.push(day);
      return payloads[day] ? { ok: true, payloads: payloads[day] } : { ok: false, reason: 'archive_day_unreadable:404' };
    },
  };
  const requests: string[][] = [];
  const batchProofs = {
    getBatchProofs: async (hashes: readonly string[]): Promise<MeterAnswer> => {
      requests.push([...hashes]);
      const batches = options.missingReceived ? [] : hashes.filter((h) => h === r2.batch_hash).map(() => answerOf(r2, day1.anchorOf(3), false));
      return { status: 200, body: { batches, missing: hashes.filter((h) => options.missingReceived || h !== r2.batch_hash) }, error: null };
    },
  };
  return { root, store, archive, batchProofs, pulls, requests, roots: { [meterAnchorBatchIdOf(D1)]: day1.root, [meterAnchorBatchIdOf(D2)]: day2.root }, chainA, r2 };
}

function rpc(roots: Record<string, string>, override?: string) {
  const calls: { url: string; to: string; data: string }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { params: [{ to: string; data: string }] };
    calls.push({ url: String(url), ...body.params[0] });
    const id = '0x' + body.params[0].data.slice(10);
    const root = override ?? roots[id] ?? '0x' + '00'.repeat(32);
    const exists = override !== undefined || roots[id] !== undefined;
    const result = '0x' + root.slice(2) + '0'.repeat(63) + '4' + '0'.repeat(64) + '0'.repeat(64) + '0'.repeat(63) + (exists ? '1' : '0');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function linesOf(text: string): ExportBodyLine[] {
  const parsed = parseExport(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.body;
}

describe('PE export — one action exports everything the agent owns', () => {
  it('a complete export verifies offline with zero failures and zero gaps, every record type present', async () => {
    const f = await fixture();
    const out = path.join(f.root, 'out', 'export.jsonl');
    const result = await exportPesToFile({ mailbox: DRAINED,
      stores: listLocalDeviceStores(f.root, DEV_A).stores, owner: { wallet_id: OWNER, address: '0x' + '12'.repeat(20) },
      archive: f.archive, batchProofs: f.batchProofs, out, now: () => 1_791_300_000_000,
    });
    expect(result.status).toBe('ok');
    // The one thing this file cannot hold: the newest PEs of the other machine (DEV_B) whose chain
    // came in through the Archive — named, never silent.
    expect(result.incomplete).toEqual([{ what: `PEs recorded on ${DEV_B} since that machine's last Archive day`, reason: expect.stringMatching(/^kept_on_that_machine:/) }]);
    expect(result.complete).toBe(false);
    expect(result.self_check.failures).toEqual([]);
    expect(result.self_check.gaps_in_listed_devices).toEqual([]);
    expect(result.self_check.gaps_archive_only).toEqual([]);
    // Never an empty population: every record type is present and was evaluated.
    expect(result.counts).toEqual({ pe: 8, batch: 2, received: 3, legacy: 1 });
    expect(result.self_check.counts).toMatchObject({
      pe: { total: 8, proven_to_root: 7, pending: 1 },
      batch: { total: 2, proven_to_root: 2, pending: 0 },
      received: { total: 3, proven_to_root: 3, pending: 0 },
      legacy: { total: 1, unanchorable: 1 },
    });
    expect(result.self_check.day_roots).toBe(2);
    // Written private, atomically, at the path asked for.
    expect((fs.statSync(out).mode & 0o777).toString(8)).toBe('600');
    const body = linesOf(fs.readFileSync(out, 'utf8'));
    const pes = body.filter((l): l is Extract<ExportBodyLine, { type: 'pe' }> => l.type === 'pe');
    expect(pes.map((l) => [l.device_id === DEV_A ? 'A' : 'B', l.index, l.source, l.status])).toEqual([
      ['A', 0, 'archive', 'anchored'], ['A', 1, 'archive', 'anchored'], ['A', 2, 'archive', 'anchored'],
      ['A', 3, 'device', 'anchored'], ['A', 4, 'device', 'anchored'], ['A', 5, 'device', 'not_batched_yet'],
      ['B', 0, 'archive', 'anchored'], ['B', 1, 'archive', 'anchored'],
    ]);
    // The archived proofs carry the pinned PEAnchor (the archive holds '' for it).
    expect(pes.every((l) => l.inclusion === null || l.inclusion.anchor?.contract === PE_EXPORT_PE_ANCHOR)).toBe(true);
    // Each Archive day pulled once; the header lists this device and every day.
    expect(f.pulls).toEqual([D1, D2]);
    const parsed = parseExport(fs.readFileSync(out, 'utf8'));
    if (!parsed.ok) throw new Error('parse');
    expect(parsed.header.devices).toEqual([DEV_A]);
    expect(parsed.header.archive).toEqual({ state: 'on', days: [{ wallet: OWNER, day: D1, pulled: true, reason: null }, { wallet: OWNER, day: D2, pulled: true, reason: null }] });
    expect(parsed.header.producer.kind).toBe('sdk');
    expect(parsed.header.owner).toEqual({ kind: 'agent', wallet_id: OWNER, address: '0x' + '12'.repeat(20) });
    // The record fetched at export time was asked for once (only the batch with none kept) and kept.
    expect(f.requests).toEqual([[f.r2.batch_hash]]);
    expect((await f.store.listReceivedProofs()).map((p) => p.batch_hash)).toContain(f.r2.batch_hash);
    const received = body.filter((l): l is Extract<ExportBodyLine, { type: 'received' }> => l.type === 'received');
    expect(received.map((r) => r.status)).toEqual(['anchored', 'anchored', 'anchored']);
    expect(body.find((l) => l.type === 'legacy')).toMatchObject({ source: 'handed_back', id: 'env_old', hash: 'f0'.repeat(32), status: 'pre_meter' });
  });

  it('the verifier confirms every day root on Base and contacts only the RPC host', async () => {
    const f = await fixture();
    const out = path.join(f.root, 'export.jsonl');
    await exportPesToFile({ mailbox: DRAINED, stores: [f.store], owner: { wallet_id: OWNER, address: null }, archive: f.archive, batchProofs: f.batchProofs, out });
    const chain = rpc(f.roots);
    const v = await verifyPeExportFile(out, { rpcUrl: 'https://base-rpc.example/v1', fetchFn: chain.fetchFn });
    // Every line and both day roots verify, but the file names what it does not carry: never `ok`.
    expect(v.verdict).toBe('incomplete');
    expect(v.missing).toEqual([expect.stringMatching(new RegExp(`^PEs recorded on ${DEV_B} since that machine's last Archive day — kept_on_that_machine:`))]);
    expect(v.failures).toEqual([]);
    expect(v.anchors).toHaveLength(2);
    expect(v.anchors.every((a) => a.ok === true)).toBe(true);
    expect(v.rpc.contacted_hosts).toEqual(['base-rpc.example']);
    expect(new Set(chain.calls.map((c) => new URL(c.url).host))).toEqual(new Set(['base-rpc.example']));
    expect(chain.calls.every((c) => c.to === PE_EXPORT_PE_ANCHOR)).toBe(true);
    expect(chain.calls.map((c) => c.data).sort()).toEqual([getBatchCalldata(meterAnchorBatchIdOf(D1)), getBatchCalldata(meterAnchorBatchIdOf(D2))].sort());
    // Offline: nothing contacted, the roots listed unchecked.
    const off = await verifyPeExportFile(out, { offline: true, fetchFn: (async () => { throw new Error('must not fetch'); }) as unknown as typeof fetch });
    expect(off.verdict).toBe('offline_incomplete');
    expect(off.rpc.contacted_hosts).toEqual([]);
    expect(off.anchors.every((a) => a.ok === null)).toBe(true);
  });

  it('a complete export (no other machine, mailbox drained) verifies ok online and offline_ok offline', async () => {
    const f = await fixture({ noOtherMachine: true });
    const out = path.join(f.root, 'export.jsonl');
    const result = await exportPesToFile({ mailbox: DRAINED, stores: [f.store], owner: { wallet_id: OWNER, address: null }, archive: f.archive, batchProofs: f.batchProofs, out });
    expect(result.incomplete).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.counts.pe).toBe(6);
    const v = await verifyPeExportFile(out, { rpcUrl: 'https://base-rpc.example', fetchFn: rpc(f.roots).fetchFn });
    expect(v.verdict).toBe('ok');
    expect(v.incomplete).toEqual([]);
    expect(v.missing).toEqual([]);
    expect(v.anchors.length).toBe(1);
    expect((await verifyPeExportFile(out, { offline: true })).verdict).toBe('offline_ok');
  });

  it('RED: an export whose end line names ANY missing item never verifies ok — online or offline', async () => {
    const f = await fixture({ noOtherMachine: true });
    const out = path.join(f.root, 'export.jsonl');
    // The same complete store, but three mailbox PEs stayed on the relay (no key on this machine).
    const result = await exportPesToFile({
      mailbox: { waiting: 3, truncated: false, reason: 'no_message_key_here: test' },
      stores: [f.store], owner: { wallet_id: OWNER, address: null }, archive: f.archive, batchProofs: f.batchProofs, out,
    });
    expect(result.incomplete).toEqual([{ what: 'mailbox: 3 PE(s) sealed to this agent still waiting on the relay', reason: 'no_message_key_here: test' }]);
    expect(result.complete).toBe(false);
    // Every line verifies (the self-check is clean) — the population is real, not empty.
    expect(result.self_check.failures).toEqual([]);
    expect(result.self_check.counts?.pe.total).toBe(6);
    const v = await verifyPeExportFile(out, { rpcUrl: 'https://base-rpc.example', fetchFn: rpc(f.roots).fetchFn });
    expect(v.anchors.every((a) => a.ok === true)).toBe(true);
    expect(v.verdict).toBe('incomplete');
    expect(v.missing).toEqual(['mailbox: 3 PE(s) sealed to this agent still waiting on the relay — no_message_key_here: test']);
    expect(v.reasons).toContain('1 item(s) the export names as held by the owner but not included (see missing)');
    expect((await verifyPeExportFile(out, { offline: true })).verdict).toBe('offline_incomplete');
  });

  it('RED: an export built without a mailbox check names the mailbox as not checked', async () => {
    const f = await fixture({ noOtherMachine: true });
    const out = path.join(f.root, 'export.jsonl');
    const result = await exportPesToFile({ stores: [f.store], owner: { wallet_id: OWNER, address: null }, archive: f.archive, batchProofs: f.batchProofs, out });
    expect(result.incomplete.map((i) => i.reason)).toEqual([expect.stringMatching(/^mailbox_not_checked:/)]);
    expect(result.complete).toBe(false);
  });

  it('an Archive that is off names the chains of other machines as not included', async () => {
    const f = await fixture({ noOtherMachine: true });
    const off: PeExportArchiveSource = { ...f.archive, readStatus: async () => ({ ok: true, wallet: OWNER, on: false }) };
    const result = await exportPesToFile({ mailbox: DRAINED, stores: [f.store], owner: { wallet_id: OWNER, address: null }, archive: off, batchProofs: f.batchProofs, out: path.join(f.root, 'e.jsonl') });
    expect(result.incomplete).toContainEqual({ what: 'chains this agent recorded on other machines', reason: expect.stringMatching(/^only_this_machine: .*is off for this agent$/) });
    expect(result.complete).toBe(false);
  });

  it('RED: the verifier refuses a tampered file and a day root Base does not hold', async () => {
    const f = await fixture();
    const out = path.join(f.root, 'export.jsonl');
    await exportPesToFile({ mailbox: DRAINED, stores: [f.store], owner: { wallet_id: OWNER, address: null }, archive: f.archive, batchProofs: f.batchProofs, out });
    const text = fs.readFileSync(out, 'utf8');
    const tampered = path.join(f.root, 'tampered.jsonl');
    fs.writeFileSync(tampered, text.replace('a act 4', 'a act X'));
    const t = await verifyPeExportFile(tampered, { offline: true });
    expect(t.verdict).toBe('failed');
    expect(t.parse_error?.error).toBe('chain_mismatch');
    const wrongRoot = rpc(f.roots, '0x' + '33'.repeat(32));
    const w = await verifyPeExportFile(out, { rpcUrl: 'https://base-rpc.example', fetchFn: wrongRoot.fetchFn });
    expect(w.verdict).toBe('failed');
    expect(w.anchors.every((a) => a.ok === false && a.reason === 'onchain_root_differs')).toBe(true);
    expect(w.rpc.contacted_hosts).toEqual(['base-rpc.example']);
    const absent = rpc({});
    expect((await verifyPeExportFile(out, { rpcUrl: 'https://base-rpc.example', fetchFn: absent.fetchFn })).verdict).toBe('failed');
  });

  it('RED: an edited PE line in pes.jsonl fails the self-check loudly; the file is still written', async () => {
    const f = await fixture();
    const pesPath = path.join(f.store.location, 'pes.jsonl');
    fs.writeFileSync(pesPath, fs.readFileSync(pesPath, 'utf8').replace('a act 4', 'a act 4 (edited)'));
    const out = path.join(f.root, 'export.jsonl');
    const result = await exportPesToFile({ mailbox: DRAINED, stores: [f.store], owner: { wallet_id: OWNER, address: null }, archive: f.archive, batchProofs: f.batchProofs, out });
    expect(result.status).toBe('error');
    expect(result.warning).toMatch(/LOCAL PE STORE IS CORRUPT/);
    expect(result.self_check.failures.map((x) => x.reason)).toContain('pe_hash_mismatch');
    expect(fs.existsSync(out)).toBe(true);
  });

  it('RED: an unreadable pes.jsonl line is listed as incomplete and shows as a gap in the chain held here', async () => {
    const f = await fixture();
    const pesPath = path.join(f.store.location, 'pes.jsonl');
    const lines = fs.readFileSync(pesPath, 'utf8').split('\n');
    lines[4] = '{not json';
    fs.writeFileSync(pesPath, lines.join('\n'));
    const result = await exportPesToFile({ mailbox: DRAINED, stores: [f.store], owner: { wallet_id: OWNER, address: null }, archive: f.archive, batchProofs: f.batchProofs, out: path.join(f.root, 'e.jsonl') });
    expect(result.incomplete.map((i) => i.what)).toContain(`pe ${DEV_A}#4`);
    expect(result.self_check.gaps_in_listed_devices).toEqual([{ device_id: DEV_A, from: 4, before: 5 }]);
    expect(result.complete).toBe(false);
  });

  it('RED: a received PE with no obtainable proof is proof_unavailable and listed in incomplete', async () => {
    const f = await fixture({ missingReceived: true });
    const out = path.join(f.root, 'export.jsonl');
    const result = await exportPesToFile({ mailbox: DRAINED, stores: [f.store], owner: { wallet_id: OWNER, address: null }, archive: f.archive, batchProofs: f.batchProofs, out });
    const received = linesOf(fs.readFileSync(out, 'utf8')).filter((l): l is Extract<ExportBodyLine, { type: 'received' }> => l.type === 'received');
    expect(received.map((r) => [r.mailbox_id, r.status])).toEqual([['mb_1', 'anchored'], ['mb_2', 'proof_unavailable'], ['mb_3', 'proof_unavailable']]);
    expect(result.incomplete.filter((i) => i.what.startsWith('received ')).map((i) => i.what)).toEqual(['received mb_2 (pe_c_0)', 'received mb_3 (pe_c_1)']);
    expect(result.incomplete.find((i) => i.what === 'received mb_2 (pe_c_0)')?.reason).toMatch(/relay_no_longer_holds_batch/);
    // Pending, never verified — and never a failure.
    expect(result.self_check.failures).toEqual([]);
    expect(result.self_check.counts?.received).toEqual({ total: 3, proven_to_root: 1, pending: 2 });
  });

  it('RED: an archived copy that differs from the pointer kept here is not emitted and is listed', async () => {
    const f = await fixture({ tamperArchiveIndex: 1 });
    const out = path.join(f.root, 'export.jsonl');
    const result = await exportPesToFile({ mailbox: DRAINED, stores: [f.store], owner: { wallet_id: OWNER, address: null }, archive: f.archive, batchProofs: f.batchProofs, out });
    const pes = linesOf(fs.readFileSync(out, 'utf8')).filter((l): l is Extract<ExportBodyLine, { type: 'pe' }> => l.type === 'pe' && l.device_id === DEV_A);
    expect(pes.map((l) => l.index)).toEqual([0, 2, 3, 4, 5]);
    expect(result.incomplete.find((i) => i.what === `pe ${DEV_A}#1 (pe_a_1)`)?.reason).toMatch(/archive_entry_differs_from_pointer/);
    expect(result.self_check.gaps_in_listed_devices).toEqual([{ device_id: DEV_A, from: 1, before: 2 }]);
    expect(result.complete).toBe(false);
  });

  it('an Archive that cannot be opened here: pointer days are listed not pulled, and the export says so', async () => {
    const f = await fixture();
    const result = await exportPesToFile({ mailbox: DRAINED, stores: [f.store], owner: { wallet_id: OWNER, address: null }, archive: null, batchProofs: null, out: path.join(f.root, 'e.jsonl') });
    expect(result.archive).toEqual({ state: 'unknown', days: 1, pulled: 0 });
    expect(result.incomplete.map((i) => i.what)).toEqual(expect.arrayContaining(['archive', `archive day ${OWNER} ${D1}`, 'received mb_2 (pe_c_0)']));
    expect(result.self_check.failures).toEqual([]);
    expect(result.self_check.gaps_in_listed_devices).toEqual([{ device_id: DEV_A, from: 0, before: 3 }]);
  });

  it('every device store under the root is exported, the configured one first', async () => {
    const f = await fixture();
    const other = new FsPeStore(DEV_C, f.root);
    for (const pe of chainOf(DEV_C, 2, 'c-local')) await other.append(pe);
    const { stores } = listLocalDeviceStores(f.root, DEV_C);
    expect(stores.map((s) => s.deviceId)).toEqual([DEV_C, DEV_A]);
    const result = await exportPesToFile({ mailbox: DRAINED, stores, owner: { wallet_id: OWNER, address: null }, archive: f.archive, batchProofs: f.batchProofs, out: path.join(f.root, 'e.jsonl') });
    expect(result.devices).toEqual([DEV_C, DEV_A]);
    expect(result.self_check.failures).toEqual([]);
    expect(result.counts.pe).toBe(10);
    const report = verifyExportOffline(linesOf(fs.readFileSync(result.path, 'utf8')));
    expect(report.gaps).toEqual([]);
  });

  it('selfCheckPeExport refuses a truncated text (RED: not a vacuous pass)', () => {
    expect(selfCheckPeExport('')).toMatchObject({ ok: false, parse_error: 'empty' });
  });
});

describe('PE export — the relay mailbox is drained first, and what stays there is named', () => {
  function sealed(pe: PeV2 | Record<string, unknown>, pubkeyB64u: string, id: string, peId: string, batchHash: string): Record<string, unknown> {
    return {
      id, to: `agent:${OWNER}`, pe_id: peId, box: sealThreadMessage(canonicalJson(pe), { p: pubkeyB64u }).ciphertexts.p,
      from_device: DEV_C, from_actor: OWNER, batch_hash: batchHash, created_at_ms: 4,
    };
  }

  it('a PE waiting in the mailbox lands in the export; an item this key cannot open is counted and named', async () => {
    const f = await fixture({ noOtherMachine: true });
    const agent = deriveMessageKeyPair('33'.repeat(32));
    const stranger = deriveMessageKeyPair('44'.repeat(32));
    const waitingPe = chainOf(DEV_C, 3, 'c')[2]; // another of the agent's devices, not filed here yet
    const relay = new FakeMeterRelay(DEV_A, OWNER);
    relay.mailbox = [
      sealed(waitingPe, agent.pubkeyB64u, 'mb_waiting', waitingPe.pe_id, f.r2.batch_hash),
      sealed(waitingPe, stranger.pubkeyB64u, 'mb_sealed_elsewhere', 'pe_unknown', f.r2.batch_hash),
    ];
    const transport = createHttpMeterTransport({
      relayUrl: 'https://relay.test',
      boundEnvelope: async (body) => ({ headers: {}, body: JSON.stringify(body) }),
      authHeaders: () => ({ Authorization: 'DeviceKey pdk:pds' }),
      timeoutMs: 5_000,
      fetchImpl: relay.fetch,
    });
    const keyCopy = new Uint8Array(agent.secretKey);
    const batcher = new MeterBatcher({ store: f.store, transport, now: () => relay.now, resendDelayMs: 0, messageSecretKey: async () => new Uint8Array(keyCopy) });
    const state = await drainMailboxForExport({
      drain: () => batcher.drainMailbox(),
      getMailbox: (after, limit) => transport.getMailbox(after, limit),
      filedIds: async () => new Set((await f.store.listReceived()).map((r) => r.mailbox_id)),
    });
    expect(state).toEqual({ waiting: 1, truncated: false, reason: expect.stringMatching(/^unopenable: 1 item/) });
    // The opened PE was filed and acknowledged; the one sealed to another key stays on the relay.
    expect(relay.mailbox.map((m) => m.id)).toEqual(['mb_sealed_elsewhere']);
    const out = path.join(f.root, 'export.jsonl');
    const result = await exportPesToFile({ mailbox: state, stores: [f.store], owner: { wallet_id: OWNER, address: null }, archive: f.archive, batchProofs: f.batchProofs, out });
    const received = linesOf(fs.readFileSync(out, 'utf8')).filter((l): l is Extract<ExportBodyLine, { type: 'received' }> => l.type === 'received');
    expect(received.map((r) => r.mailbox_id)).toContain('mb_waiting');
    expect(received.find((r) => r.mailbox_id === 'mb_waiting')?.pe.pe_hash).toBe(waitingPe.pe_hash);
    expect(result.incomplete).toContainEqual({ what: 'mailbox: 1 PE(s) sealed to this agent still waiting on the relay', reason: expect.stringMatching(/^unopenable:/) });
    const v = await verifyPeExportFile(out, { offline: true });
    expect(v.verdict).toBe('offline_incomplete');
    expect(v.missing.some((m) => m.startsWith('mailbox: 1 PE(s)'))).toBe(true);
  });

  it('no key here: nothing is opened, every waiting item is counted, and the reason says why', async () => {
    const relay = { items: [{ id: 'mb_1' }, { id: 'mb_2' }, { id: 'mb_filed' }] };
    const state = await drainMailboxForExport({
      drain: async () => ({ ok: true, received: 0, skipped: 'no_key', unopenable: 0 }),
      getMailbox: async () => ({ status: 200, body: { items: relay.items, next: null }, error: null }),
      filedIds: async () => new Set(['mb_filed']),
    });
    expect(state).toEqual({ waiting: 2, truncated: false, reason: expect.stringMatching(/^no_message_key_here:/) });
    expect(mailboxIncompleteOf(state)).toEqual([{ what: 'mailbox: 2 PE(s) sealed to this agent still waiting on the relay', reason: state.reason }]);
  });

  it('RED: a mailbox that cannot be read is named as not counted — never as empty', async () => {
    const state = await drainMailboxForExport({
      drain: async () => ({ ok: false, received: 0, skipped: null, unopenable: 0 }),
      getMailbox: async () => ({ status: 503, body: null, error: 'down' }),
      filedIds: async () => new Set(),
    });
    expect(state.waiting).toBeNull();
    expect(mailboxIncompleteOf(state)).toEqual([{ what: 'mailbox: PEs sealed to this agent waiting on the relay', reason: expect.stringMatching(/^mailbox_not_counted: mailbox_unreachable/) }]);
    // The control: a drained, empty mailbox names nothing.
    expect(mailboxIncompleteOf({ waiting: 0, truncated: false, reason: null })).toEqual([]);
  });

  it('a long mailbox is drained until a drain files nothing, and a listing past the page cap is "at least"', async () => {
    let drains = 0;
    const state = await drainMailboxForExport({
      drain: async () => ({ ok: true, received: ++drains < 3 ? 100 : 0, skipped: null, unopenable: 0 }),
      getMailbox: async (after) => ({ status: 200, body: { items: [{ id: `x_${after ?? 0}` }], next: `${Number(after ?? 0) + 1}` }, error: null }),
      filedIds: async () => new Set(),
      maxPages: 4,
    });
    expect(drains).toBe(3);
    expect(state).toMatchObject({ waiting: 4, truncated: true });
    expect(mailboxIncompleteOf(state)[0].what).toBe('mailbox: at least 4 PE(s) sealed to this agent still waiting on the relay');
  });
});

describe('received-PE batch proofs are fetched daily and KEPT', () => {
  it('keeps only anchored, checked records; refuses one whose batch leaf does not recompute', async () => {
    const f = await fixture();
    const store = new MemoryPeStore(DEV_A);
    for (const r of await f.store.listReceived()) await store.recordReceived(r);
    const relayRow = (await f.store.listReceived())[0];
    const good = (await f.store.listReceivedProofs())[0];
    const asked: string[][] = [];
    const transport = {
      getBatchProofs: async (hashes: readonly string[]): Promise<MeterAnswer> => {
        asked.push([...hashes]);
        return {
          status: 200,
          body: {
            batches: [
              { ...good, fetched_at_ms: undefined },
              // Unanchored yet: not kept (asked again tomorrow).
              { ...answerOf(f.r2, null, false) },
            ],
            missing: [],
          },
          error: null,
        };
      },
    };
    const first = await keepReceivedProofs(store, transport, 10);
    expect(first).toMatchObject({ ok: true, kept: 1, pending: 1, refused: 0 });
    expect(asked).toEqual([[relayRow.batch_hash, f.r2.batch_hash]]);
    // Kept records are not asked for again.
    await keepReceivedProofs(store, transport, 11);
    expect(asked[1]).toEqual([f.r2.batch_hash]);
    // RED: a record whose batch leaf does not recompute from its identity is never kept.
    const forged = new MemoryPeStore(DEV_A);
    await forged.recordReceived(relayRow);
    const bad = await keepReceivedProofs(forged, {
      getBatchProofs: async () => ({ status: 200, body: { batches: [{ ...good, seq: good.seq + 1 }], missing: [] }, error: null }),
    }, 12);
    expect(bad).toMatchObject({ kept: 0, refused: 1 });
    expect(await forged.listReceivedProofs()).toEqual([]);
  });
});
