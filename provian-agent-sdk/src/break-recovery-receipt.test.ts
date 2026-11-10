import { expect, it } from 'vitest';
import { AbiCoder, Interface, ZeroAddress, concat, keccak256, sha256 } from 'ethers';
import { verifyBreakRecoveryReceipt } from './break-recovery-receipt';
import { BREAK_RECOVERY_ABI, type PreparedBreakRecovery } from './break-recovery';
import { OWNER_EXECUTOR_ABI, OWNER_KERNEL_ABI } from './recourse-owner-operation';
import { PROTOCOL_COMPONENTS, type ProtocolComponent, type ProtocolDeployment } from './protocol-pointer';
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`,h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
const coder=AbiCoder.defaultAbiCoder(),kernel=a(1),executor=a(2),destination=a(3),identity=h(1),transactionHash=h(2),blockHash=h(3);
const events=new Interface(['event IdentityRestored(bytes32 indexed identity,address indexed destination,uint256 amount)',
 'event OwnerAuthorizationConsumed(bytes32 indexed identity,uint256 nonce,bytes32 indexed intent,bytes32 nextCommitment,bytes32 nextSigningRoot)',
 'event Transfer(address indexed from,address indexed to,uint256 value)']);
function fixture(){
 const proof={recoverySecret:h(10),signingRoot:h(11),nextCommitment:h(12),nextSigningRoot:h(13),publicKey:h(14),signature:'0x11'};
 const operationHash=h(15),destinationRoot=h(16);
 const ownerIntent=sha256(coder.encode(['string','uint256','address','bytes32','bytes32','uint256','bytes32','bytes32','bytes32'],
 ['Provian restoration owner authorization',8453,kernel,identity,sha256(concat([proof.recoverySecret,proof.signingRoot])),0,operationHash,proof.nextCommitment,proof.nextSigningRoot]));
 const payload=coder.encode(['uint8','bytes'],[1,coder.encode(['tuple(bytes32,uint256,bytes32,address,bytes32,bytes32[])'],[[identity,50,h(17),destination,destinationRoot,[]]])]);
 const prepared:PreparedBreakRecovery={phase:'restore_balance',kernel,executor,authority:a(4),manifestHash:h(20),identity,destination,amount:'50',ownerIntent,
 data:OWNER_EXECUTOR_ABI.encodeFunctionData('execute',[identity,operationHash,proof,payload])};
 const event=(name:string,values:readonly unknown[],address:string)=>({...events.encodeEventLog(events.getEvent(name)!,values),address,transactionHash,blockHash,removed:false});
 const receipt={transactionHash,blockHash,blockNumber:'0x64',status:'0x1',logs:[event('IdentityRestored',[identity,destination,50],executor),event('OwnerAuthorizationConsumed',[identity,0,ownerIntent,proof.nextCommitment,proof.nextSigningRoot],executor),event('Transfer',[ZeroAddress,destination,50],kernel)]};
 const deployment:ProtocolDeployment={pointer:a(6),revision:2n,manifestHash:h(20),blockHash:h(21),runtimeHashes:[],addresses:Object.fromEntries(PROTOCOL_COMPONENTS.map(k=>[k,kernel])) as Record<ProtocolComponent,string>};
 const state={finalized:'0x65',canonical:blockHash,disagree:false,currentExecutor:executor,badRoot:false,restored:true,nonce:1,rotateDuringReceipt:false,rotateOwnerDuringReceipt:false};
 const all=new Interface([...BREAK_RECOVERY_ABI.fragments,...OWNER_EXECUTOR_ABI.fragments,...OWNER_KERNEL_ABI.fragments,'function recoveredDestination(bytes32) view returns(address)']);
 const rpcs=[0,1].map(index=>({request:async(method:string,params:readonly unknown[]):Promise<unknown>=>{
  if(method==='eth_getTransactionReceipt'){if(state.rotateDuringReceipt)state.badRoot=true;if(state.rotateOwnerDuringReceipt)state.nonce=2;return state.disagree&&index===1?{...receipt,status:'0x0'}:receipt;}
  if(method==='eth_getBlockByNumber')return params[0]==='finalized'?{number:state.finalized}:{number:'0x64',hash:state.canonical};
  if(method==='eth_getCode')return '0x6000';
  const call=all.parseTransaction({data:(params[0] as {data:string}).data})!;
  const v:Record<string,unknown>={ownerAuthorization:state.currentExecutor,ownerAuthorizationNonce:state.nonce,ownerRecoveryCommitment:proof.nextCommitment,ownerSigningRoot:proof.nextSigningRoot,recoveredDestination:destination,previousAuthorization:executor,kernel,restoredIdentity:state.restored,hashAccountCodeHash:keccak256('0x6000'),keyCommitment:state.badRoot?h(22):destinationRoot};
  if(!(call.name in v))throw Error('unexpected '+call.name);return all.encodeFunctionResult(call.name,[v[call.name]]);
 }}));
 return {prepared,receipt,state,network:{deployment:async()=>deployment,rpcs:rpcs as [typeof rpcs[number],typeof rpcs[number]]}};
}
it('accepts only exact finalized restoration, including an ordinary successor that inherited owner state',async()=>{
 const f=fixture();await verifyBreakRecoveryReceipt(f.prepared,transactionHash,f.network);
 f.state.currentExecutor=a(7);await verifyBreakRecoveryReceipt(f.prepared,transactionHash,f.network);
});
it('refuses unfinalized, orphaned, provider-disagreed, missing-state and rotated-destination receipts',async()=>{
 for(const key of ['finalized','canonical','disagree','badRoot','restored'] as const){
  const f=fixture();if(key==='finalized')f.state.finalized='0x63';else if(key==='canonical')f.state.canonical=h(99);else if(key==='restored')f.state.restored=false;else f.state[key]=true;
  await expect(verifyBreakRecoveryReceipt(f.prepared,transactionHash,f.network)).rejects.toThrow();
 }
});
it('does not install from outer success, another mint, removed logs, or substituted owner intent',async()=>{
 for(const mutation of ['missing','mint','removed','intent'] as const){const f=fixture();
  if(mutation==='missing')f.receipt.logs.splice(0,1);
  if(mutation==='mint')f.receipt.logs[2].address=a(99);
  if(mutation==='removed')f.receipt.logs[0].removed=true;
  const prepared=mutation==='intent'?{...f.prepared,ownerIntent:h(99)}:f.prepared;
  await expect(verifyBreakRecoveryReceipt(prepared,transactionHash,f.network)).rejects.toThrow();
 }
});

it('rechecks owner state and destination root after receipt awaits even when pointer manifest is unchanged',async()=>{
 for(const key of ['rotateDuringReceipt','rotateOwnerDuringReceipt'] as const){const f=fixture();f.state[key]=true;
  await expect(verifyBreakRecoveryReceipt(f.prepared,transactionHash,f.network)).rejects.toThrow(/changed/);
 }
});
