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
  'function restorationRoot() view returns(bytes32)',
  'function successionReady() view returns(bool)',
  'event BalanceMigrated(address indexed previousOwner,address indexed destination,uint256 amount)',
  'event Transfer(address indexed from,address indexed to,uint256 amount)']);
const zero=`0x${'0'.repeat(40)}`;
export interface RestorationMigration { readonly kernel:string; readonly executor:string; readonly predecessor:string; readonly cutoff:number; }
export interface RestorationLineage { readonly kernel:string; readonly executor:string; readonly manifestHash:string; readonly migrations:readonly RestorationMigration[]; }
export interface RestorationSuccessionMigration extends RestorationMigration {
  readonly kind: 'ordinary' | 'cryptographic_break';
  readonly root: string;
  readonly cutoffHash: string;
}
export interface RestorationSuccessionLineage extends Omit<RestorationLineage, 'migrations'> {
  readonly migrations: readonly RestorationSuccessionMigration[];
}
export interface MigrationBalance { readonly mintId:string; readonly succession:TracedTransfer|null; }
/** Ordinary succession preserves the original loss scope. The current pointer
 * and immutable executor links, not a caller's address list, authenticate every
 * step of the balance history used to determine it. */
export async function readRestorationLineage(lossKernel:string):Promise<RestorationLineage> {
  const lineage = await readRestorationSuccessionLineage(lossKernel);
  // The ordinary collector cannot interpret unissued break entitlements. Keep
  // this refusal until its caller uses the authenticated typed bridge collector.
  if (lineage.migrations.some(migration => migration.kind !== 'ordinary')) throw Error('recourse_lineage_invalid');
  return lineage;
}
/** The pointer and immutable predecessor chain authenticate origins. Artifact
 * metadata never supplies an origin, root or cutoff. This describes succession
 * domains; it does not yet verify a balance partition or restoration receipt. */
export async function readRestorationSuccessionLineage(lossKernel:string):Promise<RestorationSuccessionLineage & { readonly block: number; readonly blockHash: string }> {
  if (!/^0x[0-9a-f]{40}$/.test(lossKernel) || lossKernel === zero) throw Error('recourse_lineage_invalid');
  const deployment=await currentProtocolDeployment();
  const legs=getOperatorBoundRpcLegs('base');
  if(legs[0].operatorId===legs[1].operatorId)throw Error('recourse_rpc_operators_not_independent');
  const headerNumber = (raw: unknown): number => {
    if (!raw || typeof raw !== 'object' || !('hash' in raw) || raw.hash !== deployment.blockHash
      || !('number' in raw) || typeof raw.number !== 'string' || !/^0x[0-9a-f]+$/.test(raw.number)
      || BigInt(raw.number) < 1n || BigInt(raw.number) > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('recourse_lineage_changed');
    return Number(BigInt(raw.number));
  };
  const headers = await Promise.all(legs.map(leg => leg.provider.send('eth_getBlockByHash', [deployment.blockHash, false])));
  const height = headerNumber(headers[0]);
  if (headerNumber(headers[1]) !== height) throw Error('recourse_lineage_changed');
  const call=async(target:string,method:string):Promise<unknown>=>{
    const replies:unknown[]=await Promise.all(legs.map(leg=>leg.provider.send('eth_call',[{to:target,data:abi.encodeFunctionData(method)},
      {blockHash:deployment.blockHash,requireCanonical:true}])));
    if(typeof replies[0]!=='string'||!rpcChainFactsEqual(replies[0],replies[1]))throw Error('recourse_lineage_rpc_disagreement');
    return abi.decodeFunctionResult(method,replies[0])[0];
  };
  const currentKernel=deployment.addresses.kernel.toLowerCase();
  const currentExecutor=String(await call(currentKernel,'ownerAuthorization')).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(currentExecutor) || currentExecutor === zero
    || String(await call(currentExecutor,'kernel')).toLowerCase() !== currentKernel) throw Error('recourse_lineage_invalid');
  let kernel=currentKernel,executor=currentExecutor,ceiling=height;
  const seen=new Set<string>(),migrations:RestorationSuccessionMigration[]=[];
  while(kernel!==lossKernel){
    if(kernel===zero||executor===zero||seen.has(kernel)||String(await call(executor,'kernel')).toLowerCase()!==kernel
      || await call(executor,'successionReady') !== true)throw Error('recourse_lineage_invalid');
    seen.add(kernel);
    const predecessor=String(await call(executor,'predecessor')).toLowerCase(),cutoff=Number(await call(executor,'lastGoodBlock'));
    if(!Number.isSafeInteger(cutoff)||cutoff<1||cutoff>=ceiling)throw Error('recourse_lineage_invalid');
    const broken = await call(executor,'cryptographicBreak'), root = String(await call(executor,'restorationRoot')).toLowerCase();
    const cutoffHash = await readAgreedBaseBlockHash(cutoff);
    if ((broken !== true && broken !== false) || !/^0x[0-9a-f]{64}$/.test(root) || /^0x0+$/.test(root)
      || !cutoffHash || !/^0x[0-9a-f]{64}$/.test(cutoffHash)
      || predecessor === zero || seen.has(predecessor)) throw Error('recourse_lineage_invalid');
    migrations.push({kernel,executor,predecessor,cutoff,cutoffHash,root,kind:broken?'cryptographic_break':'ordinary'});ceiling=cutoff;
    const previous=String(await call(executor,'previousAuthorization')).toLowerCase();
    const predecessorExecutor = String(await call(predecessor,'ownerAuthorization')).toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(predecessorExecutor) || predecessorExecutor === zero
      || (broken ? previous !== zero : previous !== predecessorExecutor)) throw Error('recourse_lineage_invalid');
    kernel=predecessor;executor=predecessorExecutor;
  }
  if (String(await call(executor,'kernel')).toLowerCase() !== lossKernel) throw Error('recourse_lineage_invalid');
  if((await currentProtocolDeployment()).manifestHash!==deployment.manifestHash)throw Error('recourse_lineage_changed');
  for (const migration of migrations) if (await readAgreedBaseBlockHash(migration.cutoff) !== migration.cutoffHash) throw Error('recourse_lineage_changed');
  // An unchanged manifest does not prove the checkpoint or its import-ready
  // state survived. Check canonical height after the final resolver awaits.
  const canonical = await Promise.all(legs.map(leg => leg.provider.send('eth_getBlockByNumber', [`0x${height.toString(16)}`, false])));
  if (canonical.some(header => headerNumber(header) !== height)) throw Error('recourse_lineage_changed');
  return {kernel:currentKernel,executor:currentExecutor,manifestHash:deployment.manifestHash,migrations:migrations.reverse(),block:height,blockHash:deployment.blockHash};
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
