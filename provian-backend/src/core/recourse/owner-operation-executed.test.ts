import { Interface,concat,sha256 } from 'ethers';
import { findExecutedOwnerOperation } from './owner-operation-executed';
import { ownerOperationIntent,type RecoveryOwnerOperation } from './owner-operation';
import { RECOVERY_AUTH_ABI } from './recovery-authorization';
import { recoveryAuthorizationFixture } from './__test-helpers__/recovery-authorization-fixture';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { getAgreedBaseLogs,readAgreedBaseHead,readAgreedBaseBlockHash } from '../onchain/economic-discovery';
import { currentProtocolDeployment } from '../protocol/runtime';
jest.mock('../onchain/rpc-provider',()=>({getOperatorBoundRpcLegs:jest.fn()}));
jest.mock('../onchain/economic-discovery',()=>({getAgreedBaseLogs:jest.fn(),readAgreedBaseHead:jest.fn(),readAgreedBaseBlockHash:jest.fn()}));
jest.mock('../protocol/runtime',()=>({currentProtocolDeployment:jest.fn()}));
const h=(b:string)=>`0x${b.repeat(32)}`,a=(b:string)=>`0x${b.repeat(20)}`,executor=a('18'),txHash=h('21'),queuedHash=h('aa');
const operation:RecoveryOwnerOperation={kernel:a('11'),identity:h('22'),destination:a('33'),nonce:0,revision:'1',proof:{
 recoverySecret:h('44'),signingRoot:h('55'),nextCommitment:h('66'),nextSigningRoot:h('77'),publicKey:h('88'),signature:'0x99'}};
let notFinal=false,superseded=false,orphan=false;
let orphanHeaders:readonly unknown[]=[null,null];
beforeEach(()=>{
 jest.resetAllMocks();notFinal=false;superseded=false;orphan=false;orphanHeaders=[null,null];
 const legs=recoveryAuthorizationFixture({kernel:operation.kernel,identity:operation.identity,destination:operation.destination,nonce:0,transactionHash:txHash,
  consumedCommitment:sha256(concat([operation.proof.recoverySecret,operation.proof.signingRoot])),nextCommitment:operation.proof.nextCommitment,nextSigningRoot:operation.proof.nextSigningRoot});
 (getOperatorBoundRpcLegs as jest.Mock).mockReturnValue(legs.map((leg,index)=>({operatorId:leg.operatorId,provider:{send:async(method:string,params:readonly unknown[])=>{
  if(method==='eth_getBlockByHash')return orphan?orphanHeaders[index]:{hash:queuedHash,number:'0x63'};
  if(orphan&&method==='eth_getCode')return typeof params[1]==='string'&&BigInt(params[1])<90n?'0x':'0x6001';
  if(orphan&&method==='eth_call'){
    const binding=new Interface(['function kernel() view returns(address)']);
    if((params[0] as {data:string}).data===binding.encodeFunctionData('kernel'))return binding.encodeFunctionResult('kernel',[operation.kernel]);
  }
  if(notFinal&&method==='eth_getBlockByNumber'&&params[0]==='finalized')return {number:'0x63'};
  if(superseded&&method==='eth_call'){
    const request=params[0] as {to:string;data:string};
    if(request.to===executor && request.data.startsWith(RECOVERY_AUTH_ABI.getFunction('ownerAuthorizationNonce')!.selector))return RECOVERY_AUTH_ABI.encodeFunctionResult('ownerAuthorizationNonce',[2]);
  }
  return leg.send(method,params);
 }}})));
 (readAgreedBaseHead as jest.Mock).mockResolvedValue(101);(readAgreedBaseBlockHash as jest.Mock).mockResolvedValue(queuedHash);
 (currentProtocolDeployment as jest.Mock).mockResolvedValue({addresses:{kernel:operation.kernel}});
 const event=RECOVERY_AUTH_ABI.encodeEventLog(RECOVERY_AUTH_ABI.getEvent('OwnerAuthorizationConsumed')!,[operation.identity,0,ownerOperationIntent(operation),operation.proof.nextCommitment,operation.proof.nextSigningRoot]);
 (getAgreedBaseLogs as jest.Mock).mockResolvedValue([{...event,address:executor,transactionHash:txHash,blockHash:h('19'),blockNumber:100,logIndex:1,removed:false}]);
});
test('discovers exact execution by another payer only after canonical finalized owner-state verification',async()=>{
 expect(await findExecutedOwnerOperation(operation,executor,queuedHash)).toEqual({transactionHash:txHash,superseded:false});
 superseded=true;expect(await findExecutedOwnerOperation(operation,executor,queuedHash)).toEqual({transactionHash:txHash,superseded:true});
 superseded=false;
 expect(getAgreedBaseLogs).toHaveBeenCalledWith(expect.objectContaining({address:executor,topics:[RECOVERY_AUTH_ABI.getEvent('OwnerAuthorizationConsumed')!.topicHash,operation.identity,ownerOperationIntent(operation)],fromBlock:99,toBlock:101}));
 notFinal=true;await expect(findExecutedOwnerOperation(operation,executor,queuedHash)).rejects.toThrow('not_finalized');
});
test('missing execution is not success and a substituted nonce cannot satisfy the receipt lookup',async()=>{
 (getAgreedBaseLogs as jest.Mock).mockResolvedValue([]);
 expect(await findExecutedOwnerOperation(operation,executor,queuedHash)).toBeNull();
 const event=RECOVERY_AUTH_ABI.encodeEventLog(RECOVERY_AUTH_ABI.getEvent('OwnerAuthorizationConsumed')!,[operation.identity,1,ownerOperationIntent(operation),operation.proof.nextCommitment,operation.proof.nextSigningRoot]);
 (getAgreedBaseLogs as jest.Mock).mockResolvedValue([{...event,address:executor,transactionHash:txHash,removed:false}]);
 await expect(findExecutedOwnerOperation(operation,executor,queuedHash)).rejects.toThrow('execution_mismatch');
});

test('an orphaned queue block resumes from executor birth and still verifies the finalized owner proof',async()=>{
 orphan=true;
 expect(await findExecutedOwnerOperation(operation,executor,queuedHash)).toEqual({transactionHash:txHash,superseded:false});
 expect(getAgreedBaseLogs).toHaveBeenCalledWith(expect.objectContaining({fromBlock:90,toBlock:101}));
 notFinal=true;await expect(findExecutedOwnerOperation(operation,executor,queuedHash)).rejects.toThrow();
});

test.each([
 [null,{hash:queuedHash,number:'0x63'}],
 [{hash:queuedHash,number:'0xff'},{hash:queuedHash,number:'0xff'}],
])('unavailable queue hints %j do not prevent authenticated birth lookup',async(first,second)=>{
 orphan=true;orphanHeaders=[first,second];
 expect(await findExecutedOwnerOperation(operation,executor,queuedHash)).toEqual({transactionHash:txHash,superseded:false});
 expect(getAgreedBaseLogs).toHaveBeenCalledWith(expect.objectContaining({fromBlock:90,toBlock:101}));
 notFinal=true;await expect(findExecutedOwnerOperation(operation,executor,queuedHash)).rejects.toThrow();
});
