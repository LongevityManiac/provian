import { id } from 'ethers';
import { MEMBER_SETTLEMENT_ABI as abi } from './issuance-ticket';
import { decodeIssuanceProbe,simulatePrivateIssuanceProbe } from './settlement-issuance-probe';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { currentProtocolDeployment } from '../protocol/runtime';
import { issuanceBatchFixture } from './__test-helpers__/issuance-batch-fixture';
import { a,h } from './__test-helpers__/membership-receipt-fixture';
jest.mock('../onchain/rpc-provider',()=>({getOperatorBoundRpcLegs:jest.fn()}));
jest.mock('../protocol/runtime',()=>({currentProtocolDeployment:jest.fn()}));
const result=(ok:boolean,data='0x')=>abi.encodeErrorResult('ProbeResult',[ok,data]);
function setup(){
 const {batch}=issuanceBatchFixture();
 const input={target:batch.target,data:abi.encodeFunctionData('probeMemberBatch',[batch.kernelCall,batch.context,batch.tickets]),blockHash:h(99),manifestHash:h(500)};
 const deployment={manifestHash:input.manifestHash,addresses:{settlement:input.target}};
 const rpc=(error:unknown)=>jest.fn(async(method:string):Promise<unknown>=>{
  if(method==='eth_getBlockByHash'||method==='eth_getBlockByNumber')return {hash:h(99),number:'0x63'};
  throw error;
 });
 const first=rpc({code:'CALL_EXCEPTION',data:result(true)});
 const second=rpc({info:{error:{code:3,data:result(true)}}});
 const legs=[{operatorId:'first',provider:{send:first}},{operatorId:'second',provider:{send:second}}];
 (getOperatorBoundRpcLegs as jest.Mock).mockReturnValue(legs);
 (currentProtocolDeployment as jest.Mock).mockResolvedValue(deployment);
 return {input,first,second,legs,deployment};
}
beforeEach(()=>jest.resetAllMocks());
test('two structured canonical rollback responses establish feasibility at one pinned block',async()=>{
 const s=setup();await expect(simulatePrivateIssuanceProbe(s.input,a(900))).resolves.toEqual({ok:true,revertReason:null});
 for(const call of [s.first,s.second])expect(call).toHaveBeenCalledWith('eth_call',[
  {to:s.input.target,from:a(900),data:s.input.data},{blockHash:h(99),requireCanonical:true}]);
});
test('nested fake success remains a failed kernel execution',()=>{
 const nested=result(true);
 expect(()=>decodeIssuanceProbe(result(false,nested))).toThrow('inconclusive');
});
test('truncated, empty, trailing, noncanonical or empty failed results are inconclusive',()=>{
 const raw=result(true), invalidBool=`${raw.slice(0,10)}${'0'.repeat(63)}2${raw.slice(74)}`;
 for(const value of ['0x',raw.slice(0,-2),`${raw}00`,invalidBool,result(false),result(true,'0x1234')])expect(()=>decodeIssuanceProbe(value)).toThrow('inconclusive');
});
test('timeout, opaque errors, normal returns and RPC disagreement cannot identify poisoned claims',async()=>{
 for(const mode of ['timeout','message','disagreement','return']){
  const s=setup();
  if(mode==='timeout')s.second.mockImplementation(async(method:string)=>{if(method!=='eth_call')return {hash:h(99),number:'0x63'};throw Error('timeout');});
  if(mode==='message')s.second.mockImplementation(async(method:string)=>{if(method!=='eth_call')return {hash:h(99),number:'0x63'};throw Error(`revert ${result(true)}`);});
  if(mode==='disagreement')s.second.mockImplementation(async(method:string)=>{if(method!=='eth_call')return {hash:h(99),number:'0x63'};throw {code:'CALL_EXCEPTION',data:result(false,'0x12345678')};});
  if(mode==='return')s.second.mockImplementation(async(method:string)=>method==='eth_call'?result(true):{hash:h(99),number:'0x63'});
  await expect(simulatePrivateIssuanceProbe(s.input,a(900))).rejects.toThrow('recourse_issuance_probe_');
 }
});
test('changed pointer, wrong entrypoint and duplicate operators refuse the probe',async()=>{
 for(const mode of ['pointer','entry','operators']){
  const s=setup();
  if(mode==='pointer')(currentProtocolDeployment as jest.Mock).mockResolvedValueOnce(s.deployment).mockResolvedValue({...s.deployment,manifestHash:h(501)});
  if(mode==='entry')s.input.data=abi.encodeFunctionData('cancelMemberBatch',[h(5),1]);
  if(mode==='operators')s.legs[1].operatorId=s.legs[0].operatorId;
  await expect(simulatePrivateIssuanceProbe(s.input,a(900))).rejects.toThrow('recourse_issuance_probe_');
 }
});

test('only specific kernel claim errors inform bisection; approval, cursor and membership lag do not',()=>{
 const claim=id('InvalidClaim()').slice(0,10);
 expect(decodeIssuanceProbe(result(false,claim))).toEqual({ok:false,revertReason:claim});
 for(const name of ['VerificationFailed','CursorDiscontinuity','EpochMismatch','InvalidIssuanceTicket','InvalidConfiguration'])
  expect(()=>decodeIssuanceProbe(result(false,id(`${name}()`).slice(0,10)))).toThrow('inconclusive');
});
test('same-manifest reorg after both calls refuses the old block result',async()=>{
 const s=setup();
 for(const send of [s.first,s.second])send.mockImplementation(async(method:string)=>{
  if(method==='eth_getBlockByHash')return {hash:h(99),number:'0x63'};
  if(method==='eth_getBlockByNumber')return {hash:h(100),number:'0x63'};
  throw {code:'CALL_EXCEPTION',data:result(true)};
 });
 await expect(simulatePrivateIssuanceProbe(s.input,a(900))).rejects.toThrow('reorg');
});
