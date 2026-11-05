import {describe,it,expect} from 'vitest';
import {createHash} from 'crypto';
import fs from 'fs';import os from 'os';import path from 'path';
import {buildPeV2} from './pe-builder';
import {FsPeStore} from './pe-store';
import {sealPrivatePricing} from './private-pricing';
import {buildBatch,batchHashOf,actRecordOf,hardwareNonceOfAct,peHashOf,pricingOf} from '../meter-wire';
import {openPrivatePricing,unwrapPrivateBatch} from '../../../provian-backend/src/core/meter/private-pricing';

import {detailMatchesPe,recordHashOf} from '../pe-export-wire';
const secret='existing-registered-test-device-secret',nextSecret='existing-recovered-test-credential';
const privatePath='/workspace/private-client/repository';
const content={action_type:'agent_tool_orchestration',description:privatePath,metadata:{source:'transcript',tool_count:1,tool_names:[privatePath],author_email:'private-client@example.invalid',resource:privatePath},compute:null,geo:null,execution_env:{cwd:privatePath},parent_goal_pe_id:null,input_origins:[{origin_identifier:'repo:'+privatePath+'@private-branch',hash:'sha256:'+createHash('sha256').update(privatePath).digest('hex'),witnessed:true,witness:{type:'observer_device',device_id:'d'}}]};
describe(' owner-secret commitments and original ciphertext admission',()=>{
 it('RED old wire exposes private repo, metadata and dictionary hash; new wire preserves exact pricing',async()=>{
  const old=await buildPeV2({content,deviceId:'d',prevHash:'genesis',timestampMs:1,peId:'pe_old'});
  const pe=await buildPeV2({content,deviceId:'d',prevHash:'genesis',timestampMs:1,peId:'pe_private',privacySecret:secret});
  const act=actRecordOf(pe),wire=JSON.stringify(act);
  expect(JSON.stringify(actRecordOf(old))).toContain(privatePath);
  expect(wire).not.toMatch(/private-client|private-branch|author_email|example.invalid|workspace/);
  expect(wire).not.toContain(String(pe.private_commitment));
  expect(openPrivatePricing(act,String(pe.private_commitment))).toEqual(pricingOf(old));
  expect(()=>openPrivatePricing(act,nextSecret)).toThrow();
  const guesses=['/workspace/public-client/repository',privatePath];
  expect(guesses.find(g=>createHash('sha256').update(g).digest('hex')===String(content.input_origins[0].hash).slice(7))).toBe(privatePath);
  expect(guesses.some(g=>peHashOf({...pe,description:g,private_commitment:''})===pe.pe_hash)).toBe(false);
  expect(pe.description).toBe(privatePath);
 });
 it('queued PE survives restart and credential recovery; RED old credential cannot open new transport wrapper',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'d554-private-rotation-'));
  try {
   let store=new FsPeStore('d',dir);
   const pe=await buildPeV2({content,deviceId:'d',prevHash:'genesis',timestampMs:1,peId:'pe_queued',privacySecret:secret});
   await store.append(pe);store=new FsPeStore('d',dir);
   const saved=(await store.readPes(0,1))[0].pe;expect(saved).toEqual(pe);
   const batch=buildBatch({device_id:'d',seq:1,prev_batch_hash:'genesis',created_at_ms:2,pes:[saved]});
   const hash=batchHashOf(batch),nonce=hardwareNonceOfAct(batch.acts[0]),openings={[saved.pe_id]:String(saved.private_commitment)};
   const renewed={batch,private_openings:sealPrivatePricing(openings,nextSecret,hash)};
   expect(()=>unwrapPrivateBatch(renewed,secret)).toThrow();
   const reopened=unwrapPrivateBatch(renewed,nextSecret);
   expect(reopened.batch).toEqual(batch);expect(batchHashOf(reopened.batch as typeof batch)).toBe(hash);
   expect(hardwareNonceOfAct(batch.acts[0])).toBe(nonce);expect(saved.pe_hash).toBe(pe.pe_hash);
   expect(openPrivatePricing(batch.acts[0],reopened.openings[saved.pe_id])).toEqual(pricingOf(await buildPeV2({content,deviceId:'d',prevHash:'genesis',timestampMs:1,peId:'pe_queued'})));
   expect(JSON.stringify(renewed)).not.toContain(privatePath);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
 });
 it('phone detail commitment defeats old guessing and remains independently verifiable from owner export',async()=>{
  const phoneModule=path.resolve(__dirname,'../../../src/core/meter/phonePeBuilder.ts');
  const {buildPhonePeV2}=await import(/* @vite-ignore */phoneModule);
  const env={envelope_id:'phone-private',timestamp:1,action_type:'ai_conversation',intent_text:privatePath,device_attestation_depth:'software',ai_conversation_metadata:{provider:'openai',model:'m',turn_count:1}} as never;
  const detail=env as unknown as Record<string,unknown>,hash=recordHashOf(detail);
  const old=await buildPhonePeV2({envelope:env,detailHash:hash,deviceId:'d',prevHash:'genesis'});
  const pe=await buildPhonePeV2({envelope:env,detailHash:hash,deviceId:'d',prevHash:'genesis',privacySecret:secret});
  expect(old.detail_hash).toBe(hash);
  expect(pe.detail_hash).not.toBe(hash);expect(detailMatchesPe(detail,pe)).toBe(true);
  expect(detailMatchesPe({...detail,intent_text:'/another/private/path'},pe)).toBe(false);
  const wire=JSON.stringify(actRecordOf(pe));expect(wire).not.toContain(privatePath);expect(wire).not.toContain(String(pe.private_commitment));
  expect(openPrivatePricing(actRecordOf(pe),String(pe.private_commitment)).detail_hash).toBe(pe.detail_hash);
 });
});
