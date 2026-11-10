import { AbiCoder, Interface, ZeroAddress, ZeroHash, sha256 } from 'ethers';
import { merkle, verifyProof } from './snapshot.mjs';
import { breakOwnerLeaf, breakInstitutionLeaf } from './break-snapshot.mjs';
const coder=AbiCoder.defaultAbiCoder();
export const pendingBreakAbi=new Interface(['function ownerAuthorization() view returns(address)',
 'function breakOrigin() view returns(address)','function restorationRoot() view returns(bytes32)',
 'function predecessor() view returns(address)','function lastGoodBlock() view returns(uint256)',
 'function migratedAddress(address) view returns(bool)','function restoredIdentity(bytes32) view returns(bool)']);
function ensure(ok,error){if(!ok)throw Error(error);}
/** Unissued break entitlements are not in totalSupply. Carry their authenticated
 * original proof set separately, never count them as newly witnessed issuance. */
export async function readPendingBreak({port,kernel,blockHash,artifact}){
 const read=async(target,name,args=[])=>pendingBreakAbi.decodeFunctionResult(name,
  await port.call(target,pendingBreakAbi.encodeFunctionData(name,args),blockHash))[0];
 const executor=await read(kernel,'ownerAuthorization'),origin=await read(executor,'breakOrigin');
 if(origin===ZeroAddress)return null;
 const snapshot=artifact?.ownership??artifact?.breakOriginSnapshot;
 ensure(snapshot?.format==='provian-break-ownership-snapshot'&&Array.isArray(snapshot.entries),'snapshot_break_artifact_required');
 ensure(await read(origin,'restorationRoot')===snapshot.root
  &&String(await read(origin,'predecessor')).toLowerCase()===snapshot.predecessor.toLowerCase()
  &&await read(origin,'lastGoodBlock')===BigInt(snapshot.block),'snapshot_break_origin_mismatch');
 const ids=new Set(),leaves=[];
 for(const e of snapshot.entries){
  let leaf;
  if(e.kind==='owner'){
   ensure(!ids.has(e.identity)&&e.identity!==ZeroHash,'snapshot_break_owner_duplicate');ids.add(e.identity);
   leaf=breakOwnerLeaf(snapshot.predecessor,snapshot.block,e.identity,e.amount,e.commitment);
  }else if(e.kind==='institution'){
   leaf=breakInstitutionLeaf(snapshot.predecessor,snapshot.block,e.source,e.destination,e.amount,e.runtimeHash);
   ensure(await read(origin,'migratedAddress',[e.source]),'snapshot_break_institution_unrestored');
  }else if(e.kind==='institution-count')leaf=sha256(coder.encode(['string','address','uint256','uint256','uint256'],
   ['Provian institution restoration count',snapshot.predecessor,snapshot.block,e.count,e.amount]));
  else if(e.kind==='reversal')leaf=sha256(coder.encode(['string','address','uint256','bytes32','bytes32','uint256','bytes32'],
   ['Provian reversal history',snapshot.predecessor,snapshot.block,e.request,e.identity,e.shortfall,e.evidenceHash]));
  else if(e.kind==='intent')leaf=sha256(coder.encode(['string','address','uint256','tuple(bytes32,bytes32,address,bytes32,uint256)'],
   ['Provian pending restoration intent',snapshot.predecessor,snapshot.block,[e.request,e.identity,e.destination,e.lossHash,e.maximumLoss]]));
  else if(e.kind==='reversal-count')leaf=sha256(coder.encode(['string','address','uint256','uint256'],['Provian reversal history count',snapshot.predecessor,snapshot.block,e.count]));
  else throw Error('snapshot_break_entry_invalid');
  ensure(leaf===e.leaf&&verifyProof(leaf,e.proof,snapshot.root),'snapshot_break_proof_invalid');leaves.push(leaf);
 }
 ensure(ids.size===snapshot.counts.owners&&new Set(leaves).size===leaves.length&&merkle(leaves).root===snapshot.root,'snapshot_break_artifact_incomplete');
 const owners=[];let amount=0n;
 for(const e of snapshot.entries.filter(e=>e.kind==='owner')){
  if(!await read(executor,'restoredIdentity',[e.identity])){owners.push(e);amount+=BigInt(e.amount);}
 }
 return {origin,snapshot,owners,amount:amount.toString()};
}
