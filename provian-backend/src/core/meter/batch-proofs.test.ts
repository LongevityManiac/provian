/**
 * PE export — `readBatchProofs`: the anchoring record of batches whose PEs were sealed to an owner.
 *
 * Each guard ships with its RED control beside a positive twin:
 *   - a found + anchored batch returns its identity, act leaves and anchor; a found + unanchored
 *     one returns anchor null (and a record marked anchored whose proof is unreadable is reported
 *     unanchored, never with a half proof);
 *   - act leaves that recompute acts_root are returned and every held PE's path verifies from
 *     them; a record without them (pre-change) answers null, and leaves that do NOT recompute
 *     acts_root answer null (RED);
 *   - presented hashes with no record land in `missing`; duplicates are read once;
 *   - the request is refused (`batch_hashes_invalid`) for a non-array, an empty array, >200
 *     items, an uppercase / short / non-hex / non-string hash — before any read (RED);
 *   - the response is an explicit allowlist: claim_keys, eligible_points_atomic, act_pages and
 *     any extra field on the stored anchor never leak (RED: they are present on the stored doc).
 * Populations are counted: every "each" assertion first asserts a non-empty set.
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { METER_BATCHES_COLLECTION } from './meter-store';
import {
  merkleRootOf as merkleRootOfLeaves,
  actLeafOf,
  actRecordOf,
  batchHashOf,
  batchLeafOf,
  buildBatch,
  merkleProofOf,
  METER_GENESIS_PREV_HASH,
  PE_V2_SCHEMA,
  peHashOf,
  verifyMerkleProofOf,
  type PeBatch,
  type PeV2,
} from './meter-wire';
import { MAX_BATCH_PROOF_HASHES, parseBatchHashes, readBatchProofs, readBatchProofsRequest } from './batch-proofs';
import type { MeterAnchorProof } from './meter-anchor';

const DB = (fake: FakeFirestore) => fake as unknown as Firestore;
const T0 = Date.parse('2026-10-04T12:00:00Z');
const ANCHOR = '0x889A59A847e490c5Cc91f281468AbAacc100a9fD';
const HEX64 = /^[0-9a-f]{64}$/;

const RECORD_KEYS = [
  'act_leaves', 'accepted_at_ms', 'acts_root', 'actor_id', 'anchor', 'anchor_contract', 'anchored',
  'batch_hash', 'batch_leaf', 'chain_id', 'day', 'device_id', 'seq',
].sort();

function pesOf(deviceId: string, count: number, t: number): PeV2[] {
  const out: PeV2[] = [];
  let prev = METER_GENESIS_PREV_HASH;
  for (let i = 0; i < count; i++) {
    const pe = {
      schema: PE_V2_SCHEMA,
      pe_id: `pe_${deviceId}_${t}_${i}`,
      device_id: deviceId,
      prev_hash: prev,
      timestamp: t + i,
      action_type: 'ai_conversation',
      metadata: { session_fingerprint_hash: `${i}`.repeat(64).slice(0, 64) },
    } as unknown as PeV2;
    prev = peHashOf(pe);
    out.push(pe);
  }
  return out;
}

interface Seeded {
  readonly batch: PeBatch;
  readonly pes: PeV2[];
  readonly hash: string;
  readonly leaf: string;
}

function anchorProof(leafIndex = 0): MeterAnchorProof {
  return {
    day: '2026-10-04',
    anchor_batch_id: `0x${'ab'.repeat(32)}`,
    leaf_index: leafIndex,
    leaf_count: 2,
    leaf_hash: `0x${'cd'.repeat(32)}`,
    proof: [`0x${'ef'.repeat(32)}`],
    merkle_root: `0x${'12'.repeat(32)}`,
    anchor_tx_hash: `0x${'34'.repeat(32)}`,
    anchored_at_ms: T0 + 86_400_000,
  };
}

async function seed(fake: FakeFirestore, opts: {
  deviceId?: string;
  actorId?: string;
  acts?: number;
  anchored?: boolean;
  anchor?: unknown;
  actLeaves?: unknown;
  t?: number;
} = {}): Promise<Seeded> {
  const deviceId = opts.deviceId ?? 'dev_atlas';
  const actorId = opts.actorId ?? 'agent_atlas';
  const t = opts.t ?? T0;
  const pes = pesOf(deviceId, opts.acts ?? 3, t);
  const batch = buildBatch({ device_id: deviceId, seq: 7, prev_batch_hash: METER_GENESIS_PREV_HASH, created_at_ms: t, pes });
  const hash = batchHashOf(batch);
  const leaf = batchLeafOf({ device_id: deviceId, actor_id: actorId, seq: 7, batch_hash: hash, acts_root: batch.acts_root });
  const doc: Record<string, unknown> = {
    batch_hash: hash,
    device_id: deviceId,
    actor_id: actorId,
    seq: 7,
    acts_root: batch.acts_root,
    batch_leaf: leaf,
    act_count: batch.acts.length,
    eligible_points_atomic: '123456789',
    claim_keys: ['claim_secret_1', 'claim_secret_2'],
    act_pages: 1,
    day: '2026-10-04',
    accepted_at_ms: t,
    anchored: opts.anchored ?? false,
    anchor: opts.anchored ? (opts.anchor ?? anchorProof()) : null,
  };
  if (opts.actLeaves !== undefined) doc.act_leaves = opts.actLeaves;
  await DB(fake).collection(METER_BATCHES_COLLECTION).doc(hash).set(doc);
  return { batch, pes, hash, leaf };
}

let savedAnchorEnv: string | undefined;
beforeEach(() => {
  savedAnchorEnv = process.env.PE_ANCHOR_CONTRACT_ADDRESS;
  process.env.PE_ANCHOR_CONTRACT_ADDRESS = ANCHOR;
});
afterEach(() => {
  if (savedAnchorEnv === undefined) delete process.env.PE_ANCHOR_CONTRACT_ADDRESS;
  else process.env.PE_ANCHOR_CONTRACT_ADDRESS = savedAnchorEnv;
});

describe('readBatchProofs — found batches', () => {
  it('returns a found + anchored batch with its identity, act leaves and anchor proof', async () => {
    const fake = createFakeFirestore();
    const s = await seed(fake, { anchored: true, actLeaves: [] }); // placeholder, overwritten below
    const leaves = s.batch.acts.map(actLeafOf);
    await DB(fake).collection(METER_BATCHES_COLLECTION).doc(s.hash).update({ act_leaves: leaves });

    const result = await readBatchProofs(DB(fake), [s.hash]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.missing).toEqual([]);
    expect(result.value.batches).toHaveLength(1);
    const rec = result.value.batches[0];
    expect(rec).toEqual({
      batch_hash: s.hash,
      device_id: 'dev_atlas',
      actor_id: 'agent_atlas',
      seq: 7,
      acts_root: s.batch.acts_root,
      batch_leaf: s.leaf,
      day: '2026-10-04',
      accepted_at_ms: T0,
      anchored: true,
      chain_id: 8453,
      anchor_contract: ANCHOR,
      anchor: anchorProof(),
      act_leaves: leaves,
    });
    // The batch leaf recomputes from the returned identity (what a verifier checks offline).
    expect(batchLeafOf({ device_id: rec.device_id, actor_id: rec.actor_id, seq: rec.seq, batch_hash: rec.batch_hash, acts_root: rec.acts_root })).toBe(rec.batch_leaf);
  });

  it('returns a found + unanchored batch with anchor null', async () => {
    const fake = createFakeFirestore();
    const s = await seed(fake, { anchored: false });
    const result = await readBatchProofs(DB(fake), [s.hash]);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.batches).toHaveLength(1);
    expect(result.value.batches[0].anchored).toBe(false);
    expect(result.value.batches[0].anchor).toBeNull();
  });

  it('RED: a record marked anchored whose proof is malformed is reported unanchored, anchor null', async () => {
    const fake = createFakeFirestore();
    const s = await seed(fake, { anchored: true, anchor: { day: '2026-10-04', leaf_index: 'zero' } });
    const result = await readBatchProofs(DB(fake), [s.hash]);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.batches[0].anchored).toBe(false);
    expect(result.value.batches[0].anchor).toBeNull();
  });

  it('anchor_contract is null when PE_ANCHOR_CONTRACT_ADDRESS is unset', async () => {
    delete process.env.PE_ANCHOR_CONTRACT_ADDRESS;
    const fake = createFakeFirestore();
    const s = await seed(fake, { anchored: true });
    const result = await readBatchProofs(DB(fake), [s.hash]);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.batches[0].anchor_contract).toBeNull();
    expect(result.value.batches[0].chain_id).toBe(8453);
  });
});

describe('readBatchProofs — act leaves', () => {
  it('returns stored act leaves, from which every held PE\'s path to acts_root verifies', async () => {
    const fake = createFakeFirestore();
    const s = await seed(fake, { acts: 5 });
    const leaves = s.batch.acts.map(actLeafOf);
    await DB(fake).collection(METER_BATCHES_COLLECTION).doc(s.hash).update({ act_leaves: leaves });
    const result = await readBatchProofs(DB(fake), [s.hash]);
    if (!result.ok) throw new Error('expected ok');
    const got = result.value.batches[0].act_leaves;
    expect(got).toEqual(leaves);
    expect(got).toHaveLength(5);
    // An owner holding only PE #3 of 5 builds its path from the leaves alone.
    let verified = 0;
    for (const index of [0, 3, 4]) {
      const proof = merkleProofOf(got as string[], index);
      expect(verifyMerkleProofOf(actLeafOf(actRecordOf(s.pes[index])), proof, s.batch.acts_root)).toBe(true);
      verified++;
    }
    expect(verified).toBe(3);
  });

  it('answers act_leaves null for a batch accepted before the relay kept them', async () => {
    const fake = createFakeFirestore();
    const s = await seed(fake);
    const result = await readBatchProofs(DB(fake), [s.hash]);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.batches).toHaveLength(1);
    expect(result.value.batches[0].act_leaves).toBeNull();
  });

  it('RED: stored leaves that do not recompute acts_root (or are malformed) answer null', async () => {
    const fake = createFakeFirestore();
    const good = await seed(fake, { t: T0 + 1 });
    const leaves = good.batch.acts.map(actLeafOf);
    const cases: unknown[] = [
      [...leaves].reverse(),                    // reordered → different root
      leaves.slice(0, 2),                       // truncated
      [...leaves.slice(0, 2), 'f'.repeat(64)],  // one leaf substituted
      leaves.map((l) => l.toUpperCase()),       // not lowercase hex
      'not-an-array',
      [],
    ];
    let checked = 0;
    for (const [i, bad] of cases.entries()) {
      const s = await seed(fake, { t: T0 + 100 + i, actLeaves: bad });
      const result = await readBatchProofs(DB(fake), [s.hash]);
      if (!result.ok) throw new Error('expected ok');
      expect(result.value.batches[0].act_leaves).toBeNull();
      checked++;
    }
    expect(checked).toBe(cases.length);
    // Positive twin on the same fake: the correct leaves are returned.
    await DB(fake).collection(METER_BATCHES_COLLECTION).doc(good.hash).update({ act_leaves: leaves });
    const ok = await readBatchProofs(DB(fake), [good.hash]);
    if (!ok.ok) throw new Error('expected ok');
    expect(ok.value.batches[0].act_leaves).toEqual(leaves);
  });
});

describe('readBatchProofs — missing and dedupe', () => {
  it('lists presented hashes with no record under missing, in request order', async () => {
    const fake = createFakeFirestore();
    const s = await seed(fake);
    const absentA = 'a'.repeat(64);
    const absentB = 'b'.repeat(64);
    const result = await readBatchProofs(DB(fake), [absentA, s.hash, absentB]);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.batches.map((b) => b.batch_hash)).toEqual([s.hash]);
    expect(result.value.missing).toEqual([absentA, absentB]);
  });

  it('RED: a record missing a required identity field is listed as missing, not half-returned', async () => {
    const fake = createFakeFirestore();
    const s = await seed(fake);
    await DB(fake).collection(METER_BATCHES_COLLECTION).doc(s.hash).update({ batch_leaf: 'nope' });
    const result = await readBatchProofs(DB(fake), [s.hash]);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.batches).toEqual([]);
    expect(result.value.missing).toEqual([s.hash]);
  });

  it('reads each distinct hash once, in one getAll', async () => {
    const fake = createFakeFirestore();
    const s1 = await seed(fake, { t: T0 + 1 });
    const s2 = await seed(fake, { t: T0 + 2 });
    const calls: number[] = [];
    const realGetAll = fake.getAll.bind(fake);
    fake.getAll = async (...refs) => { calls.push(refs.length); return realGetAll(...refs); };
    const result = await readBatchProofs(DB(fake), [s1.hash, s2.hash, s1.hash, s2.hash, s1.hash]);
    if (!result.ok) throw new Error('expected ok');
    expect(calls).toEqual([2]);
    expect(result.value.batches.map((b) => b.batch_hash)).toEqual([s1.hash, s2.hash]);
    expect(result.value.missing).toEqual([]);
  });

  it('accepts exactly 200 hashes (the limit), all missing', async () => {
    const fake = createFakeFirestore();
    const hashes = Array.from({ length: MAX_BATCH_PROOF_HASHES }, (_, i) => i.toString(16).padStart(64, '0'));
    const result = await readBatchProofs(DB(fake), hashes);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.missing).toHaveLength(200);
  });
});

describe('readBatchProofs — RED: request refusal', () => {
  const good = 'c'.repeat(64);
  const refusals: [string, unknown][] = [
    ['undefined', undefined],
    ['null', null],
    ['a string', good],
    ['an object', { 0: good }],
    ['an empty array', []],
    ['201 items', Array.from({ length: MAX_BATCH_PROOF_HASHES + 1 }, (_, i) => i.toString(16).padStart(64, '0'))],
    ['an uppercase hash', [good.toUpperCase()]],
    ['a mixed-case hash', [`A${'c'.repeat(63)}`]],
    ['a short hash', ['c'.repeat(63)]],
    ['a long hash', ['c'.repeat(65)]],
    ['a non-hex hash', [`g${'c'.repeat(63)}`]],
    ['a 0x-prefixed hash', [`0x${'c'.repeat(62)}`]],
    ['a non-string item', [good, 42]],
    ['one bad item among good ones', [good, 'd'.repeat(64), 'zz']],
  ];

  it('the population of refusals is non-empty', () => {
    expect(refusals.length).toBeGreaterThan(10);
  });

  for (const [name, raw] of refusals) {
    it(`refuses ${name} with batch_hashes_invalid and reads nothing`, async () => {
      const fake = createFakeFirestore();
      let reads = 0;
      const realGetAll = fake.getAll.bind(fake);
      fake.getAll = async (...refs) => { reads++; return realGetAll(...refs); };
      const result = await readBatchProofs(DB(fake), raw);
      expect(result).toEqual({ ok: false, error: 'batch_hashes_invalid' });
      expect(parseBatchHashes(raw)).toBeNull();
      expect(reads).toBe(0);
    });
  }

  it('positive twin: a well-formed request is accepted', async () => {
    expect(parseBatchHashes([good, good, 'd'.repeat(64)])).toEqual([good, 'd'.repeat(64)]);
  });
});

describe('readBatchProofs — RED: nothing beyond the allowlist leaks', () => {
  it('never returns claim_keys, eligible_points_atomic, act_pages, act_count or extra anchor fields', async () => {
    const fake = createFakeFirestore();
    const s = await seed(fake, {
      anchored: true,
      anchor: { ...anchorProof(), operator_note: 'internal', signer_key: 'secret' },
    });
    await DB(fake).collection(METER_BATCHES_COLLECTION).doc(s.hash).update({
      act_leaves: s.batch.acts.map(actLeafOf),
      internal_debug: { secret: true },
    });
    // The stored doc DOES carry the fields (otherwise this test would pass vacuously).
    const stored = fake.store.get(`${METER_BATCHES_COLLECTION}/${s.hash}`) as Record<string, unknown>;
    expect(stored.claim_keys).toEqual(['claim_secret_1', 'claim_secret_2']);
    expect(stored.eligible_points_atomic).toBe('123456789');
    expect((stored.anchor as Record<string, unknown>).signer_key).toBe('secret');

    const result = await readBatchProofs(DB(fake), [s.hash]);
    if (!result.ok) throw new Error('expected ok');
    const rec = result.value.batches[0] as unknown as Record<string, unknown>;
    expect(Object.keys(rec).sort()).toEqual(RECORD_KEYS);
    const text = JSON.stringify(result.value);
    for (const leaked of ['claim_keys', 'claim_secret', 'eligible_points_atomic', '123456789', 'act_pages', 'act_count', 'internal_debug', 'operator_note', 'signer_key']) {
      expect(text).not.toContain(leaked);
    }
    expect(Object.keys(rec.anchor as object).sort()).toEqual(Object.keys(anchorProof()).sort());
    expect((rec.act_leaves as string[]).every((l) => HEX64.test(l))).toBe(true);
  });
});

describe('batch proofs — a relay-authored PE handed over directly (no batch hash): by its one-act root', () => {
  it('finds the one-act relay batch from the root the owner computes from the PE alone', async () => {
    const fake = createFakeFirestore();
    const relay = await seed(fake, { deviceId: 'relay:atlas', actorId: 'atlas', acts: 1, anchored: true, actLeaves: undefined });
    const root = merkleRootOfOne(relay.pes[0]);
    expect(root).toBe(relay.batch.acts_root);
    const r = await readBatchProofsRequest(DB(fake), { acts_roots: [root] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.batches.map((b) => b.batch_hash)).toEqual([relay.hash]);
    expect(Object.keys(r.value.batches[0]).sort()).toEqual(RECORD_KEYS);
    expect(r.value.batches[0].anchored).toBe(true);
    expect(r.value.missing_acts_roots).toEqual([]);
  });

  it('answers batch_hashes and acts_roots together, without duplicates', async () => {
    const fake = createFakeFirestore();
    const relay = await seed(fake, { deviceId: 'relay:atlas', actorId: 'atlas', acts: 1 });
    const device = await seed(fake, { deviceId: 'dev_x', acts: 3 });
    const r = await readBatchProofsRequest(DB(fake), { batch_hashes: [device.hash, relay.hash], acts_roots: [relay.batch.acts_root] });
    expect(r.ok && r.value.batches.map((b) => b.batch_hash).sort()).toEqual([device.hash, relay.hash].sort());
  });

  it('NEGATIVE CONTROL: a device batch, or a relay batch of more than one act, is never answered by root', async () => {
    const fake = createFakeFirestore();
    const device = await seed(fake, { deviceId: 'dev_x', acts: 1 });
    const multi = await seed(fake, { deviceId: 'relay:atlas', acts: 2 });
    const r = await readBatchProofsRequest(DB(fake), { acts_roots: [device.batch.acts_root, multi.batch.acts_root] });
    expect(r.ok && r.value.batches).toEqual([]);
    expect(r.ok && r.value.missing_acts_roots).toEqual([device.batch.acts_root, multi.batch.acts_root]);
  });

  it('NEGATIVE CONTROL: malformed roots, or more than 200 values in all, are refused', async () => {
    const fake = createFakeFirestore();
    const good = 'a'.repeat(64);
    for (const body of [
      { acts_roots: [] }, { acts_roots: ['A'.repeat(64)] }, { acts_roots: 'x' },
      { acts_roots: [good], batch_hashes: ['nothex'] },
      { acts_roots: Array.from({ length: 101 }, (_, i) => i.toString(16).padStart(64, '0')), batch_hashes: Array.from({ length: 100 }, (_, i) => (i + 500).toString(16).padStart(64, '0')) },
    ]) {
      expect(await readBatchProofsRequest(DB(fake), body)).toEqual({ ok: false, error: 'batch_hashes_invalid' });
    }
    // A body with only batch_hashes still behaves exactly as before.
    expect(await readBatchProofsRequest(DB(fake), { batch_hashes: [good] })).toEqual({ ok: true, value: { batches: [], missing: [good] } });
  });
});

function merkleRootOfOne(pe: PeV2): string {
  // The owner's computation: the root of a one-leaf tree over the PE's act leaf.
  const leaf = actLeafOf(actRecordOf(pe));
  const proof = merkleProofOf([leaf], 0);
  expect(proof).toEqual([]);
  return merkleRootOfLeaves([leaf]);
}
