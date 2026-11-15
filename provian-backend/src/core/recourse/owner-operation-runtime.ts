import { Wallet } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createRecourseGasSigner } from './gas-signer';
import { OWNER_OPERATIONS, assertCheckedOwnerOperation } from './owner-operation-queue';
import { executeOwnerOperation } from './owner-operation-worker';
import { SETTLEMENT_SIGNER_LEASES_COLLECTION } from '../pvt/settlement/durable-settlement-store';
/** Gas sponsorship can rotate only independently authorized owner credentials
 * or register a bounded intent. It cannot reverse funds or allocate the pool. */
export async function runOwnerOperationWorker(db:Firestore,env:NodeJS.ProcessEnv=process.env):Promise<{id:string;status:string}|null> {
  const key=env.PVT9_SETTLEMENT_MINTER_KEY;
  if(!key)throw Error('recourse_owner_gas_signer_unavailable');
  const signer=createRecourseGasSigner(new Wallet(key),assertCheckedOwnerOperation);
  const lease=await db.collection(SETTLEMENT_SIGNER_LEASES_COLLECTION).doc(signer.address).get();
  const pending:unknown=lease.get('pending_operation');
  let id:string;
  if(typeof pending==='string'){
    if(!/^0x[0-9a-f]{64}$/.test(pending)||!(await db.collection(OWNER_OPERATIONS).doc(pending).get()).exists)return null;
    id=pending;
  }else{
    const submitted=await db.collection(OWNER_OPERATIONS).where('status','==','submitted').limit(1).get();
    const rows=submitted.empty?await db.collection(OWNER_OPERATIONS).where('status','==','queued').limit(1).get():submitted;
    if(rows.empty)return null;id=rows.docs[0].id;
  }
  return {id,status:await executeOwnerOperation(db,id,signer)};
}
