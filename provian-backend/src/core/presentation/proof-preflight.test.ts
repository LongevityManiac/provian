import {Wallet} from 'ethers';
import {preflightPresentationFromRequest,type PresenterPrincipal} from './service';
import {claimsDigest,presentationBindingString} from './types';
import {actRecordOf,actLeafOf,merkleRootOf,batchLeafOf,peHashOf,PE_V2_SCHEMA,METER_GENESIS_PREV_HASH} from '../meter/meter-wire';
import {meterAnchorBatchId} from '../meter/meter-anchor';
import {hashEnvelopeHashLeaf} from '../pvt/merkle';

const owner='human-test';
const signer=Wallet.createRandom();
const principal:PresenterPrincipal={kind:'human',walletId:'wallet-test',address:signer.address.toLowerCase(),peOwnerUserId:owner,standing:{}};
const pe={schema:PE_V2_SCHEMA,pe_id:'pe-preflight',device_id:'device-test',prev_hash:METER_GENESIS_PREV_HASH,timestamp:1791606000000,action_type:'coding_session',metadata:{commit_sha:'a'.repeat(40)}};
const hash=peHashOf(pe);
const batch={device_id:pe.device_id,actor_id:owner,seq:1,batch_hash:'b'.repeat(64)};
const acts_root=merkleRootOf([actLeafOf(actRecordOf(pe))]);
const leaf=hashEnvelopeHashLeaf(batchLeafOf({...batch,acts_root}));
const inclusion={act_index:0,act_proof:[],acts_root,batch,anchor:{day:'2026-10-10',segment:2,proof:[]}};
const fact={pe_id:pe.pe_id,envelope_hash:hash,pe,inclusion};
async function body(facts:unknown[]=[fact],tier='pe_fact',disclosures?:unknown[]) {
 const iat=Math.floor(Date.now()/1000),exp=iat+300,burn_id='0'.repeat(64),audience='requester',challenge='a'.repeat(32),jti='preflight-test';
 const digest=claimsDigest(tier==='pe_fact'?{tier:'pe_fact',pe_facts:facts as never}:{tier:'reputation',reputation_directive:{redact:[],predicates:[]}});
 const binding=presentationBindingString({tier:tier as 'pe_fact',presenter_address:principal.address,aud:audience,chal:challenge,iat,exp,jti,burn_id,claims_digest:digest});
 return {tier,iat,exp,burn_id,audience,challenge,jti,pop:{scheme:'eip191_secp256k1',signature:await signer.signMessage(binding)},pe_facts:facts,disclosures};
}
function deps(){
 const db=new Proxy({},{get(){throw new Error('preflight_must_not_read_or_write_db');}}) as FirebaseFirestore.Firestore;
 return {db,vocabulary:jest.fn(async()=>{throw new Error('must_not_read_vocabulary');}),peAnchor:{verifyPE:jest.fn(async(id:string,l:string,p:string[])=>id===meterAnchorBatchId('2026-10-10',2)&&l===leaf&&p.length===0)}};
}

describe('issuance proof preflight before any burn',()=>{
 it('accepts a real segmented proof without storage, vocabulary or a signing key',async()=>{
  const d=deps();expect(await preflightPresentationFromRequest(d,principal,await body())).toEqual({ok:true});
  expect(d.peAnchor.verifyPE).toHaveBeenCalledTimes(1);expect(d.vocabulary).not.toHaveBeenCalled();
 });
 it('refuses foreign ownership, absent/wrong segment, malformed hop, and empty/excessive claims',async()=>{
  for(const facts of [[],[{...fact,inclusion:{...inclusion,batch:{...batch,actor_id:'foreign'}}}],[{...fact,inclusion:{...inclusion,anchor:{...inclusion.anchor,segment:undefined}}}],[{...fact,inclusion:{...inclusion,anchor:{...inclusion.anchor,segment:99}}}],[{...fact,inclusion:{...inclusion,act_proof:['bad']}}],Array.from({length:51},(_,i)=>({...fact,pe_id:'pe-'+i}))]){
   const d=deps();const result=await preflightPresentationFromRequest(d,principal,await body(facts));expect(result.ok).toBe(false);expect(d.vocabulary).not.toHaveBeenCalled();
  }
 });
 it('rejects a submitted burn before the eager recorder can run',async()=>{
  const result=await preflightPresentationFromRequest(deps(),principal,{...await body(),burn:{tx_hash:'0x'+'c'.repeat(64),amount_atomic:'5000000000000000000'}});
  expect(result).toMatchObject({ok:false,reason:'preflight_burn_forbidden'});
 });
 it('refuses oversized and mismatched disclosures before any burn',async()=>{
  const request={kind:'pe',output_digest:'d'.repeat(64)};
  const record={pe_id:pe.pe_id,pe_hash:hash,pe,inclusion};
  for(const disclosures of [[{request,election:'disclosed',records:[record,record]}],[{request,election:'disclosed',records:[record]}]]){
    const result=await preflightPresentationFromRequest(deps(),principal,await body([],'reputation',disclosures));
    expect(result.ok).toBe(false);
    if(!result.ok)expect(result.error).toMatch(/malformed|disclosure_record_mismatch/);
  }
 });
});
