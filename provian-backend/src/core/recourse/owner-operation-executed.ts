import { Interface, concat, sha256 } from 'ethers';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { rpcChainFactsEqual } from '../onchain/rpc-chain-facts';
import { getAgreedBaseLogs, readAgreedBaseHead, readAgreedBaseBlockHash } from '../onchain/economic-discovery';
import { currentProtocolDeployment } from '../protocol/runtime';
import { RECOVERY_AUTH_ABI, verifyRecoveryAuthorization } from './recovery-authorization';
import { ownerOperationIntent, type RecoveryOwnerOperation } from './owner-operation';
/** A public exact owner intent may be sponsored by anyone. Discover its real
 * receipt rather than declaring recovery failed because our nonce was unused. */
export async function findExecutedOwnerOperation(operation:RecoveryOwnerOperation,executor:string,queuedAtBlockHash:string):Promise<{transactionHash:string;superseded:boolean}|null>{
  return findExecutedRecovery(operation, ownerOperationIntent(operation), executor, queuedAtBlockHash);
}
export interface RecoveryOccurrence {
  readonly kernel: string; readonly identity: string; readonly destination: string; readonly nonce: number;
  readonly proof: { readonly recoverySecret: string; readonly signingRoot: string; readonly nextCommitment: string; readonly nextSigningRoot: string };
  readonly breakDestinationRoot?: string;
}
export async function findExecutedRecovery(operation:RecoveryOccurrence,intent:string,executor:string,queuedAtBlockHash:string):Promise<{transactionHash:string;superseded:boolean}|null>{
  if (!/^0x[0-9a-f]{64}$/.test(intent)) throw Error('recourse_owner_execution_boundary_invalid');
  if(!/^0x[0-9a-f]{40}$/.test(executor)||!/^0x[0-9a-f]{64}$/.test(queuedAtBlockHash))throw Error('recourse_owner_execution_boundary_invalid');
  const legs=getOperatorBoundRpcLegs('base');
  if(legs[0].operatorId===legs[1].operatorId)throw Error('recourse_rpc_operators_not_independent');
  const headers:unknown[]=await Promise.all(legs.map(leg=>leg.provider.send('eth_getBlockByHash',[queuedAtBlockHash,false])));
  const header=headers[0],head=await readAgreedBaseHead();
  let start:number|undefined;
  // The queue header is only a search hint. Honest providers may retain
  // different orphan headers, or prune them independently after a reorg.
  if(rpcChainFactsEqual(header,headers[1])&&header&&typeof header==='object'
    &&'hash' in header&&header.hash===queuedAtBlockHash
    &&'number' in header&&typeof header.number==='string'&&/^0x[0-9a-f]+$/i.test(header.number)){
    const height=Number(BigInt(header.number));
    if(Number.isSafeInteger(height)&&height<=head&&await readAgreedBaseBlockHash(height)===queuedAtBlockHash)start=height;
  }
  if(start===undefined){
    // An orphaned queue head may be replaced by execution at an earlier height.
    // Discover from the immutable executor's birth; the receipt verifier below
    // still authenticates the exact owner proof and every effect.
    const agreed=async(method:string,params:readonly unknown[]):Promise<string>=>{
      const values:unknown[]=await Promise.all(legs.map(leg=>leg.provider.send(method,[...params])));
      if(typeof values[0]!=='string'||values[0]!==values[1])throw Error('recourse_owner_execution_boundary_invalid');
      return values[0];
    };
    const headHash=await readAgreedBaseBlockHash(head);
    if(!headHash)throw Error('recourse_owner_execution_boundary_invalid');
    const tag={blockHash:headHash,requireCanonical:true},binding=new Interface(['function kernel() view returns(address)']);
    const code=await agreed('eth_getCode',[executor,tag]);
    if(code==='0x'||String(binding.decodeFunctionResult('kernel',await agreed('eth_call',[{to:executor,
      data:binding.encodeFunctionData('kernel')},tag]))[0]).toLowerCase()!==operation.kernel)throw Error('recourse_owner_execution_boundary_invalid');
    let left=1,right=head;
    while(left<right){const mid=left+Math.floor((right-left)/2);
      if(await agreed('eth_getCode',[executor,`0x${mid.toString(16)}`])==='0x')left=mid+1;else right=mid;}
    if(await agreed('eth_getCode',[executor,`0x${(left-1).toString(16)}`])!=='0x'
      ||await agreed('eth_getCode',[executor,`0x${left.toString(16)}`])!==code
      ||await readAgreedBaseBlockHash(head)!==headHash)throw Error('recourse_owner_execution_boundary_invalid');
    start=left;
  }
  const matches=[];
  for(let from=start;from<=head;from+=500)matches.push(...await getAgreedBaseLogs({address:executor,
    topics:[RECOVERY_AUTH_ABI.getEvent('OwnerAuthorizationConsumed')!.topicHash,operation.identity,intent],
    fromBlock:from,toBlock:Math.min(from+499,head)}));
  if(matches.length===0)return null;
  if(matches.length!==1)throw Error('recourse_owner_execution_ambiguous');
  const log=matches[0],event=RECOVERY_AUTH_ABI.parseLog({topics:[...log.topics],data:log.data});
  if(log.removed||log.address!==executor||!event||event.args.identity!==operation.identity||event.args.intent!==intent||event.args.nonce!==BigInt(operation.nonce)
    ||event.args.nextCommitment!==operation.proof.nextCommitment||event.args.nextSigningRoot!==operation.proof.nextSigningRoot)throw Error('recourse_owner_execution_mismatch');
  let superseded=false;
  try { await verifyRecoveryAuthorization({kernel:operation.kernel,currentKernel:(await currentProtocolDeployment()).addresses.kernel.toLowerCase(),
    identity:operation.identity,destination:operation.destination,nonce:operation.nonce,transactionHash:log.transactionHash,
    consumedCommitment:sha256(concat([operation.proof.recoverySecret,operation.proof.signingRoot])),
    nextCommitment:operation.proof.nextCommitment,nextSigningRoot:operation.proof.nextSigningRoot,
    ...(operation.breakDestinationRoot ? {breakDestinationRoot:operation.breakDestinationRoot} : {}), expectedIntent:intent}); }
  catch(error){
    // The verifier checks the exact occurrence and rechecks canonical receipt
    // blocks before reporting this state-only difference. No stale credentials
    // become installable; only the already-consumed gas nonce is reconciled.
    if(!(error instanceof Error)||error.message!=='recourse_authorization_superseded')throw error;
    superseded=true;
  }
  return {transactionHash:log.transactionHash,superseded};
}
