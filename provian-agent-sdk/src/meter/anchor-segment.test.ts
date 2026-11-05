import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildPeExport} from './export';
import {MemoryPeStore,FsPeStore} from './pe-store';
import { describe, expect, it, vi } from 'vitest';
import { x25519 } from '@noble/curves/ed25519';
import { MemoryArchiveObjectCache } from './archive-cache';
import { anchoredStore } from './anchored-store.test-support';
import { ArchiveKeeper, type ArchiveTransport } from './archive';
import { actInclusionProofFor } from './prove';
import { batchLeafOf } from '../meter-wire';
import { anchoredLeafOf, meterAnchorBatchIdOf, PE_EXPORT_PE_ANCHOR, verifyExportOffline, repairArchivePayloadSegments } from '../pe-export-wire';
import { buildArchiveEntries, bytesToB64u, sealArchivePart } from '../pe-archive-wire';

const offline: ArchiveTransport = {
  getStatus: async () => ({ status: 503, body: null, error: 'offline' }),
  uploadPart: async () => ({ status: 503, body: null, error: 'offline' }),
  listDays: async () => ({ status: 200, body: { days: [] }, error: null }),
  getDayObject: async () => ({ status: 404, bytes: null, error: 'missing' }),
};

async function fixture(segment?: number, verified = true) {
    const { store, pes } = await anchoredStore({ anchored: false });
    const [batch] = await store.listBatches();
    const day = new Date(batch.accepted_at_ms!).toISOString().slice(0, 10);
    const leaf = batchLeafOf({ device_id: store.deviceId, actor_id: batch.actor_id!, seq: batch.seq, batch_hash: batch.batch_hash, acts_root: batch.acts_root! });
    await store.recordProof({ seq: batch.seq, batch_hash: batch.batch_hash, acts_root: batch.acts_root!, actor_id: batch.actor_id!, batch_leaf: leaf,
      anchor: { day, ...(segment !== undefined ? { segment } : {}), anchor_batch_id: meterAnchorBatchIdOf(day, segment), leaf_index: 0, leaf_count: 1,
        leaf_hash: anchoredLeafOf(leaf), proof: [], merkle_root: anchoredLeafOf(leaf), anchor_tx_hash: null, anchored_at_ms: 1 }, fetched_at_ms: 1, verified });
    return { store, pes, batch, day };
}

describe('segmented Archive producer', () => {
  it.each([undefined, 1, 3])('preserves segment %s through upload and presentation', async segment => {
    const { store, pes, batch, day } = await fixture(segment);
    const days = await new ArchiveKeeper({ store, transport: offline }).readyDays();
    expect(days).toHaveLength(1);
    const built = buildArchiveEntries(day, days[0].batches, PE_EXPORT_PE_ANCHOR);
    expect(built.refs[0].anchor.segment).toBe(segment);
    for (const e of built.entries) {
      const report = verifyExportOffline([{ type: 'received', source: 'archive', mailbox_id: null, from_actor: batch.actor_id!, from_device: store.deviceId,
        batch_hash: batch.batch_hash, received_at_ms: null, pe: e.pe, status: 'anchored', inclusion: e.inclusion }]);
      expect(report.failures).toEqual([]);
    }
    const fact = await actInclusionProofFor(store, pes[0].pe_id);
    expect(fact.ok).toBe(true);
    if (fact.ok) expect(fact.proof.anchor?.segment).toBe(segment);
  });
});


describe('legacy Archive proof repair', () => {
  it('repairs missing segments after decrypting cached immutable bytes and rejects a conflicting repair', async () => {
    const { store, batch, day } = await fixture(2);
    const [plan] = await new ArchiveKeeper({store, transport: offline}).readyDays();
    const valid = buildArchiveEntries(day, plan.batches, PE_EXPORT_PE_ANCHOR);
    const damaged = buildArchiveEntries(day, plan.batches.map(b => ({...b, anchor: {...b.anchor, segment: undefined}})), PE_EXPORT_PE_ANCHOR);
    expect(() => repairArchivePayloadSegments({schema:'provian.pe-archive-payload.v1',wallet:'owner',day,device_id:store.deviceId,part:0,entries:damaged.entries}, valid.refs.map(r=>({...r,anchor:{...r.anchor,segment:99}})))).toThrow('repair_unavailable');
    const secret = new Uint8Array(32).fill(7);
    const sealed = sealArchivePart({wallet:'owner',day,device_id:store.deviceId,part:0,entries:damaged.entries,refs:damaged.refs,recipients:[{party_id:'owner',pubkey_b64u:bytesToB64u(x25519.getPublicKey(secret))}]});
    const original = sealed.line;
    const getDayObject = vi.fn(async()=>({status:200,bytes:sealed.bytes,error:null}));
    const transport: ArchiveTransport = {...offline, getDayObject, getDayProofs:async()=>({status:200,error:null,body:{days:[{wallet:'owner',day,proof_repairs:valid.refs}]}})};
    const keeper = new ArchiveKeeper({store,transport,messageSecretKey:async()=>secret.slice(),objectCache:new MemoryArchiveObjectCache()});
    for(let i=0;i<2;i++){
      const pulled=await keeper.pullDay(day,'owner');
      expect(pulled.ok).toBe(true);
      if(!pulled.ok) throw new Error(pulled.reason);
      expect(pulled.payloads[0].entries).toHaveLength(2);
      for(const e of pulled.payloads[0].entries){
        expect(e.inclusion.anchor?.segment).toBe(2);
        const report=verifyExportOffline([{type:'received',source:'archive',mailbox_id:null,from_actor:batch.actor_id!,from_device:store.deviceId,batch_hash:batch.batch_hash,received_at_ms:null,pe:e.pe,status:'anchored',inclusion:e.inclusion}]);
        expect(report.failures).toEqual([]);
      }
    }
    expect(getDayObject).toHaveBeenCalledTimes(1);
    expect(sealed.line).toBe(original);
  });
  it('uses complete metadata to revalidate an unverified proof retained in a backup',async()=>{
    const {store,pes}=await fixture(1,false);
    expect((await store.listProofs())[0].verified).toBe(true);
    const result=await actInclusionProofFor(store,pes[0].pe_id);
    expect(result.ok && result.anchored).toBe(true);
  });
});


