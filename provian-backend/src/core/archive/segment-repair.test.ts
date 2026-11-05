import { repairArchiveDaySegments } from './segment-repair';
import { meterAnchorBatchId } from '../meter/meter-anchor';
import {checkBatchAnchored, type ArchiveDayDoc, type ArchiveDeps} from './archive-service';
import {batchLeafOf} from '../meter/meter-wire';
import {hashEnvelopeHashLeaf} from '../pvt/merkle';

const day = '2026-10-10';
const id = meterAnchorBatchId(day, 2);
const leaf=batchLeafOf({device_id:'device',actor_id:'actor',seq:1,batch_hash:'c'.repeat(64),acts_root:'e'.repeat(64)});
const root=hashEnvelopeHashLeaf(leaf);
function record(segment?: number): ArchiveDayDoc {
  return { schema: 'provian.pe-archive-day.v1', id: 'owner_' + day, wallet: 'owner', day, bucket: 'archive', object_path: 'immutable',
    stored_bytes: 100, generation: '1', pe_count: 2, confirmed: true, confirmed_at_ms: 1, rejected_reason: null,
    last_check: null, created_at_ms: 1, updated_at_ms: 1,
    parts: [{ device_id: 'device', part: 0, sha256: 'b'.repeat(64), bytes: 100, charged_bytes: 1000000, pe_count: 2,
      state: 'stored', confirmed: true, uploaded_at_ms: 1, stored_at_ms: 1, object_path: 'immutable-part', md5_b64: 'md5',
      batches: [{ seq: 1, batch_hash: 'c'.repeat(64), batch_leaf: leaf, acts_root: 'e'.repeat(64), actor_id: 'actor',
        first_index: 0, count: 2, anchor: { day, anchor_batch_id: id, ...(segment !== undefined ? { segment } : {}), leaf_index: 0, proof: [], merkle_root: root, tx_hash: null } }] }] };
}
const catalog = { segment_2: { anchor_batch_id: id, merkle_root: root } };

describe('immutable Archive segment metadata repair', () => {
  it('repairs only the missing segment and verifies it, then is idempotent', async () => {
    const before = record();
    const bytes = JSON.stringify(before);
    const verifyPE = jest.fn(async () => true);
    const repaired = await repairArchiveDaySegments(before, catalog, { verifyPE });
    expect(repaired).toMatchObject({ found: 1, repaired: 1, verified: 1, affectedPes: 2 });
    expect(repaired.parts[0].batches[0].anchor.segment).toBe(2);
    expect(JSON.stringify(before)).toBe(bytes);
    expect({ ...repaired.parts[0], batches: [] }).toEqual({ ...before.parts[0], batches: [] });
    const again = await repairArchiveDaySegments({ ...before, parts: repaired.parts }, catalog, { verifyPE });
    expect(again).toMatchObject({ found: 0, repaired: 0, verified: 1 });
    expect(verifyPE).toHaveBeenCalledTimes(2);
  });
  it('refuses a missing catalog entry', async () => {
    await expect(repairArchiveDaySegments(record(), {}, { verifyPE: async () => true })).rejects.toThrow('not_in_catalog');
  });
  it('refuses a different root or explicit wrong segment', async () => {
    await expect(repairArchiveDaySegments(record(), { segment_2: { anchor_batch_id: id, merkle_root: 'other' } }, { verifyPE: async () => true })).rejects.toThrow('root_differs');
    await expect(repairArchiveDaySegments(record(1), catalog, { verifyPE: async () => true })).rejects.toThrow('id_mismatch');
  });
  it('refuses an inconsistent identity or carried root even if a chain stub accepts', async () => {
    const original=record(2);
    const wrongIdentity={...original,parts:original.parts.map(p=>({...p,batches:p.batches.map(b=>({...b,actor_id:'foreign'}))}))};
    await expect(repairArchiveDaySegments(wrongIdentity,catalog,{verifyPE:async()=>true})).rejects.toThrow('identity_mismatch');
    const wrongRoot={...original,parts:original.parts.map(p=>({...p,batches:p.batches.map(b=>({...b,anchor:{...b.anchor,merkle_root:'0x'+'f'.repeat(64)}}))}))};
    await expect(repairArchiveDaySegments(wrongRoot,catalog,{verifyPE:async()=>true})).rejects.toThrow('proof_invalid');
  });
  it('RED: an on-chain refusal never becomes a repair', async () => {
    await expect(repairArchiveDaySegments(record(), catalog, { verifyPE: async () => false })).rejects.toThrow('not_verified');
  });
});


describe('Archive confirmation validates carried segments before the recent-record shortcut', () => {
  it('accepts the real segment, refuses its omission and a broken path, and verifies a different cached root on chain', async () => {
    const b=record(2).parts[0].batches[0];
    const batch={...b,anchor:{...b.anchor,merkle_root:hashEnvelopeHashLeaf(b.batch_leaf)}};
    const recent={device_id:'device',actor_id:b.actor_id,batch_leaf:b.batch_leaf,acts_root:b.acts_root,seq:b.seq,anchored:true,anchor:batch.anchor};
    const verifyPE=jest.fn(async()=>false);
    const deps={anchor:{verifyPE}} as unknown as ArchiveDeps;
    expect(await checkBatchAnchored(deps,day,'device',batch,recent)).toBe('anchored');
    expect(verifyPE).not.toHaveBeenCalled();
    expect(await checkBatchAnchored(deps,day,'device',{...batch,anchor:{...batch.anchor,segment:undefined}},recent)).toEqual({mismatch:'batch_anchor_id_differs:1'});
    expect(await checkBatchAnchored(deps,day,'device',{...batch,anchor:{...batch.anchor,proof:['0x'+'f'.repeat(64)]}},recent)).toEqual({mismatch:'batch_anchor_proof_invalid:1'});
    expect(await checkBatchAnchored(deps,day,'device',batch,{...recent,anchor:{...recent.anchor,merkle_root:'other'}})).toEqual({mismatch:'batch_not_anchored_on_chain:1'});
    expect(verifyPE).toHaveBeenCalledTimes(1);
  });
});
