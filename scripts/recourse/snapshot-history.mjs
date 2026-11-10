import { readFileSync } from 'node:fs';
import { AbiCoder, Interface, getAddress } from 'ethers';
import { merkle, verifyProof, historyLeaf, batchLeaf } from './snapshot.mjs';
const coder = AbiCoder.defaultAbiCoder();
const historyAbi = new Interface(JSON.parse(readFileSync(new URL('../../contracts/out/ProvianRecoveryHistory.sol/ProvianRecoveryHistory.json',import.meta.url))).abi);
function ensure(ok,reason){if(!ok)throw Error(reason);}
/** An imported history is enumerable from its public proof artifact, but that
 * artifact is authoritative only after its complete root/count/domain match the
 * immutable on-chain history. Every retained fact is then reconciled at cutoff. */
export async function inheritedMonetaryHistory({prior,historyAddress,port,blockHash,iface,read,predecessor,block}){
 ensure(prior?.format==='provian-succession-snapshot'&&Array.isArray(prior.history)
   &&Number.isSafeInteger(prior.historyCount)&&prior.historyCount===prior.history.length,'snapshot_prior_artifact_required');
 const call=async name=>historyAbi.decodeFunctionResult(name,await port.call(historyAddress,historyAbi.encodeFunctionData(name),blockHash))[0];
 const [root,count,old,cutoff,complete]=await Promise.all(['root','entryCount','predecessor','lastGoodBlock','complete'].map(call));
 ensure(complete&&root===prior.historyRoot&&count===BigInt(prior.historyCount)
   &&getAddress(old)===getAddress(prior.predecessor)&&cutoff===BigInt(prior.block),'snapshot_prior_history_mismatch');
 ensure(merkle(prior.history.map(e=>e.leaf)).root===root,'snapshot_prior_population_incomplete');
 const frozenState = await call('state');
 const publishedState=prior.deployedHistoryState??prior.state;
 ensure(publishedState && coder.encode([historyAbi.getFunction('state').outputs[0]],[publishedState])
   ===coder.encode([historyAbi.getFunction('state').outputs[0]],[frozenState]),'snapshot_prior_state_mismatch');
 const entries=[],claims=new Set(),anchors=new Set(),wallets=new Set(),batches=new Set();let minted=0n;
 for(const entry of prior.history){
  ensure(Array.isArray(entry.proof)&&verifyProof(entry.leaf,entry.proof,root),'snapshot_prior_proof_invalid');
  if(entry.type==='batch'){
   const encoded=coder.encode([iface.getFunction('getBatchRecord').outputs[0]],[entry.record]);
   ensure(entry.leaf===batchLeaf(prior.predecessor,prior.block,entry.key,encoded)&&!batches.has(entry.key),'snapshot_prior_batch_invalid');
   const current=await read('getBatchRecord',[entry.key]);
   ensure(current.settled&&coder.encode([iface.getFunction('getBatchRecord').outputs[0]],[current])===encoded,'snapshot_prior_batch_changed');
   batches.add(entry.key);minted+=BigInt(current.totalMinted);
   entries.push({...entry,leaf:batchLeaf(predecessor,block,entry.key,encoded),proof:undefined});
  }else{
   ensure(entry.type==='entry'&&[0,1,2].includes(entry.kind)&&entry.leaf===historyLeaf(prior.predecessor,prior.block,entry.kind,entry.key,entry.value),
    'snapshot_prior_entry_invalid');
   const set=entry.kind===0?claims:entry.kind===1?anchors:wallets;
   ensure(!set.has(entry.key),'snapshot_prior_duplicate_entry');set.add(entry.key);
   if(entry.kind===2){ensure(await read('genesisWalletGrossIssued',[entry.key])>=BigInt(entry.value),'snapshot_prior_wallet_regressed');continue;}
   ensure(entry.value==='1'&&await read(entry.kind===0?'claimSettled':'genesisAnchorUsed',[entry.key]),'snapshot_prior_consumption_lost');
   entries.push({...entry,leaf:historyLeaf(predecessor,block,entry.kind,entry.key,1),proof:undefined});
  }
 }
 return{entries,claims,anchors,wallets,batches,minted,scheduleEpochs:frozenState.schedules.map(s=>s.epoch.toString())};
}
