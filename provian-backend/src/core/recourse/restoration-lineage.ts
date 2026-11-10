import { Interface } from 'ethers';
import { currentProtocolDeployment } from '../protocol/runtime';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { rpcChainFactsEqual } from '../onchain/rpc-chain-facts';
import { getAgreedBaseLogs, readAgreedBaseBlockHash, verifyBaseTransactionEvidence } from '../onchain/economic-discovery';
import type { RecourseChainPort } from './chain-ledger';
import type { TracedTransfer } from './restoration-trace';
const abi = new Interface(['function ownerAuthorization() view returns(address)', 'function kernel() view returns(address)',
  'function predecessor() view returns(address)', 'function previousAuthorization() view returns(address)',
  'function lastGoodBlock() view returns(uint256)', 'function cryptographicBreak() view returns(bool)',
  'function successionReady() view returns(bool)',
  'event BalanceMigrated(address indexed previousOwner,address indexed destination,uint256 amount)',
  'event Transfer(address indexed from,address indexed to,uint256 amount)']);
const zero=`0x${'0'.repeat(40)}`;
export interface RestorationMigration { readonly kernel:string; readonly executor:string; readonly predecessor:string; readonly cutoff:number; }
export interface RestorationLineage { readonly kernel:string; readonly executor:string; readonly manifestHash:string; readonly migrations:readonly RestorationMigration[]; }
export interface MigrationBalance { readonly mintId:string; readonly succession:TracedTransfer|null; }
/** Ordinary succession preserves the original loss scope. The current pointer
 * and immutable executor links, not a caller's address list, authenticate every
 * step of the balance history used to determine it. */
export async function readRestorationLineage(lossKernel:string):Promise<RestorationLineage> {
  const deployment=await currentProtocolDeployment();
  const legs=getOperatorBoundRpcLegs('base');
  if(legs[0].operatorId===legs[1].operatorId)throw Error('recourse_rpc_operators_not_independent');
  const call=async(target:string,method:string)=>{
    const replies:unknown[]=await Promise.all(legs.map(leg=>leg.provider.send('eth_call',[{to:target,data:abi.encodeFunctionData(method)},
      {blockHash:deployment.blockHash,requireCanonical:true}])));
    if(typeof replies[0]!=='string'||!rpcChainFactsEqual(replies[0],replies[1]))throw Error('recourse_lineage_rpc_disagreement');
    return abi.decodeFunctionResult(method,replies[0])[0];
  };
  const currentKernel=deployment.addresses.kernel.toLowerCase();
  const currentExecutor=String(await call(currentKernel,'ownerAuthorization')).toLowerCase();
  let kernel=currentKernel,executor=currentExecutor,ceiling:number|null=null;
  const seen=new Set<string>(),migrations:RestorationMigration[]=[];
  while(kernel!==lossKernel){
    if(kernel===zero||executor===zero||seen.has(kernel)||String(await call(executor,'kernel')).toLowerCase()!==kernel
      || await call(executor,'cryptographicBreak') || !await call(executor,'successionReady'))throw Error('recourse_lineage_invalid');
    seen.add(kernel);
    const predecessor=String(await call(executor,'predecessor')).toLowerCase(),cutoff=Number(await call(executor,'lastGoodBlock'));
    if(!Number.isSafeInteger(cutoff)||cutoff<1||(ceiling!==null&&cutoff>=ceiling))throw Error('recourse_lineage_invalid');
    migrations.push({kernel,executor,predecessor,cutoff});ceiling=cutoff;
    const previous=String(await call(executor,'previousAuthorization')).toLowerCase();
    if(previous===zero||previous!==String(await call(predecessor,'ownerAuthorization')).toLowerCase())throw Error('recourse_lineage_invalid');
    kernel=predecessor;executor=previous;
  }
  if((await currentProtocolDeployment()).manifestHash!==deployment.manifestHash)throw Error('recourse_lineage_changed');
  return {kernel:currentKernel,executor:currentExecutor,manifestHash:deployment.manifestHash,migrations:migrations.reverse()};
}
/** Verify the actual import event and its adjacent token mint against the old
 * balance at the immutable cutoff. Only that precise mint is a carried balance;
 * later work issuance remains an ordinary inbound Transfer in the trace. */
export async function readMigrationMint(migration:RestorationMigration,account:string,through:number,chain:RecourseChainPort):Promise<MigrationBalance|null> {
  const cutoffHash=await chain.blockHash(migration.cutoff);
  if(!cutoffHash||through<=migration.cutoff)throw Error('recourse_migration_checkpoint_invalid');
  const amount=await chain.balance(migration.predecessor,account,cutoffHash);
  const topic=`0x${account.slice(2).padStart(64,'0')}`;
  const logs=[];
  for(let from=migration.cutoff+1;from<=through;from+=500)logs.push(...await getAgreedBaseLogs({address:migration.executor,
    topics:[abi.getEvent('BalanceMigrated')!.topicHash,topic],fromBlock:from,toBlock:Math.min(from+499,through)}));
  if(amount===0n){if(logs.length!==0)throw Error('recourse_migration_amount_mismatch');return null;}
  if(logs.length!==1)throw Error('recourse_migration_import_missing');
  const log=logs[0],decoded=abi.parseLog({topics:[...log.topics],data:log.data});
  const destination=decoded?String(decoded.args.destination).toLowerCase():zero;
  if(log.removed||log.address!==migration.executor||!decoded||String(decoded.args.previousOwner).toLowerCase()!==account
    ||destination===zero||BigInt(decoded.args.amount)!==amount
    ||await readAgreedBaseBlockHash(log.blockNumber)!==log.blockHash)throw Error('recourse_migration_amount_mismatch');
  const transaction=await verifyBaseTransactionEvidence({transactionHash:log.transactionHash});
  const mint=transaction.logs.find(item=>item.logIndex===log.logIndex-1&&item.address===migration.kernel);
  if(transaction.blockHash!==log.blockHash||!mint)throw Error('recourse_migration_mint_missing');
  const transfer=abi.parseLog({topics:[...mint.topics],data:mint.data});
  if(!transfer||transfer.name!=='Transfer'||String(transfer.args.from).toLowerCase()!==zero
    ||String(transfer.args.to).toLowerCase()!==destination||BigInt(transfer.args.amount)!==amount)throw Error('recourse_migration_mint_mismatch');
  // The authenticated snapshot may carry institutional custody to a new
  // contract. Keep that exact balance and its traced provenance together.
  // This is an accounting bridge backed by BalanceMigrated, not a work mint
  // or an assertion that the institution gave or received consideration.
  return {mintId:`${mint.transactionHash}:${mint.logIndex}`,succession:destination===account?null:{
    block:log.blockNumber,blockHash:log.blockHash,transactionHash:log.transactionHash,logIndex:log.logIndex,
    from:account,to:destination,amountAtomic:amount.toString(),receipt:'custody_succession',witnessHash:transaction.evidenceHash,
  }};
}
