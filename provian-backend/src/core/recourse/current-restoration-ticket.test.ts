import { Interface } from 'ethers';
import { readCurrentRestorationTicket } from './current-restoration-ticket';
import { currentProtocolDeployment } from '../protocol/runtime';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
jest.mock('../protocol/runtime',()=>({currentProtocolDeployment:jest.fn()}));
jest.mock('../onchain/rpc-provider',()=>({getOperatorBoundRpcLegs:jest.fn()}));
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`,a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
const abi=new Interface(['function ownerAuthorization() view returns(address)','function kernel() view returns(address)',
 'function restorationIntent(bytes32) view returns(tuple(bytes32 request,bytes32 identity,address destination,bytes32 lossHash,uint256 maximumLoss))',
 'function reversalExecuted(bytes32) view returns(bool)','function recoveredDestination(bytes32) view returns(address)','function determined(bytes32) view returns(bool)']);
let mode='ok';
beforeEach(()=>{
 mode='ok';jest.resetAllMocks();let deployments=0;
 (currentProtocolDeployment as jest.Mock).mockImplementation(async()=>({addresses:{kernel:a(1),recoursePool:a(3)},blockHash:h(4),manifestHash:mode==='pointer'&&deployments++>0?h(6):h(5)}));
 (getOperatorBoundRpcLegs as jest.Mock).mockImplementation(()=>[0,1].map(index=>({operatorId:mode==='same-rpc'?'rpc':`rpc-${index}`,provider:{send:async(method:string,args:readonly unknown[])=>{
  if(method==='eth_getBlockByHash')return {hash:h(4),number:'0x14'};
  if(method==='eth_getBlockByNumber'){expect(args).toEqual(['0x14',false]);return {hash:mode==='reorg'?h(99):h(4),number:mode==='height'&&index===1?'0x15':'0x14'};}
  expect(method).toBe('eth_call');expect(args[1]).toEqual({blockHash:h(4),requireCanonical:true});
  const call=args[0]as{to:string;data:string},parsed=abi.parseTransaction({data:call.data})!;
  if(mode==='rpc'&&index===1)return '0x';
  const value:Record<string,unknown>={ownerAuthorization:a(2),kernel:mode==='kernel'?a(9):a(1),
   restorationIntent:[mode==='request'?h(9):h(7),mode==='identity'?h(0):h(8),mode==='destination'?a(0):a(10),h(11),100],
   recoveredDestination:mode==='current'?a(0):a(12),reversalExecuted:mode==='reversed',determined:mode==='determined'};
  if(parsed.name==='determined')expect(call.to).toBe(a(3));
  return abi.encodeFunctionResult(parsed.name,[value[parsed.name]]);
 }}})));
});
test('a surviving current imported ticket binds exact consent and destination without pretending to trace old balances',async()=>{
 expect(await readCurrentRestorationTicket(h(7))).toEqual({request:h(7),identity:h(8),destination:a(10),currentDestination:a(12),lossHash:h(11),maximumLoss:'100'});
});
test.each(['kernel','request','identity','destination','current','reversed','determined','pointer','rpc','same-rpc','reorg','height'])('refuses changed or completed current ticket: %s',async failure=>{
 mode=failure;await expect(readCurrentRestorationTicket(h(7))).rejects.toThrow();
});
