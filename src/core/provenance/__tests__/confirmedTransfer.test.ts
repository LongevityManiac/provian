import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { sha256, toUtf8Bytes } from 'ethers';
import type { BiometricAction } from '../../security/biometricAction';
import type { ProvenanceEnvelope } from '../types';
const f=vi.hoisted(()=>({mem:new Map<string,string>(),signs:0,failIndex:false,failWal:false,untrusted:false}));
vi.mock('@react-native-async-storage/async-storage',()=>({default:{getItem:async(k:string)=>f.mem.get(k)??null,
 setItem:async(k:string,v:string)=>{if(f.failWal&&k==='provian_pe_wal')throw Error('disk full');f.mem.set(k,v);},removeItem:async(k:string)=>{f.mem.delete(k);}}}));
vi.mock('../../security/hmacAsyncStorage',()=>({getItemHmac:async(k:string,options?:{preserveInvalid?:boolean})=>{if(f.untrusted){if(!options?.preserveInvalid)f.mem.delete(k);return null;}return JSON.parse(f.mem.get(k)??'null');},getItemHmacWithLegacyFallback:async(k:string)=>JSON.parse(f.mem.get(k)??'null'),
 setItemHmac:async(k:string,v:unknown)=>{if(f.failIndex&&k.startsWith('provian_transfer_pe_')&&!k.endsWith('_pending')){f.failIndex=false;throw Error('index interrupted');}f.mem.set(k,JSON.stringify(v));}}));
vi.mock('../../security/KeyManager',()=>({default:{getAddress:async()=>`0x${'11'.repeat(20)}`,performDeviceAttestation:async()=>({deviceId:'device',isHardwareBacked:true,securityLevel:'hardware'}),
 signPayload:async(payload:string)=>{f.signs++;return sha256(toUtf8Bytes(payload));},verifySignature:async(payload:string,signature:string)=>({isValid:sha256(toUtf8Bytes(payload))===signature})}}));
vi.mock('../../footprint/FootprintService',()=>({ingestPE:async()=>{},estimateFromPE:()=>0}));
vi.mock('../../meter/outputSigning',()=>({withQueuedOutputCitations:(input:unknown)=>input}));
vi.mock('../PELifecycleManager',()=>({default:{addPEToHotTier:async()=>{},initialize:async()=>{}}}));
import manager from '../ProvenanceEnvelopeManager';
const a=(n:string)=>`0x${n.repeat(20)}`,hash=`0x${'33'.repeat(32)}`,action={}as BiometricAction;
const input={txHash:hash,chainId:8453,actorAddress:a('11'),counterparty:a('22'),contract:a('44'),assetSymbol:'PVT',amount:'1.0'};
const state=manager as unknown as {pendingQueue:ProvenanceEnvelope[];flushTimer:ReturnType<typeof setTimeout>|null;hashCache:Map<string,string>;flushQueue():Promise<void>};
beforeEach(()=>{vi.useFakeTimers();f.mem.clear();f.signs=0;f.failIndex=false;f.failWal=false;f.untrusted=false;state.pendingQueue=[];state.flushTimer=null;state.hashCache.clear();});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});
test('concurrent and archived completion retries retain one signed occurrence and refuse changed transfer fields',async()=>{
 const [first,retry]=await Promise.all([manager.createConfirmedTransferEnvelope(input,action),manager.createConfirmedTransferEnvelope(input,action)]);
 expect(first.envelope_id).toBe(retry.envelope_id);expect(f.signs).toBe(1);expect(JSON.parse(f.mem.get('provian_pe_wal')!)).toHaveLength(1);
 f.mem.delete('provian_pe_wal');state.pendingQueue=[];
 expect((await manager.createConfirmedTransferEnvelope(input,action)).envelope_id).toBe(first.envelope_id);expect(f.signs).toBe(1);
 await expect(manager.createConfirmedTransferEnvelope({...input,amount:'2.0'},action)).rejects.toThrow('record_changed');expect(f.signs).toBe(1);
});
test('a crash after WAL write but before indexing resumes the signed occurrence without re-signing',async()=>{
 f.failIndex=true;await expect(manager.createConfirmedTransferEnvelope(input,action)).rejects.toThrow('index interrupted');
 const wal=JSON.parse(f.mem.get('provian_pe_wal')!);expect(wal).toHaveLength(1);state.pendingQueue=[];
 expect((await manager.createConfirmedTransferEnvelope(input,action)).envelope_id).toBe(wal[0].envelope_id);
 expect(f.signs).toBe(1);expect(state.pendingQueue).toHaveLength(1);
});
test('failed WAL persistence cannot mark a confirmed transfer recorded',async()=>{
 f.failWal=true;await expect(manager.createConfirmedTransferEnvelope(input,action)).rejects.toThrow('disk full');
 expect([...f.mem.keys()].some(k=>k.startsWith('provian_transfer_pe_')&&!k.endsWith('_pending'))).toBe(false);expect(state.pendingQueue).toHaveLength(0);
 f.failWal=false;await manager.createConfirmedTransferEnvelope(input,action);expect(JSON.parse(f.mem.get('provian_pe_wal')!)).toHaveLength(1);
});

test('flushing a recovered WAL rebuilds the occurrence index before clearing its only retry evidence',async()=>{
 f.failIndex=true;await expect(manager.createConfirmedTransferEnvelope(input,action)).rejects.toThrow('index interrupted');
 const first=JSON.parse(f.mem.get('provian_pe_wal')!)[0];
 f.mem.set('pe_migration_complete','true');await state.flushQueue();
 expect(f.mem.has('provian_pe_wal')).toBe(false);
 expect((await manager.createConfirmedTransferEnvelope(input,action)).envelope_id).toBe(first.envelope_id);expect(f.signs).toBe(1);
});
test('a tampered WAL cannot be promoted into the authenticated occurrence index',async()=>{
 f.failIndex=true;await expect(manager.createConfirmedTransferEnvelope(input,action)).rejects.toThrow('index interrupted');
 const wal=JSON.parse(f.mem.get('provian_pe_wal')!);wal[0].intent_text='forged record';f.mem.set('provian_pe_wal',JSON.stringify(wal));
 await expect(manager.createConfirmedTransferEnvelope(input,action)).rejects.toThrow('signature_invalid');
 expect([...f.mem.keys()].some(k=>k.startsWith('provian_transfer_pe_')&&!k.endsWith('_pending'))).toBe(false);expect(f.signs).toBe(1);
});
test('the returned and queued PE retain exactly the fields that were signed',async()=>{
 const pe=await manager.createConfirmedTransferEnvelope(input,action);
 expect((await manager.verifyPESignature(pe)).isValid).toBe(true);expect((await manager.verifyPESignature(state.pendingQueue[0])).isValid).toBe(true);
});

test('new occurrence keys never import plaintext or treat a damaged index as a new act',async()=>{
 const pe=await manager.createConfirmedTransferEnvelope(input,action);f.mem.delete('provian_pe_wal');state.pendingQueue=[];f.untrusted=true;
 for(let i=0;i<2;i++)await expect(manager.createConfirmedTransferEnvelope(input,action)).rejects.toThrow('index_invalid');expect(f.signs).toBe(1);
 expect(pe.tx_hash).toBe(hash);
});