describe('restored full batch metadata supersedes adopted log entries',()=>{
  it.each([['memory',true],['memory',false],['disk',true],['disk',false]] as const)('%s store, adopted first %s',async(kind,adoptedFirst)=>{
    const f=await fixture(2);
    const [proof]=await f.store.listProofs();
    const root=mkdtempSync(join(tmpdir(),'provian-restored-batch-'));
    try{
      let store=kind==='memory'?new MemoryPeStore(f.store.deviceId):new FsPeStore(f.store.deviceId,root);
      for(const pe of f.pes)await store.append(pe);
      const adopted={...f.batch,adopted:true,acts_root:null,actor_id:null};
      if(adoptedFirst)await store.recordBatch(adopted,null);
      // An earlier mismatching complete row cannot shadow the valid restored metadata either.
      await store.recordBatch({...f.batch,acts_root:'f'.repeat(64)},null);
      await store.recordProof({...proof,verified:false});
      expect((await store.listProofs())[0].verified).toBe(false);
      await store.recordBatch(f.batch,null);
      if(!adoptedFirst)await store.recordBatch(adopted,null);
      if(kind==='disk')store=new FsPeStore(f.store.deviceId,root);
      expect((await store.listProofs())[0].verified).toBe(true);
      const result=await actInclusionProofFor(store,f.pes[0].pe_id);
      expect(result.ok&&result.anchored).toBe(true);
      if(!result.ok)throw new Error(result.reason);
      expect(result.proof.anchor?.segment).toBe(2);
      const report=verifyExportOffline([{type:'received',source:'archive',mailbox_id:null,from_actor:f.batch.actor_id!,from_device:store.deviceId,batch_hash:f.batch.batch_hash,received_at_ms:null,pe:f.pes[0],status:'anchored',inclusion:result.proof}]);
      expect(report.counts.received.proven_to_root).toBe(1);expect(report.failures).toEqual([]);
      if(kind==='disk')expect(JSON.parse(readFileSync(join(store.location,'proofs.jsonl'),'utf8').trim()).verified).toBe(false);
    }finally{rmSync(root,{recursive:true,force:true});}
  });
});

it.each([true,false])('exports the complete restored proof with adopted placeholder first %s',async first=>{
 const f=await fixture(2);const [proof]=await f.store.listProofs();const store=new MemoryPeStore(f.store.deviceId);
 for(const pe of f.pes)await store.append(pe);
 const old={...f.batch,adopted:true,actor_id:null,acts_root:null};
 if(first)await store.recordBatch(old,null);
 await store.recordBatch(f.batch,null);
 if(!first)await store.recordBatch(old,null);
 await store.recordProof({...proof,verified:false});
 const out=await buildPeExport({stores:[store],owner:{wallet_id:f.batch.actor_id,address:null},mailbox:{waiting:0,truncated:false,reason:null},archive:{readStatus:async()=>({ok:true,wallet:f.batch.actor_id!,on:false}),listDays:async()=>({ok:true,days:[]}),pullDay:async()=>({ok:false,reason:'not_archived'})}});
 const lines=out.text.trim().split('\n').slice(1).map(line=>JSON.parse(line)).filter(line=>line.type!=='end');
 const report=verifyExportOffline(lines);
 expect(report.counts.pe.proven_to_root).toBe(f.pes.length);
 expect(report.failures).toEqual([]);
 expect(out.incomplete).toHaveLength(1);
 expect(out.incomplete[0].reason).toMatch(/^only_this_machine:/);
});
