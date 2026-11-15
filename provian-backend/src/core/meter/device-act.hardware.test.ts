import { deviceActToAccrualParams, type DeviceBatchLane } from './device-act';
import type { ActRecord } from './meter-wire';
import type { DeviceDocument } from '../../routes/middleware/device-auth';
describe(' agent-only tool intake',()=>{
 const lane=(owner:string)=>({device:{owner_type:owner,device_id:'fixture'} as DeviceDocument,bodyBound:true,signatureAuthenticated:true,attestationTier:'software',ownerId:'fixture',receivedAtMs:Date.now(),lineage:null,lineageTouched:false} as DeviceBatchLane);
 const act=(action_type:string)=>({action_type,pe_id:'fixture',timestamp:Date.now(),device_id:'fixture',prev_hash:'genesis',pricing:{metadata:{source:'transcript',tool:'provian:transcript',tool_count:1,api_count:1}},pe_hash:'sha256:'+'a'.repeat(64)} as unknown as ActRecord);
 it('human devices reject every tool lane, including a fabricated body-bound report',async()=>{
  for(const type of ['agent_tool_orchestration','agent_api_orchestration','link_spend'])expect(await deviceActToAccrualParams(lane('human'),act(type),'fixture')).toEqual({ok:false,reason:'tool_capture_agents_only'});
 });
 it('RED control: the same agent tool observation passes that owner gate',async()=>{
  const result=await deviceActToAccrualParams(lane('agent'),act('agent_tool_orchestration'),'fixture');
  expect(result).not.toEqual({ok:false,reason:'tool_capture_agents_only'});
 });
});
