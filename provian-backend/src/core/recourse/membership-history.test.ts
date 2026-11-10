import { Interface, keccak256 } from 'ethers';
import { readLossMembership } from './membership-history';
import { RECOURSE_POOL_ABI } from './pool-abi';
import type { LossSnapshot } from './loss-snapshot';
import { currentProtocolDeployment } from '../protocol/runtime';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { getAgreedBaseLogs, readAgreedBaseBlockHash } from '../onchain/economic-discovery';
jest.mock('../protocol/runtime',()=>({currentProtocolDeployment:jest.fn()}));
jest.mock('../onchain/rpc-provider',()=>({getOperatorBoundRpcLegs:jest.fn()}));
jest.mock('../onchain/economic-discovery',()=>({getAgreedBaseLogs:jest.fn(),readAgreedBaseBlockHash:jest.fn()}));
const address=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
const hash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
const oldPool=address(1), pool=address(2),oldKernel=address(3),kernel=address(4),identity=hash(5);
const history=new Interface(['function poolSnapshot() view returns(address,uint256,bytes32,uint256,bool)']);
const code='0x6000', baseTime=Date.UTC(2026,10,1)/1000;
let disagreement=false, cycle=false, joinedBlock=20, joinedIndex=1;
function snapshot(block=80):LossSnapshot{return {identity,kernel:block>50?kernel:oldKernel,block,blockHash:hash(block),transactionHash:hash(999),
  firstOutflowLogIndex:3,recordedBalanceAtomic:'100',lossAtomic:'100',addresses:[],outflows:[],occurrence:hash(1001),evidenceHash:hash(1002)};}
beforeEach(()=>{
  jest.resetAllMocks();disagreement=false;cycle=false;joinedBlock=20;joinedIndex=1;
  (currentProtocolDeployment as jest.Mock).mockResolvedValue({blockHash:hash(100),manifestHash:hash(101),addresses:{recoursePool:pool,kernel},runtimeHashes:Array(10).fill(keccak256(code))});
  (readAgreedBaseBlockHash as jest.Mock).mockImplementation(async n=>hash(n));
  (getOperatorBoundRpcLegs as jest.Mock).mockReturnValue([0,1].map(index=>({operatorId:`operator-${index}`,provider:{send:async(method:string,params:readonly unknown[])=>{
    if(method==='eth_getBlockByHash'){const n=Number(BigInt(String(params[0])));return {hash:hash(n),number:`0x${n.toString(16)}`,timestamp:`0x${(baseTime+n).toString(16)}`};}
    if(method==='eth_getCode'){const birth=params[0]===pool?60:10;return typeof params[1]==='string'&&Number(BigInt(params[1]))<birth?'0x':code;}
    if(method!=='eth_call')throw new Error('unexpected RPC');
    const call=params[0] as {to:string;data:string};
    if(call.data===history.encodeFunctionData('poolSnapshot'))return history.encodeFunctionResult('poolSnapshot',call.to===pool?[cycle?pool:oldPool,50,hash(51),10,false]:[address(0),0,hash(0),0,false]);
    const parsed=RECOURSE_POOL_ABI.parseTransaction({data:call.data})!;
    if(parsed.name==='token')return RECOURSE_POOL_ABI.encodeFunctionResult('token',[disagreement&&index===1?address(99):call.to===pool?kernel:oldKernel]);
    throw new Error(`unexpected call ${parsed.name}`);
  }}})));
  (getAgreedBaseLogs as jest.Mock).mockImplementation(async({address:target,fromBlock,toBlock})=>{
    if(target!==oldPool||joinedBlock<fromBlock||joinedBlock>toBlock)return [];
    const event=RECOURSE_POOL_ABI.encodeEventLog(RECOURSE_POOL_ABI.getEvent('MembershipChanged')!,[identity,true,1,24322]);
    return [{...event,address:oldPool,removed:false,blockNumber:joinedBlock,blockHash:hash(joinedBlock),transactionHash:hash(200),logIndex:joinedIndex}];
  });
});
test('a carried member retains the original enrollment without a deployment environment override',async()=>{
  const previous=process.env.PVT_RECOURSE_POOL_DEPLOYMENT_BLOCK;
  delete process.env.PVT_RECOURSE_POOL_DEPLOYMENT_BLOCK;
  try {expect(await readLossMembership(snapshot())).toMatchObject({active:true,periodIndex:0,unpaidAtomic:'0'});}
  finally {if(previous!==undefined)process.env.PVT_RECOURSE_POOL_DEPLOYMENT_BLOCK=previous;}
  expect(getAgreedBaseLogs).toHaveBeenCalledWith(expect.objectContaining({address:oldPool,fromBlock:10,toBlock:50}));
  expect(getAgreedBaseLogs).toHaveBeenCalledWith(expect.objectContaining({address:pool,fromBlock:60,toBlock:80}));
});
test('a historical loss reads its original pool and keeps exact same-block enrollment ordering',async()=>{
  joinedBlock=40;joinedIndex=2;
  expect(await readLossMembership(snapshot(40))).toMatchObject({active:true,periodIndex:0});
  joinedIndex=4;
  expect(await readLossMembership(snapshot(40))).toMatchObject({active:false,periodIndex:null});
});
test('disagreeing token identity and a cyclic predecessor fail closed',async()=>{
  disagreement=true;await expect(readLossMembership(snapshot())).rejects.toThrow('rpc_disagreement');
  disagreement=false;cycle=true;await expect(readLossMembership(snapshot())).rejects.toThrow('history_cycle');
});
