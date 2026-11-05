import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import stableStringify from 'json-stable-stringify';
import {
  actLeafOf, actMatchesPe, actRecordOf, batchHashOf, batchLeafOf, canonicalJson, hardwareNonceOfAct, PE_V2_SCHEMA, METER_GENESIS_PREV_HASH,
  merkleProofOf, merkleRootOf, peHashOf, validateBatchShape, verifyActChain, verifyActInclusion,
  verifyMerkleProofOf, type PeBatch, type PeV2,
} from './meter-wire';

const V = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../docs/audit/meter-wire-vectors.json'), 'utf8'));

describe('meter wire — pinned vectors (shared with the SDK and the app)', () => {
  it('reproduces every pinned output', () => {
    expect(canonicalJson(V.canonical_json.input)).toBe(V.canonical_json.output);
    const pes = V.pes as PeV2[];
    expect(pes.map(peHashOf)).toEqual(V.pe_hashes);
    expect(pes.map(actRecordOf)).toEqual(V.acts);
    expect(V.acts.map(actLeafOf)).toEqual(V.act_leaves);
    expect(hardwareNonceOfAct(V.acts[2])).toBe(V.hardware_nonce_c);
    expect(batchHashOf(V.batch)).toBe(V.batch_hash);
    expect(merkleRootOf(V.act_leaves)).toBe(V.batch.acts_root);
    V.act_leaves.forEach((leaf: string, i: number) => {
      expect(merkleProofOf(V.act_leaves, i)).toEqual(V.act_proofs[i]);
      expect(verifyMerkleProofOf(leaf, V.act_proofs[i], V.batch.acts_root)).toBe(true);
    });
    expect(batchLeafOf({ device_id: V.batch.device_id, actor_id: 'agent_vector', seq: 1, batch_hash: V.batch_hash, acts_root: V.batch.acts_root }))
      .toBe(V.batch_leaf);
  });

  it('canonicalJson agrees with json-stable-stringify on plain JSON', () => {
    for (const pe of V.pes) expect(canonicalJson(pe)).toBe(stableStringify(pe));
    expect(canonicalJson(V.batch)).toBe(stableStringify(V.batch));
  });

  it('free text is hashed into the PE but never sent as a pricing input', () => {
    const act = V.acts[0];
    expect(JSON.stringify(act)).not.toContain('never leaves the device');
    const edited = { ...V.pes[0], description: 'edited' };
    expect(peHashOf(edited)).not.toBe(V.pe_hashes[0]); // RED: the fingerprint covers the complete PE
    expect(actMatchesPe(act, V.pes[0])).toBe(true);
    expect(actMatchesPe(act, edited)).toBe(false);
  });

  it('a valid batch validates; a tampered one is refused (RED controls)', () => {
    expect(validateBatchShape(V.batch).ok).toBe(true);
    const badRoot = { ...V.batch, acts: [{ ...V.batch.acts[0], timestamp: V.batch.acts[0].timestamp + 1 }, ...V.batch.acts.slice(1)] };
    expect(validateBatchShape(badRoot)).toEqual({ ok: false, error: 'acts_root_mismatch' });
    const smuggled = { ...V.batch, acts: [{ ...V.batch.acts[0], pricing: { ...V.batch.acts[0].pricing, description: 'x' } }] };
    expect(validateBatchShape(smuggled)).toMatchObject({ ok: false, error: 'bad_act' });
    const extraKey = { ...V.batch, acts: [{ ...V.batch.acts[0], extra: 1 }] };
    expect(validateBatchShape(extraKey)).toMatchObject({ ok: false, error: 'bad_act' });
    const dup = { ...V.batch, acts: [V.batch.acts[0], V.batch.acts[0]] };
    expect(validateBatchShape(dup)).toMatchObject({ ok: false, error: 'duplicate_pe_id' });
    expect(validateBatchShape({ ...V.batch, schema: 'x' })).toMatchObject({ ok: false, error: 'bad_schema' });
  });

  it('the act chain continues across batches; a re-included or reordered act breaks it', () => {
    expect(verifyActChain('genesis', V.batch.acts)).toEqual({ ok: true });
    expect(verifyActChain(V.pe_hashes[2], V.batch.acts)).toEqual({ ok: false, index: 0 });
    const reordered = [V.batch.acts[1], V.batch.acts[0]];
    expect(verifyActChain('genesis', reordered)).toEqual({ ok: false, index: 0 });
  });

  it('a holder proves one act up to the batch leaf; a different PE does not prove', () => {
    const proof = {
      act_index: 1, act_proof: V.act_proofs[1], acts_root: V.batch.acts_root,
      batch: { device_id: V.batch.device_id, actor_id: 'agent_vector', seq: 1, batch_hash: V.batch_hash },
    };
    expect(verifyActInclusion(V.pes[1], proof)).toEqual({ ok: true, batch_leaf: V.batch_leaf });
    expect(verifyActInclusion({ ...V.pes[1], metadata: { commit_sha: 'c'.repeat(40) } }, proof))
      .toEqual({ ok: false, reason: 'act_not_in_batch' });
  });

  it('the hardware nonce does not depend on the witness it binds (no self-reference); RED: a pricing edit moves it', () => {
    const base = { schema: PE_V2_SCHEMA, pe_id: 'pe_hw', device_id: 'dev_hw', prev_hash: METER_GENESIS_PREV_HASH, timestamp: 1, action_type: 'compute_session', metadata: { a: 1 } };
    const witnessed = { ...base, hardware_witness: { scheme: 'tpm2_quote', report: 'sig-over-the-nonce' } };
    expect(hardwareNonceOfAct(actRecordOf(witnessed))).toBe(hardwareNonceOfAct(actRecordOf(base)));
    expect(actRecordOf(witnessed).pe_hash).not.toBe(actRecordOf(base).pe_hash);
    expect(hardwareNonceOfAct(actRecordOf({ ...base, metadata: { a: 2 } }))).not.toBe(hardwareNonceOfAct(actRecordOf(base)));
  });

  it('single-act batches and power-of-two padding are well defined', () => {
    const one = [V.act_leaves[0]];
    expect(verifyMerkleProofOf(one[0], merkleProofOf(one, 0), merkleRootOf(one))).toBe(true);
    expect(merkleProofOf(one, 0)).toEqual([]);
    const batch = V.batch as PeBatch;
    expect(batch.acts.length).toBe(3);
  });
});
