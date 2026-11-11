import { Interface, ZeroAddress } from 'ethers';
import { verifyBreakArtifact } from '../../provian-agent-sdk/dist/break-artifact.js';
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
 let checked;
 try { checked=verifyBreakArtifact(snapshot,{predecessor:snapshot.predecessor,block:snapshot.block,root:snapshot.root}); }
 catch { throw Error('snapshot_break_artifact_incomplete'); }
 ensure(checked.owners.length===snapshot.counts?.owners,'snapshot_break_artifact_incomplete');
 for(const entry of snapshot.entries.filter(e=>e.kind==='institution'))
  ensure(await read(origin,'migratedAddress',[entry.source]),'snapshot_break_institution_unrestored');
 const owners=[];let amount=0n;
 for(const e of snapshot.entries.filter(e=>e.kind==='owner')){
  if(!await read(executor,'restoredIdentity',[e.identity])){owners.push(e);amount+=BigInt(e.amount);}
 }
 return {origin,snapshot,owners,amount:amount.toString()};
}
