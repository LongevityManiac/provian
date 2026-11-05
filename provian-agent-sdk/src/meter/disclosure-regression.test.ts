import { describe, it, expect } from 'vitest';
import { MemoryPeStore } from '../meter/pe-store';
import { findDisclosureRecords } from '../meter/disclose';
import { peFactFromStore } from '../meter/prove';
import { normalizeDisclosureRequests } from '../disclosure-request';
import { PE_V2_SCHEMA, METER_GENESIS_PREV_HASH, peHashOf, actsRootOf, actRecordOf, batchLeafOf } from '../meter-wire';

describe('requester-named archived disclosure', () => {
  it('finds an archived PE by its own hash when the Archive can return its anchored record', async () => {
    const device='device_archive_repro', actor='wallet_archive_repro';
    const store=new MemoryPeStore(device);
    const base={schema:PE_V2_SCHEMA,pe_id:'pe_archived_repro',device_id:device,prev_hash:METER_GENESIS_PREV_HASH,timestamp:Date.parse('2026-09-01T12:00:00Z'),action_type:'coding_session',metadata:{lines:10}};
    const pe={...base,pe_hash:peHashOf(base as any)};
    expect((await store.append(pe as any)).ok).toBe(true);
    const root=actsRootOf([actRecordOf(pe as any)]), hash='a'.repeat(64);
    await store.recordBatch({seq:1,batch_hash:hash,prev_batch_hash:METER_GENESIS_PREV_HASH,acts_root:root,first_index:0,count:1,last_pe_hash:pe.pe_hash,created_at_ms:1,accepted_at_ms:2,actor_id:actor,totals:null},null);
    await store.recordProof({seq:1,batch_hash:hash,acts_root:root,actor_id:actor,batch_leaf:batchLeafOf({device_id:device,actor_id:actor,seq:1,batch_hash:hash,acts_root:root}),anchor:{day:'2026-09-01',anchor_batch_id:'0x'+'b'.repeat(64),leaf_index:0,leaf_count:1,leaf_hash:'0x'+'c'.repeat(64),proof:[],merkle_root:'0x'+'c'.repeat(64),anchor_tx_hash:'0x'+'d'.repeat(64),anchored_at_ms:3},fetched_at_ms:4,verified:true});
    const before=await peFactFromStore(store,pe.pe_id);
    if(!before.ok) throw new Error(before.detail);
    const request=normalizeDisclosureRequests([{kind:'pe',output_digest:pe.pe_hash}])![0];
    expect((await findDisclosureRecords(store,request)).records.map(r=>r.peId)).toEqual([pe.pe_id]);
    await store.dropArchivedDay({day:'2026-09-01',wallet:actor,pes:[{index:0,pe_id:pe.pe_id,pe_hash:pe.pe_hash}],part_sha256s:['e'.repeat(64)]});
    let archiveCalls=0;
    const archive={async findArchivedPe(id:string){archiveCalls++;expect(id).toBe(pe.pe_id);return {ok:true as const,entry:{pe:before.fact.pe as any,inclusion:before.fact.inclusion}} as any;}};
    expect((await peFactFromStore(store,pe.pe_id,archive)).ok).toBe(true);
    archiveCalls=0;
    const result=await findDisclosureRecords(store,request,archive);
    expect(archiveCalls).toBe(1);
    expect(result.records.map(r=>r.peId)).toEqual([pe.pe_id]);
    // Same pointer far beyond the former 5000-row scan window remains directly retrievable.
    const oldHead = await store.head();
    store.head = async () => ({ ...oldHead, count: 5001 });
    expect((await findDisclosureRecords(store,request,archive,{scanLimit:5000})).records).toEqual([]);
    expect((await findDisclosureRecords(store,request,archive)).records.map(r=>r.peId)).toEqual([pe.pe_id]);
  });
});
